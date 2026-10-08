/*
验证 SDK 契约、清单加载、定义继承与错误诊断。
xhwsd@qq.com 2026-8-27
*/

import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	buildDefinitionIndex,
	findSdkManifest,
	getEffectiveMembers,
	getEffectivePropertyByProjection,
	isComponentDefinition,
	isContainerDefinition,
	isVisualComponentDefinition,
	isWindowDefinition,
	loadSdk,
	renderSdkTemplate,
	type LibraryManifest
} from "../sdk";

/**
 * 将测试夹具序列化为带末尾换行的 UTF-8 JSON 文件。
 *
 * @param filePath 测试 JSON 文件的完整路径。
 * @param value 待序列化的 JSON 根值。
 */
async function writeJson(filePath: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, `${JSON.stringify(value, undefined, 2)}\r\n`, "utf8");
}

test("加载 SDK 入口及其编译器、运行库和类库清单", async (context) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-sdk-"));
	context.after(() => fs.rm(directory, { recursive: true, force: true }));

	await writeJson(path.join(directory, "sdk.json"), {
		authors: [
			{ name: "SDK 作者", email: "sdk@example.com" },
			{ name: "SDK 协作者" }
		],
		version: "1.0.0",
		compiler: "simple/compiler.json",
		runtime: "simple/runtime.json",
		capabilities: {
			projects: [{
				name: "编译为调试应用",
				description: "仅编译为调试应用",
				command: "capabilities/debug.bat",
				arguments: ["PROJECT_FILE", "APK_FILE"]
			}],
			tools: [{
				name: "启动SDK管理器",
				command: "manager/manager.exe"
			}]
		},
		templates: {
			project: {
				template: "templates/project.properties",
				variables: ["应用名称"]
			}
		},
		libraries: ["libraries/com.example.demo/library.json"]
	});
	await fs.mkdir(path.join(directory, "templates"), { recursive: true });
	await fs.writeFile(
		path.join(directory, "templates", "project.properties"),
		"name={$应用名称}\r\n",
		"utf8"
	);
	await writeJson(path.join(directory, "simple", "compiler.json"), {
		name: "编译器",
		authors: [{ name: "编译器作者", email: "compiler@example.com" }],
		kind: "compiler",
		categories: [{
			name: "属性区",
			definitions: [{
				name: "$对象",
				kind: "$type",
				// 定义级 hidden 属于无效输入，加载后必须丢弃且不能影响类库树可见性。
				hidden: true,
				properties: [
					{ name: "基础对象", type: "对象" },
					{ name: "实现接口", type: "接口列表" }
				]
			}]
		}]
	});
	await writeJson(path.join(directory, "simple", "runtime.json"), {
		name: "运行库",
		kind: "runtime",
		categories: []
	});
	await writeJson(path.join(directory, "libraries", "com.example.demo", "library.json"), {
		name: "演示库",
		kind: "library",
		categories: []
	});

	const sdk = await loadSdk(path.join(directory, "sdk.json"));

	assert.equal(sdk.version, "1.0.0");
	assert.deepEqual(sdk.authors, [
		{ name: "SDK 作者", email: "sdk@example.com" },
		{ name: "SDK 协作者" }
	]);
	assert.deepEqual(sdk.manifests.map((manifest) => manifest.name), ["编译器", "运行库", "演示库"]);
	assert.deepEqual(sdk.manifests[0]?.authors, [
		{ name: "编译器作者", email: "compiler@example.com" }
	]);
	assert.deepEqual(sdk.capabilities, {
		projects: [{
			arguments: ["PROJECT_FILE", "APK_FILE"],
			command: path.join(directory, "capabilities", "debug.bat"),
			description: "仅编译为调试应用",
			id: "编译为调试应用",
			name: "编译为调试应用"
		}],
		tools: [{
			command: path.join(directory, "manager", "manager.exe"),
			description: undefined,
			id: "启动SDK管理器",
			name: "启动SDK管理器"
		}]
	});
	assert.equal(
		renderSdkTemplate(sdk.templates.project!, { "应用名称": "测试应用" }),
		"name=测试应用\r\n"
	);
	const objectUnit = sdk.manifests[0]?.categories[0]?.definitions[0];
	assert.equal(objectUnit?.name, "$对象");
	assert.equal(objectUnit === undefined ? true : "hidden" in objectUnit, false);
	assert.deepEqual(objectUnit?.properties, [
		{ name: "基础对象", type: "对象" },
		{ name: "实现接口", type: "接口列表" }
	]);
	assert.equal(buildDefinitionIndex(sdk.manifests).get("$对象")?.definition, objectUnit);
	assert.deepEqual(sdk.issues, []);
});

