/*
解析 project.properties，并构建和发现 Simple 项目模型。
xhwsd@qq.com 2026-8-27
*/

import * as path from "node:path";
import { mostSpecificSourceRoot, simpleQualifiedName } from "./simpleProjectPaths";

/** 描述由 `project.properties` 解析得到的完整 Simple 项目信息。 */
export interface SimpleProjectInfo {
	/** 资产目录的绝对路径。 */
	readonly assetsDirectory: string;
	/** 构建输出目录的绝对路径。 */
	readonly buildDirectory: string;
	/** 项目根目录的绝对路径。 */
	readonly directory: string;
	/** `project.properties` 的绝对路径。 */
	readonly filePath: string;
	/** 项目主程序单元；未配置时为空。 */
	readonly main?: string;
	/** 项目显示名称。 */
	readonly name: string;
	/** 未丢失未知字段的原始项目属性。 */
	readonly properties: Readonly<Record<string, string>>;
	/** Android 资源目录的绝对路径。 */
	readonly resourceDirectory: string;
	/** 按配置顺序排列的源码目录绝对路径。 */
	readonly sourceDirectories: readonly string[];
}

/**
 * 判断属性文件中的物理行是否以未转义的反斜杠续行。
 *
 * @param line 待检查的物理行。
 * @returns 行末反斜杠数量为奇数时返回 `true`。
 */
function hasContinuation(line: string): boolean {
	let slashCount = 0;

	for (let index = line.length - 1; index >= 0 && line[index] === "\\"; index -= 1) {
		slashCount += 1;
	}

	return slashCount % 2 === 1;
}

/**
 * 将 Java Properties 格式的物理行合并为逻辑行。
 *
 * @param source 属性文件原文。
 * @returns 已处理反斜杠续行的逻辑行数组。
 */
function toLogicalLines(source: string): string[] {
	const physicalLines = source.replace(/\r\n?/g, "\n").split("\n");
	const logicalLines: string[] = [];
	let current = "";
	let continuing = false;

	for (const physicalLine of physicalLines) {
		const line = continuing ? physicalLine.replace(/^[ \t\f]+/, "") : physicalLine;
		current += line;

		if (hasContinuation(current)) {
			current = current.slice(0, -1);
			continuing = true;
			continue;
		}

		logicalLines.push(current);
		current = "";
		continuing = false;
	}

	if (continuing || current.length > 0) {
		logicalLines.push(current);
	}

	return logicalLines;
}

/**
 * 将 Java Properties 转义序列还原为实际字符。
 *
 * @param value 待反转义的属性键或属性值。
 * @returns 还原制表符、换行符、Unicode 等转义后的文本。
 */
function unescapeProperty(value: string): string {
	return value.replace(/\\(?:u([0-9A-Fa-f]{4})|(.))/g, (_match, unicode: string | undefined, escaped: string | undefined) => {
		if (unicode !== undefined) {
			return String.fromCharCode(Number.parseInt(unicode, 16));
		}

		switch (escaped) {
			case "t":
				return "\t";
			case "n":
				return "\n";
			case "r":
				return "\r";
			case "f":
				return "\f";
			default:
				return escaped ?? "";
		}
	});
}

/**
 * 查找属性键的结束位置，兼容等号、冒号和空白分隔形式。
 *
 * @param line 当前逻辑行。
 * @param start 属性键起始偏移。
 * @returns 属性键结束偏移；没有分隔符时返回行长度。
 */
function findKeyEnd(line: string, start: number): number {
	let escaped = false;

	for (let index = start; index < line.length; index += 1) {
		const character = line[index];

		if (!escaped && (character === "=" || character === ":" || /[ \t\f]/.test(character ?? ""))) {
			return index;
		}

		if (character === "\\") {
			escaped = !escaped;
		} else {
			escaped = false;
		}
	}

	return line.length;
}

/**
 * 解析 Simple 项目的 Java Properties 格式配置。
 *
 * @param source `project.properties` 文件内容。
 * @returns 以属性名索引的只读配置值。
 */
export function parseProjectProperties(source: string): Readonly<Record<string, string>> {
	const properties: Record<string, string> = Object.create(null) as Record<string, string>;

	for (const line of toLogicalLines(source)) {
		let cursor = 0;

		while (cursor < line.length && /[ \t\f]/.test(line[cursor] ?? "")) {
			cursor += 1;
		}

		if (cursor >= line.length || line[cursor] === "#" || line[cursor] === "!") {
			continue;
		}

		const keyStart = cursor;
		const keyEnd = findKeyEnd(line, keyStart);
		cursor = keyEnd;

		while (cursor < line.length && /[ \t\f]/.test(line[cursor] ?? "")) {
			cursor += 1;
		}

		if (line[cursor] === "=" || line[cursor] === ":") {
			cursor += 1;
		}

		while (cursor < line.length && /[ \t\f]/.test(line[cursor] ?? "")) {
			cursor += 1;
		}

		const key = unescapeProperty(line.slice(keyStart, keyEnd));
		const value = unescapeProperty(line.slice(cursor));
		properties[key] = value;
	}

	return properties;
}

