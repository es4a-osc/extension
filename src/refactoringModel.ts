/*
按项目语义快照分析单元、别名、成员和资源引用，并生成最小代码及 XML 修改。
xhwsd@qq.com 2026-10-10
*/

import { createSimpleSourceAnalysis, resolveSimpleBinding, resolveSimpleQualifier, type SimpleSourceAnalysis } from "./completionModel";
import { findSimpleDefinition, type SimpleDefinitionTarget } from "./definitionModel";
import { buildCompilerTokenRules } from "./compilerTokens";
import {
	collectPropertyXmlElements, findPropertyXmlElementPath,
	getPropertyXmlAttribute, getPropertyXmlChildren, writePropertyXmlValue,
	type SimplePropertyXmlDocument, type SimplePropertyXmlParseResult
} from "./propertyXml";
import { getEffectiveMembers, type LibraryManifest, type Sdk } from "./sdk";
import { parseSimpleStringLiteral, serializeSimpleStringLiteral } from "./simpleStringLiteral";
import { filePathKey, simpleQualifiedName } from "./simpleProjectPaths";
import { maskSimpleIgnoredText } from "./simpleSourceLexical";
import {
	buildSemanticDefinitionIndex, isSimpleAliasName, resolveSimpleDefinitionName, parseSimpleUnitSymbolsFromModel, type SimpleProjectSemanticContext, type SimpleUnitSymbol
} from "./simpleUnitSymbols";
import type { SimpleProjectResourceIndex } from "./simpleResourceSymbols";

export interface RefactoringUnit {
	readonly filePath: string;
	readonly sourceRoot: string;
	readonly userCode: string;
	readonly property: SimplePropertyXmlParseResult;
}

export interface SimpleReferenceSpan {
	readonly start: number;
	readonly end: number;
	readonly name: string;
}

export interface SimpleCodeChange extends SimpleReferenceSpan {
	readonly replacement: string;
}

export interface SimpleUnitChange {
	readonly unit: RefactoringUnit;
	readonly edits: readonly SimpleCodeChange[];
	readonly userCode: string;
	readonly propertyDocument: SimplePropertyXmlDocument | undefined;
}

export interface SimpleUnitPathChange {
	readonly oldFile: string;
	readonly newFile: string;
	readonly sourceRoot: string;
}

/** 一次扫描建立偏移，字符串、注释和点链中的词分别保留原始位置。 */
export function simpleIdentifierSpans(source: string): readonly SimpleReferenceSpan[] {
	return [...maskSimpleIgnoredText(source).matchAll(/(?<![\p{L}\p{N}_])[\p{L}_][\p{L}\p{N}_]*/gu)]
		.map((match) => ({ start: match.index, end: match.index + match[0].length, name: match[0] }));
}

export function applySimpleCodeChanges(source: string, edits: readonly SimpleCodeChange[]): string {
	let result = source;
	let boundary = source.length;
	for (const edit of [...edits].sort((left, right) => right.start - left.start || right.end - left.end)) {
		if (edit.start < 0 || edit.end > boundary || edit.end < edit.start) throw new Error("引用修改范围发生重叠。");
		result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
		boundary = edit.start;
	}
	return result;
}

/** 缩小跨区事务的文本替换范围；设计器和项目重构使用同一差异规则。 */
export function minimalSimpleCodeChange(previous: string, next: string): SimpleCodeChange | undefined {
	if (previous === next) return undefined;
	let start = 0;
	while (start < previous.length && start < next.length && previous[start] === next[start]) start += 1;
	let end = previous.length;
	let nextEnd = next.length;
	while (end > start && nextEnd > start && previous[end - 1] === next[nextEnd - 1]) { end -= 1; nextEnd -= 1; }
	return { start, end, name: previous.slice(start, end), replacement: next.slice(start, nextEnd) };
}

/** 重构与语言服务共享规范身份及作用域查找，不单独制造短名称入口。 */
export function refactoringContext(
	unit: RefactoringUnit,
	units: readonly RefactoringUnit[],
	resources?: SimpleProjectResourceIndex,
	parsedSymbols?: readonly SimpleUnitSymbol[]
): SimpleProjectSemanticContext {
	const symbols = parsedSymbols ?? units.map((value) => parseSimpleUnitSymbolsFromModel(value.userCode, value.property, value.filePath, value.sourceRoot));
	const current = symbols.find((value) => filePathKey(value.filePath) === filePathKey(unit.filePath))!;
	const manifest: LibraryManifest = {
		kind: "project", name: "项目单元", filePath: unit.sourceRoot, directory: unit.sourceRoot,
		categories: [{ name: "项目单元", hidden: true, definitions: symbols.map((symbol) => symbol.definition) }]
	};
	return { currentUnit: current, manifest, units: symbols, ...(resources === undefined ? {} : { resources }) };
}

