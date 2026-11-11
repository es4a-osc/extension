/*
验证 Simple 首拼补全只返回当前代码区域、作用域和类型允许的候选。
xhwsd@qq.com 2026-8-27
*/

import { testFixturePath, testSdkPath } from "./testFixtures";

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { test } from "node:test";
import { createSimpleSourceAnalysis, isSimpleResourceRoot, pinyinInitials, provideSimpleCompletions } from "../completionModel";
import { loadSdk, type Sdk } from "../sdk";
import { parseSimpleUnitSymbols, type SimpleProjectSemanticContext } from "../simpleUnitSymbols";
import { splitSimpleUnitSource } from "../simpleUnitSource";

const CURSOR = "¦";
const sdkPromise = loadSdk(testSdkPath());

/** Parser.parseExpression 中可继续表达式的运算符，与语句分隔符一起校验。 */
const binaryOperators = ["且", "或", "异或", "是", "非", "匹配", "=", "<>", "<", "<=", ">", ">=", "<<", ">>", "&", "+", "-", "%", "\\", "*", "/", "^"];
const operators = (...delimiters: string[]) => new Set([...binaryOperators, ...delimiters]);
const typeCheckOperators = new Set(["是", "<<", ">>", "&", "+", "-", "%", "\\", "*", "/", "^"]);


/** 在标记位置执行补全，并返回候选。 */
async function completionCandidates(markedSource: string) {
	return completionCandidatesForFile(markedSource, "Test.simple");
}

/** 使用指定单元文件名在标记位置执行补全。 */
async function completionCandidatesForFile(markedSource: string, fileName: string, configuredSdk?: Sdk) {
	const offset = markedSource.indexOf(CURSOR);
	assert.notEqual(offset, -1, "测试源码缺少光标标记");
	const source = markedSource.replace(CURSOR, "");
	const userCode = splitSimpleUnitSource(source).userCode;
	const sdk: Sdk = configuredSdk ?? await sdkPromise;
	const unit = parseSimpleUnitSymbols(source, `C:\\project\\src\\${fileName}`, "C:\\project\\src");
	const context: SimpleProjectSemanticContext = {
		currentUnit: unit,
		manifest: {
			categories: [{ definitions: [unit.definition], hidden: true, name: "测试单元" }],
			description: "测试单元",
			directory: "C:\\project\\src",
			filePath: "C:\\project\\project.properties",
			kind: "project",
			name: "测试项目"
		}
	};
	return provideSimpleCompletions(userCode, offset, sdk, context)?.candidates ?? [];
}

/** 在标记位置执行补全，并返回候选中文名称。 */
async function complete(markedSource: string): Promise<readonly string[]> {
	return (await completionCandidates(markedSource)).map((candidate) => candidate.name);
}

/** 为代码区追加程序单元类型属性，光标仍位于属性区之前。 */
function unit(source: string, kind = "对象"): string {
	return `${source}\r\n$属性\r\n\t$资源 $${kind}\r\n$结束 $属性\r\n`;
}

test("连续变量和常量声明在每个逗号后重新进入名称、类型与初值阶段", async () => {
	for (const scope of ["", "过程 Run()\r\n"]) {
		const end = scope === "" ? "" : "\r\n结束 过程";
		for (const initial of ["1", "取最大值(1, 2)", '"a,b"']) {
			assert.ok((await complete(unit(`${scope}变量 甲 为 整数型 = ${initial}, 乙 为 整¦${end}`))).includes("整数型"));
			assert.deepEqual(await complete(unit(`${scope}变量 甲 为 整数型 = ${initial}, 乙 ¦${end}`)), ["为"]);
			const values = await complete(unit(`${scope}变量 甲 为 整数型 = ${initial}, 乙 为 整数型 = ¦${end}`));
			assert.ok(values.includes("甲") && values.includes("真"));
			if (scope !== "") assert.equal(values.includes("乙"), false);
		}
	}
	assert.ok((await complete(unit("常量 甲 为 整数型 = 1, 乙 为 整¦"))).includes("整数型"));
	const constants = await completionCandidates(unit("变量 实例值 为 整数型\r\n常量 甲 为 整数型 = 1, 乙 为 整数型 = ¦"));
	assert.ok(constants.some((candidate) => candidate.name === "甲"));
	assert.equal(constants.some((candidate) => candidate.name === "实例值"), false);
});

test("数组声明区分省略维数与指定尺寸，不推荐非法混合或双重初始化", async () => {
	for (const declaration of ["变量 数组 为 整数型(3) ¦", "变量 数组 为 整数型(3) = ¦", "变量 数组 为 整数型(, ¦)", "变量 数组 为 整数型(3, , ¦)"]) {
		assert.deepEqual(await complete(unit(`过程 Run()\r\n${declaration}\r\n结束 过程`)), [], declaration);
	}
	assert.ok((await complete(unit("过程 Run()\r\n变量 数 为 整数型\r\n变量 数组 为 整数型(3, ¦)\r\n结束 过程"))).includes("数"));
	assert.ok((await complete(unit("过程 Run()\r\n变量 原数组 为 整数型()\r\n变量 数组 为 整数型() = ¦\r\n结束 过程"))).includes("原数组"));
});

test("完整语句按实际左值提示等号，单行条件在完整语句后提供否则", async () => {
	const declarations = "变量 数 为 整数型\r\n变量 数组 为 整数型()\r\n变量 控件 为 按钮\r\n过程 调用()\r\n结束 过程\r\n";
	const source = (body: string) => unit(`${declarations}过程 Run()\r\n${body}\r\n结束 过程`);
	for (const body of ["调用() ¦", "控件.销毁() ¦"]) assert.deepEqual(await complete(source(body)), [], body);
	for (const target of ["数", "数组(0)", "控件.文本"]) assert.deepEqual(await complete(source(`${target} ¦`)), ["="], target);
	for (const body of ["调用()", "退出 过程", "触发事件 完成()"])
		assert.deepEqual(await complete(source(`如果 真 则 ${body} ¦`)), ["否则"], body);
	assert.deepEqual(new Set(await complete(source("如果 真 则 数 = 1 ¦"))), operators("否则"));
	assert.deepEqual(await complete(source("如果 真 则 调用() 否则 调用() ¦")), []);
	assert.equal((await complete(source("如果 真 则 数 = ¦"))).includes("否则"), false);
});

test("判断分支的普通值、比较项和范围项在列表中保持各自语法", async () => {
	const source = (header: string) => unit(`过程 Run()\r\n变量 数 为 整数型\r\n判断 数\r\n${header}\r\n结束 判断\r\n结束 过程`);
	for (const header of ["分支 是 > 1, ¦", "分支 1, 是 < 2, ¦", "分支 是 > 1, 2 至 3, ¦"]) {
		const names = await complete(source(header));
		assert.ok(names.includes("数") && names.includes("是"), header);
		assert.equal(names.includes("否则"), false);
	}
	assert.deepEqual(new Set(await complete(source("分支 1, 是 ¦"))), new Set(["=", "<>", "<", "<=", ">", ">="]));
	assert.equal((await complete(source("分支 是 > 1 ¦"))).includes("至"), false);
});

test("初值禁用名称不能回退到外层字段，显式本对象限定仍可读取字段", async () => {
	for (const body of ["变量 甲 为 按钮 = ¦", "变量 乙 为 按钮 = ¦\r\n变量 甲 为 按钮"]) {
		const marked = unit(`变量 甲 为 按钮\r\n过程 Run()\r\n${body}\r\n结束 过程`);
		assert.equal((await complete(marked)).includes("甲"), false, body);
		assert.deepEqual(await complete(marked.replace("¦", "甲.¦")), []);
		assert.ok((await complete(marked.replace("¦", "本对象.¦"))).includes("甲"));
	}
	for (const body of ["变量 R 为 整数型 = R", "变量 值 为 整数型 = R\r\n变量 R 为 整数型"]) {
		const source = unit(`过程 Run()\r\n${body}\r\n结束 过程`);
		const offset = source.indexOf("= R") + 2;
		assert.equal(isSimpleResourceRoot(createSimpleSourceAnalysis(source, undefined), offset), false, body);
	}
});

test("静态调用的返回类型与可用调用一致，不从实例函数声明旁路推断", async () => {
	const declarations = "函数 取得控件() 为 按钮\r\n结束 函数\r\n静态 函数 静态控件() 为 按钮\r\n结束 函数\r\n";
	for (const receiver of ["取得控件()", "静态控件()"])
		for (const modifier of ["", "静态 "]) {
			const names = await complete(unit(`${declarations}${modifier}过程 Run()\r\n变量 值 为 文本型\r\n值 = ${receiver}.¦\r\n结束 过程`));
			assert.equal(names.includes("文本"), modifier === "" || receiver === "静态控件()", modifier + receiver);
		}
});

test("源码属性按获取与设置筛选，访问器内部保留自己的隐式值", async () => {
	const declarations = [
		"属性 只读值 为 整数型", "获取", "只读值 = 1", "结束 获取", "结束 属性",
		"属性 只写值 为 整数型", "设置", "结束 设置", "结束 属性",
		"属性 双向值 为 整数型", "获取", "双向值 = 1", "结束 获取", "设置", "结束 设置", "结束 属性"
	].join("\r\n");
	const targets = await complete(unit(`${declarations}\r\n过程 Run()\r\n¦ = 1\r\n结束 过程`));
	assert.ok(targets.includes("只写值") && targets.includes("双向值"));
	assert.equal(targets.includes("只读值"), false);
	const values = await complete(unit(`${declarations}\r\n过程 Run()\r\n变量 值 为 整数型\r\n值 = ¦\r\n结束 过程`));
	assert.ok(values.includes("只读值") && values.includes("双向值"));
	assert.equal(values.includes("只写值"), false);
	const getter = await completionCandidates(unit("属性 只读值 为 整数型\r\n获取\r\n只¦读值 = 1\r\n结束 获取\r\n结束 属性"));
	assert.equal(getter.find((candidate) => candidate.name === "只读值")?.kind, "variable");
	const setter = await complete(unit("属性 只写值 为 整数型\r\n设置\r\n输出信息(\"tag\", 只¦写值)\r\n结束 设置\r\n结束 属性"));
	assert.ok(setter.includes("只写值"));
});

test("名称后已有括号时只提示函数，名称前缀及限定名继续参与匹配", async () => {
	const declarations = "变量 求值缓存 为 整数型\r\n变量 求值数组 为 整数型()\r\n函数 求值(输入 为 整数型) 为 整数型\r\n求值 = 输入\r\n结束 函数\r\n\r\n函数 求值备选(输入 为 整数型) 为 整数型\r\n求值备选 = 输入\r\n结束 函数\r\n";
	for (const call of ["求¦值(1)", "求值¦(1)", "求¦值 \t(1)"]) {
		const candidates = await completionCandidates(unit(declarations + `过程 Run()\r\n${call}\r\n结束 过程`));
		assert.ok(candidates.some((candidate) => candidate.name === "求值"));
		assert.ok(candidates.some((candidate) => candidate.name === "求值备选"));
		assert.ok(candidates.every((candidate) => candidate.kind === "function"));
	}
	const qualified = await completionCandidates(unit('过程 Run()\r\nsimple.runtime.文本操作.分¦割文本("", "", 1)\r\n结束 过程'));
	assert.ok(qualified.some((candidate) => candidate.name === "分割文本"));
	assert.ok(qualified.every((candidate) => candidate.kind === "function"));
});

test("数组元素赋值读取数组属性，不要求属性本身具有设置过程", async () => {
	const declarations = [
		"属性 数组只读 为 整数型()", "获取", "结束 获取", "结束 属性",
		"属性 数组只写 为 整数型()", "设置", "结束 设置", "结束 属性",
		"变量 数组变量 为 整数型()"
	].join("\r\n");
	const candidates = await complete(unit(`${declarations}\r\n过程 Run()\r\n数组¦只读(0) = 1\r\n结束 过程`));
	assert.deepEqual(new Set(candidates), new Set(["数组只读", "数组变量"]));
});

