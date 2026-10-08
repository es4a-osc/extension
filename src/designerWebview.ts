/*
在编辑器标签页中装配窗口设计器模板，并协调 XML 属性模型与 Webview 消息。
xhwsd@qq.com 2026-8-29
*/

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { createComponentIconSources } from "./componentIcon";
import {
	collectUnavailableComponentNames,
	inspectDesignerComponentNames,
	resolveDesignerComponentIdentity,
	type DesignerComponentIdentity
} from "./componentIdentity";
import { propertyInputValidationMessage } from "./designer/propertyPresentation";
import { SimpleDesignerDocument } from "./designerDocument";
import {
	addSimpleDesignerComponent,
	copySimpleDesignerComponent,
	createSimpleDesignerModel,
	deleteSimpleDesignerComponent,
	findDesignerComponentNode,
	isSimpleDesignerComponentClipboardText,
	moveSimpleDesignerComponent,
	moveSimpleDesignerRelativeComponent,
	nudgeSimpleDesignerComponent,
	pasteSimpleDesignerComponent,
	relocateSimpleDesignerComponent,
	resizeSimpleDesignerComponent,
	type DesignerComponentNode,
	type DesignerRelativeDock,
	type DesignerRelativePlacement,
	type SimpleDesignerModel
} from "./designerModel";
import {
	DEFAULT_DESIGNER_DISPLAY_OPTIONS,
	DESIGNER_COLUMN_IDS,
	normalizeDesignerColumnOrder,
	normalizeDesignerDisplayOptions,
	type DesignerColumnId,
	type DesignerDisplayOptions
} from "./designerLayout";
import type { DesignerPreferenceState } from "./designerPreferencePersistence";
import {
	createDesignerComponentEventGroups,
	resolveDesignerComponentEventAction
} from "./designerComponentEvents";
import {
	PropertyPanelSymbolValidationError,
	updatePropertyPanelValue,
	type PropertyPanelValueRequest
} from "./propertyPanel";
import { createPropertyPanelModel, type PropertyPanelModel } from "./propertyPanelModel";
import {
	getPropertyXmlAttribute,
	resolvePropertyXmlElement,
	type SimplePropertyXmlDocument,
	type SimplePropertyXmlParseResult
} from "./propertyXml";
import { buildDefinitionIndex, type Sdk } from "./sdk";
import type { SimpleProjectSemanticContext } from "./simpleUnitSymbols";
import { libraryDefinitionTarget } from "./librarySymbol";
import { KeyedTaskQueue } from "./keyedTaskQueue";
import {
	SimpleCodeFileSystemProvider,
	toSimpleCodeUri,
	toSimpleSourceUri
} from "./simpleCodeFileSystem";
import { sameFilePath } from "./simpleProjectPaths";
import {
	parseDesignerWebviewMessage,
	type ActivateDesignerComponentEventMessage,
	type AddDesignerComponentMessage,
	type CheckDesignerComponentClipboardMessage,
	type CopyDesignerComponentMessage,
	type CutDesignerComponentMessage,
	type DeleteDesignerComponentMessage,
	type DesignerWebviewMessage,
	type DesignerWebviewRenderMessage,
	type MoveDesignerComponentMessage,
	type MoveRelativeDesignerComponentMessage,
	type DesignerRelativeDockMessage,
	type DesignerRelativePlacementMessage,
	type NudgeDesignerComponentMessage,
	type PasteDesignerComponentMessage,
	type RelocateDesignerComponentMessage,
	type ResizeDesignerComponentMessage,
	type RevealDesignerLibraryDefinitionMessage,
	type UpdateDesignerColumnOrderMessage,
	type UpdateDesignerDisplayOptionMessage
} from "./designerProtocol";

export type { DesignerWebviewMessage, DesignerWebviewRenderMessage } from "./designerProtocol";

/** VS Code 用于显式打开 ES4A 设计器的自定义编辑器类型。 */
export const SIMPLE_DESIGNER_VIEW_TYPE = "es4a.simpleDesigner";

/** 把组件节点中的本地 SVG 路径递归转换为 Webview 可安全消费的遮罩数据源。 */
function mapComponentIconSources(
	node: DesignerComponentNode,
	defaultIconPath: string
): DesignerComponentNode {
	return {
		...node,
		children: node.children.map((child) => mapComponentIconSources(child, defaultIconPath)),
		icon: createComponentIconSources(node.icon, defaultIconPath)?.mask
	};
}

/** 从当前 XML 路径取得组件名称；属性根等非组件节点不建立组件身份。 */
function componentIdentityAtPath(
	document: SimplePropertyXmlDocument,
	xmlPath: string | undefined
): DesignerComponentIdentity | undefined {
	if (xmlPath === undefined) return undefined;
	const element = resolvePropertyXmlElement(document, xmlPath);
	if (element?.name !== "定义") return undefined;
	const componentName = getPropertyXmlAttribute(element, "名称");
	return componentName === undefined ? undefined : { componentName, xmlPath };
}

/** 把设计器完整模型中的组件图标转换为不会暴露本地路径的数据 URI。 */
function mapDesignerIconSources(
	model: SimpleDesignerModel,
	defaultIconPath: string
): SimpleDesignerModel {
	return {
		...model,
		nonVisualComponents: model.nonVisualComponents.map(
			(node) => mapComponentIconSources(node, defaultIconPath)
		),
		root: model.root === undefined
			? undefined
			: mapComponentIconSources(model.root, defaultIconPath),
		toolbox: model.toolbox.map((group) => ({
			...group,
			items: group.items.map((item) => ({
				...item,
				icon: createComponentIconSources(item.icon, defaultIconPath)?.mask
			}))
		}))
	};
}

/** 未适配布局中的属性仍完整显示，但移除全部写入目标。 */
function readOnlyPropertyPanel(model: PropertyPanelModel): PropertyPanelModel {
	return {
		...model,
		groups: model.groups.map((group) => ({
			...group,
			rows: group.rows.map((row) => row.editTarget === undefined
				? row
				: { ...row, editTarget: undefined })
		}))
	};
}

/** 一个设计器标签页绑定的真实文档、选择和会话状态。 */
interface DesignerPanelState {
	readonly contextToken: string;
	readonly disposables: vscode.Disposable[];
	readonly document: SimpleDesignerDocument;
	initialized: boolean;
	readonly panel: vscode.WebviewPanel;
	pendingCut?: {
		readonly clipboardText: string;
		readonly identity: DesignerComponentIdentity;
	};
	ready: boolean;
	renderVersion: number;
	selectedComponentName?: string;
	selectedXmlPath?: string;
}

