/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { ChatViewProvider, trustHtml } from './chatViewProvider';
import { OpencodeServer, workspaceDirectory } from './server';

const viewType = 'opencode.view';
const advancedPanelType = 'opencode.panel';

export function activate(context: vscode.ExtensionContext) {
	const output = vscode.window.createOutputChannel('Agent Chat');
	const server = new OpencodeServer(context.extensionPath, output);
	const chat = new ChatViewProvider(context, server, output);

	context.subscriptions.push(
		output,
		server,
		chat,
		vscode.window.registerWebviewViewProvider(viewType, chat, { webviewOptions: { retainContextWhenHidden: true } }),

		vscode.commands.registerCommand('opencode.newSession', () => chat.newSession()),
		vscode.commands.registerCommand('opencode.restart', () => server.restart()),
		vscode.commands.registerCommand('opencode.openInEditor', () => openAdvancedView(server, output)),

		vscode.commands.registerTextEditorCommand('opencode.addSelection', editor => {
			const file = editor.document.uri;
			if (file.scheme !== 'file') {
				return;
			}
			const selection = editor.selection;
			const startLine = selection.start.line + 1;
			// A selection ending at column 0 of the next line doesn't include that line.
			const endLine = selection.end.character === 0 && selection.end.line > selection.start.line ? selection.end.line : selection.end.line + 1;
			const name = path.basename(file.fsPath);
			return chat.attach(selection.isEmpty
				? { path: file.fsPath, label: name }
				: { path: file.fsPath, label: `${name}:${startLine}-${endLine}`, startLine, endLine });
		}),

		vscode.commands.registerCommand('opencode.addFile', (uri?: vscode.Uri) => {
			const file = uri ?? vscode.window.activeTextEditor?.document.uri;
			if (file?.scheme === 'file') {
				return chat.attach({ path: file.fsPath, label: path.basename(file.fsPath) });
			}
			return undefined;
		}),
	);
}

export function deactivate() { }

/**
 * Opens opencode's own web UI in an editor tab, for settings and provider sign-in that
 * Agent Chat does not offer itself.
 */
function openAdvancedView(server: OpencodeServer, output: vscode.OutputChannel): void {
	const panel = vscode.window.createWebviewPanel(advancedPanelType, vscode.l10n.t('Agent Chat: Advanced'), vscode.ViewColumn.Active, {
		// The embedded page inherits this webview's sandbox, so scripts must be enabled.
		enableScripts: true,
		retainContextWhenHidden: true,
	});
	const disposables: vscode.Disposable[] = [];

	const render = async () => {
		if (!vscode.workspace.isTrusted) {
			panel.webview.html = trustHtml();
			return;
		}
		panel.webview.html = messageHtml(vscode.l10n.t('Starting Agent Chat…'));
		try {
			const running = await server.get();
			const external = await vscode.env.asExternalUri(vscode.Uri.parse(running.url));
			const origin = external.toString(true).replace(/\/$/, '');
			const route = vscode.workspace.workspaceFolders?.length ? `/${base64UrlEncode(workspaceDirectory())}/session` : '/';
			panel.webview.html = iframeHtml(origin, `${origin}${route}?auth_token=${encodeURIComponent(running.authToken)}&color_scheme=${colorScheme()}`);
		} catch (err) {
			output.appendLine(String(err));
			panel.webview.html = messageHtml(err instanceof Error ? err.message : String(err));
		}
	};

	let renderedScheme = colorScheme();
	disposables.push(
		panel.webview.onDidReceiveMessage((message: { type?: string }) => {
			if (message.type === 'manageTrust') {
				void vscode.commands.executeCommand('workbench.trust.manage');
			}
		}),
		server.onDidRestart(render),
		vscode.workspace.onDidGrantWorkspaceTrust(render),
		vscode.window.onDidChangeActiveColorTheme(() => {
			// Reload only on a light/dark switch; sessions live on the server.
			if (colorScheme() !== renderedScheme) {
				renderedScheme = colorScheme();
				void render();
			}
		}),
	);
	panel.onDidDispose(() => vscode.Disposable.from(...disposables).dispose());
	void render();
}

/** The opencode web UI supports light and dark; high contrast themes map to the closest one. */
function colorScheme(): 'light' | 'dark' {
	const kind = vscode.window.activeColorTheme.kind;
	return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight ? 'light' : 'dark';
}

/** Matches `base64Encode` in opencode core, which the web UI uses for directory routes. */
function base64UrlEncode(value: string): string {
	return Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function iframeHtml(origin: string, src: string): string {
	return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${escapeHtml(origin)}; style-src 'unsafe-inline';">
	<style>
		html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
		iframe { border: 0; width: 100%; height: 100%; display: block; }
	</style>
</head>
<body>
	<iframe src="${escapeHtml(src)}" allow="clipboard-read; clipboard-write"></iframe>
</body>
</html>`;
}

function messageHtml(message: string): string {
	return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
	<style>body { font-family: var(--vscode-font-family); color: var(--vscode-descriptionForeground); padding: 12px; }</style>
</head>
<body>${escapeHtml(message)}</body>
</html>`;
}
