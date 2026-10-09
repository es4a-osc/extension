/*
把通用 XML 属性文档与 SDK 组件元数据投影为可视化设计器模型。
xhwsd@qq.com 2026-8-29
*/

import {
	appendPropertyXmlElement,
	createPropertyXmlAttributePath,
	createPropertyXmlElement,
	findPropertyXmlElementPath,
	getPropertyXmlAttribute,
	getPropertyXmlChildren,
	insertPropertyXmlElement,
	parsePropertyXmlElement,
	relocatePropertyXmlElement,
	removePropertyXmlElement,
	resolvePropertyXmlElement,
	serializePropertyXmlElement,
	writePropertyXmlValue,
	type PropertyXmlElement,
	type SimplePropertyXmlDocument
} from "./propertyXml";
import { parseSimpleStringLiteral, serializeSimpleStringLiteral } from "./simpleStringLiteral";
import {
	buildDefinitionIndex,
	definitionExtendsType,
	getEffectiveMembers,
	getEffectivePropertyByProjection,
	isComponentDefinition,
	isContainerDefinition,
	isVisualComponentDefinition,
	isWindowDefinition,
	resolveSdkConstantValue,
	runtimeTypeShortName,
	type LibraryDefinitionReference,
	type LibraryPropertyProjection,
	type Sdk
} from "./sdk";
import { resolveDefinitionIconPath } from "./componentIcon";
import {
	designerDefaultLengthKind,
	designerLayoutDefinition,
	designerLayoutKind,
	type DesignerLayoutKind
} from "./designerDefaults";
import { copyNameCandidate } from "./copyName";
import {
	collectUnavailableComponentNames,
	componentNameValidationError
} from "./componentIdentity";

export type { DesignerLayoutKind } from "./designerDefaults";

/** Android 重心常量在设计器中的二维对齐投影。 */
export interface DesignerAlignment {
	readonly horizontal?: "center" | "left" | "right";
	readonly vertical?: "bottom" | "center" | "top";
}

/** 单帧布局子组件相对父级的完整二维对齐和显式边距。 */
export interface DesignerFramePlacement {
	readonly alignment: {
		readonly horizontal: "center" | "left" | "right";
		readonly vertical: "bottom" | "center" | "top";
	};
	/** 该方向原本不是固定尺寸时，显式写为适应内容，使父级定位能够产生可见位移。 */
	readonly fitContentHeight?: boolean;
	readonly fitContentWidth?: boolean;
	readonly margin?: DesignerBoxSpacing;
}

/** 组件四边填充或边距的设计期 DIP 投影。 */
export interface DesignerBoxSpacing {
	readonly bottom?: number;
	readonly left?: number;
	readonly right?: number;
	readonly top?: number;
}

/** 绝对布局子组件相对父容器内容区左上角的设计期 DIP 坐标。 */
export interface DesignerAbsolutePosition {
	readonly left: number;
	readonly top: number;
}

/** 相对布局子组件仅由 XML 属性区确定的兄弟锚点和父级规则。 */
export interface DesignerRelativeRules {
	readonly above?: string;
	readonly alignBaseline?: string;
	readonly alignBottom?: string;
	readonly alignEnd?: string;
	readonly alignLeft?: string;
	readonly alignParentBottom?: boolean;
	readonly alignParentEnd?: boolean;
	readonly alignParentLeft?: boolean;
	readonly alignParentRight?: boolean;
	readonly alignParentStart?: boolean;
	readonly alignParentTop?: boolean;
	readonly alignRight?: string;
	readonly alignStart?: string;
	readonly alignTop?: string;
	readonly below?: string;
	readonly centerHorizontal?: boolean;
	readonly centerInParent?: boolean;
	readonly centerVertical?: boolean;
	readonly endOf?: string;
	readonly leftOf?: string;
	readonly rightOf?: string;
	readonly startOf?: string;
}

/** 相对布局规则在 SDK 属性框中的真实显示名称。 */
export type DesignerRelativeRuleLabels = Readonly<Partial<Record<keyof DesignerRelativeRules, string>>>;

/** 相对布局拖动时允许改变的坐标轴。 */
export interface DesignerRelativeMoveAxes {
	readonly horizontal: boolean;
	readonly vertical: boolean;
}

/** 相对布局拖拽命中的一条可持久化父级或同级停靠关系。 */
export interface DesignerRelativeDock {
	readonly axis: "horizontal" | "vertical";
	readonly projection:
		| "above"
		| "alignBottom"
		| "alignLeft"
		| "alignParentBottom"
		| "alignParentLeft"
		| "alignParentRight"
		| "alignParentTop"
		| "alignRight"
		| "alignTop"
		| "below"
		| "centerHorizontal"
		| "centerInParent"
		| "centerVertical"
		| "leftOf"
		| "rightOf";
	readonly targetXmlPath?: string;
}

/** 相对布局一次拖拽的最终位置、位移和可选双轴停靠关系。 */
export interface DesignerRelativePlacement extends DesignerComponentNudge {
	readonly horizontalDock?: DesignerRelativeDock;
	readonly left: number;
	readonly margin?: DesignerBoxSpacing;
	readonly top: number;
	readonly verticalDock?: DesignerRelativeDock;
}

/** 相对规则不能仅凭 XML 属性区确定时使用的保守投影状态。 */
export type DesignerRelativePositionIssue = "missing-anchor" | "unsupported-expression";

/** 一次画布尺寸拖动产生的固定 DIP 尺寸及可选绝对布局坐标。 */
export interface DesignerComponentResize {
	readonly height?: number;
	readonly left?: number;
	readonly top?: number;
	readonly width?: number;
}

/** Android 字体类型在浏览器低保真预览中的字体族投影。 */
export type DesignerFontFamily = "monospace" | "sans-serif" | "serif";

/** 可视组件宽高在设计器中的低保真长度投影。 */
export type DesignerLength =
	| { readonly kind: "content" }
	| { readonly kind: "parent" }
	| { readonly kind: "fixed"; readonly value: number };

/** 画布、组件树和非可视组件列表共同使用的真实 XML 定义节点。 */
export interface DesignerComponentNode {
	readonly absolutePosition?: DesignerAbsolutePosition;
	readonly alignment?: DesignerAlignment;
	/** 当前容器是否还能接收一个直属可视子组件；非容器固定为 false。 */
	readonly acceptsVisualChild?: boolean;
	readonly backgroundColor?: string;
	readonly children: readonly DesignerComponentNode[];
	readonly container: boolean;
	readonly contentAlignment?: DesignerAlignment;
	readonly description?: string;
	readonly displayText: string;
	/** 当前组件没有可投影的真实文本内容。 */
	readonly displayTextPlaceholder?: boolean;
	readonly fontBold?: boolean;
	readonly fontFamily?: DesignerFontFamily;
	readonly fontItalic?: boolean;
	readonly fontSize?: number;
	readonly gridColumn?: number;
	readonly gridPositionIssue?: "duplicate" | "missing" | "out-of-bounds" | "parent-size";
	readonly gridPositionValid?: boolean;
	readonly gridRow?: number;
	readonly height?: DesignerLength;
	/** 清单定义的已校验 SVG 路径；Webview Provider 会转换为图片数据源。 */
	readonly icon?: string;
	readonly layout: DesignerLayoutKind;
	readonly layoutBaselineAligned?: boolean;
	readonly layoutAllColumnsShrinkable?: boolean;
	readonly layoutAllColumnsStretchable?: boolean;
	readonly layoutColumns?: number;
	readonly layoutContentAlignment?: DesignerAlignment;
	readonly layoutGridSizeValid?: boolean;
	/** 当前可视组件受未适配的父级布局控制，只允许查看和复制。 */
	readonly layoutReadOnly?: boolean;
	/** 当前容器的子组件区域位于未适配布局中，禁止对子组件执行交互操作。 */
	readonly childrenLayoutReadOnly?: boolean;
	readonly layoutRows?: number;
	readonly layoutWeightSum?: number;
	readonly margin?: DesignerBoxSpacing;
	readonly name: string;
	readonly padding?: DesignerBoxSpacing;
	readonly parentPath?: string;
	readonly path: string;
	/** 相对布局中的位置不能通过通用排序拖拽改写。 */
	readonly positionReadOnly?: boolean;
	/** 相对布局中的位置可通过专用画布拖动改写停靠关系或边距，但仍禁止按 XML 顺序移动。 */
	readonly positionDraggable?: boolean;
	readonly relativeMoveAxes?: DesignerRelativeMoveAxes;
	/** 与属性框共用的 SDK 相对布局属性名，避免画布维护第二套规则术语。 */
	readonly relativeRuleLabels?: DesignerRelativeRuleLabels;
	readonly relativePositionIssue?: DesignerRelativePositionIssue;
	readonly relativeRules?: DesignerRelativeRules;
	/** 至少一个尺寸属性可写时允许画布显示对应方向的调节块。 */
	readonly resizable?: boolean;
	readonly resizeHeight?: boolean;
	readonly resizeWidth?: boolean;
	/** 容器清单声明的直属可视子组件上限，不计非可视组件。 */
	readonly limit?: number;
	/** 已合并真实属性与组件级规则的滚动投影方向。 */
	readonly scroll?: "horizontal" | "vertical";
	readonly scrollable?: boolean;
	readonly scrollbarEnabled?: boolean;
	readonly singleLine?: boolean;
	readonly textComponent: boolean;
	/** SDK 定义声明的完整运行时类型；悬停提示优先显示此值。 */
	readonly runtimeType?: string;
	readonly type: string;
	/** SDK 定义名称；界面使用短名称显示组件类型。 */
	readonly typeName?: string;
	readonly visual: boolean;
	readonly textColor?: string;
	readonly width?: DesignerLength;
	readonly weight?: number;
}

/** SDK 提供、尚未加入当前 XML 属性文档的候选组件。 */
export interface DesignerToolboxItem {
	readonly container: boolean;
	readonly description?: string;
	/** 清单定义的已校验 SVG 路径；缺失时由界面使用扩展缺省图标。 */
	readonly icon?: string;
	readonly name: string;
	readonly relativeRuleLabels?: DesignerRelativeRuleLabels;
	/** SDK 清单声明的完整运行时类名。 */
	readonly runtimeType: string;
	readonly visual: boolean;
}

/** SDK 清单中的组件分类及其可拖入组件。 */
export interface DesignerToolboxGroup {
	readonly items: readonly DesignerToolboxItem[];
	readonly name: string;
}

/** 一个窗口单元在设计器中的完整只读投影。 */
export interface SimpleDesignerModel {
	readonly emptyMessage?: string;
	readonly nonVisualComponents: readonly DesignerComponentNode[];
	readonly root?: DesignerComponentNode;
	readonly selectedPath?: string;
	readonly toolbox: readonly DesignerToolboxGroup[];
}

/** 拖入候选组件后返回的新 XML 文档及其节点路径。 */
export interface AddDesignerComponentResult {
	readonly componentPath: string;
	readonly document: SimplePropertyXmlDocument;
}

/** 新组件相对于同一 XML 父节点中现有组件的插入位置。 */
export interface DesignerComponentInsertion {
	readonly position: "after" | "before";
	readonly referenceXmlPath: string;
}

/** 表格布局单元格位置；行列均沿用 Simple 运行时的零基编号。 */
export interface DesignerGridPosition {
	readonly column: number;
	readonly row: number;
}

/** 把设计面有限数值写成运行时可按设备密度换算的 DP 字符串表达式。 */
function designerDpExpression(value: number): string {
	return serializeSimpleStringLiteral(`${value}dp`);
}

