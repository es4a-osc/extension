/*
验证连续审查确认的复制身份、共享声明、配置编码和诊断投影边界。
xhwsd@qq.com 2026-10-31
*/

import * as assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { readWorkspaceConfigurationJsonc, updateWorkspaceConfigurationJsonc } from "../workspaceConfigurationFile";
import { createCopiedSimpleUnitSource, resolveSimpleUnitLifecycleEventAction, renameSimpleUnitLifecycleEventOwners } from "../unitFiles";
import { buildDocumentSignatures } from "../signatures";
import { createSimplePropertyXmlDocument, createPropertyXmlAttributePath, writePropertyXmlValue, collectPropertyXmlElements, serializePropertyXml, serializePropertyXmlWithLocations, appendPropertyXmlElement, createPropertyXmlElement } from "../propertyXml";
import { resolveDesignerComponentEventAction } from "../designerComponentEvents";
import { analyzeSimpleReferences } from "../referenceDiagnostics";
import { refactoringContext, type RefactoringUnit } from "../refactoringModel";
import { createSimpleSourcePositionIndex } from "../simpleSourcePositions";
import type { Sdk } from "../sdk";

const property = "$属性\n$资源 $对象\n$结束 $属性\n";
const sdk: Sdk = { directory: "C:/sdk", capabilities: { projects: [], tools: [] }, templates: {}, issues: [], manifests: [{
	kind: "runtime", name: "测试", directory: "C:/sdk", filePath: "C:/sdk/runtime.json", categories: [{ name: "组件", definitions: [
		{ name: "工厂", kind: "object", functions: [{ name: "获取", static: true, return: "工厂", params: [] }] },
		{ name: "窗口", kind: "component.window", events: [{ name: "初始化", params: [] }] }
	] }]
}] };

test("工程 BOM 和仅有注释的配置可读取、更新且保留原标记及注释", () => {
	for (const source of ['\uFEFF{"es4a.projects":[]}', "\uFEFF// 项目设置\r\n", "// 项目设置\n"]) {
		assert.doesNotThrow(() => readWorkspaceConfigurationJsonc(source, ["es4a.projects"]));
		const updated = updateWorkspaceConfigurationJsonc(source, ["es4a.projects"], [{ path: "demo" }]);
		assert.equal(updated.startsWith("\uFEFF"), source.startsWith("\uFEFF"));
		if (source.includes("//")) assert.ok(updated.includes("// 项目设置"));
		assert.deepEqual(readWorkspaceConfigurationJsonc(updated, ["es4a.projects"]), [{ path: "demo" }]);
	}
});

test("复制单元仅更新实际自引用，保留同名参数、局部变量和字符串", () => {
	const source = '过程 测试(对象1 为 对象1)\n变量 对象2 为 整数型\n对象1 = 对象1\n结束 过程\n变量 自己 为 对象1\n' + property;
	const copied = createCopiedSimpleUnitSource(source, "对象1", "对象2");
	assert.ok(copied.startsWith('过程 测试(对象1 为 对象2)\n变量 对象2 为 整数型\n对象1 = 对象1\n结束 过程\n变量 自己 为 对象2\n'));
});

test("复制到新命名空间时保持依赖引用，新短名被遮蔽时使用完整名称", () => {
	const source = "过程 测试()\n变量 对象2 为 整数型\n对象1.共享()\n结束 过程\n" + property;
	const root = path.resolve("copy/src");
	const file = path.join(root, "pkg/对象1.simple");
	const copied = createCopiedSimpleUnitSource(source, "对象1", "对象2", { sourceFile: file, sourceRoot: root,
		destinationFile: path.join(root, "next/对象2.simple"), destinationRoot: root, units: [] });
	assert.ok(copied.includes("变量 对象2 为 整数型\nnext.对象2.共享()"));
	assert.throws(() => createCopiedSimpleUnitSource(source, "对象1", "对象2"), /没有可用于区分的限定名/u);
});

test("续行和冒号声明的签名只包含真实参数与返回类型", () => {
	const source = "函数 计算(甲 为 整数型, _\n传址 乙 为 文本型) 为 文本型 : 计算(甲, 乙) : 结束 函数";
	const signatures = buildDocumentSignatures(source);
	assert.equal(signatures.length, 1);
	assert.equal(signatures[0]?.return, "文本型");
	assert.deepEqual(signatures[0]?.parameters, [{ name: "甲", byRef: false, type: "整数型" }, { name: "乙", byRef: true, type: "文本型" }]);
});

test("事件入口识别续行及冒号处理器，已有声明不再生成第二份", () => {
	const document = createSimplePropertyXmlDocument("窗口", "主窗口");
	for (const source of ["事件 _\n主窗口.初始化()\n\t结束 事件", "事件 主窗口.初始化() : 结束 事件"]) {
		assert.equal(resolveSimpleUnitLifecycleEventAction(source, "主窗口", "初始化").existing, true);
		assert.equal(resolveDesignerComponentEventAction(document, sdk, source, "/属性/定义[1]", "初始化").existing, true);
		assert.ok(renameSimpleUnitLifecycleEventOwners(source, "主窗口", "副窗口").includes("副窗口.初始化"));
	}
});

test("资源诊断遵循别名 R 的绑定，不把有效静态成员当作资源", () => {
	const unit: RefactoringUnit = { filePath: path.resolve("audit/调用.simple"), sourceRoot: path.resolve("audit"),
		userCode: "别名 R = 工厂\n过程 测试()\nR.获取()\n结束 过程", property: { document: createSimplePropertyXmlDocument("对象", "调用"), status: "valid", issues: [] } };
	assert.deepEqual(analyzeSimpleReferences(unit.userCode, sdk, refactoringContext(unit, [unit]), unit.property.document), []);
});

test("XML 诊断行号取自当前投影，新节点和顺序变化均可定位且不改模型", () => {
	const original = createSimplePropertyXmlDocument("对象", "调用");
	const document = writePropertyXmlValue(original, createPropertyXmlAttributePath("/属性", "赋值", "属性", "基础对象", "值"), "不存在");
	const withExtra = appendPropertyXmlElement(document, "/属性", createPropertyXmlElement("未知", { 内容: "保留" }));
	const projection = serializePropertyXmlWithLocations(withExtra);
	assert.equal(projection.text, serializePropertyXml(withExtra));
	const assignment = collectPropertyXmlElements(withExtra.root, "赋值")[0]!;
	assert.equal(assignment.temporary.get("sourceLine"), undefined);
	const line = projection.text.split("\r\n")[projection.elementLines.get(assignment)!];
	assert.ok(line?.includes('值="不存在"'));
	assert.equal(collectPropertyXmlElements(original.root, "赋值").length, 0);
});

test("诊断位置索引兼容 UTF-16、CRLF、LF、CR 和末尾行", () => {
	const positionAt = createSimpleSourcePositionIndex("甲😀\r\n乙\n丙\r");
	assert.deepEqual([0, 3, 4, 5, 6, 7, 8, 9].map(positionAt), [
		{ line: 0, character: 0 }, { line: 0, character: 3 }, { line: 0, character: 3 },
		{ line: 1, character: 0 }, { line: 1, character: 1 }, { line: 2, character: 0 }, { line: 2, character: 1 }, { line: 3, character: 0 }
	]);
});
