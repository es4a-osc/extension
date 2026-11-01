/*
验证引用诊断覆盖删除后的类型、变量、成员、接口与资源，并避免注释和变体误报。
xhwsd@qq.com 2026-10-10
*/

import { testSdkPath } from "./testFixtures";

import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { createSimpleSourceAnalysis, provideSimpleCompletions, resolveSimpleBinding, resolveSimpleQualifier } from "../completionModel";
import { findSimpleDefinition } from "../definitionModel";
import { findSimpleKeywordHover } from "../keywordHover";
import { listSimpleFiles } from "../simpleFileDiscovery";
import { parseSimpleUnitSymbolsFromModel } from "../simpleUnitSymbols";
import { simpleTestProjectPath, simpleTestUnitPath } from "./testProjects";
import { splitSimpleUnitSource } from "../simpleUnitSource";
import { test } from "node:test";
import { loadSdk, type Sdk } from "../sdk";
import { buildDocumentTokenRules, tokenizeSimpleText } from "../compilerTokens";
import { analyzeSimpleReferences, analyzeSimpleReferencesAsync } from "../referenceDiagnostics";
import { refactoringContext, simpleIdentifierSpans, type RefactoringUnit } from "../refactoringModel";
import { inspectSimplePropertyXml } from "../propertyXml";

const sdkPromise = loadSdk(testSdkPath());

test("静态工具与实例继承常量在诊断、补全、悬停、跳转和着色中使用同一访问规则", async () => {
	const baseSdk = await sdkPromise;
	const sdk: Sdk = {
		...baseSdk,
		manifests: [...baseSdk.manifests, {
			name: "访问规则测试库", kind: "library", directory: "C:/diagnostics/sdk/library", filePath: "C:/diagnostics/sdk/library/library.json",
			categories: [{ name: "测试", definitions: [
				{ name: "工具", kind: "object", type: "example.工具", functions: [{ name: "取品牌", static: true, return: "文本型" }] },
				{ name: "基类", kind: "object", type: "example.基类", constants: [{ name: "轮播效果_深度", type: "文本型", value: '"Depth"' }] },
				{ name: "图片轮播", kind: "object", type: "example.图片轮播", inherits: ["example.基类"], functions: [{ name: "置效果", params: [{ name: "效果", type: "文本型" }] }] }
			] }]
		}]
	};
	const code = [
		"变量 轮播 为 example.图片轮播", "过程 Run()",
		"\texample.工具.取品牌()", "\t轮播.置效果(轮播.轮播效果_深度)",
		"\t轮播.置效果(example.基类.轮播效果_深度)", "结束 过程", ""
	].join("\r\n");
	const unit: RefactoringUnit = { filePath: path.resolve("C:/diagnostics/src/对象1.simple"), sourceRoot: path.resolve("C:/diagnostics/src"), userCode: code, property: inspectSimplePropertyXml("$属性\r\n$资源 $对象\r\n$结束 $属性\r\n") };
	const context = refactoringContext(unit, [unit]);
	assert.deepEqual(analyzeSimpleReferences(code, sdk, context), []);
	for (const [qualifier, name, owner] of [["example.工具", "取品牌", "工具"], ["轮播", "轮播效果_深度", "基类"], ["example.基类", "轮播效果_深度", "基类"]] as const) {
		const offset = code.indexOf(`${qualifier}.${name}`) + qualifier.length + 1;
		assert.equal(findSimpleDefinition(code, offset, sdk, context)?.librarySymbol?.definitionName, owner);
		assert.equal(findSimpleKeywordHover(code, offset, sdk, context)?.name, name);
		assert.ok(provideSimpleCompletions(code, offset, sdk, context)?.candidates.some((candidate) => candidate.name === name));
	}
	const tokens = tokenizeSimpleText(code, buildDocumentTokenRules(code, sdk, context));
	assert.equal(tokens.filter((token) => token.text === "轮播效果_深度" && token.type === "variable" && token.modifiers.includes("readonly")).length, 2);
	assert.ok(tokens.some((token) => token.text === "取品牌" && token.type === "method"));

	// 常量例外不放宽其它成员：实例方法不能经类型调用，静态函数也不会变成全局函数。
	const invalid = code.replace("结束 过程", '\texample.图片轮播.置效果("Depth")\r\n\t取品牌()\r\n\t轮播.不存在\r\n结束 过程');
	assert.deepEqual(analyzeSimpleReferences(invalid, sdk, refactoringContext({ ...unit, userCode: invalid }, [{ ...unit, userCode: invalid }])).map((issue) => [issue.code, invalid.slice(issue.start, issue.end)]), [
		["unknownMember", "置效果"], ["unknownName", "取品牌"], ["unknownMember", "不存在"]
	]);
});

