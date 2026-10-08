<!--
递归呈现一个可视组件或容器节点，并暴露选择、排序和拖放所需的 XML 锚点。
xhwsd@qq.com 2026-8-30
-->

<template>
	<div
		:class="presentation.classes"
		:style="presentation.style"
		:data-node-path="node.path"
		:data-component-path="node.path"
		:data-component-parent-path="node.parentPath"
		:data-component-type="node.type"
		:data-menu-label="node.name"
		data-component-actions="true"
		:data-layout-move="node.layoutReadOnly === true || node.positionReadOnly === true ? 'false' : 'true'"
		:data-layout-read-only="node.layoutReadOnly === true ? 'true' : undefined"
		:data-move-previous="move.previous ? 'true' : 'false'"
		:data-move-next="move.next ? 'true' : 'false'"
		:data-insert-accept="node.layoutReadOnly === true || node.positionReadOnly === true || node.parentPath === undefined || node.gridPositionValid === false ? undefined : 'visual'"
		:data-insert-parent="node.layoutReadOnly === true || node.positionReadOnly === true || node.gridPositionValid === false ? undefined : node.parentPath"
		:data-insert-reference="node.layoutReadOnly === true || node.positionReadOnly === true || node.parentPath === undefined || node.gridPositionValid === false ? undefined : node.path"
		:data-drag-component-path="node.path"
		:data-drag-component-type="node.type"
		data-drag-component-visual="true"
		:data-grid-parent="node.gridPositionValid === undefined ? undefined : node.parentPath"
		:data-grid-row="node.gridRow"
		:data-grid-column="node.gridColumn"
		:data-hover-hint="hoverHint"
		:title="hoverHint"
		:draggable="node.layoutReadOnly !== true && (node.positionReadOnly !== true || node.positionDraggable === true) && node.path === selectedPath"
		@click.stop
	>
		<template v-if="node.container">
			<div
				class="container-content"
				:style="containerInsetStyle(node)"
				:title="hoverHint"
			>
				<div
					ref="layoutSurface"
					:class="['container-layout-surface', designerLayoutClass(node)]"
					:style="containerStyle(node)"
					:data-layout-surface-path="node.path"
					:data-drop-target="node.acceptsVisualChild === false ? undefined : node.path"
					:data-accept="node.acceptsVisualChild === false ? undefined : 'visual'"
					:data-accepts-visual-child="node.acceptsVisualChild === false ? 'false' : 'true'"
					:title="hoverHint"
				>
					<div v-if="node.layout === 'unsupported'" class="designer-unsupported-layout-notice">
						当前布局尚未适配，仅按组件顺序展示
					</div>
					<div
						v-for="cell in gridCells"
						:key="'grid:' + cell.key"
						:class="['designer-grid-cell', {
							'designer-grid-cell-occupied': cell.occupiedComponentPath !== undefined,
							'designer-grid-cell-selected': cell.occupiedComponentPath === undefined
								&& selectedGridCell?.parentXmlPath === node.path
								&& selectedGridCell.row === cell.row
								&& selectedGridCell.column === cell.column
						}]"
						:style="{ gridColumn: String(cell.column + 1), gridRow: String(cell.row + 1) }"
						:data-grid-cell-parent="node.path"
						:data-grid-cell-row="cell.row"
						:data-grid-cell-column="cell.column"
						:data-grid-cell-occupied="cell.occupiedComponentPath"
						:title="`第 ${cell.row + 1} 行，第 ${cell.column + 1} 列`"
						@click.stop="selectGridCell(cell)"
					>
						<DesignerNode
							v-if="cell.occupiedComponent !== undefined"
							:node="cell.occupiedComponent.node"
							:selected-grid-cell="selectedGridCell"
							:selected-path="selectedPath"
							:move="{
								previous: node.children.slice(0, cell.occupiedComponent.index)
									.some((candidate) => candidate.visual === cell.occupiedComponent?.node.visual),
								next: node.children.slice(cell.occupiedComponent.index + 1)
									.some((candidate) => candidate.visual === cell.occupiedComponent?.node.visual)
							}"
							@select="$emit('select', $event)"
							@select-grid-cell="$emit('selectGridCell', $event)"
						/>
					</div>
					<template v-for="(child, index) in node.children" :key="child.path">
						<DesignerNode
							v-if="node.layout !== 'grid' && isDesignerGridPlacedChild(node, child)"
							:node="child"
							:relative-position="relativePositions.get(child.path)"
							:selected-grid-cell="selectedGridCell"
							:selected-path="selectedPath"
							:move="{
								previous: node.children.slice(0, index).some((candidate) => candidate.visual === child.visual),
								next: node.children.slice(index + 1).some((candidate) => candidate.visual === child.visual)
							}"
							@select="$emit('select', $event)"
							@select-grid-cell="$emit('selectGridCell', $event)"
						/>
					</template>
					<div
						v-if="unplacedChildren.length > 0"
						class="designer-grid-unplaced"
						:style="{ gridRow: String((node.layoutRows ?? 0) + 1) }"
					>
						<span class="designer-grid-unplaced-label">未放置</span>
						<DesignerNode
							v-for="entry in unplacedChildren"
							:key="'unplaced:' + entry.node.path"
							:node="entry.node"
							:selected-grid-cell="selectedGridCell"
							:selected-path="selectedPath"
							:move="{
								previous: node.children.slice(0, entry.index)
									.some((candidate) => candidate.visual === entry.node.visual),
								next: node.children.slice(entry.index + 1)
									.some((candidate) => candidate.visual === entry.node.visual)
							}"
							@select="$emit('select', $event)"
							@select-grid-cell="$emit('selectGridCell', $event)"
						/>
					</div>
					<div
						v-if="remainder > 0"
						class="designer-weight-remainder"
						:style="{ '--designer-component-weight': String(remainder) }"
					></div>
				</div>
			</div>
		</template>
		<template v-else>
			<span class="visual-control-content" :data-full-text="node.displayText">{{ node.displayText }}</span>
		</template>
	</div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { DesignerComponentNode } from "../designerModel";
