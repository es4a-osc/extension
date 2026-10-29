/*
在画布顶层显示不占布局空间的滚动条，复用真实容器的滚动范围，不维护第二份布局或 XML 状态。
xhwsd@qq.com 2026-10-27
*/

/// <reference lib="dom" />

import { nextTick, onBeforeUnmount, onMounted, shallowRef, watch, type CSSProperties, type Ref } from "vue";

/** 一个方向的滚动条测量结果，长度均使用浏览器实际像素。 */
export interface DesignerScrollbarGeometry {
	readonly length: number;
	readonly range: number;
	readonly start: number;
	readonly travel: number;
}

/** 按真实视口和内容长度计算滑块，最小命中长度不能超过轨道。 */
export function designerScrollbarGeometry(viewport: number, content: number, offset: number, track: number): DesignerScrollbarGeometry {
	const range = Math.max(0, content - viewport);
	const length = Math.min(track, Math.max(24, content > 0 ? track * viewport / content : track));
	const travel = Math.max(0, track - length);
	return { length, range, start: range > 0 ? Math.min(range, Math.max(0, offset)) * travel / range : 0, travel };
}

type ScrollAxis = "horizontal" | "vertical";

/** 覆盖层只保存当前悬停容器的瞬时测量，不参与组件布局。 */
interface Scrollbar {
	readonly axis: ScrollAxis;
	readonly geometry: DesignerScrollbarGeometry;
	readonly offset: number;
	readonly style: CSSProperties;
	readonly thumbStyle: CSSProperties;
	readonly viewport: number;
}

interface ScrollDrag {
	readonly axis: ScrollAxis;
	readonly coordinate: number;
	readonly element: HTMLElement;
	readonly geometry: DesignerScrollbarGeometry;
	readonly offset: number;
	readonly pointerId: number;
	readonly surface: HTMLElement;
}

const SURFACE_SELECTOR = ".window-layout-surface, .container-layout-surface";
const INSET = 2;
const THICKNESS = 8;

