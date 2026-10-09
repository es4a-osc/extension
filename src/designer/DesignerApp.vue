<!--
装配窗口设计器四个列区，并统一协调宿主消息、组件菜单、拖放和文档历史操作。
xhwsd@qq.com 2026-8-30
-->

<template>
	<div
		class="designer-app-content"
		@click="hideContextMenu"
		@contextmenu="onContextMenu"
		@dragend="finishDrag"
		@dragleave="onDragLeave"
		@dragover="onDragOver"
		@dragstart="onDragStart"
		@drop="onDrop"
	>
	<div v-if="message !== undefined" ref="shell" class="designer-shell">
		<template v-for="columnId in columnOrder" :key="columnId">
			<div v-if="columnId === 'property'" class="left-column designer-column" data-designer-column="property">
				<section class="section property-section">
					<div class="section-title designer-column-handle" data-designer-column-handle draggable="true" title="拖动调整设计器区域顺序">
						<span class="section-title-label">属性</span>
						<span class="section-title-actions">
							<button
								class="section-title-action"
								type="button"
								title="全部折叠"
								aria-label="全部折叠属性"
								@click.stop="collapseAllPropertyGroups"
								@pointerdown.stop
							>
								<span class="codicon codicon-collapse-all" aria-hidden="true"></span>
							</button>
							<button
								class="section-title-action"
								type="button"
								title="全部展开"
								aria-label="全部展开属性"
								@click.stop="expandAllPropertyGroups"
								@pointerdown.stop
							>
								<span class="codicon codicon-expand-all" aria-hidden="true"></span>
							</button>
						</span>
					</div>
					<PropertyPanel
						:ref="setPropertyPanelRef"
						:hover-hint="selectedComponentHoverHint"
						:model="message.propertyPanel"
						:selected-path="message.projection.selectedPath"
						@submit="submitProperty"
					/>
				</section>
				<section class="section layout-section">
					<div class="section-title">
						<span class="section-title-label">布局</span>
						<span
							v-if="layoutComponentCount > 0"
							class="section-title-count section-title-count-inline"
							title="布局组件总数"
						>{{ layoutComponentCount }}</span>
						<span class="section-title-actions">
							<button
								class="section-title-action"
								type="button"
								:title="layoutHoverSync ? '关闭悬停同步' : '开启悬停同步'"
								:aria-label="layoutHoverSync ? '关闭悬停同步' : '开启悬停同步'"
								:aria-pressed="layoutHoverSync"
								@click.stop="toggleLayoutHoverSync"
								@pointerdown.stop
							>
								<span class="codicon codicon-inspect" aria-hidden="true"></span>
							</button>
						</span>
					</div>
					<LayoutTree
						:hovered-path="layoutHoverSync ? hoveredComponentPath : undefined"
						:root="message.projection.root"
						:selected-path="message.projection.selectedPath"
						@select="selectNode"
					/>
				</section>
			</div>
			<section v-else-if="columnId === 'enabled'" class="section nonvisual-section designer-column" data-designer-column="enabled">
				<div class="section-title designer-column-handle" data-designer-column-handle draggable="true" title="拖动调整设计器区域顺序">
					<span class="section-title-label">启用</span>
					<span
						v-if="message.projection.nonVisualComponents.length > 0"
						class="section-title-count section-title-count-inline"
						title="已启用组件总数"
					>{{ message.projection.nonVisualComponents.length }}</span>
				</div>
				<EnabledComponents
					:components="message.projection.nonVisualComponents"
					:read-only="message.projection.root?.layoutReadOnly === true"
					:root-path="message.projection.root?.path"
					:selected-path="message.projection.selectedPath"
					@hover="hoverComponent"
					@select="selectNode"
				/>
			</section>
			<section v-else-if="columnId === 'toolbox'" class="section toolbox-section designer-column" data-designer-column="toolbox">
				<div class="section-title designer-column-handle" data-designer-column-handle draggable="true" title="拖动调整设计器区域顺序">
					<span class="section-title-label">可用</span>
					<span
						v-if="toolboxComponentCount > 0"
						class="section-title-count section-title-count-inline"
						title="可用组件总数"
					>{{ toolboxComponentCount }}</span>
					<span class="section-title-actions">
						<button
							class="section-title-action"
							type="button"
							title="全部折叠"
							aria-label="全部折叠可用组件"
							@click.stop="collapseAllToolboxGroups"
							@pointerdown.stop
						>
							<span class="codicon codicon-collapse-all" aria-hidden="true"></span>
						</button>
						<button
							class="section-title-action"
							type="button"
							title="全部展开"
							aria-label="全部展开可用组件"
							@click.stop="expandAllToolboxGroups"
							@pointerdown.stop
						>
							<span class="codicon codicon-expand-all" aria-hidden="true"></span>
						</button>
					</span>
				</div>
				<ToolboxPanel :ref="setToolboxPanelRef" :groups="message.projection.toolbox" />
			</section>
			<section v-else-if="columnId === 'projection'" class="section projection-section designer-column" data-designer-column="projection">
				<div class="section-title designer-column-handle" data-designer-column-handle draggable="true" title="拖动调整设计器区域顺序">
					<span class="section-title-label">投影</span>
					<span class="section-title-actions">
						<button
							class="section-title-action"
							type="button"
							:title="componentLabelsVisible ? '隐藏组件名称' : '显示组件名称'"
							:aria-label="componentLabelsVisible ? '隐藏组件名称' : '显示组件名称'"
							:aria-pressed="componentLabelsVisible"
							@click.stop="toggleComponentLabels"
							@pointerdown.stop
						>
							<span class="codicon codicon-symbol-constant" aria-hidden="true"></span>
						</button>
						<button
							class="section-title-action"
							type="button"
							:title="designerDebug ? '关闭调试模式' : '开启调试模式'"
							:aria-label="designerDebug ? '关闭调试模式' : '开启调试模式'"
							:aria-pressed="designerDebug"
							@click.stop="toggleDesignerDebug"
							@pointerdown.stop
						>
							<span class="codicon codicon-bug" aria-hidden="true"></span>
						</button>
					</span>
				</div>
				<DesignerCanvas
					:debug="designerDebug"
					:drag-feedback="displayedPlacementFeedback"
					:drag-hovered-path="dragHoveredComponentPath"
					:projection="message.projection"
					:selected-grid-cell="selectedGridCell"
					:show-component-labels="componentLabelsVisible"
					@hover="hoverComponent"
					@open-code="openCode"
					@resize="resizeComponent"
					@select="selectNode"
					@select-grid-cell="selectGridCell"
				/>
			</section>
		</template>
	</div>

	<DesignerContextMenu
		v-if="contextMenu !== undefined"
		:enabled="contextMenu.enabled"
		:events="contextMenu.events"
		:left="contextMenu.left"
		:top="contextMenu.top"
		:label="contextMenu.label"
		:component-actions="contextMenu.componentActions"
		:define-library="contextMenu.defineLibrary"
		:layout-move="contextMenu.layoutMove"
		:move-previous="contextMenu.movePrevious"
		:move-next="contextMenu.moveNext"
		:read-only="contextMenu.readOnly"
		:can-paste="contextMenu.canPaste"
		:available-component="contextMenu.availableComponent"
		:can-add="contextMenu.addTarget !== undefined"
		@activate-component-event="activateComponentEvent"
		@add-component="addAvailableComponent"
		@copy-component="copyComponent"
		@cut-component="cutComponent"
		@move-component="moveComponent"
		@move-enabled-component="moveEnabledComponent"
		@paste-component="pasteComponent"
		@remove-component="removeComponent"
		@reveal-library-definition="revealLibraryDefinition"
	/>
	</div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef } from "vue";
import type { DesignerComponentEventItem } from "../designerComponentEvents";
import type {
	DesignerRelativePlacement,
	DesignerRelativeRuleLabels,
	DesignerRelativeRules,
	DesignerAbsolutePosition,
	DesignerBoxSpacing,
	DesignerComponentNudge,
	DesignerComponentNode,
	DesignerComponentResize,
	DesignerFramePlacement,
	DesignerGridPosition,
	DesignerLength,
	DesignerRelativeMoveAxes
} from "../designerModel";
import {
	DEFAULT_DESIGNER_DISPLAY_OPTIONS,
	DESIGNER_COLUMN_IDS,
	isDesignerColumnOrder,
	moveDesignerColumn,
	normalizeDesignerDisplayOptions,
	type DesignerColumnId,
	type DesignerDisplayOptionId
} from "../designerLayout";
import type {
	DesignerWebviewHostMessage,
	DesignerWebviewMessage,
	DesignerWebviewRenderMessage
} from "../designerProtocol";
import type { PropertyPanelValueRequest } from "../propertyPanel";
import { serializeSimpleStringLiteral } from "../simpleStringLiteral";
import DesignerCanvas from "./DesignerCanvas.vue";
import DesignerContextMenu from "./DesignerContextMenu.vue";
import EnabledComponents from "./EnabledComponents.vue";
import LayoutTree from "./LayoutTree.vue";
import PropertyPanel from "./PropertyPanel.vue";
import { normalizePropertyInput } from "./propertyPresentation";
import ToolboxPanel from "./ToolboxPanel.vue";
import {
	componentEdgeInsertionPosition,
	componentDragPointerOffset,
	componentHoverHint,
	currentDesignerRelativeGuides,
	designerFrameAlignmentLabel,
	designerFrameAlignmentLabelSide,
	designerFrameRuleLabels,
	designerGridCells,
	findDesignerComponentNode,
	previewDesignerRelativePlacement,
	projectedDesignerRelativePreviewBounds,
	resolveDesignerAddTarget,
	resolveDesignerFrameSnap,
	resolveDesignerPasteTargetPath,
	resolveDesignerRelativeSnap,
	syncVisualControlContents,
	type DesignerAddTarget,
	type DesignerDragFeedback,
	type DesignerGridCellSelection,
	type DesignerRelativeGuide,
	type DesignerRelativeSnapDock,
	type DesignerRelativeSnapSibling
} from "./designerView";
import type { VsCodeApi } from "./designerClient";

/** 一次组件拖放携带的最小业务信息；已有组件额外携带其真实 XML 路径。 */
interface DraggedComponent {
	readonly componentName?: string;
	readonly componentXmlPath?: string;
	readonly parentXmlPath?: string;
	readonly pointerOffsetLeft?: number;
	readonly pointerOffsetTop?: number;
	readonly previewHeight?: number;
	readonly previewHeightKind?: DesignerLength["kind"];
	readonly previewLeft?: number;
	readonly previewTop?: number;
	readonly previewWidth?: number;
	readonly previewWidthKind?: DesignerLength["kind"];
	readonly relativeMoveAxes?: DesignerRelativeMoveAxes;
	readonly relativeRuleLabels?: DesignerRelativeRuleLabels;
	readonly startClientX?: number;
	readonly startClientY?: number;
	readonly type: string;
	readonly visual: boolean;
}

/** 组件拖放命中的 XML 父节点、参考节点和可视插入指示。 */
interface ComponentDropLocation {
	readonly accept: "nonvisual" | "visual";
	readonly absolutePosition?: DesignerAbsolutePosition;
	readonly acceptsVisualChild?: boolean;
	readonly frameGuides?: readonly DesignerRelativeGuide[];
	readonly framePlacement?: DesignerFramePlacement;
	readonly framePreviewBounds?: Readonly<{
		readonly height: number;
		readonly left: number;
		readonly top: number;
		readonly width: number;
	}>;
	readonly gridPosition?: DesignerGridPosition;
	readonly indicator: HTMLElement;
	readonly indicatorClass: string;
	readonly occupiedComponentPath?: string;
	readonly parentXmlPath: string;
	readonly position?: "after" | "before";
	readonly referenceXmlPath?: string;
	readonly relativeDocks?: Readonly<{
		readonly horizontal?: DesignerRelativeSnapDock;
		readonly vertical?: DesignerRelativeSnapDock;
	}>;
	readonly relativeGuides?: readonly DesignerRelativeGuide[];
	readonly relativeMargin?: DesignerBoxSpacing;
	readonly relativeOffset?: DesignerComponentNudge;
	readonly relativePosition?: Readonly<{ readonly left: number; readonly top: number }>;
	readonly relativePreviewBounds?: Readonly<{
		readonly height: number;
		readonly left: number;
		readonly top: number;
		readonly width: number;
	}>;
}

