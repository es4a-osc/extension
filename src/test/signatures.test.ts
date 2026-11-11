/*
验证签名定义构建和 Simple 调用上下文解析。
xhwsd@qq.com 2026-8-27
*/

import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { Sdk } from "../sdk";
import {
	buildDocumentSignatures,
	buildSdkSignatures,
	findCallableArgumentCount,
	findCallContext,
	formatSignature
} from "../signatures";

test("名称和已有实参之间允许连续续行，普通换行与注释不充当续行", () => {
	for (const gap of [" ", " _\n", " _\r\n\t_\r\n "]) {
		const source = `方法${gap}(1, 2)`;
		assert.equal(findCallableArgumentCount(source, 2), 2, gap);
		assert.equal(findCallContext(source, source.indexOf("2"))?.activeParameter, 1, gap);
	}
	for (const gap of ["\n", " ' 注释\r\n"]) assert.equal(findCallableArgumentCount(`方法${gap}(1, 2)`, 2), undefined, gap);
});

test("从 SDK 函数和事件定义生成参数签名", () => {
	const sdk: Sdk = {
		capabilities: { projects: [], tools: [] },

		templates: {},
		directory: "C:\\SDK",
		issues: [],
		manifests: [
			{
				categories: [
					{
						definitions: [
							{
								events: [
									{
										name: "按下某键",
										params: [{ name: "keycode", type: "整数型" }]
									}
								],
								functions: [
									{
										description: "返回较大的数。",
										name: "最大值",
										params: [
											{ name: "left", type: "整数型" },
											{ byRef: true, name: "right", type: "整数型" }
										],
										return: "整数型"
									}
								],
								name: "数值运算"
							}
						],
						name: "对象"
					}
				],
				directory: "C:\\SDK\\simple",
				filePath: "C:\\SDK\\simple\\runtime.json",
				kind: "runtime",
				name: "运行库"
			}
		]
	};

	assert.deepEqual(
		buildSdkSignatures(sdk).map(formatSignature),
		[
			"数值运算.最大值(left 为 整数型, 传址 right 为 整数型) 为 整数型",
			"数值运算.按下某键(keycode 为 整数型)"
		]
	);
});

test("解析当前文档的函数、过程和事件参数", () => {
	const source = [
		"''' **求和说明**",
		"函数 Sum(left 为 整数型, 传址 right 为 整数型) 为 整数型",
		"结束 函数",
		"过程 Fill(values 为 整数型(,), 传值 count 为 整数型)",
		"结束 过程",
		"事件 Window.按下某键(keycode 为 整数型)",
		"结束 事件"
	].join("\n");

	assert.deepEqual(
		buildDocumentSignatures(source).map(formatSignature),
		[
			"Sum(left 为 整数型, 传址 right 为 整数型) 为 整数型",
			"Fill(values 为 整数型(,), count 为 整数型)",
			"Window.按下某键(keycode 为 整数型)"
		]
	);
	assert.equal(buildDocumentSignatures(source)[0]?.description, "**求和说明**");
});

test("嵌套调用按括号层级计算当前参数", () => {
	const nested = "Outer(Inner(1, 2), \"a,b\", Third(";
	assert.deepEqual(findCallContext(nested, nested.length), {
		activeParameter: 0,
		name: "Third",
		nameStart: nested.lastIndexOf("Third"),
		qualifier: undefined
	});

	const outer = "Outer(Inner(1, 2), \"a,b\", Third(3), ";
	assert.deepEqual(findCallContext(outer, outer.length), {
		activeParameter: 3,
		name: "Outer",
		nameStart: 0,
		qualifier: undefined
	});

	const qualified = "数值运算.最大值(1, ";
	assert.deepEqual(findCallContext(qualified, qualified.length), {
		activeParameter: 1,
		name: "最大值",
		nameStart: qualified.indexOf("最大值"),
		qualifier: "数值运算"
	});

	const declaration = "函数 Sum(";
	assert.equal(findCallContext(declaration, declaration.length), undefined);
});

test("完整调用按顶层实参数量选择重载", () => {
	assert.equal(findCallableArgumentCount("执行()", "执行".length), 0);
	assert.equal(findCallableArgumentCount("执行(1)", "执行".length), 1);
	assert.equal(findCallableArgumentCount("执行(取值(1, 2), \"a,b\")", "执行".length), 2);
	assert.equal(findCallableArgumentCount("执行(1, ' 注释中的逗号,\n2)", "执行".length), undefined);
	assert.equal(findCallableArgumentCount("执行(", "执行".length), undefined);
	assert.equal(findCallableArgumentCount("执行", "执行".length), undefined);
});

test("实参数量使用词法续行和语句边界，空续行仍是零参数", () => {
	for (const newline of ["\n", "\r\n"]) {
		for (const body of [` _${newline}`, ` _${newline} _${newline}`]) {
			const source = `求值(${body})`;
			assert.equal(findCallableArgumentCount(source, 2), 0);
			assert.equal(findCallContext(source, source.indexOf(")"))?.activeParameter, 0);
		}
		assert.equal(findCallableArgumentCount(`求值(1, _${newline}取值(2, 3))`, 2), 2);
		assert.equal(findCallableArgumentCount(`求值(${newline}后续(1))`, 2), undefined);
		assert.equal(findCallableArgumentCount(`求值(1:${newline}后续(2))`, 2), undefined);
	}
	assert.equal(findCallableArgumentCount('求值("(_)", "a,b")', 2), 2);
});
