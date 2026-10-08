<!--
呈现固定 DIP 窗口画布及其可视组件树，不执行 Simple 运行时表达式。
xhwsd@qq.com 2026-8-30
-->

<template>
	<div
		ref="canvasElement"
		:class="['section-content', 'designer-canvas', { 'designer-debug': props.debug }]"
		@pointerdown.capture="selectComponentAtPointer"
		@pointermove="handleCanvasPointerMove"
		@pointerup="finishResize"
		@pointercancel="cancelResize"
		@lostpointercapture="resizePointerCaptureLost"
		@pointerleave="clearHoveredComponent"
		@scroll.capture="positionNameOverlays"
	>
		<div v-if="projection.root === undefined" class="designer-empty">
			{{ projection.emptyMessage ?? "当前窗口无法预览。" }}
		</div>
		<div
			v-else
			class="window-node"
			:data-node-path="projection.root.path"
			:data-component-path="projection.root.path"
			:data-component-type="projection.root.type"
			:data-menu-label="projection.root.name"
			data-component-actions="false"
			:title="componentHoverHint(projection.root)"
			@dblclick="openRootCode"
		>
			<div
				class="window-title"
				:data-node-path="projection.root.path"
				:title="componentHoverHint(projection.root)"
			>{{ projection.root.displayText }}</div>
			<div
				class="window-content"
				:style="windowContentStyle"
				:title="componentHoverHint(projection.root)"
			>
				<div
					ref="windowLayoutSurface"
					:class="['window-layout-surface', designerLayoutClass(projection.root), { 'window-scrollable': projection.root.scrollable === true }]"
					:style="windowLayoutStyle"
					:data-layout-surface-path="projection.root.path"
					:data-drop-target="projection.root.acceptsVisualChild === false ? undefined : projection.root.path"
					:data-accept="projection.root.acceptsVisualChild === false ? undefined : 'visual'"
					:title="componentHoverHint(projection.root)"
				>
					<div v-if="projection.root.layout === 'unsupported'" class="designer-unsupported-layout-notice">
						当前布局尚未适配，仅按组件顺序展示
					</div>
				<div
					v-for="cell in rootGridCells"
					:key="'grid:' + cell.key"
					:class="['designer-grid-cell', {
						'designer-grid-cell-occupied': cell.occupiedComponentPath !== undefined,
						'designer-grid-cell-selected': cell.occupiedComponentPath === undefined
							&& selectedGridCell?.parentXmlPath === projection.root.path
							&& selectedGridCell.row === cell.row
							&& selectedGridCell.column === cell.column
					}]"
					:style="{ gridColumn: String(cell.column + 1), gridRow: String(cell.row + 1) }"
					:data-grid-cell-parent="projection.root.path"
					:data-grid-cell-row="cell.row"
					:data-grid-cell-column="cell.column"
					:data-grid-cell-occupied="cell.occupiedComponentPath"
					:title="`第 ${cell.row + 1} 行，第 ${cell.column + 1} 列`"
					@click.stop="selectGridCell(projection.root.path, cell)"
				>
					<DesignerNode
						v-if="cell.occupiedComponent !== undefined"
						:node="cell.occupiedComponent.node"
						:selected-grid-cell="selectedGridCell"
						:selected-path="projection.selectedPath"
						:move="{
							previous: projection.root.children.slice(0, cell.occupiedComponent.index)
								.some((candidate) => candidate.visual === cell.occupiedComponent?.node.visual),
							next: projection.root.children.slice(cell.occupiedComponent.index + 1)
								.some((candidate) => candidate.visual === cell.occupiedComponent?.node.visual)
						}"
						@select="$emit('select', $event)"
						@select-grid-cell="$emit('selectGridCell', $event)"
					/>
				</div>
				<template v-for="(child, index) in projection.root.children" :key="child.path">
					<DesignerNode
						v-if="projection.root.layout !== 'grid' && isDesignerGridPlacedChild(projection.root, child)"
						:node="child"
						:relative-position="rootRelativePositions.get(child.path)"
						:selected-grid-cell="selectedGridCell"
						:selected-path="projection.selectedPath"
						:move="{
							previous: projection.root.children.slice(0, index).some((candidate) => candidate.visual === child.visual),
							next: projection.root.children.slice(index + 1).some((candidate) => candidate.visual === child.visual)
						}"
						@select="$emit('select', $event)"
						@select-grid-cell="$emit('selectGridCell', $event)"
					/>
				</template>
				<div
					v-if="rootUnplacedChildren.length > 0"
					class="designer-grid-unplaced"
					:style="{ gridRow: String((projection.root.layoutRows ?? 0) + 1) }"
				>
					<span class="designer-grid-unplaced-label">未放置</span>
					<DesignerNode
						v-for="entry in rootUnplacedChildren"
						:key="'unplaced:' + entry.node.path"
						:node="entry.node"
						:selected-grid-cell="selectedGridCell"
						:selected-path="projection.selectedPath"
						:move="{
							previous: projection.root.children.slice(0, entry.index)
								.some((candidate) => candidate.visual === entry.node.visual),
							next: projection.root.children.slice(entry.index + 1)
								.some((candidate) => candidate.visual === entry.node.visual)
						}"
						@select="$emit('select', $event)"
						@select-grid-cell="$emit('selectGridCell', $event)"
					/>
				</div>
				<div
					v-if="rootRemainder > 0"
					class="designer-weight-remainder"
					:style="{ '--designer-component-weight': String(rootRemainder) }"
				></div>
				</div>
			</div>
		</div>
		<div class="designer-interaction-layer">
			<div
				v-if="dragHoveredPath === undefined && hoveredFeedbackPath !== undefined"
				class="designer-component-feedback designer-component-feedback-hovered"
				:style="hoveredFeedbackStyle"
			></div>
			<div
				v-if="selectedFeedbackPath !== undefined"
				class="designer-component-feedback designer-component-feedback-selected"
				:style="selectedFeedbackStyle"
				:data-component-path="selectedFeedbackPath"
			>
				<button
					v-for="handle in resizeHandles"
					:key="handle"
					type="button"
					tabindex="-1"
					:class="['designer-resize-handle', 'designer-resize-handle-' + handle]"
					:data-resize-handle="handle"
					:title="selectedVisualComponent === undefined ? undefined : componentHoverHint(selectedVisualComponent)"
					:aria-label="resizeHandleAriaLabel(handle)"
				></button>
			</div>
		</div>
		<div v-if="showComponentLabels" class="designer-label-layer">
			<div
				v-if="selectedComponentName !== undefined && selectedVisualComponent !== undefined"
				ref="selectedNameElement"
				class="designer-component-name designer-component-name-selected"
				:style="selectedNameStyle"
				:data-component-path="selectedVisualComponent.path"
				:data-component-parent-path="selectedVisualComponent.parentPath"
				:data-drag-component-path="selectedVisualComponent.positionReadOnly === true && selectedVisualComponent.positionDraggable !== true ? undefined : selectedVisualComponent.path"
				:data-drag-component-type="selectedVisualComponent.positionReadOnly === true && selectedVisualComponent.positionDraggable !== true ? undefined : selectedVisualComponent.type"
				:data-drag-component-visual="selectedVisualComponent.positionReadOnly === true && selectedVisualComponent.positionDraggable !== true ? undefined : 'true'"
				:data-selected-move-path="selectedVisualComponent.positionReadOnly === true && selectedVisualComponent.positionDraggable !== true ? undefined : selectedVisualComponent.path"
				:title="componentHoverHint(selectedVisualComponent)"
				:draggable="selectedVisualComponent.positionReadOnly !== true || selectedVisualComponent.positionDraggable === true"
			><span class="designer-component-name-text">{{ selectedComponentName }}</span></div>
			<div
				v-if="hoveredComponentName !== undefined && displayedHoveredPath !== projection.selectedPath"
				ref="hoveredNameElement"
				class="designer-component-name designer-component-name-hovered"
				:style="hoveredNameStyle"
			><span class="designer-component-name-text">{{ hoveredComponentName }}</span></div>
		</div>
		<div class="designer-drag-layer">
			<template v-if="dragFeedback?.kind === 'grid' && dragFeedback.gridPosition !== undefined">
				<div class="designer-grid-position-label designer-grid-position-label-feedback" :style="gridPositionLabelStyle">行{{ dragFeedback.gridPosition.row }} 列{{ dragFeedback.gridPosition.column }}</div>
			</template>
			<template v-if="dragFeedback?.kind === 'absolute' && dragFeedback.absoluteCoordinates !== undefined">
				<div class="designer-absolute-coordinate-line designer-absolute-coordinate-line-x" :style="absoluteCoordinateLineStyle('x')"></div>
				<div class="designer-absolute-coordinate-line designer-absolute-coordinate-line-y" :style="absoluteCoordinateLineStyle('y')"></div>
				<div class="designer-absolute-coordinate-label designer-absolute-coordinate-label-x" :style="absoluteCoordinateLabelStyle('x')">{{ dragFeedback.absoluteCoordinates.x }}dp</div>
				<div class="designer-absolute-coordinate-label designer-absolute-coordinate-label-y" :style="absoluteCoordinateLabelStyle('y')">{{ dragFeedback.absoluteCoordinates.y }}dp</div>
			</template>
			<div
				v-for="(guide, index) in dragFeedback?.guides ?? []"
				:key="guide.axis + ':' + guide.position + ':' + guide.kind + ':' + index"
				:class="['designer-relative-snap-guide', 'designer-relative-snap-guide-' + guide.axis, 'designer-relative-snap-guide-' + guide.target, 'designer-relative-snap-guide-' + guide.kind]"
				:style="relativeSnapGuideStyle(guide)"
				:title="guide.title"
			><span
				v-if="guide.connector !== undefined"
				:class="['designer-relative-snap-guide-connector', 'designer-relative-snap-guide-connector-' + guide.connector.axis]"
				:style="relativeSnapGuideConnectorStyle(guide)"
			><span
				:class="['designer-relative-snap-guide-label', 'designer-relative-snap-guide-label-middle', { 'designer-relative-snap-guide-label-horizontal': relativeGuideLabelHorizontal(guide, true) }]"
				:style="relativeSnapGuideLabelStyle(guide, true, index)"
			>{{ guide.connector.label }}</span></span><span
				v-if="dragFeedback?.kind !== 'frame' && relativeSnapGuideLabelMode(index) !== 'hidden'"
				:class="['designer-relative-snap-guide-label', 'designer-relative-snap-guide-label-' + guide.labelPlacement, { 'designer-relative-snap-guide-label-horizontal': relativeGuideLabelHorizontal(guide, false) }]"
				:style="relativeSnapGuideLabelStyle(guide, false, index)"
			>{{ guide.label }}</span></div>
			<div
				v-if="dragFeedback?.kind === 'frame' && dragFeedback.placementLabel !== undefined"
				class="designer-frame-placement-label"
				:style="framePlacementLabelStyle"
			>{{ dragFeedback.placementLabel }}</div>
			<div
				v-if="dragFeedback !== undefined && dragFeedback.showBounds !== false"
				:class="['designer-drop-feedback', 'designer-drop-feedback-' + dragFeedback.kind]"
				:style="dragFeedbackStyle"
			></div>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type CSSProperties } from "vue";
