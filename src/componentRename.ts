/*
协调 XML 组件名称、兄弟锚点表达式与用户代码组件引用的同步更新。
xhwsd@qq.com 2026-8-28
*/

import {
	buildDocumentTokenRules,
	tokenizeSimpleText,
	type SimpleSemanticTokenSpan
} from "./compilerTokens";
import {
	assertDesignerComponentNames,
	componentNameValidationError
} from "./componentIdentity";
import {
	collectPropertyXmlElements,
	findPropertyXmlElementPath,
	getPropertyXmlAttribute,
	getPropertyXmlChildren,
	resolvePropertyXmlElement,
	writePropertyXmlValue,
	type PropertyXmlElement,
	type SimplePropertyXmlDocument
} from "./propertyXml";
import {
	buildDefinitionIndex,
	getEffectivePropertyByProjection,
	getEffectiveMembers,
	type LibraryDefinitionReference,
	type Sdk
} from "./sdk";
import { filePathKey } from "./simpleProjectPaths";
import { createSimpleSourceAnalysis, resolveSimpleBinding } from "./completionModel";
import { findSimpleDefinition } from "./definitionModel";
import { refactoringContext, simpleIdentifierSpans, applySimpleCodeChanges, planSimpleSymbolRename, type RefactoringUnit, type SimpleUnitChange } from "./refactoringModel";

/** 组件改名后返回的用户代码与 XML 属性文档。 */
export interface SimpleComponentRenameResult {
	readonly propertyDocument: SimplePropertyXmlDocument;
	readonly userCode: string;
}

/** 返回目标定义的直接父定义；窗口根定义没有兄弟锚点。 */
function findDirectParentDefinition(
	root: PropertyXmlElement,
	target: PropertyXmlElement
): PropertyXmlElement | undefined {
	for (const child of getPropertyXmlChildren(root)) {
		if (child === target) return root.name === "定义" ? root : undefined;
		const parent = findDirectParentDefinition(child, target);
		if (parent !== undefined) return parent;
	}
	return undefined;
}

/** 返回组件定义中由 simple.anchor 声明的锚点属性名称。 */
function anchorPropertyNames(
	componentType: string,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): ReadonlySet<string> {
	const definition = definitions.get(componentType);
	if (definition === undefined) return new Set();
	return new Set(
		getEffectiveMembers(definition, "properties", definitions)
			.filter((property) => property.member.editor === "simple.anchor")
			.map((property) => property.member.name)
	);
}

/** 同步直接兄弟组件中由 SDK 标记的锚点表达式，不改写其它 XML 值。 */
function renameSiblingAnchorReferences(
	document: SimplePropertyXmlDocument,
	component: PropertyXmlElement,
	oldName: string,
	newName: string,
	sdk: Sdk | undefined
): SimplePropertyXmlDocument {
	if (sdk === undefined) return document;
	const parent = findDirectParentDefinition(document.root, component);
	if (parent === undefined) return document;
	const definitions = buildDefinitionIndex(sdk.manifests);
	const componentType = getPropertyXmlAttribute(component, "组件") ?? "";
	const idPropertyName = getEffectivePropertyByProjection(
		definitions.get(componentType),
		"id",
		definitions
	)?.member.name;
	if (idPropertyName === undefined) return document;
	const oldExpression = `${oldName}.${idPropertyName}`;
	const newExpression = `${newName}.${idPropertyName}`;
	const valuePaths: string[] = [];

	for (const sibling of getPropertyXmlChildren(parent, "定义")) {
		if (sibling === component) continue;
		const componentType = getPropertyXmlAttribute(sibling, "组件") ?? "";
		const anchorNames = anchorPropertyNames(componentType, definitions);
		if (anchorNames.size === 0) continue;
		for (const property of getPropertyXmlChildren(sibling, "赋值")) {
			if (
				!anchorNames.has(getPropertyXmlAttribute(property, "属性") ?? "")
				|| getPropertyXmlAttribute(property, "值") !== oldExpression
			) {
				continue;
			}
			const propertyPath = findPropertyXmlElementPath(document, property);
			if (propertyPath !== undefined) valuePaths.push(`${propertyPath}/@值`);
		}
	}

	return valuePaths.reduce(
		(updated, valuePath) => writePropertyXmlValue(updated, valuePath, newExpression),
		document
	);
}

/** 将语义令牌的行列位置换算为字符串偏移。 */
function tokenOffset(source: string, token: SimpleSemanticTokenSpan): number {
	let line = 0;
	let lineStart = 0;
	while (line < token.line) {
		const lineEnd = source.indexOf("\n", lineStart);
		if (lineEnd < 0) {
			return source.length;
		}
		lineStart = lineEnd + 1;
		line += 1;
	}
	return lineStart + token.character;
}