test("跨物理行的事件、过程及函数参数保留声明位置、传址和作用域", async () => {
	const sdk = await sdkPromise;
	for (const eol of ["\r\n", "\n"]) {
		for (const [declaration, ending] of [["过程 处理", "过程"], ["静态 函数 处理", "函数"], ["事件 传感器.加速度改变", "事件"]]) {
			const code = [
				`${declaration}(传值 横向值 为 _`, "\t单精度小数型, 纵向值 为 单精度小数型, _",
				`\t传址 垂直值 为 单精度小数型)${ending === "函数" ? " 为 单精度小数型" : ""}`,
				"\t横向值 = 纵向值 + 垂直值", `结束 ${ending}`,
				"过程 Outside()", "\t横向值 = 1", "结束 过程", ""
			].join(eol);
			const property = inspectSimplePropertyXml(["$属性", "$资源 $窗口", "$定义 主窗口 $为 窗口", "$定义 传感器 $为 加速度传感器", "$结束 $定义", "$结束 $定义", "$结束 $属性", ""].join(eol));
			const unit: RefactoringUnit = { filePath: path.resolve("C:/diagnostics/src/主窗口.simple"), sourceRoot: path.resolve("C:/diagnostics/src"), userCode: code, property };
			const context = refactoringContext(unit, [unit]);
			const analysis = createSimpleSourceAnalysis(code, sdk, context);
			const issues = analyzeSimpleReferences(code, sdk, context, property.document);
			assert.deepEqual(issues.map((issue) => [issue.code, issue.start]), [["unknownName", code.lastIndexOf("横向值")]], `${declaration} ${JSON.stringify(eol)}`);
			assert.deepEqual(await analyzeSimpleReferencesAsync(code, sdk, context, property.document), issues);
			for (const name of ["横向值", "纵向值", "垂直值"]) {
				const declarationStart = code.indexOf(name);
				const bodyStart = code.indexOf(name, code.indexOf("\t横向值 ="));
				for (const offset of [declarationStart, bodyStart]) {
					const binding = resolveSimpleBinding(code, offset, name, context, analysis);
					assert.equal(binding?.kind, "parameter");
					assert.equal(binding?.declarationStart, declarationStart);
					assert.equal(binding?.passing, name === "垂直值" ? "传址" : name === "横向值" ? "传值" : undefined);
					assert.deepEqual(binding, resolveSimpleBinding(code, offset, name, context));
					assert.equal(findSimpleDefinition(code, offset, sdk, context)?.targetOffset, declarationStart);
					assert.equal(findSimpleKeywordHover(code, offset, sdk, context)?.name, name);
				}
			}
			const candidates = provideSimpleCompletions(code, code.indexOf("\t横向值 =") + 1, sdk, context)?.candidates;
			assert.ok(["横向值", "纵向值", "垂直值"].every((name) => candidates?.some((candidate) => candidate.name === name)));
		}
	}
});