interface UnitReference extends SimpleReferenceSpan {
	readonly target: SimpleUnitSymbol;
	readonly alias?: string;
	readonly full: boolean;
}

/** 解析点链的最长单元前缀；局部变量和成员遮蔽优先于同名类型。 */
function unitReferences(unit: RefactoringUnit, symbols: readonly SimpleUnitSymbol[], context: SimpleProjectSemanticContext, sdk?: Sdk, preparedAnalysis?: SimpleSourceAnalysis): readonly UnitReference[] {
	const result: UnitReference[] = [];
	const masked = maskSimpleIgnoredText(unit.userCode);
	const analysis = preparedAnalysis ?? createSimpleSourceAnalysis(unit.userCode, sdk, context);
	const definitions = analysis.definitions;
	const chainPattern = /(?<![\p{L}\p{N}_])[\p{L}_][\p{L}\p{N}_]*(?:[ \t]*\.[ \t]*[\p{L}_][\p{L}\p{N}_]*)*/gu;
	for (const match of masked.matchAll(chainPattern)) {
		const parts = simpleIdentifierSpans(match[0]);
		const first = parts[0]!;
		const start = match.index;
		const lineStart = masked.lastIndexOf("\n", start - 1) + 1;
		const prefix = masked.slice(lineStart, start);
		/* 声明名称及别名左侧不是类型引用。类型注解不受同名变量遮蔽。 */
		if (/^[ \t]*(?:(?:静态|私有|公开)[ \t]+)*(?:变量|常量|函数|过程|属性|别名)[ \t]*$/u.test(prefix)) continue;
		const typePosition = /\b为[ \t]*$/u.test(prefix) || /(?:^|[ \t])为[ \t]*$/u.test(prefix) || /别名[ \t]+[\p{L}_][\p{L}\p{N}_]*[ \t]*=[ \t]*$/u.test(prefix);
		if (!typePosition && resolveSimpleBinding(unit.userCode, start, first.name, context, analysis) !== undefined) continue;
		const alias = isSimpleAliasName(first.name, definitions) ? first.name : undefined;
		for (let length = parts.length; length >= 1; length -= 1) {
			const names = parts.slice(0, length).map((value) => value.name).join(".");
			const definition = resolveSimpleDefinitionName(names, definitions)?.definition;
			const target = symbols.find((value) => value.definition.sourceFile === definition?.sourceFile);
			if (target === undefined) continue;
			const last = parts[length - 1]!;
			result.push({ start, end: start + last.end, name: unit.userCode.slice(start, start + last.end), target, full: names === target.qualifiedName, ...(alias === undefined ? {} : { alias }) });
			break;
		}
	}
	return result;
}

export function findSimpleUnitAtPosition(unit: RefactoringUnit, units: readonly RefactoringUnit[], offset: number): { readonly reference: SimpleReferenceSpan; readonly target: RefactoringUnit } | undefined {
	const symbols = units.map((value) => parseSimpleUnitSymbolsFromModel(value.userCode, value.property, value.filePath, value.sourceRoot));
	const reference = unitReferences(unit, symbols, refactoringContext(unit, units)).find((value) => value.alias === undefined && offset >= value.start && offset < value.end);
	const target = reference === undefined ? undefined : units.find((value) => filePathKey(value.filePath) === filePathKey(reference.target.filePath));
	return reference === undefined || target === undefined ? undefined : { reference, target };
}

/** 在头部普通注释之后、首个声明的注解之前插入别名。 */
function aliasInsertionOffset(source: string): number {
	let offset = 0;
	for (const line of source.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/gu)) {
		if (line[0].length === 0) break;
		if (/^[ \t]*$/u.test(line[0].replace(/[\r\n]/gu, ""))) offset += line[0].length;
		else if (/^[ \t]*'(?!')/u.test(line[0])) offset += line[0].length;
		else break;
	}
	return offset;
}

