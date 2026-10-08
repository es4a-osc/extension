/*
通过项目树右键菜单编辑 project.properties 中面向应用的常用属性。
xhwsd@qq.com 2026-9-20
*/

import * as path from "node:path";
import * as vscode from "vscode";
import {
	parseProjectProperties,
	updateProjectProperty,
	type SimpleProjectInfo
} from "./project";
import { ProgramTreeProvider, type ProgramTreeNode } from "./programTree";
import { sameFilePath } from "./simpleProjectPaths";
import { indexSimpleProjectResources } from "./simpleResourceSymbols";

/** “编辑属性”子菜单中允许直接修改的项目字段。 */
export type EditableProjectProperty =
	| "icon"
	| "name"
	| "orientation"
	| "theme"
	| "version.code"
	| "version.name";

/** 项目属性编辑完成后需要刷新的扩展状态。 */
export interface ProjectPropertyEditServices {
	readonly refreshProjectSemantics: () => Promise<void>;
}

interface ProjectPropertyDefinition {
	readonly label: string;
	readonly prompt: string;
}

const PROJECT_PROPERTY_DEFINITIONS: Readonly<Record<EditableProjectProperty, ProjectPropertyDefinition>> = {
	icon: {
		label: "应用图标",
		prompt: "选择项目中的 drawable 或 mipmap 资源。"
	},
	name: {
		label: "应用名称",
		prompt: "输入应用名称。"
	},
	orientation: {
		label: "屏幕方向",
		prompt: "选择应用的屏幕方向。"
	},
	theme: {
		label: "应用主题",
		prompt: "选择常用 Android 主题，或选择“自定义…”。"
	},
	"version.code": {
		label: "版本号",
		prompt: "输入大于或等于 1 的整数版本号。"
	},
	"version.name": {
		label: "版本名",
		prompt: "输入应用版本名。"
	}
};

/** 与 Simple 编译器 `Project` 各属性读取方法保持一致的缺省值。 */
const PROJECT_PROPERTY_DEFAULT_VALUES: Readonly<Record<EditableProjectProperty, string>> = {
	icon: "@drawable/icon",
	name: "MyApp",
	orientation: "unspecified",
	theme: "",
	"version.code": "1",
	"version.name": "1.0"
};

const FIXED_PROJECT_PROPERTY_KEYS = new Set([
	"assets",
	"build",
	"icon",
	"key.alias",
	"key.location",
	"key.password",
	"main",
	"name",
	"orientation",
	"res",
	"source",
	"theme",
	"version.code",
	"version.name"
]);

interface ProjectPropertyQuickPickItem extends vscode.QuickPickItem {
	readonly custom?: boolean;
	readonly value: string;
}

interface ProjectManifestMacroQuickPickItem extends vscode.QuickPickItem {
	readonly add?: boolean;
	readonly key?: string;
}

interface ProjectPropertyFileState {
	readonly bytes: Uint8Array | undefined;
	readonly document: vscode.TextDocument | undefined;
	readonly source: string;
	readonly uri: vscode.Uri;
}

/** 读取当前磁盘文件或已打开文档中的最新项目属性。 */
async function loadProjectPropertyFile(node: ProgramTreeNode | undefined): Promise<ProjectPropertyFileState> {
	if (node?.kind !== "project") {
		throw new Error("请在项目节点上编辑项目属性。");
	}

	const uri = vscode.Uri.file(node.project.filePath);
	const document = vscode.workspace.textDocuments.find((candidate) => (
		candidate.uri.scheme === "file" && sameFilePath(candidate.uri.fsPath, uri.fsPath)
	));
	const bytes = document === undefined ? await vscode.workspace.fs.readFile(uri) : undefined;
	return {
		bytes,
		document,
		source: document?.getText() ?? new TextDecoder("utf-8").decode(bytes),
		uri
	};
}

/** 保存项目属性，并刷新项目树和项目语义。 */
async function saveProjectPropertyFile(
	provider: ProgramTreeProvider,
	services: ProjectPropertyEditServices,
	state: ProjectPropertyFileState,
	nextSource: string
): Promise<void> {
	if (state.document !== undefined) {
		const lastLine = state.document.lineAt(state.document.lineCount - 1);
		const edit = new vscode.WorkspaceEdit();
		edit.replace(
			state.document.uri,
			new vscode.Range(new vscode.Position(0, 0), lastLine.range.end),
			nextSource
		);
		if (!await vscode.workspace.applyEdit(edit)) {
			throw new Error("无法写入项目属性。");
		}
		if (!await state.document.save()) {
			throw new Error("无法保存项目属性。");
		}
	} else {
		const hasUtf8Bom = state.bytes !== undefined
			&& state.bytes.length >= 3
			&& state.bytes[0] === 0xef
			&& state.bytes[1] === 0xbb
			&& state.bytes[2] === 0xbf;
		const encoded = new TextEncoder().encode(nextSource);
		const output = hasUtf8Bom ? new Uint8Array(encoded.length + 3) : encoded;
		if (hasUtf8Bom) {
			output.set([0xef, 0xbb, 0xbf]);
			output.set(encoded, 3);
		}
		await vscode.workspace.fs.writeFile(state.uri, output);
	}

	provider.refresh();
	await services.refreshProjectSemantics();
}