test("十六进制数字和续行符不是名称，真实同名标识符仍报告诊断", async () => {
	const sdk = await sdkPromise;
	for (const eol of ["\r\n", "\n"]) {
		const code = [
			"过程 Run()", "\t断言真(&H4 = &H4)", "\t断言真(&Hff = &HFF)",
			"\t断言真(&H800080008000 = &H800080008000)", "\t变量 文本 为 文本型",
			"\t文本 = \"&H4 _\" _", "\t\t& \"内容\" _", "\t\t& \"尾部\"",
			"\tH4 = 1", "\t文本 = 文本 & HFF", "\t不存在 = 2", "结束 过程", ""
		].join(eol);
		const unit: RefactoringUnit = { filePath: path.resolve("C:/diagnostics/src/对象1.simple"), sourceRoot: path.resolve("C:/diagnostics/src"), userCode: code, property: inspectSimplePropertyXml("$属性\r\n$资源 $对象\r\n$结束 $属性\r\n") };
		const context = refactoringContext(unit, [unit]);
		const issues = analyzeSimpleReferences(code, sdk, context);
		assert.deepEqual(issues.map((issue) => [issue.code, code.slice(issue.start, issue.end)]), [
			["unknownName", "H4"], ["unknownName", "HFF"], ["unknownName", "不存在"]
		]);
		assert.deepEqual(await analyzeSimpleReferencesAsync(code, sdk, context), issues);
	}
});

test("真实 SmokeTest 全项目无误报，当前单元静态字段支持限定名、补全、悬停和跳转", async () => {
	const sdk = await sdkPromise;
	const sourceRoot = simpleTestProjectPath("SmokeTest", "src");
	const units: RefactoringUnit[] = await Promise.all((await listSimpleFiles(sourceRoot)).map(async (filePath) => {
		const source = await fs.readFile(filePath, "utf8");
		return { filePath, sourceRoot, userCode: splitSimpleUnitSource(source).userCode, property: inspectSimplePropertyXml(source) };
	}));
	const symbols = units.map((unit) => parseSimpleUnitSymbolsFromModel(unit.userCode, unit.property, unit.filePath, unit.sourceRoot));
	assert.ok(units.length >= 36, "应覆盖完整的编译器冒烟项目");
	for (const unit of units) {
		const context = refactoringContext(unit, units, undefined, symbols);
		assert.deepEqual(analyzeSimpleReferences(unit.userCode, sdk, context, unit.property.document), [], path.relative(sourceRoot, unit.filePath));
	}
	const current = units.find((unit) => path.basename(unit.filePath) === "ScopesTest.simple")!;
	const context = refactoringContext(current, units, undefined, symbols);
	for (const [qualified, name] of [["simple.smoketest.scopes.ScopesTest.var2", "var2"], ["ScopesTest.var3", "var3"]] as const) {
		const start = current.userCode.indexOf(qualified);
		assert.notEqual(start, -1);
		const offset = start + qualified.length - name.length;
		const member = context.currentUnit!.definition.variables!.find((value) => value.name === name)!;
		assert.equal(member.static, true);
		const target = findSimpleDefinition(current.userCode, offset, sdk, context);
		assert.equal(target?.filePath, current.filePath);
		assert.equal(target?.targetOffset, member.declarationOffset);
		const hover = findSimpleKeywordHover(current.userCode, offset, sdk, context);
		assert.equal(hover?.name, name);
		assert.equal(hover?.declarationSource, context.currentUnit!.qualifiedName);
		assert.ok(provideSimpleCompletions(current.userCode, offset, sdk, context)?.candidates.some((candidate) => candidate.name === name));
	}
});

test("真实 JSON 样例的多行拼接不报告续行名称", async () => {
	const sdk = await sdkPromise;
	const filePath = await simpleTestUnitPath("SmokeTests", "测试JSON操作");
	const sourceRoot = simpleTestProjectPath("SmokeTests", "src");
	const units: RefactoringUnit[] = await Promise.all((await listSimpleFiles(sourceRoot)).map(async (unitPath) => {
		const source = await fs.readFile(unitPath, "utf8");
		return { filePath: unitPath, sourceRoot, userCode: splitSimpleUnitSource(source).userCode, property: inspectSimplePropertyXml(source) };
	}));
	const unit = units.find((value) => value.filePath === filePath)!;
	assert.match(unit.userCode, /_(?:\r\n|\n)/u);
	assert.deepEqual(analyzeSimpleReferences(unit.userCode, sdk, refactoringContext(unit, units), unit.property.document), []);
});

