/*
在 Simple 属性代码与可供所有设计功能共享的通用 XML 文档模型之间双向转换。
xhwsd@qq.com 2026-8-28
*/

import {
	detectSimpleLineEnding,
	findPropertySectionStart
} from "./simpleUnitSource";
import { stripSimpleLineComment } from "./simpleSourceLexical";

/** 当前编译器支持的 Simple 程序单元类型。 */
export type SimpleUnitType = "窗口" | "对象" | "接口" | "服务";

/** 属性 XML 的可用状态。 */
export type PropertyXmlStatus = "valid" | "warning" | "damaged";

/**
 * 通用 XML 节点的设计期临时数据。
 *
 * 这里的数据供属性框、设计器、来源映射和扩展功能传递，不参与 XML 预览或 Simple 写出。
 */
export type PropertyXmlTemporaryData = Map<PropertyKey, unknown>;

/** XML 元素与文本节点共享的临时源位置和会话数据。 */
interface PropertyXmlNodeBase {
	readonly temporary: PropertyXmlTemporaryData;
}

/** 通用 XML 元素；业务含义只由元素名、属性和层级决定。 */
export interface PropertyXmlElement extends PropertyXmlNodeBase {
	readonly attributes: Readonly<Record<string, string>>;
	readonly children: readonly PropertyXmlNode[];
	readonly name: string;
	readonly nodeType: "element";
}

/** XML 文档中的文本节点；用于保留属性代码中的空行。 */
export interface PropertyXmlText extends PropertyXmlNodeBase {
	readonly nodeType: "text";
	readonly value: string;
}

/** 属性 XML 文档中的任意节点。 */
export type PropertyXmlNode = PropertyXmlElement | PropertyXmlText;

/** 一个 Simple 单元对应的通用 XML 属性文档。 */
export interface SimplePropertyXmlDocument {
	readonly issues: readonly string[];
	readonly lineEnding: string;
	readonly root: PropertyXmlElement;
	readonly status: PropertyXmlStatus;
}

/** 属性区解析结果；损坏时仍尽量提供可检查的 XML 文档。 */
export interface SimplePropertyXmlParseResult {
	readonly document?: SimplePropertyXmlDocument;
	readonly issues: readonly string[];
	readonly status: PropertyXmlStatus;
}

/** XML 属性模型写回 Simple 属性代码时使用的排版格式。 */
export interface SimplePropertySourceFormatting {
	readonly indentation: string;
	readonly lineEnding: string;
}

/** XML 路径赋值时控制空值是否删除目标属性或承载该属性的元素。 */
export interface PropertyXmlWriteOptions {
	readonly removeAttributeWhenEmpty?: boolean;
	readonly removeElementWhenEmpty?: boolean;
}

/** 一个具象 XML 路径段及其同名兄弟索引。 */
interface PropertyXmlPathSegment {
	readonly attributeName?: string;
	readonly attributeValue?: string;
	readonly index?: number;
	readonly name: string;
}

/** 路径解析后可直接用于逐层查找的元素段或属性目标。 */
interface ParsedPropertyXmlPath {
	readonly attributeName?: string;
	readonly elements: readonly PropertyXmlPathSegment[];
}

/** 返回新增赋值的插入位置，使直属赋值始终位于直属子定义之前。 */
function findPropertyXmlAssignmentInsertionIndex(children: readonly PropertyXmlNode[]): number {
	const firstDefinitionIndex = children.findIndex((child) => isPropertyXmlElement(child, "定义"));
	let insertionIndex = firstDefinitionIndex < 0 ? children.length : firstDefinitionIndex;
	while (insertionIndex > 0 && children[insertionIndex - 1]?.nodeType === "text") {
		insertionIndex -= 1;
	}
	return insertionIndex;
}

/** 创建通用 XML 元素。 */
export function createPropertyXmlElement(
	name: string,
	attributes: Readonly<Record<string, string>> = {},
	children: readonly PropertyXmlNode[] = [],
	temporary: PropertyXmlTemporaryData = new Map()
): PropertyXmlElement {
	return {
		attributes,
		children,
		name,
		nodeType: "element",
		temporary
	};
}

/** 创建通用 XML 文本节点。 */
export function createPropertyXmlText(
	value: string,
	temporary: PropertyXmlTemporaryData = new Map()
): PropertyXmlText {
	return { nodeType: "text", temporary, value };
}

/** 为新建单元建立最小 XML 属性文档；窗口单元同时包含同名窗口根定义。 */
export function createSimplePropertyXmlDocument(
	unitType: SimpleUnitType,
	unitName: string,
	lineEnding = "\r\n"
): SimplePropertyXmlDocument {
	const children: readonly PropertyXmlNode[] = unitType === "窗口"
		? [
			createPropertyXmlElement("资源", { 单元: unitType }),
			createPropertyXmlElement("定义", { 名称: unitName, 组件: "窗口" })
		]
		: [createPropertyXmlElement("资源", { 单元: unitType })];
	return {
		issues: [],
		lineEnding,
		root: createPropertyXmlElement("属性", {}, children),
		status: "valid"
	};
}

/** 判断节点是否是指定名称的 XML 元素。 */
export function isPropertyXmlElement(
	node: PropertyXmlNode,
	name?: string
): node is PropertyXmlElement {
	return node.nodeType === "element" && (name === undefined || node.name === name);
}

