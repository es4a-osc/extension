/*
在真实扩展宿主中验证保存期间撤销、属性冲突和多段成员参数提示。
xhwsd@qq.com 2026-10-31
*/

import { testExtensionId } from "../testFixtures";

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { SimpleCodeFileSystemProvider, toSimpleCodeUri } from "../../simpleCodeFileSystem";
import { collectPropertyXmlElements, findPropertyXmlElementPath, getPropertyXmlAttribute, writePropertyXmlValue } from "../../propertyXml";
import { editProjectProperty } from "../../projectPropertyCommands";
import { parseProjectProperties } from "../../project";
import { loadSimpleProject } from "../../programResources";
import { ProgramTreeProvider } from "../../programTree";
import { SimpleSignatureHelpProvider } from "../../signatureHelp";
import type { Sdk } from "../../sdk";
import { sameFilePath } from "../../simpleProjectPaths";

suite("整扩展审查回归", () => {
	test("设计器保存等待写入期间的撤销仍保留为待保存版本", async () => {
		await vscode.extensions.getExtension(testExtensionId())!.activate();
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-audit-designer-save-"));
		const file = path.join(directory, "主窗口.simple");
		const source = '$属性\r\n$资源 $窗口\r\n$定义 主窗口 $为 窗口\r\n文本 = "之前"\r\n$结束 $定义\r\n$结束 $属性\r\n';
		const originalWrite = vscode.workspace.fs.writeFile;
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const started = new Promise<void>((resolve) => { entered = resolve; });
		let delayWrite = false;
		const provider = new SimpleCodeFileSystemProvider({ ...vscode.workspace.fs, writeFile: async (uri, bytes) => {
			if (sameFilePath(uri.fsPath, file) && delayWrite) { entered(); await gate; }
			await originalWrite(uri, bytes);
		} });
		let saving: Promise<void> | undefined;
		try {
			await fs.writeFile(file, source);
			const uri = toSimpleCodeUri(vscode.Uri.file(file));
			await provider.readFile(uri);
			const document = await vscode.workspace.openTextDocument(uri);
			const before = provider.getProperty(document)!.document!;
			const assignment = collectPropertyXmlElements(before.root, "赋值")[0]!;
			const changed = writePropertyXmlValue(before, findPropertyXmlElementPath(before, assignment)! + "/@值", '"之后"');
			await provider.applyDesignerPropertyEdit(document, before, changed, document.getText());
			delayWrite = true;
			saving = provider.saveDesignerProperty(document);
			await Promise.race([started, saving.then(() => { throw new Error("保存未经过受控写入边界。"); })]);
			provider.setDesignerPropertyDocument(document, changed, before);
			release();
			await saving;
			assert.equal(provider.getProperty(document)!.document, before);
			assert.ok(provider.hasUnsavedChanges(vscode.Uri.file(file)));
			await provider.saveDesignerProperty(document);
			assert.equal(getPropertyXmlAttribute(collectPropertyXmlElements(provider.getProperty(document)!.document!.root, "赋值")[0]!, "值"), '"之前"');
			assert.match(await fs.readFile(file, "utf8"), /文本 = "之前"/u);
		} finally {
			release();
			await saving?.catch(() => undefined);
			provider.dispose();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test("属性提交重读外部改动，保留其它字段并拒绝覆盖同一字段", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-audit-property-save-"));
		const file = path.join(directory, "project.properties");
		const provider = new ProgramTreeProvider();
		const originalRead = vscode.workspace.fs.readFile;
		try {
			await fs.writeFile(file, "name=old\nmain=主窗口\n");
			const project = await loadSimpleProject(file);
			for (const conflict of [false, true]) {
				await fs.writeFile(file, "name=old\nmain=主窗口\n");
				let first = true;
				const fileSystem = { ...vscode.workspace.fs, readFile: async (uri: vscode.Uri) => {
					const bytes = await originalRead(uri);
					if (sameFilePath(uri.fsPath, file) && first) {
						first = false;
						await fs.writeFile(file, `name=${conflict ? "外部名称" : "old"}\nmain=用户新主窗口\n`);
					}
					return bytes;
				} };
				const operation = editProjectProperty(provider, { fileSystem, refreshProjectSemantics: async () => undefined }, { kind: "project", label: "审查项目", project }, "name", "new");
				if (conflict) await assert.rejects(operation, /输入期间已变化/u);
				else await operation;
				const actual = parseProjectProperties(await fs.readFile(file, "utf8"));
				assert.equal(actual.main, "用户新主窗口");
				assert.equal(actual.name, conflict ? "外部名称" : "new");
			}
		} finally {
			provider.dispose();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test("多段成员调用的参数提示不被同名局部对象截获", async () => {
		const provider = new SimpleSignatureHelpProvider();
		const sdk: Sdk = { directory: "C:/sdk", templates: {}, issues: [], capabilities: { projects: [], tools: [] }, manifests: [{
			kind: "runtime", name: "测试", directory: "C:/sdk", filePath: "C:/sdk/runtime.json", categories: [{ name: "对象", definitions: [
				{ name: "父", kind: "object", properties: [{ name: "子", type: "正确类型" }] },
				{ name: "正确类型", kind: "object", functions: [{ name: "方法", params: [{ name: "正确参数", type: "文本型" }] }] },
				{ name: "其它类型", kind: "object", functions: [{ name: "方法", params: [{ name: "错误参数", type: "整数型" }] }] }
			] }] }
		] };
		provider.updateSdk(sdk);
		const source = "变量 甲 为 父\n变量 子 为 其它类型\n过程 测试()\n甲.子.方法(";
		const document = await vscode.workspace.openTextDocument({ language: "simple", content: source });
		const cancellation = new vscode.CancellationTokenSource();
		const help = provider.provideSignatureHelp(document, document.positionAt(source.length), cancellation.token, {
			triggerKind: vscode.SignatureHelpTriggerKind.Invoke, isRetrigger: false, triggerCharacter: undefined, activeSignatureHelp: undefined
		});
		cancellation.dispose();
		assert.equal(help?.signatures.length, 1);
		assert.match(help!.signatures[0]!.label, /正确参数/u);
	});
});
