/*
验证 Simple 编译器与运行库悬停的范围、类型绑定和文本语境过滤。
xhwsd@qq.com 2026-8-27
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { findSimpleKeywordHover, type SimpleKeywordHoverInfo } from "../keywordHover";
import { loadSdk, type Sdk } from "../sdk";
import { parseSimpleUnitSymbols, type SimpleProjectSemanticContext } from "../simpleUnitSymbols";
import { splitSimpleUnitSource } from "../simpleUnitSource";

const CURSOR = "¦";
const sdkPromise = loadSdk(path.resolve("..", "sdk", "sdk.json"));

/** 在标记位置查询关键字悬停。 */
async function hover(markedSource: string): Promise<SimpleKeywordHoverInfo | undefined> {
	const offset = markedSource.indexOf(CURSOR);
	assert.notEqual(offset, -1, "测试源码缺少光标标记");
	const source = markedSource.replace(CURSOR, "");
	const sdk: Sdk = await sdkPromise;
	return findSimpleKeywordHover(source, offset, sdk);
}

test("长关键字、操作符和属性区标记返回清单说明及准确范围", async () => {
	const elseIf = await hover("否则¦如果 真 则");
	assert.equal(elseIf?.name, "否则如果");
	assert.equal(elseIf?.category, "流程控制");
	assert.match(elseIf?.description ?? "", /继续判断/);
	assert.deepEqual([elseIf?.start, elseIf?.end], [0, 4]);

	const operator = await hover("如果 1 <¦= 2 则");
	assert.equal(operator?.name, "<=");
	assert.equal(operator?.kind, "operator");

	const propertyType = await hover("$资源 $服¦务");
	assert.equal(propertyType?.name, "$服务");
	assert.equal(propertyType?.category, "属性区");
	assert.notEqual((await hover("$资源 $线¦程"))?.name, "$线程");

	const objectType = await hover("变量 value 为 对¦象");
	assert.equal(objectType?.name, "对象");
	assert.equal(objectType?.kind, "type");
	assert.equal(objectType?.category, "数据类型");
	assert.equal(objectType?.description, "可保存对象实例引用或空值的数据类型。");

	const statementSeparator = await hover("Run() ¦: Next()");
	assert.equal(statementSeparator?.name, ":");
	assert.equal(statementSeparator?.kind, "punctuation");
	assert.equal(statementSeparator?.category, "标点符号");
	assert.equal(statementSeparator?.description, "显式结束当前语句，使下一条语句可以写在同一行。");
	assert.equal(await hover("Run¦()"), undefined);
});

test("关键字悬停跳过注释、字符串和更长标识符内部", async () => {
	assert.equal(await hover("' 如果¦"), undefined);
	assert.equal(await hover("文本 = \"如果¦\""), undefined);
	const longerIdentifier = await hover("变量 如果¦值 为 整数型");
	assert.equal(longerIdentifier?.name, "如果值");
	assert.equal(longerIdentifier?.kind, "field");
});

test("十六进制整数字面量悬停显示精确十进制值", async () => {
	const small = await hover("值 = ¦&H4");
	assert.equal(small?.name, "&H4");
	assert.equal(small?.kind, "literal");
	assert.equal(small?.category, "整数字面量");
	assert.equal(small?.signature, "&H4 = 4");
	assert.deepEqual([small?.start, small?.end], [4, 7]);

	const long = await hover("断言真(&H80008000¦8000 = &H800080008000)");
	assert.equal(long?.signature, "&H800080008000 = 140739635871744");
	assert.equal(await hover("值 = &h¦FF"), undefined);
	assert.equal(await hover("' &H¦FF"), undefined);
	assert.equal(await hover("文本 = \"&H¦FF\""), undefined);
});

test("运行库类型和全局函数返回清单说明与完整签名", async () => {
	const runtimeType = await hover("变量 timer 为 计¦时器");
	assert.equal(runtimeType?.name, "计时器");
	assert.equal(runtimeType?.kind, "component");
	assert.equal(runtimeType?.category, "组件");
	assert.match(runtimeType?.manifest ?? "", /运行库/);
	assert.equal(runtimeType?.declarationSource, "simple.runtime.components.计时器");
	assert.match(runtimeType?.description ?? "", /时间间隔/);
	assert.equal(runtimeType?.librarySymbol?.definitionName, "计时器");

	const globalFunction = await hover("分割¦文本(内容, 分隔符, 1)");
	assert.equal(globalFunction?.name, "分割文本");
	assert.equal(globalFunction?.kind, "functions");
	assert.equal(globalFunction?.owner, "数组操作");
	assert.equal(globalFunction?.declarationSource, "simple.runtime.数组操作");
	assert.match(globalFunction?.signature ?? "", /str 为 文本型/);
	assert.match(globalFunction?.signature ?? "", /文本型\(\)/);
	assert.equal(globalFunction?.librarySymbol?.memberGroup, "functions");
	assert.deepEqual(globalFunction?.parameters?.map((parameter) => parameter.description), [
		"欲分割的文本",
		"欲查找的分割文本",
		"分割次数"
	]);
});

