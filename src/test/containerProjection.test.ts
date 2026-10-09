/*
验证组件级容器投影复用已有布局、滚动属性及通用子组件数量约束。
xhwsd@qq.com 2026-10-8
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import {
	addSimpleDesignerComponent,
	canDesignerContainerAcceptVisualChild,
	copySimpleDesignerComponent,
	createSimpleDesignerModel,
	pasteSimpleDesignerComponent,
	relocateSimpleDesignerComponent,
	type DesignerComponentNode
} from "../designerModel";
import { containerStyle, designerLayoutClass } from "../designer/designerView";
import { createPropertyPanelModel } from "../propertyPanelModel";
import { parseSimplePropertyXml, resolvePropertyXmlElement, serializePropertyXml } from "../propertyXml";
import { loadSdk, type LibraryContainerProjection, type LibraryMember, type Sdk } from "../sdk";

/** 在真实 SDK 上添加不依赖内置中文类型名的容器，验证扩展清单消费路径。 */
function withContainer(
	sdk: Sdk,
	projection?: LibraryContainerProjection,
	properties?: readonly LibraryMember[]
): Sdk {
	const runtime = sdk.manifests.find((manifest) => manifest.kind === "runtime");
	assert.ok(runtime);
	return {
		...sdk,
		manifests: [...sdk.manifests, {
			...runtime,
			kind: "library",
			name: "容器投影验证库",
			categories: [{
				name: "扩展容器",
				definitions: [{
					name: "投影容器",
					kind: "component",
					type: "example.投影容器",
					inherits: ["simple.runtime.components.可视组件", "simple.runtime.components.组件容器"],
					projection,
					properties
				}]
			}]
		}]
	};
}

/** 包含非可视组件及外部可移动组件的 XML，覆盖数量上限和未设置尺寸。 */
function containerDocument(assignment?: string) {
	const document = parseSimplePropertyXml([
		"'用户代码区不参与投影修改",
		"$属性",
		"\t$资源 $窗口",
		"\t$定义 Main $为 窗口",
		"\t\t$定义 Box $为 投影容器",
		...(assignment === undefined ? [] : ["\t\t\t" + assignment]),
		"\t\t\t未知属性 = \"保持原值\"",
		"\t\t\t$定义 First $为 按钮",
		"\t\t\t$结束 $定义",
		"\t\t\t$定义 Second $为 按钮",
		"\t\t\t$结束 $定义",
		"\t\t\t$定义 Timer $为 计时器",
		"\t\t\t$结束 $定义",
		"\t\t$结束 $定义",
		"\t\t$定义 Outside $为 按钮",
		"\t\t$结束 $定义",
		"\t$结束 $定义",
		"$结束 $属性"
	].join("\r\n"));
	assert.ok(document);
	return document;
}

/** 按模型名称查找组件，真实 XML 路径仍由设计器建立。 */
function find(node: DesignerComponentNode | undefined, name: string): DesignerComponentNode | undefined {
	return node?.name === name ? node : node?.children.map((child) => find(child, name)).find(Boolean);
}

test("无布局属性的扩展容器缺省单帧且不把投影配置写入 XML", async () => {
	const sdk = withContainer(await loadSdk(path.resolve("..", "sdk", "sdk.json")));
	const document = containerDocument();
	const before = serializePropertyXml(document);
	const model = createSimpleDesignerModel(document, sdk);
	const box = find(model.root, "Box");
	assert.ok(box);
	assert.equal(box.layout, "frame");
	assert.equal(box.limit, undefined);
	assert.equal(box.scroll, undefined);
	assert.equal(box.acceptsVisualChild, true);
	assert.deepEqual(find(box, "First")?.width, { kind: "parent" });
	assert.deepEqual(find(box, "First")?.height, { kind: "parent" });
	assert.equal(serializePropertyXml(document), before);
	const panel = createPropertyPanelModel(document, resolvePropertyXmlElement(document, box.path), sdk, "Main");
	assert.equal(panel.groups.flatMap((group) => group.rows).some((row) => row.name === "布局"), false);
	const first = find(box, "First");
	assert.ok(first);
	const childPanel = createPropertyPanelModel(document, resolvePropertyXmlElement(document, first.path), sdk, "Main");
	assert.equal(childPanel.groups.flatMap((group) => group.rows).some((row) => row.name === "对齐"), true);
});

test("固定布局复用现有投影且真实布局属性优先，包括自定义属性名", async () => {
	const base = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const document = containerDocument();
	for (const layout of ["absolute", "frame", "grid", "linear-horizontal", "linear-vertical", "relative"] as const) {
		const model = createSimpleDesignerModel(document, withContainer(base, { layout }));
		assert.equal(find(model.root, "Box")?.layout, layout);
	}
	const sdk = withContainer(base, { layout: "frame" }, [{
		name: "排列",
		type: "整数型",
		projection: "layout",
		initializer: { label: "线性", value: "布局_线性" }
	}]);
	assert.equal(find(createSimpleDesignerModel(document, sdk).root, "Box")?.layout, "linear-vertical");
	const explicit = containerDocument("排列 = 布局_相对");
	const model = createSimpleDesignerModel(explicit, sdk);
	assert.equal(find(model.root, "Box")?.layout, "relative");
	const first = find(model.root, "First");
	assert.ok(first);
	const panel = createPropertyPanelModel(explicit, resolvePropertyXmlElement(explicit, first.path), sdk, "Main");
	assert.equal(panel.groups.flatMap((group) => group.rows).some((row) => row.name === "位于左边"), true);
	const unknown = containerDocument("排列 = 未知布局()");
	assert.equal(find(createSimpleDesignerModel(unknown, sdk).root, "Box")?.childrenLayoutReadOnly, true);
	const withoutDefault = withContainer(base, { layout: "frame" }, [{
		name: "排列", type: "整数型", projection: "layout"
	}]);
	const fallback = createSimpleDesignerModel(document, withoutDefault);
	assert.equal(find(fallback.root, "Box")?.layout, "frame");
	const fallbackChild = find(fallback.root, "First");
	assert.ok(fallbackChild);
	const fallbackPanel = createPropertyPanelModel(
		document, resolvePropertyXmlElement(document, fallbackChild.path), withoutDefault, "Main"
	);
	assert.equal(fallbackPanel.groups.flatMap((group) => group.rows).some((row) => row.name === "对齐"), true);
});

