/*
按输入清单全量验证扩展的定义、继承、签名、图标和设计器消费，不固定产品内容。
xhwsd@qq.com 2026-10-14
*/

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createComponentIconSources, resolveDefinitionIconPath } from "../componentIcon";
import { createSimpleDesignerModel } from "../designerModel";
import {
	buildDefinitionIndex, getEffectiveMembers, isComponentDefinition, isWindowDefinition,
	LIBRARY_MEMBER_GROUPS, loadSdk, type LibraryDefinitionReference, type LibraryMember,
	type LibraryMemberGroup, type Sdk
} from "../sdk";
import { buildSdkSignatures } from "../signatures";

/** 可报告的实际遍历数量，空输入不能伪装成全量验证通过。 */
export interface SdkCompatibilityCoverage {
	manifests: number;
	definitions: number;
	members: number;
	parameters: number;
	icons: number;
	components: number;
	/** 未公开为清单定义的父类型不贡献成员，单独报告，避免静默遗漏。 */
	unresolvedParents: readonly string[];
}

/** 外部入口和附加类库只读加载；临时入口使用原清单基准解析路径，不写 SDK。 */
export async function loadCompatibilitySdk(entryFile: string, libraries: readonly string[] = []): Promise<Sdk> {
	const entry = path.resolve(entryFile);
	if (libraries.length === 0) return loadSdk(entry);
	const source: unknown = JSON.parse(await fs.readFile(entry, "utf8"));
	assert.ok(source !== null && typeof source === "object" && !Array.isArray(source));
	const directory = path.dirname(entry);
	const rebase = (value: unknown, key?: string): unknown => {
		if (typeof value === "string" && ["compiler", "runtime", "command", "template"].includes(key ?? "")) {
			return path.resolve(directory, value);
		}
		if (Array.isArray(value)) return value.map((item) => rebase(item));
		if (value !== null && typeof value === "object") {
			return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, rebase(item, name)]));
		}
		return value;
	};
	const rebased = rebase(source) as Record<string, unknown>;
	const registered = (source as Record<string, unknown>).libraries;
	assert.ok(registered === undefined || Array.isArray(registered), "libraries 必须是数组");
	rebased.libraries = [...new Set([
		...(registered ?? []).map((item: unknown) => {
			assert.equal(typeof item, "string");
			return path.resolve(directory, item as string);
		}),
		...libraries.map((file) => path.resolve(file))
	])];
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "es4a-sdk-compatibility-"));
	try {
		const file = path.join(temporary, "entry.json");
		await fs.writeFile(file, JSON.stringify(rebased), "utf8");
		return await loadSdk(file);
	} finally {
		await fs.rm(temporary, { recursive: true, force: true });
	}
}

/** 独立计算继承期望；函数保留不同实参数量的重载，其它成员按名称覆盖。 */
function expectedMembers(
	reference: LibraryDefinitionReference,
	group: LibraryMemberGroup,
	index: ReturnType<typeof buildDefinitionIndex>,
	visited = new Set<string>()
): readonly LibraryMember[] {
	const identity = reference.definition.type ?? reference.definition.name;
	assert.ok(!visited.has(identity), `循环继承：${identity}`);
	const next = new Set(visited).add(identity);
	const members = new Map<string, LibraryMember>();
	const put = (member: LibraryMember): void => {
		const key = group === "functions" ? `${member.name}\0${member.params?.length ?? 0}` : member.name;
		members.set(key, member);
	};
	for (const identity of reference.definition.inherits ?? []) {
		const parent = index.get(identity);
		// 清单可以保留没有公开成员元数据的 Java 标记接口；扩展也不能凭空生成其成员。
		if (parent === undefined) continue;
		for (const member of expectedMembers(parent, group, index, next)) put(member);
	}
	for (const member of reference.definition[group] ?? []) put(member);
	return [...members.values()];
}

