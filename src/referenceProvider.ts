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
import { createSimpleSourcePositionIndex } from "./simpleSourcePositions";
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
		const positions = new Map<string, { readonly uri: vscode.Uri; readonly at: ReturnType<typeof createSimpleSourcePositionIndex> }>();
		for (const { unit, span } of references) {
			if (cancelled()) return [];
			if (!options.includeDeclaration && target?.targetOffset === span.start && target.filePath !== undefined && filePathKey(target.filePath) === filePathKey(unit.filePath)) continue;
			const key = filePathKey(unit.filePath);
			let location = positions.get(key);
			if (location === undefined) {
				location = { uri: toSimpleCodeUri(vscode.Uri.file(unit.filePath)), at: createSimpleSourcePositionIndex(unit.userCode) };
				positions.set(key, location);
			}
			const start = location.at(span.start);
			const end = location.at(span.end);
			result.push(new vscode.Location(location.uri, new vscode.Range(start.line, start.character, end.line, end.character)));
		}
		if (result.length === 0) return result;
		// 直接校验查询快照。提前打开命中文档会触发恢复和诊断，还会改变文档会话。
		const used = snapshot.units.filter((unit) => unit === snapshot.current || positions.has(filePathKey(unit.filePath)));
		try {
			for (const unit of used) {
				if (cancelled()) return [];
				await unit.assertUnchanged();
			}
			for (const unit of used) unit.assertCurrent();
		} catch {
			return [];
		}
		return cancelled() ? [] : result;
	}
}
