/*
合并 XML 属性区与 SDK 元数据，生成单元和组件的可编辑属性框模型。
xhwsd@qq.com 2026-8-27
*/

import {
	buildDefinitionIndex,
	getEffectiveMembers,
	isVisualComponentDefinition,
	resolveSdkConstantValue,
	runtimeTypeShortName,
	type LibraryDefinitionReference,
	type LibraryMember,
	type Sdk
} from "./sdk";
import { resolveDefinitionIconPath } from "./componentIcon";
import {
	createPropertyXmlAttributePath,
	findPropertyXmlElementPath,
	getPropertyXmlAttribute,
	getPropertyXmlChildren,
	getSimplePropertyUnitType,
	type PropertyXmlElement,
	type SimplePropertyXmlDocument
} from "./propertyXml";
import { parseSimpleStringLiteral } from "./simpleStringLiteral";

/** 属性框中一行值与通用 XML 文档的路径绑定。 */
export interface PropertyPanelEditTarget {
	readonly effect?: "editComponentComment" | "renameComponent";
	readonly removeElementWhenEmpty?: boolean;
	readonly xmlPath: string;
}

/** 属性框选择器中的一个合法 Simple 表达式。 */
export interface PropertyPanelChoice {
	readonly label: string;
	readonly value: string;
}

/** simple.color 属性供浏览器颜色选择器使用的确定值。 */
export interface PropertyPanelColor {
	readonly alpha: string;
	readonly inputValue: string;
	readonly previewValue?: string;
}

/** 属性框值来自 XML 显式赋值、SDK 缺省值或只读信息。 */
export type PropertyPanelValueSource = "explicit" | "default" | "informational";

/** XML 中存在赋值节点即为显式值，否则当前显示值只能来自 SDK initializer。 */
function editableValueSource(assigned: PropertyXmlElement | undefined): PropertyPanelValueSource {
	return assigned === undefined ? "default" : "explicit";
}

/** 属性框中的一行属性。 */
export interface PropertyPanelRow {
	/** 同时声明 select 和 input: true 时允许提交候选之外的值。 */
	readonly allowCustomValue?: boolean;
	readonly choices?: readonly PropertyPanelChoice[];
	readonly color?: PropertyPanelColor;
	readonly defaultExpression?: string;
	readonly defaultLabel?: string;
	readonly description?: string;
	/** SDK 显式声明的属性编辑器；省略时由属性类型采用缺省输入规则。 */
	readonly editor?: string;
	readonly editTarget?: PropertyPanelEditTarget;
	readonly name: string;
	/** 纯字符串字面量供输入框显示的正文；存在时提交会自动恢复 Simple 引号。 */
	readonly stringLiteralInput?: string;
	readonly typeName?: string;
	readonly value: string;
	readonly valueSource: PropertyPanelValueSource;
}

/** 属性框中可折叠的一组属性。 */
export interface PropertyPanelGroup {
	readonly name: string;
	readonly rows: readonly PropertyPanelRow[];
}

/** 当前单元或组件的属性框模型。 */
export interface PropertyPanelModel {
	/** 当前标题是否表示组件；为真时没有清单图标也显示扩展缺省图标。 */
	readonly component?: boolean;
	readonly emptyMessage?: string;
	readonly groups: readonly PropertyPanelGroup[];
	/** 清单定义的已校验 SVG 路径；Webview Provider 会转换为图片数据源。 */
	readonly icon?: string;
	readonly subtitle?: string;
	readonly title?: string;
}

const LOGICAL_CHOICES: readonly PropertyPanelChoice[] = [
	{ label: "真", value: "真" },
	{ label: "假", value: "假" }
];

/** 仅为文本型和实际保存了字符串字面量的变体型启用无引号输入。 */
function stringLiteralInput(typeName: string | undefined, expression: string): string | undefined {
	if (typeName !== "文本型" && typeName !== "变体型") return undefined;
	const value = parseSimpleStringLiteral(expression);
	if (value !== undefined) return value;
	return typeName === "文本型" && expression.length === 0 ? "" : undefined;
}

/** 按 SDK 标签显示候选项，写入值始终保持清单声明的 Simple 表达式。 */
function choicesFromSelect(member: LibraryMember): readonly PropertyPanelChoice[] {
	if (member.select === undefined) return [];
	const choices: PropertyPanelChoice[] = [];
	const usedValues = new Set<string>();

	for (const option of member.select.options) {
		if (usedValues.has(option.value)) continue;
		usedValues.add(option.value);
		choices.push({ label: option.label, value: option.value });
	}

	return choices;
}