import type {
	DesignerComponentNode,
	DesignerComponentResize,
	SimpleDesignerModel
} from "../designerModel";
import DesignerNode from "./DesignerNode.vue";
import { useDesignerRelativeLayoutProjection } from "./designerRelativeLayout";
import {
	appearanceStyle,
	componentHoverHint,
	containerInsetStyle,
	containerStyle,
	designerGridCells,
	designerGridPositionLabelBounds,
	designerGridUnplacedChildren,
	designerLayoutClass,
	designerRelativeGuideLabelMode as resolveDesignerRelativeGuideLabelMode,
	designerRelativeGuideLabelSide,
	designerRelativeShortGuideLabelCenter,
	layoutDesignerRelativeLabels,
	type DesignerDragFeedback,
	type DesignerRelativeGuide,
	isDesignerGridPlacedChild,
	type DesignerGridCell,
	type DesignerGridCellSelection,
	weightRemainder
} from "./designerView";

const props = defineProps<{
	readonly debug: boolean;
	readonly dragFeedback?: DesignerDragFeedback;
	readonly dragHoveredPath?: string | null;
	readonly projection: SimpleDesignerModel;
	readonly selectedGridCell?: DesignerGridCellSelection;
	readonly showComponentLabels: boolean;
}>();
const emit = defineEmits<{
	hover: [xmlPath: string | undefined];
	openCode: [];
	resize: [xmlPath: string, resize: DesignerComponentResize];
	select: [xmlPath: string];
	selectGridCell: [selection: DesignerGridCellSelection];
}>();
const canvasElement = ref<HTMLElement>();
const windowLayoutSurface = ref<HTMLElement>();
const selectedNameElement = ref<HTMLElement>();
const hoveredNameElement = ref<HTMLElement>();
const hoveredComponentPath = ref<string>();
const hoveredFeedbackStyle = ref<CSSProperties>({ visibility: "hidden" });
const selectedFeedbackStyle = ref<CSSProperties>({ visibility: "hidden" });
const selectedNameStyle = ref<CSSProperties>({ visibility: "hidden" });
const hoveredNameStyle = ref<CSSProperties>({ visibility: "hidden" });
/** 点燃和选中标签共享同一视觉间隔，不改变名称标签层级。 */
const COMPONENT_NAME_GAP = 2;
const VISUAL_COMPONENT_SELECTOR = ".visual-node[data-component-path], .window-node[data-component-path]";
let nameResizeObserver: ResizeObserver | undefined;
let hoveredPointer: Readonly<{ clientX: number; clientY: number }> | undefined;
let gridPositionMeasureContext: CanvasRenderingContext2D | null | undefined;

