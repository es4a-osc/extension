/*
在真实扩展宿主验证故障回滚、恢复冲突、工程配置并发与语义签名。
xhwsd@qq.com 2026-10-31
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { ProgramTreeProvider } from "../../programTree";
import { SimpleCodeFileSystemProvider, toSimpleCodeUri } from "../../simpleCodeFileSystem";
import { writeWorkspaceConfiguration } from "../../workspaceConfigurationWriter";
import { writePropertyXmlValue } from "../../propertyXml";
import { SimpleSignatureHelpProvider } from "../../signatureHelp";
import { refactoringContext, type RefactoringUnit } from "../../refactoringModel";
import { inspectSimplePropertyXml } from "../../propertyXml";
import type { Sdk } from "../../sdk";
import { UnitTransferController } from "../../unitTransfer";
import { loadSimpleProject } from "../../programResources";
import { sameFilePath } from "../../simpleProjectPaths";
import { SimpleProjectRefactoring } from "../../projectRefactoring";
import { testExtensionId, testSdkPath } from "../testFixtures";
import { loadSdk } from "../../sdk";

suite("扩展集中完整性回归", () => {
	test("XML 重构撤销和重做拒绝已有设计器草稿，保留草稿且仍可保存", async () => {
		await vscode.extensions.getExtension(testExtensionId())!.activate();
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-integrity-receipt-draft-"));
		try {
			for (const mode of ["undo", "redo"] as const) {
				const file = path.join(directory, mode + ".simple");
				const source = '$属性\n$资源 $窗口\n$定义 主窗口 $为 窗口\n标题 = "原标题"\n$定义 按钮1 $为 按钮\n$结束 $定义\n$结束 $定义\n$结束 $属性\n';
				await fs.writeFile(file, source);
				const provider = new SimpleCodeFileSystemProvider();
				try {
					const document = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(file)));
					await provider.readFile(document.uri);
					const original = provider.getProperty(document)!.document!;
					const receipt = await provider.preparePropertyRefactor(vscode.Uri.file(file), writePropertyXmlValue(original, "/属性/定义[1]/定义[1]/@名称", "新按钮"));
					await provider.rename(receipt.before, receipt.after, { overwrite: false });
					if (mode === "redo") await provider.rename(receipt.after, receipt.before, { overwrite: false });
					const current = provider.getProperty(document)!.document!;
					const draft = writePropertyXmlValue(current, "/属性/定义[1]/赋值[@属性='标题']/@值", '"后续标题"');
					provider.setDesignerPropertyDocument(document, current, draft);
					const disk = await fs.readFile(file, "utf8");
					await assert.rejects(provider.rename(mode === "undo" ? receipt.after : receipt.before, mode === "undo" ? receipt.before : receipt.after, { overwrite: false }), /设计器草稿/u);
					assert.equal(await fs.readFile(file, "utf8"), disk);
					assert.equal(provider.getProperty(document)!.document, draft);
					assert.equal(receipt.isApplied(), mode === "undo");
					await provider.saveDesignerProperty(document);
					assert.match(await fs.readFile(file, "utf8"), /后续标题/u);
					receipt.dispose();
				} finally { provider.dispose(); }
			}
		} finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
	});

	test("项目重构准备期间 main 和资源 XML 再次编辑时拒绝过期计划", async () => {
		await vscode.extensions.getExtension(testExtensionId())!.activate();
		const sdk = await loadSdk(testSdkPath());
		for (const mode of ["main", "main-aba", "xml"] as const) {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-integrity-refactor-text-"));
			const projectFile = path.join(directory, "project.properties");
			const file = path.join(directory, "src", "Old.simple");
			const image = path.join(directory, "res", "drawable", "old.png");
			const xmlFile = path.join(directory, "res", "layout", "screen.xml");
			const provider = new SimpleCodeFileSystemProvider();
			const refactoring = new SimpleProjectRefactoring({ codeDocuments: provider, getSdk: () => sdk, refreshProjectSemantics: async () => undefined });
			let changedDocument: vscode.TextDocument | undefined;
			try {
				await fs.mkdir(path.dirname(file), { recursive: true });
				await fs.mkdir(path.dirname(image), { recursive: true });
				await fs.mkdir(path.dirname(xmlFile), { recursive: true });
				await fs.writeFile(file, "变量 编号 为 整数型\n过程 测试()\n编号 = R.drawable_old\n结束 过程\n$属性\n$资源 $对象\n$结束 $属性\n");
				await fs.writeFile(projectFile, "source=./src\nmain=Old\n");
				await fs.writeFile(image, new Uint8Array([0]));
				await fs.writeFile(xmlFile, '<ImageView src="@drawable/old" />\n');
				changedDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(mode === "xml" ? xmlFile : projectFile));
				const original = changedDocument.getText();
				const updated = mode === "xml" ? original + "<!--用户新增-->\n" : original.replace("main=Old", "main=User");
				const read = provider.readRefactoringUnit.bind(provider);
				let checks = 0;
				provider.readRefactoringUnit = async (...args) => {
					const snapshot = await read(...args);
					return { ...snapshot, assertUnchanged: async (...expected) => {
						await snapshot.assertUnchanged(...expected);
						if (++checks !== 2) return;
						const edit = new vscode.WorkspaceEdit();
						edit.replace(changedDocument!.uri, new vscode.Range(changedDocument!.positionAt(0), changedDocument!.positionAt(original.length)), updated);
						assert.ok(await vscode.workspace.applyEdit(edit));
						if (mode === "main-aba") {
							const restore = new vscode.WorkspaceEdit();
							restore.replace(changedDocument!.uri, new vscode.Range(changedDocument!.positionAt(0), changedDocument!.positionAt(updated.length)), original);
							assert.ok(await vscode.workspace.applyEdit(restore));
						}
					} };
				};
				const before = mode === "xml" ? image : file;
				const after = path.join(path.dirname(before), mode === "xml" ? "new.png" : "New.simple");
				await assert.rejects(refactoring.prepareNativePathEdits(await loadSimpleProject(projectFile), [{ oldFile: before, newFile: after }], mode === "xml" ? "resources" : "units"), /关联文档.*已变化/u);
				assert.equal(checks, 2);
				assert.equal(changedDocument.getText(), mode === "main-aba" ? original : updated);
				assert.ok(await fs.stat(before));
				await assert.rejects(fs.stat(after));
				assert.equal(await fs.readFile(changedDocument.uri.fsPath, "utf8"), original);
			} finally {
				if (changedDocument !== undefined) {
					await vscode.window.showTextDocument(changedDocument);
					await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
				}
				refactoring.dispose(); provider.dispose();
				await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
			}
		}
	});

	test("项目重构源码扫描失败时拒绝不完整快照", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-integrity-incomplete-scan-"));
		const provider = new SimpleCodeFileSystemProvider();
		const refactoring = new SimpleProjectRefactoring({ codeDocuments: provider, refreshProjectSemantics: async () => undefined });
		try {
			await fs.writeFile(path.join(directory, "project.properties"), "source=./src,./missing\n");
			await fs.mkdir(path.join(directory, "src"));
			await fs.writeFile(path.join(directory, "src", "对象.simple"), "$属性\n$资源 $对象\n$结束 $属性\n");
			await assert.rejects(refactoring.readProject(await loadSimpleProject(path.join(directory, "project.properties"))), /无法完整扫描源码目录/u);
		} finally { refactoring.dispose(); provider.dispose(); await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
	});

	test("原生重命名同名局部变量时保留触发事件目标，保存只更新实际变量引用", async () => {
		await vscode.extensions.getExtension(testExtensionId())!.activate();
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-integrity-event-identity-"));
		const projectFile = path.join(directory, "project.properties");
		const file = path.join(directory, "src/对象.simple");
		const uri = toSimpleCodeUri(vscode.Uri.file(file));
		const property = "$属性\n$资源 $对象\n$结束 $属性\n";
		const code = "事件 通知(数值 为 整数型)\n结束 事件\n过程 测试()\n变量 通知 为 整数型\n通知 = 1\n触发事件 通知(通知)\n结束 过程\n";
		let document: vscode.TextDocument | undefined;
		let added = false;
		try {
			await fs.mkdir(path.dirname(file), { recursive: true });
			await fs.writeFile(projectFile, "name=事件身份\nsource=./src\n");
			await fs.writeFile(file, code + property);
			await vscode.commands.executeCommand("es4a.internal.addProject", projectFile);
			added = true;
			document = await vscode.workspace.openTextDocument(uri);
			await vscode.window.showTextDocument(document, { preview: false });
			const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>("vscode.executeDocumentRenameProvider", uri, document.positionAt(code.indexOf("变量 通知") + 3), "计数");
			assert.ok(edit);
			assert.ok(await vscode.workspace.applyEdit(edit));
			assert.ok(document.getText().includes("触发事件 通知(计数)"));
			assert.ok(document.getText().startsWith("事件 通知("));
			assert.ok(document.getText().includes("变量 计数 为 整数型"));
			assert.equal(await fs.readFile(file, "utf8"), code + property);
			assert.ok(await document.save());
			const saved = await fs.readFile(file, "utf8");
			assert.ok(saved.includes("触发事件 通知(计数)"));
			assert.ok(saved.endsWith(property));
		} finally {
			if (document?.isDirty) { await vscode.window.showTextDocument(document); await vscode.commands.executeCommand("workbench.action.files.revert"); }
			if (added) await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			assert.equal(path.dirname(directory), os.tmpdir());
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
	test("关闭并丢弃属性草稿后旧快照失效，重开会话也不能复用旧快照", async () => {
		await vscode.extensions.getExtension(testExtensionId())!.activate();
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-integrity-session-close-"));
		const source = '过程 测试()\n结束 过程\n$属性\n$资源 $窗口\n$定义 Main $为 窗口\n标题 = "原标题"\n$定义 按钮1 $为 按钮\n$结束 $定义\n$结束 $定义\n$结束 $属性\n';
		try {
			for (const reopen of [false, true]) {
				const provider = new SimpleCodeFileSystemProvider();
				const file = path.join(directory, `窗口-${reopen}.simple`);
				const uri = toSimpleCodeUri(vscode.Uri.file(file));
				try {
					await fs.writeFile(file, source);
					const document = await vscode.workspace.openTextDocument(uri);
					await provider.readFile(uri);
					const property = provider.getProperty(document)!.document!;
					provider.setDesignerPropertyDocument(document, property, writePropertyXmlValue(property, "/属性/定义[1]/赋值[@属性='标题']/@值", '"已放弃标题"'));
					const snapshot = await provider.readRefactoringUnit(vscode.Uri.file(file), directory);
					provider.releaseDocument(document);
					if (reopen) await provider.readFile(uri);
					assert.throws(snapshot.assertCurrent, /会话.*关闭|失效/u);
					await assert.rejects(snapshot.assertUnchanged(), /会话.*关闭|失效/u);
					assert.equal(await fs.readFile(file, "utf8"), source);
				} finally { provider.dispose(); }
			}
		} finally { assert.equal(path.dirname(directory), os.tmpdir()); await fs.rm(directory, { recursive: true, force: true }); }
	});

	test("XML 重构在读取及最终写前的新编辑使计划失效，保留草稿并可重新准备", async () => {
		await vscode.extensions.getExtension(testExtensionId())!.activate();
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-integrity-xml-final-"));
		const original = '过程 测试()\n结束 过程\n$属性\n$资源 $窗口\n$定义 Main $为 窗口\n标题 = "原标题"\n$定义 按钮1 $为 按钮\n$结束 $定义\n$结束 $定义\n$结束 $属性\n';
		try {
			for (const injectAt of [1, 2]) {
				const file = path.join(directory, `窗口-${injectAt}.simple`);
				const uri = toSimpleCodeUri(vscode.Uri.file(file));
				let reads = 0;
				let inject: (() => void) | undefined;
				const provider = new SimpleCodeFileSystemProvider({ ...vscode.workspace.fs, readFile: async (target) => {
					const bytes = await vscode.workspace.fs.readFile(target);
					if (inject !== undefined && ++reads === injectAt) { const action = inject; inject = undefined; action(); }
					return bytes;
				} });
				try {
					await fs.writeFile(file, original);
					const document = await vscode.workspace.openTextDocument(uri);
					await provider.readFile(uri);
					const property = provider.getProperty(document)!.document!;
					const title = "/属性/定义[1]/赋值[@属性='标题']/@值";
					const button = "/属性/定义[1]/定义[1]/@名称";
					const receipt = await provider.preparePropertyRefactor(vscode.Uri.file(file), writePropertyXmlValue(property, button, "新按钮"));
					inject = () => provider.setDesignerPropertyDocument(document, property, writePropertyXmlValue(property, title, '"并发标题"'));
					await assert.rejects(provider.rename(receipt.before, receipt.after, { overwrite: false }), /XML.*变化|发生编辑/u);
					assert.equal(inject, undefined);
					assert.equal(await fs.readFile(file, "utf8"), original);
					assert.ok(provider.hasUnsavedChanges(vscode.Uri.file(file)));
					receipt.dispose();
					await provider.saveDesignerProperty(document);
					const current = provider.getProperty(document)!.document!;
					const retry = await provider.preparePropertyRefactor(vscode.Uri.file(file), writePropertyXmlValue(current, button, "新按钮"));
					await provider.rename(retry.before, retry.after, { overwrite: false });
					const saved = await fs.readFile(file, "utf8");
					assert.ok(saved.includes("并发标题"));
					assert.ok(saved.includes("新按钮"));
					retry.dispose();
				} finally { provider.dispose(); }
			}
		} finally { assert.equal(path.dirname(directory), os.tmpdir()); await fs.rm(directory, { recursive: true, force: true }); }
	});

	test("磁盘属性与活动会话不一致时拒绝重构，不把旧模型覆盖到新属性", async () => {
		await vscode.extensions.getExtension(testExtensionId())!.activate();
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-integrity-model-baseline-"));
		const file = path.join(directory, "窗口.simple");
		const uri = toSimpleCodeUri(vscode.Uri.file(file));
		const provider = new SimpleCodeFileSystemProvider();
		try {
			const original = '$属性\n$资源 $窗口\n$定义 Main $为 窗口\n标题 = "原标题"\n$结束 $定义\n$结束 $属性\n';
			await fs.writeFile(file, original);
			const document = await vscode.workspace.openTextDocument(uri);
			await provider.readFile(uri);
			const snapshot = await provider.readRefactoringUnit(vscode.Uri.file(file), directory);
			const property = provider.getProperty(document)!.document!;
			const external = original.replace("原标题", "外部标题");
			await fs.writeFile(file, external);
			await assert.rejects(provider.preparePropertyRefactor(vscode.Uri.file(file), property), /基线不一致/u);
			const stale = await provider.readRefactoringUnit(vscode.Uri.file(file), directory);
			assert.throws(stale.assertCurrent, /基线不一致/u);
			await assert.rejects(snapshot.assertUnchanged(), /外部修改/u);
			assert.equal(await fs.readFile(file, "utf8"), external);
		} finally { provider.dispose(); assert.equal(path.dirname(directory), os.tmpdir()); await fs.rm(directory, { recursive: true, force: true }); }
	});
	test("代码和设计器保存拒绝准备期间的外部修改，保留草稿并允许重试", async () => {
		await vscode.extensions.getExtension(testExtensionId())!.activate();
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-integrity-save-race-"));
		try {
			for (const mode of ["code", "designer"]) for (const area of ["code", "property"]) {
				const file = path.join(directory, `${mode}-${area}.simple`);
				const uri = toSimpleCodeUri(vscode.Uri.file(file));
				const original = '过程 原代码()\n结束 过程\n$属性\n$资源 $对象\n未知 = "原值"\n$结束 $属性\n';
				const external = area === "code" ? original.replace("原代码", "外部代码") : original.replace("原值", "外部属性");
				let armed = false;
				let injected = false;
				const provider = new SimpleCodeFileSystemProvider({ ...vscode.workspace.fs, readFile: async (target) => {
					const bytes = await vscode.workspace.fs.readFile(target);
					if (armed && sameFilePath(target.fsPath, file)) { armed = false; injected = true; await fs.writeFile(file, external); }
					return bytes;
				} });
				try {
					await fs.writeFile(file, original);
					const document = await vscode.workspace.openTextDocument(uri);
					await provider.readFile(uri);
					const draft = await vscode.workspace.encode("过程 用户新代码()\n结束 过程\n", { encoding: "utf8" });
					if (mode === "designer") {
						const before = provider.getProperty(document)!.document!;
						await provider.applyDesignerPropertyEdit(document, before, writePropertyXmlValue(before, "/属性/赋值[@属性='未知']/@值", '"设计器修改"'), document.getText());
					}
					const save = () => mode === "designer" ? provider.saveDesignerProperty(document) : provider.writeFile(uri, draft, { create: false, overwrite: true });
					armed = true;
					await assert.rejects(save(), /保存期间.*外部修改/u);
					assert.equal(injected, true);
					assert.equal(await fs.readFile(file, "utf8"), external);
					if (mode === "designer") assert.ok(provider.hasUnsavedChanges(vscode.Uri.file(file)));
					await fs.writeFile(file, original);
					await save();
					const saved = await fs.readFile(file, "utf8");
					assert.ok(saved.includes(mode === "designer" ? "设计器修改" : "用户新代码"));
					assert.ok(saved.includes(mode === "designer" ? "原代码" : "原值"));
				} finally { provider.dispose(); }
			}
		} finally { await fs.rm(directory, { recursive: true, force: true }); }
	});

	test("快照校验等待磁盘期间发生内存编辑时拒绝过期版本", async () => {
		await vscode.extensions.getExtension(testExtensionId())!.activate();
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-integrity-snapshot-race-"));
		const file = path.join(directory, "对象.simple");
		const uri = toSimpleCodeUri(vscode.Uri.file(file));
		let document: vscode.TextDocument | undefined;
		let reads = 0;
		const provider = new SimpleCodeFileSystemProvider({ ...vscode.workspace.fs, readFile: async (target) => {
			const bytes = await vscode.workspace.fs.readFile(target);
			if (++reads === 2) {
				const edit = new vscode.WorkspaceEdit();
				edit.insert(uri, new vscode.Position(0, 0), "' 后来的编辑\n");
				assert.ok(await vscode.workspace.applyEdit(edit));
			}
			return bytes;
		} });
		try {
			await fs.writeFile(file, "变量 数值 为 整数型\n$属性\n$资源 $对象\n$结束 $属性\n");
			document = await vscode.workspace.openTextDocument(uri);
			const snapshot = await provider.readRefactoringUnit(vscode.Uri.file(file), directory);
			await assert.rejects(snapshot.assertUnchanged(), /发生编辑/u);
			assert.throws(snapshot.assertCurrent, /发生编辑/u);
			assert.ok(document.getText().startsWith("' 后来的编辑"));
		} finally {
			if (document !== undefined) {
				await vscode.window.showTextDocument(document);
				await vscode.commands.executeCommand("workbench.action.files.revert");
				await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
			}
			provider.dispose();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test("触发事件提示当前及继承事件参数，不混入普通函数和全局函数", async () => {
		const root = path.resolve("integrity/src");
		const base: RefactoringUnit = { sourceRoot: root, filePath: path.join(root, "基类.simple"), userCode: "事件 继承通知(消息 为 文本型)\n结束 事件\n", property: inspectSimplePropertyXml("$属性\n$资源 $对象\n$结束 $属性") };
		const cases = [
			["触发事件 通知(", ["通知(数值 为 整数型)"]],
			["触发事件 继承通知(", ["继承通知(消息 为 文本型)"]],
			["通知(", undefined],
			["触发事件 计算(", undefined]
		] as const;
		const sdk: Sdk = { directory: "C:/sdk", capabilities: { projects: [], tools: [] }, templates: {}, issues: [], manifests: [{ kind: "runtime", name: "运行库", directory: "C:/sdk", filePath: "C:/sdk/runtime.json", categories: [{ name: "对象", definitions: [{ name: "工具", kind: "object", functions: [{ name: "计算", global: true, params: [{ name: "参数", type: "整数型" }] }] }] }] }] };
		for (const local of ["", "变量 通知 为 整数型\n", "变量 继承通知 为 整数型\n"]) for (const [call, expected] of cases) {
			const source = "事件 通知(数值 为 整数型)\n结束 事件\n过程 测试()\n" + local + call;
			const current: RefactoringUnit = { sourceRoot: root, filePath: path.join(root, "派生类.simple"), userCode: source, property: inspectSimplePropertyXml("$属性\n$资源 $对象\n基础对象 = 基类\n$结束 $属性") };
			const provider = new SimpleSignatureHelpProvider(() => source, () => refactoringContext(current, [base, current]));
			provider.updateSdk(sdk);
			const document = await vscode.workspace.openTextDocument({ language: "simple", content: source });
			const cancellation = new vscode.CancellationTokenSource();
			try {
				const help = provider.provideSignatureHelp(document, document.positionAt(source.length), cancellation.token, { isRetrigger: false, triggerKind: vscode.SignatureHelpTriggerKind.Invoke, triggerCharacter: undefined, activeSignatureHelp: undefined });
				assert.deepEqual(help?.signatures.map((signature) => signature.label), expected);
			} finally { cancellation.dispose(); }
		}
	});
	test("添加项目异步读取期间接收外部列表变更，保留项目及去重", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-integrity-project-race-"));
		try {
			const file = path.join(directory, "project.properties");
			await fs.writeFile(file, "name=测试\nsource=./src\n");
			for (const external of [path.join(directory, "external/project.properties"), file]) {
				let reads = 0;
				let registered: readonly string[] = [];
				const programs = new ProgramTreeProvider({
					get: <T>(_key: string, _fallback: T) => { const current = registered; if (++reads === 2) queueMicrotask(() => { registered = [external]; programs.reloadProjectConfiguration(); }); return current as T; },
					update: async (_key, value) => { registered = value as readonly string[]; }
				});
				try {
					assert.equal(await programs.addProject(file), external !== file);
					assert.deepEqual(registered, external === file ? [file] : [external, file]);
				} finally { programs.dispose(); }
			}
		} finally { await fs.rm(directory, { recursive: true, force: true }); }
	});

	test("复制读取内容与后续快照不一致时拒绝创建，重试复制最新内容", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-integrity-copy-race-"));
		const programs = new ProgramTreeProvider();
		const file = path.join(directory, "src/对象.simple");
		const before = "变量 值 为 整数型 = 1\n$属性\n$资源 $对象\n$结束 $属性\n";
		const after = before.replace("= 1", "= 2");
		let changed = false;
		const documents = new SimpleCodeFileSystemProvider({ ...vscode.workspace.fs, readFile: async (uri) => {
			if (!changed && sameFilePath(uri.fsPath, file)) { changed = true; await fs.writeFile(file, after); }
			return vscode.workspace.fs.readFile(uri);
		} });
		const controller = new UnitTransferController(programs, { codeDocuments: documents, refreshProjectSemantics: async () => undefined });
		try {
			await fs.mkdir(path.join(directory, "src/target"), { recursive: true });
			const projectFile = path.join(directory, "project.properties");
			await fs.writeFile(projectFile, "name=测试\nsource=./src\n");
			await fs.writeFile(file, before);
			await programs.addProject(projectFile);
			const project = await loadSimpleProject(projectFile);
			const source = { kind: "unit" as const, label: "对象", filePath: file, project };
			const target = { kind: "directory" as const, mode: "units" as const, label: "target", directoryPath: path.join(directory, "src/target"), project };
			await controller.copy(source);
			await assert.rejects(controller.paste(target), /快照不一致/u);
			assert.equal(changed, true);
			assert.deepEqual(await fs.readdir(target.directoryPath), []);
			assert.equal(await fs.readFile(file, "utf8"), after);
			await controller.paste(target);
			assert.ok((await fs.readFile(path.join(target.directoryPath, "对象.simple"), "utf8")).includes("= 2"));
		} finally { controller.dispose(); documents.dispose(); programs.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
	});
	test("项目持久化失败不修改内存，重试可成功，并发添加不重复", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-integrity-project-"));
		let fail = true;
		let registered: readonly string[] = [];
		const programs = new ProgramTreeProvider({ get: <T>(_key: string, _fallback: T) => registered as T, update: async (_key, value) => { if (fail) throw new Error("故障注入"); registered = value as readonly string[]; } });
		try {
			const file = path.join(directory, "project.properties");
			await fs.writeFile(file, "name=测试\nsource=./src\n");
			await assert.rejects(programs.addProject(file), /故障注入/u);
			assert.equal((await programs.getProjects()).length, 0);
			fail = false;
			assert.deepEqual(await Promise.all([programs.addProject(file), programs.addProject(file)]), [true, false]);
			assert.equal((await programs.getProjects()).length, 1);
			fail = true;
			await assert.rejects(programs.removeProject(file), /故障注入/u);
			assert.equal((await programs.getProjects()).length, 1);
			fail = false;
			assert.equal(await programs.removeProject(file), true);
			// 配置事件尚未送达时，新的项目操作仍须保留外部刚加入的项目。
			const external = path.join(directory, "external", "project.properties");
			await fs.mkdir(path.dirname(external));
			await fs.writeFile(external, "name=外部项目\n");
			registered = [external];
			assert.equal(await programs.addProject(file), true);
			assert.deepEqual(registered, [external, file]);
			fail = true;
			await assert.rejects(programs.moveProjects([file], external), /故障注入/u);
			assert.deepEqual((await programs.getProjects()).map((project) => project.filePath), [external, file]);
		} finally { programs.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
	});

	test("恢复设计器备份保留原冲突基线，拒绝覆盖离线期间的 XML 修改", async () => {
		await vscode.extensions.getExtension(testExtensionId())!.activate();
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-integrity-backup-"));
		const file = path.join(directory, "对象.simple");
		const uri = toSimpleCodeUri(vscode.Uri.file(file));
		const source = '过程 测试()\n结束 过程\n$属性\n$资源 $对象\n未知 = "原值"\n$结束 $属性\n';
		const first = new SimpleCodeFileSystemProvider();
		const second = new SimpleCodeFileSystemProvider();
		try {
			await fs.writeFile(file, source);
			const code = await vscode.workspace.openTextDocument(uri);
			await first.readFile(uri);
			const original = first.getProperty(code)!.document!;
			const updated = writePropertyXmlValue(original, "/属性/赋值[@属性='未知']/@值", '"设计器草稿"');
			await first.applyDesignerPropertyEdit(code, original, updated, code.getText());
			const backup = await first.backupDesignerProperty(code);
			const external = source.replace("原值", "外部修改");
			await fs.writeFile(file, external);
			await second.readFile(uri);
			await second.restoreDesignerProperty(code, backup);
			await assert.rejects(second.saveDesignerProperty(code), /磁盘上修改/u);
			assert.equal(await fs.readFile(file, "utf8"), external);
			// 外部文件恢复原基线后，仍可保存同一份草稿；备份中的代码不覆盖磁盘新代码。
			await fs.writeFile(file, source.replace("过程 测试", "过程 外部代码"));
			await second.saveDesignerProperty(code);
			const saved = await fs.readFile(file, "utf8");
			assert.ok(saved.startsWith("过程 外部代码()"));
			assert.ok(saved.includes("设计器草稿"));
			// 旧格式缺少原基线仍可找回草稿并另存，但不能因此覆盖已经不同的原文件。
			await second.restoreDesignerProperty(code, Buffer.from(source.replace("原值", "旧格式草稿")));
			await assert.rejects(second.saveDesignerProperty(code), /磁盘上修改/u);
			const destination = vscode.Uri.file(path.join(directory, "另存.simple"));
			await second.saveDesignerPropertyAs(code, destination);
			assert.ok((await fs.readFile(destination.fsPath, "utf8")).includes("旧格式草稿"));
			assert.equal(await fs.readFile(file, "utf8"), saved);
		} finally { first.dispose(); second.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
	});

	test("工程配置写入期间发生外部修改时拒绝替换并清理临时文件", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-integrity-config-"));
		const uri = vscode.Uri.file(path.join(directory, "settings.json"));
		const before = '{"es4a.projects":[],"editor.fontSize":14}';
		const external = '{"es4a.projects":[],"editor.fontSize":20,"external":true}';
		try {
			await fs.writeFile(uri.fsPath, before);
			const injected: typeof vscode.workspace.fs = { ...vscode.workspace.fs, writeFile: async (temporary, content) => {
				await vscode.workspace.fs.writeFile(temporary, content);
				await fs.writeFile(uri.fsPath, external);
			} };
			await assert.rejects(writeWorkspaceConfiguration(uri, undefined, ["es4a.projects"], [{ path: "demo" }], injected), /已变化/u);
			assert.equal(await fs.readFile(uri.fsPath, "utf8"), external);
			assert.deepEqual(await fs.readdir(directory), ["settings.json"]);
			await writeWorkspaceConfiguration(uri, undefined, ["es4a.projects"], [{ path: "demo" }]);
			assert.equal(JSON.parse(await fs.readFile(uri.fsPath, "utf8")).external, true);
			// 进入写入队列之前发生的同字段修改也必须按调用方基线拒绝。
			const saved = await fs.readFile(uri.fsPath, "utf8");
			await assert.rejects(writeWorkspaceConfiguration(uri, undefined, ["es4a.projects"], [], vscode.workspace.fs, { value: [] }), /配置已变化/u);
			assert.equal(await fs.readFile(uri.fsPath, "utf8"), saved);
			assert.deepEqual(await fs.readdir(directory), ["settings.json"]);
		} finally { await fs.rm(directory, { recursive: true, force: true }); }
	});

	test("工程配置有未保存输入时不写磁盘，拒绝制造缓冲区和磁盘两个版本", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-integrity-dirty-config-"));
		const uri = vscode.Uri.file(path.join(directory, "settings.json"));
		try {
			await fs.writeFile(uri.fsPath, "{}");
			const document = await vscode.workspace.openTextDocument(uri);
			const edit = new vscode.WorkspaceEdit();
			edit.insert(uri, new vscode.Position(0, 1), '"draft":true');
			assert.ok(await vscode.workspace.applyEdit(edit));
			await assert.rejects(writeWorkspaceConfiguration(uri, undefined, ["es4a.projects"], []), /未保存修改/u);
			assert.equal(document.getText(), '{"draft":true}');
			assert.equal(await fs.readFile(uri.fsPath, "utf8"), "{}");
			await document.save();
		} finally { await fs.rm(directory, { recursive: true, force: true }); }
	});

	test("参数提示遵循真实绑定和遮蔽，续行调用有效且声明头不弹提示", async () => {
		const sdk: Sdk = { directory: "C:/sdk", capabilities: { projects: [], tools: [] }, templates: {}, issues: [], manifests: [{ kind: "runtime", name: "测试", directory: "C:/sdk", filePath: "C:/sdk/runtime.json", categories: [{ name: "对象", definitions: [{ name: "工具", kind: "object", functions: [
			{ name: "计算", global: true, params: [{ name: "整数", type: "整数型" }] },
			{ name: "实例方法", params: [{ name: "文本", type: "文本型" }] }
		] }] }] }] };
		const run = async (source: string) => {
			const document = await vscode.workspace.openTextDocument({ language: "simple", content: source });
			const current: RefactoringUnit = { userCode: source, sourceRoot: path.resolve("integrity/src"), filePath: path.resolve("integrity/src/对象.simple"), property: inspectSimplePropertyXml("$属性\n$资源 $对象\n$结束 $属性") };
			const provider = new SimpleSignatureHelpProvider(() => source, () => refactoringContext(current, [current]));
			provider.updateSdk(sdk);
			return provider.provideSignatureHelp(document, document.positionAt(source.length), new vscode.CancellationTokenSource().token, { isRetrigger: false, triggerKind: vscode.SignatureHelpTriggerKind.Invoke, triggerCharacter: undefined, activeSignatureHelp: undefined });
		};
		assert.equal(await run("过程 测试()\n变量 计算 为 整数型(10)\n计算("), undefined);
		assert.equal(await run("过程 测试()\n实例方法("), undefined);
		assert.equal(await run("函数 _\n计算(参数 为 整数型, "), undefined);
		const source = "过程 计算(文本 为 文本型)\n结束 过程\n过程 测试()\n计算 _\n(";
		assert.deepEqual((await run(source))?.signatures.map((signature) => signature.label), ["计算(文本 为 文本型)"]);
	});

	test("无限定调用保留本地及基类重载，同参数个数的派生成员覆盖基类", async () => {
		const root = path.resolve("integrity/src");
		const base: RefactoringUnit = { sourceRoot: root, filePath: path.join(root, "基类.simple"), userCode: "过程 计算(旧参数 为 整数型)\n结束 过程\n过程 计算(基类参数 为 整数型, 另一个 为 整数型)\n结束 过程\n", property: inspectSimplePropertyXml("$属性\n$资源 $对象\n$结束 $属性") };
		const source = "过程 计算(本地参数 为 整数型)\n结束 过程\n过程 测试()\n计算(1, ";
		const current: RefactoringUnit = { userCode: source, sourceRoot: root, filePath: path.join(root, "派生类.simple"), property: inspectSimplePropertyXml("$属性\n$资源 $对象\n基础对象 = 基类\n$结束 $属性") };
		const provider = new SimpleSignatureHelpProvider(() => source, () => refactoringContext(current, [base, current]));
		const document = await vscode.workspace.openTextDocument({ language: "simple", content: source });
		const cancellation = new vscode.CancellationTokenSource();
		try {
			const help = provider.provideSignatureHelp(document, document.positionAt(source.length), cancellation.token, { isRetrigger: false, triggerKind: vscode.SignatureHelpTriggerKind.Invoke, triggerCharacter: undefined, activeSignatureHelp: undefined });
			assert.deepEqual(help?.signatures.map((signature) => signature.label), ["计算(本地参数 为 整数型)", "计算(基类参数 为 整数型, 另一个 为 整数型)"]);
			assert.equal(help?.activeParameter, 1);
			assert.equal(help?.activeSignature, 1);
		} finally { cancellation.dispose(); }
	});
});
