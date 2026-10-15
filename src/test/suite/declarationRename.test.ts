/*
在真实代码编辑器中验证声明直接输入后的同步时机、保存、冲突和原生撤销。
xhwsd@qq.com 2026-10-10
*/

import { testSdkPath } from "../testFixtures";

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { toSimpleCodeUri } from "../../simpleCodeFileSystem";
import { SimpleCodeFileSystemProvider } from "../../simpleCodeFileSystem";
import { SimpleDeclarationRenameController } from "../../declarationRenameController";
import { SimpleProjectRefactoring } from "../../projectRefactoring";
import type { ProgramTreeProvider } from "../../programTree";
import { refactoringContext, type RefactoringUnit } from "../../refactoringModel";
import { inspectSimplePropertyXml } from "../../propertyXml";
import { loadSimpleProject } from "../../programResources";
import { loadSdk } from "../../sdk";
import { getVisibleSimpleUnitUserCode } from "../../simpleUnitSource";

const property = "$属性\r\n$资源 $对象\r\n$结束 $属性\r\n";
const local = "过程 P(参数 为 整数型)\r\n\t变量 旧值 为 整数型\r\n\t旧值 = 参数\r\n结束 过程\r\n过程 Q()\r\n\t变量 旧值 为 整数型\r\n\t旧值 = 2\r\n结束 过程\r\n";

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
	assert.ok(predicate(), "应在编辑完成后得到实际同步结果");
}

async function withProject(code: string, run: (editor: vscode.TextEditor, file: string, directory: string) => Promise<void>, other?: string): Promise<void> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-auto-declaration-"));
	const project = path.join(directory, "project.properties");
	const file = path.join(directory, "src", "对象1.simple");
	try {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(project, "source=./src\r\nmain=对象1\r\n");
		await fs.writeFile(file, code + property);
		if (other !== undefined) await fs.writeFile(path.join(directory, "src", "调用者.simple"), other + property);
		await vscode.commands.executeCommand("es4a.internal.addProject", project);
		await vscode.commands.executeCommand("es4a.refreshPrograms");
		const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(file))), { preview: false });
		// 等待实际声明悬停，证明项目语义已可供输入监听使用。
		const position = editor.document.positionAt(code.indexOf("旧值"));
		let ready = false;
		for (let attempt = 0; attempt < 100 && !ready; attempt += 1) {
			const values = await vscode.commands.executeCommand<readonly vscode.Hover[]>("vscode.executeHoverProvider", editor.document.uri, position);
			ready = values.length > 0;
			if (!ready) await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.ok(ready);
		await run(editor, file, directory);
	} finally {
		await vscode.commands.executeCommand("es4a.internal.removeProject", project);
		await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}

async function typeName(editor: vscode.TextEditor, name: string, previous = "旧值"): Promise<void> {
	const start = editor.document.getText().indexOf(previous);
	assert.ok(start >= 0);
	editor.selection = new vscode.Selection(editor.document.positionAt(start), editor.document.positionAt(start + previous.length));
	await vscode.commands.executeCommand("type", { text: name });
}

