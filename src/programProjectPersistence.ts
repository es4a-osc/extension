/*
在 VS Code 工作区配置与当前会话状态之间转换 ES4A 项目列表，并统一项目路径语义。
xhwsd@qq.com 2026-10-7
*/

import * as path from "node:path";
import { filePathKey } from "./simpleProjectPaths";

/** 项目树与工作区配置适配器之间传递有序项目列表的键。 */
export const PROGRAM_PROJECT_FILES_STATE_KEY = "es4a.projects";

/** ProgramTreeProvider 所需的最小项目状态接口。 */
export interface ProgramProjectState {
	/** 读取已持久化的状态值。 */
	get<T>(key: string, defaultValue: T): T;
	/** 更新已持久化的状态值。 */
	update(key: string, value: unknown, expectedProjectFiles?: readonly string[]): Thenable<void>;
}

/** 一个 ES4A 项目在工程文件中保存的项目级设置。 */
export type WorkspaceProjectSettings = Readonly<Record<string, unknown>>;

/** 工作区配置中一个有序 ES4A 项目根目录引用。 */
export interface WorkspaceProjectReference {
	readonly path: string;
	readonly settings?: WorkspaceProjectSettings;
}

/** 已解析为本机绝对项目文件的工作区项目。 */
export interface WorkspaceProjectEntry {
	readonly projectFile: string;
	readonly settings?: WorkspaceProjectSettings;
}

/** 项目级功能共享的工程项目注册表。 */
export interface WorkspaceProjectRegistry {
	/** 返回当前有序项目及其项目级设置。 */
	projectEntries(): readonly WorkspaceProjectEntry[];
	/** 在提交队列内基于最新设置求值，并保留项目列表、顺序和其它项目。 */
	updateProjectSettings(projectFile: string, update: (settings: WorkspaceProjectSettings | undefined) => WorkspaceProjectSettings | undefined): Thenable<void>;
}

/** 项目树状态与项目级设置注册表的统一实现。 */
export type PersistentProgramProjectState = ProgramProjectState & WorkspaceProjectRegistry;

