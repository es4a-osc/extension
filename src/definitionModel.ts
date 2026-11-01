/*
解析 Simple 标识符的变量、别名、单元及继承成员声明位置。
xhwsd@qq.com 2026-9-1
*/

import {
	createSimpleSourceAnalysis,
	isSimpleResourceRoot,
	resolveSimpleBinding,
	resolveSimpleQualifier,
	type SimpleSourceAnalysis
} from "./completionModel";
import {
	getEffectiveMembers,
	type LibraryDefinitionReference,
	type LibraryMember,
	type LibraryMemberGroup,
	type Sdk
} from "./sdk";
import {
	isSimpleMemberAccessible,
	isSimpleAliasName,
	resolveSimpleDefinitionName,
	resolveSimpleNamespaceName,
	type SimpleProjectSemanticContext
} from "./simpleUnitSymbols";
import {
	libraryDefinitionTarget,
	libraryMemberTarget,
	type LibrarySymbolTarget
} from "./librarySymbol";
import { findCallableArgumentCount } from "./signatures";
import { isSimpleEventTarget } from "./simpleSourceSyntax";
import { simpleIdentifierRange as identifierRange, simpleSourceTokenIndex, type SimpleSourceToken } from "./simpleSourceLexical";


/** 编辑器适配层可直接转换为目标位置的一次定义解析结果。 */
export interface SimpleDefinitionTarget {
	readonly symbolKind?: "alias" | "unit" | "member" | "binding";
	readonly end: number;
	readonly filePath?: string;
	readonly librarySymbol?: LibrarySymbolTarget;
	readonly memberGroup?: LibraryMemberGroup;
	readonly name: string;
	readonly propertySource?: boolean;
	readonly resourceSource?: boolean;
	readonly start: number;
	readonly targetLine?: number;
	readonly targetOffset?: number;
}

/** 读取包含当前标识符的点号链，允许点号两侧空白，保留原文范围而统一解析名称。 */
function qualifiedNameAt(tokens: readonly SimpleSourceToken[], start: number, end: number): { readonly end: number; readonly name: string; readonly start: number; readonly qualifier?: string } {
	const index = simpleSourceTokenIndex(tokens, start);
	let first = index;
	const last = index;
	while (tokens[first - 1]?.text === "." && tokens[first - 2]?.kind === "word") first -= 2;
	// 查询类型段时只解析截至光标的前缀，右侧成员不属于该类型的限定名。
	return { start: tokens[first]?.start ?? start, end: tokens[last]?.end ?? end,
		name: tokens.slice(first, last + 1).map((token) => token.text).join(""),
		qualifier: first === index ? undefined : tokens.slice(first, index - 1).map((token) => token.text).join("") };
}

/** 从清单扩展字段读取项目源码路径。 */
function definitionSourceFile(reference: LibraryDefinitionReference): string | undefined {
	const sourceFile = reference.definition.sourceFile;
	return typeof sourceFile === "string" && sourceFile.length > 0 ? sourceFile : undefined;
}

/** 把项目单元定义转换为跳转目标。 */
function definitionTarget(
	reference: LibraryDefinitionReference,
	origin: { readonly end: number; readonly name: string; readonly start: number }
): SimpleDefinitionTarget | undefined {
	const filePath = definitionSourceFile(reference);
	if (filePath === undefined) {
		return reference.manifest.kind === "runtime" || reference.manifest.kind === "library"
			? { ...origin, librarySymbol: libraryDefinitionTarget(reference) }
			: undefined;
	}
	return {
		...origin,
		filePath,
		symbolKind: "unit",
		targetLine: 0
	};
}

