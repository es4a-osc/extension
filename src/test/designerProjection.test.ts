/*
验证设计器按 SDK 有效缺省值投影文本外观、二维对齐和表格有效性。
xhwsd@qq.com 2026-8-31
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import {
	createSimpleDesignerModel,
	type DesignerComponentNode,
	type DesignerRelativeRuleLabels
} from "../designerModel";
import { resolveDesignerRelativePositions } from "../designer/designerRelativeLayout";
import {
	componentEdgeInsertionPosition,
	componentDragPointerOffset,
	componentHoverHint,
	componentPresentation,
	componentTypeHoverHint,
	containerInsetStyle,
	containerStyle,
	currentDesignerRelativeGuides,
	type DesignerRelativeLabelBounds,
	designerFrameAlignmentLabel,
	designerFrameAlignmentLabelSide,
	designerGridCells,
	designerGridPositionLabelBounds,
	designerGridUnplacedChildren,
	designerRelativeGuideLabelMode,
	designerRelativeGuideLabelSide,
	designerRelativeShortGuideLabelCenter,
	findDesignerComponentNode,
	isDesignerGridPlacedChild,
	layoutDesignerRelativeLabels,
	projectedDesignerRelativePreviewBounds,
	resolveDesignerFrameSnap,
	resolveDesignerRelativeSnap,
	sdkDescriptionHoverHint
} from "../designer/designerView";
import { parseSimplePropertyXml, serializePropertyXml } from "../propertyXml";
import { loadSdk } from "../sdk";

/** 按名称递归查找设计器组件树节点。 */
function findComponent(node: DesignerComponentNode | undefined, name: string): DesignerComponentNode | undefined {
	if (node?.name === name) return node;
	return node?.children.map((child) => findComponent(child, name)).find((child) => child !== undefined);
}

const RELATIVE_RULE_LABELS: DesignerRelativeRuleLabels = {
	above: "位于顶边",
	alignBaseline: "对齐基线",
	alignBottom: "对齐底边",
	alignEnd: "对齐结束",
	alignLeft: "对齐左边",
	alignParentBottom: "对齐父底边",
	alignParentEnd: "对齐父结束",
	alignParentLeft: "对齐父左边",
	alignParentRight: "对齐父右边",
	alignParentStart: "对齐父开始",
	alignParentTop: "对齐父顶边",
	alignRight: "对齐右边",
	alignStart: "对齐开始",
	alignTop: "对齐顶边",
	below: "位于底边",
	centerHorizontal: "居中水平",
	centerInParent: "居中于父",
	centerVertical: "居中垂直",
	endOf: "位于结束",
	leftOf: "位于左边",
	rightOf: "位于右边",
	startOf: "位于开始"
};

test("组件名称标签拖拽保留组件外指针偏移", () => {
	assert.equal(componentDragPointerOffset(96, 100, true), -4);
	assert.equal(componentDragPointerOffset(132, 100, true), 32);
	assert.equal(componentDragPointerOffset(96, 100, false), 0);
	assert.equal(componentDragPointerOffset(132, 100, false), 32);
});

test("容器首尾内边缘保留同级前后插入位置", () => {
	assert.equal(componentEdgeInsertionPosition(100, 100, 200), "before");
	assert.equal(componentEdgeInsertionPosition(108, 100, 200), "before");
	assert.equal(componentEdgeInsertionPosition(109, 100, 200), undefined);
	assert.equal(componentEdgeInsertionPosition(291, 100, 200), undefined);
	assert.equal(componentEdgeInsertionPosition(292, 100, 200), "after");
	assert.equal(componentEdgeInsertionPosition(300, 100, 200), "after");
	assert.equal(componentEdgeInsertionPosition(99, 100, 200), undefined);
	assert.equal(componentEdgeInsertionPosition(301, 100, 200), undefined);
	assert.equal(componentEdgeInsertionPosition(104, 100, 8), "before");
	assert.equal(componentEdgeInsertionPosition(105, 100, 8), "after");
});

test("相对布局按父级规则和同级锚点计算确定位置", () => {
	const positions = resolveDesignerRelativePositions(300, 200, [
		{
			height: 20,
			path: "center",
			rules: { centerInParent: true },
			width: 40
		},
		{
			height: 10,
			path: "left-above",
			rules: { above: "center", leftOf: "center" },
			width: 30
		},
		{
			height: 10,
			path: "right-below",
			rules: { below: "center", rightOf: "center" },
			width: 30
		},
		{
			height: 20,
			margin: { bottom: 7, left: undefined, right: 9, top: undefined },
			path: "right-bottom",
			rules: { alignParentBottom: true, alignParentRight: true },
			width: 40
		},
		{
			height: 12,
			margin: { bottom: undefined, left: 17, right: undefined, top: 23 },
			path: "unconstrained",
			rules: {},
			width: 24
		}
	]);
	assert.deepEqual(positions.get("center"), { issue: undefined, left: 130, top: 90 });
	assert.deepEqual(positions.get("left-above"), { issue: undefined, left: 100, top: 80 });
	assert.deepEqual(positions.get("right-below"), { issue: undefined, left: 170, top: 110 });
	assert.deepEqual(positions.get("right-bottom"), { issue: undefined, left: 251, top: 173 });
	assert.deepEqual(positions.get("unconstrained"), { issue: undefined, left: 17, top: 23 });
});

test("相对布局未设置关系时悬停明确说明左上角和边距定位", () => {
	const node: DesignerComponentNode = {
		children: [],
		container: false,
		displayText: "按钮1",
		layout: "linear-vertical",
		margin: { bottom: undefined, left: 12, right: undefined, top: 18 },
		name: "按钮1",
		path: "/属性/定义[1]/定义[1]",
		relativeRules: {},
		textComponent: true,
		type: "按钮",
		visual: true
	};
	assert.match(componentHoverHint(node), /未设置相对关系，按父级左上角及边距定位/u);
});

test("相对布局缺失锚点和循环引用稳定回退到左上", () => {
	const positions = resolveDesignerRelativePositions(200, 100, [
		{ height: 10, path: "missing", rules: { rightOf: "unknown" }, width: 20 },
		{ height: 10, path: "cycle-a", rules: { rightOf: "cycle-b" }, width: 20 },
		{ height: 10, path: "cycle-b", rules: { rightOf: "cycle-a" }, width: 20 }
	]);
	assert.deepEqual(positions.get("missing"), {
		issue: "missing-anchor",
		left: 0,
		top: 0
	});
	assert.equal(positions.get("cycle-a")?.issue, "cycle");
	assert.equal(positions.get("cycle-b")?.issue, "cycle");
	assert.equal(Number.isFinite(positions.get("cycle-a")?.left), true);
	assert.equal(Number.isFinite(positions.get("cycle-b")?.left), true);
});

test("设计器 SDK 描述悬停保留换行", () => {
	const node: DesignerComponentNode = {
		children: [],
		container: false,
		description: "第一行。\r\n第二行。\r第三行。",
		displayText: "按钮1",
		layout: "linear-vertical",
		name: "按钮1",
		path: "/属性/定义[1]/定义[1]",
		runtimeType: "simple.runtime.components.按钮",
		textComponent: true,
		type: "按钮",
		visual: true
	};
	assert.equal(
		componentHoverHint(node),
		"按钮1 - simple.runtime.components.按钮\n第一行。\n第二行。\n第三行。"
	);
	assert.equal(findDesignerComponentNode(node, node.path), node);
	assert.equal(findDesignerComponentNode(node, "/属性/定义[9]"), undefined);
	assert.equal(
		componentTypeHoverHint("按钮", "simple.runtime.components.按钮", node.description),
		"按钮 - simple.runtime.components.按钮\n第一行。\n第二行。\n第三行。"
	);
	assert.equal(sdkDescriptionHoverHint("第一行。\r\n第二行。\r第三行。"), "第一行。\n第二行。\n第三行。");
	assert.equal(sdkDescriptionHoverHint(undefined, "缺省提示"), "缺省提示");
});

test("设计器原生悬停把 SDK Markdown 转为保留换行的纯文本", () => {
	assert.equal(
		sdkDescriptionHoverHint("**第一行。**\r\n- `第二行。`\r\n第三行。"),
		"第一行。\n• 第二行。\n第三行。"
	);
});

