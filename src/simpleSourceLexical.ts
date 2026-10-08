/*
提供不依赖 VS Code 的 Simple 字符串与单行注释基础扫描规则。
xhwsd@qq.com 2026-9-10
*/

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
			if (current === "\\" && index + 1 < end) {
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