/** 比较两个编辑文档是否绑定同一个真实 `.simple` 文件。 */
function sameDocumentSource(
	left: vscode.Uri | undefined,
	right: vscode.Uri | undefined
): boolean {
	const leftUri = left === undefined ? undefined : toSimpleSourceUri(left);
	const rightUri = right === undefined ? undefined : toSimpleSourceUri(right);
	if (leftUri === undefined || rightUri === undefined) {
		return leftUri === rightUri;
	}
	return sameFilePath(leftUri.fsPath, rightUri.fsPath);
}

/** 从虚拟文档映射回真实单元，避免显示名称参与设计器业务模型。 */
function documentUnitName(uri: vscode.Uri): string {
	const sourceUri = toSimpleSourceUri(uri);
	const sourcePath = sourceUri?.fsPath ?? uri.path;
	return path.basename(sourcePath, path.extname(sourcePath));
}

/** 把构建后的静态模板绑定到当前 Webview 的本地资源 URI 和 CSP。 */
function loadDesignerWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const resourceRoot = vscode.Uri.joinPath(extensionUri, "dist", "designer");
	const templatePath = vscode.Uri.joinPath(resourceRoot, "designer.html").fsPath;
	const nonce = randomBytes(16).toString("hex");
	return readFileSync(templatePath, "utf8")
		.replaceAll("{{CSP_SOURCE}}", webview.cspSource)
		.replaceAll("{{NONCE}}", nonce)
		.replaceAll("{{STYLE_URI}}", webview.asWebviewUri(vscode.Uri.joinPath(resourceRoot, "designer.css")).toString())
		.replaceAll("{{SCRIPT_URI}}", webview.asWebviewUri(vscode.Uri.joinPath(resourceRoot, "designerClient.js")).toString());
}

/** 建立浏览器端渲染所需的完整数据；XML 属性文档仍是唯一真实状态。 */
export function createDesignerWebviewModel(
	result: SimplePropertyXmlParseResult,
	selectedXmlPath: string | undefined,
	sdk: Sdk | undefined,
	unitName: string,
	contextToken: string,
	defaultComponentIconPath?: string,
	columnOrder: readonly DesignerColumnId[] = DESIGNER_COLUMN_IDS,
	userCode = "",
	renderVersion = 0,
	displayOptions: DesignerDisplayOptions = DEFAULT_DESIGNER_DISPLAY_OPTIONS
): DesignerWebviewRenderMessage {
	const componentNameIssues = result.document === undefined || result.status === "damaged"
		? []
		: inspectDesignerComponentNames(result.document, sdk);
	const projectedModel = createSimpleDesignerModel(result.document, sdk, selectedXmlPath);
	const rawProjection: SimpleDesignerModel = componentNameIssues.length === 0
		? projectedModel
		: {
			emptyMessage: `组件名称无效：${componentNameIssues.join("；")}`,
			nonVisualComponents: [],
			selectedPath: undefined,
			toolbox: projectedModel.toolbox
		};
	const projection = defaultComponentIconPath === undefined
		? rawProjection
		: mapDesignerIconSources(rawProjection, defaultComponentIconPath);
	const selectedNode = result.document === undefined || projection.selectedPath === undefined
		? undefined
		: resolvePropertyXmlElement(result.document, projection.selectedPath);
	const damagedMessage = result.status === "damaged"
		? `属性区损坏：${result.issues.join("；")}`
		: componentNameIssues.length > 0
			? `组件名称无效：${componentNameIssues.join("；")}`
			: undefined;
	const editablePropertyPanel: PropertyPanelModel = damagedMessage === undefined
		? createPropertyPanelModel(result.document, selectedNode, sdk, unitName)
		: { emptyMessage: damagedMessage, groups: [] };
	const selectedProjectedNode = rawProjection.root === undefined || rawProjection.selectedPath === undefined
		? undefined
		: findDesignerComponentNode(rawProjection.root, rawProjection.selectedPath);
	const rawPropertyPanel = selectedProjectedNode?.layoutReadOnly === true
		? readOnlyPropertyPanel(editablePropertyPanel)
		: editablePropertyPanel;
	const propertyPanel = defaultComponentIconPath === undefined || rawPropertyPanel.component !== true
		? rawPropertyPanel
		: {
			...rawPropertyPanel,
			icon: createComponentIconSources(rawPropertyPanel.icon, defaultComponentIconPath)?.mask
		};

	return {
		columnOrder: normalizeDesignerColumnOrder(columnOrder),
		componentEvents: componentNameIssues.length === 0
			? createDesignerComponentEventGroups(result.document, sdk, userCode)
			: [],
		contextToken,
		displayOptions: normalizeDesignerDisplayOptions(displayOptions),
		projection,
		propertyPanel,
		renderVersion,
		type: "renderDesigner"
	};
}

/** 在设计器标签页中复用当前单元树上下文，并独立管理 XML 修改状态。 */
export class SimpleDesignerProvider implements vscode.CustomEditorProvider<SimpleDesignerDocument>, vscode.Disposable {
	private readonly panels = new Set<DesignerPanelState>();
	private readonly documentOperations = new KeyedTaskQueue();
	private readonly documentChangeEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<SimpleDesignerDocument>>();
	private readonly propertyChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
	private propertyValidationStatus?: vscode.Disposable;
	private sdk?: Sdk;

	readonly onDidChangeProperty = this.propertyChangeEmitter.event;
	readonly onDidChangeCustomDocument = this.documentChangeEmitter.event;
	private readonly defaultComponentIconPath: string;

	/** 装配设计器所需的 SDK、XML 会话边界、工作区界面偏好和静态资源。 */
	constructor(
		private readonly codeDocuments: SimpleCodeFileSystemProvider,
		private readonly extensionUri: vscode.Uri,
		private readonly preferenceState: DesignerPreferenceState,
		private readonly semanticContextForDocument?: (
			document: vscode.TextDocument,
			source: string
		) => SimpleProjectSemanticContext | undefined
	) {
		this.defaultComponentIconPath = vscode.Uri.joinPath(
			extensionUri,
			"icons",
			"component-default.svg"
		).fsPath;
	}

