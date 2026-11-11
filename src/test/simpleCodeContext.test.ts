/*
以当前 Parser 的语法位置验证共享提示阶段，不以某个候选列表反推语言规则。
xhwsd@qq.com 2026-11-5
*/

import * as assert from "node:assert/strict";
import { test } from "node:test";
import { simpleCodeContext, simpleExecutionContext, type SimpleCodeContext } from "../simpleCodeContext";
import { analyzeSimpleSourceSyntax } from "../simpleSourceSyntax";

/** 每个样本标出语法位置，换行和合法续行必须产生同一阶段。 */
const cases: readonly [name: string, marked: string, slot: SimpleCodeContext["slot"], keywords?: readonly string[]][] = [
	["顶层", "|", "statement"], ["静态声明", "静态 |", "keyword", ["变量", "函数", "过程"]],
	["变量名称", "变量 新|值 为 整数型", "name"], ["变量类型前", "变量 新值 |", "keyword", ["为"]],
	["变量类型", "变量 新值 为 |", "type"], ["变量类型后", "变量 新值 为 整数型 |", "keyword", ["="]],
	["变量初值", "变量 新值 为 整数型 = |", "value"], ["变量尺寸", "变量 新值 为 整数型(|)", "value"],
	["逗号声明", "变量 一 为 整数型, |", "name"], ["常量类型前", "常量 值 |", "keyword", ["为"]],
	["初值后继续声明", "变量 一 为 整数型 = 1, 二 为 |", "type"],
	["第二个初值", "变量 一 为 整数型 = 1, 二 为 整数型 = |", "value"],
	["嵌套初值后声明", "变量 一 为 整数型 = 求值(1, 2), 二 |", "keyword", ["为"]],
	["连续常量类型", "常量 一 为 整数型 = 1, 二 为 |", "type"],
	["连续常量初值", "常量 一 为 整数型 = 1, 二 为 整数型 = |", "value"],
	["固定数组声明结束", "变量 数组 为 整数型(3) |", "none"],
	["固定数组禁止初值", "变量 数组 为 整数型(3) = |", "none"],
	["动态数组允许初值", "变量 数组 为 整数型(,) = |", "value"],
	["省略维数禁止尺寸", "变量 数组 为 整数型(, |)", "none"],
	["给定尺寸继续维数", "变量 数组 为 整数型(3, |)", "value"],
	["常量初值", "常量 值 为 整数型 = |", "value"], ["别名名称", "别名 |", "name"],
	["别名目标", "别名 工具 = 包.类型.|", "alias"], ["函数名称", "函数 |", "name"],
	["形参名称", "函数 计算(|) 为 整数型", "name"], ["形参传址", "函数 计算(传址 |) 为 整数型", "name"],
	["形参类型前", "函数 计算(参数 |) 为 整数型", "keyword", ["为"]], ["形参类型", "函数 计算(参数 为 |) 为 整数型", "type"],
	["形参类型后", "函数 计算(参数 为 整数型 |) 为 整数型", "none"], ["形参数组", "函数 计算(参数 为 整数型(,)|) 为 整数型", "none"],
	["返回类型前", "函数 计算() |", "keyword", ["为"]], ["返回类型", "函数 计算() 为 |", "type"],
	["返回类型后", "函数 计算() 为 整数型 |", "none"], ["过程头结束", "过程 运行() |", "none"],
	["属性类型后", "属性 数值 为 整数型 |", "none"], ["事件拥有者", "事件 |", "eventOwner"],
	["事件成员", "事件 目标.|", "event"], ["事件形参", "事件 目标.完成(参数 为 |)", "type"],
	["事件声明主体", "事件 自定义()\n|\n结束 事件", "keyword", ["结束"]],
	["赋值缺值", "过程 Run()\n数 = |\n结束 过程", "value"],
	["赋值操作数后", "过程 Run()\n数 = 1 |\n结束 过程", "operator", ["异或", "匹配", "+"]],
	["条件操作数后", "过程 Run()\n如果 数 |\n结束 过程", "operator", ["则", "是", "非", "匹配"]],
	["条件运算符后", "过程 Run()\n如果 数 匹配 |\n结束 过程", "value"],
	["括号内缺值", "过程 Run()\n如果 (数 + |) 则\n结束 过程", "value"],
	["嵌套调用缺值", "过程 Run()\n数 = 求值(求值(1), |)\n结束 过程", "value"],
	["嵌套调用操作数后", "过程 Run()\n数 = 求值(1 |)\n结束 过程", "operator", ["+"]],
	["限定成员", "过程 Run()\n数 = 对象实例.|\n结束 过程", "member"],
	["调用后成员", "过程 Run()\n数 = 工厂().|\n结束 过程", "member"],
	["类型检验操作数", "过程 Run()\n如果 类型检验 |\n结束 过程", "value"],
	["类型检验的是", "过程 Run()\n如果 类型检验 (数 是 空) |\n结束 过程", "operator", ["是", "+"]],
	["类型检验类型", "过程 Run()\n数 = 类型检验 载荷 是 |\n结束 过程", "type"],
	["创建类型", "过程 Run()\n对象实例 = 创建 |\n结束 过程", "type"],
	["创建容器", "过程 Run()\n对象实例 = 创建 按钮 位于 |\n结束 过程", "value"],
	["循环变量", "过程 Run()\n循环 |\n结束 过程", "loopVariable", ["每个"]],
	["遍历变量", "过程 Run()\n循环 每个 |\n结束 过程", "loopVariable"],
	["遍历来源前", "过程 Run()\n循环 每个 项 |\n结束 过程", "keyword", ["从"]],
	["遍历来源", "过程 Run()\n循环 每个 项 从 |\n结束 过程", "value"],
	["循环起值", "过程 Run()\n循环 数 = |\n结束 过程", "value"],
	["循环至", "过程 Run()\n循环 数 = 1 |\n结束 过程", "operator", ["至", "异或"]],
	["循环步进", "过程 Run()\n循环 数 = 1 至 10 |\n结束 过程", "operator", ["步进", "+"]],
	["前置循环条件", "过程 Run()\n判断循环 |\n结束 过程", "value"],
	["后置循环条件", "过程 Run()\n执行\n直到 |\n结束 过程", "value"],
	["判断分支比较", "过程 Run()\n判断 数\n分支 是 |\n结束 过程", "keyword", ["<", "<=", "=", ">", ">=", "<>"]],
	["判断范围", "过程 Run()\n判断 数\n分支 1 |\n结束 过程", "operator", ["至", "+"]],
	["比较分支后续项", "过程 Run()\n判断 数\n分支 是 > 1, |\n结束 过程", "value", ["是"]],
	["分支后续比较", "过程 Run()\n判断 数\n分支 1, 是 |\n结束 过程", "keyword", ["<", "="]],
	["混合分支范围", "过程 Run()\n判断 数\n分支 是 > 1, 2 至 |\n结束 过程", "value"],
	["错误类型", "过程 Run()\n位于 错误\n分支 |\n结束 过程", "errorType", ["否则"]],
	["错误类型列表", "过程 Run()\n位于 错误\n分支 文件错误, |\n结束 过程", "errorType"],
	["退出目标", "过程 Run()\n退出 |\n结束 过程", "keyword", ["过程"]],
	["退出完成", "过程 Run()\n退出 过程 |\n结束 过程", "none"],
	["单行分支缺值", "过程 Run()\n如果 真 则 数 = |\n结束 过程", "value"],
	["单行退出", "过程 Run()\n如果 真 则 退出 |\n结束 过程", "keyword", ["过程"]],
	["单行退出之后", "过程 Run()\n如果 真 则 退出 过程 |\n结束 过程", "keyword", ["否则"]],
	["单行赋值之后", "过程 Run()\n如果 真 则 数 = 1 |\n结束 过程", "operator", ["否则", "+"]],
	["触发事件名称", "过程 Run()\n触发事件 |\n结束 过程", "event"],
	["触发事件实参", "过程 Run()\n触发事件 完成(|)\n结束 过程", "value"]
];

