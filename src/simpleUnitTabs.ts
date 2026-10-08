/*
统一管理 ES4A 单元代码、预览与设计器标签页的项目归属和关闭生命周期。
xhwsd@qq.com 2026-9-6
*/

import * as vscode from "vscode";
import { SIMPLE_DESIGNER_VIEW_TYPE } from "./designerWebview";
import type { SimpleProjectInfo } from "./project";
import { findProjectForSource } from "./projectCapability";
import { readSimpleUnitType } from "./programResources";
import {
	SIMPLE_CODE_SCHEME,
	toSimpleSourceUri
} from "./simpleCodeFileSystem";
import { filePathKey, isPathInside, sameFilePath } from "./simpleProjectPaths";
import {
	UNIT_CONTENT_PREVIEW_SCHEME,
	UNIT_XML_PREVIEW_SCHEME,
	toUnitContentPreviewUri,
	toUnitPreviewSourceUri,
	toUnitXmlPreviewUri
} from "./unitPreview";

/** ES4A 自己创建并需要跟随项目生命周期的单元标签类型。 */
export type SimpleUnitTabKind = "code" | "contentPreview" | "designer" | "xmlPreview";

/** 一个 ES4A 标签页及其对应的真实 `.simple` 文件。 */
export interface SimpleUnitTabBinding {
	readonly kind: SimpleUnitTabKind;
	readonly sourceUri: vscode.Uri;
	readonly tab: vscode.Tab;
}

/** 启动恢复标签清理结果。 */
export interface SimpleUnitTabReconcileResult {
	readonly closed: number;
	readonly retainedDirtySources: readonly vscode.Uri[];
}

/** 把受 ES4A 管理的标签页解析为真实单元；普通真实文件标签不在此生命周期内。 */
export function resolveSimpleUnitTab(tab: vscode.Tab): SimpleUnitTabBinding | undefined {
	const input = tab.input;
	const uri = input instanceof vscode.TabInputText
		? input.uri
		: input instanceof vscode.TabInputCustom ? input.uri : undefined;
	if (uri === undefined) {
		return undefined;
	}

	const sourceUri = toUnitPreviewSourceUri(uri) ?? toSimpleSourceUri(uri);
	if (sourceUri === undefined) {
		return undefined;
	}

	let kind: SimpleUnitTabKind | undefined;
	if (input instanceof vscode.TabInputCustom && input.viewType === SIMPLE_DESIGNER_VIEW_TYPE) {
		kind = "designer";
	} else if (input instanceof vscode.TabInputText && uri.scheme === SIMPLE_CODE_SCHEME) {
		kind = "code";
	} else if (input instanceof vscode.TabInputText && uri.scheme === UNIT_CONTENT_PREVIEW_SCHEME) {
		kind = "contentPreview";
	} else if (input instanceof vscode.TabInputText && uri.scheme === UNIT_XML_PREVIEW_SCHEME) {
		kind = "xmlPreview";
	}

	return kind === undefined ? undefined : { kind, sourceUri, tab };
}

/** 返回当前全部受 ES4A 管理的单元标签。 */
function currentSimpleUnitTabs(): readonly SimpleUnitTabBinding[] {
	return vscode.window.tabGroups.all.flatMap((group) => (
		group.tabs.flatMap((tab) => {
			const binding = resolveSimpleUnitTab(tab);
			return binding === undefined ? [] : [binding];
		})
	));
}

/** 判断指定真实单元当前是否打开了某类受 ES4A 管理的标签。 */
export function hasOpenSimpleUnitTab(
	sourceUri: vscode.Uri,
	kind?: SimpleUnitTabKind
): boolean {
	return currentSimpleUnitTabs().some((binding) => (
		(kind === undefined || binding.kind === kind)
		&& sameFilePath(binding.sourceUri.fsPath, sourceUri.fsPath)
	));
}

/** 单元真实路径变化后，把仍绑定旧 URI 的只读预览迁移到新 URI。 */
export async function moveSimpleUnitPreviewTabs(
	oldSourceUri: vscode.Uri,
	newSourceUri: vscode.Uri
): Promise<void> {
	const previews = currentSimpleUnitTabs().filter((binding) => (
		sameFilePath(binding.sourceUri.fsPath, oldSourceUri.fsPath)
		&& (binding.kind === "contentPreview" || binding.kind === "xmlPreview")
	));
	if (previews.length === 0) {
		return;
	}
	if (!await closeTabs(previews.map(({ tab }) => tab))) {
		throw new Error("无法关闭使用旧路径的单元预览标签。");
	}
	for (const kind of new Set(previews.map((binding) => binding.kind))) {
		const uri = kind === "contentPreview"
			? toUnitContentPreviewUri(newSourceUri)
			: toUnitXmlPreviewUri(newSourceUri);
		await vscode.commands.executeCommand("vscode.open", uri, { preview: false });
	}
}