test("跨单元继承属性保留读写限制，派生同名属性遮蔽基础声明", () => {
	const sourceRoot = "C:\\project\\src";
	const base = parseSimpleUnitSymbols(unit([
		"属性 只读值 为 整数型", "获取", "结束 获取", "结束 属性",
		"属性 只写值 为 整数型", "设置", "结束 设置", "结束 属性",
		"属性 同名值 为 整数型", "获取", "结束 获取", "结束 属性"
	].join("\r\n")), `${sourceRoot}\\Base.simple`, sourceRoot);
	const derived = parseSimpleUnitSymbols([
		"属性 同名值 为 整数型", "设置", "结束 设置", "结束 属性",
		"$属性", "$资源 $对象", "基础对象 = Base", "$结束 $属性"
	].join("\r\n"), `${sourceRoot}\\Derived.simple`, sourceRoot);
	for (const [statement, expected] of [
		["实例.¦ = 1", ["只写值", "同名值"]], ["数 = 实例.¦", ["只读值"]]
	] as const) {
		const marked = unit(`过程 Run()\r\n变量 实例 为 Derived\r\n变量 数 为 整数型\r\n${statement}\r\n结束 过程`);
		const offset = marked.indexOf(CURSOR);
		const source = marked.replace(CURSOR, "");
		const caller = parseSimpleUnitSymbols(source, `${sourceRoot}\\Caller.simple`, sourceRoot);
		const context: SimpleProjectSemanticContext = { currentUnit: caller, manifest: {
			kind: "project", name: "测试项目", directory: sourceRoot, filePath: "C:\\project\\project.properties",
			categories: [{ name: "项目单元", definitions: [base, derived, caller].map((entry) => entry.definition) }]
		} };
		const candidates = provideSimpleCompletions(splitSimpleUnitSource(source).userCode, offset, undefined, context)?.candidates ?? [];
		assert.deepEqual(new Set(candidates.map((candidate) => candidate.name)), new Set(expected));
	}
});

test("调用筛选保留类型声明、数组下标、事件声明及关键字各自的候选", async () => {
	assert.ok((await complete(unit("变量 值 为 文¦本型()"))).includes("文本型"));
	const arrays = await completionCandidates(unit("过程 Run()\r\n变量 数据数组 为 整数型()\r\n变量 数据数组备选 为 整数型()\r\n变量 数据值 为 整数型\r\n数据¦数组(0)\r\n结束 过程"));
	assert.deepEqual(arrays.map((candidate) => candidate.name), ["数据数组", "数据数组备选"]);
	assert.ok(arrays.every((candidate) => candidate.array === true));
	const events = await completionCandidates(unit("事件 Test.初¦始化()\r\n结束 事件"));
	assert.ok(events.some((candidate) => candidate.name === "初始化"));
	assert.ok(events.every((candidate) => candidate.kind === "event"));
	const conditional = await completionCandidates(unit("过程 Run()\r\n如¦果(真) 则\r\n结束 如果\r\n结束 过程"));
	assert.ok(conditional.some((candidate) => candidate.name === "如果"));
	assert.ok(conditional.every((candidate) => candidate.kind === "keyword"));
});

test("未知名称后的括号同时允许数组和方法，数组元素赋值仍只允许数组", async () => {
	const declarations = "变量 数据数组 为 整数型()\r\n函数 数据计算(索引 为 整数型) 为 整数型\r\n结束 函数\r\n";
	for (const [statement, array, method] of [
		["数 = 数据¦旧(0)", true, true], ["数据¦旧(0) = 1", true, false],
		["数 = 数据¦数组(0)", true, false], ["数 = 数据¦计算(0)", false, true]
	] as const) {
		const names = await complete(unit(`${declarations}过程 Run()\r\n变量 数 为 整数型\r\n${statement}\r\n结束 过程`));
		assert.equal(names.includes("数据数组"), array, statement);
		assert.equal(names.includes("数据计算"), method, statement);
	}
});

test("限定名中间段后是点号时仍补全成员，不受后续方法括号影响", async () => {
	const candidates = await completionCandidates(unit("变量 bbb 为 Test\r\n变量 ccc 为 Test\r\n变量 ccc新 为 Test\r\n函数 dddd() 为 整数型\r\ndddd = 0\r\n结束 函数\r\n\r\n过程 Run()\r\n变量 aaa 为 Test\r\naaa.bbb.cc¦c.dddd()\r\n结束 过程"));
	assert.deepEqual(candidates.map((candidate) => candidate.name), ["ccc", "ccc新"]);
	assert.ok(candidates.every((candidate) => candidate.kind === "variable"));
	const continued = await completionCandidates(unit("变量 bbb 为 Test\r\n变量 ccc 为 Test\r\n变量 ccc新 为 Test\r\n过程 Run()\r\n变量 aaa 为 Test\r\naaa.bbb.cc¦c _\r\n.dddd()\r\n结束 过程"));
	assert.deepEqual(continued.map((candidate) => candidate.name), ["ccc", "ccc新"]);
});

test("类型和别名限定名的中间段只匹配当前命名空间，保留两侧路径", async () => {
	const sdk = await sdkPromise;
	const cases: readonly [string, string, string][] = [
		["变量 值 为 si¦mple.runtime.components.按钮", "simple", "si"],
		["变量 值 为 simple.run¦time.components.按钮", "runtime", "run"],
		["变量 值 为 simple.¦runtime.components.按钮", "runtime", ""],
		["变量 值 为 simple.runtime.com¦ponents.按钮", "components", "com"],
		["别名 类型 = simple.run¦time.components.按钮", "runtime", "run"],
		["别名 类型=simple.run¦time.components.按钮", "runtime", "run"],
		["过程 Run()\r\n变量 值 为 按钮\r\n值 = 创建 simple.run¦time.components.按钮\r\n结束 过程", "runtime", "run"],
		["过程 Run()\r\n变量 值 为 对象型\r\n如果 值 是 simple.run¦time.components.按钮 则\r\n结束 如果\r\n结束 过程", "runtime", "run"]
	];
	for (const [marked, name, query] of cases) {
		const offset = marked.indexOf(CURSOR);
		const source = marked.replace(CURSOR, "");
		const result = provideSimpleCompletions(source, offset, sdk);
		assert.ok(result, marked);
		assert.ok(result.candidates.some((candidate) => candidate.name === name), marked);
		assert.ok(result.candidates.every((candidate) => candidate.kind === "reference" && !candidate.name.includes(".")), marked);
		assert.equal(source.slice(result.start, result.end), query, marked);
		assert.equal(result.query, query, marked);
	}
	assert.deepEqual(await complete(unit("变量 值 为 unknown.run¦time.components.按钮")), []);
});

test("别名等号两侧没有空格时仍按完整限定名匹配类型末段", async () => {
	assert.ok((await complete(unit("别名 类型=simple.runtime.文¦本操作"))).includes("simple.runtime.文本操作"));
});

test("表达式限定名首段不插入完整类名，并保留同名值的遮蔽", async () => {
	const expression = '过程 Run()\r\nsi¦mple.runtime.文本操作.分割文本("", "", 1)\r\n结束 过程';
	const namespaces = await completionCandidates(unit(expression));
	assert.ok(namespaces.some((candidate) => candidate.kind === "reference" && candidate.name === "simple"));
	assert.ok(namespaces.every((candidate) => !candidate.name.includes(".")));
	const shadowed = await completionCandidates(unit("变量 simple 为 Test\r\n" + expression));
	assert.ok(shadowed.some((candidate) => candidate.name === "simple" && candidate.kind === "variable"));
	assert.equal(shadowed.some((candidate) => candidate.name === "simple" && candidate.kind === "reference"), false);
});

test("声明初值中的字符串和调用逗号不会引入伪变量，后续声明保留类型", async () => {
	const source = [
		"过程 Run()",
		'变量 title 为 文本型 = "a, phantom = 创建 计时器", timer 为 计时器 = 创建 计时器',
		"timer.jg¦",
		"结束 过程"
	].join("\r\n");
	assert.deepEqual(await complete(unit(source)), ["间隔"]);
	assert.deepEqual(await complete(unit(source.replace("timer.jg¦", "phantom.jg¦"))), []);
});

test("将中文候选转换为连续拼音首字母", () => {
	assert.equal(pinyinInitials("如果"), "rg");
	assert.equal(pinyinInitials("数组"), "sz");
	assert.equal(pinyinInitials("分割文本"), "fgwb");
});

test("中英文混合输入转首拼匹配，同时保留原名称和作用域约束", async () => {
	for (const query of ["分割", "fgwb", "分割wb", "fg文本", "分g文b", "分割WB"]) {
		assert.deepEqual(
			await complete(unit(`过程 Run()\r\n\t文本操作.${query}¦\r\n结束 过程`)),
			["分割文本"],
			query
		);
	}
	assert.deepEqual(await complete(unit("过程 Run()\r\n\t文本操作.分割wx¦\r\n结束 过程")), []);
	assert.deepEqual(await complete(unit("过程 Run()\r\n\t未知对象.分割wb¦\r\n结束 过程")), []);

	for (const query of ["HTTP服", "http服", "局_HTTP服", "局_httpfw1"]) {
		const candidates = await complete(unit([
			"过程 Run()",
			"\t变量 HTTP服务1 为 文本型",
			"\t变量 局_HTTP服务1 为 文本型",
			`\t${query}¦`,
			"结束 过程"
		].join("\r\n")));
		assert.ok(candidates.includes(query.startsWith("局_") ? "局_HTTP服务1" : "HTTP服务1"), query);
	}
});

test("执行代码支持首拼，但顶层和接口方法体不提示流程语句", async () => {
	const executable = await complete(unit("过程 Run()\r\n\trg¦\r\n结束 过程"));
	assert.ok(executable.includes("如果"));

	const topLevel = await complete(unit("rg¦"));
	assert.ok(!topLevel.includes("如果"));
	assert.ok((await complete(unit("bm¦"))).includes("别名"));

	const interfaceBody = await complete(unit("过程 Run()\r\n\trg¦\r\n结束 过程", "接口"));
	assert.ok(!interfaceBody.includes("如果"));
	assert.ok((await complete(unit("bm¦", "接口"))).includes("别名"));

	const crlfInterfaceBody = await complete([
		"过程 Run()",
		"\trg¦",
		"结束 过程",
		"$属性",
		"\t$资源 $接口",
		"$结束 $属性"
	].join("\r\n"));
	assert.ok(!crlfInterfaceBody.includes("如果"));
});

test("函数声明闭合参数列表后通过首拼提示返回类型关键字", async () => {
	assert.deepEqual(await complete(unit("函数 xx1() w¦\r\n结束 函数")), ["为"]);
	assert.deepEqual(await complete(unit("静态 函数 xx1(value 为 整数型) w¦\r\n结束 函数")), ["为"]);
	assert.ok(!(await complete(unit("过程 xx1() w¦\r\n结束 过程"))).includes("为"));
});

test("函数式声明的参数名后通过首拼提示类型关键字", async () => {
	assert.deepEqual(await complete(unit("函数 xx1(value w¦) 为 整数型\r\n结束 函数")), ["为"]);
	assert.deepEqual(await complete(unit("过程 xx1(传值 value w¦)\r\n结束 过程")), ["为"]);
	assert.deepEqual(await complete(unit("事件 Test.xx1(first 为 整数型, 传址 second w¦)\r\n结束 事件")), ["为"]);
});