/** 按 select、editor、type 的优先级返回固定合法值。 */
function choicesForMember(
	member: LibraryMember,
	anchorChoices: readonly PropertyPanelChoice[] = []
): readonly PropertyPanelChoice[] | undefined {
	if (member.select !== undefined) {
		return choicesFromSelect(member);
	}
	if (member.editor === "simple.anchor") {
		return anchorChoices;
	}
	if (member.editor === "simple.boolean") {
		return LOGICAL_CHOICES;
	}

	return member.type === "逻辑型" ? LOGICAL_CHOICES : undefined;
}

/** input 只有显式为 true 时才把 select 作为候选而不是合法值全集。 */
function allowsCustomValue(member: LibraryMember): boolean | undefined {
	return member.select !== undefined
		&& member.select.input === true
		? true
		: undefined;
}

/** 返回与布局常量对应的布局定义；simple.layout 约定 布局_线性 对应 线性布局。 */
function resolveLayoutDefinition(
	layoutMember: LibraryMember | undefined,
	layoutExpression: string | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): LibraryDefinitionReference | undefined {
	if (layoutMember?.editor !== "simple.layout" || layoutMember.select === undefined) {
		return undefined;
	}
	const resolvedLayoutExpression = resolveSdkConstantValue(layoutExpression, definitions);

	for (const option of layoutMember.select.options) {
		const reference = option.value;
		const separator = reference.lastIndexOf(".");
		const qualified = separator > 0 && separator < reference.length - 1;
		const constantName = qualified ? reference.slice(separator + 1) : reference;
		const constant = qualified
			? definitions.get(reference.slice(0, separator))?.definition.constants
				?.find((candidate) => candidate.name === constantName)
			: Array.from(definitions.values())
				.flatMap((candidate) => candidate.definition.constants ?? [])
				.find((candidate) => candidate.name === constantName);
		if (
			layoutExpression !== reference
			&& layoutExpression !== constantName
			&& layoutExpression !== constant?.value
			&& resolvedLayoutExpression !== constant?.value
		) {
			continue;
		}
		const layoutPrefix = "布局_";
		const layoutName = constantName.startsWith(layoutPrefix)
			? `${constantName.slice(layoutPrefix.length)}布局`
			: undefined;
		const layout = layoutName === undefined ? undefined : definitions.get(layoutName);

		if (layout?.definition.kind === "layout") {
			return layout;
		}
	}

	return undefined;
}

/** 返回参与属性计算和源码写入的 SDK 缺省表达式。 */
function defaultExpression(member: LibraryMember): string | undefined {
	return member.initializer?.value;
}

/** 将 simple.color 的确定值投影为颜色选择器数据，不改写原始 Simple 表达式。 */
function propertyColor(
	member: LibraryMember,
	expression: string,
	definitions: ReadonlyMap<string, LibraryDefinitionReference> | undefined
): PropertyPanelColor | undefined {
	if (member.editor !== "simple.color") return undefined;
	const argb = /^&H([0-9A-F]{8})$/iu.exec(resolveSdkConstantValue(expression, definitions) ?? "")?.[1]
		?.toUpperCase();
	if (argb === undefined) {
		return { alpha: "FF", inputValue: "#000000" };
	}
	return {
		alpha: argb.slice(0, 2),
		inputValue: `#${argb.slice(2)}`,
		previewValue: `#${argb.slice(2)}${argb.slice(0, 2)}`
	};
}

/** 返回元素的直接属性赋值 XML 子节点。 */
function directProperties(element: PropertyXmlElement): readonly PropertyXmlElement[] {
	return getPropertyXmlChildren(element, "赋值");
}

/** 返回目标组件的直接父定义；窗口根定义没有父组件。 */
function findDirectParentDefinition(
	root: PropertyXmlElement,
	target: PropertyXmlElement
): PropertyXmlElement | undefined {
	for (const child of getPropertyXmlChildren(root)) {
		if (child === target) {
			return root.name === "定义" ? root : undefined;
		}
		const parent = findDirectParentDefinition(child, target);
		if (parent !== undefined) return parent;
	}
	return undefined;
}

/** 返回当前组件可作为相对布局锚点的直接可视兄弟组件。 */
function siblingAnchorChoices(
	root: PropertyXmlElement,
	target: PropertyXmlElement,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): readonly PropertyPanelChoice[] {
	const parent = findDirectParentDefinition(root, target);
	if (parent === undefined) return [];

	return getPropertyXmlChildren(parent, "定义").flatMap((candidate) => {
		if (candidate === target) return [];
		const name = getPropertyXmlAttribute(candidate, "名称")?.trim();
		const type = getPropertyXmlAttribute(candidate, "组件")?.trim();
		if (
			name === undefined
			|| name.length === 0
			|| type === undefined
			|| !isVisualComponentDefinition(definitions.get(type)?.definition)
		) {
			return [];
		}
		return [{ label: name, value: `${name}.标识` }];
	});
}