/** 将导航覆盖层绑定到当前画布；显示、拖动及销毁均不发送属性编辑消息。 */
export function useDesignerScrollbars(canvas: Ref<HTMLElement | undefined>, projection: () => unknown) {
	const bars = shallowRef<readonly Scrollbar[]>([]);
	const viewportStyle = shallowRef<CSSProperties>({});
	let surface: HTMLElement | undefined;
	let pointer: Readonly<{ x: number; y: number }> | undefined;
	let drag: ScrollDrag | undefined;
	let observer: ResizeObserver | undefined;
	let frame: number | undefined;
	let disposed = false;

	/** 仅按实际溢出显示导航滑块，不读取应用运行时的滚动条开关。 */
	function axes(element: HTMLElement): readonly ScrollAxis[] {
		const style = getComputedStyle(element);
		const result: ScrollAxis[] = [];
		if (["auto", "scroll"].includes(style.overflowX) && element.scrollWidth > element.clientWidth + 1) result.push("horizontal");
		if (["auto", "scroll"].includes(style.overflowY) && element.scrollHeight > element.clientHeight + 1) result.push("vertical");
		return result;
	}

	/** 只选择指针下最内层且确实存在溢出的容器，穿透名称和选中覆盖层。 */
	function hoveredSurface(): HTMLElement | undefined {
		const root = canvas.value;
		if (root === undefined || pointer === undefined) return undefined;
		for (const target of document.elementsFromPoint(pointer.x, pointer.y)) {
			if (!(target instanceof HTMLElement) || !root.contains(target)) continue;
			if (target.closest(".designer-scrollbar-layer") !== null) return surface;
			let candidate = target.closest<HTMLElement>(SURFACE_SELECTOR);
			while (candidate !== null && root.contains(candidate)) {
				if (axes(candidate).length > 0) return candidate;
				candidate = candidate.parentElement?.closest<HTMLElement>(SURFACE_SELECTOR) ?? null;
			}
		}
		return undefined;
	}

	/** 跟踪当前视口及其直属内容的自然尺寸，不为整个项目建立观察器。 */
	function observeSurface(): void {
		if (disposed) return;
		observer?.disconnect();
		if (canvas.value !== undefined) observer?.observe(canvas.value);
		if (surface === undefined) return;
		observer?.observe(surface);
		for (const child of surface.children) if (child instanceof HTMLElement) observer?.observe(child);
	}

	/** 使用祖先真实裁剪矩形限制覆盖层，避免嵌套滚动时滑块跑到容器外。 */
	function measure(): void {
		const root = canvas.value;
		const current = drag?.surface ?? hoveredSurface();
		if (surface !== current) { surface = current; observeSurface(); }
		if (root === undefined || current === undefined || !current.isConnected) { bars.value = []; return; }
		const bounds = current.getBoundingClientRect();
		const rootBounds = root.getBoundingClientRect();
		let left = Math.max(bounds.left, rootBounds.left);
		let top = Math.max(bounds.top, rootBounds.top);
		let right = Math.min(bounds.right, rootBounds.right);
		let bottom = Math.min(bounds.bottom, rootBounds.bottom);
		for (let parent = current.parentElement; parent !== null && root.contains(parent); parent = parent.parentElement) {
			const style = getComputedStyle(parent);
			const clip = parent.getBoundingClientRect();
			if (style.overflowX !== "visible") { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
			if (style.overflowY !== "visible") { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
		}
		if (right <= left || bottom <= top) { bars.value = []; return; }
		viewportStyle.value = { left: left - rootBounds.left + "px", top: top - rootBounds.top + "px", width: right - left + "px", height: bottom - top + "px" };
		bars.value = axes(current).map(axis => {
			const horizontal = axis === "horizontal";
			const viewport = horizontal ? current.clientWidth : current.clientHeight;
			const offset = horizontal ? current.scrollLeft : current.scrollTop;
			const track = Math.max(0, (horizontal ? bounds.width : bounds.height) - INSET * 2);
			const geometry = designerScrollbarGeometry(viewport, horizontal ? current.scrollWidth : current.scrollHeight, offset, track);
			return {
				axis, geometry, offset, viewport,
				style: horizontal
					? { left: bounds.left - left + INSET + "px", top: bounds.bottom - top - THICKNESS - INSET + "px", width: track + "px", height: THICKNESS + "px" }
					: { left: bounds.right - left - THICKNESS - INSET + "px", top: bounds.top - top + INSET + "px", width: THICKNESS + "px", height: track + "px" },
				thumbStyle: horizontal
					? { left: geometry.start + "px", width: geometry.length + "px", top: "0", height: "100%" }
					: { top: geometry.start + "px", height: geometry.length + "px", left: "0", width: "100%" }
			};
		});
	}

	function scheduleMeasure(): void {
		if (disposed || frame !== undefined) return;
		frame = requestAnimationFrame(() => { frame = undefined; measure(); });
	}

	function trackPointer(event: PointerEvent): void {
		pointer = { x: event.clientX, y: event.clientY };
		scheduleMeasure();
	}

	function leaveCanvas(): void {
		pointer = undefined;
		if (drag === undefined) { surface = undefined; bars.value = []; observeSurface(); }
	}

	/** 指针捕获只属于滚动条，不能让按下滑块触发组件移动或 XML 选择。 */
	function startScroll(event: PointerEvent, bar: Scrollbar): void {
		if (event.button !== 0 || surface === undefined || !(event.currentTarget instanceof HTMLElement)) return;
		const element = event.currentTarget;
		const horizontal = bar.axis === "horizontal";
		const coordinate = horizontal ? event.clientX : event.clientY;
		if (!(event.target instanceof Element) || event.target.closest(".designer-scrollbar-thumb") === null) {
			const bounds = element.getBoundingClientRect();
			const position = coordinate - (horizontal ? bounds.left : bounds.top);
			const step = position < bar.geometry.start ? -bar.viewport : bar.viewport;
			if (horizontal) surface.scrollLeft += step;
			else surface.scrollTop += step;
		}
		drag = { axis: bar.axis, coordinate, element, geometry: bar.geometry, offset: horizontal ? surface.scrollLeft : surface.scrollTop, pointerId: event.pointerId, surface };
		element.setPointerCapture(event.pointerId);
		scheduleMeasure();
	}

	function moveScroll(event: PointerEvent): void {
		if (drag === undefined || event.pointerId !== drag.pointerId || drag.geometry.travel <= 0) return;
		const coordinate = drag.axis === "horizontal" ? event.clientX : event.clientY;
		const offset = drag.offset + (coordinate - drag.coordinate) * drag.geometry.range / drag.geometry.travel;
		if (drag.axis === "horizontal") drag.surface.scrollLeft = offset;
		else drag.surface.scrollTop = offset;
		scheduleMeasure();
	}

	function finishScroll(event?: PointerEvent): void {
		if (drag === undefined || (event !== undefined && event.pointerId !== drag.pointerId)) return;
		const previous = drag;
		drag = undefined;
		if (previous.element.hasPointerCapture(previous.pointerId)) previous.element.releasePointerCapture(previous.pointerId);
		scheduleMeasure();
	}

	/** 滑块遮盖的窄区域也继续响应滚轮，不把滚动交给设计器外层。 */
	function wheelScroll(event: WheelEvent, bar: Scrollbar): void {
		if (surface === undefined) return;
		const delta = (bar.axis === "horizontal" ? event.deltaX || event.deltaY : event.deltaY) * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bar.viewport : 1);
		if (bar.axis === "horizontal") surface.scrollLeft += delta;
		else surface.scrollTop += delta;
	}

	function keyScroll(event: KeyboardEvent, bar: Scrollbar): void {
		if (surface === undefined) return;
		const step = ({ ArrowLeft: -40, ArrowUp: -40, ArrowRight: 40, ArrowDown: 40, PageUp: -bar.viewport, PageDown: bar.viewport, Home: -bar.geometry.range, End: bar.geometry.range } as Readonly<Record<string, number>>)[event.key];
		if (step === undefined) return;
		event.preventDefault();
		if (bar.axis === "horizontal") surface.scrollLeft += step;
		else surface.scrollTop += step;
	}

	watch(projection, async () => { finishScroll(); await nextTick(); observeSurface(); scheduleMeasure(); });
	onMounted(() => {
		observer = new ResizeObserver(scheduleMeasure);
		observeSurface();
		canvas.value?.addEventListener("pointermove", trackPointer, true);
		canvas.value?.addEventListener("pointerleave", leaveCanvas);
		canvas.value?.addEventListener("scroll", scheduleMeasure, true);
		window.addEventListener("resize", scheduleMeasure);
	});
	onBeforeUnmount(() => {
		disposed = true;
		finishScroll();
		if (frame !== undefined) cancelAnimationFrame(frame);
		observer?.disconnect();
		canvas.value?.removeEventListener("pointermove", trackPointer, true);
		canvas.value?.removeEventListener("pointerleave", leaveCanvas);
		canvas.value?.removeEventListener("scroll", scheduleMeasure, true);
		window.removeEventListener("resize", scheduleMeasure);
	});
	return { bars, viewportStyle, startScroll, moveScroll, finishScroll, wheelScroll, keyScroll };
}
