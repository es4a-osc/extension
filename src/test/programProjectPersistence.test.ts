/*
验证 ES4A 项目列表在工作区配置、相对路径与空窗口内存状态之间的行为。
xhwsd@qq.com 2026-10-7
*/

import * as assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import {
	createProgramProjectState,
	PROGRAM_PROJECT_FILES_STATE_KEY,
	resolveWorkspaceProjectFiles,
	serializeWorkspaceProjectFiles,
	type WorkspaceProjectReference
} from "../programProjectPersistence";

test("工作区项目引用按工作区目录往返相对路径", () => {
	const workspaceDirectory = path.resolve("workspace");
	const projectFiles = [
		path.join(workspaceDirectory, "projects", "Tetris", "project.properties"),
		path.join(workspaceDirectory, "projects", "SmokeTest", "project.properties")
	];
	const references = serializeWorkspaceProjectFiles(projectFiles, workspaceDirectory);

	assert.deepEqual(references, [
		{ path: "projects/Tetris" },
		{ path: "projects/SmokeTest" }
	]);
	assert.deepEqual(resolveWorkspaceProjectFiles(references, workspaceDirectory), projectFiles);
});

test("工作区项目配置是项目列表唯一初始来源", async () => {
	const workspaceDirectory = path.resolve("workspace");
	const configuredProject = path.join(workspaceDirectory, "Configured", "project.properties");
	let workspaceUpdates = 0;
	const state = await createProgramProjectState({
		available: true,
		baseDirectory: workspaceDirectory,
		read: () => [{ path: "Configured" }],
		update: () => {
			workspaceUpdates += 1;
			return Promise.resolve();
		}
	});

	assert.deepEqual(state.get(PROGRAM_PROJECT_FILES_STATE_KEY, []), [configuredProject]);
	assert.equal(workspaceUpdates, 0);
});

test("正式工作区把未命名工作区留下的绝对项目路径规范为相对路径", async () => {
	const workspaceDirectory = path.resolve("workspace");
	const configuredProjectDirectory = path.join(workspaceDirectory, "Configured");
	let writtenProjects: readonly WorkspaceProjectReference[] | undefined;
	const state = await createProgramProjectState({
		available: true,
		baseDirectory: workspaceDirectory,
		read: () => [{ path: configuredProjectDirectory }],
		update: (projects) => {
			writtenProjects = projects;
			return Promise.resolve();
		}
	});

	assert.deepEqual(writtenProjects, [{ path: "Configured" }]);
	assert.deepEqual(state.get(PROGRAM_PROJECT_FILES_STATE_KEY, []), [
		path.join(configuredProjectDirectory, "project.properties")
	]);
});

test("项目列表更新只写工作区配置并保持顺序", async () => {
	const workspaceDirectory = path.resolve("workspace");
	const writes: Array<readonly WorkspaceProjectReference[]> = [];
	const state = await createProgramProjectState({
		available: true,
		baseDirectory: workspaceDirectory,
		read: () => [],
		update: (projects) => {
			writes.push(projects);
			return Promise.resolve();
		}
	});
	const updatedFiles = [
		path.join(workspaceDirectory, "B", "project.properties"),
		path.join(workspaceDirectory, "A", "project.properties")
	];

	await state.update(PROGRAM_PROJECT_FILES_STATE_KEY, updatedFiles);

	assert.deepEqual(writes, [[{ path: "B" }, { path: "A" }]]);
	assert.deepEqual(state.get(PROGRAM_PROJECT_FILES_STATE_KEY, []), updatedFiles);
});

test("连续项目操作串行写入工作区配置", async () => {
	const workspaceDirectory = path.resolve("workspace");
	const writes: Array<readonly WorkspaceProjectReference[]> = [];
	let releaseFirstWrite: (() => void) | undefined;
	const state = await createProgramProjectState({
		available: true,
		baseDirectory: workspaceDirectory,
		read: () => [],
		update: (projects) => {
			writes.push(projects);
			if (writes.length !== 1) return Promise.resolve();
			return new Promise<void>((resolve) => {
				releaseFirstWrite = resolve;
			});
		}
	});
	const firstFiles = [path.join(workspaceDirectory, "First", "project.properties")];
	const secondFiles = [path.join(workspaceDirectory, "Second", "project.properties")];

	const firstUpdate = state.update(PROGRAM_PROJECT_FILES_STATE_KEY, firstFiles);
	const secondUpdate = state.update(PROGRAM_PROJECT_FILES_STATE_KEY, secondFiles);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(writes, [[{ path: "First" }]]);

	releaseFirstWrite?.();
	await Promise.all([firstUpdate, secondUpdate]);

	assert.deepEqual(writes, [[{ path: "First" }], [{ path: "Second" }]]);
	assert.deepEqual(state.get(PROGRAM_PROJECT_FILES_STATE_KEY, []), secondFiles);
});

test("项目排序和增删保留对应项目设置且不串到其它项目", async () => {
	const workspaceDirectory = path.resolve("workspace");
	const firstFile = path.join(workspaceDirectory, "First", "project.properties");
	const secondFile = path.join(workspaceDirectory, "Second", "project.properties");
	let writtenProjects: readonly WorkspaceProjectReference[] | undefined;
	const state = await createProgramProjectState({
		available: true,
		baseDirectory: workspaceDirectory,
		read: () => [
			{ path: "First", settings: { designer: { documents: { "src/Main.simple": { columnOrder: [] } } } } },
			{ path: "Second", settings: { marker: "second" } }
		],
		update: (projects) => {
			writtenProjects = projects;
			return Promise.resolve();
		}
	});

	await state.update(PROGRAM_PROJECT_FILES_STATE_KEY, [secondFile, firstFile]);

	assert.deepEqual(writtenProjects, [
		{ path: "Second", settings: { marker: "second" } },
		{ path: "First", settings: { designer: { documents: { "src/Main.simple": { columnOrder: [] } } } } }
	]);
});

test("更新一个项目的设置保留项目顺序和其它项目", async () => {
	const workspaceDirectory = path.resolve("workspace");
	const firstFile = path.join(workspaceDirectory, "First", "project.properties");
	let writtenProjects: readonly WorkspaceProjectReference[] | undefined;
	const state = await createProgramProjectState({
		available: true,
		baseDirectory: workspaceDirectory,
		read: () => [{ path: "First" }, { path: "Second", settings: { marker: true } }],
		update: (projects) => {
			writtenProjects = projects;
			return Promise.resolve();
		}
	});

	await state.updateProjectSettings(firstFile, { designer: { documents: {} } });

	assert.deepEqual(writtenProjects, [
		{ path: "First", settings: { designer: { documents: {} } } },
		{ path: "Second", settings: { marker: true } }
	]);
});

test("没有工作区的空窗口只保留当前会话内存状态", async () => {
	let workspaceUpdates = 0;
	const state = await createProgramProjectState({
		available: false,
		read: () => undefined,
		update: () => {
			workspaceUpdates += 1;
			return Promise.resolve();
		}
	});
	const projectFiles = [path.resolve("Standalone", "project.properties")];

	await state.update(PROGRAM_PROJECT_FILES_STATE_KEY, projectFiles);

	assert.equal(workspaceUpdates, 0);
	assert.deepEqual(state.get(PROGRAM_PROJECT_FILES_STATE_KEY, []), projectFiles);
});
