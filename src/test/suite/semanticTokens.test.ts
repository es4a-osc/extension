/*
验证不同打开入口在无 SDK 时提供一致的源码着色，并核对真实编辑器显示和主题响应。
xhwsd@qq.com 2026-11-4
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { loadConfiguredSdk } from "../../main";
import { ProgramTreeProvider } from "../../programTree";
import { toSimpleSourceUri } from "../../simpleCodeFileSystem";
import { toUnitContentPreviewUri, toUnitPreviewSourceUri } from "../../unitPreview";
import { testExtensionId } from "../testFixtures";
import { WorkbenchDriver } from "./workbenchDriver";

const userCode = [
	"常量 上限 为 整数型 = 7",
	"变量 上限值 为 整数型",
	"函数 计算(值 为 整数型) 为 整数型",
	"\t如果 值 > 0 则",
	"\t\t计算 = 计算(值 - 1) + 上限",
	"\t否则",
	"\t\t计算 = 值",
	"\t结束 如果",
	"结束 函数",
	"过程 运行()",
	"\t变量 上限 为 整数型",
	"\t上限 = 1",
	"\t上限值 = 计算(上限)",
	"\t' 上限 计算 值 保留在注释中",
	'\t变量 文本值 为 文本型 = "上限 计算 值"',
	"结束 过程",
	""
].join("\r\n");
const propertySource = "$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n";

interface SourceToken {
	readonly line: number;
	readonly character: number;
	readonly text: string;
	readonly type: string;
	readonly modifiers: readonly string[];
}

/** 通过实际注册的 Provider 读取结果，避免绕过文档选择器验证。 */
async function readTokens(document: vscode.TextDocument): Promise<readonly SourceToken[]> {
	const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend>(
		"vscode.provideDocumentSemanticTokensLegend", document.uri
	);
	const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>(
		"vscode.provideDocumentSemanticTokens", document.uri
	);
	assert.ok(legend && tokens, `${document.uri.scheme} 文档缺少语义着色 Provider`);
	const result: SourceToken[] = [];
	let line = 0;
	let character = 0;
	for (let index = 0; index < tokens.data.length; index += 5) {
		line += tokens.data[index]!;
		character = tokens.data[index] === 0 ? character + tokens.data[index + 1]! : tokens.data[index + 1]!;
		const modifiers = tokens.data[index + 4]!;
		result.push({
			line, character,
			text: document.lineAt(line).text.slice(character, character + tokens.data[index + 2]!),
			type: legend.tokenTypes[tokens.data[index + 3]!]!,
			modifiers: legend.tokenModifiers.filter((_, modifier) => (modifiers & (1 << modifier)) !== 0)
		});
	}
	return result;
}

/** 验证源码身份、作用域和忽略区，断言不依赖具体主题颜色。 */
function assertSourceRoles(tokens: readonly SourceToken[]): void {
	const at = (line: number, text: string): SourceToken => {
		const token = tokens.find((value) => value.line === line && value.text === text);
		assert.ok(token, `第 ${line + 1} 行缺少 ${text} 的语义标记`);
		return token;
	};
	assert.deepEqual(at(0, "上限").modifiers, ["readonly"]);
	assert.deepEqual(at(4, "上限").modifiers, ["readonly"]);
	assert.deepEqual(at(10, "上限").modifiers, []);
	assert.deepEqual(at(12, "上限").modifiers, []);
	assert.equal(at(2, "计算").type, "function");
	assert.deepEqual(tokens.filter((value) => value.line === 4 && value.text === "计算").map((value) => value.type), ["variable", "function"]);
	assert.equal(at(4, "值").type, "parameter");
	assert.equal(at(12, "上限值").type, "variable");
	assert.deepEqual(at(12, "上限值").modifiers, []);
	assert.equal(at(3, "如果").type, "simpleControl");
	assert.equal(at(0, "常量").type, "simpleDeclaration");
	assert.equal(at(0, "整数型").type, "type");
	assert.equal(at(4, "+").type, "operator");
	assert.equal(tokens.some((value) => value.line === 13), false);
	assert.equal(tokens.some((value) => value.line === 14 && ["上限", "计算", "值"].includes(value.text)), false);
}

/** 执行项目树实际提供的单元打开命令。 */
async function openProjectCode(file: string, project: string): Promise<vscode.TextEditor> {
	await vscode.commands.executeCommand("es4a.internal.addProject", project);
	const programs = new ProgramTreeProvider();
	try {
		await programs.addProject(project);
		const node = await programs.findUnitByFilePath(file);
		assert.ok(node);
		const command = programs.getTreeItem(node).command;
		assert.ok(command);
		await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
		const editor = vscode.window.activeTextEditor;
		assert.ok(editor);
		assert.notEqual(editor.document.uri.scheme, "file");
		return editor;
	} finally {
		programs.dispose();
	}
}