test("组件事件处理过程保留当前单元归属并显示事件说明和定义来源", async () => {
	const queryEvent = async (documentation?: string): Promise<SimpleKeywordHoverInfo | undefined> => {
		const fullSource = [
			...(documentation === undefined ? [] : [`''' ${documentation}`]),
			"事件 按钮44.被单击()",
			"结束 事件",
			"",
			"$属性",
			"\t$资源 $窗口",
			"\t$定义 测试其它 $为 窗口",
			"\t\t$定义 按钮44 $为 按钮",
			"\t\t$结束 $定义",
			"\t$结束 $定义",
			"$结束 $属性"
		].join("\r\n");
		const userCode = splitSimpleUnitSource(fullSource).userCode;
		const unit = parseSimpleUnitSymbols(
			fullSource,
			"C:\\project\\src\\simple\\runtime\\smoketests\\测试其它.simple",
			"C:\\project\\src"
		);
		const context: SimpleProjectSemanticContext = {
			currentUnit: unit,
			manifest: {
				categories: [{ definitions: [unit.definition], hidden: true, name: "当前单元" }],
				directory: "C:\\project",
				filePath: "C:\\project\\project.properties",
				kind: "project",
				name: "冒烟测试"
			}
		};
		return findSimpleKeywordHover(
			userCode,
			userCode.indexOf("被单击") + 1,
			await sdkPromise,
			context
		);
	};

	const sdkDocumented = await queryEvent();
	assert.equal(sdkDocumented?.signature, "事件 按钮44.被单击()");
	assert.equal(sdkDocumented?.description, "默认单击事件处理方法。");
	assert.equal(sdkDocumented?.manifest, "冒烟测试");
	assert.equal(sdkDocumented?.declarationSource, "simple.runtime.smoketests.测试其它");
	assert.equal(
		sdkDocumented?.eventDefinition,
		"simple.runtime.components.按钮.被单击()"
	);

	const userDocumented = await queryEvent("用户定义的按钮事件处理说明。");
	assert.equal(userDocumented?.description, "用户定义的按钮事件处理说明。");
	assert.equal(
		userDocumented?.eventDefinition,
		"simple.runtime.components.按钮.被单击()"
	);
});

test("当前窗口单元的加载和初始化事件使用编译器对象事件说明", async () => {
	const sourceRoot = path.resolve("..", "simple", "tests", "simple", "runtime", "DeviceTests", "SmokeTests", "src");
	const sourceFile = path.join(sourceRoot, "simple", "runtime", "smoketests", "layouts", "局部布局.simple");
	const fullSource = await fs.readFile(sourceFile, "utf8");
	const unit = parseSimpleUnitSymbols(fullSource, sourceFile, sourceRoot);
	const userCode = splitSimpleUnitSource(fullSource).userCode;
	const context: SimpleProjectSemanticContext = {
		currentUnit: unit,
		manifest: {
			categories: [{ definitions: [unit.definition], hidden: true, name: "当前单元" }],
			directory: path.dirname(sourceRoot),
			filePath: path.join(path.dirname(sourceRoot), "project.properties"),
			kind: "project",
			name: "冒烟测试"
		}
	};
	assert.ok(unit.definition.variables?.some((member) => member.component === true && member.name === unit.name));

	for (const [eventName, description] of [
		["加载", "当该对象首次加载（使用）时触发。"],
		["初始化", "当该对象被创建（实例化）时触发。"]
	] as const) {
		const offset = userCode.indexOf(`事件 局部布局.${eventName}()`);
		assert.notEqual(offset, -1);
		const result = findSimpleKeywordHover(
			userCode,
			offset + `事件 局部布局.`.length + 1,
			await sdkPromise,
			context
		);
		assert.equal(result?.signature, `事件 局部布局.${eventName}()`);
		assert.ok(result?.description?.startsWith(description));
		assert.equal(result?.declarationSource, unit.qualifiedName);
		assert.equal(result?.manifest, "冒烟测试");
	}
});

