/*
提供不依赖 VS Code 的 Simple 词法扫描、逻辑分句及字符串和注释屏蔽。
xhwsd@qq.com 2026-9-10
*/

import languageFacts from "./simpleLanguageFacts.json";

/** 保留 UTF-16 位置的源码令牌；换行和冒号分句，合法续行不分句。 */
export interface SimpleSourceToken {
	readonly kind: "word" | "number" | "string" | "comment" | "operator" | "punctuation" | "separator" | "continuation" | "invalid";
	readonly text: string;
	readonly start: number;
	readonly end: number;
	readonly line: number;
	readonly character: number;
}

/** 按 UTF-16 位置定位令牌；名称末尾的查询可以明确选择左侧令牌。 */
export function simpleSourceTokenIndex(tokens: readonly SimpleSourceToken[], offset: number, includeEnd = false): number {
	let low = 0;
	let high = tokens.length;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if (tokens[middle]!.start < offset || !includeEnd && tokens[middle]!.start === offset) {
			low = middle + 1;
		} else {
			high = middle;
		}
	}
	const index = low - 1;
	const token = tokens[index];
	if (token !== undefined && offset >= token.start && (offset < token.end || includeEnd && offset === token.end)) {
		return index;
	}
	return tokens[low]?.start === offset ? low : -1;
}

/** 与 Scanner 的 Java 标识符字符类别一致，首字符另外排除美元符和下划线。 */
const IDENTIFIER_START = /[\p{L}\p{Nl}\p{Sc}\p{Pc}]/u;
const IDENTIFIER_PART = /[\p{L}\p{Nl}\p{Sc}\p{Pc}\p{Nd}\p{Mn}\p{Mc}\p{Cf}\u0000-\u0008\u000e-\u001b\u007f-\u009f]/u;

/** 所有编辑期入口共用编译器的完整字符边界，禁止把合法名称截成其它符号。 */
export const SIMPLE_IDENTIFIER_CHARACTER = /(?!\$)[\p{L}\p{Nl}\p{Sc}\p{Pc}\p{Nd}\p{Mn}\p{Mc}\p{Cf}\u0000-\u0008\u000e-\u001b\u007f-\u009f]/u;
export const SIMPLE_IDENTIFIER_PATTERN = "(?![$_])[\\p{L}\\p{Nl}\\p{Sc}\\p{Pc}](?:(?!\\$)[\\p{L}\\p{Nl}\\p{Sc}\\p{Pc}\\p{Nd}\\p{Mn}\\p{Mc}\\p{Cf}\\u0000-\\u0008\\u000e-\\u001b\\u007f-\\u009f])*";

/** Scanner 按 Java char 扫描，因此这里也按 UTF-16 单元校验。 */
export function isSimpleIdentifier(name: string): boolean {
	return name.length > 0 && name.split("").every((character, index) => isSimpleIdentifierCharacter(character, index === 0));
}

/** 返回完整词法名称的范围；光标在名称末尾时允许命中紧邻的左词。 */
export function simpleIdentifierRange(source: string, offset: number): { readonly start: number; readonly end: number; readonly name: string } | undefined {
	let start = isSimpleIdentifierCharacter(source[offset] ?? "") ? offset : offset - 1;
	if (start < 0 || !isSimpleIdentifierCharacter(source[start] ?? "")) return undefined;
	let end = start + 1;
	while (start > 0 && isSimpleIdentifierCharacter(source[start - 1]!)) start--;
	while (end < source.length && isSimpleIdentifierCharacter(source[end]!)) end++;
	const name = source.slice(start, end);
	return isSimpleIdentifier(name) ? { start, end, name } : undefined;
}

/** 判断编译器允许的单个标识符字符。 */
export function isSimpleIdentifierCharacter(character: string, first = false): boolean {
	return character.length > 0 && character !== "$" && (!first || character !== "_")
		&& (first ? IDENTIFIER_START : IDENTIFIER_PART).test(character);
}

