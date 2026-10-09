/*
集中计算画布投影使用的容器布局及隐含宽高尺寸。
xhwsd@qq.com 2026-8-31
*/

import type { LibraryContainerLayout } from "./sdk";

/** 设计器支持的容器排列投影；不改变 Simple 的真实布局表达式。 */
export type DesignerLayoutKind = LibraryContainerLayout | "unsupported";

/** 将已有布局投影对应到 SDK 布局定义和常量，供画布及属性适用性判断共用。 */
export function designerLayoutDefinition(layout: DesignerLayoutKind): {
	readonly name: string;
	readonly expression: string;
} | undefined {
	switch (layout) {
		case "absolute": return { name: "绝对布局", expression: "布局_绝对" };
		case "frame": return { name: "单帧布局", expression: "布局_单帧" };
		case "grid": return { name: "表格布局", expression: "布局_表格" };
		case "linear-horizontal":
		case "linear-vertical": return { name: "线性布局", expression: "布局_线性" };
		case "relative": return { name: "相对布局", expression: "布局_相对" };
		case "unsupported": return undefined;
	}
}

/** 未显式设置尺寸时由父容器赋予的布局参数类型。 */
export type DesignerDefaultLengthKind = "content" | "parent";

/** 将父容器的布局表达式解析为设计器支持的低保真排列。 */
export function designerLayoutKind(
	layoutExpression: string | undefined,
	directionExpression: string | undefined
): DesignerLayoutKind {
	const layout = layoutExpression ?? "1";
	if (layout === "2" || /布局_表格$/u.test(layout)) return "grid";
	if (layout === "3" || /布局_单帧$/u.test(layout)) return "frame";
	if (layout === "4" || /布局_相对$/u.test(layout)) return "relative";
	if (layout === "5" || /布局_绝对$/u.test(layout)) return "absolute";
	if (layout !== "1" && !/布局_线性$/u.test(layout)) return "unsupported";
	const direction = directionExpression ?? "1";
	return direction === "0" || /布局_方向_水平$/u.test(direction)
		? "linear-horizontal"
		: "linear-vertical";
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

