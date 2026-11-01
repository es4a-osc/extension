/*
在统一边界写工程配置，保护未保存缓冲区和写入期间发生的外部修改。
xhwsd@qq.com 2026-10-31
*/

import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { sameFilePath } from "./simpleProjectPaths";
import { readWorkspaceConfigurationJsonc, updateWorkspaceConfigurationJsonc } from "./workspaceConfigurationFile";

/** 调用方串行提交设置；这里在实际替换前复核磁盘和已打开文档。 */
export async function writeWorkspaceConfiguration(
	file: vscode.Uri,
	directory: vscode.Uri | undefined,
	propertyPath: readonly string[],
	value: unknown,
	fileSystem: typeof vscode.workspace.fs = vscode.workspace.fs,
	expected?: { readonly value: unknown }
): Promise<void> {
	const opened = () => vscode.workspace.textDocuments.find((document) => document.uri.scheme === file.scheme && sameFilePath(document.uri.fsPath, file.fsPath));
	if (opened()?.isDirty) throw new Error("工程配置有未保存修改，请先保存或撤销后重试。");
	const originalDocument = opened();
	const version = originalDocument?.version;
	const read = async (): Promise<Uint8Array | undefined> => {
		try { return await fileSystem.readFile(file); }
		catch (error) {
			if (directory !== undefined && error instanceof vscode.FileSystemError && error.code === "FileNotFound") return undefined;
			throw error;
		}
	};
	const original = await read();
	const source = original === undefined ? "{\r\n}\r\n" : Buffer.from(original).toString("utf8");
	if (expected !== undefined && JSON.stringify(readWorkspaceConfigurationJsonc(source, [...propertyPath])) !== JSON.stringify(expected.value)) {
		throw new Error("工程项目配置已变化，请按最新配置重试。");
	}
	const updated = updateWorkspaceConfigurationJsonc(source, [...propertyPath], value);
	if (updated === source) return;
	if (directory !== undefined) await fileSystem.createDirectory(directory);
	const temporary = file.with({ path: `${file.path}.es4a-${randomUUID()}.tmp` });
	try {
		await fileSystem.writeFile(temporary, new TextEncoder().encode(updated));
		const current = await read();
		const document = opened();
		if ((original === undefined) !== (current === undefined)
			|| original !== undefined && !Buffer.from(original).equals(Buffer.from(current!))
			|| document?.isDirty || document === originalDocument && document?.version !== version) {
			throw new Error("工程配置在写入期间已变化，已拒绝覆盖，请重试。");
		}
		await fileSystem.rename(temporary, file, { overwrite: true });
	} finally {
		try { await fileSystem.delete(temporary); } catch { /* 替换成功后临时文件已经不存在。 */ }
	}
}
