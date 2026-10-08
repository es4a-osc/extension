/*
注册 ES4A 项目树的创建、重命名、事件定位、预览、刷新、移除与回收站删除命令。
xhwsd@qq.com 2026-8-29
*/

import * as path from "node:path";
import * as vscode from "vscode";
import { renameSimpleComponent } from "./componentRename";
import { KeyedTaskQueue } from "./keyedTaskQueue";
import {
	ProgramTreeProvider,
	isUnitFolderNode,
	isUnitsNode,
	simpleUnitIcon,
	type DirectoryNode,
	type FileNode,
	type ProgramTreeNode,
	type ProjectNode
} from "./programTree";
import {
	type SimpleUnitType
} from "./propertyXml";
import { filePathKey, isPathInside, sameFilePath } from "./simpleProjectPaths";
import {
	createSimpleUnitSourceFromTemplate,
	resolveSimpleUnitLifecycleEventAction,
	validateResourceFileName,
	validateUnitFolderName,
	validateUnitName,
	type SimpleUnitLifecycleEventName
} from "./unitFiles";
import { createProjectInfo, parseProjectProperties } from "./project";
import {
	renderSdkTemplate,
	type Sdk,
	type SdkTemplate
} from "./sdk";
import { SIMPLE_DESIGNER_VIEW_TYPE } from "./designerWebview";
import {
	SIMPLE_CODE_SCHEME,
	toSimpleCodeUri,
	toSimpleDesignerUri,
	toSimpleSourceUri
} from "./simpleCodeFileSystem";
import {
	UNIT_CONTENT_PREVIEW_SCHEME,
	UNIT_XML_PREVIEW_SCHEME,
	toUnitContentPreviewUri,
	toUnitPreviewSourceUri,
	toUnitXmlPreviewUri
} from "./unitPreview";
import { showProjectCodeSearch } from "./projectCodeSearchCommand";
import { moveUnitToDirectory } from "./unitMove";
import { UnitTransferController } from "./unitTransfer";
import { closeSimpleUnitTabsInDirectories } from "./simpleUnitTabs";
import { listSimpleFiles } from "./simpleFileDiscovery";
import {
	editProjectManifestMacro,
	editProjectProperty,
	type EditableProjectProperty
} from "./projectPropertyCommands";
import {
	copyResourceText,
	copyUnitFolderText,
	copyUnitText,
	selectBaseObject,
	selectImplementedInterfaces,
	selectObjectRelation,
	type UnitRelationServices
} from "./unitRelationCommands";
import { workspacePathExists } from "./workspaceFileSystem";

/** 用户确认删除时使用的统一操作文案。 */
const MOVE_TO_TRASH = "移至回收站";
const DELETE_PERMANENTLY = "永久删除";

/** 项目树行内“创建”入口中的可执行目标；分隔项不携带目标。 */
interface CreateQuickPickItem extends vscode.QuickPickItem {
	readonly target?: SimpleUnitType | "文件夹";
}

/** 创建项目命令经过交互确认后的完整输入；目录名与项目名分别保存。 */
interface CreateProjectRequest {
	readonly packageName: string;
	readonly parentDirectory: vscode.Uri;
	readonly projectDirectoryName: string;
	readonly projectName: string;
}

/** 项目树命令在单元路径生命周期中需要同步的设计器状态。 */
interface ProgramCommandServices extends UnitRelationServices {
	readonly deleteDesignerSourceState: (sourceUri: vscode.Uri) => Promise<void>;
	readonly moveDesignerSourceState: (oldSourceUri: vscode.Uri, newSourceUri: vscode.Uri) => Promise<void>;
}

/** 可创建单元类型对应的 SDK 模板稳定标识。 */
const UNIT_TEMPLATE_IDS: Readonly<Record<SimpleUnitType, string>> = {
	"窗口": "window",
	"对象": "object",
	"接口": "interface",
	"服务": "service"
};

/** 取得当前 SDK 注册的必需模板。 */
function requireSdkTemplate(
	getSdk: () => Sdk | undefined,
	id: string
): SdkTemplate {
	const sdk = getSdk();
	if (sdk === undefined) {
		throw new Error("当前没有可用的 SDK，无法创建项目或单元。");
	}
	const template = sdk.templates[id];
	if (template === undefined) {
		throw new Error("当前 SDK 未注册“" + id + "”模板。");
	}
	return template;
}

/** 为可创建单元提供清单声明的模板变量值。 */
function simpleUnitTemplateValues(
	unitType: SimpleUnitType,
	unitName: string
): Readonly<Record<string, string>> {
	switch (unitType) {
		case "窗口":
			return { "窗口名称": unitName };
		case "对象":
			return { "对象名称": unitName };
		case "接口":
		case "服务":
			return {};
	}
}

/** 将未知异常转成用户可读文本。 */
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 把代码、预览和设计器标签页 URI 统一解析为真实 `.simple` 文件。 */
function relatedUnitSourceUri(uri: vscode.Uri): vscode.Uri | undefined {
	return toUnitPreviewSourceUri(uri) ?? toSimpleSourceUri(uri);
}

/** 返回文本或自定义编辑器标签绑定的 URI。 */
function tabUri(tab: vscode.Tab): vscode.Uri | undefined {
	const input = tab.input;
	return input instanceof vscode.TabInputText
		? input.uri
		: input instanceof vscode.TabInputCustom ? input.uri : undefined;
}

/** 判断标签页是否绑定指定真实单元文件。 */
function tabMatchesUnit(tab: vscode.Tab, sourceUri: vscode.Uri): boolean {
	const uri = tabUri(tab);
	const tabSourceUri = uri === undefined ? undefined : relatedUnitSourceUri(uri);
	return tabSourceUri !== undefined && sameFilePath(tabSourceUri.fsPath, sourceUri.fsPath);
}

/** 文件夹改名后需要按原视图类型重新打开的标签页种类。 */
type FolderTabKind = "code" | "contentPreview" | "designer" | "source" | "xmlPreview";

/** 返回一个已识别 Simple 标签的视图种类。 */
function unitTabKind(tab: vscode.Tab): FolderTabKind | undefined {
	const uri = tabUri(tab);
	if (uri === undefined) {
		return undefined;
	}
	if (tab.input instanceof vscode.TabInputCustom && tab.input.viewType === SIMPLE_DESIGNER_VIEW_TYPE) {
		return "designer";
	}
	if (uri.scheme === SIMPLE_CODE_SCHEME) {
		return "code";
	}
	if (uri.scheme === UNIT_CONTENT_PREVIEW_SCHEME) {
		return "contentPreview";
	}
	if (uri.scheme === UNIT_XML_PREVIEW_SCHEME) {
		return "xmlPreview";
	}
	return uri.scheme === "file" ? "source" : undefined;
}

/** 文件夹改名前记录的标签页类型和相对文件位置。 */
interface FolderTabBinding {
	readonly kind: FolderTabKind;
	readonly relativePath: string;
	readonly tab: vscode.Tab;
}

/** 记录目录改名后需要按新路径恢复的 Simple 标签页。 */
function folderTabBinding(tab: vscode.Tab, directoryPath: string): FolderTabBinding | undefined {
	const uri = tabUri(tab);
	const sourceUri = uri === undefined ? undefined : relatedUnitSourceUri(uri);
	if (
		uri === undefined
		|| sourceUri === undefined
		|| !isPathInside(directoryPath, sourceUri.fsPath)
	) {
		return undefined;
	}

	const kind = unitTabKind(tab);
	if (kind === undefined) {
		return undefined;
	}

	return {
		kind,
		relativePath: path.relative(directoryPath, sourceUri.fsPath),
		tab
	};
}

/** 按目标真实单元路径重新打开一种代码、设计器或预览标签。 */
async function reopenUnitTab(kind: FolderTabKind, sourceUri: vscode.Uri): Promise<void> {
	switch (kind) {
		case "code":
			await vscode.window.showTextDocument(
				await vscode.workspace.openTextDocument(toSimpleCodeUri(sourceUri)),
				{ preview: false }
			);
			break;
		case "contentPreview":
			await vscode.commands.executeCommand("vscode.open", toUnitContentPreviewUri(sourceUri), { preview: false });
			break;
		case "designer":
			await vscode.commands.executeCommand(
				"vscode.openWith",
				toSimpleDesignerUri(sourceUri),
				SIMPLE_DESIGNER_VIEW_TYPE,
				{ preview: false }
			);
			break;
		case "source":
			await vscode.commands.executeCommand("vscode.open", sourceUri, { preview: false });
			break;
		case "xmlPreview":
			await vscode.commands.executeCommand("vscode.open", toUnitXmlPreviewUri(sourceUri), { preview: false });
			break;
	}
}

