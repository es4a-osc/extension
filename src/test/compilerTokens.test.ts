/*
验证 Simple 编译器标记规则的构建与扫描结果。
xhwsd@qq.com 2026-8-27
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import {
	buildCompilerTokenRules,
	buildDocumentTokenRules,
	tokenizeSimpleText
} from "../compilerTokens";
import { loadSimpleProject } from "../programResources";
import { ProjectSymbolIndex } from "../projectSymbolIndex";
import { loadSdk, type Sdk } from "../sdk";
import { parseSimpleUnitSymbols, type SimpleProjectSemanticContext } from "../simpleUnitSymbols";
import { splitSimpleUnitSource } from "../simpleUnitSource";
import { simpleTestProjectPath } from "./testProjects";

/** 将测试完整单元在加载边界拆成用户代码和派生语义上下文。 */
function documentModel(source: string): {
	readonly context: SimpleProjectSemanticContext;
	readonly userCode: string;
} {
	const unit = parseSimpleUnitSymbols(source, "C:\\project\\src\\Test.simple", "C:\\project\\src");
	return {
		context: {
			currentUnit: unit,
			manifest: {
				categories: [{ definitions: [unit.definition], hidden: true, name: "测试单元" }],
				description: "测试单元",
				directory: "C:\\project\\src",
				filePath: "C:\\project\\project.properties",
				kind: "project",
				name: "测试项目"
			}
		},
		userCode: splitSimpleUnitSource(source).userCode
	};
}

test("编译器清单动态生成语义着色规则", () => {
	const sdk: Sdk = {
		capabilities: { projects: [], tools: [] },
		templates: {},
		directory: "C:\\SDK",
		filePath: "C:\\SDK\\entry.json",
		issues: [],
		manifests: [
			{
				categories: [
					{
						definitions: [
							{ kind: "declaration", name: "函数" },
							{ kind: "modifier", name: "静态" },
							{ kind: "control", name: "如果" },
							{ kind: "control", name: "结束" },
							{ kind: "declaration", name: "创建" },
							{ kind: "operator", name: "为" }
						],
						name: "关键字"
					},
					{
						definitions: [
							{ kind: "type", name: "整数型" },
							{ kind: "type", name: "对象" }
						],
						name: "数据类型"
					},
					{
						definitions: [
							{ kind: "literal", name: "真" },
							{ kind: "operator", name: ">=" }
						],
						name: "运算符"
					},
					{
						definitions: [
							{ kind: "$keyword", name: "$资源" },
							{ kind: "$type", name: "$接口" }
						],
						hidden: true,
						name: "属性区"
					}
				],
				directory: "C:\\SDK\\simple",
				filePath: "C:\\SDK\\simple\\SimpleCompiler.json",
				kind: "compiler",
				name: "编译器"
			}
		]
	};

	const rules = buildCompilerTokenRules(sdk);
	const source = [
		"变量 示例 为 对象",
		"静态 变量 数值 为 整数型",
		"' 如果 真 >= $窗口",
		"文本 = \"如果 真\"",
		"如果 真 >= 数值",
		"创建 示例",
		"$资源 $接口",
		"如果值",
		"结束 函数",
		"结束 如果"
	].join("\n");
	const tokens = tokenizeSimpleText(source, rules);

	assert.deepEqual(
		tokens.map((token) => [token.line, token.text, token.type]),
		[
			[0, "为", "operator"],
			[0, "对象", "type"],
			[1, "静态", "simpleModifier"],
			[1, "为", "operator"],
			[1, "整数型", "type"],
			[4, "如果", "simpleControl"],
			[4, "真", "enumMember"],
			[4, ">=", "operator"],
			[5, "创建", "simpleDeclaration"],
			[6, "$资源", "keyword"],
			[6, "$接口", "type"],
			[8, "结束", "simpleDeclaration"],
			[8, "函数", "simpleDeclaration"],
			[9, "结束", "simpleControl"],
			[9, "如果", "simpleControl"]
		]
	);
});

