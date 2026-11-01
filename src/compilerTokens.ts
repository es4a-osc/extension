/*
按 Simple 语法位置与源码引用生成语义标记，SDK 只补充外部类型和成员。
xhwsd@qq.com 2026-10-31
*/

import {
	isSdkTypeKind,
	type Sdk,
	type LibraryMemberGroup,
	type LibraryDefinitionReference
} from "./sdk";
import {
	isSimpleMemberAccessible,
	resolveSimpleDefinitionName,
	type SimpleProjectSemanticContext
} from "./simpleUnitSymbols";
import { createSimpleSourceAnalysis, isSimpleResourceRoot, type ResolvedSimpleQualifier, type SimpleSourceAnalysis } from "./completionModel";
import { scanSimpleSource, type SimpleSourceToken } from "./simpleSourceLexical";
import { analyzeSimpleSourceSyntax, simpleDeclarationRole, type SimpleSourceDeclaration } from "./simpleSourceSyntax";
import { simpleUnitHighlightingInput, type SimpleUnitHighlightingInput } from "./propertyXml";
import languageFacts from "./simpleLanguageFacts.json";

/** 扩展公开的语义类型和修饰符，顺序与 VS Code 图例一致。 */
export const SIMPLE_SEMANTIC_TOKEN_TYPES = [
	"simpleDeclaration", "simpleControl", "simpleModifier", "keyword", "type", "operator",
	"enumMember", "function", "event", "method", "parameter", "property", "variable"
] as const;
export type SimpleSemanticTokenType = typeof SIMPLE_SEMANTIC_TOKEN_TYPES[number];
export const SIMPLE_SEMANTIC_TOKEN_MODIFIERS = ["readonly"] as const;
export type SimpleSemanticTokenModifier = typeof SIMPLE_SEMANTIC_TOKEN_MODIFIERS[number];

/** 固定语言规则以词法令牌匹配；源码分析规则必须携带精确位置。 */
export interface SimpleTokenRule {
	readonly text: string;
	readonly type: SimpleSemanticTokenType;
	readonly modifiers?: readonly SimpleSemanticTokenModifier[];
	readonly start?: number;
	readonly end?: number;
}

/** 交给编辑器的单行 UTF-16 语义令牌。 */
export interface SimpleSemanticTokenSpan {
	readonly character: number;
	readonly length: number;
	readonly line: number;
	readonly modifiers: readonly SimpleSemanticTokenModifier[];
	readonly text: string;
	readonly type: SimpleSemanticTokenType;
}

/** 从扩展自带的集中语言事实构建固定规则，SDK 加载状态不参与。 */
export function buildLanguageTokenRules(): readonly SimpleTokenRule[] {
	return [
		...Object.values(languageFacts.words).map((word) => ({ text: word.text, type: word.role as SimpleSemanticTokenType })),
		...languageFacts.operators.map((text) => ({ text, type: "operator" as const }))
	];
}

/** 成员分组保留常量、函数、属性、事件和数据字段的实际身份。 */
function memberStyle(group: LibraryMemberGroup): Pick<SimpleTokenRule, "type" | "modifiers"> {
	switch (group) {
		case "constants":
			return { type: "variable", modifiers: ["readonly"] };
		case "events":
			return { type: "event" };
		case "functions":
			return { type: "method" };
		case "properties":
			return { type: "property" };
		case "variables":
			return { type: "variable" };
	}
}

/** 结合访问方式读取已确认的成员；不能把不可访问成员退化为猜测结果。 */
function resolvedMemberStyle(
	resolved: ResolvedSimpleQualifier,
	name: string,
	analysis: SimpleSourceAnalysis
): Pick<SimpleTokenRule, "type" | "modifiers"> | undefined {
	const groups: readonly LibraryMemberGroup[] = resolved.access === "static"
		? ["constants", "variables", "functions"] : ["constants", "variables", "properties", "functions", "events"];
	for (const group of groups) {
		const value = analysis.members(resolved.reference, group, name).find((entry) => isSimpleMemberAccessible(entry.member, group, resolved.access));
		if (value !== undefined) {
			return memberStyle(group);
		}
	}
	return undefined;
}

/**
 * 根据共享语法与项目符号逐个分类源码位置；不会为某个名字生成全文匹配规则。
 *
 * @param input 文档边界提供的源码与共享词法结果。
 * @param sdk 可选 SDK，只用于补充源码以外的符号。
 * @param context 当前项目的源码单元、继承与组件信息。
 * @returns 每项都具有精确起止位置的语义规则。
 */
