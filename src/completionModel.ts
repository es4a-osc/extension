/*
分析 Simple 代码区补全语境，并从 SDK 与当前文档生成支持首拼过滤的合法候选。
xhwsd@qq.com 2026-8-27
*/

import { pinyin } from "pinyin-pro";
import {
	getEffectiveMembers,
	isComponentDefinition,
	isSdkTypeKind,
	type LibraryDefinition,
	type LibraryDefinitionReference,
	type LibraryMember,
	type LibraryMemberGroup,
	type EffectiveLibraryMember,
	type Sdk
} from "./sdk";
import {
	buildSemanticDefinitionIndex,
	isSimpleMemberAccessible,
	isSimpleAliasName,
	resolveSimpleDefinitionName,
	resolveSimpleNamespaceName,
	isStaticProjectMember,
	type SimpleAliasSymbol,
	type SimpleProjectSemanticContext
} from "./simpleUnitSymbols";
import { SIMPLE_IDENTIFIER_CHARACTER as IDENTIFIER_CHARACTER, SIMPLE_IDENTIFIER_PATTERN, isSimpleIgnoredOffset, maskSimpleIgnoredText, scanSimpleSource, simpleIdentifierRange, simpleSourceStatements, simpleSourceTokenIndex, skipSimpleContinuationWhitespace, type SimpleSourceToken } from "./simpleSourceLexical";
import {
	analyzeSimpleSourceSyntax,
	isSimpleEventTarget,
	simpleCreatedType,
	type SimpleSourceDeclaration,
	type SimpleSourceSyntax,
	type SimpleSourceBlock as BlockFrame
} from "./simpleSourceSyntax";
import languageFacts from "./simpleLanguageFacts.json";
import { sameFilePath } from "./simpleProjectPaths";
import { simpleCodeContext, simpleExecutionContext, simpleExpressionKeywords, type SimpleCodeContext } from "./simpleCodeContext";
import { findCallContext, findCallableArgumentCount, type CallContext } from "./signatures";

/** 补全项的编辑器中立语义类型。 */
export type SimpleCompletionKind =
	| "constant"
	| "event"
	| "function"
	| "keyword"
	| "property"
	| "reference"
	| "type"
	| "variable";

/** 可由 VS Code 适配层展示和插入的一项 Simple 补全候选。 */
export interface SimpleCompletionCandidate {
	/** 值的声明类型为数组，后接括号表示下标而非方法调用。 */
	readonly array?: true;
	/** 变量、属性、常量的声明类型，或函数的返回类型；过程没有返回类型。 */
	readonly valueType?: string;
	/** 明确只写的属性不能作为表达式值或成员接收者。 */
	readonly readable?: false;
	/** 当前候选可直接作为赋值目标。 */
	readonly writable?: true;
	/** 可调用成员，包括仍使用引用图标展示的方法别名。 */
	readonly callable?: true;
	/** 候选说明。 */
	readonly description?: string;
	/** 补全列表中的补充信息。 */
	readonly detail?: string;
	/** 用于拼音首字母过滤的无空格小写文本。 */
	readonly initials: string;
	/** 候选语义类型。 */
	readonly kind: SimpleCompletionKind;
	/** 最终插入 Simple 源码的中文名称。 */
	readonly name: string;
	/** 同名过程或函数用于区分重载的正式参数个数。 */
	readonly overloadArity?: number;
	/** 数字越小排序越靠前。 */
	readonly priority: number;
	/** 函数或事件可由 VS Code 解释的参数占位片段。 */
	readonly snippet?: string;
}

/** 一次代码区补全分析的候选和替换范围。 */
export interface SimpleCompletionResult {
	readonly candidates: readonly SimpleCompletionCandidate[];
	readonly end: number;
	readonly query: string;
	readonly start: number;
}

/** 光标位置待替换文本及可能存在的点号限定名。 */
interface CompletionInput {
	readonly end: number;
	readonly linePrefix: string;
	readonly query: string;
	readonly sanitized: string;
	readonly source: string;
	readonly start: number;
}

/** 当前文档中具有明确 Simple 数据类型的绑定种类。 */
export type SimpleBindingKind =
	| "componentBinding"
	| "field"
	| "functionResult"
	| "parameter"
	| "staticField"
	| "variable";

/** 当前文档中可由作用域和声明确认的数据类型绑定。 */
export interface SimpleBinding {
	/** 变体型被当前赋值收窄时保留原声明类型。 */
	readonly declaredTypeName?: string;
	/** 绑定名称在当前用户代码中的声明偏移。 */
	readonly declarationStart?: number;
	readonly kind: SimpleBindingKind;
	readonly name: string;
	/** 源码显式写出的参数传递方式；只用于参数绑定。 */
	readonly passing?: "传值" | "传址";
	/** 当前查询位置可确认的有效类型。 */
	readonly typeName: string;
}

const IDENTIFIER = SIMPLE_IDENTIFIER_PATTERN;
const QUALIFIED_IDENTIFIER = `${IDENTIFIER}(?:\\.${IDENTIFIER})*`;
const TOP_LEVEL_KEYWORDS = languageFacts.contexts.topLevel;
const STATEMENT_KEYWORDS = languageFacts.contexts.statement;
const LANGUAGE_WORDS = new Set(Object.values(languageFacts.words).map((word) => word.text));

/** 将中文名称转换为连续的小写拼音首字母，保留下划线和已有拉丁字符。 */
export function pinyinInitials(value: string): string {
	return pinyin(value, {
		pattern: "first",
		toneType: "none",
		type: "array"
	}).join("").toLowerCase();
}

/** 将注释和字符串替换为空格，同时保持偏移及换行位置不变。 */
function sanitizeSource(source: string): string {
	return maskSimpleIgnoredText(source);
}

/** 返回当前逻辑语句的起点，续行换行不结束语句，冒号与普通换行会结束语句。 */
function logicalStatementStart(source: string, offset: number): number {
	let cursor = offset;

	while (cursor > 0) {
		const newline = source.lastIndexOf("\n", cursor - 1);
		const colon = source.lastIndexOf(":", cursor - 1);

		if (colon > newline) {
			return colon + 1;
		}

		if (newline < 0) {
			return 0;
		}

		const beforeNewline = source[newline - 1] === "\r" ? newline - 2 : newline - 1;
		if (beforeNewline >= 0 && source[beforeNewline] === "_") {
			cursor = beforeNewline;
			continue;
		}

		return newline + 1;
	}

	return 0;
}

/** 将逻辑语句中的合法续行序列替换为空白，保留其余文本和偏移。 */
function normalizeLogicalPrefix(value: string): string {
	return value.replace(/_\r?\n/gu, (continuation) => " ".repeat(continuation.length));
}

/** 从光标向前读取当前待替换标识符。 */
function completionInput(source: string, offset: number): CompletionInput | undefined {
	const sanitized = sanitizeSource(source);

	if (isSimpleIgnoredOffset(source, offset, false)) {
		return undefined;
	}

	let start = offset;
	while (start > 0 && IDENTIFIER_CHARACTER.test(sanitized[start - 1] ?? "")) {
		start -= 1;
	}

	const statementStart = logicalStatementStart(sanitized, offset);
	return {
		end: offset,
		linePrefix: normalizeLogicalPrefix(sanitized.slice(statementStart, offset)),
		query: sanitized.slice(start, offset),
		sanitized,
		source,
		start
	};
}

/** 单次语言分析的词法、块作用域、字段及定义索引；使用结束后即可释放。 */
export interface SimpleSourceAnalysis {
	readonly source: string;
	readonly syntax: SimpleSourceSyntax;
	readonly sanitized: string;
	readonly definitions: ReadonlyMap<string, LibraryDefinitionReference>;
	readonly expressionTokens: readonly SimpleSourceToken[];
	readonly narrowing: Set<SimpleSourceDeclaration>;
	stackAt(offset: number): readonly BlockFrame[];
	members(reference: LibraryDefinitionReference, group: LibraryMemberGroup, name: string): readonly EffectiveLibraryMember[];
	memberAt(offset: number): { readonly receiver: ResolvedSimpleQualifier | undefined; readonly callable: boolean } | undefined;
	receiverBefore(offset: number): { readonly receiver: ResolvedSimpleQualifier | undefined; readonly callable: boolean } | undefined;
}

/** 线性预扫块状态与字段，避免项目诊断对每个名称重复扫描全文。 */
export function createSimpleSourceAnalysis(
	source: string,
	sdk: Sdk | undefined,
	context?: SimpleProjectSemanticContext,
	input: { readonly syntax?: SimpleSourceSyntax; readonly tokens?: readonly SimpleSourceToken[] } = {}
): SimpleSourceAnalysis {
	const syntax = input.syntax ?? analyzeSimpleSourceSyntax(source, context?.currentUnit?.unitType === "接口");
	let sanitized: string | undefined;
	const definitions = buildSemanticDefinitionIndex(sdk, context);
	const expressionTokens = (input.tokens ?? syntax.tokens).filter((token) => token.kind !== "comment" && token.kind !== "continuation");
	const memberIndex = new Map<LibraryDefinitionReference, Map<LibraryMemberGroup, Map<string, EffectiveLibraryMember[]>>>();
	const receiverTypes = new Map<number, ResolvedSimpleQualifier | undefined>();
	const analysis: SimpleSourceAnalysis = {
		source, syntax, definitions, expressionTokens, narrowing: new Set(), stackAt: syntax.blocksAt,
		get sanitized() {
			sanitized ??= maskSimpleIgnoredText(source, syntax.tokens);
			return sanitized;
		},
		members(reference, group, name) {
			let groups = memberIndex.get(reference);
			if (groups === undefined) {
				groups = new Map();
				memberIndex.set(reference, groups);
			}
			let names = groups.get(group);
			if (names === undefined) {
				names = new Map();
				for (const value of getEffectiveMembers(reference, group, definitions)) {
					const entries = names.get(value.member.name) ?? [];
					entries.push(value);
					names.set(value.member.name, entries);
				}
				groups.set(group, names);
			}
			return names.get(name) ?? [];
		},
		memberAt(offset) {
			const index = simpleSourceTokenIndex(expressionTokens, offset);
			if (index < 0 || expressionTokens[index - 1]?.text !== "." || syntax.roleAt(offset) === "type") {
				return undefined;
			}
			return { receiver: expressionReceiverType(index - 2, analysis, context, receiverTypes), callable: callableQualifier(expressionTokens, index - 2) };
		},
		receiverBefore(offset) {
			let low = 0;
			let high = expressionTokens.length;
			while (low < high) {
				const middle = Math.floor((low + high) / 2);
				if (expressionTokens[middle]!.end <= offset) low = middle + 1;
				else high = middle;
			}
			return expressionTokens[low - 1]?.text === "."
				? { receiver: expressionReceiverType(low - 2, analysis, context, receiverTypes), callable: callableQualifier(expressionTokens, low - 2) } : undefined;
		}
	};
	return analysis;
}