function relationChanges(document: SimplePropertyXmlDocument, moves: ReadonlyMap<string, { readonly name: string; readonly type?: string }>): SimplePropertyXmlDocument {
	let next = document;
	for (const assignment of collectPropertyXmlElements(document.root, "赋值")) {
		const property = getPropertyXmlAttribute(assignment, "属性");
		const value = getPropertyXmlAttribute(assignment, "值");
		if (value === undefined || (property !== "基础对象" && property !== "实现接口")) continue;
		const replace = (name: string): string => {
			const move = moves.get(name);
			return move?.type === (property === "基础对象" ? "对象" : "接口") ? move.name : name;
		};
		// 关系值是单个对象名或逗号分隔的接口名；不替换任意表达式中的名称片段。
		const qualified = /^(\s*)([\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*)(\s*)$/u;
		const replaceItem = (part: string): string => part.replace(qualified, (_match, before: string, name: string, after: string) => before + replace(name) + after);
		const updated = property === "基础对象" ? replaceItem(value) : value.split(",").map(replaceItem).join(",");
		if (updated !== value) {
			const elementPath = findPropertyXmlElementPath(document, assignment);
			if (elementPath !== undefined) next = writePropertyXmlValue(next, elementPath + "/@值", updated);
		}
	}
	return next;
}

/** 以同一次旧语义分析修正入站引用及移动单元自己的出站引用。 */
export function planSimpleUnitPaths(units: readonly RefactoringUnit[], paths: readonly SimpleUnitPathChange[], sdk?: Sdk): readonly SimpleUnitChange[] {
	const symbols = units.map((unit) => parseSimpleUnitSymbolsFromModel(unit.userCode, unit.property, unit.filePath, unit.sourceRoot));
	const movedFiles = new Map(paths.map((value) => [filePathKey(value.oldFile), value]));
	const moves = new Map(symbols.flatMap((symbol) => {
		const moved = movedFiles.get(filePathKey(symbol.filePath));
		return moved === undefined ? [] : [[symbol.qualifiedName, { name: simpleQualifiedName(moved.sourceRoot, moved.newFile), type: symbol.unitType }] as const];
	}));
	const nextNames = symbols.map((symbol) => moves.get(symbol.qualifiedName)?.name ?? symbol.qualifiedName);
	const nextSymbols = symbols.map((symbol, index) => {
		const moved = movedFiles.get(filePathKey(symbol.filePath));
		return moved === undefined ? symbol : parseSimpleUnitSymbolsFromModel(units[index]!.userCode, units[index]!.property, moved.newFile, moved.sourceRoot);
	});
	if (new Set(nextNames).size !== nextNames.length) throw new Error("目标单元限定名与项目内已有单元冲突。");
	return units.flatMap((unit) => {
		const context = refactoringContext(unit, units, undefined, symbols);
		const ownMove = movedFiles.get(filePathKey(unit.filePath));
		const nextUnit = ownMove === undefined ? unit : { ...unit, filePath: ownMove.newFile, sourceRoot: ownMove.sourceRoot };
		const nextDefinitions = buildSemanticDefinitionIndex(sdk, refactoringContext(nextUnit, units, undefined, nextSymbols));
		const analysis = createSimpleSourceAnalysis(unit.userCode, sdk, context);
		const boundNames = new Set(simpleIdentifierSpans(unit.userCode).filter((span) => resolveSimpleBinding(unit.userCode, span.start, span.name, context, analysis) !== undefined).map((span) => span.name));
		const edits: SimpleCodeChange[] = [];
		const aliases = new Map<string, string>();
		for (const reference of unitReferences(unit, symbols, context, sdk, analysis)) {
			const nextTarget = moves.get(reference.target.qualifiedName)?.name ?? reference.target.qualifiedName;
			if (reference.alias !== undefined) continue; // 别名右侧作为独立完整引用更新，使用处保持别名。
			if (reference.full) {
				if (nextTarget !== reference.target.qualifiedName) edits.push({ ...reference, replacement: nextTarget });
				continue;
			}
			/* 自己的短事件拥有者不因移动改变，改文件名时更新自身短名。 */
			if (!reference.name.includes(".") && filePathKey(reference.target.filePath) === filePathKey(unit.filePath)) {
				const nextShort = nextTarget.slice(nextTarget.lastIndexOf(".") + 1);
				if (nextShort !== reference.name) edits.push({ ...reference, replacement: nextShort });
				continue;
			}
			const previousShort = reference.target.qualifiedName.slice(reference.target.qualifiedName.lastIndexOf(".") + 1);
			const nextShort = nextTarget.slice(nextTarget.lastIndexOf(".") + 1);
			// 改单元名称直接更新短名；只有命名空间移动造成的不可见才需要保留旧名的别名。
			if (!reference.name.includes(".") && previousShort !== nextShort) {
				const shortVisible = resolveSimpleDefinitionName(nextShort, nextDefinitions)?.definition.name === nextTarget && resolveSimpleBinding(unit.userCode, reference.start, nextShort, context, analysis) === undefined;
				edits.push({ ...reference, replacement: shortVisible ? nextShort : nextTarget });
				continue;
			}
			const nextResolved = resolveSimpleDefinitionName(reference.name.replace(/[ \t]/gu, ""), nextDefinitions);
			if (nextResolved?.definition.name === nextTarget) continue;
			/* 相对包路径失效时只更新单元前缀，不能为点号名称创建别名。 */
			if (reference.name.includes(".")) {
				const spelling = reference.name.replace(/[ \t]/gu, "");
				const omitted = reference.target.qualifiedName.slice(0, -spelling.length);
				const relative = nextTarget.startsWith(omitted) ? nextTarget.slice(omitted.length) : nextTarget;
				const replacement = resolveSimpleDefinitionName(relative, nextDefinitions)?.definition.name === nextTarget ? relative : nextTarget;
				edits.push({ ...reference, replacement });
				continue;
			}
			const conflict = nextResolved !== undefined
				|| context.currentUnit!.aliases.some((value) => value.name === reference.name && value.target !== reference.target.qualifiedName)
				|| boundNames.has(reference.name);
			if (conflict) edits.push({ ...reference, replacement: nextTarget });
			// 与旧目标相同的已有别名，其 RHS 已在本计划更新，不能再插入第二条。
			else if (!context.currentUnit!.aliases.some((value) => value.name === reference.name && value.target === reference.target.qualifiedName)) aliases.set(reference.name, nextTarget);
		}
		if (aliases.size > 0) {
			const offset = aliasInsertionOffset(unit.userCode);
			const eol = unit.userCode.includes("\r\n") ? "\r\n" : unit.userCode.includes("\n") ? "\n" : "\r\n";
			edits.push({ start: offset, end: offset, name: "", replacement: [...aliases].map(([name, target]) => `别名 ${name} = ${target}${eol}`).join("") + eol });
		}
		const propertyDocument = ownMove === undefined && unit.property.document !== undefined ? relationChanges(unit.property.document, moves) : unit.property.document;
		if (edits.length === 0 && propertyDocument === unit.property.document) return [];
		return [{ unit, edits, propertyDocument, userCode: applySimpleCodeChanges(unit.userCode, edits) }];
	});
}

/** 将定义解析的真实文件、声明偏移或成员位置转换为稳定引用身份。 */
export function simpleDefinitionIdentity(target: SimpleDefinitionTarget): string | undefined {
	if (target.filePath === undefined || target.resourceSource === true) return undefined;
	return filePathKey(target.filePath) + (target.propertySource === true ? `:组件:${target.name}` : target.targetOffset !== undefined ? `:偏移:${target.targetOffset}` : `:行:${target.targetLine ?? 0}:${target.memberGroup ?? target.symbolKind ?? "单元"}`);
}

export function findSimpleProjectReferences(
	units: readonly RefactoringUnit[], origin: RefactoringUnit, offset: number, sdk: Sdk | undefined,
	resources?: SimpleProjectResourceIndex
): readonly { readonly unit: RefactoringUnit; readonly span: SimpleReferenceSpan }[] {
	const symbols = units.map((unit) => parseSimpleUnitSymbolsFromModel(unit.userCode, unit.property, unit.filePath, unit.sourceRoot));
	const context = refactoringContext(origin, units, resources, symbols);
	const originAnalysis = createSimpleSourceAnalysis(origin.userCode, sdk, context);
	const target = findSimpleDefinition(origin.userCode, offset, sdk, context, originAnalysis);
	const identity = target === undefined ? undefined : simpleDefinitionIdentity(target);
	if (identity === undefined) return [];
	const identities = relatedMemberIdentities(units, identity, sdk);
	return units.flatMap((unit) => {
		const current = unit === origin ? context : refactoringContext(unit, units, resources, symbols);
		// 一次引用扫描只建立一次词法、作用域和定义索引，不按标识符重复解析全文。
		const analysis = unit === origin ? originAnalysis : createSimpleSourceAnalysis(unit.userCode, sdk, current);
		return simpleIdentifierSpans(unit.userCode).flatMap((span) => {
			const resolved = findSimpleDefinition(unit.userCode, span.start, sdk, current, analysis);
			return resolved !== undefined && identities.has(simpleDefinitionIdentity(resolved) ?? "") ? [{ unit, span }] : [];
		});
	});
}

/** 项目接口及对象覆写的方法属于同一个契约；字段和局部绑定保持各自身份。 */
function relatedMemberIdentities(units: readonly RefactoringUnit[], identity: string, sdk: Sdk | undefined): ReadonlySet<string> {
	const identities = new Set([identity]);
	const nodes = units.flatMap((unit) => {
		const symbol = parseSimpleUnitSymbolsFromModel(unit.userCode, unit.property, unit.filePath, unit.sourceRoot);
		return (["functions", "properties", "events"] as const).flatMap((group) => (symbol.definition[group] ?? []).map((member) => ({ unit, symbol, group, member, identity: filePathKey(unit.filePath) + `:偏移:${member.declarationOffset}` })));
	});
	const selected = nodes.find((node) => node.identity === identity);
	if (selected === undefined) return identities;
	const same = (node: typeof selected): boolean => node.group === selected.group && node.member.name === selected.member.name && (node.member.params?.length ?? 0) === (selected.member.params?.length ?? 0);
	const context = refactoringContext(selected.unit, units);
	const definitions = buildSemanticDefinitionIndex(sdk, context);
	const contracts = (node: typeof selected): readonly string[] => (node.symbol.definition.inherits ?? []).flatMap((parent) => {
		const reference = definitions.get(parent);
		if (reference === undefined) return [];
		return getEffectiveMembers(reference, selected.group, definitions)
			.filter((value) => value.member.name === selected.member.name && (value.member.params?.length ?? 0) === (selected.member.params?.length ?? 0))
			.map((value) => value.owner.definition.name);
	});
	const connected = new Set([selected.symbol.qualifiedName]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const node of nodes.filter(same)) {
			const parents = contracts(node);
			if (connected.has(node.symbol.qualifiedName)) {
				for (const parent of parents) if (!connected.has(parent)) { connected.add(parent); changed = true; }
			} else if (parents.some((parent) => connected.has(parent))) { connected.add(node.symbol.qualifiedName); changed = true; }
		}
	}
	for (const node of nodes.filter((value) => same(value) && connected.has(value.symbol.qualifiedName))) identities.add(node.identity);
	/* SDK 契约不能通过项目内改名改变；明确拒绝，避免生成看似成功的失效覆写。 */
	for (const name of connected) {
		const reference = definitions.get(name);
		if (reference !== undefined && reference.manifest.kind !== "project" && getEffectiveMembers(reference, selected.group, definitions).some((value) => value.member.name === selected.member.name && (value.member.params?.length ?? 0) === (selected.member.params?.length ?? 0))) {
			/* 查找引用仍可读取契约；是否允许改名由计划器判断。 */
			identities.add("sdk-contract");
		}
	}
	return identities;
}