test("完整代码属性区名称和对象类名提供悬停且不污染用户代码", async () => {
	assert.equal(await hover("基础¦对象 = 空"), undefined);

	const property = await hover([
		"事件 Test.初始化()",
		"结束 事件",
		"",
		"$属性",
		"  $资源 $对象",
		"  基础¦对象 = simple.runtime.collections.线程",
		"$结束 $属性"
	].join("\r\n"));
	assert.equal(property?.name, "基础对象");
	assert.equal(property?.kind, "properties");
	assert.match(property?.description ?? "", /基础对象/);

	const runtimeClass = await hover([
		"$属性",
		"  $资源 $对象",
		"  基础对象 = simple.runtime.collections.线¦程",
		"$结束 $属性"
	].join("\r\n"));
	assert.equal(runtimeClass?.name, "simple.runtime.collections.线程");
	assert.equal(runtimeClass?.kind, "object");
	assert.equal(runtimeClass?.signature, "对象 线程");
});

test("运行库静态成员和已知变量实例成员按访问方式悬停", async () => {
	const staticFunction = await hover("数组操作.分割¦文本(内容, 分隔符, 1)");
	assert.equal(staticFunction?.name, "分割文本");
	assert.equal(staticFunction?.owner, "数组操作");

	const instanceProperty = await hover([
		"过程 Run()",
		"  变量 timer 为 计时器",
		"  timer.间¦隔 = 500",
		"结束 过程",
		"$属性",
		"  $资源 $对象",
		"$结束 $属性"
	].join("\r\n"));
	assert.equal(instanceProperty?.name, "间隔");
	assert.equal(instanceProperty?.kind, "properties");
	assert.equal(instanceProperty?.owner, "计时器");
	assert.equal(instanceProperty?.signature, "属性 间隔 为 整数型");
	assert.equal(instanceProperty?.initializer, "1000");

	assert.equal(await hover("unknown.间¦隔 = 500"), undefined);
	assert.equal(await hover("间¦隔 = 500"), undefined);
});

test("源码变量在声明及有效作用域内返回类型悬停", async () => {
	const source = [
		"静态 过程 RunSmokeTests()",
		"  ''' 测试集合",
		"  变量 tests 为 集合",
		"  tests = 创建 集合",
		"  tests.加入(创建 ExampleTest)",
		"结束 过程"
	].join("\r\n");
	const declaration = await hover(source.replace("tests 为", "tes¦ts 为"));
	assert.equal(declaration?.name, "tests");
	assert.equal(declaration?.kind, "variable");
	assert.equal(declaration?.signature, "变量 tests 为 集合");
	assert.equal(declaration?.category, "当前文档");
	assert.equal(declaration?.description, "测试集合");

	const reference = await hover(source.replace("tests.加入", "tes¦ts.加入"));
	assert.equal(reference?.signature, "变量 tests 为 集合");

	const member = await hover(source.replace("tests.加入", "tests.加¦入"));
	assert.equal(member?.signature, "过程 加入(item 为 变体型)");
	assert.match(member?.description ?? "", /添加到集合/);

	const outOfScope = [source, "tes¦ts.加入(空)"].join("\r\n");
	assert.equal(await hover(outOfScope), undefined);

	const inferredMember = await hover([
		"过程 Run()",
		"  变量 a1 = 创建 按钮 位于 面板1",
		"  a1.文¦本 = \"确定\"",
		"结束 过程"
	].join("\r\n"));
	assert.equal(inferredMember?.name, "文本");
	assert.equal(inferredMember?.kind, "properties");

	const array = await hover([
		"静态 变量 matrix 为 文本型(2, 2)",
		"mat¦rix = 空"
	].join("\r\n"));
	assert.equal(array?.signature, "静态 变量 matrix 为 文本型(2, 2)");
});

