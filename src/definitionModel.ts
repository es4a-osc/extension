/*
解析 Simple 标识符的变量、别名、单元及继承成员声明位置。
xhwsd@qq.com 2026-9-1
*/

import {
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
	buildSemanticDefinitionIndex,
	isSimpleAliasName,
	resolveSimpleDefinitionName,
	resolveSimpleNamespaceName,
	isStaticProjectMember,
	type SimpleProjectSemanticContext
} from "./simpleUnitSymbols";
import {
	libraryDefinitionTarget,
	libraryMemberTarget,
	type LibrarySymbolTarget
} from "./librarySymbol";
import { findCallableArgumentCount } from "./signatures";
import { isSimpleIgnoredOffset } from "./simpleSourceLexical";

const IDENTIFIER_CHARACTER = /[\p{L}\p{N}_]/u;

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

/** 返回光标所在标识符范围；名称末尾的插入位置仍属于紧邻左侧的名称。 */
function identifierRange(
	source: string,
	offset: number
): { readonly end: number; readonly name: string; readonly start: number } | undefined {
	const actualOffset = IDENTIFIER_CHARACTER.test(source[offset] ?? "") ? offset : offset - 1;
	if (actualOffset < 0 || !IDENTIFIER_CHARACTER.test(source[actualOffset] ?? "")) {
		return undefined;
	}

	let start = actualOffset;
	let end = actualOffset + 1;
	while (start > 0 && IDENTIFIER_CHARACTER.test(source[start - 1] ?? "")) {
		start -= 1;
	}
	while (end < source.length && IDENTIFIER_CHARACTER.test(source[end] ?? "")) {
		end += 1;
	}
	return { end, name: source.slice(start, end), start };
}

/** 读取包含当前标识符的点号链，允许点号两侧空白，保留原文范围而统一解析名称。 */
function qualifiedNameAt(
	source: string,
	start: number,
	end: number
): { readonly end: number; readonly name: string; readonly start: number } {
	let qualifiedStart = start;
	let qualifiedEnd = end;
	while (qualifiedStart > 0) {
		let cursor = qualifiedStart;
		while (cursor > 0 && /[ \t]/u.test(source[cursor - 1]!)) cursor -= 1;
		if (source[cursor - 1] !== ".") break;
		cursor -= 1;
		while (cursor > 0 && /[ \t]/u.test(source[cursor - 1]!)) cursor -= 1;
		const end = cursor;
		while (cursor > 0 && IDENTIFIER_CHARACTER.test(source[cursor - 1]!)) cursor -= 1;
		if (cursor === end) break;
		qualifiedStart = cursor;
	}
	while (qualifiedEnd < source.length) {
		let cursor = qualifiedEnd;
		while (cursor < source.length && /[ \t]/u.test(source[cursor]!)) cursor += 1;
		if (source[cursor] !== ".") break;
		cursor += 1;
		while (cursor < source.length && /[ \t]/u.test(source[cursor]!)) cursor += 1;
		const start = cursor;
		while (cursor < source.length && IDENTIFIER_CHARACTER.test(source[cursor]!)) cursor += 1;
		if (cursor === start) break;
		qualifiedEnd = cursor;
	}
	return {
		end: qualifiedEnd,
		name: source.slice(qualifiedStart, qualifiedEnd).replace(/[ \t]/gu, ""),
		start: qualifiedStart
	};
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
		if (access !== undefined) {
			const staticMember = group === "constants"
				|| value.member.global === true
				|| isStaticProjectMember(value.member);
			if ((access === "static") !== staticMember) {
				continue;
			}
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
	if (range === undefined || isSimpleIgnoredOffset(source, range.start, true)) {
		return undefined;
	}
	const qualified = qualifiedNameAt(source, range.start, range.end);
	const qualifier = qualified.start === range.start ? undefined : source.slice(qualified.start, range.start).replace(/[ \t]/gu, "").slice(0, -1);
	/* R 成员直接定位 res 中的首个真实来源，不依赖构建目录或 R.txt。 */
	if (qualifier === "R" && resolveSimpleBinding(source, range.start, "R", context, analysis) === undefined) {
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

	const definitions = analysis?.definitions ?? buildSemanticDefinitionIndex(sdk, context);
	const callArity = findCallableArgumentCount(source, range.end);
	if (qualifier !== undefined) {
		const resolved = resolveSimpleQualifier(source, range.start, qualifier, sdk, context, analysis);
		if (resolved !== undefined) {
			return effectiveMemberTarget(
				resolved.reference,
				resolved.access === "static"
					? ["constants", "variables", "functions"]
					: ["variables", "properties", "functions", "events"],
				range.name,
				definitions,
				range,
				resolved.access,
				callArity
			);
		}
	}

	const binding = qualifier === undefined ? resolveSimpleBinding(source, range.start, range.name, context, analysis) : undefined;
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
	if (qualifier !== undefined && resolveSimpleBinding(source, qualified.start, root, context, analysis) !== undefined) return undefined;
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