test("用户函数和过程的声明及调用使用一致的语义着色", () => {
	const source = [
		"函数 TurnRight(value 为 整数型) 为 整数型",
		"  TurnRight = value + 1",
		"结束 函数",
		"过程 CheckRow()",
		"  TurnRight(1)",
		"  CheckRow()",
		"结束 过程",
		"' 函数 Ignored()",
		"文本 = \"TurnRight()\""
	].join("\n");
	const model = documentModel(source);
	const tokens = tokenizeSimpleText(
		model.userCode,
		buildDocumentTokenRules(model.userCode, undefined, model.context)
	);

	assert.deepEqual(
		tokens.map((token) => [token.line, token.text, token.type]),
		[
			[0, "TurnRight", "function"],
			[0, "value", "parameter"],
			[1, "TurnRight", "function"],
			[1, "value", "parameter"],
			[3, "CheckRow", "function"],
			[4, "TurnRight", "function"],
			[5, "CheckRow", "function"]
		]
	);
});

test("变量、常量、参数、属性、事件和组件实例在声明与引用处一致着色", () => {
	const source = [
		"常量 ROWS 为 整数型 = 20",
		"变量 NextBrick 为 Brick, Orientation 为 整数型",
		"过程 Use(brick 为 Brick)",
		"  变量 row 为 整数型, cells 为 整数型(,)",
		"  NextBrick = brick",
		"  row = ROWS",
		"  Timer.间隔 = ROWS",
		"结束 过程",
		"属性 Score 为 整数型",
		"  获取",
		"    Score = ROWS",
		"  结束 获取",
		"结束 属性",
		"事件 Timer.计时()",
		"  Score = Score",
		"结束 事件",
		"$属性",
		"  $资源 $对象",
		"  $定义 Test $为 对象",
		"    $定义 Timer $为 计时器",
		"    $结束 $定义",
		"  $结束 $定义",
		"$结束 $属性"
	].join("\n");
	const model = documentModel(source);
	const tokens = tokenizeSimpleText(
		model.userCode,
		buildDocumentTokenRules(model.userCode, undefined, model.context)
	);

	assert.deepEqual(
		tokens.map((token) => [token.line, token.text, token.type, token.modifiers]),
		[
			[0, "ROWS", "variable", ["readonly"]],
			[1, "NextBrick", "variable", []],
			[1, "Orientation", "variable", []],
			[2, "Use", "function", []],
			[2, "brick", "parameter", []],
			[3, "row", "variable", []],
			[3, "cells", "variable", []],
			[4, "NextBrick", "variable", []],
			[4, "brick", "parameter", []],
			[5, "row", "variable", []],
			[5, "ROWS", "variable", ["readonly"]],
			[6, "Timer", "variable", []],
			[6, "ROWS", "variable", ["readonly"]],
			[8, "Score", "property", []],
			[10, "Score", "property", []],
			[10, "ROWS", "variable", ["readonly"]],
			[13, "Timer", "variable", []],
			[13, "计时", "event", []],
			[14, "Score", "property", []],
			[14, "Score", "property", []]
		]
	);
});