/** 返回元素的指定 XML 属性。 */
export function getPropertyXmlAttribute(
	element: PropertyXmlElement | undefined,
	name: string
): string | undefined {
	return element?.attributes[name];
}

/** 返回元素的指定名称直接子元素。 */
export function getPropertyXmlChildren(
	element: PropertyXmlElement,
	name?: string
): readonly PropertyXmlElement[] {
	return element.children.filter(
		(node): node is PropertyXmlElement => isPropertyXmlElement(node, name)
	);
}

/** 返回 XML 根节点中声明的资源单元名称，包括尚未识别的名称。 */
export function getSimplePropertyResourceUnit(
	document: SimplePropertyXmlDocument
): string | undefined {
	return getPropertyXmlAttribute(getPropertyXmlChildren(document.root, "资源")[0], "单元");
}

/** 返回编译器已经识别的资源单元类型。 */
export function getSimplePropertyUnitType(
	document: SimplePropertyXmlDocument
): SimpleUnitType | undefined {
	const value = getSimplePropertyResourceUnit(document);
	return value !== undefined && isSimpleUnitType(value) ? value : undefined;
}

/** 临时解析属性 XML 并返回单元类型；项目树不保留解析结果。 */
export function detectSimpleUnitType(source: string): SimpleUnitType | undefined {
	const document = inspectSimplePropertyXml(source).document;
	return document === undefined ? undefined : getSimplePropertyUnitType(document);
}

/** XML 属性值转义。 */
function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("\"", "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

/** 还原本模块规范 XML 写出产生的实体；剪贴板片段不接受未知实体。 */
function unescapePropertyXml(value: string): string {
	const entities: Readonly<Record<string, string>> = {
		amp: "&",
		gt: ">",
		lt: "<",
		quot: "\""
	};
	if (value.replace(/&(amp|gt|lt|quot);/gu, "").includes("&")) {
		throw new Error("剪贴板 XML 包含不支持的实体。");
	}
	return value.replace(/&(amp|gt|lt|quot);/gu, (_match, name: string) => entities[name] ?? "");
}

/** 解析一个规范 XML 标签中的属性文本。 */
function parsePropertyXmlAttributes(source: string): Readonly<Record<string, string>> {
	const attributes: Record<string, string> = {};
	const pattern = /\s+([^\s=\/>]+)="([^"]*)"/guy;
	let offset = 0;
	while (offset < source.length) {
		pattern.lastIndex = offset;
		const match = pattern.exec(source);
		if (match === null) {
			throw new Error("剪贴板 XML 属性格式无效。");
		}
		const name = match[1];
		if (name === undefined || Object.hasOwn(attributes, name)) {
			throw new Error("剪贴板 XML 包含无效或重复的属性。");
		}
		attributes[name] = unescapePropertyXml(match[2] ?? "");
		offset = pattern.lastIndex;
	}
	return attributes;
}

/**
 * 解析设计器复制到剪贴板的单个规范 XML 元素。
 *
 * 该入口只接收 `serializePropertyXmlElement` 产生的无声明 XML 片段，不把 XML
 * 当作 `.simple` 磁盘格式，也不接触用户代码或原属性代码。
 */
export function parsePropertyXmlElement(source: string): PropertyXmlElement {
	const lines = source.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
	if (lines.at(-1) === "") {
		lines.pop();
	}
	let index = 0;
	/** 按缩进递归读取剪贴板 XML，同时保留空文本节点。 */
	const parseNode = (depth: number): PropertyXmlNode => {
		const line = lines[index];
		if (line === undefined) {
			throw new Error("剪贴板 XML 意外结束。");
		}
		index += 1;
		const trimmed = line.trim();
		if (trimmed.length === 0) {
			return createPropertyXmlText("");
		}
		if (!trimmed.startsWith("<")) {
			const indentation = "\t".repeat(depth);
			const value = line.startsWith(indentation) ? line.slice(indentation.length) : line;
			return createPropertyXmlText(unescapePropertyXml(value));
		}
		const selfClosing = /^<([^\s\/>]+)([\s\S]*?)\s*\/>$/u.exec(trimmed);
		if (selfClosing !== null) {
			return createPropertyXmlElement(
				selfClosing[1] ?? "",
				parsePropertyXmlAttributes(selfClosing[2] ?? "")
			);
		}
		const opening = /^<([^\s\/>]+)([\s\S]*?)>$/u.exec(trimmed);
		if (opening === null || trimmed.startsWith("</")) {
			throw new Error("剪贴板 XML 标签格式无效。");
		}
		const name = opening[1] ?? "";
		const children: PropertyXmlNode[] = [];
		while (index < lines.length && lines[index]?.trim() !== "</" + name + ">") {
			children.push(parseNode(depth + 1));
		}
		if (lines[index]?.trim() !== "</" + name + ">") {
			throw new Error("剪贴板 XML 缺少结束标签：" + name);
		}
		index += 1;
		return createPropertyXmlElement(
			name,
			parsePropertyXmlAttributes(opening[2] ?? ""),
			children
		);
	};

	const root = parseNode(0);
	if (root.nodeType !== "element" || index !== lines.length) {
		throw new Error("剪贴板必须只包含一个 XML 元素。");
	}
	return root;
}

/** 把 XPath 字面量限制在当前属性名称能够安全表达的范围内。 */
function propertyXmlPathLiteral(value: string): string {
	if (!value.includes("'")) {
		return "'" + value + "'";
	}
	if (!value.includes("\"")) {
		return "\"" + value + "\"";
	}
	throw new Error("XML 路径值不能同时包含单引号和双引号。");
}