	/** 打开设计器自己的文档，并在后台取得同一单元的用户代码文档和共享 XML 会话。 */
	async openCustomDocument(
		uri: vscode.Uri,
		openContext: vscode.CustomDocumentOpenContext,
		_token: vscode.CancellationToken
	): Promise<SimpleDesignerDocument> {
		const sourceUri = toSimpleSourceUri(uri);
		if (sourceUri === undefined) {
			throw new Error(`无法确定设计器对应的 Simple 单元：${uri.toString()}`);
		}
		const codeDocument = await vscode.workspace.openTextDocument(toSimpleCodeUri(sourceUri));
		const document = new SimpleDesignerDocument(
			uri,
			codeDocument,
			this.codeDocuments.retainDesignerDocument(codeDocument)
		);
		try {
			if (openContext.backupId !== undefined) {
				const backupUri = vscode.Uri.parse(openContext.backupId);
				await this.codeDocuments.restoreDesignerProperty(
					codeDocument,
					await vscode.workspace.fs.readFile(backupUri)
				);
			}
			return document;
		} catch (error) {
			document.dispose();
			throw error;
		}
	}

	/** 设计器标签页使用稳定的编辑器类型图标，不跟随窗口组件清单图标。 */
	private updatePanelIcon(panel: vscode.WebviewPanel): void {
		panel.iconPath = {
			dark: vscode.Uri.joinPath(this.extensionUri, "icons", "designer-dark.svg"),
			light: vscode.Uri.joinPath(this.extensionUri, "icons", "designer-light.svg")
		};
	}

	/** 绑定用户代码文档与 Webview 标签页，并注册该标签页独占的消息生命周期。 */
	resolveCustomEditor(document: SimpleDesignerDocument, panel: vscode.WebviewPanel): void {
		panel.title = documentUnitName(document.uri) + "(设计器)";
		this.updatePanelIcon(panel);
		const state: DesignerPanelState = {
			contextToken: randomBytes(16).toString("hex"),
			disposables: [],
			document,
			initialized: false,
			panel,
			ready: false,
			renderVersion: 0
		};
		state.disposables.push(
			panel.webview.onDidReceiveMessage((message: unknown) => this.enqueueMessage(state, message)),
			panel.onDidChangeViewState(() => this.showPanel(state)),
			panel.onDidDispose(() => this.disposePanel(state))
		);
		this.panels.add(state);
		this.showPanel(state);
	}

	/** 保存设计器自己的 XML 修改状态，不保存代码标签中尚未落盘的用户代码。 */
	async saveCustomDocument(
		document: SimpleDesignerDocument,
		cancellation: vscode.CancellationToken
	): Promise<void> {
		await this.enqueueDocumentOperation(document, async () => {
			if (cancellation.isCancellationRequested) return;
			await this.codeDocuments.saveDesignerProperty(await document.getCodeDocument());
			this.notifyPropertyDocumentChanged(document);
		});
	}

	/** 把当前设计器投影另存为一个完整 Simple 单元。 */
	async saveCustomDocumentAs(
		document: SimpleDesignerDocument,
		destination: vscode.Uri,
		cancellation: vscode.CancellationToken
	): Promise<void> {
		await this.enqueueDocumentOperation(document, async () => {
			if (cancellation.isCancellationRequested) return;
			await this.codeDocuments.saveDesignerPropertyAs(
				await document.getCodeDocument(),
				destination
			);
		});
	}

	/** 放弃设计器自己的 XML 修改并恢复磁盘属性区，不影响代码标签的未保存内容。 */
	async revertCustomDocument(
		document: SimpleDesignerDocument,
		cancellation: vscode.CancellationToken
	): Promise<void> {
		await this.enqueueDocumentOperation(document, async () => {
			if (cancellation.isCancellationRequested) return;
			await this.codeDocuments.revertDesignerProperty(await document.getCodeDocument());
			this.notifyPropertyDocumentChanged(document);
		});
	}

