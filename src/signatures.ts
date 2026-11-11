/*
构建编辑器无关的签名定义，并解析 Simple 调用上下文。
xhwsd@qq.com 2026-8-27
*/

import type { Sdk, LibraryMember } from "./sdk";
import { findAdjacentSimpleDocumentationComment } from "./simpleDocumentation";
import { scanSimpleSource, skipSimpleContinuationWhitespace, type SimpleSourceToken } from "./simpleSourceLexical";
import { analyzeSimpleSourceSyntax, isSimpleEventTarget, type SimpleSourceSyntax } from "./simpleSourceSyntax";

/** 编辑器中立的正式参数定义。 */
export interface SignatureParameter {
	/** 是否按引用传递参数。 */
	readonly byRef?: boolean;
	/** 参数说明。 */
	readonly description?: string;
	/** 参数名称。 */
	readonly name: string;
	/** 参数数据类型。 */
	readonly type?: string;
}

/** 编辑器中立的函数、过程或事件签名。 */
export interface SignatureDefinition {
	/** 事件只能在触发事件语句中提示，不与普通函数混为同一候选集合。 */
	readonly event?: true;
	/** 函数、过程或事件说明。 */
	readonly description?: string;
	/** 不包含限定名的调用名称。 */
	readonly name: string;
	/** 可选的对象或组件限定名。 */
	readonly owner?: string;
	/** 按声明顺序排列的正式参数。 */
	readonly parameters: readonly SignatureParameter[];
	/** 函数返回类型；过程和事件为空。 */
	readonly return?: string;
}

/** 描述光标当前所在的调用和活动参数序号。 */
export interface CallContext {
	readonly event?: true;
	/** 从零开始的活动参数序号。 */
	readonly activeParameter: number;
	/** 当前调用名称。 */
	readonly name: string;
	/** 调用名称在文档中的起始偏移。 */
	readonly nameStart: number;
	/** 点号调用前的可选限定名。 */
	readonly qualifier?: string;
}

/**
 * 将类库成员转换为编辑器中立签名。
 *
 * @param owner 成员所属对象或组件名称。
 * @param member 类库函数或事件成员。
 * @returns 可由不同编辑器适配层复用的签名定义。
 */
export function signatureFromMember(owner: string | undefined, member: LibraryMember): SignatureDefinition {
	return {
		description: member.description,
		name: member.name,
		owner,
		parameters: (member.params ?? []).map((parameter) => ({
			byRef: parameter.byRef,
			description: parameter.description,
			name: parameter.name,
			type: parameter.type
		})),
		return: member.return
	};
}

/**
 * 从全部 SDK 清单收集函数和事件签名。
 *
 * @param sdk 当前已加载的 SDK；未配置时可为空。
 * @returns 保留清单顺序的签名数组，供支持重载和同名成员。
 */
export function buildSdkSignatures(sdk: Sdk | undefined): readonly SignatureDefinition[] {
	if (sdk === undefined) {
		return [];
	}

	const signatures: SignatureDefinition[] = [];

	// 函数和事件都带有正式参数；属性目前没有带参数的清单结构。
	for (const manifest of sdk.manifests) {
		for (const category of manifest.categories) {
			for (const definition of category.definitions) {
				for (const member of [...(definition.functions ?? []), ...(definition.events ?? [])]) {
					signatures.push(signatureFromMember(definition.name, member));
				}
			}
		}
	}

	return signatures;
}

/**
 * 从当前 Simple 文档收集函数、过程和事件声明。
 *
 * 该轻量解析仅服务编辑期提示；最终语法有效性仍由 Java 编译器裁决。
 *
 * @param source 当前 Simple 文档内容。
 * @returns 保留源码声明顺序的签名数组。
 */
export function buildDocumentSignatures(source: string, syntax: SimpleSourceSyntax = analyzeSimpleSourceSyntax(source)): readonly SignatureDefinition[] {
	return syntax.declarations.filter((declaration) => declaration.implicit !== true
		&& ["function", "procedure", "event"].includes(declaration.kind)).map((declaration) => ({
		description: findAdjacentSimpleDocumentationComment(source, declaration.statementStart),
		name: declaration.name,
			...(declaration.kind === "event" ? { event: true as const } : {}),
		owner: declaration.owner,
		parameters: (declaration.parameters ?? []).map((parameter) => ({
			byRef: parameter.passing === "传址", name: parameter.name, type: parameter.typeName
		})),
		return: declaration.kind === "function" ? declaration.typeName : undefined
	}));
}

/** 扫描到光标时仍未闭合的一层括号及其参数位置。 */
interface ParenthesisFrame {
	/** 当前括号内从零开始的参数序号。 */
	activeParameter: number;
	/** 左括号在文档中的 UTF-16 偏移。 */
	openOffset: number;
}

