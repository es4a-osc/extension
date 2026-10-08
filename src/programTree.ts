/*
管理已添加的 Simple 项目，并将其源码与资源映射为 ES4A 项目树。
xhwsd@qq.com 2026-8-27
*/

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { SimpleProjectInfo } from "./project";
import { toSimpleCodeUri } from "./simpleCodeFileSystem";
import { filePathKey, isPathInside } from "./simpleProjectPaths";
import { simpleResourceReferenceForFile } from "./simpleResourceSymbols";
import {
	listProgramDirectory,
	loadSimpleProject,
	programDirectoryExists,
	type ProgramDirectoryMode,
	type SimpleUnitMetadata
} from "./programResources";
import type { SimpleUnitType } from "./propertyXml";
import {
	PROGRAM_PROJECT_FILES_STATE_KEY,
	type ProgramProjectState
} from "./programProjectPersistence";

export type { ProgramProjectState } from "./programProjectPersistence";

/** ES4A 项目树内部拖放项目时使用的 MIME 类型。 */
const PROJECT_DRAG_MIME = "application/vnd.code.tree.es4a.programs";

/** 项目树中的 Simple 项目根节点。 */
export interface ProjectNode {
	readonly kind: "project";
	readonly label: string;
	readonly project: SimpleProjectInfo;
}

/** 项目下固定的单元或资源分组节点。 */
export interface GroupNode {
	readonly kind: "resources" | "units";
	readonly label: string;
	readonly project: SimpleProjectInfo;
}

/** 映射真实源码、资源或构建目录的可展开节点。 */
export interface DirectoryNode {
	readonly directoryPath: string;
	readonly kind: "assets" | "build" | "directory" | "res";
	readonly label: string;
	readonly missing?: boolean;
	readonly mode: ProgramDirectoryMode;
	readonly project?: SimpleProjectInfo;
	readonly resourceRoot?: "assets" | "res";
}

/** 映射真实 `.simple` 单元或普通资源文件的叶节点。 */
export interface FileNode {
	readonly baseObject?: string;
	readonly buildOutput?: boolean;
	readonly filePath: string;
	readonly interfaces?: readonly string[];
	readonly kind: "file" | "unit";
	readonly label: string;
	readonly project?: SimpleProjectInfo;
	readonly resourceIndex?: string;
	readonly resourceRoot?: "assets" | "res";
	readonly unitType?: SimpleUnitType;
}

/** 项目加载失败时保留在树中的可见诊断节点。 */
export interface ErrorNode {
	readonly kind: "error";
	readonly label: string;
	readonly message: string;
	readonly projectFilePath?: string;
}

/** 项目树中可显示的全部节点。 */
export type ProgramTreeNode = ProjectNode | GroupNode | DirectoryNode | FileNode | ErrorNode;

/** 判断节点是否为项目的“单元”根节点。 */
export function isUnitsNode(node: ProgramTreeNode | undefined): node is GroupNode & { readonly kind: "units" } {
	return node?.kind === "units";
}

/** 判断节点是否为源码包文件夹。 */
export function isUnitFolderNode(node: ProgramTreeNode | undefined): node is DirectoryNode {
	return node?.kind === "directory" && node.mode === "units";
}

/** 项目树把单元拖到源码目录时交给命令层执行的事务回调。 */
export type UnitMoveHandler = (source: FileNode, target: DirectoryNode) => Promise<void>;

/**
 * 把源码文件夹或单元节点解析为单元移动的目标文件夹。
 *
 * 拖到单元表示移动到该单元所在的同级目录，不表示调整树节点顺序。
 */
function unitDropDirectory(target: ProgramTreeNode | undefined): DirectoryNode | undefined {
	if (target?.kind === "directory" && target.mode === "units") {
		return target;
	}
	if (target?.kind !== "unit" || target.project === undefined) {
		return undefined;
	}

	const directoryPath = path.dirname(target.filePath);
	return {
		directoryPath,
		kind: "directory",
		label: path.basename(directoryPath),
		mode: "units",
		project: target.project
	};
}

/** 项目树内部单元拖放载荷只保存可重新定位的真实文件路径。 */
interface UnitDragPayload {
	readonly filePath: string;
	readonly kind: "unit";
}

/** 将未知异常转换为适合树节点提示的文本。 */
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 给项目树中的相对提示路径加上明确的当前目录前缀。 */
function explicitRelativePath(relativePath: string): string {
	return relativePath.length === 0 ? `.${path.sep}` : `.${path.sep}${relativePath}`;
}

