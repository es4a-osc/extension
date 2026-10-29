/*
索引已添加 Simple 项目的全部单元，并为活动文档提供同步跨单元语义上下文。
xhwsd@qq.com 2026-8-27
*/

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { LibraryDefinition, LibraryManifest } from "./sdk";
import type { SimpleProjectInfo } from "./project";
import type { SimpleUnitMetadata } from "./programResources";
import { listSimpleFiles } from "./simpleFileDiscovery";
import {
	filePathKey,
	isPathInsideOrEqual,
	mostSpecificSourceRoot
} from "./simpleProjectPaths";
import { decodeSimpleSource } from "./simpleSourceEncoding";
import {
	indexSimpleProjectResources,
	type SimpleProjectResourceIndex
} from "./simpleResourceSymbols";
import {
	parseSimpleUnitSymbols,
	parseSimpleUnitSymbolsFromModel,
	type SimpleProjectSemanticContext,
	type SimpleUnitSymbol
} from "./simpleUnitSymbols";
import type { SimplePropertyXmlParseResult } from "./propertyXml";
import { findProjectForSource } from "./projectCapability";

/** 一个仍在编辑器中打开、可能尚未保存的单元模型。 */
export interface OpenSimpleUnitSnapshot {
	/** 仅用于打开文档派生符号的弱引用缓存身份。 */
	readonly cacheIdentity?: object;
	readonly filePath: string;
	readonly property: SimplePropertyXmlParseResult;
	readonly userCode: string;
	readonly version?: number;
}

/** 调用方维护的打开文档语义代次及当前文档身份。 */
export interface SimpleSemanticContextCacheKey {
	readonly generation: number;
	readonly identity: object;
}

/** 一个已添加项目的文件快照及按路径索引的单元符号。 */
interface IndexedProject {
	readonly project: SimpleProjectInfo;
	readonly resources: SimpleProjectResourceIndex;
	readonly units: readonly SimpleUnitSymbol[];
}

/** 一个打开文档版本已经解析出的单元符号。 */
interface CachedOpenUnitSymbol {
	readonly filePath: string;
	readonly projectSnapshotVersion: number;
	readonly propertyDocument: SimplePropertyXmlParseResult["document"];
	readonly sourceRoot: string;
	readonly symbol: SimpleUnitSymbol;
	readonly userCode: string;
	readonly version: number;
}

/** 同一打开文档在当前全局语义代次中的完整上下文。 */
interface CachedSemanticContext {
	readonly context: SimpleProjectSemanticContext | undefined;
	readonly filePath: string;
	readonly generation: number;
	readonly projectSnapshotVersion: number;
	readonly propertyDocument: SimplePropertyXmlParseResult["document"];
	readonly source: string | undefined;
	readonly openUnits: readonly OpenSimpleUnitSnapshot[];
}

/** 设计器的未保存 XML 不触发代码版本变化，跨单元上下文仍须验证这些真实输入。 */
function sameOpenUnits(left: readonly OpenSimpleUnitSnapshot[], right: readonly OpenSimpleUnitSnapshot[]): boolean {
	return left.length === right.length && left.every((unit, index) => {
		const other = right[index];
		return other !== undefined && filePathKey(unit.filePath) === filePathKey(other.filePath)
			&& unit.userCode === other.userCode && unit.property.document === other.property.document
			&& unit.version === other.version;
	});
}

/** 读取一个项目的全部单元，单个损坏文件不会阻断其他单元。 */
async function indexProject(project: SimpleProjectInfo): Promise<IndexedProject> {
	const [fileGroups, resources] = await Promise.all([
		Promise.all(project.sourceDirectories.map((sourceRoot) => listSimpleFiles(sourceRoot))),
		indexSimpleProjectResources(project)
	]);
	const files = new Map<string, string>();
	for (const filePath of fileGroups.flat()) {
		files.set(filePathKey(filePath), filePath);
	}
	const parsedUnits = await Promise.all([...files.values()].map(
		async (filePath): Promise<SimpleUnitSymbol | undefined> => {
			const sourceRoot = mostSpecificSourceRoot(project.sourceDirectories, filePath);
			if (sourceRoot === undefined) {
				return undefined;
			}
			try {
				const source = decodeSimpleSource(await fs.readFile(filePath));
				return parseSimpleUnitSymbols(source, filePath, sourceRoot);
			} catch {
				// 项目树负责显示文件读取错误；索引继续处理其他单元。
				return undefined;
			}
		}
	));
	const units = parsedUnits.filter((unit): unit is SimpleUnitSymbol => unit !== undefined);

	return { project, resources, units };
}

