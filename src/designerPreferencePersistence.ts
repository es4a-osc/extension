/*
把设计器界面偏好绑定到工程中的对应 ES4A 项目，并以项目内相对单元路径持久化。
xhwsd@qq.com 2026-10-7
*/

import * as path from "node:path";
import {
	isDesignerColumnOrder,
	type DesignerColumnId,
	type DesignerDisplayOptionId,
	type DesignerDisplayOptions
} from "./designerLayout";
import type {
	WorkspaceProjectEntry,
	WorkspaceProjectRegistry,
	WorkspaceProjectSettings
} from "./programProjectPersistence";
import { filePathKey, isPathInsideOrEqual } from "./simpleProjectPaths";

/** 一个 Simple 单元在所属项目中保存的设计器界面偏好。 */
export interface DesignerDocumentPreference {
	readonly columnOrder?: readonly DesignerColumnId[];
	readonly displayOptions?: Readonly<Partial<DesignerDisplayOptions>>;
}

/** 设计器 Provider 使用的项目级界面偏好状态。 */
export interface DesignerPreferenceState {
	/** 读取一个真实 Simple 单元在所属项目中的界面偏好。 */
	getDocument(sourceFilePath: string): DesignerDocumentPreference;
	/** 更新一个真实 Simple 单元的栏目顺序。 */
	updateColumnOrder(sourceFilePath: string, order: readonly DesignerColumnId[]): Thenable<void>;
	/** 只更新用户实际操作的一个显示开关。 */
	updateDisplayOption(
		sourceFilePath: string,
		option: DesignerDisplayOptionId,
		value: boolean
	): Thenable<void>;
	/** 同一项目内移动单元时同步项目内相对键。 */
	moveDocument(oldSourceFilePath: string, newSourceFilePath: string): Thenable<void>;
	/** 删除单元时移除其项目级设计器偏好。 */
	deleteDocument(sourceFilePath: string): Thenable<void>;
}

