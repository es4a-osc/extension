/*
验证 SDK 项目能力与 Simple 项目之间的调用契约。
xhwsd@qq.com 2026-9-4
*/

import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { SimpleProjectInfo } from "../project";
import {
	createProjectCapabilityArguments,
	createProjectCapabilityInvocation,
	findProjectForSource
} from "../projectCapability";
import type { Sdk } from "../sdk";

const project: SimpleProjectInfo = {
	assetsDirectory: "E:\\Projects\\Demo\\assets",
	buildDirectory: "E:\\Projects\\Demo\\build",
	directory: "E:\\Projects\\Demo",
	filePath: "E:\\Projects\\Demo\\project.properties",
	main: "simple.demo.Main",
	name: "Demo",
	properties: {
		assets: "./assets",
		build: "./build",
		main: "simple.demo.Main",
		name: "Demo",
		res: "./res",
		source: "./src"
	},
	resourceDirectory: "E:\\Projects\\Demo\\res",
	sourceDirectories: ["E:\\Projects\\Demo\\src"]
};

const sdk: Sdk = {
	capabilities: {
		projects: [
			{
				arguments: ["PROJECT_FILE"],
				command: "E:\\SDK\\capabilities\\debug.bat",
				description: "编译、安装并启动应用",
				id: "debug",
				name: "调试应用"
			},
			{
				arguments: ["PROJECT_FILE"],
				command: "E:\\SDK\\capabilities\\compile.bat",
				description: "编译指定 Simple 项目的 APK",
				id: "compile",
				name: "编译应用"
			}
		],
		tools: []
	},
	directory: "E:\\SDK",
	issues: [],
	manifests: [],
	templates: {}
};

test("项目能力按清单顺序把参数标识转换为实际值", () => {
	assert.deepEqual(createProjectCapabilityArguments(project), []);
	assert.deepEqual(createProjectCapabilityArguments(project, [
		"PROJECT_FILE"
	]), [
		project.filePath
	]);
	assert.deepEqual(createProjectCapabilityInvocation(sdk, "compile", project), {
		args: [project.filePath],
		command: "E:\\SDK\\capabilities\\compile.bat",
		description: "编译指定 Simple 项目的 APK",
		id: "compile",
		name: "编译应用"
	});
	assert.deepEqual(createProjectCapabilityInvocation(sdk, "debug", project), {
		args: [project.filePath],
		command: "E:\\SDK\\capabilities\\debug.bat",
		description: "编译、安装并启动应用",
		id: "debug",
		name: "调试应用"
	});
});

test("快捷调试按当前单元所在的最具体源码根选择项目", () => {
	const nestedProject: SimpleProjectInfo = {
		...project,
		directory: "E:\\Projects\\Demo\\nested",
		filePath: "E:\\Projects\\Demo\\nested\\project.properties",
		name: "Nested",
		sourceDirectories: ["E:\\Projects\\Demo\\src\\nested"]
	};

	assert.equal(
		findProjectForSource(
			[project, nestedProject],
			"E:\\Projects\\Demo\\src\\nested\\测试窗口.simple"
		),
		nestedProject
	);
	assert.equal(
		findProjectForSource([project], "E:\\Projects\\Other\\测试窗口.simple"),
		undefined
	);
});

test("项目参数使用项目模型已经解析的缺省值", () => {
	const projectWithoutConfiguration: SimpleProjectInfo = {
		...project,
		main: undefined,
		properties: {}
	};
	assert.deepEqual(
		createProjectCapabilityArguments(projectWithoutConfiguration, [
			"PROJECT_FILE"
		]),
		[project.filePath]
	);
});

test("拒绝 SDK 声明未知的项目参数标识", () => {
	assert.throws(
		() => createProjectCapabilityArguments(project, ["UNKNOWN"]),
		/当前 SDK 声明了未知的项目参数“UNKNOWN”/u
	);
	assert.throws(
		() => createProjectCapabilityArguments(project, ["APK_FILE"]),
		/当前 SDK 声明了未知的项目参数“APK_FILE”/u
	);
});

test("拒绝调用当前 SDK 未声明的项目能力", () => {
	assert.throws(
		() => createProjectCapabilityInvocation(sdk, "PublishProject", project),
		/当前 SDK 不提供项目能力“PublishProject”/u
	);
	assert.throws(
		() => createProjectCapabilityInvocation(undefined, "compile", project),
		/尚未加载 SDK，请选择 SDK 目录。/u
	);
});

test("共享脚本先传固定子命令，再按清单顺序传项目参数", () => {
	const sharedSdk: Sdk = {
		...sdk,
		capabilities: {
			projects: [{
				id: "debug",
				name: "调试应用",
				command: "E:\\SDK\\utils\\project\\project.ps1",
				commandArguments: ["debug"],
				arguments: ["PROJECT_FILE"]
			}],
			tools: []
		}
	};
	assert.deepEqual(createProjectCapabilityInvocation(sharedSdk, "debug", project).args, [
		"debug", project.filePath
	]);
});
