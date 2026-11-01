/*
验证集中审查中的跨功能语法、工程属性、XML 往返和复制引用边界。
xhwsd@qq.com 2026-10-31
*/

import * as assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { isSimpleIdentifier, scanSimpleSource } from "../simpleSourceLexical";
import { findSimpleDefinition } from "../definitionModel";
import { planSimpleSymbolRename, planSimpleResourceReferences, planSimpleUnitPaths, refactoringContext, findSimpleProjectReferences, type RefactoringUnit } from "../refactoringModel";
import { parseProjectProperties, updateProjectProperty, createProjectInfo } from "../project";
import { inspectSimplePropertyXml, serializeSimplePropertySource, serializePropertyXml, writePropertyXmlValue, parseSimplePropertyXml, resolvePropertyXmlElement, serializePropertyXmlElement } from "../propertyXml";
import { declarationNameAtChange, beginDeclarationRename } from "../declarationRename";
import { findCallContext, findCallableArgumentCount } from "../signatures";
import { findProjectForPath, findProjectForSource } from "../projectCapability";
import { createDesignerPreferenceState } from "../designerPreferencePersistence";
import type { WorkspaceProjectEntry } from "../programProjectPersistence";
import { loadSdk, type Sdk } from "../sdk";
import { testSdkPath } from "./testFixtures";
import { createSimpleDesignerModel, copySimpleDesignerComponent, pasteSimpleDesignerComponent, findDesignerComponentNode } from "../designerModel";
import { provideSimpleCompletions } from "../completionModel";
import { analyzeSimpleReferences, analyzeSimpleReferencesAsync } from "../referenceDiagnostics";

const sourceRoot = path.resolve("integrity/src");
function unit(userCode: string, name = "对象"): RefactoringUnit {
	return { userCode, filePath: path.join(sourceRoot, name + ".simple"), sourceRoot,
		property: inspectSimplePropertyXml("$属性\n$资源 $对象\n$结束 $属性\n") };
}

test("动态表达式成员不误报，已知接收者的缺失成员和未知根名称仍诊断", async () => {
	const sdk = await loadSdk(testSdkPath());
	const target = unit("变量 数值 为 整数型\n", "已知类型");
	const current = unit([
		"过程 测试(v 为 变体型, values 为 变体型(), 已知 为 已知类型)",
		"v.任意方法()", "(v).任意方法()", "values(0).任意方法()",
		"(v).任意属性.任意方法()", "(v) _\n.任意方法()",
		"(已知).数值 = 1", "(已知).缺失成员()", "(已知).缺失属性.后续成员()",
		"(不存在).任意方法()", "结束 过程", ""
	].join("\n"));
	const context = refactoringContext(current, [target, current]);
	const expected = [["unknownMember", "缺失成员"], ["unknownMember", "缺失属性"], ["unknownName", "不存在"]];
	const issues = analyzeSimpleReferences(current.userCode, sdk, context);
	assert.deepEqual(issues.map((issue) => [issue.code, current.userCode.slice(issue.start, issue.end)]), expected);
	assert.deepEqual(await analyzeSimpleReferencesAsync(current.userCode, sdk, context), issues);
});

test("完整标识符贯穿导航与改名，不修改同名前缀的另一个符号", () => {
	for (const suffix of ["€", "\u0301", "\u200c"]) {
		const source = `过程 测试()\n变量 价格 为 整数型\n变量 价格${suffix} 为 整数型\n价格${suffix} = 1\n价格 = 2\n结束 过程\n`;
		const current = unit(source);
		const offset = source.indexOf(`价格${suffix} =`);
		assert.equal(findSimpleDefinition(source, offset, undefined, refactoringContext(current, [current]))?.name, `价格${suffix}`);
		const renamed = planSimpleSymbolRename([current], current, offset, "金额", undefined)[0]!.userCode;
		assert.ok(renamed.includes("变量 价格 为 整数型\n变量 金额 为 整数型\n金额 = 1\n价格 = 2"));
	}
	assert.equal(isSimpleIdentifier("€价格"), true);
	assert.equal(isSimpleIdentifier("_价格"), false);
	assert.equal(isSimpleIdentifier("价格$"), false);
});

