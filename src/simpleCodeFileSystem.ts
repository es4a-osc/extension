/*
将真实 `.simple` 单元映射为只展示用户代码且可安全保存的虚拟文档。
xhwsd@qq.com 2026-9-1
*/

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { KeyedTaskQueue } from "./keyedTaskQueue";
import { resolvePropertySourceFormatting } from "./propertyFormatting";
import {
	inspectSimplePropertyXml,
	serializeSimplePropertySource,
	type SimplePropertySourceFormatting,
	type SimplePropertyXmlDocument,
	type SimplePropertyXmlParseResult
} from "./propertyXml";
import {
	assembleSimpleUnitSource,
	getVisibleSimpleUnitUserCode,
	splitSimpleUnitSource
} from "./simpleUnitSource";
import { detectSimpleSourceEncoding } from "./simpleSourceEncoding";

/** 用户代码虚拟文档的 URI 协议。 */
export const SIMPLE_CODE_SCHEME = "simple-code";

/** 生成不会冒充真实文件、可匹配 `*(代码)` 图标且能还原真实单元路径的虚拟路径。 */
function codeDisplayPath(sourceUri: vscode.Uri): string {
	const extension = path.posix.extname(sourceUri.path);
	const unitName = path.posix.basename(sourceUri.path, extension);
	return path.posix.join(path.posix.dirname(sourceUri.path), `${unitName}(代码)`);
}

/** 生成从创建时就能显示正确标签名、同时仍可还原真实单元的设计器路径。 */
function designerDisplayPath(sourceUri: vscode.Uri): string {
	const extension = path.posix.extname(sourceUri.path);
	const unitName = path.posix.basename(sourceUri.path, extension);
	return path.posix.join(path.posix.dirname(sourceUri.path), `${unitName}(设计器)`);
}

/** 真实 Simple 文件监视器及其虚拟文档引用计数。 */
interface SourceWatcher {
	readonly watcher: fs.FSWatcher;
	references: number;
}

/** 绑定到用户代码标签页、等待用户保存的 XML 属性修改。 */
interface PendingPropertyEdit {
	readonly formatting: SimplePropertySourceFormatting;
	readonly history: readonly SimplePropertyXmlDocument[];
	readonly userCodeHistory: readonly string[];
	readonly index: number;
}

/** 由设计器独立持有、等待设计器标签保存的 XML 属性修改。 */
interface PendingDesignerPropertyEdit {
	readonly basePropertySource: string;
	readonly document: SimplePropertyXmlDocument;
	readonly formatting: SimplePropertySourceFormatting;
}

/** 仅在用户代码文档打开期间存在的单元状态。 */
interface SimpleDocumentSession {
	basePropertySource: string;
	designerPropertyEdit?: PendingDesignerPropertyEdit;
	documentEncoding?: string;
	pendingPropertyEdit?: PendingPropertyEdit;
	property: SimplePropertyXmlParseResult;
	sourceEncoding: string;
	userCodeSnapshot: string;
}

/** 同一打开单元提供给完整代码和 XML 属性预览的原子状态。 */
export interface SimpleBoundUnitPreview {
	readonly property: SimplePropertyXmlParseResult;
	readonly source: string;
}

/** 返回当前撤销位置对应的 XML 属性模型。 */
function pendingPropertyDocument(edit: PendingPropertyEdit): SimplePropertyXmlDocument {
	return edit.history[edit.index] ?? edit.history[0]!;
}

/** 只在保存边界把当前 XML 属性状态转换为 Simple 属性代码。 */
function pendingPropertySource(edit: PendingPropertyEdit): string {
	return serializeSimplePropertySource(pendingPropertyDocument(edit), edit.formatting);
}

/** 返回会话当前撤销位置唯一对应的 XML 属性状态。 */
function sessionProperty(session: SimpleDocumentSession): SimplePropertyXmlParseResult {
	const propertyDocument = session.designerPropertyEdit?.document
		?? (session.pendingPropertyEdit === undefined
			? session.property.document
			: pendingPropertyDocument(session.pendingPropertyEdit));
	return propertyDocument === undefined
		? session.property
		: {
			document: propertyDocument,
			issues: propertyDocument.issues,
			status: propertyDocument.status
		};
}

/** 令不支持的虚拟文件系统修改以统一的权限错误失败。 */
function noPermissions(uri: vscode.Uri): never {
	throw vscode.FileSystemError.NoPermissions(`用户代码文档不支持此操作：${uri.toString()}`);
}

/** 为 Windows 文件系统生成大小写无关的内部索引。 */
function uriKey(uri: vscode.Uri): string {
	const value = uri.toString();
	return process.platform === "win32" ? value.toLowerCase() : value;
}

/** 为允许撤销和重做的真实单元路径对生成方向无关索引。 */
function unitRenameKey(left: vscode.Uri, right: vscode.Uri): string {
	const values = [left.fsPath, right.fsPath]
		.map((value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value))
		.sort();
	return values.join("\u0000");
}

/** 把真实本地单元 URI 转换为用户代码虚拟 URI。 */
export function toSimpleCodeUri(sourceUri: vscode.Uri): vscode.Uri {
	if (sourceUri.scheme !== "file") {
		throw new Error("只能为本地 `.simple` 文件创建用户代码文档。");
	}

	return sourceUri.with({
		fragment: "",
		path: codeDisplayPath(sourceUri),
		query: "",
		scheme: SIMPLE_CODE_SCHEME
	});
}