/** 资源入口必须没有被代码声明、项目类型、别名或当前单元成员遮蔽。 */
export function isSimpleResourceRoot(analysis: SimpleSourceAnalysis, offset: number, context?: SimpleProjectSemanticContext): boolean {
	if (analysis.syntax.roleAt(offset) === "type" || analysis.syntax.isBlocked("R", offset) || analysis.syntax.resolve("R", offset) !== undefined
		|| resolveSimpleBinding(analysis.source, offset, "R", context, analysis) !== undefined
		|| resolveSimpleDefinitionName("R", analysis.definitions) !== undefined
		|| resolveSimpleNamespaceName("R", analysis.definitions) !== undefined) return false;
	const current = context?.currentUnit === undefined ? undefined : analysis.definitions.get(context.currentUnit.qualifiedName);
	return current === undefined || !(["constants", "variables", "properties", "functions", "events"] as const)
		.some((group) => analysis.members(current, group, "R").length > 0);
}

/** 从文档属性声明读取当前程序单元类型；只用于约束代码区，属性区本身不参与补全。 */
function unitType(context: SimpleProjectSemanticContext | undefined): string | undefined {
	return context?.currentUnit?.unitType;
}

/** 返回块栈中最近的函数式声明。 */
function callableFrame(stack: readonly BlockFrame[]): BlockFrame | undefined {
	return [...stack].reverse().find((frame) => (
		frame.kind === "event"
		|| frame.kind === "function"
		|| frame.kind === "getter"
		|| frame.kind === "procedure"
		|| frame.kind === "setter"
	));
}

/** 将共享语法声明转换为既有语言能力使用的类型绑定。 */
function sourceBinding(declaration: SimpleSourceDeclaration): SimpleBinding | undefined {
	if (!["variable", "parameter", "functionResult"].includes(declaration.kind) || declaration.typeName === undefined) {
		return undefined;
	}
	return {
		declarationStart: declaration.token.start,
		kind: declaration.kind === "parameter" ? "parameter" : declaration.kind === "functionResult" ? "functionResult"
			: declaration.scope.parent === undefined ? declaration.static ? "staticField" : "field" : "variable",
		name: declaration.name,
		passing: declaration.passing,
		typeName: declaration.typeName
	};
}

/** 只枚举光标所在词法作用域内可见的参数、局部变量和返回值。 */
function visibleLocalBindings(source: string, offset: number, _stack: readonly BlockFrame[], analysis?: SimpleSourceAnalysis, context?: SimpleProjectSemanticContext): readonly SimpleBinding[] {
	const syntax = analysis?.syntax ?? analyzeSimpleSourceSyntax(source);
	const names = new Set(syntax.declarations.filter((declaration) => declaration.scope !== syntax.root).map((declaration) => declaration.name));
	return [...names].flatMap((name) => {
		const declaration = syntax.resolve(name, offset);
		const binding = declaration === undefined || declaration.scope === syntax.root ? undefined : sourceBinding(declaration);
		return binding === undefined || declaration === undefined ? [] : [narrowVariantBinding(source, offset, _stack, binding, syntax, declaration, context, analysis)];
	});
}

/** 用光标前最后一次 `创建` 赋值收窄变体型，未知动态值仍保持变体型。 */
function narrowVariantBinding(
	source: string,
	offset: number,
	stack: readonly BlockFrame[],
	binding: SimpleBinding,
	syntax: SimpleSourceSyntax,
	declaration: SimpleSourceDeclaration,
	context?: SimpleProjectSemanticContext,
	analysis?: SimpleSourceAnalysis
): SimpleBinding {
	if (binding.typeName !== "变体型" || analysis?.narrowing.has(declaration)) {
		return binding;
	}

	const callable = callableFrame(stack);
	const start = Math.max(binding.declarationStart ?? 0, callable?.start ?? 0);
	let narrowedType = declaration.createdTypeName;
	analysis?.narrowing.add(declaration);
	try {
		for (const statement of simpleSourceStatements(syntax.tokens)) {
			let depth = 0;
			for (let index = 0; index < statement.length; index += 1) {
				const target = statement[index]!;
				if (target.text === "(") depth += 1;
				else if (target.text === ")") depth -= 1;
				const previous = statement[index - 1];
				const inline = previous?.text === "则" || previous?.text === "否则";
				if (target.start < start || statement.at(-1)!.end >= offset) continue;
				let equal = index + 1;
				let sameTarget = target.text === binding.name && syntax.resolve(binding.name, target.start) === declaration;
				if (!sameTarget && declaration.scope === syntax.root) {
					let end = index;
					while (statement[end + 1]?.text === "." && statement[end + 2]?.kind === "word") end += 2;
					const qualifier = statement.slice(index, end - 1).map((token) => token.text).join("");
					const self = qualifier === "本对象" && !simpleExecutionContext(syntax, offset, context?.currentUnit?.name).static;
					const ownType = declaration.static && [context?.currentUnit?.name, context?.currentUnit?.qualifiedName].includes(qualifier)
						&& syntax.resolve(target.text, target.start) === undefined;
					sameTarget = end > index && statement[end]?.text === binding.name && (self || ownType);
					equal = end + 1;
				}
				if (!sameTarget) continue;
				const loop = statement[0]?.text === "循环" && index === (statement[1]?.text === "每个" ? 2 : 1);
				if (loop) { narrowedType = undefined; continue; }
				if (depth > 0 && statement[equal]?.text !== ".") {
					const call = findCallContext(source, target.start, syntax);
					if (call !== undefined) {
						const arity = findCallableArgumentCount(source, call.nameStart + call.name.length);
						const members = analysis === undefined ? [] : resolveSimpleCallMembers(call, analysis, context)
							.filter(({ member }) => arity === undefined || (member.params?.length ?? 0) === arity);
						if (members.length === 0 || members.some(({ member }) => member.params?.[call.activeParameter]?.byRef === true)) narrowedType = undefined;
					}
					continue;
				}
				if (depth !== 0 || index !== 0 && !inline || statement[equal]?.text !== "=") continue;
				const writeStack = syntax.blocksAt(target.start);
				const guaranteed = !inline && writeStack.length <= stack.length && writeStack.every((frame, index) => frame.start === stack[index]?.start);
				// 同名内层变量不是当前绑定；无法确定执行路径或动态赋值时撤销收窄。
				narrowedType = guaranteed ? simpleCreatedType(statement.slice(equal + 1), source) : undefined;
			}
		}
	} finally {
		analysis?.narrowing.delete(declaration);
	}

	return narrowedType === undefined
		? binding
		: { ...binding, declaredTypeName: binding.typeName, typeName: narrowedType };
}

/** 将源码绑定转换为首拼补全候选。 */
function bindingCandidate(binding: SimpleBinding, priority: number): SimpleCompletionCandidate {
	const labels: Readonly<Record<SimpleBindingKind, string>> = {
		componentBinding: "组件实例",
		field: "单元变量",
		functionResult: "函数返回值",
		parameter: "参数",
		staticField: "静态成员变量",
		variable: "局部变量"
	};
	return {
		...(binding.kind !== "functionResult" && binding.typeName.includes("(") ? { array: true as const } : {}),
		valueType: binding.typeName,
		writable: true,
		detail: `${labels[binding.kind]} · ${binding.typeName}`,
		initials: pinyinInitials(binding.name),
		kind: "variable",
		name: binding.name,
		priority
	};
}

/** 查找当前函数式作用域内最后一个同名参数或变量声明。 */
function resolveTypedBinding(
	sanitized: string,
	offset: number,
	stack: readonly BlockFrame[],
	name: string,
	context?: SimpleProjectSemanticContext,
	analysis?: SimpleSourceAnalysis
): SimpleBinding | undefined {
	const syntax = analysis?.syntax ?? analyzeSimpleSourceSyntax(sanitized, context?.currentUnit?.unitType === "接口");
	const direct = syntax.declarationAt(offset, name);
	if (direct === undefined && syntax.isBlocked(name, offset)) return undefined;
	const declaration = direct ?? syntax.resolve(name, offset);
	if (declaration !== undefined) {
		const binding = sourceBinding(declaration);
		return binding === undefined || binding.kind === "field" && simpleExecutionContext(syntax, offset, context?.currentUnit?.name).static ? undefined
			: narrowVariantBinding(analysis?.source ?? sanitized, offset, stack, binding, syntax, declaration, context, analysis);
	}
	const component = context?.currentUnit?.definition.variables?.find((member) => member.component === true && member.name === name);
	return component?.type === undefined || simpleExecutionContext(syntax, offset, context?.currentUnit?.name).static ? undefined : { kind: "componentBinding", name, typeName: component.type };
}

/**
 * 解析指定源码位置可见的参数、变量、字段、函数返回值或组件绑定。
 *
 * @param source 完整 Simple 源码。
 * @param offset 当前查询位置。
 * @param name 待解析的标识符。
 * @returns 已确认作用域与类型的源码绑定；无法确认时返回 `undefined`。
 */
export function resolveSimpleBinding(
	source: string,
	offset: number,
	name: string,
	context?: SimpleProjectSemanticContext,
	analysis?: SimpleSourceAnalysis
): SimpleBinding | undefined {
	if (offset < 0 || offset > source.length || name.length === 0) {
		return undefined;
	}

	const current = analysis ?? createSimpleSourceAnalysis(source, undefined, context);
	if (isSimpleEventTarget(current.syntax, offset)
		|| current.syntax.declarationAt(offset, name) === undefined && current.syntax.roleAt(offset) === "type") {
		return undefined;
	}
	return resolveTypedBinding(current.sanitized, offset, current.stackAt(offset), name, context, current);
}

/**
 * 按作用域查询候选名称，供改名和移动的冲突预检使用。
 *
 * 此查询不把当前位置视为候选名称的源码引用，因此类型位置也能检查同名变量
 * 是否会遮蔽拟采用的短名；实际引用解析仍通过 resolveSimpleBinding。
 */
export function lookupSimpleBinding(source: string, offset: number, name: string, context?: SimpleProjectSemanticContext, analysis?: SimpleSourceAnalysis): SimpleBinding | undefined {
	if (offset < 0 || offset > source.length || name.length === 0) {
		return undefined;
	}
	const current = analysis ?? createSimpleSourceAnalysis(source, undefined, context);
	return resolveTypedBinding(current.sanitized, offset, current.stackAt(offset), name, context, current);
}

