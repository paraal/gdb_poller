import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Decorates every line the debug adapter reports as a valid breakpoint
 * location (DAP `breakpointLocations` request) with a faint gutter box, so
 * lines where a breakpoint (regular, temporary, or a future click-to-set) can
 * actually land are visible at a glance — similar to how some IDEs shade
 * viable breakpoint lines. Silently disables itself for the rest of the
 * session if the adapter does not implement the request (logged once).
 */
export class BreakpointGlyphDecorator implements vscode.Disposable {
    private readonly decoration: vscode.TextEditorDecorationType;
    private readonly disposables: vscode.Disposable[] = [];
    private unsupported = false;
    private refreshTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(context: vscode.ExtensionContext, private readonly output: vscode.OutputChannel) {
        this.decoration = vscode.window.createTextEditorDecorationType({
            gutterIconPath: context.asAbsolutePath('media/bp-slot.svg'),
            gutterIconSize: 'contain'
        });
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor(() => this.scheduleRefresh()),
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document === vscode.window.activeTextEditor?.document) {
                    this.scheduleRefresh();
                }
            }),
            vscode.debug.onDidChangeActiveDebugSession(() => this.scheduleRefresh()),
            vscode.debug.onDidStartDebugSession(() => {
                this.unsupported = false;
                this.scheduleRefresh();
            }),
            vscode.debug.onDidTerminateDebugSession(() => this.clearAll()),
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('gdbLiveWatch.showBreakpointGlyphs')) {
                    this.scheduleRefresh();
                }
            })
        );
    }

    private enabled(): boolean {
        return vscode.workspace.getConfiguration('gdbLiveWatch').get<boolean>('showBreakpointGlyphs', true);
    }

    private scheduleRefresh(): void {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
        this.refreshTimer = setTimeout(() => void this.refresh(), 250);
    }

    private clearAll(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            editor.setDecorations(this.decoration, []);
        }
    }

    async refresh(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        const session = vscode.debug.activeDebugSession;
        if (!editor || editor.document.uri.scheme !== 'file' || !session || !this.enabled() || this.unsupported) {
            if (editor) {
                editor.setDecorations(this.decoration, []);
            }
            return;
        }
        try {
            const resp = await session.customRequest('breakpointLocations', {
                source: {
                    path: editor.document.uri.fsPath,
                    name: path.basename(editor.document.uri.fsPath)
                },
                line: 1,
                endLine: editor.document.lineCount
            });
            const locations: Array<{ line: number }> = resp?.breakpoints ?? [];
            const ranges = locations.map((l) => new vscode.Range(l.line - 1, 0, l.line - 1, 0));
            if (vscode.window.activeTextEditor === editor) {
                editor.setDecorations(this.decoration, ranges);
            }
        } catch (e) {
            this.unsupported = true;
            editor.setDecorations(this.decoration, []);
            this.output.appendLine(
                `Breakpoint location glyphs unavailable (adapter does not support 'breakpointLocations'): ${
                    e instanceof Error ? e.message : String(e)
                }`
            );
        }
    }

    dispose(): void {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
        this.disposables.forEach((d) => d.dispose());
        this.decoration.dispose();
    }
}
