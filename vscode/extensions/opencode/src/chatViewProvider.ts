/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import MarkdownIt from 'markdown-it';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import * as vscode from 'vscode';
import { ApiEvent, ApiMessage, ApiMessageInfo, ApiPart, ApiPermission, ApiQuestion, ApiSession, ApiSessionStatus, OpencodeClient, PromptPart } from './client';
import type { AgentOption, Attachment, HostMessage, ModelOption, ModelRef, PermissionView, QuestionView, SessionSummary, ViewMessage, ViewPart, WebviewMessage } from './protocol';
import { OpencodeServer, workspaceDirectory } from './server';

const modelStateKey = 'agentChat.model';
const agentStateKey = 'agentChat.agent';
const renderDelayMs = 50;
const maxOutputChars = 8_000;

interface StoredMessage {
	info: ApiMessageInfo;
	parts: Map<string, ApiPart>;
}

/**
 * The Agent Chat sidebar: a native chat UI backed by the opencode server's API.
 *
 * The extension host owns all state and talks to the server; the webview only renders
 * {@link HostMessage}s and reports user actions as {@link WebviewMessage}s.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {

	private view: vscode.WebviewView | undefined;
	private client: OpencodeClient | undefined;
	private connection: AbortController | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	private sessions: ApiSession[] = [];
	private activeSessionId: string | undefined;
	private readonly messages = new Map<string, StoredMessage>();
	private statuses: Record<string, ApiSessionStatus> = {};
	private permissions: ApiPermission[] = [];
	private questions: ApiQuestion[] = [];
	private models: ModelOption[] = [];
	private agents: AgentOption[] = [];
	private model: ModelRef | undefined;
	private defaultModel: ModelRef | undefined;
	private agent: string | undefined;

	private readonly pendingRenders = new Set<string>();
	private renderTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly markdown = new MarkdownIt({ html: false, linkify: true, breaks: false });

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly server: OpencodeServer,
		private readonly output: vscode.OutputChannel,
	) {
		this.model = context.globalState.get<ModelRef>(modelStateKey);
		this.agent = context.globalState.get<string>(agentStateKey);
		this.disposables.push(
			server.onDidRestart(() => this.reload()),
			vscode.workspace.onDidGrantWorkspaceTrust(() => this.reload()),
		);
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
		};
		view.webview.onDidReceiveMessage((message: WebviewMessage) => this.onMessage(message), undefined, this.disposables);
		view.onDidDispose(() => {
			this.view = undefined;
			this.disconnect();
		}, undefined, this.disposables);
		this.renderShell();
	}

	/** Reveals the view and adds a file or selection to the composer. */
	async attach(attachment: Attachment): Promise<void> {
		await vscode.commands.executeCommand('opencode.view.focus');
		this.post({ type: 'attach', attachment });
	}

	async newSession(): Promise<void> {
		this.activeSessionId = undefined;
		this.messages.clear();
		this.postState();
		this.post({ type: 'messages', messages: [] });
		this.postStatus();
		this.postRequests();
	}

	private reload(): void {
		this.disconnect();
		this.renderShell();
	}

	private renderShell(): void {
		if (!this.view) {
			return;
		}
		this.view.webview.html = vscode.workspace.isTrusted ? this.chatHtml(this.view.webview) : trustHtml();
	}

	// #region Webview messages

	private async onMessage(message: WebviewMessage): Promise<void> {
		try {
			switch (message.type) {
				case 'ready':
					await this.connect();
					break;
				case 'newSession':
					await this.newSession();
					break;
				case 'selectSession':
					await this.selectSession(message.id);
					break;
				case 'deleteSession':
					await this.deleteSession(message.id);
					break;
				case 'send':
					await this.send(message.text, message.attachments);
					break;
				case 'abort':
					if (this.activeSessionId) {
						await this.client?.abort(this.activeSessionId);
					}
					break;
				case 'setModel':
					this.model = message.model;
					await this.context.globalState.update(modelStateKey, message.model);
					break;
				case 'setAgent':
					this.agent = message.agent;
					await this.context.globalState.update(agentStateKey, message.agent);
					break;
				case 'permission':
					await this.client?.replyPermission(message.id, message.reply);
					break;
				case 'question':
					await this.client?.replyQuestion(message.id, message.answers);
					break;
				case 'questionReject':
					await this.client?.rejectQuestion(message.id);
					break;
				case 'openLink':
					await this.openLink(message.href);
					break;
				case 'openFile':
					await this.openFile(message.path, message.line);
					break;
				case 'openAdvanced':
					await vscode.commands.executeCommand('opencode.openInEditor');
					break;
				case 'manageTrust':
					await vscode.commands.executeCommand('workbench.trust.manage');
					break;
			}
		} catch (err) {
			this.notice(err);
		}
	}

	private async send(text: string, attachments: readonly Attachment[]): Promise<void> {
		const client = this.client;
		if (!client || (!text.trim() && !attachments.length)) {
			return;
		}
		let sessionId = this.activeSessionId;
		if (!sessionId) {
			const session = await client.createSession();
			this.upsertSession(session);
			sessionId = session.id;
			this.activeSessionId = sessionId;
			this.postState();
		}

		const parts: PromptPart[] = [{ type: 'text', text }];
		for (const attachment of attachments) {
			const range = attachment.startLine ? `?start=${attachment.startLine}&end=${attachment.endLine ?? attachment.startLine}` : '';
			parts.push({
				type: 'file',
				mime: 'text/plain',
				url: `${pathToFileURL(attachment.path).href}${range}`,
				filename: path.basename(attachment.path),
			});
		}
		await client.prompt(sessionId, { parts, model: this.model, agent: this.agent });
	}

	private async selectSession(id: string): Promise<void> {
		const client = this.client;
		if (!client) {
			return;
		}
		this.activeSessionId = id;
		this.messages.clear();
		const messages = await client.messages(id);
		if (this.activeSessionId !== id) {
			return; // Another session was selected while loading.
		}
		for (const message of messages) {
			this.storeMessage(message);
		}
		this.adoptSessionModel(messages);
		this.postState();
		this.post({ type: 'messages', sessionId: id, messages: this.viewMessages() });
		this.postStatus();
		this.postRequests();
	}

	private async deleteSession(id: string): Promise<void> {
		const session = this.sessions.find(s => s.id === id);
		const confirm = vscode.l10n.t('Delete');
		const choice = await vscode.window.showWarningMessage(
			vscode.l10n.t('Delete the chat "{0}"?', session?.title ?? id),
			{ modal: true, detail: vscode.l10n.t('The conversation will be removed permanently.') },
			confirm,
		);
		if (choice !== confirm) {
			return;
		}
		await this.client?.deleteSession(id);
		this.sessions = this.sessions.filter(s => s.id !== id);
		if (this.activeSessionId === id) {
			await this.newSession();
		} else {
			this.postState();
		}
	}

	private async openLink(href: string): Promise<void> {
		const uri = vscode.Uri.parse(href, false);
		if (uri.scheme === 'http' || uri.scheme === 'https' || uri.scheme === 'mailto') {
			await vscode.env.openExternal(uri);
			return;
		}
		// Anything else is treated as a file path, optionally with a `#L12` or `:12` line suffix.
		const match = /^(?<file>.*?)(?:#L(?<hash>\d+)|:(?<colon>\d+))?$/.exec(decodeURIComponent(href.replace(/^file:\/\//, '')));
		const file = match?.groups?.file ?? href;
		const line = Number(match?.groups?.hash ?? match?.groups?.colon) || undefined;
		await this.openFile(file, line);
	}

	private async openFile(file: string, line?: number): Promise<void> {
		const absolute = path.isAbsolute(file) ? file : path.join(workspaceDirectory(), file);
		const position = line ? new vscode.Position(line - 1, 0) : undefined;
		await vscode.window.showTextDocument(vscode.Uri.file(absolute), {
			preview: true,
			selection: position ? new vscode.Range(position, position) : undefined,
		});
	}

	// #endregion

	// #region Connection and server events

	private async connect(): Promise<void> {
		this.disconnect();
		const connection = new AbortController();
		this.connection = connection;
		try {
			const running = await this.server.get();
			if (connection.signal.aborted) {
				return;
			}
			const client = new OpencodeClient(running.url, running.authToken, workspaceDirectory());
			this.client = client;
			await this.loadCatalog(client);
			// The stream's connect callback performs the initial sync and resyncs after reconnects.
			void client.subscribe(event => this.onEvent(event), () => void this.sync(client), connection.signal);
		} catch (err) {
			this.output.appendLine(String(err));
			this.postState();
			this.notice(err);
		}
	}

	private disconnect(): void {
		this.connection?.abort();
		this.connection = undefined;
		this.client = undefined;
	}

	private async loadCatalog(client: OpencodeClient): Promise<void> {
		const [providers, config, agents] = await Promise.all([client.providers(), client.config().catch(() => ({ model: undefined })), client.agents()]);

		this.models = providers.providers.flatMap(provider => Object.values(provider.models)
			.filter(model => model.status !== 'deprecated')
			.map(model => ({ providerID: provider.id, providerName: provider.name, modelID: model.id, name: model.name })));

		// Without an explicit model, the server picks one: the configured model, then the most
		// recently used one, then the first provider's default. Mirror that for the "Auto" label.
		const isAvailable = (ref: ModelRef | undefined) => !!ref && this.models.some(m => m.providerID === ref.providerID && m.modelID === ref.modelID);
		if (!isAvailable(this.model)) {
			this.model = undefined;
		}
		const configured = config.model?.split('/');
		const fromConfig = configured && configured.length >= 2 ? { providerID: configured[0], modelID: configured.slice(1).join('/') } : undefined;
		const firstProvider = providers.providers[0];
		const fromDefaults = firstProvider && providers.default[firstProvider.id] ? { providerID: firstProvider.id, modelID: providers.default[firstProvider.id] } : undefined;
		this.defaultModel = [fromConfig, ...recentModels(), fromDefaults].find(isAvailable);

		this.agents = agents
			.filter(agent => agent.mode !== 'subagent' && !agent.hidden)
			.map(agent => ({ name: agent.name, description: agent.description }));
		if (!this.agent || !this.agents.some(a => a.name === this.agent)) {
			this.agent = this.agents.find(a => a.name === 'build')?.name ?? this.agents[0]?.name;
		}
	}

	/** Loads everything the event stream may have missed. */
	private async sync(client: OpencodeClient): Promise<void> {
		try {
			const [sessions, statuses, permissions, questions] = await Promise.all([
				client.listSessions(), client.sessionStatus(), client.permissions(), client.questions(),
			]);
			if (client !== this.client) {
				return;
			}
			const directory = workspaceDirectory();
			this.sessions = sessions.filter(s => !s.parentID && !s.time.archived && s.directory === directory);
			this.statuses = statuses;
			this.permissions = permissions;
			this.questions = questions;
			if (this.activeSessionId && this.sessions.some(s => s.id === this.activeSessionId)) {
				await this.selectSession(this.activeSessionId);
			} else {
				this.activeSessionId = undefined;
				const latest = [...this.sessions].sort((a, b) => b.time.updated - a.time.updated)[0];
				if (latest) {
					await this.selectSession(latest.id);
				} else {
					await this.newSession();
				}
			}
		} catch (err) {
			this.notice(err);
		}
	}

	private onEvent(event: ApiEvent): void {
		const props = event.properties;
		const sessionID = typeof props.sessionID === 'string' ? props.sessionID : undefined;
		switch (event.type) {
			case 'session.created':
			case 'session.updated': {
				const info = props.info as ApiSession;
				if (!info.parentID && info.directory === workspaceDirectory()) {
					this.upsertSession(info);
					this.postState();
				}
				break;
			}
			case 'session.deleted':
				this.sessions = this.sessions.filter(s => s.id !== sessionID);
				this.postState();
				break;
			case 'session.status':
				if (sessionID) {
					this.statuses[sessionID] = props.status as ApiSessionStatus;
					this.postStatus();
				}
				break;
			case 'session.idle':
				if (sessionID) {
					this.statuses[sessionID] = { type: 'idle' };
					this.postStatus();
				}
				break;
			case 'session.error':
				if (sessionID === this.activeSessionId && props.error) {
					const error = props.error as ApiMessageInfo['error'];
					if (error?.name !== 'MessageAbortedError') {
						this.notice(error?.data?.message ?? error?.name ?? 'Unknown error');
					}
				}
				break;
			case 'message.updated': {
				const info = props.info as ApiMessageInfo;
				if (info.sessionID === this.activeSessionId) {
					const stored = this.messages.get(info.id);
					if (stored) {
						stored.info = info;
					} else {
						this.messages.set(info.id, { info, parts: new Map() });
					}
					this.scheduleRender(info.id);
				}
				break;
			}
			case 'message.removed':
				if (sessionID && sessionID === this.activeSessionId && typeof props.messageID === 'string') {
					this.messages.delete(props.messageID);
					this.post({ type: 'removeMessage', sessionId: sessionID, messageId: props.messageID });
				}
				break;
			case 'message.part.updated': {
				const part = props.part as ApiPart;
				const stored = part.sessionID === this.activeSessionId ? this.messages.get(part.messageID) : undefined;
				if (stored) {
					stored.parts.set(part.id, part);
					this.scheduleRender(part.messageID);
				}
				break;
			}
			case 'message.part.delta': {
				const stored = sessionID === this.activeSessionId ? this.messages.get(props.messageID as string) : undefined;
				const part = stored?.parts.get(props.partID as string);
				if (stored && part && props.field === 'text') {
					part.text = (part.text ?? '') + String(props.delta);
					this.scheduleRender(stored.info.id);
				}
				break;
			}
			case 'message.part.removed': {
				const stored = sessionID === this.activeSessionId ? this.messages.get(props.messageID as string) : undefined;
				if (stored) {
					stored.parts.delete(props.partID as string);
					this.scheduleRender(stored.info.id);
				}
				break;
			}
			case 'permission.asked':
				this.permissions = [...this.permissions.filter(p => p.id !== props.id), props as unknown as ApiPermission];
				this.postRequests();
				break;
			case 'permission.replied':
				this.permissions = this.permissions.filter(p => p.id !== props.requestID);
				this.postRequests();
				break;
			case 'question.asked':
				this.questions = [...this.questions.filter(q => q.id !== props.id), props as unknown as ApiQuestion];
				this.postRequests();
				break;
			case 'question.replied':
			case 'question.rejected':
				this.questions = this.questions.filter(q => q.id !== props.requestID);
				this.postRequests();
				break;
		}
	}

	private storeMessage(message: ApiMessage): void {
		this.messages.set(message.info.id, { info: message.info, parts: new Map(message.parts.map(part => [part.id, part])) });
	}

	private upsertSession(session: ApiSession): void {
		this.sessions = [...this.sessions.filter(s => s.id !== session.id), session];
	}

	/** Continue an existing chat with the model it last used. */
	private adoptSessionModel(messages: ApiMessage[]): void {
		const lastUser = [...messages].reverse().find(m => m.info.role === 'user')?.info;
		const model = lastUser?.model;
		if (model && this.models.some(m => m.providerID === model.providerID && m.modelID === model.modelID)) {
			this.model = { providerID: model.providerID, modelID: model.modelID };
		}
		if (lastUser?.agent && this.agents.some(a => a.name === lastUser.agent)) {
			this.agent = lastUser.agent;
		}
	}

	// #endregion

	// #region Rendering

	private scheduleRender(messageId: string): void {
		this.pendingRenders.add(messageId);
		this.renderTimer ??= setTimeout(() => {
			this.renderTimer = undefined;
			const sessionId = this.activeSessionId;
			for (const id of this.pendingRenders) {
				const stored = this.messages.get(id);
				if (stored && sessionId) {
					this.post({ type: 'upsertMessage', sessionId, message: this.viewMessage(stored) });
				}
			}
			this.pendingRenders.clear();
		}, renderDelayMs);
	}

	private viewMessages(): ViewMessage[] {
		return [...this.messages.values()]
			.sort((a, b) => compareIds(a.info.id, b.info.id))
			.map(stored => this.viewMessage(stored));
	}

	private viewMessage(stored: StoredMessage): ViewMessage {
		const info = stored.info;
		const parts = [...stored.parts.values()]
			.sort((a, b) => compareIds(a.id, b.id))
			.map(part => this.viewPart(part))
			.filter((part): part is ViewPart => !!part);
		const error = info.error && info.error.name !== 'MessageAbortedError'
			? info.error.data?.message ?? info.error.name
			: undefined;
		const model = info.role === 'assistant' && info.modelID
			? this.models.find(m => m.providerID === info.providerID && m.modelID === info.modelID)?.name ?? info.modelID
			: undefined;
		return { id: info.id, role: info.role, parts, error, model };
	}

	private viewPart(part: ApiPart): ViewPart | undefined {
		switch (part.type) {
			case 'text':
				return part.synthetic || part.ignored || !part.text ? undefined : { kind: 'text', id: part.id, html: this.markdown.render(part.text) };
			case 'reasoning':
				return part.text?.trim() ? { kind: 'reasoning', id: part.id, html: this.markdown.render(part.text), done: !!part.time?.end } : undefined;
			case 'file': {
				const filePath = part.url?.startsWith('file:') ? vscode.Uri.parse(part.url.split('?')[0]).fsPath : undefined;
				const range = part.url?.includes('?start=') ? /start=(\d+)&end=(\d+)/.exec(part.url) : undefined;
				const name = (part.filename ?? (filePath ? path.basename(filePath) : 'file')) + (range ? `:${range[1]}-${range[2]}` : '');
				return { kind: 'file', id: part.id, name, path: filePath };
			}
			case 'tool':
				return this.toolPart(part);
			default:
				return undefined;
		}
	}

	private toolPart(part: ApiPart): ViewPart | undefined {
		const state = part.state;
		if (!state || part.tool === 'todoread') {
			return undefined;
		}
		const input = state.input ?? {};
		const metadata = state.metadata ?? {};
		const str = (value: unknown) => typeof value === 'string' && value ? value : undefined;
		const filePath = str(input.filePath) ?? str(input.path);
		const rel = filePath ? relativePath(filePath) : undefined;

		let title: string;
		let detail: string | undefined;
		switch (part.tool) {
			case 'bash':
				title = str(input.description) ?? vscode.l10n.t('Run command');
				detail = str(input.command);
				break;
			case 'read':
				title = vscode.l10n.t('Read {0}', rel ?? '');
				break;
			case 'edit':
				title = vscode.l10n.t('Edit {0}', rel ?? '');
				break;
			case 'write':
				title = vscode.l10n.t('Write {0}', rel ?? '');
				break;
			case 'apply_patch':
				title = state.title ?? vscode.l10n.t('Apply patch');
				break;
			case 'glob':
			case 'grep':
				title = vscode.l10n.t('Search {0}', str(input.pattern) ?? '');
				detail = rel;
				break;
			case 'webfetch':
				title = vscode.l10n.t('Fetch {0}', str(input.url) ?? '');
				break;
			case 'websearch':
				title = vscode.l10n.t('Search the web for {0}', str(input.query) ?? '');
				break;
			case 'task':
				title = vscode.l10n.t('Subagent: {0}', str(input.description) ?? '');
				break;
			case 'todowrite':
				title = vscode.l10n.t('Update plan');
				break;
			default:
				title = state.title ?? part.tool ?? vscode.l10n.t('Tool');
		}

		const diff = str(metadata.diff);
		const filediff = metadata.filediff as { additions?: number; deletions?: number } | undefined;
		const rawOutput = str(metadata.output) ?? state.output;
		const output = part.tool === 'read' || part.tool === 'edit' || part.tool === 'write' ? undefined : truncate(rawOutput);
		return {
			kind: 'tool',
			id: part.id,
			tool: part.tool ?? 'tool',
			status: state.status,
			title,
			filePath: rel,
			detail,
			output,
			error: state.status === 'error' ? state.error : undefined,
			diff,
			additions: filediff?.additions,
			deletions: filediff?.deletions,
		};
	}

	private permissionView(permission: ApiPermission): PermissionView {
		const metadata = permission.metadata ?? {};
		const targets = permission.patterns.join(', ');
		switch (permission.permission) {
			case 'bash':
				return { id: permission.id, sessionID: permission.sessionID, title: vscode.l10n.t('Run this command?'), detail: String(metadata.command ?? targets) };
			case 'edit':
				return { id: permission.id, sessionID: permission.sessionID, title: vscode.l10n.t('Edit {0}?', targets), diff: typeof metadata.diff === 'string' ? metadata.diff : undefined };
			case 'external_directory':
				return { id: permission.id, sessionID: permission.sessionID, title: vscode.l10n.t('Access files outside the workspace?'), detail: targets };
			case 'webfetch':
				return { id: permission.id, sessionID: permission.sessionID, title: vscode.l10n.t('Fetch a web page?'), detail: String(metadata.url ?? targets) };
			default:
				return { id: permission.id, sessionID: permission.sessionID, title: vscode.l10n.t('Allow {0}?', permission.permission), detail: targets || undefined };
		}
	}

	private questionView(question: ApiQuestion): QuestionView {
		return {
			id: question.id,
			sessionID: question.sessionID,
			questions: question.questions.map(q => ({
				header: q.header,
				question: q.question,
				options: q.options,
				multiple: !!q.multiple,
				custom: q.custom !== false,
			})),
		};
	}

	// #endregion

	// #region Posting to the webview

	private postState(): void {
		this.post({
			type: 'state',
			sessions: this.sessions
				.map((s): SessionSummary => ({ id: s.id, title: s.title, updated: s.time.updated }))
				.sort((a, b) => b.updated - a.updated),
			activeSessionId: this.activeSessionId,
			models: this.models,
			agents: this.agents,
			model: this.model,
			defaultModelName: this.defaultModel && this.models.find(m => m.providerID === this.defaultModel!.providerID && m.modelID === this.defaultModel!.modelID)?.name,
			agent: this.agent,
			connected: !!this.client,
		});
	}

	private postStatus(): void {
		const status = this.activeSessionId ? this.statuses[this.activeSessionId] : undefined;
		this.post({
			type: 'status',
			busy: status?.type === 'busy' || status?.type === 'retry',
			retry: status?.type === 'retry' ? status.message : undefined,
		});
	}

	private postRequests(): void {
		const active = this.activeSessionId;
		this.post({
			type: 'requests',
			permissions: this.permissions.filter(p => p.sessionID === active).map(p => this.permissionView(p)),
			questions: this.questions.filter(q => q.sessionID === active).map(q => this.questionView(q)),
		});
	}

	private notice(err: unknown): void {
		this.post({ type: 'notice', text: err instanceof Error ? err.message : String(err) });
	}

	private post(message: HostMessage): void {
		void this.view?.webview.postMessage(message);
	}

	// #endregion

	private chatHtml(webview: vscode.Webview): string {
		const nonce = crypto.randomBytes(16).toString('base64');
		const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file));
		return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; font-src data:; script-src 'nonce-${nonce}';">
	<link rel="stylesheet" href="${media('codicon.css')}">
	<link rel="stylesheet" href="${media('chat.css')}">