/** 读取直接父容器当前布局表达式及其 SDK 布局定义；显式 XML 值优先于初始值。 */
function parentLayoutContext(
	root: PropertyXmlElement,
	target: PropertyXmlElement,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): { readonly definition?: LibraryDefinitionReference; readonly expression?: string } {
	const parent = findDirectParentDefinition(root, target);
	if (parent === undefined) return {};
	const parentType = getPropertyXmlAttribute(parent, "组件") ?? "";
	const parentDefinition = definitions.get(parentType);
	if (parentDefinition === undefined) return {};
	const layoutMember = getEffectiveMembers(parentDefinition, "properties", definitions)
		.find((property) => property.member.name === "布局")?.member;
	if (layoutMember === undefined) return {};
	const assigned = directProperties(parent).find(
		(property) => propertyName(property) === "布局"
	);
	const expression = assigned === undefined ? defaultExpression(layoutMember) : propertyValue(assigned);
	return {
		definition: resolveLayoutDefinition(layoutMember, expression, definitions),
		expression
	};
}

/** 判断受限属性是否适用于直接父容器当前布局，兼容短名、限定名和常量值。 */
function propertyAppliesToParentLayout(
	member: LibraryMember,
	layoutExpression: string | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): boolean {
	if (member.layouts === undefined) return true;
	if (layoutExpression === undefined) return false;
	const expression = layoutExpression.trim();
	const resolvedExpression = resolveSdkConstantValue(expression, definitions);
	return member.layouts.some((layout) => (
		layout === expression
		|| resolveSdkConstantValue(layout, definitions) === resolvedExpression
	));
}

/** 返回属性赋值节点的名称。 */
function propertyName(element: PropertyXmlElement): string {
	return getPropertyXmlAttribute(element, "属性") ?? "";
}

/** 返回属性赋值节点的值。 */
function propertyValue(element: PropertyXmlElement): string {
	return getPropertyXmlAttribute(element, "值") ?? "";
}

/** 生成当前 XML 节点下指定属性赋值的相对绑定路径。 */
function propertyValuePath(parentPath: string, name: string): string {
	return createPropertyXmlAttributePath(parentPath, "赋值", "属性", name, "值");
}

/** 只为 SDK 允许赋值的属性生成编辑路径。 */
function propertyEditTarget(
	member: LibraryMember,
	parentPath: string,
	name: string
): PropertyPanelEditTarget | undefined {
	return member.writable === false ? undefined : {
		removeElementWhenEmpty: true,
		xmlPath: propertyValuePath(parentPath, name)
	};
}

/** 将 XML 中尚未被 SDK 消费的赋值节点转换为属性框行。 */
function sourceRows(
	properties: readonly PropertyXmlElement[],
	parentPath: string | undefined
): readonly PropertyPanelRow[] {
	return properties.map((property) => {
		const name = propertyName(property);
		return {
			editTarget: parentPath === undefined ? undefined : {
				removeElementWhenEmpty: true,
				xmlPath: propertyValuePath(parentPath, name)
			},
			name,
			value: propertyValue(property),
			valueSource: "explicit" as const
		};
	});
}

/** 按真实归属名称合并属性分组，不为标题附加“属性”“设置”等界面后缀。 */
function appendPropertyGroup(
	groups: PropertyPanelGroup[],
	name: string,
	rows: readonly PropertyPanelRow[]
): void {
	if (rows.length === 0) return;
	const index = groups.findIndex((group) => group.name === name);
	if (index < 0) {
		groups.push({ name, rows });
		return;
	}
	const current = groups[index];
	if (current !== undefined) {
		groups[index] = { name, rows: [...current.rows, ...rows] };
	}
}

/** 将 SDK 自定义子分组附加到属性原有的归属分组，不改变归属和布局过滤语义。 */
function propertyGroupName(parentName: string, member: LibraryMember): string {
	return member.group === undefined ? parentName : `${parentName} · ${member.group}`;
}

/**
 * 为当前选中 XML 根节点或定义节点建立属性框投影。
 *
 * 属性框行只保存 XML 路径，不保存组件索引或专用属性对象。
 */
