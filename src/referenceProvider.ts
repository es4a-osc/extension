/*
将项目语义引用分析接入 VS Code 的查找引用，不修改代码或属性状态。
xhwsd@qq.com 2026-10-10
*/

import * as vscode from "vscode";
import { findSimpleDefinition } from "./definitionModel";
import { findSimpleProjectReferences, refactoringContext } from "./refactoringModel";
import { findProjectForSource } from "./projectCapability";
import type { SimpleProjectRefactoring } from "./projectRefactoring";
import type { ProgramTreeProvider } from "./programTree";
import type { Sdk } from "./sdk";
import { filePathKey } from "./simpleProjectPaths";
import { toSimpleCodeUri, toSimpleSourceUri } from "./simpleCodeFileSystem";

export class SimpleReferenceProvider implements vscode.ReferenceProvider {
	constructor(
		private readonly programs: ProgramTreeProvider,
		private readonly refactoring: SimpleProjectRefactoring,
		private readonly getSdk: () => Sdk | undefined
	) {}

	private async snapshot(document: vscode.TextDocument, cancelled: () => boolean) {
		const source = toSimpleSourceUri(document.uri);
		if (source === undefined || cancelled()) return undefined;
		const project = findProjectForSource(await this.programs.getProjects(), source.fsPath);
		if (project === undefined || cancelled()) return undefined;
		const units = await this.refactoring.readProject(project);
		const current = units.find((unit) => filePathKey(unit.filePath) === filePathKey(source.fsPath));
		return current === undefined || cancelled() || current.userCode !== document.getText() ? undefined : { units, current };
	}

	async provideReferences(document: vscode.TextDocument, position: vscode.Position, options: vscode.ReferenceContext, token: vscode.CancellationToken): Promise<vscode.Location[]> {
		const version = document.version;
		const offset = document.offsetAt(position);
		const cancelled = (): boolean => token.isCancellationRequested || this.refactoring.isBusy || document.isClosed || document.version !== version;
		const snapshot = await this.snapshot(document, cancelled);
		if (snapshot === undefined) return [];
		const sdk = this.getSdk();
		const references = findSimpleProjectReferences(snapshot.units, snapshot.current, offset, sdk);
		const target = findSimpleDefinition(snapshot.current.userCode, offset, sdk, refactoringContext(snapshot.current, snapshot.units));
		const result: vscode.Location[] = [];
		const documents = new Map<string, { readonly document: vscode.TextDocument; readonly source: string }>();
		for (const { unit, span } of references) {
			if (cancelled()) return [];
			if (!options.includeDeclaration && target?.targetOffset === span.start && target.filePath !== undefined && filePathKey(target.filePath) === filePathKey(unit.filePath)) continue;
			const key = filePathKey(unit.filePath);
			let referenced = documents.get(key)?.document;
			if (referenced === undefined) {
				referenced = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(unit.filePath)));
				if (cancelled() || referenced.getText() !== unit.userCode) return [];
				documents.set(key, { document: referenced, source: unit.userCode });
			}
			result.push(new vscode.Location(referenced.uri, new vscode.Range(referenced.positionAt(span.start), referenced.positionAt(span.end))));
		}
		// 打开后续单元期间，先前读取的文档仍可能被编辑，不能返回旧偏移构造的位置。
		return cancelled() || [...documents.values()].some((entry) => entry.document.isClosed || entry.document.getText() !== entry.source) ? [] : result;
	}
}