/** 把项目成员及其实际声明单元转换为跳转目标。 */
function memberTarget(
	member: LibraryMember,
	owner: LibraryDefinitionReference,
	group: LibraryMemberGroup,
	origin: { readonly end: number; readonly name: string; readonly start: number }
): SimpleDefinitionTarget | undefined {
	const filePath = definitionSourceFile(owner);
	const line = member.line;
	if (filePath === undefined) {
		return owner.manifest.kind === "runtime" || owner.manifest.kind === "library"
			? { ...origin, librarySymbol: libraryMemberTarget(owner, group, member), memberGroup: group }
			: undefined;
	}
	if (typeof line !== "number" && member.component !== true) {
		return undefined;
	}
	return {
		...origin,
		filePath,
		symbolKind: "member",
		memberGroup: group,
		propertySource: member.component === true || undefined,
		targetOffset: typeof member.declarationOffset === "number" ? member.declarationOffset : undefined,
		targetLine: typeof line === "number" ? Math.max(0, line - 1) : undefined
	};
}

/** 在继承后的成员集合中查找实际声明来源。 */
function effectiveMemberTarget(
	reference: LibraryDefinitionReference,
	groups: readonly LibraryMemberGroup[],
	name: string,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>,
	origin: { readonly end: number; readonly name: string; readonly start: number },
	access?: "instance" | "static",
	callArity?: number
): SimpleDefinitionTarget | undefined {
	for (const group of groups) {
		const value = getEffectiveMembers(reference, group, definitions).find(
			(candidate) => candidate.member.name === name
				&& (group !== "functions"
					|| callArity === undefined
					|| (candidate.member.params?.length ?? 0) === callArity)
		);
		if (value === undefined) {
			continue;
		}
		if (access !== undefined && !isSimpleMemberAccessible(value.member, group, access)) {
			continue;
		}
		return memberTarget(value.member, value.owner, group, origin);
	}
	return undefined;
}

/** 查找不带类型限定名直接调用的运行库或扩展库全局成员。 */
function globalMemberTarget(
	sdk: Sdk | undefined,
	name: string,
	origin: { readonly end: number; readonly name: string; readonly start: number },
	callArity?: number
): SimpleDefinitionTarget | undefined {
	for (const manifest of sdk?.manifests ?? []) {
		if (manifest.kind === "compiler" || manifest.kind === "project") {
			continue;
		}
		for (const category of manifest.categories) {
			for (const definition of category.definitions) {
				for (const group of ["constants", "variables", "functions"] as const) {
					const member = definition[group]?.find(
						(candidate) => candidate.name === name
							&& candidate.global === true
							&& (group !== "functions"
								|| callArity === undefined
								|| (candidate.params?.length ?? 0) === callArity)
					);
					if (member !== undefined) {
						return memberTarget(member, { definition, manifest }, group, origin);
					}
				}
			}
		}
	}
	return undefined;
}

/**
 * 查找 Simple 标识符的源码声明。
 *
 * 局部绑定和文件别名跳到当前文档；跨单元类型及继承成员跳到实际声明文件。
 */
