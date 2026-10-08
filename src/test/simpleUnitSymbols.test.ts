/*
验证属性 XML 与用户代码合并后的单元符号及项目级跨单元索引。
xhwsd@qq.com 2026-8-27
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { provideSimpleCompletions } from "../completionModel";
import { buildDocumentTokenRules, tokenizeSimpleText } from "../compilerTokens";
import { findSimpleKeywordHover } from "../keywordHover";
import { loadSimpleProject } from "../programResources";
import { ProjectSymbolIndex } from "../projectSymbolIndex";
import { loadSdk } from "../sdk";
import { parseSimpleUnitSymbols } from "../simpleUnitSymbols";
import {
	simpleTestProjectPath,
	simpleTestUnitPath,
	type SimpleTestProjectName
} from "./testProjects";

const SDK = loadSdk(path.resolve("..", "sdk", "sdk.json"));

/** 返回测试样例目录中的绝对路径。 */
function fixture(project: SimpleTestProjectName, ...segments: string[]): string {
	return simpleTestProjectPath(project, ...segments);
}

test("单元符号从属性 XML 读取类型、继承、接口和组件", () => {
	const sourceRoot = fixture("Tetris", "src");
	const filePath = fixture("Tetris", "src", "simple", "samples", "tetris", "Tetris.simple");
	const unit = parseSimpleUnitSymbols(fs.readFileSync(filePath, "utf8"), filePath, sourceRoot);

	assert.equal(unit.qualifiedName, "simple.samples.tetris.Tetris");
	assert.equal(unit.unitType, "窗口");
	assert.equal(unit.definition.propertyStatus, "valid");
	assert.ok(unit.definition.inherits?.includes("窗口"));
	const board = unit.definition.variables?.find((member) => member.name === "Board");
	assert.equal(board?.component, true);
	assert.equal(board?.type, "面板");
});

test("真实测试重载单元保留同名过程和函数的全部参数个数", () => {
	const sourceRoot = fixture("SmokeTests", "src");
	const filePath = fixture(
		"SmokeTests",
		"src",
		"simple",
		"runtime",
		"smoketests",
		"others",
		"测试重载.simple"
	);
	const unit = parseSimpleUnitSymbols(fs.readFileSync(filePath, "utf8"), filePath, sourceRoot);
	const arities = (name: string) => unit.definition.functions
		?.filter((member) => member.name === name)
		.map((member) => member.params?.length ?? 0);

	assert.deepEqual(arities("过程1"), [0, 1, 2]);
	assert.deepEqual(arities("函数1"), [0, 1, 2]);
});

test("损坏属性区保留代码成员但不生成组件绑定", () => {
	const source = [
		"函数 Name() 为 文本型",
		"结束 函数",
		"$属性",
		"  $资源 $对象",
		"  $定义 Broken $为 计时器"
	].join("\r\n");
	const unit = parseSimpleUnitSymbols(source, "C:\\project\\src\\Broken.simple", "C:\\project\\src");

	assert.equal(unit.definition.propertyStatus, "damaged");
	assert.ok(unit.definition.functions?.some((member) => member.name === "Name"));
	assert.ok(!unit.definition.variables?.some((member) => member.name === "Broken"));
});

test("单元符号只记录文件级别名声明", () => {
	const source = [
		"别名 日期类型 = 日期时间操作",
		"过程 Run()",
		"  别名 非法别名 = 数组",
		"结束 过程",
		"$属性",
		"  $资源 $对象",
		"$结束 $属性"
	].join("\r\n");
	const unit = parseSimpleUnitSymbols(source, "C:\\project\\src\\Alias.simple", "C:\\project\\src");

	assert.deepEqual(unit.aliases, [{ line: 1, name: "日期类型", target: "日期时间操作" }]);
});

