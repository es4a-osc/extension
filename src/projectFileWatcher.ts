/*
独立监听项目配置、源码和 Android 资源变化，确保折叠项目树不暂停后台语义分析。
xhwsd@qq.com 2026-11-1
*/

import * as fs from "node:fs";
import * as path from "node:path";
import type { SimpleProjectInfo } from "./project";
import { filePathKey, isPathInsideOrEqual, sameFilePath } from "./simpleProjectPaths";

/** 一个分析入口及其当前可监听的上级目录。 */
interface SemanticWatch {
	readonly directory: string;
	readonly watcher: fs.FSWatcher;
}

/** 选择最近存在的目录，兼顾尚未生成和被删除的源码、资源根。 */
function existingParent(directory: string): string {
	let candidate = directory;
	while (true) {
		try {
			if (fs.statSync(candidate).isDirectory()) {
				return candidate;
			}
		} catch {
			// 新建父目录后，下次语义同步会把监听缩回真实映射根。
		}
		const parent = path.dirname(candidate);
		if (parent === candidate) {
			return candidate;
		}
		candidate = parent;
	}
}

/** 文件分析不依赖树视图是否显示或节点是否展开。 */
export class ProjectFileWatcher {
	private readonly watches = new Map<string, SemanticWatch>();
	private projects: readonly SimpleProjectInfo[] = [];
	private disposed = false;

	/** 分别通知文件语义变化与项目配置变化，避免普通文件事件重建项目根。 */
	constructor(private readonly changed: (filePath: string, contentOnly?: boolean) => void, private readonly configured: (filePath: string) => void) {}

	/** 同步源码、资源及资产引用的分析入口，显示监听仍由项目树自行维护。 */
	update(projects: readonly SimpleProjectInfo[], projectFiles: readonly string[] = projects.map((project) => project.filePath)): void {
		this.projects = projects;
		const desired = new Set<string>();
		if (!this.disposed) {
			for (const file of projectFiles) {
				this.watch(`config:${filePathKey(file)}`, existingParent(path.dirname(file)), file, false, desired);
			}
			for (const project of projects) {
				for (const root of [...project.sourceDirectories, project.resourceDirectory, project.assetsDirectory]) {
					this.watch(`source:${filePathKey(root)}`, existingParent(root), root, true, desired);
				}
			}
		}
		for (const [key, watch] of this.watches) {
			if (!desired.has(key)) {
				watch.watcher.close();
				this.watches.delete(key);
			}
		}
	}

	/** 过滤与分析根无关的文件，以及 source=./ 覆盖到的构建产物。 */
	private watch(key: string, directory: string, target: string, recursive: boolean, desired: Set<string>): void {
		desired.add(key);
		const previous = this.watches.get(key);
		if (previous !== undefined && sameFilePath(previous.directory, directory)) {
			return;
		}
		previous?.watcher.close();
		this.watches.delete(key);
		try {
			const watcher = fs.watch(directory, { persistent: false, recursive }, (event, name) => {
				if (this.watches.get(key)?.watcher !== watcher) {
					return;
				}
				const changed = name === null ? undefined : path.join(directory, name);
				if (!recursive) {
					if (changed === undefined || isPathInsideOrEqual(changed, target)) {
						this.configured(target);
					}
					return;
				}
				if (changed !== undefined) {
					if (!isPathInsideOrEqual(target, changed) && !isPathInsideOrEqual(changed, target)) {
						return;
					}
					const owners = this.projects.filter((project) => (
						[...project.sourceDirectories, project.resourceDirectory, project.assetsDirectory]
							.some((root) => sameFilePath(root, target))
					));
					// 一个项目的构建目录可能包含另一个项目的源码，不能据此屏蔽后者。
					if (owners.length > 0 && owners.every((project) => isPathInsideOrEqual(project.buildDirectory, changed))) {
						return;
					}
				}
				// 系统没有给出文件名时，按该监听入口刷新，仍可定位影响范围。
				this.changed(changed ?? target, changed !== undefined && event === "change");
			});
			this.watches.set(key, { directory, watcher });
			watcher.on("error", () => {
				if (this.watches.get(key)?.watcher !== watcher) {
					return;
				}
				this.watches.delete(key);
				watcher.close();
				if (recursive) {
					this.changed(target);
				} else {
					this.configured(target);
				}
			});
		} catch {
			// 不可读目录由项目树展示；后续文件事件或主动刷新会重新尝试监听。
		}
	}

	/** 释放后台监听，独立于项目树的展开和可见状态。 */
	dispose(): void {
		this.disposed = true;
		this.update([]);
	}
}
