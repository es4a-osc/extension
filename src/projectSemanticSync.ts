/*
串行维护项目语义快照，并合并项目树和文件事件触发的重复刷新。
xhwsd@qq.com 2026-9-10
*/

import * as vscode from "vscode";
import type { ProgramTreeProvider } from "./programTree";
import { ProjectSymbolIndex } from "./projectSymbolIndex";
import { filePathKey } from "./simpleProjectPaths";

/** 合并后台文件与项目操作的语义更新，发布后仅重绘可见单元。 */
export class ProjectSemanticSyncController implements vscode.Disposable {
	private batching = 0;
	private disposed = false;
	private revision = 0;
	private sequence = Promise.resolve();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly changedPaths = new Map<string, boolean>();
	private refreshAll = false;
	private readonly fileListener: vscode.Disposable;

	constructor(
		private readonly programs: ProgramTreeProvider,
		private readonly symbols: ProjectSymbolIndex,
		private readonly refreshLanguageFeatures: (projectFiles?: readonly string[]) => void,
		private readonly reportError: (message: string) => void
	) {
		this.fileListener = programs.onDidChangeProjectFiles((change) => this.schedule(change?.paths, change?.contentOnly));
	}

	async wait(): Promise<void> {
		// 扫描期间可能再次收到文件事件；就绪边界必须包含等待中新加入的刷新。
		while (!this.disposed) {
			if (this.timer !== undefined) {
				await this.flush();
			}
			const pending = this.sequence;
			await pending;
			if (this.timer === undefined && pending === this.sequence) {
				return;
			}
		}
	}

	/** 重构期间不发布中间快照，事务完成后由调用者统一刷新。 */
	beginBatch(): vscode.Disposable {
		this.batching += 1;
		this.revision += 1;
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		return new vscode.Disposable(() => {
			this.batching -= 1;
			this.schedulePending();
		});
	}

	private include(changes: Iterable<readonly [string, boolean]> | undefined): void {
		if (changes === undefined) {
			this.refreshAll = true;
			this.changedPaths.clear();
		} else if (!this.refreshAll) {
			for (const [key, contentOnly] of changes) {
				// 同一路径混合结构和内容事件时，必须按结构变化处理。
				this.changedPaths.set(key, contentOnly && this.changedPaths.get(key) !== false);
			}
		}
	}

	schedule(paths?: readonly string[], contentOnly = false): void {
		if (this.disposed) return;
		this.include(paths?.map((filePath) => [filePathKey(filePath), contentOnly] as const));
		this.schedulePending();
	}

	private schedulePending(): void {
		if (this.disposed || this.batching > 0 || (!this.refreshAll && this.changedPaths.size === 0)) return;
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			void this.flush().catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				this.reportError(`刷新项目语义索引失败：${message}`);
			});
		}, 150);
	}

	async refresh(paths?: readonly string[]): Promise<void> {
		if (this.disposed) return;
		this.include(paths?.map((filePath) => [filePathKey(filePath), false] as const));
		if (this.batching === 0) {
			await this.flush();
		}
	}

	private async flush(): Promise<void> {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		const run = async (): Promise<void> => {
			if (this.disposed || this.batching > 0 || (!this.refreshAll && this.changedPaths.size === 0)) return;
			const revision = this.revision;
			const isCurrent = (): boolean => !this.disposed && this.batching === 0 && revision === this.revision;
			const changes = this.refreshAll ? undefined : [...this.changedPaths];
			this.refreshAll = false;
			this.changedPaths.clear();
			try {
				const projects = await this.programs.getProjects();
				const paths = changes?.map(([filePath]) => filePath);
				const contentChanges = changes === undefined ? undefined : new Set(changes.filter(([, contentOnly]) => contentOnly).map(([filePath]) => filePath));
				const affected = isCurrent() ? await this.symbols.updateProjects(projects, isCurrent, paths, contentChanges) : [];
				if (!isCurrent()) {
					// 重构使本批结果失效，原有外部变更仍须随下一批处理。
					this.include(changes);
					this.schedulePending();
					return;
				}
				if (affected?.length !== 0) {
					this.refreshLanguageFeatures(affected);
					this.programs.refreshVisibleUnits();
				}
			} catch (error) {
				this.include(changes);
				throw error;
			}
		};
		this.sequence = this.sequence.then(run, run);
		await this.sequence;
	}

	dispose(): void {
		this.disposed = true;
		this.revision += 1;
		this.fileListener.dispose();
		this.changedPaths.clear();
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}
}