test("组件事件定义补全插入参数类型且普通调用保持参数值片段", async () => {
	const propertySource = [
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 Test $为 窗口",
		"\t\t$定义 消息传递器1 $为 消息传递器",
		"\t\t$结束 $定义",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n");
	const declaration = await completionCandidates([
		"事件 消息传递器1.sdxx¦",
		"结束 事件",
		propertySource
	].join("\r\n"));
	assert.deepEqual(declaration.map((candidate) => candidate.name), ["收到消息"]);
	assert.equal(
		declaration[0]?.snippet,
		"收到消息(${1:标记} 为 整数型, ${2:载荷} 为 变体型)"
	);

	const invocation = await completionCandidates([
		"过程 Run()",
		"\t消息传递器1.fsxx¦",
		"结束 过程",
		propertySource
	].join("\r\n"));
	assert.equal(
		invocation.find((candidate) => candidate.name === "发送消息")?.snippet,
		"发送消息(${1:标记}, ${2:载荷})"
	);
});

test("事件拥有者位置支持当前单元和有事件组件的首拼补全", async () => {
	const currentUnit = await completionCandidatesForFile([
		"事件 jc¦",
		"$属性",
		"	$资源 $对象",
		"	基础对象 = simple.runtime.collections.线程",
		"$结束 $属性"
	].join("\r\n"), "继承线程.simple");
	assert.deepEqual(currentUnit.map((candidate) => candidate.name), ["继承线程"]);
	assert.equal(currentUnit[0]?.detail, "当前单元 · 继承线程");

	const component = await completionCandidates([
		"事件 zjsq¦",
		"$属性",
		"	$资源 $窗口",
		"	$定义 Test $为 窗口",
		"		$定义 主计时器 $为 计时器",
		"		$结束 $定义",
		"	$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.deepEqual(component.map((candidate) => candidate.name), ["主计时器"]);
	assert.equal(component[0]?.detail, "组件实例 · 计时器");
});

test("不完整变量和静态声明只提示当前位置合法的声明关键字", async () => {
	assert.deepEqual(await complete(unit("变量 a w¦")), ["为"]);
	assert.deepEqual(await complete(unit("静态 bl¦")), ["变量"]);
});

test("执行体内声明名称后的空白只提示为，逗号和续行不混入已有成员", async () => {
	const declarations = "变量 按钮1 为 按钮\r\n变量 基数 为 整数型\r\n";
	for (const header of [
		"变量 整数 ¦", "变量 整数 w¦", "变量 整数 为¦",
		"变量 前项 为 整数型, 后项 ¦", "变量 矩阵 为 整数型(1, 2), 后项 ¦",
		"变量 前项 为 整数型, _\r\n后项 ¦", "变量 前项 为 整数型: 变量 后项 ¦"
	]) {
		const candidates = await complete(unit(`${declarations}过程 Run()\r\n${header}\r\n结束 过程`));
		assert.deepEqual(candidates, ["为"], header);
	}
	for (const expression of ["变量 数 为 整数型 = 基¦数", "变量 数组 为 整数型(1, 基¦数)"]) {
		assert.ok((await complete(unit(`${declarations}过程 Run()\r\n${expression}\r\n结束 过程`))).includes("基数"));
	}
});

test("变量声明名称位置不提示自身、同名候选或其它已有符号", async () => {
	for (const declaration of [
		"变量 ¦",
		"变量 局_服务意图1¦ 为 意图",
		"变量 局_服务¦意图1 为 意图",
		"变量 局_服¦",
		"变量 rg¦ 为 整数型",
		"变量 前项 为 整数型, 局_服务意图1¦ 为 意图",
		"变量 矩阵 为 整数型(2, 3), 局_服务意图1¦ 为 意图",
		"变量 前项 为 整数型, _\r\n\t局_服务意图1¦ 为 意图",
		"变量 前项 为 整数型: 变量 局_服务意图1¦ 为 意图"
	]) {
		assert.deepEqual(await complete(unit([
			"过程 Run()",
			"\t变量 局_服务意图 为 意图",
			`\t${declaration}`,
			"结束 过程"
		].join("\r\n"))), [], declaration);
	}
	assert.deepEqual(await complete(unit("静态 变量 成_意图1¦ 为 意图")), []);
});

test("变量声明抑制补全不影响类型、数组维度及正文引用", async () => {
	assert.ok((await complete(unit("过程 Run()\r\n\t变量 值 为 yt¦\r\n结束 过程"))).includes("意图"));
	assert.ok((await complete(unit("过程 Run()\r\n\t变量 后项 w¦\r\n结束 过程"))).includes("为"));
	for (const use of ["局_服务¦", "变量 矩阵 为 整数型(2, 局_服务¦)"]) {
		assert.ok((await complete(unit([
			"过程 Run()",
			"\t变量 局_服务意图1 为 整数型",
			`\t${use}`,
			"结束 过程"
		].join("\r\n")))).includes("局_服务意图1"), use);
	}
});

test("真实冒烟测试单元的变量声明名称不补全且正文引用仍补全", async () => {
	const source = await fs.readFile(testFixturePath("simple", "tests", "simple", "runtime", "DeviceTests", "SmokeTests", "src", "simple", "runtime", "smoketests", "others", "测试其它.simple"), "utf8");
	const declaration = "变量 局_测试对象 为 对象";
	assert.ok(source.includes(declaration));
	assert.deepEqual(await complete(source.replace(declaration, "变量 局_测试对象1¦ 为 对象")), []);
	assert.ok((await complete(source.replace("局_测试对象 =", "局_测试对¦ ="))).includes("局_测试对象"));
});

test("如果和否则如果的条件末尾提示则且不重复提示", async () => {
	const ifCandidates = await complete(unit([
		"过程 Run()",
		"\t如果 1 > 2 z¦",
		"\t结束 如果",
		"结束 过程"
	].join("\r\n")));
	assert.equal(ifCandidates[0], "则");

	const elseIfCandidates = await complete(unit([
		"过程 Run()",
		"\t如果 假 则",
		"\t否则如果 1 > 2 z¦",
		"\t结束 如果",
		"结束 过程"
	].join("\r\n")));
	assert.equal(elseIfCandidates[0], "则");

	const completedCondition = await complete(unit([
		"过程 Run()",
		"\t如果 1 > 2 则 z¦",
		"\t结束 如果",
		"结束 过程"
	].join("\r\n")));
	assert.ok(!completedCondition.includes("则"));
});

test("完整操作数后保留运算符和则，操作数未完成时继续提示取值", async () => {
	const source = (statement: string) => unit(`变量 整数 为 整数型\r\n变量 按钮1 为 按钮\r\n过程 Run()\r\n${statement}\r\n结束 过程`);
	for (const statement of [
		"如果 整数 = 组件.布局_方向_水平 ¦", "如果 (整数 = 1) ¦", "如果 整数 = 求绝对值(1) ¦",
		"如果 真 ¦", "如果 \"a\" 匹配 \"a.*\" ¦", "如果 整数 = _\r\n组件.布局_方向_水平 ¦"
	]) {
		assert.deepEqual(new Set(await complete(source(statement))), operators("则"), statement);
	}
	for (const statement of ["如果 整数 = 整¦", "如果 真 且 整¦", "如果 (整数 + 整¦"]) {
		assert.ok((await complete(source(statement))).includes("整数"), statement);
	}
	for (const statement of ["如果 整数 = ¦ 则", "如果 整数 + ¦", "如果 真 且 ¦", "如果 求绝对值(¦", "如果 类型检验 ¦"]) {
		const candidates = await complete(source(statement));
		assert.ok(candidates.includes("整数"), statement);
		assert.equal(candidates.includes("则"), false, statement);
	}
	assert.deepEqual(await complete(source("如果 真 则\r\n结束 ¦")), ["如果"]);
});

test("包含关键字的完整标识符和关键字成员不改变条件语法阶段", async () => {
	for (const expression of ["类型检验次数 = 0", "目标.类型检验 = 0", "目标.是 = 0", "目标 . 则 = 0"]) {
		const source = unit(`变量 类型检验次数 为 整数型\r\n变量 目标 为 Test\r\n过程 Run()\r\n如果 ${expression} ¦\r\n结束 如果\r\n结束 过程`);
		assert.deepEqual(new Set(await complete(source)), operators("则"), expression);
	}
});

test("嵌套比较不能替代外层类型检验的是，括号未关闭不提示则", async () => {
	for (const expression of ["类型检验 (载荷 是 空)", "类型检验 取值(载荷 是 空)"]) {
		assert.deepEqual(new Set(await complete(unit(`过程 Run(载荷 为 变体型)\r\n如果 ${expression} ¦\r\n结束 如果\r\n结束 过程`))), typeCheckOperators, expression);
	}
	const nested = await complete(unit("过程 Run(载荷 为 变体型)\r\n如果 (类型检验 载荷 是 文本型 ¦\r\n结束 过程"));
	assert.equal(nested.includes("则"), false);
	assert.deepEqual(new Set(await complete(unit("过程 Run(载荷 为 变体型)\r\n如果 (类型检验 载荷 是 文本型) ¦\r\n结束 如果\r\n结束 过程"))), operators("则"));
});

test("类型检验在赋值、实参和循环条件中也提示是及完整类型", async () => {
	for (const body of ["结果 = #", "断言真(#)", "判断循环 #", "执行\r\n直到 #", "如果 #", "循环 索引 = #", "判断 真\r\n分支 #"]) {
		const source = (expression: string) => unit(`过程 Run(载荷 为 变体型)\r\n变量 结果 为 逻辑型\r\n${body.replace("#", expression)}\r\n结束 过程`);
		assert.deepEqual(await complete(source("类型检验 载荷 s¦")), ["是"], body);
		const types = await complete(source("类型检验 载荷 是 ¦"));
		assert.ok(types.includes("文本型"), body);
		assert.equal(types.includes("载荷"), false, body);
		if (!body.startsWith("如果")) assert.equal((await complete(source("类型检验 载荷 是 文本型 ¦"))).includes("则"), false, body);
	}
	assert.deepEqual(new Set(await complete(unit("过程 Run(载荷 为 变体型)\r\n变量 索引 为 整数型\r\n循环 索引 = 类型检验 载荷 是 文本型 ¦\r\n结束 过程"))), operators("至"));
});

test("隐式本对象解析自有属性和继承字段，静态过程拒绝实例字段并保留局部遮蔽", () => {
	const root = "C:\\project\\src";
	const item = parseSimpleUnitSymbols(unit("变量 成员 为 整数型\r\n过程 工作()\r\n结束 过程"), `${root}\\Item.simple`, root);
	const base = parseSimpleUnitSymbols(unit("变量 基础字段 为 Item\r\n静态 变量 共享字段 为 Item"), `${root}\\Base.simple`, root);
	for (const [head, receiver, local, valid] of [
		["过程 Run()", "子对象", "", true], ["过程 Run()", "基础字段", "", true], ["过程 Run()", "自有字段", "", true],
		["静态 过程 Run()", "子对象", "", false], ["静态 过程 Run()", "基础字段", "", false], ["静态 过程 Run()", "自有字段", "", false],
		["静态 过程 Run()", "共享字段", "", true], ["静态 过程 Run()", "自有字段", "变量 自有字段 为 Item\r\n", true]
	] as const) {
		const marked = "变量 自有字段 为 Item\r\n属性 子对象 为 Item\r\n获取\r\n结束 获取\r\n结束 属性\r\n"
			+ `${head}\r\n${local}变量 数 为 整数型\r\n数 = ${receiver}.¦\r\n结束 过程\r\n$属性\r\n$资源 $对象\r\n基础对象 = Base\r\n$结束 $属性\r\n`;
		const source = marked.replace(CURSOR, ""), caller = parseSimpleUnitSymbols(source, `${root}\\Caller.simple`, root);
		const context: SimpleProjectSemanticContext = { currentUnit: caller, units: [caller, base, item], manifest: {
			kind: "project", name: "test", directory: root, filePath: "C:\\project\\project.properties",
			categories: [{ name: "单元", definitions: [caller.definition, base.definition, item.definition] }]
		} };
		const names = provideSimpleCompletions(splitSimpleUnitSource(source).userCode, marked.indexOf(CURSOR), undefined, context)?.candidates.map((value) => value.name) ?? [];
		assert.equal(names.includes("成员"), valid, `${head}: ${receiver}: ${local}`);
	}
});

test("数组必须完整取下标，只写属性和裸方法不能作为成员接收者", async () => {
	const declarations = [
		"变量 按钮数组 为 按钮()", "变量 按钮矩阵 为 按钮(,)",
		"属性 只写对象 为 Test", "设置", "结束 设置", "结束 属性",
		"属性 只读数组 为 按钮()", "获取", "结束 获取", "结束 属性",
		"函数 工厂() 为 Test", "结束 函数", "过程 工作()", "结束 过程"
	].join("\r\n");
	for (const receiver of ["按钮数组", "(按钮数组)", "按钮矩阵(0)", "本对象.只写对象", "本对象.只读数组", "本对象.工厂", "本对象.只读数组(0)"]) {
		assert.deepEqual(await complete(unit(`${declarations}\r\n过程 Run()\r\n${receiver}.¦\r\n结束 过程`)), [], receiver);
	}
	for (const receiver of ["按钮数组(0)", "按钮矩阵(0, 1)", "只读数组(0)"]) {
		assert.ok((await complete(unit(`${declarations}\r\n过程 Run()\r\n${receiver}.¦\r\n结束 过程`))).includes("文本"), receiver);
	}
});

test("成员别名按原对象或数组解析，局部遮蔽及数组维数仍生效", async () => {
	const root = "C:\\project\\src";
	const holder = parseSimpleUnitSymbols(unit("静态 变量 实例 为 按钮\r\n静态 变量 数组 为 按钮(,)"), `${root}\\Holder.simple`, root);
	for (const [receiver, valid] of [["实例别名", true], ["连续别名", true], ["数组别名(0, 1)", true], ["实例别名()", false], ["数组别名", false], ["数组别名()", false], ["数组别名(0)", false]] as const) {
		const marked = unit(`别名 实例别名 = Holder.实例\r\n别名 连续别名 = 实例别名\r\n别名 数组别名 = Holder.数组\r\n过程 Run()\r\n变量 值 为 文本型\r\n值 = ${receiver}.¦\r\n结束 过程`);
		const source = marked.replace(CURSOR, "");
		const caller = parseSimpleUnitSymbols(source, `${root}\\Caller.simple`, root);
		const context: SimpleProjectSemanticContext = { currentUnit: caller, units: [holder, caller], manifest: {
			kind: "project", name: "test", directory: root, filePath: "C:\\project\\project.properties", categories: [{ name: "单元", definitions: [holder.definition, caller.definition] }]
		} };
		const names = provideSimpleCompletions(splitSimpleUnitSource(source).userCode, marked.indexOf(CURSOR), await sdkPromise, context)?.candidates.map((value) => value.name) ?? [];
		assert.equal(names.includes("文本"), valid, receiver);
		const shadowed = source.replace("变量 值", "变量 实例别名 为 整数型\r\n变量 连续别名 为 整数型\r\n变量 数组别名 为 整数型\r\n变量 值");
		assert.deepEqual(provideSimpleCompletions(splitSimpleUnitSource(shadowed).userCode, shadowed.indexOf(`${receiver}.`) + receiver.length + 1, await sdkPromise, context)?.candidates, [], receiver);
	}
});

test("调用或下标后的成员可以取值，但不能继续调用或取下标", async () => {
	const declarations = "变量 实例 为 按钮\r\n变量 数组 为 按钮()\r\n函数 工厂() 为 按钮\r\n结束 函数";
	for (const receiver of ["工厂()", "数组(0)", "(实例)"]) {
		const candidates = await completionCandidates(unit(`${declarations}\r\n过程 Run()\r\n变量 值 为 文本型\r\n值 = ${receiver}.¦\r\n结束 过程`));
		assert.ok(candidates.some((value) => value.name === "文本"), receiver);
		assert.ok(candidates.every((value) => value.kind !== "function"), receiver);
		assert.deepEqual(await complete(unit(`${declarations}\r\n过程 Run()\r\n${receiver}.¦设置焦点()\r\n结束 过程`)), [], receiver);
	}
	assert.ok((await completionCandidates(unit(`${declarations}\r\n过程 Run()\r\n实例.¦\r\n结束 过程`))).some((value) => value.kind === "function"));
});

test("循环与退出头按语法阶段提示，表达式未结束时仍允许取值", async () => {
	const source = (statement: string) => unit(`变量 索引 为 整数型\r\n变量 项 为 整数型\r\n变量 数组 为 整数型()\r\n过程 Run()\r\n${statement}\r\n结束 过程`);
	assert.deepEqual(new Set(await complete(source("循环 索引 = 0 ¦"))), operators("至"));
	assert.deepEqual(await complete(source("循环 每个 项 ¦")), ["从"]);
	assert.deepEqual(new Set(await complete(source("循环 索引 = 0 至 10 ¦"))), operators("步进"));
	assert.deepEqual(await complete(source("退出 ¦")), ["过程"]);
	assert.deepEqual(new Set(await complete(source("循环 索引 = 0 至 10\r\n退出 ¦"))), new Set(["过程", "循环"]));
	for (const header of ["循环 索引 = 索¦", "循环 索引 = 0 至 索¦", "循环 索引 = 0 至 10 步进 索¦"]) {
		assert.ok((await complete(source(header))).includes("索引"), header);
	}
});

test("单行分支、否则和循环收尾分别限制合法候选", async () => {
	const source = (statement: string) => unit(`变量 索引 为 整数型\r\n过程 Run()\r\n${statement}\r\n结束 过程`);
	for (const prefix of ["如果 真 则", "如果 假 则 索引 = 0 否则"]) {
		assert.deepEqual(new Set(await complete(source(`${prefix} 退出 ¦`))), new Set(prefix.endsWith("否则") ? ["过程"] : ["过程", "否则"]), prefix);
		const names = await complete(source(`${prefix} ¦`));
		assert.ok(names.includes("退出"));
		assert.ok(names.includes("触发事件"));
		assert.equal(names.includes("变量"), false);
		assert.equal(names.includes("创建"), false);
	}
	const afterElse = await complete(source("如果 真 则\r\n否则\r\n¦\r\n结束 如果"));
	assert.equal(afterElse.includes("否则"), false);
	assert.equal(afterElse.includes("否则如果"), false);
	assert.ok((await complete(source("如果 真 则\r\n否则\r\n如果 真 则\r\n¦\r\n结束 如果\r\n结束 如果"))).includes("否则"));
	for (const header of ["循环 索引 = 0 至 3", "循环 每个 索引 从 数组"]) {
		assert.deepEqual(await complete(source(`${header}\r\n下个 ¦`)), ["索引"]);
		assert.deepEqual(await complete(source(`${header}\r\n结束 ¦\r\n下个`)), []);
	}
	assert.deepEqual(await complete(source("执行\r\n结束 ¦\r\n直到 真")), []);
	assert.ok((await complete(source("执行\r\n直¦到 真"))).includes("直到"));
});

test("判断和错误处理按分支、范围及默认分支阶段筛选", async () => {
	const source = (body: string) => unit(`过程 Run()\r\n变量 数值 为 整数型\r\n${body}\r\n结束 过程`);
	assert.deepEqual(await complete(source("位于 ¦")), ["错误"]);
	for (const header of ["判断 数值", "位于 错误"]) {
		assert.deepEqual(new Set(await complete(source(`${header}\r\n¦`))), new Set(["分支", "结束"]));
		const start = await complete(source(`${header}\r\n分支 ¦`));
		assert.ok(start.includes("否则"));
		assert.equal(start.includes("数值"), header.startsWith("判断"));
		if (header.startsWith("位于")) assert.ok(start.includes("非法参数错误"));
		assert.equal(start.includes("是"), header.startsWith("判断"));
		assert.deepEqual(await complete(source(`${header}\r\n分支 否则 ¦`)), []);
		const defaultBody = await complete(source(`${header}\r\n分支 否则\r\n¦`));
		assert.equal(defaultBody.includes("分支"), false);
		assert.ok(defaultBody.includes("结束"));
	}
	assert.deepEqual(new Set(await complete(source("判断 数值\r\n分支 1 ¦"))), operators("至"));
	assert.ok((await complete(source("判断 数值\r\n分支 1 至 数¦"))).includes("数值"));
	assert.deepEqual(new Set(await complete(source("判断 数值\r\n分支 是 ¦"))), new Set(["=", "<>", "<", "<=", ">", ">="]));
	const next = await complete(source("判断 数值\r\n分支 1, ¦"));
	assert.ok(next.includes("是"));
	assert.equal(next.includes("否则"), false);
});

test("类型限定成员优先静态变量和方法，同类优先自有声明，常量靠后", () => {
	const root = "C:\\project\\src";
	const base = parseSimpleUnitSymbols(unit("常量 A继承常量 为 整数型 = 1\r\n静态 变量 B继承变量 为 整数型\r\n静态 函数 C继承方法() 为 整数型\r\n结束 函数"), `${root}\\Base.simple`, root);
	const derived = parseSimpleUnitSymbols("常量 D当前常量 为 整数型 = 1\r\n静态 变量 Z窗口实例 为 Derived\r\n静态 函数 Y当前方法() 为 整数型\r\n结束 函数\r\n$属性\r\n$资源 $对象\r\n基础对象 = Base\r\n$结束 $属性\r\n", `${root}\\Derived.simple`, root);
	const marked = unit("过程 Run()\r\n变量 数 为 整数型\r\n数 = Derived.¦\r\n结束 过程");
	const source = marked.replace(CURSOR, "");
	const caller = parseSimpleUnitSymbols(source, `${root}\\Caller.simple`, root);
	const context: SimpleProjectSemanticContext = { currentUnit: caller, manifest: {
		kind: "project", name: "test", directory: root, filePath: "C:\\project\\project.properties",
		categories: [{ name: "单元", definitions: [base, derived, caller].map((value) => value.definition) }]
	} };
	const names = provideSimpleCompletions(splitSimpleUnitSource(source).userCode, marked.indexOf(CURSOR), undefined, context)?.candidates.map((value) => value.name) ?? [];
	assert.deepEqual(names, ["Y当前方法", "Z窗口实例", "B继承变量", "C继承方法", "D当前常量", "A继承常量"]);
});

test("类型检验按语法阶段提示是和逻辑连接符", async () => {
	const sourcePrefix = [
		"过程 Run()",
		"\t变量 消息载荷 为 变体型"
	];
	assert.deepEqual(await complete(unit([
		...sourcePrefix,
		"\t如果 类型检验 消息载荷 s¦",
		"\t结束 如果",
		"结束 过程"
	].join("\r\n"))), ["是"]);
	assert.ok((await complete(unit([
		...sourcePrefix,
		"\t如果 类型检验 消息载荷 是 rqs¦",
		"\t结束 如果",
		"结束 过程"
	].join("\r\n")))).includes("日期时间型"));
	assert.deepEqual(await complete(unit([
		...sourcePrefix,
		"\t如果 类型检验 消息载荷 是 日期时间型 则",
		"\t否则如果 类型检验 消息载荷 是 文本型 h¦",
		"\t结束 如果",
		"结束 过程"
	].join("\r\n"))), ["或"]);
	assert.deepEqual(await complete(unit([
		...sourcePrefix,
		"\t如果 类型检验 消息载荷 是 文本型 q¦",
		"\t结束 如果",
		"结束 过程"
	].join("\r\n"))), ["且"]);
});

test("属性声明只按访问器顺序提示获取和设置", async () => {
	const beforeAccessor = await complete(unit("属性 Value 为 整数型\r\n\thq¦\r\n结束 属性"));
	assert.deepEqual(beforeAccessor, ["获取"]);

	const afterGetter = await complete(unit([
		"属性 Value 为 整数型",
		"\t获取",
		"\t\tValue = 1",
		"\t结束 获取",
		"\tsz¦",
		"结束 属性"
	].join("\r\n")));
	assert.deepEqual(afterGetter, ["设置"]);

	const getterBody = await complete(unit([
		"属性 Value 为 整数型",
		"\t获取",
		"\t\trg¦",
		"\t结束 获取",
		"结束 属性"
	].join("\r\n")));
	assert.ok(getterBody.includes("如果"));
});

test("文件属性区、注释和字符串内不提供首拼补全", async () => {
	assert.deepEqual(await complete("$属性\r\n\t$资源 $对象\r\n\trg¦\r\n$结束 $属性"), []);
	assert.deepEqual(await complete(unit("过程 Run()\r\n\t' rg¦\r\n结束 过程")), []);
	assert.deepEqual(await complete(unit("过程 Run()\r\n\t变量 文本 为 文本型 = \"rg¦\"\r\n结束 过程")), []);
});

test("已知变量只提示其类型的实例成员，未知限定名不回退全库", async () => {
	const timer = await complete(unit([
		"过程 Run()",
		"\t变量 timer 为 计时器",
		"\ttimer.jg¦",
		"结束 过程"
	].join("\r\n")));
	assert.deepEqual(timer, ["间隔"]);

	const collection = await complete(unit([
		"过程 Run()",
		"\t变量 集合实例 为 集合",
		"\t集合实例.jr¦",
		"结束 过程"
	].join("\r\n")));
	assert.deepEqual(collection, ["加入"]);

	assert.deepEqual(await complete(unit("过程 Run()\r\n\t未知对象.jr¦\r\n结束 过程")), []);
});

test("点号左侧只提示能继续访问成员的接收者，普通成员列表不包含事件", async () => {
	const declarations = [
		"变量 按钮1 为 按钮", "变量 按钮2 为 按钮", "变量 按数 为 整数型", "变量 按数组 为 整数型()",
		"常量 按常量 为 整数型 = 1",
		"函数 按取控件() 为 按钮", "结束 函数",
		"过程 按过程()", "结束 过程",
		"事件 按下某键()", "结束 事件", ""
	].join("\r\n");
	const receiver = await completionCandidates(unit(declarations + '过程 Run()\r\n按¦钮1.文本 = "111"\r\n结束 过程'));
	const names = receiver.map((candidate) => candidate.name);
	assert.ok(names.includes("按钮1"));
	assert.ok(names.includes("按钮2"));
	for (const name of ["按数", "按数组", "按常量", "按取控件", "按过程", "按下某键"]) assert.equal(names.includes(name), false, name);
	const members = await completionCandidates(unit(declarations + "过程 Run()\r\n按钮1.¦\r\n结束 过程"));
	assert.ok(members.some((candidate) => candidate.name === "文本"));
	assert.ok(members.some((candidate) => candidate.name === "销毁"));
	assert.equal(members.some((candidate) => candidate.kind === "event"), false);
});

test("事件声明和触发事件只提示事件，触发事件的实参仍提示表达式值", async () => {
	const declarations = [
		"事件 完成(结果 为 整数型)", "结束 事件",
		"变量 完成值 为 整数型",
		"函数 完成函数() 为 整数型", "结束 函数",
		"过程 完成过程()", "结束 过程", ""
	].join("\r\n");
	for (const statement of ["触发事件 ¦", "触发事件 完¦成(1)", "如果 真 则 触发事件 完¦成(1)"]) {
		const candidates = await completionCandidates(unit(declarations + `过程 Run()\r\n${statement}\r\n结束 过程`));
		assert.deepEqual(candidates.map((candidate) => candidate.name), ["完成"], statement);
		assert.ok(candidates.every((candidate) => candidate.kind === "event"));
	}
	const header = await completionCandidates(unit(declarations + "事件 Test.完¦成(结果 为 整数型)\r\n结束 事件"));
	assert.deepEqual(header.map((candidate) => candidate.name), ["完成"]);
	const arguments_ = await completionCandidates(unit(declarations + "过程 Run()\r\n触发事件 完成(完¦成值)\r\n结束 过程"));
	assert.ok(arguments_.some((candidate) => candidate.name === "完成值"));
	assert.ok(arguments_.some((candidate) => candidate.name === "完成函数"));
	assert.equal(arguments_.some((candidate) => candidate.name === "完成过程" || candidate.kind === "event"), false);
	assert.deepEqual(await complete(unit(declarations + "静态 过程 Run()\r\n触发事件 ¦\r\n结束 过程")), []);
});

test("独立语句不提示只取值常量，赋值右侧、参数和条件仍可读取常量", async () => {
	const declarations = "变量 按钮1 为 按钮\r\n变量 数 为 整数型\r\n";
	for (const statement of ["按钮1.¦", "如果 真 则 按钮1.¦", "如果 假 则 数 = 1 否则 按钮1.¦"]) {
		const candidates = await completionCandidates(unit(declarations + `过程 Run()\r\n${statement}\r\n结束 过程`));
		assert.equal(candidates.some((candidate) => candidate.kind === "constant"), false, statement);
		assert.ok(candidates.some((candidate) => candidate.name === "文本"), statement);
		assert.ok(candidates.some((candidate) => candidate.name === "销毁"), statement);
	}
	for (const statement of ["数 = 按钮1.¦", '输出信息("tag", 按钮1.¦)', "如果 按钮1.¦ = 1 则"]) {
		const candidates = await completionCandidates(unit(declarations + `过程 Run()\r\n${statement}\r\n结束 过程`));
		assert.ok(candidates.some((candidate) => candidate.name === "布局_单帧" && candidate.kind === "constant"), statement);
	}
});

test("独立语句排除只读标量，保留可赋值项、调用、数组和可继续访问的对象", async () => {
	const declarations = [
		"常量 常量值 为 整数型 = 1", "变量 变量值 为 整数型",
		"属性 只读数 为 整数型", "获取", "结束 获取", "结束 属性",
		"属性 只读数组 为 整数型()", "获取", "结束 获取", "结束 属性",
		"属性 只读对象 为 Test", "获取", "结束 获取", "结束 属性",
		"函数 函数值() 为 整数型", "结束 函数", "过程 过程值()", "结束 过程"
	].join("\r\n");
	const candidates = await complete(unit(`${declarations}\r\n过程 Run()\r\n¦\r\n结束 过程`));
	for (const name of ["常量值", "只读数"]) assert.equal(candidates.includes(name), false, name);
	for (const name of ["变量值", "函数值", "过程值", "只读数组", "只读对象"]) assert.ok(candidates.includes(name), name);
});

test("成员别名仍按实际用途筛选，不能用别名绕过常量的语句限制", async () => {
	const declarations = "别名 日期常量 = 日期时间操作.日期_年\r\n别名 日期函数 = 日期时间操作.格式化时间\r\n";
	const statement = await completionCandidates(unit(`${declarations}过程 Run()\r\n日期¦\r\n结束 过程`));
	assert.equal(statement.some((candidate) => candidate.name === "日期常量"), false);
	assert.equal(statement.find((candidate) => candidate.name === "日期函数")?.kind, "reference");
	const value = await complete(unit(`${declarations}过程 Run()\r\n变量 数 为 整数型\r\n数 = 日期¦\r\n结束 过程`));
	assert.ok(value.includes("日期常量"));
	const shortNames = "别名 短常量 = 日期_年\r\n别名 短函数 = 输出信息\r\n别名 短链 = 短函数\r\n";
	const shortStatement = await complete(unit(`${shortNames}过程 Run()\r\n短¦\r\n结束 过程`));
	assert.ok(shortStatement.includes("短函数") && shortStatement.includes("短链"));
	assert.equal(shortStatement.includes("短常量"), false);
});

test("赋值目标排除常量和方法，取值位置排除过程与只写属性", async () => {
	const sdk = await sdkPromise;
	const configuredSdk: Sdk = { ...sdk, manifests: [...sdk.manifests, {
		directory: "C:\\sdk\\libraries\\context", filePath: "C:\\sdk\\libraries\\context\\library.json", kind: "library", name: "语境测试库",
		categories: [{ name: "语境对象", definitions: [{
			name: "语境对象", type: "test.context.语境对象", kind: "object",
			constants: [{ name: "常量", type: "整数型" }], variables: [{ name: "字段", type: "整数型" }, { name: "子对象", type: "test.context.语境对象" }],
			properties: [{ name: "只读", type: "整数型", writable: false }, { name: "只写", type: "整数型", readable: false }, { name: "值", type: "整数型" }],
			functions: [{ name: "方法值", return: "整数型" }, { name: "方法过程" }], events: [{ name: "事件" }]
		}] }]
	}] };
	const source = (statement: string): string => unit(`函数 工厂(输入 为 整数型) 为 语境对象\r\n结束 函数\r\n\r\n过程 Run()\r\n变量 控件 为 语境对象\r\n${statement}\r\n结束 过程`);
	for (const statement of ["控件.¦ = 1", "如果 真 则 控件.¦ = 1", "如果 假 则 控件.字段 = 1 否则 控件.¦ = 2"]) {
		const candidates = await completionCandidatesForFile(source(statement), "Test.simple", configuredSdk);
		assert.deepEqual(new Set(candidates.map((candidate) => candidate.name)), new Set(["字段", "子对象", "只写", "值"]), statement);
	}
	for (const statement of ["控件.字段 = 控件.¦", "输出信息(\"tag\", 控件.¦)", "如果 控件.¦ = 1 则", "控件.字段 = 1 + 控件.¦", "控件.字段 = _\r\n控件.¦"]) {
		const candidates = await completionCandidatesForFile(source(statement), "Test.simple", configuredSdk);
		const names = candidates.map((candidate) => candidate.name);
		for (const name of ["常量", "字段", "只读", "值", "方法值"]) assert.ok(names.includes(name), `${statement}: ${name}`);
		for (const name of ["只写", "方法过程", "事件"]) assert.equal(names.includes(name), false, `${statement}: ${name}`);
	}
	for (const statement of ["控件.¦", "工厂(1 + 2).¦"]) {
		const ordinary = await completionCandidatesForFile(source(statement), "Test.simple", configuredSdk);
		assert.equal(ordinary.some((candidate) => candidate.name === "方法过程"), statement === "控件.¦", statement);
		assert.ok(ordinary.some((candidate) => candidate.name === "字段"), statement);
		assert.equal(ordinary.some((candidate) => candidate.kind === "event"), false);
	}
	for (const statement of ["控件.子¦目标.字段 = 1", "工厂(1 + 2).子¦目标.字段 = 1"]) {
		const receiver = await completionCandidatesForFile(source(statement), "Test.simple", configuredSdk);
		assert.deepEqual(receiver.map((candidate) => candidate.name), ["子对象"], statement);
	}
});

test("新声明名称不提示已有符号，形参类型和函数返回值仍正常补全", async () => {
	for (const declaration of [
		"常量 ¦", "常量 最¦大值 为 整数型 = 1", "别名 已¦有 = simple.runtime.文本操作",
		"函数 新¦名称() 为 整数型", "过程 新¦名称()", "属性 新¦名称 为 整数型", "事件 新¦事件()",
		"函数 新名称(¦)", "函数 新名称(参¦数 为 文本型)", "过程 新名称(传址 ¦)",
		"过程 新名称(数组 为 整数型(,), 参¦数 为 文本型)"
	]) assert.deepEqual(await complete(unit(declaration)), [], declaration);
	assert.ok((await complete(unit("函数 新名称(参数 为 文¦本型) 为 整数型"))).includes("文本型"));
	assert.ok((await complete(unit("函数 新名称() 为 文¦本型"))).includes("文本型"));
	const result = await completionCandidates(unit("函数 计算() 为 整数型\r\n计¦算 = 1\r\n结束 函数"));
	assert.deepEqual(result.filter((candidate) => candidate.name === "计算").map((candidate) => candidate.kind), ["variable"]);
});

test("创建对象与创建数组分别筛选类型，接口仅可作为数组元素", async () => {
	const sdk = await sdkPromise;
	const configuredSdk: Sdk = { ...sdk, manifests: [...sdk.manifests, {
		directory: "C:\\sdk\\libraries\\context", filePath: "C:\\sdk\\libraries\\context\\library.json", kind: "library", name: "创建测试库",
		categories: [{ name: "类型", definitions: [{ name: "测试接口", type: "test.context.测试接口", kind: "interface" }] }]
	}] };
	const objectTypes = await completionCandidatesForFile(unit("过程 Run()\r\n变量 值 为 对象型\r\n值 = 创建 ¦\r\n结束 过程"), "Test.simple", configuredSdk);
	assert.ok(objectTypes.some((candidate) => candidate.name === "计时器"));
	assert.ok(objectTypes.some((candidate) => candidate.name === "对象"));
	assert.equal(objectTypes.some((candidate) => candidate.name === "整数型" || candidate.name === "测试接口"), false);
	for (const type of ["整¦数型", "测试¦接口"]) {
		const candidates = await completionCandidatesForFile(unit(`过程 Run()\r\n变量 值 为 对象型\r\n值 = 创建 ${type}(10)\r\n结束 过程`), "Test.simple", configuredSdk);
		assert.ok(candidates.some((candidate) => candidate.name === type.replace(CURSOR, "")), type);
	}
	assert.ok((await completionCandidatesForFile(unit("过程 Run()\r\n变量 值 为 对象型\r\n值 = 创建 文¦本型 _\r\n(10)\r\n结束 过程"), "Test.simple", configuredSdk)).some((candidate) => candidate.name === "文本型"));
	const declaration = await completionCandidatesForFile(unit("变量 值 为 测试¦接口"), "Test.simple", configuredSdk);
	assert.ok(declaration.some((candidate) => candidate.name === "测试接口"));
});

test("SDK 类型支持首拼、静态成员首拼和全局函数首拼", async () => {
	const typeNames = await complete(unit("过程 Run()\r\n\t变量 值 为 sz¦\r\n结束 过程"));
	assert.ok(typeNames.includes("数组操作"));
	assert.ok((await complete(unit("过程 Run()\r\n\t变量 值 为 dx¦\r\n结束 过程"))).includes("对象"));
	assert.ok((await complete(unit("过程 Run()\r\n\t变量 值 为 an¦\r\n结束 过程"))).includes("按钮"));
	assert.ok((await complete(unit("过程 Run()\r\n\t变量 值 为 mb¦\r\n结束 过程"))).includes("面板"));
	assert.ok((await complete(unit("过程 Run()\r\n\t变量 值 为 ck¦\r\n结束 过程"))).includes("窗口"));

	const qualified = await complete(unit("过程 Run()\r\n\t文本操作.fgwb¦\r\n结束 过程"));
	assert.deepEqual(qualified, ["分割文本"]);

	const global = await complete(unit("过程 Run()\r\n\tfgwb¦\r\n结束 过程"));
	assert.ok(global.includes("分割文本"));
});

test("对象方法迁移后按新归属补全并保留全局短名", async () => {
	assert.deepEqual(await complete(unit("过程 Run()\r\n\t对象操作.qdxlm¦\r\n结束 过程")), ["取对象类名"]);
	assert.deepEqual(await complete(unit("过程 Run()\r\n\t其它操作.qdxlm¦\r\n结束 过程")), []);
	assert.deepEqual(await complete(unit("过程 Run()\r\n\t其它操作.qdym¦\r\n结束 过程")), ["取单元名"]);
	assert.ok((await complete(unit("过程 Run()\r\n\tqdxlm¦\r\n结束 过程"))).includes("取对象类名"));
});

test("弹出菜单组件提供父子项方法补全", async () => {
	const source = [
		"过程 Run()",
		"\t变量 菜单 为 弹出菜单",
		"\t菜单.zfx¦",
		"结束 过程"
	].join("\r\n");
	assert.deepEqual(await complete(unit(source)), ["置父项"]);
});

test("只有创建真实组件后才限定提示位于，普通对象与未知类型不冒充组件", async () => {
	for (const name of ["Test", "日期时间操作", "未安装类型"]) {
		assert.equal((await complete(unit(`过程 Run()\r\n变量 值 为 对象型\r\n值 = 创建 ${name} ¦\r\n结束 过程`))).includes("位于"), false, name);
	}
	assert.deepEqual(new Set(await complete(unit("别名 控件类型 = 按钮\r\n过程 Run()\r\n变量 值 为 按钮\r\n值 = 创建 控件类型 ¦\r\n结束 过程"))), operators("位于"));
});

test("创建组件类型后按语法位置提示位于", async () => {
	assert.deepEqual(
		await complete(unit("过程 Run()\r\n\t变量 a1 为 变体型 = 创建 按钮 wy¦\r\n结束 过程")),
		["位于"]
	);
	assert.deepEqual(
		await complete(unit("过程 Run()\r\n\t变量 a1 为 变体型 = 创建 simple.runtime.components.按钮 wy¦\r\n结束 过程")),
		["位于"]
	);
	assert.ok(!(
		await complete(unit("过程 Run()\r\n\t变量 a1 为 变体型 = 按钮 wy¦\r\n结束 过程"))
	).includes("位于"));
});

test("变量从创建初始化器推断组件类型并提供实例成员", async () => {
	const members = await complete(unit([
		"过程 Run()",
		"\t变量 a1 为 变体型 = 创建 按钮 位于 面板1",
		"\ta1.wb¦",
		"结束 过程"
	].join("\r\n")));
	assert.ok(members.includes("文本"));
});

test("变体型只在当前创建赋值可确认类型后提供对应成员", async () => {
	const beforeAssignment = await complete(unit([
		"过程 Run()",
		"\t变量 value 为 变体型",
		"\tvalue.jg¦",
		"结束 过程"
	].join("\r\n")));
	assert.deepEqual(beforeAssignment, []);

	const afterAssignment = await complete(unit([
		"过程 Run()",
		"\t变量 value 为 变体型",
		"\tvalue = 创建 计时器",
		"\tvalue.jg¦",
		"结束 过程"
	].join("\r\n")));
	assert.deepEqual(afterAssignment, ["间隔"]);

	const afterUnknownAssignment = await complete(unit([
		"过程 Run(other 为 变体型)",
		"\t变量 value 为 变体型",
		"\tvalue = 创建 计时器",
		"\tvalue = other",
		"\tvalue.jg¦",
		"结束 过程"
	].join("\r\n")));
	assert.deepEqual(afterUnknownAssignment, []);
});

test("变体初始化不锁死后续类型，同名内层声明不污染外层绑定", () => {
	const root = "C:\\project\\src";
	const a = parseSimpleUnitSymbols(unit("变量 甲值 为 整数型"), `${root}\\A.simple`, root);
	const b = parseSimpleUnitSymbols(unit("变量 乙值 为 整数型"), `${root}\\B.simple`, root);
	for (const [body, expected] of [
		["变量 值 为 变体型 = 创建 A\r\n值 = 创建 B", ["乙值"]],
		["变量 值 为 变体型 = 创建 A\r\n值 = 空", []],
		["变量 值 为 变体型\r\n值 = 创建 A\r\n如果 真 则\r\n变量 值 为 变体型\r\n值 = 创建 B\r\n结束 如果", ["甲值"]],
		["变量 值 为 变体型 = 创建 A\r\n如果 真 则\r\n值 = 创建 B\r\n结束 如果", []],
		["变量 值 为 变体型 = 创建 A\r\n如果 真 则 值 = 创建 B", []],
		["变量 值 为 变体型 = 创建 A\r\n值 = _\r\n创建 B", ["乙值"]]
	] as const) {
		const marked = unit(`过程 Run()\r\n${body}\r\n变量 数 为 整数型\r\n数 = 值.¦\r\n结束 过程`);
		const source = marked.replace(CURSOR, ""), caller = parseSimpleUnitSymbols(source, `${root}\\Caller.simple`, root);
		const context: SimpleProjectSemanticContext = { currentUnit: caller, units: [caller, a, b], manifest: {
			kind: "project", name: "test", directory: root, filePath: "C:\\project\\project.properties",
			categories: [{ name: "单元", definitions: [caller.definition, a.definition, b.definition] }]
		} };
		assert.deepEqual(provideSimpleCompletions(splitSimpleUnitSource(source).userCode, marked.indexOf(CURSOR), undefined, context)?.candidates.map((value) => value.name) ?? [], expected, body);
	}
});

test("变体不把创建比较结果当作对象，当前字段的限定赋值更新同一绑定", async () => {
	const root = "C:\\project\\src";
	const a = parseSimpleUnitSymbols(unit("变量 甲值 为 整数型"), `${root}\\A.simple`, root);
	const b = parseSimpleUnitSymbols(unit("变量 乙值 为 整数型"), `${root}\\B.simple`, root);
	for (const [prefix, body, receiver, expected] of [
		["", "变量 值 为 变体型 = 创建 A 是 空", "值", []],
		["", "变量 值 为 变体型\r\n值 = 创建 A 是 空", "值", []],
		["", "变量 值 为 变体型\r\n值 = 创建 A(3)", "值(0)", ["甲值"]],
		["变量 值 为 变体型 = 创建 A\r\n", "本对象.值 = 创建 B", "值", ["乙值"]],
		["变量 值 为 变体型 = 创建 A\r\n", "本对象.值 = 创建 B", "本对象.值", ["乙值"]],
		["静态 变量 值 为 变体型 = 创建 A\r\n", "Caller.值 = 创建 B", "Caller.值", ["乙值"]],
		["变量 值 为 变体型 = 创建 A\r\n", "变量 值 为 变体型 = 创建 A\r\n本对象.值 = 创建 B", "值", ["甲值"]],
		["变量 值 为 变体型 = 创建 A\r\n", "变量 值 为 变体型 = 创建 A\r\n本对象.值 = 创建 B", "本对象.值", ["乙值"]],
		["变量 值 为 变体型 = 创建 A\r\n", "变量 其它 为 Caller\r\n本对象.值 = 创建 B", "其它.值", []]
	] as const) {
		const marked = unit(`${prefix}过程 Run()\r\n${body}\r\n变量 数 为 整数型\r\n数 = ${receiver}.¦\r\n结束 过程`);
		const source = marked.replace(CURSOR, ""), caller = parseSimpleUnitSymbols(source, `${root}\\Caller.simple`, root);
		const context: SimpleProjectSemanticContext = { currentUnit: caller, units: [caller, a, b], manifest: {
			kind: "project", name: "test", directory: root, filePath: "C:\\project\\project.properties",
			categories: [{ name: "单元", definitions: [caller.definition, a.definition, b.definition] }]
		} };
		for (const sdk of [undefined, await sdkPromise]) {
			assert.deepEqual(provideSimpleCompletions(splitSimpleUnitSource(source).userCode, marked.indexOf(CURSOR), sdk, context)?.candidates.map((value) => value.name) ?? [], expected, `${body} → ${receiver}`);
		}
	}
});

test("初值、静态加载事件和实例初始化按编译器上下文筛选成员", async () => {
	const prefix = "常量 上限 为 整数型 = 3\r\n变量 实例值 为 整数型\r\n静态 变量 静态值 为 整数型\r\n函数 求值() 为 整数型\r\n结束 函数\r\n静态 函数 静态求值() 为 整数型\r\n结束 函数\r\n过程 动作()\r\n结束 过程\r\n";
	for (const [body, allowed, forbidden] of [
		["变量 初值 为 整数型 = ¦", ["上限", "实例值", "求值", "静态值", "静态求值", "本对象"], ["动作"]],
		["静态 变量 初值 为 整数型 = ¦", ["上限", "静态值", "静态求值"], ["实例值", "求值", "动作", "本对象"]],
		["常量 新常量 为 整数型 = ¦", ["上限"], ["实例值", "求值", "静态值", "动作", "创建", "本对象"]],
		["事件 Test.加载()\r\n静态¦\r\n结束 事件", ["静态值", "静态求值"], ["实例值", "求值", "本对象"]],
		["事件 Test.初始化()\r\n本¦对象\r\n结束 事件", ["本对象"], ["加载"]]
	] as const) {
		const names = await complete(unit(prefix + body));
		for (const name of allowed) assert.ok(names.includes(name), `${body} 应提示 ${name}`);
		for (const name of forbidden) assert.equal(names.includes(name), false, `${body} 不应提示 ${name}`);
	}
});

test("声明、表达式和完整语句按阶段保留合法运算符，排除相邻的多余值", async () => {
	for (const query of ["如果 文本 匹¦配 \"a\" 则", "如果 真 异¦或 假 则", "循环 数 = 1 异¦或 2 至 3", "判断 数\r\n分支 1 异¦或 2"]) {
		const names = await complete(unit(`过程 Run(数 为 整数型, 文本 为 文本型)\r\n${query}\r\n结束 过程`));
		assert.ok(names.includes(query.includes("匹") ? "匹配" : "异或"), query);
	}
	for (const query of ["数 = 1 ¦", "退出 过程 ¦", "过程 新过程(参数 为 整数型 ¦)"]) {
		const names = await complete(unit(`变量 字段 为 整数型\r\n过程 Run(数 为 整数型)\r\n${query}\r\n结束 过程`));
		assert.equal(names.includes("字段"), false, query);
		assert.equal(names.includes("数"), false, query);
	}
});

test("循环目标与错误类型位置排除不可赋值成员、过程和普通类型", async () => {
	const prefix = "常量 固定 为 整数型 = 1\r\n变量 数字 为 整数型\r\n变量 数组 为 整数型()\r\n变量 对象值 为 Test\r\n过程 动作()\r\n结束 过程\r\n";
	for (const each of [false, true]) {
		const values = await complete(unit(prefix + `过程 Run()\r\n循环 ${each ? "每个 " : ""}¦\r\n结束 过程`));
		assert.ok(values.includes("数字"));
		assert.equal(values.includes("固定") || values.includes("动作"), false);
		assert.equal(values.includes("对象值"), each);
		assert.equal(values.includes("数组"), each);
	}
	const errors = await complete(unit(prefix + "过程 Run()\r\n位于 错误\r\n分支 ¦\r\n结束 过程"));
	assert.ok(errors.includes("非法参数错误"));
	for (const name of ["数字", "数组", "动作", "文本型", "按钮"]) assert.equal(errors.includes(name), false, name);
	const source = await complete(unit(prefix + "过程 Run()\r\n循环 每个 数字 从 ¦\r\n结束 过程"));
	assert.ok(source.includes("数组"));
	assert.equal(source.includes("动作"), false);
});

test("错误分支的限定名按段补全，只列出能到达错误类型的命名空间", async () => {
	const base = await sdkPromise;
	const sdk: Sdk = { ...base, manifests: [...base.manifests, {
		kind: "library", name: "错误类型", filePath: "C:\\sdk\\errors\\library.json", directory: "C:\\sdk\\errors",
		categories: [{ name: "类型", definitions: [
			{ name: "外部错误", type: "extra.errors.外部错误", kind: "error" },
			{ name: "普通对象", type: "extra.errors.普通对象", kind: "object" }
		] }]
	}] };
	const marked = unit("过程 Run()\r\n位于 错误\r\n分支 extra.errors.外¦部错误\r\n结束 错误\r\n结束 过程");
	const values = await completionCandidatesForFile(marked, "Test.simple", sdk);
	assert.deepEqual(values.map((candidate) => candidate.name), ["外部错误"]);
});

test("事件绑定支持普通对象字段，刚输入点号也能查到事件，声明本身不能执行语句", async () => {
	const root = "C:\\project\\src";
	const emitter = parseSimpleUnitSymbols(unit("事件 完成(结果 为 整数型)\r\n结束 事件"), `${root}\\Emitter.simple`, root);
	for (const [query, expected] of [["事件 ¦", "发射器"], ["事件 发射器.¦", "完成"], ["事件 发射器.完¦", "完成"]] as const) {
		const marked = unit(`变量 发射器 为 Emitter\r\n${query}`), source = marked.replace(CURSOR, "");
		const caller = parseSimpleUnitSymbols(source, `${root}\\Caller.simple`, root);
		const context: SimpleProjectSemanticContext = { currentUnit: caller, units: [caller, emitter], manifest: {
			kind: "project", name: "test", directory: root, filePath: `${root}\\project.properties`,
			categories: [{ name: "单元", definitions: [caller.definition, emitter.definition] }]
		} };
		const values = provideSimpleCompletions(splitSimpleUnitSource(source).userCode, marked.indexOf(CURSOR), await sdkPromise, context)?.candidates ?? [];
		assert.ok(values.some((candidate) => candidate.name === expected), query);
	}
	assert.deepEqual(await complete(unit("事件 自定义()\r\n¦\r\n结束 事件")), ["结束"]);
});

test("成员别名目标提示静态成员与全局函数，接受文本不携带调用括号", async () => {
	for (const [query, expected] of [["对象操作.调¦用方法", "调用方法"], ["simple.runtime.对象操作.调¦用方法", "调用方法"], ["输出信¦息", "输出信息"]] as const) {
		const candidates = await completionCandidates(unit(`别名 工具 = ${query}`));
		assert.ok(candidates.some((candidate) => candidate.name === expected), query);
		assert.ok(candidates.every((candidate) => candidate.snippet === undefined), query);
	}
});

test("循环写入与传址调用撤销旧变体类型，传值调用保持确认的创建类型", async () => {
	const root = "C:\\project\\src";
	const a = parseSimpleUnitSymbols(unit("变量 甲值 为 整数型"), `${root}\\A.simple`, root);
	const b = parseSimpleUnitSymbols(unit("变量 乙值 为 整数型"), `${root}\\B.simple`, root);
	for (const [parameters, body, expected] of [
		["传址 值 为 变体型", "改值(值)", []], ["传值 值 为 变体型", "改值(值)", ["甲值"]],
		["值 为 变体型", "循环 每个 值 从 数组", []],
		["传址 值 为 变体型", "如果 真 则 改值(值)", []]
	] as const) {
		const marked = unit(`过程 改值(${parameters})\r\n结束 过程\r\n过程 Run()\r\n变量 值 为 变体型 = 创建 A\r\n变量 数组 为 B()\r\n${body}\r\n变量 数 为 整数型\r\n数 = 值.¦\r\n结束 过程`);
		const source = marked.replace(CURSOR, ""), caller = parseSimpleUnitSymbols(source, `${root}\\Caller.simple`, root);
		const context: SimpleProjectSemanticContext = { currentUnit: caller, units: [caller, a, b], manifest: {
			kind: "project", name: "test", directory: root, filePath: `${root}\\project.properties`,
			categories: [{ name: "单元", definitions: [caller.definition, a.definition, b.definition] }]
		} };
		assert.deepEqual(provideSimpleCompletions(splitSimpleUnitSource(source).userCode, marked.indexOf(CURSOR), await sdkPromise, context)?.candidates.map((candidate) => candidate.name) ?? [], expected, `${parameters}: ${body}`);
	}
});

test("全局常量参与首拼，静态函数不提示本对象", async () => {
	const globalConstant = await complete(unit("过程 Run()\r\n\t变量 值 为 整数型\r\n\t值 = rq_n¦\r\n结束 过程"));
	assert.ok(globalConstant.includes("日期_年"));

	const instanceContext = await complete(unit("过程 Run()\r\n\tbdx¦\r\n结束 过程"));
	assert.ok(instanceContext.includes("本对象"));

	const staticContext = await complete(unit("静态 过程 Run()\r\n\tbdx¦\r\n结束 过程"));
	assert.ok(!staticContext.includes("本对象"));
});

test("当前作用域的用户符号统一支持首拼补全", async () => {
	const source = (query: string): string => unit([
		"别名 时间类型 = 日期时间操作",
		"常量 最大次数 为 整数型 = 3",
		"变量 当前计数 为 整数型",
		"属性 显示文本 为 文本型",
		"获取", "结束 获取", "设置", "结束 设置",
		"结束 属性",
		"函数 计算总数() 为 整数型",
		"结束 函数",
		"过程 刷新界面()",
		"结束 过程",
		"事件 初始化()",
		"结束 事件",
		"过程 Run(请求文本 为 文本型)",
		"	变量 临时结果 为 整数型",
		`\t${query}¦`,
		"结束 过程"
	].join("\r\n"));
	const expected = [
		["qqwb", "请求文本"],
		["lsjg", "临时结果"],
		["dqjs", "当前计数"],
		["当前计数 = zdcs", "最大次数"],
		["xswb", "显示文本"],
		["jszs", "计算总数"],
		["sxjm", "刷新界面"],
		["sjlx", "时间类型"]
	] as const;

	for (const [query, name] of expected) {
		assert.ok((await complete(source(query))).includes(name), `${query} 应提示 ${name}`);
	}
	assert.equal((await complete(source("csh"))).includes("初始化"), false);
	assert.ok((await complete(source("触发事件 csh"))).includes("初始化"));
});

test("显式传值和传址参数在过程体内参与补全", async () => {
	const candidates = await complete(unit([
		"过程 Run(传值 text 为 文本型, 传址 accept 为 逻辑型)",
		"\tacc¦",
		"结束 过程"
	].join("\r\n")));
	assert.ok(candidates.includes("accept"));
});

test("局部符号只在声明后的当前函数式作用域参与首拼", async () => {
	const beforeDeclaration = await complete(unit([
		"过程 Run(请求文本 为 文本型)",
		"	qqwb¦",
		"	变量 晚值 为 整数型",
		"结束 过程"
	].join("\r\n")));
	assert.ok(beforeDeclaration.includes("请求文本"));
	assert.ok(!beforeDeclaration.includes("晚值"));

	const otherProcedure = await complete(unit([
		"过程 First()",
		"	变量 临时结果 为 整数型",
		"结束 过程",
		"过程 Second()",
		"	lsjg¦",
		"结束 过程"
	].join("\r\n")));
	assert.ok(!otherProcedure.includes("临时结果"));

	const functionResult = await complete(unit([
		"函数 计算结果() 为 整数型",
		"	jsjg¦",
		"结束 函数"
	].join("\r\n")));
	assert.ok(functionResult.includes("计算结果"));
});

test("局部名称遮蔽外层不同种类候选，函数返回值仍允许递归调用", async () => {
	const source = [
		"常量 同名值 为 整数型 = 1", "函数 同名方法() 为 整数型", "结束 函数",
		"过程 Run(同名值 为 文本型)", "变量 同名方法 为 整数型()", "变量 文本操作 为 整数型",
		"同¦名值", "结束 过程"
	].join("\r\n");
	const candidates = await completionCandidates(unit(source));
	assert.equal(candidates.filter((candidate) => candidate.name === "同名值").length, 1);
	assert.equal(candidates.find((candidate) => candidate.name === "同名值")?.kind, "variable");
	assert.equal(candidates.find((candidate) => candidate.name === "同名方法")?.kind, "variable");
	assert.equal(candidates.some((candidate) => candidate.kind === "function" && candidate.name === "同名方法"), false);
	const typeShadow = await completionCandidates(unit(source.replace("同¦名值", "文¦本操作")));
	assert.equal(typeShadow.some((candidate) => candidate.kind === "type" && candidate.name === "文本操作"), false);
	const recursion = await completionCandidates(unit("函数 计算结果() 为 整数型\r\n计算结果 = 计¦算结果()\r\n结束 函数"));
	assert.ok(recursion.some((candidate) => candidate.kind === "function" && candidate.name === "计算结果"));
	const globalShadow = await completionCandidates(unit("变量 输出信息 为 整数型\r\n过程 Run()\r\n输¦出信息\r\n结束 过程"));
	assert.equal(globalShadow.filter((candidate) => candidate.name === "输出信息").length, 1);
	assert.equal(globalShadow.find((candidate) => candidate.name === "输出信息")?.kind, "variable");
	const staticShadow = await complete(unit("变量 输出信息 为 整数型\r\n静态 过程 Run()\r\n输¦出信息\r\n结束 过程"));
	assert.equal(staticShadow.includes("输出信息"), false);
});

test("类型别名支持类型位置首拼和静态成员补全", async () => {
	const typeAlias = await complete(unit([
		"别名 日期类型 = 日期时间操作",
		"过程 Run()",
		"	变量 value 为 rqlx¦",
		"结束 过程"
	].join("\r\n")));
	assert.ok(typeAlias.includes("日期类型"));

	const aliasMember = await complete(unit([
		"别名 日期类型 = 日期时间操作",
		"过程 Run()",
		"\t变量 值 为 整数型", "\t值 = 日期类型.rq_n¦",
		"结束 过程"
	].join("\r\n")));
	assert.ok(aliasMember.includes("日期_年"));
});

test("项目别名实例合并跨单元自有成员和基础对象成员", () => {
	const sourceRoot = "C:\\project\\src";
	const base = parseSimpleUnitSymbols([
		"过程 基础过程()",
		"结束 过程",
		"$属性",
		"\t$资源 $对象",
		"$结束 $属性"
	].join("\r\n"), `${sourceRoot}\\pkg\\Base.simple`, sourceRoot);
	const derived = parseSimpleUnitSymbols([
		"过程 自有过程()",
		"结束 过程",
		"$属性",
		"\t$资源 $对象",
		"\t基础对象 = pkg.Base",
		"$结束 $属性"
	].join("\r\n"), `${sourceRoot}\\pkg\\Derived.simple`, sourceRoot);
	const marked = [
		"别名 A = pkg.Derived",
		"过程 Run()",
		"\t变量 value 为 A",
		"\tvalue.¦",
		"结束 过程",
		"$属性",
		"\t$资源 $对象",
		"$结束 $属性"
	].join("\r\n");
	const offset = marked.indexOf("¦");
	const source = marked.replace("¦", "");
	const caller = parseSimpleUnitSymbols(source, `${sourceRoot}\\Caller.simple`, sourceRoot);
	const userCode = splitSimpleUnitSource(source).userCode;
	const context: SimpleProjectSemanticContext = {
		currentUnit: caller,
		manifest: {
			categories: [{
				definitions: [base, derived, caller].map((entry) => ({
					...entry.definition,
					aliases: [entry.name]
				})),
				hidden: true,
				name: "项目单元"
			}],
			directory: "C:\\project",
			filePath: "C:\\project\\project.properties",
			kind: "project",
			name: "测试项目"
		}
	};
	const candidates = provideSimpleCompletions(userCode, offset, undefined, context)?.candidates ?? [];

	assert.deepEqual(candidates.map((candidate) => candidate.name), ["基础过程", "自有过程"]);
	assert.ok(candidates.every((candidate) => candidate.snippet?.endsWith("()") === true));
});

test("同名过程按参数个数分别提供补全项", () => {
	const sourceRoot = "C:\\project\\src";
	const marked = [
		"过程 执行()",
		"结束 过程",
		"过程 执行(value 为 整数型)",
		"结束 过程",
		"过程 Run()",
		"\t执¦",
		"结束 过程",
		"$属性",
		"\t$资源 $对象",
		"$结束 $属性"
	].join("\r\n");
	const offset = marked.indexOf(CURSOR);
	const source = marked.replace(CURSOR, "");
	const current = parseSimpleUnitSymbols(source, `${sourceRoot}\\Overload.simple`, sourceRoot);
	const context: SimpleProjectSemanticContext = {
		currentUnit: current,
		manifest: {
			categories: [{ definitions: [current.definition], hidden: true, name: "项目单元" }],
			directory: "C:\\project",
			filePath: "C:\\project\\project.properties",
			kind: "project",
			name: "测试项目"
		}
	};
	const candidates = provideSimpleCompletions(
		splitSimpleUnitSource(source).userCode,
		offset,
		undefined,
		context
	)?.candidates.filter((candidate) => candidate.name === "执行") ?? [];

	assert.deepEqual(candidates.map((candidate) => candidate.overloadArity), [0, 1]);
	assert.deepEqual(candidates.map((candidate) => candidate.snippet), ["执行()", "执行(${1:value})"]);
});

test("扩展类库同名方法重载分别提供补全项", async () => {
	const candidates = await completionCandidates(unit([
		"过程 Run()",
		"\t变量 list 为 simple.library.wsd.grouplist.分组列表框",
		"\tlist.tjzx¦",
		"结束 过程"
	].join("\r\n")));
	const overloads = candidates.filter((candidate) => candidate.name === "添加子项");

	// 重载沿用清单声明顺序，每个签名保留自己的参数占位符。
	assert.deepEqual(overloads.map((candidate) => candidate.overloadArity), [6, 2]);
	assert.equal(overloads[0]?.snippet, "添加子项(${1:分组索引}, ${2:图片}, ${3:标题}, ${4:信息}, ${5:按钮图片}, ${6:按钮标题})");
	assert.equal(overloads[1]?.snippet, "添加子项(${1:分组索引}, ${2:标题})");
});

test("变体型布局不推断具体成员，显式布局变量正常提示", async () => {
	const variantLayout = await complete([
		"事件 Test.初始化()",
		"\t面板1.布局.¦",
		"结束 事件",
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 Test $为 窗口",
		"\t\t$定义 面板1 $为 面板",
		"\t\t\t布局 = 布局_表格",
		"\t\t$结束 $定义",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.deepEqual(variantLayout, []);

	const typedLayout = await complete(unit([
		"过程 Run()",
		"\t变量 局_表格布局 为 表格布局",
		"\t局_表格布局.¦",
		"结束 过程"
	].join("\r\n")));
	assert.ok(typedLayout.includes("所有列可拉伸"));
	assert.ok(typedLayout.includes("置列可拉伸"));
});

test("别名目标位置支持跨命名空间类型补全", () => {
	const sourceRoot = "C:\\project\\src";
	const target = parseSimpleUnitSymbols(
		"$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n",
		`${sourceRoot}\\pkg\\tools\\Target.simple`,
		sourceRoot
	);
	const marked = "别名 T = pkg.tools.Ta¦";
	const offset = marked.indexOf("¦");
	const source = marked.replace("¦", "");
	const current = parseSimpleUnitSymbols(source, `${sourceRoot}\\Caller.simple`, sourceRoot);
	const context: SimpleProjectSemanticContext = {
		currentUnit: current,
		manifest: {
			categories: [{ definitions: [target.definition, current.definition], name: "项目单元" }],
			directory: "C:\\project",
			filePath: "C:\\project\\project.properties",
			kind: "project",
			name: "测试项目"
		}
	};
	const result = provideSimpleCompletions(source, offset, undefined, context);

	assert.deepEqual(result?.candidates.map((candidate) => candidate.name), ["pkg.tools.Target"]);
	assert.equal(source.slice(result?.start, result?.end), "pkg.tools.Ta");
});

test("项目类型限定名中间段不吞并前缀，也不重复右侧子路径", () => {
	const sourceRoot = "C:\\project\\src";
	const target = parseSimpleUnitSymbols(unit(""), `${sourceRoot}\\pkg\\tools\\deep\\Target.simple`, sourceRoot);
	for (const declaration of ["变量 值 为", "别名 类型 ="]) {
		const marked = `${declaration} pkg.to¦ols.deep.Target`;
		const offset = marked.indexOf(CURSOR);
		const source = marked.replace(CURSOR, "");
		const current = parseSimpleUnitSymbols(source, `${sourceRoot}\\Caller.simple`, sourceRoot);
		const context: SimpleProjectSemanticContext = {
			currentUnit: current,
			manifest: {
				categories: [{ definitions: [target.definition, current.definition], name: "项目单元" }],
				directory: "C:\\project", filePath: "C:\\project\\project.properties", kind: "project", name: "测试项目"
			}
		};
		const result = provideSimpleCompletions(source, offset, undefined, context);
		assert.deepEqual(result?.candidates.map((candidate) => candidate.name), ["tools"]);
		assert.equal(source.slice(result?.start, result?.end), "to");
	}
});

test("相对限定名的首段补全遵循当前命名空间和遮蔽关系", () => {
	const sourceRoot = "C:\\project\\src";
	const target = parseSimpleUnitSymbols(unit(""), `${sourceRoot}\\app\\tools\\deep\\Target.simple`, sourceRoot);
	for (const shadowed of [false, true]) {
		const marked = "变量 值 为 to¦ols.deep.Target";
		const offset = marked.indexOf(CURSOR);
		const source = marked.replace(CURSOR, "");
		const current = parseSimpleUnitSymbols(source, `${sourceRoot}\\app\\inner\\Caller.simple`, sourceRoot);
		const shadow = parseSimpleUnitSymbols(unit(""), `${sourceRoot}\\app\\inner\\tools.simple`, sourceRoot);
		const context: SimpleProjectSemanticContext = {
			currentUnit: current,
			manifest: {
				categories: [{ definitions: [target.definition, current.definition, ...(shadowed ? [shadow.definition] : [])], name: "项目单元" }],
				directory: "C:\\project", filePath: "C:\\project\\project.properties", kind: "project", name: "测试项目"
			}
		};
		const result = provideSimpleCompletions(source, offset, undefined, context);
		assert.deepEqual(result?.candidates.map((candidate) => candidate.name), shadowed ? [] : ["tools"]);
		assert.equal(source.slice(result?.start, result?.end), "to");
	}
});

test("表达式限定链按层提示命名空间和静态类型", () => {
	const sourceRoot = "C:\\project\\src";
	const target = parseSimpleUnitSymbols(
		"静态 过程 执行()\r\n结束 过程\r\n$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n",
		`${sourceRoot}\\pkg\\tools\\Target.simple`,
		sourceRoot
	);
	const completeProject = (query: string): readonly string[] => {
		const marked = `过程 Run()\r\n\t${query}¦\r\n结束 过程`;
		const offset = marked.indexOf("¦");
		const source = marked.replace("¦", "");
		const current = parseSimpleUnitSymbols(source, `${sourceRoot}\\Caller.simple`, sourceRoot);
		const context: SimpleProjectSemanticContext = {
			currentUnit: current,
			manifest: {
				categories: [{ definitions: [target.definition, current.definition], name: "项目单元" }],
				directory: "C:\\project",
				filePath: "C:\\project\\project.properties",
				kind: "project",
				name: "测试项目"
			}
		};
		return provideSimpleCompletions(source, offset, undefined, context)?.candidates.map(
			(candidate) => candidate.name
		) ?? [];
	};

	assert.deepEqual(completeProject("pkg.to"), ["tools"]);
	assert.deepEqual(completeProject("pkg.tools."), ["Target"]);
});

test("R 点号成员只补全当前项目 res 中已有的资源", () => {
	const marked = "过程 Run()\r\n\t图标 = R.drawable_¦\r\n结束 过程";
	const offset = marked.indexOf(CURSOR);
	const source = marked.replace(CURSOR, "");
	const sourceRoot = "C:\\project\\src";
	const current = parseSimpleUnitSymbols(source, `${sourceRoot}\\Main.simple`, sourceRoot);
	const context: SimpleProjectSemanticContext = {
		currentUnit: current,
		manifest: {
			categories: [{ definitions: [current.definition], name: "项目单元" }],
			directory: "C:\\project",
			filePath: "C:\\project\\project.properties",
			kind: "project",
			name: "资源测试"
		},
		resources: {
			objectQualifiedName: "sample.app.SimpleResources",
			projectDirectory: "C:\\project",
			symbols: [{
				name: "drawable_icon",
				resourceName: "icon",
				resourceType: "drawable",
				sourceFiles: ["C:\\project\\res\\drawable\\icon.png"]
			}, {
				name: "string_app_name",
				resourceName: "app_name",
				resourceType: "string",
				sourceFiles: ["C:\\project\\res\\values\\strings.xml"]
			}]
		}
	};
	const result = provideSimpleCompletions(source, offset, undefined, context);

	assert.deepEqual(result?.candidates.map((candidate) => candidate.name), ["drawable_icon"]);
	assert.equal(result?.candidates[0]?.kind, "constant");
	assert.equal(result?.candidates[0]?.description, "Android drawable 资源。");
	assert.doesNotMatch(result?.candidates[0]?.detail ?? "", /0x|&H/iu);

	const allSource = source.replace("R.drawable_", "R.");
	assert.deepEqual(
		provideSimpleCompletions(allSource, allSource.indexOf("R.") + 2, undefined, context)
			?.candidates.map((candidate) => candidate.name),
		["drawable_icon", "string_app_name"]
	);
});

test("组件实例和继承成员参与当前单元首拼补全", async () => {
	const component = await complete([
		"过程 Run()",
		"	zjsq¦",
		"结束 过程",
		"$属性",
		"	$资源 $窗口",
		"	$定义 Test $为 窗口",
		"		$定义 主计时器 $为 计时器",
		"		$结束 $定义",
		"	$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.ok(component.includes("主计时器"));

	const inherited = await complete([
		"过程 Run()",
		"	bjys¦",
		"结束 过程",
		"$属性",
		"	$资源 $对象",
		"	基础对象 = 窗口",
		"$结束 $属性"
	].join("\r\n"));
	assert.ok(inherited.includes("背景颜色"));
});

test("单行如果不建立块，续行条件和冒号语句保持正确语境", async () => {
	const afterSingleLineIf = await complete(unit([
		"过程 Run()",
		"\t如果 真 则 Run()",
		"\t结束 ¦",
		"结束 过程"
	].join("\r\n")));
	assert.deepEqual(afterSingleLineIf, ["过程"]);

	const continuedCondition = await complete(unit([
		"过程 Run()",
		"\t如果 真 且 _",
		"\t\t假 z¦",
		"\t结束 如果",
		"结束 过程"
	].join("\r\n")));
	assert.equal(continuedCondition[0], "则");

	const afterColon = await complete(unit("过程 Run()\r\n\tRun(): rg¦\r\n结束 过程"));
	assert.ok(afterColon.includes("如果"));
});

test("顶层字段和属性区组件可解析实例成员，非法下划线首字符不作为声明", async () => {
	const field = await complete(unit([
		"变量 timer 为 计时器",
		"过程 Run()",
		"\ttimer.jg¦",
		"结束 过程"
	].join("\r\n")));
	assert.deepEqual(field, ["间隔"]);

	const component = await complete([
		"过程 Run()",
		"\tTimer.jg¦",
		"结束 过程",
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 Test $为 窗口",
		"\t\t$定义 Timer $为 计时器",
		"\t\t$结束 $定义",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.deepEqual(component, ["间隔"]);

	const invalid = await complete(unit([
		"过程 Run()",
		"\t变量 _timer 为 计时器",
		"\t_timer.jg¦",
		"结束 过程"
	].join("\r\n")));
	assert.deepEqual(invalid, []);
});
