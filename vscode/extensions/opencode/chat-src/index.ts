/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Agent Chat webview. It renders state pushed by the extension host (see ../src/protocol.ts)
// and reports user actions back; it never talks to the opencode server directly.
// Message HTML is produced by the host with markdown-it (raw HTML disabled), so it is safe to insert.

/// <reference types="vscode-webview" />

import type { AgentOption, Attachment, HostMessage, ModelOption, ModelRef, PermissionView, QuestionView, SessionSummary, ViewMessage, ViewPart, WebviewMessage } from '../src/protocol';

const vscode = acquireVsCodeApi();

function post(message: WebviewMessage): void {
	vscode.postMessage(message);
}

// #region State

let sessions: readonly SessionSummary[] = [];
let activeSessionId: string | undefined;
let models: readonly ModelOption[] = [];
let agents: readonly AgentOption[] = [];
let model: ModelRef | undefined;
let defaultModelName: string | undefined;
let agent: string | undefined;
let connected = false;
let busy = false;
let retry: string | undefined;
let attachments: Attachment[] = [];
let permissions: readonly PermissionView[] = [];
let questions: readonly QuestionView[] = [];
const messages = new Map<string, ViewMessage>();
/** Tool and reasoning sections the user expanded, kept open across re-renders. */
const expanded = new Set<string>();
/** Selected answers per question request, indexed by question. */
const questionAnswers = new Map<string, Set<string>[]>();

// #endregion

// #region DOM helpers

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: { className?: string; text?: string; title?: string; attrs?: Record<string, string> } = {}, ...children: (Node | string | undefined | false)[]): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag);
	if (props.className) {
		element.className = props.className;
	}
	if (props.text !== undefined) {
		element.textContent = props.text;
	}
	if (props.title) {
		element.title = props.title;
	}
	for (const [name, value] of Object.entries(props.attrs ?? {})) {
		element.setAttribute(name, value);
	}
	for (const child of children) {
		if (child) {
			element.append(child);
		}
	}
	return element;
}

function icon(name: string): HTMLElement {
	return h('span', { className: `codicon codicon-${name}`, attrs: { 'aria-hidden': 'true' } });
}

function iconButton(name: string, label: string, onClick: () => void, className = ''): HTMLButtonElement {
	const button = h('button', { className: `icon-button ${className}`, title: label, attrs: { 'aria-label': label, type: 'button' } }, icon(name));
	button.addEventListener('click', onClick);
	return button;
}

function html(className: string, markup: string): HTMLElement {
	const element = h('div', { className });
	element.innerHTML = markup;
	return element;
}

// #endregion

// #region Layout

const app = document.getElementById('app')!;

const sessionSelect = h('select', { className: 'session-select', attrs: { 'aria-label': 'Chat history' } });
sessionSelect.addEventListener('change', () => {
	if (sessionSelect.value) {
		post({ type: 'selectSession', id: sessionSelect.value });
	}
});
const deleteButton = iconButton('trash', 'Delete Chat', () => activeSessionId && post({ type: 'deleteSession', id: activeSessionId }));
const header = h('div', { className: 'header' },
	sessionSelect,
	iconButton('add', 'New Chat', () => post({ type: 'newSession' })),
	deleteButton,
);

const messageList = h('div', { className: 'messages', attrs: { role: 'log', 'aria-live': 'polite' } });
const noticeBar = h('div', { className: 'notice hidden', attrs: { role: 'alert' } });
const requestArea = h('div', { className: 'requests' });

const attachmentRow = h('div', { className: 'attachments' });
const input = h('textarea', { className: 'input', attrs: { rows: '1', placeholder: 'Ask Agent Chat to build, fix, or explain…', 'aria-label': 'Message' } });
const agentSelect = h('select', { className: 'picker', attrs: { 'aria-label': 'Agent' } });
const modelSelect = h('select', { className: 'picker model-picker', attrs: { 'aria-label': 'Model' } });
const stopButton = iconButton('debug-stop', 'Stop', () => post({ type: 'abort' }), 'stop hidden');
const sendButton = iconButton('send', 'Send (Enter)', send, 'send');
const composer = h('div', { className: 'composer' },
	attachmentRow,
	input,
	h('div', { className: 'composer-footer' }, agentSelect, modelSelect, h('span', { className: 'spacer' }), stopButton, sendButton),
);

