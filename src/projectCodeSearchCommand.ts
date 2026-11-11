/*
使用 VS Code 原生快速选择器呈现项目或源码文件夹范围内的用户代码搜索结果。
xhwsd@qq.com 2026-9-1
*/

import * as path from "node:path";
import * as vscode from "vscode";
import { filePathKey, mostSpecificSourceRoot } from "./simpleProjectPaths";
import {
	findProjectCodeMatches,
	loadProjectCodeDocuments,
	type ProjectCodeDocument,
	type ProjectCodeMatch
} from "./projectCodeSearch";
import { isUnitFolderNode, isUnitsNode, type ProgramTreeNode } from "./programTree";
import {
	SIMPLE_CODE_SCHEME,
	toSimpleCodeUri,
	toSimpleSourceUri
} from "./simpleCodeFileSystem";

/** 快速选择项保留跳转所需的真实文件和用户代码位置。 */
interface ProjectCodeSearchQuickPickItem extends vscode.QuickPickItem {
	readonly match: ProjectCodeMatch;
}

/** 已确认可搜索的项目树范围。 */
interface ProjectCodeSearchScope {
	readonly label: string;
	readonly roots: readonly string[];
	readonly excludedDirectories: readonly string[];
}

/** 从项目树节点建立代码搜索范围，不允许资源目录或具体单元混入。 */
function searchScope(node: ProgramTreeNode | undefined): ProjectCodeSearchScope {
	if (isUnitsNode(node)) {
		return {
			excludedDirectories: [node.project.buildDirectory],
			label: node.project.name,
			roots: node.project.sourceDirectories
		};
	}
	if (isUnitFolderNode(node)) {
		return {
			excludedDirectories: node.project === undefined ? [] : [node.project.buildDirectory],
			label: node.label,
			roots: [node.directoryPath]
		};
	}
	throw new Error("请在“单元”或单元文件夹上执行“搜索代码”。");
}

/** 返回文件相对于最具体搜索根目录的显示路径。 */
function relativeSearchPath(filePath: string, roots: readonly string[]): string {
	const root = mostSpecificSourceRoot(roots, filePath);
	return root === undefined ? filePath : `.${path.sep}${path.relative(root, filePath)}`;
}

/** 收集当前已打开单元尚未保存的用户代码，以真实 `.simple` 路径建立快照。 */
function openUserCodeSnapshots(): ReadonlyMap<string, string> {
	const snapshots = new Map<string, string>();
	for (const document of vscode.workspace.textDocuments) {
		if (document.uri.scheme !== SIMPLE_CODE_SCHEME) {
			continue;
		}
		const sourceUri = toSimpleSourceUri(document.uri);
		if (sourceUri !== undefined) {
			snapshots.set(filePathKey(sourceUri.fsPath), document.getText());
		}
	}
	return snapshots;
}

/** 把纯搜索结果转换为带实际相对路径和代码行号的原生快速选择项。 */
function searchItem(match: ProjectCodeMatch, roots: readonly string[]): ProjectCodeSearchQuickPickItem {
	const unitName = path.basename(match.filePath, path.extname(match.filePath));
	return {
		alwaysShow: true,
		description: `${unitName} · 第 ${match.lineNumber + 1} 行`,
		detail: relativeSearchPath(match.filePath, roots),
		label: match.lineText.trim(),
		match
	};
}

/** 打开命中单元的用户代码文档，并选中匹配文本。 */
async function openSearchMatch(match: ProjectCodeMatch): Promise<void> {
	const document = await vscode.workspace.openTextDocument(toSimpleCodeUri(vscode.Uri.file(match.filePath)));
	if (match.lineNumber >= document.lineCount || document.lineAt(match.lineNumber).text !== match.lineText) {
		void vscode.window.showInformationMessage("搜索结果所在代码行已变化，请重新搜索。");
		return;
	}
	const start = new vscode.Position(match.lineNumber, match.startCharacter);
	const end = new vscode.Position(match.lineNumber, match.endCharacter);
	await vscode.window.showTextDocument(document, { preview: true, selection: new vscode.Range(start, end) });
}

/** 打开限定到项目或源码文件夹的用户代码搜索选择器。 */
export async function showProjectCodeSearch(node: ProgramTreeNode | undefined): Promise<void> {
	const scope = searchScope(node);
	const picker = vscode.window.createQuickPick<ProjectCodeSearchQuickPickItem>();
	const cancellation = new vscode.CancellationTokenSource();
	const token = cancellation.token;
	const snapshots = openUserCodeSnapshots();
	const baseTitle = `搜索代码 — ${scope.label}`;
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;
	let refreshVersion = 0;
	let documents: readonly ProjectCodeDocument[] | undefined;
	let acceptedMatch: ProjectCodeMatch | undefined;

	picker.busy = true;
	picker.ignoreFocusOut = false;
	picker.matchOnDescription = true;
	picker.matchOnDetail = true;
	picker.placeholder = "输入要搜索的用户代码";
	picker.title = baseTitle;

	const fail = (error: unknown): void => {
		if (token.isCancellationRequested) return;
		picker.hide();
		void vscode.window.showErrorMessage(`搜索代码失败：${error instanceof Error ? error.message : String(error)}`);
	};

	const refresh = (): void => {
		const query = picker.value;
		const version = ++refreshVersion;
		if (refreshTimer !== undefined) {
			clearTimeout(refreshTimer);
			refreshTimer = undefined;
		}
		picker.items = [];
		picker.title = baseTitle;
		const loaded = documents;
		picker.busy = loaded === undefined || query.trim().length !== 0;
		if (loaded === undefined || !picker.busy) return;
		const cancelled = (): boolean => version !== refreshVersion || token.isCancellationRequested;
		refreshTimer = setTimeout(() => {
			refreshTimer = undefined;
			void findProjectCodeMatches(loaded, query, undefined, cancelled).then((result) => {
				if (result === undefined || cancelled()) return;
				picker.items = result.matches.map((match) => searchItem(match, scope.roots));
				picker.title = `${baseTitle} · ${result.matches.length}${result.limitHit ? "+" : ""} 条`;
				picker.busy = false;
			}, (error: unknown) => {
				if (!cancelled()) fail(error);
			});
		}, 100);
	};

	await new Promise<void>((resolve) => {
		const valueDisposable = picker.onDidChangeValue(refresh);
		const acceptDisposable = picker.onDidAccept(() => {
			const selected = picker.activeItems[0];
			if (!picker.busy && selected !== undefined && picker.items.includes(selected)) {
				acceptedMatch = selected.match;
				picker.hide();
			}
		});
		const hideDisposable = picker.onDidHide(() => {
			cancellation.cancel();
			if (refreshTimer !== undefined) {
				clearTimeout(refreshTimer);
			}
			valueDisposable.dispose();
			acceptDisposable.dispose();
			hideDisposable.dispose();
			picker.dispose();
			cancellation.dispose();
			resolve();
		});

		picker.show();
		void loadProjectCodeDocuments(
			scope.roots,
			(filePath) => snapshots.get(filePathKey(filePath)),
			() => token.isCancellationRequested,
			scope.excludedDirectories
		).then((loadedDocuments) => {
			if (token.isCancellationRequested) {
				return;
			}
			documents = loadedDocuments;
			refresh();
		}, fail);
	});

	if (acceptedMatch !== undefined) {
		await openSearchMatch(acceptedMatch);
	}
}
