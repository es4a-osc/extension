/*
定位扩展仓库内固定的 SDK 契约与项目样本，隔离相邻仓库和本机 SDK 的内容变化。
xhwsd@qq.com 2026-10-14
*/

import { readFileSync } from "node:fs";
import * as path from "node:path";

/** 编译后的测试仍读取源码目录中的固定数据，不复制到生成目录。 */
export function testFixturePath(...segments: readonly string[]): string {
	return path.resolve(__dirname, "../../src/test/fixtures", ...segments);
}

/** 固定 SDK 仅用于行为回归，真实清单兼容验证使用调用者明确传入的 SDK 目录。 */
export function testSdkPath(...segments: readonly string[]): string {
	return testFixturePath("sdk", ...segments);
}

/** 从当前开发扩展清单读取身份，不把发布者或名称固化在宿主测试中。 */
export function testExtensionId(): string {
	const manifest: unknown = JSON.parse(readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"));
	if (typeof manifest !== "object" || manifest === null
		|| !("publisher" in manifest) || typeof manifest.publisher !== "string" || manifest.publisher.length === 0
		|| !("name" in manifest) || typeof manifest.name !== "string" || manifest.name.length === 0) {
		throw new Error("开发扩展清单缺少有效的 publisher/name。");
	}
	return `${manifest.publisher}.${manifest.name}`;
}
