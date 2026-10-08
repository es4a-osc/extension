/*
验证属性原子表达式只接受当前 SDK、项目或资源索引中确实存在的值符号。
xhwsd@qq.com 2026-9-18
*/

import assert from "node:assert/strict";
import test from "node:test";
import { unresolvedPropertySymbolExpression } from "../propertyExpressionValidation";
import type { LibraryDefinition, LibraryManifest, Sdk } from "../sdk";
import type { SimpleProjectSemanticContext, SimpleUnitSymbol } from "../simpleUnitSymbols";

const filePath = "C:\\project\\src\\test\\窗口.simple";
const sourceRoot = "C:\\project\\src";
const definition: LibraryDefinition = {
	constants: [{ line: 1, name: "项目常量", static: true, type: "整数型", value: "1" }],
	functions: [{ line: 2, name: "项目函数", params: [], return: "整数型" }],
	kind: "object",
	name: "test.窗口",
	sourceFile: filePath
};
const unit: SimpleUnitSymbol = {
	aliases: [],
	definition,
	filePath,
	name: "窗口",
	qualifiedName: definition.name,
	sourceRoot
};
const manifest: LibraryManifest = {
	categories: [{ definitions: [{ ...definition, aliases: ["窗口"] }], hidden: true, name: "项目单元" }],
	directory: "C:\\project",
	filePath: "C:\\project\\project.properties",
	kind: "project",
	name: "测试项目"
};
const context: SimpleProjectSemanticContext = { currentUnit: unit, manifest };
const runtimeManifest: LibraryManifest = {
	categories: [{
		definitions: [{
			constants: [{ name: "像素_绝对", type: "整数型", value: "0" }],
			functions: [{ global: true, name: "到绝对像素", params: [{ name: "值", type: "变体型" }], return: "整数型" }],
			kind: "object",
			name: "像素转换"
		}],
		name: "函数集"
	}],
	directory: "C:\\sdk",
	filePath: "C:\\sdk\\runtime.json",
	kind: "runtime",
	name: "测试运行库"
};
const sdk: Sdk = {
	capabilities: { projects: [], tools: [] },
	templates: {},
	directory: "C:\\sdk",
	filePath: "C:\\sdk\\sdk.json",
	issues: [],
	manifests: [runtimeManifest]
};

test("属性原子表达式使用项目语义索引核对常量和函数", () => {
	for (const expression of ["项目常量", "项目函数()", "像素转换.像素_绝对", "像素转换.到绝对像素(10)"]) {
		assert.equal(unresolvedPropertySymbolExpression(expression, sdk, context), undefined, expression);
	}
	for (const expression of ["s", "不存在的常量", "不存在的函数()", "像素转换.不存在"]) {
		assert.equal(unresolvedPropertySymbolExpression(expression, sdk, context), expression);
	}
});

test("属性组合表达式继续兼容放行且不递归查询内部符号", () => {
	for (const expression of ["s + 1", "不存在的函数() + 10", "项目常量 * 2"]) {
		assert.equal(unresolvedPropertySymbolExpression(expression, sdk, context), undefined, expression);
	}
});