</head>
<body>
	<div id="app"></div>
	<script type="module" nonce="${nonce}" src="${media('chat.js')}"></script>
</body>
</html>`;
	}

	dispose(): void {
		this.disconnect();
		if (this.renderTimer) {
			clearTimeout(this.renderTimer);
		}
		vscode.Disposable.from(...this.disposables).dispose();
	}
}

/** opencode ids (`msg_…`, `prt_…`) sort chronologically as strings. */
function compareIds(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Models opencode's TUI and web UI recently used, most recent first (opencode's `model.json`). */
function recentModels(): ModelRef[] {
	try {
		const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
		const state = JSON.parse(fs.readFileSync(path.join(stateHome, 'opencode', 'model.json'), 'utf8')) as { recent?: unknown };
		return Array.isArray(state.recent)
			? state.recent.filter((m): m is ModelRef => typeof m?.providerID === 'string' && typeof m?.modelID === 'string')
			: [];
	} catch {
		return [];
	}
}

function relativePath(file: string): string {
	if (!path.isAbsolute(file)) {
		return file;
	}
	const relative = path.relative(workspaceDirectory(), file);
	return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file;
}

function truncate(text: string | undefined): string | undefined {
	if (!text) {
		return undefined;
	}
	return text.length > maxOutputChars ? `${text.slice(0, maxOutputChars)}\n…` : text;
}

export function trustHtml(): string {
	const nonce = crypto.randomBytes(16).toString('base64');
	return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<style>
		body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 16px 12px; }
		h2 { font-size: 1.1em; margin: 0 0 8px; }
		p { color: var(--vscode-descriptionForeground); line-height: 1.5; margin: 0 0 14px; }
		button { font: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; border-radius: 2px; padding: 6px 14px; cursor: pointer; width: 100%; }
		button:hover { background: var(--vscode-button-hoverBackground); }
	</style>
</head>
<body>
	<h2>${vscode.l10n.t('Agent Chat needs a trusted folder')}</h2>
	<p>${vscode.l10n.t('This folder is open in Restricted Mode. Agent Chat can run commands and edit files, so it only starts once you trust the folder\'s authors.')}</p>
	<button id="trust">${vscode.l10n.t('Trust Folder')}</button>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		document.getElementById('trust').addEventListener('click', () => vscode.postMessage({ type: 'manageTrust' }));
	</script>
</body>
</html>`;
}