test("资源与单元重构使用完整令牌并支持点链续行", () => {
	const current = unit("过程 测试()\n变量 €R 为 整数型\n€R.drawable_old = 1\nR _\n. drawable_old = 2\n结束 过程");
	const resource = planSimpleResourceReferences([current], new Map([["drawable_old", "drawable_new"]]))[0]!;
	assert.ok(resource.userCode.includes("€R.drawable_old = 1"));
	assert.ok(resource.userCode.includes("R _\n. drawable_new = 2"));
	const target = unit("", "价格€");
	const caller = unit("变量 引用 为 价格€\n", "调用");
	const plans = planSimpleUnitPaths([target, caller], [{ oldFile: target.filePath, newFile: path.join(sourceRoot, "金额.simple"), sourceRoot }]);
	assert.equal(plans.find((plan) => plan.unit === caller)?.userCode, "变量 引用 为 金额\n");
	const nested = unit("", "pkg/价格€");
	const continued = unit("变量 引用 为 pkg _\n. 价格€\n", "续行调用");
	assert.equal(findSimpleDefinition(continued.userCode, continued.userCode.indexOf("价格€"), undefined, refactoringContext(continued, [nested, continued]))?.filePath, nested.filePath);
});

test("Java Properties 注释末尾反斜杠不吞字段，各种行尾更新不删除相邻属性", () => {
	for (const eol of ["\r", "\n", "\r\n"]) {
		const source = `# Windows C:\\${eol}source=./custom${eol}main=p.Old${eol}! 注释\\${eol}name=Keep${eol}`;
		assert.deepEqual({ ...parseProjectProperties(source) }, { source: "./custom", main: "p.Old", name: "Keep" });
		assert.equal(updateProjectProperty(source, "main", "p.New"), source.replace("p.Old", "p.New"));
		const first = `main=p.Old${eol}name=Keep${eol}source=./src${eol}`;
		assert.equal(updateProjectProperty(first, "main", "p.New"), first.replace("p.Old", "p.New"));
	}
});

test("XML 结束注释经编辑、保存和再次加载保持，包括空结束注释", () => {
	const source = "$属性\n$资源 $窗口\n$定义 Main $为 窗口\n$定义 Child $为 按钮\n$结束 $定义 '\n标题 = \"旧\"\n$结束 $定义 ' 组件结束\n$结束 $属性 ' 属性结束\n";
	const parsed = parseSimplePropertyXml(source)!;
	const edited = writePropertyXmlValue(parsed, "/属性/定义[1]/赋值[@属性='标题']/@值", '"新"');
	const saved = serializeSimplePropertySource(edited);
	assert.ok(saved.includes("$结束 $定义 ' 组件结束"));
	assert.ok(saved.includes("$结束 $属性 ' 属性结束"));
	assert.ok(saved.includes("$结束 $定义 '\r\n"));
	assert.equal(serializePropertyXml(parseSimplePropertyXml(saved)!), serializePropertyXml(edited));
});

test("直接声明改名支持冒号与续行参数，普通正文不被当成声明", () => {
	for (const source of ["过程 测试():变量 数值 为 整数型:数值 = 1:结束 过程", "过程 测试( _\r\n数值 为 整数型)\r\n数值 = 1\r\n结束 过程"]) {
		const offset = source.indexOf("数值");
		const change = { rangeOffset: offset, rangeLength: 2, text: "新值" };
		assert.equal(declarationNameAtChange(source, change)?.name, "数值");
		const current = unit(source);
		assert.equal(beginDeclarationRename(source, change, undefined, refactoringContext(current, [current]))?.newName, "新值");
		assert.equal(declarationNameAtChange(source, { ...change, rangeOffset: source.lastIndexOf("数值") }), undefined);
	}
});

test("调用头的续行、声明参数和嵌套括号共享逻辑语句规则", () => {
	const call = "计算 _\r\n(1, ";
	assert.deepEqual(findCallContext(call, call.length), { name: "计算", nameStart: 0, activeParameter: 1, qualifier: undefined });
	for (const source of ["函数 _\n计算(参数 为 整数型, ", "事件 窗口.初始化(", "过程 测试():函数 _\n计算("]) assert.equal(findCallContext(source, source.length), undefined);
	assert.equal(findCallableArgumentCount("计算 _\n(1, 2)", 2), 2);
	assert.equal(scanSimpleSource(call).filter((token) => token.kind === "separator").length, 0);
});

