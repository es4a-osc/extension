/*
将 SDK 编译器、运行库和类库清单组织为 ES4A 类库树。
xhwsd@qq.com 2026-8-27
*/

import * as path from "node:path";
import * as vscode from "vscode";
import { resolveDefinitionIconPath } from "./componentIcon";
import { createComponentTreeIconPath, type ComponentTreeIconPath } from "./componentTreeIcon";
import { libraryMemberKey, type LibrarySymbolTarget } from "./librarySymbol";
import { markdownDocumentationForDisplay } from "./markdownDocumentation";
import { sameFilePath } from "./simpleProjectPaths";
import {
	LIBRARY_MEMBER_GROUPS,
	buildDefinitionIndex,
	getEffectiveMembers,
	isComponentDefinition,
	isContainerDefinition,
	type EffectiveLibraryMember,
	type Sdk,
	type LibraryCategory,
	type LibraryDefinitionReference,
	type LibraryManifest,
	type LibraryMember,
	type LibraryMemberGroup
} from "./sdk";

/** 类库成员分组的中文显示名称。 */
const GROUP_LABELS: Readonly<Record<LibraryMemberGroup, string>> = {
	constants: "常量",
	events: "事件",
	functions: "函数",
	properties: "属性",
	variables: "变量"
};

/** 类库定义类型的中文显示名称。 */
const DEFINITION_KIND_LABELS: Readonly<Record<string, string>> = {
	"$keyword": "属性关键字",
	"$source": "属性资源",
	component: "组件",
	"component.window": "窗口组件",
	control: "流程控制",
	declaration: "声明关键字",
	error: "运行时错误",
	interface: "接口",
	keyword: "关键字",
	layout: "布局",
	literal: "字面量",
	modifier: "修饰关键字",
	object: "对象",
	operator: "运算符",
	type: "数据类型"
};

/** 类库根节点显示的清单类型名称。 */
const MANIFEST_KIND_LABELS: Readonly<Record<string, string>> = {
	compiler: "编译器",
	library: "扩展库",
	project: "项目",
	runtime: "运行库"
};

/**
 * 创建带语义颜色的 VS Code 符号图标。
 *
 * @param id Codicon 图标标识。
 * @param colorId VS Code 符号主题颜色标识。
 * @returns 可用于树节点的主题图标。
 */
function coloredIcon(id: string, colorId: string): vscode.ThemeIcon {
	return new vscode.ThemeIcon(id, new vscode.ThemeColor(colorId));
}

/** 类库树中全部内部节点类型的可辨识联合。 */
export type LibraryNode =
	| { readonly kind: "category"; readonly category: LibraryCategory; readonly manifest: LibraryManifest }
	| { readonly kind: "definition"; readonly reference: LibraryDefinitionReference }
	| { readonly kind: "failure"; readonly message: string }
	| { readonly kind: "group"; readonly group: LibraryMemberGroup; readonly members: readonly EffectiveLibraryMember[]; readonly reference: LibraryDefinitionReference }
	| { readonly kind: "issue"; readonly message: string }
	| { readonly kind: "issues"; readonly issues: readonly string[] }
	| { readonly kind: "manifest"; readonly manifest: LibraryManifest }
	| { readonly kind: "member"; readonly group: LibraryMemberGroup; readonly overloaded: boolean; readonly reference: LibraryDefinitionReference; readonly value: EffectiveLibraryMember }
	| { readonly kind: "missing" }
	| { readonly kind: "loading" };

/**
 * 根据定义本质选择类库树中的语义图标。
 *
 * @param kind 类库定义类型。
 * @returns 与定义类型对应的 VS Code 主题图标。
 */

