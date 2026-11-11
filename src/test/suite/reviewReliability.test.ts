/*
在真实扩展宿主核对源码树、搜索和类库刷新的一致性。
xhwsd@qq.com 2026-11-7
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { SimpleCodeFileSystemProvider, toSimpleCodeUri, toSimpleSourceUri } from "../../simpleCodeFileSystem";
import { SimpleProjectRefactoring } from "../../projectRefactoring";
import { loadSimpleProject } from "../../programResources";
import { sameFilePath } from "../../simpleProjectPaths";
import { LibraryTreeProvider } from "../../libraryTree";
import { loadSdk } from "../../sdk";
import { hasOpenSimpleUnitTab } from "../../simpleUnitTabs";
import { testExtensionId, testSdkPath } from "../testFixtures";
import { WorkbenchDriver } from "./workbenchDriver";

suite("扩展深审边界", () => {
	test("取消 SDK 选择框后应用等待期间发生的配置变更", async () => {
		await vscode.extensions.getExtension(testExtensionId())!.activate();
		const config = vscode.workspace.getConfiguration("es4a");
		const previous = config.inspect<string>("sdk.path")?.globalValue;
		const windowApi = vscode.window as { showOpenDialog: typeof vscode.window.showOpenDialog };
		const originalDialog = windowApi.showOpenDialog;
		let open!: () => void;
		let close!: (value: undefined) => void;
		const opened = new Promise<void>((resolve) => { open = resolve; });
		const dialog = new Promise<undefined>((resolve) => { close = resolve; });
		let selecting: Thenable<unknown> | undefined;
		let listener: vscode.Disposable | undefined;
		try {
			await config.update("sdk.path", testSdkPath(), vscode.ConfigurationTarget.Global);
			await vscode.commands.executeCommand("es4a.refreshLibraries");
			const document = await vscode.workspace.openTextDocument({ language: "simple", content: '显示提示框("回归")' });
			const hasHover = async () => (await vscode.commands.executeCommand<readonly vscode.Hover[]>("vscode.executeHoverProvider", document.uri, new vscode.Position(0, 2))).length > 0;
			assert.equal(await hasHover(), true);
			windowApi.showOpenDialog = () => { open(); return dialog; };
			selecting = vscode.commands.executeCommand("es4a.selectSdk");
			await opened;
			const changed = new Promise<void>((resolve) => {
				listener = vscode.workspace.onDidChangeConfiguration((event) => {
					if (event.affectsConfiguration("es4a.sdk.path")) resolve();
				});
			});
			await config.update("sdk.path", "", vscode.ConfigurationTarget.Global);
			await changed;
			close(undefined);
			await selecting;
			assert.equal(await hasHover(), false);
		} finally {
			close(undefined);
			windowApi.showOpenDialog = originalDialog;
			listener?.dispose();
			await selecting;
			await config.update("sdk.path", previous, vscode.ConfigurationTarget.Global);
			await vscode.commands.executeCommand("es4a.refreshLibraries");
		}
	});

	test("移除项目只关闭其独有标签，保留共享单元及未保存代码", async () => {
		await vscode.extensions.getExtension(testExtensionId())!.activate();
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-shared-tabs-"));
		const first = path.join(directory, "A", "project.properties");
		const second = path.join(directory, "B", "project.properties");
		const shared = vscode.Uri.file(path.join(directory, "shared", "Shared.simple"));
		const only = vscode.Uri.file(path.join(directory, "A", "src", "Only.simple"));
		let sharedDocument: vscode.TextDocument | undefined;
		try {
			for (const folder of [path.dirname(second), path.dirname(shared.fsPath), path.dirname(only.fsPath)]) {
				await fs.mkdir(folder, { recursive: true });
			}
			await fs.writeFile(first, "name=共享项目甲\r\nsource=./src,../shared\r\n");
			await fs.writeFile(second, "name=共享项目乙\r\nsource=../shared\r\n");
			const source = "常量 数值 为 整数型 = 1\r\n";
			await fs.writeFile(shared.fsPath, source);
			await fs.writeFile(only.fsPath, source);
			for (const project of [first, second]) await vscode.commands.executeCommand("es4a.internal.addProject", project);
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(toSimpleCodeUri(only)), { preview: false });
			sharedDocument = await vscode.workspace.openTextDocument(toSimpleCodeUri(shared));
			const editor = await vscode.window.showTextDocument(sharedDocument, { preview: false });
			assert.ok(await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), "' 共享草稿\r\n")));
			await vscode.commands.executeCommand("es4a.removeProject", { kind: "project", project: await loadSimpleProject(first) });
			assert.equal(hasOpenSimpleUnitTab(only), false);
			assert.equal(hasOpenSimpleUnitTab(shared), true);
			assert.equal(sharedDocument.isDirty, true);
			assert.match(sharedDocument.getText(), /共享草稿/u);
			assert.equal(await fs.readFile(shared.fsPath, "utf8"), source);
		} finally {
			if (sharedDocument?.isDirty) assert.ok(await sharedDocument.save());
			for (const project of [first, second]) await vscode.commands.executeCommand("es4a.internal.removeProject", project);
			assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
			assert.ok(path.basename(directory).startsWith("es4a-shared-tabs-"));
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	test("外部修改属性区后当前代码标签的设计器入口随单元类型更新", async function () {
		this.timeout(30000);
		await vscode.extensions.getExtension(testExtensionId())!.activate();
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-designer-context-"));
		const project = path.join(directory, "project.properties");
		const file = path.join(directory, "src", "切换类型.simple");
		const code = "' 用户代码保持原样\r\n";
		const object = code + "$属性\r\n$资源 $对象\r\n$结束 $属性\r\n";
		const window = code + "$属性\r\n$资源 $窗口\r\n$定义 切换类型 $为 窗口\r\n$结束 $定义\r\n$结束 $属性\r\n";
		let driver: WorkbenchDriver | undefined;
		try {
			await fs.mkdir(path.dirname(file));
			await fs.writeFile(project, "source=./src\r\n");
			await fs.writeFile(file, object);
			await vscode.commands.executeCommand("es4a.internal.addProject", project);
			const document = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(file)));
			await vscode.window.showTextDocument(document, { preview: false });
			driver = await WorkbenchDriver.connect();
			const hasDesigner = "[...document.querySelectorAll('.editor-actions .action-label')].some(action => action.getClientRects().length && (action.getAttribute('aria-label') ?? action.getAttribute('title') ?? '').includes('设计窗口布局'))";
			await driver.waitFor(`!(${hasDesigner})`);
			await fs.writeFile(file, window);
			await driver.waitFor(hasDesigner);
			assert.equal(vscode.window.activeTextEditor?.document, document);
			assert.equal(document.getText(), code);
			await fs.writeFile(file, object);
			await driver.waitFor(`!(${hasDesigner})`);
			assert.equal(vscode.window.activeTextEditor?.document, document);
		} finally {
			driver?.dispose();
			await vscode.commands.executeCommand("es4a.internal.removeProject", project);
			assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
			assert.ok(path.basename(directory).startsWith("es4a-designer-context-"));
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	test("类库树显示复用进行中的加载，显式刷新后迟到的旧错误不会覆盖新 SDK", async () => {
		const sdk = await loadSdk(testSdkPath());
		let rejectOld!: (error: Error) => void;
		const old = new Promise<undefined>((_resolve, reject) => { rejectOld = reject; });
		let reads = 0;
		const provider = new LibraryTreeProvider(() => ++reads === 1 ? old : Promise.resolve(sdk));
		const first = provider.ensureLoaded();
		const second = provider.ensureLoaded();
		try {
			await Promise.resolve();
			assert.equal(reads, 1);
			await provider.refresh();
			assert.ok(provider.getChildren().some((node) => node.kind === "manifest" && node.manifest === sdk.manifests[0]));
			rejectOld(new Error("旧 SDK 暂时不可读"));
			await Promise.all([first, second]);
			assert.equal(reads, 2);
			assert.ok(provider.getChildren().some((node) => node.kind === "manifest" && node.manifest === sdk.manifests[0]));
		} finally {
			rejectOld(new Error("结束旧 SDK 测试读取"));
			await Promise.allSettled([first, second]);
			provider.dispose();
		}
	});

	test("搜索快速切换关键词不会接受旧结果，当前结果打开正确的代码选区", async function () {
		this.timeout(30000);
		await vscode.extensions.getExtension(testExtensionId())!.activate();
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-review-search-"));
		const file = path.join(directory, "搜索目标.simple");
		const input = ".quick-input-widget input";
		let driver: WorkbenchDriver | undefined;
		let pending: Thenable<void> | undefined;
		try {
			await fs.writeFile(file, "常量 初次关键词 为 整数型 = 1\r\n常量 最终关键词 为 整数型 = 2\r\n");
			driver = await WorkbenchDriver.connect();
			pending = vscode.commands.executeCommand<void>("es4a.searchUnitCode", { kind: "directory", mode: "units", directoryPath: directory, label: "搜索回归" });
			await driver.fill(input, "初次关键词");
			const resultRow = (text: string) => `[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].some(row => row.getClientRects().length && row.textContent.includes(${JSON.stringify(text)}))`;
			await driver.waitFor(resultRow("初次关键词"));
			await driver.fill(input, "没有结果的关键词");
			await driver.key("Enter");
			await driver.waitFor("[...document.querySelectorAll('.quick-input-widget')].some(widget => widget.getClientRects().length && widget.textContent.includes('0 条'))");
			await driver.fill(input, "最终关键词");
			await driver.waitFor(resultRow("最终关键词"));
			await driver.key("Enter");
			await pending;
			pending = undefined;
			const editor = vscode.window.activeTextEditor;
			const source = editor === undefined ? undefined : toSimpleSourceUri(editor.document.uri);
			assert.ok(editor && source && sameFilePath(source.fsPath, file));
			assert.equal(editor.document.getText(editor.selection), "最终关键词");
		} finally {
			if (pending !== undefined && driver !== undefined) {
				await driver.key("Escape");
				await pending;
			}
			const editor = vscode.window.activeTextEditor;
			const source = editor === undefined ? undefined : toSimpleSourceUri(editor.document.uri);
			if (source !== undefined && sameFilePath(source.fsPath, file)) {
				await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
			}
			driver?.dispose();
			assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
			assert.ok(path.basename(directory).startsWith("es4a-review-search-"));
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	test("源码根覆盖项目时，生成单元只在构建分支显示且不参与重构", async function () {
		this.timeout(30000);
		await vscode.extensions.getExtension(testExtensionId())!.activate();
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-review-source-root-"));
		const projectFile = path.join(directory, "project.properties");
		const file = path.join(directory, "保留深审单元.simple");
		const generated = path.join(directory, "深审产物", "生成深审文件.simple");
		const provider = new SimpleCodeFileSystemProvider();
		const refactoring = new SimpleProjectRefactoring({
			codeDocuments: provider,
			refreshProjectSemantics: async () => undefined
		});
		let driver: WorkbenchDriver | undefined;
		let added = false;
		try {
			await fs.mkdir(path.dirname(generated));
			await fs.writeFile(projectFile, "name=根目录源码深审\r\nsource=./\r\nbuild=./深审产物\r\n");
			await fs.writeFile(file, "$属性\r\n$资源 $对象\r\n$结束 $属性\r\n");
			await fs.writeFile(generated, "生成内容不作为源码解析");
			const project = await loadSimpleProject(projectFile);
			const units = await refactoring.readProject(project);
			assert.equal(units.length, 1);
			assert.equal(sameFilePath(units[0]!.filePath, file), true);
			await vscode.commands.executeCommand("es4a.internal.addProject", projectFile);
			added = true;
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(file))));
			await vscode.commands.executeCommand("es4a.programs.focus");
			driver = await WorkbenchDriver.connect();
			const row = (label: string) => "[...document.querySelectorAll('.monaco-list-row')].find(row => row.querySelector('.label-name')?.textContent === " + JSON.stringify(label) + ")";
			await driver.waitFor("Boolean(" + row("根目录源码深审") + ") && Boolean(" + row("保留深审单元") + ")");
			assert.equal(await driver.evaluate("Boolean(" + row("深审产物") + ")"), false, "源码分支不显示生成目录");
			const opened = await driver.evaluate([
				"(() => {",
				"const rows = [...document.querySelectorAll('.monaco-list-row')];",
				"const owner = rows.findIndex(row => row.querySelector('.label-name')?.textContent === '根目录源码深审');",
				"const build = rows.slice(owner + 1).find(row => row.querySelector('.label-name')?.textContent === '构建');",
				"if (!build) return false;",
				"build.querySelector('.monaco-tl-twistie').click();",
				"return true;",
				"})()"
			].join("\n"));
			assert.equal(opened, true);
			await driver.waitFor("Boolean(" + row("生成深审文件.simple") + ")");
		} finally {
			driver?.dispose();
			refactoring.dispose();
			provider.dispose();
			if (added) {
				await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			}
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});
});