/** 顶级列拖放命中后计算出的新顺序及其视觉锚点。 */
interface DesignerColumnDropLocation {
	readonly indicator: HTMLElement;
	readonly order: readonly DesignerColumnId[];
	readonly position: "after" | "before";
}

/** 当前组件菜单绑定的 XML 节点和根据 DOM 元数据计算出的可用动作。 */
interface ContextMenuState {
	readonly addTarget?: DesignerAddTarget;
	readonly availableComponent: boolean;
	canPaste: boolean;
	readonly componentType?: string;
	readonly componentActions: boolean;
	readonly defineLibrary: boolean;
	readonly enabled: boolean;
	readonly events: readonly DesignerComponentEventItem[];
	readonly label: string;
	readonly layoutMove: boolean;
	left: number;
	readonly moveNext: boolean;
	readonly movePrevious: boolean;
	readonly pasteXmlPath?: string;
	readonly readOnly: boolean;
	readonly target: HTMLElement;
	top: number;
	readonly xmlPath?: string;
}

const props = defineProps<{ readonly vscode: VsCodeApi }>();
const shell = useTemplateRef<HTMLElement>("shell");
interface PropertyPanelExposed {
	expandAllPropertyGroups(): void;
	collapseAllPropertyGroups(): void;
}
interface ToolboxPanelExposed {
	expandAllToolboxGroups(): void;
	collapseAllToolboxGroups(): void;
}
let propertyPanel: PropertyPanelExposed | undefined;
let toolboxPanel: ToolboxPanelExposed | undefined;
const SELECTED_MOVE_SELECTOR = ".designer-component-name-selected[data-selected-move-path]";
const VISUAL_DRAG_COMPONENT_SELECTOR = ".visual-node[data-drag-component-path]";
const TOOLBOX_VISUAL_PREVIEW_SIZE = 32;

/** 宿主每次发送完整只读投影，Vue 端只替换引用，不深度修改消息模型。 */
const message = shallowRef<DesignerWebviewRenderMessage>();
/** 只记住已随选择交出的 DOM 输入，抵消紧接着的失焦；不建立属性模型副本。 */
const handedOffPropertyInputs = new WeakMap<HTMLInputElement, {
	readonly value: string;
	readonly selectedXmlPath?: string;
	readonly xmlPath?: string;
}>();
const columnOrder = ref<readonly DesignerColumnId[]>(DESIGNER_COLUMN_IDS);
const contextMenu = ref<ContextMenuState>();
const dragFeedback = ref<DesignerDragFeedback>();
const selectedPlacementFeedback = ref<DesignerDragFeedback>();
const dragHoveredComponentPath = ref<string | null>();
const hoveredComponentPath = ref<string>();
const selectedGridCell = ref<DesignerGridCellSelection>();
const componentDragging = ref(false);
const displayedPlacementFeedback = computed(() => componentDragging.value
	? dragFeedback.value
	: selectedPlacementFeedback.value);
/** 三个标题栏开关由宿主按当前单元持久化，初次渲染前使用产品缺省值。 */
const componentLabelsVisible = ref(DEFAULT_DESIGNER_DISPLAY_OPTIONS.componentLabelsVisible);
const designerDebug = ref(DEFAULT_DESIGNER_DISPLAY_OPTIONS.designerDebug);
const layoutHoverSync = ref(DEFAULT_DESIGNER_DISPLAY_OPTIONS.layoutHoverSync);

/** 递归统计布局树节点；根节点即窗口，因此总数明确包含窗口。 */
function countLayoutComponents(node: DesignerComponentNode | undefined): number {
	if (node === undefined) return 0;
	return 1 + node.children.reduce((count, child) => count + countLayoutComponents(child), 0);
}

const layoutComponentCount = computed(() => countLayoutComponents(message.value?.projection.root));
const toolboxComponentCount = computed(() => message.value?.projection.toolbox.reduce(
	(count, group) => count + group.items.length,
	0
) ?? 0);

/** 属性框标题与布局树定位到同一组件节点；未选择子组件时使用窗口根节点。 */
const selectedComponentHoverHint = computed(() => {
	const projection = message.value?.projection;
	if (projection?.root === undefined) return undefined;
	const component = projection.selectedPath === undefined
		? projection.root
		: findDesignerComponentNode(projection.root, projection.selectedPath);
	return component === undefined ? undefined : componentHoverHint(component);
});

/** 拖放和画布测量是单次浏览器交互状态，不进入 VS Code 文档模型。 */
let draggedComponent: DraggedComponent | undefined;
let draggedDesignerColumnId: DesignerColumnId | undefined;
let designSurfaceFrame: number | undefined;
let placementFeedbackFrame: number | undefined;
let componentClipboardRequestId = 0;

/** 所有业务修改都通过类型化消息交还扩展宿主执行。 */
function post(value: DesignerWebviewMessage): void {
	props.vscode.postMessage(value);
}

/** 保存 v-for 内属性面板的单一实例引用，避免字符串模板引用被收集为数组。 */
function setPropertyPanelRef(instance: PropertyPanelExposed | null): void {
	propertyPanel = instance ?? undefined;
}

/** 保存 v-for 内可用组件面板的单一实例引用。 */
function setToolboxPanelRef(instance: ToolboxPanelExposed | null): void {
	toolboxPanel = instance ?? undefined;
}

/** 收起属性面板当前呈现的全部分组，不写入文档或宿主持久化状态。 */
function collapseAllPropertyGroups(): void {
	propertyPanel?.collapseAllPropertyGroups();
}

/** 展开属性面板当前呈现的全部分组，不写入文档或宿主持久化状态。 */
function expandAllPropertyGroups(): void {
	propertyPanel?.expandAllPropertyGroups();
}

/** 收起可用组件面板当前呈现的全部分类。 */
function collapseAllToolboxGroups(): void {
	toolboxPanel?.collapseAllToolboxGroups();
}

/** 展开可用组件面板当前呈现的全部分类。 */
function expandAllToolboxGroups(): void {
	toolboxPanel?.expandAllToolboxGroups();
}

/** 更新当前单元的一个显示开关；宿主负责持久化并同步同单元标签页。 */
function updateDisplayOption(option: DesignerDisplayOptionId, value: boolean): void {
	post({ contextToken: currentContextToken(), option, type: "updateDisplayOption", value });
}

/** 切换当前单元设计器的交互区域调试显示。 */
function toggleDesignerDebug(): void {
	designerDebug.value = !designerDebug.value;
	updateDisplayOption("designerDebug", designerDebug.value);
}

/** 切换当前设计器的组件名称层，不改变组件投影和文档状态。 */
function toggleComponentLabels(): void {
	componentLabelsVisible.value = !componentLabelsVisible.value;
	updateDisplayOption("componentLabelsVisible", componentLabelsVisible.value);
}

/** 控制布局树是否响应画布和启用列表的临时悬停，不改变正式选择。 */
function toggleLayoutHoverSync(): void {
	layoutHoverSync.value = !layoutHoverSync.value;
	updateDisplayOption("layoutHoverSync", layoutHoverSync.value);
}

/** 返回当前设计器标签页的会话令牌，供宿主拒绝其它会话的修改。 */
function currentContextToken(): string {
	return message.value?.contextToken ?? "";
}

/** 返回产生当前只读投影的版本；组件操作只能提交给同一版本。 */
function currentRenderVersion(): number {
	return message.value?.renderVersion ?? 0;
}

/** 由当前投影路径取得窗口内唯一组件名称。 */
function componentIdentity(xmlPath: string | undefined): {
	readonly componentName: string;
	readonly renderVersion: number;
	readonly xmlPath: string;
} | undefined {
	const root = message.value?.projection.root;
	if (root === undefined || xmlPath === undefined) return undefined;
	const component = findDesignerComponentNode(root, xmlPath);
	return component === undefined
		? undefined
		: { componentName: component.name, renderVersion: currentRenderVersion(), xmlPath: component.path };
}

/** 请求宿主把属性框、布局树和画布共同切换到指定 XML 节点。 */
function selectNode(xmlPath: string): void {
	const identity = componentIdentity(xmlPath);
	if (identity === undefined) return;
	selectedGridCell.value = undefined;
	selectedPlacementFeedback.value = currentPlacementFeedback(xmlPath);
	post({ ...identity, contextToken: currentContextToken(), pendingPropertyEdit: takeFocusedPropertyEdit(), type: "selectNode" });
}

/** 画布悬停仅驱动当前布局树反馈，不改变组件选择或宿主文档状态。 */
function hoverComponent(xmlPath: string | undefined): void {
	hoveredComponentPath.value = xmlPath === undefined
		? undefined
		: componentIdentity(xmlPath)?.xmlPath;
}

/** 选中不属于 XML 的空表格格子，同时让属性框继续显示它的父容器。 */
function selectGridCell(selection: DesignerGridCellSelection): void {
	const identity = componentIdentity(selection.parentXmlPath);
	if (identity === undefined) return;
	selectedGridCell.value = selection;
	selectedPlacementFeedback.value = currentGridCellSelectionFeedback(selection);
	post({ ...identity, contextToken: currentContextToken(), pendingPropertyEdit: takeFocusedPropertyEdit(), type: "selectNode" });
}

/** 请求宿主打开当前设计器对应的固定代码标签。 */
function openCode(): void {
	post({ contextToken: currentContextToken(), type: "openCode" });
}

/** 把画布松开鼠标时得到的一次尺寸变化交给扩展宿主登记 XML 事务。 */
function resizeComponent(xmlPath: string, resize: DesignerComponentResize): void {
	const identity = componentIdentity(xmlPath);
	if (identity === undefined) return;
	post({
		...resize,
		...identity,
		contextToken: currentContextToken(),
		type: "resizeComponent"
	});
}

/** 生成属性编辑消息；字符串输入在离开 Vue 视图边界时恢复 Simple 引号。 */
function createPropertyEdit(
	element: HTMLInputElement | HTMLSelectElement | HTMLButtonElement,
	value: string,
	allowEmpty = false
): PropertyPanelValueRequest | undefined {
	const editEffect = element.dataset.editEffect === "editComponentComment"
		|| element.dataset.editEffect === "renameComponent"
		? element.dataset.editEffect
		: undefined;
	const renameComponent = editEffect === "renameComponent";
	const stringLiteralInput = element instanceof HTMLInputElement
		&& element.dataset.stringLiteralInput === "true";
	const color = element instanceof HTMLInputElement && element.type === "color"
		? /^#([0-9A-F]{6})$/iu.exec(value)?.[1]
		: undefined;
	const rawColorAlpha = element.dataset.colorAlpha ?? "";
	const colorAlpha = /^[0-9A-F]{2}$/iu.test(rawColorAlpha)
		? rawColorAlpha.toUpperCase()
		: "FF";
	if (!renameComponent && !allowEmpty && !stringLiteralInput && value.length === 0) {
		if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) {
			element.value = element.dataset.originalInputValue ?? "";
		}
		return undefined;
	}
	if (!allowEmpty && value === element.dataset.originalInputValue) return undefined;
	const normalizedValue = element instanceof HTMLInputElement && !renameComponent && color === undefined
		? normalizePropertyInput(element.dataset.propertyType, value, element.dataset.propertyEditor)
		: undefined;
	if (element instanceof HTMLInputElement && !renameComponent && color === undefined && normalizedValue === undefined) {
		const componentName = element.dataset.componentName;
		const propertyName = element.dataset.propertyName;
		const propertyType = element.dataset.propertyType;
		if (componentName !== undefined && propertyName !== undefined && propertyType !== undefined) {
			post({
				componentName,
				contextToken: currentContextToken(),
				propertyEditor: element.dataset.propertyEditor || undefined,
				propertyName,
				propertyType,
				type: "showPropertyValidationWarning"
			});
		}
		element.value = element.dataset.originalInputValue ?? "";
		return undefined;
	}
	const submittedValue = color !== undefined
		? `&H${colorAlpha}${color.toUpperCase()}`
		: normalizedValue ?? (stringLiteralInput ? serializeSimpleStringLiteral(value) : value);
	if (!allowEmpty && submittedValue === element.dataset.originalValue) return undefined;
	const selectedXmlPath = element.dataset.selectedXmlPath;
	if (selectedXmlPath === undefined || !selectedXmlPath.startsWith("/")) return undefined;
	const selected = componentIdentity(selectedXmlPath);
	return {
		contextToken: currentContextToken(),
		effect: editEffect,
		removeElementWhenEmpty: element.dataset.removeElementWhenEmpty === "true",
		renderVersion: selected?.renderVersion ?? currentRenderVersion(),
		selectedComponentName: selected?.componentName,
		selectedXmlPath,
		type: "updateXmlValue",
		value: submittedValue,
		xmlPath: element.dataset.xmlPath ?? ""
	};
}

