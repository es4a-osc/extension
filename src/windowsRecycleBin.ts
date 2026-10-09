/*
通过 Windows 静默回收助手删除项目树文件夹，隔离系统弹窗与进程启动细节。
xhwsd@qq.com 2026-10-9
*/

import { execFile } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

/** 助手失败只返回错误，不重新调用会弹窗的删除接口或永久删除。 */
export async function recycleWindowsFolder(directoryPath: string): Promise<void> {
	if (process.platform !== "win32" || !path.isAbsolute(directoryPath)) {
		throw new Error("静默回收需要 Windows 本地文件夹的完整路径。");
	}
	const windowsDirectory = process.env.SystemRoot;
	if (windowsDirectory === undefined) {
		throw new Error("无法找到 Windows 回收站服务。");
	}
	const executable = path.join(windowsDirectory, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	// dist 与测试输出 out 都与 scripts 同级；助手随扩展发布，不依赖 SDK。
	const script = path.join(__dirname, "..", "scripts", "recycleFolder.ps1");
	await new Promise<void>((resolve, reject) => {
		execFile(executable, [
			"-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass",
			"-File", script, "-TargetPathBase64", Buffer.from(directoryPath, "utf8").toString("base64")
		], {
			// 不继承可能位于待回收目录内的 cwd；路径作为数据参数传递，不拼接命令。
			cwd: os.tmpdir(),
			windowsHide: true,
			encoding: "utf8",
			maxBuffer: 64 * 1024
		}, (error, _stdout, stderr) => {
			if (error === null) {
				resolve();
			} else {
				reject(new Error("无法移至回收站，请检查文件夹权限或占用情况。", {
					cause: new Error(stderr.trim() || error.message)
				}));
			}
		});
	});
}
