/*
把 SDK 清单声明的项目能力和工具能力装配为通用 VS Code 命令与任务。
xhwsd@qq.com 2026-9-4
*/

import * as os from "node:os";
import * as vscode from "vscode";
import { markdownDocumentationToPlainText } from "./markdownDocumentation";
import { createProjectCapabilityInvocation } from "./projectCapability";
import type { SimpleProjectInfo } from "./project";
import type { ProgramTreeNode } from "./programTree";
import type { Sdk, SdkCapability } from "./sdk";
import { createWindowsSdkCapabilityShell } from "./sdkCapabilityShell";

/** 快速选择项携带的原始 SDK 能力声明。 */
interface CapabilityQuickPickItem extends vscode.QuickPickItem {
	readonly capability: SdkCapability;
}

/** 将未知异常转成用户可读文本。 */
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 确认能力命令路径存在且指向文件。 */
async function ensureCommandFile(command: string): Promise<void> {
	let commandStat: vscode.FileStat;
	try {
		commandStat = await vscode.workspace.fs.stat(vscode.Uri.file(command));
	} catch {
		throw new Error("SDK 能力命令不存在：" + command);
	}
	if ((commandStat.type & vscode.FileType.File) === 0) {
		throw new Error("SDK 能力命令不是文件：" + command);
	}
}

/** 为 SDK 能力任务应用统一的终端呈现规则。 */
function configureTask(task: vscode.Task, description: string | undefined): void {
	task.detail = description === undefined ? undefined : markdownDocumentationToPlainText(description);
	task.presentationOptions = {
		clear: true,
		echo: false,
		focus: false,
		panel: vscode.TaskPanelKind.Shared,
		reveal: vscode.TaskRevealKind.Always,
		showReuseMessage: false
	};
}

/** 创建 SDK 能力的终端执行。 */
export function createSdkCapabilityExecution(
	command: string,
	args: readonly string[]
): vscode.ProcessExecution | vscode.ShellExecution {
	const cwd = os.homedir();
	const windowsShell = createWindowsSdkCapabilityShell();
	if (windowsShell !== undefined) {
		return new vscode.ProcessExecution(
			windowsShell.executable,
			[...windowsShell.args, command, ...args],
			{ cwd }
		);
	}
	return new vscode.ShellExecution(
		command,
		args.map((value): vscode.ShellQuotedString => ({
			quoting: vscode.ShellQuoting.Strong,
			value
		})),
		{
			// 空工作区禁止终端直接把 cwd 切到用户目录之外；能力输入均使用绝对路径。
			cwd
		}
	);
}

/** 按清单顺序让用户选择一个当前 SDK 能力。 */
async function selectCapability(
	capabilities: readonly SdkCapability[],
	placeHolder: string
): Promise<SdkCapability | undefined> {
	const items: readonly CapabilityQuickPickItem[] = capabilities.map((capability) => ({
		capability,
		description: capability.description === undefined
			? undefined
			: markdownDocumentationToPlainText(capability.description),
		label: capability.name
	}));
	return (await vscode.window.showQuickPick(items, { placeHolder }))?.capability;
}

/** 运行指定项目能力，按 SDK 清单注入参数和任务环境变量。 */
async function runProjectCapability(
	getSdk: () => Sdk | undefined,
	project: SimpleProjectInfo | undefined,
	capabilityId: string,
	displayName: string
): Promise<void> {
	if (project === undefined) {
		throw new Error("当前标签页不属于已添加的 Simple 项目。");
	}
	const sdk = getSdk();
	if (sdk === undefined) {
		throw new Error("当前没有可用的 SDK。");
	}
	const invocation = createProjectCapabilityInvocation(sdk, capabilityId, project);
	await ensureCommandFile(invocation.command);
	const task = new vscode.Task(
		{
			type: "es4a-project-capability",
			capability: invocation.id,
			project: project.filePath
		},
		vscode.TaskScope.Global,
		displayName + "：" + project.name,
		"ES4A",
		createSdkCapabilityExecution(invocation.command, invocation.args),
		[]
	);
	configureTask(task, invocation.description);
	await vscode.tasks.executeTask(task);
}

/** 选择并在 SDK 根目录运行不依赖项目的工具能力。 */
async function runToolCapability(getSdk: () => Sdk | undefined): Promise<void> {
	const sdk = getSdk();
	if (sdk === undefined) {
		throw new Error("当前没有可用的 SDK。");
	}
	const capability = await selectCapability(sdk.capabilities.tools, "选择要启动的 SDK 工具");
	if (capability === undefined) {
		return;
	}

	await ensureCommandFile(capability.command);
	const task = new vscode.Task(
		{
			type: "es4a-tool-capability",
			capability: capability.id
		},
		vscode.TaskScope.Global,
		capability.name,
		"ES4A",
		createSdkCapabilityExecution(capability.command, []),
		[]
	);
	configureTask(task, capability.description);
	await vscode.tasks.executeTask(task);
}

/** 注册固定项目操作入口和清单驱动的 SDK 工具入口。 */
export function registerSdkCapabilityCommands(
	context: vscode.ExtensionContext,
	getSdk: () => Sdk | undefined,
	getCurrentProject: () => Promise<SimpleProjectInfo | undefined>
): void {
	const resolveProject = async (node: ProgramTreeNode | undefined): Promise<SimpleProjectInfo | undefined> => {
		if (node === undefined) {
			return getCurrentProject();
		}
		if (node.kind !== "project") {
			throw new Error("请在项目节点上执行项目能力。");
		}
		return node.project;
	};
	const compileApplication = async (node?: ProgramTreeNode): Promise<void> => {
		try {
			await runProjectCapability(getSdk, await resolveProject(node), "compile", "编译应用");
		} catch (error) {
			await vscode.window.showErrorMessage("编译应用失败：" + errorMessage(error));
		}
	};
	const debugApplication = async (node?: ProgramTreeNode): Promise<void> => {
		try {
			await runProjectCapability(getSdk, await resolveProject(node), "debug", "调试应用");
		} catch (error) {
			await vscode.window.showErrorMessage("调试应用失败：" + errorMessage(error));
		}
	};
	context.subscriptions.push(
		vscode.commands.registerCommand("es4a.debugApplication", debugApplication),
		vscode.commands.registerCommand("es4a.compileApplication", compileApplication),
		vscode.commands.registerCommand(
			"es4a.runSdkTool",
			() => runToolCapability(getSdk).catch(
				(error) => vscode.window.showErrorMessage("启动 SDK 工具失败：" + errorMessage(error))
			)
		)
	);
}

/** SDK 刷新后同步固定项目操作和通用工具入口的可用状态。 */
export async function updateSdkCapabilityContexts(sdk: Sdk | undefined): Promise<void> {
	await Promise.all([
		vscode.commands.executeCommand(
			"setContext",
			"es4a.sdk.hasCompileCapability",
			sdk?.capabilities.projects.some((capability) => capability.id === "compile") ?? false
		),
		vscode.commands.executeCommand(
			"setContext",
			"es4a.sdk.hasDebugCapability",
			sdk?.capabilities.projects.some((capability) => capability.id === "debug") ?? false
		),
		vscode.commands.executeCommand(
			"setContext",
			"es4a.sdk.hasTools",
			(sdk?.capabilities.tools.length ?? 0) > 0
		)
	]);
}
