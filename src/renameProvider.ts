/*
将变量、参数、成员变量及组件引用接入原生 F2，按声明或 XML 身份准备关联修改。
xhwsd@qq.com 2026-10-11
*/

import * as path from "node:path";
import * as vscode from "vscode";
import { findSimpleDefinition } from "./definitionModel";
import { findProjectForSource } from "./projectCapability";
import { replaceChangedText, type SimpleProjectRefactoring } from "./projectRefactoring";
import { collectPropertyXmlElements, findPropertyXmlElementPath, getPropertyXmlAttribute } from "./propertyXml";
import { planSimpleSymbolRename, refactoringContext } from "./refactoringModel";
import { filePathKey } from "./simpleProjectPaths";
import { toSimpleCodeUri, toSimpleSourceUri, type SimpleCodeFileSystemProvider } from "./simpleCodeFileSystem";
import type { ProgramTreeProvider } from "./programTree";
import type { Sdk } from "./sdk";

export class SimpleRenameProvider implements vscode.RenameProvider, vscode.Disposable {
	private pending: Array<Awaited<ReturnType<SimpleCodeFileSystemProvider["preparePropertyRefactor"]>>> = [];
	private request = 0;

	constructor(
		private readonly programs: ProgramTreeProvider,
		private readonly refactoring: SimpleProjectRefactoring,
		private readonly documents: SimpleCodeFileSystemProvider,
		private readonly getSdk: () => Sdk | undefined
	) {}

	/** 区分代码声明与 XML 组件身份；SDK 成员和类型名称不进入当前重命名入口。 */
	private async target(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken) {
		const version = document.version;
		const offset = document.offsetAt(position);
		const cancelled = (): boolean => token.isCancellationRequested || document.isClosed || document.version !== version;
		const source = toSimpleSourceUri(document.uri);
		if (source === undefined || cancelled()) return undefined;
		if (this.refactoring.isBusy) throw new Error("正在重构，请稍后重命名。");
		const project = findProjectForSource(await this.programs.getProjects(), source.fsPath);
		if (cancelled()) return undefined;
		const units = project === undefined
			? [await this.documents.readRefactoringUnit(source, path.dirname(source.fsPath))]
			: await this.refactoring.readProject(project);
		if (cancelled()) return undefined;
		const current = units.find((unit) => filePathKey(unit.filePath) === filePathKey(source.fsPath));
		if (current === undefined) return undefined;
		const sdk = this.getSdk();
		if (current.userCode !== document.getText()) return undefined;
		const target = findSimpleDefinition(current.userCode, offset, sdk, refactoringContext(current, units));
		if (target?.filePath === undefined) return undefined;
		if (target.propertySource !== true) return target.symbolKind === "binding" || target.memberGroup === "variables"
			? { kind: "symbol" as const, units, current, target, sdk } : undefined;
		const owner = units.find((unit) => filePathKey(unit.filePath) === filePathKey(target.filePath!));
		const property = owner?.property.document;
		if (owner === undefined || property === undefined || owner.property.status === "damaged") return undefined;
		const matches = collectPropertyXmlElements(property.root, "定义").filter((element) => getPropertyXmlAttribute(element, "名称") === target.name);
		if (matches.length !== 1) throw new Error("组件名称重复或无法定位，请先修正 XML 属性。");
		const componentPath = findPropertyXmlElementPath(property, matches[0]!);
		return componentPath === undefined ? undefined : { kind: "component" as const, units, current, owner, target, componentPath, sdk };
	}

	async prepareRename(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<{ range: vscode.Range; placeholder: string } | undefined> {
		const value = await this.target(document, position, token);
		return value === undefined ? undefined : {
			range: new vscode.Range(document.positionAt(value.target.start), document.positionAt(value.target.end)),
			placeholder: value.target.name
		};
	}

	/** 只准备 WorkspaceEdit；预览取消、名称冲突或版本校验失败都不能提前改写文件。 */
	async provideRenameEdits(document: vscode.TextDocument, position: vscode.Position, newName: string, token: vscode.CancellationToken): Promise<vscode.WorkspaceEdit | undefined> {
		const request = ++this.request;
		this.clearPending();
		const value = await this.target(document, position, token);
		if (value === undefined) return undefined;
		if (value.kind === "symbol") {
			const changes = planSimpleSymbolRename(value.units, value.current, value.target.start, newName, value.sdk);
			const edit = new vscode.WorkspaceEdit();
			for (const change of changes) {
				const unit = value.units.find((unit) => unit === change.unit)!;
				await unit.assertUnchanged();
				const code = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(unit.filePath)));
				if (code.getText() !== unit.userCode) throw new Error("关联代码已变化，请重试重命名。");
				for (const span of change.edits) edit.replace(code.uri, new vscode.Range(code.positionAt(span.start), code.positionAt(span.end)), span.replacement);
			}
			for (const unit of value.units.filter((unit) => unit === value.current || changes.some((change) => change.unit === unit))) await unit.assertUnchanged();
			return token.isCancellationRequested || request !== this.request ? undefined : edit;
		}
		const changes = await this.refactoring.planComponentRename(value.units, value.owner, value.componentPath, newName);
		const affected = value.units.filter((unit) => changes.some((change) => change.unit === unit));
		const edit = new vscode.WorkspaceEdit();
		const receipts: typeof this.pending = [];
		try {
			const codes: Array<{ readonly document: vscode.TextDocument; readonly userCode: string }> = [];
			for (const change of changes) {
				await affected.find((unit) => unit === change.unit)!.assertUnchanged();
				const code = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(change.unit.filePath)));
				if (code.getText() !== change.unit.userCode) throw new Error("关联代码已变化，请重试组件重命名。");
				codes.push({ document: code, userCode: change.userCode });
				if (change.propertyDocument !== undefined && change.propertyDocument !== change.unit.property.document) {
					const receipt = await this.documents.preparePropertyRefactor(vscode.Uri.file(change.unit.filePath), change.propertyDocument, change.userCode, false, { from: value.target.name, to: newName.trim() }, async () => {
						if (this.refactoring.isBusy || request !== this.request) throw new Error("重命名计划已经过期，请重试。");
						for (const unit of affected) await unit.assertUnchanged();
					});
					receipts.push(receipt);
					edit.renameFile(receipt.before, receipt.after, { overwrite: false }, { label: "重构组件名称及 XML 锚点引用", needsConfirmation: false });
				}
			}
			// XML 资源校验先执行，拒绝过期属性状态时不能先改到代码引用。
			for (const code of codes) replaceChangedText(edit, code.document, code.userCode);
			for (const unit of affected) await unit.assertUnchanged();
			if (token.isCancellationRequested || request !== this.request) { for (const receipt of receipts) receipt.dispose(); return undefined; }
			this.pending = receipts;
			return edit;
		} catch (error) {
			for (const receipt of receipts) receipt.dispose();
			throw error;
		}
	}

	/** 已应用的 XML 撤销凭据由共享会话保留，未应用的准备结果在下一次请求时释放。 */
	private clearPending(): void {
		for (const receipt of this.pending) if (!receipt.wasApplied()) receipt.dispose();
		this.pending = [];
	}

	dispose(): void { this.request += 1; this.clearPending(); }
}
