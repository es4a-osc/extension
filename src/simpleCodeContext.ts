/*
按当前编译器的声明、表达式和语句阶段确定代码提示位置，统一语言能力的执行语境。
xhwsd@qq.com 2026-11-5
*/

import languageFacts from "./simpleLanguageFacts.json";
import { simpleSourceStatements, type SimpleSourceToken } from "./simpleSourceLexical";
import { nameEnd, type SimpleSourceSyntax } from "./simpleSourceSyntax";

/** 当前位置允许补充的语法种类；成员的具体资格仍由共享语义模型确定。 */
export interface SimpleCodeContext {
	readonly slot: "statement" | "value" | "member" | "operator" | "type" | "name" | "alias" | "eventOwner" | "event" | "loopVariable" | "errorType" | "keyword" | "none";
	readonly keywords?: readonly string[];
	readonly constant?: boolean;
	/** 完整语句左侧的源码范围，由语义层判定是否能够继续赋值。 */
	readonly assignmentTarget?: { readonly start: number; readonly end: number };
	readonly static: boolean;
	readonly executable: boolean;
}

/** 参数和成员访问共同使用的执行语境，不以是否有静态修饰词代替实际语义。 */
export function simpleExecutionContext(syntax: SimpleSourceSyntax, offset: number, unitName?: string): { readonly static: boolean; readonly executable: boolean; readonly constant: boolean } {
	if (syntax.blocksAt(offset).at(-1)?.declarationOnly) return { static: false, executable: false, constant: false };
	if (syntax.blocksAt(offset).some((frame) => frame.kind === "getter" || frame.kind === "setter")) return { static: false, executable: true, constant: false };
	const callable = syntax.callableAt(offset);
	if (callable !== undefined) return {
		static: callable.static || callable.kind === "event" && callable.owner === unitName && callable.name === "加载",
		executable: !(callable.kind === "event" && callable.owner === undefined),
		constant: false
	};
	const initializer = syntax.declarations.find((value) => value.scope === syntax.root && ["variable", "constant"].includes(value.kind)
		&& offset >= value.statementStart && offset < (value.statementEnd ?? value.token.end));
	return { static: initializer?.static === true || initializer?.kind === "constant", executable: initializer !== undefined, constant: initializer?.kind === "constant" };
}

/* 优先级来自 Parser.parseExpression；类型检验的操作数在比较运算符前结束。 */
const PRECEDENCE: Readonly<Record<string, number>> = {
	或: 2, 异或: 2, 且: 1, 是: 4, 非: 4, 匹配: 4, "=": 4, "<>": 4, "<": 4, "<=": 4, ">": 4, ">=": 4,
	"<<": 5, ">>": 5, "&": 6, "+": 7, "-": 7, "%": 8, "\\": 9, "*": 10, "/": 10, "^": 12
};
const OPERATORS = Object.keys(PRECEDENCE);
const RESERVED_WORDS = new Set<string>(Object.values(languageFacts.words).map((word) => word.text));
type Position = Pick<SimpleCodeContext, "slot" | "keywords" | "assignmentTarget">;
const value: Position = { slot: "value" };
const none: Position = { slot: "none" };
const keyword = (...keywords: string[]): Position => ({ slot: "keyword", keywords });

/** 只解析光标前的令牌，返回未完成的位置；不完整的嵌套调用不会被当作完整表达式。 */
class CodePrefix {
	index = 0;
	position?: Position;
	array?: "dynamic" | "sized";
	/** 保存当前逻辑语句的原始令牌，所有位置沿用共享词法偏移。 */
	constructor(readonly tokens: readonly SimpleSourceToken[]) {}
	text(): string | undefined { return this.tokens[this.index]?.text; }