/** 在父路径下生成按属性筛选元素并读取目标属性的 XML 路径。 */
export function createPropertyXmlAttributePath(
	parentPath: string,
	elementName: string,
	matchAttribute: string,
	matchValue: string,
	valueAttribute: string
): string {
	return parentPath
		+ "/" + elementName
		+ "[@" + matchAttribute + "=" + propertyXmlPathLiteral(matchValue) + "]"
		+ "/@" + valueAttribute;
}

/** 解析当前实现支持的 XPath 子集。 */
function parsePropertyXmlPath(path: string): ParsedPropertyXmlPath {
	if (!path.startsWith("/")) {
		throw new Error("XML 路径必须从根节点开始。");
	}
	const parts = path.slice(1).split("/").filter((part) => part.length > 0);
	if (parts.length === 0) {
		throw new Error("XML 路径不能为空。");
	}

	let attributeName: string | undefined;
	if (parts.at(-1)?.startsWith("@")) {
		attributeName = parts.pop()?.slice(1);
		if (attributeName === undefined || attributeName.length === 0) {
			throw new Error("XML 属性路径缺少属性名称。");
		}
	}

	/** 将元素路径段解析为同名索引或属性谓词，拒绝含糊路径。 */
	const elements = parts.map((part): PropertyXmlPathSegment => {
		const indexMatch = /^([^\[\]]+)\[(\d+)\]$/u.exec(part);
		if (indexMatch !== null) {
			return {
				index: Number(indexMatch[2]),
				name: indexMatch[1] ?? ""
			};
		}
		const predicateMatch = /^([^\[\]]+)\[@([^=\]]+)=('([^']*)'|"([^"]*)")\]$/u.exec(part);
		if (predicateMatch !== null) {
			return {
				attributeName: predicateMatch[2],
				attributeValue: predicateMatch[4] ?? predicateMatch[5] ?? "",
				name: predicateMatch[1] ?? ""
			};
		}
		if (/^[^\[\]]+$/u.test(part)) {
			return { name: part };
		}
		throw new Error("暂不支持该 XML 路径片段：" + part);
	});

	return { attributeName, elements };
}

/** 返回路径片段在父元素直接子节点中的唯一位置。 */
function matchingChildIndexes(
	parent: PropertyXmlElement,
	segment: PropertyXmlPathSegment
): readonly number[] {
	const matches: number[] = [];
	let sameNameIndex = 0;

	for (const [childIndex, child] of parent.children.entries()) {
		if (!isPropertyXmlElement(child, segment.name)) {
			continue;
		}
		sameNameIndex += 1;
		if (segment.index !== undefined && sameNameIndex !== segment.index) {
			continue;
		}
		if (
			segment.attributeName !== undefined
			&& child.attributes[segment.attributeName] !== segment.attributeValue
		) {
			continue;
		}
		matches.push(childIndex);
	}
	return matches;
}

/** 按绝对 XML 路径读取元素。 */
export function resolvePropertyXmlElement(
	document: SimplePropertyXmlDocument,
	path: string
): PropertyXmlElement | undefined {
	const parsed = parsePropertyXmlPath(path);
	const rootSegment = parsed.elements[0];
	if (
		rootSegment === undefined
		|| rootSegment.name !== document.root.name
		|| rootSegment.index !== undefined
		|| rootSegment.attributeName !== undefined
	) {
		return undefined;
	}

	let current = document.root;
	for (const segment of parsed.elements.slice(1)) {
		const indexes = matchingChildIndexes(current, segment);
		if (indexes.length !== 1) {
			return undefined;
		}
		const child = current.children[indexes[0] ?? -1];
		if (child === undefined || !isPropertyXmlElement(child)) {
			return undefined;
		}
		current = child;
	}
	return current;
}

/** 按 XML 路径读取元素属性。 */
export function readPropertyXmlValue(
	document: SimplePropertyXmlDocument,
	path: string
): string | undefined {
	const parsed = parsePropertyXmlPath(path);
	if (parsed.attributeName === undefined) {
		return undefined;
	}
	return resolvePropertyXmlElement(document, path)?.attributes[parsed.attributeName];
}

/** 返回目标 XML 元素的绝对索引路径。 */
export function findPropertyXmlElementPath(
	document: SimplePropertyXmlDocument,
	target: PropertyXmlElement
): string | undefined {
	if (document.root === target) {
		return "/" + document.root.name;
	}

	/** 按对象身份递归生成路径，确保重复元素名称使用真实兄弟序号。 */
	const visit = (parent: PropertyXmlElement, parentPath: string): string | undefined => {
		const sameNameCounts = new Map<string, number>();
		for (const child of parent.children) {
			if (child === undefined || !isPropertyXmlElement(child)) {
				continue;
			}
			const index = (sameNameCounts.get(child.name) ?? 0) + 1;
			sameNameCounts.set(child.name, index);
			const childPath = parentPath + "/" + child.name + "[" + index + "]";
			if (child === target) {
				return childPath;
			}
			const nested = visit(child, childPath);
			if (nested !== undefined) {
				return nested;
			}
		}
		return undefined;
	};

	return visit(document.root, "/" + document.root.name);
}

