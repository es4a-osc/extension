/*
从 Simple 项目的 res 目录建立独立于 Android 构建产物的资源符号索引。
xhwsd@qq.com 2026-9-8
*/

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SimpleProjectInfo } from "./project";

/** 会以文件名直接生成同类型 Android 资源符号的 res 一级目录。 */
const FILE_RESOURCE_TYPES = new Set([
	"anim",
	"animator",
	"color",
	"drawable",
	"font",
	"interpolator",
	"layout",
	"menu",
	"mipmap",
	"navigation",
	"raw",
	"transition",
	"xml"
]);

/** values XML 顶层元素名称与 AAPT2 资源类型的对应关系。 */
const VALUE_RESOURCE_TYPES: Readonly<Record<string, string>> = {
	array: "array",
	attr: "attr",
	bool: "bool",
	color: "color",
	dimen: "dimen",
	fraction: "fraction",
	integer: "integer",
	"integer-array": "array",
	plurals: "plurals",
	string: "string",
	"string-array": "array",
	style: "style"
};

/** res 中一个可由 Simple 代码通过 `R.类型_名称` 访问的资源符号。 */
export interface SimpleResourceSymbol {
	/** 展平后的 Simple 成员名称，例如 `drawable_es4a`。 */
	readonly name: string;
	/** Android 资源自身的名称。 */
	readonly resourceName: string;
	/** Android 资源类型，例如 `drawable` 或 `string`。 */
	readonly resourceType: string;
	/** 声明或承载该资源的绝对文件路径；限定目录中的同名资源会合并。 */
	readonly sourceFiles: readonly string[];
}

/** 当前项目由 res 目录推导出的 Simple 资源索引。 */
export interface SimpleProjectResourceIndex {
	/** 编译器最终生成的资源对象限定名，仅用于悬停说明。 */
	readonly objectQualifiedName: string;
	readonly projectDirectory: string;
	readonly symbols: readonly SimpleResourceSymbol[];
}

/** 尚在收集来源文件的可变资源符号。 */
interface MutableResourceSymbol {
	readonly name: string;
	readonly resourceName: string;
	readonly resourceType: string;
	readonly sourceFiles: Set<string>;
}

/** 一个能由文件路径唯一确定的 Android 文件资源。 */
interface SimpleResourceFileSymbol {
	readonly name: string;
	readonly resourceName: string;
	readonly resourceType: string;
}

/** Android 资源名称转换为 R 符号字段名称时使用的基础规则。 */
function normalizeResourceName(value: string): string | undefined {
	const normalized = value.replace(/[.:]/gu, "_");
	return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(normalized) ? normalized : undefined;
}

/**
 * 按 Android 文件资源目录规则解析一个真实 res 文件。
 *
 * `values` 文件会声明多个资源，不能由文件本身确定唯一索引，因此不返回结果。
 */
function resourceFileSymbol(resourceDirectory: string, filePath: string): SimpleResourceFileSymbol | undefined {
	const relativePath = path.relative(resourceDirectory, filePath);
	const segments = relativePath.split(path.sep);
	if (path.isAbsolute(relativePath) || segments.length !== 2 || segments[0] === "..") {
		return undefined;
	}
	const resourceType = segments[0]?.split("-", 1)[0]?.toLowerCase();
	const fileName = segments[1];
	if (resourceType === undefined || fileName === undefined || !FILE_RESOURCE_TYPES.has(resourceType)) {
		return undefined;
	}
	const extension = path.extname(fileName);
	const resourceName = normalizeResourceName(path.basename(fileName, extension).replace(/\.9$/u, ""));
	return resourceName === undefined ? undefined : {
		name: `${resourceType}_${resourceName}`,
		resourceName,
		resourceType
	};
}

/** 返回项目树复制命令使用的 `R.类型_名称`；没有唯一文件索引时返回 `undefined`。 */
export function simpleResourceReferenceForFile(
	resourceDirectory: string,
	filePath: string
): string | undefined {
	const symbol = resourceFileSymbol(resourceDirectory, filePath);
	return symbol === undefined ? undefined : `R.${symbol.name}`;
}

/** 按资源树中的相对路径排序，让基础目录优先于后续限定目录。 */
function compareResourceSourceFiles(resourceDirectory: string, left: string, right: string): number {
	const leftRelative = path.relative(resourceDirectory, left);
	const rightRelative = path.relative(resourceDirectory, right);
	const leftQualified = (leftRelative.split(path.sep)[0] ?? "").includes("-");
	const rightQualified = (rightRelative.split(path.sep)[0] ?? "").includes("-");
	if (leftQualified !== rightQualified) {
		return leftQualified ? 1 : -1;
	}
	return leftRelative.localeCompare(
		rightRelative,
		"zh-CN",
		{ numeric: true, sensitivity: "base" }
	);
}

