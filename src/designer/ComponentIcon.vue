<!--
统一呈现 SDK 组件遮罩图标，缺失时使用相同占位图形，不从组件名称推断外观。
xhwsd@qq.com 2026-8-30
-->

<template>
	<span
		aria-hidden="true"
		:class="['component-icon', modifier, { 'component-icon-fallback': source === undefined }]"
		:style="source === undefined ? undefined : { '--component-icon-source': `url(&quot;${source}&quot;)` }"
	>{{ source === undefined ? '◇' : '' }}</span>
</template>

<script setup lang="ts">
defineProps<{
	readonly modifier?: string;
	readonly source?: string;
}>();
</script>
