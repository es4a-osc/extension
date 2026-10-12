/*
统一校验 XML 属性操作，通过组件改名事件准备关联代码，并交给共享文档事务提交。
xhwsd@qq.com 2026-10-10
*/

import * as vscode from "vscode";
import { resolveDesignerComponentIdentity } from "./componentIdentity";
import { createSimpleDesignerModel, findDesignerComponentNode } from "./designerModel";
import { updatePropertyPanelValue, type PropertyPanelValueRequest } from "./propertyPanel";
import { getPropertyXmlAttribute, resolvePropertyXmlElement, type SimplePropertyXmlDocument } from "./propertyXml";
import type { SimpleUnitChange } from "./refactoringModel";
import type { Sdk } from "./sdk";
import { toSimpleCodeUri, type RelatedSimpleCodeEdit } from "./simpleCodeFileSystem";
import { sameFilePath } from "./simpleProjectPaths";
import type { SimpleProjectSemanticContext } from "./simpleUnitSymbols";

/** 改名事件在提交前等待关联同步完成；处理器只返回修改计划，不提前写入 XML 或代码。 */
export interface SimpleComponentRenameEvent {
	readonly sourceFile: string;
	readonly xmlPath: string;
	readonly oldName: string;
	readonly newName: string;
}

export interface SimplePropertyOperationResult {
	readonly propertyDocument: SimplePropertyXmlDocument;
	readonly userCode: string;
	readonly relatedCode: readonly RelatedSimpleCodeEdit[];
	readonly rename?: SimpleComponentRenameEvent;
}

/** VS Code 适配器提供共享会话和事务提交，不把界面选择状态引入属性操作规则。 */
export interface SimplePropertyOperationContext {
	readonly codeDocument: vscode.TextDocument;
	readonly propertyDocument: SimplePropertyXmlDocument;
	readonly sourceFile: string;
	readonly unitName: string;
	readonly sdk: Sdk | undefined;
	readonly semanticContext?: SimpleProjectSemanticContext;
	synchronizeComponentReferences(): boolean;
	onComponentRename?: (event: SimpleComponentRenameEvent) => Promise<readonly SimpleUnitChange[]>;
	commit(result: SimplePropertyOperationResult): Promise<void>;
}

/** 名称校验、模型操作和关联同步均成功后才进入一次共享事务，失败不提交半次修改。 */
export async function executeSimplePropertyOperation(context: SimplePropertyOperationContext, request: PropertyPanelValueRequest): Promise<boolean> {
	const { codeDocument, propertyDocument, sdk } = context;
	const userCode = codeDocument.getText();
	const selectedPath = request.selectedComponentName === undefined ? request.selectedXmlPath
		: resolveDesignerComponentIdentity(propertyDocument, { componentName: request.selectedComponentName, xmlPath: request.selectedXmlPath }, sdk).xmlPath;
	const projection = createSimpleDesignerModel(propertyDocument, sdk, selectedPath);
	if (projection.root !== undefined && findDesignerComponentNode(projection.root, selectedPath)?.layoutReadOnly === true) {
		throw new Error("当前布局尚未适配，只能查看和复制其中的组件。");
	}
	const synchronize = context.synchronizeComponentReferences();
	const projectRename = request.effect === "renameComponent" && synchronize && context.onComponentRename !== undefined;
	let updated = updatePropertyPanelValue(userCode, propertyDocument, sdk, context.unitName, request, context.semanticContext, synchronize && !projectRename);
	if (updated.propertyDocument === propertyDocument && updated.userCode === userCode) return false;
	const oldName = getPropertyXmlAttribute(resolvePropertyXmlElement(propertyDocument, selectedPath), "名称");
	const rename = request.effect === "renameComponent" && oldName !== undefined
		? { sourceFile: context.sourceFile, xmlPath: selectedPath, oldName, newName: request.value.trim() } : undefined;
	const relatedCode: RelatedSimpleCodeEdit[] = [];
	if (projectRename && rename !== undefined && context.onComponentRename !== undefined) {
		let ownerPlanned = false;
		for (const change of await context.onComponentRename(rename)) {
			if (sameFilePath(change.unit.filePath, context.sourceFile)) {
				if (change.unit.userCode !== userCode) throw new Error("代码已变化，请重试组件改名。");
				if (change.propertyDocument === undefined) throw new Error("组件属性状态不可用。");
				updated = { propertyDocument: change.propertyDocument, userCode: change.userCode };
				ownerPlanned = true;
				continue;
			}
			if (change.userCode === change.unit.userCode) continue;
			const document = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(change.unit.filePath)));
			if (document.getText() !== change.unit.userCode) throw new Error("关联代码已变化，请重试组件改名。");
			relatedCode.push({ document, before: change.unit.userCode, after: change.userCode });
		}
		// 未注册项目的独立单元仍同步本地引用，只有缺少项目计划时才执行此分支。
		if (!ownerPlanned) updated = updatePropertyPanelValue(userCode, propertyDocument, sdk, context.unitName, request, undefined, true);
	}
	if (rename !== undefined && synchronize && !context.synchronizeComponentReferences()) {
		updated = updatePropertyPanelValue(userCode, propertyDocument, sdk, context.unitName, request, undefined, false);
		relatedCode.length = 0;
	}
	if (codeDocument.getText() !== userCode) throw new Error("代码已变化，请重试属性修改。");
	await context.commit({ ...updated, relatedCode, rename });
	return true;
}
