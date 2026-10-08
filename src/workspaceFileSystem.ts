/*
提供扩展各文件操作流程共享的 VS Code 工作区文件系统查询。
xhwsd@qq.com 2026-9-10
*/

import * as vscode from "vscode";

/** 判断 URI 是否对应已经存在的文件系统项。 */
export async function workspacePathExists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}
