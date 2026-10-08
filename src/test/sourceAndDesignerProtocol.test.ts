/*
验证共享 Simple 词法扫描与设计器消息边界在精简后保持既有语义。
xhwsd@qq.com 2026-9-10
*/

import assert from "node:assert/strict";
import test from "node:test";
import { parseDesignerWebviewMessage } from "../designerProtocol";
import { isSimpleIgnoredOffset, stripSimpleLineComment } from "../simpleSourceLexical";

test("共享词法扫描区分代码、字符串和单行注释", () => {
	const source = "变量 文本 = \"a\\\"b\" ' 注释";
	assert.equal(isSimpleIgnoredOffset(source, source.indexOf("a"), true), true);
	assert.equal(isSimpleIgnoredOffset(source, source.indexOf("注"), true), true);
	assert.equal(isSimpleIgnoredOffset(source, source.indexOf("变量"), true), false);
	assert.equal(stripSimpleLineComment(source), "变量 文本 = \"a\\\"b\" ");
});

test("设计器协议统一校验上下文令牌、XML 路径和插入位置", () => {
	assert.deepEqual(parseDesignerWebviewMessage({ type: "ready" }), { type: "ready" });
	assert.deepEqual(parseDesignerWebviewMessage({
		contextToken: "designer",
		option: "designerDebug",
		type: "updateDisplayOption",
		value: true
	}), {
		contextToken: "designer",
		option: "designerDebug",
		type: "updateDisplayOption",
		value: true
	});
	assert.equal(parseDesignerWebviewMessage({
		contextToken: "designer",
		option: "unknown",
		type: "updateDisplayOption",
		value: true
	}), undefined);
	assert.equal(parseDesignerWebviewMessage({
		contextToken: "designer",
		option: "designerDebug",
		type: "updateDisplayOption",
		value: "true"
	}), undefined);
	assert.equal(parseDesignerWebviewMessage({ type: "selectNode", xmlPath: "/属性" }), undefined);
	assert.deepEqual(parseDesignerWebviewMessage({
		contextToken: "designer",
		type: "openCode"
	}), {
		contextToken: "designer",
		type: "openCode"
	});
	assert.deepEqual(parseDesignerWebviewMessage({
		componentName: "面板1",
		contextToken: "1",
		propertyEditor: "simple.pixel",
		propertyName: "行数",
		propertyType: "整数型",
		type: "showPropertyValidationWarning"
	}), {
		componentName: "面板1",
		contextToken: "1",
		propertyEditor: "simple.pixel",
		propertyName: "行数",
		propertyType: "整数型",
		type: "showPropertyValidationWarning"
	});
	assert.equal(parseDesignerWebviewMessage({
		componentName: "面板1",
		contextToken: "1",
		propertyName: "行数",
		type: "showPropertyValidationWarning"
	}), undefined);
	assert.equal(parseDesignerWebviewMessage({
		contextToken: "1",
		propertyName: "行数",
		propertyType: "整数型",
		type: "showPropertyValidationWarning"
	}), undefined);
	assert.equal(parseDesignerWebviewMessage({
		componentType: "按钮",
		contextToken: "1",
		parentComponentName: "窗口1",
		parentXmlPath: "/属性",
		position: "after",
		renderVersion: 3,
		target: "canvas",
		type: "addComponent"
	}), undefined);
	assert.deepEqual(parseDesignerWebviewMessage({
		contextToken: "1",
		effect: "editComponentComment",
		removeElementWhenEmpty: false,
		renderVersion: 3,
		selectedComponentName: "窗口1",
		selectedXmlPath: "/属性/定义[1]",
		type: "updateXmlValue",
		value: "主界面",
		xmlPath: "/属性/定义[1]/@注释"
	}), {
		contextToken: "1",
		effect: "editComponentComment",
		removeElementWhenEmpty: false,
		renderVersion: 3,
		selectedComponentName: "窗口1",
		selectedXmlPath: "/属性/定义[1]",
		type: "updateXmlValue",
		value: "主界面",
		xmlPath: "/属性/定义[1]/@注释"
	});
	assert.deepEqual(parseDesignerWebviewMessage({
		contextToken: "1",
		removeElementWhenEmpty: true,
		renderVersion: 3,
		selectedComponentName: "窗口1",
		selectedXmlPath: "/属性/定义[1]",
		type: "updateXmlValue",
		value: "长度_匹配父级",
		xmlPath: "/属性/定义[1]/赋值[@属性='宽度']/@值"
	}), {
		contextToken: "1",
		removeElementWhenEmpty: true,
		renderVersion: 3,
		selectedComponentName: "窗口1",
		selectedXmlPath: "/属性/定义[1]",
		type: "updateXmlValue",
		value: "长度_匹配父级",
		xmlPath: "/属性/定义[1]/赋值[@属性='宽度']/@值"
	});
	assert.deepEqual(parseDesignerWebviewMessage({
		componentName: "窗口1",
		contextToken: "designer",
		gridPosition: { column: 3, row: 1 },
		renderVersion: 3,
		type: "pasteComponent",
		xmlPath: "/属性/定义[1]"
	}), {
		componentName: "窗口1",
		contextToken: "designer",
		gridPosition: { column: 3, row: 1 },
		renderVersion: 3,
		type: "pasteComponent",
		xmlPath: "/属性/定义[1]"
	});
	assert.deepEqual(parseDesignerWebviewMessage({
		contextToken: "designer",
		requestId: 2,
		type: "checkComponentClipboard"
	}), {
		contextToken: "designer",
		requestId: 2,
		type: "checkComponentClipboard"
	});
	assert.equal(parseDesignerWebviewMessage({
		contextToken: "designer",
		requestId: -1,
		type: "checkComponentClipboard"
	}), undefined);
	assert.deepEqual(parseDesignerWebviewMessage({
		componentName: "按钮1",
		contextToken: "designer",
		renderVersion: 3,
		type: "cutComponent",
		xmlPath: "/属性/定义[1]/定义[1]"
	}), {
		componentName: "按钮1",
		contextToken: "designer",
		renderVersion: 3,
		type: "cutComponent",
		xmlPath: "/属性/定义[1]/定义[1]"
	});
	assert.equal(parseDesignerWebviewMessage({
		componentName: "按钮1",
		contextToken: "designer",
		renderVersion: 3,
		type: "cutComponent",
		xmlPath: "定义[1]"
	}), undefined);
	assert.equal(parseDesignerWebviewMessage({
		componentName: "窗口1",
		contextToken: "designer",
		gridPosition: { column: -1, row: 1 },
		renderVersion: 3,
		type: "pasteComponent",
		xmlPath: "/属性/定义[1]"
	}), undefined);
	assert.deepEqual(parseDesignerWebviewMessage({
		absolutePosition: { left: 24, top: 36 },
		componentType: "按钮",
		contextToken: "designer",
		parentComponentName: "窗口1",
		parentXmlPath: "/属性/定义[1]",
		renderVersion: 3,
		target: "canvas",
		type: "addComponent"
	}), {
		absolutePosition: { left: 24, top: 36 },
		componentType: "按钮",
		contextToken: "designer",
		parentComponentName: "窗口1",
		parentXmlPath: "/属性/定义[1]",
		renderVersion: 3,
		target: "canvas",
		type: "addComponent"
	});
	assert.equal(parseDesignerWebviewMessage({
		absolutePosition: { left: 24.5, top: 36 },
		componentType: "按钮",
		contextToken: "designer",
		parentComponentName: "窗口1",
		parentXmlPath: "/属性/定义[1]",
		renderVersion: 3,
		target: "canvas",
		type: "addComponent"
	}), undefined);
	assert.equal(parseDesignerWebviewMessage({
		absolutePosition: { left: 24, top: 36 },
		componentType: "按钮",
		contextToken: "designer",
		gridPosition: { column: 0, row: 0 },
		parentComponentName: "窗口1",
		parentXmlPath: "/属性/定义[1]",
		renderVersion: 3,
		target: "canvas",
		type: "addComponent"
	}), undefined);
	assert.deepEqual(parseDesignerWebviewMessage({
		componentName: "按钮1",
		contextToken: "designer",
		height: 48,
		left: 12,
		top: 18,
		type: "resizeComponent",
		renderVersion: 3,
		width: 96,
		xmlPath: "/属性/定义[1]/定义[1]"
	}), {
		componentName: "按钮1",
		contextToken: "designer",
		height: 48,
		left: 12,
		top: 18,
		type: "resizeComponent",
		renderVersion: 3,
		width: 96,
		xmlPath: "/属性/定义[1]/定义[1]"
	});
	assert.equal(parseDesignerWebviewMessage({
		componentName: "按钮1",
		contextToken: "designer",
		left: 12,
		renderVersion: 3,
		type: "resizeComponent",
		xmlPath: "/属性/定义[1]/定义[1]"
	}), undefined);
	assert.equal(parseDesignerWebviewMessage({
		componentName: "按钮1",
		contextToken: "designer",
		renderVersion: 3,
		type: "resizeComponent",
		width: -1,
		xmlPath: "/属性/定义[1]/定义[1]"
	}), undefined);
	assert.equal(parseDesignerWebviewMessage({
		contextToken: "1",
		removeElementWhenEmpty: true,
		type: "updateXmlValue",
		value: "长度_匹配父级",
		xmlPath: "/属性/定义[1]/赋值[@属性='宽度']/@值"
	}), undefined);
});