/** 扫描代码或边界适配器提供的预览文本；损坏字符串在物理行末恢复。 */
export function scanSimpleSource(source: string): readonly SimpleSourceToken[] {
	const tokens: SimpleSourceToken[] = [];
	let index = 0;
	let line = 0;
	let character = 0;
	while (index < source.length) {
		const start = index;
		const tokenLine = line;
		const tokenCharacter = character;
		const current = source[index]!;
		let kind: SimpleSourceToken["kind"];
		if (current === "\r" || current === "\n") {
			index += current === "\r" && source[index + 1] === "\n" ? 2 : 1;
			kind = "separator";
			line += 1;
			character = 0;
		} else if (current === "_" && (source[index + 1] === "\n" || source.slice(index + 1, index + 3) === "\r\n")) {
			index += source[index + 1] === "\n" ? 2 : 3;
			kind = "continuation";
			line += 1;
			character = 0;
		} else if (/\s/u.test(current)) {
			index += 1;
			character += 1;
			continue;
		} else {
			if (current === "'") {
				kind = "comment";
				while (index < source.length && !/[\r\n]/u.test(source[index]!)) {
					index += 1;
				}
			} else if (current === "\"") {
				kind = "string";
				index += 1;
				while (index < source.length && !/[\r\n]/u.test(source[index]!)) {
					if (source[index] === "\\" && index + 1 < source.length && !/[\r\n]/u.test(source[index + 1]!)) {
						index += 2;
					} else if (source[index++] === "\"") {
						break;
					}
				}
			} else if (isSimpleIdentifierCharacter(current, true) || current === "$" && isSimpleIdentifierCharacter(source[index + 1] ?? "", true)) {
				kind = "word";
				index += 1;
				while (index < source.length && isSimpleIdentifierCharacter(source[index]!)) {
					index += 1;
				}
			} else {
				const number = /^(?:&H[\dA-Fa-f]+|\d+(?:\.\d+(?:[Ee][+-]?\d+)?)?)/u.exec(source.slice(index));
				const operator = languageFacts.operators.find((value) => source.startsWith(value, index));
				if (number !== null) {
					kind = "number";
					index += number[0].length;
				} else if (operator !== undefined) {
					kind = "operator";
					index += operator.length;
				} else {
					kind = current === ":" ? "separator" : /[(),.]/u.test(current) ? "punctuation" : "invalid";
					index += 1;
				}
			}
			character += index - start;
		}
		tokens.push({ kind, text: source.slice(start, index), start, end: index, line: tokenLine, character: tokenCharacter });
	}
	return tokens;
}

/** 分出逻辑语句，字符串中的冒号、逗号和合法续行均不作为语句边界。 */
export function simpleSourceStatements(tokens: readonly SimpleSourceToken[]): readonly (readonly SimpleSourceToken[])[] {
	const statements: SimpleSourceToken[][] = [[]];
	for (const token of tokens) {
		if (token.kind === "separator") {
			statements.push([]);
		} else if (token.kind !== "comment" && token.kind !== "continuation") {
			statements.at(-1)!.push(token);
		}
	}
	return statements.filter((statement) => statement.length > 0);
}

/** 判断指定偏移是否位于 Simple 字符串或单行注释中。 */
export function isSimpleIgnoredOffset(source: string, offset: number, includeOffset: boolean): boolean {
	const end = Math.min(source.length, Math.max(0, offset + (includeOffset ? 1 : 0)));
	let inComment = false;
	let inString = false;
	for (let index = 0; index < end; index += 1) {
		const current = source[index];
		if (current === "\n" || current === "\r") {
			inComment = false;
			inString = false;
		} else if (inComment) {
			continue;
		} else if (inString) {
			if (current === "\\" && index + 1 < end && source[index + 1] !== "\r" && source[index + 1] !== "\n") {
				index += 1;
			} else if (current === "\"") {
				inString = false;
			}
		} else if (current === "'") {
			inComment = true;
		} else if (current === "\"") {
			inString = true;
		}
	}
	return inComment || inString;
}

/** 删除字符串之外的 Simple 行尾注释。 */
export function stripSimpleLineComment(value: string): string {
	let inString = false;
	for (let index = 0; index < value.length; index += 1) {
		const current = value[index];
		if (current === "\\" && inString) {
			index += 1;
		} else if (current === "\"") {
			inString = !inString;
		} else if (current === "'" && !inString) {
			return value.slice(0, index);
		}
	}
	return value;
}

/** 屏蔽字符串和注释但保留物理行及 UTF-16 偏移，供引用扫描使用。 */
export function maskSimpleIgnoredText(source: string, tokens?: readonly SimpleSourceToken[]): string {
	if (tokens !== undefined) {
		const result = source.split("");
		for (const token of tokens) {
			if (token.kind !== "comment" && token.kind !== "string") {
				continue;
			}
			for (let index = token.start; index < token.end; index += 1) {
				if (source[index] !== "\r" && source[index] !== "\n") {
					result[index] = " ";
				}
			}
		}
		return result.join("");
	}
	let comment = false;
	let quoted = false;
	const result = source.split("");
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index];
		if (character === "\r" || character === "\n") {
			comment = false;
			quoted = false;
			continue;
		}
		if (comment) result[index] = " ";
		else if (quoted) {
			result[index] = " ";
			if (character === "\\" && index + 1 < source.length && !/[\r\n]/u.test(source[index + 1]!)) {
				result[++index] = " ";
			} else if (character === "\"") quoted = false;
		} else if (character === "'" || character === "\"") {
			result[index] = " ";
			comment = character === "'";
			quoted = character === "\"";
		}
	}
	return result.join("");
}