/** 清单宏键固定为“类简名.宏名”，排除编译器自身带点号的固定属性。 */
function isProjectManifestMacroKey(key: string): boolean {
	return !FIXED_PROJECT_PROPERTY_KEYS.has(key) && /^[^.\s=:]+\.[^\s=:]+$/u.test(key);
}

/** 返回应用图标可使用的项目图片资源，并保留编译器的缺省图标入口。 */
async function projectIconItems(project: SimpleProjectInfo): Promise<readonly ProjectPropertyQuickPickItem[]> {
	const index = await indexSimpleProjectResources(project);
	const items = new Map<string, ProjectPropertyQuickPickItem>();
	items.set("@drawable/icon", {
		description: "缺失时由编译器生成缺省图标",
		label: "@drawable/icon",
		value: "@drawable/icon"
	});
	for (const symbol of index.symbols) {
		if (symbol.resourceType !== "drawable" && symbol.resourceType !== "mipmap") {
			continue;
		}
		const value = `@${symbol.resourceType}/${symbol.resourceName}`;
		const source = symbol.sourceFiles[0];
		items.set(value, {
			description: source === undefined ? undefined : path.relative(project.directory, source),
			label: value,
			value
		});
	}
	return [...items.values()];
}

/** 返回常用 Android 系统主题；空值表示沿用系统默认主题。 */
function projectThemeItems(): readonly ProjectPropertyQuickPickItem[] {
	return [
		{ label: "系统默认", description: "空值", value: "" },
		{ label: "Material", description: "@android:style/Theme.Material", value: "@android:style/Theme.Material" },
		{ label: "Material 白色", description: "@android:style/Theme.Material.Light", value: "@android:style/Theme.Material.Light" },
		{ label: "Material 白色无标题栏", description: "@android:style/Theme.Material.Light.NoActionBar", value: "@android:style/Theme.Material.Light.NoActionBar" },
		{ label: "Holo", description: "@android:style/Theme.Holo", value: "@android:style/Theme.Holo" },
		{ label: "Holo 白色", description: "@android:style/Theme.Holo.Light", value: "@android:style/Theme.Holo.Light" },
		{ label: "经典", description: "@android:style/Theme", value: "@android:style/Theme" },
		{ label: "经典白色", description: "@android:style/Theme.Light", value: "@android:style/Theme.Light" },
		{ label: "自定义…", value: "", custom: true }
	];
}

/** 把当前值对应项移到开头并明确标记；不在候选列表中的当前值作为独立项保留。 */
function prioritizeCurrentItem(
	items: readonly ProjectPropertyQuickPickItem[],
	currentValue: string
): readonly ProjectPropertyQuickPickItem[] {
	const current = items.find((item) => !item.custom && item.value === currentValue);
	const retained = items.filter((item) => item !== current);
	if (current !== undefined) {
		return [{
			...current,
			description: current.description === undefined
				? "当前"
				: `当前 · ${current.description}`,
			iconPath: new vscode.ThemeIcon("check")
		}, ...retained];
	}
	return currentValue.length > 0
		? [{
			label: currentValue,
			description: "当前",
			iconPath: new vscode.ThemeIcon("check"),
			value: currentValue
		}, ...items]
		: items;
}

/** 通过输入框或选择列表取得新的项目属性值。 */
async function requestProjectPropertyValue(
	property: EditableProjectProperty,
	currentValue: string,
	project: SimpleProjectInfo
): Promise<string | undefined> {
	const definition = PROJECT_PROPERTY_DEFINITIONS[property];
	if (property === "orientation") {
		const items: readonly ProjectPropertyQuickPickItem[] = [
			{ label: "默认", description: "unspecified", value: "unspecified" },
			{ label: "横向", description: "landscape", value: "landscape" },
			{ label: "纵向", description: "portrait", value: "portrait" }
		];
		return (await vscode.window.showQuickPick(prioritizeCurrentItem(items, currentValue), {
			placeHolder: definition.prompt,
			title: `项目属性：${definition.label}`
		}))?.value;
	}
	if (property === "icon") {
		return (await vscode.window.showQuickPick(
			prioritizeCurrentItem(await projectIconItems(project), currentValue),
			{
				placeHolder: definition.prompt,
				title: `项目属性：${definition.label}`
			}
		))?.value;
	}
	if (property === "theme") {
		const selection = await vscode.window.showQuickPick(
			prioritizeCurrentItem(projectThemeItems(), currentValue),
			{
				placeHolder: definition.prompt,
				title: `项目属性：${definition.label}`
			}
		);
		if (selection === undefined) {
			return undefined;
		}
		return selection.custom
			? vscode.window.showInputBox({
				prompt: "输入完整 Android 主题名称。",
				title: "项目属性：应用主题",
				value: currentValue
			})
			: selection.value;
	}

	return vscode.window.showInputBox({
		prompt: definition.prompt,
		title: `项目属性：${definition.label}`,
		value: currentValue,
		validateInput: property === "version.code"
			? (value) => /^[1-9]\d*$/u.test(value) ? undefined : "版本号必须是大于或等于 1 的整数。"
			: undefined
	});
}

