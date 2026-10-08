/*
从编译器、运行库清单和项目源码定位 Simple 标记，并生成编辑器无关的悬停信息。
xhwsd@qq.com 2026-8-27
*/

import * as path from "node:path";
import {
	resolveSimpleBinding,
	resolveSimpleQualifier,
	type SimpleBinding
} from "./completionModel";
import {
	getEffectiveMembers,
	isComponentDefinitionKind,
	type LibraryDefinition,
	type LibraryDefinitionReference,
	type LibraryManifest,
	type LibraryMember,
	type LibraryMemberGroup,
	type Sdk
} from "./sdk";
import {
	buildSemanticDefinitionIndex,
	isStaticProjectMember,
	type SimpleProjectSemanticContext
} from "./simpleUnitSymbols";
import { findAdjacentSimpleDocumentationComment } from "./simpleDocumentation";
import { findPropertySectionStart } from "./simpleUnitSource";
import {
	libraryDefinitionTarget,
	libraryMemberTarget,
	type LibrarySymbolTarget
} from "./librarySymbol";
import { findCallableArgumentCount } from "./signatures";
import { isSimpleIgnoredOffset } from "./simpleSourceLexical";

/** 一个已由清单或项目源码确认的 Simple 语言标记悬停结果。 */
export interface SimpleKeywordHoverInfo {
	/** 对象单元直接声明的基础对象限定名。 */
	readonly baseObject?: string;
	/** 标记所属的清单分类。 */
	readonly category: string;
	/** 面向使用者的标记说明。 */
	readonly description?: string;
	/** 标记结束位置的排他偏移。 */
	readonly end: number;
	/** 继承成员的实际声明类型。 */
	readonly inheritedFrom?: string;
	/** 类型定义从属性 XML 或 SDK 清单声明的直接父类型。 */
	readonly inherits?: readonly string[];
	/** 组件事件处理过程所响应的 SDK 或项目事件完整定义。 */
	readonly eventDefinition?: string;
	/** 属性或变量的初始值。 */
	readonly initializer?: string;
	/** 对象单元直接声明实现的接口限定名。 */
	readonly interfaces?: readonly string[];
	/** 清单中的标记或成员类型。 */
	readonly kind?: string;
	/** 标记所属的清单名称；编译器语言标记不重复显示。 */
	readonly manifest?: string;
	/** 标记实际定义所在的完整单元名或完整类名。 */
	readonly declarationSource?: string;
	/** 实际定义来自项目单元还是 SDK 类库。 */
	readonly declarationSourceKind?: "library" | "project";
	/** 可由编辑器适配层定位到类库树的稳定符号身份。 */
	readonly librarySymbol?: LibrarySymbolTarget;
	/** Simple 源码中的完整标记文本。 */
	readonly name: string;
	/** 成员访问所基于的对象或类型名称。 */
	readonly owner?: string;
	/** SDK 成员中带有说明的参数。 */
	readonly parameters?: readonly {
		readonly description: string;
		readonly name: string;
	}[];
	/** 当前有效成员相对基础对象或接口承担的声明关系。 */
	readonly relations?: readonly SimpleMemberRelation[];
	/** 可直接展示的定义或成员签名。 */
	readonly signature?: string;
	/** 调用参数个数无对应重载时可供用户选择的同名签名。 */
	readonly overloads?: readonly SimpleKeywordHoverInfo[];
	/** 标记开始位置。 */
	readonly start: number;
}

/** 描述当前有效成员对基础对象成员的重写或对接口成员的实现。 */
export interface SimpleMemberRelation {
	/** 当前成员在 Simple 源码中的声明种类。 */
	readonly declaration: "过程" | "函数";
	readonly kind: "implements" | "overrides";
	readonly source: string;
}

/** 编译器清单中可直接悬停的关键字或数据类型。 */
interface CompilerDefinition {
	readonly category: string;
	readonly description?: string;
	readonly kind?: string;
	readonly name: string;
	readonly propertyOnly?: boolean;
}

/** 运行库或类库中可按名称解析的类型定义。 */
interface RuntimeDefinition {
	readonly category: string;
	readonly reference: LibraryDefinitionReference;
}

/** 运行库定义继承后可悬停的成员及其所属类型。 */
interface RuntimeMember {
	readonly category: string;
	readonly group: LibraryMemberGroup;
	readonly member: LibraryMember;
	readonly owner: LibraryDefinitionReference;
}

const IDENTIFIER_CHARACTER = /[\p{L}\p{N}_]/u;

