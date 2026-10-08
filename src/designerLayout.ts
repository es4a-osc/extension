/*
定义窗口设计器顶级列顺序，并提供不依赖 VS Code 和 DOM 的校验及移动逻辑。
xhwsd@qq.com 2026-8-29
*/

/** 设计器中可以由用户横向排序的四个顶级区域。 */
export const DESIGNER_COLUMN_IDS = ["property", "projection", "enabled", "toolbox"] as const;

/** 一个可排序设计器顶级区域的稳定标识。 */
export type DesignerColumnId = typeof DESIGNER_COLUMN_IDS[number];

/** 设计器标题栏三个显示开关的当前值。 */
export interface DesignerDisplayOptions {
	readonly componentLabelsVisible: boolean;
	readonly designerDebug: boolean;
	readonly layoutHoverSync: boolean;
}

/** 可由标题栏开关独立修改的显示选项。 */
export type DesignerDisplayOptionId = keyof DesignerDisplayOptions;

/** 新单元设计器使用的显示选项。 */
export const DEFAULT_DESIGNER_DISPLAY_OPTIONS: DesignerDisplayOptions = {
	componentLabelsVisible: false,
	designerDebug: false,
	layoutHoverSync: false
};

/** 判断未知值是否为三个受支持的显示选项之一。 */
export function isDesignerDisplayOptionId(value: unknown): value is DesignerDisplayOptionId {
	return value === "componentLabelsVisible"
		|| value === "designerDebug"
		|| value === "layoutHoverSync";
}

/** 恢复三个显示开关；缺失或无效字段分别使用产品缺省值。 */
export function normalizeDesignerDisplayOptions(value: unknown): DesignerDisplayOptions {
	const candidate = typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
	return {
		componentLabelsVisible: typeof candidate.componentLabelsVisible === "boolean"
			? candidate.componentLabelsVisible
			: DEFAULT_DESIGNER_DISPLAY_OPTIONS.componentLabelsVisible,
		designerDebug: typeof candidate.designerDebug === "boolean"
			? candidate.designerDebug
			: DEFAULT_DESIGNER_DISPLAY_OPTIONS.designerDebug,
		layoutHoverSync: typeof candidate.layoutHoverSync === "boolean"
			? candidate.layoutHoverSync
			: DEFAULT_DESIGNER_DISPLAY_OPTIONS.layoutHoverSync
	};
}

/** 判断未知值是否包含每个顶级区域且只包含一次。 */
export function isDesignerColumnOrder(value: unknown): value is readonly DesignerColumnId[] {
	return Array.isArray(value)
		&& value.length === DESIGNER_COLUMN_IDS.length
		&& DESIGNER_COLUMN_IDS.every((id) => value.includes(id))
		&& new Set(value).size === DESIGNER_COLUMN_IDS.length;
}

/** 将旧版投影列标识迁移为当前标识；其它无效状态仍然拒绝恢复。 */
function migrateDesignerColumnOrder(value: unknown): readonly DesignerColumnId[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const migrated = value.map((id: unknown) => id === "designer" ? "projection" : id);
	return isDesignerColumnOrder(migrated) ? [...migrated] : undefined;
}

/** 从工作区状态读取列顺序；无效或旧版本状态回退到产品缺省顺序。 */
export function normalizeDesignerColumnOrder(value: unknown): readonly DesignerColumnId[] {
	return migrateDesignerColumnOrder(value) ?? [...DESIGNER_COLUMN_IDS];
}

/** 把一个顶级区域移动到另一区域之前或之后。 */
export function moveDesignerColumn(
	order: readonly DesignerColumnId[],
	column: DesignerColumnId,
	reference: DesignerColumnId,
	position: "after" | "before"
): readonly DesignerColumnId[] {
	const updated = normalizeDesignerColumnOrder(order).filter((id) => id !== column);
	const referenceIndex = updated.indexOf(reference);
	if (referenceIndex < 0) return normalizeDesignerColumnOrder(order);
	updated.splice(referenceIndex + (position === "after" ? 1 : 0), 0, column);
	return updated;
}