/** 把真实本地单元 URI 转换为设计器标签专用 URI。 */
export function toSimpleDesignerUri(sourceUri: vscode.Uri): vscode.Uri {
	if (sourceUri.scheme !== "file" || path.extname(sourceUri.fsPath).toLowerCase() !== ".simple") {
		throw new Error("只能为本地 `.simple` 文件创建设计器文档。");
	}

	return sourceUri.with({
		fragment: "",
		path: designerDisplayPath(sourceUri),
		query: `source=${encodeURIComponent(sourceUri.toString())}`,
		scheme: SIMPLE_CODE_SCHEME
	});
}

/** 将真实文件、用户代码或设计器虚拟 URI 解析为真实本地文件 URI。 */
export function toSimpleSourceUri(uri: vscode.Uri): vscode.Uri | undefined {
	if (uri.scheme === "file") {
		return uri;
	}

	if (uri.scheme !== SIMPLE_CODE_SCHEME) {
		return undefined;
	}
	const prefix = "source=";
	const query = uri.query.startsWith(prefix)
		? uri.query
		: (() => {
			try {
				return decodeURIComponent(uri.query);
			} catch {
				return uri.query;
			}
		})();
	if (query.startsWith(prefix)) {
		try {
			const sourceUri = vscode.Uri.parse(decodeURIComponent(query.slice(prefix.length)));
			return sourceUri.scheme === "file" && path.extname(sourceUri.fsPath).toLowerCase() === ".simple"
				? sourceUri
				: undefined;
		} catch {
			return undefined;
		}
	}

	// 新 URI 直接从可逆显示路径还原；也兼容旧版本遗留的 `.simple` 虚拟路径。
	const displaySuffix = ["(代码)", "(设计器)"].find((suffix) => uri.path.endsWith(suffix));
	const sourcePath = displaySuffix === undefined
		? uri.path
		: `${uri.path.slice(0, -displaySuffix.length)}.simple`;
	const sourceUri = uri.with({
		fragment: "",
		path: sourcePath,
		query: "",
		scheme: "file"
	});
	return path.extname(sourceUri.fsPath).toLowerCase() === ".simple"
		? sourceUri
		: undefined;
}

/**
 * 为 VS Code 提供可编辑的 Simple 用户代码文档。
 *
 * 真实 `.simple` 始终是唯一磁盘数据源。读取时隐藏 XML 属性区；编辑期间将 XML 属性修改
 * 绑定到标签页，保存时再与用户代码一起组装。没有修改的区域逐字保留。
 */
export class SimpleCodeFileSystemProvider implements vscode.FileSystemProvider, vscode.Disposable {
	private readonly allowedUnitRenames = new Set<string>();
	private readonly changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	private readonly documentSessions = new Map<string, SimpleDocumentSession>();
	private readonly designerDocumentReferences = new Map<string, number>();
	private readonly persistenceOperations = new KeyedTaskQueue();
	private readonly propertyDirtyTransactions = new Set<string>();
	private readonly sourceWatchers = new Map<string, SourceWatcher>();

	readonly onDidChangeFile = this.changeEmitter.event;

	/** 通知 VS Code 同一路径的真实单元已经重新创建，清除虚拟代码和设计器 URI 的失效缓存。 */
	notifySourceCreated(sourceUri: vscode.Uri): void {
		this.requireLocalSource(sourceUri);
		this.changeEmitter.fire([
			{ type: vscode.FileChangeType.Created, uri: toSimpleCodeUri(sourceUri) },
			{ type: vscode.FileChangeType.Created, uri: toSimpleDesignerUri(sourceUri) }
		]);
	}

	/** 通知 VS Code 真实单元已经删除，使旧路径的代码和设计器 URI 立即失效。 */
	notifySourceDeleted(sourceUri: vscode.Uri): void {
		this.requireLocalSource(sourceUri);
		this.changeEmitter.fire([
			{ type: vscode.FileChangeType.Deleted, uri: toSimpleCodeUri(sourceUri) },
			{ type: vscode.FileChangeType.Deleted, uri: toSimpleDesignerUri(sourceUri) }
		]);
	}

	/** 通知 VS Code 一次由命令层完成的真实单元改名。 */
	notifySourceMoved(oldSourceUri: vscode.Uri, newSourceUri: vscode.Uri): void {
		this.requireLocalSource(oldSourceUri);
		this.requireLocalSource(newSourceUri);
		this.changeEmitter.fire([
			{ type: vscode.FileChangeType.Deleted, uri: toSimpleCodeUri(oldSourceUri) },
			{ type: vscode.FileChangeType.Deleted, uri: toSimpleDesignerUri(oldSourceUri) },
			{ type: vscode.FileChangeType.Created, uri: toSimpleCodeUri(newSourceUri) },
			{ type: vscode.FileChangeType.Created, uri: toSimpleDesignerUri(newSourceUri) }
		]);
	}

	/** 返回真实单元当前打开的用户代码文档。 */
	getOpenDocument(sourceUri: vscode.Uri): vscode.TextDocument | undefined {
		const documentUri = toSimpleCodeUri(sourceUri);
		return vscode.workspace.textDocuments.find(
			(candidate) => uriKey(candidate.uri) === uriKey(documentUri)
		);
	}

