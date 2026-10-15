/*
在真实扩展宿主中全量核对清单定义、成员导航及图标，可显式追加外部 SDK 输入。
xhwsd@qq.com 2026-10-14
*/

import assert from "node:assert/strict";
import * as vscode from "vscode";
import { LibraryTreeProvider, type LibraryNode } from "../../libraryTree";
import { libraryMemberKey, libraryMemberTarget } from "../../librarySymbol";
import { LIBRARY_MEMBER_GROUPS } from "../../sdk";
import { loadCompatibilitySdk, validateSdkCompatibility } from "../sdkCompatibility";
import { testSdkPath } from "../testFixtures";

suite("清单内容与扩展消费解耦", () => {
	test("类库树全量消费输入清单的定义成员与图标", async function () {
		this.timeout(30000);
		const inputs = [testSdkPath("sdk.json")];
		if (process.env.ES4A_TEST_SDK_PATH !== undefined) inputs.push(process.env.ES4A_TEST_SDK_PATH);
		for (const input of inputs) {
			const sdk = await loadCompatibilitySdk(input);
			const coverage = await validateSdkCompatibility(sdk);
			const provider = new LibraryTreeProvider(async () => sdk);
			let members = 0;
			try {
				await provider.ensureLoaded();
				for (const manifest of sdk.manifests) {
					const root: LibraryNode | undefined = provider.getChildren().find((node) => node.kind === "manifest" && node.manifest === manifest);
					assert.ok(root?.kind === "manifest");
					for (const category of manifest.categories) {
						const categoryNode: LibraryNode | undefined = provider.getChildren(root).find((node) => node.kind === "category" && node.category === category);
						if (category.hidden === true) {
							assert.equal(categoryNode, undefined, "隐藏分类不应出现在类库树");
							members += category.definitions.reduce((sum, definition) => sum + LIBRARY_MEMBER_GROUPS.reduce((sum, group) => sum + (definition[group]?.length ?? 0), 0), 0);
							continue;
						}
						assert.ok(categoryNode?.kind === "category");
						assert.equal(provider.getChildren(categoryNode).length, category.definitions.length);
						for (const definition of category.definitions) {
							const definitionNode: LibraryNode | undefined = provider.getChildren(categoryNode).find((node) => node.kind === "definition" && node.reference.definition === definition);
							assert.ok(definitionNode?.kind === "definition");
							assert.equal(provider.getTreeItem(definitionNode).label, definition.name);
							if (definition.icon !== undefined) assert.ok(provider.getTreeItem(definitionNode).iconPath);
							for (const group of LIBRARY_MEMBER_GROUPS) {
								for (const member of definition[group] ?? []) {
									members += 1;
									const groupNode: LibraryNode | undefined = provider.getChildren(definitionNode).find((node) => node.kind === "group" && node.group === group);
									assert.ok(groupNode?.kind === "group");
									const node: LibraryNode | undefined = provider.getChildren(groupNode).find((node) => node.kind === "member" && libraryMemberKey(node.value.member) === libraryMemberKey(member));
									assert.ok(node?.kind === "member", `${definition.name}.${member.name} 未进入类库树`);
									const target = libraryMemberTarget({ definition, manifest }, group, member);
									const navigated = await provider.findSymbol(target);
									// 编译器语言标记可以浏览，但不属于运行库／类库符号导航的目标。
									if (manifest.kind === "compiler") assert.equal(navigated, undefined);
									else assert.ok(navigated?.kind === "member");
									const item = provider.getTreeItem(node);
									assert.ok(String(item.label).includes(member.name));
									assert.ok(item.tooltip instanceof vscode.MarkdownString);
									const parent = provider.getParent(node);
									assert.ok(parent?.kind === "group");
									const owner = provider.getParent(parent);
									assert.ok(owner?.kind === "definition");
									assert.equal(owner.reference.definition, definition);
									if (definition.icon !== undefined) assert.ok(provider.getTreeItem(owner).iconPath);
								}
							}
						}
					}
				}
				assert.equal(members, coverage.members);
			} finally {
				provider.dispose();
			}
		}
	});
});
