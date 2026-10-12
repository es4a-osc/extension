/*
通过原生 F2 输入框及重构预览验证提交、取消、连续改名和跨区撤销，不直接应用计划代替操作。
xhwsd@qq.com 2026-10-12
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { toSimpleCodeUri, toSimpleSourceUri } from "../../simpleCodeFileSystem";
import { getVisibleSimpleUnitUserCode, splitSimpleUnitSource } from "../../simpleUnitSource";
import { loadSimpleProject } from "../../programResources";
import { isPathInsideOrEqual, sameFilePath } from "../../simpleProjectPaths";
import { toUnitXmlPreviewUri } from "../../unitPreview";
import { resolveSimpleUnitTab } from "../../simpleUnitTabs";
import { WorkbenchDriver } from "./workbenchDriver";

const windowProperty = '$属性\r\n\t$资源 $窗口\r\n\t$定义 主窗口 $为 窗口\r\n\t\t$定义 按钮1 $为 按钮\r\n\t\t\t未知属性 = "保留"\r\n\t\t$结束 $定义\r\n\t\t$定义 按钮2 $为 按钮\r\n\t\t\t位于左边 = 按钮1.标识\r\n\t\t$结束 $定义\r\n\t$结束 $定义\r\n$结束 $属性\r\n';
const objectProperty = "$属性\r\n$资源 $对象\r\n$结束 $属性\r\n";
const localCode = '过程 P()\r\n\t变量 旧值 为 整数型\r\n\t旧值 = 旧值 + 1\r\n\t显示提示框("旧值") \' 旧值保留\r\n结束 过程\r\n过程 Q()\r\n\t变量 旧值 为 整数型\r\n\t旧值 = 2\r\n结束 过程\r\n';
const componentCode = '事件 按钮1.被单击()\r\n\t按钮1.文本 = "按钮1"\r\n结束 事件\r\n';

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 250; attempt += 1) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.ok(await predicate(), "原生重构未在时限内完成");
}

async function withProject(code: string, action: (value: {
	readonly editor: vscode.TextEditor;
	readonly caller: vscode.TextDocument;
	readonly file: string;
	readonly callerFile: string;
	readonly source: string;
	readonly callerSource: string;
	readonly projectFile: string;
}) => Promise<void>, callerCode = '过程 P(a 为 主窗口)\r\n\ta.按钮1.文本 = "调用"\r\n结束 过程\r\n', nested = false): Promise<void> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-workbench-refactor-"));
	const project = path.join(directory, "project.properties");
	const file = path.join(directory, nested ? "src/pkg/主窗口.simple" : "src/主窗口.simple");
	const callerFile = path.join(directory, "src/调用者.simple");
	const source = code + windowProperty;
	const callerSource = callerCode + objectProperty;
	try {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(project, `source=./src\r\nmain=${nested ? "pkg." : ""}主窗口\r\n`);
		await fs.writeFile(file, source);
		await fs.writeFile(callerFile, callerSource);
		await vscode.commands.executeCommand("es4a.internal.addProject", project);
		const caller = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(callerFile)));
		const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(file))), { preview: false });
		await action({ editor, caller, file, callerFile, source, callerSource, projectFile: project });
	} finally {
		await vscode.commands.executeCommand("refactorPreview.discard");
		await vscode.commands.executeCommand("cancelRenameInput");
		for (const document of vscode.workspace.textDocuments) {
			const sourceUri = toSimpleSourceUri(document.uri) ?? document.uri;
			if (document.isClosed || !isPathInsideOrEqual(directory, sourceUri.fsPath) || !await vscode.workspace.fs.stat(document.uri).then(() => true, () => false)) continue;
			await vscode.window.showTextDocument(document);
			if (document.isDirty) await vscode.commands.executeCommand("workbench.action.files.revert");
			await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
		}
		await vscode.commands.executeCommand("es4a.internal.removeProject", project);
		assert.equal(path.dirname(directory), os.tmpdir());
		await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}

suite("原生重构操作", () => {
	let driver: WorkbenchDriver;
	let previousSdk: string | undefined;
	let previousAutoSave: boolean | undefined;
	suiteSetup(async () => {
		const configuration = vscode.workspace.getConfiguration("es4a");
		previousSdk = configuration.inspect<string>("sdk.path")?.globalValue;
		await configuration.update("sdk.path", path.resolve(__dirname, "../../../../sdk/sdk.json"), vscode.ConfigurationTarget.Global);
		await vscode.extensions.getExtension("es4a.es4a")!.activate();
		await vscode.commands.executeCommand("es4a.refreshLibraries");
		const files = vscode.workspace.getConfiguration("files");
		previousAutoSave = files.inspect<boolean>("refactoring.autoSave")?.globalValue;
		await files.update("refactoring.autoSave", false, vscode.ConfigurationTarget.Global);
		driver = await WorkbenchDriver.connect();
	});
	suiteTeardown(async () => {
		driver?.dispose();
		await vscode.workspace.getConfiguration("files").update("refactoring.autoSave", previousAutoSave, vscode.ConfigurationTarget.Global);
		await vscode.workspace.getConfiguration("es4a").update("sdk.path", previousSdk, vscode.ConfigurationTarget.Global);
	});

	async function rename(editor: vscode.TextEditor, name: string, next: string, action: "apply" | "cancel" | "preview" = "apply"): Promise<void> {
		await vscode.window.showTextDocument(editor.document, { preview: false });
		const start = editor.document.getText().indexOf(name + " =");
		const offset = start >= 0 ? start : editor.document.getText().indexOf(name);
		assert.ok(offset >= 0);
		editor.selection = new vscode.Selection(editor.document.positionAt(offset), editor.document.positionAt(offset + name.length));
		// 走 F2 对应的原生命令，输入与提交仍由实际工作台控件完成。
		const operation = vscode.commands.executeCommand("editor.action.rename");
		void operation.then(undefined, () => undefined);
		await driver.fill(".rename-box input", next);
		await driver.key(action === "cancel" ? "Escape" : "Enter", action === "preview");
		await driver.waitFor('!document.querySelector(".rename-box input")?.getClientRects().length');
		if (action === "preview") await driver.waitFor('Boolean(document.querySelector(".bulk-edit-panel .buttons")?.getClientRects().length)');
		else await operation;
	}

	async function clickPreview(apply: boolean): Promise<void> {
		assert.equal(await driver.evaluate(`(() => { const buttons = document.querySelectorAll(".bulk-edit-panel .buttons .monaco-button"); if (buttons.length !== 2) return false; buttons[${apply ? 0 : 1}].click(); return true; })()`), true);
	}

	test("实际 F2 输入取消后立即重试，回车同步引用并支持保存与撤销", async () => {
		await withProject(localCode, async ({ editor, file, source }) => {
			await rename(editor, "旧值", "取消值", "cancel");
			assert.equal(editor.document.getText(), getVisibleSimpleUnitUserCode(source));
			assert.equal(await fs.readFile(file, "utf8"), source);
			await rename(editor, "旧值", "新值");
			const expected = getVisibleSimpleUnitUserCode(source.replace("变量 旧值", "变量 新值").replace("旧值 = 旧值 +", "新值 = 新值 +"));
			await waitFor(() => editor.document.getText() === expected);
			assert.equal(await fs.readFile(file, "utf8"), source);
			await vscode.commands.executeCommand("undo");
			assert.equal(editor.document.getText(), getVisibleSimpleUnitUserCode(source));
			await vscode.commands.executeCommand("redo");
			assert.equal(editor.document.getText(), expected);
			await editor.document.save();
			const saved = await fs.readFile(file, "utf8");
			assert.equal(getVisibleSimpleUnitUserCode(saved), expected);
			assert.equal(splitSimpleUnitSource(saved).propertySource, windowProperty);
		});
	});

	test("实际组件预览点击放弃后再次连续改名，代码、XML 和跨单元引用整体撤销", async () => {
		await withProject(componentCode, async ({ editor, caller, file, callerFile, source, callerSource }) => {
			await rename(editor, "按钮1", "取消按钮", "preview");
			assert.equal(editor.document.getText(), getVisibleSimpleUnitUserCode(source));
			assert.equal(await fs.readFile(file, "utf8"), source);
			await clickPreview(false);
			await driver.waitFor('!document.querySelector(".bulk-edit-panel .buttons")?.getClientRects().length');
			assert.equal(caller.getText(), getVisibleSimpleUnitUserCode(callerSource));
			await rename(editor, "按钮1", "按钮11");
			await waitFor(() => editor.document.getText().includes("事件 按钮11.") && caller.getText().includes("a.按钮11."));
			await rename(editor, "按钮11", "按钮111");
			await waitFor(() => editor.document.getText().includes("事件 按钮111.") && caller.getText().includes("a.按钮111."));
			assert.equal(await fs.readFile(file, "utf8"), componentCode + windowProperty.replaceAll("按钮1", "按钮111"));
			assert.equal(await fs.readFile(callerFile, "utf8"), callerSource);
			await vscode.commands.executeCommand("undo");
			assert.match(editor.document.getText(), /事件 按钮11\./u);
			assert.match(caller.getText(), /a\.按钮11\./u);
			await vscode.commands.executeCommand("undo");
			assert.equal(editor.document.getText(), getVisibleSimpleUnitUserCode(source));
			assert.equal(caller.getText(), getVisibleSimpleUnitUserCode(callerSource));
			assert.equal(await fs.readFile(file, "utf8"), source);
			await vscode.commands.executeCommand("redo");
			await vscode.commands.executeCommand("redo");
			assert.match(editor.document.getText(), /事件 按钮111\./u);
			assert.match(caller.getText(), /a\.按钮111\./u);
		});
	});

	test("原生输入重复组件名失败后立即修正，不写入失败计划", async () => {
		await withProject(componentCode, async ({ editor, caller, file, callerFile, source, callerSource }) => {
			await vscode.commands.executeCommand("notifications.clearAll");
			await rename(editor, "按钮1", "按钮2");
			await driver.waitFor('Boolean(document.querySelector(".notifications-toasts .notification-toast")?.getClientRects().length)');
			assert.equal(editor.document.getText(), getVisibleSimpleUnitUserCode(source));
			assert.equal(caller.getText(), getVisibleSimpleUnitUserCode(callerSource));
			assert.equal(await fs.readFile(file, "utf8"), source);
			assert.equal(await fs.readFile(callerFile, "utf8"), callerSource);
			await vscode.commands.executeCommand("notifications.clearAll");
			await rename(editor, "按钮1", "修正按钮");
			await waitFor(() => caller.getText().includes("a.修正按钮."));
			assert.match(editor.document.getText(), /事件 修正按钮\./u);
			await vscode.commands.executeCommand("undo");
			assert.equal(editor.document.getText(), getVisibleSimpleUnitUserCode(source));
			assert.equal(caller.getText(), getVisibleSimpleUnitUserCode(callerSource));
			assert.equal(await fs.readFile(file, "utf8"), source);
		});
	});

	test("原生参数重命名预览点击应用，只更新对应作用域并可整体撤销", async () => {
		const code = localCode.replace("过程 P()", "过程 P(参数 为 整数型)").replace("旧值 = 旧值 + 1", "旧值 = 参数 + 参数");
		await withProject(code, async ({ editor, file, source }) => {
			await rename(editor, "参数", "新参数", "preview");
			assert.equal(editor.document.getText(), getVisibleSimpleUnitUserCode(source));
			await clickPreview(true);
			await waitFor(() => editor.document.getText().includes("新参数 + 新参数"));
			assert.equal(editor.document.getText(), getVisibleSimpleUnitUserCode(source.replaceAll("参数", "新参数")));
			assert.equal(await fs.readFile(file, "utf8"), source);
			await vscode.commands.executeCommand("undo");
			assert.equal(editor.document.getText(), getVisibleSimpleUnitUserCode(source));
		});
	});

	test("原生预览期间修改关联代码，点击应用拒绝过期编辑并可重新重命名", async () => {
		await withProject(componentCode, async ({ editor, caller, file, callerFile, source, callerSource }) => {
			await rename(editor, "按钮1", "过期按钮", "preview");
			const change = new vscode.WorkspaceEdit();
			change.insert(caller.uri, new vscode.Position(0, 0), "' 预览期间保留\r\n");
			assert.ok(await vscode.workspace.applyEdit(change));
			await clickPreview(true);
			// 扩展测试宿主禁用警告对话框，但原生冲突分支仍须拒绝并结束预览。
			await driver.waitFor('!document.querySelector(".bulk-edit-panel .buttons")?.getClientRects().length');
			assert.equal(editor.document.getText(), getVisibleSimpleUnitUserCode(source));
			assert.equal(caller.getText(), "' 预览期间保留\r\n" + getVisibleSimpleUnitUserCode(callerSource));
			assert.equal(await fs.readFile(file, "utf8"), source);
			assert.equal(await fs.readFile(callerFile, "utf8"), callerSource);
			await rename(editor, "按钮1", "最新按钮");
			await waitFor(() => caller.getText().includes("a.最新按钮."));
			assert.ok(caller.getText().startsWith("' 预览期间保留\r\n"));
			assert.match(editor.document.getText(), /事件 最新按钮\./u);
		});
	});

	test("从跨单元字段引用打开原生输入框，连续改名保留局部同名变量并整体撤销", async () => {
		const code = "变量 字段 为 整数型\r\n过程 P()\r\n\t字段 = 1\r\n结束 过程\r\n";
		const callerCode = "过程 P(a 为 主窗口)\r\n\t变量 字段 为 整数型\r\n\ta.字段 = 字段 + 1\r\n结束 过程\r\n";
		await withProject(code, async ({ editor, caller, file, callerFile, source, callerSource }) => {
			const callerEditor = await vscode.window.showTextDocument(caller, { preview: false });
			for (const [previous, next] of [["字段", "字段1"], ["字段1", "字段11"]] as const) {
				await rename(callerEditor, previous, next);
				await waitFor(() => caller.getText().includes(`a.${next} = 字段 + 1`) && editor.document.getText().includes(`变量 ${next} 为`));
				assert.match(caller.getText(), /变量 字段 为 整数型/u);
			}
			assert.equal(await fs.readFile(file, "utf8"), source);
			assert.equal(await fs.readFile(callerFile, "utf8"), callerSource);
			await vscode.commands.executeCommand("undo");
			assert.match(caller.getText(), /a\.字段1 = 字段 \+ 1/u);
			await vscode.commands.executeCommand("undo");
			assert.equal(editor.document.getText(), getVisibleSimpleUnitUserCode(source));
			assert.equal(caller.getText(), getVisibleSimpleUnitUserCode(callerSource));
		}, callerCode);
	});

	test("开启 VS Code 重构自动保存后，实际多文件 F2 保存代码并保留 XML 与引用一致", async () => {
		const configuration = vscode.workspace.getConfiguration("files");
		await configuration.update("refactoring.autoSave", true, vscode.ConfigurationTarget.Global);
		try {
			await withProject(componentCode, async ({ editor, caller, file, callerFile, source, callerSource }) => {
				await rename(editor, "按钮1", "保存按钮");
				await waitFor(() => editor.document.getText().includes("事件 保存按钮.") && caller.getText().includes("a.保存按钮.") && !editor.document.isDirty && !caller.isDirty);
				const saved = await fs.readFile(file, "utf8");
				assert.equal(getVisibleSimpleUnitUserCode(saved), getVisibleSimpleUnitUserCode(source).replaceAll("按钮1.", "保存按钮."));
				assert.equal(splitSimpleUnitSource(saved).propertySource, windowProperty.replaceAll("按钮1", "保存按钮"));
				assert.equal(await fs.readFile(callerFile, "utf8"), callerSource.replace("a.按钮1.", "a.保存按钮."));
				await rename(editor, "保存按钮", "再次保存按钮");
				await waitFor(() => caller.getText().includes("a.再次保存按钮.") && !editor.document.isDirty && !caller.isDirty);
				assert.equal(getVisibleSimpleUnitUserCode(await fs.readFile(file, "utf8")), editor.document.getText());
				assert.match(await fs.readFile(file, "utf8"), /位于左边 = 再次保存按钮\.标识/u);
			});
		} finally { await configuration.update("refactoring.autoSave", false, vscode.ConfigurationTarget.Global); }
	});

	for (const folder of [false, true]) test(`项目树实际${folder ? "包" : "单元"}重命名输入先取消再提交，文件与引用一起撤销重做并重新打开`, async () => {
		const code = "事件 主窗口.初始化()\r\n结束 事件\r\n";
		const oldName = folder ? "pkg" : "主窗口";
		const newName = folder ? "new" : "新窗口";
		const callerCode = `变量 实例 为 ${folder ? "pkg." : ""}主窗口\r\n`;
		await withProject(code, async ({ editor, caller, file, callerFile, source, callerSource, projectFile }) => {
			const project = await loadSimpleProject(projectFile);
			const node = folder ? { kind: "directory", mode: "units", label: "pkg", directoryPath: path.dirname(file), project }
				: { kind: "unit", label: "主窗口", filePath: file, project };
			const command = folder ? "es4a.renameUnitFolder" : "es4a.renameUnitFile";
			const next = folder ? path.join(path.dirname(path.dirname(file)), "new/主窗口.simple") : path.join(path.dirname(file), "新窗口.simple");
			const beforeMain = await fs.readFile(projectFile, "utf8");
			const cancelled = vscode.commands.executeCommand(command, node);
			await driver.fill(".quick-input-widget input", "取消窗口");
			await driver.key("Escape");
			await cancelled;
			assert.equal(await fs.readFile(file, "utf8"), source);
			assert.equal(await fs.readFile(projectFile, "utf8"), beforeMain);
			const renamed = vscode.commands.executeCommand(command, node);
			await driver.fill(".quick-input-widget input", newName);
			await driver.key("Enter");
			await renamed;
			assert.equal(await fs.stat(file).then(() => true, () => false), false);
			const changed = folder ? source : source.replace("事件 主窗口.", "事件 新窗口.").replace("$定义 主窗口 $为", "$定义 新窗口 $为");
			assert.equal(await fs.readFile(next, "utf8"), changed);
			assert.equal(await fs.readFile(callerFile, "utf8"), callerSource);
			assert.equal(await fs.readFile(projectFile, "utf8"), beforeMain);
			assert.equal(caller.getText(), getVisibleSimpleUnitUserCode(callerSource.replace(oldName, newName)));
			assert.equal(caller.isDirty, true);
			const properties = await vscode.workspace.openTextDocument(vscode.Uri.file(projectFile));
			assert.equal(properties.getText(), beforeMain.replace(oldName, newName));
			assert.equal(properties.isDirty, true);
			await vscode.window.showTextDocument(caller, { preview: false });
			await vscode.commands.executeCommand("undo");
			assert.ok(await fs.stat(file));
			assert.equal(caller.getText(), getVisibleSimpleUnitUserCode(callerSource));
			const main = await vscode.workspace.openTextDocument(vscode.Uri.file(projectFile));
			assert.equal(main.getText(), beforeMain);
			await waitFor(async () => vscode.workspace.fs.stat(toSimpleCodeUri(vscode.Uri.file(file))).then(() => true, () => false));
			await waitFor(() => vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => {
				const binding = resolveSimpleUnitTab(tab);
				return binding?.kind === "code" && sameFilePath(binding.sourceUri.fsPath, file);
			})) && vscode.window.activeTextEditor?.document === caller);
			const restored = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(file)));
			await waitFor(() => restored.getText() === getVisibleSimpleUnitUserCode(source));
			assert.equal(restored.getText(), getVisibleSimpleUnitUserCode(source));
			const restoredXml = await vscode.workspace.openTextDocument(toUnitXmlPreviewUri(vscode.Uri.file(file)));
			assert.match(restoredXml.getText(), /名称="主窗口"/u);
			assert.ok(editor.document.isClosed || editor.document.uri.toString() === restored.uri.toString());
			await vscode.window.showTextDocument(caller, { preview: false });
			await vscode.commands.executeCommand("redo");
			await waitFor(async () => vscode.workspace.fs.stat(toSimpleCodeUri(vscode.Uri.file(next))).then(() => true, () => false));
			const redone = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(next)));
			assert.equal(redone.getText(), getVisibleSimpleUnitUserCode(changed));
			const redoneXml = await vscode.workspace.openTextDocument(toUnitXmlPreviewUri(vscode.Uri.file(next)));
			assert.ok(redoneXml.getText().includes(`名称="${folder ? "主窗口" : "新窗口"}"`));
			assert.equal(caller.getText(), getVisibleSimpleUnitUserCode(callerSource.replace(oldName, newName)));
			assert.equal(main.getText(), beforeMain.replace(oldName, newName));
			await caller.save();
			await main.save();
			assert.equal(await fs.readFile(callerFile, "utf8"), callerSource.replace(oldName, newName));
			assert.equal(await fs.readFile(projectFile, "utf8"), beforeMain.replace(oldName, newName));
		}, callerCode, folder);
	});
});
