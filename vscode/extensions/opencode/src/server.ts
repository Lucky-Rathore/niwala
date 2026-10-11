/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/** The folder the agent works in: the first workspace folder, or the home folder for empty windows. */
export function workspaceDirectory(): string {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
}

export interface RunningServer {
	readonly process: cp.ChildProcess;
	readonly url: string;
	readonly authToken: string;
}

/**
 * Runs a single `opencode serve` sidecar per window, bound to 127.0.0.1 with a
 * random per-session password. Agent Chat talks to its API; the advanced view embeds its web UI.
 */
export class OpencodeServer implements vscode.Disposable {

	private server: Promise<RunningServer> | undefined;
	private readonly onDidRestartEmitter = new vscode.EventEmitter<void>();
	readonly onDidRestart = this.onDidRestartEmitter.event;

	constructor(
		private readonly extensionPath: string,
		private readonly output: vscode.OutputChannel,
	) { }

	get(): Promise<RunningServer> {
		if (!this.server) {
			const starting = this.start();
			this.server = starting;
			starting.catch(() => {
				if (this.server === starting) {
					this.server = undefined;
				}
			});
		}
		return this.server;
	}

	async restart(): Promise<void> {
		await this.stop();
		this.onDidRestartEmitter.fire();
	}

	private start(): Promise<RunningServer> {
		const binary = this.resolveBinary();
		const password = crypto.randomBytes(24).toString('hex');
		const authToken = Buffer.from(`opencode:${password}`).toString('base64');
		const cwd = workspaceDirectory();

		this.output.appendLine(`Starting ${binary} serve in ${cwd}`);
		const child = cp.spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
			cwd,
			env: {
				...process.env,
				OPENCODE_SERVER_USERNAME: 'opencode',
				OPENCODE_SERVER_PASSWORD: password,
				OPENCODE_PUBLIC_UI: '1',
				// Niwala ships and updates the binary; opencode must not replace it.
				OPENCODE_DISABLE_AUTOUPDATE: '1',
			},
		});

		let started = false;
		const running = new Promise<RunningServer>((resolve, reject) => {
			const timeout = setTimeout(() => {
				child.kill();
				reject(new Error('Timed out waiting for the Agent Chat server to start.'));
			}, 30_000);

			child.stdout?.on('data', (data: Buffer) => {
				const text = data.toString();
				this.output.append(text);
				const match = /listening on (http:\/\/\S+)/.exec(text);
				if (match) {
					clearTimeout(timeout);
					started = true;
					resolve({ process: child, url: match[1].replace(/\/$/, ''), authToken });
				}
			});
			child.stderr?.on('data', (data: Buffer) => this.output.append(data.toString()));
			child.on('error', err => {
				clearTimeout(timeout);
				reject(new Error(`Failed to start Agent Chat (${binary}): ${err.message}`));
			});
			child.on('exit', code => {
				clearTimeout(timeout);
				this.output.appendLine(`Agent Chat server exited with code ${code}`);
				if (this.server === running) {
					this.server = undefined;
					// A crash after startup: let views reconnect (a failed start is reported by `get()` instead).
					if (started) {
						this.onDidRestartEmitter.fire();
					}
				}
				reject(new Error(`Agent Chat server exited with code ${code}`));
			});
		});
		return running;
	}

	private resolveBinary(): string {
		const configured = vscode.workspace.getConfiguration('agentChat').get<string>('binaryPath');
		if (configured) {
			return configured;
		}

		const bundled = path.join(this.extensionPath, 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode');
		if (fs.existsSync(bundled)) {
			if (process.platform !== 'win32') {
				// Packaging does not always preserve the executable bit.
				try { fs.chmodSync(bundled, 0o755); } catch { /* read-only install; assume already executable */ }
			}
			return bundled;
		}

		return 'opencode';
	}

	private async stop(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		const running = await server?.catch(() => undefined);
		running?.process.kill();
	}

	dispose(): void {
		void this.stop();
		this.onDidRestartEmitter.dispose();
	}
}
