/*
处理项目单元名称、路径、基础对象和实现接口的复制与关系选择。
xhwsd@qq.com 2026-9-10
*/

import * as path from "node:path";
import * as vscode from "vscode";
import {
	createPropertyXmlAttributePath,
	writePropertyXmlValue
} from "./propertyXml";
import {
	buildDefinitionIndex,
	type LibraryDefinitionReference,
	type Sdk
} from "./sdk";
import { ProjectSymbolIndex } from "./projectSymbolIndex";
import { simpleUnitMetadataFromProperty } from "./programResources";
import { sameFilePath } from "./simpleProjectPaths";
import {
	SIMPLE_CODE_SCHEME,
	SimpleCodeFileSystemProvider,
	toSimpleCodeUri,
	toSimpleSourceUri
} from "./simpleCodeFileSystem";
import { toUnitPreviewSourceUri } from "./unitPreview";
import {
	ProgramTreeProvider,
	type DirectoryNode,
	type FileNode,
	type ProgramTreeNode
} from "./programTree";

/** 对象关系命令访问 SDK、项目索引和共享 XML 文档事务所需的依赖。 */
export interface UnitRelationServices {
	readonly codeDocuments: SimpleCodeFileSystemProvider;
	readonly getSdk: () => Sdk | undefined;
	readonly projectSymbols: ProjectSymbolIndex;
	readonly refreshProjectSemantics: () => Promise<void>;
}

/** VS Code 类型选择项携带写入 Simple 属性 XML 的完整名称。 */
interface UnitRelationQuickPickItem extends vscode.QuickPickItem {
	readonly value: string;
	readonly navigateTo?: UnitRelationPage;
}

/** 对象关系选择器按当前项目和类库分成两个按需展示的页面。 */
type UnitRelationPage = "project" | "library";

/** 分别保留项目和类库定义，避免初次打开选择器时混入大量类库项。 */
interface UnitRelationDefinitionIndex {
	readonly all: ReadonlyMap<string, LibraryDefinitionReference>;
	readonly currentName?: string;
	readonly library: ReadonlyMap<string, LibraryDefinitionReference>;
	readonly project: ReadonlyMap<string, LibraryDefinitionReference>;
}

/** 返回当前已经打开且绑定指定真实单元的用户代码文档。 */
function openedUnitCodeDocument(filePath: string): vscode.TextDocument | undefined {
	return vscode.workspace.textDocuments.find((document) => {
		if (document.uri.scheme !== SIMPLE_CODE_SCHEME) {
			return false;
		}
		const sourceUri = toSimpleSourceUri(document.uri);
		return sourceUri !== undefined && sameFilePath(sourceUri.fsPath, filePath);
	});
}

/** 合并当前项目与 SDK 定义，项目内同名定义优先。 */
function unitDefinitionIndex(
	node: FileNode,
	services: UnitRelationServices
): UnitRelationDefinitionIndex {
	const document = openedUnitCodeDocument(node.filePath);
	const property = document === undefined ? undefined : services.codeDocuments.getProperty(document);
	const context = services.projectSymbols.contextForFile(node.filePath, document?.getText(), property);
	const project = buildDefinitionIndex(context === undefined ? [] : [context.manifest]);
	const library = buildDefinitionIndex(services.getSdk()?.manifests ?? []);
	return {
		all: buildDefinitionIndex([
			...(context === undefined ? [] : [context.manifest]),
			...(services.getSdk()?.manifests ?? [])
		]),
		currentName: context?.currentUnit?.qualifiedName,
		library,
		project
	};
}

/** 判断候选类型是否直接或间接依赖当前对象，用于拒绝循环继承。 */
function definitionDependsOn(
	name: string,
	targetName: string,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>,
	visited = new Set<string>()
): boolean {
	if (name === targetName) {
		return true;
	}
	if (visited.has(name)) {
		return false;
	}
	visited.add(name);

	const definition = definitions.get(name)?.definition;
	return (definition?.inherits ?? []).some(
		(parentName) => definitionDependsOn(parentName, targetName, definitions, visited)
	);
}