	/** 判断单元当前是否存在尚未写入真实文件的代码或设计器修改。 */
	hasUnsavedChanges(sourceUri: vscode.Uri): boolean {
		const documentUri = toSimpleCodeUri(sourceUri);
		const document = this.getOpenDocument(sourceUri);
		const session = this.documentSessions.get(uriKey(documentUri));
		return document?.isDirty === true || session?.designerPropertyEdit !== undefined;
	}

	/** 允许一次受控单元移动，并保留路径对以支持 VS Code 撤销和重做。 */
	allowUnitRename(
		oldSourceUri: vscode.Uri,
		newSourceUri: vscode.Uri
	): vscode.Disposable {
		const key = unitRenameKey(oldSourceUri, newSourceUri);
		this.allowedUnitRenames.add(key);
		return new vscode.Disposable(() => {
			this.allowedUnitRenames.delete(key);
		});
	}

	/** 返回当前打开代码文档共享的 XML 属性状态。 */
	getProperty(document: vscode.TextDocument): SimplePropertyXmlParseResult | undefined {
		if (document.uri.scheme !== SIMPLE_CODE_SCHEME) {
			return undefined;
		}
		const session = this.documentSessions.get(uriKey(document.uri));
		if (session === undefined) {
			return undefined;
		}
		session.documentEncoding = document.encoding;
		return sessionProperty(session);
	}

	/**
	 * 保留设计器使用的共享单元会话。
	 *
	 * 自定义设计器不再依赖可见文本编辑器，因此代码标签关闭时仍要保留同一份 XML 状态。
	 */
	retainDesignerDocument(document: vscode.TextDocument): vscode.Disposable {
		if (document.uri.scheme !== SIMPLE_CODE_SCHEME) {
			throw new Error("设计器只能绑定 Simple 用户代码文档。");
		}
		const key = uriKey(document.uri);
		this.designerDocumentReferences.set(key, (this.designerDocumentReferences.get(key) ?? 0) + 1);
		return new vscode.Disposable(() => this.releaseDesignerDocument(key));
	}

	/**
	 * 应用一次设计器独立 XML 修改；只有组件改名等跨区操作才同时修改用户代码。
	 *
	 * XML 修改不会借用代码编辑器制造脏状态，设计器 Provider 通过 CustomDocument 自己登记撤销。
	 */
	async applyDesignerPropertyEdit(
		document: vscode.TextDocument,
		currentPropertyDocument: SimplePropertyXmlDocument,
		updatedPropertyDocument: SimplePropertyXmlDocument,
		updatedUserCode: string
	): Promise<void> {
		const session = this.requireDocumentSession(document);
		if (sessionProperty(session).document !== currentPropertyDocument) {
			throw new Error("当前 XML 属性状态已经变化，请按最新状态重试。");
		}

		/* 旧的代码标签 XML 事务已经保存时，开始独立设计器事务前收口为当前磁盘基线。 */
		if (session.designerPropertyEdit === undefined && session.pendingPropertyEdit !== undefined) {
			const pendingSource = pendingPropertySource(session.pendingPropertyEdit);
			if (pendingSource !== session.basePropertySource) {
				throw new Error("用户代码标签还有未保存的 XML 修改，请先保存后再操作设计器。");
			}
			const currentDocument = pendingPropertyDocument(session.pendingPropertyEdit);
			session.property = {
				document: currentDocument,
				issues: currentDocument.issues,
				status: currentDocument.status
			};
			session.pendingPropertyEdit = undefined;
		}

		const previousDesignerEdit = session.designerPropertyEdit;
		session.designerPropertyEdit = {
			basePropertySource: previousDesignerEdit?.basePropertySource ?? session.basePropertySource,
			document: updatedPropertyDocument,
			formatting: previousDesignerEdit?.formatting ?? resolvePropertySourceFormatting(document)
		};

		if (document.getText() === updatedUserCode) {
			return;
		}

		const edit = new vscode.WorkspaceEdit();
		edit.replace(
			document.uri,
			new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
			updatedUserCode
		);
		try {
			if (await vscode.workspace.applyEdit(edit)) {
				return;
			}
		} catch (error) {
			session.designerPropertyEdit = previousDesignerEdit;
			throw new Error("无法同步设计器产生的用户代码修改。", { cause: error });
		}
		session.designerPropertyEdit = previousDesignerEdit;
		throw new Error("无法同步设计器产生的用户代码修改。");
	}

	/** 把设计器 XML 状态切换到指定版本，供 CustomDocument 撤销和重做使用。 */
	setDesignerPropertyDocument(
		document: vscode.TextDocument,
		currentPropertyDocument: SimplePropertyXmlDocument,
		updatedPropertyDocument: SimplePropertyXmlDocument
	): void {
		const session = this.requireDocumentSession(document);
		if (sessionProperty(session).document !== currentPropertyDocument) {
			throw new Error("当前 XML 属性状态已经变化，无法继续撤销或重做。");
		}
		const previousDesignerEdit = session.designerPropertyEdit;
		session.designerPropertyEdit = {
			basePropertySource: previousDesignerEdit?.basePropertySource ?? session.basePropertySource,
			document: updatedPropertyDocument,
			formatting: previousDesignerEdit?.formatting ?? resolvePropertySourceFormatting(document)
		};
	}

	/** 只保存设计器负责的 XML 属性区，并逐字保留磁盘上的用户代码区。 */
	async saveDesignerProperty(document: vscode.TextDocument): Promise<void> {
		await this.enqueuePersistence(document.uri, () => this.saveDesignerPropertyNow(document));
	}

