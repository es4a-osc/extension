/*
验证设计器从真实 XML 属性模型和 SDK 清单建立窗口、组件树与工具箱投影。
xhwsd@qq.com 2026-8-29
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import {
	addSimpleDesignerComponent,
	copySimpleDesignerComponent,
	createSimpleDesignerModel,
	deleteSimpleDesignerComponent,
	findDesignerComponentNode,
	isSimpleDesignerComponentClipboardText,
	moveSimpleDesignerComponent,
	moveSimpleDesignerRelativeComponent,
	nudgeSimpleDesignerComponent,
	pasteSimpleDesignerComponent,
	relocateSimpleDesignerComponent,
	resizeSimpleDesignerComponent,
	type DesignerComponentNode
} from "../designerModel";
import {
	componentHoverHint,
	previewDesignerRelativePlacement,
	resolveDesignerAddTarget,
	resolveDesignerPasteTargetPath
} from "../designer/designerView";
import {
	getPropertyXmlAttribute,
	getPropertyXmlChildren,
	resolvePropertyXmlElement,
	parseSimplePropertyXml
} from "../propertyXml";
import { loadSdk, type Sdk } from "../sdk";
import { simpleTestProjectPath, simpleTestUnitPath } from "./testProjects";

/** 按名称递归查找设计器组件树节点。 */
function findComponent(node: DesignerComponentNode | undefined, name: string): DesignerComponentNode | undefined {
	if (node?.name === name) return node;
	return node?.children.map((child) => findComponent(child, name)).find((child) => child !== undefined);
}

/** 读取组件 XML 中一个直接赋值，缺失时返回 undefined。 */
function componentPropertyValue(
	document: NonNullable<ReturnType<typeof parseSimplePropertyXml>>,
	component: DesignerComponentNode | undefined,
	propertyName: string
): string | undefined {
	if (component === undefined) return undefined;
	const element = resolvePropertyXmlElement(document, component.path);
	const assignment = element === undefined
		? undefined
		: getPropertyXmlChildren(element, "赋值")
			.find((candidate) => getPropertyXmlAttribute(candidate, "属性") === propertyName);
	return assignment === undefined ? undefined : getPropertyXmlAttribute(assignment, "值");
}

test("可用组件候选保留 SDK 完整运行时类名", async () => {
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const model = createSimpleDesignerModel(undefined, sdk);
	const button = model.toolbox
		.find((group) => group.name === "视图组件")
		?.items.find((item) => item.name === "按钮");
	assert.equal(button?.runtimeType, "simple.runtime.components.按钮");
});

