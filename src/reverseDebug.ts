import * as vscode from 'vscode';
import { GdbCommandRunner } from './gdbConsole';

export type RecordMethod = 'full' | 'btrace';

interface SessionRecordState {
    recording: boolean;
    method?: RecordMethod;
}

const REJECTED_RE = /^(undefined|ambiguous) command|not supported|not currently recording|no record history/i;

/**
 * Drives GDB's process-record-and-replay ("reverse debugging"): starting and
 * stopping recording, plus the reverse-execution commands
 * (reverse-continue / reverse-next / reverse-step / reverse-stepi /
 * reverse-finish). None of this has a first-class DAP request in cppdbg/
 * MIEngine, so every command goes through the GDB CLI via {@link GdbCommandRunner}.
 * The resulting stop/continue events still flow through the normal DAP
 * 'continued'/'stopped' events (MIEngine forwards those for any GDB-state
 * change regardless of what triggered it), so the rest of the extension
 * (call stack, Live Watch refresh) keeps working unmodified.
 */
export class ReverseDebugController implements vscode.Disposable {
    private readonly states = new Map<string, SessionRecordState>();
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changeEmitter.event;

    constructor(private readonly runner: GdbCommandRunner) {}

    isRecording(sessionId: string | undefined): boolean {
        return !!sessionId && !!this.states.get(sessionId)?.recording;
    }

    recordMethod(sessionId: string | undefined): RecordMethod | undefined {
        return sessionId ? this.states.get(sessionId)?.method : undefined;
    }

    forgetSession(sessionId: string): void {
        if (this.states.delete(sessionId)) {
            this.changeEmitter.fire();
        }
    }

    async startRecording(session: vscode.DebugSession, method: RecordMethod): Promise<void> {
        const text = await this.runner.run(session, `record ${method}`);
        // "target does not support ... record" / "You can't do that without a process" etc.
        if (REJECTED_RE.test(text) || /you can't do that|not supported|failed|error/i.test(text)) {
            throw new Error(text || 'GDB rejected the record command.');
        }
        this.states.set(session.id, { recording: true, method });
        this.changeEmitter.fire();
    }

    async stopRecording(session: vscode.DebugSession): Promise<void> {
        const text = await this.runner.run(session, 'record stop');
        if (/^(undefined|ambiguous) command/i.test(text)) {
            throw new Error(text);
        }
        this.states.set(session.id, { recording: false });
        this.changeEmitter.fire();
    }

    private async reverseExec(session: vscode.DebugSession, command: string): Promise<void> {
        if (!this.isRecording(session.id)) {
            throw new Error('Start recording first (GDB "record") — reverse execution needs recorded history.');
        }
        const text = await this.runner.run(session, command);
        if (REJECTED_RE.test(text)) {
            throw new Error(text || `GDB rejected '${command}'.`);
        }
    }

    reverseContinue(session: vscode.DebugSession): Promise<void> {
        return this.reverseExec(session, 'reverse-continue');
    }
    reverseNext(session: vscode.DebugSession): Promise<void> {
        return this.reverseExec(session, 'reverse-next');
    }
    reverseStep(session: vscode.DebugSession): Promise<void> {
        return this.reverseExec(session, 'reverse-step');
    }
    reverseStepInstruction(session: vscode.DebugSession): Promise<void> {
        return this.reverseExec(session, 'reverse-stepi');
    }
    reverseFinish(session: vscode.DebugSession): Promise<void> {
        return this.reverseExec(session, 'reverse-finish');
    }

    dispose(): void {
        this.changeEmitter.dispose();
    }
}