export function createPropertyPanelModel(
	document: SimplePropertyXmlDocument | undefined,
	selectedNode: PropertyXmlElement | undefined,
	sdk: Sdk | undefined,
	unitName?: string
): PropertyPanelModel {
	if (document === undefined || selectedNode === undefined) {
		return { emptyMessage: "打开 Simple 单元后显示属性。", groups: [] };
	}

	const selectedPath = findPropertyXmlElementPath(document, selectedNode);
	if (selectedPath === undefined) {
		return { emptyMessage: "当前 XML 节点已经变化，请重新选择。", groups: [] };
	}
	const definitions = sdk === undefined ? undefined : buildDefinitionIndex(sdk.manifests);

	if (selectedNode === document.root) {
		const assignedProperties = directProperties(document.root);
		const assignedByName = new Map(
			assignedProperties.map((property) => [propertyName(property), property])
		);
		const consumedNames = new Set<string>();
		const unitType = getSimplePropertyUnitType(document);
		const propertyDefinitions = unitType === undefined
			? undefined
			: sdk?.manifests.find((manifest) => manifest.kind === "compiler")
				?.categories.flatMap((category) => category.definitions)
				.find((definition) => definition.name === "$" + unitType)
				?.properties;
		const groups: PropertyPanelGroup[] = [{
			name: "单元",
			rows: [
				...(unitName === undefined ? [] : [{
					name: "名称",
					value: unitName,
					valueSource: "informational" as const
				}]),
				{
					name: "类型",
					value: unitType ?? "未知",
					valueSource: "informational"
				}
			]
		}];

		if (propertyDefinitions !== undefined && propertyDefinitions.length > 0) {
			groups.push({
				name: unitType ?? "单元",
				rows: propertyDefinitions.map((definition) => {
					const assigned = assignedByName.get(definition.name);
					const expression = assigned === undefined
						? definition.initializer?.value ?? ""
						: propertyValue(assigned);
					if (assigned !== undefined) {
						consumedNames.add(definition.name);
					}
					return {
						allowCustomValue: allowsCustomValue(definition),
						choices: choicesForMember(definition),
						color: propertyColor(definition, expression, definitions),
						defaultExpression: defaultExpression(definition),
						defaultLabel: definition.initializer?.label,
						description: definition.description,
						editor: definition.editor,
						editTarget: propertyEditTarget(definition, selectedPath, definition.name),
						name: definition.name,
						stringLiteralInput: stringLiteralInput(definition.type, expression),
						typeName: definition.type,
						value: expression,
						valueSource: editableValueSource(assigned)
					};
				})
			});
		}

		const remainingProperties = assignedProperties.filter(
			(property) => !consumedNames.has(propertyName(property))
		);
		if (remainingProperties.length > 0) {
			groups.push({ name: "其它", rows: sourceRows(remainingProperties, selectedPath) });
		}
		return {
			component: unitType === "窗口",
			groups,
			icon: unitType === undefined
				? undefined
				: resolveDefinitionIconPath(definitions?.get(unitType)),
			subtitle: unitType,
			title: unitName ?? (unitType === undefined ? "当前单元" : unitType + "单元")
		};
	}

	if (selectedNode.name !== "定义") {
		return { emptyMessage: "当前 XML 节点没有可显示的组件属性。", groups: [] };
	}

	const componentName = getPropertyXmlAttribute(selectedNode, "名称") ?? "";
	const componentType = getPropertyXmlAttribute(selectedNode, "组件") ?? "";
	const componentComment = getPropertyXmlAttribute(selectedNode, "注释");
	const assignedProperties = directProperties(selectedNode);
	const assignedByName = new Map(
		assignedProperties.map((property) => [propertyName(property), property])
	);
	const consumedNames = new Set<string>();
	const groups: PropertyPanelGroup[] = [{
		name: "组件",
		rows: [
			{
				description: "组件在当前窗口中的唯一名称。\n名称必须符合 Simple 标识符规则，且不能与其他组件重名。\n修改名称后，会同步更新用户代码和 XML 属性中的组件引用。",
				editTarget: {
					effect: "renameComponent",
					xmlPath: selectedPath + "/@名称"
				},
				name: "名称",
				value: componentName,
				valueSource: "explicit"
			},
			{
				description: "组件定义的行尾注释，不影响组件运行。",
				editTarget: {
					effect: "editComponentComment",
					xmlPath: selectedPath + "/@注释"
				},
				name: "注释",
				value: componentComment ?? "",
				valueSource: componentComment === undefined ? "default" : "explicit"
			}
		]
	}];
	const definition = definitions?.get(componentType);
	let layoutDefinition: LibraryDefinitionReference | undefined;

	if (definition !== undefined && definitions !== undefined) {
		const ownerGroups = new Map<string, PropertyPanelRow[]>();
		const parentLayoutGroups = new Map<string, PropertyPanelRow[]>();
		const parentLayout = parentLayoutContext(document.root, selectedNode, definitions);
		const parentLayoutGroupName = "位于" + (parentLayout.definition?.definition.name ?? "布局");
		const anchorChoices = siblingAnchorChoices(document.root, selectedNode, definitions);
		const effectiveProperties = getEffectiveMembers(definition, "properties", definitions);
		const layoutMember = effectiveProperties.find(
			(effective) => effective.member.name === "布局"
		)?.member;
		for (const effective of effectiveProperties) {
			const member = effective.member;
			const assigned = assignedByName.get(member.name);
			if (assigned !== undefined) {
				consumedNames.add(member.name);
			}
			if (!propertyAppliesToParentLayout(member, parentLayout.expression, definitions)) {
				continue;
			}
			const initializer = defaultExpression(member);
			const expression = assigned === undefined
				? initializer ?? ""
				: propertyValue(assigned);
			const row: PropertyPanelRow = {
				allowCustomValue: allowsCustomValue(member),
				choices: choicesForMember(member, anchorChoices),
				color: propertyColor(member, expression, definitions),
				defaultExpression: initializer,
				defaultLabel: member.initializer?.label,
				description: member.description,
				editor: member.editor,
				editTarget: propertyEditTarget(member, selectedPath, member.name),
				name: member.name,
				stringLiteralInput: stringLiteralInput(member.type, expression),
				typeName: member.type,
				value: expression,
				valueSource: editableValueSource(assigned)
			};
			if (member.layouts === undefined) {
				const groupName = propertyGroupName(effective.owner.definition.name, member);
				const rows = ownerGroups.get(groupName) ?? [];
				rows.push(row);
				ownerGroups.set(groupName, rows);
			} else {
				const groupName = propertyGroupName(parentLayoutGroupName, member);
				const rows = parentLayoutGroups.get(groupName) ?? [];
				rows.push(row);
				parentLayoutGroups.set(groupName, rows);
			}
		}
		for (const [ownerName, rows] of ownerGroups) {
			appendPropertyGroup(groups, ownerName, rows);
		}
		for (const [groupName, rows] of parentLayoutGroups) {
			appendPropertyGroup(groups, groupName, rows);
		}

		const layoutAssigned = assignedByName.get("布局");
		const layoutExpression = layoutAssigned === undefined
			? layoutMember?.initializer?.value
			: propertyValue(layoutAssigned);
		layoutDefinition = resolveLayoutDefinition(layoutMember, layoutExpression, definitions);
	}

	const layoutGroups = new Map<string, PropertyPanelRow[]>();
	if (layoutDefinition !== undefined && definitions !== undefined) {
		for (const effective of getEffectiveMembers(layoutDefinition, "properties", definitions)) {
			const member = effective.member;
			const name = "布局." + member.name;
			const assigned = assignedByName.get(name);
			const expression = assigned === undefined
				? member.initializer?.value ?? ""
				: propertyValue(assigned);
			const row: PropertyPanelRow = {
				allowCustomValue: allowsCustomValue(member),
				choices: choicesForMember(member),
				color: propertyColor(member, expression, definitions),
				defaultExpression: defaultExpression(member),
				defaultLabel: member.initializer?.label,
				description: member.description,
				editor: member.editor,
				editTarget: propertyEditTarget(member, selectedPath, name),
				name,
				stringLiteralInput: stringLiteralInput(member.type, expression),
				typeName: member.type,
				value: expression,
				valueSource: editableValueSource(assigned)
			};
			const groupName = propertyGroupName(layoutDefinition.definition.name, member);
			const rows = layoutGroups.get(groupName) ?? [];
			rows.push(row);
			layoutGroups.set(groupName, rows);
			if (assigned !== undefined) {
				consumedNames.add(name);
			}
		}
	}

	const remainingProperties = assignedProperties.filter(
		(property) => !consumedNames.has(propertyName(property))
	);
	// 不兼容当前布局的旧赋值仍留在 XML 中无损往返，但不能冒充当前布局的可编辑属性。
	const otherProperties = remainingProperties.filter(
		(property) => !propertyName(property).startsWith("布局.")
	);
	for (const [groupName, rows] of layoutGroups) {
		appendPropertyGroup(groups, groupName, rows);
	}
	if (otherProperties.length > 0) {
		groups.push({ name: "其它", rows: sourceRows(otherProperties, selectedPath) });
	}
	return {
		component: true,
		groups,
		icon: resolveDefinitionIconPath(definition),
		subtitle: definition?.definition.name ?? runtimeTypeShortName(componentType),
		title: componentName
	};
}
