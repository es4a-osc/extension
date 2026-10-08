/*
校验并加载 SDK、清单元数据、定义继承关系与类库成员。
xhwsd@qq.com 2026-8-27
*/

import * as fs from "node:fs/promises";
import * as path from "node:path";

/** 类库定义中允许出现的成员分组及其固定浏览顺序。 */
export const LIBRARY_MEMBER_GROUPS = [
	"constants",
	"variables",
	"properties",
	"functions",
	"events"
] as const;

/** Simple 运行库中用于判断组件能力的稳定类型标识。 */
export const SIMPLE_VISIBLE_COMPONENT_TYPE = "simple.runtime.components.可视组件";
export const SIMPLE_COMPONENT_CONTAINER_TYPE = "simple.runtime.components.组件容器";

/** 类库成员分组名称联合。 */
export type LibraryMemberGroup = typeof LIBRARY_MEMBER_GROUPS[number];

/** 属性编辑器中一个候选项的显示文本和 Simple 源码值。 */
export interface LibraryMemberSelectOption {
	/** 仅供属性编辑器显示的文本。 */
	readonly label: string;
	/** 写入 XML 属性和 Simple 源码的表达式。 */
	readonly value: string;
}

/** 属性或变量缺省值的显示文本和 Simple 源码值。 */
export interface LibraryMemberInitializer {
	/** 仅供界面显示的缺省值文本。 */
	readonly label: string;
	/** 参与语义计算并写入 Simple 源码的表达式。 */
	readonly value: string;
}

/** 属性编辑器的候选值配置。 */
export interface LibraryMemberSelect {
	/** 是否允许输入候选之外的值；缺省为 false。 */
	readonly input?: boolean;
	/** 按显示顺序排列的候选项。 */
	readonly options: readonly LibraryMemberSelectOption[];
}

/** 设计器能够从组件属性投影到低保真画布的稳定语义标识。 */
export type LibraryPropertyProjection =
	| "above"
	| "alignBaseline"
	| "alignBottom"
	| "alignEnd"
	| "alignLeft"
	| "alignParentBottom"
	| "alignParentEnd"
	| "alignParentLeft"
	| "alignParentRight"
	| "alignParentStart"
	| "alignParentTop"
	| "alignRight"
	| "alignStart"
	| "alignTop"
	| "backgroundColor"
	| "backgroundImage"
	| "baselineAligned"
	| "below"
	| "bottomMargin"
	| "centerHorizontal"
	| "centerInParent"
	| "centerVertical"
	| "column"
	| "columnCount"
	| "endOf"
	| "fontBold"
	| "fontFamily"
	| "fontItalic"
	| "gravity"
	| "height"
	| "hint"
	| "hintTextColor"
	| "id"
	| "layout"
	| "layoutGravity"
	| "leftMargin"
	| "leftOf"
	| "orientation"
	| "paddingBottom"
	| "paddingLeft"
	| "paddingRight"
	| "paddingTop"
	| "rightMargin"
	| "rightOf"
	| "row"
	| "rowCount"
	| "scrollable"
	| "scrollbarEnabled"
	| "shrinkAllColumns"
	| "singleLine"
	| "startOf"
	| "stretchAllColumns"
	| "text"
	| "textColor"
	| "textSize"
	| "topMargin"
	| "weight"
	| "weightSum"
	| "width"
	| "x"
	| "y";

/** 描述常量、变量、属性、函数或事件中的一个成员。 */
export interface LibraryMember {
	/** 面向使用者的成员说明。 */
	readonly description?: string;
	/** 属性框使用的专用编辑器标识。 */
	readonly editor?: string;
	/** 属性或变量的缺省显示文本和初始化表达式。 */
	readonly initializer?: LibraryMemberInitializer;
	/** 属性可用的直接父级布局常量；省略表示不受父级布局限制。 */
	readonly layouts?: readonly string[];
	/** 在既有父级分组下追加的自定义子分组名称。 */
	readonly group?: string;
	/** Simple 源码中使用的成员名称。 */
	readonly name: string;
	/** 属性编辑器的候选值配置。 */
	readonly select?: LibraryMemberSelect;
	/** 函数或事件的有序正式参数。 */
	readonly params?: readonly LibraryParameter[];
	/** 设计器读取和写回该属性时使用的稳定语义标识。 */
	readonly projection?: LibraryPropertyProjection;
	/** 函数返回的数据类型。 */
	readonly return?: string;
	/** 常量、变量或属性的数据类型。 */
	readonly type?: string;
	/** 常量的固定值。 */
	readonly value?: string;
	/** 属性是否允许赋值；显式为 false 时只能读取。 */
	readonly writable?: boolean;
	/** 允许类库保留自定义元数据字段。 */
	readonly [key: string]: unknown;
}

/** 描述函数或事件的一个正式参数。 */
export interface LibraryParameter {
	/** 是否按引用传递参数。 */
	readonly byRef?: boolean;
	/** 面向使用者的参数说明。 */
	readonly description?: string;
	/** Simple 源码中的参数名称。 */
	readonly name: string;
	/** 用户源码显式写出的参数传递方式；省略时按传值处理。 */
	readonly passing?: "传值" | "传址";
	/** 参数的数据类型。 */
	readonly type?: string;
	/** 允许类库保留自定义参数元数据。 */
	readonly [key: string]: unknown;
}

