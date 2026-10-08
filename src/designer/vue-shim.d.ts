/*
声明设计器 Vue 单文件组件模块，供扩展 TypeScript 严格检查识别。
xhwsd@qq.com 2026-8-30
*/

declare module "*.vue" {
	import type { DefineComponent } from "vue";
	const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
	export default component;
}