test("单元类型与实例访问保持区分，事件声明仍解析继承事件", async () => {
	const sdk = await sdkPromise;
	const code = [
		"静态 变量 静态计时器 为 计时器", "变量 实例字段 为 文本型",
		"事件 当前.运行()", "结束 事件", "过程 Run()",
		"\t当前.静态计时器.间隔 = 100", "\t当前.实例字段 = \"不允许类型访问实例字段\"",
		"\t变量 当前 为 计时器", "\t当前.间隔 = 10", "\t当前.静态计时器 = 空", "结束 过程", ""
	].join("\r\n");
	const unit: RefactoringUnit = { filePath: path.resolve("C:/diagnostics/src/当前.simple"), sourceRoot: path.resolve("C:/diagnostics/src"), userCode: code, property: inspectSimplePropertyXml("$属性\r\n$资源 $对象\r\n基础对象 = 线程\r\n$结束 $属性\r\n") };
	const context = refactoringContext(unit, [unit]);
	assert.deepEqual(analyzeSimpleReferences(code, sdk, context, unit.property.document).map((issue) => [issue.code, code.slice(issue.start, issue.end)]), [
		["unknownMember", "实例字段"], ["unknownMember", "静态计时器"]
	]);
});

test("当前窗口和对象的加载、初始化处理器不按普通成员误报", async () => {
	const sdk = await sdkPromise;
	for (const kind of ["窗口", "对象"] as const) {
		const code = "事件 主窗口.加载()\r\n结束 事件\r\n\t事件 主窗口 . 初始化 ()\r\n结束 事件\r\n";
		const property = inspectSimplePropertyXml(kind === "窗口"
			? "$属性\r\n$资源 $窗口\r\n$定义 主窗口 $为 窗口\r\n$结束 $定义\r\n$结束 $属性\r\n"
			: "$属性\r\n$资源 $对象\r\n$结束 $属性\r\n");
		const unit: RefactoringUnit = { filePath: path.resolve("C:/diagnostics/src/app/主窗口.simple"), sourceRoot: path.resolve("C:/diagnostics/src"), userCode: code, property };
		const context = refactoringContext(unit, [unit]);
		assert.deepEqual(analyzeSimpleReferences(code, sdk, context, property.document), [], kind);
		assert.deepEqual(await analyzeSimpleReferencesAsync(code, sdk, context, property.document), [], kind);
	}
});

test("单元事件特例不放过普通调用、其它组件和未知事件名称", async () => {
	const sdk = await sdkPromise;
	const code = [
		"事件 主窗口.加载()", "结束 事件",
		"事件 主窗口.不存在事件()", "结束 事件",
		"事件 其它窗口.加载()", "结束 事件",
		"过程 P()", "\t主窗口.加载()", "\t主窗口.不存在成员()", "结束 过程", ""
	].join("\r\n");
	const property = inspectSimplePropertyXml("$属性\r\n$资源 $窗口\r\n$定义 主窗口 $为 窗口\r\n$定义 其它窗口 $为 窗口\r\n$结束 $定义\r\n$结束 $定义\r\n$结束 $属性\r\n");
	const unit: RefactoringUnit = { filePath: path.resolve("C:/diagnostics/src/app/主窗口.simple"), sourceRoot: path.resolve("C:/diagnostics/src"), userCode: code, property };
	const issues = analyzeSimpleReferences(code, sdk, refactoringContext(unit, [unit]), property.document);
	assert.deepEqual(issues.map((issue) => ({ code: issue.code, name: code.slice(issue.start, issue.end) })), [
		{ code: "unknownMember", name: "不存在事件" },
		{ code: "unknownMember", name: "加载" },
		{ code: "unknownMember", name: "加载" },
		{ code: "unknownMember", name: "不存在成员" }
	]);
});

