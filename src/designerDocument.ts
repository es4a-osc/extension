/*
维护窗口设计器的独立 CustomDocument 生命周期，并关联同一单元的用户代码文档。
xhwsd@qq.com 2026-9-9
*/

import * as vscode from "vscode";

/**
 * 设计器标签自己的文档身份。
 *
 * 设计器修改状态由 VS Code 的 CustomDocument 管理；XML 真值仍保存在共享单元会话中，
 * 这里不复制组件树或属性模型。
 */
export class SimpleDesignerDocument implements vscode.CustomDocument {
	private disposed = false;
	private readonly codeDocumentUri: vscode.Uri;

	constructor(
		readonly uri: vscode.Uri,
		private codeDocument: vscode.TextDocument,
		private readonly sessionReference: vscode.Disposable
	) {
		this.codeDocumentUri = codeDocument.uri;
	}

	/** 返回当前关联实例，供不需要重新打开文档的只读投影使用。 */
	get currentCodeDocument(): vscode.TextDocument {
		return this.codeDocument;
	}

	/** 返回同一单元当前可用的用户代码文档；关闭后按原 URI 重新取得而不显示标签页。 */
	async getCodeDocument(): Promise<vscode.TextDocument> {
		if (this.codeDocument.isClosed) {
			this.codeDocument = await vscode.workspace.openTextDocument(this.codeDocumentUri);
		}
		return this.codeDocument;
	}

	/** 文档变化通知携带的新实例仍属于同一单元时，更新设计器读取入口。 */
	observeCodeDocument(document: vscode.TextDocument): void {
		if (document.uri.toString() === this.codeDocumentUri.toString()) {
			this.codeDocument = document;
		}
	}

	/** 最后一个设计器标签关闭时释放共享单元会话引用。 */
	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.sessionReference.dispose();
	}
}
