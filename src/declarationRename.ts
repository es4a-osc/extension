/*
识别声明名称的连续编辑，并复用语义重构规则生成自动引用同步计划。
xhwsd@qq.com 2026-10-10
*/

import { resolveSimpleBinding } from "./completionModel";
import { findSimpleDefinition } from "./definitionModel";
import { filePathKey } from "./simpleProjectPaths";
import { applySimpleCodeChanges, planSimpleSymbolRename, type RefactoringUnit, type SimpleUnitChange } from "./refactoringModel";
import type { SimpleProjectSemanticContext } from "./simpleUnitSymbols";
import type { Sdk } from "./sdk";

export interface DeclarationTextChange {
	readonly rangeOffset: number;
	readonly rangeLength: number;
	readonly text: string;
}

/** 只保留正在编辑的声明身份；旧引用在提交时按当前项目重新分析。 */
export interface PendingDeclarationRename {
	readonly start: number;
	readonly oldName: string;
	readonly newName: string;
	readonly local: boolean;
}

/** 普通正文输入只检查当前物理行，不为每个字符建立整份语义上下文。 */
export function declarationNameAtChange(source: string, change: DeclarationTextChange): { readonly start: number; readonly end: number; readonly name: string } | undefined {
	if (!/^[\p{L}\p{N}_]*$/u.test(change.text)) return undefined;
	const lineStart = source.lastIndexOf("\n", change.rangeOffset - 1) + 1;
	let start = change.rangeOffset;
	let end = start + change.rangeLength;
	while (start > lineStart && /[\p{L}\p{N}_]/u.test(source[start - 1]!)) start -= 1;
	while (end < source.length && /[\p{L}\p{N}_]/u.test(source[end]!)) end += 1;
	const name = source.slice(start, end);
	if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name)) return undefined;
	const prefix = source.slice(lineStart, start);
	const variable = /^[ \t]*(?:静态[ \t]+)?变量[ \t]+(?:.*,[ \t]*)?$/u.test(prefix);
	const callable = /^[ \t]*(?:静态[ \t]+)?(?:函数|过程|事件)[ \t]+[^()]*\(/u.exec(prefix);
	const parameter = callable !== null && /^(?:.*,[ \t]*)?(?:(?:传址|传值)[ \t]+)?$/u.test(prefix.slice(callable[0].length));
	return variable || parameter ? { start, end, name } : undefined;
}

/** 在旧文本中证明编辑命中了变量或参数的声明，不从同名引用推测改名。 */
export function beginDeclarationRename(source: string, change: DeclarationTextChange, sdk: Sdk | undefined, context: SimpleProjectSemanticContext): PendingDeclarationRename | undefined {
	if (context.currentUnit === undefined || !/^[\p{L}\p{N}_]*$/u.test(change.text)) return undefined;
	const span = declarationNameAtChange(source, change);
	if (span === undefined) return undefined;
	const target = findSimpleDefinition(source, span.start, sdk, context);
	if (target?.targetOffset !== span.start || target.filePath === undefined || filePathKey(target.filePath) !== filePathKey(context.currentUnit.filePath)) return undefined;
	const binding = resolveSimpleBinding(source, span.start, span.name, context);
	const local = target.symbolKind === "binding" && (binding?.kind === "variable" || binding?.kind === "parameter");
	const field = target.symbolKind === "binding" && (binding?.kind === "field" || binding?.kind === "staticField");
	if (!local && !field && !(target.symbolKind === "member" && target.memberGroup === "variables" && target.propertySource !== true)) return undefined;
	const name = span.name.slice(0, change.rangeOffset - span.start) + change.text + span.name.slice(change.rangeOffset + change.rangeLength - span.start);
	return name === span.name ? undefined : { start: span.start, oldName: span.name, newName: name, local };
}

/** 空名称及选词中的中间状态可以暂存；提交才验证完整名称。其它文本编辑取消推测。 */
export function continueDeclarationRename(source: string, change: DeclarationTextChange, pending: PendingDeclarationRename): PendingDeclarationRename | undefined {
	const end = pending.start + pending.newName.length;
	if (source.slice(pending.start, end) !== pending.newName || change.rangeOffset < pending.start || change.rangeOffset + change.rangeLength > end || !/^[\p{L}\p{N}_]*$/u.test(change.text)) return undefined;
	const name = pending.newName.slice(0, change.rangeOffset - pending.start) + change.text + pending.newName.slice(change.rangeOffset + change.rangeLength - pending.start);
	return { ...pending, newName: name };
}

/** 输入分隔空白只表示离开名称，不把空白作为名称的一部分；保留用户新增空白。 */
export function finishesDeclarationRename(source: string, change: DeclarationTextChange, pending: PendingDeclarationRename): boolean {
	const end = pending.start + pending.newName.length;
	const lineEnd = source.indexOf("\n", end);
	return change.rangeLength === 0 && /^[ \t\r\n]+$/u.test(change.text) && change.rangeOffset >= end && change.rangeOffset <= (lineEnd < 0 ? source.length : lineEnd);
}

/** 恢复旧声明仅作为内存分析输入；实际编辑只同步仍指向原变量的引用。 */
export function planDeclarationRename(units: readonly RefactoringUnit[], origin: RefactoringUnit, pending: PendingDeclarationRename, sdk: Sdk | undefined): readonly SimpleUnitChange[] {
	if (pending.oldName === pending.newName) return [];
	const end = pending.start + pending.newName.length;
	if (origin.userCode.slice(pending.start, end) !== pending.newName) throw new Error("声明已变化，未应用此次重构。");
	const before: RefactoringUnit = { ...origin, userCode: origin.userCode.slice(0, pending.start) + pending.oldName + origin.userCode.slice(end) };
	const input = pending.local ? [before] : units.map((unit) => unit === origin ? before : unit);
	const plans = planSimpleSymbolRename(input, before, pending.start, pending.newName, sdk);
	return plans.flatMap((plan) => {
		const actual = plan.unit === before ? origin : plan.unit;
		if (actual.userCode === plan.userCode) return [];
		const delta = pending.newName.length - pending.oldName.length;
		const edits = plan.edits.filter((edit) => plan.unit !== before || edit.start !== pending.start).map((edit) => plan.unit === before && edit.start > pending.start ? { ...edit, start: edit.start + delta, end: edit.end + delta } : edit);
		if (applySimpleCodeChanges(actual.userCode, edits) !== plan.userCode) throw new Error("引用位置已变化，未应用此次重构。");
		return [{ ...plan, unit: actual, edits }];
	});
}