/** 克隆元素的正式 XML 数据，临时数据继续跟随同一逻辑节点。 */
function clonePropertyXmlElement(
	element: PropertyXmlElement,
	attributes: Readonly<Record<string, string>> = element.attributes,
	children: readonly PropertyXmlNode[] = element.children
): PropertyXmlElement {
	return createPropertyXmlElement(element.name, attributes, children, element.temporary);
}

/** 不可变更新递归返回的新节点及是否命中目标。 */
interface UpdatePropertyXmlElementResult {
	readonly changed: boolean;
	readonly element?: PropertyXmlElement;
}

/** 沿 XML 路径不可变更新一个属性，并可在路径缺失时创建带谓词的新元素。 */
function updatePropertyXmlElement(
	element: PropertyXmlElement,
	segments: readonly PropertyXmlPathSegment[],
	depth: number,
	attributeName: string,
	value: string,
	removeAttributeWhenEmpty: boolean,
	removeElementWhenEmpty: boolean
): UpdatePropertyXmlElementResult {
	if (depth === segments.length) {
		const previous = element.attributes[attributeName];
		if (removeAttributeWhenEmpty && value.length === 0) {
			if (previous === undefined) return { changed: false, element };
			const attributes = { ...element.attributes };
			delete attributes[attributeName];
			return { changed: true, element: clonePropertyXmlElement(element, attributes) };
		}
		if (removeElementWhenEmpty && value.length === 0) {
			return previous === undefined
				? { changed: false, element }
				: { changed: true };
		}
		if (previous === value) {
			return { changed: false, element };
		}
		return {
			changed: true,
			element: clonePropertyXmlElement(element, {
				...element.attributes,
				[attributeName]: value
			})
		};
	}

	const segment = segments[depth];
	if (segment === undefined) {
		return { changed: false, element };
	}
	const indexes = matchingChildIndexes(element, segment);
	if (indexes.length > 1) {
		throw new Error("XML 路径匹配到多个节点，无法确定修改目标。");
	}
	let childIndex = indexes[0];
	let child: PropertyXmlElement;
	let created = false;

	if (childIndex === undefined) {
		if (segment.index !== undefined || segment.attributeName === undefined) {
			if ((removeAttributeWhenEmpty || removeElementWhenEmpty) && value.length === 0) {
				return { changed: false, element };
			}
			throw new Error("XML 路径不存在：" + segment.name);
		}
		child = createPropertyXmlElement(segment.name, {
			[segment.attributeName]: segment.attributeValue ?? ""
		});
		childIndex = element.children.length;
		created = true;
	} else {
		const existing = element.children[childIndex];
		if (existing === undefined || !isPropertyXmlElement(existing)) {
			throw new Error("XML 路径目标不是元素节点。");
		}
		child = existing;
	}

	const updated = updatePropertyXmlElement(
		child,
		segments,
		depth + 1,
		attributeName,
		value,
		removeAttributeWhenEmpty,
		removeElementWhenEmpty
	);
	if (!updated.changed) {
		return { changed: false, element };
	}

	const children = [...element.children];
	if (updated.element === undefined) {
		children.splice(childIndex, 1);
	} else if (created) {
		const insertionIndex = updated.element.name === "赋值"
			? findPropertyXmlAssignmentInsertionIndex(children)
			: children.length;
		children.splice(insertionIndex, 0, updated.element);
	} else {
		children[childIndex] = updated.element;
	}
	return {
		changed: true,
		element: clonePropertyXmlElement(element, element.attributes, children)
	};
}

/** 按 XML 路径设置值；属性框、设计器和其他扩展功能共享此入口。 */
export function writePropertyXmlValue(
	document: SimplePropertyXmlDocument,
	path: string,
	requestedValue: string,
	options: PropertyXmlWriteOptions = {}
): SimplePropertyXmlDocument {
	if (document.status === "damaged") {
		throw new Error("XML 属性已经损坏，不能安全修改。");
	}
	if (/\r|\n/u.test(requestedValue)) {
		throw new Error("XML 属性值不能包含换行。");
	}
	const parsed = parsePropertyXmlPath(path);
	const rootSegment = parsed.elements[0];
	if (
		rootSegment === undefined
		|| rootSegment.name !== document.root.name
		|| rootSegment.index !== undefined
		|| rootSegment.attributeName !== undefined
	) {
		throw new Error("XML 路径根节点与当前文档不一致。");
	}
	if (parsed.attributeName === undefined) {
		throw new Error("XML 置值路径必须以属性结束。");
	}

	const value = requestedValue.trim();
	const result = updatePropertyXmlElement(
		document.root,
		parsed.elements,
		1,
		parsed.attributeName,
		value,
		options.removeAttributeWhenEmpty === true,
		options.removeElementWhenEmpty === true
	);
	if (!result.changed || result.element === undefined) {
		return document;
	}
	return { ...document, root: result.element };
}

/**
 * 在指定 XML 父元素中插入一个真实子元素。
 *
 * 指定参照节点时只能在其之前或之后插入，并要求参照节点是父元素的直接子节点；
 * 未指定时追加到尾部空行之前。调用者负责校验父子组件关系和业务字段。
 */
