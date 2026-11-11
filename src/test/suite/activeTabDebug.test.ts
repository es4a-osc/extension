/*
验证 F5 按当前活动单元标签执行 SDK 调试能力，覆盖临时标签、固定标签和普通文件。
xhwsd@qq.com 2026-10-13
*/

import { testExtensionId, testSdkPath } from "../testFixtures";

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { resolveActiveTabUnitSourceUri } from "../../main";
import { toSimpleCodeUri, toSimpleDesignerUri } from "../../simpleCodeFileSystem";
import { filePathKey } from "../../simpleProjectPaths";
import { loadSimpleProject } from "../../programResources";
import type { ProjectProcessResult } from "../../sdkProjectTerminal";
import { toUnitContentPreviewUri, toUnitXmlPreviewUri } from "../../unitPreview";
import { WorkbenchDriver } from "./workbenchDriver";

suite("活动标签 F5", () => {
	test("F5 从临时、固定、普通文件及设计器标签调试当前项目", async function () {
		this.timeout(45000);
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-active-tab-debug-"));
		const projectFile = path.join(directory, "project.properties");
		const sourceUri = vscode.Uri.file(path.join(directory, "src", "主窗口.simple"));
		const sdkDirectory = path.join(directory, "sdk");
		const configuration = vscode.workspace.getConfiguration("es4a");
		const previousSdk = configuration.inspect<string>("sdk.path")?.globalValue;
		const previousSerial = configuration.inspect<string>("device.serial")?.globalValue;
		let expectedSerial = "emulator-5560";
		let completed = 0;
		let driver: WorkbenchDriver | undefined;
		const source = "事件 主窗口.初始化()\r\n结束 事件\r\n$属性\r\n$资源 $窗口\r\n$定义 主窗口 $为 窗口\r\n$结束 $定义\r\n$结束 $属性\r\n";
		try {
			await fs.mkdir(path.dirname(sourceUri.fsPath), { recursive: true });
			await fs.writeFile(sourceUri.fsPath, source);
			await fs.writeFile(projectFile, "main=主窗口\r\nsource=./src\r\nname=当前标签调试\r\n");
			await fs.mkdir(path.join(sdkDirectory, "utils", "project"), { recursive: true });
			await fs.cp(testSdkPath("simple"), path.join(sdkDirectory, "simple"), { recursive: true });
			await fs.writeFile(path.join(sdkDirectory, "utils", "project", "project.ps1"), [
				"[CmdletBinding()]",
				"param($Action, $ProjectFile)",
				"$output = Join-Path (Split-Path -Parent $ProjectFile) 'invocation.json'",
				"$count = if (Test-Path -LiteralPath $output) { (Get-Content -LiteralPath $output -Raw | ConvertFrom-Json).count } else { 0 }",
				"$invocation = @{ action = $Action; project = $ProjectFile; count = $count + 1; serial = [string]$env:ANDROID_SERIAL } | ConvertTo-Json -Compress",
				"[IO.File]::WriteAllText($output, $invocation)",
				"exit 0",
				""
			].join("\r\n"));
			await configuration.update("sdk.path", sdkDirectory, vscode.ConfigurationTarget.Global);
			await configuration.update("device.serial", expectedSerial, vscode.ConfigurationTarget.Global);
			await vscode.extensions.getExtension(testExtensionId())!.activate();
			await vscode.commands.executeCommand("es4a.refreshLibraries");
			await vscode.commands.executeCommand("es4a.internal.addProject", projectFile);
			driver = await WorkbenchDriver.connect();
			const pressF5 = async (): Promise<void> => {
				await driver!.key("F5");
				let count = completed;
				for (let attempt = 0; attempt < 250 && count === completed; attempt += 1) {
					try { count = JSON.parse(await fs.readFile(path.join(directory, "invocation.json"), "utf8")).count; }
					catch { /* 首次执行或文件写入期间继续等待。 */ }
					if (count === completed) {
						await new Promise((resolve) => setTimeout(resolve, 20));
					}
				}
				assert.equal(count, completed + 1, "F5 应进入 ES4A 当前标签调试命令");
				completed = count;
				// 真实进程只传项目文件；脚本自行定位产物，不接受外部 APK 路径。
				const invocation = JSON.parse(await fs.readFile(path.join(directory, "invocation.json"), "utf8"));
				assert.deepEqual({ ...invocation, project: filePathKey(invocation.project) }, {
					action: "debug",
					project: filePathKey(projectFile),
					serial: expectedSerial,
					count
				});
			};
			for (const preview of [true, false]) {
				await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(toSimpleCodeUri(sourceUri)), { preview });
				assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview, preview);
				// 单击预览后焦点仍可留在侧边栏；F5 仍应只使用活动标签，不使用树选择。
				await vscode.commands.executeCommand("es4a.programs.focus");
				await pressF5();
				assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview, preview, "F5 不应固定临时标签");
			}
			expectedSerial = process.env.ANDROID_SERIAL ?? "";
			await configuration.update("device.serial", "", vscode.ConfigurationTarget.Global);
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
			const count = completed;
			await vscode.commands.executeCommand("setContext", "debugState", "stopped");
			try {
				await driver.key("F5");
				await new Promise((resolve) => setTimeout(resolve, 1000));
				assert.equal(JSON.parse(await fs.readFile(path.join(directory, "invocation.json"), "utf8")).count, count);
			} finally {
				await vscode.commands.executeCommand("setContext", "debugState", "inactive");
			}
			const otherUri = vscode.Uri.file(path.join(directory, "其他.java"));
			await fs.writeFile(otherUri.fsPath, "// F5 兼容性检查\r\n");
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(otherUri), { preview: true });
			assert.equal(resolveActiveTabUnitSourceUri(vscode.window.tabGroups.activeTabGroup.activeTab), undefined, "其它文件不能沿用之前的 Simple 标签");
			assert.equal(await fs.readFile(sourceUri.fsPath, "utf8"), source);

			// 正式命令进入同一构建目录时，即使同时提交也要等前一个进程完全结束。
			await fs.writeFile(path.join(sdkDirectory, "utils", "project", "project.ps1"), [
				"param($Action, $ProjectFile)",
				"$trace = Join-Path (Split-Path -Parent $ProjectFile) 'build-order.txt'",
				"[IO.File]::AppendAllText($trace, \"$Action-start`n\")",
				"Start-Sleep -Milliseconds 500",
				"[IO.File]::AppendAllText($trace, \"$Action-end`n\")",
				"exit 0", ""
			].join("\r\n"));
			const projectNode = { kind: "project", project: await loadSimpleProject(projectFile) };
			const builds = await Promise.all([
				vscode.commands.executeCommand<ProjectProcessResult>("es4a.compileApplication", projectNode),
				vscode.commands.executeCommand<ProjectProcessResult>("es4a.debugApplication", projectNode)
			]);
			assert.deepEqual(builds.map((result) => result?.exitCode), [0, 0]);
			const order = (await fs.readFile(path.join(directory, "build-order.txt"), "utf8")).trim();
			assert.match(order, /^(?:compile-start\ncompile-end\ndebug-start\ndebug-end|debug-start\ndebug-end\ncompile-start\ncompile-end)$/u);
		} finally {
			await driver?.key("Escape");
			driver?.dispose();
			for (const terminal of vscode.window.terminals) {
				if (/^(?:编译|调试)应用：当前标签调试/u.test(terminal.name)) {
					terminal.dispose();
				}
			}
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			await configuration.update("sdk.path", previousSdk, vscode.ConfigurationTarget.Global);
			await configuration.update("device.serial", previousSerial, vscode.ConfigurationTarget.Global);
			await vscode.commands.executeCommand("es4a.refreshLibraries");
			assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});
});
