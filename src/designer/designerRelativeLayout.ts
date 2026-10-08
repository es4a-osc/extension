/*
只根据 XML 投影模型和已渲染尺寸计算相对布局位置，不读取或执行 Simple 代码区。
xhwsd@qq.com 2026-9-17
*/

/// <reference lib="dom" />

import {
	nextTick,
	onBeforeUnmount,
	onMounted,
	shallowRef,
	watch,
	type ComputedRef,
	type Ref
} from "vue";
import type {
	DesignerBoxSpacing,
	DesignerComponentNode,
	DesignerRelativePositionIssue,
	DesignerRelativeRules
} from "../designerModel";

export type DesignerProjectedRelativePositionIssue = DesignerRelativePositionIssue | "cycle";

/** 浏览器测量后的一个相对布局直属子组件。 */
export interface DesignerRelativeLayoutItem {
	readonly height: number;
	readonly issue?: DesignerRelativePositionIssue;
	readonly margin?: DesignerBoxSpacing;
	readonly path: string;
	readonly rules?: DesignerRelativeRules;
	readonly width: number;
}

/** 相对布局在设计器内容区内计算出的临时位置。 */
export interface DesignerProjectedRelativePosition {
	readonly issue?: DesignerProjectedRelativePositionIssue;
	readonly left: number;
	readonly top: number;
}

interface AxisProjection {
	readonly cycle: boolean;
	readonly missing: boolean;
	readonly value: number;
}

/** 以左到右方向解释 Android START/END，并用确定性回退处理坏锚点和循环。 */
export function resolveDesignerRelativePositions(
	containerWidth: number,
	containerHeight: number,
	items: readonly DesignerRelativeLayoutItem[]
): ReadonlyMap<string, DesignerProjectedRelativePosition> {
	const byPath = new Map(items.map((item) => [item.path, item]));
	const horizontalCache = new Map<string, AxisProjection>();
	const verticalCache = new Map<string, AxisProjection>();
	const horizontalVisiting = new Set<string>();
	const verticalVisiting = new Set<string>();
	const margin = (item: DesignerRelativeLayoutItem, side: keyof DesignerBoxSpacing): number => (
		item.margin?.[side] ?? 0
	);

	const horizontal = (path: string): AxisProjection => {
		const cached = horizontalCache.get(path);
		if (cached !== undefined) return cached;
		const item = byPath.get(path);
		if (item === undefined) return { cycle: false, missing: true, value: 0 };
		const fallback = margin(item, "left");
		if (horizontalVisiting.has(path)) return { cycle: true, missing: false, value: fallback };
		horizontalVisiting.add(path);
		const rules = item.rules;
		let projection: AxisProjection = { cycle: false, missing: false, value: fallback };
		const anchor = (targetPath: string | undefined): { readonly item?: DesignerRelativeLayoutItem; readonly projection: AxisProjection } => {
			if (targetPath === undefined) return { projection: { cycle: false, missing: true, value: 0 } };
			const target = byPath.get(targetPath);
			return { item: target, projection: horizontal(targetPath) };
		};
		if (rules?.centerInParent === true || rules?.centerHorizontal === true) {
			projection = { cycle: false, missing: false, value: (containerWidth - item.width) / 2 };
		} else if (rules?.alignParentStart === true || rules?.alignParentLeft === true) {
			projection = { cycle: false, missing: false, value: margin(item, "left") };
		} else if (rules?.alignParentEnd === true || rules?.alignParentRight === true) {
			projection = {
				cycle: false,
				missing: false,
				value: containerWidth - item.width - margin(item, "right")
			};
		} else if (rules?.startOf !== undefined || rules?.leftOf !== undefined) {
			const target = anchor(rules.startOf ?? rules.leftOf);
			projection = target.item === undefined
				? { ...target.projection, value: fallback }
				: {
					...target.projection,
					value: target.projection.value - item.width - margin(item, "right")
				};
		} else if (rules?.endOf !== undefined || rules?.rightOf !== undefined) {
			const target = anchor(rules.endOf ?? rules.rightOf);
			projection = target.item === undefined
				? { ...target.projection, value: fallback }
				: {
					...target.projection,
					value: target.projection.value + target.item.width + margin(item, "left")
				};
		} else if (rules?.alignStart !== undefined || rules?.alignLeft !== undefined) {
			const target = anchor(rules.alignStart ?? rules.alignLeft);
			projection = target.item === undefined
				? { ...target.projection, value: fallback }
				: { ...target.projection, value: target.projection.value + margin(item, "left") };
		} else if (rules?.alignEnd !== undefined || rules?.alignRight !== undefined) {
			const target = anchor(rules.alignEnd ?? rules.alignRight);
			projection = target.item === undefined
				? { ...target.projection, value: fallback }
				: {
					...target.projection,
					value: target.projection.value + target.item.width - item.width - margin(item, "right")
				};
		}
		horizontalVisiting.delete(path);
		horizontalCache.set(path, projection);
		return projection;
	};

	const vertical = (path: string): AxisProjection => {
		const cached = verticalCache.get(path);
		if (cached !== undefined) return cached;
		const item = byPath.get(path);
		if (item === undefined) return { cycle: false, missing: true, value: 0 };
		const fallback = margin(item, "top");
		if (verticalVisiting.has(path)) return { cycle: true, missing: false, value: fallback };
		verticalVisiting.add(path);
		const rules = item.rules;
		let projection: AxisProjection = { cycle: false, missing: false, value: fallback };
		const anchor = (targetPath: string | undefined): { readonly item?: DesignerRelativeLayoutItem; readonly projection: AxisProjection } => {
			if (targetPath === undefined) return { projection: { cycle: false, missing: true, value: 0 } };
			const target = byPath.get(targetPath);
			return { item: target, projection: vertical(targetPath) };
		};
		if (rules?.centerInParent === true || rules?.centerVertical === true) {
			projection = { cycle: false, missing: false, value: (containerHeight - item.height) / 2 };
		} else if (rules?.alignParentTop === true) {
			projection = { cycle: false, missing: false, value: margin(item, "top") };
		} else if (rules?.alignParentBottom === true) {
			projection = {
				cycle: false,
				missing: false,
				value: containerHeight - item.height - margin(item, "bottom")
			};
		} else if (rules?.above !== undefined) {
			const target = anchor(rules.above);
			projection = target.item === undefined
				? { ...target.projection, value: fallback }
				: {
					...target.projection,
					value: target.projection.value - item.height - margin(item, "bottom")
				};
		} else if (rules?.below !== undefined) {
			const target = anchor(rules.below);
			projection = target.item === undefined
				? { ...target.projection, value: fallback }
				: {
					...target.projection,
					value: target.projection.value + target.item.height + margin(item, "top")
				};
		} else if (rules?.alignTop !== undefined) {
			const target = anchor(rules.alignTop);
			projection = target.item === undefined
				? { ...target.projection, value: fallback }
				: { ...target.projection, value: target.projection.value + margin(item, "top") };
		} else if (rules?.alignBaseline !== undefined || rules?.alignBottom !== undefined) {
			const target = anchor(rules.alignBaseline ?? rules.alignBottom);
			projection = target.item === undefined
				? { ...target.projection, value: fallback }
				: {
					...target.projection,
					value: target.projection.value + target.item.height - item.height - margin(item, "bottom")
				};
		}
		verticalVisiting.delete(path);
		verticalCache.set(path, projection);
		return projection;
	};

	return new Map(items.map((item) => {
		const x = horizontal(item.path);
		const y = vertical(item.path);
		return [item.path, {
			issue: item.issue ?? (x.cycle || y.cycle
				? "cycle"
				: x.missing || y.missing ? "missing-anchor" : undefined),
			left: x.value,
			top: y.value
		}] as const;
	}));
}