test("水平进度条与其它非文本组件统一使用普通占位外观", () => {
	const node: DesignerComponentNode = {
		children: [],
		container: false,
		displayText: "Progress1",
		displayTextPlaceholder: true,
		layout: "linear-vertical",
		name: "Progress1",
		path: "/属性/定义[1]/定义[1]",
		textComponent: false,
		type: "水平进度条",
		visual: true
	};
	const classes = componentPresentation(node, undefined, "control").classes;
	assert.ok(classes.includes("designer-placeholder-control"));
	assert.ok(classes.includes("designer-empty-content"));
});

test("相对布局规则与边距分线显示并用间距段连接组件边", () => {
	const guides = currentDesignerRelativeGuides(
		{ height: 20, left: 140, top: 60, width: 40 },
		{ height: 200, left: 0, top: 0, width: 300 },
		[{ componentName: "标签1", height: 20, left: 40, top: 60, width: 50, xmlPath: "label" }],
		{ alignParentTop: true, rightOf: "label" },
		{ left: 50 },
		RELATIVE_RULE_LABELS
	);
	assert.deepEqual(guides.filter((guide) => guide.kind === "dock").map((guide) => guide.label), [
		"对齐父顶边",
		"位于右边"
	]);
	assert.deepEqual(guides.filter((guide) => guide.kind === "margin").map((guide) => guide.label), []);
	assert.deepEqual(guides.flatMap((guide) => guide.connector?.label ?? []), ["50dp"]);
	const rightOfGuide = guides.find((guide) => guide.label === "位于右边");
	assert.equal(rightOfGuide?.labelPlacement, "start");
	assert.deepEqual(rightOfGuide?.connector, {
		axis: "horizontal",
		end: 140,
		label: "50dp",
		marginSide: "left",
		position: 70,
		start: 90
	});
	assert.equal(rightOfGuide?.start, 44);
	assert.equal(rightOfGuide?.end, 96);
	const touchingGuides = currentDesignerRelativeGuides(
		{ height: 20, left: 90, top: 60, width: 40 },
		{ height: 200, left: 0, top: 0, width: 300 },
		[{ componentName: "标签1", height: 20, left: 40, top: 60, width: 50, xmlPath: "label" }],
		{ rightOf: "label" },
		undefined,
		RELATIVE_RULE_LABELS
	);
	assert.deepEqual(
		touchingGuides.map((guide) => [guide.axis, guide.position, guide.start, guide.end]),
		[["vertical", 90, 44, 96]]
	);
	const touchingGuide = touchingGuides[0];
	assert.ok(touchingGuide);
	assert.equal(60 - touchingGuide.start, touchingGuide.end - 80);
	const belowGuide = currentDesignerRelativeGuides(
		{ height: 20, left: 40, top: 100, width: 40 },
		{ height: 200, left: 0, top: 0, width: 300 },
		[{ componentName: "标签1", height: 20, left: 40, top: 60, width: 50, xmlPath: "label" }],
		{ below: "label" },
		undefined,
		RELATIVE_RULE_LABELS
	)[0];
	assert.deepEqual([belowGuide?.axis, belowGuide?.position, belowGuide?.start, belowGuide?.end], ["horizontal", 80, 24, 106]);
	assert.equal(40 - (belowGuide?.start ?? 0), (belowGuide?.end ?? 0) - 90);
	const negativeMargin = currentDesignerRelativeGuides(
		{ height: 20, left: 140, top: 60, width: 40 },
		{ height: 200, left: 0, top: 0, width: 300 },
		[],
		{},
		{ left: -51 },
		RELATIVE_RULE_LABELS
	).find((guide) => guide.kind === "margin");
	assert.deepEqual(negativeMargin, {
		axis: "horizontal",
		end: 140,
		kind: "margin",
		label: "-51dp",
		labelPlacement: "middle",
		marginSide: "left",
		position: 70,
		start: 89,
		target: "margin",
		title: "-51dp"
	});
	assert.equal(currentDesignerRelativeGuides(
		{ height: 20, left: 140, top: 60, width: 40 },
		{ height: 200, left: 0, top: 0, width: 300 },
		[],
		{ alignParentLeft: true },
		undefined,
		RELATIVE_RULE_LABELS
	).some((guide) => guide.label.endsWith("dp")), false);
	const parentGuides = currentDesignerRelativeGuides(
		{ height: 20, left: 140, top: 60, width: 40 },
		{ height: 200, left: 0, top: 0, width: 300 },
		[],
		{ alignParentRight: true, alignParentTop: true },
		{ right: 120, top: 60 },
		RELATIVE_RULE_LABELS
	);
	assert.deepEqual(parentGuides.map((guide) => [guide.label, guide.connector]), [
		["对齐父右边", { axis: "horizontal", end: 300, label: "120dp", marginSide: "right", position: 70, start: 180 }],
		["对齐父顶边", { axis: "vertical", end: 60, label: "60dp", marginSide: "top", position: 160, start: 0 }]
	]);
	assert.ok(parentGuides.every((guide) => guide.labelPlacement === "middle"));
	const centerInParentGuides = currentDesignerRelativeGuides(
		{ height: 20, left: 130, top: 90, width: 40 },
		{ height: 200, left: 0, top: 0, width: 300 },
		[],
		{ centerInParent: true },
		undefined,
		RELATIVE_RULE_LABELS
	);
	assert.deepEqual(centerInParentGuides.map((guide) => guide.rule), ["centerInParent", "centerInParent"]);
	assert.deepEqual(centerInParentGuides.map((_, index) => designerRelativeGuideLabelMode(centerInParentGuides, index)), [
		"hidden",
		"center-in-parent"
	]);
});

test("相对布局拖拽示意线使用预演规则投影后的位置", () => {
	const parent = { height: 400, left: 100, top: 50, width: 600 };
	const sibling = { componentName: "锚点", height: 40, left: 300, top: 130, width: 80, xmlPath: "anchor" };
	const preview = projectedDesignerRelativePreviewBounds(
		{ height: 40, left: 250, top: 180, width: 60 },
		parent,
		[sibling],
		{ leftOf: "anchor", below: "anchor" },
		{ right: 10, top: 15 },
		300,
		200
	);
	assert.deepEqual(preview, { height: 40, left: 220, top: 200, width: 60 });
	const guides = currentDesignerRelativeGuides(
		preview,
		parent,
		[sibling],
		{ leftOf: "anchor", below: "anchor" },
		{ right: 10, top: 15 },
		RELATIVE_RULE_LABELS
	);
	assert.deepEqual(guides.map((guide) => guide.connector && [guide.connector.start, guide.connector.end]), [
		[280, 300],
		[170, 200]
	]);
});

test("相对布局兄弟停靠文案在内容区横排避让并保留父级提示", () => {
	const moving = { height: 40, left: 263, top: 148, width: 118 };
	const parent = { height: 540, left: 92, top: 42, width: 523 };
	const guides = currentDesignerRelativeGuides(
		moving,
		parent,
		[
			{ componentName: "右上", height: 60, left: 413, top: 198, width: 120, xmlPath: "right" },
			{ componentName: "左上", height: 65, left: 92, top: 42, width: 120, xmlPath: "top" }
		],
		{ leftOf: "right", below: "top", alignParentBottom: true },
		{ right: 32, top: 41 },
		RELATIVE_RULE_LABELS
	);
	const placements = layoutDesignerRelativeLabels(
		guides,
		moving,
		parent,
		(label) => [...label].reduce((width, character) => width + (character.charCodeAt(0) <= 0x7f ? 6 : 10), 0)
	);
	const labels = placements.flatMap((placement) => [placement.connector, placement.rule])
		.filter((bounds) => bounds !== undefined);
	assert.equal(labels.length, 4);
	assert.deepEqual(placements[0], {});
	const leftOfLabel = placements[guides.findIndex((guide) => guide.rule === "leftOf")]?.rule;
	const belowLabel = placements[guides.findIndex((guide) => guide.rule === "below")]?.rule;
	assert.ok(leftOfLabel && leftOfLabel.left + leftOfLabel.width <= 413);
	assert.ok(belowLabel && belowLabel.top >= 107);
	for (const [index, bounds] of labels.entries()) {
		assert.ok(bounds.left >= parent.left && bounds.left + bounds.width <= parent.left + parent.width);
		assert.ok(bounds.top >= parent.top && bounds.top + bounds.height <= parent.top + parent.height);
		assert.ok(
			bounds.left + bounds.width <= moving.left || bounds.left >= moving.left + moving.width
				|| bounds.top + bounds.height <= moving.top || bounds.top >= moving.top + moving.height,
			`文案 ${index} 不得压住当前组件`
		);
		for (const previous of labels.slice(0, index)) {
			assert.ok(
				bounds.left + bounds.width <= previous.left || bounds.left >= previous.left + previous.width
					|| bounds.top + bounds.height <= previous.top || bounds.top >= previous.top + previous.height,
				`文案 ${index} 不得与其它文案重叠`
			);
		}
	}
});

