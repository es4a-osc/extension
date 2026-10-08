/*
集中定义窗口 XML 中组件名称的合法性、全局唯一性和设计器稳定定位规则。
xhwsd@qq.com 2026-9-17
*/

import { buildCompilerTokenRules, buildDocumentTokenRules } from "./compilerTokens";
import {
	collectPropertyXmlElements,
	findPropertyXmlElementPath,
	getPropertyXmlAttribute,
	resolvePropertyXmlElement,
	type PropertyXmlElement,
	type SimplePropertyXmlDocument
} from "./propertyXml";
import type { Sdk } from "./sdk";

/** 设计器采用的 Simple 标识符安全子集；不会接受编译器明确禁止的 `_`、`$` 起始名称。 */
const SIMPLE_COMPONENT_NAME = /^\p{L}[\p{L}\p{N}_]*$/u;

/** Webview 发回的组件身份；路径只是本次投影坐标，名称才是窗口内稳定身份。 */
export interface DesignerComponentIdentity {
	readonly componentName: string;
	readonly xmlPath: string;
}

/** 已解析并重新取得当前 XML 路径的组件身份。 */
export interface ResolvedDesignerComponentIdentity extends DesignerComponentIdentity {
	readonly element: PropertyXmlElement;
}

/** 返回组件名称的语法或关键字错误；`undefined` 表示可作为 Simple 标识符。 */
export function componentNameValidationError(name: string, sdk?: Sdk): string | undefined {
	if (name.length === 0) return "组件名称不能为空。";
	if (name !== name.trim()) return "组件名称前后不能包含空白字符。";
	if (!SIMPLE_COMPONENT_NAME.test(name)) {
		return "组件名称必须以字母开头，并且只能包含字母、数字和下划线。";
	}
	if (buildCompilerTokenRules(sdk).some((rule) => rule.text === name)) {
		return `“${name}”是 Simple 关键字或保留字，不能作为组件名称。`;
	}
	return undefined;
}

/** 检查整个窗口定义树；嵌套容器不形成独立命名空间。 */
export function inspectDesignerComponentNames(
	document: SimplePropertyXmlDocument,
	sdk?: Sdk
): readonly string[] {
	const issues: string[] = [];
	const pathsByName = new Map<string, string[]>();
	for (const element of collectPropertyXmlElements(document.root, "定义")) {
		const path = findPropertyXmlElementPath(document, element) ?? "未知路径";
		const name = getPropertyXmlAttribute(element, "名称");
		if (name === undefined) {
			issues.push(`组件定义缺少名称：${path}`);
			continue;
		}
		const validationError = componentNameValidationError(name, sdk);
		if (validationError !== undefined) issues.push(`${validationError}（${path}）`);
		const paths = pathsByName.get(name) ?? [];
		paths.push(path);
		pathsByName.set(name, paths);
	}
	for (const [name, paths] of pathsByName) {
		if (paths.length > 1) {
			issues.push(`组件名称重复：“${name}”（${paths.join("、")}）`);
		}
	}
	return issues;
}

/** 在任何设计器操作前拒绝名称损坏的窗口，避免路径继续命中错误组件。 */
export function assertDesignerComponentNames(
	document: SimplePropertyXmlDocument,
	sdk?: Sdk
): void {
	const issues = inspectDesignerComponentNames(document, sdk);
	if (issues.length > 0) throw new Error(issues.join("；"));
}

/** 汇总当前 XML 名称和用户代码已声明标识符，供新增与粘贴统一避让。 */
export function collectUnavailableComponentNames(
	document: SimplePropertyXmlDocument,
	userCode = ""
): Set<string> {
	return new Set([
		...collectPropertyXmlElements(document.root, "定义")
			.map((element) => getPropertyXmlAttribute(element, "名称"))
			.filter((name): name is string => name !== undefined),
		...buildDocumentTokenRules(userCode).map((rule) => rule.text)
	]);
}

/**
 * 按窗口内唯一名称重新定位组件。
 *
 * 消息路径可以因兄弟插入或移动而变化；名称索引确认唯一后，以当前 XML 中的新路径为准。
 */
export function resolveDesignerComponentIdentity(
	document: SimplePropertyXmlDocument,
	identity: DesignerComponentIdentity,
	sdk?: Sdk
): ResolvedDesignerComponentIdentity {
	assertDesignerComponentNames(document, sdk);
	const matches = collectPropertyXmlElements(document.root, "定义").filter(
		(element) => getPropertyXmlAttribute(element, "名称") === identity.componentName
	);
	if (matches.length !== 1) {
		throw new Error(`组件“${identity.componentName}”已经不存在，请按当前设计器内容重试。`);
	}
	const element = matches[0];
	if (element === undefined) {
		throw new Error(`组件“${identity.componentName}”已经不存在，请按当前设计器内容重试。`);
	}
	const xmlPath = findPropertyXmlElementPath(document, element);
	if (xmlPath === undefined) throw new Error(`无法定位组件“${identity.componentName}”。`);
	const pathElement = resolvePropertyXmlElement(document, identity.xmlPath);
	if (
		pathElement?.name === "定义"
		&& getPropertyXmlAttribute(pathElement, "名称") === identity.componentName
	) {
		return { componentName: identity.componentName, element: pathElement, xmlPath: identity.xmlPath };
	}
	return { componentName: identity.componentName, element, xmlPath };
}
