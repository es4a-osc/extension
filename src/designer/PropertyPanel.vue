<!--
按照属性面板模型呈现单元或组件属性，并把用户编辑转换为 XML 路径提交消息。
xhwsd@qq.com 2026-8-30
-->

<template>
	<div ref="content" class="section-content property-content">
		<main v-if="model.emptyMessage !== undefined" class="empty-state">
			<span class="codicon codicon-layout codicon-placeholder" aria-hidden="true"></span>
			<p>{{ model.emptyMessage }}</p>
		</main>
		<template v-else>
			<header
				:class="['component-header', { 'component-header-with-icon': model.component === true }]"
				:title="model.component === true ? hoverHint : undefined"
			>
				<ComponentIcon
					v-if="model.component === true"
					modifier="component-icon-header"
					:source="model.icon"
					:type="model.subtitle ?? '组件'"
				/>
				<div class="component-name">{{ model.title ?? "当前单元" }}</div>
				<div class="component-type">{{ model.subtitle ?? "" }}</div>
			</header>
			<main class="property-list" role="table" aria-label="组件属性">
				<details v-for="group in model.groups" :key="group.name" class="property-group" open>
					<summary>
						<span class="group-disclosure" aria-hidden="true">
							<span class="codicon codicon-fold group-disclosure-closed"></span>
							<span class="codicon codicon-unfold group-disclosure-open"></span>
						</span>
						<span>{{ group.name }}</span>
					</summary>
					<div role="rowgroup">
						<div
							v-for="row in group.rows"
							:key="`${group.name}:${row.name}`"
							:class="['property-row', 'value-' + row.valueSource]"
							role="row"
						>
							<div class="property-name" role="cell" :title="propertyHoverHint(row)">{{ row.name }}</div>
							<div
								v-overflow-title="propertyValueDisplayText(row)"
								class="property-value"
								role="cell"
							>
								<span v-if="row.editTarget === undefined" class="property-readonly-value">{{ propertyValueDisplayText(row) }}</span>
								<div v-else class="property-editor">
									<input
										v-if="row.choices === undefined || row.allowCustomValue === true"
										class="property-editor-control property-input"
										type="text"
										:value="propertyEditorValue(row)"
										:placeholder="propertyEditorPlaceholder(row)"
										:aria-label="propertyValueAriaLabel(row)"
										:data-atomic-expression="isAtomicPropertyExpression(row) ? 'true' : 'false'"
										autocomplete="off"
										spellcheck="false"
										v-bind="editData(row)"
										@beforeinput="propertyBeforeInput"
										@blur="blurProperty"
										@click="selectAtomicPropertyInput"
										@focus="selectAtomicPropertyInput"
										@keydown="propertyKeydown"
									>
									<label
										v-if="row.color !== undefined"
										class="property-color-trigger"
										title="选择颜色"
									>
										<span
											:class="['property-color-swatch', { 'property-color-swatch-unknown': row.color.previewValue === undefined }]"
											:style="row.color.previewValue === undefined ? undefined : { backgroundColor: row.color.previewValue }"
										></span>
										<input
											class="property-color-input"
											type="color"
											:value="row.color.inputValue"
											:aria-label="'选择' + row.name"
											v-bind="editData(row)"
											@change="changeColorProperty($event, row)"
										>
									</label>
									<button
										v-if="row.choices !== undefined"
										:class="['property-choice-trigger', { 'property-choice-trigger-full': row.allowCustomValue !== true }]"
										:aria-expanded="propertyChoiceMenuOpen(row)"
										:aria-label="propertyValueAriaLabel(row)"
										type="button"
										@click.stop="togglePropertyChoiceMenu($event, row)"
									>
										<span v-if="row.allowCustomValue !== true" class="property-choice-value">
											{{ propertyValueDisplayText(row) }}
										</span>
										<span class="codicon codicon-chevron-down property-choice-arrow" aria-hidden="true"></span>
									</button>
									<Teleport to="body">
										<div
											v-if="row.choices !== undefined && propertyChoiceMenuOpen(row)"
											class="property-choice-menu"
											role="listbox"
											:aria-label="row.name + '的候选值'"
											:style="propertyChoiceMenuStyle"
										>
											<button
												v-if="row.valueSource === 'explicit' && row.editTarget.removeElementWhenEmpty === true"
												class="property-choice-option property-choice-option-default"
												type="button"
												v-bind="editData(row)"
												@click="choosePropertyOption($event, DEFAULT_PROPERTY_SELECT_VALUE)"
											>清除赋值</button>
											<button
												v-for="choice in row.choices"
												:key="`${choice.label}:${choice.value}`"
												class="property-choice-option"
												type="button"
												v-bind="editData(row)"
												@click="choosePropertyOption($event, choice.value)"
											>{{ choice.label }}</button>
										</div>
									</Teleport>
									<button
										v-if="row.choices === undefined && row.valueSource === 'explicit' && (row.editTarget.removeElementWhenEmpty === true || row.editTarget.effect === 'editComponentComment')"
										class="property-clear"
										type="button"
										:title="row.editTarget.effect === 'editComponentComment' ? '清除注释' : '清除赋值'"
										:aria-label="row.editTarget.effect === 'editComponentComment' ? '清除组件注释' : '清除' + row.name + '的赋值'"
										v-bind="editData(row)"
										@click="clearProperty"
									><span class="codicon codicon-close-small" aria-hidden="true"></span></button>
								</div>
							</div>
						</div>
					</div>
				</details>
			</main>
		</template>
	</div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch, useTemplateRef, type ObjectDirective } from "vue";
