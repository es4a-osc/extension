/*
校验设计器属性面板消息，并按 XML 路径计算属性修改。
xhwsd@qq.com 2026-8-29
*/

import { resolveDesignerComponentIdentity } from "./componentIdentity";
import { renameSimpleComponent } from "./componentRename";
import { ensureSimpleDesignerRelativeAnchorOrder } from "./designerModel";
import { unresolvedPropertySymbolExpression } from "./propertyExpressionValidation";
import {
	createPropertyPanelModel,
	type PropertyPanelChoice,
	type PropertyPanelEditTarget,
	type PropertyPanelRow
} from "./propertyPanelModel";
import {
	createPropertyXmlAttributePath,
	getPropertyXmlAttribute,
	getPropertyXmlChildren,
	removePropertyXmlElement,
	resolvePropertyXmlElement,
	writePropertyXmlValue,
	type SimplePropertyXmlDocument
} from "./propertyXml";
import type { Sdk } from "./sdk";
import type { SimpleProjectSemanticContext } from "./simpleUnitSymbols";

/** 属性输入包含无法从当前 SDK 或项目语义索引解析的原子符号。 */
export class PropertyPanelSymbolValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PropertyPanelSymbolValidationError";
	}
}

/** Webview 属性编辑提交给 XML 事务边界的完整请求。 */
export interface PropertyPanelValueRequest {
	readonly contextToken: string;
	readonly effect?: "editComponentComment" | "renameComponent";
	readonly removeElementWhenEmpty: boolean;
	readonly renderVersion: number;
	readonly selectedComponentName?: string;
	readonly selectedXmlPath: string;
	readonly type: "updateXmlValue";
	readonly value: string;
	readonly xmlPath: string;
}

/** 拒绝 Webview 发送的非预期 XML 路径置值消息。 */
export function isPropertyPanelValueRequest(message: unknown): message is PropertyPanelValueRequest {
	if (typeof message !== "object" || message === null) {
		return false;
	}
	const candidate = message as Record<string, unknown>;
	return candidate.type === "updateXmlValue"
		&& typeof candidate.contextToken === "string"
		&& Number.isSafeInteger(candidate.renderVersion)
		&& (candidate.renderVersion as number) >= 0
		&& typeof candidate.xmlPath === "string"
		&& candidate.xmlPath.startsWith("/")
		&& typeof candidate.value === "string"
		&& typeof candidate.removeElementWhenEmpty === "boolean"
		&& (
			candidate.selectedComponentName === undefined
			|| typeof candidate.selectedComponentName === "string" && candidate.selectedComponentName.length > 0
		)
		&& typeof candidate.selectedXmlPath === "string"
		&& candidate.selectedXmlPath.startsWith("/")
		&& (
			candidate.effect === undefined
			|| candidate.effect === "editComponentComment"
			|| candidate.effect === "renameComponent"
		);
}

interface PermittedPropertyEdit {
	readonly allowCustomValue?: boolean;
	readonly choices?: readonly PropertyPanelChoice[];
	readonly row: PropertyPanelRow;
	readonly target: PropertyPanelEditTarget;
}

/** 返回属性行实际允许提交的编辑目标。 */
function permittedPropertyEdits(row: PropertyPanelRow): readonly PermittedPropertyEdit[] {
	if (row.editTarget === undefined) return [];
	return [{
		allowCustomValue: row.allowCustomValue,
		choices: row.choices,
		row,
		target: row.editTarget
	}];
}

/** 组件路径因并发重命名被重新解析时，同步换算该组件下的属性路径。 */
function remapSelectedPath(path: string, requestedSelectedPath: string, currentSelectedPath: string): string {
	return path.startsWith(requestedSelectedPath)
		? currentSelectedPath + path.slice(requestedSelectedPath.length)
		: path;
}