/** 从 XML 起始标签中提取属性，属性名称保留命名空间前缀。 */
function xmlAttributes(tag: string): ReadonlyMap<string, string> {
	const attributes = new Map<string, string>();
	const pattern = /([A-Za-z_:][A-Za-z0-9_:.-]*)\s*=\s*(["'])(.*?)\2/gsu;
	for (const match of tag.matchAll(pattern)) {
		const name = match[1];
		const value = match[3];
		if (name !== undefined && value !== undefined) {
			attributes.set(name, value);
		}
	}
	return attributes;
}

/** 返回与编译器一致的 `包名.SimpleResources` 限定名。 */
function resourceObjectQualifiedName(main: string | undefined): string {
	const separator = main?.lastIndexOf(".") ?? -1;
	return separator < 0
		? "SimpleResources"
		: `${main?.slice(0, separator)}.SimpleResources`;
}

/**
 * 只读取 res 中的文件名和 XML 声明并建立资源索引。
 *
 * 不读取 `R.txt`、build 目录或任何编译器输出；Android 数值资源编号也不会在这里生成。
 */
export async function indexSimpleProjectResources(
	project: SimpleProjectInfo
): Promise<SimpleProjectResourceIndex> {
	const symbols = new Map<string, MutableResourceSymbol>();
	const addSymbol = (
		resourceType: string,
		resourceName: string,
		sourceFile: string
	): void => {
		const normalizedType = resourceType.trim().toLowerCase();
		const normalizedName = normalizeResourceName(resourceName.trim());
		if (!/^[a-z][a-z0-9_]*$/u.test(normalizedType) || normalizedName === undefined) {
			return;
		}

		const name = `${normalizedType}_${normalizedName}`;
		const existing = symbols.get(name);
		if (existing !== undefined) {
			existing.sourceFiles.add(path.resolve(sourceFile));
			return;
		}
		symbols.set(name, {
			name,
			resourceName: normalizedName,
			resourceType: normalizedType,
			sourceFiles: new Set([path.resolve(sourceFile)])
		});
	};

	/** 读取 XML 中创建的 id，并在 values 文件中读取顶层命名资源。 */
	const indexXml = (source: string, sourceFile: string, valuesFile: boolean): void => {
		const withoutComments = source.replace(/<!--[\s\S]*?-->/gu, "");
		const tagPattern = /<\/?\s*([A-Za-z][A-Za-z0-9_.-]*)\b[^>]*>/gu;
		let resourcesDepth = 0;
		let insideResources = false;

		for (const match of withoutComments.matchAll(tagPattern)) {
			const tag = match[0];
			const tagName = match[1]?.toLowerCase();
			if (tagName === undefined) {
				continue;
			}

			const closing = /^<\s*\//u.test(tag);
			const selfClosing = /\/\s*>$/u.test(tag);
			if (closing) {
				if (insideResources) {
					resourcesDepth -= 1;
					if (resourcesDepth <= 0 && tagName === "resources") {
						insideResources = false;
						resourcesDepth = 0;
					}
				}
				continue;
			}

			const attributes = xmlAttributes(tag);
			for (const value of attributes.values()) {
				for (const id of value.matchAll(/@\+id\/([A-Za-z_][A-Za-z0-9_]*)/gu)) {
					if (id[1] !== undefined) {
						addSymbol("id", id[1], sourceFile);
					}
				}
			}

			if (tagName === "resources" && !insideResources) {
				insideResources = true;
				resourcesDepth = selfClosing ? 0 : 1;
				continue;
			}

			if (valuesFile && insideResources && resourcesDepth === 1) {
				const resourceName = attributes.get("name");
				const resourceType = tagName === "item" || tagName === "public"
					? attributes.get("type")
					: VALUE_RESOURCE_TYPES[tagName];
				if (resourceName !== undefined && resourceType !== undefined && resourceType !== "styleable") {
					addSymbol(resourceType, resourceName, sourceFile);
				}
			} else if (valuesFile && insideResources && resourcesDepth === 2 && tagName === "attr") {
				/* declare-styleable 内的 attr 仍会生成独立的 R.attr 常量。 */
				const resourceName = attributes.get("name");
				if (resourceName !== undefined) {
					addSymbol("attr", resourceName, sourceFile);
				}
			}

			if (insideResources && !selfClosing) {
				resourcesDepth += 1;
			}
		}
	};

	try {
		const directories = await fs.readdir(project.resourceDirectory, { withFileTypes: true });
		await Promise.all(directories.filter((entry) => entry.isDirectory()).map(async (directory) => {
			const resourceType = directory.name.split("-", 1)[0]?.toLowerCase();
			if (resourceType === undefined) {
				return;
			}
			const directoryPath = path.join(project.resourceDirectory, directory.name);
			let files: import("node:fs").Dirent<string>[];
			try {
				files = await fs.readdir(directoryPath, { withFileTypes: true });
			} catch {
				return;
			}

			await Promise.all(files.filter((entry) => entry.isFile()).map(async (file) => {
				const filePath = path.join(directoryPath, file.name);
				const fileSymbol = resourceFileSymbol(project.resourceDirectory, filePath);
				if (fileSymbol !== undefined) {
					addSymbol(fileSymbol.resourceType, fileSymbol.resourceName, filePath);
				}
				if (path.extname(file.name).toLowerCase() !== ".xml") {
					return;
				}
				try {
					indexXml(await fs.readFile(filePath, "utf8"), filePath, resourceType === "values");
				} catch {
					// 损坏或暂时不可读的单个 XML 不阻断其它资源的编辑器提示。
				}
			}));
		}));
	} catch {
		// res 尚不存在时仍返回空索引，使项目中的 R 对象保持可识别。
	}

	return {
		objectQualifiedName: resourceObjectQualifiedName(project.main),
		projectDirectory: project.directory,
		symbols: [...symbols.values()]
			.map((symbol) => ({
				...symbol,
				sourceFiles: [...symbol.sourceFiles].sort(
					(left, right) => compareResourceSourceFiles(project.resourceDirectory, left, right)
				)
			}))
			.sort((left, right) => left.name.localeCompare(right.name))
	};
}
