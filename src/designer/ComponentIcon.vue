<!--
统一呈现 SDK 组件遮罩图标，并在图标缺失时回退到稳定的文本图形。
xhwsd@qq.com 2026-8-30
-->

<template>
	<span
		aria-hidden="true"
		:class="['component-icon', modifier, { 'component-icon-fallback': source === undefined }]"
		:style="source === undefined ? undefined : { '--component-icon-source': `url(&quot;${source}&quot;)` }"
	>{{ source === undefined ? componentGlyph(type) : '' }}</span>
</template>

<script setup lang="ts">
import { componentGlyph } from "./designerView";

defineProps<{
	readonly modifier?: string;
	readonly source?: string;
	readonly type: string;
}>();
</script>