/** 从当前替换范围前读取点号限定名。 */
function qualifierBefore(input: CompletionInput): string | undefined {
	let cursor = input.start;
	while (cursor > 0 && /[ \t]/u.test(input.sanitized[cursor - 1] ?? "")) {
		cursor -= 1;
	}

	if (input.sanitized[cursor - 1] !== ".") {
		return undefined;
	}

	cursor -= 1;
	while (cursor > 0 && /[ \t]/u.test(input.sanitized[cursor - 1] ?? "")) {
		cursor -= 1;
	}

	const end = cursor;
	while (
		cursor > 0
		&& (
			IDENTIFIER_CHARACTER.test(input.sanitized[cursor - 1] ?? "")
			|| input.sanitized[cursor - 1] === "."
		)
	) {
		cursor -= 1;
	}

	return cursor === end ? undefined : input.sanitized.slice(cursor, end);
}

/** 将编译器或 SDK 定义转换为通用补全项。 */
function definitionCandidate(definition: LibraryDefinition, priority: number): SimpleCompletionCandidate {
	return {
		description: definition.description,
		detail: definition.kind,
		initials: pinyinInitials(definition.name),
		kind: definition.kind === "type" ? "type" : definition.kind === "literal" ? "constant" : "keyword",
		name: definition.name,
		priority
	};
}

/** 将 SDK 对象或类型转换为补全项。 */
function typeCandidate(reference: LibraryDefinitionReference, priority: number): SimpleCompletionCandidate {
	return {
		description: reference.definition.description,
		detail: `${reference.manifest.name} · ${reference.definition.kind ?? "类型"}`,
		initials: pinyinInitials(reference.definition.name),
		kind: "type",
		name: reference.definition.name,
		priority
	};
}

/** 将类库成员转换为补全项。 */
function memberCandidate(
	member: LibraryMember,
	group: LibraryMemberGroup,
	owner: string,
	priority: number,
	eventDeclaration = false
): SimpleCompletionCandidate {
	const kinds: Readonly<Record<LibraryMemberGroup, SimpleCompletionKind>> = {
		constants: "constant",
		events: "event",
		functions: "function",
		properties: "property",
		variables: "variable"
	};

	const parameters = (member.params ?? []).map((parameter) => {
		const passing = parameter.passing ?? (parameter.byRef === true ? "传址" : undefined);
		const type = parameter.type === undefined ? "" : ` 为 ${parameter.type}`;
		return `${passing === undefined ? "" : `${passing} `}${parameter.name}${type}`;
	});
	const callable = group === "functions" || group === "events";
	const returnType = group === "functions" && member.return !== undefined
		? ` 为 ${member.return}`
		: "";
	const signature = callable
		? `${member.name}(${parameters.join(", ")})${returnType}`
		: `${member.name}${member.type === undefined ? "" : ` 为 ${member.type}`}`;
	const label = group === "constants" ? "常量" : group === "events" ? "事件"
		: group === "properties" ? "属性" : group === "variables" ? "变量" : member.return === undefined ? "过程" : "函数";
	const snippetParameters = (member.params ?? []).map((parameter, index) => {
		const passing = parameter.passing ?? (parameter.byRef === true ? "传址" : undefined);
		const type = eventDeclaration && parameter.type !== undefined ? ` 为 ${parameter.type}` : "";
		return `${eventDeclaration && passing !== undefined ? `${passing} ` : ""}\${${index + 1}:${parameter.name}}${type}`;
	});

	return {
		...(group === "functions" ? { callable: true as const } : {}),
		...(!callable && member.type?.includes("(") === true ? { array: true as const } : {}),
		...(member.readable === false ? { readable: false as const } : {}),
		...((group === "variables" || group === "properties") && member.writable !== false ? { writable: true as const } : {}),
		valueType: callable ? member.return : member.type,
		description: member.description,
		detail: `${owner} · ${label} ${signature}`,
		initials: pinyinInitials(member.name),
		kind: kinds[group],
		name: member.name,
		overloadArity: group === "functions" ? member.params?.length ?? 0 : undefined,
		priority,
		snippet: callable ? `${member.name}(${snippetParameters.join(", ")})` : undefined
	};
}

/** 别名指向的实际成员，保留声明位置及分组供补全和参数提示共同使用。 */
export interface SimpleAliasMember extends EffectiveLibraryMember {
	readonly group: LibraryMemberGroup;
}

/** 解析成员别名和连续别名，类型别名、循环及无效目标不回退到同名成员。 */
export function resolveSimpleAliasMembers(
	name: string,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>,
	context?: SimpleProjectSemanticContext
): readonly SimpleAliasMember[] {
	const alias = context?.currentUnit?.aliases.find((value) => value.name === name);
	if (alias === undefined || resolveSimpleDefinitionName(name, definitions) !== undefined) return [];
	let targetName = alias.target;
	const seen = new Set([alias.name]);
	for (let next = context?.currentUnit?.aliases.find((value) => value.name === targetName); next !== undefined;
		next = context?.currentUnit?.aliases.find((value) => value.name === targetName)) {
		if (seen.has(next.name)) return [];
		seen.add(next.name); targetName = next.target;
	}
	const separator = targetName.lastIndexOf(".");
	const groups = ["constants", "functions", "variables"] as const;
	let owner = separator < 0 ? undefined : resolveSimpleDefinitionName(targetName.slice(0, separator), definitions);
	if (separator < 0) {
		const current = definitions.get(context?.currentUnit?.qualifiedName ?? "");
		owner = current !== undefined && groups.some((group) => getEffectiveMembers(current, group, definitions).some((value) => value.member.name === targetName))
			? current : [...new Set(definitions.values())].find((reference) => groups.some((group) => reference.definition[group]?.some((value) => value.name === targetName && value.global === true)));
	}
	if (owner !== undefined) {
		for (const group of groups) {
			const values = getEffectiveMembers(owner, group, definitions).filter((value) => value.member.name === targetName.slice(separator + 1)
				&& isSimpleMemberAccessible(value.member, group, "static"));
			if (values.length > 0) return values.map((value) => ({ ...value, group }));
		}
	}
	return [];
}

/** 统一解析当前调用的有效成员，参数提示与传址写入分析共用遮蔽、继承和静态规则。 */
export function resolveSimpleCallMembers(call: CallContext, analysis: SimpleSourceAnalysis, context?: SimpleProjectSemanticContext): readonly SimpleAliasMember[] {
	const event = call.event === true;
	const group: LibraryMemberGroup = event ? "events" : "functions";
	const access = analysis.memberAt(call.nameStart);
	if (!event && access?.callable === false) return [];
	if (access !== undefined || call.qualifier !== undefined) {
		const receiver = access?.receiver ?? (call.qualifier === undefined ? undefined : resolveQualifier(call.qualifier, analysis.sanitized,
			call.nameStart, analysis.stackAt(call.nameStart), analysis.definitions, context, analysis));
		return receiver === undefined ? [] : getEffectiveMembers(receiver.reference, group, analysis.definitions)
			.filter(({ member }) => member.name === call.name && isSimpleMemberAccessible(member, group, receiver.access))
			.map((value) => ({ ...value, group }));
	}
	if (!event && analysis.syntax.isBlocked(call.name, call.nameStart)) return [];
	const declaration = analysis.syntax.resolve(call.name, call.nameStart);
	if (!event && declaration?.kind === "alias") return resolveSimpleAliasMembers(call.name, analysis.definitions, context).filter((value) => value.group === "functions");
	if (!event && declaration !== undefined && !["function", "procedure", "functionResult"].includes(declaration.kind)) return [];
	const current = context?.currentUnit === undefined ? undefined : analysis.definitions.get(context.currentUnit.qualifiedName);
	const staticContext = simpleExecutionContext(analysis.syntax, call.nameStart, context?.currentUnit?.name).static;
	const members = current === undefined ? [] : getEffectiveMembers(current, group, analysis.definitions)
		.filter(({ member }) => member.name === call.name && (!staticContext || group === "functions" && (member.global === true || isStaticProjectMember(member))))
		.map((value) => ({ ...value, group }));
	const shadowed = declaration !== undefined || current !== undefined && (["variables", "constants", "properties", "functions", "events"] as const)
		.some((kind) => getEffectiveMembers(current, kind, analysis.definitions).some(({ member }) => member.name === call.name));
	if (members.length > 0 || shadowed || event) return members;
	return [...new Set(analysis.definitions.values())].filter((owner) => owner.manifest.kind !== "project" && owner.manifest.kind !== "compiler")
		.flatMap((owner) => (owner.definition.functions ?? []).filter((member) => member.name === call.name && member.global === true)
			.map((member) => ({ owner, member, inherited: false, group: "functions" as const })));
}

/** 将当前单元别名转换为补全候选，并在目标是类型时使用类型图标。 */
function aliasCandidate(alias: SimpleAliasSymbol, definitions: ReadonlyMap<string, LibraryDefinitionReference>, priority: number, context?: SimpleProjectSemanticContext): SimpleCompletionCandidate {
	const target = resolveSimpleDefinitionName(alias.name, definitions);
	const value = resolveSimpleAliasMembers(alias.name, definitions, context)[0];
	const member = value === undefined ? undefined : memberCandidate(value.member, value.group, value.owner.definition.name, priority);
	return {
		...member,
		description: alias.description ?? member?.description,
		detail: `别名 · ${alias.target}`,
		initials: pinyinInitials(alias.name),
		kind: target !== undefined && isSdkTypeKind(target.definition.kind) ? "type" : "reference",
		name: alias.name,
		priority,
		snippet: undefined
	};
}

/** 枚举当前单元中目标明确为类型的别名。 */
function typeAliasCandidates(
	context: SimpleProjectSemanticContext | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>,
	priority: number
): readonly SimpleCompletionCandidate[] {
	return (context?.currentUnit?.aliases ?? []).flatMap((alias) => {
		if (!isSimpleAliasName(alias.name, definitions)) return [];
		const candidate = aliasCandidate(alias, definitions, priority, context);
		return candidate.kind === "type" ? [candidate] : [];
	});
}

/** 从编译器清单按名称选择已确认适用于当前语境的关键字。 */
function compilerCandidates(sdk: Sdk, names: readonly string[], priority: number): SimpleCompletionCandidate[] {
	const compiler = sdk.manifests.find((manifest) => manifest.kind === "compiler");
	if (compiler === undefined) {
		return [];
	}

	const definitions = new Map(
		compiler.categories.flatMap((category) => category.definitions).map((definition) => [definition.name, definition])
	);

	return names.flatMap((name) => {
		const definition = definitions.get(name);
		return definition === undefined ? [] : [definitionCandidate(definition, priority)];
	});
}

/** 枚举可在声明类型或对象限定位置出现的 SDK 类型。 */
function semanticTypeCandidates(
	definitions: ReadonlyMap<string, LibraryDefinitionReference>,
	priority: number
): SimpleCompletionCandidate[] {
	return [...definitions.entries()]
		.filter(([name, reference]) => (
			reference.manifest.kind !== "compiler"
			&& isSdkTypeKind(reference.definition.kind)
			&& resolveSimpleDefinitionName(name, definitions) === reference
		))
		.map(([name, reference]) => ({
			...typeCandidate(reference, priority),
			initials: pinyinInitials(name),
			name
		}));
}

