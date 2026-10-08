/*
提供 Vue 设计器组件共享的图标、样式投影与真实 DOM 测量辅助函数。
xhwsd@qq.com 2026-8-30
*/

/// <reference lib="dom" />

import type { CSSProperties } from "vue";
import type {
	DesignerAlignment,
	DesignerBoxSpacing,
	DesignerComponentNode,
	DesignerFramePlacement,
	DesignerGridPosition,
	DesignerLength,
	DesignerRelativePlacement,
	DesignerRelativeRuleLabels,
	DesignerRelativeRules
} from "../designerModel";
import { markdownDocumentationToPlainText } from "../markdownDocumentation";
import { resolveDesignerRelativePositions, type DesignerProjectedRelativePosition } from "./designerRelativeLayout";

/**
 * 计算拖动指针相对组件左边或顶边的偏移。
 * 组件名称标签位于组件外侧，必须保留负数或超过组件尺寸的真实偏移，避免起拖后跳位。
 */
export function componentDragPointerOffset(
	pointerPosition: number,
	componentStart: number,
	fromComponentName: boolean
): number {
	const offset = pointerPosition - componentStart;
	return fromComponentName ? offset : Math.max(0, offset);
}

/**
 * 把组件主轴首尾的窄边缘解释为同级插入位置。
 * 容器中部仍留给内部放置；组件过小时把命中宽度限制为自身的一半，避免前后区域重叠。
 */
export function componentEdgeInsertionPosition(
	pointerPosition: number,
	componentStart: number,
	componentLength: number,
	edgeSize = 8
): "after" | "before" | undefined {
	if (
		!Number.isFinite(pointerPosition)
		|| !Number.isFinite(componentStart)
		|| !Number.isFinite(componentLength)
		|| !Number.isFinite(edgeSize)
		|| componentLength <= 0
		|| edgeSize <= 0
	) return undefined;
	const componentEnd = componentStart + componentLength;
	if (pointerPosition < componentStart || pointerPosition > componentEnd) return undefined;
	const effectiveEdgeSize = Math.min(edgeSize, componentLength / 2);
	if (pointerPosition <= componentStart + effectiveEdgeSize) return "before";
	if (pointerPosition >= componentEnd - effectiveEdgeSize) return "after";
	return undefined;
}

/** 当前组件在同级 XML 顺序中允许的前移和后移动作。 */
export interface LayoutMoveAvailability {
	readonly next: boolean;
	readonly previous: boolean;
}

/** 设计面绘制和拖放共同使用的一个表格单元格。 */
export interface DesignerGridCell {
	readonly column: number;
	readonly key: string;
	readonly occupiedComponent?: {
		readonly index: number;
		readonly node: DesignerComponentNode;
	};
	readonly occupiedComponentPath?: string;
	readonly row: number;
}

/** 浏览器端临时选中的空表格单元格；它不是 XML 节点。 */
export interface DesignerGridCellSelection extends DesignerGridPosition {
	readonly parentXmlPath: string;
}

/** 相对布局拖动时参与停靠计算的视口矩形。 */
export interface DesignerRelativeSnapBounds {
	readonly height: number;
	readonly left: number;
	readonly top: number;
	readonly width: number;
}

/** 可作为相对布局停靠锚点的直接同级组件及其真实 XML 身份。 */
export interface DesignerRelativeSnapSibling extends DesignerRelativeSnapBounds {
	readonly componentName: string;
	readonly xmlPath: string;
}

/** 一条可由 SDK 相对布局投影真实写回 XML 的拖拽停靠关系。 */
export interface DesignerRelativeSnapDock {
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
	readonly targetComponentName?: string;
	readonly targetXmlPath?: string;
}

/** 相对布局示意线附带的间距段；连接停靠线与组件边，并独立显示边距。 */
export interface DesignerRelativeGuideConnector {
	readonly axis: "horizontal" | "vertical";
	readonly end: number;
	readonly label: string;
	readonly marginSide: keyof DesignerBoxSpacing;
	readonly position: number;
	readonly start: number;
}

/** 相对布局交互层绘制的一条真实停靠规则线；规则名与间距文字分别归属主线和间距段。 */
export interface DesignerRelativeGuide {
	readonly axis: "horizontal" | "vertical";
	readonly connector?: DesignerRelativeGuideConnector;
	readonly end: number;
	readonly kind: "dock" | "margin";
	readonly label: string;
	readonly labelPlacement: "end" | "middle" | "start";
	readonly marginSide?: keyof DesignerBoxSpacing;
	readonly position: number;
	readonly rule?: keyof DesignerRelativeRules;
	readonly start: number;
	readonly target: "margin" | "parent" | "sibling";
	readonly title: string;
}

/** 拖动吸附候选额外携带能够真实写回 XML 的停靠描述。 */
export interface DesignerRelativeSnapGuide extends DesignerRelativeGuide {
	readonly dock: DesignerRelativeSnapDock;
	readonly kind: "dock";
	readonly target: "parent" | "sibling";
}

/** 相对布局拖动吸附结果；坐标仍位于调用方传入的同一视口坐标系。 */
export interface DesignerRelativeSnapResult {
	readonly guides: readonly DesignerRelativeSnapGuide[];
	readonly horizontalDock?: DesignerRelativeSnapDock;
	readonly left: number;
	readonly margin?: DesignerBoxSpacing;
	readonly top: number;
	readonly verticalDock?: DesignerRelativeSnapDock;
}

/** 用与正式相对布局投影相同的规则计算拖拽预演矩形，避免示意线仍跟随未落位的指针矩形。 */
export function projectedDesignerRelativePreviewBounds(
	moving: DesignerRelativeSnapBounds,
	parent: DesignerRelativeSnapBounds,
	siblings: readonly DesignerRelativeSnapSibling[],
	rules: DesignerRelativeRules,
	margin: DesignerBoxSpacing | undefined,
	layoutWidth: number,
	layoutHeight: number
): DesignerRelativeSnapBounds {
	if (layoutWidth <= 0 || layoutHeight <= 0 || parent.width <= 0 || parent.height <= 0) return moving;
	const scaleX = parent.width / layoutWidth;
	const scaleY = parent.height / layoutHeight;
	const previewPath = "\u0000relative-preview";
	const positions = resolveDesignerRelativePositions(layoutWidth, layoutHeight, [
		...siblings.map((sibling) => ({
			height: sibling.height / scaleY,
			margin: {
				left: (sibling.left - parent.left) / scaleX,
				top: (sibling.top - parent.top) / scaleY
			},
			path: sibling.xmlPath,
			width: sibling.width / scaleX
		})),
		{
			height: moving.height / scaleY,
			margin,
			path: previewPath,
			rules,
			width: moving.width / scaleX
		}
	]);
	const position = positions.get(previewPath);
	return position === undefined || position.issue !== undefined
		? moving
		: {
			...moving,
			left: parent.left + position.left * scaleX,
			top: parent.top + position.top * scaleY
		};
}

/** 单帧布局拖动只在父级九宫格对齐中选择位置，不产生同级锚点。 */
export interface DesignerFrameSnapResult {
	readonly guides: readonly DesignerRelativeSnapGuide[];
	readonly left: number;
	readonly placement: DesignerFramePlacement;
	readonly top: number;
}

interface RelativeSnapCandidate {
	readonly distance: number;
	readonly delta: number;
	readonly guide: DesignerRelativeSnapGuide;
	readonly margin?: DesignerBoxSpacing;
	readonly order: number;
	readonly priority: number;
	readonly proximity: number;
}

export type DesignerRelativeGuideLabelSide = "above" | "below" | "left" | "right";
export type DesignerRelativeGuideLabelMode = "center-in-parent" | "default" | "hidden";

const DESIGNER_RELATIVE_GUIDE_LABEL_GAP = 4;
const DESIGNER_RELATIVE_GUIDE_LABEL_PADDING = 4;
const DESIGNER_RELATIVE_GUIDE_LABEL_THICKNESS = 14;

function estimatedDesignerRelativeGuideLabelLength(label: string): number {
	return [...label].reduce(
		(length, character) => length + (character.charCodeAt(0) <= 0x7f ? 6 : 10),
		DESIGNER_RELATIVE_GUIDE_LABEL_PADDING
	);
}

/** 短间距段容不下文字时，把文字移到远离拖拽组件的端点外侧。 */
export function designerRelativeShortGuideLabelCenter(
	guide: Readonly<Pick<DesignerRelativeGuide, "axis" | "end" | "label" | "start">>,
	moving: DesignerRelativeSnapBounds
): number | undefined {
	const start = Math.min(guide.start, guide.end);
	const end = Math.max(guide.start, guide.end);
	const labelLength = estimatedDesignerRelativeGuideLabelLength(guide.label);
	if (end - start >= labelLength + DESIGNER_RELATIVE_GUIDE_LABEL_GAP * 2) return undefined;
	const movingCenter = guide.axis === "horizontal"
		? moving.left + moving.width / 2
		: moving.top + moving.height / 2;
	const useEnd = Math.abs(end - movingCenter) >= Math.abs(start - movingCenter);
	const endpoint = useEnd ? end : start;
	return endpoint + (useEnd ? 1 : -1) * (labelLength / 2 + DESIGNER_RELATIVE_GUIDE_LABEL_GAP);
}