export function insertPropertyXmlElement(
	document: SimplePropertyXmlDocument,
	parentPath: string,
	child: PropertyXmlElement,
	referencePath?: string,
	position: "after" | "before" = "after"
): SimplePropertyXmlDocument {
	if (document.status === "damaged") {
		throw new Error("XML 属性已经损坏，不能安全修改。");
	}
	const parent = resolvePropertyXmlElement(document, parentPath);
	if (parent === undefined) {
		throw new Error("XML 父节点不存在：" + parentPath);
	}
	const reference = referencePath === undefined
		? undefined
		: resolvePropertyXmlElement(document, referencePath);
	if (referencePath !== undefined && reference === undefined) {
		throw new Error("XML 插入参照节点不存在：" + referencePath);
	}
	/** 不可变递归到目标父节点，并在尾部空文本节点之前插入新元素。 */
	const append = (element: PropertyXmlElement): UpdatePropertyXmlElementResult => {
		if (element === parent) {
			const children = [...element.children];
			let insertionIndex: number;
			if (reference !== undefined) {
				const referenceIndex = children.findIndex((candidate) => candidate === reference);
				if (referenceIndex < 0) {
					throw new Error("XML 插入参照节点不是目标父节点的直接子节点。");
				}
				insertionIndex = referenceIndex + (position === "after" ? 1 : 0);
			} else {
				insertionIndex = children.length;
				while (
					insertionIndex > 0
						&& children[insertionIndex - 1]?.nodeType === "text"
				) {
					insertionIndex -= 1;
				}
			}
			children.splice(insertionIndex, 0, child);
			return {
				changed: true,
				element: clonePropertyXmlElement(element, element.attributes, children)
			};
		}

		for (const [index, node] of element.children.entries()) {
			if (!isPropertyXmlElement(node)) {
				continue;
			}
			const updated = append(node);
			if (!updated.changed || updated.element === undefined) {
				continue;
			}
			const children = [...element.children];
			children[index] = updated.element;
			return {
				changed: true,
				element: clonePropertyXmlElement(element, element.attributes, children)
			};
		}
		return { changed: false, element };
	};

	const updated = append(document.root);
	if (!updated.changed || updated.element === undefined) {
		throw new Error("XML 父节点不属于当前文档：" + parentPath);
	}
	return { ...document, root: updated.element };
}

/** 在指定 XML 元素末尾追加一个真实子元素。 */
export function appendPropertyXmlElement(
	document: SimplePropertyXmlDocument,
	parentPath: string,
	child: PropertyXmlElement
): SimplePropertyXmlDocument {
	return insertPropertyXmlElement(document, parentPath, child);
}

/** 返回候选元素是否位于指定元素的完整子树中。 */
function propertyXmlElementContains(
	element: PropertyXmlElement,
	candidate: PropertyXmlElement
): boolean {
	return element === candidate || getPropertyXmlChildren(element)
		.some((child) => propertyXmlElementContains(child, candidate));
}

/**
 * 把一个现有 XML 元素及其完整子树移动到另一个父元素。
 *
 * 源节点、目标父节点和可选参照节点均从同一文档解析；操作采用一次不可变树更新，
 * 因此同父排序和跨父移动不会因路径序号变化而误中其它节点。
 */
export function relocatePropertyXmlElement(
	document: SimplePropertyXmlDocument,
	elementPath: string,
	parentPath: string,
	referencePath?: string,
	position: "after" | "before" = "after"
): SimplePropertyXmlDocument {
	if (document.status === "damaged") {
		throw new Error("XML 属性已经损坏，不能安全修改。");
	}
	const target = resolvePropertyXmlElement(document, elementPath);
	const parent = resolvePropertyXmlElement(document, parentPath);
	const reference = referencePath === undefined
		? undefined
		: resolvePropertyXmlElement(document, referencePath);
	if (target === undefined) {
		throw new Error("XML 移动目标不存在：" + elementPath);
	}
	if (parent === undefined) {
		throw new Error("XML 目标父节点不存在：" + parentPath);
	}
	if (target === document.root) {
		throw new Error("XML 根节点不能移动。");
	}
	if (propertyXmlElementContains(target, parent)) {
		throw new Error("XML 节点不能移动到自身或自己的子节点中。");
	}
	if (reference === target) {
		throw new Error("XML 移动参照节点不能是目标自身。");
	}
	if (referencePath !== undefined && reference === undefined) {
		throw new Error("XML 移动参照节点不存在：" + referencePath);
	}
	if (reference !== undefined && !parent.children.includes(reference)) {
		throw new Error("XML 移动参照节点不是目标父节点的直接子节点。");
	}

	/** 单次递归同时移除源节点并在目标父节点重插，保持其它节点对象不变。 */
	const relocate = (element: PropertyXmlElement): UpdatePropertyXmlElementResult => {
		let changed = false;
		const children: Array<{ original: PropertyXmlNode; value: PropertyXmlNode }> = [];
		for (const child of element.children) {
			if (child === target) {
				changed = true;
				continue;
			}
			if (!isPropertyXmlElement(child)) {
				children.push({ original: child, value: child });
				continue;
			}
			const updated = relocate(child);
			changed ||= updated.changed;
			children.push({ original: child, value: updated.element ?? child });
		}
		if (element === parent) {
			let insertionIndex: number;
			if (reference !== undefined) {
				const referenceIndex = children.findIndex((child) => child.original === reference);
				if (referenceIndex < 0) {
					throw new Error("XML 移动参照节点不再属于目标父节点。");
				}
				insertionIndex = referenceIndex + (position === "after" ? 1 : 0);
			} else {
				insertionIndex = children.length;
				while (insertionIndex > 0 && children[insertionIndex - 1]?.value.nodeType === "text") {
					insertionIndex -= 1;
				}
			}
			children.splice(insertionIndex, 0, { original: target, value: target });
			changed = true;
		}
		return changed
			? {
				changed: true,
				element: clonePropertyXmlElement(
					element,
					element.attributes,
					children.map((child) => child.value)
				)
			}
			: { changed: false, element };
	};

	const updated = relocate(document.root);
	if (!updated.changed || updated.element === undefined) {
		throw new Error("XML 移动目标或目标父节点不属于当前文档。");
	}
	return { ...document, root: updated.element };
}