function definitionIcon(
	reference: LibraryDefinitionReference
): vscode.ThemeIcon | ComponentTreeIconPath {
	const kind = reference.definition.kind;
	if (isComponentDefinition(reference.definition)) {
		const iconPath = resolveDefinitionIconPath(reference);
		if (iconPath !== undefined) {
			const icon = createComponentTreeIconPath(iconPath);
			if (icon !== undefined) return icon;
		}
		switch (kind) {
			case "component.window":
				return new vscode.ThemeIcon("window");
			default:
				return isContainerDefinition(reference.definition)
					? coloredIcon("layout", "symbolIcon.structForeground")
					: coloredIcon("symbol-class", "symbolIcon.classForeground");
		}
	}
	switch (kind) {
		case "interface":
			return new vscode.ThemeIcon("symbol-structure");
		case "layout":
			return coloredIcon("layout", "symbolIcon.structForeground");
		case "error":
			return new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"));
		case "declaration":
		case "control":
		case "modifier":
		case "keyword":
		case "$keyword":
		case "$source":
			return coloredIcon("symbol-keyword", "symbolIcon.keywordForeground");
		case "operator":
			return coloredIcon("symbol-operator", "symbolIcon.operatorForeground");
		case "type":
			return coloredIcon("symbol-type-parameter", "symbolIcon.typeParameterForeground");
		case "object":
			return coloredIcon("symbol-object", "symbolIcon.objectForeground");
		default:
			return coloredIcon("symbol-object", "symbolIcon.objectForeground");
	}
}

/**
 * 根据清单类型选择编译器、运行库或类库图标。
 *
 * @param kind 类库清单类型。
 * @returns 与清单类型对应的 VS Code 主题图标。
 */
function manifestIcon(kind: string | undefined): vscode.ThemeIcon {
	switch (kind) {
		case "compiler":
			return new vscode.ThemeIcon("code");
		case "runtime":
			return new vscode.ThemeIcon("library");
		case "library":
			return new vscode.ThemeIcon("extensions");
		default:
			return new vscode.ThemeIcon("package");
	}
}

/**
 * 根据成员分组选择常量、属性、方法或事件图标。
 *
 * @param group 类库成员分组。
 * @returns 与成员分组对应的 VS Code 主题图标。
 */
function memberIcon(group: LibraryMemberGroup): vscode.ThemeIcon {
	switch (group) {
		case "constants":
			return coloredIcon("symbol-constant", "symbolIcon.constantForeground");
		case "variables":
			return coloredIcon("symbol-variable", "symbolIcon.variableForeground");
		case "properties":
			return coloredIcon("symbol-property", "symbolIcon.propertyForeground");
		case "functions":
			return coloredIcon("symbol-method", "symbolIcon.methodForeground");
		case "events":
			return coloredIcon("symbol-event", "symbolIcon.eventForeground");
	}
}

/**
 * 将成员参数格式化为类库树使用的紧凑标签。
 *
 * @param member 包含正式参数的函数或事件成员。
 * @returns 以逗号分隔的参数标签。
 */
function formatParameters(member: LibraryMember): string {
	return (member.params ?? [])
		.map((parameter) => `${parameter.byRef === true ? "传址 " : ""}${parameter.name}${parameter.type === undefined ? "" : ` 为 ${parameter.type}`}`)
		.join(", ");
}

/**
 * 构造悬停提示使用的完整成员签名。
 *
 * @param member 待显示的类库成员。
 * @param group 成员所属分组。
 * @returns 包含完整参数、类型和常量值的签名。
 */
function memberSignature(member: LibraryMember, group: LibraryMemberGroup): string {
	if (group === "functions" || group === "events") {
		const returnType = group === "functions" && member.return !== undefined ? ` 为 ${member.return}` : "";
		return `${member.name}(${formatParameters(member)})${returnType}`;
	}

	const type = member.type === undefined ? "" : ` 为 ${member.type}`;
	const value = member.value === undefined ? "" : ` = ${member.value}`;
	return `${member.name}${type}${value}`;
}

/** 在名称、签名或参数说明后追加描述，并返回是否实际写入。 */
function appendDescription(
	tooltip: vscode.MarkdownString,
	value: string | undefined,
	separator = "  \n"
): boolean {
	if (value === undefined) return false;
	const description = markdownDocumentationForDisplay(value);
	if (description.length === 0) return false;
	tooltip.appendMarkdown(separator);
	tooltip.appendMarkdown(description);
	return true;
}

/** 在标题或描述后追加普通信息区块。 */
function appendInformation(
	tooltip: vscode.MarkdownString,
	entries: readonly (readonly [label: string, value: string])[],
	hasDescription: boolean
): void {
	if (entries.length === 0) return;
	tooltip.appendMarkdown(hasDescription ? "\n\n" : "  \n");
	entries.forEach(([label, value], index) => {
		if (index > 0) tooltip.appendMarkdown("  \n");
		tooltip.appendText(`${label}：${value}`);
	});
}

