/*
定义设计器 Webview 与扩展宿主之间的消息契约，并在宿主边界校验未知输入。
xhwsd@qq.com 2026-9-10
*/

import {
	isDesignerColumnOrder,
	isDesignerDisplayOptionId,
	type DesignerColumnId,
	type DesignerDisplayOptionId,
	type DesignerDisplayOptions
} from "./designerLayout";
import type { DesignerComponentEventGroup } from "./designerComponentEvents";
import type {
	DesignerAbsolutePosition,
	DesignerBoxSpacing,
	DesignerComponentResize,
	DesignerFramePlacement,
	DesignerGridPosition,
	DesignerRelativeDock,
	DesignerRelativePlacement,
	SimpleDesignerModel
} from "./designerModel";
import { isPropertyPanelValueRequest, type PropertyPanelValueRequest } from "./propertyPanel";
import type { PropertyPanelModel } from "./propertyPanelModel";

export interface ReadyDesignerMessage {
	readonly type: "ready";
}

interface DesignerRenderBoundMessage {
	readonly contextToken: string;
	readonly renderVersion: number;
}

interface DesignerComponentTargetMessage extends DesignerRenderBoundMessage {
	readonly componentName: string;
	readonly xmlPath: string;
}

export interface SelectDesignerNodeMessage extends DesignerComponentTargetMessage {
	/** 切换选择前仍在输入框内的编辑，与目标选择使用同一投影版本。 */
	readonly pendingPropertyEdit?: PropertyPanelValueRequest;
	readonly type: "selectNode";
}

/** 请求扩展宿主打开当前设计器对应的用户代码标签。 */
export interface OpenDesignerCodeMessage {
	readonly contextToken: string;
	readonly type: "openCode";
}

export interface RevealDesignerLibraryDefinitionMessage {
	readonly componentType: string;
	readonly contextToken: string;
	readonly type: "revealLibraryDefinition";
}

export interface AddDesignerComponentMessage extends DesignerRenderBoundMessage {
	readonly absolutePosition?: DesignerAbsolutePosition;
	readonly componentType: string;
	readonly framePlacement?: DesignerFramePlacement;
	readonly gridPosition?: DesignerGridPosition;
	readonly parentComponentName: string;
	readonly parentXmlPath: string;
	readonly position?: "after" | "before";
	readonly referenceComponentName?: string;
	readonly referenceXmlPath?: string;
	readonly relativePlacement?: DesignerRelativePlacementMessage;
	readonly target: "canvas" | "nonvisual";
	readonly type: "addComponent";
}

export interface DeleteDesignerComponentMessage extends DesignerComponentTargetMessage {
	readonly type: "deleteComponent";
}

export interface CopyDesignerComponentMessage extends DesignerComponentTargetMessage {
	readonly type: "copyComponent";
}

export interface CutDesignerComponentMessage extends DesignerComponentTargetMessage {
	readonly type: "cutComponent";
}

export interface PasteDesignerComponentMessage extends DesignerComponentTargetMessage {
	readonly gridPosition?: DesignerGridPosition;
	readonly type: "pasteComponent";
}

/** 请求扩展宿主检查系统剪贴板中是否存在有效组件定义。 */
export interface CheckDesignerComponentClipboardMessage {
	readonly contextToken: string;
	readonly requestId: number;
	readonly type: "checkComponentClipboard";
}

/** 扩展宿主返回与当前右键菜单请求对应的组件剪贴板状态。 */
export interface DesignerComponentClipboardStatusMessage {
	readonly available: boolean;
	readonly contextToken: string;
	readonly requestId: number;
	readonly type: "componentClipboardStatus";
}

export interface MoveDesignerComponentMessage extends DesignerComponentTargetMessage {
	readonly direction: "next" | "previous";
	readonly type: "moveComponent";
}

export interface UpdateDesignerColumnOrderMessage {
	readonly contextToken: string;
	readonly order: readonly DesignerColumnId[];
	readonly type: "updateColumnOrder";
}

export interface UpdateDesignerDisplayOptionMessage {
	readonly contextToken: string;
	readonly option: DesignerDisplayOptionId;
	readonly type: "updateDisplayOption";
	readonly value: boolean;
}

export interface NavigateDesignerHistoryMessage {
	readonly contextToken: string;
	readonly direction: "redo" | "undo";
	readonly type: "navigateDocumentHistory";
}