/** 项目清单只登记规范单元身份，可见名称由共享作用域索引派生。 */
function projectManifest(project: SimpleProjectInfo, units: readonly SimpleUnitSymbol[]): LibraryManifest {
	const definitions: LibraryDefinition[] = units.map((unit) => unit.definition);

	return {
		categories: [{ definitions, hidden: true, name: "项目单元" }],
		description: `${project.name} 项目中的 Simple 单元`,
		directory: project.directory,
		filePath: project.filePath,
		kind: "project",
		name: project.name
	};
}

/** 为不属于已添加项目的当前打开单元建立临时语义清单。 */
function standaloneManifest(unit: SimpleUnitSymbol): LibraryManifest {
	return {
		categories: [{ definitions: [unit.definition], hidden: true, name: "当前单元" }],
		description: "当前打开的 Simple 单元",
		directory: path.dirname(unit.filePath),
		filePath: unit.filePath,
		kind: "project",
		name: unit.name
	};
}

/** 缓存项目磁盘快照，并允许活动单元用未保存源码覆盖自己的快照。 */
export class ProjectSymbolIndex {
	/** 文件夹创建、删除和移动也会改变单元或资源语义，不能只按扩展名判断。 */
	containsProjectPath(filePath: string): boolean {
		return this.projects.some(({ project }) => [...project.sourceDirectories, project.resourceDirectory, project.assetsDirectory]
			.some((directory) => isPathInsideOrEqual(directory, filePath) || isPathInsideOrEqual(filePath, directory)));
	}
	private readonly contextCache = new WeakMap<object, CachedSemanticContext>();
	private readonly openUnitCache = new WeakMap<object, CachedOpenUnitSymbol>();
	private projects: readonly IndexedProject[] = [];
	private projectSnapshotVersion = 0;
	private unitsByPath = new Map<string, SimpleUnitSymbol>();
	private updateVersion = 0;

	/** 重新读取全部单元；重构或关闭期间过期的扫描不能覆盖最后一份完整快照。 */
	async updateProjects(projects: readonly SimpleProjectInfo[], isCurrent: () => boolean = () => true): Promise<void> {
		const version = ++this.updateVersion;
		const indexedProjects = await Promise.all(projects.map(indexProject));
		if (version === this.updateVersion && isCurrent()) {
			this.projects = indexedProjects;
			this.projectSnapshotVersion += 1;
			this.unitsByPath = new Map(indexedProjects.flatMap(
				(indexed) => indexed.units.map((unit) => [filePathKey(unit.filePath), unit] as const)
			));
		}
	}

	/** 返回最近一次完整项目快照中的单元属性元数据。 */
	metadataForFile(filePath: string): SimpleUnitMetadata | undefined {
		const unit = this.unitsByPath.get(filePathKey(filePath));
		if (unit === undefined) {
			return undefined;
		}

		return {
			baseObject: unit.definition.baseObject,
			interfaces: unit.definition.interfaces ?? [],
			unitType: unit.unitType
		};
	}

	/** 判断文件是否位于当前任一已添加项目配置的 res 目录中。 */
	containsResourcePath(filePath: string): boolean {
		const resolvedPath = path.resolve(filePath);
		return this.projects.some((entry) => (
			isPathInsideOrEqual(entry.project.resourceDirectory, resolvedPath)
		));
	}

	/** 复用同一打开文档版本已经派生出的单元符号。 */
	private symbolForOpenUnit(
		snapshot: OpenSimpleUnitSnapshot,
		sourceRoot: string
	): SimpleUnitSymbol {
		const identity = snapshot.cacheIdentity;
		const version = snapshot.version;
		if (identity !== undefined && version !== undefined) {
			const cached = this.openUnitCache.get(identity);
			if (
				cached !== undefined
				&& cached.filePath === filePathKey(snapshot.filePath)
				&& cached.projectSnapshotVersion === this.projectSnapshotVersion
				&& cached.propertyDocument === snapshot.property.document
				&& cached.sourceRoot === sourceRoot
				&& cached.version === version
				&& cached.userCode === snapshot.userCode
			) {
				return cached.symbol;
			}
		}

		const symbol = parseSimpleUnitSymbolsFromModel(
			snapshot.userCode,
			snapshot.property,
			snapshot.filePath,
			sourceRoot
		);
		if (identity !== undefined && version !== undefined) {
			this.openUnitCache.set(identity, {
				filePath: filePathKey(snapshot.filePath),
				projectSnapshotVersion: this.projectSnapshotVersion,
				propertyDocument: snapshot.property.document,
				sourceRoot,
				symbol,
				userCode: snapshot.userCode,
				version
			});
		}
		return symbol;
	}

