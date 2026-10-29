/*
验证项目符号索引合并其它已打开单元的未保存代码与 XML 属性状态。
xhwsd@qq.com 2026-9-1
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { findSimpleDefinition } from "../definitionModel";
import type { SimpleProjectInfo } from "../project";
import { ProjectSymbolIndex } from "../projectSymbolIndex";
import { inspectSimplePropertyXml } from "../propertyXml";
import { splitSimpleUnitSource } from "../simpleUnitSource";

test("其它打开单元的未保存成员立即参与跨单元定义解析", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-project-symbols-"));
	const sourceRoot = path.join(directory, "src");
	const baseFile = path.join(sourceRoot, "pkg", "Base.simple");
	const callerFile = path.join(sourceRoot, "Caller.simple");
	const property = "$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n";
	const diskBase = `过程 已保存过程()\r\n结束 过程\r\n${property}`;
	const openBase = `过程 未保存过程()\r\n结束 过程\r\n${property}`;
	const caller = [
		"过程 Run()",
		"\t变量 value 为 pkg.Base",
		"\tvalue.未保存过程()",
		"结束 过程",
		property
	].join("\r\n");

	try {
		await fs.mkdir(path.dirname(baseFile), { recursive: true });
		await fs.writeFile(baseFile, diskBase, "utf8");
		await fs.writeFile(callerFile, caller, "utf8");
		const project: SimpleProjectInfo = {
			assetsDirectory: path.join(directory, "assets"),
			buildDirectory: path.join(directory, "build"),
			directory,
			filePath: path.join(directory, "project.properties"),
			name: "测试项目",
			properties: {},
			resourceDirectory: path.join(directory, "res"),
			sourceDirectories: [sourceRoot]
		};
		const index = new ProjectSymbolIndex();
		await index.updateProjects([project]);
		const callerUserCode = splitSimpleUnitSource(caller).userCode;
		const context = index.contextForFile(
			callerFile,
			callerUserCode,
			inspectSimplePropertyXml(caller),
			[{
				filePath: baseFile,
				property: inspectSimplePropertyXml(openBase),
				userCode: splitSimpleUnitSource(openBase).userCode
			}]
		);
		const offset = callerUserCode.indexOf("未保存过程") + 1;
		const target = findSimpleDefinition(callerUserCode, offset, undefined, context);

		assert.equal(target?.filePath, path.resolve(baseFile));
		assert.equal(target?.targetLine, 0);
		const base = context?.manifest.categories[0]?.definitions.find(
			(definition) => definition.name === "pkg.Base"
		);
		assert.deepEqual(base?.functions?.map((member) => member.name), ["未保存过程"]);
	} finally {
		await fs.rm(directory, { force: true, recursive: true });
	}
});

test("嵌套源码根只索引一次并使用最具体源码根计算限定名", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-nested-source-roots-"));
	const broadRoot = path.join(directory, "src");
	const specificRoot = path.join(broadRoot, "generated");
	const unitFile = path.join(specificRoot, "pkg", "Target.simple");
	const property = "$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n";
	try {
		await fs.mkdir(path.dirname(unitFile), { recursive: true });
		await fs.writeFile(unitFile, property, "utf8");
		const project: SimpleProjectInfo = {
			assetsDirectory: path.join(directory, "assets"),
			buildDirectory: path.join(directory, "build"),
			directory,
			filePath: path.join(directory, "project.properties"),
			name: "嵌套源码根",
			properties: {},
			resourceDirectory: path.join(directory, "res"),
			sourceDirectories: [broadRoot, specificRoot]
		};
		const index = new ProjectSymbolIndex();
		await index.updateProjects([project]);
		const context = index.contextForFile(unitFile, "", inspectSimplePropertyXml(property));
		const definitions = context?.manifest.categories[0]?.definitions ?? [];

		assert.deepEqual(definitions.map((definition) => definition.name), ["pkg.Target"]);
		assert.equal(context?.currentUnit?.qualifiedName, "pkg.Target");
	} finally {
		await fs.rm(directory, { force: true, recursive: true });
	}
});

test("项目索引按路径提供项目树所需的单元元数据", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-project-metadata-"));
	const sourceRoot = path.join(directory, "src");
	const unitFile = path.join(sourceRoot, "pkg", "Target.simple");
	const source = [
		"$属性",
		"\t$资源 $对象",
		"\t基础对象 = simple.Base",
		"\t实现接口 = simple.First, simple.Second",
		"$结束 $属性",
		""
	].join("\r\n");
	try {
		await fs.mkdir(path.dirname(unitFile), { recursive: true });
		await fs.writeFile(unitFile, source, "utf8");
		const project: SimpleProjectInfo = {
			assetsDirectory: path.join(directory, "assets"),
			buildDirectory: path.join(directory, "build"),
			directory,
			filePath: path.join(directory, "project.properties"),
			name: "元数据项目",
			properties: {},
			resourceDirectory: path.join(directory, "res"),
			sourceDirectories: [sourceRoot]
		};
		const index = new ProjectSymbolIndex();
		await index.updateProjects([project]);

		assert.deepEqual(index.metadataForFile(unitFile), {
			baseObject: "simple.Base",
			interfaces: ["simple.First", "simple.Second"],
			unitType: "对象"
		});
		assert.equal(index.metadataForFile(path.join(sourceRoot, "Missing.simple")), undefined);
	} finally {
		await fs.rm(directory, { force: true, recursive: true });
	}
});

test("项目索引把 res 资源独立附加到语义上下文", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-project-resources-"));
	const sourceRoot = path.join(directory, "src");
	const resourceRoot = path.join(directory, "res");
	const unitFile = path.join(sourceRoot, "pkg", "Target.simple");
	const resourceFile = path.join(resourceRoot, "drawable", "icon.png");
	const source = "$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n";
	try {
		await fs.mkdir(path.dirname(unitFile), { recursive: true });
		await fs.mkdir(path.dirname(resourceFile), { recursive: true });
		await fs.writeFile(unitFile, source, "utf8");
		await fs.writeFile(resourceFile, "image", "utf8");
		const project: SimpleProjectInfo = {
			assetsDirectory: path.join(directory, "assets"),
			buildDirectory: path.join(directory, "build"),
			directory,
			filePath: path.join(directory, "project.properties"),
			main: "pkg.Target",
			name: "资源项目",
			properties: {},
			resourceDirectory: resourceRoot,
			sourceDirectories: [sourceRoot]
		};
		const index = new ProjectSymbolIndex();
		await index.updateProjects([project]);
		const context = index.contextForFile(unitFile, "", inspectSimplePropertyXml(source));

		assert.equal(index.containsResourcePath(resourceFile), true);
		assert.equal(index.containsResourcePath(path.join(directory, "assets", "icon.png")), false);
		assert.equal(context?.resources?.objectQualifiedName, "pkg.SimpleResources");
		assert.deepEqual(context?.resources?.symbols.map((symbol) => symbol.name), ["drawable_icon"]);
	} finally {
		await fs.rm(directory, { force: true, recursive: true });
	}
});

test("同一文档语义代次复用完整上下文并在代次变化后失效", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-context-cache-"));
	const sourceRoot = path.join(directory, "src");
	const unitFile = path.join(sourceRoot, "Target.simple");
	const source = "过程 Run()\r\n结束 过程\r\n$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n";
	try {
		await fs.mkdir(sourceRoot, { recursive: true });
		await fs.writeFile(unitFile, source, "utf8");
		const project: SimpleProjectInfo = {
			assetsDirectory: path.join(directory, "assets"),
			buildDirectory: path.join(directory, "build"),
			directory,
			filePath: path.join(directory, "project.properties"),
			name: "上下文缓存项目",
			properties: {},
			resourceDirectory: path.join(directory, "res"),
			sourceDirectories: [sourceRoot]
		};
		const index = new ProjectSymbolIndex();
		await index.updateProjects([project]);
		const property = inspectSimplePropertyXml(source);
		const userCode = splitSimpleUnitSource(source).userCode;
		const documentIdentity = {};
		const openUnit = {
			cacheIdentity: documentIdentity,
			filePath: unitFile,
			property,
			userCode,
			version: 1
		};
		const first = index.contextForFile(
			unitFile,
			userCode,
			property,
			[openUnit],
			{ generation: 1, identity: documentIdentity }
		);
		const reused = index.contextForFile(
			unitFile,
			userCode,
			property,
			[openUnit],
			{ generation: 1, identity: documentIdentity }
		);
		const invalidated = index.contextForFile(
			unitFile,
			userCode,
			property,
			[openUnit],
			{ generation: 2, identity: documentIdentity }
		);

		assert.strictEqual(reused, first);
		assert.notStrictEqual(invalidated, first);
	} finally {
		await fs.rm(directory, { force: true, recursive: true });
	}
});

test("同一文档身份和代次的分析不能复用另一份代码、XML 或文件路径", async () => {
	const index = new ProjectSymbolIndex();
	const identity = {};
	const cache = { generation: 1, identity };
	const file = path.resolve("standalone", "First.simple");
	const property = inspectSimplePropertyXml("$属性\r\n$资源 $对象\r\n$结束 $属性\r\n");
	const before = "过程 Before()\r\n结束 过程\r\n";
	const after = "过程 After()\r\n结束 过程\r\n";
	const first = index.contextForFile(file, before, property, [], cache);
	const changed = index.contextForFile(file, after, property, [], cache);
	assert.deepEqual(changed?.currentUnit?.definition.functions?.map((member) => member.name), ["After"]);
	assert.notStrictEqual(changed, first);
	const movedFile = path.resolve("standalone", "Second.simple");
	const moved = index.contextForFile(movedFile, after, property, [], cache);
	assert.equal(moved?.currentUnit?.filePath, movedFile);
	const windowProperty = inspectSimplePropertyXml("$属性\r\n$资源 $窗口\r\n$定义 Second $为 窗口\r\n$结束 $定义\r\n$结束 $属性\r\n");
	const changedXml = index.contextForFile(movedFile, after, windowProperty, [], cache);
	assert.equal(changedXml?.currentUnit?.unitType, "窗口");
});

test("同版本打开文档改变路径或代码后重新派生符号，不能返回旧限定名", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-open-symbol-path-"));
	const sourceRoot = path.join(directory, "src");
	const firstFile = path.join(sourceRoot, "First.simple");
	const secondFile = path.join(sourceRoot, "nested", "Second.simple");
	const propertySource = "$属性\r\n$资源 $对象\r\n$结束 $属性\r\n";
	const before = "过程 Before()\r\n结束 过程\r\n";
	try {
		await fs.mkdir(sourceRoot, { recursive: true });
		await fs.writeFile(firstFile, before + propertySource, "utf8");
		const index = new ProjectSymbolIndex();
		const project: SimpleProjectInfo = {
			directory, filePath: path.join(directory, "project.properties"), name: "路径缓存验证", properties: {},
			sourceDirectories: [sourceRoot], assetsDirectory: path.join(directory, "assets"),
			buildDirectory: path.join(directory, "build"), resourceDirectory: path.join(directory, "res")
		};
		await index.updateProjects([project]);
		const snapshot = { cacheIdentity: {}, version: 1, filePath: firstFile, userCode: before, property: inspectSimplePropertyXml(propertySource) };
		index.contextForFile(firstFile, before, snapshot.property, [snapshot]);
		const moved = { ...snapshot, filePath: secondFile };
		const changedPath = index.contextForFile(secondFile, before, snapshot.property, [moved]);
		assert.equal(changedPath?.currentUnit?.filePath, secondFile);
		assert.equal(changedPath?.currentUnit?.definition.name, "nested.Second");
		const after = "过程 After()\r\n结束 过程\r\n";
		const changedCode = index.contextForFile(secondFile, after, snapshot.property, [{ ...moved, userCode: after }]);
		assert.deepEqual(changedCode?.currentUnit?.definition.functions?.map((member) => member.name), ["After"]);
		const cache = { identity: {}, generation: 1 };
		const caller = index.contextForFile(firstFile, before, snapshot.property, [snapshot, moved], cache);
		assert.equal(caller?.units?.find((unit) => unit.filePath === secondFile)?.definition.functions?.[0]?.name, "Before");
		const otherChanged = index.contextForFile(firstFile, before, snapshot.property, [snapshot, { ...moved, userCode: after }], cache);
		assert.equal(otherChanged?.units?.find((unit) => unit.filePath === secondFile)?.definition.functions?.[0]?.name, "After");
		const changedProperty = inspectSimplePropertyXml("$属性\r\n$资源 $窗口\r\n$定义 Second $为 窗口\r\n$结束 $定义\r\n$结束 $属性\r\n");
		const otherXml = index.contextForFile(firstFile, before, snapshot.property, [snapshot, { ...moved, userCode: after, property: changedProperty }], cache);
		assert.equal(otherXml?.units?.find((unit) => unit.filePath === secondFile)?.unitType, "窗口");
		/* 同一文件同时属于外层与内层项目时，语言分析必须与编译、重构选择同一个项目。 */
		const inner = { ...project, name: "内层项目", filePath: path.join(sourceRoot, "nested", "project.properties"), sourceDirectories: [path.dirname(secondFile)] };
		await index.updateProjects([project, inner]);
		assert.equal(index.contextForFile(secondFile, before, snapshot.property)?.currentUnit?.definition.name, "Second");
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});
