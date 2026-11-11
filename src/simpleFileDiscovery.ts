/*
以稳定顺序发现目录中的真实 Simple 单元文件，并统一取消与不可读目录处理。
xhwsd@qq.com 2026-9-2
*/

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isPathInsideOrEqual } from "./simpleProjectPaths";

/** 扫描只排除项目明确声明的生成目录，不按文件夹名称猜测用途。 */
export interface SimpleFileDiscoveryOptions {
	readonly strict?: boolean;
	readonly excludedDirectories?: readonly string[];
}

/** 不跟随符号链接枚举单元；搜索可跳过不可读子树，重构要求完整扫描。 */
export async function listSimpleFiles(
	directoryPath: string,
	isCancelled: () => boolean = () => false,
	options: SimpleFileDiscoveryOptions = {}
): Promise<readonly string[]> {
	if (isCancelled() || options.excludedDirectories?.some((directory) => isPathInsideOrEqual(directory, directoryPath))) {
		return [];
	}

	let entries;
	try {
		entries = await fs.readdir(directoryPath, { withFileTypes: true });
	} catch (error) {
		if (options.strict) throw new Error(`无法完整扫描源码目录：${directoryPath}`, { cause: error });
		return [];
	}
	entries.sort((left, right) => left.name.localeCompare(right.name));

	const groups = await Promise.all(entries.map(async (entry): Promise<readonly string[]> => {
		if (isCancelled()) {
			return [];
		}
		const entryPath = path.join(directoryPath, entry.name);
		if (entry.isDirectory()) {
			return listSimpleFiles(entryPath, isCancelled, options);
		}
		return entry.isFile() && path.extname(entry.name).toLowerCase() === ".simple"
			? [entryPath]
			: [];
	}));
	return groups.flat();
}
