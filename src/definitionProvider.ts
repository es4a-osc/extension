/*
把编辑器中立的 Simple 声明解析结果适配为 VS Code 定义跳转。
xhwsd@qq.com 2026-9-1
*/

import * as vscode from "vscode";
import { findSimpleDefinition, type SimpleDefinitionTarget } from "./definitionModel";
import type { LibrarySymbolTarget } from "./librarySymbol";
import type { Sdk } from "./sdk";
import type { SimpleProjectSemanticContext } from "./simpleUnitSymbols";
import { toSimpleCodeUri } from "./simpleCodeFileSystem";
import { toUnitContentPreviewUri } from "./unitPreview";

/** 为变量、别名、单元、继承成员和项目资源提供定义跳转。 */
export class SimpleDefinitionProvider implements vscode.DefinitionProvider {
	private sdk: Sdk | undefined;

	constructor(
		private readonly readSource: (document: vscode.TextDocument) => string = (document) => document.getText(),
		private readonly readContext: (
			document: vscode.TextDocument,
			source: string
		) => SimpleProjectSemanticContext | undefined = () => undefined
	) {}

	/** 更新定义解析使用的 SDK 快照。 */
	updateSdk(sdk: Sdk | undefined): void {
		this.sdk = sdk;
	}

	/** 解析光标令牌对应的项目单元或 SDK 类库来源。 */
	targetAt(document: vscode.TextDocument, position: vscode.Position): SimpleDefinitionTarget | undefined {
		const source = this.readSource(document);
		return findSimpleDefinition(
			source,
			document.offsetAt(position),
			this.sdk,
			this.readContext(document, source)
		);
	}

	/** 返回光标令牌对应的稳定类库树导航目标。 */
	librarySymbolAt(document: vscode.TextDocument, position: vscode.Position): LibrarySymbolTarget | undefined {
		return this.targetAt(document, position)?.librarySymbol;
	}

	/** 将当前标识符解析到可编辑用户代码或只读完整属性来源。 */
	async provideDefinition(
		document: vscode.TextDocument,
		position: vscode.Position
	): Promise<vscode.Location | undefined> {
		const result = this.targetAt(document, position);
		return result === undefined ? undefined : this.locationForTarget(result);
	}

	/** 将已经解析的源码目标转换为 VS Code 定义位置，避免命令层重复执行语义解析。 */
	async locationForTarget(result: SimpleDefinitionTarget): Promise<vscode.Location | undefined> {
		if (result.librarySymbol !== undefined) {
			return undefined;
		}
		if (result.filePath === undefined) {
			return undefined;
		}
		if (result.resourceSource === true) {
			const position = new vscode.Position(0, 0);
			return new vscode.Location(
				vscode.Uri.file(result.filePath),
				new vscode.Range(position, position)
			);
		}

		const sourceUri = vscode.Uri.file(result.filePath);
		const targetUri = result.propertySource === true
			? toUnitContentPreviewUri(sourceUri)
			: toSimpleCodeUri(sourceUri);
		let targetDocument: vscode.TextDocument;
		try {
			targetDocument = await vscode.workspace.openTextDocument(targetUri);
		} catch {
			return undefined;
		}
		let targetPosition: vscode.Position;
		if (result.targetOffset !== undefined) {
			targetPosition = targetDocument.positionAt(result.targetOffset);
		} else if (result.targetLine !== undefined) {
			const lineNumber = Math.min(
				Math.max(0, result.targetLine),
				Math.max(0, targetDocument.lineCount - 1)
			);
			const line = targetDocument.lineAt(lineNumber);
			const character = Math.max(0, line.text.indexOf(result.name));
			targetPosition = new vscode.Position(lineNumber, character);
		} else {
			const targetOffset = Math.max(0, targetDocument.getText().indexOf(result.name));
			targetPosition = targetDocument.positionAt(targetOffset);
		}

		return new vscode.Location(
			targetUri,
			new vscode.Range(targetPosition, targetPosition.translate(0, result.name.length))
		);
	}
}
