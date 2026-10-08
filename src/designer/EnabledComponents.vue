<!--
呈现当前窗口已经启用的非可视组件，并提供选择、拖放与窗口根节点内排序。
xhwsd@qq.com 2026-8-30
-->

<template>
	<div
		class="nonvisual-list"
		:data-drop-target="readOnly ? undefined : rootPath"
		:data-accept="readOnly || rootPath === undefined ? undefined : 'nonvisual'"
		:title="readOnly || rootPath === undefined ? undefined : '拖入非可视组件'"
	>
		<button
			v-for="(component, index) in components"
			:key="component.path"
			type="button"
			:class="['nonvisual-item', { selected: component.path === selectedPath }]"
			:data-node-path="component.path"
			:data-component-path="component.path"
			:data-component-type="component.type"
			:data-menu-label="component.name"
			:data-layout-read-only="component.layoutReadOnly === true ? 'true' : undefined"
			:data-insert-accept="!readOnly && component.parentPath === rootPath ? 'nonvisual' : undefined"
			:data-insert-parent="!readOnly && component.parentPath === rootPath ? rootPath : undefined"
			:data-insert-reference="!readOnly && component.parentPath === rootPath ? component.path : undefined"
			:data-drag-component-path="component.path"
			:data-drag-component-type="component.type"
			data-drag-component-visual="false"
			:data-enabled-previous-parent="moveAnchor(component, components[index - 1])?.parentPath"
			:data-enabled-previous-reference="moveAnchor(component, components[index - 1])?.referencePath"
			:data-enabled-next-parent="moveAnchor(component, components[index + 1])?.parentPath"
			:data-enabled-next-reference="moveAnchor(component, components[index + 1])?.referencePath"
			:title="componentHoverHint(component)"
			:aria-label="componentHoverHint(component)"
			:draggable="!readOnly"
			@click="$emit('select', component.path)"
			@pointerenter="$emit('hover', component.path)"
			@pointerleave="$emit('hover', undefined)"
		>
			<ComponentIcon modifier="component-icon-enabled" :source="component.icon" :type="component.type" />
		</button>
	</div>
</template>

<script setup lang="ts">
import type { DesignerComponentNode } from "../designerModel";
import ComponentIcon from "./ComponentIcon.vue";
import { componentHoverHint } from "./designerView";

const props = defineProps<{
	readonly components: readonly DesignerComponentNode[];
	readonly readOnly: boolean;
	readonly rootPath?: string;
	readonly selectedPath?: string;
}>();

defineEmits<{
	hover: [xmlPath: string | undefined];
	select: [xmlPath: string];
}>();

/** 启用列表只使用窗口根节点下的非可视组件作为排序锚点。 */
function moveAnchor(
	component: DesignerComponentNode,
	anchor: DesignerComponentNode | undefined
): { readonly parentPath: string; readonly referencePath: string } | undefined {
	const parentPath = props.rootPath;
	if (
		props.readOnly
		|| component.layoutReadOnly === true
		|| anchor === undefined
		|| parentPath === undefined
		|| anchor.parentPath !== parentPath
		|| parentPath === component.path
		|| parentPath.startsWith(component.path + "/")
	) return undefined;
	return { parentPath, referencePath: anchor.path };
}
</script>