/** 构造清单根节点悬停，按名称、说明和清单信息的顺序显示。 */
function manifestTooltip(manifest: LibraryManifest): vscode.MarkdownString {
	const tooltip = new vscode.MarkdownString(undefined, true);
	tooltip.appendMarkdown(`**${manifest.name.replace(/([\\*_])/gu, "\\$1")}**`);
	const hasDescription = appendDescription(tooltip, manifest.description);
	const hasInformation = manifest.kind !== undefined
		|| manifest.version !== undefined
		|| (manifest.authors?.length ?? 0) > 0
		|| manifest.kind === "library";
	if (hasInformation) tooltip.appendMarkdown(hasDescription ? "\n\n" : "  \n");
	let hasPreviousInformation = false;
	const nextInformation = (): void => {
		if (hasPreviousInformation) tooltip.appendMarkdown("  \n");
		hasPreviousInformation = true;
	};
	if (manifest.kind !== undefined) {
		nextInformation();
		tooltip.appendText(`类别：${MANIFEST_KIND_LABELS[manifest.kind] ?? manifest.kind}`);
	}
	if (manifest.version !== undefined) {
		nextInformation();
		tooltip.appendText(`版本：${manifest.version}`);
	}
	for (const author of manifest.authors ?? []) {
		nextInformation();
		tooltip.appendText(`作者：${author.name}`);
		if (author.email !== undefined) {
			const email = author.email.replace(/([\\*_\[\]])/gu, "\\$1");
			tooltip.appendText("（");
			tooltip.appendMarkdown(`[${email}](mailto:${encodeURIComponent(author.email)})`);
			tooltip.appendText("）");
		}
	}
	if (manifest.kind === "library") {
		nextInformation();
		tooltip.appendText(`目录：${path.basename(manifest.directory)}`);
	}
	return tooltip;
}

/** 构造分类节点悬停，说明固定放在分类信息之前。 */
function categoryTooltip(category: LibraryCategory): vscode.MarkdownString {
	const tooltip = new vscode.MarkdownString(undefined, true);
	tooltip.appendMarkdown(`**${category.name.replace(/([\\*_])/gu, "\\$1")}**`);
	const hasDescription = appendDescription(tooltip, category.description);
	appendInformation(tooltip, [["数量", String(category.definitions.length)]], hasDescription);
	return tooltip;
}

/** 构造成员分组悬停，按总数、当前定义数和继承数显示。 */
function groupTooltip(group: LibraryMemberGroup, members: readonly EffectiveLibraryMember[]): vscode.MarkdownString {
	const inherited = members.filter((value) => value.inherited).length;
	const declared = members.length - inherited;
	const tooltip = new vscode.MarkdownString(undefined, true);
	tooltip.appendMarkdown(`**${GROUP_LABELS[group]}**`);
	appendInformation(tooltip, [
		["拥有数", String(members.length)],
		["定义数", String(declared)],
		...(inherited > 0 ? [["继承数", String(inherited)] as const] : [])
	], false);
	return tooltip;
}

/**
 * 构造成员悬停说明，并标注继承来源和初始值。
 *
 * @param value 合并继承关系后的成员及其来源。
 * @param group 成员所属分组。
 * @returns 适用于树节点的 Markdown 悬停内容。
 */
function memberTooltip(value: EffectiveLibraryMember, group: LibraryMemberGroup): vscode.MarkdownString {
	const tooltip = new vscode.MarkdownString(undefined, true);
	tooltip.appendMarkdown(`**${memberSignature(value.member, group)}**`);
	const parameters = (value.member.params ?? []).flatMap((parameter) => {
		const documentation = parameter.description === undefined
			? ""
			: markdownDocumentationForDisplay(parameter.description);
		return documentation.length === 0 ? [] : [{ documentation, name: parameter.name }];
	});
	if (parameters.length > 0) {
		tooltip.appendMarkdown("  \n");
		parameters.forEach((parameter, index) => {
			if (index > 0) {
				tooltip.appendMarkdown("  \n");
			}
			const name = parameter.name.replace(/([\\*_])/gu, "\\$1");
			tooltip.appendMarkdown(`*${name}：*&#8203;${parameter.documentation}`);
		});
	}
	const hasDescription = appendDescription(
		tooltip,
		value.member.description,
		parameters.length > 0 ? "\n\n" : "  \n"
	);

	appendInformation(tooltip, [
		...(value.member.initializer === undefined
			? []
			: [["初始值", value.member.initializer.label] as const]),
		...(value.inherited ? [["继承自", value.owner.definition.name] as const] : [])
	], hasDescription || parameters.length > 0);

	return tooltip;
}