app.append(header, messageList, noticeBar, requestArea, composer);

input.addEventListener('input', autosize);
input.addEventListener('keydown', event => {
	if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
		event.preventDefault();
		send();
	}
});
agentSelect.addEventListener('change', () => {
	agent = agentSelect.value;
	post({ type: 'setAgent', agent });
});
modelSelect.addEventListener('change', () => {
	const selected = modelSelect.value ? models[Number(modelSelect.value)] : undefined;
	model = selected && { providerID: selected.providerID, modelID: selected.modelID };
	post({ type: 'setModel', model });
});

// Links in rendered markdown and file references open in the editor (or the browser).
messageList.addEventListener('click', event => {
	const target = event.target as HTMLElement;
	const fileLink = target.closest<HTMLElement>('[data-file]');
	if (fileLink) {
		event.preventDefault();
		post({ type: 'openFile', path: fileLink.dataset.file! });
		return;
	}
	const anchor = target.closest('a');
	if (anchor?.getAttribute('href')) {
		event.preventDefault();
		post({ type: 'openLink', href: anchor.getAttribute('href')! });
	}
});
// Remember which collapsible sections are open so streaming updates don't close them.
messageList.addEventListener('toggle', event => {
	const details = event.target as HTMLDetailsElement;
	const id = details.dataset.id;
	if (id) {
		if (details.open) {
			expanded.add(id);
		} else {
			expanded.delete(id);
		}
	}
}, true);

function autosize(): void {
	input.style.height = 'auto';
	input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
}

function send(): void {
	const text = input.value.trim();
	if ((!text && !attachments.length) || !connected) {
		return;
	}
	post({ type: 'send', text, attachments });
	input.value = '';
	attachments = [];
	autosize();
	renderAttachments();
}

// #endregion

// #region Rendering

function renderHeader(): void {
	sessionSelect.replaceChildren();
	if (!activeSessionId) {
		sessionSelect.append(h('option', { text: 'New chat', attrs: { value: '' } }));
	}
	for (const session of sessions) {
		const option = h('option', { text: session.title || 'Untitled chat', attrs: { value: session.id } });
		option.selected = session.id === activeSessionId;
		sessionSelect.append(option);
	}
	sessionSelect.disabled = !sessions.length;
	deleteButton.disabled = !activeSessionId;
}

function renderPickers(): void {
	agentSelect.replaceChildren(...agents.map(a => {
		const option = h('option', { text: capitalize(a.name), title: a.description, attrs: { value: a.name } });
		option.selected = a.name === agent;
		return option;
	}));
	agentSelect.classList.toggle('hidden', agents.length < 2);

	modelSelect.replaceChildren(h('option', { text: defaultModelName ? `Auto (${defaultModelName})` : 'Auto', attrs: { value: '' } }));
	const groups = new Map<string, HTMLOptGroupElement>();
	models.forEach((m, index) => {
		let group = groups.get(m.providerID);
		if (!group) {
			group = h('optgroup', { attrs: { label: m.providerName } });
			groups.set(m.providerID, group);
			modelSelect.append(group);
		}
		const option = h('option', { text: m.name, attrs: { value: String(index) } });
		option.selected = !!model && m.providerID === model.providerID && m.modelID === model.modelID;
		group.append(option);
	});
	modelSelect.disabled = !models.length;
	input.disabled = !connected;
	sendButton.disabled = !connected;
}

function renderMessages(): void {
	const nearBottom = isNearBottom();
	messageList.replaceChildren();
	if (!messages.size) {
		messageList.append(renderEmptyState());
		return;
	}
	for (const message of messages.values()) {
		messageList.append(renderMessage(message));
	}
	messageList.append(renderWorking());
	if (nearBottom) {
		scrollToBottom();
	}
}

