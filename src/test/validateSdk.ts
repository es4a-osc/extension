/*
只读验证明确传入的真实 SDK 入口和附加类库，报告全量消费覆盖数量。
xhwsd@qq.com 2026-10-14
*/

import { loadCompatibilitySdk, validateSdkCompatibility } from "./sdkCompatibility";

async function main(): Promise<void> {
	const [entry, ...libraries] = process.argv.slice(2);
	if (entry === undefined) throw new Error("用法：npm run test:sdk -- SDK入口.json [类库清单.json ...]");
	console.log(await validateSdkCompatibility(await loadCompatibilitySdk(entry, libraries)));
}

void main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
