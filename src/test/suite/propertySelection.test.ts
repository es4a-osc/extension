/*
使用正式 Vue 设计器和 XML 会话验证属性输入、失焦与画布选择的两种消息顺序。
xhwsd@qq.com 2026-10-8
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { SimpleDesignerDocument } from "../../designerDocument";
import { SimpleDesignerProvider, type DesignerWebviewRenderMessage } from "../../designerWebview";
import { getPropertyXmlAttribute, getPropertyXmlChildren, resolvePropertyXmlElement, serializePropertyXml } from "../../propertyXml";
import { SimpleCodeFileSystemProvider, toSimpleCodeUri, toSimpleDesignerUri } from "../../simpleCodeFileSystem";
import { loadSdk } from "../../sdk";

/** 等待真实 Webview 与宿主完成交互，超时显示这一步的业务目标。 */
async function waitForSelectionEdit(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 10000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(label + "超时");
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
	}
}

suite("属性输入与画布选择", () => {
	test("点击画布和先失焦两种顺序均保存输入，连续选择保留最终目标且不重复写入", async function () {
		this.timeout(40000);
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension);
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-property-selection-"));
		const sourceFile = path.join(directory, "SelectionWindow.simple");
		const userCode = "' 用户代码必须逐字保留\r\n事件 SelectionWindow.初始化()\r\n结束 事件\r\n\r\n";
		const source = userCode + [
			"$属性", "\t$资源 $窗口", "\t$定义 SelectionWindow $为 窗口",
			"\t\t$定义 Button1 $为 按钮", "\t\t$结束 $定义",
			"\t\t$定义 Button2 $为 按钮", '\t\t\t未知属性 = "保留"', "\t\t$结束 $定义",
			"\t\t$定义 Button3 $为 按钮", "\t\t$结束 $定义",
			"\t$结束 $定义", "$结束 $属性", ""
		].join("\r\n");
		const codeDocuments = new SimpleCodeFileSystemProvider();
		const provider = new SimpleDesignerProvider(codeDocuments, extension.extensionUri, {
			getDocument: () => ({}), updateColumnOrder: async () => {}, updateDisplayOption: async () => {},
			moveDocument: async () => {}, deleteDocument: async () => {}
		});
		const cancellation = new vscode.CancellationTokenSource();
		const panel = vscode.window.createWebviewPanel("es4a.propertySelectionTest", "属性提交回归",
			vscode.ViewColumn.Active, { enableScripts: true });
		let document: SimpleDesignerDocument | undefined;
		let latest: DesignerWebviewRenderMessage | undefined;
		const edits: vscode.CustomDocumentEditEvent<SimpleDesignerDocument>[] = [];
		const messages: string[] = [];
		const subscriptions = [
			provider.onDidChangeCustomDocument((event) => edits.push(event)),
			panel.webview.onDidReceiveMessage((message: unknown) => {
				if (typeof message === "object" && message !== null && "type" in message && typeof message.type === "string") {
					messages.push(message.type);
				}
			})
		];
		const originalPost = panel.webview.postMessage.bind(panel.webview);
		panel.webview.postMessage = (message: unknown) => {
			if (typeof message === "object" && message !== null && "type" in message && message.type === "renderDesigner") {
				latest = message as DesignerWebviewRenderMessage;
			}
			return originalPost(message);
		};
		try {
			await fs.writeFile(sourceFile, source, "utf8");
			const sourceUri = vscode.Uri.file(sourceFile);
			await codeDocuments.readFile(toSimpleCodeUri(sourceUri));
			document = await provider.openCustomDocument(toSimpleDesignerUri(sourceUri),
				{ backupId: undefined, untitledDocumentData: undefined }, cancellation.token);
			provider.updateSdk(await loadSdk(path.resolve(extension.extensionPath, "..", "sdk", "sdk.json")));
			provider.resolveCustomEditor(document, panel);
			const html = panel.webview.html;
			const nonce = /<script nonce="([^"]+)"/u.exec(html)?.[1];
			assert.ok(nonce);
			/* 仅在此测试面板注入驱动；正式构建的 Vue 输入、画布和宿主协议全部照常运行。 */
			panel.webview.html = html.replace("</body>", `<script nonce="${nonce}">
				window.addEventListener('message', (event) => {
					const action = event.data;
					if (action.type !== 'testPropertySelection') return;
					requestAnimationFrame(() => requestAnimationFrame(() => {
						const input = document.querySelector('input.property-input[data-property-name="宽度"]');
						if (action.value !== undefined && input !== null) {
							input.focus(); input.value = action.value;
							input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
							if (action.blurFirst) input.blur();
						}
						for (const name of action.targets) {
							const target = document.querySelector('.visual-node[data-menu-label="' + name + '"]');
							if (target === null) throw new Error('缺少画布组件 ' + name);
							const rect = target.getBoundingClientRect();
							target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0,
								clientX: rect.left + 1, clientY: rect.top + 1 }));
						}
						if (action.value !== undefined && input !== null) input.blur();
					}));
				});
			</script></body>`);
			await waitForSelectionEdit(() => latest !== undefined, "初始化正式设计器");
			const componentPath = (name: string): string | undefined => latest?.projection.root?.children.find((node) => node.name === name)?.path;
			const selectedName = (): string | undefined => latest?.projection.root?.children.find((node) => node.path === latest?.projection.selectedPath)?.name;
			const codeDocument = await document.getCodeDocument();
			const originalUserCode = codeDocument.getText();
			const button2Path = componentPath("Button2");
			assert.ok(button2Path);
			const originalButton2 = resolvePropertyXmlElement(codeDocuments.getProperty(codeDocument)!.document!, button2Path);
			assert.ok(originalButton2);
			const widthValue = (): string | undefined => {
				const xml = codeDocuments.getProperty(codeDocument)?.document;
				const xmlPath = componentPath("Button1");
				const element = xml === undefined || xmlPath === undefined ? undefined : resolvePropertyXmlElement(xml, xmlPath);
				return element === undefined ? undefined : getPropertyXmlChildren(element, "赋值")
					.filter((child) => getPropertyXmlAttribute(child, "属性") === "宽度")
					.map((child) => getPropertyXmlAttribute(child, "值"))[0];
			};
			for (const [index, blurFirst, targets] of [[1, false, ["Button2"]], [2, true, ["Button2"]], [3, false, ["Button2", "Button3"]]] as const) {
				await panel.webview.postMessage({ type: "testPropertySelection", targets: ["Button1"] });
				await waitForSelectionEdit(() => selectedName() === "Button1", "选择编辑源组件");
				const value = String(120 + index);
				const previousMessages = messages.length;
				await panel.webview.postMessage({ type: "testPropertySelection", value, blurFirst, targets });
				try {
					await waitForSelectionEdit(() => widthValue() === value && selectedName() === targets.at(-1), `顺序 ${index} 提交属性并保留点击目标`);
				} catch (error) {
					throw new Error(`顺序 ${index}：当前宽度 ${widthValue()}，当前选择 ${selectedName()}，消息 ${messages.slice(previousMessages).join(",")}`, { cause: error });
				}
				assert.equal(edits.length, index, "每次输入只能登记一次 XML 修改");
				assert.equal(messages.slice(previousMessages).filter((type) => type === "updateXmlValue").length, blurFirst ? 1 : 0);
				assert.deepEqual(resolvePropertyXmlElement(codeDocuments.getProperty(codeDocument)!.document!, button2Path), originalButton2);
				assert.equal(codeDocument.getText(), originalUserCode);
			}
			assert.equal(await fs.readFile(sourceFile, "utf8"), source, "未保存编辑不得提前写盘");
			await provider.saveCustomDocument(document, cancellation.token);
			const saved = await fs.readFile(sourceFile, "utf8");
			assert.ok(saved.startsWith(userCode));
			assert.match(saved, /宽度 = 123/u);
			await edits.at(-1)!.undo();
			assert.equal(widthValue(), "122");
			await edits.at(-1)!.redo();
			assert.equal(widthValue(), "123");
			assert.match(serializePropertyXml(codeDocuments.getProperty(codeDocument)!.document!), /未知属性/u);
		} finally {
			for (const subscription of subscriptions) subscription.dispose();
			panel.dispose(); document?.dispose(); provider.dispose(); codeDocuments.dispose(); cancellation.dispose();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
