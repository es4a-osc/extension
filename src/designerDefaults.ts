/*
集中计算画布投影使用的容器布局及隐含宽高尺寸。
xhwsd@qq.com 2026-8-31
*/

/** 设计器支持的容器排列投影；不改变 Simple 的真实布局表达式。 */
export type DesignerLayoutKind = "absolute" | "frame" | "grid" | "linear-horizontal" | "linear-vertical" | "relative" | "unsupported";

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
	parentType: string | undefined,
	dimension: "height" | "width"
): DesignerDefaultLengthKind {
	return parentLayout === "frame"
		|| parentType === "垂直滚动框"
		|| parentType === "水平滚动框"
		|| (parentLayout === "grid" && dimension === "width")
		? "parent"
		: "content";
}