	/** 读取类型及数组维度；形参和返回类型的数组只允许逗号，不允许尺寸表达式。 */
	type(sized = false): boolean {
		this.array = undefined;
		if (this.text() === undefined) { this.position = { slot: "type" }; return false; }
		const end = nameEnd(this.tokens, this.index);
		if (end === this.index) { this.position = none; return false; }
		this.index = end;
		if (this.text() === ".") { this.position = { slot: "type" }; return false; }
		if (this.text() !== "(") return true;
		this.index++;
		if (this.text() === ")" || this.text() === ",") {
			this.array = "dynamic";
			while (this.text() === ",") this.index++;
			if (this.text() !== ")") { this.position = none; return false; }
			this.index++; return true;
		}
		if (!sized) { this.position = none; return false; }
		this.array = "sized";
		for (;;) {
			if (!this.expression()) return false;
			if (this.text() === undefined) { this.position = this.operators(); return false; }
			if (this.text() === ")") { this.index++; this.array = "sized"; return true; }
			if (this.text() !== ",") { this.position = none; return false; }
			this.index++;
		}
	}

	/** 生成当前优先级允许继续的运算符，并保留语句要求的分隔关键字。 */
	operators(minimum = 0, delimiters: readonly string[] = []): Position {
		return { slot: "operator", keywords: [...delimiters, ...OPERATORS.filter((name) => PRECEDENCE[name]! > minimum)] };
	}

	/** 解析与编译器相同的前缀、一元、二元、调用、下标和点号表达式结构。 */
	expression(minimum = 0): boolean {
		const token = this.tokens[this.index];
		if (token === undefined) { this.position = value; return false; }
		this.index++;
		if (["+", "-", "取反"].includes(token.text)) {
			if (!this.expression(token.text === "取反" ? 3 : 11)) return false;
		} else if (token.text === "类型检验") {
			if (!this.expression(4)) return false;
			if (this.text() === undefined) { this.position = this.operators(4, ["是"]); return false; }
			if (this.text() !== "是") { this.position = none; return false; }
			this.index++;
			if (!this.type()) return false;
		} else if (token.text === "创建") {
			if (!this.type(true)) return false;
			if (this.text() === "位于" && this.array === undefined) { this.index++; if (!this.expression()) return false; }
		} else if (token.text === "(") {
			if (!this.expression()) return false;
			if (this.text() !== ")") { this.position = this.text() === undefined ? this.operators() : none; return false; }
			this.index++;
		} else if (!["word", "number", "string"].includes(token.kind)
			|| token.kind === "word" && RESERVED_WORDS.has(token.text) && !["本对象", "真", "假", "空"].includes(token.text)) {
			this.position = none; return false;
		}

		// 当前编译器只在以标识符开头的限定名之后解析一次调用或下标。
		const callable = token.kind === "word" && !["本对象", "创建", "类型检验", "取反", "真", "假", "空"].includes(token.text);
		while (this.text() === ".") {
			this.index++;
			if (this.text() === undefined) { this.position = { slot: "member" }; return false; }
			if (this.tokens[this.index]?.kind !== "word") { this.position = none; return false; }
			this.index++;
		}
		if (callable && this.text() === "(") {
			this.index++;
			if (this.text() !== ")") for (;;) {
				if (!this.expression()) return false;
				if (this.text() !== ",") break;
				this.index++;
			}
			if (this.text() !== ")") { this.position = this.text() === undefined ? this.operators() : none; return false; }
			this.index++;
			while (this.text() === ".") {
				this.index++;
				if (this.text() === undefined) { this.position = { slot: "member" }; return false; }
				this.index++;
			}
		}
		while (this.text() !== undefined && (PRECEDENCE[this.text() ?? ""] ?? 0) > minimum) {
			const operator = this.text()!;
			this.index++;
			if (!this.expression(PRECEDENCE[operator]! - (operator === "^" ? 1 : 0))) return false;
		}
		return true;
	}
}