/**
 * 枚举别名右侧允许写入的完整项目单元名和完整类库类名。
 *
 * 项目单元始终优先；编译器基本类型、短名称索引和没有完整类名的清单定义不参与。
 */
function aliasTargetCandidates(
	sdk: Sdk | undefined,
	context: SimpleProjectSemanticContext | undefined
): SimpleCompletionCandidate[] {
	const projectTypes = (context?.manifest.categories ?? []).flatMap((category) => (
		category.definitions
			.filter((definition) => isSdkTypeKind(definition.kind))
			.map((definition) => ({
				description: definition.description,
				detail: `${context?.manifest.name ?? "项目"} · 项目单元`,
				initials: pinyinInitials(definition.name),
				kind: "type" as const,
				name: definition.name,
				priority: 0
			}))
	));
	const libraryTypes = (sdk?.manifests ?? []).flatMap((manifest) => (
		manifest.kind === "compiler"
			? []
			: manifest.categories.flatMap((category) => category.definitions.flatMap((definition) => {
				const typeName = typeof definition.type === "string" ? definition.type.trim() : "";
				return !isSdkTypeKind(definition.kind) || typeName.length === 0
					? []
					: [{
						description: definition.description,
						detail: `${manifest.name} · ${definition.name}`,
						initials: pinyinInitials(typeName),
						kind: "type" as const,
						name: typeName,
						priority: 1
					}];
			}))
	));

	return [...projectTypes, ...libraryTypes];
}

/** 枚举限定名前缀后的下一层命名空间或类型短名称。 */
function namespaceMemberCandidates(
	qualifier: string,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): readonly SimpleCompletionCandidate[] {
	const candidates = new Map<string, SimpleCompletionCandidate>();
	if (qualifier.length === 0) {
		/* 首段也允许当前命名空间下的相对路径，不能只枚举全局根名称。 */
		for (const [name, reference] of definitions) {
			if (reference.manifest.kind === "compiler") continue;
			for (const segment of name.split(".").slice(0, -1)) {
				const namespace = resolveSimpleNamespaceName(segment, definitions);
				if (namespace === undefined) continue;
				candidates.set(segment, {
					detail: `命名空间 · ${namespace}`,
					initials: pinyinInitials(segment), kind: "reference", name: segment, priority: 0
				});
			}
		}
		return [...candidates.values()];
	}
	const namespace = resolveSimpleNamespaceName(qualifier, definitions);
	if (namespace === undefined) return [];
	const prefix = `${namespace}.`;
	for (const [name, reference] of definitions) {
		if (reference.manifest.kind === "compiler" || !name.startsWith(prefix)) {
			continue;
		}
		const remainder = name.slice(prefix.length);
		const segment = remainder.split(".")[0];
		if (segment === undefined || segment.length === 0) {
			continue;
		}
		const isNamespace = remainder.includes(".");
		if (isNamespace && resolveSimpleNamespaceName(`${qualifier}.${segment}`, definitions) !== `${prefix}${segment}`) continue;
		const candidate: SimpleCompletionCandidate = {
			description: isNamespace ? undefined : reference.definition.description,
			detail: isNamespace ? `命名空间 · ${prefix}${segment}` : `类型 · ${name}`,
			initials: pinyinInitials(segment),
			kind: isNamespace ? "reference" : "type",
			name: segment,
			priority: 0
		};
		if (!candidates.has(`${candidate.kind}:${segment}`)) {
			candidates.set(`${candidate.kind}:${segment}`, candidate);
		}
	}
	return [...candidates.values()];
}

/** 枚举当前项目真实 res 目录生成的 R 成员，不读取 R.txt 或资源编号。 */
function resourceMemberCandidates(
	context: SimpleProjectSemanticContext | undefined
): readonly SimpleCompletionCandidate[] {
	return (context?.resources?.symbols ?? []).map((symbol) => ({
		description: `Android ${symbol.resourceType} 资源。`,
		detail: `${context?.manifest.name ?? "项目"} · R 资源`,
		initials: pinyinInitials(symbol.name),
		kind: "constant" as const,
		name: symbol.name,
		priority: 0
	}));
}

/** 枚举清单明确标记为全局别名的函数、常量和静态数据。 */
function globalValueCandidates(sdk: Sdk, priority: number): SimpleCompletionCandidate[] {
	const candidates: SimpleCompletionCandidate[] = [];

	for (const reference of buildSemanticDefinitionIndex(sdk, undefined).values()) {
		for (const group of ["constants", "variables", "functions"] as const) {
			for (const member of reference.definition[group] ?? []) {
				if (member.global === true) {
					candidates.push(memberCandidate(member, group, reference.definition.name, priority));
				}
			}
		}
	}

	return candidates;
}

export interface ResolvedSimpleQualifier {
	readonly access: "instance" | "static";
	readonly directCurrentUnit: boolean;
	readonly reference: LibraryDefinitionReference;
}

/** 读取数组类型的维数，维度表达式内的逗号不算新的维度。 */
function arrayRank(typeName: string | undefined): number {
	const open = typeName?.indexOf("(") ?? -1;
	if (open < 0 || typeName === undefined) return 0;
	let rank = 1;
	let depth = 0;
	for (const token of scanSimpleSource(typeName.slice(open))) {
		if (token.text === "(") depth += 1;
		else if (token.text === ")") depth -= 1;
		else if (token.text === "," && depth === 1) rank += 1;
	}
	return rank;
}

/** 只有明确执行数组索引时才解析元素类型，数组自身不冒充元素对象。 */
function definitionForType(
	typeName: string | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>,
	context: SimpleProjectSemanticContext | undefined,
	owner?: LibraryDefinitionReference,
	element = false
): LibraryDefinitionReference | undefined {
	if (typeName === undefined || !element && arrayRank(typeName) > 0) {
		return undefined;
	}

	const normalized = typeName.split("(")[0]!.trim();
	if (owner !== undefined && owner.manifest.kind !== "project") return definitions.get(normalized);
	const declaringUnit = owner === undefined ? undefined : context?.units?.find((unit) => unit.filePath === owner.definition.sourceFile);
	return resolveSimpleDefinitionName(normalized, definitions, declaringUnit);
}

/** 按当前静态或实例访问方式查找成员产生的下一段对象类型。 */
function memberResultDefinition(
	resolved: ResolvedSimpleQualifier,
	memberName: string,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>,
	context: SimpleProjectSemanticContext | undefined,
	analysis?: SimpleSourceAnalysis,
	arity?: number,
	offset?: number
): LibraryDefinitionReference | undefined {
	const groups: readonly LibraryMemberGroup[] = resolved.access === "static"
		? ["constants", "functions", "variables"]
		: ["constants", "properties", "variables", "functions"];

	for (const group of groups) {
		const candidates = (analysis?.members(resolved.reference, group, memberName)
			?? getEffectiveMembers(resolved.reference, group, definitions).filter((candidate) => candidate.member.name === memberName))
			.filter((candidate) => isSimpleMemberAccessible(candidate.member, group, resolved.access));
		const value = group === "functions" && arity !== undefined
			? candidates.find((candidate) => (candidate.member.params?.length ?? 0) === arity) ?? (candidates.length === 1 ? candidates[0] : undefined)
			: candidates[0];
		if (value === undefined) {
			continue;
		}
		if (value.member.readable === false || group === "functions" && arity === undefined) return undefined;
		let typeName = group === "functions" ? value.member.return : value.member.type;
		if (typeName === "变体型" && group === "variables" && resolved.directCurrentUnit && analysis !== undefined && offset !== undefined
			&& typeof value.owner.definition.sourceFile === "string" && context?.currentUnit !== undefined
			&& sameFilePath(value.owner.definition.sourceFile, context.currentUnit.filePath)) {
			const declaration = analysis.syntax.declarationsNamed(memberName).find((item) => item.kind === "variable" && item.scope === analysis.syntax.root);
			const binding = declaration === undefined ? undefined : sourceBinding(declaration);
			if (binding !== undefined && declaration !== undefined) typeName = narrowVariantBinding(analysis.source, offset, analysis.stackAt(offset), binding, analysis.syntax, declaration, context, analysis).typeName;
		}
		const indexed = group !== "functions" && arity !== undefined;
		if (indexed && (arrayRank(typeName) === 0 || arrayRank(typeName) !== arity)) return undefined;

		return definitionForType(
			typeName,
			definitions,
			context,
			value.owner,
			indexed
		);
	}

	return undefined;
}

/** 查找当前逻辑语句中的左括号，不跨越未续行的换行或冒号。 */
function expressionOpening(tokens: readonly SimpleSourceToken[], close: number): number {
	let depth = 0;
	for (let index = close; index >= 0; index -= 1) {
		const token = tokens[index]!;
		if (token.kind === "separator") {
			break;
		}
		if (token.text === ")") {
			depth += 1;
		} else if (token.text === "(" && --depth === 0) {
			return index;
		}
	}
	return -1;
}

/** 括号令牌已排除字符串内分隔符，按最外层逗号计算实参数量。 */
function expressionArity(tokens: readonly SimpleSourceToken[], open: number, close: number): number {
	if (close === open + 1) {
		return 0;
	}
	let count = 1;
	let depth = 0;
	for (let index = open + 1; index < close; index += 1) {
		const text = tokens[index]!.text;
		if (text === "(") {
			depth += 1;
		} else if (text === ")") {
			depth -= 1;
		} else if (text === "," && depth === 0) {
			count += 1;
		}
	}
	return count;
}