/** 窗口根和嵌套容器复用同一套仅依赖 XML 投影的相对布局计算。 */
const rootProjection = computed(() => props.projection.root);
const rootRelativePositions = useDesignerRelativeLayoutProjection(windowLayoutSurface, rootProjection);

type ResizeHandle = "bottom" | "left" | "right" | "top";
const RESIZE_PREVIEW_PROPERTIES = [
	"height",
	"max-height",
	"max-width",
	"min-height",
	"min-width",
	"transform",
	"width",
	"--designer-absolute-left",
	"--designer-absolute-top"
] as const;

interface ResizeStyleValue {
	readonly name: typeof RESIZE_PREVIEW_PROPERTIES[number];
	readonly priority: string;
	readonly value: string;
}

interface ResizePreview {
	readonly element: HTMLElement;
	readonly style: readonly ResizeStyleValue[];
}

interface ResizeDrag {
	readonly absolute: boolean;
	readonly component: DesignerComponentNode;
	readonly handle: ResizeHandle;
	readonly element: HTMLElement;
	readonly pointerId: number;
	readonly preview: ResizePreview;
	readonly startClientX: number;
	readonly startClientY: number;
	readonly startOverlayLeft: number;
	readonly startOverlayTop: number;
	readonly startHeight: number;
	readonly startWidth: number;
	currentHeight: number;
	currentWidth: number;
}

interface OverlayBounds {
	readonly height: number;
	readonly left: number;
	readonly top: number;
	readonly width: number;
}

/** 布局参数只能占用窗口内容区；窗口标题栏和画布留白不参与文字位置自适应。 */
function layoutParameterAvailableBounds(): OverlayBounds | undefined {
	const canvas = canvasElement.value;
	const content = canvas?.querySelector<HTMLElement>(".window-content");
	if (canvas === undefined || content === undefined || content === null) return undefined;
	const canvasBounds = canvas.getBoundingClientRect();
	const contentBounds = content.getBoundingClientRect();
	return {
		height: contentBounds.height,
		left: contentBounds.left - canvasBounds.left,
		top: contentBounds.top - canvasBounds.top,
		width: contentBounds.width
	};
}

function layoutParameterTextWidth(text: string): number {
	gridPositionMeasureContext ??= document.createElement("canvas").getContext("2d");
	const context = gridPositionMeasureContext;
	if (context !== null) {
		const family = canvasElement.value === undefined
			? "sans-serif"
			: window.getComputedStyle(canvasElement.value).fontFamily;
		context.font = `400 10px ${family}`;
	}
	return Math.ceil(context?.measureText(text).width ?? text.length * 10);
}

let resizeDrag: ResizeDrag | undefined;
let pendingResizePreview: ResizePreview | undefined;

/** 画布只遍历已经建立的投影，不把依赖 Node.js 的模型实现打进 Webview。 */
function findProjectedComponent(
	node: DesignerComponentNode,
	targetPath: string
): DesignerComponentNode | undefined {
	if (node.path === targetPath) return node;
	for (const child of node.children) {
		const nested = findProjectedComponent(child, targetPath);
		if (nested !== undefined) return nested;
	}
	return undefined;
}

/** 名称标签只属于窗口内部的可视组件，窗口根节点不显示。 */
function projectedComponentName(path: string | undefined): string | undefined {
	const root = props.projection.root;
	if (root === undefined || path === undefined || path === root.path) return undefined;
	return findProjectedComponent(root, path)?.name;
}

const selectedComponentName = computed(() => projectedComponentName(props.projection.selectedPath));
/** 原生拖拽期间没有稳定 pointermove，改用 dragover 给出的接纳组件；其它时间继续使用普通点燃。 */
const displayedHoveredPath = computed(() => props.dragHoveredPath === undefined
	? hoveredComponentPath.value
	: props.dragHoveredPath ?? undefined);
const hoveredComponentName = computed(() => projectedComponentName(displayedHoveredPath.value));
const dragFeedbackStyle = computed<CSSProperties>(() => props.dragFeedback === undefined
	? { visibility: "hidden" }
	: {
		height: Math.max(0, props.dragFeedback.height) + "px",
		left: props.dragFeedback.left + "px",
		top: props.dragFeedback.top + "px",
		visibility: "visible",
		width: Math.max(0, props.dragFeedback.width) + "px"
	});

/** 绝对布局坐标线分别从父级内容原点连接到组件左边和顶边。 */
function absoluteCoordinateLineStyle(axis: "x" | "y"): CSSProperties {
	const feedback = props.dragFeedback;
	const coordinates = feedback?.absoluteCoordinates;
	if (feedback === undefined || coordinates === undefined) return {};
	if (axis === "x") {
		const origin = feedback.left - coordinates.x;
		return {
			left: Math.min(origin, feedback.left) + "px",
			top: feedback.top + feedback.height / 2 + "px",
			width: Math.abs(coordinates.x) + "px"
		};
	}
	const origin = feedback.top - coordinates.y;
	return {
		height: Math.abs(coordinates.y) + "px",
		left: feedback.left + feedback.width / 2 + "px",
		top: Math.min(origin, feedback.top) + "px"
	};
}

