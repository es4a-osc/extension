/*
提供不依赖内置布局名称、属性名称和文本基类的投影契约样本。
xhwsd@qq.com 2026-10-28
*/

import { buildDefinitionIndex, getEffectiveMembers, type LibraryMember, type Sdk } from "../sdk";

/** 非标准布局选择值和属性名用于发现按运行库名称、数值或编辑器类型分支的回归。 */
export const PROJECTION_CONTRACT_SOURCE = [
	"'用户代码与未知属性必须保持原样",
	"$属性",
	"\t$资源 $窗口",
	"\t$定义 Main $为 窗口",
	"\t\t标题 = \"投影解耦验证\"",
	"\t\t$定义 Box $为 ProjectionBox",
	"\t\t\t宽度 = 360",
	"\t\t\t高度 = 180",
	"\t\t\tLayoutMode.Axis = AxisToken",
	"\t\t\tUnknown = \"保持原样\"",
	"\t\t\t$定义 First $为 ProjectionControl",
	"\t\t\t\tSpan = SizeToken",
	"\t\t\t\t高度 = 36",
	"\t\t\t$结束 $定义",
	"\t\t\t$定义 Second $为 ProjectionTextControl",
	"\t\t\t\tSpan = SizeToken",
	"\t\t\t\t高度 = 36",
	"\t\t\t$结束 $定义",
	"\t\t$结束 $定义",
	"\t$结束 $定义",
	"$结束 $属性"
].join("\r\n");

/** 在指定 SDK 上追加隔离的测试定义，保留真实运行库布局与组件模型。 */
export function withProjectionContract(sdk: Sdk): Sdk {
	const definitions = buildDefinitionIndex(sdk.manifests);
	const text = definitions.get("simple.runtime.components.文本组件");
	if (text === undefined) throw new Error("投影验证需要运行库的文本属性声明");
	/* 两类组件使用相同的有效属性，仅保留不同的基类身份。 */
	const properties = getEffectiveMembers(text, "properties", definitions).map(({ member }): LibraryMember => {
		if (member.projection === "width") return { ...member, name: "Span" };
		if (member.projection === "text") return {
			...member, name: "Caption", initializer: { label: "字段投影", value: "\"字段投影\"" }
		};
		return member;
	});
	const runtime = text.manifest;
	return {
		...sdk,
		manifests: [...sdk.manifests, {
			...runtime,
			kind: "library",
			name: "投影解耦验证",
			categories: [{
				name: "投影契约",
				definitions: [{
					name: "ArrangementMetadata",
					kind: "layout",
					type: "probe.Arrangement",
					projection: { layout: "linear-vertical", layoutValue: "ModeToken" },
					constants: [
						{ name: "ModeToken", type: "整数型", value: "42" },
						{ name: "ModeAlias", type: "整数型", value: "42" },
						{ name: "AxisToken", type: "整数型", value: "0" },
						{ name: "SizeToken", type: "整数型", value: "104" },
						{ name: "ParentSpan", type: "整数型", value: "-2" }
					],
					properties: [{ name: "Axis", type: "整数型", projection: "orientation" }, {
						name: "Total", type: "单精度小数型", projection: "weightSum",
						initializer: { label: "十", value: "10" }
					}]
				}, {
					name: "ProjectionBox",
					kind: "component",
					type: "probe.Box",
					inherits: ["simple.runtime.components.可视组件", "simple.runtime.components.组件容器"],
					properties: [{
						name: "LayoutMode", type: "变体型", projection: "layout",
						initializer: { label: "自定义线性", value: "ModeAlias" }
					}]
				}, ...["ProjectionControl", "ProjectionTextControl"].map((name, index) => ({
					name, kind: "component", type: "probe." + name,
					inherits: [index === 0 ? "simple.runtime.components.可视组件" : "simple.runtime.components.文本组件"],
					/* 内存追加的定义同样提供加载器展开后的继承闭包，避免把第二类误作非可视组件。 */
					resolvedInherits: index === 0 ? ["simple.runtime.components.可视组件"]
						: ["simple.runtime.components.文本组件", ...(text.definition.resolvedInherits ?? text.definition.inherits ?? [])],
					properties
				}))]
			}]
		}]
	};
}