/** 居中于父的十字线只显示一个水平规则名，其余规则仍各自显示。 */
export function designerRelativeGuideLabelMode(
	guides: readonly DesignerRelativeGuide[],
	index: number
): DesignerRelativeGuideLabelMode {
	const guide = guides[index];
	if (guide?.rule !== "centerInParent") return "default";
	const centerAxes = new Set(guides
		.filter((candidate) => candidate.rule === "centerInParent")
		.map((candidate) => candidate.axis));
	if (!centerAxes.has("horizontal") || !centerAxes.has("vertical")) return "default";
	return guide.axis === "horizontal" ? "center-in-parent" : "hidden";
}

/** 停靠线越过相关组件边框的长度，使对齐方向在拖拽时能够直接辨认。 */
const DESIGNER_RELATIVE_GUIDE_EXTENSION = 16;

function extendedDesignerRelativeGuideRange(
	start: number,
	end: number,
	minimum: number,
	maximum: number
): Readonly<{ end: number; start: number }> {
	return {
		end: Math.min(maximum, Math.max(start, end) + DESIGNER_RELATIVE_GUIDE_EXTENSION),
		start: Math.max(minimum, Math.min(start, end) - DESIGNER_RELATIVE_GUIDE_EXTENSION)
	};
}

/** 根据示意线与拖拽矩形的相对位置选择文字外侧，并在有效区域边缘空间不足时翻到线内。 */
export function designerRelativeGuideLabelSide(
	guide: DesignerRelativeGuide,
	moving: DesignerRelativeSnapBounds,
	availableBounds?: Readonly<{ height: number; left?: number; top?: number; width: number }>,
	labelDirection: "horizontal" | "vertical" = "vertical"
): DesignerRelativeGuideLabelSide {
	const movingRight = moving.left + moving.width;
	const movingBottom = moving.top + moving.height;
	const minimumLeft = availableBounds?.left ?? 0;
	const minimumTop = availableBounds?.top ?? 0;
	const maximumRight = minimumLeft + (availableBounds?.width ?? 0);
	const maximumBottom = minimumTop + (availableBounds?.height ?? 0);
	if (guide.axis === "vertical") {
		let side: DesignerRelativeGuideLabelSide = Math.abs(guide.position - moving.left) <= Math.abs(guide.position - movingRight)
			? "left"
			: "right";
		const labelWidth = labelDirection === "vertical"
			? DESIGNER_RELATIVE_GUIDE_LABEL_THICKNESS
			: estimatedDesignerRelativeGuideLabelLength(guide.label);
		if (availableBounds !== undefined) {
			if (side === "left" && guide.position - labelWidth - 4 < minimumLeft) side = "right";
			else if (side === "right" && guide.position + labelWidth + 4 > maximumRight) side = "left";
		}
		return side;
	}
	let side: DesignerRelativeGuideLabelSide = Math.abs(guide.position - moving.top) <= Math.abs(guide.position - movingBottom)
		? "above"
		: "below";
	if (availableBounds !== undefined) {
		if (side === "above" && guide.position - 18 < minimumTop) side = "below";
		else if (side === "below" && guide.position + 18 > maximumBottom) side = "above";
	}
	return side;
}

export interface DesignerRelativeLabelBounds {
	readonly height: number;
	readonly left: number;
	readonly top: number;
	readonly width: number;
}

/** 相对布局规则名与边距分别避让；父级边框上的规则名仍使用原有绘制规则。 */
export function layoutDesignerRelativeLabels(
	guides: readonly DesignerRelativeGuide[],
	moving: DesignerRelativeSnapBounds,
	available: DesignerRelativeSnapBounds,
	measureWidth: (label: string) => number
): readonly Readonly<{ connector?: DesignerRelativeLabelBounds; rule?: DesignerRelativeLabelBounds }>[] {
	const placements: Array<{ connector?: DesignerRelativeLabelBounds; rule?: DesignerRelativeLabelBounds }> = guides.map(() => ({}));
	const occupied: DesignerRelativeLabelBounds[] = [];
	const overlapArea = (left: DesignerRelativeLabelBounds, right: DesignerRelativeLabelBounds): number => (
		Math.max(0, Math.min(left.left + left.width + 2, right.left + right.width) - Math.max(left.left - 2, right.left))
		* Math.max(0, Math.min(left.top + left.height + 2, right.top + right.height) - Math.max(left.top - 2, right.top))
	);
	const lineOverlapArea = (bounds: DesignerRelativeLabelBounds, line: DesignerRelativeGuide | DesignerRelativeGuideConnector): number => {
		const lineBounds = line.axis === "vertical"
			? { height: line.end - line.start, left: line.position - 0.5, top: line.start, width: 1 }
			: { height: 1, left: line.start, top: line.position - 0.5, width: line.end - line.start };
		return Math.max(0, Math.min(bounds.left + bounds.width, lineBounds.left + lineBounds.width) - Math.max(bounds.left, lineBounds.left))
			* Math.max(0, Math.min(bounds.top + bounds.height, lineBounds.top + lineBounds.height) - Math.max(bounds.top, lineBounds.top));
	};
	const place = (guide: DesignerRelativeGuide, connector: boolean, label: string): DesignerRelativeLabelBounds => {
		const line = connector && guide.connector !== undefined ? { ...guide, ...guide.connector } : guide;
		const marginSide = connector ? guide.connector?.marginSide : guide.kind === "margin" ? guide.marginSide : undefined;
		const width = measureWidth(label);
		const height = 14;
		const start = Math.min(line.start, line.end);
		const end = Math.max(line.start, line.end);
		const midpoint = (start + end) / 2;
		let side = designerRelativeGuideLabelSide(line, moving, available, "horizontal");
		/* 相邻边规则的锚点在参照线另一侧；文案优先放在当前组件与参照线之间。 */
		if (!connector && guide.target === "sibling" && (
			guide.rule === "leftOf" || guide.rule === "rightOf"
			|| guide.rule === "startOf" || guide.rule === "endOf"
			|| guide.rule === "above" || guide.rule === "below"
		)) {
			side = { above: "below", below: "above", left: "right", right: "left" }[side] as DesignerRelativeGuideLabelSide;
		}
		const candidates: Array<Readonly<{ left: number; top: number }>> = [];
		if (line.axis === "vertical" && (marginSide === "top" || marginSide === "bottom")) {
			const edgeTop = marginSide === "top" ? moving.top - height - 2 : moving.top + moving.height + 2;
			const centeredTop = midpoint - height / 2;
			const fitsOnSide = marginSide === "top"
				? centeredTop + height <= moving.top - 2
				: centeredTop >= moving.top + moving.height + 2;
			const tops = [
				...(fitsOnSide ? [centeredTop] : []),
				edgeTop,
				marginSide === "top" ? start - height - 2 : end + 2
			];
			const sides = [
				line.position - width - 4,
				line.position + 4,
				moving.left - width - 4,
				moving.left + moving.width + 4
			];
			for (const top of tops) for (const left of sides) candidates.push({ left, top });
		} else if (line.axis === "horizontal" && (marginSide === "left" || marginSide === "right")) {
			const edgeLeft = marginSide === "left" ? moving.left - width - 2 : moving.left + moving.width + 2;
			const centeredLeft = midpoint - width / 2;
			const fitsOnSide = marginSide === "left"
				? centeredLeft + width <= moving.left - 2
				: centeredLeft >= moving.left + moving.width + 2;
			const lefts = [
				...(fitsOnSide ? [centeredLeft] : []),
				edgeLeft,
				marginSide === "left" ? start - width - 2 : end + 2
			];
			const tops = [
				line.position - height - 2,
				line.position + 3,
				moving.top - height - 2,
				moving.top + moving.height + 2
			];
			for (const left of lefts) for (const top of tops) candidates.push({ left, top });
		} else if (line.axis === "vertical") {
			const preferredTop = connector || guide.labelPlacement === "middle"
				? midpoint - height / 2
				: guide.labelPlacement === "end" ? end - height : start;
			const tops = [
				preferredTop, start, end - height, midpoint - height / 2,
				...(guide.connector === undefined || connector ? [] : [guide.connector.position - height - 4, guide.connector.position + 4]),
				moving.top - height - 4, moving.top + moving.height + 4
			];
			const sides = side === "left"
				? [line.position - width - 4, line.position + 4]
				: [line.position + 4, line.position - width - 4];
			for (const top of tops) for (const left of sides) candidates.push({ left, top });
		} else {
			const shortCenter = connector ? designerRelativeShortGuideLabelCenter(line, moving) : undefined;
			const preferredLeft = connector
				? (shortCenter ?? midpoint) - width / 2
				: guide.labelPlacement === "middle" ? midpoint - width / 2
					: guide.labelPlacement === "end" ? end - width : start;
			const lefts = [
				preferredLeft, start, end - width, midpoint - width / 2,
				...(guide.connector === undefined || connector ? [] : [guide.connector.position - width - 4, guide.connector.position + 4])
			];
			const sides = side === "above"
				? [line.position - height - 2, line.position + 3]
				: [line.position + 3, line.position - height - 2];
			for (const left of lefts) for (const top of sides) candidates.push({ left, top });
		}
		const maximumLeft = available.left + available.width - width;
		const maximumTop = available.top + available.height - height;
		let best: DesignerRelativeLabelBounds | undefined;
		let bestScore = Number.POSITIVE_INFINITY;
		for (const [index, candidate] of candidates.entries()) {
			const bounds = {
				height,
				left: Math.max(available.left, Math.min(maximumLeft, candidate.left)),
				top: Math.max(available.top, Math.min(maximumTop, candidate.top)),
				width
			};
			const componentOverlap = overlapArea(bounds, moving);
			const labelOverlap = occupied.reduce((sum, previous) => sum + overlapArea(bounds, previous), 0);
			const lineOverlap = guides.reduce((sum, current) => sum
				+ lineOverlapArea(bounds, current)
				+ (current.connector === undefined ? 0 : lineOverlapArea(bounds, current.connector)), 0);
			/* 只把当前组件、已放文案和示意线当作禁区；兄弟组件仍可作为停靠锚点，但不参与文案避让。 */
			const score = (componentOverlap > 0 ? 1_000_000 + componentOverlap * 1_000 : 0)
				+ (labelOverlap > 0 ? 100_000 + labelOverlap * 100 : 0)
				+ (lineOverlap > 0 ? 10_000 + lineOverlap * 10 : 0)
				+ Math.abs(bounds.left - candidate.left) + Math.abs(bounds.top - candidate.top)
				+ index / 100;
			if (score < bestScore) {
				best = bounds;
				bestScore = score;
			}
		}
		return best ?? { height, left: available.left, top: available.top, width };
	};
	for (const connector of [true, false]) {
		for (const [index, guide] of guides.entries()) {
			if (guide.target === "parent" && !connector) continue;
			const placement = placements[index];
			if (placement === undefined) continue;
			const label = connector ? guide.connector?.label : guide.label;
			if (label === undefined || label.length === 0) continue;
			const bounds = place(guide, connector, label);
			placement[connector ? "connector" : "rule"] = bounds;
			occupied.push(bounds);
		}
	}
	return placements;
}

