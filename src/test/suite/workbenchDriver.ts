/*
通过测试宿主的本地 DevTools 通道操作原生输入框，按可见状态等待而不绕过界面提交。
xhwsd@qq.com 2026-10-12
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";

interface DevToolsReply {
	readonly id?: number;
	readonly result?: { readonly result?: { readonly value?: unknown }; readonly exceptionDetails?: unknown };
	readonly error?: { readonly message: string };
}

/** 仅连接本轮测试宿主；不连接用户平时使用的 VS Code。 */
export class WorkbenchDriver {
	private nextId = 0;
	private readonly pending = new Map<number, { readonly resolve: (value: DevToolsReply["result"]) => void; readonly reject: (error: Error) => void }>();
	private constructor(private readonly socket: WebSocket) {
		socket.addEventListener("message", (event) => {
			const reply = JSON.parse(String(event.data)) as DevToolsReply;
			if (reply.id === undefined) return;
			const request = this.pending.get(reply.id);
			if (request === undefined) return;
			this.pending.delete(reply.id);
			if (reply.error !== undefined) request.reject(new Error(reply.error.message));
			else request.resolve(reply.result);
		});
		socket.addEventListener("close", () => this.rejectPending());
	}

	static async connect(): Promise<WorkbenchDriver> {
		const directory = process.env.ES4A_TEST_USER_DATA;
		assert.ok(directory, "必须由集成测试配置提供测试宿主目录");
		const [port] = (await fs.readFile(path.join(directory, "DevToolsActivePort"), "utf8")).split(/\r?\n/u);
		assert.match(port!, /^\d+$/u);
		const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) });
		const pages = await response.json() as Array<{ readonly type: string; readonly url: string; readonly webSocketDebuggerUrl?: string }>;
		const workbenches = pages.filter((page) => page.type === "page" && page.url.includes("workbench"));
		assert.equal(workbenches.length, 1, "必须唯一定位本轮测试工作台");
		const socket = new WebSocket(workbenches[0]!.webSocketDebuggerUrl!);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => { socket.close(); reject(new Error("测试工作台连接超时")); }, 5000);
			socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
			socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("测试工作台连接失败")); }, { once: true });
		});
		return new WorkbenchDriver(socket);
	}

	private async send(method: string, params: Readonly<Record<string, unknown>>): Promise<DevToolsReply["result"]> {
		const id = ++this.nextId;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await new Promise((resolve, reject) => {
				timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`测试工作台请求超时：${method}`)); }, 5000);
				this.pending.set(id, { resolve, reject });
				this.socket.send(JSON.stringify({ id, method, params }));
			});
		} finally { clearTimeout(timer); this.pending.delete(id); }
	}

	async evaluate(expression: string): Promise<unknown> {
		const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (result?.exceptionDetails !== undefined) throw new Error(JSON.stringify(result.exceptionDetails));
		return result?.result?.value;
	}

	async waitFor(expression: string): Promise<void> {
		for (let attempt = 0; attempt < 250; attempt += 1) {
			if (await this.evaluate(expression) === true) return;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		const state = await this.evaluate('({ active: document.activeElement?.outerHTML?.slice(0, 500), inputs: [...document.querySelectorAll(".rename-box input")].map(input => ({ value: input.value, visible: input.getClientRects().length })), notifications: document.querySelector(".notifications-toasts")?.textContent })');
		throw new Error(`测试工作台状态等待超时：${expression}；${JSON.stringify(state)}`);
	}

	async fill(selector: string, name: string): Promise<void> {
		await this.waitFor(`Boolean(document.querySelector(${JSON.stringify(selector)})?.getClientRects().length)`);
		assert.equal(await this.evaluate(`(() => {
			const input = document.querySelector(${JSON.stringify(selector)});
			input.focus(); input.value = ${JSON.stringify(name)};
			input.dispatchEvent(new Event("input", { bubbles: true }));
			return input.value;
		})()`), name);
	}

	async key(key: "F2" | "F5" | "Enter" | "Escape", control = false): Promise<void> {
		const code = key === "F2" ? 113 : key === "F5" ? 116 : key === "Enter" ? 13 : 27;
		for (const type of ["keyDown", "keyUp"]) await this.send("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: code, modifiers: control ? 2 : 0 });
	}

	private rejectPending(): void {
		for (const request of this.pending.values()) request.reject(new Error("测试工作台连接已关闭"));
		this.pending.clear();
	}

	dispose(): void { this.rejectPending(); this.socket.close(); }
}
