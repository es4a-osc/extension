/*
验证 Simple 项目公共路径规则在大小写、目录边界、嵌套源码根和限定名上的行为。
xhwsd@qq.com 2026-9-2
*/

import * as assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import {
	filePathKey,
	isPathInside,
	isPathInsideOrEqual,
	mostSpecificSourceRoot,
	sameFilePath,
	simpleQualifiedName
} from "../simpleProjectPaths";

test("公共路径身份和目录包含规则拒绝相似前缀与父目录", () => {
	const root = path.resolve("E:\\Project\\src");
	const nested = path.join(root, "simple", "tests", "Target.simple");

	assert.equal(sameFilePath(root, path.join(root, ".")), true);
	assert.equal(filePathKey(root), filePathKey(path.join(root, ".")));
	assert.equal(isPathInside(root, nested), true);
	assert.equal(isPathInside(root, root), false);
	assert.equal(isPathInsideOrEqual(root, root), true);
	assert.equal(isPathInside(root, path.resolve("E:\\Project\\src-other\\Target.simple")), false);
	assert.equal(isPathInside(root, path.resolve("E:\\Project\\Target.simple")), false);
});

test("嵌套源码根选择最具体目录并生成稳定限定名", () => {
	const broadRoot = path.resolve("E:\\Project\\src");
	const specificRoot = path.join(broadRoot, "generated");
	const filePath = path.join(specificRoot, "simple", "tests", "Target.simple");

	assert.equal(mostSpecificSourceRoot([broadRoot, specificRoot], filePath), specificRoot);
	assert.equal(simpleQualifiedName(specificRoot, filePath), "simple.tests.Target");
	assert.equal(mostSpecificSourceRoot([path.resolve("E:\\Other")], filePath), undefined);
});