/** 限制设计器生成的数值保持有限且不越过 JavaScript 的安全整数范围，同时允许小数 DIP。 */
function isSafeDesignerNumber(value: number): boolean {
	return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

/** 返回一次画布写回所需的真实 SDK 属性名；清单未声明时拒绝猜测中文名称。 */
function requiredProjectedPropertyName(
	definition: LibraryDefinitionReference | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>,
	projection: LibraryPropertyProjection
): string {
	const name = projectedProperty(definition, definitions, projection)?.name;
	if (name === undefined) {
		throw new Error(`SDK 组件没有声明 ${projection} 投影属性。`);
	}
	return name;
}

/** 按清单投影角色把设计器值写入组件的真实 XML 属性。 */
function writeDesignerProjectedProperty(
	document: SimplePropertyXmlDocument,
	componentPath: string,
	definition: LibraryDefinitionReference | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>,
	projection: LibraryPropertyProjection,
	value: string
): SimplePropertyXmlDocument {
	const name = requiredProjectedPropertyName(definition, definitions, projection);
	return writePropertyXmlValue(
		document,
		createPropertyXmlAttributePath(componentPath, "赋值", "属性", name, "值"),
		value
	);
}

/** 删除组件上一项由 SDK 投影声明的显式属性；清单没有该投影时保持原文不变。 */
function removeDesignerProjectedProperty(
	document: SimplePropertyXmlDocument,
	componentPath: string,
	definition: LibraryDefinitionReference | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>,
	projection: LibraryPropertyProjection
): SimplePropertyXmlDocument {
	const name = projectedProperty(definition, definitions, projection)?.name;
	if (name === undefined) return document;
	const valuePath = createPropertyXmlAttributePath(componentPath, "赋值", "属性", name, "值");
	const elementPath = valuePath.slice(0, -"/@值".length);
	return resolvePropertyXmlElement(document, elementPath) === undefined
		? document
		: removePropertyXmlElement(document, elementPath);
}

/** 在组件定义中写入绝对布局使用的左边和顶边 DP 坐标。 */
function writeDesignerAbsolutePosition(
	document: SimplePropertyXmlDocument,
	componentPath: string,
	position: DesignerAbsolutePosition,
	definition: LibraryDefinitionReference | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): SimplePropertyXmlDocument {
	return writeDesignerProjectedProperty(
		writeDesignerProjectedProperty(
			document,
			componentPath,
			definition,
			definitions,
			"x",
			designerDpExpression(position.left)
		),
		componentPath,
		definition,
		definitions,
		"y",
		designerDpExpression(position.top)
	);
}

const FRAME_ALIGNMENT_EXPRESSIONS = {
	"center:bottom": "对齐_中下",
	"center:center": "对齐_居中",
	"center:top": "对齐_中上",
	"left:bottom": "对齐_左下",
	"left:center": "对齐_左中",
	"left:top": "对齐_左上",
	"right:bottom": "对齐_右下",
	"right:center": "对齐_右中",
	"right:top": "对齐_右上"
} as const;

/** 校验单帧布局父级定位，并拒绝无法安全写回的数值。 */
function validateDesignerFramePlacement(placement: DesignerFramePlacement): void {
	const key = `${placement.alignment.horizontal}:${placement.alignment.vertical}` as keyof typeof FRAME_ALIGNMENT_EXPRESSIONS;
	if (FRAME_ALIGNMENT_EXPRESSIONS[key] === undefined) {
		throw new Error("单帧布局对齐方式无效。");
	}
	for (const value of Object.values(placement.margin ?? {})) {
		if (value !== undefined && !isSafeDesignerNumber(value)) {
			throw new Error("单帧布局边距必须是有效 DIP 数值。");
		}
	}
	if (placement.fitContentHeight !== undefined && typeof placement.fitContentHeight !== "boolean") {
		throw new Error("单帧布局高度调整标记无效。");
	}
	if (placement.fitContentWidth !== undefined && typeof placement.fitContentWidth !== "boolean") {
		throw new Error("单帧布局宽度调整标记无效。");
	}
}

/** 用一项组合对齐和相应两侧边距写回单帧布局位置，避免残留旧方向边距。 */
function writeDesignerFramePlacement(
	document: SimplePropertyXmlDocument,
	componentPath: string,
	placement: DesignerFramePlacement,
	definition: LibraryDefinitionReference | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): SimplePropertyXmlDocument {
	validateDesignerFramePlacement(placement);
	let updated = (["layoutGravity", "leftMargin", "topMargin", "rightMargin", "bottomMargin"] as const)
		.reduce(
			(current, projection) => removeDesignerProjectedProperty(
				current,
				componentPath,
				definition,
				definitions,
				projection
			),
			document
		);
	const alignmentKey = `${placement.alignment.horizontal}:${placement.alignment.vertical}` as keyof typeof FRAME_ALIGNMENT_EXPRESSIONS;
	updated = writeDesignerProjectedProperty(
		updated,
		componentPath,
		definition,
		definitions,
		"layoutGravity",
		FRAME_ALIGNMENT_EXPRESSIONS[alignmentKey]
	);
	for (const [side, projection] of [
		["left", "leftMargin"],
		["top", "topMargin"],
		["right", "rightMargin"],
		["bottom", "bottomMargin"]
	] as const) {
		const value = placement.margin?.[side];
		if (value === undefined || value === 0) continue;
		updated = writeDesignerProjectedProperty(
			updated,
			componentPath,
			definition,
			definitions,
			projection,
			designerDpExpression(value)
		);
	}
	if (placement.fitContentWidth === true) {
		updated = writeDesignerProjectedProperty(
			updated,
			componentPath,
			definition,
			definitions,
			"width",
			"长度_适应内容"
		);
	}
	if (placement.fitContentHeight === true) {
		updated = writeDesignerProjectedProperty(
			updated,
			componentPath,
			definition,
			definitions,
			"height",
			"长度_适应内容"
		);
	}
	return updated;
}

/** 删除组件后返回的新 XML 文档和应继续选择的父组件路径。 */
export interface DeleteDesignerComponentResult {
	readonly document: SimplePropertyXmlDocument;
	readonly selectedPath: string;
}

/** 复制组件后返回的剪贴板文本。 */
export interface CopyDesignerComponentResult {
	readonly text: string;
}

/** 粘贴组件后返回的新 XML 文档及其新节点路径。 */
export interface PasteDesignerComponentResult {
	readonly componentPath: string;
	readonly document: SimplePropertyXmlDocument;
}

/** 移动组件后返回的新 XML 文档和目标节点的新路径。 */
export interface MoveDesignerComponentResult {
	readonly document: SimplePropertyXmlDocument;
	readonly selectedPath: string;
}

/** 拖拽组件后返回的新 XML 文档和目标节点的新路径。 */
export interface RelocateDesignerComponentResult {
	readonly document: SimplePropertyXmlDocument;
	readonly selectedPath: string;
}

/** 拖动尺寸后返回的新 XML 文档和仍应保持选择的组件路径。 */
export interface ResizeDesignerComponentResult {
	readonly document: SimplePropertyXmlDocument;
	readonly selectedPath: string;
}

/** 方向键移动使用相对位移，确保连续按键始终基于宿主中的最新 XML 坐标。 */
export interface DesignerComponentNudge {
	readonly deltaLeft: number;
	readonly deltaTop: number;
}

/** 一次索引组件直接声明的属性；重复名称保持 XML 中第一个值的既有语义。 */
function directPropertyValues(element: PropertyXmlElement): ReadonlyMap<string, string | undefined> {
	const values = new Map<string, string | undefined>();
	for (const assignment of getPropertyXmlChildren(element, "赋值")) {
		const name = getPropertyXmlAttribute(assignment, "属性");
		if (name !== undefined && !values.has(name)) {
			values.set(name, assignment.attributes["值"]);
		}
	}
	return values;
}

/** 返回属性索引中一个组件直接声明的表达式。 */
function directProperty(
	properties: ReadonlyMap<string, string | undefined>,
	name: string
): string | undefined {
	return properties.get(name);
}

/** 返回组件继承链中承担指定投影语义的实际属性。 */
function projectedProperty(
	definition: LibraryDefinitionReference | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>,
	projection: LibraryPropertyProjection
) {
	return getEffectivePropertyByProjection(definition, projection, definitions)?.member;
}

/** 读取组件直接声明的投影属性表达式。 */
function directProjectedProperty(
	properties: ReadonlyMap<string, string | undefined>,
	definition: LibraryDefinitionReference | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>,
	projection: LibraryPropertyProjection
): string | undefined {
	const property = projectedProperty(definition, definitions, projection);
	return property === undefined ? undefined : directProperty(properties, property.name);
}

/** 读取 XML 显式投影值；未声明时使用 SDK 继承链中的有效缺省表达式。 */
function effectiveProjectedPropertyExpression(
	properties: ReadonlyMap<string, string | undefined>,
	definition: LibraryDefinitionReference | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>,
	projection: LibraryPropertyProjection
): string | undefined {
	const property = projectedProperty(definition, definitions, projection);
	if (property === undefined) return undefined;
	const explicit = directProperty(properties, property.name);
	if (explicit !== undefined) return explicit;
	return property.initializer?.value;
}

/** 将 Simple 逻辑字面量转换为设计期样式值。 */
function designerBoolean(expression: string | undefined): boolean | undefined {
	const value = expression?.trim().toLocaleLowerCase();
	if (value === "真" || value === "true") return true;
	if (value === "假" || value === "false") return false;
	return undefined;
}

/** 将 Simple 单精度数值字面量转换为非负设计期像素值。 */
function designerFontSize(
	expression: string | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): number | undefined {
	const value = resolveSdkConstantValue(expression, definitions);
	if (value === undefined || !/^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/u.test(value)) {
		return undefined;
	}
	const size = Number(value);
	return Number.isFinite(size) ? size : undefined;
}

/** 将可确定的整数或小数表达式转换为设计期数值。 */
function designerNumber(
	expression: string | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>,
	minimum = 0
): number | undefined {
	const value = designerDipLiteral(resolveSdkConstantValue(expression, definitions));
	if (value === undefined || !/^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/u.test(value)) {
		return undefined;
	}
	const number = Number(value);
	return Number.isFinite(number) && number >= minimum ? number : undefined;
}

/**
 * 将确定的数值、单位字符串或 `到绝对像素(数值)`还原为设计面的参考逻辑尺寸。
 *
 * 设计器不具备目标设备密度和字体缩放，因而只按 mdpi、fontScale=1 的参考比例投影数值。
 */
function designerDipLiteral(expression: string | undefined): string | undefined {
	const value = expression?.trim();
	if (value === undefined) {
		return undefined;
	}
	const match = value.match(
		/^(?:(?:simple\.runtime\.)?像素\.)?到绝对像素\s*\(\s*(-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+))\s*\)$/u
	);
	if (match?.[1] !== undefined) return match[1];
	const stringValue = parseSimpleStringLiteral(value)?.trim();
	const unit = stringValue?.match(/^(-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+))\s*(?:px|dp|dip|sp)?$/iu);
	return unit?.[1] ?? value;
}

/** 将可确定的非负整数表达式转换为设计期行列值。 */
function designerInteger(
	expression: string | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>,
	minimum = 0
): number | undefined {
	const number = designerNumber(expression, definitions, minimum);
	return number !== undefined && Number.isSafeInteger(number) ? number : undefined;
}

/** 读取组件直接声明的四边填充或边距；没有可确定值的边保持未设置。 */
function designerBoxSpacing(
	properties: ReadonlyMap<string, string | undefined>,
	definition: LibraryDefinitionReference | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>,
	projections: Readonly<{
		bottom: LibraryPropertyProjection;
		left: LibraryPropertyProjection;
		right: LibraryPropertyProjection;
		top: LibraryPropertyProjection;
	}>,
	minimum = 0
): DesignerBoxSpacing | undefined {
	const spacing: DesignerBoxSpacing = {
		bottom: designerNumber(directProjectedProperty(properties, definition, definitions, projections.bottom), definitions, minimum),
		left: designerNumber(directProjectedProperty(properties, definition, definitions, projections.left), definitions, minimum),
		right: designerNumber(directProjectedProperty(properties, definition, definitions, projections.right), definitions, minimum),
		top: designerNumber(directProjectedProperty(properties, definition, definitions, projections.top), definitions, minimum)
	};
	return Object.values(spacing).some((value) => value !== undefined) ? spacing : undefined;
}

/** 将 Android Typeface 常量转换为浏览器字体族。 */
function designerFontFamily(
	expression: string | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): DesignerFontFamily | undefined {
	const value = resolveSdkConstantValue(expression, definitions);
	if (value === "0" || value === "1") return "sans-serif";
	if (value === "2") return "serif";
	if (value === "3") return "monospace";
	return undefined;
}

/** 将 Simple 的十六进制或十进制 32 位 ARGB 整数转换为 CSS 的 #RRGGBBAA。 */
function designerColor(
	expression: string | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): string | undefined {
	const value = resolveSdkConstantValue(expression, definitions);
	const hexadecimal = value?.match(/^&H([0-9A-F]{8})$/iu)?.[1];
	let argb = hexadecimal;
	if (argb === undefined && value !== undefined && /^-?[0-9]+$/u.test(value)) {
		const decimal = BigInt(value);
		if (decimal >= -0x80000000n && decimal <= 0xFFFFFFFFn) {
			argb = BigInt.asUintN(32, decimal).toString(16).padStart(8, "0");
		}
	}
	if (argb === undefined) return undefined;
	return `#${argb.slice(2)}${argb.slice(0, 2)}`.toUpperCase();
}

/** 将 Simple 文本字面量转换为预览文本；其他表达式保持原样。 */
function displayExpression(value: string | undefined): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	const trimmed = value.trim();
	const stringLiteral = parseSimpleStringLiteral(trimmed);
	if (stringLiteral !== undefined) {
		return stringLiteral;
	}
	return trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")
		? trimmed.slice(1, -1).replaceAll("\"\"", "\"")
		: trimmed;
}

/** 按 Simple 自身常量解释组件长度；未显式设置时采用父容器的真实初始布局参数。 */
function designerLength(
	expression: string | undefined,
	defaultKind: "content" | "parent" = "content"
): DesignerLength | undefined {
	const value = expression?.trim();
	if (value === undefined) {
		return { kind: defaultKind };
	}
	if (value === "-1" || value !== undefined && /(?:^|\.)长度_适应内容$/u.test(value)) {
		return { kind: "content" };
	}
	if (value === "-2" || value !== undefined && /(?:^|\.)长度_匹配父级$/u.test(value)) {
		return { kind: "parent" };
	}
	const dipValue = designerDipLiteral(value);
	if (dipValue === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(dipValue)) {
		return undefined;
	}
	const fixed = Number(dipValue);
	return Number.isSafeInteger(fixed) ? { kind: "fixed", value: fixed } : undefined;
}

/** 读取布局子属性的 XML 显式值；未声明时使用当前 SDK 布局定义的有效初始值。 */
function effectiveLayoutPropertyExpression(
	properties: ReadonlyMap<string, string | undefined>,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>,
	layout: DesignerLayoutKind,
	projection: LibraryPropertyProjection
): string | undefined {
	const definitionName = designerLayoutDefinition(layout)?.name;
	const layoutDefinition = definitionName === undefined ? undefined : definitions.get(definitionName);
	const property = projectedProperty(layoutDefinition, definitions, projection);
	if (property === undefined) return undefined;
	const explicit = directProperty(properties, "布局." + property.name);
	return explicit ?? property.initializer?.value;
}

/** 将组件及布局 SDK 初始值或 XML 显式值映射为低保真 CSS 排列。 */
function layoutKind(
	properties: ReadonlyMap<string, string | undefined>,
	definition: LibraryDefinitionReference | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): DesignerLayoutKind {
	const layoutExpression = effectiveProjectedPropertyExpression(properties, definition, definitions, "layout");
	/* 没有有效布局属性值时使用固定投影；未知的实际表达式仍保持只读。 */
	if (layoutExpression === undefined && isContainerDefinition(definition?.definition)) {
		return definition?.definition.projection?.layout ?? "frame";
	}
	const initialLayout = designerLayoutKind(layoutExpression, undefined);
	return designerLayoutKind(
		layoutExpression,
		effectiveLayoutPropertyExpression(properties, definitions, initialLayout, "orientation")
	);
}

/** 按 Android 运行库的对齐常量提取水平方向。 */
function horizontalContentAlignment(expression: string | undefined): DesignerAlignment["horizontal"] {
	const value = expression?.trim();
	if (value === undefined) {
		return undefined;
	}
	if (["0", "6", "8", "9"].includes(value) || /(?:^|\.)对齐_(?:左|左上|左中|左下)$/u.test(value)) {
		return "left";
	}
	if (["1", "10", "11", "12"].includes(value) || /(?:^|\.)对齐_(?:水平居中|中上|居中|中下)$/u.test(value)) {
		return "center";
	}
	if (["2", "13", "14", "15"].includes(value) || /(?:^|\.)对齐_(?:右|右上|右中|右下)$/u.test(value)) {
		return "right";
	}
	return undefined;
}

/** 文本内容未声明某个方向时，按 Android TextView 语义落在左上。 */
function contentAlignment(
	expression: string | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): DesignerAlignment | undefined {
	const alignment = designerAlignment(expression, definitions);
	return alignment === undefined ? undefined : {
		horizontal: alignment.horizontal ?? "left",
		vertical: alignment.vertical ?? "top"
	};
}

