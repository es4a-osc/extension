/*
在真实 Webview 中验证滚动容器的尺寸与内容溢出，保持空容器可操作和滚动方向可浏览。
xhwsd@qq.com 2026-10-8
*/

import { testSdkPath } from "../testFixtures";

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { createSimpleDesignerModel, type DesignerComponentNode } from "../../designerModel";
import { componentPresentation, containerStyle, designerLayoutClass, findDesignerComponentNode } from "../../designer/designerView";
import { parseSimplePropertyXml } from "../../propertyXml";
import { loadSdk } from "../../sdk";
import { simpleTestUnitPath } from "../testProjects";

suite("嵌套空容器尺寸投影", () => {
	test("真实水平滚动框保留最小交互高度，固定高度仍严格保持", async function () {
		this.timeout(15000);
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension);
		const sdk = await loadSdk(testSdkPath());
		const sourcePath = await simpleTestUnitPath("SmokeTests", "测试水平滚动框");
		const source = await fs.readFile(sourcePath, "utf8");
		const document = parseSimplePropertyXml(source);
		assert.ok(document);
		const root = createSimpleDesignerModel(document, sdk).root;
		assert.ok(root);
		const scroll = root.children.find((node) => node.name === "水平滚动框1");
		assert.ok(scroll);
		const sampleChild = scroll.children.find((node) => node.name === "面板2");
		assert.ok(sampleChild);
		/* 保留当前真实样例的布局和尺寸，仅在测试投影中清空内容，避免依赖用户编辑状态。 */
		const child = { ...sampleChild, children: [] };
		assert.ok(findDesignerComponentNode(root, child.path));
		const css = await fs.readFile(path.join(extension.extensionPath, "dist", "designer", "designer.css"), "utf8");
		const panel = vscode.window.createWebviewPanel("es4a.containerSizeTest", "容器尺寸回归",
			vscode.ViewColumn.Active, { enableScripts: true });
		try {
			for (const height of [undefined, 3]) {
				const emptyScroll = { ...scroll, children: [child] };
				const node = height === undefined ? emptyScroll : { ...emptyScroll, height: { kind: "fixed" as const, value: height } };
				const outer = componentPresentation(node, undefined, "container");
				const inner = componentPresentation(child, undefined, "container");
				/* 保持 DesignerNode 的三层真实结构，使用构建 CSS 和模型样式测量，不模拟布局算法。 */
				const measured = new Promise<{ height: number; childHeight: number }>((resolve, reject) => {
					const timeout = setTimeout(() => {
						listener.dispose();
						reject(new Error("Webview 容器尺寸测量超时"));
					}, 10000);
					const listener = panel.webview.onDidReceiveMessage((message: unknown) => {
						if (typeof message !== "object" || message === null
							|| !("height" in message) || typeof message.height !== "number"
							|| !("childHeight" in message) || typeof message.childHeight !== "number") return;
						clearTimeout(timeout);
						listener.dispose();
						resolve({ height: message.height, childHeight: message.childHeight });
					});
				});
				panel.webview.html = `<!doctype html><html><head><style>${css}</style></head><body>
					<div style="width:480px;height:800px" class="layout-linear-vertical">
						<div id="scroll" class="${outer.classes.join(" ")}"><div class="container-content">
							<div id="surface" class="container-layout-surface ${designerLayoutClass(node)}">
								<div id="child" class="${inner.classes.join(" ")}"><div class="container-content">
									<div id="inner" class="container-layout-surface ${designerLayoutClass(child)}"></div>
								</div></div>
							</div>
						</div></div>
					</div><script>
					const api = acquireVsCodeApi();
					const styles = ${JSON.stringify({ scroll: outer.style, surface: containerStyle(node), child: inner.style, inner: containerStyle(child) })};
					for (const [id, style] of Object.entries(styles)) for (const [key, value] of Object.entries(style)) {
						document.getElementById(id).style.setProperty(key.startsWith('--') ? key : key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()), value);
					}
					requestAnimationFrame(() => requestAnimationFrame(() => api.postMessage({
						height: document.getElementById('scroll').getBoundingClientRect().height,
						childHeight: document.getElementById('child').getBoundingClientRect().height
					})));
					</script></body></html>`;
				const result = await measured;
				if (height === undefined) {
					assert.ok(result.height >= 32, `滚动框实际高度为 ${result.height}`);
					assert.ok(result.childHeight > 0, "内部空面板应具有可选外框");
				} else {
					assert.ok(Math.abs(result.height - height) < 0.5, `固定高度被放大为 ${result.height}`);
				}
			}
			assert.equal(await fs.readFile(sourcePath, "utf8"), source);
		} finally {
			panel.dispose();
		}
	});
});


