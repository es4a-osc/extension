/*
注册类库树清单节点的打开与系统定位命令，不承担 SDK 加载或树数据构建。
xhwsd@qq.com 2026-9-21
*/

import * as vscode from "vscode";
import type { LibraryNode } from "./libraryTree";

/** 确认命令目标是类库树中的清单根节点。 */
function requireManifestNode(node: LibraryNode | undefined): Extract<LibraryNode, { readonly kind: "manifest" }> {
	if (node?.kind !== "manifest") {
		throw new Error("请在编译器、运行库或扩展类库根节点上执行此操作。");
	}
	return node;
}

/** 注册清单文件的打开与系统定位命令。 */
export function registerLibraryCommands(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand("es4a.openLibraryManifest", async (node?: LibraryNode) => {
			const manifest = requireManifestNode(node).manifest;
			await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(manifest.filePath), {
				preview: false
			});
		}),
		vscode.commands.registerCommand("es4a.locateLibraryManifest", async (node?: LibraryNode) => {
			const manifest = requireManifestNode(node).manifest;
			await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(manifest.filePath));
		})
	);
}
