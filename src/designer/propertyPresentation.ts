/*
集中计算属性框显式编辑值、缺省态提示和选择项说明，不复制 Vue 状态。
xhwsd@qq.com 2026-8-31
*/

import type { PropertyPanelRow } from "../propertyPanelModel";
import { parseSimpleStringLiteral, serializeSimpleStringLiteral } from "../simpleStringLiteral";
import { sdkDescriptionHoverHint } from "./designerView";

/** 候选菜单内部用于表示“清除显式赋值”的非 Simple 表达式值。 */
export const DEFAULT_PROPERTY_SELECT_VALUE = "\uE000ES4A_DEFAULT_PROPERTY_VALUE";

/** Simple 扫描器接受的带可选正负号整数表达式。 */
const SIMPLE_INTEGER_LITERAL = /^[+-]?[ \t]*(?:(?:0|[1-9][0-9]*)|&H[0-9A-Fa-f]+)$/u;

/** Simple 扫描器接受的带可选正负号十进制数值表达式。 */
const SIMPLE_FLOAT_LITERAL = /^[+-]?[ \t]*(?:0|[1-9][0-9]*)(?:\.[0-9]+(?:[eE][+-]?[0-9]+)?)?$/u;

/** Android 运行库像素解析器接受的十进制正文及可选单位。 */
const SIMPLE_PIXEL_TEXT = /^[+-]?(?:(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)[ \t]*(?:px|dp|dip|sp)?$/iu;

/** Simple 标识符及其点号限定形式；这里只判断外形，不查询 SDK 符号。 */
const SIMPLE_IDENTIFIER = /^[\p{L}_][\p{L}\p{N}_]*$/u;

/** 属性框可以直接录入整数字面量的标量类型。 */
const SIMPLE_INTEGER_TYPES = new Set(["字节型", "短整数型", "整数型", "长整数型"]);

/** 属性框可以直接录入数值字面量的浮点类型。 */
const SIMPLE_FLOAT_TYPES = new Set(["单精度小数型", "双精度小数型"]);

/** 数值输入失败时使用的简短 VS Code 状态栏消息正文。 */
const NUMERIC_PROPERTY_REQUIREMENTS = new Map<string, string>([
	["字节型", "有效字节值"],
	["短整数型", "有效短整数值"],
	["整数型", "有效整数值"],
	["长整数型", "有效长整数值"],
	["单精度小数型", "有效单精度数值"],
	["双精度小数型", "有效双精度数值"]
]);

/** 判断完整输入是否是一个括号平衡的函数调用表达式。 */
function isSimpleCallExpression(expression: string): boolean {
	const open = expression.indexOf("(");
	if (open <= 0 || !expression.endsWith(")")) return false;
	const callee = expression.slice(0, open).trim();
	if (!callee.split(".").every((part) => SIMPLE_IDENTIFIER.test(part))) return false;

	let depth = 0;
	let quoted = false;
	let escaped = false;
	for (let index = open; index < expression.length; index += 1) {
		const character = expression[index];
		if (quoted) {
			if (escaped) {
				escaped = false;
			} else if (character === "\\") {
				escaped = true;
			} else if (character === "\"") {
				quoted = false;
			}
			continue;
		}
		if (character === "\"") {
			quoted = true;
			continue;
		}
		if (character === "(") depth += 1;
		if (character === ")") {
			depth -= 1;
			if (depth < 0 || depth === 0 && index !== expression.length - 1) return false;
		}
	}
	return depth === 0 && !quoted;
}

/** 判断调用、限定成员或下划线常量的语法外形，不验证目标是否真实存在。 */
function isSimpleSymbolicExpression(expression: string): boolean {
	if (isSimpleCallExpression(expression)) return true;
	const parts = expression.split(".");
	if (!parts.every((part) => SIMPLE_IDENTIFIER.test(part))) return false;
	if (parts.length > 1) return true;
	return parts[parts.length - 1]?.includes("_") === true;
}

/** 判断单个标识符或点号限定成员引用，不查询符号是否存在。 */
function isSimpleReferenceExpression(expression: string): boolean {
	return expression.split(".").every((part) => SIMPLE_IDENTIFIER.test(part));
}

/** 一个需要由扩展宿主查询 SDK 或项目语义索引的原子符号表达式。 */
export interface AtomicPropertySymbolExpression {
	readonly expression: string;
	readonly offset: number;
}

/**
 * 返回单独常量、成员引用或函数调用中最后一个标识符的位置。
 *
 * 数值、字符串及组合表达式不在这里验证；组合表达式继续按兼容规则放行。
 */
export function atomicPropertySymbolExpression(input: string): AtomicPropertySymbolExpression | undefined {
	const expression = input.trim();
	const callee = isSimpleCallExpression(expression)
		? expression.slice(0, expression.indexOf("(")).trim()
		: isSimpleReferenceExpression(expression) ? expression : undefined;
	if (callee === undefined) return undefined;
	const offset = callee.length - 1;
	return offset < 0 ? undefined : { expression, offset };
}

/**
 * 识别需要兼容放行的组合表达式。
 *
 * 这里只避开字符串内部的运算符，不尝试替代 Simple 解析器验证表达式是否合法。
 */
function isSimpleCompositeExpression(expression: string): boolean {
	let quoted = false;
	let escaped = false;
	let unquoted = "";
	for (let index = 0; index < expression.length; index += 1) {
		const character = expression[index];
		if (quoted) {
			unquoted += " ";
			if (escaped) {
				escaped = false;
			} else if (character === "\\") {
				escaped = true;
			} else if (character === "\"") {
				quoted = false;
			}
			continue;
		}
		if (character === "\"") {
			quoted = true;
			unquoted += "S";
			continue;
		}
		unquoted += character;
	}

	if (/^[ \t]*\(.*\)[ \t]*$/u.test(unquoted)) return true;
	if (/(?:^|[ \t(])(?:且|或|异或|是|非)(?=$|[ \t)])/u.test(unquoted)) return true;
	for (let index = 0; index < unquoted.length; index += 1) {
		if (!"&*/\\%=<>+-".includes(unquoted[index] ?? "")) continue;
		if (unquoted.slice(0, index).trim().length > 0 && unquoted.slice(index + 1).trim().length > 0) {
			return true;
		}
	}
	return false;
}

/** 编辑器未显式声明时，整数属性仍采用整数输入规则。 */
function effectivePropertyEditor(typeName: string | undefined, editor: string | undefined): string | undefined {
	if (editor !== undefined && editor.length > 0) return editor;
	return typeName !== undefined && SIMPLE_INTEGER_TYPES.has(typeName) ? "simple.integer" : undefined;
}

/** simple.pixel 把像素正文转换为运行库接受的整数或文本表达式。 */
function normalizePixelInput(expression: string, stringLiteral: string | undefined): string | undefined {
	if (stringLiteral !== undefined) {
		return SIMPLE_PIXEL_TEXT.test(stringLiteral.trim()) ? expression : undefined;
	}
	if (SIMPLE_INTEGER_LITERAL.test(expression)) return expression;
	if (SIMPLE_PIXEL_TEXT.test(expression)) return serializeSimpleStringLiteral(expression);
	if (
		isSimpleCallExpression(expression)
		|| isSimpleReferenceExpression(expression)
		|| isSimpleCompositeExpression(expression)
	) {
		return expression;
	}
	return undefined;
}

/**
 * 根据属性声明类型把属性框正文转换为合法 Simple 表达式。
 *
 * 返回 undefined 表示数值标量属性收到非数值、非表达式内容；调用方应恢复原值。
 * 函数、资源索引和常量只按语法外形保留，不通过 SDK 判断其存在性或返回类型。
 */
export function normalizePropertyInput(
	typeName: string | undefined,
	input: string,
	editor?: string
): string | undefined {
	const expression = input.trim();
	const stringLiteral = parseSimpleStringLiteral(expression);
	const symbolic = isSimpleSymbolicExpression(expression);
	const composite = isSimpleCompositeExpression(expression);
	const resolvedEditor = effectivePropertyEditor(typeName, editor);
	if (resolvedEditor === "simple.pixel") {
		return normalizePixelInput(expression, stringLiteral);
	}
	if (resolvedEditor === "simple.integer") {
		if (stringLiteral !== undefined) return undefined;
		return SIMPLE_INTEGER_LITERAL.test(expression)
			|| isSimpleReferenceExpression(expression)
			|| isSimpleCallExpression(expression)
			|| composite
			? expression
			: undefined;
	}
	if (typeName !== undefined && SIMPLE_FLOAT_TYPES.has(typeName)) {
		if (stringLiteral !== undefined) return undefined;
		return SIMPLE_INTEGER_LITERAL.test(expression)
			|| SIMPLE_FLOAT_LITERAL.test(expression)
			|| isSimpleReferenceExpression(expression)
			|| isSimpleCallExpression(expression)
			|| composite
			? expression
			: undefined;
	}

	switch (typeName) {
		case "变体型":
			if (stringLiteral !== undefined) return expression;
			return SIMPLE_INTEGER_LITERAL.test(expression)
				|| SIMPLE_FLOAT_LITERAL.test(expression)
				|| symbolic
				|| composite
				? expression
				: serializeSimpleStringLiteral(input);
		case "文本型":
			if (stringLiteral !== undefined || symbolic || composite) return expression;
			return serializeSimpleStringLiteral(input);
		default:
			return input;
	}
}

/** 只为属性框实际校验的数值标量类型生成用户可见警告。 */
export function propertyInputValidationMessage(
	typeName: string | undefined,
	componentName: string | undefined,
	propertyName: string | undefined,
	editor?: string
): string | undefined {
	if (
		componentName === undefined
		|| componentName.length === 0
		|| propertyName === undefined
		|| propertyName.length === 0
	) return undefined;
	const resolvedEditor = effectivePropertyEditor(typeName, editor);
	const requirement = resolvedEditor === "simple.pixel"
		? "有效像素值（例如 30、30dp、30px 或 30sp）"
		: resolvedEditor === "simple.integer"
			? NUMERIC_PROPERTY_REQUIREMENTS.get(typeName ?? "") ?? "有效整数值"
			: typeName === undefined ? undefined : NUMERIC_PROPERTY_REQUIREMENTS.get(typeName);
	return requirement === undefined ? undefined : `${componentName}.${propertyName}：需要${requirement}`;
}

/** 把候选菜单操作转换为宿主可提交的 XML 值与删除标记。 */
export function propertySelectSubmission(value: string): { readonly allowEmpty: boolean; readonly value: string } {
	return value === DEFAULT_PROPERTY_SELECT_VALUE
		? { allowEmpty: true, value: "" }
		: { allowEmpty: false, value };
}

/** 缺省态编辑框保持为空；显式字符串显示正文，命中候选的表达式显示选项标签。 */
export function propertyEditorValue(row: PropertyPanelRow): string {
	if (row.valueSource === "default") return "";
	if (row.allowCustomValue === true && row.choices !== undefined) {
		return propertyExpressionLabel(row, row.value) ?? row.stringLiteralInput ?? row.value;
	}
	return row.stringLiteralInput ?? row.value;
}

/** 返回 initializer 自身声明的显示文本，不从 select.options 推导。 */
function propertyDefaultDisplayText(row: PropertyPanelRow): string {
	return row.defaultLabel ?? row.stringLiteralInput ?? row.defaultExpression ?? row.value;
}

/** 缺省值只作为占位提示；空字符串用引号提示，避免属性值列看起来没有值。 */
export function propertyEditorPlaceholder(row: PropertyPanelRow): string | undefined {
	if (row.valueSource !== "default") return undefined;
	const displayValue = propertyDefaultDisplayText(row);
	return displayValue.length > 0 ? displayValue : row.value || undefined;
}

/** 数值属性中不能按声明类型解析为字面量的显式值按不可拆分的常量处理。 */
export function isAtomicPropertyExpression(row: PropertyPanelRow): boolean {
	if (row.valueSource !== "explicit") return false;
	const value = row.value.trim();
	if (row.typeName !== undefined && SIMPLE_INTEGER_TYPES.has(row.typeName)) {
		return !SIMPLE_INTEGER_LITERAL.test(value);
	}
	if (row.typeName !== undefined && SIMPLE_FLOAT_TYPES.has(row.typeName)) {
		return !SIMPLE_INTEGER_LITERAL.test(value) && !SIMPLE_FLOAT_LITERAL.test(value);
	}
	return false;
}

/** 返回属性值列当前实际显示的文本，供溢出测量和完整值提示复用。 */
export function propertyValueDisplayText(row: PropertyPanelRow): string {
	if (row.editTarget === undefined) {
		return row.valueSource === "default" ? row.defaultLabel ?? row.value : row.value;
	}
	if (row.choices !== undefined) {
		return row.valueSource === "default"
			? propertyDefaultDisplayText(row)
			: propertyExpressionLabel(row, row.value) ?? row.value;
	}
	return propertyEditorValue(row) || propertyEditorPlaceholder(row) || "";
}

/** 仅当属性值文本宽于实际可用空间时显示完整值提示。 */
export function propertyValueNeedsTooltip(availableWidth: number, textWidth: number): boolean {
	return textWidth > Math.max(0, availableWidth) + 0.5;
}

/** 为编辑器说明属性用途，并向辅助技术明确当前是否显示缺省值。 */
export function propertyValueAriaLabel(row: PropertyPanelRow): string {
	const label = row.editTarget?.effect === "renameComponent"
		? "组件名称"
		: row.editTarget?.effect === "editComponentComment"
			? "组件注释"
			: row.name + (row.stringLiteralInput === undefined ? "的属性表达式" : "的字符串值");
	return label + (row.valueSource === "default" ? "，当前显示缺省值" : "");
}

/** 属性名称、类型和缺省值连续显示；SDK 说明另起一段，便于区分元数据与用途。 */
export function propertyHoverHint(row: PropertyPanelRow): string {
	const metadata = [
		row.name,
		row.typeName === undefined ? undefined : `类型：${row.typeName}`,
		row.defaultExpression === undefined ? undefined : `缺省值：${row.defaultExpression}`
	].filter((value): value is string => value !== undefined && value.length > 0);
	const description = sdkDescriptionHoverHint(row.description);
	return description === undefined || description.length === 0
		? metadata.join("\n")
		: `${metadata.join("\n")}\n\n${description}`;
}

/** 返回与指定 Simple 表达式对应的真实 SDK 选项。 */
function matchingPropertyChoice(
	row: PropertyPanelRow,
	expression: string
): NonNullable<PropertyPanelRow["choices"]>[number] | undefined {
	return row.choices?.find((choice) => choice.value === expression);
}

/** 仅供设计器前端显示：先按选择项、再按对象形式 initializer 的值适配标签，不转换或改写实际属性值。 */
function propertyExpressionLabel(row: PropertyPanelRow, expression: string): string | undefined {
	return matchingPropertyChoice(row, expression)?.label
		?? (row.defaultLabel !== undefined && row.defaultExpression === expression
			? row.defaultLabel
			: undefined);
}


