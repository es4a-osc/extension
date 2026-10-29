/*
集中解析清单声明的布局投影及隐含尺寸，供画布和属性框共用。
xhwsd@qq.com 2026-8-31
*/

import { resolveSdkConstantValue, type LibraryContainerLayout, type LibraryDefinitionReference } from "./sdk";

/** 设计器支持的容器排列投影；不改变 Simple 的真实布局表达式。 */
export type DesignerLayoutKind = LibraryContainerLayout | "unsupported";

/** 横纵线性布局共用一个布局定义，方向由对应属性投影单独确定。 */
function sameLayoutFamily(left: LibraryContainerLayout | undefined, right: DesignerLayoutKind): boolean {
	return left === right || left?.startsWith("linear-") === true && right.startsWith("linear-");
}

/** 按固定投影查找清单加载顺序中的首个布局定义，不从中文名称反推类型。 */
export function designerLayoutDefinition(
	layout: DesignerLayoutKind,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): LibraryDefinitionReference | undefined {
	return Array.from(definitions.values()).find((reference) => (
		reference.definition.kind === "layout"
		&& reference.definition.projection?.layoutValue !== undefined
		&& sameLayoutFamily(reference.definition.projection.layout, layout)
	));
}

/** 按布局选择值与清单中的显式投影关联查找定义；冲突关联保持不可解析。 */
export function resolveDesignerLayoutDefinition(
	expression: string | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): LibraryDefinitionReference | undefined {
	const value = resolveSdkConstantValue(expression, definitions)?.trim();
	if (value === undefined) return undefined;
	const candidates = new Set(Array.from(definitions.values()).filter((reference) => (
		reference.definition.kind === "layout"
		&& reference.definition.projection?.layout !== undefined
		&& reference.definition.projection.layoutValue !== undefined
		&& resolveSdkConstantValue(reference.definition.projection.layoutValue, definitions)?.trim() === value
	)));
	return candidates.size === 1 ? candidates.values().next().value : undefined;
}

/** 未显式设置尺寸时由父容器赋予的布局参数类型。 */
export type DesignerDefaultLengthKind = "content" | "parent";

/** 读取布局定义声明的排列语义，线性方向只接受可确定的清单常量或数值。 */
export function designerLayoutKind(
	layoutExpression: string | undefined,
	directionExpression: string | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): DesignerLayoutKind {
	const layout = resolveDesignerLayoutDefinition(layoutExpression, definitions)?.definition.projection?.layout;
	if (layout === undefined) return "unsupported";
	if (!layout.startsWith("linear-") || directionExpression === undefined) return layout;
	const direction = resolveSdkConstantValue(directionExpression, definitions)?.trim();
	return direction === "0" ? "linear-horizontal" : direction === "1" ? "linear-vertical" : "unsupported";
}

/** 按当前 Android 容器添加子视图时使用的真实初始布局参数返回缺省尺寸。 */
export function designerDefaultLengthKind(
	parentLayout: DesignerLayoutKind | undefined,
	dimension: "height" | "width"
): DesignerDefaultLengthKind {
	return parentLayout === "frame"
		|| (parentLayout === "grid" && dimension === "width")
		? "parent"
		: "content";
}

