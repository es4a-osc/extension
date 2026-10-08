/*
验证设计器顶级区域顺序的恢复、校验和拖动结果。
xhwsd@qq.com 2026-8-29
*/

import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_DESIGNER_DISPLAY_OPTIONS,
	DESIGNER_COLUMN_IDS,
	isDesignerColumnOrder,
	isDesignerDisplayOptionId,
	moveDesignerColumn,
	normalizeDesignerColumnOrder,
	normalizeDesignerDisplayOptions
} from "../designerLayout";

test("设计器列顺序只接受四个区域各出现一次", () => {
	assert.deepEqual(DESIGNER_COLUMN_IDS, ["property", "projection", "enabled", "toolbox"]);
	assert.equal(isDesignerColumnOrder(["property", "projection", "enabled", "toolbox"]), true);
	assert.equal(isDesignerColumnOrder(["property", "projection", "enabled", "enabled"]), false);
	assert.equal(isDesignerColumnOrder(["property", "projection", "toolbox"]), false);
	assert.deepEqual(normalizeDesignerColumnOrder(["enabled", "projection"]), DESIGNER_COLUMN_IDS);
	assert.deepEqual(
		normalizeDesignerColumnOrder(["property", "designer", "enabled", "toolbox"]),
		DESIGNER_COLUMN_IDS
	);
});

test("设计器顶栏拖动按参照列前后生成稳定顺序", () => {
	const movedBefore = moveDesignerColumn(DESIGNER_COLUMN_IDS, "projection", "toolbox", "before");
	assert.deepEqual(movedBefore, ["property", "enabled", "projection", "toolbox"]);
	const movedAfter = moveDesignerColumn(movedBefore, "property", "toolbox", "after");
	assert.deepEqual(movedAfter, ["enabled", "projection", "toolbox", "property"]);
});

test("设计器三个显示开关按单元恢复并分别回退缺省值", () => {
	assert.equal(isDesignerDisplayOptionId("componentLabelsVisible"), true);
	assert.equal(isDesignerDisplayOptionId("designerDebug"), true);
	assert.equal(isDesignerDisplayOptionId("layoutHoverSync"), true);
	assert.equal(isDesignerDisplayOptionId("unknown"), false);
	assert.deepEqual(normalizeDesignerDisplayOptions(undefined), DEFAULT_DESIGNER_DISPLAY_OPTIONS);
	assert.deepEqual(normalizeDesignerDisplayOptions({
		componentLabelsVisible: true,
		designerDebug: true,
		layoutHoverSync: false
	}), {
		componentLabelsVisible: true,
		designerDebug: true,
		layoutHoverSync: false
	});
	assert.deepEqual(normalizeDesignerDisplayOptions({ designerDebug: true }), {
		componentLabelsVisible: false,
		designerDebug: true,
		layoutHoverSync: false
	});
});