test("单元与所有声明统一识别三单引号连续多行文档注释", () => {
	const source = [
		"' 文件头第一行",
		"' 文件头第二行",
		"",
		"''' 单元说明第一行",
		"''' 单元说明第二行",
		"",
		"''' 别名说明第一行",
		"''' 别名只取第二行",
		"别名 Item = simple.example.Item",
		"''' 常量说明第一行",
		"''' 常量说明第二行",
		"常量 Limit 为 整数型 = 1",
		"''' 事件说明第一行",
		"''' 事件说明第二行",
		"事件 Test.初始化()",
		"结束 事件",
		"''' 过程说明第一行",
		"''' 过程说明第二行",
		"过程 Run()",
		"结束 过程",
		"''' 函数说明第一行",
		"''' 函数说明第二行",
		"函数 Name() 为 文本型",
		"结束 函数",
		"''' 属性说明第一行",
		"''' 属性说明第二行",
		"属性 Title 为 文本型",
		"结束 属性",
		"''' 变量说明第一行",
		"''' 变量只取第二行",
		"变量 Value 为 整数型",
		"$属性",
		"  $资源 $对象",
		"$结束 $属性"
	].join("\r\n");
	const unit = parseSimpleUnitSymbols(source, "C:\\project\\src\\Test.simple", "C:\\project\\src");

	assert.equal(unit.definition.description, "单元说明第一行\n单元说明第二行");
	assert.equal(unit.aliases[0]?.description, "别名说明第一行\n别名只取第二行");
	assert.equal(unit.definition.constants?.[0]?.description, "常量说明第一行\n常量说明第二行");
	assert.equal(unit.definition.events?.[0]?.description, "事件说明第一行\n事件说明第二行");
	assert.equal(
		unit.definition.functions?.find((member) => member.name === "Run")?.description,
		"过程说明第一行\n过程说明第二行"
	);
	assert.equal(
		unit.definition.functions?.find((member) => member.name === "Name")?.description,
		"函数说明第一行\n函数说明第二行"
	);
	assert.equal(unit.definition.properties?.[0]?.description, "属性说明第一行\n属性说明第二行");
	assert.equal(unit.definition.variables?.[0]?.description, "变量说明第一行\n变量只取第二行");

	const ordinaryComment = parseSimpleUnitSymbols(
		["' 不符合定义文档注释结构", "变量 a 为 整数型", "$属性", "  $资源 $对象", "$结束 $属性"].join("\r\n"),
		"C:\\project\\src\\NoDescription.simple",
		"C:\\project\\src"
	);
	assert.equal(ordinaryComment.definition.description, undefined);
	assert.equal(ordinaryComment.definition.variables?.[0]?.description, undefined);

	const multiLineUnit = parseSimpleUnitSymbols(
		["''' 单元说明第一行", "''' 单元说明第二行", "", "变量 a 为 整数型", "$属性", "  $资源 $对象", "$结束 $属性"].join("\r\n"),
		"C:\\project\\src\\MultiLineDescription.simple",
		"C:\\project\\src"
	);
	assert.equal(multiLineUnit.definition.description, "单元说明第一行\n单元说明第二行");
});

test("别名常量变量函数过程属性事件统一忽略普通分区注释", () => {
	const section = (title: string): readonly string[] => [
		"' ----------------",
		`' ${title}`,
		"' ----------------"
	];
	const source = [
		...section("Aliases"),
		"别名 Item = simple.example.Item",
		...section("Constants"),
		"常量 Limit 为 整数型 = 1",
		...section("Variables"),
		"变量 Value 为 整数型",
		...section("Procedures"),
		"过程 Run()",
		"结束 过程",
		...section("Functions"),
		"函数 Name() 为 文本型",
		"结束 函数",
		...section("Properties"),
		"属性 Title 为 文本型",
		"结束 属性",
		...section("Events"),
		"事件 Test.初始化()",
		"结束 事件",
		"$属性",
		"  $资源 $对象",
		"$结束 $属性"
	].join("\r\n");
	const unit = parseSimpleUnitSymbols(source, "C:\\project\\src\\Test.simple", "C:\\project\\src");

	assert.equal(unit.aliases[0]?.description, undefined);
	assert.equal(unit.definition.constants?.[0]?.description, undefined);
	assert.equal(unit.definition.variables?.[0]?.description, undefined);
	assert.equal(
		unit.definition.functions?.find((member) => member.name === "Run")?.description,
		undefined
	);
	assert.equal(
		unit.definition.functions?.find((member) => member.name === "Name")?.description,
		undefined
	);
	assert.equal(unit.definition.properties?.[0]?.description, undefined);
	assert.equal(unit.definition.events?.[0]?.description, undefined);
});