function upsertMessage(message: ViewMessage): void {
	const nearBottom = isNearBottom();
	const isNew = !messages.has(message.id);
	messages.set(message.id, message);
	if (isNew) {
		// Keep insertion order chronological (ids sort by creation time).
		const sorted = [...messages.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
		messages.clear();
		for (const m of sorted) {
			messages.set(m.id, m);
		}
		renderMessages();
		scrollToBottom();
		return;
	}
	const existing = messageList.querySelector(`[data-message="${CSS.escape(message.id)}"]`);
	existing?.replaceWith(renderMessage(message));
	if (nearBottom) {
		scrollToBottom();
	}
}

function renderEmptyState(): HTMLElement {
	if (!connected) {
		return h('div', { className: 'empty' }, h('div', { className: 'empty-title', text: 'Starting Agent Chat…' }));
	}
	if (!models.length) {
		const connect = h('button', { className: 'primary-button', text: 'Connect a Model Provider', attrs: { type: 'button' } });
		connect.addEventListener('click', () => post({ type: 'openAdvanced' }));
		return h('div', { className: 'empty' },
			h('div', { className: 'empty-title', text: 'Connect a model to get started' }),
			h('p', { text: 'Sign in to a provider such as Anthropic, OpenAI, or GitHub, or use a local model.' }),
			connect,
		);
	}
	const suggestions = ['Explain this project', 'Find and fix a bug', 'Write tests for the current file'];
	return h('div', { className: 'empty' },
		h('div', { className: 'empty-logo', attrs: { 'aria-hidden': 'true' } }),
		h('div', { className: 'empty-title', text: 'What should we build?' }),
		h('p', { text: 'Agent Chat reads your project, edits files, and runs commands. Add context with Ctrl+Alt+K from the editor.' }),
		h('div', { className: 'suggestions' }, ...suggestions.map(text => {
			const button = h('button', { className: 'suggestion', text, attrs: { type: 'button' } });
			button.addEventListener('click', () => {
				input.value = text;
				autosize();
				input.focus();
			});
			return button;
		})),
	);
}

function renderWorking(): HTMLElement {
	const working = h('div', { className: `working ${busy ? '' : 'hidden'}` },
		h('span', { className: 'dots', attrs: { 'aria-hidden': 'true' } }, h('span'), h('span'), h('span')),
		h('span', { text: retry ? `Retrying: ${retry}` : 'Working' }),
	);
	working.id = 'working';
	return working;
}

function renderMessage(message: ViewMessage): HTMLElement {
	const container = h('div', { className: `message ${message.role}`, attrs: { 'data-message': message.id } });
	if (message.role === 'user') {
		const bubble = h('div', { className: 'bubble' });
		const files = message.parts.filter(p => p.kind === 'file');
		for (const part of message.parts) {
			if (part.kind === 'text') {
				bubble.append(html('markdown', part.html));
			}
		}
		if (files.length) {
			bubble.append(h('div', { className: 'chips' }, ...files.map(renderFileChip)));
		}
		container.append(bubble);
		return container;
	}
	for (const part of message.parts) {
		const rendered = renderPart(part);
		if (rendered) {
			container.append(rendered);
		}
	}
	if (message.error) {
		container.append(h('div', { className: 'error' }, icon('error'), h('span', { text: message.error })));
	}
	return container;
}

function renderFileChip(part: ViewPart): HTMLElement {
	if (part.kind !== 'file') {
		return h('span');
	}
	return h('span', { className: 'chip', title: part.path, attrs: part.path ? { 'data-file': part.path } : {} }, icon('file'), h('span', { text: part.name }));
}

function renderPart(part: ViewPart): HTMLElement | undefined {
	switch (part.kind) {
		case 'text':
			return html('markdown', part.html);
		case 'reasoning': {
			const details = h('details', { className: 'reasoning', attrs: { 'data-id': part.id } },
				h('summary', {}, icon(part.done ? 'lightbulb' : 'loading'), h('span', { text: part.done ? 'Thought' : 'Thinking…' })),
				html('markdown', part.html),
			);
			details.open = expanded.has(part.id);
			return details;
		}
		case 'tool':
			return renderTool(part);
		case 'file':
			return renderFileChip(part);
	}
}

function renderTool(part: Extract<ViewPart, { kind: 'tool' }>): HTMLElement {
	const statusIcon = part.status === 'completed' ? 'check' : part.status === 'error' ? 'error' : 'loading';
	const summary = h('summary', {},
		icon(statusIcon),
		h('span', { className: 'tool-title', text: part.title }),
		part.additions !== undefined && h('span', { className: 'stat added', text: `+${part.additions}` }),
		part.deletions !== undefined && h('span', { className: 'stat removed', text: `−${part.deletions}` }),
	);
	const body = h('div', { className: 'tool-body' });
	if (part.filePath) {
		body.append(h('a', { className: 'file-link', text: part.filePath, attrs: { href: '#', 'data-file': part.filePath } }));
	}
	if (part.detail) {
		body.append(h('pre', { className: 'code', text: part.tool === 'bash' ? `$ ${part.detail}` : part.detail }));
	}
	if (part.diff) {
		body.append(renderDiff(part.diff));
	}
	if (part.output) {
		body.append(h('pre', { className: 'code output', text: part.output }));
	}
	if (part.error) {
		body.append(h('div', { className: 'error' }, h('span', { text: part.error })));
	}
	const hasBody = body.childElementCount > 0;
	const details = h('details', { className: `tool status-${part.status} ${hasBody ? '' : 'no-body'}`, attrs: { 'data-id': part.id } }, summary, hasBody && body);
	details.open = hasBody && expanded.has(part.id);
	return details;
}

function renderDiff(diff: string): HTMLElement {
	const pre = h('pre', { className: 'code diff' });
	for (const line of diff.split('\n')) {
		if (/^(Index:|={3,}|---|\+\+\+)/.test(line)) {
			continue;
		}
		const kind = line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : line.startsWith('@@') ? 'hunk' : '';
		pre.append(h('span', { className: `line ${kind}`, text: line || ' ' }));
	}
	return pre;
}

function renderRequests(): void {
	requestArea.replaceChildren(...permissions.map(renderPermission), ...questions.map(renderQuestion));
}

function renderPermission(permission: PermissionView): HTMLElement {
	const reply = (value: 'once' | 'always' | 'reject') => () => post({ type: 'permission', id: permission.id, reply: value });
	const allow = h('button', { className: 'primary-button', text: 'Allow', attrs: { type: 'button' } });
	allow.addEventListener('click', reply('once'));
	const always = h('button', { className: 'secondary-button', text: 'Always Allow', attrs: { type: 'button' } });
	always.addEventListener('click', reply('always'));
	const deny = h('button', { className: 'secondary-button', text: 'Deny', attrs: { type: 'button' } });
	deny.addEventListener('click', reply('reject'));
	return h('div', { className: 'request' },
		h('div', { className: 'request-title' }, icon('shield'), h('span', { text: permission.title })),
		permission.detail && h('pre', { className: 'code', text: permission.detail }),
		permission.diff && renderDiff(permission.diff),
		h('div', { className: 'request-actions' }, allow, always, deny),
	);
}

function renderQuestion(request: QuestionView): HTMLElement {
	let answers = questionAnswers.get(request.id);
	if (!answers) {
		answers = request.questions.map(() => new Set<string>());
		questionAnswers.set(request.id, answers);
	}
	const customInputs: (HTMLInputElement | undefined)[] = [];
	const submit = h('button', { className: 'primary-button', text: 'Submit', attrs: { type: 'button' } });
	const updateSubmit = () => {
		submit.disabled = request.questions.some((_, i) => !answers![i].size && !customInputs[i]?.value.trim());
	};

	const blocks = request.questions.map((question, index) => {
		const selected = answers![index];
		const options = question.options.map(option => {
			const button = h('button', { className: `option ${selected.has(option.label) ? 'selected' : ''}`, title: option.description, attrs: { type: 'button' } },
				h('span', { className: 'option-label', text: option.label }),
				option.description && h('span', { className: 'option-description', text: option.description }),
			);
			button.addEventListener('click', () => {
				if (!question.multiple) {
					selected.clear();
				}
				if (selected.has(option.label)) {
					selected.delete(option.label);
				} else {
					selected.add(option.label);
				}
				renderRequests();
			});
			return button;
		});
		let custom: HTMLInputElement | undefined;
		if (question.custom) {
			custom = h('input', { className: 'custom-answer', attrs: { type: 'text', placeholder: 'Other…' } });
			custom.addEventListener('input', updateSubmit);
		}
		customInputs[index] = custom;
		return h('div', { className: 'question' },
			h('div', { className: 'question-header', text: question.header }),
			h('div', { className: 'question-text', text: question.question }),
			h('div', { className: 'options' }, ...options),
			custom,
		);
	});

	submit.addEventListener('click', () => {
		const result = request.questions.map((_, i) => {
			const values = [...answers![i]];
			const extra = customInputs[i]?.value.trim();
			return extra ? [...values, extra] : values;
		});
		questionAnswers.delete(request.id);
		post({ type: 'question', id: request.id, answers: result });
	});
	const dismiss = h('button', { className: 'secondary-button', text: 'Dismiss', attrs: { type: 'button' } });
	dismiss.addEventListener('click', () => {
		questionAnswers.delete(request.id);
		post({ type: 'questionReject', id: request.id });
	});
	updateSubmit();
	return h('div', { className: 'request' },
		h('div', { className: 'request-title' }, icon('question'), h('span', { text: 'Agent Chat has a question' })),
		...blocks,
		h('div', { className: 'request-actions' }, submit, dismiss),
	);
}

function renderAttachments(): void {
	attachmentRow.replaceChildren(...attachments.map((attachment, index) =>
		h('span', { className: 'chip', title: attachment.path },
			icon('file'),
			h('span', { text: attachment.label }),
			iconButton('close', `Remove ${attachment.label}`, () => {
				attachments.splice(index, 1);
				renderAttachments();
			}, 'chip-remove'),
		)));
	attachmentRow.classList.toggle('hidden', !attachments.length);
}

function renderStatus(): void {
	stopButton.classList.toggle('hidden', !busy);
	const working = document.getElementById('working');
	if (working) {
		working.replaceWith(renderWorking());
	}
	if (busy && isNearBottom()) {
		scrollToBottom();
	}
}

function showNotice(text: string): void {
	noticeBar.replaceChildren(
		icon('warning'),
		h('span', { className: 'notice-text', text }),
		iconButton('close', 'Dismiss', () => noticeBar.classList.add('hidden')),
	);
	noticeBar.classList.remove('hidden');
}

function isNearBottom(): boolean {
	return messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 60;
}

function scrollToBottom(): void {
	messageList.scrollTop = messageList.scrollHeight;
}

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

// #endregion

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
	const message = event.data;
	switch (message.type) {
		case 'state': {
			const sessionChanged = message.activeSessionId !== activeSessionId;
			const wasConnected = connected;
			({ sessions, activeSessionId, models, agents, model, defaultModelName, agent, connected } = message);
			renderHeader();
			renderPickers();
			if (sessionChanged || wasConnected !== connected) {
				noticeBar.classList.add('hidden');
			}
			if (!messages.size) {
				renderMessages();
			}
			break;
		}
		case 'messages':
			messages.clear();
			for (const m of message.messages) {
				messages.set(m.id, m);
			}
			renderMessages();
			scrollToBottom();
			break;
		case 'upsertMessage':
			if (message.sessionId === activeSessionId) {
				upsertMessage(message.message);
			}
			break;
		case 'removeMessage':
			if (message.sessionId === activeSessionId && messages.delete(message.messageId)) {
				renderMessages();
			}
			break;
		case 'status':
			busy = message.busy;
			retry = message.retry;
			renderStatus();
			break;
		case 'requests':
			permissions = message.permissions;
			questions = message.questions;
			renderRequests();
			break;
		case 'attach':
			if (!attachments.some(a => a.label === message.attachment.label && a.path === message.attachment.path)) {
				attachments.push(message.attachment);
			}
			renderAttachments();
			input.focus();
			break;
		case 'notice':
			showNotice(message.text);
			break;
	}
});

renderHeader();
renderPickers();
renderMessages();
renderAttachments();
post({ type: 'ready' });
