/*
构建并扫描 Simple 编译器关键字、类型与成员的语义标记规则。
xhwsd@qq.com 2026-8-27
*/

import {
	getEffectiveMembers,
	isSdkTypeKind,
	type Sdk,
	type LibraryMemberGroup
} from "./sdk";
import {
	buildSemanticDefinitionIndex,
	isStaticProjectMember,
	type SimpleProjectSemanticContext
} from "./simpleUnitSymbols";
import { resolveSimpleQualifier } from "./completionModel";
import { findPropertySectionStart } from "./simpleUnitSource";
import { stripSimpleLineComment } from "./simpleSourceLexical";

/** 扩展向 VS Code 提供的全部 Simple 语义令牌类型。 */
export const SIMPLE_SEMANTIC_TOKEN_TYPES = [
	"simpleDeclaration",
	"simpleControl",
	"simpleModifier",
	"keyword",
	"type",
	"operator",
	"enumMember",
	"function",
	"event",
	"method",
	"parameter",
	"property",
	"variable"
] as const;

/** Simple 语义令牌类型联合。 */
export type SimpleSemanticTokenType = typeof SIMPLE_SEMANTIC_TOKEN_TYPES[number];

/** 扩展向 VS Code 提供的全部 Simple 语义令牌修饰符。 */
export const SIMPLE_SEMANTIC_TOKEN_MODIFIERS = [
	"readonly"
] as const;

/** Simple 语义令牌修饰符联合。 */
export type SimpleSemanticTokenModifier = typeof SIMPLE_SEMANTIC_TOKEN_MODIFIERS[number];

/** 描述一个由清单或当前文档生成的文本着色规则。 */
export interface CompilerTokenRule {
	/** 规则生效范围的排他结束偏移；省略时作用于全文。 */
	readonly end?: number;
	/** 应用于命中令牌的语义修饰符。 */
	readonly modifiers?: readonly SimpleSemanticTokenModifier[];
	/** 令牌前必须出现的点号限定名；省略时不限制。 */
	readonly qualifier?: string;
	/** 规则生效范围的起始偏移；省略时作用于全文。 */
	readonly start?: number;
	/** 需要完整匹配的源码文本。 */
	readonly text: string;
	/** 命中后生成的语义令牌类型。 */
	readonly type: SimpleSemanticTokenType;
}

/** 描述文档中已识别语义令牌的位置和类型。 */
export interface SimpleSemanticTokenSpan {
	/** 令牌起始位置在当前行中的 UTF-16 偏移。 */
	readonly character: number;
	/** 令牌的 UTF-16 长度。 */
	readonly length: number;
	/** 从零开始的行号。 */
	readonly line: number;
	/** 应用于令牌的语义修饰符。 */
	readonly modifiers: readonly SimpleSemanticTokenModifier[];
	/** 已匹配的源码文本。 */
	readonly text: string;
	/** 交给 VS Code 的语义令牌类型。 */
	readonly type: SimpleSemanticTokenType;
}

/** 用于判断令牌是否嵌入更长标识符的单字符模式。 */
const WORD_CHARACTER = /^[\p{L}\p{N}_]$/u;

/** Simple 标识符的完整匹配模式。 */
const IDENTIFIER = "[\\p{L}][\\p{L}\\p{N}_]*";
const QUALIFIED_IDENTIFIER = `${IDENTIFIER}(?:\\.${IDENTIFIER})*`;

/** 描述函数、过程、事件或属性在文档中的源码范围。 */
interface DocumentScope {
	readonly end: number;
	readonly start: number;
}

/** 描述已知 SDK 类型的变量、参数或组件实例。 */
interface TypedDocumentSymbol extends DocumentScope {
	readonly access: "instance" | "static";
	readonly name: string;
	readonly typeName: string;
}

/**
 * 将 SDK 清单中的通用定义类型映射为 VS Code 语义令牌类型。
 *
 * @param kind SDK 定义的类型标识。
 * @returns 对应的语义令牌类型；不参与着色时返回 `undefined`。
 */