	/** 在统一持久化队列内执行设计器属性区保存。 */
	private async saveDesignerPropertyNow(document: vscode.TextDocument): Promise<void> {
		const session = this.requireDocumentSession(document);
		const pending = session.designerPropertyEdit;
		if (pending === undefined) {
			return;
		}
		const sourceUri = this.requireSourceUri(document.uri);
		const sourceBytes = await vscode.workspace.fs.readFile(sourceUri);
		const sourceEncoding = detectSimpleSourceEncoding(sourceBytes);
		const source = await vscode.workspace.decode(sourceBytes, { encoding: sourceEncoding });
		const currentPropertySource = splitSimpleUnitSource(source).propertySource;
		if (currentPropertySource !== pending.basePropertySource) {
			throw vscode.FileSystemError.Unavailable(
				"真实 `.simple` 文件的 XML 属性区已在磁盘上修改，请重新打开后再保存。"
			);
		}
		const writtenPropertySource = serializeSimplePropertySource(pending.document, pending.formatting);
		const mergedSource = assembleSimpleUnitSource(
			source,
			getVisibleSimpleUnitUserCode(source),
			writtenPropertySource
		);
		await vscode.workspace.fs.writeFile(
			sourceUri,
			await vscode.workspace.encode(mergedSource, { encoding: sourceEncoding })
		);
		session.basePropertySource = writtenPropertySource;
		session.designerPropertyEdit = undefined;
		session.property = {
			document: pending.document,
			issues: pending.document.issues,
			status: pending.document.status
		};
		session.sourceEncoding = sourceEncoding;
	}

	/** 将当前设计器状态写到另一个真实单元文件，不改变原设计器文档的修改状态。 */
	async saveDesignerPropertyAs(document: vscode.TextDocument, destination: vscode.Uri): Promise<void> {
		await this.enqueuePersistence(document.uri, async () => {
			const session = this.requireDocumentSession(document);
			const source = await this.designerUnitSource(document);
			const destinationUri = destination.scheme === SIMPLE_CODE_SCHEME
				? this.requireSourceUri(destination)
				: destination;
			await vscode.workspace.fs.writeFile(
				destinationUri,
				await vscode.workspace.encode(source, { encoding: session.sourceEncoding })
			);
		});
	}

	/** 放弃设计器独立修改并重新读取磁盘属性区，不影响尚未保存的用户代码。 */
	async revertDesignerProperty(document: vscode.TextDocument): Promise<void> {
		await this.enqueuePersistence(document.uri, () => this.revertDesignerPropertyNow(document));
	}

	/** 在统一持久化队列内恢复设计器属性区。 */
	private async revertDesignerPropertyNow(document: vscode.TextDocument): Promise<void> {
		const session = this.requireDocumentSession(document);
		const sourceUri = this.requireSourceUri(document.uri);
		const sourceBytes = await vscode.workspace.fs.readFile(sourceUri);
		const sourceEncoding = detectSimpleSourceEncoding(sourceBytes);
		const source = await vscode.workspace.decode(sourceBytes, { encoding: sourceEncoding });
		const sections = splitSimpleUnitSource(source);
		session.basePropertySource = sections.propertySource;
		session.designerPropertyEdit = undefined;
		session.property = inspectSimplePropertyXml(source);
		session.sourceEncoding = sourceEncoding;
	}

	/** 生成包含当前设计器 XML 状态的 UTF-8 完整单元备份，用于 VS Code 热退出恢复。 */
	async backupDesignerProperty(document: vscode.TextDocument): Promise<Uint8Array> {
		return this.enqueuePersistence(
			document.uri,
			async () => Buffer.from(await this.designerUnitSource(document), "utf8")
		);
	}

	/** 从热退出完整单元备份恢复设计器 XML 状态，磁盘文件仍作为保存冲突基线。 */
	async restoreDesignerProperty(document: vscode.TextDocument, backup: Uint8Array): Promise<void> {
		const session = this.requireDocumentSession(document);
		const property = inspectSimplePropertyXml(Buffer.from(backup).toString("utf8"));
		if (property.document === undefined || property.status === "damaged") {
			throw new Error("设计器备份中的 XML 属性区无效。");
		}
		session.designerPropertyEdit = {
			basePropertySource: session.basePropertySource,
			document: property.document,
			formatting: resolvePropertySourceFormatting(document)
		};
	}

	/**
	 * 按真实 `.simple` 源 URI 返回预览绑定的当前单元状态。
	 *
	 * 只接受与该源 URI 精确对应的用户代码文档，避免真实源码标签或其它预览标签抢占
	 * 绑定；XML 属性和完整代码由同一会话、同一撤销位置一次性取得。
	 */
	getBoundPreview(sourceUri: vscode.Uri): SimpleBoundUnitPreview | undefined {
		if (sourceUri.scheme !== "file" || path.extname(sourceUri.fsPath).toLowerCase() !== ".simple") {
			return undefined;
		}
		const documentUri = toSimpleCodeUri(sourceUri);
		const session = this.documentSessions.get(uriKey(documentUri));
		if (session === undefined) {
			return undefined;
		}
		const document = vscode.workspace.textDocuments.find(
			(candidate) => uriKey(candidate.uri) === uriKey(documentUri)
		);
		if (document === undefined) {
			return undefined;
		}

		session.documentEncoding = document.encoding;
		const property = sessionProperty(session);
		if (property.document === undefined) {
			return undefined;
		}
		const formatting = session.pendingPropertyEdit?.formatting
			?? resolvePropertySourceFormatting(document);
		const propertySource = serializeSimplePropertySource(property.document, formatting);
		return {
			property,
			source: assembleSimpleUnitSource(
				session.userCodeSnapshot + session.basePropertySource,
				document.getText(),
				propertySource
			)
		};
	}

