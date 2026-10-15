/*
在真实设计器 Webview 中验证回车、失焦和输入法事件，经共享文档边界提交组件名称及属性。
xhwsd@qq.com 2026-10-10
*/

import { testSdkPath } from "../testFixtures";

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { SimpleCodeFileSystemProvider, toSimpleCodeUri, toSimpleDesignerUri } from "../../simpleCodeFileSystem";
import { SimpleDesignerProvider } from "../../designerWebview";
import { serializePropertyXml } from "../../propertyXml";
import { loadSdk } from "../../sdk";
import { getVisibleSimpleUnitUserCode } from "../../simpleUnitSource";
import type { SimpleDesignerDocument } from "../../designerDocument";
import { planSimpleComponentProjectRename, renameSimpleComponent } from "../../componentRename";

/** 只在测试页面注入事件驱动器；正式 Vue 客户端、宿主 Provider 和 XML 事务保持原样。 */
const inputDriver = `
const acquireOriginalApi = window.acquireVsCodeApi;
let testApi;
const submitted = [];
let lastModel;
let lastResult;
let lastSelection;
let ready = false;
window.acquireVsCodeApi = () => {
	const api = acquireOriginalApi();
	testApi = { postMessage(message) {
		if (message.type === "updateXmlValue") submitted.push(message);
		if (message.type === "selectNode") lastSelection = message;
		return api.postMessage(message);
	} };
	return testApi;
};
function check(condition, message) { if (!condition) throw new Error(message); }
window.addEventListener("message", async (event) => {
	if (event.data.type === "propertyOperationResult") { lastResult = event.data; return; }
	if (event.data.type === "renderDesigner") {
		lastModel = event.data;
		if (!ready) { ready = true; setTimeout(() => testApi.postMessage({ type: "testReady" }), 0); }
		return;
	}
	if (event.data.type !== "testInput") return;
	const { action, id } = event.data;
	try {
		if (action === "preview") {
			const input = document.querySelector('input[data-property-name="名称"]');
			check(input && input.dataset.componentName === "按钮1", "未选择原组件");
			input.focus(); input.value = "延迟按钮";
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
			await new Promise(resolve => setTimeout(resolve, 0));
			check(input.readOnly && input.value === "延迟按钮" && document.activeElement === input, "未即时显示新名并保留焦点");
			check(document.querySelector(".component-name").textContent === "延迟按钮", "属性标题未即时改名");
			check([...document.querySelectorAll(".tree-name")].some(node => node.textContent === "延迟按钮"), "布局树未即时改名");
			const canvasName = document.querySelector(".designer-component-name-selected .designer-component-name-text");
			if (canvasName) check(canvasName.textContent === "延迟按钮", "画布标签未即时改名");
			check(lastModel.propertyPanel.title === "按钮1", "前端篡改了正式模型");
			check(!document.querySelector('[role="status"]'), "快速操作提前显示同步状态");
		} else if (action === "pending") {
			const edit = submitted[submitted.length - 1];
			window.postMessage({ type: "propertyOperationResult", contextToken: edit.contextToken, requestId: edit.requestId + 100, succeeded: true }, "*");
			await new Promise(resolve => setTimeout(resolve, 0));
			for (let attempt = 0; attempt < 100 && !document.querySelector('[role="status"]'); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
			const status = document.querySelector('[role="status"]');
			check(status?.textContent === "重构中…", "慢操作没有重构状态或旧确认清除了新状态：" + JSON.stringify({ lastResult, submitted, header: document.querySelector(".component-name")?.textContent }));
			check(document.querySelector(".component-name").textContent === "延迟按钮", "普通重绘丢失临时显示");
		} else if (action === "confirmed" || action === "restored") {
			const edit = submitted[submitted.length - 1];
			for (let attempt = 0; attempt < 100 && lastResult?.requestId !== edit.requestId; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
			await new Promise(resolve => setTimeout(resolve, 0));
			check(lastResult?.requestId === edit.requestId && lastResult.succeeded === (action === "confirmed"), "未收到匹配的处理结果");
			const expected = action === "confirmed" ? "延迟按钮" : "按钮1";
			const input = document.querySelector('input[data-property-name="名称"]');
			check(input && input.value === expected && !input.readOnly, "处理后没有确认或恢复输入");
			check(document.querySelector(".component-name").textContent === expected, "标题没有确认或恢复");
			check([...document.querySelectorAll(".tree-name")].some(node => node.textContent === expected), "布局树没有确认或恢复");
			check(!document.querySelector('[role="status"]'), "完成后仍显示同步中");
		} else if (action === "select") {
			const node = lastModel.projection.root.children[0];
			testApi.postMessage({ type: "selectNode", contextToken: lastModel.contextToken, renderVersion: lastModel.renderVersion, componentName: node.name, xmlPath: node.path });
		} else if (action === "selection") {
			const node = lastModel.projection.root.children[0];
			await new Promise(resolve => setTimeout(resolve, 0));
			check(lastModel.projection.selectedPath === node.path, "改名事务刷新后丢失组件选择");
			check(lastModel.propertyPanel.title === node.name, "属性框切换到了其它组件");
			check(document.querySelector(".component-name").textContent === node.name, "属性标题未保持选中组件");
			check(document.querySelector('.designer-component-feedback-selected')?.dataset.componentPath === node.path, "画布取消了组件选中");
		} else {
			const renaming = action === "rename" || action === "renameSelected";
			const property = renaming ? "名称" : "文本";
			let input;
			for (let attempt = 0; attempt < 100; attempt++) {
				input = document.querySelector('input[data-property-name="' + property + '"]');
				if (input && input.dataset.componentName === (renaming ? "按钮1" : "演示按钮")) break;
				await new Promise(resolve => setTimeout(resolve, 20));
			}
			check(input && input.dataset.componentName === (renaming ? "按钮1" : "演示按钮"), "未显示目标组件属性");
			input.focus();
			const before = submitted.length;
			if (action === "cancel") {
				const original = input.value;
				input.value = "取消编辑";
				input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
				check(input.value === original && submitted.length === before, "Escape 未取消编辑");
			} else {
				input.value = renaming ? "演示按钮" : "回车演示";
				input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
				input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true }));
				check(submitted.length === before && document.activeElement === input, "输入法选字提前提交或失焦");
				const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
				input.dispatchEvent(enter);
				check(enter.defaultPrevented && submitted.length === before + 1 && document.activeElement === input, "回车未直接提交并保留焦点");
				input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
				input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true, cancelable: true }));
				if (action === "rename") {
					document.querySelector(".layout-tree-item").click();
					check(lastSelection && lastSelection.pendingPropertyEdit === undefined, "回车后切换选择重发属性编辑");
				}
				input.blur();
				check(submitted.length === before + 1, "重复回车或随后失焦重复提交");
			}
		}
		testApi.postMessage({ type: "testResult", id });
	} catch (error) { testApi.postMessage({ type: "testResult", id, error: String(error) }); }
});
`;