/** 读取组件显式逻辑属性；未声明时使用 SDK 继承链中的实际默认值。 */
function booleanProperty(
	properties: ReadonlyMap<string, string | undefined>,
	definition: LibraryDefinitionReference | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>,
	projection: LibraryPropertyProjection
): boolean | undefined {
	return designerBoolean(effectiveProjectedPropertyExpression(properties, definition, definitions, projection));
}

/** 读取继承合并后的属性可写性；缺少 SDK 定义或属性时不开放直接画布修改。 */
function designerPropertyWritable(
	definition: LibraryDefinitionReference | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>,
	projection: LibraryPropertyProjection
): boolean {
	const property = projectedProperty(definition, definitions, projection);
	return property !== undefined && property.writable !== false;
}

const RELATIVE_ANCHOR_PROJECTIONS = [
	"leftOf",
	"above",
	"rightOf",
	"below",
	"alignBaseline",
	"alignLeft",
	"alignTop",
	"alignRight",
	"alignBottom",
	"startOf",
	"endOf",
	"alignStart",
	"alignEnd"
] as const satisfies readonly LibraryPropertyProjection[];

const RELATIVE_PARENT_PROJECTIONS = [
	"alignParentLeft",
	"alignParentTop",
	"alignParentRight",
	"alignParentBottom",
	"centerInParent",
	"centerHorizontal",
	"centerVertical",
	"alignParentStart",
	"alignParentEnd"
] as const satisfies readonly LibraryPropertyProjection[];

const RELATIVE_ANCHOR_PROJECTION_SET: ReadonlySet<LibraryPropertyProjection> = new Set(
	RELATIVE_ANCHOR_PROJECTIONS
);

/** 相对关系可以在拖拽落点被替换；损坏或无法解析的规则仍由调用方禁止拖动。 */
function relativeMoveAxes(_rules: DesignerRelativeRules): DesignerRelativeMoveAxes {
	return { horizontal: true, vertical: true };
}

/** 从组件继承后的 SDK 属性定义建立画布规则名称，不在设计器中硬编码另一套文案。 */
function relativeRuleLabels(
	definition: LibraryDefinitionReference | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): DesignerRelativeRuleLabels {
	const labels: Partial<Record<keyof DesignerRelativeRules, string>> = {};
	for (const projection of [...RELATIVE_ANCHOR_PROJECTIONS, ...RELATIVE_PARENT_PROJECTIONS]) {
		const property = projectedProperty(definition, definitions, projection);
		if (property !== undefined) labels[projection] = property.name;
	}
	return labels;
}

/** 把相对布局锚点表达式限定解析到同一 XML 父节点下的组件。 */
function projectRelativeChildren(
	children: readonly DesignerComponentNode[],
	elements: readonly PropertyXmlElement[],
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): readonly DesignerComponentNode[] {
	const childProperties = elements.map(directPropertyValues);
	const referencesByName = new Map<string, { readonly idPropertyName: string; readonly path: string }>();
	const pathsByIdentifier = new Map<string, string>();
	for (const [index, child] of children.entries()) {
		const definition = definitions.get(child.type);
		const idProperty = projectedProperty(definition, definitions, "id");
		if (idProperty === undefined) continue;
		referencesByName.set(child.name, { idPropertyName: idProperty.name, path: child.path });
		const identifier = resolveSdkConstantValue(
			directProperty(childProperties[index] ?? new Map(), idProperty.name),
			definitions
		)?.trim();
		if (identifier !== undefined && identifier.length > 0 && identifier !== "0" && !pathsByIdentifier.has(identifier)) {
			pathsByIdentifier.set(identifier, child.path);
		}
	}

	const resolveAnchor = (
		expression: string
	): { readonly issue?: DesignerRelativePositionIssue; readonly path?: string } => {
		const value = expression.trim();
		if (value.length === 0) return { issue: "unsupported-expression" };
		const memberSeparator = value.lastIndexOf(".");
		if (memberSeparator >= 0) {
			const referenceName = value.slice(0, memberSeparator).split(".").at(-1) ?? "";
			const memberName = value.slice(memberSeparator + 1);
			const reference = referencesByName.get(referenceName);
			if (reference !== undefined && reference.idPropertyName === memberName) {
				return { path: reference.path };
			}
			return { issue: "missing-anchor" };
		}
		const resolved = resolveSdkConstantValue(value, definitions)?.trim();
		if (resolved === undefined || resolved.length === 0) return { issue: "unsupported-expression" };
		if (resolved === "0") return {};
		const path = pathsByIdentifier.get(resolved);
		return path === undefined ? { issue: "unsupported-expression" } : { path };
	};

	return children.map((child, index) => {
		if (!child.visual) return child;
		const properties = childProperties[index] ?? new Map<string, string | undefined>();
		const definition = definitions.get(child.type);
		const rules: Record<string, boolean | string | undefined> = {};
		let issue: DesignerRelativePositionIssue | undefined;
		for (const projection of RELATIVE_ANCHOR_PROJECTIONS) {
			const expression = directProjectedProperty(properties, definition, definitions, projection);
			if (expression === undefined) continue;
			const anchor = resolveAnchor(expression);
			if (anchor.path !== undefined) rules[projection] = anchor.path;
			issue ??= anchor.issue;
		}
		for (const projection of RELATIVE_PARENT_PROJECTIONS) {
			const expression = directProjectedProperty(properties, definition, definitions, projection);
			if (expression === undefined) continue;
			const enabled = designerBoolean(expression);
			if (enabled === true) rules[projection] = true;
			if (enabled === undefined) issue ??= "unsupported-expression";
		}
		const relativeRules = rules as DesignerRelativeRules;
		const moveAxes = relativeMoveAxes(relativeRules);
		return {
			...child,
			positionDraggable: issue === undefined && (moveAxes.horizontal || moveAxes.vertical),
			relativeMoveAxes: issue === undefined ? moveAxes : undefined,
			relativeRuleLabels: relativeRuleLabels(definition, definitions),
			relativePositionIssue: issue,
			relativeRules
		};
	});
}

/** 建立一个真实 XML 定义节点的设计器投影。 */
function createComponentNode(
	document: SimplePropertyXmlDocument,
	element: PropertyXmlElement,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>,
	parentPath?: string,
	parentLayout?: DesignerLayoutKind,
	parentGridSize?: { readonly columns: number; readonly rows: number },
	parentChildrenLayoutReadOnly = false
): DesignerComponentNode | undefined {
	const path = findPropertyXmlElementPath(document, element);
	if (path === undefined) {
		return undefined;
	}
	const name = getPropertyXmlAttribute(element, "名称") ?? "未命名组件";
	const type = getPropertyXmlAttribute(element, "组件") ?? "未知组件";
	const properties = directPropertyValues(element);
	const definition = definitions.get(type);
	const definitionValue = definition?.definition;
	const visual = isVisualComponentDefinition(definitionValue);
	const window = isWindowDefinition(definitionValue);
	const textComponent = definitionExtendsType(
		definitionValue,
		"simple.runtime.components.文本组件"
	);
	const layout = layoutKind(properties, definition, definitions);
	const projection = isContainerDefinition(definitionValue) ? definitionValue?.projection : undefined;
	const limit = projection?.limit;
	const scrollable = booleanProperty(properties, definition, definitions, "scrollable");
	/* 实际滚动开关优先；固定方向只补足组件没有方向属性的投影。 */
	const scroll = scrollable === false ? undefined
		: projection?.scroll === "horizontal" ? "horizontal"
			: projection?.scroll === "vertical" || scrollable === true ? "vertical" : undefined;
	/* 自身布局只控制子组件；组件自身是否可操作由所在父布局决定。 */
	const layoutReadOnly = visual && parentChildrenLayoutReadOnly;
	const childrenLayoutReadOnly = layoutReadOnly || layout === "unsupported";
	const projectedText = displayExpression(effectiveProjectedPropertyExpression(
		properties,
		definition,
		definitions,
		"text"
	));
	const projectedHintText = !window && (projectedText === undefined || projectedText.length === 0)
		? displayExpression(effectiveProjectedPropertyExpression(
			properties,
			definition,
			definitions,
			"hint"
		))
		: undefined;
	const usesHintText = projectedHintText !== undefined && projectedHintText.length > 0;
	const displayText = window && (projectedText === undefined || projectedText.length === 0)
		? name
		: usesHintText ? projectedHintText : projectedText ?? "";
	const displayTextPlaceholder = !window && displayText.length === 0;
	const gridColumn = designerInteger(directProjectedProperty(properties, definition, definitions, "column"), definitions);
	const gridRow = designerInteger(directProjectedProperty(properties, definition, definitions, "row"), definitions);
	const layoutColumns = designerInteger(
		effectiveLayoutPropertyExpression(properties, definitions, layout, "columnCount"),
		definitions,
		1
	);
	const layoutRows = designerInteger(
		effectiveLayoutPropertyExpression(properties, definitions, layout, "rowCount"),
		definitions,
		1
	);
	const gridPositionIssue = parentLayout !== "grid" || !visual
		? undefined
		: parentGridSize === undefined
			? "parent-size"
			: gridColumn === undefined || gridRow === undefined
				? "missing"
				: gridColumn < 0 || gridColumn >= parentGridSize.columns
					|| gridRow < 0 || gridRow >= parentGridSize.rows
					? "out-of-bounds"
					: undefined;
	const childGridSize = layout === "grid" && layoutColumns !== undefined && layoutRows !== undefined
		? { columns: layoutColumns, rows: layoutRows }
		: undefined;
	const childElements = getPropertyXmlChildren(element, "定义");
	const rawChildren = childElements
		.map((child) => createComponentNode(
			document,
			child,
			definitions,
			path,
			layout,
			childGridSize,
			childrenLayoutReadOnly
		))
		.filter((child): child is DesignerComponentNode => child !== undefined);
	const positionedChildren = layout === "relative"
		? projectRelativeChildren(rawChildren, childElements, definitions)
		: rawChildren;
	const occupiedGridPositions = new Map<string, number>();
	if (layout === "grid") {
		for (const child of positionedChildren) {
			if (child.gridPositionValid !== true || child.gridColumn === undefined || child.gridRow === undefined) continue;
			const key = child.gridRow + ":" + child.gridColumn;
			occupiedGridPositions.set(key, (occupiedGridPositions.get(key) ?? 0) + 1);
		}
	}
	const children = positionedChildren.map((child): DesignerComponentNode => {
		if (
			child.gridPositionValid !== true
			|| child.gridColumn === undefined
			|| child.gridRow === undefined
			|| occupiedGridPositions.get(child.gridRow + ":" + child.gridColumn) === 1
		) return child;
		return { ...child, gridPositionIssue: "duplicate", gridPositionValid: false };
	});
	const resizeWidth = visual && !window && !layoutReadOnly
		&& designerPropertyWritable(definition, definitions, "width");
	const resizeHeight = visual && !window && !layoutReadOnly
		&& designerPropertyWritable(definition, definitions, "height");
	return {
		absolutePosition: parentLayout === "absolute" && visual
			? {
				left: designerInteger(directProjectedProperty(properties, definition, definitions, "x"), definitions, Number.MIN_SAFE_INTEGER) ?? 0,
				top: designerInteger(directProjectedProperty(properties, definition, definitions, "y"), definitions, Number.MIN_SAFE_INTEGER) ?? 0
			}
			: undefined,
		/* 未显式设置子组件对齐时沿用父布局的内容对齐，不能用 SDK 初始值覆盖。 */
		alignment: designerAlignment(directProjectedProperty(properties, definition, definitions, "layoutGravity"), definitions),
		acceptsVisualChild: !childrenLayoutReadOnly && isContainerDefinition(definition?.definition)
			&& (limit === undefined || children.filter((child) => child.visual).length < limit),
		backgroundColor: designerColor(
			effectiveProjectedPropertyExpression(properties, definition, definitions, "backgroundColor"),
			definitions
		),
		children,
		childrenLayoutReadOnly,
		container: isContainerDefinition(definition?.definition),
		contentAlignment: projectedProperty(definition, definitions, "gravity") !== undefined
			? contentAlignment(
				effectiveProjectedPropertyExpression(properties, definition, definitions, "gravity"),
				definitions
			)
			: undefined,
		description: definitionValue?.description,
		displayText,
		displayTextPlaceholder: !window && displayTextPlaceholder,
		fontBold: booleanProperty(properties, definition, definitions, "fontBold"),
		fontFamily: designerFontFamily(
			effectiveProjectedPropertyExpression(properties, definition, definitions, "fontFamily"),
			definitions
		),
		fontItalic: booleanProperty(properties, definition, definitions, "fontItalic"),
		fontSize: designerFontSize(
			effectiveProjectedPropertyExpression(properties, definition, definitions, "textSize"),
			definitions
		),
		gridColumn,
		gridPositionValid: parentLayout === "grid" && visual
			? gridPositionIssue === undefined
			: undefined,
		gridPositionIssue,
		gridRow,
		height: designerLength(
			directProjectedProperty(properties, definition, definitions, "height"),
			designerDefaultLengthKind(parentLayout, "height")
		),
		icon: resolveDefinitionIconPath(definition),
		layout,
		layoutAllColumnsShrinkable: layout === "grid"
			? designerBoolean(effectiveLayoutPropertyExpression(
				properties,
				definitions,
				layout,
				"shrinkAllColumns"
			))
			: undefined,
		layoutAllColumnsStretchable: layout === "grid"
			? designerBoolean(effectiveLayoutPropertyExpression(
				properties,
				definitions,
				layout,
				"stretchAllColumns"
			))
			: undefined,
		layoutBaselineAligned: designerBoolean(effectiveLayoutPropertyExpression(
			properties,
			definitions,
			layout,
			"baselineAligned"
		)),
		layoutColumns,
		layoutContentAlignment: designerAlignment(
			effectiveLayoutPropertyExpression(properties, definitions, layout, "gravity"),
			definitions
		),
		layoutGridSizeValid: layout === "grid"
			? layoutColumns !== undefined && layoutRows !== undefined
			: undefined,
		layoutReadOnly,
		layoutRows,
		layoutWeightSum: designerNumber(
			effectiveLayoutPropertyExpression(properties, definitions, layout, "weightSum"),
			definitions
		),
		margin: designerBoxSpacing(properties, definition, definitions, {
			bottom: "bottomMargin", left: "leftMargin", right: "rightMargin", top: "topMargin"
		}, Number.MIN_SAFE_INTEGER),
		name,
		padding: designerBoxSpacing(properties, definition, definitions, {
			bottom: "paddingBottom", left: "paddingLeft", right: "paddingRight", top: "paddingTop"
		}),
		parentPath,
		path,
		positionReadOnly: parentLayout === "relative" && visual ? true : undefined,
		resizable: resizeWidth || resizeHeight,
		resizeHeight,
		resizeWidth,
		limit,
		scroll,
		scrollable,
		scrollbarEnabled: booleanProperty(properties, definition, definitions, "scrollbarEnabled"),
		singleLine: booleanProperty(properties, definition, definitions, "singleLine"),
		textComponent,
		runtimeType: definitionValue?.type?.trim() || type,
		type,
		typeName: definitionValue?.name ?? runtimeTypeShortName(type),
		visual,
		textColor: designerColor(
			effectiveProjectedPropertyExpression(
				properties,
				definition,
				definitions,
				usesHintText ? "hintTextColor" : "textColor"
			),
			definitions
		),
		width: designerLength(
			directProjectedProperty(properties, definition, definitions, "width"),
			designerDefaultLengthKind(parentLayout, "width")
		),
		weight: designerNumber(directProjectedProperty(properties, definition, definitions, "weight"), definitions)
	};
}

