/*
验证分组合并之后的用户排序、运行库与扩展库混排及暂不可用分组恢复。
xhwsd@qq.com 2026-11-1
*/

import assert from "node:assert/strict";
import test from "node:test";
import { moveToolboxCategory, normalizeToolboxCategoryOrder, orderToolboxCategories } from "../designerToolboxOrder";
import { createSimpleDesignerModel, type DesignerToolboxGroup } from "../designerModel";
import type { Sdk } from "../sdk";

const groups: readonly DesignerToolboxGroup[] = [
	{ name: "运行组件", items: [] },
	{ name: "运行容器", items: [] },
	{ name: "扩展可视组件", items: [] },
	{ name: "扩展组件", items: [] },
	{ name: "扩展组件容器", items: [] }
];

test("用户顺序统一作用于运行库及扩展库分组，未配置分组按默认顺序追加", () => {
	assert.deepEqual(orderToolboxCategories(groups, ["扩展组件容器", "运行容器", "扩展组件容器", "暂不可用", "扩展组件"])
		.map((group) => group.name), ["扩展组件容器", "运行容器", "扩展组件", "运行组件", "扩展可视组件"]);
	assert.deepEqual(orderToolboxCategories(groups, []), groups);
	assert.deepEqual(normalizeToolboxCategoryOrder([null, "", "  ", "扩展组件", "扩展组件", 7]), ["扩展组件"]);
});

test("分类拖动前后位置保留暂不可用分类，重新安装时恢复其位置", () => {
	const saved = ["扩展可视组件", "暂不可用", "扩展组件", "扩展组件容器"];
	const moved = moveToolboxCategory(saved, groups, "扩展组件容器", "扩展可视组件", "before");
	assert.deepEqual(moved, ["扩展组件容器", "暂不可用", "扩展可视组件", "扩展组件", "运行组件", "运行容器"]);
	assert.deepEqual(orderToolboxCategories([...groups, { name: "暂不可用", items: [] }], moved!)
		.map((group) => group.name), ["扩展组件容器", "暂不可用", "扩展可视组件", "扩展组件", "运行组件", "运行容器"]);
	assert.deepEqual(moveToolboxCategory([], groups, "扩展可视组件", "扩展组件容器", "after"),
		["运行组件", "运行容器", "扩展组件", "扩展组件容器", "扩展可视组件"]);
	assert.deepEqual(saved, ["扩展可视组件", "暂不可用", "扩展组件", "扩展组件容器"]);
});

test("运行库分组可跨扩展库分组移动，扩展库分组也可移到运行库前", () => {
	assert.deepEqual(moveToolboxCategory([], groups, "运行组件", "扩展组件", "after"),
		["运行容器", "扩展可视组件", "扩展组件", "运行组件", "扩展组件容器"]);
	assert.deepEqual(moveToolboxCategory([], groups, "扩展组件", "运行组件", "before"),
		["扩展组件", "运行组件", "运行容器", "扩展可视组件", "扩展组件容器"]);
});

test("拒绝失效分组和自身作为移动目标", () => {
	assert.equal(moveToolboxCategory([], groups, "扩展组件", "不存在", "before"), undefined);
	assert.equal(moveToolboxCategory([], groups, "扩展组件", "扩展组件", "after"), undefined);
});

test("扩展库并入运行库同名分组后整体参与排序，分组内部组件顺序不变", () => {
	const sdk: Sdk = {
		directory: "", issues: [], capabilities: { projects: [], tools: [] }, templates: {},
		manifests: [
			{ name: "运行库", kind: "runtime", directory: "", filePath: "runtime.json", categories: [
				{ name: "共享分类", definitions: [{ kind: "component", name: "基础组件" }] }
			] },
			{ name: "扩展甲", kind: "library", directory: "", filePath: "a.json", categories: [
				{ name: "共享分类", definitions: [{ kind: "component", name: "追加组件" }] },
				{ name: "扩展分类", definitions: [{ kind: "component", name: "扩展甲" }] }
			] },
			{ name: "扩展乙", kind: "library", directory: "", filePath: "b.json", categories: [
				{ name: "扩展分类", definitions: [{ kind: "component", name: "扩展乙" }] }
			] }
		]
	};
	const model = createSimpleDesignerModel(undefined, sdk);
	const sorted = orderToolboxCategories(model.toolbox, ["扩展分类", "共享分类"]);
	assert.equal(sorted[0]?.name, "扩展分类");
	assert.deepEqual(sorted[0]?.items.map((item) => item.name), ["扩展甲", "扩展乙"]);
	assert.deepEqual(sorted[1]?.items.map((item) => item.name), ["基础组件", "追加组件"]);
});