/** 返回光标所在十六进制整数字面量及其精确十进制值。 */
function hexadecimalIntegerHover(source: string, offset: number): SimpleKeywordHoverInfo | undefined {
	const lineStart = source.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
	const lineEndIndex = source.indexOf("\n", offset);
	const lineEnd = lineEndIndex < 0 ? source.length : lineEndIndex;
	const line = source.slice(lineStart, lineEnd);
	const pattern = /&H[0-9A-Fa-f]+/gu;

	for (const match of line.matchAll(pattern)) {
		if (match.index === undefined) continue;
		const start = lineStart + match.index;
		const literal = match[0];
		const end = start + literal.length;
		if (offset < start || offset >= end) continue;

		return {
			category: "整数字面量",
			end,
			kind: "literal",
			name: literal,
			signature: `${literal} = ${BigInt(`0x${literal.slice(2)}`).toString(10)}`,
			start
		};
	}

	return undefined;
}

/** 判断候选文本没有嵌入更长的 Simple 标识符。 */
function hasTokenBoundary(source: string, start: number, name: string): boolean {
	const first = name[0];
	const last = name[name.length - 1];
	const previous = start > 0 ? source[start - 1] : undefined;
	const next = source[start + name.length];

	if (
		first !== undefined
		&& IDENTIFIER_CHARACTER.test(first)
		&& previous !== undefined
		&& IDENTIFIER_CHARACTER.test(previous)
	) {
		return false;
	}

	return !(
		last !== undefined
		&& IDENTIFIER_CHARACTER.test(last)
		&& next !== undefined
		&& IDENTIFIER_CHARACTER.test(next)
	);
}

/** 返回编译器清单中可提供说明的语言标记，长标记优先。 */
function compilerDefinitions(sdk: Sdk): readonly CompilerDefinition[] {
	const compiler = sdk.manifests.find((manifest) => manifest.kind === "compiler");
	if (compiler === undefined) {
		return [];
	}

	const definitions = new Map<string, CompilerDefinition>();

	for (const category of compiler.categories) {
		for (const definition of category.definitions) {
			if (
				definition.name.length === 0
				|| (definition.kind === "punctuation" && definition.hover !== true)
			) {
				continue;
			}

			if (!definitions.has(definition.name)) {
				definitions.set(definition.name, {
					category: category.name,
					description: definition.description,
					kind: definition.kind,
					name: definition.name
				});
			}
			for (const property of definition.properties ?? []) {
				if (!definitions.has(property.name)) {
					definitions.set(property.name, {
						category: category.name,
						description: property.description,
						kind: "properties",
						name: property.name,
						propertyOnly: true
					});
				}
			}
		}
	}

	return [...definitions.values()].sort(
		(left, right) => right.name.length - left.name.length
	);
}

/** 按名称建立运行库定义索引，并保留清单分类。 */
function runtimeDefinitions(
	sdk: Sdk | undefined,
	context: SimpleProjectSemanticContext | undefined
): ReadonlyMap<string, RuntimeDefinition> {
	const definitions = new Map<string, RuntimeDefinition>();

	for (const [name, reference] of buildSemanticDefinitionIndex(sdk, context)) {
		if (reference.manifest.kind === "compiler") {
			continue;
		}

		if (!definitions.has(name)) {
			definitions.set(name, {
				category: runtimeCategory(reference.manifest, reference.definition),
				reference
			});
		}
	}
	for (const manifest of sdk?.manifests ?? []) {
		if (manifest.kind === "compiler") {
			continue;
		}
		for (const category of manifest.categories) {
			for (const definition of category.definitions) {
				const typeName = definition.type?.trim();
				if (typeName !== undefined && typeName.length > 0 && !definitions.has(typeName)) {
					definitions.set(typeName, {
						category: runtimeCategory(manifest, definition),
						reference: { definition, manifest }
					});
				}
			}
		}
	}

	return definitions;
}

/** 从标记前读取可带空白的点号限定名。 */
function qualifierBefore(source: string, start: number): string | undefined {
	let cursor = start;

	while (cursor > 0 && /[ \t]/u.test(source[cursor - 1] ?? "")) {
		cursor -= 1;
	}

	if (source[cursor - 1] !== ".") {
		return undefined;
	}

	cursor -= 1;
	while (cursor > 0 && /[ \t]/u.test(source[cursor - 1] ?? "")) {
		cursor -= 1;
	}

	const end = cursor;
	while (
		cursor > 0
		&& (IDENTIFIER_CHARACTER.test(source[cursor - 1] ?? "") || source[cursor - 1] === ".")
	) {
		cursor -= 1;
	}

	return cursor === end ? undefined : source.slice(cursor, end);
}

