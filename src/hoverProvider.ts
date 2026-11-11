/*
将 Simple 清单与项目源码悬停信息适配为简洁的 VS Code Markdown 提示。
xhwsd@qq.com 2026-8-27
*/

import * as vscode from "vscode";
import { findSimpleKeywordHover, type SimpleKeywordHoverInfo } from "./keywordHover";
import { markdownDocumentationForDisplay } from "./markdownDocumentation";
import type { Sdk } from "./sdk";
import type { SimpleProjectSemanticContext } from "./simpleUnitSymbols";

/** 追加普通字段标签和值，并交由 VS Code 统一转义。 */
function appendMetadata(
	contents: vscode.MarkdownString,
	label: string,
	value: string
): void {
	contents.appendText(`${label}：${value}`);
}

/** 分别显示真实项目或类库与声明来源，独立单元的临时清单只用于语义分析。 */
function sourceMetadata(
	info: SimpleKeywordHoverInfo,
	context: SimpleProjectSemanticContext | undefined
): { readonly label: string; readonly value: string }[] {
	if (info.declarationSource === undefined || info.declarationSource.length === 0) {
		return [];
	}

	const fromProject = info.declarationSourceKind === "project";
	const metadata: { readonly label: string; readonly value: string }[] = [];
	if (info.manifest !== undefined && info.manifest.length > 0 && (!fromProject || context?.standalone !== true)) {
		metadata.push({ label: fromProject ? "所属项目" : "所属库", value: info.manifest });
	}
	metadata.push({ label: fromProject ? "所属单元" : "所属类", value: info.declarationSource });
	return metadata;
}

/** 为 Simple 编译器语言标记及运行库定义、成员提供悬停说明。 */
export class SimpleHoverProvider implements vscode.HoverProvider {
	private sdk: Sdk | undefined;

	/** 注入当前文档源码读取与项目语义上下文，兼容用户代码和完整代码只读预览。 */
	constructor(
		private readonly readSource: (document: vscode.TextDocument) => string = (document) => document.getText(),
		private readonly readContext: (
			document: vscode.TextDocument,
			source: string
		) => SimpleProjectSemanticContext | undefined = () => undefined
	) {}

	/** 更新悬停查询使用的 SDK 快照。 */
	updateSdk(sdk: Sdk | undefined): void {
		this.sdk = sdk;
	}

	/** 返回当前光标下由 SDK 清单和源码类型绑定确认的说明。 */
	provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
		const source = this.readSource(document);
		const context = this.readContext(document, source);
		const result = findSimpleKeywordHover(
			source,
			document.offsetAt(position),
			this.sdk,
			context
		);
		if (result === undefined) {
			return undefined;
		}

		const contents = new vscode.MarkdownString();
		const displayed = result.overloads ?? [result];
		const sharedSource = displayed.every((candidate) => candidate.manifest === result.manifest
			&& candidate.declarationSource === result.declarationSource
			&& candidate.declarationSourceKind === result.declarationSourceKind);
		displayed.forEach((candidate, candidateIndex) => {
			if (candidateIndex > 0) contents.appendMarkdown("\n\n");
			contents.appendCodeblock(candidate.signature ?? candidate.name, "simple");
			const description = candidate.description === undefined
				? ""
				: markdownDocumentationForDisplay(candidate.description);
			const parameters = (candidate.parameters ?? []).flatMap((parameter) => {
				const documentation = markdownDocumentationForDisplay(parameter.description);
				return documentation.length === 0 ? [] : [{ documentation, name: parameter.name }];
			});
			if (parameters.length > 0) {
				parameters.forEach((parameter, index) => {
					if (index > 0) contents.appendMarkdown("  \n");
					const name = parameter.name.replace(/([\\*_])/gu, "\\$1");
					contents.appendMarkdown(`*${name}：*&#8203;${parameter.documentation}`);
				});
			}
			if (description.length > 0) {
				if (parameters.length > 0) contents.appendMarkdown("\n\n");
				contents.appendMarkdown(description);
			}
			const candidateMetadata = sharedSource ? [] : sourceMetadata(candidate, context);
			if (candidateMetadata.length > 0) {
				contents.appendMarkdown("\n\n");
				candidateMetadata.forEach(({ label, value }, index) => {
					if (index > 0) {
						contents.appendMarkdown("  \n");
					}
					appendMetadata(contents, label, value);
				});
			}
		});

		const metadata = sharedSource ? sourceMetadata(result, context) : [];

		if (result.relations !== undefined && result.relations.length > 0) {
			metadata.push(...result.relations.map((relation) => ({
				label: relation.kind === "overrides"
					? `重写${relation.declaration}`
					: `实现${relation.declaration}`,
				value: relation.source
			})));
		}

		const objectRelations = [
			...(result.baseObject === undefined ? [] : [{ label: "基础对象", value: result.baseObject }]),
			...((result.interfaces ?? []).length === 0
				? []
				: [{ label: "实现接口", value: result.interfaces?.join("、") ?? "" }])
		];
		if (objectRelations.length > 0) {
			metadata.push(...objectRelations);
		}

		if (result.eventDefinition !== undefined && result.eventDefinition.length > 0) {
			metadata.push({ label: "事件定义", value: result.eventDefinition });
		}

		if (metadata.length > 0) {
			// 资源来源与项目归属连续显示，中间只换行。
			contents.appendMarkdown(result.category === "项目资源" && result.kind === "constants"
				? "  \n"
				: "\n\n");
			metadata.forEach(({ label, value }, index) => {
				if (index > 0) contents.appendMarkdown("  \n");
				appendMetadata(contents, label, value);
			});
		}

		return new vscode.Hover(
			contents,
			new vscode.Range(document.positionAt(result.start), document.positionAt(result.end))
		);
	}
}