test("SDK 模板变量必须与模板原文完全一致", async (context) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-sdk-template-"));
	context.after(() => fs.rm(directory, { recursive: true, force: true }));
	await writeJson(path.join(directory, "sdk.json"), {
		templates: {
			project: {
				template: "templates/project.properties",
				variables: ["已声明"]
			}
		}
	});
	await fs.mkdir(path.join(directory, "templates"), { recursive: true });
	await fs.writeFile(
		path.join(directory, "templates", "project.properties"),
		"name={$未声明}\r\n",
		"utf8"
	);

	const sdk = await loadSdk(path.join(directory, "sdk.json"));
	assert.equal(sdk.templates.project, undefined);
	assert.equal(sdk.issues.some((issue) => /未声明模板变量：未声明/u.test(issue)), true);
	assert.equal(sdk.issues.some((issue) => /声明了未使用的模板变量：已声明/u.test(issue)), true);
});

test("清单类型必须与 SDK 入口声明一致", async (context) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-sdk-kind-"));
	context.after(() => fs.rm(directory, { recursive: true, force: true }));

	await writeJson(path.join(directory, "sdk.json"), {
		compiler: "compiler.json",
		runtime: "runtime.json",
		libraries: ["libraries/test/library.json"]
	});
	await writeJson(path.join(directory, "compiler.json"), {
		name: "编译器",
		kind: "compiler",
		categories: []
	});
	await writeJson(path.join(directory, "runtime.json"), {
		name: "运行库",
		kind: "runtime",
		categories: []
	});
	await writeJson(path.join(directory, "libraries", "test", "library.json"), {
		name: "错误类库",
		kind: "librarie",
		categories: []
	});

	const sdk = await loadSdk(path.join(directory, "sdk.json"));
	assert.deepEqual(sdk.manifests.map((manifest) => manifest.name), ["编译器", "运行库"]);
	assert.deepEqual(sdk.issues, [
		`${path.join(directory, "libraries", "test", "library.json")} 的 kind 必须是 library`
	]);
});

test("libraries 只加载显式注册清单并保持数组顺序", async (context) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-sdk-libraries-"));
	context.after(() => fs.rm(directory, { recursive: true, force: true }));
	await writeJson(path.join(directory, "sdk.json"), {
		compiler: "compiler.json", runtime: "runtime.json",
		libraries: ["libraries/second/library.json", "libraries/first/library.json", "./libraries/second/library.json"]
	});
	for (const kind of ["compiler", "runtime"] as const) {
		await writeJson(path.join(directory, kind + ".json"), { name: kind, kind, categories: [] });
	}
	for (const name of ["first", "second", "unregistered"]) {
		await writeJson(path.join(directory, "libraries", name, "library.json"), {
			name, kind: "library",
			categories: [{
				name: "Z category",
				definitions: [
					{ name: "shared", kind: "object", type: name + ".shared" },
					{ name: "A object", kind: "object" }
				]
			}, { name: "A category", definitions: [] }]
		});
	}
	const sdk = await loadSdk(path.join(directory, "sdk.json"));
	assert.deepEqual(sdk.manifests.map((manifest) => manifest.name), ["compiler", "runtime", "second", "first"]);
	assert.deepEqual(sdk.manifests[2]?.categories.map((category) => category.name), ["Z category", "A category"]);
	assert.deepEqual(sdk.manifests[2]?.categories[0]?.definitions.map((definition) => definition.name), ["shared", "A object"]);
	assert.equal(buildDefinitionIndex(sdk.manifests).get("shared")?.definition.type, "second.shared");
	assert.deepEqual(sdk.issues, []);
});

