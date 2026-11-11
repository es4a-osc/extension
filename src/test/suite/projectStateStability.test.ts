/*
验证重叠项目资源分支的树项身份，以及虚拟代码读取与持久化写入的顺序一致性。
xhwsd@qq.com 2026-10-28
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { ProgramTreeProvider, type ProgramTreeNode } from "../../programTree";
import { SimpleCodeFileSystemProvider, toSimpleCodeUri } from "../../simpleCodeFileSystem";
import { ProjectSemanticSyncController } from "../../projectSemanticSync";
import { ProjectSymbolIndex } from "../../projectSymbolIndex";
import { ProgramTreeExpansionController, type ProgramTreeExpansionView } from "../../programTreeExpansion";
import { createProjectInfo } from "../../project";
import { OpenUnitSemantics } from "../../openUnitSemantics";

suite("项目树与代码会话稳定性", () => {
	test("树与语义请求共享配置读取，迟到的旧源码根不能覆盖新配置", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-config-revision-"));
		const file = path.join(directory, "project.properties");
		let current = createProjectInfo(file, { source: "./old" });
		let reads = 0;
		let held = false;
		let markStarted!: () => void;
		let release!: () => void;
		const started = new Promise<void>((resolve) => { markStarted = resolve; });
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const provider = new ProgramTreeProvider(undefined, undefined, async () => {
			reads += 1;
			const result = current;
			if (held) {
				held = false;
				markStarted();
				await gate;
			}
			return result;
		});
		try {
			await provider.addProject(file);
			await fs.mkdir(path.join(directory, "new"));
			held = true;
			const pendingTree = provider.getChildren();
			await started;
			const pendingSymbols = provider.getProjects();
			assert.equal(reads, 2, "树和语义只能发起一次配置读取");
			current = createProjectInfo(file, { source: "./new" });
			provider.refresh(undefined, file);
			assert.deepEqual(await provider.getProjects(), [current]);
			release();
			assert.deepEqual(await pendingSymbols, [current]);
			assert.deepEqual(await pendingTree, [{ kind: "project", label: current.name, project: current }]);
		} finally {
			release();
			provider.dispose();
			assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
			assert.ok(path.basename(directory).startsWith("es4a-config-revision-"));
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	test("另一个原生脏文档只解析一次，版本变化后立即替换其符号", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-native-symbol-cache-"));
		const project = createProjectInfo(path.join(directory, "project.properties"), {});
		const source = project.sourceDirectories[0]!;
		const caller = { uri: vscode.Uri.file(path.join(source, "Caller.simple")), languageId: "simple" } as vscode.TextDocument;
		let version = 1;
		let reads = 0;
		let code = "常量 原始数值 为 整数型 = 1\r\n";
		const target = {
			uri: vscode.Uri.file(path.join(source, "Target.simple")), languageId: "simple", isDirty: true,
			get version() { return version; },
			getText: () => { reads += 1; return code; }
		} as vscode.TextDocument;
		const symbols = new ProjectSymbolIndex();
		const documents = new SimpleCodeFileSystemProvider();
		const semantics = new OpenUnitSemantics(documents, symbols, () => undefined);
		try {
			await symbols.updateProjects([project]);
			semantics.track(target);
			const first = semantics.contextForDocument(caller, "变量 实例 为 Target\r\n");
			assert.equal(first?.units?.find((unit) => unit.name === "Target")?.definition.constants?.[0]?.name, "原始数值");
			assert.equal(semantics.contextForDocument(caller, "变量 实例 为 Target\r\n"), first);
			assert.equal(reads, 1);
			version += 1;
			code = "常量 新数值 为 整数型 = 2\r\n";
			const updated = semantics.contextForDocument(caller, "变量 实例 为 Target\r\n");
			assert.equal(updated?.units?.find((unit) => unit.name === "Target")?.definition.constants?.[0]?.name, "新数值");
			assert.equal(reads, 2);
		} finally {
			documents.dispose();
			assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
			assert.ok(path.basename(directory).startsWith("es4a-native-symbol-cache-"));
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	test("等待语义刷新时新收到的防抖事件也必须发布后才返回", async () => {
		let enter!: () => void;
		let release!: () => void;
		const entered = new Promise<void>((resolve) => { enter = resolve; });
		const gate = new Promise<void>((resolve) => { release = resolve; });
		class DelayedPrograms extends ProgramTreeProvider {
			private first = true;
			override async getProjects() {
				if (this.first) {
					this.first = false;
					enter();
					await gate;
				}
				return [];
			}
		}
		const programs = new DelayedPrograms();
		let published = 0;
		const controller = new ProjectSemanticSyncController(programs, new ProjectSymbolIndex(), () => { published++; }, assert.fail);
		try {
			const first = controller.refresh();
			await entered;
			const waiting = controller.wait();
			controller.schedule();
			release();
			await Promise.all([first, waiting]);
			assert.equal(published, 2);
		} finally {
			release();
			controller.dispose();
			programs.dispose();
		}
	});
	test("嵌套源码根、重叠资源目录和共享源码的项目具有不同且稳定的树项身份", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-tree-identities-"));
		const provider = new ProgramTreeProvider();
		try {
			const sourceRoot = path.join(directory, "src");
			await fs.mkdir(path.join(sourceRoot, "nested"), { recursive: true });
			await fs.writeFile(path.join(sourceRoot, "nested", "Item.simple"), "$属性\r\n$资源 $对象\r\n$结束 $属性\r\n");
			await fs.writeFile(path.join(sourceRoot, "data.txt"), "资源内容");
			for (const name of ["first", "second"]) {
				const projectDirectory = path.join(directory, name);
				await fs.mkdir(projectDirectory);
				const projectFile = path.join(projectDirectory, "project.properties");
				await fs.writeFile(projectFile, "source=../src,../src/nested\r\nassets=../src\r\nres=../src\r\n");
				await provider.addProject(projectFile);
			}
			const collect = async (): Promise<string[]> => {
				const ids: string[] = [];
				const visit = async (nodes: readonly ProgramTreeNode[]): Promise<void> => {
					for (const node of nodes) {
						const item = provider.getTreeItem(node);
						if (item.id !== undefined) ids.push(item.id);
						if (node.kind !== "build") await visit(await provider.getChildren(node));
					}
				};
				await visit(await provider.getChildren());
				return ids;
			};
			const before = await collect();
			assert.equal(new Set(before).size, before.length, "不同资源分支不能复用同一个树项 id");
			provider.refresh();
			assert.deepEqual(await collect(), before, "刷新不改变同一分支的节点身份");
			const innerDirectory = path.join(directory, "inner");
			for (const name of ["first", "second"]) {
				await fs.writeFile(path.join(directory, name, "project.properties"), "source=../src\r\n");
			}
			await fs.mkdir(innerDirectory);
			const innerProject = path.join(innerDirectory, "project.properties");
			await fs.writeFile(innerProject, "source=../src/nested\r\n");
			await provider.addProject(innerProject);
			assert.equal((await provider.findUnitByFilePath(path.join(sourceRoot, "nested", "Item.simple")))?.project?.filePath, innerProject);
		} finally {
			provider.dispose();
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	test("先提交代码保存再读取时，读取等待写入完成且保留 XML", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-code-serial-read-"));
		const provider = new SimpleCodeFileSystemProvider();
		try {
			const file = path.join(directory, "Item.simple");
			const property = '$属性\r\n$资源 $对象\r\n未知 = "保持原样"\r\n$结束 $属性\r\n';
			const before = "过程 Before()\r\n结束 过程\r\n";
			const after = "过程 After()\r\n结束 过程\r\n";
			await fs.writeFile(file, before + property);
			const uri = toSimpleCodeUri(vscode.Uri.file(file));
			await provider.readFile(uri);
			const writing = provider.writeFile(uri, Buffer.from(after.trimEnd()), { create: false, overwrite: true });
			const reading = provider.readFile(uri);
			await writing;
			assert.equal(Buffer.from(await reading).toString("utf8").trimEnd(), after.trimEnd());
			assert.equal(await fs.readFile(file, "utf8"), after + property);
		} finally {
			provider.dispose();
			await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	test("重构批次开始后丢弃已在读取的语义刷新，批次结束后再统一刷新", async () => {
		let release!: () => void;
		let reading = false;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		class DelayedPrograms extends ProgramTreeProvider {
			override async getProjects() {
				reading = true;
				await gate;
				return [];
			}
		}
		const programs = new DelayedPrograms();
		let published = 0;
		const controller = new ProjectSemanticSyncController(programs, new ProjectSymbolIndex(), () => { published++; }, (message) => { throw new Error(message); });
		try {
			const pending = controller.refresh();
			for (let count = 0; count < 30 && !reading; count++) await new Promise((resolve) => setTimeout(resolve, 1));
			assert.ok(reading);
			const batch = controller.beginBatch();
			release();
			await pending;
			assert.equal(published, 0, "不得在单元改名或移动期间发布中间语义快照");
			batch.dispose();
			await controller.refresh();
			assert.equal(published, 1);
		} finally {
			release(); controller.dispose(); programs.dispose();
		}
	});

	test("等待语义就绪包含尚未触发的防抖刷新", async () => {
		const programs = new ProgramTreeProvider();
		let published = 0;
		const controller = new ProjectSemanticSyncController(programs, new ProjectSymbolIndex(), () => { published++; }, (message) => { throw new Error(message); });
		try {
			controller.schedule();
			await controller.wait();
			assert.equal(published, 1, "转到定义不能跳过仍在防抖等待的项目更新");
		} finally {
			controller.dispose(); programs.dispose();
		}
	});

	test("隐藏项目树时自动定位不唤起视图，可见时正常跟随，显式资源定位仍可打开", async () => {
		const expanded = new vscode.EventEmitter<vscode.TreeViewExpansionEvent<ProgramTreeNode>>();
		const collapsed = new vscode.EventEmitter<vscode.TreeViewExpansionEvent<ProgramTreeNode>>();
		let visible = false;
		const revealed: ProgramTreeNode[] = [];
		const view: ProgramTreeExpansionView = {
			onDidExpandElement: expanded.event,
			onDidCollapseElement: collapsed.event,
			get visible() { return visible; },
			async reveal(node) { revealed.push(node); }
		};
		const controller = new ProgramTreeExpansionController(
			{ async getSingleDirectoryChild() { return undefined; } }, view, assert.fail
		);
		const unit: ProgramTreeNode = { kind: "unit", label: "主窗口", filePath: path.resolve("主窗口.simple") };
		const resource: ProgramTreeNode = { kind: "file", label: "icon.png", filePath: path.resolve("icon.png") };
		try {
			/* 编辑器激活不能唤起隐藏的项目树。 */
			await controller.revealActiveUnit(unit);
			assert.deepEqual(revealed, []);

			/* 用户已经打开项目树时，保留跟随当前单元的行为。 */
			visible = true;
			await controller.revealActiveUnit(unit);
			assert.deepEqual(revealed, [unit]);

			/* 用户主动执行资源定位时，仍可显示目标视图。 */
			visible = false;
			await controller.revealResource(resource);
			assert.deepEqual(revealed, [unit, resource]);
		} finally {
			controller.dispose();
			expanded.dispose();
			collapsed.dispose();
		}
	});

	test("项目树隐藏后，排队中的活动单元定位不能重新打开视图", async () => {
		const expanded = new vscode.EventEmitter<vscode.TreeViewExpansionEvent<ProgramTreeNode>>();
		const collapsed = new vscode.EventEmitter<vscode.TreeViewExpansionEvent<ProgramTreeNode>>();
		let visible = true;
		let release!: () => void;
		let markStarted!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const started = new Promise<void>((resolve) => { markStarted = resolve; });
		const revealed: string[] = [];
		const view: ProgramTreeExpansionView = {
			onDidExpandElement: expanded.event,
			onDidCollapseElement: collapsed.event,
			get visible() { return visible; },
			async reveal(node) {
				revealed.push(node.label);
				if (node.label === "First") {
					markStarted();
					await gate;
				}
			}
		};
		const controller = new ProgramTreeExpansionController(
			{ async getSingleDirectoryChild() { return undefined; } }, view, assert.fail
		);
		const node = (label: string): ProgramTreeNode => ({ kind: "unit", label, filePath: path.resolve(label + ".simple") });
		try {
			const first = controller.revealActiveUnit(node("First"));
			await started;
			const pending = controller.revealActiveUnit(node("Pending"));

			/* 请求入队后用户切走侧边栏，真正执行时必须放弃自动定位。 */
			visible = false;
			release();
			await Promise.all([first, pending]);
			assert.deepEqual(revealed, ["First"]);
			assert.equal(controller.isRevealing, false);

			visible = true;
			await controller.revealActiveUnit(node("Current"));
			assert.deepEqual(revealed, ["First", "Current"]);
		} finally {
			release();
			controller.dispose();
			expanded.dispose();
			collapsed.dispose();
		}
	});

	test("单目录链读取期间隐藏项目树，返回后不再自动展开视图", async () => {
		const expanded = new vscode.EventEmitter<vscode.TreeViewExpansionEvent<ProgramTreeNode>>();
		const collapsed = new vscode.EventEmitter<vscode.TreeViewExpansionEvent<ProgramTreeNode>>();
		let visible = true;
		let release!: () => void;
		let markStarted!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const started = new Promise<void>((resolve) => { markStarted = resolve; });
		const revealed: ProgramTreeNode[] = [];
		const child = { kind: "directory" as const, label: "nested", directoryPath: path.resolve("src", "nested"), mode: "units" as const };
		const view: ProgramTreeExpansionView = {
			onDidExpandElement: expanded.event,
			onDidCollapseElement: collapsed.event,
			get visible() { return visible; },
			async reveal(node) { revealed.push(node); }
		};
		const controller = new ProgramTreeExpansionController({
			async getSingleDirectoryChild(node) {
				if (node === child) return undefined;
				markStarted();
				await gate;
				return child;
			}
		}, view, assert.fail);
		try {
			expanded.fire({ element: { kind: "directory", label: "src", directoryPath: path.resolve("src"), mode: "units" } });
			await started;

			/* 目录读取完成前切走视图，异步结果不能再唤起项目树。 */
			visible = false;
			release();
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(revealed, []);
		} finally {
			release();
			controller.dispose();
			expanded.dispose();
			collapsed.dispose();
		}
	});

	test("快速切换活动单元时旧定位不能覆盖最后一次选择", async () => {
		const expanded = new vscode.EventEmitter<vscode.TreeViewExpansionEvent<ProgramTreeNode>>();
		const collapsed = new vscode.EventEmitter<vscode.TreeViewExpansionEvent<ProgramTreeNode>>();
		let release!: () => void;
		let reading = false;
		let selected: string | undefined;
		const revealed: string[] = [];
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const view: ProgramTreeExpansionView = {
			onDidExpandElement: expanded.event, onDidCollapseElement: collapsed.event,
			visible: true,
			reveal: async (node) => {
				revealed.push(node.label);
				if (node.label === "First") { reading = true; await gate; }
				selected = node.label;
			}
		};
		const controller = new ProgramTreeExpansionController({ getSingleDirectoryChild: async () => undefined }, view, assert.fail);
		try {
			const node = (label: string): ProgramTreeNode => ({ kind: "unit", label, filePath: path.resolve(label + ".simple") });
			const first = controller.revealActiveUnit(node("First"));
			for (let count = 0; count < 30 && !reading; count++) await new Promise((resolve) => setTimeout(resolve, 1));
			assert.ok(reading);
			const skipped = controller.revealActiveUnit(node("Skipped"));
			const last = controller.revealActiveUnit(node("Last"));
			release();
			await Promise.all([first, skipped, last]);
			assert.equal(selected, "Last");
			assert.deepEqual(revealed, ["First", "Last"]);
			assert.equal(controller.isRevealing, false);
		} finally {
			release(); controller.dispose(); expanded.dispose(); collapsed.dispose();
		}
	});
});
