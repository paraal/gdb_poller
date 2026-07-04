import * as vscode from 'vscode';
import { GdbCommandRunner } from './gdbConsole';

export type WatchpointKind = 'write' | 'read' | 'access';

export interface Watchpoint {
    /** GDB breakpoint number. */
    id: number;
    expression: string;
    kind: WatchpointKind;
    enabled: boolean;
}

const KIND_COMMAND: Record<WatchpointKind, string> = {
    write: 'watch',
    read: 'rwatch',
    access: 'awatch'
};

export const WATCHPOINT_KIND_LABEL: Record<WatchpointKind, string> = {
    write: 'Write',
    read: 'Read',
    access: 'Read/Write'
};

/** GDB confirmation text, e.g. "Hardware watchpoint 3: foo" / "Watchpoint 3: foo". */
const CONFIRM_RE = /(?:hardware\s+)?(?:read\s+|access\s+)?watchpoint\s+(\d+):/i;

/**
 * Manages GDB watchpoints (`watch` / `rwatch` / `awatch`): stop-on-write,
 * stop-on-read and stop-on-access breakpoints on an expression. cppdbg/
 * MIEngine has no first-class DAP surface for these (its "Break on Value
 * Change" only supports write-watchpoints on a live variablesReference), so
 * every operation goes through the GDB CLI via {@link GdbCommandRunner}. The
 * tracked list is reconciled against `info watchpoints` whenever the target
 * stops, so a watchpoint disappears once GDB reports it hit-and-removed
 * (software watchpoints in particular are one-shot on some targets).
 */
export class WatchpointManager implements vscode.Disposable {
    private readonly bySession = new Map<string, Watchpoint[]>();
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changeEmitter.event;

    constructor(private readonly runner: GdbCommandRunner) {}

    list(sessionId: string | undefined): Watchpoint[] {
        return (sessionId ? this.bySession.get(sessionId) : undefined) ?? [];
    }

    async add(session: vscode.DebugSession, expression: string, kind: WatchpointKind): Promise<Watchpoint> {
        const text = await this.runner.run(session, `${KIND_COMMAND[kind]} ${expression}`);
        const m = text.match(CONFIRM_RE);
        if (!m) {
            throw new Error(text || `GDB did not confirm the watchpoint on '${expression}'.`);
        }
        const wp: Watchpoint = { id: Number(m[1]), expression, kind, enabled: true };
        const list = this.bySession.get(session.id) ?? [];
        list.push(wp);
        this.bySession.set(session.id, list);
        this.changeEmitter.fire();
        return wp;
    }

    async remove(session: vscode.DebugSession, wp: Watchpoint): Promise<void> {
        await this.runner.run(session, `delete ${wp.id}`);
        const list = this.bySession.get(session.id) ?? [];
        this.bySession.set(session.id, list.filter((w) => w.id !== wp.id));
        this.changeEmitter.fire();
    }

    async setEnabled(session: vscode.DebugSession, wp: Watchpoint, enabled: boolean): Promise<void> {
        await this.runner.run(session, `${enabled ? 'enable' : 'disable'} ${wp.id}`);
        wp.enabled = enabled;
        this.changeEmitter.fire();
    }

    /** Reconciles the tracked list against `info watchpoints` (drops hit/auto-deleted ones). */
    async refresh(session: vscode.DebugSession): Promise<void> {
        const known = this.bySession.get(session.id);
        if (!known || known.length === 0) {
            return;
        }
        const text = await this.runner.run(session, 'info watchpoints').catch(() => '');
        const stillThere = new Map<number, boolean>();
        for (const m of text.matchAll(/^(\d+)\s+(?:hw |read |acc(?:ess)? )*watchpoint\s+(?:keep|del)\s+([yn])\b/gim)) {
            stillThere.set(Number(m[1]), m[2].toLowerCase() === 'y');
        }
        const remaining = known.filter((wp) => stillThere.has(wp.id));
        for (const wp of remaining) {
            wp.enabled = stillThere.get(wp.id) ?? wp.enabled;
        }
        this.bySession.set(session.id, remaining);
        this.changeEmitter.fire();
    }

    forgetSession(sessionId: string): void {
        if (this.bySession.delete(sessionId)) {
            this.changeEmitter.fire();
        }
    }

    dispose(): void {
        this.changeEmitter.dispose();
    }
}

export class WatchpointTreeProvider implements vscode.TreeDataProvider<Watchpoint> {
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changeEmitter.event;

    constructor(private readonly manager: WatchpointManager) {
        manager.onDidChange(() => this.changeEmitter.fire());
        vscode.debug.onDidChangeActiveDebugSession(() => this.changeEmitter.fire());
    }

    getChildren(): Watchpoint[] {
        return this.manager.list(vscode.debug.activeDebugSession?.id);
    }

    getTreeItem(wp: Watchpoint): vscode.TreeItem {
        const item = new vscode.TreeItem(wp.expression, vscode.TreeItemCollapsibleState.None);
        item.id = `wp-${wp.id}`;
        item.description = `${WATCHPOINT_KIND_LABEL[wp.kind]}${wp.enabled ? '' : ' (disabled)'}`;
        item.contextValue = `gdbLiveWatch.watchpoint.${wp.enabled ? 'enabled' : 'disabled'}`;
        const iconId = wp.kind === 'read' ? 'eye' : wp.kind === 'access' ? 'sync' : 'edit';
        item.iconPath = new vscode.ThemeIcon(
            iconId,
            wp.enabled ? undefined : new vscode.ThemeColor('disabledForeground')
        );
        item.tooltip = `GDB breakpoint #${wp.id} — ${WATCHPOINT_KIND_LABEL[wp.kind]} watchpoint on '${wp.expression}'`;
        return item;
    }
}
