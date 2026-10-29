/*
验证覆盖式滚动条的比例、边界和最小命中长度，不依赖操作系统原生滚动条宽度。
xhwsd@qq.com 2026-10-27
*/

import assert from "node:assert/strict";
import { test } from "node:test";
import { designerScrollbarGeometry } from "../designer/designerScrollbars";

test("覆盖式滑块按真实滚动范围覆盖首尾和中点", () => {
	const start = designerScrollbarGeometry(200, 800, 0, 196);
	const middle = designerScrollbarGeometry(200, 800, 300, 196);
	const end = designerScrollbarGeometry(200, 800, 600, 196);
	assert.equal(start.length, 49);
	assert.equal(start.start, 0);
	assert.equal(middle.start, 73.5);
	assert.equal(end.start + end.length, 196);
});

test("极长内容仍保留可拖动长度，短轨道不会出现反向移动范围", () => {
	const long = designerScrollbarGeometry(100, 100000, 99900, 96);
	assert.equal(long.length, 24);
	assert.equal(long.start + long.length, 96);
	const short = designerScrollbarGeometry(10, 1000, 500, 6);
	assert.equal(short.length, 6);
	assert.equal(short.travel, 0);
	assert.equal(short.start, 0);
});

test("内容未溢出或偏移暂时越界时不生成非法滑块坐标", () => {
	assert.deepEqual(designerScrollbarGeometry(200, 100, 0, 196), { length: 196, range: 0, start: 0, travel: 0 });
	assert.equal(designerScrollbarGeometry(200, 800, -10, 196).start, 0);
	assert.equal(designerScrollbarGeometry(200, 800, 900, 196).start, 147);
});
