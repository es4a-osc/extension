/*
验证不依赖 SDK 的 Simple 语法着色、逻辑语句与源码作用域，并检查共享符号查询。
xhwsd@qq.com 2026-10-31
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { buildLanguageTokenRules, buildDocumentTokenRules, tokenizeSimpleText } from "../compilerTokens";
import { createSimpleSourceAnalysis, resolveSimpleBinding } from "../completionModel";
import { scanSimpleSource, simpleSourceStatements } from "../simpleSourceLexical";
import { analyzeSimpleSourceSyntax, simpleCreatedType } from "../simpleSourceSyntax";
import { parseSimpleUnitSymbols } from "../simpleUnitSymbols";
import { splitSimpleUnitSource } from "../simpleUnitSource";
import { listSimpleFiles } from "../simpleFileDiscovery";
import { loadSdk } from "../sdk";
import { testSdkPath } from "./testFixtures";
import { simpleTestProjectPath } from "./testProjects";

/** 使用与 Provider 相同的语法及符号输入，返回编辑器中立令牌。 */
function color(source: string) {
	return tokenizeSimpleText(source, [...buildLanguageTokenRules(), ...buildDocumentTokenRules(source)]);
}

test("无 SDK 时按声明位置区分同名参数、未知类型、函数返回值及调用", () => {
	const source = [
		"别名 数据类型 = 项目.数据对象",
		"函数 计算(数据类型 为 数据类型, 传址 项目值 为 未安装类型) 为 未安装类型",
		"计算 = 项目值",
		"结束 函数",
		"过程 运行()",
		"计算(空, 空)",
		"结束 过程"
	].join("\r\n");
	const tokens = color(source);
	assert.deepEqual(tokens.filter((token) => token.text === "数据类型").map((token) => [token.line, token.type]), [[0, "type"], [1, "parameter"], [1, "type"]]);
	assert.deepEqual(tokens.filter((token) => token.text === "计算").map((token) => token.type), ["function", "variable", "function"]);
	assert.equal(tokens.filter((token) => token.text === "未安装类型" && token.type === "type").length, 2);
	assert.deepEqual(tokens.filter((token) => token.text === "项目值").map((token) => token.type), ["parameter", "parameter"]);
});

test("递归调用、返回值和常量遮蔽按各自身份着色，完整名称不误匹配前缀", () => {
	const source = [
		"常量 上限 为 整数型 = 7",
		"函数 计算(值 为 整数型) 为 整数型",
		"计算 = 计算(值 - 1) + 上限",
		"结束 函数",
		"过程 运行()",
		"变量 上限 为 整数型",
		"上限 = 1",
		"上限之外 = 上限",
		"结束 过程",
		'文本 = "上限 计算 值"',
		"' 上限 计算 值"
	].join("\r\n");
	const tokens = color(source);
	assert.deepEqual(tokens.filter((token) => token.text === "计算").map((token) => token.type), ["function", "variable", "function"]);
	assert.deepEqual(tokens.filter((token) => token.text === "上限").map((token) => token.modifiers), [["readonly"], ["readonly"], [], [], []]);
	assert.equal(tokens.some((token) => token.text === "上限之外"), false);
	assert.equal(tokens.some((token) => token.line >= 9 && ["上限", "计算", "值"].includes(token.text)), false);
});

test("冒号与续行声明共享解析，数组和字符串中的逗号不会生成伪声明", () => {
	const source = [
		"过程 运行(甲 为 整数型, _",
		"传值 乙 为 文本型)",
		'变量 名称 为 文本型 = "a,b:c", _',
		"数组 为 整数型(2, 3) : 变量 数量 为 整数型 = 2",
		"数量 = 甲 : 名称 = 乙",
		"结束 过程"
	].join("\r\n");
	const tokens = color(source);
	for (const name of ["名称", "数量", "甲", "乙"]) {
		assert.equal(tokens.filter((token) => token.text === name).length, 2, name);
	}
	assert.ok(tokens.some((token) => token.text === "乙" && token.line === 1 && token.character === 3 && token.type === "parameter"));
	assert.ok(tokens.some((token) => token.text === "数组" && token.type === "variable"));
	assert.equal(tokens.some((token) => token.text === "a" || token.text === "b" || token.text === "c"), false);
	const analysis = createSimpleSourceAnalysis(source, undefined);
	assert.equal(resolveSimpleBinding(source, source.indexOf("名称 ="), "乙", undefined, analysis)?.typeName, "文本型");
	assert.equal(resolveSimpleBinding(source, source.indexOf("数量 = 甲"), "数组", undefined, analysis)?.typeName, "整数型(2, 3)");
});

