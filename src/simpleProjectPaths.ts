/*
统一 Simple 项目文件的路径身份、目录包含、源码根选择和限定名计算规则。
xhwsd@qq.com 2026-9-2
*/

import * as path from "node:path";

/** 返回可作为 Map 或 Set 键的绝对路径；Windows 下忽略大小写。 */
export function filePathKey(filePath: string): string {
	const resolvedPath = path.resolve(filePath);
	return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}

/** 按当前平台文件系统语义判断两个路径是否指向同一位置。 */
export function sameFilePath(leftPath: string, rightPath: string): boolean {
	return filePathKey(leftPath) === filePathKey(rightPath);
}

/** 判断候选路径是否严格位于指定目录内，不把目录自身视为子路径。 */
export function isPathInside(directoryPath: string, candidatePath: string): boolean {
	const relativePath = path.relative(path.resolve(directoryPath), path.resolve(candidatePath));
	return relativePath.length > 0
		&& !path.isAbsolute(relativePath)
		&& relativePath !== ".."
		&& !relativePath.startsWith(`..${path.sep}`);
}

/** 判断候选路径是否等于指定目录或位于该目录内。 */
export function isPathInsideOrEqual(directoryPath: string, candidatePath: string): boolean {
	return sameFilePath(directoryPath, candidatePath) || isPathInside(directoryPath, candidatePath);
}

/** 从多个可能嵌套的源码根中选择实际包含目标路径的最具体一项。 */
export function mostSpecificSourceRoot(
	sourceRoots: readonly string[],
	targetPath: string
): string | undefined {
	let selected: string | undefined;
	for (const candidate of sourceRoots) {
		if (!isPathInsideOrEqual(candidate, targetPath)) {
			continue;
		}
		if (selected === undefined || path.resolve(candidate).length > path.resolve(selected).length) {
			selected = candidate;
		}
	}
	return selected;
}

/** 按源码根相对路径和无后缀文件名计算 Simple 单元完整限定名。 */
export function simpleQualifiedName(sourceRoot: string, filePath: string): string {
	const relativePath = path.relative(path.resolve(sourceRoot), path.resolve(filePath));
	return relativePath
		.slice(0, -path.extname(relativePath).length)
		.split(path.sep)
		.join(".");
}
