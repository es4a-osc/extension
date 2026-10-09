/*
在 VS Code 扩展宿主中验证激活、贡献点和 Provider 装配。
xhwsd@qq.com 2026-8-27
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { SimpleCodeDocumentRecovery } from "../../simpleCodeDocumentRecovery";
import { SimpleDesignerDocument } from "../../designerDocument";
import {
	createDesignerWebviewModel,
	SIMPLE_DESIGNER_VIEW_TYPE,
	SimpleDesignerProvider,
	type DesignerWebviewRenderMessage
} from "../../designerWebview";
import type { DesignerPreferenceState } from "../../designerPreferencePersistence";
import { SIMPLE_SEMANTIC_TOKEN_TYPES } from "../../compilerTokens";
import {
	SIMPLE_COMPLETION_TRIGGER_CHARACTERS,
	SimpleCompletionProvider
} from "../../completionProvider";
import { SimpleDefinitionProvider } from "../../definitionProvider";
import { SimpleHoverProvider } from "../../hoverProvider";
import { loadSdk, type LibraryManifest, type Sdk } from "../../sdk";
import { SimpleSemanticTokensProvider } from "../../semanticTokens";
import { SimpleSignatureHelpProvider } from "../../signatureHelp";
import { LibraryTreeProvider } from "../../libraryTree";
import { libraryMemberTarget } from "../../librarySymbol";
import {
	ProgramTreeProvider,
	type DirectoryNode,
	type FileNode,
	type ProgramProjectState,
	type ProgramTreeNode
} from "../../programTree";
import {
	ProgramTreeExpansionController,
	type ProgramTreeExpansionProvider,
	type ProgramTreeExpansionView
} from "../../programTreeExpansion";
import { ProgramRevealController } from "../../programReveal";
import { resolvePropertySourceFormatting } from "../../propertyFormatting";
import {
	createPropertyXmlAttributePath,
	inspectSimplePropertyXml,
	parseSimplePropertyXml,
	serializePropertyXml,
	writePropertyXmlValue
} from "../../propertyXml";
import {
	loadConfiguredSdk,
	resolveActiveUnitSourceUri,
	resolveDesignerTabSourceUri
} from "../../main";
import {
	SIMPLE_CODE_SCHEME,
	SimpleCodeFileSystemProvider,
	toSimpleCodeUri,
	toSimpleDesignerUri,
	toSimpleSourceUri
} from "../../simpleCodeFileSystem";
import {
	getVisibleSimpleUnitUserCode,
	splitSimpleUnitSource
} from "../../simpleUnitSource";
import { parseSimpleUnitSymbols, type SimpleProjectSemanticContext } from "../../simpleUnitSymbols";
import { loadSimpleProject } from "../../programResources";
import {
	createDefaultPackageName,
	deleteProjectDirectory
} from "../../programCommands";
import {
	editProjectManifestMacro,
	editProjectProperty
} from "../../projectPropertyCommands";
import { ProjectSymbolIndex } from "../../projectSymbolIndex";
import {
	UNIT_CONTENT_PREVIEW_SCHEME,
	UNIT_XML_PREVIEW_SCHEME,
	UnitPreviewProvider,
	toUnitContentPreviewUri,
	toUnitXmlPreviewUri
} from "../../unitPreview";
import {
	reconcileSimpleUnitTabs,
	resolveSimpleUnitTab
} from "../../simpleUnitTabs";
import {
	simpleTestProjectPath as testProjectPath,
	simpleTestUnitPath,
	type SimpleTestProjectName
} from "../testProjects";

const COMPLETION_CURSOR = "¦";

/** 返回 Simple 正式样例或测试项目内的绝对路径。 */
/** 为开发窗口恢复测试提供不接触真实工作区状态的内存 Memento。 */
class MemoryMemento implements vscode.Memento {
	private readonly values = new Map<string, unknown>();

	keys(): readonly string[] {
		return [...this.values.keys()];
	}

	get<T>(section: string): T | undefined;
	get<T>(section: string, defaultValue: T): T;
	get<T>(section: string, defaultValue?: T): T | undefined {
		return this.values.has(section)
			? this.values.get(section) as T
			: defaultValue;
	}

	update(section: string, value: unknown): Thenable<void> {
		if (value === undefined) {
			this.values.delete(section);
		} else {
			this.values.set(section, structuredClone(value));
		}
		return Promise.resolve();
	}
}

/** 为设计器 Provider 提供不接触真实工作区配置的内存界面偏好状态。 */
function memoryDesignerPreferenceState(): DesignerPreferenceState {
	const documents = new Map<string, ReturnType<DesignerPreferenceState["getDocument"]>>();
	return {
		getDocument: (sourceFilePath) => documents.get(sourceFilePath) ?? {},
		updateColumnOrder: async (sourceFilePath, order) => {
			documents.set(sourceFilePath, { ...documents.get(sourceFilePath), columnOrder: [...order] });
		},
		updateDisplayOption: async (sourceFilePath, option, value) => {
			const current = documents.get(sourceFilePath);
			documents.set(sourceFilePath, {
				...current,
				displayOptions: { ...(current?.displayOptions ?? {}), [option]: value }
			});
		},
		moveDocument: async (oldSourceFilePath, newSourceFilePath) => {
			const preference = documents.get(oldSourceFilePath);
			if (preference === undefined) return;
			documents.delete(oldSourceFilePath);
			documents.set(newSourceFilePath, preference);
		},
		deleteDocument: async (sourceFilePath) => {
			documents.delete(sourceFilePath);
		}
	};
}

/** 从唯一内存属性模型生成用于断言的 XML 文本。 */
function propertyXmlText(
	document: ReturnType<typeof parseSimplePropertyXml>
): string | undefined {
	return document === undefined
		? undefined
		: serializePropertyXml(document);
}

/** 在扩展宿主中请求标记位置的 Simple 补全项名称。 */
async function completionLabels(markedSource: string): Promise<readonly string[]> {
	const offset = markedSource.indexOf(COMPLETION_CURSOR);
	assert.notEqual(offset, -1, "测试源码缺少光标标记");
	const source = markedSource.replace(COMPLETION_CURSOR, "");
	const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-completion-"));
	const sourceFile = path.join(temporaryDirectory, "Completion.simple");
	await fs.writeFile(sourceFile, source, "utf8");
	const document = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(sourceFile)));

	try {
		const position = document.positionAt(offset);
		const result = await vscode.commands.executeCommand<vscode.CompletionList>(
			"vscode.executeCompletionItemProvider",
			document.uri,
			position
		);
		return result.items.map((item) => typeof item.label === "string" ? item.label : item.label.label);
	} finally {
		await vscode.window.showTextDocument(document, { preview: false });
		await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
		await fs.rm(temporaryDirectory, { force: true, recursive: true });
	}
}

/** 在扩展宿主中请求标记位置的 Simple 悬停 Markdown。 */
async function hoverContents(markedSource: string): Promise<readonly string[]> {
	const offset = markedSource.indexOf(COMPLETION_CURSOR);
	assert.notEqual(offset, -1, "测试源码缺少光标标记");
	const source = markedSource.replace(COMPLETION_CURSOR, "");
	const document = await vscode.workspace.openTextDocument({ content: source, language: "simple" });
	const position = document.positionAt(offset);
	const result = await vscode.commands.executeCommand<readonly vscode.Hover[]>(
		"vscode.executeHoverProvider",
		document.uri,
		position
	);
	return result.flatMap((hover) => hover.contents.map(
		(content) => typeof content === "string" ? content : content.value
	));
}

/** 将悬停 Markdown 中的元信息斜体标记还原为可见文本，便于断言内容与顺序。 */
function visibleHoverMarkdown(markdown: string): string {
	return markdown
		.replace(/\*([^*\r\n]+：)\*&#8203;/gu, "$1")
		.replaceAll("\\", "");
}

/** 断言项目树提示使用加粗类型和斜体字段名，并复用 VS Code 的文本转义。 */
function assertProgramTreeTooltip(
	actual: vscode.TreeItem["tooltip"],
	summary: string,
	fields: readonly (readonly [label: string, value: string])[] = [],
	description?: string
): void {
	assert.ok(actual instanceof vscode.MarkdownString);
	const expected = new vscode.MarkdownString(undefined, true);
	expected.appendMarkdown("**");
	expected.appendText(summary);
	expected.appendMarkdown("**");
	if (description !== undefined) {
		expected.appendMarkdown("  \n");
		expected.appendText(description);
	}
	let firstField = true;
	for (const [label, value] of fields) {
		if (description !== undefined && firstField) {
			expected.appendMarkdown("\n");
		}
		expected.appendMarkdown("  \n");
		expected.appendText(`${label}：${value}`);
		firstField = false;
	}
	assert.equal(actual.value, expected.value);
}

/** 等待异步编辑监听器把活动文档规范化为预期内容。 */
async function waitForDocumentText(document: vscode.TextDocument, expected: string): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (document.getText() === expected) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}

	assert.equal(document.getText(), expected);
}

/** 判断集成测试创建的临时文件是否存在。 */
async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.stat(filePath);
		return true;
	} catch {
		return false;
	}
}

/** Windows 集成宿主返回的小写盘符与测试输入视为同一路径。 */
function sameLocalPath(left: string | undefined, right: string): boolean {
	if (left === undefined) {
		return false;
	}
	const resolvedLeft = path.resolve(left);
	const resolvedRight = path.resolve(right);
	return process.platform === "win32"
		? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
		: resolvedLeft === resolvedRight;
}

suite("ES4A 扩展", () => {
	let originalSdkPath: string | undefined;
	let originalWorkspaceSettings: Uint8Array | undefined;
	let workspaceSettingsFile: string | undefined;

	suiteSetup("显式选择集成测试 SDK", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		assert.ok(workspaceFolder, "扩展宿主没有打开工作区");
		workspaceSettingsFile = path.join(workspaceFolder.uri.fsPath, ".vscode", "settings.json");
		try {
			originalWorkspaceSettings = await fs.readFile(workspaceSettingsFile);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const configuration = vscode.workspace.getConfiguration("es4a");
		originalSdkPath = configuration.inspect<string>("sdk.path")?.globalValue;
		await configuration.update(
			"sdk.path",
			path.resolve(extension.extensionPath, "..", "sdk", "sdk.json"),
			vscode.ConfigurationTarget.Global
		);
		await extension.activate();
	});

	suiteTeardown("恢复集成测试前的 SDK 和工作区设置", async () => {
		const configuration = vscode.workspace.getConfiguration("es4a");
		await configuration.update(
			"sdk.path",
			originalSdkPath,
			vscode.ConfigurationTarget.Global
		);
		try {
			await configuration.update("projects", undefined, vscode.ConfigurationTarget.Workspace);
		} finally {
			const settingsFile = workspaceSettingsFile;
			if (settingsFile !== undefined) {
				if (originalWorkspaceSettings !== undefined) {
					await fs.writeFile(settingsFile, originalWorkspaceSettings);
				} else {
					await fs.rm(settingsFile, { force: true });
					try {
						await fs.rmdir(path.dirname(settingsFile));
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
					}
				}
			}
		}
	});

	test("扩展宿主以 Tetris 示例项目启动", () => {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		assert.ok(workspaceFolder, "扩展宿主没有打开工作区");
		assert.equal(path.basename(workspaceFolder.uri.fsPath), "Tetris");
	});

	test("冷启动可直接恢复用户代码虚拟文档", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		const sourceUri = vscode.Uri.file(testProjectPath(
			"SmokeTest",
			"src",
			"simple",
			"smoketest",
			"conversions",
			"BooleanConversionsTest.simple"
		));
		const document = await vscode.workspace.openTextDocument(toSimpleCodeUri(sourceUri));

		assert.equal(document.uri.scheme, SIMPLE_CODE_SCHEME);
		assert.equal(path.basename(document.uri.path), "BooleanConversionsTest(代码)");
		assert.equal(toSimpleSourceUri(document.uri)?.fsPath, sourceUri.fsPath);
		const designerUri = toSimpleDesignerUri(sourceUri);
		assert.equal(designerUri.scheme, SIMPLE_CODE_SCHEME);
		assert.equal(path.basename(designerUri.path), "BooleanConversionsTest(设计器)");
		assert.equal(toSimpleSourceUri(designerUri)?.fsPath, sourceUri.fsPath);
		assert.notEqual(designerUri.toString(), document.uri.toString());
		assert.equal(
			toSimpleSourceUri(sourceUri.with({ scheme: SIMPLE_CODE_SCHEME }))?.fsPath,
			sourceUri.fsPath
		);
		assert.equal(document.languageId, "simple");
		assert.match(document.getText(), /函数 Name\(\) 为 文本型/u);
		assert.doesNotMatch(document.getText(), /\$属性/u);
		assert.equal(extension.isActive, true);
	});

	test("单元各视图恢复专用标签并自定义复制真实 simple 路径", async () => {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		assert.ok(workspaceFolder, "扩展宿主没有打开工作区");
		const sourceFile = path.join(
			workspaceFolder.uri.fsPath,
			"src",
			"simple",
			"samples",
			"tetris",
			"Tetris.simple"
		);
		const sourceUri = vscode.Uri.file(sourceFile);
		const viewUris: ReadonlyArray<readonly [vscode.Uri, string, string]> = [
			[toSimpleCodeUri(sourceUri), "Tetris(代码)", "simple"],
			[toUnitContentPreviewUri(sourceUri), "Tetris(完整代码)", "simple-full-preview"],
			[toUnitXmlPreviewUri(sourceUri), "Tetris(属性)", "simple-property-xml"]
		];
		const originalClipboard = await vscode.env.clipboard.readText();

		try {
			for (const [viewUri, expectedLabel, expectedLanguage] of viewUris) {
				assert.equal(path.basename(viewUri.path), expectedLabel);
				const document = await vscode.workspace.openTextDocument(viewUri);
				await vscode.window.showTextDocument(document, { preview: false });
				assert.equal(document.languageId, expectedLanguage);
				assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab?.label, expectedLabel);
				await vscode.commands.executeCommand("es4a.copyUnitAbsolutePath", viewUri);
				assert.equal(
					path.normalize(await vscode.env.clipboard.readText()).toLowerCase(),
					path.normalize(sourceFile).toLowerCase()
				);

				await vscode.commands.executeCommand("es4a.copyUnitRelativePath", viewUri);
				assert.equal(
					path.normalize(await vscode.env.clipboard.readText()).toLowerCase(),
					path.normalize(path.relative(workspaceFolder.uri.fsPath, sourceFile)).toLowerCase()
				);
				await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
			}
		} finally {
			await vscode.env.clipboard.writeText(originalClipboard);
		}
	});

	test("新窗口把未保存用户代码恢复到同一脏文档", async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-development-recovery-"));
		const sourceFile = path.join(temporaryDirectory, "Recovery.simple");
		await fs.writeFile(sourceFile, "' 原代码\r\n", "utf8");
		const document = await vscode.workspace.openTextDocument(
			toSimpleCodeUri(vscode.Uri.file(sourceFile))
		);
		const editor = await vscode.window.showTextDocument(document, { preview: false });
		const memento = new MemoryMemento();
		const firstWindow = new SimpleCodeDocumentRecovery(memento);
		const marker = "\r\n事件 Recovery.被长按()\r\n\r\n结束 事件\r\n";

		try {
			assert.equal(await editor.edit((edit) => edit.insert(
				document.positionAt(document.getText().length),
				marker
			)), true);
			assert.equal(document.isDirty, true);
			firstWindow.capture(document);
			await firstWindow.flush();

			const nativeRecovery = new SimpleCodeDocumentRecovery(memento);
			assert.equal(await nativeRecovery.restore(document), false);
			assert.equal(document.isDirty, true);
			assert.match(document.getText(), /事件 Recovery\.被长按\(\)/u);

			await vscode.commands.executeCommand("workbench.action.files.revert");
			assert.equal(document.isDirty, false);
			assert.doesNotMatch(document.getText(), /被长按/u);

			const nextWindow = new SimpleCodeDocumentRecovery(memento);
			assert.equal(await nextWindow.restore(document), true);
			assert.equal(document.isDirty, true);
			assert.match(document.getText(), /事件 Recovery\.被长按\(\)/u);
			nextWindow.clear(document);
			await nextWindow.flush();
		} finally {
			if (document.isDirty) {
				await vscode.commands.executeCommand("workbench.action.files.revert");
			}
			await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("Tetris 用户代码虚拟文档逐字保留属性区之前的源码", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		const sourceUri = vscode.Uri.file(testProjectPath(
			"Tetris",
			"src",
			"simple",
			"samples",
			"tetris",
			"Bar.simple"
		));
		const source = await fs.readFile(sourceUri.fsPath, "utf8");
		const document = await vscode.workspace.openTextDocument(toSimpleCodeUri(sourceUri));

		assert.equal(document.getText(), getVisibleSimpleUnitUserCode(source));
		assert.equal(
			document.lineCount,
			getVisibleSimpleUnitUserCode(source).split(/\r\n|\n|\r/u).length
		);
	});

	test("Ell 用户代码通过属性 XML 提供 Brick 继承悬停", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		const projectFile = testProjectPath(
			"Tetris",
			"project.properties"
		);
		const sourceFile = path.resolve(
			path.dirname(projectFile),
			"src",
			"simple",
			"samples",
			"tetris",
			"Ell.simple"
		);
		const [project, source, sdk] = await Promise.all([
			loadSimpleProject(projectFile),
			fs.readFile(sourceFile, "utf8"),
			loadSdk(path.resolve(extension.extensionPath, "..", "sdk", "sdk.json"))
		]);
		const index = new ProjectSymbolIndex();
		await index.updateProjects([project]);
		const context = index.contextForFile(sourceFile, source);
		assert.ok(context);
		const document = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(sourceFile)));
		const provider = new SimpleHoverProvider(() => source, () => context);
		provider.updateSdk(sdk);
		const hoverText = (offset: number): string => {
			const hover = provider.provideHover(document, document.positionAt(offset));
			return visibleHoverMarkdown(hover?.contents.map(
				(content) => typeof content === "string" ? content : content.value
			).join("\n") ?? "");
		};
		const visibleSource = document.getText();
		const eventHeader = visibleSource.indexOf("事件 Ell.初始化");
		assert.notEqual(eventHeader, -1);

		const unitHover = hoverText(eventHeader + "事件 ".length + 1);
		assert.match(unitHover, /对象 Ell/u);
		assert.match(unitHover, /基础对象：simple\.samples\.tetris\.Brick/u);
		assert.match(unitHover, /所属项目：Tetris/u);
		assert.match(unitHover, /所属单元：simple\.samples\.tetris\.Ell/u);
		assert.doesNotMatch(unitHover, /项目单元|Tetris\.simple/u);
		assert.match(
			hoverText(eventHeader + "事件 Ell.".length + 1),
			/事件 Ell\.初始化\(\)/u
		);
		const inheritedConstantOffset = visibleSource.indexOf("ORIENTATION_0", eventHeader);
		assert.notEqual(inheritedConstantOffset, -1);
		assert.match(
			hoverText(inheritedConstantOffset + 1),
			/常量 ORIENTATION_0/u
		);
	});

	test("组件事件悬停显示事件说明并把完整事件定义排在末尾", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		const projectFile = testProjectPath("SmokeTests", "project.properties");
		const sourceFile = await simpleTestUnitPath("SmokeTests", "测试其它");
		const [project, source, sdk] = await Promise.all([
			loadSimpleProject(projectFile),
			fs.readFile(sourceFile, "utf8"),
			loadSdk(path.resolve(extension.extensionPath, "..", "sdk", "sdk.json"))
		]);
		const index = new ProjectSymbolIndex();
		await index.updateProjects([project]);
		const context = index.contextForFile(sourceFile, source);
		assert.ok(context);
		const document = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(sourceFile)));
		const provider = new SimpleHoverProvider(() => source, () => context);
		provider.updateSdk(sdk);
		const eventOffset = document.getText().indexOf("事件 按钮4.被单击");
		assert.notEqual(eventOffset, -1);
		const hover = provider.provideHover(
			document,
			document.positionAt(eventOffset + "事件 按钮4.".length + 1)
		);
		const hoverMarkdown = hover?.contents.map(
			(content) => typeof content === "string" ? content : content.value
		).join("\n") ?? "";
		const hoverText = visibleHoverMarkdown(hoverMarkdown);

		assert.match(hoverText, /事件 按钮4\.被单击\(\)/u);
		assert.match(hoverText, /默认单击事件处理方法。/u);
		assert.match(hoverText, /所属项目：冒烟测试/u);
		assert.match(hoverText, /所属单元：simple\.runtime\.smoketests\.others\.测试其它/u);
		assert.match(
			hoverText,
			/事件定义：simple\.runtime\.components\.按钮\.被单击\(\)/u
		);
		assert.match(hoverMarkdown, /所属项目：冒烟测试/u);
		assert.match(hoverMarkdown, /所属单元：simple\.runtime\.smoketests\.others\.测试其它/u);
		assert.match(hoverMarkdown, /事件定义：simple\.runtime\.components\.按钮/u);
		assert.ok(hoverText.indexOf("所属单元：") < hoverText.indexOf("事件定义："));
	});

	test("参数个数错误时悬停仍显示完整函数签名和参数说明", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		const sdk = await loadSdk(path.resolve(extension.extensionPath, "..", "sdk", "sdk.json"));
		const source = "过程 Run()\r\n\t弹出确认框(\"授权结果\")\r\n结束 过程";
		const document = await vscode.workspace.openTextDocument({ content: source, language: "simple" });
		const provider = new SimpleHoverProvider(() => source);
		provider.updateSdk(sdk);
		const offset = source.indexOf("弹出确认框") + 1;
		const hover = provider.provideHover(document, document.positionAt(offset));
		const hoverText = visibleHoverMarkdown(hover?.contents.map(
			(content) => typeof content === "string" ? content : content.value
		).join("\n") ?? "");
		assert.match(hoverText, /过程 弹出确认框\(title 为 文本型, message 为 文本型, btnOK 为 文本型\)/u);
		assert.match(hoverText, /title：/u);
		assert.match(hoverText, /message：/u);
		assert.match(hoverText, /btnOK：/u);
	});

	test("当前窗口单元的加载事件在代码视图显示对象事件说明", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		const projectFile = testProjectPath("SmokeTests", "project.properties");
		const sourceFile = await simpleTestUnitPath("SmokeTests", "局部布局");
		const [project, source, sdk] = await Promise.all([
			loadSimpleProject(projectFile),
			fs.readFile(sourceFile, "utf8"),
			loadSdk(path.resolve(extension.extensionPath, "..", "sdk", "sdk.json"))
		]);
		const index = new ProjectSymbolIndex();
		await index.updateProjects([project]);
		const context = index.contextForFile(sourceFile, source);
		assert.ok(context);
		const document = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(sourceFile)));
		const provider = new SimpleHoverProvider(() => source, () => context);
		provider.updateSdk(sdk);
		const eventOffset = document.getText().indexOf("事件 局部布局.加载()");
		assert.notEqual(eventOffset, -1);
		const hover = provider.provideHover(
			document,
			document.positionAt(eventOffset + "事件 局部布局.".length + 1)
		);
		const hoverText = visibleHoverMarkdown(hover?.contents.map(
			(content) => typeof content === "string" ? content : content.value
		).join("\n") ?? "");
		assert.match(hoverText, /事件 局部布局\.加载\(\)/u);
		assert.match(hoverText, /当该对象首次加载（使用）时触发。/u);
		assert.match(hoverText, /所属单元：simple\.runtime\.smoketests\.layouts\.局部布局/u);
	});

	test("普通注释不进入悬停且三单引号过程文档按多行显示", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		const projectFile = testProjectPath("SmokeTest", "project.properties");
		const sourceFile = path.resolve(
			path.dirname(projectFile),
			"src", "simple", "smoketest", "Test.simple"
		);
		const [project, source, sdk] = await Promise.all([
			loadSimpleProject(projectFile),
			fs.readFile(sourceFile, "utf8"),
			loadSdk(path.resolve(extension.extensionPath, "..", "sdk", "sdk.json"))
		]);
		const index = new ProjectSymbolIndex();
		await index.updateProjects([project]);
		const ordinaryContext = index.contextForFile(sourceFile, source);
		assert.ok(ordinaryContext);
		const document = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(sourceFile)));
		const ordinaryProvider = new SimpleHoverProvider(() => source, () => ordinaryContext);
		ordinaryProvider.updateSdk(sdk);
		const ordinaryOffset = document.getText().indexOf("Run()") + 1;
		const ordinaryHover = ordinaryProvider.provideHover(
			document,
			document.positionAt(ordinaryOffset)
		);
		const ordinaryText = ordinaryHover?.contents.map(
			(content) => typeof content === "string" ? content : content.value
		).join("\n") ?? "";
		assert.doesNotMatch(ordinaryText, /Starts execution of the test/u);

		const documentedSource = source
			.replace("' Starts execution", "''' Starts execution")
			.replace("' (see simple.runtime.Assert)", "''' (see simple.runtime.Assert)");
		const documentedContext = index.contextForFile(sourceFile, documentedSource);
		assert.ok(documentedContext);
		const documentedDocument = await vscode.workspace.openTextDocument({
			content: getVisibleSimpleUnitUserCode(documentedSource),
			language: "simple"
		});
		const provider = new SimpleHoverProvider(() => documentedSource, () => documentedContext);
		provider.updateSdk(sdk);
		const offset = documentedDocument.getText().indexOf("Run()") + 1;
		const hover = provider.provideHover(
			documentedDocument,
			documentedDocument.positionAt(offset)
		);
		const text = hover?.contents.map(
			(content) => typeof content === "string" ? content : content.value
		).join("\n") ?? "";
		const visibleText = text.replaceAll("&nbsp;", " ").replaceAll("\\", "");

		assert.match(
			visibleText,
			/Starts execution of the test\. Failing tests must result in runtime errors  \r?\n\(see simple\.runtime\.Assert\)/u
		);
	});

	test("DerivedObject 悬停只显示直接基础对象重写关系", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		const projectFile = testProjectPath(
			"SmokeTest",
			"project.properties"
		);
		const sourceFile = path.resolve(
			path.dirname(projectFile),
			"src",
			"simple",
			"smoketest",
			"utils",
			"DerivedObject.simple"
		);
		const [project, source, sdk] = await Promise.all([
			loadSimpleProject(projectFile),
			fs.readFile(sourceFile, "utf8"),
			loadSdk(path.resolve(extension.extensionPath, "..", "sdk", "sdk.json"))
		]);
		const index = new ProjectSymbolIndex();
		await index.updateProjects([project]);
		const context = index.contextForFile(sourceFile, source);
		assert.ok(context);
		const document = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(sourceFile)));
		const provider = new SimpleHoverProvider(() => source, () => context);
		provider.updateSdk(sdk);
		const offset = document.getText().lastIndexOf("GetObjectName") + 1;
		const hover = provider.provideHover(document, document.positionAt(offset));
		const text = hover?.contents.map(
			(content) => typeof content === "string" ? content : content.value
		).join("\n") ?? "";
		const visibleText = visibleHoverMarkdown(text);

		assert.match(visibleText, /函数 GetObjectName\(\) 为 文本型/u);
		assert.match(visibleText, /重写函数：simple\.smoketest\.utils\.BaseObject\.GetObjectName\(\)/u);
		assert.doesNotMatch(visibleText, /实现接口：/u);
		assert.match(visibleText, /所属项目：SmokeTest/u);
		assert.match(visibleText, /所属单元：simple\.smoketest\.utils\.DerivedObject/u);
		assert.match(
			text,
			/所属项目：SmokeTest  \r?\n所属单元：simple\.smoketest\.utils\.DerivedObject/u
		);
		assert.match(
			text,
			/所属单元：simple\.smoketest\.utils\.DerivedObject  \r?\n重写函数：simple\.smoketest\.utils\.BaseObject\.GetObjectName\\\(\\\)/u
		);
		assert.ok(visibleText.indexOf("所属单元：") < visibleText.indexOf("重写函数："));
	});

	test("BaseObject 重载悬停只显示对应签名和接口关系", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		const projectFile = testProjectPath("SmokeTest", "project.properties");
		const sourceFile = path.resolve(
			path.dirname(projectFile),
			"src", "simple", "smoketest", "utils", "BaseObject.simple"
		);
		const [project, source, sdk] = await Promise.all([
			loadSimpleProject(projectFile),
			fs.readFile(sourceFile, "utf8"),
			loadSdk(path.resolve(extension.extensionPath, "..", "sdk", "sdk.json"))
		]);
		const index = new ProjectSymbolIndex();
		await index.updateProjects([project]);
		const context = index.contextForFile(sourceFile, source);
		assert.ok(context);
		const document = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(sourceFile)));
		const provider = new SimpleHoverProvider(() => source, () => context);
		provider.updateSdk(sdk);
		const overloadedOffset = document.getText().lastIndexOf("GetObjectName") + 1;
		const overloadedHover = provider.provideHover(document, document.positionAt(overloadedOffset));
		const overloadedText = visibleHoverMarkdown(overloadedHover?.contents.map(
			(content) => typeof content === "string" ? content : content.value
		).join("\n") ?? "");
		assert.match(overloadedText, /函数 GetObjectName\(prefix 为 文本型\) 为 文本型/u);
		assert.doesNotMatch(overloadedText, /实现函数：|重写/u);

		const offset = document.getText().indexOf("函数 GetObjectName()") + "函数 ".length + 1;
		const hover = provider.provideHover(document, document.positionAt(offset));
		const text = hover?.contents.map(
			(content) => typeof content === "string" ? content : content.value
		).join("\n") ?? "";
		const visibleText = visibleHoverMarkdown(text);

		assert.match(visibleText, /函数 GetObjectName\(\) 为 文本型/u);
		assert.match(visibleText, /实现函数：simple\.smoketest\.utils\.ObjectNameInterface\.GetObjectName\(\)/u);
		assert.doesNotMatch(visibleText, /重写/u);
		assert.match(
			text,
			/所属单元：simple\.smoketest\.utils\.BaseObject  \r?\n实现函数：simple\.smoketest\.utils\.ObjectNameInterface\.GetObjectName\\\(\\\)/u
		);
		assert.ok(visibleText.indexOf("所属单元：") < visibleText.indexOf("实现函数："));
	});

	test("别名右侧限定名跳到对象单元且单元接口关系位于悬停末尾", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		const projectFile = testProjectPath("SmokeTest", "project.properties");
		const sourceFile = path.resolve(
			path.dirname(projectFile),
			"src", "simple", "smoketest", "expressions", "CallExpressionsTest.simple"
		);
		const targetFile = path.resolve(
			path.dirname(projectFile),
			"src", "simple", "smoketest", "utils", "BaseObject.simple"
		);
		const [project, source, sdk] = await Promise.all([
			loadSimpleProject(projectFile),
			fs.readFile(sourceFile, "utf8"),
			loadSdk(path.resolve(extension.extensionPath, "..", "sdk", "sdk.json"))
		]);
		const index = new ProjectSymbolIndex();
		await index.updateProjects([project]);
		const context = index.contextForFile(sourceFile, source);
		assert.ok(context);
		const document = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(sourceFile)));
		const target = "simple.smoketest.utils.BaseObject";
		const offset = source.indexOf(target) + target.lastIndexOf("BaseObject") + 1;

		const hoverProvider = new SimpleHoverProvider(() => source, () => context);
		hoverProvider.updateSdk(sdk);
		const hover = hoverProvider.provideHover(document, document.positionAt(offset));
		const hoverMarkdown = hover?.contents.map(
			(content) => typeof content === "string" ? content : content.value
		).join("\n") ?? "";
		const hoverText = visibleHoverMarkdown(hoverMarkdown);
		assert.match(hoverMarkdown, /实现接口：/u);
		assert.ok(hoverText.indexOf("所属单元：") < hoverText.indexOf("实现接口："));
		assert.equal(
			hoverText.trimEnd().endsWith(
				"实现接口：simple.smoketest.utils.ObjectNameInterface"
			),
			true
		);

		const definitionProvider = new SimpleDefinitionProvider(() => source, () => context);
		definitionProvider.updateSdk(sdk);
		const location = await definitionProvider.provideDefinition(document, document.positionAt(offset));
		assert.equal(location?.uri.toString(), toSimpleCodeUri(vscode.Uri.file(targetFile)).toString());
	});

	test("注册扩展、命令和 Simple 语言", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");

		await extension.activate();
		assert.ok(SIMPLE_COMPLETION_TRIGGER_CHARACTERS.includes("w"));
		assert.ok(SIMPLE_COMPLETION_TRIGGER_CHARACTERS.includes("W"));
		assert.ok(SIMPLE_COMPLETION_TRIGGER_CHARACTERS.includes("."));

		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes("es4a.createProject"));
		assert.ok(commands.includes("es4a.addProject"));
		assert.ok(commands.includes("es4a.searchUnitCode"));
		assert.ok(commands.includes("es4a.refreshPrograms"));
		assert.ok(commands.includes("es4a.goToDefinition"));
		assert.ok(commands.includes("es4a.revealLibrarySymbol"));
		const editorMenuItems = (extension.packageJSON as {
			readonly contributes?: {
				readonly menus?: Readonly<Record<string, readonly {
					readonly command: string;
					readonly when?: string;
				}[]>>;
			};
		}).contributes?.menus?.["editor/context"] ?? [];
		assert.deepEqual(editorMenuItems.filter((item) => item.command.startsWith("es4a.goTo")), [{
			command: "es4a.goToDefinition",
			group: "navigation@1",
			when: "editorLangId == simple"
		}]);
		assert.equal(editorMenuItems.some((item) => item.command === "es4a.revealLibrarySymbol"), false);
		assert.ok(commands.includes("es4a.compileApplication"));
		assert.ok(commands.includes("es4a.debugApplication"));
		assert.ok(commands.includes("es4a.openProjectProperties"));
		assert.ok(commands.includes("es4a.locateProjectProperties"));
		assert.equal(commands.includes("es4a.locateProject"), false);
		assert.ok(commands.includes("es4a.openProjectDirectory"));
		assert.ok(commands.includes("es4a.locateFolder"));
		assert.ok(commands.includes("es4a.openUnitLoadEvent"));
		assert.ok(commands.includes("es4a.openUnitInitializeEvent"));
		assert.ok(commands.includes("es4a.locateUnitFile"));
		assert.ok(commands.includes("es4a.locateResourceFile"));
		assert.ok(commands.includes("es4a.locateBuildFile"));
		assert.ok(commands.includes("es4a.runSdkTool"));
		assert.ok(commands.includes("es4a.removeProject"));
		assert.ok(commands.includes("es4a.deleteProject"));
		assert.ok(commands.includes("es4a.createUnitItem"));
		assert.ok(commands.includes("es4a.createWindowUnit"));
		assert.ok(commands.includes("es4a.createObjectUnit"));
		assert.ok(commands.includes("es4a.createInterfaceUnit"));
		assert.ok(commands.includes("es4a.createServiceUnit"));
		assert.equal(commands.includes("es4a.createThreadUnit"), false);
		assert.ok(commands.includes("es4a.createUnitFolder"));
		assert.ok(commands.includes("es4a.importResource"));
		assert.ok(commands.includes("es4a.exportResource"));
		assert.ok(commands.includes("es4a.exportBuildFile"));
		assert.ok(commands.includes("es4a.createResourceFolder"));
		assert.ok(commands.includes("es4a.renameUnitFolder"));
		assert.ok(commands.includes("es4a.deleteUnitFolder"));
		assert.ok(commands.includes("es4a.renameUnitFile"));
		assert.ok(commands.includes("es4a.deleteUnitFile"));
		assert.ok(commands.includes("es4a.copyUnit"));
		assert.ok(commands.includes("es4a.cutUnit"));
		assert.ok(commands.includes("es4a.pasteUnit"));
		assert.ok(commands.includes("es4a.renameResourceFile"));
		assert.ok(commands.includes("es4a.deleteResourceFile"));
		assert.ok(commands.includes("es4a.deleteBuildFile"));
		assert.ok(commands.includes("es4a.copyResourceIndex"));
		assert.ok(commands.includes("es4a.copyResourceFileName"));
		assert.ok(commands.includes("es4a.copyResourceFolderName"));
		assert.ok(commands.includes("es4a.copyResourceRelativePath"));
		assert.ok(commands.includes("es4a.copyResourceAbsolutePath"));
		assert.ok(commands.includes("es4a.previewUnitContent"));
		assert.ok(commands.includes("es4a.previewUnitXml"));
		assert.ok(commands.includes("es4a.setObjectRelation"));
		assert.ok(commands.includes("es4a.setBaseObject"));
		assert.ok(commands.includes("es4a.setImplementedInterfaces"));
		assert.ok(commands.includes("es4a.copyUnitName"));
		assert.ok(commands.includes("es4a.copyUnitFolderQualifiedName"));
		assert.ok(commands.includes("es4a.copyUnitFolderName"));
		assert.ok(commands.includes("es4a.copyUnitFolderRelativePath"));
		assert.ok(commands.includes("es4a.copyUnitFolderAbsolutePath"));
		assert.ok(commands.includes("es4a.copyUnitQualifiedName"));
		assert.ok(commands.includes("es4a.copyUnitBaseObjectQualifiedName"));
		assert.ok(commands.includes("es4a.copyUnitImplementedInterfacesQualifiedName"));
		assert.ok(commands.includes("es4a.copyUnitRelativePath"));
		assert.ok(commands.includes("es4a.copyUnitAbsolutePath"));
		assert.ok(commands.includes("es4a.openDesigner"));
		assert.ok(commands.includes("es4a.refreshLibraries"));
		assert.ok(commands.includes("es4a.openLibraryManifest"));
		assert.ok(commands.includes("es4a.locateLibraryManifest"));
		assert.equal(commands.includes("es4a.refreshProperties"), false);

		assert.ok(commands.includes("es4a.selectSdk"));
		assert.ok(commands.includes("workbench.view.extension.es4a-programs"));

		const document = await vscode.workspace.openTextDocument({
			content: "常量 ANSWER 为 整数型 = 42",
			language: "simple"
		});
		assert.equal(document.languageId, "simple");
	});

	test("未选择 SDK 时不加载任何默认入口", async () => {
		const configuration = vscode.workspace.getConfiguration("es4a");
		const selectedSdkPath = configuration.get<string>("sdk.path");
		assert.ok(selectedSdkPath);

		try {
			await configuration.update("sdk.path", undefined, vscode.ConfigurationTarget.Global);
			assert.equal(await loadConfiguredSdk(), undefined);
		} finally {
			await configuration.update("sdk.path", selectedSdkPath, vscode.ConfigurationTarget.Global);
			await vscode.commands.executeCommand("es4a.refreshLibraries");
		}
	});

	test("完整代码保持只读并复用 Simple 着色和悬停", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		await extension.activate();
		const sourceUri = vscode.Uri.file(testProjectPath(
			"SmokeTest", "src", "simple", "smoketest", "SmokeTest.simple"
		));
		const document = await vscode.workspace.openTextDocument(toUnitContentPreviewUri(sourceUri));
		assert.equal(document.languageId, "simple-full-preview");
		assert.notEqual(vscode.workspace.fs.isWritableFileSystem(document.uri.scheme), true);

		const propertyOffset = document.getText().indexOf("$属性");
		assert.notEqual(propertyOffset, -1);
		const position = document.positionAt(propertyOffset + 1);
		const hovers = await vscode.commands.executeCommand<readonly vscode.Hover[]>(
			"vscode.executeHoverProvider",
			document.uri,
			position
		);
		assert.ok(hovers.length > 0, "完整代码应复用 Simple 悬停能力");
		const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens | undefined>(
			"vscode.provideDocumentSemanticTokens",
			document.uri
		);
		assert.ok(tokens !== undefined && tokens.data.length > 0,
			"完整代码应复用 Simple 语义着色能力");
	});

	test("两个单元预览协议以无文件系统锁的只读文本打开", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		await extension.activate();
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-preview-text-"));
		const sourceUri = vscode.Uri.file(path.join(temporaryDirectory, "RestorePreview.simple"));
		const source = [
			"事件 RestorePreview.初始化()",
			"结束 事件",
			"$属性",
			"\t$资源 $窗口",
			"\t$定义 RestorePreview $为 窗口",
			"\t$结束 $定义",
			"$结束 $属性",
			""
		].join("\r\n");

		try {
			await fs.writeFile(sourceUri.fsPath, source, "utf8");
			const contentUri = toUnitContentPreviewUri(sourceUri);
			const xmlUri = toUnitXmlPreviewUri(sourceUri);
			const [contentDocument, xmlDocument] = await Promise.all([
				vscode.workspace.openTextDocument(contentUri),
				vscode.workspace.openTextDocument(xmlUri)
			]);

			assert.equal(vscode.workspace.fs.isWritableFileSystem(contentUri.scheme), undefined);
			assert.equal(vscode.workspace.fs.isWritableFileSystem(xmlUri.scheme), undefined);
			assert.equal(contentDocument.getText(), source);
			assert.match(xmlDocument.getText(), /<资源 单元="窗口" \/>/u);
			assert.match(
				xmlDocument.getText(),
				/<定义 名称="RestorePreview" 组件="窗口">\r?\n\s*<\/定义>/u
			);
			assert.doesNotMatch(xmlDocument.getText(), /<定义 名称="RestorePreview" 组件="窗口" \/>/u);
		} finally {
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("窗口单元通过命令打开自定义设计器标签页", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		const filePath = testProjectPath(
			"Tetris",
			"src",
			"simple",
			"samples",
			"tetris",
			"Tetris.simple"
		);

		await vscode.commands.executeCommand("es4a.openDesigner", {
			filePath,
			kind: "unit",
			label: "Tetris",
			unitType: "窗口"
		});
		let input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
		for (let attempt = 0; attempt < 25 && !(input instanceof vscode.TabInputCustom); attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
		}
		assert.ok(input instanceof vscode.TabInputCustom);
		assert.equal(input.viewType, "es4a.simpleDesigner");
		assert.equal(input.uri.scheme, SIMPLE_CODE_SCHEME);
		assert.equal(path.basename(input.uri.path), "Tetris(设计器)");
		assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab?.label, "Tetris(设计器)");
		assert.equal(
			resolveDesignerTabSourceUri(vscode.window.tabGroups.activeTabGroup.activeTab)?.fsPath.toLowerCase(),
			filePath.toLowerCase()
		);
		assert.equal(resolveDesignerTabSourceUri(undefined), undefined);
		const previousClipboard = await vscode.env.clipboard.readText();
		try {
			await vscode.commands.executeCommand("es4a.copyUnitAbsolutePath", input.uri);
			assert.equal(
				path.normalize(await vscode.env.clipboard.readText()).toLowerCase(),
				path.normalize(filePath).toLowerCase()
			);
			await vscode.commands.executeCommand("es4a.copyUnitRelativePath", input.uri);
			assert.equal(
				path.normalize(await vscode.env.clipboard.readText()).toLowerCase(),
				path.normalize(vscode.workspace.asRelativePath(vscode.Uri.file(filePath), false)).toLowerCase()
			);
		} finally {
			await vscode.env.clipboard.writeText(previousClipboard);
		}
		const provider = new ProgramTreeProvider();
		const windowItem = provider.getTreeItem({
			filePath,
			kind: "unit",
			label: "Tetris",
			unitType: "窗口"
		});
		assert.equal(windowItem.contextValue, "es4a.windowUnit");
		assert.equal(windowItem.resourceUri?.fsPath.toLowerCase(), filePath.toLowerCase());
		const resourceItem = provider.getTreeItem({ filePath, kind: "file", label: "Tetris.simple" });
		assert.equal(resourceItem.contextValue, "es4a.file");
		assert.equal(resourceItem.resourceUri?.fsPath.toLowerCase(), filePath.toLowerCase());
		assert.equal(
			(resourceItem.command?.arguments?.[0] as vscode.Uri).fsPath.toLowerCase(),
			filePath.toLowerCase()
		);
		provider.dispose();
		await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
	});

	test("非窗口单元拒绝打开窗口设计器", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension);
		const filePath = testProjectPath(
			"Tetris", "src", "simple", "samples", "tetris", "DownStep.simple"
		);
		await vscode.commands.executeCommand("es4a.openDesigner", {
			filePath,
			kind: "unit",
			label: "DownStep",
			unitType: "对象"
		});
		assert.equal(vscode.window.tabGroups.all.flatMap((group) => group.tabs).some((tab) => (
			tab.input instanceof vscode.TabInputCustom
			&& toSimpleSourceUri(tab.input.uri)?.fsPath === filePath
		)), false);
	});

	test("项目状态缺失时关闭干净恢复标签并只保留未保存代码", async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-orphan-tabs-"));
		const cleanFile = path.join(temporaryDirectory, "CleanWindow.simple");
		const dirtyFile = path.join(temporaryDirectory, "DirtyWindow.simple");
		const windowSource = [
			"' 标签恢复测试",
			"",
			"$属性",
			"\t$资源 $窗口",
			"$结束 $属性",
			""
		].join("\r\n");
		const tabsForFile = (filePath: string): readonly vscode.Tab[] => (
			vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => {
				const binding = resolveSimpleUnitTab(tab);
				return binding !== undefined && sameLocalPath(binding.sourceUri.fsPath, filePath);
			})
		);

		try {
			await fs.writeFile(cleanFile, windowSource, "utf8");
			const cleanUri = toSimpleCodeUri(vscode.Uri.file(cleanFile));
			await vscode.window.showTextDocument(
				await vscode.workspace.openTextDocument(cleanUri),
				{ preview: false }
			);
			await vscode.commands.executeCommand("vscode.openWith", cleanUri, "es4a.simpleDesigner");
			assert.ok(tabsForFile(cleanFile).length >= 1);

			const cleanResult = await reconcileSimpleUnitTabs([]);
			assert.ok(cleanResult.closed >= 1);
			assert.equal(cleanResult.retainedDirtySources.length, 0);
			assert.equal(tabsForFile(cleanFile).length, 0);

			await fs.writeFile(dirtyFile, windowSource, "utf8");
			const dirtyUri = toSimpleCodeUri(vscode.Uri.file(dirtyFile));
			const dirtyDocument = await vscode.workspace.openTextDocument(dirtyUri);
			await vscode.window.showTextDocument(dirtyDocument, { preview: false });
			const edit = new vscode.WorkspaceEdit();
			edit.insert(dirtyUri, new vscode.Position(0, 0), "' 未保存\r\n");
			assert.equal(await vscode.workspace.applyEdit(edit), true);
			assert.equal(dirtyDocument.isDirty, true);
			await vscode.commands.executeCommand("vscode.openWith", dirtyUri, "es4a.simpleDesigner");

			const dirtyResult = await reconcileSimpleUnitTabs([]);
			assert.equal(dirtyResult.retainedDirtySources.length, 1);
			assert.equal(tabsForFile(dirtyFile).some((tab) => (
				tab.input instanceof vscode.TabInputCustom
			)), false);
			assert.equal(tabsForFile(dirtyFile).some((tab) => (
				tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === SIMPLE_CODE_SCHEME
			)), true);
			assert.equal(await dirtyDocument.save(), true);
		} finally {
			const tabs = [...tabsForFile(cleanFile), ...tabsForFile(dirtyFile)];
			if (tabs.length > 0) {
				await vscode.window.tabGroups.close(tabs, true);
			}
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("后台设计器只在真正可见时初始化并生成模型", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		const document = await vscode.workspace.openTextDocument({
			content: "",
			language: "simple"
		});
		const messageEmitter = new vscode.EventEmitter<unknown>();
		const disposeEmitter = new vscode.EventEmitter<void>();
		const viewStateEmitter = new vscode.EventEmitter<vscode.WebviewPanelOnDidChangeViewStateEvent>();
		let visible = false;
		let htmlAssignments = 0;
		let renderMessages = 0;
		let html = "";
		const webview = {
			asWebviewUri: (uri: vscode.Uri) => uri,
			cspSource: "vscode-webview://designer-test",
			get html() {
				return html;
			},
			set html(value: string) {
				html = value;
				htmlAssignments += 1;
			},
			onDidReceiveMessage: messageEmitter.event,
			options: {},
			postMessage: () => {
				renderMessages += 1;
				return Promise.resolve(true);
			}
		} as unknown as vscode.Webview;
		const panel = {
			active: false,
			onDidChangeViewState: viewStateEmitter.event,
			onDidDispose: disposeEmitter.event,
			viewColumn: vscode.ViewColumn.One,
			get visible() {
				return visible;
			},
			webview
		} as unknown as vscode.WebviewPanel;
		const provider = new SimpleDesignerProvider(
			{
				getProperty: () => ({ issues: ["测试属性状态"], status: "damaged" })
			} as unknown as SimpleCodeFileSystemProvider,
			extension.extensionUri,
			memoryDesignerPreferenceState()
		);
		const designerDocument = new SimpleDesignerDocument(
			document.uri,
			document,
			new vscode.Disposable(() => undefined)
		);

		try {
			provider.resolveCustomEditor(designerDocument, panel);
			assert.equal(htmlAssignments, 0);
			assert.equal(renderMessages, 0);

			visible = true;
			viewStateEmitter.fire({ webviewPanel: panel });
			assert.equal(htmlAssignments, 1);
			messageEmitter.fire({ type: "ready" });
			assert.equal(renderMessages, 1);

			visible = false;
			viewStateEmitter.fire({ webviewPanel: panel });
			provider.refreshDocument(document);
			assert.equal(renderMessages, 1);

			visible = true;
			viewStateEmitter.fire({ webviewPanel: panel });
			assert.equal(htmlAssignments, 1);
			assert.equal(renderMessages, 2);
		} finally {
			designerDocument.dispose();
			provider.dispose();
			messageEmitter.dispose();
			disposeEmitter.dispose();
			viewStateEmitter.dispose();
		}
	});

	test("设计器标签页内嵌属性框、布局树、画布和组件列表", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		const source = await fs.readFile(testProjectPath(
			"Tetris", "src", "simple",
			"samples", "tetris", "Tetris.simple"
		), "utf8");
		const result = inspectSimplePropertyXml(source);
		const sdk = await loadSdk(path.resolve(extension.extensionPath, "..", "sdk", "sdk.json"));
		const defaultComponentIconPath = path.resolve(
			extension.extensionPath,
			"icons",
			"component-default.svg"
		);
		const model = createDesignerWebviewModel(
			result,
			"/属性/定义[1]",
			sdk,
			"Tetris",
			"designer-test",
			defaultComponentIconPath,
			undefined,
			splitSimpleUnitSource(source).userCode
		);
		assert.deepEqual(model.displayOptions, {
			componentLabelsVisible: false,
			designerDebug: false,
			layoutHoverSync: false
		});
		assert.equal(model.componentEvents.some((group) => (
			group.events.some((event) => event.name === "计时" && event.existing)
		)), true);
		const designerDirectory = path.resolve(extension.extensionPath, "dist", "designer");
		const [html, css, client, providerSource, mainSource, unitTabsSource] = await Promise.all([
			fs.readFile(path.join(designerDirectory, "designer.html"), "utf8"),
			fs.readFile(path.join(designerDirectory, "designer.css"), "utf8"),
			fs.readFile(path.join(designerDirectory, "designerClient.js"), "utf8"),
			fs.readFile(path.resolve(extension.extensionPath, "src", "designerWebview.ts"), "utf8"),
			fs.readFile(path.resolve(extension.extensionPath, "src", "main.ts"), "utf8"),
			fs.readFile(path.resolve(extension.extensionPath, "src", "simpleUnitTabs.ts"), "utf8")
		]);
		const designerSourceDirectory = path.resolve(extension.extensionPath, "src", "designer");
		const [appSource, propertySource, layoutSource, layoutNodeSource, canvasSource, nodeSource, toolboxSource, enabledSource, menuSource, viewSource, relativeSource] = await Promise.all([
			fs.readFile(path.join(designerSourceDirectory, "DesignerApp.vue"), "utf8"),
			fs.readFile(path.join(designerSourceDirectory, "PropertyPanel.vue"), "utf8"),
			fs.readFile(path.join(designerSourceDirectory, "LayoutTree.vue"), "utf8"),
			fs.readFile(path.join(designerSourceDirectory, "LayoutTreeNode.vue"), "utf8"),
			fs.readFile(path.join(designerSourceDirectory, "DesignerCanvas.vue"), "utf8"),
			fs.readFile(path.join(designerSourceDirectory, "DesignerNode.vue"), "utf8"),
			fs.readFile(path.join(designerSourceDirectory, "ToolboxPanel.vue"), "utf8"),
			fs.readFile(path.join(designerSourceDirectory, "EnabledComponents.vue"), "utf8"),
			fs.readFile(path.join(designerSourceDirectory, "DesignerContextMenu.vue"), "utf8"),
			fs.readFile(path.join(designerSourceDirectory, "designerView.ts"), "utf8"),
			fs.readFile(path.join(designerSourceDirectory, "designerRelativeLayout.ts"), "utf8")
		]);

		assert.match(html, /<div id="designer-app"><\/div>/u);
		assert.match(html, /href="\{\{STYLE_URI\}\}"/u);
		assert.match(html, /src="\{\{SCRIPT_URI\}\}"/u);
		assert.match(html, /font-src \{\{CSP_SOURCE\}\}/u);
		assert.match(html, /img-src data:/u);
		assert.match(await fs.readFile(path.resolve(extension.extensionPath, "esbuild.js"), "utf8"), /"\.ttf": "file"/u);
		assert.doesNotMatch(html, /designer-shell|property-row|component-context-menu|Tetris/u);
		assert.match(client, /createApp/u);
		assert.match(client, /renderList/u);
		assert.doesNotMatch(client, /function renderPropertyPanel|function renderLayout|replaceChildren\(/u);
		assert.match(appSource, /v-for="columnId in columnOrder"/u);
		assert.match(appSource, /<PropertyPanel/u);
		assert.match(appSource, /aria-label="全部折叠属性"[\s\S]*?codicon codicon-collapse-all[\s\S]*?aria-label="全部展开属性"[\s\S]*?codicon codicon-expand-all/u);
		assert.match(appSource, /@click\.stop="collapseAllPropertyGroups"[\s\S]*?@pointerdown\.stop/u);
		assert.match(appSource, /@click\.stop="expandAllPropertyGroups"[\s\S]*?@pointerdown\.stop/u);
		assert.match(appSource, /:ref="setPropertyPanelRef"/u);
		assert.match(appSource, /propertyPanel\?\.expandAllPropertyGroups\(\)/u);
		assert.match(appSource, /propertyPanel\?\.collapseAllPropertyGroups\(\)/u);
		assert.match(appSource, /aria-label="全部折叠可用组件"[\s\S]*?codicon codicon-collapse-all[\s\S]*?aria-label="全部展开可用组件"[\s\S]*?codicon codicon-expand-all/u);
		assert.match(appSource, /aria-label="全部展开可用组件"[\s\S]*?@click\.stop="expandAllToolboxGroups"/u);
		assert.match(appSource, /aria-label="全部折叠可用组件"[\s\S]*?@click\.stop="collapseAllToolboxGroups"/u);
		assert.match(appSource, /<ToolboxPanel :ref="setToolboxPanelRef"/u);
		assert.match(appSource, /toolboxPanel\?\.expandAllToolboxGroups\(\)/u);
		assert.match(appSource, /toolboxPanel\?\.collapseAllToolboxGroups\(\)/u);
		assert.match(appSource, /:hover-hint="selectedComponentHoverHint"/u);
		assert.match(appSource, /projection\.selectedPath === undefined[\s\S]*?\? projection\.root[\s\S]*?: findDesignerComponentNode\(projection\.root, projection\.selectedPath\)/u);
		assert.match(appSource, /findDesignerComponentNode\(projection\.root, projection\.selectedPath\)/u);
		assert.match(appSource, /<LayoutTree/u);
		assert.match(appSource, /<LayoutTree[\s\S]*?:hovered-path="layoutHoverSync \? hoveredComponentPath : undefined"/u);
		assert.match(appSource, /<DesignerCanvas[\s\S]*?@hover="hoverComponent"/u);
		assert.match(appSource, /const hoveredComponentPath = ref<string>\(\)/u);
		assert.match(appSource, /function hoverComponent\(xmlPath: string \| undefined\): void \{[\s\S]*?componentIdentity\(xmlPath\)\?\.xmlPath/u);
		assert.match(appSource, /<span class="section-title-label">布局<\/span>[\s\S]*?v-if="layoutComponentCount > 0"[\s\S]*?class="section-title-count section-title-count-inline"[\s\S]*?title="布局组件总数"[\s\S]*?\{\{ layoutComponentCount \}\}/u);
		assert.match(appSource, /<span class="section-title-label">可用<\/span>[\s\S]*?v-if="toolboxComponentCount > 0"[\s\S]*?class="section-title-count section-title-count-inline"[\s\S]*?title="可用组件总数"[\s\S]*?\{\{ toolboxComponentCount \}\}/u);
		assert.match(appSource, /const toolboxComponentCount = computed\(\(\) => message\.value\?\.projection\.toolbox\.reduce\([\s\S]*?count \+ group\.items\.length[\s\S]*?\) \?\? 0\);/u);
		assert.match(appSource, /function countLayoutComponents\(node: DesignerComponentNode \| undefined\): number[\s\S]*?return 1 \+ node\.children\.reduce\(\(count, child\) => count \+ countLayoutComponents\(child\), 0\)/u);
		assert.match(appSource, /computed\(\(\) => countLayoutComponents\(message\.value\?\.projection\.root\)\)/u);
		assert.match(css, /\.section-title-count \{[^}]*margin-left: auto;[^}]*color: var\(--vscode-descriptionForeground\);[^}]*font-weight: 400;/u);
		assert.match(css, /\.section-title-count-inline \{[^}]*margin-left: 5px;/u);
		assert.match(appSource, /const layoutHoverSync = ref\(DEFAULT_DESIGNER_DISPLAY_OPTIONS\.layoutHoverSync\)/u);
		assert.match(appSource, /:title="layoutHoverSync \? '关闭悬停同步' : '开启悬停同步'"[\s\S]*?:aria-label="layoutHoverSync \? '关闭悬停同步' : '开启悬停同步'"[\s\S]*?:aria-pressed="layoutHoverSync"[\s\S]*?@click\.stop="toggleLayoutHoverSync"[\s\S]*?codicon codicon-inspect/u);
		assert.match(appSource, /function toggleLayoutHoverSync\(\): void \{[\s\S]*?layoutHoverSync\.value = !layoutHoverSync\.value/u);
		assert.match(appSource, /<EnabledComponents/u);
		assert.match(appSource, /<EnabledComponents[\s\S]*?@hover="hoverComponent"/u);
		assert.match(appSource, /<span class="section-title-label">启用<\/span>[\s\S]*?v-if="message\.projection\.nonVisualComponents\.length > 0"[\s\S]*?class="section-title-count section-title-count-inline"[\s\S]*?title="已启用组件总数"[\s\S]*?\{\{ message\.projection\.nonVisualComponents\.length \}\}/u);
		assert.match(enabledSource, /@pointerenter="\$emit\('hover', component\.path\)"[\s\S]*?@pointerleave="\$emit\('hover', undefined\)"/u);
		assert.match(enabledSource, /hover: \[xmlPath: string \| undefined\]/u);
		assert.match(appSource, /<ToolboxPanel/u);
		assert.match(appSource, /<DesignerCanvas/u);
		assert.match(appSource, /const designerDebug = ref\(DEFAULT_DESIGNER_DISPLAY_OPTIONS\.designerDebug\)/u);
		assert.match(appSource, /const componentLabelsVisible = ref\(DEFAULT_DESIGNER_DISPLAY_OPTIONS\.componentLabelsVisible\)/u);
		assert.match(appSource, /<span class="section-title-label">投影<\/span>\s*<span class="section-title-actions">[\s\S]*?@click\.stop="toggleComponentLabels"[\s\S]*?@click\.stop="toggleDesignerDebug"/u);
		assert.match(appSource, /columnId === 'projection'[\s\S]*?data-designer-column="projection"/u);
		assert.match(css, /\.projection-section \{[^}]*width: fit-content;/u);
		assert.match(appSource, /:title="componentLabelsVisible \? '隐藏组件名称' : '显示组件名称'"[\s\S]*?:aria-label="componentLabelsVisible \? '隐藏组件名称' : '显示组件名称'"[\s\S]*?:aria-pressed="componentLabelsVisible"[\s\S]*?codicon codicon-symbol-constant/u);
		assert.match(appSource, /function toggleComponentLabels\(\): void \{[\s\S]*?componentLabelsVisible\.value = !componentLabelsVisible\.value;[\s\S]*?updateDisplayOption\("componentLabelsVisible", componentLabelsVisible\.value\)/u);
		assert.match(appSource, /:title="designerDebug \? '关闭调试模式' : '开启调试模式'"[\s\S]*?:aria-label="designerDebug \? '关闭调试模式' : '开启调试模式'"/u);
		assert.match(appSource, /:aria-pressed="designerDebug"[\s\S]*?@click\.stop="toggleDesignerDebug"[\s\S]*?codicon codicon-bug/u);
		assert.match(appSource, /function toggleDesignerDebug\(\): void \{[\s\S]*?designerDebug\.value = !designerDebug\.value;[\s\S]*?updateDisplayOption\("designerDebug", designerDebug\.value\)/u);
		assert.match(appSource, /<DesignerCanvas[\s\S]*?:debug="designerDebug"/u);
		assert.match(appSource, /<DesignerCanvas[\s\S]*?:show-component-labels="componentLabelsVisible"/u);
		assert.match(css, /\.section-title-action\[aria-pressed=(?:"true"|true)\] \{[^}]*background: var\(--vscode-button-background\);/u);
		assert.match(appSource, /<DesignerContextMenu/u);
		assert.equal((appSource.match(/class="section-title designer-column-handle"/gu) ?? []).length, 4);
		assert.equal((appSource.match(/class="section-title designer-column-handle" data-designer-column-handle draggable="true"/gu) ?? []).length, 4);
		assert.match(propertySource, /codicon codicon-layout codicon-placeholder/u);
		assert.equal((await fs.stat(path.join(designerDirectory, "codicon.ttf"))).isFile(), true);
		assert.match(propertySource, /v-for="group in model\.groups"/u);
		assert.match(propertySource, /codicon codicon-fold group-disclosure-closed[\s\S]*?codicon codicon-unfold group-disclosure-open/u);
		assert.match(propertySource, /codicon codicon-chevron-down property-choice-arrow/u);
		assert.doesNotMatch(css, /\.property-choice-arrow::before[^}]*border-top/u);
		assert.match(css, /\.property-choice-arrow,\s*\.property-clear > \.codicon \{[^}]*width: 16px;[^}]*height: 16px;[^}]*line-height: 16px;[^}]*place-items: center;/u);
		assert.match(css, /\.property-choice-arrow \{[^}]*color: var\(--vscode-descriptionForeground\);/u);
		assert.match(css, /\.property-choice-trigger:hover \.property-choice-arrow,\s*\.property-choice-trigger:focus \.property-choice-arrow \{[^}]*color: var\(--vscode-foreground\);/u);
		assert.match(css, /\.property-clear \{[^}]*display: grid;[^}]*width: 24px;[^}]*height: 24px;[^}]*overflow: hidden;[^}]*place-items: center;/u);
		assert.match(css, /\.property-clear:hover,\s*\.property-clear:focus \{[^}]*color: var\(--vscode-foreground\);/u);
		assert.match(css, /\.property-choice-arrow::before,\s*\.property-clear > \.codicon::before \{[^}]*transform: none;/u);
		assert.match(propertySource, /function collapseAllPropertyGroups[\s\S]*?querySelectorAll<HTMLDetailsElement>\("\.property-group"\)[\s\S]*?group\.open = false/u);
		assert.match(propertySource, /function expandAllPropertyGroups[\s\S]*?querySelectorAll<HTMLDetailsElement>\("\.property-group"\)[\s\S]*?group\.open = true/u);
		assert.match(propertySource, /defineExpose\(\{ collapseAllPropertyGroups, expandAllPropertyGroups \}\)/u);
		assert.match(propertySource, /v-for="row in group\.rows"/u);
		assert.match(propertySource, /:title="model\.component === true \? hoverHint : undefined"/u);
		assert.match(propertySource, /v-overflow-title="propertyValueDisplayText\(row\)"/u);
		assert.doesNotMatch(propertySource, /class="column-header"/u);
		assert.doesNotMatch(propertySource, />属性名<|>属性值</u);
		assert.match(css, /\.component-header \{[^}]*position: sticky;[^}]*top: 0;[^}]*z-index: 3;/u);
		assert.doesNotMatch(propertySource, /class="property-value" role="cell" :title="propertyHoverHint/u);
		assert.match(propertySource, /v-if="row\.choices === undefined \|\| row\.allowCustomValue === true"/u);
		assert.match(propertySource, /v-if="row\.color !== undefined"/u);
		assert.match(propertySource, /type="color"/u);
		assert.match(propertySource, /@change="changeColorProperty\(\$event, row\)"/u);
		assert.match(propertySource, /"data-color-alpha": row\.color\?\.alpha \?\? ""/u);
		assert.match(propertySource, /"data-selected-xml-path": props\.selectedPath \?\? ""/u);
		assert.match(appSource, /element\.type === "color"/u);
		assert.match(appSource, /element\.dataset\.selectedXmlPath/u);
		assert.match(appSource, /`&H\$\{colorAlpha\}\$\{color\.toUpperCase\(\)\}`/u);
		assert.doesNotMatch(propertySource, /<datalist/u);
		assert.doesNotMatch(propertySource, /<select/u);
		assert.match(propertySource, /<Teleport to="body">/u);
		assert.match(propertySource, /'property-choice-trigger-full': row\.allowCustomValue !== true/u);
		assert.match(propertySource, /class="property-choice-menu"\s+role="listbox"/u);
		assert.match(propertySource, /class="codicon codicon-chevron-down property-choice-arrow" aria-hidden="true"/u);
		assert.match(propertySource, /@click="choosePropertyOption\(\$event, choice\.value\)"/u);
		assert.match(css, /\.property-choice-menu \{[^}]*position: fixed;[^}]*max-height: min\(240px, 50vh\);[^}]*overflow-y: auto;/u);
		assert.match(css, /\.property-choice-option:hover,\s*\.property-choice-option:focus \{[^}]*background: var\(--vscode-list-activeSelectionBackground\);/u);
		assert.doesNotMatch(css, /\.property-choice-option:hover,\s*\.property-choice-option:focus \{[^}]*color:/u);
		assert.match(
			css,
			/\.section-content,\s*\.nonvisual-list,\s*\.property-choice-menu,\s*#component-event-menu-items,\s*#enabled-component-event-menu-items,\s*\.window-layout-surface\.window-scrollable,\s*\.container-scroll-vertical\s*\{\s*overscroll-behavior-y: contain;/u
		);
		assert.match(css, /\.property-color-input \{[^}]*position: absolute;[^}]*opacity: 0;/u);
		assert.match(propertySource, /document\.addEventListener\("scroll", closePropertyChoiceMenuFromScroll, true\)/u);
		assert.match(propertySource, /:title="row\.editTarget\.effect === 'editComponentComment' \? '清除注释' : '清除赋值'"/u);
		assert.match(propertySource, /class="codicon codicon-close-small" aria-hidden="true"/u);
		assert.match(propertySource, /const submission = propertySelectSubmission\(value\);/u);
		assert.match(propertySource, /v-if="row\.choices !== undefined && propertyChoiceMenuOpen\(row\)"[\s\S]*?v-if="row\.valueSource === 'explicit' && row\.editTarget\.removeElementWhenEmpty === true"[\s\S]*?>清除赋值<\/button>/u);
		assert.match(propertySource, /v-if="row\.choices === undefined && row\.valueSource === 'explicit' && \(row\.editTarget\.removeElementWhenEmpty === true \|\| row\.editTarget\.effect === 'editComponentComment'\)"/u);
		assert.doesNotMatch(propertySource, /row\.allowCustomValue === true \|\| \(row\.defaultExpression/u);
		assert.match(propertySource, /:data-atomic-expression="isAtomicPropertyExpression\(row\) \? 'true' : 'false'"/u);
		assert.match(propertySource, /@beforeinput="propertyBeforeInput"/u);
		assert.match(propertySource, /@blur="blurProperty"/u);
		assert.doesNotMatch(propertySource, /@change="changeProperty"/u);
		assert.match(propertySource, /@click="selectAtomicPropertyInput"/u);
		assert.match(propertySource, /event\.key === "Backspace" \|\| event\.key === "Delete"/u);
		assert.match(propertySource, /data-string-literal-input/u);
		assert.match(layoutSource, /<LayoutTreeNode/u);
		assert.match(layoutSource, /:hovered-path="hoveredPath"/u);
		assert.match(layoutSource, /watch\(\(\) => props\.hoveredPath, async \(path\) => \{[\s\S]*?revealTreeItem\("\.layout-tree-item\.hovered"\)/u);
		assert.match(layoutSource, /function revealTreeItem[\s\S]*?element\.scrollTop -=[\s\S]*?element\.scrollTop \+=/u);
		assert.doesNotMatch(layoutSource, /scrollIntoView/u);
		assert.match(layoutNodeSource, /hovered: node\.path === hoveredPath/u);
		assert.match(layoutNodeSource, /:hovered-path="hoveredPath"/u);
		assert.match(css, /\.layout-tree-item:hover,\s*\.layout-tree-item\.hovered \{[^}]*background: var\(--vscode-list-hoverBackground\);/u);
		assert.match(canvasSource, /<DesignerNode/u);
		assert.match(canvasSource, /hover: \[xmlPath: string \| undefined\]/u);
		assert.match(canvasSource, /watch\(hoveredComponentPath, \(path\) => emit\("hover", path\)\)/u);
		assert.match(canvasSource, /@dblclick="openRootCode"/u);
		assert.match(canvasSource, /closest<HTMLElement>\("\[data-component-path\]"\)/u);
		assert.match(canvasSource, /component\?\.dataset\.componentPath === props\.projection\.root\?\.path/u);
		assert.match(nodeSource, /<DesignerNode/u);
		assert.match(nodeSource, /data-component-type/u);
		assert.match(nodeSource, /:data-hover-hint="hoverHint"[\s\S]*?:title="hoverHint"/u);
		assert.doesNotMatch(nodeSource, /nativeHoverHint|COMPONENT_MOVE_HINT/u);
		assert.equal((nodeSource.match(/:draggable="node\.layoutReadOnly !== true && \(node\.positionReadOnly !== true \|\| node\.positionDraggable === true\) && node\.path === selectedPath"/gu) ?? []).length, 1);
		assert.match(nodeSource, /:draggable="node\.layoutReadOnly !== true && \(node\.positionReadOnly !== true \|\| node\.positionDraggable === true\) && node\.path === selectedPath"[\s\S]*?@click\.stop\s*>/u);
		assert.doesNotMatch(nodeSource, /stopComponentClick/u);
		assert.match(nodeSource, /v-if="cell\.occupiedComponent !== undefined"/u);
		assert.match(canvasSource, /v-if="cell\.occupiedComponent !== undefined"/u);
		assert.match(canvasSource, /function componentPathAtPoint[\s\S]*?document\.elementsFromPoint\(clientX, clientY\)/u);
		assert.match(canvasSource, /@pointerdown\.capture="selectComponentAtPointer"/u);
		assert.match(canvasSource, /function componentPathFromPointer[\s\S]*?event\.composedPath\(\)[\s\S]*?componentPathAtPoint\(event\.clientX, event\.clientY\)/u);
		assert.match(canvasSource, /function selectComponentAtPointer[\s\S]*?componentPathFromPointer\(event\)[\s\S]*?hoveredComponentPath\.value = path;[\s\S]*?emit\("select", path\)/u);
		assert.match(canvasSource, /function trackHoveredComponent[\s\S]*?componentPathFromPointer\(event\)/u);
		assert.match(canvasSource, /hoveredPointer = \{ clientX: event\.clientX, clientY: event\.clientY \}/u);
		assert.match(canvasSource, /function refreshHoveredComponentAfterModelChange[\s\S]*?componentPathAtPoint\(pointer\.clientX, pointer\.clientY\)/u);
		assert.match(canvasSource, /watch\(\(\) => props\.projection,[\s\S]*?hoveredComponentPath\.value = undefined;[\s\S]*?refreshHoveredComponentAfterModelChange\(\);/u);
		assert.doesNotMatch(canvasSource + nodeSource, /hovered-path|hoveredPath|hovered: projection\.root\.path/u);
		assert.match(canvasSource, /v-if="selectedComponentName !== undefined && selectedVisualComponent !== undefined"/u);
		assert.doesNotMatch(canvasSource, /v-if="dragHoveredPath === undefined && selectedComponentName/u);
		assert.match(canvasSource, /v-if="selectedFeedbackPath !== undefined"/u);
		assert.match(canvasSource, /class="designer-component-feedback designer-component-feedback-selected"[^>]*:data-component-path="selectedFeedbackPath"/u);
		assert.match(canvasSource, /const selectedFeedbackPath = computed[\s\S]*?findProjectedComponent\(root, path\)\?\.visual === true \? path : undefined/u);
		assert.match(canvasSource, /v-if="dragHoveredPath === undefined && hoveredFeedbackPath !== undefined"[\s\S]*?designer-component-feedback-hovered/u);
		assert.match(canvasSource, /class="designer-component-name designer-component-name-selected"[^>]*:data-selected-move-path="selectedVisualComponent\.positionReadOnly === true && selectedVisualComponent\.positionDraggable !== true \? undefined : selectedVisualComponent\.path"[^>]*:draggable="selectedVisualComponent\.positionReadOnly !== true \|\| selectedVisualComponent\.positionDraggable === true"/u);
		assert.match(canvasSource, /class="designer-component-name designer-component-name-selected"[^>]*:title="componentHoverHint\(selectedVisualComponent\)"/u);
		assert.doesNotMatch(canvasSource, /class="designer-component-feedback designer-component-feedback-selected"[^>]*:data-selected-move-path=/u);
		assert.match(canvasSource, /v-if="hoveredComponentName !== undefined && displayedHoveredPath !== projection\.selectedPath"/u);
		assert.match(appSource, /function visualComponentAtPoint[\s\S]*?document\.elementsFromPoint\(event\.clientX, event\.clientY\)/u);
		assert.match(appSource, /data-selected-move-path[\s\S]*?component\.contains\(movedComponent\)[\s\S]*?return movedComponent/u);
		assert.match(appSource, /\? visualComponentAtPoint\(event\) \?\?/u);
		assert.match(css, /\.designer-component-feedback \{[^}]*box-shadow: inset 0 0 0 var\(--designer-feedback-line-width\) var\(--designer-component-interaction-color\);[^}]*pointer-events: none;/u);
		assert.match(css, /\.designer-component-feedback-hovered \{[^}]*--designer-feedback-line-width: var\(--designer-component-hover-line-width\);[^}]*z-index: 2;/u);
		assert.doesNotMatch(css, /\.(?:visual-node|window-node)\.hovered:not\(\.selected\)/u);
		assert.doesNotMatch(css, /\.visual-node:hover/u);
		assert.doesNotMatch(nodeSource, /componentBorderSides|designer-component-border-hit/u);
		assert.doesNotMatch(appSource, /isPointOnComponentBorder|componentBorderPointerPath/u);
		assert.match(appSource, /const SELECTED_MOVE_SELECTOR = "\.designer-component-name-selected\[data-selected-move-path\]"/u);
		assert.match(appSource, /const VISUAL_DRAG_COMPONENT_SELECTOR = "\.visual-node\[data-drag-component-path\]"/u);
		assert.match(appSource, /function visualComponentByPath[\s\S]*?querySelectorAll<HTMLElement>\(VISUAL_DRAG_COMPONENT_SELECTOR\)[\s\S]*?element\.dataset\.dragComponentPath === path/u);
		assert.match(appSource, /function selectedVisualDragSource[\s\S]*?target\.closest<HTMLElement>\(SELECTED_MOVE_SELECTOR\)[\s\S]*?visualComponentByPath\(canvas, movePath\)/u);
		assert.match(appSource, /const component = target\.closest<HTMLElement>\(VISUAL_DRAG_COMPONENT_SELECTOR\)[\s\S]*?!component\.classList\.contains\("selected"\)[\s\S]*?component\.draggable !== true/u);
		assert.match(appSource, /visualDragSource = selectedVisualDragSource\(event\.target\)[\s\S]*?component = visualDragSource\.component/u);
		assert.match(appSource, /pointerOffsetLeft: componentDragPointerOffset\([\s\S]*?visualDragSource\?\.fromLabel === true[\s\S]*?pointerOffsetTop: componentDragPointerOffset/u);
		assert.match(appSource, /const TOOLBOX_VISUAL_PREVIEW_SIZE = 32/u);
		assert.match(appSource, /const visual = item\.dataset\.visual === "true";[\s\S]*?previewHeight: visual \? TOOLBOX_VISUAL_PREVIEW_SIZE : undefined[\s\S]*?if \(visual\) hideNativeDragImage\(event\);[\s\S]*?else setDragImage\(event, item, "\.component-icon-toolbox"\)/u);
		assert.match(appSource, /if \(visualDragSource\?\.fromLabel !== true\) \{[\s\S]*?document\.body\.classList\.add\("component-dragging"\);[\s\S]*?function onDragOver[\s\S]*?document\.body\.classList\.add\("component-dragging"\);/u);
		assert.doesNotMatch(appSource, /selectedMoveSource/u);
		assert.doesNotMatch(appSource, /componentPointerPath/u);
		assert.match(css, /\.designer-canvas \{[^}]*-webkit-user-select: none;[^}]*user-select: none;/u);
		assert.match(css, /\.designer-label-layer \{[^}]*z-index: var\(--designer-label-layer\);/u);
		assert.match(css, /\.designer-component-name \{[^}]*display: flex;[^}]*align-items: center;[^}]*height: 20px;[^}]*padding: 0 5px;[^}]*pointer-events: none;/u);
		assert.match(css, /\.designer-component-name-text \{[^}]*min-width: 0;[^}]*overflow: hidden;[^}]*line-height: 16px;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/u);
		assert.match(canvasSource, /<span class="designer-component-name-text">\{\{ selectedComponentName \}\}<\/span>/u);
		assert.match(canvasSource, /<span class="designer-component-name-text">\{\{ hoveredComponentName \}\}<\/span>/u);
		assert.match(canvasSource, /<div v-if="showComponentLabels" class="designer-label-layer">/u);
		assert.match(canvasSource, /readonly showComponentLabels: boolean/u);
		assert.match(canvasSource, /displayedHoveredPath\.value,[\s\S]*?props\.showComponentLabels[\s\S]*?refreshNameOverlays/u);
		assert.match(css, /\.designer-component-name-selected,\s*\.designer-component-name-hovered \{[^}]*border: 1px solid var\(--designer-component-interaction-color\);[^}]*color: #fff;[^}]*background: var\(--designer-component-interaction-color\);/u);
		assert.match(css, /\.designer-component-name-selected \{[^}]*border-radius: 3px;[^}]*font-weight: 400;[^}]*cursor: move;[^}]*pointer-events: auto;/u);
		assert.match(css, /\.designer-component-name-hovered \{[^}]*border-radius: 3px;[^}]*font-style: italic;[^}]*font-weight: 400;/u);
		assert.doesNotMatch(css, /\.designer-component-name-selected:active/u);
		assert.match(canvasSource, /const COMPONENT_NAME_GAP = 2/u);
		assert.doesNotMatch(canvasSource, /gap = 0/u);
		assert.match(toolboxSource, /v-for="group in groups"/u);
		assert.match(toolboxSource, /function collapseAllToolboxGroups[\s\S]*?for \(const group of props\.groups\) collapsedGroups\.add\(group\.name\)/u);
		assert.match(toolboxSource, /function expandAllToolboxGroups[\s\S]*?collapsedGroups\.clear\(\)/u);
		assert.match(toolboxSource, /defineExpose\(\{ collapseAllToolboxGroups, expandAllToolboxGroups \}\)/u);
		assert.match(toolboxSource, /codicon codicon-fold group-disclosure-closed[\s\S]*?codicon codicon-unfold group-disclosure-open/u);
		assert.doesNotMatch(css, /\.toolbox-group-summary::before/u);
		assert.match(css, /details\[open\] > summary \.group-disclosure-closed \{[^}]*display: none;/u);
		assert.match(css, /details\[open\] > summary \.group-disclosure-open \{[^}]*display: inline-block;/u);
		assert.match(css, /\.group-disclosure > \.group-disclosure-open \{[^}]*display: none;/u);
		assert.match(enabledSource, /v-for="\(component, index\) in components"/u);
		assert.match(enabledSource, /data-component-type/u);
		assert.match(canvasSource, /data-component-type/u);
		assert.doesNotMatch(layoutSource + canvasSource + nodeSource, /data-can-paste/u);
		assert.match(menuSource, /class="context-menu-item context-menu-submenu-trigger"/u);
		assert.match(menuSource, />定位类库<\/button>/u);
		assert.match(menuSource, />加入布局<\/button>/u);
		assert.match(menuSource, />复制组件<\/button>/u);
		assert.match(menuSource, />剪切组件<\/button>/u);
		assert.match(menuSource, />粘贴组件<\/button>/u);
		assert.match(menuSource, />前移组件<\/button>/u);
		assert.match(menuSource, />后移组件<\/button>/u);
		assert.match(menuSource, />删除组件<\/button>/u);
		assert.match(menuSource, /<span>组件事件<\/span>[\s\S]*?>定位类库<\/button>/u);
		assert.equal((menuSource.match(/class="context-menu-separator"/gu) ?? []).length, 1);
		assert.doesNotMatch(
			menuSource,
			/v-if="[^"]*availableComponent[^"]*"\s+class="context-menu-separator"/u
		);
		assert.match(
			menuSource,
			/<template v-if="readOnly">[\s\S]*?>复制组件<\/button>[\s\S]*?<\/template>/u
		);
		assert.match(
			menuSource,
			/<template v-else-if="enabled">[\s\S]*?>前移组件<\/button>[\s\S]*?>后移组件<\/button>[\s\S]*?>复制组件<\/button>[\s\S]*?>剪切组件<\/button>[\s\S]*?>删除组件<\/button>[\s\S]*?<\/template>/u
		);
		assert.match(
			menuSource,
			/<template v-else-if="componentActions \|\| canPaste">[\s\S]*?>前移组件<\/button>[\s\S]*?>后移组件<\/button>[\s\S]*?>复制组件<\/button>[\s\S]*?>剪切组件<\/button>[\s\S]*?>粘贴组件<\/button>[\s\S]*?>删除组件<\/button>/u
		);
		assert.doesNotMatch(menuSource, />(?:复制|剪切|粘贴|前移|后移|删除)<\/button>/u);
		assert.match(menuSource, /\$emit\('activate-component-event'/u);
		assert.match(menuSource, /\$emit\('add-component'/u);
		assert.match(menuSource, /\$emit\('copy-component'/u);
		assert.match(menuSource, /\$emit\('cut-component'/u);
		assert.match(menuSource, /\$emit\('move-component'/u);
		assert.match(menuSource, /\$emit\('move-enabled-component'/u);
		assert.match(menuSource, /\$emit\('paste-component'/u);
		assert.match(menuSource, /\$emit\('remove-component'/u);
		assert.match(menuSource, /\$emit\('reveal-library-definition'/u);
		assert.match(appSource, /@activate-component-event="activateComponentEvent"/u);
		assert.match(appSource, /@open-code="openCode"/u);
		assert.match(appSource, /@add-component="addAvailableComponent"/u);
		assert.match(appSource, /@copy-component="copyComponent"/u);
		assert.match(appSource, /@cut-component="cutComponent"/u);
		assert.match(appSource, /@move-component="moveComponent"/u);
		assert.match(appSource, /@move-enabled-component="moveEnabledComponent"/u);
		assert.match(appSource, /@paste-component="pasteComponent"/u);
		assert.match(appSource, /canPaste: false/u);
		assert.match(appSource, /type: "checkComponentClipboard"/u);
		assert.match(appSource, /hostMessage\.type === "componentClipboardStatus"[\s\S]*?contextMenu\.value\.canPaste = hostMessage\.available/u);
		assert.match(appSource, /@remove-component="removeComponent"/u);
		assert.match(appSource, /@reveal-library-definition="revealLibraryDefinition"/u);
		assert.match(menuSource, /v-if="componentEvent\.existing" class="context-menu-event-status">✓/u);
		assert.match(appSource, /type: "activateComponentEvent"/u);
		assert.match(appSource, /type: "openCode"/u);
		assert.match(providerSource, /case "openCode":[\s\S]*?await this\.openCode\(state\)/u);
		assert.match(providerSource, /showTextDocument\(await state\.document\.getCodeDocument\(\), \{ preview: false \}\)/u);
		assert.match(appSource, /type: "addComponent"/u);
		assert.match(appSource, /resolveDesignerAddTarget\(root, selectedComponent, selectedGridCell\.value/u);
		assert.match(appSource, /gridPosition: menu\.addTarget\.gridPosition === undefined[\s\S]*?column: menu\.addTarget\.gridPosition\.column,[\s\S]*?row: menu\.addTarget\.gridPosition\.row/u);
		assert.match(appSource, /position: menu\.addTarget\.position/u);
		assert.match(appSource, /referenceComponentName: reference\?\.componentName/u);
		assert.match(appSource, /referenceXmlPath: reference\?\.xmlPath/u);
		assert.match(appSource, /renderVersion: parent\.renderVersion/u);
		assert.match(appSource, /type: "relocateComponent"/u);
		assert.match(appSource, /commandKey === "x"/u);
		assert.match(appSource, /requestCutComponent\(selectedComponent\.path\)/u);
		assert.match(providerSource, /case "cutComponent":[\s\S]*?await this\.cutComponent\(state, parsedMessage\)/u);
		assert.match(providerSource, /pendingCut\.clipboardText === clipboardText[\s\S]*?cutSourceMatches = copySimpleDesignerComponent[\s\S]*?relocateSimpleDesignerComponent/u);
		assert.match(providerSource, /"剪切并粘贴组件"/u);
		assert.match(appSource, /@resize="resizeComponent"/u);
		assert.match(appSource, /type: "resizeComponent"/u);
		assert.match(appSource, /ArrowLeft: \{ deltaLeft: -1, deltaTop: 0 \}/u);
		assert.match(appSource, /selectedParent\?\.layout === "absolute"/u);
		assert.match(appSource, /type: "nudgeComponent"/u);
		assert.match(providerSource, /case "nudgeComponent":[\s\S]*?await this\.nudgeComponent\(state, parsedMessage\)/u);
		assert.match(providerSource, /nudgeSimpleDesignerComponent\(propertyDocument, this\.sdk, component\.xmlPath/u);
		assert.doesNotMatch(canvasSource, /designer-resize-frame|resizeFrameElement|applyResizeFrameBounds/u);
		assert.doesNotMatch(nodeSource, /designer-component-feedback|data-resize-handle/u);
		assert.match(canvasSource, /class="designer-interaction-layer"[\s\S]*?class="designer-component-feedback designer-component-feedback-selected"/u);
		assert.match(canvasSource, /class="designer-label-layer"[\s\S]*?class="designer-component-name designer-component-name-selected"/u);
		assert.match(canvasSource, /:data-resize-handle="handle"/u);
		assert.match(canvasSource, /function externalNameStyleFromBounds/u);
		assert.match(canvasSource, /:data-layout-surface-path="projection\.root\.path"/u);
		assert.match(nodeSource, /:data-layout-surface-path="node\.path"/u);
		assert.match(canvasSource, /function componentParentOverlayBounds[\s\S]*?component\?\.dataset\.componentParentPath[\s\S]*?querySelectorAll<HTMLElement>\("\[data-layout-surface-path\]"\)[\s\S]*?surface\.dataset\.layoutSurfacePath === parentPath/u);
		assert.doesNotMatch(canvasSource, /componentParentOverlayBounds[\s\S]*?closest<HTMLElement>\("\[data-drop-target\]"\)/u);
		assert.match(canvasSource, /const availableBounds = parentBounds \?\?/u);
		assert.match(canvasSource, /const candidates = \[topCandidate, bottomCandidate, leftCandidate, rightCandidate\]/u);
		assert.match(canvasSource, /candidates\.find\(\(candidate\) => \([\s\S]*?candidate\.left >= minimumLeft[\s\S]*?candidate\.top <= maximumTop[\s\S]*?\)\) \?\? topCandidate/u);
		assert.doesNotMatch(canvasSource, /clampNameCoordinate/u);
		assert.match(canvasSource, /selectedNameElement\.value,[\s\S]*?COMPONENT_NAME_GAP/u);
		assert.match(canvasSource, /hoveredNameElement\.value,[\s\S]*?COMPONENT_NAME_GAP/u);
		assert.match(canvasSource, /drag\.startOverlayLeft \+ offsetLeft/u);
		assert.match(canvasSource, /drag\.startOverlayTop \+ offsetTop/u);
		assert.match(
			canvasSource,
			/function applyResizePreview[\s\S]*?selectedNameStyle\.value = externalNameStyleFromBounds/u
		);
		assert.match(canvasSource, /closest<HTMLElement>\("\[data-resize-handle\]"\)[\s\S]*?startResize\(event, handle, resizeHandle\)/u);
		assert.match(canvasSource, /component\.resizeHeight === true[\s\S]*?handles\.push\("top", "bottom"\)/u);
		assert.match(canvasSource, /component\.resizeWidth === true[\s\S]*?handles\.push\("left", "right"\)/u);
		assert.match(canvasSource, /:title="selectedVisualComponent === undefined \? undefined : componentHoverHint\(selectedVisualComponent\)"/u);
		assert.match(canvasSource, /:aria-label="resizeHandleAriaLabel\(handle\)"/u);
		assert.match(canvasSource, /function resizeHandleAriaLabel[\s\S]*?"按住左右拖动调整宽度"[\s\S]*?"按住上下拖动调整高度"/u);
		assert.doesNotMatch(css, /\.designer-resize-handle::after/u);
		assert.match(canvasSource, /readonly debug: boolean;/u);
		assert.match(canvasSource, /:class="\['section-content', 'designer-canvas', \{ 'designer-debug': props\.debug \}\]"/u);
		assert.doesNotMatch(canvasSource, /DESIGNER_DEBUG/u);
		assert.match(css, /\.designer-interaction-layer,\s*\.designer-label-layer \{[^}]*position: absolute;[^}]*inset: 0;[^}]*pointer-events: none;/u);
		assert.match(css, /\.designer-interaction-layer \{[^}]*z-index: var\(--designer-interaction-layer\);/u);
		assert.match(css, /\.designer-label-layer \{[^}]*z-index: var\(--designer-label-layer\);/u);
		assert.match(css, /\.designer-component-feedback \{[^}]*position: absolute;[^}]*pointer-events: none;/u);
		assert.doesNotMatch(css, /\.designer-component-feedback::after/u);
		assert.match(css, /\.designer-component-feedback-selected \{[^}]*--designer-feedback-line-width: var\(--designer-component-selection-line-width\);[^}]*z-index: 1;/u);
		assert.doesNotMatch(css, /(?:^|\n)\.designer-component-feedback-selected \{[^}]*(?:cursor|pointer-events):/u);
		assert.match(css, /\.component-dragging \.designer-component-feedback-selected \{[^}]*visibility: hidden !important;[^}]*pointer-events: none;/u);
		assert.match(css, /\.component-dragging \.designer-component-name-selected \{[^}]*opacity: 0;[^}]*pointer-events: none;/u);
		assert.doesNotMatch(css, /\.component-dragging \.designer-component-name-selected \{[^}]*display: none;/u);
		assert.match(css, /\.designer-resize-handle \{[^}]*background: transparent;[^}]*pointer-events: auto;/u);
		assert.doesNotMatch(css, /\.designer-debug \.designer-component-feedback-selected::after/u);
		assert.match(css, /\.designer-debug \.designer-component-feedback-selected \.designer-resize-handle \{[^}]*background: rgba\(255, 140, 0, \.45\);/u);
		assert.match(css, /--designer-resize-handle-size: 4px;[\s\S]*?--designer-resize-handle-offset: 2px;/u);
		assert.match(css, /\.designer-resize-handle-top \{[^}]*top: calc\(-1 \* var\(--designer-resize-handle-offset\)\);[^}]*right: 0;[^}]*left: 0;[^}]*height: var\(--designer-resize-handle-size\);/u);
		assert.match(css, /\.designer-resize-handle-right \{[^}]*top: 0;[^}]*right: calc\(-1 \* var\(--designer-resize-handle-offset\)\);[^}]*bottom: 0;[^}]*width: var\(--designer-resize-handle-size\);/u);
		assert.match(css, /\.designer-resize-handle-bottom \{[^}]*right: 0;[^}]*bottom: calc\(-1 \* var\(--designer-resize-handle-offset\)\);[^}]*left: 0;[^}]*height: var\(--designer-resize-handle-size\);/u);
		assert.match(css, /\.designer-resize-handle-left \{[^}]*top: 0;[^}]*bottom: 0;[^}]*left: calc\(-1 \* var\(--designer-resize-handle-offset\)\);[^}]*width: var\(--designer-resize-handle-size\);/u);
		assert.doesNotMatch(css, /\.window-node\.selected/u);
		assert.doesNotMatch(canvasSource, /selected: projection\.root\.path === projection\.selectedPath/u);
		assert.doesNotMatch(css, /\.visual-node\.selected\s*\{[^}]*box-shadow:/u);
		assert.doesNotMatch(viewSource, /designer-resize-target/u);
		assert.match(appSource, /type: "revealLibraryDefinition"/u);
		assert.match(appSource, /type: "updateColumnOrder"/u);
		assert.match(appSource, /type: "navigateDocumentHistory"/u);
		assert.match(appSource, /type: "saveDocument"/u);
		assert.match(appSource, /pendingPropertyEdit: event\.target instanceof HTMLInputElement/u);
		assert.match(appSource, /commandKey === "c"/u);
		assert.match(appSource, /event\.key === "Delete"/u);
		assert.match(appSource, /!event\.repeat/u);
		assert.match(appSource, /!event\.isComposing/u);
		assert.match(appSource, /event\.target\.closest\("\.property-choice-trigger, \.property-choice-menu"\)/u);
		assert.match(appSource, /selectedGridCell\.value === undefined/u);
		assert.match(appSource, /requestDeleteComponent\(selectedComponent\.path\)/u);
		assert.match(appSource, /const textSelection = window\.getSelection\(\)/u);
		assert.match(appSource, /!textSelection\.isCollapsed[\s\S]*textSelection\.toString\(\)\.length > 0/u);
		assert.match(appSource, /const gridPasteTarget = selectedGridCell\.value/u);
		assert.match(appSource, /requestPasteComponent\(pasteTargetPath, gridPasteTarget === undefined/u);
		assert.match(appSource, /commandKey === "v"/u);
		assert.match(appSource, /copy && !editingText && !selectingText && selectedComponent\?\.parentPath !== undefined/u);
		assert.match(appSource, /const pasteXmlPath = enabled \? undefined : resolveDesignerPasteTargetPath\(component\)/u);
		assert.match(appSource, /paste && !editingText && pasteTargetPath !== undefined/u);
		assert.match(appSource, /requestCopyComponent\(selectedComponent\.path\)/u);
		assert.match(appSource, /target\.closest\("\.nonvisual-item"\)/u);
		assert.match(appSource, /target\.closest\("\.toolbox-item"\)/u);
		assert.match(appSource, /target\.closest\("\[data-component-path\]"\)/u);
		assert.match(providerSource, /case "revealLibraryDefinition"/u);
		assert.match(appSource, /function resolveDesignerColumnDropLocation/u);
		assert.doesNotMatch(appSource, /previewColumnOrder|displayedColumnOrder|createDesignerColumnDragPreview/u);
		assert.match(appSource, /function onDragStart[\s\S]*?closest<HTMLElement>\("\[data-designer-column-handle\]"\)[\s\S]*?draggedDesignerColumnId = columnId;[\s\S]*?application\/x-es4a-designer-column/u);
		assert.match(appSource, /function onDragOver[\s\S]*?draggedDesignerColumnId !== undefined[\s\S]*?clearDesignerColumnDropTarget\(false\)[\s\S]*?location\.indicator\.classList\.add\("designer-column-drop-" \+ location\.position\)/u);
		assert.match(appSource, /function onDrop[\s\S]*?draggedDesignerColumnId !== undefined[\s\S]*?columnOrder\.value = location\.order;[\s\S]*?type: "updateColumnOrder"/u);
		assert.doesNotMatch(appSource, /DesignerColumnPointerDrag|onDesignerColumnPointerDown|setPointerCapture/u);
		assert.match(appSource, /event\.key === "Escape"[\s\S]*?finishDrag\(\)/u);
		assert.match(css, /\.designer-column-source \{[^}]*opacity: \.62;/u);
		assert.match(css, /\.designer-column-drop-before \{[^}]*box-shadow: -4px 0 0 var\(--vscode-focusBorder\);/u);
		assert.match(css, /\.designer-column-drop-after \{[^}]*box-shadow: 4px 0 0 var\(--vscode-focusBorder\);/u);
		assert.doesNotMatch(css, /designer-column-drag-preview/u);
		assert.match(appSource, /function resolveComponentDropLocation/u);
		assert.match(appSource, /function resolveDraggedComponentDropLocation/u);
		assert.match(appSource, /function relativeLocation/u);
		assert.match(appSource, /function frameLocation/u);
		assert.match(appSource, /function frameLocation[\s\S]*?!pointInsideElement\(container, event\)[\s\S]*?return undefined/u);
		assert.match(appSource, /if \(!pointerInsideSource\) return resolveOutsideSourceDropLocation\(event, sourceParentPath\);[\s\S]*?return frameLocation\(sourceFrameContainer, event\)/u);
		assert.match(appSource, /resolveDesignerFrameSnap\([\s\S]*?framePlacement: \{[\s\S]*?\.\.\.snapped\.placement[\s\S]*?fitContentHeight:[\s\S]*?fitContentWidth:/u);
		assert.match(appSource, /\.layout-frame\[data-layout-surface-path\]/u);
		assert.match(appSource, /componentType: draggedComponent\.type,[\s\S]*?framePlacement: location\.framePlacement[\s\S]*?type: "addComponent"/u);
		assert.match(appSource, /framePlacement: location\.framePlacement[\s\S]*?type: "relocateComponent"/u);
		assert.match(appSource, /\.layout-relative\[data-layout-surface-path\]/u);
		assert.match(appSource, /const snappedBounds = \{[\s\S]*?left: snapped\.left,[\s\S]*?top: snapped\.top,[\s\S]*?projectedDesignerRelativePreviewBounds\([\s\S]*?relativePreviewBounds: previewBounds/u);
		assert.match(appSource, /location\.indicatorClass === "drop-relative-position"[\s\S]*?const previewBounds = location\.relativePreviewBounds;[\s\S]*?canvasDragFeedback\("relative", previewBounds\)/u);
		assert.doesNotMatch(appSource, /component\.previewLeft \+ offset\.deltaLeft|component\.previewTop \+ offset\.deltaTop/u);
		assert.match(appSource, /container\.classList\.contains\("layout-relative"\)[\s\S]*?return relativeLocation\(container, event\)/u);
		assert.match(appSource, /sourceRelativeContainer !== undefined[\s\S]*?directLocation\.parentXmlPath !== sourceParentPath[\s\S]*?resolveOutsideSourceDropLocation\(event, sourceParentPath\)[\s\S]*?return relativeLocation\(sourceRelativeContainer, event\)/u);
		assert.match(appSource, /type: "moveRelativeComponent"/u);
		assert.match(appSource, /draggedComponent\.parentXmlPath === location\.parentXmlPath[\s\S]*?type: "moveRelativeComponent"/u);
		assert.match(appSource, /relativePlacement: location\.relativeOffset[\s\S]*?type: "addComponent"/u);
		assert.match(appSource, /relativePlacement: location\.relativeOffset[\s\S]*?type: "relocateComponent"/u);
		assert.match(providerSource, /case "moveRelativeComponent":[\s\S]*?await this\.moveRelativeComponent\(state, parsedMessage\)/u);
		assert.match(providerSource, /moveSimpleDesignerRelativeComponent\([\s\S]*?this\.resolveRelativePlacement\(propertyDocument, message\)/u);
		assert.match(appSource, /target\.closest<HTMLElement>\("\.designer-canvas"\)/u);
		assert.match(appSource, /\.layout-absolute\[data-drop-target\]/u);
		assert.match(appSource, /function pointInsideElement/u);
		assert.match(appSource, /document\.elementsFromPoint\(event\.clientX, event\.clientY\)/u);
		assert.match(appSource, /function resolveOutsideSourceDropLocation/u);
		assert.match(appSource, /!pointerInsideSource[\s\S]*?resolveOutsideSourceDropLocation\(event, sourceParentPath\)/u);
		assert.match(appSource, /return absoluteLocation\(sourceContainer, event\)/u);
		assert.match(appSource, /const location = resolveDraggedComponentDropLocation\(event\.target, event\)/u);
		assert.match(appSource, /:drag-feedback="displayedPlacementFeedback"/u);
		assert.match(appSource, /:drag-hovered-path="dragHoveredComponentPath"/u);
		assert.match(appSource, /dragHoveredComponentPath\.value = location\.accept === "visual" \? location\.parentXmlPath : null/u);
		assert.match(appSource, /@dragleave="onDragLeave"/u);
		assert.match(appSource, /event\.target !== event\.currentTarget/u);
		assert.match(appSource, /dragHoveredComponentPath\.value = undefined/u);
		assert.match(canvasSource, /const displayedHoveredPath = computed\(\(\) => props\.dragHoveredPath === undefined/u);
		assert.match(canvasSource, /path === undefined && previousPath !== undefined/u);
		assert.match(appSource, /event\.clientX < bounds\.left \+ bounds\.width \/ 2 \? "before" : "after"/u);
		assert.match(appSource, /event\.clientY < bounds\.top \+ bounds\.height \/ 2 \? "before" : "after"/u);
		assert.match(appSource, /insertionLocation\(insertion, insertionPosition\(insertion, event\)\)/u);
		assert.match(appSource, /event\.dataTransfer\.setDragImage/u);
		assert.match(appSource, /function hideNativeDragImage/u);
		assert.match(appSource, /if \(draggedComponent\.visual\) hideNativeDragImage\(event\)/u);
		assert.doesNotMatch(appSource, /absoluteDropPreview|designer-absolute-drop-preview/u);
		assert.match(appSource, /function visualDropFeedback/u);
		assert.match(appSource, /dragFeedback\.value = visualDropFeedback\(location\)/u);
		assert.match(appSource, /location\.accept === "visual"[\s\S]*?dragFeedback\.value = visualDropFeedback\(location\)[\s\S]*?location\.indicator\.classList\.add\(location\.indicatorClass\)/u);
		assert.match(appSource, /component\.previewWidth \?\? 12/u);
		assert.match(appSource, /component\.previewHeight \?\? 12/u);
		assert.match(appSource, /left: bounds\.left - canvasBounds\.left/u);
		assert.match(appSource, /top: bounds\.top - canvasBounds\.top/u);
		assert.doesNotMatch(appSource, /contentWidth - previewWidth/u);
		assert.doesNotMatch(appSource, /contentHeight - previewHeight/u);
		assert.match(canvasSource, /class="designer-drag-layer"[\s\S]*?class="\['designer-drop-feedback', 'designer-drop-feedback-' \+ dragFeedback\.kind\]"/u);
		assert.match(css, /\.designer-drag-layer \{[^}]*z-index: var\(--designer-drag-layer\);[^}]*pointer-events: none;[^}]*user-select: none;/u);
		assert.match(css, /\.designer-drop-feedback \{[^}]*position: absolute;[^}]*pointer-events: none;/u);
		assert.match(css, /\.designer-drop-feedback-container \{[^}]*box-shadow: inset 0 0 0 2px var\(--designer-drop-indicator\);/u);
		assert.match(css, /\.designer-drop-feedback-grid,[^}]*background: var\(--designer-drop-hatch\);/u);
		assert.match(css, /\.designer-drop-feedback-grid \{[^}]*border-width: 2px;/u);
		assert.match(canvasSource, /dragFeedback\?\.kind === 'grid' && dragFeedback\.gridPosition !== undefined/u);
		assert.match(canvasSource, /行\{\{ dragFeedback\.gridPosition\.row \}\} 列\{\{ dragFeedback\.gridPosition\.column \}\}/u);
		assert.doesNotMatch(canvasSource, /designer-grid-position-label-selected/u);
		assert.doesNotMatch(nodeSource, /designer-grid-position-label-selected/u);
		assert.match(css, /\.designer-grid-position-label \{[^}]*color: var\(--designer-relative-guide\);[^}]*font-size: 10px;[^}]*line-height: 14px;/u);
		assert.doesNotMatch(css, /\.designer-grid-position-label-selected/u);
		assert.match(canvasSource, /designerGridPositionLabelBounds\([\s\S]*?feedback,[\s\S]*?availableBounds,[\s\S]*?\{ height: 14, width \}/u);
		assert.match(canvasSource, /function layoutParameterAvailableBounds\([\s\S]*?querySelector<HTMLElement>\("\.window-content"\)/u);
		assert.match(canvasSource, /function absoluteCoordinateLabelStyle[\s\S]*?layoutParameterAvailableBounds\(\)/u);
		assert.match(canvasSource, /const framePlacementLabelStyle[\s\S]*?layoutParameterAvailableBounds\(\)/u);
		assert.match(appSource, /function currentGridDragFeedback[\s\S]*?gridPosition: \{ column: component\.gridColumn, row: component\.gridRow \},[\s\S]*?showBounds: false/u);
		assert.match(appSource, /function currentGridCellSelectionFeedback[\s\S]*?\.designer-grid-cell\[data-grid-cell-parent\][\s\S]*?canvasDragFeedback\("grid", cell\.getBoundingClientRect\(\)\)[\s\S]*?showBounds: false/u);
		assert.match(canvasSource, /dragFeedback !== undefined && dragFeedback\.showBounds !== false/u);
		assert.match(appSource, /location\.indicatorClass === "drop-grid-cell"[\s\S]*?gridPosition: location\.gridPosition/u);
		assert.match(css, /\.designer-drop-feedback-frame,\s*\.designer-drop-feedback-relative \{[^}]*border: 2px solid var\(--designer-drop-indicator\);[^}]*background: color-mix/u);
		assert.match(css, /\.designer-drop-feedback-absolute \{[^}]*background: color-mix/u);
		assert.match(css, /\.designer-drop-feedback-absolute::after \{[^}]*z-index: 3;[^}]*border: 2px solid var\(--designer-drop-indicator\);/u);
		assert.match(canvasSource, /dragFeedback\?\.kind === 'absolute' && dragFeedback\.absoluteCoordinates !== undefined/u);
		assert.match(canvasSource, />\{\{ dragFeedback\.absoluteCoordinates\.x \}\}dp<\/div>/u);
		assert.match(canvasSource, />\{\{ dragFeedback\.absoluteCoordinates\.y \}\}dp<\/div>/u);
		assert.doesNotMatch(canvasSource, />[XY] \{\{ dragFeedback\.absoluteCoordinates\.[xy] \}\}dp<\/div>/u);
		assert.match(css, /\.designer-absolute-coordinate-label \{[^}]*z-index: 2;[^}]*color: var\(--designer-relative-guide\);[^}]*font-size: 10px;[^}]*line-height: 14px;/u);
		assert.match(appSource, /function currentAbsoluteDragFeedback[\s\S]*?absoluteCoordinates: \{ x: position\.left, y: position\.top \}/u);
		assert.match(appSource, /parent\?\.layout === "absolute"[\s\S]*?currentAbsoluteDragFeedback\(component, componentElement\)/u);
		assert.match(canvasSource, /v-for="\(guide, index\) in dragFeedback\?\.guides \?\? \[\]"/u);
		assert.match(css, /\.designer-relative-snap-guide-vertical \{[^}]*border-left: 1px solid var\(--designer-relative-guide\);/u);
		assert.match(css, /\.designer-relative-snap-guide-horizontal \{[^}]*border-top: 1px solid var\(--designer-relative-guide\);/u);
		assert.match(css, /--designer-relative-guide: var\(--vscode-descriptionForeground\);/u);
		assert.doesNotMatch(css, /--designer-relative-guide: var\(--designer-component-interaction-color\);/u);
		assert.doesNotMatch(css, /--designer-relative-guide: var\(--vscode-charts-purple/u);
		assert.match(canvasSource, /designer-relative-snap-guide-label-['"]? \+ guide\.labelPlacement/u);
		assert.match(canvasSource, /v-if="guide\.connector !== undefined"/u);
		assert.match(canvasSource, /relativeSnapGuideConnectorStyle\(guide\)/u);
		assert.match(canvasSource, /relativeSnapGuideLabelStyle\(guide, true, index\)/u);
		assert.match(canvasSource, /\{\{ guide\.connector\.label \}\}/u);
		assert.match(canvasSource, /v-if="dragFeedback\?\.kind !== 'frame' && relativeSnapGuideLabelMode\(index\) !== 'hidden'"/u);
		assert.match(canvasSource, /relativeSnapGuideLabelStyle\(guide, false, index\)/u);
		assert.match(canvasSource, /\{\{ guide\.label \}\}/u);
		assert.match(canvasSource, /:title="guide\.title"/u);
		assert.match(canvasSource, /designerRelativeGuideLabelSide\([\s\S]*?line,[\s\S]*?feedback,[\s\S]*?layoutParameterAvailableBounds/u);
		assert.match(canvasSource, /designerRelativeShortGuideLabelCenter\(line, feedback\)/u);
		assert.match(canvasSource, /useConnector && feedback\.kind !== "frame"[\s\S]*?designerRelativeShortGuideLabelCenter\(line, feedback\)/u);
		assert.match(canvasSource, /labelMode === "center-in-parent"/u);
		assert.match(css, /\.designer-relative-snap-guide-label \{[^}]*background: transparent;[^}]*user-select: none;/u);
		assert.doesNotMatch(css, /\.designer-relative-snap-guide-label \{[^}]*text-shadow:/u);
		assert.match(css, /\.designer-relative-snap-guide-connector-vertical \{[^}]*border-left: 1px solid var\(--designer-relative-guide\);/u);
		assert.match(css, /\.designer-relative-snap-guide-connector-horizontal \{[^}]*border-top: 1px solid var\(--designer-relative-guide\);/u);
		assert.match(css, /\.designer-relative-snap-guide-vertical > \.designer-relative-snap-guide-label,[\s\S]*?\.designer-relative-snap-guide-connector-vertical > \.designer-relative-snap-guide-label \{[^}]*writing-mode: vertical-rl;[^}]*text-orientation: sideways;/u);
		assert.match(css, /\.designer-relative-snap-guide-label-horizontal \{[^}]*writing-mode: horizontal-tb !important;[^}]*text-orientation: mixed !important;/u);
		assert.match(canvasSource, /designer-relative-snap-guide-label-horizontal': relativeGuideLabelHorizontal\(guide, true\)/u);
		assert.match(canvasSource, /designer-relative-snap-guide-label-horizontal': relativeGuideLabelHorizontal\(guide, false\)/u);
		assert.match(canvasSource, /props\.dragFeedback\?\.kind === "relative" && \(useConnector \|\| guide\.target !== "parent"\)/u);
		assert.match(canvasSource, /dragFeedback\?\.kind !== 'frame' && relativeSnapGuideLabelMode\(index\) !== 'hidden'/u);
		assert.match(canvasSource, /class="designer-frame-placement-label"[\s\S]*?dragFeedback\.placementLabel/u);
		assert.match(appSource, /function currentFrameDragFeedback[\s\S]*?placementLabel: designerFrameAlignmentLabel\(component\.alignment\)/u);
		assert.doesNotMatch(appSource, /function currentRelativeDragFeedback[\s\S]*?placementLabel:[\s\S]*?function currentFrameRules/u);
		assert.match(appSource, /placementLabel: location\.framePlacement === undefined[\s\S]*?designerFrameAlignmentLabel\(location\.framePlacement\.alignment\)/u);
		assert.match(css, /\.designer-frame-placement-label \{[^}]*background: transparent;[^}]*pointer-events: none;/u);
		assert.match(css, /\.designer-relative-snap-guide-horizontal > \.designer-relative-snap-guide-label-middle \{/u);
		assert.doesNotMatch(appSource, /@pointer(?:down|up|cancel)\.capture="(?:show|clear)PressedPlacementFeedback"/u);
		assert.match(appSource, /function currentFrameDragFeedback[\s\S]*?\.layout-frame\[data-layout-surface-path\][\s\S]*?currentFrameRules\(component\)[\s\S]*?component\.margin[\s\S]*?canvasDragFeedback\("frame", bounds\)/u);
		assert.match(appSource, /const displayedPlacementFeedback = computed\(\(\) => componentDragging\.value[\s\S]*?dragFeedback\.value[\s\S]*?selectedPlacementFeedback\.value\)/u);
		assert.match(appSource, /function currentPlacementFeedback[\s\S]*?parent\?\.layout === "frame"[\s\S]*?currentFrameDragFeedback\(component, componentElement\)/u);
		assert.match(appSource, /function refreshSelectedPlacementFeedback[\s\S]*?currentPlacementFeedback\(message\.value\?\.projection\.selectedPath\)/u);
		assert.match(appSource, /currentDesignerRelativeGuides\(/u);
		assert.match(appSource, /previewDesignerRelativePlacement\(/u);
		assert.match(appSource, /horizontalDock: location\.relativeDocks\?\.horizontal/u);
		assert.match(appSource, /margin: location\.relativeMargin/u);
		assert.match(appSource, /verticalDock: location\.relativeDocks\?\.vertical/u);
		assert.doesNotMatch(css, /designer-absolute-drop-preview|\.window-node:has\([^}]*drop-active/u);
		assert.match(appSource, /serializeSimpleStringLiteral\(value\)/u);
		assert.doesNotMatch(mainSource, /registerDefinitionProvider/u);
		const fileSystemRegistrationOffset = mainSource.indexOf("registerFileSystemProvider");
		const designerRegistrationOffset = mainSource.indexOf("registerCustomEditorProvider");
		assert.ok(
			fileSystemRegistrationOffset >= 0
			&& designerRegistrationOffset >= 0
			&& fileSystemRegistrationOffset < designerRegistrationOffset,
			"恢复设计器前必须先注册 simple-code 虚拟文档协议"
		);
		assert.doesNotMatch(mainSource, /resolveRestoredDesignerTabTitles/u);
		assert.doesNotMatch(unitTabsSource, /resolveRestoredDesignerTabTitles|"vscode\.openWith"/u);
		assert.match(css, /\.designer-shell \{[^}]*display: flex;[^}]*gap: 8px;[^}]*align-items: stretch;/u);
		assert.match(css, /\.left-column \{[^}]*min-height: 0;[^}]*flex-direction: column;[^}]*gap: 8px;/u);
		assert.match(css, /\.property-section \{[^}]*min-height: 0;[^}]*flex: 1 1 0;/u);
		assert.match(css, /\.layout-section \{[^}]*height: 240px;[^}]*min-height: 240px;[^}]*flex: 0 0 240px;/u);
		assert.match(css, /\.designer-canvas \{[^}]*width: calc\(var\(--designer-logical-width\) \+ 24px\);[^}]*height: calc\(var\(--designer-logical-height\) \+ 24px\);/u);
		assert.match(css, /\.window-node \{[^}]*width: var\(--designer-logical-width\);[^}]*height: var\(--designer-logical-height\);/u);
		assert.match(css, /\.layout-linear-horizontal \{[^}]*flex-flow: row nowrap;[^}]*gap: var\(--designer-layout-spacing\);/u);
		assert.match(css, /\.layout-linear-vertical \{[^}]*gap: var\(--designer-layout-spacing\);/u);
		assert.match(css, /:root \{[^}]*--designer-layout-spacing: 0px;[^}]*--designer-empty-content-min-width: 32px;[^}]*--designer-empty-content-min-height: 32px;[^}]*--designer-component-border-width: 1px;[^}]*--designer-component-hover-line-width: 1px;[^}]*--designer-component-selection-line-width: 2px;[^}]*--designer-resize-handle-size: 4px;/u);
		assert.match(css, /:root \{[^}]*--designer-component-interaction-color: var\(--vscode-focusBorder\);/u);
		assert.doesNotMatch(css, /--designer-component-(?:hover|selection)-color/u);
		assert.doesNotMatch(css, /--designer-grid-cell-min-(?:width|height)/u);
		assert.match(css, /\.visual-node \{[^}]*min-width: 0;[^}]*min-height: 0;[^}]*border: var\(--designer-component-border-width\) dashed var\(--vscode-descriptionForeground\);/u);
		assert.match(css, /\.visual-node \{[^}]*--designer-margin-top: 0px;[^}]*--designer-margin-right: 0px;[^}]*--designer-margin-bottom: 0px;[^}]*--designer-margin-left: 0px;/u);
		assert.match(css, /\.designer-width-parent \{[^}]*width: calc\(100% - var\(--designer-margin-left, 0px\) - var\(--designer-margin-right, 0px\)\);/u);
		assert.match(css, /\.designer-height-parent \{[^}]*height: calc\(100% - var\(--designer-margin-top, 0px\) - var\(--designer-margin-bottom, 0px\)\);/u);
		assert.match(css, /\.visual-control \{[^}]*display: grid;[^}]*place-items: center;[^}]*padding: 0;/u);
		assert.doesNotMatch(css, /designer-(?:label|button|input|autocomplete|choice|radio|checkbox|generic-text)-control/u);
		assert.match(css, /\.visual-control\.designer-width-content > \.visual-control-content \{[^}]*max-width: none;[^}]*overflow-wrap: normal;[^}]*white-space: pre;/u);
		assert.match(css, /\.designer-empty-content\.designer-width-content \{[^}]*min-width: var\(--designer-empty-content-min-width\);/u);
		assert.match(css, /\.designer-empty-content\.designer-height-content \{[^}]*min-height: var\(--designer-empty-content-min-height\);/u);
		assert.match(css, /\.container-node \{[^}]*display: grid;[^}]*overflow: hidden;/u);
		assert.doesNotMatch(css, /--designer-container-min-(?:width|height)/u);
		assert.match(css, /\.container-content \{[^}]*width: 100%;[^}]*height: 100%;/u);
		assert.match(css, /\.window-layout-surface,\s*\.container-layout-surface \{[^}]*width: 100%;[^}]*height: 100%;[^}]*overflow: visible;/u);
		assert.match(css, /\.designer-width-fixed > \.container-content > \.container-layout-surface > \.designer-width-content,\s*\.designer-width-parent > \.container-content > \.container-layout-surface > \.designer-width-content\s*\{[^}]*max-width:\s*100%;/u);
		assert.match(css, /\.designer-height-fixed > \.container-content > \.container-layout-surface > \.designer-height-content,\s*\.designer-height-parent > \.container-content > \.container-layout-surface > \.designer-height-content\s*\{[^}]*max-height:\s*100%;/u);
		assert.match(css, /\.layout-grid \{[^}]*align-content: start;[^}]*gap: 0;/u);
		assert.doesNotMatch(css, /\.layout-grid \{[^}]*border:/u);
		assert.match(css, /\.designer-grid-cell \{[^}]*position: relative;[^}]*display: grid;[^}]*min-width: 0;[^}]*min-height: 0;[^}]*padding: var\(--designer-layout-spacing\);[^}]*border: 0;[^}]*background: transparent;/u);
		assert.match(css, /\.designer-grid-cell::before \{[^}]*position: absolute;[^}]*border-right: 1px solid[^}]*border-bottom: 1px solid[^}]*pointer-events: none;/u);
		assert.match(css, /\.designer-grid-cell\[data-grid-cell-column="0"\]::before \{[^}]*border-left: 1px solid/u);
		assert.match(css, /\.designer-grid-cell\[data-grid-cell-row="0"\]::before \{[^}]*border-top: 1px solid/u);
		assert.match(css, /\.designer-grid-cell-selected \{[^}]*outline: 2px solid var\(--vscode-focusBorder\);[^}]*outline-offset: -2px;/u);
		assert.match(css, /\.visual-node\.selected\[draggable=(?:"true"|true)\] \{[^}]*cursor: move;/u);
		assert.doesNotMatch(css, /\.window-node\.selected/u);
		assert.doesNotMatch(css, /\.visual-node\.selected\s*\{[^}]*box-shadow:/u);
		assert.doesNotMatch(css, /designer-component-border-hit|\.container-content > \.visual-node \{[^}]*z-index: 5;/u);
		assert.match(css, /\.designer-grid-cell > \.designer-width-parent \{[^}]*width: auto;[^}]*max-width: none;[^}]*justify-self: stretch;/u);
		assert.match(css, /\.designer-grid-cell > \.designer-height-parent \{[^}]*height: auto;[^}]*max-height: none;[^}]*align-self: stretch;/u);
		assert.match(css, /\.designer-grid-unplaced \{[^}]*grid-column: 1 \/ -1;[^}]*border-top: 1px dashed/u);
		assert.match(css, /\.window-content \{[^}]*padding: var\(--designer-layout-spacing\);/u);
		assert.match(css, /\.container-content \{[^}]*padding: var\(--designer-layout-spacing\);/u);
		assert.match(viewSource, /style\[`padding-\$\{side\}`\] = `calc\(var\(--designer-layout-spacing\) \+ \$\{value\}px\)`/u);
		assert.match(viewSource, /style\["--designer-absolute-inset-left"\] = "0px"/u);
		assert.match(css, /\.container-content \{[^}]*overflow: visible;/u);
		assert.match(css, /\.container-layout-surface\.container-scroll-horizontal \{[^}]*overflow-x: auto;[^}]*overflow-y: hidden;/u);
		assert.match(css, /\.container-layout-surface\.container-scroll-vertical \{[^}]*overflow-x: hidden;[^}]*overflow-y: auto;/u);
		assert.match(css, /\.container-layout-surface\.container-scroll-horizontal > \.designer-width-content \{[^}]*max-width: none;/u);
		assert.match(css, /\.container-layout-surface\.container-scroll-vertical > \.designer-height-content \{[^}]*max-height: none;/u);
		assert.match(nodeSource, /class="container-content"[\s\S]*?:class="\['container-layout-surface', designerLayoutClass\(node\)\]"/u);
		assert.match(canvasSource, /class="window-content"[\s\S]*?:class="\['window-layout-surface', designerLayoutClass\(projection\.root\)/u);
		assert.match(canvasSource, /const componentBounds = component\.getBoundingClientRect\(\)/u);
		assert.doesNotMatch(viewSource, /visibleComponentBounds/u);
		assert.match(nodeSource, /:data-accepts-visual-child="node\.acceptsVisualChild === false \? 'false' : 'true'"/u);
		assert.match(css, /--designer-drop-hatch:\s*repeating-linear-gradient\(\s*-45deg,/u);
		assert.match(css, /\.designer-drop-feedback-grid \{[^}]*border-width: 2px;/u);
		assert.doesNotMatch(css, /\.designer-drop-feedback-absolute[^}]*background: var\(--designer-drop-hatch\);/u);
		assert.match(css, /\.drop-insert-before-horizontal::after \{[^}]*left: 0;[^}]*width: 8px;/u);
		assert.match(css, /\.drop-insert-after-horizontal::after \{[^}]*right: 0;[^}]*width: 8px;/u);
		assert.match(css, /\.drop-insert-before-vertical::after \{[^}]*top: 0;[^}]*height: 8px;/u);
		assert.match(css, /\.drop-insert-after-vertical::after \{[^}]*bottom: 0;[^}]*height: 8px;/u);
		assert.match(css, /\.component-context-menu \{[^}]*position: fixed;[^}]*z-index: 1000;/u);
		assert.match(css, /\.context-menu-item\.context-menu-event-item \{[^}]*display: flex;[^}]*gap: 8px;/u);
		assert.match(css, /\.context-menu-item\.context-menu-submenu-trigger \{[^}]*display: flex;[^}]*gap: 8px;/u);
		assert.equal(model.projection.root?.displayText, "Tetris");
		assert.match(model.projection.root?.icon ?? "", /^data:image\/svg\+xml,/u);
		assert.match(model.propertyPanel.icon ?? "", /^data:image\/svg\+xml,/u);
		assert.ok(model.projection.toolbox.some(
			(group) => group.name === "视图组件" && group.items.some((item) => item.name === "按钮")
		));
		assert.equal(model.propertyPanel.groups[0]?.rows[0]?.editTarget?.effect, "renameComponent");
		const relativeLayoutSource = await fs.readFile(
			await simpleTestUnitPath("SmokeTests", "测试相对布局"),
			"utf8"
		);
		const relativeLayoutModel = createDesignerWebviewModel(
			inspectSimplePropertyXml(relativeLayoutSource),
			"/属性/定义[1]/定义[1]/定义[1]",
			sdk,
			"测试相对布局",
			"designer-relative-layout-test"
		);
		const relativePanel = relativeLayoutModel.projection.root?.children[0];
		const relativeButton = relativePanel?.children[0];
		assert.equal(relativePanel?.layout, "relative");
		assert.equal(relativePanel?.layoutReadOnly, false);
		assert.equal(relativePanel?.acceptsVisualChild, true);
		assert.equal(relativePanel?.children.length, 11);
		assert.equal(relativeButton?.positionReadOnly, true);
		assert.equal(relativeButton?.positionDraggable, true);
		assert.deepEqual(relativeButton?.relativeMoveAxes, { horizontal: true, vertical: true });
		assert.deepEqual(relativeButton?.relativeRules, { alignParentRight: true, alignParentTop: true });
		assert.equal(relativeLayoutModel.propertyPanel.groups.some(
			(group) => group.name === "位于相对布局 · 同级组件"
				&& group.rows.some((row) => row.editTarget !== undefined)
		), true);
		assert.match(css, /\.layout-relative \{[^}]*position: relative;[^}]*display: block;/u);
		assert.match(css, /\.layout-relative > \.designer-relative-positioned \{[^}]*position: absolute;[^}]*left: var\(--designer-relative-left\);[^}]*top: var\(--designer-relative-top\);/u);
		assert.match(canvasSource, /useDesignerRelativeLayoutProjection\(windowLayoutSurface, rootProjection\)/u);
		assert.match(nodeSource, /useDesignerRelativeLayoutProjection\(layoutSurface, projectedNode\)/u);
		assert.match(relativeSource, /height: element\.offsetHeight[\s\S]*?width: element\.offsetWidth/u);
		assert.doesNotMatch(relativeSource, /getBoundingClientRect\(\)/u);
		assert.match(css, /\.layout-unsupported \{[^}]*display: flex;[^}]*flex-direction: column;/u);
		assert.match(canvasSource, /当前布局尚未适配，仅按组件顺序展示/u);
		assert.match(nodeSource, /当前布局尚未适配，仅按组件顺序展示/u);
		assert.match(providerSource, /vscode\.commands\.executeCommand\(parsedMessage\.direction\)/u);
		assert.match(
			providerSource,
			/case "saveDocument":[\s\S]*await this\.updateProperty\(state, parsedMessage\.pendingPropertyEdit\);[\s\S]*this\.requestSaveDocument\(state\);/u
		);
		assert.match(
			providerSource,
			/void vscode\.commands\.executeCommand\("workbench\.action\.files\.save"\)/u
		);
		assert.match(providerSource, /this\.preferenceState\.updateColumnOrder\(sourceFile, message\.order\)/u);
		assert.match(providerSource, /this\.preferenceState\.updateDisplayOption\(sourceFile, message\.option, message\.value\)/u);
		assert.match(providerSource, /case "updateDisplayOption":[\s\S]*?await this\.updateDisplayOption\(state, parsedMessage\)/u);
		assert.match(appSource, /function toggleLayoutHoverSync\(\): void \{[\s\S]*?layoutHoverSync\.value = !layoutHoverSync\.value;[\s\S]*?updateDisplayOption\("layoutHoverSync", layoutHoverSync\.value\)/u);
		assert.match(providerSource, /resolveDesignerComponentEventAction\(/u);
		assert.match(providerSource, /vscode\.window\.showTextDocument\(codeDocument, \{ preview: false \}\)/u);
		const imageTestsSource = await fs.readFile(testProjectPath(
			"StartTests", "src", "simple",
			"runtime", "tests", "ImageTests.simple"
		), "utf8");
		const emptyNonvisualModel = createDesignerWebviewModel(
			inspectSimplePropertyXml(imageTestsSource),
			"/属性/定义[1]",
			sdk,
			"ImageTests",
			"designer-empty-nonvisual-test"
		);
		assert.deepEqual(emptyNonvisualModel.projection.nonVisualComponents, []);
	});

	test("项目树项目、单元分组、窗口和服务单元保持稳定图标", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		const provider = new ProgramTreeProvider();
		try {
			await provider.addProject(testProjectPath("Tetris", "project.properties"));
			await provider.addProject(testProjectPath("SmokeTests", "project.properties"));
			const project = (await provider.getChildren()).find((node) => node.label === "Tetris");
			assert.ok(project?.kind === "project");
			const projectIcon = provider.getTreeItem(project).iconPath;
			assert.ok(projectIcon instanceof vscode.ThemeIcon);
			assert.equal(projectIcon.id, "project");
			const units = (await provider.getChildren(project)).find((node) => node.kind === "units");
			assert.ok(units);
			const unitsIcon = provider.getTreeItem(units).iconPath;
			assert.ok(unitsIcon instanceof vscode.ThemeIcon);
			assert.equal(unitsIcon.id, "extensions");

			const windowUnit = await provider.findUnitByFilePath(testProjectPath(
				"Tetris", "src", "simple", "samples", "tetris", "Tetris.simple"
			));
			assert.ok(windowUnit);
			const windowIcon = provider.getTreeItem(windowUnit).iconPath;
			assert.ok(windowIcon instanceof vscode.ThemeIcon);
			assert.equal(windowIcon.id, "layout-menubar");
			assert.equal(windowIcon.color?.id, "charts.red");

			const serviceUnit = await provider.findUnitByFilePath(
				await simpleTestUnitPath("SmokeTests", "自定义服务")
			);
			assert.ok(serviceUnit);
			const serviceIcon = provider.getTreeItem(serviceUnit).iconPath;
			assert.ok(serviceIcon instanceof vscode.ThemeIcon);
			assert.equal(serviceIcon.id, "terminal");
			assert.equal(serviceIcon.color?.id, "charts.purple");
		} finally {
			provider.dispose();
		}
	});

	test("代码标签撤销和重做始终共享同一份 XML 属性状态", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		await extension.activate();

		const sourceFile = path.join(
			os.tmpdir(),
			`es4a-property-undo-${process.pid}-${Date.now()}.simple`
		);
		const source = [
			"过程 Run()",
			"结束 过程",
			"",
			"$属性",
			"  $资源 $对象",
			"  基础对象 = simple.Before",
			"$结束 $属性",
			""
		].join("\r\n");
		const originalUserCode = getVisibleSimpleUnitUserCode(source);
		const beforeXml = propertyXmlText(inspectSimplePropertyXml(source).document);
		assert.ok(beforeXml);

		let document: vscode.TextDocument | undefined;
		let xmlDocument: vscode.TextDocument | undefined;

		try {
			await fs.writeFile(sourceFile, source, "utf8");
			document = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(sourceFile)));
			await vscode.commands.executeCommand("es4a.previewUnitXml", {
				filePath: sourceFile,
				kind: "unit",
				label: "UndoProperty"
			});
			xmlDocument = vscode.window.activeTextEditor?.document;
			assert.ok(xmlDocument);
			assert.equal(xmlDocument.uri.scheme, UNIT_XML_PREVIEW_SCHEME);
			await waitForDocumentText(xmlDocument, beforeXml);

			await vscode.window.showTextDocument(document, { preview: false });
			const valueStart = document.getText().indexOf("Run");
			assert.notEqual(valueStart, -1);
			const edit = new vscode.WorkspaceEdit();
			edit.replace(
				document.uri,
				new vscode.Range(
					document.positionAt(valueStart),
					document.positionAt(valueStart + "Run".length)
				),
				"RunAfter"
			);
			assert.equal(await vscode.workspace.applyEdit(edit), true);
			const changedUserCode = document.getText();
			assert.match(changedUserCode, /RunAfter/u);
			await waitForDocumentText(xmlDocument, beforeXml);

			assert.equal(vscode.window.activeTextEditor?.document, document);
			await vscode.commands.executeCommand("undo");
			await waitForDocumentText(document, originalUserCode);
			await waitForDocumentText(xmlDocument, beforeXml);

			await vscode.commands.executeCommand("redo");
			await waitForDocumentText(document, changedUserCode);
			await waitForDocumentText(xmlDocument, beforeXml);
			assert.equal(await document.save(), true);
		} finally {
			if (document?.isDirty === true) {
				await vscode.window.showTextDocument(document, { preview: false });
				await vscode.commands.executeCommand("workbench.action.files.revert");
			}
			if (xmlDocument !== undefined) {
				await vscode.window.showTextDocument(xmlDocument, { preview: false });
				await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
			}
			if (document !== undefined) {
				await vscode.window.showTextDocument(document, { preview: false });
				await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
			}
			await fs.rm(sourceFile, { force: true });
		}
	});

	test("VS Code 按作用域和已知类型提供 Simple 首拼补全", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		await extension.activate();

		const executable = await completionLabels([
			"过程 Run()",
			"\trg¦",
			"结束 过程",
			"$属性",
			"\t$资源 $对象",
			"$结束 $属性"
		].join("\r\n"));
		assert.ok(executable.includes("如果"));

		const functionResult = await completionLabels([
			"函数 xx1() w¦",
			"结束 函数",
			"$属性",
			"\t$资源 $对象",
			"$结束 $属性"
		].join("\r\n"));
		assert.deepEqual(functionResult, ["为"]);

		const variableType = await completionLabels([
			"变量 a w¦",
			"$属性",
			"\t$资源 $对象",
			"$结束 $属性"
		].join("\r\n"));
		assert.deepEqual(variableType, ["为"]);

		const staticDeclaration = await completionLabels([
			"静态 bl¦",
			"$属性",
			"\t$资源 $对象",
			"$结束 $属性"
		].join("\r\n"));
		assert.deepEqual(staticDeclaration, ["变量"]);

		const staticMember = await completionLabels([
			"过程 Run()",
			"\t数组操作.fgwb¦",
			"结束 过程",
			"$属性",
			"\t$资源 $对象",
			"$结束 $属性"
		].join("\r\n"));
		assert.ok(staticMember.includes("分割文本"));

		const ifThen = await completionLabels([
			"过程 Run()",
			"\t如果 1 > 2 z¦",
			"\t结束 如果",
			"结束 过程",
			"$属性",
			"\t$资源 $对象",
			"$结束 $属性"
		].join("\r\n"));
		assert.ok(ifThen.includes("则"));

		const typeCheckIs = await completionLabels([
			"过程 Run()",
			"\t变量 消息载荷 为 变体型",
			"\t如果 类型检验 消息载荷 s¦",
			"\t结束 如果",
			"结束 过程",
			"$属性",
			"\t$资源 $对象",
			"$结束 $属性"
		].join("\r\n"));
		assert.deepEqual(typeCheckIs, ["是"]);

		const typeCheckOr = await completionLabels([
			"过程 Run()",
			"\t变量 消息载荷 为 变体型",
			"\t如果 类型检验 消息载荷 是 文本型 h¦",
			"\t结束 如果",
			"结束 过程",
			"$属性",
			"\t$资源 $对象",
			"$结束 $属性"
		].join("\r\n"));
		assert.deepEqual(typeCheckOr, ["或"]);

		const globalConstant = await completionLabels([
			"过程 Run()",
			"\trq_n¦",
			"结束 过程",
			"$属性",
			"\t$资源 $对象",
			"$结束 $属性"
		].join("\r\n"));
		assert.ok(globalConstant.includes("日期_年"));

		const staticContext = await completionLabels([
			"静态 过程 Run()",
			"\tbdx¦",
			"结束 过程",
			"$属性",
			"\t$资源 $对象",
			"$结束 $属性"
		].join("\r\n"));
		assert.ok(!staticContext.includes("本对象"));
	});

	test("VS Code 补全项保留用户别名的首拼过滤文本和引用图标", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		const markedSource = [
			"''' **日期工具说明**",
			"别名 日期工具 = 日期时间操作.格式化",
			"过程 Run()",
			"	rqgj¦",
			"结束 过程",
			"$属性",
			"	$资源 $对象",
			"$结束 $属性"
		].join("\r\n");
		const offset = markedSource.indexOf(COMPLETION_CURSOR);
		const source = markedSource.replace(COMPLETION_CURSOR, "");
		const filePath = "C:\\project\\src\\Completion.simple";
		const sourceRoot = "C:\\project\\src";
		const unit = parseSimpleUnitSymbols(source, filePath, sourceRoot);
		const context: SimpleProjectSemanticContext = {
			currentUnit: unit,
			manifest: {
				categories: [{ definitions: [unit.definition], hidden: true, name: "测试单元" }],
				directory: sourceRoot,
				filePath: "C:\\project\\project.properties",
				kind: "project",
				name: "测试项目"
			}
		};
		const provider = new SimpleCompletionProvider(() => source, () => context);
		provider.updateSdk(await loadSdk(path.resolve(extension.extensionPath, "..", "sdk", "sdk.json")));
		const document = await vscode.workspace.openTextDocument({ content: source, language: "simple" });
		const completions = provider.provideCompletionItems(document, document.positionAt(offset));
		const alias = completions.items.find((item) => (
			(typeof item.label === "string" ? item.label : item.label.label) === "日期工具"
		));

		assert.ok(alias);
		assert.equal(alias.filterText, "rqgj");
		assert.equal(alias.kind, vscode.CompletionItemKind.Reference);
		assert.ok(alias.documentation instanceof vscode.MarkdownString);
		assert.equal(alias.documentation.value, "**日期工具说明**");
	});

	test("方法补全复用光标后已有括号且缺少括号时插入参数片段", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		const sdk = await loadSdk(path.resolve(extension.extensionPath, "..", "sdk", "sdk.json"));
		const provide = async (statement: string): Promise<vscode.CompletionItem> => {
			const markedSource = [
				"过程 Run()",
				"\t变量 局_服务意图 为 意图",
				`\t${statement}`,
				"结束 过程",
				"$属性",
				"\t$资源 $对象",
				"$结束 $属性"
			].join("\r\n");
			const offset = markedSource.indexOf(COMPLETION_CURSOR);
			assert.notEqual(offset, -1);
			const source = markedSource.replace(COMPLETION_CURSOR, "");
			const sourceRoot = "C:\\project\\src";
			const unit = parseSimpleUnitSymbols(source, `${sourceRoot}\\Completion.simple`, sourceRoot);
			const context: SimpleProjectSemanticContext = {
				currentUnit: unit,
				manifest: {
					categories: [{ definitions: [unit.definition], hidden: true, name: "测试单元" }],
					directory: sourceRoot,
					filePath: "C:\\project\\project.properties",
					kind: "project",
					name: "测试项目"
				}
			};
			const provider = new SimpleCompletionProvider(() => source, () => context);
			provider.updateSdk(sdk);
			const document = await vscode.workspace.openTextDocument({ content: source, language: "simple" });
			const completions = provider.provideCompletionItems(document, document.positionAt(offset));
			const item = completions.items.find((candidate) => (
				(typeof candidate.label === "string" ? candidate.label : candidate.label.label) === "置包名"
			));
			assert.ok(item, "没有找到置包名补全项");
			return item;
		};

		const existing = await provide("局_服务意图.z¦(取包名())");
		assert.equal(existing.insertText, "置包名");
		const spaced = await provide("局_服务意图.z¦ (取包名())");
		assert.equal(spaced.insertText, "置包名");
		const missing = await provide("局_服务意图.z¦");
		assert.ok(missing.insertText instanceof vscode.SnippetString);
		assert.equal(missing.insertText.value, "置包名(${1:packageName})");
	});

	test("VS Code 转到定义定位当前用户代码中的变量声明", async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-definition-"));
		const sourceFile = path.join(temporaryDirectory, "Definition.simple");
		const source = [
			"过程 Run()",
			"\t变量 value 为 整数型",
			"\tvalue = 1",
			"结束 过程",
			"$属性",
			"\t$资源 $对象",
			"$结束 $属性",
			""
		].join("\r\n");
		await fs.writeFile(sourceFile, source, "utf8");
		const document = await vscode.workspace.openTextDocument(
			toSimpleCodeUri(vscode.Uri.file(sourceFile))
		);

		try {
			const offset = document.getText().lastIndexOf("value") + 1;
			const editor = await vscode.window.showTextDocument(document, { preview: false });
			editor.selection = new vscode.Selection(document.positionAt(offset), document.positionAt(offset));
			await vscode.commands.executeCommand("es4a.goToDefinition");
			const targetEditor = vscode.window.activeTextEditor;
			assert.equal(targetEditor?.document.uri.toString(), document.uri.toString());
			assert.equal(targetEditor?.document.getText(targetEditor.selection), "value");
			assert.equal(targetEditor?.selection.start.line, 1);
		} finally {
			await vscode.window.showTextDocument(document, { preview: false });
			await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("VS Code 从编译器和运行库清单提供悬停说明", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		await extension.activate();

		const keyword = (await hoverContents("如¦果 真 则")).join("\n");
		assert.match(keyword, /如果/);
		assert.match(keyword, /条件判断/);
		assert.doesNotMatch(keyword, /流程控制/u);

		assert.deepEqual(await hoverContents("' 如¦果"), []);
		const statementSeparator = (await hoverContents("Run() ¦: Next()"));
		assert.match(statementSeparator.join("\n"), /显式结束当前语句/u);
		assert.deepEqual(await hoverContents("Run¦()"), []);

		const documentedVariable = (await hoverContents([
			"''' **加粗说明**  ",
			"''' - 列表项",
			"变量 val¦ue 为 整数型"
		].join("\r\n"))).join("\n");
		assert.match(documentedVariable, /\*\*加粗说明\*\*  \n- 列表项/u);

		const runtimeFunction = (await hoverContents("数组操作.分割¦文本(内容, 分隔符, 1)")).join("\n");
		assert.match(runtimeFunction, /函数 分割文本\(str 为 文本型/);
		assert.match(runtimeFunction, /所属库：运行库/u);
		assert.match(runtimeFunction, /所属类：simple\.runtime\.数组操作/u);
		assert.match(runtimeFunction, /查找指定文本来分割文本/);
		assert.match(runtimeFunction, /```\n\*str：\*/u);
		assert.ok(runtimeFunction.indexOf("*str：*") < runtimeFunction.indexOf("查找指定文本来分割文本。"));
		assert.match(runtimeFunction, /\*count：\*&#8203;分割次数\n\n查找指定文本来分割文本。\n\n所属库：运行库/u);
		assert.doesNotMatch(runtimeFunction, /参数：/u);
		assert.match(runtimeFunction, /\*str：\*&#8203;欲分割的文本/u);
		assert.match(runtimeFunction, /\*separator：\*&#8203;欲查找的分割文本/u);
		assert.match(runtimeFunction, /\*count：\*&#8203;分割次数/u);
		assert.doesNotMatch(runtimeFunction, /command:es4a\.revealLibrarySymbol/u);

		const noParameterFunction = (await hoverContents("取现行¦时间()")).join("\n");
		assert.match(noParameterFunction, /取当前设备的日期时间。\n\n所属库：运行库/u);

		const sdk = await loadSdk(path.resolve(extension.extensionPath, "..", "sdk", "sdk.json"));
		const provider = new SimpleHoverProvider();
		provider.updateSdk(sdk);
		const source = "数组操作.分割文本(内容, 分隔符, 1)";
		const document = await vscode.workspace.openTextDocument({ content: source, language: "simple" });
		const hover = provider.provideHover(document, document.positionAt(source.indexOf("分割文本") + 1));
		const markdown = hover?.contents.find(
			(content): content is vscode.MarkdownString => content instanceof vscode.MarkdownString
		);
		assert.equal(markdown?.supportThemeIcons, false);
		const runtimeProperty = (await hoverContents([
			"过程 Run()",
			"  变量 timer 为 计时器",
			"  timer.间¦隔 = 500",
			"结束 过程",
			"$属性",
			"  $资源 $对象",
			"$结束 $属性"
		].join("\r\n"))).join("\n");
		assert.match(runtimeProperty, /属性 间隔 为 整数型/);
		assert.match(runtimeProperty, /所属库：运行库/u);
		assert.match(runtimeProperty, /所属类：simple\.runtime\.components\.计时器/u);
		assert.doesNotMatch(runtimeProperty, /初始值/u);

		const localCollection = (await hoverContents([
			"静态 过程 RunSmokeTests()",
			"  变量 tests 为 集合",
			"  tests = 创建 集合",
			"  tes¦ts.加入(创建 ExampleTest)",
			"结束 过程"
		].join("\r\n"))).join("\n");
		assert.match(localCollection, /变量 tests 为 集合/);
		assert.doesNotMatch(localCollection, /当前文档/u);

		const collectionMember = (await hoverContents([
			"静态 过程 RunSmokeTests()",
			"  变量 tests 为 集合",
			"  tests = 创建 集合",
			"  tests.加¦入(创建 ExampleTest)",
			"结束 过程"
		].join("\r\n"))).join("\n");
		assert.match(collectionMember, /过程 加入\(item 为 变体型\)/);
		assert.match(collectionMember, /将新项添加到集合中/);

		const explicitParameter = (await hoverContents([
			"事件 TextBox1.文本改变(text 为 文本型, 传址 accept 为 逻辑型)",
			"  ' TODO 无效，待解决",
			"  acc¦ept = 真",
			"结束 事件"
		].join("\r\n"))).join("\n");
		assert.match(explicitParameter, /传址 accept 为 逻辑型/u);
		assert.doesNotMatch(explicitParameter, /TODO/u);
	});

	test("用户代码保存时逐字保留磁盘上的最新 XML 属性区", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		await extension.activate();

		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-simple-code-"));
		const sourceFile = path.join(temporaryDirectory, "VirtualUnit.simple");
		const propertySource = "$属性\r\n\t$资源 $对象\r\n\t$未知 = \"初始值\"\r\n$结束 $属性\r\n";
		const latestPropertySource = "$属性\r\n  $资源 $对象\r\n\r\n  $未知 = \"外部更新也必须保留\"\r\n$结束 $属性\r\n";
		const source = "过程 Before()\r\n结束 过程\r\n" + propertySource;

		try {
			await fs.writeFile(sourceFile, source, "utf8");
			const codeUri = toSimpleCodeUri(vscode.Uri.file(sourceFile));
			const document = await vscode.workspace.openTextDocument(codeUri);

			assert.equal(document.uri.scheme, SIMPLE_CODE_SCHEME);
			assert.equal(document.languageId, "simple");
			assert.equal(document.getText(), "过程 Before()\r\n结束 过程");

			await fs.writeFile(sourceFile, document.getText() + "\r\n" + latestPropertySource, "utf8");
			const changedCode = "过程 After()\r\n结束 过程";
			const edit = new vscode.WorkspaceEdit();
			edit.replace(
				codeUri,
				new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
				changedCode
			);
			assert.equal(await vscode.workspace.applyEdit(edit), true);
			assert.equal(await document.save(), true);
			assert.equal(document.getText(), changedCode);
			assert.equal(document.isDirty, false);
			assert.equal(
				await fs.readFile(sourceFile, "utf8"),
				changedCode + "\r\n" + latestPropertySource
			);
		} finally {
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("设计器 XML 属性修改与预览共享同一状态并独立保存", async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-bound-property-"));
		const sourceFile = path.join(temporaryDirectory, "BoundProperty.simple");
		const propertySource = "$属性\r\n\t$资源 $对象\r\n\t基础对象 = simple.Before\r\n$结束 $属性\r\n";
		const source = `过程 Run()\r\n结束 过程\r\n
${propertySource}`;
		const provider = new SimpleCodeFileSystemProvider();
		const previewProvider = new UnitPreviewProvider(
			(sourceUri) => provider.getBoundPreview(sourceUri)
		);
		let designerReference: vscode.Disposable | undefined;

		try {
			await fs.writeFile(sourceFile, source, "utf8");
			const codeUri = toSimpleCodeUri(vscode.Uri.file(sourceFile));
			const document = await vscode.workspace.openTextDocument(codeUri);
			await provider.readFile(codeUri);
			designerReference = provider.retainDesignerDocument(document);
			const propertyDocument = provider.getProperty(document)?.document;
			assert.ok(propertyDocument);
			await provider.readFile(codeUri);
			assert.strictEqual(
				provider.getProperty(document)?.document,
				propertyDocument,
				"后台代码文档重复读取时不应重建仍由设计器持有的 XML 状态"
			);
			const updatedPropertyDocument = writePropertyXmlValue(
				propertyDocument,
				createPropertyXmlAttributePath(
					"/属性",
					"赋值",
					"属性",
					"基础对象",
					"值"
				),
				"simple.After",
				{ removeElementWhenEmpty: true }
			);

			await provider.applyDesignerPropertyEdit(
				document,
				propertyDocument,
				updatedPropertyDocument,
				document.getText()
			);
			assert.equal(document.isDirty, false);
			assert.equal(await fs.readFile(sourceFile, "utf8"), source);
			assert.match(propertyXmlText(provider.getProperty(document)?.document) ?? "", /值="simple\.After"/u);
			await provider.readFile(codeUri);
			assert.strictEqual(
				provider.getProperty(document)?.document,
				updatedPropertyDocument,
				"重复读取不能用磁盘属性覆盖设计器尚未保存的 XML 状态"
			);
			assert.match(
				await previewProvider.provideTextDocumentContent(
					toUnitXmlPreviewUri(vscode.Uri.file(sourceFile))
				),
				/值="simple\.After"/u
			);

			provider.setDesignerPropertyDocument(document, updatedPropertyDocument, propertyDocument);
			assert.match(propertyXmlText(provider.getProperty(document)?.document) ?? "", /值="simple\.Before"/u);
			assert.match(
				await previewProvider.provideTextDocumentContent(
					toUnitXmlPreviewUri(vscode.Uri.file(sourceFile))
				),
				/值="simple\.Before"/u
			);
			provider.setDesignerPropertyDocument(document, propertyDocument, updatedPropertyDocument);
			assert.match(propertyXmlText(provider.getProperty(document)?.document) ?? "", /值="simple\.After"/u);

			await provider.saveDesignerProperty(document);
			assert.match(await fs.readFile(sourceFile, "utf8"), /基础对象 = simple\.After/u);
			assert.equal(document.isDirty, false);
			designerReference.dispose();
			designerReference = undefined;
			provider.releaseDocument(document);
			assert.equal(provider.getProperty(document), undefined);
		} finally {
			designerReference?.dispose();
			previewProvider.dispose();
			provider.dispose();
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("不可见的空代码标签也能承载设计器属性修改和一次撤销", async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-hidden-empty-code-"));
		const sourceFile = path.join(temporaryDirectory, "EmptyWindow.simple");
		const source = [
			"$属性",
			"  $资源 $窗口",
			"  $定义 EmptyWindow $为 窗口",
			"  $结束 $定义",
			"$结束 $属性",
			""
		].join("\r\n");
		const provider = new SimpleCodeFileSystemProvider();
		let document: vscode.TextDocument | undefined;

		try {
			await fs.writeFile(sourceFile, source, "utf8");
			const codeUri = toSimpleCodeUri(vscode.Uri.file(sourceFile));
			await provider.readFile(codeUri);
			document = await vscode.workspace.openTextDocument(codeUri);
			await vscode.window.showTextDocument(document, { preview: false });
			const placeholderDocument = await vscode.workspace.openTextDocument({
				content: "占位",
				language: "plaintext"
			});
			await vscode.window.showTextDocument(
				placeholderDocument,
				{ preview: false }
			);
			assert.equal(vscode.window.visibleTextEditors.some((editor) => editor.document === document), false);
			assert.equal(document.getText(), "");

			const propertyDocument = provider.getProperty(document)?.document;
			assert.ok(propertyDocument);
			const updatedPropertyDocument = writePropertyXmlValue(
				propertyDocument,
				createPropertyXmlAttributePath(
					"/属性/定义[@名称='EmptyWindow']",
					"赋值",
					"属性",
					"标题",
					"值"
				),
				"\"新窗口\""
			);

			await provider.applyPropertyEdit(
				document,
				propertyDocument,
				updatedPropertyDocument,
				document.getText()
			);
			assert.equal(document.getText(), "");
			assert.equal(document.isDirty, true);
			assert.match(propertyXmlText(provider.getProperty(document)?.document) ?? "", /属性="标题" 值="&quot;新窗口&quot;"/u);

			await vscode.window.showTextDocument(document, { preview: false });
			await vscode.commands.executeCommand("undo");
			provider.synchronizePendingEdit(document, vscode.TextDocumentChangeReason.Undo);
			assert.equal(document.getText(), "");
			assert.doesNotMatch(propertyXmlText(provider.getProperty(document)?.document) ?? "", /属性="标题"/u);
		} finally {
			if (document?.isDirty === true) {
				await vscode.window.showTextDocument(document, { preview: false });
				await vscode.commands.executeCommand("workbench.action.files.revert");
			}
			provider.dispose();
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("设计器和代码双向并发保存时分别保留另一侧最新内容", async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-designer-document-"));
		const sourceFile = path.join(temporaryDirectory, "DesignerWindow.simple");
		const originalCode = "过程 Run()\r\n结束 过程";
		const propertySource = [
			"$属性",
			"\t$资源 $窗口",
			"\t$定义 DesignerWindow $为 窗口",
			"\t$结束 $定义",
			"$结束 $属性",
			""
		].join("\r\n");
		const source = originalCode + "\r\n" + propertySource;
		const provider = new SimpleCodeFileSystemProvider();
		let document: vscode.TextDocument | undefined;

		try {
			await fs.writeFile(sourceFile, source, "utf8");
			const codeUri = toSimpleCodeUri(vscode.Uri.file(sourceFile));
			await provider.readFile(codeUri);
			document = await vscode.workspace.openTextDocument(codeUri);
			await vscode.window.showTextDocument(document, { preview: false });
			const placeholder = await vscode.workspace.openTextDocument({
				content: "保持活动标签",
				language: "plaintext"
			});
			await vscode.window.showTextDocument(placeholder, { preview: false });
			const activeUri = vscode.window.activeTextEditor?.document.uri.toString();

			const propertyDocument = provider.getProperty(document)?.document;
			assert.ok(propertyDocument);
			const updatedPropertyDocument = writePropertyXmlValue(
				propertyDocument,
				createPropertyXmlAttributePath(
					"/属性/定义[@名称='DesignerWindow']",
					"赋值",
					"属性",
					"标题",
					"值"
				),
				"\"设计器标题\""
			);

			await provider.applyDesignerPropertyEdit(
				document,
				propertyDocument,
				updatedPropertyDocument,
				document.getText()
			);
			assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), activeUri);
			assert.equal(vscode.window.visibleTextEditors.some((editor) => editor.document === document), false);
			assert.equal(document.isDirty, false);

			const unsavedCode = "过程 Changed()\r\n结束 过程";
			const codeEdit = new vscode.WorkspaceEdit();
			codeEdit.replace(
				codeUri,
				new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
				unsavedCode
			);
			assert.equal(await vscode.workspace.applyEdit(codeEdit), true);
			assert.equal(document.isDirty, true);

			await Promise.all([
				provider.saveDesignerProperty(document),
				provider.writeFile(
					codeUri,
					Buffer.from(unsavedCode, "utf8"),
					{ create: false, overwrite: true }
				)
			]);
			const savedSource = await fs.readFile(sourceFile, "utf8");
			assert.match(savedSource, /标题 = "设计器标题"/u);
			assert.equal(getVisibleSimpleUnitUserCode(savedSource), unsavedCode);
			assert.equal(document.getText(), unsavedCode);
			assert.equal(document.isDirty, true);

			const currentPropertyDocument = provider.getProperty(document)?.document;
			assert.ok(currentPropertyDocument);
			const secondPropertyDocument = writePropertyXmlValue(
				currentPropertyDocument,
				createPropertyXmlAttributePath(
					"/属性/定义[@名称='DesignerWindow']",
					"赋值",
					"属性",
					"标题",
					"值"
				),
				"\"第二次标题\""
			);
			await provider.applyDesignerPropertyEdit(
				document,
				currentPropertyDocument,
				secondPropertyDocument,
				document.getText()
			);
			const secondUserCode = "过程 SecondChanged()\r\n结束 过程";
			await Promise.all([
				provider.writeFile(
					codeUri,
					Buffer.from(secondUserCode, "utf8"),
					{ create: false, overwrite: true }
				),
				provider.saveDesignerProperty(document)
			]);
			const secondSavedSource = await fs.readFile(sourceFile, "utf8");
			assert.match(secondSavedSource, /标题 = "第二次标题"/u);
			assert.equal(getVisibleSimpleUnitUserCode(secondSavedSource), secondUserCode);

			const thirdCurrentDocument = provider.getProperty(document)?.document;
			assert.ok(thirdCurrentDocument);
			const thirdPropertyDocument = writePropertyXmlValue(
				thirdCurrentDocument,
				createPropertyXmlAttributePath(
					"/属性/定义[@名称='DesignerWindow']",
					"赋值",
					"属性",
					"标题",
					"值"
				),
				"\"第三次标题\""
			);
			await provider.applyDesignerPropertyEdit(
				document,
				thirdCurrentDocument,
				thirdPropertyDocument,
				document.getText()
			);
			await fs.writeFile(
				sourceFile,
				secondSavedSource.replace('标题 = "第二次标题"', '标题 = "外部标题"'),
				"utf8"
			);
			await assert.rejects(
				provider.saveDesignerProperty(document),
				/XML 属性区已在磁盘上修改/u
			);
			await provider.revertDesignerProperty(document);
			assert.match(
				propertyXmlText(provider.getProperty(document)?.document) ?? "",
				/值="&quot;外部标题&quot;"/u
			);
		} finally {
			if (document?.isDirty === true) {
				await vscode.window.showTextDocument(document, { preview: false });
				await vscode.commands.executeCommand("workbench.action.files.revert");
			}
			provider.dispose();
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("设计器组件操作登记独立撤销且始终保持当前标签", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-designer-history-"));
		const sourceFile = path.join(temporaryDirectory, "HistoryWindow.simple");
		const source = [
			"事件 HistoryWindow.初始化()",
			"结束 事件",
			"",
			"$属性",
			"\t$资源 $窗口",
			"\t$定义 HistoryWindow $为 窗口",
			"\t\t$定义 Button1 $为 按钮",
			"\t\t$结束 $定义",
			"\t\t$定义 Button2 $为 按钮",
			"\t\t$结束 $定义",
			"\t$结束 $定义",
			"$结束 $属性",
			""
		].join("\r\n");
		const codeDocuments = new SimpleCodeFileSystemProvider();
		const messageEmitter = new vscode.EventEmitter<unknown>();
		const disposeEmitter = new vscode.EventEmitter<void>();
		const viewStateEmitter = new vscode.EventEmitter<vscode.WebviewPanelOnDidChangeViewStateEvent>();
		let renderMessage: DesignerWebviewRenderMessage | undefined;
		let html = "";
		const webview = {
			asWebviewUri: (uri: vscode.Uri) => uri,
			cspSource: "vscode-webview://designer-history-test",
			get html() { return html; },
			set html(value: string) { html = value; },
			onDidReceiveMessage: messageEmitter.event,
			options: {},
			postMessage: (message: DesignerWebviewRenderMessage) => {
				renderMessage = message;
				return Promise.resolve(true);
			}
		} as unknown as vscode.Webview;
		const panel = {
			active: true,
			onDidChangeViewState: viewStateEmitter.event,
			onDidDispose: disposeEmitter.event,
			viewColumn: vscode.ViewColumn.One,
			visible: true,
			webview
		} as unknown as vscode.WebviewPanel;
		const provider = new SimpleDesignerProvider(
			codeDocuments,
			extension.extensionUri,
			memoryDesignerPreferenceState()
		);
		let designerDocument: SimpleDesignerDocument | undefined;

		try {
			await fs.writeFile(sourceFile, source, "utf8");
			const sourceUri = vscode.Uri.file(sourceFile);
			const codeUri = toSimpleCodeUri(sourceUri);
			await codeDocuments.readFile(codeUri);
			designerDocument = await provider.openCustomDocument(
				toSimpleDesignerUri(sourceUri),
				{ backupId: undefined, untitledDocumentData: undefined },
				new vscode.CancellationTokenSource().token
			);
			provider.updateSdk(await loadSdk(path.resolve(extension.extensionPath, "..", "sdk", "sdk.json")));
			provider.resolveCustomEditor(designerDocument, panel);
			messageEmitter.fire({ type: "ready" });
			assert.ok(renderMessage);
			const button1Path = renderMessage.projection.root?.children.find((child) => child.name === "Button1")?.path;
			const button2Path = renderMessage.projection.root?.children.find((child) => child.name === "Button2")?.path;
			assert.ok(button1Path);
			assert.ok(button2Path);
			const initialContextToken = renderMessage.contextToken;
			messageEmitter.fire({
				componentName: "Button1",
				contextToken: initialContextToken,
				renderVersion: renderMessage.renderVersion,
				type: "selectNode",
				xmlPath: button1Path
			});
			assert.equal(renderMessage.projection.selectedPath, button1Path);
			messageEmitter.fire({
				componentName: "Button2",
				contextToken: initialContextToken,
				renderVersion: renderMessage.renderVersion,
				type: "selectNode",
				xmlPath: button2Path
			});
			assert.equal(renderMessage.projection.selectedPath, button2Path);

			const placeholder = await vscode.workspace.openTextDocument({
				content: "设计器保持活动",
				language: "plaintext"
			});
			await vscode.window.showTextDocument(placeholder, { preview: false });
			const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
			const editEventsPromise = new Promise<readonly vscode.CustomDocumentEditEvent<SimpleDesignerDocument>[]>((resolve) => {
				const events: vscode.CustomDocumentEditEvent<SimpleDesignerDocument>[] = [];
				const subscription = provider.onDidChangeCustomDocument((event) => {
					events.push(event);
					if (events.length === 2) {
						subscription.dispose();
						resolve(events);
					}
				});
			});
			messageEmitter.fire({
				componentName: "Button2",
				contextToken: initialContextToken,
				renderVersion: renderMessage.renderVersion,
				type: "deleteComponent",
				xmlPath: button2Path
			});
			messageEmitter.fire({
				componentName: "Button1",
				contextToken: initialContextToken,
				renderVersion: renderMessage.renderVersion,
				type: "deleteComponent",
				xmlPath: button1Path
			});
			const savePromise = provider.saveCustomDocument(
				designerDocument,
				new vscode.CancellationTokenSource().token
			);
			const editEvents = await editEventsPromise;
			await savePromise;
			assert.equal(renderMessage.contextToken, initialContextToken);
			const codeDocument = await designerDocument.getCodeDocument();
			assert.equal(codeDocument.uri.toString(), codeUri.toString());
			assert.equal(path.basename(designerDocument.uri.path), "HistoryWindow(设计器)");
			assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), activeUri);
			assert.equal(vscode.window.visibleTextEditors.some((editor) => editor.document === codeDocument), false);
			assert.equal(codeDocument.isDirty, false);
			assert.doesNotMatch(propertyXmlText(codeDocuments.getProperty(codeDocument)?.document) ?? "", /名称="Button1"/u);
			assert.doesNotMatch(propertyXmlText(codeDocuments.getProperty(codeDocument)?.document) ?? "", /名称="Button2"/u);
			assert.doesNotMatch(await fs.readFile(sourceFile, "utf8"), /\$定义 Button1 \$为 按钮/u);
			assert.doesNotMatch(await fs.readFile(sourceFile, "utf8"), /\$定义 Button2 \$为 按钮/u);

			await editEvents[1]!.undo();
			assert.match(propertyXmlText(codeDocuments.getProperty(codeDocument)?.document) ?? "", /名称="Button1"/u);
			assert.doesNotMatch(propertyXmlText(codeDocuments.getProperty(codeDocument)?.document) ?? "", /名称="Button2"/u);
			await editEvents[0]!.undo();
			assert.match(propertyXmlText(codeDocuments.getProperty(codeDocument)?.document) ?? "", /名称="Button1"/u);
			assert.match(propertyXmlText(codeDocuments.getProperty(codeDocument)?.document) ?? "", /名称="Button2"/u);
			await editEvents[0]!.redo();
			assert.match(propertyXmlText(codeDocuments.getProperty(codeDocument)?.document) ?? "", /名称="Button1"/u);
			assert.doesNotMatch(propertyXmlText(codeDocuments.getProperty(codeDocument)?.document) ?? "", /名称="Button2"/u);
			await editEvents[1]!.redo();
			assert.doesNotMatch(propertyXmlText(codeDocuments.getProperty(codeDocument)?.document) ?? "", /名称="Button1"/u);
			assert.doesNotMatch(propertyXmlText(codeDocuments.getProperty(codeDocument)?.document) ?? "", /名称="Button2"/u);

		} finally {
			designerDocument?.dispose();
			provider.dispose();
			codeDocuments.dispose();
			messageEmitter.dispose();
			disposeEmitter.dispose();
			viewStateEmitter.dispose();
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("对象单元右键命令通过共享 XML 状态设置基础对象和实现接口", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		await extension.activate();
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-object-relations-"));
		const sourceFile = path.join(temporaryDirectory, "ObjectRelations.simple");
		const source = [
			"过程 Run()",
			"结束 过程",
			"",
			"$属性",
			"\t$资源 $对象",
			"$结束 $属性",
			""
		].join("\r\n");
		const node = {
			filePath: sourceFile,
			interfaces: [],
			kind: "unit" as const,
			label: "ObjectRelations",
			unitType: "对象" as const
		};

		try {
			await fs.writeFile(sourceFile, source, "utf8");
			await vscode.commands.executeCommand("es4a.setBaseObject", node, "simple.example.Base");
			await vscode.commands.executeCommand(
				"es4a.setImplementedInterfaces",
				node,
				["simple.example.First", "simple.example.Second"]
			);

			const codeUri = toSimpleCodeUri(vscode.Uri.file(sourceFile));
			const document = vscode.workspace.textDocuments.find(
				(candidate) => candidate.uri.toString() === codeUri.toString()
			);
			assert.ok(document);
			assert.equal(document.isDirty, true);
			assert.equal(await fs.readFile(sourceFile, "utf8"), source);

			await vscode.commands.executeCommand("es4a.previewUnitXml", node);
			const xmlPreview = vscode.window.activeTextEditor?.document;
			assert.equal(xmlPreview?.uri.scheme, UNIT_XML_PREVIEW_SCHEME);
			assert.match(
				xmlPreview?.getText() ?? "",
				/<赋值 属性="基础对象" 值="simple\.example\.Base" \/>/u
			);
			assert.match(
				xmlPreview?.getText() ?? "",
				/<赋值 属性="实现接口" 值="simple\.example\.First,simple\.example\.Second" \/>/u
			);

			assert.equal(await document.save(), true);
			const writtenSource = await fs.readFile(sourceFile, "utf8");
			assert.match(writtenSource, /基础对象 = simple\.example\.Base/u);
			assert.match(writtenSource, /实现接口 = simple\.example\.First,simple\.example\.Second/u);
			const relatedTabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => {
				const input = tab.input;
				return input instanceof vscode.TabInputText && (
					input.uri.toString() === codeUri.toString()
					|| input.uri.toString() === toUnitXmlPreviewUri(vscode.Uri.file(sourceFile)).toString()
				);
			});
			if (relatedTabs.length > 0) {
				await vscode.window.tabGroups.close(relatedTabs, true);
			}
		} finally {
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("窗口或对象单元右键命令插入并定位有序生命周期事件", async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-lifecycle-events-"));
		const sourceFile = path.join(temporaryDirectory, "LifecycleObject.simple");
		await fs.writeFile(sourceFile, [
			"$属性",
			"\t$资源 $对象",
			"$结束 $属性",
			""
		].join("\r\n"), "utf8");
		const node: FileNode = {
			filePath: sourceFile,
			kind: "unit",
			label: "LifecycleObject",
			unitType: "对象"
		};

		try {
			await vscode.commands.executeCommand("es4a.openUnitInitializeEvent", node);
			await vscode.commands.executeCommand("es4a.openUnitLoadEvent", node);
			const document = vscode.window.activeTextEditor?.document;
			assert.ok(document);
			assert.equal(document.uri.scheme, SIMPLE_CODE_SCHEME);
			assert.equal(document.getText(), [
				"事件 LifecycleObject.加载()",
				"\t",
				"结束 事件",
				"",
				"事件 LifecycleObject.初始化()",
				"\t",
				"结束 事件"
			].join("\r\n"));

			await vscode.commands.executeCommand("es4a.openUnitLoadEvent", node);
			assert.equal(
				document.offsetAt(vscode.window.activeTextEditor!.selection.active),
				document.getText().indexOf("\t") + 1
			);
			assert.equal((document.getText().match(/\.加载\(\)/gu) ?? []).length, 1);
			assert.equal(await document.save(), true);
			assert.match(await fs.readFile(sourceFile, "utf8"), /^事件 LifecycleObject\.加载\(\)/u);
		} finally {
			await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("XML 属性写出遵循用户代码标签页的编码、换行和缩进", async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-property-format-"));
		const sourceFile = path.join(temporaryDirectory, "FormattedProperty.simple");
		const source = [
			"过程 Run()",
			"  变量 value 为 整数型",
			"结束 过程",
			"",
			"$属性",
			"  $资源 $对象",
			"  基础对象 = simple.Before",
			"$结束 $属性",
			""
		].join("\r\n");
		const provider = new SimpleCodeFileSystemProvider();

		try {
			await fs.writeFile(sourceFile, Buffer.concat([
				Buffer.from([0xEF, 0xBB, 0xBF]),
				Buffer.from(source, "utf8")
			]));
			const codeUri = toSimpleCodeUri(vscode.Uri.file(sourceFile));
			const document = await vscode.workspace.openTextDocument(codeUri);
			const editor = await vscode.window.showTextDocument(document);
			editor.options = { indentSize: 2, insertSpaces: true, tabSize: 2 };
			await provider.readFile(codeUri);
			const propertyDocument = provider.getProperty(document)?.document;
			assert.ok(propertyDocument);
			const formatting = resolvePropertySourceFormatting(document, [editor]);
			assert.deepEqual(formatting, { indentation: "  ", lineEnding: "\r\n" });
			const updatedPropertyDocument = writePropertyXmlValue(
				propertyDocument,
				createPropertyXmlAttributePath(
					"/属性",
					"赋值",
					"属性",
					"基础对象",
					"值"
				),
				"simple.After",
				{ removeElementWhenEmpty: true }
			);

			await provider.applyPropertyEdit(
				document,
				propertyDocument,
				updatedPropertyDocument,
				document.getText()
			);
			await provider.writeFile(
				codeUri,
				await vscode.workspace.encode(document.getText(), { encoding: document.encoding }),
				{ create: false, overwrite: true }
			);
			assert.equal(await document.save(), true);
			const written = await fs.readFile(sourceFile);
			assert.deepEqual([...written.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
			assert.equal(written.subarray(3).toString("utf8"), source.replace("simple.Before", "simple.After"));
			await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
		} finally {
			provider.dispose();
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("末尾无换行的用户代码可以连续保存且不会误判为磁盘冲突", async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-save-snapshot-"));
		const sourceFile = path.join(temporaryDirectory, "SaveSnapshot.simple");
		const propertySource = "$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n";
		const userCode = "事件 SaveSnapshot.初始化()\r\n\t\r\n结束 事件";
		const provider = new SimpleCodeFileSystemProvider();

		try {
			await fs.writeFile(sourceFile, propertySource, "utf8");
			const codeUri = toSimpleCodeUri(vscode.Uri.file(sourceFile));
			await provider.readFile(codeUri);

			await provider.writeFile(codeUri, Buffer.from(userCode, "utf8"), { create: false, overwrite: true });
			await provider.writeFile(codeUri, Buffer.from(userCode, "utf8"), { create: false, overwrite: true });

			assert.equal(await fs.readFile(sourceFile, "utf8"), `${userCode}\r\n${propertySource}`);
		} finally {
			provider.dispose();
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("保存前补齐属性区边界换行且重新打开后保持干净", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		await extension.activate();

		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-clean-reopen-"));
		const sourceFile = path.join(temporaryDirectory, "CleanReopen.simple");
		const propertySource = "$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n";
		const userCode = "事件 CleanReopen.初始化()\r\n\t\r\n结束 事件";

		try {
			await fs.writeFile(sourceFile, propertySource, "utf8");
			const codeUri = toSimpleCodeUri(vscode.Uri.file(sourceFile));
			const document = await vscode.workspace.openTextDocument(codeUri);
			const editor = await vscode.window.showTextDocument(document, { preview: false });
			assert.equal(await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), userCode)), true);
			const lineEnding = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
			const normalizedUserCode = userCode.replaceAll("\r\n", lineEnding);

			assert.equal(await document.save(), true);
			assert.equal(document.getText(), normalizedUserCode);
			assert.equal(document.isDirty, false);
			assert.equal(
				await fs.readFile(sourceFile, "utf8"),
				normalizedUserCode + lineEnding + propertySource
			);

			await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
			const reopened = await vscode.workspace.openTextDocument(codeUri);
			assert.equal(reopened.getText(), normalizedUserCode);
			assert.equal(reopened.isDirty, false);
		} finally {
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("活动 Simple 编辑器只转换代码区域新输入的中文符号", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		await extension.activate();

		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-punctuation-"));
		const sourceFile = path.join(temporaryDirectory, "Punctuation.simple");
		const propertySource = "$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n";
		const input = "过程 Test（值 为 文本型）\r\n\t值＝\"中文，。\" ' 注释（中文）\r\n结束 过程\r\n";
		const expected = "过程 Test(值 为 文本型)\r\n\t值=\"中文，。\" ' 注释（中文）\r\n结束 过程\r\n";

		try {
			await fs.writeFile(sourceFile, propertySource, "utf8");
			const document = await vscode.workspace.openTextDocument(
				toSimpleCodeUri(vscode.Uri.file(sourceFile))
			);
			const editor = await vscode.window.showTextDocument(document);

			assert.equal(await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), input)), true);
			await waitForDocumentText(document, expected);
			assert.equal(await document.save(), true);
			assert.equal(await fs.readFile(sourceFile, "utf8"), expected + "\r\n" + propertySource);
			await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
		} finally {
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("虚拟文档隐藏属性区后仍按单元类型限制补全作用域", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		await extension.activate();

		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-interface-code-"));
		const sourceFile = path.join(temporaryDirectory, "InterfaceUnit.simple");
		const userCode = "过程 Run()\r\n\trg\r\n结束 过程";
		const propertySource = "$属性\r\n\t$资源 $接口\r\n$结束 $属性\r\n";

		try {
			await fs.writeFile(sourceFile, userCode + "\r\n\r\n" + propertySource, "utf8");
			const codeUri = toSimpleCodeUri(vscode.Uri.file(sourceFile));
			const document = await vscode.workspace.openTextDocument(codeUri);
			const position = document.positionAt(userCode.indexOf("rg") + 2);
			const unit = parseSimpleUnitSymbols(
				userCode + "\r\n\r\n" + propertySource,
				sourceFile,
				temporaryDirectory
			);
			const context: SimpleProjectSemanticContext = {
				currentUnit: unit,
				manifest: {
					categories: [{ definitions: [unit.definition], hidden: true, name: "项目单元" }],
					directory: temporaryDirectory,
					filePath: path.join(temporaryDirectory, "project.properties"),
					kind: "project",
					name: "测试项目"
				}
			};
			const provider = new SimpleCompletionProvider(() => document.getText(), () => context);
			provider.updateSdk(await loadSdk(path.resolve(extension.extensionPath, "..", "sdk", "sdk.json")));
			const result = provider.provideCompletionItems(document, position);
			const labels = result.items.map(
				(item) => typeof item.label === "string" ? item.label : item.label.label
			);

			assert.equal(document.getText(), userCode + "\r\n");
			assert.equal(
				labels.includes("如果"),
				false,
				JSON.stringify(result.items.filter(
					(item) => (typeof item.label === "string" ? item.label : item.label.label) === "如果"
				).map((item) => ({ detail: item.detail, label: item.label })))
			);
		} finally {
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("代码错误且属性区损坏的单元仍可打开代码标签并安全保存", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		await extension.activate();

		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-broken-code-"));
		const sourceFile = path.join(temporaryDirectory, "Broken.simple");
		const brokenPropertySource = "$属性\r\n\t$资源 $窗口\r\n\t损坏属性行\r\n";
		const source = "这不是合法的 Simple 代码\r\n" + brokenPropertySource;

		try {
			await fs.writeFile(sourceFile, source, "utf8");
			const codeUri = toSimpleCodeUri(vscode.Uri.file(sourceFile));
			const document = await vscode.workspace.openTextDocument(codeUri);
			await vscode.window.showTextDocument(document, { preview: false });
			assert.equal(document.getText(), "这不是合法的 Simple 代码");

			const edit = new vscode.WorkspaceEdit();
			edit.replace(
				codeUri,
				new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
				"修改后仍然是错误代码"
			);
			assert.equal(await vscode.workspace.applyEdit(edit), true);
			assert.equal(await document.save(), true);
			assert.equal(
				await fs.readFile(sourceFile, "utf8"),
				"修改后仍然是错误代码\r\n" + brokenPropertySource
			);
			await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
		} finally {
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("ES4A 项目侧边栏在尚未添加项目时显示空树并支持刷新", async () => {
		const provider = new ProgramTreeProvider();
		let refreshCount = 0;
		const listener = provider.onDidChangeTreeData(() => {
			refreshCount += 1;
		});

		assert.deepEqual(await provider.getChildren(), []);
		provider.refresh();
		assert.equal(refreshCount, 1);

		listener.dispose();
		provider.dispose();
	});

	test("创建项目时仅从英文目录名建议包名", () => {
		assert.equal(createDefaultPackageName("MyApp"), "simple.myapp");
		assert.equal(createDefaultPackageName("  Demo_App  "), "simple.demo_app");
		assert.equal(createDefaultPackageName("1App"), "");
		assert.equal(createDefaultPackageName("测试"), "");
		assert.equal(createDefaultPackageName("My App"), "");
		assert.equal(createDefaultPackageName("CON"), "");
	});

	test("创建项目拒绝中文应用包名且不创建目录", async () => {
		const parentDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-invalid-package-"));
		const projectDirectory = path.join(parentDirectory, "测试");
		try {
			await assert.rejects(
				async () => vscode.commands.executeCommand("es4a.internal.createProject", {
					packageName: "simple.测试",
					parentDirectory: vscode.Uri.file(parentDirectory),
					projectDirectoryName: "测试",
					projectName: "测试"
				}),
				/应用包名/
			);
			await assert.rejects(fs.stat(projectDirectory));
		} finally {
			await fs.rm(parentDirectory, { force: true, recursive: true });
		}
	});

	test("创建项目支持中文目录名与独立应用名称", async () => {
		const parentDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-create-project-"));
		const projectDirectoryName = "测试目录";
		const projectName = "新建项目测试";
		const packageName = "simple.created";
		const mainUnitName = "主窗口";
		const projectDirectory = path.join(parentDirectory, projectDirectoryName);
		const projectFile = path.join(projectDirectory, "project.properties");
		const mainUnitFile = path.join(
			projectDirectory,
			"src",
			"simple",
			"created",
			`${mainUnitName}.simple`
		);
		try {
			const sdk = await loadConfiguredSdk();
			assert.notEqual(sdk, undefined);
			const projectTemplate = sdk?.templates.project;
			const mainTemplate = sdk?.templates.main;
			assert.notEqual(projectTemplate, undefined);
			assert.notEqual(mainTemplate, undefined);
			const expectedProjectSource = (projectTemplate?.source ?? "")
				.replaceAll("{$主窗口限定名}", packageName + "." + mainUnitName)
				.replaceAll("{$应用名称}", projectName);
			const expectedMainSource = (mainTemplate?.source ?? "")
				.replaceAll("{$应用名称}", projectName);
			assert.equal(
				(await vscode.commands.executeCommand<string>("es4a.internal.createProject", {
					packageName,
					parentDirectory: vscode.Uri.file(parentDirectory),
					projectDirectoryName,
					projectName
				})).toLowerCase(),
				projectFile.toLowerCase()
			);
			assert.equal(
				await fs.readFile(projectFile, "utf8"),
				expectedProjectSource
			);
			assert.equal(
				await fs.readFile(mainUnitFile, "utf8"),
				expectedMainSource
			);
			assert.equal((await fs.stat(path.join(projectDirectory, "assets"))).isDirectory(), true);
			assert.equal((await fs.stat(path.join(projectDirectory, "res"))).isDirectory(), true);
			await assert.rejects(fs.stat(path.join(projectDirectory, "build")));
			assert.equal(
				await vscode.commands.executeCommand<boolean>("es4a.internal.addProject", projectFile),
				false
			);
		} finally {
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			await fs.rm(parentDirectory, { force: true, recursive: true });
		}
	});

	test("失效项目同路径重建后重新打开主窗口代码和设计器", async () => {
		const parentDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-recreate-project-"));
		const projectName = "同名重建项目测试";
		const packageName = "simple.recreated";
		const projectDirectory = path.join(parentDirectory, projectName);
		const projectFile = path.join(projectDirectory, "project.properties");
		const mainUnitFile = path.join(projectDirectory, "src", "simple", "recreated", "主窗口.simple");
		try {
			const sdk = await loadConfiguredSdk();
			const projectTemplate = sdk?.templates.project;
			const mainTemplate = sdk?.templates.main;
			assert.ok(projectTemplate);
			assert.ok(mainTemplate);
			const projectSource = projectTemplate.source
				.replaceAll("{$主窗口限定名}", packageName + ".主窗口")
				.replaceAll("{$应用名称}", projectName);
			const mainSource = mainTemplate.source.replaceAll("{$应用名称}", projectName);
			await fs.mkdir(path.dirname(mainUnitFile), { recursive: true });
			await fs.mkdir(path.join(projectDirectory, "assets"), { recursive: true });
			await fs.mkdir(path.join(projectDirectory, "res"), { recursive: true });
			await fs.writeFile(projectFile, projectSource, "utf8");
			await fs.writeFile(mainUnitFile, mainSource, "utf8");
			assert.equal(
				await vscode.commands.executeCommand<boolean>("es4a.internal.addProject", projectFile),
				true
			);

			await fs.rm(projectDirectory, { force: true, recursive: true });
			const mainCodeUri = toSimpleCodeUri(vscode.Uri.file(mainUnitFile));
			await assert.rejects(async () => vscode.workspace.openTextDocument(mainCodeUri));
			assert.equal(
				(await vscode.commands.executeCommand<string>("es4a.internal.createProject", {
					packageName,
					parentDirectory: vscode.Uri.file(parentDirectory),
					projectDirectoryName: projectName,
					projectName
				})).toLowerCase(),
				projectFile.toLowerCase()
			);
			assert.equal(
				vscode.window.activeTextEditor?.document.getText(),
				getVisibleSimpleUnitUserCode(mainSource)
			);
			await vscode.commands.executeCommand("es4a.openDesigner");
			const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
			assert.ok(activeTab?.input instanceof vscode.TabInputCustom);
			assert.equal(activeTab.input.viewType, SIMPLE_DESIGNER_VIEW_TYPE);
		} finally {
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			await fs.rm(parentDirectory, { force: true, recursive: true });
		}
	});

	test("缺失或删除后的同名单元都打开最新模板", async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-create-unit-uri-"));
		const sourceDirectory = path.join(temporaryDirectory, "src");
		const projectFile = path.join(temporaryDirectory, "project.properties");
		const unitFile = path.join(sourceDirectory, "重建对象.simple");
		try {
			await fs.mkdir(sourceDirectory, { recursive: true });
			await fs.writeFile(projectFile, "name=单元重建测试\r\nsource=./src\r\nbuild=./build\r\n", "utf8");
			assert.equal(
				await vscode.commands.executeCommand<boolean>("es4a.internal.addProject", projectFile),
				true
			);
			const project = await loadSimpleProject(projectFile);
			const units: ProgramTreeNode = { kind: "units", label: "单元", project };
			const codeUri = toSimpleCodeUri(vscode.Uri.file(unitFile));
			await assert.rejects(async () => vscode.workspace.openTextDocument(codeUri));

			await vscode.commands.executeCommand(
				"es4a.internal.createUnit",
				units,
				"对象",
				"重建对象"
			);
			const sdk = await loadConfiguredSdk();
			const expectedSource = (sdk?.templates.object?.source ?? "")
				.replaceAll("{$对象名称}", "重建对象");
			assert.equal(await fs.readFile(unitFile, "utf8"), expectedSource);
			const unitNode: FileNode = {
				filePath: unitFile,
				kind: "unit",
				label: "重建对象",
				project,
				unitType: "对象"
			};
			await vscode.commands.executeCommand("es4a.previewUnitContent", unitNode);
			await vscode.commands.executeCommand("es4a.previewUnitXml", unitNode);
			await vscode.commands.executeCommand("es4a.internal.deleteUnitFile", unitNode);
			await assert.rejects(fs.stat(unitFile), { code: "ENOENT" });
			assert.equal(vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => {
				const binding = resolveSimpleUnitTab(tab);
				return binding !== undefined && sameLocalPath(binding.sourceUri.fsPath, unitFile);
			})), false);

			await vscode.commands.executeCommand(
				"es4a.internal.createUnit",
				units,
				"对象",
				"重建对象"
			);
			assert.equal(await fs.readFile(unitFile, "utf8"), expectedSource);
			assert.equal(
				vscode.window.activeTextEditor?.document.getText(),
				getVisibleSimpleUnitUserCode(expectedSource)
			);
		} finally {
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("项目属性命令只修改所选字段和清单宏并立即刷新项目", async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-project-property-"));
		const projectFile = path.join(temporaryDirectory, "project.properties");
		const provider = new ProgramTreeProvider();
		let semanticRefreshCount = 0;
		let treeRefreshCount = 0;
		const listener = provider.onDidChangeTreeData(() => {
			treeRefreshCount += 1;
		});
		try {
			const originalSource = [
				"# 应用名称",
				"name=旧名称",
				"version.code=1",
				"应用更新.applicationId=旧标识",
				"source=./src",
				""
			].join("\r\n");
			await fs.writeFile(projectFile, originalSource, "utf8");
			assert.equal(await provider.addProject(projectFile), true);
			assert.equal(provider.hasProjectProperties(projectFile), true);
			const project = (await provider.getChildren())[0];
			assert.ok(project?.kind === "project");
			treeRefreshCount = 0;

			await editProjectProperty(provider, {
				refreshProjectSemantics: async () => {
					semanticRefreshCount += 1;
				}
			}, project, "name", "新名称");

			assert.equal(await fs.readFile(projectFile, "utf8"), [
				"# 应用名称",
				"name=新名称",
				"version.code=1",
				"应用更新.applicationId=旧标识",
				"source=./src",
				""
			].join("\r\n"));
			assert.equal(treeRefreshCount, 1);
			assert.equal(semanticRefreshCount, 1);

			await editProjectManifestMacro(provider, {
				refreshProjectSemantics: async () => {
					semanticRefreshCount += 1;
				}
			}, project, "应用更新.applicationId", "新标识");

			assert.equal(await fs.readFile(projectFile, "utf8"), [
				"# 应用名称",
				"name=新名称",
				"version.code=1",
				"应用更新.applicationId=新标识",
				"source=./src",
				""
			].join("\r\n"));
			assert.equal(treeRefreshCount, 2);
			assert.equal(semanticRefreshCount, 2);
		} finally {
			listener.dispose();
			provider.dispose();
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("打开属性命令打开真实 project.properties", async () => {
		const provider = new ProgramTreeProvider();
		const projectFile = testProjectPath("Tetris", "project.properties");
		try {
			assert.equal(await provider.addProject(projectFile), true);
			const project = (await provider.getChildren())[0];
			assert.ok(project?.kind === "project");
			await vscode.commands.executeCommand("es4a.openProjectProperties", project);
			assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, projectFile);
			assert.equal(vscode.window.activeTextEditor?.document.uri.scheme, "file");
		} finally {
			await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
			provider.dispose();
		}
	});

	test("项目移入回收站失败后经再次确认永久删除", async () => {
		const deleteModes: boolean[] = [];
		const trashError = new Error("回收站不可用");
		let confirmedError: unknown;
		assert.equal(await deleteProjectDirectory(
			"删除测试",
			vscode.Uri.file(path.join(os.tmpdir(), "es4a-delete-project")),
			async (_uri, options) => {
				deleteModes.push(options.useTrash);
				if (options.useTrash) {
					throw trashError;
				}
			},
			async (error) => {
				confirmedError = error;
				return true;
			}
		), true);
		assert.equal(confirmedError, trashError);
		assert.deepEqual(deleteModes, [true, false]);
	});

	test("项目移入回收站失败后取消永久删除则保留目录", async () => {
		const deleteModes: boolean[] = [];
		assert.equal(await deleteProjectDirectory(
			"删除取消测试",
			vscode.Uri.file(path.join(os.tmpdir(), "es4a-cancel-delete-project")),
			async (_uri, options) => {
				deleteModes.push(options.useTrash);
				throw new Error("回收站不可用");
			},
			async () => false
		), false);
		assert.deepEqual(deleteModes, [true]);
	});

	test("项目树允许移除不可用的项目记录", async () => {
		const projectFile = path.join(
			os.tmpdir(),
			`es4a-unavailable-project-${process.pid}-${Date.now()}`,
			"project.properties"
		);
		let storedProjectFiles: unknown = [projectFile];
		const state: ProgramProjectState = {
			get<T>(_key: string, defaultValue: T): T {
				return storedProjectFiles === undefined ? defaultValue : storedProjectFiles as T;
			},
			update(_key: string, value: unknown): Thenable<void> {
				storedProjectFiles = value;
				return Promise.resolve();
			}
		};
		const provider = new ProgramTreeProvider(state);
		try {
			const project = (await provider.getChildren())[0];
			assert.ok(project?.kind === "error");
			assert.equal(project.projectFilePath, projectFile);
			const item = provider.getTreeItem(project);
			assert.equal(item.contextValue, "es4a.unavailableProject");
			assertProgramTreeTooltip(item.tooltip, "项目错误", [
				["原因", project.message],
				["路径", projectFile]
			]);
			assert.equal(await provider.removeProject(project.projectFilePath), true);
			assert.deepEqual(storedProjectFiles, []);
			assert.deepEqual(await provider.getChildren(), []);
		} finally {
			provider.dispose();
		}
	});

	test("从项目列表移除项目时先关闭关联单元标签", async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-remove-project-tabs-"));
		const sourceDirectory = path.join(temporaryDirectory, "src");
		const projectFile = path.join(temporaryDirectory, "project.properties");
		const unitFile = path.join(sourceDirectory, "RemovedUnit.simple");
		try {
			await fs.mkdir(sourceDirectory, { recursive: true });
			await fs.writeFile(projectFile, "name=标签关闭测试\r\nsource=./src\r\n", "utf8");
			await fs.writeFile(unitFile, [
				"$属性",
				"\t$资源 $对象",
				"$结束 $属性",
				""
			].join("\r\n"), "utf8");
			assert.equal(
				await vscode.commands.executeCommand<boolean>("es4a.internal.addProject", projectFile),
				true
			);
			await vscode.window.showTextDocument(
				await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(unitFile))),
				{ preview: false }
			);
			assert.equal(vscode.window.tabGroups.all.flatMap((group) => group.tabs).some((tab) => {
				const binding = resolveSimpleUnitTab(tab);
				return binding !== undefined && sameLocalPath(binding.sourceUri.fsPath, unitFile);
			}), true);

			assert.equal(
				await vscode.commands.executeCommand<boolean>("es4a.internal.removeProject", projectFile),
				true
			);
			assert.equal(vscode.window.tabGroups.all.flatMap((group) => group.tabs).some((tab) => {
				const binding = resolveSimpleUnitTab(tab);
				return binding !== undefined && sameLocalPath(binding.sourceUri.fsPath, unitFile);
			}), false);
		} finally {
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("项目树明确显示不可用的单源码目录", async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-missing-source-"));
		const projectFile = path.join(temporaryDirectory, "project.properties");
		const provider = new ProgramTreeProvider();
		try {
			await fs.writeFile(projectFile, "name=缺失源码\r\nsource=./missing\r\n", "utf8");
			assert.equal(await provider.addProject(projectFile), true);
			const project = (await provider.getChildren())[0];
			assert.ok(project?.kind === "project");
			const units = (await provider.getChildren(project)).find((node) => node.kind === "units");
			assert.ok(units);
			const children = await provider.getChildren(units);
			assert.equal(children.length, 1);
			assert.equal(children[0]?.kind, "error");
			assert.equal(children[0]?.label, "源码目录不可用");
			assert.match(children[0]?.message ?? "", /missing/u);
			const error = children[0]!;
			const item = provider.getTreeItem(error);
			assert.equal(item.contextValue, "es4a.error");
			assertProgramTreeTooltip(item.tooltip, "源码目录错误", [
				["原因", error.message]
			]);
		} finally {
			provider.dispose();
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("项目树固定映射并可导出构建目录中的任意文件", async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-build-tree-"));
		const sourceDirectory = path.join(temporaryDirectory, "src");
		const buildDirectory = path.join(temporaryDirectory, "output");
		const nestedDirectory = path.join(buildDirectory, "deploy");
		const projectFile = path.join(temporaryDirectory, "project.properties");
		const provider = new ProgramTreeProvider();
		try {
			await fs.mkdir(sourceDirectory);
			await fs.writeFile(projectFile, [
				"name=构建树",
				"source=./src",
				"build=./output",
				""
			].join("\r\n"), "utf8");
			assert.equal(await provider.addProject(projectFile), true);
			const project = (await provider.getChildren())[0];
			assert.ok(project?.kind === "project");

			const missingBuild = (await provider.getChildren(project)).find(
				(node) => node.kind === "build"
			);
			assert.ok(missingBuild?.kind === "build");
			assert.equal(missingBuild.label, "构建");
			assert.equal(missingBuild.directoryPath, buildDirectory);
			assert.equal(missingBuild.missing, true);
			assert.equal(provider.getTreeItem(missingBuild).contextValue, "es4a.build");

			const refreshed = new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => {
					listener.dispose();
					reject(new Error("首次生成构建目录后项目树没有刷新"));
				}, 5_000);
				const listener = provider.onDidChangeTreeData(() => {
					clearTimeout(timeout);
					listener.dispose();
					resolve();
				});
			});
			await fs.mkdir(nestedDirectory, { recursive: true });
			await refreshed;
			await fs.writeFile(path.join(buildDirectory, "无扩展名"), "output", "utf8");
			await fs.writeFile(path.join(nestedDirectory, "应用.apk"), new Uint8Array([1, 2, 3]));

			const build = (await provider.getChildren(project)).find(
				(node) => node.kind === "build"
			);
			assert.ok(build?.kind === "build");
			assert.equal(build.missing, false);
			const buildItem = provider.getTreeItem(build);
			assert.equal((buildItem.iconPath as vscode.ThemeIcon).id, "package");
			assertProgramTreeTooltip(buildItem.tooltip, "构建", [
				["路径", "./output"]
			], "项目构建目录");
			const buildChildren = await provider.getChildren(build);
			assert.deepEqual(buildChildren.map((node) => [node.kind, node.label]), [
				["directory", "deploy"],
				["file", "无扩展名"]
			]);
			const deploy = buildChildren[0];
			assert.ok(deploy?.kind === "directory");
			assert.equal(deploy.mode, "build");
			assert.equal(provider.getTreeItem(deploy).contextValue, "es4a.buildFolder");
			const apk = (await provider.getChildren(deploy))[0];
			assert.ok(apk?.kind === "file");
			assert.equal(apk.buildOutput, true);
			assert.equal(provider.getTreeItem(apk).contextValue, "es4a.buildFile");
			const exportedFile = path.join(temporaryDirectory, "导出的应用.apk");
			await vscode.commands.executeCommand(
				"es4a.exportBuildFile",
				apk,
				vscode.Uri.file(exportedFile)
			);
			assert.deepEqual(await fs.readFile(exportedFile), Buffer.from([1, 2, 3]));
			await vscode.commands.executeCommand("es4a.internal.deleteUnitFolder", deploy);
			assert.equal(await fs.stat(buildDirectory).then((stat) => stat.isDirectory()), true);
			await assert.rejects(fs.stat(nestedDirectory), { code: "ENOENT" });

			const resources = (await provider.getChildren(project)).find(
				(node) => node.kind === "resources"
			);
			assert.ok(resources?.kind === "resources");
			assert.equal((provider.getTreeItem(resources).iconPath as vscode.ThemeIcon).id, "archive");
		} finally {
			provider.dispose();
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("项目树监听项目外部新增的 Simple 单元", async function () {
		this.timeout(10_000);
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-tree-watch-"));
		const sourceDirectory = path.join(temporaryDirectory, "src");
		const projectFile = path.join(temporaryDirectory, "project.properties");
		const provider = new ProgramTreeProvider();
		try {
			await fs.mkdir(sourceDirectory);
			await fs.writeFile(projectFile, "name=外部变化\r\nsource=./src\r\n", "utf8");
			assert.equal(await provider.addProject(projectFile), true);
			const project = (await provider.getChildren())[0];
			assert.ok(project?.kind === "project");
			const units = (await provider.getChildren(project)).find((node) => node.kind === "units");
			assert.ok(units);
			assert.deepEqual(await provider.getChildren(units), []);

			const refreshed = new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => {
					listener.dispose();
					reject(new Error("外部新增单元后项目树没有刷新"));
				}, 5_000);
				const listener = provider.onDidChangeTreeData(() => {
					clearTimeout(timeout);
					listener.dispose();
					resolve();
				});
			});
			await fs.writeFile(
				path.join(sourceDirectory, "错误代码.simple"),
				"这不是合法的 Simple 代码\r\n",
				"utf8"
			);
			await refreshed;
			const children = await provider.getChildren(units);
			assert.deepEqual(children.map((node) => [node.kind, node.label]), [
				["unit", "错误代码"]
			]);
		} finally {
			provider.dispose();
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("项目树监听项目外部新增的 Res 和 Assets 资源", async function () {
		this.timeout(10_000);
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-resource-watch-"));
		const sourceDirectory = path.join(temporaryDirectory, "src");
		const drawableDirectory = path.join(temporaryDirectory, "res", "drawable");
		const assetsDirectory = path.join(temporaryDirectory, "assets");
		const projectFile = path.join(temporaryDirectory, "project.properties");
		const provider = new ProgramTreeProvider();
		try {
			await Promise.all([
				fs.mkdir(sourceDirectory, { recursive: true }),
				fs.mkdir(drawableDirectory, { recursive: true }),
				fs.mkdir(assetsDirectory, { recursive: true })
			]);
			await fs.writeFile(projectFile, [
				"name=外部资源变化",
				"source=./src",
				"assets=./assets",
				"res=./res",
				""
			].join("\r\n"), "utf8");
			assert.equal(await provider.addProject(projectFile), true);
			const project = (await provider.getChildren())[0];
			assert.ok(project?.kind === "project");

			const waitForRefresh = (message: string): Promise<void> => new Promise((resolve, reject) => {
				const timeout = setTimeout(() => {
					listener.dispose();
					reject(new Error(message));
				}, 5_000);
				const listener = provider.onDidChangeTreeData(() => {
					clearTimeout(timeout);
					listener.dispose();
					resolve();
				});
			});

			const drawableFile = path.join(drawableDirectory, "external.png");
			const resRefreshed = waitForRefresh("外部新增 Res 文件后项目树没有刷新");
			await fs.writeFile(drawableFile, new Uint8Array());
			await resRefreshed;
			const drawable = await provider.findResourceByFilePath(drawableFile);
			assert.equal(drawable?.kind, "file");
			assert.equal(drawable?.resourceRoot, "res");
			assert.equal(provider.getParent(drawable!)?.label, "drawable");

			const assetFile = path.join(assetsDirectory, "external.json");
			const assetsRefreshed = waitForRefresh("外部新增 Assets 文件后项目树没有刷新");
			await fs.writeFile(assetFile, "{}", "utf8");
			await assetsRefreshed;
			const asset = await provider.findResourceByFilePath(assetFile);
			assert.equal(asset?.kind, "file");
			assert.equal(asset?.resourceRoot, "assets");
			assert.equal(provider.getParent(asset!)?.label, "Assets");
		} finally {
			provider.dispose();
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("项目树命令重命名真实 Simple 单元文件", async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-rename-unit-"));
		const sourceFile = path.join(temporaryDirectory, "OldUnit.simple");
		const targetFile = path.join(temporaryDirectory, "NewUnit.simple");
		try {
			await fs.writeFile(sourceFile, "$属性\r\n  $资源 $对象\r\n$结束 $属性\r\n", "utf8");
			await vscode.commands.executeCommand(
				"es4a.renameUnitFile",
				{
					filePath: sourceFile,
					kind: "unit",
					label: "OldUnit",
					unitType: "对象"
				},
				"NewUnit"
			);
			assert.equal(await fs.stat(sourceFile).then(() => true, () => false), false);
			assert.equal(await fs.stat(targetFile).then(() => true, () => false), true);
			assert.match(await fs.readFile(targetFile, "utf8"), /\$资源 \$对象/u);
		} finally {
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("项目树命令重命名窗口单元时同步根定义和用户代码引用", async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-rename-window-unit-"));
		const sourceFile = path.join(temporaryDirectory, "旧窗口.simple");
		const targetFile = path.join(temporaryDirectory, "新窗口.simple");
		try {
			await fs.writeFile(sourceFile, [
				"事件 旧窗口.初始化()",
				"结束 事件",
				"",
				"$属性",
				"\t$资源 $窗口",
				"\t$定义 旧窗口 $为 窗口",
				"\t\t标题 = \"旧窗口\"",
				"\t$结束 $定义",
				"$结束 $属性",
				""
			].join("\r\n"), "utf8");
			await vscode.commands.executeCommand(
				"es4a.renameUnitFile",
				{
					filePath: sourceFile,
					kind: "unit",
					label: "旧窗口",
					unitType: "窗口"
				},
				"新窗口"
			);

			assert.equal(await fs.stat(sourceFile).then(() => true, () => false), false);
			const renamedSource = await fs.readFile(targetFile, "utf8");
			assert.match(renamedSource, /事件 新窗口\.初始化\(\)/u);
			assert.match(renamedSource, /\$定义 新窗口 \$为 窗口/u);
			assert.match(renamedSource, /标题 = "旧窗口"/u);
		} finally {
			await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("项目树快速重复重命名同一窗口单元时不串写后一次内容", async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-rename-window-unit-queue-"));
		const sourceFile = path.join(temporaryDirectory, "旧窗口.simple");
		const firstTargetFile = path.join(temporaryDirectory, "第一次.simple");
		const secondTargetFile = path.join(temporaryDirectory, "第二次.simple");
		try {
			await fs.writeFile(sourceFile, [
				"事件 旧窗口.初始化()",
				"结束 事件",
				"",
				"$属性",
				"\t$资源 $窗口",
				"\t$定义 旧窗口 $为 窗口",
				"\t$结束 $定义",
				"$结束 $属性",
				""
			].join("\r\n"), "utf8");
			const node = {
				filePath: sourceFile,
				kind: "unit",
				label: "旧窗口",
				unitType: "窗口"
			} as const;

			await Promise.all([
				vscode.commands.executeCommand("es4a.renameUnitFile", node, "第一次"),
				vscode.commands.executeCommand("es4a.renameUnitFile", node, "第二次")
			]);

			assert.equal(await fs.stat(sourceFile).then(() => true, () => false), false);
			assert.equal(await fs.stat(firstTargetFile).then(() => true, () => false), true);
			assert.equal(await fs.stat(secondTargetFile).then(() => true, () => false), false);
			const renamedSource = await fs.readFile(firstTargetFile, "utf8");
			assert.match(renamedSource, /事件 第一次\.初始化\(\)/u);
			assert.match(renamedSource, /\$定义 第一次 \$为 窗口/u);
			assert.doesNotMatch(renamedSource, /第二次/u);
		} finally {
			await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("项目树命令按当前文件名同步窗口单元名称并保留未保存状态", async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-sync-unit-file-name-"));
		const sourceFile = path.join(temporaryDirectory, "当前窗口.simple");
		try {
			await fs.writeFile(sourceFile, [
				"事件 旧窗口.初始化()",
				"结束 事件",
				"",
				"$属性",
				"\t$资源 $窗口",
				"\t$定义 旧窗口 $为 窗口",
				"\t\t标题 = \"旧窗口\"",
				"\t$结束 $定义",
				"$结束 $属性",
				""
			].join("\r\n"), "utf8");
			const document = await vscode.workspace.openTextDocument(
				toSimpleCodeUri(vscode.Uri.file(sourceFile))
			);
			await vscode.window.showTextDocument(document, { preview: false });

			await vscode.commands.executeCommand("es4a.syncUnitFileName", {
				filePath: sourceFile,
				kind: "unit",
				label: "当前窗口",
				unitType: "窗口"
			});

			assert.equal(document.isDirty, true);
			assert.match(document.getText(), /事件 当前窗口\.初始化\(\)/u);
			assert.match(await fs.readFile(sourceFile, "utf8"), /\$定义 旧窗口 \$为 窗口/u);
			assert.equal(await document.save(), true);
			const repairedSource = await fs.readFile(sourceFile, "utf8");
			assert.match(repairedSource, /\$定义 当前窗口 \$为 窗口/u);
			assert.match(repairedSource, /标题 = "旧窗口"/u);
		} finally {
			await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("项目树命令重命名单元文件夹及其嵌套内容", async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-rename-folder-"));
		const sourceFolder = path.join(temporaryDirectory, "OldFolder");
		const targetFolder = path.join(temporaryDirectory, "NewFolder");
		const nestedFile = path.join(sourceFolder, "nested", "Unit.simple");
		try {
			await fs.mkdir(path.dirname(nestedFile), { recursive: true });
			await fs.writeFile(nestedFile, "$属性\r\n  $资源 $对象\r\n$结束 $属性\r\n", "utf8");
			await vscode.window.showTextDocument(
				await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(nestedFile))),
				{ preview: false }
			);
			await vscode.commands.executeCommand(
				"es4a.renameUnitFolder",
				{
					directoryPath: sourceFolder,
					kind: "directory",
					label: "OldFolder",
					mode: "units"
				},
				"NewFolder"
			);
			assert.equal(await fs.stat(sourceFolder).then(() => true, () => false), false);
			assert.equal(await fs.stat(targetFolder).then(() => true, () => false), true);
			assert.match(
				await fs.readFile(path.join(targetFolder, "nested", "Unit.simple"), "utf8"),
				/\$资源 \$对象/u
			);
			const reopenedEditor = vscode.window.activeTextEditor;
			assert.ok(reopenedEditor);
			const reopenedSourcePath = toSimpleSourceUri(reopenedEditor.document.uri)?.fsPath;
			const expectedSourcePath = path.join(targetFolder, "nested", "Unit.simple");
			assert.equal(
				process.platform === "win32" ? reopenedSourcePath?.toLowerCase() : reopenedSourcePath,
				process.platform === "win32" ? expectedSourcePath.toLowerCase() : expectedSourcePath
			);
			await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
		} finally {
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("项目树命令重命名资源文件和资源文件夹", async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-rename-resource-"));
		const sourceFolder = path.join(temporaryDirectory, "old");
		const targetFolder = path.join(temporaryDirectory, "new");
		const sourceFile = path.join(sourceFolder, "old-name.png");
		const renamedFile = path.join(sourceFolder, "new-name.png");
		try {
			await fs.mkdir(sourceFolder, { recursive: true });
			await fs.writeFile(sourceFile, "resource", "utf8");
			await vscode.commands.executeCommand(
				"es4a.renameResourceFile",
				{
					filePath: sourceFile,
					kind: "file",
					label: "old-name.png"
				},
				"new-name.png"
			);
			assert.equal(await fs.stat(sourceFile).then(() => true, () => false), false);
			assert.equal(await fs.readFile(renamedFile, "utf8"), "resource");

			await vscode.commands.executeCommand(
				"es4a.renameUnitFolder",
				{
					directoryPath: sourceFolder,
					kind: "directory",
					label: "old",
					mode: "resources"
				},
				"new"
			);
			assert.equal(await fs.stat(sourceFolder).then(() => true, () => false), false);
			assert.equal(await fs.readFile(path.join(targetFolder, "new-name.png"), "utf8"), "resource");
		} finally {
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("项目树命令在 Assets 和 Res 创建文件夹、导入资源并将普通文件另存导出", async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-resource-create-"));
		const sourceFile = path.join(temporaryDirectory, "source", "icon.bin");
		const assetsDirectory = path.join(temporaryDirectory, "project", "assets");
		const resDirectory = path.join(temporaryDirectory, "project", "res");
		try {
			await fs.mkdir(path.dirname(sourceFile), { recursive: true });
			await fs.writeFile(sourceFile, Buffer.from([0, 1, 2, 255]));
			await vscode.commands.executeCommand(
				"es4a.importResource",
				{
					directoryPath: assetsDirectory,
					kind: "assets",
					label: "Assets",
					missing: true,
					mode: "resources",
					resourceRoot: "assets"
				},
				[vscode.Uri.file(sourceFile)]
			);
			const assetFile = path.join(assetsDirectory, "icon.bin");
			assert.deepEqual(
				await fs.readFile(assetFile),
				Buffer.from([0, 1, 2, 255])
			);
			await vscode.commands.executeCommand(
				"es4a.createResourceFolder",
				{
					directoryPath: assetsDirectory,
					kind: "assets",
					label: "Assets",
					missing: false,
					mode: "resources",
					resourceRoot: "assets"
				},
				"docs"
			);
			const docsDirectory = path.join(assetsDirectory, "docs");
			assert.equal((await fs.stat(docsDirectory)).isDirectory(), true);
			await vscode.commands.executeCommand(
				"es4a.createResourceFolder",
				{
					directoryPath: docsDirectory,
					kind: "directory",
					label: "docs",
					mode: "resources",
					resourceRoot: "assets"
				},
				"images"
			);
			assert.equal((await fs.stat(path.join(docsDirectory, "images"))).isDirectory(), true);
			await vscode.commands.executeCommand(
				"es4a.importResource",
				{
					directoryPath: docsDirectory,
					kind: "directory",
					label: "docs",
					mode: "resources",
					resourceRoot: "assets"
				},
				[vscode.Uri.file(sourceFile)]
			);
			assert.deepEqual(
				await fs.readFile(path.join(docsDirectory, "icon.bin")),
				Buffer.from([0, 1, 2, 255])
			);

			await vscode.commands.executeCommand(
				"es4a.createResourceFolder",
				{
					directoryPath: resDirectory,
					kind: "res",
					label: "Res",
					missing: true,
					mode: "resources",
					resourceRoot: "res"
				},
				"drawable"
			);
			const drawableDirectory = path.join(resDirectory, "drawable");
			await vscode.commands.executeCommand(
				"es4a.importResource",
				{
					directoryPath: drawableDirectory,
					kind: "directory",
					label: "drawable",
					mode: "resources",
					resourceRoot: "res"
				},
				[vscode.Uri.file(sourceFile)]
			);
			const resFile = path.join(drawableDirectory, "icon.bin");
			assert.deepEqual(await fs.readFile(resFile), Buffer.from([0, 1, 2, 255]));

			const exportedAssetFile = path.join(temporaryDirectory, "exported-asset.bin");
			await vscode.commands.executeCommand(
				"es4a.exportResource",
				{
					filePath: assetFile,
					kind: "file",
					label: "icon.bin",
					resourceRoot: "assets"
				},
				vscode.Uri.file(exportedAssetFile)
			);
			assert.deepEqual(await fs.readFile(exportedAssetFile), Buffer.from([0, 1, 2, 255]));

			const exportedResFile = path.join(temporaryDirectory, "exported-res.bin");
			await vscode.commands.executeCommand(
				"es4a.exportResource",
				{
					filePath: resFile,
					kind: "file",
					label: "icon.bin",
					resourceRoot: "res"
				},
				vscode.Uri.file(exportedResFile)
			);
			assert.deepEqual(await fs.readFile(exportedResFile), Buffer.from([0, 1, 2, 255]));
		} finally {
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("项目树按 project.properties 路径恢复 SmokeTest 项目", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		const values = new Map<string, unknown>();
		const state: ProgramProjectState = {
			get<T>(key: string, defaultValue: T): T {
				return values.has(key) ? values.get(key) as T : defaultValue;
			},
			update(key: string, value: unknown): Thenable<void> {
				values.set(key, value);
				return Promise.resolve();
			}
		};
		const projectFile = testProjectPath(
			"SmokeTest",
			"project.properties"
		);
		const provider = new ProgramTreeProvider(state);

		assert.equal(await provider.addProject(projectFile), true);
		assert.equal(await provider.addProject(projectFile), false);
		const restoredProvider = new ProgramTreeProvider(state);
		const projects = await restoredProvider.getChildren();
		assert.equal(projects.length, 1);
		const project = projects[0];
		assert.ok(project);
		assert.equal(project.kind, "project");
		assert.equal(project.label, "SmokeTest");
		assert.equal(project.project.filePath, projectFile);
		assert.ok(restoredProvider.getTreeItem(project).id?.includes("project.properties"));
		const groups = await restoredProvider.getChildren(project);
		assert.deepEqual(groups.map((group) => group.label), ["单元", "资源", "构建"]);
		const units = groups.find((group) => group.kind === "units");
		const resources = groups.find((group) => group.kind === "resources");
		assert.ok(units);
		assert.ok(resources);
		const unitsIcon = restoredProvider.getTreeItem(units).iconPath;
		assert.ok(unitsIcon instanceof vscode.ThemeIcon);
		assert.equal(unitsIcon.id, "extensions");
		const sourceRoot = await restoredProvider.getChildren(units);
		assert.deepEqual(sourceRoot.map((node) => node.label), ["simple"]);
		const simpleDirectory = sourceRoot[0];
		assert.ok(simpleDirectory);
		assert.ok(simpleDirectory.kind === "directory");
		const simpleDirectoryItem = restoredProvider.getTreeItem(simpleDirectory);
		assert.equal(simpleDirectoryItem.contextValue, "es4a.unitFolder");
		assert.equal(
			simpleDirectoryItem.resourceUri?.fsPath.toLowerCase(),
			simpleDirectory.directoryPath.toLowerCase()
		);
		assertProgramTreeTooltip(simpleDirectoryItem.tooltip, "源码文件夹", [
			["路径", `.${path.sep}simple`],
			["限定名", "simple"]
		]);
		const simpleChildren = await restoredProvider.getChildren(simpleDirectory);
		const smokeTestDirectory = simpleChildren.find(
			(node) => node.kind === "directory" && node.label === "smoketest"
		);
		assert.ok(smokeTestDirectory);
		assert.ok((await restoredProvider.getChildren(smokeTestDirectory))
			.some((node) => node.label === "SmokeTest"));
		const smokeTestFile = testProjectPath(
			"SmokeTest",
			"src",
			"simple",
			"smoketest",
			"SmokeTest.simple"
		);
		const activeUnit = await restoredProvider.findUnitByFilePath(smokeTestFile);
		assert.ok(activeUnit);
		assert.equal(activeUnit.kind, "unit");
		assert.equal(activeUnit.filePath, smokeTestFile);
		const activeUnitItem = restoredProvider.getTreeItem(activeUnit);
		assert.equal(activeUnit.unitType, "对象");
		assert.equal(activeUnitItem.contextValue, "es4a.objectUnit.none");
		assertProgramTreeTooltip(activeUnitItem.tooltip, "对象单元", [
			["路径", `.${path.sep}${path.join("simple", "smoketest", "SmokeTest.simple")}`],
			["限定名", "simple.smoketest.SmokeTest"]
		]);
		assert.equal(activeUnitItem.resourceUri?.fsPath.toLowerCase(), smokeTestFile.toLowerCase());
		assert.equal(activeUnitItem.command?.command, "vscode.open");
		assert.equal(
			(activeUnitItem.command?.arguments?.[0] as vscode.Uri | undefined)?.toString(),
			toSimpleCodeUri(vscode.Uri.file(smokeTestFile)).toString()
		);
		await vscode.commands.executeCommand("vscode.open", toSimpleCodeUri(vscode.Uri.file(smokeTestFile)));
		const unitCodeEditor = vscode.window.activeTextEditor;
		const unitCodePreviewTab = vscode.window.tabGroups.activeTabGroup.activeTab;
		assert.ok(unitCodeEditor);
		assert.ok(unitCodePreviewTab);
		assert.equal(unitCodeEditor.document.uri.scheme, SIMPLE_CODE_SCHEME);
		assert.equal(unitCodeEditor.document.languageId, "simple");
		assert.equal(unitCodePreviewTab.label, "SmokeTest(代码)");
		assert.equal(
			resolveActiveUnitSourceUri(unitCodeEditor.document)?.fsPath,
			vscode.Uri.file(smokeTestFile).fsPath
		);
		assert.equal(unitCodePreviewTab.isPreview, true);
		await vscode.commands.executeCommand("es4a.previewUnitContent", activeUnit);
		const contentPreviewEditor = vscode.window.activeTextEditor;
		assert.ok(contentPreviewEditor);
		assert.equal(contentPreviewEditor.document.uri.scheme, UNIT_CONTENT_PREVIEW_SCHEME);
		assert.equal(contentPreviewEditor.document.languageId, "simple-full-preview");
		const contentPreviewTab = vscode.window.tabGroups.activeTabGroup.activeTab;
		assert.equal(contentPreviewTab?.label, "SmokeTest(完整代码)");
		assert.equal(contentPreviewTab?.isPreview, false);
		assert.equal(
			resolveActiveUnitSourceUri(contentPreviewEditor.document)?.fsPath,
			vscode.Uri.file(smokeTestFile).fsPath
		);
		assert.equal(path.basename(contentPreviewEditor.document.uri.path), "SmokeTest(完整代码)");
		assert.match(contentPreviewEditor.document.getText(), /^\$属性$/mu);
		assert.notEqual(vscode.workspace.fs.isWritableFileSystem(UNIT_CONTENT_PREVIEW_SCHEME), true);

		await vscode.commands.executeCommand("es4a.previewUnitXml", activeUnit);
		const xmlPreviewEditor = vscode.window.activeTextEditor;
		assert.ok(xmlPreviewEditor);
		assert.equal(xmlPreviewEditor.document.uri.scheme, UNIT_XML_PREVIEW_SCHEME);
		assert.equal(
			resolveActiveUnitSourceUri(xmlPreviewEditor.document)?.fsPath,
			vscode.Uri.file(smokeTestFile).fsPath
		);
		assert.equal(xmlPreviewEditor.document.languageId, "simple-property-xml");
		const xmlPreviewTab = vscode.window.tabGroups.activeTabGroup.activeTab;
		assert.equal(xmlPreviewTab?.label, "SmokeTest(属性)");
		assert.equal(xmlPreviewTab?.isPreview, false);
		assert.equal(path.basename(xmlPreviewEditor.document.uri.path), "SmokeTest(属性)");
		assert.match(xmlPreviewEditor.document.getText(), /<资源 单元="对象" \/>/u);
		assert.notEqual(vscode.workspace.fs.isWritableFileSystem(UNIT_XML_PREVIEW_SCHEME), true);
		const parentLabels: string[] = [];
		let parent = restoredProvider.getParent(activeUnit);
		while (parent !== undefined) {
			parentLabels.push(parent.label);
			parent = restoredProvider.getParent(parent);
		}
		assert.deepEqual(parentLabels, ["smoketest", "simple", "单元", "SmokeTest"]);
		assert.equal(
			await restoredProvider.findUnitByFilePath(path.resolve(extension.extensionPath, "outside.simple")),
			undefined
		);
		const mappedResources = await restoredProvider.getChildren(resources);
		assert.deepEqual(mappedResources.map((node) => node.label), ["Assets", "Res"]);
		assert.equal(mappedResources[0]?.kind, "assets");
		assert.equal(mappedResources[1]?.kind, "res");
		const assetsItem = restoredProvider.getTreeItem(mappedResources[0]!);
		const missingResourceItem = restoredProvider.getTreeItem(mappedResources[1]!);
		assert.ok(assetsItem.iconPath instanceof vscode.ThemeIcon);
		assert.equal(assetsItem.iconPath.id, "folder-library");
		assert.equal(assetsItem.resourceUri, undefined);
		assert.equal(missingResourceItem.description, undefined);
		assert.ok(missingResourceItem.iconPath instanceof vscode.ThemeIcon);
		assert.equal(missingResourceItem.iconPath.id, "folder-library");
		assert.equal(missingResourceItem.resourceUri, undefined);
		assert.equal(await restoredProvider.removeProject(projectFile), true);
		assert.equal(await restoredProvider.removeProject(projectFile), false);
		const removedProvider = new ProgramTreeProvider(state);
		assert.deepEqual(await removedProvider.getChildren(), []);

		provider.dispose();
		restoredProvider.dispose();
		removedProvider.dispose();
	});

	test("项目树单元提示显示继承、限定名和 source 相对路径", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		const projectFile = testProjectPath("SmokeTest", "project.properties");
		const smokeTestFile = testProjectPath(
			"SmokeTest", "src", "simple", "smoketest", "SmokeTest.simple"
		);
		const interfaceFile = testProjectPath("SmokeTest", "src", "simple", "smoketest", "Test.simple");
		const baseObjectFile = testProjectPath(
			"SmokeTest", "src", "simple", "smoketest", "utils", "BaseObject.simple"
		);
		const derivedObjectFile = testProjectPath(
			"SmokeTest", "src", "simple", "smoketest", "utils", "DerivedObject.simple"
		);
		const provider = new ProgramTreeProvider();
		try {
			assert.equal(await provider.addProject(projectFile), true);
			const project = (await provider.getChildren())[0];
			assert.ok(project?.kind === "project");
			assertProgramTreeTooltip(provider.getTreeItem(project).tooltip, "SmokeTest", [
				["主单元", "simple.smoketest.Main"],
				["版本号", "1"],
				["版本名", "1.0"]
			]);
			const units = (await provider.getChildren(project)).find((node) => node.kind === "units");
			assert.ok(units);
			assertProgramTreeTooltip(provider.getTreeItem(units).tooltip, "单元", [
				["路径", "./src"]
			], "项目源代码");
			const sourceDirectory = (await provider.getChildren(units))[0];
			assert.ok(sourceDirectory?.kind === "directory");
			assertProgramTreeTooltip(provider.getTreeItem(sourceDirectory).tooltip, "源码文件夹", [
				["路径", `.${path.sep}simple`],
				["限定名", "simple"]
			]);
			const smokeTestDirectory = (await provider.getChildren(sourceDirectory))[0];
			assert.ok(smokeTestDirectory?.kind === "directory");
			assertProgramTreeTooltip(provider.getTreeItem(smokeTestDirectory).tooltip, "源码文件夹", [
				["路径", `.${path.sep}${path.join("simple", "smoketest")}`],
				["限定名", "simple.smoketest"]
			]);

			const unit = await provider.findUnitByFilePath(smokeTestFile);
			assert.ok(unit?.kind === "unit");
			assert.equal(provider.getTreeItem(unit).contextValue, "es4a.objectUnit.none");
			assertProgramTreeTooltip(provider.getTreeItem(unit).tooltip, "对象单元", [
				["路径", `.${path.sep}${path.join("simple", "smoketest", "SmokeTest.simple")}`],
				["限定名", "simple.smoketest.SmokeTest"]
			]);

			const interfaceUnit = await provider.findUnitByFilePath(interfaceFile);
			assert.ok(interfaceUnit?.kind === "unit");
			assertProgramTreeTooltip(provider.getTreeItem(interfaceUnit).tooltip, "接口单元", [
				["路径", `.${path.sep}${path.join("simple", "smoketest", "Test.simple")}`],
				["限定名", "simple.smoketest.Test"]
			]);

			const baseObject = await provider.findUnitByFilePath(baseObjectFile);
			assert.ok(baseObject?.kind === "unit");
			assert.equal(provider.getTreeItem(baseObject).contextValue, "es4a.objectUnit.interfaces");
			assertProgramTreeTooltip(provider.getTreeItem(baseObject).tooltip, "对象单元", [
				["路径", `.${path.sep}${path.join("simple", "smoketest", "utils", "BaseObject.simple")}`],
				["限定名", "simple.smoketest.utils.BaseObject"],
				["实现接口", "simple.smoketest.utils.ObjectNameInterface"]
			]);

			const derivedObject = await provider.findUnitByFilePath(derivedObjectFile);
			assert.ok(derivedObject?.kind === "unit");
			assert.equal(provider.getTreeItem(derivedObject).contextValue, "es4a.objectUnit.baseObject");
			assertProgramTreeTooltip(provider.getTreeItem(derivedObject).tooltip, "对象单元", [
				["路径", `.${path.sep}${path.join("simple", "smoketest", "utils", "DerivedObject.simple")}`],
				["限定名", "simple.smoketest.utils.DerivedObject"],
				["基础对象", "simple.smoketest.utils.BaseObject"]
			]);
			const combinedObjectItem = provider.getTreeItem({
				...derivedObject,
				interfaces: ["simple.smoketest.utils.ObjectNameInterface"]
			});
			assert.equal(
				combinedObjectItem.contextValue,
				"es4a.objectUnit.baseObjectAndInterfaces"
			);
			assertProgramTreeTooltip(combinedObjectItem.tooltip, "对象单元", [
				["路径", `.${path.sep}${path.join("simple", "smoketest", "utils", "DerivedObject.simple")}`],
				["限定名", "simple.smoketest.utils.DerivedObject"],
				["基础对象", "simple.smoketest.utils.BaseObject"],
				["实现接口", "simple.smoketest.utils.ObjectNameInterface"]
			]);
		} finally {
			provider.dispose();
		}
	});

	test("项目树源码文件夹和单元复制名称、限定名及真实路径", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		await extension.activate();
		const projectFile = testProjectPath("SmokeTest", "project.properties");
		const derivedObjectFile = path.resolve(
			path.dirname(projectFile),
			"src", "simple", "smoketest", "utils", "DerivedObject.simple"
		);
		const baseObjectFile = path.resolve(
			path.dirname(projectFile),
			"src", "simple", "smoketest", "utils", "BaseObject.simple"
		);
		const provider = new ProgramTreeProvider();
		const previousClipboard = await vscode.env.clipboard.readText();
		try {
			assert.equal(await provider.addProject(projectFile), true);
			const project = (await provider.getChildren())[0];
			assert.ok(project?.kind === "project");
			const units = (await provider.getChildren(project)).find((node) => node.kind === "units");
			assert.ok(units);
			const sourceDirectory = (await provider.getChildren(units))[0];
			assert.ok(sourceDirectory?.kind === "directory");
			const smokeTestDirectory = (await provider.getChildren(sourceDirectory))[0];
			assert.ok(smokeTestDirectory?.kind === "directory");
			const derivedObject = await provider.findUnitByFilePath(derivedObjectFile);
			const baseObject = await provider.findUnitByFilePath(baseObjectFile);
			assert.ok(derivedObject?.kind === "unit");
			assert.ok(baseObject?.kind === "unit");

			await vscode.commands.executeCommand("es4a.copyUnitFolderQualifiedName", smokeTestDirectory);
			assert.equal(await vscode.env.clipboard.readText(), "simple.smoketest");

			await vscode.commands.executeCommand("es4a.copyUnitFolderName", smokeTestDirectory);
			assert.equal(await vscode.env.clipboard.readText(), "smoketest");

			await vscode.commands.executeCommand("es4a.copyUnitFolderRelativePath", smokeTestDirectory);
			assert.equal(
				await vscode.env.clipboard.readText(),
				path.join("src", "simple", "smoketest")
			);

			await vscode.commands.executeCommand("es4a.copyUnitFolderAbsolutePath", smokeTestDirectory);
			assert.equal(await vscode.env.clipboard.readText(), smokeTestDirectory.directoryPath);

			await vscode.commands.executeCommand("es4a.copyUnitName", derivedObject);
			assert.equal(await vscode.env.clipboard.readText(), "DerivedObject");

			await vscode.commands.executeCommand("es4a.copyUnitQualifiedName", derivedObject);
			assert.equal(
				await vscode.env.clipboard.readText(),
				"simple.smoketest.utils.DerivedObject"
			);

			await vscode.commands.executeCommand("es4a.copyUnitBaseObjectQualifiedName", derivedObject);
			assert.equal(
				await vscode.env.clipboard.readText(),
				"simple.smoketest.utils.BaseObject"
			);

			await vscode.commands.executeCommand(
				"es4a.copyUnitImplementedInterfacesQualifiedName",
				baseObject
			);
			assert.equal(
				await vscode.env.clipboard.readText(),
				"simple.smoketest.utils.ObjectNameInterface"
			);

			await vscode.commands.executeCommand("es4a.copyUnitRelativePath", derivedObject);
			assert.equal(
				await vscode.env.clipboard.readText(),
				path.join("src", "simple", "smoketest", "utils", "DerivedObject.simple")
			);

			await vscode.commands.executeCommand("es4a.copyUnitAbsolutePath", derivedObject);
			assert.equal(await vscode.env.clipboard.readText(), derivedObjectFile);
		} finally {
			await vscode.env.clipboard.writeText(previousClipboard);
			provider.dispose();
		}
	});

	test("项目树资源分组提示统一使用映射目录相对路径", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		const projectFile = testProjectPath("SmokeTests", "project.properties");
		const provider = new ProgramTreeProvider();
		try {
			assert.equal(await provider.addProject(projectFile), true);
			const project = (await provider.getChildren())[0];
			assert.ok(project?.kind === "project");
			const resources = (await provider.getChildren(project)).find((node) => node.kind === "resources");
			assert.ok(resources);
			const resourcesIcon = provider.getTreeItem(resources).iconPath;
			assert.ok(resourcesIcon instanceof vscode.ThemeIcon);
			assert.equal(resourcesIcon.id, "archive");
			assertProgramTreeTooltip(
				provider.getTreeItem(resources).tooltip,
				"资源",
				[],
				"项目资产和资源"
			);
			const roots = await provider.getChildren(resources);
			const assets = roots.find((node) => node.kind === "assets");
			const res = roots.find((node) => node.kind === "res");
			assert.ok(assets);
			assert.ok(res);
			const assetsIcon = provider.getTreeItem(assets).iconPath;
			const resIcon = provider.getTreeItem(res).iconPath;
			assert.ok(assetsIcon instanceof vscode.ThemeIcon);
			assert.ok(resIcon instanceof vscode.ThemeIcon);
			assert.equal(assetsIcon.id, "folder-library");
			assert.equal(resIcon.id, "folder-library");
			assert.equal(provider.getTreeItem(assets).contextValue, "es4a.assets");
			assert.equal(provider.getTreeItem(res).contextValue, "es4a.res");
			assert.equal(await provider.getSingleDirectoryChild(resources), undefined);
			assertProgramTreeTooltip(provider.getTreeItem(assets).tooltip, "Assets", [
				["路径", "./assets"]
			], "项目资产");
			assertProgramTreeTooltip(provider.getTreeItem(res).tooltip, "Res", [
				["路径", "./res"]
			], "项目资源");

			const assetFile = (await provider.getChildren(assets)).find(
				(node) => node.kind === "file" && node.label === "android.png"
			);
			assert.ok(assetFile);
			assert.equal(provider.getTreeItem(assetFile).contextValue, "es4a.assetsFile");
			assert.equal(await provider.getSingleDirectoryChild(assets), undefined);
			assertProgramTreeTooltip(provider.getTreeItem(assetFile).tooltip, "Assets 文件", [
				["路径", `.${path.sep}android.png`]
			]);
			assert.equal(await provider.getSingleDirectoryChild(res), undefined);
			const drawable = (await provider.getChildren(res)).find(
				(node) => node.kind === "directory" && node.label === "drawable"
			);
			assert.ok(drawable);
			assert.equal(drawable.label, "drawable");
			const drawableIcon = provider.getTreeItem(drawable).iconPath;
			assert.ok(drawableIcon instanceof vscode.ThemeIcon);
			assert.equal(drawableIcon.id, "file-submodule");
			assert.equal(provider.getTreeItem(drawable).contextValue, "es4a.resFolder");
			assertProgramTreeTooltip(provider.getTreeItem(drawable).tooltip, "Res 文件夹", [
				["路径", `.${path.sep}drawable`]
			]);
			const resourceFile = (await provider.getChildren(drawable)).find(
				(node) => node.kind === "file" && node.label === "icon.png"
			);
			assert.ok(resourceFile);
			assert.equal(provider.getTreeItem(resourceFile).contextValue, "es4a.resFile.indexed");
			assert.equal(await provider.getSingleDirectoryChild(drawable), undefined);
			assertProgramTreeTooltip(provider.getTreeItem(resourceFile).tooltip, "Res 资源文件", [
				["路径", `.${path.sep}${path.join("drawable", "icon.png")}`],
				["索引", "R.drawable_icon"]
			]);
		} finally {
			provider.dispose();
		}
	});

	test("项目树逐级显示并识别单目录链与分支", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		const projectFile = testProjectPath(
			"SmokeTests",
			"project.properties"
		);
		const provider = new ProgramTreeProvider();
		await provider.addProject(projectFile);
		const project = (await provider.getChildren())[0];
		assert.ok(project?.kind === "project");
		const units = (await provider.getChildren(project)).find((node) => node.kind === "units");
		assert.ok(units);
		const simpleDirectory = await provider.getSingleDirectoryChild(units);
		assert.ok(simpleDirectory);
		assert.equal(simpleDirectory.label, "simple");
		const simpleDirectoryIcon = provider.getTreeItem(simpleDirectory).iconPath;
		assert.ok(simpleDirectoryIcon instanceof vscode.ThemeIcon);
		assert.equal(simpleDirectoryIcon.id, "file-submodule");
		assert.equal(
			simpleDirectory.directoryPath,
			path.resolve(path.dirname(projectFile), "src", "simple")
		);
		assert.equal(await provider.getSingleDirectoryChild(simpleDirectory), undefined);
		const runtimeDirectory = (await provider.getChildren(simpleDirectory)).find(
			(node) => node.kind === "directory" && node.label === "runtime"
		);
		assert.ok(runtimeDirectory);
		assert.equal(runtimeDirectory.label, "runtime");
		const smokeTestDirectory = await provider.getSingleDirectoryChild(runtimeDirectory);
		assert.ok(smokeTestDirectory);
		assert.equal(smokeTestDirectory.label, "smoketests");
		assert.equal(
			smokeTestDirectory.directoryPath,
			path.resolve(path.dirname(projectFile), "src", "simple", "runtime", "smoketests")
		);
		assert.ok((await provider.getChildren(smokeTestDirectory)).length > 1);
		assert.equal(await provider.getSingleDirectoryChild(smokeTestDirectory), undefined);
		provider.dispose();
	});

	test("单目录链自动展开不抢占活动单元定位", async () => {
		const simpleDirectory: DirectoryNode = {
			directoryPath: path.resolve("src", "simple"),
			kind: "directory",
			label: "simple",
			mode: "units"
		};
		const runtimeDirectory: DirectoryNode = {
			directoryPath: path.resolve("src", "simple", "runtime"),
			kind: "directory",
			label: "runtime",
			mode: "units"
		};
		const smokeTestsDirectory: DirectoryNode = {
			directoryPath: path.resolve("src", "simple", "runtime", "smoketests"),
			kind: "directory",
			label: "smoketests",
			mode: "units"
		};
		const activeUnit: FileNode = {
			filePath: path.resolve(smokeTestsDirectory.directoryPath, "主窗口.simple"),
			kind: "unit",
			label: "主窗口"
		};
		const resourceFile: FileNode = {
			filePath: path.resolve("res", "drawable", "icon.png"),
			kind: "file",
			label: "icon.png",
			resourceRoot: "res"
		};
		const children = new Map<ProgramTreeNode, DirectoryNode | undefined>([
			[simpleDirectory, runtimeDirectory],
			[runtimeDirectory, smokeTestsDirectory],
			[smokeTestsDirectory, undefined]
		]);
		let finishExpansion: (() => void) | undefined;
		const expansionFinished = new Promise<void>((resolve) => {
			finishExpansion = resolve;
		});
		const provider: ProgramTreeExpansionProvider = {
			async getSingleDirectoryChild(node): Promise<DirectoryNode | undefined> {
				const child = children.get(node);
				if (node === smokeTestsDirectory) {
					finishExpansion?.();
				}
				return child;
			}
		};
		const expandEmitter = new vscode.EventEmitter<vscode.TreeViewExpansionEvent<ProgramTreeNode>>();
		const collapseEmitter = new vscode.EventEmitter<vscode.TreeViewExpansionEvent<ProgramTreeNode>>();
		const reveals: Array<{
			readonly element: ProgramTreeNode;
			readonly options: { expand?: boolean | number; focus?: boolean; select?: boolean } | undefined;
		}> = [];
		const view: ProgramTreeExpansionView = {
			onDidCollapseElement: collapseEmitter.event,
			onDidExpandElement: expandEmitter.event,
			reveal(element, options): Thenable<void> {
				reveals.push({ element, options });
				if (element === activeUnit) {
					expandEmitter.fire({ element: simpleDirectory });
				}
				return Promise.resolve();
			}
		};
		const controller = new ProgramTreeExpansionController(provider, view, assert.fail);
		try {
			expandEmitter.fire({ element: simpleDirectory });
			await expansionFinished;
			assert.deepEqual(
				reveals.map(({ element }) => element.label),
				["runtime", "smoketests"]
			);
			assert.ok(reveals.every(({ options }) => (
				options?.expand === true && options.focus === false && options.select === false
			)));

			reveals.length = 0;
			await controller.revealActiveUnit(activeUnit);
			assert.deepEqual(reveals, [{
				element: activeUnit,
				options: { focus: false, select: true }
			}]);

			reveals.length = 0;
			await controller.revealResource(resourceFile);
			assert.deepEqual(reveals, [{
				element: resourceFile,
				options: { focus: false, select: true }
			}]);
		} finally {
			controller.dispose();
			expandEmitter.dispose();
			collapseEmitter.dispose();
		}
	});

	test("重命名单元后恢复代码和两个预览标签", async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-rename-unit-tabs-"));
		const sourceFile = path.join(temporaryDirectory, "旧对象.simple");
		const targetFile = path.join(temporaryDirectory, "新对象.simple");
		const sourceUri = vscode.Uri.file(sourceFile);
		try {
			await fs.writeFile(sourceFile, "$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n", "utf8");
			const node: FileNode = {
				filePath: sourceFile,
				kind: "unit",
				label: "旧对象",
				unitType: "对象"
			};
			await vscode.window.showTextDocument(
				await vscode.workspace.openTextDocument(toSimpleCodeUri(sourceUri)),
				{ preview: false }
			);
			await vscode.commands.executeCommand("es4a.previewUnitContent", node);
			await vscode.commands.executeCommand("es4a.previewUnitXml", node);

			await vscode.commands.executeCommand("es4a.renameUnitFile", node, "新对象");
			const reopenedKinds = vscode.window.tabGroups.all.flatMap((group) => (
				group.tabs.flatMap((tab) => {
					const binding = resolveSimpleUnitTab(tab);
					return binding !== undefined && sameLocalPath(binding.sourceUri.fsPath, targetFile)
						? [binding.kind]
						: [];
				})
			));
			assert.deepEqual(new Set(reopenedKinds), new Set(["code", "contentPreview", "xmlPreview"]));
		} finally {
			const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs.filter((tab) => {
				const binding = resolveSimpleUnitTab(tab);
				return binding !== undefined && sameLocalPath(binding.sourceUri.fsPath, targetFile);
			}));
			if (tabs.length > 0) await vscode.window.tabGroups.close(tabs, true);
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("活动单元 URI 未变化但树节点失选时重新定位", async () => {
		const sourceUri = vscode.Uri.file(path.resolve("src", "simple", "main", "主窗口.simple"));
		const activeUnit: FileNode = {
			filePath: sourceUri.fsPath,
			kind: "unit",
			label: "主窗口",
			unitType: "窗口"
		};
		const programs = {
			findUnitByFilePath: async () => activeUnit
		} as unknown as ProgramTreeProvider;
		const expandEmitter = new vscode.EventEmitter<vscode.TreeViewExpansionEvent<ProgramTreeNode>>();
		const collapseEmitter = new vscode.EventEmitter<vscode.TreeViewExpansionEvent<ProgramTreeNode>>();
		let selectedUnit: FileNode | undefined;
		let revealCount = 0;
		let revealFinished: (() => void) | undefined;
		const expansion = new ProgramTreeExpansionController(
			{ async getSingleDirectoryChild() { return undefined; } },
			{
				onDidCollapseElement: collapseEmitter.event,
				onDidExpandElement: expandEmitter.event,
				reveal(): Thenable<void> {
					revealCount += 1;
					revealFinished?.();
					return Promise.resolve();
				}
			},
			assert.fail
		);
		const controller = new ProgramRevealController(
			programs,
			expansion,
			() => selectedUnit,
			assert.fail
		);
		const scheduleAndWait = async (): Promise<void> => {
			await new Promise<void>((resolve) => {
				revealFinished = resolve;
				controller.schedule(sourceUri);
			});
			revealFinished = undefined;
		};
		try {
			await scheduleAndWait();
			assert.equal(revealCount, 1);

			/* 项目刷新或同路径重建会丢失树选择，此时相同 URI 也必须再次定位。 */
			await scheduleAndWait();
			assert.equal(revealCount, 2);

			selectedUnit = activeUnit;
			controller.schedule(sourceUri);
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.equal(revealCount, 2);
		} finally {
			controller.dispose();
			expansion.dispose();
			expandEmitter.dispose();
			collapseEmitter.dispose();
		}
	});

	test("项目树拖动顶层项目并持久化排序", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		const values = new Map<string, unknown>();
		const state: ProgramProjectState = {
			get<T>(key: string, defaultValue: T): T {
				return values.has(key) ? values.get(key) as T : defaultValue;
			},
			update(key: string, value: unknown): Thenable<void> {
				values.set(key, value);
				return Promise.resolve();
			}
		};
		const testProjectFile = (name: SimpleTestProjectName): string => testProjectPath(name, "project.properties");
		const provider = new ProgramTreeProvider(state);
		await provider.addProject(testProjectFile("SmokeTest"));
		await provider.addProject(testProjectFile("StartTests"));
		await provider.addProject(testProjectFile("Tetris"));
		const projects = await provider.getChildren();
		const source = projects.find((node) => node.kind === "project" && node.label === "Tetris");
		const target = projects.find((node) => node.kind === "project" && node.label === "SmokeTest");
		assert.ok(source);
		assert.ok(target);

		const dataTransfer = new vscode.DataTransfer();
		const cancellation = new vscode.CancellationTokenSource();
		provider.handleDrag([source], dataTransfer, cancellation.token);
		await provider.handleDrop(target, dataTransfer, cancellation.token);
		assert.deepEqual(
			(await provider.getChildren()).map((node) => node.label),
			["Tetris", "SmokeTest", "StartTests"]
		);

		const restoredProvider = new ProgramTreeProvider(state);
		assert.deepEqual(
			(await restoredProvider.getChildren()).map((node) => node.label),
			["Tetris", "SmokeTest", "StartTests"]
		);
		const restoredProjects = await restoredProvider.getChildren();
		const firstProject = restoredProjects[0];
		assert.ok(firstProject);
		const moveToEndTransfer = new vscode.DataTransfer();
		restoredProvider.handleDrag([firstProject], moveToEndTransfer, cancellation.token);
		await restoredProvider.handleDrop(undefined, moveToEndTransfer, cancellation.token);
		assert.deepEqual(
			(await restoredProvider.getChildren()).map((node) => node.label),
			["SmokeTest", "StartTests", "Tetris"]
		);
		cancellation.dispose();
		provider.dispose();
		restoredProvider.dispose();
	});

	test("项目树把单个单元拖到源码文件夹或目标单元的同级目录", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		const projectFile = testProjectPath(
			"SmokeTests",
			"project.properties"
		);
		const sourceFile = await simpleTestUnitPath("SmokeTests", "测试对象");
		const provider = new ProgramTreeProvider();
		await provider.addProject(projectFile);
		const source = await provider.findUnitByFilePath(sourceFile);
		assert.ok(source?.project);
		const target: DirectoryNode = {
			directoryPath: path.dirname(sourceFile),
			kind: "directory",
			label: "smoketests",
			mode: "units",
			project: source.project
		};
		let movedSource: FileNode | undefined;
		let movedTarget: DirectoryNode | undefined;
		provider.setUnitMoveHandler((candidate, directory) => {
			movedSource = candidate;
			movedTarget = directory;
			return Promise.resolve();
		});
		const dataTransfer = new vscode.DataTransfer();
		const cancellation = new vscode.CancellationTokenSource();
		provider.handleDrag([source], dataTransfer, cancellation.token);
		await provider.handleDrop(target, dataTransfer, cancellation.token);
		assert.equal(movedSource?.filePath, sourceFile);
		assert.equal(movedTarget, target);

		const siblingDirectory = path.resolve(path.dirname(sourceFile), "..", "visuals");
		const targetUnit: FileNode = {
			filePath: path.join(siblingDirectory, "目标单元.simple"),
			kind: "unit",
			label: "目标单元",
			project: source.project
		};
		await provider.handleDrop(targetUnit, dataTransfer, cancellation.token);
		assert.equal(movedSource?.filePath, sourceFile);
		assert.equal(movedTarget?.directoryPath, siblingDirectory);
		assert.equal(movedTarget?.project, source.project);
		cancellation.dispose();
		provider.dispose();
	});

	test("单元移动事务明确拒绝跨项目拖拽且不改文件", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		await extension.activate();
		const sourceProject = await loadSimpleProject(testProjectPath("SmokeTests", "project.properties"));
		const targetProject = await loadSimpleProject(testProjectPath("StartTests", "project.properties"));
		const sourceFile = await simpleTestUnitPath("SmokeTests", "测试对象");
		const targetDirectory = path.resolve(targetProject.directory, "src", "simple", "runtime");
		const targetFile = path.join(targetDirectory, path.basename(sourceFile));
		const source: FileNode = {
			filePath: sourceFile,
			kind: "unit",
			label: "测试对象",
			project: sourceProject
		};
		const target: DirectoryNode = {
			directoryPath: targetDirectory,
			kind: "directory",
			label: "runtime",
			mode: "units",
			project: targetProject
		};

		await assert.rejects(
			async () => vscode.commands.executeCommand("es4a.internal.moveUnitToFolder", source, target),
			/暂不支持跨项目移动单元/u
		);
		assert.equal((await fs.stat(sourceFile)).isFile(), true);
		await assert.rejects(fs.stat(targetFile), { code: "ENOENT" });
	});

	test("移动单元后代码和两个预览标签都迁移到新 URI", async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-move-unit-tabs-"));
		const sourceRoot = path.join(temporaryDirectory, "src");
		const sourceDirectory = path.join(sourceRoot, "old");
		const targetDirectory = path.join(sourceRoot, "new");
		const projectFile = path.join(temporaryDirectory, "project.properties");
		const sourceFile = path.join(sourceDirectory, "对象1.simple");
		const targetFile = path.join(targetDirectory, "对象1.simple");
		const tabKindsAt = (filePath: string): Set<string> => new Set(
			vscode.window.tabGroups.all.flatMap((group) => (
				group.tabs.flatMap((tab) => {
					const binding = resolveSimpleUnitTab(tab);
					return binding !== undefined && sameLocalPath(binding.sourceUri.fsPath, filePath)
						? [binding.kind]
						: [];
				})
			))
		);
		const waitForMoveState = async (existingFile: string, missingFile: string): Promise<void> => {
			for (let attempt = 0; attempt < 50; attempt += 1) {
				if (
					await fileExists(existingFile)
					&& !await fileExists(missingFile)
					&& tabKindsAt(existingFile).size === 3
				) {
					return;
				}
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			assert.fail(`单元移动状态未同步到 ${existingFile}`);
		};
		try {
			await fs.mkdir(sourceDirectory, { recursive: true });
			await fs.mkdir(targetDirectory, { recursive: true });
			await fs.writeFile(projectFile, "name=单元移动标签测试\r\nsource=./src\r\nbuild=./build\r\n", "utf8");
			await fs.writeFile(sourceFile, "$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n", "utf8");
			await vscode.commands.executeCommand("es4a.internal.addProject", projectFile);
			const project = await loadSimpleProject(projectFile);
			const source: FileNode = {
				filePath: sourceFile,
				kind: "unit",
				label: "对象1",
				project,
				unitType: "对象"
			};
			const target: DirectoryNode = {
				directoryPath: targetDirectory,
				kind: "directory",
				label: "new",
				mode: "units",
				project
			};
			await vscode.window.showTextDocument(
				await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(sourceFile))),
				{ preview: false }
			);
			await vscode.commands.executeCommand("es4a.previewUnitContent", source);
			await vscode.commands.executeCommand("es4a.previewUnitXml", source);

			await vscode.commands.executeCommand("es4a.internal.moveUnitToFolder", source, target);
			await waitForMoveState(targetFile, sourceFile);
			assert.deepEqual(tabKindsAt(targetFile), new Set(["code", "contentPreview", "xmlPreview"]));

			const undoEdit = new vscode.WorkspaceEdit();
			undoEdit.renameFile(
				toSimpleCodeUri(vscode.Uri.file(targetFile)),
				toSimpleCodeUri(vscode.Uri.file(sourceFile)),
				{ overwrite: false }
			);
			assert.equal(await vscode.workspace.applyEdit(undoEdit), true);
			await waitForMoveState(sourceFile, targetFile);
			assert.deepEqual(tabKindsAt(sourceFile), new Set(["code", "contentPreview", "xmlPreview"]));

			const redoEdit = new vscode.WorkspaceEdit();
			redoEdit.renameFile(
				toSimpleCodeUri(vscode.Uri.file(sourceFile)),
				toSimpleCodeUri(vscode.Uri.file(targetFile)),
				{ overwrite: false }
			);
			assert.equal(await vscode.workspace.applyEdit(redoEdit), true);
			await waitForMoveState(targetFile, sourceFile);
			assert.deepEqual(tabKindsAt(targetFile), new Set(["code", "contentPreview", "xmlPreview"]));
		} finally {
			const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs.filter((tab) => {
				const binding = resolveSimpleUnitTab(tab);
				return binding !== undefined && (
					sameLocalPath(binding.sourceUri.fsPath, sourceFile)
					|| sameLocalPath(binding.sourceUri.fsPath, targetFile)
				);
			}));
			if (tabs.length > 0) await vscode.window.tabGroups.close(tabs, true);
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("设计器打开时拒绝移动单元并保留原文件", async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-move-open-designer-"));
		const sourceRoot = path.join(temporaryDirectory, "src");
		const sourceDirectory = path.join(sourceRoot, "old");
		const targetDirectory = path.join(sourceRoot, "new");
		const projectFile = path.join(temporaryDirectory, "project.properties");
		const sourceFile = path.join(sourceDirectory, "窗口1.simple");
		const targetFile = path.join(targetDirectory, "窗口1.simple");
		try {
			await fs.mkdir(sourceDirectory, { recursive: true });
			await fs.mkdir(targetDirectory, { recursive: true });
			await fs.writeFile(projectFile, "name=设计器移动测试\r\nsource=./src\r\nbuild=./build\r\n", "utf8");
			await fs.writeFile(sourceFile, [
				"$属性",
				"\t$资源 $窗口",
				"\t$定义 窗口1 $为 窗口",
				"\t$结束 $定义",
				"$结束 $属性",
				""
			].join("\r\n"), "utf8");
			await vscode.commands.executeCommand("es4a.internal.addProject", projectFile);
			const project = await loadSimpleProject(projectFile);
			const source: FileNode = {
				filePath: sourceFile,
				kind: "unit",
				label: "窗口1",
				project,
				unitType: "窗口"
			};
			const target: DirectoryNode = {
				directoryPath: targetDirectory,
				kind: "directory",
				label: "new",
				mode: "units",
				project
			};
			await vscode.commands.executeCommand("es4a.openDesigner", source);
			await assert.rejects(
				async () => vscode.commands.executeCommand("es4a.internal.moveUnitToFolder", source, target),
				/请先关闭设计器后再移动/u
			);
			assert.equal(await fileExists(sourceFile), true);
			assert.equal(await fileExists(targetFile), false);
		} finally {
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("单元移动只改变文件路径并可整体撤销重做", async function () {
		this.timeout(60_000);
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		await extension.activate();
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-unit-move-"));
		const sourceRoot = path.join(temporaryDirectory, "src");
		const oldDirectory = path.join(sourceRoot, "old");
		const targetDirectory = path.join(sourceRoot, "new");
		const projectFile = path.join(temporaryDirectory, "project.properties");
		const movedFile = path.join(oldDirectory, "目标.simple");
		const movedTargetFile = path.join(targetDirectory, "目标.simple");
		const callerFile = path.join(oldDirectory, "调用者.simple");
		const movedSource = [
			"事件 目标.初始化()",
			"结束 事件",
			"",
			"$属性",
			"\t$资源 $对象",
			"$结束 $属性",
			""
		].join("\r\n");
		const callerSource = [
			"变量 成_目标 为 old.目标",
			"",
			"$属性",
			"\t$资源 $对象",
			"\t基础对象 = old.目标",
			"$结束 $属性",
			""
		].join("\r\n");
		const projectSource = "main=old.目标\r\nname=移动测试\r\nsource=./src\r\nbuild=./build\r\n";
		try {
			await fs.mkdir(oldDirectory, { recursive: true });
			await fs.mkdir(targetDirectory, { recursive: true });
			await fs.writeFile(projectFile, projectSource, "utf8");
			await fs.writeFile(movedFile, movedSource, "utf8");
			await fs.writeFile(callerFile, callerSource, "utf8");
			await vscode.commands.executeCommand("es4a.internal.addProject", projectFile);
			await new Promise((resolve) => setTimeout(resolve, 500));
			const project = await loadSimpleProject(projectFile);
			const sourceNode: FileNode = {
				filePath: movedFile,
				kind: "unit",
				label: "目标",
				project,
				unitType: "对象"
			};
			const targetNode: DirectoryNode = {
				directoryPath: targetDirectory,
				kind: "directory",
				label: "new",
				mode: "units",
				project
			};
			const document = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(movedFile)));
			await vscode.window.showTextDocument(document, { preview: false });

			await vscode.commands.executeCommand("es4a.internal.moveUnitToFolder", sourceNode, targetNode);
			assert.equal(await fileExists(movedFile), false);
			assert.equal(await fileExists(movedTargetFile), true);
			assert.equal(await fs.readFile(movedTargetFile, "utf8"), movedSource);
			assert.equal(await fs.readFile(callerFile, "utf8"), callerSource);
			assert.equal(await fs.readFile(projectFile, "utf8"), projectSource);
			assert.ok(vscode.workspace.textDocuments.some((candidate) => (
				sameLocalPath(toSimpleSourceUri(candidate.uri)?.fsPath, movedTargetFile)
			)));

			await vscode.commands.executeCommand("undo");
			assert.equal(await fileExists(movedFile), true);
			assert.equal(await fileExists(movedTargetFile), false);
			assert.equal(await fs.readFile(movedFile, "utf8"), movedSource);
			assert.equal(await fs.readFile(callerFile, "utf8"), callerSource);
			assert.equal(await fs.readFile(projectFile, "utf8"), projectSource);

			await vscode.commands.executeCommand("redo");
			assert.equal(await fileExists(movedFile), false);
			assert.equal(await fileExists(movedTargetFile), true);
			assert.equal(await fs.readFile(movedTargetFile, "utf8"), movedSource);
			assert.equal(await fs.readFile(callerFile, "utf8"), callerSource);
			assert.equal(await fs.readFile(projectFile, "utf8"), projectSource);
		} finally {
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			const activeSource = toSimpleSourceUri(
				vscode.window.activeTextEditor?.document.uri ?? vscode.Uri.parse("untitled:")
			);
			if (
				activeSource !== undefined
				&& path.resolve(activeSource.fsPath).startsWith(path.resolve(temporaryDirectory))
			) {
				await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
			}
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("复制单元按目标目录递增数字后缀并同步新单元自身名称", async function () {
		this.timeout(60_000);
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		await extension.activate();
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-unit-copy-"));
		const sourceRoot = path.join(temporaryDirectory, "src");
		const sourceDirectory = path.join(sourceRoot, "simple", "copytest");
		const unrelatedDirectory = path.join(sourceRoot, "simple", "other");
		const projectFile = path.join(temporaryDirectory, "project.properties");
		const sourceFile = path.join(sourceDirectory, "测试窗口1.simple");
		const firstCopy = path.join(sourceDirectory, "测试窗口2.simple");
		const secondCopy = path.join(sourceDirectory, "测试窗口3.simple");
		const unrelatedFile = path.join(unrelatedDirectory, "测试窗口2.simple");
		const sourceText = [
			"事件 测试窗口1.初始化()",
			"\t测试窗口1.标题 = \"测试窗口1\"",
			"结束 事件",
			"",
			"$属性",
			"\t$资源 $窗口",
			"\t$定义 测试窗口1 $为 窗口",
			"\t$结束 $定义",
			"$结束 $属性",
			""
		].join("\r\n");
		try {
			await fs.mkdir(sourceDirectory, { recursive: true });
			await fs.mkdir(unrelatedDirectory, { recursive: true });
			await fs.writeFile(projectFile, "name=复制测试\r\nsource=./src\r\nbuild=./build\r\n", "utf8");
			await fs.writeFile(sourceFile, sourceText, "utf8");
			await fs.writeFile(unrelatedFile, sourceText, "utf8");
			await vscode.commands.executeCommand("es4a.internal.addProject", projectFile);
			const project = await loadSimpleProject(projectFile);
			const source: FileNode = {
				filePath: sourceFile,
				kind: "unit",
				label: "测试窗口1",
				project,
				unitType: "窗口"
			};
			const target: DirectoryNode = {
				directoryPath: sourceDirectory,
				kind: "directory",
				label: "copytest",
				mode: "units",
				project
			};

			await vscode.commands.executeCommand("es4a.internal.copyUnit", source);
			await vscode.commands.executeCommand("es4a.internal.pasteUnit", target);
			await vscode.commands.executeCommand("es4a.internal.pasteUnit", target);

			assert.equal(await fs.readFile(sourceFile, "utf8"), sourceText);
			const firstText = await fs.readFile(firstCopy, "utf8");
			const secondText = await fs.readFile(secondCopy, "utf8");
			assert.match(firstText, /事件 测试窗口2\.初始化\(\)/u);
			assert.match(firstText, /\$定义 测试窗口2 \$为 窗口/u);
			assert.match(secondText, /事件 测试窗口3\.初始化\(\)/u);
			assert.match(secondText, /\$定义 测试窗口3 \$为 窗口/u);

			await vscode.commands.executeCommand("es4a.internal.cutUnit", source);
			await vscode.commands.executeCommand("es4a.internal.pasteUnit", target);
			await assert.rejects(
				async () => vscode.commands.executeCommand("es4a.internal.pasteUnit", target),
				/没有已复制或剪切的单元/u
			);
		} finally {
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("剪切粘贴单元复用移动事务并在成功后清空状态", async function () {
		this.timeout(60_000);
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		await extension.activate();
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-unit-cut-"));
		const sourceRoot = path.join(temporaryDirectory, "src");
		const oldDirectory = path.join(sourceRoot, "old");
		const targetDirectory = path.join(sourceRoot, "new");
		const projectFile = path.join(temporaryDirectory, "project.properties");
		const sourceFile = path.join(oldDirectory, "测试对象.simple");
		const targetFile = path.join(targetDirectory, "测试对象.simple");
		const sourceText = "$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n";
		try {
			await fs.mkdir(oldDirectory, { recursive: true });
			await fs.mkdir(targetDirectory, { recursive: true });
			await fs.writeFile(projectFile, "name=剪切测试\r\nsource=./src\r\nbuild=./build\r\n", "utf8");
			await fs.writeFile(sourceFile, sourceText, "utf8");
			await vscode.commands.executeCommand("es4a.internal.addProject", projectFile);
			const project = await loadSimpleProject(projectFile);
			const source: FileNode = {
				filePath: sourceFile,
				kind: "unit",
				label: "测试对象",
				project,
				unitType: "对象"
			};
			const target: DirectoryNode = {
				directoryPath: targetDirectory,
				kind: "directory",
				label: "new",
				mode: "units",
				project
			};

			await vscode.commands.executeCommand("es4a.internal.cutUnit", source);
			await vscode.commands.executeCommand("es4a.internal.pasteUnit", target);
			assert.equal(await fileExists(sourceFile), false);
			assert.equal(await fs.readFile(targetFile, "utf8"), sourceText);
			await assert.rejects(
				async () => vscode.commands.executeCommand("es4a.internal.pasteUnit", target),
				/没有已复制或剪切的单元/u
			);
		} finally {
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});
	test("项目树只快速识别已知单元类型并保留未知类型单元", async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-damaged-unit-"));
		const sourceDirectory = path.join(temporaryDirectory, "src");
		const projectFile = path.join(temporaryDirectory, "project.properties");
		const unitFile = path.join(sourceDirectory, "Broken.simple");
		const provider = new ProgramTreeProvider();

		try {
			await fs.mkdir(sourceDirectory, { recursive: true });
			await fs.writeFile(projectFile, "name=Damaged\r\nsource=./src\r\n", "utf8");
			await fs.writeFile(
				unitFile,
				[
					"过程 Run()",
					"结束 过程",
					"$属性",
					"  $资源 $未知单元",
					"$结束 $属性",
					""
				].join("\r\n"),
				"utf8"
			);
			assert.equal(await provider.addProject(projectFile), true);
			const project = (await provider.getChildren())[0];
			assert.ok(project?.kind === "project");
			const units = (await provider.getChildren(project)).find((node) => node.kind === "units");
			assert.ok(units);
			const unit = (await provider.getChildren(units))[0];
			assert.ok(unit?.kind === "unit");
			assert.equal(unit.unitType, undefined);
			const item = provider.getTreeItem(unit);
			assert.equal(item.description, undefined);
			assert.ok(item.tooltip instanceof vscode.MarkdownString);
			assert.match(item.tooltip.value, /Broken\.simple/u);
			assert.equal(item.command?.command, "vscode.open");
			await vscode.commands.executeCommand("es4a.previewUnitXml", unit);
			const xmlPreview = vscode.window.activeTextEditor?.document;
			assert.equal(xmlPreview?.uri.scheme, UNIT_XML_PREVIEW_SCHEME);
			assert.match(xmlPreview?.getText() ?? "", /^<属性>/u);
			assert.match(xmlPreview?.getText() ?? "", /<资源 单元="未知单元" \/>/u);
		} finally {
			provider.dispose();
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("ES4A 侧边栏只保留项目和类库视图", () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		const packageJson = extension.packageJSON as {
			activationEvents?: string[];
			version?: string;
			contributes?: {
				commands?: Array<{ command: string; icon?: string; title: string }>;
				configuration?: {
					properties?: Record<string, {
						default?: unknown;
						items?: { required?: string[]; type?: string };
						scope?: string;
						type?: string;
					}>;
				};
				keybindings?: Array<{ command: string; key: string; when?: string }>;
				languages?: Array<{
					icon?: { dark: string; light: string };
					id: string;
				}>;
				customEditors?: Array<{
					displayName: string;
					priority: string;
					selector: Array<{ filenamePattern: string }>;
					viewType: string;
				}>;
				viewsContainers?: {
					activitybar?: Array<{ id: string; title: string }>;
				};
				views?: Record<string, Array<{ icon?: string; id: string; name: string; type?: string }>>;
				menus?: {
					"es4a.editProjectProperties"?: Array<{ command: string; group?: string }>;
					"editor/title"?: Array<{ command: string; group?: string; when?: string }>;
					"editor/title/context"?: Array<{ command: string; group?: string; when?: string }>;
					"view/title"?: Array<{ command: string; group?: string; when?: string }>;
					"view/item/context"?: Array<{
						command?: string;
						group?: string;
						submenu?: string;
						when?: string;
					}>;
				};
				submenus?: Array<{ id: string; label: string }>;
			};
		};
		const views = packageJson.contributes?.views;
		const container = packageJson.contributes?.viewsContainers?.activitybar
			?.find((candidate) => candidate.id === "es4a-programs");

		assert.ok(views, "扩展没有声明侧边栏视图");
		const configurationProperties = packageJson.contributes?.configuration?.properties;
		const projectConfiguration = configurationProperties?.["es4a.projects"] as {
			items?: {
				properties?: {
					settings?: {
						properties?: {
						designer?: {
							properties?: {
								documents?: {
									additionalProperties?: {
										properties?: {
											displayOptions?: { required?: readonly string[] };
										};
									};
									description?: string;
								};
							};
							};
						};
					};
				};
			};
			scope?: string;
			type?: string;
		} | undefined;
		assert.equal(projectConfiguration?.type, "array");
		assert.equal(projectConfiguration?.scope, "window");
		assert.equal(
			projectConfiguration?.items?.properties?.settings?.properties?.designer
				?.properties?.documents?.description,
			"以项目根目录为基准的 Simple 单元设计器设置。"
		);
		assert.equal(
			projectConfiguration?.items?.properties?.settings?.properties?.designer
				?.properties?.documents?.additionalProperties?.properties?.displayOptions?.required,
			undefined,
			"显示开关必须允许只保存用户实际操作的字段"
		);
		assert.equal(configurationProperties?.["es4a.designer.columnOrdersByDocument"], undefined);
		assert.equal(configurationProperties?.["es4a.designer.displayOptionsByDocument"], undefined);
		assert.deepEqual(
			packageJson.activationEvents,
			["onFileSystem:simple-code"],
			"只有虚拟文件系统需要显式激活，语言和设计器由贡献点自动生成"
		);
		assert.equal(container?.title, "ES4A");
		assert.deepEqual(
			views["es4a-programs"]?.map((view) => [view.id, view.name, view.icon]),
			[
				["es4a.programs", "项目", "$(project)"],
				["es4a.libraries", "类库", "$(library)"]
			]
		);
		assert.equal(views["es4a-programs"]?.some((view) => view.id === "es4a.layout"), false);
		assert.equal(views["es4a-programs"]?.some((view) => view.id === "es4a.properties"), false);
		assert.equal(views.explorer?.some((view) => view.id === "es4a.libraries") ?? false, false);
		const commandTitles = new Map(
			packageJson.contributes?.commands?.map((command) => [command.command, command.title])
		);
		assert.equal(commandTitles.get("es4a.createProject"), "创建项目");
		assert.equal(commandTitles.get("es4a.previewUnitContent"), "预览完整代码");
		assert.equal(commandTitles.get("es4a.searchUnitCode"), "搜索代码");
		assert.equal(commandTitles.get("es4a.previewUnitXml"), "预览XML属性");
		assert.equal(commandTitles.get("es4a.setObjectRelation"), "设置实现接口或基础对象");
		assert.equal(commandTitles.get("es4a.setBaseObject"), "设置基础对象");
		assert.equal(commandTitles.get("es4a.setImplementedInterfaces"), "设置实现接口");
		assert.equal(commandTitles.get("es4a.copyUnit"), "复制单元");
		assert.equal(commandTitles.get("es4a.cutUnit"), "剪切单元");
		assert.equal(commandTitles.get("es4a.pasteUnit"), "粘贴单元");
		assert.equal(commandTitles.get("es4a.copyUnitName"), "复制单元名");
		assert.equal(commandTitles.get("es4a.copyUnitFolderQualifiedName"), "复制限定名");
		assert.equal(commandTitles.get("es4a.copyUnitFolderName"), "复制文件夹名");
		assert.equal(commandTitles.get("es4a.copyUnitFolderRelativePath"), "复制相对路径");
		assert.equal(commandTitles.get("es4a.copyUnitFolderAbsolutePath"), "复制绝对路径");
		assert.equal(commandTitles.get("es4a.copyUnitQualifiedName"), "复制限定名");
		assert.equal(commandTitles.get("es4a.copyUnitBaseObjectQualifiedName"), "复制基础对象");
		assert.equal(commandTitles.get("es4a.copyUnitImplementedInterfacesQualifiedName"), "复制实现接口");
		assert.equal(commandTitles.get("es4a.copyUnitRelativePath"), "复制相对路径");
		assert.equal(commandTitles.get("es4a.copyUnitAbsolutePath"), "复制绝对路径");
		assert.equal(commandTitles.get("es4a.openDesigner"), "设计窗口布局");
		assert.equal(commandTitles.get("es4a.renameUnitFile"), "重命名单元");
		assert.equal(commandTitles.get("es4a.syncUnitFileName"), "同步单元名");
		assert.equal(commandTitles.get("es4a.deleteUnitFile"), "删除单元");
		assert.equal(commandTitles.get("es4a.renameUnitFolder"), "重命名文件夹");
		assert.equal(commandTitles.get("es4a.renameResourceFile"), "重命名文件");
		assert.equal(commandTitles.get("es4a.deleteResourceFile"), "删除文件");
		assert.equal(commandTitles.get("es4a.copyResourceIndex"), "复制索引名");
		assert.equal(commandTitles.get("es4a.copyResourceFileName"), "复制文件名");
		assert.equal(commandTitles.get("es4a.copyResourceFolderName"), "复制文件夹名");
		assert.equal(commandTitles.get("es4a.copyResourceRelativePath"), "复制相对路径");
		assert.equal(commandTitles.get("es4a.copyResourceAbsolutePath"), "复制绝对路径");
		assert.equal(commandTitles.get("es4a.compileApplication"), "编译应用");
		assert.equal(commandTitles.get("es4a.editProjectName"), "应用名称");
		assert.equal(commandTitles.get("es4a.editProjectVersionCode"), "版本号");
		assert.equal(commandTitles.get("es4a.editProjectVersionName"), "版本名");
		assert.equal(commandTitles.get("es4a.editProjectIcon"), "应用图标");
		assert.equal(commandTitles.get("es4a.editProjectOrientation"), "屏幕方向");
		assert.equal(commandTitles.get("es4a.editProjectTheme"), "应用主题");
		assert.equal(commandTitles.get("es4a.editProjectManifestMacro"), "清单宏...");
		assert.equal(commandTitles.has("es4a.buildApplication"), false);
		assert.equal(commandTitles.get("es4a.debugApplication"), "调试应用");
		assert.equal(commandTitles.get("es4a.createUnitItem"), "创建...");
		assert.equal(commandTitles.get("es4a.importResource"), "导入资源");
		assert.equal(commandTitles.get("es4a.exportResource"), "导出资源");
		assert.equal(commandTitles.get("es4a.exportBuildFile"), "导出文件");
		assert.equal(commandTitles.get("es4a.createResourceFolder"), "新建文件夹");
		assert.equal(
			packageJson.contributes?.commands?.find((command) => command.command === "es4a.debugApplication")?.icon,
			"$(debug-alt-small)"
		);
		assert.equal(
			packageJson.contributes?.commands?.find((command) => command.command === "es4a.createUnitItem")?.icon,
			"$(add)"
		);
		assert.equal(
			packageJson.contributes?.commands?.find((command) => command.command === "es4a.createProject")?.icon,
			"$(new-folder)"
		);
		assert.equal(
			packageJson.contributes?.commands?.find((command) => command.command === "es4a.openDesigner")?.icon,
			"$(layout)"
		);
		assert.equal(
			packageJson.contributes?.commands?.find((command) => command.command === "es4a.importResource")?.icon,
			"$(add)"
		);
		assert.equal(
			packageJson.contributes?.commands?.find((command) => command.command === "es4a.createResourceFolder")?.icon,
			"$(add)"
		);
		assert.equal(
			packageJson.contributes?.commands?.find((command) => command.command === "es4a.setBaseObject")?.icon,
			"$(git-pull-request-go-to-changes)"
		);
		assert.equal(commandTitles.get("es4a.openProjectProperties"), "打开属性");
		assert.equal(commandTitles.get("es4a.locateProjectProperties"), "定位属性");
		assert.equal(commandTitles.has("es4a.locateProject"), false);
		assert.equal(commandTitles.get("es4a.openProjectDirectory"), "打开目录");
		assert.equal(commandTitles.get("es4a.locateFolder"), "定位文件夹");
		assert.equal(commandTitles.get("es4a.openUnitLoadEvent"), "载入事件");
		assert.equal(commandTitles.get("es4a.openUnitInitializeEvent"), "初始化事件");
		assert.equal(commandTitles.get("es4a.locateUnitFile"), "定位单元");
		assert.equal(commandTitles.get("es4a.locateResourceFile"), "定位文件");
		assert.equal(commandTitles.get("es4a.locateBuildFile"), "定位文件");
		assert.equal(commandTitles.get("es4a.deleteBuildFile"), "删除文件");
		assert.equal(commandTitles.get("es4a.runSdkTool"), "SDK工具...");
		assert.equal(commandTitles.get("es4a.openLibraryManifest"), "打开清单");
		assert.equal(commandTitles.get("es4a.locateLibraryManifest"), "定位清单");
		assert.equal(commandTitles.has("es4a.refreshProperties"), false);
		const simpleLanguageIcon = packageJson.contributes?.languages
			?.find((language) => language.id === "simple")?.icon;
		const propertyXmlLanguageIcon = packageJson.contributes?.languages
			?.find((language) => language.id === "simple-property-xml")?.icon;
		assert.deepEqual(simpleLanguageIcon, {
			dark: "./icons/simple-dark.svg",
			light: "./icons/simple-light.svg"
		});
		assert.deepEqual(propertyXmlLanguageIcon, {
			dark: "./icons/property-xml-dark.svg",
			light: "./icons/property-xml-light.svg"
		});
		assert.deepEqual(packageJson.contributes?.customEditors, [{
			displayName: "ES4A 窗口设计器",
			priority: "option",
			selector: [
				{ filenamePattern: "*(设计器)" },
				{ filenamePattern: "*(代码)" }
			],
			viewType: "es4a.simpleDesigner"
		}]);
		assert.deepEqual(packageJson.contributes?.keybindings, [
			{
				command: "es4a.copyUnit",
				key: "ctrl+c",
				when: "focusedView == es4a.programs"
			},
			{
				command: "es4a.pasteUnit",
				key: "ctrl+v",
				when: "focusedView == es4a.programs && es4a.unitClipboardAvailable"
			},
			{
				command: "es4a.debugApplication",
				key: "f5",
				when: "es4a.sdk.hasDebugCapability && (editorLangId == simple || resourceScheme == es4a-unit-content-preview || resourceScheme == es4a-unit-xml-preview || activeCustomEditorId == es4a.simpleDesigner)"
			}
		]);
		assert.deepEqual(packageJson.contributes?.menus?.["editor/title"], [{
			command: "es4a.openDesigner",
			group: "navigation@10",
			when: "editorLangId == simple && resourceScheme == simple-code && es4a.activeEditorIsWindowUnit"
		}]);
		assert.equal(packageJson.contributes?.menus?.["editor/title/context"], undefined);
		const programActions = packageJson.contributes?.menus?.["view/title"]
			?.filter((item) => item.when === "view == es4a.programs")
			.map((item) => [item.command, item.group]);
		assert.deepEqual(programActions, [
			["es4a.createProject", "navigation@1"],
			["es4a.addProject", "navigation@2"],
			["es4a.refreshPrograms", "navigation@3"]
		]);
		const libraryActions = packageJson.contributes?.menus?.["view/title"]
			?.filter((item) => item.when === "view == es4a.libraries")
			.map((item) => [item.command, item.group]);
		assert.deepEqual(libraryActions, [
			["es4a.selectSdk", "navigation@1"],
			["es4a.refreshLibraries", "navigation@2"]
		]);
		const sdkToolActions = packageJson.contributes?.menus?.["view/title"]
			?.filter((item) => item.when?.startsWith("view == es4a.libraries &&"))
			.map((item) => [item.command, item.group, item.when]);
		assert.deepEqual(sdkToolActions, [
			[
				"es4a.runSdkTool",
				"1_tools@1",
				"view == es4a.libraries && es4a.sdk.hasTools"
			]
		]);
		assert.equal(
			packageJson.contributes?.menus?.["view/title"]
				?.some((item) => item.when === "view == es4a.properties"),
			false
		);
		assert.deepEqual(packageJson.contributes?.submenus, [{
			id: "es4a.editProjectProperties",
			label: "编辑属性"
		}]);
		assert.deepEqual(
			packageJson.contributes?.menus?.["es4a.editProjectProperties"]?.map((item) => [item.command, item.group]),
			[
				["es4a.editProjectName", "1_property@1"],
				["es4a.editProjectVersionCode", "1_property@2"],
				["es4a.editProjectVersionName", "1_property@3"],
				["es4a.editProjectIcon", "1_property@4"],
				["es4a.editProjectOrientation", "1_property@5"],
				["es4a.editProjectTheme", "1_property@6"],
				["es4a.editProjectManifestMacro", "1_property@7"]
			]
		);
		const unitContextActions = packageJson.contributes?.menus?.["view/item/context"];
		assert.deepEqual(
			unitContextActions?.map((item) => [item.submenu ?? item.command, item.group, item.when]),
			[
				[
					"es4a.debugApplication",
					"inline@1",
					"view == es4a.programs && viewItem == es4a.project && es4a.sdk.hasDebugCapability"
				],
				[
					"es4a.debugApplication",
					"1_capability@1",
					"view == es4a.programs && viewItem == es4a.project && es4a.sdk.hasDebugCapability"
				],
				[
					"es4a.compileApplication",
					"1_capability@2",
					"view == es4a.programs && viewItem == es4a.project && es4a.sdk.hasCompileCapability"
				],
				[
					"es4a.editProjectProperties",
					"2_properties@1",
					"view == es4a.programs && viewItem == es4a.project"
				],
				["es4a.openProjectProperties", "2_properties@2", "view == es4a.programs && viewItem == es4a.project"],
				["es4a.locateProjectProperties", "2_properties@3", "view == es4a.programs && viewItem == es4a.project"],
				[
					"es4a.removeProject",
					"3_project@3",
					"view == es4a.programs && (viewItem == es4a.project || viewItem == es4a.unavailableProject)"
				],
				["es4a.deleteProject", "3_project@4", "view == es4a.programs && viewItem == es4a.project"],
				["es4a.refreshPrograms", "3_project@2", "view == es4a.programs && viewItem == es4a.project"],
				["es4a.importResource", "inline@1", "view == es4a.programs && viewItem == es4a.assets"],
				["es4a.importResource", "1_create@1", "view == es4a.programs && viewItem == es4a.assets"],
				["es4a.createResourceFolder", "1_create@2", "view == es4a.programs && viewItem == es4a.assets"],
				["es4a.locateFolder", "1_create@3", "view == es4a.programs && viewItem == es4a.assets"],
				["es4a.createResourceFolder", "inline@1", "view == es4a.programs && viewItem == es4a.res"],
				["es4a.createResourceFolder", "1_create@1", "view == es4a.programs && viewItem == es4a.res"],
				["es4a.locateFolder", "1_create@2", "view == es4a.programs && viewItem == es4a.res"],
				["es4a.importResource", "inline@1", "view == es4a.programs && viewItem == es4a.resFolder"],
				["es4a.importResource", "1_create@1", "view == es4a.programs && viewItem == es4a.resFolder"],
				["es4a.importResource", "inline@1", "view == es4a.programs && viewItem == es4a.assetsFolder"],
				["es4a.importResource", "1_create@1", "view == es4a.programs && viewItem == es4a.assetsFolder"],
				["es4a.createResourceFolder", "1_create@2", "view == es4a.programs && viewItem == es4a.assetsFolder"],
				["es4a.createUnitFolder", "inline@1", "view == es4a.programs && viewItem == es4a.units"],
				[
					"es4a.createUnitItem",
					"inline@1",
					"view == es4a.programs && viewItem == es4a.unitFolder"
				],
				[
					"es4a.createWindowUnit",
					"1_create@1",
					"view == es4a.programs && (viewItem == es4a.units || viewItem == es4a.unitFolder)"
				],
				[
					"es4a.createObjectUnit",
					"1_create@2",
					"view == es4a.programs && (viewItem == es4a.units || viewItem == es4a.unitFolder)"
				],
				[
					"es4a.createInterfaceUnit",
					"1_create@3",
					"view == es4a.programs && (viewItem == es4a.units || viewItem == es4a.unitFolder)"
				],
				[
					"es4a.createServiceUnit",
					"1_create@4",
					"view == es4a.programs && (viewItem == es4a.units || viewItem == es4a.unitFolder)"
				],
				["es4a.pasteUnit", "2_folder@2", "view == es4a.programs && es4a.unitClipboardAvailable && (viewItem == es4a.units || viewItem == es4a.unitFolder)"],
				[
					"es4a.searchUnitCode",
					"2_folder@1",
					"view == es4a.programs && (viewItem == es4a.units || viewItem == es4a.unitFolder)"
				],
				[
					"es4a.locateFolder",
					"2_folder@3",
					"view == es4a.programs && (viewItem == es4a.units || viewItem == es4a.unitFolder || viewItem == es4a.assetsFolder || viewItem == es4a.resFolder)"
				],
				[
					"es4a.locateFolder",
					"2_folder@3",
					"view == es4a.programs && (viewItem == es4a.build || viewItem == es4a.buildFolder)"
				],
				[
					"es4a.createUnitFolder",
					"1_create@5",
					"view == es4a.programs && (viewItem == es4a.units || viewItem == es4a.unitFolder)"
				],
				["es4a.renameUnitFolder", "2_folder@4", "view == es4a.programs && (viewItem == es4a.unitFolder || viewItem == es4a.assetsFolder || viewItem == es4a.resFolder)"],
			["es4a.deleteUnitFolder", "2_folder@5", "view == es4a.programs && (viewItem == es4a.unitFolder || viewItem == es4a.assetsFolder || viewItem == es4a.resFolder || viewItem == es4a.buildFolder)"],
				["es4a.copyUnitFolderQualifiedName", "3_copy@1", "view == es4a.programs && viewItem == es4a.unitFolder"],
				["es4a.copyUnitFolderName", "3_copy@2", "view == es4a.programs && viewItem == es4a.unitFolder"],
				["es4a.copyUnitFolderRelativePath", "3_copy@3", "view == es4a.programs && viewItem == es4a.unitFolder"],
				["es4a.copyUnitFolderAbsolutePath", "3_copy@4", "view == es4a.programs && viewItem == es4a.unitFolder"],
				["es4a.setBaseObject", "inline@1", "view == es4a.programs && viewItem =~ /^es4a\\.objectUnit\\./"],
				["es4a.setBaseObject", "0_relation@1", "view == es4a.programs && viewItem =~ /^es4a\\.objectUnit\\./"],
				["es4a.setImplementedInterfaces", "0_relation@2", "view == es4a.programs && viewItem =~ /^es4a\\.objectUnit\\./"],
				["es4a.openDesigner", "inline@1", "view == es4a.programs && viewItem == es4a.windowUnit"],
				["es4a.openDesigner", "1_open@1", "view == es4a.programs && viewItem == es4a.windowUnit"],
				["es4a.previewUnitXml", "1_open@2", "view == es4a.programs && (viewItem == es4a.unit || viewItem =~ /^es4a\\.objectUnit\\./ || viewItem == es4a.windowUnit)"],
				["es4a.previewUnitContent", "1_open@3", "view == es4a.programs && (viewItem == es4a.unit || viewItem =~ /^es4a\\.objectUnit\\./ || viewItem == es4a.windowUnit)"],
				[
					"es4a.locateResourceFile",
					"2_file@1",
					"view == es4a.programs && viewItem =~ /^es4a\\.resFile/"
				],
				[
					"es4a.locateResourceFile",
					"2_file@1",
					"view == es4a.programs && viewItem == es4a.assetsFile"
				],
				[
					"es4a.locateBuildFile",
					"2_file@1",
					"view == es4a.programs && viewItem == es4a.buildFile"
				],
				[
					"es4a.openUnitLoadEvent",
					"2_event@1",
					"view == es4a.programs && (viewItem == es4a.windowUnit || viewItem =~ /^es4a\\.objectUnit\\./)"
				],
				[
					"es4a.openUnitInitializeEvent",
					"2_event@2",
					"view == es4a.programs && (viewItem == es4a.windowUnit || viewItem =~ /^es4a\\.objectUnit\\./)"
				],
				[
					"es4a.locateUnitFile",
					"2_unit@1",
					"view == es4a.programs && (viewItem == es4a.unit || viewItem =~ /^es4a\\.objectUnit\\./ || viewItem == es4a.windowUnit)"
				],
				[
					"es4a.exportResource",
					"1_transfer@1",
					"view == es4a.programs && (viewItem == es4a.assetsFile || viewItem =~ /^es4a\\.resFile/)"
				],
				[
					"es4a.exportBuildFile",
					"1_transfer@1",
					"view == es4a.programs && viewItem == es4a.buildFile"
				],
				["es4a.renameUnitFile", "2_unit@5", "view == es4a.programs && (viewItem == es4a.unit || viewItem =~ /^es4a\\.objectUnit\\./ || viewItem == es4a.windowUnit)"],
				["es4a.syncUnitFileName", "2_unit@6", "view == es4a.programs && viewItem == es4a.windowUnit"],
				["es4a.deleteUnitFile", "2_unit@7", "view == es4a.programs && (viewItem == es4a.unit || viewItem =~ /^es4a\\.objectUnit\\./ || viewItem == es4a.windowUnit)"],
				["es4a.copyUnit", "2_unit@3", "view == es4a.programs && (viewItem == es4a.unit || viewItem =~ /^es4a\\.objectUnit\\./ || viewItem == es4a.windowUnit)"],
				["es4a.cutUnit", "2_unit@2", "view == es4a.programs && (viewItem == es4a.unit || viewItem =~ /^es4a\\.objectUnit\\./ || viewItem == es4a.windowUnit)"],
				["es4a.pasteUnit", "2_unit@4", "view == es4a.programs && es4a.unitClipboardAvailable && (viewItem == es4a.unit || viewItem =~ /^es4a\\.objectUnit\\./ || viewItem == es4a.windowUnit)"],
				["es4a.renameResourceFile", "2_file@2", "view == es4a.programs && (viewItem == es4a.assetsFile || viewItem =~ /^es4a\\.resFile/)"],
				["es4a.deleteResourceFile", "2_file@3", "view == es4a.programs && (viewItem == es4a.assetsFile || viewItem =~ /^es4a\\.resFile/)"],
				["es4a.deleteBuildFile", "2_file@2", "view == es4a.programs && viewItem == es4a.buildFile"],
				["es4a.copyResourceIndex", "3_copy@1", "view == es4a.programs && viewItem == es4a.resFile.indexed"],
				["es4a.copyResourceFileName", "3_copy@2", "view == es4a.programs && (viewItem == es4a.assetsFile || viewItem =~ /^es4a\\.resFile/)"],
				["es4a.copyResourceFolderName", "3_copy@1", "view == es4a.programs && (viewItem == es4a.assetsFolder || viewItem == es4a.resFolder)"],
				["es4a.copyResourceRelativePath", "3_copy@3", "view == es4a.programs && (viewItem == es4a.assetsFile || viewItem == es4a.assetsFolder || viewItem == es4a.resFolder || viewItem =~ /^es4a\\.resFile/)"],
				["es4a.copyResourceAbsolutePath", "3_copy@4", "view == es4a.programs && (viewItem == es4a.assetsFile || viewItem == es4a.assetsFolder || viewItem == es4a.resFolder || viewItem =~ /^es4a\\.resFile/)"],
				["es4a.copyUnitName", "3_copy@1", "view == es4a.programs && (viewItem == es4a.unit || viewItem =~ /^es4a\\.objectUnit\\./ || viewItem == es4a.windowUnit)"],
				["es4a.copyUnitQualifiedName", "3_copy@2", "view == es4a.programs && (viewItem == es4a.unit || viewItem =~ /^es4a\\.objectUnit\\./ || viewItem == es4a.windowUnit)"],
				["es4a.copyUnitBaseObjectQualifiedName", "3_copy@3", "view == es4a.programs && (viewItem == es4a.objectUnit.baseObject || viewItem == es4a.objectUnit.baseObjectAndInterfaces)"],
				["es4a.copyUnitImplementedInterfacesQualifiedName", "3_copy@4", "view == es4a.programs && (viewItem == es4a.objectUnit.interfaces || viewItem == es4a.objectUnit.baseObjectAndInterfaces)"],
				["es4a.copyUnitRelativePath", "3_copy@5", "view == es4a.programs && (viewItem == es4a.unit || viewItem =~ /^es4a\\.objectUnit\\./ || viewItem == es4a.windowUnit)"],
				["es4a.copyUnitAbsolutePath", "3_copy@6", "view == es4a.programs && (viewItem == es4a.unit || viewItem =~ /^es4a\\.objectUnit\\./ || viewItem == es4a.windowUnit)"],
				["es4a.openLibraryManifest", "1_manifest@1", "view == es4a.libraries && viewItem == es4a.libraryManifest"],
				["es4a.locateLibraryManifest", "1_manifest@2", "view == es4a.libraries && viewItem == es4a.libraryManifest"]
			]
		);
	});

	test("语言配置文件没有错误或警告", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");

		const configurationUri = vscode.Uri.file(
			path.join(extension.extensionPath, "language-configuration.json")
		);
		await vscode.workspace.openTextDocument(configurationUri);
		await new Promise((resolve) => setTimeout(resolve, 500));

		const diagnostics = vscode.languages.getDiagnostics(configurationUri)
			.filter((diagnostic) => diagnostic.severity <= vscode.DiagnosticSeverity.Warning);

		assert.deepEqual(
			diagnostics.map((diagnostic) => diagnostic.message),
			[]
		);
	});

	test("从真实 SimpleCompiler.json 动态生成语义着色", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		const sdk = await loadSdk(path.resolve(extension.extensionPath, "..", "sdk", "sdk.json"));
		let analysisCount = 0;
		const provider = new SimpleSemanticTokensProvider((document) => {
			analysisCount += 1;
			return document.getText();
		});
		const cancellation = new vscode.CancellationTokenSource();

		try {
			provider.updateSdk(sdk);
			const document = await vscode.workspace.openTextDocument({
				content: "如果 真 >= 整数型\r\n' 如果\r\n\"如果\"",
				language: "simple"
			});
			const tokens = provider.provideDocumentSemanticTokens(document, cancellation.token);
			const cachedTokens = provider.provideDocumentSemanticTokens(document, cancellation.token);

			assert.equal(tokens.data.length / 5, 4);
			assert.equal(cachedTokens, tokens);
			assert.equal(analysisCount, 1);
			provider.refresh();
			provider.provideDocumentSemanticTokens(document, cancellation.token);
			assert.equal(analysisCount, 2);
		} finally {
			cancellation.dispose();
			provider.dispose();
		}
	});

	test("项目 res 资源通过 VS Code Provider 提供 R 补全、着色、悬停和定义", async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-resource-provider-"));
		const sourceDirectory = path.join(temporaryDirectory, "src", "sample");
		const resourceDirectory = path.join(temporaryDirectory, "res", "drawable");
		const sourceFile = path.join(sourceDirectory, "Main.simple");
		const source = "事件 Main.初始化()\r\n\t图标 = R.drawable_icon\r\n结束 事件\r\n";
		const index = new ProjectSymbolIndex();
		const cancellation = new vscode.CancellationTokenSource();

		try {
			await Promise.all([
				fs.mkdir(sourceDirectory, { recursive: true }),
				fs.mkdir(resourceDirectory, { recursive: true }),
				fs.mkdir(path.join(temporaryDirectory, "build"), { recursive: true })
			]);
			await Promise.all([
				fs.writeFile(path.join(temporaryDirectory, "project.properties"), [
					"main=sample.Main",
					"name=资源索引集成测试",
					"assets=./assets",
					"res=./res",
					"source=./src",
					"build=./build",
					""
				].join("\r\n"), "utf8"),
				fs.writeFile(sourceFile, source, "utf8"),
				fs.writeFile(path.join(resourceDirectory, "icon.png"), new Uint8Array()),
				fs.writeFile(
					path.join(temporaryDirectory, "build", "R.txt"),
					"int drawable generated_only 0x7f010000\r\n",
					"utf8"
				)
			]);

			const project = await loadSimpleProject(path.join(temporaryDirectory, "project.properties"));
			await index.updateProjects([project]);
			const context = index.contextForFile(sourceFile, source);
			assert.ok(context);
			const document = await vscode.workspace.openTextDocument({ content: source, language: "simple" });
			const hoverProvider = new SimpleHoverProvider(() => source, () => context);
			const semanticProvider = new SimpleSemanticTokensProvider(() => source, () => context);
			const definitionProvider = new SimpleDefinitionProvider(() => source, () => context);
			const memberOffset = source.indexOf("drawable_icon") + 1;
			const hover = hoverProvider.provideHover(document, document.positionAt(memberOffset));
			const hoverMarkdown = hover?.contents.map(
				(content) => typeof content === "string" ? content : content.value
			).join("\n") ?? "";
			const hoverText = visibleHoverMarkdown(hoverMarkdown);

			assert.match(hoverText, /常量 R\.drawable_icon 为 整数型/u);
			assert.match(hoverText, /res\/drawable\/icon\.png/u);
			assert.match(hoverMarkdown, /来源文件：res\/drawable\/icon\.png  \n所属项目：资源索引集成测试/u);
			assert.doesNotMatch(hoverText, /0x|&H|7f010000/iu);
			assert.equal(context.resources?.symbols.some(
				(symbol) => symbol.name === "generated_only"
			), false);
			const definitionTarget = definitionProvider.targetAt(
				document,
				document.positionAt(memberOffset)
			);
			assert.equal(definitionTarget?.resourceSource, true);
			const definitionLocation = definitionTarget === undefined
				? undefined
				: await definitionProvider.locationForTarget(definitionTarget);
			assert.equal(
				definitionLocation?.uri.fsPath.toLowerCase(),
				path.join(resourceDirectory, "icon.png").toLowerCase()
			);
			const completionSource = source.replace("drawable_icon", "drawable_");
			const completionDocument = await vscode.workspace.openTextDocument({
				content: completionSource,
				language: "simple"
			});
			const completionProvider = new SimpleCompletionProvider(
				() => completionSource,
				() => context
			);
			const completions = completionProvider.provideCompletionItems(
				completionDocument,
				completionDocument.positionAt(completionSource.indexOf("drawable_") + "drawable_".length)
			);
			assert.deepEqual(completions.items.map((item) => (
				typeof item.label === "string" ? item.label : item.label.label
			)), ["drawable_icon"]);
			assert.equal(completions.items[0]?.kind, vscode.CompletionItemKind.Constant);

			const tokens = semanticProvider.provideDocumentSemanticTokens(document, cancellation.token);
			const tokenTypes: string[] = [];
			for (let index = 3; index < tokens.data.length; index += 5) {
				const tokenType = SIMPLE_SEMANTIC_TOKEN_TYPES[tokens.data[index] ?? -1];
				if (tokenType !== undefined) {
					tokenTypes.push(tokenType);
				}
			}
			assert.ok(tokenTypes.includes("type"));
			assert.ok(tokenTypes.includes("variable"));
			semanticProvider.dispose();
		} finally {
			cancellation.dispose();
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	test("编译器清单将流程控制、声明、修饰符和语法定义分开", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		const sdk = await loadSdk(path.resolve(extension.extensionPath, "..", "sdk", "sdk.json"));
		const compiler = sdk.manifests.find((manifest) => manifest.kind === "compiler");
		assert.ok(compiler, "没有找到编译器清单");
		const propertyArea = compiler.categories.find((category) => category.name === "属性区");
		const controls = compiler.categories.find((category) => category.name === "流程控制");
		const declarations = compiler.categories.find((category) => category.name === "声明");
		const types = compiler.categories.find((category) => category.name === "数据类型");
		const modifiers = compiler.categories.find((category) => category.name === "修饰符");
		const syntax = compiler.categories.find((category) => category.name === "语法");

		assert.ok(propertyArea, "没有找到属性区分类");
		const objectUnit = propertyArea.definitions.find((definition) => definition.name === "$对象");
		assert.equal(objectUnit === undefined ? true : "hidden" in objectUnit, false);
		assert.deepEqual(objectUnit?.properties?.map((property) => property.name), ["基础对象", "实现接口"]);
		assert.ok(controls, "没有找到流程控制分类");
		assert.ok(declarations, "没有找到声明分类");
		assert.ok(types, "没有找到数据类型分类");
		assert.ok(modifiers, "没有找到修饰符分类");
		assert.ok(syntax, "没有找到语法分类");
		assert.ok(controls.definitions.length > 0, "流程控制分类不能为空");
		assert.equal(controls.definitions.every((definition) => definition.kind === "control"), true);
		assert.equal(declarations.definitions.some((definition) => definition.kind === "control"), false);
		assert.equal(declarations.definitions.some((definition) => definition.name === "对象"), false);
		assert.equal(types.definitions.find((definition) => definition.name === "对象")?.kind, "type");
		assert.equal(modifiers.definitions.some((definition) => definition.kind === "control"), false);
		assert.equal(controls.definitions.find((definition) => definition.name === "位于")?.kind, "control");

		const provider = new LibraryTreeProvider(async () => sdk);
		await provider.refresh();
		const compilerNode = provider.getChildren().find(
			(node) => node.kind === "manifest" && node.manifest === compiler
		);
		assert.ok(compilerNode?.kind === "manifest");
		assert.equal(propertyArea.hidden, true);
		assert.equal(provider.getChildren(compilerNode).some(
			(node) => node.kind === "category" && node.category === propertyArea
		), false);
	});

	test("从真实运行库解析组件类型和继承成员着色", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		const sdk = await loadSdk(path.resolve(extension.extensionPath, "..", "sdk", "sdk.json"));
		const provider = new SimpleSemanticTokensProvider();
		const cancellation = new vscode.CancellationTokenSource();

		try {
			provider.updateSdk(sdk);
			const document = await vscode.workspace.openTextDocument({
				content: "变量 timer 为 计时器\r\ntimer.间隔 = 400",
				language: "simple"
			});
			const tokens = provider.provideDocumentSemanticTokens(document, cancellation.token);
			const types: string[] = [];

			for (let index = 3; index < tokens.data.length; index += 5) {
				const type = SIMPLE_SEMANTIC_TOKEN_TYPES[tokens.data[index] ?? -1];

				if (type !== undefined) {
					types.push(type);
				}
			}

			assert.deepEqual(
				types,
				["simpleDeclaration", "variable", "operator", "type", "variable", "property", "operator"]
			);
		} finally {
			cancellation.dispose();
			provider.dispose();
		}
	});

	test("未加载 SDK 时类库树提示项可选择 SDK 入口文件", async () => {
		const provider = new LibraryTreeProvider(async () => undefined);
		try {
			await provider.refresh();
			const nodes = provider.getChildren();
			assert.equal(nodes.length, 1);
			assert.equal(nodes[0]?.kind, "missing");
			const item = provider.getTreeItem(nodes[0]!);
			assert.equal(item.label, "选择 SDK 入口文件 sdk.json");
			assert.deepEqual(item.command, { command: "es4a.selectSdk", title: "选择 SDK 入口文件" });
		} finally {
			provider.dispose();
		}
	});

	test("类库树按需加载并解析运行库方法的完整父级路径", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		const sdk = await loadSdk(path.resolve(extension.extensionPath, "..", "sdk", "sdk.json"));
		const runtime = sdk.manifests.find((manifest) => manifest.kind === "runtime");
		assert.ok(runtime, "没有找到运行库清单");
		const definition = runtime.categories
			.flatMap((category) => category.definitions)
			.find((candidate) => candidate.name === "数组操作");
		assert.ok(definition, "没有找到数组定义");
		const member = definition.functions?.find((candidate) => candidate.name === "分割文本");
		assert.ok(member, "没有找到分割文本方法");
		const provider = new LibraryTreeProvider(async () => sdk);

		try {
			const node = await provider.findSymbol(
				libraryMemberTarget({ definition, manifest: runtime }, "functions", member)
			);
			assert.ok(node?.kind === "member", "无法定位运行库方法节点");
			const group = provider.getParent(node);
			assert.ok(group?.kind === "group");
			const owner = provider.getParent(group);
			assert.ok(owner?.kind === "definition");
		assert.equal(owner.reference.definition.name, "数组操作");
			const category = provider.getParent(owner);
			assert.ok(category?.kind === "category");
			assert.equal(provider.getParent(category)?.kind, "manifest");
		} finally {
			provider.dispose();
		}
	});

	test("类库树成员悬停显示多行说明和参数说明", async () => {
		const definition = {
			constants: [{
				description: "常量第一行。\n常量第二行。",
				name: "测试常量",
				type: "整数型",
				value: "1"
			}],
			functions: [{
				description: "**函数第一行。**\n- 函数第二行。",
				name: "测试函数",
				params: [{
					description: "参数第一行。\n参数第二行。",
					name: "value",
					type: "文本型"
				}],
				return: "逻辑型"
			}],
			kind: "object" as const,
			name: "测试对象",
			properties: [{
				description: "属性第一行。\n属性第二行。",
				name: "测试属性",
				type: "文本型"
			}],
			variables: [{
				description: "变量第一行。\n变量第二行。",
				name: "测试变量",
				type: "文本型"
			}]
		};
		const manifest: LibraryManifest = {
			categories: [{ definitions: [definition], name: "测试分类" }],
			directory: os.tmpdir(),
			filePath: path.join(os.tmpdir(), "runtime.json"),
			kind: "runtime",
			name: "测试运行库"
		};
		const provider = new LibraryTreeProvider(async () => ({
			capabilities: { projects: [], tools: [] },

			templates: {},
			directory: os.tmpdir(),
			filePath: path.join(os.tmpdir(), "sdk.json"),
			issues: [],
			manifests: [manifest]
		}));

		try {
			await provider.refresh();
			const runtime = provider.getChildren().find((node) => node.kind === "manifest");
			assert.ok(runtime?.kind === "manifest");
			const category = provider.getChildren(runtime).find((node) => node.kind === "category");
			assert.ok(category?.kind === "category");
			const owner = provider.getChildren(category).find((node) => node.kind === "definition");
			assert.ok(owner?.kind === "definition");
			const ownerTooltip = provider.getTreeItem(owner).tooltip;
			assert.ok(ownerTooltip instanceof vscode.MarkdownString);
			assert.match(ownerTooltip.value, /^\*\*测试对象\*\*  \n类别：对象$/u);

			const tooltipFor = (groupName: "constants" | "functions" | "properties" | "variables") => {
				const group = provider.getChildren(owner).find(
					(node) => node.kind === "group" && node.group === groupName
				);
				assert.ok(group?.kind === "group");
				const member = provider.getChildren(group).find((node) => node.kind === "member");
				assert.ok(member?.kind === "member");
				const tooltip = provider.getTreeItem(member).tooltip;
				assert.ok(tooltip instanceof vscode.MarkdownString);
				return tooltip.value;
			};

			assert.match(
				tooltipFor("functions"),
				/^\*\*测试函数\(value 为 文本型\) 为 逻辑型\*\*  \n\*value：\*&#8203;参数第一行。  \n参数第二行。\n\n\*\*函数第一行。\*\*  \n- 函数第二行。$/u
			);
			assert.match(tooltipFor("constants"), /^\*\*测试常量 为 整数型 = 1\*\*  \n常量第一行。  \n常量第二行。$/u);
			assert.match(tooltipFor("properties"), /^\*\*测试属性 为 文本型\*\*  \n属性第一行。  \n属性第二行。$/u);
			assert.match(tooltipFor("variables"), /^\*\*测试变量 为 文本型\*\*  \n变量第一行。  \n变量第二行。$/u);
		} finally {
			provider.dispose();
		}
	});

	test("项目树 Assets 文件和 Res 文件夹、文件复制名称及真实路径", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		await extension.activate();
		const projectFile = testProjectPath("SmokeTests", "project.properties");
		const projectDirectory = path.dirname(projectFile);
		const provider = new ProgramTreeProvider();
		const previousClipboard = await vscode.env.clipboard.readText();
		try {
			assert.equal(await provider.addProject(projectFile), true);
			const project = (await provider.getChildren())[0];
			assert.ok(project?.kind === "project");
			const resources = (await provider.getChildren(project)).find(
				(node) => node.kind === "resources"
			);
			assert.ok(resources);
			const resourceRoots = await provider.getChildren(resources);
			const assets = resourceRoots.find((node) => node.kind === "assets");
			const res = resourceRoots.find((node) => node.kind === "res");
			assert.ok(assets?.kind === "assets");
			assert.ok(res?.kind === "res");

			const assetFile = (await provider.getChildren(assets)).find(
				(node) => node.kind === "file" && node.label === "simple.png"
			);
			assert.ok(assetFile?.kind === "file");
			await vscode.commands.executeCommand("es4a.copyResourceFileName", assetFile);
			assert.equal(await vscode.env.clipboard.readText(), "simple.png");
			await vscode.commands.executeCommand("es4a.copyResourceRelativePath", assetFile);
			assert.equal(await vscode.env.clipboard.readText(), path.join("assets", "simple.png"));
			await vscode.commands.executeCommand("es4a.copyResourceAbsolutePath", assetFile);
			assert.equal(await vscode.env.clipboard.readText(), path.join(projectDirectory, "assets", "simple.png"));
			assert.ok(assets.project);
			const assetFolder: DirectoryNode = {
				directoryPath: path.join(projectDirectory, "assets", "docs"),
				kind: "directory",
				label: "docs",
				mode: "resources",
				project: assets.project,
				resourceRoot: "assets"
			};
			await vscode.commands.executeCommand("es4a.copyResourceFolderName", assetFolder);
			assert.equal(await vscode.env.clipboard.readText(), "docs");
			await vscode.commands.executeCommand("es4a.copyResourceRelativePath", assetFolder);
			assert.equal(await vscode.env.clipboard.readText(), path.join("assets", "docs"));
			await vscode.commands.executeCommand("es4a.copyResourceAbsolutePath", assetFolder);
			assert.equal(
				await vscode.env.clipboard.readText(),
				path.join(projectDirectory, "assets", "docs")
			);

			const resFolder = (await provider.getChildren(res)).find(
				(node) => node.kind === "directory" && node.label === "drawable"
			);
			assert.ok(resFolder?.kind === "directory");
			await vscode.commands.executeCommand("es4a.copyResourceFolderName", resFolder);
			assert.equal(await vscode.env.clipboard.readText(), "drawable");
			await vscode.commands.executeCommand("es4a.copyResourceRelativePath", resFolder);
			assert.equal(await vscode.env.clipboard.readText(), path.join("res", "drawable"));
			await vscode.commands.executeCommand("es4a.copyResourceAbsolutePath", resFolder);
			assert.equal(await vscode.env.clipboard.readText(), path.join(projectDirectory, "res", "drawable"));

			const resFile = (await provider.getChildren(resFolder)).find(
				(node) => node.kind === "file" && node.label === "icon.png"
			);
			assert.ok(resFile?.kind === "file");
			assert.equal(resFile.resourceIndex, "R.drawable_icon");
			await vscode.commands.executeCommand("es4a.copyResourceIndex", resFile);
			assert.equal(await vscode.env.clipboard.readText(), "R.drawable_icon");
			await vscode.commands.executeCommand("es4a.copyResourceFileName", resFile);
			assert.equal(await vscode.env.clipboard.readText(), "icon.png");
			await vscode.commands.executeCommand("es4a.copyResourceRelativePath", resFile);
			assert.equal(await vscode.env.clipboard.readText(), path.join("res", "drawable", "icon.png"));
			await vscode.commands.executeCommand("es4a.copyResourceAbsolutePath", resFile);
			assert.equal(
				await vscode.env.clipboard.readText(),
				path.join(projectDirectory, "res", "drawable", "icon.png")
			);

			const valuesFolder = (await provider.getChildren(res)).find(
				(node) => node.kind === "directory" && node.label === "values"
			);
			assert.ok(valuesFolder?.kind === "directory");
			const valuesFile = (await provider.getChildren(valuesFolder)).find(
				(node) => node.kind === "file" && node.label === "es4a_strings.xml"
			);
			assert.ok(valuesFile?.kind === "file");
			assert.equal(valuesFile.resourceIndex, undefined);
			assert.equal(provider.getTreeItem(valuesFile).contextValue, "es4a.resFile");
		} finally {
			await vscode.env.clipboard.writeText(previousClipboard);
			provider.dispose();
		}
	});

	test("类库根节点显示清单元数据并提供清单操作上下文", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		const sdk = await loadSdk(path.resolve(extension.extensionPath, "..", "sdk", "sdk.json"));
		const provider = new LibraryTreeProvider(async () => sdk);
		try {
			await provider.refresh();
			const library = provider.getChildren().find(
				(node) => node.kind === "manifest" && node.manifest.name === "HTTP服务扩展库"
			);
			assert.ok(library?.kind === "manifest", "没有找到 HTTP 服务扩展库根节点");
			const item = provider.getTreeItem(library);
			assert.equal(item.description, "0.1.0");
			assert.equal(item.contextValue, "es4a.libraryManifest");
			assert.ok(item.tooltip instanceof vscode.MarkdownString);
			assert.match(item.tooltip.value, /^\*\*HTTP服务扩展库\*\*  \n提供 HTTP 服务器路由注册与请求响应功能。\n\n类别：扩展库  \n版本：0\.1\.0/u);
			assert.match(item.tooltip.value, /作者：树先生（\[xhwsd@qq\.com\]\(mailto:xhwsd%40qq\.com\)）/u);
			assert.match(item.tooltip.value, /目录：simple\.library\.wsd\.httpserver/u);
			assert.ok(item.tooltip.value.endsWith("目录：simple.library.wsd.httpserver"));
			assert.doesNotMatch(item.tooltip.value, /library\.json/u);
		} finally {
			provider.dispose();
		}
	});

	test("类库树保持注册数组及清单分类顺序", async () => {
		const compiler: LibraryManifest = {
			categories: [],
			directory: os.tmpdir(),
			filePath: path.join(os.tmpdir(), "compiler.json"),
			kind: "compiler",
			name: "编译器"
		};
		const runtime: LibraryManifest = {
			categories: [],
			directory: os.tmpdir(),
			filePath: path.join(os.tmpdir(), "runtime.json"),
			kind: "runtime",
			name: "运行库"
		};
		const laterLibrary: LibraryManifest = {
			categories: [
				{ definitions: [], name: "清单第一分类" },
				{ definitions: [], name: "清单第二分类" }
			],
			directory: os.tmpdir(),
			filePath: path.join(os.tmpdir(), "later-library.json"),
			kind: "library",
			name: "后置类库"
		};
		const earlierLibrary: LibraryManifest = {
			categories: [],
			directory: os.tmpdir(),
			filePath: path.join(os.tmpdir(), "earlier-library.json"),
			kind: "library",
			name: "前置类库"
		};
		const provider = new LibraryTreeProvider(async () => ({
			capabilities: { projects: [], tools: [] },
			templates: {},
			directory: os.tmpdir(),
			filePath: path.join(os.tmpdir(), "sdk.json"),
			issues: [],
			manifests: [compiler, runtime, laterLibrary, earlierLibrary]
		}));

		try {
			await provider.refresh();
			const roots = provider.getChildren();
			assert.deepEqual(roots.map((node) => node.kind === "manifest" ? node.manifest.name : node.kind), [
				"编译器",
				"运行库",
				"后置类库",
				"前置类库"
			]);
			const laterNode = roots.find(
				(node) => node.kind === "manifest" && node.manifest === laterLibrary
			);
			assert.ok(laterNode?.kind === "manifest");
			assert.deepEqual(provider.getChildren(laterNode).map((node) => (
				node.kind === "category" ? node.category.name : node.kind
			)), ["清单第一分类", "清单第二分类"]);
		} finally {
			provider.dispose();
		}
	});

	test("类库树使用紧凑签名、继承摘要和分组语义图标", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		const sdk = await loadSdk(path.resolve(extension.extensionPath, "..", "sdk", "sdk.json"));
		const provider = new LibraryTreeProvider(async () => sdk);

		try {
			await provider.refresh();
			const compiler = provider.getChildren().find(
				(node) => node.kind === "manifest" && node.manifest.kind === "compiler"
			);
			assert.ok(compiler?.kind === "manifest", "没有找到编译器根节点");
			const compilerTooltip = provider.getTreeItem(compiler).tooltip;
			assert.ok(compilerTooltip instanceof vscode.MarkdownString);
			assert.doesNotMatch(compilerTooltip.value, /(?:路径|目录)：/u);
			const runtime = provider.getChildren().find(
				(node) => node.kind === "manifest" && node.manifest.kind === "runtime"
			);
			assert.ok(runtime?.kind === "manifest", "没有找到运行库根节点");
			const runtimeTooltip = provider.getTreeItem(runtime).tooltip;
			assert.ok(runtimeTooltip instanceof vscode.MarkdownString);
			assert.doesNotMatch(runtimeTooltip.value, /(?:路径|目录)：/u);
			const componentCategory = provider.getChildren(runtime).find(
				(node) => node.kind === "category" && node.category.name === "组件"
			);
			assert.ok(componentCategory?.kind === "category", "没有找到组件分类");
			const componentCategoryTooltip = provider.getTreeItem(componentCategory).tooltip;
			assert.ok(componentCategoryTooltip instanceof vscode.MarkdownString);
			assert.match(componentCategoryTooltip.value, /^\*\*组件\*\*  \n数量：\d+/u);
			const component = provider.getChildren(componentCategory).find(
				(node) => node.kind === "definition" && node.reference.definition.name === "组件"
			);
			assert.ok(component?.kind === "definition", "没有找到组件基础接口");
			const componentIcon = provider.getTreeItem(component).iconPath;
			assert.ok(componentIcon instanceof vscode.ThemeIcon);
			assert.equal(componentIcon.id, "symbol-structure");
			assert.equal(componentIcon.color, undefined);
			const timer = provider.getChildren(componentCategory).find(
				(node) => node.kind === "definition" && node.reference.definition.name === "计时器"
			);
			assert.ok(timer?.kind === "definition", "没有找到计时器组件");
			const timerTooltip = provider.getTreeItem(timer).tooltip;
			assert.ok(timerTooltip instanceof vscode.MarkdownString);
			assert.match(
				timerTooltip.value,
				/^\*\*计时器\*\*  \n按照指定时间间隔触发计时事件的组件。\n\n类别：组件  \n类型：simple\.runtime\.components\.计时器  \n继承：simple\.runtime\.components\.组件$/u
			);
			const timerIcon = provider.getTreeItem(timer).iconPath;
			assert.ok(
				typeof timerIcon === "object"
				&& timerIcon !== null
				&& !(timerIcon instanceof vscode.ThemeIcon)
				&& "dark" in timerIcon
			);
			assert.equal(timerIcon.dark.scheme, "data");
			assert.match(timerIcon.dark.path, /^image\/svg\+xml,/u);
			const componentContainers = provider.getChildren(runtime).find(
				(node) => node.kind === "category" && node.category.name === "组件容器"
			);
			assert.ok(componentContainers?.kind === "category", "没有找到组件容器分类");
			const window = provider.getChildren(componentContainers).find(
				(node) => node.kind === "definition" && node.reference.definition.name === "窗口"
			);
			assert.ok(window?.kind === "definition", "没有找到窗口组件");
			const windowIcon = provider.getTreeItem(window).iconPath;
			assert.ok(
				typeof windowIcon === "object"
				&& windowIcon !== null
				&& !(windowIcon instanceof vscode.ThemeIcon)
				&& "dark" in windowIcon
			);
			assert.equal(windowIcon.dark.scheme, "data");
			assert.match(windowIcon.dark.path, /^image\/svg\+xml,/u);
			const visualComponents = provider.getChildren(runtime).find(
				(node) => node.kind === "category" && node.category.name === "视图组件"
			);
			assert.ok(visualComponents?.kind === "category", "没有找到视图组件分类");
			const button = provider.getChildren(visualComponents).find(
				(node) => node.kind === "definition" && node.reference.definition.name === "按钮"
			);
			assert.ok(button?.kind === "definition", "没有找到按钮组件");
			const propertyGroup = provider.getChildren(button).find(
				(node) => node.kind === "group" && node.group === "properties"
			);
			assert.ok(propertyGroup?.kind === "group", "按钮组件没有属性分组");
			const visible = provider.getChildren(propertyGroup).find(
				(node) => node.kind === "member" && node.value.member.name === "可视"
			);
			assert.ok(visible?.kind === "member", "没有找到继承属性可视");
			const visibleTooltip = provider.getTreeItem(visible).tooltip;
			assert.ok(visibleTooltip instanceof vscode.MarkdownString);
			assert.equal(
				visibleTooltip.value,
				"**可视 为 逻辑型**  \n欲设置组件的可视状态。\n\n初始值：真  \n继承自：可视组件"
			);
			const functionGroup = provider.getChildren(button).find(
				(node) => node.kind === "group" && node.group === "functions"
			);
			assert.ok(functionGroup?.kind === "group", "按钮组件没有函数分组");
			const groupItem = provider.getTreeItem(functionGroup);
			assert.ok(groupItem.iconPath instanceof vscode.ThemeIcon);
			assert.equal(groupItem.iconPath.id, "symbol-method");
			assert.ok(groupItem.tooltip instanceof vscode.MarkdownString);
			assert.match(groupItem.tooltip.value, /^\*\*函数\*\*  \n拥有数：\d+  \n定义数：\d+  \n继承数：\d+$/u);
			const setMargin = provider.getChildren(functionGroup).find(
				(node) => node.kind === "member" && node.value.member.name === "置边距"
			);
			assert.ok(setMargin?.kind === "member", "没有找到继承函数置边距");
			const memberItem = provider.getTreeItem(setMargin);
			assert.equal(memberItem.label, "置边距");
			assert.equal(memberItem.description, "← 可视组件");
			assert.ok(memberItem.tooltip instanceof vscode.MarkdownString);
			assert.match(memberItem.tooltip.value, /leftMargin 为 整数型/);
			assert.match(memberItem.tooltip.value, /^\*\*置边距\([^\r\n]+\*\*  \n设置组件的边距。\n\n\*左边距：\*/u);
			assert.match(memberItem.tooltip.value, /\*底边距：\*[\s\S]+\n\n继承自：可视组件$/u);
			const declaredSetMargin = await provider.findSymbol(
				libraryMemberTarget(setMargin.value.owner, "functions", setMargin.value.member)
			);
			assert.ok(declaredSetMargin?.kind === "member", "无法按需定位类库方法");
			const declaredGroup = provider.getParent(declaredSetMargin);
			assert.ok(declaredGroup?.kind === "group");
			const declaredDefinition = provider.getParent(declaredGroup);
			assert.ok(declaredDefinition?.kind === "definition");
			assert.equal(declaredDefinition.reference.definition.name, "可视组件");

			const functionCategory = provider.getChildren(runtime).find(
				(node) => node.kind === "category" && node.category.name === "函数集"
			);
			assert.ok(functionCategory?.kind === "category", "没有找到函数集分类");
			const pixel = provider.getChildren(functionCategory).find(
				(node) => node.kind === "definition" && node.reference.definition.name === "像素转换"
			);
			assert.ok(pixel?.kind === "definition", "没有找到像素函数集合");
			const constantGroup = provider.getChildren(pixel).find(
				(node) => node.kind === "group" && node.group === "constants"
			);
			assert.ok(constantGroup?.kind === "group", "像素函数集合没有常量分组");
			const absolutePixel = provider.getChildren(constantGroup).find(
				(node) => node.kind === "member" && node.value.member.name === "像素_绝对"
			);
			assert.ok(absolutePixel?.kind === "member", "没有找到像素_绝对常量");
			const constantItem = provider.getTreeItem(absolutePixel);
			assert.equal(constantItem.label, "像素_绝对");
			assert.ok(constantItem.tooltip instanceof vscode.MarkdownString);
			assert.equal(constantItem.tooltip.value, "**像素_绝对 为 整数型 = 0**");
		} finally {
			provider.dispose();
		}
	});

	test("类库树按组件 kind 使用 VS Code 缺省图标", async () => {
		const manifest: LibraryManifest = {
			categories: [{
				definitions: [
					{ kind: "component.window", name: "窗口" },
					{
						inherits: ["simple.runtime.components.组件容器"],
						kind: "component",
						name: "面板"
					},
					{ kind: "component", name: "按钮" },
					{ kind: "component", name: "计时器" }
				],
				name: "组件"
			}],
			directory: os.tmpdir(),
			filePath: path.join(os.tmpdir(), "runtime.json"),
			kind: "runtime",
			name: "测试运行库"
		};
		const sdk: Sdk = {
			capabilities: { projects: [], tools: [] },

			templates: {},
			directory: os.tmpdir(),
			filePath: path.join(os.tmpdir(), "sdk.json"),
			issues: [],
			manifests: [manifest]
		};
		const provider = new LibraryTreeProvider(async () => sdk);

		try {
			await provider.refresh();
			const runtime = provider.getChildren().find((node) => node.kind === "manifest");
			assert.ok(runtime?.kind === "manifest");
			const category = provider.getChildren(runtime).find((node) => node.kind === "category");
			assert.ok(category?.kind === "category");
			const iconIds = Object.fromEntries(provider.getChildren(category).map((node) => {
				assert.ok(node.kind === "definition");
				const icon = provider.getTreeItem(node).iconPath;
				assert.ok(icon instanceof vscode.ThemeIcon);
				return [node.reference.definition.name, icon.id];
			}));

			assert.deepEqual(iconIds, {
				窗口: "window",
				面板: "layout",
				按钮: "symbol-class",
				计时器: "symbol-class"
			});
		} finally {
			provider.dispose();
		}
	});

	test("类库树以参数数量区分同名重载", async () => {
		const manifest: LibraryManifest = {
			categories: [{
				definitions: [{
					functions: [
						{ name: "执行" },
						{ name: "执行", params: [{ name: "value", type: "整数型" }] }
					],
					inherits: ["基础对象"],
					kind: "object",
					name: "测试对象"
				}, {
					functions: [{
						description: "设置组件的填充。",
						name: "置填充",
						params: [{ description: "左填充", name: "leftPadding", type: "整数型" }]
					}],
					kind: "object",
					name: "基础对象"
				}],
				name: "对象"
			}],
			directory: os.tmpdir(),
			filePath: path.join(os.tmpdir(), "overload-runtime.json"),
			kind: "runtime",
			name: "测试运行库"
		};
		const sdk: Sdk = {
			capabilities: { projects: [], tools: [] },

			templates: {},
			directory: os.tmpdir(),
			filePath: path.join(os.tmpdir(), "overload-sdk.json"),
			issues: [],
			manifests: [manifest]
		};
		const provider = new LibraryTreeProvider(async () => sdk);
		try {
			await provider.refresh();
			const runtime = provider.getChildren()[0];
			assert.ok(runtime?.kind === "manifest");
			const category = provider.getChildren(runtime)[0];
			assert.ok(category?.kind === "category");
			const definition = provider.getChildren(category)[0];
			assert.ok(definition?.kind === "definition");
			const group = provider.getChildren(definition)[0];
			assert.ok(group?.kind === "group");
			const members = provider.getChildren(group);
			const overloads = members.filter(
				(node) => node.kind === "member" && node.value.member.name === "执行"
			);
			assert.deepEqual(overloads.map((node) => provider.getTreeItem(node).label), [
				"执行",
				"执行"
			]);
			assert.deepEqual(overloads.map((node) => provider.getTreeItem(node).description), [
				"0个参数",
				"1个参数"
			]);
			const first = overloads[0];
			const second = overloads[1];
			assert.ok(first?.kind === "member");
			assert.ok(second?.kind === "member");
			assert.notEqual(
				libraryMemberTarget(first.value.owner, "functions", first.value.member).memberKey,
				libraryMemberTarget(second.value.owner, "functions", second.value.member).memberKey
			);
			const inherited = members.find(
				(node) => node.kind === "member" && node.value.member.name === "置填充"
			);
			assert.ok(inherited?.kind === "member");
			const inheritedTooltip = provider.getTreeItem(inherited).tooltip;
			assert.ok(inheritedTooltip instanceof vscode.MarkdownString);
			assert.equal(
				inheritedTooltip.value,
				"**置填充(leftPadding 为 整数型)**  \n"
				+ "*leftPadding：*&#8203;左填充\n\n"
				+ "设置组件的填充。\n\n"
				+ "继承自：基础对象"
			);
		} finally {
			provider.dispose();
		}
	});

	test("VS Code 可请求当前文档函数的参数提示", async () => {
		const content = [
			"''' **求和说明**",
			"函数 Sum(left 为 整数型, right 为 整数型) 为 整数型",
			"结束 函数",
			"Sum("
		].join("\r\n");
		const document = await vscode.workspace.openTextDocument({ content, language: "simple" });
		const help = await vscode.commands.executeCommand<vscode.SignatureHelp>(
			"vscode.executeSignatureHelpProvider",
			document.uri,
			document.positionAt(content.length),
			"("
		);

		assert.ok(help);
		assert.equal(help.activeParameter, 0);
		assert.equal(help.signatures[0]?.label, "Sum(left 为 整数型, right 为 整数型) 为 整数型");
		const documentation = help.signatures[0]?.documentation;
		assert.equal(
			typeof documentation === "string" ? documentation : documentation?.value,
			"**求和说明**"
		);
	});

	test("参数提示按限定变量类型列出运行库重载", async () => {
		const extension = vscode.extensions.getExtension("es4a.es4a");
		assert.ok(extension, "没有找到 ES4A 扩展");
		const sdk = await loadSdk(path.resolve(extension.extensionPath, "..", "sdk", "sdk.json"));
		const sourceRoot = "C:\\project\\src";
		const fullSource = [
			"过程 Run()",
			"\t变量 list 为 分组列表框",
			"\tlist.添加子项(1, \"\", \"\", \"\", ",
			"结束 过程",
			"$属性",
			"\t$资源 $对象",
			"$结束 $属性"
		].join("\r\n");
		const userCode = splitSimpleUnitSource(fullSource).userCode;
		const unit = parseSimpleUnitSymbols(fullSource, `${sourceRoot}\\Overload.simple`, sourceRoot);
		const context: SimpleProjectSemanticContext = {
			currentUnit: unit,
			manifest: {
				categories: [{ definitions: [unit.definition], hidden: true, name: "项目单元" }],
				directory: "C:\\project",
				filePath: "C:\\project\\project.properties",
				kind: "project",
				name: "测试项目"
			}
		};
		const document = await vscode.workspace.openTextDocument({ content: userCode, language: "simple" });
		const provider = new SimpleSignatureHelpProvider(() => userCode, () => context);
		provider.updateSdk(sdk);
		const help = provider.provideSignatureHelp(
			document,
			document.positionAt(userCode.indexOf("\r\n结束 过程")),
			new vscode.CancellationTokenSource().token,
			{
				activeSignatureHelp: undefined,
				isRetrigger: false,
				triggerCharacter: undefined,
				triggerKind: vscode.SignatureHelpTriggerKind.Invoke
			}
		);

		assert.ok(help);
		assert.deepEqual(help.signatures.map((signature) => signature.label), [
			"list.添加子项(groupid 为 整数型, title 为 文本型)",
			"list.添加子项(groupid 为 整数型, image 为 文本型, title 为 文本型, info 为 文本型, buttonimage 为 文本型, buttontitle 为 文本型)"
		]);
		assert.equal(help.activeParameter, 4);
		assert.equal(help.activeSignature, 1);
	});
});