/** 在 pointerdown 切换选择之前取得原输入值，保持编辑源节点与点击目标各自的身份。 */
function takeFocusedPropertyEdit(): PropertyPanelValueRequest | undefined {
	const element = document.activeElement;
	if (!(element instanceof HTMLInputElement) || !element.classList.contains("property-input")) return undefined;
	const handedOff = handedOffPropertyInputs.get(element);
	/* 输入框尚未失焦时可以连续切换目标，同一值只交给第一个选择消息。 */
	if (handedOff !== undefined && handedOff.value === element.value
		&& handedOff.selectedXmlPath === element.dataset.selectedXmlPath
		&& handedOff.xmlPath === element.dataset.xmlPath) return undefined;
	const edit = createPropertyEdit(element, element.value);
	if (edit !== undefined) {
		handedOffPropertyInputs.set(element, {
			value: element.value,
			selectedXmlPath: element.dataset.selectedXmlPath,
			xmlPath: element.dataset.xmlPath
		});
	}
	return edit;
}

/** 提交普通属性编辑；已随选择交出的同一输入不再由随后失焦重复提交。 */
function submitProperty(
	element: HTMLInputElement | HTMLSelectElement | HTMLButtonElement,
	value: string,
	allowEmpty = false
): void {
	if (element instanceof HTMLInputElement) {
		const handedOff = handedOffPropertyInputs.get(element);
		handedOffPropertyInputs.delete(element);
		if (handedOff !== undefined && handedOff.value === value
			&& handedOff.selectedXmlPath === element.dataset.selectedXmlPath
			&& handedOff.xmlPath === element.dataset.xmlPath) return;
	}
	const edit = createPropertyEdit(element, value, allowEmpty);
	if (edit !== undefined) post(edit);
}

/** 返回当前 XML 组件继承后的 SDK 事件菜单。 */
function componentEvents(xmlPath: string): readonly DesignerComponentEventItem[] {
	return message.value?.componentEvents.find((group) => group.xmlPath === xmlPath)?.events ?? [];
}

/** 根据右键目标建立动态菜单，并在 Vue 渲染后把菜单约束到可视区域。 */
async function showContextMenu(target: HTMLElement, event: MouseEvent, enabled: boolean): Promise<void> {
	const xmlPath = target.dataset.componentPath;
	const componentType = target.dataset.componentType;
	if (xmlPath === undefined && componentType === undefined) return;
	const availableComponent = xmlPath === undefined && target.classList.contains("toolbox-item");
	const events = xmlPath === undefined ? [] : componentEvents(xmlPath);
	const componentActions = xmlPath !== undefined && (enabled || target.dataset.componentActions === "true");
	const defineLibrary = componentType !== undefined;
	if (events.length === 0 && !componentActions && !defineLibrary) return;
	const root = message.value?.projection.root;
	const component = root === undefined || xmlPath === undefined
		? undefined
		: findDesignerComponentNode(root, xmlPath);
	const readOnly = component?.layoutReadOnly === true;
	const pasteXmlPath = enabled ? undefined : resolveDesignerPasteTargetPath(component);
	const selectedComponent = root === undefined || message.value?.projection.selectedPath === undefined
		? undefined
		: findDesignerComponentNode(root, message.value.projection.selectedPath);
	const addTarget = availableComponent && target.dataset.visual !== undefined
		? resolveDesignerAddTarget(root, selectedComponent, selectedGridCell.value, target.dataset.visual === "true")
		: undefined;
	contextMenu.value = {
		addTarget,
		availableComponent,
		canPaste: false,
		componentType,
		componentActions,
		defineLibrary,
		enabled,
		events,
		label: target.dataset.menuLabel ?? componentType ?? "",
		layoutMove: xmlPath !== undefined && !enabled && target.dataset.layoutMove === "true",
		left: event.clientX,
		moveNext: enabled
			? target.dataset.enabledNextReference !== undefined
			: target.dataset.moveNext === "true",
		movePrevious: enabled
			? target.dataset.enabledPreviousReference !== undefined
			: target.dataset.movePrevious === "true",
		pasteXmlPath,
		readOnly,
		target,
		top: event.clientY,
		xmlPath
	};
	if (pasteXmlPath !== undefined) {
		componentClipboardRequestId += 1;
		post({
			contextToken: currentContextToken(),
			requestId: componentClipboardRequestId,
			type: "checkComponentClipboard"
		});
	}
	await nextTick();
	const menu = document.querySelector<HTMLElement>(".component-context-menu:not(.context-menu-flyout)");
	if (menu === null || contextMenu.value === undefined) return;
	const bounds = menu.getBoundingClientRect();
	contextMenu.value.left = Math.max(4, Math.min(event.clientX, window.innerWidth - bounds.width - 4));
	contextMenu.value.top = Math.max(4, Math.min(event.clientY, window.innerHeight - bounds.height - 4));
}

/** 释放菜单及其二级菜单状态。 */
function hideContextMenu(): void {
	contextMenu.value = undefined;
	componentClipboardRequestId += 1;
}

/** 只接管设计器组件右键；输入控件继续使用浏览器原生编辑菜单。 */
function onContextMenu(event: MouseEvent): void {
	const target = event.target;
	if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
		hideContextMenu();
		return;
	}
	event.preventDefault();
	const enabledComponent = target instanceof Element ? target.closest(".nonvisual-item") : null;
	if (enabledComponent instanceof HTMLElement && enabledComponent.dataset.componentPath !== undefined) {
		event.stopPropagation();
		void showContextMenu(enabledComponent, event, true);
		return;
	}
	const toolboxComponent = target instanceof Element ? target.closest(".toolbox-item") : null;
	if (toolboxComponent instanceof HTMLElement && toolboxComponent.dataset.componentType !== undefined) {
		event.stopPropagation();
		void showContextMenu(toolboxComponent, event, false);
		return;
	}
	const component = target instanceof Element && target.closest(".designer-canvas") !== null
		? visualComponentAtPoint(event) ?? target.closest("[data-component-path]")
		: target instanceof Element ? target.closest("[data-component-path]") : null;
	if (component instanceof HTMLElement) {
		event.stopPropagation();
		void showContextMenu(component, event, false);
	} else hideContextMenu();
}

/** 请求宿主在类库树中定位菜单对应的组件定义。 */
function revealLibraryDefinition(): void {
	const componentType = contextMenu.value?.componentType;
	hideContextMenu();
	if (componentType !== undefined) {
		post({ componentType, contextToken: currentContextToken(), type: "revealLibraryDefinition" });
	}
}

/** 把可用列表中的组件加入当前选择解析出的布局位置。 */
function addAvailableComponent(): void {
	const menu = contextMenu.value;
	hideContextMenu();
	if (menu?.componentType === undefined || menu.addTarget === undefined) return;
	const parent = componentIdentity(menu.addTarget.parentXmlPath);
	const reference = menu.addTarget.referenceXmlPath === undefined
		? undefined
		: componentIdentity(menu.addTarget.referenceXmlPath);
	if (parent === undefined || (menu.addTarget.referenceXmlPath !== undefined && reference === undefined)) return;
	post({
		componentType: menu.componentType,
		contextToken: currentContextToken(),
		gridPosition: menu.addTarget.gridPosition === undefined
			? undefined
			: {
				column: menu.addTarget.gridPosition.column,
				row: menu.addTarget.gridPosition.row
			},
		parentComponentName: parent.componentName,
		parentXmlPath: parent.xmlPath,
		position: menu.addTarget.position,
		referenceComponentName: reference?.componentName,
		referenceXmlPath: reference?.xmlPath,
		renderVersion: parent.renderVersion,
		target: menu.addTarget.target,
		type: "addComponent"
	});
}

/** 请求删除菜单绑定的 XML 组件定义。 */
function removeComponent(): void {
	const xmlPath = contextMenu.value?.xmlPath;
	hideContextMenu();
	if (xmlPath !== undefined) requestDeleteComponent(xmlPath);
}

/** 请求宿主删除指定 XML 组件定义。 */
function requestDeleteComponent(xmlPath: string): void {
	const identity = componentIdentity(xmlPath);
	if (identity !== undefined) post({ ...identity, contextToken: currentContextToken(), type: "deleteComponent" });
}

/** 请求把菜单绑定的 XML `定义`子树复制到系统剪贴板。 */
function copyComponent(): void {
	const xmlPath = contextMenu.value?.xmlPath;
	hideContextMenu();
	if (xmlPath !== undefined) requestCopyComponent(xmlPath);
}

/** 请求把菜单绑定的 XML `定义`子树标记为待剪切组件。 */
function cutComponent(): void {
	const xmlPath = contextMenu.value?.xmlPath;
	hideContextMenu();
	if (xmlPath !== undefined) requestCutComponent(xmlPath);
}

/** 请求把剪贴板中的 XML 组件子树粘贴到菜单绑定的容器。 */
function pasteComponent(): void {
	const xmlPath = contextMenu.value?.pasteXmlPath;
	hideContextMenu();
	if (xmlPath !== undefined) requestPasteComponent(xmlPath);
}

/** 请求宿主复制指定 XML 组件定义。 */
function requestCopyComponent(xmlPath: string): void {
	const identity = componentIdentity(xmlPath);
	if (identity !== undefined) post({ ...identity, contextToken: currentContextToken(), type: "copyComponent" });
}

/** 请求宿主复制并记录指定 XML 组件定义，粘贴成功时执行一次移动事务。 */
function requestCutComponent(xmlPath: string): void {
	const identity = componentIdentity(xmlPath);
	if (identity !== undefined) post({ ...identity, contextToken: currentContextToken(), type: "cutComponent" });
}

/** 请求宿主把系统剪贴板中的组件定义粘贴到指定容器。 */
function requestPasteComponent(xmlPath: string, gridPosition?: DesignerGridPosition): void {
	const identity = componentIdentity(xmlPath);
	if (identity !== undefined) {
		post({ ...identity, contextToken: currentContextToken(), gridPosition, type: "pasteComponent" });
	}
}

/** 请求在当前 XML 父节点中交换可视组件的同级顺序。 */
function moveComponent(direction: "next" | "previous"): void {
	const xmlPath = contextMenu.value?.xmlPath;
	hideContextMenu();
	const identity = componentIdentity(xmlPath);
	if (identity !== undefined) {
		post({ ...identity, contextToken: currentContextToken(), direction, type: "moveComponent" });
	}
}

/** 将扁平启用列表中的相邻项还原为真实 XML 父节点和参考节点后移动。 */
function moveEnabledComponent(direction: "next" | "previous"): void {
	const target = contextMenu.value?.target;
	const componentXmlPath = target?.dataset.componentPath;
	const parentXmlPath = direction === "previous"
		? target?.dataset.enabledPreviousParent
		: target?.dataset.enabledNextParent;
	const referenceXmlPath = direction === "previous"
		? target?.dataset.enabledPreviousReference
		: target?.dataset.enabledNextReference;
	hideContextMenu();
	if (componentXmlPath === undefined || parentXmlPath === undefined || referenceXmlPath === undefined) return;
	const component = componentIdentity(componentXmlPath);
	const parent = componentIdentity(parentXmlPath);
	const reference = componentIdentity(referenceXmlPath);
	if (component === undefined || parent === undefined || reference === undefined) return;
	post({
		componentName: component.componentName,
		componentXmlPath: component.xmlPath,
		contextToken: currentContextToken(),
		parentComponentName: parent.componentName,
		parentXmlPath: parent.xmlPath,
		position: direction === "previous" ? "before" : "after",
		referenceComponentName: reference.componentName,
		referenceXmlPath: reference.xmlPath,
		renderVersion: component.renderVersion,
		type: "relocateComponent"
	});
}

/** 请求宿主跳转到已有事件主体，或为缺失事件追加处理过程。 */
function activateComponentEvent(eventName: string): void {
	const xmlPath = contextMenu.value?.xmlPath;
	hideContextMenu();
	const identity = componentIdentity(xmlPath);
	if (identity !== undefined) {
		post({ ...identity, contextToken: currentContextToken(), eventName, type: "activateComponentEvent" });
	}
}

