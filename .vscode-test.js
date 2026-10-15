const { defineConfig } = require("@vscode/test-cli");
const path = require("node:path");

module.exports = defineConfig({
	files: "out/test/suite/**/*.test.js",
	workspaceFolder: "src/test/fixtures/simple/samples/Tetris",
	// 仅测试宿主启用随机本地调试端口，用于自动验证原生输入及预览界面。
	launchArgs: ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"],
	env: { ES4A_TEST_USER_DATA: path.join(__dirname, ".vscode-test/user-data") },
	mocha: {
		timeout: 20000,
		ui: "tdd"
	}
});