/** 收集组件树中的全部非可视组件，保持 XML 声明顺序。 */
function collectNonVisual(node: DesignerComponentNode): readonly DesignerComponentNode[] {
	return [
		...(node.visual ? [] : [node]),
		...node.children.flatMap(collectNonVisual)
	];
}

/** 按 SDK 清单分类返回全部可实例化组件，入口窗口不作为候选子组件。 */
function toolboxGroups(
	sdk: Sdk | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): readonly DesignerToolboxGroup[] {
	if (sdk === undefined) {
		return [];
	}
	const used = new Set<string>();
	const groups = new Map<string, DesignerToolboxItem[]>();
	for (const manifest of sdk.manifests) {
		for (const category of manifest.categories) {
			const candidates = category.definitions.filter((definition) => (
				isComponentDefinition(definition) && !isWindowDefinition(definition)
			));
			if (candidates.length === 0) continue;

			let group = groups.get(category.name);
			if (group === undefined) {
				group = [];
				groups.set(category.name, group);
			}
			for (const definition of candidates) {
				if (
					used.has(definition.name)
				) {
					continue;
				}
				used.add(definition.name);
				group.push({
					container: isContainerDefinition(definition),
					description: definition.description,
					icon: resolveDefinitionIconPath(definitions.get(definition.name)),
					name: definition.name,
					relativeRuleLabels: isVisualComponentDefinition(definition)
						? relativeRuleLabels(definitions.get(definition.name), definitions)
						: undefined,
					runtimeType: definition.type?.trim() || definition.name,
					visual: isVisualComponentDefinition(definition)
				});
			}
		}
	}
	return [...groups]
		.filter(([, items]) => items.length > 0)
		.map(([name, items]) => ({
			items,
			name
		}));
}

/** 使用同一份 SDK 定义索引建立模型，供一次设计器操作复用。 */
function createSimpleDesignerModelFromDefinitions(
	document: SimplePropertyXmlDocument | undefined,
	sdk: Sdk | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>,
	selectedPath?: string
): SimpleDesignerModel {
	const toolbox = toolboxGroups(sdk, definitions);
	if (document === undefined || document.status === "damaged") {
		return {
			emptyMessage: "当前单元没有可安全操作的 XML 属性模型。",
			nonVisualComponents: [],
			toolbox
		};
	}
	const rootElement = getPropertyXmlChildren(document.root, "定义")[0];
	const root = rootElement === undefined
		? undefined
		: createComponentNode(document, rootElement, definitions);
	if (root === undefined || !isWindowDefinition(definitions.get(root.type)?.definition)) {
		return {
			emptyMessage: "可视化设计器暂时只支持窗口单元。",
			nonVisualComponents: [],
			toolbox
		};
	}
	const resolvedSelection = selectedPath === undefined
		? undefined
		: resolvePropertyXmlElement(document, selectedPath);
	return {
		nonVisualComponents: root.children.flatMap(collectNonVisual),
		root,
		selectedPath: resolvedSelection === undefined ? root.path : selectedPath,
		toolbox
	};
}

/** 建立第一阶段设计器模型；源 XML 文档始终是唯一组件状态。 */
export function createSimpleDesignerModel(
	document: SimplePropertyXmlDocument | undefined,
	sdk: Sdk | undefined,
	selectedPath?: string
): SimpleDesignerModel {
	return createSimpleDesignerModelFromDefinitions(
		document,
		sdk,
		buildDefinitionIndex(sdk?.manifests ?? []),
		selectedPath
	);
}

/** 返回指定候选组件的 SDK 定义。 */
/** 为每次拖入产生当前 XML 文档中唯一的 Simple 组件名称。 */
function createComponentName(
	document: SimplePropertyXmlDocument,
	sdk: Sdk | undefined,
	componentType: string,
	unavailableNames?: ReadonlySet<string>
): string {
	const names = new Set([
		...collectUnavailableComponentNames(document),
		...(unavailableNames ?? [])
	]);
	const baseName = componentNameValidationError(componentType + "1", sdk) === undefined
		? componentType
		: "组件";
	for (let index = 1; ; index += 1) {
		const name = baseName + index;
		if (!names.has(name) && componentNameValidationError(name, sdk) === undefined) {
			return name;
		}
	}
}

/**
 * 窗口根节点中的可视组件不得插到非可视组件之后。
 *
 * 显式落点已在可视区时保留原顺序；没有落点或落点越过第一个非可视组件时，
 * 统一改为插在第一个非可视组件之前。
 */
function rootVisualComponentInsertion(
	root: DesignerComponentNode,
	insertion: DesignerComponentInsertion | undefined
): DesignerComponentInsertion | undefined {
	const firstNonVisualIndex = root.children.findIndex((child) => !child.visual);
	if (firstNonVisualIndex < 0) return insertion;
	const firstNonVisual = root.children[firstNonVisualIndex];
	if (firstNonVisual === undefined) return insertion;
	if (insertion !== undefined) {
		const referenceIndex = root.children.findIndex((child) => child.path === insertion.referenceXmlPath);
		const insertionIndex = referenceIndex + (insertion.position === "after" ? 1 : 0);
		if (referenceIndex >= 0 && insertionIndex <= firstNonVisualIndex) return insertion;
	}
	return { position: "before", referenceXmlPath: firstNonVisual.path };
}

interface DesignerComponentPlacement {
	readonly insertion?: DesignerComponentInsertion;
	readonly parent: DesignerComponentNode;
}

/**
 * 将所有组件位置操作收口到同一条 XML 结构规则。
 *
 * 非可视组件只能位于窗口根节点，并且只能相对已经处于全部可视组件之后的直属
 * 非可视组件排序；窗口直属可视组件不能越过第一个非可视组件。
 */
function resolveDesignerComponentPlacement(
	root: DesignerComponentNode,
	requestedParentPath: string,
	visual: boolean,
	insertion?: DesignerComponentInsertion,
	componentPath?: string
): DesignerComponentPlacement | undefined {
	if (!visual) {
		const referenceIndex = insertion === undefined
			? -1
			: root.children.findIndex((child) => child.path === insertion.referenceXmlPath);
		const reference = referenceIndex < 0 ? undefined : root.children[referenceIndex];
		let lastVisualIndex = -1;
		for (const [index, child] of root.children.entries()) {
			if (child.visual) lastVisualIndex = index;
		}
		const safeInsertion = reference !== undefined
			&& reference.path !== componentPath
			&& !reference.visual
			&& reference.parentPath === root.path
			&& referenceIndex > lastVisualIndex
				? insertion
				: undefined;
		return { insertion: safeInsertion, parent: root };
	}
	const parent = findDesignerComponentNode(root, requestedParentPath);
	if (parent === undefined) return undefined;
	return {
		insertion: parent.path === root.path
			? rootVisualComponentInsertion(root, insertion)
			: insertion,
		parent
	};
}

/** 校验表格单元格并拒绝越界或已由其他可视组件占用的位置。 */
function validateDesignerGridPosition(
	parent: DesignerComponentNode,
	position: DesignerGridPosition,
	excludedPath?: string
): void {
	if (parent.layout !== "grid") {
		throw new Error("只有表格布局才能指定组件的行和列。");
	}
	if (
		parent.layoutGridSizeValid !== true
		|| parent.layoutColumns === undefined
		|| parent.layoutRows === undefined
	) {
		throw new Error("表格布局需要先设置有效的行数和列数。");
	}
	if (
		!Number.isSafeInteger(position.column)
		|| !Number.isSafeInteger(position.row)
		|| position.column < 0
		|| position.column >= parent.layoutColumns
		|| position.row < 0
		|| position.row >= parent.layoutRows
	) {
		throw new Error("目标单元格已经超出表格布局的行列范围。");
	}
	const occupied = parent.children.find((child) => (
		child.visual
		&& child.path !== excludedPath
		&& child.gridColumn === position.column
		&& child.gridRow === position.row
	));
	if (occupied !== undefined) {
		throw new Error(`第 ${position.row + 1} 行、第 ${position.column + 1} 列已有组件“${occupied.name}”。`);
	}
}

/** 校验绝对布局坐标，保留运行时允许的负整数位置。 */
function validateDesignerAbsolutePosition(position: DesignerAbsolutePosition): void {
	if (!Number.isSafeInteger(position.left) || !Number.isSafeInteger(position.top)) {
		throw new Error("绝对布局的左边和顶边必须是有效整数。");
	}
}

/** 在组件定义中写入表格布局使用的零基行列属性。 */
function writeDesignerGridPosition(
	document: SimplePropertyXmlDocument,
	componentPath: string,
	position: DesignerGridPosition,
	definition: LibraryDefinitionReference | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): SimplePropertyXmlDocument {
	return writeDesignerProjectedProperty(
		writeDesignerProjectedProperty(
			document,
			componentPath,
			definition,
			definitions,
			"row",
			String(position.row)
		),
		componentPath,
		definition,
		definitions,
		"column",
		String(position.column)
	);
}

/**
 * 校验设计器拖放并向 XML 属性模型追加最小组件定义。
 *
 * 非可视组件固定追加到窗口根定义末尾，因而始终位于可视组件之后。
 * 可视性、候选范围和容器能力全部来自 SDK；本函数不写 SDK 默认属性。
 */
export function addSimpleDesignerComponent(
	document: SimplePropertyXmlDocument,
	sdk: Sdk | undefined,
	componentType: string,
	parentXmlPath: string,
	target: "canvas" | "nonvisual",
	insertion?: DesignerComponentInsertion,
	gridPosition?: DesignerGridPosition,
	absolutePosition?: DesignerAbsolutePosition,
	unavailableNames?: ReadonlySet<string>,
	relativePlacement?: DesignerRelativePlacement,
	framePlacement?: DesignerFramePlacement
): AddDesignerComponentResult {
	if (document.status === "damaged") {
		throw new Error("当前单元没有可安全修改的 XML 属性模型。");
	}
	const definitions = buildDefinitionIndex(sdk?.manifests ?? []);
	const model = createSimpleDesignerModelFromDefinitions(document, sdk, definitions);
	const toolboxItem = model.toolbox
		.flatMap((group) => group.items)
		.find((item) => item.name === componentType);
	const definitionReference = definitions.get(componentType);
	const definition = definitionReference?.definition;
	if (toolboxItem === undefined || definition === undefined) {
		throw new Error("SDK 中没有该候选组件：" + componentType);
	}
	if ((target === "canvas") !== toolboxItem.visual) {
		throw new Error(toolboxItem.visual ? "可视组件只能拖入窗口或面板。" : "非可视组件只能拖入组件列表。");
	}
	if (model.root === undefined) {
		throw new Error("当前单元没有可插入非可视组件的窗口根节点。");
	}
	const placement = resolveDesignerComponentPlacement(
		model.root,
		parentXmlPath,
		toolboxItem.visual,
		insertion
	);
	if (placement === undefined) {
		throw new Error("拖放目标已经变化，请重新选择容器。");
	}
	if (toolboxItem.visual && placement.parent.childrenLayoutReadOnly === true) {
		throw new Error("当前布局尚未适配，只能查看和复制其中的组件。");
	}
	const resolvedParentXmlPath = placement.parent.path;
	const resolvedInsertion = placement.insertion;
	const parent = resolvePropertyXmlElement(document, resolvedParentXmlPath);
	if (parent === undefined || parent.name !== "定义") {
		throw new Error("拖放目标已经变化，请重新选择容器。");
	}
	const parentType = getPropertyXmlAttribute(parent, "组件") ?? "";
	const parentDefinition = definitions.get(parentType)?.definition;
	if (!isContainerDefinition(parentDefinition)) {
		throw new Error("组件“" + parentType + "”不能承载子组件。");
	}
	const parentNode = placement.parent;
	if (toolboxItem.visual && !canDesignerContainerAcceptVisualChild(parentNode)) {
		throw new Error(`容器最多只能直接包含 ${parentNode.limit} 个可视组件；可先放入面板承载多个组件。`);
	}
	if (toolboxItem.visual && parentNode.layout === "grid") {
		if (gridPosition === undefined) {
			throw new Error("请把组件拖入表格布局中的具体单元格。");
		}
		if (insertion !== undefined) {
			throw new Error("表格布局按行列定位组件，不能同时指定 XML 插入位置。");
		}
		validateDesignerGridPosition(parentNode, gridPosition);
	} else if (gridPosition !== undefined) {
		throw new Error("当前拖放目标不是表格布局单元格。");
	}
	if (toolboxItem.visual && parentNode.layout === "absolute") {
		if (absolutePosition !== undefined) validateDesignerAbsolutePosition(absolutePosition);
	} else if (absolutePosition !== undefined) {
		throw new Error("当前拖放目标不是绝对布局。");
	}
	if (toolboxItem.visual && parentNode.layout === "relative") {
		if (gridPosition !== undefined || absolutePosition !== undefined || framePlacement !== undefined) {
			throw new Error("相对布局不能同时使用其它布局位置。");
		}
	} else if (relativePlacement !== undefined) {
		throw new Error("当前拖放目标不是相对布局。");
	}
	if (toolboxItem.visual && parentNode.layout === "frame") {
		if (gridPosition !== undefined || absolutePosition !== undefined || relativePlacement !== undefined) {
			throw new Error("单帧布局不能同时使用其它布局位置。");
		}
		if (framePlacement !== undefined) {
			if (resolvedInsertion !== undefined) {
				throw new Error("单帧布局位置拖拽不能同时指定 XML 插入位置。");
			}
			validateDesignerFramePlacement(framePlacement);
		}
	} else if (framePlacement !== undefined) {
		throw new Error("当前拖放目标不是单帧布局。");
	}
	if (resolvedInsertion !== undefined) {
		const reference = resolvePropertyXmlElement(document, resolvedInsertion.referenceXmlPath);
		if (reference?.name !== "定义") {
			throw new Error("拖放插入位置已经变化，请重新选择。");
		}
		const referenceType = getPropertyXmlAttribute(reference, "组件") ?? "";
		const referenceItem = model.toolbox
			.flatMap((group) => group.items)
			.find((item) => item.name === referenceType);
		const rootVisualBoundary = toolboxItem.visual
			&& parentNode.path === model.root?.path
			&& resolvedInsertion.position === "before"
			&& parentNode.children.find((child) => !child.visual)?.path === resolvedInsertion.referenceXmlPath;
		if (!rootVisualBoundary && (referenceItem === undefined || referenceItem.visual !== toolboxItem.visual)) {
			throw new Error("新组件只能插入到同类可视性的兄弟组件之间。");
		}
	}
	const componentName = createComponentName(document, sdk, componentType, unavailableNames);
	const textPropertyName = projectedProperty(definitionReference, definitions, "text")?.name;
	const initialProperties = textPropertyName !== undefined
		? [createPropertyXmlElement("赋值", {
			"属性": textPropertyName,
			"值": serializeSimpleStringLiteral(componentName)
		})]
		: [];
	if (gridPosition !== undefined) {
		const rowPropertyName = requiredProjectedPropertyName(definitionReference, definitions, "row");
		const columnPropertyName = requiredProjectedPropertyName(definitionReference, definitions, "column");
		initialProperties.push(
			createPropertyXmlElement("赋值", { "属性": rowPropertyName, "值": String(gridPosition.row) }),
			createPropertyXmlElement("赋值", { "属性": columnPropertyName, "值": String(gridPosition.column) })
		);
	} else if (absolutePosition !== undefined) {
		const xPropertyName = requiredProjectedPropertyName(definitionReference, definitions, "x");
		const yPropertyName = requiredProjectedPropertyName(definitionReference, definitions, "y");
		initialProperties.push(
			createPropertyXmlElement("赋值", {
				"属性": xPropertyName,
				"值": designerDpExpression(absolutePosition.left)
			}),
			createPropertyXmlElement("赋值", {
				"属性": yPropertyName,
				"值": designerDpExpression(absolutePosition.top)
			})
		);
	}
	const component = createPropertyXmlElement(
		"定义",
		{
			"名称": componentName,
			"组件": componentType
		},
		initialProperties
	);
	const updatedDocument = resolvedInsertion === undefined
		? appendPropertyXmlElement(document, resolvedParentXmlPath, component)
		: insertPropertyXmlElement(
			document,
			resolvedParentXmlPath,
			component,
			resolvedInsertion.referenceXmlPath,
			resolvedInsertion.position
		);
	const componentPath = findPropertyXmlElementPath(updatedDocument, component);
	if (componentPath === undefined) {
		throw new Error("无法定位新建组件。");
	}
	const relativeResult = relativePlacement === undefined
		? undefined
		: placeSimpleDesignerRelativeComponent(updatedDocument, sdk, componentPath, relativePlacement);
	const placedDocument = relativeResult?.document ?? (framePlacement !== undefined
		? writeDesignerFramePlacement(
			updatedDocument,
			componentPath,
			framePlacement,
			definitionReference,
			definitions
		)
		: updatedDocument);
	return { componentPath: relativeResult?.selectedPath ?? componentPath, document: placedDocument };
}

