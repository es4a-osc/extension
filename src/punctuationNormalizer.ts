/*
监听 Simple 编辑器变化，并应用代码区域的中文符号半角化替换。
xhwsd@qq.com 2026-8-27
*/

import * as vscode from "vscode";
import { findSimplePunctuationReplacements } from "./punctuationNormalizerModel";

/** 监听 Simple 编辑器变化，并把代码区域新输入的中文符号合并进当前撤销步骤。 */
export class SimplePunctuationNormalizer implements vscode.Disposable {
	private readonly applying = new Set<string>();
	private readonly sources = new Map<string, string>();

	/** 以当前打开文档建立初始快照，避免首次输入缺少旧文本坐标。 */
	constructor(documents: readonly vscode.TextDocument[] = vscode.workspace.textDocuments) {
		for (const document of documents) {
			this.trackDocument(document);
		}
	}

	/** 记录新打开 Simple 文档的当前内容，供下一次增量变化还原旧文档坐标。 */
	trackDocument(document: vscode.TextDocument): void {
		if (document.languageId === "simple") {
			this.sources.set(document.uri.toString(), document.getText());
		}
	}

	/** 停止跟踪已关闭文档。 */
	forgetDocument(document: vscode.TextDocument): void {
		const key = document.uri.toString();
		this.sources.delete(key);
		this.applying.delete(key);
	}

	/** 处理一次活动编辑器输入；撤销、重做和非活动文档变化只更新文本快照。 */
	async normalize(event: vscode.TextDocumentChangeEvent): Promise<void> {
		const document = event.document;
		if (document.languageId !== "simple") {
			return;
		}

		const key = document.uri.toString();
		const currentSource = document.getText();
		const previousSource = this.sources.get(key);
		this.sources.set(key, currentSource);

		if (
			previousSource === undefined
			|| this.applying.has(key)
			|| event.contentChanges.length === 0
			|| event.reason === vscode.TextDocumentChangeReason.Undo
			|| event.reason === vscode.TextDocumentChangeReason.Redo
		) {
			return;
		}

		const editor = vscode.window.visibleTextEditors.find(
			(candidate) => candidate.document === document
		);
		if (editor === undefined) {
			return;
		}

		const result = findSimplePunctuationReplacements(
			previousSource,
			event.contentChanges.map((change) => ({
				content: change.text,
				rangeLength: change.rangeLength,
				rangeOffset: change.rangeOffset
			}))
		);
		if (result === undefined || result.source !== currentSource || result.replacements.length === 0) {
			return;
		}

		this.applying.add(key);
		try {
			const applied = await editor.edit((edit) => {
				for (const replacement of result.replacements) {
					edit.replace(
						new vscode.Range(
							document.positionAt(replacement.start),
							document.positionAt(replacement.end)
						),
						replacement.text
					);
				}
			}, { undoStopAfter: false, undoStopBefore: false });

			if (applied && vscode.window.activeTextEditor?.document === document) {
				await vscode.commands.executeCommand("hideSuggestWidget");
			}
		} finally {
			this.applying.delete(key);
		}
	}

	/** 清空文档快照和内部应用标记。 */
	dispose(): void {
		this.applying.clear();
		this.sources.clear();
	}
}
