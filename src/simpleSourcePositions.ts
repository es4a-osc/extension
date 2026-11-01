/*
一次建立用户代码行索引，为诊断批量换算 UTF-16 偏移，避免逐条重扫全文。
xhwsd@qq.com 2026-10-31
*/

/** 返回与文档物理行一致的零基行列；CRLF 内部偏移夹到上一行末尾。 */
export function createSimpleSourcePositionIndex(source: string): (offset: number) => { readonly line: number; readonly character: number } {
	const starts = [0];
	const ends: number[] = [];
	for (let offset = 0; offset < source.length; offset += 1) {
		if (source[offset] !== "\r" && source[offset] !== "\n") continue;
		ends.push(offset);
		if (source[offset] === "\r" && source[offset + 1] === "\n") offset += 1;
		starts.push(offset + 1);
	}
	ends.push(source.length);
	return (requested) => {
		const offset = Math.min(source.length, Math.max(0, requested));
		let low = 0;
		let high = starts.length;
		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			if (starts[middle]! <= offset) low = middle + 1;
			else high = middle;
		}
		const line = Math.max(0, low - 1);
		return { line, character: Math.min(offset, ends[line]!) - starts[line]! };
	};
}