/** 判断定义是否属于当前项目中可直接写入关系属性的严格单元类型。 */
function isProjectRelationDefinition(
	reference: LibraryDefinitionReference,
	kind: "interface" | "object"
): boolean {
	return reference.definition.unitType === (kind === "object" ? "对象" : "接口");
}

/** 返回写入关系属性的完整名称；类库定义优先使用清单声明的运行时类型名。 */
function unitRelationDefinitionValue(
	reference: LibraryDefinitionReference,
	page: UnitRelationPage
): string {
	const typeName = reference.definition.type?.trim();
	return page === "library" && typeName !== undefined && typeName.length > 0
		? typeName
		: reference.definition.name;
}

/** 判断定义能否作为指定页面上的基础对象或实现接口候选。 */
function isUnitRelationDefinition(
	reference: LibraryDefinitionReference,
	page: UnitRelationPage,
	kind: "interface" | "object"
): boolean {
	return page === "project"
		? isProjectRelationDefinition(reference, kind)
		: reference.definition.kind === kind;
}

/** 建立当前页面的基础对象或接口候选项。 */
function unitRelationChoices(
	index: UnitRelationDefinitionIndex,
	page: UnitRelationPage,
	kind: "interface" | "object",
	currentValues: readonly string[],
	unknownCurrentValues: readonly string[] = []
): readonly UnitRelationQuickPickItem[] {
	const entries: readonly {
		readonly page: UnitRelationPage;
		readonly reference: LibraryDefinitionReference;
	}[] = page === "project"
		? [
			...[...index.project.values()].map((reference) => ({ page: "project" as const, reference })),
			...[...index.library.values()]
				.filter((reference) => currentValues.includes(unitRelationDefinitionValue(reference, "library")))
				.map((reference) => ({ page: "library" as const, reference }))
		]
		: [...index.library.values()].map((reference) => ({ page: "library" as const, reference }));
	const includedValues = new Set<string>();
	const choices = entries.flatMap((entry): UnitRelationQuickPickItem[] => {
		const { reference } = entry;
		const definition = reference.definition;
		const value = unitRelationDefinitionValue(reference, entry.page);
		if (
			!isUnitRelationDefinition(reference, entry.page, kind)
			|| value === index.currentName
			|| (
				kind === "object"
				&& index.currentName !== undefined
				&& definitionDependsOn(definition.name, index.currentName, index.all)
			)
			|| includedValues.has(value)
		) {
			return [];
		}
		includedValues.add(value);

		const current = currentValues.includes(value);
		const declaredUnitName = definition.unitName;
		const displayName = entry.page === "project" && typeof declaredUnitName === "string"
			? declaredUnitName
			: definition.name;
		return [{
			detail: `${reference.manifest.name}：${value}`,
			label: kind === "object" && current ? `${displayName} √` : displayName,
			picked: current,
			value
		}];
	});

	for (const currentValue of unknownCurrentValues) {
		const displayName = currentValue.split(".").at(-1) ?? currentValue;
		choices.push({
			detail: `未解析：${currentValue}`,
			label: displayName,
			picked: true,
			value: currentValue
		});
	}

	return choices.sort((left, right) => {
		if (kind === "interface") {
			const currentOrder = Number(currentValues.includes(right.value)) - Number(currentValues.includes(left.value));
			if (currentOrder !== 0) {
				return currentOrder;
			}
		}
		return left.value.localeCompare(right.value, "zh-CN", { numeric: true, sensitivity: "base" });
	});
}

/** 返回仅用于切换项目候选与类库候选的选择项。 */
function relationNavigationItem(
	page: UnitRelationPage,
	kind: "interface" | "object"
): UnitRelationQuickPickItem {
	const typeName = kind === "object" ? "对象" : "接口";
	return page === "project"
		? {
			alwaysShow: true,
			label: `浏览类库${typeName}…`,
			navigateTo: "library",
			value: ""
		}
		: {
			alwaysShow: true,
			label: `返回当前项目${typeName}…`,
			navigateTo: "project",
			value: ""
		};
}

