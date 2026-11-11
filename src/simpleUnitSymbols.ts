/*
从用户代码和属性 XML 建立可供项目级语言能力复用的 Simple 单元符号。
xhwsd@qq.com 2026-8-27
*/

import * as path from "node:path";
import {
	buildDefinitionIndex,
	type LibraryDefinition,
	type LibraryDefinitionReference,
	type LibraryManifest,
	type LibraryMember,
	type LibraryMemberGroup,
	type Sdk
} from "./sdk";
import {
	collectPropertyXmlElements,
	getPropertyXmlAttribute,
	getPropertyXmlChildren,
	getSimplePropertyUnitType,
	inspectSimplePropertyXml,
	type SimplePropertyXmlParseResult,
	type SimpleUnitType
} from "./propertyXml";
import {
	findAdjacentSimpleDocumentationComment,
	findSimpleUnitComment
} from "./simpleDocumentation";
import { splitSimpleUnitSource } from "./simpleUnitSource";
import type { SimpleProjectResourceIndex } from "./simpleResourceSymbols";
import { simpleQualifiedName } from "./simpleProjectPaths";
import { analyzeSimpleSourceSyntax, type SimpleSourceSyntax } from "./simpleSourceSyntax";

/** 当前单元文件内声明的一个符号别名。 */
export interface SimpleAliasSymbol {
	/** 声明正上方紧邻的一行非空注释。 */
	readonly description?: string;
	/** 别名声明所在的用户代码行，从 1 开始。 */
	readonly line: number;
	readonly name: string;
	readonly target: string;
}

/** 项目中一个 `.simple` 文件对应的单元符号。 */
export interface SimpleUnitSymbol {
	readonly aliases: readonly SimpleAliasSymbol[];
	readonly definition: LibraryDefinition;
	readonly filePath: string;
	readonly name: string;
	readonly qualifiedName: string;
	readonly sourceRoot: string;
	readonly unitType?: SimpleUnitType;
}

/** 当前文件所属项目向语言能力提供的同步语义上下文。 */
export interface SimpleProjectSemanticContext {
	readonly currentUnit?: SimpleUnitSymbol;
	readonly manifest: LibraryManifest;
	/** 仅为独立单元派生的上下文；临时语义清单不代表已识别的真实项目。 */
	readonly standalone?: true;
	/** 当前语义快照中的单元，用于按成员声明处解析其类型和别名。 */
	readonly units?: readonly SimpleUnitSymbol[];
	/** 仅由项目 res 目录推导、供资源补全、着色、悬停和定义跳转使用的独立索引。 */
	readonly resources?: SimpleProjectResourceIndex;
}

/** 判断成员是否显式声明为静态，适用于项目单元和 SDK 清单。 */
export function isStaticProjectMember(member: LibraryMember): boolean {
	return member.static === true;
}

/** 常量可通过类型或实例读取；其它成员仍按声明的静态或实例访问方式解析。 */
export function isSimpleMemberAccessible(member: LibraryMember, group: LibraryMemberGroup, access: "instance" | "static"): boolean {
	if (group === "constants") {
		return true;
	}

	const staticMember = member.global === true || isStaticProjectMember(member);
	return (access === "static") === staticMember;
}

/** 按顶层逗号拆分参数、变量或接口列表。 */
export function splitSimpleTopLevelDeclarations(value: string): readonly string[] {
	const values: string[] = [];
	let depth = 0;
	let inString = false;
	let start = 0;

	for (let index = 0; index < value.length; index += 1) {
		const current = value[index];
		if (current === "\\" && inString) {
			index += 1;
		} else if (current === "\"") {
			inString = !inString;
		} else if (!inString && current === "(") {
			depth += 1;
		} else if (!inString && current === ")") {
			depth = Math.max(0, depth - 1);
		} else if (!inString && current === "," && depth === 0) {
			values.push(value.slice(start, index).trim());
			start = index + 1;
		}
	}

	values.push(value.slice(start).trim());
	return values.filter((item) => item.length > 0);
}

/** 从同一次语法分析中读取单元级别名，保留声明相邻文档。 */
function parseCodeAliases(userCode: string, syntax: SimpleSourceSyntax): readonly SimpleAliasSymbol[] {
	return syntax.declarations.filter((declaration) => declaration.kind === "alias" && declaration.scope === syntax.root && declaration.target !== undefined)
		.map((declaration) => ({
			...(findAdjacentSimpleDocumentationComment(userCode, declaration.statementStart) === undefined ? {} : { description: findAdjacentSimpleDocumentationComment(userCode, declaration.statementStart) }),
			line: declaration.token.line + 1,
			name: declaration.name,
			target: declaration.target!
		}));
}

