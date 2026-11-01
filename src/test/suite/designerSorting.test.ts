/*
在真实 Vue Webview 中验证列顺序分层回退、用户分组排序模式、恢复默认及文档不变。
xhwsd@qq.com 2026-11-1
*/

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { SimpleCodeFileSystemProvider, toSimpleCodeUri, toSimpleDesignerUri } from "../../simpleCodeFileSystem";
import { SimpleDesignerProvider } from "../../designerWebview";
import type { SimpleDesignerDocument } from "../../designerDocument";
import type { DesignerDocumentPreference, DesignerPreferenceState } from "../../designerPreferencePersistence";
import { DESIGNER_COLUMN_IDS } from "../../designerLayout";
import { designerColumnOrder, toolboxCategoryOrder } from "../../designerUserSettings";
import { loadSdk } from "../../sdk";
import { serializePropertyXml } from "../../propertyXml";
import { filePathKey } from "../../simpleProjectPaths";
import { testExtensionId, testSdkPath } from "../testFixtures";
import { simpleTestProjectPath } from "../testProjects";

/** 只读取正式 DOM 并派发真实 Vue 监听的交互事件，不模拟排序或宿主持久化。 */
const driver = `
const acquire = window.acquireVsCodeApi;
let api, ready = false;
window.acquireVsCodeApi = () => { api = acquire(); return api; };
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
window.addEventListener('message', async event => {
 if (event.data.type === 'renderDesigner') {
  if (!ready) { ready = true; setTimeout(() => api.postMessage({type: 'testSortingReady'}), 0); }
  return;
 }
 if (event.data.type !== 'testSorting') return;
 try {
  await frame(); await frame();
  const input = event.data;
  const groups = () => [...document.querySelectorAll('.toolbox-group')];
  const group = name => groups().find(element => element.querySelector('.toolbox-group-name').textContent === name);
  let feedback, columnStart;
  if (input.action === 'drag') {
   const source = group(input.source).querySelector(input.selector || 'summary');
   const target = group(input.target), summary = target.querySelector('summary');
   const box = summary.getBoundingClientRect(), transfer = new DataTransfer();
   source.dispatchEvent(new DragEvent('dragstart', {bubbles: true, cancelable: true, dataTransfer: transfer}));
   target.dispatchEvent(new DragEvent('dragover', {bubbles: true, cancelable: true, dataTransfer: transfer, clientY: box.top + (input.position === 'before' ? 1 : box.height - 1)}));
   await frame();
   feedback = { shadow: getComputedStyle(summary).boxShadow, opacity: getComputedStyle(source.closest('.toolbox-group')).opacity };
   if (!input.cancel) target.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: transfer, clientY: box.top + (input.position === 'before' ? 1 : box.height - 1)}));
   source.dispatchEvent(new DragEvent('dragend', {bubbles: true, dataTransfer: transfer}));
   if (input.clickAfter) source.click();
  }
  if (input.action === 'clickGroup') group(input.source).querySelector(input.selector).click();
  if (input.action === 'toggleSorting') document.querySelector('[data-toolbox-sort-toggle]').click();
  if (input.action === 'expandAll') document.querySelector('[aria-label="全部展开可用组件"]').click();
  if (input.action === 'moveColumn') {
   const source = document.querySelector('[data-designer-column="' + (input.source || 'toolbox') + '"] [data-designer-column-handle]');
   const target = document.querySelector('[data-designer-column="' + (input.target || 'property') + '"]');
   const list = document.querySelector('.toolbox-list');
   const originalGroups = groups().map(element => ({element, open: element.open}));
   const scrollTop = list.scrollTop;
   let toggles = 0;
   const countToggle = () => toggles++;
   list.addEventListener('toggle', countToggle, true);
   const box = target.getBoundingClientRect(), transfer = new DataTransfer();
   source.dispatchEvent(new DragEvent('dragstart', {bubbles: true, cancelable: true, dataTransfer: transfer}));
   await frame(); await frame();
   columnStart = {
    sorting: document.querySelector('[data-toolbox-sort-toggle]').getAttribute('aria-pressed') === 'true',
    groupsUnchanged: originalGroups.every((original, index) => groups()[index] === original.element && original.element.open === original.open),
    scrollUnchanged: list.scrollTop === scrollTop, toggles
   };
   list.removeEventListener('toggle', countToggle, true);
   if (!input.cancel) {
    const clientX = input.position === 'after' ? box.right - 1 : box.left + 1;
    target.dispatchEvent(new DragEvent('dragover', {bubbles: true, cancelable: true, dataTransfer: transfer, clientX}));
    target.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: transfer, clientX}));
   }
   source.dispatchEvent(new DragEvent('dragend', {bubbles: true, dataTransfer: transfer}));
  }
  await frame(); await frame();
  api.postMessage({type: 'testSortingResult', id: input.id, result: {
   columns: [...document.querySelectorAll('[data-designer-column]')].map(element => element.dataset.designerColumn),
   groups: groups().map(element => {
    const summary = element.querySelector('summary');
    return {name: element.querySelector('.toolbox-group-name').textContent, open: element.open, draggable: summary.draggable, titleTooltip: summary.title, titleCursor: getComputedStyle(summary).cursor};
   }),
   sorting: document.querySelector('[data-toolbox-sort-toggle]').getAttribute('aria-pressed') === 'true',
   expandDisabled: document.querySelector('[aria-label="全部展开可用组件"]').disabled,
   toolboxActions: [...document.querySelectorAll('.toolbox-section .section-title-action')].map(element => element.getAttribute('aria-label')),
   feedback, columnStart, indicators: document.querySelectorAll('.toolbox-group-source, .toolbox-group-drop-before, .toolbox-group-drop-after').length
  }});
 } catch (error) { api.postMessage({type: 'testSortingResult', id: event.data.id, error: String(error)}); }
});`;

