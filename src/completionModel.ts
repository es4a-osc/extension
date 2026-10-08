/*
分析 Simple 代码区补全语境，并从 SDK 与当前文档生成支持首拼过滤的合法候选。
xhwsd@qq.com 2026-8-27
*/

import { pinyin } from "pinyin-pro";
import {
	getEffectiveMembers,
	isSdkTypeKind,
	type LibraryDefinition,
	type LibraryDefinitionReference,
	type LibraryMember,
	type LibraryMemberGroup,
	type Sdk
} from "./sdk";
import {
	buildSemanticDefinitionIndex,
	isStaticProjectMember,
	type SimpleAliasSymbol,
	type SimpleProjectSemanticContext
} from "./simpleUnitSymbols";
import { isSimpleIgnoredOffset } from "./simpleSourceLexical";

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

/** 补全分析需要追踪的 Simple 代码块种类。 */
type BlockKind =
	| "do"
	| "error"
	| "event"
	| "for"
	| "function"
	| "getter"
	| "if"
	| "property"
	| "procedure"
	| "select"
	| "setter"
	| "while";

/** 光标前一个尚未关闭的 Simple 语法块。 */
interface BlockFrame {
	getterSeen?: boolean;
	header: string;
	kind: BlockKind;
	setterSeen?: boolean;
	start: number;
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

const IDENTIFIER_CHARACTER = /[\p{L}\p{N}_]/u;
const IDENTIFIER = "[\\p{L}][\\p{L}\\p{N}_]*";
const QUALIFIED_IDENTIFIER = `${IDENTIFIER}(?:\\.${IDENTIFIER})*`;
const TOP_LEVEL_KEYWORDS = ["别名", "常量", "变量", "事件", "函数", "过程", "属性", "静态"] as const;
const STATEMENT_KEYWORDS = [
	"变量",
	"本对象",
	"如果",
	"判断",
	"判断循环",
	"循环",
	"执行",
	"退出",
	"位于",
	"触发事件"
] as const;
const EXPRESSION_KEYWORDS = ["创建", "本对象", "真", "假", "空", "取反", "类型检验"] as const;

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
	const characters = source.split("");
	let inComment = false;
	let inString = false;

	for (let index = 0; index < characters.length; index += 1) {
		const current = characters[index];

		if (current === "\n") {
			inComment = false;
			if (inString) {
				inString = false;
			}
			continue;
		}

		if (inComment) {
			if (current !== "\r") {
				characters[index] = " ";
			}
			continue;
		}

		if (inString) {
			if (current === "\\" && index + 1 < characters.length) {
				characters[index] = " ";
				index += 1;
				if (characters[index] !== "\r" && characters[index] !== "\n") {
					characters[index] = " ";
				}
				continue;
			}

			characters[index] = " ";
			if (current === "\"") {
				inString = false;
			}
			continue;
		}

		if (current === "'") {
			characters[index] = " ";
			inComment = true;
		} else if (current === "\"") {
			characters[index] = " ";
			inString = true;
		}
	}