/** 解析未限定调用或数组索引的结果类型，未定型的局部声明仍遮蔽外部同名函数。 */
function rootCallResultType(callee: SimpleSourceToken, arity: number, analysis: SimpleSourceAnalysis, context?: SimpleProjectSemanticContext): LibraryDefinitionReference | undefined {
	if (analysis.syntax.isBlocked(callee.text, callee.start)) return undefined;
	const stack = analysis.stackAt(callee.start);
	const binding = resolveTypedBinding(analysis.sanitized, callee.start, stack, callee.text, context, analysis);
	if (binding !== undefined) {
		const rank = arrayRank(binding.typeName);
		return rank > 0 ? rank === arity ? definitionForType(binding.typeName, analysis.definitions, context, undefined, true) : undefined
			: binding.kind === "functionResult" ? definitionForType(binding.typeName, analysis.definitions, context) : undefined;
	}
	const local = analysis.syntax.resolve(callee.text, callee.start);
	if (local?.kind === "alias") {
		const value = resolveSimpleAliasMembers(callee.text, analysis.definitions, context)
			.find((value) => value.member.readable !== false && (value.group === "functions"
				? (value.member.params?.length ?? 0) === arity : arity > 0 && arrayRank(value.member.type) === arity));
		return value === undefined ? undefined : definitionForType(value.group === "functions" ? value.member.return : value.member.type,
			analysis.definitions, context, value.owner, value.group !== "functions");
	}
	if (local?.kind === "variable" || local?.kind === "parameter" || local?.kind === "constant") {
		return undefined;
	}
	const current = context?.currentUnit === undefined ? undefined : analysis.definitions.get(context.currentUnit.qualifiedName);
	if (current !== undefined && (["variables", "properties"] as const).some((group) => analysis.members(current, group, callee.text).length > 0)) {
		return memberResultDefinition({ reference: current, access: simpleExecutionContext(analysis.syntax, callee.start, context?.currentUnit?.name).static ? "static" : "instance",
			directCurrentUnit: true }, callee.text, analysis.definitions, context, analysis, arity, callee.start);
	}
	if (context?.currentUnit === undefined) {
		const declaration = analysis.syntax.declarationsNamed(callee.text).find((value) => value.scope === analysis.syntax.root
			&& value.kind === "function" && (value.parameters?.length ?? 0) === arity);
		if (declaration !== undefined) return !simpleExecutionContext(analysis.syntax, callee.start).static || declaration.static
			? definitionForType(declaration.typeName, analysis.definitions, context) : undefined;
	}
	// 调用结果与参数提示共用有效调用集合，不绕过静态检查直接读取函数声明。
	const value = resolveSimpleCallMembers({ name: callee.text, nameStart: callee.start, activeParameter: 0 }, analysis, context)
		.find(({ member }) => (member.params?.length ?? 0) === arity);
	return value === undefined ? undefined : definitionForType(value.member.return, analysis.definitions, context, value.owner);
}

/** 当前编译器只允许对纯限定标识符调用，调用结果、下标和分组之后只能继续读取成员。 */
function callableQualifier(tokens: readonly SimpleSourceToken[], end: number): boolean {
	if (tokens[end]?.kind !== "word") return false;
	let start = end;
	while (tokens[start - 1]?.text === "." && tokens[start - 2]?.kind === "word") start -= 2;
	return tokens[start - 1]?.text !== "." && tokens[start]!.text !== "本对象";
}

/**
 * 沿词法令牌推导点号左侧的表达式类型，复用同次分析的绑定与成员索引。
 *
 * 调用和数组索引使用实际返回或元素类型；未确认的表达式保持未知，不能回退
 * 到某个恰好同名的局部变量。结果仅存活于本次分析，不建立项目级表达式缓存。
 */
function expressionReceiverType(
	end: number,
	analysis: SimpleSourceAnalysis,
	context: SimpleProjectSemanticContext | undefined,
	cache: Map<number, ResolvedSimpleQualifier | undefined>
): ResolvedSimpleQualifier | undefined {
	if (cache.has(end)) {
		return cache.get(end);
	}
	const tokens = analysis.expressionTokens;
	const token = tokens[end];
	cache.set(end, undefined);
	if (token === undefined || token.kind === "separator") {
		return undefined;
	}
	const instance = (reference: LibraryDefinitionReference | undefined): ResolvedSimpleQualifier | undefined => reference === undefined
		? undefined : { reference, access: "instance", directCurrentUnit: false };
	const infer = (index: number) => expressionReceiverType(index, analysis, context, cache);
	let result: ResolvedSimpleQualifier | undefined;
	if (token.kind === "word") {
		let start = end;
		while (start >= 2 && tokens[start - 1]?.text === "." && tokens[start - 2]?.kind === "word") {
			start -= 2;
		}
		if (tokens[start - 1]?.text !== ".") {
			const qualifier = tokens.slice(start, end + 1).map((part) => part.text).join("");
			const lookupOffset = Math.min(token.start, analysis.source.length);
			result = resolveQualifier(qualifier, analysis.sanitized, lookupOffset, analysis.stackAt(lookupOffset), analysis.definitions, context, analysis);
		}
		if (result === undefined && tokens[end - 1]?.text === ".") {
			const receiver = infer(end - 2);
			if (receiver !== undefined) {
				result = instance(memberResultDefinition(receiver, token.text, analysis.definitions, context, analysis, undefined, token.start));
			}
		}
	} else if (token.text === ")") {
		const open = expressionOpening(tokens, end);
		if (open >= 0) {
			const callee = tokens[open - 1];
			if (callee?.kind === "word" && (tokens[open - 2]?.text === "." || !LANGUAGE_WORDS.has(callee.text))) {
				const arity = expressionArity(tokens, open, end);
				if (tokens[open - 2]?.text === ".") {
					const receiver = infer(open - 3);
					if (receiver !== undefined && callableQualifier(tokens, open - 3)) {
						result = instance(memberResultDefinition(receiver, callee.text, analysis.definitions, context, analysis, arity, callee.start));
					}
				} else {
					result = instance(rootCallResultType(callee, arity, analysis, context));
				}
			} else if (tokens[open + 1]?.text === "创建" && tokens[open + 2]?.kind === "word") {
				let last = open + 3;
				while (tokens[last]?.text === "." && tokens[last + 1]?.kind === "word") {
					last += 2;
				}
				if (last === end || tokens[last]?.text === "位于") {
					result = instance(definitionForType(tokens.slice(open + 2, last).map((part) => part.text).join(""), analysis.definitions, context));
				}
			} else {
				let depth = 0;
				let pathOnly = true;
				let expectName = true;
				let memberName = false;
				for (let index = open + 1; index < end; index += 1) {
					const part = tokens[index]!;
					if (part.text === "(") {
						if (depth === 0 && expectName && index !== open + 1) {
							pathOnly = false;
						}
						depth += 1;
					} else if (part.text === ")") {
						depth -= 1;
						if (depth === 0) {
							expectName = false;
						}
					} else if (depth === 0) {
						if (part.text === "." && !expectName) {
							expectName = true;
							memberName = true;
						} else if (part.kind === "word" && expectName && (memberName || part.text === "本对象" || !LANGUAGE_WORDS.has(part.text))) {
							expectName = false;
							memberName = false;
						} else {
							pathOnly = false;
						}
					}
				}
				if (pathOnly && !expectName) {
					result = infer(end - 1);
				}
			}
		}
	}
	cache.set(end, result);
	return result;
}

/**
 * 逐段解析点号左侧限定链，并把静态变量、字段或属性的声明类型传给下一段。
 *
 * 定义名称可能自身包含命名空间点号，因此先选择能命中的最长定义前缀，再把
 * 剩余片段作为成员依次解析。
 */
function resolveQualifier(
	qualifier: string,
	sanitized: string,
	offset: number,
	stack: readonly BlockFrame[],
	definitions: ReadonlyMap<string, LibraryDefinitionReference>,
	context: SimpleProjectSemanticContext | undefined,
	analysis?: SimpleSourceAnalysis
): ResolvedSimpleQualifier | undefined {
	const segments = qualifier.split(".");
	const first = segments[0];
	if (first === undefined) {
		return undefined;
	}
	if (analysis?.syntax.roleAt(offset) !== "type" && analysis?.syntax.isBlocked(first, offset)) return undefined;
	const currentUnit = context?.currentUnit;
	const directCurrentUnit = currentUnit !== undefined && (
		resolveSimpleDefinitionName(qualifier, definitions)?.definition.sourceFile === currentUnit.filePath
	);

	const binding = analysis?.syntax.roleAt(offset) === "type" ? undefined : resolveTypedBinding(sanitized, offset, stack, first, context, analysis);
	const sourceDeclaration = analysis?.syntax.roleAt(offset) === "type" ? undefined : analysis?.syntax.resolve(first, offset);
	if (binding === undefined && (sourceDeclaration?.kind === "variable" || sourceDeclaration?.kind === "parameter" || sourceDeclaration?.kind === "constant")) {
		return undefined;
	}
	let consumed = 0;
	let resolved: ResolvedSimpleQualifier | undefined;
	if (first === "本对象" && currentUnit !== undefined && !simpleExecutionContext(analysis?.syntax ?? analyzeSimpleSourceSyntax(sanitized), offset, context?.currentUnit?.name).static) {
		const reference = definitions.get(currentUnit.qualifiedName);
		if (reference !== undefined) {
			consumed = 1;
			resolved = { access: "instance", directCurrentUnit: true, reference };
		}
	}
	if (binding !== undefined) {
		const reference = definitionForType(binding.typeName, definitions, context);
		if (reference === undefined) return undefined;
		if (reference !== undefined) {
			consumed = 1;
			resolved = { access: "instance", directCurrentUnit, reference };
		}
	}
	if (resolved === undefined && binding === undefined && sourceDeclaration?.kind === "alias") {
		const value = resolveSimpleAliasMembers(first, definitions, context).find((value) => value.group !== "functions" && value.member.readable !== false);
		const reference = value === undefined ? undefined : definitionForType(value.member.type, definitions, context, value.owner);
		if (reference !== undefined) {
			consumed = 1;
			resolved = { access: "instance", directCurrentUnit: false, reference };
		}
	}
	if (resolved === undefined && binding === undefined && (sourceDeclaration === undefined || sourceDeclaration.kind === "property")
		&& analysis?.syntax.roleAt(offset) !== "type" && currentUnit !== undefined) {
		const current = definitions.get(currentUnit.qualifiedName);
		if (current !== undefined && (["variables", "properties", "constants"] as const).some((group) =>
			getEffectiveMembers(current, group, definitions).some((value) => value.member.name === first))) {
			const modes = simpleExecutionContext(analysis?.syntax ?? analyzeSimpleSourceSyntax(sanitized), offset, context?.currentUnit?.name).static ? ["static"] as const : ["instance", "static"] as const;
			const reference = modes.map((access) => memberResultDefinition({ reference: current, access, directCurrentUnit: true }, first, definitions, context, analysis, undefined, offset)).find((value) => value !== undefined);
			if (reference === undefined) return undefined;
			consumed = 1;
			resolved = { access: "instance", directCurrentUnit: false, reference };
		}
	}

	if (resolved === undefined) {
		for (let length = segments.length; length > 0; length -= 1) {
			const name = segments.slice(0, length).join(".");
			const sourceFile = resolveSimpleDefinitionName(name, definitions)?.definition.sourceFile;
			if (currentUnit !== undefined && (
				name === currentUnit.qualifiedName
				|| name === currentUnit.name
			) && typeof sourceFile === "string" && sameFilePath(sourceFile, currentUnit.filePath)) {
				const reference = definitions.get(currentUnit.qualifiedName);
				if (reference !== undefined) {
					consumed = length;
					/* 单元类型名访问静态成员；事件声明的拥有者仍按实例事件解析。 */
					const lineStart = sanitized.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
					const eventDeclaration = /^[ \t]*事件[ \t]+[^()\r\n]*$/u.test(sanitized.slice(lineStart, offset));
					resolved = {
						access: eventDeclaration ? "instance" : "static",
						directCurrentUnit: true,
						reference
					};
					break;
				}
			}

			const reference = resolveSimpleDefinitionName(name, definitions);
			if (reference !== undefined) {
				consumed = length;
				resolved = { access: "static", directCurrentUnit: false, reference };
				break;
			}
		}
	}

	if (resolved === undefined) {
		return undefined;
	}

	for (const memberName of segments.slice(consumed)) {
		const reference = memberResultDefinition(resolved, memberName, definitions, context, analysis, undefined, offset);
		if (reference === undefined) {
			return undefined;
		}
		resolved = { access: "instance", directCurrentUnit: false, reference };
	}

	return resolved;
}

