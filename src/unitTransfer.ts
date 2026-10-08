/*
维护项目树单元的内部复制、剪切状态，并执行同项目粘贴事务。
xhwsd@qq.com 2026-9-9
*/

import * as path from "node:path";
import * as vscode from "vscode";
import type { DirectoryNode, FileNode, ProgramTreeProvider } from "./programTree";
import { listSimpleFiles } from "./simpleFileDiscovery";
import {
	filePathKey,
	mostSpecificSourceRoot,
	simpleQualifiedName
} from "./simpleProjectPaths";
import { detectSimpleSourceEncoding } from "./simpleSourceEncoding";
import { createCopiedSimpleUnitSource } from "./unitFiles";
import { moveUnitToDirectory, type UnitMoveServices } from "./unitMove";
import { copyNameCandidate } from "./copyName";
import { workspacePathExists } from "./workspaceFileSystem";

/** 控制“粘贴单元”菜单是否显示的 VS Code 上下文键。 */
export const UNIT_CLIPBOARD_AVAILABLE_CONTEXT = "es4a.unitClipboardAvailable";

/** 内部单元剪贴板只记录可以重新验证的源路径和操作类型。 */
interface UnitClipboardEntry {
	readonly mode: "copy" | "cut";
	readonly projectFilePath: string;
	readonly sourceFilePath: string;
}

/** 枚举项目内所有单元的限定名，供复制时同时规避路径和限定名冲突。 */
async function projectQualifiedNames(
	sourceDirectories: readonly string[]
): Promise<ReadonlySet<string>> {
	const names = new Set<string>();
	const groups = await Promise.all(sourceDirectories.map((sourceRoot) => listSimpleFiles(sourceRoot)));
	for (const filePath of groups.flat()) {
		const sourceRoot = mostSpecificSourceRoot(sourceDirectories, filePath);
		if (sourceRoot !== undefined) {
			names.add(simpleQualifiedName(sourceRoot, filePath));
		}
	}
	return names;
}

/** 返回目标目录中第一个没有路径及限定名冲突的单元文件。 */
async function availableCopyTarget(
	target: DirectoryNode,
	preferredName: string
): Promise<{ readonly filePath: string; readonly name: string }> {
	const project = target.project;
	if (project === undefined) {
		throw new Error("无法确定粘贴目标所属项目。");
	}
	const sourceRoot = mostSpecificSourceRoot(project.sourceDirectories, target.directoryPath);
	if (sourceRoot === undefined) {
		throw new Error("粘贴路径不属于当前项目配置的源码目录。");
	}

	const qualifiedNames = await projectQualifiedNames(project.sourceDirectories);
	for (let increment = 0; ; increment += 1) {
		const name = copyNameCandidate(preferredName, increment);
		const filePath = path.join(target.directoryPath, `${name}.simple`);
		if (
			!await workspacePathExists(vscode.Uri.file(filePath))
			&& !qualifiedNames.has(simpleQualifiedName(sourceRoot, filePath))
		) {
			return { filePath, name };
		}
	}
}

/** 管理一个扩展宿主周期内的单元复制、剪切与粘贴。 */
export class UnitTransferController implements vscode.Disposable {
	private clipboard: UnitClipboardEntry | undefined;

	constructor(
		private readonly provider: ProgramTreeProvider,
		private readonly services: UnitMoveServices
	) {
		void this.updateAvailableContext(false);
	}

	/** 记录待复制单元；实际文件内容在粘贴前重新读取并验证。 */
	async copy(source: FileNode): Promise<void> {
		await this.remember(source, "copy");
	}

	/** 记录待移动单元；粘贴成功前不修改源文件。 */
	async cut(source: FileNode): Promise<void> {
		await this.remember(source, "cut");
	}

