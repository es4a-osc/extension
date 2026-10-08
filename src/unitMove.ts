/*
协调项目树中的同项目单元拖放、文件移动和打开文档会话迁移，不修改用户代码及属性引用。
xhwsd@qq.com 2026-9-2
*/

import * as path from "node:path";
import * as vscode from "vscode";
import type { DirectoryNode, FileNode, ProgramTreeProvider } from "./programTree";
import { listSimpleFiles } from "./simpleFileDiscovery";
import {
	filePathKey,
	mostSpecificSourceRoot,
	sameFilePath,
	simpleQualifiedName
} from "./simpleProjectPaths";
import {
	SimpleCodeFileSystemProvider,
	toSimpleCodeUri
} from "./simpleCodeFileSystem";
import { workspacePathExists } from "./workspaceFileSystem";
import { hasOpenSimpleUnitTab, resolveSimpleUnitTab } from "./simpleUnitTabs";
import {
	toUnitContentPreviewUri,
	toUnitXmlPreviewUri
} from "./unitPreview";

/** 单元移动命令访问共享文档边界所需依赖。 */
export interface UnitMoveServices {
	readonly codeDocuments: SimpleCodeFileSystemProvider;
	readonly refreshProjectSemantics: () => Promise<void>;
}

/** 移动后需要按新路径恢复、但不能由 WorkspaceEdit 自动迁移的标签类型。 */
type MovedUnitTabKind = "contentPreview" | "source" | "xmlPreview";

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
		&& (binding.kind === "contentPreview" || binding.kind === "xmlPreview")
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
	const uri = kind === "contentPreview"
		? toUnitContentPreviewUri(sourceUri)
		: kind === "xmlPreview" ? toUnitXmlPreviewUri(sourceUri) : sourceUri;
	await vscode.commands.executeCommand("vscode.open", uri, { preview: false });
}

/** 去重枚举项目全部源码单元，并记录每个文件最具体的源码根。 */
async function projectUnitFiles(
	sourceRoots: readonly string[]
): Promise<readonly { readonly filePath: string; readonly sourceRoot: string }[]> {
	const fileGroups = await Promise.all(sourceRoots.map((sourceRoot) => listSimpleFiles(sourceRoot)));
	const files = new Map<string, string>();
	for (const filePath of fileGroups.flat()) {
		files.set(filePathKey(filePath), filePath);
	}
	return [...files.values()].flatMap((filePath) => {
		const sourceRoot = mostSpecificSourceRoot(sourceRoots, filePath);
		return sourceRoot === undefined ? [] : [{ filePath, sourceRoot }];
	});
}

/**
 * 把一个单元移动到同项目已有源码目录。
 *
 * 移动只改变真实文件路径并迁移打开文档会话；用户代码、XML 属性引用和项目配置保持原样。
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

	const newQualifiedName = simpleQualifiedName(targetRoot, targetFilePath);
	const duplicate = (await projectUnitFiles(project.sourceDirectories)).find((item) => (
		filePathKey(item.filePath) !== filePathKey(source.filePath)
		&& simpleQualifiedName(item.sourceRoot, item.filePath) === newQualifiedName
	));
	if (duplicate !== undefined) {
		throw new Error(`目标限定名“${newQualifiedName}”已经由 ${duplicate.filePath} 使用。`);
	}

	const sourceUri = vscode.Uri.file(source.filePath);
	if (services.codeDocuments.hasUnsavedChanges(sourceUri)) {
		throw new Error("该单元存在未保存修改，请先保存或撤销后再移动。");
	}
	/* 设计器 CustomDocument 的标签 URI 不能随代码 URI 自动改名，先禁止留下旧路径文档。 */
	if (hasOpenSimpleUnitTab(sourceUri, "designer")) {
		throw new Error("该单元的设计器仍然打开，请先关闭设计器后再移动。");
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
	if (
		movedTabs.length > 0
		&& !await vscode.window.tabGroups.close(movedTabs.map(({ tab }) => tab), true)
	) {
		throw new Error("无法关闭该单元使用旧路径的预览标签。");
	}

	const edit = new vscode.WorkspaceEdit();
	const oldCodeUri = toSimpleCodeUri(sourceUri);
	const newCodeUri = toSimpleCodeUri(targetUri);
	let renameRegistration: vscode.Disposable | undefined;
	let applied = false;
	try {
		renameRegistration = services.codeDocuments.allowUnitRename(sourceUri, targetUri);
		edit.renameFile(oldCodeUri, newCodeUri, { overwrite: false });
		applied = await vscode.workspace.applyEdit(edit);
	} catch (error) {
		renameRegistration?.dispose();
		for (const { kind } of movedTabs) {
			await reopenMovedUnitTab(kind, sourceUri);
		}
		throw error;
	}
	if (!applied) {
		renameRegistration?.dispose();
		for (const { kind } of movedTabs) {
			await reopenMovedUnitTab(kind, sourceUri);
		}
		throw new Error("VS Code 未能应用单元文件移动。");
	}

	provider.refresh();
	await services.refreshProjectSemantics();
	for (const { kind } of movedTabs) {
		await reopenMovedUnitTab(kind, targetUri);
	}
}
