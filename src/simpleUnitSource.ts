/*
切分并重新组装 Simple 单元的用户代码与属性区。
xhwsd@qq.com 2026-8-27
*/

/** Simple 单元中可编辑的用户代码和必须无损保留的属性原文。 */
export interface SimpleUnitSourceSections {
	readonly propertySource: string;
	readonly userCode: string;
}

/**
 * 按当前 Simple 编译器的规则定位属性区起点。
 *
 * 编译器把源文中倒数第二次出现的 `$属性` 视为属性区开头；最后一次通常来自
 * `$结束 $属性`。属性区损坏而只剩独立起始标记时仍以该行作为边界，使代码标签
 * 可以打开并在保存时原样保留损坏的属性原文。
 */
export function findPropertySectionStart(source: string): number {
	const lastPropertyMarker = source.lastIndexOf("$属性");

	if (lastPropertyMarker < 0) {
		return source.length;
	}

	const propertySectionStart = source.lastIndexOf("$属性", lastPropertyMarker - 1);
	if (propertySectionStart >= 0) {
		return propertySectionStart;
	}

	const standaloneMarker = /(?:^|(\r\n|\n|\r))[ \t]*\$属性[ \t]*(?=\r\n|\n|\r|$)/gu.exec(source);
	return standaloneMarker === null
		? source.length
		: standaloneMarker.index + (standaloneMarker[1]?.length ?? 0);
}

/** 将完整 `.simple` 原文切分为用户代码和属性区原文。 */
export function splitSimpleUnitSource(source: string): SimpleUnitSourceSections {
	const propertySectionStart = findPropertySectionStart(source);

	return {
		propertySource: source.slice(propertySectionStart),
		userCode: source.slice(0, propertySectionStart)
	};
}

/**
 * 返回虚拟编辑器应显示的用户代码。
 *
 * 代码视图与物理用户代码区保持相同的行尾，不再隐去属性区之前的最后一个换行。
 * 保存时复用已有换行，避免把结构分隔再次写成额外空白行。
 */
export function getVisibleSimpleUnitUserCode(source: string): string {
	return splitSimpleUnitSource(source).userCode;
}

/** 从原代码区提取最后使用的换行符，无换行时遵循项目的 CRLF 默认。 */
export function detectSimpleLineEnding(source: string): string {
	let lineEnding = "\r\n";
	const matches = source.matchAll(/\r\n|\n|\r/gu);

	for (const match of matches) {
		lineEnding = match[0];
	}

	return lineEnding;
}

/** 优先复用原属性区边界的换行，兼容代码区和属性区换行格式不同的历史单元。 */
function detectPropertyBoundaryLineEnding(source: string): string {
	const sections = splitSimpleUnitSource(source);
	const boundary = sections.propertySource.length > 0
		? sections.userCode.match(/(?:\r\n|\n|\r)$/u)?.[0]
		: undefined;
	return boundary ?? detectSimpleLineEnding(source);
}

/** 保持真实源文的 UTF-8 BOM 状态，避免虚拟文档保存时意外改变编码标记。 */
function preserveByteOrderMark(source: string, userCode: string): string {
	const sourceHasByteOrderMark = source.startsWith("\uFEFF");
	const codeWithoutByteOrderMark = userCode.startsWith("\uFEFF") ? userCode.slice(1) : userCode;
	return sourceHasByteOrderMark ? `\uFEFF${codeWithoutByteOrderMark}` : codeWithoutByteOrderMark;
}

/**
 * 使用指定的用户代码和属性源码重新组装完整 Simple 单元。
 *
 * 用户代码中的换行、空行和空白一律原样保留；只有非空代码末尾缺少换行时才补齐
 * 与属性区的物理行分隔，不重复添加已有换行。
 */
export function assembleSimpleUnitSource(
	source: string,
	userCode: string,
	propertySource: string,
	lineEnding?: string
): string {
	const hasPropertySection = propertySource.length > 0;
	let normalizedUserCode = preserveByteOrderMark(
		source,
		userCode
	);
	const userCodeContent = normalizedUserCode.startsWith("\uFEFF")
		? normalizedUserCode.slice(1)
		: normalizedUserCode;

	if (
		hasPropertySection
		&& userCodeContent.length > 0
		&& !/[\r\n]$/u.test(userCodeContent)
	) {
		normalizedUserCode += lineEnding ?? (/[\r\n]/u.test(userCodeContent) ? detectSimpleLineEnding(userCodeContent) : detectPropertyBoundaryLineEnding(source));
	}

	return normalizedUserCode + propertySource;
}

/** 保留真实文件中的属性原文，只替换用户代码。 */
export function mergeSimpleUnitUserCode(source: string, userCode: string): string {
	return assembleSimpleUnitSource(
		source,
		userCode,
		splitSimpleUnitSource(source).propertySource
	);
}