/** 根据完整源码确定当前逻辑语句，字符串、冒号及续行沿用共享词法规则。 */
export function simpleCodeContext(offset: number, syntax: SimpleSourceSyntax, unitName?: string): SimpleCodeContext {
	const execution = simpleExecutionContext(syntax, offset, unitName);
	const statements = simpleSourceStatements(syntax.tokens);
	const separator = syntax.tokens.findLast((token) => token.kind === "separator" && token.end <= offset)?.end ?? 0;
	const tokens = statements.find((statement) => statement[0]!.start >= separator && statement[0]!.start <= offset)?.filter((token) => token.end <= offset) ?? [];
	const reader = new CodePrefix(tokens);
	const stack = syntax.blocksAt(offset);
	const frame = stack.at(-1);
	const result = (position: Position, constant = execution.constant): SimpleCodeContext => ({ ...execution, ...position, constant });
	const expression = (delimiters: readonly string[] = []): Position => reader.expression() ? reader.text() === undefined ? reader.operators(0, delimiters) : none : reader.position ?? value;
	const expect = (name: string): boolean => {
		if (reader.text() === name) { reader.index++; return true; }
		reader.position = reader.text() === undefined ? keyword(name) : none; return false;
	};
	let head = reader.text();
	if (frame?.declarationOnly && head !== "结束") return result(head === undefined ? keyword("结束") : none);
	if (head === "静态") { reader.index++; head = reader.text(); if (head === undefined) return result(keyword("变量", "函数", "过程")); }
	if (["变量", "常量", "属性", "别名"].includes(head ?? "")) {
		reader.index++;
		for (;;) {
			if (reader.text() === undefined) return result({ slot: "name" });
			reader.index++;
			if (!expect(head === "别名" ? "=" : "为")) return result(reader.position!);
			if (head === "别名") return result({ slot: "alias" });
			if (!reader.type(head === "变量")) return result(reader.position!);
			if (head === "常量" && reader.array !== undefined) return result(none);
			const initialized = reader.text() === "=";
			if (initialized) {
				if (head === "属性" || reader.array === "sized") return result(none);
				reader.index++;
				if (!reader.expression()) return result(reader.position ?? value, head === "常量");
			}
			if (reader.text() !== ",") return result(reader.text() !== undefined ? none : initialized ? reader.operators()
				: head !== "属性" && reader.array !== "sized" ? keyword("=") : none, head === "常量");
			if (head === "属性") return result(none);
			reader.index++;
		}
	}
	if (["函数", "过程", "事件"].includes(head ?? "")) {
		reader.index++;
		if (reader.text() === undefined) return result({ slot: head === "事件" ? "eventOwner" : "name" });
		reader.index = nameEnd(tokens, reader.index);
		if (reader.text() === ".") return result({ slot: head === "事件" ? "event" : "name" });
		if (!expect("(")) return result(reader.position!);
		while (reader.text() !== ")") {
			if (reader.text() === "传址" || reader.text() === "传值") reader.index++;
			if (reader.text() === undefined) return result({ slot: "name" });
			reader.index++;
			if (!expect("为") || !reader.type()) return result(reader.position!);
			if (reader.text() === ")") break;
			if (reader.text() !== ",") return result(none);
			reader.index++;
		}
		reader.index++;
		if (head === "函数") { if (!expect("为") || !reader.type()) return result(reader.position!); }
		return result(none);
	}
	if (tokens.length === 0) {
		if (frame?.declarationOnly) return result(keyword("结束"));
		return result({ slot: "statement" });
	}
	const statement = (inline = false): Position => {
		const start = reader.index;
		const first = reader.text();
		reader.index++;
		if (first === "退出") {
			const names = { procedure: "过程", function: "函数", event: "事件", for: "循环", while: "判断循环", do: "执行", getter: "属性", setter: "属性" };
			const targets = [...new Set(stack.flatMap((item) => names[item.kind as keyof typeof names] ?? []))];
			if (reader.text() === undefined) return keyword(...targets, ...(inline ? ["否则"] : []));
			if (targets.includes(reader.text()!)) reader.index++;
			return inline && reader.text() === undefined ? keyword("否则") : none;
		}
		if (first === "触发事件") {
			if (reader.text() === undefined) return { slot: "event" };
			if (!reader.expression(99)) return reader.position ?? value;
			return inline && reader.text() === undefined ? keyword("否则") : none;
		}
		reader.index--;
		if (!reader.expression(99)) return reader.position ?? value;
		if (reader.text() === "=") { reader.index++; return expression(inline ? ["否则"] : []); }
		return reader.text() === undefined ? { ...keyword("=", ...(inline ? ["否则"] : [])),
			assignmentTarget: { start: tokens[start]!.start, end: tokens[reader.index - 1]!.end } } : none;
	};
	if (head === "如果" || head === "否则如果") {
		reader.index++;
		if (!reader.expression()) return result(reader.position ?? value);
		if (reader.text() === undefined) return result(reader.operators(0, ["则"]));
		if (!expect("则")) return result(none);
		if (reader.text() === undefined) return result({ slot: "statement", keywords: execution.static ? ["退出", "触发事件"] : ["退出", "触发事件", "本对象"] });
		// 单行如果的两个分支使用同一条语句解析路径。
		const position = statement(true);
		if (reader.text() === "否则") { reader.index++; return result(reader.text() === undefined ? { slot: "statement", keywords: execution.static ? ["退出", "触发事件"] : ["退出", "触发事件", "本对象"] } : statement()); }
		return result(position);
	}
	if (head === "循环") {
		reader.index++;
		const each = reader.text() === "每个";
		if (each) reader.index++;
		if (reader.text() === undefined) return result({ slot: "loopVariable", keywords: each ? [] : ["每个"] });
		reader.index++;
		if (!expect(each ? "从" : "=")) return result(reader.position!);
		if (each) return result(expression());
		if (!reader.expression()) return result(reader.position ?? value);
		if (reader.text() === undefined) return result(reader.operators(0, ["至"]));
		if (!expect("至")) return result(none);
		if (!reader.expression()) return result(reader.position ?? value);
		if (reader.text() === undefined) return result(reader.operators(0, ["步进"]));
		if (!expect("步进")) return result(none);
		return result(expression());
	}
	if (["判断", "判断循环", "直到"].includes(head ?? "")) { reader.index++; return result(expression()); }
	if (head === "分支") {
		reader.index++;
		if (reader.text() === "否则") return result(none);
		if (frame?.kind === "error") {
			let first = true;
			for (;;) {
				if (reader.text() === undefined || tokens.at(-1)?.text === ".") return result({ slot: "errorType", keywords: first ? ["否则"] : [] });
				reader.index = nameEnd(tokens, reader.index);
				if (reader.text() !== ",") return result(none);
				reader.index++; first = false;
			}
		}
		let first = true;
		for (;;) {
			if (reader.text() === undefined) return result({ slot: "value", keywords: first ? ["否则", "是"] : ["是"] });
			const comparison = reader.text() === "是";
			if (comparison) {
				reader.index++;
				if (reader.text() === undefined) return result(keyword("=", "<>", "<", "<=", ">", ">="));
				if (!["=", "<>", "<", "<=", ">", ">="].includes(reader.text()!)) return result(none);
				reader.index++;
			}
			if (!reader.expression()) return result(reader.position ?? value);
			if (reader.text() === undefined) return result(reader.operators(0, comparison ? [] : ["至"]));
			if (!comparison && reader.text() === "至") { reader.index++; if (!reader.expression()) return result(reader.position ?? value); }
			if (reader.text() !== ",") return result(reader.text() === undefined ? reader.operators() : none);
			reader.index++; first = false;
		}
	}
	if (head === "位于") return result(tokens.length === 1 ? keyword("错误") : none);
	if (["执行", "否则", "获取", "设置"].includes(head ?? "")) return result(none);
	if (head === "结束") {
		const names = { do: "执行", error: "错误", event: "事件", for: "循环", function: "函数", getter: "获取", if: "如果", property: "属性", procedure: "过程", select: "判断", setter: "设置", while: "判断循环" };
		return result(tokens.length === 1 && frame !== undefined && !["for", "do"].includes(frame.kind) ? keyword(names[frame.kind]) : none);
	}
	if (head === "下个") {
		const loop = syntax.blocksAt(tokens[0]!.start).at(-1);
		return result(tokens.length === 1 && loop?.kind === "for" ? { slot: "loopVariable" } : none);
	}
	return result(statement());
}

/** 编译器支持的普通表达式起始关键字，具体符号仍从当前清单加载。 */
export function simpleExpressionKeywords(context: SimpleCodeContext): readonly string[] {
	return languageFacts.contexts.expression.filter((name) => (!context.static || name !== "本对象")
		&& (!context.constant || ["真", "假", "取反"].includes(name)));
}
