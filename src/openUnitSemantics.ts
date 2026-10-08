/*
维护当前打开的 Simple 用户代码文档，并为语言能力提供共享项目语义上下文。
xhwsd@qq.com 2026-9-10
*/

import * as vscode from "vscode";
import { simpleUnitMetadataFromProperty, type SimpleUnitMetadata } from "./programResources";
import { ProjectSymbolIndex } from "./projectSymbolIndex";
import { filePathKey } from "./simpleProjectPaths";
import {
	SIMPLE_CODE_SCHEME,
	SimpleCodeFileSystemProvider,
	toSimpleSourceUri
} from "./simpleCodeFileSystem";
import type { SimpleProjectSemanticContext } from "./simpleUnitSymbols";

/** 将打开文档的未保存代码和 XML 会话统一提供给项目语义索引。 */
export class OpenUnitSemantics {
	private readonly documents = new Map<string, vscode.TextDocument>();
	private generation = 0;

	constructor(
		private readonly codeDocuments: SimpleCodeFileSystemProvider,
		private readonly projectSymbols: ProjectSymbolIndex,
		private readonly resolveSourceUri: (uri: vscode.Uri) => vscode.Uri | undefined
	) {}

	track(document: vscode.TextDocument): void {
		if (document.uri.scheme !== SIMPLE_CODE_SCHEME) return;
		const sourceUri = toSimpleSourceUri(document.uri);
		if (sourceUri === undefined) return;
		const key = filePathKey(sourceUri.fsPath);
		if (this.documents.get(key) !== document) {
			this.documents.set(key, document);
			this.generation += 1;
		}
	}

	forget(document: vscode.TextDocument): void {
		const sourceUri = document.uri.scheme === SIMPLE_CODE_SCHEME
			? toSimpleSourceUri(document.uri)
			: undefined;
		if (sourceUri === undefined) return;
		const key = filePathKey(sourceUri.fsPath);
		if (this.documents.get(key) === document) {
			this.documents.delete(key);
			this.generation += 1;
		}
	}

	markChanged(document: vscode.TextDocument): void {
		if (document.languageId === "simple") this.generation += 1;
	}

	metadataForFile(filePath: string): SimpleUnitMetadata | undefined {
		const document = this.documents.get(filePathKey(filePath));
		const property = document === undefined ? undefined : this.codeDocuments.getProperty(document);
		return property === undefined
			? this.projectSymbols.metadataForFile(filePath)
			: simpleUnitMetadataFromProperty(property);
	}

	contextForDocument(document: vscode.TextDocument, source: string): SimpleProjectSemanticContext | undefined {
		const sourceUri = this.resolveSourceUri(document.uri) ?? toSimpleSourceUri(document.uri);
		if (sourceUri === undefined) return undefined;
		const currentProperty = document.uri.scheme === SIMPLE_CODE_SCHEME
			? this.codeDocuments.getProperty(document)
			: undefined;
		const openUnits = [...this.documents.values()].flatMap((candidate) => {
			const candidateSourceUri = toSimpleSourceUri(candidate.uri);
			if (candidateSourceUri === undefined) return [];
			const property = candidate === document
				? currentProperty
				: this.codeDocuments.getProperty(candidate);
			return property === undefined
				? []
				: [{
					cacheIdentity: candidate,
					filePath: candidateSourceUri.fsPath,
					property,
					userCode: candidate.getText(),
					version: candidate.version
				}];
		});
		return this.projectSymbols.contextForFile(
			sourceUri.fsPath,
			source,
			currentProperty,
			openUnits,
			{ generation: this.generation, identity: document }
		);
	}
}
