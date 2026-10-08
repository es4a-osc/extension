const { defineConfig } = require("@vscode/test-cli");

module.exports = defineConfig({
	files: "out/test/suite/**/*.test.js",
	workspaceFolder: "../simple/samples/Tetris",
	mocha: {
		timeout: 20000,
		ui: "tdd"
	}
});