test("相对布局短底边距文案留在组件下方的所属间距线旁", () => {
	const moving = { height: 40, left: 74, top: 52, width: 80 };
	const parent = { height: 250, left: 0, top: 0, width: 315 };
	const guides = currentDesignerRelativeGuides(
		moving,
		parent,
		[{ componentName: "父.居中", height: 40, left: 100, top: 99, width: 80, xmlPath: "center" }],
		{ above: "center" },
		{ bottom: 7 },
		RELATIVE_RULE_LABELS
	);
	const placements = layoutDesignerRelativeLabels(guides, moving, parent, (label) => label.length * 6);
	assert.equal(guides[0]?.connector?.marginSide, "bottom");
	const label = placements[0]?.connector;
	assert.ok(label);
	assert.ok(label.top >= moving.top + moving.height, "底边距文字不能翻到组件上方");
	assert.ok(label.top <= (guides[0]?.connector?.end ?? 0) + 4, "文字应贴近底部的短间距线");
	const rule = placements[0]?.rule;
	assert.ok(rule);
	assert.ok(
		label.left + label.width <= rule.left || label.left >= rule.left + rule.width
			|| label.top + label.height <= rule.top || label.top >= rule.top + rule.height,
		"底边距数字与位于顶边规则名不能相互遮挡"
	);
});

test("相对布局拥挤处的边距数字不压当前组件、示意线或其它文案", () => {
	const moving = { height: 40, left: 192, top: 155, width: 80 };
	const parent = { height: 327, left: 86, top: 58, width: 350 };
	const guides = currentDesignerRelativeGuides(
		moving,
		parent,
		[
			{ componentName: "下方", height: 40, left: 221, top: 202, width: 80, xmlPath: "lower" },
			{ componentName: "右方", height: 40, left: 301, top: 161, width: 80, xmlPath: "right" }
		],
		{ above: "lower", leftOf: "right" },
		{ bottom: 7, right: 29 },
		RELATIVE_RULE_LABELS
	);
	const placements = layoutDesignerRelativeLabels(
		guides,
		moving,
		parent,
		(label) => [...label].reduce((width, character) => width + (character.charCodeAt(0) <= 0x7f ? 6 : 10), 0)
	);
	const labels = placements.flatMap((placement) => [placement.connector, placement.rule])
		.filter((bounds) => bounds !== undefined);
	assert.equal(labels.length, 4);
	const bottomIndex = guides.findIndex((guide) => guide.connector?.marginSide === "bottom");
	const bottomLabel = placements[bottomIndex]?.connector;
	const bottomLine = guides[bottomIndex]?.connector;
	assert.ok(bottomLabel && bottomLine);
	assert.ok(Math.min(
		Math.abs(bottomLabel.left - bottomLine.position),
		Math.abs(bottomLabel.left + bottomLabel.width - bottomLine.position)
	) <= 6, "7dp 应贴着自己的竖向间距线，而不是被推到远处");
	const intersects = (left: DesignerRelativeLabelBounds, right: DesignerRelativeLabelBounds): boolean => (
		left.left < right.left + right.width && left.left + left.width > right.left
		&& left.top < right.top + right.height && left.top + left.height > right.top
	);
	for (const [index, label] of labels.entries()) {
		assert.equal(intersects(label, moving), false, `文案 ${index} 不能盖住当前组件`);
		for (const previous of labels.slice(0, index)) {
			assert.equal(intersects(label, previous), false, `文案 ${index} 不能盖住其它文案`);
		}
		for (const guide of guides) {
			for (const line of [guide, guide.connector].filter((value) => value !== undefined)) {
				const bounds = line.axis === "vertical"
					? { height: line.end - line.start, left: line.position - 0.5, top: line.start, width: 1 }
					: { height: 1, left: line.start, top: line.position - 0.5, width: line.end - line.start };
				assert.equal(intersects(label, bounds), false, `文案 ${index} 不能压住示意线`);
			}
		}
	}
});

test("相对布局四向短边距文案保持所属边，父级规则只保留边框提示", () => {
	const moving = { height: 40, left: 100, top: 100, width: 80 };
	const parent = { height: 300, left: 0, top: 93, width: 315 };
	const margin = { bottom: 7, left: 7, right: 7, top: 7 };
	const guides = currentDesignerRelativeGuides(moving, parent, [], { alignParentTop: true }, margin, RELATIVE_RULE_LABELS);
	const placements = layoutDesignerRelativeLabels(guides, moving, parent, (label) => label.length * 6);
	const parentGuide = guides.findIndex((guide) => guide.target === "parent");
	assert.ok(parentGuide >= 0);
	assert.deepEqual(placements[parentGuide]?.rule, undefined);
	assert.ok(placements[parentGuide]?.connector, "父级对齐的边距文字也要参与避让");
	for (const side of ["bottom", "left", "right"] as const) {
		const index = guides.findIndex((guide) => guide.marginSide === side);
		const bounds = placements[index]?.rule;
		assert.ok(bounds, `${side} 边距必须有文字`);
		if (side === "bottom") assert.ok(bounds.top >= moving.top + moving.height);
		if (side === "left") assert.ok(bounds.left + bounds.width <= moving.left);
		if (side === "right") assert.ok(bounds.left >= moving.left + moving.width);
	}
});

test("相对布局底边空间不足时把短边距文字移到线旁而非盖住组件", () => {
	const moving = { height: 40, left: 100, top: 100, width: 80 };
	const parent = { height: 147, left: 0, top: 0, width: 315 };
	const guides = currentDesignerRelativeGuides(moving, parent, [], {}, { bottom: 7 }, RELATIVE_RULE_LABELS);
	const label = layoutDesignerRelativeLabels(guides, moving, parent, (text) => text.length * 6)[0]?.rule;
	assert.ok(label);
	assert.ok(label.top + label.height <= parent.top + parent.height);
	assert.ok(label.left + label.width <= moving.left || label.left >= moving.left + moving.width);
});