/** 把属性 XML 中的继承和接口值转换为类型名称。 */
function propertyTypeNames(property: SimplePropertyXmlParseResult, name: string): readonly string[] {
	const document = property.document;
	if (document === undefined) {
		return [];
	}

	return getPropertyXmlChildren(document.root, "赋值").flatMap((element) => (
		getPropertyXmlAttribute(element, "属性") === name
			? splitSimpleTopLevelDeclarations(getPropertyXmlAttribute(element, "值") ?? "")
			: []
	));
}

/** 递归收集属性 XML 中定义的组件实例。 */
function componentMembers(property: SimplePropertyXmlParseResult): readonly LibraryMember[] {
	if (property.status === "damaged" || property.document === undefined) {
		return [];
	}

	return collectPropertyXmlElements(property.document.root, "定义").flatMap((element) => {
		const name = getPropertyXmlAttribute(element, "名称");
		const type = getPropertyXmlAttribute(element, "组件");
		const sourceLine = element.temporary.get("sourceLine");
		return name === undefined || type === undefined
			? []
			: [{
				component: true,
				line: typeof sourceLine === "number" ? sourceLine : undefined,
				name,
				type
			}];
	});
}

/** 按单元类型补充编译器隐式建立的父类型。 */
function implicitParents(
	unitType: SimpleUnitType | undefined,
	property: SimplePropertyXmlParseResult
): readonly string[] {
	if (property.status === "damaged") {
		return [];
	}

	switch (unitType) {
		case "窗口": {
			const root = property.document === undefined
				? undefined
				: getPropertyXmlChildren(property.document.root, "定义")[0];
			return [getPropertyXmlAttribute(root, "组件") ?? "窗口"];
		}
		case "服务":
			return ["服务"];
		default:
			return [];
	}
}

/** 将属性区单元类型映射为通用定义类型。 */
function definitionKind(unitType: SimpleUnitType | undefined): string {
	if (unitType === "窗口") {
		return "component";
	}
	if (unitType === "接口") {
		return "interface";
	}
	return "object";
}

/** 将共享语法声明投影为项目成员，不另行扫描或猜测局部声明范围。 */
function parseCodeMembers(
	userCode: string,
	unitName: string,
	qualifiedName: string,
	syntax: SimpleSourceSyntax
): Pick<LibraryDefinition, "constants" | "events" | "functions" | "properties" | "variables"> {
	const members: Record<LibraryMemberGroup, LibraryMember[]> = { constants: [], events: [], functions: [], properties: [], variables: [] };
	/* 获取结果和设置参数沿用所属属性的声明位置，直接复用共享语法中的访问器信息。 */
	const getters = new Set(syntax.declarations.filter((value) => value.implicit === true && value.kind === "functionResult").map((value) => value.token.start));
	const setters = new Set(syntax.declarations.filter((value) => value.implicit === true && value.kind === "parameter").map((value) => value.token.start));

	for (const declaration of syntax.declarations) {
		if (declaration.scope !== syntax.root || declaration.implicit === true || declaration.kind === "alias") {
			continue;
		}
		const groups: Partial<Record<typeof declaration.kind, LibraryMemberGroup>> = {
			constant: "constants", event: "events", function: "functions", procedure: "functions", property: "properties", variable: "variables"
		};
		const group = groups[declaration.kind];
		if (group === undefined || declaration.kind === "event" && declaration.owner !== undefined
			&& declaration.owner !== unitName && declaration.owner !== qualifiedName) {
			continue;
		}
		const description = findAdjacentSimpleDocumentationComment(userCode, declaration.statementStart);
		members[group].push({
			...(description === undefined ? {} : { description }),
			...(group === "properties" ? { readable: getters.has(declaration.token.start), writable: setters.has(declaration.token.start) } : {}),
			line: declaration.token.line + 1,
			declarationOffset: declaration.token.start,
			name: declaration.name,
			static: declaration.static || undefined,
			type: declaration.kind === "property" || declaration.kind === "variable" || declaration.kind === "constant" ? declaration.typeName : undefined,
			return: declaration.kind === "function" ? declaration.typeName : undefined,
			params: declaration.parameters?.map((parameter) => ({ name: parameter.name, type: parameter.typeName, passing: parameter.passing, byRef: parameter.passing === "传址" || undefined })),
			...(declaration.initializer === undefined ? {} : { initializer: { label: declaration.initializer, value: declaration.initializer } }),
			value: declaration.kind === "constant" ? declaration.initializer : undefined
		});
	}
	return members;
}

/**
 * 建立一个完整 Simple 单元的编辑器中立符号模型。
 *
 * 代码声明只读取用户代码；单元类型、继承、接口和组件只消费属性 XML。
 */