test("真实 SmokeTests 主窗口的加载和初始化声明无误报", async () => {
	const sdk = await sdkPromise;
	const file = await simpleTestUnitPath("SmokeTests", "主窗口");
	const original = await fs.readFile(file, "utf8");
	const code = splitSimpleUnitSource(original).userCode;
	const unit: RefactoringUnit = { filePath: file, sourceRoot: simpleTestProjectPath("SmokeTests", "src"), userCode: code, property: inspectSimplePropertyXml(original) };
	const issues = analyzeSimpleReferences(code, sdk, refactoringContext(unit, [unit]), unit.property.document);
	for (const name of ["加载", "初始化"]) {
		assert.ok(code.includes(`事件 主窗口.${name}()`));
		assert.equal(issues.some((issue) => issue.start === code.indexOf(name)), false, name);
	}
});

test("未知名称、类型、成员、资源和接口关系使用独立诊断", async () => {
	const sdk = await sdkPromise;
	const code = "变量 a 为 缺失类型\r\n过程 P()\r\n\t未声明变量 = 1\r\n\t变量 b 为 文本型\r\n\tb.不存在的成员()\r\n\t变量 c 为 变体型\r\n\tc.运行时成员()\r\n\t变量 x 为 整数型\r\n\tx = R.drawable_missing\r\n\t显示提示框(\"未声明变量\") ' 未声明变量\r\n结束 过程\r\n";
	const property = inspectSimplePropertyXml("$属性\r\n\t$资源 $对象\r\n\t实现接口 = app.已删除接口\r\n$结束 $属性\r\n");
	const unit: RefactoringUnit = { filePath: path.resolve("C:/diagnostics/src/app/对象1.simple"), sourceRoot: path.resolve("C:/diagnostics/src"), userCode: code, property };
	const context = refactoringContext(unit, [unit], { objectQualifiedName: "app.SimpleResources", projectDirectory: "C:/diagnostics", symbols: [] });
	const issues = analyzeSimpleReferences(code, sdk, context, property.document);
	assert.equal(issues.filter((issue) => issue.code === "unknownType").length, 1);
	assert.equal(issues.filter((issue) => issue.code === "unknownResource").length, 1);
	assert.equal(issues.filter((issue) => issue.code === "unknownRelation").length, 1);
	assert.equal(issues.filter((issue) => code.slice(issue.start, issue.end) === "未声明变量").length, 1);
	assert.equal(issues.some((issue) => issue.message.includes("运行时成员")), false);
	assert.equal(issues.some((issue) => issue.message.includes("显示提示")), false);
});

test("没有 SDK 时不误报 SDK 类型和全局函数", () => {
	const unit: RefactoringUnit = { filePath: path.resolve("C:/diagnostics/src/对象1.simple"), sourceRoot: path.resolve("C:/diagnostics/src"), userCode: "显示提示(\"内容\")\r\n", property: inspectSimplePropertyXml("$属性\r\n$资源 $对象\r\n$结束 $属性\r\n") };
	assert.deepEqual(analyzeSimpleReferences(unit.userCode, undefined, refactoringContext(unit, [unit])), []);
});