test("libraries 拒绝字符串和通配注册并隔离无效路径", async (context) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-sdk-registration-"));
	context.after(() => fs.rm(directory, { recursive: true, force: true }));
	const entry = { compiler: "compiler.json", runtime: "runtime.json" };
	for (const kind of ["compiler", "runtime"] as const) {
		await writeJson(path.join(directory, kind + ".json"), { name: kind, kind, categories: [] });
	}
	await writeJson(path.join(directory, "valid.json"), { name: "valid", kind: "library", categories: [] });
	await writeJson(path.join(directory, "sdk.json"), { ...entry, libraries: "valid.json" });
	const scalarSdk = await loadSdk(path.join(directory, "sdk.json"));
	assert.deepEqual(scalarSdk.manifests.map((manifest) => manifest.name), ["compiler", "runtime"]);
	assert.equal(scalarSdk.issues.length, 1);
	assert.match(scalarSdk.issues[0]!, /libraries 必须是明确的类库清单路径数组/u);
	await writeJson(path.join(directory, "sdk.json"), {
		...entry, libraries: ["libraries/*/library.json", "libraries/?/library.json", "  ", 7, "missing.json", "valid.json"]
	});
	const sdk = await loadSdk(path.join(directory, "sdk.json"));
	assert.deepEqual(sdk.manifests.map((manifest) => manifest.name), ["compiler", "runtime", "valid"]);
	assert.equal(sdk.issues.length, 5);
	assert.match(sdk.issues[0]!, /libraries\[0\] 不支持通配表达式/u);
	assert.match(sdk.issues[1]!, /libraries\[1\] 不支持通配表达式/u);
	assert.match(sdk.issues[2]!, /libraries\[2\] 必须是非空路径字符串/u);
	assert.match(sdk.issues[3]!, /libraries\[3\] 必须是非空路径字符串/u);
	assert.equal(sdk.issues[4]?.includes("missing.json"), true);
});

test("属性选择项和缺省值支持字符串简写及标签值对象", async (context) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-sdk-select-"));
	context.after(() => fs.rm(directory, { recursive: true, force: true }));
	await writeJson(path.join(directory, "sdk.json"), { runtime: "runtime.json" });
	const runtimePath = path.join(directory, "runtime.json");
	const runtime = (options: unknown[], initializer: unknown = {
		label: "默认",
		value: "缓存模式_默认"
	}, layouts?: unknown, group?: unknown) => ({
		name: "运行库",
		kind: "runtime",
		categories: [{
			name: "组件",
			definitions: [{
				name: "测试组件",
				kind: "component",
				properties: [{
					name: "缓存模式",
					type: "整数型",
					initializer,
					group,
					layouts,
					select: { options }
				}]
			}]
		}]
	});

	await writeJson(runtimePath, runtime([
		{ label: "默认", value: "缓存模式_默认" },
		{ label: "忽略", value: "处理方式_忽略" }
	], undefined, undefined, "显示"));
	const sdk = await loadSdk(path.join(directory, "sdk.json"));
	const property = sdk.manifests[0]?.categories[0]?.definitions[0]?.properties?.[0];
	assert.deepEqual(
		sdk.manifests[0]?.categories[0]?.definitions[0]?.properties?.[0]?.select?.options,
		[
			{ label: "默认", value: "缓存模式_默认" },
			{ label: "忽略", value: "处理方式_忽略" }
		]
	);
	assert.deepEqual(
		property?.initializer,
		{ label: "默认", value: "缓存模式_默认" }
	);
	assert.equal(property?.group, "显示");

	await writeJson(runtimePath, runtime(["缓存模式_默认"], "缓存模式_默认"));
	const shorthandSdk = await loadSdk(path.join(directory, "sdk.json"));
	const shorthandProperty = shorthandSdk.manifests[0]?.categories[0]
		?.definitions[0]?.properties?.[0];
	assert.deepEqual(shorthandProperty?.select?.options, [
		{ label: "缓存模式_默认", value: "缓存模式_默认" }
	]);
	assert.deepEqual(shorthandProperty?.initializer, {
		label: "缓存模式_默认",
		value: "缓存模式_默认"
	});

	await writeJson(runtimePath, runtime([0]));
	const invalidOptionSdk = await loadSdk(path.join(directory, "sdk.json"));
	assert.equal(invalidOptionSdk.manifests.length, 0);
	assert.equal(invalidOptionSdk.issues.some(
		(issue) => /select\.options 必须是非空字符串或包含 label 和 value 的对象/u.test(issue)
	), true);

	await writeJson(runtimePath, runtime([], 0));
	const invalidInitializerSdk = await loadSdk(path.join(directory, "sdk.json"));
	assert.equal(invalidInitializerSdk.manifests.length, 0);
	assert.equal(invalidInitializerSdk.issues.some(
		(issue) => /initializer 必须是非空字符串或包含 label 和 value 的对象/u.test(issue)
	), true);

	await writeJson(runtimePath, runtime([], "缓存模式_默认", ["布局_线性", 1]));
	const invalidLayoutsSdk = await loadSdk(path.join(directory, "sdk.json"));
	assert.equal(invalidLayoutsSdk.manifests.length, 0);
	assert.equal(invalidLayoutsSdk.issues.some(
		(issue) => /layouts 必须是非空字符串数组/u.test(issue)
	), true);

	await writeJson(runtimePath, runtime([], "缓存模式_默认", undefined, ""));
	const invalidGroupSdk = await loadSdk(path.join(directory, "sdk.json"));
	assert.equal(invalidGroupSdk.manifests.length, 0);
	assert.equal(invalidGroupSdk.issues.some(
		(issue) => /group 必须是非空字符串/u.test(issue)
	), true);

});

