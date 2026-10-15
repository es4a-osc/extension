/*
在真实设计器 Webview 中验证满尺寸组件及覆盖层拖放，检查各布局的落位与 XML 事务。
xhwsd@qq.com 2026-10-12
*/

import { testSdkPath } from "../testFixtures";

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { SimpleCodeFileSystemProvider, toSimpleCodeUri, toSimpleDesignerUri } from "../../simpleCodeFileSystem";
import { SimpleDesignerProvider } from "../../designerWebview";
import { addSimpleDesignerComponent, createSimpleDesignerModel, relocateSimpleDesignerComponent } from "../../designerModel";
import { createPropertyXmlAttributePath, parseSimplePropertyXml, serializePropertyXml, writePropertyXmlValue } from "../../propertyXml";
import { loadSdk } from "../../sdk";
import { getVisibleSimpleUnitUserCode } from "../../simpleUnitSource";
import type { SimpleDesignerDocument } from "../../designerDocument";
import type { AddDesignerComponentMessage } from "../../designerProtocol";

/** 只注入事件驱动器；正式 Vue 客户端、宿主消息处理和 XML 持久化保持原样。 */
const dropDriver = `
const originalApi = window.acquireVsCodeApi;
let api, model, ready = false;
const submitted = [];
window.acquireVsCodeApi = () => {
	const original = originalApi();
	api = { postMessage(message) {
		if (message.type === "addComponent") submitted.push(message);
		return original.postMessage(message);
	} };
	return api;
};
function check(condition, message) { if (!condition) throw new Error(message); }
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
function find(node, name) {
	if (node.name === name) return node;
	for (const child of node.children) { const match = find(child, name); if (match) return match; }
}
window.addEventListener("message", async event => {
	if (event.data.type === "renderDesigner") {
		model = event.data;
		if (!ready) { ready = true; setTimeout(() => api.postMessage({ type: "testReady" }), 0); }
		return;
	}
	if (event.data.type !== "testDrop") return;
	const { id, action, accepted, parentPath } = event.data;
	try {
		if (action === "select") {
			let group;
			for (let attempt = 0; attempt < 200; attempt++) {
				group = find(model.projection.root, "分组列表框1");
				const parent = find(model.projection.root, event.data.parentName);
				if (parent?.children.length === 1) break;
				await new Promise(resolve => setTimeout(resolve, 20));
			}
			check(group, "满尺寸组件不存在");
			api.postMessage({ type: "selectNode", contextToken: model.contextToken, renderVersion: model.renderVersion, componentName: group.name, xmlPath: group.path });
			for (let attempt = 0; attempt < 200 && model.projection.selectedPath !== group.path; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
			check(model.projection.selectedPath === group.path, "组件未选中");
			await frame(); await frame();
		} else {
			const group = find(model.projection.root, "分组列表框1");
			const body = [...document.querySelectorAll('.visual-node[data-component-path]')].find(node => node.dataset.componentPath === group.path);
			check(body, "组件 DOM 不存在");
			body.scrollIntoView({ block: "center", inline: "center" });
			await frame(); await frame();
			const target = action === "body" ? body.querySelector('.visual-control-content') ?? body
				: action === "label" ? document.querySelector('.designer-component-name-selected .designer-component-name-text')
				: action === "handle" ? document.querySelector('.designer-resize-handle-right')
				: action === "feedback" ? document.querySelector('.designer-drag-layer')
				: [...document.querySelectorAll('[data-grid-cell-parent]')].find(node => node.dataset.gridCellParent === parentPath && node.dataset.gridCellRow === "1" && node.dataset.gridCellColumn === "1");
			check(target, "拖放目标不存在: " + action);
			const bounds = (action === "cell" ? target : body).getBoundingClientRect();
			check(bounds.width > 0 && bounds.height > 0, "目标没有可见尺寸");
			const init = { bubbles: true, cancelable: true, dataTransfer: new DataTransfer(), clientX: (Math.max(0, bounds.left) + Math.min(innerWidth, bounds.right)) / 2, clientY: (Math.max(0, bounds.top) + Math.min(innerHeight, bounds.bottom)) / 2 };
			const toolbox = document.querySelector('.toolbox-item[data-component-type="按钮"]');
			check(toolbox, "按钮候选不存在");
			const before = submitted.length;
			toolbox.dispatchEvent(new DragEvent("dragstart", init));
			if (action === "feedback") body.dispatchEvent(new DragEvent("dragover", init));
			const over = new DragEvent("dragover", init);
			target.dispatchEvent(over);
			// VS Code Webview 全局也会 preventDefault；拒绝落点须检查实际消息和 XML，不能只看该标记。
			if (accepted) check(over.defaultPrevented, "有效落点未接纳拖入: " + action);
			await frame(); await frame();
			const feedback = document.querySelector('.designer-drop-feedback');
			if (accepted) {
				check(feedback, "拖动中未显示着落示意图: " + action);
				const feedbackBounds = feedback.getBoundingClientRect();
				const style = getComputedStyle(feedback);
				check(feedbackBounds.width > 0 && feedbackBounds.height > 0 && style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0", "着落示意图不可见");
				const layout = event.data.layout;
				check(layout.startsWith("linear") ? feedback.className.includes("designer-drop-feedback-insert-") : feedback.classList.contains("designer-drop-feedback-" + layout), "着落示意图布局错误");
			} else check(!feedback, "拒绝落点仍显示有效着落示意图");
			check(submitted.length === before, "拖动预览提前新增了组件");
			target.dispatchEvent(new DragEvent("drop", init));
			toolbox.dispatchEvent(new DragEvent("dragend", init));
			await frame(); await frame();
			check(!document.querySelector('.designer-drop-feedback'), "拖动结束后仍显示着落示意图");
			check(submitted.length === before + (accepted ? 1 : 0), "新增消息次数错误");
			if (accepted) check(submitted.at(-1).parentXmlPath === parentPath, "拖入了错误容器: " + action);
		}
		api.postMessage({ type: "testResult", id, message: action === "select" ? undefined : submitted.at(-1) });
	} catch (error) { api.postMessage({ type: "testResult", id, error: String(error) }); }
});
`;