export function parseSimpleUnitSymbols(
	source: string,
	filePath: string,
	sourceRoot: string
): SimpleUnitSymbol {
	return parseSimpleUnitSymbolsFromModel(
		splitSimpleUnitSource(source).userCode,
		inspectSimplePropertyXml(source),
		filePath,
		sourceRoot
	);
}

/** 直接从用户代码和当前 XML 属性状态建立单元符号，不重新解析原属性代码。 */
export function parseSimpleUnitSymbolsFromModel(
	userCode: string,
	property: SimplePropertyXmlParseResult,
	filePath: string,
	sourceRoot: string
): SimpleUnitSymbol {
	const resolvedFilePath = path.resolve(filePath);
	const resolvedSourceRoot = path.resolve(sourceRoot);
	const qualifiedName = simpleQualifiedName(resolvedSourceRoot, resolvedFilePath);
	const name = path.basename(resolvedFilePath, path.extname(resolvedFilePath));
	const unitType = property.document === undefined
		? undefined
		: getSimplePropertyUnitType(property.document);
	const syntax = analyzeSimpleSourceSyntax(userCode, unitType === "接口");
	const codeMembers = parseCodeMembers(userCode, name, qualifiedName, syntax);
	const baseObject = propertyTypeNames(property, "基础对象")[0];
	const interfaces = propertyTypeNames(property, "实现接口");
	const description = findSimpleUnitComment(userCode);
	const inherits = [
		...implicitParents(unitType, property),
		...(baseObject === undefined ? [] : [baseObject]),
		...interfaces
	];

	return {
		aliases: parseCodeAliases(userCode, syntax),
		definition: {
			...codeMembers,
			...(baseObject === undefined ? {} : { baseObject }),
			...(description === undefined ? {} : { description }),
			inherits: [...new Set(inherits)],
			...(interfaces.length === 0 ? {} : { interfaces }),
			kind: definitionKind(unitType),
			name: qualifiedName,
			propertyStatus: property.status,
			sourceFile: resolvedFilePath,
			unitName: name,
			unitType,
			variables: [...(codeMembers.variables ?? []), ...componentMembers(property)]
		},
		filePath: resolvedFilePath,
		name,
		qualifiedName,
		sourceRoot: resolvedSourceRoot,
		unitType
	};
}

/** 把 SDK 与当前项目单元合并为名称、限定名称均可查询的定义索引。 */
export function buildSemanticDefinitionIndex(
	sdk: Sdk | undefined,
	context: SimpleProjectSemanticContext | undefined
): ReadonlyMap<string, LibraryDefinitionReference> {
	const definitions = new Map(buildDefinitionIndex(sdk?.manifests ?? []));
	if (context === undefined) {
		return scopedDefinitionIndex(definitions, context);
	}

	for (const category of context.manifest.categories) {
		for (const definition of category.definitions) {
			const reference = { definition, manifest: context.manifest };
			if (!definitions.has(definition.name)) {
				definitions.set(definition.name, reference);
			}

			for (const alias of Array.isArray(definition.aliases) ? definition.aliases : []) {
				if (typeof alias === "string" && !definitions.has(alias)) {
					definitions.set(alias, reference);
				}
			}
		}
	}

	return scopedDefinitionIndex(definitions, context);
}

/** 规范身份供继承图使用，可见写法供源码解析使用，两者不能混为全局短名。 */
class ScopedDefinitionIndex extends Map<string, LibraryDefinitionReference> {
	readonly visible = new Map<string, LibraryDefinitionReference>();
	readonly namespaces = new Map<string, string>();
	readonly aliases = new Set<string>();
	constructor(readonly canonical: ReadonlyMap<string, LibraryDefinitionReference>) { super(canonical); }
}

/** 源码名称只能通过当前作用域的可见入口解析。 */
export function resolveSimpleDefinitionName(name: string, definitions: ReadonlyMap<string, LibraryDefinitionReference>, declaringUnit?: SimpleUnitSymbol): LibraryDefinitionReference | undefined {
	if (declaringUnit !== undefined) return scopedDefinitionIndex(definitions instanceof ScopedDefinitionIndex ? definitions.canonical : definitions, { currentUnit: declaringUnit }).visible.get(name);
	return definitions instanceof ScopedDefinitionIndex ? definitions.visible.get(name) : definitions.get(name);
}

/** 相对包路径必须先确定首段实际指向的命名空间，不能绕过近处遮蔽。 */
export function resolveSimpleNamespaceName(name: string, definitions: ReadonlyMap<string, LibraryDefinitionReference>): string | undefined {
	return definitions instanceof ScopedDefinitionIndex ? definitions.namespaces.get(name) : undefined;
}