test("缺失资产仅诊断 SDK 资产属性，数字指数与普通文本不误报", async () => {
	const sdk = await sdkPromise;
	const code = '事件 主窗口.初始化()\r\n\t图片框1.图片 = "images/missing.png"\r\n\t显示提示框("images/missing.png")\r\n\t变量 n 为 双精度小数型\r\n\tn = 1.0e3\r\n结束 事件\r\n';
	const property = inspectSimplePropertyXml('$属性\r\n\t$资源 $窗口\r\n\t$定义 主窗口 $为 窗口\r\n\t\t$定义 图片框1 $为 图片框\r\n\t\t\t图片 = "images/missing.png"\r\n\t\t$结束 $定义\r\n\t$结束 $定义\r\n$结束 $属性\r\n');
	const unit: RefactoringUnit = { filePath: path.resolve("C:/diagnostics/src/主窗口.simple"), sourceRoot: path.resolve("C:/diagnostics/src"), userCode: code, property };
	const context = refactoringContext(unit, [unit]);
	const issues = analyzeSimpleReferences(code, sdk, context, property.document, new Set());
	assert.equal(issues.filter((issue) => issue.code === "unknownAsset").length, 2);
	assert.equal(issues.some((issue) => issue.message.includes("e3")), false);
	assert.equal(analyzeSimpleReferences(code, sdk, context, property.document, new Set(["images/missing.png"])).filter((issue) => issue.code === "unknownAsset").length, 0);
});


test("批量分析保留字段、局部遮蔽、传址参数、变体收窄及访问器作用域", async () => {
	const sdk = await sdkPromise;
	const code = [
		"变量 字段 为 整数型", "静态 变量 静态字段 为 文本型",
		"过程 P(传址 参数 为 变体型)", "\t字段 = 1", "\t参数 = 创建 计时器", "\t参数.启用 = 真",
		"\t变量 字段 为 文本型", "\t字段 = 创建 图片框", "\t如果 真 则 P(参数): 字段 = \"文本\"", "结束 过程",
		"过程 Q(续行参数 为 _", " 文本型)", "\t续行参数 = \"演示\"", "结束 过程",
		"属性 值 为 文本型", "\t获取", "\t\t变量 局部 为 文本型", "\t\t局部 = 静态字段", "\t结束 获取",
		"\t设置", "\t\t字段 = 1", "\t结束 设置", "结束 属性", ""
	].join("\r\n");
	const unit: RefactoringUnit = { filePath: path.resolve("C:/diagnostics/src/对象1.simple"), sourceRoot: path.resolve("C:/diagnostics/src"), userCode: code, property: inspectSimplePropertyXml("$属性\r\n$资源 $对象\r\n$结束 $属性\r\n") };
	const context = refactoringContext(unit, [unit]);
	const analysis = createSimpleSourceAnalysis(code, sdk, context);
	for (const span of simpleIdentifierSpans(code)) {
		assert.deepEqual(resolveSimpleBinding(code, span.start, span.name, context, analysis), resolveSimpleBinding(code, span.start, span.name, context), `绑定 ${span.name}@${span.start}`);
		assert.deepEqual(resolveSimpleQualifier(code, span.start, span.name, sdk, context, analysis), resolveSimpleQualifier(code, span.start, span.name, sdk, context), `限定链 ${span.name}@${span.start}`);
	}
	assert.deepEqual(await analyzeSimpleReferencesAsync(code, sdk, context, unit.property.document), analyzeSimpleReferences(code, sdk, context, unit.property.document));
});

test("真实大单元诊断让出线程，过期分析不返回半次结果", async () => {
	const sdk = await sdkPromise;
	const root = simpleTestProjectPath("SmokeTest", "src");
	const file = await simpleTestUnitPath("SmokeTest", "ArrayExpressionsTest");
	const original = await fs.readFile(file, "utf8");
	const unit: RefactoringUnit = { filePath: file, sourceRoot: root, userCode: splitSimpleUnitSource(original).userCode, property: inspectSimplePropertyXml(original) };
	const context = refactoringContext(unit, [unit]);
	let cancelled = false;
	const timer = setTimeout(() => { cancelled = true; }, 0);
	try {
		assert.equal(await analyzeSimpleReferencesAsync(unit.userCode, sdk, context, unit.property.document, undefined, () => cancelled), undefined);
		assert.equal(cancelled, true, "分析期间应允许其它事件执行");
	} finally { clearTimeout(timer); }
	assert.deepEqual(await analyzeSimpleReferencesAsync(unit.userCode, sdk, context, unit.property.document), analyzeSimpleReferences(unit.userCode, sdk, context, unit.property.document));
});
