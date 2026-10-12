/*
验证引用诊断覆盖删除后的类型、变量、成员、接口与资源，并避免注释和变体误报。
xhwsd@qq.com 2026-10-10
*/

import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { createSimpleSourceAnalysis, resolveSimpleBinding, resolveSimpleQualifier } from "../completionModel";
import { simpleTestProjectPath, simpleTestUnitPath } from "./testProjects";
import { splitSimpleUnitSource } from "../simpleUnitSource";
import { test } from "node:test";
import { loadSdk } from "../sdk";
import { analyzeSimpleReferences, analyzeSimpleReferencesAsync } from "../referenceDiagnostics";
import { refactoringContext, simpleIdentifierSpans, type RefactoringUnit } from "../refactoringModel";
import { inspectSimplePropertyXml } from "../propertyXml";

const sdkPromise = loadSdk(path.resolve(__dirname, "../../../sdk/sdk.json"));

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
	const code = '事件 主窗口.初始化()\r\n\t图片框1.图片 = "images/missing.png"\r\n\t显示提示框("images/missing.png")\r\n\t变量 n 为 双精度小数型\r\n\tn = 1e3\r\n结束 事件\r\n';
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