test("项目索引让用户单元和属性组件共同参与补全、悬停与着色", async () => {
	const project = await loadSimpleProject(fixture("SmokeTest", "project.properties"));
	const index = new ProjectSymbolIndex();
	await index.updateProjects([project]);
	const filePath = fixture("SmokeTest", "src", "simple", "smoketest", "SmokeTest.simple");
	const source = fs.readFileSync(filePath, "utf8");
	const context = index.contextForFile(filePath, source);
	const sdk = await SDK;

	assert.ok(context);
	const localVariableOffset = source.indexOf("变量 t 为 Test") + "变量 ".length;
	const localVariable = findSimpleKeywordHover(source, localVariableOffset, sdk, context);
	assert.equal(localVariable?.signature, "变量 t 为 Test");
	assert.equal(localVariable?.description, undefined);
	const definitions = context.manifest.categories[0]?.definitions ?? [];
	assert.ok(definitions.some((definition) => definition.name === "simple.smoketest.Test"));
	const testDefinition = definitions.find((definition) => definition.name === "simple.smoketest.Test");
	assert.equal(
		testDefinition?.functions?.find((member) => member.name === "Run")?.description,
		undefined
	);

	const memberSource = [
		"过程 Check()",
		"  变量 t 为 Test",
		"  t.na",
		"结束 过程",
		"$属性",
		"  $资源 $对象",
		"$结束 $属性"
	].join("\r\n");
	const memberContext = index.contextForFile(filePath, memberSource);
	const completionOffset = memberSource.indexOf("t.na") + "t.na".length;
	const completion = provideSimpleCompletions(memberSource, completionOffset, sdk, memberContext);
	assert.ok(completion?.candidates.some((candidate) => candidate.name === "Name"));

	const hoverOffset = memberSource.indexOf("Test") + 1;
	const hover = findSimpleKeywordHover(memberSource, hoverOffset, sdk, memberContext);
	assert.equal(hover?.name, "Test");
	assert.equal(hover?.category, "项目单元");
	assert.equal(hover?.signature, "接口 Test");
	assert.equal(hover?.description, undefined);
	assert.equal(hover?.manifest, "SmokeTest");
	assert.equal(hover?.declarationSource, "simple.smoketest.Test");

	const tokenSource = memberSource.replace("t.na", "t.Name()");
	const tokenContext = index.contextForFile(filePath, tokenSource);
	const tokens = tokenizeSimpleText(
		tokenSource,
		buildDocumentTokenRules(tokenSource, sdk, tokenContext)
	);
	assert.ok(tokens.some((token) => token.text === "Test" && token.type === "type"));
	assert.ok(tokens.some((token) => token.text === "Name" && token.type === "method"));
});

test("真实项目函数悬停只显示完整声明且不生成重复单元说明", async () => {
	const project = await loadSimpleProject(fixture("SmokeTest", "project.properties"));
	const index = new ProjectSymbolIndex();
	await index.updateProjects([project]);
	const filePath = fixture(
		"SmokeTest",
		"src",
		"simple",
		"smoketest",
		"statements",
		"ForNextStatementsTest.simple"
	);
	const source = fs.readFileSync(filePath, "utf8");
	const context = index.contextForFile(filePath, source);
	const offset = source.lastIndexOf("StepExpression()") + 1;
	const hover = findSimpleKeywordHover(source, offset, await SDK, context);

	assert.equal(hover?.signature, "函数 StepExpression() 为 整数型");
	assert.equal(hover?.description, undefined);
});

