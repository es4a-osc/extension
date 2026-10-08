/*
验证 Simple 三单引号文档注释与普通注释、许可证和连续说明的边界。
xhwsd@qq.com 2026-9-2
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import {
	findAdjacentSimpleDocumentationComment,
	findSimpleUnitComment
} from "../simpleDocumentation";
import { simpleTestProjectPath } from "./testProjects";

/** 返回指定声明在测试源码中的起始位置。 */
function declarationOffset(source: string, declaration: string): number {
	const offset = source.indexOf(declaration);
	assert.notEqual(offset, -1);
	return offset;
}

test("声明文档注释支持三单引号连续多行和不同换行格式", () => {
	for (const eol of ["\r\n", "\n", "\r"]) {
		const source = [
			"''' 计算指定输入。",
			"'''",
			"''' 输入无效时返回空值。",
			"函数 Calculate() 为 对象",
			"结束 函数"
		].join(eol);

		assert.equal(
			findAdjacentSimpleDocumentationComment(source, declarationOffset(source, "函数 Calculate")),
			"计算指定输入。\n\n输入无效时返回空值。"
		);
	}
});

test("普通代码段和分隔注释永远不构成声明文档", () => {
	const section = [
		"' ----------------",
		"' Constant definitions",
		"' ----------------",
		"' 棋盘背景色。",
		"常量 A 为 整数型"
	].join("\n");
	assert.equal(
		findAdjacentSimpleDocumentationComment(section, declarationOffset(section, "常量 A")),
		undefined
	);

	const described = [
		"' - - - -",
		"' Constant definitions",
		"' - - - -",
		"''' 棋盘背景色。",
		"常量 A 为 整数型"
	].join("\n");
	assert.equal(
		findAdjacentSimpleDocumentationComment(described, declarationOffset(described, "常量 A")),
		"棋盘背景色。"
	);

	const interrupted = [
		"''' 不应跨过普通注释。",
		"' 初始化常量",
		"常量 A 为 整数型"
	].join("\n");
	assert.equal(
		findAdjacentSimpleDocumentationComment(interrupted, declarationOffset(interrupted, "常量 A")),
		undefined
	);
});

test("单元文档注释支持独立的三单引号多行块", () => {
	const documented = [
		"' Copyright 2009 Example",
		"' Licensed under the Apache License.",
		"",
		"''' 俄罗斯方块主窗口。",
		"''' 提供游戏入口。",
		"",
		"过程 Run()",
		"结束 过程"
	].join("\r\n");
	assert.equal(findSimpleUnitComment(documented), "俄罗斯方块主窗口。\n提供游戏入口。");

	const declarationDocumentation = [
		"''' Run 过程说明。",
		"过程 Run()",
		"结束 过程"
	].join("\n");
	assert.equal(findSimpleUnitComment(declarationDocumentation), undefined);
});

test("真实 Tetris 普通许可证、代码段和声明说明均不构成文档注释", () => {
	const filePath = simpleTestProjectPath("Tetris", "src", "simple", "samples", "tetris", "Tetris.simple");
	const source = fs.readFileSync(filePath, "utf8");

	assert.equal(findSimpleUnitComment(source), undefined);
	assert.equal(
		findAdjacentSimpleDocumentationComment(
			source,
			declarationOffset(source, "常量 BOARD_COLOR1")
		),
		undefined
	);
	assert.equal(
		findAdjacentSimpleDocumentationComment(
			source,
			declarationOffset(source, "过程 NewGame()")
		),
		undefined
	);
});
