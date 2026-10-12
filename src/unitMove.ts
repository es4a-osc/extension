/*
协调同项目单元拖放，复用项目关联重构事务并迁移预览标签。
xhwsd@qq.com 2026-9-2
*/

import * as path from "node:path";
import * as vscode from "vscode";
import type { DirectoryNode, FileNode, ProgramTreeProvider } from "./programTree";
import type { SimpleProjectRefactoring } from "./projectRefactoring";
import {
	filePathKey,
	mostSpecificSourceRoot,
	sameFilePath
} from "./simpleProjectPaths";
import {
	SimpleCodeFileSystemProvider, toSimpleDesignerUri
} from "./simpleCodeFileSystem";
import { workspacePathExists } from "./workspaceFileSystem";
import { resolveSimpleUnitTab } from "./simpleUnitTabs";
import { SIMPLE_DESIGNER_VIEW_TYPE } from "./designerWebview";
import {
	toUnitContentPreviewUri,
	toUnitXmlPreviewUri
} from "./unitPreview";

/** 单元移动命令访问共享文档边界所需依赖。 */
export interface UnitMoveServices {
	readonly refactoring?: SimpleProjectRefactoring;
	readonly codeDocuments: SimpleCodeFileSystemProvider;
	readonly refreshProjectSemantics: () => Promise<void>;
}

/** 移动后需要按新路径恢复、但不能由 WorkspaceEdit 自动迁移的标签类型。 */
type MovedUnitTabKind = "contentPreview" | "source" | "xmlPreview" | "designer";

interface MovedUnitTab {
	readonly kind: MovedUnitTabKind;
	readonly tab: vscode.Tab;
}

/** 返回绑定真实源文件、且不会随虚拟代码 URI 自动迁移的标签。 */
function movedUnitTab(tab: vscode.Tab, sourceUri: vscode.Uri): MovedUnitTab | undefined {
	const binding = resolveSimpleUnitTab(tab);
	if (
		binding !== undefined
		&& sameFilePath(binding.sourceUri.fsPath, sourceUri.fsPath)
		&& (binding.kind === "contentPreview" || binding.kind === "xmlPreview" || binding.kind === "designer")
	) {
		return { kind: binding.kind, tab };
	}
	const input = tab.input;
	return input instanceof vscode.TabInputText
		&& input.uri.scheme === "file"
		&& sameFilePath(input.uri.fsPath, sourceUri.fsPath)
		? { kind: "source", tab }
		: undefined;
}

/** 按新的真实单元 URI 恢复移动前打开的预览或完整源码标签。 */
async function reopenMovedUnitTab(kind: MovedUnitTabKind, sourceUri: vscode.Uri): Promise<void> {
	if (kind === "designer") {
		await vscode.commands.executeCommand("vscode.openWith", toSimpleDesignerUri(sourceUri), SIMPLE_DESIGNER_VIEW_TYPE, { preview: false });
		return;
	}
	const uri = kind === "contentPreview"
		? toUnitContentPreviewUri(sourceUri)
		: kind === "xmlPreview" ? toUnitXmlPreviewUri(sourceUri) : sourceUri;
	await vscode.commands.executeCommand("vscode.open", uri, { preview: false });
}

/**
 * 把一个单元移动到同项目已有源码目录。
 *
 * 同步入站与出站引用、XML 对象关系及 main；关联文本等待保存，XML 沿用统一边界，撤销保留 VS Code 原有行为。
 */
export async function moveUnitToDirectory(
	provider: ProgramTreeProvider,
	services: UnitMoveServices,
	source: FileNode,
	target: DirectoryNode
): Promise<void> {
	if (source.kind !== "unit" || target.kind !== "directory" || target.mode !== "units") {
		throw new Error("只能把单元拖到项目的源码文件夹中。");
	}
	if (
		source.project === undefined
		|| target.project === undefined
		|| filePathKey(source.project.filePath) !== filePathKey(target.project.filePath)
	) {
		throw new Error("暂不支持跨项目移动单元，请将单元拖到当前项目的源码文件夹中。");
	}

	const project = source.project;
	const targetRoot = mostSpecificSourceRoot(project.sourceDirectories, target.directoryPath);
	const sourceRoot = mostSpecificSourceRoot(project.sourceDirectories, source.filePath);
	if (targetRoot === undefined || sourceRoot === undefined) {
		throw new Error("移动路径不属于当前项目配置的源码目录。");
	}

	const targetFilePath = path.join(target.directoryPath, path.basename(source.filePath));
	if (filePathKey(targetFilePath) === filePathKey(source.filePath)) {
		return;
	}
	const targetUri = vscode.Uri.file(targetFilePath);
	if (await workspacePathExists(targetUri)) {
		throw new Error(`目标文件已经存在：${targetFilePath}`);
	}

	const sourceUri = vscode.Uri.file(source.filePath);
	if (services.codeDocuments.hasUnsavedChanges(sourceUri)) {
		throw new Error("该单元存在未保存修改，请先保存或撤销后再移动。");
	}
	const movedTabs = vscode.window.tabGroups.all.flatMap((group) => (
		group.tabs.flatMap((tab) => {
			const binding = movedUnitTab(tab, sourceUri);
			return binding === undefined ? [] : [binding];
		})
	));
	if (movedTabs.some(({ tab }) => tab.isDirty)) {
		throw new Error("该单元存在未保存修改，请先保存或撤销后再移动。");
	}
	if (services.refactoring === undefined) throw new Error("单元移动缺少项目重构服务。");
	if (
		movedTabs.length > 0
		&& !await vscode.window.tabGroups.close(movedTabs.map(({ tab }) => tab), true)
	) {
		throw new Error("无法关闭该单元使用旧路径的预览标签。");
	}

	try {
		await services.refactoring.renamePath(project, source.filePath, targetFilePath, "units");
	} catch (error) {
		for (const { kind } of movedTabs) await reopenMovedUnitTab(kind, sourceUri);
		throw error;
	}

	provider.refresh();
	for (const { kind } of movedTabs) {
		await reopenMovedUnitTab(kind, targetUri);
	}
}
