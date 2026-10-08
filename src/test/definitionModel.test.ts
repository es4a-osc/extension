/*
验证 Simple 定义解析覆盖局部绑定、别名、跨单元和继承成员。
xhwsd@qq.com 2026-9-1
*/

import * as assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { findSimpleDefinition } from "../definitionModel";
import { loadSdk, type LibraryManifest } from "../sdk";
import {
	parseSimpleUnitSymbols,
	type SimpleProjectSemanticContext,
	type SimpleUnitSymbol
} from "../simpleUnitSymbols";
import { splitSimpleUnitSource } from "../simpleUnitSource";

const CURSOR = "¦";
const SOURCE_ROOT = "C:\\project\\src";

/** 为项目单元补充唯一短名称，并建立当前文档语义上下文。 */
function contextFor(current: SimpleUnitSymbol, units: readonly SimpleUnitSymbol[]): SimpleProjectSemanticContext {
	const manifest: LibraryManifest = {
		categories: [{
			definitions: units.map((unit) => ({ ...unit.definition, aliases: [unit.name] })),
			hidden: true,
			name: "项目单元"
		}],
		directory: "C:\\project",
		filePath: "C:\\project\\project.properties",
		kind: "project",
		name: "测试项目"
	};
	return { currentUnit: current, manifest };
}

/** 在标记处查找定义。 */
function definition(
	markedUserCode: string,
	current: SimpleUnitSymbol,
	units: readonly SimpleUnitSymbol[]
) {
	const offset = markedUserCode.indexOf(CURSOR);
	assert.notEqual(offset, -1);
	const source = markedUserCode.replace(CURSOR, "");
	return findSimpleDefinition(source, offset, undefined, contextFor(current, units));
}

test("局部变量、文件别名和跨单元继承成员跳到实际声明", () => {
	const baseSource = [
		"过程 基础过程()",
		"结束 过程",
		"$属性",
		"\t$资源 $对象",
		"$结束 $属性"
	].join("\r\n");
	const derivedSource = [
		"过程 自有过程()",
		"结束 过程",
		"静态 过程 静态过程()",
		"结束 过程",
		"$属性",
		"\t$资源 $对象",
		"\t基础对象 = pkg.Base",
		"$结束 $属性"
	].join("\r\n");
	const callerSource = [
		"别名 A = pkg.Derived",
		"别名 Derived = pkg.Derived",
		"过程 Run()",
		"\t变量 a 为 A",
		"\ta.基础过程()",
		"\ta.自有过程()",
		"\tA.静态过程()",
		"结束 过程",
		"$属性",
		"\t$资源 $对象",
		"$结束 $属性"
	].join("\r\n");
	const base = parseSimpleUnitSymbols(baseSource, `${SOURCE_ROOT}\\pkg\\Base.simple`, SOURCE_ROOT);
	const derived = parseSimpleUnitSymbols(derivedSource, `${SOURCE_ROOT}\\pkg\\Derived.simple`, SOURCE_ROOT);
	const caller = parseSimpleUnitSymbols(callerSource, `${SOURCE_ROOT}\\Caller.simple`, SOURCE_ROOT);
	const units = [base, derived, caller];
	const userCode = splitSimpleUnitSource(callerSource).userCode;

	const local = definition(userCode.replace("\ta.基础", "\t¦a.基础"), caller, units);
	assert.equal(local?.filePath, caller.filePath);
	assert.equal(local?.targetOffset, userCode.indexOf("a 为 A"));

	const alias = definition(userCode.replace("变量 a 为 A", "变量 a 为 ¦A"), caller, units);
	assert.equal(alias?.filePath, caller.filePath);
	assert.equal(alias?.targetLine, 0);

	const aliasDeclaration = definition(userCode.replace("别名 Derived", "别名 Deri¦ved"), caller, units);
	assert.equal(aliasDeclaration?.filePath, caller.filePath);
	assert.equal(aliasDeclaration?.targetLine, 1);

	const aliasTarget = definition(userCode.replace("pkg.Derived", "pkg.Deri¦ved"), caller, units);
	assert.equal(aliasTarget?.filePath, derived.filePath);
	assert.equal(aliasTarget?.targetLine, 0);

	const inherited = definition(userCode.replace("基础过程", "基础¦过程"), caller, units);
	assert.equal(inherited?.filePath, base.filePath);
	assert.equal(inherited?.targetLine, 0);

	const own = definition(userCode.replace("自有过程()", "自有¦过程()"), caller, units);
	assert.equal(own?.filePath, derived.filePath);
	assert.equal(own?.targetLine, 0);

	const staticMember = definition(userCode.replace("静态过程()", "静态¦过程()"), caller, units);
	assert.equal(staticMember?.filePath, derived.filePath);
	assert.equal(staticMember?.targetLine, 2);
});

