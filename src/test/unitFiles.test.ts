/*
验证 Simple 单元初始内容和新建名称校验规则。
xhwsd@qq.com 2026-8-27
*/

import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
	createCopiedSimpleUnitSource,
	createSimpleUnitSourceFromTemplate,
	resolveSimpleUnitLifecycleEventAction,
	validateResourceFileName,
	validateUnitFolderName,
	validateUnitName
} from "../unitFiles";

function applyLifecycleEventAction(
	source: string,
	action: ReturnType<typeof resolveSimpleUnitLifecycleEventAction>
): string {
	if (action.existing) return source;
	assert.notEqual(action.insertionOffset, undefined);
	assert.notEqual(action.insertionText, undefined);
	return source.slice(0, action.insertionOffset)
		+ action.insertionText
		+ source.slice(action.insertionOffset);
}

test("SDK 单元模板先解析 XML 属性模型再生成完整源码", () => {
	const source = [
		"事件 测试窗口.初始化()",
		"",
		"结束 事件",
		"",
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 测试窗口 $为 窗口",
		"\t\t标题 = \"测试窗口\"",
		"\t$结束 $定义",
		"$结束 $属性",
		""
	].join("\r\n");

	assert.equal(createSimpleUnitSourceFromTemplate(source, "窗口"), source);
	assert.throws(
		() => createSimpleUnitSourceFromTemplate(source, "对象"),
		/单元类型不匹配/u
	);
});

test("复制窗口单元改名时同步窗口根和代码引用", () => {
	const source = [
		"事件 主窗口.初始化()",
		"\t主窗口.标题 = \"主窗口\" ' 主窗口注释",
		"结束 事件",
		"",
		"$属性",
		"  $资源 $窗口",
		"  $定义 主窗口 $为 窗口",
		"    标题 = \"主窗口\"",
		"  $结束 $定义",
		"$结束 $属性",
		""
	].join("\r\n");

	const copied = createCopiedSimpleUnitSource(source, "主窗口", "主窗口1");
	assert.match(copied, /事件 主窗口1\.初始化\(\)/u);
	assert.match(copied, /主窗口1\.标题 = "主窗口" ' 主窗口注释/u);
	assert.match(copied, /\$定义 主窗口1 \$为 窗口/u);
	assert.match(copied, /    标题 = "主窗口"/u);
});

test("复制对象单元改名时同步自身名称引用", () => {
	const source = [
		"事件 测试对象.初始化()",
		"\t测试对象.共享值 = 1",
		"结束 事件",
		"",
		"$属性",
		"\t$资源 $对象",
		"$结束 $属性",
		""
	].join("\r\n");

	const copied = createCopiedSimpleUnitSource(source, "测试对象", "测试对象1");
	assert.match(copied, /事件 测试对象1\.初始化\(\)/u);
	assert.match(copied, /测试对象1\.共享值 = 1/u);
});

test("先插入初始化再插入载入时仍保持加载在初始化之前", () => {
	let source = "变量 值 为 整数型";
	source = applyLifecycleEventAction(
		source,
		resolveSimpleUnitLifecycleEventAction(source, "测试对象", "初始化")
	);
	source = applyLifecycleEventAction(
		source,
		resolveSimpleUnitLifecycleEventAction(source, "测试对象", "加载")
	);
	assert.equal(source, [
		"事件 测试对象.加载()",
		"\t",
		"结束 事件",
		"",
		"事件 测试对象.初始化()",
		"\t",
		"结束 事件",
		"",
		"变量 值 为 整数型"
	].join("\r\n"));
});

test("先插入载入再插入初始化时初始化紧跟完整载入事件", () => {
	let source = "";
	const loadAction = resolveSimpleUnitLifecycleEventAction(source, "主窗口", "加载", "\n");
	source = applyLifecycleEventAction(source, loadAction);
	const initializeAction = resolveSimpleUnitLifecycleEventAction(source, "主窗口", "初始化", "\n");
	source = applyLifecycleEventAction(source, initializeAction);
	assert.equal(source, [
		"事件 主窗口.加载()",
		"\t",
		"结束 事件",
		"",
		"事件 主窗口.初始化()",
		"\t",
		"结束 事件"
	].join("\n"));
	assert.equal(initializeAction.caretOffset, source.indexOf("\t", source.indexOf("初始化")) + 1);
});

test("插到单元头部时复用已有前导换行，不重复增加空白行", () => {
	const source = [
		"",
		"事件 测试对象.初始化()",
		"",
		"结束 事件",
		"",
		"变量 值 为 整数型"
	].join("\r\n");
	const action = resolveSimpleUnitLifecycleEventAction(source, "测试对象", "加载");
	assert.equal(applyLifecycleEventAction(source, action), [
		"事件 测试对象.加载()",
		"\t",
		"结束 事件",
		"",
		"事件 测试对象.初始化()",
		"",
		"结束 事件",
		"",
		"变量 值 为 整数型"
	].join("\r\n"));
});

test("插到载入事件后时补足后续事件所需的空白行", () => {
	const source = [
		"事件 测试对象.加载()",
		"\t",
		"结束 事件",
		"事件 测试对象.按下某键()",
		"\t",
		"结束 事件"
	].join("\r\n");
	const action = resolveSimpleUnitLifecycleEventAction(source, "测试对象", "初始化");
	assert.equal(applyLifecycleEventAction(source, action), [
		"事件 测试对象.加载()",
		"\t",
		"结束 事件",
		"",
		"事件 测试对象.初始化()",
		"\t",
		"结束 事件",
		"",
		"事件 测试对象.按下某键()",
		"\t",
		"结束 事件"
	].join("\r\n"));
});

test("已有生命周期事件只定位事件体而不重复插入", () => {
	const source = "事件 主窗口.加载()\r\n\t显示提示(\"已加载\")\r\n结束 事件";
	const action = resolveSimpleUnitLifecycleEventAction(source, "主窗口", "加载");
	assert.deepEqual(action, {
		caretOffset: source.indexOf("显示提示"),
		existing: true
	});
});

test("单元名称接受中文标识符并拒绝后缀和路径", () => {
	assert.equal(validateUnitName("主窗口1"), undefined);
	assert.equal(validateUnitName("Timer_1"), undefined);
	assert.match(validateUnitName("1窗口") ?? "", /字母开头/);
	assert.match(validateUnitName("主窗口.simple") ?? "", /不要包含/);
	assert.match(validateUnitName("ui/主窗口") ?? "", /只能包含/);
});

test("文件夹名称拒绝路径字符和 Windows 保留名称", () => {
	assert.equal(validateUnitFolderName("业务单元"), undefined);
	assert.match(validateUnitFolderName("业务/单元") ?? "", /不允许/);
	assert.match(validateUnitFolderName("CON") ?? "", /保留名称/);
	assert.match(validateUnitFolderName("尾部.") ?? "", /结尾/);
});

test("资源文件名保留扩展名并拒绝路径字符和 Windows 保留名称", () => {
	assert.equal(validateResourceFileName("icon.png"), undefined);
	assert.equal(validateResourceFileName(".gitkeep"), undefined);
	assert.match(validateResourceFileName("draw/icon.png") ?? "", /不允许/);
	assert.match(validateResourceFileName("CON.txt") ?? "", /保留名称/);
	assert.match(validateResourceFileName("尾部.") ?? "", /结尾/);
});