/** 横纵坐标数值居中于各自坐标线，并保持水平阅读。 */
function absoluteCoordinateLabelStyle(axis: "x" | "y"): CSSProperties {
	const feedback = props.dragFeedback;
	const coordinates = feedback?.absoluteCoordinates;
	if (feedback === undefined || coordinates === undefined) return {};
	const availableBounds = layoutParameterAvailableBounds();
	const labelHeight = 14;
	if (axis === "x") {
		const origin = feedback.left - coordinates.x;
		const lineTop = feedback.top + feedback.height / 2;
		const labelWidth = layoutParameterTextWidth(`${coordinates.x}dp`);
		const minimumLeft = availableBounds?.left ?? 0;
		const maximumLeft = availableBounds === undefined
			? Number.POSITIVE_INFINITY
			: availableBounds.left + availableBounds.width - labelWidth;
		const aboveTop = lineTop - 2 - labelHeight;
		const belowTop = lineTop + 3;
		return {
			left: Math.min(maximumLeft, Math.max(minimumLeft, (origin + feedback.left - labelWidth) / 2)) + "px",
			top: (availableBounds === undefined || aboveTop >= availableBounds.top ? aboveTop : belowTop) + "px"
		};
	}
	const origin = feedback.top - coordinates.y;
	const lineLeft = feedback.left + feedback.width / 2;
	const labelWidth = layoutParameterTextWidth(`${coordinates.y}dp`);
	const leftPosition = lineLeft - 4 - labelWidth;
	const rightPosition = lineLeft + 4;
	const minimumTop = availableBounds?.top ?? 0;
	const maximumTop = availableBounds === undefined
		? Number.POSITIVE_INFINITY
		: availableBounds.top + availableBounds.height - labelHeight;
	return {
		left: (availableBounds === undefined || leftPosition >= availableBounds.left ? leftPosition : rightPosition) + "px",
		top: Math.min(maximumTop, Math.max(minimumTop, (origin + feedback.top - labelHeight) / 2)) + "px"
	};
}

/** 按实际字体宽度计算合并行列标签，并把它贴在格子外侧且限制在画布范围内。 */
const gridPositionLabelStyle = computed<CSSProperties>(() => {
	const feedback = props.dragFeedback;
	const position = feedback?.gridPosition;
	if (feedback === undefined || position === undefined) return {};
	const text = `行${position.row} 列${position.column}`;
	const width = layoutParameterTextWidth(text);
	const availableBounds = layoutParameterAvailableBounds() ?? {
		height: canvasElement.value?.clientHeight ?? feedback.top + feedback.height,
		left: 0,
		top: 0,
		width: canvasElement.value?.clientWidth ?? feedback.left + feedback.width
	};
	const bounds = designerGridPositionLabelBounds(
		feedback,
		availableBounds,
		{ height: 14, width }
	);
	return {
		height: bounds.height + "px",
		left: bounds.left + "px",
		top: bounds.top + "px",
		width: bounds.width + "px"
	};
});

/** 单帧二维对齐值避开对应边距；居中对齐按画布剩余空间选择上下侧。 */
const framePlacementLabelStyle = computed<CSSProperties>(() => {
	const feedback = props.dragFeedback;
	if (feedback === undefined) return {};
	const availableBounds = layoutParameterAvailableBounds();
	const spaceAbove = availableBounds === undefined
		? feedback.top
		: feedback.top - availableBounds.top;
	const spaceBelow = availableBounds === undefined
		? Number.POSITIVE_INFINITY
		: availableBounds.top + availableBounds.height - feedback.top - feedback.height;
	const labelWidth = layoutParameterTextWidth(feedback.placementLabel ?? "");
	const labelHeight = 14;
	const preferredAbove = feedback.placementLabelSide === "above"
		|| (feedback.placementLabelSide === undefined && spaceAbove > spaceBelow);
	const above = preferredAbove
		? spaceAbove >= labelHeight + 4 || spaceBelow < labelHeight + 4
		: spaceBelow < labelHeight + 4 && spaceAbove >= labelHeight + 4;
	const minimumLeft = availableBounds?.left ?? 0;
	const maximumLeft = availableBounds === undefined
		? Number.POSITIVE_INFINITY
		: availableBounds.left + availableBounds.width - labelWidth;
	return {
		left: Math.min(maximumLeft, Math.max(minimumLeft, feedback.left + (feedback.width - labelWidth) / 2)) + "px",
		top: (above ? feedback.top - 4 - labelHeight : feedback.top + feedback.height + 4) + "px"
	};
});

/** 把画布坐标系中的相对停靠线转换为水平或垂直的绝对定位矩形。 */
function relativeSnapGuideStyle(guide: DesignerRelativeGuide): CSSProperties {
	return guide.axis === "vertical"
		? {
			height: Math.max(0, guide.end - guide.start) + "px",
			left: guide.position + "px",
			top: guide.start + "px"
		}
		: {
			height: "1px",
			left: guide.start + "px",
			top: guide.position + "px",
			width: Math.max(0, guide.end - guide.start) + "px"
		};
}

/** 引出段与主停靠线共用一个反馈节点，并从主线接到拖拽组件的对应边。 */
function relativeSnapGuideConnectorStyle(guide: DesignerRelativeGuide): CSSProperties {
	const connector = guide.connector;
	if (connector === undefined) return { display: "none" };
	const guideLeft = guide.axis === "vertical" ? guide.position : guide.start;
	const guideTop = guide.axis === "vertical" ? guide.start : guide.position;
	return connector.axis === "vertical"
		? {
			height: Math.max(0, connector.end - connector.start) + "px",
			left: connector.position - guideLeft + "px",
			top: connector.start - guideTop + "px"
		}
		: {
			height: "1px",
			left: connector.start - guideLeft + "px",
			top: connector.position - guideTop + "px",
			width: Math.max(0, connector.end - connector.start) + "px"
		};
}

/** 规则名跟随主停靠线，间距文字固定居中于连接组件边的间距段。 */
function relativeSnapGuideLabelMode(index: number): ReturnType<typeof resolveDesignerRelativeGuideLabelMode> {
	return resolveDesignerRelativeGuideLabelMode(props.dragFeedback?.guides ?? [], index);
}