test("原生路径操作与设计器偏好按最具体源码根选择项目，支持项目外源码", async () => {
	const first = createProjectInfo(path.resolve("integrity/first/project.properties"), { source: "../shared" });
	const second = createProjectInfo(path.resolve("integrity/second/project.properties"), { source: "../shared/nested" });
	const file = path.resolve("integrity/shared/nested/窗口.simple");
	assert.equal(findProjectForSource([first, second], file), second);
	assert.equal(findProjectForPath([first, second], file), second);
	let entries: readonly WorkspaceProjectEntry[] = [{ projectFile: first.filePath }, { projectFile: second.filePath }];
	const registry = { projectEntries: () => entries, updateProjectSettings: async (projectFile: string, update: (settings: WorkspaceProjectEntry["settings"]) => WorkspaceProjectEntry["settings"]) => { entries = entries.map((entry) => entry.projectFile === projectFile ? { projectFile, settings: update(entry.settings) } : entry); } };
	const readProject = (projectFile: string) => [first, second].find((project) => project.filePath === projectFile)!;
	await createDesignerPreferenceState(registry, readProject).updateDisplayOption(file, "designerDebug", true);
	assert.equal(entries[0]!.settings, undefined);
	assert.deepEqual(createDesignerPreferenceState(registry, readProject).getDocument(file), { displayOptions: { designerDebug: true } });
});

test("复制容器改名后同步内部锚点，保留普通字符串和外部锚点", async () => {
	const sdk = await loadSdk(testSdkPath());
	const document = parseSimplePropertyXml("$属性\n$资源 $窗口\n$定义 Main $为 窗口\n$定义 Panel $为 面板\n布局 = 布局_相对\n$定义 First $为 按钮\n$结束 $定义\n$定义 Second $为 按钮\n位于右边 = First . 标识\n文本 = \"First.标识\"\n$结束 $定义\n$结束 $定义\n$结束 $定义\n$结束 $属性")!;
	const model = createSimpleDesignerModel(document, sdk);
	const copied = copySimpleDesignerComponent(document, sdk, model.root!.children[0]!.path);
	const pasted = pasteSimpleDesignerComponent(document, sdk, model.root!.path, copied.text);
	const projection = createSimpleDesignerModel(pasted.document, sdk);
	const panel = findDesignerComponentNode(projection.root!, pasted.componentPath)!;
	assert.deepEqual(panel.children.map((child) => child.name), ["First1", "Second1"]);
	assert.equal(panel.children[1]!.relativePositionIssue, undefined);
	assert.equal(panel.children[1]!.relativeRules?.rightOf, panel.children[0]!.path);
	const xml = serializePropertyXmlElement(resolvePropertyXmlElement(pasted.document, pasted.componentPath)!);
	assert.ok(xml.includes("First1 . 标识"));
	assert.ok(xml.includes("&quot;First.标识&quot;"));
	assert.throws(() => pasteSimpleDesignerComponent(document, sdk, model.root!.path, copied.text.replace('名称="Second"', '名称="First"')), /名称重复/u);
	const qualified = pasteSimpleDesignerComponent(document, sdk, model.root!.path, copied.text.replace("First . 标识", "本对象 . First . 标识"));
	const qualifiedPanel = findDesignerComponentNode(createSimpleDesignerModel(qualified.document, sdk).root!, qualified.componentPath)!;
	assert.equal(qualifiedPanel.children[1]!.relativePositionIssue, undefined);
	assert.equal(qualifiedPanel.children[1]!.relativeRules?.rightOf, qualifiedPanel.children[0]!.path);
	assert.ok(serializePropertyXmlElement(resolvePropertyXmlElement(qualified.document, qualified.componentPath)!).includes("本对象 . First1 . 标识"));
	const external = pasteSimpleDesignerComponent(document, sdk, model.root!.path, copied.text.replace("First . 标识", "其他窗口.First.标识"));
	assert.ok(serializePropertyXmlElement(resolvePropertyXmlElement(external.document, external.componentPath)!).includes("其他窗口.First.标识"));
});

test("数字令牌中的名称不能触发同名变量导航或改名", () => {
	const source = "过程 测试()\n变量 HABC 为 整数型\n变量 E3 为 整数型\n变量 值 为 整数型 = &HABC\n变量 小数 为 双精度小数型 = 1E3\nHABC = 1\n结束 过程\n";
	const current = unit(source);
	for (const offset of [source.indexOf("&HABC") + 2, source.indexOf("1E3") + 1]) {
		assert.equal(findSimpleDefinition(source, offset, undefined, refactoringContext(current, [current])), undefined);
		assert.throws(() => planSimpleSymbolRename([current], current, offset, "新名称", undefined));
	}
	const renamed = planSimpleSymbolRename([current], current, source.lastIndexOf("HABC"), "新名称", undefined)[0]!.userCode;
	assert.ok(renamed.includes("变量 新名称"));
	assert.ok(renamed.includes("= &HABC"));
});

