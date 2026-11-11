/*
维护当前打开的 Simple 单元文档，并为语言能力提供共享项目语义上下文。
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
import { parseSimpleUnitSymbols, type SimpleProjectSemanticContext, type SimpleUnitSymbol } from "./simpleUnitSymbols";

/** 将打开文档的未保存代码和 XML 会话统一提供给项目语义索引。 */
export class OpenUnitSemantics {
	private readonly documents = new Map<string, vscode.TextDocument>();
	private readonly nativeDocuments = new Set<vscode.TextDocument>();
	private readonly nativeSymbols = new WeakMap<vscode.TextDocument, { readonly version: number; readonly sourceRoot: string; readonly symbol: SimpleUnitSymbol }>();
	private generation = 0;

	constructor(
		private readonly codeDocuments: SimpleCodeFileSystemProvider,
		private readonly projectSymbols: ProjectSymbolIndex,
		private readonly resolveSourceUri: (uri: vscode.Uri) => vscode.Uri | undefined
	) {}

	track(document: vscode.TextDocument): void {
		if (document.uri.scheme === "file" && document.languageId === "simple") {
			if (!this.nativeDocuments.has(document)) {
				this.nativeDocuments.add(document);
				this.generation += 1;
			}
			return;
		}
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
		if (this.nativeDocuments.delete(document)) {
			this.nativeSymbols.delete(document);
			this.generation += 1;
		}
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

	/** 只缓存文档版本派生的符号，不保留原生文档的原属性代码或 XML 副本。 */
	private nativeSymbol(document: vscode.TextDocument): SimpleUnitSymbol | undefined {
		const sourceRoot = this.projectSymbols.sourceRootForFile(document.uri.fsPath);
		if (sourceRoot === undefined) return undefined;
		const cached = this.nativeSymbols.get(document);
		if (cached?.version === document.version && cached.sourceRoot === sourceRoot) return cached.symbol;
		const symbol = parseSimpleUnitSymbols(document.getText(), document.uri.fsPath, sourceRoot);
		this.nativeSymbols.set(document, { version: document.version, sourceRoot, symbol });
		return symbol;
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
		/* 未保存文档只使用其编辑器身份派生符号，不读取或创建同名磁盘文件。 */
		const sourceUri = this.resolveSourceUri(document.uri) ?? toSimpleSourceUri(document.uri)
			?? (document.uri.scheme === "untitled" ? vscode.Uri.file(document.uri.fsPath) : undefined);
		if (sourceUri === undefined) return undefined;
		const currentProperty = document.uri.scheme === SIMPLE_CODE_SCHEME
			? this.codeDocuments.getProperty(document)
			: undefined;
		/* 原生文件仅派生未保存内容的符号，不建立属性 XML 副本或另存源码缓存。 */
		const sourceUnits = [...this.nativeDocuments].flatMap((candidate) => {
			if (candidate === document || !candidate.isDirty) {
				return [];
			}
			const unit = this.nativeSymbol(candidate);
			return unit === undefined ? [] : [unit];
		});
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
			{ generation: this.generation, identity: document },
			sourceUnits
		);
	}
}