test("真实项目显式传址参数在声明和事件体中保持同一悬停", async () => {
	const project = await loadSimpleProject(fixture("StartTests", "project.properties"));
	const index = new ProjectSymbolIndex();
	await index.updateProjects([project]);
	const filePath = fixture(
		"StartTests",
		"src",
		"simple",
		"runtime",
		"tests",
		"TextBoxTests.simple"
	);
	const source = fs.readFileSync(filePath, "utf8");
	const context = index.contextForFile(filePath, source);
	const sdk = await SDK;
	assert.ok(context);

	const declarationOffset = source.indexOf("传址 accept") + "传址 ".length + 1;
	const declaration = findSimpleKeywordHover(source, declarationOffset, sdk, context);
	assert.equal(declaration?.signature, "传址 accept 为 逻辑型");

	const assignmentOffset = source.indexOf("accept = 真") + 1;
	const assignment = findSimpleKeywordHover(source, assignmentOffset, sdk, context);
	assert.equal(assignment?.signature, "传址 accept 为 逻辑型");
	assert.equal(assignment?.description, undefined);

	const defaultValueOffset = source.indexOf("text 为 文本型") + 1;
	const defaultValue = findSimpleKeywordHover(source, defaultValueOffset, sdk, context);
	assert.equal(defaultValue?.signature, "text 为 文本型");

	const unitOffset = source.indexOf("StartTests.PrevTest") + 1;
	const unitHover = findSimpleKeywordHover(source, unitOffset, sdk, context);
	assert.equal(unitHover?.signature, "窗口 StartTests");
	assert.equal(unitHover?.description, undefined);
	assert.equal(unitHover?.manifest, "StartTests");
	assert.equal(unitHover?.declarationSource, "simple.runtime.tests.StartTests");

	const memberOffset = source.indexOf("PrevTest") + 1;
	const memberHover = findSimpleKeywordHover(source, memberOffset, sdk, context);
	assert.equal(memberHover?.signature, "静态 过程 PrevTest()");
	assert.equal(memberHover?.description, undefined);
	assert.equal(memberHover?.manifest, "StartTests");
	assert.equal(memberHover?.declarationSource, "simple.runtime.tests.StartTests");

	const annotatedEventSource = source.replace(
		"事件 PrevButton.被单击()",
		"''' 用户定义的上一个按钮事件\r\n事件 PrevButton.被单击()"
	);
	const annotatedEventContext = index.contextForFile(filePath, annotatedEventSource);
	const eventOffset = annotatedEventSource.indexOf("被单击") + 1;
	const eventHover = findSimpleKeywordHover(
		annotatedEventSource,
		eventOffset,
		sdk,
		annotatedEventContext
	);
	assert.equal(eventHover?.signature, "事件 PrevButton.被单击()");
	assert.equal(eventHover?.description, "用户定义的上一个按钮事件");
	assert.equal(eventHover?.manifest, "StartTests");
	assert.equal(eventHover?.declarationSource, "simple.runtime.tests.TextBoxTests");
});

test("项目索引支持完全限定单元名和属性 XML 组件成员", async () => {
	const project = await loadSimpleProject(fixture("Tetris", "project.properties"));
	const index = new ProjectSymbolIndex();
	await index.updateProjects([project]);
	const filePath = fixture("Tetris", "src", "simple", "samples", "tetris", "Tetris.simple");
	const original = fs.readFileSync(filePath, "utf8");
	const sdk = await SDK;

	const finalPropertyMarker = original.lastIndexOf("$属性");
	const componentOffset = original.lastIndexOf("$属性", finalPropertyMarker - 1);
	assert.notEqual(componentOffset, -1);
	const componentSource = original.slice(0, componentOffset)
		+ "过程 Check()\r\n  ScoreLabel.bjys\r\n结束 过程\r\n"
		+ original.slice(componentOffset);
	const componentQuery = componentSource.indexOf("ScoreLabel.bjys") + "ScoreLabel.bjys".length;
	const componentContext = index.contextForFile(filePath, componentSource);
	const componentCompletion = provideSimpleCompletions(
		componentSource,
		componentQuery,
		sdk,
		componentContext
	);
	assert.ok(componentCompletion?.candidates.some((candidate) => candidate.name === "背景颜色"));

	const qualifiedSource = [
		"过程 Check()",
		"  变量 item 为 simple.samples.tetris.Ba",
		"结束 过程",
		"$属性",
		"  $资源 $对象",
		"$结束 $属性"
	].join("\r\n");
	const qualifiedOffset = qualifiedSource.indexOf(".Ba") + ".Ba".length;
	const qualifiedContext = index.contextForFile(filePath, qualifiedSource);
	const qualifiedCompletion = provideSimpleCompletions(
		qualifiedSource,
		qualifiedOffset,
		sdk,
		qualifiedContext
	);
	assert.ok(qualifiedCompletion?.candidates.some(
		(candidate) => candidate.name === "simple.samples.tetris.Bar"
	));
	assert.equal(
		qualifiedSource.slice(qualifiedCompletion?.start, qualifiedCompletion?.end),
		"simple.samples.tetris.Ba"
	);
});