test("根据 SDK 类型和继承关系着色组件类型及点号成员", () => {
	const sdk: Sdk = {
		capabilities: { projects: [], tools: [] },
		templates: {},
		directory: "C:\\SDK",
		filePath: "C:\\SDK\\entry.json",
		issues: [],
		manifests: [
			{
				categories: [
					{
						definitions: [
							{
								constants: [{ name: "颜色_黑", type: "整数型", value: "0" }],
								functions: [{ name: "销毁" }],
								kind: "interface",
								name: "组件",
								properties: [{ name: "背景颜色", type: "整数型" }],
								type: "simple.runtime.components.组件"
							},
							{
								inherits: ["simple.runtime.components.组件"],
								kind: "interface",
								name: "可视组件",
								type: "simple.runtime.components.可视组件"
							},
							{
								events: [{ name: "计时" }],
								inherits: ["simple.runtime.components.组件"],
								kind: "component",
								name: "计时器",
								properties: [
									{ name: "间隔", type: "整数型" },
									{ name: "启用", type: "逻辑型" }
								]
							},
							{
								inherits: ["simple.runtime.components.可视组件"],
								kind: "component",
								name: "图片框"
							},
							{
								inherits: [
									"simple.runtime.components.可视组件",
									"simple.runtime.components.组件容器"
								],
								kind: "component",
								name: "面板"
							},
							{
								inherits: [
									"simple.runtime.components.可视组件",
									"simple.runtime.components.组件容器"
								],
								kind: "component.window",
								name: "测试窗口"
							}
						],
						name: "组件"
					}
				],
				directory: "C:\\SDK\\simple",
				filePath: "C:\\SDK\\simple\\runtime.json",
				kind: "runtime",
				name: "运行库"
			}
		]
	};
	const source = [
		"变量 timer 为 计时器",
		"过程 Configure(image 为 图片框, panel 为 面板, window 为 测试窗口)",
		"  timer.间隔 = 400",
		"  timer.销毁()",
		"  image.背景颜色 = 组件.颜色_黑",
		"结束 过程",
		"事件 ProgressTimer.计时()",
		"  ProgressTimer.启用 = 真",
		"结束 事件",
		"$属性",
		"  $资源 $对象",
		"  $定义 Test $为 对象",
		"    $定义 ProgressTimer $为 计时器",
		"    $结束 $定义",
		"  $结束 $定义",
		"$结束 $属性"
	].join("\n");
	const model = documentModel(source);
	const tokens = tokenizeSimpleText(
		model.userCode,
		buildDocumentTokenRules(model.userCode, sdk, model.context)
	);

	assert.deepEqual(
		tokens.map((token) => [token.line, token.text, token.type, token.modifiers]),
		[
			[0, "timer", "variable", []],
			[0, "计时器", "type", []],
			[1, "Configure", "function", []],
			[1, "image", "parameter", []],
			[1, "图片框", "type", []],
			[1, "panel", "parameter", []],
			[1, "面板", "type", []],
			[1, "window", "parameter", []],
			[1, "测试窗口", "type", []],
			[2, "timer", "variable", []],
			[2, "间隔", "property", []],
			[3, "timer", "variable", []],
			[3, "销毁", "method", []],
			[4, "image", "parameter", []],
			[4, "背景颜色", "property", []],
			[4, "组件", "type", []],
			[4, "颜色_黑", "variable", ["readonly"]],
			[6, "ProgressTimer", "variable", []],
			[6, "计时", "event", []],
			[7, "ProgressTimer", "variable", []],
			[7, "启用", "property", []]
		]
	);
});

test("同名重载声明和调用均保持函数着色", () => {
	const source = [
		"过程 执行()",
		"结束 过程",
		"过程 执行(value 为 整数型)",
		"结束 过程",
		"过程 Run()",
		"\t执行()",
		"\t执行(1)",
		"结束 过程",
		"$属性",
		"\t$资源 $对象",
		"$结束 $属性"
	].join("\n");
	const model = documentModel(source);
	const tokens = tokenizeSimpleText(
		model.userCode,
		buildDocumentTokenRules(model.userCode, undefined, model.context)
	).filter((token) => token.text === "执行");

	assert.equal(tokens.length, 4);
	assert.ok(tokens.every((token) => token.type === "function"));
});