/** 检查全部原始声明都有消费结果，期望来自输入字段而非复制消费函数的输出。 */
export async function validateSdkCompatibility(sdk: Sdk): Promise<SdkCompatibilityCoverage> {
	assert.deepEqual(sdk.issues, [], "清单加载不应丢弃或拒绝有效声明");
	assert.ok(sdk.manifests.length > 0, "没有加载任何清单");
	const coverage: SdkCompatibilityCoverage = {
		manifests: sdk.manifests.length, definitions: 0, members: 0, parameters: 0, icons: 0, components: 0,
		unresolvedParents: []
	};
	const index = buildDefinitionIndex(sdk.manifests);
	const expectedSignatures: unknown[] = [];
	const toolbox = createSimpleDesignerModel(undefined, sdk).toolbox.flatMap((group) => group.items);
	const checkedComponents = new Set<string>();
	const unresolvedParents = new Set<string>();
	for (const manifest of sdk.manifests) {
		const raw = JSON.parse(await fs.readFile(manifest.filePath, "utf8")) as {
			categories: { definitions: { name: string; [key: string]: unknown }[] }[];
		};
		const rawDefinitions = raw.categories.flatMap((category) => category.definitions);
		const definitions = manifest.categories.flatMap((category) => category.definitions);
		assert.equal(definitions.length, rawDefinitions.length, `${manifest.name} 的定义被遗漏`);
		for (const [position, definition] of definitions.entries()) {
			coverage.definitions += 1;
			assert.equal(definition.name, rawDefinitions[position]!.name);
			const reference = { definition, manifest };
			for (const parent of definition.inherits ?? []) if (!index.has(parent)) unresolvedParents.add(parent);
			assert.ok(index.has(definition.type ?? definition.name), `定义未进入索引：${definition.name}`);
			for (const group of LIBRARY_MEMBER_GROUPS) {
				const declared = definition[group] ?? [];
				const rawMembers = rawDefinitions[position]![group] as readonly LibraryMember[] | undefined;
				assert.equal(declared.length, rawMembers?.length ?? 0, `${definition.name}.${group} 被遗漏`);
				const actual = getEffectiveMembers(reference, group, index).map(({ member }) => member);
				assert.deepEqual(actual, expectedMembers(reference, group, index), `${definition.name}.${group} 继承错误`);
				for (const [memberPosition, member] of declared.entries()) {
					coverage.members += 1;
					assert.equal(member.name, rawMembers![memberPosition]!.name);
					assert.deepEqual(member.params ?? [], rawMembers![memberPosition]!.params ?? []);
					coverage.parameters += member.params?.length ?? 0;
				}
			}
			for (const member of [...definition.functions ?? [], ...definition.events ?? []]) {
				expectedSignatures.push({
					description: member.description, name: member.name, owner: definition.name,
					parameters: (member.params ?? []).map((parameter) => ({
						byRef: parameter.byRef, description: parameter.description,
						name: parameter.name, type: parameter.type
					})), return: member.return
				});
			}
			if (definition.icon !== undefined) {
				coverage.icons += 1;
				const icon = resolveDefinitionIconPath(reference);
				assert.ok(icon, `图标无效：${definition.name} / ${definition.icon}`);
				assert.equal(icon, path.resolve(path.dirname(manifest.filePath), definition.icon));
				assert.ok(createComponentIconSources(icon), `SVG 无法加载：${icon}`);
			}
			if (isComponentDefinition(definition) && !isWindowDefinition(definition) && !checkedComponents.has(definition.name)) {
				checkedComponents.add(definition.name);
				coverage.components += 1;
				const item = toolbox.find((candidate) => candidate.name === definition.name);
				assert.ok(item, `组件未进入设计器：${definition.name}`);
				assert.equal(item.runtimeType, definition.type ?? definition.name);
				if (definition.icon !== undefined) assert.equal(item.icon, resolveDefinitionIconPath(reference));
			}
		}
	}
	assert.ok(coverage.definitions > 0, "没有遍历任何定义");
	assert.deepEqual(buildSdkSignatures(sdk), expectedSignatures, "函数和事件签名遗漏或次序错误");
	coverage.unresolvedParents = [...unresolvedParents];
	return coverage;
}