import type {
	PropertyPanelModel,
	PropertyPanelRow
} from "../propertyPanelModel";
import ComponentIcon from "./ComponentIcon.vue";
import {
	DEFAULT_PROPERTY_SELECT_VALUE,
	isAtomicPropertyExpression,
	propertyEditorPlaceholder,
	propertyEditorValue,
	propertyHoverHint,
	propertySelectSubmission,
	propertyValueDisplayText,
	propertyValueNeedsTooltip,
	propertyValueAriaLabel
} from "./propertyPresentation";

const props = defineProps<{
	readonly hoverHint?: string;
	readonly model: PropertyPanelModel;
	readonly selectedPath?: string;
}>();

const emit = defineEmits<{
	submit: [element: HTMLInputElement | HTMLButtonElement, value: string, allowEmpty?: boolean];
}>();

const content = useTemplateRef<HTMLElement>("content");
const openPropertyChoiceKey = ref<string>();
const propertyChoiceMenuStyle = ref<Record<string, string>>({});
const PROPERTY_CHOICE_MENU_MAX_HEIGHT = 240;
const PROPERTY_CHOICE_MENU_MARGIN = 4;
interface OverflowTitleState {
	readonly observer: ResizeObserver;
	value: string;
}
const overflowTitleStates = new WeakMap<HTMLElement, OverflowTitleState>();

/** 收起当前属性面板内的全部原生 details 分组。 */
function collapseAllPropertyGroups(): void {
	closePropertyChoiceMenu();
	for (const group of content.value?.querySelectorAll<HTMLDetailsElement>(".property-group") ?? []) {
		group.open = false;
	}
}

/** 展开当前属性面板内的全部原生 details 分组。 */
function expandAllPropertyGroups(): void {
	closePropertyChoiceMenu();
	for (const group of content.value?.querySelectorAll<HTMLDetailsElement>(".property-group") ?? []) {
		group.open = true;
	}
}

defineExpose({ collapseAllPropertyGroups, expandAllPropertyGroups });

/** 取得属性值列中实际承载可见文本的元素。 */
function propertyValueContent(cell: HTMLElement): HTMLElement | undefined {
	return cell.querySelector<HTMLElement>(
		".property-editor-control, .property-choice-trigger, .property-readonly-value"
	) ?? undefined;
}

/** 使用当前控件字体测量属性值文本，不把下拉箭头占用空间误算为可显示区域。 */
function updateOverflowTitle(cell: HTMLElement, value: string): void {
	const target = propertyValueContent(cell);
	if (target === undefined || value.length === 0) {
		cell.removeAttribute("title");
		return;
	}
	const style = getComputedStyle(target);
	const canvas = document.createElement("canvas");
	const context = canvas.getContext("2d");
	if (context === null) {
		cell.removeAttribute("title");
		return;
	}
	context.font = style.font;
	const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
	const border = Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.borderRightWidth);
	const selectArrow = target.classList.contains("property-choice-trigger-full") ? 24 : 0;
	const availableWidth = target.clientWidth - padding - border - selectArrow;
	const textWidth = context.measureText(value).width;
	if (propertyValueNeedsTooltip(availableWidth, textWidth)) {
		cell.title = value;
	} else {
		cell.removeAttribute("title");
	}
}