/** 清除组件拖放产生的容器、插入线及表格单元格反馈。 */
function clearDropTargets(): void {
	dragFeedback.value = undefined;
	document.querySelectorAll(
		".drop-active, .drop-insert-before-horizontal, .drop-insert-after-horizontal, "
		+ ".drop-insert-before-vertical, .drop-insert-after-vertical, "
		+ ".drop-grid-cell, .drop-absolute-position, .drop-frame-position, .drop-relative-position"
	).forEach((element) => element.classList.remove(
		"drop-active",
		"drop-insert-before-horizontal",
		"drop-insert-after-horizontal",
		"drop-insert-before-vertical",
		"drop-insert-after-vertical",
		"drop-grid-cell",
		"drop-absolute-position",
		"drop-frame-position",
		"drop-relative-position"
	));
}

/** 把视口矩形换算到画布顶层拖放层，不把反馈节点插入真实组件。 */
function canvasDragFeedback(
	kind: DesignerDragFeedback["kind"],
	bounds: Readonly<{ height: number; left: number; top: number; width: number }>
): DesignerDragFeedback | undefined {
	const canvas = shell.value?.querySelector<HTMLElement>(".designer-canvas");
	if (canvas === undefined || canvas === null) return undefined;
	const canvasBounds = canvas.getBoundingClientRect();
	return {
		height: Math.max(0, bounds.height),
		kind,
		left: bounds.left - canvasBounds.left,
		top: bounds.top - canvasBounds.top,
		width: Math.max(0, bounds.width)
	};
}

/** 把视口坐标中的相对规则线转换到画布顶层交互层。 */
function canvasRelativeGuides(guides: readonly DesignerRelativeGuide[]): readonly DesignerRelativeGuide[] {
	const canvas = shell.value?.querySelector<HTMLElement>(".designer-canvas");
	if (canvas === undefined || canvas === null) return [];
	const canvasBounds = canvas.getBoundingClientRect();
	const canvasLine = <T extends Readonly<{ axis: "horizontal" | "vertical"; end: number; position: number; start: number }>>(line: T): T => ({
		...line,
		end: line.end - (line.axis === "vertical" ? canvasBounds.top : canvasBounds.left),
		position: line.position - (line.axis === "vertical" ? canvasBounds.left : canvasBounds.top),
		start: line.start - (line.axis === "vertical" ? canvasBounds.top : canvasBounds.left)
	});
	return guides.map((guide) => ({
		...canvasLine(guide),
		...(guide.connector === undefined ? {} : { connector: canvasLine(guide.connector) })
	}));
}

/** 收集一个相对布局容器的直接可视子组件及其当前视口矩形。 */
function relativeSnapSiblings(
	container: HTMLElement,
	parentXmlPath: string,
	excludedXmlPath: string
): readonly DesignerRelativeSnapSibling[] {
	return [...container.children]
		.filter((child): child is HTMLElement => (
			child instanceof HTMLElement
			&& child.dataset.componentPath !== undefined
			&& child.dataset.componentPath !== excludedXmlPath
			&& child.dataset.componentParentPath === parentXmlPath
		))
		.map((child) => {
			const path = child.dataset.componentPath;
			const identity = path === undefined ? undefined : componentIdentity(path);
			if (identity === undefined) return undefined;
			const bounds = child.getBoundingClientRect();
			return {
				componentName: identity.componentName,
				height: bounds.height,
				left: bounds.left,
				top: bounds.top,
				width: bounds.width,
				xmlPath: identity.xmlPath
			};
		})
		.filter((sibling): sibling is DesignerRelativeSnapSibling => sibling !== undefined);
}

/** 根据当前 XML 投影在按住组件时恢复已有停靠规则，并把边距合并进对应示意。 */
function currentRelativeDragFeedback(
	component: DesignerComponentNode,
	componentElement: HTMLElement
): DesignerDragFeedback | undefined {
	const parentXmlPath = component.parentPath;
	if (
		parentXmlPath === undefined
		|| component.relativeRules === undefined
		|| component.relativePositionIssue !== undefined
	) return undefined;
	const container = [...(shell.value?.querySelectorAll<HTMLElement>(".layout-relative[data-layout-surface-path]") ?? [])]
		.find((candidate) => candidate.dataset.layoutSurfacePath === parentXmlPath);
	if (container === undefined) return undefined;
	const bounds = componentElement.getBoundingClientRect();
	const parentBounds = container.getBoundingClientRect();
	const guides = currentDesignerRelativeGuides(
		bounds,
		parentBounds,
		relativeSnapSiblings(container, parentXmlPath, component.path),
		component.relativeRules,
		component.margin,
		component.relativeRuleLabels ?? {}
	);
	if (guides.length === 0) return undefined;
	const feedback = canvasDragFeedback("relative", bounds);
	return feedback === undefined ? undefined : { ...feedback, guides: canvasRelativeGuides(guides) };
}

/** 把单帧布局当前二维对齐还原为只相对父级的规则，不引入兄弟锚点。 */
function currentFrameRules(component: DesignerComponentNode): DesignerRelativeRules {
	const horizontal = component.alignment?.horizontal ?? "left";
	const vertical = component.alignment?.vertical ?? "top";
	if (horizontal === "center" && vertical === "center") return { centerInParent: true };
	return {
		...(horizontal === "center"
			? { centerHorizontal: true }
			: horizontal === "right"
				? { alignParentRight: true }
				: { alignParentLeft: true }),
		...(vertical === "center"
			? { centerVertical: true }
			: vertical === "bottom"
				? { alignParentBottom: true }
				: { alignParentTop: true })
	};
}

/** 根据当前投影在按住单帧布局子组件时显示相对父级的对齐和边距。 */
function currentFrameDragFeedback(
	component: DesignerComponentNode,
	componentElement: HTMLElement
): DesignerDragFeedback | undefined {
	const parentXmlPath = component.parentPath;
	if (parentXmlPath === undefined) return undefined;
	const container = [...(shell.value?.querySelectorAll<HTMLElement>(".layout-frame[data-layout-surface-path]") ?? [])]
		.find((candidate) => candidate.dataset.layoutSurfacePath === parentXmlPath);
	if (container === undefined) return undefined;
	const bounds = componentElement.getBoundingClientRect();
	const guides = currentDesignerRelativeGuides(
		bounds,
		container.getBoundingClientRect(),
		[],
		currentFrameRules(component),
		component.margin,
		designerFrameRuleLabels()
	);
	const feedback = canvasDragFeedback("frame", bounds);
	return feedback === undefined ? undefined : {
		...feedback,
		guides: canvasRelativeGuides(guides),
		placementLabel: designerFrameAlignmentLabel(component.alignment),
		placementLabelSide: designerFrameAlignmentLabelSide(component.alignment)
	};
}

/** 根据当前投影在按住绝对布局子组件时显示相对父级内容原点的 X、Y 坐标。 */
function currentAbsoluteDragFeedback(
	component: DesignerComponentNode,
	componentElement: HTMLElement
): DesignerDragFeedback | undefined {
	const position = component.absolutePosition;
	if (position === undefined) return undefined;
	const feedback = canvasDragFeedback("absolute", componentElement.getBoundingClientRect());
	return feedback === undefined ? undefined : {
		...feedback,
		absoluteCoordinates: { x: position.left, y: position.top }
	};
}

/** 按住已经落入表格单元格的子组件时，高亮整个格子并显示真实零基行列。 */
function currentGridDragFeedback(
	component: DesignerComponentNode,
	componentElement: HTMLElement
): DesignerDragFeedback | undefined {
	if (
		component.gridPositionValid !== true
		|| component.gridRow === undefined
		|| component.gridColumn === undefined
	) return undefined;
	const cell = componentElement.closest<HTMLElement>(".designer-grid-cell");
	if (cell === null) return undefined;
	const feedback = canvasDragFeedback("grid", cell.getBoundingClientRect());
	return feedback === undefined ? undefined : {
		...feedback,
		gridPosition: { column: component.gridColumn, row: component.gridRow },
		showBounds: false
	};
}

/** 选中空表格格子时复用画布顶层行列标签，避免文字被小格子裁剪。 */
function currentGridCellSelectionFeedback(
	selection: DesignerGridCellSelection
): DesignerDragFeedback | undefined {
	const cell = [...(shell.value?.querySelectorAll<HTMLElement>(".designer-grid-cell[data-grid-cell-parent]") ?? [])]
		.find((candidate) => (
			candidate.dataset.gridCellParent === selection.parentXmlPath
			&& candidate.dataset.gridCellRow === String(selection.row)
			&& candidate.dataset.gridCellColumn === String(selection.column)
			&& candidate.dataset.gridCellOccupied === undefined
		));
	if (cell === undefined) return undefined;
	const feedback = canvasDragFeedback("grid", cell.getBoundingClientRect());
	return feedback === undefined ? undefined : {
		...feedback,
		gridPosition: { column: selection.column, row: selection.row },
		showBounds: false
	};
}

/** 返回已选直属子组件当前保存的布局信息；拖拽中的实时反馈使用独立状态覆盖它。 */
function currentPlacementFeedback(path: string | undefined): DesignerDragFeedback | undefined {
	const root = message.value?.projection.root;
	const component = root === undefined || path === undefined ? undefined : findDesignerComponentNode(root, path);
	if (component === undefined || component.visual !== true || component.parentPath === undefined) return;
	const parent = findDesignerComponentNode(root, component.parentPath);
	const relative = component.positionDraggable === true && component.relativeRules !== undefined;
	const frame = parent?.layout === "frame";
	const absolute = parent?.layout === "absolute" && component.absolutePosition !== undefined;
	const grid = parent?.layout === "grid" && component.gridPositionValid === true;
	if (!relative && !frame && !absolute && !grid) return;
	const componentElement = [...(shell.value?.querySelectorAll<HTMLElement>(VISUAL_DRAG_COMPONENT_SELECTOR) ?? [])]
		.find((candidate) => candidate.dataset.dragComponentPath === component.path);
	if (componentElement === undefined) return;
	const feedback = frame
		? currentFrameDragFeedback(component, componentElement)
		: absolute
			? currentAbsoluteDragFeedback(component, componentElement)
			: grid
				? currentGridDragFeedback(component, componentElement)
				: currentRelativeDragFeedback(component, componentElement);
	/* 选中轮廓由画布交互层独立绘制；这里只保留当前布局参数，避免松开拖拽后叠出第二个蓝框。 */
	return feedback === undefined ? undefined : { ...feedback, showBounds: false };
}

/** 在投影和画布完成更新后，重新显示唯一选中子组件的当前布局信息。 */
function refreshSelectedPlacementFeedback(): void {
	selectedPlacementFeedback.value = selectedGridCell.value === undefined
		? currentPlacementFeedback(message.value?.projection.selectedPath)
		: currentGridCellSelectionFeedback(selectedGridCell.value);
}