test("相对布局拖动只返回能够真实写回的父级和同级停靠关系", () => {
	const parent = { height: 200, left: 100, top: 50, width: 300 };
	const sibling = {
		componentName: "按钮2",
		height: 30,
		left: 220,
		top: 120,
		width: 80,
		xmlPath: "/属性/定义[1]/定义[2]"
	};
	const parentSnap = resolveDesignerRelativeSnap(
		{ height: 20, left: 246, top: 137, width: 10 },
		parent,
		[],
		{ horizontal: true, vertical: true },
		RELATIVE_RULE_LABELS
	);
	assert.deepEqual({ left: parentSnap.left, top: parentSnap.top }, { left: 245, top: 140 });
	assert.deepEqual(parentSnap.guides.map((guide) => [guide.axis, guide.target]), [
		["vertical", "parent"],
		["horizontal", "parent"]
	]);
	assert.equal(parentSnap.horizontalDock?.projection, "centerInParent");
	assert.equal(parentSnap.verticalDock?.projection, "centerInParent");
	assert.deepEqual(parentSnap.guides.map((guide) => guide.label), ["居中于父", "居中于父"]);
	assert.deepEqual(parentSnap.guides.map((guide) => guide.rule), ["centerInParent", "centerInParent"]);
	assert.deepEqual(parentSnap.guides.map((_, index) => designerRelativeGuideLabelMode(parentSnap.guides, index)), [
		"hidden",
		"center-in-parent"
	]);
	assert.equal(designerRelativeGuideLabelMode([{ ...parentSnap.guides[0]!, rule: "centerHorizontal" }], 0), "default");
	assert.equal(parentSnap.margin, undefined);

	const parentEdgeSnap = resolveDesignerRelativeSnap(
		{ height: 20, left: 110, top: 60, width: 10 },
		parent,
		[],
		{ horizontal: true, vertical: true },
		RELATIVE_RULE_LABELS
	);
	assert.deepEqual({ left: parentEdgeSnap.left, top: parentEdgeSnap.top }, { left: 110, top: 60 });
	assert.equal(parentEdgeSnap.horizontalDock?.projection, "alignParentLeft");
	assert.equal(parentEdgeSnap.verticalDock?.projection, "alignParentTop");
	assert.deepEqual(parentEdgeSnap.margin, { left: 10, top: 10 });
	assert.deepEqual(parentEdgeSnap.guides.map((guide) => guide.label), ["对齐父左边", "对齐父顶边"]);
	assert.deepEqual(parentEdgeSnap.guides.map((guide) => guide.connector?.label), ["10dp", "10dp"]);
	assert.ok(parentEdgeSnap.guides.every((guide) => guide.connector !== undefined));

	const siblingSnap = resolveDesignerRelativeSnap(
		{ height: 20, left: 216, top: 94, width: 50 },
		parent,
		[sibling],
		{ horizontal: true, vertical: false },
		RELATIVE_RULE_LABELS
	);
	assert.equal(siblingSnap.left, 220);
	assert.equal(siblingSnap.top, 94);
	assert.deepEqual(siblingSnap.guides.map((guide) => [guide.axis, guide.target]), [
		["vertical", "sibling"]
	]);
	assert.equal(siblingSnap.guides[0]?.start, 78);
	assert.equal(siblingSnap.guides[0]?.end, 166);
	assert.equal(siblingSnap.guides[0]?.label, "对齐左边");
	assert.equal(siblingSnap.guides[0]?.labelPlacement, "start");
	assert.equal(siblingSnap.guides[0]?.label.includes("按钮2"), false);
	assert.deepEqual(siblingSnap.horizontalDock, {
		axis: "horizontal",
		projection: "alignLeft",
		targetComponentName: "按钮2",
		targetXmlPath: "/属性/定义[1]/定义[2]"
	});

	const adjacentSnap = resolveDesignerRelativeSnap(
		{ height: 20, left: 164, top: 94, width: 50 },
		parent,
		[sibling],
		{ horizontal: true, vertical: true },
		RELATIVE_RULE_LABELS
	);
	assert.deepEqual({ left: adjacentSnap.left, top: adjacentSnap.top }, { left: 170, top: 100 });
	const horizontalGuide = adjacentSnap.guides.find((guide) => guide.axis === "horizontal");
	assert.equal(horizontalGuide?.start, 148);
	assert.equal(horizontalGuide?.end, 316);
	assert.equal(adjacentSnap.horizontalDock?.projection, "leftOf");
	assert.equal(adjacentSnap.verticalDock?.projection, "above");

	const nearbySiblingAlignment = resolveDesignerRelativeSnap(
		{ height: 20, left: 252, top: 80, width: 20 },
		parent,
		[sibling],
		{ horizontal: true, vertical: false },
		RELATIVE_RULE_LABELS
	);
	assert.equal(nearbySiblingAlignment.horizontalDock?.projection, "alignRight");
	assert.equal(nearbySiblingAlignment.horizontalDock?.targetComponentName, "按钮2");
	assert.deepEqual(nearbySiblingAlignment.margin, { right: 28 });
	assert.equal(nearbySiblingAlignment.guides[0]?.label, "对齐右边");
	assert.equal(nearbySiblingAlignment.guides[0]?.connector?.label, "28dp");

	const fractionalSiblingSnap = resolveDesignerRelativeSnap(
		{ height: 20, left: 252, top: 66, width: 20 },
		parent,
		[{
			componentName: "小数坐标组件",
			height: 40,
			left: 200.00003051757812,
			top: 100.00003051757812,
			width: 80,
			xmlPath: "fractional"
		}],
		{ horizontal: true, vertical: true },
		RELATIVE_RULE_LABELS
	);
	assert.deepEqual(fractionalSiblingSnap.margin, { bottom: 14, right: 8 });
	assert.deepEqual(
		fractionalSiblingSnap.guides.map((guide) => guide.connector?.label),
		["8dp", "14dp"]
	);

	const distantSiblingSnap = resolveDesignerRelativeSnap(
		{ height: 20, left: 216, top: 91, width: 50 },
		parent,
		[{ ...sibling, top: 500 }],
		{ horizontal: true, vertical: false },
		RELATIVE_RULE_LABELS
	);
	assert.equal(distantSiblingSnap.horizontalDock?.projection, "alignParentLeft");
	assert.deepEqual(distantSiblingSnap.margin, { left: 116 });

	const diagonalSiblingSnap = resolveDesignerRelativeSnap(
		{ height: 40, left: 320, top: 100, width: 60 },
		{ height: 600, left: 0, top: 0, width: 500 },
		[{ componentName: "父.右上", height: 60, left: 400, top: 20, width: 80, xmlPath: "top-right" }],
		{ horizontal: true, vertical: true },
		RELATIVE_RULE_LABELS
	);
	assert.deepEqual({ left: diagonalSiblingSnap.left, top: diagonalSiblingSnap.top }, { left: 320, top: 100 });
	assert.equal(diagonalSiblingSnap.horizontalDock?.projection, "leftOf");
	assert.equal(diagonalSiblingSnap.horizontalDock?.targetComponentName, "父.右上");
	assert.equal(diagonalSiblingSnap.verticalDock?.projection, "below");
	assert.equal(diagonalSiblingSnap.verticalDock?.targetComponentName, "父.右上");
	assert.deepEqual(diagonalSiblingSnap.margin, { right: 20, top: 20 });

	const closerParentSnap = resolveDesignerRelativeSnap(
		{ height: 40, left: 10, top: 10, width: 60 },
		{ height: 600, left: 0, top: 0, width: 500 },
		[{ componentName: "附近组件", height: 60, left: 100, top: 100, width: 80, xmlPath: "nearby" }],
		{ horizontal: true, vertical: true },
		RELATIVE_RULE_LABELS
	);
	assert.equal(closerParentSnap.horizontalDock?.projection, "alignParentLeft");
	assert.equal(closerParentSnap.verticalDock?.projection, "alignParentTop");
	assert.deepEqual(closerParentSnap.margin, { left: 10, top: 10 });
});

test("单帧布局拖动只生成父级九宫格对齐和边距", () => {
	assert.deepEqual([
		designerFrameAlignmentLabel({ horizontal: "left", vertical: "top" }),
		designerFrameAlignmentLabel({ horizontal: "center", vertical: "top" }),
		designerFrameAlignmentLabel({ horizontal: "right", vertical: "top" }),
		designerFrameAlignmentLabel({ horizontal: "left", vertical: "center" }),
		designerFrameAlignmentLabel({ horizontal: "center", vertical: "center" }),
		designerFrameAlignmentLabel({ horizontal: "right", vertical: "center" }),
		designerFrameAlignmentLabel({ horizontal: "left", vertical: "bottom" }),
		designerFrameAlignmentLabel({ horizontal: "center", vertical: "bottom" }),
		designerFrameAlignmentLabel({ horizontal: "right", vertical: "bottom" })
	], ["左上", "中上", "右上", "左中", "居中", "右中", "左下", "中下", "右下"]);
	assert.deepEqual([
		designerFrameAlignmentLabelSide({ horizontal: "left", vertical: "top" }),
		designerFrameAlignmentLabelSide({ horizontal: "center", vertical: "center" }),
		designerFrameAlignmentLabelSide({ horizontal: "right", vertical: "bottom" })
	], ["below", undefined, "above"]);
	const parent = { height: 200, left: 100, top: 50, width: 300 };
	const centered = resolveDesignerFrameSnap(
		{ height: 20, left: 246, top: 137, width: 10 },
		parent
	);
	assert.deepEqual({ left: centered.left, top: centered.top }, { left: 245, top: 140 });
	assert.deepEqual(centered.placement, {
		alignment: { horizontal: "center", vertical: "center" },
		margin: undefined
	});
	assert.deepEqual(centered.guides.map((guide) => guide.label), ["居中", "居中"]);

	const upperLeft = resolveDesignerFrameSnap(
		{ height: 20, left: 110, top: 60, width: 10 },
		parent
	);
	assert.deepEqual(upperLeft.placement, {
		alignment: { horizontal: "left", vertical: "top" },
		margin: { left: 10, top: 10 }
	});
	assert.deepEqual(upperLeft.guides.map((guide) => guide.label), ["左对齐", "顶部对齐"]);
	assert.deepEqual(upperLeft.guides.map((guide) => guide.connector?.label), ["10dp", "10dp"]);

	const lowerRight = resolveDesignerFrameSnap(
		{ height: 20, left: 360, top: 210, width: 20 },
		parent
	);
	assert.deepEqual(lowerRight.placement, {
		alignment: { horizontal: "right", vertical: "bottom" },
		margin: { bottom: 20, right: 20 }
	});
	assert.deepEqual(lowerRight.guides.map((guide) => guide.label), ["右对齐", "底部对齐"]);
});

