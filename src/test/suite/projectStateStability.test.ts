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

suite("项目树与代码会话稳定性", () => {
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