/**
 * 按绝对 XML 路径删除一个真实元素及其完整子树。
 *
 * 根节点不能删除；调用者负责限制目标的业务类型。该操作不可变更新祖先节点，
 * 未命中的兄弟节点、文本节点、顺序和临时数据均保持不变。
 */
export function removePropertyXmlElement(
	document: SimplePropertyXmlDocument,
	elementPath: string
): SimplePropertyXmlDocument {
	if (document.status === "damaged") {
		throw new Error("XML 属性已经损坏，不能安全修改。");
	}
	const target = resolvePropertyXmlElement(document, elementPath);
	if (target === undefined) {
		throw new Error("XML 删除目标不存在：" + elementPath);
	}
	if (target === document.root) {
		throw new Error("XML 根节点不能删除。");
	}

	/** 只克隆从根到目标父节点的路径并删除目标子树。 */
	const remove = (element: PropertyXmlElement): UpdatePropertyXmlElementResult => {
		const targetIndex = element.children.findIndex((child) => child === target);
		if (targetIndex >= 0) {
			const children = [...element.children];
			children.splice(targetIndex, 1);
			return {
				changed: true,
				element: clonePropertyXmlElement(element, element.attributes, children)
			};
		}
		for (const [index, child] of element.children.entries()) {
			if (!isPropertyXmlElement(child)) {
				continue;
			}
			const updated = remove(child);
			if (!updated.changed || updated.element === undefined) {
				continue;
			}
			const children = [...element.children];
			children[index] = updated.element;
			return {
				changed: true,
				element: clonePropertyXmlElement(element, element.attributes, children)
			};
		}
		return { changed: false, element };
	};

	const updated = remove(document.root);
	if (!updated.changed || updated.element === undefined) {
		throw new Error("XML 删除目标不属于当前文档：" + elementPath);
	}
	return { ...document, root: updated.element };
}

/**
 * 将一个 XML 元素与前一个或后一个同名兄弟元素交换位置。
 *
 * 只调整目标父节点的 children 顺序；其它元素、文本节点、属性和临时数据保持不变。
 */
export function movePropertyXmlElement(
	document: SimplePropertyXmlDocument,
	elementPath: string,
	direction: "next" | "previous"
): SimplePropertyXmlDocument {
	if (document.status === "damaged") {
		throw new Error("XML 属性已经损坏，不能安全修改。");
	}
	const target = resolvePropertyXmlElement(document, elementPath);
	if (target === undefined) {
		throw new Error("XML 移动目标不存在：" + elementPath);
	}
	if (target === document.root) {
		throw new Error("XML 根节点不能移动。");
	}

	/** 只在同名 XML 兄弟之间交换位置，文本和其它元素顺序保持不变。 */
	const move = (element: PropertyXmlElement): UpdatePropertyXmlElementResult => {
		const targetIndex = element.children.findIndex((child) => child === target);
		if (targetIndex >= 0) {
			const siblingIndexes = element.children
				.map((child, index) => isPropertyXmlElement(child) && child.name === target.name ? index : -1)
				.filter((index) => index >= 0);
			const position = siblingIndexes.indexOf(targetIndex);
			const siblingIndex = siblingIndexes[position + (direction === "previous" ? -1 : 1)];
			if (siblingIndex === undefined) {
				throw new Error(direction === "previous" ? "XML 节点已经在最前面。" : "XML 节点已经在最后面。");
			}
			const children = [...element.children];
			children[targetIndex] = children[siblingIndex]!;
			children[siblingIndex] = target;
			return {
				changed: true,
				element: clonePropertyXmlElement(element, element.attributes, children)
			};
		}
		for (const [index, child] of element.children.entries()) {
			if (!isPropertyXmlElement(child)) {
				continue;
			}
			const updated = move(child);
			if (!updated.changed || updated.element === undefined) {
				continue;
			}
			const children = [...element.children];
			children[index] = updated.element;
			return {
				changed: true,
				element: clonePropertyXmlElement(element, element.attributes, children)
			};
		}
		return { changed: false, element };
	};

	const updated = move(document.root);
	if (!updated.changed || updated.element === undefined) {
		throw new Error("XML 移动目标不属于当前文档：" + elementPath);
	}
	return { ...document, root: updated.element };
}