test("子对象同名成员跳到子对象定义且未覆盖成员跳到基础对象", () => {
	const baseSource = [
		"常量 NAME 为 文本型 = \"BaseObject\"",
		"函数 GetObjectName() 为 文本型",
		"\tGetObjectName = NAME",
		"结束 函数",
		"过程 BaseOnly()",
		"结束 过程",
		"$属性",
		"\t$资源 $对象",
		"$结束 $属性"
	].join("\r\n");
	const derivedSource = [
		"常量 NAME 为 文本型 = \"DerivedObject\"",
		"函数 GetObjectName() 为 文本型",
		"\tGetObjectName = NAME",
		"\tBaseOnly()",
		"结束 函数",
		"$属性",
		"\t$资源 $对象",
		"\t基础对象 = pkg.BaseObject",
		"$结束 $属性"
	].join("\r\n");
	const base = parseSimpleUnitSymbols(
		baseSource,
		`${SOURCE_ROOT}\\pkg\\BaseObject.simple`,
		SOURCE_ROOT
	);
	const derived = parseSimpleUnitSymbols(
		derivedSource,
		`${SOURCE_ROOT}\\pkg\\DerivedObject.simple`,
		SOURCE_ROOT
	);
	const userCode = splitSimpleUnitSource(derivedSource).userCode;
	const units = [base, derived];

	const functionResult = definition(
		userCode.replace("\tGetObjectName =", "\tGetObject¦Name ="),
		derived,
		units
	);
	assert.equal(functionResult?.filePath, derived.filePath);
	assert.equal(functionResult?.targetOffset, userCode.indexOf("GetObjectName()"));

	const ownConstant = definition(
		userCode.replace("= NAME", "= NA¦ME"),
		derived,
		units
	);
	assert.equal(ownConstant?.filePath, derived.filePath);
	assert.equal(ownConstant?.targetLine, 0);

	const inherited = definition(
		userCode.replace("BaseOnly()", "Base¦Only()"),
		derived,
		units
	);
	assert.equal(inherited?.filePath, base.filePath);
	assert.equal(inherited?.targetLine, 4);
});