function renameReferenceIdentity(target: SimpleDefinitionTarget): string | undefined {
	return target.librarySymbol === undefined ? simpleDefinitionIdentity(target) : "SDK:" + JSON.stringify(target.librarySymbol);
}

/** 在声明偏移随名称长度变化后，仍按原声明身份比较引用目标。 */
function renamedDefinitionIdentity(target: SimpleDefinitionTarget, changes: ReadonlyMap<string, SimpleUnitChange>, identities: ReadonlySet<string>, newName: string): string | undefined {
	if (target.librarySymbol !== undefined) return renameReferenceIdentity(target);
	if (target.filePath === undefined) return undefined;
	const change = changes.get(filePathKey(target.filePath));
	const targetOffset = target.targetOffset === undefined ? undefined : renamedOffset(target.targetOffset, change?.edits ?? []);
	const name = target.propertySource === true && identities.has(simpleDefinitionIdentity(target) ?? "") ? newName : target.name;
	return simpleDefinitionIdentity({ ...target, name, targetOffset });
}

function renamedOffset(offset: number, edits: readonly SimpleCodeChange[]): number {
	return offset + edits.reduce((delta, edit) => edit.end <= offset ? delta + edit.replacement.length - (edit.end - edit.start) : delta, 0);
}

/** 对内存计划重新绑定：被改引用仍指向原声明，已有新名称引用不能被新声明抢占。 */
function assertRenameBindings(units: readonly RefactoringUnit[], plans: readonly SimpleUnitChange[], target: SimpleDefinitionTarget, identities: ReadonlySet<string>, newName: string, sdk: Sdk | undefined): void {
	const changes = new Map(plans.map((plan) => [filePathKey(plan.unit.filePath), plan]));
	const staged = units.map((unit): RefactoringUnit => {
		let property = unit.property;
		if (target.propertySource === true && filePathKey(unit.filePath) === filePathKey(target.filePath!) && property.document !== undefined) {
			const component = collectPropertyXmlElements(property.document.root, "定义").find((node) => getPropertyXmlAttribute(node, "名称") === target.name);
			const componentPath = component === undefined ? undefined : findPropertyXmlElementPath(property.document, component);
			if (componentPath !== undefined) property = { ...property, document: writePropertyXmlValue(property.document, componentPath + "/@名称", newName) };
		}
		return { ...unit, property, userCode: changes.get(filePathKey(unit.filePath))?.userCode ?? unit.userCode };
	});
	const beforeSymbols = units.map((unit) => parseSimpleUnitSymbolsFromModel(unit.userCode, unit.property, unit.filePath, unit.sourceRoot));
	const afterSymbols = staged.map((unit) => parseSimpleUnitSymbolsFromModel(unit.userCode, unit.property, unit.filePath, unit.sourceRoot));
	for (const [index, unit] of units.entries()) {
		const edits = changes.get(filePathKey(unit.filePath))?.edits ?? [];
		const existing = simpleIdentifierSpans(unit.userCode).filter((span) => span.name === newName);
		if (edits.length === 0 && existing.length === 0) continue;
		const beforeContext = refactoringContext(unit, units, undefined, beforeSymbols);
		const after = staged[index]!;
		const afterContext = refactoringContext(after, staged, undefined, afterSymbols);
		const beforeAnalysis = createSimpleSourceAnalysis(unit.userCode, sdk, beforeContext);
		const afterAnalysis = createSimpleSourceAnalysis(after.userCode, sdk, afterContext);
		for (const span of [...edits, ...existing]) {
			const previous = findSimpleDefinition(unit.userCode, span.start, sdk, beforeContext, beforeAnalysis);
			if (previous === undefined) continue;
			const next = findSimpleDefinition(after.userCode, renamedOffset(span.start, edits), sdk, afterContext, afterAnalysis);
			const expected = renamedDefinitionIdentity(previous, changes, identities, newName);
			const actual = next === undefined ? undefined : renameReferenceIdentity(next);
			if (expected !== undefined && expected !== actual) throw new Error(`名称“${newName}”会改变已有引用的目标，不能重命名。`);
		}
	}
}

