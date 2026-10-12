/*
验证独立同步设置的默认值、路径改名与移动、引用原文保持及原生撤销。
xhwsd@qq.com 2026-10-10
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { AUTOMATIC_SYNC_SETTINGS, isAutomaticSyncEnabled } from "../../automaticSyncSettings";
import { loadSimpleProject } from "../../programResources";
import { toSimpleCodeUri } from "../../simpleCodeFileSystem";
import { getVisibleSimpleUnitUserCode } from "../../simpleUnitSource";

async function undoUnitPath(command: "undo" | "redo", current: string, target: string): Promise<void> {
	// 纯路径事务须从参与移动的代码资源撤销，调用者没有文本修改记录。
	await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(current))), { preview: false });
	await vscode.commands.executeCommand(command);
	for (let attempt = 0; attempt < 100 && !await fs.stat(target).then(() => true, () => false); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
	assert.ok(await fs.stat(target));
}

suite("自动同步设置", () => {
	test("四项独立开关均默认启用，虚拟代码使用真实文件设置", () => {
		const uri = vscode.Uri.file(path.join(os.tmpdir(), "自动同步.simple"));
		for (const [kind, key] of Object.entries(AUTOMATIC_SYNC_SETTINGS)) {
			assert.equal(vscode.workspace.getConfiguration("es4a", uri).inspect<boolean>(key)?.defaultValue, true);
			assert.equal(isAutomaticSyncEnabled(kind as keyof typeof AUTOMATIC_SYNC_SETTINGS, toSimpleCodeUri(uri)), isAutomaticSyncEnabled(kind as keyof typeof AUTOMATIC_SYNC_SETTINGS, uri));
		}
	});

	for (const kind of ["unit", "package"] as const) for (const native of [false, true]) {
		test(`关闭${kind === "unit" ? "单元" : "包"}同步不影响另一项，${native ? "原生" : "项目树"}改名及移动保留代码、XML 和 main`, async function () {
			this.timeout(30000);
			const configuration = vscode.workspace.getConfiguration("es4a");
			const keys = [AUTOMATIC_SYNC_SETTINGS.unit, AUTOMATIC_SYNC_SETTINGS.package];
			const previous = keys.map((key) => configuration.inspect<boolean>(key)?.globalValue);
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-sync-paths-"));
			const projectFile = path.join(directory, "project.properties");
			const folder = path.join(directory, "src", "old");
			const file = path.join(folder, "主窗口.simple");
			const callerFile = path.join(directory, "src", "调用者.simple");
			const relationFile = path.join(directory, "src", "派生.simple");
			const source = "事件 主窗口.初始化()\r\n结束 事件\r\n$属性\r\n$资源 $窗口\r\n$定义 主窗口 $为 窗口\r\n$结束 $定义\r\n$结束 $属性\r\n";
			const callerSource = "变量 窗口实例 为 old.主窗口\r\n$属性\r\n$资源 $对象\r\n$结束 $属性\r\n";
			const relationSource = "$属性\r\n$资源 $对象\r\n基础对象 = old.主窗口\r\n未知字段 = \"原文\"\r\n$结束 $属性\r\n";
			const projectSource = "# 保留排版\r\nmain = old.主窗口\r\nsource=./src\r\n";
			try {
				await configuration.update(AUTOMATIC_SYNC_SETTINGS.unit, kind !== "unit", vscode.ConfigurationTarget.Global);
				await configuration.update(AUTOMATIC_SYNC_SETTINGS.package, kind !== "package", vscode.ConfigurationTarget.Global);
				await vscode.extensions.getExtension("es4a.es4a")!.activate();
				await fs.mkdir(folder, { recursive: true });
				await fs.mkdir(path.join(directory, "src", "destination"));
				await fs.writeFile(file, source);
				await fs.writeFile(callerFile, callerSource);
				await fs.writeFile(relationFile, relationSource);
				await fs.writeFile(projectFile, projectSource);
				await vscode.commands.executeCommand("es4a.internal.addProject", projectFile);
				const project = await loadSimpleProject(projectFile);
				const caller = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(callerFile)));
				await vscode.window.showTextDocument(caller, { preview: false });
				const before = kind === "unit" ? file : folder;
				const after = kind === "unit" ? path.join(folder, "新窗口.simple") : path.join(directory, "src", "new");
				const movedFile = kind === "unit" ? after : path.join(after, "主窗口.simple");
				const assertUnchanged = async (targetFile: string): Promise<void> => {
					assert.equal(await fs.readFile(targetFile, "utf8"), source);
					assert.equal(await fs.readFile(callerFile, "utf8"), callerSource);
					assert.equal(caller.getText(), getVisibleSimpleUnitUserCode(callerSource));
					assert.equal(await fs.readFile(relationFile, "utf8"), relationSource);
					assert.equal(await fs.readFile(projectFile, "utf8"), projectSource);
				};
				if (native) {
					const edit = new vscode.WorkspaceEdit();
					edit.renameFile(vscode.Uri.file(before), vscode.Uri.file(after));
					assert.ok(await vscode.workspace.applyEdit(edit));
				} else if (kind === "unit") {
					await vscode.commands.executeCommand("es4a.renameUnitFile", { kind: "unit", label: "主窗口", filePath: file, project }, "新窗口");
				} else {
					await vscode.commands.executeCommand("es4a.renameUnitFolder", { kind: "directory", mode: "units", label: "old", directoryPath: folder, project }, "new");
				}
				await assertUnchanged(movedFile);
				if (kind === "unit") {
					await undoUnitPath("undo", movedFile, file);
					await assertUnchanged(file);
					await undoUnitPath("redo", file, movedFile);
					await assertUnchanged(movedFile);
				}
				const destination = path.join(directory, "src", "destination");
				const movedPath = path.join(destination, path.basename(after));
				if (kind === "unit" && !native) {
					await vscode.commands.executeCommand("es4a.internal.moveUnitToFolder", { kind: "unit", label: "新窗口", filePath: after, project }, { kind: "directory", mode: "units", label: "destination", directoryPath: destination, project });
				} else {
					const edit = new vscode.WorkspaceEdit();
					edit.renameFile(vscode.Uri.file(after), vscode.Uri.file(movedPath));
					assert.ok(await vscode.workspace.applyEdit(edit));
				}
				await assertUnchanged(kind === "unit" ? movedPath : path.join(movedPath, "主窗口.simple"));
				if (kind === "unit") {
					await undoUnitPath("undo", movedPath, movedFile);
					await assertUnchanged(movedFile);
				}
			} finally {
				await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
				for (const [index, key] of keys.entries()) await configuration.update(key, previous[index], vscode.ConfigurationTarget.Global);
				await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
			}
		});
	}
});
