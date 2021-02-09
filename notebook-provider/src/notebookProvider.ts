/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';

declare var TextEncoder: any;

// const mjAPI = require('mathjax-node');
// mjAPI.config({
// 	MathJax: {
// 		// traditional MathJax configuration
// 	}
// });
// mjAPI.start();

interface CellStreamOutput {
	output_type: 'stream';
	text: string;
}

interface CellErrorOutput {
	output_type: 'error';
	/**
	 * Exception Name
	 */
	ename: string;
	/**
	 * Exception Value
	 */
	evalue: string;
	/**
	 * Exception call stack
	 */
	traceback: string[];
}

interface CellDisplayOutput {
	output_type: 'display_data' | 'execute_result';
	data: { [key: string]: any };
}

export type RawCellOutput = CellStreamOutput | CellErrorOutput | CellDisplayOutput;

export interface RawCell {
	cell_type: 'markdown' | 'code';
	outputs?: RawCellOutput[];
	source: string[];
	metadata: any;
	execution_count?: number;
}

export class Cell {
	public outputs: vscode.NotebookCellOutput[] = [];

	constructor(
		public source: string[],
		public cell_type: 'markdown' | 'code',
		private _outputs: vscode.NotebookCellOutput[]
	) {

	}

	containHTML() {
		return this._outputs && this._outputs.find(op => op.outputs.find(opi => opi.mime === 'text/html'));
	}

	insertDependencies(dependency: vscode.NotebookCellOutput) {
		this._outputs.unshift(dependency);
	}

	fillInOutputs() {
		if (this._outputs && this.outputs.length !== this._outputs.length) {
			this.outputs = this._outputs;
		}
	}

	outputsFullFilled() {
		return this._outputs && this.outputs.length === this._outputs.length;
	}

	clearOutputs() {
		this.outputs = [];
	}
}

function transformOutputToCore(rawOutput: RawCellOutput): vscode.NotebookCellOutput {
	if (rawOutput.output_type === 'execute_result' || rawOutput.output_type === 'display_data') {
		const items: vscode.NotebookCellOutputItem[] = [];
		for (const key in rawOutput.data) {
			items.push(new vscode.NotebookCellOutputItem(key, rawOutput.data[key], undefined));
		}
		return new vscode.NotebookCellOutput(items)
	} else if (rawOutput.output_type === 'stream') {
		return new vscode.NotebookCellOutput([new vscode.NotebookCellOutputItem('application/x.notebook.stream', Array.isArray(rawOutput.text) ? rawOutput.text.join('') : rawOutput.text)])
	} else {
		return new vscode.NotebookCellOutput([new vscode.NotebookCellOutputItem('application/x.notebook.error-traceback', {
			ename: (<CellErrorOutput>rawOutput).ename,
			evalue: (<CellErrorOutput>rawOutput).evalue,
			traceback: (<CellErrorOutput>rawOutput).traceback
		})]);
	}
}

function transformOutputFromCore(output: vscode.NotebookCellOutput): RawCellOutput {
	if (output.outputs.find(op => op.mime === 'application/x.notebook.stream')) {
		return {
			output_type: 'stream',
			text: output.outputs.find(op => op.mime === 'application/x.notebook.stream')?.value as string || ''
		}
	} else 	if (output.outputs.find(op => op.mime === 'application/x.notebook.error-traceback')) {
		const item = output.outputs.find(op => op.mime === 'application/x.notebook.error-traceback');
		return {
			output_type: 'error',
			ename: (item as any).ename,
			evalue: (item as any).evalue,
			traceback: (item as any).traceback
		}
	} else {
		let data: { [key: string]: unknown } = {};

		output.outputs.forEach(op => {
			data[op.mime] = data.value
		})
		return {
			output_type: 'display_data',
			data: data
		};
	}
}

export class JupyterNotebook {
	public mapping: Map<number, any> = new Map();
	private preloadScript = false;
	private displayOrders = [
		'application/vnd.*',
		'application/json',
		'application/javascript',
		'text/html',
		'image/svg+xml',
		'text/markdown',
		'image/svg+xml',
		'image/png',
		'image/jpeg',
		'text/plain'
	];
	private nextExecutionOrder = 0;