suite("设计器满尺寸组件拖放", () => {
	for (const nested of [false, true]) for (const layout of ["linear-vertical", "linear-horizontal", "frame", "absolute", "relative", "grid"] as const) {
		test(`${nested ? "嵌套面板" : "窗口"} ${layout}：满尺寸组件本体、名称和尺寸覆盖层保持布局落位规则`, async function () {
			this.timeout(30000);
			const extension = vscode.extensions.getExtension("es4a.es4a")!;
			await extension.activate();
			const sdk = await loadSdk(testSdkPath("sdk.json"));
			const source = await fs.readFile(testSdkPath("libraries/simple.library.wsd.grouplist/sample/src/simple/library/wsd/grouplist/sample/主窗口.simple"), "utf8");
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-designer-drop-"));
			const sourceFile = path.join(directory, "主窗口.simple");
			const sourceUri = vscode.Uri.file(sourceFile);
			const documents = new SimpleCodeFileSystemProvider();
			const provider = new SimpleDesignerProvider(documents, extension.extensionUri, {
				getDocument: () => ({ displayOptions: { componentLabelsVisible: true } }), updateColumnOrder: async () => undefined, updateDisplayOption: async () => undefined, moveDocument: async () => undefined, deleteDocument: async () => undefined
			});
			const panel = vscode.window.createWebviewPanel("es4a.designerDropTest", "设计器拖放回归", vscode.ViewColumn.One, { enableScripts: true });
			const cancellation = new vscode.CancellationTokenSource();
			const edits: vscode.CustomDocumentEditEvent<SimpleDesignerDocument>[] = [];
			const editListener = provider.onDidChangeCustomDocument(event => edits.push(event));
			const results = new Map<string, { readonly error?: string; readonly message?: AddDesignerComponentMessage }>();
			let ready = false;
			const listener = panel.webview.onDidReceiveMessage((message: { readonly type?: string; readonly id?: string; readonly error?: string; readonly message?: AddDesignerComponentMessage }) => {
				if (message.type === "testReady") ready = true;
				if (message.type === "testResult" && message.id !== undefined) results.set(message.id, message);
			});
			const waitFor = async (condition: () => boolean): Promise<void> => {
				for (let attempt = 0; attempt < 300 && !condition(); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
				assert.ok(condition(), "设计器未在时限内响应");
			};
			let designer: SimpleDesignerDocument | undefined;
			try {
				await fs.writeFile(sourceFile, source);
				await documents.readFile(toSimpleCodeUri(sourceUri));
				designer = await provider.openCustomDocument(toSimpleDesignerUri(sourceUri), { backupId: undefined, untitledDocumentData: undefined }, cancellation.token);
				const owner = await designer.getCodeDocument();
				const original = documents.getProperty(owner)!.document!;
				let seeded = original;
				const rootPath = "/属性/定义[1]";
				let parentPath = rootPath;
				if (nested) {
					const panelResult = addSimpleDesignerComponent(seeded, sdk, "面板", rootPath, "canvas");
					parentPath = panelResult.componentPath;
					seeded = relocateSimpleDesignerComponent(panelResult.document, sdk, rootPath + "/定义[1]", parentPath).document;
					parentPath = createSimpleDesignerModel(seeded, sdk).root!.children[0]!.path;
				}
				const setValue = (nodePath: string, name: string, value: string): void => {
					seeded = writePropertyXmlValue(seeded, createPropertyXmlAttributePath(nodePath, "赋值", "属性", name, "值"), value);
				};
				setValue(parentPath, "布局", layout.startsWith("linear") ? "布局_线性" : ({ frame: "布局_单帧", absolute: "布局_绝对", relative: "布局_相对", grid: "布局_表格" } as const)[layout as "frame" | "absolute" | "relative" | "grid"]);
				if (nested) { setValue(parentPath, "宽度", "长度_匹配父级"); setValue(parentPath, "高度", "长度_匹配父级"); }
				if (layout.startsWith("linear")) setValue(parentPath, "布局.方向", layout === "linear-horizontal" ? "0" : "1");
				if (layout === "grid") {
					// TableRow 按内容收缩；另留一空行验证内部落点，避开外层线性布局的首尾同级插入区。
					setValue(parentPath, "布局.行数", "2"); setValue(parentPath, "布局.列数", "2");
					setValue(parentPath + "/定义[1]", "行", "0"); setValue(parentPath + "/定义[1]", "列", "0");
				}
				const projection = createSimpleDesignerModel(seeded, sdk).root!;
				const container = nested ? projection.children[0]! : projection;
				assert.equal(container.layout, layout);
				assert.equal(container.children[0]?.name, "分组列表框1");
				assert.equal(container.children[0]?.width?.kind, "parent");
				assert.equal(container.children[0]?.height?.kind, "parent");
				documents.setDesignerPropertyDocument(owner, original, seeded);
				const baseline = serializePropertyXml(seeded);
				provider.updateSdk(sdk);
				provider.resolveCustomEditor(designer, panel);
				const html = panel.webview.html;
				const nonce = /<script nonce="([^"]+)"/u.exec(html)?.[1];
				assert.ok(nonce);
				panel.webview.html = html.replace(/<script nonce=/u, () => '<script nonce="' + nonce + '">' + dropDriver + '</script><script nonce=');
				await waitFor(() => ready);
				const run = async (action: string, accepted = true): Promise<AddDesignerComponentMessage | undefined> => {
					results.delete(action);
					await panel.webview.postMessage({ type: "testDrop", id: action, action, accepted, parentPath, parentName: nested ? "面板1" : "主窗口", layout });
					await waitFor(() => results.has(action));
					assert.equal(results.get(action)?.error, undefined);
					return results.get(action)?.message;
				};
				const actions = ["body", "label", "handle", "feedback", ...(layout === "grid" ? ["cell"] : [])];
				for (const action of actions) {
					await run("select");
					const count = edits.length;
					const accepted = layout !== "grid" || action === "cell";
					const message = await run(action, accepted);
					if (!accepted) { assert.equal(edits.length, count); assert.equal(serializePropertyXml(documents.getProperty(owner)!.document!), baseline); continue; }
					await waitFor(() => edits.length === count + 1);
					assert.equal(owner.getText(), getVisibleSimpleUnitUserCode(source));
					assert.equal(await fs.readFile(sourceFile, "utf8"), source);
					if (layout === "grid") assert.deepEqual(message?.gridPosition, { row: 1, column: 1 });
					else if (layout === "absolute") assert.ok(message?.absolutePosition);
					else if (layout === "relative") assert.ok(message?.relativePlacement);
					else if (layout === "frame") assert.ok(message?.framePlacement);
					else { assert.equal(message?.referenceComponentName, "分组列表框1"); assert.ok(message?.position); }
					const updated = serializePropertyXml(documents.getProperty(owner)!.document!);
					assert.match(updated, /名称="按钮1"/u);
					await edits[count]!.undo();
					assert.equal(serializePropertyXml(documents.getProperty(owner)!.document!), baseline);
					await edits[count]!.redo();
					assert.equal(serializePropertyXml(documents.getProperty(owner)!.document!), updated);
					if (action === actions.at(-1)) {
						await provider.saveCustomDocument(designer, cancellation.token);
						const savedAddition = await fs.readFile(sourceFile, "utf8");
						assert.equal(getVisibleSimpleUnitUserCode(savedAddition), getVisibleSimpleUnitUserCode(source));
						const reopenedAddition = parseSimplePropertyXml(savedAddition);
						assert.ok(reopenedAddition);
						assert.equal(serializePropertyXml(reopenedAddition), updated);
					}
					await edits[count]!.undo();
				}
				await provider.saveCustomDocument(designer, cancellation.token);
				const saved = await fs.readFile(sourceFile, "utf8");
				assert.equal(getVisibleSimpleUnitUserCode(saved), getVisibleSimpleUnitUserCode(source));
				const reopened = parseSimplePropertyXml(saved);
				assert.ok(reopened);
				assert.equal(serializePropertyXml(reopened), baseline);
			} finally {
				panel.dispose(); listener.dispose(); editListener.dispose(); designer?.dispose(); provider.dispose(); documents.dispose(); cancellation.dispose();
				const code = vscode.workspace.textDocuments.find(document => document.uri.toString() === toSimpleCodeUri(sourceUri).toString());
				if (code?.isDirty) { await vscode.window.showTextDocument(code); await vscode.commands.executeCommand("workbench.action.files.revert"); }
				if (code !== undefined) { await vscode.window.showTextDocument(code); await vscode.commands.executeCommand("workbench.action.closeActiveEditor"); }
				assert.equal(path.dirname(directory), os.tmpdir());
				await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
			}
		});
	}
});
