/*
在真实扩展宿主中验证项目树按需更新、后台语义独立性和可见的折叠、展开交互。
xhwsd@qq.com 2026-11-1
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { ProgramTreeProvider, type ProgramTreeNode } from "../../programTree";
import { toSimpleCodeUri } from "../../simpleCodeFileSystem";
import { isPathInside } from "../../simpleProjectPaths";
import { ProjectSemanticSyncController } from "../../projectSemanticSync";
import { ProjectSymbolIndex } from "../../projectSymbolIndex";
import { WorkbenchDriver } from "./workbenchDriver";

/** 等待监听、语义刷新及可见工作台操作完成。 */
async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 250; attempt += 1) {
		if (await condition()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.fail("构建树未在时限内达到预期状态");
}

/** 等待文件事件的合并窗口，用于检查没有整树刷新。 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 350));

/** 仅清理本测试生成的系统临时目录，删除前核对绝对边界。 */
async function removeFixture(directory: string): Promise<void> {
	assert.ok(isPathInside(os.tmpdir(), directory));
	assert.ok(path.basename(directory).startsWith("es4a-build-host-"));
	await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

suite("项目树懒刷新", () => {
	test("构建目录位于源码根内时，产物事件仍不触发整树刷新", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-build-host-"));
		const provider = new ProgramTreeProvider();
		const events: Array<ProgramTreeNode | undefined> = [];
		try {
			const projectFile = path.join(directory, "project.properties");
			const buildDirectory = path.join(directory, "build");
			await fs.mkdir(buildDirectory);
			await fs.writeFile(projectFile, "name=构建事件边界\r\nsource=./\r\nbuild=./build\r\n");
			await provider.addProject(projectFile);
			const project = (await provider.getChildren())[0];
			assert.ok(project?.kind === "project");
			const build = (await provider.getChildren(project)).find((node) => node.kind === "build");
			assert.ok(build?.kind === "build");
			provider.setTreeVisible(true);
			provider.setTreeExpanded(project, true);
			await settle();
			const listener = provider.onDidChangeTreeData((node) => events.push(node));
			try {
				await fs.writeFile(path.join(buildDirectory, "hidden.apk"), "output");
				await settle();
				assert.equal(events.length, 0);
				provider.setTreeExpanded(build, true);
				await waitFor(() => events.includes(build));
				assert.ok(events.every((node) => node === build));
				const children = await provider.getChildren(build);
				assert.deepEqual(children.map((node) => node.label), ["hidden.apk"]);
				const sameBuild = (await provider.getChildren(project)).find((node) => node.kind === "build");
				assert.equal(sameBuild, build, "读取项目其它分支不能替换构建节点身份");
				events.length = 0;
				await fs.writeFile(path.join(buildDirectory, "hidden.apk"), "changed content");
				await settle();
				assert.equal(events.length, 0);
			} finally {
				listener.dispose();
			}
		} finally {
			provider.dispose();
			await removeFixture(directory);
		}
	});

	test("整个项目树隐藏时源码和资源仍更新语义，显示更新不回写整树", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-build-host-"));
		const symbols = new ProjectSymbolIndex();
		const provider = new ProgramTreeProvider();
		let published = 0;
		const errors: string[] = [];
		const semantic = new ProjectSemanticSyncController(provider, symbols, () => { published += 1; }, (message) => errors.push(message));
		try {
			await fs.mkdir(path.join(directory, "src"));
			await fs.mkdir(path.join(directory, "res/values"), { recursive: true });
			const projectFile = path.join(directory, "project.properties");
			const source = path.join(directory, "src/Existing.simple");
			const property = "$属性\r\n$资源 $对象\r\n$结束 $属性\r\n";
			await fs.writeFile(source, property);
			await fs.writeFile(projectFile, "name=后台分析边界\r\nsource=./src\r\nres=./res\r\n");
			await provider.addProject(projectFile);
			await provider.getChildren();
			await semantic.refresh();
			const events: Array<ProgramTreeNode | undefined> = [];
			const listener = provider.onDidChangeTreeData((node) => events.push(node));
			try {
				const added = path.join(directory, "src/Added.simple");
				await fs.writeFile(added, "变量 AddedField 为 整数型\r\n" + property);
				await waitFor(() => symbols.contextForFile(source)?.units?.some((unit) => unit.filePath === added) === true);
				await fs.writeFile(path.join(directory, "res/values/strings.xml"), '<resources><string name="hidden_resource">中文</string></resources>');
				await waitFor(() => symbols.contextForFile(source)?.resources?.symbols.some((symbol) => symbol.name === "string_hidden_resource") === true);
				const before = published;
				await fs.writeFile(added, "变量 ChangedField 为 文本型\r\n" + property);
				await waitFor(() => published > before);
				assert.ok(symbols.contextForFile(added)?.currentUnit?.definition.variables?.some((member) => member.name === "ChangedField"));
				await fs.unlink(added);
				await waitFor(() => symbols.contextForFile(source)?.units?.some((unit) => unit.filePath === added) === false);
				assert.deepEqual(events, [], "隐藏树的后台分析不能触发列表或项目根刷新");
				assert.deepEqual(errors, []);
			} finally {
				listener.dispose();
			}
		} finally {
			semantic.dispose();
			provider.dispose();
			await removeFixture(directory);
		}
	});

	for (const branch of ["units", "assets", "res"] as const) {
		test(`${branch} 折叠时不更新列表，展开后仅刷新所属分支`, async () => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-build-host-"));
			const provider = new ProgramTreeProvider();
			try {
				await Promise.all(["src", "assets", "res"].map((name) => fs.mkdir(path.join(directory, name))));
				const projectFile = path.join(directory, "project.properties");
				await fs.writeFile(projectFile, "name=分支懒刷新\r\nsource=./src\r\nassets=./assets\r\nres=./res\r\n");
				await provider.addProject(projectFile);
				const project = (await provider.getChildren())[0]!;
				const children = await provider.getChildren(project);
				const units = children.find((node) => node.kind === "units")!;
				const resources = children.find((node) => node.kind === "resources")!;
				provider.setTreeVisible(true);
				provider.setTreeExpanded(project, true);
				let parent = units;
				if (branch !== "units") {
					provider.setTreeExpanded(resources, true);
					parent = (await provider.getChildren(resources)).find((node) => node.kind === branch)!;
				}
				await provider.getChildren(parent);
				await settle();
				const events: Array<ProgramTreeNode | undefined> = [];
				const listener = provider.onDidChangeTreeData((node) => events.push(node));
				try {
					const folder = branch === "units" ? "src" : branch;
					const name = branch === "units" ? "新增单元.simple" : "data.txt";
					const filePath = path.join(directory, folder, name);
					await fs.writeFile(filePath, "$属性\r\n$资源 $对象\r\n$结束 $属性\r\n");
					await settle();
					assert.equal(events.length, 0);
					provider.setTreeExpanded(parent, true);
					await waitFor(() => events.includes(parent));
					assert.ok(events.every((node) => node === parent));
					assert.equal((await provider.getChildren(parent))[0]?.label, branch === "units" ? "新增单元" : name);
					events.length = 0;
					await fs.writeFile(path.join(directory, folder, branch === "units" ? "Another.simple" : "another.txt"), "content");
					await waitFor(() => events.includes(parent));
					assert.ok(events.every((node) => node === parent));
					assert.equal((await provider.getChildren())[0], project, "局部读取不能替换项目节点");
				} finally {
					listener.dispose();
				}
			} finally {
				provider.dispose();
				await removeFixture(directory);
			}
		});
	}

	test("多源码根的缺失目录生成后局部恢复，展开兄弟目录不影响折叠分支", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-build-host-"));
		const provider = new ProgramTreeProvider();
		try {
			await fs.mkdir(path.join(directory, "first"));
			const projectFile = path.join(directory, "project.properties");
			await fs.writeFile(projectFile, "source=./first,./second\r\n");
			await provider.addProject(projectFile);
			const project = (await provider.getChildren())[0]!;
			const units = (await provider.getChildren(project)).find((node) => node.kind === "units")!;
			const directories = await provider.getChildren(units);
			const first = directories.find((node) => node.label === "first")!;
			const second = directories.find((node) => node.label === "second");
			assert.ok(second?.kind === "directory" && second.missing);
			provider.setTreeVisible(true);
			provider.setTreeExpanded(project, true);
			provider.setTreeExpanded(units, true);
			provider.setTreeExpanded(first, true);
			await provider.getChildren(first);
			await settle();
			const events: Array<ProgramTreeNode | undefined> = [];
			const listener = provider.onDidChangeTreeData((node) => events.push(node));
			try {
				await fs.mkdir(path.join(directory, "second"));
				await fs.writeFile(path.join(directory, "second/Later.simple"), "$属性\r\n$资源 $对象\r\n$结束 $属性\r\n");
				await waitFor(() => events.includes(second));
				assert.equal(second.missing, false);
				assert.ok(events.every((node) => node === second));
				provider.setTreeExpanded(second, true);
				assert.equal((await provider.getChildren(second))[0]?.label, "Later");
				provider.setTreeExpanded(units, false);
				events.length = 0;
				await fs.writeFile(path.join(directory, "first/Hidden.simple"), "source");
				await settle();
				assert.equal(events.length, 0);
				provider.setTreeExpanded(units, true);
				await waitFor(() => events.includes(first));
			} finally {
				listener.dispose();
			}
		} finally {
			provider.dispose();
			await removeFixture(directory);
		}
	});

	test("源码内容更新只重绘可见单元，折叠后仍分析类型但不刷新列表", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-build-host-"));
		const symbols = new ProjectSymbolIndex();
		const provider = new ProgramTreeProvider(undefined, (file) => symbols.metadataForFile(file));
		const errors: string[] = [];
		const semantic = new ProjectSemanticSyncController(provider, symbols, () => undefined, (message) => errors.push(message));
		try {
			await fs.mkdir(path.join(directory, "src"));
			const source = path.join(directory, "src/Item.simple");
			const projectFile = path.join(directory, "project.properties");
			await fs.writeFile(source, "$属性\r\n$资源 $对象\r\n$结束 $属性\r\n");
			await fs.writeFile(projectFile, "source=./src\r\n");
			await provider.addProject(projectFile);
			const project = (await provider.getChildren())[0]!;
			const units = (await provider.getChildren(project)).find((node) => node.kind === "units")!;
			const unit = (await provider.getChildren(units))[0]!;
			provider.setTreeVisible(true);
			provider.setTreeExpanded(project, true);
			provider.setTreeExpanded(units, true);
			await semantic.refresh();
			await settle();
			assert.equal(provider.getTreeItem(unit).contextValue, "es4a.objectUnit.none");
			const events: Array<ProgramTreeNode | undefined> = [];
			const listener = provider.onDidChangeTreeData((node) => events.push(node));
			try {
				await fs.writeFile(source, "$属性\r\n$资源 $接口\r\n$结束 $属性\r\n");
				await waitFor(() => symbols.metadataForFile(source)?.unitType === "接口");
				assert.ok(events.includes(unit));
				assert.ok(events.every((node) => node === unit), "文件内容不能重建目录列表");
				assert.equal(provider.getTreeItem(unit).contextValue, "es4a.unit");
				provider.setTreeExpanded(units, false);
				events.length = 0;
				await fs.writeFile(source, "$属性\r\n$资源 $对象\r\n$结束 $属性\r\n");
				await waitFor(() => symbols.metadataForFile(source)?.unitType === "对象");
				assert.equal(events.length, 0);
				provider.setTreeExpanded(units, true);
				await waitFor(() => events.includes(units));
				assert.equal(provider.getTreeItem((await provider.getChildren(units))[0]!).contextValue, "es4a.objectUnit.none");
				assert.deepEqual(errors, []);
			} finally {
				listener.dispose();
			}
		} finally {
			semantic.dispose();
			provider.dispose();
			await removeFixture(directory);
		}
	});

	test("可见工作台中各分支折叠后重新展开均显示最新文件，项目节点保持原位", async function () {
		this.timeout(30_000);
		const manifest = JSON.parse(await fs.readFile(path.resolve(__dirname, "../../../package.json"), "utf8")) as {
			readonly publisher: string; readonly name: string;
		};
		const extension = vscode.extensions.getExtension(`${manifest.publisher}.${manifest.name}`);
		assert.ok(extension);
		await extension.activate();
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-build-host-"));
		const projectFile = path.join(directory, "project.properties");
		const sourceFile = path.join(directory, "src/可见单元.simple");
		const outputDirectory = path.join(directory, "build/懒刷新产物");
		let driver: WorkbenchDriver | undefined;
		try {
			await fs.mkdir(path.dirname(sourceFile), { recursive: true });
			await fs.mkdir(outputDirectory, { recursive: true });
			await Promise.all(["assets", "res"].map((name) => fs.mkdir(path.join(directory, name))));
			await fs.writeFile(projectFile, "name=构建懒刷新界面\r\nsource=./src\r\nbuild=./build\r\n");
			await fs.writeFile(sourceFile, "$属性\r\n$资源 $对象\r\n$结束 $属性\r\n");
			await vscode.commands.executeCommand("es4a.internal.addProject", projectFile);
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(sourceFile))));
			await vscode.commands.executeCommand("es4a.programs.focus");
			driver = await WorkbenchDriver.connect();
			const row = (label: string): string => `[...document.querySelectorAll('.monaco-list-row')].find(row => row.querySelector('.label-name')?.textContent === ${JSON.stringify(label)})`;
			await driver.waitFor(`Boolean(${row("构建懒刷新界面")}) && Boolean(${row("构建")})`);
			await settle();
			await driver.evaluate(`globalThis.__es4aBuildProjectRow = ${row("构建懒刷新界面")}`);
			await Promise.all(Array.from({ length: 30 }, (_, index) => fs.writeFile(path.join(outputDirectory, `产物${index}.apk`), "output")));
			await settle();
			assert.equal(await driver.evaluate("globalThis.__es4aBuildProjectRow.isConnected"), true);
			await driver.evaluate(`(${row("构建")}).querySelector('.monaco-tl-twistie').click()`);
			await driver.waitFor(`Boolean(${row("懒刷新产物")})`);
			await driver.evaluate(`(${row("懒刷新产物")}).querySelector('.monaco-tl-twistie').click()`);
			await driver.waitFor(`Boolean(${row("产物0.apk")})`);
			await driver.evaluate(`(${row("懒刷新产物")}).querySelector('.monaco-tl-twistie').click()`);
			await driver.waitFor(`!(${row("产物0.apk")})`);
			// 新文件排在首屏，避免将虚拟列表尚未渲染的行误判为没有刷新。
			await fs.writeFile(path.join(outputDirectory, "000-重新展开.apk"), "new output");
			await settle();
			assert.equal(await driver.evaluate(`Boolean(${row("000-重新展开.apk")})`), false);
			await driver.evaluate(`(${row("懒刷新产物")}).querySelector('.monaco-tl-twistie').click()`);
			await settle();
			await driver.waitFor(`Boolean(${row("000-重新展开.apk")})`);
			assert.equal(await driver.evaluate("globalThis.__es4aBuildProjectRow.isConnected"), true);
			await driver.evaluate(`(${row("构建")}).querySelector('.monaco-tl-twistie').click()`);
			await driver.waitFor(`!(${row("懒刷新产物")})`);
			for (const [label, folder, filename] of [
				["单元", "src", "000界面单元.simple"],
				["Assets", "assets", "000-asset.txt"],
				["Res", "res", "000-resource.txt"]
			] as const) {
				if (label === "Assets") {
					await driver.evaluate(`(${row("资源")}).querySelector('.monaco-tl-twistie').click()`);
					await driver.waitFor(`Boolean(${row("Assets")}) && Boolean(${row("Res")})`);
				}
				if (await driver.evaluate(`(${row(label)}).getAttribute('aria-expanded') === 'true'`)) {
					await driver.evaluate(`(${row(label)}).querySelector('.monaco-tl-twistie').click()`);
				}
				const text = filename.endsWith(".simple") ? "$属性\r\n$资源 $对象\r\n$结束 $属性\r\n" : "content";
				await fs.writeFile(path.join(directory, folder, filename), text);
				await settle();
				const displayed = filename.replace(/\.simple$/u, "");
				assert.equal(await driver.evaluate(`Boolean(${row(displayed)})`), false);
				await driver.evaluate(`(${row(label)}).querySelector('.monaco-tl-twistie').click()`);
				await driver.waitFor(`Boolean(${row(displayed)})`);
				assert.equal(await driver.evaluate("globalThis.__es4aBuildProjectRow.isConnected"), true);
				await driver.evaluate(`(${row(label)}).querySelector('.monaco-tl-twistie').click()`);
				await driver.waitFor(`!(${row(displayed)})`);
				const renamed = filename.replace("000", "001");
				await fs.rename(path.join(directory, folder, filename), path.join(directory, folder, renamed));
				await settle();
				await driver.evaluate(`(${row(label)}).querySelector('.monaco-tl-twistie').click()`);
				await driver.waitFor(`Boolean(${row(renamed.replace(/\.simple$/u, ""))})`);
			}

		} finally {
			await driver?.evaluate("delete globalThis.__es4aBuildProjectRow");
			driver?.dispose();
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			await removeFixture(directory);
		}
	});
});
