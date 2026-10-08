/*
在 VS Code 扩展宿主中验证 Windows SDK 能力任务使用系统命令解释器并能实际启动。
xhwsd@qq.com 2026-9-11
*/

import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { createSdkCapabilityExecution } from "../../sdkCapabilityCommands";

suite("SDK 能力任务 shell", () => {
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