test("完整代码复用用户代码规则并补充属性区名称和对象类名着色", () => {
	const sdk: Sdk = {
		capabilities: { projects: [], tools: [] },
		templates: {},
		directory: "C:\\SDK",
		filePath: "C:\\SDK\\entry.json",
		issues: [],
		manifests: [
			{
				categories: [
					{
						definitions: [
							{
								kind: "$type",
								name: "$对象",
								properties: [
									{ name: "基础对象", type: "对象" },
									{ name: "实现接口", type: "接口列表" }
								]
							}
						],
						name: "属性区"
					}
				],
				directory: "C:\\SDK\\simple",
				filePath: "C:\\SDK\\simple\\SimpleCompiler.json",
				kind: "compiler",
				name: "编译器"
			},
			{
				categories: [
					{
						definitions: [
							{
								kind: "object",
								name: "线程",
								type: "simple.runtime.collections.线程"
							}
						],
						name: "对象"
					}
				],
				directory: "C:\\SDK\\simple",
				filePath: "C:\\SDK\\simple\\SimpleAndroidRuntime.json",
				kind: "runtime",
				name: "运行库"
			}
		]
	};
	const source = [
		"事件 Test.初始化()",
		"结束 事件",
		"",
		"' 基础对象 = simple.runtime.collections.线程",
		"文本 = \"实现接口\"",
		"$属性",
		"  $资源 $对象",
		"  基础对象 = simple.runtime.collections.线程",
		"  实现接口 = simple.project.测试接口",
		"$结束 $属性"
	].join("\n");
	const model = documentModel(source);
	const rules = [
		...buildCompilerTokenRules(sdk),
		...buildDocumentTokenRules(source, sdk, model.context)
	];
	const tokens = tokenizeSimpleText(source, rules);

	assert.deepEqual(
		tokens
			.filter((token) => ["基础对象", "实现接口", "simple.runtime.collections.线程"].includes(token.text))
			.map((token) => [token.line, token.text, token.type]),
		[
			[7, "基础对象", "property"],
			[7, "simple.runtime.collections.线程", "type"],
			[8, "实现接口", "property"]
		]
	);
});

test("Tetris 完整代码中的布局限定属性按 SDK 着色", async () => {
	const filePath = simpleTestProjectPath(
		"Tetris", "src", "simple", "samples", "tetris", "Tetris.simple"
	);
	const source = await fs.readFile(filePath, "utf8");
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const project = await loadSimpleProject(simpleTestProjectPath("Tetris", "project.properties"));
	const index = new ProjectSymbolIndex();
	await index.updateProjects([project]);
	const context = index.contextForFile(filePath, source);
	assert.ok(context);
	const tokens = tokenizeSimpleText(source, [
		...buildCompilerTokenRules(sdk),
		...buildDocumentTokenRules(source, sdk, context)
	]);
	const lines = source.split(/\r?\n/u);
	const expected: Array<{ readonly character: number; readonly line: number; readonly text: string }> = [];

	for (const [line, text] of lines.entries()) {
		for (const match of text.matchAll(/布局[ \t]*\.[ \t]*(方向|行数|列数)/gu)) {
			const property = match[1];
			if (match.index !== undefined && property !== undefined) {
				expected.push({
					character: match.index + match[0].lastIndexOf(property),
					line,
					text: property
				});
			}
		}
	}

	assert.ok(expected.length >= 3, "Tetris 应包含方向、行数和列数等真实布局属性");
	for (const value of expected) {
		assert.ok(tokens.some((token) => (
			token.line === value.line
			&& token.character === value.character
			&& token.text === value.text
			&& token.type === "property"
		)), `布局.${value.text} 应着色为 property`);
	}
	assert.ok(tokens.some((token) => (
		token.text === "布局_方向_垂直"
		&& token.type === "variable"
		&& token.modifiers.includes("readonly")
	)), "布局常量应继续按只读变量着色");
});

test("运行库全局名称与静态、实例成员按真实访问方式着色", () => {
	const sdk: Sdk = {
		capabilities: { projects: [], tools: [] },
		templates: {},
		directory: "C:\\SDK",
		filePath: "C:\\SDK\\entry.json",
		issues: [],
		manifests: [
			{
				categories: [
					{
						definitions: [
							{
								constants: [
									{ global: true, name: "全局常量", type: "整数型", value: "1" },
									{ name: "类型常量", type: "整数型", value: "2" }
								],
								functions: [
									{ global: true, name: "分割文本" },
									{ name: "实例函数" }
								],
								kind: "object",
								name: "数组操作"
							},
							{
								functions: [{ name: "加入" }],
								kind: "object",
								name: "集合"
							}
						],
						name: "对象"
					}
				],
				directory: "C:\\SDK\\simple",
				filePath: "C:\\SDK\\simple\\runtime.json",
				kind: "runtime",
				name: "运行库"
			}
		]
	};
	const source = [
		"变量 list 为 集合",
		"过程 Run()",
		"  list.加入()",
		"  list.类型常量",
		"  集合.加入()",
		"  数组操作.分割文本()",
		"  分割文本()",
		"  全局常量",
		"结束 过程"
	].join("\n");
	const tokens = tokenizeSimpleText(source, buildDocumentTokenRules(source, sdk));
	const selected = tokens
		.filter((token) => ["加入", "类型常量", "分割文本", "全局常量"].includes(token.text))
		.map((token) => [token.line, token.text, token.type, token.modifiers]);

	assert.deepEqual(selected, [
		[2, "加入", "method", []],
		[5, "分割文本", "method", []],
		[6, "分割文本", "function", []],
		[7, "全局常量", "variable", ["readonly"]]
	]);
});

