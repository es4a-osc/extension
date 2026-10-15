/*
验证声明连续输入、提交边界、作用域及真实样例的自动改名计划。
xhwsd@qq.com 2026-10-10
*/

import { testSdkPath } from "./testFixtures";

import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { test } from "node:test";
import { beginDeclarationRename, continueDeclarationRename, finishesDeclarationRename, planDeclarationRename } from "../declarationRename";
import { refactoringContext, type RefactoringUnit } from "../refactoringModel";
import { inspectSimplePropertyXml } from "../propertyXml";
import { loadSdk } from "../sdk";
import { simpleTestProjectPath, simpleTestUnitPath } from "./testProjects";
import { splitSimpleUnitSource } from "../simpleUnitSource";

const root = path.resolve("C:/auto-rename/src");
function unit(name: string, userCode: string): RefactoringUnit {
	return { filePath: path.join(root, name + ".simple"), sourceRoot: root, userCode, property: inspectSimplePropertyXml("$属性\r\n$资源 $对象\r\n$结束 $属性\r\n") };
}
const source = "过程 A(参数 为 整数型)\r\n\t变量 旧值 为 整数型\r\n\t旧值 = 参数\r\n结束 过程\r\n过程 B()\r\n\t变量 旧值 为 文本型\r\n\t旧值 = \"旧值\" ' 旧值\r\n结束 过程\r\n";

test("声明名称连续删除和中文输入保留最初名称及身份", () => {
	const before = unit("对象1", source);
	const start = source.indexOf("旧值");
	const pending = beginDeclarationRename(source, { rangeOffset: start, rangeLength: 2, text: "" }, undefined, refactoringContext(before, [before]));
	assert.ok(pending?.local);
	assert.equal(pending.newName, "");
	const erased = source.slice(0, start) + source.slice(start + 2);
	const next = continueDeclarationRename(erased, { rangeOffset: start, rangeLength: 0, text: "新值" }, pending);
	assert.equal(next?.oldName, "旧值");
	assert.equal(next?.newName, "新值");
	assert.equal(continueDeclarationRename(erased, { rangeOffset: 0, rangeLength: 0, text: "新值" }, pending), undefined);
});

test("声明直接改名遇到 SDK 函数捕获时拒绝引用计划，保留手动输入及原调用", async () => {
	const sdk = await loadSdk(testSdkPath("sdk.json"));
	const code = '过程 P()\r\n\t变量 旧值 为 整数型\r\n\t旧值 = 1\r\n\t显示提示框("原调用")\r\n结束 过程\r\n';
	const before = unit("对象1", code);
	const start = code.indexOf("旧值");
	const pending = beginDeclarationRename(code, { rangeOffset: start, rangeLength: "旧值".length, text: "显示提示框" }, sdk, refactoringContext(before, [before]));
	assert.ok(pending);
	const manual = { ...before, userCode: code.slice(0, start) + "显示提示框" + code.slice(start + "旧值".length) };
	assert.throws(() => planDeclarationRename([manual], manual, pending, sdk), /改变已有引用的目标/u);
	assert.equal(manual.userCode, code.replace("变量 旧值", "变量 显示提示框"));
	assert.equal(manual.property.document, before.property.document);
});

test("引用、函数名称、常量及组件不作为自动变量改名入口", () => {
	for (const code of [source, "函数 F() 为 整数型\r\n\tF = 1\r\n结束 函数\r\n", "常量 旧值 为 整数型 = 1\r\n"]) {
		const current = unit("对象1", code);
		const name = code.includes("旧值") ? "旧值" : "F";
		const start = code === source ? code.indexOf("旧值 =") : code.indexOf(name);
		assert.equal(beginDeclarationRename(code, { rangeOffset: start, rangeLength: name.length, text: "新值" }, undefined, refactoringContext(current, [current])), undefined);
	}
});

test("已手动改名的声明只同步其局部引用，保持其它作用域及注释字符串", () => {
	const before = unit("对象1", source);
	const start = source.indexOf("旧值");
	const pending = beginDeclarationRename(source, { rangeOffset: start, rangeLength: 2, text: "新的名称" }, undefined, refactoringContext(before, [before]))!;
	const current = { ...before, userCode: source.slice(0, start) + pending.newName + source.slice(start + 2) };
	const plans = planDeclarationRename([current], current, pending, undefined);
	assert.equal(plans[0]!.userCode, source.replace("变量 旧值", "变量 新的名称").replace("旧值 = 参数", "新的名称 = 参数"));
	assert.equal(plans[0]!.edits.length, 1);
	assert.equal(plans[0]!.unit, current);
	assert.equal(plans[0]!.propertyDocument, current.property.document);
});