export function findSimpleDefinition(
	source: string,
	offset: number,
	sdk: Sdk | undefined,
	context?: SimpleProjectSemanticContext,
	analysis?: SimpleSourceAnalysis
): SimpleDefinitionTarget | undefined {
	if (offset < 0 || offset > source.length) {
		return undefined;
	}
	const range = identifierRange(source, offset);
	if (range === undefined) {
		return undefined;
	}
	const current = analysis ?? createSimpleSourceAnalysis(source, sdk, context);
	const lexical = current.syntax.tokens[simpleSourceTokenIndex(current.syntax.tokens, range.start)];
	if (lexical?.kind !== "word" || lexical.start !== range.start || lexical.end !== range.end) {
		return undefined;
	}
	const { qualifier, ...qualified } = qualifiedNameAt(current.expressionTokens, range.start, range.end);
	/* R 成员直接定位 res 中的首个真实来源，不依赖构建目录或 R.txt。 */
	if (qualifier === "R" && isSimpleResourceRoot(current, qualified.start, context)) {
		const resource = context?.resources?.symbols.find((symbol) => symbol.name === range.name);
		const filePath = resource?.sourceFiles[0];
		return filePath === undefined ? undefined : {
			...range,
			filePath,
			resourceSource: true
		};
	}
	const currentUnit = context?.currentUnit;
	if (currentUnit === undefined) {
		return undefined;
	}

	const definitions = current.definitions;
	const callArity = findCallableArgumentCount(source, range.end);
	if (isSimpleEventTarget(current.syntax, range.start)) {
		const owner = definitions.get(currentUnit.qualifiedName);
		return owner === undefined ? undefined : effectiveMemberTarget(owner, ["events"], range.name, definitions, range, "instance");
	}
	const access = current.memberAt(range.start);
	if (access?.receiver !== undefined) {
		return effectiveMemberTarget(access.receiver.reference,
			access.receiver.access === "static" ? ["constants", "variables", "functions"] : ["constants", "variables", "properties", "functions", "events"],
			range.name, current.definitions, range, access.receiver.access, callArity);
	}
	const expressionIndex = simpleSourceTokenIndex(current.expressionTokens, qualified.start);
	if (access !== undefined && (qualifier === undefined || current.expressionTokens[expressionIndex - 1]?.text === ".")) {
		return undefined;
	}
	if (qualifier !== undefined) {
		const resolved = resolveSimpleQualifier(source, range.start, qualifier, sdk, context, current);
		if (resolved !== undefined) {
			return effectiveMemberTarget(
				resolved.reference,
				resolved.access === "static"
					? ["constants", "variables", "functions"]
					: ["constants", "variables", "properties", "functions", "events"],
				range.name,
				definitions,
				range,
				resolved.access,
				callArity
			);
		}
	}

	const binding = qualifier === undefined ? resolveSimpleBinding(source, range.start, range.name, context, current) : undefined;
	if (binding?.declarationStart !== undefined) {
		return {
			...range,
			filePath: currentUnit.filePath,
			symbolKind: "binding",
			targetOffset: binding.declarationStart
		};
	}
	if (binding?.kind === "componentBinding") {
		const component = currentUnit.definition.variables?.find(
			(member) => member.component === true && member.name === binding.name
		);
		const reference = definitions.get(currentUnit.qualifiedName);
		if (component !== undefined && reference !== undefined) {
			return memberTarget(component, reference, "variables", range);
		}
	}

	const alias = qualifier === undefined
		? currentUnit.aliases.find((candidate) => candidate.name === range.name)
		: undefined;
	const aliasDeclaration = /^[ \t]*别名[ \t]*$/u.test(source.slice(source.lastIndexOf("\n", range.start - 1) + 1, range.start));
	if (alias !== undefined && (aliasDeclaration || isSimpleAliasName(alias.name, definitions) || (resolveSimpleDefinitionName(alias.name, definitions) === undefined && resolveSimpleNamespaceName(alias.name, definitions) === undefined))) {
		return {
			...range,
			filePath: currentUnit.filePath,
			symbolKind: "alias",
			targetLine: Math.max(0, alias.line - 1)
		};
	}

	const root = qualified.name.split(".")[0]!;
	if (qualifier !== undefined && resolveSimpleBinding(source, qualified.start, root, context, current) !== undefined) return undefined;
	const definition = resolveSimpleDefinitionName(qualified.name, definitions)
		?? (qualifier === undefined ? resolveSimpleDefinitionName(range.name, definitions) : undefined);
	const target = definition === undefined ? undefined : definitionTarget(definition, qualified);
	if (target !== undefined) {
		return target;
	}
	if (qualifier !== undefined) return undefined;

	const currentReference = definitions.get(currentUnit.qualifiedName);
	const currentMember = currentReference === undefined
		? undefined
		: effectiveMemberTarget(
			currentReference,
			["constants", "variables", "properties", "functions", "events"],
			range.name,
			definitions,
			range,
			undefined,
			callArity
		);
	return currentMember ?? globalMemberTarget(sdk, range.name, range, callArity);
}