/** 返回目标组件的直接父组件；窗口根节点没有父组件。 */
function findDesignerComponentParent(
	root: DesignerComponentNode,
	targetPath: string
): DesignerComponentNode | undefined {
	for (const child of root.children) {
		if (child.path === targetPath) {
			return root;
		}
		const nested = findDesignerComponentParent(child, targetPath);
		if (nested !== undefined) {
			return nested;
		}
	}
	return undefined;
}

/** 返回组件定义中由 simple.anchor 声明的锚点属性名称。 */
function designerAnchorPropertyNames(
	componentType: string,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): ReadonlySet<string> {
	const definition = definitions.get(componentType);
	if (definition === undefined) return new Set();
	return new Set(
		getEffectiveMembers(definition, "properties", definitions)
			.filter((property) => property.member.projection !== undefined
				&& RELATIVE_ANCHOR_PROJECTION_SET.has(property.member.projection))
			.map((property) => property.member.name)
	);
}

/** 删除一个组件中满足条件的锚点赋值，重复赋值也逐个安全移除。 */
function removeDesignerAnchorAssignments(
	document: SimplePropertyXmlDocument,
	component: DesignerComponentNode,
	anchorNames: ReadonlySet<string>,
	value?: string
): SimplePropertyXmlDocument {
	let updatedDocument = document;
	while (true) {
		const element = resolvePropertyXmlElement(updatedDocument, component.path);
		const assignment = element === undefined
			? undefined
			: getPropertyXmlChildren(element, "赋值").find((candidate) =>
				anchorNames.has(getPropertyXmlAttribute(candidate, "属性") ?? "")
				&& (value === undefined || getPropertyXmlAttribute(candidate, "值") === value)
			);
		if (assignment === undefined) return updatedDocument;
		const assignmentPath = findPropertyXmlElementPath(updatedDocument, assignment);
		if (assignmentPath === undefined) return updatedDocument;
		updatedDocument = removePropertyXmlElement(updatedDocument, assignmentPath);
	}
}

/**
 * 组件脱离原父容器时清理已经失效的兄弟锚点。
 *
 * 原兄弟对目标组件的引用和目标组件对原兄弟的锚点均失效；目标子树内部锚点不变。
 */
function detachSimpleDesignerComponentAnchors(
	document: SimplePropertyXmlDocument,
	sdk: Sdk | undefined,
	component: DesignerComponentNode,
	parent: DesignerComponentNode
): SimplePropertyXmlDocument {
	if (sdk === undefined) return document;
	const definitions = buildDefinitionIndex(sdk.manifests);
	const idPropertyName = projectedProperty(definitions.get(component.type), definitions, "id")?.name;
	const targetExpression = idPropertyName === undefined ? undefined : `${component.name}.${idPropertyName}`;
	let updatedDocument = document;

	if (targetExpression !== undefined) {
		for (const sibling of parent.children) {
			if (sibling.path === component.path) continue;
			updatedDocument = removeDesignerAnchorAssignments(
				updatedDocument,
				sibling,
				designerAnchorPropertyNames(sibling.type, definitions),
				targetExpression
			);
		}
	}
	return removeDesignerAnchorAssignments(
		updatedDocument,
		component,
		designerAnchorPropertyNames(component.type, definitions)
	);
}

/**
 * 校验并删除一个设计器组件定义。
 *
 * 删除只作用于 XML 属性区，先清理直接兄弟对目标组件的失效锚点，再删除完整 `定义`
 * 子树；用户代码保持逐字不变，窗口根组件不允许删除。删除后选择回到仍然存在的直接父组件。
 */
export function deleteSimpleDesignerComponent(
	document: SimplePropertyXmlDocument,
	sdk: Sdk | undefined,
	componentXmlPath: string
): DeleteDesignerComponentResult {
	if (document.status === "damaged") {
		throw new Error("当前单元没有可安全修改的 XML 属性模型。");
	}
	const model = createSimpleDesignerModel(document, sdk);
	const root = model.root;
	if (root === undefined) {
		throw new Error("当前单元没有可删除的窗口组件树。");
	}
	if (componentXmlPath === root.path) {
		throw new Error("窗口根组件不能删除。");
	}
	const parent = findDesignerComponentParent(root, componentXmlPath);
	const component = findDesignerComponentNode(root, componentXmlPath);
	const target = resolvePropertyXmlElement(document, componentXmlPath);
	if (parent === undefined || component === undefined || target?.name !== "定义") {
		throw new Error("删除目标已经变化，请重新选择组件。");
	}
	if (component.layoutReadOnly === true) {
		throw new Error("当前布局尚未适配，只能查看和复制其中的组件。");
	}
	const detachedDocument = detachSimpleDesignerComponentAnchors(document, sdk, component, parent);
	return {
		document: removePropertyXmlElement(detachedDocument, componentXmlPath),
		selectedPath: parent.path
	};
}

/**
 * 校验并把一个设计器组件定义转换为剪贴板文本。
 *
 * 复制不修改 XML 文档；窗口根组件不作为普通组件复制。剪贴板内容是目标 XML
 * `定义`节点及其完整子树，不包含 XML 声明。
 */
export function copySimpleDesignerComponent(
	document: SimplePropertyXmlDocument,
	sdk: Sdk | undefined,
	componentXmlPath: string
): CopyDesignerComponentResult {
	if (document.status === "damaged") {
		throw new Error("当前单元没有可安全读取的 XML 属性模型。");
	}
	const model = createSimpleDesignerModel(document, sdk);
	const root = model.root;
	if (root === undefined) {
		throw new Error("当前单元没有可复制的窗口组件树。");
	}
	if (componentXmlPath === root.path) {
		throw new Error("窗口根组件不能复制。");
	}
	const parent = findDesignerComponentParent(root, componentXmlPath);
	const target = resolvePropertyXmlElement(document, componentXmlPath);
	if (parent === undefined || target?.name !== "定义") {
		throw new Error("复制目标已经变化，请重新选择组件。");
	}
	return { text: serializePropertyXmlElement(target) };
}

/** 按 XML 路径查找组件树中的真实节点。 */
export function findDesignerComponentNode(
	root: DesignerComponentNode,
	targetPath: string
): DesignerComponentNode | undefined {
	if (root.path === targetPath) {
		return root;
	}
	for (const child of root.children) {
		const nested = findDesignerComponentNode(child, targetPath);
		if (nested !== undefined) {
			return nested;
		}
	}
	return undefined;
}

/**
 * 判断容器当前是否还能接收一个直属可视子组件。
 *
 * 数量上限来自 SDK 容器投影；移动现有直属子组件时排除源路径，非可视组件不占用数量。
 */
export function canDesignerContainerAcceptVisualChild(
	parent: DesignerComponentNode,
	excludedPath?: string
): boolean {
	if (!parent.container || parent.childrenLayoutReadOnly === true) return false;
	if (parent.limit !== undefined) {
		return parent.children.filter((child) => child.visual && child.path !== excludedPath).length < parent.limit;
	}
	return parent.acceptsVisualChild !== false;
}

/** 按运行库 ViewUtil 的重心映射提取水平和垂直对齐分量。 */
function designerAlignment(
	expression: string | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): DesignerAlignment | undefined {
	const value = resolveSdkConstantValue(expression, definitions);
	if (value === undefined) return undefined;
	const horizontal = horizontalContentAlignment(value);
	let vertical: DesignerAlignment["vertical"];
	if (["3", "6", "10", "13"].includes(value) || /(?:^|\.)对齐_(?:上|左上|中上|右上)$/u.test(value)) {
		vertical = "top";
	} else if (["4", "8", "11", "14"].includes(value) || /(?:^|\.)对齐_(?:垂直居中|左中|居中|右中)$/u.test(value)) {
		vertical = "center";
	} else if (["5", "9", "12", "15"].includes(value) || /(?:^|\.)对齐_(?:下|左下|中下|右下)$/u.test(value)) {
		vertical = "bottom";
	}
	return horizontal === undefined && vertical === undefined ? undefined : { horizontal, vertical };
}

/** 为剪贴板组件名称生成当前 XML 文档中唯一的名称。 */
function uniquePastedComponentName(
	preferredName: string,
	usedNames: Set<string>,
	sdk: Sdk | undefined
): string {
	const validationError = componentNameValidationError(preferredName, sdk);
	if (validationError !== undefined) throw new Error(validationError);
	for (let increment = 0; ; increment += 1) {
		const candidate = copyNameCandidate(preferredName, increment);
		if (!usedNames.has(candidate) && componentNameValidationError(candidate, sdk) === undefined) {
			usedNames.add(candidate);
			return candidate;
		}
	}
}

/** 校验并复制一个剪贴板定义子树，同时消除与当前文档的组件名称冲突。 */
function preparePastedComponentDefinition(
	element: PropertyXmlElement,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>,
	usedNames: Set<string>,
	sdk: Sdk | undefined
): PropertyXmlElement {
	if (element.name !== "定义") {
		throw new Error("剪贴板内容不是组件定义 XML。");
	}
	const originalName = getPropertyXmlAttribute(element, "名称");
	const componentType = getPropertyXmlAttribute(element, "组件");
	if (
		originalName === undefined
		|| originalName.trim().length === 0
		|| componentType === undefined
		|| componentType.trim().length === 0
	) {
		throw new Error("剪贴板组件定义缺少名称或组件类型。");
	}
	const definition = definitions.get(componentType)?.definition;
	if (!isComponentDefinition(definition)) {
		throw new Error("SDK 中没有剪贴板组件：" + componentType);
	}
	if (isWindowDefinition(definition)) {
		throw new Error("窗口根组件不能粘贴到其它容器中。");
	}
	const nestedDefinitions = getPropertyXmlChildren(element, "定义");
	if (nestedDefinitions.length > 0 && !isContainerDefinition(definition)) {
		throw new Error("剪贴板组件“" + componentType + "”不能承载子组件。");
	}
	const pastedName = uniquePastedComponentName(originalName, usedNames, sdk);
	const children = element.children.map((child) => child.nodeType === "element" && child.name === "定义"
		? preparePastedComponentDefinition(child, definitions, usedNames, sdk)
		: child);
	const limit = isContainerDefinition(definition) ? definition?.projection?.limit : undefined;
	if (limit !== undefined) {
		const visualChildren = children.filter((child) => (
			child.nodeType === "element"
			&& child.name === "定义"
			&& isVisualComponentDefinition(
				definitions.get(getPropertyXmlAttribute(child, "组件") ?? "")?.definition
			)
		));
		if (visualChildren.length > limit) {
			throw new Error(`剪贴板中的容器最多只能直接包含 ${limit} 个可视组件。`);
		}
	}
	return createPropertyXmlElement(
		element.name,
		pastedName === originalName
			? element.attributes
			: { ...element.attributes, "名称": pastedName },
		children,
		element.temporary
	);
}

