/*
激活 ES4A 扩展，并装配语言能力、项目与类库视图、设计器、命令及 SDK 生命周期。
xhwsd@qq.com 2026-8-29
*/

import * as path from "node:path";
import * as vscode from "vscode";
import { findSdkManifest, loadSdk, type Sdk } from "./sdk";
import {
	SIMPLE_COMPLETION_TRIGGER_CHARACTERS,
	SimpleCompletionProvider
} from "./completionProvider";
import { SimpleHoverProvider } from "./hoverProvider";
import { SimpleDefinitionProvider } from "./definitionProvider";
import { SIMPLE_SEMANTIC_TOKENS_LEGEND, SimpleSemanticTokensProvider } from "./semanticTokens";
import { SimpleSignatureHelpProvider } from "./signatureHelp";
import { LibraryTreeProvider } from "./libraryTree";
import { registerLibraryCommands } from "./libraryCommands";
import { isLibrarySymbolTarget } from "./librarySymbol";
import { ProgramTreeProvider, type FileNode, type ProgramTreeNode } from "./programTree";
import {
	createProgramProjectState,
	type ProgramWorkspaceConfiguration
} from "./programProjectPersistence";
import { ProgramTreeExpansionController } from "./programTreeExpansion";
import { ProgramRevealController } from "./programReveal";
import {
	SIMPLE_DESIGNER_VIEW_TYPE,
	SimpleDesignerProvider
} from "./designerWebview";
import { createDesignerPreferenceState } from "./designerPreferencePersistence";
import { updateWorkspaceConfigurationJsonc } from "./workspaceConfigurationFile";
import { registerProgramCommands } from "./programCommands";
import {
	registerSdkCapabilityCommands,
	updateSdkCapabilityContexts
} from "./sdkCapabilityCommands";
import { ProjectSymbolIndex } from "./projectSymbolIndex";
import { ProjectSemanticSyncController } from "./projectSemanticSync";
import {
	SIMPLE_CODE_SCHEME,
	SimpleCodeFileSystemProvider,
	toSimpleDesignerUri,
	toSimpleSourceUri
} from "./simpleCodeFileSystem";
import {
	UNIT_CONTENT_PREVIEW_SCHEME,
	UNIT_XML_PREVIEW_SCHEME,
	UnitPreviewProvider,
	toUnitPreviewSourceUri
} from "./unitPreview";
import { SimplePunctuationNormalizer } from "./punctuationNormalizer";
import { SimpleCodeDocumentRecovery } from "./simpleCodeDocumentRecovery";
import { filePathKey, sameFilePath } from "./simpleProjectPaths";
import { findProjectForSource } from "./projectCapability";
import {
	closeSimpleUnitTabsInDirectories,
	moveSimpleUnitPreviewTabs,
	reconcileSimpleUnitTabs,
	resolveSimpleUnitTab
} from "./simpleUnitTabs";
import { OpenUnitSemantics } from "./openUnitSemantics";

let simpleCodeDocumentRecovery: SimpleCodeDocumentRecovery | undefined;
let workspaceConfigurationWriteQueue: Promise<void> = Promise.resolve();

/**
 * 将用户代码、真实源码和两个只读预览标签统一解析为所属真实 Simple 单元。
 *
 * @param document 当前活动文档。
 * @returns 真实 `.simple` 文件 URI；文档不属于 Simple 单元时返回 `undefined`。
 */
export function resolveActiveUnitSourceUri(
	document: Pick<vscode.TextDocument, "languageId" | "uri"> | undefined
): vscode.Uri | undefined {
	if (document === undefined) {
		return undefined;
	}

	const previewSourceUri = toUnitPreviewSourceUri(document.uri);
	if (previewSourceUri !== undefined) {
		return previewSourceUri;
	}

	const sourceUri = toSimpleSourceUri(document.uri);
	return document.languageId === "simple"
		&& sourceUri !== undefined
		&& path.extname(sourceUri.fsPath).toLowerCase() === ".simple"
		? sourceUri
		: undefined;
}

/** 将当前活动的设计器标签解析为所属真实 Simple 单元。 */
export function resolveDesignerTabSourceUri(
	tab: Pick<vscode.Tab, "input"> | undefined
): vscode.Uri | undefined {
	const input = tab?.input;
	if (!(input instanceof vscode.TabInputCustom) || input.viewType !== SIMPLE_DESIGNER_VIEW_TYPE) {
		return undefined;
	}
	const sourceUri = toSimpleSourceUri(input.uri);
	return sourceUri !== undefined && path.extname(sourceUri.fsPath).toLowerCase() === ".simple"
		? sourceUri
		: undefined;
}

/** 加载用户明确选择的 SDK；没有配置或路径失效时保持未加载状态。 */
export async function loadConfiguredSdk(): Promise<Sdk | undefined> {
	const configuredPath = vscode.workspace.getConfiguration("es4a").get<string>("sdk.path")?.trim();
	if (configuredPath === undefined || configuredPath.length === 0) {
		return undefined;
	}

	const sdkFile = await findSdkManifest(configuredPath);
	return sdkFile === undefined ? undefined : loadSdk(sdkFile);
}