/** 父级边框规则保持原方向；所有边距和兄弟停靠在内容区水平阅读。 */
function relativeGuideLabelHorizontal(guide: DesignerRelativeGuide, useConnector: boolean): boolean {
	return props.dragFeedback?.kind === "frame"
		|| (props.dragFeedback?.kind === "relative" && (useConnector || guide.target !== "parent"));
}

const relativeLabelPlacements = computed(() => {
	const feedback = props.dragFeedback;
	if (feedback?.kind !== "relative") return [];
	const canvas = canvasElement.value;
	const available = layoutParameterAvailableBounds() ?? {
		height: canvas?.clientHeight ?? 0,
		left: 0,
		top: 0,
		width: canvas?.clientWidth ?? 0
	};
	return layoutDesignerRelativeLabels(feedback.guides ?? [], feedback, available, layoutParameterTextWidth);
});

function relativeSnapGuideLabelStyle(
	guide: DesignerRelativeGuide,
	useConnector: boolean,
	index: number
): CSSProperties {
	const feedback = props.dragFeedback;
	const canvas = canvasElement.value;
	if (feedback === undefined) return {};
	if (feedback.kind === "relative" && (useConnector || guide.target !== "parent")) {
		const placement = relativeLabelPlacements.value[index]?.[useConnector ? "connector" : "rule"];
		if (placement !== undefined) {
			const line = useConnector && guide.connector !== undefined ? guide.connector : guide;
			const originLeft = line.axis === "vertical" ? line.position : line.start;
			const originTop = line.axis === "vertical" ? line.start : line.position;
			return {
				bottom: "auto",
				left: placement.left - originLeft + "px",
				right: "auto",
				top: placement.top - originTop + "px",
				transform: "none"
			};
		}
	}
	const line = useConnector && guide.connector !== undefined
		? { ...guide, ...guide.connector }
		: guide;
	const side = designerRelativeGuideLabelSide(
		line,
		feedback,
		layoutParameterAvailableBounds() ?? (canvas === undefined ? undefined : {
			height: canvas.clientHeight,
			left: 0,
			top: 0,
			width: canvas.clientWidth
		}),
		feedback.kind === "frame" ? "horizontal" : "vertical"
	);
	const placement = useConnector ? "middle" : guide.labelPlacement;
	const middle = placement === "middle";
	const labelMode = useConnector ? "default" : relativeSnapGuideLabelMode(index);
	if (labelMode === "center-in-parent" && line.axis === "horizontal") {
		return {
			left: feedback.left + feedback.width / 2 - line.start + "px",
			top: feedback.top - line.position - 4 + "px",
			transform: "translate(-50%, -100%)"
		};
	}
	const shortLabelCenter = useConnector && feedback.kind !== "frame"
		? designerRelativeShortGuideLabelCenter(line, feedback)
		: undefined;
	if (line.axis === "vertical") {
		const style: CSSProperties = {
			left: side === "left" ? "-4px" : "4px",
			transform: side === "left"
				? middle ? "translate(-100%, -50%)" : "translateX(-100%)"
				: middle ? "translateY(-50%)" : "none"
		};
		if (shortLabelCenter !== undefined) style.top = shortLabelCenter - line.start + "px";
		else if (placement === "start") style.top = "0";
		else if (placement === "middle") style.top = "50%";
		else style.bottom = "0";
		return style;
	}
	const style: CSSProperties = {
		top: side === "above" ? "-2px" : "3px",
		transform: side === "above"
			? middle ? "translate(-50%, -100%)" : "translateY(-100%)"
			: middle ? "translateX(-50%)" : "none"
	};
	if (shortLabelCenter !== undefined) style.left = shortLabelCenter - line.start + "px";
	else if (placement === "start") style.left = "0";
	else if (placement === "middle") style.left = "50%";
	else style.right = "0";
	return style;
}
const selectedVisualComponent = computed(() => {
	const root = props.projection.root;
	const path = props.projection.selectedPath;
	if (root === undefined || path === undefined || path === root.path) return undefined;
	const component = findProjectedComponent(root, path);
	return component?.visual === true ? component : undefined;
});
/** 窗口只复用统一选中线；移动、缩放和名称标签仍只属于普通可视组件。 */
const selectedFeedbackPath = computed(() => {
	const root = props.projection.root;
	const path = props.projection.selectedPath;
	if (root === undefined || path === undefined) return undefined;
	return findProjectedComponent(root, path)?.visual === true ? path : undefined;
});
const hoveredFeedbackPath = computed(() => {
	const root = props.projection.root;
	const path = displayedHoveredPath.value;
	if (root === undefined || path === undefined || path === props.projection.selectedPath) return undefined;
	return findProjectedComponent(root, path)?.visual === true ? path : undefined;
});
const selectedResizableComponent = computed(() => {
	const component = selectedVisualComponent.value;
	return component?.resizable === true ? component : undefined;
});

const resizeHandles = computed<readonly ResizeHandle[]>(() => {
	const component = selectedResizableComponent.value;
	if (component === undefined) return [];
	const handles: ResizeHandle[] = [];
	if (component.resizeHeight === true) handles.push("top", "bottom");
	if (component.resizeWidth === true) handles.push("left", "right");
	return handles;
});

/** 缩放手柄保留无障碍操作名称，悬停文本统一使用组件提示。 */
function resizeHandleAriaLabel(handle: ResizeHandle): string {
	return handle === "left" || handle === "right"
		? "按住左右拖动调整宽度"
		: "按住上下拖动调整高度";
}

/** 选中名称标签携带组件路径；其它画布反馈按指针坐标穿透到最上层真实组件。 */
function componentPathAtPoint(clientX: number, clientY: number): string | undefined {
	const canvas = canvasElement.value;
	if (canvas === undefined) return undefined;
	const bounds = canvas.getBoundingClientRect();
	if (clientX < bounds.left || clientX > bounds.right || clientY < bounds.top || clientY > bounds.bottom) {
		return undefined;
	}
	const elements = document.elementsFromPoint(clientX, clientY);
	const moveSurface = elements
		.map((element) => element.closest<HTMLElement>("[data-selected-move-path]"))
		.find((element): element is HTMLElement => element !== null && canvas.contains(element));
	const movePath = moveSurface?.dataset.selectedMovePath;
	const movedComponent = componentElement(movePath);
	for (const element of elements) {
		const component = element.closest<HTMLElement>("[data-component-path]");
		if (component === null || !canvas.contains(component)) continue;
		/* 指针位于选中名称标签时跳过其祖先容器，稳定回到标签对应的真实组件。 */
		if (
			movedComponent !== undefined
			&& component !== movedComponent
			&& component.contains(movedComponent)
		) continue;
		return component.dataset.componentPath;
	}
	return movePath;
}