/** 剪贴板组件子树不得夹带需要单独落到窗口根节点的嵌套非可视组件。 */
function hasNestedNonVisualComponent(
	element: PropertyXmlElement,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): boolean {
	for (const child of element.children) {
		if (child.nodeType !== "element" || child.name !== "定义") continue;
		const childType = getPropertyXmlAttribute(child, "组件") ?? "";
		if (!isVisualComponentDefinition(definitions.get(childType)?.definition)) return true;
		if (hasNestedNonVisualComponent(child, definitions)) return true;
	}
	return false;
}

/** 判断系统剪贴板文本是否是一棵可由当前 SDK 识别的组件定义子树。 */
export function isSimpleDesignerComponentClipboardText(
	clipboardText: string,
	sdk: Sdk | undefined
): boolean {
	if (clipboardText.trim().length === 0) return false;
	try {
		const definitions = buildDefinitionIndex(sdk?.manifests ?? []);
		const component = preparePastedComponentDefinition(
			parsePropertyXmlElement(clipboardText),
			definitions,
			new Set<string>(),
			sdk
		);
		return !hasNestedNonVisualComponent(component, definitions);
	} catch {
		return false;
	}
}

/**
 * 把剪贴板中的单个 XML `定义`子树追加到指定容器。
 *
 * 粘贴只修改当前 XML 属性文档；目标容器和整个子树的组件类型均由 SDK 校验，
 * 与当前文档冲突的组件名称按顺序增加数字后缀。
 */
export function pasteSimpleDesignerComponent(
	document: SimplePropertyXmlDocument,
	sdk: Sdk | undefined,
	parentXmlPath: string,
	clipboardText: string,
	gridPosition?: DesignerGridPosition,
	unavailableNames?: ReadonlySet<string>
): PasteDesignerComponentResult {
	if (document.status === "damaged") {
		throw new Error("当前单元没有可安全修改的 XML 属性模型。");
	}
	const definitions = buildDefinitionIndex(sdk?.manifests ?? []);
	if (clipboardText.trim().length === 0) {
		throw new Error("剪贴板中没有可粘贴的组件 XML。");
	}
	const usedNames = new Set([
		...collectUnavailableComponentNames(document),
		...(unavailableNames ?? [])
	]);
	const component = preparePastedComponentDefinition(
		parsePropertyXmlElement(clipboardText),
		definitions,
		usedNames,
		sdk
	);
	if (hasNestedNonVisualComponent(component, definitions)) {
		throw new Error("剪贴板中的非可视组件必须直接位于窗口根节点。");
	}
	const model = createSimpleDesignerModelFromDefinitions(document, sdk, definitions);
	if (model.root === undefined) {
		throw new Error("粘贴目标已经变化，请重新选择容器。");
	}
	const componentType = getPropertyXmlAttribute(component, "组件") ?? "";
	const pastedVisual = isVisualComponentDefinition(definitions.get(componentType)?.definition);
	const placement = resolveDesignerComponentPlacement(model.root, parentXmlPath, pastedVisual);
	if (placement === undefined) {
		throw new Error("粘贴目标已经变化，请重新选择容器。");
	}
	const parentNode = placement.parent;
	if (pastedVisual && parentNode.childrenLayoutReadOnly === true) {
		throw new Error("当前布局尚未适配，只能查看和复制其中的组件。");
	}
	const parent = resolvePropertyXmlElement(document, parentNode.path);
	if (parent?.name !== "定义") {
		throw new Error("粘贴目标已经变化，请重新选择容器。");
	}
	const parentType = getPropertyXmlAttribute(parent, "组件") ?? "";
	const parentDefinition = definitions.get(parentType)?.definition;
	if (!isContainerDefinition(parentDefinition)) {
		throw new Error("组件“" + parentType + "”不能承载子组件。");
	}
	if (pastedVisual && !canDesignerContainerAcceptVisualChild(parentNode)) {
		throw new Error(`容器最多只能直接包含 ${parentNode.limit} 个可视组件；可先放入面板承载多个组件。`);
	}
	if (pastedVisual && parentNode.layout === "grid") {
		if (gridPosition === undefined) {
			throw new Error("请先选择表格布局中的空单元格。");
		}
		validateDesignerGridPosition(parentNode, gridPosition);
	} else if (gridPosition !== undefined) {
		throw new Error("只有可视组件粘贴到表格布局时才能指定行和列。");
	}
	const updatedDocument = placement.insertion === undefined
		? appendPropertyXmlElement(document, parentNode.path, component)
		: insertPropertyXmlElement(
			document,
			parentNode.path,
			component,
			placement.insertion.referenceXmlPath,
			placement.insertion.position
		);
	const componentPath = findPropertyXmlElementPath(updatedDocument, component);
	if (componentPath === undefined) {
		throw new Error("无法定位粘贴的组件。");
	}
	return {
		componentPath,
		document: gridPosition === undefined
			? updatedDocument
			: writeDesignerGridPosition(
				updatedDocument,
				componentPath,
				gridPosition,
				definitions.get(componentType),
				definitions
			)
	};
}

/** 在不跨越可视性分区的前提下移动一个布局树组件。 */
export function moveSimpleDesignerComponent(
	document: SimplePropertyXmlDocument,
	sdk: Sdk | undefined,
	componentXmlPath: string,
	direction: "next" | "previous"
): MoveDesignerComponentResult {
	if (document.status === "damaged") {
		throw new Error("当前单元没有可安全修改的 XML 属性模型。");
	}
	const model = createSimpleDesignerModel(document, sdk);
	const root = model.root;
	if (root === undefined) {
		throw new Error("当前单元没有可移动的窗口组件树。");
	}
	if (componentXmlPath === root.path) {
		throw new Error("窗口根组件不能移动。");
	}
	const component = findDesignerComponentNode(root, componentXmlPath);
	const actualParent = findDesignerComponentParent(root, componentXmlPath);
	if (component === undefined || actualParent === undefined) {
		throw new Error("移动目标已经变化，请重新选择组件。");
	}
	if (component.layoutReadOnly === true || component.positionReadOnly === true) {
		throw new Error(component.positionReadOnly === true
			? "相对布局中的组件位置只能通过布局属性修改。"
			: "当前布局尚未适配，只能查看和复制其中的组件。");
	}
	const parent = component.visual ? actualParent : root;
	const siblings = parent.children.filter((candidate) => candidate.visual === component.visual);
	const componentIndex = siblings.findIndex((candidate) => candidate.path === component.path);
	if (componentIndex < 0) {
		return relocateSimpleDesignerComponent(document, sdk, component.path, root.path);
	}
	const reference = direction === "previous"
		? siblings[componentIndex - 1]
		: siblings[componentIndex + 1];
	if (reference === undefined) {
		return { document, selectedPath: component.path };
	}
	return relocateSimpleDesignerComponent(
		document,
		sdk,
		component.path,
		parent.path,
		{
			position: direction === "previous" ? "before" : "after",
			referenceXmlPath: reference.path
		}
	);
}

/** 跨入或移出相对布局时，清除来源布局专用的位置属性。 */
function clearDesignerSourceLayoutPlacement(
	document: SimplePropertyXmlDocument,
	component: DesignerComponentNode,
	sourceLayout: DesignerLayoutKind,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): SimplePropertyXmlDocument {
	const definition = definitions.get(component.type);
	if (sourceLayout === "relative") {
		return clearRelativeAxis(
			clearRelativeAxis(document, component.path, definition, definitions, "horizontal"),
			component.path,
			definition,
			definitions,
			"vertical"
		);
	}
	const projections: readonly LibraryPropertyProjection[] = sourceLayout === "absolute"
		? ["x", "y"]
		: sourceLayout === "grid"
			? ["row", "column"]
			: sourceLayout === "frame"
				? ["layoutGravity", "leftMargin", "topMargin", "rightMargin", "bottomMargin"]
				: [];
	return projections.reduce(
		(updated, projection) => removeDesignerProjectedProperty(
			updated,
			component.path,
			definition,
			definitions,
			projection
		),
		document
	);
}

/**
 * 把现有组件移动到另一个容器或同一容器的新插入位置。
 *
 * 组件和落点都以当前 XML 路径定位；窗口根节点、非容器目标、自身/子孙目标、
 * 不属于目标容器或可视性不同的参照节点均拒绝操作。
 */
export function relocateSimpleDesignerComponent(
	document: SimplePropertyXmlDocument,
	sdk: Sdk | undefined,
	componentXmlPath: string,
	parentXmlPath: string,
	insertion?: DesignerComponentInsertion,
	gridPosition?: DesignerGridPosition,
	absolutePosition?: DesignerAbsolutePosition,
	relativePlacement?: DesignerRelativePlacement,
	framePlacement?: DesignerFramePlacement
): RelocateDesignerComponentResult {
	if (document.status === "damaged") {
		throw new Error("当前单元没有可安全修改的 XML 属性模型。");
	}
	const definitions = buildDefinitionIndex(sdk?.manifests ?? []);
	const model = createSimpleDesignerModelFromDefinitions(document, sdk, definitions);
	const root = model.root;
	if (root === undefined) {
		throw new Error("当前单元没有可移动的窗口组件树。");
	}
	const component = findDesignerComponentNode(root, componentXmlPath);
	if (component === undefined || component.path === root.path) {
		throw new Error("组件移动目标已经变化，请重新选择组件。");
	}
	const originalParent = findDesignerComponentParent(root, component.path);
	if (originalParent === undefined) {
		throw new Error("组件移动目标已经变化，请重新选择组件。");
	}
	if (component.layoutReadOnly === true) {
		throw new Error("当前布局尚未适配，只能查看和复制其中的组件。");
	}
	const placement = resolveDesignerComponentPlacement(
		root,
		parentXmlPath,
		component.visual,
		insertion,
		component.path
	);
	const parent = placement?.parent;
	const resolvedInsertion = placement?.insertion;
	if (parent === undefined || !parent.container) {
		throw new Error("拖放目标不是可承载组件的容器。");
	}
	if (component.positionReadOnly === true && originalParent.path === parent.path) {
		throw new Error("相对布局中的组件位置只能通过布局属性修改。");
	}
	if (component.visual && parent.childrenLayoutReadOnly === true) {
		throw new Error("当前布局尚未适配，只能查看和复制其中的组件。");
	}
	if (findDesignerComponentNode(component, parent.path) !== undefined) {
		throw new Error("组件不能移动到自身或自己的子容器中。");
	}
	if (component.visual && !canDesignerContainerAcceptVisualChild(parent, component.path)) {
		throw new Error(`容器最多只能直接包含 ${parent.limit} 个可视组件；可先放入面板承载多个组件。`);
	}
	if (component.visual && parent.layout === "grid") {
		if (gridPosition === undefined) {
			throw new Error("请把组件拖入表格布局中的具体单元格。");
		}
		if (resolvedInsertion !== undefined) {
			throw new Error("表格布局按行列定位组件，不能同时指定 XML 插入位置。");
		}
		validateDesignerGridPosition(parent, gridPosition, component.path);
	} else if (gridPosition !== undefined) {
		throw new Error("当前拖放目标不是表格布局单元格。");
	}
	if (component.visual && parent.layout === "absolute") {
		if (absolutePosition !== undefined) validateDesignerAbsolutePosition(absolutePosition);
	} else if (absolutePosition !== undefined) {
		throw new Error("当前拖放目标不是绝对布局。");
	}
	if (component.visual && parent.layout === "relative") {
		if (gridPosition !== undefined || absolutePosition !== undefined || framePlacement !== undefined) {
			throw new Error("相对布局不能同时使用其它布局位置。");
		}
	} else if (relativePlacement !== undefined) {
		throw new Error("当前拖放目标不是相对布局。");
	}
	if (component.visual && parent.layout === "frame") {
		if (gridPosition !== undefined || absolutePosition !== undefined || relativePlacement !== undefined) {
			throw new Error("单帧布局不能同时使用其他布局位置。");
		}
		if (framePlacement !== undefined) {
			if (resolvedInsertion !== undefined) {
				throw new Error("单帧布局位置拖拽不能同时改变组件层叠顺序。");
			}
			validateDesignerFramePlacement(framePlacement);
		}
	} else if (framePlacement !== undefined) {
		throw new Error("当前拖放目标不是单帧布局。");
	}
	if (resolvedInsertion !== undefined) {
		const reference = findDesignerComponentNode(root, resolvedInsertion.referenceXmlPath);
		const rootVisualBoundary = component.visual
			&& parent.path === root.path
			&& resolvedInsertion.position === "before"
			&& parent.children.find((child) => !child.visual)?.path === resolvedInsertion.referenceXmlPath;
		if (
			reference === undefined
			|| reference.path === component.path
			|| reference.parentPath !== parent.path
			|| reference.visual !== component.visual && !rootVisualBoundary
		) {
			throw new Error("拖放插入位置已经变化，请重新选择。");
		}
	}
	let detachedDocument = component.parentPath === parent.path
		? document
		: detachSimpleDesignerComponentAnchors(document, sdk, component, originalParent);
	if (
		component.parentPath !== parent.path
		&& (
			originalParent.layout === "relative"
			|| parent.layout === "relative"
			|| originalParent.layout === "frame"
			|| parent.layout === "frame"
		)
	) {
		detachedDocument = clearDesignerSourceLayoutPlacement(
			detachedDocument,
			component,
			originalParent.layout,
			definitions
		);
	}
	const target = resolvePropertyXmlElement(detachedDocument, component.path);
	if (target?.name !== "定义") {
		throw new Error("组件移动目标已经变化，请重新选择组件。");
	}
	const nonVisualAlreadyLast = !component.visual
		&& component.parentPath === root.path
		&& root.children.at(-1)?.path === component.path;
	const updatedDocument = component.parentPath === parent.path
		&& resolvedInsertion === undefined
		&& (component.visual || nonVisualAlreadyLast)
		? detachedDocument
		: relocatePropertyXmlElement(
			detachedDocument,
			component.path,
			parent.path,
			resolvedInsertion?.referenceXmlPath,
			resolvedInsertion?.position
		);
	let selectedPath = findPropertyXmlElementPath(updatedDocument, target);
	if (selectedPath === undefined) {
		throw new Error("移动后无法定位组件。");
	}
	let placedDocument = gridPosition !== undefined
		? writeDesignerGridPosition(
			updatedDocument,
			selectedPath,
			gridPosition,
			definitions.get(component.type),
			definitions
		)
		: absolutePosition !== undefined
			? writeDesignerAbsolutePosition(
				updatedDocument,
				selectedPath,
				absolutePosition,
				definitions.get(component.type),
				definitions
			)
			: framePlacement !== undefined
				? writeDesignerFramePlacement(
					updatedDocument,
					selectedPath,
					framePlacement,
					definitions.get(component.type),
					definitions
				)
				: updatedDocument;
	if (relativePlacement !== undefined) {
		const targetNames = {
			horizontal: relativePlacement.horizontalDock?.targetXmlPath === undefined
				? undefined
				: findDesignerComponentNode(root, relativePlacement.horizontalDock.targetXmlPath)?.name,
			vertical: relativePlacement.verticalDock?.targetXmlPath === undefined
				? undefined
				: findDesignerComponentNode(root, relativePlacement.verticalDock.targetXmlPath)?.name
		};
		const placedModel = createSimpleDesignerModelFromDefinitions(placedDocument, sdk, definitions);
		const placedComponent = placedModel.root === undefined
			? undefined
			: findDesignerComponentNode(placedModel.root, selectedPath);
		const placedParent = placedComponent?.parentPath === undefined || placedModel.root === undefined
			? undefined
			: findDesignerComponentNode(placedModel.root, placedComponent.parentPath);
		if (placedComponent === undefined || placedParent?.layout !== "relative") {
			throw new Error("移动后的相对布局目标已经变化，请重新拖动组件。");
		}
		const rebaseDock = (
			dock: DesignerRelativeDock | undefined,
			targetName: string | undefined
		): DesignerRelativeDock | undefined => {
			if (dock?.targetXmlPath === undefined) return dock;
			const targetComponent = placedParent.children.find((child) => child.name === targetName);
			if (targetComponent === undefined) {
				throw new Error("相对布局停靠目标已经变化，请重新拖动组件。");
			}
			return { ...dock, targetXmlPath: targetComponent.path };
		};
		const relativeResult = placeSimpleDesignerRelativeComponent(placedDocument, sdk, selectedPath, {
			...relativePlacement,
			horizontalDock: rebaseDock(relativePlacement.horizontalDock, targetNames.horizontal),
			verticalDock: rebaseDock(relativePlacement.verticalDock, targetNames.vertical)
		});
		placedDocument = relativeResult.document;
		selectedPath = relativeResult.selectedPath;
	}
	return { document: placedDocument, selectedPath };
}