function semanticType(kind: string | undefined): SimpleSemanticTokenType | undefined {
	switch (kind) {
		case "declaration":
			return "simpleDeclaration";
		case "control":
			return "simpleControl";
		case "modifier":
			return "simpleModifier";
		case "keyword":
		case "$keyword":
			return "keyword";
		case "type":
		case "$source":
		case "$type":
			return "type";
		case "operator":
			return "operator";
		case "literal":
			return "enumMember";
		default:
			return undefined;
	}
}

/**
 * 计算规则作用范围长度，全文规则排在所有局部规则之后。
 *
 * @param rule 待比较的着色规则。
 * @returns 规则范围长度；全文规则返回正无穷。
 */
function ruleScopeLength(rule: CompilerTokenRule): number {
	return rule.start === undefined || rule.end === undefined
		? Number.POSITIVE_INFINITY
		: rule.end - rule.start;
}

/**
 * 按最长文本优先、最小作用域优先排列着色规则。
 *
 * @param left 左侧规则。
 * @param right 右侧规则。
 * @returns 适用于 `Array.sort` 的比较结果。
 */
function compareRules(left: CompilerTokenRule, right: CompilerTokenRule): number {
	return right.text.length - left.text.length
		|| ruleScopeLength(left) - ruleScopeLength(right)
		|| Number(right.qualifier !== undefined) - Number(left.qualifier !== undefined);
}

/**
 * 从 SDK 的编译器清单生成动态着色规则。
 *
 * @param sdk 当前已加载的 SDK；未配置时可为空。
 * @returns 按文本长度降序排列的着色规则，保证长关键字优先匹配。
 */
export function buildCompilerTokenRules(sdk: Sdk | undefined): readonly CompilerTokenRule[] {
	const compiler = sdk?.manifests.find((manifest) => manifest.kind === "compiler");

	if (compiler === undefined) {
		return [];
	}

	const rules = new Map<string, CompilerTokenRule>();

	for (const category of compiler.categories) {
		for (const definition of category.definitions) {
			const type = semanticType(definition.kind);

			if (type !== undefined && definition.name.length > 0) {
				rules.set(definition.name, { text: definition.name, type });
			}
		}
	}

	return [...rules.values()].sort(compareRules);
}

/**
 * 移除 Simple 物理行中字符串之外的单引号注释。
 *
 * @param line 待处理的单行源码。
 * @returns 不包含行尾注释的源码部分。
 */
/**
 * 按顶层逗号拆分声明，忽略字符串及数组维度或调用括号中的逗号。
 *
 * @param source `变量`、`常量`或正式参数后的声明文本。
 * @returns 保持源码顺序的非空声明片段。
 */
function splitTopLevelDeclarations(source: string): readonly string[] {
	const result: string[] = [];
	let depth = 0;
	let inString = false;
	let start = 0;

	for (let index = 0; index < source.length; index += 1) {
		const current = source[index];

		if (current === "\\" && inString) {
			index += 1;
			continue;
		}

		if (current === "\"") {
			inString = !inString;
			continue;
		}

		if (inString) {
			continue;
		}

		if (current === "(") {
			depth += 1;
		} else if (current === ")") {
			depth = Math.max(0, depth - 1);
		} else if (current === "," && depth === 0) {
			result.push(source.slice(start, index).trim());
			start = index + 1;
		}
	}

	result.push(source.slice(start).trim());
	return result.filter((value) => value.length > 0);
}

/**
 * 查找左括号对应的右括号，兼容数组类型中的嵌套括号。
 *
 * @param source 完整文档内容。
 * @param openOffset 左括号偏移。
 * @returns 匹配右括号偏移；括号未闭合时返回 `undefined`。
 */
function findClosingParenthesis(source: string, openOffset: number): number | undefined {
	let depth = 0;
	let inString = false;

	for (let index = openOffset; index < source.length; index += 1) {
		const current = source[index];

		if (current === "\\" && inString) {
			index += 1;
			continue;
		}

		if (current === "\"") {
			inString = !inString;
			continue;
		}

		if (inString) {
			continue;
		}

		if (current === "(") {
			depth += 1;
		} else if (current === ")") {
			depth -= 1;

			if (depth === 0) {
				return index;
			}
		}
	}

	return undefined;
}

