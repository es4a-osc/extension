/*
验证短名、相对限定名及完整限定名共享作用域解析和移动同步，提示保持规范身份。
xhwsd@qq.com 2026-10-10
*/

import { testSdkPath } from "./testFixtures";

import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { test } from "node:test";
import { provideSimpleCompletions, resolveSimpleQualifier } from "../completionModel";
import { findSimpleDefinition } from "../definitionModel";
import { findSimpleKeywordHover } from "../keywordHover";
import { buildSemanticDefinitionIndex, resolveSimpleDefinitionName, resolveSimpleNamespaceName } from "../simpleUnitSymbols";
import { inspectSimplePropertyXml } from "../propertyXml";
import { analyzeSimpleReferences } from "../referenceDiagnostics";
import { refactoringContext, planSimpleUnitPaths, planSimpleSymbolRename, type RefactoringUnit } from "../refactoringModel";
import { loadSdk } from "../sdk";
import { loadSimpleProject } from "../programResources";
import { ProjectSymbolIndex } from "../projectSymbolIndex";
import { simpleTestProjectPath, simpleTestUnitPath } from "./testProjects";
import { splitSimpleUnitSource } from "../simpleUnitSource";

const root = path.resolve("C:/namespace-resolution/src");
const sdkPromise = loadSdk(testSdkPath("sdk.json"));
function unit(name: string, code = ""): RefactoringUnit {
	return { filePath: path.join(root, name.replaceAll(".", "/") + ".simple"), sourceRoot: root, userCode: code,
		property: inspectSimplePropertyXml("$属性\r\n$资源 $对象\r\n$结束 $属性\r\n") };
}

test("按最近作用域解析短名、相对命名空间及完整路径，不暴露不相关的唯一短名", () => {
	const current = unit("simple.runtime.smoketests.others.调用者");
	const parent = unit("simple.runtime.smoketests.主窗口");
	const child = unit("simple.runtime.smoketests.components.计时器");
	const unrelated = unit("simple.test.跨空间窗口");
	const context = refactoringContext(current, [current, parent, child, unrelated]);
	const definitions = buildSemanticDefinitionIndex(undefined, context);
	for (const spelling of ["主窗口", "smoketests.主窗口", "runtime.smoketests.主窗口", "simple.runtime.smoketests.主窗口"]) {
		assert.equal(resolveSimpleDefinitionName(spelling, definitions)?.definition.sourceFile, parent.filePath);
	}
	assert.equal(resolveSimpleDefinitionName("smoketests.components.计时器", definitions)?.definition.sourceFile, child.filePath);
	assert.equal(resolveSimpleNamespaceName("smoketests.components", definitions), "simple.runtime.smoketests.components");
	assert.equal(resolveSimpleDefinitionName("跨空间窗口", definitions), undefined);
	assert.equal(resolveSimpleDefinitionName("components.计时器", definitions)?.definition.sourceFile, child.filePath);
});

test("近处同名命名空间遮蔽父级时不回退，完整路径仍能明确目标", () => {
	const current = unit("app.inner.调用者");
	const outer = unit("app.widgets.目标");
	const inner = unit("app.inner.widgets.其它");
	const definitions = buildSemanticDefinitionIndex(undefined, refactoringContext(current, [current, outer, inner]));
	assert.equal(resolveSimpleNamespaceName("widgets", definitions), "app.inner.widgets");
	assert.equal(resolveSimpleDefinitionName("widgets.目标", definitions), undefined);
	assert.equal(resolveSimpleDefinitionName("app.widgets.目标", definitions)?.definition.sourceFile, outer.filePath);
});