test("分支沿编译器父链查找前支变量，循环体变量在离开循环后不可见", () => {
	const source = [
		"变量 值 为 文本型",
		"过程 运行()",
		"值 = 1",
		"如果 真 则",
		"变量 值 为 整数型",
		"值 = 2",
		"否则",
		"值 = 3",
		"结束 如果",
		"执行",
		"变量 临时 为 整数型",
		"临时 = 1",
		"直到 真",
		"临时 = 2",
		"位于 错误",
		"分支 否则",
		"变量 错误值 为 整数型",
		"错误值 = 1",
		"分支 空",
		"错误值 = 2",
		"结束 错误",
		"结束 过程"
	].join("\n");
	const analysis = createSimpleSourceAnalysis(source, undefined);
	for (const [text, expected] of [["值 = 1", "文本型"], ["值 = 2", "整数型"], ["值 = 3", "整数型"]] as const) {
		assert.equal(resolveSimpleBinding(source, source.indexOf(text), "值", undefined, analysis)?.typeName, expected);
	}
	assert.ok(resolveSimpleBinding(source, source.indexOf("临时 = 1"), "临时", undefined, analysis));
	assert.equal(resolveSimpleBinding(source, source.indexOf("临时 = 2"), "临时", undefined, analysis), undefined);
	assert.ok(resolveSimpleBinding(source, source.indexOf("错误值 = 1"), "错误值", undefined, analysis));
	assert.ok(resolveSimpleBinding(source, source.indexOf("错误值 = 2"), "错误值", undefined, analysis));
});

test("完整创建、数组及组件创建可推断类型，比较结果不能沿用创建类型", () => {
	for (const [source, expected] of [
		["创建 A", "A"], ["创建 A(3)", "A(3)"], ["创建 A 位于 容器", "A"],
		["创建 A 是 空", undefined], ["创建 A(3) 是 空", undefined], ["创建 A & \"文本\"", undefined],
		["创建 A(3", undefined], ["创建 A 位于", undefined]
	] as const) {
		assert.equal(simpleCreatedType(scanSimpleSource(source), source), expected, source);
	}
});

test("局部初值遵循 InitializerScope，自身或后续同名变量不能回退成外层字段", () => {
	for (const declaration of ["变量 值 为 文本型 = 值", "变量 首值 为 文本型 = 值\n变量 值 为 文本型"]) {
		const source = `变量 值 为 整数型\n过程 Run()\n${declaration}\n结束 过程`;
		const syntax = analyzeSimpleSourceSyntax(source);
		assert.equal(syntax.resolve("值", source.indexOf("= 值") + 2), undefined, declaration);
	}
	const source = "过程 Run()\n变量 前值 为 整数型 = 1\n变量 后值 为 整数型 = 前值\n结束 过程";
	assert.equal(analyzeSimpleSourceSyntax(source).resolve("前值", source.lastIndexOf("前值"))?.typeName, "整数型");
});

test("执行循环的结束条件按编译器使用外层作用域，循环体仍保留自己的局部变量", () => {
	for (const keyword of ["直到", "判断循环"]) {
		const source = `过程 Run()\r\n变量 值 为 文本型\r\n执行\r\n变量 值 为 整数型\r\n值 = 1\r\n${keyword} 值 = \"结束\"\r\n结束 过程`;
		const syntax = analyzeSimpleSourceSyntax(source);
		assert.equal(syntax.resolve("值", source.indexOf("值 = 1"))?.typeName, "整数型");
		assert.equal(syntax.resolve("值", source.lastIndexOf("值 ="))?.typeName, "文本型", keyword);
		assert.equal(syntax.blocksAt(source.indexOf(keyword)).at(-1)?.kind, "do", keyword);
		assert.equal(syntax.blocksAt(source.lastIndexOf("值 =")).some((frame) => frame.kind === "do"), false, keyword);
	}
});

test("成员位置不会被同名参数覆盖，关键字成员与普通运算符保持区分", () => {
	const source = [
		"常量 数量 为 整数型 = 1",
		"过程 运行(数量 为 文本型)",
		"本对象.数量 = 2",
		"未知实例.匹配(数量)",
		'数量 = "a" 匹配 "b"',
		"结束 过程"
	].join("\n");
	const tokens = color(source);
	const member = tokens.find((token) => token.line === 2 && token.text === "数量");
	assert.equal(member?.type, "variable");
	assert.deepEqual(member?.modifiers, ["readonly"]);
	assert.deepEqual(tokens.filter((token) => token.text === "匹配").map((token) => token.type), ["method", "operator"]);
});