test("资产重构只改完整常量路径，括号可保留，拼接片段和同名变量不变", () => {
	const sdk: Sdk = { directory: "C:/sdk", capabilities: { projects: [], tools: [] }, templates: {}, issues: [], manifests: [{ kind: "runtime", name: "测试", directory: "C:/sdk", filePath: "C:/sdk/runtime.json", categories: [{ name: "对象", definitions: [{ name: "图像", kind: "object", properties: [{ name: "图片", type: "文本型", editor: "simple.asset" }] }] }] }] };
	const source = '过程 测试()\n变量 控件 为 图像\n控件.图片 = "old.png" & ".bak"\n控件.图片 = (("old.png"))\n控件.图片 = "old.png":控件.图片 = "old.png" & 后缀\n变量 图片 为 文本型\n图片 = "old.png"\n结束 过程\n';
	const current = unit(source);
	const result = planSimpleResourceReferences([current], new Map(), sdk, new Map([["old.png", "new.png"]]))[0]!.userCode;
	assert.equal(result, source.replace('(("old.png"))', '(("new.png"))').replace('= "old.png":', '= "new.png":'));
	const conditional = unit('过程 测试()\n变量 控件 为 图像\n如果 真 则 控件.图片 = "old.png" 否则 控件.图片 = (("old.png"))\n如果 真 则 控件.图片 = "old.png" & ".bak" 否则 控件.图片 = "old.png"\n结束 过程');
	const updated = planSimpleResourceReferences([conditional], new Map(), sdk, new Map([["old.png", "new.png"]]))[0]!.userCode;
	assert.ok(updated.includes('如果 真 则 控件.图片 = "new.png" 否则 控件.图片 = (("new.png"))'));
	assert.ok(updated.includes('如果 真 则 控件.图片 = "old.png" & ".bak" 否则 控件.图片 = "new.png"'));
	const elseIf = { ...conditional, userCode: conditional.userCode.replaceAll("如果 真 则", "否则如果 真 则") };
	assert.equal(planSimpleResourceReferences([elseIf], new Map(), sdk, new Map([["old.png", "new.png"]]))[0]!.userCode, updated.replaceAll("如果 真 则", "否则如果 真 则"));
	const model = { ...unit(""), property: inspectSimplePropertyXml('$属性\n$资源 $窗口\n$定义 Main $为 窗口\n$定义 Image $为 图像\n图片 = (("old.png"))\n$结束 $定义\n$结束 $定义\n$结束 $属性') };
	const property = planSimpleResourceReferences([model], new Map(), sdk, new Map([["old.png", "new.png"]]))[0]!.propertyDocument!;
	assert.ok(serializePropertyXml(property).includes('((&quot;new.png&quot;))'));
});

test("数字内部和末尾不弹标识符补全，普通表达式中的同名变量仍可补全", () => {
	for (const literal of ["&H", "&HAB", "&HABG", "1E3", "1.0E3", "123"]) {
		const source = `过程 测试()\n变量 HABC计数 为 整数型\n变量 E3计数 为 整数型\n变量 值 为 整数型 = ${literal}\nHAB\n结束 过程`;
		const current = unit(source);
		const context = refactoringContext(current, [current]);
		const start = source.indexOf(literal, source.indexOf("变量 值"));
		for (const offset of [start + 1, start + literal.length]) assert.equal(provideSimpleCompletions(source, offset, undefined, context), undefined);
		assert.ok(provideSimpleCompletions(source, source.lastIndexOf("HAB") + 3, undefined, context)?.candidates.some((candidate) => candidate.name === "HABC计数"));
	}
});

