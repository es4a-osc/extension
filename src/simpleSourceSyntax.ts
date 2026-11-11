/*
按 Simple 逻辑语句解析声明、类型位置和词法作用域，供着色与源码符号查询共用。
xhwsd@qq.com 2026-10-31
*/

import { scanSimpleSource, simpleSourceStatements, simpleSourceTokenIndex, type SimpleSourceToken } from "./simpleSourceLexical";

/** 只描述源码中可确定的角色，不依赖 SDK 中是否存在对应名称。 */
export type SimpleSourceRole = "type" | "function" | "event" | "property" | "parameter" | "variable";

/** 共享语法块身份；补全只投影此状态，不再另行推演块栈。 */
export type SimpleSourceBlockKind = "do" | "error" | "event" | "for" | "function" | "getter" | "if" | "property" | "procedure" | "select" | "setter" | "while";

/** 光标前已完成逻辑语句形成的块状态。 */
export interface SimpleSourceBlock {
	readonly header: string;
	readonly kind: SimpleSourceBlockKind;
	readonly start: number;
	readonly getterSeen?: boolean;
	readonly setterSeen?: boolean;
	readonly declarationOnly?: boolean;
}

/** 语法关键字与块身份的唯一对应关系。 */
const BLOCK_KINDS: Readonly<Record<string, SimpleSourceBlockKind>> = {
	执行: "do", 错误: "error", 事件: "event", 循环: "for", 函数: "function", 获取: "getter",
	如果: "if", 属性: "property", 过程: "procedure", 判断: "select", 设置: "setter", 判断循环: "while"
};

/** 语句块的可见范围；分支和循环分别拥有局部变量作用域。 */
export interface SimpleSourceScope {
	readonly start: number;
	end: number;
	closed?: boolean;
	readonly parent?: SimpleSourceScope;
}

/** 从语法声明得到的源码符号，所有位置均为原文 UTF-16 偏移。 */
export interface SimpleSourceDeclaration {
	readonly kind: "alias" | "constant" | "variable" | "parameter" | "function" | "procedure" | "event" | "property" | "functionResult";
	readonly name: string;
	readonly token: SimpleSourceToken;
	readonly statementStart: number;
	readonly statementEnd?: number;
	readonly scope: SimpleSourceScope;
	readonly visibleFrom: number;
	readonly static: boolean;
	readonly typeName?: string;
	readonly owner?: string;
	readonly ownerToken?: SimpleSourceToken;
	/** 声明逻辑语句结束后第一物理行的位置，保留空事件体中的空白行。 */
	readonly bodyOffset?: number;
	readonly target?: string;
	readonly passing?: "传值" | "传址";
	readonly initializer?: string;
	readonly initializerStart?: number;
	readonly initializerEnd?: number;
	readonly createdTypeName?: string;
	readonly parameters?: readonly SimpleSourceDeclaration[];
	readonly body?: SimpleSourceScope;
	readonly implicit?: boolean;
}

/** 单次源码分析的词法、声明、精确位置角色及作用域查询。 */
export interface SimpleSourceSyntax {
	readonly tokens: readonly SimpleSourceToken[];
	readonly declarations: readonly SimpleSourceDeclaration[];
	readonly roles: ReadonlyMap<number, SimpleSourceRole>;
	readonly root: SimpleSourceScope;
	declarationAt(offset: number, name?: string): SimpleSourceDeclaration | undefined;
	declarationsNamed(name: string): readonly SimpleSourceDeclaration[];
	roleAt(offset: number): SimpleSourceRole | undefined;
	resolve(name: string, offset: number): SimpleSourceDeclaration | undefined;
	/** 初值禁止读取自身或后续局部变量；调用方不得回退到同名外层符号。 */
	isBlocked(name: string, offset: number): boolean;
	callableAt(offset: number): SimpleSourceDeclaration | undefined;
	blocksAt(offset: number): readonly SimpleSourceBlock[];
}