	/**
	 * 返回指定文件所属项目的语义上下文。
	 *
	 * `currentSource` 用于让当前编辑器的未保存内容立即参与本单元语言能力；其他单元
	 * 继续使用最近一次项目索引的磁盘快照。
	 */
	contextForFile(
		filePath: string,
		currentSource?: string,
		currentProperty?: SimplePropertyXmlParseResult,
		openUnits: readonly OpenSimpleUnitSnapshot[] = [],
		cacheKey?: SimpleSemanticContextCacheKey
	): SimpleProjectSemanticContext | undefined {
		/* 自动改名会使用编辑前代码建立绑定；同一文档代次不代表分析输入相同。 */
		const currentFileKey = filePathKey(filePath);
		if (cacheKey !== undefined) {
			const cached = this.contextCache.get(cacheKey.identity);
			if (
				cached !== undefined
				&& cached.filePath === currentFileKey
				&& cached.generation === cacheKey.generation
				&& cached.projectSnapshotVersion === this.projectSnapshotVersion
				&& cached.propertyDocument === currentProperty?.document
				&& cached.source === currentSource
				&& sameOpenUnits(cached.openUnits, openUnits)
			) {
				return cached.context;
			}
		}
		const cacheContext = (
			context: SimpleProjectSemanticContext | undefined
		): SimpleProjectSemanticContext | undefined => {
			if (cacheKey !== undefined) {
				this.contextCache.set(cacheKey.identity, {
					context,
					filePath: currentFileKey,
					generation: cacheKey.generation,
					projectSnapshotVersion: this.projectSnapshotVersion,
					propertyDocument: currentProperty?.document,
					source: currentSource,
					openUnits
				});
			}
			return context;
		};
		const resolvedFilePath = path.resolve(filePath);
		const project = findProjectForSource(this.projects.map((entry) => entry.project), resolvedFilePath);
		const indexed = this.projects.find((entry) => entry.project === project);
		if (indexed === undefined) {
			if (currentSource !== undefined && currentProperty !== undefined) {
				const currentUnit = parseSimpleUnitSymbolsFromModel(
					currentSource,
					currentProperty,
					resolvedFilePath,
					path.dirname(resolvedFilePath)
				);
				return cacheContext({ currentUnit, manifest: standaloneManifest(currentUnit) });
			}
			return cacheContext(undefined);
		}

		const unitsByPath = new Map(
			indexed.units.map((unit) => [filePathKey(unit.filePath), unit] as const)
		);
		let matchingOpenUnit: SimpleUnitSymbol | undefined;
		for (const snapshot of openUnits) {
			const sourceRoot = mostSpecificSourceRoot(
				indexed.project.sourceDirectories,
				snapshot.filePath
			);
			if (sourceRoot === undefined) {
				continue;
			}

			const openUnit = this.symbolForOpenUnit(snapshot, sourceRoot);
			const snapshotKey = filePathKey(snapshot.filePath);
			unitsByPath.delete(snapshotKey);
			unitsByPath.set(snapshotKey, openUnit);
			if (
				snapshotKey === filePathKey(resolvedFilePath)
				&& snapshot.userCode === currentSource
				&& snapshot.property.document === currentProperty?.document
			) {
				matchingOpenUnit = openUnit;
			}
		}
		let currentUnit = unitsByPath.get(currentFileKey);
		if (currentSource !== undefined) {
			const sourceRoot = mostSpecificSourceRoot(
				indexed.project.sourceDirectories,
				resolvedFilePath
			);
			if (sourceRoot !== undefined) {
				currentUnit = matchingOpenUnit ?? (currentProperty === undefined
					? parseSimpleUnitSymbols(currentSource, resolvedFilePath, sourceRoot)
					: parseSimpleUnitSymbolsFromModel(
						currentSource,
						currentProperty,
						resolvedFilePath,
						sourceRoot
					));
				unitsByPath.delete(currentFileKey);
				unitsByPath.set(currentFileKey, currentUnit);
			}
		}

		return cacheContext({
			currentUnit,
			manifest: projectManifest(indexed.project, [...unitsByPath.values()]),
			units: [...unitsByPath.values()],
			resources: indexed.resources
		});
	}
}
