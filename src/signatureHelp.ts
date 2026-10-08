/*
将签名模型和调用上下文适配为 VS Code 参数提示。
xhwsd@qq.com 2026-8-27
*/

import * as vscode from "vscode";
import { resolveSimpleQualifier } from "./completionModel";
import { markdownDocumentationForDisplay } from "./markdownDocumentation";
import {
	buildDefinitionIndex,
	getEffectiveMembers,
	type LibraryMemberGroup,
	type Sdk
} from "./sdk";
import {
	buildDocumentSignatures,
	buildSdkSignatures,
	findCallContext,
	formatParameter,
	formatSignature,
	signatureFromMember,
	type SignatureDefinition
} from "./signatures";
import {
	buildSemanticDefinitionIndex,
	isStaticProjectMember,
	type SimpleProjectSemanticContext
} from "./simpleUnitSymbols";

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
	private sdkSignatures: readonly SignatureDefinition[] = [];

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
		this.sdkSignatures = buildSdkSignatures(sdk);
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
		const visibleSource = document.getText();
		const analysisSource = this.readSource(document);
		const call = findCallContext(visibleSource, document.offsetAt(position));

		if (call === undefined) {
			return undefined;
		}

		const context = this.readContext(document, analysisSource);
		const documentSignatures = buildDocumentSignatures(analysisSource);
		let matches: SignatureDefinition[] = [];
		if (call.qualifier !== undefined) {
			const resolved = resolveSimpleQualifier(
				analysisSource,
				call.nameStart,
				call.qualifier,
				this.sdk,
				context
			);
			if (resolved !== undefined) {
				const definitions = context === undefined
					? buildDefinitionIndex(this.sdk?.manifests ?? [])
					: buildSemanticDefinitionIndex(this.sdk, context);
				const groups: readonly LibraryMemberGroup[] = ["functions", "events"];
				for (const group of groups) {
					for (const value of getEffectiveMembers(resolved.reference, group, definitions)) {
						const staticMember = value.member.global === true || isStaticProjectMember(value.member);
						if (
							value.member.name === call.name
							&& (resolved.access === "static") === staticMember
						) {
							matches.push(signatureFromMember(call.qualifier, value.member));
						}
					}
				}
			}
		} else if (context?.currentUnit !== undefined) {
			const definitions = buildSemanticDefinitionIndex(this.sdk, context);
			const current = definitions.get(context.currentUnit.qualifiedName);
			if (current !== undefined) {
				matches.push(...getEffectiveMembers(current, "functions", definitions)
					.filter((value) => value.member.name === call.name)
					.map((value) => signatureFromMember(undefined, value.member)));
			}
			for (const manifest of this.sdk?.manifests ?? []) {
				if (manifest.kind === "compiler" || manifest.kind === "project") continue;
				for (const definition of manifest.categories.flatMap((category) => category.definitions)) {
					matches.push(...(definition.functions ?? [])
						.filter((member) => member.name === call.name && member.global === true)
						.map((member) => signatureFromMember(undefined, member)));
				}
			}
			matches.unshift(...documentSignatures.filter((signature) => signature.name === call.name));
		}
		if (matches.length === 0) {
			matches = [...documentSignatures, ...this.sdkSignatures]
				.filter((signature) => signature.name === call.name);
		}

		// 限定名与清单对象一致时优先精确匹配；变量类型未知时保留同名候选。
		if (call.qualifier !== undefined && matches.length > 0) {
			const qualifiedMatches = matches.filter((signature) => signature.owner === call.qualifier);

			if (qualifiedMatches.length > 0) {
				matches = qualifiedMatches;
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
		const matchingArity = definitions.findIndex(
			(signature) => signature.parameters.length > call.activeParameter
		);
		help.activeSignature = matchingArity < 0 ? 0 : matchingArity;
		return help;
	}
}