/** 返回光标所在的完整 Simple 标识符范围。 */
function identifierRange(
	source: string,
	offset: number
): { readonly end: number; readonly name: string; readonly start: number } | undefined {
	if (!IDENTIFIER_CHARACTER.test(source[offset] ?? "")) {
		return undefined;
	}

	let start = offset;
	let end = offset + 1;

	while (start > 0 && IDENTIFIER_CHARACTER.test(source[start - 1] ?? "")) {
		start -= 1;
	}

	while (end < source.length && IDENTIFIER_CHARACTER.test(source[end] ?? "")) {
		end += 1;
	}

	return { end, name: source.slice(start, end), start };
}

/** 返回当前项目由 res 目录推导出的 R 对象或资源常量悬停。 */
function projectResourceHover(
	source: string,
	offset: number,
	context: SimpleProjectSemanticContext | undefined
): SimpleKeywordHoverInfo | undefined {
	const range = identifierRange(source, offset);
	if (context === undefined || range === undefined) {
		return undefined;
	}
	const resources = context.resources;
	if (resources === undefined) {
		return undefined;
	}

	if (range.name === "R") {
		let cursor = range.end;
		while (cursor < source.length && /[ \t]/u.test(source[cursor] ?? "")) {
			cursor += 1;
		}
		if (source[cursor] !== ".") {
			return undefined;
		}
		cursor += 1;
		while (cursor < source.length && /[ \t]/u.test(source[cursor] ?? "")) {
			cursor += 1;
		}
		const memberStart = cursor;
		while (cursor < source.length && IDENTIFIER_CHARACTER.test(source[cursor] ?? "")) {
			cursor += 1;
		}
		const memberName = source.slice(memberStart, cursor);
		if (!resources.symbols.some((candidate) => candidate.name === memberName)) {
			return undefined;
		}
		return {
			category: "项目资源",
			declarationSource: resources.objectQualifiedName,
			declarationSourceKind: "project",
			description: "当前项目根据 res 目录识别出的 Android 资源索引。",
			end: range.end,
			kind: "object",
			manifest: context.manifest.name,
			name: "R",
			signature: "对象 R",
			start: range.start
		};
	}

	if (qualifierBefore(source, range.start) !== "R") {
		return undefined;
	}
	const symbol = resources.symbols.find((candidate) => candidate.name === range.name);
	if (symbol === undefined) {
		return undefined;
	}
	const sourceFiles = symbol.sourceFiles.map((filePath) => (
		path.relative(resources.projectDirectory, filePath).split(path.sep).join("/")
	));
	return {
		category: "项目资源",
		declarationSource: resources.objectQualifiedName,
		declarationSourceKind: "project",
		description: [
			`Android ${symbol.resourceType} 资源。`,
			"",
			...sourceFiles.map((filePath) => `来源文件：${filePath}`)
		].join("\n"),
		end: range.end,
		kind: "constants",
		manifest: context.manifest.name,
		name: symbol.name,
		owner: "R",
		signature: `常量 R.${symbol.name} 为 整数型`,
		start: range.start
	};
}

/** 判断当前成员标记是否位于用户源码的事件处理器定义行。 */
function isSourceEventDeclaration(
	source: string,
	start: number,
	qualifier: string,
	name: string
): boolean {
	const lineStart = source.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
	const lineEndIndex = source.indexOf("\n", start);
	const lineEnd = lineEndIndex < 0 ? source.length : lineEndIndex;
	const escapedQualifier = qualifier.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	return new RegExp(
		`^[ \\t]*事件[ \\t]+${escapedQualifier}[ \\t]*\\.[ \\t]*${escapedName}[ \\t]*\\(`,
		"u"
	).test(source.slice(lineStart, lineEnd));
}

/** 将成员参数格式化为 Simple 源码风格。 */
function formatParameters(member: LibraryMember): string {
	return (member.params ?? []).map((parameter) => {
		const passing = parameter.passing ?? (parameter.byRef === true ? "传址" : undefined);
		const type = parameter.type === undefined ? "" : ` 为 ${parameter.type}`;
		return `${passing === undefined ? "" : `${passing} `}${parameter.name}${type}`;
	}).join(", ");
}

