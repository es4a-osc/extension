/*
验证项目终端保留实际退出码、中文日志与取消能力，并且不产生任务退出提示。
xhwsd@qq.com 2026-11-2
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { SdkProjectTerminal, SdkProjectTerminals } from "../../sdkProjectTerminal";
import { WorkbenchDriver } from "./workbenchDriver";

/** 有界等待脚本或工作台可观察状态。 */
async function waitFor(check: () => Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 250; attempt += 1) {
		if (await check()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("等待项目终端状态超时。");
}

suite("项目工具终端", () => {
	test("每次运行独立传递目标设备，不改变宿主环境或泄漏到复用终端", async function () {
		if (process.platform !== "win32") {
			return this.skip();
		}
		this.timeout(15_000);
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-project-device-"));
		const session = new SdkProjectTerminal();
		const previous = process.env.ANDROID_SERIAL;
		const previousHome = process.env.SystemRoot;
		let text = "";
		const subscription = session.onDidWrite((data) => { text += data; });
		try {
			const script = path.join(directory, "device.ps1");
			await fs.writeFile(script, '[Console]::WriteLine("DEVICE=$env:ANDROID_SERIAL|SYSTEM=$env:SystemRoot")\r\nexit 0\r\n');
			const completion = session.run(script, [], "调试应用：指定设备", { ANDROID_SERIAL: "emulator-5560" });
			session.open();
			assert.equal((await completion).exitCode, 0);
			assert.ok(text.includes(`DEVICE=emulator-5560|SYSTEM=${previousHome ?? ""}`));
			assert.equal(process.env.ANDROID_SERIAL, previous);

			text = "";
			assert.equal((await session.run(script, [], "编译应用：继承环境")).exitCode, 0);
			assert.ok(text.includes(`DEVICE=${previous ?? ""}|SYSTEM=${previousHome ?? ""}`));
			assert.equal(process.env.ANDROID_SERIAL, previous);
		} finally {
			subscription.dispose();
			session.dispose();
			assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test("设置界面可搜索目标设备", async function () {
		this.timeout(15_000);
		const driver = await WorkbenchDriver.connect();
		try {
			await vscode.commands.executeCommand("workbench.action.openSettings", "@id:es4a.device.serial");
			await driver.waitFor("document.body.innerText.includes('调试安装和启动使用的目标设备序列号')");
		} finally {
			driver.dispose();
			await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
		}
	});

	test("保留中文与特殊字符参数、错误流和失败退出码，结束后能够再次运行", async function () {
		if (process.platform !== "win32") {
			return this.skip();
		}
		this.timeout(20_000);
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a 中文终端 "));
		const session = new SdkProjectTerminal();
		let text = "";
		const subscription = session.onDidWrite((data) => { text += data; });
		try {
			const script = path.join(directory, "项目 工具.ps1");
			await fs.writeFile(script, '\ufeffparam($Action, $Project)\r\n[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\r\n[Console]::Write("$Action|$Project`n中文日志😀`r")\r\nStart-Sleep -Milliseconds 100\r\n[Console]::Write("`n")\r\n[Console]::Error.WriteLine("安装应用失败：模拟错误")\r\nexit 7\r\n');
			const args = ["compile", "E:\\中文 空格\\项目 & '测试'.properties"];
			const completion = session.run(script, args, "编译应用：测试");
			assert.equal(text, "", "打开终端前不能启动或丢失输出");
			session.open();
			const result = await completion;
			assert.equal(result.exitCode, 7);
			assert.equal(result.cancelled, false);
			assert.equal(session.running, false);
			assert.ok(text.includes(args.join("|") + "\r\n"));
			assert.ok(text.includes("中文日志😀\r\n"));
			assert.ok(text.includes("安装应用失败：模拟错误\r\n"));
			assert.ok(!text.includes("\r\r\n"));
			await fs.writeFile(script, '\ufeff[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\r\n[Console]::WriteLine("构建完成")\r\nexit 0\r\n');
			assert.equal((await session.run(script, [], "调试应用：测试")).exitCode, 0);
			assert.ok(text.includes("构建完成\r\n"));
		} finally {
			subscription.dispose();
			session.dispose();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test("Ctrl+C 和关闭终端均停止脚本及其子进程", async function () {
		if (process.platform !== "win32") {
			return this.skip();
		}
		this.timeout(30_000);
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-cancel-project-"));
		try {
			const script = path.join(directory, "parent.ps1");
			const childScript = path.join(directory, "child.ps1");
			await fs.writeFile(childScript, 'param($Ready)\r\n[IO.File]::WriteAllText($Ready, [string]$PID)\r\nStart-Sleep -Seconds 60\r\n');
			await fs.writeFile(script, 'param($Child, $Ready)\r\n& (Join-Path $PSHOME powershell.exe) -NoProfile -File $Child $Ready\r\n');
			for (const close of [false, true]) {
				const ready = path.join(directory, close ? "close.pid" : "cancel.pid");
				const session = new SdkProjectTerminal();
				const completion = session.run(script, [childScript, ready], "调试应用：取消测试");
				session.open();
				try {
					await waitFor(async () => fs.access(ready).then(() => true, () => false));
					const childPid = Number(await fs.readFile(ready, "utf8"));
					assert.ok(childPid > 0);
					if (close) {
						session.close();
					} else {
						session.handleInput("\x03");
					}
					const result = await completion;
					assert.equal(result.cancelled, true);
					assert.notEqual(result.exitCode, 0);
					await waitFor(async () => {
						try { process.kill(childPid, 0); return false; }
						catch { return true; }
					});
				} finally { session.dispose(); }
			}
		} finally { await fs.rm(directory, { recursive: true, force: true }); }
	});

	test("启动失败返回真实错误，打开前关闭不会启动进程", async function () {
		this.timeout(10_000);
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-project-start-error-"));
		try {
			const session = new SdkProjectTerminal();
			const completion = session.run(path.join(directory, "missing-tool.ps1"), [], "编译应用：启动失败");
			session.open();
			try {
				const result = await completion;
				assert.notEqual(result.exitCode, 0);
				assert.ok(result.error !== undefined || result.exitCode !== null);
			} finally { session.dispose(); }
			const unopened = new SdkProjectTerminal();
			const cancelled = unopened.run("not-started", [], "编译应用：未启动");
			unopened.close();
			assert.equal((await cancelled).cancelled, true);
			assert.equal((await cancelled).exitCode, null);
		} finally { await fs.rm(directory, { recursive: true, force: true }); }
	});

	test("真实终端保留失败日志并复用，编译和调试均不追加退出提示", async function () {
		if (process.platform !== "win32") {
			return this.skip();
		}
		this.timeout(30_000);
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-project-terminal-ui-"));
		const manager = new SdkProjectTerminals();
		let driver: WorkbenchDriver | undefined;
		try {
			driver = await WorkbenchDriver.connect();
			const script = path.join(directory, "project.ps1");
			await fs.writeFile(script, '\ufeffparam($Action)\r\n[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\r\n[Console]::WriteLine("${Action}安装应用失败：模拟失败")\r\nexit 7\r\n');
			let first: vscode.Terminal | undefined;
			for (const action of ["compile", "debug"]) {
				const name = `${action}：ES4A 项目终端验证`;
				const result = await manager.run(script, [action], name);
				assert.equal(result.exitCode, 7);
				await waitFor(async () => vscode.window.terminals.some((terminal) => terminal.name === `${name}（失败）`));
				const terminal = vscode.window.terminals.find((item) => item.name === `${name}（失败）`)!;
				if (first === undefined) {
					first = terminal;
				} else {
					assert.equal(terminal, first, "编译和调试应复用空闲终端");
				}
				assert.equal(terminal.exitStatus, undefined, "日志终端应保持打开");
				terminal.show();
				const expression = `(() => {
					const wrappers = [...document.querySelectorAll('.terminal-wrapper')];
					return wrappers.filter(item => item.getClientRects().length && item.xterm).map(item => {
						const buffer = item.xterm.buffer.active;
						return Array.from({length: buffer.length}, (_, i) => buffer.getLine(i)?.translateToString(true) ?? '').join('\\n');
					}).join('\\n');
				})()`;
				await driver.waitFor(`${expression}.includes(${JSON.stringify(action + "安装应用失败：模拟失败")})`);
				const visible: string = String(await driver.evaluate(expression));
				assert.ok(!visible.includes("终端进程") && !visible.includes("terminated with exit code"));
				assert.ok(!visible.includes(script), "不应显示进程命令行");
			}
		} finally {
			driver?.dispose();
			manager.dispose();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
