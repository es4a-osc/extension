/*
以稳定顺序发现目录中的真实 Simple 单元文件，并统一取消与不可读目录处理。
xhwsd@qq.com 2026-9-2
*/

import * as fs from "node:fs/promises";
import * as path from "node:path";

/** 不跟随符号链接递归枚举 `.simple` 文件；不可读目录只影响自身子树。 */
export async function listSimpleFiles(
	directoryPath: string,
	isCancelled: () => boolean = () => false
): Promise<readonly string[]> {
	if (isCancelled()) {
		return [];
	}

	let entries;
	try {
		entries = await fs.readdir(directoryPath, { withFileTypes: true });
	} catch {
		return [];
	}
	entries.sort((left, right) => left.name.localeCompare(right.name));

	const groups = await Promise.all(entries.map(async (entry): Promise<readonly string[]> => {
		if (isCancelled()) {
			return [];
		}
		const entryPath = path.join(directoryPath, entry.name);
		if (entry.isDirectory()) {
			return listSimpleFiles(entryPath, isCancelled);
		}
		return entry.isFile() && path.extname(entry.name).toLowerCase() === ".simple"
			? [entryPath]
			: [];
	}));
	return groups.flat();
}
