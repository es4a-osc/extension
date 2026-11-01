/*
验证项目代码搜索只读取单元用户代码、遵循文件夹范围并优先采用未保存快照。
xhwsd@qq.com 2026-9-1
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	findProjectCodeMatches,
	loadProjectCodeDocuments,
	projectCodePathKey
} from "../projectCodeSearch";
import { simpleTestProjectPath } from "./testProjects";

const SMOKE_TEST_SOURCE = simpleTestProjectPath("SmokeTest", "src");

test("项目范围只加载 Simple 单元的用户代码", async () => {
	const documents = await loadProjectCodeDocuments([SMOKE_TEST_SOURCE]);
	const scopes = documents.find((document) => document.filePath.endsWith(`scopes${path.sep}ScopesTest.simple`));

	assert.ok(scopes);
	assert.match(scopes.userCode, /函数 Name\(\) 为 文本型/u);
	assert.doesNotMatch(scopes.userCode, /\$属性/u);
	assert.equal(findProjectCodeMatches(documents, "$属性").matches.length, 0);
});

test("文件夹范围只加载该目录及其子目录中的单元", async () => {
	const scopesDirectory = path.join(SMOKE_TEST_SOURCE, "simple", "smoketest", "scopes");
	const documents = await loadProjectCodeDocuments([scopesDirectory]);

	assert.deepEqual(
		documents.map((document) => path.basename(document.filePath)),
		["ScopesTest.simple"]
	);
});

test("已打开单元的未保存用户代码优先于磁盘内容", async () => {
	const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-code-search-"));
	const filePath = path.join(temporaryDirectory, "Example.simple");
	await fs.writeFile(filePath, [
		"变量 diskValue 为 文本型",
		"$属性",
		"\t$资源 $对象",
		"\t基础对象 = simple.Hidden",
		"$结束 $属性",
		""
	].join("\r\n"));

	const documents = await loadProjectCodeDocuments(
		[temporaryDirectory],
		(candidate) => projectCodePathKey(candidate) === projectCodePathKey(filePath)
			? "变量 unsavedValue 为 文本型"
			: undefined
	);

	assert.equal(findProjectCodeMatches(documents, "unsavedvalue").matches.length, 1);
	assert.equal(findProjectCodeMatches(documents, "diskValue").matches.length, 0);
	assert.equal(findProjectCodeMatches(documents, "基础对象").matches.length, 0);
});

test("普通文本搜索不区分大小写并按代码行返回首个命中范围", () => {
	const result = findProjectCodeMatches([{
		filePath: "Example.simple",
		userCode: "Name = \"First\"\r\n调用 Name() 和 Name()"
	}], "name");

	assert.equal(result.limitHit, false);
	assert.deepEqual(result.matches.map((match) => ({
		endCharacter: match.endCharacter,
		lineNumber: match.lineNumber,
		startCharacter: match.startCharacter
	})), [
		{ endCharacter: 4, lineNumber: 0, startCharacter: 0 },
		{ endCharacter: 7, lineNumber: 1, startCharacter: 3 }
	]);
});

test("Unicode 大小写扩展后的命中范围仍指向原文，包括扩展字符本身及后续文本", () => {
	const line = "变量 İ名 为 整数型:目标 = 1:𐐀名 = 2";
	for (const [query, selected] of [["目标", "目标"], ["i", "İ"], ["İ名", "İ名"], ["𐐨名", "𐐀名"], ["= 1", "= 1"]]) {
		const match = findProjectCodeMatches([{ filePath: "Example.simple", userCode: line }], query!).matches[0]!;
		assert.equal(line.slice(match.startCharacter, match.endCharacter), selected);
		assert.equal(match.startCharacter, line.indexOf(selected!));
	}
});

test("Unicode 上下文大小写不漏掉精确子串，兼容扩展字符并按原文先后返回", () => {
	for (const [line, query, expected] of [
		["变量 ΟΣΑ 为 整数型", "ΟΣ", "ΟΣ"],
		["变量 ΣΟΣΑ 为 整数型", "ΣΟΣ", "ΣΟΣ"],
		["οσΑ ΟΣΑ", "ος", "οσ"],
		["İ i", "i", "İ"],
		["[a].* [A].*", "[A].*", "[a].*"]
	]) {
		const match = findProjectCodeMatches([{ filePath: "Example.simple", userCode: line! }], query!).matches[0]!;
		assert.ok(match);
		assert.equal(line!.slice(match.startCharacter, match.endCharacter), expected);
		assert.equal(match.startCharacter, line!.indexOf(expected!));
	}
});