/** 构造运行库成员的完整显示签名。 */
function memberSignature(member: LibraryMember, group: LibraryMemberGroup): string {
	if (group === "functions" || group === "events") {
		const returnType = group === "functions" && member.return !== undefined
			? ` 为 ${member.return}`
			: "";
		const declaration = group === "events"
			? "事件"
			: member.return === undefined ? "过程" : "函数";
		const modifier = isStaticProjectMember(member) ? "静态 " : "";
		return `${modifier}${declaration} ${member.name}(${formatParameters(member)})${returnType}`;
	}

	const type = member.type === undefined ? "" : ` 为 ${member.type}`;
	const value = member.value === undefined ? "" : ` = ${member.value}`;
	const declarations: Readonly<Record<Exclude<LibraryMemberGroup, "events" | "functions">, string>> = {
		constants: "常量 ",
		properties: "属性 ",
		variables: member.component === true
			? "组件 "
			: isStaticProjectMember(member) ? "静态 变量 " : "变量 "
	};
	const declaration = declarations[group];
	return `${declaration}${member.name}${type}${value}`;
}

/** 构造类型或项目单元的简洁声明签名。 */
function definitionSignature(entry: RuntimeDefinition): string {
	const definition = entry.reference.definition;
	const unitType = typeof definition.unitType === "string" ? definition.unitType : undefined;
	const declaration = unitType ?? (() => {
		switch (definition.kind) {
			case "error":
			case "object":
				return "对象";
			case "interface":
				return "接口";
			case "layout":
				return "布局";
			default:
				return isComponentDefinitionKind(definition.kind) ? "组件" : undefined;
		}
	})();
	const displayName = entry.reference.manifest.kind === "project"
		? typeof definition.unitName === "string" ? definition.unitName : definition.name
		: definition.name;
	return declaration === undefined ? displayName : `${declaration} ${displayName}`;
}

/** 返回定义在来源行中使用的完整单元名或完整类名。 */
function declarationSource(reference: LibraryDefinitionReference): string {
	if (reference.manifest.kind === "project") {
		return reference.definition.name;
	}

	const typeName = typeof reference.definition.type === "string"
		? reference.definition.type.trim()
		: "";
	return typeName.length > 0 ? typeName : reference.definition.name;
}

/** 判断两个过程或函数成员是否代表同一个可重写或实现的重载。 */
function sameCallableSignature(left: LibraryMember, right: LibraryMember): boolean {
	return left.name === right.name
		&& (left.params?.length ?? 0) === (right.params?.length ?? 0);
}

/** 返回定义直接继承的基础对象；接口父级不参与对象重写链。 */
function directBaseReference(
	reference: LibraryDefinitionReference,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): LibraryDefinitionReference | undefined {
	const explicit = reference.definition.baseObject;
	if (typeof explicit === "string" && explicit.length > 0) {
		return definitions.get(explicit);
	}

	const directInterfaces = new Set(reference.definition.interfaces ?? []);
	for (const name of reference.definition.inherits ?? []) {
		if (directInterfaces.has(name)) {
			continue;
		}
		const parent = definitions.get(name);
		if (parent !== undefined && parent.definition.kind !== "interface") {
			return parent;
		}
	}

	return undefined;
}

/** 收集对象当前声明直接实现的接口，不把基础对象的接口重复带入页脚。 */
function directInterfaces(
	reference: LibraryDefinitionReference,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): readonly LibraryDefinitionReference[] {
	const names = new Set([
		...(reference.definition.interfaces ?? []),
		...(reference.definition.inherits ?? []).filter(
			(name) => definitions.get(name)?.definition.kind === "interface"
		)
	]);
	return [...names].flatMap((name) => {
		const implemented = definitions.get(name);
		return implemented?.definition.kind === "interface" ? [implemented] : [];
	});
}

/** 解析当前有效过程或函数承担的基础对象重写及接口实现关系。 */
function memberRelations(
	accessReference: LibraryDefinitionReference,
	declaringReference: LibraryDefinitionReference,
	member: LibraryMember,
	group: LibraryMemberGroup,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): readonly SimpleMemberRelation[] {
	if (group !== "functions" || accessReference.definition.kind === "interface") {
		return [];
	}

	const relations: SimpleMemberRelation[] = [];
	const sources = new Set<string>();
	const add = (kind: SimpleMemberRelation["kind"], owner: LibraryDefinitionReference): void => {
		const source = `${declarationSource(owner)}.${member.name}(${formatParameters(member)})`;
		const key = `${kind}:${source}`;
		if (!sources.has(key)) {
			sources.add(key);
			relations.push({
				declaration: member.return === undefined ? "过程" : "函数",
				kind,
				source
			});
		}
	};

	if (declaringReference.definition === accessReference.definition) {
		let base = directBaseReference(accessReference, definitions);
		const visited = new Set<string>();
		while (base !== undefined && !visited.has(base.definition.name)) {
			visited.add(base.definition.name);
			if (base.definition.functions?.some((candidate) => sameCallableSignature(member, candidate))) {
				add("overrides", base);
				break;
			}
			base = directBaseReference(base, definitions);
		}
	}

	for (const implemented of directInterfaces(accessReference, definitions)) {
		const contract = getEffectiveMembers(implemented, "functions", definitions).find(
			(candidate) => sameCallableSignature(member, candidate.member)
		);
		if (contract !== undefined) {
			add("implements", contract.owner);
		}
	}

	return relations;
}

