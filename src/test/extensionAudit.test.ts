/*
验证整扩展审查确认的配置写入、成员解析、资源身份和清单隔离边界。
xhwsd@qq.com 2026-10-31
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { provideSimpleCompletions } from "../completionModel";
import { createProgramProjectState, PROGRAM_PROJECT_FILES_STATE_KEY, type WorkspaceProjectReference } from "../programProjectPersistence";
import { parseProjectProperties, updateProjectProperty } from "../project";
import { createSimplePropertyXmlDocument } from "../propertyXml";
import { planSimpleResourceReferences, refactoringContext, type RefactoringUnit } from "../refactoringModel";
import { loadSdk, type Sdk } from "../sdk";
import { buildSdkSignatures, findCallContext } from "../signatures";
import { testSdkPath } from "./testFixtures";

const sdk: Sdk = {
	directory: "C:/sdk", capabilities: { projects: [], tools: [] }, templates: {}, issues: [],
	manifests: [{ kind: "runtime", name: "运行库", filePath: "C:/sdk/runtime.json", directory: "C:/sdk", categories: [{ name: "对象", definitions: [
		{ name: "工厂", kind: "object", functions: [{ name: "获取", static: true, return: "结果", params: [] }] },
		{ name: "结果", kind: "object", properties: [{ name: "标题", type: "文本型" }], functions: [{ name: "方法", params: [] }] }
	] }] }]
};

function unit(name: string, userCode: string): RefactoringUnit {
	return { filePath: path.resolve("C:/audit", name + ".simple"), sourceRoot: path.resolve("C:/audit"), userCode,
		property: { document: createSimplePropertyXmlDocument("对象", path.basename(name)), status: "valid", issues: [] } };
}

test("属性编辑保留值的转义、前导空白和相邻字段，并完整替换延续行", () => {
	for (const value of ["C:\\new\\", "  保留", "制表\t符", "结尾\\"]) {
		const updated = updateProjectProperty("name=旧\\\r\n 名称\r\nmain=主窗口\r\n", "name", value);
		assert.deepEqual({ ...parseProjectProperties(updated) }, { name: value, main: "主窗口" });
	}
	assert.deepEqual({ ...parseProjectProperties(updateProjectProperty("", "宏.含 空格", "\\u1234")) }, { "宏.含 空格": "\\u1234" });
});

test("外部更新工程项目列表后，设置写入保留新增项目、顺序和设置", async () => {
	let projects: readonly WorkspaceProjectReference[] = [{ path: "C:/audit/a" }];
	const state = await createProgramProjectState({ available: true, read: () => projects, update: async (next) => { projects = next; } });
	projects = [{ path: "C:/audit/b", settings: { marker: true } }, ...projects];
	assert.equal(state.get<string[]>(PROGRAM_PROJECT_FILES_STATE_KEY, []).length, 2);
	await state.updateProjectSettings(path.resolve("C:/audit/a/project.properties"), () => ({ marker: "a" }));
	assert.equal(projects.length, 2);
	assert.deepEqual(projects[0]?.settings, { marker: true });
	assert.deepEqual(projects[1]?.settings, { marker: "a" });
});

test("资源改名只更新资源表达式，项目类型和别名 R 保持原样", () => {
	const caller = unit("调用", "变量 实例 为 R.drawable_old\n过程 测试()\n变量 编号 为 整数型 = R.drawable_old\n结束 过程");
	const target = unit("R/drawable_old", "");
	assert.deepEqual(planSimpleResourceReferences([caller, target], new Map([["drawable_old", "drawable_new"]]), sdk), []);
	const plain = unit("普通", "变量 实例 为 R.drawable_old\n变量 编号 为 整数型 = R.drawable_old");
	assert.equal(planSimpleResourceReferences([plain], new Map([["drawable_old", "drawable_new"]]), sdk)[0]?.userCode,
		"变量 实例 为 R.drawable_old\n变量 编号 为 整数型 = R.drawable_new");
	const alias = unit("别名", "别名 R = 工厂\n过程 测试()\nR.drawable_old = 1\n结束 过程");
	assert.deepEqual(planSimpleResourceReferences([alias], new Map([["drawable_old", "drawable_new"]]), sdk), []);
});

test("成员补全按同名 R 对象、调用结果和数组元素的真实类型返回成员", () => {
	for (const expression of ["R.", "工厂.获取().", "数组(0).", "(R).", "工厂.获取().标"]) {
		const source = "变量 R 为 结果\n过程 测试()\n变量 数组 为 结果(10)\n" + expression;
		const current = unit("调用", source);
		const result = provideSimpleCompletions(source, source.length, sdk, refactoringContext(current, [current]));
		const names = result?.candidates.map((candidate) => candidate.name) ?? [];
		assert.ok(names.includes("标题"), expression);
		assert.equal(names.includes("方法"), expression === "R.", expression);
		assert.ok(!names.includes("工厂"), expression);
	}
});

test("参数上下文保留多段接收者，并在损坏字符串后的物理行恢复", () => {
	for (const source of ["甲.子.方法(", "甲 . 子 . 方法("]) assert.equal(findCallContext(source, source.length)?.qualifier, "甲.子");
	for (const newline of ["\n", "\r\n"]) {
		const source = '"未完成\\' + newline + "方法(";
		assert.equal(findCallContext(source, source.length)?.name, "方法");
	}
	const continued = "方法(1, _\r\n2, ";
	assert.equal(findCallContext(continued, continued.length)?.activeParameter, 2);
});

test("单个库的错误成员分组和参数被隔离，不阻断有效 SDK 签名", async (context) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-audit-sdk-"));
	context.after(() => fs.rm(directory, { recursive: true, force: true }));
	await fs.cp(path.join(testSdkPath(), "simple"), path.join(directory, "simple"), { recursive: true });
	for (const [index, invalid] of [{ functions: {} }, { functions: [{ name: "坏函数", params: {} }] }].entries()) {
		const folder = path.join(directory, "libraries", "bad" + index);
		await fs.mkdir(folder, { recursive: true });
		await fs.writeFile(path.join(folder, "library.json"), JSON.stringify({ kind: "library", name: "坏库" + index,
			categories: [{ name: "对象", definitions: [{ name: "坏对象", kind: "object", ...invalid }] }] }));
	}
	const loaded = await loadSdk(directory);
	assert.equal(loaded.issues.length, 2);
	assert.equal(loaded.manifests.length, 2);
	assert.doesNotThrow(() => buildSdkSignatures(loaded));
});
