/*
合并活动单元定位请求，并协调项目树展开与窗口单元上下文状态。
xhwsd@qq.com 2026-9-10
*/

import * as vscode from "vscode";
import { ProgramTreeProvider, type FileNode } from "./programTree";
import { ProgramTreeExpansionController } from "./programTreeExpansion";

/** 只执行最后一次活动单元定位，避免快速切换时旧请求覆盖新状态。 */
export class ProgramRevealController implements vscode.Disposable {
	private lastSource: string | undefined;
	private request = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly programs: ProgramTreeProvider,
		private readonly expansion: ProgramTreeExpansionController,
		private readonly selectedUnit: (filePath: string) => FileNode | undefined,
		private readonly reportError: (message: string) => void
	) {}

	schedule(sourceUri: vscode.Uri | undefined): void {
		const sourceKey = sourceUri?.toString();
		/* 同路径重建或项目树刷新后选择可能已经丢失，不能只按上次 URI 跳过定位。 */
		if (
			this.timer === undefined
			&& sourceKey === this.lastSource
			&& (
				sourceUri === undefined
				|| this.selectedUnit(sourceUri.fsPath) !== undefined
			)
		) return;
		const request = ++this.request;
		this.expansion.cancel();
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.reveal(sourceUri, request);
		}, 75);
	}

	private async reveal(sourceUri: vscode.Uri | undefined, request: number): Promise<void> {
		if (request !== this.request) return;
		if (sourceUri === undefined) {
			await vscode.commands.executeCommand("setContext", "es4a.activeEditorIsWindowUnit", false);
			if (request === this.request) this.lastSource = undefined;
			return;
		}

		const selectedUnit = this.selectedUnit(sourceUri.fsPath);
		const unit = selectedUnit ?? await this.programs.findUnitByFilePath(sourceUri.fsPath);
		if (request !== this.request) return;
		await vscode.commands.executeCommand(
			"setContext",
			"es4a.activeEditorIsWindowUnit",
			unit?.unitType === "窗口"
		);
		if (request !== this.request) return;
		this.lastSource = sourceUri.toString();
		if (unit === undefined) return;
		/* 点击项目树打开单元时节点本来就已选中，不再对同一节点执行第二次 reveal。 */
		if (selectedUnit !== undefined) return;

		try {
			await this.expansion.revealActiveUnit(unit);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.reportError(`无法在项目树中定位活动单元：${message}`);
		}
	}

	dispose(): void {
		this.request += 1;
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}
}
