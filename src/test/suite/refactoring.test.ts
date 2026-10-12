/*
验证项目重构在真实扩展宿主中协调代码、XML、main、文件移动和撤销。
xhwsd@qq.com 2026-10-10
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { SimpleDiagnosticProvider } from "../../diagnosticProvider";
import { SimpleProjectRefactoring } from "../../projectRefactoring";
import type { ProgramTreeProvider } from "../../programTree";
import type { ProjectSymbolIndex } from "../../projectSymbolIndex";
import { refactoringContext, type RefactoringUnit } from "../../refactoringModel";
import { simpleTestUnitPath } from "../testProjects";
import { inspectSimplePropertyXml } from "../../propertyXml";
import { splitSimpleUnitSource } from "../../simpleUnitSource";
import { loadSimpleProject } from "../../programResources";
import { SimpleDesignerProvider, type DesignerWebviewRenderMessage } from "../../designerWebview";
import type { SimpleDesignerDocument } from "../../designerDocument";
import { loadSdk } from "../../sdk";
import { planSimpleComponentProjectRename } from "../../componentRename";
import { serializePropertyXml } from "../../propertyXml";
import { SimpleCodeFileSystemProvider, toSimpleDesignerUri, toSimpleCodeUri } from "../../simpleCodeFileSystem";
import { getVisibleSimpleUnitUserCode } from "../../simpleUnitSource";
import { toUnitXmlPreviewUri } from "../../unitPreview";
import { filePathKey } from "../../simpleProjectPaths";

suite("项目关联重构", () => {
	let originalSdkPath: string | undefined;
	suiteSetup(async () => {
		const configuration = vscode.workspace.getConfiguration("es4a");
		originalSdkPath = configuration.inspect<string>("sdk.path")?.globalValue;
		await configuration.update("sdk.path", path.resolve(__dirname, "../../../../sdk/sdk.json"), vscode.ConfigurationTarget.Global);
		await vscode.extensions.getExtension("es4a.es4a")!.activate();
		await vscode.commands.executeCommand("es4a.refreshLibraries");
	});
	suiteTeardown(async () => {
		await vscode.workspace.getConfiguration("es4a").update("sdk.path", originalSdkPath, vscode.ConfigurationTarget.Global);
	});

	test("原生参与者跳过关联编辑时，只改文件名并释放计划", async function () {
		this.timeout(30000);
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-refactor-skip-"));
		const projectFile = path.join(directory, "project.properties");
		const old = path.join(directory, "src", "主窗口.simple");
		const next = path.join(directory, "src", "新窗口.simple");
		const callerFile = path.join(directory, "src", "调用者.simple");
		const source = "事件 主窗口.初始化()\r\n结束 事件\r\n\r\n$属性\r\n\t$资源 $窗口\r\n\t$定义 主窗口 $为 窗口\r\n\t$结束 $定义\r\n$结束 $属性\r\n";
		const callerSource = "变量 a 为 主窗口\r\n\r\n$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n";
		const properties = "source=./src\r\nmain=主窗口\r\n";
		const codeDocuments = new SimpleCodeFileSystemProvider();
		let refreshes = 0;
		const refactoring = new SimpleProjectRefactoring({
			codeDocuments,
			refreshProjectSemantics: async () => { refreshes += 1; }
		});
		let preparations = 0;
		const listener = vscode.workspace.onWillRenameFiles((event) => {
			if (!event.files.some((file) => filePathKey(file.oldUri.fsPath) === filePathKey(old))) return;
			const plan = refactoring.requestedPathEdit(event.files);
			assert.ok(plan, "项目树必须向原生参与者提供同一关联编辑计划");
			assert.ok(plan.get(toSimpleCodeUri(vscode.Uri.file(callerFile))).length > 0);
			assert.ok(plan.get(vscode.Uri.file(projectFile)).length > 0);
			preparations += 1;
			// 不返回准备好的附加编辑，模拟原生“跳过更改”；此时任何关联内容都不能提前写入。
			event.waitUntil((async () => {
				assert.equal(await fs.readFile(old, "utf8"), source);
				assert.equal(await fs.readFile(callerFile, "utf8"), callerSource);
				assert.equal(await fs.readFile(projectFile, "utf8"), properties);
			})());
		});
		try {
			await fs.mkdir(path.dirname(old), { recursive: true });
			await fs.writeFile(old, source);
			await fs.writeFile(callerFile, callerSource);
			await fs.writeFile(projectFile, properties);
			const project = await loadSimpleProject(projectFile);
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(callerFile))), { preview: false });
			// 不添加到扩展项目树，隔离本测试服务，防止全局参与者另行返回修改。
			await refactoring.renamePath(project, old, next, "units");
			assert.equal(preparations, 1);
			assert.equal(refreshes, 1);
			assert.equal(await fs.readFile(next, "utf8"), source);
			assert.equal(await fs.readFile(callerFile, "utf8"), callerSource);
			assert.equal(await fs.readFile(projectFile, "utf8"), properties);
			assert.equal(codeDocuments.isNativePathRename(vscode.Uri.file(old), vscode.Uri.file(next)), false);
			assert.equal(refactoring.requestedPathEdit([{ oldUri: vscode.Uri.file(old), newUri: vscode.Uri.file(next) }]), undefined);
			// 跳过后虚拟代码未参与附加编辑，从真正参与路径事务的文件撤销。
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(next)), { preview: false });
			await vscode.commands.executeCommand("undo");
			for (let attempt = 0; attempt < 100 && !await fs.stat(old).then(() => true, () => false); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
			assert.equal(await fs.readFile(old, "utf8"), source);
			await vscode.commands.executeCommand("redo");
			for (let attempt = 0; attempt < 100 && !await fs.stat(next).then(() => true, () => false); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
			assert.equal(await fs.readFile(next, "utf8"), source);
		} finally {
			listener.dispose();
			refactoring.dispose();
			codeDocuments.dispose();
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	test("资源改名同步 R、资产属性、Android XML 和应用图标，普通文本保持", async function () {
		this.timeout(30000);
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-refactor-resources-"));
		const projectFile = path.join(directory, "project.properties");
		const unitFile = path.join(directory, "src", "主窗口.simple");
		const image = path.join(directory, "res", "drawable", "old.png");
		const layout = path.join(directory, "res", "layout", "screen.xml");
		const source = "变量 图片编号 为 整数型\r\n事件 主窗口.初始化()\r\n\t图片编号 = R.drawable_old\r\n\t图片框1.图片 = \"@drawable/old\"\r\n\t显示提示框(\"@drawable/old\")\r\n结束 事件\r\n\r\n$属性\r\n\t$资源 $窗口\r\n\t$定义 主窗口 $为 窗口\r\n\t\t$定义 图片框1 $为 图片框\r\n\t\t\t图片 = \"@drawable/old\"\r\n\t\t\t未知字段 = \"@drawable/old\"\r\n\t\t$结束 $定义\r\n\t$结束 $定义\r\n$结束 $属性\r\n";
		try {
			await fs.mkdir(path.dirname(unitFile), { recursive: true });
			await fs.mkdir(path.dirname(image), { recursive: true });
			await fs.mkdir(path.dirname(layout), { recursive: true });
			await fs.writeFile(unitFile, source);
			await fs.writeFile(image, new Uint8Array([0]));
			await fs.writeFile(layout, '<ImageView android:src="@drawable/old" />\r\n<!-- @drawable/old 保持 -->\r\n');
			await fs.writeFile(projectFile, "source=./src\r\nmain=主窗口\r\nicon=@drawable/old\r\n");
			await vscode.commands.executeCommand("es4a.internal.addProject", projectFile);
			const project = await loadSimpleProject(projectFile);
			const document = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(unitFile)));
			await vscode.window.showTextDocument(document, { preview: false });
			await vscode.commands.executeCommand("es4a.renameResourceFile", { kind: "file", label: "old.png", filePath: image, resourceRoot: "res", project }, "new.png");
			const changed = await fs.readFile(unitFile, "utf8");
			assert.equal(getVisibleSimpleUnitUserCode(changed), getVisibleSimpleUnitUserCode(source));
			assert.equal(document.isDirty, true);
			assert.match(document.getText(), /图片编号 = R\.drawable_new/u);
			assert.match(document.getText(), /图片框1\.图片 = "@drawable\/new"/u);
			assert.match(changed, /\t\t\t图片 = "@drawable\/new"/u);
			assert.match(changed, /显示提示框\("@drawable\/old"\)/u);
			assert.match(changed, /未知字段 = "@drawable\/old"/u);
			const layoutDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(layout));
			const properties = await vscode.workspace.openTextDocument(vscode.Uri.file(projectFile));
			assert.match(layoutDocument.getText(), /src="@drawable\/new"/u);
			assert.equal(layoutDocument.isDirty, true);
			assert.match(await fs.readFile(layout, "utf8"), /src="@drawable\/old"/u);
			assert.match(await fs.readFile(layout, "utf8"), /<!-- @drawable\/old 保持 -->/u);
			assert.match(properties.getText(), /icon=@drawable\/new/u);
			assert.equal(properties.isDirty, true);
			assert.match(await fs.readFile(projectFile, "utf8"), /icon=@drawable\/old/u);
			await document.save();
			await layoutDocument.save();
			await properties.save();
			assert.match(await fs.readFile(unitFile, "utf8"), /图片编号 = R\.drawable_new/u);
			assert.match(await fs.readFile(layout, "utf8"), /src="@drawable\/new"/u);
			assert.match(await fs.readFile(projectFile, "utf8"), /icon=@drawable\/new/u);
			await vscode.commands.executeCommand("undo");
			assert.ok(await fs.stat(image));
			assert.equal(document.getText(), getVisibleSimpleUnitUserCode(source));
			const xml = await vscode.workspace.openTextDocument(toUnitXmlPreviewUri(vscode.Uri.file(unitFile)));
			assert.match(xml.getText(), /属性="图片" 值="&quot;@drawable\/old&quot;"/u);
		} finally {
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	test("资源连续改名保留代码、Android XML 和项目配置的未保存输入，撤销重做后再保存", async function () {
		this.timeout(30000);
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-resource-buffer-"));
		const projectFile = path.join(directory, "project.properties");
		const unitFile = path.join(directory, "src", "调用者.simple");
		const layoutFile = path.join(directory, "res", "layout", "screen.xml");
		const image = path.join(directory, "res", "drawable", "old.png");
		const source = '过程 P()\r\n\t显示提示框(R.drawable_old)\r\n结束 过程\r\n$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n';
		const layout = '<ImageView src="@drawable/old" unknown="保留" />\r\n<!-- @drawable/old 保持 -->\r\n<![CDATA[@drawable/old 保持]]>\r\n';
		const properties = "source=./src\r\nicon=@drawable/old\r\n未知字段=保留\r\n";
		try {
			await fs.mkdir(path.dirname(unitFile), { recursive: true });
			await fs.mkdir(path.dirname(layoutFile), { recursive: true });
			await fs.mkdir(path.dirname(image), { recursive: true });
			await fs.writeFile(unitFile, source);
			await fs.writeFile(layoutFile, layout);
			await fs.writeFile(projectFile, properties);
			await fs.writeFile(image, new Uint8Array([1]));
			await vscode.commands.executeCommand("es4a.internal.addProject", projectFile);
			const project = await loadSimpleProject(projectFile);
			const code = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(unitFile)));
			const xml = await vscode.workspace.openTextDocument(vscode.Uri.file(layoutFile));
			const configuration = await vscode.workspace.openTextDocument(vscode.Uri.file(projectFile));
			const pending = new vscode.WorkspaceEdit();
			pending.insert(code.uri, new vscode.Position(0, 0), "' 用户输入\r\n");
			pending.insert(xml.uri, new vscode.Position(0, 0), "<!-- 用户输入 -->\r\n");
			pending.insert(configuration.uri, new vscode.Position(0, 0), "# 用户输入\r\n");
			assert.ok(await vscode.workspace.applyEdit(pending));
			await vscode.window.showTextDocument(code, { preview: false });
			for (const [previous, next] of [["old", "middle"], ["middle", "new"]]) {
				await vscode.commands.executeCommand("es4a.renameResourceFile", { kind: "file", label: previous + ".png", filePath: path.join(path.dirname(image), previous + ".png"), project, resourceRoot: "res" }, next + ".png");
				assert.match(code.getText(), new RegExp("R\\.drawable_" + next, "u"));
				assert.match(xml.getText(), new RegExp('src="@drawable/' + next + '"', "u"));
				assert.match(configuration.getText(), new RegExp("icon=@drawable/" + next, "u"));
				assert.ok(code.isDirty && xml.isDirty && configuration.isDirty);
				assert.equal(await fs.readFile(unitFile, "utf8"), source);
				assert.equal(await fs.readFile(layoutFile, "utf8"), layout);
				assert.equal(await fs.readFile(projectFile, "utf8"), properties);
			}
			await vscode.commands.executeCommand("undo");
			assert.ok(await fs.stat(path.join(path.dirname(image), "middle.png")));
			assert.match(xml.getText(), /src="@drawable\/middle"/u);
			await vscode.commands.executeCommand("undo");
			assert.ok(await fs.stat(image));
			assert.equal(xml.getText(), "<!-- 用户输入 -->\r\n" + layout);
			assert.equal(configuration.getText(), "# 用户输入\r\n" + properties);
			assert.equal(code.getText(), "' 用户输入\r\n" + getVisibleSimpleUnitUserCode(source));
			await vscode.commands.executeCommand("redo");
			await vscode.commands.executeCommand("redo");
			await code.save(); await xml.save(); await configuration.save();
			assert.equal(await fs.readFile(unitFile, "utf8"), "' 用户输入\r\n" + source.replace("R.drawable_old", "R.drawable_new"));
			assert.equal(await fs.readFile(layoutFile, "utf8"), "<!-- 用户输入 -->\r\n" + layout.replace('src="@drawable/old"', 'src="@drawable/new"'));
			assert.equal(await fs.readFile(projectFile, "utf8"), "# 用户输入\r\n" + properties.replace("icon=@drawable/old", "icon=@drawable/new"));
		} finally {
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			assert.equal(path.dirname(directory), os.tmpdir());
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	test("Android XML 资源改名后，自身引用跟随新路径工作副本并支持保存及撤销", async function () {
		this.timeout(30000);
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-resource-own-xml-"));
		const projectFile = path.join(directory, "project.properties");
		const file = path.join(directory, "res", "layout", "old.xml");
		const next = path.join(path.dirname(file), "new.xml");
		const source = '<include layout="@layout/old" />\r\n<!-- @layout/old 保持 -->\r\n';
		try {
			await fs.mkdir(path.dirname(file), { recursive: true });
			await fs.mkdir(path.join(directory, "src"));
			await fs.writeFile(file, source);
			await fs.writeFile(projectFile, "source=./src\r\n");
			await vscode.commands.executeCommand("es4a.internal.addProject", projectFile);
			const project = await loadSimpleProject(projectFile);
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)), { preview: false });
			await vscode.commands.executeCommand("es4a.renameResourceFile", { kind: "file", label: "old.xml", filePath: file, project, resourceRoot: "res" }, "new.xml");
			assert.equal(await fs.stat(file).then(() => true, () => false), false);
			const renamed = await vscode.workspace.openTextDocument(vscode.Uri.file(next));
			assert.equal(renamed.getText(), source.replace('layout="@layout/old"', 'layout="@layout/new"'));
			assert.equal(renamed.isDirty, true);
			assert.equal(await fs.readFile(next, "utf8"), source);
			await vscode.window.showTextDocument(renamed);
			await vscode.commands.executeCommand("undo");
			assert.ok(await fs.stat(file));
			const restored = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
			assert.equal(restored.getText(), source);
			await vscode.window.showTextDocument(restored);
			await vscode.commands.executeCommand("redo");
			const redone = await vscode.workspace.openTextDocument(vscode.Uri.file(next));
			assert.equal(redone.getText(), source.replace('layout="@layout/old"', 'layout="@layout/new"'));
			await redone.save();
			assert.equal(await fs.readFile(next, "utf8"), redone.getText());
		} finally {
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			assert.equal(path.dirname(directory), os.tmpdir());
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	test("删除单元及资源后出现波浪线诊断，恢复文件后清除", async function () {
		this.timeout(30000);
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-refactor-diagnostics-"));
		const projectFile = path.join(directory, "project.properties");
		const callerFile = path.join(directory, "src", "调用者.simple");
		const targetFile = path.join(directory, "src", "目标.simple");
		const image = path.join(directory, "res", "drawable", "icon.png");
		const codeUri = toSimpleCodeUri(vscode.Uri.file(callerFile));
		const target = "$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n";
		const waitFor = async (predicate: () => boolean): Promise<void> => {
			for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
			assert.ok(predicate());
		};
		try {
			await fs.mkdir(path.dirname(targetFile), { recursive: true });
			await fs.mkdir(path.dirname(image), { recursive: true });
			await fs.writeFile(projectFile, "source=./src\r\n");
			await fs.writeFile(targetFile, target);
			await fs.writeFile(image, new Uint8Array([0]));
			await fs.writeFile(callerFile, "变量 a 为 目标\r\n变量 i 为 整数型\r\n过程 P()\r\n\ti = R.drawable_icon\r\n结束 过程\r\n\r\n$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n");
			await vscode.commands.executeCommand("es4a.internal.addProject", projectFile);
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(codeUri), { preview: false });
			await fs.unlink(targetFile);
			await fs.unlink(image);
			await vscode.commands.executeCommand("es4a.refreshPrograms");
			await waitFor(() => vscode.languages.getDiagnostics(codeUri).some((issue) => issue.code === "unknownType") && vscode.languages.getDiagnostics(codeUri).some((issue) => issue.code === "unknownResource"));
			assert.ok(vscode.languages.getDiagnostics(codeUri).every((issue) => issue.source === "ES4A 引用分析"));
			await fs.writeFile(targetFile, target);
			await fs.writeFile(image, new Uint8Array([0]));
			await vscode.commands.executeCommand("es4a.refreshPrograms");
			await waitFor(() => !vscode.languages.getDiagnostics(codeUri).some((issue) => issue.code === "unknownType" || issue.code === "unknownResource"));
		} finally {
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});
	test("窗口加载和初始化在真实代码编辑器中不显示无效成员诊断", async function () {
		this.timeout(30000);
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-diagnostic-object-events-"));
		const projectFile = path.join(directory, "project.properties");
		const unitFile = path.join(directory, "src", "主窗口.simple");
		const source = "事件 主窗口.加载()\r\n结束 事件\r\n事件 主窗口.初始化()\r\n结束 事件\r\n事件 主窗口.不存在事件()\r\n结束 事件\r\n$属性\r\n$资源 $窗口\r\n$定义 主窗口 $为 窗口\r\n$结束 $定义\r\n$结束 $属性\r\n";
		try {
			await fs.mkdir(path.dirname(unitFile), { recursive: true });
			await fs.writeFile(projectFile, "source=./src\r\nmain=主窗口\r\n");
			await fs.writeFile(unitFile, source);
			await vscode.commands.executeCommand("es4a.internal.addProject", projectFile);
			const document = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(unitFile)));
			await vscode.window.showTextDocument(document, { preview: false });
			await vscode.commands.executeCommand("es4a.refreshPrograms");
			for (let attempt = 0; attempt < 200 && !vscode.languages.getDiagnostics(document.uri).some((issue) => issue.message.includes("不存在事件")); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
			const issues = vscode.languages.getDiagnostics(document.uri).filter((issue) => issue.source === "ES4A 引用分析");
			assert.equal(issues.length, 1, "只应保留未知事件的警告，不能因尚未完成诊断而通过");
			assert.equal(issues[0]!.code, "unknownMember");
			assert.equal(document.getText(issues[0]!.range), "不存在事件");
			assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), document.uri.toString());
			assert.equal(await fs.readFile(unitFile, "utf8"), source);
		} finally {
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	test("选中真实 SmokeTests 完整变量名后，从末尾发起 F2，引用、保存及撤销一致", async function () {
		this.timeout(30000);
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-refactor-f2-boundary-"));
		const projectFile = path.join(directory, "project.properties");
		const unitFile = path.join(directory, "src/simple/runtime/smoketests/主窗口.simple");
		const source = await fs.readFile(await simpleTestUnitPath("SmokeTests", "主窗口"), "utf8");
		const name = "局_切换窗口";
		try {
			await fs.mkdir(path.dirname(unitFile), { recursive: true });
			await fs.writeFile(unitFile, source);
			await fs.writeFile(projectFile, "source=./src\r\nmain=simple.runtime.smoketests.主窗口\r\n");
			await vscode.commands.executeCommand("es4a.internal.addProject", projectFile);
			const document = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(unitFile)));
			const editor = await vscode.window.showTextDocument(document, { preview: false });
			const start = document.getText().indexOf(name + " = 创建 smoketests.functions.测试广播");
			assert.ok(start >= 0);
			editor.selection = new vscode.Selection(document.positionAt(start), document.positionAt(start + name.length));
			assert.equal(document.getText(editor.selection), name);
			const position = editor.selection.active;
			const locations = await vscode.commands.executeCommand<vscode.Location[]>("vscode.executeReferenceProvider", document.uri, position);
			assert.equal(locations.length, 47);
			const xml = await vscode.workspace.openTextDocument(toUnitXmlPreviewUri(vscode.Uri.file(unitFile)));
			const beforeXml = xml.getText();
			const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>("vscode.executeDocumentRenameProvider", document.uri, position, name + "1");
			assert.ok(edit);
			assert.equal(edit.get(document.uri).length, locations.length);
			assert.equal(document.getText(), getVisibleSimpleUnitUserCode(source));
			assert.equal(await fs.readFile(unitFile, "utf8"), source);
			let expected = getVisibleSimpleUnitUserCode(source);
			for (const change of [...edit.get(document.uri)].sort((a, b) => document.offsetAt(b.range.start) - document.offsetAt(a.range.start))) {
				const start = document.offsetAt(change.range.start);
				const end = document.offsetAt(change.range.end);
				expected = expected.slice(0, start) + change.newText + expected.slice(end);
			}
			assert.ok(await vscode.workspace.applyEdit(edit));
			assert.equal(document.getText(), expected);
			assert.equal(xml.getText(), beforeXml);
			assert.equal(await fs.readFile(unitFile, "utf8"), source);
			await vscode.commands.executeCommand("undo");
			assert.equal(document.getText(), getVisibleSimpleUnitUserCode(source));
			await vscode.commands.executeCommand("redo");
			assert.equal(document.getText(), expected);
			await document.save();
			const saved = await fs.readFile(unitFile, "utf8");
			assert.equal(getVisibleSimpleUnitUserCode(saved), expected);
			assert.equal(splitSimpleUnitSource(saved).propertySource, splitSimpleUnitSource(source).propertySource);
			assert.equal(serializePropertyXml(inspectSimplePropertyXml(saved).document!), serializePropertyXml(inspectSimplePropertyXml(source).document!));
		} finally {
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	test("引用位置 F2 重命名参数并整体撤销，保持其它作用域和磁盘属性", async () => {
		await vscode.extensions.getExtension("es4a.es4a")!.activate();
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-refactor-f2-"));
		const projectFile = path.join(directory, "project.properties");
		const unitFile = path.join(directory, "src", "对象1.simple");
		const source = "过程 A(值 为 整数型)\r\n\t值 = 值 + 1\r\n结束 过程\r\n过程 B(值 为 整数型)\r\n\t值 = 2\r\n结束 过程\r\n\r\n$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n";
		try {
			await fs.mkdir(path.dirname(unitFile), { recursive: true });
			await fs.writeFile(unitFile, source);
			await fs.writeFile(projectFile, "source=./src\r\n");
			await vscode.commands.executeCommand("es4a.internal.addProject", projectFile);
			const document = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(unitFile)));
			await vscode.window.showTextDocument(document, { preview: false });
			const position = document.positionAt(document.getText().indexOf("值 = 值") + 4);
			const locations = await vscode.commands.executeCommand<vscode.Location[]>("vscode.executeReferenceProvider", document.uri, position);
			assert.equal(locations.length, 3);
			await assert.rejects(async () => vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", document.uri, position, "变量"), /有效的 Simple 标识符/u);
			const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>("vscode.executeDocumentRenameProvider", document.uri, position, "新值");
			assert.ok(edit);
			assert.equal(await fs.readFile(unitFile, "utf8"), source, "只准备计划不能写入");
			assert.ok(await vscode.workspace.applyEdit(edit));
			const changed = source.replace("A(值", "A(新值").replace("值 = 值 +", "新值 = 新值 +");
			assert.equal(document.getText(), getVisibleSimpleUnitUserCode(changed));
			assert.equal(await fs.readFile(unitFile, "utf8"), source);
			await vscode.commands.executeCommand("undo");
			assert.equal(document.getText(), getVisibleSimpleUnitUserCode(source));
			await vscode.commands.executeCommand("redo");
			assert.equal(document.getText(), getVisibleSimpleUnitUserCode(changed));
			await document.save();
			assert.equal(await fs.readFile(unitFile, "utf8"), changed);
		} finally {
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	test("跨单元字段引用 F2 独立于自动同步开关，拒绝冲突并保留局部同名变量", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-refactor-f2-field-"));
		const projectFile = path.join(directory, "project.properties");
		const ownerFile = path.join(directory, "src", "对象1.simple");
		const callerFile = path.join(directory, "src", "调用者.simple");
		const property = "$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n";
		const ownerSource = "变量 字段 为 整数型\r\n变量 已有 为 整数型\r\n过程 P()\r\n\t字段 = 1\r\n结束 过程\r\n\r\n" + property;
		const callerSource = "过程 P(a 为 对象1)\r\n\t变量 字段 为 整数型\r\n\ta.字段 = 字段\r\n结束 过程\r\n\r\n" + property;
		const configuration = vscode.workspace.getConfiguration("es4a");
		const previous = configuration.inspect<boolean>("automaticSync.variable")?.globalValue;
		try {
			await configuration.update("automaticSync.variable", false, vscode.ConfigurationTarget.Global);
			await fs.mkdir(path.dirname(ownerFile), { recursive: true });
			await fs.writeFile(projectFile, "source=./src\r\n");
			await fs.writeFile(ownerFile, ownerSource); await fs.writeFile(callerFile, callerSource);
			await vscode.commands.executeCommand("es4a.internal.addProject", projectFile);
			const owner = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(ownerFile)));
			const caller = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(callerFile)));
			await vscode.window.showTextDocument(caller, { preview: false });
			const position = caller.positionAt(caller.getText().indexOf("a.字段") + 2);
			await assert.rejects(async () => vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", caller.uri, position, "已有"), /已经存在/u);
			assert.equal(owner.getText(), getVisibleSimpleUnitUserCode(ownerSource));
			const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>("vscode.executeDocumentRenameProvider", caller.uri, position, "新字段");
			assert.ok(edit && await vscode.workspace.applyEdit(edit));
			assert.match(owner.getText(), /变量 新字段 为/u);
			assert.match(owner.getText(), /新字段 = 1/u);
			assert.match(caller.getText(), /a\.新字段 = 字段/u);
			assert.match(caller.getText(), /变量 字段 为/u);
			assert.equal(await fs.readFile(ownerFile, "utf8"), ownerSource);
			assert.equal(await fs.readFile(callerFile, "utf8"), callerSource);
			await vscode.commands.executeCommand("undo");
			assert.equal(owner.getText(), getVisibleSimpleUnitUserCode(ownerSource));
			assert.equal(caller.getText(), getVisibleSimpleUnitUserCode(callerSource));
		} finally {
			await configuration.update("automaticSync.variable", previous, vscode.ConfigurationTarget.Global);
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	test("原生工作区文件夹改名同步引用并整体撤销", async function () {
		this.timeout(30000);
		await vscode.extensions.getExtension("es4a.es4a")!.activate();
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-refactor-native-"));
		const projectFile = path.join(directory, "project.properties");
		const old = path.join(directory, "src", "old");
		const next = path.join(directory, "src", "new");
		const callerFile = path.join(directory, "src", "调用者.simple");
		const source = "变量 a 为 old.对象1\r\n\r\n$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n";
		try {
			await fs.mkdir(old, { recursive: true });
			await fs.writeFile(path.join(old, "对象1.simple"), "$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n");
			await fs.writeFile(callerFile, source);
			await fs.writeFile(projectFile, "source=./src\r\nmain=old.对象1\r\n");
			await vscode.commands.executeCommand("es4a.internal.addProject", projectFile);
			const caller = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(callerFile)));
			await vscode.window.showTextDocument(caller, { preview: false });
			const edit = new vscode.WorkspaceEdit();
			edit.renameFile(vscode.Uri.file(old), vscode.Uri.file(next));
			assert.ok(await vscode.workspace.applyEdit(edit));
			for (let attempt = 0; attempt < 100 && !caller.getText().includes("new.对象1"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
			assert.match(caller.getText(), /new\.对象1/u);
			assert.equal(caller.isDirty, true);
			assert.equal(await fs.readFile(callerFile, "utf8"), source);
			await vscode.commands.executeCommand("undo");
			assert.ok(await fs.stat(old));
			assert.equal(caller.getText(), getVisibleSimpleUnitUserCode(source));
			await vscode.commands.executeCommand("redo");
			assert.ok(await fs.stat(next));
			assert.match(caller.getText(), /new\.对象1/u);
			await caller.save();
			const properties = await vscode.workspace.openTextDocument(vscode.Uri.file(projectFile));
			await properties.save();
			const project = await loadSimpleProject(projectFile);
			await vscode.commands.executeCommand("es4a.renameUnitFolder", { kind: "directory", mode: "units", directoryPath: next, label: "new", project }, "old");
			assert.match(caller.getText(), /old\.对象1/u);
			await vscode.commands.executeCommand("undo");
			assert.ok(await fs.stat(next));
			assert.match(caller.getText(), /new\.对象1/u);
			await vscode.commands.executeCommand("undo");
			assert.ok(await fs.stat(old));
			assert.match(caller.getText(), /old\.对象1/u);
		} finally {
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	test("包目录移动保留关联代码与 main 未保存，纯 XML 关系仍按现有边界持久化，并一起撤销重做", async function () {
		this.timeout(30000);
		const configuration = vscode.workspace.getConfiguration("es4a");
		const previousUnitSync = configuration.inspect<boolean>("automaticSync.unit")?.globalValue;
		await vscode.extensions.getExtension("es4a.es4a")!.activate();
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-refactor-"));
		const projectFile = path.join(directory, "project.properties");
		const oldFolder = path.join(directory, "src", "old");
		const newFolder = path.join(directory, "src", "new");
		const consumerFile = path.join(directory, "src", "app", "消费者.simple");
		const source = "变量 x 为 old.基础\r\n' old.基础 保持\r\n\r\n$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n";
		const xmlOnlyFile = path.join(directory, "src", "app", "派生.simple");
		const xmlOnly = "' 无代码引用\r\n\r\n$属性\r\n\t$资源 $对象\r\n\t基础对象 = old.基础\r\n\t未知字段 = \"保留\"\r\n$结束 $属性\r\n";
		try {
			await configuration.update("automaticSync.unit", false, vscode.ConfigurationTarget.Global);
			await fs.mkdir(oldFolder, { recursive: true });
			await fs.mkdir(path.dirname(consumerFile), { recursive: true });
			await fs.writeFile(path.join(oldFolder, "基础.simple"), "$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n");
			await fs.writeFile(consumerFile, source);
			await fs.writeFile(xmlOnlyFile, xmlOnly);
			await fs.writeFile(projectFile, "main=old.基础\r\nsource=./src\r\n未知字段=保留\r\n");
			await vscode.commands.executeCommand("es4a.internal.addProject", projectFile);
			const project = await loadSimpleProject(projectFile);
			const document = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(consumerFile)));
			await vscode.window.showTextDocument(document, { preview: false });
			await vscode.commands.executeCommand("es4a.renameUnitFolder", { kind: "directory", mode: "units", directoryPath: oldFolder, label: "old", project }, "new");
			assert.equal(await fs.readFile(consumerFile, "utf8"), source);
			assert.match(document.getText(), /变量 x 为 new\.基础/u);
			assert.equal(document.isDirty, true);
			assert.equal(await fs.readFile(xmlOnlyFile, "utf8"), xmlOnly.replace("基础对象 = old.基础", "基础对象 = new.基础"));
			const properties = await vscode.workspace.openTextDocument(vscode.Uri.file(projectFile));
			assert.match(properties.getText(), /main=new.基础/u);
			assert.equal(properties.isDirty, true);
			assert.match(await fs.readFile(projectFile, "utf8"), /main=old.基础/u);
			assert.equal(await fs.stat(oldFolder).then(() => true, () => false), false);
			await vscode.commands.executeCommand("undo");
			assert.equal(document.getText(), getVisibleSimpleUnitUserCode(source));
			assert.equal(await fs.readFile(xmlOnlyFile, "utf8"), xmlOnly);
			assert.ok(await fs.stat(oldFolder));
			await document.save();
			await vscode.commands.executeCommand("redo");
			assert.match(document.getText(), /变量 x 为 new.基础/u);
			assert.equal(await fs.readFile(xmlOnlyFile, "utf8"), xmlOnly.replace("基础对象 = old.基础", "基础对象 = new.基础"));
			assert.ok(await fs.stat(newFolder));
		} finally {
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			await configuration.update("automaticSync.unit", previousUnitSync, vscode.ConfigurationTarget.Global);
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	test("项目树单元改名同步文件、窗口根、调用方和 main，支持撤销重做", async function () {
		this.timeout(30000);
		const configuration = vscode.workspace.getConfiguration("es4a");
		const keys = ["automaticSync.package", "automaticSync.component"];
		const previous = keys.map((key) => configuration.inspect<boolean>(key)?.globalValue);
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-refactor-unit-tree-"));
		const projectFile = path.join(directory, "project.properties");
		const old = path.join(directory, "src", "old", "主窗口.simple");
		const next = path.join(path.dirname(old), "新窗口.simple");
		const callerFile = path.join(directory, "src", "调用者.simple");
		const source = "事件 主窗口.初始化()\r\n结束 事件\r\n\r\n$属性\r\n\t$资源 $窗口\r\n\t$定义 主窗口 $为 窗口\r\n\t$结束 $定义\r\n$结束 $属性\r\n";
		let pathParticipants = 0;
		const pathListener = vscode.workspace.onWillRenameFiles((event) => {
			if (!event.files.some((file) => file.oldUri.scheme === "file" && filePathKey(file.oldUri.fsPath) === filePathKey(old))) return;
			pathParticipants += 1;
			event.waitUntil((async () => {
				assert.equal(await fs.readFile(old, "utf8"), source, "原生参与者确认前，单元代码和属性不得改写");
				assert.match(await fs.readFile(callerFile, "utf8"), /old\.主窗口/u);
				assert.match(await fs.readFile(projectFile, "utf8"), /main=old\.主窗口/u);
				assert.equal(await fs.stat(next).then(() => true, () => false), false);
			})());
		});
		try {
			for (const key of keys) await configuration.update(key, false, vscode.ConfigurationTarget.Global);
			await fs.mkdir(path.dirname(old), { recursive: true });
			await fs.writeFile(old, source);
			await fs.writeFile(callerFile, "变量 a 为 old.主窗口\r\n\r\n$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n");
			await fs.writeFile(projectFile, "source=./src\r\nmain=old.主窗口\r\n");
			await vscode.commands.executeCommand("es4a.internal.addProject", projectFile);
			const caller = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(callerFile)));
			await vscode.window.showTextDocument(caller, { preview: false });
			const project = await loadSimpleProject(projectFile);
			await vscode.commands.executeCommand("es4a.renameUnitFile", { kind: "unit", filePath: old, label: "主窗口", project }, "新窗口");
			assert.equal(pathParticipants, 1, "项目树改名应只发起一次真实路径参与者");
			assert.match(caller.getText(), /old\.新窗口/u);
			assert.equal(caller.isDirty, true);
			assert.match(await fs.readFile(callerFile, "utf8"), /old\.主窗口/u);
			assert.match(await fs.readFile(next, "utf8"), /事件 新窗口\.初始化/u);
			assert.match(await fs.readFile(next, "utf8"), /\$定义 新窗口/u);
			const properties = await vscode.workspace.openTextDocument(vscode.Uri.file(projectFile));
			assert.match(properties.getText(), /main=old\.新窗口/u);
			assert.equal(properties.isDirty, true);
			assert.match(await fs.readFile(projectFile, "utf8"), /main=old\.主窗口/u);
			await vscode.commands.executeCommand("undo");
			for (let attempt = 0; attempt < 100 && !await fs.stat(old).then(() => true, () => false); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
			assert.ok(await fs.stat(old));
			assert.match(caller.getText(), /old\.主窗口/u);
			assert.match(await fs.readFile(old, "utf8"), /\$定义 主窗口/u);
			assert.equal(await fs.readFile(old, "utf8"), source);
			await vscode.window.showTextDocument(caller, { preview: false });
			await vscode.commands.executeCommand("redo");
			for (let attempt = 0; attempt < 100 && !await fs.stat(next).then(() => true, () => false); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
			assert.ok(await fs.stat(next));
			assert.match(caller.getText(), /old\.新窗口/u);
			assert.equal(await fs.readFile(next, "utf8"), source.replaceAll("主窗口", "新窗口"));
		} finally {
			pathListener.dispose();
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			for (const [index, key] of keys.entries()) await configuration.update(key, previous[index], vscode.ConfigurationTarget.Global);
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	for (const native of [false, true]) test(`${native ? "原生" : "项目树"}连续单元改名同步真实服务窗口短引用，不插入别名并整体撤销重做`, async function () {
		this.timeout(30000);
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-refactor-short-unit-"));
		const projectFile = path.join(directory, "project.properties");
		const folder = path.join(directory, "src", "simple", "runtime", "smoketests");
		const callerFile = path.join(folder, "objects", "测试服务.simple");
		const service = await fs.readFile(await simpleTestUnitPath("SmokeTests", "测试服务"), "utf8");
		const callerCode = getVisibleSimpleUnitUserCode(service).split("事件 按钮1.")[0]!.replace(/^别名 主窗口 = simple\.runtime\.smoketests\.主窗口\d*\r?\n\r?\n/gmu, "");
		assert.ok(callerCode.includes("主窗口.成_窗口实例"));
		const callerProperty = "$属性\r\n$资源 $对象\r\n未知字段 = \"原样\"\r\n$结束 $属性\r\n";
		const source = "静态 变量 成_窗口实例 为 窗口\r\n事件 主窗口.初始化()\r\n结束 事件\r\n$属性\r\n\t$资源 $窗口\r\n\t$定义 主窗口 $为 窗口\r\n\t$结束 $定义\r\n$结束 $属性\r\n";
		try {
			await fs.mkdir(path.dirname(callerFile), { recursive: true });
			await fs.writeFile(path.join(folder, "主窗口.simple"), source);
			await fs.writeFile(callerFile, callerCode + callerProperty);
			await fs.writeFile(projectFile, "source=./src\r\nmain=simple.runtime.smoketests.主窗口\r\n");
			await vscode.commands.executeCommand("es4a.internal.addProject", projectFile);
			const caller = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(callerFile)));
			await vscode.window.showTextDocument(caller, { preview: false });
			let previous = "主窗口";
			for (const next of ["主窗口1", "主窗口2"]) {
				const oldFile = path.join(folder, previous + ".simple");
				const newFile = path.join(folder, next + ".simple");
				if (native) {
					const edit = new vscode.WorkspaceEdit(); edit.renameFile(vscode.Uri.file(oldFile), vscode.Uri.file(newFile));
					assert.ok(await vscode.workspace.applyEdit(edit));
				} else {
					await vscode.commands.executeCommand("es4a.renameUnitFile", { kind: "unit", label: previous, filePath: oldFile, project: await loadSimpleProject(projectFile) }, next);
				}
				// 原生操作立即发起第二次改名，不依赖关联文档先保存。
				if (native && next === "主窗口1") { previous = next; continue; }
				const properties = await vscode.workspace.openTextDocument(vscode.Uri.file(projectFile));
				const expectedCode = getVisibleSimpleUnitUserCode(callerCode.replaceAll("主窗口.", next + ".") + callerProperty);
				for (let attempt = 0; attempt < 150 && caller.getText() !== expectedCode; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
				for (let attempt = 0; attempt < 150 && !properties.getText().includes("main=simple.runtime.smoketests." + next + "\r\n"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
				assert.equal(caller.getText(), expectedCode);
				assert.equal(await fs.readFile(callerFile, "utf8"), callerCode + callerProperty);
				assert.equal(await fs.readFile(newFile, "utf8"), source.replaceAll("主窗口", next));
				assert.match(properties.getText(), new RegExp("main=simple\\.runtime\\.smoketests\\." + next, "u"));
				assert.match(await fs.readFile(projectFile, "utf8"), /main=simple\.runtime\.smoketests\.主窗口\r\n/u);
				previous = next;
			}
			await vscode.window.showTextDocument(caller, { preview: false });
			await vscode.commands.executeCommand("undo");
			assert.ok(await fs.stat(path.join(folder, "主窗口1.simple")));
			assert.equal(caller.getText(), getVisibleSimpleUnitUserCode(callerCode.replaceAll("主窗口.", "主窗口1.") + callerProperty));
			await vscode.commands.executeCommand("redo");
			assert.ok(await fs.stat(path.join(folder, "主窗口2.simple")));
			assert.equal(caller.getText(), getVisibleSimpleUnitUserCode(callerCode.replaceAll("主窗口.", "主窗口2.") + callerProperty));
		} finally {
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	test("组件 F2 同步事件、跨单元引用及 XML，保持遮蔽声明并统一撤销重做", async function () {
		this.timeout(30000);
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-no-component-code-rename-"));
		const projectFile = path.join(directory, "project.properties");
		const ownerFile = path.join(directory, "src", "主窗口.simple");
		const callerFile = path.join(directory, "src", "调用者.simple");
		const source = '事件 按钮1.被单击()\r\n\t按钮1.文本 = "按钮1" \' 按钮1 保留\r\n结束 事件\r\n过程 P(按钮1 为 变体型)\r\n\t按钮1.运行时成员()\r\n结束 过程\r\n\r\n$属性\r\n\t$资源 $窗口\r\n\t$定义 主窗口 $为 窗口\r\n\t\t$定义 按钮1 $为 按钮\r\n\t\t\t未知属性 = "原样"\r\n\t\t$结束 $定义\r\n\t\t$定义 按钮2 $为 按钮\r\n\t\t$结束 $定义\r\n\t$结束 $定义\r\n$结束 $属性\r\n';
		const callerSource = '过程 P(a 为 主窗口)\r\n\ta.按钮1.文本 = "调用"\r\n结束 过程\r\n\r\n$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n';
		try {
			await fs.mkdir(path.dirname(ownerFile), { recursive: true });
			await fs.writeFile(ownerFile, source);
			await fs.writeFile(callerFile, callerSource);
			await fs.writeFile(projectFile, "source=./src\r\nmain=主窗口\r\n");
			await vscode.commands.executeCommand("es4a.internal.addProject", projectFile);
			const owner = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(ownerFile)));
			const caller = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(callerFile)));
			await vscode.window.showTextDocument(owner, { preview: false });
			const renamePosition = owner.positionAt(owner.getText().indexOf("按钮1"));
			// 同窗口重复、非法名称及代码声明冲突均应在返回计划前拒绝，不能留下半次修改。
			for (const { name, message } of [
				{ name: "按钮2", message: /已经存在/u },
				{ name: "错误 名称", message: /组件名称必须/u },
				{ name: "P", message: /已经声明标识符/u }
			]) {
				await assert.rejects(async () => vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", owner.uri, renamePosition, name), message);
				assert.equal(owner.getText(), getVisibleSimpleUnitUserCode(source));
				assert.equal(await fs.readFile(ownerFile, "utf8"), source);
			}
			const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>("vscode.executeDocumentRenameProvider", caller.uri, caller.positionAt(caller.getText().indexOf("按钮1")), "演示按钮");
			assert.ok(edit && edit.size > 0);
			assert.equal(owner.getText(), getVisibleSimpleUnitUserCode(source));
			assert.equal(await fs.readFile(ownerFile, "utf8"), source);
			assert.equal(await vscode.workspace.applyEdit(edit), true);
			assert.match(owner.getText(), /事件 演示按钮\.被单击/u);
			assert.match(owner.getText(), /演示按钮\.文本 = "按钮1" ' 按钮1 保留/u);
			assert.match(owner.getText(), /过程 P\(按钮1 为 变体型\)/u);
			assert.match(owner.getText(), /按钮1\.运行时成员/u);
			assert.match(caller.getText(), /a\.演示按钮\.文本/u);
			const changed = await fs.readFile(ownerFile, "utf8");
			assert.equal(splitSimpleUnitSource(changed).userCode, splitSimpleUnitSource(source).userCode);
			assert.match(changed, /\$定义 演示按钮 \$为 按钮/u);
			assert.match(changed, /未知属性 = "原样"/u);
			assert.equal(await fs.readFile(callerFile, "utf8"), callerSource);
			await vscode.commands.executeCommand("undo");
			assert.equal(owner.getText(), getVisibleSimpleUnitUserCode(source));
			assert.equal(caller.getText(), getVisibleSimpleUnitUserCode(callerSource));
			assert.equal(await fs.readFile(ownerFile, "utf8"), source);
			// 撤销后只准备另一份预览，不执行它，原事务仍须可以重做。
			const preview = await vscode.commands.executeCommand<vscode.WorkspaceEdit>("vscode.executeDocumentRenameProvider", owner.uri, renamePosition, "取消预览按钮");
			assert.ok(preview && preview.size > 0);
			assert.equal(await fs.readFile(ownerFile, "utf8"), source);
			await vscode.commands.executeCommand("redo");
			assert.match(owner.getText(), /事件 演示按钮\.被单击/u);
			assert.match(caller.getText(), /a\.演示按钮\.文本/u);
			await owner.save();
			await caller.save();
			assert.match(await fs.readFile(ownerFile, "utf8"), /事件 演示按钮\.被单击/u);
			assert.equal(splitSimpleUnitSource(await fs.readFile(callerFile, "utf8")).propertySource, splitSimpleUnitSource(callerSource).propertySource);
		} finally {
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	test("组件 F2 预览期间关联代码变化时拒绝过期 XML 写入", async function () {
		this.timeout(30000);
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-component-f2-stale-"));
		const projectFile = path.join(directory, "project.properties");
		const ownerFile = path.join(directory, "src", "主窗口.simple");
		const callerFile = path.join(directory, "src", "调用者.simple");
		const source = '事件 按钮1.被单击()\r\n结束 事件\r\n$属性\r\n$资源 $窗口\r\n$定义 主窗口 $为 窗口\r\n\t$定义 按钮1 $为 按钮\r\n\t$结束 $定义\r\n$结束 $定义\r\n$结束 $属性\r\n';
		const callerSource = '过程 P(a 为 主窗口)\r\n\ta.按钮1.文本 = "演示"\r\n结束 过程\r\n$属性\r\n$资源 $对象\r\n$结束 $属性\r\n';
		try {
			await fs.mkdir(path.dirname(ownerFile), { recursive: true });
			await fs.writeFile(ownerFile, source);
			await fs.writeFile(callerFile, callerSource);
			await fs.writeFile(projectFile, "source=./src\r\nmain=主窗口\r\n");
			await vscode.commands.executeCommand("es4a.internal.addProject", projectFile);
			const owner = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(ownerFile)));
			const caller = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(callerFile)));
			const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>("vscode.executeDocumentRenameProvider", owner.uri, owner.positionAt(owner.getText().indexOf("按钮1")), "新按钮");
			assert.ok(edit);
			const editor = await vscode.window.showTextDocument(caller, { preview: false });
			await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), "' 预览期间新增\r\n"));
			const current = caller.getText();
			assert.equal(await vscode.workspace.applyEdit(edit), false);
			assert.equal(caller.getText(), current);
			assert.equal(owner.getText(), getVisibleSimpleUnitUserCode(source));
			assert.equal(await fs.readFile(ownerFile, "utf8"), source);
			assert.equal(await fs.readFile(callerFile, "utf8"), callerSource);
		} finally {
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	test("关闭组件自动同步仍可 F2 显式改名，只有跨单元引用时也同步 XML", async function () {
		this.timeout(30000);
		const configuration = vscode.workspace.getConfiguration("es4a");
		const previous = configuration.inspect<boolean>("automaticSync.component")?.globalValue;
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-component-f2-cross-unit-"));
		const projectFile = path.join(directory, "project.properties");
		const ownerFile = path.join(directory, "src", "主窗口.simple");
		const callerFile = path.join(directory, "src", "调用者.simple");
		const source = '$属性\r\n\t$资源 $窗口\r\n\t$定义 主窗口 $为 窗口\r\n\t\t$定义 按钮1 $为 按钮\r\n\t\t$结束 $定义\r\n\t\t$定义 按钮2 $为 按钮\r\n\t\t\t位于左边 = 按钮1.标识\r\n\t\t$结束 $定义\r\n\t$结束 $定义\r\n$结束 $属性\r\n';
		const callerSource = '过程 P(a 为 主窗口)\r\n\ta.按钮1.文本 = "演示"\r\n结束 过程\r\n\r\n$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n';
		try {
			await configuration.update("automaticSync.component", false, vscode.ConfigurationTarget.Global);
			await fs.mkdir(path.dirname(ownerFile), { recursive: true });
			await fs.writeFile(ownerFile, source);
			await fs.writeFile(callerFile, callerSource);
			await fs.writeFile(projectFile, "source=./src\r\nmain=主窗口\r\n");
			await vscode.commands.executeCommand("es4a.internal.addProject", projectFile);
			const caller = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(callerFile)));
			await vscode.window.showTextDocument(caller, { preview: false });
			const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>("vscode.executeDocumentRenameProvider", caller.uri, caller.positionAt(caller.getText().indexOf("按钮1")), "演示按钮");
			assert.ok(edit);
			assert.equal(await fs.readFile(ownerFile, "utf8"), source);
			assert.ok(await vscode.workspace.applyEdit(edit));
			assert.match(caller.getText(), /a\.演示按钮\.文本/u);
			assert.equal(await fs.readFile(ownerFile, "utf8"), source.replaceAll("按钮1", "演示按钮"));
			assert.equal(await fs.readFile(callerFile, "utf8"), callerSource);
			assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), caller.uri.toString());
			await vscode.commands.executeCommand("undo");
			assert.equal(await fs.readFile(ownerFile, "utf8"), source);
			assert.equal(caller.getText(), getVisibleSimpleUnitUserCode(callerSource));
			await vscode.commands.executeCommand("redo");
			assert.match((await fs.readFile(ownerFile, "utf8")), /位于左边 = 演示按钮\.标识/u);
			await caller.save();
			assert.equal(splitSimpleUnitSource(await fs.readFile(callerFile, "utf8")).propertySource, splitSimpleUnitSource(callerSource).propertySource);
		} finally {
			await configuration.update("automaticSync.component", previous, vscode.ConfigurationTarget.Global);
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	test("资产文件夹移动同步 SDK 资产属性，删除及恢复触发诊断", async function () {
		this.timeout(30000);
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-refactor-assets-"));
		const projectFile = path.join(directory, "project.properties");
		const old = path.join(directory, "assets", "images");
		const destination = path.join(directory, "assets", "pictures");
		const unitFile = path.join(directory, "src", "主窗口.simple");
		try {
			await fs.mkdir(old, { recursive: true });
			await fs.mkdir(path.dirname(unitFile), { recursive: true });
			await fs.writeFile(path.join(old, "icon.png"), new Uint8Array([0]));
			await fs.writeFile(unitFile, '事件 主窗口.初始化()\r\n\t图片框1.图片 = "images/icon.png"\r\n结束 事件\r\n\r\n$属性\r\n\t$资源 $窗口\r\n\t$定义 主窗口 $为 窗口\r\n\t\t$定义 图片框1 $为 图片框\r\n\t\t\t图片 = "images/icon.png"\r\n\t\t$结束 $定义\r\n\t$结束 $定义\r\n$结束 $属性\r\n');
			await fs.writeFile(projectFile, "source=./src\r\nmain=主窗口\r\n");
			await vscode.commands.executeCommand("es4a.internal.addProject", projectFile);
			const project = await loadSimpleProject(projectFile);
			const code = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(unitFile)));
			await vscode.window.showTextDocument(code, { preview: false });
			await vscode.commands.executeCommand("es4a.renameUnitFolder", { kind: "directory", mode: "resources", directoryPath: old, label: "images", project, resourceRoot: "assets" }, "pictures");
			assert.match(await fs.readFile(unitFile, "utf8"), /pictures\/icon.png/u);
			assert.match(code.getText(), /pictures\/icon.png/u);
			assert.equal(code.isDirty, true);
			assert.match(getVisibleSimpleUnitUserCode(await fs.readFile(unitFile, "utf8")), /images\/icon.png/u);
			await fs.unlink(path.join(destination, "icon.png"));
			await vscode.commands.executeCommand("es4a.refreshPrograms");
			for (let attempt = 0; attempt < 200 && !vscode.languages.getDiagnostics(code.uri).some((issue) => issue.code === "unknownAsset"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
			assert.ok(vscode.languages.getDiagnostics(code.uri).some((issue) => issue.code === "unknownAsset"));
			await fs.writeFile(path.join(destination, "icon.png"), new Uint8Array([0]));
			await vscode.commands.executeCommand("es4a.refreshPrograms");
			for (let attempt = 0; attempt < 200 && vscode.languages.getDiagnostics(code.uri).some((issue) => issue.code === "unknownAsset"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
			assert.ok(!vscode.languages.getDiagnostics(code.uri).some((issue) => issue.code === "unknownAsset"));
		} finally {
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});


	test("包目录拖放以未保存关联代码为基线重构，保留用户输入并等待保存", async function () {
		this.timeout(30000);
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-refactor-folder-drag-"));
		const projectFile = path.join(directory, "project.properties");
		const old = path.join(directory, "src", "old");
		const target = path.join(directory, "src", "new");
		const callerFile = path.join(directory, "src", "调用者.simple");
		try {
			await fs.mkdir(old, { recursive: true });
			await fs.mkdir(target, { recursive: true });
			await fs.writeFile(path.join(old, "目标.simple"), "$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n");
			await fs.writeFile(callerFile, "变量 a 为 old.目标\r\n\r\n$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n");
			await fs.writeFile(projectFile, "source=./src\r\nmain=old.目标\r\n");
			await vscode.commands.executeCommand("es4a.internal.addProject", projectFile);
			const project = await loadSimpleProject(projectFile);
			const caller = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(callerFile)));
			const editor = await vscode.window.showTextDocument(caller, { preview: false });
			await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), "' 保留未保存修改\r\n"));
			const sourceNode = { kind: "directory", mode: "units", directoryPath: old, label: "old", project };
			const targetNode = { kind: "directory", mode: "units", directoryPath: target, label: "new", project };
			await vscode.commands.executeCommand("es4a.internal.moveProjectPath", sourceNode, targetNode);
			assert.ok(await fs.stat(path.join(target, "old", "目标.simple")));
			assert.match(caller.getText(), /new\.old\.目标/u);
			assert.match(caller.getText(), /保留未保存修改/u);
			assert.equal(caller.isDirty, true);
			assert.match(await fs.readFile(callerFile, "utf8"), /old\.目标/u);
			assert.doesNotMatch(await fs.readFile(callerFile, "utf8"), /保留未保存修改/u);
			const properties = await vscode.workspace.openTextDocument(vscode.Uri.file(projectFile));
			assert.match(properties.getText(), /main=new\.old\.目标/u);
			assert.match(await fs.readFile(projectFile, "utf8"), /main=old\.目标/u);
			await vscode.commands.executeCommand("undo");
			assert.ok(await fs.stat(old));
			assert.match(caller.getText(), /old\.目标/u);
			assert.match(caller.getText(), /保留未保存修改/u);
		} finally {
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});


	test("原生批量改名单元共享引用及 main 事务，整体撤销", async function () {
		this.timeout(30000);
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-refactor-batch-"));
		const projectFile = path.join(directory, "project.properties");
		const folder = path.join(directory, "src", "pkg");
		const callerFile = path.join(directory, "src", "调用者.simple");
		try {
			await fs.mkdir(folder, { recursive: true });
			await fs.writeFile(projectFile, "source=./src\r\nmain=pkg.甲\r\n");
			for (const name of ["甲", "乙"]) await fs.writeFile(path.join(folder, name + ".simple"), "$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n");
			await fs.writeFile(callerFile, "变量 a 为 pkg.甲\r\n变量 b 为 pkg.乙\r\n\r\n$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n");
			await vscode.commands.executeCommand("es4a.internal.addProject", projectFile);
			const caller = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(callerFile)));
			await vscode.window.showTextDocument(caller, { preview: false });
			const edit = new vscode.WorkspaceEdit();
			for (const name of ["甲", "乙"]) edit.renameFile(vscode.Uri.file(path.join(folder, name + ".simple")), vscode.Uri.file(path.join(folder, "新" + name + ".simple")));
			assert.ok(await vscode.workspace.applyEdit(edit));
			const properties = await vscode.workspace.openTextDocument(vscode.Uri.file(projectFile));
			for (let attempt = 0; attempt < 150 && !properties.getText().includes("main=pkg.新甲"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
			assert.match(caller.getText(), /pkg\.新甲/u);
			assert.match(caller.getText(), /pkg\.新乙/u);
			assert.match(properties.getText(), /main=pkg\.新甲/u);
			assert.equal(caller.isDirty, true);
			assert.equal(properties.isDirty, true);
			assert.match(await fs.readFile(callerFile, "utf8"), /pkg\.甲/u);
			assert.match(await fs.readFile(projectFile, "utf8"), /main=pkg\.甲/u);
			await vscode.commands.executeCommand("undo");
			for (const name of ["甲", "乙"]) assert.ok(await fs.stat(path.join(folder, name + ".simple")));
			assert.match(caller.getText(), /pkg\.甲/u);
			assert.match(caller.getText(), /pkg\.乙/u);
		} finally {
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});


	for (const synchronize of [true, false]) test(`设计器组件改名${synchronize ? "同步跨单元引用" : "关闭同步只改 XML 名称"}，撤销重做及保存保持对应边界`, async function () {
		this.timeout(30000);
		const configuration = vscode.workspace.getConfiguration("es4a");
		const key = "automaticSync.component";
		const previous = configuration.inspect<boolean>(key)?.globalValue;
		await configuration.update(key, synchronize, vscode.ConfigurationTarget.Global);
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-refactor-designer-"));
		const sourceFile = path.join(directory, "主窗口.simple");
		const callerFile = path.join(directory, "调用者.simple");
		const source = '事件 按钮1.被单击()\r\n\t按钮1.文本 = "演示"\r\n结束 事件\r\n\r\n$属性\r\n\t$资源 $窗口\r\n\t$定义 主窗口 $为 窗口\r\n\t\t$定义 按钮1 $为 按钮\r\n\t\t$结束 $定义\r\n\t\t$定义 按钮2 $为 按钮\r\n\t\t\t位于左边 = 按钮1.标识\r\n\t\t$结束 $定义\r\n\t$结束 $定义\r\n$结束 $属性\r\n';
		const callerSource = '过程 P(a 为 主窗口)\r\n\ta.按钮1.文本 = "引用"\r\n结束 过程\r\n\r\n$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n';
		const codeDocuments = new SimpleCodeFileSystemProvider();
		const messages = new vscode.EventEmitter<unknown>();
		const disposed = new vscode.EventEmitter<void>();
		const viewStates = new vscode.EventEmitter<vscode.WebviewPanelOnDidChangeViewStateEvent>();
		const events: vscode.CustomDocumentEditEvent<SimpleDesignerDocument>[] = [];
		let render: DesignerWebviewRenderMessage | undefined;
		let html = "";
		const webview = {
			asWebviewUri: (uri: vscode.Uri) => uri, cspSource: "vscode-webview://component-refactor-test",
			get html() { return html; }, set html(value: string) { html = value; }, options: {}, onDidReceiveMessage: messages.event,
			postMessage: (message: DesignerWebviewRenderMessage) => { render = message; return Promise.resolve(true); }
		} as unknown as vscode.Webview;
		const panel = { active: true, visible: true, viewColumn: vscode.ViewColumn.One, webview, onDidChangeViewState: viewStates.event, onDidDispose: disposed.event } as unknown as vscode.WebviewPanel;
		const sdk = await loadSdk(path.resolve(__dirname, "../../../../sdk/sdk.json"));
		let planCalls = 0;
		const provider = new SimpleDesignerProvider(codeDocuments, vscode.extensions.getExtension("es4a.es4a")!.extensionUri, {
			getDocument: () => ({}), updateColumnOrder: async () => undefined, updateDisplayOption: async () => undefined, moveDocument: async () => undefined, deleteDocument: async () => undefined
		}, undefined, async (_document, componentPath, name) => {
			planCalls += 1;
			const units = await Promise.all([sourceFile, callerFile].map((file) => codeDocuments.readRefactoringUnit(vscode.Uri.file(file), directory)));
			return planSimpleComponentProjectRename(units, units[0]!, componentPath, name, sdk);
		});
		const listener = provider.onDidChangeCustomDocument((event) => events.push(event));
		let designer: SimpleDesignerDocument | undefined;
		try {
			await fs.writeFile(sourceFile, source);
			await fs.writeFile(callerFile, callerSource);
			const sourceUri = vscode.Uri.file(sourceFile);
			await codeDocuments.readFile(toSimpleCodeUri(sourceUri));
			designer = await provider.openCustomDocument(toSimpleDesignerUri(sourceUri), { backupId: undefined, untitledDocumentData: undefined }, new vscode.CancellationTokenSource().token);
			provider.updateSdk(sdk);
			provider.resolveCustomEditor(designer, panel);
			messages.fire({ type: "ready" });
			assert.ok(render);
			const componentPath = render.projection.root?.children[0]?.path;
			assert.ok(componentPath);
			messages.fire({ type: "selectNode", contextToken: render.contextToken, renderVersion: render.renderVersion, componentName: "按钮1", xmlPath: componentPath });
			const caller = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(callerFile)));
			await vscode.window.showTextDocument(caller, { preview: false });
			messages.fire({ type: "updateXmlValue", contextToken: render.contextToken, renderVersion: render.renderVersion, selectedComponentName: "按钮1", selectedXmlPath: componentPath, xmlPath: componentPath + "/@名称", effect: "renameComponent", removeElementWhenEmpty: false, value: "演示按钮" });
			for (let attempt = 0; attempt < 200 && events.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal(events.length, 1);
			const owner = await designer.getCodeDocument();
			assert.equal(planCalls, synchronize ? 1 : 0);
			assert.equal(owner.getText(), getVisibleSimpleUnitUserCode(synchronize ? source.replaceAll("按钮1", "演示按钮") : source));
			assert.equal(caller.getText(), getVisibleSimpleUnitUserCode(synchronize ? callerSource.replaceAll("按钮1", "演示按钮") : callerSource));
			assert.equal(await fs.readFile(sourceFile, "utf8"), source);
			assert.equal(await fs.readFile(callerFile, "utf8"), callerSource);
			assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), caller.uri.toString());
			await events[0]!.undo();
			assert.equal(owner.getText(), getVisibleSimpleUnitUserCode(source));
			assert.equal(caller.getText(), getVisibleSimpleUnitUserCode(callerSource));
			assert.match(serializePropertyXml(codeDocuments.getProperty(owner)!.document!), /名称="按钮1"/u);
			await events[0]!.redo();
			assert.equal(owner.getText(), getVisibleSimpleUnitUserCode(synchronize ? source.replaceAll("按钮1", "演示按钮") : source));
			assert.equal(caller.getText(), getVisibleSimpleUnitUserCode(synchronize ? callerSource.replaceAll("按钮1", "演示按钮") : callerSource));
			const snapshot = await codeDocuments.readRefactoringUnit(sourceUri, directory);
			assert.match(serializePropertyXml(snapshot.property.document!), /名称="演示按钮"/u);
			await provider.saveCustomDocument(designer, new vscode.CancellationTokenSource().token);
			const saved = await fs.readFile(sourceFile, "utf8");
			const expectedPropertySave = source.replace("$定义 按钮1 $为", "$定义 演示按钮 $为")
				.replace("位于左边 = 按钮1.标识", synchronize ? "位于左边 = 演示按钮.标识" : "位于左边 = 按钮1.标识");
			assert.equal(saved, expectedPropertySave);
			assert.ok(await owner.save());
			assert.equal(await fs.readFile(sourceFile, "utf8"), synchronize ? source.replaceAll("按钮1", "演示按钮") : saved);
			assert.equal(await fs.readFile(callerFile, "utf8"), callerSource);
		} finally {
			listener.dispose(); designer?.dispose(); provider.dispose(); codeDocuments.dispose(); messages.dispose(); disposed.dispose(); viewStates.dispose();
			await configuration.update(key, previous, vscode.ConfigurationTarget.Global);
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});


	test("相对限定名在真实宿主提供补全、完整悬停及定义，目录改名同步后整体撤销", async function () {
		this.timeout(30000);
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-refactor-relative-"));
		const sourceRoot = path.join(directory, "src");
		const packageRoot = path.join(sourceRoot, "simple", "runtime", "smoketests");
		const oldFolder = path.join(packageRoot, "components");
		const nextFolder = path.join(packageRoot, "controls");
		const targetFile = path.join(oldFolder, "计时器.simple");
		const callerFile = path.join(packageRoot, "调用者.simple");
		const projectFile = path.join(directory, "project.properties");
		const properties = "$属性\r\n$资源 $对象\r\n$结束 $属性\r\n";
		const code = "变量 a 为 smoketests.components.计时器\r\n过程 P()\r\n\t显示提示框(取对象类名(smoketests.components.计时器.实例))\r\n结束 过程\r\n' smoketests.components.计时器 保持\r\n";
		try {
			await fs.mkdir(oldFolder, { recursive: true });
			await fs.writeFile(targetFile, "静态 变量 实例 为 窗口\r\n" + properties);
			await fs.writeFile(callerFile, code + properties);
			await fs.writeFile(projectFile, "main=simple.runtime.smoketests.调用者\r\nsource=./src\r\n");
			await vscode.commands.executeCommand("es4a.internal.addProject", projectFile);
			const document = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(callerFile)));
			const editor = await vscode.window.showTextDocument(document, { preview: false });
			const position = document.positionAt(code.indexOf("计时器"));
			// 项目添加只触发后台索引，等待实际语言结果，避免把索引尚未完成当成解析失败。
			let hover: readonly vscode.Hover[] = [];
			for (let attempt = 0; attempt < 100 && hover.length === 0; attempt += 1) {
				hover = await vscode.commands.executeCommand<readonly vscode.Hover[]>("vscode.executeHoverProvider", document.uri, position);
				if (hover.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
			}
			assert.ok(hover.length > 0);
			assert.ok(hover.some((item) => item.contents.some((content) => typeof content !== "string" && content.value.includes("对象 simple.runtime.smoketests.components.计时器"))));
			editor.selection = new vscode.Selection(position, position);
			// ES4A 的 F12 使用自身导航命令，同时支持源码和类库树目标。
			await vscode.commands.executeCommand("es4a.goToDefinition");
			assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), toSimpleCodeUri(vscode.Uri.file(targetFile)).toString());
			await vscode.window.showTextDocument(document, { preview: false });
			const completions = await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", document.uri, document.positionAt(code.indexOf("计时器") + 1));
			assert.ok(completions.items.some((item) => (typeof item.label === "string" ? item.label : item.label.label).endsWith("计时器")));
			for (let attempt = 0; attempt < 100 && vscode.languages.getDiagnostics(document.uri).some((issue) => issue.source === "ES4A 引用分析"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
			assert.equal(vscode.languages.getDiagnostics(document.uri).some((issue) => issue.source === "ES4A 引用分析" && issue.message.includes("smoketests")), false);
			const project = await loadSimpleProject(projectFile);
			await vscode.commands.executeCommand("es4a.renameUnitFolder", { kind: "directory", mode: "units", directoryPath: oldFolder, label: "components", project }, "controls");
			const expected = code.replace("变量 a 为 smoketests.components", "变量 a 为 smoketests.controls").replace("取对象类名(smoketests.components", "取对象类名(smoketests.controls");
			assert.equal(document.getText(), getVisibleSimpleUnitUserCode(expected + properties));
			assert.equal(document.isDirty, true);
			assert.equal(await fs.readFile(callerFile, "utf8"), code + properties);
			await vscode.window.showTextDocument(document, { preview: false });
			await vscode.commands.executeCommand("undo");
			assert.ok(await fs.stat(oldFolder));
			assert.equal(document.getText(), getVisibleSimpleUnitUserCode(code + properties));
			await document.save();
			assert.equal(await fs.readFile(callerFile, "utf8"), code + properties);
			assert.equal(await fs.stat(nextFolder).then(() => true, () => false), false);
		} finally {
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	test("输入只诊断变更单元，大单元诊断期间悬停仍能响应", async function () {
		this.timeout(30000);
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-refactor-diagnostic-input-"));
		const sourceRoot = path.join(directory, "src");
		const first = path.join(sourceRoot, "大单元.simple");
		const second = path.join(sourceRoot, "其它单元.simple");
		const sdk = await loadSdk(path.resolve(__dirname, "../../../../sdk/sdk.json"));
		const original = await fs.readFile(await simpleTestUnitPath("SmokeTest", "ArrayExpressionsTest"), "utf8");
		const code = '显示提示框("演示")\r\n' + splitSimpleUnitSource(original).userCode;
		const property = inspectSimplePropertyXml("$属性\r\n$资源 $对象\r\n$结束 $属性\r\n");
		const units: RefactoringUnit[] = [
			{ filePath: first, sourceRoot, userCode: code, property },
			{ filePath: second, sourceRoot, userCode: "未声明其它值 = 1\r\n", property }
		];
		const documents = new SimpleCodeFileSystemProvider();
		let diagnostics: SimpleDiagnosticProvider | undefined;
		const analyzed: string[] = [];
		const errors: string[] = [];
		let hover: Promise<readonly vscode.Hover[]> | undefined;
		let hoverDuration = 0;
		try {
			await fs.mkdir(sourceRoot);
			const properties = path.join(directory, "project.properties");
			await fs.writeFile(properties, "main=大单元\r\nname=诊断体验\r\n");
			for (const unit of units) await fs.writeFile(unit.filePath, unit.userCode + "$属性\r\n$资源 $对象\r\n$结束 $属性\r\n");
			const project = await loadSimpleProject(properties);
			assert.ok(project);
			const target = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(first)));
			await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(second)));
			await vscode.window.showTextDocument(target, { preview: false });
			for (const unit of units) await documents.readFile(toSimpleCodeUri(vscode.Uri.file(unit.filePath)));
			diagnostics = new SimpleDiagnosticProvider(
				{ getProjects: async () => [project] } as unknown as ProgramTreeProvider,
				{ isBusy: false, readProject: async () => { throw new Error("输入不应读取整个项目"); } } as unknown as SimpleProjectRefactoring,
				documents, {} as ProjectSymbolIndex, () => sdk,
				(document) => {
					analyzed.push(document.uri.fsPath);
					const start = performance.now();
					hover = Promise.resolve(vscode.commands.executeCommand<readonly vscode.Hover[]>("vscode.executeHoverProvider", target.uri, new vscode.Position(0, 2))).then((value) => { hoverDuration = performance.now() - start; return value; });
					return refactoringContext(units[0]!, units);
				},
				(message) => errors.push(message)
			);
			diagnostics.schedule(false, target.uri);
			for (let attempt = 0; attempt < 200 && hover === undefined; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
			assert.ok(hover, "应执行指定单元诊断");
			assert.ok((await hover).length > 0, "悬停应返回实际 SDK 说明");
			assert.ok(hoverDuration < 1000, `悬停不应被大单元诊断长时间阻塞：${hoverDuration}ms`);
			assert.deepEqual(analyzed, [target.uri.fsPath]);
			assert.deepEqual(errors, []);
		} finally {
			diagnostics?.dispose(); documents.dispose();
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

});