/** 由落点已经算好的唯一预览矩形生成画布反馈，不再混入来源组件坐标。 */
function visualDropFeedback(location: ComponentDropLocation): DesignerDragFeedback | undefined {
	const indicator = location.indicator;
	if (location.indicatorClass === "drop-relative-position") {
		const previewBounds = location.relativePreviewBounds;
		if (previewBounds === undefined) return undefined;
		const feedback = canvasDragFeedback("relative", previewBounds);
		if (feedback === undefined) return undefined;
		return {
			...feedback,
			guides: location.relativeGuides === undefined
				? undefined
				: canvasRelativeGuides(location.relativeGuides)
		};
	}
	if (location.indicatorClass === "drop-frame-position") {
		const previewBounds = location.framePreviewBounds;
		if (previewBounds === undefined) return undefined;
		const feedback = canvasDragFeedback("frame", previewBounds);
		if (feedback === undefined) return undefined;
		return {
			...feedback,
			guides: location.frameGuides === undefined
				? undefined
				: canvasRelativeGuides(location.frameGuides),
			placementLabel: location.framePlacement === undefined
				? undefined
				: designerFrameAlignmentLabel(location.framePlacement.alignment),
			placementLabelSide: location.framePlacement === undefined
				? undefined
				: designerFrameAlignmentLabelSide(location.framePlacement.alignment)
		};
	}
	if (location.indicatorClass === "drop-absolute-position") {
		const position = location.absolutePosition;
		const component = draggedComponent;
		if (position === undefined || component === undefined) return undefined;
		const bounds = indicator.getBoundingClientRect();
		const style = window.getComputedStyle(indicator);
		const left = bounds.left
			+ (Number.parseFloat(style.borderLeftWidth) || 0)
			+ (Number.parseFloat(style.paddingLeft) || 0)
			+ position.left;
		const top = bounds.top
			+ (Number.parseFloat(style.borderTopWidth) || 0)
			+ (Number.parseFloat(style.paddingTop) || 0)
			+ position.top;
		const feedback = canvasDragFeedback("absolute", {
			height: component.previewHeight ?? 12,
			left,
			top,
			width: component.previewWidth ?? 12
		});
		return feedback === undefined ? undefined : {
			...feedback,
			absoluteCoordinates: { x: position.left, y: position.top }
		};
	}
	const target = location.indicatorClass === "drop-active"
		? indicator.closest<HTMLElement>("[data-component-path]") ?? indicator
		: indicator;
	const bounds = target.getBoundingClientRect();
	if (location.indicatorClass === "drop-active") {
		return canvasDragFeedback("container", bounds);
	}
	if (location.indicatorClass === "drop-grid-cell") {
		const feedback = canvasDragFeedback("grid", bounds);
		return feedback === undefined ? undefined : {
			...feedback,
			gridPosition: location.gridPosition
		};
	}
	const thickness = 8;
	if (location.indicatorClass === "drop-insert-before-horizontal") {
		return canvasDragFeedback("insert-before-horizontal", {
			height: bounds.height,
			left: bounds.left,
			top: bounds.top,
			width: thickness
		});
	}
	if (location.indicatorClass === "drop-insert-after-horizontal") {
		return canvasDragFeedback("insert-after-horizontal", {
			height: bounds.height,
			left: bounds.right - thickness,
			top: bounds.top,
			width: thickness
		});
	}
	if (location.indicatorClass === "drop-insert-before-vertical") {
		return canvasDragFeedback("insert-before-vertical", {
			height: thickness,
			left: bounds.left,
			top: bounds.top,
			width: bounds.width
		});
	}
	if (location.indicatorClass === "drop-insert-after-vertical") {
		return canvasDragFeedback("insert-after-vertical", {
			height: thickness,
			left: bounds.left,
			top: bounds.bottom - thickness,
			width: bounds.width
		});
	}
	return undefined;
}

/** 可视反馈进入画布拖放层；非可视列表继续使用自身列表层反馈。 */
function showDropFeedback(location: ComponentDropLocation): void {
	if (location.accept === "visual") {
		dragFeedback.value = visualDropFeedback(location);
		return;
	}
	location.indicator.classList.add(location.indicatorClass);
}

/** 清除顶级列排序反馈；连续移动时可保留来源列的淡化状态。 */
function clearDesignerColumnDropTarget(includeSource = true): void {
	document.querySelectorAll(
		(includeSource ? ".designer-column-source, " : "")
		+ ".designer-column-drop-before, .designer-column-drop-after"
	).forEach((element) => element.classList.remove(
		"designer-column-source",
		"designer-column-drop-before",
		"designer-column-drop-after"
	));
}

/** 按鼠标横坐标计算顶级列的新顺序和插入线位置，不提前移动真实栏目。 */
function resolveDesignerColumnDropLocation(
	target: Element,
	clientX: number
): DesignerColumnDropLocation | undefined {
	const sourceId = draggedDesignerColumnId;
	const designerShell = shell.value;
	if (sourceId === undefined || designerShell === null || !designerShell.contains(target)) return undefined;
	const currentOrder = columnOrder.value;
	const candidates = currentOrder.filter((id) => id !== sourceId);
	const columns = new Map<DesignerColumnId, HTMLElement>();
	for (const element of designerShell.children) {
		if (!(element instanceof HTMLElement)) continue;
		const columnId = currentOrder.find((id) => id === element.dataset.designerColumn);
		if (columnId !== undefined) columns.set(columnId, element);
	}
	for (const id of candidates) {
		const indicator = columns.get(id);
		if (indicator === undefined) continue;
		const bounds = indicator.getBoundingClientRect();
		if (clientX < bounds.left + bounds.width / 2) {
			const order = moveDesignerColumn(currentOrder, sourceId, id, "before");
			return order.every((value, index) => value === currentOrder[index])
				? undefined
				: { indicator, order, position: "before" };
		}
	}
	const referenceId = candidates.at(-1);
	const indicator = referenceId === undefined ? undefined : columns.get(referenceId);
	if (referenceId === undefined || indicator === undefined) return undefined;
	const order = moveDesignerColumn(currentOrder, sourceId, referenceId, "after");
	return order.every((value, index) => value === currentOrder[index])
		? undefined
		: { indicator, order, position: "after" };
}

/** 按 XML 路径只查找真实可视组件，不让画布反馈标签参与组件身份判断。 */
function visualComponentByPath(canvas: HTMLElement, path: string | undefined): HTMLElement | undefined {
	if (path === undefined) return undefined;
	return [...canvas.querySelectorAll<HTMLElement>(VISUAL_DRAG_COMPONENT_SELECTOR)]
		.find((element) => element.dataset.dragComponentPath === path);
}

/** 普通画布位置返回最上层真实组件；选中名称标签位置回退到标签对应组件。 */
function visualComponentAtPoint(event: MouseEvent): HTMLElement | undefined {
	if (!(event.target instanceof Element)) return undefined;
	const canvas = event.target.closest<HTMLElement>(".designer-canvas");
	if (canvas === null) {
		return event.target.closest<HTMLElement>(VISUAL_DRAG_COMPONENT_SELECTOR) ?? undefined;
	}
	const elements = document.elementsFromPoint(event.clientX, event.clientY);
	const moveSurface = elements
		.map((element) => element.closest<HTMLElement>("[data-selected-move-path]"))
		.find((element): element is HTMLElement => element !== null && canvas.contains(element));
	const movePath = moveSurface?.dataset.selectedMovePath;
	const movedComponent = visualComponentByPath(canvas, movePath);
	for (const element of elements) {
		const component = element.closest<HTMLElement>(VISUAL_DRAG_COMPONENT_SELECTOR);
		if (component === null || !canvas.contains(component)) continue;
		if (
			movedComponent !== undefined
			&& component !== movedComponent
			&& component.contains(movedComponent)
		) continue;
		return component;
	}
	return movedComponent;
}

/** 从组件 DOM 锚点读取一次同级插入所需的 XML 位置信息。 */
function insertionLocation(element: HTMLElement, position: "after" | "before"): ComponentDropLocation | undefined {
	const parentXmlPath = element.dataset.insertParent;
	const referenceXmlPath = element.dataset.insertReference;
	if (parentXmlPath === undefined || referenceXmlPath === undefined) return undefined;
	const horizontal = element.parentElement?.classList.contains("layout-linear-horizontal") === true
		|| element.parentElement?.classList.contains("layout-grid") === true;
	return {
		accept: element.dataset.insertAccept === "visual" ? "visual" : "nonvisual",
		acceptsVisualChild: element.parentElement?.dataset.acceptsVisualChild !== "false",
		indicator: element,
		indicatorClass: `drop-insert-${position}-${horizontal ? "horizontal" : "vertical"}`,
		parentXmlPath,
		position,
		referenceXmlPath
	};
}

/** 按线性布局主轴把组件自身划分为前后两个落点区域。 */
function insertionPosition(element: HTMLElement, event: DragEvent): "after" | "before" {
	const parent = element.parentElement;
	const bounds = element.getBoundingClientRect();
	if (parent?.classList.contains("layout-linear-horizontal") === true) {
		return event.clientX < bounds.left + bounds.width / 2 ? "before" : "after";
	}
	if (
		parent?.classList.contains("layout-linear-vertical") === true
		|| parent?.classList.contains("nonvisual-list") === true
	) {
		return event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
	}
	return "after";
}

/** 容器内部布局面覆盖组件时，仅让主轴首尾 8px 内边缘优先承担同级插入。 */
function containerSiblingInsertionLocation(
	insertion: HTMLElement,
	container: HTMLElement,
	event: DragEvent
): ComponentDropLocation | undefined {
	if (!insertion.contains(container) || !pointInsideElement(insertion, event)) return undefined;
	const parent = insertion.parentElement;
	const bounds = insertion.getBoundingClientRect();
	const position = parent?.classList.contains("layout-linear-horizontal") === true
		? componentEdgeInsertionPosition(event.clientX, bounds.left, bounds.width)
		: parent?.classList.contains("layout-linear-vertical") === true
			? componentEdgeInsertionPosition(event.clientY, bounds.top, bounds.height)
			: undefined;
	return position === undefined ? undefined : insertionLocation(insertion, position);
}

/** 从空单元格或已放置组件的 DOM 数据恢复表格零基行列位置。 */
function gridLocation(element: HTMLElement, component: boolean): ComponentDropLocation | undefined {
	const parentXmlPath = component ? element.dataset.gridParent : element.dataset.gridCellParent;
	const rowText = component ? element.dataset.gridRow : element.dataset.gridCellRow;
	const columnText = component ? element.dataset.gridColumn : element.dataset.gridCellColumn;
	const row = rowText === undefined ? Number.NaN : Number(rowText);
	const column = columnText === undefined ? Number.NaN : Number(columnText);
	if (
		parentXmlPath === undefined
		|| !parentXmlPath.startsWith("/")
		|| !Number.isSafeInteger(row)
		|| !Number.isSafeInteger(column)
		|| row < 0
		|| column < 0
	) return undefined;
	return {
		accept: "visual",
		gridPosition: { column, row },
		indicator: element,
		indicatorClass: "drop-grid-cell",
		occupiedComponentPath: component
			? element.dataset.insertReference
			: element.dataset.gridCellOccupied,
		parentXmlPath
	};
}

/** 按指针计算绝对布局内容区落点；四个方向都允许超出父级并保留真实坐标。 */
function absoluteLocation(container: HTMLElement, event: DragEvent): ComponentDropLocation | undefined {
	const parentXmlPath = container.dataset.dropTarget;
	if (parentXmlPath === undefined) return undefined;
	const bounds = container.getBoundingClientRect();
	const style = window.getComputedStyle(container);
	const borderLeft = Number.parseFloat(style.borderLeftWidth) || 0;
	const borderTop = Number.parseFloat(style.borderTopWidth) || 0;
	const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
	const paddingTop = Number.parseFloat(style.paddingTop) || 0;
	const left = Math.round(
		event.clientX - bounds.left - borderLeft - paddingLeft - (draggedComponent?.pointerOffsetLeft ?? 0)
	);
	const top = Math.round(
		event.clientY - bounds.top - borderTop - paddingTop - (draggedComponent?.pointerOffsetTop ?? 0)
	);
	return {
		accept: "visual",
		absolutePosition: { left, top },
		acceptsVisualChild: container.dataset.acceptsVisualChild !== "false",
		indicator: container,
		indicatorClass: "drop-absolute-position",
		parentXmlPath
	};
}