/**
 * 解析点号左侧限定链当前指向的类型及静态或实例访问方式。
 *
 * 该入口供补全、悬停等语言能力复用，保证跨单元静态变量产生的实例类型
 * 能继续解析后续成员。
 */
export function resolveSimpleQualifier(
	source: string,
	offset: number,
	qualifier: string,
	sdk: Sdk | undefined,
	context?: SimpleProjectSemanticContext,
	analysis?: SimpleSourceAnalysis
): ResolvedSimpleQualifier | undefined {
	if (offset < 0 || offset > source.length || qualifier.length === 0) {
		return undefined;
	}

	const current = analysis ?? createSimpleSourceAnalysis(source, sdk, context);
	const sanitized = current.sanitized;
	return resolveQualifier(
		qualifier,
		sanitized,
		offset,
		current.stackAt(offset),
		current.definitions,
		context,
		current
	);
}

/** 枚举类型限定名可访问的常量、静态函数及静态变量。 */
function staticMemberCandidates(
	reference: LibraryDefinitionReference,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): SimpleCompletionCandidate[] {
	const candidates: SimpleCompletionCandidate[] = [];

	for (const value of getEffectiveMembers(reference, "constants", definitions)) {
		candidates.push(memberCandidate(value.member, "constants", value.owner.definition.name, value.owner.definition === reference.definition ? 2 : 3));
	}

	for (const value of getEffectiveMembers(reference, "functions", definitions)) {
		if (value.member.global === true || isStaticProjectMember(value.member)) {
			candidates.push(memberCandidate(value.member, "functions", value.owner.definition.name, value.owner.definition === reference.definition ? 0 : 1));
		}
	}

	for (const value of getEffectiveMembers(reference, "variables", definitions)) {
		if (isStaticProjectMember(value.member)) {
			candidates.push(memberCandidate(value.member, "variables", value.owner.definition.name, value.owner.definition === reference.definition ? 0 : 1));
		}
	}

	return candidates;
}

/** 枚举已知变量类型的实例成员，并合并继承链。 */
function instanceMemberCandidates(
	reference: LibraryDefinitionReference,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>,
	eventDeclaration = false
): SimpleCompletionCandidate[] {
	const candidates: SimpleCompletionCandidate[] = [];

	const groups = eventDeclaration
		? ["events"] as const
		: ["constants", "properties", "variables", "functions"] as const;
	for (const group of groups) {
		for (const value of getEffectiveMembers(reference, group, definitions)) {
			if (!isSimpleMemberAccessible(value.member, group, "instance")) {
				continue;
			}
			candidates.push(memberCandidate(
				value.member,
				group,
				value.owner.definition.name,
				0,
				eventDeclaration
			));
		}
	}

	return candidates;
}

/** 枚举当前用户单元在代码区可直接访问的成员和组件实例。 */
function currentUnitCandidates(
	context: SimpleProjectSemanticContext | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>,
	staticContext: boolean
): SimpleCompletionCandidate[] {
	const current = context?.currentUnit;
	const reference = current === undefined ? undefined : definitions.get(current.qualifiedName);
	if (current === undefined) {
		return [];
	}

	const candidates: SimpleCompletionCandidate[] = [];
	if (reference !== undefined) {
		for (const group of ["constants", "variables", "properties", "functions"] as const) {
			for (const value of getEffectiveMembers(reference, group, definitions)) {
				const memberStatic = group === "constants" || isStaticProjectMember(value.member);
				if (staticContext !== memberStatic && staticContext) {
					continue;
				}
				candidates.push(memberCandidate(value.member, group, value.owner.definition.name, 1));
			}
		}
	}
	for (const alias of current.aliases) {
		// 成员别名不属于类型索引，保留引用候选；只有更近类型或命名空间遮蔽时隐藏。
		if (isSimpleAliasName(alias.name, definitions) || (resolveSimpleDefinitionName(alias.name, definitions) === undefined && resolveSimpleNamespaceName(alias.name, definitions) === undefined)) candidates.push(aliasCandidate(alias, definitions, 1, context));
	}

	return candidates;
}

/** 枚举事件声明点号左侧允许出现的当前单元和有事件的组件实例。 */
function eventOwnerCandidates(
	context: SimpleProjectSemanticContext | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): SimpleCompletionCandidate[] {
	const current = context?.currentUnit;
	if (current === undefined) {
		return [];
	}

	const candidates: SimpleCompletionCandidate[] = [{
		detail: `当前单元 · ${current.qualifiedName}`,
		initials: pinyinInitials(current.name),
		kind: "reference",
		name: current.name,
		priority: 0
	}];
	const currentReference = definitions.get(current.qualifiedName);
	if (currentReference === undefined) {
		return candidates;
	}

	for (const value of getEffectiveMembers(currentReference, "variables", definitions)) {
		const member = value.member;
		if (member.type === undefined || value.owner.definition !== currentReference.definition || arrayRank(member.type) > 0) {
			continue;
		}
		const componentReference = definitionForType(member.type, definitions, context);
		if (
			componentReference === undefined
			|| getEffectiveMembers(componentReference, "events", definitions).length === 0
		) {
			continue;
		}
		candidates.push(bindingCandidate({
			kind: "componentBinding",
			name: member.name,
			typeName: member.type
		}, 1));
	}

	return candidates;
}

/** 判断光标是否位于 `创建 <类型>` 之后、可继续指定组件容器的位置。 */
function awaitsComponentContainer(prefixBeforeQuery: string, definitions: ReadonlyMap<string, LibraryDefinitionReference>): boolean {
	const match = new RegExp(
		`(?:^|[^\\p{L}\\p{N}_.])创建[ \\t]+(${QUALIFIED_IDENTIFIER})[ \\t]+$`,
		"u"
	).exec(prefixBeforeQuery);
	return match !== null && isComponentDefinition(resolveSimpleDefinitionName(match[1]!, definitions)?.definition);
}

/** 语句起始的结构关键字由共享块状态投影，不再解析表达式阶段。 */
function blockKeywordCandidates(input: CompletionInput, sdk: Sdk, analysis: SimpleSourceAnalysis, context: SimpleProjectSemanticContext | undefined, grammar: SimpleCodeContext): SimpleCompletionCandidate[] {
	if (grammar.keywords !== undefined) return compilerCandidates(sdk, grammar.keywords, 0);
	const stack = analysis.stackAt(input.start);
	const frame = stack.at(-1);
	if (frame?.declarationOnly) return compilerCandidates(sdk, ["结束"], 0);
	if (frame?.kind === "property") return compilerCandidates(sdk, [
		...(frame.getterSeen !== true && frame.setterSeen !== true ? ["获取"] : []),
		...(frame.setterSeen !== true ? ["设置"] : []), "结束"
	], 0);
	if (unitType(context) === "接口") return compilerCandidates(sdk, ["别名", "常量", "函数", "过程"], 0);
	if (!grammar.executable) return compilerCandidates(sdk, TOP_LEVEL_KEYWORDS, 1);
	if ((frame?.kind === "select" || frame?.kind === "error") && scanSimpleSource(frame.header)[0]?.text !== "分支") return compilerCandidates(sdk, ["分支", "结束"], 0);
	const names = [...STATEMENT_KEYWORDS.filter((name) => name !== "本对象" || !grammar.static), "结束"];
	if (frame?.kind === "if" && scanSimpleSource(frame.header)[0]?.text !== "否则") names.push("否则", "否则如果");
	if ((frame?.kind === "select" || frame?.kind === "error") && scanSimpleSource(frame.header)[1]?.text !== "否则") names.push("分支");
	if (frame?.kind === "for") names.push("下个");
	if (frame?.kind === "do") names.push("直到");
	return compilerCandidates(sdk, names, 1);
}

/** 保留原名称前缀匹配，并将中英文混合输入转为连续首拼后过滤、去重和稳定排序。 */
function filterCandidates(
	candidates: readonly SimpleCompletionCandidate[],
	query: string
): readonly SimpleCompletionCandidate[] {
	const normalizedQuery = pinyinInitials(query);
	const unique = new Map<string, SimpleCompletionCandidate>();

	for (const candidate of candidates) {
		if (
			normalizedQuery.length > 0
			&& !candidate.name.startsWith(query)
			&& !candidate.initials.startsWith(normalizedQuery)
		) {
			continue;
		}

		const overload = candidate.kind === "function" ? `:${candidate.overloadArity ?? 0}` : "";
		const key = `${candidate.kind}:${candidate.name}${overload}`;
		const existing = unique.get(key);
		if (existing === undefined || candidate.priority < existing.priority) {
			unique.set(key, candidate);
		}
	}

	return [...unique.values()].sort((left, right) => (
		left.priority - right.priority
		|| left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" })
	));
}

/** 区分语句起始、赋值目标和取值位置；括号内等号及单行条件不作为赋值符。 */
function expressionCompletionPosition(input: CompletionInput, analysis: SimpleSourceAnalysis): "statement" | "assignment" | "value" {
	const start = logicalStatementStart(input.sanitized, input.start);
	const end = analysis.expressionTokens.find((token) => token.kind === "separator" && token.start >= input.start)?.start ?? input.source.length;
	const tokens = analysis.expressionTokens.filter((token) => token.start >= start && token.start < end);
	let head = 0;
	let depth = 0;
	for (let index = 0; index < tokens.length && tokens[index]!.start < input.start; index += 1) {
		const token = tokens[index]!;
		if (token.text === "(") depth += 1;
		else if (token.text === ")") depth -= 1;
		else if (depth === 0 && tokens[index - 1]?.text !== "." && (token.text === "则" || token.text === "否则")) head = index + 1;
	}
	if (depth > 0) return "value";
	const body = tokens.slice(head);
	const first = body[0];
	if (first !== undefined && ["如果", "否则如果", "判断", "判断循环", "直到", "分支"].includes(first.text)) return "value";

	depth = 0;
	let operatorBefore = false;
	for (const token of body) {
		if (token.text === "(") depth += 1;
		else if (token.text === ")") depth -= 1;
		else if (depth === 0 && token.text === "=" && (first === token || first?.kind === "word"
			&& (!LANGUAGE_WORDS.has(first.text) || ["本对象", "变量", "常量", "循环"].includes(first.text)))) {
			if (token.start < input.start) return "value";
			return first.text === "变量" || first.text === "常量" ? "statement" : "assignment";
		} else if (depth === 0 && token.start < input.start && token.kind === "operator") operatorBefore = true;
	}
	return operatorBefore ? "value" : "statement";
}