/** 校验一次画布尺寸拖动；尺寸非负，绝对布局坐标允许负值。 */
function validateDesignerComponentResize(resize: DesignerComponentResize): void {
	if (resize.width === undefined && resize.height === undefined) {
		throw new Error("组件尺寸没有发生变化。");
	}
	for (const [name, value] of [["宽度", resize.width], ["高度", resize.height]] as const) {
		if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
			throw new Error(`组件${name}必须是非负整数。`);
		}
	}
	if (resize.left !== undefined && resize.width === undefined) {
		throw new Error("调整左边位置时必须同时提供宽度。");
	}
	if (resize.top !== undefined && resize.height === undefined) {
		throw new Error("调整顶边位置时必须同时提供高度。");
	}
	if (resize.left !== undefined && !Number.isSafeInteger(resize.left)) {
		throw new Error("绝对布局的左边必须是有效整数。");
	}
	if (resize.top !== undefined && !Number.isSafeInteger(resize.top)) {
		throw new Error("绝对布局的顶边必须是有效整数。");
	}
}

/**
 * 把画布拖动尺寸写回组件的宽度和高度；绝对布局从左侧或顶部调整时同步坐标。
 *
 * 每个实际变化的方向独立写为 `"Ndp"`，未变化方向保留原有适应内容、匹配父级或表达式。
 */
export function resizeSimpleDesignerComponent(
	document: SimplePropertyXmlDocument,
	sdk: Sdk | undefined,
	componentXmlPath: string,
	resize: DesignerComponentResize
): ResizeDesignerComponentResult {
	if (document.status === "damaged") {
		throw new Error("当前单元没有可安全修改的 XML 属性模型。");
	}
	validateDesignerComponentResize(resize);
	const definitions = buildDefinitionIndex(sdk?.manifests ?? []);
	const model = createSimpleDesignerModelFromDefinitions(document, sdk, definitions);
	const root = model.root;
	const component = root === undefined ? undefined : findDesignerComponentNode(root, componentXmlPath);
	if (
		component === undefined
		|| component.path === root?.path
		|| component.layoutReadOnly === true
		|| component.resizable !== true
	) {
		throw new Error("当前组件的尺寸不能通过画布调整。");
	}
	if (resize.width !== undefined && component.resizeWidth !== true) {
		throw new Error("当前组件的宽度不能通过画布调整。");
	}
	if (resize.height !== undefined && component.resizeHeight !== true) {
		throw new Error("当前组件的高度不能通过画布调整。");
	}
	const parent = component.parentPath === undefined || root === undefined
		? undefined
		: findDesignerComponentNode(root, component.parentPath);
	if ((resize.left !== undefined || resize.top !== undefined) && parent?.layout !== "absolute") {
		throw new Error("只有绝对布局中的组件才能随尺寸同步修改左边或顶边。");
	}
	let updated = document;
	const definition = definitions.get(component.type);
	for (const [projection, value] of [["width", resize.width], ["height", resize.height]] as const) {
		if (value === undefined) continue;
		updated = writeDesignerProjectedProperty(
			updated,
			component.path,
			definition,
			definitions,
			projection,
			designerDpExpression(value)
		);
	}
	for (const [projection, value] of [["x", resize.left], ["y", resize.top]] as const) {
		if (value === undefined) continue;
		updated = writeDesignerProjectedProperty(
			updated,
			component.path,
			definition,
			definitions,
			projection,
			designerDpExpression(value)
		);
	}
	return { document: updated, selectedPath: component.path };
}

/**
 * 把绝对布局中已选可视子组件按相对 DIP 位移写回 XML。
 *
 * 每条消息都在宿主的串行文档事务中读取最新位置，避免长按方向键时覆盖尚未回传的前一次移动。
 */
export function nudgeSimpleDesignerComponent(
	document: SimplePropertyXmlDocument,
	sdk: Sdk | undefined,
	componentXmlPath: string,
	nudge: DesignerComponentNudge
): ResizeDesignerComponentResult {
	if (document.status === "damaged") {
		throw new Error("当前单元没有可安全修改的 XML 属性模型。");
	}
	if (
		!Number.isSafeInteger(nudge.deltaLeft)
		|| !Number.isSafeInteger(nudge.deltaTop)
		|| Math.abs(nudge.deltaLeft) + Math.abs(nudge.deltaTop) !== 1
	) {
		throw new Error("方向键移动必须是单一方向的 1dip 位移。");
	}
	const definitions = buildDefinitionIndex(sdk?.manifests ?? []);
	const model = createSimpleDesignerModelFromDefinitions(document, sdk, definitions);
	const root = model.root;
	const component = root === undefined ? undefined : findDesignerComponentNode(root, componentXmlPath);
	const parent = component?.parentPath === undefined || root === undefined
		? undefined
		: findDesignerComponentNode(root, component.parentPath);
	if (
		component === undefined
		|| component.path === root?.path
		|| component.layoutReadOnly === true
		|| component.visual !== true
		|| component.absolutePosition === undefined
		|| parent?.layout !== "absolute"
	) {
		throw new Error("只有绝对布局中的可视子组件才能使用方向键移动。");
	}
	return {
		document: writeDesignerAbsolutePosition(
			document,
			component.path,
			{
				left: component.absolutePosition.left + nudge.deltaLeft,
				top: component.absolutePosition.top + nudge.deltaTop
			},
			definitions.get(component.type),
			definitions
		),
		selectedPath: component.path
	};
}

const RELATIVE_LEFT_MARGIN_RULES = [
	"rightOf",
	"endOf",
	"alignLeft",
	"alignStart",
	"alignParentLeft",
	"alignParentStart"
] as const satisfies readonly (keyof DesignerRelativeRules)[];

const RELATIVE_RIGHT_MARGIN_RULES = [
	"leftOf",
	"startOf",
	"alignRight",
	"alignEnd",
	"alignParentRight",
	"alignParentEnd"
] as const satisfies readonly (keyof DesignerRelativeRules)[];

const RELATIVE_TOP_MARGIN_RULES = [
	"below",
	"alignTop",
	"alignParentTop"
] as const satisfies readonly (keyof DesignerRelativeRules)[];

const RELATIVE_BOTTOM_MARGIN_RULES = [
	"above",
	"alignBaseline",
	"alignBottom",
	"alignParentBottom"
] as const satisfies readonly (keyof DesignerRelativeRules)[];

const RELATIVE_HORIZONTAL_RULE_PROJECTIONS = [
	"leftOf",
	"rightOf",
	"startOf",
	"endOf",
	"alignLeft",
	"alignRight",
	"alignStart",
	"alignEnd",
	"alignParentLeft",
	"alignParentRight",
	"alignParentStart",
	"alignParentEnd",
	"centerHorizontal",
	"centerInParent"
] as const satisfies readonly LibraryPropertyProjection[];

const RELATIVE_VERTICAL_RULE_PROJECTIONS = [
	"above",
	"below",
	"alignBaseline",
	"alignTop",
	"alignBottom",
	"alignParentTop",
	"alignParentBottom",
	"centerVertical",
	"centerInParent"
] as const satisfies readonly LibraryPropertyProjection[];

const RELATIVE_HORIZONTAL_DOCK_PROJECTIONS: ReadonlySet<LibraryPropertyProjection> = new Set([
	"alignParentLeft",
	"alignParentRight",
	"centerHorizontal",
	"centerInParent",
	"alignLeft",
	"alignRight",
	"leftOf",
	"rightOf"
]);

const RELATIVE_VERTICAL_DOCK_PROJECTIONS: ReadonlySet<LibraryPropertyProjection> = new Set([
	"alignParentTop",
	"alignParentBottom",
	"centerVertical",
	"centerInParent",
	"alignTop",
	"alignBottom",
	"above",
	"below"
]);

/** 判断一组相对布局规则中是否至少有一项生效。 */
function hasRelativeRule(
	rules: DesignerRelativeRules,
	candidates: readonly (keyof DesignerRelativeRules)[]
): boolean {
	return candidates.some((candidate) => rules[candidate] !== undefined && rules[candidate] !== false);
}

/** 返回一个相对布局组件当前能够解析到直属兄弟的全部锚点路径。 */
function relativeAnchorPaths(component: DesignerComponentNode): readonly string[] {
	const paths = new Set<string>();
	for (const projection of RELATIVE_ANCHOR_PROJECTIONS) {
		const path = component.relativeRules?.[projection];
		if (typeof path === "string") paths.add(path);
	}
	return [...paths];
}

/** 判断一个兄弟锚点是否直接或间接依赖当前操作组件。 */
function relativeAnchorDependsOn(
	componentPath: string,
	targetPath: string,
	components: ReadonlyMap<string, DesignerComponentNode>,
	visited: Set<string>
): boolean {
	if (componentPath === targetPath) return true;
	if (visited.has(componentPath)) return false;
	visited.add(componentPath);
	const component = components.get(componentPath);
	return component !== undefined && relativeAnchorPaths(component)
		.some((path) => relativeAnchorDependsOn(path, targetPath, components, visited));
}

/**
 * 在相对兄弟规则正式提交后，保证操作组件排在它当前引用的全部兄弟锚点之后。
 *
 * changedPropertyName 仅供属性框限制触发范围；画布放下时省略该参数并检查最终规则集合。
 */
export function ensureSimpleDesignerRelativeAnchorOrder(
	document: SimplePropertyXmlDocument,
	sdk: Sdk | undefined,
	componentXmlPath: string,
	changedPropertyName?: string
): ResizeDesignerComponentResult {
	if (document.status === "damaged") {
		throw new Error("当前单元没有可安全修改的 XML 属性模型。");
	}
	const definitions = buildDefinitionIndex(sdk?.manifests ?? []);
	const model = createSimpleDesignerModelFromDefinitions(document, sdk, definitions);
	const root = model.root;
	const component = root === undefined ? undefined : findDesignerComponentNode(root, componentXmlPath);
	const parent = component?.parentPath === undefined || root === undefined
		? undefined
		: findDesignerComponentNode(root, component.parentPath);
	if (component === undefined || parent?.layout !== "relative") {
		return { document, selectedPath: componentXmlPath };
	}
	if (changedPropertyName !== undefined) {
		const definition = definitions.get(component.type);
		const anchorPropertyNames = new Set(RELATIVE_ANCHOR_PROJECTIONS
			.map((projection) => projectedProperty(definition, definitions, projection)?.name)
			.filter((name): name is string => name !== undefined));
		if (!anchorPropertyNames.has(changedPropertyName)) {
			return { document, selectedPath: component.path };
		}
	}

	const anchorPaths = relativeAnchorPaths(component);
	if (anchorPaths.length === 0) {
		return { document, selectedPath: component.path };
	}
	const siblings = new Map(parent.children.map((child) => [child.path, child]));
	for (const anchorPath of anchorPaths) {
		if (relativeAnchorDependsOn(anchorPath, component.path, siblings, new Set())) {
			throw new Error("相对布局组件不能形成循环锚点关系。");
		}
	}
	const componentIndex = parent.children.findIndex((child) => child.path === component.path);
	const latestAnchor = anchorPaths
		.map((path) => ({ index: parent.children.findIndex((child) => child.path === path), path }))
		.filter((anchor) => anchor.index >= 0)
		.sort((left, right) => right.index - left.index)[0];
	if (latestAnchor === undefined || latestAnchor.index < componentIndex) {
		return { document, selectedPath: component.path };
	}

	const target = resolvePropertyXmlElement(document, component.path);
	if (target?.name !== "定义") {
		throw new Error("相对布局组件顺序已经变化，请重新操作。");
	}
	const reordered = relocatePropertyXmlElement(
		document,
		component.path,
		parent.path,
		latestAnchor.path,
		"after"
	);
	const selectedPath = findPropertyXmlElementPath(reordered, target);
	if (selectedPath === undefined) {
		throw new Error("调整相对布局组件顺序后无法恢复当前选择。");
	}
	return { document: reordered, selectedPath };
}

