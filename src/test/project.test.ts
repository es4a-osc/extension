/*
验证项目属性解析与项目模型构建。
xhwsd@qq.com 2026-8-27
*/

import * as assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import {
	createProjectInfo,
	parseProjectProperties,
	updateProjectProperty
} from "../project";

test("解析 Simple 项目属性", () => {
	const properties = parseProjectProperties(`
# 项目说明
main=simple.samples.demo.主窗口
name = 中文\\u9879\\u76ee
version.code: 2
source=./src, \\
  ./generated
escaped\\ key=escaped\\ value
`);

	assert.equal(properties.main, "simple.samples.demo.主窗口");
	assert.equal(properties.name, "中文项目");
	assert.equal(properties["version.code"], "2");
	assert.equal(properties.source, "./src, ./generated");
	assert.equal(properties["escaped key"], "escaped value");
});

test("项目模型提供当前编译器约定的目录默认值", () => {
	const projectFile = path.join("C:\\workspace", "demo", "project.properties");
	const info = createProjectInfo(projectFile, {
		main: "demo.主窗口",
		name: "演示"
	});

	assert.equal(info.name, "演示");
	assert.equal(info.main, "demo.主窗口");
	assert.deepEqual(info.sourceDirectories, [path.resolve(info.directory, "src")]);
	assert.equal(info.assetsDirectory, path.resolve(info.directory, "assets"));
	assert.equal(info.resourceDirectory, path.resolve(info.directory, "res"));
	assert.equal(info.buildDirectory, path.resolve(info.directory, "build"));
	assert.equal(createProjectInfo(projectFile, {}).name, "demo");
});

test("更新项目属性保留注释、顺序和原换行", () => {
	const source = [
		"# 应用名称",
		"name = 旧名称",
		"version.code=1",
		"name=最终名称",
		"source=./src",
		""
	].join("\r\n");
	const updated = updateProjectProperty(source, "name", "应用更新");

	assert.equal(updated, [
		"# 应用名称",
		"name = 旧名称",
		"version.code=1",
		"name=应用更新",
		"source=./src",
		""
	].join("\r\n"));
});

test("项目属性不存在时追加且不改动既有内容", () => {
	assert.equal(
		updateProjectProperty("name=应用更新\n", "theme", "@android:style/Theme.Material.Light"),
		"name=应用更新\ntheme=@android:style/Theme.Material.Light\n"
	);
});
