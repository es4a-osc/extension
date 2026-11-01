/*
验证整个项目树的逐层监听、折叠暂停、分支隔离和重新展开后的局部更新。
xhwsd@qq.com 2026-11-1
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ProgramTreeRefreshController } from "../programTreeRefresh";
import { createProjectInfo } from "../project";
import type { DirectoryNode, ProgramTreeNode } from "../programTree";
import { isPathInside } from "../simpleProjectPaths";

/** 等待真实文件系统事件合并完成，用于证明没有额外的界面刷新。 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300));

/** 为异步刷新设置有限等待，不用固定延时推断正向更新成功。 */
async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 4_000;
	while (!condition()) {
		assert.ok(Date.now() < deadline, "未收到预期的构建目录局部刷新");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** 创建独立的真实构建目录；监听器先释放，再清理系统临时文件。 */
async function fixture(build = "./build", exists = true) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-build-lazy-"));
	const project = createProjectInfo(path.join(directory, "project.properties"), { build });
	const refreshed: ProgramTreeNode[] = [];
	const controller = new ProgramTreeRefreshController((node) => refreshed.push(node));
	if (exists) {
		await fs.mkdir(project.buildDirectory, { recursive: true });
	}
	const projectNode = controller.roots([{ kind: "project", label: project.name, project }])[0]!;
	const root = controller.children(projectNode, [{
		directoryPath: project.buildDirectory, kind: "build", label: "构建",
		missing: !exists, mode: "build", project
	}])[0] as DirectoryNode;
	controller.setVisible(true);
	controller.setExpanded(projectNode, true);
	controller.children(root, []);
	await settle();
	refreshed.length = 0;
	return {
		directory, project, projectNode, root, controller, refreshed,
		async child(name: string): Promise<DirectoryNode> {
			const directoryPath = path.join(project.buildDirectory, name);
			await fs.mkdir(directoryPath, { recursive: true });
			return controller.children(root, [{ directoryPath, kind: "directory", label: name, mode: "build", project }])[0] as DirectoryNode;
		},
		async dispose(): Promise<void> {
			controller.dispose();
			assert.ok(isPathInside(os.tmpdir(), directory));
			assert.ok(path.basename(directory).startsWith("es4a-build-lazy-"));
			await fs.rm(directory, { recursive: true, force: true });
		}
	};
}

test("构建根折叠时，大量内部写入不触发显示刷新", async () => {
	const value = await fixture();
	try {
		const child = await value.child("dependencies");
		await Promise.all(Array.from({ length: 40 }, (_, index) => (
			fs.writeFile(path.join(child.directoryPath, `${index}.bin`), "artifact")
		)));
		await settle();
		assert.deepEqual(value.refreshed, []);
	} finally {
		await value.dispose();
	}
});

test("已展开目录合并新增事件，内容覆盖及折叠后的变化不重建节点", async () => {
	const value = await fixture();
	try {
		value.controller.setExpanded(value.root, true);
		await waitFor(() => value.refreshed.includes(value.root));
		value.refreshed.length = 0;
		await Promise.all(Array.from({ length: 20 }, (_, index) => (
			fs.writeFile(path.join(value.root.directoryPath, `${index}.apk`), "initial")
		)));
		await waitFor(() => value.refreshed.length > 0);
		await settle();
		assert.deepEqual(value.refreshed, [value.root]);
		value.refreshed.length = 0;
		await fs.writeFile(path.join(value.root.directoryPath, "0.apk"), "changed content");
		await settle();
		assert.deepEqual(value.refreshed, []);
		value.controller.setExpanded(value.root, false);
		await fs.writeFile(path.join(value.root.directoryPath, "later.apk"), "new");
		await settle();
		assert.deepEqual(value.refreshed, []);
		value.controller.setExpanded(value.root, true);
		await waitFor(() => value.refreshed.includes(value.root));
	} finally {
		await value.dispose();
	}
});

test("只更新展开目录的直接子项，折叠的依赖目录在展开时读取最新列表", async () => {
	const value = await fixture();
	try {
		const child = await value.child("dependencies");
		value.controller.children(value.root, [child]);
		value.controller.children(child, []);
		value.controller.setExpanded(value.root, true);
		await settle();
		value.refreshed.length = 0;
		await fs.writeFile(path.join(child.directoryPath, "library.aar"), "archive");
		await settle();
		assert.deepEqual(value.refreshed, []);
		value.controller.setExpanded(child, true);
		await waitFor(() => value.refreshed.includes(child));
		assert.ok(value.refreshed.every((node) => node === child));
		value.refreshed.length = 0;
		await fs.rename(path.join(child.directoryPath, "library.aar"), path.join(child.directoryPath, "renamed.aar"));
		await waitFor(() => value.refreshed.includes(child));
		value.refreshed.length = 0;
		await fs.unlink(path.join(child.directoryPath, "renamed.aar"));
		await waitFor(() => value.refreshed.includes(child));
	} finally {
		await value.dispose();
	}
});

