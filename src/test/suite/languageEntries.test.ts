/*
验证原生文件及既有代码入口的清单提示、项目语义和属性区边界，并核对真实编辑器交互。
xhwsd@qq.com 2026-11-4
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { loadConfiguredSdk } from "../../main";
import { toSimpleCodeUri, toSimpleSourceUri } from "../../simpleCodeFileSystem";
import { toUnitContentPreviewUri, toUnitPreviewSourceUri } from "../../unitPreview";
import { testExtensionId, testSdkPath } from "../testFixtures";
import { WorkbenchDriver } from "./workbenchDriver";

const userCode = [
	"''' 当前源码的计算说明。",
	"函数 本地计算(输入 为 整数型) 为 整数型",
	"\t本地计算 = 输入",
	"结束 函数",
	"变量 目标 为 提示对象",
	"变量 控件 为 按钮",
	"过程 运行()",
	"\t如果 真 则",
	"\t\t目标.求和(1, 2)",
	'\t\t目标.标题 = "文本"',
	'\t\t控件.文本 = "按钮"',
	"\t\tSDK甲函数()",
	"\t\t本地计算(1)",
	"\t结束 如果",
	"结束 过程",
	"事件 目标.完成(结果 为 整数型)",
	"结束 事件",
	""
].join("\r\n");
/** 按 Parser.parseExpression 核对编辑器候选，不把合法运算符缩减为三个连接词。 */
const binaryOperators = ["且", "或", "异或", "是", "非", "匹配", "=", "<>", "<", "<=", ">", ">=", "<<", ">>", "&", "+", "-", "%", "\\", "*", "/", "^"];
const operators = (...delimiters: string[]) => new Set([...binaryOperators, ...delimiters]);
const typeCheckOperators = new Set(["是", "<<", ">>", "&", "+", "-", "%", "\\", "*", "/", "^"]);

const propertySource = "$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n";

/** 在唯一匹配的片段中定位请求，避免对行号或缩进作额外假设。 */
function position(document: vscode.TextDocument, text: string, delta = text.length): vscode.Position {
	const offset = document.getText().indexOf(text);
	assert.notEqual(offset, -1, `文档缺少测试片段：${text}`);
	return document.positionAt(offset + delta);
}

/** 等待工作台真正移动光标后再发送原生按键，避免两个通道的时序差异。 */
async function selectCursor(editor: vscode.TextEditor, cursor: vscode.Position): Promise<void> {
	if (editor.selection.isEmpty && editor.selection.active.isEqual(cursor)) return;
	await new Promise<void>((resolve, reject) => {
		const listener = vscode.window.onDidChangeTextEditorSelection((event) => {
			if (event.textEditor === editor && event.selections.length === 1 && event.selections[0]?.active.isEqual(cursor)) {
				clearTimeout(timer); listener.dispose(); resolve();
			}
		});
		const timer = setTimeout(() => { listener.dispose(); reject(new Error("测试光标移动超时")); }, 5000);
		editor.selection = new vscode.Selection(cursor, cursor);
	});
}

/** 始终通过实际注册的 Provider 查询，覆盖文档选择器和内部处理。 */
async function completions(document: vscode.TextDocument, text: string): Promise<readonly string[]> {
	const result = await vscode.commands.executeCommand<vscode.CompletionList | undefined>(
		"vscode.executeCompletionItemProvider", document.uri, position(document, text)
	);
	/* 只读预览还可能收到内置词语建议；这里只核对 ES4A 的有类型补全。 */
	return result?.items.filter((item) => item.kind !== vscode.CompletionItemKind.Text)
		.map((item) => typeof item.label === "string" ? item.label : item.label.label) ?? [];
}

/** 合并悬停内容以核对实际声明和说明，不依赖 Markdown 的显示排版。 */
async function hover(document: vscode.TextDocument, text: string, delta = 0): Promise<string> {
	const result = await vscode.commands.executeCommand<readonly vscode.Hover[] | undefined>(
		"vscode.executeHoverProvider", document.uri, position(document, text, delta)
	);
	return (result ?? []).flatMap((item) => item.contents.map((content) => (
		typeof content === "string" ? content : content.value
	))).join("\n");
}

/** 读取当前调用位置的参数提示。 */
async function signatures(document: vscode.TextDocument, text: string): Promise<vscode.SignatureHelp | undefined> {
	return vscode.commands.executeCommand<vscode.SignatureHelp>(
		"vscode.executeSignatureHelpProvider", document.uri, position(document, text)
	);
}

/** 创建独立清单版本，验证隐藏分类也参与语言提示，并可刷新和移除旧定义。 */
async function createSdk(directory: string, version: "甲" | "乙"): Promise<void> {
	await fs.cp(testSdkPath(), directory, { recursive: true });
	const libraryDirectory = path.join(directory, "libraries", "simple.test.language");
	await fs.mkdir(libraryDirectory, { recursive: true });
	await fs.writeFile(path.join(libraryDirectory, "library.json"), JSON.stringify({
		name: "入口提示测试库", version: "0.1.0", kind: "library",
		categories: [{ name: "提示对象", hidden: true, definitions: [{
			name: "提示对象", type: "simple.test.提示对象", kind: "object",
			description: `${version}版对象说明。`,
			properties: [
				{ name: "标题", type: "文本型", description: `${version}版标题说明。` },
				{ name: "只读值", type: "整数型", writable: false },
				{ name: "只写值", type: "整数型", readable: false },
				{ name: "类型检验", type: "整数型", description: "清单中的真实属性。" }
			],
			functions: [
				{ name: "求和", return: "整数型", description: `${version}版求和说明。`, params: [
					{ name: "左值", type: "整数型" }, { name: "右值", type: "整数型" }
				] },
				{ name: "清理" },
				{ name: `SDK${version}函数`, global: true, description: `${version}版全局函数说明。` }
			],
			events: [{ name: "完成", description: `${version}版完成事件说明。`, params: [{ name: "结果", type: "整数型" }] }]
		}] }]
	}));
}

/** 关闭临时文档并丢弃未保存修改，不触碰用户项目或其它标签。 */
async function closeTemporaryDocuments(directory: string): Promise<void> {
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of [...group.tabs]) {
			if (!(tab.input instanceof vscode.TabInputText)) {
				continue;
			}
			const uri = tab.input.uri;
			const source = toSimpleSourceUri(uri) ?? toUnitPreviewSourceUri(uri);
			if (source?.fsPath.startsWith(directory + path.sep) !== true) {
				continue;
			}
			await vscode.window.showTextDocument(uri, { viewColumn: group.viewColumn, preview: false });
			await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
		}
	}
}