/** 从有效成员中查找指定名称，并保留实际声明来源。 */
function findEffectiveMember(
	reference: LibraryDefinitionReference,
	groups: readonly LibraryMemberGroup[],
	name: string,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>,
	filter?: (member: LibraryMember, group: LibraryMemberGroup) => boolean,
	callArity?: number
): RuntimeMember | undefined {
	for (const group of groups) {
		const value = getEffectiveMembers(reference, group, definitions).find(
			(candidate) => candidate.member.name === name
				&& (group !== "functions"
					|| callArity === undefined
					|| (candidate.member.params?.length ?? 0) === callArity)
				&& (filter?.(candidate.member, group) ?? true)
		);

		if (value !== undefined) {
			return {
				category: runtimeCategory(reference.manifest, reference.definition),
				group,
				member: value.member,
				owner: value.owner
			};
		}
	}

	return undefined;
}

/** 实参数量不匹配时，保留同一类型及访问方式下的全部函数重载。 */
function findFunctionOverloads(
	reference: LibraryDefinitionReference,
	name: string,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>,
	filter?: (member: LibraryMember, group: LibraryMemberGroup) => boolean
): RuntimeMember[] {
	return getEffectiveMembers(reference, "functions", definitions)
		.filter((candidate) => candidate.member.name === name
			&& (filter?.(candidate.member, "functions") ?? true))
		.map((candidate) => ({
			category: runtimeCategory(reference.manifest, reference.definition),
			group: "functions",
			member: candidate.member,
			owner: candidate.owner
		}));
}

/** 单个候选显示完整说明；多个候选按参数个数排列，避免猜测错误调用的目标重载。 */
function runtimeOverloadHover(
	candidates: readonly RuntimeMember[],
	definitions: ReadonlyMap<string, LibraryDefinitionReference>,
	start: number,
	end: number,
	accessReference?: LibraryDefinitionReference
): SimpleKeywordHoverInfo | undefined {
	const hovers = [...candidates]
		.sort((left, right) => (left.member.params?.length ?? 0) - (right.member.params?.length ?? 0))
		.map((candidate) => runtimeMemberHover(
			candidate,
			accessReference ?? candidate.owner,
			definitions,
			start,
			end
		));
	const first = hovers[0];
	return first === undefined ? undefined : hovers.length === 1
		? first
		: { ...first, overloads: hovers };
}

/** 查找定义在所属运行库清单中的分类名称。 */
function runtimeCategory(manifest: LibraryManifest, definition: LibraryDefinition): string {
	return manifest.categories.find((category) => category.definitions.includes(definition))?.name ?? "运行库";
}

/** 将运行库定义转换为统一悬停结果。 */
function runtimeDefinitionHover(
	entry: RuntimeDefinition,
	start: number,
	end: number,
	name: string = entry.reference.definition.name
): SimpleKeywordHoverInfo {
	const definition = entry.reference.definition;
	const objectUnit = definition.unitType === "对象";
	return {
		...(objectUnit && typeof definition.baseObject === "string" && definition.baseObject.length > 0
			? { baseObject: definition.baseObject }
			: {}),
		category: entry.category,
		declarationSource: declarationSource(entry.reference),
		declarationSourceKind: entry.reference.manifest.kind === "project" ? "project" : "library",
		description: definition.description,
		end,
		inherits: definition.inherits,
		...(objectUnit && Array.isArray(definition.interfaces) && definition.interfaces.length > 0
			? { interfaces: definition.interfaces }
			: {}),
		kind: definition.kind,
		...(entry.reference.manifest.kind === "runtime" || entry.reference.manifest.kind === "library"
			? { librarySymbol: libraryDefinitionTarget(entry.reference) }
			: {}),
		manifest: entry.reference.manifest.name,
		name,
		signature: definitionSignature(entry),
		start
	};
}