/** 触发事件的名称只在对象事件表查找，不受局部变量或参数遮蔽。 */
export function isSimpleEventTarget(syntax: SimpleSourceSyntax, offset: number): boolean {
	return syntax.roleAt(offset) === "event" && syntax.declarationAt(offset) === undefined;
}

/** 解析中尚未关闭的语法块。 */
interface SyntaxFrame {
	readonly kind: string;
	readonly header: string;
	getterSeen?: boolean;
	setterSeen?: boolean;
	scope: SimpleSourceScope;
	readonly declaration?: SimpleSourceDeclaration;
	readonly branches?: readonly SimpleSourceScope[];
	readonly declarationOnly?: boolean;
}

/** 按最外层逗号拆分，数组维数、调用和字符串中的逗号保留在原片段中。 */
function splitTokens(tokens: readonly SimpleSourceToken[]): readonly (readonly SimpleSourceToken[])[] {
	const groups: SimpleSourceToken[][] = [[]];
	let depth = 0;
	for (const token of tokens) {
		if (token.text === "(") {
			depth += 1;
		} else if (token.text === ")") {
			depth -= 1;
		}
		if (token.text === "," && depth === 0) {
			groups.push([]);
		} else {
			groups.at(-1)!.push(token);
		}
	}
	return groups.filter((group) => group.length > 0);
}

/** 查找当前逻辑语句中的配对右括号；不越过未续行的下一语句。 */
export function closingParenthesis(tokens: readonly SimpleSourceToken[], start: number): number {
	let depth = 0;
	for (let index = start; index < tokens.length; index += 1) {
		if (tokens[index]!.text === "(") {
			depth += 1;
		} else if (tokens[index]!.text === ")" && --depth === 0) {
			return index;
		}
	}
	return tokens.length;
}

/** 读取点号限定名；类型段只包含名称，数组维数另行读取。 */
export function nameEnd(tokens: readonly SimpleSourceToken[], start: number): number {
	if (tokens[start]?.kind !== "word") {
		return start;
	}
	let end = start + 1;
	while (tokens[end]?.text === "." && tokens[end + 1]?.kind === "word") {
		end += 2;
	}
	return end;
}

/** 读取类型并把各名称段登记为类型位置，保留数组类型的维数。 */
function readType(tokens: readonly SimpleSourceToken[], start: number, roles: Map<number, SimpleSourceRole>, source: string): string | undefined {
	let end = nameEnd(tokens, start);
	if (end === start) {
		return undefined;
	}
	for (const token of tokens.slice(start, end)) {
		if (token.kind === "word") {
			roles.set(token.start, "type");
		}
	}
	const name = tokens.slice(start, end).map((token) => token.text).join("");
	if (tokens[end]?.text !== "(") {
		return name;
	}
	const close = Math.min(tokens.length - 1, closingParenthesis(tokens, end));
	return name + source.slice(tokens[end]!.start, tokens[close]!.end).replace(/_\r?\n/gu, " ");
}

/** 只从完整创建表达式推断类型，创建后的比较等运算不能冒充被创建对象。 */
export function simpleCreatedType(tokens: readonly SimpleSourceToken[], source: string): string | undefined {
	if (tokens[0]?.text !== "创建") return undefined;
	let end = nameEnd(tokens, 1);
	if (end === 1) return undefined;
	if (tokens[end]?.text === "(") {
		end = closingParenthesis(tokens, end) + 1;
		if (end > tokens.length) return undefined;
	}
	if (end !== tokens.length && !(tokens[end]?.text === "位于" && end + 1 < tokens.length)) return undefined;
	return readType(tokens, 1, new Map(), source);
}

