<!--
承载设计器布局树，并在选中或点燃变化后仅定位树容器以保持当前节点可见。
xhwsd@qq.com 2026-8-30
-->

<template>
	<div ref="tree" class="section-content layout-tree">
		<div v-if="root === undefined" class="layout-empty">没有可显示的组件树。</div>
		<LayoutTreeNode
			v-else
			:hovered-path="hoveredPath"
			:node="root"
			:selected-path="selectedPath"
			:deletable="false"
			@select="$emit('select', $event)"
		/>
	</div>
</template>

<script setup lang="ts">
import { nextTick, useTemplateRef, watch } from "vue";
import type { DesignerComponentNode } from "../designerModel";
import LayoutTreeNode from "./LayoutTreeNode.vue";

const props = defineProps<{
	readonly hoveredPath?: string;
	readonly root?: DesignerComponentNode;
	readonly selectedPath?: string;
}>();

defineEmits<{ select: [xmlPath: string] }>();

const tree = useTemplateRef<HTMLElement>("tree");

/** 直接调整布局树自身滚动量，禁止定位过程带动整个设计器标签页滚动。 */
function revealTreeItem(selector: string): void {
	const element = tree.value;
	const item = element?.querySelector<HTMLElement>(selector);
	if (element === null || item === undefined || item === null) return;
	const treeBounds = element.getBoundingClientRect();
	const itemBounds = item.getBoundingClientRect();
	if (itemBounds.top < treeBounds.top) element.scrollTop -= treeBounds.top - itemBounds.top;
	else if (itemBounds.bottom > treeBounds.bottom) element.scrollTop += itemBounds.bottom - treeBounds.bottom;
	if (itemBounds.left < treeBounds.left) element.scrollLeft -= treeBounds.left - itemBounds.left;
	else if (itemBounds.right > treeBounds.right) element.scrollLeft += itemBounds.right - treeBounds.right;
}

/** 选中变化后直接定位对应行，沿用原有选择可见性。 */
watch(() => props.selectedPath, async () => {
	await nextTick();
	revealTreeItem(".layout-tree-item.selected");
}, { immediate: true });

/** 画布点燃变化后直接定位并显示对应行，不改变正式选择。 */
watch(() => props.hoveredPath, async (path) => {
	if (path === undefined) return;
	await nextTick();
	revealTreeItem(".layout-tree-item.hovered");
});
</script>