	/**
	 * 把 XML 模型变更登记到用户代码标签页的撤销栈。
	 *
	 * 属性值变化但用户代码不变时，通过同一撤销事务内的插入和删除使标签页进入未保存状态；
	 * 事务结束后用户代码逐字不变。
	 */
	private async applyUserCodeEdit(
		document: vscode.TextDocument,
		updatedUserCode: string
	): Promise<boolean> {
		if (document.getText() !== updatedUserCode) {
			const edit = new vscode.WorkspaceEdit();
			edit.replace(
				document.uri,
				new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
				updatedUserCode
			);
			return vscode.workspace.applyEdit(edit);
		}

		let editor = vscode.window.visibleTextEditors.find((candidate) => candidate.document === document);
		if (editor === undefined) {
			await vscode.window.showTextDocument(document, { preview: false });
			editor = vscode.window.visibleTextEditors.find((candidate) => candidate.document === document);
			if (editor === undefined) {
				return false;
			}
		}

		const key = uriKey(document.uri);
		const marker = "\u200B";
		const markerOffset = document.getText().length;
		const markerStart = document.positionAt(markerOffset);
		this.propertyDirtyTransactions.add(key);
		try {
			let inserted: boolean;
			try {
				inserted = await editor.edit(
					(edit) => edit.insert(markerStart, marker),
					{ undoStopAfter: false, undoStopBefore: true }
				);
			} catch (error) {
				throw new Error("无法开始属性撤销事务。", { cause: error });
			}
			if (!inserted) {
				return false;
			}
			/* 空文档的 positionAt 会在模型同步前夹回 0，直接按插入位置构造结束坐标。 */
			const markerEnd = markerStart.translate(0, marker.length);
			try {
				return await editor.edit(
					(edit) => edit.delete(new vscode.Range(markerStart, markerEnd)),
					{ undoStopAfter: true, undoStopBefore: false }
				);
			} catch (error) {
				throw new Error("无法结束属性撤销事务。", { cause: error });
			}
		} finally {
			this.propertyDirtyTransactions.delete(key);
		}
	}

	/**
	 * 将 XML 属性模型修改绑定到当前用户代码标签页。
	 *
	 * 内存中只暂存 XML 属性模型；用户保存标签页时才按用户代码格式转换为属性代码。
	 */
	async applyPropertyEdit(
		document: vscode.TextDocument,
		currentPropertyDocument: SimplePropertyXmlDocument,
		updatedPropertyDocument: SimplePropertyXmlDocument,
		updatedUserCode: string
	): Promise<void> {
		if (document.uri.scheme !== SIMPLE_CODE_SCHEME) {
			throw new Error("属性编辑只能应用到 Simple 用户代码标签页。");
		}

		const key = uriKey(document.uri);
		const session = this.documentSessions.get(key);
		if (session === undefined) {
			throw new Error("当前用户代码标签页没有可用的 XML 文档会话。");
		}
		if (session.designerPropertyEdit !== undefined) {
			throw new Error("设计器还有未保存的 XML 修改，请先保存或放弃后再执行该操作。");
		}
		const currentSessionDocument = this.getProperty(document)?.document;
		if (currentSessionDocument !== currentPropertyDocument) {
			throw new Error("当前 XML 属性状态已经变化，请按最新状态重试。");
		}
		const previousPending = session.pendingPropertyEdit;
		const previousHistory = previousPending?.history.slice(0, previousPending.index + 1)
			?? [currentPropertyDocument];
		const previousUserCodeHistory = previousPending?.userCodeHistory.slice(0, previousPending.index + 1)
			?? [document.getText()];
		session.documentEncoding = document.encoding;
		session.pendingPropertyEdit = {
			formatting: resolvePropertySourceFormatting(document),
			history: [...previousHistory, updatedPropertyDocument],
			userCodeHistory: [...previousUserCodeHistory, updatedUserCode],
			index: previousHistory.length
		};

		let applied: boolean;
		try {
			applied = await this.applyUserCodeEdit(document, updatedUserCode);
		} catch (error) {
			session.pendingPropertyEdit = previousPending;
			throw error;
		}
		if (!applied || !document.isDirty) {
			session.pendingPropertyEdit = previousPending;
			throw new Error(applied
				? "当前标签页没有进入未保存状态，属性修改未生效。"
				: "无法把属性修改应用到当前标签页文档。"
			);
		}
	}
	/** 跟随标签页的编辑、撤销或重做操作切换绑定的 XML 属性版本。 */
	synchronizePendingEdit(
		document: vscode.TextDocument,
		reason: vscode.TextDocumentChangeReason | undefined
	): void {
		if (document.uri.scheme !== SIMPLE_CODE_SCHEME) {
			return;
		}
		const key = uriKey(document.uri);
		const session = this.documentSessions.get(key);
		if (session === undefined) {
			return;
		}
		session.documentEncoding = document.encoding;
		if (this.propertyDirtyTransactions.has(key)) {
			return;
		}
		const pending = session.pendingPropertyEdit;
		if (pending === undefined) {
			return;
		}

		const userCode = document.getText();
		if (reason === undefined) {
			if (pending.index >= 0 && pending.userCodeHistory[pending.index] === userCode) {
				return;
			}
			const index = Math.max(0, pending.index + 1);
			const propertyDocument = pendingPropertyDocument(pending);
			session.pendingPropertyEdit = {
				...pending,
				history: [...pending.history.slice(0, index), propertyDocument],
				userCodeHistory: [...pending.userCodeHistory.slice(0, index), userCode],
				index
			};
			return;
		}

		const step = reason === vscode.TextDocumentChangeReason.Undo ? -1 : 1;
		for (
			let index = pending.index + step;
			index >= 0 && index < pending.userCodeHistory.length;
			index += step
		) {
			if (pending.userCodeHistory[index] === userCode) {
				session.pendingPropertyEdit = { ...pending, index };
				return;
			}
		}

		if (reason === vscode.TextDocumentChangeReason.Undo) {
			session.pendingPropertyEdit = { ...pending, index: -1 };
		}
	}

