/*
分析 Simple 文本增量变化，并仅在代码区域生成中文符号半角化替换。
xhwsd@qq.com 2026-8-27
*/

/** 不依赖 VS Code 文档对象的文本变化。 */
export interface SimpleTextChange {
	readonly content: string;
	readonly rangeLength: number;
	readonly rangeOffset: number;
}

/** 在变化后的文档中需要执行的一次符号替换。 */
export interface SimplePunctuationReplacement {
	readonly end: number;
	readonly start: number;
	readonly text: string;
}

/** Simple 编译器实际接受的语法符号所对应的中文输入字符。 */
const SIMPLE_PUNCTUATION: Readonly<Record<string, string>> = {
	"　": " ",
	"＂": "\"",
	"＄": "$",
	"￥": "$",
	"＆": "&",
	"＇": "'",
	"（": "(",
	"）": ")",
	"＊": "*",
	"＋": "+",
	"，": ",",
	"－": "-",
	"。": ".",
	"．": ".",
	"／": "/",
	"：": ":",
	"＜": "<",
	"＝": "=",
	"＞": ">",
	"＼": "\\",
	"＾": "^",
	"＿": "_",
	"、": "\\",
	"《": "<",
	"》": ">",
	"“": "\"",
	"”": "\"",
	"‘": "'"
};

/** 中文输入法一次产生的成对符号到单个 Simple 语法符号的映射。 */
const SIMPLE_PUNCTUATION_PAIRS: Readonly<Record<string, string>> = {
	"……": "^",
	"——": "_",
	"‘’": "'"
};

/** 一次文本增量应用后，新插入内容在结果文本中的稳定范围。 */
interface InsertedRange {
	readonly content: string;
	readonly end: number;
	readonly start: number;
}

/** 按旧文档坐标应用非重叠变化，并记录每段新输入内容在新文档中的位置。 */
function applyChanges(
	previousSource: string,
	changes: readonly SimpleTextChange[]
): { readonly ranges: readonly InsertedRange[]; readonly source: string } | undefined {
	const ordered = [...changes].sort((left, right) => left.rangeOffset - right.rangeOffset);
	const ranges: InsertedRange[] = [];
	const parts: string[] = [];
	let oldOffset = 0;
	let newOffset = 0;

	for (const change of ordered) {
		if (
			change.rangeOffset < oldOffset
			|| change.rangeOffset < 0
			|| change.rangeLength < 0
			|| change.rangeOffset + change.rangeLength > previousSource.length
		) {
			return undefined;
		}

		const unchanged = previousSource.slice(oldOffset, change.rangeOffset);
		parts.push(unchanged, change.content);
		newOffset += unchanged.length;
		ranges.push({
			content: change.content,
			end: newOffset + change.content.length,
			start: newOffset
		});
		newOffset += change.content.length;
		oldOffset = change.rangeOffset + change.rangeLength;
	}

	parts.push(previousSource.slice(oldOffset));
	return { ranges, source: parts.join("") };
}

/**
 * 找出本次新输入内容中位于代码区域的中文符号。
 *
 * 扫描使用变化后的完整源码，并让已经转换的引号或单引号立即影响后续字符的词法状态。
 * 因此一次粘贴中出现的字符串和行注释同样不会被继续转换。
 */
export function findSimplePunctuationReplacements(
	previousSource: string,
	changes: readonly SimpleTextChange[]
): { readonly replacements: readonly SimplePunctuationReplacement[]; readonly source: string } | undefined {
	const applied = applyChanges(previousSource, changes);

	if (applied === undefined) {
		return undefined;
	}

	const transformed = [...applied.ranges].map(() => [] as string[]);
	let rangeIndex = 0;
	let state: "code" | "comment" | "string" = "code";
	let escaped = false;
	let offset = 0;

	while (offset < applied.source.length) {
		while (rangeIndex < applied.ranges.length && offset >= applied.ranges[rangeIndex]!.end) {
			rangeIndex += 1;
		}

		const range = applied.ranges[rangeIndex];
		const inserted = range !== undefined && offset >= range.start && offset < range.end;
		const character = applied.source[offset]!;
		const pair = inserted && state === "code" && offset + 1 < range.end
			? applied.source.slice(offset, offset + 2)
			: undefined;
		const pairReplacement = pair === undefined ? undefined : SIMPLE_PUNCTUATION_PAIRS[pair];
		const consumedLength = pairReplacement === undefined ? 1 : 2;
		const normalized = pairReplacement
			?? (inserted && (
				state === "code"
				|| (state === "string" && (character === "”" || character === "＂"))
			)
				? SIMPLE_PUNCTUATION[character] ?? character
				: character);

		if (inserted) {
			transformed[rangeIndex]!.push(normalized);
		}

		if (state === "comment") {
			if (normalized === "\r" || normalized === "\n") {
				state = "code";
			}
			offset += consumedLength;
			continue;
		}

		if (state === "string") {
			if (normalized === "\r" || normalized === "\n") {
				state = "code";
				escaped = false;
			} else if (escaped) {
				escaped = false;
			} else if (normalized === "\\") {
				escaped = true;
			} else if (normalized === "\"") {
				state = "code";
			}
			offset += consumedLength;
			continue;
		}

		if (normalized === "'") {
			state = "comment";
		} else if (normalized === "\"") {
			state = "string";
		}
		offset += consumedLength;
	}

	const replacements = applied.ranges.flatMap((range, index) => {
		const text = transformed[index]!.join("");
		return text === range.content
			? []
			: [{ end: range.end, start: range.start, text }];
	});

	return { replacements, source: applied.source };
}
