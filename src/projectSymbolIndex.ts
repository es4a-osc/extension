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
	projectSourceRoot,
	sameFilePath
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
	readonly indexed: IndexedProject | undefined;
	readonly propertyDocument: SimplePropertyXmlParseResult["document"];
	readonly source: string | undefined;
	readonly openUnits: readonly OpenSimpleUnitSnapshot[];
	readonly sourceUnits: readonly SimpleUnitSymbol[];
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

/** 单个损坏文件不会阻断其他单元的索引。 */
async function readUnitSymbol(filePath: string, sourceRoot: string): Promise<SimpleUnitSymbol | undefined> {
	try {
		return parseSimpleUnitSymbols(decodeSimpleSource(await fs.readFile(filePath)), filePath, sourceRoot);
	} catch {
		return undefined;
	}
}

/** 优先替换已知内容变化；完整扫描保留现有源码根及稳定顺序。 */
async function indexProjectUnits(
	project: SimpleProjectInfo,
	previous?: { readonly units: readonly SimpleUnitSymbol[]; readonly paths: readonly string[] }
): Promise<readonly SimpleUnitSymbol[]> {
	if (previous !== undefined) {
		const updated = await refreshKnownUnits(previous.units, previous.paths);
		if (updated !== undefined) return updated;
	}
	const fileGroups = await Promise.all(project.sourceDirectories.map((sourceRoot) => listSimpleFiles(sourceRoot, undefined, {
		excludedDirectories: [project.buildDirectory]
	})));
	const files = new Map<string, string>();
	for (const filePath of fileGroups.flat()) {
		files.set(filePathKey(filePath), filePath);
	}
	const parsedUnits = await Promise.all([...files.values()].map(
		(filePath) => {
			const sourceRoot = projectSourceRoot(project, filePath);
			return sourceRoot === undefined ? undefined : readUnitSymbol(filePath, sourceRoot);
		}
	));
	return parsedUnits.filter((unit): unit is SimpleUnitSymbol => unit !== undefined);
}

/** 只替换确认为已有普通文件的内容变更；结构不确定时由调用者完整扫描。 */
async function refreshKnownUnits(units: readonly SimpleUnitSymbol[], paths: readonly string[]): Promise<readonly SimpleUnitSymbol[] | undefined> {
	const keys = new Set(paths.map(filePathKey));
	const changed = units.filter((unit) => keys.has(filePathKey(unit.filePath)));
	if (changed.length !== keys.size) return undefined;
	const replacements = new Map<SimpleUnitSymbol, SimpleUnitSymbol>();
	for (const unit of changed) {
		const info = await fs.lstat(unit.filePath).catch(() => undefined);
		if (!info?.isFile()) return undefined;
		const replacement = await readUnitSymbol(unit.filePath, unit.sourceRoot);
		if (replacement === undefined) return undefined;
		replacements.set(unit, replacement);
	}
	return units.map((unit) => replacements.get(unit) ?? unit);
}

/** 文件或目录事件也可能发生在被配置目录的上级，例如移动整个包。 */
function overlapsDirectory(directory: string, changedPath: string): boolean {
	return isPathInsideOrEqual(directory, changedPath) || isPathInsideOrEqual(changedPath, directory);
}

function sameSourceLayout(left: SimpleProjectInfo, right: SimpleProjectInfo): boolean {
	return sameFilePath(left.buildDirectory, right.buildDirectory)
		&& left.sourceDirectories.length === right.sourceDirectories.length
		&& left.sourceDirectories.every((root, index) => sameFilePath(root, right.sourceDirectories[index]!));
}