for (const [name, marked, slot, keywords] of cases) {
	test(`编译器语法位置：${name}`, () => {
		for (const newline of ["\n", "\r\n"]) {
			const source = marked.replaceAll("\n", newline).replace("|", "");
			const offset = marked.replaceAll("\n", newline).indexOf("|");
			const context = simpleCodeContext(offset, analyzeSimpleSourceSyntax(source), "Test");
			assert.equal(context.slot, slot, name);
			for (const word of keywords ?? []) assert.ok(context.keywords?.includes(word), `${name} 应允许 ${word}`);
		}
	});
}

test("静态字段、实例字段和默认加载事件使用编译器的执行语境", () => {
	for (const [marked, expected] of [
		["静态 变量 值 为 整数型 = |", true], ["变量 值 为 整数型 = |", false],
		["事件 Test.加载()\n|\n结束 事件", true], ["事件 Test.初始化()\n|\n结束 事件", false],
		["事件 组件.加载()\n|\n结束 事件", false], ["静态 过程 Run()\n|\n结束 过程", true]
	] as const) {
		const source = marked.replace("|", ""), syntax = analyzeSimpleSourceSyntax(source);
		assert.equal(simpleExecutionContext(syntax, marked.indexOf("|"), "Test").static, expected, marked);
	}
});

test("接口签名后只允许结束声明，不进入函数体或顶层声明", () => {
	const marked = "函数 求值() 为 整数型\n|\n结束 函数";
	const source = marked.replace("|", "");
	assert.deepEqual(simpleCodeContext(marked.indexOf("|"), analyzeSimpleSourceSyntax(source, true), "Test").keywords, ["结束"]);
});