	/** 最后一个关联标签页关闭时释放整个单元文档会话。 */
	releaseDocument(document: vscode.TextDocument): void {
		if (document.uri.scheme === SIMPLE_CODE_SCHEME) {
			const key = uriKey(document.uri);
			if ((this.designerDocumentReferences.get(key) ?? 0) > 0) {
				return;
			}
			this.documentSessions.delete(key);
			this.propertyDirtyTransactions.delete(key);
		}
	}

	/** 监视真实单元的外部修改，让干净的虚拟文档可及时刷新。 */
	watch(uri: vscode.Uri): vscode.Disposable {
		const sourceUri = this.requireSourceUri(uri);
		const key = uriKey(uri);
		const existing = this.sourceWatchers.get(key);

		if (existing !== undefined) {
			existing.references += 1;
			return new vscode.Disposable(() => this.releaseWatcher(key));
		}

		try {
			const watcher = fs.watch(sourceUri.fsPath, { persistent: false }, () => {
				void this.fireSourceChange(uri, sourceUri);
			});
			const registration: SourceWatcher = {
				references: 1,
				watcher
			};
			watcher.on("error", () => {
				if (this.sourceWatchers.get(key) === registration) {
					this.sourceWatchers.delete(key);
				}
				watcher.close();
			});
			this.sourceWatchers.set(key, registration);
		} catch {
			return new vscode.Disposable(() => undefined);
		}

		return new vscode.Disposable(() => this.releaseWatcher(key));
	}

	/** 返回用户代码文档的类型、时间和切分后大小。 */
	async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		const sourceUri = this.requireBackingUri(uri);
		const sourceStat = await vscode.workspace.fs.stat(sourceUri);
		if ((sourceStat.type & vscode.FileType.Directory) !== 0) {
			return sourceStat;
		}
		if (path.extname(sourceUri.fsPath).toLowerCase() !== ".simple") {
			throw vscode.FileSystemError.Unavailable(uri);
		}
		const sourceBytes = await vscode.workspace.fs.readFile(sourceUri);
		const encoding = detectSimpleSourceEncoding(sourceBytes);
		const source = await vscode.workspace.decode(sourceBytes, { encoding });
		const userCode = getVisibleSimpleUnitUserCode(source);
		const userCodeBytes = await vscode.workspace.encode(userCode, { encoding });

