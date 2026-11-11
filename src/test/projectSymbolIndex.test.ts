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
import { parseSimpleUnitSymbols } from "../simpleUnitSymbols";
import { createProjectInfo } from "../project";
import { filePathKey } from "../simpleProjectPaths";

test("按变化类别替换项目快照，资源、资产和改名各自保留无关索引", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-index-scope-"));
	const first = createProjectInfo(path.join(directory, "a", "project.properties"), {});
	const second = createProjectInfo(path.join(directory, "b", "project.properties"), {});
	const projects = [first, second];
	const firstUnit = path.join(first.sourceDirectories[0]!, "First.simple");
	const peerUnit = path.join(first.sourceDirectories[0]!, "Peer.simple");
	const secondUnit = path.join(second.sourceDirectories[0]!, "Second.simple");
	const firstResource = path.join(first.resourceDirectory, "drawable", "first.png");
	const secondResource = path.join(second.resourceDirectory, "drawable", "second.png");
	try {
		for (const file of [firstUnit, peerUnit, secondUnit, firstResource, secondResource]) {
			await fs.mkdir(path.dirname(file), { recursive: true });
			await fs.writeFile(file, path.extname(file) === ".simple" ? "常量 数值 为 整数型 = 1\r\n" : "image");
		}
		const index = new ProjectSymbolIndex();
		await index.updateProjects(projects);
		const firstBefore = index.contextForFile(firstUnit)!;
		const secondBefore = index.contextForFile(secondUnit)!;
		const secondKey = { generation: 1, identity: {} };
		const secondContext = index.contextForFile(secondUnit, undefined, undefined, [], secondKey);
		const refresh = (paths: readonly string[]) => index.updateProjects(projects, undefined, paths);
		assert.deepEqual(await refresh([path.join(first.assetsDirectory, "图片.png")]), [filePathKey(first.filePath)]);
		assert.equal(index.contextForFile(firstUnit)?.currentUnit, firstBefore.currentUnit);
		assert.equal(index.contextForFile(firstUnit)?.resources, firstBefore.resources);

		const peerBefore = index.contextForFile(peerUnit)?.currentUnit;
		await fs.writeFile(firstUnit, "常量 已保存值 为 整数型 = 5\r\n");
		assert.deepEqual(await index.updateProjects(projects, undefined, [firstUnit], new Set([filePathKey(firstUnit)])), [filePathKey(first.filePath)]);
		const changedUnit = index.contextForFile(firstUnit)?.currentUnit;
		assert.equal(changedUnit?.definition.constants?.[0]?.name, "已保存值");
		assert.equal(index.contextForFile(peerUnit)?.currentUnit, peerBefore);
		assert.equal(index.contextForFile(secondUnit, undefined, undefined, [], secondKey), secondContext);

		const renamedResource = path.join(path.dirname(firstResource), "renamed.png");
		await fs.rename(firstResource, renamedResource);
		assert.deepEqual(await refresh([firstResource, renamedResource]), [filePathKey(first.filePath)]);
		const resources = index.resourcesForProject(first.filePath);
		assert.deepEqual(resources?.symbols.map((symbol) => symbol.name), ["drawable_renamed"]);
		assert.equal(index.contextForFile(firstUnit)?.currentUnit, changedUnit);

		const renamedUnit = path.join(path.dirname(firstUnit), "Renamed.simple");
		await fs.rename(firstUnit, renamedUnit);
		assert.deepEqual(await refresh([firstUnit, renamedUnit]), [filePathKey(first.filePath)]);
		assert.equal(index.contextForFile(firstUnit)?.currentUnit, undefined);
		assert.equal(index.contextForFile(renamedUnit)?.currentUnit?.name, "Renamed");
		assert.equal(index.contextForFile(renamedUnit)?.resources, resources);
		assert.equal(index.contextForFile(secondUnit)?.currentUnit, secondBefore.currentUnit);
		assert.equal(index.contextForFile(secondUnit)?.resources, secondBefore.resources);

		const shared = { ...second, sourceDirectories: [...second.sourceDirectories, ...first.sourceDirectories] };
		assert.equal(await index.updateProjects([first, shared], undefined, [second.filePath]), undefined, "共享源码归属变化时须重新分配诊断");
		const sharedResources = index.resourcesForProject(second.filePath);
		await fs.writeFile(renamedUnit, "常量 共享数值 为 整数型 = 2\r\n");
		assert.deepEqual(await index.updateProjects([first, shared], undefined, [renamedUnit]), [filePathKey(first.filePath), filePathKey(second.filePath)]);
		assert.equal(index.contextForFile(secondUnit)?.units?.find((unit) => unit.name === "Renamed")?.definition.constants?.[0]?.name, "共享数值");
		assert.equal(index.contextForFile(secondUnit)?.resources, sharedResources);
	} finally {
		assert.ok(path.basename(directory).startsWith("es4a-index-scope-"));
		assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("项目根作为源码根时索引排除自定义构建目录，监听范围不包含其产物", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-index-generated-"));
	const project = createProjectInfo(path.join(directory, "project.properties"), { source: "./", build: "./output" });
	const unit = path.join(directory, "主窗口.simple");
	const generated = path.join(project.buildDirectory, "生成.simple");
	try {
		await fs.mkdir(project.buildDirectory);
		await fs.writeFile(unit, "常量 用户值 为 整数型 = 1\n");
		await fs.writeFile(generated, "常量 生成值 为 整数型 = 2\n");
		const index = new ProjectSymbolIndex();
		await index.updateProjects([project]);
		assert.deepEqual(index.contextForFile(unit)?.units?.map((value) => value.filePath), [unit]);
		assert.equal(index.metadataForFile(generated), undefined);
		assert.equal(index.containsProjectPath(generated), false);
		assert.equal(index.containsProjectPath(unit), true);
		assert.equal(index.containsProjectPath(directory), true);
		const generatedCode = "常量 未保存生成值 为 整数型 = 3\r\n";
		const context = index.contextForFile(unit, undefined, undefined,
			[{ filePath: generated, userCode: generatedCode, property: inspectSimplePropertyXml(generatedCode) }],
			undefined, [parseSimpleUnitSymbols(generatedCode, generated, directory)]);
		assert.deepEqual(context?.units?.map((value) => value.filePath), [unit], "打开的原生与 ES4A 文档都不能把构建产物重新加入项目");
	} finally {
		await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test("项目外原生源码派生当前单元并保留已有 XML 会话优先级", () => {
	const index = new ProjectSymbolIndex();
	const file = path.join(os.tmpdir(), "es4a-standalone", "独立单元.simple");
	const code = "函数 当前计算(值 为 整数型) 为 整数型\r\n当前计算 = 值\r\n结束 函数\r\n";
	const properties = "$属性\r\n$资源 $对象\r\n$结束 $属性\r\n";
	const cache = { identity: {}, generation: 1 };
	const context = index.contextForFile(file, code + properties, undefined, [], cache);
	assert.equal(context?.standalone, true);
	assert.equal(context?.currentUnit?.name, "独立单元");
	assert.equal(context?.currentUnit?.definition.functions?.[0]?.name, "当前计算");
	assert.equal(index.contextForFile(file, code + properties, undefined, [], cache), context);
	const changed = index.contextForFile(file, code.replaceAll("当前计算", "新计算") + properties, undefined, [], cache);
	assert.equal(changed?.currentUnit?.definition.functions?.[0]?.name, "新计算");

	/* 用户代码标签已经有 XML 模型时，不从另一份属性原文推断单元种类。 */
	const property = inspectSimplePropertyXml("$属性\r\n$资源 $窗口\r\n$结束 $属性\r\n");
	const shared = index.contextForFile(file, code, property);
	assert.equal(shared?.standalone, true);
	assert.equal(shared?.currentUnit?.unitType, "窗口");
	assert.equal(index.contextForFile(file), undefined);
});

test("原生未保存符号参与跨单元分析并使缓存失效，共享 XML 会话仍优先", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-native-source-symbols-"));
	const sourceRoot = path.join(directory, "src");
	const targetFile = path.join(sourceRoot, "Target.simple");
	const callerFile = path.join(sourceRoot, "Caller.simple");
	const propertySource = "$属性\r\n$资源 $对象\r\n$结束 $属性\r\n";
	const callerSource = "变量 数据 为 Target\r\n" + propertySource;
	try {
		await fs.mkdir(sourceRoot, { recursive: true });
		await fs.writeFile(targetFile, "常量 原生成员 为 整数型 = 7\r\n" + propertySource);
		await fs.writeFile(callerFile, callerSource);
		const index = new ProjectSymbolIndex();
		await index.updateProjects([{
			directory, filePath: path.join(directory, "project.properties"), name: "原生文档符号", properties: {},
			sourceDirectories: [sourceRoot], assetsDirectory: path.join(directory, "assets"),
			buildDirectory: path.join(directory, "build"), resourceDirectory: path.join(directory, "res")
		}]);
		const cache = { identity: {}, generation: 1 };
		const native = parseSimpleUnitSymbols("变量 原生成员 为 整数型\r\n" + propertySource, targetFile, sourceRoot);
		const context = index.contextForFile(callerFile, callerSource, undefined, [], cache, [native]);
		assert.equal(context?.standalone, undefined);
		assert.equal(context?.units?.find((unit) => unit.filePath === targetFile), native);
		assert.equal(native.definition.variables?.[0]?.name, "原生成员");
		assert.equal(native.definition.constants?.length ?? 0, 0);

		/* 调用方代次不变时，新符号输入仍必须使上下文缓存失效。 */
		const next = parseSimpleUnitSymbols("常量 新成员 为 整数型 = 8\r\n" + propertySource, targetFile, sourceRoot);
		const changed = index.contextForFile(callerFile, callerSource, undefined, [], cache, [next]);
		assert.equal(changed?.units?.find((unit) => unit.filePath === targetFile)?.definition.constants?.[0]?.name, "新成员");
		const restored = index.contextForFile(callerFile, callerSource, undefined, [], cache);
		assert.equal(restored?.units?.find((unit) => unit.filePath === targetFile)?.definition.constants?.[0]?.name, "原生成员");

		/* 同一路径存在 ES4A 代码标签时，仍以其代码和共享 XML 状态为准。 */
		const shared = {
			filePath: targetFile, userCode: "变量 会话成员 为 整数型\r\n",
			property: inspectSimplePropertyXml("$属性\r\n$资源 $窗口\r\n$结束 $属性\r\n")
		};
		const sharedContext = index.contextForFile(callerFile, callerSource, undefined, [shared], cache, [native]);
		const sharedUnit = sharedContext?.units?.find((unit) => unit.filePath === targetFile);
		assert.equal(sharedUnit?.unitType, "窗口");
		assert.equal(sharedUnit?.definition.variables?.[0]?.name, "会话成员");
	} finally {
		await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

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