suite("滚动容器内容范围", () => {
	test("固定与匹配父级的容器只在滚动方向放开适应内容尺寸", async function () {
		this.timeout(30000);
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension);
		const sdk = await loadSdk(testSdkPath());
		const css = await fs.readFile(path.join(extension.extensionPath, "dist", "designer", "designer.css"), "utf8");
		const panel = vscode.window.createWebviewPanel("es4a.scrollExtentTest", "滚动范围回归",
			vscode.ViewColumn.Active, { enableScripts: true });
		try {
			for (const direction of ["horizontal", "vertical"] as const) {
				const name = direction === "horizontal" ? "水平" : "垂直";
				const sourcePath = await simpleTestUnitPath("SmokeTests", `测试${name}滚动框`);
				const source = await fs.readFile(sourcePath, "utf8");
				const document = parseSimplePropertyXml(source);
				assert.ok(document);
				const sample = createSimpleDesignerModel(document, sdk).root?.children.find(node => node.name === `${name}滚动框1`);
				assert.ok(sample);
				const sampleChild = sample.children.find(node => node.name === "面板2");
				assert.ok(sampleChild);
				for (const size of ["fixed", "parent"] as const) for (const enabled of [false, true]) {
					// 仅调整内存投影，复用真实滚动框、面板及生产 DOM 层次，不改写样例 XML。
					const node: DesignerComponentNode = {
						...sample,
						scroll: enabled ? direction : undefined,
						width: size === "fixed" ? { kind: "fixed", value: 240 } : { kind: "parent" },
						height: size === "fixed" ? { kind: "fixed", value: 160 } : { kind: "parent" }
					};
					const child: DesignerComponentNode = { ...sampleChild, width: { kind: "content" }, height: { kind: "content" } };
					const outer = componentPresentation(node, undefined, "container");
					const inner = componentPresentation(child, undefined, "container");
					const measured = new Promise<{ offset: number; delta: number; extent: number; viewport: number; content: number; crossContent: number; crossViewport: number }>((resolve, reject) => {
						const timer = setTimeout(() => { listener.dispose(); reject(new Error("滚动范围测量超时")); }, 10000);
						const listener = panel.webview.onDidReceiveMessage(message => { clearTimeout(timer); listener.dispose(); resolve(message); });
					});
					panel.webview.html = `<!doctype html><html><head><style>${css}</style></head><body>
						<div style="width:320px;height:220px" class="layout-frame">
							<div id="scroll" class="${outer.classes.join(" ")}"><div class="container-content">
								<div id="surface" class="container-layout-surface ${designerLayoutClass(node)}">
									<div id="child" class="${inner.classes.join(" ")}"><div class="container-content">
										<div id="inner" class="container-layout-surface ${designerLayoutClass(child)}">
											<div style="width:900px;height:900px;flex:none">超出视口的内容</div>
										</div>
									</div></div>
								</div>
							</div></div>
						</div><script>
						const api = acquireVsCodeApi();
						const styles = ${JSON.stringify({ scroll: outer.style, surface: containerStyle(node), child: inner.style, inner: containerStyle(child) })};
						for (const [id, style] of Object.entries(styles)) for (const [key, value] of Object.entries(style)) {
							document.getElementById(id).style.setProperty(key.startsWith('--') ? key : key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()), value);
						}
						requestAnimationFrame(() => requestAnimationFrame(() => {
							const surface = document.getElementById('surface');
							const child = document.getElementById('child');
							const horizontal = ${direction === "horizontal"};
							const before = child.getBoundingClientRect();
							if (horizontal) surface.scrollLeft = surface.scrollWidth;
							else surface.scrollTop = surface.scrollHeight;
							const after = child.getBoundingClientRect();
							api.postMessage({
								offset: horizontal ? surface.scrollLeft : surface.scrollTop,
								delta: horizontal ? before.left - after.left : before.top - after.top,
								extent: horizontal ? surface.scrollWidth : surface.scrollHeight,
								viewport: horizontal ? surface.clientWidth : surface.clientHeight,
								content: horizontal ? after.width : after.height,
								crossContent: horizontal ? after.height : after.width,
								crossViewport: horizontal ? surface.clientHeight : surface.clientWidth
							});
						}));
						</script></body></html>`;
					const result = await measured;
					const description = `${direction}/${size}/${enabled}`;
					assert.ok(result.viewport > 0, description);
					assert.ok(result.crossContent <= result.crossViewport + 1, `非滚动方向仍应受视口约束：${description}`);
					if (enabled) {
						assert.ok(result.extent > result.viewport + 100, `内容应超出视口：${description}`);
						assert.ok(result.offset > 100, `滚动方向应可浏览内容：${description}`);
						assert.ok(Math.abs(result.delta - result.offset) < 1, `内容矩形应跟随滚动：${description}`);
					} else {
						assert.ok(result.content <= result.viewport + 1, `普通容器仍应限制适应内容尺寸：${description}`);
					}
				}
				assert.equal(await fs.readFile(sourcePath, "utf8"), source);
			}
		} finally {
			panel.dispose();
		}
	});
});