/** 按目录改名后的真实路径恢复原有代码、设计器和预览标签。 */
async function reopenFolderTabs(bindings: readonly FolderTabBinding[], targetDirectoryPath: string): Promise<void> {
	const reopened = new Set<string>();
	for (const binding of bindings) {
		const sourceUri = vscode.Uri.file(path.join(targetDirectoryPath, binding.relativePath));
		const key = `${binding.kind}:${sourceUri.toString()}`;
		if (reopened.has(key)) {
			continue;
		}
		reopened.add(key);

		await reopenUnitTab(binding.kind, sourceUri);
	}
}

/** 关闭全部绑定指定真实单元的代码、设计器、预览及真实源码标签。 */
async function closeUnitTabs(sourceUri: vscode.Uri): Promise<boolean> {
	const tabs = vscode.window.tabGroups.all.flatMap(
		(group) => group.tabs.filter((tab) => tabMatchesUnit(tab, sourceUri))
	);
	return tabs.length === 0 || vscode.window.tabGroups.close(tabs, true);
}

/** 关闭真实目录内全部可识别标签；用户取消保存或关闭时中止目录操作。 */
async function closeFolderTabs(directoryPath: string): Promise<boolean> {
	const tabs = vscode.window.tabGroups.all.flatMap(
		(group) => group.tabs.filter((tab) => folderTabBinding(tab, directoryPath) !== undefined)
	);
	return tabs.length === 0 || vscode.window.tabGroups.close(tabs, true);
}

/** 执行项目树操作，并把失败原因留在当前扩展宿主中。 */
async function runAction(title: string, action: () => Promise<void>): Promise<void> {
	try {
		await action();
	} catch (error) {
		await vscode.window.showErrorMessage(`${title}失败：${errorMessage(error)}`);
	}
}

/** 判断节点是否为资源目录。 */
function isResourceFolderNode(node: ProgramTreeNode | undefined): node is DirectoryNode {
	return node?.kind === "directory" && node.mode === "resources";
}

/** 构建文件夹必须严格位于该项目构建目录内，不能删除“构建”根节点。 */
function isBuildFolderNode(node: ProgramTreeNode | undefined): node is DirectoryNode {
	return node?.kind === "directory"
		&& node.mode === "build"
		&& node.project !== undefined
		&& isPathInside(node.project.buildDirectory, node.directoryPath);
}

/** 判断节点是否可直接接收导入文件。 */
function isResourceImportTarget(node: ProgramTreeNode | undefined): node is DirectoryNode {
	return node?.kind === "assets"
		|| isResourceFolderNode(node);
}

/**
 * 根据右键节点确定新内容的物理目录；多源码根时由用户明确选择。
 *
 * @param node “单元”根节点或其下任意源码文件夹。
 * @returns 用户选中的源码目录；取消选择时返回 `undefined`。
 */
async function selectUnitDirectory(
	node: ProgramTreeNode | undefined,
	placeHolder = "该项目配置了多个源码目录，请选择新内容的保存位置。"
): Promise<string | undefined> {
	if (isUnitFolderNode(node)) {
		return node.directoryPath;
	}

	if (!isUnitsNode(node)) {
		await vscode.window.showErrorMessage("请在项目的“单元”节点或其下文件夹中执行此操作。");
		return undefined;
	}

	const sourceDirectories = node.project.sourceDirectories;

	if (sourceDirectories.length === 1) {
		return sourceDirectories[0];
	}

	if (sourceDirectories.length === 0) {
		await vscode.window.showErrorMessage("当前项目没有可用的源码目录配置。");
		return undefined;
	}

	const selection = await vscode.window.showQuickPick(
		sourceDirectories.map((directoryPath) => ({
			description: directoryPath,
			label: path.basename(directoryPath),
			directoryPath
		})),
		{
			placeHolder,
			title: "选择源码目录"
		}
	);

	return selection?.directoryPath;
}

/** 将单元粘贴目标解析为真实源码目录；粘贴到单元表示使用其同级目录。 */
async function selectUnitPasteDirectory(
	node: ProgramTreeNode | undefined
): Promise<DirectoryNode | undefined> {
	if (node?.kind === "unit" && node.project !== undefined) {
		const directoryPath = path.dirname(node.filePath);
		return {
			directoryPath,
			kind: "directory",
			label: path.basename(directoryPath),
			mode: "units",
			project: node.project
		};
	}
	const project = isUnitsNode(node)
		? node.project
		: isUnitFolderNode(node) ? node.project : undefined;

	const directoryPath = await selectUnitDirectory(
		node,
		"该项目配置了多个源码目录，请选择单元的粘贴位置。"
	);
	if (directoryPath === undefined || project === undefined) {
		return undefined;
	}
	return {
		directoryPath,
		kind: "directory",
		label: path.basename(directoryPath),
		mode: "units",
		project
	};
}

/** 在目标源码目录中创建指定类型的真实 `.simple` 文件。 */
async function createUnit(
	provider: ProgramTreeProvider,
	getSdk: () => Sdk | undefined,
	codeDocuments: UnitRelationServices["codeDocuments"],
	node: ProgramTreeNode | undefined,
	unitType: SimpleUnitType,
	requestedName?: string
): Promise<void> {
	const directoryPath = await selectUnitDirectory(node);

	if (directoryPath === undefined) {
		return;
	}

	const name = requestedName ?? await vscode.window.showInputBox({
		ignoreFocusOut: true,
		placeHolder: `例如：${unitType}1`,
		prompt: `输入新建${unitType}单元的名称，无需 .simple 后缀。`,
		title: `新建${unitType}单元`,
		validateInput: validateUnitName
	});

	if (name === undefined) {
		return;
	}
	const validationError = validateUnitName(name);
	if (validationError !== undefined) {
		throw new Error(validationError);
	}

	const directoryUri = vscode.Uri.file(directoryPath);
	const unitUri = vscode.Uri.file(path.join(directoryPath, `${name.trim()}.simple`));

	if (await workspacePathExists(unitUri)) {
		await vscode.window.showErrorMessage(`单元“${name.trim()}”已经存在。`);
		return;
	}

	const template = requireSdkTemplate(getSdk, UNIT_TEMPLATE_IDS[unitType]);
	const renderedTemplate = renderSdkTemplate(
		template,
		simpleUnitTemplateValues(unitType, name.trim())
	);
	const source = createSimpleUnitSourceFromTemplate(renderedTemplate, unitType);
	await vscode.workspace.fs.createDirectory(directoryUri);
	await vscode.workspace.fs.writeFile(
		unitUri,
		Buffer.from(source, "utf8")
	);
	codeDocuments.notifySourceCreated(unitUri);
	provider.refresh();
	await vscode.window.showTextDocument(toSimpleCodeUri(unitUri));
}

/** 项目目录名是物理路径段，复用文件系统约束。 */
function validateProjectDirectoryName(value: string): string | undefined {
	return validateUnitFolderName(value)?.replaceAll("文件夹", "项目目录");
}

/** 应用名称还会作为 APK 文件名，不能包含文件系统禁用字符。 */
function validateApplicationName(value: string): string | undefined {
	return validateUnitFolderName(value)?.replaceAll("文件夹", "应用");
}

/** Android 应用包名同时用于清单标识和本地源码目录。 */
function validatePackageName(value: string): string | undefined {
	const packageName = value.trim();
	if (packageName.length === 0) {
		return "请输入应用包名。";
	}

	const segments = packageName.split(".");
	if (segments.length < 2) {
		return "应用包名至少包含两段，例如 simple.app。";
	}
	if (segments.some((segment) => (
		!/^[A-Za-z][A-Za-z0-9_]*$/.test(segment)
		|| validateUnitFolderName(segment) !== undefined
	))) {
		return "应用包名的每段须以英文字母开头，只能包含英文字母、数字和下划线，且不能使用系统保留目录名。";
	}
	return undefined;
}

/** 仅从可直接作为 ASCII 包名段的项目目录名给出建议；其他名称由用户填写。 */
export function createDefaultPackageName(projectDirectoryName: string): string {
	const segment = projectDirectoryName.trim();
	if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(segment)) {
		return "";
	}
	const candidate = `simple.${segment.toLowerCase()}`;
	return validatePackageName(candidate) === undefined ? candidate : "";
}