suite("声明直接改名", () => {
	let originalSdkPath: string | undefined;
	suiteSetup(async () => {
		const configuration = vscode.workspace.getConfiguration("es4a");
		originalSdkPath = configuration.inspect<string>("sdk.path")?.globalValue;
		await configuration.update("sdk.path", testSdkPath("sdk.json"), vscode.ConfigurationTarget.Global);
		await vscode.extensions.getExtension("es4a.es4a")!.activate();
		await vscode.commands.executeCommand("es4a.refreshLibraries");
	});
	suiteTeardown(async () => { await vscode.workspace.getConfiguration("es4a").update("sdk.path", originalSdkPath, vscode.ConfigurationTarget.Global); });

	test("连续中文名称输入期间不改引用，离开声明行同步并随输入整体撤销", async () => {
		await withProject(local, async (editor, file) => {
			await typeName(editor, "新");
			await vscode.commands.executeCommand("type", { text: "值" });
			await new Promise((resolve) => setTimeout(resolve, 300));
			assert.equal(editor.document.getText(), getVisibleSimpleUnitUserCode(local.replace("变量 旧值", "变量 新值") + property));
			editor.selection = new vscode.Selection(2, 1, 2, 1);
			await waitFor(() => editor.document.getText().includes("新值 = 参数"));
			assert.equal(editor.document.getText(), getVisibleSimpleUnitUserCode(local.replace("变量 旧值", "变量 新值").replace("旧值 = 参数", "新值 = 参数") + property));
			assert.equal(await fs.readFile(file, "utf8"), local + property);
			await vscode.commands.executeCommand("undo");
			assert.equal(editor.document.getText(), getVisibleSimpleUnitUserCode(local + property));
			await vscode.commands.executeCommand("redo");
			assert.ok(editor.document.getText().includes("新值 = 参数"));
		});
	});

	for (const trigger of ["方向键", "空格", "制表符"] as const) test(`直接输入新名称后${trigger}触发同步，连续改名保留其它作用域和属性区`, async () => {
		await withProject(local, async (editor, file) => {
			await typeName(editor, "新值");
			if (trigger === "方向键") await vscode.commands.executeCommand("cursorDown");
			else await vscode.commands.executeCommand("type", { text: trigger === "空格" ? " " : "\t" });
			await waitFor(() => editor.document.getText().includes("新值 = 参数"));
			await typeName(editor, "最终值", "新值");
			await vscode.commands.executeCommand("cursorDown");
			await waitFor(() => editor.document.getText().includes("最终值 = 参数"));
			assert.match(editor.document.getText(), /过程 Q\(\)\r\n\t变量 旧值 为 整数型\r\n\t旧值 = 2/u);
			assert.equal(await fs.readFile(file, "utf8"), local + property);
			await editor.document.save();
			assert.equal(getVisibleSimpleUnitUserCode(await fs.readFile(file, "utf8")), editor.document.getText());
			assert.equal((await fs.readFile(file, "utf8")).slice(-property.length), property);
		});
	});

	test("直接输入的名称捕获 SDK 函数时保留手动输入并警告，继续改正后正常同步", async () => {
		const code = '过程 P()\r\n\t变量 旧值 为 整数型\r\n\t旧值 = 1\r\n\t显示提示框("原调用")\r\n结束 过程\r\n';
		await withProject(code, async (editor, file) => {
			await typeName(editor, "显示提示框");
			editor.selection = new vscode.Selection(2, 0, 2, 0);
			await waitFor(() => vscode.languages.getDiagnostics(editor.document.uri).some((issue) => issue.source === "ES4A 自动重构" && issue.message.includes("改变已有引用的目标")));
			assert.equal(editor.document.getText(), getVisibleSimpleUnitUserCode(code.replace("变量 旧值", "变量 显示提示框") + property));
			assert.equal(await fs.readFile(file, "utf8"), code + property);
			await typeName(editor, "新值", "显示提示框");
			editor.selection = new vscode.Selection(2, 0, 2, 0);
			await waitFor(() => editor.document.getText().includes("\t新值 = 1"));
			assert.equal(editor.document.getText(), getVisibleSimpleUnitUserCode(code.replaceAll("旧值", "新值") + property));
			assert.ok(!vscode.languages.getDiagnostics(editor.document.uri).some((issue) => issue.source === "ES4A 自动重构"));
			assert.equal(await fs.readFile(file, "utf8"), code + property);
		});
	});

	test("手动保存提交尚在声明行的改名，属性区逐字保持", async () => {
		await withProject(local, async (editor, file) => {
			await typeName(editor, "新的值");
			assert.equal(await editor.document.save(), true);
			assert.equal(await fs.readFile(file, "utf8"), local.replace("变量 旧值", "变量 新的值").replace("旧值 = 参数", "新的值 = 参数") + property);
		});
	});

	test("关闭变量同步后空格、离行和保存只保留声明输入，重新开启不补做旧改名", async () => {
		const configuration = vscode.workspace.getConfiguration("es4a");
		const key = "automaticSync.variable";
		const previous = configuration.inspect<boolean>(key)?.globalValue;
		try {
			await configuration.update(key, false, vscode.ConfigurationTarget.Global);
			await withProject(local, async (editor, file) => {
				await typeName(editor, "新值");
				await vscode.commands.executeCommand("type", { text: " " });
				editor.selection = new vscode.Selection(2, 1, 2, 1);
				assert.ok(await editor.document.save());
				const expected = local.replace("变量 旧值", "变量 新值 ") + property;
				assert.equal(await fs.readFile(file, "utf8"), expected);
				await configuration.update(key, true, vscode.ConfigurationTarget.Global);
				editor.selection = new vscode.Selection(3, 0, 3, 0);
				assert.ok(await editor.document.save());
				assert.equal(await fs.readFile(file, "utf8"), expected);
			});
		} finally { await configuration.update(key, previous, vscode.ConfigurationTarget.Global); }
	});

	test("输入名称后关闭再开启变量同步，待提交引用不能复活", async () => {
		const configuration = vscode.workspace.getConfiguration("es4a");
		const key = "automaticSync.variable";
		const previous = configuration.inspect<boolean>(key)?.globalValue;
		try {
			await configuration.update(key, true, vscode.ConfigurationTarget.Global);
			await withProject(local, async (editor, file) => {
				await typeName(editor, "新值");
				await configuration.update(key, false, vscode.ConfigurationTarget.Global);
				await configuration.update(key, true, vscode.ConfigurationTarget.Global);
				editor.selection = new vscode.Selection(2, 1, 2, 1);
				assert.ok(await editor.document.save());
				assert.equal(await fs.readFile(file, "utf8"), local.replace("变量 旧值", "变量 新值") + property);
			});
		} finally { await configuration.update(key, previous, vscode.ConfigurationTarget.Global); }
	});

	test("切换代码标签触发同步，保持新标签和所有代码的未保存状态", async () => {
		await withProject(local, async (editor, file, directory) => {
			await typeName(editor, "目标值");
			const next = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(path.join(directory, "src", "调用者.simple"))));
			await vscode.window.showTextDocument(next, { preview: false });
			await waitFor(() => editor.document.getText().includes("目标值 = 参数"));
			assert.equal(vscode.window.activeTextEditor?.document, next);
			assert.equal(await fs.readFile(file, "utf8"), local + property);
		}, "过程 Q()\r\n结束 过程\r\n");
	});

	test("同名冲突只在声明处提示，继续修正名称仍同步最初变量的引用", async () => {
		await withProject(local, async (editor) => {
			await typeName(editor, "参数");
			editor.selection = new vscode.Selection(2, 1, 2, 1);
			await waitFor(() => vscode.languages.getDiagnostics(editor.document.uri).some((issue) => issue.source === "ES4A 自动重构"));
			assert.ok(editor.document.getText().includes("旧值 = 参数"));
			const start = editor.document.getText().indexOf("变量 参数") + "变量 ".length;
			editor.selection = new vscode.Selection(editor.document.positionAt(start), editor.document.positionAt(start + 2));
			await vscode.commands.executeCommand("type", { text: "修正值" });
			editor.selection = new vscode.Selection(2, 1, 2, 1);
			await waitFor(() => editor.document.getText().includes("修正值 = 参数"));
			assert.equal(vscode.languages.getDiagnostics(editor.document.uri).some((issue) => issue.source === "ES4A 自动重构"), false);
		});
	});

	test("成员变量声明同步其它单元，原生撤销先恢复同步引用再恢复手动声明", async () => {
		const code = "变量 旧值 为 整数型\r\n过程 P()\r\n\t旧值 = 1\r\n结束 过程\r\n";
		const caller = "过程 Q()\r\n\t变量 a 为 对象1\r\n\ta.旧值 = 2\r\n结束 过程\r\n";
		await withProject(code, async (editor, file, directory) => {
			const other = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(path.join(directory, "src", "调用者.simple"))));
			await typeName(editor, "新字段");
			editor.selection = new vscode.Selection(1, 0, 1, 0);
			// 工作区编辑可逐文档发出通知，必须等两个文档都更新后再检查整个事务。
			await waitFor(() => other.getText().includes("a.新字段") && editor.document.getText().includes("新字段 = 1"));
			assert.ok(editor.document.getText().includes("新字段 = 1"));
			assert.equal(await fs.readFile(file, "utf8"), code + property);
			await vscode.commands.executeCommand("undo");
			assert.ok(editor.document.getText().includes("变量 新字段"));
			assert.ok(editor.document.getText().includes("旧值 = 1"));
			assert.equal(other.getText(), getVisibleSimpleUnitUserCode(caller + property));
			await vscode.commands.executeCommand("undo");
			assert.equal(editor.document.getText(), getVisibleSimpleUnitUserCode(code + property));
			await vscode.commands.executeCommand("redo");
			await vscode.commands.executeCommand("redo");
			assert.ok(other.getText().includes("a.新字段"));
		}, caller);
	});

	test("多光标同时编辑不推测自动改名", async () => {
		await withProject(local, async (editor) => {
			const code = editor.document.getText();
			const start = code.indexOf("旧值");
			const second = code.indexOf("变量 旧值", start + 2) + "变量 ".length;
			editor.selections = [start, second].map((offset) => new vscode.Selection(editor.document.positionAt(offset), editor.document.positionAt(offset + 2)));
			await vscode.commands.executeCommand("type", { text: "新值" });
			editor.selection = new vscode.Selection(2, 1, 2, 1);
			await new Promise((resolve) => setTimeout(resolve, 300));
			assert.ok(editor.document.getText().includes("旧值 = 参数"));
			assert.ok(editor.document.getText().includes("旧值 = 2"));
		});
	});

	test("项目忙碌只延后已提交的变量改名，完成事件不提前提交输入中的名称", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-auto-declaration-busy-"));
		const file = path.join(directory, "src", "对象1.simple");
		const documents = new SimpleCodeFileSystemProvider();
		const refactoring = new SimpleProjectRefactoring({ codeDocuments: documents, refreshProjectSemantics: async () => {} });
		const completed = new vscode.EventEmitter<void>();
		let busy = true;
		let controller: SimpleDeclarationRenameController | undefined;
		try {
			await fs.mkdir(path.dirname(file), { recursive: true });
			await fs.writeFile(file, local + property);
			const projectFile = path.join(directory, "project.properties");
			await fs.writeFile(projectFile, "source=./src\r\n");
			const project = await loadSimpleProject(projectFile);
			const sdk = await loadSdk(testSdkPath("sdk.json"));
			const document = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(file)));
			const editor = await vscode.window.showTextDocument(document, { preview: false });
			const errors: string[] = [];
			controller = new SimpleDeclarationRenameController(
				{ getProjects: async () => [project] } as unknown as ProgramTreeProvider,
				{ get isBusy() { return busy; }, onDidComplete: completed.event, readProject: refactoring.readProject.bind(refactoring) } as unknown as SimpleProjectRefactoring,
				documents, () => sdk,
				(candidate, source) => {
					if (candidate !== document) return undefined;
					const unit: RefactoringUnit = { filePath: file, sourceRoot: path.dirname(file), userCode: source, property: inspectSimplePropertyXml(property) };
					return refactoringContext(unit, [unit]);
				},
				(message) => errors.push(message)
			);
			await typeName(editor, "新值");
			busy = false; completed.fire();
			await new Promise((resolve) => setTimeout(resolve, 80));
			assert.ok(document.getText().includes("旧值 = 参数"), "仍在输入名称时，项目完成不能视为编辑结束");
			busy = true;
			await controller.flush(document);
			assert.ok(document.getText().includes("旧值 = 参数"));
			busy = false; completed.fire();
			await waitFor(() => document.getText().includes("新值 = 参数"));
			assert.ok(document.getText().includes("旧值 = 2"));
			assert.equal(await fs.readFile(file, "utf8"), local + property);
			assert.deepEqual(errors, []);
		} finally {
			controller?.dispose(); completed.dispose(); refactoring.dispose(); documents.dispose();
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	test("分析期间再次编辑会丢弃过期结果，不覆盖后续输入", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-auto-declaration-race-"));
		const file = path.join(directory, "src", "对象1.simple");
		const documents = new SimpleCodeFileSystemProvider();
		const refactoring = new SimpleProjectRefactoring({ codeDocuments: documents, refreshProjectSemantics: async () => {} });
		let controller: SimpleDeclarationRenameController | undefined;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let reading = false;
		try {
			await fs.mkdir(path.dirname(file), { recursive: true });
			await fs.writeFile(file, local + property);
			const projectFile = path.join(directory, "project.properties");
			await fs.writeFile(projectFile, "source=./src\r\n");
			const project = await loadSimpleProject(projectFile);
			const sdk = await loadSdk(testSdkPath("sdk.json"));
			const document = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(file)));
			const editor = await vscode.window.showTextDocument(document, { preview: false });
			const errors: string[] = [];
			controller = new SimpleDeclarationRenameController(
				{ getProjects: async () => { reading = true; await gate; return [project]; } } as unknown as ProgramTreeProvider,
				refactoring, documents, () => sdk,
				(candidate, source) => {
					if (candidate !== document) return undefined;
					const unit: RefactoringUnit = { filePath: file, sourceRoot: path.dirname(file), userCode: source, property: inspectSimplePropertyXml(property) };
					return refactoringContext(unit, [unit]);
				},
				(message) => errors.push(message)
			);
			await typeName(editor, "新值");
			const completed = controller.flush(document);
			await waitFor(() => reading);
			await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), "' 后续输入\r\n"));
			const wanted = document.getText();
			release();
			await completed;
			assert.equal(document.getText(), wanted);
			assert.ok(wanted.includes("旧值 = 参数"));
			assert.deepEqual(errors, []);
		} finally {
			release(); controller?.dispose(); refactoring.dispose(); documents.dispose();
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});
});