test("同名过程调用按实参数量跳到对应重载", () => {
	const source = [
		"过程 执行()",
		"结束 过程",
		"过程 执行(value 为 整数型)",
		"结束 过程",
		"过程 执行(left 为 整数型, right 为 整数型)",
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
	const current = parseSimpleUnitSymbols(source, `${SOURCE_ROOT}\\Overload.simple`, SOURCE_ROOT);
	const userCode = splitSimpleUnitSource(source).userCode;
	const target = (call: string) => definition(
		userCode.replace(call, call.replace("执行", "执¦行")),
		current,
		[current]
	);

	assert.equal(target("执行()")?.targetLine, 0);
	assert.equal(target("执行(1)")?.targetLine, 2);
	assert.equal(target("执行(1, 2)")?.targetLine, 4);
});

test("属性 XML 组件绑定返回完整代码属性来源", () => {
	const source = [
		"过程 Run()",
		"\t主按钮.文本 = \"确定\"",
		"结束 过程",
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 Main $为 窗口",
		"\t\t$定义 主按钮 $为 按钮",
		"\t\t$结束 $定义",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n");
	const unit = parseSimpleUnitSymbols(source, `${SOURCE_ROOT}\\Main.simple`, SOURCE_ROOT);
	const userCode = splitSimpleUnitSource(source).userCode;
	const target = definition(userCode.replace("主按钮", "主按¦钮"), unit, [unit]);

	assert.equal(target?.filePath, unit.filePath);
	assert.equal(target?.propertySource, true);
	assert.equal(target?.targetLine, 6);
});

test("显式传值和传址参数引用跳到参数名称", () => {
	const source = [
		"过程 Run(传值 text 为 文本型, 传址 accept 为 逻辑型)",
		"\ttext = text",
		"\taccept = 真",
		"结束 过程",
		"$属性",
		"\t$资源 $对象",
		"$结束 $属性"
	].join("\r\n");
	const unit = parseSimpleUnitSymbols(source, `${SOURCE_ROOT}\\Parameters.simple`, SOURCE_ROOT);
	const userCode = splitSimpleUnitSource(source).userCode;
	const text = definition(userCode.replace("text = text", "¦text = text"), unit, [unit]);
	const accept = definition(userCode.replace("accept = 真", "¦accept = 真"), unit, [unit]);

	assert.equal(text?.targetOffset, userCode.indexOf("text 为 文本型"));
	assert.equal(accept?.targetOffset, userCode.indexOf("accept 为 逻辑型"));
});

test("R 成员只按 res 索引定位首个真实资源文件", () => {
	const source = "过程 Run()\r\n\t图标 = R.drawable_icon\r\n结束 过程";
	const current = parseSimpleUnitSymbols(source, `${SOURCE_ROOT}\\Main.simple`, SOURCE_ROOT);
	const baseResource = "C:\\project\\res\\drawable\\icon.png";
	const qualifiedResource = "C:\\project\\res\\drawable-v24\\icon.xml";
	const target = findSimpleDefinition(
		source,
		source.indexOf("drawable_icon") + 1,
		undefined,
		{
			...contextFor(current, [current]),
			resources: {
				objectQualifiedName: "sample.app.SimpleResources",
				projectDirectory: "C:\\project",
				symbols: [{
					name: "drawable_icon",
					resourceName: "icon",
					resourceType: "drawable",
					sourceFiles: [baseResource, qualifiedResource]
				}]
			}
		}
	);

	assert.equal(target?.filePath, baseResource);
	assert.equal(target?.resourceSource, true);
	assert.equal(
		findSimpleDefinition(source.replace("drawable_icon", "drawable_missing"), source.indexOf("drawable_icon") + 1, undefined, {
			...contextFor(current, [current]),
			resources: {
				objectQualifiedName: "sample.app.SimpleResources",
				projectDirectory: "C:\\project",
				symbols: []
			}
		}),
		undefined
	);
});

test("运行库对象、方法和常量返回类库树导航目标", async () => {
	const fullSource = [
		"过程 Run()",
		"\t变量 value 为 意图",
		"\tvalue.置附加(\"key\", \"value\")",
		"\t变量 unit 为 整数型 = 像素转换.像素_绝对",
		"\t子文本替换(text, \"a\", \"b\", 0, -1)",
		"\t变量 list 为 分组列表框",
		"\tlist.添加子项(1, \"\")",
		"\tlist.添加子项(1, \"\", \"\", \"\", \"\", \"\")",
		"结束 过程",
		"$属性",
		"\t$资源 $对象",
		"$结束 $属性"
	].join("\r\n");
	const current = parseSimpleUnitSymbols(fullSource, `${SOURCE_ROOT}\\Current.simple`, SOURCE_ROOT);
	const source = splitSimpleUnitSource(fullSource).userCode;
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const find = (name: string) => findSimpleDefinition(
		source,
		source.indexOf(name) + 1,
		sdk,
		contextFor(current, [current])
	);

	const definitionTarget = find("意图");
	assert.equal(definitionTarget?.filePath, undefined);
	assert.equal(definitionTarget?.librarySymbol?.definitionName, "意图");
	assert.match(definitionTarget?.librarySymbol?.manifestFilePath ?? "", /SimpleAndroidRuntime\.json$/u);

	const methodTarget = find("置附加");
	assert.equal(methodTarget?.librarySymbol?.definitionName, "意图");
	assert.equal(methodTarget?.librarySymbol?.memberGroup, "functions");

	const constantTarget = find("像素_绝对");
	assert.equal(constantTarget?.librarySymbol?.definitionName, "像素转换");
	assert.equal(constantTarget?.librarySymbol?.memberGroup, "constants");

	const globalFunctionTarget = find("子文本替换");
	assert.equal(globalFunctionTarget?.librarySymbol?.definitionName, "文本操作");
	assert.equal(globalFunctionTarget?.librarySymbol?.memberGroup, "functions");

	const firstAdd = source.indexOf("添加子项");
	const secondAdd = source.indexOf("添加子项", firstAdd + 1);
	const shortOverload = findSimpleDefinition(source, firstAdd + 1, sdk, contextFor(current, [current]));
	const longOverload = findSimpleDefinition(source, secondAdd + 1, sdk, contextFor(current, [current]));
	assert.equal(shortOverload?.librarySymbol?.definitionName, "分组列表框");
	assert.equal(longOverload?.librarySymbol?.definitionName, "分组列表框");
	assert.notEqual(shortOverload?.librarySymbol?.memberKey, longOverload?.librarySymbol?.memberKey);
});
