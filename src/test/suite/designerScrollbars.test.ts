/*
在正式 Vue 设计器中验证覆盖式滚动条的悬停显隐、零布局占位和滚动操作，保持 XML 与选择不变。
xhwsd@qq.com 2026-10-27
*/

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { SimpleCodeFileSystemProvider, toSimpleCodeUri, toSimpleDesignerUri } from "../../simpleCodeFileSystem";
import { SimpleDesignerProvider } from "../../designerWebview";
import { addSimpleDesignerComponent, createSimpleDesignerModel } from "../../designerModel";
import { createPropertyXmlAttributePath, serializePropertyXml, writePropertyXmlValue } from "../../propertyXml";
import { loadSdk } from "../../sdk";
import type { SimpleDesignerDocument } from "../../designerDocument";
import { testSdkPath } from "../testFixtures";
import { simpleTestUnitPath } from "../testProjects";

/** 驱动真实 DOM 和 Vue 事件；不替换测量、滚动或 XML 实现。 */
const scrollDriver = `
const originalApi = window.acquireVsCodeApi;
let api, ready = false;
const edits = [];
window.acquireVsCodeApi = () => {
 const original = originalApi();
 api = { postMessage(message) {
  if (["selectNode", "updateXmlValue", "resizeComponent", "relocateComponent"].includes(message.type)) edits.push(message);
  return original.postMessage(message);
 } };
 return api;
};
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
const waitFor = async predicate => {
 for (let i = 0; i < 150 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 20));
 if (!predicate()) throw new Error("滚动覆盖层状态等待超时");
};
function check(value, message) { if (!value) throw new Error(message); }
window.addEventListener("message", async event => {
 if (event.data.type === "renderDesigner") {
  if (!ready) { ready = true; setTimeout(() => api.postMessage({ type: "testReady" }), 0); }
  return;
 }
 if (event.data.type !== "testScrollbar") return;
 try {
  await frame(); await frame();
  const surface = [...document.querySelectorAll('[data-layout-surface-path]')].find(element => element.dataset.layoutSurfacePath === event.data.path);
  const canvas = document.querySelector('.designer-canvas');
  check(surface && canvas, "滚动容器未渲染");
  const horizontal = event.data.axis === "horizontal";
  const size = () => ({ width: surface.clientWidth, height: surface.clientHeight, childWidth: surface.firstElementChild.getBoundingClientRect().width, childHeight: surface.firstElementChild.getBoundingClientRect().height });
  const initial = size();
  const style = getComputedStyle(surface);
  check(surface.offsetWidth - surface.clientWidth - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth) === 0, "原生纵向滚动条占用了宽度");
  check(surface.offsetHeight - surface.clientHeight - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth) === 0, "原生横向滚动条占用了高度");
  check(!document.querySelector('.designer-scrollbar'), "未悬停时不应显示滚动条");
  const bounds = surface.getBoundingClientRect();
  const hover = () => surface.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: bounds.left + 30, clientY: bounds.top + 30, pointerId: 1 }));
  hover();
  await waitFor(() => document.querySelector('.designer-scrollbar-' + event.data.axis));
  let bar = document.querySelector('.designer-scrollbar-' + event.data.axis);
  const thumb = bar.querySelector('.designer-scrollbar-thumb');
  check(getComputedStyle(bar).backgroundColor === 'rgba(0, 0, 0, 0)', "轨道必须透明");
  check(getComputedStyle(thumb).borderRadius !== '0px', "滑块应使用圆角");
  check(JSON.stringify(size()) === JSON.stringify(initial), "显示滚动条改变了布局尺寸");
  bar.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 70 }));
  await frame(); await frame();
  check((horizontal ? surface.scrollLeft : surface.scrollTop) > 0, "滑块区域不能响应滚轮");
  bar = document.querySelector('.designer-scrollbar-' + event.data.axis);
  bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
  await frame(); await frame();
  const offset = horizontal ? surface.scrollLeft : surface.scrollTop;
  const maximum = horizontal ? surface.scrollWidth - surface.clientWidth : surface.scrollHeight - surface.clientHeight;
  check(Math.abs(offset - maximum) < 1, "滚动条未能浏览到内容末尾");
  check(JSON.stringify(size()) === JSON.stringify(initial), "滚动操作改变了布局尺寸");
  canvas.dispatchEvent(new PointerEvent('pointerleave', { pointerId: 1 }));
  await waitFor(() => !document.querySelector('.designer-scrollbar'));
  check(JSON.stringify(size()) === JSON.stringify(initial), "隐藏滚动条改变了布局尺寸");
  check(edits.length === 0, "滚动条操作触发了组件选择或 XML 编辑");
  api.postMessage({ type: "testResult", result: { initial, offset, maximum } });
 } catch (error) { api.postMessage({ type: "testResult", error: String(error) }); }
});
`;