function documentTokenRules(input: SimpleUnitHighlightingInput, sdk?: Sdk, context?: SimpleProjectSemanticContext): readonly SimpleTokenRule[] {
	const parsed = analyzeSimpleSourceSyntax(input.userCode, context?.currentUnit?.unitType === "接口", input.userTokens);
	const analysis = createSimpleSourceAnalysis(input.userCode, sdk, context, { syntax: parsed, tokens: input.tokens });
	const syntax = analysis.syntax;
	const definitions = analysis.definitions;
	const rules = new Map<number, SimpleTokenRule>();
	const add = (token: Pick<SimpleSourceToken, "text" | "start" | "end">, style: Pick<SimpleTokenRule, "type" | "modifiers">): void => {
		rules.set(token.start, { text: token.text, start: token.start, end: token.end, ...style });
	};
	const declarationStyle = (declaration: SimpleSourceDeclaration): Pick<SimpleTokenRule, "type" | "modifiers"> => ({
		type: simpleDeclarationRole(declaration),
		modifiers: declaration.kind === "constant" ? ["readonly"] : undefined
	});
	const typeReference = (name: string): LibraryDefinitionReference | undefined => {
		return resolveSimpleDefinitionName(name, definitions);
	};
	const currentReference = context?.currentUnit === undefined ? undefined : definitions.get(context.currentUnit.qualifiedName);
	const words = analysis.expressionTokens;
	const languageWords = new Set(Object.values(languageFacts.words).map((word) => word.text));
	const globals = new Map<string, Pick<SimpleTokenRule, "type" | "modifiers">>();
	const shadowsResourceR = (offset: number): boolean => {
		return !isSimpleResourceRoot(analysis, Math.min(offset, input.userCode.length), context);
	};
	for (const reference of new Set(definitions.values())) {
		for (const group of ["constants", "variables", "functions"] as const) {
			for (const member of reference.definition[group] ?? []) {
				if (member.global === true) {
					globals.set(member.name, group === "functions" ? { type: "function" } : memberStyle(group));
				}
			}
		}
	}

	/* 属性原文的读取与语法映射封闭在属性边界，用户代码解析只接收用户代码区。 */
	for (const span of input.properties) {
		add(span, { type: span.role });
	}
	for (const token of syntax.tokens) {
		const role = syntax.roles.get(token.start);
		if (role !== undefined) {
			add(token, { type: role, modifiers: syntax.declarationAt(token.start)?.kind === "constant" ? ["readonly"] : undefined });
		}
	}

	for (let index = 0; index < words.length; index += 1) {
		const token = words[index]!;
		if (token.kind !== "word" || rules.has(token.start)) {
			continue;
		}
		const previous = words[index - 1];
		const next = words[index + 1];
		const inCode = token.start < input.userCode.length;
		const local = inCode && previous?.text !== "." ? syntax.resolve(token.text, token.start) : undefined;

		/* 项目资源只在完整命中现有资源且 R 未被源码遮蔽时取得资源身份。 */
		if (token.text === "R" && previous?.text !== "." && next?.text === "." && !shadowsResourceR(token.start)) {
			const resource = context?.resources?.symbols.find((value) => value.name === words[index + 2]?.text);
			if (resource !== undefined) {
				add(token, { type: "type" });
				add(words[index + 2]!, { type: "variable", modifiers: ["readonly"] });
			}
			continue;
		}
		if (previous?.text === "." && words[index - 2]?.text === "R" && words[index - 3]?.text !== "." && !shadowsResourceR(token.start)) {
			continue;
		}

		/* 成员位置先解析点号左侧，局部同名参数不能覆盖本对象或其它实例的成员。 */
		if (previous?.text === ".") {
			/* 成员语法先给出稳定底色；元数据只细化，不能删除已确认的语法角色。 */
			add(token, { type: next?.text === "(" ? "method" : "property" });
			const resolved = analysis.memberAt(token.start)?.receiver;
			const style = resolved === undefined ? undefined : resolvedMemberStyle(resolved, token.text, analysis);
			if (style !== undefined) {
				add(token, style);
			} else if (words[index - 2]?.text === "本对象") {
				const field = syntax.declarationsNamed(token.text).find((value) => value.scope === syntax.root && value.kind !== "alias");
				if (field !== undefined) {
					add(token, declarationStyle(field));
				}
			}
			continue;
		}
		if (languageWords.has(token.text)) {
			continue;
		}
		if (local !== undefined) {
			const declaration = local.kind === "functionResult" && next?.text === "("
				? syntax.declarationsNamed(token.text).find((value) => value.scope === syntax.root && value.kind === "function") ?? local
				: local;
			add(token, declarationStyle(declaration));
			continue;
		}

		/* 当前单元及其继承成员来自项目符号模型；组件变量也可在没有 SDK 时识别。 */
		if (currentReference !== undefined) {
			const access = syntax.callableAt(token.start)?.static === true ? "static" : "instance";
			const style = resolvedMemberStyle({ access, directCurrentUnit: true, reference: currentReference }, token.text, analysis);
			if (style !== undefined) {
				add(token, style.type === "method" ? { type: "function" } : style);
				continue;
			}
		}
		/* 限定类型名选择可见的最长前缀，随后成员段仍按成员解析。 */
		let end = index + 1;
		while (words[end]?.text === "." && words[end + 1]?.kind === "word") {
			end += 2;
		}
		for (let length = end; length > index; length -= 2) {
			const name = words.slice(index, length).map((part) => part.text).join("");
			const reference = typeReference(name);
			if (reference !== undefined && isSdkTypeKind(reference.definition.kind)) {
				for (const part of words.slice(index, length)) {
					if (part.kind === "word") {
						add(part, { type: "type" });
					}
				}
				break;
			}
		}
		if (rules.has(token.start)) {
			continue;
		}
		const global = globals.get(token.text);
		if (global !== undefined) {
			add(token, global);
		} else if (inCode && next?.text === "(" && !languageWords.has(token.text)) {
			add(token, { type: "function" });
		}
	}
	return [...rules.values()].sort((left, right) => left.start! - right.start!);
}

