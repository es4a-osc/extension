/*
验证真实扩展宿主的项目树文件夹删除入口能够调用 Windows 静默回收。
xhwsd@qq.com 2026-10-9
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { loadSimpleProject } from "../../programResources";
import type { DirectoryNode } from "../../programTree";

suite("项目树文件夹静默回收", () => {
	test("回收资源子目录后保留项目和同级文件", async function () {
		if (process.platform !== "win32") this.skip();
		this.timeout(30000);
		await vscode.extensions.getExtension("es4a.es4a")!.activate();
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-recycle-folder-"));
		const projectFile = path.join(directory, "project.properties");
		const folder = path.join(directory, "res", "演示目录");
		try {
			await fs.mkdir(path.join(directory, "src"));
			await fs.mkdir(folder, { recursive: true });
			await fs.writeFile(projectFile, "main=主窗口\r\nsource=src\r\nres=res\r\n");
			await fs.writeFile(path.join(directory, "res", "保留.txt"), "同级内容");
			await fs.writeFile(path.join(folder, "内容.txt"), "回收内容");
			await vscode.commands.executeCommand("es4a.internal.addProject", projectFile);
			const project = await loadSimpleProject(projectFile);
			const node: DirectoryNode = { kind: "directory", label: "演示目录", mode: "resources", directoryPath: folder, project };
			// 跳过已有删除确认，执行与正式入口相同的回收分支。
			await vscode.commands.executeCommand("es4a.internal.deleteUnitFolder", node, true);
			assert.equal(await fs.stat(folder).then(() => true, () => false), false);
			assert.equal(await fs.readFile(path.join(directory, "res", "保留.txt"), "utf8"), "同级内容");
			assert.equal(await fs.readFile(projectFile, "utf8"), "main=主窗口\r\nsource=src\r\nres=res\r\n");
		} finally {
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