test("补全、悬停、定义及诊断识别相对路径，悬停名称和声明来源保持完整限定名", async () => {
	const sdk = await sdkPromise;
	const target = unit("simple.runtime.smoketests.components.计时器", "静态 变量 窗口实例 为 窗口\r\n");
	const source = "过程 P()\r\n\t变量 值 为 smoketests.components.计时器\r\n\t切换窗口(smoketests.components.计时器.窗口实例)\r\n结束 过程\r\n";
	const current = unit("simple.runtime.smoketests.调用者", source);
	const context = refactoringContext(current, [current, target]);
	const start = source.indexOf("计时器");
	assert.equal(findSimpleDefinition(source, start, sdk, context)?.filePath, target.filePath);
	const hover = findSimpleKeywordHover(source, start, sdk, context);
	assert.equal(hover?.name, "simple.runtime.smoketests.components.计时器");
	assert.equal(hover?.signature, "对象 simple.runtime.smoketests.components.计时器");
	assert.equal(hover?.declarationSource, "simple.runtime.smoketests.components.计时器");
	assert.equal(findSimpleKeywordHover(source, source.indexOf("值"), sdk, context)?.signature, "变量 值 为 simple.runtime.smoketests.components.计时器");
	assert.equal(findSimpleKeywordHover(source, source.indexOf("窗口实例"), sdk, context)?.declarationSource, "simple.runtime.smoketests.components.计时器");
	assert.equal(analyzeSimpleReferences(source, sdk, context).some((issue) => issue.message.includes("smoketests")), false);
	for (const code of ["变量 值 为 smoketests.components.计", "过程 P()\r\n\tsmoketests.components.计时器.窗"]) {
		assert.ok(provideSimpleCompletions(code, code.length, sdk, context)?.candidates.some((candidate) => candidate.name.endsWith(code.endsWith(".窗") ? "窗口实例" : "计时器")));
	}
	assert.equal(resolveSimpleQualifier(source, source.indexOf("窗口实例"), "smoketests.components.计时器", sdk, context)?.reference.definition.name, "simple.runtime.smoketests.components.计时器");
});

test("局部名称遮蔽命名空间后不回退到同名类型或包补全", async () => {
	const sdk = await sdkPromise;
	const target = unit("app.widgets.目标", "静态 变量 值 为 整数型\r\n");
	const code = "过程 P()\r\n\t变量 widgets 为 变体型\r\n\twidgets.目标.值 = 1\r\n结束 过程\r\n";
	const current = unit("app.调用者", code);
	const context = refactoringContext(current, [current, target]);
	assert.equal(findSimpleDefinition(code, code.indexOf("目标"), sdk, context), undefined);
	assert.equal(findSimpleKeywordHover(code, code.indexOf("目标"), sdk, context), undefined);
	const prefix = code.slice(0, code.indexOf("目标"));
	assert.equal(provideSimpleCompletions(prefix, prefix.length, sdk, context)?.candidates.some((candidate) => candidate.name === "目标"), false);
	assert.equal(planSimpleUnitPaths([current, target], [{ oldFile: target.filePath, newFile: path.join(root, "app/widgets/新目标.simple"), sourceRoot: root }]).some((change) => change.unit === current), false);
});

test("移动后仍有效的父级短名与相对路径保持，失效路径最小同步", () => {
	const parent = unit("app.辅助");
	const current = unit("app.old.调用者", "变量 a 为 辅助\r\n变量 b 为 old.目标\r\n");
	const target = unit("app.old.目标");
	const move = { oldFile: current.filePath, newFile: path.join(root, "app/new/调用者.simple"), sourceRoot: root };
	assert.deepEqual(planSimpleUnitPaths([current, parent, target], [move]), []);
	const changes = planSimpleUnitPaths([current, parent, target], [{ oldFile: target.filePath, newFile: path.join(root, "app/new/目标.simple"), sourceRoot: root }]);
	assert.equal(changes.find((change) => change.unit === current)?.userCode, "变量 a 为 辅助\r\n变量 b 为 new.目标\r\n");
	const relocated = planSimpleUnitPaths([current, parent, target], [{ ...move, newFile: path.join(root, "elsewhere/调用者.simple") }]);
	assert.match(relocated[0]!.userCode, /变量 b 为 app\.old\.目标/u);
	assert.match(relocated[0]!.userCode, /别名 辅助 = app\.辅助/u);
});

test("父级与相对限定成员改名使用同一身份，别名使用保持且 RHS 同步", () => {
	const target = unit("app.主窗口", "静态 变量 字段 为 整数型\r\n");
	const current = unit("app.children.调用者", "别名 入口 = app.主窗口\r\n过程 P()\r\n\t主窗口.字段 = 1\r\n\tapp.主窗口.字段 = 2\r\n\t入口.字段 = 3\r\n结束 过程\r\n");
	const changes = planSimpleSymbolRename([current, target], target, target.userCode.indexOf("字段"), "新字段", undefined);
	assert.equal(changes.find((change) => change.unit === current)?.userCode, current.userCode.replaceAll("字段", "新字段"));
	const moved = planSimpleUnitPaths([current, target], [{ oldFile: target.filePath, newFile: path.join(root, "other/主窗口.simple"), sourceRoot: root }]);
	assert.match(moved.find((change) => change.unit === current)!.userCode, /别名 入口 = other\.主窗口/u);
	assert.match(moved.find((change) => change.unit === current)!.userCode, /入口\.字段 = 3/u);
});

