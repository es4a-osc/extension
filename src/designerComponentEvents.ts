/*
从 SDK 事件元数据建立组件事件菜单，并解析或生成用户代码中的事件处理过程。
xhwsd@qq.com 2026-8-30
*/

import { analyzeSimpleSourceSyntax } from "./simpleSourceSyntax";
import {
	collectPropertyXmlElements,
	findPropertyXmlElementPath,
	getPropertyXmlAttribute,
	resolvePropertyXmlElement,
	type SimplePropertyXmlDocument
} from "./propertyXml";
import {
	buildDefinitionIndex,
	getEffectiveMembers,
	type LibraryMember,
	type Sdk
} from "./sdk";

/** 设计器组件菜单中的一项 SDK 事件。 */
export interface DesignerComponentEventItem {
	readonly description?: string;
	readonly existing: boolean;
	readonly name: string;
}

/** 一个真实 XML 组件对应的有序事件菜单。 */
export interface DesignerComponentEventGroup {
	readonly events: readonly DesignerComponentEventItem[];
	readonly xmlPath: string;
}

/** 激活事件菜单项后需要执行的用户代码操作。 */
export interface DesignerComponentEventAction {
	readonly caretOffset: number;
	readonly existing: boolean;
	readonly insertionText?: string;
}

/** 从用户代码中识别出的组件事件声明及事件主体光标位置。 */
interface SimpleComponentEventHandler {
	readonly bodyOffset: number;
	readonly componentName: string;
	readonly eventName: string;
	readonly offset: number;
}

/** 事件菜单与签名、引用共用逻辑语句声明，不以物理行或单独正则判断。 */
function collectSimpleComponentEventHandlers(userCode: string): readonly SimpleComponentEventHandler[] {
	return analyzeSimpleSourceSyntax(userCode).declarations.flatMap((declaration) => declaration.kind !== "event" || declaration.owner === undefined ? [] : [{
		bodyOffset: declaration.bodyOffset ?? userCode.length,
		componentName: declaration.owner, eventName: declaration.name, offset: declaration.statementStart
	}]);
}

/** 查找用户代码中组件与事件名称都完全一致的事件处理过程。 */
export function findSimpleComponentEventHandler(
	userCode: string,
	componentName: string,
	eventName: string
): number | undefined {
	return collectSimpleComponentEventHandlers(userCode).find((handler) => (
		handler.componentName === componentName && handler.eventName === eventName
	))?.offset;
}

/** 从编译器清单读取所有 Simple 对象共有的预定义事件。 */
function compilerObjectEvents(sdk: Sdk): readonly LibraryMember[] {
	const compiler = sdk.manifests.find((manifest) => manifest.kind === "compiler");
	const objectDefinition = compiler?.categories
		.flatMap((category) => category.definitions)
		.find((definition) => definition.name === "对象" && definition.kind === "type");
	return objectDefinition?.events ?? [];
}

/**
 * 以编译器对象事件为缺省项，再用组件继承链中的同名事件覆盖说明和参数。
 *
 * 正常继承已经包含对象事件时不会重复；旧运行库没有声明对象继承时仍能显示预定义事件。
 */
function mergeComponentEvents(
	defaultEvents: readonly LibraryMember[],
	effectiveEvents: readonly LibraryMember[]
): readonly LibraryMember[] {
	const events = [...defaultEvents];
	const positions = new Map(events.map((event, index) => [event.name, index]));
	for (const event of effectiveEvents) {
		const position = positions.get(event.name);
		if (position === undefined) {
			positions.set(event.name, events.length);
			events.push(event);
		} else {
			events[position] = event;
		}
	}
	return events;
}

/** 返回 XML 定义所引用的 SDK 组件及其继承后的事件。 */
function componentEvents(
	document: SimplePropertyXmlDocument,
	definitions: ReturnType<typeof buildDefinitionIndex>,
	defaultEvents: readonly LibraryMember[],
	xmlPath: string
): { readonly componentName: string; readonly events: readonly LibraryMember[] } | undefined {
	const element = resolvePropertyXmlElement(document, xmlPath);
	if (element?.name !== "定义") return undefined;
	const componentName = getPropertyXmlAttribute(element, "名称");
	const componentType = getPropertyXmlAttribute(element, "组件");
	if (componentName === undefined || componentType === undefined) return undefined;
	const definition = definitions.get(componentType);
	if (definition === undefined) return undefined;
	const effectiveEvents = getEffectiveMembers(definition, "events", definitions)
		.map((item) => item.member);
	return {
		componentName,
		events: mergeComponentEvents(defaultEvents, effectiveEvents)
	};
}