test("相对布局示意文字避开拖拽组件并在有效内容边界翻向", () => {
	const moving = { height: 40, left: 100, top: 80, width: 60 };
	const verticalGuide = {
		axis: "vertical" as const,
		end: 160,
		kind: "dock" as const,
		label: "位于右边",
		labelPlacement: "start" as const,
		position: 160,
		start: 80,
		target: "sibling" as const,
		title: "位于右边"
	};
	assert.equal(designerRelativeGuideLabelSide(verticalGuide, moving, { height: 300, width: 300 }), "right");
	assert.equal(designerRelativeGuideLabelSide(
		{ ...verticalGuide, position: 255 },
		{ ...moving, left: 195 },
		{ height: 300, width: 300 }
	), "right");
	assert.equal(designerRelativeGuideLabelSide(
		{ ...verticalGuide, position: 255 },
		{ ...moving, left: 195 },
		{ height: 300, width: 300 },
		"horizontal"
	), "left");
	assert.equal(designerRelativeGuideLabelSide(
		{ ...verticalGuide, position: 298 },
		{ ...moving, left: 238 },
		{ height: 300, width: 300 }
	), "left");
	assert.equal(designerRelativeGuideLabelSide(
		{ ...verticalGuide, position: 42 },
		{ ...moving, left: 42 },
		{ height: 200, left: 40, top: 40, width: 200 }
	), "right");
	const horizontalGuide = { ...verticalGuide, axis: "horizontal" as const, position: 80 };
	assert.equal(designerRelativeGuideLabelSide(horizontalGuide, moving, { height: 300, width: 300 }), "above");
	assert.equal(designerRelativeGuideLabelSide(
		{ ...horizontalGuide, position: 2 },
		{ ...moving, top: 2 },
		{ height: 300, width: 300 }
	), "below");
	assert.equal(designerRelativeGuideLabelSide(
		{ ...horizontalGuide, position: 42 },
		{ ...moving, top: 42 },
		{ height: 200, left: 40, top: 40, width: 200 }
	), "below");
});

test("相对布局短间距文字移到远离拖拽组件的端点外侧", () => {
	const moving = { height: 40, left: 100, top: 80, width: 60 };
	assert.equal(designerRelativeShortGuideLabelCenter({
		axis: "horizontal",
		end: 180,
		label: "5dp",
		start: 160
	}, moving), 195);
	assert.equal(designerRelativeShortGuideLabelCenter({
		axis: "vertical",
		end: 80,
		label: "5dp",
		start: 60
	}, moving), 45);
	assert.equal(designerRelativeShortGuideLabelCenter({
		axis: "horizontal",
		end: 240,
		label: "5dp",
		start: 160
	}, moving), undefined);
});

test("设计期固定尺寸严格保持声明值且不被最小交互区域放大", () => {
	const node: DesignerComponentNode = {
		children: [],
		container: true,
		displayText: "面板1",
		height: { kind: "fixed", value: 1 },
		layout: "grid",
		name: "面板1",
		path: "/属性/定义[1]/定义[1]",
		textComponent: false,
		type: "面板",
		visual: true,
		width: { kind: "fixed", value: 1 }
	};
	const presentation = componentPresentation(node, undefined, "container");
	assert.equal(presentation.style.width, "1px");
	assert.equal(presentation.style.minWidth, "1px");
	assert.equal(presentation.style.maxWidth, "1px");
	assert.equal(presentation.style.height, "1px");
	assert.equal(presentation.style.minHeight, "1px");
	assert.equal(presentation.style.maxHeight, "1px");
	assert.ok(presentation.classes.includes("designer-width-fixed"));
	assert.ok(presentation.classes.includes("designer-height-fixed"));
});

test("没有运行内容的适应内容组件只使用最小交互尺寸", () => {
	const node: DesignerComponentNode = {
		children: [],
		container: false,
		displayText: "很长的设计期组件名称",
		displayTextPlaceholder: true,
		height: { kind: "content" },
		layout: "linear-vertical",
		name: "很长的设计期组件名称",
		path: "/属性/定义[1]/定义[1]",
		textComponent: true,
		type: "按钮",
		visual: true,
		width: { kind: "content" }
	};
	const presentation = componentPresentation(node, undefined, "control");
	assert.ok(presentation.classes.includes("designer-empty-content"));
	assert.ok(presentation.classes.includes("designer-display-placeholder"));
	assert.ok(presentation.classes.includes("designer-width-content"));
	assert.ok(presentation.classes.includes("designer-height-content"));
	const contentPresentation = componentPresentation({
		...node,
		displayText: "文本",
		displayTextPlaceholder: false
	}, undefined, "control");
	assert.equal(contentPresentation.classes.includes("designer-empty-content"), false);
	assert.equal(contentPresentation.classes.includes("designer-display-placeholder"), false);
});

test("空容器仅在适应内容方向使用最小交互尺寸", () => {
	const node: DesignerComponentNode = {
		children: [],
		container: true,
		displayText: "",
		height: { kind: "fixed", value: 20 },
		layout: "linear-vertical",
		name: "面板1",
		path: "/属性/定义[1]/定义[1]",
		textComponent: false,
		type: "面板",
		visual: true,
		width: { kind: "content" }
	};
	const presentation = componentPresentation(node, undefined, "container");
	assert.ok(presentation.classes.includes("designer-empty-content"));
	assert.ok(presentation.classes.includes("designer-width-content"));
	assert.ok(presentation.classes.includes("designer-height-fixed"));
	assert.equal(presentation.style.height, "20px");

	const child: DesignerComponentNode = {
		...node,
		container: false,
		name: "标签1",
		path: node.path + "/定义[1]",
		textComponent: true,
		type: "标签"
	};
	assert.equal(componentPresentation({ ...node, children: [child] }, undefined, "container")
		.classes.includes("designer-empty-content"), false);
});

test("真实滚动框窗口内的空面板不会让适应内容高度塌缩，且不改写 XML", async () => {
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	for (const direction of ["水平", "垂直"]) {
		const source = await fs.readFile(path.resolve("..", "simple", "tests", "simple", "runtime",
			"DeviceTests", "SmokeTests", "src", "simple", "runtime", "smoketests", "containers",
			`测试${direction}滚动框.simple`), "utf8");
		const document = parseSimplePropertyXml(source);
		assert.ok(document);
		const before = serializePropertyXml(document);
		const model = createSimpleDesignerModel(document, sdk);
		const scroll = findComponent(model.root, `${direction}滚动框1`);
		assert.ok(scroll);
		assert.equal(scroll.layout, "frame");
		assert.deepEqual(scroll.height, { kind: direction === "水平" ? "content" : "parent" });
		const panel = findComponent(scroll, "面板2");
		assert.ok(panel);
		/* 正式样例允许用户加入内容；仅在投影副本中构造空面板，保持 XML 和源码不变。 */
		const emptyScroll = { ...scroll, children: [{ ...panel, children: [] }] };
		assert.equal(componentPresentation(emptyScroll, undefined, "container").style.minHeight,
			direction === "水平" ? "var(--designer-empty-content-min-height)" : undefined);
		assert.equal(componentPresentation(emptyScroll, undefined, "container").style.minWidth, undefined);
		assert.deepEqual(panel.height, { kind: "parent" });
		assert.equal(componentPresentation(panel, undefined, "container").style.minHeight, undefined);
		assert.equal(serializePropertyXml(document), before);
	}
});

