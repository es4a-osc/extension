/*
验证真实 Simple 属性代码与通用 XML 文档模型之间的双向转换和路径读写。
xhwsd@qq.com 2026-8-28
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, test } from "node:test";
import {
	appendPropertyXmlElement,
	collectPropertyXmlElements,
	createPropertyXmlElement,
	createPropertyXmlText,
	createPropertyXmlAttributePath,
	detectSimpleUnitType,
	findPropertyXmlElementPath,
	getPropertyXmlAttribute,
	getPropertyXmlChildren,
	getSimplePropertyResourceUnit,
	getSimplePropertyUnitType,
	inspectSimplePropertyXml,
	movePropertyXmlElement,
	parsePropertyXmlElement,
	parseSimplePropertyXml,
	readPropertyXmlValue,
	relocatePropertyXmlElement,
	removePropertyXmlElement,
	resolvePropertyXmlElement,
	serializePropertyXml,
	serializePropertyXmlElement,
	serializeSimplePropertySource,
	writePropertyXmlValue
} from "../propertyXml";
import { splitSimpleUnitSource } from "../simpleUnitSource";
import { simpleTestProjectPath, type SimpleTestProjectName } from "./testProjects";

/** 以 UTF-8 读取真实 Simple 测试样例。 */
function readFixture(project: SimpleTestProjectName, ...segments: string[]): string {
	return fs.readFileSync(simpleTestProjectPath(project, ...segments), "utf8");
}

