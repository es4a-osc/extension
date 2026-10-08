/*
验证组件改名同时更新 XML 名称、兄弟锚点和用户代码引用且保持其它原文不变。
xhwsd@qq.com 2026-8-28
*/

import * as assert from "node:assert/strict";
import * as path from "node:path";
import { describe, test } from "node:test";
import { renameSimpleComponent } from "../componentRename";
import {
	getPropertyXmlAttribute,
	parseSimplePropertyXml,
	resolvePropertyXmlElement,
	serializeSimplePropertySource
} from "../propertyXml";
import { loadSdk } from "../sdk";
import { splitSimpleUnitSource } from "../simpleUnitSource";

const ROOT_DIRECTORY = path.resolve(__dirname, "../..");

describe("Simple 组件改名", () => {
	test("同步事件限定名和普通组件引用并跳过字符串、注释及更长标识符", () => {
		const source = [
			"事件 Form.初始化()",
			"\tForm.标题 = \"Form\" ' Form 保持注释",
			"\tFormButton.可用 = 真",
			"结束 事件",
			"",
			"$属性",
			"\t$资源 $窗口",
			"\t$定义 Form $为 窗口",
			"\t\t标题 = \"Form\"",
			"\t$结束 $定义",
			"$结束 $属性",
			""
		].join("\r\n");

		const sections = splitSimpleUnitSource(source);
		const document = parseSimplePropertyXml(source);
		assert.ok(document);
		const updated = renameSimpleComponent(
			sections.userCode,
			document,
			"/属性/定义[1]",
			"MainForm"
		);

		assert.match(updated.userCode, /事件 MainForm\.初始化\(\)/u);
		assert.match(updated.userCode, /MainForm\.标题 = "Form" ' Form 保持注释/u);
		assert.match(updated.userCode, /FormButton\.可用/u);
		const propertySource = serializeSimplePropertySource(updated.propertyDocument);
		assert.match(propertySource, /\$定义 MainForm \$为 窗口/u);
		assert.match(propertySource, /标题 = "Form"/u);
	});

	test("嵌套组件按 XML 路径改名并拒绝重复名称", () => {
		const source = [
			"事件 Timer1.周期事件()",
			"\tTimer1.启用 = 真",
			"结束 事件",
			"$属性",
			"\t$资源 $窗口",
			"\t$定义 Form $为 窗口",
			"\t\t$定义 Timer1 $为 计时器",
			"\t\t$结束 $定义",
			"\t$结束 $定义",
			"$结束 $属性",
			""
		].join("\r\n");
		const document = parseSimplePropertyXml(source);
		const timer = document === undefined
			? undefined
			: resolvePropertyXmlElement(document, "/属性/定义[1]/定义[1]");
		assert.equal(getPropertyXmlAttribute(timer, "名称"), "Timer1");

		assert.ok(document);
		const userCode = splitSimpleUnitSource(source).userCode;
		const updated = renameSimpleComponent(
			userCode,
			document,
			"/属性/定义[1]/定义[1]",
			"Clock"
		);
		const updatedTimer = resolvePropertyXmlElement(
			updated.propertyDocument,
			"/属性/定义[1]/定义[1]"
		);
		assert.equal(getPropertyXmlAttribute(updatedTimer, "名称"), "Clock");
		assert.match(updated.userCode, /事件 Clock\.周期事件/u);
		assert.throws(
			() => renameSimpleComponent(userCode, document, "/属性/定义[1]/定义[1]", "Form"),
			/已经存在/u
		);
	});

	test("组件改名只同步直接兄弟的 simple.anchor XML 表达式", async () => {
		const source = [
			"事件 按钮1.被单击()",
			"\t按钮1.可用 = 真",
			"结束 事件",
			"$属性",
			"\t$资源 $窗口",
			"\t$定义 Form $为 窗口",
			"\t\t$定义 Panel1 $为 面板",
			"\t\t\t布局 = 布局_相对",
			"\t\t\t$定义 按钮1 $为 按钮",
			"\t\t\t$结束 $定义",
			"\t\t\t$定义 按钮2 $为 按钮",
			"\t\t\t\t位于左边 = 按钮1.标识",
			"\t\t\t\t保留字段 = 按钮1.标识",
			"\t\t\t$结束 $定义",
			"\t\t$结束 $定义",
			"\t\t$定义 Panel2 $为 面板",
			"\t\t\t布局 = 布局_相对",
			"\t\t\t$定义 按钮3 $为 按钮",
			"\t\t\t\t位于左边 = 按钮1.标识",
			"\t\t\t$结束 $定义",
			"\t\t$结束 $定义",
			"\t$结束 $定义",
			"$结束 $属性",
			""
		].join("\r\n");
		const document = parseSimplePropertyXml(source);
		assert.ok(document);
		const sdk = await loadSdk(path.join(ROOT_DIRECTORY, "..", "sdk", "sdk.json"));
		const updated = renameSimpleComponent(
			splitSimpleUnitSource(source).userCode,
			document,
			"/属性/定义[1]/定义[1]/定义[1]",
			"中心按钮",
			sdk
		);

		assert.match(updated.userCode, /事件 中心按钮\.被单击/u);
		assert.match(updated.userCode, /中心按钮\.可用/u);
		const propertySource = serializeSimplePropertySource(updated.propertyDocument);
		assert.match(propertySource, /\$定义 中心按钮 \$为 按钮/u);
		assert.match(propertySource, /位于左边 = 中心按钮\.标识/u);
		assert.match(propertySource, /保留字段 = 按钮1\.标识/u);
		assert.equal((propertySource.match(/位于左边 = 按钮1\.标识/gu) ?? []).length, 1);
	});
});