/** 返回过程、函数或事件成员的正式参数个数。 */
export function libraryMemberParameterCount(member: LibraryMember): number {
	return member.params?.length ?? 0;
}

/**
 * 返回继承合并使用的成员身份。
 *
 * Simple 过程和函数只按“名称＋参数个数”区分重载；其它成员仍按名称覆盖。
 */
export function effectiveLibraryMemberKey(
	member: LibraryMember,
	group: LibraryMemberGroup
): string {
	return group === "functions"
		? `${member.name}\0${libraryMemberParameterCount(member)}`
		: member.name;
}

/** 描述类库中的对象、组件、布局、类型或语言定义。 */
export interface LibraryDefinition {
	/** 对象单元直接声明的基础对象完整名称。 */
	readonly baseObject?: string;
	/** 对象、接口或组件对应的完整运行时类型名。 */
	readonly type?: string;
	/** 定义直接声明的常量。 */
	readonly constants?: readonly LibraryMember[];
	/** 面向使用者的定义说明。 */
	readonly description?: string;
	/** 是否允许通常被忽略的标点定义提供悬停说明。 */
	readonly hover?: boolean;
	/** 定义直接声明的事件。 */
	readonly events?: readonly LibraryMember[];
	/** 相对于所属清单目录的 24×24 SVG 组件图标路径。 */
	readonly icon?: string;
	/** 定义直接声明的函数。 */
	readonly functions?: readonly LibraryMember[];
	/** 清单原样声明的直接父类型标识。 */
	readonly inherits?: readonly string[];
	/** 扩展内部按继承顺序解析的全部父类型标识，不属于清单字段。 */
	readonly resolvedInherits?: readonly string[];
	/** 对象单元直接声明实现的接口完整名称。 */
	readonly interfaces?: readonly string[];
	/** 对象、组件、布局、关键字等定义类型。 */
	readonly kind?: string;
	/** Simple 源码中使用的定义名称。 */
	readonly name: string;
	/** 定义直接声明的属性。 */
	readonly properties?: readonly LibraryMember[];
	/** 定义直接声明的变量。 */
	readonly variables?: readonly LibraryMember[];
	/** 允许类库保留自定义定义元数据。 */
	readonly [key: string]: unknown;
}

/** 判断清单定义类型是否属于组件及其稳定子类型。 */
export function isComponentDefinitionKind(kind: string | undefined): boolean {
	return kind === "component" || kind?.startsWith("component.") === true;
}

/** 判断清单定义类型是否能在 Simple 类型位置使用。 */
export function isSdkTypeKind(kind: string | undefined): boolean {
	return isComponentDefinitionKind(kind)
		|| kind === "error"
		|| kind === "interface"
		|| kind === "layout"
		|| kind === "object";
}

/** 判断清单定义是否属于可实例化组件。 */
export function isComponentDefinition(definition: LibraryDefinition | undefined): boolean {
	return isComponentDefinitionKind(definition?.kind);
}

/** 从完整运行时类型名中提取用于界面显示的短名称。 */
export function runtimeTypeShortName(type: string): string {
	const separator = type.lastIndexOf(".");
	return separator < 0 || separator === type.length - 1
		? type
		: type.slice(separator + 1);
}

/** 判断定义自身或已展开继承链是否包含指定完整运行时类型。 */
export function definitionExtendsType(
	definition: LibraryDefinition | undefined,
	type: string
): boolean {
	return definition?.type === type
		|| (definition?.resolvedInherits ?? definition?.inherits)?.includes(type) === true;
}

/** 判断清单定义是否属于可视组件。 */
export function isVisualComponentDefinition(definition: LibraryDefinition | undefined): boolean {
	return isComponentDefinition(definition) && (
		definition?.kind === "component.window"
		|| definitionExtendsType(definition, SIMPLE_VISIBLE_COMPONENT_TYPE)
	);
}

/** 判断清单定义是否能够承载子组件。 */
export function isContainerDefinition(definition: LibraryDefinition | undefined): boolean {
	return isComponentDefinition(definition) && (
		definition?.kind === "component.window"
		|| definitionExtendsType(definition, SIMPLE_COMPONENT_CONTAINER_TYPE)
	);
}

/** 判断清单定义是否属于窗口类根组件。 */
export function isWindowDefinition(definition: LibraryDefinition | undefined): boolean {
	return definition?.kind === "component.window";
}

/** 描述类库浏览树中的一个有序分类。 */
export interface LibraryCategory {
	/** 按浏览顺序排列的定义。 */
	readonly definitions: readonly LibraryDefinition[];
	/** 面向使用者的分类说明。 */
	readonly description?: string;
	/** 是否从类库浏览树隐藏该分类；其中定义仍可供语言功能使用。 */
	readonly hidden?: boolean;
	/** 分类显示名称。 */
	readonly name: string;
}

/** 描述清单中的一位作者。 */
export interface ManifestAuthor {
	/** 作者邮箱。 */
	readonly email?: string;
	/** 作者名称。 */
	readonly name: string;
}

/** 描述编译器、运行库或类库的入口清单。 */
export interface LibraryManifest {
	/** 按清单顺序排列的作者。 */
	readonly authors?: readonly ManifestAuthor[];
	/** 按清单顺序排列的定义分类。 */
	readonly categories: readonly LibraryCategory[];
	/** 面向使用者的清单说明。 */
	readonly description?: string;
	/** 清单文件所在目录的绝对路径。 */
	readonly directory: string;
	/** 清单文件的绝对路径。 */
	readonly filePath: string;
	/** 编译器、运行库或类库类型。 */
	readonly kind?: "compiler" | "runtime" | "library" | "project";
	/** 清单显示名称。 */
	readonly name: string;
	/** 清单版本。 */
	readonly version?: string;
}