test("参数声明自动改名不改变其它过程的同名参数", () => {
	const code = "过程 A(值 为 整数型)\r\n\t值 = 1\r\n结束 过程\r\n过程 B(值 为 整数型)\r\n\t值 = 2\r\n结束 过程\r\n";
	const before = unit("对象", code);
	const pending = beginDeclarationRename(code, { rangeOffset: code.indexOf("值"), rangeLength: 1, text: "新值" }, undefined, refactoringContext(before, [before]))!;
	assert.ok(pending.local);
	const current = { ...before, userCode: code.replace("A(值", "A(新值") };
	assert.equal(planDeclarationRename([current], current, pending, undefined)[0]!.userCode, code.replace("A(值", "A(新值").replace("值 = 1", "新值 = 1"));
});

test("成员声明自动改名同步跨单元字段，局部同名变量保持", () => {
	const code = "变量 字段 为 整数型\r\n过程 A()\r\n\t字段 = 1\r\n结束 过程\r\n";
	const before = unit("app/对象1", code);
	const other = unit("app/调用者", "过程 P()\r\n\t变量 a 为 对象1\r\n\ta.字段 = 2\r\n\t变量 字段 为 整数型\r\n\t字段 = 3\r\n结束 过程\r\n");
	const pending = beginDeclarationRename(code, { rangeOffset: code.indexOf("字段"), rangeLength: 2, text: "新字段" }, undefined, refactoringContext(before, [before, other]))!;
	assert.equal(pending.local, false);
	const current = { ...before, userCode: code.replace("变量 字段", "变量 新字段") };
	const plans = planDeclarationRename([current, other], current, pending, undefined);
	assert.match(plans.find((plan) => plan.unit === current)!.userCode, /新字段 = 1/u);
	assert.equal(plans.find((plan) => plan.unit === other)!.userCode, other.userCode.replace("a.字段", "a.新字段"));
});

test("分隔空白可以结束名称输入，不能把其它声明或删除视为改名", () => {
	const pending = { start: source.indexOf("旧值"), oldName: "旧值", newName: "旧值", local: true };
	const end = pending.start + pending.newName.length;
	assert.ok(finishesDeclarationRename(source, { rangeOffset: end, rangeLength: 0, text: " " }, pending));
	assert.ok(finishesDeclarationRename(source, { rangeOffset: source.indexOf("\r\n", end), rangeLength: 0, text: "\r\n" }, pending));
	assert.equal(finishesDeclarationRename(source, { rangeOffset: source.length, rangeLength: 0, text: "\r\n" }, pending), false);
	assert.equal(finishesDeclarationRename(source, { rangeOffset: end, rangeLength: 1, text: " " }, pending), false);
});

test("无效名称和同一作用域冲突拒绝写入，改回原名不生成编辑", async () => {
	const sdk = await loadSdk(testSdkPath("sdk.json"));
	const start = source.indexOf("旧值");
	for (const newName of ["", "123", "如果", "参数"]) {
		const current = unit("对象", source.slice(0, start) + newName + source.slice(start + 2));
		assert.throws(() => planDeclarationRename([current], current, { start, oldName: "旧值", newName, local: true }, sdk));
	}
	const current = unit("对象", source);
	assert.deepEqual(planDeclarationRename([current], current, { start, oldName: "旧值", newName: "旧值", local: true }, sdk), []);
});

test("真实 SmokeTests 服务窗口的局部变量改名不影响另一事件及属性模型", async () => {
	const sdk = await loadSdk(testSdkPath("sdk.json"));
	const file = await simpleTestUnitPath("SmokeTests", "测试服务");
	const original = await fs.readFile(file, "utf8");
	const userCode = splitSimpleUnitSource(original).userCode;
	const before: RefactoringUnit = { filePath: file, sourceRoot: simpleTestProjectPath("SmokeTests", "src"), userCode, property: inspectSimplePropertyXml(original) };
	const oldName = "局_服务意图";
	const blockStart = userCode.indexOf("事件 按钮2.");
	const blockEnd = userCode.indexOf("结束 事件", blockStart);
	const start = userCode.indexOf(oldName, blockStart);
	assert.ok(start >= 0);
	const pending = beginDeclarationRename(userCode, { rangeOffset: start, rangeLength: oldName.length, text: "局_启动意图" }, sdk, refactoringContext(before, [before]))!;
	assert.ok(pending?.local);
	const current = { ...before, userCode: userCode.slice(0, start) + pending.newName + userCode.slice(start + oldName.length) };
	const plans = planDeclarationRename([current], current, pending, sdk);
	assert.equal(plans[0]!.userCode, userCode.slice(0, blockStart) + userCode.slice(blockStart, blockEnd).replaceAll(oldName, pending.newName) + userCode.slice(blockEnd));
	assert.equal(plans[0]!.propertyDocument, before.property.document);
});
