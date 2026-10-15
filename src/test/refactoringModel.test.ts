/*
验证全项目关联重构、双向命名空间引用、作用域遮蔽和 XML 保持规则。
xhwsd@qq.com 2026-10-10
*/

import { testFixturePath, testSdkPath } from "./testFixtures";

import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { test } from "node:test";
import { inspectSimplePropertyXml, serializePropertyXml, serializeSimplePropertySource } from "../propertyXml";
import { findSimpleProjectReferences, refactoringContext, simpleDefinitionIdentity, simpleIdentifierSpans, planSimpleUnitPaths, planSimpleSymbolRename, planSimpleResourceReferences, type RefactoringUnit } from "../refactoringModel";
import { planSimpleComponentProjectRename } from "../componentRename";
import { findSimpleDefinition } from "../definitionModel";
import { loadSdk } from "../sdk";
import { listSimpleFiles } from "../simpleFileDiscovery";
import { getVisibleSimpleUnitUserCode, splitSimpleUnitSource } from "../simpleUnitSource";

const root = path.resolve("C:/refactoring/src");
function unit(name: string, code: string, properties = "", type = "对象"): RefactoringUnit {
	return {
		filePath: path.join(root, name + ".simple"), sourceRoot: root, userCode: code,
		property: inspectSimplePropertyXml(`$属性\r\n\t$资源 $${type}\r\n${properties}$结束 $属性\r\n`)
	};
}

