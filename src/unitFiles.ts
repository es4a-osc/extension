/*
定义 Simple 单元文件模板、生命周期事件代码操作，并集中校验单元、文件夹与资源文件名称。
xhwsd@qq.com 2026-8-27
*/

import { renameSimpleComponent } from "./componentRename";
import { analyzeSimpleSourceSyntax } from "./simpleSourceSyntax";
import { simpleSourceTokenIndex } from "./simpleSourceLexical";
import { planSimpleUnitPaths, type RefactoringUnit } from "./refactoringModel";
import type { Sdk } from "./sdk";
import * as path from "node:path";
import { sameFilePath } from "./simpleProjectPaths";
import {
	getSimplePropertyUnitType,
	inspectSimplePropertyXml,
	serializeSimplePropertySource,
	type SimpleUnitType
} from "./propertyXml";
import {
	assembleSimpleUnitSource,
	getVisibleSimpleUnitUserCode,
	splitSimpleUnitSource
} from "./simpleUnitSource";

/** Simple 源码标识符允许中文或其它 Unicode 字母开头。 */
const SIMPLE_IDENTIFIER_PATTERN = /^\p{L}[\p{L}\p{N}_]*$/u;

/** Windows 和常见文件系统不允许出现在文件夹名称中的字符。 */
const INVALID_FOLDER_CHARACTER_PATTERN = /[<>:"/\\|?*\u0000-\u001F]/;

/** Windows 保留的设备名称，忽略大小写及扩展名。 */
const WINDOWS_RESERVED_NAME_PATTERN = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

/** 由编译器预定义、可直接写在窗口或对象单元上的生命周期事件。 */
export type SimpleUnitLifecycleEventName = "加载" | "初始化";

/** 打开生命周期事件时需要执行的定位或插入操作。 */
export interface SimpleUnitLifecycleEventAction {
	readonly caretOffset: number;
	readonly existing: boolean;
	readonly insertionOffset?: number;
	readonly insertionText?: string;
}

/** 已存在的生命周期事件声明及完整事件范围。 */
interface SimpleUnitLifecycleEventHandler {
	readonly bodyOffset: number;
	readonly end?: number;
	readonly eventName: SimpleUnitLifecycleEventName;
	readonly start: number;
}

/**
 * 单元自身的加载、初始化事件按文件名绑定，与窗口 XML 根名称无关。
 * 只改声明中的对象名，保留组件事件、事件体、字符串、注释及原有排版。
 */
export function renameSimpleUnitLifecycleEventOwners(
	userCode: string,
	oldName: string,
	newName: string
): string {
	if (oldName === newName) return userCode;
	const owners = analyzeSimpleSourceSyntax(userCode).declarations.filter((declaration) => declaration.kind === "event"
		&& declaration.owner === oldName && (declaration.name === "加载" || declaration.name === "初始化"))
		.map((declaration) => declaration.ownerToken!).sort((left, right) => right.start - left.start);
	let updated = userCode;
	for (const token of owners) updated = updated.slice(0, token.start) + newName + updated.slice(token.end);
	return updated;
}

/** 识别指定单元已有的加载和初始化事件，并定位其事件体。 */
function collectSimpleUnitLifecycleEventHandlers(
	userCode: string,
	unitName: string
): readonly SimpleUnitLifecycleEventHandler[] {
	const syntax = analyzeSimpleSourceSyntax(userCode);
	return syntax.declarations.flatMap((declaration): SimpleUnitLifecycleEventHandler[] => {
		if (declaration.kind !== "event" || declaration.owner !== unitName
			|| declaration.name !== "加载" && declaration.name !== "初始化") return [];
		let end = declaration.body?.closed === true ? declaration.body.end : undefined;
		if (end !== undefined) {
			const next = syntax.tokens[simpleSourceTokenIndex(syntax.tokens, end, true) + 1];
			if (next?.kind === "comment") end = next.end;
		}
		return [{ bodyOffset: declaration.bodyOffset ?? userCode.length, end, eventName: declaration.name, start: declaration.statementStart }];
	});
}

/** 按 Simple 语法创建空的单元生命周期事件处理过程。 */
function createSimpleUnitLifecycleEvent(
	unitName: string,
	eventName: SimpleUnitLifecycleEventName,
	lineEnding: string
): { readonly bodyOffset: number; readonly source: string } {
	const declaration = `事件 ${unitName}.${eventName}()`;
	return {
		bodyOffset: declaration.length + lineEnding.length + 1,
		source: declaration + lineEnding + "\t" + lineEnding + "结束 事件"
	};
}

/** 根据后续源码已有的开头换行，只补足一个完整空白分隔行。 */
function lifecycleEventSeparatorBefore(
	followingCode: string,
	lineEnding: string
): string {
	if (followingCode.length === 0 || /^[\t \r\n]*$/u.test(followingCode)) return "";
	const leadingWhitespaceLines = followingCode.match(/^(?:[\t ]*(?:\r\n|\n|\r))+/u)?.[0];
	const leadingLineEndingCount = leadingWhitespaceLines?.match(/\r\n|\n|\r/gu)?.length ?? 0;
	if (leadingLineEndingCount >= 2) return "";
	if (leadingLineEndingCount === 1) return lineEnding;
	return lineEnding + lineEnding;
}

/**
 * 解析项目树生命周期事件命令。
 *
 * 已有事件只返回事件体位置；缺失事件写在单元头部。初始化事件在已有加载事件之后插入，
 * 加载事件始终插到最前，从而不受用户点击顺序影响，稳定保持“加载、初始化”的源码顺序。
 */
export function resolveSimpleUnitLifecycleEventAction(
	userCode: string,
	unitName: string,
	eventName: SimpleUnitLifecycleEventName,
	lineEnding = "\r\n"
): SimpleUnitLifecycleEventAction {
	const eol = lineEnding === "\r\n" ? "\r\n" : "\n";
	const handlers = collectSimpleUnitLifecycleEventHandlers(userCode, unitName);
	const existing = handlers.find((handler) => handler.eventName === eventName);
	if (existing !== undefined) {
		return { caretOffset: existing.bodyOffset, existing: true };
	}

	const created = createSimpleUnitLifecycleEvent(unitName, eventName, eol);
	if (eventName === "初始化") {
		const loadHandler = handlers.find((handler) => handler.eventName === "加载");
		if (loadHandler !== undefined) {
			if (loadHandler.end === undefined) {
				throw new Error("载入事件缺少“结束 事件”，无法安全插入初始化事件。");
			}
			const prefix = eol + eol;
			const suffix = lifecycleEventSeparatorBefore(userCode.slice(loadHandler.end), eol);
			return {
				caretOffset: loadHandler.end + prefix.length + created.bodyOffset,
				existing: false,
				insertionOffset: loadHandler.end,
				insertionText: prefix + created.source + suffix
			};
		}
	}

	const suffix = lifecycleEventSeparatorBefore(userCode, eol);
	return {
		caretOffset: created.bodyOffset,
		existing: false,
		insertionOffset: 0,
		insertionText: created.source + suffix
	};
}

/** 校验一个文件系统路径段，并按文件或文件夹生成准确提示。 */
function validateFileSystemName(value: string, kind: "文件" | "文件夹"): string | undefined {
	const name = value.trim();

	if (name.length === 0) {
		return `请输入${kind}名称。`;
	}

	if (name === "." || name === "..") {
		return `${kind}名称不能是 . 或 ..。`;
	}

	if (name.endsWith(".") || name.endsWith(" ")) {
		return `${kind}名称不能以句点或空格结尾。`;
	}

	if (INVALID_FOLDER_CHARACTER_PATTERN.test(name)) {
		return `${kind}名称包含文件系统不允许的字符。`;
	}

	if (WINDOWS_RESERVED_NAME_PATTERN.test(name)) {
		return `${kind}名称不能使用系统保留名称。`;
	}

	return undefined;
}

/**
 * 校验新建 Simple 单元名称。
 *
 * @param value 用户输入的无后缀单元名称。
 * @returns 名称有效时返回 `undefined`，否则返回可直接显示的中文错误。
 */
export function validateUnitName(value: string): string | undefined {
	const name = value.trim();

	if (name.length === 0) {
		return "请输入单元名称。";
	}

	if (name.toLowerCase().endsWith(".simple")) {
		return "只需输入单元名称，不要包含 .simple 后缀。";
	}

	if (!SIMPLE_IDENTIFIER_PATTERN.test(name)) {
		return "单元名称必须以字母开头，并且只能包含字母、数字和下划线。";
	}

	return undefined;
}

/**
 * 校验新建源码文件夹名称。
 *
 * @param value 用户输入的单层文件夹名称。
 * @returns 名称有效时返回 `undefined`，否则返回可直接显示的中文错误。
 */
export function validateUnitFolderName(value: string): string | undefined {
	return validateFileSystemName(value, "文件夹");
}

/** 校验资源树中普通文件的新文件名，输入包含扩展名。 */
export function validateResourceFileName(value: string): string | undefined {
	return validateFileSystemName(value, "文件");
}

/**
 * 从已渲染的 SDK 模板创建 Simple 单元。
 *
 * 模板属性区必须先成功解析为 XML 模型，再由统一序列化边界写回；业务命令不会
 * 直接把模板中的原属性代码写入目标文件。
 *
 * @param templateSource 已完成变量替换的 SDK 模板原文。
 * @param unitType 目标单元类型。
 * @returns 保留模板用户代码、并由 XML 模型重新生成属性区的完整单元源码。
 */
export function createSimpleUnitSourceFromTemplate(
	templateSource: string,
	unitType: SimpleUnitType
): string {
	const parsed = inspectSimplePropertyXml(templateSource);
	if (parsed.document === undefined || parsed.status !== "valid") {
		throw new Error(
			"SDK " + unitType + "模板的属性区无效："
			+ (parsed.issues.join("；") || "没有可用的 XML 属性模型。")
		);
	}
	if (getSimplePropertyUnitType(parsed.document) !== unitType) {
		throw new Error("SDK " + unitType + "模板声明的单元类型不匹配。");
	}

	const propertySource = serializeSimplePropertySource(
		parsed.document,
		{
			indentation: copiedPropertyIndentation(splitSimpleUnitSource(templateSource).propertySource),
			lineEnding: parsed.document.lineEnding
		}
	);
	return assembleSimpleUnitSource(
		templateSource,
		getVisibleSimpleUnitUserCode(templateSource),
		propertySource
	);
}

/** 从现有属性区取得重写时应继续使用的一级缩进。 */
function copiedPropertyIndentation(propertySource: string): string {
	return /(?:^|\r\n|\n|\r)([\t ]+)\S/u.exec(propertySource)?.[1] ?? "\t";
}

/** 复制使用整个项目的类型信息，只为源单元计算代码修改。 */
export interface SimpleUnitCopyContext {
	readonly sourceFile: string;
	readonly sourceRoot: string;
	readonly destinationFile: string;
	readonly destinationRoot: string;
	readonly units: readonly RefactoringUnit[];
	readonly sdk?: Sdk;
}

/**
 * 为复制后改名的单元生成新内容。
 *
 * 窗口单元同步窗口根定义；其它引用复用项目语义重构，保留同名参数及局部变量。
 * 原单元和项目内其它单元均不修改。
 */
export function createCopiedSimpleUnitSource(
	source: string,
	oldName: string,
	newName: string,
	context?: SimpleUnitCopyContext
): string {
	if (oldName === newName && (context === undefined || path.dirname(context.sourceFile) === path.dirname(context.destinationFile))) {
		return source;
	}

	const property = inspectSimplePropertyXml(source);
	if (property.document === undefined || property.status === "damaged") {
		throw new Error("源单元属性区已损坏，不能安全生成改名单元。");
	}

	const sections = splitSimpleUnitSource(source);
	const originalCode = getVisibleSimpleUnitUserCode(source);
	const sourceRoot = context?.sourceRoot ?? path.resolve(".");
	const sourceFile = context?.sourceFile ?? path.join(sourceRoot, oldName + ".simple");
	const origin: RefactoringUnit = { filePath: sourceFile, sourceRoot, userCode: originalCode, property };
	const units = [origin, ...(context?.units ?? []).filter((unit) => !sameFilePath(unit.filePath, sourceFile))];
	const changes = planSimpleUnitPaths(units, [{ oldFile: sourceFile, newFile: context?.destinationFile ?? path.join(sourceRoot, newName + ".simple"), sourceRoot: context?.destinationRoot ?? sourceRoot }], context?.sdk, origin);
	const userCode = renameSimpleUnitLifecycleEventOwners(changes.find((change) => change.unit === origin)?.userCode ?? originalCode, oldName, newName);
	if (getSimplePropertyUnitType(property.document) !== "窗口") {
		return assembleSimpleUnitSource(
			source,
			userCode,
			sections.propertySource
		);
	}

	const renamed = renameSimpleComponent(
		userCode,
		property.document,
		"/属性/定义[1]",
		newName
	);
	return assembleSimpleUnitSource(
		source,
		renamed.userCode,
		serializeSimplePropertySource(renamed.propertyDocument, {
			indentation: copiedPropertyIndentation(sections.propertySource),
			lineEnding: property.document.lineEnding
		})
	);
}
