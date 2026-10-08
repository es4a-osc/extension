/*
验证组件名称在整个窗口 XML 中保持唯一，并作为设计器操作的稳定身份。
xhwsd@qq.com 2026-9-17
*/

import * as assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import {
	componentNameValidationError,
	inspectDesignerComponentNames,
	resolveDesignerComponentIdentity
} from "../componentIdentity";
import { parseSimplePropertyXml } from "../propertyXml";
import { loadSdk } from "../sdk";

/** 用最小窗口属性区建立可供身份规则检查的 XML 文档。 */
function componentDocument(definitions: readonly string[]) {
	return parseSimplePropertyXml([
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 窗口1 $为 窗口",
		...definitions.map((definition) => "\t\t" + definition),
		"\t$结束 $定义",
		"$结束 $属性",
		""
	].join("\r\n"));
}

test("同名组件跨嵌套层级仍按整个窗口报告重复", () => {
	const document = componentDocument([
		"$定义 按钮1 $为 按钮",
		"$结束 $定义",
		"$定义 面板1 $为 面板",
		"\t$定义 按钮1 $为 按钮",
		"\t$结束 $定义",
		"$结束 $定义"
	]);
	assert.ok(document);
	assert.deepEqual(inspectDesignerComponentNames(document), [
		"组件名称重复：“按钮1”（/属性/定义[1]/定义[1]、/属性/定义[1]/定义[2]/定义[1]）"
	]);
});

test("组件身份在兄弟路径变化后按唯一名称重新定位", () => {
	const document = componentDocument([
		"$定义 标签1 $为 标签",
		"$结束 $定义",
		"$定义 按钮1 $为 按钮",
		"$结束 $定义"
	]);
	assert.ok(document);
	const resolved = resolveDesignerComponentIdentity(document, {
		componentName: "按钮1",
		xmlPath: "/属性/定义[1]/定义[1]"
	});
	assert.equal(resolved.xmlPath, "/属性/定义[1]/定义[2]");
});

test("组件名称拒绝当前编译器清单中的关键字", async () => {
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	assert.match(componentNameValidationError("如果", sdk) ?? "", /关键字或保留字/u);
	assert.equal(componentNameValidationError("按钮1", sdk), undefined);
});
