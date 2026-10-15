/*
集中解析扩展仓库内固定的 Simple 项目样本路径。
xhwsd@qq.com 2026-9-4
*/

import { testFixturePath } from "./testFixtures";

import * as path from "node:path";
import { listSimpleFiles } from "../simpleFileDiscovery";

export type SimpleTestProjectName = "SmokeTest" | "SmokeTests" | "StartTests" | "Tetris";

const SIMPLE_DIRECTORY = testFixturePath("simple");

const PROJECT_DIRECTORIES: Readonly<Record<SimpleTestProjectName, string>> = {
	SmokeTest: path.join(SIMPLE_DIRECTORY, "tests", "simple", "compiler", "SmokeTest"),
	SmokeTests: path.join(SIMPLE_DIRECTORY, "tests", "simple", "runtime", "DeviceTests", "SmokeTests"),
	StartTests: path.join(SIMPLE_DIRECTORY, "tests", "simple", "runtime", "DeviceTests", "StartTests"),
	Tetris: path.join(SIMPLE_DIRECTORY, "samples", "Tetris")
};

/** 返回扩展固定项目样本内的绝对路径。 */
export function simpleTestProjectPath(
	project: SimpleTestProjectName,
	...segments: readonly string[]
): string {
	return path.join(PROJECT_DIRECTORIES[project], ...segments);
}

/** 按唯一单元名定位固定样本，避免测试依赖项目内部的分类目录。 */
export async function simpleTestUnitPath(
	project: SimpleTestProjectName,
	unitName: string
): Promise<string> {
	const matches = (await listSimpleFiles(simpleTestProjectPath(project, "src")))
		.filter((filePath) => path.basename(filePath, path.extname(filePath)) === unitName);
	if (matches.length !== 1) {
		throw new Error(`项目 ${project} 中应当只有一个名为 ${unitName} 的 Simple 单元，实际找到 ${matches.length} 个。`);
	}
	return matches[0]!;
}