import {
	useDesignerRelativeLayoutProjection,
	type DesignerProjectedRelativePosition
} from "./designerRelativeLayout";
import {
	componentHoverHint,
	componentPresentation,
	containerInsetStyle,
	containerStyle,
	designerGridCells,
	designerGridUnplacedChildren,
	designerLayoutClass,
	isDesignerGridPlacedChild,
	type DesignerGridCell,
	type DesignerGridCellSelection,
	type LayoutMoveAvailability,
	weightRemainder
} from "./designerView";

const props = defineProps<{
	readonly move: LayoutMoveAvailability;
	readonly node: DesignerComponentNode;
	readonly relativePosition?: DesignerProjectedRelativePosition;
	readonly selectedGridCell?: DesignerGridCellSelection;
	readonly selectedPath?: string;
}>();

const emit = defineEmits<{
	select: [xmlPath: string];
	selectGridCell: [selection: DesignerGridCellSelection];
}>();
const layoutSurface = ref<HTMLElement>();
const projectedNode = computed(() => props.node);
const relativePositions = useDesignerRelativeLayoutProjection(layoutSurface, projectedNode);

/** 空格子作为临时粘贴落点选中，不把虚拟格写入 XML。 */
function selectGridCell(cell: DesignerGridCell): void {
	if (props.node.childrenLayoutReadOnly === true) return;
	if (cell.occupiedComponentPath !== undefined) {
		emit("select", props.node.path);
		return;
	}
	emit("selectGridCell", { column: cell.column, parentXmlPath: props.node.path, row: cell.row });
}

/** 悬停文本始终来自当前组件名称和真实 SDK 类型。 */
const hoverHint = computed(() => componentHoverHint(props.node));

/** 合并组件长度、父布局、外观和选择态，供模板一次性绑定。 */
const presentation = computed(() => componentPresentation(
	props.node,
	props.selectedPath,
	props.node.container ? "container" : "control",
	props.relativePosition
));

/** 表格容器显示完整空单元格；其它布局不建立辅助节点。 */
const gridCells = computed(() => designerGridCells(props.node));

/** 无法映射到有效单元格的组件集中显示在网格之后，不能挤开或遮挡放置目标。 */
const unplacedChildren = computed(() => designerGridUnplacedChildren(props.node));

/** 在线性布局中补出未被组件权重占用的剩余空间。 */
const remainder = computed(() => weightRemainder(props.node));
</script>
