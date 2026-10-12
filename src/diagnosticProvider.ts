/*
维护项目引用的波浪线诊断，合并事件并在重构完成后发布一致的结果。
xhwsd@qq.com 2026-10-10
*/

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { analyzeSimpleReferencesAsync } from "./referenceDiagnostics";
import { refactoringContext } from "./refactoringModel";
import { serializePropertyXml, resolvePropertyXmlElement, getPropertyXmlAttribute } from "./propertyXml";
import { toSimpleCodeUri, toSimpleSourceUri, type SimpleCodeFileSystemProvider } from "./simpleCodeFileSystem";
import { toUnitXmlPreviewUri } from "./unitPreview";
import { mostSpecificSourceRoot } from "./simpleProjectPaths";
import { findProjectForSource } from "./projectCapability";
import type { SimpleProjectInfo } from "./project";
import type { ProgramTreeProvider } from "./programTree";
import type { SimpleProjectRefactoring } from "./projectRefactoring";
import type { ProjectSymbolIndex } from "./projectSymbolIndex";
import { parseSimpleUnitSymbolsFromModel, type SimpleUnitSymbol, type SimpleProjectSemanticContext } from "./simpleUnitSymbols";
import type { Sdk } from "./sdk";

export class SimpleDiagnosticProvider implements vscode.Disposable {
	private readonly collection = vscode.languages.createDiagnosticCollection("ES4A");
	private generation = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private fullRefresh = false;
	private readonly changedDocuments = new Set<string>();
	private disposed = false;

	constructor(
		private readonly programs: ProgramTreeProvider,
		private readonly refactoring: SimpleProjectRefactoring,
		private readonly documents: SimpleCodeFileSystemProvider,
		private readonly symbols: ProjectSymbolIndex,
		private readonly getSdk: () => Sdk | undefined,
		private readonly readContext: (document: vscode.TextDocument, source: string) => SimpleProjectSemanticContext | undefined,
		private readonly reportError: (message: string) => void
	) {}