test("当前 SDK 以稳定标识声明项目能力", async () => {
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));

	assert.deepEqual(
		sdk.capabilities.projects.map((capability) => capability.id),
		["debug", "compile"]
	);
	assert.deepEqual(sdk.capabilities.tools, []);
	assert.equal(
		sdk.capabilities.projects[0]?.command,
		path.resolve("..", "sdk", "capabilities", "debug.bat")
	);
	assert.deepEqual(sdk.capabilities.projects.map((capability) => capability.arguments), [
		["PROJECT_FILE", "APK_FILE"],
		["PROJECT_FILE"]
	]);
	assert.deepEqual(Object.keys(sdk.templates), [
		"project",
		"main",
		"window",
		"object",
		"interface",
		"service"
	]);
	assert.deepEqual(sdk.issues, []);
});

test("只接受 SDK 入口的完整绝对 JSON 文件路径", async (context) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-sdk-find-"));
	context.after(() => fs.rm(directory, { recursive: true, force: true }));
	const sdkFile = path.join(directory, "sdk", "ES4A.json");
	await writeJson(sdkFile, {});

	assert.equal(await findSdkManifest(sdkFile), sdkFile);
	assert.equal(await findSdkManifest(path.dirname(sdkFile)), undefined);
	assert.equal(await findSdkManifest(path.join("sdk", "ES4A.json")), undefined);
	assert.equal(await findSdkManifest(path.join(directory, "sdk", "ES4A.txt")), undefined);
	assert.equal(await findSdkManifest(undefined), undefined);
});

test("运行库将所有组件容器归入独立分类", async () => {
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const runtime = sdk.manifests.find((manifest) => manifest.kind === "runtime");
	assert.ok(runtime);
	const containerCategory = runtime.categories.find((category) => category.name === "组件容器");
	assert.ok(containerCategory);
	assert.equal(
		containerCategory.definitions.find((definition) => definition.name === "窗口")?.icon,
		"icons/device-screen.svg"
	);
	assert.deepEqual(
		containerCategory.definitions.map((definition) => definition.name),
		["窗口", "面板", "垂直滚动框", "水平滚动框"]
	);
	assert.equal(
		containerCategory.definitions.every(
			(definition) => isContainerDefinition(definition)
		),
		true
	);
	assert.deepEqual(
		runtime.categories.flatMap((category) => category.definitions)
			.filter(isContainerDefinition)
			.map((definition) => definition.name),
		containerCategory.definitions.map((definition) => definition.name)
	);
	assert.equal(containerCategory.definitions.every(isVisualComponentDefinition), true);

});

test("运行库按组件体系和用途排列组件定义", async () => {
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const runtime = sdk.manifests.find((manifest) => manifest.kind === "runtime");
	assert.ok(runtime);
	const definitionNames = (categoryName: string): readonly string[] => (
		runtime.categories.find((category) => category.name === categoryName)
			?.definitions.map((definition) => definition.name) ?? []
	);

	assert.deepEqual(definitionNames("组件"), [
		"组件", "计时器", "音频播放器", "电话", "消息传递器", "广播接收器", "权限请求"
	]);
	assert.deepEqual(definitionNames("组件容器"), [
		"窗口", "面板", "垂直滚动框", "水平滚动框"
	]);
	assert.deepEqual(definitionNames("视图组件"), [
		"可视组件",
		"文本组件", "图片组件", "进度组件", "列表组件",
		"标签", "按钮", "编辑框", "密码编辑框", "单选框", "复选框", "邮箱选择器",
		"图片框", "图片按钮",
		"水平进度条", "水平滑块条", "垂直滑块条",
		"列表框", "单选列表框", "多选列表框", "分组列表框", "下拉列表框",
		"进度圈", "画板", "网页浏览框", "视频播放器"
	]);
});

