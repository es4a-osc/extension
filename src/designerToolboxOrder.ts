/*
合并分组后的用户顺序及暂不可用分组的顺序保留规则。
xhwsd@qq.com 2026-11-1
*/

import type { DesignerToolboxGroup } from "./designerModel";

/** 清理用户分类列表中的无效名称与重复项，保留首次出现顺序。 */
export function normalizeToolboxCategoryOrder(value: unknown): readonly string[] {
	return Array.isArray(value)
		? [...new Set(value.filter((name): name is string => typeof name === "string" && name.trim().length > 0))]
		: [];
}

/** 全部分组统一应用用户顺序，其余分组按发现顺序追加。 */
export function orderToolboxCategories(
	groups: readonly DesignerToolboxGroup[],
	order: readonly string[]
): readonly DesignerToolboxGroup[] {
	const available = new Map(groups.map((group) => [group.name, group]));
	const sorted: DesignerToolboxGroup[] = [];
	for (const name of order) {
		const group = available.get(name);
		if (group === undefined) {
			continue;
		}
		sorted.push(group);
		available.delete(name);
	}
	return [...sorted, ...available.values()];
}

/** 移动当前可见分组，同时保留用户列表中暂不可用分组的槽位。 */
export function moveToolboxCategory(
	savedOrder: readonly string[],
	groups: readonly DesignerToolboxGroup[],
	category: string,
	reference: string,
	position: "before" | "after"
): readonly string[] | undefined {
	const names = orderToolboxCategories(groups, savedOrder).map((group) => group.name);
	if (category === reference || !names.includes(category) || !names.includes(reference)) {
		return undefined;
	}
	const moved = names.filter((name) => name !== category);
	moved.splice(moved.indexOf(reference) + (position === "after" ? 1 : 0), 0, category);
	const visible = new Set(names);
	let index = 0;
	const merged = normalizeToolboxCategoryOrder(savedOrder).map((name) => visible.has(name) ? moved[index++]! : name);
	return [...merged, ...moved.slice(index)];
}
