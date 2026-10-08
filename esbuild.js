const esbuild = require("esbuild");
const fs = require("node:fs/promises");
const path = require("node:path");
const { compileScript, parse } = require("@vue/compiler-sfc");

const isWatch = process.argv.includes("--watch");

const vuePlugin = {
	name: "vue-sfc",
	setup(build) {
		build.onLoad({ filter: /\.vue$/ }, async (args) => {
			const source = await fs.readFile(args.path, "utf8");
			const { descriptor, errors } = parse(source, { filename: args.path });
			if (errors.length > 0) throw errors[0];
			const id = Buffer.from(path.relative(process.cwd(), args.path)).toString("hex");
			const script = compileScript(descriptor, { id, inlineTemplate: true });
			return {
				contents: script.content,
				loader: script.lang === "js" ? "js" : "ts",
				resolveDir: path.dirname(args.path)
			};
		});
	}
};

const extensionBuildOptions = {
	bundle: true,
	entryPoints: ["src/main.ts"],
	external: ["vscode"],
	format: "cjs",
	logLevel: "info",
	mainFields: ["module", "main"],
	minify: false,
	outfile: "dist/extension.js",
	platform: "node",
	sourcemap: true,
	target: "node22"
};

const designerBuildOptions = {
	assetNames: "[name]",
	bundle: true,
	entryNames: "[name]",
	entryPoints: [
		"src/designer/designerClient.ts",
		"src/designer/designer.css",
		"src/designer/designer.html"
	],
	loader: { ".html": "copy", ".ttf": "file" },
	define: {
		__VUE_OPTIONS_API__: "false",
		__VUE_PROD_DEVTOOLS__: "false",
		__VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false"
	},
	logLevel: "info",
	outbase: "src/designer",
	outdir: "dist/designer",
	platform: "browser",
	plugins: [vuePlugin],
	sourcemap: true,
	target: "es2023"
};

async function main() {
	if (isWatch) {
		const contexts = await Promise.all([
			esbuild.context(extensionBuildOptions),
			esbuild.context(designerBuildOptions)
		]);
		await Promise.all(contexts.map((context) => context.watch()));
		return;
	}

	await Promise.all([
		esbuild.build(extensionBuildOptions),
		esbuild.build(designerBuildOptions)
	]);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
