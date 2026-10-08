/*
统一确定 SDK 能力任务使用的宿主 shell，避免 Windows 能力受用户默认终端配置影响。
xhwsd@qq.com 2026-9-11
*/

/** Windows SDK 能力任务使用的系统命令解释器。 */
export interface WindowsSdkCapabilityShell {
	readonly executable: string;
	readonly args: string[];
}

/** Windows SDK 能力统一交给系统命令解释器执行，其他平台沿用 VS Code 默认 shell。 */
export function createWindowsSdkCapabilityShell(
	platform: NodeJS.Platform = process.platform,
	comSpec: string | undefined = process.env.ComSpec
): WindowsSdkCapabilityShell | undefined {
	if (platform !== "win32") return undefined;
	return {
		executable: comSpec?.trim() || "cmd.exe",
		args: ["/d", "/s", "/c"]
	};
}
