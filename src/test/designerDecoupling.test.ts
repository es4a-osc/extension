/*
验证布局关联、常量解析和文本外观只消费清单投影，并保持 XML 写回边界。
xhwsd@qq.com 2026-10-28
*/

import * as assert from "node:assert/strict";
import { test } from "node:test";
import { testSdkPath } from "./testFixtures";
import { PROJECTION_CONTRACT_SOURCE, withProjectionContract } from "./designerDecouplingFixture";
import { createSimpleDesignerModel, resizeSimpleDesignerComponent } from "../designerModel";
import { componentPresentation } from "../designer/designerView";
import { createPropertyPanelModel } from "../propertyPanelModel";
import { parseSimplePropertyXml, resolvePropertyXmlElement, serializePropertyXml } from "../propertyXml";
import { buildDefinitionIndex, loadSdk } from "../sdk";
import { resolveDesignerLayoutDefinition } from "../designerDefaults";

test("布局选择值与定义显式关联，不依赖布局名、数值约定和专用编辑器", async () => {
	const sdk = withProjectionContract(await loadSdk(testSdkPath()));
	const document = parseSimplePropertyXml(PROJECTION_CONTRACT_SOURCE);
	assert.ok(document);
	const baseline = serializePropertyXml(document);
	const root = createSimpleDesignerModel(document, sdk).root;
	const box = root?.children[0];
	assert.ok(box);
	assert.equal(box.layout, "linearHorizontal");
	assert.equal(box.layoutWeightSum, 10);
	assert.equal(box.childrenLayoutReadOnly, false);
	assert.deepEqual(box.children[0]?.width, { kind: "fixed", value: 104 });
	const panel = createPropertyPanelModel(document, resolvePropertyXmlElement(document, box.path), sdk, "Main");
	assert.ok(panel.groups.flatMap((group) => group.rows).some((row) => row.name === "LayoutMode.Axis"));

	const renamed = {
		...sdk,
		manifests: sdk.manifests.map((manifest) => ({
			...manifest,
			categories: manifest.categories.map((category) => ({
				...category,
				definitions: category.definitions.map((definition) => definition.kind === "layout"
					? { ...definition, name: "Renamed_" + definition.name } : definition)
			}))
		}))
	};
	assert.deepEqual(createSimpleDesignerModel(document, renamed).root, root);
	assert.equal(serializePropertyXml(document), baseline);
});

test("相同属性投影的外观不因组件是否继承文本基类而变化", async () => {
	const sdk = withProjectionContract(await loadSdk(testSdkPath()));
	const document = parseSimplePropertyXml(PROJECTION_CONTRACT_SOURCE);
	const children = createSimpleDesignerModel(document, sdk).root?.children[0]?.children;
	assert.ok(children?.[0] && children[1]);
	assert.ok(children.every((child) => child.visual));
	assert.notEqual(children[0].type, children[1].type);
	assert.equal(children[0].displayText, "字段投影");
	assert.deepEqual(componentPresentation(children[0], undefined, "control"), componentPresentation(children[1], undefined, "control"));
});

test("长度常量读取与改名属性写回共用投影角色，并保留未知 XML", async () => {
	const sdk = withProjectionContract(await loadSdk(testSdkPath()));
	const document = parseSimplePropertyXml(PROJECTION_CONTRACT_SOURCE.replace("Span = SizeToken", "Span = ParentSpan"));
	assert.ok(document);
	const before = serializePropertyXml(document);
	const first = createSimpleDesignerModel(document, sdk).root?.children[0]?.children[0];
	assert.ok(first);
	assert.deepEqual(first.width, { kind: "parent" });
	const resized = resizeSimpleDesignerComponent(document, sdk, first.path, { width: 128 });
	const after = serializePropertyXml(resized.document);
	assert.equal(after, before.replace('属性="Span" 值="ParentSpan"', '属性="Span" 值="&quot;128dp&quot;"'));
	assert.deepEqual(createSimpleDesignerModel(resized.document, sdk).root?.children[0]?.children[0]?.width, { kind: "fixed", value: 128 });
});

test("未知及重复的布局值不回退猜测，已知名称缺少关联同样保持只读", async () => {
	const sdk = withProjectionContract(await loadSdk(testSdkPath()));
	for (const value of ["UnknownMode()", "999"]) {
		const source = PROJECTION_CONTRACT_SOURCE.replace("LayoutMode.Axis = AxisToken", "LayoutMode = " + value);
		const box = createSimpleDesignerModel(parseSimplePropertyXml(source), sdk).root?.children[0];
		assert.equal(box?.layout, "unsupported");
		assert.equal(box?.childrenLayoutReadOnly, true);
	}
	const repeated = { ...sdk, manifests: [...sdk.manifests, {
		...sdk.manifests.at(-1)!,
		categories: [{ name: "重复投影", definitions: [{
			name: "DuplicateLayout", kind: "layout", projection: { layout: "grid" as const, value: "42" }
		}] }]
	}] };
	assert.equal(resolveDesignerLayoutDefinition("ModeAlias", buildDefinitionIndex(repeated.manifests)), undefined);
	const absent = { ...sdk, manifests: sdk.manifests.map((manifest) => ({
		...manifest,
		categories: manifest.categories.map((category) => ({ ...category, definitions: category.definitions.map((definition) => (
			definition.kind === "layout" ? { ...definition, projection: undefined } : definition
		)) }))
	})) };
	assert.equal(resolveDesignerLayoutDefinition("布局_线性", buildDefinitionIndex(absent.manifests)), undefined);
});
