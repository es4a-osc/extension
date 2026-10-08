/*
按当前 Simple 扫描器规则解析和序列化属性框使用的字符串字面量。
xhwsd@qq.com 2026-8-30
*/

/** 解析一个完整字符串字面量；组合表达式和损坏值返回 undefined。 */
export function parseSimpleStringLiteral(expression: string): string | undefined {
	const source = expression.trim();
	if (!source.startsWith("\"")) return undefined;
	let value = "";
	for (let index = 1; index < source.length; index += 1) {
		const character = source[index];
		if (character === "\"") {
			return index === source.length - 1 ? value : undefined;
		}
		if (character === "\r" || character === "\n") return undefined;
		if (character !== "\\") {
			value += character;
			continue;
		}
		const escaped = source[index + 1];
		if (escaped === undefined) return undefined;
		index += 1;
		switch (escaped) {
			case "n": value += "\n"; break;
			case "r": value += "\r"; break;
			case "t": value += "\t"; break;
			case "u": {
				const digits = source.slice(index + 1, index + 5);
				if (!/^[0-9A-Fa-f]{4}$/u.test(digits)) return undefined;
				value += String.fromCharCode(Number.parseInt(digits, 16));
				index += 4;
				break;
			}
			default: value += escaped; break;
		}
	}
	return undefined;
}

/** 将普通文本编码为合法的 Simple 字符串字面量。 */
export function serializeSimpleStringLiteral(value: string): string {
	return "\"" + value
		.replaceAll("\\", "\\\\")
		.replaceAll("\"", "\\\"")
		.replaceAll("\r", "\\r")
		.replaceAll("\n", "\\n")
		.replaceAll("\t", "\\t") + "\"";
}