test("移动同时更新入站完整引用、出站短名、main 所需路径，注释字符串和局部遮蔽保持", () => {
	const moved = unit("old/对象1", "变量 a 为 对象2\r\n事件 对象1.初始化()\r\n结束 事件\r\n");
	const other = unit("old/对象2", "变量 a 为 对象1\r\n变量 b 为 old.对象1\r\n' old.对象1\r\n过程 P()\r\n\t变量 old 为 变体型\r\n\told.对象1()\r\n\t显示提示(\"old.对象1\")\r\n结束 过程\r\n");
	const result = planSimpleUnitPaths([moved, other], [{ oldFile: moved.filePath, newFile: path.join(root, "new/对象1.simple"), sourceRoot: root }]);
	assert.match(result.find((value) => value.unit === moved)!.userCode, /别名 对象2 = old\.对象2/u);
	const code = result.find((value) => value.unit === other)!.userCode;
	assert.match(code, /别名 对象1 = new\.对象1/u);
	assert.match(code, /变量 b 为 new\.对象1/u);
	assert.match(code, /' old\.对象1/u);
	assert.match(code, /old\.对象1\(\)/u);
	assert.match(code, /"old\.对象1"/u);
});

test("已有别名仅改 RHS；对象与接口关系只改其它单元的精确限定名并保持未知 XML", () => {
	const base = unit("old/基础", "", "\t未知字段 = 42\r\n");
	const face = unit("old/接口1", "", "", "接口");
	const consumer = unit("app/消费者", "别名 A = old.基础\r\n变量 v 为 A\r\n", "\t基础对象 = old.基础\r\n\t实现接口 = old.接口1,  old.接口2\r\n\t未知字段 = \"old.基础\"\r\n");
	const result = planSimpleUnitPaths([base, face, consumer], [base, face].map((value) => ({ oldFile: value.filePath, newFile: value.filePath.replace(path.sep + "old" + path.sep, path.sep + "new" + path.sep), sourceRoot: root })));
	assert.equal(result.some((value) => value.unit === base), false);
	const changed = result.find((value) => value.unit === consumer)!;
	assert.equal(changed.userCode, "别名 A = new.基础\r\n变量 v 为 A\r\n");
	const xml = serializePropertyXml(changed.propertyDocument!);
	assert.match(xml, /值="new.基础"/u);
	assert.match(xml, /值="new.接口1,  old.接口2"/u);
	assert.match(xml, /&quot;old.基础&quot;/u);
});

test("单元改名直接同步父级短名、相对名及完整名，不创建旧名称别名", () => {
	const owner = unit("app/主窗口", "静态 变量 成_窗口实例 为 窗口\r\n", "", "窗口");
	const caller = unit("app/sub/调用者", "过程 P()\r\n\t切换窗口(主窗口.成_窗口实例)\r\n\t变量 a 为 app.主窗口\r\n\t显示提示框(\"主窗口\") ' 主窗口\r\n结束 过程\r\n");
	const result = planSimpleUnitPaths([owner, caller], [{ oldFile: owner.filePath, newFile: path.join(root, "app/主窗口1.simple"), sourceRoot: root }]);
	assert.equal(result.find((value) => value.unit === caller)!.userCode, caller.userCode.replace("切换窗口(主窗口.", "切换窗口(主窗口1.").replace("为 app.主窗口", "为 app.主窗口1"));
	assert.ok(!result.some((value) => value.userCode.includes("别名 ")));
});

test("单元改名的新短名被变量遮蔽时只把实际类型引用改为完整名", () => {
	const owner = unit("app/原对象", "");
	const caller = unit("app/调用者", "过程 P(新对象 为 变体型)\r\n\t变量 a 为 原对象\r\n\t新对象.运行时成员()\r\n结束 过程\r\n");
	const result = planSimpleUnitPaths([owner, caller], [{ oldFile: owner.filePath, newFile: path.join(root, "app/新对象.simple"), sourceRoot: root }]);
	assert.equal(result.find((value) => value.unit === caller)!.userCode, caller.userCode.replace("为 原对象", "为 app.新对象"));
});

test("已有同名别名在目录移动时更新目标，不重复插入", () => {
	const owner = unit("app/主窗口", "");
	const caller = unit("app/sub/调用者", "别名 主窗口 = app.主窗口\r\n\r\n变量 a 为 主窗口\r\n");
	const result = planSimpleUnitPaths([owner, caller], [{ oldFile: owner.filePath, newFile: path.join(root, "other/主窗口.simple"), sourceRoot: root }]);
	assert.equal(result.find((value) => value.unit === caller)!.userCode, caller.userCode.replace("= app.主窗口", "= other.主窗口"));
});

test("单元改名保留用户别名写法，只更新其目标", () => {
	const owner = unit("app/主窗口", "");
	const caller = unit("other/调用者", "别名 入口窗口 = app.主窗口\r\n变量 a 为 入口窗口\r\n");
	const result = planSimpleUnitPaths([owner, caller], [{ oldFile: owner.filePath, newFile: path.join(root, "app/主窗口1.simple"), sourceRoot: root }]);
	assert.equal(result.find((value) => value.unit === caller)!.userCode, caller.userCode.replace("= app.主窗口", "= app.主窗口1"));
});

test("对象关系仅完整匹配，接口逐项完整匹配且保持分隔排版", () => {
	const base = unit("old/基础", "");
	const face = unit("old/接口1", "", "", "接口");
	const expression = unit("app/表达式", "", "\t基础对象 = old.基础 + Other\r\n\t实现接口 = old.接口1 + Other, \"old.接口1\"\r\n");
	const consumer = unit("app/消费者", "", "\t基础对象 =   old.基础  \r\n\t实现接口 =  old.接口1 , old.接口2 ,  old.接口1  \r\n");
	const result = planSimpleUnitPaths([base, face, expression, consumer], [base, face].map((value) => ({ oldFile: value.filePath, newFile: value.filePath.replace(path.sep + "old" + path.sep, path.sep + "new" + path.sep), sourceRoot: root })));
	assert.ok(!result.some((value) => value.unit === expression));
	const changed = result.find((value) => value.unit === consumer)!;
	assert.match(serializePropertyXml(changed.propertyDocument!), /值="new.基础"/u);
	assert.match(serializePropertyXml(changed.propertyDocument!), /值="new.接口1 , old.接口2 ,  new.接口1"/u);
	assert.equal(serializeSimplePropertySource(changed.propertyDocument!), serializeSimplePropertySource(consumer.property.document!).replaceAll("old.基础", "new.基础").replaceAll("old.接口1", "new.接口1"));
});

test("目标命名空间同名冲突时只限定实际受影响的短名引用", () => {
	const moved = unit("old/调用者", "变量 a 为 辅助\r\n");
	const old = unit("old/辅助", "");
	const next = unit("new/辅助", "");
	const changes = planSimpleUnitPaths([moved, old, next], [{ oldFile: moved.filePath, newFile: path.join(root, "new/调用者.simple"), sourceRoot: root }]);
	assert.equal(changes[0]!.userCode, "变量 a 为 old.辅助\r\n");
});

test("变量改名按作用域处理参数、局部变量和其它过程中的同名变量", () => {
	const code = "过程 A(值 为 整数型)\r\n\t值 = 值 + 1\r\n结束 过程\r\n过程 B(值 为 整数型)\r\n\t值 = 2\r\n结束 过程\r\n";
	const current = unit("app/对象1", code);
	const changes = planSimpleSymbolRename([current], current, code.indexOf("值"), "新值", undefined);
	assert.equal(changes[0]!.userCode, code.replace("A(值", "A(新值").replace("值 = 值 +", "新值 = 新值 +"));
});

test("字段改名更新跨单元访问，局部同名变量和字符串不变", () => {
	const owner = unit("app/对象1", "变量 字段 为 整数型\r\n过程 A()\r\n\t字段 = 1\r\n结束 过程\r\n");
	const caller = unit("app/调用者", "过程 P()\r\n\t变量 a 为 对象1\r\n\ta.字段 = 2\r\n\t变量 字段 为 整数型\r\n\t字段 = 3\r\n结束 过程\r\n");
	const changes = planSimpleSymbolRename([owner, caller], owner, owner.userCode.indexOf("字段"), "新字段", undefined);
	assert.match(changes.find((value) => value.unit === caller)!.userCode, /a\.新字段 = 2/u);
	assert.match(changes.find((value) => value.unit === caller)!.userCode, /\t字段 = 3/u);
});

test("局部变量改名不能抢占已有 SDK 函数调用，其它过程与字符串不误判", async () => {
	const sdk = await loadSdk(testSdkPath("sdk.json"));
	const current = unit("对象", '过程 P()\r\n\t变量 旧值 为 整数型\r\n\t旧值 = 1\r\n\t显示提示框("原调用")\r\n结束 过程\r\n');
	assert.throws(() => planSimpleSymbolRename([current], current, current.userCode.indexOf("旧值"), "显示提示框", sdk), /改变已有引用的目标/u);
	const safe = unit("对象", '过程 P()\r\n\t变量 旧值 为 整数型\r\n\t旧值 = 1\r\n\t显示提示框("普通文本")\r\n结束 过程\r\n过程 Q()\r\n\t显示提示框("另一个过程")\r\n结束 过程\r\n');
	const plans = planSimpleSymbolRename([safe], safe, safe.userCode.indexOf("旧值"), "新值", sdk);
	assert.equal(plans[0]!.userCode, safe.userCode.replaceAll("旧值", "新值"));
	const differentScope = unit("对象", '过程 P()\r\n\t变量 旧值 为 整数型\r\n\t旧值 = 1\r\n结束 过程\r\n过程 Q()\r\n\t显示提示框("不受影响")\r\n结束 过程\r\n');
	assert.equal(planSimpleSymbolRename([differentScope], differentScope, differentScope.userCode.indexOf("旧值"), "显示提示框", sdk)[0]!.userCode, differentScope.userCode.replaceAll("旧值", "显示提示框"));
});

test("基类字段改名不能被派生类同名字段截获，包含传参实例及多段成员链", () => {
	const base = unit("app/基础", "变量 字段 为 整数型\r\n");
	const derived = unit("app/派生", "变量 新字段 为 整数型\r\n", "\t基础对象 = app.基础\r\n");
	const holder = unit("app/持有者", "变量 实例 为 派生\r\n");
	for (const code of ["过程 P(a 为 派生)\r\n\ta.字段 = 1\r\n结束 过程\r\n", "过程 P(a 为 持有者)\r\n\ta . 实例 . 字段 = 1\r\n结束 过程\r\n"]) {
		const caller = unit("app/调用者", code);
		assert.throws(() => planSimpleSymbolRename([base, derived, holder, caller], base, base.userCode.indexOf("字段"), "新字段", undefined), /改变已有引用的目标/u);
	}
	const safeCaller = unit("app/调用者", "过程 P(a 为 基础, b 为 派生)\r\n\ta.字段 = b.新字段\r\n结束 过程\r\n");
	const plans = planSimpleSymbolRename([base, derived, safeCaller], base, base.userCode.indexOf("字段"), "新字段", undefined);
	assert.equal(plans.find((plan) => plan.unit === safeCaller)!.userCode, safeCaller.userCode.replace("a.字段", "a.新字段"));
	assert.ok(!plans.some((plan) => plan.unit === derived));
});

test("资源匹配 R 成员并保留 R 局部遮蔽与字符串", () => {
	const current = unit("app/窗口", "变量 x 为 整数型\r\n过程 A()\r\n\tx = R.drawable_old\r\n结束 过程\r\n过程 B(R 为 变体型)\r\n\tx = R.drawable_old\r\n结束 过程\r\n");
	const changed = planSimpleResourceReferences([current], new Map([["drawable_old", "drawable_new"]]))[0]!;
	assert.equal(changed.userCode, current.userCode.replace("R.drawable_old", "R.drawable_new"));
});

test("资源改名不匹配中文标识符后缀或对象的 R 成员，代码及 XML 表达式一致", () => {
	const code = "过程 P(中文R 为 变体型, 对象 为 变体型)\r\n\t中文R.drawable_old = 1\r\n\t对象.R.drawable_old = 2\r\n\t对象 . R . drawable_old = 3\r\n\tR . drawable_old = 4\r\n\t显示提示框(\"R.drawable_old\") ' R.drawable_old\r\n结束 过程\r\n";
	const current = unit("app/窗口", code, "\t资源值 = R . drawable_old\r\n\t后缀值 = 中文R.drawable_old\r\n\t成员值 = 对象 . R.drawable_old\r\n\t字符串值 = \"R.drawable_old\"\r\n");
	const changed = planSimpleResourceReferences([current], new Map([["drawable_old", "drawable_new"]]))[0]!;
	assert.equal(changed.userCode, code.replace("\tR . drawable_old = 4", "\tR . drawable_new = 4"));
	assert.equal(serializeSimplePropertySource(changed.propertyDocument!), serializeSimplePropertySource(current.property.document!).replace("资源值 = R . drawable_old", "资源值 = R . drawable_new"));
});

test("资产属性的点号空白写法与普通写法同样重构，字符串和未知 XML 保持", async () => {
	const sdk = await loadSdk(testSdkPath("sdk.json"));
	const code = "过程 P()\r\n\t图片框1 . 图片 = \"@drawable/old\"\r\n\t显示提示框(\"@drawable/old\")\r\n结束 过程\r\n";
	const current = unit("app/窗口", code, "\t$定义 窗口 $为 窗口\r\n\t\t$定义 图片框1 $为 图片框\r\n\t\t\t图片 = \"@drawable/old\"\r\n\t\t\t未知字段 = \"@drawable/old\"\r\n\t\t$结束 $定义\r\n\t$结束 $定义\r\n", "窗口");
	const changed = planSimpleResourceReferences([current], new Map(), sdk, new Map([["@drawable/old", "@drawable/new"]]))[0]!;
	assert.equal(changed.userCode, code.replace('图片框1 . 图片 = "@drawable/old"', '图片框1 . 图片 = "@drawable/new"'));
	assert.equal(serializeSimplePropertySource(changed.propertyDocument!), serializeSimplePropertySource(current.property.document!).replace('图片 = "@drawable/old"', '图片 = "@drawable/new"'));
});

test("接口方法改名同步实现与调用，普通同名方法保持", () => {
	const face = unit("app/接口1", "过程 执行()\r\n结束 过程\r\n", "", "接口");
	const implementation = unit("app/实现", "过程 执行()\r\n结束 过程\r\n", "\t实现接口 = app.接口1\r\n");
	const unrelated = unit("app/无关", "过程 执行()\r\n结束 过程\r\n");
	const caller = unit("app/调用者", "过程 P()\r\n\t变量 a 为 接口1\r\n\t变量 b 为 实现\r\n\ta.执行()\r\n\tb.执行()\r\n结束 过程\r\n");
	const changes = planSimpleSymbolRename([face, implementation, unrelated, caller], face, face.userCode.indexOf("执行"), "运行", undefined);
	assert.equal(changes.some((value) => value.unit === unrelated), false);
	assert.match(changes.find((value) => value.unit === implementation)!.userCode, /过程 运行/u);
	assert.match(changes.find((value) => value.unit === caller)!.userCode, /a\.运行\(\)/u);
	assert.match(changes.find((value) => value.unit === caller)!.userCode, /b\.运行\(\)/u);
});

test("真实 Tetris 对象移动后保留完整属性区及自身短事件拥有者", async () => {
	const file = testFixturePath("simple", "samples/Tetris/src/simple/samples/tetris/Bar.simple");
	const source = await fs.readFile(file, "utf8");
	const current = { filePath: file, sourceRoot: testFixturePath("simple", "samples/Tetris/src"), userCode: splitSimpleUnitSource(source).userCode, property: inspectSimplePropertyXml(source) };
	const result = planSimpleUnitPaths([current], [{ oldFile: file, newFile: path.join(current.sourceRoot, "moved/Bar.simple"), sourceRoot: current.sourceRoot }]);
	assert.equal(result.length, 0);
});


test("根命名空间未受影响的短引用不产生别名或写入", () => {
	const target = unit("目标", "");
	const caller = unit("调用者", "变量 a 为 目标\r\n");
	const other = unit("old/其它", "");
	assert.equal(planSimpleUnitPaths([target, caller, other], [{ oldFile: other.filePath, newFile: path.join(root, "new/其它.simple"), sourceRoot: root }]).length, 0);
});

test("变量新名称与后续同作用域声明冲突时拒绝，其它作用域允许", () => {
	const current = unit("对象", "过程 A()\r\n\t变量 旧值 为 整数型\r\n\t旧值 = 1\r\n\t变量 新值 为 整数型\r\n结束 过程\r\n");
	assert.throws(() => planSimpleSymbolRename([current], current, current.userCode.indexOf("旧值"), "新值", undefined), /同一作用域/u);
});

test("相似事件拥有者不改变成员的声明身份", () => {
	const current = unit("执行者", "事件 执行者.执行()\r\n结束 事件\r\n");
	const result = planSimpleSymbolRename([current], current, current.userCode.indexOf(".执行") + 1, "运行", undefined);
	assert.equal(result[0]!.userCode, "事件 执行者.运行()\r\n结束 事件\r\n");
});


test("本对象限定字段与跨单元字段共享声明身份", () => {
	const current = unit("对象", "变量 字段 为 整数型\r\n过程 P()\r\n\t本对象.字段 = 1\r\n结束 过程\r\n");
	const changes = planSimpleSymbolRename([current], current, current.userCode.indexOf("字段"), "新字段", undefined);
	assert.match(changes[0]!.userCode, /本对象\.新字段/u);
});


test("接口成员改名拒绝实现单元中已有的目标成员", () => {
	const face = unit("app/接口1", "过程 执行()\r\n结束 过程\r\n", "", "接口");
	const implementation = unit("app/实现", "过程 执行()\r\n结束 过程\r\n过程 运行()\r\n结束 过程\r\n", "\t实现接口 = app.接口1\r\n");
	assert.throws(() => planSimpleSymbolRename([face, implementation], face, face.userCode.indexOf("执行"), "运行", undefined), /成员名称/u);
});


test("组件改名使用项目身份更新自身限定类型的成员访问", () => {
	const current = unit("app/窗口1", "过程 P(a 为 app.窗口1)\r\n\ta.按钮1.文本 = \"演示\"\r\n结束 过程\r\n", "\t$定义 窗口1 $为 窗口\r\n\t\t$定义 按钮1 $为 按钮\r\n\t\t$结束 $定义\r\n\t$结束 $定义\r\n", "窗口");
	const changes = planSimpleComponentProjectRename([current], current, "/属性/定义[1]/定义[1]", "演示按钮", undefined);
	assert.match(changes[0]!.userCode, /a\.演示按钮/u);
});

test("点号两侧空白的多段组件成员链保持定义与重构身份一致", async () => {
	const sdk = await loadSdk(testSdkPath("sdk.json"));
	const owner = unit("app/窗口1", "", "\t$定义 窗口1 $为 窗口\r\n\t\t$定义 按钮1 $为 按钮\r\n\t\t$结束 $定义\r\n\t$结束 $定义\r\n", "窗口");
	const caller = unit("app/调用者", '过程 P(a 为 app.窗口1)\r\n\ta . 按钮1 . 文本 = "演示"\r\n结束 过程\r\n');
	const context = refactoringContext(caller, [owner, caller]);
	const target = findSimpleDefinition(caller.userCode, caller.userCode.indexOf("文本"), sdk, context);
	assert.equal(target?.name, "文本");
	assert.equal(target?.memberGroup, "properties");
	const changes = planSimpleComponentProjectRename([owner, caller], owner, "/属性/定义[1]/定义[1]", "演示按钮", sdk);
	assert.equal(changes.find((change) => change.unit === caller)!.userCode, caller.userCode.replace("a . 按钮1 . 文本", "a . 演示按钮 . 文本"));
});

test("名称末尾与内部解析同一变量，分隔符及文件末尾均可重构，注释字符串保持排除", () => {
	for (const suffix of [" = 1", "\t= 1", "\r\n", "", ",", ")", ".未知成员"]) {
		const current = unit("对象", "变量 值 为 整数型\r\n值" + suffix);
		const start = current.userCode.lastIndexOf("值");
		const context = refactoringContext(current, [current]);
		assert.deepEqual(findSimpleDefinition(current.userCode, start + 1, undefined, context), findSimpleDefinition(current.userCode, start, undefined, context));
		assert.deepEqual(findSimpleProjectReferences([current], current, start + 1, undefined), findSimpleProjectReferences([current], current, start, undefined));
		assert.deepEqual(planSimpleSymbolRename([current], current, start + 1, "新值", undefined), planSimpleSymbolRename([current], current, start, "新值", undefined));
	}
	const current = unit("对象", '变量 值 为 整数型\r\n值  = 1\r\n\' 值\r\n显示提示框("值")\r\n');
	const context = refactoringContext(current, [current]);
	for (const offset of [current.userCode.indexOf("值  =") + 2, current.userCode.indexOf("' 值") + 3, current.userCode.indexOf('"值"') + 2]) {
		assert.equal(findSimpleDefinition(current.userCode, offset, undefined, context), undefined);
	}
});

test("真实 SmokeTests 选中完整局部变量后，从名称末尾重构全部引用", async () => {
	const sourceRoot = testFixturePath("simple", "tests/simple/runtime/DeviceTests/SmokeTests/src");
	const filePath = path.join(sourceRoot, "simple/runtime/smoketests/主窗口.simple");
	const source = await fs.readFile(filePath, "utf8");
	const current: RefactoringUnit = { filePath, sourceRoot, userCode: getVisibleSimpleUnitUserCode(source), property: inspectSimplePropertyXml(source) };
	const name = "局_切换窗口";
	const start = current.userCode.indexOf(name + " = 创建 smoketests.functions.测试广播");
	assert.ok(start >= 0);
	const references = findSimpleProjectReferences([current], current, start, undefined);
	assert.equal(references.length, 47);
	assert.deepEqual(findSimpleProjectReferences([current], current, start + name.length, undefined), references);
	const changes = planSimpleSymbolRename([current], current, start + name.length, name + "1", undefined);
	assert.equal(changes.length, 1);
	assert.equal(changes[0]!.edits.length, references.length);
	assert.equal(changes[0]!.propertyDocument, current.property.document);
	let expected = current.userCode;
	for (const { span } of [...references].reverse()) expected = expected.slice(0, span.start) + name + "1" + expected.slice(span.end);
	assert.equal(changes[0]!.userCode, expected);
	assert.match(changes[0]!.userCode, /' 注意哈希表返回空，可以通过“类型检验 局_切换窗口 是 窗口”/u);
	assert.equal(await fs.readFile(filePath, "utf8"), source);
});

test("真实 SmokeTests 组件引用批量分析与即时查询一致，改名只修改实际引用", async () => {
	const sourceRoot = testFixturePath("simple", "tests/simple/runtime/DeviceTests/SmokeTests/src");
	const sdk = await loadSdk(testSdkPath("sdk.json"));
	const units = await Promise.all((await listSimpleFiles(sourceRoot)).map(async (filePath): Promise<RefactoringUnit> => {
		const source = await fs.readFile(filePath, "utf8");
		return { filePath, sourceRoot, userCode: getVisibleSimpleUnitUserCode(source), property: inspectSimplePropertyXml(source) };
	}));
	const owner = units.find((value) => path.basename(value.filePath) === "测试其它.simple")!;
	assert.ok(owner);
	const offset = owner.userCode.indexOf("按钮1.被单击");
	assert.ok(offset >= 0);
	const target = findSimpleDefinition(owner.userCode, offset, sdk, refactoringContext(owner, units))!;
	assert.equal(target.propertySource, true);
	const identity = simpleDefinitionIdentity(target);
	const expected = units.flatMap((unit) => {
		const context = refactoringContext(unit, units);
		return simpleIdentifierSpans(unit.userCode).flatMap((span) => {
			const resolved = findSimpleDefinition(unit.userCode, span.start, sdk, context);
			return resolved !== undefined && simpleDefinitionIdentity(resolved) === identity ? [{ unit, span }] : [];
		});
	});
	assert.deepEqual(findSimpleProjectReferences(units, owner, offset, sdk), expected);
	const changes = planSimpleComponentProjectRename(units, owner, "/属性/定义[1]/定义[1]", "演示按钮", sdk);
	for (const unit of units) {
		let code = unit.userCode;
		for (const { span } of expected.filter((value) => value.unit === unit).reverse()) code = code.slice(0, span.start) + "演示按钮" + code.slice(span.end);
		assert.equal(changes.find((change) => change.unit === unit)?.userCode ?? unit.userCode, code);
	}
	assert.equal(changes.filter((change) => change.propertyDocument !== change.unit.property.document).length, 1);
	assert.equal(changes.find((change) => change.unit === owner)?.propertyDocument?.status, "valid");
});