/** 读取真实工作台已渲染的文本颜色，不读取分析器内部缓存。 */
function renderedColors(name: string): string {
	return `Array.from(document.querySelectorAll('.monaco-editor .view-line span')).filter(span => span.children.length === 0 && span.textContent.trim() === ${JSON.stringify(name)}).map(span => getComputedStyle(span).color)`;
}

/** 同名返回值、递归调用和遮蔽变量应分别响应测试主题中的对应规则。 */
async function assertRenderedRoles(driver: WorkbenchDriver): Promise<void> {
	await driver.waitFor(`(${renderedColors("上限")}).includes('rgb(230, 81, 0)')
		&& (${renderedColors("上限")}).includes('rgb(25, 118, 210)')
		&& (${renderedColors("计算")}).includes('rgb(123, 31, 162)')
		&& (${renderedColors("计算")}).includes('rgb(25, 118, 210)')
		&& (${renderedColors("值")}).includes('rgb(0, 137, 123)')`);
}

/** 关闭并清理本用例创建的文件；不操作其它标签或真实项目。 */
async function withSource(action: (file: string, project: string) => Promise<void>): Promise<void> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-semantic-tokens-"));
	const file = path.join(directory, "src", "着色.simple");
	const project = path.join(directory, "project.properties");
	try {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, userCode + propertySource);
		await fs.writeFile(project, "source=./src\r\nmain=着色\r\n");
		await action(file, project);
	} finally {
		for (const document of vscode.workspace.textDocuments) {
			const source = toSimpleSourceUri(document.uri) ?? toUnitPreviewSourceUri(document.uri);
			if (source?.fsPath.startsWith(directory + path.sep) && document.isDirty) {
				await document.save();
			}
		}
		const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs.filter((tab) => {
			if (!(tab.input instanceof vscode.TabInputText)) {
				return false;
			}
			const source = toSimpleSourceUri(tab.input.uri) ?? toUnitPreviewSourceUri(tab.input.uri);
			return source?.fsPath.startsWith(directory + path.sep) === true;
		}));
		if (tabs.length > 0) {
			await vscode.window.tabGroups.close(tabs, true);
		}
		await vscode.commands.executeCommand("es4a.internal.removeProject", project);
		await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}

