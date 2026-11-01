/*
从扩展集中语言事实生成 TextMate 词表，并可对照指定的 Simple 编译器源码校验。
xhwsd@qq.com 2026-10-31
*/

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const readFacts = () => JSON.parse(fs.readFileSync(path.resolve(__dirname, "../src/simpleLanguageFacts.json"), "utf8"));

/** 关键字在任何扩展模块中的拼写都以同一份语言事实为来源。 */
function generateGrammar(grammar) {
	const facts = readFacts();
	const result = structuredClone(grammar);
	const words = Object.values(facts.words);
	const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const tokenNames = (ids) => ids.map((id) => escape(facts.words[id].text)).join("|");
	const pattern = (role, property = false) => words.filter((word) => word.role === role && word.text.startsWith("$") === property)
		.map((word) => word.text).sort((left, right) => right.length - left.length).map(escape).join("|");
	const boundary = (values) => `(?<![\\p{L}\\p{Nl}\\p{Sc}\\p{Pc}\\p{Nd}\\p{Mn}\\p{Mc}\\p{Cf}.])(?:${values})(?![\\p{L}\\p{Nl}\\p{Sc}\\p{Pc}\\p{Nd}\\p{Mn}\\p{Mc}\\p{Cf}])`;
	const set = (group, scope, values) => {
		const rule = result.repository[group].patterns.find((entry) => entry.name === scope);
		assert.ok(rule, `缺少 TextMate 规则 ${group}/${scope}`);
		rule.match = group === "operators" && scope === "keyword.operator.symbol.simple" ? values : boundary(values);
	};
	set("keywords", "storage.type.declaration.simple", words.filter((word) => word.role === "simpleDeclaration" && word !== facts.words.TOK_GET && word !== facts.words.TOK_SET).map((word) => escape(word.text)).join("|"));
	set("keywords", "keyword.control.simple", pattern("simpleControl"));
	set("keywords", "storage.modifier.simple", pattern("simpleModifier"));
	set("keywords", "keyword.other.expression.simple", pattern("keyword"));
	set("types", "storage.type.simple", pattern("type"));
	set("literals", "constant.language.boolean.simple", words.filter((word) => word.role === "enumMember" && word.text !== facts.words.TOK_NOTHING.text).map((word) => escape(word.text)).join("|"));
	result.repository.literals.patterns = result.repository.literals.patterns.filter((rule) => rule.name !== "constant.language.null.simple");
	result.repository.literals.patterns.push({ match: boundary(escape(facts.words.TOK_NOTHING.text)), name: "constant.language.null.simple" });
	set("operators", "keyword.operator.word.simple", pattern("operator"));
	set("operators", "keyword.operator.symbol.simple", facts.operators.map(escape).join("|"));
	set("property-section", "keyword.other.property-section.simple", pattern("keyword", true));
	set("property-section", "storage.type.property-section.simple", pattern("type", true));
	/* 声明捕获和访问器也从同一词表取名，语法文件不独立维护关键字拼写。 */
	const identifier = "[\\p{L}][\\p{L}\\p{N}_]*";
	result.repository.declarations.patterns[0].match = `(?<![\\p{L}\\p{N}_])(${tokenNames(["TOK_FUNCTION", "TOK_SUB", "TOK_EVENT", "TOK_PROPERTY"])})\\s+(${identifier}(?:\\.${identifier})?)`;
	result.repository.declarations.patterns[1].match = `(?<![\\p{L}\\p{N}_])(${tokenNames(["TOK_CONST", "TOK_DIM"])})\\s+(${identifier})`;
	result.repository.keywords.patterns.find((rule) => rule.captures).match = `^\\s*(${tokenNames(["TOK_GET", "TOK_SET"])})(?=\\s*(?:'|$))`;
	return result;
}

/** 对照当前 TokenKind 和 Keywords 核对完整词表，不依赖已安装 SDK 或相邻仓库约定。 */
function verifyCompiler(directory) {
	const facts = readFacts();
	const tokens = fs.readFileSync(path.join(directory, "scanner/TokenKind.java"), "utf8");
	const keywords = fs.readFileSync(path.join(directory, "scanner/Keywords.java"), "utf8");
	const spellings = new Map([...tokens.matchAll(/\b(TOK_[A-Z_$]+)\("([^"\r\n]*)"\)/g)].map((match) => [match[1], JSON.parse('"' + match[2] + '"')]));
	const registered = [...keywords.matchAll(/enterKeyword\(TokenKind\.(TOK_[A-Z_$]+)\)/g)].map((match) => match[1]).sort();
	assert.deepEqual(Object.keys(facts.words).sort(), registered, "扩展词表与编译器已注册关键字不一致");
	for (const [token, word] of Object.entries(facts.words)) {
		assert.equal(word.text, spellings.get(token), `${token} 的拼写与编译器不一致`);
	}
	const symbols = [...spellings.values()].filter((text) => /^[+\-*/%\\^&=<>]+$/.test(text));
	assert.deepEqual([...facts.operators].sort(), symbols.sort(), "符号运算符与编译器不一致");
	for (const values of Object.values(facts.contexts)) {
		for (const value of values) {
			assert.ok(Object.values(facts.words).some((word) => word.text === value), `未知语境关键字 ${value}`);
		}
	}
}

/** 只在内容变化时写出，监视构建不会无意义地触碰语法文件。 */
function writeGrammar(check = false) {
	const file = path.resolve(__dirname, "../syntaxes/simple.tmLanguage.json");
	const current = fs.readFileSync(file, "utf8");
	const expected = JSON.stringify(generateGrammar(JSON.parse(current)), null, "\t").replace(/\n/g, "\r\n") + "\r\n";
	if (check) {
		assert.ok(current === expected, "请运行 npm run generate-syntax 同步基础语法规则");
	} else if (current !== expected) {
		fs.writeFileSync(file, expected);
	}
}

if (require.main === module) {
	const compilerIndex = process.argv.indexOf("--compiler-source");
	if (compilerIndex >= 0) {
		const directory = process.argv[compilerIndex + 1];
		assert.ok(directory, "--compiler-source 需要 Simple 编译器源码目录");
		verifyCompiler(path.resolve(directory));
	}
	writeGrammar(process.argv.includes("--check"));
}

module.exports = { generateGrammar, verifyCompiler, writeGrammar };