/** 组件内容沿用真实事件路径；画布交互层和名称标签没有组件路径时再按坐标穿透。 */
function componentPathFromPointer(event: PointerEvent): string | undefined {
	const canvas = canvasElement.value;
	if (canvas !== undefined) {
		for (const target of event.composedPath()) {
			if (!(target instanceof HTMLElement) || !canvas.contains(target)) continue;
			if (target.dataset.componentPath !== undefined) return target.dataset.componentPath;
		}
	}
	return componentPathAtPoint(event.clientX, event.clientY);
}

/** 指针按下立即切换组件；不等待可能被原生拖动取消的 click。 */
function selectComponentAtPointer(event: PointerEvent): void {
	if (event.button !== 0 || !(event.target instanceof Element)) return;
	const resizeHandle = event.target.closest<HTMLElement>("[data-resize-handle]");
	if (resizeHandle !== null && canvasElement.value?.contains(resizeHandle)) {
		const handle = resizeHandle.dataset.resizeHandle;
		if (handle === "bottom" || handle === "left" || handle === "right" || handle === "top") {
			event.preventDefault();
			event.stopPropagation();
			startResize(event, handle, resizeHandle);
		}
		return;
	}
	const gridCell = event.target.closest<HTMLElement>("[data-grid-cell-parent]");
	if (gridCell !== null && gridCell.dataset.gridCellOccupied === undefined) return;
	const path = componentPathFromPointer(event);
	hoveredPointer = { clientX: event.clientX, clientY: event.clientY };
	hoveredComponentPath.value = path;
	if (path !== undefined && path !== props.projection.selectedPath) {
		selectedFeedbackStyle.value = { visibility: "hidden" };
		emit("select", path);
	}
}

function trackHoveredComponent(event: PointerEvent): void {
	hoveredPointer = { clientX: event.clientX, clientY: event.clientY };
	hoveredComponentPath.value = componentPathFromPointer(event);
}

function handleCanvasPointerMove(event: PointerEvent): void {
	if (resizeDrag !== undefined) {
		moveResize(event);
		return;
	}
	trackHoveredComponent(event);
}

function clearHoveredComponent(): void {
	hoveredPointer = undefined;
	hoveredComponentPath.value = undefined;
}

/** 点燃路径只在当前设计器视图内同步给布局树，不进入宿主或 XML 状态。 */
watch(hoveredComponentPath, (path) => emit("hover", path));

/** 模型替换会重建组件 DOM；下一帧按仍停留在画布上的指针恢复点燃组件。 */
async function refreshHoveredComponentAfterModelChange(): Promise<void> {
	await nextTick();
	const pointer = hoveredPointer;
	hoveredComponentPath.value = pointer === undefined
		? undefined
		: componentPathAtPoint(pointer.clientX, pointer.clientY);
}

/** 双击窗口自身时打开代码；子组件的双击冒泡到窗口后必须保持无动作。 */
function openRootCode(event: MouseEvent): void {
	const component = event.target instanceof Element
		? event.target.closest<HTMLElement>("[data-component-path]")
		: null;
	if (component?.dataset.componentPath === props.projection.root?.path) emit("openCode");
}

/** 找到与 XML 路径对应的画布组件元素。 */
function componentElement(path: string | undefined): HTMLElement | undefined {
	const canvas = canvasElement.value;
	if (canvas === undefined || path === undefined) return undefined;
	return [...canvas.querySelectorAll<HTMLElement>(VISUAL_COMPONENT_SELECTOR)]
		.find((element) => element.dataset.componentPath === path);
}

/** 把真实组件视口边界换算为画布坐标，供独立的交互层和名称标签层定位。 */
function componentOverlayBounds(path: string | undefined): OverlayBounds | undefined {
	const canvas = canvasElement.value;
	const component = componentElement(path);
	if (canvas === undefined || component === undefined) return undefined;
	const canvasBounds = canvas.getBoundingClientRect();
	const componentBounds = component.getBoundingClientRect();
	return {
		height: componentBounds.height,
		left: componentBounds.left - canvasBounds.left,
		top: componentBounds.top - canvasBounds.top,
		width: componentBounds.width
	};
}

/** 名称标签按组件 parentPath 查找真实直属父布局面，不能依赖会随拖放资格消失的落点标记。 */
function componentParentOverlayBounds(path: string | undefined): OverlayBounds | undefined {
	const canvas = canvasElement.value;
	const component = componentElement(path);
	const parentPath = component?.dataset.componentParentPath;
	const parentSurface = parentPath === undefined || canvas === undefined
		? undefined
		: [...canvas.querySelectorAll<HTMLElement>("[data-layout-surface-path]")]
			.find((surface) => surface.dataset.layoutSurfacePath === parentPath);
	if (canvas === undefined || parentSurface === undefined || parentSurface === null) return undefined;
	const canvasBounds = canvas.getBoundingClientRect();
	const parentBounds = parentSurface.getBoundingClientRect();
	return {
		height: parentBounds.height,
		left: parentBounds.left - canvasBounds.left,
		top: parentBounds.top - canvasBounds.top,
		width: parentBounds.width
	};
}