/**
 * 打开 SDK 入口选择器，并将完整文件路径保存到全局扩展设置。
 *
 * @returns 用户成功选择本地 JSON 文件时返回 `true`；取消或无效时返回 `false`。
 */
async function selectSdkManifest(): Promise<boolean> {
	const selection = await vscode.window.showOpenDialog({
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: false,
		filters: {
			"SDK 入口文件": ["json"]
		},
		openLabel: "选择 SDK 入口",
		title: "选择 SDK 入口文件"
	});
	const selected = selection?.[0];

	if (selected === undefined) {
		return false;
	}

	if (selected.scheme !== "file") {
		await vscode.window.showErrorMessage("请选择本地 SDK 入口文件。");
		return false;
	}

	await vscode.workspace.getConfiguration("es4a").update(
		"sdk.path",
		path.resolve(selected.fsPath),
		vscode.ConfigurationTarget.Global
	);
	return true;
}

/**
 * 打开 Simple 项目配置选择器。
 *
 * @returns 用户选择的本地 `project.properties` 文件；取消时返回空数组。
 */
async function selectProjectFiles(): Promise<readonly vscode.Uri[]> {
	return await vscode.window.showOpenDialog({
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: true,
		defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
		filters: {
			"Simple 项目配置": ["properties"]
		},
		openLabel: "添加项目",
		title: "选择 project.properties"
	}) ?? [];
}

/** 当前 VS Code 窗口中可供 ES4A 工作区配置复用的路径上下文。 */
interface WorkspaceConfigurationContext {
	readonly available: boolean;
	readonly baseDirectory?: string;
	readonly configurationDirectory?: vscode.Uri;
	readonly configurationFile?: vscode.Uri;
	readonly configurationPropertyPrefix: readonly string[];
}

/** 解析工作区文件、单文件夹和未命名工作区的共同配置上下文。 */
function workspaceConfigurationContext(): WorkspaceConfigurationContext {
	const workspaceFile = vscode.workspace.workspaceFile;
	const workspaceFolders = vscode.workspace.workspaceFolders;
	const singleFolder = workspaceFile === undefined && workspaceFolders?.length === 1
		? workspaceFolders[0]
		: undefined;
	const baseDirectory = workspaceFile?.scheme === "file"
		? path.dirname(workspaceFile.fsPath)
		: singleFolder?.uri.scheme === "file"
			? singleFolder.uri.fsPath
			: undefined;
	const settingsDirectory = singleFolder === undefined
		? undefined
		: vscode.Uri.joinPath(singleFolder.uri, ".vscode");
	return {
		available: workspaceFile !== undefined || (workspaceFolders?.length ?? 0) > 0,
		baseDirectory,
		configurationDirectory: settingsDirectory,
		configurationFile: workspaceFile?.scheme === "file"
			? workspaceFile
			: settingsDirectory === undefined
				? undefined
				: vscode.Uri.joinPath(settingsDirectory, "settings.json"),
		configurationPropertyPrefix: workspaceFile?.scheme === "file" ? ["settings"] : []
	};
}

/** 对可定位的工作区文件执行一次保留注释的完整 JSONC 写入。 */
async function updateWorkspaceConfigurationFile(
	context: WorkspaceConfigurationContext,
	key: string,
	value: unknown
): Promise<boolean> {
	const configurationFile = context.configurationFile;
	if (configurationFile === undefined) return false;

	let source: string;
	try {
		source = Buffer.from(await vscode.workspace.fs.readFile(configurationFile)).toString("utf8");
	} catch (error) {
		if (
			context.configurationDirectory === undefined
			|| !(error instanceof vscode.FileSystemError)
			|| error.code !== "FileNotFound"
		) {
			throw error;
		}
		await vscode.workspace.fs.createDirectory(context.configurationDirectory);
		source = "{\r\n}\r\n";
	}

	const updated = updateWorkspaceConfigurationJsonc(
		source,
		[...context.configurationPropertyPrefix, key],
		value
	);
	if (updated !== source) {
		const temporaryFile = configurationFile.with({
			path: `${configurationFile.path}.es4a-${process.pid}-${Date.now()}.tmp`
		});
		try {
			await vscode.workspace.fs.writeFile(temporaryFile, new TextEncoder().encode(updated));
			await vscode.workspace.fs.rename(temporaryFile, configurationFile, { overwrite: true });
		} finally {
			try {
				await vscode.workspace.fs.delete(temporaryFile);
			} catch {
				// 替换成功后临时文件已经不存在；失败时这里只做尽力清理。
			}
		}
	}
	return true;
}

/** 串行写入同一个工作区文件；未命名工作区回退到 VS Code 配置 API。 */
function enqueueWorkspaceConfigurationUpdate(
	context: WorkspaceConfigurationContext,
	key: string,
	value: unknown,
	updateUntitledWorkspace: () => Thenable<void>
): Promise<void> {
	const task = workspaceConfigurationWriteQueue.then(async () => {
		if (await updateWorkspaceConfigurationFile(context, key, value)) return;
		await updateUntitledWorkspace();
	});
	workspaceConfigurationWriteQueue = task.catch(() => undefined);
	return task;
}

