/*
在变量声明编辑结束时同步引用，协调输入快照、版本校验和原生撤销，不自动保存代码。
xhwsd@qq.com 2026-10-10
*/

import * as vscode from "vscode";
import { AUTOMATIC_SYNC_SETTINGS, isAutomaticSyncEnabled } from "./automaticSyncSettings";
import { beginDeclarationRename, continueDeclarationRename, declarationNameAtChange, finishesDeclarationRename, planDeclarationRename, type PendingDeclarationRename } from "./declarationRename";
import { filePathKey, mostSpecificSourceRoot } from "./simpleProjectPaths";
import { findProjectForSource } from "./projectCapability";
import { SIMPLE_CODE_SCHEME, toSimpleCodeUri, toSimpleSourceUri, type SimpleCodeFileSystemProvider } from "./simpleCodeFileSystem";
import type { SimpleProjectSemanticContext } from "./simpleUnitSymbols";
import type { SimpleProjectRefactoring } from "./projectRefactoring";
import type { ProgramTreeProvider } from "./programTree";
import type { Sdk } from "./sdk";

export class SimpleDeclarationRenameController implements vscode.Disposable {
	private readonly sources = new Map<vscode.TextDocument, string>();
	private readonly pending = new Map<vscode.TextDocument, PendingDeclarationRename>();
	private readonly attempted = new Map<vscode.TextDocument, number>();
	private readonly deferred = new Set<vscode.TextDocument>();
	private readonly listeners: vscode.Disposable[] = [];
	private readonly applying = new Set<vscode.TextDocument>();
	private readonly issues = vscode.languages.createDiagnosticCollection("ES4A 自动重构");
	private sequence = Promise.resolve();
	private lastEditor = vscode.window.activeTextEditor;
	private disposed = false;

