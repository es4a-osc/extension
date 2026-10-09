/*
将 SDK 项目能力声明转换为选定 Simple 项目的稳定调用参数。
xhwsd@qq.com 2026-9-4
*/

import * as path from "node:path";
import type { SimpleProjectInfo } from "./project";
import { mostSpecificSourceRoot } from "./simpleProjectPaths";
import type { Sdk } from "./sdk";

/** SDK 项目能力执行所需的完整调用信息。 */
export interface ProjectCapabilityInvocation {
	/** SDK 能力声明并按顺序解析的命令行参数。 */
	readonly args: readonly string[];
	/** SDK 清单中已经解析为绝对路径的命令。 */
	readonly command: string;
	/** 能力说明。 */
	readonly description?: string;
	/** SDK 清单中的稳定能力标识。 */
	readonly id: string;
	/** 面向用户的能力名称。 */
	readonly name: string;
}

/** 按最具体源码根查找包含当前单元的已添加项目。 */
export function findProjectForSource(
	projects: readonly SimpleProjectInfo[],
	sourceFilePath: string
): SimpleProjectInfo | undefined {
	let selectedProject: SimpleProjectInfo | undefined;
	let selectedSourceRootLength = -1;
	for (const project of projects) {
		const sourceRoot = mostSpecificSourceRoot(project.sourceDirectories, sourceFilePath);
		if (sourceRoot === undefined) {
			continue;
		}
		const sourceRootLength = path.resolve(sourceRoot).length;
		if (sourceRootLength > selectedSourceRootLength) {
			selectedProject = project;
			selectedSourceRootLength = sourceRootLength;
		}
	}
	return selectedProject;
}

/** 按清单顺序把参数标识转换为项目模型已经解析完成的实际值。 */
export function createProjectCapabilityArguments(
	project: SimpleProjectInfo,
	argumentNames: readonly string[] = []
): readonly string[] {
	const values: Readonly<Record<string, string>> = {
		PROJECT_FILE: project.filePath,
		APK_FILE: path.join(project.buildDirectory, "deploy", project.name + ".apk")
	};
	return argumentNames.map((argumentName) => {
		const value = values[argumentName];
		if (value === undefined) {
			throw new Error("当前 SDK 声明了未知的项目参数“" + argumentName + "”。");
		}
		if (value.length === 0) {
			throw new Error("无法解析当前 SDK 项目参数“" + argumentName + "”。");
		}
		return value;
	});
}

/**
 * 按稳定标识查找项目能力，并按清单中的参数标识构造调用。
 *
 * @param sdk 当前内存中的 SDK。
 * @param capabilityId SDK 清单中的项目能力标识。
 * @param project 右键选中的 Simple 项目。
 * @returns 可直接交给宿主任务系统的调用信息。
 * @throws SDK 不可用或没有声明目标能力时抛出用户可读错误。
 */
export function createProjectCapabilityInvocation(
	sdk: Sdk | undefined,
	capabilityId: string,
	project: SimpleProjectInfo
): ProjectCapabilityInvocation {
	if (sdk === undefined) {
		throw new Error("尚未加载 SDK，请选择 SDK 入口文件 sdk.json。");
	}

	const capability = sdk.capabilities.projects.find((candidate) => candidate.id === capabilityId);
	if (capability === undefined) {
		throw new Error("当前 SDK 未声明项目能力“" + capabilityId + "”。");
	}
	return {
		args: createProjectCapabilityArguments(project, capability.arguments),
		command: capability.command,
		description: capability.description,
		id: capability.id,
		name: capability.name
	};
}