/**
 * 查找声明对应的 `结束` 组合关键字，并确定局部符号范围。
 *
 * @param source 完整文档内容。
 * @param start 声明起始偏移。
 * @param declarationKind 函数、过程、事件或属性关键字。
 * @returns 包含整个声明体的排他结束偏移。
 */
function findDeclarationEnd(source: string, start: number, declarationKind: string): number {
	const ending = new RegExp(`^[ \\t]*结束[ \\t]+${declarationKind}(?=[ \\t'\\r\\n]|$)`, "gmu");
	ending.lastIndex = start;
	const match = ending.exec(source);
	return match === null ? source.length : match.index + match[0].length;
}

/** 返回完整单元属性区的源码范围；用户代码文档没有属性区时返回 `undefined`。 */
function propertySectionScope(source: string): DocumentScope | undefined {
	const start = findPropertySectionStart(source);
	return start < source.length ? { end: source.length, start } : undefined;
}

/**
 * 将类库成员分组映射为 VS Code 语义令牌类型和修饰符。
 *
 * @param group 类库成员分组。
 * @returns 可直接合并进着色规则的成员语义信息。
 */
function memberTokenStyle(group: LibraryMemberGroup): Pick<CompilerTokenRule, "modifiers" | "type"> {
	switch (group) {
		case "constants":
			return { modifiers: ["readonly"], type: "variable" };
		case "events":
			return { type: "event" };
		case "functions":
			return { type: "method" };
		case "properties":
			return { type: "property" };
		case "variables":
			return { type: "variable" };
	}
}

/**
 * 收集当前文档声明的可调用成员、属性、参数、变量、常量和组件实例。
 *
 * 局部变量和参数只在所属声明体内生效；同名局部规则优先于全局规则。
 *
 * @param source 当前 Simple 文档内容。
 * @param sdk 当前已加载的 SDK，用于解析组件类型、继承关系和成员。
 * @returns 按文本长度和作用域精度排列的文档符号规则。
 */