	constructor(
		private _extensionPath: string,
		public notebookJSON: any,
		private fillOutputs: boolean
	) {
		// editor.document.languages = ['python'];
		// editor.document.displayOrder = this.displayOrders;
		// editor.document.metadata = {
		// };
	}

	resolve(): vscode.NotebookData {
		return {
			languages: ['python'],
			metadata: {
				editable: this.notebookJSON?.metadata?.editable === undefined ? true : this.notebookJSON?.metadata?.editable,
				runnable: this.notebookJSON?.metadata?.runnable === undefined ? true : this.notebookJSON?.metadata?.runnable,
				cellEditable: this.notebookJSON?.metadata?.cellEditable === undefined ? true : this.notebookJSON?.metadata?.cellEditable,
				cellRunnable: this.notebookJSON?.metadata?.cellRunnable === undefined ? true : this.notebookJSON?.metadata?.cellRunnable,
				displayOrder: this.displayOrders,
			},
			cells: this.notebookJSON.cells.map(((raw_cell: RawCell) => {
				let outputs: vscode.NotebookCellOutput[] = [];
				if (this.fillOutputs) {
					outputs = raw_cell.outputs?.map(rawOutput => transformOutputToCore(rawOutput)) || [];

					// if (!this.preloadScript) {
					// 	let containHTML = this.containHTML(raw_cell);

					// 	if (containHTML) {
					// 		this.preloadScript = true;
					// 		const scriptPathOnDisk = vscode.Uri.file(
					// 			path.join(this._extensionPath, 'dist', 'ipywidgets.js')
					// 		);

					// 		let scriptUri = scriptPathOnDisk.with({ scheme: 'vscode-webview-resource' });

					// 		outputs.unshift(
					// 			{
					// 				outputKind: vscode.CellOutputKind.Rich,
					// 				'data': {
					// 					'text/html': [
					// 						`<script src="${scriptUri}"></script>\n`,
					// 					]
					// 				}
					// 			}
					// 		);
					// 	}
					// }
				}

				const executionOrder = typeof raw_cell.execution_count === 'number' ? raw_cell.execution_count : undefined;
				if (typeof executionOrder === 'number') {
					if (executionOrder >= this.nextExecutionOrder) {
						this.nextExecutionOrder = executionOrder + 1;
					}
				}

				const cellEditable = raw_cell.metadata?.editable;
				const runnable = raw_cell.metadata?.runnable;
				const metadata = { editable: cellEditable, runnable: runnable, executionOrder };

				return {
					source: raw_cell.source ? (Array.isArray(raw_cell.source) ? raw_cell.source.join('') : raw_cell.source) : '',
					language: this.notebookJSON?.metadata?.language_info?.name || 'python',
					cellKind: raw_cell.cell_type === 'code' ? vscode.CellKind.Code : vscode.CellKind.Markdown,
					outputs: outputs,
					metadata
				};
			}))
		}
	}

	private getNextExecutionOrder(): number {
		return this.nextExecutionOrder++;
	}

