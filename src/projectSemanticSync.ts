/*
串行维护项目语义快照，并合并项目树和文件事件触发的重复刷新。
xhwsd@qq.com 2026-9-10
*/

import * as vscode from "vscode";
import { ProgramTreeProvider, type ProgramTreeNode } from "./programTree";
import { ProjectSymbolIndex } from "./projectSymbolIndex";

/** 合并后台文件与项目操作的语义更新，发布后仅重绘可见单元。 */
export class ProjectSemanticSyncController implements vscode.Disposable {
	private batching = 0;
	private disposed = false;
	private revision = 0;
	private sequence = Promise.resolve();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly treeListener: vscode.Disposable;
	private readonly fileListener: vscode.Disposable;

	constructor(
		private readonly programs: ProgramTreeProvider,
		private readonly symbols: ProjectSymbolIndex,
		private readonly refreshLanguageFeatures: () => void,
		private readonly reportError: (message: string) => void
	) {
		this.treeListener = programs.onDidChangeTreeData((node) => this.onTreeChanged(node));
		this.fileListener = programs.onDidChangeProjectFiles(() => this.schedule());
	}

	async wait(): Promise<void> {
		/* 用户主动请求定义时，把尚未触发的防抖任务也纳入就绪边界。 */
		if (this.timer !== undefined) await this.refresh();
		await this.sequence;
	}

	/** 重构期间不发布中间快照，事务完成后由调用者统一刷新。 */
	beginBatch(): vscode.Disposable {
		this.batching += 1;
		this.revision += 1;
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		return new vscode.Disposable(() => { this.batching -= 1; });
	}

	schedule(): void {
		if (this.disposed || this.batching > 0) return;
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
		if (this.disposed || this.batching > 0) return;
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		await this.sync();
	}

	private async sync(): Promise<void> {
		const revision = this.revision;
		const isCurrent = (): boolean => !this.disposed && this.batching === 0 && revision === this.revision;
		const run = async (): Promise<void> => {
			if (!isCurrent()) return;
			const projects = await this.programs.getProjects();
			if (!isCurrent()) return;
			await this.symbols.updateProjects(projects, isCurrent);
			if (!isCurrent()) return;
			this.refreshLanguageFeatures();
			// 语义快照与目录显示分离，折叠项目树也必须继续更新语言能力。
			this.programs.refreshVisibleUnits();
		};
		this.sequence = this.sequence.then(run, run);
		await this.sequence;
	}

	private onTreeChanged(node: ProgramTreeNode | undefined): void {
		if (node === undefined) this.schedule();
	}

	dispose(): void {
		this.disposed = true;
		this.revision += 1;
		this.treeListener.dispose();
		this.fileListener.dispose();
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}
}
