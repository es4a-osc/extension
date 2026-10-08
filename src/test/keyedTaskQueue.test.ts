/*
验证按键异步任务队列的串行顺序、跨键并行和失败恢复。
xhwsd@qq.com 2026-9-10
*/

import assert from "node:assert/strict";
import test from "node:test";
import { KeyedTaskQueue } from "../keyedTaskQueue";

test("同键任务串行执行且一次失败不阻断后续任务", async () => {
	const queue = new KeyedTaskQueue();
	const order: string[] = [];
	const first = queue.run("unit", async () => {
		order.push("first-start");
		await Promise.resolve();
		order.push("first-end");
	});
	const failed = queue.run("unit", async () => {
		order.push("failed");
		throw new Error("test failure");
	});
	const last = queue.run("unit", async () => {
		order.push("last");
		return 3;
	});

	await first;
	await assert.rejects(failed, /test failure/u);
	assert.equal(await last, 3);
	assert.deepEqual(order, ["first-start", "first-end", "failed", "last"]);
});

test("不同键的任务不互相等待", async () => {
	const queue = new KeyedTaskQueue();
	const order: string[] = [];
	let releaseFirst: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const first = queue.run("first", async () => {
		order.push("first-start");
		await gate;
		order.push("first-end");
	});
	const second = queue.run("second", async () => {
		order.push("second");
	});

	await second;
	assert.deepEqual(order, ["first-start", "second"]);
	releaseFirst?.();
	await first;
	assert.deepEqual(order, ["first-start", "second", "first-end"]);
});
