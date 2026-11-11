/*
验证项目后台监听覆盖资产引用，并隔离重叠项目各自的生成目录。
xhwsd@qq.com 2026-11-7
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createProjectInfo } from "../project";
import { ProjectFileWatcher } from "../projectFileWatcher";

/** 在限定时间内观察实际文件通知，避免以源码文本匹配代替监听行为。 */
async function expectFileChange(
	setup: (changed: () => void) => ProjectFileWatcher,
	write: () => Promise<void>
): Promise<void> {
	let resolve!: () => void;
	const observed = new Promise<void>((done) => { resolve = done; });
	const watcher = setup(resolve);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await write();
		await Promise.race([
			observed,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("没有收到项目文件变化")), 2500);
			})
		]);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
		watcher.dispose();
	}
}

test("项目树不参与时仍能收到资产文件的外部变化", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-watch-assets-"));
	const project = createProjectInfo(path.join(directory, "project.properties"), {});
	try {
		await fs.mkdir(project.assetsDirectory);
		await expectFileChange((changed) => {
			const watcher = new ProjectFileWatcher(changed, assert.fail);
			watcher.update([project]);
			return watcher;
		}, () => fs.writeFile(path.join(project.assetsDirectory, "note.txt"), "新资产"));
	} finally {
		await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test("其它项目的构建路径不会屏蔽当前项目明确配置的源码", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-watch-overlap-"));
	const outer = createProjectInfo(path.join(directory, "project.properties"), { source: "./" });
	const innerDirectory = path.join(outer.buildDirectory, "embedded");
	const inner = createProjectInfo(path.join(innerDirectory, "project.properties"), {});
	try {
		await fs.mkdir(inner.sourceDirectories[0]!, { recursive: true });
		await expectFileChange((changed) => {
			const watcher = new ProjectFileWatcher(changed, () => undefined);
			watcher.update([outer, inner]);
			return watcher;
		}, () => fs.writeFile(path.join(inner.sourceDirectories[0]!, "保留.simple"), "常量 数值 为 整数型 = 1"));
	} finally {
		await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test("项目自己的生成目录变化不触发源码分析，释放后不再收到事件", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-watch-generated-"));
	const project = createProjectInfo(path.join(directory, "project.properties"), { source: "./" });
	let changed = 0;
	const watcher = new ProjectFileWatcher(() => { changed++; }, () => undefined);
	try {
		await fs.mkdir(project.buildDirectory);
		const file = path.join(project.buildDirectory, "生成.simple");
		await fs.writeFile(file, "旧内容");
		watcher.update([project]);
		await fs.writeFile(file, "新内容");
		await new Promise((resolve) => setTimeout(resolve, 350));
		assert.equal(changed, 0);
		watcher.dispose();
		await fs.writeFile(path.join(directory, "用户.simple"), "源码");
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(changed, 0);
	} finally {
		watcher.dispose();
		await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});