test("别名目标只补全完整项目单元名和完整类库类名并保持项目优先", async () => {
	const project = await loadSimpleProject(fixture("SmokeTest", "project.properties"));
	const index = new ProjectSymbolIndex();
	await index.updateProjects([project]);
	const filePath = fixture(
		"SmokeTest",
		"src",
		"simple",
		"smoketest",
		"statements",
		"ForNextStatementsTest.simple"
	);
	const source = "别名 A = s";
	const context = index.contextForFile(filePath, source);
	const result = provideSimpleCompletions(source, source.length, await SDK, context);
	const names = result?.candidates.map((candidate) => candidate.name) ?? [];
	const projectIndex = names.indexOf("simple.smoketest.statements.SelectStatementsTest");
	const libraryIndex = names.indexOf("simple.runtime.数组操作");

	assert.ok(projectIndex >= 0);
	assert.ok(libraryIndex > projectIndex);
	assert.ok(!names.includes("双精度小数型"));
	assert.ok(!names.includes("数组操作"));
	assert.ok(result?.candidates.every((candidate) => candidate.name.includes(".")));
});

test("SmokeTests 跨单元静态变量继续推导窗口实例成员", async () => {
	const project = await loadSimpleProject(fixture("SmokeTests", "project.properties"));
	const index = new ProjectSymbolIndex();
	await index.updateProjects([project]);
	const filePath = await simpleTestUnitPath("SmokeTests", "测试水平滚动框");
	const original = fs.readFileSync(filePath, "utf8");
	const source = original.replace(
		"切换窗口(主窗口.成_主窗口)",
		"切换窗口(主窗口.成_主窗口.bt)"
	);
	const offset = source.indexOf("主窗口.成_主窗口.bt") + "主窗口.成_主窗口.bt".length;
	const context = index.contextForFile(filePath, source);
	const completion = provideSimpleCompletions(source, offset, await SDK, context);

	assert.ok(completion?.candidates.some((candidate) => candidate.name === "标题"));

	const staticVariableOffset = source.indexOf("成_主窗口") + 1;
	const staticVariableHover = findSimpleKeywordHover(source, staticVariableOffset, await SDK, context);
	assert.equal(staticVariableHover?.name, "成_主窗口");
	assert.equal(staticVariableHover?.kind, "staticVariable");
	assert.equal(staticVariableHover?.signature, "静态 变量 成_主窗口 为 窗口");

	const qualifiedSource = original.replace(
		"主窗口.成_主窗口",
		"simple.runtime.smoketests.主窗口.成_主窗口"
	);
	const qualifiedContext = index.contextForFile(filePath, qualifiedSource);
	const qualifiedOffset = qualifiedSource.indexOf(".成_主窗口") + 2;
	const qualifiedHover = findSimpleKeywordHover(qualifiedSource, qualifiedOffset, await SDK, qualifiedContext);
	assert.equal(qualifiedHover?.name, "成_主窗口");
	assert.equal(qualifiedHover?.kind, "staticVariable");
	assert.equal(qualifiedHover?.signature, "静态 变量 成_主窗口 为 窗口");

	const titleSource = source.replace("主窗口.成_主窗口.bt", "主窗口.成_主窗口.标题");
	const titleContext = index.contextForFile(filePath, titleSource);
	const titleOffset = titleSource.indexOf(".标题") + 2;
	const titleHover = findSimpleKeywordHover(titleSource, titleOffset, await SDK, titleContext);
	assert.equal(titleHover?.name, "标题");
	assert.equal(titleHover?.kind, "properties");
	assert.equal(titleHover?.owner, "窗口");
});

test("SmokeTests 静态变量声明悬停明确标识静态语义", async () => {
	const project = await loadSimpleProject(fixture("SmokeTests", "project.properties"));
	const index = new ProjectSymbolIndex();
	await index.updateProjects([project]);
	const filePath = fixture(
		"SmokeTests",
		"src",
		"simple",
		"runtime",
		"smoketests",
		"主窗口.simple"
	);
	const source = fs.readFileSync(filePath, "utf8");
	const context = index.contextForFile(filePath, source);
	const offset = source.indexOf("成_主窗口") + 1;
	const hover = findSimpleKeywordHover(source, offset, await SDK, context);

	assert.equal(hover?.kind, "staticVariable");
	assert.equal(hover?.signature, "静态 变量 成_主窗口 为 窗口");
});

