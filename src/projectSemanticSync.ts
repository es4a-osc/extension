/*
串行维护项目语义快照，并合并项目树和文件事件触发的重复刷新。
xhwsd@qq.com 2026-9-10
*/

import * as vscode from "vscode";
import { ProgramTreeProvider, type ProgramTreeNode } from "./programTree";
import { ProjectSymbolIndex } from "./projectSymbolIndex";

/** 统一项目语义索引的立即刷新、防抖刷新和项目树回写抑制。 */
export class ProjectSemanticSyncController implements vscode.Disposable {
	private refreshingTree = false;
	private batching = 0;
	private sequence = Promise.resolve();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly treeListener: vscode.Disposable;

	constructor(
		private readonly programs: ProgramTreeProvider,
		private readonly symbols: ProjectSymbolIndex,
		private readonly refreshLanguageFeatures: () => void,
		private readonly reportError: (message: string) => void
	) {
		this.treeListener = programs.onDidChangeTreeData((node) => this.onTreeChanged(node));
	}

	wait(): Promise<void> {
		return this.sequence;
	}

	/** 重构期间不发布中间快照，事务完成后由调用者统一刷新。 */
	beginBatch(): vscode.Disposable {
		this.batching += 1;
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		return new vscode.Disposable(() => { this.batching -= 1; });
	}

	schedule(): void {
		if (this.batching > 0) return;
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.sync().catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				this.reportError(`刷新项目语义索引失败：${message}`);
			});
		}, 150);
	}

	async refresh(): Promise<void> {
		if (this.batching > 0) return;
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		await this.sync();
	}

	private async sync(): Promise<void> {
		const run = async (): Promise<void> => {
			const projects = await this.programs.getProjects();
			await this.symbols.updateProjects(projects);
			this.refreshLanguageFeatures();
			this.refreshingTree = true;
			try {
				this.programs.refresh();
			} finally {
				this.refreshingTree = false;
			}
		};
		this.sequence = this.sequence.then(run, run);
		await this.sequence;
	}

	private onTreeChanged(node: ProgramTreeNode | undefined): void {
		if (node === undefined && !this.refreshingTree) this.schedule();
	}

	dispose(): void {
		this.treeListener.dispose();
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}
}