test("设计器协议只接受方向键产生的单一 1dip 相对移动", () => {
	assert.deepEqual(parseDesignerWebviewMessage({
		componentName: "按钮1",
		contextToken: "designer",
		deltaLeft: -1,
		deltaTop: 0,
		type: "nudgeComponent",
		renderVersion: 3,
		xmlPath: "/属性/定义[1]/定义[1]"
	}), {
		componentName: "按钮1",
		contextToken: "designer",
		deltaLeft: -1,
		deltaTop: 0,
		type: "nudgeComponent",
		renderVersion: 3,
		xmlPath: "/属性/定义[1]/定义[1]"
	});
	assert.equal(parseDesignerWebviewMessage({
		componentName: "按钮1",
		contextToken: "designer",
		deltaLeft: 1,
		deltaTop: 1,
		type: "nudgeComponent",
		renderVersion: 3,
		xmlPath: "/属性/定义[1]/定义[1]"
	}), undefined);
	assert.equal(parseDesignerWebviewMessage({
		componentName: "按钮1",
		contextToken: "designer",
		deltaLeft: 0,
		deltaTop: 0,
		type: "nudgeComponent",
		renderVersion: 3,
		xmlPath: "/属性/定义[1]/定义[1]"
	}), undefined);
});

test("设计器协议接受相对布局拖拽产生的位置和真实停靠关系", () => {
	const message = {
		componentName: "按钮1",
		contextToken: "designer",
		deltaLeft: 24,
		deltaTop: -13,
		horizontalDock: {
			axis: "horizontal",
			projection: "alignLeft",
			targetComponentName: "按钮2",
			targetXmlPath: "/属性/定义[1]/定义[2]"
		},
		left: 120,
		margin: { left: 12 },
		renderVersion: 3,
		top: 80,
		type: "moveRelativeComponent",
		xmlPath: "/属性/定义[1]/定义[1]"
	};
	assert.deepEqual(parseDesignerWebviewMessage(message), message);
	assert.deepEqual(parseDesignerWebviewMessage({
		...message,
		deltaLeft: 0,
		deltaTop: 0,
		horizontalDock: { axis: "horizontal", projection: "alignParentLeft" }
	}), {
		...message,
		deltaLeft: 0,
		deltaTop: 0,
		horizontalDock: { axis: "horizontal", projection: "alignParentLeft" }
	});
	assert.deepEqual(parseDesignerWebviewMessage({
		...message,
		deltaLeft: 0,
		deltaTop: 0,
		horizontalDock: { axis: "horizontal", projection: "centerInParent" },
		verticalDock: { axis: "vertical", projection: "centerInParent" }
	}), {
		...message,
		deltaLeft: 0,
		deltaTop: 0,
		horizontalDock: { axis: "horizontal", projection: "centerInParent" },
		verticalDock: { axis: "vertical", projection: "centerInParent" }
	});
	assert.equal(parseDesignerWebviewMessage({ ...message, deltaLeft: 1.5 }), undefined);
	assert.deepEqual(parseDesignerWebviewMessage({ ...message, margin: { left: 14.5, top: 31.5 } }), {
		...message,
		margin: { left: 14.5, top: 31.5 }
	});
	assert.equal(parseDesignerWebviewMessage({ ...message, margin: { left: Number.NaN } }), undefined);
	assert.equal(parseDesignerWebviewMessage({ ...message, margin: { left: Number.POSITIVE_INFINITY } }), undefined);
	assert.equal(parseDesignerWebviewMessage({ ...message, margin: { left: Number.MAX_SAFE_INTEGER + 1 } }), undefined);
	assert.equal(parseDesignerWebviewMessage({ ...message, horizontalDock: { axis: "vertical", projection: "alignLeft" } }), undefined);
	assert.equal(parseDesignerWebviewMessage({ ...message, horizontalDock: { axis: "horizontal", projection: "alignLeft" } }), undefined);
	assert.equal(parseDesignerWebviewMessage({
		...message,
		deltaLeft: 0,
		deltaTop: 0,
		horizontalDock: undefined
	}), undefined);
});

