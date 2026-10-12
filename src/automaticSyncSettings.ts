/*
统一读取各类自动同步开关；虚拟单元按真实文件归属应用用户及工作区设置。
xhwsd@qq.com 2026-10-10
*/

import * as vscode from "vscode";
import { toSimpleSourceUri } from "./simpleCodeFileSystem";

export const AUTOMATIC_SYNC_SETTINGS = {
	variable: "automaticSync.variable",
	component: "automaticSync.component",
	unit: "automaticSync.unit",
	package: "automaticSync.package"
} as const;

export type AutomaticSyncKind = keyof typeof AUTOMATIC_SYNC_SETTINGS;

export function isAutomaticSyncEnabled(kind: AutomaticSyncKind, uri: vscode.Uri): boolean {
	return vscode.workspace.getConfiguration("es4a", toSimpleSourceUri(uri) ?? uri).get<boolean>(AUTOMATIC_SYNC_SETTINGS[kind], true);
}
