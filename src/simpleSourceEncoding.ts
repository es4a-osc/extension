/*
统一识别并解码 Simple 源文件字节，供项目树、索引和预览复用。
xhwsd@qq.com 2026-8-29
*/

import { TextDecoder } from "node:util";

/** VS Code 与 Simple 源文件读写共同使用的编码名称。 */
export type SimpleSourceEncoding = "utf8" | "utf8bom" | "utf16le" | "utf16be";

/** 没有字节序标记时按 UTF-8 读取。 */
export const DEFAULT_SIMPLE_SOURCE_ENCODING: SimpleSourceEncoding = "utf8";

/** 从字节序标记识别 Simple 源文件编码。 */
export function detectSimpleSourceEncoding(content: Uint8Array): SimpleSourceEncoding {
	if (content[0] === 0xEF && content[1] === 0xBB && content[2] === 0xBF) {
		return "utf8bom";
	}
	if (content[0] === 0xFF && content[1] === 0xFE) {
		return "utf16le";
	}
	if (content[0] === 0xFE && content[1] === 0xFF) {
		return "utf16be";
	}
	return DEFAULT_SIMPLE_SOURCE_ENCODING;
}

/** 按 BOM 或默认 UTF-8 把 Simple 源文件字节解码为内存文本。 */
export function decodeSimpleSource(content: Uint8Array): string {
	const encoding = detectSimpleSourceEncoding(content);
	const label = encoding === "utf16le"
		? "utf-16le"
		: encoding === "utf16be" ? "utf-16be" : "utf-8";
	return new TextDecoder(label).decode(content);
}