/** 把未被项目或类库清单解析的既有属性值留在项目页供用户查看和移除。 */
function unknownRelationValues(
	index: UnitRelationDefinitionIndex,
	currentValues: readonly string[],
	kind: "interface" | "object"
): readonly string[] {
	const knownValues = new Set<string>();
	for (const [page, definitions] of [
		["project", index.project],
		["library", index.library]
	] as const) {
		for (const reference of definitions.values()) {
			if (isUnitRelationDefinition(reference, page, kind)) {
				knownValues.add(unitRelationDefinitionValue(reference, page));
			}
		}
	}
	return currentValues.filter((value) => !knownValues.has(value));
}

/** 读取当前打开 XML 会话；未打开时使用树节点加载的磁盘元数据。 */
function currentUnitRelations(
	node: FileNode,
	services: UnitRelationServices
): { readonly baseObject?: string; readonly interfaces: readonly string[] } {
	const document = openedUnitCodeDocument(node.filePath);
	const property = document === undefined ? undefined : services.codeDocuments.getProperty(document);
	return property === undefined
		? { baseObject: node.baseObject, interfaces: node.interfaces ?? [] }
		: simpleUnitMetadataFromProperty(property);
}

/** 从项目树节点或编辑器标签资源解析对应的真实 `.simple` 文件。 */
function copyTargetSourceUri(target: ProgramTreeNode | vscode.Uri | undefined): vscode.Uri | undefined {
	if (target instanceof vscode.Uri) {
		return toSimpleSourceUri(target) ?? toUnitPreviewSourceUri(target);
	}
	if (target?.kind === "unit") {
		return vscode.Uri.file(target.filePath);
	}

	const activeDocumentUri = vscode.window.activeTextEditor?.document.uri;
	if (activeDocumentUri !== undefined) {
		const sourceUri = toSimpleSourceUri(activeDocumentUri) ?? toUnitPreviewSourceUri(activeDocumentUri);
		if (sourceUri !== undefined) {
			return sourceUri;
		}
	}

	const activeInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
	return activeInput instanceof vscode.TabInputCustom
		? toSimpleSourceUri(activeInput.uri)
		: undefined;
}

/** 将项目树单元或编辑器标签对应的真实单元信息写入系统剪贴板。 */
export async function copyUnitText(
	provider: ProgramTreeProvider,
	services: UnitRelationServices,
	target: ProgramTreeNode | vscode.Uri | undefined,
	kind: "absolutePath" | "baseObject" | "interfaces" | "name" | "qualifiedName" | "relativePath"
): Promise<void> {
	const sourceUri = copyTargetSourceUri(target);
	if (sourceUri === undefined) {
		throw new Error("请在单元文件上执行复制命令。");
	}
	const node = target instanceof vscode.Uri || target === undefined
		? await provider.findUnitByFilePath(sourceUri.fsPath)
		: target.kind === "unit" ? target : undefined;

	let value: string | undefined;
	switch (kind) {
		case "absolutePath":
			value = path.resolve(sourceUri.fsPath);
			break;
		case "baseObject":
			if (node === undefined) throw new Error("无法读取当前单元的基础对象。");
			value = currentUnitRelations(node, services).baseObject ?? "";
			break;
		case "interfaces":
			if (node === undefined) throw new Error("无法读取当前单元的实现接口。");
			value = currentUnitRelations(node, services).interfaces.join(",");
			break;
		case "name":
			value = path.basename(sourceUri.fsPath, path.extname(sourceUri.fsPath));
			break;
		case "qualifiedName":
			if (node === undefined) throw new Error("无法确定当前单元的限定名。");
			value = provider.unitQualifiedName(node);
			break;
		case "relativePath":
			value = node === undefined
				? vscode.workspace.asRelativePath(sourceUri, false)
				: provider.unitProjectRelativePath(node);
			break;
	}

	if (value === undefined) {
		throw new Error("无法确定当前单元所属项目。");
	}
	await vscode.env.clipboard.writeText(value);
}

