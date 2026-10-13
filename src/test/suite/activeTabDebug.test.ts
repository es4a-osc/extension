/*
验证 F5 按当前活动单元标签执行 SDK 调试能力，覆盖临时标签、固定标签和普通文件。
xhwsd@qq.com 2026-10-13
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { resolveActiveTabUnitSourceUri } from "../../main";
import { toSimpleCodeUri, toSimpleDesignerUri } from "../../simpleCodeFileSystem";
import { toUnitContentPreviewUri, toUnitXmlPreviewUri } from "../../unitPreview";
import { WorkbenchDriver } from "./workbenchDriver";

suite("活动标签 F5", () => {
	test("F5 从临时、固定、普通文件及设计器标签调试当前项目", async function () {
		this.timeout(45000);
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-active-tab-debug-"));
		const projectFile = path.join(directory, "project.properties");
		const sourceUri = vscode.Uri.file(path.join(directory, "src", "主窗口.simple"));
		const sdkFile = path.join(directory, "sdk.json");
		const configuration = vscode.workspace.getConfiguration("es4a");
		const previousSdk = configuration.inspect<string>("sdk.path")?.globalValue;
		const completed: vscode.TaskProcessEndEvent[] = [];
		const subscription = vscode.tasks.onDidEndTaskProcess((event) => {
			if (event.execution.task.definition.type === "es4a-project-capability"
				&& event.execution.task.definition.project === projectFile) completed.push(event);
		});
		let driver: WorkbenchDriver | undefined;
		const source = "事件 主窗口.初始化()\r\n结束 事件\r\n$属性\r\n$资源 $窗口\r\n$定义 主窗口 $为 窗口\r\n$结束 $定义\r\n$结束 $属性\r\n";
		try {
			await fs.mkdir(path.dirname(sourceUri.fsPath), { recursive: true });
			await fs.writeFile(sourceUri.fsPath, source);
			await fs.writeFile(projectFile, "main=主窗口\r\nsource=./src\r\nname=当前标签调试\r\n");
			await fs.writeFile(path.join(directory, "debug.bat"), "@echo off\r\nexit /b 0\r\n");
			await fs.writeFile(sdkFile, JSON.stringify({
				name: "F5 测试 SDK",
				compiler: path.resolve(__dirname, "../../../../sdk/simple/SimpleCompiler.json"),
				runtime: path.resolve(__dirname, "../../../../sdk/simple/SimpleAndroidRuntime.json"),
				capabilities: { debug: { command: "debug.bat", arguments: ["PROJECT_FILE"] } }
			}));
			await configuration.update("sdk.path", sdkFile, vscode.ConfigurationTarget.Global);
			await vscode.extensions.getExtension("es4a.es4a")!.activate();
			await vscode.commands.executeCommand("es4a.refreshLibraries");
			await vscode.commands.executeCommand("es4a.internal.addProject", projectFile);
			driver = await WorkbenchDriver.connect();
			const pressF5 = async (): Promise<void> => {
				const count = completed.length;
				await driver!.key("F5");
				for (let attempt = 0; attempt < 250 && completed.length === count; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
				assert.equal(completed.length, count + 1, "F5 应进入 ES4A 当前标签调试命令");
				assert.equal(completed[count]!.exitCode, 0);
				assert.equal(completed[count]!.execution.task.definition.capability, "debug");
			};
			for (const preview of [true, false]) {
				await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(toSimpleCodeUri(sourceUri)), { preview });
				assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview, preview);
				// 单击预览后焦点仍可留在侧边栏；F5 仍应只使用活动标签，不使用树选择。
				await vscode.commands.executeCommand("es4a.programs.focus");
				await pressF5();
				assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview, preview, "F5 不应固定临时标签");
			}
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(sourceUri), { preview: true });
			assert.equal(vscode.window.activeTextEditor?.document.uri.scheme, "file");
			await vscode.commands.executeCommand("es4a.programs.focus");
			await pressF5();
			for (const uri of [toUnitContentPreviewUri(sourceUri), toUnitXmlPreviewUri(sourceUri)]) {
				await vscode.commands.executeCommand("vscode.open", uri, { preview: true });
				await vscode.commands.executeCommand("es4a.programs.focus");
				await pressF5();
			}
			await vscode.commands.executeCommand("vscode.openWith", toSimpleDesignerUri(sourceUri), "es4a.simpleDesigner", { preview: false });
			await vscode.commands.executeCommand("es4a.programs.focus");
			await pressF5();
			assert.equal(resolveActiveTabUnitSourceUri(vscode.window.tabGroups.activeTabGroup.activeTab)?.fsPath, sourceUri.fsPath);
			// 模拟原生调试的暂停上下文，F5 不能再次启动 SDK 任务。
			const count = completed.length;
			await vscode.commands.executeCommand("setContext", "debugState", "stopped");
			try {
				await driver.key("F5");
				await new Promise((resolve) => setTimeout(resolve, 1000));
				assert.equal(completed.length, count);
			} finally {
				await vscode.commands.executeCommand("setContext", "debugState", "inactive");
			}
			const otherUri = vscode.Uri.file(path.join(directory, "其他.java"));
			await fs.writeFile(otherUri.fsPath, "// F5 兼容性检查\r\n");
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(otherUri), { preview: true });
			assert.equal(resolveActiveTabUnitSourceUri(vscode.window.tabGroups.activeTabGroup.activeTab), undefined, "其它文件不能沿用之前的 Simple 标签");
			assert.equal(await fs.readFile(sourceUri.fsPath, "utf8"), source);
		} finally {
			await driver?.key("Escape");
			driver?.dispose();
			subscription.dispose();
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			await configuration.update("sdk.path", previousSdk, vscode.ConfigurationTarget.Global);
			await vscode.commands.executeCommand("es4a.refreshLibraries");
			assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});
});
