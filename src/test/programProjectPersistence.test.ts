/*
验证 ES4A 项目列表在工作区配置、相对路径与空窗口内存状态之间的行为。
xhwsd@qq.com 2026-10-7
*/

import * as assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { createDesignerPreferenceState } from "../designerPreferencePersistence";
import { createProjectInfo } from "../project";
import { readWorkspaceConfigurationJsonc } from "../workspaceConfigurationFile";
import { sameFilePath } from "../simpleProjectPaths";
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

test("同一项目目录的多种写法只保留首次出现的条目", async () => {
	const workspaceDirectory = path.resolve("workspace");
	const first = { path: "./Project", settings: { setting: "first" } };
	const state = await createProgramProjectState({
		available: true,
		baseDirectory: workspaceDirectory,
		read: () => [first, { path: "Other/../Project", settings: { setting: "second" } }, { path: "Other" }],
		update: async () => undefined
	});
	assert.deepEqual(state.projectEntries(), [
		{ projectFile: path.join(workspaceDirectory, "Project", "project.properties"), settings: first.settings },
		{ projectFile: path.join(workspaceDirectory, "Other", "project.properties"), settings: undefined }
	]);
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

test("加载绝对项目路径不写配置，首次显式更新才规范为相对路径", async () => {
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

	assert.equal(writtenProjects, undefined);
	assert.deepEqual(state.get(PROGRAM_PROJECT_FILES_STATE_KEY, []), [
		path.join(configuredProjectDirectory, "project.properties")
	]);
	await state.update(PROGRAM_PROJECT_FILES_STATE_KEY, [path.join(configuredProjectDirectory, "project.properties")]);
	assert.deepEqual(writtenProjects, [{ path: "Configured" }]);
});

test("配置不能写入时仍可加载项目，显式写入失败保留原状态", async () => {
	const directory = path.resolve("workspace/Configured");
	const state = await createProgramProjectState({
		available: true, baseDirectory: path.dirname(directory), read: () => [{ path: directory }],
		update: async () => { throw new Error("工程配置有未保存修改"); }
	});
	assert.deepEqual(state.get(PROGRAM_PROJECT_FILES_STATE_KEY, []), [path.join(directory, "project.properties")]);
	await assert.rejects(async () => state.update(PROGRAM_PROJECT_FILES_STATE_KEY, []), /未保存修改/u);
	assert.deepEqual(state.get(PROGRAM_PROJECT_FILES_STATE_KEY, []), [path.join(directory, "project.properties")]);
});

test("排队提交时项目列表已变化则拒绝旧快照，并传递配置基线", async () => {
	const directory = path.resolve("workspace");
	let projects: readonly WorkspaceProjectReference[] = [{ path: "First" }];
	let writes = 0;
	const state = await createProgramProjectState({
		available: true, baseDirectory: directory, read: () => projects,
		update: async (next, expected) => { assert.deepEqual(expected, { value: projects }); writes++; projects = next; }
	});
	const first = path.join(directory, "First/project.properties");
	const second = path.join(directory, "Second/project.properties");
	projects = [{ path: "First", settings: { retained: true } }, { path: "Second" }];
	await assert.rejects(async () => state.update(PROGRAM_PROJECT_FILES_STATE_KEY, [], [first]), /列表已变化/u);
	assert.equal(writes, 0);
	assert.deepEqual(state.get(PROGRAM_PROJECT_FILES_STATE_KEY, []), [first, second]);
	await state.update(PROGRAM_PROJECT_FILES_STATE_KEY, [first], [first, second]);
	assert.deepEqual(projects, [{ path: "First", settings: { retained: true } }]);
});

test("项目列表更新只写工作区配置并保持顺序", async () => {
	const workspaceDirectory = path.resolve("workspace");
	const writes: Array<readonly WorkspaceProjectReference[]> = [];
	let configured: readonly WorkspaceProjectReference[] = [];
	const state = await createProgramProjectState({
		available: true,
		baseDirectory: workspaceDirectory,
		read: () => configured,
		update: (projects) => {
			configured = projects;
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
	let configured: readonly WorkspaceProjectReference[] = [];
	let releaseFirstWrite: (() => void) | undefined;
	const state = await createProgramProjectState({
		available: true,
		baseDirectory: workspaceDirectory,
		read: () => configured,
		update: (projects) => {
			configured = projects;
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

	await state.updateProjectSettings(firstFile, () => ({ designer: { documents: {} } }));

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

test("项目和设置写入结束后保留等待期间观察到的外部状态，后续操作不删除外部项目", async () => {
	const root = path.resolve("workspace");
	for (const settingsOnly of [false, true]) {
		let configured: readonly WorkspaceProjectReference[] = [{ path: "First" }];
		let enter!: () => void;
		let release!: () => void;
		const entered = new Promise<void>((resolve) => { enter = resolve; });
		const blocked = new Promise<void>((resolve) => { release = resolve; });
		const state = await createProgramProjectState({ available: true, baseDirectory: root, read: () => configured,
			update: async (projects) => { configured = projects; enter(); await blocked; } });
		const first = path.join(root, "First/project.properties");
		const pending = settingsOnly ? state.updateProjectSettings(first, () => ({ own: true }))
			: state.update(PROGRAM_PROJECT_FILES_STATE_KEY, [first, path.join(root, "Second/project.properties")], [first]);
		await entered;
		configured = [{ path: "External", settings: { retained: true } }];
		const external = path.join(root, "External/project.properties");
		assert.deepEqual(state.get(PROGRAM_PROJECT_FILES_STATE_KEY, []), [external]);
		release();
		await pending;
		assert.deepEqual(state.get(PROGRAM_PROJECT_FILES_STATE_KEY, []), [external]);
		await state.update(PROGRAM_PROJECT_FILES_STATE_KEY, [external, path.join(root, "Third/project.properties")], [external]);
		assert.deepEqual(configured, [{ path: "External", settings: { retained: true } }, { path: "Third" }]);
	}
});

test("不同设计器会话在提交队列内合并最新设置，不覆盖外部字段、其它文档及显示开关", async () => {
	const root = path.resolve("workspace");
	let configured: readonly WorkspaceProjectReference[] = [{ path: "First", settings: { original: true } }];
	const registry = await createProgramProjectState({ available: true, baseDirectory: root, read: () => configured, update: async (projects) => { configured = projects; } });
	const readProject = (file: string) => createProjectInfo(file, { source: "./src" });
	const first = createDesignerPreferenceState(registry, readProject);
	const second = createDesignerPreferenceState(registry, readProject);
	const one = first.updateDisplayOption(path.join(root, "First/src/窗口.simple"), "designerDebug", true);
	const two = second.updateDisplayOption(path.join(root, "First/src/另一个.simple"), "componentLabelsVisible", true);
	queueMicrotask(() => { configured = [{ path: "First", settings: { original: true, external: "KEEP", designer: { documents: { "src/窗口.simple": { displayOptions: { layoutHoverSync: true } } } } } }]; });
	await Promise.all([one, two]);
	assert.equal(configured[0]!.settings?.external, "KEEP");
	assert.equal(configured[0]!.settings?.original, true);
	assert.deepEqual(first.getDocument(path.join(root, "First/src/窗口.simple")), { displayOptions: { layoutHoverSync: true, designerDebug: true } });
	assert.deepEqual(second.getDocument(path.join(root, "First/src/另一个.simple")), { displayOptions: { componentLabelsVisible: true } });
});

test("损坏配置不阻断初始化，保留最后有效状态，拒绝写入并在修复后恢复", async () => {
	const root = path.resolve("workspace");
	let source = '{"es4a.projects":[}';
	let writes = 0;
	const errors: unknown[] = [];
	const state = await createProgramProjectState({ available: true, baseDirectory: root,
		read: () => readWorkspaceConfigurationJsonc(source, ["es4a.projects"]), onReadError: (error) => errors.push(error),
		update: async (projects) => { writes++; source = JSON.stringify({ "es4a.projects": projects }); } });
	assert.deepEqual(state.get(PROGRAM_PROJECT_FILES_STATE_KEY, []), []);
	assert.equal(errors.length, 1);
	await assert.rejects(async () => state.update(PROGRAM_PROJECT_FILES_STATE_KEY, []), /JSONC/u);
	assert.equal(writes, 0);
	source = '{"es4a.projects":[{"path":"First"}]}';
	const files = [path.join(root, "First/project.properties")];
	assert.deepEqual(state.get(PROGRAM_PROJECT_FILES_STATE_KEY, []), files);
	source = '{"es4a.projects":[}';
	assert.deepEqual(state.get(PROGRAM_PROJECT_FILES_STATE_KEY, []), files);
	assert.equal(errors.length, 2);
	source = '{"es4a.projects":[{"path":"First"}]}';
	await state.update(PROGRAM_PROJECT_FILES_STATE_KEY, [], files);
	assert.equal(writes, 1);
	assert.deepEqual(state.get(PROGRAM_PROJECT_FILES_STATE_KEY, []), []);
});

test("写入完成时配置损坏，保留最新有效观测；没有更新观测时保留本次成功写入", async () => {
	const root = path.resolve("workspace");
	for (const observeExternal of [false, true]) {
		let configured: readonly WorkspaceProjectReference[] = [{ path: "First" }];
		let broken = false;
		let enter!: () => void;
		let release!: () => void;
		const entered = new Promise<void>((resolve) => { enter = resolve; });
		const blocked = new Promise<void>((resolve) => { release = resolve; });
		const state = await createProgramProjectState({ available: true, baseDirectory: root,
			read: () => { if (broken) throw new Error("JSONC 损坏"); return configured; },
			update: async (projects) => { configured = projects; enter(); await blocked; } });
		const first = path.join(root, "First/project.properties");
		const own = [first, path.join(root, "Second/project.properties")];
		const pending = state.update(PROGRAM_PROJECT_FILES_STATE_KEY, own, [first]);
		await entered;
		const external = path.join(root, "External/project.properties");
		if (observeExternal) {
			configured = [{ path: "External", settings: { retained: true } }];
			assert.deepEqual(state.get(PROGRAM_PROJECT_FILES_STATE_KEY, []), [external]);
		}
		broken = true;
		release();
		await pending;
		assert.deepEqual(state.get(PROGRAM_PROJECT_FILES_STATE_KEY, []), observeExternal ? [external] : own);
		broken = false;
		assert.deepEqual(state.get(PROGRAM_PROJECT_FILES_STATE_KEY, []), observeExternal ? [external] : own);
	}
});

test("偏好提交时重新验证最具体所属项目，拒绝旧归属且重试写入新项目", async () => {
	const root = path.resolve("workspace");
	let configured: readonly WorkspaceProjectReference[] = [{ path: "First" }];
	let writes = 0;
	const first = path.join(root, "First/project.properties");
	const registry = await createProgramProjectState({ available: true, baseDirectory: root, read: () => configured, update: async (projects) => { writes++; configured = projects; } });
	const preferences = createDesignerPreferenceState(registry, (file) => createProjectInfo(file, { source: sameFilePath(file, first) ? "../shared" : "../shared/nested" }));
	const file = path.join(root, "shared/nested/窗口.simple");
	const pending = preferences.updateDisplayOption(file, "designerDebug", true);
	queueMicrotask(() => { configured = [{ path: "First" }, { path: "Second" }]; });
	await assert.rejects(async () => pending, /所属项目已变化/u);
	assert.equal(writes, 0);
	assert.deepEqual(configured, [{ path: "First" }, { path: "Second" }]);
	await preferences.updateDisplayOption(file, "designerDebug", true);
	assert.equal(registry.projectEntries()[0]!.settings, undefined);
	assert.deepEqual(preferences.getDocument(file), { displayOptions: { designerDebug: true } });
	assert.ok(registry.projectEntries()[1]!.settings?.designer);
});