test("创建初始化器为变量提供组件类型及成员着色", () => {
	const sdk: Sdk = {
		capabilities: { projects: [], tools: [] },
		templates: {},
		directory: "C:\\SDK",
		filePath: "C:\\SDK\\entry.json",
		issues: [],
		manifests: [{
			categories: [{
				definitions: [{
					inherits: ["simple.runtime.components.可视组件"],
					kind: "component",
					name: "按钮",
					properties: [{ name: "文本", type: "文本型" }]
				}],
				name: "组件"
			}],
			directory: "C:\\SDK\\simple",
			filePath: "C:\\SDK\\simple\\runtime.json",
			kind: "runtime",
			name: "运行库"
		}]
	};
	const source = [
		"过程 Run()",
		"  变量 a1 = 创建 按钮 位于 面板1",
		"  a1.文本 = \"确定\"",
		"结束 过程"
	].join("\n");
	const tokens = tokenizeSimpleText(source, buildDocumentTokenRules(source, sdk));

	assert.ok(tokens.some((token) => token.text === "按钮" && token.type === "type"));
	assert.equal(tokens.filter((token) => token.text === "a1" && token.type === "variable").length, 2);
	assert.ok(tokens.some((token) => token.text === "文本" && token.type === "property"));
});

test("类型别名和变体型创建赋值参与成员链语义着色", () => {
	const sdk: Sdk = {
		capabilities: { projects: [], tools: [] },
		templates: {},
		directory: "C:\\SDK",
		filePath: "C:\\SDK\\entry.json",
		issues: [],
		manifests: [{
			categories: [{
				definitions: [{
					kind: "object",
					name: "计时器",
					properties: [{ name: "间隔", type: "整数型" }]
				}],
				name: "对象"
			}],
			directory: "C:\\SDK",
			filePath: "C:\\SDK\\runtime.json",
			kind: "runtime",
			name: "运行库"
		}]
	};
	const fullSource = [
		"别名 Timer = 计时器",
		"过程 Run()",
		"\t变量 value 为 变体型",
		"\tvalue = 创建 Timer",
		"\tvalue.间隔 = 500",
		"\t间隔 = 1000",
		"结束 过程",
		"$属性",
		"\t$资源 $对象",
		"\t基础对象 = 计时器",
		"$结束 $属性"
	].join("\n");
	const model = documentModel(fullSource);
	const tokens = tokenizeSimpleText(
		model.userCode,
		buildDocumentTokenRules(model.userCode, sdk, model.context)
	);

	assert.ok(tokens.some((token) => token.text === "Timer" && token.type === "type"));
	assert.equal(tokens.filter((token) => token.text === "间隔" && token.type === "property").length, 2);
});

test("项目 res 索引只为已存在的 R 资源生成语义着色", () => {
	const source = [
		"过程 Run()",
		"\t图片 = R.drawable_es4a",
		"\t其它 = R.drawable_missing",
		"\t文本 = \"R.drawable_es4a\"",
		"\t' R.drawable_es4a",
		"结束 过程"
	].join("\n");
	const model = documentModel(`${source}\n$属性\n\t$资源 $对象\n$结束 $属性`);
	const context: SimpleProjectSemanticContext = {
		...model.context,
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
	const tokens = tokenizeSimpleText(
		source,
		buildDocumentTokenRules(source, undefined, context)
	);

	assert.deepEqual(
		tokens.filter((token) => token.text === "R" || token.text.startsWith("drawable_"))
			.map((token) => [token.line, token.text, token.type, token.modifiers]),
		[
			[1, "R", "type", []],
			[1, "drawable_es4a", "variable", ["readonly"]]
		]
	);
});