test("运行库通过 kind 和 inherits 区分组件角色", async () => {
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const runtime = sdk.manifests.find((manifest) => manifest.kind === "runtime");
	assert.ok(runtime);
	const definitions = runtime.categories.flatMap((category) => category.definitions);

	assert.equal(definitions.find((definition) => definition.name === "窗口")?.kind, "component.window");
	assert.equal(definitions.find((definition) => definition.name === "面板")?.kind, "component");
	assert.equal(definitions.find((definition) => definition.name === "按钮")?.kind, "component");
	assert.equal(definitions.find((definition) => definition.name === "计时器")?.kind, "component");
	assert.equal(isWindowDefinition(definitions.find((definition) => definition.name === "窗口")), true);
	assert.equal(isContainerDefinition(definitions.find((definition) => definition.name === "面板")), true);
	assert.equal(isVisualComponentDefinition(definitions.find((definition) => definition.name === "按钮")), true);
	assert.deepEqual(definitions.find((definition) => definition.name === "按钮")?.inherits, [
		"simple.runtime.components.文本组件"
	]);
	assert.deepEqual(definitions.find((definition) => definition.name === "按钮")?.resolvedInherits?.slice(-3), [
		"simple.runtime.components.组件",
		"simple.runtime.components.可视组件",
		"simple.runtime.components.文本组件"
	]);
	assert.deepEqual(definitions.find((definition) => definition.name === "线性布局")?.inherits, [
		"simple.runtime.components.布局"
	]);
	assert.deepEqual(definitions.find((definition) => definition.name === "属性访问错误")?.inherits, [
		"simple.runtime.errors.运行错误"
	]);
	assert.equal(
		definitions.flatMap((definition) => definition.inherits ?? [])
			.every((parent) => parent.trim().length > 0),
		true
	);
});

test("可视组件像素属性使用变体输入和像素编辑器", async () => {
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const runtime = sdk.manifests.find((manifest) => manifest.kind === "runtime");
	assert.ok(runtime);
	const visualComponent = runtime.categories
		.flatMap((category) => category.definitions)
		.find((definition) => definition.name === "可视组件");
	assert.ok(visualComponent);
	assert.deepEqual(
		visualComponent.properties
			?.filter((member) => member.editor === "simple.pixel")
			.map((member) => [member.name, member.type, member.editor]),
		[
			["宽度", "变体型", "simple.pixel"],
			["高度", "变体型", "simple.pixel"],
			["左边距", "变体型", "simple.pixel"],
			["顶边距", "变体型", "simple.pixel"],
			["右边距", "变体型", "simple.pixel"],
			["底边距", "变体型", "simple.pixel"],
			["左填充", "变体型", "simple.pixel"],
			["顶填充", "变体型", "simple.pixel"],
			["右填充", "变体型", "simple.pixel"],
			["底填充", "变体型", "simple.pixel"],
			["左边", "变体型", "simple.pixel"],
			["顶边", "变体型", "simple.pixel"]
		]
	);
});

test("可视组件只为受父级布局约束的属性声明适用布局", async () => {
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const runtime = sdk.manifests.find((manifest) => manifest.kind === "runtime");
	assert.ok(runtime);
	const visualComponent = runtime.categories
		.flatMap((category) => category.definitions)
		.find((definition) => definition.name === "可视组件");
	assert.ok(visualComponent);

	const layoutProperties = Object.fromEntries(
		(visualComponent.properties ?? [])
			.filter((property) => property.layouts !== undefined)
			.map((property) => [property.name, property.layouts])
	);
	assert.deepEqual(layoutProperties, {
		"对齐": ["布局_线性", "布局_表格", "布局_单帧"],
		"权重": ["布局_线性"],
		"行": ["布局_表格"],
		"列": ["布局_表格"],
		"位于左边": ["布局_相对"],
		"位于顶边": ["布局_相对"],
		"位于右边": ["布局_相对"],
		"位于底边": ["布局_相对"],
		"对齐基线": ["布局_相对"],
		"对齐左边": ["布局_相对"],
		"对齐顶边": ["布局_相对"],
		"对齐右边": ["布局_相对"],
		"对齐底边": ["布局_相对"],
		"对齐父左边": ["布局_相对"],
		"对齐父顶边": ["布局_相对"],
		"对齐父右边": ["布局_相对"],
		"对齐父底边": ["布局_相对"],
		"居中于父": ["布局_相对"],
		"居中水平": ["布局_相对"],
		"居中垂直": ["布局_相对"],
		"位于开始": ["布局_相对"],
		"位于结束": ["布局_相对"],
		"对齐开始": ["布局_相对"],
		"对齐结束": ["布局_相对"],
		"对齐父开始": ["布局_相对"],
		"对齐父结束": ["布局_相对"],
		"左边": ["布局_绝对"],
		"顶边": ["布局_绝对"]
	});
	assert.deepEqual(
		Object.fromEntries(
			(visualComponent.properties ?? [])
				.filter((property) => property.layouts?.includes("布局_相对"))
				.map((property) => [property.name, property.group])
		),
		{
			"位于左边": "同级组件",
			"位于顶边": "同级组件",
			"位于右边": "同级组件",
			"位于底边": "同级组件",
			"对齐基线": "同级组件",
			"对齐左边": "同级组件",
			"对齐顶边": "同级组件",
			"对齐右边": "同级组件",
			"对齐底边": "同级组件",
			"对齐父左边": "父级容器",
			"对齐父顶边": "父级容器",
			"对齐父右边": "父级容器",
			"对齐父底边": "父级容器",
			"居中于父": "父级容器",
			"居中水平": "父级容器",
			"居中垂直": "父级容器",
			"位于开始": "同级组件",
			"位于结束": "同级组件",
			"对齐开始": "同级组件",
			"对齐结束": "同级组件",
			"对齐父开始": "父级容器",
			"对齐父结束": "父级容器"
		}
	);
});

