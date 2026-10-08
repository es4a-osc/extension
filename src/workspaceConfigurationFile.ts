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
	const content = source.trim().length === 0 ? `{${options.eol}}${options.eol}` : source;
	const errors: ParseError[] = [];
	const parsed = parse(content, errors, {
		allowTrailingComma: true,
		disallowComments: false
	});
	if (errors.length > 0 || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("工作区配置文件不是有效的 JSONC 对象，已拒绝写入 ES4A 设置。");
	}

	return applyEdits(content, modify(content, propertyPath, value, { formattingOptions: options }));
}
