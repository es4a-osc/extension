/*
验证 SDK 元数据与当前通用 XML 节点合并后的属性框路径绑定模型。
xhwsd@qq.com 2026-8-28
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";
import { PropertyPanelSymbolValidationError, updatePropertyPanelValue } from "../propertyPanel";
import {
	createPropertyPanelModel
} from "../propertyPanelModel";
import {
	findPropertyXmlElementPath,
	getPropertyXmlAttribute,
	getPropertyXmlChildren,
	inspectSimplePropertyXml,
	parseSimplePropertyXml,
	readPropertyXmlValue,
	serializeSimplePropertySource
} from "../propertyXml";
import { loadSdk, SIMPLE_VISIBLE_COMPONENT_TYPE, type Sdk } from "../sdk";
import { parseSimpleUnitSymbolsFromModel, type SimpleProjectSemanticContext } from "../simpleUnitSymbols";
import { parseSimpleStringLiteral, serializeSimpleStringLiteral } from "../simpleStringLiteral";
import { simpleTestProjectPath, simpleTestUnitPath } from "./testProjects";

const ROOT_DIRECTORY = path.resolve(__dirname, "../..");

describe("单元与组件属性框 XML 路径模型", () => {
	test("字符串字面量隐藏外围引号并按 Simple 转义规则自动补回", () => {
		assert.equal(parseSimpleStringLiteral("\"测试\""), "测试");
		assert.equal(parseSimpleStringLiteral("\"引号：\\\"，路径：C:\\\\Temp\""), "引号：\"，路径：C:\\Temp");
		assert.equal(parseSimpleStringLiteral("\"前缀\" & 名称"), undefined);
		assert.equal(parseSimpleStringLiteral("取标题()"), undefined);
		assert.equal(serializeSimpleStringLiteral("引号：\"，路径：C:\\Temp"), "\"引号：\\\"，路径：C:\\\\Temp\"");
	});

	test("四类单元都以 XML 根节点建立属性框", () => {
		const unitTypes = ["窗口", "对象", "接口", "服务"] as const;
		for (const unitType of unitTypes) {
			const document = parseSimplePropertyXml([
				"$属性",
				"\t$资源 $" + unitType,
				"$结束 $属性"
			].join("\r\n"));
			assert.ok(document);
			const unitName = unitType + "1";
			const model = createPropertyPanelModel(document, document.root, undefined, unitName);
			assert.equal(model.title, unitName);
			assert.equal(model.subtitle, unitType);
			assert.equal(model.groups[0]?.name, "单元");
			assert.deepEqual(model.groups[0]?.rows.map((row) => [row.name, row.value]), [
				["名称", unitName],
				["类型", unitType]
			]);
		}
	});

	test("Tetris 组件属性全部绑定到所选 XML 定义节点的路径", async () => {
		const source = fs.readFileSync(simpleTestProjectPath(
			"Tetris", "src", "simple",
			"samples", "tetris", "Tetris.simple"
		), "utf8");
		const document = parseSimplePropertyXml(source);
		assert.ok(document);
		const sdk = await loadSdk(path.join(ROOT_DIRECTORY, "..", "sdk", "sdk.json"));
		const component = getPropertyXmlChildren(document.root, "定义")[0];
		assert.ok(component);
		const model = createPropertyPanelModel(document, component, sdk);

		assert.equal(model.title, "Tetris");
		assert.equal(model.subtitle, "窗口");
		assert.equal(model.component, true);
		assert.equal(path.basename(model.icon ?? ""), "device-screen.svg");
		assert.deepEqual(model.groups.map((group) => group.name), [
			"组件", "可视组件", "窗口", "线性布局"
		]);
		assert.deepEqual(model.groups[0]?.rows.map((row) => [row.name, row.value]), [
			["名称", "Tetris"],
			["注释", ""]
		]);
		assert.equal(
			model.groups[0]?.rows[0]?.description,
			"组件在当前窗口中的唯一名称。\n名称必须符合 Simple 标识符规则，且不能与其他组件重名。\n修改名称后，会同步更新用户代码和 XML 属性中的组件引用。"
		);
		assert.deepEqual(model.groups[0]?.rows[0]?.editTarget, {
			effect: "renameComponent",
			xmlPath: "/属性/定义[1]/@名称"
		});
		assert.deepEqual(model.groups[0]?.rows[1], {
			description: "组件定义的行尾注释，不影响组件运行。",
			editTarget: {
				effect: "editComponentComment",
				xmlPath: "/属性/定义[1]/@注释"
			},
			name: "注释",
			value: "",
			valueSource: "default"
		});

		const windowGroup = model.groups.find((group) => group.name === "窗口");
		assert.ok(windowGroup);
		const titleRow = windowGroup.rows.find((row) => row.name === "标题");
		assert.equal(titleRow?.value, "\"Tetris\"");
		assert.equal(titleRow?.stringLiteralInput, "Tetris");
		assert.equal(titleRow?.defaultExpression, "\"\"");
		assert.deepEqual(titleRow?.editTarget, {
			removeElementWhenEmpty: true,
			xmlPath: "/属性/定义[1]/赋值[@属性='标题']/@值"
		});
		assert.equal(titleRow?.valueSource, "explicit");
		const windowLayoutRow = windowGroup.rows.find((row) => row.name === "布局");
		assert.equal(windowLayoutRow?.value, "布局_线性");
		assert.equal(windowLayoutRow?.stringLiteralInput, undefined);
		assert.deepEqual(windowLayoutRow?.choices, [
			{ label: "线性", value: "布局_线性" },
			{ label: "表格", value: "布局_表格" },
			{ label: "单帧", value: "布局_单帧" },
			{ label: "相对", value: "布局_相对" },
			{ label: "绝对", value: "布局_绝对" }
		]);
		const scrollRow = windowGroup.rows.find((row) => row.name === "滚动");
		assert.equal(scrollRow?.valueSource, "default");
		assert.equal(scrollRow?.value, "假");
		assert.equal(scrollRow?.defaultExpression, "假");
		assert.deepEqual(scrollRow?.choices, [
			{ label: "真", value: "真" },
			{ label: "假", value: "假" }
		]);

		const layoutGroup = model.groups.find((group) => group.name === "线性布局");
		const directionRow = layoutGroup?.rows.find((row) => row.name === "布局.方向");
		assert.equal(directionRow?.value, "布局_方向_垂直");
		assert.equal(directionRow?.defaultExpression, "布局_方向_垂直");
		assert.deepEqual(directionRow?.choices, [
			{ label: "水平", value: "布局_方向_水平" },
			{ label: "垂直", value: "布局_方向_垂直" }
		]);
		const contentAlignmentRow = layoutGroup?.rows.find((row) => row.name === "布局.内容对齐");
		assert.equal(contentAlignmentRow?.value, "对齐_左");
		assert.equal(contentAlignmentRow?.defaultExpression, "对齐_左");
		const baselineAlignmentRow = layoutGroup?.rows.find((row) => row.name === "布局.基线对齐");
		assert.equal(baselineAlignmentRow?.value, "假");
		assert.equal(baselineAlignmentRow?.defaultExpression, "假");
		assert.deepEqual(
			baselineAlignmentRow?.choices,
			[
				{ label: "真", value: "真" },
				{ label: "假", value: "假" }
			]
		);

		const panel = getPropertyXmlChildren(component, "定义").find(
			(element) => getPropertyXmlAttribute(element, "名称") === "StatusPanel"
		);
		assert.ok(panel);
		const panelModel = createPropertyPanelModel(document, panel, sdk);
		const panelLayoutRow = panelModel.groups.find(
			(group) => group.name === "面板"
		)?.rows.find((row) => row.name === "布局");
		assert.deepEqual(panelLayoutRow?.choices, windowLayoutRow?.choices);
	});

	test("扩展类库组件属性框顶部显示定义短名称", async () => {
		const source = fs.readFileSync(path.resolve(
			ROOT_DIRECTORY,
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
		const sdk = await loadSdk(path.join(ROOT_DIRECTORY, "..", "sdk", "sdk.json"));
		assert.ok(document);
		const window = getPropertyXmlChildren(document.root, "定义")[0];
		const component = window === undefined ? undefined : getPropertyXmlChildren(window, "定义")[0];
		assert.ok(component);

		const model = createPropertyPanelModel(document, component, sdk);
		assert.equal(model.title, "演示按钮1");
		assert.equal(model.subtitle, "演示按钮");
	});

	test("组件注释编辑定义节点属性并在清空时保留组件", () => {
		const document = parseSimplePropertyXml([
			"$属性",
			"\t$资源 $窗口",
			"\t$定义 主窗口 $为 窗口",
			"\t$结束 $定义",
			"$结束 $属性",
			""
		].join("\r\n"));
		assert.ok(document);
		const request = (value: string) => ({
			contextToken: "test",
			effect: "editComponentComment" as const,
			removeElementWhenEmpty: false,
			renderVersion: 0,
			selectedComponentName: "主窗口",
			selectedXmlPath: "/属性/定义[1]",
			type: "updateXmlValue" as const,
			value,
			xmlPath: "/属性/定义[1]/@注释"
		});

		const added = updatePropertyPanelValue("", document, undefined, "主窗口", request("类库演示"));
		const addedWindow = getPropertyXmlChildren(added.propertyDocument.root, "定义")[0];
		assert.ok(addedWindow);
		assert.equal(getPropertyXmlAttribute(addedWindow, "注释"), "类库演示");
		assert.match(serializeSimplePropertySource(added.propertyDocument), /\$定义 主窗口 \$为 窗口 ' 类库演示/u);
		assert.equal(
			createPropertyPanelModel(added.propertyDocument, addedWindow, undefined)
				.groups[0]?.rows[1]?.valueSource,
			"explicit"
		);

		const cleared = updatePropertyPanelValue("", added.propertyDocument, undefined, "主窗口", request(""));
		const clearedWindow = getPropertyXmlChildren(cleared.propertyDocument.root, "定义")[0];
		assert.ok(clearedWindow);
		assert.equal(getPropertyXmlAttribute(clearedWindow, "名称"), "主窗口");
		assert.equal(getPropertyXmlAttribute(clearedWindow, "注释"), undefined);
		assert.doesNotMatch(serializeSimplePropertySource(cleared.propertyDocument), /类库演示/u);
	});

	test("属性选项按 SDK 标签显示并始终提交声明值", () => {
		const document = parseSimplePropertyXml([
			"$属性",
			"\t$资源 $窗口",
			"\t$定义 测试窗口 $为 窗口",
			"\t\t$定义 组件1 $为 测试组件",
			"\t\t\t尺寸 = -2",
			"\t\t$结束 $定义",
			"\t$结束 $定义",
			"$结束 $属性"
		].join("\r\n"));
		assert.ok(document);
		const sdk: Sdk = {
			capabilities: { projects: [], tools: [] },
			templates: {},
			directory: "C:\\sdk",
			filePath: "C:\\sdk\\sdk.json",
			issues: [],
			manifests: [{
				categories: [{
					definitions: [{
						inherits: [SIMPLE_VISIBLE_COMPONENT_TYPE],
						kind: "component",
						name: "测试组件",
						properties: [{
							initializer: { label: "缺省短名", value: "短名" },
							name: "模式",
							select: {
								options: [
									{ label: "短", value: "短名" },
									{ label: "完整", value: "组件.完整名" },
									{ label: "重复值", value: "短名" }
								]
							},
							type: "整数型"
						}, {
							editor: "simple.integer",
							initializer: { label: "适应内容", value: "组件.长度_适应内容" },
							name: "尺寸",
							select: {
								input: true,
								options: [
									{ label: "适应内容", value: "组件.长度_适应内容" },
									{ label: "匹配父级", value: "组件.长度_匹配父级" }
								]
							},
							type: "整数型"
						}],
						type: "test.测试组件"
					}],
					name: "测试"
				}],
				directory: "C:\\sdk",
				filePath: "C:\\sdk\\library.json",
				name: "测试库"
			}]
		};
		const window = getPropertyXmlChildren(document.root, "定义")[0];
		const component = window === undefined ? undefined : getPropertyXmlChildren(window, "定义")[0];
		assert.ok(component);
		const rows = createPropertyPanelModel(document, component, sdk).groups.flatMap((group) => group.rows);
		const row = rows.find((candidate) => candidate.name === "模式");
		const customRow = rows.find((candidate) => candidate.name === "尺寸");

		assert.equal(row?.value, "短名");
		assert.equal(row?.defaultLabel, "缺省短名");
		assert.deepEqual(row?.choices, [
			{ label: "短", value: "短名" },
			{ label: "完整", value: "组件.完整名" }
		]);
		assert.equal(row?.allowCustomValue, undefined);
		assert.equal(customRow?.allowCustomValue, true);
		assert.equal(customRow?.defaultLabel, "适应内容");
		assert.deepEqual(customRow?.choices, [
			{ label: "适应内容", value: "组件.长度_适应内容" },
			{ label: "匹配父级", value: "组件.长度_匹配父级" }
		]);
		const selectedConstant = updatePropertyPanelValue(
			"",
			document,
			sdk,
			"测试窗口",
			{
				contextToken: "test",
				removeElementWhenEmpty: true,
				renderVersion: 0,
				selectedXmlPath: "/属性/定义[1]/定义[1]",
				type: "updateXmlValue",
				value: "组件.长度_匹配父级",
				xmlPath: "/属性/定义[1]/定义[1]/赋值[@属性='尺寸']/@值"
			}
		);
		assert.equal(
			readPropertyXmlValue(selectedConstant.propertyDocument, "/属性/定义[1]/定义[1]/赋值[@属性='尺寸']/@值"),
			"组件.长度_匹配父级"
		);

		assert.throws(() => updatePropertyPanelValue(
			"",
			document,
			sdk,
			"测试窗口",
			{
				contextToken: "test",
				removeElementWhenEmpty: true,
				renderVersion: 0,
				selectedXmlPath: "/属性/定义[1]/定义[1]",
				type: "updateXmlValue",
				value: "其它",
				xmlPath: "/属性/定义[1]/定义[1]/赋值[@属性='模式']/@值"
			}
		), /不在属性允许选择的常量中/u);
		const customUpdated = updatePropertyPanelValue(
			"",
			document,
			sdk,
			"测试窗口",
			{
				contextToken: "test",
				removeElementWhenEmpty: true,
				renderVersion: 0,
				selectedXmlPath: "/属性/定义[1]/定义[1]",
				type: "updateXmlValue",
				value: "200",
				xmlPath: "/属性/定义[1]/定义[1]/赋值[@属性='尺寸']/@值"
			}
		);
		assert.equal(
			readPropertyXmlValue(customUpdated.propertyDocument, "/属性/定义[1]/定义[1]/赋值[@属性='尺寸']/@值"),
			"200"
		);
		assert.throws(() => updatePropertyPanelValue(
			"",
			document,
			sdk,
			"测试窗口",
			{
				contextToken: "test",
				removeElementWhenEmpty: true,
				renderVersion: 0,
				selectedXmlPath: "/属性/定义[1]",
				type: "updateXmlValue",
				value: "200",
				xmlPath: "/属性/定义[1]/定义[1]/赋值[@属性='尺寸']/@值"
			}
		), /当前不可编辑/u);
	});

	test("设计器属性面板按许可路径修改 XML 并拒绝未允许的候选外值", async () => {
		const source = fs.readFileSync(simpleTestProjectPath(
			"Tetris", "src", "simple",
			"samples", "tetris", "Tetris.simple"
		), "utf8");
		const document = parseSimplePropertyXml(source);
		assert.ok(document);
		const sdk = await loadSdk(path.join(ROOT_DIRECTORY, "..", "sdk", "sdk.json"));
		const component = getPropertyXmlChildren(document.root, "定义")[0];
		assert.ok(component);
		const updated = updatePropertyPanelValue(
			source,
			document,
			sdk,
			"Tetris",
			{
				contextToken: "test",
				removeElementWhenEmpty: true,
				renderVersion: 0,
				selectedXmlPath: "/属性/定义[1]",
				type: "updateXmlValue",
				value: "\"新标题\"",
				xmlPath: "/属性/定义[1]/赋值[@属性='标题']/@值"
			}
		);
		assert.equal(
			readPropertyXmlValue(updated.propertyDocument, "/属性/定义[1]/赋值[@属性='标题']/@值"),
			"\"新标题\""
		);

		assert.throws(() => updatePropertyPanelValue(
			source,
			document,
			sdk,
			"Tetris",
			{
				contextToken: "test",
				removeElementWhenEmpty: true,
				renderVersion: 0,
				selectedXmlPath: "/属性/定义[1]",
				type: "updateXmlValue",
				value: "999",
				xmlPath: "/属性/定义[1]/赋值[@属性='布局']/@值"
			}
		), /不在属性允许选择的常量中/u);
	});

	test("属性提交使用当前单元语义上下文拒绝不存在的原子符号", async () => {
		const source = [
			"$属性",
			"\t$资源 $窗口",
			"\t$定义 测试窗口 $为 窗口",
			"\t\t布局 = 布局_线性",
			"\t\t$定义 按钮1 $为 按钮",
			"\t\t\t权重 = 1",
			"\t\t$结束 $定义",
			"\t$结束 $定义",
			"$结束 $属性"
		].join("\r\n");
		const property = inspectSimplePropertyXml(source);
		assert.ok(property.document);
		const sdk = await loadSdk(path.join(ROOT_DIRECTORY, "..", "sdk", "sdk.json"));
		const filePath = path.join(ROOT_DIRECTORY, "fixtures", "测试窗口.simple");
		const currentUnit = parseSimpleUnitSymbolsFromModel("", property, filePath, path.dirname(filePath));
		const semanticContext: SimpleProjectSemanticContext = {
			currentUnit,
			manifest: {
				categories: [{ definitions: [currentUnit.definition], hidden: true, name: "当前单元" }],
				directory: path.dirname(filePath),
				filePath,
				kind: "project",
				name: "测试项目"
			}
		};
		const request = (value: string) => ({
			contextToken: "test",
			removeElementWhenEmpty: true,
			renderVersion: 0,
			selectedXmlPath: "/属性/定义[1]/定义[1]",
			type: "updateXmlValue" as const,
			value,
			xmlPath: "/属性/定义[1]/定义[1]/赋值[@属性='权重']/@值"
		});
		assert.throws(() => updatePropertyPanelValue(
			"",
			property.document!,
			sdk,
			"测试窗口",
			request("s"),
			semanticContext
		), PropertyPanelSymbolValidationError);
		const updated = updatePropertyPanelValue(
			"",
			property.document,
			sdk,
			"测试窗口",
			request("像素转换.到绝对像素(10)"),
			semanticContext
		);
		assert.equal(
			readPropertyXmlValue(updated.propertyDocument, request("").xmlPath),
			"像素转换.到绝对像素(10)"
		);
	});

	test("切换容器布局时删除全部旧布局属性赋值", async () => {
		const document = parseSimplePropertyXml([
			"$属性",
			"\t$资源 $窗口",
			"\t$定义 测试窗口 $为 窗口",
			"\t\t布局 = 布局_线性",
			"\t\t布局.方向 = 布局_方向_水平",
			"\t\t布局.内容对齐 = 居中",
			"\t\t布局.未知属性 = 旧值",
			"\t\t标题 = \"测试\"",
			"\t$结束 $定义",
			"$结束 $属性"
		].join("\r\n"));
		assert.ok(document);
		const sdk = await loadSdk(path.join(ROOT_DIRECTORY, "..", "sdk", "sdk.json"));
		const updated = updatePropertyPanelValue(
			"",
			document,
			sdk,
			"测试窗口",
			{
				contextToken: "test",
				removeElementWhenEmpty: true,
				renderVersion: 0,
				selectedXmlPath: "/属性/定义[1]",
				type: "updateXmlValue",
				value: "布局_表格",
				xmlPath: "/属性/定义[1]/赋值[@属性='布局']/@值"
			}
		);
		const window = getPropertyXmlChildren(updated.propertyDocument.root, "定义")[0];
		assert.ok(window);
		assert.deepEqual(
			getPropertyXmlChildren(window, "赋值").map((property) => [
				getPropertyXmlAttribute(property, "属性"),
				getPropertyXmlAttribute(property, "值")
			]),
			[
				["布局", "布局_表格"],
				["标题", "\"测试\""]
			]
		);
	});

	test("SDK 标记为不可写的组件属性只显示且拒绝提交", async () => {
		const document = parseSimplePropertyXml([
			"$属性",
			"\t$资源 $窗口",
			"\t$定义 测试窗口 $为 窗口",
			"\t\t$定义 音频播放器1 $为 音频播放器",
			"\t\t\t时长 = 123",
			"\t\t$结束 $定义",
			"\t$结束 $定义",
			"$结束 $属性"
		].join("\r\n"));
		assert.ok(document);
		const sdk = await loadSdk(path.join(ROOT_DIRECTORY, "..", "sdk", "sdk.json"));
		const window = getPropertyXmlChildren(document.root, "定义")[0];
		const player = window === undefined ? undefined : getPropertyXmlChildren(window, "定义")[0];
		assert.ok(player);
		const rows = createPropertyPanelModel(document, player, sdk).groups.flatMap((group) => group.rows);
		const duration = rows.find((row) => row.name === "时长");
		const position = rows.find((row) => row.name === "位置");

		assert.equal(duration?.value, "123");
		assert.equal(duration?.valueSource, "explicit");
		assert.equal(duration?.editTarget, undefined);
		assert.ok(position?.editTarget);
		assert.throws(() => updatePropertyPanelValue(
			"",
			document,
			sdk,
			"测试窗口",
			{
				contextToken: "test",
				removeElementWhenEmpty: true,
				renderVersion: 0,
				selectedXmlPath: "/属性/定义[1]/定义[1]",
				type: "updateXmlValue",
				value: "456",
				xmlPath: "/属性/定义[1]/定义[1]/赋值[@属性='时长']/@值"
			}
		), /当前不可编辑/u);
	});

	test("属性框只显示 SDK 明确声明的缺省值", async () => {
		const source = fs.readFileSync(
			await simpleTestUnitPath("SmokeTests", "测试按钮"),
			"utf8"
		);
		const document = parseSimplePropertyXml(source);
		assert.ok(document);
		const sdk = await loadSdk(path.join(ROOT_DIRECTORY, "..", "sdk", "sdk.json"));
		const window = getPropertyXmlChildren(document.root, "定义")[0];
		const button = window === undefined ? undefined : getPropertyXmlChildren(window, "定义")[0];
		assert.ok(button);
		const rows = createPropertyPanelModel(document, button, sdk).groups.flatMap((group) => group.rows);
		assert.equal(rows.find((row) => row.name === "宽度")?.value, "");
		assert.equal(rows.find((row) => row.name === "宽度")?.defaultExpression, undefined);
		assert.equal(rows.find((row) => row.name === "宽度")?.editor, "simple.pixel");
		assert.equal(rows.find((row) => row.name === "高度")?.value, "");
		assert.equal(rows.find((row) => row.name === "高度")?.defaultExpression, undefined);
		assert.equal(rows.find((row) => row.name === "高度")?.editor, "simple.pixel");
		assert.equal(rows.find((row) => row.name === "可视")?.value, "真");
	});

	test("simple.color 保留源码表达式并提供颜色选择器投影", () => {
		const sdk: Sdk = {
			capabilities: { projects: [], tools: [] },
			templates: {},
			directory: "C:\\sdk",
			filePath: "C:\\sdk\\sdk.json",
			issues: [],
			manifests: [{
				categories: [{
					definitions: [{
						constants: [{ name: "颜色_绿", type: "整数型", value: "&H8000FF00" }],
						kind: "interface",
						name: "颜色"
					}, {
						kind: "component",
						name: "测试组件",
						properties: [{ editor: "simple.color", name: "颜色", type: "整数型" }],
						type: "test.测试组件"
					}],
					name: "测试"
				}],
				directory: "C:\\sdk",
				filePath: "C:\\sdk\\library.json",
				kind: "runtime",
				name: "测试库"
			}]
		};
		const colorRow = (expression: string) => {
			const document = parseSimplePropertyXml([
				"$属性",
				"\t$资源 $窗口",
				"\t$定义 测试窗口 $为 窗口",
				"\t\t$定义 组件1 $为 测试组件",
				`\t\t\t颜色 = ${expression}`,
				"\t\t$结束 $定义",
				"\t$结束 $定义",
				"$结束 $属性"
			].join("\r\n"));
			assert.ok(document);
			const window = getPropertyXmlChildren(document.root, "定义")[0];
			const component = window === undefined ? undefined : getPropertyXmlChildren(window, "定义")[0];
			assert.ok(component);
			return createPropertyPanelModel(document, component, sdk).groups
				.flatMap((group) => group.rows)
				.find((row) => row.name === "颜色");
		};

		const literal = colorRow("&H8000FF00");
		assert.equal(literal?.value, "&H8000FF00");
		assert.deepEqual(literal?.color, {
			alpha: "80",
			inputValue: "#00FF00",
			previewValue: "#00FF0080"
		});

		const constant = colorRow("颜色_绿");
		assert.equal(constant?.value, "颜色_绿");
		assert.deepEqual(constant?.color, literal?.color);

		const expression = colorRow("取颜色()");
		assert.equal(expression?.value, "取颜色()");
		assert.deepEqual(expression?.color, { alpha: "FF", inputValue: "#000000" });
	});

	test("表格布局属性缺省值完全来自运行库清单", async () => {
		const document = parseSimplePropertyXml([
			"$属性",
			"\t$资源 $窗口",
			"\t$定义 测试窗口 $为 窗口",
			"\t\t布局 = 2",
			"\t$结束 $定义",
			"$结束 $属性"
		].join("\r\n"));
		assert.ok(document);
		const sdk = await loadSdk(path.join(ROOT_DIRECTORY, "..", "sdk", "sdk.json"));
		const window = getPropertyXmlChildren(document.root, "定义")[0];
		assert.ok(window);
		const layoutRows = createPropertyPanelModel(document, window, sdk).groups
			.find((group) => group.name === "表格布局")?.rows;

		assert.deepEqual(layoutRows?.map((row) => [
			row.name,
			row.value,
			row.defaultExpression,
			row.valueSource
		]), [
			["布局.行数", "0", "0", "default"],
			["布局.列数", "0", "0", "default"],
			["布局.内容对齐", "对齐_上", "对齐_上", "default"],
			["布局.所有列可收缩", "假", "假", "default"],
			["布局.所有列可拉伸", "真", "真", "default"]
		]);
	});

	test("布局设置只显示当前布局声明的属性", async () => {
		const sdk = await loadSdk(path.join(ROOT_DIRECTORY, "..", "sdk", "sdk.json"));
		for (const [layout, groupName, expectedRows] of [
			["布局_表格", "表格布局", ["布局.行数", "布局.列数", "布局.内容对齐", "布局.所有列可收缩", "布局.所有列可拉伸"]],
			["布局_单帧", "单帧布局", []],
			["布局_相对", "相对布局", []],
			["布局_绝对", "绝对布局", []]
		] as const) {
			const document = parseSimplePropertyXml([
				"$属性",
				"\t$资源 $窗口",
				"\t$定义 测试窗口 $为 窗口",
				`\t\t布局 = ${layout}`,
				"\t\t布局.方向 = 布局_方向_水平",
				"\t$结束 $定义",
				"$结束 $属性"
			].join("\r\n"));
			assert.ok(document);
			const window = getPropertyXmlChildren(document.root, "定义")[0];
			assert.ok(window);
			const layoutRows = createPropertyPanelModel(document, window, sdk).groups
				.find((group) => group.name === groupName)?.rows ?? [];

			assert.deepEqual(layoutRows.map((row) => row.name), expectedRows);
			assert.equal(
				getPropertyXmlChildren(window, "赋值")
					.some((property) => getPropertyXmlAttribute(property, "属性") === "布局.方向"),
				true
			);
		}
	});

	test("组件属性按直接父容器布局过滤并支持 SDK 自定义子分组", async () => {
		const sdk = await loadSdk(path.join(ROOT_DIRECTORY, "..", "sdk", "sdk.json"));
		const relativeComponentRows = [
			"位于左边", "位于顶边", "位于右边", "位于底边", "对齐基线",
			"对齐左边", "对齐顶边", "对齐右边", "对齐底边",
			"位于开始", "位于结束", "对齐开始", "对齐结束"
		];
		const relativeParentRows = [
			"对齐父左边", "对齐父顶边", "对齐父右边", "对齐父底边",
			"居中于父", "居中水平", "居中垂直",
			"对齐父开始", "对齐父结束"
		];
		for (const [layout, expectedGroups] of [
			["", [["位于线性布局", ["对齐", "权重"]]]],
			["布局_线性", [["位于线性布局", ["对齐", "权重"]]]],
			["2", [["位于表格布局", ["对齐", "行", "列"]]]],
			["布局_单帧", [["位于单帧布局", ["对齐"]]]],
			["组件.布局_相对", [
				["位于相对布局 · 同级组件", relativeComponentRows],
				["位于相对布局 · 父级容器", relativeParentRows]
			]],
			["5", [["位于绝对布局", ["左边", "顶边"]]]]
		] as const) {
			const document = parseSimplePropertyXml([
				"$属性",
				"\t$资源 $窗口",
				"\t$定义 测试窗口 $为 窗口",
				...(layout === "" ? [] : [`\t\t布局 = ${layout}`]),
				"\t\t$定义 按钮1 $为 按钮",
				"\t\t\t行 = 1",
				"\t\t\t左边 = \"10dp\"",
				"\t\t\t保留字段 = 保留值",
				"\t\t$结束 $定义",
				"\t$结束 $定义",
				"$结束 $属性"
			].join("\r\n"));
			assert.ok(document);
			const window = getPropertyXmlChildren(document.root, "定义")[0];
			const button = window === undefined ? undefined : getPropertyXmlChildren(window, "定义")[0];
			assert.ok(window);
			assert.ok(button);

			const model = createPropertyPanelModel(document, button, sdk);
			for (const [groupName, expectedRows] of expectedGroups) {
				assert.deepEqual(
					model.groups.find((group) => group.name === groupName)?.rows.map((row) => row.name),
					expectedRows
				);
			}
			assert.deepEqual(
				model.groups.find((group) => group.name === "其它")?.rows.map((row) => row.name),
				["保留字段"]
			);
			const groupNames = new Set<string>(expectedGroups.map(([groupName]) => groupName));
			const expectedRows = new Set<string>(expectedGroups.flatMap(([, rows]) => rows));
			assert.equal(
				model.groups
					.filter((group) => !groupNames.has(group.name))
					.flatMap((group) => group.rows)
					.some((row) => expectedRows.has(row.name)),
				false
			);
		}
	});

	test("group 不依赖 layouts 并追加在属性原有归属分组后", async () => {
		const sdk = await loadSdk(path.join(ROOT_DIRECTORY, "..", "sdk", "sdk.json"));
		const runtime = sdk.manifests.find((manifest) => manifest.kind === "runtime");
		const visualComponent = runtime?.categories
			.flatMap((category) => category.definitions)
			.find((definition) => definition.name === "可视组件");
		const backgroundColor = visualComponent?.properties
			?.find((property) => property.name === "背景颜色");
		assert.ok(backgroundColor);
		Object.assign(backgroundColor, { group: "外观" });

		const document = parseSimplePropertyXml([
			"$属性",
			"\t$资源 $窗口",
			"\t$定义 测试窗口 $为 窗口",
			"\t\t$定义 按钮1 $为 按钮",
			"\t\t$结束 $定义",
			"\t$结束 $定义",
			"$结束 $属性"
		].join("\r\n"));
		assert.ok(document);
		const window = getPropertyXmlChildren(document.root, "定义")[0];
		const button = window === undefined ? undefined : getPropertyXmlChildren(window, "定义")[0];
		assert.ok(button);

		const model = createPropertyPanelModel(document, button, sdk);
		assert.deepEqual(
			model.groups.find((group) => group.name === "可视组件 · 外观")?.rows.map((row) => row.name),
			["背景颜色"]
		);
	});

	test("相对布局属性分组显示并只修改自身赋值", async () => {
		const source = fs.readFileSync(
			await simpleTestUnitPath("SmokeTests", "测试相对布局"),
			"utf8"
		);
		const document = parseSimplePropertyXml(source);
		assert.ok(document);
		const sdk = await loadSdk(path.join(ROOT_DIRECTORY, "..", "sdk", "sdk.json"));
		const window = getPropertyXmlChildren(document.root, "定义")[0];
		const panel = window === undefined ? undefined : getPropertyXmlChildren(window, "定义")[0];
		const button = panel === undefined
			? undefined
			: getPropertyXmlChildren(panel, "定义").find(
				(candidate) => getPropertyXmlAttribute(candidate, "名称") === "按钮6"
			);
		assert.ok(button);

		const anchorRow = createPropertyPanelModel(document, button, sdk).groups
			.find((group) => group.name === "位于相对布局 · 同级组件")?.rows
			.find((row) => row.name === "位于左边");
		assert.ok(anchorRow);
		assert.equal(anchorRow.value, "按钮3.标识");
		assert.equal(anchorRow.valueSource, "explicit");
		assert.equal(anchorRow.editTarget?.removeElementWhenEmpty, true);
		assert.deepEqual(anchorRow.choices?.map((choice) => choice.label), [
			"按钮1", "按钮2", "按钮3", "按钮4", "按钮5",
			"按钮7", "按钮8", "按钮9", "按钮10", "按钮11"
		]);
		assert.deepEqual(
			anchorRow.choices?.map((choice) => choice.value),
			anchorRow.choices?.map((choice) => `${choice.label}.标识`)
		);
		const buttonPath = findPropertyXmlElementPath(document, button);
		assert.ok(buttonPath);
		assert.ok(anchorRow.editTarget);
		const topRow = createPropertyPanelModel(document, button, sdk).groups
			.find((group) => group.name === "位于相对布局 · 同级组件")?.rows
			.find((row) => row.name === "位于顶边");
		assert.ok(topRow?.editTarget);
		const updated = updatePropertyPanelValue("", document, sdk, "测试相对布局", {
			contextToken: "test",
			removeElementWhenEmpty: true,
			renderVersion: 0,
			selectedXmlPath: buttonPath,
			type: "updateXmlValue",
			value: "按钮1.标识",
			xmlPath: anchorRow.editTarget.xmlPath
		});
		assert.equal(readPropertyXmlValue(updated.propertyDocument, anchorRow.editTarget.xmlPath), "按钮1.标识");
		assert.equal(readPropertyXmlValue(updated.propertyDocument, topRow.editTarget.xmlPath), "按钮3.标识");
		const cleared = updatePropertyPanelValue("", updated.propertyDocument, sdk, "测试相对布局", {
			contextToken: "test",
			removeElementWhenEmpty: true,
			renderVersion: 0,
			selectedXmlPath: buttonPath,
			type: "updateXmlValue",
			value: "",
			xmlPath: anchorRow.editTarget.xmlPath
		});
		assert.equal(readPropertyXmlValue(cleared.propertyDocument, anchorRow.editTarget.xmlPath), undefined);
		assert.equal(readPropertyXmlValue(cleared.propertyDocument, topRow.editTarget.xmlPath), "按钮3.标识");
	});

	test("属性框提交后把当前组件移动到相对锚点之后并保持选择", async () => {
		const document = parseSimplePropertyXml([
			"$属性",
			"\t$资源 $窗口",
			"\t$定义 RelativePropertyOrderTests $为 窗口",
			"\t\t布局 = 布局_相对",
			"\t\t$定义 Current $为 按钮",
			"\t\t$结束 $定义",
			"\t\t$定义 Middle $为 按钮",
			"\t\t$结束 $定义",
			"\t\t$定义 Anchor $为 按钮",
			"\t\t$结束 $定义",
			"\t$结束 $定义",
			"$结束 $属性"
		].join("\r\n"));
		assert.ok(document);
		const sdk = await loadSdk(path.join(ROOT_DIRECTORY, "..", "sdk", "sdk.json"));
		const window = getPropertyXmlChildren(document.root, "定义")[0];
		const current = window === undefined
			? undefined
			: getPropertyXmlChildren(window, "定义").find(
				(candidate) => getPropertyXmlAttribute(candidate, "名称") === "Current"
			);
		assert.ok(current);
		const currentPath = findPropertyXmlElementPath(document, current);
		assert.ok(currentPath);
		const anchorRow = createPropertyPanelModel(document, current, sdk).groups
			.find((group) => group.name === "位于相对布局 · 同级组件")?.rows
			.find((row) => row.name === "位于左边");
		assert.ok(anchorRow?.editTarget);

		const updated = updatePropertyPanelValue("", document, sdk, "RelativePropertyOrderTests", {
			contextToken: "test",
			removeElementWhenEmpty: true,
			renderVersion: 0,
			selectedXmlPath: currentPath,
			type: "updateXmlValue",
			value: "Anchor.标识",
			xmlPath: anchorRow.editTarget.xmlPath
		});
		const updatedWindow = getPropertyXmlChildren(updated.propertyDocument.root, "定义")[0];
		const updatedChildren = updatedWindow === undefined
			? []
			: getPropertyXmlChildren(updatedWindow, "定义");
		assert.deepEqual(updatedChildren.map((child) => getPropertyXmlAttribute(child, "名称")), [
			"Middle", "Anchor", "Current"
		]);
		const updatedCurrent = updatedChildren.find(
			(child) => getPropertyXmlAttribute(child, "名称") === "Current"
		);
		assert.ok(updatedCurrent);
		assert.equal(updated.selectedPath, findPropertyXmlElementPath(updated.propertyDocument, updatedCurrent));
		assert.equal(
			createPropertyPanelModel(updated.propertyDocument, updatedCurrent, sdk).groups
				.find((group) => group.name === "位于相对布局 · 同级组件")?.rows
				.find((row) => row.name === "位于左边")?.value,
			"Anchor.标识"
		);
	});

	test("逻辑属性的显式真值保持输入来源，不与 SDK 缺省值混淆", async () => {
		const source = fs.readFileSync(
			await simpleTestUnitPath("SmokeTests", "测试按钮"),
			"utf8"
		);
		const document = parseSimplePropertyXml(source);
		assert.ok(document);
		const sdk = await loadSdk(path.join(ROOT_DIRECTORY, "..", "sdk", "sdk.json"));
		const window = getPropertyXmlChildren(document.root, "定义")[0];
		const boldButton = window === undefined
			? undefined
			: getPropertyXmlChildren(window, "定义").find(
				(component) => getPropertyXmlAttribute(component, "名称") === "按钮5"
			);
		assert.ok(boldButton);
		const boldRow = createPropertyPanelModel(document, boldButton, sdk).groups
			.flatMap((group) => group.rows)
			.find((row) => row.name === "字体加粗");

		assert.equal(boldRow?.value, "真");
		assert.equal(boldRow?.valueSource, "explicit");
		assert.deepEqual(boldRow?.choices, [
			{ label: "真", value: "真" },
			{ label: "假", value: "假" }
		]);
	});

	test("文本组件内容对齐和字体类型提供 Java 运行库对应的 SDK 选项", async () => {
		const source = fs.readFileSync(simpleTestProjectPath(
			"StartTests", "src", "simple",
			"runtime", "tests", "RadioButtonTests.simple"
		), "utf8");
		const document = parseSimplePropertyXml(source);
		assert.ok(document);
		const sdk = await loadSdk(path.join(ROOT_DIRECTORY, "..", "sdk", "sdk.json"));
		const windowComponent = getPropertyXmlChildren(document.root, "定义")[0];
		const radioButton = windowComponent === undefined
			? undefined
			: getPropertyXmlChildren(windowComponent, "定义").find(
				(component) => getPropertyXmlAttribute(component, "名称") === "RadioButton2"
			);
		assert.ok(radioButton);
		const model = createPropertyPanelModel(document, radioButton, sdk);
		const row = model.groups.flatMap((group) => group.rows)
			.find((candidate) => candidate.name === "内容对齐");

		assert.equal(row?.value, "2");
		assert.equal(row?.defaultExpression, "对齐_左");
		assert.deepEqual(row?.choices, [
			{ label: "左", value: "对齐_左" },
			{ label: "水平居中", value: "对齐_水平居中" },
			{ label: "右", value: "对齐_右" },
			{ label: "上", value: "对齐_上" },
			{ label: "垂直居中", value: "对齐_垂直居中" },
			{ label: "下", value: "对齐_下" },
			{ label: "左上", value: "对齐_左上" },
			{ label: "左中", value: "对齐_左中" },
			{ label: "左下", value: "对齐_左下" },
			{ label: "中上", value: "对齐_中上" },
			{ label: "居中", value: "对齐_居中" },
			{ label: "中下", value: "对齐_中下" },
			{ label: "右上", value: "对齐_右上" },
			{ label: "右中", value: "对齐_右中" },
			{ label: "右下", value: "对齐_右下" }
		]);

		const fontRadioButton = windowComponent === undefined
			? undefined
			: getPropertyXmlChildren(windowComponent, "定义").find(
				(component) => getPropertyXmlAttribute(component, "名称") === "RadioButton8"
			);
		assert.ok(fontRadioButton);
		const fontRow = createPropertyPanelModel(document, fontRadioButton, sdk).groups
			.flatMap((group) => group.rows)
			.find((candidate) => candidate.name === "字体类型");
		assert.equal(fontRow?.value, "3");
		assert.equal(fontRow?.defaultExpression, "字体类型_默认");
		assert.deepEqual(fontRow?.choices, [
			{ label: "默认", value: "字体类型_默认" },
			{ label: "无衬线", value: "字体类型_无衬线" },
			{ label: "衬线", value: "字体类型_衬线" },
			{ label: "等宽", value: "字体类型_等宽" }
		]);
	});

	test("对象单元属性按 XML 根路径读取和置值", async () => {
		const document = parseSimplePropertyXml([
			"$属性",
			"\t$资源 $对象",
			"\t基础对象 = simple.example.BaseObject",
			"$结束 $属性"
		].join("\r\n"));
		assert.ok(document);
		const sdk = await loadSdk(path.join(ROOT_DIRECTORY, "..", "sdk", "sdk.json"));
		const model = createPropertyPanelModel(document, document.root, sdk, "DerivedObject");

		assert.deepEqual(model.groups[1]?.rows.map((row) => [
			row.name,
			row.value,
			row.valueSource
		]), [
			["基础对象", "simple.example.BaseObject", "explicit"],
			["实现接口", "", "default"]
		]);
		assert.deepEqual(model.groups[1]?.rows.map((row) => row.editTarget), [
			{
				removeElementWhenEmpty: true,
				xmlPath: "/属性/赋值[@属性='基础对象']/@值"
			},
			{
				removeElementWhenEmpty: true,
				xmlPath: "/属性/赋值[@属性='实现接口']/@值"
			}
		]);
	});

	test("对象 XML 没有显式赋值时仍提供路径绑定的空白填写项", async () => {
		const document = parseSimplePropertyXml([
			"$属性",
			"\t$资源 $对象",
			"$结束 $属性"
		].join("\r\n"));
		assert.ok(document);
		const sdk = await loadSdk(path.join(ROOT_DIRECTORY, "..", "sdk", "sdk.json"));
		const model = createPropertyPanelModel(document, document.root, sdk, "EmptyObject");
		assert.deepEqual(model.groups[1]?.rows.map((row) => [row.name, row.value]), [
			["基础对象", ""],
			["实现接口", ""]
		]);
	});
});
