/*
验证语法着色与共享引用身份的边界，防止 SDK、嵌套表达式和改名互相污染。
xhwsd@qq.com 2026-10-31
*/

import * as assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { buildSimpleSemanticTokens } from "../compilerTokens";
import { findSimpleDefinition } from "../definitionModel";
import { analyzeSimpleSourceSyntax } from "../simpleSourceSyntax";
import { isSimpleIgnoredOffset } from "../simpleSourceLexical";
import { createSimplePropertyXmlDocument } from "../propertyXml";
import { planSimpleSymbolRename, refactoringContext, type RefactoringUnit } from "../refactoringModel";
import type { Sdk } from "../sdk";
import type { SimpleProjectSemanticContext } from "../simpleUnitSymbols";

/** 外部元数据用于细化成员身份，不能决定固定语法是否可着色。 */
const sdk: Sdk = {
	directory: "C:/sdk", capabilities: { projects: [], tools: [] }, templates: {}, issues: [],
	manifests: [{
		kind: "runtime", name: "运行库", directory: "C:/sdk/simple", filePath: "C:/sdk/simple/runtime.json",
		categories: [{ name: "对象", definitions: [
			{ name: "工厂", kind: "object", functions: [
				{ name: "获取", static: true, return: "结果", params: [] },
				{ name: "获取", static: true, return: "另一结果", params: [{ name: "序号", type: "整数型" }] }
			] },
			{ name: "结果", kind: "object", constants: [{ name: "值", type: "整数型", value: "1" }], properties: [{ name: "下级", type: "另一结果" }] },
			{ name: "另一结果", kind: "object", properties: [{ name: "标题", type: "文本型" }] },
			{ name: "未完整交付类型", kind: "object", functions: [], properties: [] }
		] }]
	}]
};

/** 纯内存单元，只通过 XML 模型提供属性。 */
function unit(name: string, userCode: string): RefactoringUnit {
	return {
		filePath: path.resolve("C:/test", name + ".simple"), sourceRoot: path.resolve("C:/test"), userCode,
		property: { document: createSimplePropertyXmlDocument("对象", name), status: "valid", issues: [] }
	};
}

/** 直接调用 Provider 使用的着色入口，覆盖词法与语法结果复用。 */
function color(source: string, selectedSdk?: Sdk, context?: SimpleProjectSemanticContext) {
	return buildSimpleSemanticTokens(source, selectedSdk, context);
}

test("参数与类型同名时类型跳转及改名保持独立身份", () => {
	const source = "过程 运行(类型名 为 类型名)\n类型名 = 类型名\n结束 过程";
	const origin = unit("调用", source);
	const target = unit("类型名", "");
	const context = refactoringContext(origin, [origin, target]);
	const annotation = source.indexOf("为 类型名") + 2;
	assert.equal(findSimpleDefinition(source, annotation, undefined, context)?.filePath, target.filePath);
	const plans = planSimpleSymbolRename([origin, target], origin, source.indexOf("类型名"), "新参数", undefined);
	assert.equal(plans[0]?.userCode, "过程 运行(新参数 为 类型名)\n新参数 = 新参数\n结束 过程");
});

test("SDK 缺失成员时仍保留方法及属性的语法着色", () => {
	const source = "变量 实例 为 未完整交付类型\n过程 运行()\n实例.新增方法()\n实例.新增属性 = 1\n结束 过程";
	const select = (selectedSdk?: Sdk) => color(source, selectedSdk).filter((token) => token.text.startsWith("新增")).map((token) => [token.text, token.type]);
	assert.deepEqual(select(sdk), [["新增方法", "method"], ["新增属性", "property"]]);
	assert.deepEqual(select(sdk), select());
});

test("否则如果和分支表达式继续识别类型位置", () => {
	const source = "过程 运行(值 为 对象)\n如果 假 则\n否则如果 类型检验 值 是 另一类型 则\n结束 如果\n判断 真\n分支 类型检验 值 是 分支类型\n结束 判断\n结束 过程";
	for (const name of ["另一类型", "分支类型"]) {
		assert.equal(color(source).find((token) => token.text === name)?.type, "type");
	}
});

test("嵌套类型检验只给其对应的是右侧类型着色", () => {
	const source = "过程 运行(甲 为 对象, 乙 为 对象)\n变量 结果 为 逻辑型 = 类型检验 (甲 是 乙) 是 未安装类型\n结束 过程";
	const tokens = color(source);
	assert.deepEqual(tokens.filter((token) => token.text === "乙").map((token) => token.type), ["parameter", "parameter"]);
	assert.equal(tokens.find((token) => token.text === "未安装类型")?.type, "type");
});

