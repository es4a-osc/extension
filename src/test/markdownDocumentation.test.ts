/*
验证 Markdown 文档规范化、文档注释保真和纯文本降级规则。
xhwsd@qq.com 2026-9-5
*/

import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
	markdownDocumentationForDisplay,
	markdownDocumentationToPlainText,
	normalizeMarkdownDocumentation
} from "../markdownDocumentation";
import { findAdjacentSimpleDocumentationComment } from "../simpleDocumentation";

test("Markdown 文档规范化换行但保留内部缩进和硬换行", () => {
	assert.equal(
		normalizeMarkdownDocumentation("\r\n**说明**  \r\n  - 子项\r\n\r\n"),
		"**说明**  \n  - 子项"
	);
});

test("Markdown 显示文本把普通物理换行转换为可见硬换行", () => {
	assert.equal(
		markdownDocumentationForDisplay("**第一行**\n第二行\n第三行"),
		"**第一行**  \n第二行  \n第三行"
	);
});

test("Markdown 转纯文本时移除格式并保留物理换行", () => {
	assert.equal(
		markdownDocumentationToPlainText("# 标题\r\n\r\n**第一行**\r\n- `第二行`\r\n> [第三行](https://example.com)"),
		"标题\n\n第一行\n• 第二行\n第三行"
	);
	assert.equal(markdownDocumentationToPlainText("成_主窗口 和 simple.runtime_1"), "成_主窗口 和 simple.runtime_1");
});

test("Simple 文档注释保留 Markdown 所需的缩进和行尾空格", () => {
	const source = [
		"''' **说明**  ",
		"'''   - 子项",
		"变量 value 为 整数型"
	].join("\n");
	assert.equal(
		findAdjacentSimpleDocumentationComment(source, source.indexOf("变量")),
		"**说明**  \n  - 子项"
	);
});
