/*
校验 SDK 组件 SVG，并生成适用于 VS Code 树和设计器 Webview 的安全图标资源。
xhwsd@qq.com 2026-8-29
*/

import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import type { LibraryDefinitionReference } from "./sdk";

/** VS Code 明暗主题中用于外部 SVG 树图标的稳定前景色。 */
const LIGHT_THEME_ICON_COLOR = "#424242";
const DARK_THEME_ICON_COLOR = "#c5c5c5";

/** 拒绝会使 SVG 脱离纯路径图标边界的活动内容或外部资源。 */
const UNSAFE_SVG_PATTERN = /<(?:script|foreignObject|iframe|object|embed|image|style|a)\b|\bon[a-z]+\s*=|\b(?:href|xlink:href)\s*=|url\s*\(/iu;

/** 按文件时间缓存的已校验 SVG 文本。 */
interface CachedSvg {
	readonly modifiedAt: number;
	readonly source?: string;
}

/** 同一 SDK 图标会被多个界面重复消费，按文件修改时间复用已校验文本。 */
const svgCache = new Map<string, CachedSvg>();

/** 一个 SVG 在树和 Webview 中需要的主题化数据源。 */
export interface ComponentIconSources {
	readonly dark: string;
	readonly light: string;
	readonly mask: string;
}

/** 判断候选文件是否位于声明它的清单目录内部。 */
function isPathInside(directoryPath: string, filePath: string): boolean {
	const relativePath = path.relative(path.resolve(directoryPath), path.resolve(filePath));
	return relativePath.length > 0
		&& !path.isAbsolute(relativePath)
		&& relativePath !== ".."
		&& !relativePath.startsWith(`..${path.sep}`);
}

/** 读取并限制为 24×24、无活动内容的内联 SVG。 */
function readSafeSvg(filePath: string): string | undefined {
	try {
		const stats = statSync(filePath);
		if (!stats.isFile() || stats.size > 32 * 1024) return undefined;
		const cached = svgCache.get(filePath);
		if (cached?.modifiedAt === stats.mtimeMs) return cached.source;

		const source = readFileSync(filePath, "utf8");
		const safe = /<svg\b/iu.test(source)
			&& /\bviewBox\s*=\s*["']0\s+0\s+24\s+24["']/iu.test(source)
			&& /<\/svg\s*>\s*$/iu.test(source)
			&& !UNSAFE_SVG_PATTERN.test(source);
		const normalized = safe
			? source
				.replace(/\s(?:width|height)\s*=\s*["'][^"']*["']/giu, "")
				.replace(/\sclass\s*=\s*["'][^"']*["']/giu, "")
				.trim()
			: undefined;
		svgCache.set(filePath, { modifiedAt: stats.mtimeMs, source: normalized });
		return normalized;
	} catch {
		return undefined;
	}
}

/** 把 SVG 文本编码为不会执行活动内容的图片数据 URI。 */
function svgDataUri(source: string, color: string): string {
	return `data:image/svg+xml,${encodeURIComponent(source.replaceAll("currentColor", color))}`;
}

/**
 * 按清单相对路径语义解析一个组件定义的 SVG。
 *
 * 绝对路径、越出清单目录、非 SVG、缺失或不完整文件和不安全内容统一视为没有有效图标。
 */
export function resolveDefinitionIconPath(reference: LibraryDefinitionReference | undefined): string | undefined {
	if (reference === undefined) return undefined;
	const icon = reference.definition.icon;
	if (typeof icon !== "string" || icon.length === 0 || path.isAbsolute(icon)) return undefined;
	const resolvedPath = path.resolve(reference.manifest.directory, icon);
	if (path.extname(resolvedPath).toLowerCase() !== ".svg") return undefined;
	if (!isPathInside(reference.manifest.directory, resolvedPath)) return undefined;
	return readSafeSvg(resolvedPath) === undefined ? undefined : resolvedPath;
}

/** 使用声明图标，并在调用方提供时使用其缺省图标，生成明暗主题与遮罩数据源。 */
export function createComponentIconSources(
	iconPath: string | undefined,
	defaultIconPath?: string
): ComponentIconSources | undefined {
	const source = (iconPath === undefined ? undefined : readSafeSvg(iconPath))
		?? (defaultIconPath === undefined ? undefined : readSafeSvg(defaultIconPath));
	if (source === undefined) return undefined;
	return {
		dark: svgDataUri(source, DARK_THEME_ICON_COLOR),
		light: svgDataUri(source, LIGHT_THEME_ICON_COLOR),
		mask: svgDataUri(source, "#000000")
	};
}