/** 把可写回的停靠规则映射为属性框使用的同一个 SDK 属性名称。 */
export function designerRelativeDockLabel(
	dock: DesignerRelativeSnapDock,
	ruleLabels: DesignerRelativeRuleLabels
): string {
	return ruleLabels[dock.projection] ?? "";
}

function designerRelativeMarginEntry(
	margin: DesignerBoxSpacing | undefined
): readonly [keyof DesignerBoxSpacing, number] | undefined {
	for (const side of ["left", "right", "top", "bottom"] as const) {
		const value = margin?.[side];
		if (value !== undefined) return [side, value];
	}
	return undefined;
}

/**
 * 根据当前 XML 投影恢复组件已有的相对规则线，并把显式边距合并到对应规则。
 *
 * 边距数值只来自 XML 的四向边距投影；不根据浏览器中的几何间隔反推不存在的边距。
 */
export function currentDesignerRelativeGuides(
	moving: DesignerRelativeSnapBounds,
	parent: DesignerRelativeSnapBounds,
	siblings: readonly DesignerRelativeSnapSibling[],
	rules: DesignerRelativeRules,
	margin: DesignerBoxSpacing | undefined,
	ruleLabels: DesignerRelativeRuleLabels
): readonly DesignerRelativeGuide[] {
	const guides: DesignerRelativeGuide[] = [];
	const movingRight = moving.left + moving.width;
	const movingBottom = moving.top + moving.height;
	const siblingByPath = new Map(siblings.map((sibling) => [sibling.xmlPath, sibling]));
	const consumedMargins = new Set<keyof DesignerBoxSpacing>();
	const line = (
		axis: DesignerRelativeGuide["axis"],
		start: number,
		end: number,
		position: number,
		label: string,
		target: DesignerRelativeGuide["target"],
		kind: DesignerRelativeGuide["kind"] = "dock",
		labelPlacement: DesignerRelativeGuide["labelPlacement"] = "start",
		connector?: DesignerRelativeGuideConnector,
		rule?: keyof DesignerRelativeRules,
		marginSide?: keyof DesignerBoxSpacing
	): void => {
		guides.push({
			axis,
			...(connector === undefined ? {} : { connector }),
			end: Math.max(start, end),
			kind,
			label,
			labelPlacement,
			...(marginSide === undefined ? {} : { marginSide }),
			position,
			...(rule === undefined ? {} : { rule }),
			start: Math.min(start, end),
			target,
			title: label
		});
	};
	const verticalAlignment = (
		position: number,
		bounds: DesignerRelativeSnapBounds,
		label: string,
		target: "parent" | "sibling",
		marginSide?: "left" | "right",
		rule?: keyof DesignerRelativeRules
	): void => {
		const range = extendedDesignerRelativeGuideRange(
			Math.min(moving.top, bounds.top),
			Math.max(movingBottom, bounds.top + bounds.height),
			parent.top,
			parent.top + parent.height
		);
		const marginValue = marginSide === undefined ? undefined : margin?.[marginSide];
		if (marginSide !== undefined && marginValue !== undefined) consumedMargins.add(marginSide);
		const movingEdge = marginSide === "right" ? movingRight : moving.left;
		const connector = marginSide === undefined || marginValue === undefined || marginValue === 0
			? undefined
			: {
				axis: "horizontal" as const,
				end: Math.max(position, movingEdge),
				label: `${marginValue}dp`,
				marginSide,
				position: moving.top + moving.height / 2,
				start: Math.min(position, movingEdge)
			};
		line("vertical", range.start, range.end, position, label, target, "dock", target === "parent" ? "middle" : "start", connector, rule);
	};
	const horizontalAlignment = (
		position: number,
		bounds: DesignerRelativeSnapBounds,
		label: string,
		target: "parent" | "sibling",
		marginSide?: "bottom" | "top",
		rule?: keyof DesignerRelativeRules
	): void => {
		const range = extendedDesignerRelativeGuideRange(
			Math.min(moving.left, bounds.left),
			Math.max(movingRight, bounds.left + bounds.width),
			parent.left,
			parent.left + parent.width
		);
		const marginValue = marginSide === undefined ? undefined : margin?.[marginSide];
		if (marginSide !== undefined && marginValue !== undefined) consumedMargins.add(marginSide);
		const movingEdge = marginSide === "bottom" ? movingBottom : moving.top;
		const connector = marginSide === undefined || marginValue === undefined || marginValue === 0
			? undefined
			: {
				axis: "vertical" as const,
				end: Math.max(position, movingEdge),
				label: `${marginValue}dp`,
				marginSide,
				position: moving.left + moving.width / 2,
				start: Math.min(position, movingEdge)
			};
		line("horizontal", range.start, range.end, position, label, target, "dock", target === "parent" ? "middle" : "start", connector, rule);
	};
	const sibling = (path: string | undefined): DesignerRelativeSnapSibling | undefined => (
		path === undefined ? undefined : siblingByPath.get(path)
	);
	const ruleLabel = (projection: keyof DesignerRelativeRules): string => ruleLabels[projection] ?? "";

	if (rules.alignParentLeft === true) verticalAlignment(parent.left, parent, ruleLabel("alignParentLeft"), "parent", "left");
	if (rules.alignParentStart === true) verticalAlignment(parent.left, parent, ruleLabel("alignParentStart"), "parent", "left");
	if (rules.alignParentRight === true) verticalAlignment(parent.left + parent.width, parent, ruleLabel("alignParentRight"), "parent", "right");
	if (rules.alignParentEnd === true) verticalAlignment(parent.left + parent.width, parent, ruleLabel("alignParentEnd"), "parent", "right");
	if (rules.alignParentTop === true) horizontalAlignment(parent.top, parent, ruleLabel("alignParentTop"), "parent", "top");
	if (rules.alignParentBottom === true) horizontalAlignment(parent.top + parent.height, parent, ruleLabel("alignParentBottom"), "parent", "bottom");
	if (rules.centerHorizontal === true) verticalAlignment(parent.left + parent.width / 2, parent, ruleLabel("centerHorizontal"), "parent", undefined, "centerHorizontal");
	if (rules.centerVertical === true) horizontalAlignment(parent.top + parent.height / 2, parent, ruleLabel("centerVertical"), "parent", undefined, "centerVertical");
	if (rules.centerInParent === true) {
		verticalAlignment(parent.left + parent.width / 2, parent, ruleLabel("centerInParent"), "parent", undefined, "centerInParent");
		horizontalAlignment(parent.top + parent.height / 2, parent, ruleLabel("centerInParent"), "parent", undefined, "centerInParent");
	}

	const alignLeft = sibling(rules.alignLeft);
	if (alignLeft !== undefined) verticalAlignment(alignLeft.left, alignLeft, ruleLabel("alignLeft"), "sibling", "left", "alignLeft");
	const alignStart = sibling(rules.alignStart);
	if (alignStart !== undefined) verticalAlignment(alignStart.left, alignStart, ruleLabel("alignStart"), "sibling", "left", "alignStart");
	const alignRight = sibling(rules.alignRight);
	if (alignRight !== undefined) verticalAlignment(alignRight.left + alignRight.width, alignRight, ruleLabel("alignRight"), "sibling", "right", "alignRight");
	const alignEnd = sibling(rules.alignEnd);
	if (alignEnd !== undefined) verticalAlignment(alignEnd.left + alignEnd.width, alignEnd, ruleLabel("alignEnd"), "sibling", "right", "alignEnd");
	const alignTop = sibling(rules.alignTop);
	if (alignTop !== undefined) horizontalAlignment(alignTop.top, alignTop, ruleLabel("alignTop"), "sibling", "top", "alignTop");
	const alignBottom = sibling(rules.alignBottom);
	if (alignBottom !== undefined) horizontalAlignment(alignBottom.top + alignBottom.height, alignBottom, ruleLabel("alignBottom"), "sibling", "bottom", "alignBottom");
	const alignBaseline = sibling(rules.alignBaseline);
	if (alignBaseline !== undefined) horizontalAlignment(alignBaseline.top + alignBaseline.height, alignBaseline, ruleLabel("alignBaseline"), "sibling", "bottom", "alignBaseline");

	const leftOf = sibling(rules.leftOf);
	if (leftOf !== undefined) {
		verticalAlignment(leftOf.left, leftOf, ruleLabel("leftOf"), "sibling", "right", "leftOf");
	}
	const startOf = sibling(rules.startOf);
	if (startOf !== undefined) {
		verticalAlignment(startOf.left, startOf, ruleLabel("startOf"), "sibling", "right", "startOf");
	}
	const rightOf = sibling(rules.rightOf);
	if (rightOf !== undefined) {
		verticalAlignment(rightOf.left + rightOf.width, rightOf, ruleLabel("rightOf"), "sibling", "left", "rightOf");
	}
	const endOf = sibling(rules.endOf);
	if (endOf !== undefined) {
		verticalAlignment(endOf.left + endOf.width, endOf, ruleLabel("endOf"), "sibling", "left", "endOf");
	}
	const above = sibling(rules.above);
	if (above !== undefined) {
		horizontalAlignment(above.top, above, ruleLabel("above"), "sibling", "bottom", "above");
	}
	const below = sibling(rules.below);
	if (below !== undefined) {
		horizontalAlignment(below.top + below.height, below, ruleLabel("below"), "sibling", "top", "below");
	}

	const marginLine = (side: keyof DesignerBoxSpacing, value: number): void => {
		const label = `${value}dp`;
		const distance = Math.abs(value);
		switch (side) {
			case "left": line("horizontal", moving.left - distance, moving.left, moving.top + moving.height / 2, label, "margin", "margin", "middle", undefined, undefined, side); break;
			case "right": line("horizontal", movingRight, movingRight + distance, moving.top + moving.height / 2, label, "margin", "margin", "middle", undefined, undefined, side); break;
			case "top": line("vertical", moving.top - distance, moving.top, moving.left + moving.width / 2, label, "margin", "margin", "middle", undefined, undefined, side); break;
			case "bottom": line("vertical", movingBottom, movingBottom + distance, moving.left + moving.width / 2, label, "margin", "margin", "middle", undefined, undefined, side); break;
		}
	};
	for (const side of ["left", "right", "top", "bottom"] as const) {
		const value = margin?.[side];
		if (value !== undefined && value !== 0 && !consumedMargins.has(side)) marginLine(side, value);
	}
	return guides;
}