test("未闭合字符串、参数和块不吞掉下一物理行，位置保持 UTF-16 与 CRLF", () => {
	const source = '过程 运行(甲 为 整数型\r\n"未闭合\\\r\n变量 e\u0301 为 整数型 : e\u0301 = 1\r\n结束 过程';
	const tokens = color(source);
	assert.equal(tokens.filter((token) => token.text === "e\u0301" && token.type === "variable").length, 2);
	assert.ok(tokens.some((token) => token.line === 2 && token.character === 3 && token.text === "e\u0301"));
	assert.equal(tokens.some((token) => token.line === 1), false);
	const statements = simpleSourceStatements(scanSimpleSource('变量 甲 为 文本型 = "a:b" : _\r\n变量 乙 为 整数型'));
	assert.equal(statements.length, 2);
	assert.equal(statements[1]?.[0]?.text, "变量");
	assert.equal(color("如果\u0301").length, 0, "标识符内部的关键字不着色");
});

test("接口无函数体、属性访问器隐式值及同名单元成员使用各自作用域", () => {
	const syntax = analyzeSimpleSourceSyntax("函数 甲(参数甲 为 文本型) 为 文本型\n过程 乙(参数乙 为 整数型)", true);
	assert.deepEqual(syntax.declarations.filter((declaration) => declaration.scope === syntax.root).map((declaration) => declaration.name), ["甲", "乙"]);
	const source = "属性 数量 为 整数型\n获取\n数量 = 1\n结束 获取\n设置\n变量 值 为 整数型 = 数量\n结束 设置\n结束 属性";
	assert.deepEqual(color(source).filter((token) => token.text === "数量").map((token) => token.type), ["property", "variable", "parameter"]);
});

test("SDK 编译器清单不能覆盖固定关键字、参数或变量的源码身份", () => {
	const source = "变量 值 为 未安装类型\n过程 运行(值 为 文本型)\n如果 真 则\n值 = 值\n结束 如果\n结束 过程";
	const sdk = {
		directory: "C:\\sdk", capabilities: { projects: [], tools: [] }, templates: {}, issues: [],
		manifests: [{
			kind: "compiler" as const, directory: "C:\\sdk\\simple", filePath: "C:\\sdk\\simple\\SimpleCompiler.json", name: "不同版本清单",
			categories: [{ name: "清单分类", definitions: [{ name: "如果", kind: "type" }, { name: "值", kind: "type" }] }]
		}]
	};
	assert.deepEqual(tokenizeSimpleText(source, [...buildLanguageTokenRules(), ...buildDocumentTokenRules(source, sdk)]), color(source));
});

test("真实 Tetris 的常量、数组访问和源码函数在无 SDK 时保留不同角色", async () => {
	const file = simpleTestProjectPath("Tetris", "src", "simple", "samples", "tetris", "Tetris.simple");
	const source = splitSimpleUnitSource(await fs.readFile(file, "utf8")).userCode;
	const tokens = color(source);
	const array = tokens.filter((token) => token.text === "BoardCells");
	assert.ok(array.length > 5);
	assert.ok(array.every((token) => token.type === "variable"), "带括号的数组访问不能按函数着色");
	const constant = tokens.filter((token) => token.text === "ROWS");
	assert.ok(constant.length > 5);
	assert.ok(constant.every((token) => token.type === "variable" && token.modifiers.includes("readonly")));
	assert.ok(tokens.filter((token) => token.text === "GetBoardColor" && token.type === "function").length > 2);
	assert.ok(tokens.some((token) => token.text === "循环" && token.type === "simpleControl"));
});

test("真实 Tetris 和 SmokeTest 源码在无 SDK 时识别声明、类型和关键字，SDK 不改写源码角色", async () => {
	const sdk = await loadSdk(testSdkPath());
	let files = 0;
	let declarations = 0;
	for (const project of ["Tetris", "SmokeTest"] as const) {
		for (const file of await listSimpleFiles(simpleTestProjectPath(project, "src"))) {
			const source = await fs.readFile(file, "utf8");
			const unit = parseSimpleUnitSymbols(source, file, simpleTestProjectPath(project, "src"));
			const context = { currentUnit: unit, manifest: { categories: [{ definitions: [unit.definition], name: "源码" }], kind: "project" as const, name: project, directory: path.dirname(file), filePath: file } };
			const withoutSdk = buildDocumentTokenRules(source, undefined, context);
			const withSdk = buildDocumentTokenRules(source, sdk, context);
			const syntax = analyzeSimpleSourceSyntax(splitSimpleUnitSource(source).userCode, unit.unitType === "接口");
			for (const declaration of syntax.declarations.filter((value) => value.implicit !== true)) {
				const before = withoutSdk.find((rule) => rule.start === declaration.token.start);
				const after = withSdk.find((rule) => rule.start === declaration.token.start);
				assert.ok(before, file + ": " + declaration.name);
				assert.equal(before.type, after?.type, file + ": " + declaration.name);
				declarations += 1;
			}
			files += 1;
		}
	}
	assert.ok(files > 10 && declarations > 100);
});