/**
 * 构造定义悬停说明，区分 IDE 定义类别和完整运行时类型。
 *
 * @param reference 类库定义及其所属清单。
 * @returns 适用于树节点的 Markdown 悬停内容。
 */
function definitionTooltip(reference: LibraryDefinitionReference): vscode.MarkdownString {
	const tooltip = new vscode.MarkdownString(undefined, true);
	tooltip.appendMarkdown(`**${reference.definition.name}**`);
	const hasDescription = appendDescription(tooltip, reference.definition.description);
	appendInformation(tooltip, [
		...(reference.definition.kind === undefined
			? []
			: [["类别", DEFINITION_KIND_LABELS[reference.definition.kind] ?? reference.definition.kind] as const]),
		...(reference.definition.type === undefined
			? []
			: [["类型", reference.definition.type] as const]),
		...((reference.definition.inherits?.length ?? 0) === 0
			? []
			: [["继承", reference.definition.inherits?.join(", ") ?? ""] as const])
	], hasDescription);

	return tooltip;
}

/** 将 SDK 清单呈现为资源管理器中的分层类库树。 */
export class LibraryTreeProvider implements vscode.TreeDataProvider<LibraryNode> {
	private readonly changed = new vscode.EventEmitter<LibraryNode | undefined>();
	private definitions: ReadonlyMap<string, LibraryDefinitionReference> | undefined;
	private failure: string | undefined;
	private loading = true;
	private parents = new WeakMap<LibraryNode, LibraryNode | undefined>();
	private refreshTask: Promise<void> | undefined;
	private sdk: Sdk | undefined;

	/** SDK 或加载状态变化时通知 VS Code 刷新类库树。 */
	readonly onDidChangeTreeData = this.changed.event;

	/**
	 * @param readSdk 读取当前内存 SDK 的回调；类库树不负责从磁盘加载或解析清单。
	 */
	constructor(private readonly readSdk: () => Promise<Sdk | undefined>) {
	}

	/** 释放树数据变更事件资源。 */
	dispose(): void {
		this.changed.dispose();
	}

	/** 丢弃旧树状态，并在需要显示类库树时读取当前内存 SDK。 */
	refresh(): Promise<void> {
		if (this.refreshTask !== undefined) {
			return this.refreshTask;
		}
		const task = this.performRefresh();
		this.refreshTask = task;
		return task.finally(() => {
			if (this.refreshTask === task) {
				this.refreshTask = undefined;
			}
		});
	}

	/** 执行一次 SDK 快照读取；并发刷新统一复用同一任务。 */
	private async performRefresh(): Promise<void> {
		this.loading = true;
		this.changed.fire(undefined);

		try {
			this.sdk = await this.readSdk();
			this.failure = undefined;
			this.definitions = undefined;
			this.parents = new WeakMap();
		} catch (error) {
			this.sdk = undefined;
			this.definitions = undefined;
			this.failure = error instanceof Error ? error.message : String(error);
		} finally {
			this.loading = false;
			this.changed.fire(undefined);
		}
	}