/** 收集指定名称的全部 XML 元素。 */
export function collectPropertyXmlElements(
	root: PropertyXmlElement,
	name?: string
): readonly PropertyXmlElement[] {
	const elements: PropertyXmlElement[] = [];
	/** 以文档顺序深度优先收集，供组件和属性投影稳定复用。 */
	const visit = (element: PropertyXmlElement): void => {
		if (name === undefined || element.name === name) {
			elements.push(element);
		}
		for (const child of getPropertyXmlChildren(element)) {
			visit(child);
		}
	};
	visit(root);
	return elements;
}
/** 把通用 XML 节点写入规范化 XML 文本。 */
function serializePropertyXmlNode(node: PropertyXmlNode, depth: number): string[] {
	const indentation = "\t".repeat(depth);
	if (node.nodeType === "text") {
		return node.value.length === 0 ? [""] : [indentation + escapeXml(node.value)];
	}

	const attributes = Object.entries(node.attributes)
		.map(([name, value]) => " " + name + "=\"" + escapeXml(value) + "\"")
		.join("");
	if (node.children.length === 0 && node.name !== "定义") {
		return [indentation + "<" + node.name + attributes + " />"];
	}
	return [
		indentation + "<" + node.name + attributes + ">",
		...node.children.flatMap((child) => serializePropertyXmlNode(child, depth + 1)),
		indentation + "</" + node.name + ">"
	];
}

/** 将一个 XML 元素及其完整子树序列化为不含声明的规范 XML。 */
export function serializePropertyXmlElement(element: PropertyXmlElement): string {
	return [
		...serializePropertyXmlNode(element, 0),
		""
	].join("\r\n");
}

/** 将通用属性模型序列化为不含 XML 声明的规范 XML。 */
export function serializePropertyXml(document: SimplePropertyXmlDocument): string {
	return [
		...serializePropertyXmlNode(document.root, 0),
		""
	].join("\r\n");
}

/** 把通用 XML 节点写回 Simple 属性代码。 */
function serializeSimplePropertyNode(
	node: PropertyXmlNode,
	depth: number,
	indentationUnit: string
): string[] {
	const indentation = indentationUnit.repeat(depth);
	if (node.nodeType === "text") {
		return node.value.length === 0 ? [""] : [indentation + node.value];
	}
	/** 在同一物理行恢复节点映射的 Simple 行尾注释。 */
	const withComment = (source: string): string => {
		const comment = node.attributes["注释"];
		return comment === undefined
			? source
			: source + " '" + (comment.length === 0 ? "" : " " + comment);
	};

	switch (node.name) {
		case "资源": {
			const unit = node.attributes["单元"];
			if (unit === undefined || unit.length === 0) {
				throw new Error("XML 资源节点缺少“单元”属性。");
			}
			return [withComment(indentation + "$资源 $" + unit)];
		}
		case "定义": {
			const name = node.attributes["名称"];
			const component = node.attributes["组件"];
			if (name === undefined || component === undefined) {
				throw new Error("XML 定义节点缺少“名称”或“组件”属性。");
			}
			return [
				withComment(indentation + "$定义 " + name + " $为 " + component),
				...node.children.flatMap(
					(child) => serializeSimplePropertyNode(child, depth + 1, indentationUnit)
				),
				indentation + "$结束 $定义"
			];
		}
		case "赋值": {
			const name = node.attributes["属性"];
			const value = node.attributes["值"];
			if (name === undefined || value === undefined) {
				throw new Error("XML 赋值节点缺少“属性”或“值”属性。");
			}
			return [withComment(indentation + name + " = " + value)];
		}
		case "注释": {
			const content = node.attributes["内容"];
			if (content === undefined) {
				throw new Error("XML 注释节点缺少“内容”属性。");
			}
			return [indentation + "'" + content];
		}
		case "未知": {
			const source = node.attributes["原文"];
			if (source === undefined) {
				throw new Error("XML 未知节点缺少“原文”属性。");
			}
			return [withComment(indentation + source)];
		}
		default:
			throw new Error("XML 节点“" + node.name + "”无法转换为 Simple 属性代码。");
	}
}

/** 将内存 XML 文档转换为完整 Simple 属性代码。 */
export function serializeSimplePropertySource(
	document: SimplePropertyXmlDocument,
	formatting: SimplePropertySourceFormatting = {
		indentation: "\t",
		lineEnding: "\r\n"
	}
): string {
	if (document.root.name !== "属性") {
		throw new Error("XML 属性文档根节点必须是“属性”。");
	}
	if (getSimplePropertyResourceUnit(document) === undefined) {
		throw new Error("XML 属性缺少资源单元名称。");
	}
	return [
		document.root.attributes["注释"] === undefined
			? "$属性"
			: "$属性 '" + (document.root.attributes["注释"].length === 0
				? ""
				: " " + document.root.attributes["注释"]),
		...document.root.children.flatMap(
			(node) => serializeSimplePropertyNode(node, 1, formatting.indentation)
		),
		"$结束 $属性",
		""
	].join(formatting.lineEnding);
}

/** 判断扫描到的资源名称是否是当前编译器支持的单元类型。 */
function isSimpleUnitType(value: string): value is SimpleUnitType {
	return value === "窗口"
		|| value === "对象"
		|| value === "接口"
		|| value === "服务";
}

/** 创建携带来源行号的临时节点数据。 */
function sourceTemporary(sourceLine: number): PropertyXmlTemporaryData {
	return new Map<PropertyKey, unknown>([["sourceLine", sourceLine]]);
}

/** 把属性代码行拆成语句和字符串之外的行尾注释。 */
function simplePropertyLineParts(sourceLine: string): {
	readonly comment?: string;
	readonly text: string;
} {
	const sourceWithoutComment = stripSimpleLineComment(sourceLine);
	return {
		...(sourceWithoutComment.length === sourceLine.length
			? {}
			: { comment: sourceLine.slice(sourceWithoutComment.length + 1).trim() }),
		text: sourceWithoutComment.trim()
	};
}