test("嵌套空容器逐方向补足交互尺寸，实际文本和固定内容尺寸保持自然测量", () => {
	const child: DesignerComponentNode = {
		children: [], container: true, displayText: "", displayTextPlaceholder: true,
		height: { kind: "parent" }, layout: "frame", name: "空面板", path: "/child",
		textComponent: false, type: "面板", visual: true, width: { kind: "parent" }
	};
	const parent: DesignerComponentNode = {
		...child, children: [child], height: { kind: "content" }, name: "父容器", path: "/parent",
		width: { kind: "content" }
	};
	const style = componentPresentation(parent, undefined, "container").style;
	assert.equal(style.minHeight, "var(--designer-empty-content-min-height)");
	assert.equal(style.minWidth, "var(--designer-empty-content-min-width)");
	const fixedChild = { ...child, width: { kind: "fixed", value: 12 } as const };
	const fixedWidthStyle = componentPresentation({ ...parent, children: [fixedChild] }, undefined, "container").style;
	assert.equal(fixedWidthStyle.minWidth, undefined);
	assert.equal(fixedWidthStyle.minHeight, "var(--designer-empty-content-min-height)");
	const measuredChild = { ...fixedChild, height: { kind: "fixed", value: 18 } as const };
	assert.equal(componentPresentation({ ...parent, children: [measuredChild] }, undefined, "container").style.minHeight, undefined);
	const text = { ...child, container: false, displayText: "实际文本", displayTextPlaceholder: false };
	assert.equal(componentPresentation({ ...parent, children: [{ ...child, children: [text] }] }, undefined, "container").style.minHeight, undefined);
	const fixedParent = { ...parent, height: { kind: "fixed", value: 1 } as const };
	assert.equal(componentPresentation(fixedParent, undefined, "container").style.minHeight, "1px");
	const matchingParent = { ...parent, height: { kind: "parent" } as const };
	assert.equal(componentPresentation(matchingParent, undefined, "container").style.minHeight, undefined);
});