test("类型别名显示目标，变体型在创建赋值后显示当前收窄类型", async () => {
	const fullSource = [
		"''' 计时器别名",
		"别名 Timer = 计时器",
		"过程 Run()",
		"  ''' 动态计时器",
		"  变量 value 为 变体型",
		"  value = 创建 Timer",
		"  value.间隔 = 500",
		"结束 过程",
		"$属性",
		"  $资源 $对象",
		"$结束 $属性"
	].join("\r\n");
	const userCode = splitSimpleUnitSource(fullSource).userCode;
	const unit = parseSimpleUnitSymbols(fullSource, "C:\\project\\src\\Test.simple", "C:\\project\\src");
	const context: SimpleProjectSemanticContext = {
		currentUnit: unit,
		manifest: {
			categories: [{ definitions: [unit.definition], hidden: true, name: "当前单元" }],
			directory: "C:\\project",
			filePath: "C:\\project\\project.properties",
			kind: "project",
			name: "测试项目"
		}
	};
	const sdk = await sdkPromise;
	const aliasOffset = userCode.indexOf("Timer") + 1;
	const alias = findSimpleKeywordHover(userCode, aliasOffset, sdk, context);
	assert.equal(alias?.signature, "别名 Timer = 计时器");
	assert.equal(alias?.description, "计时器别名");
	assert.equal(alias?.manifest, "测试项目");
	assert.equal(alias?.declarationSource, "Test");

	const valueOffset = userCode.lastIndexOf("value") + 1;
	const narrowed = findSimpleKeywordHover(userCode, valueOffset, sdk, context);
	assert.equal(narrowed?.signature, "变量 value 为 变体型（当前收窄为 Timer）");
	assert.equal(narrowed?.description, "动态计时器");

	const memberOffset = userCode.indexOf("间隔") + 1;
	const member = findSimpleKeywordHover(userCode, memberOffset, sdk, context);
	assert.equal(member?.signature, "属性 间隔 为 整数型");
});

test("显式传值和传址参数在声明及引用处返回原样悬停", async () => {
	const source = [
		"事件 TextBox1.文本改变(传值 text 为 文本型, 传址 accept 为 逻辑型)",
		"  text = text",
		"  accept = 真",
		"结束 事件"
	].join("\r\n");

	const valueDeclaration = await hover(source.replace("传值 text", "传值 te¦xt"));
	assert.equal(valueDeclaration?.kind, "parameter");
	assert.equal(valueDeclaration?.signature, "传值 text 为 文本型");

	const referenceDeclaration = await hover(source.replace("传址 accept", "传址 acc¦ept"));
	assert.equal(referenceDeclaration?.kind, "parameter");
	assert.equal(referenceDeclaration?.signature, "传址 accept 为 逻辑型");

	const reference = await hover(source.replace("accept = 真", "acc¦ept = 真"));
	assert.equal(reference?.signature, "传址 accept 为 逻辑型");
});

test("相邻三单引号文档注释识别连续多行、段尾空注释和物理空行", async () => {
	const adjacent = await hover([
		"过程 Run()",
		"  ''' 第一行",
		"  ''' 实际说明",
		"  变量 ¦i 为 整数型",
		"结束 过程"
	].join("\r\n"));
	assert.equal(adjacent?.description, "第一行\n实际说明");

	const empty = await hover([
		"过程 Run()",
		"  ''' 不应向上查找",
		"  '''   ",
		"  变量 ¦i 为 整数型",
		"结束 过程"
	].join("\r\n"));
	assert.equal(empty?.description, "不应向上查找");

	const allEmpty = await hover([
		"过程 Run()",
		"  '''   ",
		"  ''' ",
		"  变量 ¦i 为 整数型",
		"结束 过程"
	].join("\r\n"));
	assert.equal(allEmpty?.description, undefined);

	const separated = await hover([
		"过程 Run()",
		"  ''' 不应跨过空行",
		"",
		"  变量 ¦i 为 整数型",
		"结束 过程"
	].join("\r\n"));
	assert.equal(separated?.description, undefined);
});

test("函数结果引用复用函数定义和定义文档注释", async () => {
	const fullSource = [
		"''' 计算结果",
		"函数 Calculate(value 为 整数型) 为 整数型",
		"  Calculate = value",
		"结束 函数",
		"$属性",
		"  $资源 $对象",
		"$结束 $属性"
	].join("\r\n");
	const userCode = splitSimpleUnitSource(fullSource).userCode;
	const unit = parseSimpleUnitSymbols(fullSource, "C:\\project\\src\\Calculate.simple", "C:\\project\\src");
	const context: SimpleProjectSemanticContext = {
		currentUnit: unit,
		manifest: {
			categories: [{ definitions: [unit.definition], hidden: true, name: "当前单元" }],
			directory: "C:\\project",
			filePath: "C:\\project\\project.properties",
			kind: "project",
			name: "计算项目"
		}
	};
	const offset = userCode.lastIndexOf("Calculate") + 1;
	const result = findSimpleKeywordHover(userCode, offset, await sdkPromise, context);

	assert.equal(result?.signature, "函数 Calculate(value 为 整数型) 为 整数型");
	assert.equal(result?.description, "计算结果");
	assert.equal(result?.manifest, "计算项目");
	assert.equal(result?.declarationSource, "Calculate");
});