suite("设计器属性输入", () => {
	for (const mode of ["项目计划", "未注册项目", "本地同步"]) test(`真实 Vue 页面回车提交改名和文本（${mode}），输入法、重复提交及取消保持正确`, async function () {
		this.timeout(30000);
		const extension = vscode.extensions.getExtension("es4a.es4a")!;
		await extension.activate();
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-property-enter-"));
		const sourceFile = path.join(directory, "主窗口.simple");
		const source = '事件 按钮1.被单击()\r\n\t按钮1.文本 = "演示"\r\n结束 事件\r\n\r\n$属性\r\n\t$资源 $窗口\r\n\t$定义 主窗口 $为 窗口\r\n\t\t$定义 按钮1 $为 按钮\r\n\t\t$结束 $定义\r\n\t$结束 $定义\r\n$结束 $属性\r\n';
		const documents = new SimpleCodeFileSystemProvider();
		const sdk = await loadSdk(testSdkPath("sdk.json"));
		let planCalls = 0;
		const provider = new SimpleDesignerProvider(documents, extension.extensionUri, {
			getDocument: () => ({}), updateColumnOrder: async () => undefined, updateDisplayOption: async () => undefined, moveDocument: async () => undefined, deleteDocument: async () => undefined
		}, undefined, mode !== "本地同步" ? async (_document, componentPath, name) => {
			planCalls++;
			if (mode === "未注册项目") return [];
			const owner = await documents.readRefactoringUnit(vscode.Uri.file(sourceFile), directory);
			return planSimpleComponentProjectRename([owner], owner, componentPath, name, sdk);
		} : undefined);
		const panel = vscode.window.createWebviewPanel("es4a.propertyEnterTest", "属性回车回归", vscode.ViewColumn.One, { enableScripts: true });
		const cancellation = new vscode.CancellationTokenSource();
		// 复现正式 main.ts 的代码变化刷新，不能只验证孤立 Provider 的最终提交。
		const codeListener = vscode.workspace.onDidChangeTextDocument((event) => provider.refreshDocument(event.document));
		const edits: vscode.CustomDocumentEditEvent<SimpleDesignerDocument>[] = [];
		const editListener = provider.onDidChangeCustomDocument((event) => edits.push(event));
		const results = new Map<string, { readonly error?: string }>();
		let ready = false;
		const listener = panel.webview.onDidReceiveMessage((message: { readonly type?: string; readonly id?: string; readonly error?: string }) => {
			if (message.type === "testReady") ready = true;
			if (message.type === "testResult" && message.id !== undefined) results.set(message.id, message);
		});
		const waitFor = async (condition: () => boolean): Promise<void> => {
			for (let attempt = 0; attempt < 300 && !condition(); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
			assert.ok(condition(), "设计器页面未在时限内响应");
		};
		const run = async (action: string): Promise<void> => {
			results.delete(action);
			await panel.webview.postMessage({ type: "testInput", action, id: action });
			await waitFor(() => results.has(action));
			assert.equal(results.get(action)?.error, undefined);
		};
		let designer: SimpleDesignerDocument | undefined;
		try {
			await fs.writeFile(sourceFile, source);
			const sourceUri = vscode.Uri.file(sourceFile);
			await documents.readFile(toSimpleCodeUri(sourceUri));
			designer = await provider.openCustomDocument(toSimpleDesignerUri(sourceUri), { backupId: undefined, untitledDocumentData: undefined }, cancellation.token);
			provider.updateSdk(sdk);
			provider.resolveCustomEditor(designer, panel);
			const html = panel.webview.html;
			const nonce = /<script nonce="([^"]+)"/u.exec(html)?.[1];
			assert.ok(nonce);
			panel.webview.html = html.replace(/<script nonce=/u, () => '<script nonce="' + nonce + '">' + inputDriver + '</script><script nonce=');
			await waitFor(() => ready);
			await run("select");
			await run("renameSelected");
			await waitFor(() => edits.length === 1);
			assert.equal(planCalls, mode === "本地同步" ? 0 : 1);
			const owner = await designer.getCodeDocument();
			assert.equal(owner.getText(), getVisibleSimpleUnitUserCode(source.replaceAll("按钮1", "演示按钮")));
			assert.match(serializePropertyXml(documents.getProperty(owner)!.document!), /名称="演示按钮"/u);
			await run("selection");
			await run("text");
			await waitFor(() => edits.length === 2);
			await run("cancel");
			assert.equal(edits.length, 2);
			assert.equal(await fs.readFile(sourceFile, "utf8"), source);
			await provider.saveCustomDocument(designer, cancellation.token);
			const saved = await fs.readFile(sourceFile, "utf8");
			assert.equal(getVisibleSimpleUnitUserCode(saved), getVisibleSimpleUnitUserCode(source));
			assert.match(saved, /\$定义 演示按钮 \$为 按钮/u);
			assert.match(saved, /文本 = "回车演示"/u);
			await edits[1]!.undo();
			await edits[0]!.undo();
			assert.equal(owner.getText(), getVisibleSimpleUnitUserCode(source));
			assert.match(serializePropertyXml(documents.getProperty(owner)!.document!), /名称="按钮1"/u);
			await run("selection");
			await edits[0]!.redo();
			await run("selection");
			await edits[0]!.undo();
			// 代码侧 XML 事务的改名通知同样要保留选中节点，且逆向通知能恢复原名称。
			const beforeCodeRename = documents.getProperty(owner)!.document!;
			const codeRename = renameSimpleComponent(owner.getText(), beforeCodeRename, "/属性/定义[1]/定义[1]", "代码改名按钮", sdk);
			documents.setDesignerPropertyDocument(owner, beforeCodeRename, codeRename.propertyDocument);
			provider.refreshDocument(owner, { from: "按钮1", to: "代码改名按钮" });
			await run("selection");
			documents.setDesignerPropertyDocument(owner, codeRename.propertyDocument, beforeCodeRename);
			provider.refreshDocument(owner, { from: "代码改名按钮", to: "按钮1" });
			await run("selection");
		} finally {
			panel.dispose(); listener.dispose(); codeListener.dispose(); editListener.dispose(); designer?.dispose(); provider.dispose(); documents.dispose(); cancellation.dispose();
			const code = vscode.workspace.textDocuments.find((document) => document.uri.toString() === toSimpleCodeUri(vscode.Uri.file(sourceFile)).toString());
			if (code?.isDirty) { await vscode.window.showTextDocument(code); await vscode.commands.executeCommand("workbench.action.files.revert"); }
			if (code !== undefined) { await vscode.window.showTextDocument(code); await vscode.commands.executeCommand("workbench.action.closeActiveEditor"); }
			assert.equal(path.dirname(directory), os.tmpdir());
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	for (const succeeded of [true, false]) test(`组件改名立即显示，慢同步${succeeded ? "成功确认" : "失败恢复"}且正式 XML 与代码不提前改变`, async function () {
		this.timeout(30000);
		const extension = vscode.extensions.getExtension("es4a.es4a")!;
		await extension.activate();
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-rename-feedback-"));
		const sourceFile = path.join(directory, "主窗口.simple");
		const source = '事件 按钮1.被单击()\r\n结束 事件\r\n\r\n$属性\r\n\t$资源 $窗口\r\n\t$定义 主窗口 $为 窗口\r\n\t\t$定义 按钮1 $为 按钮\r\n\t\t$结束 $定义\r\n\t$结束 $定义\r\n$结束 $属性\r\n';
		const documents = new SimpleCodeFileSystemProvider();
		const sdk = await loadSdk(testSdkPath("sdk.json"));
		let release!: () => void;
		let analyzing = false;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const provider = new SimpleDesignerProvider(documents, extension.extensionUri, {
			getDocument: () => ({}), updateColumnOrder: async () => undefined, updateDisplayOption: async () => undefined, moveDocument: async () => undefined, deleteDocument: async () => undefined
		}, undefined, async (_document, componentPath, name) => {
			analyzing = true;
			await gate;
			if (!succeeded) throw new Error("模拟组件关联同步失败");
			const owner = await documents.readRefactoringUnit(vscode.Uri.file(sourceFile), directory);
			return planSimpleComponentProjectRename([owner], owner, componentPath, name, sdk);
		});
		const panel = vscode.window.createWebviewPanel("es4a.renameFeedbackTest", "组件改名反馈回归", vscode.ViewColumn.One, { enableScripts: true });
		const cancellation = new vscode.CancellationTokenSource();
		const codeListener = vscode.workspace.onDidChangeTextDocument((event) => provider.refreshDocument(event.document));
		const edits: vscode.CustomDocumentEditEvent<SimpleDesignerDocument>[] = [];
		const editListener = provider.onDidChangeCustomDocument((event) => edits.push(event));
		const results = new Map<string, { readonly error?: string }>();
		let ready = false;
		const listener = panel.webview.onDidReceiveMessage((value: { readonly type?: string; readonly id?: string; readonly error?: string }) => {
			if (value.type === "testReady") ready = true;
			if (value.type === "testResult" && value.id !== undefined) results.set(value.id, value);
		});
		const waitFor = async (condition: () => boolean): Promise<void> => {
			for (let attempt = 0; attempt < 300 && !condition(); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
			assert.ok(condition(), "设计器未在时限内响应");
		};
		const run = async (action: string): Promise<void> => {
			results.delete(action);
			await panel.webview.postMessage({ type: "testInput", action, id: action });
			await waitFor(() => results.has(action));
			assert.equal(results.get(action)?.error, undefined);
		};
		let designer: SimpleDesignerDocument | undefined;
		try {
			await fs.writeFile(sourceFile, source);
			const sourceUri = vscode.Uri.file(sourceFile);
			await documents.readFile(toSimpleCodeUri(sourceUri));
			designer = await provider.openCustomDocument(toSimpleDesignerUri(sourceUri), { backupId: undefined, untitledDocumentData: undefined }, cancellation.token);
			provider.updateSdk(sdk);
			provider.resolveCustomEditor(designer, panel);
			const html = panel.webview.html;
			const nonce = /<script nonce="([^"]+)"/u.exec(html)?.[1];
			assert.ok(nonce);
			panel.webview.html = html.replace(/<script nonce=/u, () => '<script nonce="' + nonce + '">' + inputDriver + '</script><script nonce=');
			await waitFor(() => ready);
			await run("select");
			await waitFor(() => panel.visible);
			await new Promise((resolve) => setTimeout(resolve, 100));
			await run("preview");
			await waitFor(() => analyzing);
			const owner = await designer.getCodeDocument();
			assert.equal(owner.getText(), getVisibleSimpleUnitUserCode(source));
			assert.match(serializePropertyXml(documents.getProperty(owner)!.document!), /名称="按钮1"/u);
			assert.equal(edits.length, 0);
			await run("select");
			await new Promise((resolve) => setTimeout(resolve, 600));
			await run("pending");
			release();
			await run(succeeded ? "confirmed" : "restored");
			await run("selection");
			assert.equal(edits.length, succeeded ? 1 : 0);
			assert.equal(await fs.readFile(sourceFile, "utf8"), source);
			if (succeeded) {
				assert.match(owner.getText(), /事件 延迟按钮\.被单击/u);
				await edits[0]!.undo();
				await run("selection");
				await edits[0]!.redo();
				await run("selection");
				await edits[0]!.undo();
			}
			assert.equal(owner.getText(), getVisibleSimpleUnitUserCode(source));
			assert.match(serializePropertyXml(documents.getProperty(owner)!.document!), /名称="按钮1"/u);
		} finally {
			release(); panel.dispose(); listener.dispose(); codeListener.dispose(); editListener.dispose(); designer?.dispose(); provider.dispose(); documents.dispose(); cancellation.dispose();
			const code = vscode.workspace.textDocuments.find((document) => document.uri.toString() === toSimpleCodeUri(vscode.Uri.file(sourceFile)).toString());
			if (code?.isDirty) { await vscode.window.showTextDocument(code); await vscode.commands.executeCommand("workbench.action.files.revert"); }
			if (code !== undefined) { await vscode.window.showTextDocument(code); await vscode.commands.executeCommand("workbench.action.closeActiveEditor"); }
			assert.equal(path.dirname(directory), os.tmpdir());
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});
});