/** 用共享令牌读取调用名和限定名，声明头本身不作为调用。 */
function callAtFrame(tokens: readonly SimpleSourceToken[], index: number, frame: ParenthesisFrame, syntax: SimpleSourceSyntax): CallContext | undefined {
	const name = tokens[index - 1];
	if (name?.kind !== "word") return undefined;
	const declaration = syntax.declarationAt(name.start);
	if (declaration !== undefined && declaration.token.start === name.start
		&& ["function", "procedure", "event", "property"].includes(declaration.kind)) return undefined;
	const parts: string[] = [];
	let first = index - 1;
	while (tokens[first - 1]?.text === "." && tokens[first - 2]?.kind === "word") { parts.unshift(tokens[first - 2]!.text); first -= 2; }
	return { activeParameter: frame.activeParameter, name: name.text, nameStart: name.start,
		...(isSimpleEventTarget(syntax, name.start) ? { event: true as const } : {}),
		qualifier: parts.length === 0 ? undefined : parts.join(".") };
}

/**
 * 读取标识符后完整实参列表的参数个数。
 *
 * 字符串、注释及嵌套调用中的逗号不会被计入；调用尚未闭合或标识符后没有左括号时返回
 * `undefined`，避免把不完整源码错误绑定到某个重载。
 */
export function findCallableArgumentCount(
	source: string,
	identifierEnd: number
): number | undefined {
	const cursor = skipSimpleContinuationWhitespace(source, identifierEnd);
	if (source[cursor] !== "(") {
		return undefined;
	}

	let depth = 0;
	let commaCount = 0;
	let hasArgument = false;
	// 与调用位置共用词法令牌；合法续行不是实参，普通换行也不能跨语句寻找右括号。
	for (const token of scanSimpleSource(source.slice(cursor))) {
		if (token.kind === "comment" || token.kind === "continuation") continue;
		if (token.kind === "separator") return undefined;
		if (token.text === "(" && token.kind === "punctuation") {
			if (depth === 1) hasArgument = true;
			depth += 1;
		} else if (token.text === ")" && token.kind === "punctuation") {
			depth -= 1;
			if (depth === 0) {
				return hasArgument ? commaCount + 1 : 0;
			}
		} else if (token.text === "," && token.kind === "punctuation" && depth === 1) {
			commaCount += 1;
		} else if (depth === 1) {
			hasArgument = true;
		}
	}

	return undefined;
}

/**
 * 查找光标所在的最近调用，并计算当前参数序号。
 *
 * 扫描会忽略注释和字符串中的括号、逗号，并正确处理嵌套调用。
 *
 * @param source 完整文档内容。
 * @param offset 光标在文档中的 UTF-16 偏移。
 * @returns 最近调用上下文；不在已知调用括号内时返回 `undefined`。
 */
export function findCallContext(source: string, offset: number, syntax: SimpleSourceSyntax = analyzeSimpleSourceSyntax(source)): CallContext | undefined {
	const frames: Array<{ readonly index: number; readonly frame: ParenthesisFrame }> = [];
	const tokens = syntax.tokens.filter((token) => token.kind !== "comment" && token.kind !== "continuation");
	for (let index = 0; index < tokens.length && tokens[index]!.start < offset; index++) {
		const token = tokens[index]!;
		if (token.kind === "separator") frames.length = 0;
		else if (token.text === "(" && token.kind === "punctuation") frames.push({ index, frame: { activeParameter: 0, openOffset: token.start } });
		else if (token.text === ")" && token.kind === "punctuation") frames.pop();
		else if (token.text === "," && token.kind === "punctuation" && frames.length > 0) frames.at(-1)!.frame.activeParameter++;
	}
	for (let index = frames.length - 1; index >= 0; index--) {
		const frame = frames[index]!;
		const context = callAtFrame(tokens, frame.index, frame.frame, syntax);
		if (context !== undefined) return context;
	}
	return undefined;
}

/**
 * 将单个正式参数格式化为 Simple 源码风格。
 *
 * @param parameter 参数定义。
 * @returns 可直接嵌入签名标签的参数文本。
 */
export function formatParameter(parameter: SignatureParameter): string {
	const passing = parameter.byRef === true ? "传址 " : "";
	return `${passing}${parameter.name}${parameter.type === undefined ? "" : ` 为 ${parameter.type}`}`;
}

/**
 * 将完整签名格式化为参数提示中显示的 Simple 源码风格。
 *
 * @param signature 编辑器中立签名。
 * @returns 包含限定名、参数和返回类型的显示文本。
 */
export function formatSignature(signature: SignatureDefinition): string {
	const owner = signature.owner === undefined ? "" : `${signature.owner}.`;
	const parameters = signature.parameters.map(formatParameter).join(", ");
	const returnType = signature.return === undefined ? "" : ` 为 ${signature.return}`;
	return `${owner}${signature.name}(${parameters})${returnType}`;
}