/** 变量、参数、字段、方法和别名使用真实定义身份改名，不改同名遮蔽声明。 */
export function planSimpleSymbolRename(units: readonly RefactoringUnit[], origin: RefactoringUnit, offset: number, newName: string, sdk: Sdk | undefined): readonly SimpleUnitChange[] {
	if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(newName) || buildCompilerTokenRules(sdk).some((rule) => rule.text === newName)) throw new Error("名称必须是有效的 Simple 标识符，不能使用关键字或 SDK 保留名称。");
	const references = findSimpleProjectReferences(units, origin, offset, sdk);
	if (references.length === 0) throw new Error("此处没有可重命名的项目符号。");
	const target = findSimpleDefinition(origin.userCode, offset, sdk, refactoringContext(origin, units))!;
	if (target.name === newName) return [];
	const identity = simpleDefinitionIdentity(target)!;
	const identities = relatedMemberIdentities(units, identity, sdk);
	if (identities.has("sdk-contract")) throw new Error("此成员属于 SDK 契约，不能在项目中重命名。");
	const symbols = units.map((unit) => parseSimpleUnitSymbolsFromModel(unit.userCode, unit.property, unit.filePath, unit.sourceRoot));
	// 契约改名同时影响接口及实现；每个实际声明所在单元都要预检目标成员冲突。
	for (const symbol of symbols) {
		const groups = ["functions", "events", "properties", "variables", "constants"] as const;
		const members = groups.flatMap((group) => symbol.definition[group] ?? []);
		const renamed = members.filter((member) => identities.has(filePathKey(symbol.filePath) + `:偏移:${member.declarationOffset}`));
		if (renamed.length > 0 && members.some((member) => member.name === newName && !renamed.includes(member))) throw new Error(`成员名称“${newName}”已经存在。`);
	}
	const plans = units.flatMap((unit) => {
		const edits = references.filter((value) => value.unit === unit).map(({ span }) => ({ ...span, replacement: newName }));
		const context = refactoringContext(unit, units, undefined, symbols);
		const analysis = edits.length === 0 ? undefined : createSimpleSourceAnalysis(unit.userCode, sdk, context);
		for (const edit of edits) {
			if (!/\.[ \t]*$/u.test(unit.userCode.slice(0, edit.start)) && resolveSimpleBinding(unit.userCode, edit.start, newName, context, analysis) !== undefined) throw new Error(`名称“${newName}”会与现有绑定冲突。`);
		}
		/* 后续局部声明同样参与冲突检查，不能只检查原名称被使用的位置。 */
		if (target.symbolKind === "binding" && filePathKey(unit.filePath) === filePathKey(target.filePath!)) {
			for (const span of simpleIdentifierSpans(unit.userCode).filter((value) => value.name === newName)) {
				const existing = resolveSimpleBinding(unit.userCode, span.end, newName, context, analysis);
				const original = resolveSimpleBinding(unit.userCode, span.end, target.name, context, analysis);
				if (existing?.declarationStart === span.start && original?.declarationStart === target.targetOffset) throw new Error(`同一作用域已经声明“${newName}”。`);
			}
		}
		if (target.symbolKind === "alias" && (context.currentUnit?.aliases.some((value) => value.name === newName) || buildSemanticDefinitionIndex(sdk, context).has(newName))) throw new Error(`别名“${newName}”已经存在。`);
		return edits.length === 0 ? [] : [{ unit, edits, userCode: applySimpleCodeChanges(unit.userCode, edits), propertyDocument: unit.property.document }];
	});
	assertRenameBindings(units, plans, target, identities, newName, sdk);
	return plans;
}