/** 把当前 VS Code 工作区适配为 ES4A 项目列表的配置边界。 */
function programWorkspaceConfiguration(): ProgramWorkspaceConfiguration {
	const context = workspaceConfigurationContext();
	const configuration = vscode.workspace.getConfiguration("es4a");

	return {
		available: context.available,
		baseDirectory: context.baseDirectory,
		read: () => configuration.inspect<unknown>("projects")?.workspaceValue,
		update: (projects) => enqueueWorkspaceConfigurationUpdate(
			context,
			"es4a.projects",
			projects,
			() => configuration.update(
				"projects",
				projects,
				vscode.ConfigurationTarget.Workspace
			)
		)
	};
}

/**
 * 激活 ES4A 扩展并注册语言能力、类库视图和用户命令。
 *
 * @param context VS Code 提供的扩展生命周期上下文。
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const output = vscode.window.createOutputChannel("ES4A");
	simpleCodeDocumentRecovery = new SimpleCodeDocumentRecovery(context.workspaceState);
	let restoringWorkbenchUnitTabs = true;
	let scheduleUnitTabReconcile = (): void => undefined;
	/** 后台恢复目标用户代码，不让兜底恢复阻塞扩展激活和普通文档加载。 */
	const restoreSimpleCodeDocument = async (document: vscode.TextDocument): Promise<void> => {
		if (document.uri.scheme !== SIMPLE_CODE_SCHEME) {
			return;
		}
		try {
			await simpleCodeDocumentRecovery?.restore(document);
		} catch (error) {
			output.appendLine(`恢复未保存用户代码失败：${String(error)}`);
		} finally {
			if (restoringWorkbenchUnitTabs) {
				scheduleUnitTabReconcile();
			}
		}
	};
	/** 文档打开后只触发一次非阻塞恢复，设计器继续共享该标准文档。 */
	const simpleCodeRecoveryOpenListener = vscode.workspace.onDidOpenTextDocument(
		(document) => void restoreSimpleCodeDocument(document)
	);
	const simpleCodeFileSystemProvider = new SimpleCodeFileSystemProvider();
	const unitPreviewProvider = new UnitPreviewProvider(
		(sourceUri) => simpleCodeFileSystemProvider.getBoundPreview(sourceUri)
	);
	const projectSymbols = new ProjectSymbolIndex();
	const openUnitSemantics = new OpenUnitSemantics(
		simpleCodeFileSystemProvider,
		projectSymbols,
		(uri) => unitPreviewProvider.resolveSourceUri(uri)
	);
	for (const document of vscode.workspace.textDocuments) {
		openUnitSemantics.track(document);
	}
	/** 语言 Provider 读取当前虚拟文档；代码标签仅含用户代码，完整代码标签含整个单元。 */
	const readSimpleSource = (document: vscode.TextDocument): string => document.getText();
	const readSemanticContext = (document: vscode.TextDocument, source: string) => (
		openUnitSemantics.contextForDocument(document, source)
	);
	const completionProvider = new SimpleCompletionProvider(readSimpleSource, readSemanticContext);
	const hoverProvider = new SimpleHoverProvider(readSimpleSource, readSemanticContext);
	const definitionProvider = new SimpleDefinitionProvider(readSimpleSource, readSemanticContext);
	const semanticTokensProvider = new SimpleSemanticTokensProvider(readSimpleSource, readSemanticContext);
	const signatureHelpProvider = new SimpleSignatureHelpProvider(readSimpleSource, readSemanticContext);
	/* 设计器恢复依赖共享的虚拟文档协议，必须先注册协议再注册自定义编辑器。 */
	const simpleCodeFileSystemRegistration = vscode.workspace.registerFileSystemProvider(
		SIMPLE_CODE_SCHEME,
		simpleCodeFileSystemProvider,
		{
			isCaseSensitive: process.platform !== "win32",
			isReadonly: false
		}
	);
	const unitContentPreviewRegistration = vscode.workspace.registerTextDocumentContentProvider(
		UNIT_CONTENT_PREVIEW_SCHEME,
		unitPreviewProvider
	);
	const unitXmlPreviewRegistration = vscode.workspace.registerTextDocumentContentProvider(
		UNIT_XML_PREVIEW_SCHEME,
		unitPreviewProvider
	);
	const programProjectState = await createProgramProjectState(
		programWorkspaceConfiguration()
	);
	const designerPreferenceState = createDesignerPreferenceState(programProjectState);
	const designerProvider = new SimpleDesignerProvider(
		simpleCodeFileSystemProvider,
		context.extensionUri,
		designerPreferenceState,
		readSemanticContext
	);
	const designerRegistration = vscode.window.registerCustomEditorProvider(
		SIMPLE_DESIGNER_VIEW_TYPE,
		designerProvider,
		{
			supportsMultipleEditorsPerDocument: true,
			webviewOptions: { retainContextWhenHidden: true }
		}
	);
	const punctuationNormalizer = new SimplePunctuationNormalizer();
	const programProvider = new ProgramTreeProvider(
		programProjectState,
		(filePath) => openUnitSemantics.metadataForFile(filePath)
	);
	const projectSemantics = new ProjectSemanticSyncController(
		programProvider,
		projectSymbols,
		() => semanticTokensProvider.refresh(),
		(message) => output.appendLine(message)
	);
	let sdkSelectionInProgress = false;
	let sdkLoadTask: Promise<Sdk | undefined> | undefined;
	let activeSdk: Sdk | undefined;
	let activeSdkFailure: unknown;
	const sdkConsumers: readonly { updateSdk(sdk: Sdk | undefined): void }[] = [
		completionProvider,
		hoverProvider,
		definitionProvider,
		semanticTokensProvider,
		signatureHelpProvider,
		designerProvider
	];
	const applySdkState = async (sdk: Sdk | undefined, failure?: unknown): Promise<void> => {
		activeSdk = sdk;
		activeSdkFailure = failure;
		for (const consumer of sdkConsumers) {
			consumer.updateSdk(sdk);
		}
		await updateSdkCapabilityContexts(sdk);
	};
	const editableLanguageDocumentSelector: vscode.DocumentSelector = [
		{ language: "simple", scheme: SIMPLE_CODE_SCHEME },
		{ language: "simple", scheme: "untitled" }
	];
	const readableLanguageDocumentSelector: vscode.DocumentSelector = [
		...editableLanguageDocumentSelector,
		{ language: "simple-full-preview", scheme: UNIT_CONTENT_PREVIEW_SCHEME }
	];

	/**
	 * SDK 刷新时同步更新所有消费者，避免各语言能力读取到不同版本的清单。
	 *
	 * @returns 最新 SDK；没有有效入口时返回 `undefined`。
	 */
	const loadSdkAndUpdateTokens = (): Promise<Sdk | undefined> => {
		if (sdkLoadTask !== undefined) {
			return sdkLoadTask;
		}
		const task = (async (): Promise<Sdk | undefined> => {
			try {
				const sdk = await loadConfiguredSdk();
				await applySdkState(sdk);
				return sdk;
			} catch (error) {
				await applySdkState(undefined, error);
				throw error;
			}
		})();
		sdkLoadTask = task;
		const clearTask = (): void => {
			if (sdkLoadTask === task) {
				sdkLoadTask = undefined;
			}
		};
		void task.then(clearTask, clearTask);
		return task;
	};
	const completionRegistration = vscode.languages.registerCompletionItemProvider(
		editableLanguageDocumentSelector,
		completionProvider,
		...SIMPLE_COMPLETION_TRIGGER_CHARACTERS
	);
	const hoverRegistration = vscode.languages.registerHoverProvider(
		readableLanguageDocumentSelector,
		hoverProvider
	);
	const semanticTokensRegistration = vscode.languages.registerDocumentSemanticTokensProvider(
		readableLanguageDocumentSelector,
		semanticTokensProvider,
		SIMPLE_SEMANTIC_TOKENS_LEGEND
	);
	const signatureHelpRegistration = vscode.languages.registerSignatureHelpProvider(
		editableLanguageDocumentSelector,
		signatureHelpProvider,
		"(",
		","
	);
	const libraryProvider = new LibraryTreeProvider(async () => {
		if (activeSdkFailure !== undefined) {
			throw activeSdkFailure;
		}
		return activeSdk;
	});
	const libraryView = vscode.window.createTreeView("es4a.libraries", {
		showCollapseAll: true,
		treeDataProvider: libraryProvider
	});
	registerLibraryCommands(context);
	/** 类库视图展开时才从当前内存 SDK 构建树，折叠状态不创建类库节点。 */
	const libraryViewVisibilityListener = libraryView.onDidChangeVisibility((event) => {
		if (event.visible) {
			void libraryProvider.ensureLoaded();
		}
	});
	const goToDefinitionCommand = vscode.commands.registerCommand(
		"es4a.goToDefinition",
		async () => {
			const editor = vscode.window.activeTextEditor;
			if (editor === undefined) return;
			/* 首次调用必须等待激活阶段已经启动的后台数据加载，不能让用户靠重复操作碰运气。 */
			await projectSemantics.wait().catch(() => undefined);
			await sdkLoadTask?.catch(() => undefined);
			const target = definitionProvider.targetAt(editor.document, editor.selection.active);
			if (target === undefined) {
				vscode.window.setStatusBarMessage("当前位置没有可转到的定义。", 2000);
				return;
			}
			if (target?.librarySymbol !== undefined) {
				await vscode.commands.executeCommand("es4a.revealLibrarySymbol", target.librarySymbol);
				return;
			}
			if (target.resourceSource === true && target.filePath !== undefined) {
				/* 资源定义使用 VS Code 自身的文件打开方式，并同步选中项目树中的真实文件。 */
				await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(target.filePath));
				const resource = await programProvider.findResourceByFilePath(target.filePath);
				if (resource !== undefined) {
					await programTreeExpansion.revealResource(resource);
				}
				return;
			}
			const location = await definitionProvider.locationForTarget(target);
			if (location === undefined) {
				vscode.window.setStatusBarMessage("当前位置没有可转到的定义。", 2000);
				return;
			}
			const targetEditor = await vscode.window.showTextDocument(location.uri, { preview: true });
			targetEditor.selection = new vscode.Selection(location.range.start, location.range.end);
			targetEditor.revealRange(location.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
		}
	);
	const revealLibrarySymbolCommand = vscode.commands.registerCommand(
		"es4a.revealLibrarySymbol",
		async (target: unknown) => {
			const editor = vscode.window.activeTextEditor;
			const resolvedTarget = isLibrarySymbolTarget(target)
				? target
				: editor?.document.languageId === "simple"
					? definitionProvider.librarySymbolAt(editor.document, editor.selection.active)
					: undefined;
			if (resolvedTarget === undefined) return;
			const node = await libraryProvider.findSymbol(resolvedTarget);
			if (node === undefined) {
				await vscode.window.showWarningMessage("没有找到对应的类库节点。");
				return;
			}
			await libraryView.reveal(node, {
				focus: true,
				select: true
			});
		}
	);
	const programView = vscode.window.createTreeView("es4a.programs", {
		dragAndDropController: programProvider,
		showCollapseAll: true,
		treeDataProvider: programProvider
	});
	const programTreeExpansion = new ProgramTreeExpansionController(
		programProvider,
		programView,
		(message) => output.appendLine(message)
	);
	let unitTabReconcileTimer: ReturnType<typeof setTimeout> | undefined;
	let unitTabReconcileSequence = Promise.resolve();
	const warnedDirtyUnitTabs = new Set<string>();
	/** 根据当前项目列表清理 VS Code 恢复出的孤立 ES4A 标签。 */
	const reconcileRestoredUnitTabs = async (): Promise<void> => {
		const result = await reconcileSimpleUnitTabs(await programProvider.getProjects());
		if (result.closed > 0) {
			output.appendLine(`已关闭 ${result.closed} 个不再属于当前项目的 ES4A 标签页。`);
		}
		const retainedKeys = new Set(result.retainedDirtySources.map((uri) => filePathKey(uri.fsPath)));
		const newlyRetained = result.retainedDirtySources.filter((uri) => {
			const key = filePathKey(uri.fsPath);
			if (warnedDirtyUnitTabs.has(key)) {
				return false;
			}
			warnedDirtyUnitTabs.add(key);
			return true;
		});
		for (const key of [...warnedDirtyUnitTabs]) {
			if (!retainedKeys.has(key)) {
				warnedDirtyUnitTabs.delete(key);
			}
		}
		if (newlyRetained.length > 0) {
			void vscode.window.showWarningMessage(
				`有 ${newlyRetained.length} 个未保存的 Simple 单元不属于当前项目，已仅保留代码标签。`
			);
		}
	};
	/** 合并启动恢复阶段连续出现的标签事件，并串行执行归属校验。 */
	scheduleUnitTabReconcile = (): void => {
		if (unitTabReconcileTimer !== undefined) {
			clearTimeout(unitTabReconcileTimer);
		}
		unitTabReconcileTimer = setTimeout(() => {
			unitTabReconcileTimer = undefined;
			const run = async (): Promise<void> => {
				try {
					await reconcileRestoredUnitTabs();
				} catch (error) {
					output.appendLine(`清理失效 ES4A 标签页失败：${String(error)}`);
				} finally {
					restoringWorkbenchUnitTabs = false;
				}
			};
			unitTabReconcileSequence = unitTabReconcileSequence.then(run, run);
		}, 100);
	};
	const unitTabReconcileScheduler = new vscode.Disposable(() => {
		if (unitTabReconcileTimer !== undefined) {
			clearTimeout(unitTabReconcileTimer);
			unitTabReconcileTimer = undefined;
		}
	});
	/** 内部移除入口也必须先关闭关联标签，避免测试或扩展流程绕过生命周期。 */
	const removeProjectWithTabs = async (filePath: string): Promise<boolean> => {
		const project = (await programProvider.getProjects()).find(
			(candidate) => sameFilePath(candidate.filePath, filePath)
		);
		const sourceDirectories = project?.sourceDirectories ?? [path.dirname(filePath)];
		if (!await closeSimpleUnitTabsInDirectories(sourceDirectories)) {
			return false;
		}
		return programProvider.removeProject(filePath);
	};
	const programReveal = new ProgramRevealController(
		programProvider,
		programTreeExpansion,
		(filePath) => programView.selection.find((selected): selected is FileNode => (
			selected.kind === "unit" && sameFilePath(selected.filePath, filePath)
		)),
		(message) => output.appendLine(message)
	);
	/** 把普通文本编辑器当前文档转换为项目树定位请求。 */
	const revealProgramUnit = (document: vscode.TextDocument): void => {
		programReveal.schedule(resolveActiveUnitSourceUri(document));
	};
	/** 文本编辑器失焦时尝试从活动设计器标签恢复真实单元定位。 */
	const revealActiveDesignerTab = (): boolean => {
		const sourceUri = resolveDesignerTabSourceUri(vscode.window.tabGroups.activeTabGroup.activeTab);
		if (sourceUri === undefined) return false;
		programReveal.schedule(sourceUri);
		return true;
	};
	const designerPropertyChangeListener = designerProvider.onDidChangeProperty((sourceUri) => {
		unitPreviewProvider.refreshSource(sourceUri);
	});
	registerProgramCommands(context, programProvider, programView, {
		codeDocuments: simpleCodeFileSystemProvider,
		deleteDesignerSourceState: (sourceUri) => designerProvider.deleteSourceState(sourceUri),
		getSdk: () => activeSdk,
		moveDesignerSourceState: (oldSourceUri, newSourceUri) => (
			designerProvider.moveSourceState(oldSourceUri, newSourceUri)
		),
		projectSymbols,
		refreshProjectSemantics: () => projectSemantics.refresh()
	});
	registerSdkCapabilityCommands(
		context,
		() => activeSdk,
		async () => {
			const sourceUri = resolveDesignerTabSourceUri(vscode.window.tabGroups.activeTabGroup.activeTab)
				?? resolveActiveUnitSourceUri(vscode.window.activeTextEditor?.document);
			return sourceUri === undefined
				? undefined
				: findProjectForSource(await programProvider.getProjects(), sourceUri.fsPath);
		}
	);
	const openDesignerCommand = vscode.commands.registerCommand(
		"es4a.openDesigner",
		async (node?: ProgramTreeNode) => {
			const nodeSourceUri = node?.kind === "unit" ? vscode.Uri.file(node.filePath) : undefined;
			const sourceUri = nodeSourceUri
				?? resolveActiveUnitSourceUri(vscode.window.activeTextEditor?.document)
				?? designerProvider.getActiveSourceUri();
			const unit = node?.kind === "unit"
				? node
				: sourceUri === undefined ? undefined : await programProvider.findUnitByFilePath(sourceUri.fsPath);
			if (sourceUri === undefined || unit?.unitType !== "窗口") {
				void vscode.window.showErrorMessage("请先打开或选择一个 Simple 窗口单元。");
				return;
			}
			await vscode.commands.executeCommand(
				"vscode.openWith",
				toSimpleDesignerUri(sourceUri),
				SIMPLE_DESIGNER_VIEW_TYPE,
				{ preview: false }
			);
		}
	);
	const addProjectCommand = vscode.commands.registerCommand(
		"es4a.addProject",
		async () => {
			const selections = await selectProjectFiles();
			let addedCount = 0;
			let existingCount = 0;

			for (const selection of selections) {
				if (selection.scheme !== "file") {
					await vscode.window.showErrorMessage("只能添加本地 Simple 项目。");
					continue;
				}

				try {
					if (await programProvider.addProject(selection.fsPath)) {
						addedCount += 1;
					} else {
						existingCount += 1;
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					await vscode.window.showErrorMessage(`添加 Simple 项目失败：${message}`);
				}
			}

			if (addedCount > 0) {
				await vscode.window.showInformationMessage(`已添加 ${addedCount} 个 ES4A 项目。`);
			} else if (existingCount > 0) {
				await vscode.window.showInformationMessage("所选项目已经在 ES4A 项目列表中。");
			}
		}
	);
	/** 无 UI 的内部项目入口只供扩展自身流程和集成测试复用。 */
	const internalAddProjectCommand = vscode.commands.registerCommand(
		"es4a.internal.addProject",
		(filePath: string) => programProvider.addProject(filePath)
	);
	const internalRemoveProjectCommand = vscode.commands.registerCommand(
		"es4a.internal.removeProject",
		(filePath: string) => removeProjectWithTabs(filePath)
	);
	const refreshProgramsCommand = vscode.commands.registerCommand(
		"es4a.refreshPrograms",
		() => programProvider.refresh()
	);
	const reloadSdkAndRefreshLibraries = async (): Promise<void> => {
		try {
			await sdkLoadTask;
		} catch {
			// 显式刷新继续重新读取，不能被上一次失败的后台加载阻断。
		}
		try {
			await loadSdkAndUpdateTokens();
		} catch (error) {
			output.appendLine(`读取 SDK 失败：${String(error)}`);
		}
		await libraryProvider.refresh();
	};
	const refreshLibrariesCommand = vscode.commands.registerCommand(
		"es4a.refreshLibraries",
		reloadSdkAndRefreshLibraries
	);
	const selectSdkCommand = vscode.commands.registerCommand(
		"es4a.selectSdk",
		async () => {
			sdkSelectionInProgress = true;
			try {
				if (await selectSdkManifest()) {
					await reloadSdkAndRefreshLibraries();
				}
			} finally {
				sdkSelectionInProgress = false;
			}
		}
	);

	/* 文档生命周期统一维护输入规范化、XML 会话、预览和项目符号索引。 */
	const documentListener = vscode.workspace.onDidOpenTextDocument((document) => {
		openUnitSemantics.track(document);
		punctuationNormalizer.trackDocument(document);
	});
	/** 当前单元标签发生编辑、撤销、重做或保存时刷新全部关联预览。 */
	const refreshUnitPreviews = (document: vscode.TextDocument): void => {
		const sourceUri = toSimpleSourceUri(document.uri);
		if (sourceUri !== undefined && path.extname(sourceUri.fsPath).toLowerCase() === ".simple") {
			unitPreviewProvider.refreshSource(sourceUri);
		}
	};
	const documentChangeListener = vscode.workspace.onDidChangeTextDocument((event) => {
		openUnitSemantics.markChanged(event.document);
		void punctuationNormalizer.normalize(event);
		const previousPropertyDocument = simpleCodeFileSystemProvider.getProperty(event.document)?.document;
		simpleCodeFileSystemProvider.synchronizePendingEdit(event.document, event.reason);
		const currentPropertyDocument = simpleCodeFileSystemProvider.getProperty(event.document)?.document;
		if (previousPropertyDocument !== currentPropertyDocument) {
			const sourceUri = toSimpleSourceUri(event.document.uri);
			if (sourceUri !== undefined) {
				void programProvider.findUnitByFilePath(sourceUri.fsPath).then((unit) => {
					if (unit !== undefined) {
						programProvider.refresh(unit);
					}
				}).catch((error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					output.appendLine(`刷新单元关系提示失败：${message}`);
				});
			}
		}
		simpleCodeDocumentRecovery?.capture(event.document);
		refreshUnitPreviews(event.document);
		designerProvider.refreshDocument(event.document);
		if (event.document.languageId === "simple") {
			semanticTokensProvider.refresh();
		}
	});
	const documentSaveListener = vscode.workspace.onDidSaveTextDocument((document) => {
		simpleCodeDocumentRecovery?.clear(document);
		refreshUnitPreviews(document);
		if (
			document.uri.scheme === "file"
			&& path.basename(document.uri.fsPath).toLowerCase() === "project.properties"
			&& programProvider.hasProjectProperties(document.uri.fsPath)
		) {
			programProvider.refresh();
			projectSemantics.schedule();
		}
		if (
			document.languageId === "simple"
			|| (document.uri.scheme === "file" && projectSymbols.containsResourcePath(document.uri.fsPath))
		) {
			projectSemantics.schedule();
		}
	});
	const documentCloseListener = vscode.workspace.onDidCloseTextDocument((document) => {
		openUnitSemantics.forget(document);
		punctuationNormalizer.forgetDocument(document);
		simpleCodeDocumentRecovery?.clearClosedDocument(document);
		simpleCodeFileSystemProvider.releaseDocument(document);
		unitPreviewProvider.closePreview(document.uri);
	});
	/** 判断文件事件是否会影响 Simple 项目级语义索引。 */
	const isSimpleFile = (uri: vscode.Uri): boolean => {
		const sourceUri = toSimpleSourceUri(uri);
		return sourceUri !== undefined && path.extname(sourceUri.fsPath).toLowerCase() === ".simple";
	};
	/** 判断文件是否会改变 Simple 单元或独立的 res 资源语义索引。 */
	const affectsProjectSemantics = (uri: vscode.Uri): boolean => (
		isSimpleFile(uri)
		|| (uri.scheme === "file" && projectSymbols.containsResourcePath(uri.fsPath))
	);
	/* 工作区文件变化只在涉及 Simple 单元或项目 res 目录时重建项目符号索引。 */
	const fileCreateListener = vscode.workspace.onDidCreateFiles((event) => {
		for (const file of event.files) {
			if (isSimpleFile(file)) {
				simpleCodeFileSystemProvider.notifySourceCreated(toSimpleSourceUri(file) ?? file);
			}
		}
		if (event.files.some(affectsProjectSemantics)) {
			projectSemantics.schedule();
		}
	});
	const fileDeleteListener = vscode.workspace.onDidDeleteFiles((event) => {
		for (const file of event.files) {
			const sourceUri = toSimpleSourceUri(file);
			if (sourceUri !== undefined && path.extname(sourceUri.fsPath).toLowerCase() === ".simple") {
				simpleCodeFileSystemProvider.notifySourceDeleted(sourceUri);
				void designerProvider.deleteSourceState(sourceUri).catch((error: unknown) => {
					output.appendLine(`清理已删除单元的设计器状态失败：${String(error)}`);
				});
			}
		}
		if (event.files.some(affectsProjectSemantics)) {
			projectSemantics.schedule();
		}
	});
	const fileRenameListener = vscode.workspace.onDidRenameFiles((event) => {
		for (const file of event.files) {
			const oldSourceUri = toSimpleSourceUri(file.oldUri);
			const newSourceUri = toSimpleSourceUri(file.newUri);
			if (oldSourceUri !== undefined && newSourceUri !== undefined) {
				unitPreviewProvider.moveSource(oldSourceUri, newSourceUri);
				if (
					path.extname(oldSourceUri.fsPath).toLowerCase() === ".simple"
					&& path.extname(newSourceUri.fsPath).toLowerCase() === ".simple"
				) {
					simpleCodeFileSystemProvider.notifySourceMoved(oldSourceUri, newSourceUri);
					void moveSimpleUnitPreviewTabs(oldSourceUri, newSourceUri).catch((error: unknown) => {
						output.appendLine(`迁移单元预览标签失败：${String(error)}`);
					});
					void designerProvider.moveSourceState(oldSourceUri, newSourceUri).catch((error: unknown) => {
						output.appendLine(`迁移单元设计器状态失败：${String(error)}`);
					});
				}
			}
		}
		if (event.files.some((file) => (
			affectsProjectSemantics(file.oldUri) || affectsProjectSemantics(file.newUri)
		))) {
			projectSemantics.schedule();
		}
	});
	/* 编辑器和标签页焦点变化只负责同步项目树选择及窗口单元上下文。 */
	const editorListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
		if (editor !== undefined) {
			revealProgramUnit(editor.document);
		} else if (!revealActiveDesignerTab()) {
			programReveal.schedule(undefined);
		}
	});
	const tabListener = vscode.window.tabGroups.onDidChangeTabs((event) => {
		revealActiveDesignerTab();
		if (
			restoringWorkbenchUnitTabs
			&& event.opened.some((tab) => resolveSimpleUnitTab(tab) !== undefined)
		) {
			scheduleUnitTabReconcile();
		}
	});
	const tabGroupListener = vscode.window.tabGroups.onDidChangeTabGroups(() => {
		revealActiveDesignerTab();
	});
	const configurationListener = vscode.workspace.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration("es4a.sdk.path") && !sdkSelectionInProgress) {
			void reloadSdkAndRefreshLibraries();
		}
	});

	context.subscriptions.push(
		output,
		completionRegistration,
		hoverRegistration,
		semanticTokensProvider,
		semanticTokensRegistration,
		signatureHelpRegistration,
		simpleCodeFileSystemProvider,
		simpleCodeFileSystemRegistration,
		unitPreviewProvider,
		unitContentPreviewRegistration,
		unitXmlPreviewRegistration,
		libraryProvider,
		libraryView,
		libraryViewVisibilityListener,
		goToDefinitionCommand,
		revealLibrarySymbolCommand,
		programProvider,
		programView,
		programTreeExpansion,
		programReveal,
		projectSemantics,
		unitTabReconcileScheduler,
		designerProvider,
		designerRegistration,
		designerPropertyChangeListener,
		punctuationNormalizer,
		addProjectCommand,
		internalAddProjectCommand,
		internalRemoveProjectCommand,
		openDesignerCommand,
		refreshProgramsCommand,
		refreshLibrariesCommand,
		selectSdkCommand,
		configurationListener,
		simpleCodeRecoveryOpenListener,
		documentListener,
		documentChangeListener,
		documentSaveListener,
		documentCloseListener,
		fileCreateListener,
		fileDeleteListener,
		fileRenameListener,
		editorListener,
		tabListener,
		tabGroupListener
	);
	/* 激活前已经打开的虚拟文档不会再触发打开事件，因此补一次非阻塞检查。 */
	for (const document of vscode.workspace.textDocuments) {
		void restoreSimpleCodeDocument(document);
	}
	/* VS Code 标签页恢复独立于扩展工作区状态，激活后必须按当前项目列表补做归属校验。 */
	scheduleUnitTabReconcile();
	/* 项目索引和 SDK 只做后台预热，不能继续阻塞项目树与已恢复标签页显示。 */
	void projectSemantics.refresh().catch((error: unknown) => {
		output.appendLine(`读取项目语义索引失败：${String(error)}`);
	});
	void (async (): Promise<void> => {
		try {
			await loadSdkAndUpdateTokens();
		} catch (error) {
			output.appendLine(`读取 SDK 失败：${String(error)}`);
		}
		if (libraryView.visible) {
			await libraryProvider.refresh();
		}
		/* 激活完成后仅提示一次；切换文档和项目不会重复触发。 */
		if (activeSdk === undefined && !sdkSelectionInProgress) {
			const action = await vscode.window.showInformationMessage(
				"尚未加载有效的 SDK 清单，请选择 SDK 入口文件。",
				"选择 SDK 清单"
			);
			if (action === "选择 SDK 清单" && activeSdk === undefined && !sdkSelectionInProgress) {
				await vscode.commands.executeCommand("es4a.selectSdk");
			}
		}
	})();

	if (vscode.window.activeTextEditor !== undefined) {
		revealProgramUnit(vscode.window.activeTextEditor.document);
	} else {
		revealActiveDesignerTab();
	}
}

/** VS Code 窗口关闭前提交尚未写入的恢复状态。 */
export async function deactivate(): Promise<void> {
	await simpleCodeDocumentRecovery?.flush();
	simpleCodeDocumentRecovery = undefined;
}