suite("设计器覆盖式滚动条", () => {
	for (const target of ["container", "window"] as const) for (const axis of ["horizontal", "vertical"] as const) test(`${target} ${axis}：悬停显示且不占布局空间，不改变选择或 XML`, async function () {
		this.timeout(30000);
		const extension = vscode.extensions.getExtension("es4a.es4a")!;
		await extension.activate();
		const sdk = await loadSdk(testSdkPath());
		const name = axis === "horizontal" ? "水平" : "垂直";
		const source = await fs.readFile(await simpleTestUnitPath("SmokeTests", `测试${name}滚动框`), "utf8");
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-overlay-scrollbar-"));
		const sourceFile = path.join(directory, "主窗口.simple");
		const sourceUri = vscode.Uri.file(sourceFile);
		const documents = new SimpleCodeFileSystemProvider();
		const provider = new SimpleDesignerProvider(documents, extension.extensionUri, {
			getDocument: () => ({ displayOptions: { componentLabelsVisible: true } }), updateColumnOrder: async () => undefined,
			updateDisplayOption: async () => undefined, moveDocument: async () => undefined, deleteDocument: async () => undefined
		});
		const panel = vscode.window.createWebviewPanel("es4a.overlayScrollTest", "覆盖式滚动条回归", vscode.ViewColumn.One, { enableScripts: true });
		const cancellation = new vscode.CancellationTokenSource();
		let designer: SimpleDesignerDocument | undefined;
		let ready = false;
		let result: { error?: string; result?: unknown } | undefined;
		let edits = 0;
		const listener = panel.webview.onDidReceiveMessage((message: { type?: string; error?: string; result?: unknown }) => {
			if (message.type === "testReady") ready = true;
			if (message.type === "testResult") result = message;
		});
		const editListener = provider.onDidChangeCustomDocument(() => { edits++; });
		const waitFor = async (condition: () => boolean): Promise<void> => {
			for (let attempt = 0; attempt < 300 && !condition(); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
			assert.ok(condition(), "设计器未在时限内响应");
		};
		try {
			await fs.writeFile(sourceFile, source);
			await documents.readFile(toSimpleCodeUri(sourceUri));
			designer = await provider.openCustomDocument(toSimpleDesignerUri(sourceUri), { backupId: undefined, untitledDocumentData: undefined }, cancellation.token);
			const owner = await designer.getCodeDocument();
			const original = documents.getProperty(owner)!.document!;
			const root = createSimpleDesignerModel(original, sdk).root!;
			const scroll = target === "window" ? root : root.children.find(node => node.name === `${name}滚动框1`)!;
			const content = target === "window" ? root : scroll.children.find(node => node.name === "面板2")!;
			const addition = addSimpleDesignerComponent(original, sdk, "按钮", content.path, "canvas");
			let seeded = addition.document;
			const setValue = (xmlPath: string, property: string, value: string): void => {
				seeded = writePropertyXmlValue(seeded, createPropertyXmlAttributePath(xmlPath, "赋值", "属性", property, "值"), value);
			};
			setValue(root.path, "布局", target === "window" ? "布局_单帧" : "布局_线性");
			setValue(root.path, "布局.方向", "1");
			// 运行时关闭滚动和滚动条，设计期仍须能够浏览溢出内容。
			setValue(root.path, "滚动", "假");
			if (target === "container") {
				setValue(scroll.path, "宽度", "240");
				setValue(scroll.path, "高度", "160");
				setValue(scroll.path, "启用滚动条", "假");
				setValue(content.path, "宽度", "长度_适应内容");
				setValue(content.path, "高度", "长度_适应内容");
			}
			setValue(addition.componentPath, "宽度", "900");
			setValue(addition.componentPath, "高度", "900");
			documents.setDesignerPropertyDocument(owner, original, seeded);
			const baseline = serializePropertyXml(seeded);
			provider.updateSdk(sdk);
			provider.resolveCustomEditor(designer, panel);
			const html = panel.webview.html;
			const nonce = /<script nonce="([^"]+)"/u.exec(html)?.[1];
			assert.ok(nonce);
			// 测试只隐藏无关列，保持画布、组件树和正式导航覆盖层的真实 DOM。
			panel.webview.html = html.replace(/<script nonce=/u, () => `<style nonce="${nonce}">.designer-column:not([data-designer-column="projection"]) { display:none !important; }.designer-shell { display:block !important; }</style><script nonce="${nonce}">${scrollDriver}</script><script nonce=`);
			await waitFor(() => ready);
			await panel.webview.postMessage({ type: "testScrollbar", axis, path: scroll.path });
			await waitFor(() => result !== undefined);
			assert.equal(result?.error, undefined);
			assert.ok(result?.result);
			assert.equal(edits, 0);
			assert.equal(serializePropertyXml(documents.getProperty(owner)!.document!), baseline);
			assert.equal(await fs.readFile(sourceFile, "utf8"), source);
		} finally {
			panel.dispose(); listener.dispose(); editListener.dispose(); designer?.dispose(); provider.dispose(); documents.dispose(); cancellation.dispose();
			assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});
});
