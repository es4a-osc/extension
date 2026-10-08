/*
验证属性框以独立缺省态呈现 SDK 有效值，同时保持显式值和编辑原值语义。
xhwsd@qq.com 2026-8-31
*/

import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
	atomicPropertySymbolExpression,
	DEFAULT_PROPERTY_SELECT_VALUE,
	isAtomicPropertyExpression,
	normalizePropertyInput,
	propertyInputValidationMessage,
	propertyEditorPlaceholder,
	propertyEditorValue,
	propertyHoverHint,
	propertySelectSubmission,
	propertyValueDisplayText,
	propertyValueNeedsTooltip,
	propertyValueAriaLabel
} from "../designer/propertyPresentation";
import type { PropertyPanelRow } from "../propertyPanelModel";

const defaultStringRow: PropertyPanelRow = {
	defaultExpression: "\"缺省标题\"",
	editTarget: { removeElementWhenEmpty: true, xmlPath: "/属性/定义[1]/赋值[@属性='标题']/@值" },
	name: "标题",
	stringLiteralInput: "缺省标题",
	typeName: "文本型",
	value: "\"缺省标题\"",
	valueSource: "default"
};

test("输入框只用占位文本提示 SDK 缺省值", () => {
	assert.equal(propertyEditorValue(defaultStringRow), "");
	assert.equal(propertyEditorPlaceholder(defaultStringRow), "缺省标题");
	assert.equal(propertyValueAriaLabel(defaultStringRow), "标题的字符串值，当前显示缺省值");
	assert.equal(propertyEditorPlaceholder({
		...defaultStringRow,
		defaultExpression: "\"\"",
		stringLiteralInput: "",
		value: "\"\""
	}), "\"\"");
	assert.equal(propertyEditorValue({
		...defaultStringRow,
		stringLiteralInput: "显式标题",
		value: "\"显式标题\"",
		valueSource: "explicit"
	}), "显式标题");
	assert.equal(propertyValueDisplayText(defaultStringRow), "缺省标题");
	const namedDefaultRow: PropertyPanelRow = {
		defaultExpression: "字体_默认_大小",
		defaultLabel: "默认大小",
		editTarget: { removeElementWhenEmpty: true, xmlPath: "/属性/定义[1]/赋值[@属性='字体大小']/@值" },
		name: "字体大小",
		typeName: "单精度小数型",
		value: "字体_默认_大小",
		valueSource: "default"
	};
	assert.equal(propertyEditorPlaceholder(namedDefaultRow), "默认大小");
	assert.equal(propertyValueDisplayText(namedDefaultRow), "默认大小");
	assert.equal(propertyValueDisplayText({
		...namedDefaultRow,
		editTarget: undefined
	}), "默认大小");
});

test("候选菜单按标签显示但保持缺省值和显式值的 Simple 表达式", () => {
	const choices = [{ label: "左", value: "组件.对齐_左" }];
	const defaultChoiceRow: PropertyPanelRow = {
		choices,
		defaultExpression: "组件.对齐_左",
		defaultLabel: "缺省靠左",
		editTarget: { removeElementWhenEmpty: true, xmlPath: "/属性/定义[1]/赋值[@属性='内容对齐']/@值" },
		name: "内容对齐",
		typeName: "整数型",
		value: "组件.对齐_左",
		valueSource: "default"
	};
	assert.equal(propertyValueDisplayText(defaultChoiceRow), "缺省靠左");
	const explicitMappedRow = {
		...defaultChoiceRow,
		valueSource: "explicit" as const
	};
	assert.equal(propertyValueDisplayText(explicitMappedRow), "左");
	const explicitUnknownRow = { ...explicitMappedRow, value: "取对齐()" };
	assert.equal(propertyValueDisplayText(explicitUnknownRow), "取对齐()");
	const explicitLogicalRow: PropertyPanelRow = {
		...defaultChoiceRow,
		choices: [
			{ label: "真", value: "真" },
			{ label: "假", value: "假" }
		],
		defaultLabel: "真",
		value: "真",
		valueSource: "explicit"
	};
	assert.equal(propertyValueDisplayText(explicitLogicalRow), "真");
	assert.equal(propertyValueDisplayText({
		...defaultChoiceRow,
		defaultLabel: undefined
	}), "组件.对齐_左");
	const emptyDefaultChoiceRow: PropertyPanelRow = {
		...defaultChoiceRow,
		defaultExpression: undefined,
		defaultLabel: undefined,
		value: "",
		valueSource: "default"
	};
	assert.equal(propertyEditorPlaceholder(emptyDefaultChoiceRow), undefined);
	assert.equal(propertyValueDisplayText(emptyDefaultChoiceRow), "");
	assert.deepEqual(propertySelectSubmission(DEFAULT_PROPERTY_SELECT_VALUE), {
		allowEmpty: true,
		value: ""
	});
	assert.deepEqual(propertySelectSubmission("真"), {
		allowEmpty: false,
		value: "真"
	});
	assert.deepEqual(propertySelectSubmission("长度_匹配父级"), {
		allowEmpty: false,
		value: "长度_匹配父级"
	});
});