/** 点号左侧必须能解析为可访问成员的值、类型或命名空间，不能使用事件或裸方法名。 */
function isMemberReceiverCandidate(
	candidate: SimpleCompletionCandidate,
	qualifier: string | undefined,
	input: CompletionInput,
	analysis: SimpleSourceAnalysis,
	context: SimpleProjectSemanticContext | undefined,
	parent: ResolvedSimpleQualifier | undefined
): boolean {
	if (candidate.kind === "event" || candidate.kind === "function" || candidate.array === true || candidate.readable === false
		|| candidate.kind === "keyword" && candidate.name !== "本对象") return false;
	const name = qualifier === undefined ? candidate.name : `${qualifier}.${candidate.name}`;
	if (parent === undefined && resolveSimpleNamespaceName(name, analysis.definitions) !== undefined) return true;
	const current = parent === undefined && candidate.kind === "property" ? analysis.definitions.get(context?.currentUnit?.qualifiedName ?? "") : undefined;
	const owner = parent ?? (current === undefined ? undefined : { reference: current, access: "instance" as const, directCurrentUnit: true });
	const result = owner === undefined ? undefined : memberResultDefinition(owner, candidate.name, analysis.definitions, context, analysis, undefined, input.start);
	const memberReceiver: ResolvedSimpleQualifier | undefined = result === undefined ? undefined : { reference: result, access: "instance", directCurrentUnit: false };
	const receiver: ResolvedSimpleQualifier | undefined = parent === undefined
		? resolveQualifier(name, input.sanitized, input.start, analysis.stackAt(input.start), analysis.definitions, context, analysis) ?? memberReceiver
		: memberReceiver;
	if (receiver === undefined || receiver.reference.manifest.kind === "compiler") return false;
	return (["constants", "variables", "properties", "functions"] as const).some((group) =>
		getEffectiveMembers(receiver.reference, group, analysis.definitions).some((value) => isSimpleMemberAccessible(value.member, group, receiver.access))
	);
}

/** 完整语句只有可写变量、属性或可读数组元素才能继续赋值，方法调用不能作为左值。 */
function assignmentTargetWritable(target: NonNullable<SimpleCodeContext["assignmentTarget"]>, analysis: SimpleSourceAnalysis, context?: SimpleProjectSemanticContext): boolean {
	const tokens = analysis.expressionTokens.filter((token) => token.start >= target.start && token.end <= target.end);
	let index = tokens.length - 1;
	let arity: number | undefined;
	if (tokens[index]?.text === ")") {
		const open = expressionOpening(tokens, index);
		if (open < 1) return false;
		arity = expressionArity(tokens, open, index);
		index = open - 1;
	}
	const name = tokens[index];
	if (name?.kind !== "word") return false;
	const writable = (member: LibraryMember): boolean => arity === undefined ? member.writable !== false
		: member.readable !== false && arity > 0 && arrayRank(member.type) === arity;
	const access = analysis.memberAt(name.start);
	if (access !== undefined) return access.receiver !== undefined && (["variables", "properties"] as const).some((group) =>
		analysis.members(access.receiver!.reference, group, name.text).some(({ member }) => isSimpleMemberAccessible(member, group, access.receiver!.access) && writable(member)));
	if (analysis.syntax.isBlocked(name.text, name.start)) return false;
	const binding = resolveTypedBinding(analysis.sanitized, name.start, analysis.stackAt(name.start), name.text, context, analysis);
	if (binding !== undefined) return arity === undefined || arity > 0 && arrayRank(binding.typeName) === arity;
	const declaration = analysis.syntax.resolve(name.text, name.start);
	if (declaration?.kind === "alias") return resolveSimpleAliasMembers(name.text, analysis.definitions, context)
		.some(({ group, member }) => group === "variables" && writable(member));
	if (declaration !== undefined && !["property", "variable"].includes(declaration.kind)) return false;
	const current = context?.currentUnit === undefined ? undefined : analysis.definitions.get(context.currentUnit.qualifiedName);
	const staticContext = simpleExecutionContext(analysis.syntax, name.start, context?.currentUnit?.name).static;
	if (current !== undefined && (["variables", "properties"] as const).some((group) => analysis.members(current, group, name.text)
		.some(({ member }) => (!staticContext || isSimpleMemberAccessible(member, group, "static")) && writable(member)))) return true;
	return declaration === undefined && [...new Set(analysis.definitions.values())].some((owner) => owner.manifest.kind !== "project"
		&& owner.definition.variables?.some((member) => member.name === name.text && member.global === true && writable(member)));
}

