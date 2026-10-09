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
	updateProjectProperty,
	updateProjectMainForRenamedUnits
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

test("主窗口随包目录改名时只更新有效 main，保留注释、重复键和其它属性", () => {
	const projectFile = path.resolve("project", "project.properties");
	const source = "# 主窗口\r\nmain=legacy.主窗口\r\n  main : old.nested.主窗口\r\nsource=./src\r\n未知字段=保留\r\n";
	const changed = updateProjectMainForRenamedUnits(source, projectFile, [{
		oldFile: path.resolve("project", "src", "old", "nested", "主窗口.simple"),
		newFile: path.resolve("project", "src", "new", "nested", "主窗口.simple")
	}]);
	assert.equal(changed, source.replace("main : old.nested.主窗口", "main : new.nested.主窗口"));
	assert.equal(updateProjectMainForRenamedUnits(source, projectFile, []), undefined);
	assert.equal(updateProjectMainForRenamedUnits(source, projectFile, [{
		oldFile: path.resolve("project", "src", "old", "其他窗口.simple"),
		newFile: path.resolve("project", "src", "new", "其他窗口.simple")
	}]), undefined);
});

test("主窗口限定名使用最具体源码根，未配置或相似前缀的 main 不改写", () => {
	const projectFile = path.resolve("project", "project.properties");
	const units = [{
		oldFile: path.resolve("project", "src", "nested", "old", "主窗口.simple"),
		newFile: path.resolve("project", "src", "nested", "new", "主窗口.simple")
	}];
	const source = "source=./src,./src/nested\nmain=old.主窗口\n";
	assert.equal(updateProjectMainForRenamedUnits(source, projectFile, units), source.replace("old.主窗口", "new.主窗口"));
	assert.equal(updateProjectMainForRenamedUnits(source.replace("main=old.主窗口\n", ""), projectFile, units), undefined);
	assert.equal(updateProjectMainForRenamedUnits(source.replace("old.主窗口", "old.主窗口2"), projectFile, units), undefined);
});

test("主窗口改名离开源码根或 main 延续行无法保持时拒绝生成修改", () => {
	const projectFile = path.resolve("project", "project.properties");
	const unit = {
		oldFile: path.resolve("project", "src", "old", "主窗口.simple"),
		newFile: path.resolve("project", "other", "new", "主窗口.simple")
	};
	assert.throws(() => updateProjectMainForRenamedUnits("main=old.主窗口\n", projectFile, [unit]), /不属于项目源码目录/u);
	assert.throws(() => updateProjectMainForRenamedUnits("main=old.\\\n  主窗口\n", projectFile, [{
		...unit, newFile: path.resolve("project", "src", "new", "主窗口.simple")
	}]), /暂不支持的属性排版/u);
});

test("主窗口文件改名完整匹配限定名，仅替换 main 的单元名", () => {
	const projectFile = path.resolve("project", "project.properties");
	const source = "main=demo.主窗口\r\nsource=./src\r\nunknown=demo.主窗口\r\n";
	const unit = {
		oldFile: path.resolve("project", "src", "demo", "主窗口.simple"),
		newFile: path.resolve("project", "src", "demo", "新主窗口.simple")
	};
	assert.equal(updateProjectMainForRenamedUnits(source, projectFile, [unit]), source.replace("main=demo.主窗口", "main=demo.新主窗口"));
	assert.equal(updateProjectMainForRenamedUnits(source, projectFile, [{
		...unit, oldFile: path.resolve("project", "src", "other", "主窗口.simple")
	}]), undefined);
});