	/**
	 * 将内部节点模型转换为 VS Code 可显示的树节点。
	 *
	 * @param element 类库树内部节点。
	 * @returns VS Code 可显示的树节点。
	 */
	getTreeItem(element: LibraryNode): vscode.TreeItem {
		switch (element.kind) {
			case "loading": {
				const item = new vscode.TreeItem("正在读取 SDK…", vscode.TreeItemCollapsibleState.None);
				item.iconPath = new vscode.ThemeIcon("loading~spin");
				return item;
			}
			case "missing": {
				const item = new vscode.TreeItem("选择 SDK 入口文件 sdk.json", vscode.TreeItemCollapsibleState.None);
				item.iconPath = new vscode.ThemeIcon("warning");
				item.command = { command: "es4a.selectSdk", title: "选择 SDK 入口文件" };
				return item;
			}
			case "failure": {
				const item = new vscode.TreeItem("读取 SDK 失败", vscode.TreeItemCollapsibleState.None);
				item.description = element.message;
				item.iconPath = new vscode.ThemeIcon("error");
				item.tooltip = element.message;
				return item;
			}
			case "manifest": {
				const item = new vscode.TreeItem(element.manifest.name, vscode.TreeItemCollapsibleState.Collapsed);
				item.description = element.manifest.version;
				item.contextValue = "es4a.libraryManifest";
				item.iconPath = manifestIcon(element.manifest.kind);
				item.tooltip = manifestTooltip(element.manifest);
				return item;
			}
			case "category": {
				const item = new vscode.TreeItem(element.category.name, vscode.TreeItemCollapsibleState.Collapsed);
				item.description = String(element.category.definitions.length);
				item.iconPath = new vscode.ThemeIcon("folder");
				item.tooltip = categoryTooltip(element.category);
				return item;
			}
			case "definition": {
				const hasMembers = this.definitionGroups(element.reference).length > 0;
				const item = new vscode.TreeItem(
					element.reference.definition.name,
					hasMembers ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
				);
				item.iconPath = definitionIcon(element.reference);
				item.tooltip = definitionTooltip(element.reference);
				return item;
			}
			case "group": {
				const item = new vscode.TreeItem(GROUP_LABELS[element.group], vscode.TreeItemCollapsibleState.Collapsed);
				item.description = String(element.members.length);
				item.iconPath = memberIcon(element.group);
				item.tooltip = groupTooltip(element.group, element.members);
				return item;
			}
			case "member": {
				const item = new vscode.TreeItem(element.value.member.name, vscode.TreeItemCollapsibleState.None);
				const inheritedDescription = element.value.inherited
					? `← ${element.value.owner.definition.name}`
					: undefined;
				item.description = element.overloaded
					? `${element.value.member.params?.length ?? 0}个参数${inheritedDescription === undefined ? "" : ` · ${inheritedDescription}`}`
					: inheritedDescription;
				item.iconPath = memberIcon(element.group);
				item.tooltip = memberTooltip(element.value, element.group);
				return item;
			}
			case "issues": {
				const item = new vscode.TreeItem("SDK 清单问题", vscode.TreeItemCollapsibleState.Collapsed);
				item.description = String(element.issues.length);
				item.iconPath = new vscode.ThemeIcon("warning");
				return item;
			}
			case "issue": {
				const item = new vscode.TreeItem(element.message, vscode.TreeItemCollapsibleState.None);
				item.iconPath = new vscode.ThemeIcon("warning");
				item.tooltip = element.message;
				return item;
			}
		}
	}

	/**
	 * 按当前节点类型返回其直接子节点。
	 *
	 * @param element 可选父节点；省略时返回树根节点。
	 * @returns 保持清单和分类顺序的直接子节点。
	 */
	getChildren(element?: LibraryNode): LibraryNode[] {
		const children = this.buildChildren(element);
		for (const child of children) {
			this.parents.set(child, element);
		}
		return children;
	}

	/** 创建直接子节点，并由公开入口统一记录其父级身份。 */
	private buildChildren(element?: LibraryNode): LibraryNode[] {
		if (element === undefined) {
			if (this.loading) {
				return [{ kind: "loading" }];
			}

			if (this.sdk === undefined) {
				if (this.failure !== undefined) {
					return [{ kind: "failure", message: this.failure }];
				}

				return [{ kind: "missing" }];
			}

			const fixedRoots = this.sdk.manifests
				.filter((manifest) => manifest.kind !== "library")
				.map((manifest): LibraryNode => ({ kind: "manifest", manifest }));
			const libraryRoots = this.sdk.manifests
				.filter((manifest) => manifest.kind === "library")
				.map((manifest): LibraryNode => ({ kind: "manifest", manifest }));
			const roots: LibraryNode[] = [...fixedRoots, ...libraryRoots];

			if (this.sdk.issues.length > 0) {
				roots.push({ issues: this.sdk.issues, kind: "issues" });
			}

			return roots;
		}

		switch (element.kind) {
			case "manifest":
				return element.manifest.categories
					.filter((category) => category.hidden !== true)
					.map((category) => ({ category, kind: "category", manifest: element.manifest }));
			case "category":
				return element.category.definitions
					.map((definition) => ({
						kind: "definition",
						reference: { definition, manifest: element.manifest }
					}));
			case "definition":
				return this.definitionGroups(element.reference);
			case "group":
				return element.members.map((value) => ({
					group: element.group,
					kind: "member",
					overloaded: element.group === "functions" && element.members.some(
						(candidate) => candidate !== value && candidate.member.name === value.member.name
					),
					reference: element.reference,
					value
				}));
			case "issues":
				return element.issues.map((message) => ({ kind: "issue", message }));
			default:
				return [];
		}
	}

