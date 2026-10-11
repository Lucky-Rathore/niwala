/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Messages exchanged between the extension host and the Agent Chat webview.
// Shared by both sides, so this file must not import `vscode` or Node modules.

export interface ModelRef {
	readonly providerID: string;
	readonly modelID: string;
}

export interface ModelOption extends ModelRef {
	readonly providerName: string;
	readonly name: string;
}

export interface AgentOption {
	readonly name: string;
	readonly description?: string;
}

export interface SessionSummary {
	readonly id: string;
	readonly title: string;
	readonly updated: number;
}

export type ToolStatus = 'pending' | 'running' | 'completed' | 'error';

export type ViewPart =
	| { readonly kind: 'text'; readonly id: string; readonly html: string }
	| { readonly kind: 'reasoning'; readonly id: string; readonly html: string; readonly done: boolean }
	| {
		readonly kind: 'tool';
		readonly id: string;
		readonly tool: string;
		readonly status: ToolStatus;
		readonly title: string;
		/** Workspace-relative (or absolute) path the tool acted on, shown as a link. */
		readonly filePath?: string;
		/** Command, pattern, or other primary input, shown as code. */
		readonly detail?: string;
		readonly output?: string;
		readonly error?: string;
		readonly diff?: string;
		readonly additions?: number;
		readonly deletions?: number;
	}
	| { readonly kind: 'file'; readonly id: string; readonly name: string; readonly path?: string };

export interface ViewMessage {
	readonly id: string;
	readonly role: 'user' | 'assistant';
	readonly parts: readonly ViewPart[];
	readonly error?: string;
	/** Model label for assistant messages. */
	readonly model?: string;
}

export interface PermissionView {
	readonly id: string;
	readonly sessionID: string;
	readonly title: string;
	readonly detail?: string;
	readonly diff?: string;
}

export interface QuestionView {
	readonly id: string;
	readonly sessionID: string;
	readonly questions: readonly {
		readonly header: string;
		readonly question: string;
		readonly options: readonly { readonly label: string; readonly description: string }[];
		readonly multiple: boolean;
		readonly custom: boolean;
	}[];
}

export interface Attachment {
	/** Absolute path. */
	readonly path: string;
	/** Display label, e.g. `app.ts:10-24`. */
	readonly label: string;
	readonly startLine?: number;
	readonly endLine?: number;
}

export type HostMessage =
	| {
		readonly type: 'state';
		readonly sessions: readonly SessionSummary[];
		readonly activeSessionId?: string;
		readonly models: readonly ModelOption[];
		readonly agents: readonly AgentOption[];
		/** Explicitly chosen model; undefined lets opencode pick its default. */
		readonly model?: ModelRef;
		/** Name of the model opencode picks by default, for the "Auto" option. */
		readonly defaultModelName?: string;
		readonly agent?: string;
		readonly connected: boolean;
	}
	| { readonly type: 'messages'; readonly sessionId?: string; readonly messages: readonly ViewMessage[] }
	| { readonly type: 'upsertMessage'; readonly sessionId: string; readonly message: ViewMessage }
	| { readonly type: 'removeMessage'; readonly sessionId: string; readonly messageId: string }
	| { readonly type: 'status'; readonly busy: boolean; readonly retry?: string }
	| { readonly type: 'requests'; readonly permissions: readonly PermissionView[]; readonly questions: readonly QuestionView[] }
	| { readonly type: 'attach'; readonly attachment: Attachment }
	| { readonly type: 'notice'; readonly text: string };

export type WebviewMessage =
	| { readonly type: 'ready' }
	| { readonly type: 'newSession' }
	| { readonly type: 'selectSession'; readonly id: string }
	| { readonly type: 'deleteSession'; readonly id: string }
	| { readonly type: 'send'; readonly text: string; readonly attachments: readonly Attachment[] }
	| { readonly type: 'abort' }
	| { readonly type: 'setModel'; readonly model: ModelRef | undefined }
	| { readonly type: 'setAgent'; readonly agent: string }
	| { readonly type: 'permission'; readonly id: string; readonly reply: 'once' | 'always' | 'reject' }
	| { readonly type: 'question'; readonly id: string; readonly answers: readonly (readonly string[])[] }
	| { readonly type: 'questionReject'; readonly id: string }
	| { readonly type: 'openLink'; readonly href: string }
	| { readonly type: 'openFile'; readonly path: string; readonly line?: number }
	| { readonly type: 'openAdvanced' }
	| { readonly type: 'manageTrust' };