/** 返回简单项目属性物理行中值的起始偏移；不是目标属性时返回 `undefined`。 */
function projectPropertyValueStart(line: string, key: string): number | undefined {
	let cursor = 0;
	while (cursor < line.length && /[ \t\f]/.test(line[cursor] ?? "")) {
		cursor += 1;
	}
	if (cursor >= line.length || line[cursor] === "#" || line[cursor] === "!") {
		return undefined;
	}
	if (line.slice(cursor, cursor + key.length) !== key) {
		return undefined;
	}
	cursor += key.length;
	if (cursor < line.length && !/[ \t\f=:]/.test(line[cursor] ?? "")) {
		return undefined;
	}
	while (cursor < line.length && /[ \t\f]/.test(line[cursor] ?? "")) {
		cursor += 1;
	}
	if (line[cursor] === "=" || line[cursor] === ":") {
		cursor += 1;
	}
	while (cursor < line.length && /[ \t\f]/.test(line[cursor] ?? "")) {
		cursor += 1;
	}
	return cursor;
}

/**
 * 更新一个已知项目属性的值，并保持其它注释、顺序和换行不变。
 *
 * Java Properties 允许重复键，实际读取以最后一项为准，因此这里同步修改最后一项；
 * 属性不存在时追加到文件末尾。
 */
export function updateProjectProperty(source: string, key: string, value: string): string {
	if (/\r|\n/u.test(key) || /\r|\n/u.test(value)) {
		throw new Error("项目属性名称和值不能包含换行。");
	}

	let lineStart = 0;
	let lastMatch: { readonly start: number; readonly end: number } | undefined;
	while (lineStart <= source.length) {
		const newlineIndex = source.indexOf("\n", lineStart);
		const physicalEnd = newlineIndex < 0 ? source.length : newlineIndex;
		const contentEnd = physicalEnd > lineStart && source[physicalEnd - 1] === "\r"
			? physicalEnd - 1
			: physicalEnd;
		const line = source.slice(lineStart, contentEnd);
		const valueStart = projectPropertyValueStart(line, key);
		if (valueStart !== undefined) {
			lastMatch = {
				start: lineStart + valueStart,
				end: contentEnd
			};
		}
		if (newlineIndex < 0) {
			break;
		}
		lineStart = newlineIndex + 1;
	}

	if (lastMatch !== undefined) {
		return source.slice(0, lastMatch.start) + value + source.slice(lastMatch.end);
	}

	const newline = source.includes("\r\n") ? "\r\n" : source.includes("\n") ? "\n" : "\r\n";
	const hasFinalNewline = /(?:\r\n|\n)$/u.test(source);
	const prefix = source.length === 0 || hasFinalNewline ? "" : newline;
	const suffix = hasFinalNewline ? newline : "";
	return `${source}${prefix}${key}=${value}${suffix}`;
}

/** 仅在实际改名的单元完整匹配当前 main 时同步限定名，不按包名前缀改写配置。 */
export function updateProjectMainForRenamedUnits(
	source: string,
	projectFile: string,
	units: readonly { readonly oldFile: string; readonly newFile: string }[]
): string | undefined {
	const project = createProjectInfo(projectFile, parseProjectProperties(source));
	if (project.main === undefined) return undefined;
	for (const unit of units) {
		const oldRoot = mostSpecificSourceRoot(project.sourceDirectories, unit.oldFile);
		if (oldRoot === undefined || simpleQualifiedName(oldRoot, unit.oldFile) !== project.main) continue;
		const newRoot = mostSpecificSourceRoot(project.sourceDirectories, unit.newFile);
		if (newRoot === undefined) throw new Error("主窗口改名后的路径不属于项目源码目录，无法同步 main。");
		const nextMain = simpleQualifiedName(newRoot, unit.newFile);
		if (nextMain === project.main) return undefined;
		const updated = updateProjectProperty(source, "main", nextMain);
		/* 延续行等特殊排版不能由现有单属性编辑器无损处理时，先拒绝整个改名。 */
		const updatedProperties = parseProjectProperties(updated);
		if (updatedProperties.main !== nextMain
			|| Object.keys(updatedProperties).length !== Object.keys(project.properties).length
			|| Object.entries(project.properties).some(([key, value]) => key !== "main" && updatedProperties[key] !== value)) {
			throw new Error("main 使用了暂不支持的属性排版，请先整理该属性后再改名。");
		}
		return updated;
	}
	return undefined;
}

/**
 * 将项目中的可选相对目录配置解析为绝对路径。
 *
 * @param projectDirectory 项目根目录。
 * @param configuredPath 项目配置中的可选目录路径。
 * @param fallback 未配置路径时使用的默认相对目录。
 * @returns 基于项目根目录解析的绝对路径。
 */
function resolveProjectDirectory(projectDirectory: string, configuredPath: string | undefined, fallback: string): string {
	return path.resolve(projectDirectory, configuredPath?.trim() || fallback);
}

/**
 * 根据配置文件路径和已解析属性构造 Simple 项目模型。
 *
 * @param filePath `project.properties` 的完整路径。
 * @param properties 已解析的项目属性。
 * @returns 目录均已规范化为绝对路径的项目模型。
 */
export function createProjectInfo(
	filePath: string,
	properties: Readonly<Record<string, string>>
): SimpleProjectInfo {
	const directory = path.dirname(path.resolve(filePath));
	const sourceValues = (properties.source || "./src")
		.split(",")
		.map((value) => value.trim())
		.filter((value) => value.length > 0);

	return {
		assetsDirectory: resolveProjectDirectory(directory, properties.assets, "./assets"),
		buildDirectory: resolveProjectDirectory(directory, properties.build, "./build"),
		directory,
		filePath: path.resolve(filePath),
		main: properties.main || undefined,
		name: properties.name || path.basename(directory),
		properties,
		resourceDirectory: resolveProjectDirectory(directory, properties.res, "./res"),
		sourceDirectories: sourceValues.map((value) => path.resolve(directory, value))
	};
}

