/*
为 Simple 单元提供完整内容和属性 XML 元数据的只读虚拟预览文档。
xhwsd@qq.com 2026-8-27
*/

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
	inspectSimplePropertyXml,
	serializePropertyXml,
	type SimplePropertyXmlParseResult
} from "./propertyXml";
import { decodeSimpleSource } from "./simpleSourceEncoding";

/** 完整单元内容只读预览使用的 URI 协议。 */
export const UNIT_CONTENT_PREVIEW_SCHEME = "es4a-unit-content-preview";

/** 单元属性 XML 元数据只读预览使用的 URI 协议。 */
export const UNIT_XML_PREVIEW_SCHEME = "es4a-unit-xml-preview";

/** 已打开单元提供给只读预览的同一文档状态。 */
export interface BoundUnitPreview {
	readonly property: SimplePropertyXmlParseResult;
	readonly source: string;
}

/** 将源 URI 写入查询参数；预览显示路径只负责标签名和专用图标匹配。 */
function sourceQuery(sourceUri: vscode.Uri): string {
	if (sourceUri.scheme !== "file" || path.extname(sourceUri.fsPath).toLowerCase() !== ".simple") {
		throw new Error("只能预览本地 `.simple` 单元。");
	}

	return `source=${encodeURIComponent(sourceUri.toString())}`;
}

/** 按预览类型生成不会冒充真实 `.simple` 文件的虚拟显示路径。 */
function previewDisplayPath(sourceUri: vscode.Uri, suffix: "完整代码" | "属性"): string {
	const extension = path.posix.extname(sourceUri.path);
	const unitName = path.posix.basename(sourceUri.path, extension);
	return path.posix.join(path.posix.dirname(sourceUri.path), `${unitName}(${suffix})`);
}
/** 把真实单元 URI 转换为完整内容预览 URI。 */
export function toUnitContentPreviewUri(sourceUri: vscode.Uri): vscode.Uri {
	return sourceUri.with({
		fragment: "",
		path: previewDisplayPath(sourceUri, "完整代码"),
		query: sourceQuery(sourceUri),
		scheme: UNIT_CONTENT_PREVIEW_SCHEME
	});
}

/** 把真实单元 URI 转换为 XML 元数据预览 URI。 */
export function toUnitXmlPreviewUri(sourceUri: vscode.Uri): vscode.Uri {
	return sourceUri.with({
		fragment: "",
		path: previewDisplayPath(sourceUri, "属性"),
		query: sourceQuery(sourceUri),
		scheme: UNIT_XML_PREVIEW_SCHEME
	});
}

/** 从两个预览协议还原绑定的真实本地单元 URI。 */
export function toUnitPreviewSourceUri(uri: vscode.Uri): vscode.Uri | undefined {
	if (uri.scheme !== UNIT_CONTENT_PREVIEW_SCHEME && uri.scheme !== UNIT_XML_PREVIEW_SCHEME) {
		return undefined;
	}

	const prefix = "source=";
	if (!uri.query.startsWith(prefix)) {
		return undefined;
	}

	try {
		const sourceUri = vscode.Uri.parse(decodeURIComponent(uri.query.slice(prefix.length)));
		return sourceUri.scheme === "file" && path.extname(sourceUri.fsPath).toLowerCase() === ".simple"
			? sourceUri
			: undefined;
	} catch {
		return undefined;
	}
}


/** 转义预览 XML 中的文本节点。 */
function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

/** 为已删除或暂时不可读取的单元生成明确的 XML 预览状态。 */
function unavailableXml(message: string): string {
	return [
		"<属性 状态=\"不可用\">",
		`\t<解析问题>${escapeXml(message)}</解析问题>`,
		"</属性>"
	].join("\r\n");
}

/**
 * 为内容预览和 XML 元数据预览提供无锁图标的只读文本，并按真实源文件刷新已打开文档。
 */
