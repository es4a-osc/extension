/*
验证 Simple 首拼补全只返回当前代码区域、作用域和类型允许的候选。
xhwsd@qq.com 2026-8-27
*/

import * as assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { pinyinInitials, provideSimpleCompletions } from "../completionModel";
import { loadSdk, type Sdk } from "../sdk";
import { parseSimpleUnitSymbols, type SimpleProjectSemanticContext } from "../simpleUnitSymbols";
import { splitSimpleUnitSource } from "../simpleUnitSource";

const CURSOR = "¦";
const sdkPromise = loadSdk(path.resolve("..", "sdk", "sdk.json"));

/** 在标记位置执行补全，并返回候选。 */
async function completionCandidates(markedSource: string) {
	return completionCandidatesForFile(markedSource, "Test.simple");
}

/** 使用指定单元文件名在标记位置执行补全。 */
async function completionCandidatesForFile(markedSource: string, fileName: string) {
	const offset = markedSource.indexOf(CURSOR);
	assert.notEqual(offset, -1, "测试源码缺少光标标记");
	const source = markedSource.replace(CURSOR, "");
	const userCode = splitSimpleUnitSource(source).userCode;
	const sdk: Sdk = await sdkPromise;
	const unit = parseSimpleUnitSymbols(source, `C:\\project\\src\\${fileName}`, "C:\\project\\src");
	const context: SimpleProjectSemanticContext = {
		currentUnit: unit,
		manifest: {
			categories: [{ definitions: [unit.definition], hidden: true, name: "测试单元" }],
			description: "测试单元",
			directory: "C:\\project\\src",
			filePath: "C:\\project\\project.properties",
			kind: "project",
			name: "测试项目"
		}
	};
	return provideSimpleCompletions(userCode, offset, sdk, context)?.candidates ?? [];
}

/** 在标记位置执行补全，并返回候选中文名称。 */
async function complete(markedSource: string): Promise<readonly string[]> {
	return (await completionCandidates(markedSource)).map((candidate) => candidate.name);
}

/** 为代码区追加程序单元类型属性，光标仍位于属性区之前。 */
function unit(source: string, kind = "对象"): string {
	return `${source}\r\n$属性\r\n\t$资源 $${kind}\r\n$结束 $属性\r\n`;
}

test("将中文候选转换为连续拼音首字母", () => {
	assert.equal(pinyinInitials("如果"), "rg");
	assert.equal(pinyinInitials("数组"), "sz");
	assert.equal(pinyinInitials("分割文本"), "fgwb");
});

test("执行代码支持首拼，但顶层和接口方法体不提示流程语句", async () => {
	const executable = await complete(unit("过程 Run()\r\n\trg¦\r\n结束 过程"));
	assert.ok(executable.includes("如果"));

	const topLevel = await complete(unit("rg¦"));
	assert.ok(!topLevel.includes("如果"));
	assert.ok((await complete(unit("bm¦"))).includes("别名"));

	const interfaceBody = await complete(unit("过程 Run()\r\n\trg¦\r\n结束 过程", "接口"));
	assert.ok(!interfaceBody.includes("如果"));
	assert.ok((await complete(unit("bm¦", "接口"))).includes("别名"));

	const crlfInterfaceBody = await complete([
		"过程 Run()",
		"\trg¦",
		"结束 过程",
		"$属性",
		"\t$资源 $接口",
		"$结束 $属性"
	].join("\r\n"));
	assert.ok(!crlfInterfaceBody.includes("如果"));
});

test("函数声明闭合参数列表后通过首拼提示返回类型关键字", async () => {
	assert.deepEqual(await complete(unit("函数 xx1() w¦\r\n结束 函数")), ["为"]);
	assert.deepEqual(await complete(unit("静态 函数 xx1(value 为 整数型) w¦\r\n结束 函数")), ["为"]);
	assert.ok(!(await complete(unit("过程 xx1() w¦\r\n结束 过程"))).includes("为"));
});