/** 依次收集上级目录、项目目录名、应用包名和应用名称；确认完成前不创建文件。 */
async function requestCreateProject(): Promise<CreateProjectRequest | undefined> {
	const selectedDirectories = await vscode.window.showOpenDialog({
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
		defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
		openLabel: "选择保存位置",
		title: "选择新项目的上级文件夹"
	});
	const parentDirectory = selectedDirectories?.[0];
	if (parentDirectory === undefined) {
		return undefined;
	}

	const projectDirectoryName = await vscode.window.showInputBox({
		ignoreFocusOut: true,
		prompt: "输入新项目的文件夹名称。",
		title: "设置项目目录名",
		validateInput: validateProjectDirectoryName
	});
	if (projectDirectoryName === undefined) {
		return undefined;
	}

	const packageName = await vscode.window.showInputBox({
		ignoreFocusOut: true,
		placeHolder: "例如 com.example.app",
		prompt: "输入应用包名，同时作为主窗口所在包名。",
		title: "设置应用包名",
		validateInput: validatePackageName,
		value: createDefaultPackageName(projectDirectoryName)
	});
	if (packageName === undefined) {
		return undefined;
	}

	const projectName = await vscode.window.showInputBox({
		ignoreFocusOut: true,
		prompt: "输入应用显示名称，可与项目目录名不同。",
		title: "设置应用名称",
		validateInput: validateApplicationName,
		value: projectDirectoryName.trim()
	});
	if (projectName === undefined) {
		return undefined;
	}

	return {
		packageName: packageName.trim(),
		parentDirectory,
		projectDirectoryName: projectDirectoryName.trim(),
		projectName: projectName.trim()
	};
}

/** 按当前 SDK 模板创建 Simple 项目，加入项目列表并打开主窗口代码。 */
async function createProject(
	provider: ProgramTreeProvider,
	getSdk: () => Sdk | undefined,
	codeDocuments: UnitRelationServices["codeDocuments"],
	requested?: CreateProjectRequest
): Promise<string | undefined> {
	const request = requested ?? await requestCreateProject();
	if (request === undefined) {
		return undefined;
	}
	if (request.parentDirectory.scheme !== "file") {
		throw new Error("只能在本地文件夹中创建 Simple 项目。");
	}

	const projectDirectoryNameError = validateProjectDirectoryName(request.projectDirectoryName);
	if (projectDirectoryNameError !== undefined) throw new Error(projectDirectoryNameError);
	const projectNameError = validateApplicationName(request.projectName);
	if (projectNameError !== undefined) throw new Error(projectNameError);
	const packageNameError = validatePackageName(request.packageName);
	if (packageNameError !== undefined) throw new Error(packageNameError);

	const projectDirectoryName = request.projectDirectoryName.trim();
	const projectName = request.projectName.trim();
	const packageName = request.packageName.trim();
	const projectUri = vscode.Uri.joinPath(request.parentDirectory, projectDirectoryName);
	if (await workspacePathExists(projectUri)) {
		throw new Error(`项目目录“${projectUri.fsPath}”已经存在。`);
	}
	if (!await closeSimpleUnitTabsInDirectories([projectUri.fsPath])) {
		return undefined;
	}

	const projectTemplate = requireSdkTemplate(getSdk, "project");
	const mainTemplate = requireSdkTemplate(getSdk, "main");
	if (path.extname(mainTemplate.filePath).toLowerCase() !== ".simple") {
		throw new Error("当前 SDK 的 main 模板必须是 .simple 文件。");
	}
	const mainUnitName = path.basename(mainTemplate.filePath, path.extname(mainTemplate.filePath));
	const mainUnitNameError = validateUnitName(mainUnitName);
	if (mainUnitNameError !== undefined) {
		throw new Error("当前 SDK 的 main 模板文件名不能作为主窗口名称：" + mainUnitNameError);
	}

	const projectFile = vscode.Uri.joinPath(projectUri, "project.properties");
	const projectSource = renderSdkTemplate(projectTemplate, {
		"主窗口限定名": packageName + "." + mainUnitName,
		"应用名称": projectName
	});
	const project = createProjectInfo(
		projectFile.fsPath,
		parseProjectProperties(projectSource)
	);
	if (project.sourceDirectories.length === 0) {
		throw new Error("SDK 项目模板没有提供可用的 source 目录。");
	}
	const sourceDirectory = vscode.Uri.file(path.join(
		project.sourceDirectories[0] ?? "",
		...packageName.split(".")
	));
	const assetsDirectory = vscode.Uri.file(project.assetsDirectory);
	const resourceDirectory = vscode.Uri.file(project.resourceDirectory);
	const mainUnitFile = vscode.Uri.joinPath(sourceDirectory, `${mainUnitName}.simple`);
	const mainSource = createSimpleUnitSourceFromTemplate(
		renderSdkTemplate(mainTemplate, { "应用名称": projectName }),
		"窗口"
	);

	try {
		await vscode.workspace.fs.createDirectory(sourceDirectory);
		await vscode.workspace.fs.createDirectory(assetsDirectory);
		await vscode.workspace.fs.createDirectory(resourceDirectory);
		await vscode.workspace.fs.writeFile(projectFile, Buffer.from(projectSource, "utf8"));
		await vscode.workspace.fs.writeFile(
			mainUnitFile,
			Buffer.from(mainSource, "utf8")
		);
	} catch (error) {
		if (await workspacePathExists(projectUri)) {
			await vscode.workspace.fs.delete(projectUri, { recursive: true });
		}
		throw error;
	}

	codeDocuments.notifySourceCreated(mainUnitFile);
	if (!await provider.addProject(projectFile.fsPath)) {
		provider.refresh();
	}
	await vscode.window.showTextDocument(toSimpleCodeUri(mainUnitFile));
	if (requested === undefined) {
		await vscode.window.showInformationMessage(`已创建 ES4A 项目“${projectName}”。`);
	}
	return projectFile.fsPath;
}

/** 在“单元”根节点或任意单元文件夹下新建物理文件夹。 */
async function createUnitFolder(
	provider: ProgramTreeProvider,
	node: ProgramTreeNode | undefined
): Promise<void> {
	const directoryPath = await selectUnitDirectory(node);

	if (directoryPath === undefined) {
		return;
	}

	const name = await vscode.window.showInputBox({
		ignoreFocusOut: true,
		prompt: "输入单层文件夹名称。",
		title: "新建单元文件夹",
		validateInput: validateUnitFolderName
	});

	if (name === undefined) {
		return;
	}

	const folderUri = vscode.Uri.file(path.join(directoryPath, name.trim()));

	if (await workspacePathExists(folderUri)) {
		await vscode.window.showErrorMessage(`文件夹“${name.trim()}”已经存在。`);
		return;
	}

	await vscode.workspace.fs.createDirectory(folderUri);
	provider.refresh();
}

/** 将用户选择的本地文件复制到项目 Assets 根目录。 */
async function importResources(
	provider: ProgramTreeProvider,
	node: ProgramTreeNode | undefined,
	selectedFiles?: readonly vscode.Uri[]
): Promise<void> {
	if (!isResourceImportTarget(node)) {
		await vscode.window.showErrorMessage("请在项目的 Assets 节点或 Res 文件夹中执行“导入资源”。");
		return;
	}

	const sourceUris = selectedFiles ?? await vscode.window.showOpenDialog({
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: true,
		openLabel: "导入",
		title: "选择要导入的资源文件"
	});
	if (sourceUris === undefined || sourceUris.length === 0) {
		return;
	}

	const imports = await Promise.all(sourceUris.map(async (sourceUri) => {
		const stat = await vscode.workspace.fs.stat(sourceUri);
		if ((stat.type & vscode.FileType.File) === 0) {
			throw new Error(`“${sourceUri.fsPath}”不是普通文件。`);
		}
		return {
			name: path.basename(sourceUri.fsPath),
			sourceUri,
			targetUri: vscode.Uri.file(path.join(node.directoryPath, path.basename(sourceUri.fsPath)))
		};
	}));
	const names = new Set<string>();
	for (const item of imports) {
		const key = process.platform === "win32" ? item.name.toLowerCase() : item.name;
		if (names.has(key)) {
			throw new Error(`选择的文件中存在同名文件“${item.name}”。`);
		}
		names.add(key);
		if (await workspacePathExists(item.targetUri)) {
			throw new Error(`目标文件夹中已经存在“${item.name}”。`);
		}
	}

	await vscode.workspace.fs.createDirectory(vscode.Uri.file(node.directoryPath));
	for (const item of imports) {
		await vscode.workspace.fs.copy(item.sourceUri, item.targetUri, { overwrite: false });
	}
	provider.refresh();
}

/** 将 Assets 或 Res 下的普通文件另存到用户选择的位置。 */
async function exportResource(
	node: ProgramTreeNode | undefined,
	requestedTarget?: vscode.Uri
): Promise<void> {
	if (node?.kind !== "file" || node.buildOutput) {
		await vscode.window.showErrorMessage("请在资源文件上执行“导出资源”。");
		return;
	}

	const sourceUri = vscode.Uri.file(node.filePath);
	const targetUri = requestedTarget ?? await vscode.window.showSaveDialog({
		defaultUri: sourceUri,
		saveLabel: "导出",
		title: "导出资源"
	});
	if (targetUri === undefined || sameFilePath(sourceUri.fsPath, targetUri.fsPath)) {
		return;
	}

	await vscode.workspace.fs.copy(sourceUri, targetUri, { overwrite: true });
}

