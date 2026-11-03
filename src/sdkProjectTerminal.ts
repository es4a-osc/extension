/*
在可复用终端中运行项目工具，独立保留进程结果，不触发任务终端的退出提示。
xhwsd@qq.com 2026-11-2
*/

import { spawn, type ChildProcess } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { createWindowsSdkCapabilityShell } from "./sdkCapabilityShell";

/** 项目工具的实际执行结果；取消和启动失败不视为成功。 */
export interface ProjectProcessResult {
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly cancelled: boolean;
	readonly error?: Error;
}

interface ProjectRun {
	readonly command: string;
	readonly args: readonly string[];
	readonly name: string;
	readonly environment?: Readonly<NodeJS.ProcessEnv>;
	readonly resolve: (result: ProjectProcessResult) => void;
	child?: ChildProcess;
	cancelled: boolean;
}

/** 每个流分别处理 UTF-8 解码及跨数据块的 CRLF，避免中文乱码和重复回车。 */
function terminalWriter(write: (data: string) => void): (data: string) => void {
	let previousCR = false;
	return (data) => {
		const prefix = previousCR ? "\r" : "";
		previousCR = data.endsWith("\r");
		write((prefix + data).replace(/\r?\n/gu, "\r\n").slice(prefix.length));
	};
}

/** 终端只负责显示，子进程结束后保持打开，真实结果通过运行 Promise 返回。 */
export class SdkProjectTerminal implements vscode.Pseudoterminal, vscode.Disposable {
	private readonly writeEmitter = new vscode.EventEmitter<string>();
	private readonly nameEmitter = new vscode.EventEmitter<string>();
	readonly onDidWrite = this.writeEmitter.event;
	readonly onDidChangeName = this.nameEmitter.event;
	private opened = false;
	private disposed = false;
	private current: ProjectRun | undefined;

	get running(): boolean { return this.current !== undefined; }

	/** 准备执行；终端尚未打开时，等待 open 后再启动，避免丢失首批输出。 */
	run(command: string, args: readonly string[], name: string, environment?: Readonly<NodeJS.ProcessEnv>): Promise<ProjectProcessResult> {
		if (this.disposed) {
			throw new Error("项目终端已关闭。");
		}
		if (this.current !== undefined) {
			throw new Error("项目终端仍在运行。");
		}
		return new Promise((resolve) => {
			this.current = { command, args, name, environment: environment === undefined ? undefined : { ...environment }, resolve, cancelled: false };
			if (this.opened) {
				this.start();
			}
		});
	}

	open(): void {
		if (this.disposed) {
			return;
		}
		this.opened = true;
		this.start();
	}

	/** 启动独立进程，保持项目路径参数原样传递，隐藏 Windows 控制台窗口。 */
	private start(): void {
		const run = this.current;
		if (run === undefined || run.child !== undefined) {
			return;
		}
		this.writeEmitter.fire("\x1b[2J\x1b[3J\x1b[H");
		this.nameEmitter.fire(run.name);
		const shell = createWindowsSdkCapabilityShell(process.platform, process.env.ComSpec, run.command);
		try {
			const child = spawn(shell?.executable ?? run.command, shell === undefined ? [...run.args] : [...shell.args, run.command, ...run.args], {
				cwd: os.homedir(),
				env: run.environment === undefined ? undefined : { ...process.env, ...run.environment },
				windowsHide: true,
				detached: process.platform !== "win32",
				stdio: ["pipe", "pipe", "pipe"]
			});
			run.child = child;
			for (const stream of [child.stdout, child.stderr]) {
				stream?.setEncoding("utf8");
				stream?.on("data", terminalWriter((data) => this.writeEmitter.fire(data)));
			}
			child.once("error", (error) => this.failedToStart(run, error));
			child.once("close", (exitCode, signal) => this.finish(run, { exitCode, signal, cancelled: run.cancelled }));
		} catch (error) {
			this.failedToStart(run, error instanceof Error ? error : new Error(String(error)));
		}
	}

	/** 启动失败也保留中文原因，不虚构进程退出码。 */
	private failedToStart(run: ProjectRun, error: Error): void {
		this.writeEmitter.fire(`启动项目工具失败：${error.message}\r\n`);
		this.finish(run, { exitCode: null, signal: null, cancelled: run.cancelled, error });
	}

	/** 保留输出及实际结果；不关闭显示终端，因此 VS Code 不会追加进程退出信息。 */
	private finish(run: ProjectRun, result: ProjectProcessResult): void {
		if (this.current !== run) {
			return;
		}
		this.current = undefined;
		if (result.cancelled) {
			this.writeEmitter.fire("\r\n操作已取消。\r\n");
		}
		const status = result.cancelled ? "已取消" : result.exitCode === 0 && result.error === undefined ? "完成" : "失败";
		this.nameEmitter.fire(`${run.name}（${status}）`);
		run.resolve(result);
	}

	/** Ctrl+C 取消整个进程树；其它输入继续传递给项目工具。 */
	handleInput(data: string): void {
		if (data.includes("\x03")) {
			this.cancel();
		} else {
			this.current?.child?.stdin?.write(data);
		}
	}

	/** 同时终止 PowerShell 和它启动的 Java、ADB 等子进程。 */
	cancel(): void {
		const run = this.current;
		if (run === undefined || run.cancelled) {
			return;
		}
		run.cancelled = true;
		const child = run.child;
		if (child === undefined) {
			this.finish(run, { exitCode: null, signal: null, cancelled: true });
			return;
		}
		if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
			return;
		}
		if (process.platform === "win32") {
			const taskkill = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
			const killer = spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
			killer.once("error", (error) => {
				this.writeEmitter.fire(`终止项目工具失败：${error.message}\r\n`);
				child.kill();
			});
		} else {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		}
	}

	close(): void { this.dispose(); }

	/** 关闭终端或停用扩展时回收执行进程和事件。 */
	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.cancel();
		this.writeEmitter.dispose();
		this.nameEmitter.dispose();
	}
}

/** 编译和调试共用空闲终端；并行执行时分别显示，避免混合日志。 */
export class SdkProjectTerminals implements vscode.Disposable {
	private readonly terminals = new Map<vscode.Terminal, SdkProjectTerminal>();
	private readonly closeSubscription = vscode.window.onDidCloseTerminal((terminal) => {
		this.terminals.get(terminal)?.dispose();
		this.terminals.delete(terminal);
	});

	/** 在终端面板运行项目工具，不抢走编辑器焦点。 */
	run(command: string, args: readonly string[], name: string, environment?: Readonly<NodeJS.ProcessEnv>): Promise<ProjectProcessResult> {
		let entry = [...this.terminals].find(([, session]) => !session.running);
		if (entry === undefined) {
			const session = new SdkProjectTerminal();
			const terminal = vscode.window.createTerminal({ name, pty: session, isTransient: true });
			this.terminals.set(terminal, session);
			entry = [terminal, session];
		}
		const [terminal, session] = entry;
		const result = session.run(command, args, name, environment);
		terminal.show(true);
		return result;
	}

	/** 扩展生命周期结束时停止全部项目执行并关闭终端。 */
	dispose(): void {
		this.closeSubscription.dispose();
		for (const [terminal, session] of this.terminals) {
			session.dispose();
			terminal.dispose();
		}
		this.terminals.clear();
	}
}