/** 将源码文件夹的名称、限定名或真实路径写入系统剪贴板。 */
export async function copyUnitFolderText(
	provider: ProgramTreeProvider,
	node: ProgramTreeNode | undefined,
	kind: "absolutePath" | "name" | "qualifiedName" | "relativePath"
): Promise<void> {
	if (node?.kind !== "directory" || node.mode !== "units") {
		throw new Error("请在单元文件夹上执行复制命令。");
	}
	let value: string | undefined;
	switch (kind) {
		case "absolutePath":
			value = path.resolve(node.directoryPath);
			break;
		case "name":
			value = provider.unitFolderName(node);
			break;
		case "qualifiedName":
			value = provider.unitFolderQualifiedName(node);
			break;
		case "relativePath":
			value = provider.unitFolderProjectRelativePath(node);
			break;
	}

	if (value === undefined) {
		throw new Error("无法确定当前文件夹所属项目。");
	}
	await vscode.env.clipboard.writeText(value);
}

/** 将 Assets 或 Res 文件夹、文件的名称、资源索引及真实路径写入系统剪贴板。 */
export async function copyResourceText(
	node: ProgramTreeNode | undefined,
	kind: "absolutePath" | "index" | "name" | "relativePath"
): Promise<void> {
	const targetNode: FileNode | DirectoryNode | undefined = node?.kind === "file"
		&& (node.resourceRoot === "assets" || node.resourceRoot === "res")
		? node
		: node?.kind === "directory"
			&& (node.resourceRoot === "assets" || node.resourceRoot === "res")
			? node
			: undefined;
	if (targetNode === undefined || targetNode.project === undefined) {
		throw new Error("请在 Assets 或 Res 文件夹、文件上执行复制命令。");
	}
	const targetPath = "filePath" in targetNode
		? targetNode.filePath
		: targetNode.directoryPath;

	let value: string;
	switch (kind) {
		case "absolutePath":
			value = path.resolve(targetPath);
			break;
		case "index":
			if (targetNode.kind !== "file" || targetNode.resourceIndex === undefined) {
				throw new Error("该 Res 文件没有唯一的资源索引。");
			}
			value = targetNode.resourceIndex;
			break;
		case "name":
			value = path.basename(targetPath);
			break;
		case "relativePath":
			value = path.relative(targetNode.project.directory, targetPath);
			break;
	}
	await vscode.env.clipboard.writeText(value);
}

/** 把对象关系写入当前用户代码标签页绑定的 XML 状态，不直接保存真实文件。 */
async function applyUnitRelation(
	provider: ProgramTreeProvider,
	services: UnitRelationServices,
	node: FileNode,
	propertyName: "基础对象" | "实现接口",
	value: string
): Promise<void> {
	const document = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(node.filePath)));
	await vscode.window.showTextDocument(document, { preserveFocus: true, preview: false });
	const property = services.codeDocuments.getProperty(document);
	const currentDocument = property?.document;
	if (property === undefined || currentDocument === undefined || property.status === "damaged") {
		throw new Error("当前单元没有可修改的 XML 属性状态。");
	}
	if (simpleUnitMetadataFromProperty(property).unitType !== "对象") {
		throw new Error("基础对象和实现接口只能设置到对象单元。");
	}

	const updatedDocument = writePropertyXmlValue(
		currentDocument,
		createPropertyXmlAttributePath("/属性", "赋值", "属性", propertyName, "值"),
		value,
		{ removeElementWhenEmpty: true }
	);
	await services.codeDocuments.applyPropertyEdit(
		document,
		currentDocument,
		updatedDocument,
		document.getText()
	);
	provider.refresh(node);
}