	constructor(
		private readonly programs: ProgramTreeProvider,
		private readonly refactoring: SimpleProjectRefactoring,
		private readonly documents: SimpleCodeFileSystemProvider,
		private readonly getSdk: () => Sdk | undefined,
		private readonly readContext: (document: vscode.TextDocument, source: string) => SimpleProjectSemanticContext | undefined,
		private readonly reportError: (message: string) => void
	) {
		for (const document of vscode.workspace.textDocuments) this.track(document);
		this.listeners.push(
			// 项目操作占用事务时保留声明改名，结束后重试，不能静默丢掉一次提交信号。
			this.refactoring.onDidComplete(() => {
				const deferred = [...this.deferred];
				this.deferred.clear();
				for (const document of deferred) this.schedule(document);
			}),
			vscode.workspace.onDidChangeConfiguration((event) => {
				// 关闭时清除待提交编辑和警告；重新开启不能补做此前的改名。
				for (const document of this.sources.keys()) if (event.affectsConfiguration("es4a." + AUTOMATIC_SYNC_SETTINGS.variable, toSimpleSourceUri(document.uri)) && !isAutomaticSyncEnabled("variable", document.uri)) this.clear(document);
			}),
			vscode.workspace.onDidOpenTextDocument((document) => this.track(document)),
			vscode.workspace.onDidCloseTextDocument((document) => { this.sources.delete(document); this.clear(document); }),
			vscode.workspace.onDidChangeTextDocument((event) => this.changed(event)),
			vscode.window.onDidChangeTextEditorSelection((event) => {
				const pending = this.pending.get(event.textEditor.document);
				if (pending === undefined || event.selections.length !== 1) return;
				const line = event.textEditor.document.positionAt(pending.start).line;
				if (event.selections[0]!.active.line !== line) this.schedule(event.textEditor.document);
			}),
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				const previous = this.lastEditor;
				this.lastEditor = editor;
				if (previous !== undefined && previous.document !== editor?.document) this.schedule(previous.document);
			}),
			vscode.window.onDidChangeWindowState((state) => { if (!state.focused) this.focusLost(); }),
			vscode.workspace.onWillSaveTextDocument((event) => {
				if (event.reason === vscode.TextDocumentSaveReason.Manual && this.pending.has(event.document)) event.waitUntil(this.flush(event.document).then(() => []));
			})
		);
	}

	private track(document: vscode.TextDocument): void {
		if (document.uri.scheme === SIMPLE_CODE_SCHEME) this.sources.set(document, document.getText());
	}

	private clear(document: vscode.TextDocument): void {
		this.pending.delete(document);
		this.deferred.delete(document);
		this.attempted.delete(document);
		this.issues.delete(document.uri);
	}

	private changed(event: vscode.TextDocumentChangeEvent): void {
		const document = event.document;
		const previous = this.sources.get(document);
		if (previous === undefined) return;
		const source = document.getText();
		this.sources.set(document, source);
		if (event.contentChanges.length === 0) return;
		if (!isAutomaticSyncEnabled("variable", document.uri)) { this.clear(document); return; }
		if (this.applying.has(document) || event.reason !== undefined || event.contentChanges.length !== 1 || vscode.window.activeTextEditor?.document !== document || vscode.window.activeTextEditor.selections.length !== 1) { this.clear(document); return; }
		const change = event.contentChanges[0]!;
		const pending = this.pending.get(document);
		if (pending !== undefined && finishesDeclarationRename(previous, change, pending)) { this.schedule(document); return; }
		if (pending === undefined && declarationNameAtChange(previous, change) === undefined) { this.clear(document); return; }
		const context = pending === undefined ? this.readContext(document, previous) : undefined;
		const next = pending === undefined
			? context === undefined ? undefined : beginDeclarationRename(previous, change, this.getSdk(), context)
			: continueDeclarationRename(previous, change, pending);
		this.clear(document);
		if (next !== undefined) this.pending.set(document, next);
	}

	/** 供实际拥有焦点事件的 ES4A 视图通知；不把普通可见性变化当成失焦。 */
	focusLost(): void {
		for (const document of this.pending.keys()) this.schedule(document);
	}

	private schedule(document: vscode.TextDocument): void { void this.flush(document); }

	/** 排队并在执行前重读版本，过期分析不能覆盖后续输入。 */
	flush(document: vscode.TextDocument): Promise<void> {
		this.sequence = this.sequence.then(() => this.synchronize(document)).catch((error: unknown) => this.reportError(`变量自动重构失败：${String(error)}`));
		return this.sequence;
	}

	private async synchronize(document: vscode.TextDocument): Promise<void> {
		if (!isAutomaticSyncEnabled("variable", document.uri)) { this.clear(document); return; }
		const pending = this.pending.get(document);
		if (this.disposed || document.isClosed || pending === undefined || this.attempted.get(document) === document.version) return;
		if (this.refactoring.isBusy) { this.deferred.add(document); return; }
		if (pending.oldName === pending.newName) { this.clear(document); return; }
		const version = document.version;
		const valid = (): boolean => {
			if (this.disposed || document.isClosed || document.version !== version || this.pending.get(document) !== pending || !isAutomaticSyncEnabled("variable", document.uri)) return false;
			if (this.refactoring.isBusy) { this.deferred.add(document); return false; }
			return true;
		};
		let progress: vscode.Disposable | undefined;
		const timer = setTimeout(() => { if (valid()) progress = vscode.window.setStatusBarMessage("正在重构变量引用…"); }, 500);
		try {
			const source = toSimpleSourceUri(document.uri);
			if (source === undefined) return;
			const project = findProjectForSource(await this.programs.getProjects(), source.fsPath);
			if (project === undefined || !valid()) return;
			const units = pending.local
				? [await this.documents.readRefactoringUnit(source, mostSpecificSourceRoot(project.sourceDirectories, source.fsPath)!)]
				: await this.refactoring.readProject(project);
			if (!valid()) return;
			const origin = units.find((unit) => filePathKey(unit.filePath) === filePathKey(source.fsPath));
			if (origin === undefined) return;
			const plans = planDeclarationRename(units, origin, pending, this.getSdk());
			const targets = await Promise.all(plans.map(async (plan) => ({ plan, document: await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(plan.unit.filePath))) })));
			if (!valid()) return;
			for (const unit of units.filter((unit) => unit === origin || plans.some((plan) => plan.unit === unit))) await unit.assertUnchanged();
			if (!valid()) return;
			for (const target of targets) if (target.document.getText() !== target.plan.unit.userCode) throw new Error("关联代码已变化，未应用此次重构。");
			if (targets.length === 0) { this.clear(document); return; }
			for (const target of targets) this.applying.add(target.document);
			try {
				const editor = vscode.window.visibleTextEditors.find((value) => value.document === document);
				let applied: boolean;
				if (targets.length === 1 && targets[0]!.document === document && editor !== undefined) {
					// 同文档尽量合并到刚结束的名称输入；跨文档由原生工作区事务保留撤销。
					applied = await editor.edit((builder) => { for (const edit of targets[0]!.plan.edits) builder.replace(new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)), edit.replacement); }, { undoStopBefore: false, undoStopAfter: true });
				} else {
					const edit = new vscode.WorkspaceEdit();
					for (const target of targets) for (const change of target.plan.edits) edit.replace(target.document.uri, new vscode.Range(target.document.positionAt(change.start), target.document.positionAt(change.end)), change.replacement);
					applied = await vscode.workspace.applyEdit(edit);
				}
				if (!applied) throw new Error("未能应用此次重构。");
				this.clear(document);
			} finally { for (const target of targets) this.applying.delete(target.document); }
		} catch (error: unknown) {
			if (!valid()) return;
			this.attempted.set(document, version);
			const message = error instanceof Error ? error.message : String(error);
			const issue = new vscode.Diagnostic(new vscode.Range(document.positionAt(pending.start), document.positionAt(pending.start + pending.newName.length)), `变量重构未完成：${message}`, vscode.DiagnosticSeverity.Warning);
			issue.source = "ES4A 自动重构";
			this.issues.set(document.uri, [issue]);
			this.reportError(issue.message);
		} finally { clearTimeout(timer); progress?.dispose(); }
	}

	dispose(): void {
		this.disposed = true;
		for (const listener of this.listeners) listener.dispose();
		this.sources.clear(); this.pending.clear(); this.deferred.clear(); this.attempted.clear(); this.issues.dispose();
	}
}
