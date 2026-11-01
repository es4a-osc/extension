/*
在正式 Vue Webview 中验证自定义布局关联、同值常量和不同基类组件的相同投影。
xhwsd@qq.com 2026-10-28
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { SimpleCodeFileSystemProvider, toSimpleCodeUri, toSimpleDesignerUri } from "../../simpleCodeFileSystem";
import { SimpleDesignerProvider } from "../../designerWebview";
import type { SimpleDesignerDocument } from "../../designerDocument";
import { createSimpleDesignerModel } from "../../designerModel";
import { serializePropertyXml } from "../../propertyXml";
import { loadSdk } from "../../sdk";
import { testExtensionId, testSdkPath } from "../testFixtures";
import { PROJECTION_CONTRACT_SOURCE, withProjectionContract } from "../designerDecouplingFixture";

/** 只驱动正式 DOM、样式及选择事件，不模拟投影算法或 XML 编辑。 */
const driver = `
const originalApi = window.acquireVsCodeApi;
let api, ready = false;
window.acquireVsCodeApi = () => { api = originalApi(); return api; };
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
window.addEventListener('message', async event => {
 if (event.data.type === 'renderDesigner') {
  if (!ready) { ready = true; setTimeout(() => api.postMessage({type: 'testReady'}), 0); }
  return;
 }
 if (event.data.type !== 'testDecoupling') return;
 try {
  await frame(); await frame();
  const node = path => [...document.querySelectorAll('.visual-node[data-component-path]')].find(element => element.dataset.componentPath === path);
  const first = node(event.data.first), second = node(event.data.second);
  if (!first || !second) throw new Error('投影组件没有显示：' + JSON.stringify({first: event.data.first, nodes: [...document.querySelectorAll('.designer-canvas [data-component-path]')].map(element => ({path: element.dataset.componentPath, classes: element.className})), notice: document.querySelector('.designer-empty')?.textContent}));
  const a = first.getBoundingClientRect(), b = second.getBoundingClientRect();
  if (!(a.width > 0 && a.height > 0 && b.left >= a.right - 1 && Math.abs(a.top - b.top) < 1)) throw new Error('自定义关联未生成横向排列：' + JSON.stringify({first: a.toJSON(), second: b.toJSON()}));
  if (Math.abs(parseFloat(getComputedStyle(first).width) - 104) > 1) throw new Error('尺寸常量没有按值投影');
  const appearance = element => {
   const style = getComputedStyle(element);
   return { color: style.color, background: style.backgroundColor, size: style.fontSize, weight: style.fontWeight };
  };
  if (JSON.stringify(appearance(first)) !== JSON.stringify(appearance(second))) throw new Error('相同投影因基类不同产生外观差异');
  if (first.querySelector('.visual-control-content')?.textContent !== '字段投影') throw new Error('自定义文本属性没有投影');
  first.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, button: 0, pointerId: 1, clientX: a.left + 12, clientY: a.top + 12}));
  for (let i = 0; i < 100 && !node(event.data.first)?.classList.contains('selected'); i++) await new Promise(resolve => setTimeout(resolve, 20));
  if (!node(event.data.first)?.classList.contains('selected')) throw new Error('画布选择未同步');
  api.postMessage({type: 'testResult', result: {horizontal: true, equalAppearance: true, selection: true}});
 } catch (error) { api.postMessage({type: 'testResult', error: String(error)}); }
});`;

suite("投影与组件名称解耦", () => {
	test("自定义关联横向排列且不同基类外观一致，选择不修改 XML", async function () {
		this.timeout(30000);
		const extension = vscode.extensions.getExtension(testExtensionId())!;
		await extension.activate();
		const sdk = withProjectionContract(await loadSdk(testSdkPath()));
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-decoupling-"));
		const sourceFile = path.join(directory, "Main.simple");
		const sourceUri = vscode.Uri.file(sourceFile);
		const documents = new SimpleCodeFileSystemProvider();
		const provider = new SimpleDesignerProvider(documents, extension.extensionUri, {
			getDocument: () => ({ displayOptions: { componentLabelsVisible: true } }),
			updateColumnOrder: async () => undefined, updateDisplayOption: async () => undefined,
			moveDocument: async () => undefined, deleteDocument: async () => undefined
		});
		const panel = vscode.window.createWebviewPanel("es4a.decouplingTest", "投影解耦验证", vscode.ViewColumn.One, { enableScripts: true });
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
		const wait = async (condition: () => boolean): Promise<void> => {
			for (let attempt = 0; attempt < 300 && !condition(); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
			assert.ok(condition(), "真实投影页面没有在时限内响应");
		};
		try {
			await fs.writeFile(sourceFile, PROJECTION_CONTRACT_SOURCE, "utf8");
			await documents.readFile(toSimpleCodeUri(sourceUri));
			designer = await provider.openCustomDocument(toSimpleDesignerUri(sourceUri), { backupId: undefined, untitledDocumentData: undefined }, cancellation.token);
			const owner = await designer.getCodeDocument();
			const document = documents.getProperty(owner)!.document!;
			const baseline = serializePropertyXml(document);
			const children = createSimpleDesignerModel(document, sdk).root!.children[0]!.children;
			provider.updateSdk(sdk);
			provider.resolveCustomEditor(designer, panel);
			const html = panel.webview.html;
			const nonce = /<script nonce="([^"]+)"/u.exec(html)?.[1];
			assert.ok(nonce);
			panel.webview.html = html.replace(/<script nonce=/u, () => `<script nonce="${nonce}">${driver}</script><script nonce=`);
			await wait(() => ready);
			await panel.webview.postMessage({ type: "testDecoupling", first: children[0]!.path, second: children[1]!.path });
			await wait(() => result !== undefined);
			assert.equal(result?.error, undefined);
			assert.deepEqual(result?.result, { horizontal: true, equalAppearance: true, selection: true });
			assert.equal(edits, 0);
			assert.equal(serializePropertyXml(documents.getProperty(owner)!.document!), baseline);
			assert.equal(await fs.readFile(sourceFile, "utf8"), PROJECTION_CONTRACT_SOURCE);
		} finally {
			panel.dispose(); listener.dispose(); editListener.dispose(); designer?.dispose();
			provider.dispose(); documents.dispose(); cancellation.dispose();
			assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});
});