	/** 把内部剪贴板中的单元复制或移动到指定源码目录。 */
	async paste(target: DirectoryNode): Promise<void> {
		const entry = this.clipboard;
		if (entry === undefined) {
			throw new Error("当前没有已复制或剪切的单元。");
		}
		if (target.kind !== "directory" || target.mode !== "units" || target.project === undefined) {
			throw new Error("只能把单元粘贴到项目的源码文件夹中。");
		}
		if (filePathKey(entry.projectFilePath) !== filePathKey(target.project.filePath)) {
			throw new Error("暂不支持跨项目粘贴单元。");
		}

		const sourceUri = vscode.Uri.file(entry.sourceFilePath);
		if (!await workspacePathExists(sourceUri)) {
			await this.clear();
			throw new Error("源单元已经不存在，请重新复制或剪切。");
		}
		const source = await this.provider.findUnitByFilePath(entry.sourceFilePath);
		if (source === undefined) {
			await this.clear();
			throw new Error("无法在当前项目中重新定位源单元。");
		}
		this.ensureSaved(source);

		if (entry.mode === "cut") {
			await moveUnitToDirectory(this.provider, this.services, source, target);
			await this.clear();
			return;
		}

		const oldName = path.basename(source.filePath, path.extname(source.filePath));
		const copyTarget = await availableCopyTarget(target, oldName);
		const sourceBytes = await vscode.workspace.fs.readFile(sourceUri);
		let targetBytes = sourceBytes;
		if (copyTarget.name !== oldName) {
			const encoding = detectSimpleSourceEncoding(sourceBytes);
			const sourceText = await vscode.workspace.decode(sourceBytes, { encoding });
			const targetText = createCopiedSimpleUnitSource(sourceText, oldName, copyTarget.name);
			targetBytes = await vscode.workspace.encode(targetText, { encoding });
		}

		const edit = new vscode.WorkspaceEdit();
		edit.createFile(vscode.Uri.file(copyTarget.filePath), {
			contents: targetBytes,
			overwrite: false
		});
		if (!await vscode.workspace.applyEdit(edit)) {
			throw new Error("VS Code 未能创建复制的单元文件。");
		}
		this.services.codeDocuments.notifySourceCreated(vscode.Uri.file(copyTarget.filePath));
		this.provider.refresh();
		await this.services.refreshProjectSemantics();
	}

	/** 清空扩展内部状态；不会改动系统文本剪贴板。 */
	dispose(): void {
		this.clipboard = undefined;
		void this.updateAvailableContext(false);
	}

	/** 校验源单元并写入内部剪贴板。 */
	private async remember(source: FileNode, mode: UnitClipboardEntry["mode"]): Promise<void> {
		if (source.kind !== "unit" || source.project === undefined) {
			throw new Error("请在单元文件上执行此操作。");
		}
		if (!await workspacePathExists(vscode.Uri.file(source.filePath))) {
			throw new Error("源单元已经不存在。");
		}
		this.ensureSaved(source);
		this.clipboard = {
			mode,
			projectFilePath: source.project.filePath,
			sourceFilePath: source.filePath
		};
		await this.updateAvailableContext(true);
	}

	/** 拒绝复制磁盘旧内容或移动仍有未保存会话的单元。 */
	private ensureSaved(source: FileNode): void {
		if (this.services.codeDocuments.hasUnsavedChanges(vscode.Uri.file(source.filePath))) {
			throw new Error("该单元存在未保存修改，请先保存或撤销后再操作。");
		}
	}

	/** 成功剪切粘贴或源文件失效后隐藏粘贴菜单。 */
	private async clear(): Promise<void> {
		this.clipboard = undefined;
		await this.updateAvailableContext(false);
	}

	/** 同步控制项目树“粘贴单元”菜单的上下文状态。 */
	private updateAvailableContext(available: boolean): Thenable<unknown> {
		return vscode.commands.executeCommand(
			"setContext",
			UNIT_CLIPBOARD_AVAILABLE_CONTEXT,
			available
		);
	}
}