/** 将构建目录下的任意文件另存到用户选择的位置。 */
async function exportBuildFile(
	node: ProgramTreeNode | undefined,
	requestedTarget?: vscode.Uri
): Promise<void> {
	if (node?.kind !== "file" || !node.buildOutput) {
		await vscode.window.showErrorMessage("请在构建文件上执行“导出文件”。");
		return;
	}

	const sourceUri = vscode.Uri.file(node.filePath);
	const targetUri = requestedTarget ?? await vscode.window.showSaveDialog({
		defaultUri: sourceUri,
		saveLabel: "导出",
		title: "导出文件"
	});
	if (targetUri === undefined || sameFilePath(sourceUri.fsPath, targetUri.fsPath)) {
		return;
	}

	await vscode.workspace.fs.copy(sourceUri, targetUri, { overwrite: true });
}

/** 在 Assets 目录、Res 根目录或 Res 子文件夹中创建单层资源文件夹。 */
async function createResourceFolder(
	provider: ProgramTreeProvider,
	node: ProgramTreeNode | undefined,
	requestedName?: string
): Promise<void> {
	if (
		node?.kind !== "assets"
		&& node?.kind !== "res"
		&& !(
			node?.kind === "directory"
			&& node.mode === "resources"
			&& (node.resourceRoot === "assets" || node.resourceRoot === "res")
		)
	) {
		await vscode.window.showErrorMessage("请在项目的 Assets 目录、Res 节点或 Res 子文件夹中执行“新建文件夹”。");
		return;
	}

	const name = requestedName ?? await vscode.window.showInputBox({
		ignoreFocusOut: true,
		prompt: "输入单层文件夹名称。",
		title: "新建资源文件夹",
		validateInput: validateUnitFolderName
	});
	if (name === undefined) {
		return;
	}
	const validationError = validateUnitFolderName(name);
	if (validationError !== undefined) {
		throw new Error(validationError);
	}

	const trimmedName = name.trim();
	const folderUri = vscode.Uri.file(path.join(node.directoryPath, trimmedName));
	if (await workspacePathExists(folderUri)) {
		throw new Error(`文件夹“${trimmedName}”已经存在。`);
	}

	await vscode.workspace.fs.createDirectory(folderUri);
	provider.refresh();
}

/** 参考 VS Code 项目资源管理器，通过一个行内入口选择要创建的单元或文件夹。 */
async function showCreateQuickPick(
	provider: ProgramTreeProvider,
	getSdk: () => Sdk | undefined,
	codeDocuments: UnitRelationServices["codeDocuments"],
	node: ProgramTreeNode | undefined
): Promise<void> {
	if (!isUnitsNode(node) && !isUnitFolderNode(node)) {
		await vscode.window.showErrorMessage("请在项目的“单元”节点或其下文件夹中执行此操作。");
		return;
	}

	const selection = await vscode.window.showQuickPick<CreateQuickPickItem>([
		{ iconPath: simpleUnitIcon("窗口"), label: "窗口单元", target: "窗口" },
		{ iconPath: simpleUnitIcon("对象"), label: "对象单元", target: "对象" },
		{ iconPath: simpleUnitIcon("接口"), label: "接口单元", target: "接口" },
		{ iconPath: simpleUnitIcon("服务"), label: "服务单元", target: "服务" },
		{ kind: vscode.QuickPickItemKind.Separator, label: "" },
		{ iconPath: new vscode.ThemeIcon("folder"), label: "文件夹", target: "文件夹" }
	], {
		placeHolder: "选择要创建的类型。",
		title: "创建"
	});

	if (selection?.target === undefined) {
		return;
	}

	if (selection.target === "文件夹") {
		await createUnitFolder(provider, node);
		return;
	}

	await createUnit(provider, getSdk, codeDocuments, node, selection.target);
}

/** 重命名项目树中的真实文件夹，并迁移目录内已经打开的标签页。 */
async function renameTreeFolder(
	provider: ProgramTreeProvider,
	services: ProgramCommandServices,
	node: ProgramTreeNode | undefined,
	requestedName?: string
): Promise<void> {
	if (!isUnitFolderNode(node) && !isResourceFolderNode(node)) {
		await vscode.window.showErrorMessage("请在单元或资源节点下的文件夹上执行“重命名文件夹”。");
		return;
	}
	const folderKind = node.mode === "units" ? "单元" : "资源";
	const currentName = path.basename(node.directoryPath);

	const name = requestedName ?? await vscode.window.showInputBox({
		ignoreFocusOut: true,
		prompt: "输入新的单层文件夹名称。",
		title: `重命名${folderKind}文件夹`,
		validateInput: validateUnitFolderName,
		value: currentName,
		valueSelection: [0, currentName.length]
	});
	if (name === undefined) {
		return;
	}
	const validationError = validateUnitFolderName(name);
	if (validationError !== undefined) {
		throw new Error(validationError);
	}
	const trimmedName = name.trim();
	if (trimmedName === currentName) {
		return;
	}

	const sourceUri = vscode.Uri.file(node.directoryPath);
	const targetUri = vscode.Uri.file(path.join(path.dirname(node.directoryPath), trimmedName));
	if (await workspacePathExists(targetUri)) {
		throw new Error(`文件夹“${trimmedName}”已经存在。`);
	}
	if (!await closeFolderTabs(targetUri.fsPath)) {
		return;
	}

	const movedUnits = node.mode === "units"
		? (await listSimpleFiles(node.directoryPath)).map((filePath) => ({
			newUri: vscode.Uri.file(path.join(targetUri.fsPath, path.relative(node.directoryPath, filePath))),
			oldUri: vscode.Uri.file(filePath)
		}))
		: [];

	const dirtyDocument = vscode.workspace.textDocuments.find((document) => {
		const sourceDocumentUri = relatedUnitSourceUri(document.uri);
		return document.isDirty
			&& sourceDocumentUri !== undefined
			&& isPathInside(node.directoryPath, sourceDocumentUri.fsPath);
	});
	if (dirtyDocument !== undefined) {
		throw new Error("该文件夹内存在未保存的文件，请先保存或撤销后再重命名。");
	}

	const bindings = vscode.window.tabGroups.all.flatMap((group) => (
		group.tabs.map((tab) => folderTabBinding(tab, node.directoryPath))
			.filter((binding): binding is FolderTabBinding => binding !== undefined)
	));
	if (bindings.length > 0 && !await vscode.window.tabGroups.close(bindings.map((binding) => binding.tab), true)) {
		throw new Error("无法关闭该文件夹内使用旧路径的标签页。");
	}
	if (movedUnits.some(({ oldUri }) => services.codeDocuments.hasUnsavedChanges(oldUri))) {
		throw new Error("该文件夹内仍有未保存的单元，无法重命名。");
	}

	await vscode.workspace.fs.rename(sourceUri, targetUri, { overwrite: false });
	for (const { newUri, oldUri } of movedUnits) {
		services.codeDocuments.notifySourceMoved(oldUri, newUri);
		await services.moveDesignerSourceState(oldUri, newUri);
	}
	provider.refresh();
	await reopenFolderTabs(bindings, targetUri.fsPath);
}

/** 从 ES4A 项目列表移除项目，不触碰磁盘。 */
async function removeProject(provider: ProgramTreeProvider, node: ProgramTreeNode | undefined): Promise<void> {
	const projectFilePath = node?.kind === "project"
		? node.project.filePath
		: node?.kind === "error"
			? node.projectFilePath
			: undefined;
	if (projectFilePath === undefined) {
		await vscode.window.showErrorMessage("请在项目节点上执行“移除项目”。");
		return;
	}

	const sourceDirectories = node?.kind === "project"
		? node.project.sourceDirectories
		: [path.dirname(projectFilePath)];
	if (!await closeSimpleUnitTabsInDirectories(sourceDirectories)) {
		return;
	}
	await provider.removeProject(projectFilePath);
}

/** 在系统文件资源管理器中打开节点所在目录，并选中对应文件。 */
async function openProjectDirectory(node: ProgramTreeNode | undefined): Promise<void> {
	if (node?.kind === "directory") {
		await vscode.env.openExternal(vscode.Uri.file(node.directoryPath));
		return;
	}

	const filePath = node?.kind === "project"
		? node.project.filePath
		: node?.kind === "unit" || node?.kind === "file"
			? node.filePath
			: undefined;
	if (filePath === undefined) {
		await vscode.window.showErrorMessage("请在项目、单元或资源文件夹、单元文件或资源文件节点上执行“打开目录”。");
		return;
	}

	await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(filePath));
}

/** 在普通文本编辑器中打开真实项目属性文件。 */
async function openProjectProperties(node: ProgramTreeNode | undefined): Promise<void> {
	if (node?.kind !== "project") {
		await vscode.window.showErrorMessage("请在项目节点上执行“打开属性”。");
		return;
	}
	const document = await vscode.workspace.openTextDocument(vscode.Uri.file(node.project.filePath));
	await vscode.window.showTextDocument(document, { preview: false });
}