interface ViewState {
	readonly columns: readonly string[];
	readonly sorting: boolean;
	readonly expandDisabled: boolean;
	readonly toolboxActions: readonly string[];
	readonly groups: readonly {
		readonly name: string;
		readonly open: boolean;
		readonly draggable: boolean;
		readonly titleTooltip: string;
		readonly titleCursor: string;
	}[];
	readonly feedback?: { readonly shadow: string; readonly opacity: string };
	readonly columnStart?: {
		readonly sorting: boolean;
		readonly groupsUnchanged: boolean;
		readonly scrollUnchanged: boolean;
		readonly toggles: number;
	};
	readonly indicators: number;
}

/** 等待配置写入、宿主刷新及 Vue 页面更新。 */
async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 250; attempt += 1) {
		if (await condition()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.fail("设计器排序未在时限内达到预期状态");
}

/** 在可见正式 Webview 中执行一个交互，并读取结果。 */
async function interact(panel: vscode.WebviewPanel, action: string, options: Record<string, unknown> = {}): Promise<ViewState> {
	const id = Math.random().toString(36);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { listener.dispose(); reject(new Error("排序页面交互超时")); }, 7000);
		const listener = panel.webview.onDidReceiveMessage((message) => {
			if (message.type !== "testSortingResult" || message.id !== id) {
				return;
			}
			clearTimeout(timer);
			listener.dispose();
			if (message.error !== undefined) {
				reject(new Error(message.error));
			} else {
				resolve(message.result as ViewState);
			}
		});
		void panel.webview.postMessage({ type: "testSorting", id, action, ...options });
	});
}