/** 名称依次尝试顶、底、左、右边框并保持居中；四边均放不下时回到默认顶边。 */
function externalNameStyleFromBounds(
	bounds: OverlayBounds | undefined,
	parentBounds: OverlayBounds | undefined,
	label: HTMLElement | undefined,
	gap: number
): CSSProperties {
	const canvas = canvasElement.value;
	if (canvas === undefined || bounds === undefined || label === undefined) {
		return { visibility: "hidden" };
	}
	const left = bounds.left;
	const top = bounds.top;
	const right = left + bounds.width;
	const bottom = top + bounds.height;
	const labelWidth = label.offsetWidth;
	const labelHeight = label.offsetHeight;
	const availableBounds = parentBounds ?? {
		height: canvas.clientHeight,
		left: 0,
		top: 0,
		width: canvas.clientWidth
	};
	const minimumLeft = availableBounds.left + 2;
	const maximumLeft = availableBounds.left + availableBounds.width - labelWidth - 2;
	const minimumTop = availableBounds.top + 2;
	const maximumTop = availableBounds.top + availableBounds.height - labelHeight - 2;
	const centeredLeft = left + (bounds.width - labelWidth) / 2;
	const centeredTop = top + (bounds.height - labelHeight) / 2;
	const topPosition = top - labelHeight - gap;
	const bottomPosition = bottom + gap;
	const rightPosition = right + gap;
	const leftPosition = left - labelWidth - gap;
	const topCandidate = { left: centeredLeft, top: topPosition };
	const rightCandidate = { left: rightPosition, top: centeredTop };
	const bottomCandidate = { left: centeredLeft, top: bottomPosition };
	const leftCandidate = { left: leftPosition, top: centeredTop };
	const candidates = [topCandidate, bottomCandidate, leftCandidate, rightCandidate];
	const position = candidates.find((candidate) => (
		candidate.left >= minimumLeft
		&& candidate.left <= maximumLeft
		&& candidate.top >= minimumTop
		&& candidate.top <= maximumTop
	)) ?? topCandidate;
	return {
		left: Math.round(position.left) + "px",
		top: Math.round(position.top) + "px",
		visibility: "visible"
	};
}

function externalNameStyle(
	path: string | undefined,
	label: HTMLElement | undefined,
	gap: number
): CSSProperties {
	return externalNameStyleFromBounds(
		componentOverlayBounds(path),
		componentParentOverlayBounds(path),
		label,
		gap
	);
}

function feedbackStyle(path: string | undefined): CSSProperties {
	if (props.dragHoveredPath !== undefined) return { visibility: "hidden" };
	const bounds = componentOverlayBounds(path);
	return bounds === undefined
		? { visibility: "hidden" }
		: {
			height: Math.max(0, bounds.height) + "px",
			left: bounds.left + "px",
			top: bounds.top + "px",
			visibility: "visible",
			width: Math.max(0, bounds.width) + "px"
		};
}

function positionNameOverlays(): void {
	selectedFeedbackStyle.value = feedbackStyle(selectedFeedbackPath.value);
	hoveredFeedbackStyle.value = feedbackStyle(hoveredFeedbackPath.value);
	selectedNameStyle.value = externalNameStyle(
		props.projection.selectedPath,
		selectedNameElement.value,
		COMPONENT_NAME_GAP
	);
	hoveredNameStyle.value = externalNameStyle(
		displayedHoveredPath.value,
		hoveredNameElement.value,
		COMPONENT_NAME_GAP
	);
}

/** 保存 Vue 已投影到元素上的行内样式，拖动完成或取消后精确恢复。 */
function captureResizePreview(element: HTMLElement): ResizePreview {
	return {
		element,
		style: RESIZE_PREVIEW_PROPERTIES.map((name) => ({
			name,
			priority: element.style.getPropertyPriority(name),
			value: element.style.getPropertyValue(name)
		}))
	};
}

function restoreResizePreview(preview: ResizePreview | undefined): void {
	if (preview === undefined) return;
	for (const property of preview.style) {
		if (property.value.length === 0) preview.element.style.removeProperty(property.name);
		else preview.element.style.setProperty(property.name, property.value, property.priority);
	}
}

function clearResizePreview(): void {
	restoreResizePreview(pendingResizePreview);
	pendingResizePreview = undefined;
}

/** 固定浏览器端预览尺寸；左上方向在绝对布局中同步坐标，其它布局临时平移跟随指针。 */
function applyResizePreview(drag: ResizeDrag, width: number, height: number): void {
	const horizontal = drag.handle === "left" || drag.handle === "right";
	const west = drag.handle === "left";
	const north = drag.handle === "top";
	const offsetLeft = west ? drag.startWidth - width : 0;
	const offsetTop = north ? drag.startHeight - height : 0;
	const previewDimensions = horizontal
		? [["width", width], ["min-width", width], ["max-width", width]] as const
		: [["height", height], ["min-height", height], ["max-height", height]] as const;
	for (const [name, value] of previewDimensions) {
		drag.element.style.setProperty(name, value + "px", "important");
	}
	if (drag.absolute) {
		const position = drag.component.absolutePosition;
		if (position !== undefined) {
			drag.element.style.setProperty("--designer-absolute-left", position.left + offsetLeft + "px", "important");
			drag.element.style.setProperty("--designer-absolute-top", position.top + offsetTop + "px", "important");
		}
		drag.element.style.removeProperty("transform");
	} else {
		drag.element.style.setProperty("transform", `translate(${offsetLeft}px, ${offsetTop}px)`, "important");
	}
	drag.currentWidth = width;
	drag.currentHeight = height;
	/* 预览组件和独立交互层使用同一实时矩形，名称标签只复用该矩形定位。 */
	selectedFeedbackStyle.value = {
		height: Math.max(0, height) + "px",
		left: drag.startOverlayLeft + offsetLeft + "px",
		top: drag.startOverlayTop + offsetTop + "px",
		visibility: "visible",
		width: Math.max(0, width) + "px"
	};
	selectedNameStyle.value = externalNameStyleFromBounds({
		height,
		left: drag.startOverlayLeft + offsetLeft,
		top: drag.startOverlayTop + offsetTop,
		width
	}, componentParentOverlayBounds(drag.component.path), selectedNameElement.value, COMPONENT_NAME_GAP);
	hoveredNameStyle.value = externalNameStyle(
		displayedHoveredPath.value,
		hoveredNameElement.value,
		COMPONENT_NAME_GAP
	);
}

/** 从选中组件当前投影尺寸开始一次单轴拖动，不预先改写适应内容或匹配父级。 */
function startResize(event: PointerEvent, handle: ResizeHandle, captureTarget: HTMLElement): void {
	if (event.button !== 0 || !event.isPrimary || resizeDrag !== undefined) return;
	clearResizePreview();
	const component = selectedResizableComponent.value;
	const element = componentElement(component?.path);
	const canvas = canvasElement.value;
	if (
		component === undefined
		|| element === undefined
		|| canvas === undefined
	) return;
	const bounds = element.getBoundingClientRect();
	const canvasBounds = canvas.getBoundingClientRect();
	const preview = captureResizePreview(element);
	resizeDrag = {
		absolute: component.absolutePosition !== undefined,
		component,
		currentHeight: Math.max(0, Math.round(bounds.height)),
		currentWidth: Math.max(0, Math.round(bounds.width)),
		element,
		handle,
		pointerId: event.pointerId,
		preview,
		startClientX: event.clientX,
		startClientY: event.clientY,
		startOverlayLeft: bounds.left - canvasBounds.left,
		startOverlayTop: bounds.top - canvasBounds.top,
		startHeight: Math.max(0, Math.round(bounds.height)),
		startWidth: Math.max(0, Math.round(bounds.width))
	};
	pendingResizePreview = preview;
	captureTarget.setPointerCapture(event.pointerId);
}

