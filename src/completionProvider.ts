/*
将作用域感知的 Simple 首拼候选适配为 VS Code 补全项。
xhwsd@qq.com 2026-8-27
*/

import * as vscode from "vscode";
import { provideSimpleCompletions, type SimpleCompletionKind } from "./completionModel";
import { markdownDocumentationForDisplay } from "./markdownDocumentation";
import type { Sdk } from "./sdk";
import type { SimpleProjectSemanticContext } from "./simpleUnitSymbols";

/** 首拼输入必须主动触发语言补全，不能依赖用户是否启用 VS Code 快速建议。 */
export const SIMPLE_COMPLETION_TRIGGER_CHARACTERS = [
	".",
	..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
] as const;

/** 将编辑器中立补全类型映射为 VS Code 图标类型。 */
function completionItemKind(kind: SimpleCompletionKind): vscode.CompletionItemKind {
	switch (kind) {
		case "constant":
			return vscode.CompletionItemKind.Constant;
		case "event":
			return vscode.CompletionItemKind.Event;
		case "function":
			return vscode.CompletionItemKind.Function;
		case "keyword":
			return vscode.CompletionItemKind.Keyword;
		case "property":
			return vscode.CompletionItemKind.Property;
		case "reference":
			return vscode.CompletionItemKind.Reference;
		case "type":
			return vscode.CompletionItemKind.Class;
		case "variable":
			return vscode.CompletionItemKind.Variable;
	}
}

/** 为 Simple 文档提供中文名称、拼音首字母和项目 R 资源补全。 */
export class SimpleCompletionProvider implements vscode.CompletionItemProvider {
	private sdk: Sdk | undefined;

	/** 注入可替换的文档读取与项目语义上下文，便于共享同一文档模型。 */
	constructor(
		private readonly readSource: (document: vscode.TextDocument) => string = (document) => document.getText(),
		private readonly readContext: (
			document: vscode.TextDocument,
			source: string
		) => SimpleProjectSemanticContext | undefined = () => undefined
	) {}

	/** 更新补全使用的 SDK 快照。 */
	updateSdk(sdk: Sdk | undefined): void {
		this.sdk = sdk;
	}

	/** 根据光标语境返回已经过作用域和类型约束的补全项。 */
	provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position
	): vscode.CompletionList {
		const source = this.readSource(document);
		const result = provideSimpleCompletions(
			source,
			document.offsetAt(position),
			this.sdk,
			this.readContext(document, source)
		);
		if (result === undefined) {
			return new vscode.CompletionList([], false);
		}
		const callParenthesisFollows = /^[ \t]*\(/u.test(source.slice(result.end));

		const range = new vscode.Range(document.positionAt(result.start), document.positionAt(result.end));
		const items = result.candidates.map((candidate, index) => {
			const item = new vscode.CompletionItem(candidate.name, completionItemKind(candidate.kind));
			item.detail = candidate.detail;
			item.documentation = candidate.description === undefined
				? undefined
				: new vscode.MarkdownString(markdownDocumentationForDisplay(candidate.description));
			item.filterText = /[\u3400-\u9fff]/u.test(result.query) ? candidate.name : candidate.initials;
			item.insertText = candidate.snippet === undefined || callParenthesisFollows
				? candidate.name
				: new vscode.SnippetString(candidate.snippet);
			item.range = range;
			item.sortText = `${candidate.priority.toString().padStart(2, "0")}:${index.toString().padStart(4, "0")}`;
			return item;
		});

		return new vscode.CompletionList(items, false);
	}
}