/** SDK 明确声明的资产属性引用；普通字符串不参与资源重构和诊断。 */
export interface SimpleAssetReference extends SimpleReferenceSpan {
	readonly value: string;
	readonly propertyPath?: string;
}

export function findSimpleAssetReferences(unit: RefactoringUnit, context: SimpleProjectSemanticContext, sdk: Sdk | undefined, analysis?: SimpleSourceAnalysis): readonly SimpleAssetReference[] {
	const definitions = analysis?.definitions ?? buildSemanticDefinitionIndex(sdk, context);
	const masked = analysis?.sanitized ?? maskSimpleIgnoredText(unit.userCode);
	const result: SimpleAssetReference[] = [];
	const assetProperties = (component: string): ReadonlySet<string> => {
		const reference = definitions.get(component);
		return new Set(reference === undefined ? [] : getEffectiveMembers(reference, "properties", definitions).filter((value) => value.member.editor === "simple.asset").map((value) => value.member.name));
	};
	for (const match of unit.userCode.matchAll(/([\p{L}_][\p{L}\p{N}_]*(?:[ \t]*\.[ \t]*[\p{L}_][\p{L}\p{N}_]*)*)[ \t]*=[ \t]*("(?:\\[^\r\n]|[^"\\\r\n])*")/gu)) {
		if (masked[match.index] === " ") continue;
		const names = match[1]!.split(/[ \t]*\.[ \t]*/u);
		const member = names.pop()!;
		const reference = names.length > 0 ? resolveSimpleQualifier(unit.userCode, match.index, names.join("."), sdk, context, analysis)?.reference : definitions.get(context.currentUnit?.qualifiedName ?? "");
		if (names.length === 0 && resolveSimpleBinding(unit.userCode, match.index, member, context, analysis) !== undefined) continue;
		if (reference === undefined || !assetProperties(reference.definition.name).has(member)) continue;
		const value = parseSimpleStringLiteral(match[2]!);
		if (value === undefined) continue;
		const start = match.index + match[0].lastIndexOf(match[2]!);
		result.push({ start, end: start + match[2]!.length, name: match[2]!, value });
	}
	const document = unit.property.document;
	if (document !== undefined) {
		for (const definition of collectPropertyXmlElements(document.root, "定义")) {
			const names = assetProperties(getPropertyXmlAttribute(definition, "组件") ?? "");
			for (const assignment of getPropertyXmlChildren(definition, "赋值")) {
				if (!names.has(getPropertyXmlAttribute(assignment, "属性") ?? "")) continue;
				const name = getPropertyXmlAttribute(assignment, "值") ?? "";
				const value = parseSimpleStringLiteral(name);
				const elementPath = findPropertyXmlElementPath(document, assignment);
				if (value !== undefined && elementPath !== undefined) result.push({ start: 0, end: name.length, name, value, propertyPath: elementPath + "/@值" });
			}
		}
	}
	return result;
}

