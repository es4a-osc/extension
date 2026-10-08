/*
验证设计器界面偏好按 ES4A 项目归属、项目内单元路径和空窗口会话行为保存。
xhwsd@qq.com 2026-10-7
*/

import * as assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { createDesignerPreferenceState } from "../designerPreferencePersistence";
import type {
	WorkspaceProjectEntry,
	WorkspaceProjectRegistry,
	WorkspaceProjectSettings
} from "../programProjectPersistence";

/** 创建可观察项目设置写入的内存工程项目注册表。 */
function memoryProjectRegistry(
	initialEntries: readonly WorkspaceProjectEntry[] = []
): WorkspaceProjectRegistry & { writes: Array<{ projectFile: string; settings: WorkspaceProjectSettings | undefined }> } {
	let entries = initialEntries.map((entry) => ({ ...entry }));
	const writes: Array<{ projectFile: string; settings: WorkspaceProjectSettings | undefined }> = [];
	return {
		writes,
		projectEntries: () => entries.map((entry) => ({ ...entry })),
		updateProjectSettings: async (projectFile, settings) => {
			writes.push({ projectFile, settings });
			entries = entries.map((entry) => path.resolve(entry.projectFile) === path.resolve(projectFile)
				? { projectFile: entry.projectFile, settings }
				: entry);
		}
	};
}

test("设计器设置绑定对应项目并使用项目内相对单元路径", async () => {
	const projectDirectory = path.resolve("workspace", "Tetris");
	const projectFile = path.join(projectDirectory, "project.properties");
	const sourceFile = path.join(projectDirectory, "src", "simple", "Main.simple");
	const registry = memoryProjectRegistry([{ projectFile }]);
	const state = createDesignerPreferenceState(registry);

	await state.updateColumnOrder(sourceFile, ["toolbox", "projection", "property", "enabled"]);
	await state.updateDisplayOption(sourceFile, "componentLabelsVisible", true);

	assert.deepEqual(registry.projectEntries()[0]?.settings, {
		designer: {
			documents: {
				"src/simple/Main.simple": {
					columnOrder: ["toolbox", "projection", "property", "enabled"],
					displayOptions: {
						componentLabelsVisible: true
					}
				}
			}
		}
	});
	assert.deepEqual(state.getDocument(sourceFile), {
		columnOrder: ["toolbox", "projection", "property", "enabled"],
		displayOptions: {
			componentLabelsVisible: true
		}
	});
});

test("显示开关逐项合并且不写入用户没有操作的字段", async () => {
	const projectDirectory = path.resolve("workspace", "Tetris");
	const projectFile = path.join(projectDirectory, "project.properties");
	const sourceFile = path.join(projectDirectory, "src", "Main.simple");
	const registry = memoryProjectRegistry([{ projectFile }]);
	const state = createDesignerPreferenceState(registry);

	await state.updateDisplayOption(sourceFile, "designerDebug", true);
	await state.updateDisplayOption(sourceFile, "layoutHoverSync", false);

	assert.deepEqual(state.getDocument(sourceFile).displayOptions, {
		designerDebug: true,
		layoutHoverSync: false
	});
	assert.deepEqual(
		((registry.projectEntries()[0]?.settings?.designer as {
			documents: Record<string, { displayOptions: unknown }>;
		}).documents["src/Main.simple"]?.displayOptions),
		{ designerDebug: true, layoutHoverSync: false }
	);
});

test("栏目排序只写栏目设置且不补写缺失的显示开关", async () => {
	const projectDirectory = path.resolve("workspace", "Tetris");
	const projectFile = path.join(projectDirectory, "project.properties");
	const sourceFile = path.join(projectDirectory, "src", "Main.simple");
	const registry = memoryProjectRegistry([{
		projectFile,
		settings: {
			designer: {
				documents: {
					"src/Main.simple": { displayOptions: { designerDebug: false } }
				}
			}
		}
	}]);
	const state = createDesignerPreferenceState(registry);

	await state.updateColumnOrder(sourceFile, ["enabled", "projection", "property", "toolbox"]);

	assert.deepEqual(state.getDocument(sourceFile), {
		columnOrder: ["enabled", "projection", "property", "toolbox"],
		displayOptions: { designerDebug: false }
	});
});

test("相同项目内路径在不同项目中保持独立", async () => {
	const firstProject = path.resolve("workspace", "First");
	const secondProject = path.resolve("workspace", "Second");
	const registry = memoryProjectRegistry([
		{ projectFile: path.join(firstProject, "project.properties") },
		{ projectFile: path.join(secondProject, "project.properties") }
	]);
	const state = createDesignerPreferenceState(registry);
	const relativeUnit = path.join("src", "Main.simple");

	await state.updateDisplayOption(path.join(firstProject, relativeUnit), "componentLabelsVisible", true);

	assert.equal(state.getDocument(path.join(firstProject, relativeUnit)).displayOptions?.componentLabelsVisible, true);
	assert.deepEqual(state.getDocument(path.join(secondProject, relativeUnit)), {});
});