/** 在系统文件资源管理器中定位真实项目属性文件。 */
async function locateProjectProperties(node: ProgramTreeNode | undefined): Promise<void> {
	if (node?.kind !== "project") {
		await vscode.window.showErrorMessage("请在项目节点上执行“定位属性”。");
		return;
	}
	await openProjectDirectory(node);
}

/** 在系统文件资源管理器中定位项目树文件夹。 */
async function locateFolder(node: ProgramTreeNode | undefined): Promise<void> {
	const directoryPath = node?.kind === "units"
		? await selectUnitDirectory(node, "该项目配置了多个源码目录，请选择要定位的目录。")
		: node?.kind === "assets" || node?.kind === "build" || node?.kind === "directory" || node?.kind === "res"
			? node.directoryPath
			: undefined;
	if (directoryPath === undefined) {
		if (node?.kind === "units") {
			return;
		}
		throw new Error("请在文件夹节点上执行“定位文件夹”。");
	}
	if (
		(node?.kind === "assets" || node?.kind === "build" || node?.kind === "res" || isResourceFolderNode(node))
		&& !await workspacePathExists(vscode.Uri.file(directoryPath))
		&& node.project !== undefined
	) {
		await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(node.project.filePath));
		return;
	}
	await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(directoryPath));
}

/** 在系统文件资源管理器中定位真实 `.simple` 单元文件。 */
async function locateUnit(node: ProgramTreeNode | undefined): Promise<void> {
	if (node?.kind !== "unit") {
		throw new Error("请在单元文件上执行“定位单元”。");
	}
	await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(node.filePath));
}

/** 打开窗口或对象单元的预定义事件；缺失时通过普通代码编辑事务补到单元头部。 */
async function openUnitLifecycleEvent(
	node: FileNode,
	eventName: SimpleUnitLifecycleEventName
): Promise<void> {
	if (node.unitType !== "窗口" && node.unitType !== "对象") {
		throw new Error("载入和初始化事件只适用于窗口或对象单元。");
	}
	const document = await vscode.workspace.openTextDocument(
		toSimpleCodeUri(vscode.Uri.file(node.filePath))
	);
	const editor = await vscode.window.showTextDocument(document, { preview: false });
	const userCode = document.getText();
	const action = resolveSimpleUnitLifecycleEventAction(
		userCode,
		path.basename(node.filePath, path.extname(node.filePath)),
		eventName,
		document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n"
	);
	if (!action.existing) {
		if (action.insertionOffset === undefined || action.insertionText === undefined) {
			throw new Error("生命周期事件插入内容无效。");
		}
		const inserted = await editor.edit(
			(edit) => edit.insert(document.positionAt(action.insertionOffset!), action.insertionText!),
			{ undoStopAfter: true, undoStopBefore: true }
		);
		if (!inserted) throw new Error("无法修改当前用户代码文档。");
	}
	const position = document.positionAt(action.caretOffset);
	editor.selection = new vscode.Selection(position, position);
	editor.revealRange(
		new vscode.Range(position, position),
		vscode.TextEditorRevealType.InCenterIfOutsideViewport
	);
}

/** 在系统文件资源管理器中定位真实资源文件。 */
async function locateResourceFile(node: ProgramTreeNode | undefined): Promise<void> {
	if (node?.kind !== "file" || node.buildOutput) {
		throw new Error("请在资源文件上执行“定位文件”。");
	}
	await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(node.filePath));
}

/** 在系统文件资源管理器中定位真实构建文件。 */
async function locateBuildFile(node: ProgramTreeNode | undefined): Promise<void> {
	if (node?.kind !== "file" || !node.buildOutput) {
		throw new Error("请在构建文件上执行“定位文件”。");
	}
	await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(node.filePath));
}

/** 先尝试回收站；失败时只有再次确认才永久删除，取消时保留完整目录。 */
export async function deleteProjectDirectory(
	projectName: string,
	projectUri: vscode.Uri,
	deleteEntry: (
		uri: vscode.Uri,
		options: { readonly recursive: boolean; readonly useTrash: boolean }
	) => Thenable<void> = (uri, options) => vscode.workspace.fs.delete(uri, options),
	confirmPermanentDelete: (error: unknown) => Promise<boolean> = async (error) => {
		const fallbackAction = await vscode.window.showWarningMessage(
			`无法将项目“${projectName}”移至回收站，是否永久删除？`,
			{
				detail: `${errorMessage(error)}\n\n永久删除后无法恢复。`,
				modal: true
			},
			DELETE_PERMANENTLY
		);
		return fallbackAction === DELETE_PERMANENTLY;
	}
): Promise<boolean> {
	try {
		await deleteEntry(projectUri, {
			recursive: true,
			useTrash: true
		});
		return true;
	} catch (error) {
		if (!await confirmPermanentDelete(error)) {
			return false;
		}
		await deleteEntry(projectUri, {
			recursive: true,
			useTrash: false
		});
		return true;
	}
}

/** 确认后删除完整项目目录；回收站不可用时允许用户再次确认永久删除。 */
async function deleteProject(provider: ProgramTreeProvider, node: ProgramTreeNode | undefined): Promise<void> {
	if (node?.kind !== "project") {
		await vscode.window.showErrorMessage("请在项目节点上执行“删除项目”。");
		return;
	}

	const projectNode: ProjectNode = node;
	const action = await vscode.window.showWarningMessage(
		`确定删除项目“${projectNode.project.name}”吗？\n${projectNode.project.directory}`,
		{
			detail: "完整项目目录将移至系统回收站。",
			modal: true
		},
		MOVE_TO_TRASH
	);

	if (action !== MOVE_TO_TRASH) {
		return;
	}

	if (!await closeSimpleUnitTabsInDirectories(projectNode.project.sourceDirectories)) {
		return;
	}
	const projectUri = vscode.Uri.file(projectNode.project.directory);
	if (!await deleteProjectDirectory(projectNode.project.name, projectUri)) {
		return;
	}
	await provider.removeProject(projectNode.project.filePath);
}

/** 确认后把项目树中的物理文件夹及其内容移至系统回收站。 */
async function deleteTreeFolder(
	provider: ProgramTreeProvider,
	services: ProgramCommandServices,
	node: ProgramTreeNode | undefined,
	confirmed = false,
	useTrash = true
): Promise<void> {
	if (!isUnitFolderNode(node) && !isResourceFolderNode(node) && !isBuildFolderNode(node)) {
		await vscode.window.showErrorMessage("请在单元、资源或构建节点下的文件夹上执行“删除文件夹”。");
		return;
	}
	if (!confirmed) {
		const action = await vscode.window.showWarningMessage(
			`确定删除文件夹“${node.label}”及其全部内容吗？\n${node.directoryPath}`,
			{
				detail: "文件夹将移至系统回收站。",
				modal: true
			},
			MOVE_TO_TRASH
		);
		if (action !== MOVE_TO_TRASH) {
			return;
		}
	}
	const unitUris = node.mode === "units"
		? (await listSimpleFiles(node.directoryPath)).map((filePath) => vscode.Uri.file(filePath))
		: [];
	if (!await closeFolderTabs(node.directoryPath)) {
		return;
	}
	if (unitUris.some((sourceUri) => services.codeDocuments.hasUnsavedChanges(sourceUri))) {
		throw new Error("该文件夹内仍有未保存的单元，无法删除。");
	}

	await vscode.workspace.fs.delete(vscode.Uri.file(node.directoryPath), {
		recursive: true,
		useTrash
	});
	for (const sourceUri of unitUris) {
		services.codeDocuments.notifySourceDeleted(sourceUri);
		await services.deleteDesignerSourceState(sourceUri);
	}
	provider.refresh();
}

/** 确认后把一个真实 `.simple` 单元文件移至系统回收站。 */
async function deleteUnit(
	provider: ProgramTreeProvider,
	services: ProgramCommandServices,
	node: ProgramTreeNode | undefined,
	confirmed = false,
	useTrash = true
): Promise<void> {
	if (node?.kind !== "unit") {
		await vscode.window.showErrorMessage("请在单元文件上执行“删除单元”。");
		return;
	}

	if (!confirmed) {
		const action = await vscode.window.showWarningMessage(
			`确定删除单元文件“${node.label}.simple”吗？\n${node.filePath}`,
			{
				detail: "文件将移至系统回收站。",
				modal: true
			},
			MOVE_TO_TRASH
		);
		if (action !== MOVE_TO_TRASH) {
			return;
		}
	}
	const sourceUri = vscode.Uri.file(node.filePath);
	if (!await closeUnitTabs(sourceUri)) {
		return;
	}
	if (services.codeDocuments.hasUnsavedChanges(sourceUri)) {
		throw new Error("该单元仍有未保存修改，无法删除。");
	}

	await vscode.workspace.fs.delete(sourceUri, {
		useTrash
	});
	services.codeDocuments.notifySourceDeleted(sourceUri);
	await services.deleteDesignerSourceState(sourceUri);
	provider.refresh();
}

