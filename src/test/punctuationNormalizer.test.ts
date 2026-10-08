/*
验证 Simple 代码输入符号规范化只影响字符串和注释之外的新输入内容。
xhwsd@qq.com 2026-8-27
*/

import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
	findSimplePunctuationReplacements,
	type SimpleTextChange
} from "../punctuationNormalizerModel";

/** 将纯文本变化应用后再执行规范化替换。 */
function normalize(previousSource: string, changes: readonly SimpleTextChange[]): string {
	const result = findSimplePunctuationReplacements(previousSource, changes);
	assert.ok(result);
	let source = result.source;

	for (const replacement of [...result.replacements].reverse()) {
		source = source.slice(0, replacement.start) + replacement.text + source.slice(replacement.end);
	}

	return source;
}

test("把代码区域新输入的常见中文符号转换为英文符号", () => {
	assert.equal(normalize("", [{
		content: "函数 测试（值 为 整数型）：值＝值＋1；",
		rangeLength: 0,
		rangeOffset: 0
	}]), "函数 测试(值 为 整数型):值=值+1；");
});

test("一次粘贴时保留字符串和单引号注释中的中文符号", () => {
	const content = [
		"变量 文本 为 文本型 = \"中文，。；：？！\"",
		"' 注释（中文），不转换。",
		"函数 测试（）"
	].join("\r\n");

	assert.equal(normalize("", [{
		content,
		rangeLength: 0,
		rangeOffset: 0
	}]), [
		"变量 文本 为 文本型 = \"中文，。；：？！\"",
		"' 注释（中文），不转换。",
		"函数 测试()"
	].join("\r\n"));
});

test("在已有字符串和注释中输入中文符号时保持原样", () => {
	assert.equal(normalize("\"文本\"", [{
		content: "，",
		rangeLength: 0,
		rangeOffset: 3
	}]), "\"文本，\"");
	assert.equal(normalize("' 注释", [{
		content: "。",
		rangeLength: 0,
		rangeOffset: 4
	}]), "' 注释。");
});

test("多光标输入按变化后的准确位置分别转换", () => {
	assert.equal(normalize("测试\r\n调用", [
		{ content: "（", rangeLength: 0, rangeOffset: 2 },
		{ content: "）", rangeLength: 0, rangeOffset: 6 }
	]), "测试(\r\n调用)");
});

test("替换已有选择区时只检查新输入内容", () => {
	assert.equal(normalize("测试（旧值）", [{
		content: "（新值）",
		rangeLength: 4,
		rangeOffset: 2
	}]), "测试(新值)");
});

test("粘贴内容包含 UTF-16 代理对时仍保持符号位置准确", () => {
	assert.equal(normalize("", [{
		content: "😀测试（）",
		rangeLength: 0,
		rangeOffset: 0
	}]), "😀测试()");
});

test("只转换 Simple 语法符号并保留其它中文标点", () => {
	assert.equal(normalize("", [{
		content: "｛值【索引】；？！＠＃％｜～·｝",
		rangeLength: 0,
		rangeOffset: 0
	}]), "｛值【索引】；？！＠＃％｜～·｝");
});

test("中文双引号只转换字符串边界并保留内部标点", () => {
	assert.equal(normalize("", [{
		content: "变量 文本 为 文本型 = “中文，。；？！”",
		rangeLength: 0,
		rangeOffset: 0
	}]), "变量 文本 为 文本型 = \"中文，。；？！\"");
});

test("中文输入法的成对省略号和破折号映射为单个语法符号", () => {
	assert.equal(normalize("", [{
		content: "值……2——\r\n",
		rangeLength: 0,
		rangeOffset: 0
	}]), "值^2_\r\n");
	assert.equal(normalize("", [{
		content: "值…—",
		rangeLength: 0,
		rangeOffset: 0
	}]), "值…—");
});

test("成对中文单引号在代码区合并为一个注释起始符", () => {
	assert.equal(normalize("", [{
		content: "‘’ 这是注释（内容不转换）",
		rangeLength: 0,
		rangeOffset: 0
	}]), "' 这是注释（内容不转换）");
});