suite("Simple 不同代码入口的语言提示", () => {
	let directory: string;
	let sdkA: string;
	let sdkB: string;
	let previousSdk: string | undefined;
	let driver: WorkbenchDriver;

	/** 配置和刷新都走产品入口，确保所有 Provider 使用同一 SDK 版本。 */
	async function selectSdk(sdk: string | undefined): Promise<void> {
		await vscode.workspace.getConfiguration("es4a").update("sdk.path", sdk, vscode.ConfigurationTarget.Global);
		await vscode.commands.executeCommand("es4a.refreshLibraries");
	}

	/** 每个用例使用独立文件，只有明确需要项目语义时才添加项目。 */
	async function withSource(action: (file: string, project: string) => Promise<void>): Promise<void> {
		const root = await fs.mkdtemp(path.join(directory, "source-"));
		const file = path.join(root, "src", "入口.simple");
		const project = path.join(root, "project.properties");
		try {
			await fs.mkdir(path.dirname(file));
			await fs.writeFile(file, userCode + propertySource);
			await fs.writeFile(project, "source=./src\r\nmain=入口\r\n");
			await action(file, project);
		} finally {
			await closeTemporaryDocuments(root);
			await vscode.commands.executeCommand("es4a.internal.removeProject", project);
			await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	}

	suiteSetup(async () => {
		const extension = vscode.extensions.getExtension(testExtensionId());
		assert.ok(extension);
		assert.equal(path.resolve(extension.extensionPath).toLowerCase(), path.resolve(__dirname, "../../..").toLowerCase());
		assert.deepEqual(vscode.extensions.all.filter((value) => value.packageJSON.name === "es4a" || value.packageJSON.displayName === "ES4A")
			.map((value) => value.id), [extension.id]);
		console.log(`语言入口测试加载开发扩展：${extension.extensionPath}`);
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-language-entries-"));
		sdkA = path.join(directory, "sdk-a");
		sdkB = path.join(directory, "sdk-b");
		await createSdk(sdkA, "甲");
		await createSdk(sdkB, "乙");
		previousSdk = vscode.workspace.getConfiguration("es4a").inspect<string>("sdk.path")?.globalValue;
		await extension.activate();
		driver = await WorkbenchDriver.connect();
	});

	setup(async () => selectSdk(sdkA));

	suiteTeardown(async () => {
		driver?.dispose();
		await selectSdk(previousSdk);
		await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	for (const entry of ["原生文件", "ES4A 代码标签", "未保存文档"] as const) {
		test(`${entry}提供清单关键字、类型、继承成员和事件提示`, async () => {
			await withSource(async (file) => {
				const document = entry === "未保存文档"
					? await vscode.workspace.openTextDocument({ language: "simple", content: userCode })
					: await vscode.workspace.openTextDocument(entry === "原生文件" ? vscode.Uri.file(file) : toSimpleCodeUri(vscode.Uri.file(file)));
				try {
					assert.match(await hover(document, "如果"), /条件判断/u);
					assert.match(await hover(document, "整数型"), /整数型/u);
					assert.match(await hover(document, "提示对象"), /甲版对象说明/u);
					assert.match(await hover(document, "目标.标题", 3), /甲版标题说明/u);
					assert.match(await hover(document, "目标.求和", 3), /甲版求和说明/u);
					assert.match(await hover(document, "目标.完成", 3), /甲版完成事件说明/u);
					assert.match(await hover(document, "控件.文本", 3), /文本/u);
					assert.ok((await completions(document, "目标.标")).includes("标题"));
					assert.ok((await completions(document, "控件.文")).includes("文本"));
					assert.ok((await completions(document, "事件 目标.完")).includes("完成"));
					const typeLabels = await completions(document, "变量 目标 为 提");
					assert.ok(typeLabels.includes("提示对象"));
					assert.equal(typeLabels.includes("SDK甲函数"), false);
					const help = await signatures(document, "目标.求和(1,");
					assert.equal(help?.activeParameter, 1);
					assert.match(help?.signatures[0]?.label ?? "", /求和\(左值 为 整数型, 右值 为 整数型\)/u);
					assert.ok((await completions(document, "\t\t本地计")).includes("本地计算"));
					const local = await hover(document, "本地计算(1)");
					/* 未保存文档还没有真实单元文件，只核对不会虚构项目归属。 */
					if (entry !== "未保存文档") {
						assert.match(local, /所属单元：/u);
					}
					assert.doesNotMatch(local, /所属项目：/u);
				} finally {
					if (entry === "未保存文档") {
						await vscode.window.showTextDocument(document);
						await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
					}
				}
			});
		});
	}

	test("配置变化和同路径刷新同步所有入口，不残留上一版清单", async () => {
		await withSource(async (file) => {
			const untitled = await vscode.workspace.openTextDocument({ language: "simple", content: userCode });
			const documents = [
				await vscode.workspace.openTextDocument(vscode.Uri.file(file)),
				await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(file))),
				await vscode.workspace.openTextDocument(toUnitContentPreviewUri(vscode.Uri.file(file))),
				untitled
			];
			const manifest = path.join(sdkB, "libraries", "simple.test.language", "library.json");
			const original = await fs.readFile(manifest, "utf8");
			try {
				/* 不调用刷新命令，先验证配置监听本身会更新语言服务。 */
				await vscode.workspace.getConfiguration("es4a").update("sdk.path", sdkB, vscode.ConfigurationTarget.Global);
				let current = "";
				for (let attempt = 0; attempt < 100; attempt += 1) {
					current = await hover(documents[0]!, "目标.求和", 3);
					if (current.includes("乙版求和说明")) {
						break;
					}
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
				assert.match(current, /乙版求和说明/u);
				for (const document of documents) {
					assert.match(await hover(document, "目标.求和", 3), /乙版求和说明/u);
					assert.doesNotMatch(await hover(document, "目标.求和", 3), /甲版/u);
				}

				await fs.writeFile(manifest, original.replaceAll("乙", "丙"));
				await vscode.commands.executeCommand("es4a.refreshLibraries");
				for (const document of documents) {
					assert.match(await hover(document, "目标.求和", 3), /丙版求和说明/u);
				}
				await selectSdk(undefined);
				for (const document of documents) {
					assert.equal(await hover(document, "目标.求和", 3), "");
					assert.match(await hover(document, "本地计算(1)"), /当前源码的计算说明/u);
					if (document !== documents[2]) {
						assert.ok((await completions(document, "\t\t本地计")).includes("本地计算"));
						assert.equal((await completions(document, "SDK甲")).includes("SDK甲函数"), false);
					}
				}
			} finally {
				await fs.writeFile(manifest, original);
				await vscode.window.showTextDocument(untitled);
				await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
			}
		});
	});

	test("普通文件按成员归属、作用域和忽略区筛选，不用全库候选兜底", async () => {
		await withSource(async (file) => {
			await fs.writeFile(file, userCode + "过程 边界()\r\n变量 私有值 为 整数型\r\n结束 过程\r\n过程 外部()\r\n私有\r\n目标.完\r\n未知对象.标\r\n' 目标.标\r\n变量 文本值 为 文本型 = \"目标.标\"\r\n结束 过程\r\n" + propertySource);
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
			assert.equal((await completions(document, "\r\n私有")).includes("私有值"), false);
			assert.equal((await completions(document, "\r\n目标.完")).includes("SDK甲函数"), false);
			assert.deepEqual(await completions(document, "未知对象.标"), []);
			assert.deepEqual(await completions(document, "' 目标.标"), []);
			assert.deepEqual(await completions(document, '"目标.标'), []);
			assert.equal(await hover(document, "未知对象.标", 5), "");
		});
	});

	test("独立单元的变量、参数、返回值、事件和组件只显示单元归属，添加项目后显示真实归属", async () => {
		await withSource(async (file, project) => {
			const target = path.join(path.dirname(file), "示例", "手势窗口.simple");
			const code = [
				"常量 上限 为 整数型 = 10",
				"变量 待完成编号 为 整数型",
				"函数 查找演示节点(文本 为 文本型) 为 文本型",
				"\t变量 局部值 为 整数型",
				"\t查找演示节点 = 文本",
				"结束 函数",
				"事件 手势窗口.按下某键(键码 为 整数型, 传址 消费 为 逻辑型)",
				"\t待完成编号 = 键码",
				"\t待完成编号 = 上限",
				"\t消费 = 真",
				'\t状态.文本 = "内容"',
				"结束 事件",
				""
			].join("\r\n");
			const properties = "$属性\r\n\t$资源 $窗口\r\n\t$定义 手势窗口 $为 窗口\r\n\t\t$定义 状态 $为 标签\r\n\t\t$结束 $定义\r\n\t$结束 $定义\r\n$结束 $属性\r\n";
			await fs.mkdir(path.dirname(target));
			await fs.writeFile(target, code + properties);
			await fs.writeFile(project, "source=./src\r\nmain=示例.手势窗口\r\nname=实际项目\r\n");
			const documents = [
				await vscode.workspace.openTextDocument(vscode.Uri.file(target)),
				await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(target))),
				await vscode.workspace.openTextDocument(toUnitContentPreviewUri(vscode.Uri.file(target)))
			];
			const cases: readonly [string, number][] = [
				["常量 上限", 3], ["待完成编号 = 上限", 8],
				["变量 待完成编号", 3], ["待完成编号 = 键码", 0],
				["函数 查找演示节点", 3], ["查找演示节点 = 文本", 0],
				["文本 为 文本型", 0], ["查找演示节点 = 文本", 9],
				["变量 局部值", 3], ["键码 为 整数型", 0], ["待完成编号 = 键码", 8],
				["传址 消费", 3], ["\t消费 = 真", 1],
				["事件 手势窗口.按下某键", 8], ["状态.文本", 0]
			];
			for (const document of documents) {
				for (const [text, delta] of cases) {
					const contents = await hover(document, text, delta);
					assert.match(contents, /所属单元：手势窗口/u, `${document.uri.scheme}：${text}`);
					assert.doesNotMatch(contents, /所属项目：/u);
				}
				/* SDK 类型与继承成员仍显示自己的库和类，不受独立单元标记影响。 */
				const library = await hover(document, "状态.文本", 3);
				assert.match(library, /所属库：运行库/u);
				assert.match(library, /所属类：simple\.runtime\.components\.文本组件/u);
			}

			await vscode.commands.executeCommand("es4a.internal.addProject", project);
			let contents = "";
			for (let attempt = 0; attempt < 100; attempt += 1) {
				contents = await hover(documents[0]!, "变量 待完成编号", 3);
				if (contents.includes("所属项目：实际项目")) {
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			assert.match(contents, /所属项目：实际项目/u);
			for (const document of documents) {
				for (const [text, delta] of cases) {
					const contents = await hover(document, text, delta);
					assert.match(contents, /所属项目：实际项目/u);
					assert.match(contents, /所属单元：示例\.手势窗口/u);
				}
			}

			/* 移除项目后应重新显示独立单元，不能残留先前项目及完整限定名。 */
			await vscode.commands.executeCommand("es4a.internal.removeProject", project);
			for (let attempt = 0; attempt < 100; attempt += 1) {
				contents = await hover(documents[0]!, "变量 待完成编号", 3);
				if (!contents.includes("所属项目：")) {
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			for (const document of documents) {
				const contents = await hover(document, "变量 待完成编号", 3);
				assert.match(contents, /所属单元：手势窗口/u);
				assert.doesNotMatch(contents, /所属项目：|示例\.手势窗口/u);
			}
			assert.equal(await fs.readFile(target, "utf8"), code + properties);
		});
	});

	test("独立对象的项目与类库混合重载分别保留单元和库的真实归属", async () => {
		await withSource(async (file) => {
			const source = "函数 求和(值 为 整数型) 为 整数型\r\n求和 = 值\r\n结束 函数\r\n过程 运行()\r\n求和(1, 2, 3)\r\n结束 过程\r\n$属性\r\n$资源 $对象\r\n基础对象 = simple.test.提示对象\r\n$结束 $属性\r\n";
			await fs.writeFile(file, source);
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
			const contents = await hover(document, "求和(1, 2, 3)");
			assert.match(contents, /值 为 整数型/u);
			assert.match(contents, /左值 为 整数型, 右值 为 整数型/u);
			assert.match(contents, /所属单元：入口/u);
			assert.match(contents, /所属库：入口提示测试库/u);
			assert.match(contents, /所属类：simple\.test\.提示对象/u);
			assert.doesNotMatch(contents, /所属项目：/u);
		});
	});

	test("无 SDK 和失效 SDK 保留当前源码提示，刷新切换后清除旧清单结果", async () => {
		await withSource(async (file) => {
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
			assert.ok((await completions(document, "SDK甲")).includes("SDK甲函数"));
			for (const sdk of [undefined, path.join(directory, "missing-sdk")]) {
				await selectSdk(sdk);
				assert.equal(await loadConfiguredSdk().catch(() => undefined), undefined);
				assert.equal((await completions(document, "SDK甲")).includes("SDK甲函数"), false);
				assert.equal(await hover(document, "目标.求和", 3), "");
				assert.equal((await signatures(document, "目标.求和("))?.signatures.length ?? 0, 0);
				assert.ok((await completions(document, "\t\t本地计")).includes("本地计算"));
				assert.match(await hover(document, "本地计算(1)"), /当前源码的计算说明/u);
				assert.match((await signatures(document, "\t\t本地计算("))?.signatures[0]?.label ?? "", /输入 为 整数型/u);
			}

			await selectSdk(sdkB);
			assert.equal((await completions(document, "SDK甲")).includes("SDK甲函数"), false);
			assert.match(await hover(document, "目标.求和", 3), /乙版求和说明/u);
			const editor = await vscode.window.showTextDocument(document);
			assert.equal(await editor.edit((edit) => edit.replace(new vscode.Range(position(document, "SDK甲", 0), position(document, "SDK甲")), "SDK乙")), true);
			assert.ok((await completions(document, "SDK乙")).includes("SDK乙函数"));
			const content = document.getText();
			await fs.writeFile(path.join(sdkB, "libraries", "simple.test.language", "library.json"), "{}");
			await vscode.commands.executeCommand("es4a.refreshLibraries");
			assert.equal((await completions(document, "SDK乙")).includes("SDK乙函数"), false);
			assert.equal(await hover(document, "目标.求和", 3), "");
			assert.equal(document.getText(), content);
		});
	});

	test("属性区不提供代码补全或参数提示，完整预览保持只读悬停", async () => {
		await withSource(async (file) => {
			const properties = "$属性\r\n\t$资源 $对象\r\n\t\t基础对象 = 目标.求和(1, 2)\r\n\t\t实现接口 = SDK甲\r\n$结束 $属性\r\n";
			await fs.writeFile(file, userCode + properties);
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
			assert.deepEqual(await completions(document, "实现接口 = SDK甲"), []);
			assert.equal((await signatures(document, "基础对象 = 目标.求和("))?.signatures.length ?? 0, 0);
			assert.match(await hover(document, "$属性", 1), /属性/u);
			assert.equal(await fs.readFile(file, "utf8"), userCode + properties);

			const preview = await vscode.workspace.openTextDocument(toUnitContentPreviewUri(vscode.Uri.file(file)));
			assert.equal(vscode.workspace.fs.isWritableFileSystem(preview.uri.scheme), undefined);
			assert.match(await hover(preview, "目标.求和", 3), /甲版求和说明/u);
			assert.match(await hover(preview, "$属性", 1), /属性/u);
			assert.deepEqual(await completions(preview, "SDK甲"), []);
			assert.equal((await signatures(preview, "目标.求和("))?.signatures.length ?? 0, 0);
		});
	});

	test("原生窗口从现有属性模型识别组件及继承成员", async () => {
		await withSource(async (file) => {
			const code = "过程 运行()\r\n按钮1.文本 = \"内容\"\r\n结束 过程\r\n事件 按钮1.被单击()\r\n结束 事件\r\n";
			const properties = "$属性\r\n\t$资源 $窗口\r\n\t$定义 入口 $为 窗口\r\n\t\t$定义 按钮1 $为 按钮\r\n\t\t\t文本 = \"按钮\"\r\n\t\t$结束 $定义\r\n\t$结束 $定义\r\n$结束 $属性\r\n";
			await fs.writeFile(file, code + properties);
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
			assert.ok((await completions(document, "按钮1.文")).includes("文本"));
			assert.match(await hover(document, "按钮1.文本", 4), /文本组件/u);
			assert.ok((await completions(document, "事件 按钮1.被单")).includes("被单击"));
			assert.match(await hover(document, "按钮1.被单击", 4), /被单击/u);
			assert.equal(document.isDirty, false);
			assert.equal(await fs.readFile(file, "utf8"), code + properties);
		});
	});

	test("已识别项目读取其它单元及未保存声明，原生入口不扩大重命名和引用范围", async () => {
		await withSource(async (file, project) => {
			await vscode.commands.executeCommand("workbench.view.explorer");
			const target = path.join(path.dirname(file), "数据对象.simple");
			await fs.writeFile(target, "函数 项目计算(旧参数 为 整数型) 为 整数型\r\n项目计算 = 旧参数\r\n结束 函数\r\n" + propertySource);
			await fs.writeFile(file, "变量 数据 为 数据对象\r\n过程 运行()\r\n数据.项目计算(1)\r\n结束 过程\r\n" + propertySource);
			await vscode.commands.executeCommand("es4a.internal.addProject", project);
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
			let description = "";
			for (let attempt = 0; attempt < 100; attempt += 1) {
				description = await hover(document, "数据.项目计算", 3);
				if (description.includes("旧参数")) {
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			assert.match(description, /旧参数/u);
			assert.ok((await completions(document, "数据.项目计")).includes("项目计算"));
			const editor = await vscode.window.showTextDocument(vscode.Uri.file(target));
			const changed = editor.document.getText().replaceAll("旧参数", "新参数");
			assert.equal(await editor.edit((edit) => edit.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), changed)), true);
			assert.equal(editor.document.isDirty, true);
			for (const caller of [document, await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(file)))]) {
				assert.match(await hover(caller, "数据.项目计算", 3), /新参数/u);
				assert.doesNotMatch(await hover(caller, "数据.项目计算", 3), /旧参数/u);
				assert.match((await signatures(caller, "数据.项目计算("))?.signatures[0]?.label ?? "", /新参数 为 整数型/u);
			}
			assert.match(await fs.readFile(target, "utf8"), /旧参数/u);
			assert.equal((await vscode.commands.executeCommand<vscode.Location[] | undefined>("vscode.executeReferenceProvider", document.uri, position(document, "数据.项目计算", 3)))?.length ?? 0, 0);
			const edits = await vscode.commands.executeCommand<vscode.WorkspaceEdit | undefined>("vscode.executeDocumentRenameProvider", document.uri, position(document, "数据.项目计算", 3), "不应改名");
			assert.equal(edits?.size ?? 0, 0);
		});
	});

	test("ES4A 代码补全按光标前缀匹配并替换完整标识符，保留已有调用参数", async () => {
		await withSource(async (file) => {
			const code = [
				"变量 用户名称 为 文本型",
				"变量 用户年龄 为 整数型",
				"变量 实例 为 提示对象",
				"变量 限定类型 为 simple.runtime.文本操作",
				"变量 限定组件 为 simple.runtime.components.按钮",
				"别名 限定别名 = simple.runtime.components.按钮",
				"别名 紧凑别名=simple.runtime.文本操作",
				"变量 aaa 为 入口",
				"变量 bbb 为 入口",
				"变量 ccc 为 入口",
				"变量 ccc新 为 入口",
				"函数 求值旧(输入 为 整数型) 为 整数型",
				"\t求值旧 = 输入",
				"结束 函数",
				"",
				"函数 求值新(输入 为 整数型) 为 整数型",
				"\t求值新 = 输入",
				"结束 函数",
				"",
				"过程 运行(参数原值 为 文本型, 参数新值 为 文本型)",
				"\t变量 局部原值 为 文本型",
				"\t变量 局部新值 为 文本型",
				"\t变量 类型值 为 文本型",
				"\t用户名称 = 参数原值",
				"\t局部原值 = 用户名称",
				"\t按钮1.文本 = 0",
				"\t实例.求和(1, 2)",
				"\t实例.求和 \t(1, 2)",
				"\t实例.求和 _\r\n(1, 2)",
				'\tsimple.runtime.文本操作.分割文本("", "", 1)',
				"\taaa.bbb.ccc.dddd()",
				"\t求值旧(1)",
				"\t求值旧",
				"\tan旧字",
				"结束 过程",
				"事件 按钮1.被单击()",
				"结束 事件",
				""
			].join("\r\n");
			const properties = "$属性\r\n\t$资源 $窗口\r\n\t$定义 入口 $为 窗口\r\n\t\t$定义 按钮1 $为 按钮\r\n\t\t$结束 $定义\r\n\t\t$定义 按钮2 $为 按钮\r\n\t\t$结束 $定义\r\n\t$结束 $定义\r\n$结束 $属性\r\n";
			await fs.writeFile(file, code + properties);
			const document = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(file)));
			const cases: readonly [string, string, string, string][] = [
				["\t用户|名称 =", "用户年龄", "用户名称", "用户年龄"],
				["= 参数|原值", "参数新值", "参数原值", "参数新值"],
				["\t局部|原值 =", "局部新值", "局部原值", "局部新值"],
				["\t按钮|1.文本", "按钮2", "按钮1", "按钮2"],
				["按钮1.文|本 =", "文本颜色", "文本", "文本颜色"],
				["按钮1.|文本 =", "文本颜色", "文本", "文本颜色"],
				["类型值 为 文|本型", "文本型", "文本型", "文本型"],
				["实例.求|和(1, 2)", "求和", "求和", "求和"],
				["实例.求|和 \t(1, 2)", "求和", "求和", "求和"],
				["实例.求|和 _\r\n(1, 2)", "求和", "求和", "求和"],
				['simple.runtime.文本操作.分|割文本("", "", 1)', "分割文本", "分割文本", "分割文本"],
				['si|mple.runtime.文本操作.分割文本("", "", 1)', "simple", "simple", "simple"],
				['simple.runtime.文|本操作.分割文本("", "", 1)', "文本操作", "文本操作", "文本操作"],
				["限定类型 为 simple.runtime.文|本操作", "simple.runtime.文本操作", "simple.runtime.文本操作", "simple.runtime.文本操作"],
				["限定组件 为 si|mple.runtime.components.按钮", "simple", "simple", "simple"],
				["限定组件 为 simple.run|time.components.按钮", "runtime", "runtime", "runtime"],
				["限定组件 为 simple.|runtime.components.按钮", "runtime", "runtime", "runtime"],
				["限定别名 = simple.runtime.com|ponents.按钮", "components", "components", "components"],
				["紧凑别名=simple.runtime.文|本操作", "simple.runtime.文本操作", "simple.runtime.文本操作", "simple.runtime.文本操作"],
				["aaa.bbb.cc|c.dddd()", "ccc新", "ccc", "ccc新"],
				["\t求值|旧(1)", "求值新", "求值旧", "求值新"],
				["按钮1.被|单击()", "被单击", "被单击", "被单击"],
				["按钮1.文本| =", "文本颜色", "文本", "文本颜色"]
			];
			for (const [marked, name, previous, expected] of cases) {
				const marker = marked.indexOf("|");
				const fragment = marked.replace("|", "");
				const result = await vscode.commands.executeCommand<vscode.CompletionList>(
					"vscode.executeCompletionItemProvider", document.uri, position(document, fragment, marker)
				);
				const item = result.items.find((value) => (typeof value.label === "string" ? value.label : value.label.label) === name);
				assert.ok(item, `${marked} 缺少 ${name} 候选`);
				assert.ok(item.range instanceof vscode.Range);
				assert.equal(document.getText(item.range), previous, marked);
				assert.equal(item.insertText, expected, marked);
			}
			const members = await completions(document, "按钮1.");
			assert.ok(members.includes("文本"));
			assert.ok(members.includes("文本颜色"));
			assert.equal(members.includes("被单击"), false);
			const methods = await completions(document, "实例.");
			assert.ok(methods.includes("求和"));
			assert.equal(methods.includes("标题"), false);
			assert.equal(methods.includes("完成"), false);

			/* 缺少括号时仍插入参数片段；光标右侧已有调用时只替换名称。 */
			const result = await vscode.commands.executeCommand<vscode.CompletionList>(
				"vscode.executeCompletionItemProvider", document.uri, position(document, "\t求值旧\r\n", 3)
			);
			const item = result.items.find((value) => value.label === "求值新");
			assert.ok(item?.insertText instanceof vscode.SnippetString);
			assert.match(item.insertText.value, /^求值新\(/u);
			assert.equal(document.getText(item.range as vscode.Range), "求值旧");
			assert.equal(document.getText(), code);
			assert.equal(await fs.readFile(file, "utf8"), code + properties);
		});
	});

	for (const entry of ["ES4A 代码标签", "原生文件"] as const) {
		test(`${entry}名称内部主动补全按原文匹配，字符触发和词尾首拼保持原样`, async () => {
			await withSource(async (file) => {
				const code = [
					"变量 控件 为 按钮",
					"过程 运行()",
					'\t控件.文本 = ""',
					"\t控件.w旧字",
					"\t控件.文",
					"结束 过程",
					""
				].join("\r\n");
				await fs.writeFile(file, code + propertySource);
				const document = await vscode.workspace.openTextDocument(entry === "原生文件"
					? vscode.Uri.file(file) : toSimpleCodeUri(vscode.Uri.file(file)));
				const names = (result: vscode.CompletionList): string[] => result.items
					.map((item) => typeof item.label === "string" ? item.label : item.label.label);
				const middle = await vscode.commands.executeCommand<vscode.CompletionList>(
					"vscode.executeCompletionItemProvider", document.uri, position(document, "控件.文本", 4)
				);
				assert.deepEqual(names(middle), ["文本", "文本颜色"]);
				for (const item of middle.items) {
					assert.ok(item.range instanceof vscode.Range);
					assert.equal(document.getText(item.range), "文本");
				}

				/* 同样的名称内部，主动触发不借用首拼；输入字母触发仍使用原规则。 */
				const letterPosition = position(document, "控件.w旧字", 4);
				const invoked = await vscode.commands.executeCommand<vscode.CompletionList>(
					"vscode.executeCompletionItemProvider", document.uri, letterPosition
				);
				assert.deepEqual(names(invoked), []);
				const typed = await vscode.commands.executeCommand<vscode.CompletionList>(
					"vscode.executeCompletionItemProvider", document.uri, letterPosition, "w"
				);
				assert.ok(names(typed).includes("文本"));
				assert.ok(names(typed).includes("位于底边"));

				/* 光标在名称末尾的主动补全不属于本次修改范围。 */
				const ending = await vscode.commands.executeCommand<vscode.CompletionList>(
					"vscode.executeCompletionItemProvider", document.uri, position(document, "控件.文\r\n", 4)
				);
				assert.ok(names(ending).includes("文本"));
				assert.ok(names(ending).includes("位于底边"));
				assert.equal(document.getText(), entry === "原生文件" ? code + propertySource : code);
				assert.equal(await fs.readFile(file, "utf8"), code + propertySource);
			});
		});
	}

	for (const entry of ["ES4A 代码标签", "原生文件"] as const) {
		test(`${entry}按接收者、赋值、取值及事件位置筛选补全`, async () => {
			await withSource(async (file) => {
				const code = [
					"变量 接收对象 为 提示对象", "变量 普通数 为 整数型",
					"事件 完成事件(值 为 整数型)", "结束 事件", "",
					"事件 入口.初始化()",
					'\t按钮1.文本 = "111"',
					"\t接收对象.标题 = 接收对象.只读值",
					'\t输出信息("tag", 接收对象.标题)',
					"\t触发事件 完成事件(1)",
					"结束 事件", "",
					"事件 按钮1.被单击()", "结束 事件", ""
				].join("\r\n");
				const properties = "$属性\r\n\t$资源 $窗口\r\n\t$定义 入口 $为 窗口\r\n\t\t$定义 按钮1 $为 按钮\r\n\t\t$结束 $定义\r\n\t\t$定义 按钮2 $为 按钮\r\n\t\t$结束 $定义\r\n\t$结束 $定义\r\n$结束 $属性\r\n";
				await fs.writeFile(file, code + properties);
				const document = await vscode.workspace.openTextDocument(entry === "原生文件"
					? vscode.Uri.file(file) : toSimpleCodeUri(vscode.Uri.file(file)));
				const suggest = async (marked: string): Promise<readonly vscode.CompletionItem[]> => {
					const marker = marked.indexOf("|");
					return (await vscode.commands.executeCommand<vscode.CompletionList>(
						"vscode.executeCompletionItemProvider", document.uri, position(document, marked.replace("|", ""), marker)
					)).items;
				};
				const names = (items: readonly vscode.CompletionItem[]): string[] => items
					.map((item) => typeof item.label === "string" ? item.label : item.label.label);
				const receivers = await suggest("按|钮1.文本");
				assert.ok(names(receivers).includes("按钮1"));
				assert.ok(names(receivers).includes("按钮2"));
				assert.equal(receivers.some((item) => item.kind === vscode.CompletionItemKind.Event || item.kind === vscode.CompletionItemKind.Function), false);
				assert.equal(names(receivers).includes("按下某键"), false);

				const target = names(await suggest("接收对象.|标题 ="));
				assert.ok(target.includes("标题"));
				assert.ok(target.includes("只写值"));
				for (const name of ["只读值", "求和", "清理", "完成"]) assert.equal(target.includes(name), false, name);
				const values = names(await suggest('"tag", 接收对象.|标题'));
				assert.ok(values.includes("标题"));
				assert.ok(values.includes("只读值"));
				assert.ok(values.includes("求和"));
				for (const name of ["只写值", "清理", "完成"]) assert.equal(values.includes(name), false, name);

				const declaredEvents = await suggest("事件 按钮1.|被单击()");
				assert.ok(names(declaredEvents).includes("被单击"));
				assert.ok(declaredEvents.every((item) => item.kind === vscode.CompletionItemKind.Event));
				const raisedEvents = await suggest("触发事件 完|成事件(1)");
				assert.deepEqual(names(raisedEvents), ["完成事件"]);
				assert.ok(raisedEvents.every((item) => item.kind === vscode.CompletionItemKind.Event));
				assert.equal(await fs.readFile(file, "utf8"), code + properties);
			});
		});
	}

	test("真实 ES4A 代码标签主动补全替换变量、组件、成员及 R 资源完整名称", async () => {
		await withSource(async (file, project) => {
			const resourceDirectory = path.join(path.dirname(project), "res", "drawable");
			await fs.mkdir(resourceDirectory, { recursive: true });
			await fs.writeFile(path.join(resourceDirectory, "icon1.xml"), "<shape />");
			await fs.writeFile(path.join(resourceDirectory, "icon2.xml"), "<shape />");
			const code = "变量 限定组件 为 simple.run旧.components.按钮\r\n别名 限定别名 = simple.runtime.com旧.按钮\r\n"
				+ "变量 类型值 为 文旧型\r\n变量 数据数组旧 为 整数型()\r\n变量 数据数组新 为 整数型()\r\n"
				+ "变量 用户名称 为 文本型\r\n变量 用户年龄 为 文本型\r\n函数 求值旧(输入 为 整数型) 为 整数型\r\n求值旧 = 输入\r\n结束 函数\r\n\r\n函数 求值新(输入 为 整数型) 为 整数型\r\n求值新 = 输入\r\n结束 函数\r\n\r\n过程 运行()\r\n用户名称 = \"\"\r\n按钮1.文本 = 0\r\n求值旧 \t(1)\r\n数据数组旧(0) = 1\r\n变量 资源编号 为 整数型\r\n资源编号 = R.drawable_icon1\r\n结束 过程\r\n\r\n事件 按钮1.被单击()\r\n结束 事件\r\n";
			const properties = "$属性\r\n\t$资源 $窗口\r\n\t$定义 入口 $为 窗口\r\n\t\t$定义 按钮1 $为 按钮\r\n\t\t$结束 $定义\r\n\t\t$定义 按钮2 $为 按钮\r\n\t\t$结束 $定义\r\n\t$结束 $定义\r\n$结束 $属性\r\n";
			await fs.writeFile(file, code + properties);
			await vscode.commands.executeCommand("es4a.internal.addProject", project);
			const editor = await vscode.window.showTextDocument(toSimpleCodeUri(vscode.Uri.file(file)), { preview: false });
			assert.equal(editor.document.uri.scheme, "simple-code");
			for (let attempt = 0; attempt < 100; attempt += 1) {
				if ((await completions(editor.document, "R.drawable_icon")).includes("drawable_icon2")) {
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			const cases: readonly [string, number, string, string, string][] = [
				["\r\n用户名称 =", 4, "用户年龄", "\r\n用户名称 =", "\r\n用户年龄 ="],
				["按钮1.文本", 2, "按钮2", "按钮1.文本", "按钮2.文本"],
				["按钮1.文本", 5, "文本颜色", "按钮1.文本", "按钮1.文本颜色"],
				["求值旧 \t(1)", 2, "求值新", "求值旧 \t(1)", "求值新 \t(1)"],
				["类型值 为 文旧型", 7, "文本型", "类型值 为 文旧型", "类型值 为 文本型"],
				["按钮1.被单击()", 5, "被长按", "按钮1.被单击()", "按钮1.被长按()"],
				["数据数组旧(0)", 4, "数据数组新", "数据数组旧(0)", "数据数组新(0)"],
				["simple.run旧.components.按钮", 10, "runtime", "simple.run旧.components.按钮", "simple.runtime.components.按钮"],
				["simple.runtime.com旧.按钮", 18, "components", "simple.runtime.com旧.按钮", "simple.runtime.components.按钮"],
				["R.drawable_icon1", 15, "drawable_icon2", "R.drawable_icon1", "R.drawable_icon2"]
			];
			for (const [text, delta, name, previous, next] of cases) {
				const before = editor.document.getText();
				const cursor = position(editor.document, text, delta);
				editor.selection = new vscode.Selection(cursor, cursor);
				await vscode.commands.executeCommand("editor.action.triggerSuggest");
				await driver.waitFor(`Array.from(document.querySelectorAll('.suggest-widget.visible .label-name')).some(element => element.textContent === ${JSON.stringify(name)})`);
				if (text === "按钮1.文本" && delta === 2) {
					const visible = await driver.evaluate("Array.from(document.querySelectorAll('.suggest-widget.visible .label-name')).map(element => element.textContent)") as string[];
					assert.ok(visible.includes("按钮1") && visible.includes("按钮2"));
					assert.equal(visible.includes("按下某键"), false);
				}
				if (text === "按钮1.文本" && delta === 5) {
					assert.deepEqual(await driver.evaluate("Array.from(document.querySelectorAll('.suggest-widget.visible .label-name')).map(element => element.textContent)"), ["文本", "文本颜色"]);
				}
				await vscode.commands.executeCommand("selectFirstSuggestion");
				let selected = false;
				for (let attempt = 0; attempt < 40; attempt += 1) {
					selected = await driver.evaluate(`document.querySelector('.suggest-widget.visible .monaco-list-row.focused .label-name')?.textContent === ${JSON.stringify(name)}`) === true;
					if (selected) {
						break;
					}
					await vscode.commands.executeCommand("selectNextSuggestion");
				}
				assert.equal(selected, true, `未选中 ${name} 补全项`);
				await vscode.commands.executeCommand("acceptSelectedSuggestion");
				assert.equal(editor.document.getText(), before.replace(previous, next));
				await vscode.commands.executeCommand("undo");
				assert.equal(editor.document.getText(), before);
				await vscode.commands.executeCommand("redo");
				assert.equal(editor.document.getText(), before.replace(previous, next));
				await vscode.commands.executeCommand("undo");
				assert.equal(editor.document.getText(), before);
			}
			assert.equal(await fs.readFile(file, "utf8"), code + properties);
		});
	});

	for (const entry of ["ES4A 代码标签", "原生文件"] as const) {
		test(`${entry}保留源码属性读写限制并以标准类型和详情区分候选`, async () => {
			await withSource(async (file, project) => {
				const code = [
					"常量 补全常量 为 整数型 = 1", "变量 补全变量 为 整数型",
					"属性 补全只读 为 整数型", "获取", "补全只读 = 1", "结束 获取", "结束 属性",
					"属性 补全只写 为 整数型", "设置", "结束 设置", "结束 属性",
					"函数 补全函数() 为 整数型", "结束 函数", "过程 补全过程()", "结束 过程",
					"事件 补全事件()", "结束 事件", "过程 运行()", "补全变量 = 补全只读", "补全变量", "结束 过程",
					"事件 入口.补全事件()", "结束 事件", ""
				].join("\r\n");
				const properties = "$属性\r\n$资源 $对象\r\n$结束 $属性\r\n";
				await fs.writeFile(file, code + properties);
				await vscode.commands.executeCommand("es4a.internal.addProject", project);
				const editor = await vscode.window.showTextDocument(entry === "原生文件"
					? vscode.Uri.file(file) : toSimpleCodeUri(vscode.Uri.file(file)), { preview: false });
				const suggest = async (marked: string): Promise<readonly vscode.CompletionItem[]> => (
					await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider",
						editor.document.uri, position(editor.document, marked.replace("|", ""), marked.indexOf("|")))
				).items;
				const names = (items: readonly vscode.CompletionItem[]) => items.map((item) => typeof item.label === "string" ? item.label : item.label.label);
				assert.deepEqual(new Set(names(await suggest("补全|变量 ="))), new Set(["补全变量", "补全只写"]));
				const valueItems = await suggest("= 补全|只读");
				assert.deepEqual(new Set(names(valueItems)), new Set(["补全变量", "补全只读", "补全常量", "补全函数"]));
				const items = await suggest("\r\n补全|变量\r\n");
				assert.equal(names(items).includes("补全常量"), false);
				assert.equal(names(items).includes("补全只读"), false);
				for (const [name, kind, label] of [
					["补全常量", vscode.CompletionItemKind.Constant, "常量"], ["补全变量", vscode.CompletionItemKind.Variable, "变量"],
					["补全只读", vscode.CompletionItemKind.Property, "属性"], ["补全函数", vscode.CompletionItemKind.Function, "函数"],
					["补全过程", vscode.CompletionItemKind.Function, "过程"]
				] as const) {
					const item = [...items, ...valueItems].find((value) => (typeof value.label === "string" ? value.label : value.label.label) === name);
					assert.equal(item?.kind, kind, name);
					assert.ok(item.detail?.includes(` · ${label} ${name}`), item.detail ?? name);
				}
				const events = await suggest("入口.补全|事件()");
				assert.deepEqual(names(events), ["补全事件"]);
				assert.equal(events[0]?.kind, vscode.CompletionItemKind.Event);
				assert.match(events[0]?.detail ?? "", / · 事件 补全事件/u);
				const cursor = position(editor.document, "= 补全只读", 4);
				await selectCursor(editor, cursor);
				await driver.key(" ", true);
				await driver.waitFor("Boolean(document.querySelector('.suggest-widget.visible .codicon-symbol-property')) && Boolean(document.querySelector('.suggest-widget.visible .codicon-symbol-constant')) && Boolean(document.querySelector('.suggest-widget.visible .codicon-symbol-variable'))");
				await driver.key("Escape");
				assert.equal(await fs.readFile(file, "utf8"), code + properties);
			});
		});
	}

	for (const entry of ["ES4A 代码标签", "原生文件"] as const) {
		test(`${entry}实际输入点号时语句位置排除常量，取值位置保留同一常量`, async () => {
			await withSource(async (file, project) => {
				const code = "过程 运行()\r\n\t变量 数 为 整数型\r\n\t按钮1\r\n\t数 = 按钮1\r\n结束 过程\r\n";
				const properties = "$属性\r\n\t$资源 $窗口\r\n\t$定义 入口 $为 窗口\r\n\t\t$定义 按钮1 $为 按钮\r\n\t\t$结束 $定义\r\n\t$结束 $定义\r\n$结束 $属性\r\n";
				await fs.writeFile(file, code + properties);
				await vscode.commands.executeCommand("es4a.internal.addProject", project);
				const editor = await vscode.window.showTextDocument(entry === "原生文件"
					? vscode.Uri.file(file) : toSimpleCodeUri(vscode.Uri.file(file)), { preview: false });
				for (const [fragment, delta, valuePosition] of [["\t按钮1\r\n", 4, false], ["数 = 按钮1\r\n", 7, true]] as const) {
					await selectCursor(editor, position(editor.document, fragment, delta));
					await driver.type(".");
					await driver.waitFor("document.querySelectorAll('.suggest-widget.visible .label-name').length > 0");
					const result = await vscode.commands.executeCommand<vscode.CompletionList>(
						"vscode.executeCompletionItemProvider", editor.document.uri, editor.selection.active, "."
					);
					const constants = result.items.filter((item) => item.kind === vscode.CompletionItemKind.Constant);
					assert.equal(constants.some((item) => item.label === "布局_单帧"), valuePosition);
					if (!valuePosition) assert.equal(constants.length, 0);
					await driver.waitFor(`Boolean(document.querySelector('.suggest-widget.visible .codicon-symbol-constant')) === ${valuePosition}`);
					await driver.key("Escape");
				}
				assert.equal(await fs.readFile(file, "utf8"), code + properties);
			});
		});
	}

	for (const entry of ["ES4A 代码标签", "原生文件"] as const) {
		test(`${entry}真实按键、点号、字母、中文快速建议与列表更新共用语法筛选`, async () => {
			await withSource(async (file, project) => {
				const code = "过程 运行()\r\n\t按钮1.文本 = 0\r\n\t按钮1\r\n结束 过程\r\n";
				const properties = "$属性\r\n\t$资源 $窗口\r\n\t$定义 入口 $为 窗口\r\n\t\t$定义 按钮1 $为 按钮\r\n\t\t$结束 $定义\r\n\t$结束 $定义\r\n$结束 $属性\r\n";
				await fs.writeFile(file, code + properties);
				await vscode.commands.executeCommand("es4a.internal.addProject", project);
				const editor = await vscode.window.showTextDocument(entry === "原生文件"
					? vscode.Uri.file(file) : toSimpleCodeUri(vscode.Uri.file(file)), { preview: false });
				const initial = editor.document.getText();
				const labels = "Array.from(document.querySelectorAll('.suggest-widget.visible .label-name')).map(element => element.textContent)";
				const middle = position(editor.document, "按钮1.文本", 5);
				assert.ok((await completions(editor.document, "按钮1.文")).includes("文本颜色"), "按键前确认项目及 SDK 语义已加载");
				await selectCursor(editor, middle);
				/* 通过隔离工作台的标准建议快捷键验证；不修改用户按键，也不经过系统输入法。 */
				await driver.key(" ", true);
				await driver.waitFor(`${labels}.includes('文本颜色')`);
				assert.deepEqual(await driver.evaluate(labels), ["文本", "文本颜色"]);
				await driver.key("Escape");

				/* 实际输入路径让 VS Code 自己决定触发方式，不直接调用补全 Provider。 */
				const end = position(editor.document, "\t按钮1\r\n", 4);
				await selectCursor(editor, end);
				await driver.type(".");
				assert.equal(editor.document.getText(), initial.replace("\t按钮1\r\n", "\t按钮1.\r\n"));
				assert.ok((await completions(editor.document, "\t按钮1.")).includes("文本"), "点号输入后仍可查询到成员");
				/* 点号候选很多，列表按需渲染；此处不能要求未滚入视口的文本项已经有 DOM。 */
				await driver.waitFor(`${labels}.length > 0`);
				const dotItems = await driver.evaluate(labels) as string[];
				assert.equal(dotItems.includes("被单击"), false);
				assert.equal(dotItems.includes("按钮"), false);
				await driver.type("w");
				await driver.waitFor(`${labels}.includes('位于底边') && ${labels}.includes('文本')`);
				await driver.type("b");
				await driver.waitFor(`${labels}.includes('文本') && !${labels}.includes('位于底边')`);
				assert.deepEqual(await driver.evaluate(labels), ["文本", "文本颜色"]);
				await driver.key("Escape");
				await vscode.commands.executeCommand("undo");
				assert.equal(editor.document.getText(), initial);

				/* 中文不属于注册的字母触发字符，由编辑器快速建议发起。 */
				await selectCursor(editor, end);
				await driver.type(".");
				await driver.waitFor(`${labels}.length > 0`);
				await driver.key("Escape");
				await driver.type("文");
				await driver.waitFor(`${labels}.includes('文本')`);
				const chineseItems = await driver.evaluate(labels) as string[];
				assert.equal(chineseItems.includes("被单击"), false);
				assert.ok(chineseItems.includes("位于底边"), "词尾中文输入保留原首拼匹配");
				await driver.key("Escape");
				assert.equal(await fs.readFile(file, "utf8"), code + properties);
			});
		});
	}

	for (const entry of ["ES4A 代码标签", "原生文件"] as const) {
		test(`${entry}声明和条件边界不混入成员，静态成员优先且片段置后`, async () => {
			await withSource(async (file, project) => {
				const code = [
					"事件 入口.初始化()", "变量 整数 ", "如果 整数 = 组件.布局_方向_水平 ",
					"如果 真 则", "结束 ", "切换窗口(主窗口.窗口实例)", "结束 事件", ""
				].join("\r\n");
				const properties = "$属性\r\n$资源 $窗口\r\n$结束 $属性\r\n";
				await fs.writeFile(file, code + properties);
				await fs.writeFile(path.join(path.dirname(file), "主窗口.simple"), "静态 变量 窗口实例 为 主窗口\r\n" + properties);
				await vscode.commands.executeCommand("es4a.internal.addProject", project);
				const editor = await vscode.window.showTextDocument(entry === "原生文件"
					? vscode.Uri.file(file) : toSimpleCodeUri(vscode.Uri.file(file)), { preview: false });
				const suggest = async (fragment: string, delta = fragment.length) => (
					await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider",
						editor.document.uri, position(editor.document, fragment, delta))
				).items;
				const names = (items: readonly vscode.CompletionItem[]) => items.map((item) => typeof item.label === "string" ? item.label : item.label.label);
				assert.deepEqual(names(await suggest("变量 整数 ")), ["为"]);
				assert.deepEqual(new Set(names(await suggest("如果 整数 = 组件.布局_方向_水平 "))), operators("则"));
				assert.deepEqual(names(await suggest("结束 ")), ["如果"]);
				let members: readonly vscode.CompletionItem[] = [];
				for (let attempt = 0; attempt < 100; attempt += 1) {
					members = await suggest("主窗口.窗口实例", 4);
					if (members.length > 0) break;
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
				assert.equal(names(members)[0], "窗口实例");
				assert.equal(members[0]?.kind, vscode.CompletionItemKind.Variable);
				assert.ok(members.slice(1).some((value) => value.kind === vscode.CompletionItemKind.Constant));
				assert.equal(vscode.workspace.getConfiguration("editor", editor.document).get("snippetSuggestions"), "bottom");

				const labels = "Array.from(document.querySelectorAll('.suggest-widget.visible .label-name')).map(element => element.textContent)";
				for (const [fragment, expected] of [["变量 整数 ", ["为"]], ["如果 整数 = 组件.布局_方向_水平 ", ["则", ...binaryOperators]]] as const) {
					await selectCursor(editor, position(editor.document, fragment));
					await driver.key(" ", true);
					await driver.waitFor(`${labels}.includes(${JSON.stringify(expected[0])})`);
					// 大候选列表由编辑器虚拟化；完整集合已由 Provider 断言，可见行不得混入其它符号。
					assert.ok((await driver.evaluate(labels) as string[]).every((name) => expected.some((allowed) => allowed === name)));
					await driver.key("Escape");
				}
				await selectCursor(editor, position(editor.document, "主窗口.窗口实例", 4));
				await driver.key(" ", true);
				await driver.waitFor(`${labels}[0] === '窗口实例'`);
				await driver.key("Escape");

				/* 在隔离工作台注入一个片段候选，确认即便其排序文本更靠前，也排在语义候选之后。 */
				const snippets = vscode.languages.registerCompletionItemProvider({ language: "simple", scheme: editor.document.uri.scheme }, {
					provideCompletionItems: () => {
						const item = new vscode.CompletionItem("b__回归片段", vscode.CompletionItemKind.Snippet);
						item.sortText = "0000"; item.insertText = new vscode.SnippetString("测试片段");
						return [item];
					}
				});
				try {
					await selectCursor(editor, position(editor.document, "结束 "));
					await driver.key(" ", true);
					await driver.waitFor(`${labels}.includes('b__回归片段')`);
					assert.deepEqual(await driver.evaluate(labels), ["如果", "b__回归片段"]);
					await driver.key("Escape");
				} finally { snippets.dispose(); }
				assert.equal(await fs.readFile(file, "utf8"), code + properties);
			});
		});
	}

	test("真实 ES4A 续行调用接受补全后保留已有括号和实参", async () => {
		await withSource(async (file) => {
			const code = "变量 实例 为 提示对象\r\n\r\n过程 Run()\r\n实例.求和 _\r\n(1, 2)\r\n结束 过程\r\n";
			await fs.writeFile(file, code + propertySource);
			const editor = await vscode.window.showTextDocument(toSimpleCodeUri(vscode.Uri.file(file)), { preview: false });
			const cursor = position(editor.document, "实例.求和", "实例.求".length);
			const items = await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", editor.document.uri, cursor);
			assert.equal(items.items.find((item) => item.label === "求和")?.insertText, "求和");
			await selectCursor(editor, cursor);
			await driver.key(" ", true);
			await driver.waitFor("Array.from(document.querySelectorAll('.suggest-widget .monaco-list-row')).some(element => element.getClientRects().length > 0 && element.textContent.includes('求和'))");
			await driver.key("Enter");
			assert.equal(editor.document.getText(), code);
			assert.equal(await fs.readFile(file, "utf8"), code + propertySource);
		});
	});

	for (const entry of ["ES4A 代码标签", "原生文件"] as const) {
		test(`${entry}隐式成员、静态限制与变体赋值共享实际接收者`, async () => {
			await withSource(async (file, project) => {
				const code = [
					"变量 自有字段 为 A", "属性 子对象 为 A", "获取", "结束 获取", "结束 属性", "",
					"过程 Run()", "变量 数 为 整数型", "数 = 子对象.甲值", "数 = 基础字段.甲值",
					"子对象.工作(1)", "基础字段.工作(1)", "",
					"变量 值 为 变体型 = 创建 A", "值 = 创建 B", "数 = 值.乙值", "",
					"变量 外层 为 变体型 = 创建 A", "如果 真 则", "变量 外层 为 变体型", "外层 = 创建 B", "结束 如果",
					"数 = 外层.甲值", "结束 过程", "",
					"静态 过程 静态运行()", "变量 数 为 整数型", "数 = 自有字段.甲值", "数 = 基础字段.甲值", "自有字段.工作(1)", "结束 过程", ""
				].join("\r\n");
				const properties = "$属性\r\n$资源 $对象\r\n基础对象 = Base\r\n$结束 $属性\r\n";
				await fs.writeFile(file, code + properties);
				await fs.writeFile(path.join(path.dirname(file), "A.simple"), "变量 甲值 为 整数型\r\n\r\n过程 工作(值 为 整数型)\r\n结束 过程\r\n" + propertySource);
				await fs.writeFile(path.join(path.dirname(file), "B.simple"), "变量 乙值 为 整数型\r\n" + propertySource);
				await fs.writeFile(path.join(path.dirname(file), "Base.simple"), "变量 基础字段 为 A\r\n" + propertySource);
				await vscode.commands.executeCommand("es4a.internal.addProject", project);
				const editor = await vscode.window.showTextDocument(entry === "原生文件" ? vscode.Uri.file(file) : toSimpleCodeUri(vscode.Uri.file(file)), { preview: false });
				for (let attempt = 0; attempt < 100 && !(await hover(editor.document, "子对象.甲值", 4)).includes("变量 甲值"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
				for (const receiver of ["子对象", "基础字段", "外层"]) {
					assert.ok((await completions(editor.document, `数 = ${receiver}.`)).includes("甲值"), receiver);
					assert.match(await hover(editor.document, `${receiver}.甲值`, receiver.length + 1), /变量 甲值/u);
				}
				assert.ok((await completions(editor.document, "数 = 值.")).includes("乙值"));
				assert.equal((await completions(editor.document, "数 = 值.")).includes("甲值"), false);
				for (const receiver of ["子对象", "基础字段"]) assert.match((await signatures(editor.document, `${receiver}.工作(`))?.signatures[0]?.label ?? "", /工作\(值 为 整数型\)/u);
				const staticStart = editor.document.getText().indexOf("静态 过程");
				for (const receiver of ["自有字段", "基础字段"]) {
					const offset = editor.document.getText().indexOf(`${receiver}.甲值`, staticStart) + receiver.length + 1;
					const result = await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", editor.document.uri, editor.document.positionAt(offset));
					assert.deepEqual(result.items, [], receiver);
				}
				assert.equal(await signatures(editor.document, "自有字段.工作("), undefined);
				assert.equal(await fs.readFile(file, "utf8"), code + properties);
			});
		});

		test(`${entry}R 遮蔽后的补全和悬停保持真实身份`, async () => {
			await withSource(async (file, project) => {
				const code = "过程 原资源()\r\n变量 数 为 整数型\r\n数 = R.string_probe\r\n结束 过程\r\n\r\n过程 Run()\r\n变量 R 为 Result\r\n变量 值 为 文本型\r\n值 = R.string_probe\r\n结束 过程\r\n";
				await fs.writeFile(file, code + propertySource);
				await fs.writeFile(path.join(path.dirname(file), "Result.simple"), "变量 string_probe 为 文本型\r\n" + propertySource);
				const values = path.join(path.dirname(project), "res", "values");
				await fs.mkdir(values, { recursive: true });
				await fs.writeFile(path.join(values, "strings.xml"), '<resources><string name="probe">值</string></resources>');
				await vscode.commands.executeCommand("es4a.internal.addProject", project);
				const editor = await vscode.window.showTextDocument(entry === "原生文件" ? vscode.Uri.file(file) : toSimpleCodeUri(vscode.Uri.file(file)), { preview: false });
				let actual = "";
				for (let attempt = 0; attempt < 100; attempt += 1) {
					actual = await hover(editor.document, "值 = R.string_probe", "值 = R.".length);
					if (actual.includes("变量 string_probe")) break;
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
				assert.match(actual, /变量 string_probe 为 文本型/u);
				assert.doesNotMatch(actual, /常量 R\./u);
				assert.ok((await completions(editor.document, "值 = R.")).includes("string_probe"));
				assert.match(await hover(editor.document, "数 = R.string_probe", "数 = R.".length), /常量 R\.string_probe 为 整数型/u);
				assert.equal(await fs.readFile(file, "utf8"), code + propertySource);
			});
		});

		test(`${entry}按编译器语法验证初值、事件、分支、传址及完整调用重载`, async () => {
			await withSource(async (file, project) => {
				const code = [
					"别名 工具 = 对象操作.调用方旧", "常量 上限 为 整数型 = 3",
					"变量 实例值 为 整数型", "静态 变量 静态值 为 整数型",
					"变量 发射器 为 Emitter", "变量 初值 为 整数型 = 上限",
					"静态 函数 计算(左值 为 整数型) 为 整数型", "结束 函数",
					"静态 函数 计算(左值 为 整数型, 右值 为 整数型) 为 整数型", "结束 函数",
					"过程 改值(传址 载荷 为 变体型)", "结束 过程",
					"事件 入口.加载()", "静态值 = 0", "结束 事件",
					"事件 发射器.完成(结果 为 整数型)", "实例值 = 结果", "结束 事件",
					"过程 Run(数 为 整数型, 文本 为 文本型)", "变量 载荷 为 变体型 = 创建 A",
					"改值(载荷)", "数 = 载荷.甲值", "数 = 计算(1, 2)",
					"如果 文本 匹配 \"a\" 则", "变量 前支 为 A", "否则", "数 = 前支.甲值", "结束 如果",
					"位于 错误", "分支 非法参数错误", "数 = 1", "结束 错误",
					"退出 过程 ", "结束 过程", ""
				].join("\r\n");
				await fs.writeFile(file, code + propertySource);
				await fs.writeFile(path.join(path.dirname(file), "Emitter.simple"), "事件 完成(结果 为 整数型)\r\n结束 事件\r\n" + propertySource);
				await fs.writeFile(path.join(path.dirname(file), "A.simple"), "变量 甲值 为 整数型\r\n" + propertySource);
				await vscode.commands.executeCommand("es4a.internal.addProject", project);
				const editor = await vscode.window.showTextDocument(entry === "原生文件" ? vscode.Uri.file(file) : toSimpleCodeUri(vscode.Uri.file(file)), { preview: false });
				for (let attempt = 0; attempt < 100; attempt++) {
					if ((await hover(editor.document, "前支.甲值", 3)).includes("变量 甲值")) break;
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
				const suggest = async (marked: string) => (await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider",
					editor.document.uri, position(editor.document, marked.replace("|", ""), marked.indexOf("|")))).items;
				const names = (items: readonly vscode.CompletionItem[]) => items.map((item) => typeof item.label === "string" ? item.label : item.label.label);
				const initial = names(await suggest("初值 为 整数型 = |上限"));
				assert.ok(initial.includes("上限") && initial.includes("实例值"));
				const loaded = names(await suggest("事件 入口.加载()\r\n|静态值 = 0"));
				assert.ok(loaded.includes("静态值"));
				assert.equal(loaded.includes("实例值") || loaded.includes("本对象"), false);
				assert.ok(names(await suggest("事件 |发射器.完成")).includes("发射器"));
				assert.deepEqual(names(await suggest("事件 发射器.|完成")), ["完成"]);
				const operators_ = names(await suggest("如果 文本 |匹配"));
				assert.ok(operators_.includes("匹配") && operators_.includes("异或"));
				assert.equal(operators_.includes("文本") || operators_.includes("实例值"), false);
				assert.deepEqual(await suggest("退出 过程 |\r\n"), []);
				assert.deepEqual(await suggest("载荷.|甲值"), []);
				assert.equal(await hover(editor.document, "载荷.甲值", 3), "");
				assert.ok(names(await suggest("前支.|甲值")).includes("甲值"));
				const errors = names(await suggest("分支 |非法参数错误"));
				assert.ok(errors.includes("非法参数错误"));
				assert.equal(errors.includes("数") || errors.includes("按钮"), false);
				const help = await signatures(editor.document, "计算(1");
				assert.ok(help);
				assert.equal(help.signatures[help.activeSignature]?.parameters.length, 2);

				/* 实际接受成员别名补全只替换目标名称，不插入调用括号或保存用户文件。 */
				await selectCursor(editor, position(editor.document, "调用方旧", 3));
				await driver.key(" ", true);
				await driver.waitFor("Array.from(document.querySelectorAll('.suggest-widget .monaco-list-row')).some(element => element.getClientRects().length > 0 && element.textContent.includes('调用方法'))");
				await driver.key("Enter");
				assert.equal(editor.document.getText(), code.replace("调用方旧", "调用方法") + (entry === "原生文件" ? propertySource : ""));
				assert.equal(await fs.readFile(file, "utf8"), code + propertySource);
			});
		});

		test(`${entry}数组纠错、表达式类型、执行条件与续行悬停使用同一语义`, async () => {
			await withSource(async (file, project) => {
				const code = [
					"变量 字段 为 变体型 = 创建 A", "",
					"过程 Run(载荷 为 变体型)", "变量 数据数组 为 整数型()", "变量 数 为 整数型", "数 = 数据错(0)", "",
					"变量 结果 为 逻辑型", "结果 = 类型检验 载荷 是 文本型", "断言真(类型检验 载荷 是 文本型)", "",
					"变量 比较 为 变体型 = 创建 A 是 空", "数 = 比较.甲值", "",
					"本对象.字段 = 创建 B", "数 = 字段.乙值", "数 = 本对象.字段.乙值", "",
					"变量 值 为 A", "执行", "变量 值 为 B", "直到 值.甲值", "",
					"变量 控件 为 提示对象", "数 = 控件. _\r\n类型检验", "结束 过程", ""
				].join("\r\n");
				await fs.writeFile(file, code + propertySource);
				await fs.writeFile(path.join(path.dirname(file), "A.simple"), "变量 甲值 为 逻辑型\r\n" + propertySource);
				await fs.writeFile(path.join(path.dirname(file), "B.simple"), "变量 乙值 为 逻辑型\r\n" + propertySource);
				await vscode.commands.executeCommand("es4a.internal.addProject", project);
				const editor = await vscode.window.showTextDocument(entry === "原生文件" ? vscode.Uri.file(file) : toSimpleCodeUri(vscode.Uri.file(file)), { preview: false });
				for (let attempt = 0; attempt < 100 && !(await hover(editor.document, "字段.乙值", 3)).includes("变量 乙值"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
				const suggest = async (marked: string) => (await vscode.commands.executeCommand<vscode.CompletionList>(
					"vscode.executeCompletionItemProvider", editor.document.uri, position(editor.document, marked.replace("|", ""), marked.indexOf("|")))).items;
				const names = (items: readonly vscode.CompletionItem[]) => items.map((item) => typeof item.label === "string" ? item.label : item.label.label);
				const array = (await suggest("数 = 数据|错(0)")).find((item) => item.label === "数据数组");
				assert.equal(array?.insertText, "数据数组");
				assert.equal(editor.document.getText(array!.range as vscode.Range), "数据错");
				for (const head of ["结果 = 类型检验 载荷", "断言真(类型检验 载荷"]) {
					assert.deepEqual(new Set(names(await suggest(`${head} |是 文本型`))), typeCheckOperators);
					assert.ok(names(await suggest(`${head} 是 |文本型`)).includes("文本型"));
				}
				assert.deepEqual(await suggest("数 = 比较.|甲值"), []);
				for (const receiver of ["字段", "本对象.字段"]) {
					const members = names(await suggest(`数 = ${receiver}.|乙值`));
					assert.ok(members.includes("乙值"), receiver);
					assert.equal(members.includes("甲值"), false, receiver);
				}
				const condition = names(await suggest("直到 值.|甲值"));
				assert.ok(condition.includes("甲值"));
				assert.equal(condition.includes("乙值"), false);
				assert.match(await hover(editor.document, "控件. _\r\n类型检验", "控件. _\r\n".length), /属性 类型检验 为 整数型/u);

				/* 实际接受数组纠错补全，只替换名称并保留原下标。 */
				await selectCursor(editor, position(editor.document, "数据错(0)", 2));
				await driver.key(" ", true);
				await driver.waitFor("Array.from(document.querySelectorAll('.suggest-widget .monaco-list-row')).some(element => element.getClientRects().length > 0 && element.textContent.includes('数据数组'))");
				await driver.key("Enter");
				assert.equal(editor.document.getText(), code.replace("数据错(0)", "数据数组(0)") + (entry === "原生文件" ? propertySource : ""));
				assert.equal(await fs.readFile(file, "utf8"), code + propertySource);
			});
		});

		test(`${entry}统一链式接收者、成员别名、条件及循环阶段的提示`, async () => {
			await withSource(async (file, project) => {
				const properties = "$属性\r\n$资源 $对象\r\n$结束 $属性\r\n";
				const code = [
					"别名 日期工具 = 日期时间操作.格式化时间", "别名 连续工具 = 日期工具", "别名 输出别名 = 输出信息",
					"别名 实例工具 = Holder.实例", "别名 数组工具 = Holder.数组",
					"变量 对象数组 为 Result()", "变量 索引 为 整数型", "变量 数 为 整数型",
					"变量 类型检验次数 为 整数型", "变量 普通对象 为 Result",
					"属性 只写对象 为 Result", "设置", "结束 设置", "结束 属性",
					"函数 工厂() 为 Result", "结束 函数", "过程 运行()",
					"如果 数 =  则", "结束 如果", "如果 真 且 真 则", "结束 如果",
					"如果 类型检验次数 = 0 则", "结束 如果", "如果 真 则 退出 过程",
					"如果 真 则", "否则", "数 = 0", "结束 如果",
					"如果 类型检验 (空 是 空) 是 逻辑型 则", "结束 如果",
					"判断 数", "分支 1 至 3", "数 = 1", "分支 否则", "数 = 2", "结束 判断",
					"位于 错误", "分支 否则", "数 = 3", "结束 错误",
					"循环 索引 = 0 至 10 步进 1", "退出 过程", "下个 索引",
					"循环 每个 索引 从 对象数组", "下个 索引",
					"数 = 工厂().结果值", "数 = 对象数组(0).结果值",
					"数 = 实例工具.结果值", "数 = 数组工具(0).结果值", "实例工具.输出信息(\"x\")",
					"工厂().输出信息(\"x\")", "对象数组(0).输出信息(\"x\")",
					"普通对象 = 创建 Result ",
					"对象数组.输出信息(\"x\")", "本对象.只写对象.输出信息(\"x\")",
					"日期工具(空, \"\")", "连续工具(空, \"\")", "输出别名(\"x\")", "结束 过程", ""
				].join("\r\n");
				await fs.writeFile(file, code + properties);
				await fs.writeFile(path.join(path.dirname(file), "Result.simple"), "变量 结果值 为 整数型\r\n\r\n过程 输出信息(自己的参数 为 文本型)\r\n结束 过程\r\n" + properties);
				await fs.writeFile(path.join(path.dirname(file), "Holder.simple"), "静态 变量 实例 为 Result\r\n静态 变量 数组 为 Result()\r\n" + properties);
				await vscode.commands.executeCommand("es4a.internal.addProject", project);
				const editor = await vscode.window.showTextDocument(entry === "原生文件" ? vscode.Uri.file(file) : toSimpleCodeUri(vscode.Uri.file(file)), { preview: false });
				for (let attempt = 0; attempt < 100; attempt += 1) {
					if ((await hover(editor.document, "工厂().结果值", 5)).includes("变量 结果值")) break;
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
				const suggest = async (marked: string) => (await vscode.commands.executeCommand<vscode.CompletionList>(
					"vscode.executeCompletionItemProvider", editor.document.uri, position(editor.document, marked.replace("|", ""), marked.indexOf("|")))).items;
				const names = (items: readonly vscode.CompletionItem[]) => items.map((item) => typeof item.label === "string" ? item.label : item.label.label);
				for (const fragment of ["如果 数 = | 则", "如果 真 且 |真"]) {
					const values = names(await suggest(fragment));
					assert.ok(values.includes("数")); assert.equal(values.includes("则"), false);
				}
				assert.deepEqual(new Set(names(await suggest("循环 索引 = 0 |至"))), operators("至"));
				assert.deepEqual(new Set(names(await suggest("循环 索引 = 0 至 10 |步进"))), operators("步进"));
				assert.deepEqual(names(await suggest("循环 每个 索引 |从")), ["从"]);
				assert.deepEqual(new Set(names(await suggest("循环 索引 = 0 至 10 步进 1\r\n退出 |过程"))), new Set(["过程", "循环"]));
				assert.deepEqual(new Set(names(await suggest("如果 类型检验次数 = 0 |则"))), operators("则"));
				assert.deepEqual(new Set(names(await suggest("如果 真 则 退出 |过程"))), new Set(["过程", "否则"]));
				assert.deepEqual(names(await suggest("下个 |索引")), ["索引"]);
				for (const name of ["否则", "否则如果"]) assert.equal(names(await suggest("否则\r\n|数 = 0")).includes(name), false);
				assert.equal(names(await suggest("普通对象 = 创建 Result |\r\n")).includes("位于"), false);
				assert.deepEqual(new Set(names(await suggest("如果 类型检验 (空 是 空) |是 逻辑型"))), typeCheckOperators);
				assert.deepEqual(new Set(names(await suggest("判断 数\r\n|分支 1"))), new Set(["分支", "结束"]));
				assert.deepEqual(new Set(names(await suggest("分支 1 |至 3"))), operators("至"));
				assert.deepEqual(names(await suggest("位于 |错误")), ["错误"]);
				assert.equal(names(await suggest("分支 否则\r\n|数 = 2")).includes("分支"), false);
				for (const receiver of ["工厂()", "对象数组(0)"]) {
					const values = names(await suggest(`${receiver}.|结果值`));
					assert.ok(values.includes("结果值"));
					assert.equal(values.includes("输出信息"), false);
					assert.match(await hover(editor.document, `${receiver}.结果值`, receiver.length + 1), /变量 结果值 为 整数型/u);
					assert.equal(await signatures(editor.document, `${receiver}.输出信息(`), undefined);
				}
				for (const receiver of ["实例工具", "数组工具(0)"]) {
					assert.ok(names(await suggest(`${receiver}.|结果值`)).includes("结果值"));
					assert.match(await hover(editor.document, `${receiver}.结果值`, receiver.length + 1), /变量 结果值 为 整数型/u);
				}
				assert.match((await signatures(editor.document, "实例工具.输出信息("))?.signatures[0]?.label ?? "", /自己的参数/u);

				/* 实际主动补全仍显示合法字段，连续方法调用不进入可见列表。 */
				await selectCursor(editor, position(editor.document, "工厂().结果值", "工厂().".length));
				await driver.key(" ", true);
				await driver.waitFor("Array.from(document.querySelectorAll('.suggest-widget .monaco-list-row')).some(element => element.getClientRects().length > 0 && element.textContent.includes('结果值'))");
				assert.equal(await driver.evaluate("Array.from(document.querySelectorAll('.suggest-widget .monaco-list-row')).some(element => element.getClientRects().length > 0 && element.textContent.includes('输出信息'))"), false);
				await driver.key("Escape");
				for (const receiver of ["对象数组", "本对象.只写对象"]) {
					assert.deepEqual(await suggest(`${receiver}.|输出信息`), []);
					assert.equal(await hover(editor.document, `${receiver}.输出信息`, receiver.length + 1), "");
					assert.equal(await signatures(editor.document, `${receiver}.输出信息(`), undefined);
				}
				for (const alias of ["日期工具", "连续工具", "输出别名"]) {
					const help = await signatures(editor.document, `${alias}(`);
					assert.ok(help?.signatures.length);
					assert.ok(help.signatures.every((value) => value.label.startsWith(`${alias}(`)));
				}
				await selectCursor(editor, position(editor.document, "工厂().结果值", 5));
				await vscode.commands.executeCommand("editor.action.showHover");
				await driver.waitFor("Array.from(document.querySelectorAll('.monaco-hover')).some(element => element.getClientRects().length > 0 && element.textContent.includes('变量 结果值'))");
				await driver.key("Escape");
				await selectCursor(editor, position(editor.document, "连续工具("));
				await vscode.commands.executeCommand("editor.action.triggerParameterHints");
				await driver.waitFor("Array.from(document.querySelectorAll('.parameter-hints-widget')).some(element => element.getClientRects().length > 0 && element.textContent.includes('连续工具'))");
				await driver.key("Escape");
				assert.equal(await fs.readFile(file, "utf8"), code + properties);
			});
		});
	}

	test("ES4A 代码标签统一验证连续声明、完整语句、初值遮蔽、静态调用及续行重载", async () => {
		await withSource(async (file, project) => {
			const isolatedSdk = path.join(path.dirname(project), "sdk");
			await createSdk(isolatedSdk, "甲");
			const library = path.join(isolatedSdk, "libraries", "simple.test.overloads");
			await fs.mkdir(library);
			await fs.writeFile(path.join(library, "library.json"), JSON.stringify({
				kind: "library", name: "续行重载测试", categories: [{ name: "工具", definitions: [{
					name: "重载工具", type: "simple.test.overloads.重载工具", kind: "object", functions: [
						{ name: "求值", static: true, return: "整数型", params: [{ name: "输入", type: "整数型" }] },
						{ name: "求值", static: true, return: "整数型", params: [] }
					]
				}] }]
			}));
			const code = [
				"变量 同名 为 按钮", "常量 甲 为 整数型 = 1, 乙 为 整数型 = 2",
				"过程 调用()", "结束 过程", "函数 取得控件() 为 按钮", "结束 函数",
				"过程 Run()", "变量 一 为 整数型 = 1, 二 为 整数型 = 一",
				"变量 同名 为 按钮 = 同名", "变量 显式 为 按钮 = 本对象.同名",
				"变量 动态 为 整数型() = 创建 整数型(3)", "变量 固定 为 整数型(3) ",
				"如果 真 则 调用() ", "如果 真 则 退出 过程 ", "调用() ", "固定(0) ",
				"判断 一", "分支 是 > 1, ", "分支 1, 是 < 4", "结束 判断", "结束 过程",
				"静态 过程 静态Run()", "变量 值 为 文本型 = 取得控件().文本",
				"变量 数 为 整数型 = 重载工具.求值( _", ")", "结束 过程", ""
			].join("\r\n");
			try {
				await selectSdk(isolatedSdk);
				await fs.writeFile(file, code + propertySource);
				await vscode.commands.executeCommand("es4a.internal.addProject", project);
				const editor = await vscode.window.showTextDocument(toSimpleCodeUri(vscode.Uri.file(file)), { preview: false });
				const suggest = async (marked: string) => {
					const result = await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", editor.document.uri,
						position(editor.document, marked.replace("|", ""), marked.indexOf("|")));
					return result.items.filter((item) => item.kind !== vscode.CompletionItemKind.Text)
						.map((item) => typeof item.label === "string" ? item.label : item.label.label);
				};
				assert.ok((await suggest("一 为 整数型 = 1, 二 为 整|数型")).includes("整数型"));
				assert.ok((await suggest("二 为 整数型 = |一")).includes("一"));
				assert.ok((await suggest("甲 为 整数型 = 1, 乙 为 整|数型")).includes("整数型"));
				for (const fragment of ["如果 真 则 调用() |", "如果 真 则 退出 过程 |"])
					assert.deepEqual(await suggest(fragment), ["否则"]);
				assert.deepEqual(await suggest("\r\n调用() |"), []);
				assert.deepEqual(await suggest("固定(0) |"), ["="]);
				assert.deepEqual(await suggest("整数型(3) |"), []);
				assert.ok((await suggest("分支 是 > 1, |")).includes("是"));
				assert.ok((await suggest("分支 1, 是 |< 4")).includes("<"));
				assert.equal((await suggest("同名 为 按钮 = |同名")).includes("同名"), false);
				assert.equal(await hover(editor.document, "同名 为 按钮 = 同名", "同名 为 按钮 = ".length), "");
				assert.match(await hover(editor.document, "本对象.同名", 4), /变量 同名/u);
				assert.deepEqual(await suggest("取得控件().|文本"), []);
				assert.equal(await hover(editor.document, "取得控件().文本", 7), "");
				const help = await signatures(editor.document, "重载工具.求值( _\r\n");
				assert.ok(help);
				assert.equal(help.signatures[help.activeSignature]?.parameters.length, 0);
				const target = position(editor.document, "同名 为 按钮 = 同名", "同名 为 按钮 = ".length);
				const definitions = await vscode.commands.executeCommand<readonly vscode.Location[]>("vscode.executeDefinitionProvider", editor.document.uri, target);
				assert.equal(definitions?.length ?? 0, 0);

				/* 真正弹出补全列表，完整调用后只有否则，不出现不能赋值的方法结果。 */
				await selectCursor(editor, position(editor.document, "如果 真 则 调用() "));
				await driver.key(" ", true);
				await driver.waitFor("Array.from(document.querySelectorAll('.suggest-widget .label-name')).some(element => element.getClientRects().length > 0 && element.textContent === '否则')");
				assert.equal(await driver.evaluate("Array.from(document.querySelectorAll('.suggest-widget .label-name')).some(element => element.getClientRects().length > 0 && element.textContent === '=')"), false);
				await driver.key("Escape");
				assert.equal(await fs.readFile(file, "utf8"), code + propertySource);
			} finally { await selectSdk(sdkA); }
		});
	});

	test("真实原生编辑器显示悬停、补全和参数提示，接受补全不改变属性和侧边栏", async () => {
		await withSource(async (file) => {
			await vscode.commands.executeCommand("workbench.view.explorer");
			await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file), { preview: false });
			const editor = vscode.window.activeTextEditor;
			assert.ok(editor);
			assert.equal(editor.document.uri.scheme, "file");
			const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs).length;
			editor.selection = new vscode.Selection(position(editor.document, "目标.求和", 3), position(editor.document, "目标.求和", 3));
			await vscode.commands.executeCommand("editor.action.showHover");
			await driver.waitFor("Array.from(document.querySelectorAll('.monaco-hover')).some(element => element.getClientRects().length > 0 && element.textContent.includes('甲版求和说明'))");
			await driver.key("Escape");

			/* 在真实悬停面板核对独立单元归属，不能只验证内部结果。 */
			const localPosition = position(editor.document, "本地计算(1)", 0);
			editor.selection = new vscode.Selection(localPosition, localPosition);
			await vscode.commands.executeCommand("editor.action.showHover");
			await driver.waitFor("Array.from(document.querySelectorAll('.monaco-hover')).some(element => element.getClientRects().length > 0 && element.textContent.includes('所属单元：入口') && !element.textContent.includes('所属项目：'))");
			await driver.key("Escape");

			editor.selection = new vscode.Selection(position(editor.document, "目标.求和(1,"), position(editor.document, "目标.求和(1,"));
			await vscode.commands.executeCommand("editor.action.triggerParameterHints");
			await driver.waitFor("Array.from(document.querySelectorAll('.parameter-hints-widget')).some(element => element.getClientRects().length > 0 && element.textContent.includes('右值'))");
			await driver.key("Escape");

			const start = position(editor.document, "目标.标题", 3);
			const end = position(editor.document, "目标.标题");
			assert.equal(await editor.edit((edit) => edit.replace(new vscode.Range(start, end), "标")), true);
			editor.selection = new vscode.Selection(start.translate(0, 1), start.translate(0, 1));
			await vscode.commands.executeCommand("editor.action.triggerSuggest");
			await driver.waitFor("Array.from(document.querySelectorAll('.suggest-widget.visible')).some(element => element.textContent.includes('标题'))");
			await vscode.commands.executeCommand("acceptSelectedSuggestion");
			assert.equal(editor.document.getText(), userCode + propertySource);
			assert.equal(await fs.readFile(file, "utf8"), userCode + propertySource);
			assert.equal(vscode.window.tabGroups.all.flatMap((group) => group.tabs).length, tabs);
			assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), vscode.Uri.file(file).toString());
			await driver.waitFor("Boolean(document.querySelector('.sidebar .explorer-viewlet')?.getClientRects().length)");
		});
	});
});