export function buildDocumentTokenRules(
	source: string,
	sdk?: Sdk,
	context?: SimpleProjectSemanticContext
): readonly CompilerTokenRule[] {
	const rules = new Map<string, CompilerTokenRule>();
	const scopes: DocumentScope[] = [];
	const typedSymbols: TypedDocumentSymbol[] = [];
	const definitions = new Map(buildSemanticDefinitionIndex(sdk, context));
	for (const manifest of sdk?.manifests ?? []) {
		for (const category of manifest.categories) {
			for (const definition of category.definitions) {
				const typeName = definition.type?.trim();
				if (typeName !== undefined && typeName.length > 0 && !definitions.has(typeName)) {
					definitions.set(typeName, { definition, manifest });
				}
			}
		}
	}

	/** 将规则加入集合，并保留不同类型或作用域的同名定义。 */
	const addRule = (rule: CompilerTokenRule): void => {
		const key = [
			rule.text,
			rule.type,
			rule.start ?? "document",
			rule.end ?? "document",
			rule.qualifier ?? "unqualified",
			...(rule.modifiers ?? [])
		].join(":");
		rules.set(key, rule);
	};

	/*
	 * 项目资源只形成 R.xxx 的着色规则，不进入通用定义索引，避免顺带改变补全、
	 * 跳转或其它语言能力。对象和成员都只在完整命中已有资源时着色，未知 R 成员
	 * 不会仅凭写法获得资源语义。
	 */
	if (context?.resources !== undefined) {
		for (const symbol of context.resources.symbols) {
			const reference = new RegExp(
				`(?<![\\p{L}\\p{N}_])(R)[ \\t]*\\.[ \\t]*(${symbol.name})(?![\\p{L}\\p{N}_])`,
				"gu"
			);
			for (const match of source.matchAll(reference)) {
				if (match.index === undefined) {
					continue;
				}
				const memberStart = match.index + match[0].lastIndexOf(symbol.name);
				addRule({
					end: match.index + 1,
					start: match.index,
					text: "R",
					type: "type"
				});
				addRule({
					end: memberStart + symbol.name.length,
					modifiers: ["readonly"],
					start: memberStart,
					text: symbol.name,
					type: "variable"
				});
			}
		}
	}

	/**
	 * 记录已知 SDK 类型的符号，同时为其类型名称建立着色规则。
	 *
	 * @param name 变量、参数、组件实例或静态类型限定名。
	 * @param typeName SDK 定义名称。
	 * @param scope 符号可见的源码范围。
	 * @param access 点号访问使用实例成员还是静态成员。
	 */
	const addTypedSymbol = (
		name: string,
		typeName: string,
		scope: DocumentScope,
		access: TypedDocumentSymbol["access"] = "instance"
	): void => {
		const normalized = typeName.trim().replace(/\([^()]*\)$/u, "");
		const aliasTarget = context?.currentUnit?.aliases.find(
			(alias) => alias.name === normalized
		)?.target;
		const resolvedName = aliasTarget ?? normalized;
		const reference = definitions.get(resolvedName)
			?? definitions.get(resolvedName.split(".").at(-1) ?? resolvedName);

		if (reference === undefined || !isSdkTypeKind(reference.definition.kind)) {
			return;
		}

		addRule({ text: typeName, type: "type" });
		typedSymbols.push({ ...scope, access, name, typeName: reference.definition.name });
	};
	const callableDeclaration = new RegExp(
		`^[ \\t]*(?:静态[ \\t]+)?(函数|过程|事件|属性)[ \\t]+(${IDENTIFIER})(?:\\.(${IDENTIFIER}))?`,
		"gmu"
	);

	for (const match of source.matchAll(callableDeclaration)) {
		const declarationKind = match[1];
		const name = match[3] ?? match[2];

		if (declarationKind === undefined || name === undefined || match.index === undefined) {
			continue;
		}

		const type: SimpleSemanticTokenType = declarationKind === "事件"
			? "event"
			: declarationKind === "属性" ? "property" : "function";
		addRule({ text: name, type });
		const scope = {
			end: findDeclarationEnd(source, match.index, declarationKind),
			start: match.index
		};
		scopes.push(scope);

		if (declarationKind === "属性") {
			continue;
		}

		let openOffset = match.index + match[0].length;

		while (openOffset < source.length && /[ \t]/.test(source[openOffset] ?? "")) {
			openOffset += 1;
		}

		if (source[openOffset] !== "(") {
			continue;
		}

		const closeOffset = findClosingParenthesis(source, openOffset);

		if (closeOffset === undefined) {
			continue;
		}

		for (const parameter of splitTopLevelDeclarations(source.slice(openOffset + 1, closeOffset))) {
			const parameterMatch = new RegExp(
				`^(?:(?:传值|传址)[ \\t]+)?(${IDENTIFIER})[ \\t]+为[ \\t]+(${QUALIFIED_IDENTIFIER})`,
				"u"
			)
				.exec(parameter);
			const parameterName = parameterMatch?.[1];
			const parameterType = parameterMatch?.[2];

			if (parameterName !== undefined) {
				addRule({ ...scope, text: parameterName, type: "parameter" });

				if (parameterType !== undefined) {
					addTypedSymbol(parameterName, parameterType, scope);
				}
			}
		}
	}

	const dataDeclaration = new RegExp(
		`^[ \\t]*(?:静态[ \\t]+)?(变量|常量)[ \\t]+([^\\r\\n]*)`,
		"gmu"
	);

	for (const match of source.matchAll(dataDeclaration)) {
		const declarationKind = match[1];
		const declarationSource = match[2];

		if (declarationKind === undefined || declarationSource === undefined || match.index === undefined) {
			continue;
		}

		const localScope = declarationKind === "变量"
			? scopes
				.filter((scope) => match.index >= scope.start && match.index < scope.end)
				.sort((left, right) => (left.end - left.start) - (right.end - right.start))[0]
			: undefined;
		const symbolScope = localScope ?? { end: source.length, start: 0 };

		for (const declaration of splitTopLevelDeclarations(stripSimpleLineComment(declarationSource))) {
			const declarationMatch = new RegExp(
				`^(${IDENTIFIER})(?:[ \\t]+为[ \\t]+(${QUALIFIED_IDENTIFIER})|[ \\t]*=[ \\t]*创建[ \\t]+(${QUALIFIED_IDENTIFIER}))`,
				"u"
			).exec(declaration);
			const name = declarationMatch?.[1];
			const typeName = declarationMatch?.[2] ?? declarationMatch?.[3];

			if (name === undefined) {
				continue;
			}

			addRule({
				...(localScope ?? {}),
				modifiers: declarationKind === "常量" ? ["readonly"] : undefined,
				text: name,
				type: "variable"
			});

			if (declarationKind === "变量" && typeName !== undefined) {
				addTypedSymbol(name, typeName, symbolScope);
			}
		}
	}

	const componentMembers = context?.currentUnit?.definition.variables?.filter(
		(member) => member.component === true
	) ?? [];

	for (const component of componentMembers) {
		addRule({ text: component.name, type: "variable" });
		if (component.type !== undefined) {
			addTypedSymbol(component.name, component.type, { end: source.length, start: 0 });
		}
	}

	for (const alias of context?.currentUnit?.aliases ?? []) {
		const target = definitions.get(alias.target)
			?? definitions.get(alias.target.split(".").at(-1) ?? alias.target);
		if (target !== undefined && isSdkTypeKind(target.definition.kind)) {
			addRule({ text: alias.name, type: "type" });
			addTypedSymbol(alias.name, alias.name, { end: source.length, start: 0 }, "static");
		}
	}

	const propertyScope = propertySectionScope(source);
	if (propertyScope !== undefined) {
		const compiler = sdk?.manifests.find((manifest) => manifest.kind === "compiler");
		for (const definition of compiler?.categories.flatMap((category) => category.definitions) ?? []) {
			for (const property of definition.properties ?? []) {
				addRule({ ...propertyScope, text: property.name, type: "property" });
			}
		}

		/*
		 * 布局属性写在容器定义内部，并统一以“布局.xxx”出现，不属于容器组件
		 * 自身的成员。按点号限定后着色，避免同名普通标识符被误判为属性。
		 */
		for (const reference of definitions.values()) {
			if (reference.definition.kind !== "layout") {
				continue;
			}
			for (const property of getEffectiveMembers(reference, "properties", definitions)) {
				addRule({
					...propertyScope,
					qualifier: "布局",
					text: property.member.name,
					type: "property"
				});
			}
		}

		const propertyOwnerNames = new Set<string>();
		if (context?.currentUnit !== undefined) {
			propertyOwnerNames.add(context.currentUnit.qualifiedName);
		}
		for (const component of componentMembers) {
			if (component.type !== undefined) {
				propertyOwnerNames.add(component.type);
			}
		}
		for (const ownerName of propertyOwnerNames) {
			const reference = definitions.get(ownerName);
			if (reference === undefined) {
				continue;
			}
			for (const property of getEffectiveMembers(reference, "properties", definitions)) {
				addRule({ ...propertyScope, text: property.member.name, type: "property" });
			}
		}
	}

	for (const [name, reference] of definitions) {
		const typeName = reference.definition.type?.trim();
		if (
			(reference.manifest.kind === "project" || typeName === name)
			&& source.includes(name)
		) {
			addRule({ text: name, type: "type" });
		}
	}

	for (const [typeName, reference] of definitions) {

		if (
			isSdkTypeKind(reference.definition.kind)
			&& new RegExp(`(?<![\\p{L}\\p{N}_])${typeName}[ \\t]*\\.`, "u").test(source)
		) {
			addTypedSymbol(typeName, typeName, { end: source.length, start: 0 }, "static");
		}
	}

	const currentReference = context?.currentUnit === undefined
		? undefined
		: definitions.get(context.currentUnit.qualifiedName);
	if (currentReference !== undefined) {
		for (const group of ["constants", "variables", "properties", "functions", "events"] as const) {
			for (const value of getEffectiveMembers(currentReference, group, definitions)) {
				addRule({ ...memberTokenStyle(group), text: value.member.name });
			}
		}
	}

	for (const reference of definitions.values()) {
		for (const group of ["constants", "variables", "functions"] as const) {
			for (const member of reference.definition[group] ?? []) {
				if (member.global !== true) {
					continue;
				}

				const style = group === "functions"
					? { type: "function" as const }
					: memberTokenStyle(group);
				addRule({ ...style, text: member.name });
			}
		}
	}

	for (const symbol of typedSymbols) {
		const reference = definitions.get(symbol.typeName);

		if (reference === undefined) {
			continue;
		}

		const groups: readonly LibraryMemberGroup[] = symbol.access === "static"
			? ["constants", "variables", "functions"]
			: ["variables", "properties", "functions", "events"];

		for (const group of groups) {
			const style = memberTokenStyle(group);

			for (const value of getEffectiveMembers(reference, group, definitions)) {
				const isStaticMember = group === "constants"
					|| value.member.global === true
					|| isStaticProjectMember(value.member);
				if ((symbol.access === "static") !== isStaticMember) {
					continue;
				}

				addRule({
					...style,
					end: symbol.end,
					qualifier: symbol.name,
					start: symbol.start,
					text: value.member.name
				});
			}
		}
	}

	/* 多段成员链按完整限定链解析最后一段，覆盖跨单元属性或函数返回值。 */
	const chainedMember = new RegExp(
		`(${QUALIFIED_IDENTIFIER})[ \\t]*\\.[ \\t]*(${IDENTIFIER})`,
		"gu"
	);
	for (const match of source.matchAll(chainedMember)) {
		const qualifier = match[1];
		const memberName = match[2];
		if (qualifier === undefined || memberName === undefined || match.index === undefined) {
			continue;
		}
		const memberStart = match.index + match[0].lastIndexOf(memberName);
		const resolved = resolveSimpleQualifier(source, memberStart, qualifier, sdk, context);
		if (resolved === undefined) {
			continue;
		}

		const groups: readonly LibraryMemberGroup[] = resolved.access === "static"
			? ["constants", "variables", "functions"]
			: ["variables", "properties", "functions", "events"];
		for (const group of groups) {
			const value = getEffectiveMembers(resolved.reference, group, definitions).find(
				(candidate) => candidate.member.name === memberName
			);
			if (value === undefined) {
				continue;
			}
			const staticMember = group === "constants"
				|| value.member.global === true
				|| isStaticProjectMember(value.member);
			if ((resolved.access === "static") !== staticMember) {
				continue;
			}
			addRule({ ...memberTokenStyle(group), qualifier, text: memberName });
			break;
		}
	}

	return [...rules.values()].sort(compareRules);
}

