/*
构建编辑器无关的签名定义，并解析 Simple 调用上下文。
xhwsd@qq.com 2026-8-27
*/

import type { Sdk, LibraryMember } from "./sdk";
import { findAdjacentSimpleDocumentationComment } from "./simpleDocumentation";

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
	/** 从零开始的活动参数序号。 */
	readonly activeParameter: number;
	/** 当前调用名称。 */
	readonly name: string;
	/** 调用名称在文档中的起始偏移。 */
	readonly nameStart: number;
	/** 点号调用前的可选限定名。 */
	readonly qualifier?: string;
}

/** Simple 标识符允许出现的单个字符。 */
const IDENTIFIER_CHARACTER = /^[\p{L}\p{N}_]$/u;

/**
 * 按括号层级拆分正式参数列表。
 *
 * @param source 声明括号内的参数文本。
 * @returns 去除首尾空白并保留原始顺序的参数片段。
 */
function splitParameters(source: string): string[] {
	const result: string[] = [];
	let depth = 0;
	let start = 0;

	// 数组类型可以写成“整数型(,)”，只能切分最外层的参数逗号。
	for (let index = 0; index < source.length; index += 1) {
		switch (source[index]) {
			case "(":
				depth += 1;
				break;
			case ")":
				depth = Math.max(0, depth - 1);
				break;
			case ",":
				if (depth === 0) {
					result.push(source.slice(start, index).trim());
					start = index + 1;
				}
				break;
		}
	}

	result.push(source.slice(start).trim());
	return result.filter((value) => value.length > 0);
}

/**
 * 解析一个 Simple 正式参数，兼容可选的 `传值` 和 `传址` 修饰。
 *
 * @param source 单个正式参数的源码文本。
 * @returns 解析后的参数；语法不匹配时返回 `undefined`。
 */