test("嵌套项目中的单元绑定最具体项目", async () => {
	const outerProject = path.resolve("workspace", "Outer");
	const innerProject = path.join(outerProject, "modules", "Inner");
	const registry = memoryProjectRegistry([
		{ projectFile: path.join(outerProject, "project.properties") },
		{ projectFile: path.join(innerProject, "project.properties") }
	]);
	const state = createDesignerPreferenceState(registry);

	await state.updateColumnOrder(
		path.join(innerProject, "src", "Main.simple"),
		["enabled", "projection", "property", "toolbox"]
	);

	assert.equal(registry.projectEntries()[0]?.settings, undefined);
	assert.deepEqual(registry.projectEntries()[1]?.settings, {
		designer: {
			documents: {
				"src/Main.simple": { columnOrder: ["enabled", "projection", "property", "toolbox"] }
			}
		}
	});
});

test("并发修改同一单元的栏目和显示设置不会互相覆盖", async () => {
	const projectDirectory = path.resolve("workspace", "Tetris");
	const projectFile = path.join(projectDirectory, "project.properties");
	let entry: WorkspaceProjectEntry = { projectFile };
	let writeCount = 0;
	let releaseFirstWrite: (() => void) | undefined;
	const registry: WorkspaceProjectRegistry = {
		projectEntries: () => [{ ...entry }],
		updateProjectSettings: async (_projectFile, settings) => {
			writeCount += 1;
			if (writeCount === 1) {
				await new Promise<void>((resolve) => {
					releaseFirstWrite = resolve;
				});
			}
			entry = { projectFile, settings };
		}
	};
	const state = createDesignerPreferenceState(registry);
	const sourceFile = path.join(projectDirectory, "src", "Main.simple");

	const columnUpdate = state.updateColumnOrder(
		sourceFile,
		["toolbox", "projection", "property", "enabled"]
	);
	const displayUpdate = state.updateDisplayOption(sourceFile, "designerDebug", true);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(writeCount, 1);
	releaseFirstWrite?.();
	await Promise.all([columnUpdate, displayUpdate]);

	assert.deepEqual(state.getDocument(sourceFile), {
		columnOrder: ["toolbox", "projection", "property", "enabled"],
		displayOptions: {
			designerDebug: true
		}
	});
});

test("单元移动在同一项目设置中同步相对路径键", async () => {
	const projectDirectory = path.resolve("workspace", "Tetris");
	const projectFile = path.join(projectDirectory, "project.properties");
	const oldSource = path.join(projectDirectory, "src", "Old.simple");
	const newSource = path.join(projectDirectory, "src", "nested", "New.simple");
	const registry = memoryProjectRegistry([{
		projectFile,
		settings: {
			custom: true,
			designer: { documents: { "src/Old.simple": { columnOrder: ["property", "enabled", "projection", "toolbox"] } } }
		}
	}]);
	const state = createDesignerPreferenceState(registry);

	await state.moveDocument(oldSource, newSource);

	assert.deepEqual(state.getDocument(oldSource), {});
	assert.deepEqual(state.getDocument(newSource).columnOrder, ["property", "enabled", "projection", "toolbox"]);
	assert.equal(registry.projectEntries()[0]?.settings?.custom, true);
});

test("删除最后一个单元偏好时收回空设计器设置并保留其它项目设置", async () => {
	const projectDirectory = path.resolve("workspace", "Tetris");
	const sourceFile = path.join(projectDirectory, "src", "Main.simple");
	const registry = memoryProjectRegistry([{
		projectFile: path.join(projectDirectory, "project.properties"),
		settings: {
			custom: true,
			designer: { documents: { "src/Main.simple": { displayOptions: { componentLabelsVisible: true } } } }
		}
	}]);
	const state = createDesignerPreferenceState(registry);

	await state.deleteDocument(sourceFile);

	assert.deepEqual(registry.projectEntries()[0]?.settings, { custom: true });
});

test("不属于当前工程项目的单元只保留当前会话偏好", async () => {
	const registry = memoryProjectRegistry();
	const state = createDesignerPreferenceState(registry);
	const sourceFile = path.resolve("Standalone", "Main.simple");

	await state.updateDisplayOption(sourceFile, "designerDebug", true);

	assert.equal(registry.writes.length, 0);
	assert.equal(state.getDocument(sourceFile).displayOptions?.designerDebug, true);
});