/** 相对布局拖拽若提交时将形成的规则和显式边距，仅供画布实时反馈使用。 */
export interface DesignerRelativePlacementPreview {
	readonly margin?: DesignerBoxSpacing;
	readonly rules: DesignerRelativeRules;
}

const PREVIEW_HORIZONTAL_RULES: readonly (keyof DesignerRelativeRules)[] = [
	"leftOf", "rightOf", "startOf", "endOf", "alignLeft", "alignRight", "alignStart", "alignEnd",
	"alignParentLeft", "alignParentRight", "alignParentStart", "alignParentEnd", "centerHorizontal", "centerInParent"
];
const PREVIEW_VERTICAL_RULES: readonly (keyof DesignerRelativeRules)[] = [
	"above", "below", "alignBaseline", "alignTop", "alignBottom", "alignParentTop", "alignParentBottom",
	"centerVertical", "centerInParent"
];
const PREVIEW_LEFT_MARGIN_RULES: readonly (keyof DesignerRelativeRules)[] = [
	"rightOf", "endOf", "alignLeft", "alignStart", "alignParentLeft", "alignParentStart"
];
const PREVIEW_RIGHT_MARGIN_RULES: readonly (keyof DesignerRelativeRules)[] = [
	"leftOf", "startOf", "alignRight", "alignEnd", "alignParentRight", "alignParentEnd"
];
const PREVIEW_TOP_MARGIN_RULES: readonly (keyof DesignerRelativeRules)[] = ["below", "alignTop", "alignParentTop"];
const PREVIEW_BOTTOM_MARGIN_RULES: readonly (keyof DesignerRelativeRules)[] = [
	"above", "alignBaseline", "alignBottom", "alignParentBottom"
];

/** 预演一次相对布局拖拽将写入的规则和边距，不修改 XML。 */
export function previewDesignerRelativePlacement(
	component: Pick<DesignerComponentNode, "margin" | "relativeRules">,
	move: DesignerRelativePlacement
): DesignerRelativePlacementPreview {
	const currentRules = component.relativeRules ?? {};
	const rules: Record<string, boolean | string | undefined> = { ...currentRules };
	const margin: Partial<Record<keyof DesignerBoxSpacing, number | undefined>> = { ...component.margin };
	const hasRule = (candidates: readonly (keyof DesignerRelativeRules)[]): boolean => (
		candidates.some((candidate) => currentRules[candidate] !== undefined && currentRules[candidate] !== false)
	);
	const clearAxis = (axis: "horizontal" | "vertical"): void => {
		for (const projection of axis === "horizontal" ? PREVIEW_HORIZONTAL_RULES : PREVIEW_VERTICAL_RULES) {
			delete rules[projection];
		}
		if (axis === "horizontal") {
			delete margin.left;
			delete margin.right;
		} else {
			delete margin.top;
			delete margin.bottom;
		}
	};
	const horizontalChanged = move.deltaLeft !== 0 || move.horizontalDock !== undefined;
	const verticalChanged = move.deltaTop !== 0 || move.verticalDock !== undefined;
	const detachHorizontalCenter = move.horizontalDock === undefined
		&& move.deltaLeft !== 0
		&& (currentRules.centerInParent === true || currentRules.centerHorizontal === true);
	const detachVerticalCenter = move.verticalDock === undefined
		&& move.deltaTop !== 0
		&& (currentRules.centerInParent === true || currentRules.centerVertical === true);

	if (move.horizontalDock !== undefined) {
		clearAxis("horizontal");
		rules[move.horizontalDock.projection] = move.horizontalDock.targetXmlPath ?? true;
		if (move.margin?.left !== undefined) margin.left = move.margin.left;
		if (move.margin?.right !== undefined) margin.right = move.margin.right;
	} else if (detachHorizontalCenter) {
		clearAxis("horizontal");
		margin.left = move.left;
	} else if (move.deltaLeft !== 0) {
		if (hasRule(PREVIEW_LEFT_MARGIN_RULES) || !hasRule(PREVIEW_RIGHT_MARGIN_RULES)) {
			margin.left = (margin.left ?? 0) + move.deltaLeft;
		}
		if (hasRule(PREVIEW_RIGHT_MARGIN_RULES)) margin.right = (margin.right ?? 0) - move.deltaLeft;
	}
	if (move.verticalDock !== undefined) {
		clearAxis("vertical");
		rules[move.verticalDock.projection] = move.verticalDock.targetXmlPath ?? true;
		if (move.margin?.top !== undefined) margin.top = move.margin.top;
		if (move.margin?.bottom !== undefined) margin.bottom = move.margin.bottom;
	} else if (detachVerticalCenter) {
		clearAxis("vertical");
		margin.top = move.top;
	} else if (move.deltaTop !== 0) {
		if (hasRule(PREVIEW_TOP_MARGIN_RULES) || !hasRule(PREVIEW_BOTTOM_MARGIN_RULES)) {
			margin.top = (margin.top ?? 0) + move.deltaTop;
		}
		if (hasRule(PREVIEW_BOTTOM_MARGIN_RULES)) margin.bottom = (margin.bottom ?? 0) - move.deltaTop;
	}
	if (currentRules.centerInParent === true && horizontalChanged !== verticalChanged) {
		if (horizontalChanged) rules.centerVertical = true;
		else rules.centerHorizontal = true;
	}
	const projectedMargin = Object.values(margin).some((value) => value !== undefined)
		? margin as DesignerBoxSpacing
		: undefined;
	return { margin: projectedMargin, rules: rules as DesignerRelativeRules };
}

/**
 * 按 Android Studio 布局编辑器的整体拖动方式吸附到父级或同级边线。
 *
 * 这里只计算临时位置、示意线和可持久化停靠描述；XML 规则仍由宿主模型事务统一写回。
 */