test("匹配父级组件区分已解析的外边距与内填充", async () => {
	const document = parseSimplePropertyXml([
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 MarginTests $为 窗口",
		"\t\t$定义 Scroll1 $为 垂直滚动框",
		"\t\t\t宽度 = 长度_匹配父级",
		"\t\t\t左边距 = 到绝对像素(10)",
		"\t\t\t顶边距 = \"8dip\"",
		"\t\t\t右边距 = \"10dp\"",
		"\t\t\t底边距 = \"6px\"",
		"\t\t\t左填充 = \"4dp\"",
		"\t\t\t顶填充 = 到绝对像素(5)",
		"\t\t\t右填充 = \"6dip\"",
		"\t\t\t底填充 = \"7px\"",
		"\t\t$结束 $定义",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.ok(document);
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const model = createSimpleDesignerModel(document, sdk);
	const scroll = findComponent(model.root, "Scroll1");
	assert.ok(scroll);
	assert.deepEqual(scroll.margin, { bottom: 6, left: 10, right: 10, top: 8 });
	assert.deepEqual(scroll.padding, { bottom: 7, left: 4, right: 6, top: 5 });

	const presentation = componentPresentation(scroll, undefined, "container");
	assert.ok(presentation.classes.includes("designer-width-parent"));
	assert.equal(presentation.style["--designer-margin-left"], "10px");
	assert.equal(presentation.style["--designer-margin-top"], "8px");
	assert.equal(presentation.style["--designer-margin-right"], "10px");
	assert.equal(presentation.style["--designer-margin-bottom"], "6px");
	assert.equal(presentation.style["margin-left"], "10px");
	assert.equal(presentation.style["margin-right"], "10px");
	assert.equal(presentation.style["padding-left"], undefined);
	assert.deepEqual(containerInsetStyle(scroll), {
		"padding-bottom": "calc(var(--designer-layout-spacing) + 7px)",
		"padding-left": "calc(var(--designer-layout-spacing) + 4px)",
		"padding-right": "calc(var(--designer-layout-spacing) + 6px)",
		"padding-top": "calc(var(--designer-layout-spacing) + 5px)"
	});
});

test("单帧布局子组件未设置宽高时匹配父级", async () => {
	const document = parseSimplePropertyXml([
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 FrameTests $为 窗口",
		"\t\t布局 = 布局_单帧",
		"\t\t左填充 = 6",
		"\t\t$定义 DefaultButton $为 按钮",
		"\t\t$结束 $定义",
		"\t\t$定义 ContentButton $为 按钮",
		"\t\t\t宽度 = 长度_适应内容",
		"\t\t\t高度 = 长度_适应内容",
		"\t\t$结束 $定义",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.ok(document);
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const model = createSimpleDesignerModel(document, sdk);
	const defaultButton = findComponent(model.root, "DefaultButton");
	const contentButton = findComponent(model.root, "ContentButton");
	assert.ok(model.root);
	assert.ok(defaultButton);
	assert.ok(contentButton);

	assert.equal(model.root.layout, "frame");
	assert.deepEqual(defaultButton.width, { kind: "parent" });
	assert.deepEqual(defaultButton.height, { kind: "parent" });
	assert.ok(componentPresentation(defaultButton, undefined, "control").classes.includes(
		"designer-width-parent"
	));
	assert.ok(componentPresentation(defaultButton, undefined, "control").classes.includes(
		"designer-height-parent"
	));
	assert.deepEqual(contentButton.width, { kind: "content" });
	assert.deepEqual(contentButton.height, { kind: "content" });
	assert.deepEqual(containerStyle(model.root), {
		gridTemplateColumns: "minmax(0, 1fr)",
		gridTemplateRows: "minmax(0, 1fr)"
	});
	assert.deepEqual(containerInsetStyle(model.root), {
		"padding-left": "calc(var(--designer-layout-spacing) + 6px)"
	});
});

test("绝对布局按左边和顶边投影子组件且缺省宽高适应内容", async () => {
	const document = parseSimplePropertyXml([
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 AbsoluteTests $为 窗口",
		"\t\t布局 = 布局_绝对",
		"\t\t左填充 = 6",
		"\t\t顶填充 = 8",
		"\t\t$定义 Button1 $为 按钮",
		"\t\t\t左边 = \"24dip\"",
		"\t\t\t顶边 = \"36dp\"",
		"\t\t$结束 $定义",
		"\t\t$定义 Button2 $为 按钮",
		"\t\t\t左边 = \"48px\"",
		"\t\t\t顶边 = 到绝对像素(64)",
		"\t\t$结束 $定义",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.ok(document);
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const model = createSimpleDesignerModel(document, sdk);
	const button = findComponent(model.root, "Button1");
	const secondButton = findComponent(model.root, "Button2");
	assert.ok(model.root);
	assert.ok(button);
	assert.ok(secondButton);

	assert.equal(model.root.layout, "absolute");
	assert.deepEqual(button.absolutePosition, { left: 24, top: 36 });
	assert.deepEqual(button.width, { kind: "content" });
	assert.deepEqual(button.height, { kind: "content" });
	const presentation = componentPresentation(button, undefined, "control");
	assert.ok(presentation.classes.includes("designer-absolute-positioned"));
	assert.equal(presentation.classes.includes("selected"), false);
	assert.equal(componentPresentation(button, button.path, "control").classes.includes("selected"), true);
	assert.equal(presentation.style["--designer-absolute-left"], "24px");
	assert.equal(presentation.style["--designer-absolute-top"], "36px");
	assert.deepEqual(secondButton.absolutePosition, { left: 48, top: 64 });
	assert.deepEqual(containerStyle(model.root), {
		"--designer-absolute-inset-left": "0px",
		"--designer-absolute-inset-top": "0px"
	});
	assert.deepEqual(containerInsetStyle(model.root), {
		"padding-left": "calc(var(--designer-layout-spacing) + 6px)",
		"padding-top": "calc(var(--designer-layout-spacing) + 8px)"
	});
});

test("文本组件使用 SDK 继承缺省值并保留完整二维对齐", async () => {
	const document = parseSimplePropertyXml([
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 ProjectionTests $为 窗口",
		"\t\t$定义 Label1 $为 标签",
		"\t\t$结束 $定义",
		"\t\t$定义 Edit1 $为 编辑框",
		"\t\t\t宽度 = -2",
		"\t\t\t高度 = -2",
		"\t\t$结束 $定义",
		"\t\t$定义 Button1 $为 按钮",
		"\t\t$结束 $定义",
		"\t\t$定义 Password1 $为 密码编辑框",
		"\t\t$结束 $定义",
		"\t\t$定义 Radio1 $为 单选框",
		"\t\t$结束 $定义",
		"\t\t$定义 Check1 $为 复选框",
		"\t\t$结束 $定义",
		"\t\t$定义 Mail1 $为 邮箱选择器",
		"\t\t$结束 $定义",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.ok(document);
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const model = createSimpleDesignerModel(document, sdk);
	const label = findComponent(model.root, "Label1");
	const edit = findComponent(model.root, "Edit1");
	const button = findComponent(model.root, "Button1");
	const password = findComponent(model.root, "Password1");
	const radio = findComponent(model.root, "Radio1");
	const checkbox = findComponent(model.root, "Check1");
	const mail = findComponent(model.root, "Mail1");

	assert.equal(model.root?.backgroundColor, "#FFFFFFFF");
	assert.equal(model.root?.layout, "linear-vertical");
	assert.deepEqual(model.root?.layoutContentAlignment, { horizontal: "left", vertical: undefined });
	assert.equal(model.root?.layoutBaselineAligned, false);
	assert.equal(label?.alignment, undefined);
	assert.deepEqual(label?.contentAlignment, { horizontal: "left", vertical: "top" });
	assert.equal(label?.fontBold, false);
	assert.equal(label?.fontFamily, "sans-serif");
	assert.equal(label?.fontItalic, false);
	assert.equal(label?.fontSize, 14);
	assert.equal(label?.singleLine, false);
	assert.equal(label?.textColor, "#000000FF");
	assert.deepEqual(edit?.contentAlignment, { horizontal: "left", vertical: "top" });
	assert.deepEqual(button?.contentAlignment, { horizontal: "center", vertical: "center" });
	for (const component of [label, edit, button, password, radio, checkbox, mail]) {
		assert.ok(componentPresentation(component!, undefined, "control").classes.includes("designer-text-control"));
	}

	const editClasses = componentPresentation(edit!, undefined, "control").classes;
	assert.ok(editClasses.includes("designer-content-horizontal-left"));
	assert.ok(editClasses.includes("designer-content-vertical-top"));
	assert.ok(editClasses.includes("designer-multiline"));
	const buttonClasses = componentPresentation(button!, undefined, "control").classes;
	assert.ok(buttonClasses.includes("designer-content-horizontal-center"));
	assert.ok(buttonClasses.includes("designer-content-vertical-center"));
});

test("颜色投影兼容十六进制常量与十进制 32 位 ARGB 整数", async () => {
	const document = parseSimplePropertyXml([
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 ColorTests $为 窗口",
		"\t\t背景颜色 = -65536",
		"\t\t$定义 Label1 $为 标签",
		"\t\t\t文本颜色 = -16711936",
		"\t\t$结束 $定义",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.ok(document);
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const model = createSimpleDesignerModel(document, sdk);
	const label = findComponent(model.root, "Label1");

	assert.equal(model.root?.backgroundColor, "#FF0000FF");
	assert.equal(label?.textColor, "#00FF00FF");
});

test("表格布局投影单元格并区分缺失、越界和重复位置", async () => {
	const document = parseSimplePropertyXml([
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 GridTests $为 窗口",
		"\t\t布局 = 2",
		"\t\t布局.行数 = 2",
		"\t\t布局.列数 = 2",
		"\t\t布局.内容对齐 = 对齐_右下",
		"\t\t布局.所有列可收缩 = 真",
		"\t\t布局.所有列可拉伸 = 假",
		"\t\t$定义 Positioned $为 按钮",
		"\t\t\t行 = 0",
		"\t\t\t列 = 1",
		"\t\t$结束 $定义",
		"\t\t$定义 MissingPosition $为 按钮",
		"\t\t$结束 $定义",
		"\t\t$定义 OutOfBounds $为 按钮",
		"\t\t\t行 = 2",
		"\t\t\t列 = 0",
		"\t\t$结束 $定义",
		"\t\t$定义 Duplicate $为 按钮",
		"\t\t\t行 = 0",
		"\t\t\t列 = 1",
		"\t\t$结束 $定义",
		"\t\t$定义 Valid $为 按钮",
		"\t\t\t行 = 1",
		"\t\t\t列 = 0",
		"\t\t$结束 $定义",
		"\t\t$定义 Timer1 $为 计时器",
		"\t\t$结束 $定义",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.ok(document);
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const model = createSimpleDesignerModel(document, sdk);
	const positioned = findComponent(model.root, "Positioned");
	const missing = findComponent(model.root, "MissingPosition");
	const outOfBounds = findComponent(model.root, "OutOfBounds");
	const duplicate = findComponent(model.root, "Duplicate");
	const valid = findComponent(model.root, "Valid");
	const timer = findComponent(model.root, "Timer1");

	assert.equal(model.root?.layoutGridSizeValid, true);
	assert.equal(model.root?.layoutAllColumnsShrinkable, true);
	assert.equal(model.root?.layoutAllColumnsStretchable, false);
	assert.deepEqual(model.root?.layoutContentAlignment, { horizontal: "right", vertical: "bottom" });
	assert.equal(positioned?.gridPositionValid, false);
	assert.equal(positioned?.gridPositionIssue, "duplicate");
	assert.equal(missing?.gridPositionValid, false);
	assert.equal(missing?.gridPositionIssue, "missing");
	assert.equal(outOfBounds?.gridPositionValid, false);
	assert.equal(outOfBounds?.gridPositionIssue, "out-of-bounds");
	assert.equal(duplicate?.gridPositionIssue, "duplicate");
	assert.equal(valid?.gridPositionValid, true);
	assert.deepEqual(valid?.width, { kind: "parent" });
	assert.deepEqual(valid?.height, { kind: "content" });
	assert.equal(timer?.gridPositionValid, undefined);
	assert.ok(componentPresentation(missing!, undefined, "control").classes.includes(
		"designer-grid-position-invalid"
	));
	assert.match(componentHoverHint(missing!), /运行时不会放置此组件/u);
	assert.match(componentHoverHint(outOfBounds!), /超出表格范围/u);
	assert.match(componentHoverHint(duplicate!), /多个组件/u);
	const outOfBoundsStyle = componentPresentation(outOfBounds!, undefined, "control").style;
	assert.equal(outOfBoundsStyle.gridColumn, "1 / -1");
	assert.equal(outOfBoundsStyle.gridRow, undefined);
	const cells = designerGridCells(model.root!);
	assert.equal(cells.length, 4);
	assert.equal(cells.find((cell) => cell.key === "0:0")?.occupiedComponentPath, undefined);
	assert.equal(cells.find((cell) => cell.key === "0:1")?.occupiedComponentPath, positioned?.path);
	assert.equal(cells.find((cell) => cell.key === "0:1")?.occupiedComponent?.node, positioned);
	assert.equal(cells.find((cell) => cell.key === "1:0")?.occupiedComponentPath, valid?.path);
	assert.equal(isDesignerGridPlacedChild(model.root!, valid!), true);
	assert.equal(isDesignerGridPlacedChild(model.root!, missing!), false);
	assert.deepEqual(
		designerGridUnplacedChildren(model.root!).map(({ node }) => node.name),
		["Positioned", "MissingPosition", "OutOfBounds", "Duplicate"]
	);
	assert.deepEqual(containerStyle(model.root!), {
		alignContent: "end",
		gridTemplateColumns: "repeat(2, minmax(0, auto))",
		gridTemplateRows: "repeat(2, max-content)",
		justifyContent: "end"
	});

	const defaultGrid = parseSimplePropertyXml([
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 DefaultGrid $为 窗口",
		"\t\t布局 = 2",
		"\t\t布局.行数 = 1",
		"\t\t布局.列数 = 2",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.ok(defaultGrid);
	const defaultModel = createSimpleDesignerModel(defaultGrid, sdk);
	assert.equal(defaultModel.root?.layoutAllColumnsShrinkable, false);
	assert.equal(defaultModel.root?.layoutAllColumnsStretchable, true);
	assert.deepEqual(containerStyle(defaultModel.root!), {
		alignContent: "start",
		gridTemplateColumns: "repeat(2, auto)",
		gridTemplateRows: "repeat(1, minmax(0, 1fr))",
		justifyContent: "stretch"
	});

	const denseGrid = parseSimplePropertyXml([
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 DenseGrid $为 窗口",
		"\t\t布局 = 2",
		"\t\t布局.行数 = 20",
		"\t\t布局.列数 = 10",
		"\t\t宽度 = 160",
		"\t\t高度 = 320",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.ok(denseGrid);
	const denseGridModel = createSimpleDesignerModel(denseGrid, sdk);
	assert.equal(designerGridCells(denseGridModel.root!).length, 200);
	assert.deepEqual(containerStyle(denseGridModel.root!), {
		alignContent: "start",
		gridTemplateColumns: "repeat(10, auto)",
		gridTemplateRows: "repeat(20, minmax(0, 1fr))",
		justifyContent: "stretch"
	});

	const emptyNonStretchingGrid = parseSimplePropertyXml([
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 EmptyNonStretchingGrid $为 窗口",
		"\t\t布局 = 2",
		"\t\t布局.行数 = 1",
		"\t\t布局.列数 = 4",
		"\t\t布局.所有列可收缩 = 假",
		"\t\t布局.所有列可拉伸 = 假",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.ok(emptyNonStretchingGrid);
	const emptyNonStretchingModel = createSimpleDesignerModel(emptyNonStretchingGrid, sdk);
	assert.equal(designerGridCells(emptyNonStretchingModel.root!).length, 4);
	assert.deepEqual(containerStyle(emptyNonStretchingModel.root!), {
		alignContent: "start",
		gridTemplateColumns: "repeat(4, auto)",
		gridTemplateRows: "repeat(1, minmax(0, 1fr))",
		justifyContent: "start"
	});

	const populatedDefaultGrid = parseSimplePropertyXml([
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 PopulatedGrid $为 窗口",
		"\t\t布局 = 2",
		"\t\t布局.行数 = 1",
		"\t\t布局.列数 = 2",
		"\t\t$定义 FixedButton $为 按钮",
		"\t\t\t宽度 = 120",
		"\t\t\t高度 = 64",
		"\t\t\t行 = 0",
		"\t\t\t列 = 0",
		"\t\t$结束 $定义",
		"\t\t$定义 DefaultButton $为 按钮",
		"\t\t\t行 = 0",
		"\t\t\t列 = 1",
		"\t\t$结束 $定义",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.ok(populatedDefaultGrid);
	const populatedDefaultModel = createSimpleDesignerModel(populatedDefaultGrid, sdk);
	const fixedButton = findComponent(populatedDefaultModel.root, "FixedButton");
	const defaultButton = findComponent(populatedDefaultModel.root, "DefaultButton");
	assert.deepEqual(fixedButton?.width, { kind: "fixed", value: 120 });
	assert.deepEqual(fixedButton?.height, { kind: "fixed", value: 64 });
	assert.deepEqual(defaultButton?.width, { kind: "parent" });
	assert.deepEqual(defaultButton?.height, { kind: "content" });
	assert.deepEqual(containerStyle(populatedDefaultModel.root!), {
		alignContent: "start",
		gridTemplateColumns: "repeat(2, auto)",
		gridTemplateRows: "repeat(1, max-content)",
		justifyContent: "stretch"
	});

	const partiallyPopulatedGrid = parseSimplePropertyXml([
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 PartiallyPopulatedGrid $为 窗口",
		"\t\t布局 = 2",
		"\t\t布局.行数 = 1",
		"\t\t布局.列数 = 4",
		"\t\t布局.所有列可收缩 = 真",
		"\t\t布局.所有列可拉伸 = 假",
		"\t\t$定义 OnlyButton $为 按钮",
		"\t\t\t行 = 0",
		"\t\t\t列 = 0",
		"\t\t$结束 $定义",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.ok(partiallyPopulatedGrid);
	const partiallyPopulatedModel = createSimpleDesignerModel(partiallyPopulatedGrid, sdk);
	assert.deepEqual(containerStyle(partiallyPopulatedModel.root!), {
		alignContent: "start",
		gridTemplateColumns: "repeat(4, minmax(0, auto))",
		gridTemplateRows: "repeat(1, max-content)",
		justifyContent: "start"
	});

	const mixedRowsGrid = parseSimplePropertyXml([
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 MixedRowsGrid $为 窗口",
		"\t\t布局 = 2",
		"\t\t布局.行数 = 3",
		"\t\t布局.列数 = 1",
		"\t\t$定义 FirstButton $为 按钮",
		"\t\t\t行 = 0",
		"\t\t\t列 = 0",
		"\t\t$结束 $定义",
		"\t\t$定义 LastButton $为 按钮",
		"\t\t\t行 = 2",
		"\t\t\t列 = 0",
		"\t\t$结束 $定义",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.ok(mixedRowsGrid);
	const mixedRowsModel = createSimpleDesignerModel(mixedRowsGrid, sdk);
	assert.deepEqual(containerStyle(mixedRowsModel.root!), {
		alignContent: "start",
		gridTemplateColumns: "repeat(1, auto)",
		gridTemplateRows: "max-content minmax(0, 1fr) max-content",
		justifyContent: "stretch"
	});

	const invalidGrid = parseSimplePropertyXml([
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 InvalidGrid $为 窗口",
		"\t\t布局 = 2",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.ok(invalidGrid);
	const invalidModel = createSimpleDesignerModel(invalidGrid, sdk);
	assert.equal(invalidModel.root?.layoutGridSizeValid, false);
	assert.match(componentHoverHint(invalidModel.root!), /有效的行数和列数/u);
});

test("表格行列标签按四边可用空间显示且始终位于格子外", () => {
	assert.deepEqual(designerGridPositionLabelBounds(
		{ height: 40, left: 50, top: 30, width: 100 },
		{ height: 120, left: 0, top: 0, width: 200 },
		{ height: 14, width: 40 }
	), { height: 14, left: 80, top: 15, width: 40 });
	assert.deepEqual(designerGridPositionLabelBounds(
		{ height: 30, left: 10, top: 5, width: 80 },
		{ height: 100, left: 0, top: 0, width: 120 },
		{ height: 14, width: 50 }
	), { height: 14, left: 25, top: 36, width: 50 });
	assert.deepEqual(designerGridPositionLabelBounds(
		{ height: 20, left: 90, top: 30, width: 40 },
		{ height: 60, left: 0, top: 0, width: 100 },
		{ height: 14, width: 60 }
	), { height: 14, left: 36, top: 15, width: 60 });
	assert.deepEqual(designerGridPositionLabelBounds(
		{ height: 20, left: 10, top: 5, width: 30 },
		{ height: 100, left: 0, top: 0, width: 200 },
		{ height: 14, width: 50 }
	), { height: 14, left: 41, top: 8, width: 50 });
	assert.deepEqual(designerGridPositionLabelBounds(
		{ height: 85, left: 80, top: 5, width: 30 },
		{ height: 100, left: 0, top: 0, width: 120 },
		{ height: 14, width: 50 }
	), { height: 14, left: 29, top: 40.5, width: 50 });
	assert.deepEqual(designerGridPositionLabelBounds(
		{ height: 92, left: 4, top: 4, width: 92 },
		{ height: 100, left: 0, top: 0, width: 100 },
		{ height: 14, width: 40 }
	), { height: 14, left: 30, top: -11, width: 40 });
});