/** 在目标相对布局中计算唯一预览矩形；内部移动和首次拖入共用该矩形生成规则、边距与反馈。 */
function relativeLocation(container: HTMLElement, event: DragEvent): ComponentDropLocation | undefined {
	const component = draggedComponent;
	const parentXmlPath = container.dataset.layoutSurfacePath;
	if (
		component === undefined
		|| parentXmlPath === undefined
	) return undefined;
	const sameParent = component.componentXmlPath !== undefined && component.parentXmlPath === parentXmlPath;
	const moveAxes = sameParent ? component.relativeMoveAxes : { horizontal: true, vertical: true };
	if (moveAxes === undefined) return undefined;
	const deltaLeft = sameParent && component.startClientX !== undefined && moveAxes.horizontal
		? Math.round(event.clientX - component.startClientX)
		: 0;
	const deltaTop = sameParent && component.startClientY !== undefined && moveAxes.vertical
		? Math.round(event.clientY - component.startClientY)
		: 0;
	const previewWidth = component.previewWidth ?? 0;
	const previewHeight = component.previewHeight ?? 0;
	const initialLeft = sameParent
		? (component.previewLeft ?? event.clientX)
		: event.clientX - (component.pointerOffsetLeft ?? 0);
	const initialTop = sameParent
		? (component.previewTop ?? event.clientY)
		: event.clientY - (component.pointerOffsetTop ?? 0);
	const moving = {
		height: previewHeight,
		left: initialLeft + deltaLeft,
		top: initialTop + deltaTop,
		width: previewWidth
	};
	const parentBounds = container.getBoundingClientRect();
	const siblings = relativeSnapSiblings(container, parentXmlPath, component.componentXmlPath ?? "");
	const changedAxes = {
		horizontal: sameParent ? moveAxes.horizontal && deltaLeft !== 0 : moveAxes.horizontal,
		vertical: sameParent ? moveAxes.vertical && deltaTop !== 0 : moveAxes.vertical
	};
	const root = message.value?.projection.root;
	const projectedComponent = root === undefined
		? undefined
		: findDesignerComponentNode(root, component.componentXmlPath);
	const snapped = resolveDesignerRelativeSnap(
		moving,
		parentBounds,
		siblings,
		changedAxes,
		component.relativeRuleLabels ?? projectedComponent?.relativeRuleLabels ?? {}
	);
	const relativePosition = {
		left: Math.round(snapped.left - parentBounds.left),
		top: Math.round(snapped.top - parentBounds.top)
	};
	const relativeOffset = {
		deltaLeft: sameParent ? Math.round(snapped.left - initialLeft) : relativePosition.left,
		deltaTop: sameParent ? Math.round(snapped.top - initialTop) : relativePosition.top
	};
	const placement: DesignerRelativePlacement = {
		...relativeOffset,
		horizontalDock: snapped.horizontalDock,
		...relativePosition,
		margin: snapped.margin,
		verticalDock: snapped.verticalDock
	};
	const preview = previewDesignerRelativePlacement(
		sameParent && projectedComponent !== undefined
			? projectedComponent
			: { margin: undefined, relativeRules: {} },
		placement
	);
	const snappedBounds = {
		height: previewHeight,
		left: snapped.left,
		top: snapped.top,
		width: previewWidth
	};
	const previewBounds = projectedDesignerRelativePreviewBounds(
		snappedBounds,
		parentBounds,
		siblings,
		preview.rules,
		preview.margin,
		container.clientWidth,
		container.clientHeight
	);
	return {
		accept: "visual",
		indicator: container,
		indicatorClass: "drop-relative-position",
		parentXmlPath,
		relativeDocks: {
			horizontal: snapped.horizontalDock,
			vertical: snapped.verticalDock
		},
		relativeGuides: currentDesignerRelativeGuides(
				previewBounds,
				parentBounds,
				siblings,
				preview.rules,
				preview.margin,
				component.relativeRuleLabels ?? projectedComponent?.relativeRuleLabels ?? {}
			),
		relativeOffset,
		relativeMargin: snapped.margin,
		relativePosition,
		relativePreviewBounds: previewBounds
	};
}

/** 单帧布局拖入或内部移动只计算父级九宫格对齐和边距，不改变 XML 层叠顺序。 */
function frameLocation(container: HTMLElement, event: DragEvent): ComponentDropLocation | undefined {
	const component = draggedComponent;
	const parentXmlPath = container.dataset.layoutSurfacePath;
	if (
		component === undefined
		|| parentXmlPath === undefined
		|| !pointInsideElement(container, event)
	) return undefined;
	const sameParent = component.componentXmlPath !== undefined && component.parentXmlPath === parentXmlPath;
	if (sameParent && (
		component.startClientX === undefined
		|| component.startClientY === undefined
		|| component.previewLeft === undefined
		|| component.previewTop === undefined
	)) return undefined;
	const fitContentWidth = sameParent
		? component.previewWidthKind === "parent"
		: component.previewWidthKind !== "fixed";
	const fitContentHeight = sameParent
		? component.previewHeightKind === "parent"
		: component.previewHeightKind !== "fixed";
	const previewWidth = component.previewWidthKind === "parent" && fitContentWidth
		? TOOLBOX_VISUAL_PREVIEW_SIZE
		: component.previewWidth ?? TOOLBOX_VISUAL_PREVIEW_SIZE;
	const previewHeight = component.previewHeightKind === "parent" && fitContentHeight
		? TOOLBOX_VISUAL_PREVIEW_SIZE
		: component.previewHeight ?? TOOLBOX_VISUAL_PREVIEW_SIZE;
	const pointerLeft = component.previewWidthKind === "parent" && fitContentWidth
		? previewWidth / 2
		: component.pointerOffsetLeft ?? 0;
	const pointerTop = component.previewHeightKind === "parent" && fitContentHeight
		? previewHeight / 2
		: component.pointerOffsetTop ?? 0;
	const moving = {
		height: previewHeight,
		left: sameParent && component.previewWidthKind !== "parent"
			? (component.previewLeft ?? event.clientX) + Math.round(event.clientX - (component.startClientX ?? event.clientX))
			: event.clientX - pointerLeft,
		top: sameParent && component.previewHeightKind !== "parent"
			? (component.previewTop ?? event.clientY) + Math.round(event.clientY - (component.startClientY ?? event.clientY))
			: event.clientY - pointerTop,
		width: previewWidth
	};
	const parentBounds = container.getBoundingClientRect();
	const snapped = resolveDesignerFrameSnap(
		moving,
		parentBounds
	);
	return {
		accept: "visual",
		frameGuides: snapped.guides,
		framePlacement: {
			...snapped.placement,
			fitContentHeight: fitContentHeight || undefined,
			fitContentWidth: fitContentWidth || undefined
		},
		framePreviewBounds: {
			height: moving.height,
			left: snapped.left,
			top: snapped.top,
			width: moving.width
		},
		indicator: container,
		indicatorClass: "drop-frame-position",
		parentXmlPath
	};
}

/** 按容器布局方向和指针位置选择最接近的组件插入锚点。 */
function resolveComponentDropLocation(target: Element, event: DragEvent): ComponentDropLocation | undefined {
	const insertion = target.closest("[data-insert-parent]");
	const container = target.closest("[data-drop-target]");
	if (insertion instanceof HTMLElement && container instanceof HTMLElement) {
		const siblingLocation = containerSiblingInsertionLocation(insertion, container, event);
		if (siblingLocation !== undefined) return siblingLocation;
	}
	const gridCell = target.closest("[data-grid-cell-parent]");
	if (gridCell instanceof HTMLElement) return gridLocation(gridCell, false);
	if (container instanceof HTMLElement && container.classList.contains("layout-absolute")) {
		return absoluteLocation(container, event);
	}
	if (container instanceof HTMLElement && container.classList.contains("layout-relative")) {
		return relativeLocation(container, event);
	}
	if (container instanceof HTMLElement && container.classList.contains("layout-frame")) {
		const location = frameLocation(container, event);
		if (location !== undefined) return location;
	}
	if (
		insertion instanceof HTMLElement
		&& insertion.dataset.insertParent !== undefined
		&& insertion.dataset.insertReference !== undefined
		&& !(container instanceof HTMLElement && insertion.contains(container))
	) {
		if (insertion.parentElement?.classList.contains("layout-grid") === true) {
			return gridLocation(insertion, true);
		}
		return insertionLocation(insertion, insertionPosition(insertion, event));
	}
	if (!(container instanceof HTMLElement) || container.dataset.dropTarget === undefined) return undefined;
	/* 有效表格只接受具体单元格；无效表格没有可安全推导的行列位置。 */
	if (container.classList.contains("layout-grid")) return undefined;
	const flattenedNonVisualList = container.classList.contains("nonvisual-list");
	const children = [...container.children].filter((child): child is HTMLElement => (
		child instanceof HTMLElement
		&& (flattenedNonVisualList || child.dataset.insertParent === container.dataset.dropTarget)
		&& child.dataset.insertAccept === container.dataset.accept
	));
	if (children.length > 0) {
		const lastChild = children.at(-1);
		if (lastChild === undefined) return undefined;
		const horizontal = container.classList.contains("layout-linear-horizontal");
		const vertical = container.classList.contains("layout-linear-vertical")
			|| container.classList.contains("nonvisual-list");
		if (!horizontal && !vertical) return insertionLocation(lastChild, "after");
		const pointer = horizontal ? event.clientX : event.clientY;
		for (const [index, child] of children.entries()) {
			const bounds = child.getBoundingClientRect();
			const start = horizontal ? bounds.left : bounds.top;
			if (pointer < start) {
				const previousChild = children[index - 1];
				return previousChild === undefined
					? insertionLocation(child, "before")
					: insertionLocation(previousChild, "after");
			}
		}
		return insertionLocation(lastChild, "after");
	}
	return {
		accept: container.dataset.accept === "visual" ? "visual" : "nonvisual",
		acceptsVisualChild: container.dataset.acceptsVisualChild !== "false",
		indicator: container,
		indicatorClass: "drop-active",
		parentXmlPath: container.dataset.dropTarget
	};
}

/** 判断指针是否仍位于元素自身边界内，不把溢出的子组件区域误算为父容器命中。 */
function pointInsideElement(element: HTMLElement, event: DragEvent): boolean {
	const bounds = element.getBoundingClientRect();
	return event.clientX >= bounds.left
		&& event.clientX <= bounds.right
		&& event.clientY >= bounds.top
		&& event.clientY <= bounds.bottom;
}

/** 穿透拖动组件，从指针下方的 DOM 层级寻找原父容器之外的首个有效落点。 */
function resolveOutsideSourceDropLocation(
	event: DragEvent,
	sourceParentPath: string
): ComponentDropLocation | undefined {
	for (const element of document.elementsFromPoint(event.clientX, event.clientY)) {
		const location = resolveComponentDropLocation(element, event);
		if (
			location !== undefined
			&& location.parentXmlPath !== sourceParentPath
			&& canDropDraggedComponent(location)
		) return location;
	}
	return undefined;
}

/** 空间定位布局内优先保留原父级；指针越过原容器后允许外层或兄弟容器接管落点。 */
function resolveDraggedComponentDropLocation(target: Element, event: DragEvent): ComponentDropLocation | undefined {
	/* 非可视组件只允许进入窗口根节点；已有根组件仍可在非可视分区内部排序。 */
	if (draggedComponent?.visual === false) {
		const list = target.closest<HTMLElement>(".nonvisual-list");
		const parentXmlPath = list?.dataset.dropTarget;
		if (list !== null && list !== undefined && parentXmlPath !== undefined) {
			const directLocation = resolveComponentDropLocation(target, event);
			if (
				draggedComponent.componentXmlPath !== undefined
				&& directLocation?.accept === "nonvisual"
				&& directLocation.parentXmlPath === parentXmlPath
			) return directLocation;
			return {
				accept: "nonvisual",
				indicator: list,
				indicatorClass: "drop-active",
				parentXmlPath
			};
		}
	}
	const component = draggedComponent;
	const sourceParentPath = component?.parentXmlPath;
	const canvas = target.closest<HTMLElement>(".designer-canvas");
	if (
		component?.componentXmlPath !== undefined
		&& component.visual === true
		&& sourceParentPath !== undefined
		&& canvas !== null
		&& component.relativeMoveAxes !== undefined
	) {
		const sourceRelativeContainer = [...canvas.querySelectorAll<HTMLElement>(
			".layout-relative[data-layout-surface-path]"
		)].find((element) => element.dataset.layoutSurfacePath === sourceParentPath);
		if (sourceRelativeContainer !== undefined) {
			const directLocation = resolveComponentDropLocation(target, event);
			const pointerInsideSource = pointInsideElement(sourceRelativeContainer, event);
			if (
				directLocation !== undefined
				&& directLocation.parentXmlPath !== sourceParentPath
				&& (!sourceParentPath.startsWith(directLocation.parentXmlPath + "/") || !pointerInsideSource)
				&& canDropDraggedComponent(directLocation)
			) return directLocation;
			if (!pointerInsideSource) {
				const outsideLocation = resolveOutsideSourceDropLocation(event, sourceParentPath);
				if (outsideLocation !== undefined) return outsideLocation;
			}
			return relativeLocation(sourceRelativeContainer, event);
		}
	}
	if (
		component?.componentXmlPath !== undefined
		&& component.visual === true
		&& sourceParentPath !== undefined
		&& canvas !== null
	) {
		const sourceFrameContainer = [...canvas.querySelectorAll<HTMLElement>(
			".layout-frame[data-layout-surface-path]"
		)].find((element) => element.dataset.layoutSurfacePath === sourceParentPath);
		if (sourceFrameContainer !== undefined) {
			const directLocation = resolveComponentDropLocation(target, event);
			const pointerInsideSource = pointInsideElement(sourceFrameContainer, event);
			if (
				directLocation !== undefined
				&& directLocation.parentXmlPath !== sourceParentPath
				&& (!sourceParentPath.startsWith(directLocation.parentXmlPath + "/") || !pointerInsideSource)
				&& canDropDraggedComponent(directLocation)
			) return directLocation;
			if (!pointerInsideSource) return resolveOutsideSourceDropLocation(event, sourceParentPath);
			return frameLocation(sourceFrameContainer, event);
		}
	}
	const directLocation = resolveComponentDropLocation(target, event);
	if (
		component?.componentXmlPath === undefined
		|| component.visual !== true
		|| sourceParentPath === undefined
		|| canvas === null
	) return directLocation;
	const sourceContainer = [...canvas.querySelectorAll<HTMLElement>(".layout-absolute[data-drop-target]")]
		.find((element) => element.dataset.dropTarget === sourceParentPath);
	if (sourceContainer === undefined) return directLocation;
	const pointerInsideSource = pointInsideElement(sourceContainer, event);
	if (
		directLocation !== undefined
		&& directLocation.parentXmlPath !== sourceParentPath
		&& (!sourceParentPath.startsWith(directLocation.parentXmlPath + "/") || !pointerInsideSource)
		&& canDropDraggedComponent(directLocation)
	) return directLocation;
	if (!pointerInsideSource) {
		const outsideLocation = resolveOutsideSourceDropLocation(event, sourceParentPath);
		if (outsideLocation !== undefined) return outsideLocation;
	}
	return absoluteLocation(sourceContainer, event);
}