	/** 返回节点的直接父节点，使 VS Code 能按需展开并定位尚未加载的分支。 */
	getParent(element: LibraryNode): LibraryNode | undefined {
		if (this.parents.has(element)) {
			return this.parents.get(element);
		}
		switch (element.kind) {
			case "category":
				return { kind: "manifest", manifest: element.manifest };
			case "definition": {
				const category = element.reference.manifest.categories.find(
					(candidate) => candidate.hidden !== true
						&& candidate.definitions.includes(element.reference.definition)
				);
				return category === undefined ? undefined : {
					category,
					kind: "category",
					manifest: element.reference.manifest
				};
			}
			case "group":
				return { kind: "definition", reference: element.reference };
			case "member": {
				const group = this.definitionGroups(element.reference).find(
					(candidate) => candidate.kind === "group" && candidate.group === element.group
				);
				return group;
			}
			default:
				return undefined;
		}
	}

	/** 仅在类库树尚未初始化时读取 SDK，避免显示视图时重复刷新。 */
	async ensureLoaded(): Promise<void> {
		if (this.loading) {
			await this.refresh();
		}
	}

	/** 按稳定符号身份解析类库树节点，不预先展开无关分支。 */
	async findSymbol(target: LibrarySymbolTarget): Promise<LibraryNode | undefined> {
		await this.ensureLoaded();
		const manifestNode = this.getChildren().find(
			(candidate) => candidate.kind === "manifest"
				&& sameFilePath(candidate.manifest.filePath, target.manifestFilePath)
		);
		if (
			manifestNode?.kind !== "manifest"
			|| (manifestNode.manifest.kind !== "runtime" && manifestNode.manifest.kind !== "library")
		) {
			return undefined;
		}
		const categoryNode = this.getChildren(manifestNode).find((candidate) => (
			candidate.kind === "category"
			&& candidate.category.definitions.some((definition) => (
				definition.name === target.definitionName
				&& (target.definitionType === undefined || definition.type === target.definitionType)
			))
		));
		if (categoryNode?.kind !== "category") {
			return undefined;
		}
		const definitionNode = this.getChildren(categoryNode).find((candidate) => (
			candidate.kind === "definition"
			&& candidate.reference.definition.name === target.definitionName
			&& (target.definitionType === undefined
				|| candidate.reference.definition.type === target.definitionType)
		));
		if (definitionNode?.kind !== "definition") {
			return undefined;
		}
		if (target.memberGroup === undefined || target.memberKey === undefined) {
			return definitionNode;
		}
		const groupNode = this.getChildren(definitionNode).find(
			(candidate) => candidate.kind === "group" && candidate.group === target.memberGroup
		);
		if (groupNode?.kind !== "group") {
			return undefined;
		}
		const memberNode = this.getChildren(groupNode).find(
			(candidate) => candidate.kind === "member"
				&& libraryMemberKey(candidate.value.member) === target.memberKey
		);
		return memberNode?.kind === "member" ? memberNode : undefined;
	}

	/**
	 * 为具体定义生成非空成员分组，并合并继承成员。
	 *
	 * @param reference 待展开的类库定义。
	 * @returns 按固定成员顺序排列的非空分组节点。
	 */
	private definitionGroups(reference: LibraryDefinitionReference): LibraryNode[] {
		const definitions = this.definitions
			?? new Map(buildDefinitionIndex(this.sdk?.manifests ?? []));
		this.definitions = definitions;
		return LIBRARY_MEMBER_GROUPS.flatMap((group) => {
			const members = getEffectiveMembers(reference, group, definitions);
			return members.length === 0 ? [] : [{ group, kind: "group" as const, members, reference }];
		});
	}
}
