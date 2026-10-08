/*
验证 Simple 项目资源目录枚举、单元名称和属性 XML 元数据识别。
xhwsd@qq.com 2026-8-27
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	listProgramDirectory,
	loadSimpleProject,
	programDirectoryExists,
	readSimpleUnitMetadata,
	readSimpleUnitType
} from "../programResources";
import { simpleTestProjectPath } from "./testProjects";

const SMOKE_TEST_DIRECTORY = simpleTestProjectPath("SmokeTest");

test("从 project.properties 加载 SmokeTest 项目目录映射", async () => {
	const projectFile = path.join(SMOKE_TEST_DIRECTORY, "project.properties");
	const project = await loadSimpleProject(projectFile);

	assert.equal(project.name, "SmokeTest");
	assert.equal(project.filePath, projectFile);
	assert.deepEqual(project.sourceDirectories, [path.join(SMOKE_TEST_DIRECTORY, "src")]);
	assert.equal(project.assetsDirectory, path.join(SMOKE_TEST_DIRECTORY, "assets"));
	assert.equal(project.resourceDirectory, path.join(SMOKE_TEST_DIRECTORY, "res"));
	assert.equal(await programDirectoryExists(project.assetsDirectory), true);
	assert.equal(await programDirectoryExists(project.resourceDirectory), true);
});

test("单元目录保留文件夹层级并隐藏 simple 后缀", async () => {
	const sourceDirectory = path.join(SMOKE_TEST_DIRECTORY, "src");
	const sourceEntries = await listProgramDirectory(sourceDirectory, "units");
	assert.deepEqual(sourceEntries.map((entry) => [entry.kind, entry.label]), [
		["directory", "simple"]
	]);

	const packageEntries = await listProgramDirectory(
		path.join(sourceDirectory, "simple", "smoketest"),
		"units"
	);
	assert.deepEqual(packageEntries.slice(0, 4).map((entry) => entry.label), [
		"conversions",
		"expressions",
		"scopes",
		"statements"
	]);
	assert.equal(packageEntries.some((entry) => entry.label.endsWith(".simple")), false);
	assert.equal(
		packageEntries.find((entry) => entry.label === "SmokeTest")?.unitType,
		"对象"
	);
	assert.equal(
		packageEntries.find((entry) => entry.label === "Test")?.unitType,
		"接口"
	);
});

test("单元目录忽略非 simple 文件，资源目录保留普通文件", async () => {
	const unitEntries = await listProgramDirectory(SMOKE_TEST_DIRECTORY, "units");
	const resourceEntries = await listProgramDirectory(SMOKE_TEST_DIRECTORY, "resources");

	assert.equal(unitEntries.some((entry) => entry.label === "project.properties"), false);
	assert.equal(resourceEntries.some((entry) => entry.label === "project.properties"), true);
});

test("代码和属性区损坏的 Simple 文件仍作为单元列出", async () => {
	const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-broken-units-"));
	try {
		await fs.writeFile(
			path.join(temporaryDirectory, "错误代码.simple"),
			"这不是合法的 Simple 代码\r\n",
			"utf8"
		);
		await fs.writeFile(
			path.join(temporaryDirectory, "损坏属性.simple"),
			"过程 Run()\r\n结束 过程\r\n$属性\r\n\t$资源 $窗口\r\n",
			"utf8"
		);

		const entries = await listProgramDirectory(temporaryDirectory, "units");
		assert.deepEqual(entries.map((entry) => [entry.kind, entry.label]), [
			["unit", "错误代码"],
			["unit", "损坏属性"]
		]);
	} finally {
		await fs.rm(temporaryDirectory, { force: true, recursive: true });
	}
});

test("单元目录优先复用已有元数据", async () => {
	const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-known-unit-"));
	const filePath = path.join(temporaryDirectory, "Known.simple");
	try {
		await fs.writeFile(filePath, "无法提供属性元数据", "utf8");
		const entries = await listProgramDirectory(
			temporaryDirectory,
			"units",
			(candidate) => candidate === filePath
				? {
					baseObject: "simple.Base",
					interfaces: ["simple.Contract"],
					unitType: "对象"
				}
				: undefined
		);

		assert.deepEqual(entries, [{
			baseObject: "simple.Base",
			interfaces: ["simple.Contract"],
			kind: "unit",
			label: "Known",
			path: filePath,
			unitType: "对象"
		}]);
	} finally {
		await fs.rm(temporaryDirectory, { force: true, recursive: true });
	}
});

test("项目树从 UTF-16 单元一次读取类型与继承元数据", async () => {
	const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-unit-type-"));
	const filePath = path.join(temporaryDirectory, "Utf16Window.simple");
	const source = [
		"$属性",
		"\t$资源 $对象",
		"\t基础对象 = simple.Base",
		"\t实现接口 = simple.First, simple.Second",
		"$结束 $属性",
		""
	].join("\r\n");
	try {
		await fs.writeFile(
			filePath,
			Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(source, "utf16le")])
		);
		assert.deepEqual(await readSimpleUnitMetadata(filePath), {
			baseObject: "simple.Base",
			interfaces: ["simple.First", "simple.Second"],
			unitType: "对象"
		});
		assert.equal(await readSimpleUnitType(filePath), "对象");
	} finally {
		await fs.rm(temporaryDirectory, { force: true, recursive: true });
	}
});