test("父级单元遮蔽同名别名时提示跳转与改名仍按实际单元处理", () => {
	const target = unit("app.目标");
	const aliased = unit("other.目标");
	const code = "别名 目标 = other.目标\r\n变量 a 为 目标\r\n";
	const current = unit("app.child.调用者", code);
	const definitions = buildSemanticDefinitionIndex(undefined, refactoringContext(current, [current, target, aliased]));
	assert.equal(resolveSimpleDefinitionName("目标", definitions)?.definition.sourceFile, target.filePath);
	const context = refactoringContext(current, [current, target, aliased]);
	assert.equal(findSimpleDefinition(code, code.lastIndexOf("目标"), undefined, context)?.filePath, target.filePath);
	assert.equal(findSimpleKeywordHover(code, code.lastIndexOf("目标"), undefined, context)?.name, "app.目标");
	const changes = planSimpleUnitPaths([current, target, aliased], [{ oldFile: target.filePath, newFile: path.join(root, "app/新目标.simple"), sourceRoot: root }]);
	const changed = changes.find((change) => change.unit === current)!;
	assert.equal(changed.userCode, "别名 目标 = other.目标\r\n变量 a 为 新目标\r\n");
	const nextTarget = { ...target, filePath: path.join(root, "app/新目标.simple") };
	const nextCurrent = { ...current, userCode: changed.userCode };
	assert.equal(findSimpleDefinition(changed.userCode, changed.userCode.lastIndexOf("新目标"), undefined, refactoringContext(nextCurrent, [nextCurrent, nextTarget, aliased]))?.filePath, nextTarget.filePath);
});

test("成员类型按声明单元的包和别名解析，不被调用方的同名类型改变", async () => {
	const sdk = await sdkPromise;
	const helper = unit("app.defs.辅助", "变量 字段 为 整数型\r\n");
	const owner = unit("app.defs.容器", "别名 目标 = 辅助\r\n静态 变量 实例 为 目标\r\n");
	const unrelated = unit("app.other.目标", "变量 其它 为 整数型\r\n");
	const code = "过程 P()\r\n\tdefs.容器.实例.字段 = 1\r\n结束 过程\r\n";
	const current = unit("app.other.调用者", code);
	const context = refactoringContext(current, [current, helper, owner, unrelated]);
	assert.equal(resolveSimpleQualifier(code, code.indexOf("字段"), "defs.容器.实例", sdk, context)?.reference.definition.name, "app.defs.辅助");
	assert.equal(findSimpleDefinition(code, code.indexOf("字段"), sdk, context)?.filePath, helper.filePath);
	assert.equal(findSimpleKeywordHover(code, code.indexOf("字段"), sdk, context)?.declarationSource, "app.defs.辅助");
	assert.equal(findSimpleKeywordHover(code, code.indexOf("实例"), sdk, context)?.signature, "静态 变量 实例 为 app.defs.辅助");
	const prefix = code.slice(0, code.indexOf("字段"));
	assert.ok(provideSimpleCompletions(prefix, prefix.length, sdk, context)?.candidates.some((candidate) => candidate.name === "字段"));
	assert.deepEqual(analyzeSimpleReferences(code, sdk, context), []);
});

test("真实 SmokeTests 三种名称写法共享语言索引和重构上下文", async () => {
	const sdk = await sdkPromise;
	const project = await loadSimpleProject(simpleTestProjectPath("SmokeTests", "project.properties"));
	assert.ok(project);
	const index = new ProjectSymbolIndex();
	await index.updateProjects([project]);
	const mainFile = await simpleTestUnitPath("SmokeTests", "主窗口");
	const source = splitSimpleUnitSource(await fs.readFile(mainFile, "utf8")).userCode;
	const context = index.contextForFile(mainFile, source);
	assert.ok(context);
	for (const name of ["components.测试计时器", "smoketests.components.测试计时器", "simple.runtime.smoketests.components.测试计时器"]) {
		const code = "变量 v 为 " + name;
		assert.ok(findSimpleKeywordHover(code, code.indexOf("测试计时器"), sdk, context)?.declarationSource?.endsWith("components.测试计时器"));
		assert.ok(findSimpleDefinition(code, code.indexOf("测试计时器"), sdk, context)?.filePath?.endsWith("测试计时器.simple"));
		assert.deepEqual(analyzeSimpleReferences(code, sdk, context), []);
	}
});