test("SmokeTest 当前单元短名和全限定名访问静态变量时提供悬停", async () => {
	const project = await loadSimpleProject(fixture("SmokeTest", "project.properties"));
	const index = new ProjectSymbolIndex();
	await index.updateProjects([project]);
	const filePath = fixture(
		"SmokeTest",
		"src",
		"simple",
		"smoketest",
		"scopes",
		"ScopesTest.simple"
	);
	const source = fs.readFileSync(filePath, "utf8");
	const context = index.contextForFile(filePath, source);

	for (const expression of [
		"simple.smoketest.scopes.ScopesTest.var2",
		"ScopesTest.var3"
	]) {
		const name = expression.slice(expression.lastIndexOf(".") + 1);
		const offset = source.indexOf(expression) + expression.lastIndexOf(name) + 1;
		const hover = findSimpleKeywordHover(source, offset, await SDK, context);

		assert.equal(hover?.name, name);
		assert.equal(hover?.kind, "staticVariable");
		assert.match(hover?.signature ?? "", new RegExp(`^静态 变量 ${name} 为 `, "u"));
	}
});

test("Ell 从属性 XML 继承 Brick 并提供当前对象及继承成员提示", async () => {
	const project = await loadSimpleProject(fixture("Tetris", "project.properties"));
	const index = new ProjectSymbolIndex();
	await index.updateProjects([project]);
	const filePath = fixture("Tetris", "src", "simple", "samples", "tetris", "Ell.simple");
	const source = [
		"''' Ell 对象说明",
		"",
		"事件 Ell.初始化()",
		"  Get",
		"结束 事件",
		"$属性",
		"  $资源 $对象",
		"  基础对象 = simple.samples.tetris.Brick",
		"  实现接口 = simple.samples.tetris.Shape, simple.samples.tetris.Drawable",
		"$结束 $属性"
	].join("\r\n");
	const context = index.contextForFile(filePath, source);
	const sdk = await SDK;

	assert.ok(context);
	assert.deepEqual(
		context.currentUnit?.definition.inherits,
		[
			"simple.samples.tetris.Brick",
			"simple.samples.tetris.Shape",
			"simple.samples.tetris.Drawable"
		]
	);

	const ellHover = findSimpleKeywordHover(
		source,
		source.indexOf("事件 Ell") + "事件 ".length + 1,
		sdk,
		context
	);
	assert.equal(
		ellHover?.signature,
		"对象 Ell"
	);
	assert.equal(ellHover?.baseObject, "simple.samples.tetris.Brick");
	assert.deepEqual(
		ellHover?.interfaces,
		["simple.samples.tetris.Shape", "simple.samples.tetris.Drawable"]
	);
	assert.equal(ellHover?.description, "Ell 对象说明");
	assert.equal(ellHover?.manifest, "Tetris");
	assert.equal(ellHover?.declarationSource, "simple.samples.tetris.Ell");

	const eventOffset = source.indexOf("初始化") + 1;
	const eventHover = findSimpleKeywordHover(source, eventOffset, sdk, context);
	assert.equal(eventHover?.kind, "events");
	assert.equal(eventHover?.owner, "simple.samples.tetris.Ell");

	const completionOffset = source.indexOf("Get") + "Get".length;
	const completion = provideSimpleCompletions(source, completionOffset, sdk, context);
	assert.ok(completion?.candidates.some((candidate) => candidate.name === "GetShape"));

	const inheritedSource = source.replace("  Get", "  GetShape(0)");
	const inheritedContext = index.contextForFile(filePath, inheritedSource);
	const inheritedHover = findSimpleKeywordHover(
		inheritedSource,
		inheritedSource.indexOf("GetShape") + 1,
		sdk,
		inheritedContext
	);
	assert.equal(inheritedHover?.inheritedFrom, "simple.samples.tetris.Brick");
});