/** 只替换用户代码中的完整标识符，字符串和注释由公共词法扫描器自动跳过。 */
export function renameSimpleCodeIdentifiers(source: string, oldName: string, newName: string): string {
	const tokens = tokenizeSimpleText(source, [{ text: oldName, type: "variable" }]);
	let updated = source;
	for (const token of [...tokens].reverse()) {
		const start = tokenOffset(source, token);
		updated = updated.slice(0, start) + newName + updated.slice(start + token.length);
	}
	return updated;
}

/** 按 XML 路径修改组件名称；启用关联同步时处理兄弟锚点和用户代码引用。 */
export function renameSimpleComponent(
	userCode: string,
	propertyDocument: SimplePropertyXmlDocument,
	componentPath: string,
	requestedName: string,
	sdk?: Sdk,
	synchronizeReferences = true
): SimpleComponentRenameResult {
	assertDesignerComponentNames(propertyDocument, sdk);
	const component = resolvePropertyXmlElement(propertyDocument, componentPath);
	if (component?.name !== "定义") {
		throw new Error("选中的 XML 节点已经变化，请重新选择组件后再修改名称。");
	}
	const oldName = getPropertyXmlAttribute(component, "名称");
	if (oldName === undefined) {
		throw new Error("选中的 XML 定义节点缺少名称。");
	}

	const newName = requestedName.trim();
	const validationError = componentNameValidationError(newName, sdk);
	if (validationError !== undefined) throw new Error(validationError);
	if (newName === oldName) {
		return { propertyDocument, userCode };
	}
	if (collectPropertyXmlElements(propertyDocument.root, "定义").some(
		(candidate) => candidate !== component && getPropertyXmlAttribute(candidate, "名称") === newName
	)) {
		throw new Error("XML 属性已经存在名为“" + newName + "”的组件。");
	}

	const documentRules = buildDocumentTokenRules(userCode);
	if (documentRules.some((rule) => rule.text === newName)) {
		throw new Error("用户代码区已经声明标识符“" + newName + "”，不能作为组件名称。");
	}
	// 关闭同步仍执行名称校验，只修改所选 XML 定义，不改代码和兄弟锚点。
	if (!synchronizeReferences) return {
		propertyDocument: writePropertyXmlValue(propertyDocument, componentPath + "/@名称", newName),
		userCode
	};
	const unit = {
		filePath: "当前单元.simple", sourceRoot: ".", userCode,
		property: { document: propertyDocument, status: propertyDocument.status, issues: propertyDocument.issues }
	};
	const context = refactoringContext(unit, [unit]);
	const analysis = createSimpleSourceAnalysis(userCode, sdk, context);
	const references = simpleIdentifierSpans(userCode).filter((span) => span.name === oldName
		&& findSimpleDefinition(userCode, span.start, sdk, context, analysis)?.propertySource === true);
	for (const span of references) {
		if (resolveSimpleBinding(userCode, span.start, newName, context, analysis) !== undefined) throw new Error("新组件名称会遮蔽已有代码绑定。");
	}

	const anchorUpdatedDocument = renameSiblingAnchorReferences(
		propertyDocument,
		component,
		oldName,
		newName,
		sdk
	);
	return {
		propertyDocument: writePropertyXmlValue(
			anchorUpdatedDocument,
			componentPath + "/@名称",
			newName
		),
		userCode: applySimpleCodeChanges(userCode, references.map((span) => ({ ...span, replacement: newName })))
	};
}


/** 设计器组件改名的全项目引用计划，自身 XML 和锚点仍由组件模型负责。 */
export function planSimpleComponentProjectRename(units: readonly RefactoringUnit[], owner: RefactoringUnit, componentPath: string, newName: string, sdk: Sdk | undefined): readonly SimpleUnitChange[] {
	const property = owner.property.document;
	if (property === undefined || owner.property.status === "damaged") throw new Error("组件属性状态不可用。");
	const component = resolvePropertyXmlElement(property, componentPath);
	const oldName = component === undefined ? undefined : getPropertyXmlAttribute(component, "名称");
	if (oldName === undefined) throw new Error("组件已不存在，请重新选择。");
	const renamed = renameSimpleComponent(owner.userCode, property, componentPath, newName, sdk);
	if (renamed.propertyDocument === property) return [];
	let changes: SimpleUnitChange[] = [];
	for (const unit of units) {
		const candidates = simpleIdentifierSpans(unit.userCode).filter((span) => span.name === oldName);
		if (candidates.length === 0) continue;
		const context = refactoringContext(unit, units);
		const analysis = createSimpleSourceAnalysis(unit.userCode, sdk, context);
		const span = candidates.find((span) => {
			const target = findSimpleDefinition(unit.userCode, span.start, sdk, context, analysis);
			return target?.propertySource === true && target.filePath !== undefined && filePathKey(target.filePath) === filePathKey(owner.filePath);
		});
		if (span !== undefined) { changes = [...planSimpleSymbolRename(units, unit, span.start, newName, sdk)]; break; }
	}
	return [...changes.filter((change) => change.unit !== owner), { unit: owner, userCode: changes.find((change) => change.unit === owner)?.userCode ?? renamed.userCode, propertyDocument: renamed.propertyDocument, edits: [] }];
}
