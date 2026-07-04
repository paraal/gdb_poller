import * as vscode from 'vscode';
import { DebugSessionTracker } from './tracker';

/** Console-command prefixes to try, per adapter (cppdbg uses '-exec', others vary). */
const COMMAND_PREFIXES = ['-exec ', '', '`'];

function delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * Runs raw GDB CLI commands (e.g. `tbreak main`, `record full`,
 * `reverse-continue`, `watch foo`) through the active debug adapter's REPL and
 * returns whatever text GDB printed for it. This is the only way to reach GDB
 * features that have no first-class DAP request (process record/replay,
 * temporary breakpoints, watch/rwatch/awatch), the same trick
 * `SymbolService.execConsole` uses for `info variables`/`info functions`.
 *
 * Kept independent from `SymbolService.execConsole`: symbol listings are
 * large/streamed and need generous settle timing, while these are short
 * one-line confirmations, so the two have different tuning needs.
 */
export class GdbCommandRunner {
    private readonly prefixCache = new Map<string, string>();

    constructor(private readonly tracker: DebugSessionTracker) {}

    /**
     * Sends `command` to GDB and returns its textual output (evaluate result
     * and/or captured 'output' events, trimmed). Throws only when the DAP
     * 'evaluate' request itself fails for every adapter prefix; a GDB-level
     * error (e.g. "No symbol \"x\" in current context.") is returned as normal
     * text for the caller to inspect.
     */
    async run(session: vscode.DebugSession, command: string): Promise<string> {
        const cached = this.prefixCache.get(session.id);
        const candidates =
            cached !== undefined
                ? [cached, ...COMMAND_PREFIXES.filter((p) => p !== cached)]
                : [...COMMAND_PREFIXES];

        let lastError: unknown;
        for (const prefix of candidates) {
            const expression = prefix === '`' ? `\`${command}\`` : `${prefix}${command}`;
            const capture = this.tracker.startOutputCapture(session.id);
            let responseText = '';
            try {
                const resp = await session.customRequest('evaluate', {
                    expression,
                    context: 'repl'
                });
                responseText = String(resp?.result ?? '').trim();
            } catch (e) {
                lastError = e;
                capture.stop();
                continue;
            }

            // Give trailing 'output' events (cppdbg/MIEngine console output) a
            // short moment to settle. These are one-line confirmations, not
            // large streamed listings, so a short window is enough.
            let prevLen = -1;
            let stableReads = 0;
            for (let i = 0; i < 20; i++) {
                await delay(50);
                const len = capture.peek().length;
                if (len === prevLen) {
                    if (++stableReads >= 2) {
                        break;
                    }
                } else {
                    stableReads = 0;
                }
                prevLen = len;
            }
            const captured = capture.stop().trim();

            this.prefixCache.set(session.id, prefix);
            return responseText || captured;
        }
        throw lastError instanceof Error
            ? lastError
            : new Error(`'${command}' failed (adapter not supported?)`);
    }
}