test("可选且可输入的属性命中选项时显示标签否则显示原值", () => {
	const customSelectRow: PropertyPanelRow = {
		allowCustomValue: true,
		choices: [
			{ label: "适应内容", value: "长度_适应内容" },
			{ label: "匹配父级", value: "长度_匹配父级" }
		],
		defaultExpression: "长度_适应内容",
		defaultLabel: "适应内容",
		editTarget: { removeElementWhenEmpty: true, xmlPath: "/属性/定义[1]/赋值[@属性='高度']/@值" },
		name: "高度",
		typeName: "整数型",
		value: "长度_匹配父级",
		valueSource: "explicit"
	};

	assert.equal(propertyEditorValue(customSelectRow), "匹配父级");
	assert.equal(propertyValueDisplayText(customSelectRow), "匹配父级");
	assert.equal(propertyEditorValue({ ...customSelectRow, value: "-2" }), "-2");
	assert.equal(propertyValueDisplayText({ ...customSelectRow, value: "-2" }), "-2");
	assert.equal(propertyEditorValue({ ...customSelectRow, value: "100" }), "100");
	assert.equal(propertyValueDisplayText({ ...customSelectRow, value: "100" }), "100");
	const initializerOnlyRow: PropertyPanelRow = {
		...customSelectRow,
		choices: [{ label: "匹配父级", value: "长度_匹配父级" }],
		defaultExpression: "字体类型_默认",
		defaultLabel: "默认",
		value: "字体类型_默认"
	};
	assert.equal(propertyEditorValue(initializerOnlyRow), "默认");
	assert.equal(propertyValueDisplayText(initializerOnlyRow), "默认");
	assert.equal(propertyEditorValue({
		...customSelectRow,
		allowCustomValue: undefined
	}), "长度_匹配父级");
	assert.equal(propertyEditorValue({
		...customSelectRow,
		value: "长度_适应内容",
		valueSource: "default"
	}), "");
});

test("属性值只在文本宽于可用空间时需要完整值提示", () => {
	assert.equal(propertyValueNeedsTooltip(120, 120), false);
	assert.equal(propertyValueNeedsTooltip(120, 120.4), false);
	assert.equal(propertyValueNeedsTooltip(120, 121), true);
	assert.equal(propertyValueNeedsTooltip(-1, 1), true);
});

test("属性悬停将名称类型和缺省值连排并把说明单独成段", () => {
	assert.equal(
		propertyHoverHint({
			...defaultStringRow,
			description: "**第一行。**\n- 第二行。"
		}),
		"标题\n类型：文本型\n缺省值：\"缺省标题\"\n\n第一行。\n• 第二行。"
	);
	assert.equal(
		propertyHoverHint({ ...defaultStringRow, description: undefined }),
		"标题\n类型：文本型\n缺省值：\"缺省标题\""
	);
});

test("整数和浮点属性按声明类型区分字面量与原子常量", () => {
	const row: PropertyPanelRow = {
		editTarget: { removeElementWhenEmpty: true, xmlPath: "/属性/定义[1]/赋值[@属性='宽度']/@值" },
		name: "宽度",
		typeName: "整数型",
		value: "组件.长度_匹配父级",
		valueSource: "explicit"
	};
	assert.equal(isAtomicPropertyExpression(row), true);
	for (const value of ["0", "200", "-2", "- 2", "+2", "&HFF000000"]) {
		assert.equal(isAtomicPropertyExpression({ ...row, value }), false, value);
	}
	assert.equal(isAtomicPropertyExpression({ ...row, value: "1.5" }), true);
	assert.equal(isAtomicPropertyExpression({ ...row, value: "组件.长度_匹配父" }), true);

	const floatRow = { ...row, typeName: "单精度小数型" };
	for (const value of ["0", "200", "-1.5", "+ 0.5", "1.5E+2"]) {
		assert.equal(isAtomicPropertyExpression({ ...floatRow, value }), false, value);
	}
	assert.equal(isAtomicPropertyExpression({ ...floatRow, value: "组件.比例_一半" }), true);
	assert.equal(isAtomicPropertyExpression({ ...floatRow, typeName: "双精度小数型" }), true);
	assert.equal(isAtomicPropertyExpression({ ...row, valueSource: "default" }), false);
});