test("同名过程调用按实参数量显示对应重载签名", () => {
	const sourceRoot = "C:\\project\\src";
	const fullSource = [
		"过程 执行()",
		"结束 过程",
		"过程 执行(value 为 整数型)",
		"结束 过程",
		"过程 Run()",
		"\t执行()",
		"\t执行(1)",
		"\t执行(1, 2)",
		"结束 过程",
		"$属性",
		"\t$资源 $对象",
		"$结束 $属性"
	].join("\r\n");
	const current = parseSimpleUnitSymbols(
		fullSource,
		`${sourceRoot}\\Overload.simple`,
		sourceRoot
	);
	const userCode = splitSimpleUnitSource(fullSource).userCode;
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
	const query = (call: string) => {
		const start = userCode.indexOf(call, userCode.indexOf("过程 Run"));
		return findSimpleKeywordHover(userCode, start + 1, undefined, context);
	};

	assert.equal(query("执行()")?.signature, "过程 执行()");
	assert.equal(query("执行(1)")?.signature, "过程 执行(value 为 整数型)");
	assert.deepEqual(query("执行(1, 2)")?.overloads?.map((overload) => overload.signature), [
		"过程 执行()",
		"过程 执行(value 为 整数型)"
	]);
});

test("参数个数错误时仍显示唯一的全局函数签名", async () => {
	const result = await hover('弹出确¦认框("授权结果")');
	assert.equal(result?.signature, "过程 弹出确认框(title 为 文本型, message 为 文本型, btnOK 为 文本型)");
	assert.deepEqual(result?.parameters?.map((parameter) => parameter.name), ["title", "message", "btnOK"]);
});

test("运行库方法调用按实参数量显示对应重载签名", async () => {
	const sourceRoot = "C:\\project\\src";
	const fullSource = [
		"过程 Run()",
		"\t变量 list 为 分组列表框",
		"\tlist.添加子项(1, \"\")",
		"\tlist.添加子项(1, \"\", \"\", \"\", \"\", \"\")",
		"\tlist.添加子项(1)",
		"结束 过程",
		"$属性",
		"\t$资源 $对象",
		"$结束 $属性"
	].join("\r\n");
	const current = parseSimpleUnitSymbols(fullSource, `${sourceRoot}\\RuntimeOverload.simple`, sourceRoot);
	const userCode = splitSimpleUnitSource(fullSource).userCode;
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
	const sdk = await sdkPromise;
	const query = (occurrence: number) => {
		const first = userCode.indexOf("添加子项");
		const start = occurrence === 0 ? first : userCode.indexOf("添加子项", first + 1);
		return findSimpleKeywordHover(userCode, start + 1, sdk, context);
	};

	assert.match(query(0)?.signature ?? "", /^过程 添加子项\([^)]*title 为 文本型\)$/u);
	assert.match(query(1)?.signature ?? "", /^过程 添加子项\([^)]*buttontitle 为 文本型\)$/u);
	const wrongArity = userCode.lastIndexOf("添加子项");
	const alternatives = findSimpleKeywordHover(userCode, wrongArity + 1, sdk, context)?.overloads;
	assert.equal(alternatives?.length, 2);
	assert.match(alternatives[0]?.signature ?? "", /^过程 添加子项\([^)]*title 为 文本型\)$/u);
	assert.match(alternatives[1]?.signature ?? "", /^过程 添加子项\([^)]*buttontitle 为 文本型\)$/u);
});

