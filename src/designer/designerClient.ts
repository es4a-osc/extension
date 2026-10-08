/*
启动 Vue 设计器应用，并把 VS Code Webview API 作为唯一宿主消息出口。
xhwsd@qq.com 2026-8-30
*/

/// <reference lib="dom" />

import { createApp } from "vue";
import type { DesignerWebviewMessage } from "../designerProtocol";
import DesignerApp from "./DesignerApp.vue";

/** Webview 只暴露向扩展宿主发送类型化消息的最小 API。 */
export interface VsCodeApi {
	postMessage(message: DesignerWebviewMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** 模板只允许一个 Vue 根节点，缺失时立即终止以暴露打包问题。 */
const mountPoint = document.getElementById("designer-app");
if (mountPoint === null) throw new Error("设计器模板缺少 Vue 挂载点：designer-app");

createApp(DesignerApp, { vscode: acquireVsCodeApi() }).mount(mountPoint);
