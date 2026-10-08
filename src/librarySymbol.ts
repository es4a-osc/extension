/*
定义 SDK 类库符号的稳定身份，供语言功能与类库树导航共同使用。
xhwsd@qq.com 2026-9-3
*/

import type {
	LibraryDefinitionReference,
	LibraryMember,
	LibraryMemberGroup
} from "./sdk";

/** 可在类库树中定位的定义或成员。 */
export interface LibrarySymbolTarget {
	readonly definitionName: string;
	readonly definitionType?: string;
	readonly manifestFilePath: string;
	readonly memberGroup?: LibraryMemberGroup;
	readonly memberKey?: string;
}

/** 返回能够区分同名方法重载的稳定成员键。 */
export function libraryMemberKey(member: LibraryMember): string {
	const parameters = (member.params ?? []).map((parameter) => (
		`${parameter.byRef === true || parameter.passing === "传址" ? "&" : ""}${parameter.type ?? ""}`
	));
	return `${member.name}(${parameters.join(",")}):${member.return ?? member.type ?? ""}`;
}

/** 创建类库定义的导航目标。 */
export function libraryDefinitionTarget(
	reference: LibraryDefinitionReference
): LibrarySymbolTarget {
	return {
		definitionName: reference.definition.name,
		definitionType: reference.definition.type,
		manifestFilePath: reference.manifest.filePath
	};
}

/** 创建类库成员的导航目标，并保留其实际声明类型。 */
export function libraryMemberTarget(
	reference: LibraryDefinitionReference,
	group: LibraryMemberGroup,
	member: LibraryMember
): LibrarySymbolTarget {
	return {
		...libraryDefinitionTarget(reference),
		memberGroup: group,
		memberKey: libraryMemberKey(member)
	};
}

/** 校验从命令参数传入的类库导航目标。 */
export function isLibrarySymbolTarget(value: unknown): value is LibrarySymbolTarget {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const target = value as Partial<LibrarySymbolTarget>;
	return typeof target.definitionName === "string"
		&& target.definitionName.length > 0
		&& typeof target.manifestFilePath === "string"
		&& target.manifestFilePath.length > 0
		&& (target.definitionType === undefined || typeof target.definitionType === "string")
		&& (target.memberGroup === undefined || [
			"constants",
			"variables",
			"properties",
			"functions",
			"events"
		].includes(target.memberGroup))
		&& (target.memberKey === undefined || typeof target.memberKey === "string")
		&& ((target.memberGroup === undefined) === (target.memberKey === undefined));
}
