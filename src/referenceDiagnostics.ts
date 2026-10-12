/*
按当前语义上下文报告未解析的名称、类型、成员及资源引用，不替代编译器诊断。
xhwsd@qq.com 2026-10-10
*/

import { buildCompilerTokenRules } from "./compilerTokens";
import { createSimpleSourceAnalysis, resolveSimpleBinding, resolveSimpleQualifier } from "./completionModel";
import { findSimpleDefinition } from "./definitionModel";
import { resolveSimpleDefinitionName, type SimpleProjectSemanticContext } from "./simpleUnitSymbols";
import { collectPropertyXmlElements, findPropertyXmlElementPath, getPropertyXmlAttribute, type SimplePropertyXmlDocument } from "./propertyXml";
import { findSimpleAssetReferences, type RefactoringUnit } from "./refactoringModel";
import type { Sdk } from "./sdk";

export interface SimpleReferenceDiagnostic {
	readonly code: "unknownName" | "unknownType" | "unknownMember" | "unknownResource" | "unknownRelation" | "unknownAsset";
	readonly message: string;
	readonly start: number;
	readonly end: number;
	readonly propertyPath?: string;
}

/** 只分析用户代码及 XML 模型；没有 SDK 时不把 SDK 名称误报为无效变量。 */
function* analyzeSimpleReferenceSteps(source: string, sdk: Sdk | undefined, context: SimpleProjectSemanticContext, property?: SimplePropertyXmlDocument, assets?: ReadonlySet<string>): Generator<void, readonly SimpleReferenceDiagnostic[]> {
	const diagnostics: SimpleReferenceDiagnostic[] = [];
	const analysis = createSimpleSourceAnalysis(source, sdk, context);
	const masked = analysis.sanitized;
	const definitions = analysis.definitions;
	const rules = buildCompilerTokenRules(sdk);
	const compilerNames = new Set(rules.map((rule) => rule.text));
	const compilerTypes = new Set(rules.filter((rule) => rule.type === "type").map((rule) => rule.text));
	const objectEvents = new Set(sdk?.manifests.find((manifest) => manifest.kind === "compiler")
		?.categories.flatMap((category) => category.definitions)
		.find((definition) => definition.kind === "type" && definition.name === "对象")
		?.events?.map((event) => event.name));
	const knownType = (name: string): boolean => compilerTypes.has(name) || resolveSimpleDefinitionName(name, definitions) !== undefined;
	const types: Array<{ start: number; end: number }> = [];
	for (const match of masked.matchAll(/(?:^|[ \t])为[ \t]+([\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*)/gmu)) {
		yield;
		const name = match[1]!;
		const start = match.index + match[0].lastIndexOf(name);
		types.push({ start, end: start + name.length });
		if (sdk !== undefined && !knownType(name)) diagnostics.push({ code: "unknownType", start, end: start + name.length, message: `找不到类型“${name}”。` });
	}
	if (sdk !== undefined) {
		let typeIndex = 0;
		for (const match of masked.matchAll(/(?<![\p{L}\p{N}_])[\p{L}_][\p{L}\p{N}_]*(?:[ \t]*\.[ \t]*[\p{L}_][\p{L}\p{N}_]*)*/gu)) {
			yield;
			const start = match.index;
			const end = start + match[0].length;
			while (types[typeIndex] !== undefined && types[typeIndex]!.end <= start) typeIndex += 1;
			const type = types[typeIndex];
			if (type !== undefined && start >= type.start && end <= type.end) continue;
			const parts = match[0].split(/[ \t]*\.[ \t]*/u);
			const name = parts[0]!;
			const lineStart = masked.lastIndexOf("\n", start - 1) + 1;
			const prefix = masked.slice(lineStart, start);
			/* 声明名及语法注解由对应解析边界负责；别名 RHS 仍检查引用目标。 */
			if (/^[ \t]*(?:(?:静态|公开|私有)[ \t]+)*(?:变量|常量|过程|函数|属性|别名)[ \t]*$/u.test(prefix)
				|| compilerNames.has(match[0]) || (parts.length === 1 && compilerNames.has(name)) || /^[$@]/u.test(masked[start - 1] ?? "")) continue;
			if (parts.length > 1) {
				const member = parts[parts.length - 1]!;
				const memberStart = end - member.length;
				/* 编译器先识别当前单元的加载／初始化处理器，不按根组件或静态成员查找。仅声明行适用。 */
				if (parts.length === 2 && name === context.currentUnit?.name && objectEvents.has(member)
					&& /^[ \t]*事件[ \t]+$/u.test(prefix) && /^[ \t]*\(/u.test(masked.slice(end))) continue;
				if (name === "R" && parts.length === 2 && resolveSimpleBinding(source, start, "R", context, analysis) === undefined) {
					if (!context.resources?.symbols.some((value) => value.name === member)) diagnostics.push({ code: "unknownResource", start: memberStart, end, message: `找不到资源“R.${member}”。` });
					continue;
				}
				if ((resolveSimpleBinding(source, start, name, context, analysis) === undefined && knownType(parts.join("."))) || findSimpleDefinition(source, memberStart, sdk, context, analysis) !== undefined) continue;
				const qualifier = parts.slice(0, -1).join(".");
				const resolved = resolveSimpleQualifier(source, start, qualifier, sdk, context, analysis);
				const binding = resolveSimpleBinding(source, start, name, context, analysis);
				/* 变体或尚未推断的实例成员由正式编译决定，避免误报。 */
				if (binding?.typeName === "变体型" || (resolved === undefined && binding !== undefined && !knownType(binding.typeName))) continue;
				diagnostics.push({ code: resolved === undefined ? "unknownName" : "unknownMember", start: resolved === undefined ? start : memberStart, end, message: resolved === undefined ? `找不到名称“${qualifier}”。` : `“${qualifier}”没有成员“${member}”。` });
			} else if (findSimpleDefinition(source, start, sdk, context, analysis) === undefined && !knownType(name)) {
				/* 孤立标签及过程参数名称不按一般表达式处理。 */
				if (/^[ \t]*标签[ \t]*$/u.test(prefix) || /(?:^|[ \t])转到[ \t]*$/u.test(prefix)) continue;
				diagnostics.push({ code: "unknownName", start, end, message: `找不到名称“${name}”。` });
			}
		}
	}
	if (property !== undefined && sdk !== undefined) {
		for (const element of collectPropertyXmlElements(property.root, "赋值")) {
			yield;
			const name = getPropertyXmlAttribute(element, "属性");
			if (name !== "基础对象" && name !== "实现接口") continue;
			const value = getPropertyXmlAttribute(element, "值") ?? "";
			for (const match of value.matchAll(/[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*/gu)) {
				if (definitions.has(match[0])) continue;
				const elementPath = findPropertyXmlElementPath(property, element);
				diagnostics.push({ code: "unknownRelation", start: match.index, end: match.index + match[0].length, propertyPath: elementPath === undefined ? undefined : elementPath + "/@值", message: `找不到${name === "基础对象" ? "基础对象" : "实现接口"}“${match[0]}”。` });
			}
		}
	}
	if (sdk !== undefined && context.currentUnit !== undefined && assets !== undefined) {
		const unit: RefactoringUnit = { filePath: context.currentUnit.filePath, sourceRoot: context.currentUnit.sourceRoot, userCode: source, property: { document: property, status: property?.status ?? "valid", issues: property?.issues ?? [] } };
		for (const reference of findSimpleAssetReferences(unit, context, sdk, analysis)) {
			yield;
			const value = reference.value;
			if (value.length === 0 || /^(?:[a-z][a-z0-9+.-]*:|\/)/iu.test(value)) continue;
			const resource = /^@([a-z]+)\/([\w.]+)$/u.exec(value);
			const exists = resource === null ? assets.has(value.replace(/\\/gu, "/")) : context.resources?.symbols.some((symbol) => symbol.resourceType === resource[1] && symbol.resourceName === resource[2]);
			if (!exists) diagnostics.push({ ...reference, code: "unknownAsset", message: `找不到资源文件“${value}”。` });
		}
	}
	return diagnostics;
}

/** 同步入口供纯规则调用；编辑器诊断必须使用可让出线程的异步入口。 */
export function analyzeSimpleReferences(source: string, sdk: Sdk | undefined, context: SimpleProjectSemanticContext, property?: SimplePropertyXmlDocument, assets?: ReadonlySet<string>): readonly SimpleReferenceDiagnostic[] {
	const steps = analyzeSimpleReferenceSteps(source, sdk, context, property, assets);
	for (;;) { const next = steps.next(); if (next.done) return next.value; }
}

/** 按时间片扫描单元内部引用；取消返回 undefined，不把半次分析发布为完整结果。 */
export async function analyzeSimpleReferencesAsync(source: string, sdk: Sdk | undefined, context: SimpleProjectSemanticContext, property?: SimplePropertyXmlDocument, assets?: ReadonlySet<string>, cancelled: () => boolean = () => false): Promise<readonly SimpleReferenceDiagnostic[] | undefined> {
	const steps = analyzeSimpleReferenceSteps(source, sdk, context, property, assets);
	let deadline = performance.now() + 8;
	for (;;) {
		if (cancelled()) return undefined;
		const next = steps.next();
		if (next.done) return next.value;
		if (performance.now() < deadline) continue;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		deadline = performance.now() + 8;
	}
}
