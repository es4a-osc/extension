/*
使用真实 Simple 单元验证用户代码切分与属性区无损合并。
xhwsd@qq.com 2026-8-27
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { test } from "node:test";
import {
	assembleSimpleUnitSource,
	findPropertySectionStart,
	getVisibleSimpleUnitUserCode,
	mergeSimpleUnitUserCode,
	splitSimpleUnitSource
} from "../simpleUnitSource";
import {
	decodeSimpleSource,
	detectSimpleSourceEncoding
} from "../simpleSourceEncoding";
import { simpleTestProjectPath } from "./testProjects";

test("统一解码 UTF-8 BOM、UTF-16 LE 和 UTF-16 BE 单元", () => {
	const source = "$属性\r\n\t$资源 $窗口\r\n$结束 $属性\r\n";
	const utf8Bom = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(source, "utf8")]);
	const utf16Le = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(source, "utf16le")]);
	const utf16BeBody = Buffer.from(source, "utf16le");
	utf16BeBody.swap16();
	const utf16Be = Buffer.concat([Buffer.from([0xFE, 0xFF]), utf16BeBody]);

	assert.equal(detectSimpleSourceEncoding(utf8Bom), "utf8bom");
	assert.equal(detectSimpleSourceEncoding(utf16Le), "utf16le");
	assert.equal(detectSimpleSourceEncoding(utf16Be), "utf16be");
	assert.equal(decodeSimpleSource(utf8Bom), source);
	assert.equal(decodeSimpleSource(utf16Le), source);
	assert.equal(decodeSimpleSource(utf16Be), source);
});

test("按编译器的倒数第二个属性标记切分单元", () => {
	const source = "过程 Run()\r\n结束 过程\r\n\r\n$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n";
	const sections = splitSimpleUnitSource(source);

	assert.equal(sections.userCode, "过程 Run()\r\n结束 过程\r\n\r\n");
	assert.equal(sections.propertySource, "$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n");
	assert.equal(findPropertySectionStart("只有一个 $属性"), "只有一个 $属性".length);
});

test("用户代码视图不显示属性区前的结构换行", () => {
	const propertySource = "$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n";

	assert.equal(
		getVisibleSimpleUnitUserCode(`过程 Run()\r\n结束 过程\r\n${propertySource}`),
		"过程 Run()\r\n结束 过程"
	);
	assert.equal(
		getVisibleSimpleUnitUserCode(`过程 Run()\r\n结束 过程\r\n\r\n${propertySource}`),
		"过程 Run()\r\n结束 过程\r\n"
	);
});

test("真实 SmokeTest 和 Tetris 单元可无损切分并重组", async () => {
	const unitFiles = [
		simpleTestProjectPath("SmokeTest", "src", "simple", "smoketest", "SmokeTest.simple"),
		simpleTestProjectPath("Tetris", "src", "simple", "samples", "tetris", "Tetris.simple")
	];

	for (const unitFile of unitFiles) {
		const source = await fs.readFile(unitFile, "utf8");
		const sections = splitSimpleUnitSource(source);

		assert.ok(sections.userCode.length > 0, `${unitFile} 没有切出用户代码`);
		assert.match(sections.propertySource, /^\$属性/u);
		assert.equal(mergeSimpleUnitUserCode(source, getVisibleSimpleUnitUserCode(source)), source);
	}
});

test("Tetris 用户代码视图隐藏属性区前的结构换行并保留更早的空行", async () => {
	const unitFile = simpleTestProjectPath(
		"Tetris",
		"src",
		"simple",
		"samples",
		"tetris",
		"Bar.simple"
	);
	const source = await fs.readFile(unitFile, "utf8");
	const userCode = getVisibleSimpleUnitUserCode(source);
	const sourcePrefix = source.slice(0, findPropertySectionStart(source));

	assert.equal(userCode, sourcePrefix.replace(/(?:\r\n|\n|\r)$/u, ""));
	assert.equal(
		mergeSimpleUnitUserCode(source, userCode),
		source
	);
});

test("合并编辑后代码时逐字保留用户换行、属性原文和 BOM", () => {
	const propertySource = "$属性\r\n\t$未知 = \"原值\"\r\n$结束 $属性\r\n";
	const source = `\uFEFF过程 Run()\r\n结束 过程\r\n\r\n\r\n\r\n${propertySource}`;
	const changedCode = "过程 Changed()\r\n结束 过程\r\n\r\n\r\n";
	const merged = mergeSimpleUnitUserCode(source, changedCode);
	const sections = splitSimpleUnitSource(merged);

	assert.equal(getVisibleSimpleUnitUserCode(merged), `\uFEFF${changedCode}`);
	assert.equal(sections.propertySource, propertySource);
});

test("使用 XML 生成的属性源码组装完整单元", () => {
	const source = "\uFEFF过程 Before()\r\n结束 过程\r\n\r\n$属性\r\n\t$资源 $对象\r\n$结束 $属性\r\n";
	const generatedPropertySource = "$属性\r\n\t$资源 $接口\r\n$结束 $属性\r\n";
	const merged = assembleSimpleUnitSource(
		source,
		"过程 After()\r\n结束 过程\r\n",
		generatedPropertySource
	);

	assert.equal(
		merged,
		"\uFEFF过程 After()\r\n结束 过程\r\n\r\n" + generatedPropertySource
	);
});

test("组装属性区时在非空用户代码后补一个不可见的结构换行", () => {
	const propertySource = "$属性\n\t$资源 $对象\n$结束 $属性\n";

	assert.equal(
		assembleSimpleUnitSource(propertySource, "过程 Run()\n结束 过程", propertySource),
		`过程 Run()\n结束 过程\n${propertySource}`
	);
	assert.equal(
		assembleSimpleUnitSource(propertySource, "过程 Run()\n结束 过程\n", propertySource),
		`过程 Run()\n结束 过程\n\n${propertySource}`
	);
	assert.equal(assembleSimpleUnitSource(propertySource, "", propertySource), propertySource);
	assert.equal(
		assembleSimpleUnitSource(`\uFEFF${propertySource}`, "", propertySource),
		`\uFEFF${propertySource}`
	);
});

test("没有完整属性区的文件整体视为用户代码", () => {
	const source = "过程 Run()\n结束 过程\n";

	assert.deepEqual(splitSimpleUnitSource(source), {
		propertySource: "",
		userCode: source
	});
	assert.equal(mergeSimpleUnitUserCode(source, "过程 Changed()\n结束 过程\n"), "过程 Changed()\n结束 过程\n");
});

test("损坏属性区仍与用户代码分离并在保存时原样保留", () => {
	const userCode = "这不是合法的 Simple 代码\r\n";
	const brokenPropertySource = "$属性\r\n\t$资源 $窗口\r\n\t损坏属性行\r\n";
	const source = userCode + brokenPropertySource;

	assert.deepEqual(splitSimpleUnitSource(source), {
		propertySource: brokenPropertySource,
		userCode
	});
	assert.equal(getVisibleSimpleUnitUserCode(source), "这不是合法的 Simple 代码");
	assert.equal(
		mergeSimpleUnitUserCode(source, "修改后的错误代码"),
		"修改后的错误代码\r\n" + brokenPropertySource
	);
});

