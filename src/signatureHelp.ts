/*
将签名模型和调用上下文适配为 VS Code 参数提示。
xhwsd@qq.com 2026-8-27
*/

import * as vscode from "vscode";
import { createSimpleSourceAnalysis, resolveSimpleCallMembers } from "./completionModel";
import { markdownDocumentationForDisplay } from "./markdownDocumentation";
import { simpleExecutionContext } from "./simpleCodeContext";
import { getVisibleSimpleUnitUserCode } from "./simpleUnitSource";
import type { Sdk } from "./sdk";
import {
	buildDocumentSignatures,
	findCallContext,
	findCallableArgumentCount,
	formatParameter,
	formatSignature,
	signatureFromMember,
	type SignatureDefinition
} from "./signatures";
import type { SimpleProjectSemanticContext } from "./simpleUnitSymbols";

/**
 * 将编辑器中立的签名定义转换为 VS Code API 对象。
 *
 * @param definition 编辑器中立签名定义。
 * @returns 包含参数标签和说明的 VS Code 签名信息。
 */
function toSignatureInformation(definition: SignatureDefinition): vscode.SignatureInformation {
	const information = new vscode.SignatureInformation(
		formatSignature(definition),
		definition.description === undefined
			? undefined
			: new vscode.MarkdownString(markdownDocumentationForDisplay(definition.description))
	);
	information.parameters = definition.parameters.map((parameter) => new vscode.ParameterInformation(
		formatParameter(parameter),
		parameter.description === undefined
			? undefined
			: new vscode.MarkdownString(markdownDocumentationForDisplay(parameter.description))
	));
	return information;
}

/** 为 SDK 成员和当前文档声明提供函数参数提示。 */
export class SimpleSignatureHelpProvider implements vscode.SignatureHelpProvider {
	private sdk: Sdk | undefined;

	/** 注入用户代码读取器，参数提示只分析当前可编辑代码区。 */
	constructor(
		private readonly readSource: (document: vscode.TextDocument) => string = (document) => document.getText(),
		private readonly readContext: (
			document: vscode.TextDocument,
			source: string
		) => SimpleProjectSemanticContext | undefined = () => undefined
	) {}

	/**
	 * 重建 SDK 函数与事件签名缓存。
	 *
	 * @param sdk 最新 SDK；传入 `undefined` 时清空签名缓存。
	 */
	updateSdk(sdk: Sdk | undefined): void {
		this.sdk = sdk;
	}

	/**
	 * 根据光标所在调用表达式返回候选签名及当前参数位置。
	 *
	 * 当前文件声明优先于 SDK 清单；限定名能够对应清单对象时进一步缩小候选范围。
	 *
	 * @param document VS Code 请求参数提示的 Simple 文档。
	 * @param position 当前光标位置。
	 * @param _cancellationToken VS Code 提供的取消令牌；当前分析为同步操作。
	 * @param _context 本次参数提示的触发上下文。
	 * @returns 匹配的签名帮助；光标不在已知调用中时返回 `undefined`。
	 */
	provideSignatureHelp(
		document: vscode.TextDocument,
		position: vscode.Position,
		_cancellationToken: vscode.CancellationToken,
		_context: vscode.SignatureHelpContext
	): vscode.SignatureHelp | undefined {
		const visibleText = document.getText();
		const visibleSource = getVisibleSimpleUnitUserCode(visibleText);
		const offset = document.offsetAt(position);
		/* 不把属性表达式当成用户调用，避免在原生文件的属性区弹出参数提示。 */
		if (visibleSource.length < visibleText.length && offset >= visibleSource.length) {
			return undefined;
		}

		const source = this.readSource(document);
		const analysisSource = getVisibleSimpleUnitUserCode(source);
		const context = this.readContext(document, source);
		const analysis = createSimpleSourceAnalysis(analysisSource, this.sdk, context);
		const call = findCallContext(visibleSource, offset, visibleSource === analysisSource ? analysis.syntax : undefined);
		if (call === undefined) return undefined;
		let matches: SignatureDefinition[] = resolveSimpleCallMembers(call, analysis, context).map(({ member }) => ({
			...signatureFromMember(call.qualifier, member), name: call.name
		}));
		if (matches.length === 0 && context?.currentUnit === undefined && call.qualifier === undefined) {
			const binding = analysis.syntax.resolve(call.name, call.nameStart);
			const staticContext = simpleExecutionContext(analysis.syntax, call.nameStart).static;
			if (binding === undefined || ["function", "procedure", "functionResult", "event"].includes(binding.kind)) {
				matches = buildDocumentSignatures(analysisSource, analysis.syntax).filter((signature) => signature.name === call.name
					&& signature.owner === undefined && (signature.event === true) === (call.event === true)
					&& (!staticContext || analysis.syntax.declarationsNamed(call.name).some((declaration) => declaration.static
						&& declaration.parameters?.length === signature.parameters.length)));
			}
		}

		const unique = new Map<string, SignatureDefinition>();

		for (const match of matches) {
			unique.set(formatSignature(match), match);
		}

		const definitions = [...unique.values()];

		if (definitions.length === 0) {
			return undefined;
		}

		const help = new vscode.SignatureHelp();
		help.signatures = definitions.map(toSignatureInformation);
		help.activeParameter = call.activeParameter;
		const arity = findCallableArgumentCount(visibleSource, call.nameStart + call.name.length);
		const exactArity = arity === undefined ? -1 : definitions.findIndex((signature) => signature.parameters.length === arity);
		const matchingArity = exactArity >= 0 ? exactArity : definitions.findIndex(
			(signature) => signature.parameters.length > call.activeParameter
		);
		help.activeSignature = matchingArity < 0 ? 0 : matchingArity;
		return help;
	}
}
