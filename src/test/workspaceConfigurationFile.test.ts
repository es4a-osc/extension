/*
 * 工作区配置文件 JSONC 更新测试。
 * xhwsd@qq.com 2026-10-7
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "jsonc-parser";
import { updateWorkspaceConfigurationJsonc } from "../workspaceConfigurationFile";

test("单文件夹配置保留注释和无关设置", () => {
	const source = [
		"{",
		"    // 保留用户注释",
		'    "editor.fontSize": 16',
		"}",
		""
	].join("\r\n");
	const updated = updateWorkspaceConfigurationJsonc(source, ["es4a.projects"], [
		{ path: "../simple/samples/Tetris/project.properties" }
	]);
	const parsed = parse(updated) as Record<string, unknown>;

	assert.match(updated, /\/\/ 保留用户注释/);
	assert.equal(parsed["editor.fontSize"], 16);
	assert.deepEqual(parsed["es4a.projects"], [
		{ path: "../simple/samples/Tetris/project.properties" }
	]);
	assert.equal(updated.includes("\n") && !updated.includes("\r\n"), false);
});

test("工作区文件只更新 settings 下的 ES4A 配置", () => {
	const source = [
		"{",
		'    "folders": [',
		'        { "path": "." }',
		"    ],",
		'    "settings": {',
		'        "files.exclude": { "build": true }',
		"    }",
		"}",
		""
	].join("\n");
	const projects = [{
		path: "projects/Tetris",
		settings: {
			designer: {
				documents: {
					"src/Main.simple": {
						displayOptions: {
							designerDebug: true
						}
					}
				}
			}
		}
	}];
	const updated = updateWorkspaceConfigurationJsonc(source, ["settings", "es4a.projects"], projects);
	const parsed = parse(updated) as {
		folders: unknown;
		settings: Record<string, unknown>;
	};

	assert.deepEqual(parsed.folders, [{ path: "." }]);
	assert.deepEqual(parsed.settings["files.exclude"], { build: true });
	assert.deepEqual(parsed.settings["es4a.projects"], projects);
});

test("损坏的工作区配置拒绝写入", () => {
	assert.throws(
		() => updateWorkspaceConfigurationJsonc('{ "folders": [ }', ["settings", "es4a.projects"], []),
		/工作区配置/
	);
});