/** 只识别当前括号层级的语法标记，尺寸或调用参数里的等号不属于声明初值。 */
function topLevelToken(tokens: readonly SimpleSourceToken[], text: string): number {
	let depth = 0;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		if (token.text === "(") {
			depth += 1;
		} else if (token.text === ")") {
			depth -= 1;
		} else if (depth === 0 && token.text === text) {
			return index;
		}
	}
	return -1;
}

/** 在所有语句中识别创建与类型检验，点号成员不作为表达式关键字解释。 */
function expressionTypeRoles(tokens: readonly SimpleSourceToken[], roles: Map<number, SimpleSourceRole>, source: string): void {
	const pending: number[] = [];
	let depth = 0;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		if (token.text === "(") {
			depth += 1;
		} else if (token.text === ")") {
			depth -= 1;
			while (pending.length > 0 && pending.at(-1)! > depth) {
				pending.pop();
			}
		} else if (token.text === ",") {
			while (pending.length > 0 && pending.at(-1)! >= depth) {
				pending.pop();
			}
		} else if (tokens[index - 1]?.text !== ".") {
			if (token.text === "触发事件" && tokens[index + 1]?.kind === "word") {
				roles.set(tokens[index + 1]!.start, "event");
			} else if (token.text === "创建") {
				readType(tokens, index + 1, roles, source);
			} else if (token.text === "类型检验") {
				pending.push(depth);
			} else if (token.text === "是" && pending.at(-1) === depth) {
				pending.pop();
				readType(tokens, index + 1, roles, source);
			}
		}
	}
}

/** 将声明种类映射为源码角色；函数返回值在函数体内是变量。 */
export function simpleDeclarationRole(declaration: SimpleSourceDeclaration): SimpleSourceRole {
	switch (declaration.kind) {
		case "alias":
			return "type";
		case "function":
		case "procedure":
			return "function";
		case "event":
			return "event";
		case "property":
			return "property";
		case "parameter":
			return "parameter";
		default:
			return "variable";
	}
}

/**
 * 解析编辑中的用户代码；不完整声明只影响当前逻辑语句，已有名称仍可着色。
 *
 * @param source 由单元文档边界提供的用户代码。
 * @param interfaceUnit 接口成员没有函数体，不建立覆盖后续成员的局部作用域。
 * @returns 不含 SDK 状态的源码语法分析结果。
 */