export function resolveDesignerRelativeSnap(
	moving: DesignerRelativeSnapBounds,
	parent: DesignerRelativeSnapBounds,
	siblings: readonly DesignerRelativeSnapSibling[],
	axes: Readonly<{ horizontal: boolean; vertical: boolean }>,
	ruleLabels: DesignerRelativeRuleLabels,
	threshold = 6
): DesignerRelativeSnapResult {
	const movingRight = moving.left + moving.width;
	const movingBottom = moving.top + moving.height;
	const verticalCandidates: RelativeSnapCandidate[] = [];
	const horizontalCandidates: RelativeSnapCandidate[] = [];
	let candidateOrder = 0;
	const addVertical = (
		delta: number,
		position: number,
		targetBounds: DesignerRelativeSnapBounds,
		target: DesignerRelativeSnapGuide["target"],
		dock: DesignerRelativeSnapDock,
		priority = 2,
		proximity = 0,
		margin?: DesignerBoxSpacing
	): void => {
		const effectiveMargin = Math.abs(delta) <= threshold ? undefined : margin;
		const marginEntry = designerRelativeMarginEntry(effectiveMargin);
		const marginValue = marginEntry?.[1];
		const movingEdge = marginEntry?.[0] === "right" ? movingRight : moving.left;
		const label = designerRelativeDockLabel(dock, ruleLabels);
		const range = extendedDesignerRelativeGuideRange(
			Math.min(moving.top, targetBounds.top),
			Math.max(movingBottom, targetBounds.top + targetBounds.height),
			parent.top,
			parent.top + parent.height
		);
		verticalCandidates.push({
			distance: Math.hypot(delta, proximity),
			delta: Math.abs(delta) <= threshold ? delta : 0,
			guide: {
				axis: "vertical",
				...(marginEntry === undefined || marginValue === 0 ? {} : {
					connector: {
						axis: "horizontal" as const,
						end: Math.max(position, movingEdge),
						label: `${marginValue}dp`,
						marginSide: marginEntry[0],
						position: moving.top + moving.height / 2,
						start: Math.min(position, movingEdge)
					}
				}),
				dock,
				end: range.end,
				kind: "dock",
				label,
				labelPlacement: target === "parent" ? "middle" : "start",
				position,
				rule: dock.projection,
				start: range.start,
				target,
				title: label
			},
			margin: effectiveMargin,
			order: candidateOrder++,
			priority,
			proximity
		});
	};
	const addHorizontal = (
		delta: number,
		position: number,
		targetBounds: DesignerRelativeSnapBounds,
		target: DesignerRelativeSnapGuide["target"],
		dock: DesignerRelativeSnapDock,
		priority = 2,
		proximity = 0,
		margin?: DesignerBoxSpacing
	): void => {
		const effectiveMargin = Math.abs(delta) <= threshold ? undefined : margin;
		const marginEntry = designerRelativeMarginEntry(effectiveMargin);
		const marginValue = marginEntry?.[1];
		const movingEdge = marginEntry?.[0] === "bottom" ? movingBottom : moving.top;
		const label = designerRelativeDockLabel(dock, ruleLabels);
		const range = extendedDesignerRelativeGuideRange(
			Math.min(moving.left, targetBounds.left),
			Math.max(movingRight, targetBounds.left + targetBounds.width),
			parent.left,
			parent.left + parent.width
		);
		horizontalCandidates.push({
			distance: Math.hypot(delta, proximity),
			delta: Math.abs(delta) <= threshold ? delta : 0,
			guide: {
				axis: "horizontal",
				...(marginEntry === undefined || marginValue === 0 ? {} : {
					connector: {
						axis: "vertical" as const,
						end: Math.max(position, movingEdge),
						label: `${marginValue}dp`,
						marginSide: marginEntry[0],
						position: moving.left + moving.width / 2,
						start: Math.min(position, movingEdge)
					}
				}),
				dock,
				end: range.end,
				kind: "dock",
				label,
				labelPlacement: target === "parent" ? "middle" : "start",
				position,
				rule: dock.projection,
				start: range.start,
				target,
				title: label
			},
			margin: effectiveMargin,
			order: candidateOrder++,
			priority,
			proximity
		});
	};

	const parentRight = parent.left + parent.width;
	const parentBottom = parent.top + parent.height;
	const leftMargin = Math.round(moving.left - parent.left);
	const rightMargin = Math.round(parentRight - movingRight);
	const topMargin = Math.round(moving.top - parent.top);
	const bottomMargin = Math.round(parentBottom - movingBottom);
	const horizontalCenterDelta = Math.round(parent.left + parent.width / 2 - (moving.left + moving.width / 2));
	const verticalCenterDelta = Math.round(parent.top + parent.height / 2 - (moving.top + moving.height / 2));
	const horizontalCenterEligible = axes.horizontal && Math.abs(horizontalCenterDelta) <= threshold;
	const verticalCenterEligible = axes.vertical && Math.abs(verticalCenterDelta) <= threshold;
	const centerProjection = horizontalCenterEligible && verticalCenterEligible ? "centerInParent" : undefined;
	if (horizontalCenterEligible) {
		addVertical(horizontalCenterDelta, parent.left + parent.width / 2, parent, "parent", {
			axis: "horizontal",
			projection: centerProjection ?? "centerHorizontal"
		}, -1);
	}
	if (verticalCenterEligible) {
		addHorizontal(verticalCenterDelta, parent.top + parent.height / 2, parent, "parent", {
			axis: "vertical",
			projection: centerProjection ?? "centerVertical"
		}, -1);
	}
	addVertical(-leftMargin, parent.left, parent, "parent", {
		axis: "horizontal",
		projection: "alignParentLeft"
	}, 0, 0, leftMargin === 0 ? undefined : { left: leftMargin });
	addVertical(rightMargin, parentRight, parent, "parent", {
		axis: "horizontal",
		projection: "alignParentRight"
	}, 0, 0, rightMargin === 0 ? undefined : { right: rightMargin });
	addHorizontal(-topMargin, parent.top, parent, "parent", {
		axis: "vertical",
		projection: "alignParentTop"
	}, 0, 0, topMargin === 0 ? undefined : { top: topMargin });
	addHorizontal(bottomMargin, parentBottom, parent, "parent", {
		axis: "vertical",
		projection: "alignParentBottom"
	}, 0, 0, bottomMargin === 0 ? undefined : { bottom: bottomMargin });

	for (const sibling of siblings) {
		const siblingRight = sibling.left + sibling.width;
		const siblingBottom = sibling.top + sibling.height;
		const horizontalGap = Math.max(0, Math.max(moving.left, sibling.left) - Math.min(movingRight, siblingRight));
		const verticalGap = Math.max(0, Math.max(moving.top, sibling.top) - Math.min(movingBottom, siblingBottom));
		const dock = (axis: DesignerRelativeSnapDock["axis"], projection: DesignerRelativeSnapDock["projection"]): DesignerRelativeSnapDock => ({
			axis,
			projection,
			targetComponentName: sibling.componentName,
			targetXmlPath: sibling.xmlPath
		});
		/* RelativeLayout 没有同级中心约束；同级边线始终参与空间距离竞争，超出吸附范围时用边距保留落点。 */
		/* DOM 布局可能产生二进制浮点尾差；鼠标拖拽仍按整数 DIP 写回，手工小数属性不经过这里。 */
		const alignLeftDelta = Math.round(sibling.left - moving.left);
		const alignRightDelta = Math.round(siblingRight - movingRight);
		const leftOfDelta = Math.round(sibling.left - movingRight);
		const rightOfDelta = Math.round(siblingRight - moving.left);
		addVertical(alignLeftDelta, sibling.left, sibling, "sibling", dock("horizontal", "alignLeft"), 1, verticalGap,
			alignLeftDelta === 0 ? undefined : { left: -alignLeftDelta });
		addVertical(alignRightDelta, siblingRight, sibling, "sibling", dock("horizontal", "alignRight"), 1, verticalGap,
			alignRightDelta === 0 ? undefined : { right: alignRightDelta });
		addVertical(leftOfDelta, sibling.left, sibling, "sibling", dock("horizontal", "leftOf"), 0, verticalGap,
			leftOfDelta === 0 ? undefined : { right: leftOfDelta });
		addVertical(rightOfDelta, siblingRight, sibling, "sibling", dock("horizontal", "rightOf"), 0, verticalGap,
			rightOfDelta === 0 ? undefined : { left: -rightOfDelta });

		const alignTopDelta = Math.round(sibling.top - moving.top);
		const alignBottomDelta = Math.round(siblingBottom - movingBottom);
		const aboveDelta = Math.round(sibling.top - movingBottom);
		const belowDelta = Math.round(siblingBottom - moving.top);
		addHorizontal(alignTopDelta, sibling.top, sibling, "sibling", dock("vertical", "alignTop"), 1, horizontalGap,
			alignTopDelta === 0 ? undefined : { top: -alignTopDelta });
		addHorizontal(alignBottomDelta, siblingBottom, sibling, "sibling", dock("vertical", "alignBottom"), 1, horizontalGap,
			alignBottomDelta === 0 ? undefined : { bottom: alignBottomDelta });
		addHorizontal(aboveDelta, sibling.top, sibling, "sibling", dock("vertical", "above"), 0, horizontalGap,
			aboveDelta === 0 ? undefined : { bottom: aboveDelta });
		addHorizontal(belowDelta, siblingBottom, sibling, "sibling", dock("vertical", "below"), 0, horizontalGap,
			belowDelta === 0 ? undefined : { top: -belowDelta });
	}

	const candidateScore = (candidate: RelativeSnapCandidate): number => (
		candidate.distance * 100
		+ candidate.priority
		+ candidate.order / 10_000
	);
	const nearest = (candidates: readonly RelativeSnapCandidate[]): readonly RelativeSnapCandidate[] => (
		[...candidates]
			.sort((left, right) => candidateScore(left) - candidateScore(right))
	);
	const horizontalOptions = axes.horizontal ? nearest(verticalCandidates) : [];
	const verticalOptions = axes.vertical ? nearest(horizontalCandidates) : [];
	const centerCandidate = (candidate: RelativeSnapCandidate): boolean => (
		candidate.guide.dock.projection === "centerInParent"
		|| candidate.guide.dock.projection === "centerHorizontal"
		|| candidate.guide.dock.projection === "centerVertical"
	);
	const horizontalSnap = horizontalOptions.find(centerCandidate) ?? horizontalOptions[0];
	const verticalSnap = verticalOptions.find(centerCandidate) ?? verticalOptions[0];
	const margin = { ...horizontalSnap?.margin, ...verticalSnap?.margin };
	return {
		guides: [horizontalSnap?.guide, verticalSnap?.guide]
			.filter((guide): guide is DesignerRelativeSnapGuide => guide !== undefined),
		horizontalDock: horizontalSnap?.guide.dock,
		left: moving.left + (horizontalSnap?.delta ?? 0),
		margin: Object.values(margin).some((value) => value !== undefined) ? margin as DesignerBoxSpacing : undefined,
		top: moving.top + (verticalSnap?.delta ?? 0),
		verticalDock: verticalSnap?.guide.dock
	};
}

