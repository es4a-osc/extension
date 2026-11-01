/*
验证 Simple 文件发现的稳定顺序、后缀筛选、取消和不可读目录兼容行为。
xhwsd@qq.com 2026-9-2
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { listSimpleFiles } from "../simpleFileDiscovery";

test("重构严格扫描拒绝不可读子树，普通搜索仍可跳过", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-strict-discovery-"));
	const restricted = path.join(directory, "restricted");
	const nativeFs: typeof fs = require("node:fs/promises");
	const readDirectory = nativeFs.readdir;
	try {
		await fs.mkdir(restricted);
		await fs.writeFile(path.join(directory, "可读.simple"), "");
		await fs.writeFile(path.join(restricted, "引用.simple"), "");
		// 注入权限错误而不修改操作系统 ACL，确保 Windows 和其它平台得到相同边界。
		nativeFs.readdir = ((target: Parameters<typeof fs.readdir>[0], ...args: unknown[]) => {
			if (String(target) === restricted) return Promise.reject(Object.assign(new Error("拒绝访问"), { code: "EACCES" }));
			return Reflect.apply(readDirectory, nativeFs, [target, ...args]);
		}) as typeof fs.readdir;
		assert.deepEqual(await listSimpleFiles(directory), [path.join(directory, "可读.simple")]);
		await assert.rejects(listSimpleFiles(directory, undefined, { strict: true }), (error: unknown) => {
			assert.ok(error instanceof Error && error.message.includes(restricted));
			assert.equal((error.cause as NodeJS.ErrnoException).code, "EACCES");
			return true;
		});
		await assert.rejects(listSimpleFiles(path.join(directory, "missing"), undefined, { strict: true }), /无法完整扫描/u);
	} finally {
		nativeFs.readdir = readDirectory;
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("递归发现 Simple 文件并按目录项稳定排序", async () => {
	const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-simple-files-"));
	try {
		await fs.mkdir(path.join(temporaryDirectory, "b"));
		await fs.mkdir(path.join(temporaryDirectory, "a"));
		await fs.writeFile(path.join(temporaryDirectory, "b", "Second.SIMPLE"), "", "utf8");
		await fs.writeFile(path.join(temporaryDirectory, "a", "First.simple"), "", "utf8");
		await fs.writeFile(path.join(temporaryDirectory, "Ignored.txt"), "", "utf8");

		const files = await listSimpleFiles(temporaryDirectory);
		assert.deepEqual(files.map((filePath) => path.relative(temporaryDirectory, filePath)), [
			path.join("a", "First.simple"),
			path.join("b", "Second.SIMPLE")
		]);
		assert.deepEqual(await listSimpleFiles(temporaryDirectory, () => true), []);
		assert.deepEqual(await listSimpleFiles(path.join(temporaryDirectory, "missing")), []);
	} finally {
		await fs.rm(temporaryDirectory, { force: true, recursive: true });
	}
});