test("单帧布局内拖动只更新父级对齐和边距并保留层叠顺序", async () => {
	const document = parseSimplePropertyXml([
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 FrameDragTests $为 窗口",
		"\t\t布局 = 布局_单帧",
		"\t\t$定义 Button1 $为 按钮",
		"\t\t\t宽度 = 长度_适应内容",
		"\t\t\t高度 = 长度_适应内容",
		"\t\t\t对齐 = 对齐_左上",
		"\t\t\t左边距 = \"8dp\"",
		"\t\t\t顶边距 = \"6dp\"",
		"\t\t$结束 $定义",
		"\t\t$定义 Button2 $为 按钮",
		"\t\t$结束 $定义",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.ok(document);
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const model = createSimpleDesignerModel(document, sdk);
	const button = findComponent(model.root, "Button1");
	assert.ok(model.root);
	assert.ok(button);

	const moved = relocateSimpleDesignerComponent(
		document,
		sdk,
		button.path,
		model.root.path,
		undefined,
		undefined,
		undefined,
		undefined,
		{
			alignment: { horizontal: "right", vertical: "bottom" },
			fitContentHeight: true,
			fitContentWidth: true,
			margin: { bottom: 14.5, right: 20.5 }
		}
	);
	const movedModel = createSimpleDesignerModel(moved.document, sdk);
	const movedButton = findComponent(movedModel.root, "Button1");
	assert.deepEqual(movedModel.root?.children.map((child) => child.name), ["Button1", "Button2"]);
	assert.equal(componentPropertyValue(moved.document, movedButton, "对齐"), "对齐_右下");
	assert.equal(componentPropertyValue(moved.document, movedButton, "左边距"), undefined);
	assert.equal(componentPropertyValue(moved.document, movedButton, "顶边距"), undefined);
	assert.equal(componentPropertyValue(moved.document, movedButton, "右边距"), "\"20.5dp\"");
	assert.equal(componentPropertyValue(moved.document, movedButton, "底边距"), "\"14.5dp\"");
	assert.equal(componentPropertyValue(moved.document, movedButton, "宽度"), "长度_适应内容");
	assert.equal(componentPropertyValue(moved.document, movedButton, "高度"), "长度_适应内容");

	const added = addSimpleDesignerComponent(
		moved.document,
		sdk,
		"按钮",
		movedModel.root?.path ?? "",
		"canvas",
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{
			alignment: { horizontal: "left", vertical: "top" },
			fitContentHeight: true,
			fitContentWidth: true,
			margin: { left: 12, top: 18 }
		}
	);
	const addedModel = createSimpleDesignerModel(added.document, sdk);
	const addedButton = findDesignerComponentNode(addedModel.root!, added.componentPath);
	assert.equal(componentPropertyValue(added.document, addedButton, "对齐"), "对齐_左上");
	assert.equal(componentPropertyValue(added.document, addedButton, "左边距"), "\"12dp\"");
	assert.equal(componentPropertyValue(added.document, addedButton, "顶边距"), "\"18dp\"");
	assert.equal(componentPropertyValue(added.document, addedButton, "宽度"), "长度_适应内容");
	assert.equal(componentPropertyValue(added.document, addedButton, "高度"), "长度_适应内容");
});

test("组件拖入和拖出单帧布局时清理来源布局位置", async () => {
	const document = parseSimplePropertyXml([
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 FrameTransferTests $为 窗口",
		"\t\t布局 = 布局_绝对",
		"\t\t$定义 FramePanel $为 面板",
		"\t\t\t布局 = 布局_单帧",
		"\t\t\t$定义 Button1 $为 按钮",
		"\t\t\t\t宽度 = 长度_适应内容",
		"\t\t\t\t高度 = 长度_适应内容",
		"\t\t\t\t对齐 = 对齐_右下",
		"\t\t\t\t右边距 = \"8dp\"",
		"\t\t\t\t底边距 = \"6dp\"",
		"\t\t\t$结束 $定义",
		"\t\t$结束 $定义",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.ok(document);
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const model = createSimpleDesignerModel(document, sdk);
	const button = findComponent(model.root, "Button1");
	assert.ok(model.root);
	assert.ok(button);

	const movedOut = relocateSimpleDesignerComponent(
		document,
		sdk,
		button.path,
		model.root.path,
		undefined,
		undefined,
		{ left: 30, top: 40 }
	);
	const movedOutModel = createSimpleDesignerModel(movedOut.document, sdk);
	const outsideButton = findComponent(movedOutModel.root, "Button1");
	const frame = findComponent(movedOutModel.root, "FramePanel");
	assert.ok(outsideButton);
	assert.ok(frame);
	assert.equal(componentPropertyValue(movedOut.document, outsideButton, "对齐"), undefined);
	assert.equal(componentPropertyValue(movedOut.document, outsideButton, "右边距"), undefined);
	assert.equal(componentPropertyValue(movedOut.document, outsideButton, "底边距"), undefined);
	assert.equal(componentPropertyValue(movedOut.document, outsideButton, "左边"), "\"30dp\"");
	assert.equal(componentPropertyValue(movedOut.document, outsideButton, "顶边"), "\"40dp\"");

	const movedBack = relocateSimpleDesignerComponent(
		movedOut.document,
		sdk,
		outsideButton.path,
		frame.path,
		undefined,
		undefined,
		undefined,
		undefined,
		{
			alignment: { horizontal: "center", vertical: "top" },
			margin: { top: 12 }
		}
	);
	const movedBackModel = createSimpleDesignerModel(movedBack.document, sdk);
	const returnedButton = findComponent(movedBackModel.root, "Button1");
	assert.equal(componentPropertyValue(movedBack.document, returnedButton, "左边"), undefined);
	assert.equal(componentPropertyValue(movedBack.document, returnedButton, "顶边"), undefined);
	assert.equal(componentPropertyValue(movedBack.document, returnedButton, "对齐"), "对齐_中上");
	assert.equal(componentPropertyValue(movedBack.document, returnedButton, "顶边距"), "\"12dp\"");
});

test("可用组件按分类名称合并并保持首次出现顺序", () => {
	const sdk: Sdk = {
		capabilities: { projects: [], tools: [] },
		templates: {},
		directory: "",
		filePath: "",
		issues: [],
		manifests: [
			{
				categories: [
					{
						definitions: [{ kind: "component", name: "运行组件", type: "runtime.运行组件" }],
						description: "运行库分类说明",
						name: "共同分类"
					},
					{
						definitions: [{ kind: "component", name: "缺省组件", type: "runtime.缺省组件" }],
						name: "缺省分类"
					},
					{
						definitions: [{ kind: "component", name: "中间组件", type: "runtime.中间组件" }],
						name: "中间分类"
					}
				],
				directory: "",
				filePath: "runtime.json",
				kind: "runtime",
				name: "运行库",
				version: "1.0.0"
			},
			{
				categories: [{
					definitions: [{ kind: "component", name: "扩展组件", type: "library.扩展组件" }],
					description: "与运行库不同的分类说明",
					name: "共同分类"
				}],
				directory: "",
				filePath: "library.json",
				kind: "library",
				name: "扩展库",
				version: "9.9.9"
			}
		]
	};

	const model = createSimpleDesignerModel(undefined, sdk);
	assert.deepEqual(model.toolbox.map((group) => ({
		items: group.items.map((item) => item.name),
		name: group.name
	})), [
		{
			items: ["运行组件", "扩展组件"],
			name: "共同分类"
		},
		{
			items: ["缺省组件"],
			name: "缺省分类"
		},
		{
			items: ["中间组件"],
			name: "中间分类"
		}
	]);
	assert.equal("description" in (model.toolbox[2] ?? {}), false);
});

test("窗口设计器区分可视组件、非可视组件和 SDK 候选组件", async () => {
	const source = await fs.readFile(simpleTestProjectPath(
		"StartTests",
		"src",
		"simple",
		"runtime",
		"tests",
		"TimerTests.simple"
	), "utf8");
	const document = parseSimplePropertyXml(source);
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	assert.ok(document);
	const model = createSimpleDesignerModel(document, sdk);

	assert.equal(model.root?.name, "TimerTests");
	assert.equal(model.root?.type, "窗口");
	assert.equal(model.root?.displayText, "测试 - 计时器");
	assert.equal(path.basename(model.root?.icon ?? ""), "device-screen.svg");
	assert.equal(model.root?.layout, "linear-vertical");
	const topPanel = model.root?.children.find((component) => component.name === "TopPanel");
	assert.equal(topPanel?.container, true);
	assert.equal(topPanel?.layout, "linear-horizontal");
	assert.deepEqual(
		topPanel?.children.map((component) => component.displayText),
		["上一个", "下一个", "退出"]
	);
	assert.deepEqual(
		model.nonVisualComponents.map((component) => [component.name, component.type]),
		[["Timer1", "计时器"]]
	);
	assert.equal(path.basename(model.nonVisualComponents[0]?.icon ?? ""), "stopwatch.svg");
	const componentGroup = model.toolbox.find((group) => group.name === "组件");
	const containerGroup = model.toolbox.find((group) => group.name === "组件容器");
	const visualGroup = model.toolbox.find((group) => group.name === "视图组件");
	const sensorGroup = model.toolbox.find((group) => group.name === "传感器组件");
	assert.deepEqual(
		model.toolbox.slice(0, 4).map((group) => group.name),
		["组件", "组件容器", "视图组件", "传感器组件"]
	);
	assert.equal(model.toolbox.filter((group) => group.name === "扩展可视组件").length, 1);
	assert.deepEqual(
		model.toolbox.find((group) => group.name === "扩展可视组件")?.items.map((item) => item.name),
		["演示按钮", "滑动页面框"]
	);
	assert.deepEqual(
		model.toolbox.find((group) => group.name === "扩展组件")?.items.map((item) => item.name),
		["应用更新"]
	);
	assert.deepEqual(
		containerGroup?.items.map((item) => item.name),
		["面板", "垂直滚动框", "水平滚动框"]
	);
	assert.equal(visualGroup?.items.find((item) => item.name === "按钮")?.visual, true);
	assert.equal(containerGroup?.items.find((item) => item.name === "面板")?.container, true);
	assert.equal(componentGroup?.items.find((item) => item.name === "计时器")?.visual, false);
	assert.equal(
		path.basename(componentGroup?.items.find((item) => item.name === "计时器")?.icon ?? ""),
		"stopwatch.svg"
	);
	assert.equal(sensorGroup?.items.some((item) => item.name === "加速度传感器"), true);
	assert.equal(model.toolbox.flatMap((group) => group.items).some((item) => item.name === "窗口"), false);

	const addedButton = addSimpleDesignerComponent(
		document,
		sdk,
		"按钮",
		"/属性/定义[1]/定义[1]",
		"canvas"
	);
	assert.equal(addedButton.componentPath, "/属性/定义[1]/定义[1]/定义[4]");
	assert.equal(
		getPropertyXmlAttribute(
			resolvePropertyXmlElement(addedButton.document, addedButton.componentPath),
			"名称"
		),
		"按钮1"
	);
	const addedButtonElement = resolvePropertyXmlElement(addedButton.document, addedButton.componentPath);
	assert.ok(addedButtonElement);
	assert.deepEqual(
		getPropertyXmlChildren(addedButtonElement, "赋值").map((property) => [
			getPropertyXmlAttribute(property, "属性"),
			getPropertyXmlAttribute(property, "值")
		]),
		[["文本", "\"按钮1\""]]
	);
	const codeReservedButton = addSimpleDesignerComponent(
		document,
		sdk,
		"按钮",
		"/属性/定义[1]/定义[1]",
		"canvas",
		undefined,
		undefined,
		undefined,
		new Set(["按钮1"])
	);
	assert.equal(
		getPropertyXmlAttribute(
			resolvePropertyXmlElement(codeReservedButton.document, codeReservedButton.componentPath),
			"名称"
		),
		"按钮2"
	);
	const insertedButton = addSimpleDesignerComponent(
		document,
		sdk,
		"按钮",
		"/属性/定义[1]/定义[1]",
		"canvas",
		{
			position: "before",
			referenceXmlPath: "/属性/定义[1]/定义[1]/定义[2]"
		}
	);
	assert.equal(insertedButton.componentPath, "/属性/定义[1]/定义[1]/定义[2]");
	const insertedTopPanel = resolvePropertyXmlElement(
		insertedButton.document,
		"/属性/定义[1]/定义[1]"
	);
	assert.ok(insertedTopPanel);
	assert.deepEqual(
		getPropertyXmlChildren(insertedTopPanel, "定义").map(
			(component) => getPropertyXmlAttribute(component, "名称")
		),
		["PrevButton", "按钮1", "NextButton", "ExitButton"]
	);
	const addedTimer = addSimpleDesignerComponent(
		document,
		sdk,
		"计时器",
		"/属性/定义[1]/定义[1]",
		"nonvisual",
		{
			position: "before",
			referenceXmlPath: "/属性/定义[1]/定义[1]/定义[1]"
		}
	);
	assert.equal(
		getPropertyXmlAttribute(
			resolvePropertyXmlElement(addedTimer.document, addedTimer.componentPath),
			"名称"
		),
		"计时器1"
	);
	const addedTimerElement = resolvePropertyXmlElement(addedTimer.document, addedTimer.componentPath);
	assert.ok(addedTimerElement);
	assert.deepEqual(getPropertyXmlChildren(addedTimerElement, "赋值"), []);
	const addedTimerModel = createSimpleDesignerModel(addedTimer.document, sdk);
	assert.equal(findComponent(addedTimerModel.root, "计时器1")?.parentPath, addedTimerModel.root?.path);
	assert.deepEqual(
		addedTimerModel.root?.children.map((component) => component.name),
		["TopPanel", "CountdownButton", "StatusLabel", "Timer1", "计时器1"]
	);
	const addedRootButton = addSimpleDesignerComponent(
		document,
		sdk,
		"按钮",
		"/属性/定义[1]",
		"canvas"
	);
	assert.deepEqual(
		createSimpleDesignerModel(addedRootButton.document, sdk).root?.children.map((component) => component.name),
		["TopPanel", "CountdownButton", "StatusLabel", "按钮1", "Timer1"]
	);
	assert.throws(
		() => addSimpleDesignerComponent(document, sdk, "计时器", "/属性/定义[1]", "canvas"),
		/非可视组件只能拖入组件列表/u
	);
	assert.throws(
		() => addSimpleDesignerComponent(
			document,
			sdk,
			"按钮",
			"/属性/定义[1]/定义[1]",
			"canvas",
			{
				position: "after",
				referenceXmlPath: "/属性/定义[1]/定义[2]"
			}
		),
		/不是目标父节点的直接子节点/u
	);
});

test("扩展类库组件定义的行尾注释不影响限定名和别名投影", async () => {
	const source = await fs.readFile(path.resolve(
		"..",
		"sdk",
		"libraries",
		"com.example.demo",
		"sample",
		"src",
		"com",
		"example",
		"demo",
		"sample",
		"主窗口.simple"
	), "utf8");
	const document = parseSimplePropertyXml(source);
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	assert.ok(document);
	const model = createSimpleDesignerModel(document, sdk);
	assert.deepEqual(
		model.root?.children.map((component) => [
			component.name,
			component.type,
			component.typeName,
			component.runtimeType,
			component.visual,
			component.displayText
		]),
		[
			["演示按钮1", "com.example.demo.演示按钮", "演示按钮", "com.example.demo.演示按钮", true, "限定类名定义"],
			["演示按钮2", "演示按钮", "演示按钮", "com.example.demo.演示按钮", true, "别名定义"]
		]
	);
	assert.equal(
		componentHoverHint(model.root?.children[0]!),
		"演示按钮1 - com.example.demo.演示按钮\n演示标题属性和单击事件的按钮组件。"
	);
	assert.equal(model.nonVisualComponents.length, 0);
	assert.equal(path.basename(model.root?.children[0]?.icon ?? ""), "square-rounded-check.svg");
	assert.ok(model.root);
	const added = addSimpleDesignerComponent(document, sdk, "演示按钮", model.root.path, "canvas");
	const addedModel = createSimpleDesignerModel(added.document, sdk);
	const addedButton = findComponent(addedModel.root, "演示按钮3");
	assert.equal(componentPropertyValue(added.document, addedButton, "标题"), "\"演示按钮3\"");
	assert.equal(componentPropertyValue(added.document, addedButton, "文本"), undefined);
});

test("表格布局新增、移动和粘贴组件时写入目标单元格", async () => {
	const document = parseSimplePropertyXml([
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 GridTests $为 窗口",
		"\t\t布局 = 布局_表格",
		"\t\t布局.行数 = 2",
		"\t\t布局.列数 = 2",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.ok(document);
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	assert.throws(
		() => addSimpleDesignerComponent(document, sdk, "按钮", "/属性/定义[1]", "canvas"),
		/具体单元格/u
	);

	const added = addSimpleDesignerComponent(
		document,
		sdk,
		"按钮",
		"/属性/定义[1]",
		"canvas",
		undefined,
		{ column: 0, row: 1 }
	);
	const addedElement = resolvePropertyXmlElement(added.document, added.componentPath);
	assert.ok(addedElement);
	assert.deepEqual(
		getPropertyXmlChildren(addedElement, "赋值").map((assignment) => [
			getPropertyXmlAttribute(assignment, "属性"),
			getPropertyXmlAttribute(assignment, "值")
		]),
		[["文本", "\"按钮1\""], ["行", "1"], ["列", "0"]]
	);

	const moved = relocateSimpleDesignerComponent(
		added.document,
		sdk,
		added.componentPath,
		"/属性/定义[1]",
		undefined,
		{ column: 1, row: 0 }
	);
	const movedElement = resolvePropertyXmlElement(moved.document, moved.selectedPath);
	assert.ok(movedElement);
	assert.deepEqual(
		getPropertyXmlChildren(movedElement, "赋值").map((assignment) => [
			getPropertyXmlAttribute(assignment, "属性"),
			getPropertyXmlAttribute(assignment, "值")
		]),
		[["文本", "\"按钮1\""], ["行", "0"], ["列", "1"]]
	);
	const copied = copySimpleDesignerComponent(moved.document, sdk, moved.selectedPath);
	assert.throws(
		() => pasteSimpleDesignerComponent(moved.document, sdk, "/属性/定义[1]", copied.text),
		/选择表格布局中的空单元格/u
	);
	const pasted = pasteSimpleDesignerComponent(
		moved.document,
		sdk,
		"/属性/定义[1]",
		copied.text,
		{ column: 0, row: 1 }
	);
	const pastedElement = resolvePropertyXmlElement(pasted.document, pasted.componentPath);
	assert.ok(pastedElement);
	assert.deepEqual(
		getPropertyXmlChildren(pastedElement, "赋值").map((assignment) => [
			getPropertyXmlAttribute(assignment, "属性"),
			getPropertyXmlAttribute(assignment, "值")
		]),
		[["文本", "\"按钮1\""], ["行", "1"], ["列", "0"]]
	);
	assert.throws(
		() => pasteSimpleDesignerComponent(
			moved.document,
			sdk,
			"/属性/定义[1]",
			copied.text,
			{ column: 1, row: 0 }
		),
		/已有组件/u
	);
	assert.throws(
		() => addSimpleDesignerComponent(
			moved.document,
			sdk,
			"标签",
			"/属性/定义[1]",
			"canvas",
			undefined,
			{ column: 1, row: 0 }
		),
		/已有组件/u
	);
	assert.throws(
		() => addSimpleDesignerComponent(
			moved.document,
			sdk,
			"标签",
			"/属性/定义[1]",
			"canvas",
			undefined,
			{ column: 2, row: 0 }
		),
		/超出表格布局/u
	);
});

test("绝对布局鼠标新增和拖动组件时写入 DP 坐标", async () => {
	const document = parseSimplePropertyXml([
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 AbsoluteTests $为 窗口",
		"\t\t布局 = 布局_绝对",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.ok(document);
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const unpositioned = addSimpleDesignerComponent(
		document,
		sdk,
		"按钮",
		"/属性/定义[1]",
		"canvas"
	);
	const unpositionedElement = resolvePropertyXmlElement(unpositioned.document, unpositioned.componentPath);
	assert.ok(unpositionedElement);
	assert.deepEqual(
		getPropertyXmlChildren(unpositionedElement, "赋值").map((assignment) => [
			getPropertyXmlAttribute(assignment, "属性"),
			getPropertyXmlAttribute(assignment, "值")
		]),
		[["文本", "\"按钮1\""]]
	);

	const added = addSimpleDesignerComponent(
		document,
		sdk,
		"按钮",
		"/属性/定义[1]",
		"canvas",
		undefined,
		undefined,
		{ left: 24, top: 36 }
	);
	const addedElement = resolvePropertyXmlElement(added.document, added.componentPath);
	assert.ok(addedElement);
	assert.deepEqual(
		getPropertyXmlChildren(addedElement, "赋值").map((assignment) => [
			getPropertyXmlAttribute(assignment, "属性"),
			getPropertyXmlAttribute(assignment, "值")
		]),
		[["文本", "\"按钮1\""], ["左边", "\"24dp\""], ["顶边", "\"36dp\""]]
	);

	const moved = relocateSimpleDesignerComponent(
		added.document,
		sdk,
		added.componentPath,
		"/属性/定义[1]",
		undefined,
		undefined,
		{ left: 48, top: 64 }
	);
	assert.deepEqual(
		findComponent(createSimpleDesignerModel(moved.document, sdk).root, "按钮1")?.absolutePosition,
		{ left: 48, top: 64 }
	);
	const movedElement = resolvePropertyXmlElement(moved.document, moved.selectedPath);
	assert.ok(movedElement);
	assert.deepEqual(
		getPropertyXmlChildren(movedElement, "赋值").map((assignment) => [
			getPropertyXmlAttribute(assignment, "属性"),
			getPropertyXmlAttribute(assignment, "值")
		]),
		[["文本", "\"按钮1\""], ["左边", "\"48dp\""], ["顶边", "\"64dp\""]]
	);
	const nudgedLeft = nudgeSimpleDesignerComponent(
		moved.document,
		sdk,
		moved.selectedPath,
		{ deltaLeft: -1, deltaTop: 0 }
	);
	const nudgedUp = nudgeSimpleDesignerComponent(
		nudgedLeft.document,
		sdk,
		nudgedLeft.selectedPath,
		{ deltaLeft: 0, deltaTop: -1 }
	);
	assert.deepEqual(
		findComponent(createSimpleDesignerModel(nudgedUp.document, sdk).root, "按钮1")?.absolutePosition,
		{ left: 47, top: 63 }
	);
	assert.throws(
		() => nudgeSimpleDesignerComponent(moved.document, sdk, moved.selectedPath, { deltaLeft: 1, deltaTop: 1 }),
		/单一方向的 1dip/u
	);
	const inserted = addSimpleDesignerComponent(
		moved.document,
		sdk,
		"按钮",
		"/属性/定义[1]",
		"canvas",
		{ position: "after", referenceXmlPath: moved.selectedPath },
		undefined,
		{ left: 72, top: 84 }
	);
	const insertedModel = createSimpleDesignerModel(inserted.document, sdk);
	assert.deepEqual(insertedModel.root?.children.map((child) => child.name), ["按钮1", "按钮2"]);
	assert.deepEqual(findComponent(insertedModel.root, "按钮2")?.absolutePosition, { left: 72, top: 84 });
	const insertedElement = resolvePropertyXmlElement(inserted.document, inserted.componentPath);
	assert.ok(insertedElement);
	assert.deepEqual(
		getPropertyXmlChildren(insertedElement, "赋值").map((assignment) => [
			getPropertyXmlAttribute(assignment, "属性"),
			getPropertyXmlAttribute(assignment, "值")
		]),
		[["文本", "\"按钮2\""], ["左边", "\"72dp\""], ["顶边", "\"84dp\""]]
	);
	assert.throws(
		() => addSimpleDesignerComponent(
			document,
			sdk,
			"按钮",
			"/属性/定义[1]",
			"canvas",
			undefined,
			undefined,
			{ left: 1.5, top: 2 }
		),
		/必须是有效整数/u
	);
});

test("画布拖动尺寸只写入变化方向并在绝对布局同步左上坐标", async () => {
	const document = parseSimplePropertyXml([
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 ResizeTests $为 窗口",
		"\t\t布局 = 布局_绝对",
		"\t\t$定义 按钮1 $为 按钮",
		"\t\t\t文本 = \"按钮1\"",
		"\t\t\t左边 = \"24dp\"",
		"\t\t\t顶边 = \"36dp\"",
		"\t\t$结束 $定义",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.ok(document);
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const model = createSimpleDesignerModel(document, sdk);
	assert.equal(model.root?.resizable, false);
	const button = findComponent(model.root, "按钮1");
	assert.equal(button?.resizable, true);
	assert.equal(button?.resizeWidth, true);
	assert.equal(button?.resizeHeight, true);

	const resized = resizeSimpleDesignerComponent(
		document,
		sdk,
		"/属性/定义[1]/定义[1]",
		{ left: 14, top: 26, width: 110, height: 70 }
	);
	const resizedElement = resolvePropertyXmlElement(resized.document, resized.selectedPath);
	assert.ok(resizedElement);
	assert.deepEqual(
		getPropertyXmlChildren(resizedElement, "赋值").map((assignment) => [
			getPropertyXmlAttribute(assignment, "属性"),
			getPropertyXmlAttribute(assignment, "值")
		]),
		[
			["文本", "\"按钮1\""],
			["左边", "\"14dp\""],
			["顶边", "\"26dp\""],
			["宽度", "\"110dp\""],
			["高度", "\"70dp\""]
		]
	);

	const widthOnly = resizeSimpleDesignerComponent(
		document,
		sdk,
		"/属性/定义[1]/定义[1]",
		{ width: 96 }
	);
	const widthOnlyElement = resolvePropertyXmlElement(widthOnly.document, widthOnly.selectedPath);
	assert.ok(widthOnlyElement);
	assert.deepEqual(
		getPropertyXmlChildren(widthOnlyElement, "赋值").map((assignment) => getPropertyXmlAttribute(assignment, "属性")),
		["文本", "左边", "顶边", "宽度"]
	);
	assert.throws(
		() => resizeSimpleDesignerComponent(document, sdk, "/属性/定义[1]", { width: 100 }),
		/不能通过画布调整/u
	);
	assert.throws(
		() => resizeSimpleDesignerComponent(document, sdk, "/属性/定义[1]/定义[1]", { width: -1 }),
		/非负整数/u
	);
});

test("水平线性布局未声明基线对齐时使用 SDK 有效初始值并保持 XML 顺序", async () => {
	const source = await fs.readFile(simpleTestProjectPath(
		"Tetris", "src", "simple", "samples", "tetris", "Tetris.simple"
	), "utf8");
	const document = parseSimplePropertyXml(source);
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	assert.ok(document);
	const gamePanel = findComponent(createSimpleDesignerModel(document, sdk).root, "GamePanel");

	assert.equal(gamePanel?.layout, "linear-horizontal");
	assert.equal(gamePanel?.layoutBaselineAligned, false);
	assert.deepEqual(
		gamePanel?.children.filter((component) => component.visual).map((component) => component.name),
		["SpacerPanel1", "Board", "SpacerPanel2", "PreviewPanel"]
	);
});

test("窗口设计器删除可视或非可视组件并选择回到直接父组件", async () => {
	const source = await fs.readFile(simpleTestProjectPath(
		"StartTests", "src", "simple", "runtime", "tests", "TimerTests.simple"
	), "utf8");
	const document = parseSimplePropertyXml(source);
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	assert.ok(document);
	const model = createSimpleDesignerModel(document, sdk);
	const previousButton = findComponent(model.root, "PrevButton");
	const topPanel = findComponent(model.root, "TopPanel");
	const timer = model.nonVisualComponents.find((component) => component.name === "Timer1");
	assert.ok(previousButton);
	assert.ok(topPanel);
	assert.ok(timer);

	const visualDeleted = deleteSimpleDesignerComponent(document, sdk, previousButton.path);
	assert.equal(visualDeleted.selectedPath, topPanel.path);
	assert.equal(
		findComponent(createSimpleDesignerModel(visualDeleted.document, sdk).root, "PrevButton"),
		undefined
	);
	assert.ok(resolvePropertyXmlElement(document, previousButton.path));

	const nonVisualDeleted = deleteSimpleDesignerComponent(document, sdk, timer.path);
	assert.equal(nonVisualDeleted.selectedPath, model.root?.path);
	assert.equal(
		createSimpleDesignerModel(nonVisualDeleted.document, sdk).nonVisualComponents
			.some((component) => component.name === "Timer1"),
		false
	);
	assert.throws(
		() => deleteSimpleDesignerComponent(document, sdk, model.root?.path ?? ""),
		/窗口根组件不能删除/u
	);
	assert.throws(
		() => deleteSimpleDesignerComponent(document, sdk, "/属性/定义[1]/赋值[1]"),
		/删除目标已经变化/u
	);
});

test("组件脱离父容器时清理失效兄弟锚点并保留同级排序和子树内部锚点", async () => {
	const document = parseSimplePropertyXml([
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 AnchorTests $为 窗口",
		"\t\t布局 = 布局_绝对",
		"\t\t$定义 LeftPanel $为 面板",
		"\t\t\t布局 = 布局_绝对",
		"\t\t\t$定义 TargetPanel $为 面板",
		"\t\t\t\t布局 = 布局_相对",
		"\t\t\t\t位于左边 = Peer.标识",
		"\t\t\t\t$定义 Child1 $为 标签",
		"\t\t\t\t$结束 $定义",
		"\t\t\t\t$定义 Child2 $为 标签",
		"\t\t\t\t\t位于右边 = Child1.标识",
		"\t\t\t\t$结束 $定义",
		"\t\t\t$结束 $定义",
		"\t\t\t$定义 Peer $为 按钮",
		"\t\t\t\t文本 = \"保留\"",
		"\t\t\t\t位于右边 = TargetPanel.标识",
		"\t\t\t$结束 $定义",
		"\t\t$结束 $定义",
		"\t\t$定义 RightPanel $为 面板",
		"\t\t\t布局 = 布局_绝对",
		"\t\t$结束 $定义",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.ok(document);
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const model = createSimpleDesignerModel(document, sdk);
	const leftPanel = findComponent(model.root, "LeftPanel");
	const rightPanel = findComponent(model.root, "RightPanel");
	const targetPanel = findComponent(model.root, "TargetPanel");
	const peer = findComponent(model.root, "Peer");
	assert.ok(leftPanel);
	assert.ok(rightPanel);
	assert.ok(targetPanel);
	assert.ok(peer);

	const reordered = relocateSimpleDesignerComponent(
		document,
		sdk,
		targetPanel.path,
		leftPanel.path,
		{ position: "after", referenceXmlPath: peer.path }
	);
	const reorderedModel = createSimpleDesignerModel(reordered.document, sdk);
	assert.equal(
		componentPropertyValue(reordered.document, findComponent(reorderedModel.root, "TargetPanel"), "位于左边"),
		"Peer.标识"
	);
	assert.equal(
		componentPropertyValue(reordered.document, findComponent(reorderedModel.root, "Peer"), "位于右边"),
		"TargetPanel.标识"
	);

	const relocated = relocateSimpleDesignerComponent(
		document,
		sdk,
		targetPanel.path,
		rightPanel.path
	);
	const relocatedModel = createSimpleDesignerModel(relocated.document, sdk);
	const relocatedTarget = findComponent(relocatedModel.root, "TargetPanel");
	assert.equal(relocatedTarget?.parentPath, findComponent(relocatedModel.root, "RightPanel")?.path);
	assert.equal(componentPropertyValue(relocated.document, relocatedTarget, "位于左边"), undefined);
	assert.equal(
		componentPropertyValue(relocated.document, findComponent(relocatedModel.root, "Peer"), "位于右边"),
		undefined
	);
	assert.equal(
		componentPropertyValue(relocated.document, findComponent(relocatedTarget, "Child2"), "位于右边"),
		"Child1.标识"
	);

	const deleted = deleteSimpleDesignerComponent(document, sdk, targetPanel.path);
	const deletedModel = createSimpleDesignerModel(deleted.document, sdk);
	assert.equal(findComponent(deletedModel.root, "TargetPanel"), undefined);
	assert.equal(
		componentPropertyValue(deleted.document, findComponent(deletedModel.root, "Peer"), "位于右边"),
		undefined
	);
	assert.equal(
		componentPropertyValue(deleted.document, findComponent(deletedModel.root, "Peer"), "文本"),
		"\"保留\""
	);
});

test("窗口设计器复制组件只生成剪贴板文本而不修改 XML", async () => {
	const source = await fs.readFile(simpleTestProjectPath(
		"StartTests", "src", "simple", "runtime", "tests", "TimerTests.simple"
	), "utf8");
	const document = parseSimplePropertyXml(source);
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	assert.ok(document);
	const model = createSimpleDesignerModel(document, sdk);
	const topPanel = findComponent(model.root, "TopPanel");
	assert.ok(topPanel);

	const copied = copySimpleDesignerComponent(
		document,
		sdk,
		topPanel.path
	);
	assert.match(copied.text, /^<定义 名称="TopPanel" 组件="面板">\r\n/u);
	assert.match(copied.text, /\t<定义 名称="PrevButton" 组件="按钮">/u);
	assert.match(copied.text, /<\/定义>\r\n$/u);
	assert.equal(createSimpleDesignerModel(document, sdk).root?.children[0]?.name, "TopPanel");
	assert.throws(
		() => copySimpleDesignerComponent(
			document,
			sdk,
			model.root?.path ?? ""
		),
		/窗口根组件不能复制/u
	);
});

test("窗口设计器键盘粘贴按选中节点确定容器", async () => {
	const source = await fs.readFile(simpleTestProjectPath(
		"StartTests", "src", "simple", "runtime", "tests", "TimerTests.simple"
	), "utf8");
	const document = parseSimplePropertyXml(source);
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	assert.ok(document);
	const root = createSimpleDesignerModel(document, sdk).root;
	const topPanel = findComponent(root, "TopPanel");
	const previousButton = findComponent(root, "PrevButton");
	assert.ok(root);
	assert.ok(topPanel);
	assert.ok(previousButton);

	assert.equal(resolveDesignerPasteTargetPath(root), root.path);
	assert.equal(resolveDesignerPasteTargetPath(topPanel), topPanel.path);
	assert.equal(resolveDesignerPasteTargetPath(previousButton), topPanel.path);
	assert.equal(resolveDesignerPasteTargetPath(undefined), undefined);
});

test("可用组件菜单按当前选择加入安全布局位置", async () => {
	const source = await fs.readFile(simpleTestProjectPath(
		"StartTests", "src", "simple", "runtime", "tests", "TimerTests.simple"
	), "utf8");
	const document = parseSimplePropertyXml(source);
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	assert.ok(document);
	const model = createSimpleDesignerModel(document, sdk);
	const root = model.root;
	const topPanel = findComponent(root, "TopPanel");
	const previousButton = findComponent(root, "PrevButton");
	assert.ok(root);
	assert.ok(topPanel);
	assert.ok(previousButton);
	const firstVisualChild = root.children.find((child) => child.visual);
	assert.ok(firstVisualChild);

	assert.deepEqual(resolveDesignerAddTarget(root, undefined, undefined, true), {
		parentXmlPath: root.path,
		position: "before",
		referenceXmlPath: firstVisualChild.path,
		target: "canvas"
	});
	assert.deepEqual(resolveDesignerAddTarget(root, root, undefined, true), {
		parentXmlPath: root.path,
		position: "before",
		referenceXmlPath: firstVisualChild.path,
		target: "canvas"
	});
	assert.deepEqual(resolveDesignerAddTarget(root, topPanel, undefined, true), {
		parentXmlPath: topPanel.path,
		target: "canvas"
	});
	assert.deepEqual(resolveDesignerAddTarget(root, previousButton, undefined, true), {
		parentXmlPath: topPanel.path,
		position: "after",
		referenceXmlPath: previousButton.path,
		target: "canvas"
	});
	assert.deepEqual(resolveDesignerAddTarget(root, previousButton, undefined, false), {
		parentXmlPath: root.path,
		target: "nonvisual"
	});
});

test("表格格子只在明确选中且为空时作为可用组件加入目标", async () => {
	const document = parseSimplePropertyXml([
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 GridTests $为 窗口",
		"\t\t布局 = 布局_表格",
		"\t\t布局.行数 = 1",
		"\t\t布局.列数 = 2",
		"\t\t$定义 Button1 $为 按钮",
		"\t\t\t行 = 0",
		"\t\t\t列 = 0",
		"\t\t$结束 $定义",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	assert.ok(document);
	const root = createSimpleDesignerModel(document, sdk).root;
	const button = findComponent(root, "Button1");
	assert.ok(root);
	assert.ok(button);

	assert.equal(resolveDesignerAddTarget(root, root, undefined, true), undefined);
	assert.equal(resolveDesignerAddTarget(root, button, undefined, true), undefined);
	assert.equal(resolveDesignerAddTarget(
		root,
		root,
		{ column: 0, parentXmlPath: root.path, row: 0 },
		true
	), undefined);
	assert.deepEqual(resolveDesignerAddTarget(
		root,
		root,
		{ column: 1, parentXmlPath: root.path, row: 0 },
		true
	), {
		gridPosition: { column: 1, row: 0 },
		parentXmlPath: root.path,
		target: "canvas"
	});
});

test("可用组件菜单在选中容器无法接收时回退到容器后方", async () => {
	const document = parseSimplePropertyXml([
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 GridFallback $为 窗口",
		"\t\t$定义 GridPanel $为 面板",
		"\t\t\t布局 = 布局_表格",
		"\t\t\t布局.行数 = 1",
		"\t\t\t布局.列数 = 1",
		"\t\t\t$定义 ExistingButton $为 按钮",
		"\t\t\t\t行 = 0",
		"\t\t\t\t列 = 0",
		"\t\t\t$结束 $定义",
		"\t\t$结束 $定义",
		"\t\t$定义 TailButton $为 按钮",
		"\t\t$结束 $定义",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	assert.ok(document);
	const root = createSimpleDesignerModel(document, sdk).root;
	const gridPanel = findComponent(root, "GridPanel");
	const existingButton = findComponent(root, "ExistingButton");
	assert.ok(root);
	assert.ok(gridPanel);
	assert.ok(existingButton);

	assert.deepEqual(resolveDesignerAddTarget(root, gridPanel, undefined, true), {
		parentXmlPath: root.path,
		position: "after",
		referenceXmlPath: gridPanel.path,
		target: "canvas"
	});
	assert.equal(resolveDesignerAddTarget(root, existingButton, undefined, true), undefined);
});

test("窗口设计器只把剪贴板 XML 子树粘贴到容器并消除组件重名", async () => {
	const source = await fs.readFile(simpleTestProjectPath(
		"StartTests", "src", "simple", "runtime", "tests", "TimerTests.simple"
	), "utf8");
	const document = parseSimplePropertyXml(source);
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	assert.ok(document);
	const model = createSimpleDesignerModel(document, sdk);
	const root = model.root;
	const topPanel = findComponent(root, "TopPanel");
	const previousButton = findComponent(root, "PrevButton");
	assert.ok(root);
	assert.ok(topPanel);
	assert.ok(previousButton);

	const copied = copySimpleDesignerComponent(document, sdk, topPanel.path);
	assert.equal(isSimpleDesignerComponentClipboardText(copied.text, sdk), true);
	assert.equal(isSimpleDesignerComponentClipboardText("普通文本", sdk), false);
	assert.equal(isSimpleDesignerComponentClipboardText('<定义 名称="Missing" 组件="不存在" />', sdk), false);
	const nestedNonVisualXml = [
		'<定义 名称="PanelWithTimer" 组件="面板">',
		'\t<定义 名称="NestedTimer" 组件="计时器">',
		'\t</定义>',
		'</定义>',
		''
	].join("\r\n");
	assert.equal(isSimpleDesignerComponentClipboardText(nestedNonVisualXml, sdk), false);
	const pasted = pasteSimpleDesignerComponent(document, sdk, root.path, copied.text);
	const pastedModel = createSimpleDesignerModel(pasted.document, sdk, pasted.componentPath);
	const pastedPanel = findComponent(pastedModel.root, "TopPanel1");
	assert.ok(pastedPanel);
	assert.equal(pastedModel.selectedPath, pasted.componentPath);
	assert.deepEqual(
		pastedPanel.children.map((component) => component.name),
		["PrevButton1", "NextButton1", "ExitButton1"]
	);
	assert.deepEqual(
		pastedModel.root?.children.map((component) => component.name),
		["TopPanel", "CountdownButton", "StatusLabel", "TopPanel1", "Timer1"]
	);
	const timer = findComponent(model.root, "Timer1");
	assert.ok(timer);
	const copiedTimer = copySimpleDesignerComponent(document, sdk, timer.path);
	const pastedTimer = pasteSimpleDesignerComponent(document, sdk, topPanel.path, copiedTimer.text);
	const pastedTimerModel = createSimpleDesignerModel(pastedTimer.document, sdk);
	assert.equal(findComponent(pastedTimerModel.root, "Timer2")?.parentPath, pastedTimerModel.root?.path);
	assert.deepEqual(
		pastedTimerModel.root?.children.map((component) => component.name),
		["TopPanel", "CountdownButton", "StatusLabel", "Timer1", "Timer2"]
	);
	const numberedButtonXml = '<定义 名称="按钮1" 组件="按钮" />';
	const codeReservedPaste = pasteSimpleDesignerComponent(
		pasted.document,
		sdk,
		pastedModel.root?.path ?? "",
		numberedButtonXml,
		undefined,
		new Set(["按钮1"])
	);
	assert.ok(findComponent(createSimpleDesignerModel(codeReservedPaste.document, sdk).root, "按钮2"));
	const firstNumberedPaste = pasteSimpleDesignerComponent(
		pasted.document,
		sdk,
		pastedModel.root?.path ?? "",
		numberedButtonXml
	);
	const firstNumberedModel = createSimpleDesignerModel(firstNumberedPaste.document, sdk);
	assert.ok(findComponent(firstNumberedModel.root, "按钮1"));
	const secondNumberedPaste = pasteSimpleDesignerComponent(
		firstNumberedPaste.document,
		sdk,
		firstNumberedModel.root?.path ?? "",
		numberedButtonXml
	);
	const secondNumberedModel = createSimpleDesignerModel(secondNumberedPaste.document, sdk);
	assert.ok(findComponent(secondNumberedModel.root, "按钮2"));
	const nestedTarget = findComponent(secondNumberedModel.root, "TopPanel");
	assert.ok(nestedTarget);
	const nestedThirdPaste = pasteSimpleDesignerComponent(
		secondNumberedPaste.document,
		sdk,
		nestedTarget.path,
		'<定义 名称="按钮3" 组件="按钮" />'
	);
	const nestedThirdModel = createSimpleDesignerModel(nestedThirdPaste.document, sdk);
	const fourthNumberedPaste = pasteSimpleDesignerComponent(
		nestedThirdPaste.document,
		sdk,
		nestedThirdModel.root?.path ?? "",
		numberedButtonXml
	);
	assert.ok(findComponent(createSimpleDesignerModel(fourthNumberedPaste.document, sdk).root, "按钮4"));
	assert.equal(createSimpleDesignerModel(document, sdk).root?.children[0]?.name, "TopPanel");
	assert.throws(
		() => pasteSimpleDesignerComponent(document, sdk, previousButton.path, copied.text),
		/不能承载子组件/u
	);
	assert.throws(
		() => pasteSimpleDesignerComponent(document, sdk, root.path, '<赋值 属性="文本" 值="x" />'),
		/不是组件定义 XML/u
	);
	assert.throws(
		() => pasteSimpleDesignerComponent(document, sdk, root.path, '<定义 名称="Missing" 组件="不存在" />'),
		/SDK 中没有剪贴板组件/u
	);
	assert.throws(
		() => pasteSimpleDesignerComponent(document, sdk, root.path, nestedNonVisualXml),
		/非可视组件必须直接位于窗口根节点/u
	);
});

test("窗口设计器只通过 XML 模型前移和后移同级组件", async () => {
	const source = await fs.readFile(simpleTestProjectPath(
		"StartTests", "src", "simple", "runtime", "tests", "TimerTests.simple"
	), "utf8");
	const document = parseSimplePropertyXml(source);
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	assert.ok(document);
	const model = createSimpleDesignerModel(document, sdk);
	const nextButton = findComponent(model.root, "NextButton");
	const statusLabel = findComponent(model.root, "StatusLabel");
	const timer = findComponent(model.root, "Timer1");
	assert.ok(nextButton);
	assert.ok(statusLabel);
	assert.ok(timer);

	const moved = moveSimpleDesignerComponent(document, sdk, nextButton.path, "previous");
	const movedModel = createSimpleDesignerModel(moved.document, sdk);
	assert.deepEqual(
		findComponent(movedModel.root, "TopPanel")?.children.map((node) => node.name),
		["NextButton", "PrevButton", "ExitButton"]
	);
	assert.equal(findComponent(movedModel.root, "NextButton")?.path, moved.selectedPath);
	assert.deepEqual(
		findComponent(model.root, "TopPanel")?.children.map((node) => node.name),
		["PrevButton", "NextButton", "ExitButton"]
	);

	const restored = moveSimpleDesignerComponent(moved.document, sdk, moved.selectedPath, "next");
	assert.deepEqual(
		findComponent(createSimpleDesignerModel(restored.document, sdk).root, "TopPanel")?.children
			.map((node) => node.name),
		["PrevButton", "NextButton", "ExitButton"]
	);
	assert.deepEqual(
		createSimpleDesignerModel(
			moveSimpleDesignerComponent(document, sdk, statusLabel.path, "next").document,
			sdk
		).root?.children.map((node) => node.name),
		["TopPanel", "CountdownButton", "StatusLabel", "Timer1"]
	);
	assert.deepEqual(
		createSimpleDesignerModel(
			moveSimpleDesignerComponent(document, sdk, timer.path, "previous").document,
			sdk
		).root?.children.map((node) => node.name),
		["TopPanel", "CountdownButton", "StatusLabel", "Timer1"]
	);
	assert.throws(
		() => moveSimpleDesignerComponent(document, sdk, model.root?.path ?? "", "next"),
		/窗口根组件不能移动/u
	);
});

test("窗口设计器按 XML 路径把画布组件移动到其它容器和指定插入位置", async () => {
	const source = await fs.readFile(simpleTestProjectPath(
		"StartTests", "src", "simple", "runtime", "tests", "TimerTests.simple"
	), "utf8");
	const document = parseSimplePropertyXml(source);
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	assert.ok(document);
	const model = createSimpleDesignerModel(document, sdk);
	const topPanel = findComponent(model.root, "TopPanel");
	const countdownButton = findComponent(model.root, "CountdownButton");
	const nextButton = findComponent(model.root, "NextButton");
	assert.ok(topPanel);
	assert.ok(countdownButton);
	assert.ok(nextButton);

	const moved = relocateSimpleDesignerComponent(
		document,
		sdk,
		countdownButton.path,
		topPanel.path,
		{ position: "before", referenceXmlPath: nextButton.path }
	);
	const movedModel = createSimpleDesignerModel(moved.document, sdk, moved.selectedPath);
	assert.deepEqual(
		findComponent(movedModel.root, "TopPanel")?.children.map((node) => node.name),
		["PrevButton", "CountdownButton", "NextButton", "ExitButton"]
	);
	assert.equal(findComponent(movedModel.root, "CountdownButton")?.path, moved.selectedPath);
	assert.deepEqual(
		model.root?.children.map((node) => node.name),
		["TopPanel", "CountdownButton", "StatusLabel", "Timer1"]
	);
	assert.throws(
		() => relocateSimpleDesignerComponent(document, sdk, topPanel.path, topPanel.path),
		/自身或自己的子容器/u
	);
	assert.throws(
		() => relocateSimpleDesignerComponent(document, sdk, countdownButton.path, nextButton.path),
		/不是可承载组件的容器/u
	);

	const withAddedTimer = addSimpleDesignerComponent(
		document,
		sdk,
		"计时器",
		topPanel.path,
		"nonvisual"
	);
	const addedTimerModel = createSimpleDesignerModel(withAddedTimer.document, sdk);
	const timer1 = findComponent(addedTimerModel.root, "Timer1");
	const timer2 = findComponent(addedTimerModel.root, "计时器1");
	const addedTimerRoot = addedTimerModel.root;
	assert.ok(timer1);
	assert.ok(timer2);
	assert.ok(addedTimerRoot);
	const movedTimer = relocateSimpleDesignerComponent(
		withAddedTimer.document,
		sdk,
		timer2.path,
		addedTimerRoot.path,
		{ position: "before", referenceXmlPath: timer1.path }
	);
	const movedTimerModel = createSimpleDesignerModel(movedTimer.document, sdk);
	assert.deepEqual(
		movedTimerModel.nonVisualComponents.map((node) => node.name),
		["计时器1", "Timer1"]
	);
	assert.deepEqual(
		findComponent(movedTimerModel.root, "TopPanel")?.children.map((node) => node.name),
		["PrevButton", "NextButton", "ExitButton"]
	);
	const forcedRootTimer = relocateSimpleDesignerComponent(
		withAddedTimer.document,
		sdk,
		timer1.path,
		topPanel.path,
		{ position: "before", referenceXmlPath: nextButton.path }
	);
	const forcedRootTimerModel = createSimpleDesignerModel(forcedRootTimer.document, sdk);
	assert.equal(findComponent(forcedRootTimerModel.root, "Timer1")?.parentPath, forcedRootTimerModel.root?.path);
	assert.deepEqual(
		forcedRootTimerModel.root?.children.map((node) => node.name),
		["TopPanel", "CountdownButton", "StatusLabel", "计时器1", "Timer1"]
	);
	const boundedVisual = relocateSimpleDesignerComponent(
		document,
		sdk,
		countdownButton.path,
		model.root?.path ?? "",
		{ position: "after", referenceXmlPath: findComponent(model.root, "Timer1")?.path ?? "" }
	);
	assert.deepEqual(
		createSimpleDesignerModel(boundedVisual.document, sdk).root?.children.map((node) => node.name),
		["TopPanel", "StatusLabel", "CountdownButton", "Timer1"]
	);
});

test("窗口设计器按 Simple 长度常量和固定 DIP 投影组件尺寸", async () => {
	const source = await fs.readFile(simpleTestProjectPath(
		"Tetris", "src", "simple", "samples", "tetris", "Tetris.simple"
	), "utf8");
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const document = parseSimplePropertyXml(source);
	assert.ok(document);
	const model = createSimpleDesignerModel(document, sdk);
	assert.deepEqual(findComponent(model.root, "StatusPanel")?.width, { kind: "parent" });
	assert.equal(model.root?.scrollable, false);
	assert.deepEqual(findComponent(model.root, "StatusPanel")?.height, { kind: "content" });
	assert.deepEqual(findComponent(model.root, "GamePanel")?.height, { kind: "parent" });
	assert.deepEqual(findComponent(model.root, "PreviewPanel")?.height, { kind: "content" });
	assert.deepEqual(findComponent(model.root, "ScoreLabel")?.width, { kind: "fixed", value: 105 });
	assert.deepEqual(findComponent(model.root, "SpacerPanel0")?.height, { kind: "fixed", value: 32 });

	const contentSizedDocument = parseSimplePropertyXml(source.replace(
		"宽度 = 长度_匹配父级",
		"宽度 = 长度_适应内容"
	));
	assert.ok(contentSizedDocument);
	assert.deepEqual(
		findComponent(createSimpleDesignerModel(contentSizedDocument, sdk).root, "StatusPanel")?.width,
		{ kind: "content" }
	);
	const unknownDocument = parseSimplePropertyXml(source.replace(
		"宽度 = 长度_匹配父级",
		"宽度 = 计算宽度()"
	));
	assert.ok(unknownDocument);
	assert.equal(findComponent(createSimpleDesignerModel(unknownDocument, sdk).root, "StatusPanel")?.width, undefined);

	const scrollableDocument = parseSimplePropertyXml(source.replace(
		'标题 = "Tetris"',
		'标题 = "Tetris"\r\n\t\t滚动 = 真'
	));
	assert.ok(scrollableDocument);
	assert.equal(createSimpleDesignerModel(scrollableDocument, sdk).root?.scrollable, true);
});

test("窗口设计器只投影水平进度条的通用组件属性", async () => {
	const source = await fs.readFile(
		await simpleTestUnitPath("SmokeTests", "测试水平进度条"),
		"utf8"
	);
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const document = parseSimplePropertyXml(source);
	assert.ok(document);
	const model = createSimpleDesignerModel(document, sdk);
	const progress1 = findComponent(model.root, "水平进度条1");
	const progress2 = findComponent(model.root, "水平进度条2");

	assert.deepEqual(model.root?.padding, { bottom: undefined, left: 10, right: 10, top: 10 });
	assert.ok(progress1);
	assert.ok(progress2);
	assert.deepEqual(progress1?.width, { kind: "fixed", value: 200 });
	assert.deepEqual(progress1?.height, { kind: "content" });
	assert.deepEqual(progress2?.width, { kind: "fixed", value: 200 });
	assert.equal("horizontalProgress" in progress1, false);
	assert.equal("horizontalProgress" in progress2, false);
});

test("相对布局拖拽预演与正式写回采用相同的同轴规则和边距清理", () => {
	const component = {
		margin: { left: 8, right: 9, top: 4 },
		relativeRules: { alignParentRight: true, alignParentTop: true }
	};
	const moved = previewDesignerRelativePlacement(component, {
		deltaLeft: 5,
		deltaTop: 0,
		left: 120,
		top: 4
	});
	assert.deepEqual(moved.rules, component.relativeRules);
	assert.deepEqual(moved.margin, { left: 8, right: 4, top: 4 });
	const docked = previewDesignerRelativePlacement(component, {
		deltaLeft: 5,
		deltaTop: 0,
		horizontalDock: { axis: "horizontal", projection: "alignParentLeft" },
		left: 0,
		margin: { left: 12 },
		top: 4
	});
	assert.deepEqual(docked.rules, { alignParentLeft: true, alignParentTop: true });
	assert.deepEqual(docked.margin, { left: 12, top: 4 });
	const centered = previewDesignerRelativePlacement(component, {
		deltaLeft: -2,
		deltaTop: 3,
		horizontalDock: { axis: "horizontal", projection: "centerInParent" },
		left: 120,
		top: 80,
		verticalDock: { axis: "vertical", projection: "centerInParent" }
	});
	assert.deepEqual(centered.rules, { centerInParent: true });
	assert.equal(centered.margin, undefined);
});

test("窗口设计器递归投影容器布局与子组件布局参数", async () => {
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const document = parseSimplePropertyXml([
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 LayoutTests $为 窗口",
		"\t\t布局 = 1",
		"\t\t布局.方向 = 0",
		"\t\t布局.内容对齐 = 11",
		"\t\t布局.基线对齐 = 真",
		"\t\t布局.权重总和 = 4",
		"\t\t左填充 = 6",
		"\t\t顶填充 = 7",
		"\t\t$定义 GridPanel $为 面板",
		"\t\t\t布局 = 2",
		"\t\t\t布局.行数 = 2",
		"\t\t\t布局.列数 = 3",
		"\t\t\t对齐 = 14",
		"\t\t\t权重 = 2",
		"\t\t\t左边距 = 8",
		"\t\t\t底边距 = 9",
		"\t\t\t右填充 = 10",
		"\t\t\t$定义 GridButton $为 按钮",
		"\t\t\t\t行 = 1",
		"\t\t\t\t列 = 2",
		"\t\t\t$结束 $定义",
		"\t\t$结束 $定义",
		"\t\t$定义 ScrollBox $为 垂直滚动框",
		"\t\t\t启用滚动条 = 假",
		"\t\t\t$定义 ScrollPanel $为 面板",
		"\t\t\t$结束 $定义",
		"\t\t$结束 $定义",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.ok(document);
	const model = createSimpleDesignerModel(document, sdk);
	const gridPanel = findComponent(model.root, "GridPanel");
	const gridButton = findComponent(model.root, "GridButton");
	const scrollBox = findComponent(model.root, "ScrollBox");
	const scrollPanel = findComponent(model.root, "ScrollPanel");

	assert.deepEqual(model.root?.layoutContentAlignment, { horizontal: "center", vertical: "center" });
	assert.equal(model.root?.layoutBaselineAligned, true);
	assert.equal(model.root?.layoutWeightSum, 4);
	assert.deepEqual(model.root?.padding, { bottom: undefined, left: 6, right: undefined, top: 7 });
	assert.equal(gridPanel?.layout, "grid");
	assert.equal(gridPanel?.layoutRows, 2);
	assert.equal(gridPanel?.layoutColumns, 3);
	assert.deepEqual(gridPanel?.alignment, { horizontal: "right", vertical: "center" });
	assert.equal(gridPanel?.weight, 2);
	assert.deepEqual(gridPanel?.margin, { bottom: 9, left: 8, right: undefined, top: undefined });
	assert.deepEqual(gridPanel?.padding, { bottom: undefined, left: undefined, right: 10, top: undefined });
	assert.equal(gridButton?.gridRow, 1);
	assert.equal(gridButton?.gridColumn, 2);
	assert.equal(scrollBox?.scrollbarEnabled, false);
	assert.deepEqual(scrollPanel?.width, { kind: "parent" });
	assert.deepEqual(scrollPanel?.height, { kind: "parent" });
});

test("相对布局只从 XML 属性投影父级规则和同级锚点", async () => {
	const source = await fs.readFile(
		await simpleTestUnitPath("SmokeTests", "测试相对布局"),
		"utf8"
	);
	const document = parseSimplePropertyXml(source);
	assert.ok(document);
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const model = createSimpleDesignerModel(document, sdk);
	const panel = findComponent(model.root, "面板1");
	const button = findComponent(model.root, "按钮1");
	const centerButton = findComponent(model.root, "按钮3");
	const anchoredButton = findComponent(model.root, "按钮6");

	assert.equal(model.root?.layout, "linear-vertical");
	assert.deepEqual(model.root?.layoutContentAlignment, { horizontal: "center", vertical: "center" });
	assert.equal(panel?.layout, "relative");
	assert.equal(panel?.layoutReadOnly, false);
	assert.equal(panel?.acceptsVisualChild, true);
	assert.equal(panel?.resizable, true);
	assert.equal(panel?.alignment, undefined);
	assert.equal(button?.layoutReadOnly, false);
	assert.equal(button?.positionReadOnly, true);
	assert.equal(button?.positionDraggable, true);
	assert.deepEqual(button?.relativeMoveAxes, { horizontal: true, vertical: true });
	assert.equal(button?.resizable, true);
	assert.deepEqual(button?.relativeRules, { alignParentRight: true, alignParentTop: true });
	assert.equal(button?.relativeRuleLabels?.alignParentRight, "对齐父右边");
	assert.equal(button?.relativeRuleLabels?.rightOf, "位于右边");
	assert.deepEqual(centerButton?.relativeRules, { centerInParent: true });
	assert.equal(centerButton?.positionDraggable, true);
	assert.deepEqual(centerButton?.relativeMoveAxes, { horizontal: true, vertical: true });
	assert.deepEqual(anchoredButton?.relativeRules, {
		above: centerButton?.path,
		leftOf: centerButton?.path
	});
	assert.equal(panel?.children.some((child) => child.path === button?.path), true);
	assert.deepEqual(resolveDesignerAddTarget(model.root!, panel, undefined, true), {
		parentXmlPath: panel!.path,
		target: "canvas"
	});
	const addedWithoutPlacement = addSimpleDesignerComponent(document, sdk, "按钮", panel!.path, "canvas");
	const addedWithoutPlacementNode = findDesignerComponentNode(
		createSimpleDesignerModel(addedWithoutPlacement.document, sdk).root!,
		addedWithoutPlacement.componentPath
	);
	assert.deepEqual(addedWithoutPlacementNode?.relativeRules, {});
	assert.deepEqual(addedWithoutPlacementNode?.margin, undefined);

	const rootAdded = addSimpleDesignerComponent(document, sdk, "按钮", model.root!.path, "canvas");
	const movedIntoRelative = relocateSimpleDesignerComponent(
		rootAdded.document,
		sdk,
		rootAdded.componentPath,
		panel!.path,
		undefined,
		undefined,
		undefined,
		{
			deltaLeft: 25,
			deltaTop: 30,
			horizontalDock: { axis: "horizontal", projection: "alignLeft", targetXmlPath: centerButton!.path },
			left: 120,
			margin: { left: 5, top: 6 },
			top: 90,
			verticalDock: { axis: "vertical", projection: "alignParentTop" }
		}
	);
	const movedIntoRelativeNode = findDesignerComponentNode(
		createSimpleDesignerModel(movedIntoRelative.document, sdk).root!,
		movedIntoRelative.selectedPath
	);
	assert.equal(movedIntoRelativeNode?.parentPath, panel?.path);
	assert.deepEqual(movedIntoRelativeNode?.relativeRules, {
		alignLeft: centerButton?.path,
		alignParentTop: true
	});
	assert.deepEqual(movedIntoRelativeNode?.margin, {
		bottom: undefined,
		left: 5,
		right: undefined,
		top: 6
	});

	const movedOutOfRelative = relocateSimpleDesignerComponent(
		document,
		sdk,
		button!.path,
		model.root!.path
	);
	const movedOutNode = findDesignerComponentNode(
		createSimpleDesignerModel(movedOutOfRelative.document, sdk).root!,
		movedOutOfRelative.selectedPath
	);
	assert.equal(movedOutNode?.parentPath, model.root?.path);
	assert.equal(componentPropertyValue(movedOutOfRelative.document, movedOutNode, "对齐父右边"), undefined);
	assert.equal(componentPropertyValue(movedOutOfRelative.document, movedOutNode, "对齐父顶边"), undefined);
	assert.equal(componentPropertyValue(movedOutOfRelative.document, movedOutNode, "右边距"), undefined);
	assert.equal(componentPropertyValue(movedOutOfRelative.document, movedOutNode, "顶边距"), undefined);
	assert.doesNotThrow(() => deleteSimpleDesignerComponent(document, sdk, button!.path));
	assert.throws(
		() => moveSimpleDesignerComponent(document, sdk, button!.path, "next"),
		/相对布局中的组件位置只能通过布局属性修改/u
	);
	assert.doesNotThrow(() => resizeSimpleDesignerComponent(document, sdk, button!.path, { width: 100 }));
	assert.doesNotThrow(() => copySimpleDesignerComponent(document, sdk, button!.path));

	const movedButton = moveSimpleDesignerRelativeComponent(
		document,
		sdk,
		button!.path,
		{ deltaLeft: 12, deltaTop: 7, left: 100, top: 80 }
	);
	assert.equal(componentPropertyValue(movedButton.document, button, "右边距"), "\"-12dp\"");
	assert.equal(componentPropertyValue(movedButton.document, button, "顶边距"), "\"7dp\"");
	assert.equal(componentPropertyValue(movedButton.document, button, "对齐父右边"), "真");
	assert.equal(componentPropertyValue(movedButton.document, button, "对齐父顶边"), "真");

	const movedAnchoredButton = moveSimpleDesignerRelativeComponent(
		document,
		sdk,
		anchoredButton!.path,
		{ deltaLeft: 5, deltaTop: 6, left: 120, top: 90 }
	);
	assert.equal(componentPropertyValue(movedAnchoredButton.document, anchoredButton, "右边距"), "\"-5dp\"");
	assert.equal(componentPropertyValue(movedAnchoredButton.document, anchoredButton, "底边距"), "\"-6dp\"");
	assert.equal(componentPropertyValue(movedAnchoredButton.document, anchoredButton, "位于顶边"), "按钮3.标识");
	assert.equal(componentPropertyValue(movedAnchoredButton.document, anchoredButton, "位于左边"), "按钮3.标识");
	const detachedCenter = moveSimpleDesignerRelativeComponent(
		document,
		sdk,
		centerButton!.path,
		{ deltaLeft: 1, deltaTop: 0, left: 125, top: 100 }
	);
	assert.equal(componentPropertyValue(detachedCenter.document, centerButton, "居中于父"), undefined);
	assert.equal(componentPropertyValue(detachedCenter.document, centerButton, "居中垂直"), "真");
	assert.equal(componentPropertyValue(detachedCenter.document, centerButton, "左边距"), "\"125dp\"");

	const dockedButton = moveSimpleDesignerRelativeComponent(
		document,
		sdk,
		button!.path,
		{
			deltaLeft: -20,
			deltaTop: 40,
			horizontalDock: { axis: "horizontal", projection: "alignLeft", targetXmlPath: centerButton!.path },
			left: 140,
			margin: { bottom: 10, left: 8 },
			top: 200,
			verticalDock: { axis: "vertical", projection: "alignParentBottom" }
		}
	);
	const dockedButtonNode = findDesignerComponentNode(
		createSimpleDesignerModel(dockedButton.document, sdk).root!,
		dockedButton.selectedPath
	);
	assert.equal(componentPropertyValue(dockedButton.document, dockedButtonNode, "对齐左边"), "按钮3.标识");
	assert.equal(componentPropertyValue(dockedButton.document, dockedButtonNode, "对齐父底边"), "真");
	assert.equal(componentPropertyValue(dockedButton.document, dockedButtonNode, "对齐父右边"), undefined);
	assert.equal(componentPropertyValue(dockedButton.document, dockedButtonNode, "对齐父顶边"), undefined);
	assert.equal(componentPropertyValue(dockedButton.document, dockedButtonNode, "左边距"), "\"8dp\"");
	assert.equal(componentPropertyValue(dockedButton.document, dockedButtonNode, "右边距"), undefined);
	assert.equal(componentPropertyValue(dockedButton.document, dockedButtonNode, "底边距"), "\"10dp\"");

	const diagonalDockedButton = moveSimpleDesignerRelativeComponent(
		document,
		sdk,
		button!.path,
		{
			deltaLeft: 0,
			deltaTop: 0,
			horizontalDock: { axis: "horizontal", projection: "leftOf", targetXmlPath: centerButton!.path },
			left: 100,
			margin: { right: 20.5, top: 14.5 },
			top: 80,
			verticalDock: { axis: "vertical", projection: "below", targetXmlPath: centerButton!.path }
		}
	);
	const diagonalDockedButtonNode = findDesignerComponentNode(
		createSimpleDesignerModel(diagonalDockedButton.document, sdk).root!,
		diagonalDockedButton.selectedPath
	);
	assert.equal(componentPropertyValue(diagonalDockedButton.document, diagonalDockedButtonNode, "位于左边"), "按钮3.标识");
	assert.equal(componentPropertyValue(diagonalDockedButton.document, diagonalDockedButtonNode, "位于底边"), "按钮3.标识");
	assert.equal(componentPropertyValue(diagonalDockedButton.document, diagonalDockedButtonNode, "右边距"), "\"20.5dp\"");
	assert.equal(componentPropertyValue(diagonalDockedButton.document, diagonalDockedButtonNode, "顶边距"), "\"14.5dp\"");

	const centeredButton = moveSimpleDesignerRelativeComponent(
		document,
		sdk,
		button!.path,
		{
			deltaLeft: -2,
			deltaTop: 3,
			horizontalDock: { axis: "horizontal", projection: "centerInParent" },
			left: 100,
			top: 80,
			verticalDock: { axis: "vertical", projection: "centerInParent" }
		}
	);
	assert.equal(componentPropertyValue(centeredButton.document, button, "居中于父"), "真");
	assert.equal(componentPropertyValue(centeredButton.document, button, "居中水平"), undefined);
	assert.equal(componentPropertyValue(centeredButton.document, button, "居中垂直"), undefined);
	assert.equal(componentPropertyValue(centeredButton.document, button, "对齐父右边"), undefined);
	assert.equal(componentPropertyValue(centeredButton.document, button, "对齐父顶边"), undefined);
	assert.equal(componentPropertyValue(centeredButton.document, button, "右边距"), undefined);
	assert.equal(componentPropertyValue(centeredButton.document, button, "顶边距"), undefined);
});

test("相对布局提交同级锚点后按最靠后锚点调整当前组件顺序", async () => {
	const document = parseSimplePropertyXml([
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 RelativeOrderTests $为 窗口",
		"\t\t布局 = 布局_相对",
		"\t\t$定义 Current $为 按钮",
		"\t\t\t位于顶边 = LateAnchor.标识",
		"\t\t$结束 $定义",
		"\t\t$定义 EarlyAnchor $为 按钮",
		"\t\t$结束 $定义",
		"\t\t$定义 Middle $为 按钮",
		"\t\t$结束 $定义",
		"\t\t$定义 LateAnchor $为 按钮",
		"\t\t$结束 $定义",
		"\t\t$定义 Tail $为 按钮",
		"\t\t$结束 $定义",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.ok(document);
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const model = createSimpleDesignerModel(document, sdk);
	const current = findComponent(model.root, "Current");
	const earlyAnchor = findComponent(model.root, "EarlyAnchor");
	assert.ok(current);
	assert.ok(earlyAnchor);

	const moved = moveSimpleDesignerRelativeComponent(document, sdk, current.path, {
		deltaLeft: 0,
		deltaTop: 0,
		horizontalDock: {
			axis: "horizontal",
			projection: "rightOf",
			targetXmlPath: earlyAnchor.path
		},
		left: 0,
		top: 0
	});
	const movedModel = createSimpleDesignerModel(moved.document, sdk);
	assert.deepEqual(movedModel.root?.children.map((child) => child.name), [
		"EarlyAnchor", "Middle", "LateAnchor", "Current", "Tail"
	]);
	const movedCurrent = findComponent(movedModel.root, "Current");
	assert.equal(moved.selectedPath, movedCurrent?.path);
	assert.equal(componentPropertyValue(moved.document, movedCurrent, "位于右边"), "EarlyAnchor.标识");
	assert.equal(componentPropertyValue(moved.document, movedCurrent, "位于顶边"), "LateAnchor.标识");

	const unchanged = moveSimpleDesignerRelativeComponent(moved.document, sdk, movedCurrent!.path, {
		deltaLeft: 0,
		deltaTop: 0,
		horizontalDock: {
			axis: "horizontal",
			projection: "rightOf",
			targetXmlPath: findComponent(movedModel.root, "EarlyAnchor")!.path
		},
		left: 0,
		top: 0
	});
	assert.deepEqual(createSimpleDesignerModel(unchanged.document, sdk).root?.children.map((child) => child.name), [
		"EarlyAnchor", "Middle", "LateAnchor", "Current", "Tail"
	]);
});

test("相对布局拒绝提交直接或间接循环的同级锚点", async () => {
	const document = parseSimplePropertyXml([
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 RelativeCycleTests $为 窗口",
		"\t\t布局 = 布局_相对",
		"\t\t$定义 Current $为 按钮",
		"\t\t$结束 $定义",
		"\t\t$定义 Anchor $为 按钮",
		"\t\t\t位于右边 = Current.标识",
		"\t\t$结束 $定义",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.ok(document);
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const model = createSimpleDesignerModel(document, sdk);
	const current = findComponent(model.root, "Current");
	const anchor = findComponent(model.root, "Anchor");
	assert.ok(current);
	assert.ok(anchor);
	assert.throws(() => moveSimpleDesignerRelativeComponent(document, sdk, current.path, {
		deltaLeft: 0,
		deltaTop: 0,
		horizontalDock: {
			axis: "horizontal",
			projection: "rightOf",
			targetXmlPath: anchor.path
		},
		left: 0,
		top: 0
	}), /循环锚点/u);
});

test("相对布局居中规则可被拖拽替换且未改变轴继续保留", async () => {
	const document = parseSimplePropertyXml([
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 RelativeAxisTests $为 窗口",
		"\t\t布局 = 布局_相对",
		"\t\t$定义 CenterHorizontalButton $为 按钮",
		"\t\t\t居中水平 = 真",
		"\t\t\t对齐父顶边 = 真",
		"\t\t\t顶边距 = \"2.5dp\"",
		"\t\t$结束 $定义",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.ok(document);
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const button = findComponent(createSimpleDesignerModel(document, sdk).root, "CenterHorizontalButton");
	assert.equal(button?.positionDraggable, true);
	assert.deepEqual(button?.relativeMoveAxes, { horizontal: true, vertical: true });
	const moved = moveSimpleDesignerRelativeComponent(
		document,
		sdk,
		button!.path,
		{ deltaLeft: 0, deltaTop: 5, left: 100, top: 50 }
	);
	assert.equal(componentPropertyValue(moved.document, button, "顶边距"), "\"7.5dp\"");
	const detached = moveSimpleDesignerRelativeComponent(
		document,
		sdk,
		button!.path,
		{ deltaLeft: 1, deltaTop: 0, left: 101, top: 45 }
	);
	assert.equal(componentPropertyValue(detached.document, button, "居中水平"), undefined);
	assert.equal(componentPropertyValue(detached.document, button, "左边距"), "\"101dp\"");
	assert.equal(componentPropertyValue(detached.document, button, "对齐父顶边"), "真");
});

test("容器自身操作由父布局决定且未适配布局只锁定其可视子组件", async () => {
	const document = parseSimplePropertyXml([
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 UnsupportedContainerTests $为 窗口",
		"\t\t布局 = 布局_绝对",
		"\t\t$定义 UnsupportedPanel $为 面板",
		"\t\t\t布局 = 99",
		"\t\t\t$定义 ChildPanel $为 面板",
		"\t\t\t\t布局 = 布局_绝对",
		"\t\t\t\t$定义 ChildButton $为 按钮",
		"\t\t\t\t$结束 $定义",
		"\t\t\t$结束 $定义",
		"\t\t$结束 $定义",
		"\t\t$定义 SiblingLabel $为 标签",
		"\t\t$结束 $定义",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.ok(document);
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const model = createSimpleDesignerModel(document, sdk);
	const unsupportedPanel = findComponent(model.root, "UnsupportedPanel");
	const childPanel = findComponent(model.root, "ChildPanel");
	assert.ok(unsupportedPanel);
	assert.ok(childPanel);

	assert.equal(unsupportedPanel.layout, "unsupported");
	assert.equal(unsupportedPanel.layoutReadOnly, false);
	assert.equal(unsupportedPanel.childrenLayoutReadOnly, true);
	assert.equal(unsupportedPanel.resizable, true);
	assert.equal(childPanel.layoutReadOnly, true);
	assert.equal(childPanel.childrenLayoutReadOnly, true);
	assert.equal(childPanel.resizable, false);
	assert.doesNotThrow(() => resizeSimpleDesignerComponent(document, sdk, unsupportedPanel.path, { width: 120 }));
	assert.doesNotThrow(() => nudgeSimpleDesignerComponent(
		document,
		sdk,
		unsupportedPanel.path,
		{ deltaLeft: 1, deltaTop: 0 }
	));
	assert.doesNotThrow(() => moveSimpleDesignerComponent(document, sdk, unsupportedPanel.path, "next"));
	assert.doesNotThrow(() => deleteSimpleDesignerComponent(document, sdk, unsupportedPanel.path));
	assert.throws(
		() => addSimpleDesignerComponent(document, sdk, "按钮", unsupportedPanel.path, "canvas"),
		/当前布局尚未适配/u
	);
	assert.throws(
		() => resizeSimpleDesignerComponent(document, sdk, childPanel.path, { width: 120 }),
		/尺寸不能通过画布调整/u
	);

	const unsupportedRootDocument = parseSimplePropertyXml([
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 UnsupportedRootTests $为 窗口",
		"\t\t布局 = 99",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.ok(unsupportedRootDocument);
	const unsupportedRoot = createSimpleDesignerModel(unsupportedRootDocument, sdk).root;
	assert.equal(unsupportedRoot?.layoutReadOnly, false);
	assert.equal(unsupportedRoot?.childrenLayoutReadOnly, true);
	assert.doesNotThrow(() => addSimpleDesignerComponent(
		unsupportedRootDocument,
		sdk,
		"计时器",
		unsupportedRoot?.path ?? "",
		"nonvisual"
	));
});

test("组件优先投影文本，编辑框空文本时投影提示文本", async () => {
	const document = parseSimplePropertyXml([
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 EmptyContentTests $为 窗口",
		"\t\t$定义 EmptyButton $为 按钮",
		"\t\t$结束 $定义",
		"\t\t$定义 TextButton $为 按钮",
		"\t\t\t文本 = \"确定\"",
		"\t\t$结束 $定义",
		"\t\t$定义 MultilineLabel $为 标签",
		"\t\t\t文本 = \"第一行\\n第二行\"",
		"\t\t$结束 $定义",
		"\t\t$定义 HintEdit $为 编辑框",
		"\t\t\t提示文本 = \"请输入内容\"",
		"\t\t\t提示颜色 = &HFF112233",
		"\t\t$结束 $定义",
		"\t\t$定义 TextEdit $为 编辑框",
		"\t\t\t文本 = \"实际内容\"",
		"\t\t\t文本颜色 = &HFF445566",
		"\t\t\t提示文本 = \"不会显示\"",
		"\t\t\t提示颜色 = &HFF778899",
		"\t\t$结束 $定义",
		"\t\t$定义 EmptyEdit $为 编辑框",
		"\t\t$结束 $定义",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.ok(document);
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const model = createSimpleDesignerModel(document, sdk);
	const emptyButton = findComponent(model.root, "EmptyButton");
	const textButton = findComponent(model.root, "TextButton");
	const multilineLabel = findComponent(model.root, "MultilineLabel");
	const hintEdit = findComponent(model.root, "HintEdit");
	const textEdit = findComponent(model.root, "TextEdit");
	const emptyEdit = findComponent(model.root, "EmptyEdit");
	assert.equal(emptyButton?.displayText, "");
	assert.equal(emptyButton?.displayTextPlaceholder, true);
	assert.equal(emptyButton?.width?.kind, "content");
	assert.equal(emptyButton?.height?.kind, "content");
	assert.equal(textButton?.displayText, "确定");
	assert.equal(textButton?.displayTextPlaceholder, false);
	assert.equal(multilineLabel?.displayText, "第一行\n第二行");
	assert.equal(hintEdit?.displayText, "请输入内容");
	assert.equal(hintEdit?.displayTextPlaceholder, false);
	assert.equal(hintEdit?.textColor, "#112233FF");
	assert.equal(hintEdit?.width?.kind, "content");
	assert.equal(hintEdit?.height?.kind, "content");
	assert.equal(textEdit?.displayText, "实际内容");
	assert.equal(textEdit?.displayTextPlaceholder, false);
	assert.equal(textEdit?.textColor, "#445566FF");
	assert.equal(emptyEdit?.displayText, "");
	assert.equal(emptyEdit?.displayTextPlaceholder, true);
});

test("自定义组件样例中的空编辑框按提示文本投影", async () => {
	const source = await fs.readFile(await simpleTestUnitPath("SmokeTests", "测试自定义组件"), "utf8");
	const document = parseSimplePropertyXml(source);
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	assert.ok(document);
	const edit = findComponent(createSimpleDesignerModel(document, sdk).root, "编辑框1");

	assert.equal(edit?.displayText, "点击上面项目 - 获取项目标识");
	assert.equal(edit?.displayTextPlaceholder, false);
	assert.equal(edit?.width?.kind, "content");
	assert.equal(edit?.height?.kind, "content");
});

test("滚动框只接受一个直属可视组件", async () => {
	const document = parseSimplePropertyXml([
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 ScrollTests $为 窗口",
		"\t\t$定义 Scroll1 $为 垂直滚动框",
		"\t\t\t$定义 InsideButton $为 按钮",
		"\t\t\t$结束 $定义",
		"\t\t$结束 $定义",
		"\t\t$定义 Panel1 $为 面板",
		"\t\t\t$定义 OutsideButton $为 按钮",
		"\t\t\t$结束 $定义",
		"\t\t$结束 $定义",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.ok(document);
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const scrollPath = "/属性/定义[1]/定义[1]";
	const insidePath = scrollPath + "/定义[1]";
	const outsidePath = "/属性/定义[1]/定义[2]/定义[1]";
	assert.equal(findComponent(createSimpleDesignerModel(document, sdk).root, "Scroll1")?.acceptsVisualChild, false);
	assert.throws(
		() => addSimpleDesignerComponent(document, sdk, "按钮", scrollPath, "canvas"),
		/滚动框只能直接包含一个可视组件/u
	);
	const clipboard = copySimpleDesignerComponent(document, sdk, outsidePath).text;
	assert.throws(
		() => pasteSimpleDesignerComponent(document, sdk, scrollPath, clipboard),
		/滚动框只能直接包含一个可视组件/u
	);
	assert.throws(
		() => relocateSimpleDesignerComponent(document, sdk, outsidePath, scrollPath),
		/滚动框只能直接包含一个可视组件/u
	);
	assert.equal(
		relocateSimpleDesignerComponent(document, sdk, insidePath, scrollPath).selectedPath,
		insidePath
	);
	assert.throws(
		() => pasteSimpleDesignerComponent(document, sdk, "/属性/定义[1]", [
			"<定义 名称=\"InvalidScroll\" 组件=\"垂直滚动框\">",
			"\t<定义 名称=\"First\" 组件=\"按钮\">",
			"\t</定义>",
			"\t<定义 名称=\"Second\" 组件=\"按钮\">",
			"\t</定义>",
			"</定义>"
		].join("\r\n")),
		/滚动框包含多个直属可视组件/u
	);
});

test("窗口设计器按 Java 运行库常量投影文本内容水平对齐", async () => {
	const source = await fs.readFile(simpleTestProjectPath(
		"StartTests", "src", "simple", "runtime", "tests", "RadioButtonTests.simple"
	), "utf8");
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const document = parseSimplePropertyXml(source);
	assert.ok(document);
	const model = createSimpleDesignerModel(document, sdk);

	assert.deepEqual(
		findComponent(model.root, "RadioButton0")?.contentAlignment,
		{ horizontal: "left", vertical: "top" }
	);
	assert.deepEqual(
		findComponent(model.root, "RadioButton2")?.contentAlignment,
		{ horizontal: "right", vertical: "top" }
	);
	assert.deepEqual(
		findComponent(model.root, "PrevButton")?.contentAlignment,
		{ horizontal: "center", vertical: "center" }
	);
});

test("窗口设计器投影文本组件字体和 ARGB 颜色属性", async () => {
	const source = await fs.readFile(simpleTestProjectPath(
		"StartTests", "src", "simple", "runtime", "tests", "RadioButtonTests.simple"
	), "utf8");
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const document = parseSimplePropertyXml(source);
	assert.ok(document);
	const model = createSimpleDesignerModel(document, sdk);

	assert.equal(findComponent(model.root, "RadioButton3")?.backgroundColor, "#00FF00FF");
	assert.equal(findComponent(model.root, "RadioButton5")?.fontBold, true);
	assert.equal(findComponent(model.root, "RadioButton6")?.fontItalic, true);
	assert.equal(findComponent(model.root, "RadioButton7")?.fontSize, 20);
	assert.equal(findComponent(model.root, "RadioButton8")?.fontFamily, "monospace");
	assert.equal(findComponent(model.root, "RadioButton9")?.textColor, "#00FF00FF");

	const constantDocument = parseSimplePropertyXml(source.replace("文本颜色 = &HFF00FF00", "文本颜色 = 颜色_绿"));
	assert.ok(constantDocument);
	assert.equal(
		findComponent(createSimpleDesignerModel(constantDocument, sdk).root, "RadioButton9")?.textColor,
		"#00FF00FF"
	);
	const expressionDocument = parseSimplePropertyXml(source.replace("字体大小 = 20", "字体大小 = 计算字号()"));
	assert.ok(expressionDocument);
	assert.equal(
		findComponent(createSimpleDesignerModel(expressionDocument, sdk).root, "RadioButton7")?.fontSize,
		undefined
	);
});