/** 将运行库成员转换为统一悬停结果。 */
function runtimeMemberHover(
	member: RuntimeMember,
	accessReference: LibraryDefinitionReference,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>,
	start: number,
	end: number
): SimpleKeywordHoverInfo {
	const relations = memberRelations(
		accessReference,
		member.owner,
		member.member,
		member.group,
		definitions
	);
	return {
		category: member.category,
		declarationSource: declarationSource(member.owner),
		declarationSourceKind: member.owner.manifest.kind === "project" ? "project" : "library",
		description: member.member.description,
		end,
		inheritedFrom: member.owner.definition.name === accessReference.definition.name
			? undefined
			: member.owner.definition.name,
		initializer: member.member.initializer?.value,
		kind: member.group === "variables" && isStaticProjectMember(member.member)
			? "staticVariable"
			: member.group,
		...(member.owner.manifest.kind === "runtime" || member.owner.manifest.kind === "library"
			? { librarySymbol: libraryMemberTarget(member.owner, member.group, member.member) }
			: {}),
		manifest: member.owner.manifest.name,
		name: member.member.name,
		owner: accessReference.definition.name,
		...(member.owner.manifest.kind === "project"
			? {}
			: {
				parameters: (member.member.params ?? []).flatMap((parameter) => (
					typeof parameter.description === "string" && parameter.description.length > 0
						? [{ description: parameter.description, name: parameter.name }]
						: []
				))
			}),
		...(relations.length === 0 ? {} : { relations }),
		signature: memberSignature(member.member, member.group),
		start
	};
}

/** 将当前文档中已确认类型的绑定转换为悬停结果。 */
function sourceBindingHover(
	binding: SimpleBinding,
	source: string,
	start: number,
	end: number,
	context: SimpleProjectSemanticContext | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): SimpleKeywordHoverInfo {
	const projectMember = binding.kind === "functionResult"
		? context?.currentUnit?.definition.functions?.find((member) => (
			member.name === binding.name
			&& (binding.declarationStart === undefined
				|| findCallableArgumentCount(
					source,
					binding.declarationStart + binding.name.length
				) === (member.params?.length ?? 0))
		))
		: undefined;
	if (projectMember !== undefined) {
		const currentReference = context?.currentUnit === undefined
			? undefined
			: definitions.get(context.currentUnit.qualifiedName);
		const relations = currentReference === undefined
			? []
			: memberRelations(
				currentReference,
				currentReference,
				projectMember,
				"functions",
				definitions
			);
		return {
			category: "当前文档",
			declarationSource: context?.currentUnit?.qualifiedName,
			declarationSourceKind: "project",
			description: projectMember.description,
			end,
			kind: "functions",
			manifest: context?.manifest.name,
			name: binding.name,
			...(relations.length === 0 ? {} : { relations }),
			signature: memberSignature(projectMember, "functions"),
			start
		};
	}

	const typeDescription = binding.declaredTypeName === undefined
		? binding.typeName
		: `${binding.declaredTypeName}（当前收窄为 ${binding.typeName}）`;
	const passing = binding.passing === undefined ? "" : `${binding.passing} `;
	const signatures: Readonly<Record<SimpleBinding["kind"], string>> = {
		componentBinding: `组件 ${binding.name} 为 ${typeDescription}`,
		field: `变量 ${binding.name} 为 ${typeDescription}`,
		functionResult: `函数返回值 ${binding.name} 为 ${typeDescription}`,
		parameter: `${passing}${binding.name} 为 ${typeDescription}`,
		staticField: `静态 变量 ${binding.name} 为 ${typeDescription}`,
		variable: `变量 ${binding.name} 为 ${typeDescription}`
	};
	return {
		category: "当前文档",
		declarationSource: context?.currentUnit?.qualifiedName,
		declarationSourceKind: "project",
		description: binding.kind === "parameter" || binding.declarationStart === undefined
			? undefined
			: findAdjacentSimpleDocumentationComment(source, binding.declarationStart),
		end,
		kind: binding.kind === "staticField" ? "staticVariable" : binding.kind,
		manifest: context?.manifest.name,
		name: binding.name,
		signature: signatures[binding.kind],
		start
	};
}

/**
 * 查找光标所在的运行库定义、静态成员、实例成员或全局成员。
 *
 * 点号成员必须能从限定类型或当前文档绑定中解析；未知限定名不回退全库。
 */