	async execute(document: vscode.NotebookDocument, cell: vscode.NotebookCell | undefined) {
		if (cell) {
			const index = document.cells.indexOf(cell);
			let rawCell: RawCell = this.notebookJSON.cells[index];

			if (!this.preloadScript) {
				let containHTML = this.containHTML(rawCell);
				if (containHTML) {
					this.preloadScript = true;
					const scriptPathOnDisk = vscode.Uri.file(
						path.join(this._extensionPath, 'dist', 'ipywidgets.js')
					);

					let scriptUri = scriptPathOnDisk.with({ scheme: 'vscode-webview-resource' });

					rawCell.outputs?.unshift(
						{
							'output_type': 'display_data',
							'data': {
								'text/html': [
									`<script src="${scriptUri}"></script>\n`,
								]
							}
						}
					);
				}
			}
			const edit = new vscode.WorkspaceEdit();
			edit.replaceNotebookCellOutput(document.uri, cell.index, rawCell.outputs?.map(rawOutput => transformOutputToCore(rawOutput)) || []);
			edit.replaceNotebookCellMetadata(document.uri, cell.index, { ...cell.metadata, executionOrder: this.getNextExecutionOrder() });
			await vscode.workspace.applyEdit(edit);
		} else {
			if (!this.fillOutputs) {
				for (let i = 0; i < document.cells.length; i++) {
					let cell = document.cells[i];

					let rawCell: RawCell = this.notebookJSON.cells[i];

					if (!this.preloadScript) {
						let containHTML = this.containHTML(rawCell);
						if (containHTML) {
							this.preloadScript = true;
							const scriptPathOnDisk = vscode.Uri.file(
								path.join(this._extensionPath, 'dist', 'ipywidgets.js')
							);

							let scriptUri = scriptPathOnDisk.with({ scheme: 'vscode-webview-resource' });

							rawCell.outputs?.unshift(
								{
									'output_type': 'display_data',
									'data': {
										'text/html': [
											`<script src="${scriptUri}"></script>\n`,
										]
									}
								}
							);
						}
					}

					const edit = new vscode.WorkspaceEdit();
					edit.replaceNotebookCellOutput(document.uri, cell.index, rawCell.outputs?.map(rawOutput => transformOutputToCore(rawOutput)) || []);
					edit.replaceNotebookCellMetadata(document.uri, cell.index, { ...cell.metadata, executionOrder: this.getNextExecutionOrder() });
					await vscode.workspace.applyEdit(edit);
				}

				this.fillOutputs = true;
			}
		}
	}

	containHTML(rawCell: RawCell) {
		return rawCell.outputs && rawCell.outputs.some((output: any) => {
			if (output.output_type === 'display_data' && output.data['text/html']) {
				return true;
			}

			return false;
		});
	}
}

async function timeFn(fn: () => Promise<void>): Promise<number> {
	const startTime = Date.now();
	await fn();
	return Date.now() - startTime;
}

// For test
const DELAY_EXECUTION = true;

export class NotebookProvider implements vscode.NotebookContentProvider, vscode.NotebookKernel {
	private _notebooks: Map<string, JupyterNotebook> = new Map();
	onDidChange: vscode.Event<void> = new vscode.EventEmitter<void>().event;
	label: string = 'Jupyter';
	isPreferred: boolean = true;

	constructor(viewType: string, private _extensionPath: string, private fillOutputs: boolean) {

		const emitter = new vscode.EventEmitter<vscode.NotebookDocument | undefined>();
		vscode.notebook.registerNotebookKernelProvider({ viewType: viewType }, {
			onDidChangeKernels: emitter.event,
			provideKernels: () => {
				return [this];
			}
		});

		setTimeout(() => {
			emitter.fire(undefined);
		}, 5000);

	}

	async openNotebook(uri: vscode.Uri, context: vscode.NotebookDocumentOpenContext): Promise<vscode.NotebookData> {
		let actualUri = context.backupId ? vscode.Uri.parse(context.backupId) : uri;

		try {
			let json;
			try {
				let content = await vscode.workspace.fs.readFile(actualUri);
				json = JSON.parse(content.toString());
			} catch {
				json = {
					cells: [{
						cell_type: 'markdown',
						source: [
							'# header'
						]
					}]
				};
			}
			let jupyterNotebook = new JupyterNotebook(this._extensionPath, json, this.fillOutputs);
			this._notebooks.set(uri.toString(), jupyterNotebook);
			return jupyterNotebook.resolve();
		} catch {
			throw new Error('Fail to load the document');
		}
	}

	async resolveNotebook(_document: vscode.NotebookDocument, _webview: vscode.NotebookCommunication): Promise<void> {
		return;
	}

	async saveNotebook(_document: vscode.NotebookDocument, _token: vscode.CancellationToken): Promise<void> {
		return this._save(_document, _document.uri, _token);
	}