/** 描述 SDK 对外提供的一项可执行能力。 */
export interface SdkCapability {
	/** 按清单顺序保留的能力参数标识。 */
	readonly arguments?: readonly string[];
	/** 已基于 SDK 目录解析的可执行命令绝对路径。 */
	readonly command: string;
	/** 面向调用者的能力说明。 */
	readonly description?: string;
	/** SDK 清单中用于稳定调用能力的标识。 */
	readonly id: string;
	/** 能力显示名称。 */
	readonly name: string;
}

/** SDK 按使用边界划分的项目能力和独立工具能力。 */
export interface SdkCapabilities {
	/** 需要选定 Simple 项目后执行的能力。 */
	readonly projects: readonly SdkCapability[];
	/** 不依赖具体项目的 SDK 工具。 */
	readonly tools: readonly SdkCapability[];
}

/** SDK 注册的一份文本模板及其允许使用的模板变量。 */
export interface SdkTemplate {
	/** 模板文件的绝对路径。 */
	readonly filePath: string;
	/** SDK 加载时读取并校验过的模板原文。 */
	readonly source: string;
	/** 模板中按清单顺序声明的变量名称。 */
	readonly variables: readonly string[];
}

/** SDK 入口及其已加载清单、能力和非致命问题的内存模型。 */
export interface Sdk {
	/** 按清单顺序排列的 SDK 作者。 */
	readonly authors?: readonly ManifestAuthor[];
	/** SDK 入口按使用边界声明的能力。 */
	readonly capabilities: SdkCapabilities;
	/** SDK 入口所在目录的绝对路径。 */
	readonly directory: string;
	/** SDK 入口 JSON 的绝对路径。 */
	readonly filePath: string;
	/** 不阻断有效清单加载的配置问题。 */
	readonly issues: readonly string[];
	/** 按入口声明顺序加载的类库清单。 */
	readonly manifests: readonly LibraryManifest[];
	/** 以稳定模板标识为键的 SDK 文本模板。 */
	readonly templates: Readonly<Record<string, SdkTemplate>>;
	/** SDK 版本。 */
	readonly version?: string;
}

/** 将定义与其所属清单关联，避免跨库索引时丢失来源。 */
export interface LibraryDefinitionReference {
	/** 被引用的类库定义。 */
	readonly definition: LibraryDefinition;
	/** 定义所属的类库清单。 */
	readonly manifest: LibraryManifest;
}

/** 描述合并继承关系后可供具体定义使用的成员。 */
export interface EffectiveLibraryMember {
	/** 成员是否来自父定义。 */
	readonly inherited: boolean;
	/** 合并继承关系后的有效成员。 */
	readonly member: LibraryMember;
	/** 实际声明该成员的定义。 */
	readonly owner: LibraryDefinitionReference;
}

/**
 * 判断未知 JSON 值是否为可按字段读取的非数组对象。
 *
 * @param value 待检查的 JSON 值。
 * @returns 值可作为字符串键对象读取时返回 `true`。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 从未知 JSON 值读取非空字符串。
 *
 * @param value 待检查的 JSON 值。
 * @returns 非空字符串；其他值返回 `undefined`。
 */
function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 读取必需字符串字段。
 *
 * @param value 待校验的字段值。
 * @param field 字段名称，用于错误信息。
 * @param filePath 字段所属清单路径，用于错误定位。
 * @returns 已通过校验的非空字符串。
 * @throws 字段不存在、为空或不是字符串时抛出包含清单路径的错误。
 */
function requireString(value: unknown, field: string, filePath: string): string {
	const result = optionalString(value);

	if (result === undefined) {
		throw new Error(`${filePath} 缺少字符串字段 ${field}`);
	}

	return result;
}

/** 读取清单作者列表。 */
function parseManifestAuthors(value: unknown, filePath: string): readonly ManifestAuthor[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new Error(`${filePath} 的 authors 必须是数组`);
	}

	return value.map((author, index) => {
		if (!isRecord(author)) {
			throw new Error(`${filePath} 的 authors[${index}] 必须是对象`);
		}
		const email = optionalString(author.email);
		if (author.email !== undefined && email === undefined) {
			throw new Error(`${filePath} 的 authors[${index}].email 必须是非空字符串`);
		}
		return {
			...(email === undefined ? {} : { email }),
			name: requireString(author.name, `authors[${index}].name`, filePath)
		};
	});
}

/** 读取属性选择项；字符串是显示文本与源码值相同的简写。 */
function parseMemberSelectOption(
	value: unknown,
	filePath: string,
	memberName: string
): LibraryMemberSelectOption {
	if (typeof value === "string" && value.length > 0) {
		return { label: value, value };
	}
	if (!isRecord(value)) {
		throw new Error(`${filePath} 中成员 ${memberName} 的 select.options 必须是非空字符串或包含 label 和 value 的对象`);
	}
	return {
		...value,
		label: requireString(value.label, "select.options.label", filePath),
		value: requireString(value.value, "select.options.value", filePath)
	};
}