test("父级收起或视图隐藏后，下级即使保留展开状态也停止监听", async () => {
	const value = await fixture();
	try {
		const child = await value.child("apks");
		value.controller.children(value.root, [child]);
		value.controller.children(child, []);
		value.controller.setExpanded(value.root, true);
		value.controller.setExpanded(child, true);
		await settle();
		value.refreshed.length = 0;
		value.controller.setExpanded(value.root, false);
		await fs.writeFile(path.join(child.directoryPath, "first.apk"), "first");
		await settle();
		assert.deepEqual(value.refreshed, []);
		value.controller.setExpanded(value.root, true);
		await waitFor(() => value.refreshed.includes(child));
		value.refreshed.length = 0;
		value.controller.setVisible(false);
		await fs.writeFile(path.join(child.directoryPath, "second.apk"), "second");
		await settle();
		assert.deepEqual(value.refreshed, []);
		value.controller.setVisible(true);
		await waitFor(() => value.refreshed.includes(child));
		value.refreshed.length = 0;
		value.controller.setExpanded(value.projectNode, false);
		await fs.writeFile(path.join(child.directoryPath, "third.apk"), "third");
		await settle();
		assert.deepEqual(value.refreshed, []);
	} finally {
		await value.dispose();
	}
});

test("构建根首次生成和删除只更新根节点，提前重读不会吞掉存在状态变化", async () => {
	const value = await fixture("./output/deep/build", false);
	try {
		await fs.mkdir(value.root.directoryPath, { recursive: true });
		assert.equal(value.controller.children(value.projectNode, [{ ...value.root, missing: false }])[0], value.root);
		await waitFor(() => value.refreshed.includes(value.root));
		assert.equal(value.root.missing, false);
		value.refreshed.length = 0;
		assert.ok(isPathInside(value.directory, value.root.directoryPath));
		await fs.rm(value.root.directoryPath, { recursive: true });
		await waitFor(() => value.refreshed.includes(value.root));
		assert.equal(value.root.missing, true);
		assert.ok(value.refreshed.every((node) => node === value.root));
	} finally {
		await value.dispose();
	}
});

test("项目移除会释放构建监听，重新登记同一路径不继承旧展开状态", async () => {
	const value = await fixture();
	try {
		value.controller.setExpanded(value.root, true);
		await settle();
		value.refreshed.length = 0;
		value.controller.roots([]);
		await fs.writeFile(path.join(value.root.directoryPath, "orphan.apk"), "unused");
		await settle();
		assert.deepEqual(value.refreshed, []);
		value.controller.roots([value.projectNode]);
		const root = value.controller.children(value.projectNode, [{ ...value.root }])[0]!;
		assert.notEqual(root, value.root);
		await fs.writeFile(path.join(value.root.directoryPath, "another.apk"), "unused");
		await settle();
		assert.deepEqual(value.refreshed, []);
	} finally {
		await value.dispose();
	}
});


test("重新展开时，自动展开探测的提前读取不能吞掉界面刷新", async () => {
	const value = await fixture();
	try {
		value.controller.setExpanded(value.root, true);
		await settle();
		value.controller.setExpanded(value.root, false);
		value.refreshed.length = 0;
		const filePath = path.join(value.root.directoryPath, "later.apk");
		await fs.writeFile(filePath, "new");
		value.controller.setExpanded(value.root, true);
		// 模拟自动展开逻辑先读取最新子项，但 VS Code 仍持有收起前的显示列表。
		value.controller.children(value.root, [{
			kind: "file", label: "later.apk", filePath, buildOutput: true, project: value.project
		}]);
		await waitFor(() => value.refreshed.includes(value.root));
		assert.ok(value.refreshed.every((node) => node === value.root));
	} finally {
		await value.dispose();
	}
});

test("已展开目录的结构变化不能被定位过程中的提前读取吞掉", async () => {
	const value = await fixture();
	try {
		value.controller.setExpanded(value.root, true);
		await settle();
		value.refreshed.length = 0;
		const filePath = path.join(value.root.directoryPath, "created.apk");
		await fs.writeFile(filePath, "output");
		value.controller.children(value.root, [{
			kind: "file", label: "created.apk", filePath, buildOutput: true, project: value.project
		}]);
		await waitFor(() => value.refreshed.includes(value.root));
		assert.ok(value.refreshed.every((node) => node === value.root));
	} finally {
		await value.dispose();
	}
});

