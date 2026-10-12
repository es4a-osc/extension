/*
协调项目重构的语义快照、冲突检查、代码与 XML 事务、文件移动及进度反馈。
xhwsd@qq.com 2026-10-10
*/

import * as path from "node:path";
import * as vscode from "vscode";
import { isAutomaticSyncEnabled } from "./automaticSyncSettings";
import { planSimpleComponentProjectRename, renameSimpleComponent } from "./componentRename";
import { parseProjectProperties, updateProjectMainForRenamedUnits, updateProjectProperty, type SimpleProjectInfo } from "./project";
import {
	minimalSimpleCodeChange, planSimpleUnitPaths, planSimpleResourceReferences,
	type RefactoringUnit, type SimpleUnitChange, type SimpleUnitPathChange
} from "./refactoringModel";
import { listSimpleFiles } from "./simpleFileDiscovery";
import { filePathKey, isPathInsideOrEqual, mostSpecificSourceRoot } from "./simpleProjectPaths";
import {
	SimpleCodeFileSystemProvider, SIMPLE_CODE_SCHEME, toSimpleCodeUri,
	type RefactoringUnitSnapshot
} from "./simpleCodeFileSystem";
import { indexSimpleProjectResources, simpleResourceReferenceForFile } from "./simpleResourceSymbols";
import { renameSimpleUnitLifecycleEventOwners } from "./unitFiles";
import { getSimplePropertyUnitType } from "./propertyXml";
import { workspacePathExists } from "./workspaceFileSystem";
import type { Sdk } from "./sdk";
import { KeyedTaskQueue } from "./keyedTaskQueue";

export interface ProjectRefactoringServices {
	readonly codeDocuments: SimpleCodeFileSystemProvider;
	readonly getSdk?: () => Sdk | undefined;
	readonly refreshProjectSemantics: () => Promise<void>;
	readonly beginSemanticBatch?: () => vscode.Disposable;
}

interface RefactoringTextFile {
	readonly filePath: string;
	readonly before: string;
	readonly after: string;
}

interface RefactoringPathMove {
	readonly oldFile: string;
	readonly newFile: string;
}

interface PreparedPathEdit {
	readonly dispose: () => void;
	readonly rollback: (error: unknown) => Promise<void>;
	completion?: Promise<void>;
	stage?: (text: string, synchronizing?: boolean) => void;
}

function pathMovesKey(moves: readonly RefactoringPathMove[]): string {
	return moves.map((move) => `${filePathKey(move.oldFile)}\n${filePathKey(move.newFile)}`).sort().join("\n\n");
}

interface ResourceChanges {
	readonly changes: readonly SimpleUnitChange[];
	readonly textFiles: readonly RefactoringTextFile[];
	readonly names: ReadonlyMap<string, string>;
}

/** 将替换范围压缩到真正发生变化的部分，保留编辑位置及未操作文本。 */
export function replaceChangedText(edit: vscode.WorkspaceEdit, document: vscode.TextDocument, next: string): void {
	const change = minimalSimpleCodeChange(document.getText(), next);
	if (change !== undefined) edit.replace(document.uri, new vscode.Range(document.positionAt(change.start), document.positionAt(change.end)), change.replacement);
}