/** 使用 VS Code 单选列表设置或清除对象单元的基础对象。 */
export async function selectBaseObject(
	provider: ProgramTreeProvider,
	services: UnitRelationServices,
	node: ProgramTreeNode | undefined,
	requestedValue?: string | null
): Promise<void> {
	if (node?.kind !== "unit" || node.unitType !== "对象") {
		throw new Error("请在对象单元上执行“基础对象”。");
	}

	const currentValue = currentUnitRelations(node, services).baseObject;
	let selectedValue: string;
	if (requestedValue !== undefined) {
		selectedValue = requestedValue?.trim() ?? "";
	} else {
		const index = unitDefinitionIndex(node, services);
		const currentValues = currentValue === undefined ? [] : [currentValue];
		const unknownValues = unknownRelationValues(index, currentValues, "object");
		let page: UnitRelationPage = "project";
		while (true) {
			const choices = unitRelationChoices(
				index,
				page,
				"object",
				currentValues,
				page === "project" ? unknownValues : []
			);
			const clearChoice: UnitRelationQuickPickItem = {
				description: currentValue === undefined ? undefined : "当前已有基础对象",
				label: "$(clear-all) 清除基础对象",
				value: ""
			};
			const items: readonly UnitRelationQuickPickItem[] = page === "project"
				? [clearChoice, ...choices, relationNavigationItem(page, "object")]
				: [...choices, relationNavigationItem(page, "object")];
			const selected: UnitRelationQuickPickItem | undefined = await vscode.window.showQuickPick<UnitRelationQuickPickItem>(
				items,
				{
					matchOnDescription: true,
					matchOnDetail: true,
					placeHolder: page === "project"
						? "输入名称筛选当前项目对象"
						: "输入名称筛选类库对象",
					title: page === "project" || currentValue === undefined
						? `设置 ${node.label} 的基础对象`
						: `当前基础对象：${currentValue}`
				}
			);
			if (selected === undefined) {
				return;
			}
			if (selected.navigateTo !== undefined) {
				page = selected.navigateTo;
				continue;
			}
			selectedValue = selected.value;
			break;
		}
	}

	if ((currentValue ?? "") === selectedValue) {
		return;
	}
	await applyUnitRelation(provider, services, node, "基础对象", selectedValue);
}

/**
 * 在同一个多选框中按需切换项目接口和类库接口，并跨页面保留已经勾选的值。
 */