test("设计器协议允许新增或跨容器迁移携带唯一的相对布局落点", () => {
	const relativePlacement = {
		deltaLeft: 24,
		deltaTop: 30,
		horizontalDock: {
			axis: "horizontal",
			projection: "alignLeft",
			targetComponentName: "按钮2",
			targetXmlPath: "/属性/定义[1]/定义[1]/定义[2]"
		},
		left: 120,
		margin: { left: 8, top: 6 },
		top: 90,
		verticalDock: { axis: "vertical", projection: "alignParentTop" }
	};
	const added = {
		componentType: "按钮",
		contextToken: "designer",
		parentComponentName: "面板1",
		parentXmlPath: "/属性/定义[1]/定义[1]",
		relativePlacement,
		renderVersion: 3,
		target: "canvas",
		type: "addComponent"
	};
	assert.deepEqual(parseDesignerWebviewMessage(added), added);
	assert.equal(parseDesignerWebviewMessage({
		...added,
		absolutePosition: { left: 1, top: 2 }
	}), undefined);
	assert.equal(parseDesignerWebviewMessage({
		...added,
		relativePlacement: {
			...relativePlacement,
			horizontalDock: { axis: "vertical", projection: "alignLeft" }
		}
	}), undefined);
	assert.equal(parseDesignerWebviewMessage({
		...added,
		relativePlacement: { ...relativePlacement, margin: { left: Number.NaN } }
	}), undefined);

	const relocated = {
		componentName: "按钮1",
		componentXmlPath: "/属性/定义[1]/定义[2]",
		contextToken: "designer",
		parentComponentName: "面板1",
		parentXmlPath: "/属性/定义[1]/定义[1]",
		relativePlacement,
		renderVersion: 3,
		type: "relocateComponent"
	};
	assert.deepEqual(parseDesignerWebviewMessage(relocated), relocated);
	assert.equal(parseDesignerWebviewMessage({
		...relocated,
		gridPosition: { column: 0, row: 0 }
	}), undefined);
});

