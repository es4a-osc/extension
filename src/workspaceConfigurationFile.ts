/*
在保留 JSONC 注释和其它配置的前提下，完整更新工作区配置文件中的单个设置。
xhwsd@qq.com 2026-10-7
*/

import {
	applyEdits,
	modify,
	parse,
	type FormattingOptions,
	type JSONPath,
	type ParseError
} from "jsonc-parser";

/** 根据原文件选择换行格式，并使用 VS Code 配置文件的四空格缩进。 */
function formattingOptions(source: string): FormattingOptions {
	return {
		eol: source.includes("\r\n") ? "\r\n" : "\n",
		insertSpaces: true,
		tabSize: 4
	};
}

/** 读取磁盘上的实际配置，避免 VS Code 延迟通知把刚写入的项目列表回滚为旧缓存。 */
export function readWorkspaceConfigurationJsonc(source: string, propertyPath: JSONPath): unknown {
	const errors: ParseError[] = [];
	let value: unknown = parse(source.replace(/^\uFEFF/u, ""), errors, { allowTrailingComma: true, disallowComments: false, allowEmptyContent: true });
	if (value === undefined && errors.length === 0) return undefined;
	if (errors.length > 0 || typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("工作区配置文件不是有效的 JSONC 对象。");
	}
	for (const property of propertyPath) {
		if (typeof value !== "object" || value === null) return undefined;
		value = (value as Record<string | number, unknown>)[property];
	}
	return value;
}

/**
 * 更新 JSONC 工作区文件中的一个值。
 *
 * 文件损坏或根节点不是对象时拒绝覆盖，避免为了写 ES4A 设置破坏用户其它配置。
 */
export function updateWorkspaceConfigurationJsonc(
	source: string,
	propertyPath: JSONPath,
	value: unknown
): string {
	const options = formattingOptions(source);
	const byteOrderMark = source.startsWith("\uFEFF") ? "\uFEFF" : "";
	const text = source.slice(byteOrderMark.length);
	const content = text.trim().length === 0 ? `{${options.eol}}${options.eol}` : text;
	const errors: ParseError[] = [];
	const parsed = parse(content, errors, {
		allowTrailingComma: true,
		disallowComments: false,
		allowEmptyContent: true
	});
	if (errors.length > 0 || parsed !== undefined && (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))) {
		throw new Error("工作区配置文件不是有效的 JSONC 对象，已拒绝写入 ES4A 设置。");
	}

	return byteOrderMark + applyEdits(content, modify(content, propertyPath, value, { formattingOptions: options }));
}