	return characters.join("");
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

/** 按结束类型弹出最近的匹配块。 */
function closeBlock(stack: BlockFrame[], kind: BlockKind): void {
	for (let index = stack.length - 1; index >= 0; index -= 1) {
		if (stack[index]?.kind !== kind) {
			continue;
		}

		stack.splice(index);
		const property = [...stack].reverse().find((frame) => frame.kind === "property");
		if (kind === "getter" && property !== undefined) {
			property.getterSeen = true;
		} else if (kind === "setter" && property !== undefined) {
			property.setterSeen = true;
		}
		return;
	}
}

/** 扫描光标前的完整逻辑语句，建立足以约束补全的轻量块栈。 */
function blockStack(sanitized: string, offset: number): BlockFrame[] {
	const stack: BlockFrame[] = [];
	const currentLineStart = sanitized.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
	const logicalPrefix = normalizeLogicalPrefix(sanitized.slice(0, currentLineStart));
	let lineStart = 0;

	while (lineStart < logicalPrefix.length) {
		const newline = logicalPrefix.indexOf("\n", lineStart);
		const colon = logicalPrefix.indexOf(":", lineStart);
		const separators = [newline, colon].filter((index) => index >= 0);
		const statementEnd = separators.length === 0 ? logicalPrefix.length : Math.min(...separators);
		const statements = [logicalPrefix.slice(lineStart, statementEnd)];

		for (const statement of statements) {
			const trimmed = statement.trim();
			if (trimmed.length === 0) {
				continue;
			}
			const statementStart = lineStart + statement.indexOf(trimmed);

			const ending = /^结束\s+(函数|过程|事件|属性|获取|设置|如果|判断|判断循环|错误)(?:\s|$)/u.exec(trimmed)?.[1];
			const endingKinds: Readonly<Record<string, BlockKind>> = {
				事件: "event",
				函数: "function",
				判断: "select",
				判断循环: "while",
				过程: "procedure",
				获取: "getter",
				设置: "setter",
				属性: "property",
				如果: "if",
				错误: "error"
			};

			if (ending !== undefined) {
				const kind = endingKinds[ending];
				if (kind !== undefined) {
					closeBlock(stack, kind);
				}
			} else if (/^下个(?:\s|$)/u.test(trimmed)) {
				closeBlock(stack, "for");
			} else if (/^(?:直到|判断循环)(?:\s|$)/u.test(trimmed) && stack.at(-1)?.kind === "do") {
				closeBlock(stack, "do");
			} else {
				const declaration = /^(?:静态\s+)?(函数|过程|事件|属性)(?:\s|$)/u.exec(trimmed)?.[1];
				const declarationKinds: Readonly<Record<string, BlockKind>> = {
					事件: "event",
					函数: "function",
					过程: "procedure",
					属性: "property"
				};

				if (declaration !== undefined) {
					const kind = declarationKinds[declaration];
					if (kind !== undefined) {
						stack.push({ header: trimmed, kind, start: statementStart });
					}
				} else if (/^获取(?:\s|$)/u.test(trimmed) && stack.at(-1)?.kind === "property") {
					stack.push({ header: trimmed, kind: "getter", start: statementStart });
				} else if (/^设置(?:\s|$)/u.test(trimmed) && stack.at(-1)?.kind === "property") {
					stack.push({ header: trimmed, kind: "setter", start: statementStart });
				} else if (/^如果(?:\s|$).*则[ \t]*$/u.test(trimmed)) {
					stack.push({ header: trimmed, kind: "if", start: statementStart });
				} else if (/^判断循环(?:\s|$)/u.test(trimmed)) {
					stack.push({ header: trimmed, kind: "while", start: statementStart });
				} else if (/^判断(?:\s|$)/u.test(trimmed)) {
					stack.push({ header: trimmed, kind: "select", start: statementStart });
				} else if (/^循环(?:\s|$)/u.test(trimmed)) {
					stack.push({ header: trimmed, kind: "for", start: statementStart });
				} else if (/^执行(?:\s|$)/u.test(trimmed)) {
					stack.push({ header: trimmed, kind: "do", start: statementStart });
				} else if (/^位于\s+错误(?:\s|$)/u.test(trimmed)) {
					stack.push({ header: trimmed, kind: "error", start: statementStart });
				}
			}
		}

		if (statementEnd >= logicalPrefix.length) {
			break;
		}
		lineStart = statementEnd + 1;
	}

	return stack;
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

/** 解析显式类型或 `创建` 初始化器能够确定类型的变量声明。 */
function variableBindings(
	value: string,
	kind: SimpleBindingKind,
	baseOffset: number = 0
): readonly SimpleBinding[] {
	const bindings: SimpleBinding[] = [];
	const pattern = new RegExp(
		`(?:^|,)[ \\t]*(?:(传值|传址)[ \\t]+)?(${IDENTIFIER})(?:[ \\t]+为[ \\t]+(${QUALIFIED_IDENTIFIER}(?:[ \\t]*\\([^)]*\\))?)(?:[ \\t]*=[ \\t]*创建[ \\t]+(${QUALIFIED_IDENTIFIER}))?|[ \\t]*=[ \\t]*创建[ \\t]+(${QUALIFIED_IDENTIFIER}))`,
		"gu"
	);

	for (const match of value.matchAll(pattern)) {
		const passing = match[1] as "传值" | "传址" | undefined;
		const name = match[2];
		const declaredTypeName = match[3];
		const createdTypeName = match[4] ?? match[5];
		const typeName = declaredTypeName === "变体型" && createdTypeName !== undefined
			? createdTypeName
			: declaredTypeName ?? createdTypeName;
		if (name !== undefined && typeName !== undefined) {
			const declarationStart = baseOffset + (match.index ?? 0) + match[0].indexOf(name);
			bindings.push({
				declarationStart,
				declaredTypeName: declaredTypeName === "变体型" && createdTypeName !== undefined
					? declaredTypeName
					: undefined,
				kind,
				name,
				...(passing === undefined ? {} : { passing }),
				typeName
			});
		}
	}

	return bindings;
}

/** 在函数式声明行内解析光标指向的正式参数。 */
function parameterBindingAtDeclaration(
	sanitized: string,
	offset: number,
	name: string
): SimpleBinding | undefined {
	const lineStart = Math.max(
		sanitized.lastIndexOf("\n", Math.max(0, offset - 1)),
		sanitized.lastIndexOf("\r", Math.max(0, offset - 1))
	) + 1;
	const lineEndCandidates = [
		sanitized.indexOf("\n", offset),
		sanitized.indexOf("\r", offset)
	].filter((candidate) => candidate >= 0);
	const lineEnd = lineEndCandidates.length === 0
		? sanitized.length
		: Math.min(...lineEndCandidates);
	const line = sanitized.slice(lineStart, lineEnd);
	const header = /^[ \t]*(?:静态[ \t]+)?(?:函数|过程|事件)[ \t]+[^()\r\n]+\((.*)\)/u.exec(line);
	const parameters = header?.[1];
	if (parameters === undefined) {
		return undefined;
	}

	const parameterOffset = lineStart + line.indexOf(parameters);
	return variableBindings(parameters, "parameter", parameterOffset).find((binding) => (
		binding.name === name
		&& binding.declarationStart !== undefined
		&& offset >= binding.declarationStart
		&& offset < binding.declarationStart + binding.name.length
	));
}

/** 枚举当前函数式作用域内在光标前已经声明的参数、局部变量和函数返回值。 */
function visibleLocalBindings(
	sanitized: string,
	offset: number,
	stack: readonly BlockFrame[]
): readonly SimpleBinding[] {
	const callable = callableFrame(stack);
	if (callable === undefined) {
		return [];
	}

	const bindings = new Map<string, SimpleBinding>();
	const parameters = /\((.*)\)/u.exec(callable.header)?.[1];
	if (parameters !== undefined) {
		const parameterOffset = callable.start + callable.header.indexOf(parameters);
		for (const binding of variableBindings(parameters, "parameter", parameterOffset)) {
			bindings.set(binding.name, binding);
		}
	}

	const declaration = /^[ \t]*(?:静态[ \t]+)?变量[ \t]+([^\r\n]*)/gmu;
	declaration.lastIndex = callable.start;
	for (let match = declaration.exec(sanitized); match !== null && match.index < offset; match = declaration.exec(sanitized)) {
		if (match.index < callable.start) {
			continue;
		}
		const declarationSource = match[1] ?? "";
		const declarationOffset = match.index + match[0].indexOf(declarationSource);
		for (const binding of variableBindings(declarationSource, "variable", declarationOffset)) {
			bindings.set(binding.name, binding);
		}
	}

	if (callable.kind === "function") {
		const result = new RegExp(
			`^(?:静态[ \\t]+)?函数[ \\t]+(${IDENTIFIER})[^\\r\\n]*\\)[ \\t]+为[ \\t]+(${QUALIFIED_IDENTIFIER}(?:[ \\t]*\\([^)]*\\))?)`,
			"u"
		).exec(callable.header);
		const name = result?.[1];
		const typeName = result?.[2];
		if (name !== undefined && typeName !== undefined && !bindings.has(name)) {
			bindings.set(name, {
				declarationStart: callable.start + callable.header.indexOf(name),
				kind: "functionResult",
				name,
				typeName
			});
		}
	}

	return [...bindings.values()];
}

/** 用光标前最后一次 `创建` 赋值收窄变体型，未知动态值仍保持变体型。 */
function narrowVariantBinding(
	sanitized: string,
	offset: number,
	stack: readonly BlockFrame[],
	binding: SimpleBinding
): SimpleBinding {
	if (binding.typeName !== "变体型") {
		return binding;
	}

	const callable = callableFrame(stack);
	const start = Math.max(binding.declarationStart ?? 0, callable?.start ?? 0);
	const assignment = new RegExp(
		`(?:^|:)[ \\t]*${binding.name}[ \\t]*=[ \\t]*([^:\\r\\n]*)`,
		"gmu"
	);
	assignment.lastIndex = start;
	let narrowedType: string | undefined;
	for (
		let match = assignment.exec(sanitized);
		match !== null && match.index < offset;
		match = assignment.exec(sanitized)
	) {
		narrowedType = new RegExp(
			`^创建[ \\t]+(${QUALIFIED_IDENTIFIER})(?=[ \\t]|$)`,
			"u"
		).exec(match[1]?.trim() ?? "")?.[1];
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
	context?: SimpleProjectSemanticContext
): SimpleBinding | undefined {
	const local = visibleLocalBindings(sanitized, offset, stack).find((binding) => binding.name === name);
	if (local !== undefined) {
		return narrowVariantBinding(sanitized, offset, stack, local);
	}

	const component = context?.currentUnit?.definition.variables?.find(
		(member) => member.component === true && member.name === name
	);
	if (component?.type !== undefined) {
		return { kind: "componentBinding", name, typeName: component.type };
	}

	const fields: SimpleBinding[] = [];
	const fieldDeclaration = new RegExp(`^[ \\t]*(静态[ \\t]+)?变量[ \\t]+([^\\r\\n]*)`, "gmu");
	for (const match of sanitized.matchAll(fieldDeclaration)) {
		if (match.index === undefined || callableFrame(blockStack(sanitized, match.index)) !== undefined) {
			continue;
		}

		const declarationSource = match[2] ?? "";
		fields.push(...variableBindings(
			declarationSource,
			match[1] === undefined ? "field" : "staticField",
			match.index + match[0].indexOf(declarationSource)
		));
	}

	const field = fields.reverse().find((binding) => binding.name === name);
	return field === undefined ? undefined : narrowVariantBinding(sanitized, offset, stack, field);
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
	context?: SimpleProjectSemanticContext
): SimpleBinding | undefined {
	if (offset < 0 || offset > source.length || name.length === 0) {
		return undefined;
	}

	const sanitized = sanitizeSource(source);
	return parameterBindingAtDeclaration(sanitized, offset, name)
		?? resolveTypedBinding(sanitized, offset, blockStack(sanitized, offset), name, context);
}

/**
 * 解析指定源码位置可见的参数、变量、字段或属性区组件类型。
 *
 * 该入口供补全以外的语言能力复用，保持点号成员的类型判断一致。
 *
 * @param source 完整 Simple 源码。
 * @param offset 当前查询位置。
 * @param name 待解析的限定名。
 * @returns 已知绑定的数据类型；无法确认时返回 `undefined`。
 */
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
	const snippetParameters = (member.params ?? []).map((parameter, index) => {
		const passing = parameter.passing ?? (parameter.byRef === true ? "传址" : undefined);
		const type = eventDeclaration && parameter.type !== undefined ? ` 为 ${parameter.type}` : "";
		return `${eventDeclaration && passing !== undefined ? `${passing} ` : ""}\${${index + 1}:${parameter.name}}${type}`;
	});

	return {
		description: member.description,
		detail: `${owner} · ${signature}`,
		initials: pinyinInitials(member.name),
		kind: kinds[group],
		name: member.name,
		overloadArity: group === "functions" ? member.params?.length ?? 0 : undefined,
		priority,
		snippet: callable ? `${member.name}(${snippetParameters.join(", ")})` : undefined
	};
}

/** 将当前单元别名转换为补全候选，并在目标是类型时使用类型图标。 */
function aliasCandidate(
	alias: SimpleAliasSymbol,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>,
	priority: number
): SimpleCompletionCandidate {
	const target = definitions.get(alias.target);
	return {
		description: alias.description,
		detail: `别名 · ${alias.target}`,
		initials: pinyinInitials(alias.name),
		kind: target !== undefined && isSdkTypeKind(target.definition.kind) ? "type" : "reference",
		name: alias.name,
		priority
	};
}

/** 枚举当前单元中目标明确为类型的别名。 */
function typeAliasCandidates(
	context: SimpleProjectSemanticContext | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>,
	priority: number
): readonly SimpleCompletionCandidate[] {
	return (context?.currentUnit?.aliases ?? []).flatMap((alias) => {
		const candidate = aliasCandidate(alias, definitions, priority);
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
		.filter(([, reference]) => (
			reference.manifest.kind !== "compiler"
			&& isSdkTypeKind(reference.definition.kind)
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
	const prefix = `${qualifier}.`;
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

/** 判断当前函数式声明是否没有隐式 `本对象` 参数。 */
function isStaticCallable(frame: BlockFrame | undefined): boolean {
	return frame !== undefined && /^[ \t]*静态(?:[ \t]|$)/u.test(frame.header);
}

/** 返回当前函数式语境允许的表达式起始关键字。 */
function expressionKeywords(stack: readonly BlockFrame[]): readonly string[] {
	return isStaticCallable(callableFrame(stack))
		? EXPRESSION_KEYWORDS.filter((keyword) => keyword !== "本对象")
		: EXPRESSION_KEYWORDS;
}

/** 点号限定链当前解析到的对象类型及访问方式。 */
export interface ResolvedSimpleQualifier {
	readonly access: "instance" | "static";
	readonly directCurrentUnit: boolean;
	readonly reference: LibraryDefinitionReference;
}

/** 将声明类型解析为定义；数组维数不影响其元素类型的定义查找。 */
function definitionForType(
	typeName: string | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>,
	context: SimpleProjectSemanticContext | undefined
): LibraryDefinitionReference | undefined {
	if (typeName === undefined) {
		return undefined;
	}

	const normalized = typeName.trim().replace(/\([^()]*\)$/u, "");
	const aliasTarget = context?.currentUnit?.aliases.find((alias) => alias.name === normalized)?.target;
	return definitions.get(aliasTarget ?? normalized)
		?? definitions.get((aliasTarget ?? normalized).split(".").at(-1) ?? normalized);
}

/** 按当前静态或实例访问方式查找成员产生的下一段对象类型。 */
function memberResultDefinition(
	resolved: ResolvedSimpleQualifier,
	memberName: string,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>,
	context: SimpleProjectSemanticContext | undefined
): LibraryDefinitionReference | undefined {
	const groups: readonly LibraryMemberGroup[] = resolved.access === "static"
		? ["constants", "functions", "variables"]
		: ["properties", "variables", "functions"];

	for (const group of groups) {
		const value = getEffectiveMembers(resolved.reference, group, definitions).find(
			(candidate) => candidate.member.name === memberName
		);
		if (value === undefined) {
			continue;
		}

		const isStatic = group === "constants"
			|| value.member.global === true
			|| isStaticProjectMember(value.member);
		if ((resolved.access === "static") !== isStatic) {
			continue;
		}

		return definitionForType(
			group === "functions" ? value.member.return : value.member.type,
			definitions,
			context
		);
	}

	return undefined;
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
	context: SimpleProjectSemanticContext | undefined
): ResolvedSimpleQualifier | undefined {
	const segments = qualifier.split(".");
	const first = segments[0];
	if (first === undefined) {
		return undefined;
	}
	const currentUnit = context?.currentUnit;
	const directCurrentUnit = currentUnit !== undefined && (
		qualifier === currentUnit.qualifiedName
		|| segments.at(-1) === currentUnit.name
	);

	const binding = resolveTypedBinding(sanitized, offset, stack, first, context);
	let consumed = 0;
	let resolved: ResolvedSimpleQualifier | undefined;
	if (binding !== undefined) {
		const reference = definitionForType(binding.typeName, definitions, context);
		if (reference !== undefined) {
			consumed = 1;
			resolved = { access: "instance", directCurrentUnit, reference };
		}
	}

	if (resolved === undefined) {
		for (let length = segments.length; length > 0; length -= 1) {
			const name = segments.slice(0, length).join(".");
			if (currentUnit !== undefined && (
				name === currentUnit.qualifiedName
				|| name === currentUnit.name
			)) {
				const reference = definitions.get(currentUnit.qualifiedName);
				if (reference !== undefined) {
					consumed = length;
					resolved = {
						access: "instance",
						directCurrentUnit: length === segments.length,
						reference
					};
					break;
				}
			}

			const aliasTarget = currentUnit?.aliases.find((alias) => alias.name === name)?.target;
			const reference = definitions.get(aliasTarget ?? name);
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
		const reference = memberResultDefinition(resolved, memberName, definitions, context);
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
	context?: SimpleProjectSemanticContext
): ResolvedSimpleQualifier | undefined {
	if (offset < 0 || offset > source.length || qualifier.length === 0) {
		return undefined;
	}

	const sanitized = sanitizeSource(source);
	return resolveQualifier(
		qualifier,
		sanitized,
		offset,
		blockStack(sanitized, offset),
		buildSemanticDefinitionIndex(sdk, context),
		context
	);
}

/** 枚举类型限定名后可访问的静态常量和清单明确标记的静态全局函数。 */
function staticMemberCandidates(
	reference: LibraryDefinitionReference,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): SimpleCompletionCandidate[] {
	const candidates: SimpleCompletionCandidate[] = [];

	for (const value of getEffectiveMembers(reference, "constants", definitions)) {
		candidates.push(memberCandidate(value.member, "constants", value.owner.definition.name, 0));
	}

	for (const value of getEffectiveMembers(reference, "functions", definitions)) {
		if (value.member.global === true || isStaticProjectMember(value.member)) {
			candidates.push(memberCandidate(value.member, "functions", value.owner.definition.name, 0));
		}
	}

	for (const value of getEffectiveMembers(reference, "variables", definitions)) {
		if (isStaticProjectMember(value.member)) {
			candidates.push(memberCandidate(value.member, "variables", value.owner.definition.name, 0));
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
		: ["properties", "variables", "functions", "events"] as const;
	for (const group of groups) {
		for (const value of getEffectiveMembers(reference, group, definitions)) {
			if (
				(group === "functions" && value.member.global === true)
				|| isStaticProjectMember(value.member)
			) {
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
		for (const group of ["constants", "variables", "properties", "functions", "events"] as const) {
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
		candidates.push(aliasCandidate(alias, definitions, 1));
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
		if (member.component !== true || member.type === undefined) {
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

/** 返回当前最内层可由 `结束` 关闭的关键字。 */
function closingKeyword(stack: readonly BlockFrame[]): string | undefined {
	const names: Readonly<Partial<Record<BlockKind, string>>> = {
		error: "错误",
		event: "事件",
		function: "函数",
		getter: "获取",
		if: "如果",
		property: "属性",
		procedure: "过程",
		select: "判断",
		setter: "设置",
		while: "判断循环"
	};
	const frame = [...stack].reverse().find((candidate) => names[candidate.kind] !== undefined);
	return frame === undefined ? undefined : names[frame.kind];
}

/** 判断光标是否位于 `创建 <类型>` 之后、可继续指定组件容器的位置。 */
function awaitsComponentContainer(prefixBeforeQuery: string): boolean {
	return new RegExp(
		`(?:^|[^\\p{L}\\p{N}_.])创建[ \\t]+${QUALIFIED_IDENTIFIER}[ \\t]+$`,
		"u"
	).test(prefixBeforeQuery);
}

/** 判断函数式声明的当前参数是否已经写完名称、正在等待 `为`。 */
function awaitsParameterType(prefixBeforeQuery: string): boolean {
	const header = new RegExp(
		`^[ \\t]*(?:静态[ \\t]+)?(?:函数|过程|事件)[ \\t]+${QUALIFIED_IDENTIFIER}[ \\t]*\\(`,
		"u"
	).exec(prefixBeforeQuery);
	if (header === null) {
		return false;
	}

	let depth = 1;
	let parameterStart = header[0].length;
	for (let index = parameterStart; index < prefixBeforeQuery.length; index += 1) {
		const current = prefixBeforeQuery[index];
		if (current === "(") {
			depth += 1;
		} else if (current === ")") {
			depth -= 1;
			if (depth === 0) {
				return false;
			}
		} else if (current === "," && depth === 1) {
			parameterStart = index + 1;
		}
	}

	return new RegExp(
		`^[ \\t]*(?:(?:传值|传址)[ \\t]+)?${IDENTIFIER}[ \\t]+$`,
		"u"
	).test(prefixBeforeQuery.slice(parameterStart));
}

/** 判断当前条件末尾是否正在补全类型检验操作符、目标类型或后续逻辑连接符。 */
function trailingTypeCheckStage(prefixBeforeQuery: string): "is" | "type" | "logical" | undefined {
	const marker = prefixBeforeQuery.lastIndexOf("类型检验");
	if (marker < 0) {
		return undefined;
	}

	const suffix = prefixBeforeQuery.slice(marker + "类型检验".length);
	const isMatches = [...suffix.matchAll(/(?:^|[ \t])是(?=[ \t]|$)[ \t]*/gu)];
	const isMatch = isMatches.at(-1);
	if (isMatch === undefined) {
		return suffix.trim().length === 0 ? undefined : "is";
	}

	const typeStart = (isMatch.index ?? 0) + isMatch[0].length;
	const typeText = suffix.slice(typeStart).trim();
	if (typeText.length === 0) {
		return "type";
	}
	const typeReference = new RegExp(
		`^${QUALIFIED_IDENTIFIER}(?:[ \\t]*\\([ \\t]*(?:,[ \\t]*)*\\))?$`,
		"u"
	);
	return typeReference.test(typeText) ? "logical" : undefined;
}

/** 结合块栈生成保守的关键字候选；不能确认合法性时宁可少提示。 */
function contextualKeywordCandidates(
	input: CompletionInput,
	sdk: Sdk,
	stack: readonly BlockFrame[],
	currentUnitType: string | undefined
): SimpleCompletionCandidate[] {
	const prefixBeforeQuery = input.linePrefix.slice(0, input.linePrefix.length - input.query.length);
	const ending = /^[ \t]*结束[ \t]+$/u.test(prefixBeforeQuery);
	if (ending) {
		const closing = closingKeyword(stack);
		return closing === undefined ? [] : compilerCandidates(sdk, [closing], 0);
	}

	const conditionalPrefix = prefixBeforeQuery.trimStart();
	const awaitsThen = /^(?:如果|否则如果)(?:[ \t]|$)/u.test(conditionalPrefix)
		&& !/(?:^|[ \t])则(?:[ \t]|$)/u.test(conditionalPrefix);
	if (awaitsThen) {
		const typeCheckStage = trailingTypeCheckStage(prefixBeforeQuery);
		if (typeCheckStage === "is") {
			return compilerCandidates(sdk, ["是"], 0);
		}
		if (typeCheckStage === "logical") {
			return compilerCandidates(sdk, ["且", "或", "则"], 0);
		}

		return [
			...compilerCandidates(sdk, ["则"], 0),
			...compilerCandidates(sdk, expressionKeywords(stack), 3)
		];
	}

	const functionResultPrefix = new RegExp(
		`^[ \\t]*(?:静态[ \\t]+)?函数[ \\t]+${QUALIFIED_IDENTIFIER}[ \\t]*\\([^\\r\\n]*\\)[ \\t]+$`,
		"u"
	);
	if (functionResultPrefix.test(prefixBeforeQuery)) {
		return compilerCandidates(sdk, ["为"], 0);
	}

	if (awaitsParameterType(prefixBeforeQuery)) {
		return compilerCandidates(sdk, ["为"], 0);
	}

	if (new RegExp(`^[ \\t]*(?:静态[ \\t]+)?(?:变量|常量)[ \\t]+${IDENTIFIER}[ \\t]+$`, "u").test(prefixBeforeQuery)) {
		return compilerCandidates(sdk, ["为"], 0);
	}

	if (/^[ \t]*静态[ \t]+$/u.test(prefixBeforeQuery)) {
		return compilerCandidates(sdk, ["变量", "函数", "过程"], 0);
	}

	if (awaitsComponentContainer(prefixBeforeQuery)) {
		return compilerCandidates(sdk, ["位于"], 0);
	}

	const atStatementStart = /^[ \t]*$/u.test(prefixBeforeQuery);
	if (!atStatementStart) {
		return compilerCandidates(sdk, expressionKeywords(stack), 3);
	}

	const property = [...stack].reverse().find((frame) => frame.kind === "property");
	const callable = callableFrame(stack);
	if (property !== undefined && callable === undefined && stack.at(-1)?.kind === "property") {
		const accessors: string[] = [];
		if (property.getterSeen !== true && property.setterSeen !== true) {
			accessors.push("获取");
		}
		if (property.setterSeen !== true) {
			accessors.push("设置");
		}
		accessors.push("结束");
		return compilerCandidates(sdk, accessors, 0);
	}

	if (currentUnitType === "接口") {
		if (callable !== undefined) {
			return compilerCandidates(sdk, ["结束"], 0);
		}
		return compilerCandidates(sdk, ["别名", "常量", "函数", "过程"], 0);
	}

	if (callable === undefined) {
		return compilerCandidates(sdk, TOP_LEVEL_KEYWORDS, 1);
	}

	const names: string[] = [
		...STATEMENT_KEYWORDS.filter((keyword) => keyword !== "本对象" || !isStaticCallable(callable)),
		"结束"
	];
	const current = stack.at(-1)?.kind;
	if (current === "if") {
		names.push("否则如果", "否则");
	} else if (current === "select") {
		names.push("分支");
	} else if (current === "for") {
		names.push("下个");
	} else if (current === "do") {
		names.push("直到");
	}

	return compilerCandidates(sdk, names, 1);
}

/** 按中文前缀或连续首拼前缀过滤、去重并稳定排序。 */
function filterCandidates(
	candidates: readonly SimpleCompletionCandidate[],
	query: string
): readonly SimpleCompletionCandidate[] {
	const normalizedQuery = query.toLowerCase();
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

/**
 * 生成当前 Simple 代码位置可合法出现的补全候选。
 *
	 * 首拼只用于过滤已经通过语境筛选的候选。注释、字符串及无法解析类型的
	 * 点号表达式都返回空结果，不以全库候选兜底；属性信息只从语义上下文读取。
 */
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

	const stack = blockStack(input.sanitized, offset);
	const definitions = buildSemanticDefinitionIndex(sdk, context);
	const currentUnitType = unitType(context);
	const qualifier = qualifierBefore(input);
	const prefixBeforeQuery = input.linePrefix.slice(0, input.linePrefix.length - input.query.length);
	const conditionalPrefix = prefixBeforeQuery.trimStart();
	const incompleteConditional = /^(?:如果|否则如果)(?:[ \t]|$)/u.test(conditionalPrefix)
		&& !/(?:^|[ \t])则(?:[ \t]|$)/u.test(conditionalPrefix);
	const conditionalTypeCheckStage = incompleteConditional
		? trailingTypeCheckStage(prefixBeforeQuery)
		: undefined;
	const qualifiedTypePrefix = new RegExp(
		`(?:^|[ \\t])(?:(?:为|创建)|别名[ \\t]+${IDENTIFIER}[ \\t]*=)[ \\t]+((?:${IDENTIFIER}\\.)*)$`,
		"u"
	).exec(prefixBeforeQuery)?.[1] ?? "";
	const typePosition = conditionalTypeCheckStage === "type"
		|| qualifiedTypePrefix.length > 0
		|| new RegExp(
			`(?:^|[ \\t])(?:(?:为|创建)|别名[ \\t]+${IDENTIFIER}[ \\t]*=)[ \\t]+$`,
			"u"
		).test(prefixBeforeQuery);
	const aliasTargetPosition = new RegExp(
		`^[ \\t]*别名[ \\t]+${IDENTIFIER}[ \\t]*=[ \\t]*(?:${IDENTIFIER}\\.)*$`,
		"u"
	).test(prefixBeforeQuery);
	const eventOwnerPosition = /^[ \t]*事件[ \t]+$/u.test(prefixBeforeQuery)
		&& callableFrame(stack) === undefined;
	let candidates: SimpleCompletionCandidate[];

	if (eventOwnerPosition) {
		candidates = eventOwnerCandidates(context, definitions);
	} else if (aliasTargetPosition) {
		candidates = aliasTargetCandidates(sdk, context);
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
	} else if (qualifier !== undefined) {
		if (qualifier === "R") {
			candidates = [...resourceMemberCandidates(context)];
		} else {
			const resolved = resolveQualifier(
				qualifier,
				input.sanitized,
				offset,
				stack,
				definitions,
				context
			);

			if (resolved === undefined) {
				candidates = [...namespaceMemberCandidates(qualifier, definitions)];
			} else if (resolved.access === "instance") {
				const eventDeclaration = /^[ \t]*事件[ \t]+/u.test(input.linePrefix);
				candidates = instanceMemberCandidates(resolved.reference, definitions, eventDeclaration);
			} else {
				candidates = staticMemberCandidates(resolved.reference, definitions);
			}
		}
	} else {
		const allowsRuntimeValues = callableFrame(stack) !== undefined
			&& unitType(context) !== "接口";
		const structuralEnding = /^[ \t]*结束[ \t]+$/u.test(prefixBeforeQuery);
		const keywordOnly = structuralEnding
			|| awaitsComponentContainer(prefixBeforeQuery)
			|| conditionalTypeCheckStage === "is"
			|| conditionalTypeCheckStage === "logical";
		const keywordCandidates = sdk === undefined
			? []
			: contextualKeywordCandidates(input, sdk, stack, currentUnitType);
		candidates = keywordOnly
			? keywordCandidates
			: [
				...keywordCandidates,
				...(allowsRuntimeValues
					? visibleLocalBindings(input.sanitized, offset, stack).map((binding) => bindingCandidate(binding, 0))
					: []),
				...(allowsRuntimeValues
					? currentUnitCandidates(context, definitions, isStaticCallable(callableFrame(stack)))
					: []),
				...(allowsRuntimeValues && sdk !== undefined ? globalValueCandidates(sdk, 2) : []),
				...(allowsRuntimeValues ? semanticTypeCandidates(definitions, 4) : [])
			];
	}

	const query = qualifiedTypePrefix + input.query;
	return {
		candidates: filterCandidates(candidates, query),
		end: input.end,
		query,
		start: input.start - qualifiedTypePrefix.length
	};
}