export class UnitPreviewProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
	private readonly previewSources = new Map<string, vscode.Uri>();
	private readonly previewsBySource = new Map<string, Map<string, vscode.Uri>>();
	private readonly sourceWatchers = new Map<string, fs.FSWatcher>();

	readonly onDidChange = this.changeEmitter.event;

	/** 注入未保存标签页状态读取器，使预览与设计器共享同一文档版本。 */
	constructor(
		private readonly readBoundSource: (sourceUri: vscode.Uri) => BoundUnitPreview | undefined = () => undefined
	) {}

	/** 优先从绑定标签页读取未保存单元，否则读取真实文件。 */
	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		const sourceUri = this.resolveSourceUri(uri);
		if (sourceUri === undefined) {
			throw vscode.FileSystemError.Unavailable(`无效的单元预览 URI：${uri.toString()}`);
		}

		this.track(sourceUri, uri);
		let source: string;
		let property: SimplePropertyXmlParseResult | undefined;
		try {
			const bound = this.readBoundSource(sourceUri);
			source = bound?.source
				?? decodeSimpleSource(await vscode.workspace.fs.readFile(sourceUri));
			property = bound?.property;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return uri.scheme === UNIT_CONTENT_PREVIEW_SCHEME
				? `' 单元源文件暂时不可用：${message}\r\n`
				: unavailableXml(message);
		}
		if (uri.scheme === UNIT_CONTENT_PREVIEW_SCHEME) {
			return source;
		}

		property ??= inspectSimplePropertyXml(source);
		return property.document === undefined
			? unavailableXml(property.issues.join("；") || "属性区无法解析。")
			: serializePropertyXml(property.document);
	}

	/** 返回预览当前绑定的真实单元；移动后的旧预览 URI 仍解析到新路径。 */
	resolveSourceUri(previewUri: vscode.Uri): vscode.Uri | undefined {
		return this.previewSources.get(previewUri.toString()) ?? toUnitPreviewSourceUri(previewUri);
	}

	/** 在单元移动、撤销或重做时迁移已打开预览的真实源路径并立即刷新。 */
	moveSource(oldSourceUri: vscode.Uri, newSourceUri: vscode.Uri): void {
		const oldKey = oldSourceUri.toString();
		const previews = this.previewsBySource.get(oldKey);
		if (previews === undefined || previews.size === 0) {
			return;
		}

		this.previewsBySource.delete(oldKey);
		this.sourceWatchers.get(oldKey)?.close();
		this.sourceWatchers.delete(oldKey);
		for (const previewUri of previews.values()) {
			this.previewSources.set(previewUri.toString(), newSourceUri);
			this.track(newSourceUri, previewUri);
			this.changeEmitter.fire(previewUri);
		}
	}

	/** 通知 VS Code 重新读取指定真实单元关联的全部预览。 */
	refreshSource(sourceUri: vscode.Uri): void {
		for (const previewUri of this.previewsBySource.get(sourceUri.toString())?.values() ?? []) {
			this.changeEmitter.fire(previewUri);
		}
	}

	/** 关闭最后一个关联预览后释放真实单元的文件监听器。 */
	closePreview(previewUri: vscode.Uri): void {
		const sourceUri = this.resolveSourceUri(previewUri);
		if (sourceUri === undefined) {
			return;
		}
		this.previewSources.delete(previewUri.toString());

		const sourceKey = sourceUri.toString();
		const previews = this.previewsBySource.get(sourceKey);
		previews?.delete(previewUri.toString());
		if ((previews?.size ?? 0) > 0) {
			return;
		}

		this.previewsBySource.delete(sourceKey);
		this.sourceWatchers.get(sourceKey)?.close();
		this.sourceWatchers.delete(sourceKey);
	}

	/** 释放预览 URI 索引和事件资源。 */
	dispose(): void {
		for (const watcher of this.sourceWatchers.values()) {
			watcher.close();
		}
		this.sourceWatchers.clear();
		this.previewSources.clear();
		this.previewsBySource.clear();
		this.changeEmitter.dispose();
	}

	/** 记录真实单元到预览 URI 的稳定映射。 */
	private track(sourceUri: vscode.Uri, previewUri: vscode.Uri): void {
		const sourceKey = sourceUri.toString();
		this.previewSources.set(previewUri.toString(), sourceUri);
		const previews = this.previewsBySource.get(sourceKey) ?? new Map<string, vscode.Uri>();
		previews.set(previewUri.toString(), previewUri);
		this.previewsBySource.set(sourceKey, previews);

		if (!this.sourceWatchers.has(sourceKey)) {
			try {
				const watcher = fs.watch(sourceUri.fsPath, { persistent: false }, () => {
					this.refreshSource(sourceUri);
				});
				watcher.on("error", () => {
					if (this.sourceWatchers.get(sourceKey) === watcher) {
						this.sourceWatchers.delete(sourceKey);
					}
					watcher.close();
				});
				this.sourceWatchers.set(sourceKey, watcher);
			} catch {
				// VS Code 保存事件仍会刷新预览；文件系统不支持监视时无需阻断打开。
			}
		}
	}
}
