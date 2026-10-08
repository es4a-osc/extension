/*
读取 Simple 项目配置，并按项目资源管理器需要枚举源码与资源目录。
xhwsd@qq.com 2026-8-27
*/

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	createProjectInfo,
	parseProjectProperties,
	type SimpleProjectInfo
} from "./project";
import {
	getPropertyXmlAttribute,
	getPropertyXmlChildren,
	getSimplePropertyUnitType,
	inspectSimplePropertyXml,
	type SimplePropertyXmlDocument,
	type SimplePropertyXmlParseResult,
	type SimpleUnitType
} from "./propertyXml";
import { decodeSimpleSource } from "./simpleSourceEncoding";

/** 项目资源管理器枚举目录时使用的内容模式。 */
export type ProgramDirectoryMode = "build" | "resources" | "units";

/** 描述源码或资源目录中的一个直接子项。 */
export interface ProgramDirectoryEntry {
	/** 对象单元显式声明的基础对象。 */
	readonly baseObject?: string;
	/** 对象单元显式声明的接口列表。 */
	readonly interfaces?: readonly string[];
	/** 文件夹、程序单元或普通资源文件。 */
	readonly kind: "directory" | "file" | "unit";
	/** 树节点显示名称；程序单元不包含 `.simple` 后缀。 */
	readonly label: string;
	/** 子项的完整绝对路径。 */
	readonly path: string;
	/** 程序单元属性区资源声明中的单元类型。 */
	readonly unitType?: SimpleUnitType;
}

/** 项目树提示需要的单元属性元数据。 */
export interface SimpleUnitMetadata {
	readonly baseObject?: string;
	readonly interfaces: readonly string[];
	readonly unitType?: SimpleUnitType;
}

/** 从属性 XML 中读取并规范化指定属性的逗号分隔值。 */
function propertyValues(document: SimplePropertyXmlDocument, name: string): readonly string[] {
	return getPropertyXmlChildren(document.root, "赋值").flatMap((element) => {
		if (getPropertyXmlAttribute(element, "属性") !== name) {
			return [];
		}

		return (getPropertyXmlAttribute(element, "值") ?? "")
			.split(",")
			.map((value) => value.trim())
			.filter((value) => value.length > 0);
	});
}

/** 从当前属性 XML 状态提取项目树和对象关系命令共享的单元元数据。 */
export function simpleUnitMetadataFromProperty(
	property: SimplePropertyXmlParseResult
): SimpleUnitMetadata {
	const document = property.document;
	if (document === undefined) {
		return { interfaces: [] };
	}

	return {
		baseObject: propertyValues(document, "基础对象")[0],
		interfaces: propertyValues(document, "实现接口"),
		unitType: getSimplePropertyUnitType(document)
	};
}

/**
 * 从磁盘读取 `project.properties` 并构造项目模型。
 *
 * @param filePath 项目配置文件的完整路径。
 * @returns 已解析且目录路径绝对化的项目模型。
 */
export async function loadSimpleProject(filePath: string): Promise<SimpleProjectInfo> {
	const resolvedPath = path.resolve(filePath);
	const source = await fs.readFile(resolvedPath, "utf8");
	return createProjectInfo(resolvedPath, parseProjectProperties(source));
}

/**
 * 判断路径是否指向可访问目录。
 *
 * @param directoryPath 待检查的完整目录路径。
 * @returns 路径存在且为目录时返回 `true`。
 */
export async function programDirectoryExists(directoryPath: string): Promise<boolean> {
	try {
		return (await fs.stat(directoryPath)).isDirectory();
	} catch {
		return false;
	}
}

/**
 * 从统一属性 XML 边界读取项目树需要的单元类型、基础对象和接口。
 *
 * @param filePath Simple 程序单元的完整路径。
 * @returns 可用于项目树显示的单元元数据；读取失败时返回空元数据。
 */
export async function readSimpleUnitMetadata(filePath: string): Promise<SimpleUnitMetadata> {
	try {
		const source = decodeSimpleSource(await fs.readFile(filePath));
		return simpleUnitMetadataFromProperty(inspectSimplePropertyXml(source));
	} catch {
		return { interfaces: [] };
	}
}

/** 兼容只需要资源单元类型的调用方。 */
export async function readSimpleUnitType(filePath: string): Promise<SimpleUnitType | undefined> {
	return (await readSimpleUnitMetadata(filePath)).unitType;
}

/**
 * 枚举项目资源树中一个目录的直接子项。
 *
 * “单元”模式只显示文件夹和 `.simple` 文件；“资源”和“构建”模式保留全部普通文件。
 * 符号链接不跟随，避免项目树递归进入目录环。
 *
 * @param directoryPath 待枚举的完整目录路径。
 * @param mode 单元或资源枚举模式。
 * @param knownUnitMetadata 已由打开文档或项目索引提供的单元元数据。
 * @returns 文件夹优先、名称自然排序的直接子项。
 */
export async function listProgramDirectory(
	directoryPath: string,
	mode: ProgramDirectoryMode,
	knownUnitMetadata?: (filePath: string) => SimpleUnitMetadata | undefined
): Promise<readonly ProgramDirectoryEntry[]> {
	const directoryEntries = await fs.readdir(directoryPath, { withFileTypes: true });
	const visibleEntries = directoryEntries.filter((entry) => {
		if (entry.isDirectory()) {
			return true;
		}

		if (!entry.isFile()) {
			return false;
		}

		return mode !== "units" || path.extname(entry.name).toLowerCase() === ".simple";
	});
	visibleEntries.sort((left, right) => {
		if (left.isDirectory() !== right.isDirectory()) {
			return left.isDirectory() ? -1 : 1;
		}

		return left.name.localeCompare(right.name, "zh-CN", {
			numeric: true,
			sensitivity: "base"
		});
	});

	const result: ProgramDirectoryEntry[] = [];
	for (let index = 0; index < visibleEntries.length; index += 16) {
		const batch = visibleEntries.slice(index, index + 16);
		result.push(...await Promise.all(batch.map(async (entry): Promise<ProgramDirectoryEntry> => {
			const entryPath = path.join(directoryPath, entry.name);

			if (entry.isDirectory()) {
				return {
					kind: "directory",
					label: entry.name,
					path: entryPath
				};
			}

			if (mode === "units") {
				const metadata = knownUnitMetadata?.(entryPath)
					?? await readSimpleUnitMetadata(entryPath);
				return {
					baseObject: metadata.baseObject,
					interfaces: metadata.interfaces,
					kind: "unit",
					label: path.basename(entry.name, path.extname(entry.name)),
					path: entryPath,
					unitType: metadata.unitType
				};
			}

			return {
				kind: "file",
				label: entry.name,
				path: entryPath
			};
		})));
	}
	return result;
}
