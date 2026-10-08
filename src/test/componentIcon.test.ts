/*
验证 SDK 组件图标的清单相对路径、安全边界、主题数据源与缺省回退。
xhwsd@qq.com 2026-8-29
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	createComponentIconSources,
	resolveDefinitionIconPath
} from "../componentIcon";
import type { LibraryDefinitionReference, LibraryManifest } from "../sdk";

const VALID_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 4h16v16H4z" /></svg>';

/** 创建只含一个定义的最小清单引用。 */
function reference(directory: string, icon: unknown): LibraryDefinitionReference {
	const manifest: LibraryManifest = {
		categories: [],
		directory,
		filePath: path.join(directory, "runtime.json"),
		name: "测试运行库"
	};
	return {
		definition: { icon: icon as string, kind: "component", name: "测试组件" },
		manifest
	};
}

test("组件图标只接受清单目录内安全的 24×24 SVG", async (context) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-component-icon-"));
	context.after(() => fs.rm(directory, { force: true, recursive: true }));
	const iconDirectory = path.join(directory, "icon");
	const validPath = path.join(iconDirectory, "valid.svg");
	const unsafePath = path.join(iconDirectory, "unsafe.svg");
	const incompletePath = path.join(iconDirectory, "incomplete.svg");
	await fs.mkdir(iconDirectory);
	await fs.writeFile(validPath, VALID_SVG, "utf8");
	await fs.writeFile(unsafePath, VALID_SVG.replace("</svg>", "<script>alert(1)</script></svg>"), "utf8");
	await fs.writeFile(incompletePath, VALID_SVG.slice(0, -6), "utf8");

	assert.equal(resolveDefinitionIconPath(reference(directory, "icon/valid.svg")), validPath);
	assert.equal(resolveDefinitionIconPath(reference(directory, "../outside.svg")), undefined);
	assert.equal(resolveDefinitionIconPath(reference(directory, "icon/unsafe.svg")), undefined);
	assert.equal(resolveDefinitionIconPath(reference(directory, "icon/incomplete.svg")), undefined);
	assert.equal(resolveDefinitionIconPath(reference(directory, "icon/missing.svg")), undefined);
	assert.equal(resolveDefinitionIconPath(reference(directory, 24)), undefined);
});

test("组件图标生成主题数据 URI 并在声明缺失时使用扩展缺省图标", async (context) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-component-icon-source-"));
	context.after(() => fs.rm(directory, { force: true, recursive: true }));
	const defaultPath = path.join(directory, "default.svg");
	await fs.writeFile(defaultPath, VALID_SVG, "utf8");

	const sources = createComponentIconSources(undefined, defaultPath);
	assert.ok(sources);
	assert.match(sources.light, /^data:image\/svg\+xml,/u);
	assert.match(decodeURIComponent(sources.light), /stroke="#424242"/u);
	assert.match(decodeURIComponent(sources.dark), /stroke="#c5c5c5"/u);
	assert.doesNotMatch(decodeURIComponent(sources.mask), /\bwidth="24"|\bheight="24"|currentColor/u);
	assert.equal(createComponentIconSources(undefined), undefined);
});
