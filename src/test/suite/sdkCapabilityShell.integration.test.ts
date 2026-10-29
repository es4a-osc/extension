/*
在 VS Code 扩展宿主中验证 Windows SDK 能力任务使用系统命令解释器并能实际启动。
xhwsd@qq.com 2026-9-11
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { createSdkCapabilityExecution } from "../../sdkCapabilityCommands";

suite("SDK 能力任务 shell", () => {
	test("PS1 任务保留中文空格参数并向任务系统传递失败退出码", async function () {
		if (process.platform !== "win32") {
			this.skip();
			return;
		}
		this.timeout(30_000);
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a 项目入口 "));
		try {
			const script = path.join(directory, "项目工具.ps1");
			const output = path.join(directory, "接收 参数.txt");
			await fs.writeFile(script, '\ufeffparam($Command, $ProjectFile, $OutputFile)\r\n[IO.File]::WriteAllText($OutputFile, "$Command|$ProjectFile")\r\nexit 7\r\n', "utf8");
			const taskName = "ES4A PS1 smoke " + Date.now();
			const execution = createSdkCapabilityExecution(script, ["compile", "E:\\中文 空格\\项目 & 测试.properties", output]);
			assert.ok(execution instanceof vscode.ProcessExecution);
			const task = new vscode.Task({ type: "es4a-ps1-smoke" }, vscode.TaskScope.Global, taskName, "ES4A Test", execution, []);
			const exitCode = new Promise<number | undefined>((resolve, reject) => {
				const timer = setTimeout(() => {
					disposable.dispose();
					reject(new Error("等待 PowerShell 项目能力退出超时。"));
				}, 15_000);
				const disposable = vscode.tasks.onDidEndTaskProcess((event) => {
					if (event.execution.task.name !== taskName) return;
					clearTimeout(timer);
					disposable.dispose();
					resolve(event.exitCode);
				});
			});
			await vscode.tasks.executeTask(task);
			assert.equal(await exitCode, 7);
			assert.equal(await fs.readFile(output, "utf8"), "compile|E:\\中文 空格\\项目 & 测试.properties");
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
	test("Windows SDK 能力任务不依赖用户默认终端", async function () {
		if (process.platform !== "win32") {
			this.skip();
			return;
		}

		const taskName = "ES4A shell smoke " + Date.now();
		const execution = createSdkCapabilityExecution("echo", ["ES4A shell ready"]);
		assert.ok(execution instanceof vscode.ProcessExecution);
		assert.equal(execution.process, process.env.ComSpec?.trim() || "cmd.exe");
		assert.deepEqual(execution.args, ["/d", "/s", "/c", "echo", "ES4A shell ready"]);

		const task = new vscode.Task(
			{ type: "es4a-shell-smoke" },
			vscode.TaskScope.Global,
			taskName,
			"ES4A Test",
			execution,
			[]
		);
		const exitCode = new Promise<number | undefined>((resolve, reject) => {
			const timeout = setTimeout(() => {
				disposable.dispose();
				reject(new Error("等待 SDK 能力任务退出超时。"));
			}, 10_000);
			const disposable = vscode.tasks.onDidEndTaskProcess((event) => {
				if (event.execution.task.name !== taskName) return;
				clearTimeout(timeout);
				disposable.dispose();
				resolve(event.exitCode);
			});
		});

		await vscode.tasks.executeTask(task);
		assert.equal(await exitCode, 0);
	});
});