test("设计器协议允许新增或迁移组件携带唯一的单帧布局落点", () => {
	const relocated = {
		componentName: "按钮1",
		componentXmlPath: "/属性/定义[1]/定义[1]",
		contextToken: "designer",
		framePlacement: {
			alignment: { horizontal: "right", vertical: "bottom" },
			fitContentHeight: true,
			fitContentWidth: true,
			margin: { bottom: 14.5, right: 20.5 }
		},
		parentComponentName: "窗口1",
		parentXmlPath: "/属性/定义[1]",
		renderVersion: 3,
		type: "relocateComponent"
	};
	assert.deepEqual(parseDesignerWebviewMessage(relocated), relocated);
	assert.equal(parseDesignerWebviewMessage({
		...relocated,
		framePlacement: {
			...relocated.framePlacement,
			alignment: { horizontal: "start", vertical: "bottom" }
		}
	}), undefined);
	assert.equal(parseDesignerWebviewMessage({
		...relocated,
		framePlacement: { ...relocated.framePlacement, margin: { right: Number.NaN } }
	}), undefined);
	assert.equal(parseDesignerWebviewMessage({
		...relocated,
		framePlacement: { ...relocated.framePlacement, fitContentWidth: "true" }
	}), undefined);
	assert.equal(parseDesignerWebviewMessage({
		...relocated,
		absolutePosition: { left: 1, top: 2 }
	}), undefined);
	const added = {
		componentType: "按钮",
		contextToken: "designer",
		framePlacement: relocated.framePlacement,
		parentComponentName: "窗口1",
		parentXmlPath: "/属性/定义[1]",
		renderVersion: 3,
		target: "canvas",
		type: "addComponent"
	};
	assert.deepEqual(parseDesignerWebviewMessage(added), added);
});