export interface SaveDesignerDocumentMessage {
	readonly contextToken: string;
	readonly pendingPropertyEdit?: PropertyPanelValueRequest;
	readonly type: "saveDocument";
}

/** 请求扩展宿主使用 VS Code 状态栏临时消息显示属性输入类型错误。 */
export interface ShowDesignerPropertyValidationWarningMessage {
	readonly componentName: string;
	readonly contextToken: string;
	readonly propertyEditor?: string;
	readonly propertyName: string;
	readonly propertyType: string;
	readonly type: "showPropertyValidationWarning";
}

export interface ActivateDesignerComponentEventMessage extends DesignerComponentTargetMessage {
	readonly eventName: string;
	readonly type: "activateComponentEvent";
}

export interface RelocateDesignerComponentMessage extends DesignerRenderBoundMessage {
	readonly absolutePosition?: DesignerAbsolutePosition;
	readonly componentName: string;
	readonly componentXmlPath: string;
	readonly framePlacement?: DesignerFramePlacement;
	readonly gridPosition?: DesignerGridPosition;
	readonly parentComponentName: string;
	readonly parentXmlPath: string;
	readonly position?: "after" | "before";
	readonly referenceComponentName?: string;
	readonly referenceXmlPath?: string;
	readonly relativePlacement?: DesignerRelativePlacementMessage;
	readonly type: "relocateComponent";
}

/** 请求把画布拖动得到的固定 DIP 尺寸写回选中组件。 */
export interface ResizeDesignerComponentMessage extends DesignerComponentResize, DesignerComponentTargetMessage {
	readonly type: "resizeComponent";
}

/** 请求把绝对布局中的已选可视子组件沿一个方向移动 1dip。 */
export interface NudgeDesignerComponentMessage extends DesignerComponentTargetMessage {
	readonly deltaLeft: number;
	readonly deltaTop: number;
	readonly type: "nudgeComponent";
}

/** Webview 停靠关系同时携带同级组件名称和路径，供宿主抵抗过期 DOM 身份。 */
export interface DesignerRelativeDockMessage extends DesignerRelativeDock {
	readonly targetComponentName?: string;
}

/** 跨容器新增或迁移到相对布局时携带的完整目标位置。 */
export interface DesignerRelativePlacementMessage extends Omit<
	DesignerRelativePlacement,
	"horizontalDock" | "verticalDock"
> {
	readonly horizontalDock?: DesignerRelativeDockMessage;
	readonly verticalDock?: DesignerRelativeDockMessage;
}

/** 请求把相对布局拖拽产生的位置或停靠关系作为一次 XML 事务写回。 */
export interface MoveRelativeDesignerComponentMessage extends DesignerComponentTargetMessage {
	readonly deltaLeft: number;
	readonly deltaTop: number;
	readonly horizontalDock?: DesignerRelativeDockMessage;
	readonly left: number;
	readonly margin?: DesignerBoxSpacing;
	readonly top: number;
	readonly type: "moveRelativeComponent";
	readonly verticalDock?: DesignerRelativeDockMessage;
}

/** Provider 发给浏览器端的完整设计器只读投影。 */
export interface DesignerWebviewRenderMessage {
	readonly columnOrder: readonly DesignerColumnId[];
	readonly componentEvents: readonly DesignerComponentEventGroup[];
	readonly contextToken: string;
	readonly displayOptions: DesignerDisplayOptions;
	readonly projection: SimpleDesignerModel;
	readonly propertyPanel: PropertyPanelModel;
	readonly renderVersion: number;
	readonly type: "renderDesigner";
}

export type DesignerWebviewMessage =
	| ActivateDesignerComponentEventMessage
	| AddDesignerComponentMessage
	| CheckDesignerComponentClipboardMessage
	| CopyDesignerComponentMessage
	| CutDesignerComponentMessage
	| DeleteDesignerComponentMessage
	| MoveDesignerComponentMessage
	| MoveRelativeDesignerComponentMessage
	| NavigateDesignerHistoryMessage
	| NudgeDesignerComponentMessage
	| OpenDesignerCodeMessage
	| PasteDesignerComponentMessage
	| PropertyPanelValueRequest
	| ReadyDesignerMessage
	| RelocateDesignerComponentMessage
	| ResizeDesignerComponentMessage
	| RevealDesignerLibraryDefinitionMessage
	| SaveDesignerDocumentMessage
	| SelectDesignerNodeMessage
	| ShowDesignerPropertyValidationWarningMessage
	| UpdateDesignerColumnOrderMessage
	| UpdateDesignerDisplayOptionMessage;