	schedule(full = false, uri?: vscode.Uri): void {
		if (this.disposed) return;
		const source = uri === undefined ? undefined : toSimpleSourceUri(uri);
		if (source !== undefined) this.changedDocuments.add(toSimpleCodeUri(source).toString());
		this.fullRefresh ||= full;
		this.generation += 1;
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.refresh().catch((error: unknown) => {
				this.fullRefresh = true;
				this.reportError(`更新引用诊断失败：${String(error)}`);
			});
		}, 200);
	}

	private async refresh(): Promise<void> {
		if (this.refactoring.isBusy) return; // 完成事件会重新安排；不展示中间状态的错误。
		const generation = this.generation;
		const cancelled = (): boolean => this.disposed || generation !== this.generation || this.refactoring.isBusy;
		const pending = new Set(this.changedDocuments);
		const entries = new Map<string, { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }>();
		const add = (uri: vscode.Uri, diagnostic: vscode.Diagnostic): void => {
			const key = uri.toString();
			const entry = entries.get(key) ?? { uri, diagnostics: [] };
			entry.diagnostics.push(diagnostic);
			entries.set(key, entry);
		};
		const assetIndexes = new Map<string, ReadonlySet<string>>();
		const failedProjects: SimpleProjectInfo[] = [];
		const assetsFor = async (project: SimpleProjectInfo): Promise<ReadonlySet<string>> => {
			const known = assetIndexes.get(project.filePath);
			if (known !== undefined) return known;
			const names = new Set<string>();
			const visit = async (directory: string): Promise<void> => {
				if (cancelled()) return;
				let entries;
				try { entries = await fs.readdir(directory, { withFileTypes: true }); }
				catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return;
					throw error;
				}
				for (const entry of entries) {
					if (cancelled()) return;
					const file = path.join(directory, entry.name);
					if (entry.isDirectory()) await visit(file);
					else if (entry.isFile()) names.add(path.relative(project.assetsDirectory, file).split(path.sep).join("/"));
				}
			};
			await visit(project.assetsDirectory);
			assetIndexes.set(project.filePath, names);
			return names;
		};
		const analyze = async (filePath: string, code: string, context: SimpleProjectSemanticContext, property: ReturnType<SimpleCodeFileSystemProvider["getProperty"]>, assets: ReadonlySet<string>): Promise<boolean> => {
			const sourceUri = vscode.Uri.file(filePath);
			const codeUri = toSimpleCodeUri(sourceUri);
			const xmlUri = toUnitXmlPreviewUri(sourceUri);
			entries.set(codeUri.toString(), { uri: codeUri, diagnostics: [] });
			entries.set(xmlUri.toString(), { uri: xmlUri, diagnostics: [] });
			const positionAt = (offset: number): vscode.Position => {
				const before = code.slice(0, offset).split(/\r\n|\r|\n/u);
				return new vscode.Position(before.length - 1, before[before.length - 1]!.length);
			};
			const issues = await analyzeSimpleReferencesAsync(code, this.getSdk(), context, property?.document, assets, cancelled);
			if (issues === undefined) return false;
			const xmlLines = property?.document === undefined ? [] : serializePropertyXml(property.document).split(/\r\n|\n/u);
			for (const issue of issues) {
				let uri = codeUri;
				let range = new vscode.Range(positionAt(issue.start), positionAt(issue.end));
				if (issue.propertyPath !== undefined && property?.document !== undefined) {
					const element = resolvePropertyXmlElement(property.document, issue.propertyPath.slice(0, -"/@值".length));
					const lineNumber = Number(element?.temporary.get("sourceLine")) - Number(property.document.root.temporary.get("sourceLine"));
					const line = xmlLines[lineNumber];
					if (line === undefined || lineNumber < 0) continue;
					const valueStart = line.indexOf('值="') + 3;
					if (valueStart < 3) continue;
					uri = xmlUri;
					const value = getPropertyXmlAttribute(element!, "值") ?? "";
					const escapedLength = (offset: number): number => value.slice(0, offset).replace(/[&"<>]/gu, (character) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[character]!).length;
					range = new vscode.Range(lineNumber, valueStart + escapedLength(issue.start), lineNumber, valueStart + escapedLength(issue.end));
				}
				const diagnostic = new vscode.Diagnostic(range, issue.message, vscode.DiagnosticSeverity.Warning);
				diagnostic.source = "ES4A 引用分析";
				diagnostic.code = issue.code;
				add(uri, diagnostic);
			}
			return true;
		};
		const full = this.fullRefresh;
		this.fullRefresh = false;
		if (full) {
			for (const project of await this.programs.getProjects()) {
				try {
					const units = await this.refactoring.readProject(project);
					const assets = await assetsFor(project);
					// 一个项目的单元符号只解析一次，按单元让出线程；不建立项目 XML 缓存。
					const symbols: SimpleUnitSymbol[] = [];
					for (const unit of units) {
						if (cancelled()) { this.fullRefresh = true; return; }
						symbols.push(parseSimpleUnitSymbolsFromModel(unit.userCode, unit.property, unit.filePath, unit.sourceRoot));
						await new Promise<void>((resolve) => setTimeout(resolve, 0));
					}
					for (const unit of units) {
						if (generation !== this.generation || this.refactoring.isBusy) { this.fullRefresh = true; return; }
						const resources = this.symbols.contextForFile(unit.filePath)?.resources;
						if (!await analyze(unit.filePath, unit.userCode, refactoringContext(unit, units, resources, symbols), unit.property, assets)) { this.fullRefresh = true; return; }
						await new Promise<void>((resolve) => setTimeout(resolve, 0));
					}
				} catch (error: unknown) {
					if (cancelled()) { this.fullRefresh = true; return; }
					// 一个项目读取失败不能阻断其它项目，也不能用不完整结果清除其原有诊断。
					for (const [key, entry] of entries) {
						const source = toSimpleSourceUri(entry.uri);
						if (source !== undefined && findProjectForSource([project], source.fsPath) !== undefined) entries.delete(key);
					}
					failedProjects.push(project);
					this.fullRefresh = true;
					this.reportError(`更新项目引用诊断失败（${project.filePath}）：${String(error)}`);
				}
			}
		} else {
			const projects = await this.programs.getProjects();
			for (const value of pending) {
				if (cancelled()) return;
				const source = toSimpleSourceUri(vscode.Uri.parse(value));
				const project = source === undefined ? undefined : findProjectForSource(projects, source.fsPath);
				if (source === undefined || project === undefined) continue;
				const document = this.documents.getOpenDocument(source);
				// 仅设计器打开时仍从共享 XML 会话读取；不为诊断制造代码标签。
				const snapshot = document === undefined ? await this.documents.readRefactoringUnit(source, mostSpecificSourceRoot(project.sourceDirectories, source.fsPath)!) : undefined;
				const code = document?.getText() ?? snapshot!.userCode;
				const property = document === undefined ? snapshot!.property : this.documents.getProperty(document);
				const context = document === undefined ? this.symbols.contextForFile(source.fsPath, code, property) : this.readContext(document, code);
				if (context !== undefined && !await analyze(source.fsPath, code, context, property, await assetsFor(project))) return;
			}
		}
		if (generation !== this.generation || this.refactoring.isBusy) { this.fullRefresh ||= full; return; }
		if (full) {
			if (failedProjects.length > 0) this.collection.forEach((uri, diagnostics) => {
				const source = toSimpleSourceUri(uri);
				if (source !== undefined && findProjectForSource(failedProjects, source.fsPath) !== undefined) {
					entries.set(uri.toString(), { uri, diagnostics: [...diagnostics] });
				}
			});
			this.collection.clear();
		}
		for (const entry of entries.values()) this.collection.set(entry.uri, entry.diagnostics);
		for (const uri of pending) this.changedDocuments.delete(uri);
	}

	dispose(): void {
		this.disposed = true;
		this.changedDocuments.clear();
		this.generation += 1;
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.collection.dispose();
	}
}
