/*
读取和写入 ES4A 设计器的用户级界面设置，不接受工作区覆盖。
xhwsd@qq.com 2026-11-1
*/

import * as vscode from "vscode";
import { resolveDesignerColumnOrder, type DesignerColumnId } from "./designerLayout";
import { normalizeToolboxCategoryOrder } from "./designerToolboxOrder";

/** 按单元覆盖、用户默认、内置默认的优先级返回列顺序。 */
export function designerColumnOrder(documentOrder: unknown): readonly DesignerColumnId[] {
	return resolveDesignerColumnOrder(documentOrder,
		vscode.workspace.getConfiguration("es4a").inspect("designer.columnOrder")?.globalValue);
}

/** 取得当前用户的共享分类顺序，保留暂未安装的分类名称。 */
export function toolboxCategoryOrder(): readonly string[] {
	return normalizeToolboxCategoryOrder(
		vscode.workspace.getConfiguration("es4a").inspect("designer.toolboxCategoryOrder")?.globalValue);
}

/** 将分类拖动后的顺序写入用户设置。 */
export async function updateToolboxCategoryOrder(order: readonly string[]): Promise<void> {
	await vscode.workspace.getConfiguration("es4a")
		.update("designer.toolboxCategoryOrder", order, vscode.ConfigurationTarget.Global);
}
