/*
为复制组件和单元生成按末尾数字递增的候选名称。
xhwsd@qq.com 2026-9-9
*/

/**
 * 返回第 `increment` 个复制名称候选。
 *
 * 没有数字后缀时从 1 开始追加；已有数字后缀时直接递增该数字。
 */
export function copyNameCandidate(preferredName: string, increment: number): string {
	if (increment === 0) {
		return preferredName;
	}
	const match = /^(.*?)(\d+)$/u.exec(preferredName);
	if (match === null) {
		return preferredName + increment;
	}
	const baseName = match[1] ?? "";
	const numericSuffix = match[2] ?? "0";
	return baseName + (BigInt(numericSuffix) + BigInt(increment)).toString();
}
