import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { DebugSessionTracker } from './tracker';
import { Poller } from './poller';

export type SymbolCategory = 'variables' | 'constants' | 'functions' | 'types';

export const SYMBOL_CATEGORIES: SymbolCategory[] = ['variables', 'functions'];

export const CATEGORY_LABELS: Record<SymbolCategory, string> = {
    variables: 'Variables',
    constants: 'Constants',
    functions: 'Functions',
    types: 'Types'
};

export interface SymbolEntry {
    name: string;
    /** Full declaration as printed by GDB, e.g. "static const int table[4];". */
    declaration: string;
    category: SymbolCategory;
    /** Source file (compilation unit) the symbol belongs to, if debug info is available. */
    file?: string;
    line?: number;
    /** Set for symbols from the "Non-debugging symbols:" section. */
    address?: string;
    nonDebugging?: boolean;
}

/** Expression to use when adding a symbol to the watch panel. */
export function watchExpressionFor(entry: SymbolEntry): string {
    const fileScoped = vscode.workspace
        .getConfiguration('gdbSymbols')
        .get<boolean>('fileScopedExpressions', false);
    if (fileScoped && entry.file && entry.category !== 'types') {
        // GDB file-scope operator: 'file.c'::symbol - disambiguates statics
        // with the same name in different compilation units.
        return `'${entry.file}'::${entry.name}`;
    }
    return entry.name;
}

// ---------------------------------------------------------------------------
// Parsing of GDB "info variables" / "info functions" / "info types" output
// ---------------------------------------------------------------------------

type ListingKind = 'variables' | 'functions' | 'types';

const LISTING_HEADER =
    /All defined |All (?:variables|functions|types) matching |^File .+:$|Non-debugging symbols:/m;

export function looksLikeListing(text: string): boolean {
    return LISTING_HEADER.test(text);
}

export function parseSymbolListing(
    output: string,
    kind: ListingKind,
    options?: { skipNonDebugging?: boolean }
): SymbolEntry[] {
    const entries: SymbolEntry[] = [];
    let currentFile: string | undefined;
    let nonDebugging = false;

    for (const raw of output.split(/\r?\n/)) {
        const line = raw.trimEnd();
        if (!line) {
            continue;
        }
        if (/^All defined /.test(line) || /^All (variables|functions|types) matching /.test(line)) {
            continue;
        }
        const fileMatch = line.match(/^File (.+):$/);
        if (fileMatch) {
            currentFile = fileMatch[1];
            nonDebugging = false;
            continue;
        }
        if (/^Non-debugging symbols:/.test(line)) {
            // This section is always last in the listing. When the user does not
            // want non-debugging symbols, stop parsing here entirely instead of
            // scanning (and later discarding) potentially thousands of lines.
            if (options?.skipNonDebugging) {
                break;
            }
            nonDebugging = true;
            currentFile = undefined;
            continue;
        }
        if (nonDebugging) {
            const m = line.match(/^(0x[0-9a-fA-F]+)\s+(\S+)/);
            if (m) {
                entries.push({
                    name: m[2],
                    declaration: m[2],
                    category: kind === 'functions' ? 'functions' : 'variables',
                    address: m[1],
                    nonDebugging: true
                });
            }
            continue;
        }

        // Declaration line, optionally prefixed with "NN:" (GDB >= 8.1).
        let decl = line;
        let lineNo: number | undefined;
        const numbered = line.match(/^(\d+):\s*(.*)$/);
        if (numbered) {
            lineNo = Number(numbered[1]);
            decl = numbered[2];
        }
        decl = decl.trim();
        if (!decl || !decl.endsWith(';')) {
            continue;
        }

        const name = extractName(decl, kind);
        if (!name) {
            continue;
        }
        entries.push({ name, declaration: decl, category: kind, file: currentFile, line: lineNo });
    }
    return entries;
}

function extractName(decl: string, kind: ListingKind): string | undefined {
    const s = decl.replace(/;\s*$/, '').trim();
    if (kind === 'functions') {
        return extractFunctionName(s);
    }
    if (kind === 'types') {
        return extractTypeName(s);
    }
    return extractDeclaratorName(s);
}

/** Name of the declared object in a C variable declaration (heuristic). */
function extractDeclaratorName(decl: string): string | undefined {
    let s = decl.replace(/=[^=].*$/, '').trim();
    // Pointer-to-function / pointer-to-array declarator: int (*name)(...) or int (*name)[N]
    const pf = s.match(/\(\s*\*+\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/);
    if (pf) {
        return pf[1];
    }
    s = s.replace(/\[[^\]]*\]/g, '').trim();
    const m = s.match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/);
    return m?.[1];
}