export function analyzeSimpleSourceSyntax(source: string, interfaceUnit = false, tokens: readonly SimpleSourceToken[] = scanSimpleSource(source)): SimpleSourceSyntax {
	const root: SimpleSourceScope = { start: 0, end: source.length + 1 };
	const roles = new Map<number, SimpleSourceRole>();
	const declarations: SimpleSourceDeclaration[] = [];
	const byName = new Map<string, SimpleSourceDeclaration[]>();
	const byStart = new Map<number, SimpleSourceDeclaration>();
	const callables: SimpleSourceDeclaration[] = [];
	const scopeDepths = new WeakMap<SimpleSourceScope, number>([[root, 0]]);
	const scopeDepth = (value: SimpleSourceScope): number => {
		const cached = scopeDepths.get(value);
		if (cached !== undefined) {
			return cached;
		}
		const depth = value.parent === undefined ? 0 : scopeDepth(value.parent) + 1;
		scopeDepths.set(value, depth);
		return depth;
	};
	const frames: SyntaxFrame[] = [];
	const snapshots: { start: number; blocks: readonly SimpleSourceBlock[] }[] = [{ start: 0, blocks: [] }];
	const recordBlocks = (start: number): void => {
		snapshots.push({ start, blocks: frames.map((frame) => ({
			kind: BLOCK_KINDS[frame.kind]!, header: frame.header, start: frame.scope.start,
			getterSeen: frame.getterSeen, setterSeen: frame.setterSeen,
			declarationOnly: frame.declarationOnly || frame.declaration?.kind === "event" && frame.declaration.owner === undefined
		})) });
	};
	const separators = tokens.filter((token) => token.kind === "separator");
	let separatorIndex = 0;
	let header = "";
	const scope = (): SimpleSourceScope => frames.at(-1)?.scope ?? root;
	const closeFrom = (index: number, end: number): void => {
		for (const frame of frames.splice(index)) {
			frame.scope.end = end;
			for (const branch of frame.branches ?? []) branch.end = end;
			const property = [...frames].reverse().find((value) => value.kind === "属性");
			if (property !== undefined && frame.kind === "获取") {
				property.getterSeen = true;
			}
			if (property !== undefined && frame.kind === "设置") {
				property.setterSeen = true;
			}
		}
	};
	const open = (kind: string, start: number, declaration?: SimpleSourceDeclaration): SimpleSourceScope => {
		const body: SimpleSourceScope = { start, end: source.length + 1, parent: scope() };
		frames.push({ kind, header, scope: body, declaration });
		return body;
	};
	const add = (declaration: SimpleSourceDeclaration): void => {
		declarations.push(declaration);
		const names = byName.get(declaration.name) ?? [];
		names.push(declaration);
		byName.set(declaration.name, names);
		if (declaration.implicit !== true) {
			byStart.set(declaration.token.start, declaration);
			roles.set(declaration.token.start, simpleDeclarationRole(declaration));
			if (declaration.body !== undefined && declaration.kind !== "property") {
				callables.push(declaration);
			}
		}
	};

	for (const statement of simpleSourceStatements(tokens)) {
		const first = statement[0]!;
		const last = statement.at(-1)!;
		header = source.slice(first.start, last.end).replace(/_\r?\n/gu, (value) => " ".repeat(value.length));
		while (separators[separatorIndex] !== undefined && separators[separatorIndex]!.start < last.end) {
			separatorIndex += 1;
		}
		const boundary = separators[separatorIndex]?.end ?? source.length + 1;
		expressionTypeRoles(statement, roles, source);
		try {
			const staticDeclaration = first.text === "静态";
			const head = staticDeclaration ? 1 : 0;
			const keyword = statement[head]?.text;
			if (keyword === undefined) {
				continue;
			}

			/* 关闭范围与编译器恢复作用域的时机一致，保留分支之间的真实父链。 */
			const postCondition = (keyword === "直到" || keyword === "判断循环") && frames.at(-1)?.kind === "执行";
			if (keyword === "结束" || keyword === "下个" || postCondition) {
				const ending = keyword === "下个" ? "循环" : keyword === "结束" ? statement[head + 1]?.text : "执行";
				const index = frames.findLastIndex((frame) => frame.kind === ending);
				if (index >= 0) {
					frames[index]!.scope.closed = true;
					// 编译器先离开执行循环体的作用域，再解析结尾条件。
					const outerCondition = postCondition || keyword === "下个";
					closeFrom(index, outerCondition ? first.start : statement.at(-1)!.end);
					if (outerCondition) recordBlocks(first.end);
				}
				continue;
			}
			if (keyword === "否则" || keyword === "否则如果" || keyword === "分支") {
				const kind = keyword === "分支" ? [...frames].reverse().find((frame) => frame.kind === "判断" || frame.kind === "错误")?.kind : "如果";
				const index = frames.findLastIndex((frame) => frame.kind === kind);
				if (index >= 0 && kind !== undefined) {
					const previous = frames[index]!;
					closeFrom(index + 1, first.start);
					frames[index] = { kind, header,
						branches: [...(previous.branches ?? []), previous.scope],
						scope: { start: first.start, end: source.length + 1, parent: previous.scope } };
				}
				continue;
			}

			/* 声明头由令牌和括号结构确定，冒号分句与续行共用同一条解析路径。 */
			if (["函数", "过程", "事件", "属性"].includes(keyword)) {
				const previous = frames.findIndex((frame) => frame.declaration !== undefined);
				if (previous >= 0) {
					closeFrom(previous, first.start);
				}
				const end = nameEnd(statement, head + 1);
				// 尚未输入事件成员时，拥有者不能被误登记成同名事件声明。
				if (keyword === "事件" && statement[end]?.text === ".") continue;
				const token = statement[end - 1];
				if (end === head + 1 || token === undefined) {
					continue;
				}
				const kind = keyword === "函数" ? "function" : keyword === "过程" ? "procedure" : keyword === "事件" ? "event" : "property";
				const parameters: SimpleSourceDeclaration[] = [];
				const body: SimpleSourceScope = { start: first.start, end: interfaceUnit ? statement.at(-1)!.end : source.length + 1, parent: root };
				const close = statement[end]?.text === "(" ? closingParenthesis(statement, end) : end - 1;
				const typeIndex = keyword === "属性" ? end : close + 1;
				const typeName = statement[typeIndex]?.text === "为" ? readType(statement, typeIndex + 1, roles, source) : undefined;
				let bodyOffset = Math.min(boundary, source.length);
				while (source[bodyOffset] === "\t" || source[bodyOffset] === " ") bodyOffset += 1;
				const declaration: SimpleSourceDeclaration = {
					kind, name: token.text, token, scope: root, visibleFrom: 0, statementStart: first.start,
					static: staticDeclaration, typeName, parameters, body,
					owner: end > head + 2 ? statement.slice(head + 1, end - 2).map((part) => part.text).join("") : undefined,
					ownerToken: end > head + 2 ? statement[head + 1] : undefined,
					bodyOffset
				};
				add(declaration);
				frames.push({ kind: keyword, header, scope: body, declaration, declarationOnly: interfaceUnit });
				if (statement[end]?.text === "(") {
					for (const group of splitTokens(statement.slice(end + 1, close))) {
						const passing = group[0]?.text === "传值" || group[0]?.text === "传址" ? group[0].text : undefined;
						const nameIndex = passing === undefined ? 0 : 1;
						const parameter = group[nameIndex];
						if (parameter?.kind !== "word") {
							continue;
						}
						const value: SimpleSourceDeclaration = {
							kind: "parameter", name: parameter.text, token: parameter, scope: body, visibleFrom: first.start,
							statementStart: first.start, static: false, passing,
							typeName: group[nameIndex + 1]?.text === "为" ? readType(group, nameIndex + 2, roles, source) : undefined
						};
						parameters.push(value);
						add(value);
					}
				}
				if (kind === "function" && !interfaceUnit) {
					add({ ...declaration, kind: "functionResult", scope: body, visibleFrom: statement.at(-1)!.end, implicit: true, body: undefined, parameters: undefined });
				}
				continue;
			}
			if (keyword === "获取" || keyword === "设置") {
				const property = [...frames].reverse().find((frame) => frame.declaration?.kind === "property")?.declaration;
				if (property !== undefined) {
					const body = open(keyword, first.start);
					add({ ...property, kind: keyword === "设置" ? "parameter" : "functionResult", scope: body, visibleFrom: first.end, implicit: true, body: undefined, parameters: undefined });
				}
				continue;
			}
			if (keyword === "变量" || keyword === "常量") {
				for (const group of splitTokens(statement.slice(head + 1))) {
					const token = group[0];
					if (token?.kind !== "word") {
						continue;
					}
					const equal = topLevelToken(group, "=");
					const createdTypeName = equal < 0 ? undefined : simpleCreatedType(group.slice(equal + 1), source);
					const typeName = group[1]?.text === "为" ? readType(group, 2, roles, source)
						: createdTypeName;
					add({
						kind: keyword === "常量" ? "constant" : "variable", name: token.text, token, scope: scope(),
						visibleFrom: scope() === root ? 0 : group.at(-1)!.end, statementStart: first.start, statementEnd: boundary, static: staticDeclaration, typeName,
						createdTypeName,
						initializerStart: equal < 0 ? undefined : group[equal]!.end,
						initializerEnd: equal < 0 ? undefined : statement.find((value) => value.start >= group.at(-1)!.end && value.text === ",")?.start ?? boundary,
						initializer: equal < 0 ? undefined : source.slice(group[equal]!.end, group.at(-1)!.end).trim().replace(/_\r?\n/gu, " ")
					});
				}
			} else if (keyword === "别名" && statement[head + 1]?.kind === "word") {
				const token = statement[head + 1]!;
				const target = statement[head + 2]?.text === "=" ? readType(statement, head + 3, roles, source) : undefined;
				add({ kind: "alias", name: token.text, token, scope: scope(), visibleFrom: 0, statementStart: first.start, static: false, target });
			} else if (keyword === "如果" && statement.at(-1)?.text === "则") {
				open(keyword, first.start);
			} else if (["判断", "判断循环", "循环", "执行"].includes(keyword)) {
				open(keyword, first.start);
			} else if (keyword === "位于" && statement[1]?.text === "错误") {
				open("错误", first.start);
			}

		} finally {
			recordBlocks(boundary);
		}
	}

	const wordAt = (offset: number): SimpleSourceToken | undefined => {
		const current = tokens[simpleSourceTokenIndex(tokens, offset)];
		return current?.kind === "word" ? current : tokens[simpleSourceTokenIndex(tokens, offset, true)];
	};
	const isBlocked = (name: string, offset: number): boolean => {
		const initializer = declarations.find((value) => value.scope !== root && value.kind === "variable" && value.initializerStart !== undefined
			&& offset >= value.initializerStart && offset < (value.initializerEnd ?? value.token.end));
		if (initializer === undefined) return false;
		// InitializerScope 先查最近符号再检查声明顺序，不退回同名外层字段、类型或全局成员。
		const visible = (byName.get(name) ?? []).filter((value) => value.scope.start <= offset && offset < value.scope.end)
			.sort((left, right) => scopeDepth(right.scope) - scopeDepth(left.scope))[0];
		return visible?.kind === "variable" && visible.scope !== root && visible.token.start >= initializer.token.start;
	};
	return {
		tokens, declarations, roles, root, isBlocked,
		declarationAt(offset, name) {
			const token = byStart.get(offset) ?? byStart.get(wordAt(offset)?.start ?? -1);
			return name === undefined || token?.name === name ? token : undefined;
		},
		declarationsNamed(name) {
			return byName.get(name) ?? [];
		},
		roleAt(offset) {
			return roles.get(wordAt(offset)?.start ?? -1);
		},
		callableAt(offset) {
			let low = 0;
			let high = callables.length;
			while (low < high) {
				const middle = Math.floor((low + high) / 2);
				if (callables[middle]!.body!.start <= offset) {
					low = middle + 1;
				} else {
					high = middle;
				}
			}
			const candidate = callables[low - 1];
			return candidate?.body !== undefined && offset < candidate.body.end ? candidate : undefined;
		},
		blocksAt(offset) {
			let low = 0;
			let high = snapshots.length;
			while (low + 1 < high) {
				const middle = Math.floor((low + high) / 2);
				if (snapshots[middle]!.start <= offset) {
					low = middle;
				} else {
					high = middle;
				}
			}
			return snapshots[low]!.blocks;
		},
		resolve(name, offset) {
			if (isBlocked(name, offset)) return undefined;
			let result: SimpleSourceDeclaration | undefined;
			for (const declaration of byName.get(name) ?? []) {
				if (offset < declaration.visibleFrom || offset < declaration.scope.start || offset >= declaration.scope.end) {
					continue;
				}
				if (result === undefined || scopeDepth(declaration.scope) > scopeDepth(result.scope)
					|| scopeDepth(declaration.scope) === scopeDepth(result.scope) && declaration.token.start >= result.token.start) {
					result = declaration;
				}
			}
			return result;
		}
	};
}