	saveNotebookAs(targetResource: vscode.Uri, document: vscode.NotebookDocument, token: vscode.CancellationToken): Promise<void> {
		return this._save(document, targetResource, token);
	}

	async _save(document: vscode.NotebookDocument, targetResource: vscode.Uri, _token: vscode.CancellationToken): Promise<void> {
		let cells: RawCell[] = [];

		for (let i = 0; i < document.cells.length; i++) {
			let lines = document.cells[i].document.getText().split(/\r|\n|\r\n/g);
			let source = lines.map((value, index) => {
				if (index !== lines.length - 1) {
					return value + '\n';
				} else {
					return value;
				}
			});

			if (document.cells[i].cellKind === vscode.CellKind.Markdown) {
				cells.push({
					source: source,
					metadata: {
						language_info: {
							name: document.cells[i].language || 'markdown'
						}
					},
					cell_type: document.cells[i].cellKind === vscode.CellKind.Markdown ? 'markdown' : 'code'
				});
			} else {
				cells.push({
					source: source,
					metadata: {
						language_info: {
							name: document.cells[i].language || 'markdown'
						}
					},
					cell_type: document.cells[i].cellKind === vscode.CellKind.Markdown ? 'markdown' : 'code',
					outputs: document.cells[i].outputs.map(output => transformOutputFromCore(output)),
					execution_count: document.cells[i].metadata?.executionOrder
				});
			}
		}

		let raw = this._notebooks.get(document.uri.toString());

		if (raw) {
			raw.notebookJSON.cells = cells;
			let content = JSON.stringify(raw.notebookJSON, null, 4);
			await vscode.workspace.fs.writeFile(targetResource, new TextEncoder().encode(content));
		} else {
			let content = JSON.stringify({ cells: cells }, null, 4);
			await vscode.workspace.fs.writeFile(targetResource, new TextEncoder().encode(content));
		}

		return;
	}

	async executeAllCells(document: vscode.NotebookDocument): Promise<void> {
		await this.executeCell(document, undefined);
	}

	async cancelAllCellsExecution(_document: vscode.NotebookDocument) {

	}


	async executeCell(document: vscode.NotebookDocument, cell: vscode.NotebookCell | undefined): Promise<void> {
		if (cell) {
			cell.metadata.statusMessage = 'Running';
			cell.metadata.runStartTime = Date.now();
			cell.metadata.runState = vscode.NotebookCellRunState.Running;
		}

		const duration = await timeFn(async () => {
			if (DELAY_EXECUTION) {
				return this._executeCellDelayed(document, cell);
			}

			const jupyterNotebook = this._notebooks.get(document.uri.toString());
			if (jupyterNotebook) {
				return jupyterNotebook.execute(document, cell);
			}
		});

		if (cell) {
			cell.metadata.lastRunDuration = duration;
			cell.metadata.statusMessage = 'Success'
			cell.metadata.runState = vscode.NotebookCellRunState.Success;
		}
	}
	
	async cancelCellExecution(_document: vscode.NotebookDocument, _cell: vscode.NotebookCell) {
	}

	private async _executeCellDelayed(document: vscode.NotebookDocument, cell: vscode.NotebookCell | undefined): Promise<void> {
		let jupyterNotebook = this._notebooks.get(document.uri.toString());
		return new Promise<void>(async resolve => {
			await new Promise(resolve => setTimeout(resolve, Math.random() * 2500));
			if (jupyterNotebook) {
				return jupyterNotebook.execute(document, cell).then(resolve);
			}
		});
	}

	async revertNotebook(_document: vscode.NotebookDocument, _cancellation: vscode.CancellationToken): Promise<void> {
		return;
	}

	async backupNotebook(document: vscode.NotebookDocument, context: vscode.NotebookDocumentBackupContext, cancellation: vscode.CancellationToken): Promise<vscode.NotebookDocumentBackup> {
		await this._save(document, context.destination, cancellation);

		return {
			id: context.destination.toString(),
			delete: () => {
				vscode.workspace.fs.delete(context.destination);
			}
		};
	}
}