test("运行库完整声明 Java 相对布局常量、属性和方法", async () => {
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const runtime = sdk.manifests.find((manifest) => manifest.kind === "runtime");
	assert.ok(runtime);
	const definitions = runtime.categories.flatMap((category) => category.definitions);
	const component = definitions.find((definition) => definition.name === "组件");
	const visualComponent = definitions.find((definition) => definition.name === "可视组件");
	const relativeLayout = definitions.find((definition) => definition.name === "相对布局");
	assert.ok(component);
	assert.ok(visualComponent);
	assert.ok(relativeLayout);

	assert.deepEqual(
		component.constants
			?.filter((constant) => constant.name.startsWith("布局_规则_"))
			.map((constant) => [constant.name, constant.type, constant.value]),
		[
			["布局_规则_真", "整数型", "-1"],
			["布局_规则_左", "整数型", "0"],
			["布局_规则_右", "整数型", "1"],
			["布局_规则_顶", "整数型", "2"],
			["布局_规则_底", "整数型", "3"],
			["布局_规则_对齐_基线", "整数型", "4"],
			["布局_规则_对齐_左", "整数型", "5"],
			["布局_规则_对齐_顶", "整数型", "6"],
			["布局_规则_对齐_右", "整数型", "7"],
			["布局_规则_对齐_底", "整数型", "8"],
			["布局_规则_对齐_父_左", "整数型", "9"],
			["布局_规则_对齐_父_顶", "整数型", "10"],
			["布局_规则_对齐_父_右", "整数型", "11"],
			["布局_规则_对齐_父_底", "整数型", "12"],
			["布局_规则_居中_于_父", "整数型", "13"],
			["布局_规则_居中_水平", "整数型", "14"],
			["布局_规则_居中_垂直", "整数型", "15"],
			["布局_规则_开始", "整数型", "16"],
			["布局_规则_结束", "整数型", "17"],
			["布局_规则_对齐_开始", "整数型", "18"],
			["布局_规则_对齐_结束", "整数型", "19"],
			["布局_规则_对齐_父_开始", "整数型", "20"],
			["布局_规则_对齐_父_结束", "整数型", "21"]
		]
	);

	const integerProperties = [
		"位于左边", "位于顶边", "位于右边", "位于底边",
		"对齐基线", "对齐左边", "对齐顶边", "对齐右边", "对齐底边",
		"位于开始", "位于结束", "对齐开始", "对齐结束"
	];
	const booleanProperties = [
		"对齐父左边", "对齐父顶边", "对齐父右边", "对齐父底边",
		"居中于父", "居中水平", "居中垂直", "对齐父开始", "对齐父结束"
	];
	const relativeProperties = visualComponent.properties
		?.filter((property) => [...integerProperties, ...booleanProperties].includes(property.name)) ?? [];
	assert.equal(relativeProperties.length, 22);
	for (const name of integerProperties) {
		assert.equal(relativeProperties.find((property) => property.name === name)?.type, "整数型");
	}
	for (const name of booleanProperties) {
		assert.equal(relativeProperties.find((property) => property.name === name)?.type, "逻辑型");
	}
	assert.deepEqual(
		visualComponent.functions
			?.filter((member) => ["添加规则", "删除规则", "取瞄点"].includes(member.name))
			.map((member) => [
				member.name,
				member.params?.map((parameter) => [parameter.name, parameter.type]),
				member.return
			]),
		[
			["添加规则", [["verb", "整数型"], ["anchor", "整数型"]], undefined],
			["删除规则", [["verb", "整数型"]], undefined],
			["取瞄点", [["verb", "整数型"]], "整数型"]
		]
	);
	assert.equal(relativeLayout.kind, "layout");
	assert.deepEqual(relativeLayout.inherits, ["simple.runtime.components.布局"]);
	for (const definitionName of ["窗口", "面板"]) {
		const layoutProperty = definitions.find((definition) => definition.name === definitionName)
			?.properties?.find((property) => property.name === "布局");
		assert.equal(
			layoutProperty?.select?.options.some(
				(option) => option.label === "相对" && option.value === "布局_相对"
			),
			true
		);
	}
});