/** 只有未被当前或父级命名空间遮蔽的别名才作为别名引用处理。 */
export function isSimpleAliasName(name: string, definitions: ReadonlyMap<string, LibraryDefinitionReference>): boolean {
	return definitions instanceof ScopedDefinitionIndex && definitions.aliases.has(name);
}

/** 单次分析派生可见入口，不建立长期缓存或 XML 副本。 */
function scopedDefinitionIndex(canonical: ReadonlyMap<string, LibraryDefinitionReference>, context: Pick<SimpleProjectSemanticContext, "currentUnit"> | undefined): ScopedDefinitionIndex {
	const definitions = new ScopedDefinitionIndex(canonical);
	const types = new Map<string, LibraryDefinitionReference>();
	const namespaces = new Set<string>();
	for (const reference of new Set(canonical.values())) {
		if (reference.manifest.kind === "compiler") continue;
		const name = reference.definition.type?.trim() || reference.definition.name;
		types.set(name, reference);
		const parts = name.split(".");
		for (let length = 1; length < parts.length; length += 1) namespaces.add(parts.slice(0, length).join("."));
	}
	const scopes: string[] = [];
	let scope = context?.currentUnit?.qualifiedName.split(".").slice(0, -1).join(".") ?? "";
	for (;;) {
		scopes.push(scope);
		if (scope.length === 0) break;
		scope = scope.split(".").slice(0, -1).join(".");
	}
	type Entry = { readonly path: string; readonly reference?: LibraryDefinitionReference; readonly alias?: boolean };
	const firstNames = new Map<string, Entry>();
	const globals = new Map<string, Entry>();
	for (const enclosing of scopes) {
		const names = enclosing.length === 0 ? globals : firstNames;
		const prefix = enclosing.length === 0 ? "" : enclosing + ".";
		for (const name of namespaces) {
			if (!name.startsWith(prefix)) continue;
			const short = name.slice(prefix.length);
			if (!short.includes(".") && !names.has(short)) names.set(short, { path: name });
		}
		for (const [name, reference] of types) {
			if (!name.startsWith(prefix)) continue;
			const short = name.slice(prefix.length);
			if (!short.includes(".") && !names.has(short)) names.set(short, { path: name, reference });
		}
	}
	/* SDK 公开名称保留既有清单入口；项目短名不再按全项目唯一性推断。 */
	for (const [name, reference] of canonical) {
		if (reference.manifest.kind !== "project" && !name.includes(".")) globals.set(name, { path: reference.definition.type?.trim() || reference.definition.name, reference });
	}
	const populate = (): void => {
		definitions.visible.clear(); definitions.namespaces.clear(); definitions.aliases.clear();
		const selected = new Map([...globals, ...firstNames]);
		for (const [short, entry] of selected) {
			if (entry.alias === true) definitions.aliases.add(short);
			if (entry.reference !== undefined) definitions.visible.set(short, entry.reference);
			else definitions.namespaces.set(short, entry.path);
		}
		for (const enclosing of scopes) {
			const prefix = enclosing.length === 0 ? "" : enclosing + ".";
			for (const [name, reference] of types) {
				if (!name.startsWith(prefix)) continue;
				const spelling = name.slice(prefix.length);
				const first = spelling.split(".")[0]!;
				if (selected.get(first)?.path === prefix + first) definitions.visible.set(spelling, reference);
			}
			for (const name of namespaces) {
				if (!name.startsWith(prefix)) continue;
				const spelling = name.slice(prefix.length);
				const first = spelling.split(".")[0]!;
				if (selected.get(first)?.path === prefix + first) definitions.namespaces.set(spelling, name);
			}
		}
		/* 命名空间别名可以继续限定，但不能回退到其它同名空间。 */
		for (const [short, entry] of selected) {
			if (entry.reference !== undefined) continue;
			for (const [name, reference] of types) {
				if (name.startsWith(entry.path + ".")) definitions.visible.set(short + name.slice(entry.path.length), reference);
			}
			for (const name of namespaces) {
				if (name.startsWith(entry.path + ".")) definitions.namespaces.set(short + name.slice(entry.path.length), name);
			}
		}
	};
	populate();
	for (const alias of context?.currentUnit?.aliases ?? []) {
		const reference = definitions.visible.get(alias.target);
		const namespace = definitions.namespaces.get(alias.target);
		if (reference !== undefined) globals.set(alias.name, { path: reference.definition.type?.trim() || reference.definition.name, reference, alias: true });
		else if (namespace !== undefined) globals.set(alias.name, { path: namespace, alias: true });
		populate();
	}
	for (const [name, reference] of definitions.visible) if (!definitions.has(name)) definitions.set(name, reference);
	return definitions;
}