/** 比较临时位置，避免 ResizeObserver 因等值 Vue 更新形成无效循环。 */
function equalPositions(
	left: ReadonlyMap<string, DesignerProjectedRelativePosition>,
	right: ReadonlyMap<string, DesignerProjectedRelativePosition>
): boolean {
	if (left.size !== right.size) return false;
	for (const [path, value] of left) {
		const candidate = right.get(path);
		if (
			candidate === undefined
			|| candidate.left !== value.left
			|| candidate.top !== value.top
			|| candidate.issue !== value.issue
		) return false;
	}
	return true;
}

/** 在窗口根和嵌套容器中复用同一套 DOM 测量与相对约束投影。 */
export function useDesignerRelativeLayoutProjection(
	surface: Ref<HTMLElement | undefined>,
	node: ComputedRef<DesignerComponentNode | undefined>
): Readonly<Ref<ReadonlyMap<string, DesignerProjectedRelativePosition>>> {
	const positions = shallowRef<ReadonlyMap<string, DesignerProjectedRelativePosition>>(new Map());
	let observer: ResizeObserver | undefined;
	let animationFrame: number | undefined;

	const calculate = (): void => {
		animationFrame = undefined;
		const currentSurface = surface.value;
		const currentNode = node.value;
		if (currentSurface === undefined || currentNode?.layout !== "relative") {
			if (positions.value.size > 0) positions.value = new Map();
			return;
		}
		const elements = new Map<string, HTMLElement>();
		for (const child of Array.from(currentSurface.children)) {
			if (child instanceof HTMLElement && child.dataset.nodePath !== undefined) {
				elements.set(child.dataset.nodePath, child);
			}
		}
		const items: DesignerRelativeLayoutItem[] = [];
		for (const child of currentNode.children) {
			if (!child.visual) continue;
			const element = elements.get(child.path);
			if (element === undefined) continue;
			/*
			 * 父容器的 clientWidth/clientHeight 是未受 CSS zoom 或视觉变换影响的布局坐标。
			 * 子组件必须使用同一坐标系；getBoundingClientRect 会混入视觉缩放，导致右/底对齐越界。
			 */
			items.push({
				height: element.offsetHeight,
				issue: child.relativePositionIssue,
				margin: child.margin,
				path: child.path,
				rules: child.relativeRules,
				width: element.offsetWidth
			});
		}
		const next = resolveDesignerRelativePositions(
			currentSurface.clientWidth,
			currentSurface.clientHeight,
			items
		);
		if (!equalPositions(positions.value, next)) positions.value = next;
	};

	const schedule = (): void => {
		if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
		animationFrame = requestAnimationFrame(calculate);
	};

	const observe = (): void => {
		observer?.disconnect();
		observer = undefined;
		const currentSurface = surface.value;
		if (currentSurface === undefined || node.value?.layout !== "relative") return;
		observer = new ResizeObserver(schedule);
		observer.observe(currentSurface);
		for (const child of Array.from(currentSurface.children)) {
			if (child instanceof HTMLElement && child.dataset.nodePath !== undefined) observer.observe(child);
		}
	};

	const refresh = (): void => {
		void nextTick().then(() => {
			observe();
			schedule();
		});
	};

	onMounted(refresh);
	watch([surface, node], refresh);
	onBeforeUnmount(() => {
		observer?.disconnect();
		if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
	});
	return positions;
}