/**
 * 判断命中位置两侧是否满足完整标识符边界。
 *
 * @param source 完整文档文本。
 * @param index 候选令牌的起始偏移。
 * @param token 候选令牌文本。
 * @returns 候选文本没有嵌入更长标识符时返回 `true`。
 */
function hasTokenBoundary(source: string, index: number, token: string): boolean {
	const first = token[0];
	const last = token[token.length - 1];
	const previous = index === 0 ? undefined : source[index - 1];
	const nextIndex = index + token.length;
	const next = nextIndex >= source.length ? undefined : source[nextIndex];

	if (first !== undefined && WORD_CHARACTER.test(first) && previous !== undefined && WORD_CHARACTER.test(previous)) {
		return false;
	}

	return !(last !== undefined && WORD_CHARACTER.test(last) && next !== undefined && WORD_CHARACTER.test(next));
}

/**
 * 判断令牌前是否紧邻指定的点号限定名，允许点号两侧存在水平空白。
 *
 * @param source 完整文档文本。
 * @param index 成员令牌的起始偏移。
 * @param qualifier 期望的变量、组件实例或 SDK 类型名称。
 * @returns 前方限定名完整匹配时返回 `true`。
 */
function hasQualifier(source: string, index: number, qualifier: string): boolean {
	let cursor = index;

	while (cursor > 0 && /[ \t\f]/.test(source[cursor - 1] ?? "")) {
		cursor -= 1;
	}

	if (source[cursor - 1] !== ".") {
		return false;
	}

	cursor -= 1;

	while (cursor > 0 && /[ \t\f]/.test(source[cursor - 1] ?? "")) {
		cursor -= 1;
	}

	const qualifierStart = cursor - qualifier.length;

	return qualifierStart >= 0
		&& source.slice(qualifierStart, cursor) === qualifier
		&& hasTokenBoundary(source, qualifierStart, qualifier);
}