suite("设计器用户排序", () => {
	test("用户默认列顺序不覆盖单元，分组排序跨单元共享且不修改 XML", async function () {
		this.timeout(60000);
		const extension = vscode.extensions.getExtension(testExtensionId())!;
		await extension.activate();
		const configuration = vscode.workspace.getConfiguration("es4a");
		const originalColumns = configuration.inspect("designer.columnOrder")?.globalValue;
		const originalCategories = configuration.inspect("designer.toolboxCategoryOrder")?.globalValue;
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-sorting-"));
		const source = await fs.readFile(simpleTestProjectPath("Tetris", "src", "simple", "samples", "tetris", "Tetris.simple"), "utf8");
		const documents = new SimpleCodeFileSystemProvider();
		const preferences = new Map<string, DesignerDocumentPreference>();
		let columnWrites = 0;
		const preferenceState: DesignerPreferenceState = {
			getDocument: (file) => preferences.get(filePathKey(file)) ?? {},
			updateColumnOrder: async (file, columnOrder) => { columnWrites++; preferences.set(filePathKey(file), { columnOrder }); },
			updateDisplayOption: async () => undefined, moveDocument: async () => undefined, deleteDocument: async () => undefined
		};
		const provider = new SimpleDesignerProvider(documents, extension.extensionUri, preferenceState);
		const settingsListener = vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration("es4a.designer")) {
				provider.refreshAll();
			}
		});
		const panels: vscode.WebviewPanel[] = [];
		const designers: SimpleDesignerDocument[] = [];
		let edits = 0;
		const editListener = provider.onDidChangeCustomDocument(() => { edits++; });
		const cancellation = new vscode.CancellationTokenSource();
		try {
			await configuration.update("designer.columnOrder", ["property", "enabled", "projection", "toolbox"], vscode.ConfigurationTarget.Global);
			await configuration.update("designer.toolboxCategoryOrder", ["扩展可视组件", "暂未安装", "扩展组件", "扩展组件容器"], vscode.ConfigurationTarget.Global);
			const sdk = await loadSdk(testSdkPath());
			provider.updateSdk({ ...sdk, manifests: [...sdk.manifests, {
				name: "排序验证库", kind: "library", directory: "", filePath: "sorting.json", categories: [
					{ name: "扩展可视组件", definitions: [{ kind: "component", name: "排序视觉" }] },
					{ name: "扩展组件", definitions: [{ kind: "component", name: "排序非视觉" }] },
					{ name: "扩展组件容器", definitions: [{ kind: "component", name: "排序容器" }] }
				]
			}] });
			for (const name of ["First", "Second"]) {
				const file = path.join(directory, name + ".simple");
				await fs.writeFile(file, source, "utf8");
				const uri = vscode.Uri.file(file);
				await documents.readFile(toSimpleCodeUri(uri));
				const designer = await provider.openCustomDocument(toSimpleDesignerUri(uri), { backupId: undefined, untitledDocumentData: undefined }, cancellation.token);
				designers.push(designer);
				if (name === "Second") {
					preferences.set(filePathKey(file), { columnOrder: ["property", "projection", "toolbox", "enabled"] });
				}
				const panel = vscode.window.createWebviewPanel("es4a.sortingTest", "设计器排序验证 " + name, vscode.ViewColumn.One, { enableScripts: true });
				panels.push(panel);
				let ready = false;
				const listener = panel.webview.onDidReceiveMessage((message) => { if (message.type === "testSortingReady") ready = true; });
				provider.resolveCustomEditor(designer, panel);
				const html = panel.webview.html;
				const nonce = /<script nonce="([^"]+)"/u.exec(html)?.[1];
				assert.ok(nonce);
				panel.webview.html = html.replace(/<script nonce=/u, () => `<script nonce="${nonce}">${driver}</script><script nonce=`);
				await waitFor(() => ready);
				listener.dispose();
				assert.deepEqual((await interact(panel, "inspect")).columns, name === "First"
					? ["property", "enabled", "projection", "toolbox"] : ["property", "projection", "toolbox", "enabled"]);
			}
			const panel = panels[1]!;
			const baseline = serializePropertyXml(documents.getProperty(designers[1]!.currentCodeDocument)!.document!);
			const initial = await interact(panel, "inspect");
			assert.deepEqual(initial.toolboxActions, ["进入分组排序", "全部折叠可用组件", "全部展开可用组件"]);
			assert.equal(initial.sorting, false);
			for (const group of initial.groups) {
				assert.equal(group.draggable, false);
				assert.equal(group.titleCursor, "pointer");
				assert.equal(group.titleTooltip, "");
			}
			const originalOrder = [...toolboxCategoryOrder()];
			for (const selector of [".group-disclosure", ".toolbox-group-name", ".toolbox-group-count", "summary"]) {
				const clicked = await interact(panel, "clickGroup", { source: "扩展组件容器", selector });
				assert.equal(clicked.groups.find((group) => group.name === "扩展组件容器")?.open, false);
				const opened = await interact(panel, "clickGroup", { source: "扩展组件容器", selector });
				assert.equal(opened.groups.find((group) => group.name === "扩展组件容器")?.open, true);
			}
			await interact(panel, "drag", { source: "扩展组件容器", target: "扩展可视组件", position: "before" });
			assert.deepEqual(toolboxCategoryOrder(), originalOrder);
			const sorting = await interact(panel, "toggleSorting");
			assert.equal(sorting.sorting, true);
			assert.equal(sorting.expandDisabled, true);
			assert.equal(sorting.toolboxActions[0], "退出分组排序");
			assert.ok(sorting.groups.every((group) => !group.open));
			assert.ok(sorting.groups.every((group) => group.draggable));
			for (const group of sorting.groups) {
				assert.equal(group.titleCursor, "grab");
				assert.equal(group.titleTooltip, "拖动调整分组顺序");
			}
			for (const selector of [".group-disclosure", ".toolbox-group-name", ".toolbox-group-count", "summary"]) {
				const clicked = await interact(panel, "clickGroup", { source: "扩展组件容器", selector });
				assert.ok(clicked.groups.every((group) => !group.open));
				await interact(panel, "drag", { source: "扩展组件容器", target: "扩展可视组件", position: "before", selector, cancel: true });
				assert.deepEqual(toolboxCategoryOrder(), originalOrder);
			}
			assert.ok((await interact(panel, "expandAll")).groups.every((group) => !group.open));
			const moved = await interact(panel, "drag", { source: "扩展组件容器", target: "扩展可视组件", position: "before", clickAfter: true });
			assert.notEqual(moved.feedback?.shadow, "none");
			assert.equal(moved.feedback?.opacity, "0.62");
			await waitFor(() => toolboxCategoryOrder()[0] === "扩展组件容器");
			await waitFor(async () => (await interact(panel, "inspect")).groups.filter((group) => group.draggable)[0]?.name === "扩展组件容器");
			const sorted = await interact(panel, "inspect");
			assert.equal(sorted.groups.find((group) => group.name === "扩展组件容器")?.open, false);
			assert.equal(sorted.indicators, 0);
			assert.ok(toolboxCategoryOrder().includes("暂未安装"));
			assert.equal(columnWrites, 0, "分组拖动不能写单元列设置");
			const runtimeName = initial.groups.find((group) => !group.name.startsWith("扩展"))!.name;
			await interact(panel, "drag", { source: runtimeName, target: "扩展组件", position: "after" });
			await waitFor(() => toolboxCategoryOrder().indexOf(runtimeName) === toolboxCategoryOrder().indexOf("扩展组件") + 1);
			await waitFor(async () => {
				const names = (await interact(panel, "inspect")).groups.map((group) => group.name);
				return names.indexOf(runtimeName) === names.indexOf("扩展组件") + 1;
			});
			await interact(panel, "drag", { source: "扩展组件", target: runtimeName, position: "after" });
			await waitFor(() => toolboxCategoryOrder().indexOf("扩展组件") === toolboxCategoryOrder().indexOf(runtimeName) + 1);
			await waitFor(async () => {
				const names = (await interact(panel, "inspect")).groups.map((group) => group.name);
				return names.indexOf("扩展组件") === names.indexOf(runtimeName) + 1;
			});
			const saved = [...toolboxCategoryOrder()];
			await interact(panel, "drag", { source: "扩展组件", target: "扩展组件容器", position: "before", cancel: true, clickAfter: true });
			assert.deepEqual(toolboxCategoryOrder(), saved);
			assert.equal((await interact(panel, "inspect")).groups.find((group) => group.name === "扩展组件")?.open, false);
			assert.equal((await interact(panel, "inspect")).indicators, 0);
			assert.equal((await interact(panel, "inspect")).sorting, true, "配置刷新不退出排序模式");
			const exited = await interact(panel, "toggleSorting");
			assert.equal(exited.sorting, false);
			assert.equal(exited.expandDisabled, false);
			assert.ok(exited.groups.every((group) => !group.open && !group.draggable));
			const reopened = await interact(panel, "clickGroup", { source: "扩展组件容器", selector: ".group-disclosure" });
			assert.equal(reopened.groups.find((group) => group.name === "扩展组件容器")?.open, true);
			await interact(panel, "moveColumn");
			await waitFor(() => columnWrites === 1);
			for (const sourceColumn of DESIGNER_COLUMN_IDS) {
				await interact(panel, "toggleSorting");
				const beforeCancel = await interact(panel, "inspect");
				const canceled = await interact(panel, "moveColumn", { source: sourceColumn, cancel: true });
				assert.deepEqual(canceled.columnStart, { sorting: false, groupsUnchanged: true, scrollUnchanged: true, toggles: 0 });
				assert.equal(canceled.sorting, false, "任意列开始拖动即退出，取消后不重新进入排序");
				assert.equal(canceled.expandDisabled, false);
				assert.deepEqual(canceled.columns, beforeCancel.columns);
				assert.deepEqual(canceled.groups.map(({ name, open }) => ({ name, open })), beforeCancel.groups.map(({ name, open }) => ({ name, open })));
				assert.ok(canceled.groups.every((group) => !group.draggable));
				assert.deepEqual(toolboxCategoryOrder(), saved);
				assert.equal(columnWrites, 1, "取消列拖动不保存顺序");
			}
			let expectedColumnWrites = columnWrites;
			for (const sourceColumn of ["enabled", "toolbox"]) {
				await interact(panel, "toggleSorting");
				const beforeMove = await interact(panel, "inspect");
				const first = beforeMove.columns[0]!;
				const target = first === sourceColumn ? beforeMove.columns.at(-1)! : first;
				const position = first === sourceColumn ? "after" : "before";
				const movedColumn = await interact(panel, "moveColumn", { source: sourceColumn, target, position });
				assert.deepEqual(movedColumn.columnStart, { sorting: false, groupsUnchanged: true, scrollUnchanged: true, toggles: 0 });
				assert.equal(movedColumn.sorting, false);
				assert.deepEqual(movedColumn.groups.map(({ name, open }) => ({ name, open })), beforeMove.groups.map(({ name, open }) => ({ name, open })));
				const expected = beforeMove.columns.filter((column) => column !== sourceColumn);
				expected.splice(expected.indexOf(target) + (position === "after" ? 1 : 0), 0, sourceColumn);
				expectedColumnWrites++;
				await waitFor(() => columnWrites === expectedColumnWrites);
				await waitFor(async () => JSON.stringify((await interact(panel, "inspect")).columns) === JSON.stringify(expected));
				assert.deepEqual(toolboxCategoryOrder(), saved);
			}
			assert.deepEqual(configuration.inspect("designer.columnOrder")?.globalValue, ["property", "enabled", "projection", "toolbox"]);
			panels[0]!.reveal();
			await waitFor(() => panels[0]!.visible);
			const shared = await interact(panels[0]!, "inspect");
			assert.equal(shared.sorting, false, "排序模式只属于当前设计器");
			assert.deepEqual(shared.groups.map((group) => group.name), saved.filter((name) => name !== "暂未安装"));
			assert.deepEqual((await interact(panels[0]!, "inspect")).columns, ["property", "enabled", "projection", "toolbox"]);
			await configuration.update("designer.toolboxCategoryOrder", undefined, vscode.ConfigurationTarget.Global);
			await waitFor(() => configuration.inspect("designer.toolboxCategoryOrder")?.globalValue === undefined);
			assert.deepEqual(toolboxCategoryOrder(), []);
			await configuration.update("designer.columnOrder", undefined, vscode.ConfigurationTarget.Global);
			await waitFor(async () => JSON.stringify((await interact(panels[0]!, "inspect")).columns) === JSON.stringify(DESIGNER_COLUMN_IDS));
			assert.deepEqual(designerColumnOrder(undefined), DESIGNER_COLUMN_IDS);
			assert.equal(edits, 0);
			assert.equal(serializePropertyXml(documents.getProperty(designers[1]!.currentCodeDocument)!.document!), baseline);
			for (const name of ["First", "Second"]) {
				assert.equal(await fs.readFile(path.join(directory, name + ".simple"), "utf8"), source);
			}
		} finally {
			for (const panel of panels) panel.dispose();
			for (const designer of designers) designer.dispose();
			settingsListener.dispose(); editListener.dispose(); provider.dispose(); documents.dispose(); cancellation.dispose();
			await configuration.update("designer.columnOrder", originalColumns, vscode.ConfigurationTarget.Global);
			await configuration.update("designer.toolboxCategoryOrder", originalCategories, vscode.ConfigurationTarget.Global);
			assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});
});