/** 单帧布局停靠文案只描述实际位置，不重复显示属性名。 */
export function designerFrameRuleLabels(): DesignerRelativeRuleLabels {
	return {
		alignParentBottom: "底部对齐",
		alignParentLeft: "左对齐",
		alignParentRight: "右对齐",
		alignParentTop: "顶部对齐",
		centerHorizontal: "水平居中",
		centerInParent: "居中",
		centerVertical: "垂直居中"
	};
}

/** 单帧布局的二维对齐与属性框保持同一套九宫格值，只显示一次。 */
export function designerFrameAlignmentLabel(alignment: DesignerAlignment | undefined): string {
	const horizontal = alignment?.horizontal ?? "left";
	const vertical = alignment?.vertical ?? "top";
	return {
		"left:top": "左上",
		"center:top": "中上",
		"right:top": "右上",
		"left:center": "左中",
		"center:center": "居中",
		"right:center": "右中",
		"left:bottom": "左下",
		"center:bottom": "中下",
		"right:bottom": "右下"
	}[`${horizontal}:${vertical}`] ?? "左上";
}

/** 单帧布局把二维对齐文字放到垂直边距文字的另一侧；居中时交给画布按可用空间选择。 */
export function designerFrameAlignmentLabelSide(
	alignment: DesignerAlignment | undefined
): "above" | "below" | undefined {
	const vertical = alignment?.vertical ?? "top";
	if (vertical === "top") return "below";
	if (vertical === "bottom") return "above";
	return undefined;
}

/** 把单帧布局拖动换算为父级对齐、边距及与相对布局一致的示意线。 */
export function resolveDesignerFrameSnap(
	moving: DesignerRelativeSnapBounds,
	parent: DesignerRelativeSnapBounds,
	threshold = 6
): DesignerFrameSnapResult {
	const snapped = resolveDesignerRelativeSnap(
		moving,
		parent,
		[],
		{ horizontal: true, vertical: true },
		designerFrameRuleLabels(),
		threshold
	);
	const horizontal = snapped.horizontalDock?.projection === "alignParentRight"
		? "right"
		: snapped.horizontalDock?.projection === "centerHorizontal"
			|| snapped.horizontalDock?.projection === "centerInParent"
			? "center"
			: "left";
	const vertical = snapped.verticalDock?.projection === "alignParentBottom"
		? "bottom"
		: snapped.verticalDock?.projection === "centerVertical"
			|| snapped.verticalDock?.projection === "centerInParent"
			? "center"
			: "top";
	return {
		guides: snapped.guides,
		left: snapped.left,
		placement: {
			alignment: { horizontal, vertical },
			margin: snapped.margin
		},
		top: snapped.top
	};
}

/** 把表格行列标签放在格子外侧；按顶、右、底、左选择有效区域内能完整显示的一边。 */
export function designerGridPositionLabelBounds(
	cell: DesignerRelativeSnapBounds,
	availableBounds: DesignerRelativeSnapBounds,
	label: Readonly<{ height: number; width: number }>,
	gap = 1,
	inset = 4
): DesignerRelativeSnapBounds {
	const width = Math.max(0, label.width);
	const height = Math.max(0, label.height);
	const minimumLeft = availableBounds.left + inset;
	const maximumRight = availableBounds.left + availableBounds.width - inset;
	const minimumTop = availableBounds.top + inset;
	const maximumBottom = availableBounds.top + availableBounds.height - inset;
	const maximumLeft = maximumRight - width;
	const maximumTop = maximumBottom - height;
	const horizontalPosition = Math.min(maximumLeft, Math.max(minimumLeft, cell.left + (cell.width - width) / 2));
	const verticalPosition = Math.min(maximumTop, Math.max(minimumTop, cell.top + (cell.height - height) / 2));
	const candidates = [
		{
			available: cell.top - gap - height >= minimumTop && width <= maximumRight - minimumLeft,
			clearance: cell.top - minimumTop,
			left: horizontalPosition,
			top: cell.top - gap - height
		},
		{
			available: cell.left + cell.width + gap + width <= maximumRight && height <= maximumBottom - minimumTop,
			clearance: maximumRight - cell.left - cell.width,
			left: cell.left + cell.width + gap,
			top: verticalPosition
		},
		{
			available: cell.top + cell.height + gap + height <= maximumBottom && width <= maximumRight - minimumLeft,
			clearance: maximumBottom - cell.top - cell.height,
			left: horizontalPosition,
			top: cell.top + cell.height + gap
		},
		{
			available: cell.left - gap - width >= minimumLeft && height <= maximumBottom - minimumTop,
			clearance: cell.left - minimumLeft,
			left: cell.left - gap - width,
			top: verticalPosition
		}
	];
	const position = candidates.find((candidate) => candidate.available)
		?? candidates.reduce((best, candidate) => candidate.clearance > best.clearance ? candidate : best);
	return {
		height,
		left: position.left,
		top: position.top,
		width
	};
}

/** 画布顶层拖放反馈的矩形和用途；只描述临时交互，不进入组件或 XML 模型。 */
export interface DesignerDragFeedback {
	readonly absoluteCoordinates?: Readonly<{
		readonly x: number;
		readonly y: number;
	}>;
	readonly guides?: readonly DesignerRelativeGuide[];
	readonly gridPosition?: DesignerGridPosition;
	readonly height: number;
	readonly kind:
		| "absolute"
		| "container"
		| "frame"
		| "grid"
		| "relative"
		| "insert-after-horizontal"
		| "insert-after-vertical"
		| "insert-before-horizontal"
		| "insert-before-vertical";
	readonly left: number;
	readonly placementLabel?: string;
	readonly placementLabelSide?: "above" | "below";
	readonly showBounds?: boolean;
	readonly top: number;
	readonly width: number;
}

/** 可用组件菜单解析出的 XML 容器及可选表格位置。 */
export interface DesignerAddTarget {
	readonly gridPosition?: DesignerGridPosition;
	readonly parentXmlPath: string;
	readonly position?: "after" | "before";
	readonly referenceXmlPath?: string;
	readonly target: "canvas" | "nonvisual";
}

/** 从定义类型生成与项目树一致的低保真设计期图形。 */
export function componentGlyph(type: string): string {
	if (type.includes("计时")) return "◷";
	if (type.includes("按钮")) return "▣";
	if (type.includes("标签") || type.includes("文本")) return "T";
	if (type.includes("图片")) return "▧";
	if (type.includes("面板") || type.includes("滚动框")) return "▤";
	return "◇";
}