function findRuntimeHover(
	source: string,
	offset: number,
	sdk: Sdk | undefined,
	context?: SimpleProjectSemanticContext
): SimpleKeywordHoverInfo | undefined {
	const range = identifierRange(source, offset);
	if (range === undefined) {
		return undefined;
	}

	const entries = runtimeDefinitions(sdk, context);
	const references = new Map(
		[...entries].map(([name, entry]) => [name, entry.reference])
	);
	const qualifier = qualifierBefore(source, range.start);
	const callArity = findCallableArgumentCount(source, range.end);

	if (qualifier !== undefined) {
		const currentUnit = context?.currentUnit;
		if (
			currentUnit !== undefined
			&& (qualifier === currentUnit.name || qualifier === currentUnit.qualifiedName)
			&& isSourceEventDeclaration(source, range.start, qualifier, range.name)
			&& currentUnit.definition.events?.some((event) => event.name === range.name)
		) {
			const objectEvent = sdk?.manifests.find((manifest) => manifest.kind === "compiler")
				?.categories.flatMap((category) => category.definitions)
				.find((definition) => definition.name === "对象" && definition.kind === "type")
				?.events?.find((event) => event.name === range.name);
			const currentReference = entries.get(currentUnit.qualifiedName)?.reference;
			const member = currentReference === undefined || objectEvent === undefined
				? undefined
				: findEffectiveMember(currentReference, ["events"], range.name, references);
			if (member !== undefined && currentReference !== undefined && objectEvent !== undefined && context !== undefined) {
				const result = runtimeMemberHover(member, currentReference, references, range.start, range.end);
				return {
					...result,
					// 根组件可能与当前单元同名；声明行仍属于编译器的对象事件。
					description: findAdjacentSimpleDocumentationComment(source, range.start)
						?? objectEvent.description ?? result.description,
					declarationSource: currentUnit.qualifiedName,
					declarationSourceKind: "project",
					manifest: context.manifest.name,
					signature: `事件 ${qualifier}.${member.member.name}(${formatParameters(member.member)})`
				};
			}
		}

		const resolved = resolveSimpleQualifier(source, range.start, qualifier, sdk, context);

		if (resolved === undefined) {
			const qualifiedName = `${qualifier}.${range.name}`;
			const qualifiedDefinition = entries.get(qualifiedName);
			return qualifiedDefinition === undefined
				? undefined
				: runtimeDefinitionHover(
					qualifiedDefinition,
					range.start - qualifier.length - 1,
					range.end,
					qualifiedName
				);
		}

		const reference = resolved.reference;
		const staticFilter = (candidate: LibraryMember, group: LibraryMemberGroup) => group === "constants"
			|| candidate.global === true
			|| isStaticProjectMember(candidate);
		const instanceFilter = (candidate: LibraryMember, group: LibraryMemberGroup) => (
			(group !== "functions" || candidate.global !== true)
			&& !isStaticProjectMember(candidate)
		);
		const memberForAccess = resolved.access === "static"
			? findEffectiveMember(
				reference,
				["constants", "variables", "functions"],
				range.name,
				references,
				staticFilter,
				callArity
			)
			: findEffectiveMember(
				reference,
				["properties", "variables", "functions", "events"],
				range.name,
				references,
				instanceFilter,
				callArity
			);
		const member = memberForAccess ?? (resolved.directCurrentUnit && resolved.access === "instance"
			? findEffectiveMember(
				reference,
				["constants", "variables", "functions"],
				range.name,
				references,
				staticFilter,
				callArity
			)
			: undefined);

		if (member === undefined) {
			const overloads = findFunctionOverloads(
				reference,
				range.name,
				references,
				resolved.access === "static" ? staticFilter : instanceFilter
			);
			if (overloads.length === 0 && resolved.directCurrentUnit && resolved.access === "instance") {
				overloads.push(...findFunctionOverloads(reference, range.name, references, staticFilter));
			}
			return runtimeOverloadHover(overloads, references, range.start, range.end, reference);
		}

		const result = runtimeMemberHover(member, reference, references, range.start, range.end);
		if (
			member.group === "events"
			&& isSourceEventDeclaration(source, range.start, qualifier, range.name)
			&& context?.currentUnit !== undefined
		) {
			const sourceDescription = findAdjacentSimpleDocumentationComment(source, range.start);
			return {
				...result,
				declarationSource: context.currentUnit.qualifiedName,
				declarationSourceKind: "project",
				description: sourceDescription ?? result.description,
				...(resolved.directCurrentUnit
					? {}
					: {
						eventDefinition: `${result.declarationSource}.${member.member.name}(${formatParameters(member.member)})`
					}),
				manifest: context.manifest.name,
				signature: `事件 ${qualifier}.${member.member.name}(${formatParameters(member.member)})`
			};
		}

		return result;
	}

	const binding = resolveSimpleBinding(source, range.start, range.name, context);
	if (binding !== undefined) {
		return sourceBindingHover(
			binding,
			source,
			range.start,
			range.end,
			context,
			references
		);
	}

	const alias = context?.currentUnit?.aliases.find((candidate) => candidate.name === range.name);
	if (alias !== undefined) {
		return {
			category: "当前文档",
			declarationSource: context?.currentUnit?.qualifiedName,
			declarationSourceKind: "project",
			description: alias.description,
			end: range.end,
			kind: "alias",
			manifest: context?.manifest.name,
			name: alias.name,
			signature: `别名 ${alias.name} = ${alias.target}`,
			start: range.start
		};
	}

	const currentReference = context?.currentUnit === undefined
		? undefined
		: entries.get(context.currentUnit.qualifiedName)?.reference;
	if (currentReference !== undefined) {
		const member = findEffectiveMember(
			currentReference,
			["constants", "variables", "properties", "functions", "events"],
			range.name,
			references,
			undefined,
			callArity
		);
		if (member !== undefined) {
			return runtimeMemberHover(member, currentReference, references, range.start, range.end);
		}
		const overload = runtimeOverloadHover(
			findFunctionOverloads(currentReference, range.name, references),
			references,
			range.start,
			range.end,
			currentReference
		);
		if (overload !== undefined) {
			return overload;
		}
	}

	for (const entry of entries.values()) {
		for (const group of ["constants", "variables", "functions"] as const) {
			const member = entry.reference.definition[group]?.find(
				(candidate) => candidate.name === range.name
					&& candidate.global === true
					&& (group !== "functions"
						|| callArity === undefined
						|| (candidate.params?.length ?? 0) === callArity)
			);

			if (member !== undefined) {
				return runtimeMemberHover({
					category: entry.category,
					group,
					member,
					owner: entry.reference
				}, entry.reference, references, range.start, range.end);
			}
		}
	}
	const seenDefinitions = new Set<LibraryDefinition>();
	const globalOverloads: RuntimeMember[] = [];
	for (const entry of entries.values()) {
		if (seenDefinitions.has(entry.reference.definition)) continue;
		seenDefinitions.add(entry.reference.definition);
		for (const member of entry.reference.definition.functions ?? []) {
			if (member.name !== range.name || member.global !== true) continue;
			globalOverloads.push({
				category: entry.category,
				group: "functions",
				member,
				owner: entry.reference
			});
		}
	}
	const globalOverload = runtimeOverloadHover(globalOverloads, references, range.start, range.end);
	if (globalOverload !== undefined) {
		return globalOverload;
	}

	let definition = entries.get(range.name);
	let definitionName = range.name;
	let definitionStart = range.start;
	if (definition === undefined) {
		let cursor = range.start;
		while (cursor > 0 && source[cursor - 1] === ".") {
			cursor -= 1;
			while (cursor > 0 && IDENTIFIER_CHARACTER.test(source[cursor - 1] ?? "")) {
				cursor -= 1;
			}
			const candidate = source.slice(cursor, range.end);
			const candidateDefinition = entries.get(candidate);
			if (candidateDefinition !== undefined) {
				definition = candidateDefinition;
				definitionName = candidate;
				definitionStart = cursor;
			}
		}
	}
	return definition === undefined
		? undefined
		: runtimeDefinitionHover(definition, definitionStart, range.end, definitionName);
}

