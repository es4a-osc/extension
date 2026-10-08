/*
提取 Simple 单元与声明的文档注释，供悬停等语言能力复用。
xhwsd@qq.com 2026-9-1
*/

/** 解析一行显式三单引号文档注释；普通单引号注释不会进入文档说明。 */
function documentationLineValue(line: string): string | undefined {
	const match = /^[ \t]*'''[ \t]?(.*)$/u.exec(line);
	return match?.[1];
}

/** 判断文档注释内容行是否只含空白。 */
function isBlankDocumentationLine(value: string | undefined): boolean {
	return value !== undefined && /^[ \t]*$/u.test(value);
}

/**
 * 返回声明正上方连续的三单引号文档注释，并保留注释行顺序。
 *
 * 普通注释、代码行和物理空白行会终止关联；空文档注释行作为段内换行保留，
 * 但不会单独构成有效说明。
 */
export function findAdjacentSimpleDocumentationComment(
	source: string,
	declarationOffset: number
): string | undefined {
	if (declarationOffset <= 0 || declarationOffset > source.length) {
		return undefined;
	}

	const previousNewline = Math.max(
		source.lastIndexOf("\n", declarationOffset - 1),
		source.lastIndexOf("\r", declarationOffset - 1)
	);
	const declarationLineStart = previousNewline + 1;
	if (declarationLineStart === 0) {
		return undefined;
	}

	const lines = source.slice(0, declarationLineStart).split(/\r\n|\n|\r/u);
	if (lines.at(-1) === "") {
		lines.pop();
	}

	const values: string[] = [];
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const value = documentationLineValue(lines[index] ?? "");
		if (value === undefined) {
			break;
		}
		values.unshift(value);
	}

	while (isBlankDocumentationLine(values[0])) {
		values.shift();
	}
	while (isBlankDocumentationLine(values.at(-1))) {
		values.pop();
	}
	return values.length === 0 ? undefined : values.join("\n");
}

/**
 * 返回首个代码定义之前、与后续声明由空白行隔开的三单引号单元文档块。
 *
 * 普通单引号许可证和文件头不会成为单元说明；多个有效文档块中采用最接近
 * 首个代码定义的一块。
 */
export function findSimpleUnitComment(source: string): string | undefined {
	const lines = source.split(/\r\n|\n|\r/u);
	let description: string | undefined;

	for (let index = 0; index < lines.length;) {
		const line = lines[index] ?? "";
		if (/^[ \t]*$/u.test(line)) {
			index += 1;
			continue;
		}

		if (!/^[ \t]*'/u.test(line)) {
			break;
		}

		const firstValue = documentationLineValue(line);
		if (firstValue === undefined) {
			index += 1;
			continue;
		}

		const values: string[] = [];
		while (index < lines.length) {
			const value = documentationLineValue(lines[index] ?? "");
			if (value === undefined) {
				break;
			}
			values.push(value);
			index += 1;
		}

		const nextIsBlank = index < lines.length && /^[ \t]*$/u.test(lines[index] ?? "");
		while (isBlankDocumentationLine(values[0])) {
			values.shift();
		}
		while (isBlankDocumentationLine(values.at(-1))) {
			values.pop();
		}
		if (nextIsBlank && values.length > 0) {
			description = values.join("\n");
		}
	}

	return description;
}
