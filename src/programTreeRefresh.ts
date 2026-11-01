/*
为整个项目树维护稳定节点、可见展开状态和逐层文件监听，独立于后台语义索引。
xhwsd@qq.com 2026-11-1
*/

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProgramTreeNode } from "./programTree";
import { filePathKey, isPathInsideOrEqual, sameFilePath } from "./simpleProjectPaths";

/** 一个显示分支中的稳定节点；物理路径相同的不同分支不共享展开状态。 */
interface NodeState {
	readonly key: string;
	readonly node: ProgramTreeNode;
	readonly parent?: NodeState;
	missing?: boolean;
	snapshot?: string;
	revision: number;
	refreshRequested: boolean;
}

/** 非递归目录监听及其实际路径。 */
interface DirectoryWatch {
	readonly directoryPath: string;
	readonly watcher: fs.FSWatcher;
}

/** 只把真实目录作为可枚举路径。 */
function directoryExists(directoryPath: string): boolean {
	try {
		return fs.statSync(directoryPath).isDirectory();
	} catch {
		return false;
	}
}

/** 显示节点是否拥有可延迟加载的下一层。 */
function isContainer(node: ProgramTreeNode): boolean {
	return node.kind !== "file" && node.kind !== "unit" && node.kind !== "error";
}

/** 单源码根直接映射到“单元”；多源码根分别映射为真实目录。 */
function physicalDirectory(node: ProgramTreeNode): string | undefined {
	if ("directoryPath" in node) {
		return node.directoryPath;
	}
	return node.kind === "units" && node.project.sourceDirectories.length === 1
		? node.project.sourceDirectories[0] : undefined;
}