/**
 * 编辑项目属性中的一个应用属性并保存，保留文件中其它字段、注释和排版。
 *
 * `requestedValue` 仅供扩展内部流程和测试跳过交互使用。
 */
export async function editProjectProperty(
	provider: ProgramTreeProvider,
	services: ProjectPropertyEditServices,
	node: ProgramTreeNode | undefined,
	property: EditableProjectProperty,
	requestedValue?: string
): Promise<void> {
	const state = await loadProjectPropertyFile(node);
	if (node?.kind !== "project") {
		return;
	}
	const currentSource = state.source;
	const configuredValue = parseProjectProperties(currentSource)[property] ?? "";
	const currentValue = configuredValue.length === 0
		? PROJECT_PROPERTY_DEFAULT_VALUES[property]
		: configuredValue;
	const value = requestedValue ?? await requestProjectPropertyValue(property, currentValue, node.project);
	if (value === undefined || value === currentValue) {
		return;
	}
	if (/\r|\n/u.test(value)) {
		throw new Error("项目属性值不能包含换行。");
	}
	if (property === "version.code" && !/^[1-9]\d*$/u.test(value)) {
		throw new Error("版本号必须是大于或等于 1 的整数。");
	}

	const nextSource = updateProjectProperty(currentSource, property, value);
	await saveProjectPropertyFile(provider, services, state, nextSource);
}

/** 选择或新增一个“类简名.宏名”项目属性，并编辑其清单宏值。 */
export async function editProjectManifestMacro(
	provider: ProgramTreeProvider,
	services: ProjectPropertyEditServices,
	node: ProgramTreeNode | undefined,
	requestedKey?: string,
	requestedValue?: string
): Promise<void> {
	const state = await loadProjectPropertyFile(node);
	const properties = parseProjectProperties(state.source);
	let key = requestedKey;
	if (key === undefined) {
		const macros = Object.entries(properties)
			.filter(([propertyKey]) => isProjectManifestMacroKey(propertyKey))
			.map<ProjectManifestMacroQuickPickItem>(([propertyKey, value]) => ({
				description: value,
				key: propertyKey,
				label: propertyKey
			}));
		const selection = await vscode.window.showQuickPick<ProjectManifestMacroQuickPickItem>([
			...macros,
			...(macros.length === 0 ? [] : [{
				kind: vscode.QuickPickItemKind.Separator,
				label: ""
			}]),
			{
				add: true,
				iconPath: new vscode.ThemeIcon("add"),
				label: "新增…"
			}
		], {
			placeHolder: "选择已有清单宏，或新增“类简名.宏名”。",
			title: "项目属性：清单宏"
		});
		if (selection === undefined) {
			return;
		}
		key = selection.add
			? await vscode.window.showInputBox({
				prompt: "输入“类简名.宏名”，例如：应用更新.applicationId。",
				title: "项目属性：新增清单宏",
				validateInput: (value) => isProjectManifestMacroKey(value)
					? undefined
					: "清单宏名称必须使用“类简名.宏名”格式。"
			})
			: selection.key;
	}
	if (key === undefined) {
		return;
	}
	if (!isProjectManifestMacroKey(key)) {
		throw new Error("清单宏名称必须使用“类简名.宏名”格式。");
	}

	const currentValue = properties[key] ?? "";
	const value = requestedValue ?? await vscode.window.showInputBox({
		prompt: `输入清单宏 ${key} 的值。`,
		title: `项目属性：${key}`,
		value: currentValue
	});
	if (value === undefined || (properties[key] !== undefined && value === currentValue)) {
		return;
	}
	if (/\r|\n/u.test(value)) {
		throw new Error("清单宏值不能包含换行。");
	}

	await saveProjectPropertyFile(
		provider,
		services,
		state,
		updateProjectProperty(state.source, key, value)
	);
}
