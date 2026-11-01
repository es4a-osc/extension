<!--
按合并后的 SDK 分组呈现可拖入组件，并在 Vue 状态中保留各分组的折叠状态。
xhwsd@qq.com 2026-8-30
-->

<template>
	<div class="section-content toolbox-list" :class="{ 'toolbox-list-sorting': sorting }">
		<div v-if="groups.length === 0" class="toolbox-empty">SDK 没有提供可选组件。</div>
		<details
			v-for="group in groups"
			:key="group.name"
			class="toolbox-group"
			:class="{
				'toolbox-group-source': draggedGroup === group.name,
				'toolbox-group-drop-before': dropTarget?.name === group.name && dropTarget.position === 'before',
				'toolbox-group-drop-after': dropTarget?.name === group.name && dropTarget.position === 'after'
			}"
			:open="!sorting && !collapsedGroups.has(group.name)"
			@toggle="toggleGroup(group.name, $event)"
			@dragover="onGroupDragOver(group, $event)"
			@drop="onGroupDrop(group, $event)"
			@dragleave="onGroupDragLeave($event)"
		>
			<summary
				class="toolbox-group-summary"
				:draggable="sorting"
				:title="sorting ? '拖动调整分组顺序' : undefined"
				@click="onGroupClick"
				@dragstart.stop="onGroupDragStart(group, $event)"
				@dragend.stop="finishGroupDrag"
			>
				<span class="group-disclosure" aria-hidden="true">
					<span class="codicon codicon-fold group-disclosure-closed"></span>
					<span class="codicon codicon-unfold group-disclosure-open"></span>
				</span>
				<span class="toolbox-group-name">{{ group.name }}</span>
				<span class="toolbox-group-count">{{ group.items.length }}</span>
			</summary>
			<div class="toolbox-group-items">
				<div
					v-for="item in group.items"
					:key="item.name"
					class="toolbox-item"
					draggable="true"
					:data-component-type="item.name"
					:data-visual="item.visual ? 'true' : 'false'"
					:title="componentTypeHoverHint(item.name, item.runtimeType, item.description)"
				>
					<ComponentIcon modifier="component-icon-toolbox" :source="item.icon" />
					<span class="toolbox-name">{{ item.name }}</span>
				</div>
			</div>
		</details>
	</div>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from "vue";
import type { DesignerToolboxGroup } from "../designerModel";
import ComponentIcon from "./ComponentIcon.vue";
import { componentTypeHoverHint } from "./designerView";

const props = defineProps<{ readonly groups: readonly DesignerToolboxGroup[]; readonly sorting: boolean }>();
const emit = defineEmits<{
	moveCategory: [category: string, reference: string, position: "before" | "after"];
}>();

const collapsedGroups = reactive(new Set<string>());
const draggedGroup = ref<string>();
const dropTarget = ref<{ name: string; position: "before" | "after" }>();

// 进入时统一收起；退出只清理排序反馈，不再加工列表状态。
watch(() => props.sorting, (sorting) => {
	finishGroupDrag();
	if (sorting) collapseAllToolboxGroups();
});

/** 普通模式保留原生伸缩，排序模式只允许整行标题拖动。 */
function onGroupClick(event: MouseEvent): void {
	if (props.sorting) event.preventDefault();
}

/** 只在排序模式接受分组拖动，全部 SDK 分组使用相同规则。 */
function onGroupDragStart(group: DesignerToolboxGroup, event: DragEvent): void {
	if (!props.sorting) {
		event.preventDefault();
		return;
	}
	draggedGroup.value = group.name;
	dropTarget.value = undefined;
	event.dataTransfer?.setData("application/x-es4a-toolbox-category", group.name);
	if (event.dataTransfer !== null) {
		event.dataTransfer.effectAllowed = "move";
	}
}

/** 只为当前面板中的分组拖动显示标题上下插入线，不接管组件或列拖动。 */
function onGroupDragOver(group: DesignerToolboxGroup, event: DragEvent): void {
	if (!props.sorting || draggedGroup.value === undefined) {
		return;
	}
	event.stopPropagation();
	dropTarget.value = undefined;
	if (group.name === draggedGroup.value) {
		return;
	}
	const summary = event.currentTarget instanceof HTMLElement ? event.currentTarget.querySelector("summary") : null;
	if (summary === null) {
		return;
	}
	const bounds = summary.getBoundingClientRect();
	dropTarget.value = { name: group.name, position: event.clientY < bounds.top + bounds.height / 2 ? "before" : "after" };
	event.preventDefault();
	if (event.dataTransfer !== null) {
		event.dataTransfer.dropEffect = "move";
	}
}

/** 拖动离开当前分组时清理插入线，跨其内部子节点移动时保留。 */
function onGroupDragLeave(event: DragEvent): void {
	if (event.currentTarget instanceof HTMLElement
		&& (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget))) {
		dropTarget.value = undefined;
	}
}

/** 提交分组之间的移动意图；实际顺序由宿主更新用户设置后统一返回。 */
function onGroupDrop(group: DesignerToolboxGroup, event: DragEvent): void {
	if (!props.sorting || draggedGroup.value === undefined) {
		return;
	}
	event.stopPropagation();
	onGroupDragOver(group, event);
	if (dropTarget.value !== undefined) {
		emit("moveCategory", draggedGroup.value, group.name, dropTarget.value.position);
	}
	finishGroupDrag();
}

/** 结束或取消分组拖动，仅清理当前面板的临时反馈。 */
function finishGroupDrag(): void {
	draggedGroup.value = undefined;
	dropTarget.value = undefined;
}

/** 收起当前可用组件面板中的全部分组。 */
function collapseAllToolboxGroups(): void {
	for (const group of props.groups) collapsedGroups.add(group.name);
}

/** 展开当前可用组件面板中的全部分组。 */
function expandAllToolboxGroups(): void {
	if (props.sorting) return;
	collapsedGroups.clear();
}

defineExpose({ collapseAllToolboxGroups, expandAllToolboxGroups });

/** 由 details 的真实开合状态同步分组集合，避免渲染刷新丢失用户选择。 */
function toggleGroup(name: string, event: Event): void {
	if (!(event.currentTarget instanceof HTMLDetailsElement)) return;
	if (props.sorting) {
		event.currentTarget.open = false;
		collapsedGroups.add(name);
	} else if (event.currentTarget.open) collapsedGroups.delete(name);
	else collapsedGroups.add(name);
}
</script>