/** 列表快照只包含直接子项名称和类型，不含文件内容与修改时间。 */
function snapshot(entries: readonly (readonly [string, string])[]): string {
	return JSON.stringify([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

/** 项目树的显示监听与源码、资源的后台分析各自维护生命周期。 */
export class ProgramTreeRefreshController {
	private readonly states = new Map<string, NodeState>();
	private readonly nodeStates = new WeakMap<ProgramTreeNode, NodeState>();
	private readonly branches = new Map<string, Set<NodeState>>();
	private readonly expanded = new Set<string>();
	private readonly watches = new Map<string, DirectoryWatch>();
	private readonly pending = new Set<NodeState>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private visible = false;
	private disposed = false;

	/** 通过唯一的局部通知出口更新节点，不由目录事件请求整树刷新。 */
	constructor(private readonly refresh: (node: ProgramTreeNode) => void) {}

	/** 同步项目列表并复用项目节点，移除项目时释放其全部下级状态。 */
	roots(nodes: readonly ProgramTreeNode[]): ProgramTreeNode[] {
		const result = nodes.map((node) => this.bind(node));
		const retained = new Set(result.map((node) => this.nodeStates.get(node)!.key));
		for (const state of this.states.values()) {
			if (state.parent === undefined && !retained.has(state.key)) {
				this.remove(state);
			}
		}
		this.synchronizeWatches();
		return result;
	}

	/** 记录实际读取的一层，复用子节点并回收已消失的显示分支。 */
	children(parent: ProgramTreeNode, children: readonly ProgramTreeNode[]): ProgramTreeNode[] {
		const state = this.nodeStates.get(parent);
		if (state === undefined || this.states.get(state.key) !== state) {
			return [...children];
		}
		const result = children.map((node) => this.bind(node, state));
		const retained = new Set(result.map((node) => this.nodeStates.get(node)!.key));
		for (const candidate of this.branches.get(state.key) ?? []) {
			if (!retained.has(candidate.key)) {
				this.remove(candidate);
			}
		}
		state.revision += 1;
		// 定位和自动展开也会读取子项。只建立首次基线，后续基线由局部通知推进，
		// 否则探测读取可能先消费结构变化，让仍显示旧列表的界面收不到刷新。
		if (state.snapshot === undefined && !children.some((node) => node.kind === "error")) {
			state.snapshot = snapshot(children.flatMap((node): Array<readonly [string, string]> => (
				"directoryPath" in node ? [[path.basename(node.directoryPath), "directory"] as const]
					: "filePath" in node ? [[path.basename(node.filePath), "file"] as const] : []
			)));
		}
		this.synchronizeWatches();
		return result;
	}

	/** 按父链跟踪展开状态，收起父级不再监听其隐藏的后代。 */
	setExpanded(node: ProgramTreeNode, expanded: boolean): void {
		const state = this.nodeStates.get(node);
		if (state === undefined || !isContainer(node)) {
			return;
		}
		const before = this.visibleExpandedKeys();
		if (expanded) {
			this.expanded.add(state.key);
		} else {
			this.expanded.delete(state.key);
		}
		this.synchronizeWatches();
		if (expanded) {
			this.checkNewlyVisible(before);
		}
	}

	/** 整个视图隐藏时停止显示监听，恢复显示时重新核对已展开层级。 */
	setVisible(visible: boolean): void {
		const before = this.visibleExpandedKeys();
		this.visible = visible;
		this.synchronizeWatches();
		if (visible) {
			this.checkNewlyVisible(before);
		}
	}

	/** 代码关系等主动更新只通知可见节点，隐藏列表在下次展开时重读。 */
	request(node: ProgramTreeNode): void {
		const state = this.nodeStates.get(node);
		if (state !== undefined) {
			state.refreshRequested = true;
			this.queue(state);
		}
	}

	/** 后台语义更新只重绘当前可见单元，不重建目录列表或项目根。 */
	refreshVisibleUnits(): void {
		for (const state of this.states.values()) {
			if (state.node.kind === "unit" && this.isVisible(state, false)) {
				this.refresh(state.node);
			}
		}
	}

	/** 按完整显示父链定位节点；元数据更新保留对象身份与菜单参数。 */
	private bind(node: ProgramTreeNode, parent?: NodeState): ProgramTreeNode {
		const identity = "directoryPath" in node ? filePathKey(node.directoryPath)
			: "filePath" in node ? filePathKey(node.filePath)
				: node.kind === "project" ? filePathKey(node.project.filePath)
					: node.kind === "error" ? node.projectFilePath ?? node.label : node.kind;
		const key = `${parent?.key ?? ""}\0${JSON.stringify([node.kind, "mode" in node ? node.mode : undefined, identity])}`;
		const previous = this.states.get(key);
		if (previous !== undefined) {
			// readonly 约束调用方；显示状态的所有者只在重新读取时合并最新元数据。
			Object.assign(previous.node, node);
			return previous.node;
		}
		const directory = physicalDirectory(node);
		const state: NodeState = {
			key, node, parent, revision: 0, refreshRequested: false,
			missing: directory === undefined ? undefined : !directoryExists(directory)
		};
		this.states.set(key, state);
		this.nodeStates.set(node, state);
		if (parent !== undefined) {
			let siblings = this.branches.get(parent.key);
			if (siblings === undefined) {
				siblings = new Set();
				this.branches.set(parent.key, siblings);
			}
			siblings.add(state);
		}
		return node;
	}

	/** 清理一个失效显示分支，不影响同一路径在其它分支中的节点。 */
	private remove(root: NodeState): void {
		const pending = [root];
		while (pending.length > 0) {
			const state = pending.pop()!;
			for (const child of this.branches.get(state.key) ?? []) {
				pending.push(child);
			}
			this.branches.delete(state.key);
			if (state.parent !== undefined) {
				this.branches.get(state.parent.key)?.delete(state);
			}
			this.states.delete(state.key);
			this.expanded.delete(state.key);
			this.pending.delete(state);
		}
	}

	/** 节点可见取决于完整显示父链，不能仅凭物理目录是否嵌套判断。 */
	private isVisible(state: NodeState, includeSelf: boolean): boolean {
		if (!this.visible || this.states.get(state.key) !== state) {
			return false;
		}
		let ancestor: NodeState | undefined = includeSelf ? state : state.parent;
		while (ancestor !== undefined) {
			if (!this.expanded.has(ancestor.key)) {
				return false;
			}
			ancestor = ancestor.parent;
		}
		return true;
	}

	/** 保存当前实际可见的展开集合，展开子项时不连带刷新祖先。 */
	private visibleExpandedKeys(): ReadonlySet<string> {
		return new Set([...this.states.values()].filter((state) => this.isVisible(state, true)).map((state) => state.key));
	}

	/** 展开探测可能提前调用 getChildren，因此重新可见必须明确发出局部通知。 */
	private checkNewlyVisible(before: ReadonlySet<string>): void {
		for (const state of this.states.values()) {
			if (this.isVisible(state, true) && !before.has(state.key) && isContainer(state.node)) {
				state.refreshRequested = true;
				this.queue(state);
			}
		}
	}

	/** 展开目录只监听下一层；映射根另监听父级以感知首次生成与删除。 */
	private synchronizeWatches(): void {
		const desired = new Set<string>();
		if (!this.disposed) {
			for (const state of this.states.values()) {
				const directory = physicalDirectory(state.node);
				if (directory === undefined || !this.isVisible(state, false)) {
					continue;
				}
				const parentDirectory = state.parent === undefined ? undefined : physicalDirectory(state.parent.node);
				if (parentDirectory === undefined || !sameFilePath(parentDirectory, path.dirname(directory))) {
					let parent = path.dirname(directory);
					while (!directoryExists(parent) && path.dirname(parent) !== parent) {
						parent = path.dirname(parent);
					}
					this.watch(`root:${state.key}`, parent, state, directory, desired);
				}
				if (this.isVisible(state, true) && directoryExists(directory)) {
					this.watch(`children:${state.key}`, directory, state, undefined, desired);
				}
			}
		}
		for (const [key, registration] of this.watches) {
			if (!desired.has(key)) {
				registration.watcher.close();
				this.watches.delete(key);
			}
		}
	}

	/** 显示监听只关注结构事件；同名文件内容覆盖不重建列表。 */
	private watch(key: string, directory: string, state: NodeState, root: string | undefined, desired: Set<string>): void {
		desired.add(key);
		const previous = this.watches.get(key);
		if (previous !== undefined && sameFilePath(previous.directoryPath, directory)) {
			return;
		}
		previous?.watcher.close();
		this.watches.delete(key);
		try {
			const watcher = fs.watch(directory, { persistent: false, recursive: false }, (event, name) => {
				if (event === "rename" && (root === undefined || name === null || isPathInsideOrEqual(path.join(directory, name), root))) {
					this.queue(state);
					// 子目录被快速删除再创建时，父级名称列表可能完全相同。
					// 仍须核对该可见子目录，恢复其监听并更新已展开的内部列表。
					if (root === undefined) {
						for (const child of this.branches.get(state.key) ?? []) {
							const childDirectory = physicalDirectory(child.node);
							if (child.parent === state && childDirectory !== undefined
								&& (name === null || sameFilePath(childDirectory, path.join(directory, name)))) {
								this.queue(child);
							}
						}
					}
				}
			});
			this.watches.set(key, { directoryPath: directory, watcher });
			watcher.on("error", () => {
				if (this.watches.get(key)?.watcher === watcher) {
					this.watches.delete(key);
				}
				watcher.close();
				this.queue(state);
			});
		} catch {
			// 目录可能已被移动；重新展开或映射根的父级事件会再次建立监听。
		}
	}

	/** 在固定窗口合并变化，持续写入不会为每个文件单独刷新。 */
	private queue(state: NodeState): void {
		if (this.disposed || !this.visible) {
			return;
		}
		this.pending.add(state);
		if (this.timer === undefined) {
			this.timer = setTimeout(() => {
				this.timer = undefined;
				const states = [...this.pending];
				this.pending.clear();
				void Promise.all(states.map((candidate) => this.check(candidate)));
			}, 100);
		}
	}

	/** 只核对直接子项，并在异步读取完成后再次校验可见性与读取版本。 */
	private async check(state: NodeState): Promise<void> {
		if (!this.isVisible(state, false)) {
			return;
		}
		const directory = physicalDirectory(state.node);
		const missing = directory === undefined ? undefined : !directoryExists(directory);
		const existenceChanged = state.missing !== missing;
		if ("directoryPath" in state.node) {
			Object.assign(state.node, { missing });
		}
		if (isContainer(state.node) && !this.isVisible(state, true)) {
			if (existenceChanged) {
				state.missing = missing;
				this.refresh(state.node);
			}
			this.synchronizeWatches();
			return;
		}
		const revision = state.revision;
		let current = state.snapshot;
		if (directory !== undefined) {
			try {
				const units = state.node.kind === "units" || ("mode" in state.node && state.node.mode === "units");
				const entries = await fs.promises.readdir(directory, { withFileTypes: true });
				current = snapshot(entries.flatMap((entry): Array<readonly [string, string]> => (
					entry.isDirectory() ? [[entry.name, "directory"]]
						: entry.isFile() && (!units || path.extname(entry.name).toLowerCase() === ".simple") ? [[entry.name, "file"]] : []
				)));
			} catch {
				current = "unavailable";
			}
		}
		if (this.disposed || !this.isVisible(state, isContainer(state.node))) {
			return;
		}
		if (state.revision !== revision) {
			this.queue(state);
			return;
		}
		if (state.refreshRequested || existenceChanged || state.snapshot !== current) {
			state.refreshRequested = false;
			state.missing = missing;
			state.snapshot = current;
			this.refresh(state.node);
		}
		this.synchronizeWatches();
	}

	/** 释放显示监听与延迟任务，不接触后台语义监听。 */
	dispose(): void {
		this.disposed = true;
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
		}
		this.synchronizeWatches();
		this.pending.clear();
		this.states.clear();
		this.branches.clear();
		this.expanded.clear();
	}
}