function parseParameter(source: string): SignatureParameter | undefined {
	const match = /^(?:(传值|传址)\s+)?([\p{L}_][\p{L}\p{N}_]*)\s+为\s+(.+)$/u.exec(source);

	if (match === null || match[2] === undefined || match[3] === undefined) {
		return undefined;
	}

	return {
		byRef: match[1] === "传址",
		name: match[2],
		type: match[3].trim()
	};
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
export function buildDocumentSignatures(source: string): readonly SignatureDefinition[] {
	const signatures: SignatureDefinition[] = [];
	const declaration = /^[ \t]*(?:静态[ \t]+)?(函数|过程|事件)[ \t]+([\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)?)[ \t]*\((.*)\)(?:[ \t]+为[ \t]+([^\r\n']+))?/gmu;

	for (const match of source.matchAll(declaration)) {
		const declarationKind = match[1];
		const qualifiedName = match[2];

		if (qualifiedName === undefined) {
			continue;
		}

		const nameParts = qualifiedName.split(".");
		const name = nameParts.at(-1);

		if (name === undefined) {
			continue;
		}

		signatures.push({
			description: findAdjacentSimpleDocumentationComment(source, match.index),
			name,
			owner: nameParts.length > 1 ? nameParts[0] : undefined,
			parameters: splitParameters(match[3] ?? "")
				.map(parseParameter)
				.filter((parameter): parameter is SignatureParameter => parameter !== undefined),
			return: declarationKind === "函数" ? match[4]?.trim() : undefined
		});
	}

	return signatures;
}

/** 扫描到光标时仍未闭合的一层括号及其参数位置。 */
interface ParenthesisFrame {
	/** 当前括号内从零开始的参数序号。 */
	activeParameter: number;
	/** 左括号在文档中的 UTF-16 偏移。 */
	openOffset: number;
}

/**
 * 从指定结束偏移向前读取一个完整 Simple 标识符。
 *
 * @param source 完整文档内容。
 * @param end 标识符末尾的排他偏移。
 * @returns 标识符文本及起始偏移；当前位置之前没有标识符时返回 `undefined`。
 */
function readIdentifierBackward(source: string, end: number): { readonly start: number; readonly text: string } | undefined {
	let cursor = end;

	while (cursor > 0 && IDENTIFIER_CHARACTER.test(source[cursor - 1] ?? "")) {
		cursor -= 1;
	}

	return cursor === end ? undefined : { start: cursor, text: source.slice(cursor, end) };
}

/**
 * 尝试把一个尚未闭合的括号帧解释为函数调用。
 *
 * @param source 完整文档内容。
 * @param frame 扫描到光标时仍未闭合的括号帧。
 * @returns 调用名称、限定名和活动参数；括号不是调用时返回 `undefined`。
 */
function callAtFrame(source: string, frame: ParenthesisFrame): CallContext | undefined {
	let nameEnd = frame.openOffset;

	while (nameEnd > 0 && /[ \t\f]/.test(source[nameEnd - 1] ?? "")) {
		nameEnd -= 1;
	}

	const name = readIdentifierBackward(source, nameEnd);

	if (name === undefined) {
		return undefined;
	}

	// 函数声明自己的参数列表不是一次调用，不应在声明处弹出参数提示。
	const lineStart = source.lastIndexOf("\n", name.start - 1) + 1;
	const linePrefix = source.slice(lineStart, name.start);

	if (/(?:^|\s)(?:静态\s+)?(?:函数|过程|事件|属性)\s*$/u.test(linePrefix)) {
		return undefined;
	}

	let qualifier: string | undefined;
	let qualifierEnd = name.start;

	while (qualifierEnd > 0 && /[ \t\f]/.test(source[qualifierEnd - 1] ?? "")) {
		qualifierEnd -= 1;
	}

	if (source[qualifierEnd - 1] === ".") {
		const qualifierName = readIdentifierBackward(source, qualifierEnd - 1);
		qualifier = qualifierName?.text;
	}

	return {
		activeParameter: frame.activeParameter,
		name: name.text,
		nameStart: name.start,
		qualifier
	};
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
	let cursor = identifierEnd;
	while (cursor < source.length && /[ \t\f]/u.test(source[cursor] ?? "")) {
		cursor += 1;
	}
	if (source[cursor] !== "(") {
		return undefined;
	}

	let depth = 1;
	let commaCount = 0;
	let hasArgument = false;
	let inComment = false;
	let inString = false;
	for (let index = cursor + 1; index < source.length; index += 1) {
		const current = source[index];
		if (inComment) {
			if (current === "\n" || current === "\r") {
				inComment = false;
			}
			continue;
		}
		if (inString) {
			if (current === "\\") {
				index += 1;
			} else if (current === "\"") {
				inString = false;
			}
			continue;
		}
		if (current === "'") {
			inComment = true;
		} else if (current === "\"") {
			inString = true;
			if (depth === 1) hasArgument = true;
		} else if (current === "(") {
			if (depth === 1) hasArgument = true;
			depth += 1;
		} else if (current === ")") {
			depth -= 1;
			if (depth === 0) {
				return hasArgument ? commaCount + 1 : 0;
			}
		} else if (current === "," && depth === 1) {
			commaCount += 1;
		} else if (depth === 1 && !/\s/u.test(current ?? "")) {
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
export function findCallContext(source: string, offset: number): CallContext | undefined {
	const frames: ParenthesisFrame[] = [];
	let inComment = false;
	let inString = false;

	// 从文档开头扫描到光标，避免把字符串和注释中的括号、逗号计入调用层级。
	for (let index = 0; index < Math.min(offset, source.length); index += 1) {
		const current = source[index];

		if (inComment) {
			if (current === "\n") {
				inComment = false;
			}
			continue;
		}

		if (inString) {
			if (current === "\\" && index + 1 < offset) {
				index += 1;
			} else if (current === "\"") {
				inString = false;
			}
			continue;
		}

		if (current === "'") {
			inComment = true;
		} else if (current === "\"") {
			inString = true;
		} else if (current === "(") {
			frames.push({ activeParameter: 0, openOffset: index });
		} else if (current === ")") {
			frames.pop();
		} else if (current === "," && frames.length > 0) {
			const frame = frames[frames.length - 1];

			if (frame !== undefined) {
				frame.activeParameter += 1;
			}
		}
	}

	// 括号表达式可能包在调用内部，因此从内向外寻找最近的有效调用名。
	for (let index = frames.length - 1; index >= 0; index -= 1) {
		const frame = frames[index];
		const context = frame === undefined ? undefined : callAtFrame(source, frame);

		if (context !== undefined) {
			return context;
		}
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