/** 根据程序单元资源类型选择稳定的 VS Code 主题图标。 */
export function simpleUnitIcon(unitType: SimpleUnitType | undefined): vscode.ThemeIcon {
	switch (unitType) {
		case "窗口":
			return new vscode.ThemeIcon(
				"layout-menubar",
				new vscode.ThemeColor("charts.red")
			);
		case "对象":
			return new vscode.ThemeIcon("symbol-class");
		case "接口":
			return new vscode.ThemeIcon("symbol-interface");
		case "服务":
			return new vscode.ThemeIcon(
				"terminal",
				new vscode.ThemeColor("charts.purple")
			);
		default:
			return new vscode.ThemeIcon("symbol-file");
	}
}

/** 向项目树节点提示追加普通字段名和值，并安全转义。 */
function appendTreeTooltipField(
	tooltip: vscode.MarkdownString,
	label: string,
	value: string
): void {
	tooltip.appendMarkdown("  \n");
	tooltip.appendText(`${label}：${value}`);
}

/** 构造项目树节点提示，首行突出节点类型，其余信息使用统一字段样式。 */
function treeTooltip(
	summary: string,
	fields: readonly (readonly [label: string, value: string | undefined])[] = [],
	description?: string
): vscode.MarkdownString {
	const tooltip = new vscode.MarkdownString(undefined, true);
	tooltip.appendMarkdown("**");
	tooltip.appendText(summary);
	tooltip.appendMarkdown("**");
	if (description !== undefined) {
		tooltip.appendMarkdown("  \n");
		tooltip.appendText(description);
	}
	let firstField = true;
	for (const [label, value] of fields) {
		if (value === undefined) continue;
		if (description !== undefined && firstField) {
			tooltip.appendMarkdown("\n");
		}
		appendTreeTooltipField(tooltip, label, value);
		firstField = false;
	}
	return tooltip;
}

/** 构造单元树项提示，并补充其 Simple 限定关系。 */
function unitTooltip(
	unitType: SimpleUnitType | undefined,
	pathSummary: string,
	qualifiedNameSummary: string,
	baseObject: string | undefined,
	interfaces: readonly string[] | undefined
): vscode.MarkdownString {
	return treeTooltip(`${unitType ?? "未知"}单元`, [
		["路径", pathSummary],
		["限定名", qualifiedNameSummary],
		["基础对象", baseObject],
		["实现接口", interfaces === undefined || interfaces.length === 0 ? undefined : interfaces.join(",")]
	]);
}

/** 按对象单元当前关系组合生成菜单上下文，让复制项只在确有对应值时出现。 */
function objectUnitContextValue(
	baseObject: string | undefined,
	interfaces: readonly string[] | undefined
): string {
	const hasBaseObject = (baseObject?.trim().length ?? 0) > 0;
	const hasInterfaces = interfaces?.some((value) => value.trim().length > 0) ?? false;
	if (hasBaseObject && hasInterfaces) {
		return "es4a.objectUnit.baseObjectAndInterfaces";
	}
	if (hasBaseObject) {
		return "es4a.objectUnit.baseObject";
	}
	if (hasInterfaces) {
		return "es4a.objectUnit.interfaces";
	}
	return "es4a.objectUnit.none";
}