/** 校验可视类型并阻止把组件移入自身、后代或自身参考位置。 */
function canDropDraggedComponent(location: ComponentDropLocation): boolean {
	if (draggedComponent === undefined || location.accept !== (draggedComponent.visual ? "visual" : "nonvisual")) {
		return false;
	}
	if (location.occupiedComponentPath !== undefined) return false;
	if (
		draggedComponent.visual
		&& location.acceptsVisualChild === false
		&& draggedComponent.parentXmlPath !== location.parentXmlPath
	) return false;
	const sourcePath = draggedComponent.componentXmlPath;
	return sourcePath === undefined || (
		location.parentXmlPath !== sourcePath
		&& !location.parentXmlPath.startsWith(sourcePath + "/")
		&& location.referenceXmlPath !== sourcePath
	);
}

/** 临时复制组件图标作为原生拖放图像，不把辅助节点交给 Vue 管理。 */
function createComponentDragImage(icon: HTMLElement): HTMLElement {
	const dragImage = document.createElement("div");
	dragImage.className = "component-drag-image";
	dragImage.append(icon.cloneNode(true));
	document.body.append(dragImage);
	const iconBounds = icon.getBoundingClientRect();
	const dragImageBounds = dragImage.getBoundingClientRect();
	dragImage.style.left = Math.round(iconBounds.left + (iconBounds.width - dragImageBounds.width) / 2) + "px";
	dragImage.style.top = Math.round(iconBounds.top + (iconBounds.height - dragImageBounds.height) / 2) + "px";
	return dragImage;
}

/** 为浏览器拖放设置居中的组件图标，并在本轮事件后移除临时节点。 */
function setDragImage(event: DragEvent, component: HTMLElement, selector: string): void {
	if (event.dataTransfer === null) return;
	const icon = component.querySelector<HTMLElement>(selector);
	if (icon === null) return;
	const dragImage = createComponentDragImage(icon);
	const bounds = dragImage.getBoundingClientRect();
	event.dataTransfer.setDragImage(dragImage, Math.round(bounds.width / 2), Math.round(bounds.height / 2));
	setTimeout(() => dragImage.remove(), 0);
}

/** 绝对布局已有组件由落位框表达位置，隐藏浏览器额外生成的半透明组件拖影。 */
function hideNativeDragImage(event: DragEvent): void {
	if (event.dataTransfer === null) return;
	const dragImage = document.createElement("div");
	dragImage.className = "component-drag-image-transparent";
	document.body.append(dragImage);
	event.dataTransfer.setDragImage(dragImage, 0, 0);
	setTimeout(() => dragImage.remove(), 0);
}

/** 把选中名称标签或鼠标下最内层的已选组件统一解析为真实可视组件。 */
function selectedVisualDragSource(target: EventTarget | null): {
	readonly component: HTMLElement;
	readonly fromLabel: boolean;
} | undefined {
	if (!(target instanceof Element)) return undefined;
	const label = target.closest<HTMLElement>(SELECTED_MOVE_SELECTOR);
	if (label !== null) {
		const canvas = label.closest<HTMLElement>(".designer-canvas");
		const movePath = label.dataset.selectedMovePath;
		const component = canvas === null ? undefined : visualComponentByPath(canvas, movePath);
		return component === undefined ? undefined : { component, fromLabel: true };
	}
	const component = target.closest<HTMLElement>(VISUAL_DRAG_COMPONENT_SELECTOR);
	if (component === null || !component.classList.contains("selected") || component.draggable !== true) {
		return undefined;
	}
	return { component, fromLabel: false };
}

/** 区分顶级列、工具箱候选和已有组件三种拖动来源。 */
function onDragStart(event: DragEvent): void {
	const columnAction = event.target instanceof Element ? event.target.closest(".section-title-action") : null;
	if (columnAction !== null) {
		event.preventDefault();
		return;
	}
	const columnHandle = event.target instanceof Element
		? event.target.closest<HTMLElement>("[data-designer-column-handle]")
		: null;
	const column = columnHandle?.closest<HTMLElement>("[data-designer-column]");
	const columnId = columnOrder.value.find((candidate) => candidate === column?.dataset.designerColumn);
	if (column !== null && column !== undefined && columnId !== undefined) {
		draggedDesignerColumnId = columnId;
		draggedComponent = undefined;
		clearDropTargets();
		clearDesignerColumnDropTarget();
		column.classList.add("designer-column-source");
		event.dataTransfer?.setData("application/x-es4a-designer-column", columnId);
		if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = "move";
		return;
	}
	const item = event.target instanceof Element ? event.target.closest(".toolbox-item") : null;
	if (item instanceof HTMLElement) {
		const visual = item.dataset.visual === "true";
		const type = item.dataset.componentType ?? "";
		const toolboxItem = message.value?.projection.toolbox
			.flatMap((group) => group.items)
			.find((candidate) => candidate.name === type);
		draggedComponent = {
			previewHeight: visual ? TOOLBOX_VISUAL_PREVIEW_SIZE : undefined,
			previewWidth: visual ? TOOLBOX_VISUAL_PREVIEW_SIZE : undefined,
			relativeRuleLabels: toolboxItem?.relativeRuleLabels,
			type,
			visual
		};
		dragHoveredComponentPath.value = null;
		document.body.classList.add("component-dragging");
		event.dataTransfer?.setData("text/plain", draggedComponent.type);
		if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = "copy";
		if (visual) hideNativeDragImage(event);
		else setDragImage(event, item, ".component-icon-toolbox");
		return;
	}
	let component = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-drag-component-path]") : null;
	if (component === null || component.dataset.dragComponentPath === undefined) return;
	let visualDragSource: ReturnType<typeof selectedVisualDragSource>;
	if (component.dataset.dragComponentVisual === "true") {
		visualDragSource = selectedVisualDragSource(event.target);
		if (visualDragSource === undefined) {
			event.preventDefault();
			return;
		}
		component = visualDragSource.component;
	}
	const componentBounds = component.getBoundingClientRect();
	const draggedIdentity = componentIdentity(component.dataset.dragComponentPath);
	if (draggedIdentity === undefined) {
		event.preventDefault();
		return;
	}
	const projectionRoot = message.value?.projection.root;
	const projectedComponent = projectionRoot === undefined
		? undefined
		: findDesignerComponentNode(projectionRoot, draggedIdentity.xmlPath);
	draggedComponent = {
		componentName: draggedIdentity.componentName,
		componentXmlPath: draggedIdentity.xmlPath,
		parentXmlPath: component.dataset.componentParentPath,
		pointerOffsetLeft: componentDragPointerOffset(
			event.clientX,
			componentBounds.left,
			visualDragSource?.fromLabel === true
		),
		pointerOffsetTop: componentDragPointerOffset(
			event.clientY,
			componentBounds.top,
			visualDragSource?.fromLabel === true
		),
		previewHeight: Math.max(0, componentBounds.height),
		previewHeightKind: projectedComponent?.height?.kind,
		previewLeft: componentBounds.left,
		previewTop: componentBounds.top,
		previewWidth: Math.max(0, componentBounds.width),
		previewWidthKind: projectedComponent?.width?.kind,
		relativeMoveAxes: projectedComponent?.positionDraggable === true
			? projectedComponent.relativeMoveAxes
			: undefined,
		relativeRuleLabels: projectedComponent?.relativeRuleLabels,
		startClientX: event.clientX,
		startClientY: event.clientY,
		type: component.dataset.dragComponentType ?? "",
		visual: component.dataset.dragComponentVisual === "true"
	};
	componentDragging.value = true;
	/* 组件本体立即隐藏选择反馈；名称标签要等 dragover 后隐藏，否则 Chromium 会取消拖拽。 */
	if (visualDragSource?.fromLabel !== true) {
		dragHoveredComponentPath.value = null;
		document.body.classList.add("component-dragging");
	}
	event.dataTransfer?.setData("text/plain", draggedComponent.type);
	if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = "move";
	if (draggedComponent.visual) hideNativeDragImage(event);
	else setDragImage(event, component, ".component-icon-enabled");
}

/** 实时更新当前可接受的列顺序或组件插入反馈。 */
function onDragOver(event: DragEvent): void {
	if (draggedDesignerColumnId !== undefined) {
		const location = event.target instanceof Element
			? resolveDesignerColumnDropLocation(event.target, event.clientX)
			: undefined;
		clearDesignerColumnDropTarget(false);
		if (location === undefined) return;
		event.preventDefault();
		location.indicator.classList.add("designer-column-drop-" + location.position);
		if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "move";
		return;
	}
	if (draggedComponent === undefined) return;
	/* dragover 证明原生拖拽已经建立，此时再隐藏顶层来源面不会中断拖拽。 */
	document.body.classList.add("component-dragging");
	if (!(event.target instanceof Element)) {
		dragHoveredComponentPath.value = null;
		clearDropTargets();
		return;
	}
	const location = resolveDraggedComponentDropLocation(event.target, event);
	if (location === undefined || !canDropDraggedComponent(location)) {
		dragHoveredComponentPath.value = null;
		clearDropTargets();
		return;
	}
	event.preventDefault();
	dragHoveredComponentPath.value = location.accept === "visual" ? location.parentXmlPath : null;
	clearDropTargets();
	showDropFeedback(location);
	if (event.dataTransfer !== null) {
		event.dataTransfer.dropEffect = draggedComponent.componentXmlPath === undefined ? "copy" : "move";
	}
}

/** 指针真正离开整个设计器后清除最后一个接纳组件，子元素之间切换不重复闪烁。 */
function onDragLeave(event: DragEvent): void {
	if (event.target !== event.currentTarget) return;
	if (draggedDesignerColumnId !== undefined) {
		clearDesignerColumnDropTarget(false);
		return;
	}
	if (draggedComponent === undefined) return;
	dragHoveredComponentPath.value = null;
	clearDropTargets();
}