/** 读取要参与拖拽换算的显式边距；已有但不能求值的表达式不能被画布拖动覆盖。 */
function relativeMarginValue(
	properties: ReadonlyMap<string, string | undefined>,
	definition: LibraryDefinitionReference | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>,
	projection: "bottomMargin" | "leftMargin" | "rightMargin" | "topMargin"
): number {
	const property = projectedProperty(definition, definitions, projection);
	if (property === undefined || property.writable === false) {
		throw new Error(`SDK 组件没有声明可写的 ${projection} 投影属性。`);
	}
	const expression = directProperty(properties, property.name);
	if (expression === undefined) {
		if (properties.has(property.name)) {
			throw new Error(`边距属性“${property.name}”没有可安全换算的值。`);
		}
		return 0;
	}
	const value = designerNumber(expression, definitions, Number.MIN_SAFE_INTEGER);
	if (value === undefined || !Number.isSafeInteger(Math.trunc(value))) {
		throw new Error(`边距属性“${property.name}”不是可安全换算的 DIP 值。`);
	}
	return value;
}

/** 删除一个坐标轴上所有显式相对规则及两侧边距，为新的唯一停靠关系腾出位置。 */
function clearRelativeAxis(
	document: SimplePropertyXmlDocument,
	componentPath: string,
	definition: LibraryDefinitionReference | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>,
	axis: DesignerRelativeDock["axis"]
): SimplePropertyXmlDocument {
	const ruleProjections = axis === "horizontal"
		? RELATIVE_HORIZONTAL_RULE_PROJECTIONS
		: RELATIVE_VERTICAL_RULE_PROJECTIONS;
	const marginProjections = axis === "horizontal"
		? ["leftMargin", "rightMargin"] as const
		: ["topMargin", "bottomMargin"] as const;
	let updated = document;
	for (const projection of [...ruleProjections, ...marginProjections]) {
		updated = removeDesignerProjectedProperty(updated, componentPath, definition, definitions, projection);
	}
	return updated;
}

/** 把同级停靠目标转换为运行时使用的“组件名.标识”表达式。 */
function relativeDockExpression(
	dock: DesignerRelativeDock,
	component: DesignerComponentNode,
	parent: DesignerComponentNode,
	root: DesignerComponentNode,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): string {
	if (dock.targetXmlPath === undefined) return "真";
	const target = findDesignerComponentNode(root, dock.targetXmlPath);
	if (
		target === undefined
		|| target.path === component.path
		|| target.parentPath !== parent.path
		|| target.visual !== true
	) {
		throw new Error("相对布局停靠目标已经变化，请重新拖动组件。");
	}
	const idProperty = projectedProperty(definitions.get(target.type), definitions, "id");
	if (idProperty === undefined) {
		throw new Error("相对布局停靠目标没有声明标识属性。");
	}
	return `${target.name}.${idProperty.name}`;
}

/** 清理同轴旧关系后写入一条经过模型校验的真实相对停靠属性。 */
function applyRelativeDock(
	document: SimplePropertyXmlDocument,
	dock: DesignerRelativeDock,
	component: DesignerComponentNode,
	parent: DesignerComponentNode,
	root: DesignerComponentNode,
	definition: LibraryDefinitionReference | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): SimplePropertyXmlDocument {
	const allowed = dock.axis === "horizontal"
		? RELATIVE_HORIZONTAL_DOCK_PROJECTIONS
		: RELATIVE_VERTICAL_DOCK_PROJECTIONS;
	if (!allowed.has(dock.projection)) {
		throw new Error("相对布局停靠关系与坐标轴不匹配。");
	}
	const anchorProjection = RELATIVE_ANCHOR_PROJECTION_SET.has(dock.projection);
	if (anchorProjection !== (dock.targetXmlPath !== undefined)) {
		throw new Error("相对布局停靠关系缺少有效的同级目标。");
	}
	return writeDesignerProjectedProperty(
		clearRelativeAxis(document, component.path, definition, definitions, dock.axis),
		component.path,
		definition,
		definitions,
		dock.projection,
		relativeDockExpression(dock, component, parent, root, definitions)
	);
}

/** 新停靠关系写入后，只恢复该关系实际使用的一侧边距。 */
function applyRelativeDockMargin(
	document: SimplePropertyXmlDocument,
	dock: DesignerRelativeDock,
	margin: DesignerBoxSpacing | undefined,
	component: DesignerComponentNode,
	definition: LibraryDefinitionReference | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): SimplePropertyXmlDocument {
	const candidates = dock.axis === "horizontal"
		? [["left", "leftMargin", RELATIVE_LEFT_MARGIN_RULES], ["right", "rightMargin", RELATIVE_RIGHT_MARGIN_RULES]] as const
		: [["top", "topMargin", RELATIVE_TOP_MARGIN_RULES], ["bottom", "bottomMargin", RELATIVE_BOTTOM_MARGIN_RULES]] as const;
	const supplied = candidates.filter(([side]) => margin?.[side] !== undefined);
	if (supplied.length === 0) return document;
	if (supplied.length !== 1) {
		throw new Error("同一坐标轴只能写入一侧相对布局边距。");
	}
	const [side, projection, rules] = supplied[0]!;
	if (!rules.includes(dock.projection as never)) {
		throw new Error("相对布局边距方向与停靠关系不匹配。");
	}
	const value = margin?.[side];
	if (value === undefined || !isSafeDesignerNumber(value)) {
		throw new Error("相对布局边距必须是有效的有限 DIP 值。");
	}
	return writeDesignerProjectedProperty(
		document,
		component.path,
		definition,
		definitions,
		projection,
		designerDpExpression(value)
	);
}

function validateDesignerRelativePlacement(move: DesignerRelativePlacement, requireChange: boolean): void {
	if (
		!Number.isSafeInteger(move.deltaLeft)
		|| !Number.isSafeInteger(move.deltaTop)
		|| !Number.isSafeInteger(move.left)
		|| !Number.isSafeInteger(move.top)
		|| Object.values(move.margin ?? {}).some((value) => !isSafeDesignerNumber(value))
		|| requireChange && (
			move.deltaLeft === 0
			&& move.deltaTop === 0
			&& move.horizontalDock === undefined
			&& move.verticalDock === undefined
		)
	) {
		throw new Error("相对布局拖拽必须提供有效的整数 DIP 位置、有限 DIP 边距或停靠关系。");
	}
}

/** 把新加入或跨容器移入的组件从空规则状态写成目标相对布局位置。 */
function placeSimpleDesignerRelativeComponent(
	document: SimplePropertyXmlDocument,
	sdk: Sdk | undefined,
	componentXmlPath: string,
	placement: DesignerRelativePlacement
): ResizeDesignerComponentResult {
	validateDesignerRelativePlacement(placement, false);
	const definitions = buildDefinitionIndex(sdk?.manifests ?? []);
	const model = createSimpleDesignerModelFromDefinitions(document, sdk, definitions);
	const root = model.root;
	const component = root === undefined ? undefined : findDesignerComponentNode(root, componentXmlPath);
	const parent = component?.parentPath === undefined || root === undefined
		? undefined
		: findDesignerComponentNode(root, component.parentPath);
	if (
		root === undefined
		|| component === undefined
		|| component.path === root.path
		|| component.visual !== true
		|| parent?.layout !== "relative"
	) {
		throw new Error("当前组件不能写入相对布局位置。");
	}
	const definition = definitions.get(component.type);
	let updated = clearRelativeAxis(
		clearRelativeAxis(document, component.path, definition, definitions, "horizontal"),
		component.path,
		definition,
		definitions,
		"vertical"
	);
	if (placement.horizontalDock !== undefined) {
		updated = applyRelativeDock(updated, placement.horizontalDock, component, parent, root, definition, definitions);
		updated = applyRelativeDockMargin(
			updated,
			placement.horizontalDock,
			placement.margin,
			component,
			definition,
			definitions
		);
	} else if (placement.left !== 0) {
		updated = writeDesignerProjectedProperty(
			updated,
			component.path,
			definition,
			definitions,
			"leftMargin",
			designerDpExpression(placement.left)
		);
	}
	if (placement.verticalDock !== undefined) {
		updated = applyRelativeDock(updated, placement.verticalDock, component, parent, root, definition, definitions);
		updated = applyRelativeDockMargin(
			updated,
			placement.verticalDock,
			placement.margin,
			component,
			definition,
			definitions
		);
	} else if (placement.top !== 0) {
		updated = writeDesignerProjectedProperty(
			updated,
			component.path,
			definition,
			definitions,
			"topMargin",
			designerDpExpression(placement.top)
		);
	}
	return ensureSimpleDesignerRelativeAnchorOrder(updated, sdk, component.path);
}

/**
 * 在同一相对布局中移动现有可视组件，并把命中的边线写成真实父级或同级停靠关系。
 *
 * 未停靠的坐标轴继续通过边距移动；从居中规则自由拖离时改为父级左上坐标和边距。
 * 拖拽预演不改 XML 顺序；正式提交同级锚点后，必要时把当前组件移到最靠后的锚点之后。
 * 损坏锚点或表达式拒绝写回。
 */
export function moveSimpleDesignerRelativeComponent(
	document: SimplePropertyXmlDocument,
	sdk: Sdk | undefined,
	componentXmlPath: string,
	move: DesignerRelativePlacement
): ResizeDesignerComponentResult {
	if (document.status === "damaged") {
		throw new Error("当前单元没有可安全修改的 XML 属性模型。");
	}
	validateDesignerRelativePlacement(move, true);
	const definitions = buildDefinitionIndex(sdk?.manifests ?? []);
	const model = createSimpleDesignerModelFromDefinitions(document, sdk, definitions);
	const root = model.root;
	const component = root === undefined ? undefined : findDesignerComponentNode(root, componentXmlPath);
	const parent = component?.parentPath === undefined || root === undefined
		? undefined
		: findDesignerComponentNode(root, component.parentPath);
	if (
		root === undefined
		|| component === undefined
		|| component.path === root.path
		|| component.layoutReadOnly === true
		|| component.visual !== true
		|| component.positionDraggable !== true
		|| component.relativeRules === undefined
		|| component.relativeMoveAxes === undefined
		|| component.relativePositionIssue !== undefined
		|| parent === undefined
		|| parent.layout !== "relative"
	) {
		throw new Error("当前组件不能通过画布调整相对布局位置。");
	}
	const element = resolvePropertyXmlElement(document, component.path);
	if (element?.name !== "定义") {
		throw new Error("组件移动目标已经变化，请重新选择组件。");
	}
	const properties = directPropertyValues(element);
	const definition = definitions.get(component.type);
	const updates: Array<{
		readonly projection: "bottomMargin" | "leftMargin" | "rightMargin" | "topMargin";
		readonly value: number;
	}> = [];
	const rules = component.relativeRules;
	const horizontalChanged = move.deltaLeft !== 0 || move.horizontalDock !== undefined;
	const verticalChanged = move.deltaTop !== 0 || move.verticalDock !== undefined;
	const detachHorizontalCenter = move.horizontalDock === undefined
		&& move.deltaLeft !== 0
		&& (rules.centerInParent === true || rules.centerHorizontal === true);
	const detachVerticalCenter = move.verticalDock === undefined
		&& move.deltaTop !== 0
		&& (rules.centerInParent === true || rules.centerVertical === true);
	if (move.deltaLeft !== 0 && move.horizontalDock === undefined && !detachHorizontalCenter) {
		const updateLeft = hasRelativeRule(rules, RELATIVE_LEFT_MARGIN_RULES)
			|| !hasRelativeRule(rules, RELATIVE_RIGHT_MARGIN_RULES);
		const updateRight = hasRelativeRule(rules, RELATIVE_RIGHT_MARGIN_RULES);
		if (updateLeft) {
			updates.push({
				projection: "leftMargin",
				value: relativeMarginValue(properties, definition, definitions, "leftMargin") + move.deltaLeft
			});
		}
		if (updateRight) {
			updates.push({
				projection: "rightMargin",
				value: relativeMarginValue(properties, definition, definitions, "rightMargin") - move.deltaLeft
			});
		}
	}
	if (move.deltaTop !== 0 && move.verticalDock === undefined && !detachVerticalCenter) {
		const updateTop = hasRelativeRule(rules, RELATIVE_TOP_MARGIN_RULES)
			|| !hasRelativeRule(rules, RELATIVE_BOTTOM_MARGIN_RULES);
		const updateBottom = hasRelativeRule(rules, RELATIVE_BOTTOM_MARGIN_RULES);
		if (updateTop) {
			updates.push({
				projection: "topMargin",
				value: relativeMarginValue(properties, definition, definitions, "topMargin") + move.deltaTop
			});
		}
		if (updateBottom) {
			updates.push({
				projection: "bottomMargin",
				value: relativeMarginValue(properties, definition, definitions, "bottomMargin") - move.deltaTop
			});
		}
	}
	let updated = document;
	if (move.horizontalDock !== undefined) {
		updated = applyRelativeDock(updated, move.horizontalDock, component, parent, root, definition, definitions);
		updated = applyRelativeDockMargin(updated, move.horizontalDock, move.margin, component, definition, definitions);
	} else if (detachHorizontalCenter) {
		updated = writeDesignerProjectedProperty(
			clearRelativeAxis(updated, component.path, definition, definitions, "horizontal"),
			component.path,
			definition,
			definitions,
			"leftMargin",
			designerDpExpression(move.left)
		);
	}
	if (move.verticalDock !== undefined) {
		updated = applyRelativeDock(updated, move.verticalDock, component, parent, root, definition, definitions);
		updated = applyRelativeDockMargin(updated, move.verticalDock, move.margin, component, definition, definitions);
	} else if (detachVerticalCenter) {
		updated = writeDesignerProjectedProperty(
			clearRelativeAxis(updated, component.path, definition, definitions, "vertical"),
			component.path,
			definition,
			definitions,
			"topMargin",
			designerDpExpression(move.top)
		);
	}
	if (rules.centerInParent === true && horizontalChanged !== verticalChanged) {
		updated = writeDesignerProjectedProperty(
			updated,
			component.path,
			definition,
			definitions,
			horizontalChanged ? "centerVertical" : "centerHorizontal",
			"真"
		);
	}
	for (const update of updates) {
		updated = writeDesignerProjectedProperty(
			updated,
			component.path,
			definition,
			definitions,
			update.projection,
			designerDpExpression(update.value)
		);
	}
	return ensureSimpleDesignerRelativeAnchorOrder(updated, sdk, component.path);
}