interface DesignerProjectBinding {
	readonly documentPath: string;
	readonly entry: WorkspaceProjectEntry;
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 从项目设置中取得设计器文档原始映射。 */
function rawDesignerDocuments(settings: WorkspaceProjectSettings | undefined): Record<string, unknown> {
	const designer = isRecord(settings?.designer) ? settings.designer : undefined;
	return isRecord(designer?.documents) ? designer.documents : {};
}

/** 只恢复当前项目级格式中的有效单元偏好，不读取旧工作区顶层设置。 */
function normalizeDocumentPreference(value: unknown): DesignerDocumentPreference {
	if (!isRecord(value)) return {};
	const columnOrder = isDesignerColumnOrder(value.columnOrder) ? [...value.columnOrder] : undefined;
	const rawDisplayOptions = isRecord(value.displayOptions) ? value.displayOptions : {};
	const displayOptions: {
		-readonly [Option in keyof DesignerDisplayOptions]?: DesignerDisplayOptions[Option];
	} = {};
	if (typeof rawDisplayOptions.componentLabelsVisible === "boolean") {
		displayOptions.componentLabelsVisible = rawDisplayOptions.componentLabelsVisible;
	}
	if (typeof rawDisplayOptions.designerDebug === "boolean") {
		displayOptions.designerDebug = rawDisplayOptions.designerDebug;
	}
	if (typeof rawDisplayOptions.layoutHoverSync === "boolean") {
		displayOptions.layoutHoverSync = rawDisplayOptions.layoutHoverSync;
	}
	return {
		...(columnOrder === undefined ? {} : { columnOrder }),
		...(Object.keys(displayOptions).length === 0 ? {} : { displayOptions })
	};
}

/** 从当前工程中选择包含目标单元的最具体项目，并生成项目内相对路径。 */
function projectBinding(
	registry: WorkspaceProjectRegistry,
	sourceFilePath: string
): DesignerProjectBinding | undefined {
	const resolvedSource = path.resolve(sourceFilePath);
	let selected: WorkspaceProjectEntry | undefined;
	for (const entry of registry.projectEntries()) {
		const projectDirectory = path.dirname(entry.projectFile);
		if (!isPathInsideOrEqual(projectDirectory, resolvedSource)) continue;
		if (
			selected === undefined
			|| projectDirectory.length > path.dirname(selected.projectFile).length
		) {
			selected = entry;
		}
	}
	if (selected === undefined) return undefined;
	return {
		documentPath: path.relative(path.dirname(selected.projectFile), resolvedSource).replaceAll(path.sep, "/"),
		entry: selected
	};
}

/** 用新的文档映射更新项目设置，并在内容为空时收回空容器。 */
function settingsWithDesignerDocuments(
	settings: WorkspaceProjectSettings | undefined,
	documents: Readonly<Record<string, unknown>>
): WorkspaceProjectSettings | undefined {
	const updatedSettings: Record<string, unknown> = { ...(settings ?? {}) };
	const existingDesigner = isRecord(updatedSettings.designer) ? updatedSettings.designer : {};
	const updatedDesigner: Record<string, unknown> = { ...existingDesigner };
	if (Object.keys(documents).length === 0) {
		delete updatedDesigner.documents;
	} else {
		updatedDesigner.documents = documents;
	}
	if (Object.keys(updatedDesigner).length === 0) {
		delete updatedSettings.designer;
	} else {
		updatedSettings.designer = updatedDesigner;
	}
	return Object.keys(updatedSettings).length === 0 ? undefined : updatedSettings;
}

/** 创建以 `es4a.projects[*].settings` 为唯一持久化来源的设计器偏好状态。 */
export function createDesignerPreferenceState(registry: WorkspaceProjectRegistry): DesignerPreferenceState {
	const unboundDocuments = new Map<string, DesignerDocumentPreference>();
	const unboundKey = (sourceFilePath: string): string => filePathKey(sourceFilePath);
	let writeQueue: Promise<void> = Promise.resolve();
	const enqueueWrite = (operation: () => Promise<void>): Promise<void> => {
		const task = writeQueue.then(operation);
		writeQueue = task.catch(() => undefined);
		return task;
	};

	const updateBoundDocument = (
		sourceFilePath: string,
		update: (current: DesignerDocumentPreference) => DesignerDocumentPreference | undefined
	): Promise<void> => enqueueWrite(async () => {
		const binding = projectBinding(registry, sourceFilePath);
		if (binding === undefined) {
			const key = unboundKey(sourceFilePath);
			const updated = update(unboundDocuments.get(key) ?? {});
			if (updated === undefined) unboundDocuments.delete(key);
			else unboundDocuments.set(key, updated);
			return;
		}
		const documents = { ...rawDesignerDocuments(binding.entry.settings) };
		const updated = update(normalizeDocumentPreference(documents[binding.documentPath]));
		if (updated === undefined || Object.keys(updated).length === 0) {
			delete documents[binding.documentPath];
		} else {
			documents[binding.documentPath] = updated;
		}
		await registry.updateProjectSettings(
			binding.entry.projectFile,
			settingsWithDesignerDocuments(binding.entry.settings, documents)
		);
	});

	return {
		getDocument(sourceFilePath: string): DesignerDocumentPreference {
			const binding = projectBinding(registry, sourceFilePath);
			return binding === undefined
				? unboundDocuments.get(unboundKey(sourceFilePath)) ?? {}
				: normalizeDocumentPreference(rawDesignerDocuments(binding.entry.settings)[binding.documentPath]);
		},
		updateColumnOrder: (sourceFilePath, order) => updateBoundDocument(
			sourceFilePath,
			(current) => ({ ...current, columnOrder: [...order] })
		),
		updateDisplayOption: (sourceFilePath, option, value) => updateBoundDocument(
			sourceFilePath,
			(current) => ({
				...current,
				displayOptions: { ...(current.displayOptions ?? {}), [option]: value }
			})
		),
		moveDocument(oldSourceFilePath: string, newSourceFilePath: string): Promise<void> {
			return enqueueWrite(async () => {
				const oldBinding = projectBinding(registry, oldSourceFilePath);
				const newBinding = projectBinding(registry, newSourceFilePath);
				if (oldBinding === undefined || newBinding === undefined) {
					const oldKey = unboundKey(oldSourceFilePath);
					const preference = unboundDocuments.get(oldKey);
					if (preference === undefined) return;
					unboundDocuments.delete(oldKey);
					unboundDocuments.set(unboundKey(newSourceFilePath), preference);
					return;
				}
				if (filePathKey(oldBinding.entry.projectFile) !== filePathKey(newBinding.entry.projectFile)) {
					throw new Error("设计器界面偏好不能跨 ES4A 项目移动。");
				}
				if (oldBinding.documentPath === newBinding.documentPath) return;
				const documents = { ...rawDesignerDocuments(oldBinding.entry.settings) };
				const preference = documents[oldBinding.documentPath];
				if (preference === undefined) return;
				delete documents[oldBinding.documentPath];
				documents[newBinding.documentPath] = preference;
				await registry.updateProjectSettings(
					oldBinding.entry.projectFile,
					settingsWithDesignerDocuments(oldBinding.entry.settings, documents)
				);
			});
		},
		deleteDocument: (sourceFilePath) => updateBoundDocument(sourceFilePath, () => undefined)
	};
}