/** 仅构建源码语义位置规则，供需要分别核对固定语法与符号分类的消费者使用。 */
export function buildDocumentTokenRules(source: string, sdk?: Sdk, context?: SimpleProjectSemanticContext): readonly SimpleTokenRule[] {
	return documentTokenRules(simpleUnitHighlightingInput(source), sdk, context);
}

/**
 * 单次扫描完成用户代码及完整预览的语义着色，所有分析阶段复用同一令牌流。
 *
 * @param source 分析源码，由单元边界提供用户代码或完整只读预览。
 * @param sdk 可选的外部符号信息。
 * @param context 项目语义快照。
 * @param visibleSource 编辑器可见原文；与分析原文不同才单独扫描以校验位置。
 * @returns 可直接交给编辑器的单行语义令牌。
 */
export function buildSimpleSemanticTokens(source: string, sdk?: Sdk, context?: SimpleProjectSemanticContext, visibleSource = source): readonly SimpleSemanticTokenSpan[] {
	const input = simpleUnitHighlightingInput(source);
	return tokenizeSimpleText(visibleSource, [...buildLanguageTokenRules(), ...documentTokenRules(input, sdk, context)], visibleSource === source ? input.tokens : undefined);
}

/**
 * 在词法令牌位置应用语法结果与固定语言规则；字符串和注释交给 TextMate。
 *
 * @param source 编辑器可见文本。
 * @param rules 固定语言规则与精确源码位置规则。
 * @returns 按行、字符排序且不重叠的语义令牌。
 */
export function tokenizeSimpleText(source: string, rules: readonly SimpleTokenRule[], tokens: readonly SimpleSourceToken[] = scanSimpleSource(source)): readonly SimpleSemanticTokenSpan[] {
	const exact = new Map(rules.filter((rule) => rule.start !== undefined).map((rule) => [rule.start!, rule]));
	const language = new Map(rules.filter((rule) => rule.start === undefined).map((rule) => [rule.text, rule]));
	const spans: SimpleSemanticTokenSpan[] = [];
	let covered = 0;
	let previous: SimpleSourceToken | undefined;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		if (token.start < covered || token.kind === "comment" || token.kind === "string") {
			continue;
		}
		if (token.kind === "continuation") {
			continue;
		}
		const fixed = previous?.text === "." ? undefined : language.get(token.text);
		const rule = exact.get(token.start) ?? fixed;
		previous = token;
		if (rule === undefined) {
			continue;
		}
		const end = rule.end ?? token.end;
		if (end > source.length || source.slice(token.start, end) !== rule.text) {
			continue;
		}
		let type = rule.type;
		if (token.text === "结束" && language.get(tokens[index + 1]?.text ?? "")?.type === "simpleDeclaration") {
			type = "simpleDeclaration";
		}
		spans.push({ line: token.line, character: token.character, length: end - token.start, text: rule.text, type, modifiers: rule.modifiers ?? [] });
		covered = end;
	}
	return spans;
}