async function pickImplementedInterfaces(
	node: FileNode,
	index: UnitRelationDefinitionIndex,
	currentValues: readonly string[]
): Promise<readonly string[] | undefined> {
	const selectedValues = new Set(currentValues);
	const unknownValues = unknownRelationValues(index, currentValues, "interface");
	const picker = vscode.window.createQuickPick<UnitRelationQuickPickItem>();
	picker.canSelectMany = true;
	picker.matchOnDescription = true;
	picker.matchOnDetail = true;
	picker.title = `设置 ${node.label} 的实现接口`;

	let page: UnitRelationPage = "project";
	let updatingPage = false;
	let settled = false;

	const choicesForPage = (targetPage: UnitRelationPage): readonly UnitRelationQuickPickItem[] => (
		unitRelationChoices(
			index,
			targetPage,
			"interface",
			currentValues,
			targetPage === "project" ? unknownValues : []
		)
	);
	const commitPageSelection = (
		targetPage: UnitRelationPage,
		items: readonly UnitRelationQuickPickItem[]
	): void => {
		const picked = new Set(
			items.filter((item) => item.navigateTo === undefined).map((item) => item.value)
		);
		for (const choice of choicesForPage(targetPage)) {
			if (picked.has(choice.value)) {
				selectedValues.add(choice.value);
			} else {
				selectedValues.delete(choice.value);
			}
		}
	};
	const showPage = (targetPage: UnitRelationPage): void => {
		page = targetPage;
		const choices = choicesForPage(page);
		updatingPage = true;
		picker.items = [...choices, relationNavigationItem(page, "interface")];
		picker.selectedItems = choices.filter((choice) => selectedValues.has(choice.value));
		picker.placeholder = page === "project"
			? "勾选当前项目接口"
			: "勾选类库接口";
		updatingPage = false;
	};

	return await new Promise<readonly string[] | undefined>((resolve) => {
		const finish = (value: readonly string[] | undefined): void => {
			if (settled) {
				return;
			}
			settled = true;
			selectionDisposable.dispose();
			acceptDisposable.dispose();
			hideDisposable.dispose();
			picker.dispose();
			resolve(value);
		};
		const orderedSelection = (): readonly string[] => {
			const candidates = [
				...currentValues,
				...choicesForPage("project").map((choice) => choice.value),
				...choicesForPage("library").map((choice) => choice.value)
			];
			return [...new Set(candidates)].filter((value) => selectedValues.has(value));
		};
		const selectionDisposable = picker.onDidChangeSelection((items) => {
			if (updatingPage) {
				return;
			}
			const navigation = items.find((item) => item.navigateTo !== undefined);
			commitPageSelection(page, items);
			if (navigation?.navigateTo !== undefined) {
				showPage(navigation.navigateTo);
			}
		});
		const acceptDisposable = picker.onDidAccept(() => {
			const navigation = picker.activeItems.find((item) => item.navigateTo !== undefined);
			if (navigation?.navigateTo !== undefined) {
				commitPageSelection(page, picker.selectedItems);
				showPage(navigation.navigateTo);
				return;
			}
			commitPageSelection(page, picker.selectedItems);
			finish(orderedSelection());
		});
		const hideDisposable = picker.onDidHide(() => finish(undefined));

		showPage(page);
		picker.show();
	});
}

/** 使用 VS Code 多选列表设置对象单元实现的接口集合。 */
export async function selectImplementedInterfaces(
	provider: ProgramTreeProvider,
	services: UnitRelationServices,
	node: ProgramTreeNode | undefined,
	requestedValues?: readonly string[]
): Promise<void> {
	if (node?.kind !== "unit" || node.unitType !== "对象") {
		throw new Error("请在对象单元上执行“实现接口”。");
	}

	const currentValues = currentUnitRelations(node, services).interfaces;
	let selectedValues: readonly string[];
	if (requestedValues !== undefined) {
		selectedValues = requestedValues;
	} else {
		const selected = await pickImplementedInterfaces(
			node,
			unitDefinitionIndex(node, services),
			currentValues
		);
		if (selected === undefined) {
			return;
		}
		selectedValues = selected;
	}

	const normalizedValues = [...new Set(
		selectedValues.map((value) => value.trim()).filter((value) => value.length > 0)
	)];
	if (currentValues.join(",") === normalizedValues.join(",")) {
		return;
	}
	await applyUnitRelation(provider, services, node, "实现接口", normalizedValues.join(","));
}

/** 从对象单元的项目树快捷入口选择要设置的对象关系。 */
export async function selectObjectRelation(
	provider: ProgramTreeProvider,
	services: UnitRelationServices,
	node: ProgramTreeNode | undefined,
	requestedRelation?: "baseObject" | "interfaces"
): Promise<void> {
	if (node?.kind !== "unit" || node.unitType !== "对象") {
		throw new Error("请在对象单元上执行“设置实现接口或基础对象”。");
	}

	const selectedRelation = requestedRelation ?? await vscode.window.showQuickPick(
		[
			{ label: "设置基础对象", value: "baseObject" as const },
			{ label: "设置实现接口", value: "interfaces" as const }
		],
		{
			placeHolder: "选择要设置的对象关系",
			title: `设置 ${node.label} 的实现接口或基础对象`
		}
	);
	if (selectedRelation === undefined) {
		return;
	}

	const relation = typeof selectedRelation === "string"
		? selectedRelation
		: selectedRelation.value;
	if (relation === "baseObject") {
		await selectBaseObject(provider, services, node);
		return;
	}
	await selectImplementedInterfaces(provider, services, node);
}