/** R 必须是完整的首段名称，不能把中文标识符后缀或对象成员误认成资源入口。 */
function resourceMembers(source: string): readonly RegExpExecArray[] {
	const masked = maskSimpleIgnoredText(source);
	return [...masked.matchAll(/(?<![\p{L}\p{N}_])R[ \t]*\.[ \t]*([\p{L}_][\p{L}\p{N}_]*)/gu)]
		.filter((match) => {
			let previous = match.index - 1;
			while (previous >= 0 && /[ \t]/u.test(masked[previous]!)) previous -= 1;
			return masked[previous] !== ".";
		});
}

/** 资源只匹配 R 的成员，不修改同名变量或字符串。 */
export function planSimpleResourceReferences(units: readonly RefactoringUnit[], renames: ReadonlyMap<string, string>, sdk?: Sdk, paths: ReadonlyMap<string, string> = new Map()): readonly SimpleUnitChange[] {
	const remap = (name: string): string => {
		for (const [before, after] of paths) {
			if (name === before || (!before.startsWith("@") && name.startsWith(before + "/"))) return after + name.slice(before.length);
		}
		return name;
	};
	const replaceResourceExpression = (source: string): string => {
		const changes = resourceMembers(source).flatMap((match) => {
			const replacement = renames.get(match[1]!);
			const start = match.index + match[0].lastIndexOf(match[1]!);
			return replacement === undefined ? [] : [{ start, end: start + match[1]!.length, name: match[1]!, replacement }];
		});
		return applySimpleCodeChanges(source, changes);
	};
	return units.flatMap((unit) => {
		const context = refactoringContext(unit, units);
		const analysis = createSimpleSourceAnalysis(unit.userCode, sdk, context);
		const edits: SimpleCodeChange[] = [];
		for (const match of resourceMembers(unit.userCode)) {
			const replacement = renames.get(match[1]!);
			if (replacement === undefined || resolveSimpleBinding(unit.userCode, match.index, "R", context, analysis) !== undefined) continue;
			const start = match.index + match[0].lastIndexOf(match[1]!);
			edits.push({ start, end: start + match[1]!.length, name: match[1]!, replacement });
		}
		let propertyDocument = unit.property.document;
		for (const reference of findSimpleAssetReferences(unit, context, sdk, analysis)) {
			const next = remap(reference.value);
			if (next === reference.value) continue;
			const replacement = serializeSimpleStringLiteral(next);
			if (reference.propertyPath === undefined) edits.push({ ...reference, replacement });
			else if (propertyDocument !== undefined) propertyDocument = writePropertyXmlValue(propertyDocument, reference.propertyPath, replacement);
		}
		if (propertyDocument !== undefined) {
			for (const assignment of collectPropertyXmlElements(unit.property.document!.root, "赋值")) {
				const value = getPropertyXmlAttribute(assignment, "值") ?? "";
				const next = replaceResourceExpression(value);
				const elementPath = findPropertyXmlElementPath(unit.property.document!, assignment);
				if (next !== value && elementPath !== undefined) propertyDocument = writePropertyXmlValue(propertyDocument, elementPath + "/@值", next);
			}
		}
		return edits.length === 0 && propertyDocument === unit.property.document ? [] : [{ unit, edits, propertyDocument, userCode: applySimpleCodeChanges(unit.userCode, edits) }];
	});
}