/**
 * 在指定偏移处查找第一个满足文本和边界条件的规则。
 *
 * @param source 完整文档文本。
 * @param index 待匹配的起始偏移。
 * @param rulesByFirstCharacter 按首字符分组的着色规则。
 * @returns 首个有效规则；没有匹配时返回 `undefined`。
 */
function findRuleAt(
	source: string,
	index: number,
	rulesByFirstCharacter: ReadonlyMap<string, readonly CompilerTokenRule[]>
): CompilerTokenRule | undefined {
	const current = source[index];
	const candidates = current === undefined ? undefined : rulesByFirstCharacter.get(current);
	return candidates?.find((rule) => (
		(rule.start === undefined || index >= rule.start)
		&& (rule.end === undefined || index + rule.text.length <= rule.end)
		&& (rule.qualifier === undefined || hasQualifier(source, index, rule.qualifier))
		&& source.startsWith(rule.text, index)
		&& hasTokenBoundary(source, index, rule.text)
	));
}

/**
 * 根据相邻令牌修正上下文相关的颜色。
 *
 * `结束` 通常属于流程控制，但在 `结束 函数` 等组合中属于声明结束符。
 *
 * @param source 完整文档文本。
 * @param indexAfterToken 当前令牌结束后的偏移。
 * @param matched 当前已命中的规则。
 * @param rulesByFirstCharacter 按首字符分组的着色规则。
 * @returns 结合后续令牌语境确定的语义令牌类型。
 */