/** 当前 VS Code 工作区提供的项目配置读写边界。 */
export interface ProgramWorkspaceConfiguration {
	/** 当前窗口是否具有可写的工作区配置。 */
	readonly available: boolean;
	/** 相对项目路径的解析基准；未命名工作区没有稳定基准。 */
	readonly baseDirectory?: string;
	/** 读取显式配置的 `es4a.projects`；未配置时返回 `undefined`。 */
	read(): unknown;
	/** 读取失败保留最后有效状态；显式写入仍必须拒绝损坏配置。 */
	onReadError?(error: unknown): void;
	/** 按原顺序更新 `es4a.projects`。 */
	update(projects: readonly WorkspaceProjectReference[], expected?: { readonly value: unknown }): Thenable<void>;
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 只接受项目设置对象，不解释各项目功能自己的内部字段。 */
function workspaceProjectSettings(value: unknown): WorkspaceProjectSettings | undefined {
	return isRecord(value) ? value : undefined;
}

/** 只保留项目树状态值中有效的绝对 `project.properties` 路径。 */
function normalizeProjectFiles(value: unknown): string[] {
	return Array.isArray(value)
		? value
			.filter((candidate): candidate is string => typeof candidate === "string")
			.map((candidate) => path.resolve(candidate))
		: [];
}

/** 把工作区项目根目录引用恢复为绝对项目文件和项目级设置。 */
function resolveWorkspaceProjectEntries(
	value: unknown,
	baseDirectory?: string
): readonly WorkspaceProjectEntry[] {
	if (!Array.isArray(value)) return [];
	const entries: WorkspaceProjectEntry[] = [];
	const seen = new Set<string>();

	for (const candidate of value) {
		if (!isRecord(candidate)) continue;
		const configuredPath = candidate.path;
		if (typeof configuredPath !== "string" || configuredPath.length === 0) continue;
		if (!path.isAbsolute(configuredPath) && baseDirectory === undefined) continue;

		const resolvedPath = path.isAbsolute(configuredPath)
			? path.resolve(configuredPath)
			: path.resolve(baseDirectory!, configuredPath);
		const projectFile = path.join(resolvedPath, "project.properties");
		const key = filePathKey(projectFile);
		if (seen.has(key)) continue;
		seen.add(key);
		entries.push({
			projectFile,
			settings: workspaceProjectSettings(candidate.settings)
		});
	}

	return entries;
}

/** 把工作区项目根目录引用恢复为项目属性文件绝对路径。 */
export function resolveWorkspaceProjectFiles(
	value: unknown,
	baseDirectory?: string
): readonly string[] {
	return resolveWorkspaceProjectEntries(value, baseDirectory).map((entry) => entry.projectFile);
}

/** 把项目属性文件绝对路径转换为有序工作区项目根目录引用。 */
export function serializeWorkspaceProjectFiles(
	projectFiles: readonly string[],
	baseDirectory?: string
): readonly WorkspaceProjectReference[] {
	return projectFiles.map((projectFile) => serializeWorkspaceProjectEntry({ projectFile }, baseDirectory));
}

/** 把一个已解析项目转换回工作区配置引用。 */
function serializeWorkspaceProjectEntry(
	entry: WorkspaceProjectEntry,
	baseDirectory?: string
): WorkspaceProjectReference {
	const projectDirectory = path.dirname(path.resolve(entry.projectFile));
	let configuredPath = projectDirectory;
	if (baseDirectory !== undefined) {
		const relativePath = path.relative(baseDirectory, projectDirectory);
		configuredPath = path.isAbsolute(relativePath)
			? projectDirectory
			: (relativePath.length === 0 ? "." : relativePath.replaceAll(path.sep, "/"));
	}
	return entry.settings === undefined || Object.keys(entry.settings).length === 0
		? { path: configuredPath }
		: { path: configuredPath, settings: entry.settings };
}

/** 把完整项目列表转换回工作区配置引用。 */
function serializeWorkspaceProjectEntries(
	entries: readonly WorkspaceProjectEntry[],
	baseDirectory?: string
): readonly WorkspaceProjectReference[] {
	return entries.map((entry) => serializeWorkspaceProjectEntry(entry, baseDirectory));
}

/**
 * 创建项目树和项目级功能共享的状态边界。
 *
 * 工作区配置是唯一持久化来源；没有工作区的空窗口只保留当前会话内存状态。
 */
export async function createProgramProjectState(
	workspace: ProgramWorkspaceConfiguration
): Promise<PersistentProgramProjectState> {
	let writeQueue: Promise<void> = Promise.resolve();
	const enqueueWrite = (operation: () => Promise<void>): Promise<void> => {
		const task = writeQueue.then(operation);
		writeQueue = task.catch(() => undefined);
		return task;
	};
	let entries: WorkspaceProjectEntry[] = [];
	let observedConfiguration: string | undefined;
	let configurationRevision = 0;
	let readFailure: string | undefined;
	const refreshFromWorkspace = (strict = false): unknown => {
		if (!workspace.available) return undefined;
		let current: unknown;
		try {
			current = workspace.read();
			readFailure = undefined;
		} catch (error) {
			if (strict) throw error;
			const message = String(error);
			if (message !== readFailure) workspace.onReadError?.(error);
			readFailure = message;
			return undefined;
		}
		const serialized = JSON.stringify(current);
		if (serialized !== observedConfiguration) {
			entries = [...resolveWorkspaceProjectEntries(current, workspace.baseDirectory)];
			observedConfiguration = serialized;
			configurationRevision++;
		}
		return current;
	};
	refreshFromWorkspace();
	// 加载只规范化内存路径；首次显式修改再写规范格式，不能因脏配置阻断扩展激活。
	const persistEntries = async (updated: WorkspaceProjectEntry[], expected: { readonly value: unknown }): Promise<void> => {
		const projects = serializeWorkspaceProjectEntries(updated, workspace.baseDirectory);
		if (!workspace.available) { entries = updated; return; }
		const revision = configurationRevision;
		await workspace.update(projects, expected);
		const current = refreshFromWorkspace();
		if (readFailure === undefined) {
			// 即使配置回到了先前值，也要以写入完成后的真实配置为准。
			entries = [...resolveWorkspaceProjectEntries(current, workspace.baseDirectory)];
		} else if (configurationRevision === revision) {
			// 没有更新的有效观测时，成功写出的版本才可作为最后有效状态。
			entries = updated;
			observedConfiguration = JSON.stringify(projects);
			configurationRevision++;
		}
	};

	return {
		get<T>(key: string, defaultValue: T): T {
			if (key !== PROGRAM_PROJECT_FILES_STATE_KEY) return defaultValue;
			refreshFromWorkspace();
			return entries.map((entry) => entry.projectFile) as T;
		},
		async update(key: string, value: unknown, expectedProjectFiles?: readonly string[]): Promise<void> {
			if (key !== PROGRAM_PROJECT_FILES_STATE_KEY) return;

			const updatedProjectFiles = normalizeProjectFiles(value);
			await enqueueWrite(async () => {
				const expected = { value: refreshFromWorkspace(true) };
				if (expectedProjectFiles !== undefined && JSON.stringify(entries.map((entry) => filePathKey(entry.projectFile))) !== JSON.stringify(expectedProjectFiles.map(filePathKey))) {
					throw new Error("工程项目列表已变化，请按最新列表重试。");
				}
				const existingByPath = new Map(entries.map((entry) => [filePathKey(entry.projectFile), entry]));
				const updatedEntries = updatedProjectFiles.map((projectFile) => ({
					projectFile,
					settings: existingByPath.get(filePathKey(projectFile))?.settings
				}));
				await persistEntries(updatedEntries, expected);
			});
		},
		projectEntries: () => { refreshFromWorkspace(); return entries.map((entry) => ({ ...entry })); },
		async updateProjectSettings(
			projectFile: string,
			update: (settings: WorkspaceProjectSettings | undefined) => WorkspaceProjectSettings | undefined
		): Promise<void> {
			await enqueueWrite(async () => {
				const expected = { value: refreshFromWorkspace(true) };
				const projectKey = filePathKey(projectFile);
				const projectIndex = entries.findIndex((entry) => filePathKey(entry.projectFile) === projectKey);
				if (projectIndex < 0) {
					throw new Error(`无法保存不属于当前工程的项目设置：${projectFile}`);
				}
				const updatedEntries = [...entries];
				const settings = update(entries[projectIndex]!.settings);
				updatedEntries[projectIndex] = {
					projectFile: updatedEntries[projectIndex]!.projectFile,
					settings: settings === undefined || Object.keys(settings).length === 0 ? undefined : settings
				};
				await persistEntries(updatedEntries, expected);
			});
		}
	};
}