/** 为“项目”侧边栏提供多项目逻辑资源树。 */
export class ProgramTreeProvider implements
	vscode.TreeDataProvider<ProgramTreeNode>,
	vscode.TreeDragAndDropController<ProgramTreeNode>,
	vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<ProgramTreeNode | undefined>();
	private readonly parents = new WeakMap<ProgramTreeNode, ProgramTreeNode>();
	private projectFiles: string[];
	private directoryRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly directoryWatchers = new Map<string, vscode.Disposable>();
	private unitMoveHandler?: UnitMoveHandler;

	/** 在项目列表变化时通知 VS Code 重新读取树节点。 */
	readonly onDidChangeTreeData = this.changeEmitter.event;
	readonly dragMimeTypes = [PROJECT_DRAG_MIME];
	readonly dropMimeTypes = [PROJECT_DRAG_MIME];

	/**
	 * 创建项目树 Provider，并恢复当前工作区已添加的项目。
	 *
	 * @param state 可选工作区状态；测试或临时实例可以不持久化。
	 */
	constructor(
		private readonly state?: ProgramProjectState,
		private readonly knownUnitMetadata?: (filePath: string) => SimpleUnitMetadata | undefined
	) {
		const storedValue: unknown = state?.get<unknown>(PROGRAM_PROJECT_FILES_STATE_KEY, []);
		this.projectFiles = Array.isArray(storedValue)
			? storedValue.filter((value): value is string => typeof value === "string")
				.map((value) => path.resolve(value))
			: [];
	}

	/**
	 * 将一个本地 `project.properties` 加入当前工作区的项目列表。
	 *
	 * @param filePath 项目属性文件的完整路径。
	 * @returns 新增成功时返回 `true`；项目已存在时返回 `false`。
	 */
	async addProject(filePath: string): Promise<boolean> {
		const resolvedPath = path.resolve(filePath);

		if (path.basename(resolvedPath).toLowerCase() !== "project.properties") {
			throw new Error("请选择名为 project.properties 的 Simple 项目属性文件。");
		}

		if (this.projectFiles.some((candidate) => filePathKey(candidate) === filePathKey(resolvedPath))) {
			return false;
		}

		await loadSimpleProject(resolvedPath);
		this.projectFiles.push(resolvedPath);
		await this.state?.update(PROGRAM_PROJECT_FILES_STATE_KEY, this.projectFiles);
		this.refresh();
		return true;
	}

	/**
	 * 从当前工作区的项目列表移除一个项目，但不修改磁盘内容。
	 *
	 * @param filePath 项目绑定的 `project.properties` 完整路径。
	 * @returns 找到并移除项目时返回 `true`；项目不在列表中时返回 `false`。
	 */
	async removeProject(filePath: string): Promise<boolean> {
		const targetPath = filePathKey(filePath);
		const remainingFiles = this.projectFiles.filter(
			(candidate) => filePathKey(candidate) !== targetPath
		);

		if (remainingFiles.length === this.projectFiles.length) {
			return false;
		}

		this.projectFiles = remainingFiles;
		await this.state?.update(PROGRAM_PROJECT_FILES_STATE_KEY, this.projectFiles);
		this.refresh();
		return true;
	}

	/** 把拖动的顶层项目移动到目标项目前；目标为空时移动到列表末尾。 */
	async moveProjects(filePaths: readonly string[], targetFilePath?: string): Promise<boolean> {
		const sourcePaths = new Set(filePaths.map(filePathKey));
		const movedFiles = this.projectFiles.filter((candidate) => sourcePaths.has(filePathKey(candidate)));

		if (movedFiles.length === 0) {
			return false;
		}

		if (targetFilePath !== undefined && sourcePaths.has(filePathKey(targetFilePath))) {
			return false;
		}

		const remainingFiles = this.projectFiles.filter(
			(candidate) => !sourcePaths.has(filePathKey(candidate))
		);
		let targetIndex = remainingFiles.length;

		if (targetFilePath !== undefined) {
			targetIndex = remainingFiles.findIndex(
				(candidate) => filePathKey(candidate) === filePathKey(targetFilePath)
			);
			if (targetIndex < 0) {
				return false;
			}
		}

		const reorderedFiles = [
			...remainingFiles.slice(0, targetIndex),
			...movedFiles,
			...remainingFiles.slice(targetIndex)
		];
		if (reorderedFiles.every((filePath, index) => filePath === this.projectFiles[index])) {
			return false;
		}

		this.projectFiles = reorderedFiles;
		await this.state?.update(PROGRAM_PROJECT_FILES_STATE_KEY, this.projectFiles);
		this.refresh();
		return true;
	}

	/** 设置单元移动事务回调，树 Provider 本身不读取或修改项目文件。 */
	setUnitMoveHandler(handler: UnitMoveHandler): void {
		this.unitMoveHandler = handler;
	}

	/** 把单个单元或顶层项目节点加入当前项目树的拖放数据。 */
	handleDrag(
		source: readonly ProgramTreeNode[],
		dataTransfer: vscode.DataTransfer,
		token: vscode.CancellationToken
	): void {
		if (token.isCancellationRequested) {
			return;
		}

		if (source.length === 1 && source[0]?.kind === "unit") {
			const payload: UnitDragPayload = { filePath: source[0].filePath, kind: "unit" };
			dataTransfer.set(PROJECT_DRAG_MIME, new vscode.DataTransferItem(payload));
			return;
		}

		const filePaths = source
			.map((node) => this.projectFilePath(node))
			.filter((filePath): filePath is string => filePath !== undefined);
		if (filePaths.length > 0) {
			dataTransfer.set(PROJECT_DRAG_MIME, new vscode.DataTransferItem(filePaths));
		}
	}

	/** 接收项目排序，或把单元拖到源码文件夹及该文件夹中的任一单元。 */
	async handleDrop(
		target: ProgramTreeNode | undefined,
		dataTransfer: vscode.DataTransfer,
		token: vscode.CancellationToken
	): Promise<void> {
		if (token.isCancellationRequested) {
			return;
		}

		const value: unknown = dataTransfer.get(PROJECT_DRAG_MIME)?.value;
		if (
			typeof value === "object"
			&& value !== null
			&& "kind" in value
			&& value.kind === "unit"
			&& "filePath" in value
			&& typeof value.filePath === "string"
		) {
			const targetDirectory = unitDropDirectory(target);
			if (targetDirectory === undefined || this.unitMoveHandler === undefined) {
				return;
			}
			const source = await this.findUnitByFilePath(value.filePath);
			if (source !== undefined) {
				await this.unitMoveHandler(source, targetDirectory);
			}
			return;
		}
		if (!Array.isArray(value)) {
			return;
		}

		const targetFilePath = target === undefined ? undefined : this.projectFilePath(target);
		if (target !== undefined && targetFilePath === undefined) {
			return;
		}
		const filePaths = value.filter((filePath): filePath is string => typeof filePath === "string");
		await this.moveProjects(filePaths, targetFilePath);
	}

	/** 请求 VS Code 重新读取全部项目，或只重绘指定节点。 */
	refresh(node?: ProgramTreeNode): void {
		this.changeEmitter.fire(node);
	}

	/** 判断真实项目属性文件是否已经加入当前项目树。 */
	hasProjectProperties(filePath: string): boolean {
		const target = filePathKey(filePath);
		return this.projectFiles.some((candidate) => filePathKey(candidate) === target);
	}

	/** 返回当前项目列表，供项目级语言索引复用同一组 `project.properties` 绑定。 */
	async getProjects(): Promise<readonly SimpleProjectInfo[]> {
		const projects = await Promise.all(this.projectFiles.map(async (filePath) => {
			try {
				return await loadSimpleProject(filePath);
			} catch {
				// 项目树会显示对应错误节点；语言索引忽略当前不可读取的项目。
				return undefined;
			}
		}));

		return projects.filter((project): project is SimpleProjectInfo => project !== undefined);
	}

	/** 返回当前 Provider 实例生成节点的父级，供 VS Code 自动展开并定位树项。 */
	getParent(element: ProgramTreeNode): ProgramTreeNode | undefined {
		return this.parents.get(element);
	}

	/**
	 * 按磁盘路径查找已添加项目中的 Simple 单元。
	 *
	 * 只遍历包含目标文件的源码分支，并在遍历时建立完整父链，供 `TreeView.reveal` 使用。
	 *
	 * @param filePath 活动编辑器对应的本地文件路径。
	 * @returns 与路径匹配的单元节点；不属于已添加项目时返回 `undefined`。
	 */
	async findUnitByFilePath(filePath: string): Promise<FileNode | undefined> {
		if (path.extname(filePath).toLowerCase() !== ".simple") {
			return undefined;
		}

		const targetPath = filePathKey(filePath);
		const projects = await this.getChildren();

		for (const projectNode of projects) {
			if (
				projectNode.kind !== "project"
				|| !projectNode.project.sourceDirectories.some(
					(sourceDirectory) => isPathInside(sourceDirectory, filePath)
				)
			) {
				continue;
			}

			const unitsNode = (await this.getChildren(projectNode)).find(
				(node): node is GroupNode => node.kind === "units"
			);
			if (unitsNode === undefined) {
				return undefined;
			}

			return this.findUnitInBranch(targetPath, await this.getChildren(unitsNode));
		}

		return undefined;
	}

	/**
	 * 按磁盘路径查找已添加项目中的资源文件，并在遍历时建立完整父链供项目树选中。
	 *
	 * @param filePath `assets` 或 `res` 下真实资源文件的完整路径。
	 * @returns 与路径匹配的资源文件节点；不属于已添加项目时返回 `undefined`。
	 */
	async findResourceByFilePath(filePath: string): Promise<FileNode | undefined> {
		const targetPath = filePathKey(filePath);
		const projects = await this.getChildren();

		for (const projectNode of projects) {
			if (projectNode.kind !== "project") {
				continue;
			}
			const project = projectNode.project;
			if (
				!isPathInside(project.assetsDirectory, filePath)
				&& !isPathInside(project.resourceDirectory, filePath)
			) {
				continue;
			}

			const resourcesNode = (await this.getChildren(projectNode)).find(
				(node): node is GroupNode => node.kind === "resources"
			);
			if (resourcesNode === undefined) {
				return undefined;
			}

			return this.findResourceInBranch(targetPath, await this.getChildren(resourcesNode));
		}

		return undefined;
	}

	/** 将项目树数据节点转换为 VS Code 树节点。 */
	getTreeItem(element: ProgramTreeNode): vscode.TreeItem {
		const collapsibleState = element.kind === "project"
			|| element.kind === "resources"
			|| element.kind === "units"
			|| ((element.kind === "assets" || element.kind === "build" || element.kind === "directory" || element.kind === "res") && !element.missing)
			? vscode.TreeItemCollapsibleState.Collapsed
			: vscode.TreeItemCollapsibleState.None;
		const item = new vscode.TreeItem(element.label, collapsibleState);
		item.contextValue = `es4a.${element.kind}`;

		switch (element.kind) {
			case "project":
				item.id = `es4a.project:${vscode.Uri.file(element.project.filePath).toString()}`;
				item.iconPath = new vscode.ThemeIcon("project");
				item.tooltip = treeTooltip(element.project.name, [
					["主单元", element.project.properties.main],
					["版本号", element.project.properties["version.code"] || "1"],
					["版本名", element.project.properties["version.name"] || "1.0"]
				]);
				break;
			case "units":
				item.id = `es4a.units:${vscode.Uri.file(element.project.filePath).toString()}`;
				item.iconPath = new vscode.ThemeIcon("extensions");
				item.tooltip = treeTooltip("单元", [
					["路径", element.project.properties.source]
				], "项目源代码");
				break;
			case "resources":
				item.id = `es4a.resources:${vscode.Uri.file(element.project.filePath).toString()}`;
				item.iconPath = new vscode.ThemeIcon("archive");
				item.tooltip = treeTooltip("资源", [], "项目资产和资源");
				break;
			case "build":
				item.id = `es4a.build:${vscode.Uri.file(element.directoryPath).toString()}`;
				item.iconPath = new vscode.ThemeIcon("package");
				item.tooltip = treeTooltip("构建", [
					["路径", element.project?.properties.build ?? "./build"]
				], "项目构建目录");
				if (!element.missing) {
					item.resourceUri = vscode.Uri.file(element.directoryPath);
				}
				break;
			case "assets":
				item.id = `es4a.assets:${vscode.Uri.file(element.directoryPath).toString()}`;
				item.iconPath = new vscode.ThemeIcon("folder-library");
				item.tooltip = treeTooltip("Assets", [
					["路径", this.projectForNode(element)?.properties.assets]
				], "项目资产");
				break;
			case "res":
				item.id = `es4a.res:${vscode.Uri.file(element.directoryPath).toString()}`;
				item.iconPath = new vscode.ThemeIcon("folder-library");
				item.tooltip = treeTooltip("Res", [
					["路径", this.projectForNode(element)?.properties.res]
				], "项目资源");
				break;
			case "directory":
				item.id = `es4a.directory:${vscode.Uri.file(element.directoryPath).toString()}`;
				item.contextValue = element.mode === "units"
					? "es4a.unitFolder"
					: element.mode === "build"
						? "es4a.buildFolder"
						: element.resourceRoot === "res" ? "es4a.resFolder" : "es4a.assetsFolder";
				item.iconPath = new vscode.ThemeIcon("file-submodule");
				item.tooltip = element.mode === "units"
					? treeTooltip("源码文件夹", [
						["路径", this.sourceRelativePath(element, element.directoryPath)],
						["限定名", this.unitFolderQualifiedName(element)]
					])
					: element.mode === "build"
						? treeTooltip("构建文件夹", [
							["路径", this.mappedRelativePath(element, element.directoryPath)]
						])
						: treeTooltip(
						element.resourceRoot === "assets" ? "Assets 文件夹" : "Res 文件夹",
						[["路径", this.mappedRelativePath(element, element.directoryPath)]]
					);
				if (!element.missing) {
					item.resourceUri = vscode.Uri.file(element.directoryPath);
				}
				break;
			case "unit": {
				const knownMetadata = this.knownUnitMetadata?.(element.filePath);
				const unitType = knownMetadata === undefined ? element.unitType : knownMetadata.unitType;
				const baseObject = knownMetadata === undefined ? element.baseObject : knownMetadata.baseObject;
				const interfaces = knownMetadata === undefined ? element.interfaces : knownMetadata.interfaces;
				item.contextValue = unitType === "窗口"
					? "es4a.windowUnit"
					: unitType === "对象"
						? objectUnitContextValue(baseObject, interfaces)
						: "es4a.unit";
				item.id = `es4a.unit:${vscode.Uri.file(element.filePath).toString()}`;
				item.iconPath = simpleUnitIcon(unitType);
				item.tooltip = unitTooltip(
					unitType,
					this.sourceRelativePath(element, element.filePath),
					this.sourceQualifiedName(element, element.filePath),
					baseObject,
					interfaces
				);
				item.resourceUri = vscode.Uri.file(element.filePath);
				item.command = {
					arguments: [toSimpleCodeUri(vscode.Uri.file(element.filePath))],
					command: "vscode.open",
					title: "打开单元用户代码"
				};
			}
				break;
			case "file":
				item.id = `es4a.file:${vscode.Uri.file(element.filePath).toString()}`;
				item.contextValue = element.buildOutput
					? "es4a.buildFile"
					: element.resourceRoot === "assets"
					? "es4a.assetsFile"
					: element.resourceIndex === undefined
						? element.resourceRoot === "res" ? "es4a.resFile" : "es4a.file"
						: "es4a.resFile.indexed";
				item.tooltip = treeTooltip(
					element.buildOutput
						? "构建文件"
						: element.resourceRoot === "assets" ? "Assets 文件" : "Res 资源文件",
					[
						["路径", this.mappedRelativePath(element, element.filePath)],
						["索引", element.resourceIndex]
					]
				);
				item.resourceUri = vscode.Uri.file(element.filePath);
				item.command = {
					arguments: [item.resourceUri],
					command: "vscode.open",
					title: element.buildOutput ? "打开构建文件" : "打开资源文件"
				};
				break;
			case "error":
				item.contextValue = element.projectFilePath === undefined
					? "es4a.error"
					: "es4a.unavailableProject";
				item.iconPath = new vscode.ThemeIcon("error");
				item.description = "项目不可用";
				item.tooltip = treeTooltip(
					element.projectFilePath === undefined ? "源码目录错误" : "项目错误",
					[
						["原因", element.message],
						["路径", element.projectFilePath]
					]
				);
				break;
		}

		return item;
	}

	/** 按节点类型延迟加载下一层项目、目录或文件。 */
	async getChildren(element?: ProgramTreeNode): Promise<ProgramTreeNode[]> {
		if (element === undefined) {
			const nodes = await Promise.all(this.projectFiles.map(async (filePath): Promise<ProgramTreeNode> => {
				try {
					const project = await loadSimpleProject(filePath);
					return {
						kind: "project",
						label: project.name,
						project
					};
				} catch (error) {
					return {
						kind: "error",
						label: path.basename(path.dirname(filePath)),
						message: errorMessage(error),
						projectFilePath: filePath
					};
				}
			}));
			this.synchronizeDirectoryWatchers(nodes.flatMap((node) => (
				node.kind === "project" ? [node.project] : []
			)));
			return nodes;
		}

		switch (element.kind) {
			case "project":
				return this.rememberParent(element, [
					{ kind: "units", label: "单元", project: element.project },
					{ kind: "resources", label: "资源", project: element.project },
					await this.createMappedDirectory(
						"build",
						"构建",
						element.project.buildDirectory,
						element.project
					)
				]);
			case "units":
				return this.rememberParent(element, await this.getSourceChildren(element.project));
			case "resources":
				return this.rememberParent(element, await Promise.all([
					this.createMappedDirectory("assets", "Assets", element.project.assetsDirectory, element.project),
					this.createMappedDirectory("res", "Res", element.project.resourceDirectory, element.project)
				]));
			case "assets":
			case "build":
			case "directory":
			case "res":
				return element.missing
					? []
					: this.rememberParent(
						element,
						await this.getDirectoryChildren(
							element.directoryPath,
							element.mode,
							element.project,
							element.kind === "assets" || element.kind === "res"
								? element.kind
								: element.resourceRoot
						)
					);
			case "error":
			case "file":
			case "unit":
				return [];
		}
	}

	/**
	 * 返回当前节点唯一且可展开的真实子目录，供项目树沿单目录链自动展开。
	 *
	 * 单元、资源文件、错误节点或同时包含其他可见子项的目录都不构成单目录链。
	 */
	async getSingleDirectoryChild(element: ProgramTreeNode): Promise<DirectoryNode | undefined> {
		const children = await this.getChildren(element);
		if (children.length !== 1) {
			return undefined;
		}

		const child = children[0];
		return child !== undefined
			&& (child.kind === "assets" || child.kind === "build" || child.kind === "directory" || child.kind === "res")
			&& !child.missing
			? child
			: undefined;
	}

	/** 取得单元在源码映射根目录下的 Simple 限定名。 */
	unitQualifiedName(node: FileNode): string {
		return this.sourceQualifiedName(node, node.filePath);
	}

	/** 取得真实 `.simple` 文件相对于所属项目根目录的路径。 */
	unitProjectRelativePath(node: FileNode): string | undefined {
		const project = this.projectForNode(node);
		return project === undefined ? undefined : path.relative(project.directory, node.filePath);
	}

	/** 取得源码包文件夹最后一级的实际目录名。 */
	unitFolderName(node: DirectoryNode): string {
		return path.basename(node.directoryPath);
	}

	/** 取得源码包文件夹在源码映射根目录下的完整限定名。 */
	unitFolderQualifiedName(node: DirectoryNode): string {
		const relativePath = this.sourceRelativeLocation(node, node.directoryPath);
		return relativePath === undefined
			? path.basename(node.directoryPath)
			: relativePath.split(path.sep).join(".");
	}

	/** 取得真实源码包文件夹相对于所属项目根目录的路径。 */
	unitFolderProjectRelativePath(node: DirectoryNode): string | undefined {
		const project = this.projectForNode(node);
		return project === undefined ? undefined : path.relative(project.directory, node.directoryPath);
	}

	/** 取得可参与顶层排序的项目属性文件路径。 */
	private projectFilePath(node: ProgramTreeNode): string | undefined {
		if (node.kind === "project") {
			return node.project.filePath;
		}

		return node.kind === "error" ? node.projectFilePath : undefined;
	}

	/** 按所属项目的 `source=xxx` 目录生成单元分组内节点的提示路径。 */
	private sourceRelativePath(node: ProgramTreeNode, targetPath: string): string {
		const relativePath = this.sourceRelativeLocation(node, targetPath);
		return relativePath === undefined ? targetPath : explicitRelativePath(relativePath);
	}

	/** 按源码相对路径生成包含文件名的 Simple 对象类名。 */
	private sourceQualifiedName(node: ProgramTreeNode, targetPath: string): string {
		const relativePath = this.sourceRelativeLocation(node, targetPath);
		if (relativePath === undefined) {
			return path.basename(targetPath, path.extname(targetPath));
		}

		return relativePath
			.slice(0, -path.extname(relativePath).length)
			.split(path.sep)
			.join(".");
	}

	/** 取得目标在所属项目最具体 `source` 根目录下的原始相对路径。 */
	private sourceRelativeLocation(node: ProgramTreeNode, targetPath: string): string | undefined {
		const project = this.projectForNode(node);
		if (project === undefined) {
			return undefined;
		}

		const match = project.sourceDirectories
			.map((directoryPath) => ({
				directoryPath,
				relativePath: path.relative(directoryPath, targetPath)
			}))
			.filter(({ relativePath }) => (
				!path.isAbsolute(relativePath)
				&& relativePath !== ".."
				&& !relativePath.startsWith(`..${path.sep}`)
			))
			.sort((left, right) => right.directoryPath.length - left.directoryPath.length)[0];
		if (match === undefined) {
			return undefined;
		}
		return match.relativePath;
	}

	/** 沿节点父链取得所属项目。 */
	private projectForNode(node: ProgramTreeNode): SimpleProjectInfo | undefined {
		if ((node.kind === "assets" || node.kind === "build" || node.kind === "directory" || node.kind === "res"
			|| node.kind === "file" || node.kind === "unit") && node.project !== undefined) {
			return node.project;
		}

		let current: ProgramTreeNode | undefined = node;
		while (current !== undefined) {
			if (current.kind === "project" || current.kind === "units" || current.kind === "resources") {
				return current.project;
			}
			current = this.parents.get(current);
		}
		return undefined;
	}

	/** 按所属 Assets、Res 或 Build 映射根目录生成节点的提示路径。 */
	private mappedRelativePath(node: ProgramTreeNode, targetPath: string): string {
		let current: ProgramTreeNode | undefined = node;
		while (current !== undefined) {
			if (current.kind === "assets" || current.kind === "build" || current.kind === "res") {
				const relativePath = path.relative(current.directoryPath, targetPath);
				return explicitRelativePath(relativePath);
			}
			current = this.parents.get(current);
		}
		return targetPath;
	}

	/** 记录一组延迟加载节点的父级关系。 */
	private rememberParent(
		parent: ProgramTreeNode,
		children: ProgramTreeNode[]
	): ProgramTreeNode[] {
		for (const child of children) {
			this.parents.set(child, parent);
		}

		return children;
	}

	/** 在已经确认包含目标文件的源码分支中递归查找单元节点。 */
	private async findUnitInBranch(
		targetPath: string,
		nodes: readonly ProgramTreeNode[]
	): Promise<FileNode | undefined> {
		for (const node of nodes) {
			if (node.kind === "unit" && filePathKey(node.filePath) === targetPath) {
				return node;
			}

			if (
				node.kind === "directory"
				&& node.mode === "units"
				&& !node.missing
				&& isPathInside(node.directoryPath, targetPath)
			) {
				const result = await this.findUnitInBranch(targetPath, await this.getChildren(node));
				if (result !== undefined) {
					return result;
				}
			}
		}

		return undefined;
	}

	/** 在已经确认包含目标文件的资源分支中递归查找文件节点。 */
	private async findResourceInBranch(
		targetPath: string,
		nodes: readonly ProgramTreeNode[]
	): Promise<FileNode | undefined> {
		for (const node of nodes) {
			if (node.kind === "file" && filePathKey(node.filePath) === targetPath) {
				return node;
			}

			if (
				(node.kind === "assets" || node.kind === "directory" || node.kind === "res")
				&& node.mode === "resources"
				&& !node.missing
				&& isPathInside(node.directoryPath, targetPath)
			) {
				const result = await this.findResourceInBranch(targetPath, await this.getChildren(node));
				if (result !== undefined) {
					return result;
				}
			}
		}

		return undefined;
	}

	/** 枚举项目的一个或多个源码根目录。 */
	private async getSourceChildren(project: SimpleProjectInfo): Promise<ProgramTreeNode[]> {
		if (project.sourceDirectories.length === 1) {
			const sourceDirectory = project.sourceDirectories[0];

			if (sourceDirectory === undefined || !await programDirectoryExists(sourceDirectory)) {
				return [{
					kind: "error",
					label: "源码目录不可用",
					message: sourceDirectory === undefined
						? "项目没有配置有效的源码目录。"
						: `无法读取源码目录：${sourceDirectory}`
				}];
			}

			return this.getDirectoryChildren(sourceDirectory, "units", project);
		}

		return Promise.all(project.sourceDirectories.map(async (sourceDirectory): Promise<DirectoryNode> => ({
			directoryPath: sourceDirectory,
			kind: "directory",
			label: path.basename(sourceDirectory),
			missing: !await programDirectoryExists(sourceDirectory),
			mode: "units",
			project
		})));
	}

	/** 监听项目源码、Assets、Res 和 Build 目录的外部变化，使项目树与磁盘保持同步。 */
	private synchronizeDirectoryWatchers(projects: readonly SimpleProjectInfo[]): void {
		const desiredDirectories = new Map<string, string>();
		for (const project of projects) {
			const directories = [
				...project.sourceDirectories,
				project.assetsDirectory,
				project.resourceDirectory
			];
			if (fs.existsSync(project.buildDirectory)) {
				directories.push(project.buildDirectory);
			} else if (isPathInside(project.directory, project.buildDirectory)) {
				// 缺省构建目录通常尚未生成；先监听项目根，才能感知编译器首次创建目录。
				directories.push(project.directory);
			}
			for (const directory of directories) {
				desiredDirectories.set(filePathKey(directory), directory);
			}
		}

		for (const [key, watcher] of this.directoryWatchers) {
			if (!desiredDirectories.has(key)) {
				watcher.dispose();
				this.directoryWatchers.delete(key);
			}
		}

		for (const [key, directory] of desiredDirectories) {
			if (this.directoryWatchers.has(key)) {
				continue;
			}
			try {
				const watcher = fs.watch(
					directory,
					{ persistent: false, recursive: true },
					() => this.scheduleDirectoryRefresh()
				);
				const registration = new vscode.Disposable(() => watcher.close());
				watcher.on("error", () => {
					if (this.directoryWatchers.get(key) === registration) {
						this.directoryWatchers.delete(key);
					}
					watcher.close();
					this.scheduleDirectoryRefresh();
				});
				this.directoryWatchers.set(key, registration);
			} catch {
				// 目录不可用时由树节点明确展示，后续手动刷新会重新尝试建立监视器。
			}
		}
	}

	/** 合并同步盘和编辑器可能连续产生的多个文件事件。 */
	private scheduleDirectoryRefresh(): void {
		if (this.directoryRefreshTimer !== undefined) {
			clearTimeout(this.directoryRefreshTimer);
		}
		this.directoryRefreshTimer = setTimeout(() => {
			this.directoryRefreshTimer = undefined;
			this.refresh();
		}, 100);
	}

	/** 构造始终显示的 Assets、Res 或 Build 映射根节点。 */
	private async createMappedDirectory(
		kind: "assets" | "build" | "res",
		label: string,
		directoryPath: string,
		project: SimpleProjectInfo
	): Promise<DirectoryNode> {
		return {
			directoryPath,
			kind,
			label,
			missing: !await programDirectoryExists(directoryPath),
			mode: kind === "build" ? "build" : "resources",
			project,
			resourceRoot: kind === "build" ? undefined : kind
		};
	}

	/** 将物理目录的直接子项逐级转换为延迟树节点。 */
	private async getDirectoryChildren(
		directoryPath: string,
		mode: ProgramDirectoryMode,
		project?: SimpleProjectInfo,
		resourceRoot?: "assets" | "res"
	): Promise<ProgramTreeNode[]> {
		try {
			const entries = await listProgramDirectory(
				directoryPath,
				mode,
				this.knownUnitMetadata
			);
			return entries.map((entry): ProgramTreeNode => {
				if (entry.kind === "directory") {
					return {
						directoryPath: entry.path,
						kind: "directory",
						label: entry.label,
						mode,
						project,
						resourceRoot
					};
				}

				const node: FileNode = {
					baseObject: entry.baseObject,
					buildOutput: mode === "build",
					filePath: entry.path,
					interfaces: entry.interfaces,
					kind: entry.kind,
					label: entry.label,
					project,
					resourceIndex: resourceRoot === "res" && project !== undefined
						? simpleResourceReferenceForFile(project.resourceDirectory, entry.path)
						: undefined,
					resourceRoot,
					unitType: entry.unitType
				};

				return node;
			});
		} catch (error) {
			return [{
				kind: "error",
				label: "目录读取失败",
				message: errorMessage(error)
			}];
		}
	}

	/** 释放树刷新事件资源。 */
	dispose(): void {
		if (this.directoryRefreshTimer !== undefined) {
			clearTimeout(this.directoryRefreshTimer);
			this.directoryRefreshTimer = undefined;
		}
		for (const watcher of this.directoryWatchers.values()) {
			watcher.dispose();
		}
		this.directoryWatchers.clear();
		this.changeEmitter.dispose();
	}
}
