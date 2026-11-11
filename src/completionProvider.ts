/*
将作用域感知的 Simple 首拼候选适配为 VS Code 补全项。
xhwsd@qq.com 2026-8-27
*/

import * as vscode from "vscode";
import { pinyinInitials, provideSimpleCompletions, type SimpleCompletionKind } from "./completionModel";
import { markdownDocumentationForDisplay } from "./markdownDocumentation";
import { simpleIdentifierRange, skipSimpleContinuationWhitespace } from "./simpleSourceLexical";
import { getVisibleSimpleUnitUserCode } from "./simpleUnitSource";
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
		position: vscode.Position,
		_token?: vscode.CancellationToken,
		context?: vscode.CompletionContext
	): vscode.CompletionList {
		const source = this.readSource(document);
		const userCode = getVisibleSimpleUnitUserCode(source);
		const offset = document.offsetAt(position);
		/* 原生文件包含属性区；只补全用户代码，属性仍交由统一模型处理。 */
		if (userCode.length < source.length && offset >= userCode.length) {
			return new vscode.CompletionList([], false);
		}

		const result = provideSimpleCompletions(
			userCode,
			offset,
			this.sdk,
			this.readContext(document, source)
		);
		if (result === undefined) {
			return new vscode.CompletionList([], false);
		}
		/* 候选仍按光标前缀匹配，接受时替换完整标识符，保留点号和调用实参。 */
		const replacementEnd = simpleIdentifierRange(userCode, result.end)?.end ?? result.end;

		/* 已有名称内部主动补全只按原文前缀匹配，普通输入和词尾补全沿用原规则。 */
		const literalPrefix = replacementEnd > offset
			&& (context?.triggerKind ?? vscode.CompletionTriggerKind.Invoke) === vscode.CompletionTriggerKind.Invoke;
		const candidates = literalPrefix
			? result.candidates.filter((candidate) => candidate.name.startsWith(result.query))
			: result.candidates;

		const callParenthesisFollows = userCode[skipSimpleContinuationWhitespace(userCode, replacementEnd)] === "(";
		const normalizedQuery = pinyinInitials(result.query);

		const range = new vscode.Range(document.positionAt(result.start), document.positionAt(replacementEnd));
		const items = candidates.map((candidate, index) => {
			const item = new vscode.CompletionItem(candidate.name, completionItemKind(candidate.kind));
			item.detail = candidate.detail;
			item.documentation = candidate.description === undefined
				? undefined
				: new vscode.MarkdownString(markdownDocumentationForDisplay(candidate.description));
			// VS Code 仍按原输入过滤；混合首拼候选必须保留已输入文本，避免被编辑器再次排除。
			item.filterText = candidate.name.startsWith(result.query)
				? candidate.name
				: result.query + candidate.initials.slice(normalizedQuery.length);
			item.insertText = candidate.snippet === undefined || callParenthesisFollows
				? candidate.name
				: new vscode.SnippetString(candidate.snippet);
			item.range = range;
			item.sortText = `${candidate.priority.toString().padStart(2, "0")}:${index.toString().padStart(4, "0")}`;
			return item;
		});

		// 后续中文输入也需要重新计算，不能沿用只包含上一次首拼的过滤文本。
		return new vscode.CompletionList(items, true);
	}
}