/** 确认后把资源树中的普通文件移至系统回收站。 */
async function deleteResourceFile(
	provider: ProgramTreeProvider,
	node: ProgramTreeNode | undefined
): Promise<void> {
	if (node?.kind !== "file" || node.buildOutput) {
		await vscode.window.showErrorMessage("请在资源文件上执行“删除文件”。");
		return;
	}

	const action = await vscode.window.showWarningMessage(
		`确定删除资源文件“${node.label}”吗？\n${node.filePath}`,
		{
			detail: "文件将移至系统回收站。",
			modal: true
		},
		MOVE_TO_TRASH
	);

	if (action !== MOVE_TO_TRASH) {
		return;
	}

	await vscode.workspace.fs.delete(vscode.Uri.file(node.filePath), {
		useTrash: true
	});
	provider.refresh();
}

/** 确认后把构建目录中的普通文件移至系统回收站。 */
async function deleteBuildFile(
	provider: ProgramTreeProvider,
	node: ProgramTreeNode | undefined
): Promise<void> {
	if (node?.kind !== "file" || !node.buildOutput) {
		await vscode.window.showErrorMessage("请在构建文件上执行“删除文件”。");
		return;
	}

	const action = await vscode.window.showWarningMessage(
		`确定删除构建文件“${node.label}”吗？\n${node.filePath}`,
		{
			detail: "文件将移至系统回收站。",
			modal: true
		},
		MOVE_TO_TRASH
	);

	if (action !== MOVE_TO_TRASH) {
		return;
	}

	await vscode.workspace.fs.delete(vscode.Uri.file(node.filePath), {
		useTrash: true
	});
	provider.refresh();
}

/** 重命名资源树中的普通文件，文件名输入包含原扩展名。 */
async function renameResourceFile(
	provider: ProgramTreeProvider,
	node: ProgramTreeNode | undefined,
	requestedName?: string
): Promise<void> {
	if (node?.kind !== "file") {
		await vscode.window.showErrorMessage("请在资源文件上执行“重命名文件名”。");
		return;
	}

	const name = requestedName ?? await vscode.window.showInputBox({
		ignoreFocusOut: true,
		prompt: "输入新的文件名，包含扩展名。",
		title: "重命名资源文件",
		validateInput: validateResourceFileName,
		value: node.label,
		valueSelection: [0, node.label.length]
	});
	if (name === undefined) {
		return;
	}
	const validationError = validateResourceFileName(name);
	if (validationError !== undefined) {
		throw new Error(validationError);
	}
	const trimmedName = name.trim();
	if (trimmedName === node.label) {
		return;
	}

	const sourceUri = vscode.Uri.file(node.filePath);
	const targetUri = vscode.Uri.file(path.join(path.dirname(node.filePath), trimmedName));
	if (await workspacePathExists(targetUri)) {
		throw new Error(`文件“${trimmedName}”已经存在。`);
	}

	const dirtyDocument = vscode.workspace.textDocuments.find((document) => (
		document.isDirty
		&& document.uri.scheme === "file"
		&& sameFilePath(document.uri.fsPath, sourceUri.fsPath)
	));
	if (dirtyDocument !== undefined) {
		throw new Error("该资源文件存在未保存修改，请先保存或撤销后再重命名。");
	}

	const relatedTabs = vscode.window.tabGroups.all.flatMap(
		(group) => group.tabs.filter((tab) => {
			const uri = tabUri(tab);
			return uri?.scheme === "file" && sameFilePath(uri.fsPath, sourceUri.fsPath);
		})
	);
	if (relatedTabs.length > 0 && !await vscode.window.tabGroups.close(relatedTabs, true)) {
		throw new Error("无法关闭该资源文件的旧路径标签页。");
	}

	await vscode.workspace.fs.rename(sourceUri, targetUri, { overwrite: false });
	provider.refresh();
	if (relatedTabs.length > 0) {
		await vscode.commands.executeCommand("vscode.open", targetUri, { preview: false });
	}
}

/** 窗口单元改名时，同步根组件名称及当前单元中的根组件引用。 */
async function renameWindowUnitRoot(
	services: UnitRelationServices,
	sourceUri: vscode.Uri,
	requestedName: string,
	save: boolean
): Promise<boolean> {
	const document = await vscode.workspace.openTextDocument(toSimpleCodeUri(sourceUri));
	await vscode.window.showTextDocument(document, { preserveFocus: true, preview: false });
	const property = services.codeDocuments.getProperty(document);
	const currentDocument = property?.document;
	if (property === undefined || currentDocument === undefined || property.status === "damaged") {
		throw new Error("当前窗口单元没有可修改的 XML 属性状态。");
	}

	const updated = renameSimpleComponent(
		document.getText(),
		currentDocument,
		"/属性/定义[1]",
		requestedName
	);
	if (updated.propertyDocument === currentDocument && updated.userCode === document.getText()) {
		return false;
	}
	await services.codeDocuments.applyPropertyEdit(
		document,
		currentDocument,
		updated.propertyDocument,
		updated.userCode
	);
	if (save && !await document.save()) {
		throw new Error("无法保存窗口单元名称修改。");
	}
	return true;
}

/** 按当前文件名同步窗口根组件名称，不主动保存用户文档。 */
async function syncUnitName(
	services: UnitRelationServices,
	node: ProgramTreeNode | undefined
): Promise<void> {
	if (node?.kind !== "unit" || node.unitType !== "窗口") {
		await vscode.window.showErrorMessage("请在窗口单元上执行“同步单元名”。");
		return;
	}

	const changed = await renameWindowUnitRoot(
		services,
		vscode.Uri.file(node.filePath),
		path.basename(node.filePath, path.extname(node.filePath)),
		false
	);
	if (!changed) {
		await vscode.window.showInformationMessage("单元名称与文件名一致。");
	}
}

/** 重命名真实 `.simple` 文件，并同步窗口根名称及迁移已打开标签页。 */
async function renameUnit(
	provider: ProgramTreeProvider,
	services: ProgramCommandServices,
	node: ProgramTreeNode | undefined,
	requestedName?: string
): Promise<void> {
	if (node?.kind !== "unit") {
		await vscode.window.showErrorMessage("请在单元文件上执行“重命名”。");
		return;
	}
	const sourceUri = vscode.Uri.file(node.filePath);
	if (!await workspacePathExists(sourceUri)) {
		return;
	}

	const name = requestedName ?? await vscode.window.showInputBox({
		ignoreFocusOut: true,
		prompt: "输入新的单元名称，无需 .simple 后缀。",
		title: "重命名单元",
		validateInput: validateUnitName,
		value: node.label,
		valueSelection: [0, node.label.length]
	});
	if (name === undefined) {
		return;
	}
	const validationError = validateUnitName(name);
	if (validationError !== undefined) {
		throw new Error(validationError);
	}
	const trimmedName = name.trim();
	if (trimmedName === node.label) {
		return;
	}

	const targetUri = vscode.Uri.file(path.join(path.dirname(node.filePath), `${trimmedName}.simple`));
	if (await workspacePathExists(targetUri)) {
		throw new Error(`单元“${trimmedName}”已经存在。`);
	}
	/* 目标真实文件虽不存在，VS Code 仍可能保留同路径的失效虚拟标签和会话。 */
	if (!await closeUnitTabs(targetUri)) {
		return;
	}
	if (services.codeDocuments.hasUnsavedChanges(targetUri)) {
		throw new Error("目标路径仍有未保存的旧单元文档，无法重命名。");
	}

	const dirtyDocument = vscode.workspace.textDocuments.find((document) => {
		const documentSourceUri = relatedUnitSourceUri(document.uri);
		return document.isDirty
			&& documentSourceUri !== undefined
			&& sameFilePath(documentSourceUri.fsPath, sourceUri.fsPath);
	});
	if (dirtyDocument !== undefined || services.codeDocuments.hasUnsavedChanges(sourceUri)) {
		throw new Error("该单元存在未保存修改，请先保存或撤销后再重命名。");
	}

	const relatedTabs = vscode.window.tabGroups.all.flatMap(
		(group) => group.tabs.filter((tab) => tabMatchesUnit(tab, sourceUri))
	);
	const reopenKinds = [...new Set(relatedTabs.flatMap((tab) => {
		const kind = unitTabKind(tab);
		return kind === undefined ? [] : [kind];
	}))];
	let originalSourceBytes: Uint8Array | undefined;
	let renamedSourceBytes: Uint8Array | undefined;
	if (node.unitType === "窗口") {
		originalSourceBytes = await vscode.workspace.fs.readFile(sourceUri);
		if (await renameWindowUnitRoot(services, sourceUri, trimmedName, true)) {
			renamedSourceBytes = await vscode.workspace.fs.readFile(sourceUri);
		}
	}

	try {
		const tabsToClose = vscode.window.tabGroups.all.flatMap(
			(group) => group.tabs.filter((tab) => tabMatchesUnit(tab, sourceUri))
		);
		if (tabsToClose.length > 0 && !await vscode.window.tabGroups.close(tabsToClose, true)) {
			throw new Error("无法关闭该单元的旧路径标签页。");
		}

		await vscode.workspace.fs.rename(sourceUri, targetUri, { overwrite: false });
	} catch (error) {
		if (originalSourceBytes !== undefined && renamedSourceBytes !== undefined) {
			try {
				const currentSourceBytes = await vscode.workspace.fs.readFile(sourceUri);
				if (!Buffer.from(currentSourceBytes).equals(Buffer.from(renamedSourceBytes))) {
					throw new Error("源文件内容在重命名期间再次发生变化，已停止自动恢复。");
				}
				await vscode.workspace.fs.writeFile(sourceUri, originalSourceBytes);
			} catch (rollbackError) {
				throw new Error(
					`物理文件重命名失败，且无法恢复窗口单元原内容：${errorMessage(rollbackError)}`,
					{ cause: error }
				);
			}
		}
		throw error;
	}
	services.codeDocuments.notifySourceMoved(sourceUri, targetUri);
	await services.moveDesignerSourceState(sourceUri, targetUri);
	provider.refresh();
	for (const kind of reopenKinds) {
		await reopenUnitTab(kind, targetUri);
	}
}

