/*
验证 Windows 文件夹静默回收的实际内容保留，以及占用失败时不删除原目录。
xhwsd@qq.com 2026-10-9
*/

import * as assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { recycleWindowsFolder } from "../windowsRecycleBin";

const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const run = promisify(execFile);
const verificationDirectory = path.join(os.tmpdir(), "es4a-recycle-folder-verification");

test("回收助手拒绝永久删除分支，并允许回收分支", { skip: process.platform !== "win32" }, async () => {
	const script = path.resolve(__dirname, "../../scripts/recycleFolder.ps1");
	const command = "$ErrorActionPreference = 'Stop'; $p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" +
		Buffer.from(script).toString("base64") + "')); " +
		"$source = [IO.File]::ReadAllText($p); $body = [regex]::Match($source, '(?s)Add-Type -TypeDefinition @''\\r?\\n(.*?)\\r?\\n''@').Groups[1].Value; " +
		"Add-Type -TypeDefinition $body; $sink = [ES4A.RecycleOnlySink]::new(); " +
		"if ($sink.PreDeleteItem(0, [IntPtr]::Zero) -ge 0) { exit 1 }; " +
		"if ($sink.PreDeleteItem(128, [IntPtr]::Zero) -ne 0) { exit 2 }";
	await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true });
});

test("Windows 静默回收保留子目录和内容，特殊字符路径不会作为命令执行", { skip: process.platform !== "win32" }, async () => {
	await fs.mkdir(verificationDirectory, { recursive: true });
	const parent = await fs.mkdtemp(path.join(verificationDirectory, "recycle-"));
	const folder = path.join(parent, "演示 [a] ' $folder`");
	const content = Buffer.from("原内容\r\n\u0000", "utf8");
	try {
		await fs.mkdir(path.join(folder, "nested"), { recursive: true });
		await fs.writeFile(path.join(folder, "nested", "内容.txt"), content);
		await recycleWindowsFolder(folder);
		assert.equal(await fs.stat(folder).then(() => true, () => false), false);
		// 读取 Shell 的回收站项，确认删除没有退化为永久删除；不清空用户回收站。
		const command = "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); " +
			"$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + Buffer.from(folder).toString("base64") + "')); " +
			"$shell = New-Object -ComObject Shell.Application; " +
			"ConvertTo-Json -Compress -InputObject @($shell.Namespace(10).Items() | Where-Object { " +
			"[IO.Path]::Combine($_.ExtendedProperty('System.Recycle.DeletedFrom'), $_.Name) -eq $target " +
			"} | ForEach-Object { $_.Path })";
		const { stdout } = await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true });
		const entries: unknown = JSON.parse(stdout);
		assert.ok(Array.isArray(entries) && entries.length === 1);
		const recycledPath: unknown = entries[0];
		assert.equal(typeof recycledPath, "string");
		assert.deepEqual(await fs.readFile(path.join(recycledPath as string, "nested", "内容.txt")), content);
	} finally {
		// 仅清理本测试创建的原父目录；已经回收的项保留在回收站供检查。
		await fs.rm(parent, { recursive: true, force: true });
	}
});

test("目录被占用时静默回收报错，原目录与内容保留", { skip: process.platform !== "win32" }, async () => {
	await fs.mkdir(verificationDirectory, { recursive: true });
	const folder = await fs.mkdtemp(path.join(verificationDirectory, "locked-"));
	await fs.writeFile(path.join(folder, "保留.txt"), "保留内容\r\n");
	// 目录句柄不共享 DELETE，模拟阻止回收的文件占用；只锁本测试创建的目录。
	const command = "$ErrorActionPreference = 'Stop'; Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class LockFolder { " +
		"[DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode)] public static extern IntPtr CreateFile(string p, uint a, uint s, IntPtr x, uint c, uint f, IntPtr t); " +
		"[DllImport(\"kernel32.dll\")] public static extern bool CloseHandle(IntPtr h); }'; " +
		"$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + Buffer.from(folder).toString("base64") + "')); " +
		"$h = [LockFolder]::CreateFile($p, 2147483648, 3, [IntPtr]::Zero, 3, 0x02000000, [IntPtr]::Zero); " +
		"if ($h.ToInt64() -eq -1) { exit 1 }; [Console]::WriteLine('ready'); " +
		"Start-Sleep -Seconds 60; [LockFolder]::CloseHandle($h) | Out-Null";
	const holder = spawn(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true });
	const closed = once(holder, "close");
	try {
		await new Promise<void>((resolve, reject) => {
			holder.once("error", reject);
			holder.once("exit", () => reject(new Error("测试目录占用进程未就绪。")));
			holder.stdout.once("data", (chunk: Buffer) => {
				if (chunk.toString().includes("ready")) resolve();
				else reject(new Error("测试目录占用进程输出异常。"));
			});
		});
		await assert.rejects(recycleWindowsFolder(folder), /无法移至回收站/);
		assert.equal(await fs.readFile(path.join(folder, "保留.txt"), "utf8"), "保留内容\r\n");
	} finally {
		holder.kill();
		await closed;
		await fs.rm(folder, { recursive: true, force: true });
	}
});