test("属性输入按数值、变体和文本类型生成 Simple 表达式", () => {
	for (const expression of ["取值()", "像素转换.到绝对像素(81)", "R.drawable.sym_def_app_icon", "组件.长度_匹配父级"]) {
		for (const typeName of ["字节型", "短整数型", "整数型", "长整数型", "单精度小数型", "双精度小数型"]) {
			assert.equal(normalizePropertyInput(typeName, expression), expression);
		}
		assert.equal(normalizePropertyInput("变体型", expression), expression);
		assert.equal(normalizePropertyInput("文本型", expression), expression);
	}

	for (const typeName of ["字节型", "短整数型", "整数型", "长整数型"]) {
		assert.equal(normalizePropertyInput(typeName, "- 20"), "- 20");
		assert.equal(normalizePropertyInput(typeName, "81dip"), undefined);
		assert.equal(normalizePropertyInput(typeName, "\"81\""), undefined);
	}
	for (const typeName of ["单精度小数型", "双精度小数型"]) {
		assert.equal(normalizePropertyInput(typeName, "1.5E+2"), "1.5E+2");
		assert.equal(normalizePropertyInput(typeName, "&H10"), "&H10");
		assert.equal(normalizePropertyInput(typeName, "81dip"), undefined);
	}
	assert.equal(normalizePropertyInput("变体型", "81"), "81");
	assert.equal(normalizePropertyInput("变体型", "1.5"), "1.5");
	assert.equal(normalizePropertyInput("变体型", "81dip"), "\"81dip\"");
	assert.equal(normalizePropertyInput("变体型", "普通\"文本"), "\"普通\\\"文本\"");
	assert.equal(normalizePropertyInput("变体型", "\"已有字符串\""), "\"已有字符串\"");
	assert.equal(normalizePropertyInput("文本型", "81"), "\"81\"");
	assert.equal(normalizePropertyInput("文本型", "普通文本"), "\"普通文本\"");
	assert.equal(normalizePropertyInput("文本型", "取值(另一个(1), \"右括号)\")"), "取值(另一个(1), \"右括号)\")");
	assert.equal(normalizePropertyInput("变体型", "取值() + 1"), "取值() + 1");
	assert.equal(normalizePropertyInput("文本型", "取值() & \"像素\""), "取值() & \"像素\"");
	assert.equal(normalizePropertyInput("整数型", "当前值 + 1"), "当前值 + 1");
});

test("像素编辑器严格校验直接值并兼容 Simple 表达式", () => {
	for (const value of ["30", "&H1E", "宽度常量", "取得宽度()", "取得宽度() + 10", "30dx + 1"]) {
		assert.equal(normalizePropertyInput("变体型", value, "simple.pixel"), value);
	}
	for (const value of ["30px", "30dp", "30DIP", "-10.5sp", ".5dp", "1e2"]) {
		assert.equal(normalizePropertyInput("变体型", value, "simple.pixel"), `"${value}"`);
	}
	assert.equal(normalizePropertyInput("变体型", "\"30dp\"", "simple.pixel"), "\"30dp\"");
	for (const value of ["30dx", "30pt", "30d", "30 dx", "\"30dx\""]) {
		assert.equal(normalizePropertyInput("变体型", value, "simple.pixel"), undefined, value);
	}
});

test("属性输入只把单独引用和调用交给宿主查询符号", () => {
	assert.deepEqual(atomicPropertySymbolExpression("s"), { expression: "s", offset: 0 });
	assert.deepEqual(atomicPropertySymbolExpression("像素转换.到绝对像素(10)"), {
		expression: "像素转换.到绝对像素(10)",
		offset: "像素转换.到绝对像素".length - 1
	});
	assert.equal(atomicPropertySymbolExpression("不存在() + 1"), undefined);
	assert.equal(atomicPropertySymbolExpression("\"普通文本\""), undefined);
});

test("数值属性校验提示只说明属性需要的有效值", () => {
	assert.equal(propertyInputValidationMessage("字节型", "面板1", "数值"), "面板1.数值：需要有效字节值");
	assert.equal(propertyInputValidationMessage("短整数型", "面板1", "数值"), "面板1.数值：需要有效短整数值");
	assert.equal(propertyInputValidationMessage("整数型", "面板1", "行数"), "面板1.行数：需要有效整数值");
	assert.equal(propertyInputValidationMessage("长整数型", "面板1", "数值"), "面板1.数值：需要有效长整数值");
	assert.equal(propertyInputValidationMessage("单精度小数型", "面板1", "比例"), "面板1.比例：需要有效单精度数值");
	assert.equal(propertyInputValidationMessage("双精度小数型", "面板1", "比例"), "面板1.比例：需要有效双精度数值");
	assert.equal(propertyInputValidationMessage("文本型", "面板1", "文本"), undefined);
	assert.equal(propertyInputValidationMessage("变体型", "面板1", "左边"), undefined);
	assert.equal(
		propertyInputValidationMessage("变体型", "面板1", "左边", "simple.pixel"),
		"面板1.左边：需要有效像素值（例如 30、30dp、30px 或 30sp）"
	);
	assert.equal(propertyInputValidationMessage("对象", "面板1", "基础对象"), undefined);
	assert.equal(propertyInputValidationMessage("整数型", "", "行数"), undefined);
});