/** 为当前 XML 中全部有事件的组件建立动态菜单投影。 */
export function createDesignerComponentEventGroups(
	document: SimplePropertyXmlDocument | undefined,
	sdk: Sdk | undefined,
	userCode: string
): readonly DesignerComponentEventGroup[] {
	if (document === undefined || document.status === "damaged" || sdk === undefined) return [];
	const handlers = collectSimpleComponentEventHandlers(userCode);
	const definitions = buildDefinitionIndex(sdk.manifests);
	const defaultEvents = compilerObjectEvents(sdk);
	const groups: DesignerComponentEventGroup[] = [];
	for (const element of collectPropertyXmlElements(document.root, "定义")) {
		const xmlPath = findPropertyXmlElementPath(document, element);
		if (xmlPath === undefined) continue;
		const component = componentEvents(document, definitions, defaultEvents, xmlPath);
		if (component === undefined || component.events.length === 0) continue;
		groups.push({
			events: component.events.map((event) => ({
				description: event.description,
				existing: handlers.some((handler) => (
					handler.componentName === component.componentName && handler.eventName === event.name
				)),
				name: event.name
			})),
			xmlPath
		});
	}
	return groups;
}

/** 按 Simple 语法生成 SDK 事件的有序参数表。 */
function formatEventParameters(event: LibraryMember): string {
	return (event.params ?? []).map((parameter) => (
		(parameter.byRef === true ? "传址 " : "")
		+ parameter.name
		+ " 为 "
		+ (parameter.type ?? "变体型")
	)).join(", ");
}

/** 保证非空源码与新事件声明之间至少保留一个完整空白分隔行。 */
function eventInsertionPrefix(userCode: string, lineEnding: string): string {
	if (userCode.length === 0) return "";
	const trailingWhitespaceLines = userCode.match(/(?:(?:\r\n|\n|\r)[\t ]*)+$/u)?.[0];
	const trailingLineEndingCount = trailingWhitespaceLines?.match(/\r\n|\n|\r/gu)?.length ?? 0;
	if (trailingLineEndingCount >= 2) return "";
	if (trailingLineEndingCount === 1) return lineEnding;
	return lineEnding + lineEnding;
}

/** 解析事件菜单动作；已有处理过程只定位，缺失处理过程在用户代码末尾生成。 */
export function resolveDesignerComponentEventAction(
	document: SimplePropertyXmlDocument,
	sdk: Sdk | undefined,
	userCode: string,
	xmlPath: string,
	eventName: string,
	lineEnding = document.lineEnding
): DesignerComponentEventAction {
	if (document.status === "damaged" || sdk === undefined) {
		throw new Error("当前单元没有可安全读取的组件事件元数据。");
	}
	const definitions = buildDefinitionIndex(sdk.manifests);
	const component = componentEvents(
		document,
		definitions,
		compilerObjectEvents(sdk),
		xmlPath
	);
	const event = component?.events.find((candidate) => candidate.name === eventName);
	if (component === undefined || event === undefined) {
		throw new Error("当前组件不存在事件：" + eventName);
	}
	const existingHandler = collectSimpleComponentEventHandlers(userCode).find((handler) => (
		handler.componentName === component.componentName && handler.eventName === event.name
	));
	if (existingHandler !== undefined) {
		return { caretOffset: existingHandler.bodyOffset, existing: true };
	}
	const eol = lineEnding === "\r\n" ? "\r\n" : "\n";
	const prefix = eventInsertionPrefix(userCode, eol);
	const declaration = `事件 ${component.componentName}.${event.name}(${formatEventParameters(event)})`;
	const insertionText = prefix + declaration + eol + "\t" + eol + "结束 事件";
	return {
		caretOffset: userCode.length + prefix.length + declaration.length + eol.length + 1,
		existing: false,
		insertionText
	};
}