/** 指针捕获期间实时更新组件和画布交互层，期间不产生 XML 中间版本。 */
function moveResize(event: PointerEvent): void {
	const drag = resizeDrag;
	if (drag === undefined || drag.pointerId !== event.pointerId) return;
	const deltaX = Math.round(event.clientX - drag.startClientX);
	const deltaY = Math.round(event.clientY - drag.startClientY);
	const width = drag.handle === "left"
		? Math.max(0, drag.startWidth - deltaX)
		: drag.handle === "right" ? Math.max(0, drag.startWidth + deltaX) : drag.startWidth;
	const height = drag.handle === "top"
		? Math.max(0, drag.startHeight - deltaY)
		: drag.handle === "bottom" ? Math.max(0, drag.startHeight + deltaY) : drag.startHeight;
	applyResizePreview(drag, width, height);
}

/** 松开鼠标时只提交实际变化的方向，保持另一方向原有长度表达式。 */
function finishResize(event: PointerEvent): void {
	const drag = resizeDrag;
	if (drag === undefined || drag.pointerId !== event.pointerId) return;
	resizeDrag = undefined;
	const widthChanged = drag.currentWidth !== drag.startWidth;
	const heightChanged = drag.currentHeight !== drag.startHeight;
	if (!widthChanged && !heightChanged) {
		clearResizePreview();
		positionNameOverlays();
		return;
	}
	const west = drag.handle === "left";
	const north = drag.handle === "top";
	emit("resize", drag.component.path, {
		height: heightChanged ? drag.currentHeight : undefined,
		left: drag.absolute && west && widthChanged
			? (drag.component.absolutePosition?.left ?? 0) + drag.startWidth - drag.currentWidth
			: undefined,
		top: drag.absolute && north && heightChanged
			? (drag.component.absolutePosition?.top ?? 0) + drag.startHeight - drag.currentHeight
			: undefined,
		width: widthChanged ? drag.currentWidth : undefined
	});
}

function cancelResize(event: PointerEvent): void {
	if (resizeDrag?.pointerId !== event.pointerId) return;
	resizeDrag = undefined;
	clearResizePreview();
	positionNameOverlays();
}

function resizePointerCaptureLost(event: PointerEvent): void {
	if (resizeDrag?.pointerId !== event.pointerId) return;
	cancelResize(event);
}

/** 选择、点燃或投影变化后重连尺寸观察，统一刷新交互线条和名称标签。 */
async function refreshNameOverlays(): Promise<void> {
	await nextTick();
	nameResizeObserver?.disconnect();
	const canvas = canvasElement.value;
	const selected = componentElement(props.projection.selectedPath);
	const hovered = componentElement(displayedHoveredPath.value);
	if (canvas !== undefined) nameResizeObserver?.observe(canvas);
	if (selected !== undefined) nameResizeObserver?.observe(selected);
	if (hovered !== undefined && hovered !== selected) nameResizeObserver?.observe(hovered);
	positionNameOverlays();
}

/* XML 定义删除后路径可能重新编号；先丢弃旧路径，再按当前指针和新 DOM 重新命中。 */
watch(() => props.projection, () => {
	resizeDrag = undefined;
	clearResizePreview();
	selectedFeedbackStyle.value = { visibility: "hidden" };
	hoveredComponentPath.value = undefined;
	void refreshHoveredComponentAfterModelChange();
});
/* 原生拖拽结束后丢弃开始拖动前遗留的普通点燃，等待下一次真实 pointermove。 */
watch(() => props.dragHoveredPath, (path, previousPath) => {
	if (path === undefined && previousPath !== undefined) clearHoveredComponent();
});
watch(
	() => [
		props.projection,
		props.projection.selectedPath,
		displayedHoveredPath.value,
		props.showComponentLabels
	],
	() => void refreshNameOverlays()
);
onMounted(() => {
	nameResizeObserver = new ResizeObserver(positionNameOverlays);
	window.addEventListener("resize", positionNameOverlays);
	void refreshNameOverlays();
});
onBeforeUnmount(() => {
	resizeDrag = undefined;
	clearResizePreview();
	nameResizeObserver?.disconnect();
	window.removeEventListener("resize", positionNameOverlays);
});

/** 空格子只有设计期选择状态；已占用格子的点击仍由真实组件处理。 */
function selectGridCell(parentXmlPath: string, cell: DesignerGridCell): void {
	if (props.projection.root?.childrenLayoutReadOnly === true) return;
	if (cell.occupiedComponentPath !== undefined) {
		emit("select", parentXmlPath);
		return;
	}
	emit("selectGridCell", { column: cell.column, parentXmlPath, row: cell.row });
}

/** 窗口内容外层只承担设计期间隙、用户填充与窗口外观。 */
const windowContentStyle = computed(() => props.projection.root === undefined
	? {}
	: { ...containerInsetStyle(props.projection.root), ...appearanceStyle(props.projection.root) });

/** 窗口子组件只在扣除外层间隙后的真实布局区中排列和裁切。 */
const windowLayoutStyle = computed(() => props.projection.root === undefined
	? {}
	: containerStyle(props.projection.root));

/** 窗口本身使用表格布局时，在内容区绘制全部可拖放单元格。 */
const rootGridCells = computed(() => props.projection.root === undefined ? [] : designerGridCells(props.projection.root));

/** 根表格中没有有效行列的组件独立显示，不参与单元格网格的自动排版。 */
const rootUnplacedChildren = computed(() => props.projection.root === undefined
	? []
	: designerGridUnplacedChildren(props.projection.root));

/** 保持窗口根线性布局的权重分配与嵌套容器一致。 */
const rootRemainder = computed(() => props.projection.root === undefined ? 0 : weightRemainder(props.projection.root));
</script>