test("限定类型调用中的类型段和方法段分别导航到正确声明", () => {
	const target = unit("静态 过程 方法()\n结束 过程\n", "pkg/类型");
	for (const chain of ["pkg.类型.方法", "pkg _\n. 类型 _\n. 方法"]) {
		const source = `过程 测试()\n${chain}()\n结束 过程\n`;
		const current = unit(source);
		const context = refactoringContext(current, [target, current]);
		assert.equal(findSimpleDefinition(source, source.indexOf("类型"), undefined, context)?.symbolKind, "unit");
		assert.equal(findSimpleDefinition(source, source.indexOf("类型"), undefined, context)?.filePath, target.filePath);
		assert.equal(findSimpleDefinition(source, source.indexOf("方法"), undefined, context)?.symbolKind, "member");
	}
});

test("触发事件的名称不受局部变量或参数遮蔽，变量改名只修改实际变量引用", () => {
	for (const parameter of [false, true]) {
		const source = "事件 通知(数值 为 整数型)\n结束 事件\n"
			+ (parameter ? "过程 测试(通知 为 整数型)\n" : "过程 测试()\n变量 通知 为 整数型\n")
			+ "通知 = 1\n触发事件 _\n通知(通知)\n结束 过程\n";
		const current = unit(source);
		const context = refactoringContext(current, [current]);
		const trigger = source.indexOf("通知(通知)");
		const declaration = parameter ? source.indexOf("测试(通知") + 3 : source.indexOf("变量 通知") + 3;
		assert.equal(findSimpleDefinition(source, trigger, undefined, context)?.memberGroup, "events");
		assert.equal(findSimpleDefinition(source, trigger + 3, undefined, context)?.symbolKind, "binding");
		const references = findSimpleProjectReferences([current], current, declaration, undefined);
		assert.ok(references.some((reference) => reference.span.start === trigger + 3));
		assert.ok(references.every((reference) => reference.span.start !== trigger));
		const renamed = planSimpleSymbolRename([current], current, declaration, "计数", undefined)[0]!.userCode;
		assert.ok(renamed.includes("通知(计数)"));
		assert.ok(renamed.startsWith("事件 通知("));
		assert.ok(renamed.includes("计数 = 1"));
		const sameNamedType = unit("", "通知");
		const moved = planSimpleUnitPaths([sameNamedType, current], [{ oldFile: sameNamedType.filePath, newFile: path.join(sourceRoot, "新类型.simple"), sourceRoot }]);
		assert.equal(moved.find((plan) => plan.unit === current), undefined);
	}
});

test("引用诊断共享完整标识符、逻辑语句及 XML 关系名称，保留未知名称的精确范围", async () => {
	const sdk: Sdk = { directory: "C:/sdk", capabilities: { projects: [], tools: [] }, templates: {}, issues: [], manifests: [] };
	for (const suffix of ["€", "\u0301", "\u200c"]) {
		const target = unit(`变量 字段${suffix} 为 整数型\n`, `pkg/类型${suffix}`);
		const current = unit(`别名 本地 = pkg _\n. 类型${suffix}\n变量 引用 为 本地\n过程 测试()\n引用 _\n. 字段${suffix} = 1\n结束 过程\n`);
		const context = refactoringContext(current, [target, current]);
		assert.deepEqual(analyzeSimpleReferences(current.userCode, sdk, context), []);
		assert.deepEqual(await analyzeSimpleReferencesAsync(current.userCode, sdk, context), []);
		const unknown = unit(`变量 引用 为 pkg _\n. 缺失${suffix}\n`);
		const issues = analyzeSimpleReferences(unknown.userCode, sdk, refactoringContext(unknown, [target, unknown]));
		assert.equal(issues.length, 1);
		assert.equal(issues[0]!.code, "unknownType");
		assert.equal(unknown.userCode.slice(issues[0]!.start, issues[0]!.end), `pkg _\n. 缺失${suffix}`);
		const contract = { ...unit("", `pkg/接口${suffix}`), property: inspectSimplePropertyXml("$属性\n$资源 $接口\n$结束 $属性") };
		const relation = { ...unit(""), property: inspectSimplePropertyXml(`$属性\n$资源 $对象\n基础对象 = pkg.类型${suffix}\n实现接口 = pkg.接口${suffix}, pkg.缺失${suffix}\n$结束 $属性`) };
		const relationIssues = analyzeSimpleReferences("", sdk, refactoringContext(relation, [target, contract, relation]), relation.property.document);
		assert.equal(relationIssues.length, 1);
		assert.equal(relationIssues[0]!.code, "unknownRelation");
		assert.ok(relationIssues[0]!.message.includes(`pkg.缺失${suffix}`));
	}
});