/** 按属性框许可模型校验并计算一次 XML 属性修改。 */
export function updatePropertyPanelValue(
	userCode: string,
	propertyDocument: SimplePropertyXmlDocument,
	sdk: Sdk | undefined,
	unitName: string | undefined,
	request: PropertyPanelValueRequest,
	semanticContext?: SimpleProjectSemanticContext
): {
	readonly propertyDocument: SimplePropertyXmlDocument;
	readonly selectedPath?: string;
	readonly userCode: string;
} {
	const selected = request.selectedComponentName === undefined
		? undefined
		: resolveDesignerComponentIdentity(propertyDocument, {
			componentName: request.selectedComponentName,
			xmlPath: request.selectedXmlPath
		}, sdk);
	const selectedNode = selected?.element ?? resolvePropertyXmlElement(propertyDocument, request.selectedXmlPath);
	if (selectedNode === undefined) throw new Error("单元树选择已经变化，请按当前选择重试。");
	const selectedPath = selected?.xmlPath ?? request.selectedXmlPath;
	const currentXmlPath = remapSelectedPath(request.xmlPath, request.selectedXmlPath, selectedPath);
	const model = createPropertyPanelModel(propertyDocument, selectedNode, sdk, unitName);
	const pathMatches = model.groups.flatMap((group) => group.rows)
		.flatMap(permittedPropertyEdits)
		.filter((edit) => (
			edit.target.xmlPath === currentXmlPath
				&& edit.target.effect === request.effect
				&& (edit.target.removeElementWhenEmpty === true) === request.removeElementWhenEmpty
		));
	if (pathMatches.length === 0) {
		throw new Error("该 XML 路径已经变化或当前不可编辑，请刷新后重试。");
	}
	const permittedEdit = pathMatches.find((edit) => (
		request.value.length === 0
		|| edit.choices === undefined
		|| edit.allowCustomValue === true
		|| edit.choices.some((choice) => choice.value === request.value)
	));
	if (permittedEdit === undefined) {
		throw new Error("该值不在属性允许选择的常量中。");
	}
	const permittedRow = permittedEdit.row;

	if (request.effect === "renameComponent") {
		if (selected === undefined) throw new Error("当前选择不是可重命名组件。");
		return renameSimpleComponent(
			userCode,
			propertyDocument,
			selectedPath,
			request.value,
			sdk
		);
	}

	const choiceValue = permittedEdit.choices?.some((choice) => choice.value === request.value) === true;
	const unresolvedSymbol = request.effect === "editComponentComment"
		|| request.value.length === 0 || choiceValue || semanticContext === undefined
		? undefined
		: unresolvedPropertySymbolExpression(request.value, sdk, semanticContext);
	if (unresolvedSymbol !== undefined) {
		const owner = model.title ?? unitName ?? "当前组件";
		throw new PropertyPanelSymbolValidationError(
			`${owner}.${permittedRow.name}：找不到常量、资源或函数“${unresolvedSymbol}”`
		);
	}

	let updatedDocument = writePropertyXmlValue(
		propertyDocument,
		currentXmlPath,
		request.value,
		{
			removeAttributeWhenEmpty: request.effect === "editComponentComment",
			removeElementWhenEmpty: request.removeElementWhenEmpty
		}
	);
	if (permittedRow.name === "布局") {
		const layoutPropertyNames = getPropertyXmlChildren(selectedNode, "赋值")
			.map((property) => getPropertyXmlAttribute(property, "属性"))
			.filter((name): name is string => name?.startsWith("布局.") === true);
		for (const name of layoutPropertyNames) {
			const valuePath = createPropertyXmlAttributePath(
				selectedPath,
				"赋值",
				"属性",
				name,
				"值"
			);
			updatedDocument = removePropertyXmlElement(
				updatedDocument,
				valuePath.slice(0, -"/@值".length)
			);
		}
	}
	const ordered = ensureSimpleDesignerRelativeAnchorOrder(
		updatedDocument,
		sdk,
		selectedPath,
		permittedRow.name
	);
	return { propertyDocument: ordered.document, selectedPath: ordered.selectedPath, userCode };
}
