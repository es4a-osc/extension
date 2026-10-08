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

test("从 SDK 函数和事件定义生成参数签名", () => {
	const sdk: Sdk = {
		capabilities: { projects: [], tools: [] },
		templates: {},
		directory: "C:\\SDK",
		filePath: "C:\\SDK\\entry.json",
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
								name: "算术运算"
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
			"算术运算.最大值(left 为 整数型, 传址 right 为 整数型) 为 整数型",
			"算术运算.按下某键(keycode 为 整数型)"
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

	const qualified = "算术运算.最大值(1, ";
	assert.deepEqual(findCallContext(qualified, qualified.length), {
		activeParameter: 1,
		name: "最大值",
		nameStart: qualified.indexOf("最大值"),
		qualifier: "算术运算"
	});

	const declaration = "函数 Sum(";
	assert.equal(findCallContext(declaration, declaration.length), undefined);
});

test("完整调用按顶层实参数量选择重载", () => {
	assert.equal(findCallableArgumentCount("执行()", "执行".length), 0);
	assert.equal(findCallableArgumentCount("执行(1)", "执行".length), 1);
	assert.equal(findCallableArgumentCount("执行(取值(1, 2), \"a,b\")", "执行".length), 2);
	assert.equal(findCallableArgumentCount("执行(1, ' 注释中的逗号,\n2)", "执行".length), 2);
	assert.equal(findCallableArgumentCount("执行(", "执行".length), undefined);
	assert.equal(findCallableArgumentCount("执行", "执行".length), undefined);
});