/** 以只读虚拟文档预览完整 `.simple` 单元内容。 */
async function previewUnitContent(node: ProgramTreeNode | undefined): Promise<void> {
	if (node?.kind !== "unit") {
		await vscode.window.showErrorMessage("请在单元文件上执行“内容预览”。");
		return;
	}

	const document = await vscode.workspace.openTextDocument(
		toUnitContentPreviewUri(vscode.Uri.file(node.filePath))
	);
	await vscode.window.showTextDocument(document, { preview: false });
}

/** 以只读 XML 虚拟文档预览单元属性元数据。 */
async function previewUnitXml(node: ProgramTreeNode | undefined): Promise<void> {
	if (node?.kind !== "unit") {
		await vscode.window.showErrorMessage("请在单元文件上执行“XML元数据”。");
		return;
	}

	const document = await vscode.workspace.openTextDocument(
		toUnitXmlPreviewUri(vscode.Uri.file(node.filePath))
	);
	await vscode.window.showTextDocument(document, { preview: false });
}

/**
 * 注册所有依赖项目树节点参数的命令。
 *
 * @param context 扩展生命周期上下文。
 * @param provider 当前项目 Tree View 的数据 Provider。
 * @param programView 当前项目树视图，用于解析快捷键触发时的选中节点。
 * @param relationServices 对象关系选择、解析和 XML 文档事务依赖。
 */