/** 返回组件统一使用的悬停提示。 */
export function componentHoverHint(node: DesignerComponentNode): string {
	const summary = node.name + " - " + (node.runtimeType ?? node.type);
	const description = sdkDescriptionHoverHint(node.description);
	const details = node.container ? ["拖入可视组件"] : [];
	if (
		node.relativeRules !== undefined
		&& node.relativePositionIssue === undefined
		&& Object.values(node.relativeRules).every((value) => value === undefined || value === false)
	) {
		details.push("未设置相对关系，按父级左上角及边距定位");
	}
	if (node.layoutGridSizeValid === false) {
		details.push("表格布局需要有效的行数和列数");
	}
	if (node.gridPositionValid === false) {
		details.push(node.gridPositionIssue === "out-of-bounds"
			? "行或列超出表格范围，运行时不会放置此组件"
			: node.gridPositionIssue === "duplicate"
				? "该单元格声明了多个组件，设计器无法确定运行时位置"
				: node.gridPositionIssue === "parent-size"
					? "父表格没有有效的行数和列数，运行时不会放置此组件"
					: "缺少有效的行和列，运行时不会放置此组件");
	}
	if (node.relativePositionIssue !== undefined) {
		details.push(node.relativePositionIssue === "missing-anchor"
			? "相对布局引用的同级组件不存在，暂按左上位置显示"
			: "相对布局表达式无法由 XML 属性直接确定，暂按左上位置显示");
	}
	return [summary, description, ...details]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

/** 将 SDK Markdown 描述转换为设计器原生悬停可显示的多行纯文本。 */
export function sdkDescriptionHoverHint(description: string | undefined, fallback?: string): string | undefined {
	if (description === undefined || description.length === 0) return fallback;
	const plainText = markdownDocumentationToPlainText(description);
	return plainText.length === 0 ? fallback : plainText;
}

/** 返回可用组件列表使用的“短名称：完整类名 + SDK 描述”悬停提示。 */
export function componentTypeHoverHint(
	name: string,
	runtimeType: string,
	description: string | undefined
): string {
	const summary = name + " - " + runtimeType;
	const normalizedDescription = sdkDescriptionHoverHint(description);
	return normalizedDescription === undefined ? summary : `${summary}\n${normalizedDescription}`;
}

/** 把 Simple 长度投影为 Vue class 和 style。 */
function applyLength(
	classes: string[],
	style: CSSProperties,
	dimension: "height" | "width",
	length: DesignerLength | undefined
): void {
	if (length === undefined) return;
	if (length.kind === "content" || length.kind === "parent") {
		classes.push(`designer-${dimension}-${length.kind}`);
		return;
	}
	classes.push(`designer-${dimension}-fixed`);
	const value = length.value + "px";
	style[dimension] = value;
	if (dimension === "width") {
		style.minWidth = value;
		style.maxWidth = value;
	} else {
		style.minHeight = value;
		style.maxHeight = value;
	}
}

/** 把组件自身和相对父布局的样式合并为 Vue 可绑定数据。 */
export function componentPresentation(
	node: DesignerComponentNode,
	selectedPath: string | undefined,
	kind: "container" | "control",
	relativePosition?: DesignerProjectedRelativePosition
): { readonly classes: readonly string[]; readonly style: CSSProperties } {
	const classes = ["visual-node", kind === "container" ? "container-node" : "visual-control"];
	const style: CSSProperties = {};
	const hasProjectedContent = kind === "container"
		? node.children.some((child) => child.visual)
		: node.displayTextPlaceholder !== true;
	if (!hasProjectedContent) {
		/* 空内容自适应尺寸需要可见、可命中，但不能把交互下限施加到其它长度模式。 */
		classes.push("designer-empty-content");
	}
	if (node.path === selectedPath) {
		classes.push("selected");
	}
	if (kind === "control" && node.contentAlignment !== undefined) {
		if (node.contentAlignment.horizontal !== undefined) {
			classes.push("designer-content-horizontal-" + node.contentAlignment.horizontal);
		}
		if (node.contentAlignment.vertical !== undefined) {
			classes.push("designer-content-vertical-" + node.contentAlignment.vertical);
		}
	}
	if (kind === "control") {
		classes.push(node.textComponent ? "designer-text-control" : "designer-placeholder-control");
		if (node.displayTextPlaceholder === true) {
			classes.push("designer-display-placeholder");
		}
		if (node.singleLine !== undefined) {
			classes.push(node.singleLine ? "designer-single-line" : "designer-multiline");
		}
	}
	if (node.gridPositionValid === false) classes.push("designer-grid-position-invalid");
	if (node.layoutGridSizeValid === false) classes.push("designer-grid-size-invalid");
	if (node.absolutePosition !== undefined) {
		classes.push("designer-absolute-positioned");
		style["--designer-absolute-left"] = node.absolutePosition.left + "px";
		style["--designer-absolute-top"] = node.absolutePosition.top + "px";
	}
	if (relativePosition !== undefined) {
		classes.push("designer-relative-positioned");
		style["--designer-relative-left"] = relativePosition.left + "px";
		style["--designer-relative-top"] = relativePosition.top + "px";
		if (relativePosition.issue !== undefined) classes.push("designer-relative-position-invalid");
	}
	applyLength(classes, style, "width", node.width);
	applyLength(classes, style, "height", node.height);
	if (node.margin !== undefined) {
		for (const side of ["bottom", "left", "right", "top"] as const) {
			const value = node.margin[side];
			if (value === undefined) continue;
			style[`--designer-margin-${side}`] = value + "px";
			if (relativePosition === undefined) style[`margin-${side}`] = value + "px";
		}
	}
	/* 普通组件的填充只内缩自身内容，不参与父布局中的外框占位。 */
	if (kind === "control" && node.padding !== undefined) {
		for (const side of ["bottom", "left", "right", "top"] as const) {
			const value = node.padding[side];
			if (value !== undefined) style[`padding-${side}`] = value + "px";
		}
	}
	if (node.alignment?.horizontal !== undefined) {
		classes.push("designer-align-horizontal-" + node.alignment.horizontal);
	}
	if (node.alignment?.vertical !== undefined) {
		classes.push("designer-align-vertical-" + node.alignment.vertical);
	}
	if (node.gridPositionValid === false) {
		/* 无效表格位置统一显示在网格之后，不能伪装成运行时可放置的单元格。 */
		style.gridColumn = "1 / -1";
	}
	if (node.weight !== undefined && node.weight > 0) {
		classes.push("designer-weighted");
		style.maxWidth = "none";
		style.maxHeight = "none";
		style["--designer-component-weight"] = String(node.weight);
	}
	Object.assign(style, appearanceStyle(node));
	return { classes, style };
}

/** 根据有效行列数建立空单元格，并标记当前已经声明位置的第一个组件。 */
export function designerGridCells(node: DesignerComponentNode): readonly DesignerGridCell[] {
	if (
		node.layout !== "grid"
		|| node.layoutGridSizeValid !== true
		|| node.layoutColumns === undefined
		|| node.layoutRows === undefined
	) return [];
	const occupied = new Map<string, { readonly index: number; readonly node: DesignerComponentNode }>();
	for (const [index, child] of node.children.entries()) {
		if (
			!child.visual
			|| child.gridColumn === undefined
			|| child.gridRow === undefined
			|| child.gridColumn < 0
			|| child.gridColumn >= node.layoutColumns
			|| child.gridRow < 0
			|| child.gridRow >= node.layoutRows
		) continue;
		const key = child.gridRow + ":" + child.gridColumn;
		if (!occupied.has(key)) occupied.set(key, { index, node: child });
	}
	const cells: DesignerGridCell[] = [];
	for (let row = 0; row < node.layoutRows; row += 1) {
		for (let column = 0; column < node.layoutColumns; column += 1) {
			const key = row + ":" + column;
			const occupiedComponent = occupied.get(key);
			cells.push({
				column,
				key,
				occupiedComponent,
				occupiedComponentPath: occupiedComponent?.node.path,
				row
			});
		}
	}
	return cells;
}

/** 表格中只有行列有效的可视子组件进入单元格，其余组件留在独立的未放置区域。 */
export function isDesignerGridPlacedChild(
	parent: DesignerComponentNode,
	child: DesignerComponentNode
): boolean {
	return child.visual && (parent.layout !== "grid" || child.gridPositionValid === true);
}

/** 返回表格中无法对应有效单元格的可视子组件及其原始同级位置。 */
export function designerGridUnplacedChildren(
	node: DesignerComponentNode
): readonly { readonly index: number; readonly node: DesignerComponentNode }[] {
	if (node.layout !== "grid") return [];
	return node.children
		.map((child, index) => ({ index, node: child }))
		.filter(({ node: child }) => child.visual && child.gridPositionValid !== true);
}

/** 按 XML 路径查找组件树节点，供网页端各视图复用同一组件信息。 */
export function findDesignerComponentNode(
	root: DesignerComponentNode,
	targetPath: string
): DesignerComponentNode | undefined {
	if (root.path === targetPath) return root;
	for (const child of root.children) {
		const nested = findDesignerComponentNode(child, targetPath);
		if (nested !== undefined) return nested;
	}
	return undefined;
}

/**
 * 返回键盘粘贴使用的容器路径。
 *
 * 选中容器时粘贴到容器内部；选中普通组件时粘贴到其直接父容器，形成同级组件。
 */
export function resolveDesignerPasteTargetPath(
	selectedComponent: DesignerComponentNode | undefined
): string | undefined {
	if (selectedComponent === undefined || selectedComponent.layoutReadOnly === true) return undefined;
	return selectedComponent.container && selectedComponent.acceptsVisualChild !== false
		? selectedComponent.path
		: selectedComponent.parentPath;
}

/**
 * 按当前选择解析可用组件菜单的追加目标。
 *
 * 非可视组件固定进入窗口根节点；选中窗口时放在首个可视组件前，选中普通可视
 * 组件时放在它后面。容器优先接收子组件，不能接收时只回退到该容器的同级后方。
 */
export function resolveDesignerAddTarget(
	root: DesignerComponentNode | undefined,
	selectedComponent: DesignerComponentNode | undefined,
	selectedGridCell: DesignerGridCellSelection | undefined,
	visual: boolean
): DesignerAddTarget | undefined {
	if (root === undefined || !root.container || root.layoutReadOnly === true) return undefined;
	if (!visual) {
		return { parentXmlPath: root.path, target: "nonvisual" };
	}
	const selected = selectedComponent ?? root;
	if (selected.container) {
		if (selected.acceptsVisualChild !== false && selected.layout !== "grid") {
			if (selected.path !== root.path) {
				return { parentXmlPath: selected.path, target: "canvas" };
			}
			const firstVisualChild = root.children.find((child) => child.visual);
			return firstVisualChild === undefined
				? { parentXmlPath: root.path, target: "canvas" }
				: {
					parentXmlPath: root.path,
					position: "before",
					referenceXmlPath: firstVisualChild.path,
					target: "canvas"
				};
		}
		if (selected.acceptsVisualChild !== false && selected.layout === "grid") {
			const cell = selectedGridCell?.parentXmlPath === selected.path
				? designerGridCells(selected).find((candidate) => (
					candidate.row === selectedGridCell.row && candidate.column === selectedGridCell.column
				))
				: undefined;
			if (cell !== undefined && cell.occupiedComponentPath === undefined) {
				return {
					gridPosition: { column: cell.column, row: cell.row },
					parentXmlPath: selected.path,
					target: "canvas"
				};
			}
		}
		if (selected.path === root.path || selected.parentPath === undefined || !selected.visual) return undefined;
		const parent = findDesignerComponentNode(root, selected.parentPath);
		if (
			parent === undefined
			|| !parent.container
			|| parent.acceptsVisualChild === false
			|| parent.layout === "grid"
		) return undefined;
		return {
			parentXmlPath: parent.path,
			position: "after",
			referenceXmlPath: selected.path,
			target: "canvas"
		};
	}
	if (selected.parentPath === undefined) return undefined;
	const parent = findDesignerComponentNode(root, selected.parentPath);
	if (
		parent === undefined
		|| !parent.container
		|| parent.acceptsVisualChild === false
		|| parent.layout === "grid"
	) return undefined;
	if (!selected.visual) {
		return { parentXmlPath: parent.path, target: "canvas" };
	}
	return {
		parentXmlPath: parent.path,
		position: "after",
		referenceXmlPath: selected.path,
		target: "canvas"
	};
}

/** 把 Java 运行库可确定的颜色和文本样式投影为 CSS。 */
export function appearanceStyle(node: DesignerComponentNode): CSSProperties {
	const style: CSSProperties = {};
	if (node.backgroundColor !== undefined) style.backgroundColor = node.backgroundColor;
	if (node.fontBold !== undefined) style.fontWeight = node.fontBold ? "700" : "400";
	if (node.fontFamily !== undefined) style.fontFamily = node.fontFamily;
	if (node.fontItalic !== undefined) style.fontStyle = node.fontItalic ? "italic" : "normal";
	if (node.fontSize !== undefined) style.fontSize = node.fontSize + "px";
	if (node.textColor !== undefined) style.color = node.textColor;
	return style;
}

/** 滚动框由组件类型决定方向，其它容器读取自身布局设置。 */
export function designerLayoutClass(node: DesignerComponentNode): string {
	const hiddenScrollbar = node.scrollbarEnabled === false ? " container-scrollbar-hidden" : "";
	if (node.type === "水平滚动框") return "layout-linear-horizontal container-scroll-horizontal" + hiddenScrollbar;
	if (node.type === "垂直滚动框") return "layout-linear-vertical container-scroll-vertical" + hiddenScrollbar;
	return "layout-" + node.layout;
}

/** 把设计期间隙与容器填充合并到子布局区，只内缩布局可用空间。 */
export function containerInsetStyle(node: DesignerComponentNode): CSSProperties {
	const style: CSSProperties = {};
	if (node.padding !== undefined) {
		for (const side of ["bottom", "left", "right", "top"] as const) {
			const value = node.padding[side];
			if (value !== undefined) {
				style[`padding-${side}`] = `calc(var(--designer-layout-spacing) + ${value}px)`;
			}
		}
	}
	return style;
}

/** 把容器表格规模和内容对齐投影到不会覆盖外层间隙的真实布局区。 */
export function containerStyle(node: DesignerComponentNode): CSSProperties {
	const style: CSSProperties = {};
	const layout = node.type === "水平滚动框"
		? "linear-horizontal"
		: node.type === "垂直滚动框" ? "linear-vertical" : node.layout;
	if (layout === "absolute") {
		style["--designer-absolute-inset-left"] = "0px";
		style["--designer-absolute-inset-top"] = "0px";
	} else if (layout === "grid") {
		if (node.layoutColumns !== undefined) {
			/* Android 表格先按每列内容确定自然宽度，再按可收缩、可拉伸设置处理剩余空间。 */
			const columnTrack = node.layoutAllColumnsShrinkable === true ? "minmax(0, auto)" : "auto";
			style.gridTemplateColumns = `repeat(${node.layoutColumns}, ${columnTrack})`;
			style.justifyContent = node.layoutAllColumnsStretchable === false ? "start" : "stretch";
		}
		if (node.layoutRows !== undefined) {
			const occupiedRows = new Set(
				designerGridCells(node)
					.filter((cell) => cell.occupiedComponent !== undefined)
					.map((cell) => cell.row)
			);
			if (occupiedRows.size === 0) {
				/* 全空表格把现有高度等分成可交互格子，格子很小时也不强设最小高度。 */
				style.gridTemplateRows = `repeat(${node.layoutRows}, minmax(0, 1fr))`;
			} else if (occupiedRows.size === node.layoutRows) {
				/* Android TableRow 缺省为 WRAP_CONTENT；全部占用时各行按组件内容收缩。 */
				style.gridTemplateRows = `repeat(${node.layoutRows}, max-content)`;
			} else {
				/* 有组件的行按内容收缩，空行继续分配容器剩余高度供设计期交互。 */
				style.gridTemplateRows = Array.from(
					{ length: node.layoutRows },
					(_, row) => occupiedRows.has(row) ? "max-content" : "minmax(0, 1fr)"
				).join(" ");
			}
			style.alignContent = "start";
		}
	} else if (layout === "frame") {
		/* 单帧只有一个铺满容器的网格区域，保证缺省 MATCH_PARENT 有确定的宽高基准。 */
		style.gridTemplateColumns = "minmax(0, 1fr)";
		style.gridTemplateRows = "minmax(0, 1fr)";
	}
	const alignment = node.layoutContentAlignment;
	if (layout === "grid") {
		if (alignment?.horizontal !== undefined) {
			style.justifyContent = alignment.horizontal === "left"
				? "start"
				: alignment.horizontal === "right" ? "end" : "center";
		}
		if (alignment?.vertical !== undefined) {
			style.alignContent = alignment.vertical === "top"
				? "start"
				: alignment.vertical === "bottom" ? "end" : "center";
		}
	} else if (layout === "linear-horizontal") {
		if (alignment?.horizontal !== undefined) {
			style.justifyContent = alignment.horizontal === "left"
				? "flex-start"
				: alignment.horizontal === "right" ? "flex-end" : "center";
		}
		if (alignment?.vertical !== undefined) {
			style.alignItems = alignment.vertical === "top"
				? "flex-start"
				: alignment.vertical === "bottom" ? "flex-end" : "center";
		}
		if (node.layoutBaselineAligned === true) style.alignItems = "baseline";
	} else if (layout === "linear-vertical") {
		if (alignment?.vertical !== undefined) {
			style.justifyContent = alignment.vertical === "top"
				? "flex-start"
				: alignment.vertical === "bottom" ? "flex-end" : "center";
		}
		if (alignment?.horizontal !== undefined) {
			style.alignItems = alignment.horizontal === "left"
				? "flex-start"
				: alignment.horizontal === "right" ? "flex-end" : "center";
		}
	}
	return style;
}

/** 返回权重总和中没有被组件使用的份额。 */
export function weightRemainder(node: DesignerComponentNode): number {
	if (node.layoutWeightSum === undefined || !designerLayoutClass(node).startsWith("layout-linear-")) return 0;
	const assigned = node.children.filter((child) => child.visual)
		.reduce((sum, child) => sum + (child.weight ?? 0), 0);
	return Math.max(0, node.layoutWeightSum - assigned);
}

/** 将浏览器计算样式中的像素值转换为有限数值。 */
function pixelValue(value: string): number {
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

/** 保留画布控件完整文本，并在组件自身内容盒不足时补充悬停提示。 */
export function syncVisualControlContents(windowContent: HTMLElement): void {
	for (const control of windowContent.querySelectorAll<HTMLElement>(".visual-control")) {
		const content = control.querySelector<HTMLElement>(".visual-control-content");
		if (content === null) continue;
		const fullText = content.dataset.fullText ?? "";
		const baseHoverHint = control.dataset.hoverHint ?? control.title;
		content.textContent = fullText;
		control.title = baseHoverHint;
		if (fullText.trim().length === 0) continue;
		const controlBounds = control.getBoundingClientRect();
		const style = window.getComputedStyle(control);
		const contentLeft = controlBounds.left
			+ pixelValue(style.borderLeftWidth) + pixelValue(style.paddingLeft);
		const contentTop = controlBounds.top
			+ pixelValue(style.borderTopWidth) + pixelValue(style.paddingTop);
		const contentRight = controlBounds.right
			- pixelValue(style.borderRightWidth) - pixelValue(style.paddingRight);
		const contentBottom = controlBounds.bottom
			- pixelValue(style.borderBottomWidth) - pixelValue(style.paddingBottom);
		const completeTextFits = content.scrollWidth <= Math.max(0, contentRight - contentLeft) + 0.5
			&& content.scrollHeight <= Math.max(0, contentBottom - contentTop) + 0.5;
		if (completeTextFits) continue;
		control.title = baseHoverHint + "\n文本：" + fullText;
	}
}
