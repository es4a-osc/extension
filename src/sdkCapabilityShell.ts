/*
统一确定 SDK 能力任务使用的宿主 shell，按脚本类型选择 Windows 执行程序。
xhwsd@qq.com 2026-9-11
*/

import * as path from "node:path";

/** Windows SDK 能力任务使用的系统命令解释器。 */
export interface WindowsSdkCapabilityShell {
	readonly executable: string;
	readonly args: string[];
}

/** Windows PS1 使用系统 PowerShell，其余能力使用 cmd，其他平台沿用默认 shell。 */
export function createWindowsSdkCapabilityShell(
	platform: NodeJS.Platform = process.platform,
	comSpec: string | undefined = process.env.ComSpec,
	command?: string
): WindowsSdkCapabilityShell | undefined {
	if (platform !== "win32") return undefined;
	if (command !== undefined && path.win32.extname(command).toLowerCase() === ".ps1") {
		return {
			executable: path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
			args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]
		};
	}
	return {
		executable: comSpec?.trim() || "cmd.exe",
		args: ["/d", "/s", "/c"]
	};
}