/** 把最终拖放位置转换为列顺序、组件新增或 XML 组件迁移消息。 */
function onDrop(event: DragEvent): void {
	if (draggedDesignerColumnId !== undefined) {
		const location = event.target instanceof Element
			? resolveDesignerColumnDropLocation(event.target, event.clientX)
			: undefined;
		if (location !== undefined) {
			event.preventDefault();
			columnOrder.value = location.order;
			post({ contextToken: currentContextToken(), order: location.order, type: "updateColumnOrder" });
		}
		finishDrag();
		return;
	}
	if (!(event.target instanceof Element) || draggedComponent === undefined) return;
	const location = resolveDraggedComponentDropLocation(event.target, event);
	if (location === undefined || !canDropDraggedComponent(location)) return;
	event.preventDefault();
	if (
		draggedComponent.componentXmlPath !== undefined
		&& draggedComponent.parentXmlPath === location.parentXmlPath
		&& location.relativeOffset !== undefined
		&& location.relativePosition !== undefined
	) {
		const component = componentIdentity(draggedComponent.componentXmlPath);
		if (
			component !== undefined
			&& (
				location.relativeOffset.deltaLeft !== 0
				|| location.relativeOffset.deltaTop !== 0
				|| location.relativeDocks?.horizontal !== undefined
				|| location.relativeDocks?.vertical !== undefined
			)
		) {
			post({
				...component,
				contextToken: currentContextToken(),
				deltaLeft: location.relativeOffset.deltaLeft,
				deltaTop: location.relativeOffset.deltaTop,
				horizontalDock: location.relativeDocks?.horizontal,
				left: location.relativePosition.left,
				margin: location.relativeMargin,
				top: location.relativePosition.top,
				type: "moveRelativeComponent",
				verticalDock: location.relativeDocks?.vertical
			});
		}
		finishDrag();
		return;
	}
	const parent = componentIdentity(location.parentXmlPath);
	const reference = location.referenceXmlPath === undefined
		? undefined
		: componentIdentity(location.referenceXmlPath);
	if (parent === undefined || (location.referenceXmlPath !== undefined && reference === undefined)) {
		finishDrag();
		return;
	}
	if (draggedComponent.componentXmlPath === undefined) {
		post({
			absolutePosition: location.absolutePosition,
			componentType: draggedComponent.type,
			contextToken: currentContextToken(),
			framePlacement: location.framePlacement,
			parentComponentName: parent.componentName,
			parentXmlPath: parent.xmlPath,
			gridPosition: location.gridPosition,
			position: location.position,
			relativePlacement: location.relativeOffset === undefined || location.relativePosition === undefined
				? undefined
				: {
					...location.relativeOffset,
					horizontalDock: location.relativeDocks?.horizontal,
					...location.relativePosition,
					margin: location.relativeMargin,
					verticalDock: location.relativeDocks?.vertical
				},
			referenceComponentName: reference?.componentName,
			referenceXmlPath: reference?.xmlPath,
			renderVersion: parent.renderVersion,
			target: draggedComponent.visual ? "canvas" : "nonvisual",
			type: "addComponent"
		});
	} else {
		if (draggedComponent.componentName === undefined) {
			finishDrag();
			return;
		}
		post({
			absolutePosition: location.absolutePosition,
			componentName: draggedComponent.componentName,
			componentXmlPath: draggedComponent.componentXmlPath,
			contextToken: currentContextToken(),
			framePlacement: location.framePlacement,
			parentComponentName: parent.componentName,
			parentXmlPath: parent.xmlPath,
			gridPosition: location.gridPosition,
			position: location.position,
			relativePlacement: location.relativeOffset === undefined || location.relativePosition === undefined
				? undefined
				: {
					...location.relativeOffset,
					horizontalDock: location.relativeDocks?.horizontal,
					...location.relativePosition,
					margin: location.relativeMargin,
					verticalDock: location.relativeDocks?.vertical
				},
			referenceComponentName: reference?.componentName,
			referenceXmlPath: reference?.xmlPath,
			renderVersion: parent.renderVersion,
			type: "relocateComponent"
		});
	}
	finishDrag();
}

/** 统一结束任意拖动并清除浏览器瞬时状态。 */
function finishDrag(): void {
	draggedDesignerColumnId = undefined;
	draggedComponent = undefined;
	componentDragging.value = false;
	dragHoveredComponentPath.value = undefined;
	document.body.classList.remove("component-dragging");
	clearDropTargets();
	clearDesignerColumnDropTarget();
}

/** 合并同一帧内的多次重绘请求，待布局稳定后同步文本省略状态。 */
function scheduleDesignSurfaceSync(): void {
	if (designSurfaceFrame !== undefined) return;
	designSurfaceFrame = window.requestAnimationFrame(() => {
		designSurfaceFrame = undefined;
		const content = shell.value?.querySelector<HTMLElement>(".window-content");
		if (content !== undefined && content !== null) syncVisualControlContents(content);
	});
}

/** 相对布局先在动画帧中应用新位置；下一帧再从最终 DOM 矩形恢复选中示意线。 */
function scheduleSelectedPlacementFeedbackRefresh(): void {
	if (placementFeedbackFrame !== undefined) window.cancelAnimationFrame(placementFeedbackFrame);
	placementFeedbackFrame = window.requestAnimationFrame(() => {
		placementFeedbackFrame = window.requestAnimationFrame(() => {
			placementFeedbackFrame = undefined;
			refreshSelectedPlacementFeedback();
		});
	});
}

/** 接收宿主完整投影，并用宿主保存的顺序替换当前 Vue 视图状态。 */
function onWindowMessage(event: MessageEvent<unknown>): void {
	const value = event.data;
	if (typeof value !== "object" || value === null) return;
	const hostMessage = value as DesignerWebviewHostMessage;
	if (hostMessage.type === "componentClipboardStatus") {
		if (
			hostMessage.contextToken === currentContextToken()
			&& hostMessage.requestId === componentClipboardRequestId
			&& contextMenu.value?.pasteXmlPath !== undefined
		) contextMenu.value.canPaste = hostMessage.available;
		return;
	}
	if (hostMessage.type !== "renderDesigner") return;
	const renderMessage: DesignerWebviewRenderMessage = hostMessage;
	message.value = renderMessage;
	const gridSelection = selectedGridCell.value;
	if (gridSelection !== undefined) {
		const parent = renderMessage.projection.root === undefined
			? undefined
			: findDesignerComponentNode(renderMessage.projection.root, gridSelection.parentXmlPath);
		const cell = parent === undefined
			? undefined
			: designerGridCells(parent).find((candidate) => (
				candidate.column === gridSelection.column && candidate.row === gridSelection.row
			));
		if (cell === undefined || cell.occupiedComponentPath !== undefined) selectedGridCell.value = undefined;
	}
	columnOrder.value = isDesignerColumnOrder(renderMessage.columnOrder)
		? renderMessage.columnOrder
		: DESIGNER_COLUMN_IDS;
	const displayOptions = normalizeDesignerDisplayOptions(renderMessage.displayOptions);
	componentLabelsVisible.value = displayOptions.componentLabelsVisible;
	designerDebug.value = displayOptions.designerDebug;
	layoutHoverSync.value = displayOptions.layoutHoverSync;
	hideContextMenu();
	void nextTick(() => {
		scheduleDesignSurfaceSync();
		scheduleSelectedPlacementFeedbackRefresh();
	});
}

/** 把保存交给真实文档；非文本编辑状态下同时转交撤销和重做。 */
function onKeydown(event: KeyboardEvent): void {
	const commandModifier = (event.ctrlKey || event.metaKey) && !event.altKey;
	const commandKey = event.key.toLowerCase();
	const save = commandModifier && commandKey === "s" && !event.shiftKey;
	const undo = commandModifier && commandKey === "z" && !event.shiftKey;
	const redo = commandModifier && (commandKey === "y" || (commandKey === "z" && event.shiftKey));
	const copy = commandModifier && commandKey === "c" && !event.shiftKey;
	const cut = commandModifier && commandKey === "x" && !event.shiftKey;
	const paste = commandModifier && commandKey === "v" && !event.shiftKey;
	const remove = event.key === "Delete"
		&& !event.ctrlKey
		&& !event.metaKey
		&& !event.altKey
		&& !event.shiftKey
		&& !event.repeat
		&& !event.isComposing;
	const editingText = event.target instanceof HTMLInputElement
		|| event.target instanceof HTMLTextAreaElement
		|| event.target instanceof HTMLSelectElement
		|| (event.target instanceof HTMLElement && (
			event.target.isContentEditable
			|| event.target.closest(".property-choice-trigger, .property-choice-menu") !== null
		));
	const textSelection = window.getSelection();
	const selectingText = textSelection !== null
		&& !textSelection.isCollapsed
		&& textSelection.toString().length > 0;
	if (save) {
		event.preventDefault();
		event.stopPropagation();
		post({
			contextToken: currentContextToken(),
			pendingPropertyEdit: event.target instanceof HTMLInputElement
				? createPropertyEdit(event.target, event.target.value)
				: undefined,
			type: "saveDocument"
		});
		return;
	}
	const projection = message.value?.projection;
	const selectedComponent = projection?.root === undefined || projection.selectedPath === undefined
		? undefined
		: findDesignerComponentNode(projection.root, projection.selectedPath);
	const selectedParent = projection?.root === undefined || selectedComponent?.parentPath === undefined
		? undefined
		: findDesignerComponentNode(projection.root, selectedComponent.parentPath);
	const nudge = !editingText
		&& !event.isComposing
		&& !event.ctrlKey
		&& !event.metaKey
		&& !event.altKey
		&& !event.shiftKey
		&& selectedGridCell.value === undefined
		&& selectedComponent?.visual === true
		&& selectedComponent.layoutReadOnly !== true
		&& selectedComponent.absolutePosition !== undefined
		&& selectedParent?.layout === "absolute"
		? ({
			ArrowDown: { deltaLeft: 0, deltaTop: 1 },
			ArrowLeft: { deltaLeft: -1, deltaTop: 0 },
			ArrowRight: { deltaLeft: 1, deltaTop: 0 },
			ArrowUp: { deltaLeft: 0, deltaTop: -1 }
		} as const)[event.key as "ArrowDown" | "ArrowLeft" | "ArrowRight" | "ArrowUp"]
		: undefined;
	if (nudge !== undefined) {
		event.preventDefault();
		event.stopPropagation();
		hideContextMenu();
		const identity = componentIdentity(selectedComponent.path);
		if (identity === undefined) return;
		post({
			...identity,
			contextToken: currentContextToken(),
			deltaLeft: nudge.deltaLeft,
			deltaTop: nudge.deltaTop,
			type: "nudgeComponent"
		});
		return;
	}
	if (copy && !editingText && !selectingText && selectedComponent?.parentPath !== undefined) {
		event.preventDefault();
		event.stopPropagation();
		requestCopyComponent(selectedComponent.path);
		return;
	}
	if (
		cut
		&& !editingText
		&& !selectingText
		&& selectedGridCell.value === undefined
		&& selectedComponent?.parentPath !== undefined
		&& selectedComponent.layoutReadOnly !== true
	) {
		event.preventDefault();
		event.stopPropagation();
		hideContextMenu();
		requestCutComponent(selectedComponent.path);
		return;
	}
	if (
		remove
		&& !editingText
		&& !selectingText
		&& selectedGridCell.value === undefined
		&& selectedComponent?.parentPath !== undefined
		&& selectedComponent.layoutReadOnly !== true
	) {
		event.preventDefault();
		event.stopPropagation();
		hideContextMenu();
		requestDeleteComponent(selectedComponent.path);
		return;
	}
	const gridPasteTarget = selectedGridCell.value;
	const pasteTargetPath = gridPasteTarget?.parentXmlPath ?? resolveDesignerPasteTargetPath(selectedComponent);
	if (paste && !editingText && pasteTargetPath !== undefined) {
		event.preventDefault();
		event.stopPropagation();
		requestPasteComponent(pasteTargetPath, gridPasteTarget === undefined
			? undefined
			: { column: gridPasteTarget.column, row: gridPasteTarget.row });
		return;
	}
	if ((undo || redo) && !editingText) {
		event.preventDefault();
		event.stopPropagation();
		post({
			contextToken: currentContextToken(),
			direction: undo ? "undo" : "redo",
			type: "navigateDocumentHistory"
		});
	}
	if (event.key === "Escape") {
		finishDrag();
		hideContextMenu();
	}
}

/** 视口变化会使菜单坐标和文字测量失效。 */
function onResize(): void {
	hideContextMenu();
	scheduleDesignSurfaceSync();
}

/** 任意滚动后关闭浮层，并重新测量画布中的可见文字。 */
function onScroll(): void {
	hideContextMenu();
	scheduleDesignSurfaceSync();
}

/** Webview 挂载后注册唯一一组全局事件，并通知宿主可以发送首帧。 */
onMounted(() => {
	document.addEventListener("keydown", onKeydown);
	document.addEventListener("scroll", onScroll, { capture: true, passive: true });
	window.addEventListener("blur", hideContextMenu);
	window.addEventListener("message", onWindowMessage);
	window.addEventListener("resize", onResize);
	post({ type: "ready" });
});

/** 卸载时对称释放全局事件和尚未执行的动画帧。 */
onBeforeUnmount(() => {
	finishDrag();
	document.removeEventListener("keydown", onKeydown);
	document.removeEventListener("scroll", onScroll, true);
	window.removeEventListener("blur", hideContextMenu);
	window.removeEventListener("message", onWindowMessage);
	window.removeEventListener("resize", onResize);
	if (designSurfaceFrame !== undefined) window.cancelAnimationFrame(designSurfaceFrame);
	if (placementFeedbackFrame !== undefined) window.cancelAnimationFrame(placementFeedbackFrame);
});
</script>