test("函数式声明的参数名后通过首拼提示类型关键字", async () => {
	assert.deepEqual(await complete(unit("函数 xx1(value w¦) 为 整数型\r\n结束 函数")), ["为"]);
	assert.deepEqual(await complete(unit("过程 xx1(传值 value w¦)\r\n结束 过程")), ["为"]);
	assert.deepEqual(await complete(unit("事件 Test.xx1(first 为 整数型, 传址 second w¦)\r\n结束 事件")), ["为"]);
});

test("组件事件定义补全插入参数类型且普通调用保持参数值片段", async () => {
	const propertySource = [
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 Test $为 窗口",
		"\t\t$定义 消息传递器1 $为 消息传递器",
		"\t\t$结束 $定义",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n");
	const declaration = await completionCandidates([
		"事件 消息传递器1.sdxx¦",
		"结束 事件",
		propertySource
	].join("\r\n"));
	assert.deepEqual(declaration.map((candidate) => candidate.name), ["收到消息"]);
	assert.equal(
		declaration[0]?.snippet,
		"收到消息(${1:what} 为 整数型, ${2:payload} 为 变体型)"
	);

	const invocation = await completionCandidates([
		"过程 Run()",
		"\t消息传递器1.fsxx¦",
		"结束 过程",
		propertySource
	].join("\r\n"));
	assert.equal(
		invocation.find((candidate) => candidate.name === "发送消息")?.snippet,
		"发送消息(${1:what}, ${2:payload})"
	);
});

test("事件拥有者位置支持当前单元和有事件组件的首拼补全", async () => {
	const currentUnit = await completionCandidatesForFile([
		"事件 jc¦",
		"$属性",
		"	$资源 $对象",
		"	基础对象 = simple.runtime.collections.线程",
		"$结束 $属性"
	].join("\r\n"), "继承线程.simple");
	assert.deepEqual(currentUnit.map((candidate) => candidate.name), ["继承线程"]);
	assert.equal(currentUnit[0]?.detail, "当前单元 · 继承线程");

	const component = await completionCandidates([
		"事件 zjsq¦",
		"$属性",
		"	$资源 $窗口",
		"	$定义 Test $为 窗口",
		"		$定义 主计时器 $为 计时器",
		"		$结束 $定义",
		"	$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.deepEqual(component.map((candidate) => candidate.name), ["主计时器"]);
	assert.equal(component[0]?.detail, "组件实例 · 计时器");
});

test("不完整变量和静态声明只提示当前位置合法的声明关键字", async () => {
	assert.deepEqual(await complete(unit("变量 a w¦")), ["为"]);
	assert.deepEqual(await complete(unit("静态 bl¦")), ["变量"]);
});

test("如果和否则如果的条件末尾提示则且不重复提示", async () => {
	const ifCandidates = await complete(unit([
		"过程 Run()",
		"\t如果 1 > 2 z¦",
		"\t结束 如果",
		"结束 过程"
	].join("\r\n")));
	assert.equal(ifCandidates[0], "则");

	const elseIfCandidates = await complete(unit([
		"过程 Run()",
		"\t如果 假 则",
		"\t否则如果 1 > 2 z¦",
		"\t结束 如果",
		"结束 过程"
	].join("\r\n")));
	assert.equal(elseIfCandidates[0], "则");

	const completedCondition = await complete(unit([
		"过程 Run()",
		"\t如果 1 > 2 则 z¦",
		"\t结束 如果",
		"结束 过程"
	].join("\r\n")));
	assert.ok(!completedCondition.includes("则"));
});

test("类型检验按语法阶段提示是和逻辑连接符", async () => {
	const sourcePrefix = [
		"过程 Run()",
		"\t变量 消息载荷 为 变体型"
	];
	assert.deepEqual(await complete(unit([
		...sourcePrefix,
		"\t如果 类型检验 消息载荷 s¦",
		"\t结束 如果",
		"结束 过程"
	].join("\r\n"))), ["是"]);
	assert.ok((await complete(unit([
		...sourcePrefix,
		"\t如果 类型检验 消息载荷 是 rqs¦",
		"\t结束 如果",
		"结束 过程"
	].join("\r\n")))).includes("日期时间型"));
	assert.deepEqual(await complete(unit([
		...sourcePrefix,
		"\t如果 类型检验 消息载荷 是 日期时间型 则",
		"\t否则如果 类型检验 消息载荷 是 文本型 h¦",
		"\t结束 如果",
		"结束 过程"
	].join("\r\n"))), ["或"]);
	assert.deepEqual(await complete(unit([
		...sourcePrefix,
		"\t如果 类型检验 消息载荷 是 文本型 q¦",
		"\t结束 如果",
		"结束 过程"
	].join("\r\n"))), ["且"]);
});

test("属性声明只按访问器顺序提示获取和设置", async () => {
	const beforeAccessor = await complete(unit("属性 Value 为 整数型\r\n\thq¦\r\n结束 属性"));
	assert.deepEqual(beforeAccessor, ["获取"]);

	const afterGetter = await complete(unit([
		"属性 Value 为 整数型",
		"\t获取",
		"\t\tValue = 1",
		"\t结束 获取",
		"\tsz¦",
		"结束 属性"
	].join("\r\n")));
	assert.deepEqual(afterGetter, ["设置"]);

	const getterBody = await complete(unit([
		"属性 Value 为 整数型",
		"\t获取",
		"\t\trg¦",
		"\t结束 获取",
		"结束 属性"
	].join("\r\n")));
	assert.ok(getterBody.includes("如果"));
});

test("文件属性区、注释和字符串内不提供首拼补全", async () => {
	assert.deepEqual(await complete("$属性\r\n\t$资源 $对象\r\n\trg¦\r\n$结束 $属性"), []);
	assert.deepEqual(await complete(unit("过程 Run()\r\n\t' rg¦\r\n结束 过程")), []);
	assert.deepEqual(await complete(unit("过程 Run()\r\n\t变量 文本 为 文本型 = \"rg¦\"\r\n结束 过程")), []);
});

test("已知变量只提示其类型的实例成员，未知限定名不回退全库", async () => {
	const timer = await complete(unit([
		"过程 Run()",
		"\t变量 timer 为 计时器",
		"\ttimer.jg¦",
		"结束 过程"
	].join("\r\n")));
	assert.deepEqual(timer, ["间隔"]);

	const collection = await complete(unit([
		"过程 Run()",
		"\t变量 集合实例 为 集合",
		"\t集合实例.jr¦",
		"结束 过程"
	].join("\r\n")));
	assert.deepEqual(collection, ["加入"]);

	assert.deepEqual(await complete(unit("过程 Run()\r\n\t未知对象.jr¦\r\n结束 过程")), []);
});

test("SDK 类型支持首拼、静态成员首拼和全局函数首拼", async () => {
	const typeNames = await complete(unit("过程 Run()\r\n\t变量 值 为 sz¦\r\n结束 过程"));
	assert.ok(typeNames.includes("数组操作"));
	assert.ok((await complete(unit("过程 Run()\r\n\t变量 值 为 dx¦\r\n结束 过程"))).includes("对象"));
	assert.ok((await complete(unit("过程 Run()\r\n\t变量 值 为 an¦\r\n结束 过程"))).includes("按钮"));
	assert.ok((await complete(unit("过程 Run()\r\n\t变量 值 为 mb¦\r\n结束 过程"))).includes("面板"));
	assert.ok((await complete(unit("过程 Run()\r\n\t变量 值 为 ck¦\r\n结束 过程"))).includes("窗口"));

	const qualified = await complete(unit("过程 Run()\r\n\t数组操作.fgwb¦\r\n结束 过程"));
	assert.deepEqual(qualified, ["分割文本"]);

	const global = await complete(unit("过程 Run()\r\n\tfgwb¦\r\n结束 过程"));
	assert.ok(global.includes("分割文本"));
});

test("创建组件类型后按语法位置提示位于", async () => {
	assert.deepEqual(
		await complete(unit("过程 Run()\r\n\t变量 a1 = 创建 按钮 wy¦\r\n结束 过程")),
		["位于"]
	);
	assert.deepEqual(
		await complete(unit("过程 Run()\r\n\t变量 a1 = 创建 simple.runtime.components.按钮 wy¦\r\n结束 过程")),
		["位于"]
	);
	assert.ok(!(
		await complete(unit("过程 Run()\r\n\t变量 a1 = 按钮 wy¦\r\n结束 过程"))
	).includes("位于"));
});

test("变量从创建初始化器推断组件类型并提供实例成员", async () => {
	const members = await complete(unit([
		"过程 Run()",
		"\t变量 a1 = 创建 按钮 位于 面板1",
		"\ta1.wb¦",
		"结束 过程"
	].join("\r\n")));
	assert.ok(members.includes("文本"));
});

test("变体型只在当前创建赋值可确认类型后提供对应成员", async () => {
	const beforeAssignment = await complete(unit([
		"过程 Run()",
		"\t变量 value 为 变体型",
		"\tvalue.jg¦",
		"结束 过程"
	].join("\r\n")));
	assert.deepEqual(beforeAssignment, []);

	const afterAssignment = await complete(unit([
		"过程 Run()",
		"\t变量 value 为 变体型",
		"\tvalue = 创建 计时器",
		"\tvalue.jg¦",
		"结束 过程"
	].join("\r\n")));
	assert.deepEqual(afterAssignment, ["间隔"]);

	const afterUnknownAssignment = await complete(unit([
		"过程 Run(other 为 变体型)",
		"\t变量 value 为 变体型",
		"\tvalue = 创建 计时器",
		"\tvalue = other",
		"\tvalue.jg¦",
		"结束 过程"
	].join("\r\n")));
	assert.deepEqual(afterUnknownAssignment, []);
});

test("全局常量参与首拼，静态函数不提示本对象", async () => {
	const globalConstant = await complete(unit("过程 Run()\r\n\trq_n¦\r\n结束 过程"));
	assert.ok(globalConstant.includes("日期_年"));

	const instanceContext = await complete(unit("过程 Run()\r\n\tbdx¦\r\n结束 过程"));
	assert.ok(instanceContext.includes("本对象"));

	const staticContext = await complete(unit("静态 过程 Run()\r\n\tbdx¦\r\n结束 过程"));
	assert.ok(!staticContext.includes("本对象"));
});

test("当前作用域的用户符号统一支持首拼补全", async () => {
	const source = (query: string): string => unit([
		"别名 时间类型 = 日期时间操作",
		"常量 最大次数 为 整数型 = 3",
		"变量 当前计数 为 整数型",
		"属性 显示文本 为 文本型",
		"结束 属性",
		"函数 计算总数() 为 整数型",
		"结束 函数",
		"过程 刷新界面()",
		"结束 过程",
		"事件 初始化()",
		"结束 事件",
		"过程 Run(请求文本 为 文本型)",
		"	变量 临时结果 为 整数型",
		`\t${query}¦`,
		"结束 过程"
	].join("\r\n"));
	const expected = [
		["qqwb", "请求文本"],
		["lsjg", "临时结果"],
		["dqjs", "当前计数"],
		["zdcs", "最大次数"],
		["xswb", "显示文本"],
		["jszs", "计算总数"],
		["sxjm", "刷新界面"],
		["csh", "初始化"],
		["sjlx", "时间类型"]
	] as const;

	for (const [query, name] of expected) {
		assert.ok((await complete(source(query))).includes(name), `${query} 应提示 ${name}`);
	}
});

test("显式传值和传址参数在过程体内参与补全", async () => {
	const candidates = await complete(unit([
		"过程 Run(传值 text 为 文本型, 传址 accept 为 逻辑型)",
		"\tacc¦",
		"结束 过程"
	].join("\r\n")));
	assert.ok(candidates.includes("accept"));
});

test("局部符号只在声明后的当前函数式作用域参与首拼", async () => {
	const beforeDeclaration = await complete(unit([
		"过程 Run(请求文本 为 文本型)",
		"	qqwb¦",
		"	变量 晚值 为 整数型",
		"结束 过程"
	].join("\r\n")));
	assert.ok(beforeDeclaration.includes("请求文本"));
	assert.ok(!beforeDeclaration.includes("晚值"));

	const otherProcedure = await complete(unit([
		"过程 First()",
		"	变量 临时结果 为 整数型",
		"结束 过程",
		"过程 Second()",
		"	lsjg¦",
		"结束 过程"
	].join("\r\n")));
	assert.ok(!otherProcedure.includes("临时结果"));

	const functionResult = await complete(unit([
		"函数 计算结果() 为 整数型",
		"	jsjg¦",
		"结束 函数"
	].join("\r\n")));
	assert.ok(functionResult.includes("计算结果"));
});

test("类型别名支持类型位置首拼和静态成员补全", async () => {
	const typeAlias = await complete(unit([
		"别名 日期类型 = 日期时间操作",
		"过程 Run()",
		"	变量 value 为 rqlx¦",
		"结束 过程"
	].join("\r\n")));
	assert.ok(typeAlias.includes("日期类型"));

	const aliasMember = await complete(unit([
		"别名 日期类型 = 日期时间操作",
		"过程 Run()",
		"	日期类型.rq_n¦",
		"结束 过程"
	].join("\r\n")));
	assert.ok(aliasMember.includes("日期_年"));
});

test("项目别名实例合并跨单元自有成员和基础对象成员", () => {
	const sourceRoot = "C:\\project\\src";
	const base = parseSimpleUnitSymbols([
		"过程 基础过程()",
		"结束 过程",
		"$属性",
		"\t$资源 $对象",
		"$结束 $属性"
	].join("\r\n"), `${sourceRoot}\\pkg\\Base.simple`, sourceRoot);
	const derived = parseSimpleUnitSymbols([
		"过程 自有过程()",
		"结束 过程",
		"$属性",
		"\t$资源 $对象",
		"\t基础对象 = pkg.Base",
		"$结束 $属性"
	].join("\r\n"), `${sourceRoot}\\pkg\\Derived.simple`, sourceRoot);
	const marked = [
		"别名 A = pkg.Derived",
		"过程 Run()",
		"\t变量 value 为 A",
		"\tvalue.¦",
		"结束 过程",
		"$属性",
		"\t$资源 $对象",
		"$结束 $属性"
	].join("\r\n");
	const offset = marked.indexOf("¦");
	const source = marked.replace("¦", "");
	const caller = parseSimpleUnitSymbols(source, `${sourceRoot}\\Caller.simple`, sourceRoot);
	const userCode = splitSimpleUnitSource(source).userCode;
	const context: SimpleProjectSemanticContext = {
		currentUnit: caller,
		manifest: {
			categories: [{
				definitions: [base, derived, caller].map((entry) => ({
					...entry.definition,
					aliases: [entry.name]
				})),
				hidden: true,
				name: "项目单元"
			}],
			directory: "C:\\project",
			filePath: "C:\\project\\project.properties",
			kind: "project",
			name: "测试项目"
		}
	};
	const candidates = provideSimpleCompletions(userCode, offset, undefined, context)?.candidates ?? [];

	assert.deepEqual(candidates.map((candidate) => candidate.name), ["基础过程", "自有过程"]);
	assert.ok(candidates.every((candidate) => candidate.snippet?.endsWith("()") === true));
});

test("同名过程按参数个数分别提供补全项", () => {
	const sourceRoot = "C:\\project\\src";
	const marked = [
		"过程 执行()",
		"结束 过程",
		"过程 执行(value 为 整数型)",
		"结束 过程",
		"过程 Run()",
		"\t执¦",
		"结束 过程",
		"$属性",
		"\t$资源 $对象",
		"$结束 $属性"
	].join("\r\n");
	const offset = marked.indexOf(CURSOR);
	const source = marked.replace(CURSOR, "");
	const current = parseSimpleUnitSymbols(source, `${sourceRoot}\\Overload.simple`, sourceRoot);
	const context: SimpleProjectSemanticContext = {
		currentUnit: current,
		manifest: {
			categories: [{ definitions: [current.definition], hidden: true, name: "项目单元" }],
			directory: "C:\\project",
			filePath: "C:\\project\\project.properties",
			kind: "project",
			name: "测试项目"
		}
	};
	const candidates = provideSimpleCompletions(
		splitSimpleUnitSource(source).userCode,
		offset,
		undefined,
		context
	)?.candidates.filter((candidate) => candidate.name === "执行") ?? [];

	assert.deepEqual(candidates.map((candidate) => candidate.overloadArity), [0, 1]);
	assert.deepEqual(candidates.map((candidate) => candidate.snippet), ["执行()", "执行(${1:value})"]);
});

test("运行库同名方法重载分别提供补全项", async () => {
	const candidates = await completionCandidates(unit([
		"过程 Run()",
		"\t变量 list 为 分组列表框",
		"\tlist.tjzx¦",
		"结束 过程"
	].join("\r\n")));
	const overloads = candidates.filter((candidate) => candidate.name === "添加子项");

	assert.deepEqual(overloads.map((candidate) => candidate.overloadArity), [2, 6]);
	assert.equal(overloads[0]?.snippet?.split("${").length, 3);
	assert.equal(overloads[1]?.snippet?.split("${").length, 7);
});

test("变体型布局不推断具体成员，显式布局变量正常提示", async () => {
	const variantLayout = await complete([
		"事件 Test.初始化()",
		"\t面板1.布局.¦",
		"结束 事件",
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 Test $为 窗口",
		"\t\t$定义 面板1 $为 面板",
		"\t\t\t布局 = 布局_表格",
		"\t\t$结束 $定义",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.deepEqual(variantLayout, []);

	const typedLayout = await complete(unit([
		"过程 Run()",
		"\t变量 局_表格布局 为 表格布局",
		"\t局_表格布局.¦",
		"结束 过程"
	].join("\r\n")));
	assert.ok(typedLayout.includes("所有列可拉伸"));
	assert.ok(typedLayout.includes("置列可拉伸"));
});

test("别名目标位置支持跨命名空间类型补全", () => {
	const sourceRoot = "C:\\project\\src";
	const target = parseSimpleUnitSymbols(
		"$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n",
		`${sourceRoot}\\pkg\\tools\\Target.simple`,
		sourceRoot
	);
	const marked = "别名 T = pkg.tools.Ta¦";
	const offset = marked.indexOf("¦");
	const source = marked.replace("¦", "");
	const current = parseSimpleUnitSymbols(source, `${sourceRoot}\\Caller.simple`, sourceRoot);
	const context: SimpleProjectSemanticContext = {
		currentUnit: current,
		manifest: {
			categories: [{ definitions: [target.definition, current.definition], name: "项目单元" }],
			directory: "C:\\project",
			filePath: "C:\\project\\project.properties",
			kind: "project",
			name: "测试项目"
		}
	};
	const result = provideSimpleCompletions(source, offset, undefined, context);

	assert.deepEqual(result?.candidates.map((candidate) => candidate.name), ["pkg.tools.Target"]);
	assert.equal(source.slice(result?.start, result?.end), "pkg.tools.Ta");
});

test("表达式限定链按层提示命名空间和静态类型", () => {
	const sourceRoot = "C:\\project\\src";
	const target = parseSimpleUnitSymbols(
		"$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n",
		`${sourceRoot}\\pkg\\tools\\Target.simple`,
		sourceRoot
	);
	const completeProject = (query: string): readonly string[] => {
		const marked = `过程 Run()\r\n\t${query}¦\r\n结束 过程`;
		const offset = marked.indexOf("¦");
		const source = marked.replace("¦", "");
		const current = parseSimpleUnitSymbols(source, `${sourceRoot}\\Caller.simple`, sourceRoot);
		const context: SimpleProjectSemanticContext = {
			currentUnit: current,
			manifest: {
				categories: [{ definitions: [target.definition, current.definition], name: "项目单元" }],
				directory: "C:\\project",
				filePath: "C:\\project\\project.properties",
				kind: "project",
				name: "测试项目"
			}
		};
		return provideSimpleCompletions(source, offset, undefined, context)?.candidates.map(
			(candidate) => candidate.name
		) ?? [];
	};

	assert.deepEqual(completeProject("pkg.to"), ["tools"]);
	assert.deepEqual(completeProject("pkg.tools."), ["Target"]);
});

test("R 点号成员只补全当前项目 res 中已有的资源", () => {
	const marked = "过程 Run()\r\n\t图标 = R.drawable_¦\r\n结束 过程";
	const offset = marked.indexOf(CURSOR);
	const source = marked.replace(CURSOR, "");
	const sourceRoot = "C:\\project\\src";
	const current = parseSimpleUnitSymbols(source, `${sourceRoot}\\Main.simple`, sourceRoot);
	const context: SimpleProjectSemanticContext = {
		currentUnit: current,
		manifest: {
			categories: [{ definitions: [current.definition], name: "项目单元" }],
			directory: "C:\\project",
			filePath: "C:\\project\\project.properties",
			kind: "project",
			name: "资源测试"
		},
		resources: {
			objectQualifiedName: "sample.app.SimpleResources",
			projectDirectory: "C:\\project",
			symbols: [{
				name: "drawable_icon",
				resourceName: "icon",
				resourceType: "drawable",
				sourceFiles: ["C:\\project\\res\\drawable\\icon.png"]
			}, {
				name: "string_app_name",
				resourceName: "app_name",
				resourceType: "string",
				sourceFiles: ["C:\\project\\res\\values\\strings.xml"]
			}]
		}
	};
	const result = provideSimpleCompletions(source, offset, undefined, context);

	assert.deepEqual(result?.candidates.map((candidate) => candidate.name), ["drawable_icon"]);
	assert.equal(result?.candidates[0]?.kind, "constant");
	assert.equal(result?.candidates[0]?.description, "Android drawable 资源。");
	assert.doesNotMatch(result?.candidates[0]?.detail ?? "", /0x|&H/iu);

	const allSource = source.replace("R.drawable_", "R.");
	assert.deepEqual(
		provideSimpleCompletions(allSource, allSource.indexOf("R.") + 2, undefined, context)
			?.candidates.map((candidate) => candidate.name),
		["drawable_icon", "string_app_name"]
	);
});

test("组件实例和继承成员参与当前单元首拼补全", async () => {
	const component = await complete([
		"过程 Run()",
		"	zjsq¦",
		"结束 过程",
		"$属性",
		"	$资源 $窗口",
		"	$定义 Test $为 窗口",
		"		$定义 主计时器 $为 计时器",
		"		$结束 $定义",
		"	$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.ok(component.includes("主计时器"));

	const inherited = await complete([
		"过程 Run()",
		"	bjys¦",
		"结束 过程",
		"$属性",
		"	$资源 $对象",
		"	基础对象 = 窗口",
		"$结束 $属性"
	].join("\r\n"));
	assert.ok(inherited.includes("背景颜色"));
});

test("单行如果不建立块，续行条件和冒号语句保持正确语境", async () => {
	const afterSingleLineIf = await complete(unit([
		"过程 Run()",
		"\t如果 真 则 Run()",
		"\t结束 ¦",
		"结束 过程"
	].join("\r\n")));
	assert.deepEqual(afterSingleLineIf, ["过程"]);

	const continuedCondition = await complete(unit([
		"过程 Run()",
		"\t如果 真 且 _",
		"\t\t假 z¦",
		"\t结束 如果",
		"结束 过程"
	].join("\r\n")));
	assert.equal(continuedCondition[0], "则");

	const afterColon = await complete(unit("过程 Run()\r\n\tRun(): rg¦\r\n结束 过程"));
	assert.ok(afterColon.includes("如果"));
});

test("顶层字段和属性区组件可解析实例成员，非法下划线首字符不作为声明", async () => {
	const field = await complete(unit([
		"变量 timer 为 计时器",
		"过程 Run()",
		"\ttimer.jg¦",
		"结束 过程"
	].join("\r\n")));
	assert.deepEqual(field, ["间隔"]);

	const component = await complete([
		"过程 Run()",
		"\tTimer.jg¦",
		"结束 过程",
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 Test $为 窗口",
		"\t\t$定义 Timer $为 计时器",
		"\t\t$结束 $定义",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.deepEqual(component, ["间隔"]);

	const invalid = await complete(unit([
		"过程 Run()",
		"\t变量 _timer 为 计时器",
		"\t_timer.jg¦",
		"结束 过程"
	].join("\r\n")));
	assert.deepEqual(invalid, []);
});