function sameProjectConfiguration(left: SimpleProjectInfo, right: SimpleProjectInfo): boolean {
	return sameSourceLayout(left, right)
		&& sameFilePath(left.assetsDirectory, right.assetsDirectory)
		&& sameFilePath(left.resourceDirectory, right.resourceDirectory)
		&& left.name === right.name && left.main === right.main
		&& Object.keys(left.properties).length === Object.keys(right.properties).length
		&& Object.entries(left.properties).every(([key, value]) => right.properties[key] === value);
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
		return this.projects.some(({ project }) => !isPathInsideOrEqual(project.buildDirectory, filePath)
			&& [...project.sourceDirectories, project.resourceDirectory, project.assetsDirectory]
				.some((directory) => overlapsDirectory(directory, filePath)));
	}
	private readonly contextCache = new WeakMap<object, CachedSemanticContext>();
	private readonly openUnitCache = new WeakMap<object, CachedOpenUnitSymbol>();
	private projects: readonly IndexedProject[] = [];
	private unitsByPath = new Map<string, SimpleUnitSymbol>();
	private updateVersion = 0;

	/**
	 * 按变化路径替换受影响的源码或资源快照，资产变化只通知引用诊断。
	 * 返回需要诊断的项目路径。全量刷新或项目归属改变时返回 undefined。
	 */
	async updateProjects(
		projects: readonly SimpleProjectInfo[],
		isCurrent: () => boolean = () => true,
		changedPaths?: readonly string[],
		contentChanges?: ReadonlySet<string>
	): Promise<readonly string[] | undefined> {
		const version = ++this.updateVersion;
		const previous = new Map(this.projects.map((entry) => [filePathKey(entry.project.filePath), entry]));
		const affected = new Set<string>();
		// 项目加入、移除或源码根变化可能改变共享文件的归属，需要重新分配已有诊断。
		const ownershipChanged = projects.length !== this.projects.length || projects.some((project, index) => {
			const old = this.projects[index]?.project;
			return old === undefined || !sameFilePath(old.filePath, project.filePath) || !sameSourceLayout(old, project);
		});
		const indexedProjects = await Promise.all(projects.map(async (project): Promise<IndexedProject> => {
			const key = filePathKey(project.filePath);
			const old = previous.get(key);
			const configurationChanged = old === undefined || !sameProjectConfiguration(old.project, project)
				|| changedPaths?.some((file) => isPathInsideOrEqual(file, project.filePath));
			const paths = changedPaths?.filter((file) => !isPathInsideOrEqual(project.buildDirectory, file));
			const sourcePaths = paths?.filter((file) => project.sourceDirectories.some((root) => overlapsDirectory(root, file)));
			const readUnits = configurationChanged || sourcePaths === undefined || sourcePaths.length > 0;
			const readResources = configurationChanged || paths === undefined
				|| paths.some((file) => overlapsDirectory(project.resourceDirectory, file));
			if (readUnits || readResources || paths?.some((file) => overlapsDirectory(project.assetsDirectory, file))) {
				affected.add(key);
			}
			if (old !== undefined && !readUnits && !readResources) {
				return old;
			}
			const incremental = old !== undefined && !configurationChanged && sourcePaths !== undefined
				&& sourcePaths.every((file) => contentChanges?.has(filePathKey(file)))
				? { units: old.units, paths: sourcePaths }
				: undefined;
			const [units, resources] = await Promise.all([
				old === undefined || readUnits ? indexProjectUnits(project, incremental) : old.units,
				old === undefined || readResources ? indexSimpleProjectResources(project) : old.resources
			]);
			return { project, resources, units };
		}));
		if (version !== this.updateVersion || !isCurrent()) {
			return [];
		}
		if (ownershipChanged || indexedProjects.some((entry, index) => entry !== this.projects[index])) {
			this.projects = indexedProjects;
			this.unitsByPath = new Map(indexedProjects.flatMap(
				(indexed) => indexed.units.map((unit) => [filePathKey(unit.filePath), unit] as const)
			));
		}
		return changedPaths === undefined || ownershipChanged ? undefined : [...affected];
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

	/** 诊断项目已知时直接复用资源索引，无需为每个单元重新建立语义上下文。 */
	resourcesForProject(projectFile: string): SimpleProjectResourceIndex | undefined {
		return this.projects.find(({ project }) => sameFilePath(project.filePath, projectFile))?.resources;
	}

	private indexedProjectForFile(filePath: string): IndexedProject | undefined {
		const project = findProjectForSource(this.projects.map((entry) => entry.project), filePath);
		return this.projects.find((entry) => entry.project === project);
	}

	/** 原生打开文档只需要源码归属即可派生单元符号。 */
	sourceRootForFile(filePath: string): string | undefined {
		const indexed = this.indexedProjectForFile(filePath);
		return indexed === undefined ? undefined : projectSourceRoot(indexed.project, filePath);
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
	 * `currentSource` 提供当前单元内容，`sourceUnits` 补充原生文档的未保存符号；
	 * 共享 XML 会话的打开单元快照随后覆盖同路径符号，保留既有会话的优先级。
	 */
	contextForFile(
		filePath: string,
		currentSource?: string,
		currentProperty?: SimplePropertyXmlParseResult,
		openUnits: readonly OpenSimpleUnitSnapshot[] = [],
		cacheKey?: SimpleSemanticContextCacheKey,
		sourceUnits: readonly SimpleUnitSymbol[] = []
	): SimpleProjectSemanticContext | undefined {
		/* 自动改名会使用编辑前代码建立绑定；同一文档代次不代表分析输入相同。 */
		const currentFileKey = filePathKey(filePath);
		const resolvedFilePath = path.resolve(filePath);
		const indexed = this.indexedProjectForFile(resolvedFilePath);
		if (cacheKey !== undefined) {
			const cached = this.contextCache.get(cacheKey.identity);
			if (
				cached !== undefined
				&& cached.filePath === currentFileKey
				&& cached.generation === cacheKey.generation
				&& cached.indexed === indexed
				&& cached.propertyDocument === currentProperty?.document
				&& cached.source === currentSource
				&& sameOpenUnits(cached.openUnits, openUnits)
				&& cached.sourceUnits.length === sourceUnits.length
				&& cached.sourceUnits.every((unit, index) => unit === sourceUnits[index])
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
					indexed,
					propertyDocument: currentProperty?.document,
					source: currentSource,
					openUnits,
					sourceUnits
				});
			}
			return context;
		};
		if (indexed === undefined) {
			if (currentSource !== undefined) {
				/* 独立文件也有当前单元符号；已有 XML 会话继续使用其唯一模型。 */
				const sourceRoot = path.dirname(resolvedFilePath);
				const currentUnit = currentProperty === undefined
					? parseSimpleUnitSymbols(currentSource, resolvedFilePath, sourceRoot)
					: parseSimpleUnitSymbolsFromModel(currentSource, currentProperty, resolvedFilePath, sourceRoot);
				return cacheContext({ currentUnit, manifest: standaloneManifest(currentUnit), standalone: true });
			}
			return cacheContext(undefined);
		}

		const unitsByPath = new Map(
			indexed.units.map((unit) => [filePathKey(unit.filePath), unit] as const)
		);
		/* 只接收属于当前项目源码根的原生文档符号，再由共享会话提供最终覆盖。 */
		for (const unit of sourceUnits) {
			const sourceRoot = projectSourceRoot(indexed.project, unit.filePath);
			if (sourceRoot === unit.sourceRoot) {
				unitsByPath.set(filePathKey(unit.filePath), unit);
			}
		}
		let matchingOpenUnit: SimpleUnitSymbol | undefined;
		for (const snapshot of openUnits) {
			const sourceRoot = projectSourceRoot(indexed.project, snapshot.filePath);
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
			const sourceRoot = projectSourceRoot(indexed.project, resolvedFilePath);
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