/** 跟随属性值和列宽变化更新原生悬停提示。 */
const vOverflowTitle: ObjectDirective<HTMLElement, string> = {
	mounted(cell, binding) {
		updateOverflowTitle(cell, binding.value);
		const state: OverflowTitleState = {
			observer: new ResizeObserver(() => updateOverflowTitle(cell, state.value)),
			value: binding.value
		};
		state.observer.observe(cell);
		overflowTitleStates.set(cell, state);
	},
	updated(cell, binding) {
		const state = overflowTitleStates.get(cell);
		if (state !== undefined) state.value = binding.value;
		updateOverflowTitle(cell, binding.value);
	},
	unmounted(cell) {
		overflowTitleStates.get(cell)?.observer.disconnect();
		overflowTitleStates.delete(cell);
	}
};

/** 组件选择变化时从属性首行开始显示；同一组件的模型刷新不改变阅读位置。 */
watch(() => props.selectedPath, (current, previous) => {
	if (current === previous) return;
	closePropertyChoiceMenu();
	if (content.value !== null) content.value.scrollTop = 0;
});

/** 使用属性 XML 路径标识当前唯一展开的候选菜单。 */
function propertyChoiceKey(row: PropertyPanelRow): string {
	return row.editTarget?.xmlPath ?? row.name;
}

/** 判断指定属性的候选菜单是否处于展开状态。 */
function propertyChoiceMenuOpen(row: PropertyPanelRow): boolean {
	return openPropertyChoiceKey.value === propertyChoiceKey(row);
}

/** 关闭当前候选菜单。 */
function closePropertyChoiceMenu(): void {
	openPropertyChoiceKey.value = undefined;
}

/** 在属性值列附近定位根层弹出菜单，并根据上下可用空间选择展开方向。 */
function togglePropertyChoiceMenu(event: MouseEvent, row: PropertyPanelRow): void {
	const trigger = event.currentTarget;
	if (!(trigger instanceof HTMLButtonElement)) return;
	const key = propertyChoiceKey(row);
	if (openPropertyChoiceKey.value === key) {
		closePropertyChoiceMenu();
		return;
	}
	const editor = trigger.closest<HTMLElement>(".property-editor") ?? trigger;
	const rect = editor.getBoundingClientRect();
	const viewportWidth = window.innerWidth;
	const viewportHeight = window.innerHeight;
	const width = Math.max(0, Math.min(rect.width, viewportWidth - PROPERTY_CHOICE_MENU_MARGIN * 2));
	const left = Math.max(
		PROPERTY_CHOICE_MENU_MARGIN,
		Math.min(rect.left, viewportWidth - width - PROPERTY_CHOICE_MENU_MARGIN)
	);
	const spaceBelow = viewportHeight - rect.bottom - PROPERTY_CHOICE_MENU_MARGIN * 2;
	const spaceAbove = rect.top - PROPERTY_CHOICE_MENU_MARGIN * 2;
	const openAbove = spaceBelow < PROPERTY_CHOICE_MENU_MAX_HEIGHT / 2 && spaceAbove > spaceBelow;
	const availableHeight = Math.max(
		60,
		Math.min(PROPERTY_CHOICE_MENU_MAX_HEIGHT, openAbove ? spaceAbove : spaceBelow)
	);
	propertyChoiceMenuStyle.value = {
		...(openAbove
			? { bottom: `${viewportHeight - rect.top + PROPERTY_CHOICE_MENU_MARGIN}px` }
			: { top: `${rect.bottom + PROPERTY_CHOICE_MENU_MARGIN}px` }),
		left: `${left}px`,
		maxHeight: `${availableHeight}px`,
		width: `${width}px`
	};
	openPropertyChoiceKey.value = key;
}

/** 点击弹层以外区域时关闭菜单。 */
function closePropertyChoiceMenuFromPointer(event: PointerEvent): void {
	const target = event.target;
	if (target instanceof Element && target.closest(".property-choice-trigger, .property-choice-menu") !== null) return;
	closePropertyChoiceMenu();
}

/** 菜单自身可以滚动；其它区域滚动时关闭菜单，避免固定弹层脱离锚点。 */
function closePropertyChoiceMenuFromScroll(event: Event): void {
	const target = event.target;
	if (target instanceof Element && target.closest(".property-choice-menu") !== null) return;
	closePropertyChoiceMenu();
}

function closePropertyChoiceMenuFromKeyboard(event: KeyboardEvent): void {
	if (event.key === "Escape") closePropertyChoiceMenu();
}

onMounted(() => {
	document.addEventListener("pointerdown", closePropertyChoiceMenuFromPointer);
	document.addEventListener("scroll", closePropertyChoiceMenuFromScroll, true);
	window.addEventListener("resize", closePropertyChoiceMenu);
	window.addEventListener("keydown", closePropertyChoiceMenuFromKeyboard);
});

