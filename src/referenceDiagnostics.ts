/*
按当前语义上下文报告未解析的名称、类型、成员及资源引用，不替代编译器诊断。
xhwsd@qq.com 2026-10-10
*/

import { buildLanguageTokenRules } from "./compilerTokens";
import { createSimpleSourceAnalysis, isSimpleResourceRoot, resolveSimpleBinding, resolveSimpleQualifier } from "./completionModel";
import { findSimpleDefinition } from "./definitionModel";
import { resolveSimpleDefinitionName, type SimpleProjectSemanticContext } from "./simpleUnitSymbols";
import { collectPropertyXmlElements, findPropertyXmlElementPath, getPropertyXmlAttribute, type SimplePropertyXmlDocument } from "./propertyXml";
import { findSimpleAssetReferences, type RefactoringUnit } from "./refactoringModel";
import type { Sdk } from "./sdk";
import { isSimpleIdentifier, scanSimpleSource, simpleSourceStatements, type SimpleSourceToken } from "./simpleSourceLexical";
import { isSimpleEventTarget } from "./simpleSourceSyntax";

export interface SimpleReferenceDiagnostic {
	readonly code: "unknownName" | "unknownType" | "unknownMember" | "unknownResource" | "unknownRelation" | "unknownAsset";
	readonly message: string;
	readonly start: number;
	readonly end: number;
	readonly propertyPath?: string;
}

/** 用户代码和 XML 值共用完整令牌的限定名，不在正则中维护另一套标识符规则。 */
function* qualifiedNames(tokens: readonly SimpleSourceToken[]): Generator<readonly SimpleSourceToken[]> {
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (token.kind !== "word" || !isSimpleIdentifier(token.text)) continue;
		const parts = [token];
		while (tokens[index + 1]?.text === "." && tokens[index + 2]?.kind === "word" && isSimpleIdentifier(tokens[index + 2]!.text)) {
			index += 2;
			parts.push(tokens[index]!);
		}
		yield parts;
	}
}

/** 只分析用户代码及 XML 模型；没有 SDK 时不把 SDK 名称误报为无效变量。 */
function* analyzeSimpleReferenceSteps(source: string, sdk: Sdk | undefined, context: SimpleProjectSemanticContext, property?: SimplePropertyXmlDocument, assets?: ReadonlySet<string>): Generator<void, readonly SimpleReferenceDiagnostic[]> {
	const diagnostics: SimpleReferenceDiagnostic[] = [];
	const analysis = createSimpleSourceAnalysis(source, sdk, context);
	const definitions = analysis.definitions;
	const rules = buildLanguageTokenRules();
	const compilerNames = new Set(rules.map((rule) => rule.text));
	const compilerTypes = new Set(rules.filter((rule) => rule.type === "type").map((rule) => rule.text));
	const objectEvents = new Set(sdk?.manifests.find((manifest) => manifest.kind === "compiler")
		?.categories.flatMap((category) => category.definitions)
		.find((definition) => definition.kind === "type" && definition.name === "对象")
		?.events?.map((event) => event.name));
	const knownType = (name: string): boolean => compilerTypes.has(name) || resolveSimpleDefinitionName(name, definitions) !== undefined;
	if (sdk !== undefined) {
		for (const statement of simpleSourceStatements(analysis.syntax.tokens)) for (const tokens of qualifiedNames(statement)) {
			yield;
			const start = tokens[0]!.start;
			const end = tokens.at(-1)!.end;
			const parts = tokens.map((token) => token.text);
			const name = parts[0]!;
			const fullName = parts.join(".");
			if (analysis.syntax.declarationAt(start) !== undefined || /^[$@]/u.test(source[start - 1] ?? "")) continue;
			if (analysis.syntax.roleAt(start) === "type") {
				if (!knownType(fullName)) diagnostics.push({ code: "unknownType", start, end, message: `找不到类型“${fullName}”。` });
				continue;
			}
			if (parts.length === 1 && compilerNames.has(name)) continue;
			// 括号、数组元素及调用结果后的成员使用表达式接收者，不能当作独立名称。
			if (analysis.memberAt(start) !== undefined) {
				for (const token of tokens) {
					const access = analysis.memberAt(token.start);
					if (access?.receiver === undefined) break;
					if (access.receiver.reference.manifest.kind === "compiler" && access.receiver.reference.definition.name === "变体型") break;
					if (findSimpleDefinition(source, token.start, sdk, context, analysis) !== undefined) continue;
					diagnostics.push({ code: "unknownMember", start: token.start, end: token.end, message: `“${access.receiver.reference.definition.name}”没有成员“${token.text}”。` });
					break;
				}
				continue;
			}
			if (parts.length > 1) {
				const member = parts[parts.length - 1]!;
				const memberStart = tokens.at(-1)!.start;
				/* 编译器先识别当前单元的加载／初始化处理器，不按根组件或静态成员查找。仅声明行适用。 */
				const declaration = analysis.syntax.declarationAt(memberStart);
				if (parts.length === 2 && name === context.currentUnit?.name && objectEvents.has(member)
					&& declaration?.kind === "event" && declaration.owner === name) continue;
				if (name === "R" && parts.length === 2 && isSimpleResourceRoot(analysis, start, context)) {
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
			} else if (findSimpleDefinition(source, start, sdk, context, analysis) === undefined && (isSimpleEventTarget(analysis.syntax, start) || !knownType(name))) {
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
			for (const statement of simpleSourceStatements(scanSimpleSource(value))) for (const tokens of qualifiedNames(statement)) {
				const qualifiedName = tokens.map((token) => token.text).join(".");
				if (definitions.has(qualifiedName)) continue;
				const elementPath = findPropertyXmlElementPath(property, element);
				diagnostics.push({ code: "unknownRelation", start: tokens[0]!.start, end: tokens.at(-1)!.end, propertyPath: elementPath === undefined ? undefined : elementPath + "/@值", message: `找不到${name === "基础对象" ? "基础对象" : "实现接口"}“${qualifiedName}”。` });
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