export class SimpleProjectRefactoring implements vscode.Disposable {
	private readonly operations = new KeyedTaskQueue();
	private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 30);
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	private busy = false;
	private readonly preparedRenames = new Map<vscode.WorkspaceEdit, PreparedPathEdit>();
	private readonly requestedPathEdits = new Map<string, vscode.WorkspaceEdit>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	readonly onDidComplete = this.changeEmitter.event;
	get isBusy(): boolean { return this.busy; }

	constructor(private readonly services: ProjectRefactoringServices) {
		this.status.name = "ES4A 重构";
	}

	/** 原生连续路径操作等待上一次事务完成，不能因忙碌而跳过引用参与者。 */
	async waitForIdle(): Promise<void> {
		await this.operations.run("项目重构", async () => {});
	}

	async readProject(project: SimpleProjectInfo): Promise<readonly RefactoringUnitSnapshot[]> {
		const files = new Map<string, string>();
		for (const file of (await Promise.all(project.sourceDirectories.map((root) => listSimpleFiles(root)))).flat()) files.set(filePathKey(file), file);
		return Promise.all([...files.values()].map((file) => this.services.codeDocuments.readRefactoringUnit(vscode.Uri.file(file), mostSpecificSourceRoot(project.sourceDirectories, file)!)));
	}

	/** 设计器与 F2 共用组件计划及快照校验，界面不再自行拼接全项目改名流程。 */
	async planComponentRename(units: readonly RefactoringUnitSnapshot[], owner: RefactoringUnitSnapshot, componentPath: string, newName: string): Promise<readonly SimpleUnitChange[]> {
		if (this.busy) throw new Error("正在重构，请稍后重命名。");
		const changes = planSimpleComponentProjectRename(units, owner, componentPath, newName.trim(), this.services.getSdk?.());
		for (const unit of units.filter((unit) => unit === owner || changes.some((change) => change.unit === unit))) await unit.assertUnchanged();
		return changes;
	}

	/** 按真实路径类型区分发起操作，整个包移动不再叠加单元开关。 */
	private async pathSyncEnabled(file: string): Promise<boolean> {
		const uri = vscode.Uri.file(file);
		const stat = await vscode.workspace.fs.stat(uri);
		return isAutomaticSyncEnabled((stat.type & vscode.FileType.Directory) !== 0 ? "package" : "unit", uri);
	}

	/** 关闭同步时只读取移动对象，供未保存预检和共享会话迁移使用。 */
	private async readMovedUnits(project: SimpleProjectInfo, moves: readonly RefactoringPathMove[]): Promise<readonly RefactoringUnitSnapshot[]> {
		const files = new Map<string, string>();
		for (const move of moves) {
			const stat = await vscode.workspace.fs.stat(vscode.Uri.file(move.oldFile));
			const moving = (stat.type & vscode.FileType.Directory) !== 0 ? await listSimpleFiles(move.oldFile) : path.extname(move.oldFile).toLowerCase() === ".simple" ? [move.oldFile] : [];
			for (const file of moving) files.set(filePathKey(file), file);
		}
		return Promise.all([...files.values()].map((file) => this.services.codeDocuments.readRefactoringUnit(vscode.Uri.file(file), mostSpecificSourceRoot(project.sourceDirectories, file)!)));
	}

	/** 原生参与者负责确认和应用；关联文本保留未保存状态，再刷新语义及标签。 */
	async renamePath(project: SimpleProjectInfo, oldFile: string, newFile: string, kind: "units" | "resources"): Promise<void> {
		await this.run(async (stage) => {
			if (filePathKey(oldFile) === filePathKey(newFile)) return;
			const moves = [{ oldFile, newFile }];
			const edit = await this.prepareNativePathEdits(project, moves, kind);
			stage("等待文件重构确认…");
			await this.applyPathEdit(edit, moves, stage);
		});
	}

	/** 命令预检完成后复用同一计划，避免参与者再次扫描或跳过自身发起的操作。 */
	requestedPathEdit(files: readonly { readonly oldUri: vscode.Uri; readonly newUri: vscode.Uri }[]): vscode.WorkspaceEdit | undefined {
		return this.requestedPathEdits.get(pathMovesKey(files.map((file) => ({ oldFile: file.oldUri.fsPath, newFile: file.newUri.fsPath }))));
	}

	private async applyPathEdit(edit: vscode.WorkspaceEdit, moves: readonly RefactoringPathMove[], stage: (text: string, synchronizing?: boolean) => void): Promise<void> {
		const key = pathMovesKey(moves);
		const prepared = this.preparedRenames.get(edit)!;
		prepared.stage = stage;
		try {
			const pathEdit = new vscode.WorkspaceEdit();
			for (const move of moves) pathEdit.renameFile(vscode.Uri.file(move.oldFile), vscode.Uri.file(move.newFile), { overwrite: false });
			this.requestedPathEdits.set(key, edit);
			if (!await vscode.workspace.applyEdit(pathEdit)) throw new Error("VS Code 未能应用此次路径修改。");
			await prepared.completion;
		} catch (error) {
			if (prepared.completion === undefined) await prepared.rollback(error);
			throw error;
		} finally {
			this.requestedPathEdits.delete(key);
			if (prepared.completion === undefined) prepared.dispose();
		}
	}

	/** 不属于已添加项目的单元只同步自身，不猜测相邻文件的项目归属。 */
	async renameStandalonePath(oldFile: string, newFile: string, kind: "units" | "resources"): Promise<void> {
		await this.run(async (stage) => {
			if (await workspacePathExists(vscode.Uri.file(newFile))) throw new Error("目标路径已经存在。");
			const units = kind === "units" && path.extname(oldFile).toLowerCase() === ".simple" ? [await this.services.codeDocuments.readRefactoringUnit(vscode.Uri.file(oldFile), path.dirname(oldFile))] : [];
			const paths = units.map((unit) => ({ oldFile, newFile, sourceRoot: unit.sourceRoot }));
			const synchronize = units.length > 0 && await this.pathSyncEnabled(oldFile);
			stage(synchronize ? "正在重构单元名称及引用…" : "正在修改路径…", synchronize);
			const changes = synchronize ? this.renamedUnitContents(units, planSimpleUnitPaths(units, paths, this.services.getSdk?.()), paths) : [];
			const edit = await this.commit(undefined, units, changes, { oldFile, newFile, kind, paths, native: true }, true);
			await this.applyPathEdit(edit, [{ oldFile, newFile }], stage);
		});
	}

	private renamedUnitContents(units: readonly RefactoringUnit[], initial: readonly SimpleUnitChange[], paths: readonly SimpleUnitPathChange[]): SimpleUnitChange[] {
		let changes = [...initial];
		/* 改文件名还需同步自己的窗口根名称和生命周期事件；目录移动不改变短名。 */
		for (const moved of paths) {
			const oldName = path.basename(moved.oldFile, ".simple");
			const newName = path.basename(moved.newFile, ".simple");
			if (oldName === newName) continue;
			const unit = units.find((value) => filePathKey(value.filePath) === filePathKey(moved.oldFile))!;
			const previous = changes.find((value) => value.unit === unit);
			let userCode = renameSimpleUnitLifecycleEventOwners(previous?.userCode ?? unit.userCode, oldName, newName);
			let propertyDocument = previous?.propertyDocument ?? unit.property.document;
			if (propertyDocument !== undefined && getSimplePropertyUnitType(propertyDocument) === "窗口") {
				const renamed = renameSimpleComponent(userCode, propertyDocument, "/属性/定义[1]", newName, this.services.getSdk?.());
				userCode = renamed.userCode;
				propertyDocument = renamed.propertyDocument;
			}
			changes = changes.filter((value) => value.unit !== unit);
			if (userCode !== unit.userCode || propertyDocument !== unit.property.document) changes.push({ unit, userCode, propertyDocument, edits: [] });
		}
		return changes;
	}

	/** 原生资源管理器先应用参与者编辑，真实路径由 VS Code 自己移动。 */
	async prepareNativePathEdits(project: SimpleProjectInfo, moves: readonly RefactoringPathMove[], kind: "units" | "resources"): Promise<vscode.WorkspaceEdit> {
		for (const move of moves) {
			if (await workspacePathExists(vscode.Uri.file(move.newFile))) throw new Error("目标路径已经存在。");
			if (isPathInsideOrEqual(move.oldFile, move.newFile)) throw new Error("不能将文件夹移动到自身内部。");
			if (kind === "resources") this.assertResourceDestination(project, move.oldFile, move.newFile);
		}
		if (moves.some((move, index) => moves.some((other, otherIndex) => index !== otherIndex && isPathInsideOrEqual(move.oldFile, other.oldFile)))) throw new Error("移动路径存在父子重叠，请分开操作。");
		const synchronizedMoves: RefactoringPathMove[] = [];
		for (const move of moves) if (kind !== "units" || await this.pathSyncEnabled(move.oldFile)) synchronizedMoves.push(move);
		const units = synchronizedMoves.length > 0 ? await this.readProject(project) : await this.readMovedUnits(project, moves);
		const paths = kind === "units" ? units.flatMap((unit) => {
			const move = moves.find((value) => isPathInsideOrEqual(value.oldFile, unit.filePath));
			if (move === undefined) return [];
			const target = path.join(move.newFile, path.relative(move.oldFile, unit.filePath));
			const root = mostSpecificSourceRoot(project.sourceDirectories, target);
			if (root === undefined) throw new Error("自动引用重构只支持当前项目源码目录内的移动。");
			return [{ oldFile: unit.filePath, newFile: target, sourceRoot: root }];
		}) : [];
		const resources = kind === "resources" ? await this.resourceChanges(project, units, moves) : undefined;
		const synchronizedPaths = paths.filter((unit) => synchronizedMoves.some((move) => isPathInsideOrEqual(move.oldFile, unit.oldFile)));
		const changes = this.renamedUnitContents(units, kind === "units" ? synchronizedPaths.length === 0 ? [] : planSimpleUnitPaths(units, synchronizedPaths, this.services.getSdk?.()) : resources!.changes, synchronizedPaths);
		const first = moves[0];
		if (first === undefined) return new vscode.WorkspaceEdit();
		return this.commit(project, units, changes, { ...first, kind, paths, mainPaths: synchronizedPaths, resources, native: true, additionalPaths: moves.slice(1) }, true);
	}

	async applyChanges(project: SimpleProjectInfo, units: readonly RefactoringUnitSnapshot[], changes: readonly SimpleUnitChange[]): Promise<void> {
		await this.run(async (stage) => {
			stage("正在重构关联引用…");
			await this.commit(project, units, changes);
		});
	}

	private assertResourceDestination(project: SimpleProjectInfo, before: string, after: string): void {
		const root = mostSpecificSourceRoot([project.resourceDirectory, project.assetsDirectory], before);
		if (root === undefined || !isPathInsideOrEqual(root, after)) throw new Error("资源只能在同一资源根目录内移动。");
	}

	private async resourceChanges(project: SimpleProjectInfo, units: readonly RefactoringUnit[], moves: readonly RefactoringPathMove[]): Promise<ResourceChanges> {
		const resources = await indexSimpleProjectResources(project);
		const renames = new Map<string, string>();
		const names = new Map<string, string>();
		for (const symbol of resources.symbols) {
			const moving = symbol.sourceFiles.flatMap((file) => {
				const move = moves.find((value) => isPathInsideOrEqual(value.oldFile, file));
				return move === undefined ? [] : [path.join(move.newFile, path.relative(move.oldFile, file))];
			});
			if (moving.length === 0 || moving.length !== symbol.sourceFiles.length) continue;
			const references = moving.map((target) => simpleResourceReferenceForFile(project.resourceDirectory, target));
			if (new Set(references).size !== 1) throw new Error("同一资源的不同限定版本必须保留一致的资源名称。");
			const reference = references[0];
			if (reference === undefined) continue;
			const name = reference.slice(2);
			if (resources.symbols.some((value) => value.name === name && value.name !== symbol.name)) throw new Error(`资源名称“${name}”已经存在。`);
			if (name !== symbol.name) {
				renames.set(symbol.name, name);
				const separator = name.indexOf("_");
				names.set(`@${symbol.resourceType}/${symbol.resourceName}`, `@${name.slice(0, separator)}/${name.slice(separator + 1)}`);
			}
		}
		for (const move of moves) if (isPathInsideOrEqual(project.assetsDirectory, move.oldFile) && isPathInsideOrEqual(project.assetsDirectory, move.newFile)) names.set(path.relative(project.assetsDirectory, move.oldFile).split(path.sep).join("/"), path.relative(project.assetsDirectory, move.newFile).split(path.sep).join("/"));
		const textFiles: RefactoringTextFile[] = [];
		for (const uri of await vscode.workspace.findFiles(new vscode.RelativePattern(project.resourceDirectory, "**/*.xml"), null)) {
			// 与代码和项目属性采用同一规则：已打开的关联文件以当前缓冲区为基线。
			const opened = vscode.workspace.textDocuments.find((document) => document.uri.scheme === "file" && filePathKey(document.uri.fsPath) === filePathKey(uri.fsPath));
			const before = opened?.getText() ?? await vscode.workspace.decode(await vscode.workspace.fs.readFile(uri), { encoding: "utf8" });
			/* Android XML 注释和 CDATA 不包含可重构的资源引用，保持原文。 */
			const after = before.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|@[\p{L}_][\p{L}\p{N}_]*\/[\p{L}_][\p{L}\p{N}_]*/gu, (value) => names.get(value) ?? value);
			if (after !== before) textFiles.push({ filePath: uri.fsPath, before, after });
		}
		return { changes: planSimpleResourceReferences(units, renames, this.services.getSdk?.(), names), textFiles, names };
	}

	private async commit(
		project: SimpleProjectInfo | undefined, snapshots: readonly RefactoringUnitSnapshot[], changes: readonly SimpleUnitChange[],
		move?: { readonly oldFile: string; readonly newFile: string; readonly kind: "units" | "resources"; readonly paths: readonly SimpleUnitPathChange[]; readonly mainPaths?: readonly SimpleUnitPathChange[]; readonly resources?: ResourceChanges; readonly native?: boolean; readonly additionalPaths?: readonly RefactoringPathMove[] }, prepareOnly = false
	): Promise<vscode.WorkspaceEdit> {
		const pathMoves = move === undefined ? [] : [move, ...(move.additionalPaths ?? [])];
		const affected = new Set(changes.map((change) => filePathKey(change.unit.filePath)));
		for (const moved of move?.paths ?? []) affected.add(filePathKey(moved.oldFile));
		for (const unit of snapshots.filter((value) => affected.has(filePathKey(value.filePath)))) {
			// 被移动单元的模型会迁移；其它单元基于当前缓冲区规划，保留既有输入及前一次未保存的重构。
			if (move?.paths.some((value) => filePathKey(value.oldFile) === filePathKey(unit.filePath)) && this.services.codeDocuments.hasUnsavedChanges(vscode.Uri.file(unit.filePath))) throw new Error(`移动单元还有未保存修改，请先保存：${unit.filePath}`);
			await unit.assertUnchanged();
		}
		if (move !== undefined && vscode.workspace.textDocuments.some((document) => document.isDirty && document.uri.scheme === "file" && pathMoves.some((value) => isPathInsideOrEqual(value.oldFile, document.uri.fsPath)))) throw new Error("移动路径中还有未保存文件，请先保存。");
		const edit = new vscode.WorkspaceEdit();
		const documents: Array<{ readonly document: vscode.TextDocument; readonly change: SimpleUnitChange }> = [];
		const textDocuments: Array<{ readonly document: vscode.TextDocument; readonly file: RefactoringTextFile }> = [];
		const receipts: Array<Awaited<ReturnType<SimpleCodeFileSystemProvider["preparePropertyRefactor"]>>> = [];
		let mainDocument: vscode.TextDocument | undefined;
		let originalMain: string | undefined;
		let updatedMain: string | undefined;
		const pathRegistrations: vscode.Disposable[] = [];
		const disposeUnapplied = (): void => {
			for (const receipt of receipts) if (!receipt.isApplied()) receipt.dispose();
			for (const [index, value] of pathMoves.entries()) {
				if (!this.services.codeDocuments.isNativePathRenameApplied(vscode.Uri.file(value.oldFile), vscode.Uri.file(value.newFile))) pathRegistrations[index]?.dispose();
			}
		};
		const controlledNative = (value: RefactoringPathMove): boolean => move?.kind === "units" && (move.native === true || this.services.codeDocuments.isNativePathRename(vscode.Uri.file(value.oldFile), vscode.Uri.file(value.newFile)));
		const pathUri = (file: string): vscode.Uri => move?.kind === "units"
			? path.extname(file).toLowerCase() === ".simple" ? toSimpleCodeUri(vscode.Uri.file(file)) : vscode.Uri.file(file).with({ scheme: SIMPLE_CODE_SCHEME })
			: vscode.Uri.file(file);
		const rollbackChanges = async (error: unknown): Promise<void> => {
			/* applyEdit 失败也可能已完成部分资源操作，按当前状态生成反向事务，不保存用户原有输入。 */
			const rollback = new vscode.WorkspaceEdit();
			const movedPaths = [];
			for (const value of pathMoves) if (await workspacePathExists(vscode.Uri.file(value.newFile)) && !await workspacePathExists(vscode.Uri.file(value.oldFile))) movedPaths.push(value);
			const moved = movedPaths.length > 0;
			for (const { change } of documents) {
				const relocation = moved ? move?.paths.find((value) => filePathKey(value.oldFile) === filePathKey(change.unit.filePath)) : undefined;
				const document = this.services.codeDocuments.getOpenDocument(vscode.Uri.file(relocation?.newFile ?? change.unit.filePath));
				if (document?.getText() === change.userCode) replaceChangedText(rollback, document, change.unit.userCode);
				else if (document !== undefined && document.getText() !== change.unit.userCode) throw new Error("重构失败后代码再次变化，已停止自动恢复。", { cause: error });
			}
			for (const receipt of [...receipts].reverse()) if (await workspacePathExists(receipt.after)) rollback.renameFile(receipt.after, receipt.before, { overwrite: false });
			for (const { document, file } of textDocuments) {
				if (document.getText() === file.after) replaceChangedText(rollback, document, file.before);
				else if (document.getText() !== file.before) throw new Error("资源 XML 在重构失败后再次变化，已停止恢复。", { cause: error });
			}
			if (mainDocument !== undefined && mainDocument.getText() === updatedMain) replaceChangedText(rollback, mainDocument, originalMain!);
			for (const value of [...movedPaths].reverse()) {
				rollback.renameFile(pathUri(value.newFile), pathUri(value.oldFile), { overwrite: false });
				if (controlledNative(value)) rollback.renameFile(vscode.Uri.file(value.newFile), vscode.Uri.file(value.oldFile), { overwrite: false });
			}
			if (rollback.size > 0) {
				// 恢复仍处于当前队列任务内；原生参与者不能再次等待自身结束或重新规划反向引用。
				const restoring = pathMovesKey(movedPaths.map((value) => ({ oldFile: value.newFile, newFile: value.oldFile })));
				this.requestedPathEdits.set(restoring, new vscode.WorkspaceEdit());
				try {
					if (!await vscode.workspace.applyEdit(rollback)) throw new Error("重构失败，且无法完整恢复，请检查关联文件。", { cause: error });
				} finally { this.requestedPathEdits.delete(restoring); }
			}
			for (const registration of pathRegistrations) registration.dispose();
			for (const receipt of receipts) receipt.dispose();
		};
		const addPathEdit = (): void => {
			if (move === undefined) return;
			for (const value of pathMoves) {
				if (move.kind === "units") pathRegistrations.push(this.services.codeDocuments.allowUnitRename(vscode.Uri.file(value.oldFile), vscode.Uri.file(value.newFile), controlledNative(value)));
				if (move.native !== true || move.kind === "units") edit.renameFile(pathUri(value.oldFile), pathUri(value.newFile), { overwrite: false }, { label: "迁移单元标签与属性会话", needsConfirmation: false });
				if (controlledNative(value) && move.native !== true) edit.renameFile(vscode.Uri.file(value.oldFile), vscode.Uri.file(value.newFile), { overwrite: false });
			}
		};
		try {
			/* 先准备所有 XML 凭据，再迁移虚拟模型，最后处理其它单元文本；跨区持久化不能重置已登记的模型撤销。 */
			for (const change of changes) {
				// 路径操作会释放旧代码模型；自身代码须随 XML 经持久化事务恢复，不能留下旧 URI 的文本撤销记录。
				const moved = move?.paths.find((value) => filePathKey(value.oldFile) === filePathKey(change.unit.filePath));
				const persistMovedCode = moved !== undefined && change.userCode !== change.unit.userCode;
				if (!persistMovedCode && change.userCode !== change.unit.userCode) {
					const document = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(change.unit.filePath)));
					if (document.getText() !== change.unit.userCode) throw new Error("关联代码在重构准备期间发生变化。");
					documents.push({ document, change });
				}
				const changedProperty = change.propertyDocument !== change.unit.property.document;
				if (persistMovedCode || (change.propertyDocument !== undefined && changedProperty)) {
					const receipt = await this.services.codeDocuments.preparePropertyRefactor(vscode.Uri.file(change.unit.filePath), changedProperty ? change.propertyDocument : undefined, change.userCode, persistMovedCode);
					receipts.push(receipt);
					edit.renameFile(receipt.before, receipt.after, { overwrite: false }, { label: `${path.basename(change.unit.filePath)}：重构${persistMovedCode ? "单元名称及属性" : " XML 属性引用"}`, needsConfirmation: false });
				}
			}
			for (const file of move?.resources?.textFiles ?? []) {
				const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file.filePath));
				if (document.getText() !== file.before) throw new Error("关联资源 XML 在重构准备期间已变化，请按最新状态重试。");
				textDocuments.push({ document, file });
			}
			if (move !== undefined) {
				if (project !== undefined && ((move.mainPaths ?? move.paths).length > 0 || move.resources !== undefined)) {
					const document = await vscode.workspace.openTextDocument(vscode.Uri.file(project.filePath));
					const source = await vscode.workspace.fs.readFile(vscode.Uri.file(project.filePath));
					originalMain = document.getText();
					if (!document.isDirty && originalMain !== await vscode.workspace.decode(source, { encoding: "utf8" })) throw new Error("项目属性发生外部修改，请按最新状态重试。");
					updatedMain = updateProjectMainForRenamedUnits(originalMain, project.filePath, move.mainPaths ?? move.paths);
					const icon = parseProjectProperties(originalMain).icon;
					const nextIcon = icon === undefined ? undefined : move.resources?.names.get(icon);
					if (nextIcon !== undefined) updatedMain = updateProjectProperty(updatedMain ?? originalMain, "icon", nextIcon);
					if (updatedMain !== undefined) {
						mainDocument = document;
					}
				}
				addPathEdit();
			}
			for (const { document, change } of documents) replaceChangedText(edit, document, change.userCode);
			for (const { document, file } of textDocuments) replaceChangedText(edit, document, file.after);
			if (mainDocument !== undefined && updatedMain !== undefined) replaceChangedText(edit, mainDocument, updatedMain);
			for (const unit of snapshots.filter((value) => affected.has(filePathKey(value.filePath)))) await unit.assertUnchanged();
			if (prepareOnly) {
				const prepared: PreparedPathEdit = {
					rollback: rollbackChanges,
					dispose: () => {
						registration.dispose();
						this.preparedRenames.delete(edit);
						disposeUnapplied();
					}
				};
				const registration = vscode.workspace.onDidRenameFiles((event) => {
					if (move === undefined || !pathMoves.every((value) => event.files.some((file) => file.newUri.scheme === (move.native === true ? "file" : pathUri(value.newFile).scheme)
						&& filePathKey(file.oldUri.fsPath) === filePathKey(value.oldFile) && filePathKey(file.newUri.fsPath) === filePathKey(value.newFile)))) return;
					registration.dispose();
					const finish = async (stage: (text: string, synchronizing?: boolean) => void): Promise<void> => {
						const synchronizing = documents.some(({ document, change }) => document.getText() !== change.unit.userCode) || receipts.some((receipt) => receipt.isApplied())
							|| (mainDocument !== undefined && mainDocument.getText() !== originalMain) || textDocuments.some(({ document, file }) => document.getText() !== file.before);
						stage(synchronizing ? "正在更新名称引用…" : "正在刷新项目…", synchronizing);
						try {
							/* VS Code 在真实路径操作前应用已确认的附加编辑；跳过或预览取消不应被当成失败。 */
							for (const { change } of documents) {
								const moved = move.paths.find((value) => filePathKey(value.oldFile) === filePathKey(change.unit.filePath));
								const current = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(moved?.newFile ?? change.unit.filePath)));
								if (current.getText() === change.unit.userCode) continue;
								if (current.getText() !== change.userCode) throw new Error("名称引用未完整应用。");
							}
							if (mainDocument !== undefined && mainDocument.getText() !== originalMain && mainDocument.getText() !== updatedMain) throw new Error("项目 main 未完整应用。");
							for (const { document, file } of textDocuments) {
								if (document.getText() === file.before) continue;
								if (document.getText() !== file.after) throw new Error("关联资源 XML 未完整应用。");
							}
						} catch (error) { await rollbackChanges(error); throw error; }
						finally { prepared.dispose(); }
					};
					if (this.requestedPathEdits.get(pathMovesKey(pathMoves)) === edit) prepared.completion = finish(prepared.stage!);
					else {
						prepared.completion = this.run(finish);
						void prepared.completion.catch((error: unknown) => { void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); });
					}
				});
				this.preparedRenames.set(edit, prepared);
				return edit;
			}
			if (!await vscode.workspace.applyEdit(edit)) throw new Error("VS Code 未能应用此次重构。");
			for (const { change } of documents) {
				const moved = move?.paths.find((value) => filePathKey(value.oldFile) === filePathKey(change.unit.filePath));
				const uri = toSimpleCodeUri(vscode.Uri.file(moved?.newFile ?? change.unit.filePath));
				const document = await vscode.workspace.openTextDocument(uri);
				if (document.getText() !== change.userCode) throw new Error("此次重构的关联代码未完整应用。");
			}
			return edit;
		} catch (error) {
			await rollbackChanges(error);
			throw error;
		}
	}

	private async run(action: (stage: (text: string, synchronizing?: boolean) => void) => Promise<void>): Promise<void> {
		await this.operations.run("项目重构", async () => {
			this.busy = true;
			const batch = this.services.beginSemanticBatch?.();
			let visible = false;
			let label = "正在分析项目引用…";
			let synchronizing = true;
			if (this.timer !== undefined) clearTimeout(this.timer);
			this.timer = setTimeout(() => { visible = true; this.status.text = "$(sync~spin) " + label; this.status.show(); }, 500);
			let completed = false;
			let refreshStarted = false;
			try {
				await action((text, sync = true) => { label = text; synchronizing = sync; if (visible) this.status.text = "$(sync~spin) " + text; });
				label = "正在刷新项目…";
				if (visible) this.status.text = "$(sync~spin) " + label;
				batch?.dispose();
				refreshStarted = true;
				await this.services.refreshProjectSemantics();
				completed = true;
			} catch (error) {
				if (!refreshStarted) {
					batch?.dispose();
					// 失败后仍尝试恢复语言上下文；刷新失败不能盖掉原始事务错误。
					try { await this.services.refreshProjectSemantics(); } catch { /* 保留原始错误供命令入口报告。 */ }
				}
				throw error;
			} finally {
				if (visible) this.status.text = `${completed ? "$(check)" : "$(warning)"} ${synchronizing ? "重构" : "路径修改"}${completed ? "完成" : "失败"}`;
				if (this.timer !== undefined) clearTimeout(this.timer);
				this.timer = setTimeout(() => this.status.hide(), visible ? 1800 : 0);
				this.busy = false;
				this.changeEmitter.fire();
			}
		});
	}

	dispose(): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		for (const registration of this.preparedRenames.values()) registration.dispose();
		this.preparedRenames.clear();
		this.requestedPathEdits.clear();
		this.status.dispose();
		this.changeEmitter.dispose();
	}
}
