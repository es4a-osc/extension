<!--
按 SDK 分类呈现可拖入组件，并在 Vue 状态中保留各分类的折叠状态。
xhwsd@qq.com 2026-8-30
-->

<template>
	<div class="section-content toolbox-list">
		<div v-if="groups.length === 0" class="toolbox-empty">SDK 没有提供可选组件。</div>
		<details
			v-for="group in groups"
			:key="group.name"
			class="toolbox-group"
			:open="!collapsedGroups.has(group.name)"
			@toggle="toggleGroup(group.name, $event)"
		>
			<summary class="toolbox-group-summary" :title="group.name">
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
					<ComponentIcon modifier="component-icon-toolbox" :source="item.icon" :type="item.name" />
					<span class="toolbox-name">{{ item.name }}</span>
				</div>
			</div>
		</details>
	</div>
</template>

<script setup lang="ts">
import { reactive } from "vue";
import type { DesignerToolboxGroup } from "../designerModel";
import ComponentIcon from "./ComponentIcon.vue";
import { componentTypeHoverHint } from "./designerView";

const props = defineProps<{ readonly groups: readonly DesignerToolboxGroup[] }>();

const collapsedGroups = reactive(new Set<string>());

/** 收起当前可用组件面板中的全部分类。 */
function collapseAllToolboxGroups(): void {
	for (const group of props.groups) collapsedGroups.add(group.name);
}

/** 展开当前可用组件面板中的全部分类。 */
function expandAllToolboxGroups(): void {
	collapsedGroups.clear();
}

defineExpose({ collapseAllToolboxGroups, expandAllToolboxGroups });

/** 由 details 的真实开合状态同步分类集合，避免渲染刷新丢失用户选择。 */
function toggleGroup(name: string, event: Event): void {
	if (!(event.currentTarget instanceof HTMLDetailsElement)) return;
	if (event.currentTarget.open) collapsedGroups.delete(name);
	else collapsedGroups.add(name);
}
</script>
