/*
从 VS Code 文档和编辑器选项解析 Simple 属性代码的写出格式。
xhwsd@qq.com 2026-8-29
*/

import * as vscode from "vscode";
import type { SimplePropertySourceFormatting } from "./propertyXml";

/** 没有用户代码文档或编辑器时使用的属性代码格式。 */
const DEFAULT_PROPERTY_SOURCE_FORMATTING: SimplePropertySourceFormatting = {
	indentation: "\t",
	lineEnding: "\r\n"
};

/** 从用户代码文档及其编辑器读取属性代码写出格式。 */
export function resolvePropertySourceFormatting(
	document: vscode.TextDocument | undefined,
	editors: readonly vscode.TextEditor[] = vscode.window.visibleTextEditors
): SimplePropertySourceFormatting {
	if (document === undefined) {
		return DEFAULT_PROPERTY_SOURCE_FORMATTING;
	}

	const editor = editors.find((candidate) => candidate.document === document);
	const indentSize = editor?.options.indentSize;
	const tabSize = editor?.options.tabSize;
	const indentationSize = typeof indentSize === "number"
		? indentSize
		: typeof tabSize === "number" ? tabSize : 4;

	return {
		indentation: editor?.options.insertSpaces === true
			? " ".repeat(indentationSize)
			: DEFAULT_PROPERTY_SOURCE_FORMATTING.indentation,
		lineEnding: document.eol === vscode.EndOfLine.LF ? "\n" : "\r\n"
	};
}