suite("Simple 源码语义着色", () => {
	let driver: WorkbenchDriver;
	let previousSdk: string | undefined;
	let previousColors: unknown;

	suiteSetup(async () => {
		/* 确认加载的是工作区开发版本，防止机器上安装的同名扩展干扰验收。 */
		const extension = vscode.extensions.getExtension(testExtensionId());
		assert.ok(extension);
		assert.equal(path.resolve(extension.extensionPath).toLowerCase(), path.resolve(__dirname, "../../..").toLowerCase());
		const es4aExtensions = vscode.extensions.all.filter((value) => value.packageJSON.name === "es4a" || value.packageJSON.displayName === "ES4A");
		assert.deepEqual(es4aExtensions.map((value) => value.id), [extension.id]);
		console.log(`着色测试加载开发扩展：${extension.extensionPath}`);
		const configuration = vscode.workspace.getConfiguration("es4a");
		previousSdk = configuration.inspect<string>("sdk.path")?.globalValue;
		await configuration.update("sdk.path", undefined, vscode.ConfigurationTarget.Global);
		await extension.activate();
		await vscode.commands.executeCommand("es4a.refreshLibraries");
		assert.equal(await loadConfiguredSdk(), undefined);
		previousColors = vscode.workspace.getConfiguration("editor").inspect("semanticTokenColorCustomizations")?.globalValue;
		/* 颜色仅由测试主题规则指定，验证各入口服从相同的主题配置。 */
		await vscode.workspace.getConfiguration("editor").update("semanticTokenColorCustomizations", {
			enabled: true,
			rules: { "variable": "#1976D2", "variable.readonly": "#E65100", "function": "#7B1FA2", "parameter": "#00897B" }
		}, vscode.ConfigurationTarget.Global);
		driver = await WorkbenchDriver.connect();
	});

	suiteTeardown(async () => {
		driver?.dispose();
		await vscode.workspace.getConfiguration("editor").update("semanticTokenColorCustomizations", previousColors, vscode.ConfigurationTarget.Global);
		await vscode.workspace.getConfiguration("es4a").update("sdk.path", previousSdk, vscode.ConfigurationTarget.Global);
		await vscode.commands.executeCommand("es4a.refreshLibraries");
	});

	test("原生文件、项目树代码、新建文档和完整预览在无 SDK 时提供一致着色", async () => {
		await withSource(async (file, project) => {
			/* 原生资源管理器使用的文件打开命令，不先添加 ES4A 项目。 */
			await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file), { preview: false });
			const native = vscode.window.activeTextEditor!.document;
			assert.equal(native.uri.scheme, "file");
			assert.equal(native.languageId, "simple");
			const baseline = (await readTokens(native)).filter((value) => value.line < 16);
			assertSourceRoles(baseline);
			await assertRenderedRoles(driver);

			/* 从真实项目树节点读取打开命令，而不是直接调用分析器。 */
			const code = await openProjectCode(file, project);
			assert.deepEqual(await readTokens(code.document), baseline);
			await assertRenderedRoles(driver);

			await vscode.commands.executeCommand("vscode.open", toUnitContentPreviewUri(vscode.Uri.file(file)), { preview: false });
			const preview = vscode.window.activeTextEditor!.document;
			assert.equal(preview.languageId, "simple-full-preview");
			assert.deepEqual((await readTokens(preview)).filter((value) => value.line < 16), baseline);
			await assertRenderedRoles(driver);

			const untitled = await vscode.workspace.openTextDocument({ language: "simple", content: userCode });
			await vscode.window.showTextDocument(untitled, { preview: false });
			try {
				assert.deepEqual(await readTokens(untitled), baseline);
				await assertRenderedRoles(driver);
			} finally {
				await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
			}
		});
	});

	for (const entry of ["原生文件", "ES4A 代码标签"] as const) {
		test(`真实${entry}修改声明后，引用身份和显示颜色立即更新`, async () => {
			await withSource(async (file, project) => {
				const editor = entry === "原生文件"
					? await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false })
					: await openProjectCode(file, project);
				assertSourceRoles(await readTokens(editor.document));
				await assertRenderedRoles(driver);

				/* 同一个名称由常量改为变量后，引用不能残留 readonly 标记或旧颜色。 */
				assert.equal(await editor.edit((edit) => edit.replace(new vscode.Range(0, 0, 0, 2), "变量")), true);
				const changed = await readTokens(editor.document);
				assert.ok(changed.filter((value) => value.text === "上限").length >= 4);
				assert.ok(changed.filter((value) => value.text === "上限").every((value) => !value.modifiers.includes("readonly")));
				await driver.waitFor(`(${renderedColors("上限")}).length > 0 && (${renderedColors("上限")}).every(color => color === 'rgb(25, 118, 210)')`);
			});
		});
	}

	test("原生文档在无 SDK 时根据项目源码细化跨单元成员身份", async () => {
		await withSource(async (file, project) => {
			const target = path.join(path.dirname(file), "数据对象.simple");
			await fs.writeFile(target, "常量 源常量 为 整数型 = 7\r\n变量 源字段 为 整数型\r\n函数 源函数() 为 整数型\r\n源函数 = 源常量\r\n结束 函数\r\n" + propertySource);
			await fs.writeFile(file, "变量 数据 为 数据对象\r\n过程 运行()\r\n数据.源字段 = 数据.源常量\r\n数据.源函数()\r\n结束 过程\r\n" + propertySource);
			await vscode.commands.executeCommand("es4a.internal.addProject", project);
			const editor = await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
			let tokens: readonly SourceToken[] = [];
			for (let attempt = 0; attempt < 100; attempt += 1) {
				tokens = await readTokens(editor.document);
				if (tokens.some((value) => value.text === "源常量" && value.modifiers.includes("readonly"))) {
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			assert.equal(tokens.find((value) => value.text === "数据对象")?.type, "type");
			assert.equal(tokens.find((value) => value.text === "源字段")?.type, "variable");
			assert.deepEqual(tokens.find((value) => value.text === "源常量")?.modifiers, ["readonly"]);
			assert.equal(tokens.find((value) => value.text === "源函数")?.type, "method");
			assert.equal(await loadConfiguredSdk(), undefined);

			/* 另一原生单元的未保存声明变化也应影响当前单元，不能继续沿用磁盘中的常量身份。 */
			const targetEditor = await vscode.window.showTextDocument(vscode.Uri.file(target), { preview: false });
			assert.equal(await targetEditor.edit((edit) => edit.replace(new vscode.Range(0, 0, 0, 2), "变量")), true);
			assert.equal(targetEditor.document.isDirty, true);
			await vscode.window.showTextDocument(editor.document, { preview: false });
			tokens = await readTokens(editor.document);
			assert.deepEqual(tokens.find((value) => value.text === "源常量")?.modifiers, []);
			const code = await openProjectCode(file, project);
			assert.deepEqual((await readTokens(code.document)).find((value) => value.text === "源常量")?.modifiers, []);
		});
	});
});