test("关键字成员名不会启动类型检验语法", () => {
	const source = "过程 运行(甲 为 对象, 乙 为 对象)\n变量 结果 为 逻辑型 = 甲.类型检验() 是 乙\n结束 过程";
	assert.deepEqual(color(source).filter((token) => token.text === "乙").map((token) => token.type), ["parameter", "parameter"]);
});

test("函数返回值和数组元素后的成员按实际类型及重载识别", () => {
	const source = "变量 数据 为 结果(10)\n过程 运行()\n工厂.获取().值\n数据(0).值\n工厂.获取(1).标题\n工厂.获取().下级.标题\n结束 过程";
	const tokens = color(source, sdk);
	assert.deepEqual(tokens.filter((token) => token.text === "值").map((token) => [token.type, token.modifiers]), [["variable", ["readonly"]], ["variable", ["readonly"]]]);
	assert.equal(tokens.filter((token) => token.text === "标题" && token.type === "property").length, 2);
	const origin = unit("调用", source);
	const target = findSimpleDefinition(source, source.indexOf(".值") + 1, sdk, refactoringContext(origin, [origin]));
	assert.equal(target?.memberGroup, "constants");
});

test("嵌套 R 成员及同名组件不会取得项目资源身份", () => {
	const source = "过程 运行()\n其它对象.R.drawable_icon\nR.drawable_icon\n结束 过程";
	const origin = unit("调用", source);
	const context: SimpleProjectSemanticContext = {
		...refactoringContext(origin, [origin]),
		resources: { objectQualifiedName: "app.R", projectDirectory: "C:/test", symbols: [{ name: "drawable_icon", resourceName: "icon", resourceType: "drawable", sourceFiles: ["C:/test/icon.png"] }] }
	};
	const tokens = color(source, undefined, context);
	assert.equal(tokens.filter((token) => token.text === "drawable_icon" && token.modifiers.includes("readonly")).length, 1);
	assert.equal(tokens.find((token) => token.line === 1 && token.text === "R")?.type, "property");
	const current = context.currentUnit!;
	const withComponent: SimpleProjectSemanticContext = {
		...context, currentUnit: { ...current, definition: { ...current.definition, variables: [{ name: "R", type: "结果", component: true }] } },
		manifest: { ...context.manifest, categories: [{ name: "源码", definitions: [{ ...current.definition, variables: [{ name: "R", type: "结果", component: true }] }] }] }
	};
	assert.equal(color(source, sdk, withComponent).filter((token) => token.text === "drawable_icon" && token.modifiers.includes("readonly")).length, 0);
});

test("数组尺寸表达式中的比较符不构成声明初值", () => {
	const syntax = analyzeSimpleSourceSyntax("变量 数组 为 整数型(宽度(甲 = 乙))\n变量 数据 为 整数型() = 创建 整数型(2)");
	assert.equal(syntax.declarations.find((declaration) => declaration.name === "数组")?.initializer, undefined);
	assert.equal(syntax.declarations.find((declaration) => declaration.name === "数据")?.initializer, "创建 整数型(2)");
});

test("损坏字符串后的 LF 与 CRLF 均恢复为代码位置", () => {
	for (const ending of ["\n", "\r\n"]) {
		const source = '"未闭合\\' + ending + "变量 正常 为 整数型";
		assert.equal(isSimpleIgnoredOffset(source, source.indexOf("变量"), false), false);
	}
});

test("尚未关闭的函数体中结果变量优先于同名全局函数", () => {
	const source = "函数 计算() 为 整数型\n计算 = 1";
	assert.deepEqual(color(source).filter((token) => token.text === "计算").map((token) => token.type), ["function", "variable"]);
});

test("条件中的分组接收者可解析，非路径表达式不借用末尾对象身份", () => {
	const source = "过程 运行(甲 为 结果, 乙 为 结果)\n如果 (甲).值 = 1 则\n结束 如果\n(甲 是 乙).值\n结束 过程";
	const values = color(source, sdk).filter((token) => token.text === "值");
	assert.deepEqual(values.map((token) => [token.type, token.modifiers]), [["variable", ["readonly"]], ["property", []]]);
});

test("创建表达式的分组接收者仍是实例，可定位其属性", () => {
	const source = "过程 运行()\n(创建 另一结果).标题\n结束 过程";
	const origin = unit("调用", source);
	assert.equal(findSimpleDefinition(source, source.indexOf("标题"), sdk, refactoringContext(origin, [origin]))?.memberGroup, "properties");
});
