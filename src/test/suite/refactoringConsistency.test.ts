/*
验证异步重构查询的版本边界、失败后的标签恢复与多项目诊断隔离。
xhwsd@qq.com 2026-10-12
*/

import { testSdkPath } from "../testFixtures";

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { SimpleDiagnosticProvider } from "../../diagnosticProvider";
import { SimpleRenameProvider } from "../../renameProvider";
import { SimpleReferenceProvider } from "../../referenceProvider";
import { SimpleProjectRefactoring } from "../../projectRefactoring";
import { SimpleCodeFileSystemProvider, SIMPLE_CODE_SCHEME, toSimpleCodeUri, toSimpleDesignerUri } from "../../simpleCodeFileSystem";
import { loadSimpleProject } from "../../programResources";
import { loadSdk } from "../../sdk";
import type { SimpleProjectInfo } from "../../project";
import type { ProgramTreeProvider } from "../../programTree";
import type { ProjectSymbolIndex } from "../../projectSymbolIndex";
import { toUnitXmlPreviewUri } from "../../unitPreview";
import { WorkbenchDriver } from "./workbenchDriver";

const property = "$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n";

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
	assert.ok(predicate(), "等待宿主状态更新超时");
}

async function withProject(action: (value: {
	readonly directory: string;
	readonly project: SimpleProjectInfo;
	readonly ownerFile: string;
	readonly callerFile: string;
	readonly owner: vscode.TextDocument;
	readonly caller: vscode.TextDocument;
	readonly documents: SimpleCodeFileSystemProvider;
	readonly refactoring: SimpleProjectRefactoring;
}) => Promise<void>, nestedOwner = false): Promise<void> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-refactor-consistency-"));
	const projectFile = path.join(directory, "project.properties");
	const ownerFile = path.join(directory, "src", ...(nestedOwner ? ["pkg"] : []), "对象1.simple");
	const callerFile = path.join(directory, "src", "调用者.simple");
	const documents = new SimpleCodeFileSystemProvider();
	const refactoring = new SimpleProjectRefactoring({ codeDocuments: documents, refreshProjectSemantics: async () => {} });
	try {
		await fs.mkdir(path.dirname(ownerFile), { recursive: true });
		await fs.writeFile(projectFile, "source=./src\r\n");
		await fs.writeFile(ownerFile, "静态 变量 字段 为 整数型\r\n过程 P()\r\n\t字段 = 字段 + 1\r\n结束 过程\r\n" + property);
		const qualifier = nestedOwner ? "pkg.对象1" : "对象1";
		await fs.writeFile(callerFile, `过程 P()\r\n\t${qualifier}.字段 = ${qualifier}.字段 + 1\r\n结束 过程\r\n` + property);
		const project = await loadSimpleProject(projectFile);
		const owner = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(ownerFile)));
		const caller = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(callerFile)));
		await vscode.window.showTextDocument(caller, { preview: false });
		await action({ directory, project, ownerFile, callerFile, owner, caller, documents, refactoring });
	} finally {
		for (const document of vscode.workspace.textDocuments) if (!document.isClosed && document.isDirty && document.uri.fsPath.startsWith(directory + path.sep)) await document.save();
		refactoring.dispose(); documents.dispose();
		await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}

