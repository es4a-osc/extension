/*
验证关键字成员与运算符在补全、着色、签名、悬停和引用诊断中保持区分。
xhwsd@qq.com 2026-10-16
*/

import * as assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { provideSimpleCompletions } from "../completionModel";
import { buildCompilerTokenRules, buildDocumentTokenRules, tokenizeSimpleText } from "../compilerTokens";
import { findSimpleKeywordHover } from "../keywordHover";
import { createSimplePropertyXmlDocument } from "../propertyXml";
import { analyzeSimpleReferences } from "../referenceDiagnostics";
import { refactoringContext, type RefactoringUnit } from "../refactoringModel";
import { loadSdk } from "../sdk";
import { buildSdkSignatures, findCallContext } from "../signatures";
import { testSdkPath } from "./testFixtures";

test("点号后的匹配是运行库方法，普通表达式中的匹配仍是运算符", async () => {
	const sdk = await loadSdk(testSdkPath("sdk.json"));
	const source = [
		"过程 Run()",
		"\t变量 表达式 为 正则表达式",
		"\t表达式 = 创建 正则表达式",
		"\t表达式.匹配(\"apple=12\")",
		"\t变量 通过 为 逻辑型",
		"\t通过 = \"abc\" 匹配 \"a.*\"",
		"结束 过程",
		""
	].join("\r\n");
	const unit: RefactoringUnit = {
		filePath: path.resolve("C:/keyword-members/src/Check.simple"),
		sourceRoot: path.resolve("C:/keyword-members/src"),
		userCode: source,
		property: { document: createSimplePropertyXmlDocument("对象", "Check"), status: "valid", issues: [] }
	};
	const context = refactoringContext(unit, [unit]);
	const memberStart = source.indexOf("表达式.匹配(") + "表达式.".length;
	const completions = provideSimpleCompletions(source, memberStart, sdk, context);
	assert.ok(completions?.candidates.some((candidate) => candidate.name === "匹配" && candidate.kind === "function"));
	const tokens = tokenizeSimpleText(source, [
		...buildCompilerTokenRules(sdk), ...buildDocumentTokenRules(source, sdk, context)
	]);
	assert.deepEqual(tokens.filter((token) => token.text === "匹配").map((token) => token.type), ["method", "operator"]);
	const call = findCallContext(source, memberStart + "匹配(".length);
	assert.equal(call?.name, "匹配");
	assert.equal(call?.qualifier, "表达式");
	const signature = buildSdkSignatures(sdk).find((value) => value.owner === "正则表达式" && value.name === "匹配");
	assert.equal(signature?.parameters[0]?.type, "文本型");
	assert.match(findSimpleKeywordHover(source, memberStart, sdk, context)?.signature ?? "", /匹配\(文本 为 文本型\)/u);
	const operatorStart = source.indexOf('"abc" 匹配') + '"abc" '.length;
	assert.equal(findSimpleKeywordHover(source, operatorStart, sdk, context)?.kind, "operator");
	const unknownSource = source.replace("表达式.匹配(", "不存在.匹配(");
	assert.equal(findSimpleKeywordHover(unknownSource, unknownSource.indexOf("不存在.匹配") + "不存在.".length, sdk, context), undefined);
	assert.deepEqual(analyzeSimpleReferences(source, sdk, context), []);
});
