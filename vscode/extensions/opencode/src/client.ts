/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A minimal client for the opencode server's HTTP API (the `/session`, `/event`, … routes that
// opencode's own web UI uses). Only the fields Agent Chat reads are typed.

export interface ApiSession {
	id: string;
	title: string;
	directory: string;
	parentID?: string;
	time: { created: number; updated: number; archived?: number };
}

export interface ApiMessageInfo {
	id: string;
	sessionID: string;
	role: 'user' | 'assistant';
	providerID?: string;
	modelID?: string;
	model?: { providerID: string; modelID: string };
	agent?: string;
	error?: { name: string; data?: { message?: string } };
}

export interface ApiPart {
	id: string;
	sessionID: string;
	messageID: string;
	type: string;
	text?: string;
	synthetic?: boolean;
	ignored?: boolean;
	time?: { start: number; end?: number };
	// tool parts
	tool?: string;
	state?: {
		status: 'pending' | 'running' | 'completed' | 'error';
		input?: Record<string, unknown>;
		title?: string;
		output?: string;
		error?: string;
		metadata?: Record<string, unknown>;
	};
	// file parts
	filename?: string;
	url?: string;
	mime?: string;
}

export interface ApiMessage {
	info: ApiMessageInfo;
	parts: ApiPart[];
}

export interface ApiProvider {
	id: string;
	name: string;
	models: Record<string, { id: string; name: string; status?: string }>;
}

export interface ApiAgent {
	name: string;
	description?: string;
	mode: 'primary' | 'subagent' | 'all';
	hidden?: boolean;
}

export interface ApiPermission {
	id: string;
	sessionID: string;
	permission: string;
	patterns: string[];
	metadata: Record<string, unknown>;
}

export interface ApiQuestion {
	id: string;
	sessionID: string;
	questions: {
		header: string;
		question: string;
		options: { label: string; description: string }[];
		multiple?: boolean;
		custom?: boolean;
	}[];
}

export type ApiSessionStatus = { type: 'idle' } | { type: 'busy' } | { type: 'retry'; attempt: number; message: string };

export interface ApiEvent {
	type: string;
	properties: Record<string, unknown>;
}

export interface PromptPart {
	type: 'text' | 'file';
	text?: string;
	mime?: string;
	url?: string;
	filename?: string;
}

export class OpencodeClient {

	constructor(
		private readonly baseUrl: string,
		private readonly authToken: string,
		private readonly directory: string,
	) { }

	listSessions(): Promise<ApiSession[]> {
		return this.request('GET', '/session');
	}

	createSession(): Promise<ApiSession> {
		return this.request('POST', '/session', {});
	}

	deleteSession(sessionID: string): Promise<unknown> {
		return this.request('DELETE', `/session/${sessionID}`);
	}

	messages(sessionID: string): Promise<ApiMessage[]> {
		return this.request('GET', `/session/${sessionID}/message`);
	}

	sessionStatus(): Promise<Record<string, ApiSessionStatus>> {
		return this.request('GET', '/session/status');
	}

	prompt(sessionID: string, body: { parts: PromptPart[]; model?: { providerID: string; modelID: string }; agent?: string }): Promise<unknown> {
		return this.request('POST', `/session/${sessionID}/prompt_async`, body);
	}

	abort(sessionID: string): Promise<unknown> {
		return this.request('POST', `/session/${sessionID}/abort`);
	}

	providers(): Promise<{ providers: ApiProvider[]; default: Record<string, string> }> {
		return this.request('GET', '/config/providers');
	}

	config(): Promise<{ model?: string }> {
		return this.request('GET', '/config');
	}

	agents(): Promise<ApiAgent[]> {
		return this.request('GET', '/agent');
	}

	permissions(): Promise<ApiPermission[]> {
		return this.request('GET', '/permission');
	}

	replyPermission(requestID: string, reply: 'once' | 'always' | 'reject'): Promise<unknown> {
		return this.request('POST', `/permission/${requestID}/reply`, { reply });
	}

	questions(): Promise<ApiQuestion[]> {
		return this.request('GET', '/question');
	}

	replyQuestion(requestID: string, answers: readonly (readonly string[])[]): Promise<unknown> {
		return this.request('POST', `/question/${requestID}/reply`, { answers });
	}

	rejectQuestion(requestID: string): Promise<unknown> {
		return this.request('POST', `/question/${requestID}/reject`);
	}

	/**
	 * Streams server events until `signal` aborts, reconnecting with backoff when the stream drops.
	 * `onConnected` fires on every (re)connect so callers can resynchronize state they may have missed.
	 */
	async subscribe(onEvent: (event: ApiEvent) => void, onConnected: () => void, signal: AbortSignal): Promise<void> {
		let delay = 500;
		while (!signal.aborted) {
			try {
				const response = await fetch(this.url('/event'), { headers: this.headers(), signal });
				if (!response.ok || !response.body) {
					throw new Error(`event stream failed: ${response.status}`);
				}
				delay = 500;
				onConnected();

				const decoder = new TextDecoder();
				let buffer = '';
				for await (const chunk of response.body) {
					buffer += decoder.decode(chunk as Uint8Array, { stream: true });
					let boundary: number;
					while ((boundary = buffer.indexOf('\n\n')) !== -1) {
						const block = buffer.slice(0, boundary);
						buffer = buffer.slice(boundary + 2);
						const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
						if (data) {
							try {
								onEvent(JSON.parse(data) as ApiEvent);
							} catch {
								// Ignore malformed events; the next resync corrects any drift.
							}
						}
					}
				}
			} catch {
				if (signal.aborted) {
					return;
				}
			}
			await new Promise(resolve => setTimeout(resolve, delay));
			delay = Math.min(delay * 2, 5_000);
		}
	}

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const response = await fetch(this.url(path), {
			method,
			headers: { ...this.headers(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(`${method} ${path} failed (${response.status})${text ? `: ${text.slice(0, 300)}` : ''}`);
		}
		const text = await response.text();
		return (text ? JSON.parse(text) : undefined) as T;
	}

	private url(path: string): string {
		// The directory scopes every request to this window's project; a query parameter avoids
		// header encoding problems with non-ASCII paths.
		return `${this.baseUrl}${path}?directory=${encodeURIComponent(this.directory)}`;
	}

	private headers(): Record<string, string> {
		return { Authorization: `Basic ${this.authToken}` };
	}
}
