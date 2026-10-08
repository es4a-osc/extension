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
