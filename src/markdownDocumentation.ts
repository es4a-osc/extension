/*
统一规范化 Markdown 文档，并为不支持 Markdown 的界面生成保留换行的纯文本。
xhwsd@qq.com 2026-9-5
*/

/** 统一换行并移除文档首尾没有显示意义的空行，不破坏 Markdown 内部缩进。 */
export function normalizeMarkdownDocumentation(value: string): string {
	const lines = value.replace(/\r\n?|\n/gu, "\n").split("\n");
	while (lines.length > 0 && /^[ \t]*$/u.test(lines[0] ?? "")) {
		lines.shift();
	}
	while (lines.length > 0 && /^[ \t]*$/u.test(lines.at(-1) ?? "")) {
		lines.pop();
	}
	return lines.join("\n");
}

/**
 * 生成供 VS Code Markdown 控件显示的文档，保留作者写下的每个物理换行。
 *
 * Markdown 普通段落会把单个换行折叠为空格，因此在非空普通行末补硬换行；
 * 围栏代码块自身保留换行，不额外写入空格。
 */
export function markdownDocumentationForDisplay(value: string): string {
	const lines = normalizeMarkdownDocumentation(value).split("\n");
	let fence: "`" | "~" | undefined;
	return lines.map((line, index) => {
		const fenceMatch = /^[ \t]{0,3}(`{3,}|~{3,})/u.exec(line);
		const marker = fenceMatch?.[1]?.[0];
		const insideFence = fence !== undefined;
		if (marker === "`" || marker === "~") {
			if (fence === undefined) {
				fence = marker;
			} else if (fence === marker) {
				fence = undefined;
			}
		}
		if (index === lines.length - 1 || line.length === 0 || insideFence || marker !== undefined) {
			return line;
		}
		return /(?: {2}|\\)$/u.test(line) ? line : `${line}  `;
	}).join("\n");
}

/** 去除一行中的常用 Markdown 行内标记，保留可读文字。 */
function inlineMarkdownToPlainText(value: string): string {
	return value
		.replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
		.replace(/\[([^\]]+)\]\[[^\]]*\]/gu, "$1")
		.replace(/<((?:https?:\/\/|mailto:)[^>]+)>/gu, "$1")
		.replace(/`+([^`]*?)`+/gu, "$1")
		.replace(/(?<![\p{L}\p{N}_])\*\*([^*\n]+)\*\*(?![\p{L}\p{N}_])/gu, "$1")
		.replace(/(?<![\p{L}\p{N}_])__([^_\n]+)__(?![\p{L}\p{N}_])/gu, "$1")
		.replace(/~~([^~]+)~~/gu, "$1")
		.replace(/(?<![\p{L}\p{N}_])\*([^*\n]+)\*(?![\p{L}\p{N}_])/gu, "$1")
		.replace(/(?<![\p{L}\p{N}_])_([^_\n]+)_(?![\p{L}\p{N}_])/gu, "$1")
		.replace(/<\/?[A-Za-z][^>]*>/gu, "")
		.replace(/\\([\\`*{}\[\]()#+\-.!_>])/gu, "$1")
		.replace(/[ \t]+$/gu, "");
}

/**
 * 将 Markdown 文档转换为原生 title、任务详情等界面可显示的纯文本。
 *
 * 保留段落、列表和代码的物理换行；列表标记转换为普通项目符号，围栏本身不显示。
 */
export function markdownDocumentationToPlainText(value: string): string {
	const markdown = normalizeMarkdownDocumentation(value);
	if (markdown.length === 0) {
		return "";
	}

	let fence: "`" | "~" | undefined;
	return markdown.split("\n").map((sourceLine) => {
		const fenceMatch = /^[ \t]{0,3}(`{3,}|~{3,})/u.exec(sourceLine);
		if (fenceMatch !== null) {
			const marker = fenceMatch[1]?.[0];
			if (marker === "`" || marker === "~") {
				if (fence === undefined) {
					fence = marker;
					return "";
				}
				if (fence === marker) {
					fence = undefined;
					return "";
				}
			}
		}
		if (fence !== undefined) {
			return sourceLine.replace(/[ \t]+$/gu, "");
		}

		let line = sourceLine
			.replace(/^[ \t]{0,3}#{1,6}(?:[ \t]+|$)/u, "")
			.replace(/[ \t]+#{1,6}[ \t]*$/u, "")
			.replace(/^[ \t]{0,3}(?:>[ \t]?)+/u, "")
			.replace(/^([ \t]*)[-+*][ \t]+\[([ xX])\][ \t]+/u, (_match, indentation: string, checked: string) => (
				`${indentation}${checked === " " ? "☐" : "☑"} `
			))
			.replace(/^([ \t]*)[-+*][ \t]+/u, "$1• ");
		if (/^[ \t]{0,3}(?:={3,}|-{3,})[ \t]*$/u.test(line)) {
			line = "";
		}
		return inlineMarkdownToPlainText(line);
	}).join("\n");
}