test("滚动方向独立于布局，启用滚动条属性及滚动开关仍控制显示", async () => {
	const base = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const properties: readonly LibraryMember[] = [{
		name: "显示滚动条", type: "逻辑型", projection: "scrollbarEnabled"
	}, {
		name: "允许滚动", type: "逻辑型", projection: "scrollable"
	}];
	for (const scroll of ["horizontal", "vertical"] as const) {
		const sdk = withContainer(base, { layout: "frame", scroll }, properties);
		const document = containerDocument("显示滚动条 = 假");
		const box = find(createSimpleDesignerModel(document, sdk).root, "Box");
		assert.ok(box);
		assert.equal(box.layout, "frame");
		assert.equal(box.scroll, scroll);
		assert.equal(designerLayoutClass(box), "layout-frame container-scroll-" + scroll + " container-scrollbar-hidden");
		assert.deepEqual(containerStyle(box), {
			gridTemplateColumns: "minmax(0, 1fr)", gridTemplateRows: "minmax(0, 1fr)"
		});
		const disabled = find(createSimpleDesignerModel(containerDocument("允许滚动 = 假"), sdk).root, "Box");
		assert.ok(disabled);
		assert.equal(disabled.scroll, undefined);
		assert.equal(designerLayoutClass(disabled), "layout-frame");
	}
	const none = withContainer(base, { scroll: "none" });
	assert.equal(find(createSimpleDesignerModel(containerDocument(), none).root, "Box")?.scroll, undefined);
});

test("通用 limit 对新增、粘贴、移动和剪贴板子树一致，非可视组件不计数", async () => {
	const sdk = withContainer(await loadSdk(path.resolve("..", "sdk", "sdk.json")), { limit: 2 });
	const document = containerDocument();
	const before = serializePropertyXml(document);
	const model = createSimpleDesignerModel(document, sdk);
	const box = find(model.root, "Box");
	const first = find(model.root, "First");
	const outside = find(model.root, "Outside");
	assert.ok(box && first && outside && model.root);
	assert.equal(box.children.length, 3);
	assert.equal(box.acceptsVisualChild, false);
	assert.equal(canDesignerContainerAcceptVisualChild(box, first.path), true);
	assert.throws(() => addSimpleDesignerComponent(document, sdk, "按钮", box.path, "canvas"), /最多只能直接包含 2/u);
	const clipboard = copySimpleDesignerComponent(document, sdk, outside.path).text;
	assert.throws(() => pasteSimpleDesignerComponent(document, sdk, box.path, clipboard), /最多只能直接包含 2/u);
	assert.throws(() => relocateSimpleDesignerComponent(document, sdk, outside.path, box.path), /最多只能直接包含 2/u);
	assert.equal(relocateSimpleDesignerComponent(document, sdk, first.path, box.path).selectedPath, first.path);
	const copiedBox = copySimpleDesignerComponent(document, sdk, box.path).text;
	const rootPath = model.root.path;
	const narrowerSdk = withContainer(sdk, { limit: 1 });
	/* 移除旧的验证定义，让收紧后的清单成为唯一有效定义。 */
	const narrowed = { ...narrowerSdk, manifests: narrowerSdk.manifests.filter((manifest) => manifest !== sdk.manifests.at(-1)) };
	assert.throws(() => pasteSimpleDesignerComponent(document, narrowed, rootPath, copiedBox), /剪贴板中的容器最多只能直接包含 1/u);
	assert.equal(serializePropertyXml(document), before);
	const zero = withContainer(await loadSdk(path.resolve("..", "sdk", "sdk.json")), { limit: 0 });
	assert.equal(find(createSimpleDesignerModel(document, zero).root, "Box")?.acceptsVisualChild, false);
});

test("真实滑动页面框样例及滚动框清单加载为单帧容器投影", async () => {
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const file = path.resolve("..", "sdk", "libraries", "simple.library.wsd.viewpager",
		"sample", "src", "simple", "library", "wsd", "viewpager", "sample", "主窗口.simple");
	const source = await fs.readFile(file, "utf8");
	const document = parseSimplePropertyXml(source);
	assert.ok(document);
	const model = createSimpleDesignerModel(document, sdk);
	function flatten(node: DesignerComponentNode | undefined): readonly DesignerComponentNode[] {
		return node === undefined ? [] : [node, ...node.children.flatMap(flatten)];
	}
	const pager = flatten(model.root).find((node) => node.runtimeType === "simple.library.wsd.viewpager.滑动页面框");
	assert.ok(pager);
	assert.equal(pager.layout, "frame");
	assert.equal(pager.limit, undefined);
	assert.equal(pager.container, true);
	assert.equal(pager.scroll, undefined);
	assert.equal(await fs.readFile(file, "utf8"), source);
	for (const [name, scroll] of [["垂直滚动框", "vertical"], ["水平滚动框", "horizontal"]] as const) {
		const definition = sdk.manifests.flatMap((manifest) => manifest.categories.flatMap((category) => category.definitions)).find((candidate) => candidate.name === name);
		assert.deepEqual(definition?.projection, { layout: "frame", scroll, limit: 1 });
	}
});
