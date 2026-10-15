/*
验证全量清单消费及新增、改名、参数和图标变化，错误输入仍须被明确检出。
xhwsd@qq.com 2026-10-14
*/

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { loadSdk } from "../sdk";
import { testSdkPath } from "./testFixtures";
import { loadCompatibilitySdk, validateSdkCompatibility } from "./sdkCompatibility";

test("固定契约的全部定义成员和图标均被扩展消费", async () => {
	const coverage = await validateSdkCompatibility(await loadSdk(testSdkPath("sdk.json")));
	assert.ok(coverage.definitions > 0 && coverage.members > 0 && coverage.icons > 0 && coverage.components > 0);
});

test("附加清单的组件名称参数文案和图标变化无需修改既有用例", async (context) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-sdk-content-change-"));
	context.after(() => fs.rm(directory, { recursive: true, force: true }));
	const manifest = path.join(directory, "library.json");
	for (const [name, icon, parameter] of [["测试甲", "first.svg", "data"], ["测试乙", "second.svg", "数据"]]) {
		await fs.writeFile(path.join(directory, icon!), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z" /></svg>', "utf8");
		await fs.writeFile(manifest, JSON.stringify({ name: "测试库", kind: "library", categories: [{
			name: "任意分组", definitions: [{ kind: "component", name, type: `test.${name}`, icon,
				inherits: ["simple.runtime.components.组件"], functions: [{ name: "发送", params: [{ name: parameter, type: "文本型", description: `说明：${name}` }] }]
			}]
		}] }), "utf8");
		const coverage = await validateSdkCompatibility(await loadCompatibilitySdk(testSdkPath("sdk.json"), [manifest]));
		const base = await validateSdkCompatibility(await loadSdk(testSdkPath("sdk.json")));
		assert.equal(coverage.definitions, base.definitions + 1);
		assert.equal(coverage.members, base.members + 1);
		assert.equal(coverage.parameters, base.parameters + 1);
		assert.equal(coverage.icons, base.icons + 1);
	}
	await fs.writeFile(path.join(directory, "second.svg"), '<svg viewBox="0 0 24 24"><script>bad()</script></svg>', "utf8");
	await assert.rejects(async () => validateSdkCompatibility(await loadCompatibilitySdk(testSdkPath("sdk.json"), [manifest])), /图标无效/u);
});

for (const omitted of ["定义", "成员"] as const) test(`全量验证能够检出消费结果遗漏${omitted}`, async () => {
	const original = await loadSdk(testSdkPath("sdk.json"));
	let changed = false;
	const damaged = {
		...original,
		manifests: original.manifests.map((manifest) => ({
			...manifest,
			categories: manifest.categories.map((category) => ({
				...category,
				definitions: category.definitions.flatMap((definition) => {
					if (changed) return [definition];
					if (omitted === "定义") { changed = true; return []; }
					if ((definition.functions?.length ?? 0) > 0) {
						changed = true;
						return [{ ...definition, functions: definition.functions!.slice(1) }];
					}
					return [definition];
				})
			}))
		}))
	};
	assert.ok(changed);
	await assert.rejects(() => validateSdkCompatibility(damaged), /遗漏/u);
});

test("损坏清单和循环继承仍使全量兼容验证失败", async (context) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-sdk-invalid-content-"));
	context.after(() => fs.rm(directory, { recursive: true, force: true }));
	const file = path.join(directory, "library.json");
	await fs.writeFile(file, "{broken", "utf8");
	await assert.rejects(async () => validateSdkCompatibility(await loadCompatibilitySdk(testSdkPath("sdk.json"), [file])));
	await fs.writeFile(file, JSON.stringify({ name: "循环", kind: "library", categories: [{
		name: "测试", definitions: [{ name: "测试类型", kind: "object", type: "test.Cycle", inherits: ["test.Cycle"] }]
	}] }), "utf8");
	await assert.rejects(async () => validateSdkCompatibility(await loadCompatibilitySdk(testSdkPath("sdk.json"), [file])), /继承.*循环|循环继承/u);
});
