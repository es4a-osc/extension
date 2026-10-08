/*
在 VS Code 窗口恢复失败时补回未保存的 Simple 用户代码。
xhwsd@qq.com 2026-8-30
*/

import * as vscode from "vscode";
import { SIMPLE_CODE_SCHEME } from "./simpleCodeFileSystem";

const RECOVERY_STATE_KEY = "es4a.unsavedSimpleCodeByDocument";

interface SimpleCodeRecoveryEntry {
	readonly text: string;
}

type SimpleCodeRecoveryEntries = Record<string, SimpleCodeRecoveryEntry>;

/** 只接受包含字符串正文的恢复项，忽略旧版本或损坏的工作区状态。 */
function normalizeEntries(value: unknown): SimpleCodeRecoveryEntries {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {};
	}

	const entries: SimpleCodeRecoveryEntries = {};
	for (const [key, candidate] of Object.entries(value)) {
		if (
			key.length > 0
			&& typeof candidate === "object"
			&& candidate !== null
			&& "text" in candidate
			&& typeof candidate.text === "string"
		) {
			entries[key] = { text: candidate.text };
		}
	}
	return entries;
}

/** Windows 下按不区分大小写的 URI 标识同一个用户代码文档。 */
function documentKey(uri: vscode.Uri): string {
	const value = uri.toString();
	return process.platform === "win32" ? value.toLowerCase() : value;
}

/**
 * 补足 VS Code 只恢复标签页、却没有接回虚拟文档 Hot Exit 正文的异常路径。
 *
 * VS Code 已正确恢复脏文档时始终以其内容为准；只有文档被错误地按磁盘干净版本
 * 打开时才应用恢复项，并且仍通过标准文档编辑进入脏状态。
 */
export class SimpleCodeDocumentRecovery {
	private readonly entries: SimpleCodeRecoveryEntries;
	private readonly restoreOperations = new Map<string, Promise<boolean>>();
	private pendingWrite: Promise<void> = Promise.resolve();
	private writeTimer: NodeJS.Timeout | undefined;

	constructor(private readonly workspaceState: vscode.Memento) {
		this.entries = normalizeEntries(
			workspaceState.get<unknown>(RECOVERY_STATE_KEY)
		);
	}

	/** 记录脏文档正文；文档恢复为干净状态时删除对应恢复项。 */
	capture(document: vscode.TextDocument): void {
		if (document.uri.scheme !== SIMPLE_CODE_SCHEME) {
			return;
		}

		const key = documentKey(document.uri);
		if (document.isDirty) {
			this.entries[key] = { text: document.getText() };
		} else {
			delete this.entries[key];
		}
		this.scheduleWrite();
	}

	/** 保存或明确撤销后移除恢复项，避免下次开发宿主重新应用旧内容。 */
	clear(document: vscode.TextDocument): void {
		if (document.uri.scheme !== SIMPLE_CODE_SCHEME) {
			return;
		}
		const key = documentKey(document.uri);
		if (!(key in this.entries)) {
			return;
		}
		delete this.entries[key];
		this.scheduleWrite();
	}

	/** 关闭干净文档时清理残留项；关闭脏开发窗口时保留等待下次 F5 恢复。 */
	clearClosedDocument(document: vscode.TextDocument): void {
		if (!document.isDirty) {
			this.clear(document);
		}
	}

	/** 把上个开发窗口留下的正文重新应用到同一 TextDocument，并保持标准脏状态。 */
	restore(document: vscode.TextDocument): Promise<boolean> {
		if (document.uri.scheme !== SIMPLE_CODE_SCHEME) {
			return Promise.resolve(false);
		}

		const key = documentKey(document.uri);
		const running = this.restoreOperations.get(key);
		if (running !== undefined) {
			return running;
		}

		const operation = this.restoreDocument(document, key).finally(() => {
			this.restoreOperations.delete(key);
		});
		this.restoreOperations.set(key, operation);
		return operation;
	}

	/** 在扩展宿主关闭前提交最后一次工作区状态写入。 */
	async flush(): Promise<void> {
		if (this.writeTimer !== undefined) {
			clearTimeout(this.writeTimer);
			this.writeTimer = undefined;
			this.enqueueWrite();
		}
		await this.pendingWrite;
	}

	/** 执行一次恢复，防止代码页和设计器同时解析时重复应用同一正文。 */
	private async restoreDocument(document: vscode.TextDocument, key: string): Promise<boolean> {
		const entry = this.entries[key];
		if (entry === undefined) {
			return false;
		}
		/* VS Code 自带备份已经恢复时，它比扩展的兜底快照优先，禁止用旧快照覆盖。 */
		if (document.isDirty) {
			this.entries[key] = { text: document.getText() };
			this.scheduleWrite();
			return false;
		}

		const currentText = document.getText();
		if (entry.text === currentText) {
			delete this.entries[key];
			this.scheduleWrite();
			return false;
		}

		const edit = new vscode.WorkspaceEdit();
		edit.replace(
			document.uri,
			new vscode.Range(document.positionAt(0), document.positionAt(currentText.length)),
			entry.text
		);
		if (!await vscode.workspace.applyEdit(edit)) {
			throw new Error(`无法恢复未保存的用户代码：${document.uri.toString()}`);
		}
		return true;
	}

	/** 合并连续键入产生的状态写入，同时由 flush 保证窗口关闭前落下最后一份。 */
	private scheduleWrite(): void {
		if (this.writeTimer !== undefined) {
			clearTimeout(this.writeTimer);
		}
		this.writeTimer = setTimeout(() => {
			this.writeTimer = undefined;
			this.enqueueWrite();
		}, 150);
	}

	/** 串行写入快照，避免较早的异步更新覆盖最新正文。 */
	private enqueueWrite(): void {
		const snapshot = Object.keys(this.entries).length === 0
			? undefined
			: structuredClone(this.entries);
		this.pendingWrite = this.pendingWrite.then(
			() => this.workspaceState.update(RECOVERY_STATE_KEY, snapshot)
		);
	}
}