/** 读取成员缺省值；字符串是显示文本与源码值相同的简写。 */
function parseMemberInitializer(
	value: unknown,
	filePath: string,
	memberName: string
): LibraryMemberInitializer {
	if (typeof value === "string" && value.length > 0) {
		return { label: value, value };
	}
	if (!isRecord(value)) {
		throw new Error(`${filePath} 中成员 ${memberName} 的 initializer 必须是非空字符串或包含 label 和 value 的对象`);
	}
	return {
		...value,
		label: requireString(value.label, "initializer.label", filePath),
		value: requireString(value.value, "initializer.value", filePath)
	};
}

/**
 * 将未知 JSON 值校验并转换为类库成员。
 *
 * @param value 待解析的成员 JSON 值。
 * @param filePath 成员所属清单路径。
 * @returns 保留扩展字段的成员定义。
 * @throws 值不是对象或缺少必需字段时抛出错误。
 */
function parseMember(value: unknown, filePath: string): LibraryMember {
	if (!isRecord(value)) {
		throw new Error(`${filePath} 中存在无效成员定义`);
	}

	const name = requireString(value.name, "name", filePath);
	if (value.select !== undefined && !isRecord(value.select)) {
		throw new Error(`${filePath} 中成员 ${name} 的 select 必须是对象`);
	}
	if (isRecord(value.select) && (
		!Array.isArray(value.select.options)
	)) {
		throw new Error(`${filePath} 中成员 ${name} 的 select.options 必须是数组`);
	}
	if (isRecord(value.select)
		&& value.select.input !== undefined
		&& typeof value.select.input !== "boolean"
	) {
		throw new Error(`${filePath} 中成员 ${name} 的 select.input 必须是布尔值`);
	}
	const select = isRecord(value.select)
		? {
			...value.select,
			options: (value.select.options as unknown[])
				.map((option) => parseMemberSelectOption(option, filePath, name))
		}
		: undefined;
	const initializer = value.initializer === undefined
		? undefined
		: parseMemberInitializer(value.initializer, filePath, name);
	if (value.group !== undefined && (
		typeof value.group !== "string"
		|| value.group.length === 0
	)) {
		throw new Error(`${filePath} 中成员 ${name} 的 group 必须是非空字符串`);
	}
	if (value.layouts !== undefined && (
		!Array.isArray(value.layouts)
		|| value.layouts.length === 0
		|| value.layouts.some((layout) => typeof layout !== "string" || layout.length === 0)
	)) {
		throw new Error(`${filePath} 中成员 ${name} 的 layouts 必须是非空字符串数组`);
	}
	const layouts = value.layouts as readonly string[] | undefined;
	const params = Array.isArray(value.params)
		? value.params.map((parameter) => parseParameter(parameter, filePath))
		: undefined;

	return {
		...value,
		name,
		...(initializer === undefined ? {} : { initializer }),
		...(layouts === undefined ? {} : { layouts }),
		...(select === undefined ? {} : { select }),
		...(params === undefined ? {} : { params })
	};
}

/**
 * 将未知 JSON 值校验并转换为参数定义。
 *
 * @param value 待解析的参数 JSON 值。
 * @param filePath 参数所属清单路径。
 * @returns 保留扩展字段的参数定义。
 * @throws 值不是对象或缺少参数名时抛出错误。
 */
function parseParameter(value: unknown, filePath: string): LibraryParameter {
	if (!isRecord(value)) {
		throw new Error(`${filePath} 中存在无效参数定义`);
	}

	return {
		...value,
		name: requireString(value.name, "name", filePath)
	};
}

/**
 * 将未知 JSON 值校验并转换为对象或语言定义。
 *
 * @param value 待解析的定义 JSON 值。
 * @param filePath 定义所属清单路径。
 * @returns 已规范化成员分组和继承列表的定义。
 * @throws 值不是对象或缺少定义名称时抛出错误。
 */
function parseDefinition(value: unknown, filePath: string): LibraryDefinition {
	if (!isRecord(value)) {
		throw new Error(`${filePath} 中存在无效定义`);
	}

	const members: Partial<Record<LibraryMemberGroup, readonly LibraryMember[]>> = {};

	for (const group of LIBRARY_MEMBER_GROUPS) {
		const groupValue = value[group];

		if (Array.isArray(groupValue)) {
			members[group] = groupValue.map((member) => parseMember(member, filePath));
		}
	}

	const inherits = Array.isArray(value.inherits)
		? value.inherits.filter((item): item is string => typeof item === "string" && item.length > 0)
		: undefined;
	const icon = optionalString(value.icon);
	const runtimeType = optionalString(value.type) ?? optionalString(value.class);
	const definition = { ...value };
	delete definition.class;
	delete definition.hidden;
	delete definition.resolvedInherits;

	return {
		...definition,
		...members,
		icon,
		name: requireString(value.name, "name", filePath),
		...(runtimeType === undefined ? {} : { type: runtimeType }),
		...(inherits === undefined ? {} : { inherits })
	};
}

/**
 * 将未知 JSON 值校验并转换为有序分类。
 *
 * @param value 待解析的分类 JSON 值。
 * @param filePath 分类所属清单路径。
 * @returns 保留清单顺序的分类定义。
 * @throws 值不是对象、缺少名称或没有定义数组时抛出错误。
 */
