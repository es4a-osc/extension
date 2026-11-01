/*
在真实宿主验证恢复失败重试、复制身份、XML 诊断和行尾持久化。
xhwsd@qq.com 2026-10-31
*/

import { testExtensionId } from "../testFixtures";

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { SimpleCodeDocumentRecovery } from "../../simpleCodeDocumentRecovery";
import { SimpleCodeFileSystemProvider, toSimpleCodeUri } from "../../simpleCodeFileSystem";
import { ProgramTreeProvider } from "../../programTree";
import { SimpleProjectRefactoring } from "../../projectRefactoring";
import { ProjectSymbolIndex } from "../../projectSymbolIndex";
import { SimpleDiagnosticProvider } from "../../diagnosticProvider";
import { createPropertyXmlAttributePath, writePropertyXmlValue, serializePropertyXml } from "../../propertyXml";
import { toUnitXmlPreviewUri } from "../../unitPreview";
import { loadSimpleProject } from "../../programResources";
import { UnitTransferController } from "../../unitTransfer";
import type { Sdk } from "../../sdk";

suite("扩展连续操作可靠性", () => {
	test("恢复快照写入失败后，后续 flush 重试并保存最新正文", async () => {
		let attempts = 0;
		let saved: unknown;
		const failures: unknown[] = [];
		const recovery = new SimpleCodeDocumentRecovery({ keys: () => [], get: () => undefined,
			update: async (_key, value) => { attempts++; if (attempts === 1) throw new Error("模拟持久化失败"); saved = value; }
		}, (error) => failures.push(error));
		let text = "第一次修改";
		const uri = toSimpleCodeUri(vscode.Uri.file(path.join(os.tmpdir(), "recovery-retry.simple")));
		const document = { uri, isDirty: true, getText: () => text } as vscode.TextDocument;
		recovery.capture(document);
		await assert.rejects(recovery.flush(), /模拟持久化失败/u);
		assert.equal(failures.length, 1);
		text = "最新修改";
		recovery.capture(document);
		await recovery.flush();
		assert.equal(attempts, 2);
		assert.ok(JSON.stringify(saved).includes("最新修改"));
	});

	test("真实单元复制保留同名局部绑定，并且不改源文件", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-reliable-copy-"));
		const programs = new ProgramTreeProvider();
		const documents = new SimpleCodeFileSystemProvider();
		const refactoring = new SimpleProjectRefactoring({ codeDocuments: documents, refreshProjectSemantics: async () => undefined });
		const controller = new UnitTransferController(programs, { codeDocuments: documents, refactoring, refreshProjectSemantics: async () => undefined });
		try {
			const projectFile = path.join(directory, "project.properties");
			const sourceFile = path.join(directory, "src", "对象1.simple");
			await fs.mkdir(path.dirname(sourceFile));
			await fs.writeFile(projectFile, "source=./src\n");
			const source = "过程 测试(对象1 为 对象1)\n变量 对象2 为 整数型\n对象1 = 对象1\n结束 过程\n$属性\n$资源 $对象\n$结束 $属性\n";
			await fs.writeFile(sourceFile, source);
			await programs.addProject(projectFile);
			const node = await programs.findUnitByFilePath(sourceFile);
			assert.ok(node?.project);
			await controller.copy(node);
			await controller.paste({ kind: "directory", mode: "units", directoryPath: path.dirname(sourceFile), label: "src", project: node.project });
			assert.equal(await fs.readFile(sourceFile, "utf8"), source);
			const copied = await fs.readFile(path.join(directory, "src", "对象2.simple"), "utf8");
			assert.ok(copied.includes("测试(对象1 为 对象2)\n变量 对象2 为 整数型\n对象1 = 对象1"));
		} finally {
			controller.dispose(); refactoring.dispose(); documents.dispose(); programs.dispose();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test("新增 XML 关系的诊断定位到当前预览行，不依赖磁盘旧行号", async () => {
		await vscode.extensions.getExtension(testExtensionId())!.activate();
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-reliable-xml-diagnostic-"));
		const programs = new ProgramTreeProvider();
		const documents = new SimpleCodeFileSystemProvider();
		const symbols = new ProjectSymbolIndex();
		const sdk: Sdk = { directory, capabilities: { projects: [], tools: [] }, templates: {}, manifests: [], issues: [] };
		const refactoring = new SimpleProjectRefactoring({ codeDocuments: documents, getSdk: () => sdk, refreshProjectSemantics: async () => undefined });
		const diagnostics = new SimpleDiagnosticProvider(programs, refactoring, documents, symbols, () => sdk, () => undefined, assert.fail);
		try {
			const projectFile = path.join(directory, "project.properties");
			const file = path.join(directory, "src", "对象1.simple");
			await fs.mkdir(path.dirname(file));
			await fs.writeFile(projectFile, "source=./src\n");
			await fs.writeFile(file, '$属性\n$资源 $对象\n未知 = "原样保留"\n$结束 $属性\n');
			await programs.addProject(projectFile);
			await symbols.updateProjects([await loadSimpleProject(projectFile)]);
			const uri = toSimpleCodeUri(vscode.Uri.file(file));
			await documents.readFile(uri);
			const document = await vscode.workspace.openTextDocument(uri);
			const original = documents.getProperty(document)!.document!;
			const updated = writePropertyXmlValue(original, createPropertyXmlAttributePath("/属性", "赋值", "属性", "基础对象", "值"), "不存在对象");
			await documents.applyDesignerPropertyEdit(document, original, updated, document.getText());
			diagnostics.schedule(true);
			const xmlUri = toUnitXmlPreviewUri(vscode.Uri.file(file));
			let issue: vscode.Diagnostic | undefined;
			for (let count = 0; count < 100 && issue === undefined; count++) {
				await new Promise((resolve) => setTimeout(resolve, 20));
				issue = vscode.languages.getDiagnostics(xmlUri).find((item) => item.code === "unknownRelation");
			}
			assert.ok(issue);
			const xmlLine = serializePropertyXml(updated).split("\r\n")[issue.range.start.line]!;
			assert.equal(xmlLine.slice(issue.range.start.character, issue.range.end.character), "不存在对象");
		} finally {
			diagnostics.dispose(); refactoring.dispose(); documents.dispose(); programs.dispose();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test("代码视图保存已有行尾时不新增空白行，重读保持相同行尾", async () => {
		await vscode.extensions.getExtension(testExtensionId())!.activate();
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-reliable-eol-"));
		const file = path.join(directory, "对象1.simple");
		const property = "$属性\n$资源 $对象\n$结束 $属性\n";
		const reader = new SimpleCodeFileSystemProvider();
		try {
			await fs.writeFile(file, "变量 旧值 为 整数型\n" + property);
			const document = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(file)));
			const expected = "变量 新值 为 整数型\n";
			const edit = new vscode.WorkspaceEdit();
			edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), expected);
			assert.ok(await vscode.workspace.applyEdit(edit));
			assert.ok(await document.save());
			assert.equal(await fs.readFile(file, "utf8"), expected + property);
			assert.equal(Buffer.from(await reader.readFile(document.uri)).toString("utf8"), expected);
		} finally {
			reader.dispose();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
