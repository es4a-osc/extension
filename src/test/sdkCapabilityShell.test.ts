/*
验证 SDK 能力任务不会在 Windows 上继承用户配置的错误终端 shell。
xhwsd@qq.com 2026-9-11
*/

import * as assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { createWindowsSdkCapabilityShell } from "../sdkCapabilityShell";

test("Windows SDK 能力明确使用系统命令解释器", () => {
	assert.deepEqual(
		createWindowsSdkCapabilityShell("win32", "C:\\Windows\\System32\\cmd.exe"),
		{
			args: ["/d", "/s", "/c"],
			executable: "C:\\Windows\\System32\\cmd.exe",
		}
	);
});

test("Windows 缺少 ComSpec 时回退到 cmd.exe", () => {
	assert.deepEqual(createWindowsSdkCapabilityShell("win32", "  "), {
		args: ["/d", "/s", "/c"],
		executable: "cmd.exe"
	});
});

test("非 Windows 平台保留 VS Code 默认 shell", () => {
	assert.equal(createWindowsSdkCapabilityShell("linux", "/bin/bash"), undefined);
});

test("PS1 能力使用系统 PowerShell 执行文件，不依赖文件关联", () => {
	assert.deepEqual(createWindowsSdkCapabilityShell("win32", "cmd.exe", "E:\\中文 空格\\project.PS1"), {
		executable: path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
		args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]
	});
});