function extractFunctionName(decl: string): string | undefined {
    // Pointer-to-function variable listed under functions: void (*cb)(int)
    const pf = decl.match(/\(\s*\*+\s*([A-Za-z_][\w:]*)\s*\)\s*\(/);
    if (pf) {
        return pf[1];
    }
    // First (possibly qualified) identifier directly before a parameter list.
    const m = decl.match(/([A-Za-z_~][A-Za-z0-9_:~]*)\s*\(/);
    return m?.[1];
}

function extractTypeName(decl: string): string | undefined {
    if (decl.startsWith('typedef')) {
        return extractDeclaratorName(decl);
    }
    const tagged = decl.match(/^(?:struct|union|enum|class)\s+([A-Za-z_][A-Za-z0-9_:<>]*)$/);
    if (tagged) {
        return tagged[1];
    }
    return decl.match(/([A-Za-z_][A-Za-z0-9_:<>]*)\s*$/)?.[1];
}

// ---------------------------------------------------------------------------
// Symbol service
// ---------------------------------------------------------------------------

/** Console-command wrappers to try, per adapter (cppdbg uses '-exec', others vary). */
const COMMAND_PREFIXES = ['-exec ', '', '`'];

function delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

/** Single term matcher: regex if valid, case-insensitive substring otherwise. */
function makeTermMatcher(term: string): (name: string) => boolean {
    try {
        const re = new RegExp(term, 'i');
        return (name) => re.test(name);
    } catch {
        const needle = term.toLowerCase();
        return (name) => name.toLowerCase().includes(needle);
    }
}

/**
 * Builds a name matcher from the user filter: regex if valid, substring otherwise.
 *
 * A trailing call suffix is tolerated so a function can be located by pasting its
 * call/signature, e.g. "Rte_Read_R_FS2()" or "Rte_Read_R_FS2(void)" both match the
 * stored symbol name "Rte_Read_R_FS2". The original filter is still tried as well,
 * so deliberate regex groups like "(foo|bar)" keep working.
 */
function makeMatcher(filter: string): (name: string) => boolean {
    if (!filter) {
        return () => true;
    }
    const matchers = [makeTermMatcher(filter)];
    const stripped = filter.replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (stripped && stripped !== filter) {
        matchers.push(makeTermMatcher(stripped));
    }
    return (name) => matchers.some((m) => m(name));
}

/**
 * Loads the target's symbol table (variables, functions, constants, types)
 * through GDB console commands, similar to winIDEA's Symbol Browser.
 *
 * The complete table is loaded once per debug session and cached; filtering
 * only recomputes the visible view locally, without talking to GDB again.
 */
const FAVORITES_KEY = 'gdbSymbols.favorites';
const FILTER_HISTORY_KEY = 'gdbSymbols.filterHistory';
const MAX_FILTER_HISTORY = 20;

/** Bumped whenever the on-disk cache format or the parser output changes. */
const SYMBOL_CACHE_VERSION = 3;

/** Persisted shape of a cached symbol table on disk. */
interface SymbolCacheFile {
    version: number;
    /** Identity of the binary the table was parsed from. */
    signature: string;
    entries: SymbolEntry[];
}

export class SymbolService implements vscode.Disposable {
    /** Complete, unfiltered symbol table as loaded from GDB (sorted by name). */
    private allEntries: SymbolEntry[] = [];
    /** Session the cached table belongs to. */
    private loadedSessionId?: string;
    /** Identity of the binary the in-memory table was parsed from. */
    private loadedSignature?: string;
    /** Visible (filtered, capped) view, per category. */
    private readonly entries = new Map<SymbolCategory, SymbolEntry[]>();
    private readonly truncatedCategories = new Set<SymbolCategory>();
    /** Favorite entries (subset of the view), in favorite order. */
    private favoriteEntries: SymbolEntry[] = [];
    /** Console-command prefix known to work, cached per session. */
    private readonly prefixCache = new Map<string, string>();

    /** Names the user has starred as favorites (persisted). */
    private favorites: Set<string>;

    private _filter = '';
    loading = false;

    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changeEmitter.event;

    constructor(
        private readonly tracker: DebugSessionTracker,
        private readonly poller: Poller,
        private readonly state: vscode.Memento,
        private readonly cacheDir?: vscode.Uri
    ) {
        this.favorites = new Set(state.get<string[]>(FAVORITES_KEY, []));
    }

    // ---- favorites ----------------------------------------------------------

    isFavorite(name: string): boolean {
        return this.favorites.has(name);
    }

    toggleFavorite(name: string): void {
        if (this.favorites.has(name)) {
            this.favorites.delete(name);
        } else {
            this.favorites.add(name);
        }
        void this.state.update(FAVORITES_KEY, [...this.favorites]);
        this.refreshView();
    }

    get hasFavorites(): boolean {
        return this.favoriteEntries.length > 0;
    }

    getFavorites(): readonly SymbolEntry[] {
        return this.favoriteEntries;
    }

    // ---- filter history -----------------------------------------------------

    getFilterHistory(): string[] {
        return this.state.get<string[]>(FILTER_HISTORY_KEY, []);
    }

    rememberFilter(filter: string): void {
        const term = filter.trim();
        if (!term) {
            return;
        }
        const history = this.getFilterHistory().filter((f) => f !== term);
        history.unshift(term);
        void this.state.update(FILTER_HISTORY_KEY, history.slice(0, MAX_FILTER_HISTORY));
    }

    /** Local filter (regex or substring) applied to the cached table - instant. */
    get filter(): string {
        return this._filter;
    }

    set filter(value: string) {
        if (this._filter !== value) {
            this._filter = value;
            this.refreshView();
        }
    }

    /** True once a symbol table has been loaded for some session. */
    get hasData(): boolean {
        return this.loadedSessionId !== undefined;
    }

    isLoadedFor(sessionId: string): boolean {
        return this.loadedSessionId === sessionId;
    }

    getCategory(category: SymbolCategory): readonly SymbolEntry[] {
        return this.entries.get(category) ?? [];
    }

    isTruncated(category: SymbolCategory): boolean {
        return this.truncatedCategories.has(category);
    }

    clear(): void {
        this.allEntries = [];
        this.loadedSessionId = undefined;
        this.loadedSignature = undefined;
        this.entries.clear();
        this.truncatedCategories.clear();
        this.changeEmitter.fire();
    }

    forgetSession(sessionId: string): void {
        this.prefixCache.delete(sessionId);
        if (this.loadedSessionId === sessionId) {
            this.loadedSessionId = undefined;
            this.loadedSignature = undefined;
        }
    }

    /**
     * Loads the complete symbol table. Skipped when the table is already cached
     * in memory for this session, unless `force` is set (explicit reload).
     *
     * On a cold load it first tries an on-disk cache keyed by the target binary's
     * identity (path + content hash + settings); a hit avoids talking to GDB
     * entirely. On a miss it queries GDB and writes the result back to disk.
     */
    async load(session: vscode.DebugSession, options?: { force?: boolean }): Promise<void> {
        if (this.loading) {
            return;
        }
        this.loading = true;
        let started = false;
        try {
            const includeNonDebugging = vscode.workspace
                .getConfiguration('gdbSymbols')
                .get<boolean>('includeNonDebugging', false);
            const signature = await this.binarySignature(session, includeNonDebugging);

            // In-memory fast path: reuse the cached table only when it belongs to
            // this session *and* was parsed from the same binary. Comparing the
            // signature ensures a different release (a rebuilt or swapped binary,
            // even at the same path) is reloaded instead of being masked by the
            // previously cached symbols.
            if (
                !options?.force &&
                this.isLoadedFor(session.id) &&
                this.allEntries.length > 0 &&
                this.loadedSignature === signature
            ) {
                return;
            }

            started = true;
            this.changeEmitter.fire();

            // Disk fast path: reuse a previously parsed table for the same binary.
            if (!options?.force && signature) {
                const cached = await this.readDiskCache(signature);
                if (cached) {
                    this.allEntries = cached;
                    this.loadedSessionId = session.id;
                    this.loadedSignature = signature;
                    this.rebuildView();
                    return;
                }
            }

            const skipNonDebugging = !includeNonDebugging;
            const [vars, funcs] = await this.poller.runReadOperation(session, async () => {
                const v = await this.execConsole(session, 'info variables');
                const f = await this.execConsole(session, 'info functions');
                return [v, f];
            });

            this.allEntries = [
                ...parseSymbolListing(vars, 'variables', { skipNonDebugging }),
                ...parseSymbolListing(funcs, 'functions', { skipNonDebugging })
            ].sort((a, b) => a.name.localeCompare(b.name));
            this.loadedSessionId = session.id;
            this.loadedSignature = signature;
            this.rebuildView();

            if (signature) {
                void this.writeDiskCache(signature, this.allEntries);
            }
        } finally {
            this.loading = false;
            if (started) {
                this.changeEmitter.fire();
            }
        }
    }

    // ---- on-disk symbol cache ----------------------------------------------

    /**
     * Builds a stable identity string for the binary being debugged, combining
     * its path, a hash of its contents, the identity of the loaded modules and
     * the settings that affect parsing. The content hash (not size/mtime) is
     * what distinguishes two releases, so a rebuilt or swapped binary is always
     * re-parsed. Returns undefined when no binary path is known (then caching is
     * disabled).
     *
     * The main `program` alone is not enough when attaching: in an attach setup
     * the `program` is often a generic *host* process (e.g. VeosVpuHost.exe) that
     * stays byte-for-byte identical across releases, while the release-specific
     * symbols live in a DLL/shared object loaded by that host. Hashing only the
     * host executable therefore made every release collide on the same signature
     * and reuse the first release's cached symbols. Folding in the loaded modules
     * (the DLLs that actually carry the debug symbols) makes each release map to
     * its own cache entry.
     */
    private async binarySignature(
        session: vscode.DebugSession,
        includeNonDebugging: boolean
    ): Promise<string | undefined> {
        if (!this.cacheDir) {
            return undefined;
        }
        const cfg = session.configuration as { program?: string; executable?: string };
        const binPath = cfg.program ?? cfg.executable;
        if (!binPath) {
            return undefined;
        }
        try {
            // Hash the actual binary contents rather than trusting size + mtime.
            // Two different releases can share the same size (firmware images are
            // often padded to a fixed flash layout) and the same mtime (preserved
            // on copy/extract, or coarse filesystem granularity), which made a new
            // release silently reuse the previous release's cached symbols. A
            // content hash is the only reliable way to tell two binaries apart.
            const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(binPath));
            const contentHash = crypto.createHash('sha1').update(bytes).digest('hex');
            const modulesHash = await this.modulesSignature(session, binPath);
            return [
                `v${SYMBOL_CACHE_VERSION}`,
                binPath,
                bytes.byteLength,
                contentHash,
                modulesHash ?? 'nomod',
                includeNonDebugging ? 'nd1' : 'nd0'
            ].join('|');
        } catch {
            // Binary not on the local filesystem (remote target etc.): skip cache.
            return undefined;
        }
    }

    /**
     * Identity of the loaded modules (shared libraries / DLLs) that carry the
     * debug symbols, queried through the DAP 'modules' request. Only modules
     * whose symbols are actually loaded are considered (the release DLLs); they
     * are content-hashed so a swapped release DLL changes the signature. Modules
     * without symbols are ignored on purpose: a live host process loads a large,
     * volatile set of them that would otherwise change the signature every run.
     * Returns undefined when the adapter does not support the request or reports
     * no symbol-bearing modules, in which case the caller falls back to the
     * program-only signature.
     */
    private async modulesSignature(
        session: vscode.DebugSession,
        programPath: string
    ): Promise<string | undefined> {
        let modules: Array<Record<string, unknown>>;
        try {
            const resp = await session.customRequest('modules', { startModule: 0, moduleCount: 0 });
            modules = Array.isArray((resp as { modules?: unknown })?.modules)
                ? ((resp as { modules: Array<Record<string, unknown>> }).modules)
                : [];
        } catch {
            return undefined;
        }
        if (modules.length === 0) {
            return undefined;
        }

        const parts: string[] = [];
        for (const m of modules) {
            const p = typeof m.path === 'string' ? m.path : typeof m.name === 'string' ? m.name : '';
            if (!p) {
                continue;
            }
            const symbolsLoaded =
                typeof m.symbolStatus === 'string' && /loaded/i.test(m.symbolStatus);
            // Only the symbol-bearing modules (the release DLLs) define the cache
            // identity. A live host process loads a large, *volatile* set of other
            // DLLs (system libraries, worker plug-ins) in a different order and
            // count on every run; folding those in made the signature change every
            // time and defeated the cache entirely. The main program is already
            // content-hashed by the caller, so skip it here.
            if (!symbolsLoaded || p === programPath) {
                continue;
            }
            try {
                const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(p));
                const hash = crypto.createHash('sha1').update(bytes).digest('hex');
                parts.push(`${p}#${bytes.byteLength}#${hash}`);
            } catch {
                // Not readable from disk (locked/remote): use cheap identity fields.
                parts.push(`${p}#${String(m.version ?? '')}#${String(m.dateTimeStamp ?? '')}`);
            }
        }

        if (parts.length === 0) {
            return undefined;
        }
        // Order-independent: the module list order from GDB is not guaranteed.
        parts.sort();
        return crypto.createHash('sha1').update(parts.join('|')).digest('hex');
    }

    private cacheUriFor(signature: string): vscode.Uri | undefined {
        if (!this.cacheDir) {
            return undefined;
        }
        const hash = crypto.createHash('sha1').update(signature).digest('hex');
        return vscode.Uri.joinPath(this.cacheDir, `symbols-${hash}.json`);
    }

    private async readDiskCache(signature: string): Promise<SymbolEntry[] | undefined> {
        const uri = this.cacheUriFor(signature);
        if (!uri) {
            return undefined;
        }
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const data = JSON.parse(Buffer.from(bytes).toString('utf8')) as SymbolCacheFile;
            if (data.version !== SYMBOL_CACHE_VERSION || data.signature !== signature) {
                return undefined;
            }
            return Array.isArray(data.entries) && data.entries.length > 0 ? data.entries : undefined;
        } catch {
            return undefined;
        }
    }

    private async writeDiskCache(signature: string, entries: SymbolEntry[]): Promise<void> {
        const uri = this.cacheUriFor(signature);
        if (!uri || entries.length === 0) {
            return;
        }
        try {
            await vscode.workspace.fs.createDirectory(this.cacheDir!);
            const payload: SymbolCacheFile = { version: SYMBOL_CACHE_VERSION, signature, entries };
            await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(payload), 'utf8'));
        } catch {
            // Caching is best-effort; ignore write failures (read-only FS etc.).
        }
    }

    /** Recomputes the visible view from the cached table (filter/settings changed). */
    refreshView(): void {
        this.rebuildView();
        this.changeEmitter.fire();
    }

    private rebuildView(): void {
        const cfg = vscode.workspace.getConfiguration('gdbSymbols');
        const max = Math.max(1, cfg.get<number>('maxSymbolsPerCategory', 2000));
        const includeNonDebugging = cfg.get<boolean>('includeNonDebugging', false);
        const matches = makeMatcher(this._filter);

        this.entries.clear();
        this.truncatedCategories.clear();
        this.favoriteEntries = [];
        for (const category of SYMBOL_CATEGORIES) {
            this.entries.set(category, []);
        }
        for (const entry of this.allEntries) {
            if (entry.nonDebugging && !includeNonDebugging) {
                continue;
            }
            if (this.favorites.has(entry.name)) {
                this.favoriteEntries.push(entry);
            }
            if (!matches(entry.name)) {
                continue;
            }
            const list = this.entries.get(entry.category)!;
            if (list.length >= max) {
                this.truncatedCategories.add(entry.category);
                continue;
            }
            list.push(entry);
        }
    }

    /**
     * Runs a GDB console command through the adapter's REPL and returns its
     * textual output. The output may arrive either as the evaluate response
     * (cortex-debug style) or as DAP 'output' events (cppdbg style).
     */
    private async execConsole(session: vscode.DebugSession, command: string): Promise<string> {
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
                responseText = String(resp?.result ?? '');
            } catch (e) {
                lastError = e;
                capture.stop();
                continue;
            }

            let captured: string;
            if (looksLikeListing(responseText)) {
                captured = capture.stop();
            } else {
                // Output events may trail the response; wait until they settle.
                // Poll on a short interval and break as soon as the captured text
                // stops growing. For a started stream we require two consecutive
                // stable reads (cheap insurance against a pause between bursts);
                // for no output at all we give a brief grace period before giving
                // up on this prefix.
                const cfg = vscode.workspace.getConfiguration('gdbSymbols');
                const pollMs = Math.max(10, cfg.get<number>('settlePollMs', 50));
                const maxMs = Math.max(pollMs, cfg.get<number>('settleMaxMs', 3000));
                const maxIterations = Math.ceil(maxMs / pollMs);
                const graceIterations = Math.max(2, Math.ceil(150 / pollMs));
                let prevLen = -1;
                let stableReads = 0;
                for (let i = 0; i < maxIterations; i++) {
                    await delay(pollMs);
                    const len = capture.peek().length;
                    if (len === prevLen) {
                        if (len > 0) {
                            if (++stableReads >= 2) {
                                break;
                            }
                        } else if (i >= graceIterations) {
                            break;
                        }
                    } else {
                        stableReads = 0;
                    }
                    prevLen = len;
                }
                captured = capture.stop();
            }

            const text = looksLikeListing(responseText)
                ? responseText
                : looksLikeListing(captured)
                    ? captured
                    : '';
            if (text) {
                this.prefixCache.set(session.id, prefix);
                return text;
            }
        }
        throw lastError instanceof Error
            ? lastError
            : new Error(`'${command}' returned no symbol listing (adapter not supported?)`);
    }

    dispose(): void {
        this.changeEmitter.dispose();
    }
}