/** 从统一语法阶段和符号模型生成补全，不对无效名称回退到全库。 */
export function provideSimpleCompletions(
	source: string,
	offset: number,
	sdk: Sdk | undefined,
	context?: SimpleProjectSemanticContext
): SimpleCompletionResult | undefined {
	if (offset < 0 || offset > source.length) {
		return undefined;
	}

	const input = completionInput(source, offset);
	if (input === undefined) {
		return undefined;
	}

	const prefixBeforeQuery = input.linePrefix.slice(0, input.linePrefix.length - input.query.length);
	const analysis = createSimpleSourceAnalysis(source, sdk, context);
	const grammar = simpleCodeContext(input.start, analysis.syntax, context?.currentUnit?.name);
	const declaration = analysis.syntax.declarationAt(input.start);
	if (declaration?.token.start === input.start && declaration.implicit !== true
		&& (declaration.kind !== "event" || declaration.owner === undefined && /^[ \t]*\(/u.test(source.slice(declaration.token.end)))) return undefined;
	const cursorIndex = simpleSourceTokenIndex(analysis.syntax.tokens, offset, true);
	const cursorToken = analysis.syntax.tokens[cursorIndex];
	if (cursorToken?.kind === "number" && input.start < cursorToken.end) return undefined;
	// 未完成的 &H 前缀、数字后紧贴的非法名称片段也不能被补成普通标识符。
	const wordIndex = cursorToken?.kind === "word" ? cursorIndex : simpleSourceTokenIndex(analysis.syntax.tokens, input.start);
	const word = analysis.syntax.tokens[wordIndex];
	const previous = analysis.syntax.tokens[wordIndex - 1];
	if (word?.kind === "word" && previous?.end === word.start
		&& (previous.kind === "number" || previous.text === "&" && word.text.startsWith("H"))) return undefined;
	const requiredCandidates = ["none", "name"].includes(grammar.slot) ? []
		: grammar.slot === "keyword" || grammar.slot === "operator" ? sdk === undefined ? [] : compilerCandidates(sdk, [
			...(grammar.slot === "operator" && awaitsComponentContainer(prefixBeforeQuery, analysis.definitions) ? ["位于"] : []),
			...(grammar.keywords ?? [])
		], 0) : undefined;
	if (requiredCandidates !== undefined) return {
		candidates: filterCandidates(requiredCandidates.filter((candidate) => candidate.name !== "=" || grammar.assignmentTarget === undefined
			|| assignmentTargetWritable(grammar.assignmentTarget, analysis, context)).map((candidate) => ({ ...candidate,
			priority: grammar.slot !== "operator" || ["则", "至", "步进", "位于"].includes(candidate.name)
				|| candidate.name === "是" && !grammar.keywords?.includes("=") ? 0 : 1
		})), input.query),
		start: input.start, end: input.end, query: input.query
	};
	const stack = analysis.stackAt(offset);
	const definitions = analysis.definitions;
	const qualifier = qualifierBefore(input);
	const memberAccess = analysis.receiverBefore(input.start);
	const qualifiedTypePrefix = new RegExp(
		`(?:^|[ \\t])(?:(?:为|创建)[ \\t]+|别名[ \\t]+${IDENTIFIER}[ \\t]*=[ \\t]*)((?:${IDENTIFIER}\\.)*)$`,
		"u"
	).exec(prefixBeforeQuery)?.[1] ?? "";
	const typePosition = grammar.slot === "type" || grammar.slot === "errorType"
		|| analysis.syntax.roleAt(input.start) === "type"
		|| qualifiedTypePrefix.length > 0
		|| new RegExp(
			`(?:^|[ \\t])(?:(?:为|创建)|别名[ \\t]+${IDENTIFIER}[ \\t]*=)[ \\t]+$`,
			"u"
		).test(prefixBeforeQuery);
	const aliasTargetPosition = grammar.slot === "alias";
	const identifier = simpleIdentifierRange(source, offset);
	const nextCharacter = source[skipSimpleContinuationWhitespace(source, identifier?.end ?? offset)];
	const dotFollows = nextCharacter === ".";
	const parenthesisFollows = nextCharacter === "(";
	const qualifiedSegment = (typePosition || aliasTargetPosition) && dotFollows;
	const eventOwnerPosition = grammar.slot === "eventOwner";
	const eventDeclaration = /^[ \t]*事件[ \t]+/u.test(input.linePrefix);
	const raisedEventPosition = grammar.slot === "event" && !eventDeclaration || isSimpleEventTarget(analysis.syntax, input.start)
		|| /(?:^|[ \t])触发事件[ \t]+$/u.test(prefixBeforeQuery);
	const creationPosition = new RegExp(`(?:^|[ \\t])创建[ \\t]+(?:${IDENTIFIER}\\.)*$`, "u").test(prefixBeforeQuery);
	let candidates: SimpleCompletionCandidate[];
	let aliasMemberPosition = false;

	if (eventOwnerPosition) {
		candidates = eventOwnerCandidates(context, definitions);
	} else if (raisedEventPosition) {
		const current = context?.currentUnit;
		const reference = current === undefined ? undefined : definitions.get(current.qualifiedName);
		candidates = reference === undefined || grammar.static ? []
			: getEffectiveMembers(reference, "events", definitions).map((value) => memberCandidate(value.member, "events", value.owner.definition.name, 0));
	} else if (qualifiedSegment) {
		/* 限定名右侧仍有路径时只替换当前命名空间段，不重复插入完整类型名。 */
		candidates = namespaceMemberCandidates(qualifier ?? "", definitions)
			.filter((candidate) => candidate.kind === "reference");
	} else if (aliasTargetPosition) {
		const owner = qualifier === undefined ? undefined : resolveQualifier(qualifier, input.sanitized, offset, stack, definitions, context, analysis);
		aliasMemberPosition = owner !== undefined;
		candidates = owner === undefined ? [...aliasTargetCandidates(sdk, context), ...namespaceMemberCandidates(qualifier ?? "", definitions)]
			: staticMemberCandidates(owner.reference, definitions);
		if (qualifier === undefined && sdk !== undefined) candidates.push(...globalValueCandidates(sdk, 1), ...currentUnitCandidates(context, definitions, true));
		candidates = candidates.filter((candidate) => candidate.name.split(".").every((name) => !LANGUAGE_WORDS.has(name)))
			.map((candidate) => ({ ...candidate, snippet: undefined }));
	} else if (typePosition) {
		const builtInTypes = sdk?.manifests
			.find((manifest) => manifest.kind === "compiler")
			?.categories.flatMap((category) => category.definitions)
			.filter((definition) => definition.kind === "type" && !definition.name.startsWith("$"))
			.map((definition) => definitionCandidate(definition, 0)) ?? [];
		candidates = [
			...builtInTypes,
			...typeAliasCandidates(context, definitions, 0),
			...semanticTypeCandidates(definitions, 1)
		];
		if (grammar.slot === "errorType") {
			const errorType = (reference: LibraryDefinitionReference | undefined, seen = new Set<LibraryDefinitionReference>()): boolean => {
				if (reference === undefined || seen.has(reference)) return false;
				seen.add(reference);
				return reference.definition.kind === "error" || (reference.definition.inherits ?? []).some((name) => errorType(definitions.get(name), seen));
			};
			if (qualifier !== undefined) candidates = [...namespaceMemberCandidates(qualifier, definitions)];
			candidates = candidates.filter((candidate) => {
				const name = qualifier === undefined ? candidate.name : `${qualifier}.${candidate.name}`;
				const namespace = resolveSimpleNamespaceName(name, definitions);
				return errorType(resolveSimpleDefinitionName(name, definitions)) || namespace !== undefined
					&& [...definitions.values()].some((reference) => typeof reference.definition.type === "string"
						&& reference.definition.type.startsWith(`${namespace}.`) && errorType(reference));
			});
			if (sdk !== undefined && qualifier === undefined) candidates.push(...compilerCandidates(sdk, grammar.keywords ?? [], 0));
		}
		/* 创建后没有数组维度时只允许对象类型；带维度时基本类型和接口仍可作为数组元素。 */
		if (creationPosition && !parenthesisFollows) {
			candidates = candidates.filter((candidate) => {
				if (candidate.name === languageFacts.words.TOK_OBJECT.text) return true;
				const reference = resolveSimpleDefinitionName(candidate.name, definitions);
				return reference !== undefined && reference.manifest.kind !== "compiler"
					&& reference.definition.kind !== "interface" && reference.definition.abstract !== true;
			});
		}
	} else if (qualifier !== undefined || memberAccess !== undefined) {
		if (qualifier === "R" && isSimpleResourceRoot(analysis, input.start, context)) {
			candidates = [...resourceMemberCandidates(context)];
		} else {
			const resolved = memberAccess?.receiver ?? (qualifier === undefined ? undefined : resolveQualifier(
				qualifier,
				input.sanitized,
				offset,
				stack,
				definitions,
				context,
				analysis
			));

			if (resolved === undefined) {
				candidates = qualifier !== undefined && resolveTypedBinding(input.sanitized, offset, stack, qualifier.split(".")[0]!, context, analysis) === undefined
					? [...namespaceMemberCandidates(qualifier, definitions)] : [];
			} else if (resolved.access === "instance") {
				candidates = instanceMemberCandidates(resolved.reference, definitions, eventDeclaration);
			} else {
				candidates = staticMemberCandidates(resolved.reference, definitions);
			}
		}
	} else {
		const allowsRuntimeValues = grammar.executable
			&& unitType(context) !== "接口";
		const frame = stack.at(-1);
		const branchHeader = (frame?.kind === "select" || frame?.kind === "error") && scanSimpleSource(frame.header)[0]?.text !== "分支"
			&& grammar.slot === "statement";
		const keywordOnly = branchHeader || frame?.declarationOnly === true;
		const keywordCandidates = sdk === undefined
			? []
			: grammar.slot === "statement" ? blockKeywordCandidates(input, sdk, analysis, context, grammar)
				: compilerCandidates(sdk, [...(grammar.keywords ?? []), ...simpleExpressionKeywords(grammar)], 3);
		const locals = allowsRuntimeValues ? visibleLocalBindings(source, offset, stack, analysis, context) : [];
		const localNames = new Map(locals.map((binding) => [binding.name, binding]));
		const unitCandidates = allowsRuntimeValues ? currentUnitCandidates(context, definitions, grammar.static) : [];
		const unitNames = new Set(unitCandidates.map((candidate) => candidate.name));
		candidates = keywordOnly
			? keywordCandidates
			: [
				...keywordCandidates,
				...locals.map((binding) => bindingCandidate(binding, 0)),
				...unitCandidates,
				...(allowsRuntimeValues && sdk !== undefined ? globalValueCandidates(sdk, 2) : []),
				...(allowsRuntimeValues ? semanticTypeCandidates(definitions, 4) : [])
			];
		/* 局部值遮蔽外层同名符号；函数自己的返回值不妨碍按名称递归调用。 */
		if (!keywordOnly) candidates = candidates.filter((candidate) => candidate.priority === 0
			|| (!localNames.has(candidate.name) || candidate.kind === "function" && localNames.get(candidate.name)?.kind === "functionResult")
				&& (candidate.priority < 2 || !unitNames.has(candidate.name) && analysis.syntax.resolve(candidate.name, offset) === undefined));
		if (!keywordOnly && allowsRuntimeValues && dotFollows) {
			/* 表达式首段也按段补全；已有同名值时不能把它当作命名空间。 */
			candidates = [
				...candidates.filter((candidate) => !candidate.name.includes(".")),
				...namespaceMemberCandidates("", definitions).filter((candidate) => resolveTypedBinding(
					input.sanitized, offset, stack, candidate.name, context, analysis
				) === undefined)
			];
		}
	}
	if (qualifier === undefined && memberAccess === undefined && !typePosition && !aliasTargetPosition && !eventOwnerPosition && !raisedEventPosition) {
		candidates = candidates.filter((candidate) => !analysis.syntax.isBlocked(candidate.name.split(".")[0]!, input.start));
	}
	if (grammar.constant) candidates = candidates.filter((candidate) => candidate.kind === "constant" || candidate.kind === "type" || candidate.kind === "reference" || candidate.kind === "keyword");
	if (grammar.slot === "loopVariable") {
		const next = scanSimpleSource(input.linePrefix)[0]?.text === "下个";
		const loop = next ? analysis.syntax.blocksAt(logicalStatementStart(input.sanitized, input.start)).at(-1) : undefined;
		const header = loop === undefined ? [] : scanSimpleSource(loop.header);
		const name = header[header[1]?.text === "每个" ? 2 : 1]?.text;
		const each = scanSimpleSource(input.linePrefix)[1]?.text === "每个";
		const scalars = new Set(["逻辑型", "字节型", "短整数型", "整数型", "长整数型", "单精度小数型", "双精度小数型", "文本型", "变体型"]);
		candidates = candidates.filter((candidate) => (candidate.kind === "variable" || candidate.kind === "property") && candidate.writable === true
			&& (name === undefined || candidate.name === name) && (next || each || candidate.readable !== false && scalars.has(candidate.valueType ?? "")));
		if (!next && sdk !== undefined) candidates.push(...compilerCandidates(sdk, grammar.keywords ?? [], 0));
	}

	const arrayPosition = parenthesisFollows && candidates.some((candidate) => candidate.array === true && candidate.name === identifier?.name);
	const unknownCall = parenthesisFollows && !candidates.some((candidate) => candidate.name === identifier?.name);
	/* 点号前出现调用、下标或分组后，当前语法只允许继续读写成员，不能再次调用或取下标。 */
	if (memberAccess?.callable === false && !eventDeclaration && !raisedEventPosition) {
		candidates = candidates.filter((candidate) => candidate.kind !== "function" && candidate.callable !== true);
		if (parenthesisFollows) candidates = [];
	}

	/* 同一名称在接收者、赋值目标和取值位置具有不同资格，事件相关语境单独处理。 */
	if (!typePosition && !aliasTargetPosition && !eventOwnerPosition && !eventDeclaration && !raisedEventPosition) {
		if (dotFollows) candidates = filterCandidates(candidates, input.query)
			.filter((candidate) => isMemberReceiverCandidate(candidate, qualifier, input, analysis, context, memberAccess?.receiver));
		else {
			const position = grammar.slot === "value" ? "value" : expressionCompletionPosition(input, analysis);
			/* 数组下标赋值先获取数组，再修改元素；只读数组属性仍可提供数组。 */
			if (position === "assignment") candidates = candidates.filter((candidate) => arrayPosition || unknownCall
				? candidate.array === true && candidate.readable !== false : candidate.writable === true);
			else if (position === "value") candidates = candidates.filter((candidate) => candidate.readable !== false
				&& (!(candidate.kind === "function" || candidate.callable === true) || candidate.valueType !== undefined));
			/* 语句必须能继续形成赋值或调用，不能把仅可读取的标量当作独立语句。 */
			else candidates = candidates.filter((candidate) => candidate.kind === "keyword" || candidate.kind === "function" || candidate.callable === true
				|| candidate.writable === true || candidate.array === true && candidate.readable !== false
				|| isMemberReceiverCandidate(candidate, qualifier, input, analysis, context, memberAccess?.receiver));
		}
	}

	/* 完整名称后已有括号时按调用筛选，不能把普通属性或变量推荐到方法位置。 */
	if (parenthesisFollows && !typePosition && !aliasTargetPosition && !eventOwnerPosition) {
		const eventPosition = /^[ \t]*事件[ \t]+/u.test(input.linePrefix) || isSimpleEventTarget(analysis.syntax, input.start);
		const keywordPosition = candidates.some((candidate) => candidate.kind === "keyword" && candidate.name === identifier?.name);
		candidates = candidates.filter((candidate) => eventPosition
			? candidate.kind === "event"
			: keywordPosition ? candidate.kind === "keyword"
				: arrayPosition ? candidate.array === true : candidate.kind === "function" || candidate.callable === true || unknownCall && candidate.array === true);
	}

	const replacementPrefix = qualifiedSegment || aliasMemberPosition ? "" : qualifiedTypePrefix;
	const query = replacementPrefix + input.query;
	return {
		candidates: filterCandidates(candidates, query),
		end: input.end,
		query,
		start: input.start - replacementPrefix.length
	};
}