describe("Simple 通用属性 XML", () => {
	test("项目树临时解析属性 XML 取得单元类型且不保留模型", () => {
		const source = [
			"过程 Test()",
			"  文本 = \"$资源 $服务\"",
			"结束 过程",
			"$属性",
			"\t$资源 $窗口",
			"$结束 $属性",
			""
		].join("\r\n");
		assert.equal(detectSimpleUnitType(source), "窗口");
		assert.equal(detectSimpleUnitType(source.replace("$窗口", "$未知单元")), undefined);
		assert.equal(detectSimpleUnitType(source.replace("$窗口", "$线程")), undefined);
		assert.equal(detectSimpleUnitType("$资源 $对象\r\n"), undefined);
	});

	test("从 Tetris 真实窗口单元建立完整 XML 元素树", () => {
		const source = readFixture(
			"Tetris", "src", "simple", "samples", "tetris", "Tetris.simple"
		);
		const document = parseSimplePropertyXml(source);
		assert.ok(document);
		assert.equal(document.root.name, "属性");
		assert.equal(getSimplePropertyUnitType(document), "窗口");
		assert.equal(document.status, "valid");
		assert.deepEqual(document.issues, []);

		const resource = getPropertyXmlChildren(document.root, "资源")[0];
		assert.equal(getPropertyXmlAttribute(resource, "单元"), "窗口");
		const form = getPropertyXmlChildren(document.root, "定义")[0];
		assert.ok(form);
		assert.equal(getPropertyXmlAttribute(form, "名称"), "Tetris");
		assert.equal(getPropertyXmlAttribute(form, "组件"), "窗口");
		const formPath = findPropertyXmlElementPath(document, form);
		assert.equal(formPath, "/属性/定义[1]");
		assert.equal(
			readPropertyXmlValue(
				document,
				createPropertyXmlAttributePath(formPath, "赋值", "属性", "布局.方向", "值")
			),
			"布局_方向_垂直"
		);
		assert.ok(collectPropertyXmlElements(form, "定义").some(
			(element) => getPropertyXmlAttribute(element, "名称") === "ScoreLabel"
		));
		const xml = serializePropertyXml(document);
		assert.match(xml, /^<属性>/u);
		assert.match(xml, /<资源 单元="窗口" \/>/u);
		assert.match(xml, /<定义 名称="Tetris" 组件="窗口">/u);
		assert.match(xml, /<赋值 属性="标题" 值="&quot;Tetris&quot;" \/>/u);
		assert.doesNotMatch(xml, /sourceLine|temporary/u);
		assert.equal(
			xml.replace(/\r\n$|\n$|\r$/u, "").split(/\r\n|\n|\r/u).length,
			splitSimpleUnitSource(source).propertySource
				.replace(/\r\n$|\n$|\r$/u, "")
				.split(/\r\n|\n|\r/u).length
		);
	});

	test("对象和接口的类型及限定表达式全部来自 XML 节点", () => {
		const derived = parseSimplePropertyXml(readFixture(
			"SmokeTest", "src", "simple", "smoketest", "utils", "DerivedObject.simple"
		));
		const interfaceUnit = parseSimplePropertyXml(readFixture(
			"SmokeTest", "src", "simple", "smoketest", "utils", "ObjectNameInterface.simple"
		));
		assert.ok(derived);
		assert.ok(interfaceUnit);
		assert.equal(getSimplePropertyUnitType(derived), "对象");
		assert.equal(
			readPropertyXmlValue(
				derived,
				createPropertyXmlAttributePath("/属性", "赋值", "属性", "基础对象", "值")
			),
			"simple.smoketest.utils.BaseObject"
		);
		assert.equal(getSimplePropertyUnitType(interfaceUnit), "接口");
		assert.equal(getPropertyXmlChildren(interfaceUnit.root, "赋值").length, 0);
	});

	test("路径置值统一处理读取、创建、修改和删除赋值节点", () => {
		const document = parseSimplePropertyXml([
			"$属性",
			"  $资源 $窗口",
			"  $定义 Form $为 窗口",
			"    标题 = \"旧标题\"",
			"  $结束 $定义",
			"$结束 $属性",
			""
		].join("\r\n"));
		assert.ok(document);
		const titlePath = createPropertyXmlAttributePath(
			"/属性/定义[1]", "赋值", "属性", "标题", "值"
		);
		const visiblePath = createPropertyXmlAttributePath(
			"/属性/定义[1]", "赋值", "属性", "可视", "值"
		);

		const changed = writePropertyXmlValue(document, titlePath, "\"新标题\"");
		const created = writePropertyXmlValue(changed, visiblePath, "真");
		assert.equal(readPropertyXmlValue(created, titlePath), "\"新标题\"");
		assert.equal(readPropertyXmlValue(created, visiblePath), "真");
		assert.equal(
			serializeSimplePropertySource(created, { indentation: "  ", lineEnding: "\n" }),
			[
				"$属性",
				"  $资源 $窗口",
				"  $定义 Form $为 窗口",
				"    标题 = \"新标题\"",
				"    可视 = 真",
				"  $结束 $定义",
				"$结束 $属性",
				""
			].join("\n")
		);

		const cleared = writePropertyXmlValue(
			created,
			visiblePath,
			"",
			{ removeElementWhenEmpty: true }
		);
		assert.equal(readPropertyXmlValue(cleared, visiblePath), undefined);
		assert.doesNotMatch(serializePropertyXml(cleared), /属性="可视"/u);
	});

	test("新增赋值写在同级子定义之前且已有节点保持源码顺序", () => {
		const document = parseSimplePropertyXml([
			"$属性",
			"  $资源 $窗口",
			"  $定义 Form $为 窗口",
			"    $定义 Button1 $为 按钮",
			"    $结束 $定义",
			"    标题 = \"旧标题\"",
			"  $结束 $定义",
			"$结束 $属性",
			""
		].join("\r\n"));
		assert.ok(document);
		const titlePath = createPropertyXmlAttributePath(
			"/属性/定义[1]", "赋值", "属性", "标题", "值"
		);
		const visiblePath = createPropertyXmlAttributePath(
			"/属性/定义[1]", "赋值", "属性", "可视", "值"
		);
		const originalXml = serializePropertyXml(document);
		assert.ok(originalXml.indexOf('名称="Button1"') < originalXml.indexOf('属性="标题"'));
		const updated = writePropertyXmlValue(
			writePropertyXmlValue(document, titlePath, "\"新标题\""),
			visiblePath,
			"真"
		);
		const source = serializeSimplePropertySource(updated, { indentation: "  ", lineEnding: "\r\n" });
		assert.ok(source.indexOf("    可视 = 真") < source.indexOf("    $定义 Button1 $为 按钮"));
		assert.ok(source.indexOf("    $定义 Button1 $为 按钮") < source.indexOf("    标题 = \"新标题\""));
	});

	test("任何 XML 节点都能携带不参与预览和写出的临时数据", () => {
		const document = parseSimplePropertyXml([
			"$属性",
			"\t$资源 $对象",
			"\t基础对象 = simple.Base",
			"$结束 $属性",
			""
		].join("\r\n"));
		assert.ok(document);
		const assignment = getPropertyXmlChildren(document.root, "赋值")[0];
		assert.ok(assignment);
		assignment.temporary.set("selected", true);
		assignment.temporary.set(Symbol.for("designer"), { x: 10, y: 20 });
		assert.equal(assignment.temporary.get("selected"), true);
		assert.doesNotMatch(serializePropertyXml(document), /selected|designer|x="10"/u);
		assert.doesNotMatch(serializeSimplePropertySource(document), /selected|designer/u);
	});

	test("组件、赋值、注释、未知内容和空行都由通用 XML 节点表达", () => {
		const source = [
			"$属性",
			"  $资源 $窗口",
			"  $定义 Form $为 窗口",
			"",
			"    标题 = \"测试\"",
			"    'android:showDividers = \"beginning\"",
			"    未知未来语法",
			"  $结束 $定义",
			"$结束 $属性",
			""
		].join("\r\n");
		const document = parseSimplePropertyXml(source);
		assert.ok(document);
		assert.equal(document.root.children[0]?.nodeType, "element");
		const form = getPropertyXmlChildren(document.root, "定义")[0];
		assert.ok(form);
		assert.equal(form.children[0]?.nodeType, "text");
		assert.equal(form.children[1]?.nodeType, "element");
		assert.equal(form.children[2]?.nodeType, "element");
		assert.equal(
			getPropertyXmlAttribute(getPropertyXmlChildren(form, "注释")[0], "内容"),
			"android:showDividers = \"beginning\""
		);
		assert.equal(form.children[3]?.nodeType, "element");
		assert.equal(getPropertyXmlChildren(form, "赋值").length, 1);
		assert.match(
			serializePropertyXml(document),
			/<注释 内容="android:showDividers = &quot;beginning&quot;" \/>/u
		);
		assert.equal(
			getPropertyXmlAttribute(
				getPropertyXmlChildren(form, "未知")[0],
				"原文"
			),
			"未知未来语法"
		);
		assert.equal(serializeSimplePropertySource(
			document,
			{ indentation: "  ", lineEnding: "\r\n" }
		), source);

		const titlePath = createPropertyXmlAttributePath(
			"/属性/定义[1]", "赋值", "属性", "标题", "值"
		);
		const changedSource = serializeSimplePropertySource(
			writePropertyXmlValue(document, titlePath, "\"更新\""),
			{ indentation: "  ", lineEnding: "\r\n" }
		);
		assert.match(changedSource, /    'android:showDividers = "beginning"/u);
		assert.equal(readPropertyXmlValue(parseSimplePropertyXml(changedSource)!, titlePath), "\"更新\"");
	});

	test("属性代码行尾注释映射到同一 XML 节点并能写回", () => {
		const source = [
			"$属性 ' 属性区",
			"\t$资源 $窗口 ' 窗口资源",
			"\t$定义 主窗口 $为 窗口 ' 窗口定义",
			"\t\t标题 = \"含有'单引号\" ' 标题属性",
			"\t\t'独立注释",
			"\t\t未来语法 ' 未知内容",
			"\t$结束 $定义",
			"$结束 $属性",
			""
		].join("\r\n");
		const document = parseSimplePropertyXml(source);
		assert.ok(document);
		assert.equal(getPropertyXmlAttribute(document.root, "注释"), "属性区");
		const resource = getPropertyXmlChildren(document.root, "资源")[0];
		assert.ok(resource);
		assert.equal(getPropertyXmlAttribute(resource, "单元"), "窗口");
		assert.equal(getPropertyXmlAttribute(resource, "注释"), "窗口资源");
		const form = getPropertyXmlChildren(document.root, "定义")[0];
		assert.ok(form);
		assert.equal(getPropertyXmlAttribute(form, "组件"), "窗口");
		assert.equal(getPropertyXmlAttribute(form, "注释"), "窗口定义");
		const title = getPropertyXmlChildren(form, "赋值")[0];
		assert.ok(title);
		assert.equal(getPropertyXmlAttribute(title, "值"), "\"含有'单引号\"");
		assert.equal(getPropertyXmlAttribute(title, "注释"), "标题属性");
		const comment = getPropertyXmlChildren(form, "注释")[0];
		assert.ok(comment);
		assert.equal(getPropertyXmlAttribute(comment, "内容"), "独立注释");
		const unknown = getPropertyXmlChildren(form, "未知")[0];
		assert.ok(unknown);
		assert.equal(getPropertyXmlAttribute(unknown, "原文"), "未来语法");
		assert.equal(getPropertyXmlAttribute(unknown, "注释"), "未知内容");
		const xml = serializePropertyXml(document);
		assert.match(xml, /^<属性 注释="属性区">/u);
		assert.match(xml, /<资源 单元="窗口" 注释="窗口资源" \/>/u);
		assert.match(xml, /<定义 名称="主窗口" 组件="窗口" 注释="窗口定义">/u);
		assert.match(xml, /<赋值 属性="标题" 值="&quot;含有'单引号&quot;" 注释="标题属性" \/>/u);
		assert.equal(serializeSimplePropertySource(document), source);
		const titlePath = createPropertyXmlAttributePath(
			"/属性/定义[1]", "赋值", "属性", "标题", "值"
		);
		assert.match(
			serializeSimplePropertySource(writePropertyXmlValue(document, titlePath, "\"更新\"")),
			/标题 = "更新" ' 标题属性/u
		);
	});

	test("XML 元素路径按同名兄弟序号定位嵌套定义", () => {
		const document = parseSimplePropertyXml([
			"$属性",
			"\t$资源 $窗口",
			"\t$定义 Form $为 窗口",
			"\t\t$定义 First $为 按钮",
			"\t\t$结束 $定义",
			"\t\t$定义 Second $为 按钮",
			"\t\t$结束 $定义",
			"\t$结束 $定义",
			"$结束 $属性",
			""
		].join("\r\n"));
		assert.ok(document);
		const second = resolvePropertyXmlElement(document, "/属性/定义[1]/定义[2]");
		assert.equal(getPropertyXmlAttribute(second, "名称"), "Second");
		assert.equal(findPropertyXmlElementPath(document, second!), "/属性/定义[1]/定义[2]");
	});

	test("设计器追加组件时不可变更新父定义并保留原有尾部空行", () => {
		const source = [
			"$属性",
			"  $资源 $窗口",
			"  $定义 Form $为 窗口",
			"",
			"  $结束 $定义",
			"$结束 $属性",
			""
		].join("\r\n");
		const document = parseSimplePropertyXml(source);
		assert.ok(document);
		const button = createPropertyXmlElement("定义", {
			"名称": "按钮1",
			"组件": "按钮"
		});
		const updated = appendPropertyXmlElement(document, "/属性/定义[1]", button);
		assert.equal(getPropertyXmlChildren(
			resolvePropertyXmlElement(document, "/属性/定义[1]")!,
			"定义"
		).length, 0);
		assert.equal(findPropertyXmlElementPath(updated, button), "/属性/定义[1]/定义[1]");
		assert.match(
			serializeSimplePropertySource(updated, { indentation: "  ", lineEnding: "\r\n" }),
			/\$定义 按钮1 \$为 按钮\r\n\s*\$结束 \$定义\r\n\r\n  \$结束 \$定义/u
		);
	});

	test("按路径删除组件定义完整子树并保持原文档和兄弟节点", () => {
		const source = [
			"$属性",
			"  $资源 $窗口",
			"  $定义 Form $为 窗口",
			"    $定义 Panel1 $为 面板",
			"      $定义 Button1 $为 按钮",
			"        文本 = \"删除我\"",
			"      $结束 $定义",
			"    $结束 $定义",
			"    $定义 Label1 $为 标签",
			"    $结束 $定义",
			"  $结束 $定义",
			"$结束 $属性",
			""
		].join("\r\n");
		const document = parseSimplePropertyXml(source);
		assert.ok(document);
		const updated = removePropertyXmlElement(document, "/属性/定义[1]/定义[1]");
		assert.ok(resolvePropertyXmlElement(document, "/属性/定义[1]/定义[1]/定义[1]"));
		assert.equal(resolvePropertyXmlElement(updated, "/属性/定义[1]/定义[2]"), undefined);
		assert.doesNotMatch(serializeSimplePropertySource(updated), /Panel1|Button1|删除我/u);
		assert.match(serializeSimplePropertySource(updated), /\$定义 Label1 \$为 标签/u);
		assert.throws(() => removePropertyXmlElement(document, "/属性"), /根节点不能删除/u);
		assert.throws(() => removePropertyXmlElement(document, "/属性/定义[9]"), /目标不存在/u);
	});

	test("按路径前移或后移同级 XML 定义并保持其它节点位置", () => {
		const document = parseSimplePropertyXml([
			"$属性",
			"  $资源 $窗口",
			"  $定义 Form $为 窗口",
			"    $定义 First $为 按钮",
			"    $结束 $定义",
			"    标题 = \"保持位置\"",
			"    $定义 Second $为 标签",
			"    $结束 $定义",
			"  $结束 $定义",
			"$结束 $属性",
			""
		].join("\r\n"));
		assert.ok(document);
		const moved = movePropertyXmlElement(document, "/属性/定义[1]/定义[2]", "previous");
		const originalForm = resolvePropertyXmlElement(document, "/属性/定义[1]");
		const movedForm = resolvePropertyXmlElement(moved, "/属性/定义[1]");
		assert.deepEqual(
			getPropertyXmlChildren(originalForm!, "定义").map((node) => node.attributes["名称"]),
			["First", "Second"]
		);
		assert.deepEqual(
			getPropertyXmlChildren(movedForm!, "定义").map((node) => node.attributes["名称"]),
			["Second", "First"]
		);
		assert.equal(movedForm?.children[1]?.nodeType, "element");
		assert.equal(
			movedForm?.children[1]?.nodeType === "element" ? movedForm.children[1].attributes["属性"] : undefined,
			"标题"
		);
		const restored = movePropertyXmlElement(moved, "/属性/定义[1]/定义[1]", "next");
		assert.deepEqual(
			getPropertyXmlChildren(resolvePropertyXmlElement(restored, "/属性/定义[1]")!, "定义")
				.map((node) => node.attributes["名称"]),
			["First", "Second"]
		);
		assert.throws(
			() => movePropertyXmlElement(document, "/属性/定义[1]/定义[1]", "previous"),
			/已经在最前面/u
		);
		assert.throws(
			() => movePropertyXmlElement(document, "/属性/定义[1]/定义[2]", "next"),
			/已经在最后面/u
		);
	});

	test("把组件定义完整子树序列化为剪贴板 XML", () => {
		const document = parseSimplePropertyXml([
			"$属性",
			"  $资源 $窗口",
			"  $定义 Form $为 窗口",
			"    $定义 Panel1 $为 面板",
			"      文本 = \"面板\"",
			"      $定义 Button1 $为 按钮",
			"      $结束 $定义",
			"    $结束 $定义",
			"  $结束 $定义",
			"$结束 $属性",
			""
		].join("\r\n"));
		assert.ok(document);
		const panel = resolvePropertyXmlElement(document, "/属性/定义[1]/定义[1]");
		assert.ok(panel);
		const serialized = [
				'<定义 名称="Panel1" 组件="面板">',
				'\t<赋值 属性="文本" 值="&quot;面板&quot;" />',
				'\t<定义 名称="Button1" 组件="按钮">',
				'\t</定义>',
				"</定义>",
				""
			].join("\r\n");
		assert.equal(serializePropertyXmlElement(panel), serialized);
		assert.equal(serializePropertyXmlElement(parsePropertyXmlElement(serialized)), serialized);
		assert.equal(
			serializePropertyXmlElement(createPropertyXmlElement("定义", { 名称: "Empty", 组件: "按钮" })),
			['<定义 名称="Empty" 组件="按钮">', "</定义>", ""].join("\r\n")
		);
		const unknownText = serializePropertyXmlElement(createPropertyXmlElement(
			"定义",
			{ "名称": "Unknown", "组件": "按钮" },
			[createPropertyXmlText("  未知 & 文本  ")]
		));
		assert.equal(serializePropertyXmlElement(parsePropertyXmlElement(unknownText)), unknownText);
		assert.throws(
			() => parsePropertyXmlElement('<定义 名称="A" 组件="按钮" />\r\n<定义 名称="B" 组件="按钮" />'),
			/只包含一个 XML 元素/u
		);
	});

	test("按 XML 路径把完整定义子树移动到其它父节点并保持原文档不变", () => {
		const document = parseSimplePropertyXml([
			"$属性",
			"  $资源 $窗口",
			"  $定义 Form $为 窗口",
			"    $定义 Panel1 $为 面板",
			"      $定义 Button1 $为 按钮",
			"      $结束 $定义",
			"    $结束 $定义",
			"    $定义 Panel2 $为 面板",
			"      $定义 Button2 $为 按钮",
			"      $结束 $定义",
			"    $结束 $定义",
			"  $结束 $定义",
			"$结束 $属性",
			""
		].join("\r\n"));
		assert.ok(document);
		const moved = relocatePropertyXmlElement(
			document,
			"/属性/定义[1]/定义[1]/定义[1]",
			"/属性/定义[1]/定义[2]",
			"/属性/定义[1]/定义[2]/定义[1]",
			"before"
		);
		assert.deepEqual(
			getPropertyXmlChildren(resolvePropertyXmlElement(moved, "/属性/定义[1]/定义[1]")!, "定义")
				.map((node) => node.attributes["名称"]),
			[]
		);
		assert.deepEqual(
			getPropertyXmlChildren(resolvePropertyXmlElement(moved, "/属性/定义[1]/定义[2]")!, "定义")
				.map((node) => node.attributes["名称"]),
			["Button1", "Button2"]
		);
		assert.deepEqual(
			getPropertyXmlChildren(resolvePropertyXmlElement(document, "/属性/定义[1]/定义[1]")!, "定义")
				.map((node) => node.attributes["名称"]),
			["Button1"]
		);
		assert.throws(
			() => relocatePropertyXmlElement(
				document,
				"/属性/定义[1]/定义[1]",
				"/属性/定义[1]/定义[1]/定义[1]"
			),
			/自身或自己的子节点/u
		);
	});

	test("未知资源名称仍是资源 XML 节点并保持损坏诊断", () => {
		const result = inspectSimplePropertyXml([
			"$属性",
			"  $资源 $未知单元",
			"$结束 $属性",
			""
		].join("\r\n"));
		assert.equal(result.status, "damaged");
		assert.ok(result.document);
		assert.equal(getSimplePropertyResourceUnit(result.document), "未知单元");
		assert.equal(getSimplePropertyUnitType(result.document), undefined);
		assert.match(serializePropertyXml(result.document), /<资源 单元="未知单元" \/>/u);
	});

	test("没有完整属性区时不伪造 XML 文档", () => {
		const source = "过程 Test()\r\n结束 过程\r\n";
		assert.equal(parseSimplePropertyXml(source), undefined);
		const result = inspectSimplePropertyXml(source);
		assert.equal(result.status, "damaged");
		assert.equal(result.document, undefined);
	});

	test("组件定义不配对时保留可检查 XML 并禁止路径置值", () => {
		const result = inspectSimplePropertyXml([
			"$属性",
			"  $资源 $窗口",
			"  $定义 Form $为 窗口",
			"$结束 $属性"
		].join("\r\n"));
		assert.equal(result.status, "damaged");
		assert.ok(result.document);
		assert.match(result.issues[0] ?? "", /没有结束标记/u);
		assert.throws(
			() => writePropertyXmlValue(result.document!, "/属性/定义[1]/@名称", "Main"),
			/损坏/u
		);
	});
});
