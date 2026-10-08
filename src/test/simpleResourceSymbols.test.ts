/*
验证扩展只根据项目 res 目录建立 Simple 的 R 资源符号索引。
xhwsd@qq.com 2026-9-8
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { SimpleProjectInfo } from "../project";
import {
	indexSimpleProjectResources,
	simpleResourceReferenceForFile
} from "../simpleResourceSymbols";

/** 构造只供资源索引测试使用的最小项目模型。 */
function projectInfo(directory: string): SimpleProjectInfo {
	return {
		assetsDirectory: path.join(directory, "assets"),
		buildDirectory: path.join(directory, "build"),
		directory,
		filePath: path.join(directory, "project.properties"),
		main: "sample.app.Main",
		name: "资源测试",
		properties: {},
		resourceDirectory: path.join(directory, "res"),
		sourceDirectories: [path.join(directory, "src")]
	};
}

test("只扫描 res 文件和 XML 声明并合并限定目录中的同名资源", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-resource-symbols-"));
	const res = path.join(directory, "res");
	try {
		await Promise.all([
			fs.mkdir(path.join(res, "drawable"), { recursive: true }),
			fs.mkdir(path.join(res, "drawable-v24"), { recursive: true }),
			fs.mkdir(path.join(res, "menu"), { recursive: true }),
			fs.mkdir(path.join(res, "values"), { recursive: true }),
			fs.mkdir(path.join(directory, "build", "res"), { recursive: true })
		]);
		await Promise.all([
			fs.writeFile(path.join(res, "drawable", "icon.png"), "image", "utf8"),
			fs.writeFile(path.join(res, "drawable", "login.9.png"), "image", "utf8"),
			fs.writeFile(path.join(res, "drawable-v24", "icon.xml"), "<shape />", "utf8"),
			fs.writeFile(path.join(res, "menu", "test.xml"), [
				"<menu>",
				"	<!-- android:id=\"@+id/commented\" -->",
				"	<item android:id=\"@+id/account\" />",
				"</menu>"
			].join("\n"), "utf8"),
			fs.writeFile(path.join(res, "values", "values.xml"), [
				"<resources>",
				"	<string name=\"app_name\">应用</string>",
				"	<style name=\"Theme.App\">",
				"		<item name=\"colorAccent\">#ffffff</item>",
				"	</style>",
				"	<declare-styleable name=\"Card\"><attr name=\"custom_title\" format=\"string\" /></declare-styleable>",
				"	<string-array name=\"names\"><item>一</item></string-array>",
				"	<item type=\"id\" name=\"manual\" />",
				"</resources>"
			].join("\n"), "utf8"),
			fs.writeFile(
				path.join(directory, "build", "res", "R.txt"),
				"int drawable generated_only 0x7f010000\n",
				"utf8"
			)
		]);

		const index = await indexSimpleProjectResources(projectInfo(directory));
		assert.equal(index.objectQualifiedName, "sample.app.SimpleResources");
		assert.deepEqual(index.symbols.map((symbol) => symbol.name), [
			"array_names",
			"attr_custom_title",
			"drawable_icon",
			"drawable_login",
			"id_account",
			"id_manual",
			"menu_test",
			"string_app_name",
			"style_Theme_App"
		]);
		assert.equal(
			index.symbols.find((symbol) => symbol.name === "drawable_icon")?.sourceFiles.length,
			2
		);
		assert.equal(
			index.symbols.find((symbol) => symbol.name === "drawable_icon")?.sourceFiles[0],
			path.join(res, "drawable", "icon.png")
		);
		assert.equal(index.symbols.some((symbol) => symbol.name.includes("commented")), false);
		assert.equal(index.symbols.some((symbol) => symbol.name.includes("colorAccent")), false);
		assert.equal(index.symbols.some((symbol) => symbol.name.includes("generated_only")), false);
		assert.equal(
			simpleResourceReferenceForFile(res, path.join(res, "drawable", "icon.png")),
			"R.drawable_icon"
		);
		assert.equal(
			simpleResourceReferenceForFile(res, path.join(res, "drawable", "login.9.png")),
			"R.drawable_login"
		);
		assert.equal(
			simpleResourceReferenceForFile(res, path.join(res, "values", "values.xml")),
			undefined
		);
	} finally {
		await fs.rm(directory, { force: true, recursive: true });
	}
});

test("res 不存在时返回不含成员的独立资源对象", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-empty-resource-symbols-"));
	try {
		const index = await indexSimpleProjectResources(projectInfo(directory));
		assert.equal(index.objectQualifiedName, "sample.app.SimpleResources");
		assert.deepEqual(index.symbols, []);
	} finally {
		await fs.rm(directory, { force: true, recursive: true });
	}
});