/** 把行尾注释映射为当前 XML 节点的“注释”属性。 */
function simplePropertyAttributes(
	attributes: Readonly<Record<string, string>>,
	comment: string | undefined
): Readonly<Record<string, string>> {
	return comment === undefined ? attributes : { ...attributes, "注释": comment };
}

/** 从完整 .simple 原文读取末尾属性区并生成通用 XML 文档。 */
export function inspectSimplePropertyXml(source: string): SimplePropertyXmlParseResult {
	const propertySectionStart = findPropertySectionStart(source);
	const propertySource = source.slice(propertySectionStart);
	if (propertySource.length === 0) {
		return {
			issues: ["没有找到完整的 $属性 与 $结束 $属性 属性区。"],
			status: "damaged"
		};
	}

	const firstLine = source.slice(0, propertySectionStart).split(/\r\n|\n|\r/u).length;
	const rootChildren: PropertyXmlNode[] = [];
	let root = createPropertyXmlElement("属性", {}, rootChildren, sourceTemporary(firstLine));
	const componentStack: PropertyXmlElement[] = [];
	const issues: string[] = [];
	const lineEnding = detectSimpleLineEnding(propertySource);
	const propertyLines = propertySource.split(/\r\n|\n|\r/u);
	let damaged = false;
	let resourceUnit: string | undefined;
	/** 新节点始终进入当前组件栈顶，栈为空时进入 XML 根节点。 */
	const appendNode = (node: PropertyXmlNode): void => {
		const parent = componentStack.at(-1) ?? root;
		(parent.children as PropertyXmlNode[]).push(node);
	};

	for (const [index, sourceLine] of propertyLines.entries()) {
		const line = firstLine + index;
		const sourceText = sourceLine.trim();
		if (sourceText.length === 0) {
			if (index < propertyLines.length - 1) {
				appendNode(createPropertyXmlText("", sourceTemporary(line)));
			}
			continue;
		}
		if (sourceText.startsWith("'")) {
			appendNode(createPropertyXmlElement(
				"注释",
				{ "内容": sourceLine.trimStart().slice(1) },
				[],
				sourceTemporary(line)
			));
			continue;
		}
		const { comment, text } = simplePropertyLineParts(sourceLine);
		if (text === "$属性") {
			root = clonePropertyXmlElement(root, simplePropertyAttributes(root.attributes, comment));
			continue;
		}
		if (text === "$结束 $属性") {
			continue;
		}

		const resourceMatch = /^\$资源\s+\$(\S+)$/u.exec(text);
		if (resourceMatch !== null) {
			resourceUnit = resourceMatch[1] ?? "";
			appendNode(createPropertyXmlElement(
				"资源",
				simplePropertyAttributes({ "单元": resourceUnit }, comment),
				[],
				sourceTemporary(line)
			));
			if (!isSimpleUnitType(resourceUnit)) {
				issues.push("第 " + line + " 行包含未知单元类型：" + resourceUnit);
				damaged = true;
			}
			continue;
		}

		const componentMatch = /^\$定义\s+(\S+)\s+\$为\s+(.+?)\s*$/u.exec(text);
		if (componentMatch !== null) {
			const component = createPropertyXmlElement(
				"定义",
				simplePropertyAttributes({
					"名称": componentMatch[1] ?? "",
					"组件": componentMatch[2] ?? ""
				}, comment),
				[],
				sourceTemporary(line)
			);
			appendNode(component);
			componentStack.push(component);
			continue;
		}

		if (text === "$结束 $定义") {
			const component = componentStack.pop();
			if (component === undefined) {
				issues.push("第 " + line + " 行存在没有起始定义的结束标记。");
				damaged = true;
				appendNode(createPropertyXmlElement(
					"未知",
					{ "原文": text },
					[],
					sourceTemporary(line)
				));
			}
			continue;
		}

		const assignmentMatch = /^([^=]+?)\s*=\s*(.*)$/u.exec(text);
		if (assignmentMatch !== null) {
			appendNode(createPropertyXmlElement(
				"赋值",
				simplePropertyAttributes({
					"属性": (assignmentMatch[1] ?? "").trim(),
					"值": assignmentMatch[2] ?? ""
				}, comment),
				[],
				sourceTemporary(line)
			));
			continue;
		}

		issues.push("第 " + line + " 行暂时无法识别。");
		appendNode(createPropertyXmlElement(
			"未知",
			simplePropertyAttributes({ "原文": text }, comment),
			[],
			sourceTemporary(line)
		));
	}

	if (resourceUnit === undefined) {
		issues.push("属性区没有 $资源 单元名称。");
		damaged = true;
	}
	if (componentStack.length > 0) {
		issues.push("有 " + componentStack.length + " 个组件定义没有结束标记。");
		damaged = true;
	}

	const status: PropertyXmlStatus = damaged
		? "damaged"
		: issues.length > 0 ? "warning" : "valid";
	const document: SimplePropertyXmlDocument = {
		issues,
		lineEnding,
		root,
		status
	};
	return { document, issues, status };
}

/** 从完整 .simple 原文读取可操作的通用 XML 属性文档。 */
export function parseSimplePropertyXml(source: string): SimplePropertyXmlDocument | undefined {
	return inspectSimplePropertyXml(source).document;
}