function parseCategory(value: unknown, filePath: string): LibraryCategory {
	if (!isRecord(value) || !Array.isArray(value.definitions)) {
		throw new Error(`${filePath} 中存在无效分类`);
	}

	return {
		definitions: value.definitions.map((definition) => parseDefinition(definition, filePath)),
		description: optionalString(value.description),
		hidden: value.hidden === true,
		name: requireString(value.name, "name", filePath)
	};
}


/**
 * 以 UTF-8 读取并解析 JSON 文件。
 *
 * @param filePath JSON 文件的完整路径。
 * @returns JSON 根值，不预设其具体结构。
 * @throws 文件无法读取或 JSON 语法无效时抛出错误。
 */
async function readJson(filePath: string): Promise<unknown> {
	const source = await fs.readFile(filePath, "utf8");

	try {
		return JSON.parse(source) as unknown;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${filePath} 不是有效 JSON：${message}`);
	}
}

/**
 * 读取单个编译器、运行库或类库清单。
 *
 * @param filePath 类库清单的完整路径。
 * @returns 已校验并规范化路径的类库清单。
 * @throws 清单结构无效或必需字段缺失时抛出错误。
 */
async function readLibraryManifest(
	filePath: string,
	expectedKind: "compiler" | "runtime" | "library"
): Promise<LibraryManifest> {
	const value = await readJson(filePath);

	if (!isRecord(value) || !Array.isArray(value.categories)) {
		throw new Error(`${filePath} 不是有效的类库清单`);
	}
	if (value.kind !== expectedKind) {
		throw new Error(`${filePath} 的 kind 必须是 ${expectedKind}`);
	}

	const directory = path.dirname(filePath);

	return {
		authors: parseManifestAuthors(value.authors, filePath),
		categories: value.categories.map((category) => parseCategory(category, filePath)),
		description: optionalString(value.description),
		directory,
		filePath,
		kind: expectedKind,
		name: requireString(value.name, "name", filePath),
		version: optionalString(value.version)
	};
}

/** 返回清单定义在继承关系中的稳定身份。 */
function definitionIdentity(definition: LibraryDefinition): string {
	return definition.type?.trim() || definition.name;
}

/** 从完整限定名中提取定义短名称；短名称本身不触发兼容匹配。 */
function qualifiedDefinitionName(identity: string): string | undefined {
	const separator = identity.lastIndexOf(".");
	return separator < 0 || separator === identity.length - 1
		? undefined
		: identity.slice(separator + 1);
}

/** 完整限定名没有直接索引时，仅在短名称唯一的情况下兼容旧定义。 */
function uniqueDefinitionByQualifiedName<T>(
	identity: string,
	definitionsByName: ReadonlyMap<string, readonly T[]>
): T | undefined {
	const name = qualifiedDefinitionName(identity);
	if (name === undefined) return undefined;
	const candidates = definitionsByName.get(name);
	return candidates?.length === 1 ? candidates[0] : undefined;
}

/**
 * 将各清单声明的直接父级一次性展开为完整继承链。
 *
 * 完整运行时类型名优先，短名称只用于兼容既有清单。没有对应定义的父类型仍作为
 * 终点保留，例如未导出为 Simple 对象的组件容器标记接口。
 */
function resolveManifestInheritance(
	manifests: readonly LibraryManifest[],
	issues: string[]
): readonly LibraryManifest[] {
	const definitions = new Map<string, LibraryDefinition>();
	const definitionsByName = new Map<string, LibraryDefinition[]>();
	for (const manifest of manifests) {
		for (const category of manifest.categories) {
			for (const definition of category.definitions) {
				const candidates = definitionsByName.get(definition.name) ?? [];
				candidates.push(definition);
				definitionsByName.set(definition.name, candidates);
				for (const key of [definition.type, definition.name]) {
					if (key !== undefined && key.length > 0 && !definitions.has(key)) {
						definitions.set(key, definition);
					}
				}
			}
		}
	}

	const cache = new Map<string, readonly string[]>();
	const reportedCycles = new Set<string>();
	const resolve = (definition: LibraryDefinition, visiting: Set<string>): readonly string[] => {
		const identity = definitionIdentity(definition);
		const cached = cache.get(identity);
		if (cached !== undefined) return cached;
		if (visiting.has(identity)) {
			if (!reportedCycles.has(identity)) {
				reportedCycles.add(identity);
				issues.push(`定义继承存在循环：${identity}`);
			}
			return [];
		}

		visiting.add(identity);
		const inherited: string[] = [];
		const seen = new Set<string>();
		const append = (value: string): void => {
			if (!seen.has(value) && value !== identity) {
				seen.add(value);
				inherited.push(value);
			}
		};
		for (const parentIdentity of definition.inherits ?? []) {
			const parent = definitions.get(parentIdentity)
				?? uniqueDefinitionByQualifiedName(parentIdentity, definitionsByName);
			if (parent === undefined) {
				append(parentIdentity);
				continue;
			}
			for (const ancestor of resolve(parent, visiting)) append(ancestor);
			append(parentIdentity);
		}
		visiting.delete(identity);
		cache.set(identity, inherited);
		return inherited;
	};

	return manifests.map((manifest) => ({
		...manifest,
		categories: manifest.categories.map((category) => ({
			...category,
			definitions: category.definitions.map((definition) => {
				const resolvedInherits = resolve(definition, new Set());
				return resolvedInherits.length === 0
					? definition
					: { ...definition, resolvedInherits };
			})
		}))
	}));
}

/**
 * 解析一个有序 SDK 能力列表；无效项作为非致命问题收集。
 *
 * @param value 项目能力或工具能力数组。
 * @param group 能力分组名称，用于错误定位。
 * @param filePath SDK 入口文件路径。
 * @param sdkDirectory SDK 入口所在目录，用于解析相对命令路径。
 * @param issues 用于收集非致命清单问题的可变数组。
 * @returns 按清单顺序保留的有效能力。
 */
function parseCapabilityList(
	value: unknown,
	group: "projects" | "tools",
	filePath: string,
	sdkDirectory: string,
	issues: string[]
): readonly SdkCapability[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value)) {
		issues.push(filePath + " 中 capabilities." + group + " 必须是数组");
		return [];
	}

	const capabilities: SdkCapability[] = [];

	for (const [index, capabilityValue] of value.entries()) {
		if (!isRecord(capabilityValue)) {
			issues.push(filePath + " 中 capabilities." + group + "[" + index + "] 不是对象");
			continue;
		}

		const command = optionalString(capabilityValue.command);
		const name = optionalString(capabilityValue.name);

		if (command === undefined || name === undefined) {
			issues.push(filePath + " 中 capabilities." + group + "[" + index + "] 缺少 name 或 command");
			continue;
		}
		if (capabilityValue.arguments !== undefined && (
			!Array.isArray(capabilityValue.arguments)
			|| !capabilityValue.arguments.every((argument) => typeof argument === "string")
		)) {
			issues.push(filePath + " 中 capabilities." + group + "[" + index + "].arguments 必须是字符串数组");
			continue;
		}
		const argumentsValue = Array.isArray(capabilityValue.arguments)
			? capabilityValue.arguments as string[]
			: undefined;
		capabilities.push({
			...(argumentsValue === undefined ? {} : { arguments: argumentsValue }),
			command: path.resolve(sdkDirectory, command),
			description: optionalString(capabilityValue.description),
			id: optionalString(capabilityValue.id) ?? name,
			name
		});
	}

	return capabilities;
}

/** 解析直接以稳定标识为键声明的项目能力。 */
function parseProjectCapabilityEntries(
	value: Readonly<Record<string, unknown>>,
	filePath: string,
	sdkDirectory: string,
	issues: string[]
): readonly SdkCapability[] {
	const capabilities: SdkCapability[] = [];

	for (const [id, capabilityValue] of Object.entries(value)) {
		if (id === "projects" || id === "tools") {
			continue;
		}
		const location = filePath + ".capabilities." + id;
		if (!isRecord(capabilityValue)) {
			issues.push(location + " 必须是对象");
			continue;
		}

		const command = optionalString(capabilityValue.command);
		if (command === undefined) {
			issues.push(location + " 缺少 command");
			continue;
		}
		if (capabilityValue.arguments !== undefined && (
			!Array.isArray(capabilityValue.arguments)
			|| !capabilityValue.arguments.every((argument) => typeof argument === "string")
		)) {
			issues.push(location + ".arguments 必须是字符串数组");
			continue;
		}
		const argumentsValue = Array.isArray(capabilityValue.arguments)
			? capabilityValue.arguments as string[]
			: undefined;
		capabilities.push({
			...(argumentsValue === undefined ? {} : { arguments: argumentsValue }),
			command: path.resolve(sdkDirectory, command),
			description: optionalString(capabilityValue.description),
			id,
			name: optionalString(capabilityValue.name) ?? id
		});
	}

	return capabilities;
}

/** 解析 SDK 项目能力和独立工具能力分组。 */
function parseCapabilities(
	value: unknown,
	filePath: string,
	sdkDirectory: string,
	issues: string[]
): SdkCapabilities {
	if (value === undefined) {
		return { projects: [], tools: [] };
	}
	if (!isRecord(value)) {
		issues.push(filePath + " 中 capabilities 必须是对象");
		return { projects: [], tools: [] };
	}

	const projectsById = new Map<string, SdkCapability>();
	for (const capability of parseCapabilityList(value.projects, "projects", filePath, sdkDirectory, issues)) {
		projectsById.set(capability.id, capability);
	}
	for (const capability of parseProjectCapabilityEntries(value, filePath, sdkDirectory, issues)) {
		projectsById.set(capability.id, capability);
	}

	return {
		projects: [...projectsById.values()],
		tools: parseCapabilityList(value.tools, "tools", filePath, sdkDirectory, issues)
	};
}

/** 返回模板原文中按首次出现顺序排列的模板变量。 */
function templateVariables(source: string): readonly string[] {
	const variables = new Set<string>();
	for (const match of source.matchAll(/\{\$([^{}\r\n]+)\}/gu)) {
		variables.add(match[1] ?? "");
	}
	return [...variables];
}

/** 解析并校验 SDK 注册的文本模板。 */
async function parseSdkTemplates(
	value: unknown,
	filePath: string,
	sdkDirectory: string,
	issues: string[]
): Promise<Readonly<Record<string, SdkTemplate>>> {
	if (value === undefined) {
		return {};
	}
	if (!isRecord(value)) {
		issues.push(filePath + " 中 templates 必须是对象");
		return {};
	}

	const templates: Record<string, SdkTemplate> = {};
	for (const [id, templateValue] of Object.entries(value)) {
		const location = filePath + ".templates." + id;
		if (!isRecord(templateValue)) {
			issues.push(location + " 必须是对象");
			continue;
		}

		const configuredPath = optionalString(templateValue.template);
		if (configuredPath === undefined) {
			issues.push(location + ".template 必须是非空路径字符串");
			continue;
		}
		if (!Array.isArray(templateValue.variables)
			|| !templateValue.variables.every((variable) => (
				typeof variable === "string" && variable.trim().length > 0
			))) {
			issues.push(location + ".variables 必须是非空名称组成的字符串数组");
			continue;
		}

		const variables = templateValue.variables as string[];
		if (new Set(variables).size !== variables.length) {
			issues.push(location + ".variables 不能包含重复名称");
			continue;
		}

		const templateFile = path.resolve(sdkDirectory, configuredPath);
		if (!await isFile(templateFile)) {
			issues.push(location + ".template 文件不存在：" + templateFile);
			continue;
		}

		const source = await fs.readFile(templateFile, "utf8");
		const actualVariables = templateVariables(source);
		const declaredVariables = new Set(variables);
		const undeclaredVariables = actualVariables.filter((variable) => !declaredVariables.has(variable));
		const unusedVariables = variables.filter((variable) => !actualVariables.includes(variable));
		if (undeclaredVariables.length > 0 || unusedVariables.length > 0) {
			if (undeclaredVariables.length > 0) {
				issues.push(location + " 未声明模板变量：" + undeclaredVariables.join("、"));
			}
			if (unusedVariables.length > 0) {
				issues.push(location + " 声明了未使用的模板变量：" + unusedVariables.join("、"));
			}
			continue;
		}

		templates[id] = { filePath: templateFile, source, variables };
	}
	return templates;
}

/** 使用清单声明的变量渲染一份 SDK 模板。 */
export function renderSdkTemplate(
	template: SdkTemplate,
	values: Readonly<Record<string, string>>
): string {
	for (const variable of template.variables) {
		if (!Object.hasOwn(values, variable)) {
			throw new Error("缺少模板变量“" + variable + "”的值。");
		}
	}
	return template.source.replace(/\{\$([^{}\r\n]+)\}/gu, (_source, variable: string) => values[variable] ?? "");
}

/**
 * 判断指定路径是否存在且为普通文件。
 *
 * @param filePath 待检查的完整路径。
 * @returns 路径存在且指向普通文件时返回 `true`。
 */
async function isFile(filePath: string): Promise<boolean> {
	try {
		return (await fs.stat(filePath)).isFile();
	} catch {
		return false;
	}
}

/**
 * 加载 SDK 入口及其编译器、运行库和类库清单。
 *
 * 相对路径始终以声明该路径的清单所在目录为基准。单个类库加载失败会记录
 * 到 `issues`，不会阻止其他有效清单继续使用。
 *
 * @param sdkFilePath SDK 入口 JSON 文件路径。
 * @returns 完整 SDK 内存模型。
 * @throws SDK 入口无法读取或不是有效 JSON 对象时抛出错误。
 */
export async function loadSdk(sdkFilePath: string): Promise<Sdk> {
	const filePath = path.resolve(sdkFilePath);
	const directory = path.dirname(filePath);
	const value = await readJson(filePath);

	if (!isRecord(value)) {
		throw new Error(`${filePath} 不是有效的 SDK 清单`);
	}

	const issues: string[] = [];
	const manifestFiles: Array<{
		readonly filePath: string;
		readonly kind: "compiler" | "runtime" | "library";
	}> = [];

	for (const field of ["compiler", "runtime"] as const) {
		const configuredPath = optionalString(value[field]);

		if (configuredPath === undefined) {
			issues.push(`${filePath} 未定义 ${field}`);
			continue;
		}

		manifestFiles.push({
			filePath: path.resolve(directory, configuredPath),
			kind: field
		});
	}

	if (Array.isArray(value.libraries)) {
		const seenLibraryPaths = new Set<string>();
		for (const [index, configuredValue] of value.libraries.entries()) {
			const configuredPath = optionalString(configuredValue)?.trim();
			if (configuredPath === undefined || configuredPath.length === 0) {
				issues.push(`${filePath} 的 libraries[${index}] 必须是非空路径字符串`);
				continue;
			}
			if (/[*?]/u.test(configuredPath)) {
				issues.push(`${filePath} 的 libraries[${index}] 不支持通配表达式，请填写明确的类库清单路径`);
				continue;
			}
			const libraryPath = path.resolve(directory, configuredPath);
			const identity = process.platform === "win32" ? libraryPath.toLowerCase() : libraryPath;
			if (seenLibraryPaths.has(identity)) continue;
			seenLibraryPaths.add(identity);
			manifestFiles.push({ filePath: libraryPath, kind: "library" });
		}
	} else if (value.libraries !== undefined) {
		issues.push(`${filePath} 的 libraries 必须是明确的类库清单路径数组`);
	}

	const manifests: LibraryManifest[] = [];

	for (const manifestFile of manifestFiles) {
		try {
			manifests.push(await readLibraryManifest(manifestFile.filePath, manifestFile.kind));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			issues.push(message);
		}
	}

	return {
		authors: parseManifestAuthors(value.authors, filePath),
		capabilities: parseCapabilities(value.capabilities, filePath, directory, issues),
		directory,
		filePath,
		issues,
		manifests: resolveManifestInheritance(manifests, issues),
		templates: await parseSdkTemplates(value.templates, filePath, directory, issues),
		version: optionalString(value.version)
	};
}

/**
 * 校验用户配置的 SDK 入口路径。
 *
 * @param configuredPath 用户配置的完整文件路径。
 * @returns 已存在的绝对 JSON 文件路径；配置无效时返回 `undefined`。
 */
export async function findSdkManifest(
	configuredPath: string | undefined
): Promise<string | undefined> {
	const value = configuredPath?.trim();

	if (
		value === undefined
		|| value.length === 0
		|| !path.isAbsolute(value)
		|| path.extname(value).toLowerCase() !== ".json"
	) {
		return undefined;
	}

	const filePath = path.resolve(value);
	return await isFile(filePath) ? filePath : undefined;
}

/**
 * 按定义名称建立跨清单索引。
 *
 * 名称和完整运行时类型均可查询；冲突时以清单加载顺序中的第一个为准。
 *
 * @param manifests 已加载的编译器、运行库和类库清单。
 * @returns 以定义名称索引的来源引用。
 */
export function buildDefinitionIndex(
	manifests: readonly LibraryManifest[]
): ReadonlyMap<string, LibraryDefinitionReference> {
	const definitions = new Map<string, LibraryDefinitionReference>();
	const definitionsByName = new Map<string, LibraryDefinitionReference[]>();
	const references: LibraryDefinitionReference[] = [];

	for (const manifest of manifests) {
		for (const category of manifest.categories) {
			for (const definition of category.definitions) {
				const reference = { definition, manifest };
				references.push(reference);
				const candidates = definitionsByName.get(definition.name) ?? [];
				candidates.push(reference);
				definitionsByName.set(definition.name, candidates);
				for (const key of [definition.name, definition.type]) {
					if (key !== undefined && key.length > 0 && !definitions.has(key)) {
						definitions.set(key, reference);
					}
				}
			}
		}
	}

	for (const reference of references) {
		for (const parentIdentity of reference.definition.inherits ?? []) {
			if (definitions.has(parentIdentity)) continue;
			const parent = uniqueDefinitionByQualifiedName(parentIdentity, definitionsByName);
			if (parent !== undefined) {
				definitions.set(parentIdentity, parent);
			}
		}
	}

	return definitions;
}

/** 解析清单中能够确定的常量引用；其它 Simple 表达式保持原样。 */
export function resolveSdkConstantValue(
	expression: string | undefined,
	definitions: ReadonlyMap<string, LibraryDefinitionReference> | undefined
): string | undefined {
	const value = expression?.trim();
	if (value === undefined || definitions === undefined) return value;
	const separator = value.lastIndexOf(".");
	if (separator > 0 && separator < value.length - 1) {
		return definitions.get(value.slice(0, separator))?.definition.constants
			?.find((constant) => constant.name === value.slice(separator + 1))?.value ?? value;
	}
	for (const reference of definitions.values()) {
		const constant = reference.definition.constants?.find((candidate) => candidate.name === value);
		if (constant?.value !== undefined) return constant.value;
	}
	return value;
}

/**
 * 按继承顺序合并指定成员分组。
 *
 * 父级成员先加入，子级同名成员在原位置覆盖父级；循环继承通过访问集合中止。
 *
 * @param reference 需要展开成员的具体定义。
 * @param group 需要合并的成员分组。
 * @param definitions 跨清单定义索引。
 * @returns 带继承标记和实际来源的有效成员。
 */
export function getEffectiveMembers(
	reference: LibraryDefinitionReference,
	group: LibraryMemberGroup,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): readonly EffectiveLibraryMember[] {
	const result: EffectiveLibraryMember[] = [];
	const positions = new Map<string, number>();
	const visiting = new Set<string>();
	const collected = new Set<string>();

	/**
	 * 深度优先收集父级，确保继承成员先于当前定义新增成员显示。
	 *
	 * @param current 当前递归处理的定义引用。
	 */
	const collect = (current: LibraryDefinitionReference): void => {
		const identity = definitionIdentity(current.definition);
		if (visiting.has(identity) || collected.has(identity)) {
			return;
		}

		visiting.add(identity);

		for (const parentName of current.definition.inherits ?? []) {
			const parent = definitions.get(parentName);

			if (parent !== undefined) {
				collect(parent);
			}
		}

		for (const member of current.definition[group] ?? []) {
			const item: EffectiveLibraryMember = {
				inherited: current.definition !== reference.definition,
				member,
				owner: current
			};
			const key = effectiveLibraryMemberKey(member, group);
			const position = positions.get(key);

			if (position === undefined) {
				positions.set(key, result.length);
				result.push(item);
			} else {
				result[position] = item;
			}
		}

		visiting.delete(identity);
		collected.add(identity);
	};

	collect(reference);
	return result;
}

/**
 * 按投影语义返回继承后的属性；不同名称声明同一语义时优先采用最具体定义。
 */
export function getEffectivePropertyByProjection(
	reference: LibraryDefinitionReference | undefined,
	projection: LibraryPropertyProjection,
	definitions: ReadonlyMap<string, LibraryDefinitionReference>
): EffectiveLibraryMember | undefined {
	if (reference === undefined) return undefined;
	const properties = getEffectiveMembers(reference, "properties", definitions);
	for (let index = properties.length - 1; index >= 0; index -= 1) {
		const property = properties[index];
		if (property?.member.projection === projection) return property;
	}
	return undefined;
}

