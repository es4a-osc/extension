<!--
呈现设计器组件操作菜单及动态事件二级菜单，并保持子菜单在可视区域内。
xhwsd@qq.com 2026-8-30
-->

<template>
	<div
		ref="menu"
		class="component-context-menu"
		role="menu"
		:aria-label="enabled ? '启用组件操作' : '组件操作'"
		:style="{ left: left + 'px', top: top + 'px' }"
		@click.stop
	>
		<div
			v-if="events.length > 0"
			class="context-menu-section context-menu-submenu"
			@pointerenter="showSubmenu"
			@pointerleave="hideSubmenu"
		>
			<button
				ref="eventTrigger"
				class="context-menu-item context-menu-submenu-trigger"
				type="button"
				role="menuitem"
				aria-haspopup="menu"
				:aria-expanded="submenuVisible ? 'true' : 'false'"
				@click="showSubmenu"
				@focus="showSubmenu"
			>
				<span>组件事件</span><span class="context-menu-submenu-arrow" aria-hidden="true">›</span>
			</button>
			<div
				v-if="submenuVisible"
				ref="eventSubmenu"
				class="component-context-menu context-menu-flyout"
				role="menu"
				aria-label="组件事件"
				:style="{ left: submenuLeft + 'px', top: submenuTop + 'px' }"
			>
				<button
					v-for="componentEvent in events"
					:key="componentEvent.name"
					class="context-menu-item context-menu-event-item"
					type="button"
					role="menuitem"
					:title="sdkDescriptionHoverHint(componentEvent.description, componentEvent.name)"
					:aria-label="componentEvent.existing
						? componentEvent.name + '，已存在，跳转到代码'
						: componentEvent.name + '，插入事件'"
					@click="$emit('activate-component-event', componentEvent.name)"
				>
					<span class="context-menu-event-name">{{ componentEvent.name }}</span>
					<span v-if="componentEvent.existing" class="context-menu-event-status">✓</span>
				</button>
			</div>
		</div>
		<button
			v-if="defineLibrary"
			class="context-menu-item"
			type="button"
			role="menuitem"
			:aria-label="'定位类库' + label"
			@click="$emit('reveal-library-definition')"
		>定位类库</button>
		<div
			v-if="(events.length > 0 || defineLibrary) && (enabled || componentActions || canPaste)"
			class="context-menu-separator"
			role="separator"
		></div>
		<button
			v-if="availableComponent"
			class="context-menu-item"
			type="button"
			role="menuitem"
			:aria-label="'加入布局' + label"
			:disabled="!canAdd"
			@click="$emit('add-component')"
		>加入布局</button>

		<template v-if="readOnly">
			<button v-if="componentActions" class="context-menu-item" type="button" role="menuitem" :aria-label="'复制组件' + label" @click="$emit('copy-component')">复制组件</button>
		</template>
		<template v-else-if="enabled">
			<button
				class="context-menu-item"
				type="button"
				role="menuitem"
				:aria-label="'前移组件' + label"
				:disabled="!movePrevious"
				@click="$emit('move-enabled-component', 'previous')"
			>前移组件</button>
			<button
				class="context-menu-item"
				type="button"
				role="menuitem"
				:aria-label="'后移组件' + label"
				:disabled="!moveNext"
				@click="$emit('move-enabled-component', 'next')"
			>后移组件</button>
			<button class="context-menu-item" type="button" role="menuitem" :aria-label="'复制组件' + label" @click="$emit('copy-component')">复制组件</button>
			<button class="context-menu-item" type="button" role="menuitem" :aria-label="'剪切组件' + label" @click="$emit('cut-component')">剪切组件</button>
			<button class="context-menu-item" type="button" role="menuitem" :aria-label="'删除组件' + label" @click="$emit('remove-component')">删除组件</button>
		</template>
		<template v-else-if="componentActions || canPaste">
			<template v-if="layoutMove">
				<button
					class="context-menu-item"
					type="button"
					role="menuitem"
					:aria-label="'前移组件' + label"
					:disabled="!movePrevious"
					@click="$emit('move-component', 'previous')"
				>前移组件</button>
				<button
					class="context-menu-item"
					type="button"
					role="menuitem"
					:aria-label="'后移组件' + label"
					:disabled="!moveNext"
					@click="$emit('move-component', 'next')"
				>后移组件</button>
			</template>
			<button v-if="componentActions" class="context-menu-item" type="button" role="menuitem" :aria-label="'复制组件' + label" @click="$emit('copy-component')">复制组件</button>
			<button v-if="componentActions" class="context-menu-item" type="button" role="menuitem" :aria-label="'剪切组件' + label" @click="$emit('cut-component')">剪切组件</button>
			<button v-if="canPaste" class="context-menu-item" type="button" role="menuitem" :aria-label="'粘贴组件到' + label" @click="$emit('paste-component')">粘贴组件</button>
			<template v-if="componentActions">
				<button class="context-menu-item" type="button" role="menuitem" :aria-label="'删除组件' + label" @click="$emit('remove-component')">删除组件</button>
			</template>
		</template>
	</div>
</template>

<script setup lang="ts">
import { nextTick, ref, useTemplateRef } from "vue";
import type { DesignerComponentEventItem } from "../designerComponentEvents";
import { sdkDescriptionHoverHint } from "./designerView";

defineProps<{
	readonly availableComponent: boolean;
	readonly canAdd: boolean;
	readonly canPaste: boolean;
	readonly componentActions: boolean;
	readonly defineLibrary: boolean;
	readonly enabled: boolean;
	readonly events: readonly DesignerComponentEventItem[];
	readonly label: string;
	readonly layoutMove: boolean;
	readonly left: number;
	readonly moveNext: boolean;
	readonly movePrevious: boolean;
	readonly readOnly: boolean;
	readonly top: number;
}>();

defineEmits<{
	"activate-component-event": [eventName: string];
	"add-component": [];
	"copy-component": [];
	"cut-component": [];
	"move-component": [direction: "next" | "previous"];
	"move-enabled-component": [direction: "next" | "previous"];
	"paste-component": [];
	"remove-component": [];
	"reveal-library-definition": [];
}>();

const eventTrigger = useTemplateRef<HTMLButtonElement>("eventTrigger");
const eventSubmenu = useTemplateRef<HTMLElement>("eventSubmenu");
const submenuVisible = ref(false);
const submenuLeft = ref(0);
const submenuTop = ref(0);

/** 打开事件二级菜单，并在完成渲染后选择左右展开方向及可见纵坐标。 */
async function showSubmenu(event?: Event): Promise<void> {
	event?.stopPropagation();
	submenuVisible.value = true;
	await nextTick();
	const trigger = eventTrigger.value;
	const submenu = eventSubmenu.value;
	if (trigger === null || submenu === null) return;
	const triggerBounds = trigger.getBoundingClientRect();
	const submenuBounds = submenu.getBoundingClientRect();
	const preferredLeft = triggerBounds.right - 2;
	submenuLeft.value = preferredLeft + submenuBounds.width <= window.innerWidth - 4
		? preferredLeft
		: Math.max(4, triggerBounds.left - submenuBounds.width + 2);
	submenuTop.value = Math.max(4, Math.min(
		triggerBounds.top - 4,
		window.innerHeight - submenuBounds.height - 4
	));
}

/** 指针离开菜单组时关闭事件二级菜单。 */
function hideSubmenu(): void {
	submenuVisible.value = false;
}
</script>