	/** 将设计器当前 XML 状态写入 VS Code 指定位置，供热退出恢复。 */
	async backupCustomDocument(
		document: SimpleDesignerDocument,
		context: vscode.CustomDocumentBackupContext,
		cancellation: vscode.CancellationToken
	): Promise<vscode.CustomDocumentBackup> {
		return this.enqueueDocumentOperation(document, async () => {
			if (cancellation.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			const parent = context.destination.with({ path: path.posix.dirname(context.destination.path) });
			await vscode.workspace.fs.createDirectory(parent);
			await vscode.workspace.fs.writeFile(
				context.destination,
				await this.codeDocuments.backupDesignerProperty(await document.getCodeDocument())
			);
			return {
				id: context.destination.toString(),
				delete: () => {
					void vscode.workspace.fs.delete(context.destination).then(undefined, () => undefined);
				}
			};
		});
	}

	/** 首次可见时初始化 Webview；再次可见时补发隐藏期间积累的最新模型。 */
	private showPanel(state: DesignerPanelState): void {
		if (!state.panel.visible) {
			return;
		}
		if (!state.initialized) {
			const resourceRoot = vscode.Uri.joinPath(this.extensionUri, "dist", "designer");
			const html = loadDesignerWebviewHtml(state.panel.webview, this.extensionUri);
			state.panel.webview.options = { enableScripts: true, localResourceRoots: [resourceRoot] };
			state.initialized = true;
			state.panel.webview.html = html;
			return;
		}
		this.render(state);
	}

	/** 当前标签页文档变化时刷新同一单元的所有设计器，并保持仍有效的 XML 选择。 */
	refreshDocument(document: vscode.TextDocument): void {
		for (const state of this.panels) {
			if (sameDocumentSource(document.uri, state.document.uri)) {
				state.document.observeCodeDocument(document);
				this.render(state);
			}
		}
	}

	/** 返回当前设计器绑定的真实 Simple 文件，供命令面板重复打开时使用。 */
	getActiveSourceUri(): vscode.Uri | undefined {
		const document = [...this.panels].find((state) => state.panel.active)?.document;
		return document === undefined ? undefined : toSimpleSourceUri(document.uri);
	}

	/** 单元路径变化时同步更新所属项目中的设计器界面偏好键。 */
	async moveSourceState(oldSourceUri: vscode.Uri, newSourceUri: vscode.Uri): Promise<void> {
		if (oldSourceUri.scheme !== "file" || newSourceUri.scheme !== "file") return;
		await this.preferenceState.moveDocument(oldSourceUri.fsPath, newSourceUri.fsPath);
	}

	/** 单元删除时清理所属项目中不再对应真实文件的设计器显示状态。 */
	async deleteSourceState(sourceUri: vscode.Uri): Promise<void> {
		if (sourceUri.scheme !== "file") return;
		await this.preferenceState.deleteDocument(sourceUri.fsPath);
	}

	/** SDK 更新后重新生成候选组件和属性编辑器。 */
	updateSdk(sdk: Sdk | undefined): void {
		this.sdk = sdk;
		for (const state of this.panels) {
			this.updatePanelIcon(state.panel);
			this.render(state);
		}
	}

	/** 读取标签页共享的 XML 会话；会话不可用时返回可直接渲染的损坏状态。 */
	private currentResult(state: DesignerPanelState): SimplePropertyXmlParseResult {
		return this.codeDocuments.getProperty(state.document.currentCodeDocument) ?? {
			issues: ["当前用户代码标签页没有可用的 XML 文档会话。"],
			status: "damaged"
		};
	}

	/** 返回设计器文档对应的真实 Simple 单元路径。 */
	private documentSourceFile(document: SimpleDesignerDocument): string | undefined {
		const sourceUri = toSimpleSourceUri(document.uri) ?? document.uri;
		return sourceUri.scheme === "file" ? sourceUri.fsPath : undefined;
	}

	/** 返回当前文档保存的列顺序；未保存时固定使用产品缺省顺序。 */
	private documentColumnOrder(document: SimpleDesignerDocument): readonly DesignerColumnId[] {
		const sourceFile = this.documentSourceFile(document);
		return sourceFile === undefined
			? DESIGNER_COLUMN_IDS
			: this.preferenceState.getDocument(sourceFile).columnOrder ?? DESIGNER_COLUMN_IDS;
	}

	/** 返回当前文档保存的三个显示开关；未保存时使用产品缺省值。 */
	private documentDisplayOptions(document: SimpleDesignerDocument): DesignerDisplayOptions {
		const sourceFile = this.documentSourceFile(document);
		return sourceFile === undefined
			? DEFAULT_DESIGNER_DISPLAY_OPTIONS
			: normalizeDesignerDisplayOptions(this.preferenceState.getDocument(sourceFile).displayOptions);
	}

	/** 生成完整只读投影；同一标签页始终携带稳定的会话令牌。 */
	private render(state: DesignerPanelState): void {
		if (!state.initialized || !state.ready || !state.panel.visible) {
			return;
		}
		const result = this.currentResult(state);
		const rootPath = result.document === undefined ? undefined : "/" + result.document.root.name;
		if (result.document !== undefined && state.selectedComponentName !== undefined) {
			try {
				const selected = resolveDesignerComponentIdentity(result.document, {
					componentName: state.selectedComponentName,
					xmlPath: state.selectedXmlPath ?? rootPath ?? "/"
				}, this.sdk);
				state.selectedXmlPath = selected.xmlPath;
			} catch {
				state.selectedComponentName = undefined;
				state.selectedXmlPath = rootPath;
			}
		} else if (
			state.selectedXmlPath !== undefined
			&& (result.document === undefined || resolvePropertyXmlElement(result.document, state.selectedXmlPath) === undefined)
		) {
			state.selectedXmlPath = rootPath;
		}
		const selectedPath = state.selectedXmlPath ?? rootPath;
		const codeDocument = state.document.currentCodeDocument;
		state.renderVersion += 1;
		void state.panel.webview.postMessage(createDesignerWebviewModel(
			result,
			selectedPath,
			this.sdk,
			documentUnitName(state.document.uri),
			state.contextToken,
			this.defaultComponentIconPath,
			this.documentColumnOrder(state.document),
			codeDocument.getText(),
			state.renderVersion,
			this.documentDisplayOptions(state.document)
		));
	}

	/**
	 * 校验浏览器消息，并按真实单元串行执行。
	 *
	 * 同一完整投影可能在刷新到达前连续产生多条消息；只有把“读取当前 XML、计算和提交”
	 * 放进同一队列，才能避免多条操作同时持有同一个旧 XML 文档。
	 */
	private enqueueMessage(state: DesignerPanelState, message: unknown): void {
		const parsedMessage = parseDesignerWebviewMessage(message);
		if (parsedMessage === undefined) {
			return;
		}
		if (parsedMessage.type === "ready") {
			state.ready = true;
			this.render(state);
			return;
		}
		if (parsedMessage.contextToken !== state.contextToken) {
			/* 令牌不属于当前标签页时拒绝修改，同时重发模型使仍存活的 Webview 恢复同步。 */
			this.render(state);
			return;
		}
		if (parsedMessage.type === "selectNode") {
			if (parsedMessage.renderVersion !== state.renderVersion) {
				this.render(state);
				return;
			}
			try {
				this.selectNode(state, parsedMessage);
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				void vscode.window.showErrorMessage("设计器操作失败：" + detail);
				this.render(state);
			}
			return;
		}
		if (parsedMessage.type === "checkComponentClipboard") {
			void this.sendComponentClipboardStatus(state, parsedMessage);
			return;
		}
		if (
			"renderVersion" in parsedMessage
			&& parsedMessage.renderVersion !== state.renderVersion
		) {
			this.render(state);
			return;
		}

		void this.enqueueDocumentOperation(
			state.document,
			() => this.handleMessage(state, parsedMessage)
		);
	}

	/** 组件选择只是当前面板的瞬时状态，必须立即响应，不能排在 XML 写事务后面。 */
	private selectNode(
		state: DesignerPanelState,
		identity: DesignerComponentIdentity
	): void {
		const result = this.currentResult(state);
		if (result.document === undefined) return;
		const selected = resolveDesignerComponentIdentity(result.document, identity, this.sdk);
		state.selectedComponentName = selected.componentName;
		state.selectedXmlPath = selected.xmlPath;
		this.render(state);
	}

	/** 同一真实单元的消息、保存、还原和备份共享一条不会因前次失败而中断的事务队列。 */
	private enqueueDocumentOperation<T>(
		document: SimpleDesignerDocument,
		operation: () => Promise<T>
	): Promise<T> {
		const sourceUri = toSimpleSourceUri(document.uri) ?? document.uri;
		const queueKey = process.platform === "win32"
			? sourceUri.toString().toLowerCase()
			: sourceUri.toString();
		return this.documentOperations.run(queueKey, operation);
	}

	/** 把一条已校验消息分派到统一 XML 或文档事务。 */
	private async handleMessage(
		state: DesignerPanelState,
		parsedMessage: Exclude<
			DesignerWebviewMessage,
			{ readonly type: "checkComponentClipboard" } | { readonly type: "ready" } | { readonly type: "selectNode" }
		>
	): Promise<void> {
		if (!this.panels.has(state)) return;
		try {
			switch (parsedMessage.type) {
				case "activateComponentEvent":
					await this.activateComponentEvent(state, parsedMessage);
					break;
				case "openCode":
					await this.openCode(state);
					break;
				case "addComponent":
					await this.addComponent(state, parsedMessage);
					break;
				case "copyComponent":
					await this.copyComponent(state, parsedMessage);
					break;
				case "cutComponent":
					await this.cutComponent(state, parsedMessage);
					break;
				case "deleteComponent":
					await this.deleteComponent(state, parsedMessage);
					break;
				case "moveComponent":
					await this.moveComponent(state, parsedMessage);
					break;
				case "moveRelativeComponent":
					await this.moveRelativeComponent(state, parsedMessage);
					break;
				case "navigateDocumentHistory":
					await vscode.commands.executeCommand(parsedMessage.direction);
					break;
				case "nudgeComponent":
					await this.nudgeComponent(state, parsedMessage);
					break;
				case "pasteComponent":
					await this.pasteComponent(state, parsedMessage);
					break;
				case "relocateComponent":
					await this.relocateComponent(state, parsedMessage);
					break;
				case "resizeComponent":
					await this.resizeComponent(state, parsedMessage);
					break;
				case "revealLibraryDefinition":
					await this.revealLibraryDefinition(parsedMessage);
					break;
				case "saveDocument":
					if (parsedMessage.pendingPropertyEdit !== undefined) {
						await this.updateProperty(state, parsedMessage.pendingPropertyEdit);
					}
					this.requestSaveDocument(state);
					break;
				case "showPropertyValidationWarning": {
					const warning = propertyInputValidationMessage(
						parsedMessage.propertyType,
						parsedMessage.componentName,
						parsedMessage.propertyName,
						parsedMessage.propertyEditor
					);
					if (warning !== undefined) {
						this.propertyValidationStatus?.dispose();
						this.propertyValidationStatus = vscode.window.setStatusBarMessage(`$(warning) ${warning}`, 3000);
					}
					break;
				}
				case "updateColumnOrder":
					await this.updateColumnOrder(state, parsedMessage);
					break;
				case "updateDisplayOption":
					await this.updateDisplayOption(state, parsedMessage);
					break;
				case "updateXmlValue":
					await this.updateProperty(state, parsedMessage);
					break;
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			await vscode.window.showErrorMessage("设计器操作失败：" + detail);
			this.render(state);
		}
	}

	/** 读取真实系统剪贴板并只返回是否为有效组件 XML，不触发任何文档修改。 */
	private async sendComponentClipboardStatus(
		state: DesignerPanelState,
		message: CheckDesignerComponentClipboardMessage
	): Promise<void> {
		let available = false;
		try {
			available = isSimpleDesignerComponentClipboardText(
				await vscode.env.clipboard.readText(),
				this.sdk
			);
		} catch {
			/* 系统剪贴板暂时不可读时按不可粘贴处理，不弹出设计器错误。 */
		}
		if (!this.panels.has(state) || message.contextToken !== state.contextToken) return;
		void state.panel.webview.postMessage({
			available,
			contextToken: state.contextToken,
			requestId: message.requestId,
			type: "componentClipboardStatus"
		});
	}

	/** 在类库树中定位设计器菜单对应的 SDK 组件定义。 */
	private async revealLibraryDefinition(message: RevealDesignerLibraryDefinitionMessage): Promise<void> {
		const reference = buildDefinitionIndex(this.sdk?.manifests ?? []).get(message.componentType);
		if (reference === undefined) {
			await vscode.window.showWarningMessage("没有找到对应的类库组件。");
			return;
		}
		await vscode.commands.executeCommand(
			"es4a.revealLibrarySymbol",
			libraryDefinitionTarget(reference)
		);
	}

	/** 将当前设计器标签交给 VS Code 保存，不切换或保存用户代码标签。 */
	private requestSaveDocument(state: DesignerPanelState): void {
		if (!state.panel.active) {
			state.panel.reveal(state.panel.viewColumn, false);
		}
		void vscode.commands.executeCommand("workbench.action.files.save").then(undefined, async (error: unknown) => {
			const detail = error instanceof Error ? error.message : String(error);
			await vscode.window.showErrorMessage("设计器保存失败：" + detail);
			this.render(state);
		});
	}

	/** 打开当前设计器共享的用户代码文档，并固定代码标签。 */
	private async openCode(state: DesignerPanelState): Promise<void> {
		await vscode.window.showTextDocument(await state.document.getCodeDocument(), { preview: false });
	}

	/** 打开用户代码；已有事件定位声明，缺失事件通过普通编辑事务追加后定位事件体。 */
	private async activateComponentEvent(
		state: DesignerPanelState,
		message: ActivateDesignerComponentEventMessage
	): Promise<void> {
		/* 标签切换可能恢复虚拟文档内容，事件动作必须基于显示完成后的同一份文本计算。 */
		const codeDocument = await state.document.getCodeDocument();
		const editor = await vscode.window.showTextDocument(codeDocument, { preview: false });
		const { propertyDocument } = await this.currentPropertyContext(state, "读取");
		const component = resolveDesignerComponentIdentity(propertyDocument, message, this.sdk);
		const userCode = codeDocument.getText();
		const lineEnding = codeDocument.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
		const action = resolveDesignerComponentEventAction(
			propertyDocument,
			this.sdk,
			userCode,
			component.xmlPath,
			message.eventName,
			lineEnding
		);
		if (!action.existing) {
			const insertionText = action.insertionText;
			if (insertionText === undefined) throw new Error("事件插入内容无效。");
			const inserted = await editor.edit(
				(edit) => edit.insert(codeDocument.positionAt(userCode.length), insertionText),
				{ undoStopAfter: true, undoStopBefore: true }
			);
			if (!inserted) throw new Error("无法修改当前用户代码文档。");
		}
		const position = codeDocument.positionAt(action.caretOffset);
		editor.selection = new vscode.Selection(position, position);
		editor.revealRange(
			new vscode.Range(position, position),
			vscode.TextEditorRevealType.InCenterIfOutsideViewport
		);
	}

	/** 按真实 `.simple` 文档保存列顺序，并只同步该文档的其它设计器标签页。 */
	private async updateColumnOrder(
		state: DesignerPanelState,
		message: UpdateDesignerColumnOrderMessage
	): Promise<void> {
		const sourceFile = this.documentSourceFile(state.document);
		if (sourceFile === undefined) throw new Error("无法确定设计器对应的真实 Simple 单元。");
		await this.preferenceState.updateColumnOrder(sourceFile, message.order);
		for (const panel of this.panels) {
			if (sameDocumentSource(panel.document.uri, state.document.uri)) this.render(panel);
		}
	}

	/** 按真实 `.simple` 文档保存一个显示开关，并只同步该文档的其它设计器标签页。 */
	private async updateDisplayOption(
		state: DesignerPanelState,
		message: UpdateDesignerDisplayOptionMessage
	): Promise<void> {
		const sourceFile = this.documentSourceFile(state.document);
		if (sourceFile === undefined) throw new Error("无法确定设计器对应的真实 Simple 单元。");
		await this.preferenceState.updateDisplayOption(sourceFile, message.option, message.value);
		for (const panel of this.panels) {
			if (sameDocumentSource(panel.document.uri, state.document.uri)) this.render(panel);
		}
	}

	/** 先恢复后台代码文档，再返回与其同一会话的最新 XML 属性状态。 */
	private async currentPropertyContext(
		state: DesignerPanelState,
		operation: "修改" | "读取" = "修改"
	): Promise<{
		readonly codeDocument: vscode.TextDocument;
		readonly propertyDocument: SimplePropertyXmlDocument;
	}> {
		const codeDocument = await state.document.getCodeDocument();
		const propertyDocument = this.codeDocuments.getProperty(codeDocument)?.document;
		if (propertyDocument === undefined || propertyDocument.status === "damaged") {
			throw new Error(`当前单元没有可安全${operation}的 XML 属性模型。`);
		}
		return { codeDocument, propertyDocument };
	}

	/** 把同一设计器文档的最新 XML 状态同步到全部视图和只读预览。 */
	private notifyPropertyDocumentChanged(document: SimpleDesignerDocument): void {
		const sourceUri = toSimpleSourceUri(document.uri);
		if (sourceUri !== undefined) {
			this.propertyChangeEmitter.fire(sourceUri);
		}
		for (const panel of this.panels) {
			if (sameDocumentSource(panel.document.uri, document.uri)) {
				this.render(panel);
			}
		}
	}

	/** 提交一次设计器独立 XML 事务，并向 VS Code 登记设计器自己的撤销和修改状态。 */
	private async applyDesignerEdit(
		state: DesignerPanelState,
		codeDocument: vscode.TextDocument,
		currentPropertyDocument: SimplePropertyXmlDocument,
		updatedPropertyDocument: SimplePropertyXmlDocument,
		updatedUserCode: string,
		selectedXmlPath?: string,
		label = "修改设计器",
	renamedComponent?: { readonly from: string; readonly to: string }
	): Promise<void> {
		const previousSelection = {
			componentName: state.selectedComponentName,
			xmlPath: state.selectedXmlPath
		};
		await this.codeDocuments.applyDesignerPropertyEdit(
			codeDocument,
			currentPropertyDocument,
			updatedPropertyDocument,
			updatedUserCode
		);
		const retainedSelection = selectedXmlPath === undefined && state.selectedComponentName !== undefined
			? resolveDesignerComponentIdentity(updatedPropertyDocument, {
				componentName: renamedComponent?.from === state.selectedComponentName
					? renamedComponent.to
					: state.selectedComponentName,
				xmlPath: state.selectedXmlPath ?? "/"
			}, this.sdk).xmlPath
			: selectedXmlPath ?? state.selectedXmlPath;
		const nextIdentity = componentIdentityAtPath(updatedPropertyDocument, retainedSelection);
		state.selectedComponentName = nextIdentity?.componentName;
		state.selectedXmlPath = retainedSelection;
		if (renamedComponent !== undefined) {
			for (const panel of this.panels) {
				if (
					sameDocumentSource(panel.document.uri, state.document.uri)
					&& panel.selectedComponentName === renamedComponent.from
				) panel.selectedComponentName = renamedComponent.to;
			}
		}
		const nextSelection = {
			componentName: state.selectedComponentName,
			xmlPath: state.selectedXmlPath
		};

		const restoreVersion = async (
			current: SimplePropertyXmlDocument,
			updated: SimplePropertyXmlDocument,
			selection: typeof previousSelection,
			rename?: { readonly from: string; readonly to: string }
		): Promise<void> => {
			this.codeDocuments.setDesignerPropertyDocument(
				await state.document.getCodeDocument(),
				current,
				updated
			);
			if (rename !== undefined) {
				for (const panel of this.panels) {
					if (
						sameDocumentSource(panel.document.uri, state.document.uri)
						&& panel.selectedComponentName === rename.from
					) panel.selectedComponentName = rename.to;
				}
			}
			if (this.panels.has(state)) {
				state.selectedComponentName = selection.componentName;
				state.selectedXmlPath = selection.xmlPath;
			}
			this.notifyPropertyDocumentChanged(state.document);
		};
		this.documentChangeEmitter.fire({
			document: state.document,
			label,
			redo: () => restoreVersion(
				currentPropertyDocument,
				updatedPropertyDocument,
				nextSelection,
				renamedComponent
			),
			undo: () => restoreVersion(
				updatedPropertyDocument,
				currentPropertyDocument,
				previousSelection,
				renamedComponent === undefined
					? undefined
					: { from: renamedComponent.to, to: renamedComponent.from }
			)
		});
		this.notifyPropertyDocumentChanged(state.document);
	}

	/** 将属性框请求应用到当前 XML 节点；组件改名同时更新用户代码引用。 */
	private async updateProperty(state: DesignerPanelState, message: PropertyPanelValueRequest): Promise<void> {
		const { codeDocument, propertyDocument } = await this.currentPropertyContext(state);
		const selectedPath = message.selectedComponentName === undefined
			? message.selectedXmlPath
			: resolveDesignerComponentIdentity(propertyDocument, {
				componentName: message.selectedComponentName,
				xmlPath: message.selectedXmlPath
			}, this.sdk).xmlPath;
		const projection = createSimpleDesignerModel(propertyDocument, this.sdk, selectedPath);
		const selectedComponent = projection.root === undefined
			? undefined
			: findDesignerComponentNode(projection.root, selectedPath);
		if (selectedComponent?.layoutReadOnly === true) {
			throw new Error("当前布局尚未适配，只能查看和复制其中的组件。");
		}
		const userCode = codeDocument.getText();
		let updated: ReturnType<typeof updatePropertyPanelValue>;
		try {
			updated = updatePropertyPanelValue(
				userCode,
				propertyDocument,
				this.sdk,
				documentUnitName(state.document.uri),
				message,
				this.semanticContextForDocument?.(codeDocument, userCode)
			);
		} catch (error) {
			if (!(error instanceof PropertyPanelSymbolValidationError)) throw error;
			this.propertyValidationStatus?.dispose();
			this.propertyValidationStatus = vscode.window.setStatusBarMessage(`$(warning) ${error.message}`, 3000);
			this.render(state);
			return;
		}
		if (updated.propertyDocument === propertyDocument && updated.userCode === userCode) {
			this.render(state);
			return;
		}
		await this.applyDesignerEdit(
			state,
			codeDocument,
			propertyDocument,
			updated.propertyDocument,
			updated.userCode,
			updated.selectedPath ?? selectedPath,
			"修改属性",
			message.effect === "renameComponent" && message.selectedComponentName !== undefined
				? { from: message.selectedComponentName, to: message.value.trim() }
				: undefined
		);
	}

	/** 抵抗过期 DOM 身份，把 Webview 停靠目标重新解析为当前 XML 路径。 */
	private resolveRelativePlacement(
		propertyDocument: SimplePropertyXmlDocument,
		placement: DesignerRelativePlacementMessage
	): DesignerRelativePlacement {
		const resolveDock = (dock: DesignerRelativeDockMessage | undefined): DesignerRelativeDock | undefined => {
			if (dock === undefined || dock.targetXmlPath === undefined || dock.targetComponentName === undefined) {
				return dock;
			}
			const target = resolveDesignerComponentIdentity(propertyDocument, {
				componentName: dock.targetComponentName,
				xmlPath: dock.targetXmlPath
			}, this.sdk);
			return { axis: dock.axis, projection: dock.projection, targetXmlPath: target.xmlPath };
		};
		return {
			...placement,
			horizontalDock: resolveDock(placement.horizontalDock),
			verticalDock: resolveDock(placement.verticalDock)
		};
	}

	/** 向 XML 容器插入最小组件定义，并继续选择新增节点。 */
	private async addComponent(state: DesignerPanelState, message: AddDesignerComponentMessage): Promise<void> {
		const { codeDocument, propertyDocument } = await this.currentPropertyContext(state);
		const parent = resolveDesignerComponentIdentity(propertyDocument, {
			componentName: message.parentComponentName,
			xmlPath: message.parentXmlPath
		}, this.sdk);
		const reference = message.referenceXmlPath === undefined || message.referenceComponentName === undefined
			? undefined
			: resolveDesignerComponentIdentity(propertyDocument, {
				componentName: message.referenceComponentName,
				xmlPath: message.referenceXmlPath
			}, this.sdk);
		const added = addSimpleDesignerComponent(
			propertyDocument,
			this.sdk,
			message.componentType,
			parent.xmlPath,
			message.target,
			reference === undefined || message.position === undefined
				? undefined
				: {
					position: message.position,
					referenceXmlPath: reference.xmlPath
				},
			message.gridPosition,
			message.absolutePosition,
			collectUnavailableComponentNames(propertyDocument, codeDocument.getText()),
			message.relativePlacement === undefined
				? undefined
				: this.resolveRelativePlacement(propertyDocument, message.relativePlacement),
			message.framePlacement
		);
		await this.applyDesignerEdit(
			state,
			codeDocument,
			propertyDocument,
			added.document,
			codeDocument.getText(),
			added.componentPath,
			"添加组件"
		);
	}

	/** 只把目标 XML `定义`子树写入剪贴板，不序列化完整属性代码。 */
	private async copyComponent(state: DesignerPanelState, message: CopyDesignerComponentMessage): Promise<void> {
		const { propertyDocument } = await this.currentPropertyContext(state, "读取");
		const component = resolveDesignerComponentIdentity(propertyDocument, message, this.sdk);
		const copied = copySimpleDesignerComponent(
			propertyDocument,
			this.sdk,
			component.xmlPath
		);
		state.pendingCut = undefined;
		await vscode.env.clipboard.writeText(copied.text);
	}

	/** 把组件 XML 写入剪贴板并记录源路径；真正删除只发生在后续粘贴移动成功时。 */
	private async cutComponent(state: DesignerPanelState, message: CutDesignerComponentMessage): Promise<void> {
		const { propertyDocument } = await this.currentPropertyContext(state, "读取");
		const component = resolveDesignerComponentIdentity(propertyDocument, message, this.sdk);
		const copied = copySimpleDesignerComponent(
			propertyDocument,
			this.sdk,
			component.xmlPath
		);
		await vscode.env.clipboard.writeText(copied.text);
		state.pendingCut = {
			clipboardText: copied.text,
			identity: { componentName: component.componentName, xmlPath: component.xmlPath }
		};
	}

	/** 校验剪贴板 XML 子树后粘贴到容器，并选择生成的唯一名称节点。 */
	private async pasteComponent(state: DesignerPanelState, message: PasteDesignerComponentMessage): Promise<void> {
		const clipboardText = await vscode.env.clipboard.readText();
		const { codeDocument, propertyDocument } = await this.currentPropertyContext(state);
		const target = resolveDesignerComponentIdentity(propertyDocument, message, this.sdk);
		const pendingCut = state.pendingCut;
		let cutSourceMatches = false;
		let cutSourcePath: string | undefined;
		if (pendingCut !== undefined && pendingCut.clipboardText === clipboardText) {
			try {
				const source = resolveDesignerComponentIdentity(propertyDocument, pendingCut.identity, this.sdk);
				cutSourcePath = source.xmlPath;
				cutSourceMatches = copySimpleDesignerComponent(
					propertyDocument,
					this.sdk,
					source.xmlPath
				).text === pendingCut.clipboardText;
			} catch {
				/* 源节点已删除或路径已变化时按普通剪贴板粘贴，绝不移动路径上的其它组件。 */
			}
		}
		if (pendingCut !== undefined && cutSourceMatches && cutSourcePath !== undefined) {
			const moved = relocateSimpleDesignerComponent(
				propertyDocument,
				this.sdk,
				cutSourcePath,
				target.xmlPath,
				undefined,
				message.gridPosition
			);
			if (moved.document === propertyDocument) {
				state.pendingCut = undefined;
				this.render(state);
				return;
			}
			await this.applyDesignerEdit(
				state,
				codeDocument,
				propertyDocument,
				moved.document,
				codeDocument.getText(),
				moved.selectedPath,
				"剪切并粘贴组件"
			);
			state.pendingCut = undefined;
			return;
		}
		state.pendingCut = undefined;
		const pasted = pasteSimpleDesignerComponent(
			propertyDocument,
			this.sdk,
			target.xmlPath,
			clipboardText,
			message.gridPosition,
			collectUnavailableComponentNames(propertyDocument, codeDocument.getText())
		);
		await this.applyDesignerEdit(
			state,
			codeDocument,
			propertyDocument,
			pasted.document,
			codeDocument.getText(),
			pasted.componentPath,
			"粘贴组件"
		);
	}

	/** 删除 XML 组件定义，并把选择稳定回退到仍存在的父节点。 */
	private async deleteComponent(state: DesignerPanelState, message: DeleteDesignerComponentMessage): Promise<void> {
		const { codeDocument, propertyDocument } = await this.currentPropertyContext(state);
		const component = resolveDesignerComponentIdentity(propertyDocument, message, this.sdk);
		const deleted = deleteSimpleDesignerComponent(propertyDocument, this.sdk, component.xmlPath);
		await this.applyDesignerEdit(
			state,
			codeDocument,
			propertyDocument,
			deleted.document,
			codeDocument.getText(),
			deleted.selectedPath,
			"删除组件"
		);
	}

	/** 在同一 XML 父节点内交换组件顺序。 */
	private async moveComponent(state: DesignerPanelState, message: MoveDesignerComponentMessage): Promise<void> {
		const { codeDocument, propertyDocument } = await this.currentPropertyContext(state);
		const component = resolveDesignerComponentIdentity(propertyDocument, message, this.sdk);
		const moved = moveSimpleDesignerComponent(
			propertyDocument,
			this.sdk,
			component.xmlPath,
			message.direction
		);
		await this.applyDesignerEdit(
			state,
			codeDocument,
			propertyDocument,
			moved.document,
			codeDocument.getText(),
			moved.selectedPath,
			"移动组件"
		);
	}

	/** 把同一相对布局内的自由移动或真实停靠登记为一个设计器 XML 事务。 */
	private async moveRelativeComponent(
		state: DesignerPanelState,
		message: MoveRelativeDesignerComponentMessage
	): Promise<void> {
		const { codeDocument, propertyDocument } = await this.currentPropertyContext(state);
		const component = resolveDesignerComponentIdentity(propertyDocument, message, this.sdk);
		const moved = moveSimpleDesignerRelativeComponent(
			propertyDocument,
			this.sdk,
			component.xmlPath,
			this.resolveRelativePlacement(propertyDocument, message)
		);
		await this.applyDesignerEdit(
			state,
			codeDocument,
			propertyDocument,
			moved.document,
			codeDocument.getText(),
			moved.selectedPath,
			"移动相对布局组件"
		);
	}

	/** 按拖放锚点跨容器或同容器迁移 XML 组件定义。 */
	private async relocateComponent(
		state: DesignerPanelState,
		message: RelocateDesignerComponentMessage
	): Promise<void> {
		const { codeDocument, propertyDocument } = await this.currentPropertyContext(state);
		const component = resolveDesignerComponentIdentity(propertyDocument, {
			componentName: message.componentName,
			xmlPath: message.componentXmlPath
		}, this.sdk);
		const parent = resolveDesignerComponentIdentity(propertyDocument, {
			componentName: message.parentComponentName,
			xmlPath: message.parentXmlPath
		}, this.sdk);
		const reference = message.referenceXmlPath === undefined || message.referenceComponentName === undefined
			? undefined
			: resolveDesignerComponentIdentity(propertyDocument, {
				componentName: message.referenceComponentName,
				xmlPath: message.referenceXmlPath
			}, this.sdk);
		const moved = relocateSimpleDesignerComponent(
			propertyDocument,
			this.sdk,
			component.xmlPath,
			parent.xmlPath,
			reference === undefined || message.position === undefined
				? undefined
				: {
					position: message.position,
					referenceXmlPath: reference.xmlPath
				},
			message.gridPosition,
			message.absolutePosition,
			message.relativePlacement === undefined
				? undefined
				: this.resolveRelativePlacement(propertyDocument, message.relativePlacement),
			message.framePlacement
		);
		await this.applyDesignerEdit(
			state,
			codeDocument,
			propertyDocument,
			moved.document,
			codeDocument.getText(),
			moved.selectedPath,
			"移动组件"
		);
	}

	/** 把一次画布尺寸拖动登记为单独的设计器 XML 撤销事务。 */
	private async resizeComponent(
		state: DesignerPanelState,
		message: ResizeDesignerComponentMessage
	): Promise<void> {
		const { codeDocument, propertyDocument } = await this.currentPropertyContext(state);
		const component = resolveDesignerComponentIdentity(propertyDocument, message, this.sdk);
		const resized = resizeSimpleDesignerComponent(propertyDocument, this.sdk, component.xmlPath, {
			height: message.height,
			left: message.left,
			top: message.top,
			width: message.width
		});
		await this.applyDesignerEdit(
			state,
			codeDocument,
			propertyDocument,
			resized.document,
			codeDocument.getText(),
			resized.selectedPath,
			"调整组件尺寸"
		);
	}

	/** 把一次方向键相对移动登记为独立的设计器 XML 撤销事务。 */
	private async nudgeComponent(
		state: DesignerPanelState,
		message: NudgeDesignerComponentMessage
	): Promise<void> {
		const { codeDocument, propertyDocument } = await this.currentPropertyContext(state);
		const component = resolveDesignerComponentIdentity(propertyDocument, message, this.sdk);
		const moved = nudgeSimpleDesignerComponent(propertyDocument, this.sdk, component.xmlPath, {
			deltaLeft: message.deltaLeft,
			deltaTop: message.deltaTop
		});
		await this.applyDesignerEdit(
			state,
			codeDocument,
			propertyDocument,
			moved.document,
			codeDocument.getText(),
			moved.selectedPath,
			"方向键移动组件"
		);
	}

	/** 从 Provider 集合移除标签页，并释放该标签页独占的监听器。 */
	private disposePanel(state: DesignerPanelState): void {
		this.panels.delete(state);
		for (const disposable of state.disposables.splice(0)) {
			disposable.dispose();
		}
	}

	/** 关闭 Provider 时释放全部设计器标签页和属性变化事件。 */
	dispose(): void {
		for (const state of [...this.panels]) {
			this.disposePanel(state);
		}
		this.propertyValidationStatus?.dispose();
		this.documentChangeEmitter.dispose();
		this.propertyChangeEmitter.dispose();
	}
}