onBeforeUnmount(() => {
	document.removeEventListener("pointerdown", closePropertyChoiceMenuFromPointer);
	document.removeEventListener("scroll", closePropertyChoiceMenuFromScroll, true);
	window.removeEventListener("resize", closePropertyChoiceMenu);
	window.removeEventListener("keydown", closePropertyChoiceMenuFromKeyboard);
});

/** 把模型中的 XML 路径、有效显示值和 XML 原值编码为提交时读取的稳定 DOM 元数据。 */
function editData(
	row: PropertyPanelRow
): Record<string, string> {
	return {
		"data-color-alpha": row.color?.alpha ?? "",
		"data-component-name": props.model.title ?? "",
		"data-edit-effect": row.editTarget?.effect ?? "",
		"data-original-input-value": propertyEditorValue(row),
		"data-original-value": row.valueSource === "explicit" ? row.value : "",
		"data-property-editor": row.editor ?? "",
		"data-property-name": row.name,
		"data-property-type": row.typeName ?? "",
		"data-remove-element-when-empty": row.editTarget?.removeElementWhenEmpty === true ? "true" : "false",
		"data-selected-xml-path": props.selectedPath ?? "",
		"data-string-literal-input": row.stringLiteralInput === undefined ? "false" : "true",
		"data-xml-path": row.editTarget?.xmlPath ?? ""
	};
}

/** 输入框失去焦点时，将当前值交给根组件检查并提交。 */
function blurProperty(event: FocusEvent): void {
	const element = event.currentTarget;
	if (element instanceof HTMLInputElement) emit("submit", element, element.value);
}

/** 将浏览器选择的颜色交给统一属性提交边界转换为 Simple 字面量。 */
function changeColorProperty(event: Event, row: PropertyPanelRow): void {
	const element = event.currentTarget;
	if (!(element instanceof HTMLInputElement) || row.color === undefined) return;
	emit("submit", element, element.value);
}

/** 把候选值或清除操作提交给同一属性输入框。 */
function choosePropertyOption(event: MouseEvent, value: string): void {
	const element = event.currentTarget;
	if (!(element instanceof HTMLButtonElement)) return;
	const submission = propertySelectSubmission(value);
	emit("submit", element, submission.value, submission.allowEmpty);
	closePropertyChoiceMenu();
}

/** 显式清除属性时允许空值通过，由宿主决定删除对应 XML 节点。 */
function clearProperty(event: MouseEvent): void {
	if (event.currentTarget instanceof HTMLButtonElement) emit("submit", event.currentTarget, "", true);
}

/** 原子表达式获得焦点或被点击时始终整体选中，避免鼠标把光标放进常量内部。 */
function selectAtomicPropertyInput(event: FocusEvent | MouseEvent): void {
	const element = event.currentTarget;
	if (element instanceof HTMLInputElement && element.dataset.atomicExpression === "true") element.select();
}

/** 删除原子表达式时清除整个显式值，并立即恢复属性缺省状态。 */
function clearAtomicPropertyInput(element: HTMLInputElement): void {
	element.value = "";
	element.dataset.atomicExpression = "false";
	emit("submit", element, "", true);
}

/** 输入替换整个原子表达式；退格、Delete 和剪切则一次清除整个表达式。 */
function propertyBeforeInput(event: InputEvent): void {
	const element = event.currentTarget;
	if (!(element instanceof HTMLInputElement) || element.dataset.atomicExpression !== "true") return;
	if (event.inputType.startsWith("delete")) {
		event.preventDefault();
		clearAtomicPropertyInput(element);
		return;
	}
	if (event.inputType.startsWith("insert")) {
		element.select();
		element.dataset.atomicExpression = "false";
	}
}

/** 回车提交当前编辑，Escape 恢复进入编辑前的显示值。 */
function propertyKeydown(event: KeyboardEvent): void {
	if (!(event.currentTarget instanceof HTMLInputElement)) return;
	if (
		event.currentTarget.dataset.atomicExpression === "true"
		&& (event.key === "Backspace" || event.key === "Delete")
	) {
		event.preventDefault();
		clearAtomicPropertyInput(event.currentTarget);
		return;
	}
	if (event.key === "Enter") event.currentTarget.blur();
	if (event.key === "Escape") {
		event.currentTarget.value = event.currentTarget.dataset.originalInputValue ?? "";
		event.currentTarget.blur();
	}
}
</script>
