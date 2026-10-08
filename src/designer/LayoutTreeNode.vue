<!--
递归呈现布局树中的真实 XML 组件节点及其菜单、选择和同级移动元数据。
xhwsd@qq.com 2026-8-30
-->

<template>
	<div class="layout-tree-branch">
		<button
			type="button"
			:class="['layout-tree-item', {
				hovered: node.path === hoveredPath,
				selected: node.path === selectedPath
			}]"
			:data-node-path="node.path"
			:data-component-path="node.path"
			:data-component-type="node.type"
			:data-menu-label="node.name"
			:data-component-actions="deletable ? 'true' : 'false'"
			:data-layout-move="node.layoutReadOnly === true || node.positionReadOnly === true || move === undefined ? undefined : 'true'"
			:data-layout-read-only="node.layoutReadOnly === true ? 'true' : undefined"
			:data-move-previous="move?.previous ? 'true' : 'false'"
			:data-move-next="move?.next ? 'true' : 'false'"
			:data-insert-accept="node.layoutReadOnly !== true && node.positionReadOnly !== true && deletable && node.parentPath !== undefined ? (node.visual ? 'visual' : 'nonvisual') : undefined"
			:data-insert-parent="node.layoutReadOnly !== true && node.positionReadOnly !== true && deletable ? node.parentPath : undefined"
			:data-insert-reference="node.layoutReadOnly !== true && node.positionReadOnly !== true && deletable && node.parentPath !== undefined ? node.path : undefined"
			:title="componentHoverHint(node)"
			@click="$emit('select', node.path)"
		>
			<ComponentIcon modifier="component-icon-tree" :source="node.icon" :type="node.typeName ?? node.type" />
			<span class="tree-name">{{ node.name }}</span>
			<span class="tree-type">{{ node.typeName ?? node.type }}</span>
		</button>
		<div v-if="node.children.length > 0" class="layout-tree-children">
			<LayoutTreeNode
				v-for="(child, index) in node.children"
				:key="child.path"
				:hovered-path="hoveredPath"
				:node="child"
				:selected-path="selectedPath"
				:deletable="true"
				:move="{
					previous: node.children.slice(0, index).some((candidate) => candidate.visual === child.visual),
					next: node.children.slice(index + 1).some((candidate) => candidate.visual === child.visual)
				}"
				@select="$emit('select', $event)"
			/>
		</div>
	</div>
</template>

<script setup lang="ts">
import type { DesignerComponentNode } from "../designerModel";
import ComponentIcon from "./ComponentIcon.vue";
import { componentHoverHint, type LayoutMoveAvailability } from "./designerView";

defineProps<{
	readonly deletable: boolean;
	readonly hoveredPath?: string;
	readonly move?: LayoutMoveAvailability;
	readonly node: DesignerComponentNode;
	readonly selectedPath?: string;
}>();

defineEmits<{ select: [xmlPath: string] }>();
</script>