export function registerProgramCommands(
	context: vscode.ExtensionContext,
	provider: ProgramTreeProvider,
	programView: vscode.TreeView<ProgramTreeNode>,
	relationServices: ProgramCommandServices
): void {
	const unitRenameOperations = new KeyedTaskQueue();
	const selectedProgramNode = (node: ProgramTreeNode | undefined): ProgramTreeNode | undefined => (
		node ?? programView.selection[0]
	);
	const moveUnit = (source: FileNode, target: DirectoryNode): Promise<void> => runAction(
		"移动单元",
		() => moveUnitToDirectory(provider, relationServices, source, target)
	);
	provider.setUnitMoveHandler(moveUnit);
	const unitTransfer = new UnitTransferController(provider, relationServices);
	context.subscriptions.push(unitTransfer);
	const requireUnit = (node: ProgramTreeNode | undefined): FileNode => {
		if (node?.kind !== "unit") {
			throw new Error("请在单元文件上执行此操作。");
		}
		return node;
	};
	const pasteUnit = async (node: ProgramTreeNode | undefined): Promise<void> => {
		const target = await selectUnitPasteDirectory(selectedProgramNode(node));
		if (target !== undefined) {
			await unitTransfer.paste(target);
		}
	};
	const unitCommands: ReadonlyArray<readonly [string, SimpleUnitType]> = [
		["es4a.createWindowUnit", "窗口"],
		["es4a.createObjectUnit", "对象"],
		["es4a.createInterfaceUnit", "接口"],
		["es4a.createServiceUnit", "服务"]
	];

	for (const [command, unitType] of unitCommands) {
		context.subscriptions.push(vscode.commands.registerCommand(
			command,
			(node?: ProgramTreeNode) => runAction(
				`新建${unitType}单元`,
				() => createUnit(
					provider,
					relationServices.getSdk,
					relationServices.codeDocuments,
					node,
					unitType
				)
			)
		));
	}
	const projectPropertyCommands: ReadonlyArray<readonly [string, string, EditableProjectProperty]> = [
		["es4a.editProjectName", "应用名称", "name"],
		["es4a.editProjectVersionCode", "版本号", "version.code"],
		["es4a.editProjectVersionName", "版本名", "version.name"],
		["es4a.editProjectIcon", "应用图标", "icon"],
		["es4a.editProjectOrientation", "屏幕方向", "orientation"],
		["es4a.editProjectTheme", "应用主题", "theme"]
	];
	for (const [command, title, property] of projectPropertyCommands) {
		context.subscriptions.push(vscode.commands.registerCommand(
			command,
			(node?: ProgramTreeNode, requestedValue?: string) => runAction(
				`设置${title}`,
				() => editProjectProperty(
					provider,
					relationServices,
					selectedProgramNode(node),
					property,
					requestedValue
				)
			)
		));
	}
	context.subscriptions.push(vscode.commands.registerCommand(
		"es4a.editProjectManifestMacro",
		(node?: ProgramTreeNode, requestedKey?: string, requestedValue?: string) => runAction(
			"设置清单宏",
			() => editProjectManifestMacro(
				provider,
				relationServices,
				selectedProgramNode(node),
				requestedKey,
				requestedValue
			)
		)
	));
	const unitFolderCopyCommands = [
		["es4a.copyUnitFolderQualifiedName", "复制限定名", "qualifiedName"],
		["es4a.copyUnitFolderName", "复制文件夹名", "name"],
		["es4a.copyUnitFolderRelativePath", "复制相对路径", "relativePath"],
		["es4a.copyUnitFolderAbsolutePath", "复制绝对路径", "absolutePath"]
	] as const;
	for (const [command, title, mode] of unitFolderCopyCommands) {
		context.subscriptions.push(vscode.commands.registerCommand(
			command,
			(node?: ProgramTreeNode) => runAction(title, () => copyUnitFolderText(provider, node, mode))
		));
	}
	const resourceCopyCommands = [
		["es4a.copyResourceIndex", "复制索引名", "index"],
		["es4a.copyResourceFileName", "复制文件名", "name"],
		["es4a.copyResourceFolderName", "复制文件夹名", "name"],
		["es4a.copyResourceRelativePath", "复制相对路径", "relativePath"],
		["es4a.copyResourceAbsolutePath", "复制绝对路径", "absolutePath"]
	] as const;
	for (const [command, title, mode] of resourceCopyCommands) {
		context.subscriptions.push(vscode.commands.registerCommand(
			command,
			(node?: ProgramTreeNode) => runAction(title, () => copyResourceText(node, mode))
		));
	}
	const unitCopyCommands = [
		["es4a.copyUnitName", "复制单元名", "name"],
		["es4a.copyUnitQualifiedName", "复制限定名", "qualifiedName"],
		["es4a.copyUnitBaseObjectQualifiedName", "复制基础对象", "baseObject"],
		["es4a.copyUnitImplementedInterfacesQualifiedName", "复制实现接口", "interfaces"],
		["es4a.copyUnitRelativePath", "复制相对路径", "relativePath"],
		["es4a.copyUnitAbsolutePath", "复制绝对路径", "absolutePath"]
	] as const;
	for (const [command, title, mode] of unitCopyCommands) {
		context.subscriptions.push(vscode.commands.registerCommand(
			command,
			(target?: ProgramTreeNode | vscode.Uri) => runAction(
				title,
				() => copyUnitText(provider, relationServices, target, mode)
			)
		));
	}

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"es4a.createProject",
			() => runAction("创建项目", async () => {
				await createProject(provider, relationServices.getSdk, relationServices.codeDocuments);
			})
		),
		vscode.commands.registerCommand(
			"es4a.internal.createProject",
			(request: CreateProjectRequest) => createProject(
				provider,
				relationServices.getSdk,
				relationServices.codeDocuments,
				request
			)
		),
		vscode.commands.registerCommand(
			"es4a.createUnitItem",
			(node?: ProgramTreeNode) => runAction(
				"创建",
				() => showCreateQuickPick(
					provider,
					relationServices.getSdk,
					relationServices.codeDocuments,
					node
				)
			)
		),
		vscode.commands.registerCommand(
			"es4a.internal.createUnit",
			(node: ProgramTreeNode, unitType: SimpleUnitType, requestedName: string) => createUnit(
				provider,
				relationServices.getSdk,
				relationServices.codeDocuments,
				node,
				unitType,
				requestedName
			)
		),
		vscode.commands.registerCommand(
			"es4a.internal.moveUnitToFolder",
			(source: FileNode, target: DirectoryNode) => (
				moveUnitToDirectory(provider, relationServices, source, target)
			)
		),
		vscode.commands.registerCommand(
			"es4a.searchUnitCode",
			(node?: ProgramTreeNode) => runAction(
				"搜索代码",
				() => showProjectCodeSearch(node)
			)
		),
		vscode.commands.registerCommand(
			"es4a.copyUnit",
			(node?: ProgramTreeNode) => runAction(
				"复制单元",
				() => unitTransfer.copy(requireUnit(selectedProgramNode(node)))
			)
		),
		vscode.commands.registerCommand(
			"es4a.cutUnit",
			(node?: ProgramTreeNode) => runAction(
				"剪切单元",
				() => unitTransfer.cut(requireUnit(node))
			)
		),
		vscode.commands.registerCommand(
			"es4a.pasteUnit",
			(node?: ProgramTreeNode) => runAction("粘贴单元", () => pasteUnit(node))
		),
		vscode.commands.registerCommand(
			"es4a.internal.copyUnit",
			(node: FileNode) => unitTransfer.copy(node)
		),
		vscode.commands.registerCommand(
			"es4a.internal.cutUnit",
			(node: FileNode) => unitTransfer.cut(node)
		),
		vscode.commands.registerCommand(
			"es4a.internal.pasteUnit",
			(node: ProgramTreeNode) => pasteUnit(node)
		),
		vscode.commands.registerCommand(
			"es4a.setObjectRelation",
			(node?: ProgramTreeNode, requestedRelation?: "baseObject" | "interfaces") => runAction(
				"设置实现接口或基础对象",
				() => selectObjectRelation(provider, relationServices, node, requestedRelation)
			)
		),
		vscode.commands.registerCommand(
			"es4a.setBaseObject",
			(node?: ProgramTreeNode, requestedValue?: string | null) => runAction(
				"设置基础对象",
				() => selectBaseObject(provider, relationServices, node, requestedValue)
			)
		),
		vscode.commands.registerCommand(
			"es4a.setImplementedInterfaces",
			(node?: ProgramTreeNode, requestedValues?: readonly string[]) => runAction(
				"设置实现接口",
				() => selectImplementedInterfaces(provider, relationServices, node, requestedValues)
			)
		),
		vscode.commands.registerCommand(
			"es4a.createUnitFolder",
			(node?: ProgramTreeNode) => runAction("新建文件夹", () => createUnitFolder(provider, node))
		),
		vscode.commands.registerCommand(
			"es4a.importResource",
			(node?: ProgramTreeNode, selectedFiles?: readonly vscode.Uri[]) => runAction(
				"导入资源",
				() => importResources(provider, node, selectedFiles)
			)
		),
		vscode.commands.registerCommand(
			"es4a.exportResource",
			(node?: ProgramTreeNode, requestedTarget?: vscode.Uri) => runAction(
				"导出资源",
				() => exportResource(node, requestedTarget)
			)
		),
		vscode.commands.registerCommand(
			"es4a.createResourceFolder",
			(node?: ProgramTreeNode, requestedName?: string) => runAction(
				"新建文件夹",
				() => createResourceFolder(provider, node, requestedName)
			)
		),
		vscode.commands.registerCommand(
			"es4a.renameUnitFolder",
			(node?: ProgramTreeNode, requestedName?: string) => runAction(
				"重命名文件夹",
				() => renameTreeFolder(
					provider,
					relationServices,
					node,
					requestedName
				)
			)
		),
		vscode.commands.registerCommand(
			"es4a.openProjectProperties",
			(node?: ProgramTreeNode) => runAction("打开属性", () => openProjectProperties(node))
		),
		vscode.commands.registerCommand(
			"es4a.locateProjectProperties",
			(node?: ProgramTreeNode) => runAction("定位属性", () => locateProjectProperties(node))
		),
		vscode.commands.registerCommand(
			"es4a.openProjectDirectory",
			(node?: ProgramTreeNode) => runAction("打开目录", () => openProjectDirectory(node))
		),
		vscode.commands.registerCommand(
			"es4a.locateFolder",
			(node?: ProgramTreeNode) => runAction("定位文件夹", () => locateFolder(node))
		),
		vscode.commands.registerCommand(
			"es4a.openUnitLoadEvent",
			(node?: ProgramTreeNode) => runAction(
				"载入事件",
				() => openUnitLifecycleEvent(
					requireUnit(selectedProgramNode(node)),
					"加载"
				)
			)
		),
		vscode.commands.registerCommand(
			"es4a.openUnitInitializeEvent",
			(node?: ProgramTreeNode) => runAction(
				"初始化事件",
				() => openUnitLifecycleEvent(
					requireUnit(selectedProgramNode(node)),
					"初始化"
				)
			)
		),
		vscode.commands.registerCommand(
			"es4a.locateUnitFile",
			(node?: ProgramTreeNode) => runAction("定位单元", () => locateUnit(node))
		),
		vscode.commands.registerCommand(
			"es4a.locateResourceFile",
			(node?: ProgramTreeNode) => runAction("定位文件", () => locateResourceFile(node))
		),
		vscode.commands.registerCommand(
			"es4a.exportBuildFile",
			(node?: ProgramTreeNode, requestedTarget?: vscode.Uri) => runAction(
				"导出文件",
				() => exportBuildFile(node, requestedTarget)
			)
		),
		vscode.commands.registerCommand(
			"es4a.locateBuildFile",
			(node?: ProgramTreeNode) => runAction("定位文件", () => locateBuildFile(node))
		),
		vscode.commands.registerCommand(
			"es4a.removeProject",
			(node?: ProgramTreeNode) => runAction("移除项目", () => removeProject(provider, node))
		),
		vscode.commands.registerCommand(
			"es4a.deleteProject",
			(node?: ProgramTreeNode) => runAction("删除项目", () => deleteProject(provider, node))
		),
		vscode.commands.registerCommand(
			"es4a.deleteUnitFolder",
			(node?: ProgramTreeNode) => runAction(
				"删除文件夹",
				() => deleteTreeFolder(provider, relationServices, node)
			)
		),
		vscode.commands.registerCommand(
			"es4a.renameUnitFile",
			(node?: ProgramTreeNode, requestedName?: string) => {
				const target = selectedProgramNode(node);
				const queueKey = target?.kind === "unit"
					? filePathKey(target.project?.filePath ?? path.dirname(target.filePath))
					: "invalid-unit-rename";
				return runAction(
					"重命名单元",
					() => unitRenameOperations.run(
						queueKey,
						() => renameUnit(provider, relationServices, target, requestedName)
					)
				);
			}
		),
		vscode.commands.registerCommand(
			"es4a.syncUnitFileName",
			(node?: ProgramTreeNode) => runAction(
				"同步单元名",
				() => syncUnitName(relationServices, node)
			)
		),
		vscode.commands.registerCommand(
			"es4a.deleteUnitFile",
			(node?: ProgramTreeNode) => runAction(
				"删除单元",
				() => deleteUnit(provider, relationServices, node)
			)
		),
		vscode.commands.registerCommand(
			"es4a.internal.deleteUnitFile",
			(node: ProgramTreeNode) => deleteUnit(provider, relationServices, node, true, false)
		),
		vscode.commands.registerCommand(
			"es4a.internal.deleteUnitFolder",
			(node: ProgramTreeNode) => deleteTreeFolder(provider, relationServices, node, true, false)
		),
		vscode.commands.registerCommand(
			"es4a.renameResourceFile",
			(node?: ProgramTreeNode, requestedName?: string) => runAction(
				"重命名资源文件",
				() => renameResourceFile(provider, node, requestedName)
			)
		),
		vscode.commands.registerCommand(
			"es4a.deleteResourceFile",
			(node?: ProgramTreeNode) => runAction("删除资源文件", () => deleteResourceFile(provider, node))
		),
		vscode.commands.registerCommand(
			"es4a.deleteBuildFile",
			(node?: ProgramTreeNode) => runAction("删除构建文件", () => deleteBuildFile(provider, node))
		),
		vscode.commands.registerCommand(
			"es4a.previewUnitContent",
			(node?: ProgramTreeNode) => runAction("预览单元内容", () => previewUnitContent(node))
		),
		vscode.commands.registerCommand(
			"es4a.previewUnitXml",
			(node?: ProgramTreeNode) => runAction("预览 XML元数据", () => previewUnitXml(node))
		)
	);
}