/**
 * 查找光标所在的 Simple 编译器语言标记。
 *
 * 注释、字符串和标识符外部不返回悬停；源码符号不依赖 SDK 也可解析。
 */
export function findSimpleKeywordHover(
	source: string,
	offset: number,
	sdk: Sdk | undefined,
	context?: SimpleProjectSemanticContext
): SimpleKeywordHoverInfo | undefined {
	if (offset < 0 || offset >= source.length || isSimpleIgnoredOffset(source, offset, true)) {
		return undefined;
	}
	const hexadecimal = hexadecimalIntegerHover(source, offset);
	if (hexadecimal !== undefined) {
		return hexadecimal;
	}
	const resource = projectResourceHover(source, offset, context);
	if (resource !== undefined) {
		return resource;
	}

	const lineStart = source.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
	const lineEndIndex = source.indexOf("\n", offset);
	const lineEnd = lineEndIndex < 0 ? source.length : lineEndIndex;
	const propertySectionStart = findPropertySectionStart(source);

	for (const entry of sdk === undefined ? [] : compilerDefinitions(sdk)) {
		if (entry.propertyOnly === true && offset < propertySectionStart) {
			continue;
		}
		const name = entry.name;
		let start = source.indexOf(name, Math.max(lineStart, offset - name.length + 1));

		while (start >= 0 && start <= offset && start < lineEnd) {
			const end = start + name.length;
			if (offset < end && end <= lineEnd && hasTokenBoundary(source, start, name)) {
				return {
					category: entry.category,
					description: entry.description,
					end,
					kind: entry.kind,
					name,
					start
				};
			}

			start = source.indexOf(name, start + 1);
		}
	}

	return findRuntimeHover(source, offset, sdk, context);
}