export type DesignerWebviewHostMessage =
	| DesignerComponentClipboardStatusMessage
	| DesignerWebviewRenderMessage;

function isXmlPath(value: unknown): value is string {
	return typeof value === "string" && value.startsWith("/");
}

function isRenderVersion(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasComponentIdentity(
	candidate: Record<string, unknown>,
	nameKey = "componentName",
	pathKey = "xmlPath"
): boolean {
	return typeof candidate[nameKey] === "string"
		&& (candidate[nameKey] as string).length > 0
		&& isXmlPath(candidate[pathKey])
		&& isRenderVersion(candidate.renderVersion);
}

function isDesignerGridPosition(value: unknown): value is DesignerGridPosition {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return Number.isSafeInteger(candidate.column)
		&& Number.isSafeInteger(candidate.row)
		&& (candidate.column as number) >= 0
		&& (candidate.row as number) >= 0;
}

function isDesignerAbsolutePosition(value: unknown): value is DesignerAbsolutePosition {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return Number.isSafeInteger(candidate.left)
		&& Number.isSafeInteger(candidate.top);
}

function isDesignerBoxSpacing(value: unknown): value is DesignerBoxSpacing {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return ["bottom", "left", "right", "top"].every((side) => (
		candidate[side] === undefined
		|| typeof candidate[side] === "number"
			&& Number.isFinite(candidate[side])
			&& Math.abs(candidate[side]) <= Number.MAX_SAFE_INTEGER
	));
}

/** 校验单帧布局九宫格对齐和可选四向边距。 */
function isDesignerFramePlacement(value: unknown): value is DesignerFramePlacement {
	if (typeof value !== "object" || value === null) return false;
	const placement = value as Record<string, unknown>;
	if (typeof placement.alignment !== "object" || placement.alignment === null) return false;
	const alignment = placement.alignment as Record<string, unknown>;
	return ["left", "center", "right"].includes(String(alignment.horizontal))
		&& ["top", "center", "bottom"].includes(String(alignment.vertical))
		&& (placement.fitContentHeight === undefined || typeof placement.fitContentHeight === "boolean")
		&& (placement.fitContentWidth === undefined || typeof placement.fitContentWidth === "boolean")
		&& (placement.margin === undefined || isDesignerBoxSpacing(placement.margin));
}

const HORIZONTAL_RELATIVE_DOCKS = new Set([
	"alignParentLeft",
	"alignParentRight",
	"centerHorizontal",
	"centerInParent",
	"alignLeft",
	"alignRight",
	"leftOf",
	"rightOf"
]);

const VERTICAL_RELATIVE_DOCKS = new Set([
	"alignParentTop",
	"alignParentBottom",
	"centerVertical",
	"centerInParent",
	"alignTop",
	"alignBottom",
	"above",
	"below"
]);

/** 校验一条停靠关系的轴、投影以及可选同级目标身份。 */
function isDesignerRelativeDock(value: unknown, axis: "horizontal" | "vertical"): boolean {
	if (typeof value !== "object" || value === null) return false;
	const dock = value as Record<string, unknown>;
	const projections = axis === "horizontal" ? HORIZONTAL_RELATIVE_DOCKS : VERTICAL_RELATIVE_DOCKS;
	if (dock.axis !== axis || typeof dock.projection !== "string" || !projections.has(dock.projection)) return false;
	const sibling = ["alignLeft", "alignRight", "leftOf", "rightOf", "alignTop", "alignBottom", "above", "below"]
		.includes(dock.projection);
	return sibling
		? typeof dock.targetComponentName === "string"
			&& dock.targetComponentName.length > 0
			&& isXmlPath(dock.targetXmlPath)
		: dock.targetComponentName === undefined && dock.targetXmlPath === undefined;
}

function isDesignerRelativePlacement(value: unknown, requireChange: boolean): boolean {
	if (typeof value !== "object" || value === null) return false;
	const placement = value as Record<string, unknown>;
	return Number.isSafeInteger(placement.deltaLeft)
		&& Number.isSafeInteger(placement.deltaTop)
		&& Number.isSafeInteger(placement.left)
		&& Number.isSafeInteger(placement.top)
		&& (placement.margin === undefined || isDesignerBoxSpacing(placement.margin))
		&& (placement.horizontalDock === undefined || isDesignerRelativeDock(placement.horizontalDock, "horizontal"))
		&& (placement.verticalDock === undefined || isDesignerRelativeDock(placement.verticalDock, "vertical"))
		&& (!requireChange || (
			placement.deltaLeft !== 0
			|| placement.deltaTop !== 0
			|| placement.horizontalDock !== undefined
			|| placement.verticalDock !== undefined
		));
}

function hasSingleDesignerPlacement(candidate: Record<string, unknown>): boolean {
	return [candidate.absolutePosition, candidate.framePlacement, candidate.gridPosition, candidate.relativePlacement]
		.filter((value) => value !== undefined).length <= 1;
}

/** 校验尺寸拖动消息中的非负尺寸和可选绝对布局坐标。 */
function isDesignerComponentResize(candidate: Record<string, unknown>): boolean {
	const widthValid = candidate.width === undefined
		|| Number.isSafeInteger(candidate.width) && (candidate.width as number) >= 0;
	const heightValid = candidate.height === undefined
		|| Number.isSafeInteger(candidate.height) && (candidate.height as number) >= 0;
	return widthValid
		&& heightValid
		&& (candidate.width !== undefined || candidate.height !== undefined)
		&& (candidate.left === undefined || Number.isSafeInteger(candidate.left) && candidate.width !== undefined)
		&& (candidate.top === undefined || Number.isSafeInteger(candidate.top) && candidate.height !== undefined);
}

function hasValidInsertion(candidate: Record<string, unknown>): boolean {
	const hasInsertion = candidate.position !== undefined || candidate.referenceXmlPath !== undefined;
	return !hasInsertion || (
		(candidate.position === "after" || candidate.position === "before")
		&& isXmlPath(candidate.referenceXmlPath)
		&& typeof candidate.referenceComponentName === "string"
		&& candidate.referenceComponentName.length > 0
	);
}

/** 对一条未知 Webview 消息只执行一次完整校验。 */
export function parseDesignerWebviewMessage(message: unknown): DesignerWebviewMessage | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const candidate = message as Record<string, unknown>;
	if (candidate.type === "ready") return candidate as unknown as ReadyDesignerMessage;
	if (typeof candidate.contextToken !== "string") return undefined;

		switch (candidate.type) {
		case "openCode":
			return candidate as unknown as OpenDesignerCodeMessage;
		case "activateComponentEvent":
			return typeof candidate.eventName === "string"
				&& candidate.eventName.length > 0
				&& hasComponentIdentity(candidate)
				? candidate as unknown as ActivateDesignerComponentEventMessage : undefined;
		case "addComponent":
			return typeof candidate.componentType === "string"
				&& candidate.componentType.length > 0
				&& isRenderVersion(candidate.renderVersion)
				&& typeof candidate.parentComponentName === "string"
				&& candidate.parentComponentName.length > 0
				&& isXmlPath(candidate.parentXmlPath)
				&& (candidate.absolutePosition === undefined || isDesignerAbsolutePosition(candidate.absolutePosition))
				&& (candidate.framePlacement === undefined || isDesignerFramePlacement(candidate.framePlacement))
				&& (candidate.gridPosition === undefined || isDesignerGridPosition(candidate.gridPosition))
				&& (candidate.relativePlacement === undefined || isDesignerRelativePlacement(candidate.relativePlacement, false))
				&& hasSingleDesignerPlacement(candidate)
				&& hasValidInsertion(candidate)
				&& (candidate.target === "canvas" || candidate.target === "nonvisual")
				&& (candidate.relativePlacement === undefined || candidate.target === "canvas")
				&& (candidate.framePlacement === undefined || candidate.target === "canvas")
				? candidate as unknown as AddDesignerComponentMessage : undefined;
		case "copyComponent":
			return hasComponentIdentity(candidate) ? candidate as unknown as CopyDesignerComponentMessage : undefined;
		case "checkComponentClipboard":
			return Number.isSafeInteger(candidate.requestId) && (candidate.requestId as number) >= 0
				? candidate as unknown as CheckDesignerComponentClipboardMessage : undefined;
		case "cutComponent":
			return hasComponentIdentity(candidate) ? candidate as unknown as CutDesignerComponentMessage : undefined;
		case "deleteComponent":
			return hasComponentIdentity(candidate) ? candidate as unknown as DeleteDesignerComponentMessage : undefined;
		case "moveComponent":
			return hasComponentIdentity(candidate)
				&& (candidate.direction === "next" || candidate.direction === "previous")
				? candidate as unknown as MoveDesignerComponentMessage : undefined;
		case "moveRelativeComponent":
			return hasComponentIdentity(candidate)
				&& isDesignerRelativePlacement(candidate, true)
				? candidate as unknown as MoveRelativeDesignerComponentMessage : undefined;
		case "navigateDocumentHistory":
			return candidate.direction === "undo" || candidate.direction === "redo"
				? candidate as unknown as NavigateDesignerHistoryMessage : undefined;
		case "nudgeComponent":
			return hasComponentIdentity(candidate)
				&& Number.isSafeInteger(candidate.deltaLeft)
				&& Number.isSafeInteger(candidate.deltaTop)
				&& Math.abs(candidate.deltaLeft as number) + Math.abs(candidate.deltaTop as number) === 1
				? candidate as unknown as NudgeDesignerComponentMessage : undefined;
		case "pasteComponent":
			return hasComponentIdentity(candidate)
				&& (candidate.gridPosition === undefined || isDesignerGridPosition(candidate.gridPosition))
				? candidate as unknown as PasteDesignerComponentMessage : undefined;
		case "relocateComponent":
			return hasComponentIdentity(candidate, "componentName", "componentXmlPath")
				&& typeof candidate.parentComponentName === "string"
				&& candidate.parentComponentName.length > 0
				&& isXmlPath(candidate.parentXmlPath)
				&& (candidate.absolutePosition === undefined || isDesignerAbsolutePosition(candidate.absolutePosition))
				&& (candidate.framePlacement === undefined || isDesignerFramePlacement(candidate.framePlacement))
				&& (candidate.gridPosition === undefined || isDesignerGridPosition(candidate.gridPosition))
				&& (candidate.relativePlacement === undefined || isDesignerRelativePlacement(candidate.relativePlacement, false))
				&& hasSingleDesignerPlacement(candidate)
				&& hasValidInsertion(candidate)
				? candidate as unknown as RelocateDesignerComponentMessage : undefined;
		case "resizeComponent":
			return hasComponentIdentity(candidate) && isDesignerComponentResize(candidate)
				? candidate as unknown as ResizeDesignerComponentMessage : undefined;
		case "revealLibraryDefinition":
			return typeof candidate.componentType === "string" && candidate.componentType.length > 0
				? candidate as unknown as RevealDesignerLibraryDefinitionMessage : undefined;
		case "saveDocument":
			return candidate.pendingPropertyEdit === undefined || (
				isPropertyPanelValueRequest(candidate.pendingPropertyEdit)
				&& candidate.pendingPropertyEdit.contextToken === candidate.contextToken
			)
				? candidate as unknown as SaveDesignerDocumentMessage : undefined;
		case "selectNode":
			return hasComponentIdentity(candidate) && (candidate.pendingPropertyEdit === undefined || (
				isPropertyPanelValueRequest(candidate.pendingPropertyEdit)
				&& candidate.pendingPropertyEdit.contextToken === candidate.contextToken
				&& candidate.pendingPropertyEdit.renderVersion === candidate.renderVersion
			)) ? candidate as unknown as SelectDesignerNodeMessage : undefined;
		case "showPropertyValidationWarning":
			return typeof candidate.componentName === "string"
				&& candidate.componentName.length > 0
				&& (candidate.propertyEditor === undefined || (
					typeof candidate.propertyEditor === "string"
					&& candidate.propertyEditor.length > 0
				))
				&& typeof candidate.propertyName === "string"
				&& candidate.propertyName.length > 0
				&& typeof candidate.propertyType === "string"
				&& candidate.propertyType.length > 0
				? candidate as unknown as ShowDesignerPropertyValidationWarningMessage : undefined;
		case "updateColumnOrder":
			return isDesignerColumnOrder(candidate.order)
				? candidate as unknown as UpdateDesignerColumnOrderMessage : undefined;
		case "updateDisplayOption":
			return isDesignerDisplayOptionId(candidate.option) && typeof candidate.value === "boolean"
				? candidate as unknown as UpdateDesignerDisplayOptionMessage : undefined;
		case "updateXmlValue":
			return isPropertyPanelValueRequest(candidate) ? candidate : undefined;
		default:
			return undefined;
	}
}
