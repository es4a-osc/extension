/*
验证设计器组件事件菜单、已有处理过程定位和缺失处理过程插入文本。
xhwsd@qq.com 2026-8-30
*/

import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
	createDesignerComponentEventGroups,
	findSimpleComponentEventHandler,
	resolveDesignerComponentEventAction
} from "../designerComponentEvents";
import {
	createPropertyXmlElement,
	type SimplePropertyXmlDocument
} from "../propertyXml";
import type { Sdk } from "../sdk";

const buttonPath = "/属性/定义[1]/定义[1]";

/** 创建包含窗口与按钮的最小 XML 属性文档。 */
function createDocument(): SimplePropertyXmlDocument {
	return {
		issues: [],
		lineEnding: "\r\n",
		root: createPropertyXmlElement("属性", {}, [
			createPropertyXmlElement("资源", { 单元: "窗口" }),
			createPropertyXmlElement("定义", { 名称: "Test", 组件: "窗口" }, [
				createPropertyXmlElement("定义", { 名称: "按钮1", 组件: "按钮" })
			])
		]),
		status: "valid"
	};
}

/** 创建由编译器声明对象事件、运行库声明组件事件的最小 SDK 模型。 */
function createSdk(): Sdk {
	return {
		capabilities: { projects: [], tools: [] },
		templates: {},
		directory: "C:\\sdk",
		filePath: "C:\\sdk\\sdk.json",
		issues: [],
		manifests: [{
			categories: [{
				definitions: [{
					events: [
						{ description: "对象首次加载。", name: "加载" },
						{ description: "对象实例完成初始化。", name: "初始化" }
					],
					kind: "type",
					name: "对象"
				}],
				name: "数据类型"
			}],
			directory: "C:\\sdk",
			filePath: "C:\\sdk\\compiler.json",
			kind: "compiler",
			name: "测试编译器"
		}, {
			categories: [{
				definitions: [
					{
						kind: "component.window",
						name: "窗口",
						type: "simple.runtime.components.窗口"
					},
					{
						events: [{
							name: "被单击",
							params: [
								{ name: "次数", type: "整数型" },
								{ byRef: true, name: "取消事件", type: "逻辑型" }
							]
						}],
						inherits: ["simple.runtime.components.可视组件"],
						kind: "component",
						name: "按钮",
						type: "simple.runtime.components.按钮"
					},
					{
						events: [{ description: "获得输入焦点。", name: "获得焦点" }],
						inherits: ["对象"],
						kind: "component",
						name: "可视组件",
						type: "simple.runtime.components.可视组件"
					}
				],
				name: "测试组件"
			}],
			directory: "C:\\sdk",
			filePath: "C:\\sdk\\runtime.json",
			kind: "runtime",
			name: "测试运行库"
		}],
		version: "test"
	};
}

test("组件缺省显示编译器对象事件并生成有效处理过程", () => {
	const document = createDocument();
	const groups = createDesignerComponentEventGroups(document, createSdk(), "");
	const window = groups.find((group) => group.xmlPath === "/属性/定义[1]");
	assert.deepEqual(window?.events.map((event) => event.name), ["加载", "初始化"]);

	const action = resolveDesignerComponentEventAction(
		document,
		createSdk(),
		"",
		"/属性/定义[1]",
		"加载"
	);
	assert.equal(action.insertionText, "事件 Test.加载()\r\n\t\r\n结束 事件");
});

test("组件事件菜单合并继承事件并标识已有处理过程", () => {
	const userCode = [
		"' 事件 按钮1.获得焦点()",
		"事件 其它按钮.获得焦点()",
		"结束 事件",
		"事件 按钮1.被单击(次数 为 整数型, 传址 取消事件 为 逻辑型)",
		"结束 事件"
	].join("\r\n");
	const groups = createDesignerComponentEventGroups(createDocument(), createSdk(), userCode);
	const button = groups.find((group) => group.xmlPath === buttonPath);
	assert.deepEqual(button?.events.map((event) => [event.name, event.existing]), [
		["加载", false],
		["初始化", false],
		["获得焦点", false],
		["被单击", true]
	]);
	assert.equal(findSimpleComponentEventHandler(userCode, "按钮1", "被单击"), userCode.indexOf("事件 按钮1.被单击"));
});

test("缺失事件在用户代码末尾保留空白行并把光标放入事件体", () => {
	const userCode = "变量 数量 为 整数型";
	const action = resolveDesignerComponentEventAction(
		createDocument(),
		createSdk(),
		userCode,
		buttonPath,
		"获得焦点",
		"\r\n"
	);
	assert.equal(action.existing, false);
	assert.equal(action.insertionText, "\r\n\r\n事件 按钮1.获得焦点()\r\n\t\r\n结束 事件");
	const updated = userCode + action.insertionText;
	assert.equal(updated[action.caretOffset - 1], "\t");
	assert.equal(updated.slice(action.caretOffset, action.caretOffset + 2), "\r\n");
});

test("用户代码末尾只有一个换行时再补一个换行作为事件间隔", () => {
	const userCode = "事件 按钮2.被单击()\r\n\t\r\n结束 事件\r\n";
	const action = resolveDesignerComponentEventAction(
		createDocument(),
		createSdk(),
		userCode,
		buttonPath,
		"获得焦点",
		"\r\n"
	);

	assert.equal(
		action.insertionText,
		"\r\n事件 按钮1.获得焦点()\r\n\t\r\n结束 事件"
	);
});

test("已有空白行不重复添加，并按 SDK 参数生成传址事件声明", () => {
	const userCode = "变量 数量 为 整数型\r\n\r\n";
	const action = resolveDesignerComponentEventAction(
		createDocument(),
		createSdk(),
		userCode,
		buttonPath,
		"被单击"
	);
	assert.equal(
		action.insertionText,
		"事件 按钮1.被单击(次数 为 整数型, 传址 取消事件 为 逻辑型)\r\n\t\r\n结束 事件"
	);
});

test("已有空事件定位到主体空白行，不生成重复事件体", () => {
	const userCode = "事件 按钮1.获得焦点()\n\t\n结束 事件";
	const action = resolveDesignerComponentEventAction(
		createDocument(),
		createSdk(),
		userCode,
		buttonPath,
		"获得焦点",
		"\n"
	);
	assert.deepEqual(action, { caretOffset: userCode.indexOf("\t") + 1, existing: true });
});

test("已有非空事件定位到第一条主体语句的缩进之后", () => {
	const userCode = "事件 按钮1.获得焦点()\r\n\t显示提示(\"测试\")\r\n结束 事件";
	const action = resolveDesignerComponentEventAction(
		createDocument(),
		createSdk(),
		userCode,
		buttonPath,
		"获得焦点"
	);
	assert.deepEqual(action, { caretOffset: userCode.indexOf("显示提示"), existing: true });
});
