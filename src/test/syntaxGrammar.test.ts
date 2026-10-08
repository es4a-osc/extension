/*
验证 TextMate 基础着色规则与当前 Simple Scanner 的稳定词法约束一致。
xhwsd@qq.com 2026-8-27
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

/** TextMate 仓库中的最小正则规则结构。 */
interface GrammarPattern {
	readonly match?: string;
	readonly name?: string;
	readonly patterns?: readonly GrammarPattern[];
}

/** 测试只读取的 TextMate 语法仓库结构。 */
interface Grammar {
	readonly repository: Readonly<Record<string, GrammarPattern>>;
}

const grammar = JSON.parse(
	fs.readFileSync(path.resolve("syntaxes", "simple.tmLanguage.json"), "utf8")
) as Grammar;

/** 返回仓库分组中指定作用域的匹配表达式。 */
function pattern(group: string, scope: string): RegExp {
	const source = grammar.repository[group]?.patterns?.find((candidate) => candidate.name === scope)?.match;
	assert.ok(source, "缺少 " + group + " / " + scope + " 规则");
	return new RegExp("^(?:" + source + ")$", "u");
}

test("TextMate 覆盖当前关键字、类型、字面量和属性区标记", () => {
	const symbolOperator = pattern("operators", "keyword.operator.symbol.simple");
	const wordOperator = pattern("operators", "keyword.operator.word.simple");
	assert.match("否则如果", pattern("keywords", "keyword.control.simple"));
	assert.match("类型检验", pattern("keywords", "keyword.other.expression.simple"));
	assert.match("整数型", pattern("types", "storage.type.simple"));
	assert.match("真", pattern("literals", "constant.language.boolean.simple"));
	assert.match("%", symbolOperator);
	assert.doesNotMatch("求模", wordOperator);
	assert.match(":", pattern("punctuation", "punctuation.separator.statement.simple"));
	assert.match("$资源", pattern("property-section", "keyword.other.property-section.simple"));
	assert.match("$服务", pattern("property-section", "storage.type.property-section.simple"));
	assert.doesNotMatch("$线程", pattern("property-section", "storage.type.property-section.simple"));
});

test("TextMate 数值、转义和续行规则对齐 Scanner", () => {
	const decimal = pattern("numbers", "constant.numeric.decimal.simple");
	assert.match("1", decimal);
	assert.match("1.25", decimal);
	assert.match("1.25E-3", decimal);
	assert.doesNotMatch(".5", decimal);
	assert.doesNotMatch("1.", decimal);
	assert.doesNotMatch("1e3", decimal);

	const continuation = pattern("line-continuation", "punctuation.separator.continuation.simple");
	assert.match("_", continuation);
	assert.doesNotMatch("_ ", continuation);

	const escapeSource = grammar.repository.strings?.patterns?.[0]?.patterns?.[0]?.match;
	assert.ok(escapeSource);
	const escape = new RegExp("^(?:" + escapeSource + ")$", "u");
	assert.match("\\n", escape);
	assert.match("\\u4E2D", escape);
	assert.doesNotMatch("\\f", escape);
});
