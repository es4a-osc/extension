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
	type LibraryParameter,
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
import { stripSimpleLineComment } from "./simpleSourceLexical";

const IDENTIFIER = "[\\p{L}][\\p{L}\\p{N}_]*";
const QUALIFIED_IDENTIFIER = `${IDENTIFIER}(?:\\.${IDENTIFIER})*`;

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
	/** 仅由项目 res 目录推导、供资源补全、着色、悬停和定义跳转使用的独立索引。 */
	readonly resources?: SimpleProjectResourceIndex;
}

/** 判断一个成员是否由用户单元声明为静态成员。 */
export function isStaticProjectMember(member: LibraryMember): boolean {
	return member.static === true;
}

/** 按顶层逗号拆分参数、变量或接口列表。 */
function splitTopLevel(value: string): readonly string[] {
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

/** 解析函数、过程或事件的正式参数。 */
function parseParameters(value: string): readonly LibraryParameter[] {
	const pattern = new RegExp(
		`^(?:(传值|传址)[ \\t]+)?(${IDENTIFIER})[ \\t]+为[ \\t]+(${QUALIFIED_IDENTIFIER}(?:\\([^)]*\\))?)`,
		"u"
	);

	return splitTopLevel(value).flatMap((item) => {
		const match = pattern.exec(item);
		const name = match?.[2];
		if (name === undefined) {
			return [];
		}

		return [{
			byRef: match?.[1] === "传址" || undefined,
			name,
			...(match?.[1] === undefined
				? {}
				: { passing: match[1] as "传值" | "传址" }),
			type: match?.[3]
		}];
	});
}

/** 查找声明体的排他结束位置，用来排除局部变量。 */
function declarationEnd(source: string, start: number, kind: string): number {
	const ending = new RegExp(`^[ \\t]*结束[ \\t]+${kind}(?=[ \\t'\\r\\n]|$)`, "gmu");
	ending.lastIndex = start;
	const match = ending.exec(source);
	return match === null ? source.length : match.index + match[0].length;
}

/** 查找代码中函数、过程、事件和属性的声明体范围。 */
function codeDeclarationScopes(userCode: string): readonly { readonly end: number; readonly start: number }[] {
	const scopes: Array<{ readonly end: number; readonly start: number }> = [];
	const callable = new RegExp(
		`^[ \\t]*(?:静态[ \\t]+)?(函数|过程|事件|属性)[ \\t]+(?:${QUALIFIED_IDENTIFIER}\\.)?${IDENTIFIER}`,
		"gmu"
	);

	for (const match of userCode.matchAll(callable)) {
		const declarationKind = match[1];
		if (declarationKind !== undefined && match.index !== undefined) {
			scopes.push({
				end: declarationEnd(userCode, match.index, declarationKind),
				start: match.index
			});
		}
	}

	return scopes;
}

/** 解析只允许出现在文件级的别名声明。 */
function parseCodeAliases(userCode: string): readonly SimpleAliasSymbol[] {
	const scopes = codeDeclarationScopes(userCode);
	const aliases: SimpleAliasSymbol[] = [];
	const declaration = new RegExp(
		`^[ \\t]*别名[ \\t]+(${IDENTIFIER})[ \\t]*=[ \\t]*(${QUALIFIED_IDENTIFIER})(?=[ \\t:'\\r\\n]|$)`,
		"gmu"
	);

	for (const match of userCode.matchAll(declaration)) {
		const name = match[1];
		const target = match[2];
		if (
			name !== undefined
			&& target !== undefined
			&& match.index !== undefined
			&& !scopes.some((scope) => match.index !== undefined && match.index >= scope.start && match.index < scope.end)
		) {
			const description = findAdjacentSimpleDocumentationComment(userCode, match.index);
			aliases.push({
				...(description === undefined ? {} : { description }),
				line: userCode.slice(0, match.index).split(/\r\n|\n|\r/u).length,
				name,
				target
			});
		}
	}

	return aliases;
}

/** 把属性 XML 中的继承和接口值转换为类型名称。 */
function propertyTypeNames(property: SimplePropertyXmlParseResult, name: string): readonly string[] {
	const document = property.document;
	if (document === undefined) {
		return [];
	}

	return getPropertyXmlChildren(document.root, "赋值").flatMap((element) => (
		getPropertyXmlAttribute(element, "属性") === name
			? splitTopLevel(getPropertyXmlAttribute(element, "值") ?? "")
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

/** 从代码区读取单元直接声明的成员。 */
function parseCodeMembers(
	userCode: string,
	unitName: string,
	qualifiedName: string
): Pick<
	LibraryDefinition,
	"constants" | "events" | "functions" | "properties" | "variables"
> {
	const constants: LibraryMember[] = [];
	const events: LibraryMember[] = [];
	const functions: LibraryMember[] = [];
	const properties: LibraryMember[] = [];
	const variables: LibraryMember[] = [];
	const scopes: Array<{ readonly end: number; readonly start: number }> = [];
	const callable = new RegExp(
		`^[ \\t]*(静态[ \\t]+)?(函数|过程|事件|属性)[ \\t]+(?:(${QUALIFIED_IDENTIFIER})\\.)?(${IDENTIFIER})[ \\t]*(?:\\(([^\\r\\n]*)\\))?(?:[ \\t]+为[ \\t]+([^\\r\\n']+))?`,
		"gmu"
	);

	for (const match of userCode.matchAll(callable)) {
		const declarationKind = match[2];
		const owner = match[3];
		const name = match[4];
		if (declarationKind === undefined || name === undefined || match.index === undefined) {
			continue;
		}

		scopes.push({
			end: declarationEnd(userCode, match.index, declarationKind),
			start: match.index
		});
		const description = findAdjacentSimpleDocumentationComment(userCode, match.index);
		const member: LibraryMember = {
			...(description === undefined ? {} : { description }),
			line: userCode.slice(0, match.index).split(/\r\n|\n|\r/u).length,
			name,
			params: declarationKind === "属性" ? undefined : parseParameters(match[5] ?? ""),
			return: declarationKind === "函数" ? match[6]?.trim() : undefined,
			static: match[1] !== undefined || undefined,
			type: declarationKind === "属性" ? match[6]?.trim() : undefined
		};

		if (declarationKind === "属性") {
			properties.push(member);
		} else if (declarationKind === "事件") {
			if (owner === undefined || owner === unitName || owner === qualifiedName) {
				events.push(member);
			}
		} else {
			functions.push(member);
		}
	}

	const data = new RegExp(`^[ \\t]*(静态[ \\t]+)?(变量|常量)[ \\t]+([^\\r\\n]*)`, "gmu");
	const declaration = new RegExp(
		`^(${IDENTIFIER})[ \\t]+为[ \\t]+(${QUALIFIED_IDENTIFIER}(?:\\([^)]*\\))?)(?:[ \\t]*=[ \\t]*(.*))?$`,
		"u"
	);

	for (const match of userCode.matchAll(data)) {
		if (
			match.index === undefined
			|| scopes.some((scope) => match.index !== undefined && match.index >= scope.start && match.index < scope.end)
		) {
			continue;
		}

		for (const value of splitTopLevel(stripSimpleLineComment(match[3] ?? ""))) {
			const valueMatch = declaration.exec(value);
			const name = valueMatch?.[1];
			if (name === undefined) {
				continue;
			}

			const description = findAdjacentSimpleDocumentationComment(userCode, match.index);
			const initializer = valueMatch?.[3]?.trim();
			const member: LibraryMember = {
				...(description === undefined ? {} : { description }),
				...(initializer === undefined ? {} : {
					initializer: { label: initializer, value: initializer }
				}),
				line: userCode.slice(0, match.index).split(/\r\n|\n|\r/u).length,
				name,
				static: match[1] !== undefined || undefined,
				type: valueMatch?.[2],
				value: match[2] === "常量" ? valueMatch?.[3]?.trim() : undefined
			};
			(match[2] === "常量" ? constants : variables).push(member);
		}
	}

	return { constants, events, functions, properties, variables };
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
	const relativePath = path.relative(resolvedSourceRoot, resolvedFilePath);
	const qualifiedName = relativePath
		.slice(0, -path.extname(relativePath).length)
		.split(path.sep)
		.join(".");
	const name = path.basename(resolvedFilePath, path.extname(resolvedFilePath));
	const unitType = property.document === undefined
		? undefined
		: getSimplePropertyUnitType(property.document);
	const codeMembers = parseCodeMembers(
		userCode,
		name,
		qualifiedName
	);
	const baseObject = propertyTypeNames(property, "基础对象")[0];
	const interfaces = propertyTypeNames(property, "实现接口");
	const description = findSimpleUnitComment(userCode);
	const inherits = [
		...implicitParents(unitType, property),
		...(baseObject === undefined ? [] : [baseObject]),
		...interfaces
	];

	return {
		aliases: parseCodeAliases(userCode),
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
		return definitions;
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

	return definitions;
}
