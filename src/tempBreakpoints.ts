import * as vscode from 'vscode';
import * as path from 'path';
import { GdbCommandRunner } from './gdbConsole';

export interface TempBreakpoint {
    /** GDB breakpoint number. */
    number: number;
    file: string;
    line: number;
}

function samePath(a: string, b: string): boolean {
    return path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
}

/**
 * Manages GDB temporary breakpoints (`tbreak`): one-shot breakpoints GDB
 * itself deletes after the first hit. VS Code's native breakpoint UI has no
 * concept of these (they never go through `setBreakpoints`), so they are set
 * directly via the GDB CLI and shown with a dedicated gutter glyph. The
 * tracked list is reconciled against `info breakpoints` whenever the target
 * stops, so a glyph disappears the moment GDB reports the breakpoint as gone
 * (hit-and-auto-deleted, or removed by the user from the GDB console).
 */
export class TempBreakpointManager implements vscode.Disposable {
    private readonly bySession = new Map<string, TempBreakpoint[]>();
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changeEmitter.event;
    private readonly decoration: vscode.TextEditorDecorationType;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly runner: GdbCommandRunner, context: vscode.ExtensionContext) {
        this.decoration = vscode.window.createTextEditorDecorationType({
            gutterIconPath: context.asAbsolutePath('media/temp-breakpoint.svg'),
            gutterIconSize: 'contain',
            overviewRulerColor: new vscode.ThemeColor('debugIcon.breakpointForeground'),
            overviewRulerLane: vscode.OverviewRulerLane.Full
        });
        this.disposables.push(
            vscode.window.onDidChangeVisibleTextEditors(() => this.applyDecorations()),
            this.onDidChange(() => this.applyDecorations())
        );
    }

    list(sessionId: string | undefined): TempBreakpoint[] {
        return (sessionId ? this.bySession.get(sessionId) : undefined) ?? [];
    }

    /** Sets a `tbreak` at the current cursor line of `editor` for `session`. */
    async setAtCursor(session: vscode.DebugSession, editor: vscode.TextEditor): Promise<TempBreakpoint> {
        const line = editor.selection.active.line + 1;
        const file = editor.document.uri.fsPath;
        const text = await this.runner.run(session, `tbreak ${file}:${line}`);
        const m = text.match(/Temporary breakpoint (\d+)/i);
        if (!m) {
            throw new Error(
                text || `GDB did not confirm a temporary breakpoint at ${path.basename(file)}:${line}.`
            );
        }
        const bp: TempBreakpoint = { number: Number(m[1]), file, line };
        const list = this.bySession.get(session.id) ?? [];
        list.push(bp);
        this.bySession.set(session.id, list);
        this.changeEmitter.fire();
        return bp;
    }

    /** Reconciles the tracked list against `info breakpoints` (drops hit/auto-deleted ones). */
    async refresh(session: vscode.DebugSession): Promise<void> {
        const known = this.bySession.get(session.id);
        if (!known || known.length === 0) {
            return;
        }
        const text = await this.runner.run(session, 'info breakpoints').catch(() => '');
        const stillThere = new Set<number>();
        for (const m of text.matchAll(/^(\d+)\s+breakpoint\s+del\b/gm)) {
            stillThere.add(Number(m[1]));
        }
        const remaining = known.filter((bp) => stillThere.has(bp.number));
        if (remaining.length !== known.length) {
            this.bySession.set(session.id, remaining);
            this.changeEmitter.fire();
        }
    }

    async clearAll(session: vscode.DebugSession): Promise<void> {
        const known = this.bySession.get(session.id) ?? [];
        if (known.length === 0) {
            return;
        }
        await this.runner.run(session, `delete ${known.map((b) => b.number).join(' ')}`).catch(() => {
            // Already gone (hit and auto-deleted) - fine, just drop them locally.
        });
        this.bySession.set(session.id, []);
        this.changeEmitter.fire();
    }

    forgetSession(sessionId: string): void {
        if (this.bySession.delete(sessionId)) {
            this.changeEmitter.fire();
        }
    }

    private applyDecorations(): void {
        const sessionId = vscode.debug.activeDebugSession?.id;
        const list = this.list(sessionId);
        for (const editor of vscode.window.visibleTextEditors) {
            const ranges = list
                .filter((bp) => samePath(bp.file, editor.document.uri.fsPath))
                .map((bp) => new vscode.Range(bp.line - 1, 0, bp.line - 1, 0));
            editor.setDecorations(this.decoration, ranges);
        }
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
        this.decoration.dispose();
        this.changeEmitter.dispose();
    }
}