test("完整限定继承名可关联仅声明短名称的唯一父定义", async (context) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-sdk-inherits-"));
	context.after(() => fs.rm(directory, { recursive: true, force: true }));

	await writeJson(path.join(directory, "sdk.json"), {
		runtime: "runtime.json"
	});
	await writeJson(path.join(directory, "runtime.json"), {
		name: "运行库",
		kind: "runtime",
		categories: [{
			name: "布局",
			definitions: [
				{
					name: "布局",
					kind: "layout",
					properties: [{ name: "宽度", type: "整数型", projection: "width" }]
				},
				{
					name: "线性布局",
					kind: "layout",
					inherits: ["simple.runtime.components.布局"],
					properties: [{ name: "方向", type: "整数型", projection: "orientation" }]
				},
				{
					name: "测试布局",
					kind: "layout",
					inherits: ["simple.runtime.components.线性布局"],
					resolvedInherits: ["伪造的清单缓存"],
					properties: [{ name: "排列方向", type: "整数型", projection: "orientation" }]
				}
			]
		}]
	});

	const sdk = await loadSdk(path.join(directory, "sdk.json"));
	const runtime = sdk.manifests[0];
	assert.ok(runtime);
	const definitions = runtime.categories[0]?.definitions ?? [];
	const layout = definitions.find((definition) => definition.name === "布局");
	const testLayout = definitions.find((definition) => definition.name === "测试布局");
	assert.ok(layout);
	assert.ok(testLayout);
	assert.deepEqual(testLayout.inherits, [
		"simple.runtime.components.线性布局"
	]);
	assert.deepEqual(testLayout.resolvedInherits, [
		"simple.runtime.components.布局",
		"simple.runtime.components.线性布局"
	]);

	const index = buildDefinitionIndex(sdk.manifests);
	assert.equal(index.get("simple.runtime.components.布局")?.definition, layout);
	const testLayoutReference = index.get("测试布局");
	assert.ok(testLayoutReference);
	assert.deepEqual(
		getEffectiveMembers(testLayoutReference, "properties", index)
			.map((member) => member.member.name),
		["宽度", "方向", "排列方向"]
	);
	assert.equal(
		getEffectivePropertyByProjection(testLayoutReference, "orientation", index)?.member.name,
		"排列方向"
	);
});

test("运行库为全部对象、接口和组件声明完整运行时类型名", async () => {
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const runtime = sdk.manifests.find((manifest) => manifest.kind === "runtime");
	assert.ok(runtime);
	const definitions = runtime.categories.flatMap((category) => category.definitions)
		.filter((definition) => (
			definition.kind === "object"
			|| definition.kind === "interface"
			|| isComponentDefinition(definition)
		));

	assert.ok(definitions.length > 0);
	assert.equal(definitions.every((definition) => typeof definition.type === "string" && definition.type.length > 0), true);
	assert.equal(new Set(definitions.map((definition) => definition.type)).size, definitions.length);
	assert.equal(definitions.find((definition) => definition.name === "线程")?.type, "simple.runtime.collections.线程");
	assert.equal(definitions.find((definition) => definition.name === "组件")?.type, "simple.runtime.components.组件");
	assert.equal(definitions.find((definition) => definition.name === "窗口")?.type, "simple.runtime.components.窗口");
	assert.equal(definitions.find((definition) => definition.name === "文件操作")?.type, "simple.runtime.文件操作");
	assert.equal(
		buildDefinitionIndex([runtime]).get("simple.runtime.components.窗口")?.definition.name,
		"窗口"
	);
});

