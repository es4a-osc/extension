/*
使用现有 SDK 与项目语义索引验证属性值中的单独常量、资源和函数调用。
xhwsd@qq.com 2026-9-18
*/

import { findSimpleDefinition } from "./definitionModel";
import { atomicPropertySymbolExpression } from "./designer/propertyPresentation";
import type { Sdk } from "./sdk";
import type { SimpleProjectSemanticContext } from "./simpleUnitSymbols";

/**
 * 返回无法解析的原子符号表达式；没有原子符号或已经解析成功时返回 undefined。
 *
 * 属性框只核对能产生值的常量、函数和项目资源。组合表达式由前端兼容放行，
 * 不在这里递归解析其内部符号，也不验证已找到函数的返回类型。
 */
export function unresolvedPropertySymbolExpression(
	expression: string,
	sdk: Sdk | undefined,
	context: SimpleProjectSemanticContext
): string | undefined {
	const atomic = atomicPropertySymbolExpression(expression);
	if (atomic === undefined) return undefined;
	const target = findSimpleDefinition(atomic.expression, atomic.offset, sdk, context);
	return target?.resourceSource === true
		|| target?.memberGroup === "constants"
		|| target?.memberGroup === "functions"
		? undefined
		: atomic.expression;
}