test("对象过程和函数提示基础对象重写及接口实现关系", () => {
	const sourceRoot = "C:\\project\\src";
	const interfaceSource = [
		"过程 Run(value 为 整数型)",
		"结束 过程",
		"函数 GetName() 为 文本型",
		"结束 函数",
		"$属性",
		"\t$资源 $接口",
		"$结束 $属性"
	].join("\r\n");
	const baseSource = [
		"过程 Run(value 为 整数型)",
		"结束 过程",
		"函数 GetName() 为 文本型",
		"\tGetName = \"Base\"",
		"结束 函数",
		"$属性",
		"\t$资源 $对象",
		"\t实现接口 = pkg.NameContract",
		"$结束 $属性"
	].join("\r\n");
	const derivedSource = [
		"过程 Run(value 为 整数型)",
		"结束 过程",
		"函数 GetName() 为 文本型",
		"\tGetName = \"Derived\"",
		"结束 函数",
		"$属性",
		"\t$资源 $对象",
		"\t基础对象 = pkg.BaseObject",
		"$结束 $属性"
	].join("\r\n");
	const contract = parseSimpleUnitSymbols(
		interfaceSource,
		`${sourceRoot}\\pkg\\NameContract.simple`,
		sourceRoot
	);
	const base = parseSimpleUnitSymbols(
		baseSource,
		`${sourceRoot}\\pkg\\BaseObject.simple`,
		sourceRoot
	);
	const derived = parseSimpleUnitSymbols(
		derivedSource,
		`${sourceRoot}\\pkg\\DerivedObject.simple`,
		sourceRoot
	);
	const units = [contract, base, derived];
	const manifest = {
		categories: [{
			definitions: units.map((unit) => ({ ...unit.definition, aliases: [unit.name] })),
			hidden: true,
			name: "项目单元"
		}],
		directory: "C:\\project",
		filePath: "C:\\project\\project.properties",
		kind: "project" as const,
		name: "测试项目"
	};
	const derivedUserCode = splitSimpleUnitSource(derivedSource).userCode;
	const derivedContext: SimpleProjectSemanticContext = { currentUnit: derived, manifest };

	const procedure = findSimpleKeywordHover(
		derivedUserCode,
		derivedUserCode.indexOf("Run") + 1,
		undefined,
		derivedContext
	);
	assert.deepEqual(procedure?.relations, [
		{ declaration: "过程", kind: "overrides", source: "pkg.BaseObject.Run(value 为 整数型)" }
	]);

	const functionResult = findSimpleKeywordHover(
		derivedUserCode,
		derivedUserCode.lastIndexOf("GetName") + 1,
		undefined,
		derivedContext
	);
	assert.deepEqual(functionResult?.relations, [
		{ declaration: "函数", kind: "overrides", source: "pkg.BaseObject.GetName()" }
	]);

	const baseUserCode = splitSimpleUnitSource(baseSource).userCode;
	const baseContext: SimpleProjectSemanticContext = { currentUnit: base, manifest };
	const directImplementation = findSimpleKeywordHover(
		baseUserCode,
		baseUserCode.indexOf("Run") + 1,
		undefined,
		baseContext
	);
	assert.deepEqual(directImplementation?.relations, [
		{ declaration: "过程", kind: "implements", source: "pkg.NameContract.Run(value 为 整数型)" }
	]);
});

test("项目 res 索引为 R 对象和已有资源提供不含编号的悬停", () => {
	const source = "图片 = R.drawable_es4a";
	const context: SimpleProjectSemanticContext = {
		manifest: {
			categories: [],
			directory: "C:\\project",
			filePath: "C:\\project\\project.properties",
			kind: "project",
			name: "资源项目"
		},
		resources: {
			objectQualifiedName: "sample.app.SimpleResources",
			projectDirectory: "C:\\project",
			symbols: [{
				name: "drawable_es4a",
				resourceName: "es4a",
				resourceType: "drawable",
				sourceFiles: ["C:\\project\\res\\drawable\\es4a.png"]
			}]
		}
	};
	const object = findSimpleKeywordHover(source, source.indexOf("R"), undefined, context);
	const member = findSimpleKeywordHover(
		source,
		source.indexOf("drawable_es4a") + 1,
		undefined,
		context
	);

	assert.equal(object?.signature, "对象 R");
	assert.equal(object?.declarationSource, "sample.app.SimpleResources");
	assert.equal(member?.signature, "常量 R.drawable_es4a 为 整数型");
	assert.equal(member?.description, "Android drawable 资源。\n\n来源文件：res/drawable/es4a.png");
	assert.doesNotMatch(member?.signature ?? "", /&H|0x/iu);
	assert.equal(
		findSimpleKeywordHover("图片 = R.drawable_missing", 12, undefined, context),
		undefined
	);
	assert.equal(
		findSimpleKeywordHover("图片 = R.drawable_missing", 5, undefined, context),
		undefined
	);
	assert.equal(
		findSimpleKeywordHover("' R.drawable_es4a", 5, undefined, context),
		undefined
	);
});

test("没有 SDK 或光标越界时不返回关键字悬停", () => {
	assert.equal(findSimpleKeywordHover("如果", 0, undefined), undefined);
	assert.equal(findSimpleKeywordHover("如果", -1, undefined), undefined);
	assert.equal(findSimpleKeywordHover("如果", 2, undefined), undefined);
});