		return {
			ctime: sourceStat.ctime,
			mtime: sourceStat.mtime,
			size: userCodeBytes.byteLength,
			type: sourceStat.type
		};
	}

	/** 虚拟协议不承担目录浏览，但保留底层目录的只读枚举能力。 */
	readDirectory(uri: vscode.Uri): Thenable<[string, vscode.FileType][]> {
		return vscode.workspace.fs.readDirectory(this.requireBackingUri(uri));
	}

	/** 虚拟用户代码协议禁止创建目录。 */
	createDirectory(uri: vscode.Uri): never {
		return noPermissions(uri);
	}

	/** 从真实单元读取并返回用户代码。 */
	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		const sourceUri = this.requireSourceUri(uri);
		const sourceBytes = await vscode.workspace.fs.readFile(sourceUri);
		const key = uriKey(uri);
		const encoding = detectSimpleSourceEncoding(sourceBytes);
		const source = await vscode.workspace.decode(sourceBytes, { encoding });
		const sections = splitSimpleUnitSource(source);
		const userCode = getVisibleSimpleUnitUserCode(source);
		const existing = this.documentSessions.get(key);
		if (
			existing !== undefined
			&& (
				sections.propertySource === existing.basePropertySource
				|| existing.designerPropertyEdit !== undefined
				|| existing.pendingPropertyEdit !== undefined
			)
		) {
			/*
			 * 设计器仍持有会话时，后台代码文档可能被 VS Code 关闭后重新读取。
			 * 相同属性原文必须继续复用既有 XML 对象；存在未保存事务时也不能用磁盘内容覆盖。
			 */
			existing.sourceEncoding = encoding;
			const openDocument = this.getOpenDocument(sourceUri);
			if (openDocument?.isDirty !== true) {
				existing.userCodeSnapshot = userCode;
			}
			return vscode.workspace.encode(userCode, { encoding });
		}
		this.documentSessions.set(key, {
			basePropertySource: sections.propertySource,
			property: inspectSimplePropertyXml(source),
			sourceEncoding: encoding,
			userCodeSnapshot: userCode
		});
		return vscode.workspace.encode(userCode, { encoding });
	}

	/** 保存当前用户代码和绑定的 XML 属性区；没有属性修改时保留磁盘最新属性原文。 */
	async writeFile(
		uri: vscode.Uri,
		content: Uint8Array,
		options: { readonly create: boolean; readonly overwrite: boolean }
	): Promise<void> {
		await this.enqueuePersistence(uri, () => this.writeFileNow(uri, content, options));
	}

	/** 在统一持久化队列内写入用户代码，并保留磁盘最新属性区。 */
	private async writeFileNow(
		uri: vscode.Uri,
		content: Uint8Array,
		options: { readonly create: boolean; readonly overwrite: boolean }
	): Promise<void> {
		const sourceUri = this.requireSourceUri(uri);
		let sourceBytes: Uint8Array;

		try {
			sourceBytes = await vscode.workspace.fs.readFile(sourceUri);
		} catch (error) {
			if (!options.create) {
				throw error;
			}
			throw vscode.FileSystemError.FileNotFound(sourceUri);
		}

		if (!options.overwrite) {
			throw vscode.FileSystemError.FileExists(sourceUri);
		}

		const key = uriKey(uri);
		const session = this.documentSessions.get(key);
		const sourceEncoding = session?.sourceEncoding ?? detectSimpleSourceEncoding(sourceBytes);
		const outputEncoding = session?.documentEncoding ?? sourceEncoding;
		const source = await vscode.workspace.decode(sourceBytes, { encoding: sourceEncoding });
		const currentUserCode = getVisibleSimpleUnitUserCode(source);
		const requestedUserCode = await vscode.workspace.decode(content, { encoding: outputEncoding });
		const snapshot = session?.userCodeSnapshot;
		const pendingProperty = session?.pendingPropertyEdit;

		if (
			snapshot !== undefined
			&& currentUserCode !== snapshot
			&& requestedUserCode !== currentUserCode
		) {
			throw vscode.FileSystemError.Unavailable(
				"真实 `.simple` 文件的用户代码已在磁盘上修改，请重新打开后再保存。"
			);
		}

		const currentPropertySource = splitSimpleUnitSource(source).propertySource;
		if (
			pendingProperty !== undefined
			&& currentPropertySource !== session?.basePropertySource
		) {
			throw vscode.FileSystemError.Unavailable(
				"真实 `.simple` 文件的 XML 属性区已在磁盘上修改，请重新打开后再保存。"
			);
		}

		const writtenPropertySource = pendingProperty === undefined
			? currentPropertySource
			: pendingPropertySource(pendingProperty);
		const mergedSource = assembleSimpleUnitSource(
			source,
			requestedUserCode,
			writtenPropertySource
		);
		await vscode.workspace.fs.writeFile(
			sourceUri,
			await vscode.workspace.encode(mergedSource, { encoding: outputEncoding })
		);
		if (session !== undefined) {
			const writtenUserCode = getVisibleSimpleUnitUserCode(mergedSource);
			const savedPropertyDocument = pendingProperty === undefined
				? undefined
				: pendingPropertyDocument(pendingProperty);
			session.basePropertySource = writtenPropertySource;
			session.property = savedPropertyDocument === undefined
				? inspectSimplePropertyXml(source)
				: {
					document: savedPropertyDocument,
					issues: savedPropertyDocument.issues,
					status: savedPropertyDocument.status
			};
			session.sourceEncoding = outputEncoding;
			/* 快照必须对应真实写入内容，包括组装边界为属性区补入的结尾换行。 */
			session.userCodeSnapshot = writtenUserCode;
		}
		this.changeEmitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
	}

	/** 虚拟用户代码协议禁止删除真实单元。 */
	delete(uri: vscode.Uri): never {
		return noPermissions(uri);
	}

	/** 把已登记的虚拟文档重命名映射到真实 `.simple`，并迁移共享 XML 会话。 */
	async rename(
		oldUri: vscode.Uri,
		newUri: vscode.Uri,
		options: { readonly overwrite: boolean }
	): Promise<void> {
		const oldSourceUri = this.requireSourceUri(oldUri);
		const newSourceUri = this.requireSourceUri(newUri);
		const renameKey = unitRenameKey(oldSourceUri, newSourceUri);
		if (
			options.overwrite
			|| !this.allowedUnitRenames.has(renameKey)
		) {
			return noPermissions(oldUri);
		}

		await vscode.workspace.fs.rename(oldSourceUri, newSourceUri, { overwrite: false });
		this.migrateUnitSession(oldUri, newUri);
		this.changeEmitter.fire([
			{ type: vscode.FileChangeType.Deleted, uri: oldUri },
			{ type: vscode.FileChangeType.Created, uri: newUri }
		]);
	}

	/** 释放文件监视器、打开文档会话和事件发送器。 */
	dispose(): void {
		for (const registration of this.sourceWatchers.values()) {
			registration.watcher.close();
		}
		this.sourceWatchers.clear();
		this.allowedUnitRenames.clear();
		this.designerDocumentReferences.clear();
		this.documentSessions.clear();
		this.propertyDirtyTransactions.clear();
		this.changeEmitter.dispose();
	}

	/** 拒绝虚拟用户代码之外的 URI，并返回其真实文件。 */
	private requireSourceUri(uri: vscode.Uri): vscode.Uri {
		if (uri.scheme !== SIMPLE_CODE_SCHEME) {
			throw vscode.FileSystemError.Unavailable(`不支持的用户代码 URI：${uri.toString()}`);
		}

		const sourceUri = toSimpleSourceUri(uri);
		if (sourceUri === undefined) {
			throw vscode.FileSystemError.Unavailable(uri);
		}
		return sourceUri;
	}

	/** 统一校验由命令层传入的真实 Simple 单元 URI。 */
	private requireLocalSource(sourceUri: vscode.Uri): void {
		if (sourceUri.scheme !== "file" || path.extname(sourceUri.fsPath).toLowerCase() !== ".simple") {
			throw new Error("只能刷新本地 `.simple` 单元的虚拟文档。");
		}
	}

	/** 将虚拟文档或其父目录映射到底层本地路径，供 VS Code 的资源编辑预检使用。 */
	private requireBackingUri(uri: vscode.Uri): vscode.Uri {
		const sourceUri = toSimpleSourceUri(uri);
		if (sourceUri !== undefined) {
			return sourceUri;
		}
		if (uri.scheme !== SIMPLE_CODE_SCHEME || uri.query.length > 0) {
			throw vscode.FileSystemError.Unavailable(uri);
		}
		return uri.with({ fragment: "", query: "", scheme: "file" });
	}

	/** 在虚拟 URI 改名时迁移共享 XML 会话、脏事务索引并关闭旧路径监视器。 */
	private migrateUnitSession(oldUri: vscode.Uri, newUri: vscode.Uri): void {
		const oldKey = uriKey(oldUri);
		const newKey = uriKey(newUri);
		const session = this.documentSessions.get(oldKey);
		if (session !== undefined) {
			this.documentSessions.delete(oldKey);
			this.documentSessions.set(newKey, session);
		}
		if (this.propertyDirtyTransactions.delete(oldKey)) {
			this.propertyDirtyTransactions.add(newKey);
		}
		const designerReferences = this.designerDocumentReferences.get(oldKey);
		if (designerReferences !== undefined) {
			this.designerDocumentReferences.delete(oldKey);
			this.designerDocumentReferences.set(newKey, designerReferences);
		}
		const oldWatcher = this.sourceWatchers.get(oldKey);
		if (oldWatcher !== undefined) {
			oldWatcher.watcher.close();
			this.sourceWatchers.delete(oldKey);
		}
	}

	/** 检查监视目标是变更还是被删除，并通知 VS Code。 */
	private async fireSourceChange(uri: vscode.Uri, sourceUri: vscode.Uri): Promise<void> {
		let type = vscode.FileChangeType.Changed;

		try {
			await vscode.workspace.fs.stat(sourceUri);
		} catch {
			type = vscode.FileChangeType.Deleted;
		}

		this.changeEmitter.fire([{ type, uri }]);
	}

	/** 引用归零时关闭真实文件监视器。 */
	private releaseWatcher(key: string): void {
		const registration = this.sourceWatchers.get(key);

		if (registration === undefined) {
			return;
		}

		registration.references -= 1;
		if (registration.references > 0) {
			return;
		}

		registration.watcher.close();
		this.sourceWatchers.delete(key);
	}

	/** 同一虚拟单元的磁盘读取、合并和写入按调用顺序执行，失败不会阻断后续任务。 */
	private enqueuePersistence<T>(uri: vscode.Uri, operation: () => Promise<T>): Promise<T> {
		const key = uriKey(toSimpleSourceUri(uri) ?? uri);
		return this.persistenceOperations.run(key, operation);
	}

	/** 返回设计器或代码标签共享的单元会话，并统一拒绝失效文档。 */
	private requireDocumentSession(document: vscode.TextDocument): SimpleDocumentSession {
		if (document.uri.scheme !== SIMPLE_CODE_SCHEME) {
			throw new Error("只能操作 Simple 用户代码文档绑定的单元会话。");
		}
		const session = this.documentSessions.get(uriKey(document.uri));
		if (session === undefined) {
			throw new Error("当前单元没有可用的文档会话。");
		}
		session.documentEncoding = document.encoding;
		return session;
	}

	/** 组装仅用于设计器另存和热退出备份的完整单元文本。 */
	private async designerUnitSource(document: vscode.TextDocument): Promise<string> {
		const session = this.requireDocumentSession(document);
		const sourceUri = this.requireSourceUri(document.uri);
		const sourceBytes = await vscode.workspace.fs.readFile(sourceUri);
		const sourceEncoding = detectSimpleSourceEncoding(sourceBytes);
		const source = await vscode.workspace.decode(sourceBytes, { encoding: sourceEncoding });
		const propertyDocument = sessionProperty(session).document;
		if (propertyDocument === undefined) {
			throw new Error("当前单元没有可写出的 XML 属性模型。");
		}
		const formatting = session.designerPropertyEdit?.formatting
			?? resolvePropertySourceFormatting(document);
		return assembleSimpleUnitSource(
			source,
			getVisibleSimpleUnitUserCode(source),
			serializeSimplePropertySource(propertyDocument, formatting)
		);
	}

	/** 设计器最后一个文档引用释放后，仅在代码文档也已关闭时销毁共享会话。 */
	private releaseDesignerDocument(key: string): void {
		const references = this.designerDocumentReferences.get(key);
		if (references === undefined) {
			return;
		}
		if (references > 1) {
			this.designerDocumentReferences.set(key, references - 1);
			return;
		}
		this.designerDocumentReferences.delete(key);
		if (!vscode.workspace.textDocuments.some((document) => uriKey(document.uri) === key)) {
			this.documentSessions.delete(key);
			this.propertyDirtyTransactions.delete(key);
		}
	}
}
