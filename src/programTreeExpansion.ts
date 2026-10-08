/*
协调项目树的单目录链自动展开与活动单元定位，避免异步树操作互相抢占状态。
xhwsd@qq.com 2026-9-2
*/

import * as vscode from "vscode";
import { ProgramTreeProvider, type ProgramTreeNode } from "./programTree";

/** 单目录链控制器实际使用的 Provider 能力。 */
export type ProgramTreeExpansionProvider = Pick<ProgramTreeProvider, "getSingleDirectoryChild">;

/** 单目录链控制器实际使用的 TreeView 能力。 */
export type ProgramTreeExpansionView = Pick<
	vscode.TreeView<ProgramTreeNode>,
	"onDidCollapseElement" | "onDidExpandElement" | "reveal"
>;

/** 管理项目树展开交互，并封装活动单元定位期间的自动展开抑制。 */
export class ProgramTreeExpansionController implements vscode.Disposable {
	private expansionRequest = 0;
	private expansionTask: symbol | undefined;
	private revealDepth = 0;
	private readonly expandListener: vscode.Disposable;
	private readonly collapseListener: vscode.Disposable;

	constructor(
		private readonly provider: ProgramTreeExpansionProvider,
		private readonly view: ProgramTreeExpansionView,
		private readonly reportError: (message: string) => void
	) {
		this.expandListener = view.onDidExpandElement((event) => {
			if (
				this.revealDepth > 0
				|| this.expansionTask !== undefined
				|| !this.isExpansionRoot(event.element)
			) {
				return;
			}

			void this.expandSingleDirectoryChain(event.element);
		});
		this.collapseListener = view.onDidCollapseElement(() => {
			this.cancel();
		});
	}

	/** 取消尚未完成的单目录链展开。 */
	cancel(): void {
		this.expansionRequest += 1;
		this.expansionTask = undefined;
	}

	/** 定位活动单元，并在定位期间忽略由 `reveal` 产生的展开事件。 */
	async revealActiveUnit(unit: ProgramTreeNode): Promise<void> {
		await this.revealNode(unit);
	}

	/** 选中转到定义命中的真实资源，并抑制定位过程触发的自动展开。 */
	async revealResource(resource: ProgramTreeNode): Promise<void> {
		await this.revealNode(resource);
	}

	/** 统一执行项目树节点定位，避免 reveal 事件与单目录链展开互相抢占。 */
	private async revealNode(node: ProgramTreeNode): Promise<void> {
		this.cancel();
		this.revealDepth += 1;
		try {
			await this.view.reveal(node, { focus: false, select: true });
		} finally {
			this.revealDepth -= 1;
		}
	}

	/** 仅单元、资源分组及其真实目录可以启动单目录链展开。 */
	private isExpansionRoot(node: ProgramTreeNode): boolean {
		return node.kind === "units"
			|| node.kind === "resources"
			|| node.kind === "assets"
			|| node.kind === "directory"
			|| node.kind === "res";
	}

	/** 连续展开唯一的真实子目录，遇到文件、分叉、空目录或读取错误即停止。 */
	private async expandSingleDirectoryChain(start: ProgramTreeNode): Promise<void> {
		const request = ++this.expansionRequest;
		const task = Symbol("singleDirectoryExpansion");
		this.expansionTask = task;
		let current = start;

		try {
			while (request === this.expansionRequest && this.expansionTask === task) {
				const child = await this.provider.getSingleDirectoryChild(current);
				if (
					child === undefined
					|| request !== this.expansionRequest
					|| this.expansionTask !== task
				) {
					return;
				}

				await this.view.reveal(child, { expand: true, focus: false, select: false });
				current = child;
			}
		} catch (error) {
			if (request === this.expansionRequest && this.expansionTask === task) {
				const message = error instanceof Error ? error.message : String(error);
				this.reportError(`无法自动展开项目目录：${message}`);
			}
		} finally {
			if (this.expansionTask === task) {
				this.expansionTask = undefined;
			}
		}
	}

	/** 释放项目树展开事件。 */
	dispose(): void {
		this.cancel();
		this.expandListener.dispose();
		this.collapseListener.dispose();
	}
}
