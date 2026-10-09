/*
验证项目树包目录和主窗口单元改名自动同步 main，并保留无关配置与源码。
xhwsd@qq.com 2026-10-9
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { loadSimpleProject } from "../../programResources";
import type { DirectoryNode, FileNode } from "../../programTree";
import { splitSimpleUnitSource } from "../../simpleUnitSource";

suite("主窗口包目录改名", () => {
	test("同步 main 并立即保存，目录与配置一起撤销重做，其他包改名不改配置", async function () {
		this.timeout(30000);
		await vscode.extensions.getExtension("es4a.es4a")!.activate();
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-main-package-"));
		const projectFile = path.join(directory, "project.properties");
		const oldDirectory = path.join(directory, "src", "old");
		const newDirectory = path.join(directory, "src", "new");
		const relativeUnit = path.join("nested", "主窗口.simple");
		const unitSource = "' 用户代码逐字保留\r\n事件 主窗口.初始化()\r\n结束 事件\r\n\r\n$属性\r\n\t$资源 $窗口\r\n\t$定义 主窗口 $为 窗口\r\n\t$结束 $定义\r\n$结束 $属性\r\n";
		const projectSource = "# 主窗口限定名\r\n  main : old.nested.主窗口\r\nsource=./src\r\nname=包目录演示\r\n未知字段=保留\r\n";
		const updatedSource = projectSource.replace("old.nested.主窗口", "new.nested.主窗口");
		try {
			await fs.mkdir(path.join(oldDirectory, "nested"), { recursive: true });
			await fs.writeFile(path.join(oldDirectory, relativeUnit), unitSource, "utf8");
			await fs.writeFile(projectFile, projectSource, "utf8");
			await vscode.commands.executeCommand("es4a.internal.addProject", projectFile);
			const project = await loadSimpleProject(projectFile);
			const node: DirectoryNode = { kind: "directory", label: "old", mode: "units", directoryPath: oldDirectory, project };
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(projectFile));
			await vscode.window.showTextDocument(document, { preview: false });
			/* 改名直接同步，不传确认参数，也不等待新增的确认框。 */
			await vscode.commands.executeCommand("es4a.renameUnitFolder", node, "new");
			assert.equal(await fs.readFile(projectFile, "utf8"), updatedSource);
			assert.equal(document.isDirty, false);
			assert.equal((await loadSimpleProject(projectFile)).main, "new.nested.主窗口");
			assert.equal(await fs.readFile(path.join(newDirectory, relativeUnit), "utf8"), unitSource);
			assert.equal(await fs.stat(oldDirectory).then(() => true, () => false), false);

			await vscode.commands.executeCommand("undo");
			assert.equal(document.getText(), projectSource);
			assert.equal(await fs.readFile(path.join(oldDirectory, relativeUnit), "utf8"), unitSource);
			assert.equal(await fs.stat(newDirectory).then(() => true, () => false), false);
			assert.ok(await document.save());
			assert.equal(await fs.readFile(projectFile, "utf8"), projectSource);
			await vscode.commands.executeCommand("redo");
			assert.equal(document.getText(), updatedSource);
			assert.equal(await fs.readFile(path.join(newDirectory, relativeUnit), "utf8"), unitSource);
			assert.ok(await document.save());
			assert.equal(await fs.readFile(projectFile, "utf8"), updatedSource);

			const otherDirectory = path.join(directory, "src", "other");
			await fs.mkdir(otherDirectory);
			await fs.writeFile(path.join(otherDirectory, "辅助.simple"), unitSource, "utf8");
			await vscode.commands.executeCommand("es4a.renameUnitFolder", {
				...node, label: "other", directoryPath: otherDirectory
			}, "renamed");
			assert.equal(await fs.readFile(projectFile, "utf8"), updatedSource);
			assert.equal(await fs.readFile(path.join(directory, "src", "renamed", "辅助.simple"), "utf8"), unitSource);
		} finally {
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test("当前主窗口单元改名同步 main 和根名称，同名非主窗口不改 main", async function () {
		this.timeout(30000);
		await vscode.extensions.getExtension("es4a.es4a")!.activate();
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-main-unit-"));
		const projectFile = path.join(directory, "project.properties");
		const sourceFile = path.join(directory, "src", "demo", "主窗口.simple");
		const targetFile = path.join(directory, "src", "demo", "新主窗口.simple");
		const source = "' 主窗口仅为注释\r\n事件 主窗口.初始化()\r\n结束 事件\r\n\r\n$属性\r\n\t$资源 $窗口\r\n\t$定义 主窗口 $为 窗口\r\n\t\t标题 = \"主窗口保持文本\"\r\n\t\t未知字段 = 42\r\n\t$结束 $定义\r\n$结束 $属性\r\n";
		const properties = "# 保持项目属性\r\n main = demo.主窗口\r\nsource=./src\r\n未知字段=保留\r\n";
		try {
			await fs.mkdir(path.dirname(sourceFile), { recursive: true });
			await fs.writeFile(sourceFile, source, "utf8");
			await fs.writeFile(projectFile, properties, "utf8");
			await vscode.commands.executeCommand("es4a.internal.addProject", projectFile);
			const project = await loadSimpleProject(projectFile);
			const node: FileNode = { kind: "unit", filePath: sourceFile, label: "主窗口", unitType: "窗口", project };
			await vscode.commands.executeCommand("es4a.renameUnitFile", node, "新主窗口");
			const expectedProperties = properties.replace("demo.主窗口", "demo.新主窗口");
			assert.equal(await fs.readFile(projectFile, "utf8"), expectedProperties);
			assert.equal((await loadSimpleProject(projectFile)).main, "demo.新主窗口");
			assert.equal(await fs.stat(sourceFile).then(() => true, () => false), false);
			const renamed = splitSimpleUnitSource(await fs.readFile(targetFile, "utf8"));
			const expected = splitSimpleUnitSource(source
				.replace("事件 主窗口.初始化()", "事件 新主窗口.初始化()")
				.replace("$定义 主窗口 $为 窗口", "$定义 新主窗口 $为 窗口"));
			assert.equal(renamed.userCode, expected.userCode);
			/* 原有 XML 保存按编辑器缩进设置序列化；字段、值和顺序必须保持。 */
			const withoutIndent = (text: string): string => text.split("\r\n").map((line) => line.trimStart()).join("\r\n");
			assert.equal(withoutIndent(renamed.propertySource), withoutIndent(expected.propertySource));

			const otherFile = path.join(directory, "src", "other", "主窗口.simple");
			await fs.mkdir(path.dirname(otherFile));
			await fs.writeFile(otherFile, source, "utf8");
			await vscode.commands.executeCommand("es4a.renameUnitFile", { ...node, filePath: otherFile }, "辅助窗口");
			assert.equal(await fs.readFile(projectFile, "utf8"), expectedProperties);
			assert.match(await fs.readFile(path.join(path.dirname(otherFile), "辅助窗口.simple"), "utf8"), /\$定义 辅助窗口 \$为 窗口/u);
		} finally {
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test("对象、服务和窗口根名不一致时同步自身事件，保留无关代码与属性", async function () {
		this.timeout(30000);
		await vscode.extensions.getExtension("es4a.es4a")!.activate();
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-unit-events-"));
		const projectFile = path.join(directory, "project.properties");
		const objectSource = await fs.readFile(path.resolve(__dirname, "../../../../simple/samples/Tetris/src/simple/samples/tetris/Bar.simple"), "utf8");
		const properties = "main=demo.主窗口\r\nsource=./src\r\n未知字段=保留\r\n";
		const serviceSource = "' 旧服务 保留注释\r\n事件 旧服务.加载()\r\n结束 事件\r\n事件 旧服务.初始化()\r\n结束 事件\r\n事件 成员1.初始化()\r\n结束 事件\r\n过程 服务创建()\r\n\t显示提示(\"旧服务\")\r\n结束 过程\r\n\r\n$属性\r\n  $资源 $服务\r\n  未知字段 = \"旧服务\"\r\n$结束 $属性\r\n";
		try {
			const sourceDirectory = path.join(directory, "src", "demo");
			await fs.mkdir(sourceDirectory, { recursive: true });
			await fs.writeFile(projectFile, properties, "utf8");
			await vscode.commands.executeCommand("es4a.internal.addProject", projectFile);
			const project = await loadSimpleProject(projectFile);
			const cases = [
				{ oldName: "Bar", newName: "新对象", unitType: "对象" as const, source: objectSource,
					expected: objectSource.replace("事件 Bar.初始化()", "事件 新对象.初始化()") },
				{ oldName: "旧服务", newName: "新服务", unitType: "服务" as const, source: serviceSource,
					expected: serviceSource.replace("事件 旧服务.加载()", "事件 新服务.加载()").replace("事件 旧服务.初始化()", "事件 新服务.初始化()") }
			];
			for (const entry of cases) {
				const sourceFile = path.join(sourceDirectory, `${entry.oldName}.simple`);
				const targetFile = path.join(sourceDirectory, `${entry.newName}.simple`);
				await fs.writeFile(sourceFile, entry.source, "utf8");
				const node: FileNode = { kind: "unit", filePath: sourceFile, label: entry.oldName, unitType: entry.unitType, project };
				await vscode.commands.executeCommand("es4a.renameUnitFile", node, entry.newName);
				/* 仅代码变化时，完整文件逐字比较，包含原属性区与真实对象样例的事件体。 */
				assert.equal(await fs.readFile(targetFile, "utf8"), entry.expected);
				assert.equal(await fs.stat(sourceFile).then(() => true, () => false), false);
			}

			for (const rootName of ["旧根", "新窗口"]) {
				const caseDirectory = path.join(sourceDirectory, rootName);
				await fs.mkdir(caseDirectory);
				const sourceFile = path.join(caseDirectory, "旧窗口.simple");
				const targetFile = path.join(caseDirectory, "新窗口.simple");
				const source = `' 旧窗口与根名称不同\r\n事件 旧窗口.加载()\r\n结束 事件\r\n事件 旧窗口.初始化()\r\n结束 事件\r\n事件 ${rootName}.按下某键(键码 为 整数型)\r\n结束 事件\r\n事件 按钮1.被单击()\r\n\t显示提示("旧窗口")\r\n结束 事件\r\n\r\n$属性\r\n  $资源 $窗口\r\n  $定义 ${rootName} $为 窗口\r\n    未知字段 = "旧窗口"\r\n    $定义 按钮1 $为 按钮\r\n    $结束 $定义\r\n  $结束 $定义\r\n$结束 $属性\r\n`;
				await fs.writeFile(sourceFile, source, "utf8");
				const node: FileNode = { kind: "unit", filePath: sourceFile, label: "旧窗口", unitType: "窗口", project };
				await vscode.commands.executeCommand("es4a.renameUnitFile", node, "新窗口");
				const actual = await fs.readFile(targetFile, "utf8");
				const expected = source.replace("事件 旧窗口.加载()", "事件 新窗口.加载()")
					.replace("事件 旧窗口.初始化()", "事件 新窗口.初始化()")
					.replace(`事件 ${rootName}.按下某键`, "事件 新窗口.按下某键")
					.replace(`$定义 ${rootName} $为 窗口`, "$定义 新窗口 $为 窗口");
				assert.equal(splitSimpleUnitSource(actual).userCode, splitSimpleUnitSource(expected).userCode, `窗口根名：${rootName}`);
				if (rootName === "新窗口") {
					assert.equal(actual, expected);
				} else {
					const withoutIndent = (text: string): string => text.split("\r\n").map((line) => line.trimStart()).join("\r\n");
					assert.equal(withoutIndent(splitSimpleUnitSource(actual).propertySource), withoutIndent(splitSimpleUnitSource(expected).propertySource));
				}
			}
			assert.equal(await fs.readFile(projectFile, "utf8"), properties);
		} finally {
			await vscode.commands.executeCommand("es4a.internal.removeProject", projectFile);
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