/** 查找真实单元当前打开且未保存的用户代码文档。 */
function dirtyCodeDocument(sourceUri: vscode.Uri): vscode.TextDocument | undefined {
	return vscode.workspace.textDocuments.find((document) => {
		const documentSourceUri = toSimpleSourceUri(document.uri);
		return document.isDirty
			&& document.uri.scheme === SIMPLE_CODE_SCHEME
			&& documentSourceUri !== undefined
			&& sameFilePath(documentSourceUri.fsPath, sourceUri.fsPath);
	});
}

/** 确保需要保护的未保存内容具有普通代码标签，而不是只依附于待关闭的设计器。 */
async function preserveDirtyCodeTab(document: vscode.TextDocument): Promise<void> {
	const alreadyOpen = currentSimpleUnitTabs().some((binding) => (
		binding.kind === "code" && binding.tab.input instanceof vscode.TabInputText
		&& binding.tab.input.uri.toString() === document.uri.toString()
	));
	if (!alreadyOpen) {
		await vscode.window.showTextDocument(document, { preserveFocus: true, preview: false });
	}
}

/** 关闭一组标签；空集合直接成功。 */
async function closeTabs(tabs: readonly vscode.Tab[]): Promise<boolean> {
	return tabs.length === 0 || vscode.window.tabGroups.close(tabs, true);
}

/**
 * 关闭指定源码目录中的全部 ES4A 单元标签。
 *
 * VS Code 会自行处理未保存确认；用户取消关闭时返回 `false`，调用方必须中止项目操作。
 */
export async function closeSimpleUnitTabsInDirectories(
	directoryPaths: readonly string[]
): Promise<boolean> {
	const tabs = currentSimpleUnitTabs()
		.filter((binding) => directoryPaths.some(
			(directoryPath) => isPathInside(directoryPath, binding.sourceUri.fsPath)
		))
		.map((binding) => binding.tab);
	return closeTabs(tabs);
}

/** 检查真实单元仍然存在且是文件。 */
async function sourceFileExists(sourceUri: vscode.Uri): Promise<boolean> {
	try {
		const stat = await vscode.workspace.fs.stat(sourceUri);
		return (stat.type & vscode.FileType.File) !== 0;
	} catch {
		return false;
	}
}

/**
 * 清理 VS Code 恢复出的失效 ES4A 标签。
 *
 * 项目列表是标签页归属的真值。未保存代码不能被自动关闭：先确保代码标签存在，再只关闭
 * 设计器和只读预览。干净的孤立标签直接关闭；非窗口单元只关闭错误恢复的设计器。
 */
export async function reconcileSimpleUnitTabs(
	projects: readonly SimpleProjectInfo[]
): Promise<SimpleUnitTabReconcileResult> {
	const groups = new Map<string, SimpleUnitTabBinding[]>();
	for (const binding of currentSimpleUnitTabs()) {
		const key = filePathKey(binding.sourceUri.fsPath);
		const group = groups.get(key) ?? [];
		group.push(binding);
		groups.set(key, group);
	}

	let closed = 0;
	const retainedDirtySources: vscode.Uri[] = [];
	for (const bindings of groups.values()) {
		const sourceUri = bindings[0]?.sourceUri;
		if (sourceUri === undefined) {
			continue;
		}
		const belongsToProject = findProjectForSource(projects, sourceUri.fsPath) !== undefined;
		const exists = belongsToProject && await sourceFileExists(sourceUri);
		const invalidDesigner = exists && bindings.some((binding) => binding.kind === "designer")
			&& await readSimpleUnitType(sourceUri.fsPath) !== "窗口";
		if (exists && !invalidDesigner) {
			continue;
		}

		const dirtyDocument = dirtyCodeDocument(sourceUri);
		let tabsToClose: readonly vscode.Tab[];
		if (!exists && dirtyDocument !== undefined) {
			await preserveDirtyCodeTab(dirtyDocument);
			retainedDirtySources.push(sourceUri);
			tabsToClose = bindings
				.filter((binding) => binding.kind !== "code")
				.map((binding) => binding.tab);
		} else if (invalidDesigner) {
			tabsToClose = bindings
				.filter((binding) => binding.kind === "designer")
				.map((binding) => binding.tab);
		} else {
			tabsToClose = bindings.map((binding) => binding.tab);
		}

		if (await closeTabs(tabsToClose)) {
			closed += tabsToClose.length;
		}
	}

	return { closed, retainedDirtySources };
}