test("运行库为全部具体组件声明可复用的 24×24 SVG 图标", async () => {
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const runtime = sdk.manifests.find((manifest) => manifest.kind === "runtime");
	assert.ok(runtime);
	const components = runtime.categories.flatMap((category) => category.definitions)
		.filter(isComponentDefinition);
	assert.ok(components.length > 0);
	assert.equal(components.every((definition) => typeof definition.icon === "string"), true);
	for (const definition of components) {
		const icon = definition.icon;
		assert.ok(icon, `组件 ${definition.name} 没有声明图标`);
		const source = await fs.readFile(path.resolve(path.dirname(runtime.filePath), icon), "utf8");
		assert.match(source, /viewBox="0 0 24 24"/u);
		assert.doesNotMatch(source, /\s(?:width|height|class)="/u);
	}
});

test("运行库按对象集和函数集分类", async () => {
	const sdk = await loadSdk(path.resolve("..", "sdk", "sdk.json"));
	const runtime = sdk.manifests.find((manifest) => manifest.kind === "runtime");
	assert.ok(runtime);
	assert.deepEqual(
		runtime.categories.map((category) => category.name),
		["组件", "布局", "组件容器", "视图组件", "传感器组件", "对象集", "函数集", "运行时错误"]
	);
	const functionCategory = runtime.categories.find((category) => category.name === "函数集");
	const objectCategory = runtime.categories.find((category) => category.name === "对象集");
	assert.ok(functionCategory);
	assert.ok(objectCategory);
	assert.ok(functionCategory.definitions.some((definition) => definition.name === "多线程操作"));
	assert.ok(functionCategory.definitions.some((definition) => definition.name === "数组操作"));
	assert.ok(objectCategory.definitions.some((definition) => definition.name === "集合"));
	assert.ok(objectCategory.definitions.some((definition) => definition.name === "哈希表"));
	assert.equal(
		[...functionCategory.definitions, ...objectCategory.definitions]
			.every((definition) => definition.kind === "object"),
		true
	);
});

test("具体组件合并继承成员，并以子级定义覆盖父级定义", () => {
	const manifest: LibraryManifest = {
		filePath: "runtime.json",
		directory: ".",
		name: "运行库",
		categories: [
			{
				name: "对象",
				definitions: [
					{
						name: "组件",
						properties: [
							{ name: "启用", type: "逻辑型" },
							{ name: "宽度", type: "整数型" }
						]
					},
					{
						name: "按钮",
						inherits: ["组件"],
						properties: [
							{ name: "启用", type: "逻辑型", initializer: { label: "真", value: "真" } },
							{ name: "标题", type: "文本型" }
						]
					}
				]
			}
		]
	};
	const definitions = buildDefinitionIndex([manifest]);
	const button = definitions.get("按钮");
	assert.ok(button);

	const properties = getEffectiveMembers(button, "properties", definitions);

	assert.deepEqual(properties.map((item) => item.member.name), ["启用", "宽度", "标题"]);
	assert.equal(properties[0]?.inherited, false);
	assert.deepEqual(properties[0]?.member.initializer, { label: "真", value: "真" });
	assert.equal(properties[1]?.inherited, true);
	assert.equal(properties[1]?.owner.definition.name, "组件");
});

test("函数继承按名称和参数个数保留重载并覆盖对应签名", () => {
	const manifest: LibraryManifest = {
		filePath: "runtime.json",
		directory: ".",
		name: "运行库",
		categories: [{
			name: "对象",
			definitions: [
				{
					name: "基础对象",
					functions: [
						{ name: "执行" },
						{ name: "执行", params: [{ name: "value", type: "整数型" }] }
					]
				},
				{
					name: "派生对象",
					inherits: ["基础对象"],
					functions: [
						{ name: "执行", params: [{ name: "text", type: "文本型" }] },
						{
							name: "执行",
							params: [
								{ name: "left", type: "整数型" },
								{ name: "right", type: "整数型" }
							]
						}
					]
				}
			]
		}]
	};
	const definitions = buildDefinitionIndex([manifest]);
	const derived = definitions.get("派生对象");
	assert.ok(derived);

	const functions = getEffectiveMembers(derived, "functions", definitions);
	assert.deepEqual(functions.map((item) => item.member.params?.length ?? 0), [0, 1, 2]);
	assert.equal(functions[0]?.owner.definition.name, "基础对象");
	assert.equal(functions[1]?.owner.definition.name, "派生对象");
	assert.equal(functions[1]?.member.params?.[0]?.type, "文本型");
	assert.equal(functions[2]?.owner.definition.name, "派生对象");
});
