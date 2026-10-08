/*
将编辑器无关的 Simple 标记结果适配为 VS Code 语义标记。
xhwsd@qq.com 2026-8-27
*/

import * as vscode from "vscode";
import {
	SIMPLE_SEMANTIC_TOKEN_MODIFIERS,
	SIMPLE_SEMANTIC_TOKEN_TYPES,
	buildCompilerTokenRules,
	buildDocumentTokenRules,
	tokenizeSimpleText,
	type CompilerTokenRule
} from "./compilerTokens";
import type { Sdk } from "./sdk";
import type { SimpleProjectSemanticContext } from "./simpleUnitSymbols";

/** VS Code 用于解码本扩展语义令牌数据的固定图例。 */
export const SIMPLE_SEMANTIC_TOKENS_LEGEND = new vscode.SemanticTokensLegend(
	[...SIMPLE_SEMANTIC_TOKEN_TYPES],
	[...SIMPLE_SEMANTIC_TOKEN_MODIFIERS]
);

/** 同一文档版本在语义依赖未变化时可直接复用的着色结果。 */
interface CachedSemanticTokens {
	readonly generation: number;
	readonly tokens: vscode.SemanticTokens;
	readonly version: number;
}

/**
 * 将语义修饰符数组编码为 VS Code 使用的位集合。
 *
 * @param modifiers 当前令牌的语义修饰符。
 * @returns 与语义令牌图例顺序一致的修饰符位集合。
 */
function modifierBits(modifiers: readonly string[]): number {
	return modifiers.reduce((bits, modifier) => {
		const index = SIMPLE_SEMANTIC_TOKEN_MODIFIERS.indexOf(
			modifier as typeof SIMPLE_SEMANTIC_TOKEN_MODIFIERS[number]
		);
		return index < 0 ? bits : bits | (1 << index);
	}, 0);
}

/** 根据 SDK 清单和当前文档声明提供 Simple 语义着色。 */
export class SimpleSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider, vscode.Disposable {
	private cache = new WeakMap<vscode.TextDocument, CachedSemanticTokens>();
	private readonly changed = new vscode.EventEmitter<void>();
	private generation = 0;
	private rules: readonly CompilerTokenRule[] = [];
	private sdk: Sdk | undefined;

	/** 注入当前文档源码和项目语义上下文，统一着色用户代码与完整代码只读预览。 */
	constructor(
		private readonly readSource: (document: vscode.TextDocument) => string = (document) => document.getText(),
		private readonly readContext: (
			document: vscode.TextDocument,
			source: string
		) => SimpleProjectSemanticContext | undefined = () => undefined
	) {}

	/** SDK 规则变化时通知 VS Code 重新请求语义令牌。 */
	readonly onDidChangeSemanticTokens = this.changed.event;

	/** 释放语义令牌变更事件资源。 */
	dispose(): void {
		this.changed.dispose();
	}

	/**
	 * 更新 SDK 动态规则并通知 VS Code 重新请求所有可见文档的令牌。
	 *
	 * @param sdk 最新 SDK；传入 `undefined` 时清空动态规则。
	 */
	updateSdk(sdk: Sdk | undefined): void {
		this.sdk = sdk;
		this.rules = buildCompilerTokenRules(sdk);
		this.invalidate();
	}

	/** 项目符号索引变化时请求重新着色所有可见 Simple 文档。 */
	refresh(): void {
		this.invalidate();
	}

	/** 清空旧代缓存并通知 VS Code 重新请求可见文档。 */
	private invalidate(): void {
		this.generation += 1;
		this.cache = new WeakMap<vscode.TextDocument, CachedSemanticTokens>();
		this.changed.fire();
	}

	/**
	 * 扫描指定文档并返回 VS Code 紧凑语义令牌数据。
	 *
	 * @param document VS Code 请求着色的 Simple 文档。
	 * @param _cancellationToken VS Code 提供的取消令牌；当前扫描为同步操作。
	 * @returns 按文档位置编码的语义令牌集合。
	 */
	provideDocumentSemanticTokens(
		document: vscode.TextDocument,
		cancellationToken: vscode.CancellationToken
	): vscode.SemanticTokens {
		const cached = this.cache.get(document);
		if (
			cached !== undefined
			&& cached.generation === this.generation
			&& cached.version === document.version
		) {
			return cached.tokens;
		}

		const builder = new vscode.SemanticTokensBuilder(SIMPLE_SEMANTIC_TOKENS_LEGEND);
		if (cancellationToken.isCancellationRequested) {
			return builder.build();
		}
		const visibleSource = document.getText();
		const analysisSource = this.readSource(document);
		const rules = [
			...this.rules,
			...buildDocumentTokenRules(
				analysisSource,
				this.sdk,
				this.readContext(document, analysisSource)
			)
		];

		for (const token of tokenizeSimpleText(visibleSource, rules)) {
			builder.push(
				token.line,
				token.character,
				token.length,
				SIMPLE_SEMANTIC_TOKEN_TYPES.indexOf(token.type),
				modifierBits(token.modifiers)
			);
		}

		const tokens = builder.build();
		if (!cancellationToken.isCancellationRequested) {
			this.cache.set(document, {
				generation: this.generation,
				tokens,
				version: document.version
			});
		}
		return tokens;
	}
}
