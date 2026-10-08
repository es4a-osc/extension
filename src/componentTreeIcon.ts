/*
把组件 SVG 数据源适配为 VS Code TreeItem 和编辑器标签页可用的明暗主题图标。
xhwsd@qq.com 2026-8-29
*/

import * as vscode from "vscode";
import { createComponentIconSources } from "./componentIcon";

/** VS Code 根据当前颜色主题选择的组件图标资源。 */
export interface ComponentTreeIconPath {
	readonly dark: vscode.Uri;
	readonly light: vscode.Uri;
}

/** 使用有效的清单 SVG 创建明暗主题树图标。 */
export function createComponentTreeIconPath(iconPath: string): ComponentTreeIconPath | undefined {
	const sources = createComponentIconSources(iconPath);
	return sources === undefined
		? undefined
		: {
			dark: vscode.Uri.parse(sources.dark),
			light: vscode.Uri.parse(sources.light)
		};
}