function contextualType(
	source: string,
	indexAfterToken: number,
	matched: CompilerTokenRule,
	rulesByFirstCharacter: ReadonlyMap<string, readonly CompilerTokenRule[]>
): SimpleSemanticTokenType {
	if (matched.text !== "结束" || matched.type !== "simpleControl") {
		return matched.type;
	}

	let nextIndex = indexAfterToken;

	while (nextIndex < source.length && /[ \t\f]/.test(source[nextIndex] ?? "")) {
		nextIndex += 1;
	}

	const nextRule = findRuleAt(source, nextIndex, rulesByFirstCharacter);
	return nextRule?.type === "simpleDeclaration" ? "simpleDeclaration" : matched.type;
}

/**
 * 扫描 Simple 文本并生成语义令牌，主动跳过注释和字符串内容。
 *
 * @param source 完整文档文本。
 * @param rules SDK 与文档共同生成的匹配规则。
 * @returns 按源码位置排列的语义令牌跨度。
 */
export function tokenizeSimpleText(
	source: string,
	rules: readonly CompilerTokenRule[]
): readonly SimpleSemanticTokenSpan[] {
	const rulesByFirstCharacter = new Map<string, CompilerTokenRule[]>();

	for (const rule of rules) {
		const first = rule.text[0];

		if (first !== undefined) {
			const values = rulesByFirstCharacter.get(first) ?? [];
			values.push(rule);
			rulesByFirstCharacter.set(first, values);
		}
	}
	for (const values of rulesByFirstCharacter.values()) {
		values.sort(compareRules);
	}

	const tokens: SimpleSemanticTokenSpan[] = [];
	let character = 0;
	let index = 0;
	let line = 0;

	while (index < source.length) {
		const current = source[index];

		if (current === "\n") {
			index += 1;
			line += 1;
			character = 0;
			continue;
		}

		if (current === "'") {
			while (index < source.length && source[index] !== "\n") {
				index += 1;
				character += 1;
			}
			continue;
		}

		if (current === "\"") {
			index += 1;
			character += 1;

			while (index < source.length) {
				const stringCharacter = source[index];

				if (stringCharacter === "\\" && index + 1 < source.length) {
					index += 2;
					character += 2;
					continue;
				}

				index += 1;
				character += 1;

				if (stringCharacter === "\"" || stringCharacter === "\n") {
					if (stringCharacter === "\n") {
						line += 1;
						character = 0;
					}
					break;
				}
			}
			continue;
		}

		const matched = findRuleAt(source, index, rulesByFirstCharacter);

		if (matched !== undefined) {
			tokens.push({
				character,
				length: matched.text.length,
				line,
				modifiers: matched.modifiers ?? [],
				text: matched.text,
				type: contextualType(source, index + matched.text.length, matched, rulesByFirstCharacter)
			});
			index += matched.text.length;
			character += matched.text.length;
			continue;
		}

		index += 1;
		character += 1;
	}

	return tokens;
}