for (const branch of ["units", "assets", "res"] as const) {
	test(`${branch} 分支只更新展开层，折叠、重新展开及内容覆盖遵循统一规则`, async () => {
		const value = await fixture();
		try {
			const resources: ProgramTreeNode = { kind: "resources", label: "资源", project: value.project };
			const units: ProgramTreeNode = { kind: "units", label: "单元", project: value.project };
			const groups = value.controller.children(value.projectNode, [units, resources, value.root]);
			let parent = groups[0]!;
			let directory = value.project.sourceDirectories[0]!;
			if (branch !== "units") {
				directory = branch === "assets" ? value.project.assetsDirectory : value.project.resourceDirectory;
				value.controller.setExpanded(groups[1]!, true);
				parent = value.controller.children(groups[1]!, [{
					kind: branch, label: branch, directoryPath: directory, mode: "resources", project: value.project
				}])[0]!;
			}
			await fs.mkdir(directory, { recursive: true });
			value.controller.children(parent, []);
			await settle();
			value.refreshed.length = 0;
			const filename = branch === "units" ? "Item.simple" : "data.txt";
			const filePath = path.join(directory, filename);
			await fs.writeFile(filePath, "initial");
			await settle();
			assert.deepEqual(value.refreshed, [], "折叠分支不能因内部新增重建列表");
			value.controller.setExpanded(parent, true);
			await waitFor(() => value.refreshed.includes(parent));
			value.refreshed.length = 0;
			await fs.writeFile(filePath, "content only");
			await settle();
			assert.deepEqual(value.refreshed, []);
			await fs.rename(filePath, path.join(directory, branch === "units" ? "Renamed.simple" : "renamed.txt"));
			await waitFor(() => value.refreshed.includes(parent));
			assert.ok(value.refreshed.every((node) => node === parent));
			value.controller.setExpanded(parent, false);
			value.refreshed.length = 0;
			await fs.writeFile(filePath, "returned");
			await settle();
			assert.deepEqual(value.refreshed, []);
			value.controller.setExpanded(parent, true);
			await waitFor(() => value.refreshed.includes(parent));
		} finally {
			await value.dispose();
		}
	});
}

test("重叠物理路径在单元与资源分支中保留独立节点和展开状态", async () => {
	const value = await fixture();
	try {
		const groups = value.controller.children(value.projectNode, [
			{ kind: "units", label: "单元", project: value.project },
			{ kind: "resources", label: "资源", project: value.project }
		]);
		await fs.mkdir(path.join(value.directory, "shared"));
		const directory = { kind: "directory", label: "shared", directoryPath: path.join(value.directory, "shared"), project: value.project } as const;
		const source = value.controller.children(groups[0]!, [{ ...directory, mode: "units" }])[0]!;
		const resource = value.controller.children(groups[1]!, [{ ...directory, mode: "resources", resourceRoot: "assets" }])[0]!;
		assert.notEqual(source, resource);
		value.controller.setExpanded(groups[0]!, true);
		value.controller.setExpanded(source, true);
		value.controller.children(source, []);
		await settle();
		value.refreshed.length = 0;
		await fs.writeFile(path.join(directory.directoryPath, "Item.simple"), "source");
		await waitFor(() => value.refreshed.includes(source));
		assert.ok(!value.refreshed.includes(resource));
		assert.equal(value.controller.children(groups[0]!, [{ ...directory, mode: "units" }])[0], source);
	} finally {
		await value.dispose();
	}
});

test("展开的子目录快速重建后，即使父级名称列表不变也会更新并恢复监听", async () => {
	const value = await fixture();
	try {
		const child = await value.child("outputs");
		value.controller.children(child, []);
		value.controller.setExpanded(value.root, true);
		value.controller.setExpanded(child, true);
		await settle();
		value.refreshed.length = 0;
		assert.ok(isPathInside(value.directory, child.directoryPath));
		await fs.rm(child.directoryPath, { recursive: true, maxRetries: 5, retryDelay: 50 });
		await fs.mkdir(child.directoryPath);
		await fs.writeFile(path.join(child.directoryPath, "rebuilt.apk"), "new output");
		await waitFor(() => value.refreshed.includes(child));
		await settle();
		value.refreshed.length = 0;
		await fs.writeFile(path.join(child.directoryPath, "next.apk"), "next output");
		await waitFor(() => value.refreshed.includes(child));
	} finally {
		await value.dispose();
	}
});