suite("重构异步一致性", () => {
	suiteSetup(async () => { await vscode.extensions.getExtension("es4a.es4a")!.activate(); });

	for (const kind of ["成功", "路径冲突", "刷新失败", "路径及刷新都失败"] as const) test(`重构${kind}时，忙碌和完成事件覆盖实际语义刷新，错误不被后续刷新掩盖`, async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-refactor-refresh-"));
		const oldFile = path.join(directory, "old.txt");
		const newFile = path.join(directory, "new.txt");
		let started!: () => void;
		let release!: () => void;
		const start = new Promise<void>((resolve) => { started = resolve; });
		const barrier = new Promise<void>((resolve) => { release = resolve; });
		const documents = new SimpleCodeFileSystemProvider();
		let refreshes = 0;
		let completed = 0;
		const refactoring = new SimpleProjectRefactoring({ codeDocuments: documents, refreshProjectSemantics: async () => {
			refreshes += 1;
			started();
			await barrier;
			if (kind.includes("刷新")) throw new Error("模拟语义刷新失败");
		} });
		const subscription = refactoring.onDidComplete(() => { completed += 1; assert.equal(refactoring.isBusy, false); });
		try {
			await fs.writeFile(oldFile, "原文件");
			if (kind.includes("路径")) await fs.writeFile(newFile, "保留目标");
			const operation = refactoring.renameStandalonePath(oldFile, newFile, "resources").then(() => undefined, (error: unknown) => error);
			await start;
			assert.equal(refactoring.isBusy, true);
			assert.equal(completed, 0);
			let idle = false;
			const waiting = refactoring.waitForIdle().then(() => { idle = true; });
			await Promise.resolve();
			assert.equal(idle, false);
			release();
			const error = await operation;
			await waiting;
			assert.equal(refactoring.isBusy, false);
			assert.equal(completed, 1);
			assert.equal(refreshes, 1);
			if (kind === "成功") assert.equal(error, undefined);
			else assert.match(String(error), kind.includes("路径") ? /目标路径已经存在/u : /模拟语义刷新失败/u);
			if (kind.includes("路径")) {
				assert.equal(await fs.readFile(oldFile, "utf8"), "原文件");
				assert.equal(await fs.readFile(newFile, "utf8"), "保留目标");
			} else assert.equal(await fs.readFile(newFile, "utf8"), "原文件");
		} finally {
			release();
			subscription.dispose(); refactoring.dispose(); documents.dispose();
			assert.equal(path.dirname(directory), os.tmpdir());
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	test("文件 URI 与 fsPath 的盘符形式映射为同一代码和设计器 URI，不创建第二个代码模型", async () => {
		await withProject(async ({ owner, ownerFile }) => {
			const source = vscode.Uri.file(ownerFile);
			const canonical = vscode.Uri.file(source.fsPath);
			assert.equal(toSimpleCodeUri(source).toString(), toSimpleCodeUri(canonical).toString());
			assert.equal(toSimpleDesignerUri(source).toString(), toSimpleDesignerUri(canonical).toString());
			assert.equal(await vscode.workspace.openTextDocument(toSimpleCodeUri(source)), owner);
			assert.equal(await vscode.workspace.openTextDocument(toSimpleCodeUri(canonical)), owner);
		});
	});

	for (const folder of [false, true]) test(`${folder ? "目录" : "单元"}虚拟迁移与真实路径撤销重做配合，XML 会话保持同一对象`, async () => {
		await withProject(async ({ owner, ownerFile, directory, documents }) => {
			const oldPath = folder ? path.dirname(ownerFile) : ownerFile;
			const newPath = path.join(directory, "src", folder ? "new" : "新对象.simple");
			const oldSource = vscode.Uri.file(oldPath);
			const newSource = vscode.Uri.file(newPath);
			const oldCode = toSimpleCodeUri(vscode.Uri.file(ownerFile));
			const newFile = folder ? path.join(newPath, path.basename(ownerFile)) : newPath;
			const newCode = toSimpleCodeUri(vscode.Uri.file(newFile));
			const before = await documents.readFile(oldCode);
			const xml = documents.getProperty(owner)!.document;
			const registration = documents.allowUnitRename(oldSource, newSource, true);
			try {
				await documents.rename(folder ? oldSource.with({ scheme: SIMPLE_CODE_SCHEME }) : toSimpleCodeUri(oldSource), folder ? newSource.with({ scheme: SIMPLE_CODE_SCHEME }) : toSimpleCodeUri(newSource), { overwrite: false });
				await fs.rename(oldPath, newPath);
				await fs.rename(newPath, oldPath);
				await documents.rename(folder ? newSource.with({ scheme: SIMPLE_CODE_SCHEME }) : newCode, folder ? oldSource.with({ scheme: SIMPLE_CODE_SCHEME }) : oldCode, { overwrite: false });
				assert.ok(documents.isNativePathRenameApplied(newSource, oldSource));
				assert.deepEqual(await documents.readFile(oldCode), before);
				assert.equal(documents.getProperty(owner)!.document, xml);
				await documents.rename(folder ? oldSource.with({ scheme: SIMPLE_CODE_SCHEME }) : oldCode, folder ? newSource.with({ scheme: SIMPLE_CODE_SCHEME }) : newCode, { overwrite: false });
				await fs.rename(oldPath, newPath);
				assert.deepEqual(await documents.readFile(newCode), before);
				await assert.rejects(documents.stat(oldCode));
				await fs.rename(newPath, oldPath);
				await documents.rename(folder ? newSource.with({ scheme: SIMPLE_CODE_SCHEME }) : newCode, folder ? oldSource.with({ scheme: SIMPLE_CODE_SCHEME }) : oldCode, { overwrite: false });
			} finally { registration.dispose(); }
		}, folder);
	});

	for (const kind of ["rename", "references"] as const) test(`${kind}查询期间继续编辑时丢弃旧位置，重新查询返回正确结果`, async () => {
		await withProject(async ({ project, caller, documents, refactoring }) => {
			const programs = { getProjects: async () => [project] } as unknown as ProgramTreeProvider;
			const renames = new SimpleRenameProvider(programs, refactoring, documents, () => undefined);
			const references = new SimpleReferenceProvider(programs, refactoring, () => undefined);
			const cancellation = new vscode.CancellationTokenSource();
			const read = refactoring.readProject.bind(refactoring);
			let editDuringRead = true;
			refactoring.readProject = async (current) => {
				const units = await read(current);
				if (editDuringRead) {
					editDuringRead = false;
					const edit = new vscode.WorkspaceEdit();
					edit.insert(caller.uri, new vscode.Position(0, 0), "' 继续编辑\r\n");
					assert.ok(await vscode.workspace.applyEdit(edit));
				}
				return units;
			};
			const query = () => {
				const position = caller.positionAt(caller.getText().indexOf("对象1.字段") + "对象1.".length);
				return kind === "rename" ? renames.prepareRename(caller, position, cancellation.token)
					: references.provideReferences(caller, position, { includeDeclaration: true }, cancellation.token);
			};
			try {
				const stale = await query();
				if (kind === "rename") assert.equal(stale, undefined);
				else assert.deepEqual(stale, []);
				const fresh = await query();
				assert.ok(fresh);
				if (Array.isArray(fresh)) assert.equal(fresh.length, 5);
				else assert.equal(caller.getText(fresh.range), "字段");
			} finally { cancellation.dispose(); renames.dispose(); }
		});
	});

	for (const stage of ["发起前", "分析期间"] as const) test(`查找引用在${stage}遇到项目重构时不返回旧路径，完成后可重新查询`, async () => {
		await withProject(async ({ project, caller, refactoring }) => {
			let busy = stage === "发起前";
			let interrupt = stage === "分析期间";
			let reads = 0;
			const service = { get isBusy() { return busy; }, readProject: async (current: SimpleProjectInfo) => {
				reads += 1;
				const units = await refactoring.readProject(current);
				if (interrupt) busy = true;
				return units;
			} } as unknown as SimpleProjectRefactoring;
			const provider = new SimpleReferenceProvider({ getProjects: async () => [project] } as unknown as ProgramTreeProvider, service, () => undefined);
			const cancellation = new vscode.CancellationTokenSource();
			const position = caller.positionAt(caller.getText().indexOf("对象1.字段") + "对象1.".length);
			try {
				assert.deepEqual(await provider.provideReferences(caller, position, { includeDeclaration: true }, cancellation.token), []);
				assert.equal(reads, stage === "发起前" ? 0 : 1);
				busy = false; interrupt = false;
				assert.ok((await provider.provideReferences(caller, position, { includeDeclaration: true }, cancellation.token)).length > 0);
			} finally { cancellation.dispose(); }
		});
	});

	test("查找引用期间另一个单元变化时不返回错位位置，取消请求不读取项目", async () => {
		await withProject(async ({ project, owner, caller, refactoring }) => {
			const cancellation = new vscode.CancellationTokenSource();
			const programs = { getProjects: async () => [project] } as unknown as ProgramTreeProvider;
			const references = new SimpleReferenceProvider(programs, refactoring, () => undefined);
			const read = refactoring.readProject.bind(refactoring);
			let reads = 0;
			refactoring.readProject = async (current) => {
				reads += 1;
				const units = await read(current);
				const edit = new vscode.WorkspaceEdit();
				edit.insert(owner.uri, new vscode.Position(0, 0), "' 并发编辑\r\n");
				assert.ok(await vscode.workspace.applyEdit(edit));
				return units;
			};
			const position = caller.positionAt(caller.getText().indexOf("对象1.字段") + "对象1.".length);
			try {
				assert.deepEqual(await references.provideReferences(caller, position, { includeDeclaration: true }, cancellation.token), []);
				assert.equal(reads, 1);
				cancellation.cancel();
				assert.deepEqual(await references.provideReferences(caller, position, { includeDeclaration: true }, cancellation.token), []);
				assert.equal(reads, 1);
			} finally { cancellation.dispose(); }
		});
	});

	for (const kind of ["SDK", "继承"] as const) test(`F2 拒绝${kind}名称捕获，不改代码、XML 或磁盘`, async () => {
		await withProject(async ({ project, owner, caller, ownerFile, callerFile, documents, refactoring }) => {
			const sdk = await loadSdk(testSdkPath("sdk.json"));
			const programs = { getProjects: async () => [project] } as unknown as ProgramTreeProvider;
			const renames = new SimpleRenameProvider(programs, refactoring, documents, () => sdk);
			const cancellation = new vscode.CancellationTokenSource();
			const edit = new vscode.WorkspaceEdit();
			const code = kind === "SDK"
				? '过程 P()\r\n\t变量 旧值 为 整数型\r\n\t旧值 = 1\r\n\t显示提示框("原调用")\r\n结束 过程\r\n'
				: "过程 P(a 为 派生)\r\n\ta.字段 = 1\r\n结束 过程\r\n";
			edit.replace(caller.uri, new vscode.Range(caller.positionAt(0), caller.positionAt(caller.getText().length)), code);
			if (kind === "继承") {
				edit.replace(owner.uri, new vscode.Range(0, 0, 0, "静态 ".length), "");
				await fs.writeFile(path.join(path.dirname(ownerFile), "派生.simple"), "变量 新字段 为 整数型\r\n$属性\r\n\t$资源 $对象\r\n\t基础对象 = 对象1\r\n$结束 $属性\r\n");
			}
			assert.ok(await vscode.workspace.applyEdit(edit));
			const beforeOwner = owner.getText();
			const beforeCaller = caller.getText();
			const diskOwner = await fs.readFile(ownerFile, "utf8");
			const diskCaller = await fs.readFile(callerFile, "utf8");
			const xml = await vscode.workspace.openTextDocument(toUnitXmlPreviewUri(vscode.Uri.file(callerFile)));
			const beforeXml = xml.getText();
			const name = kind === "SDK" ? "旧值" : "字段";
			try {
				await assert.rejects(renames.provideRenameEdits(caller, caller.positionAt(code.indexOf(name)), kind === "SDK" ? "显示提示框" : "新字段", cancellation.token), /改变已有引用的目标/u);
				assert.equal(owner.getText(), beforeOwner);
				assert.equal(caller.getText(), beforeCaller);
				assert.equal(xml.getText(), beforeXml);
				assert.equal(await fs.readFile(ownerFile, "utf8"), diskOwner);
				assert.equal(await fs.readFile(callerFile, "utf8"), diskCaller);
			} finally { cancellation.dispose(); renames.dispose(); }
		});
	});

	for (const folder of [false, true]) test(`${folder ? "文件夹" : "单元"}重命名被移动单元未保存代码拒绝时，保留原标签及关联输入`, async () => {
		await withProject(async ({ project, ownerFile, caller, owner, directory }) => {
			await vscode.commands.executeCommand("es4a.internal.addProject", project.filePath);
			let closed = false;
			const tabs = vscode.window.tabGroups.onDidChangeTabs((event) => {
				closed ||= event.closed.some((tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === owner.uri.toString());
			});
			try {
				const edit = new vscode.WorkspaceEdit();
				edit.insert(caller.uri, new vscode.Position(0, 0), "' 保留未保存输入\r\n");
				edit.insert(owner.uri, new vscode.Position(0, 0), "' 被移动单元的未保存输入\r\n");
				assert.ok(await vscode.workspace.applyEdit(edit));
				await vscode.window.showTextDocument(owner, { preview: false });
				const before = await fs.readFile(ownerFile, "utf8");
				const command = folder ? "es4a.renameUnitFolder" : "es4a.renameUnitFile";
				const node = folder
					? { kind: "directory", mode: "units", label: "pkg", directoryPath: path.dirname(ownerFile), project }
					: { kind: "unit", label: "对象1", filePath: ownerFile, project };
				const operation = vscode.commands.executeCommand(command, node, folder ? "new" : "新对象");
				// 原路径有脏代码时应在关闭标签之前拒绝；不把关联缓冲区的正常未保存状态作为拒绝理由。
				await new Promise((resolve) => setTimeout(resolve, 100));
				await vscode.commands.executeCommand("notifications.clearAll");
				await Promise.resolve(operation).catch((error: unknown) => assert.match(String(error), /未保存/u));
				assert.equal(closed, false);
				assert.ok(owner.isDirty && owner.getText().startsWith("' 被移动单元的未保存输入"));
				assert.equal(await fs.readFile(ownerFile, "utf8"), before);
				assert.equal(await fs.stat(folder ? path.join(directory, "src", "new") : path.join(path.dirname(ownerFile), "新对象.simple")).then(() => true, () => false), false);
				assert.ok(vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === owner.uri.toString())));
				assert.ok(caller.isDirty && caller.getText().startsWith("' 保留未保存输入"));
			} finally { tabs.dispose(); await vscode.commands.executeCommand("es4a.internal.removeProject", project.filePath); }
		}, folder);
	});

	test("资源语义重名拒绝后恢复原文件标签，原文件、限定版本及引用不变", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-resource-restore-"));
		const projectFile = path.join(directory, "project.properties");
		const old = path.join(directory, "res", "layout", "old.xml");
		const target = path.join(path.dirname(old), "new.xml");
		const existing = path.join(directory, "res", "layout-land", "new.xml");
		const callerFile = path.join(directory, "src", "调用者.simple");
		const source = '<View text="保留" />\r\n';
		const callerSource = "变量 布局 为 整数型 = R.layout_old\r\n" + property;
		const driver = await WorkbenchDriver.connect();
		let closed = false;
		const listener = vscode.window.tabGroups.onDidChangeTabs((event) => { closed ||= event.closed.some((tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === vscode.Uri.file(old).toString()); });
		try {
			await fs.mkdir(path.dirname(old), { recursive: true });
			await fs.mkdir(path.dirname(existing), { recursive: true });
			await fs.mkdir(path.dirname(callerFile), { recursive: true });
			await fs.writeFile(projectFile, "source=./src\r\n");
			await fs.writeFile(old, source); await fs.writeFile(existing, source); await fs.writeFile(callerFile, callerSource);
			await vscode.commands.executeCommand("es4a.internal.addProject", projectFile);
			const project = await loadSimpleProject(projectFile);
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(old)), { preview: false });
			await vscode.commands.executeCommand("notifications.clearAll");
			const operation = Promise.resolve(vscode.commands.executeCommand("es4a.renameResourceFile", { kind: "file", filePath: old, label: "old.xml", project, resourceRoot: "res" }, "new.xml")).catch((error: unknown) => assert.match(String(error), /资源名称.*已经存在/u));
			await waitFor(() => closed && vscode.window.activeTextEditor?.document.uri.toString() === vscode.Uri.file(old).toString());
			await driver.waitFor('Boolean(document.querySelector(".notifications-toasts")?.textContent?.includes("资源名称")) && Boolean(document.querySelector(".notifications-toasts")?.textContent?.includes("已经存在"))');
			await vscode.commands.executeCommand("notifications.clearAll");
			await operation;
			assert.equal(vscode.window.activeTextEditor?.document.getText(), source);
			assert.equal(await fs.readFile(old, "utf8"), source);
			assert.equal(await fs.readFile(existing, "utf8"), source);
			assert.equal(await fs.readFile(callerFile, "utf8"), callerSource);
			assert.equal(await fs.stat(target).then(() => true, () => false), false);
		} finally {
			driver.dispose();
			listener.dispose();
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			assert.equal(path.dirname(directory), os.tmpdir());
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	test("单个项目读取失败时保留其原诊断，其它项目继续更新，恢复后重新全量分析", async () => {
		await withProject(async ({ directory, project, documents, refactoring, owner }) => {
			const otherFile = path.join(directory, "其它项目", "project.properties");
			const otherUnit = path.join(path.dirname(otherFile), "src", "其它.simple");
			await fs.mkdir(path.dirname(otherUnit), { recursive: true });
			await fs.writeFile(otherFile, "source=./src\r\n");
			await fs.writeFile(otherUnit, "未声明其它值 = 1\r\n" + property);
			const other = await loadSimpleProject(otherFile);
			const otherDocument = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(otherUnit)));
			const edit = new vscode.WorkspaceEdit(); edit.insert(owner.uri, new vscode.Position(0, 0), "未声明原值 = 1\r\n");
			assert.ok(await vscode.workspace.applyEdit(edit));
			const sdk = await loadSdk(testSdkPath("sdk.json"));
			const errors: string[] = [];
			const programs = { getProjects: async () => [project, other] } as unknown as ProgramTreeProvider;
			const diagnostics = new SimpleDiagnosticProvider(programs, refactoring, documents, { contextForFile: () => undefined } as unknown as ProjectSymbolIndex, () => sdk, () => undefined, (message) => errors.push(message));
			const read = refactoring.readProject.bind(refactoring);
			let broken = false;
			refactoring.readProject = async (current) => {
				if (broken && current.filePath === project.filePath) throw new Error("项目暂时不可读");
				return read(current);
			};
			const has = (document: vscode.TextDocument, name: string): boolean => vscode.languages.getDiagnostics(document.uri).some((issue) => issue.message.includes(name));
			try {
				diagnostics.schedule(true);
				await waitFor(() => has(owner, "未声明原值") && has(otherDocument, "未声明其它值"));
				broken = true;
				const change = new vscode.WorkspaceEdit(); change.replace(otherDocument.uri, new vscode.Range(0, 0, 0, "未声明其它值".length), "未声明新值");
				assert.ok(await vscode.workspace.applyEdit(change));
				diagnostics.schedule(true);
				await waitFor(() => errors.length === 1 && has(otherDocument, "未声明新值"));
				assert.ok(has(owner, "未声明原值"));
				assert.ok(!has(otherDocument, "未声明其它值"));
				broken = false;
				const fix = new vscode.WorkspaceEdit(); fix.delete(owner.uri, new vscode.Range(0, 0, 1, 0));
				assert.ok(await vscode.workspace.applyEdit(fix));
				// 失败留下全量请求，下一次普通调度也能重新扫描恢复的项目。
				diagnostics.schedule(false, otherDocument.uri);
				await waitFor(() => !has(owner, "未声明原值"));
				assert.ok(has(otherDocument, "未声明新值"));
			} finally { diagnostics.dispose(); }
		});
	});
});
