/*
读取指定项目范围内的 Simple 单元用户代码，并提供不接触隐藏属性区的文本匹配。
xhwsd@qq.com 2026-9-1
*/

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { listSimpleFiles } from "./simpleFileDiscovery";
import { filePathKey } from "./simpleProjectPaths";
import { decodeSimpleSource } from "./simpleSourceEncoding";
import { getVisibleSimpleUnitUserCode } from "./simpleUnitSource";

/** 一个参与项目代码搜索的真实 `.simple` 单元及其用户代码快照。 */
export interface ProjectCodeDocument {
	readonly filePath: string;
	readonly userCode: string;
}

/** 一条用户代码搜索结果；行列均为从零开始的 VS Code 文档位置。 */
export interface ProjectCodeMatch {
	readonly endCharacter: number;
	readonly filePath: string;
	readonly lineNumber: number;
	readonly lineText: string;
	readonly startCharacter: number;
}

/** 用户代码搜索结果及是否达到显示上限。 */
export interface ProjectCodeSearchResult {
	readonly limitHit: boolean;
	readonly matches: readonly ProjectCodeMatch[];
}

/** Windows 文件路径作为内部键时忽略大小写。 */
export function projectCodePathKey(filePath: string): string {
	return filePathKey(filePath);
}

/**
 * 读取搜索范围内全部单元的用户代码。
 *
 * 已打开单元通过 `readOpenUserCode` 注入未保存代码；其它单元只在加载边界切分一次磁盘原文，
 * 搜索结果不会接触或暴露隐藏属性区。
 */
export async function loadProjectCodeDocuments(
	rootPaths: readonly string[],
	readOpenUserCode: (filePath: string) => string | undefined = () => undefined,
	isCancelled: () => boolean = () => false
): Promise<readonly ProjectCodeDocument[]> {
	const seen = new Set<string>();
	const filePaths: string[] = [];

	for (const rootPath of rootPaths) {
		for (const filePath of await listSimpleFiles(rootPath, isCancelled)) {
			const key = projectCodePathKey(filePath);
			if (!seen.has(key)) {
				seen.add(key);
				filePaths.push(path.resolve(filePath));
			}
		}
	}

	const documents: ProjectCodeDocument[] = [];
	for (const filePath of filePaths) {
		if (isCancelled()) {
			break;
		}

		const openUserCode = readOpenUserCode(filePath);
		if (openUserCode !== undefined) {
			documents.push({ filePath, userCode: openUserCode });
			continue;
		}

		try {
			const source = decodeSimpleSource(await fs.readFile(filePath));
			documents.push({
				filePath,
				userCode: getVisibleSimpleUnitUserCode(source)
			});
		} catch {
			// 单个不可读单元不会阻断同一搜索范围内的其它用户代码。
		}
	}

	return documents;
}

/** 对已加载的用户代码快照执行不区分大小写的单行普通文本搜索。 */
export function findProjectCodeMatches(
	documents: readonly ProjectCodeDocument[],
	query: string,
	maxResults = 1000
): ProjectCodeSearchResult {
	if (query.trim().length === 0 || maxResults <= 0) {
		return { limitHit: false, matches: [] };
	}

	const normalizedQuery = query.toLowerCase();
	const matches: ProjectCodeMatch[] = [];
	for (const document of documents) {
		const lines = document.userCode.split(/\r\n|\n|\r/u);
		for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
			const lineText = lines[lineNumber];
			if (lineText === undefined) {
				continue;
			}
			const startCharacter = lineText.toLowerCase().indexOf(normalizedQuery);
			if (startCharacter < 0) {
				continue;
			}
			if (matches.length >= maxResults) {
				return { limitHit: true, matches };
			}
			matches.push({
				endCharacter: startCharacter + query.length,
				filePath: document.filePath,
				lineNumber,
				lineText,
				startCharacter
			});
		}
	}

	return { limitHit: false, matches };
}
