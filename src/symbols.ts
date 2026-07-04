import * as vscode from 'vscode';
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

/**
 * True when a path points inside a dSPACE toolchain folder (VEOS, etc.). Used to
 * single out the dSPACE model modules (the .dll/.vap that actually carry the
 * release-specific debug symbols) from the many system DLLs a host process loads.
 */
export function isDspacePath(p: string | undefined): boolean {
    return !!p && /[\\/]dspace[\\/]/i.test(p);
}

/**
 * Derives the dSPACE model name (e.g. "MB_ZC_Rear_vECU") from a set of loaded
 * modules by picking the dSPACE-folder module that carries the symbols. A `.dll`
 * under the dSPACE tree is preferred; a `.vap` is used as a fallback. Returns the
 * basename without extension, or undefined when no dSPACE module is present.
 */
export function dspaceModelName(
    modules: Array<{ name?: string; path?: string }>
): string | undefined {
    const dspace = modules.filter((m) => isDspacePath(m.path) || isDspacePath(m.name));
    const pick =
        dspace.find((m) => /\.dll$/i.test(m.path ?? m.name ?? '')) ??
        dspace.find((m) => /\.vap$/i.test(m.path ?? m.name ?? '')) ??
        dspace[0];
    const source = pick?.path ?? pick?.name;
    if (!source) {
        return undefined;
    }
    const base = source.split(/[\\/]/).pop() ?? source;
    return base.replace(/\.[^.]+$/, '');
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

function escapeGdbRegexLiteral(value: string): string {
    return value.replace(/[\\.^$*+?()[\]{}|]/g, '\\$&');
}

/**
 * Builds the regexp passed to GDB's `info variables/functions REGEXP` form.
 * For plain symbol names and pasted declarations/calls, use a literal symbol
 * token so GDB can reduce the listing at the source. For explicit regex-looking
 * filters, keep the user's expression and let the local matcher apply the final
 * semantics after GDB has returned the narrower candidate set.
 */
function makeGdbNameRegexp(filter: string): string | undefined {
    const strippedCall = filter.replace(/\s*\([^)]*\)\s*$/, '').trim();
    const candidate = strippedCall || filter.trim();
    if (!candidate || /[\r\n]/.test(candidate)) {
        return undefined;
    }

    const hasRegexMeta = /[\\.^$*+?()[\]{}|]/.test(candidate);
    if (hasRegexMeta) {
        try {
            new RegExp(candidate);
            return candidate;
        } catch {
            return escapeGdbRegexLiteral(candidate);
        }
    }

    const identifiers = candidate.match(/[A-Za-z_~][A-Za-z0-9_:~]*/g);
    const token = identifiers?.[identifiers.length - 1] ?? candidate;
    return escapeGdbRegexLiteral(token);
}

/**
 * Loads the target's symbol table (variables, functions, constants, types)
 * through GDB console commands, similar to winIDEA's Symbol Browser.
 *
 * The raw GDB listings are fetched fresh from GDB on every load. Name filters
 * can also run a narrower GDB regexp query through {@link loadFiltered}.
 */
const FAVORITES_KEY = 'gdbSymbols.favorites';
const FILTER_HISTORY_KEY = 'gdbSymbols.filterHistory';
const MAX_FILTER_HISTORY = 20;

export interface SymbolLoadTiming {
    durationMs: number;
    entries: number;
    /** Present when the last GDB query loaded only names matching this filter. */
    filter?: string;
    /** The regexp sent to GDB for a filtered query. */
    gdbRegexp?: string;
}

interface FilteredSymbolSet {
    sessionId: string;
    filter: string;
    gdbRegexp: string;
    entries: SymbolEntry[];
}

export class SymbolService implements vscode.Disposable {
    /**
     * Symbol table as parsed from GDB (sorted by name).
     */
    private allEntries: SymbolEntry[] = [];
    /** Candidate set loaded through `info variables/functions REGEXP` for the active filter. */
    private filteredEntries?: FilteredSymbolSet;
    /** Session the loaded table belongs to. */
    private loadedSessionId?: string;
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

    /**
     * Timing of the most recent symbol load (GDB query), for performance
     * comparison. Undefined until the first load.
     */
    private _lastLoad?: SymbolLoadTiming;

    get lastLoad(): SymbolLoadTiming | undefined {
        return this._lastLoad;
    }

    /**
     * Timing of the most recent local view rebuild (filter / settings applied to
     * the already-loaded table). Unlike `lastLoad` this updates on every filter
     * change, so it reflects the cost of the *current* filter rather than the
     * one-time symbol load. `visible` is the number of symbols left after
     * filtering. Undefined until the first view is built.
     */
    private _lastViewBuild?: { durationMs: number; visible: number };

    get lastViewBuild(): { durationMs: number; visible: number } | undefined {
        return this._lastViewBuild;
    }

    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changeEmitter.event;

    constructor(
        private readonly tracker: DebugSessionTracker,
        private readonly poller: Poller,
        private readonly state: vscode.Memento
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

    /** Local filter (regex or substring) applied to the loaded table - instant. */
    get filter(): string {
        return this._filter;
    }

    set filter(value: string) {
        if (this._filter !== value) {
            this._filter = value;
            if (!value || this.filteredEntries?.filter !== value) {
                this.filteredEntries = undefined;
            }
            this.refreshView();
        }
    }

    /** True once a symbol table has been loaded for some session. */
    get hasData(): boolean {
        return this.allEntries.length > 0 || this.filteredEntries !== undefined;
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

    /**
     * Distinct source files (compilation units) that provide the loaded symbols,
     * with the number of variables and functions each contributes. Computed from
     * the currently loaded table - after the source-path filter / dSPACE model
     * scope, but before the name filter and the per-category cap - so it
     * reflects what was actually kept from GDB's response, not just the
     * currently visible (name-filtered/capped) view. Non-debugging symbols
     * (which have no source file) are grouped under a single "no source file"
     * bucket.
     */
    getSourceFileSummary(): Array<{
        file: string;
        variables: number;
        functions: number;
        total: number;
    }> {
        const counts = new Map<string, { variables: number; functions: number }>();
        for (const entry of this.activeEntries()) {
            const key = entry.file ?? '(no source file)';
            let rec = counts.get(key);
            if (!rec) {
                rec = { variables: 0, functions: 0 };
                counts.set(key, rec);
            }
            if (entry.category === 'functions') {
                rec.functions++;
            } else {
                rec.variables++;
            }
        }
        return [...counts.entries()]
            .map(([file, c]) => ({
                file,
                variables: c.variables,
                functions: c.functions,
                total: c.variables + c.functions
            }))
            .sort((a, b) => a.file.localeCompare(b.file));
    }

    /**
     * The modules (main executable + shared libraries / DLLs) the debug adapter
     * reports as loaded into the target, together with where their debug symbols
     * came from. This is what GDB actually reads the source-file names and line
     * numbers out of. Requires a live session; returns an empty list when the
     * adapter does not support the DAP 'modules' request.
     *
     * Only the dSPACE model modules (the .dll/.vap under the dSPACE toolchain
     * tree that carry the release-specific debug symbols) are returned — the many
     * volatile system DLLs a host process loads are filtered out so the symbol
     * source view reflects only the dSPACE model.
     */
    async getModules(session: vscode.DebugSession): Promise<
        Array<{ name: string; path?: string; symbolStatus?: string; symbolFilePath?: string }>
    > {
        try {
            const resp = await session.customRequest('modules', { startModule: 0, moduleCount: 0 });
            const modules = Array.isArray((resp as { modules?: unknown })?.modules)
                ? (resp as { modules: Array<Record<string, unknown>> }).modules
                : [];
            return modules
                .map((m) => ({
                    name: typeof m.name === 'string' ? m.name : String(m.id ?? ''),
                    path: typeof m.path === 'string' ? m.path : undefined,
                    symbolStatus: typeof m.symbolStatus === 'string' ? m.symbolStatus : undefined,
                    symbolFilePath:
                        typeof m.symbolFilePath === 'string' ? m.symbolFilePath : undefined
                }))
                .filter((m) => isDspacePath(m.path) || isDspacePath(m.name));
        } catch {
            return [];
        }
    }

    /**
     * The dSPACE model name (e.g. "MB_ZC_Rear_vECU") derived from the loaded
     * dSPACE module carrying the symbols, or undefined when none is present.
     */
    async getDspaceModelName(session: vscode.DebugSession): Promise<string | undefined> {
        return dspaceModelName(await this.getModules(session));
    }

    clear(): void {
        this.allEntries = [];
        this.filteredEntries = undefined;
        this.loadedSessionId = undefined;
        this.entries.clear();
        this.truncatedCategories.clear();
        this.changeEmitter.fire();
    }

    forgetSession(sessionId: string): void {
        this.prefixCache.delete(sessionId);
        if (this.filteredEntries?.sessionId === sessionId) {
            this.filteredEntries = undefined;
        }
        if (this.loadedSessionId === sessionId) {
            this.loadedSessionId = undefined;
        }
    }

    /**
     * Loads the complete symbol table by querying GDB. The listing is always
     * fetched fresh from GDB, so every release (and every reload) reflects the
     * current target's symbols and line numbers.
     */
    async load(session: vscode.DebugSession, options?: { force?: boolean }): Promise<void> {
        if (this.loading) {
            return;
        }
        this.loading = true;
        let started = false;
        const loadStart = Date.now();
        try {
            const cfg = vscode.workspace.getConfiguration('gdbSymbols');
            const includeNonDebugging = cfg.get<boolean>('includeNonDebugging', false);

            started = true;
            this.changeEmitter.fire();

            const skipNonDebugging = !includeNonDebugging;

            const [vars, funcs] = await this.poller.runReadOperation(session, async () => {
                // Ask GDB to omit non-debugging (minimal) symbols with '-n' when
                // the user does not want them. On a host process that loads many
                // system DLLs those minimal symbols dominate the listing;
                // dropping them at the source (rather than client-side after
                // parsing) means GDB emits far less text and the DAP round-trip
                // is correspondingly faster.
                const v = await this.execInfoListing(session, 'info variables', skipNonDebugging);
                const f = await this.execInfoListing(session, 'info functions', skipNonDebugging);
                return [v, f];
            });
            const listing = { vars, funcs };

            this.allEntries = [
                ...parseSymbolListing(listing.vars, 'variables', { skipNonDebugging }),
                ...parseSymbolListing(listing.funcs, 'functions', { skipNonDebugging })
            ].sort((a, b) => a.name.localeCompare(b.name));
            this.filteredEntries = undefined;
            this.loadedSessionId = session.id;
            this.rebuildView();

            this._lastLoad = {
                durationMs: Date.now() - loadStart,
                entries: this.allEntries.length
            };
        } finally {
            this.loading = false;
            if (started) {
                this.changeEmitter.fire();
            }
        }
    }

    /**
     * Loads only symbols whose names match the filter by using GDB's
     * `info variables/functions REGEXP` form. This is intentionally separate
     * from the full-table load: a filtered query can be much cheaper for a
     * selective name, while clearing the filter returns to the complete table
     * by re-querying GDB.
     */
    async loadFiltered(
        session: vscode.DebugSession,
        filter: string,
        options?: { force?: boolean }
    ): Promise<void> {
        const term = filter.trim();
        if (!term) {
            this.filteredEntries = undefined;
            this.filter = '';
            await this.load(session, options);
            return;
        }

        const gdbRegexp = makeGdbNameRegexp(term);
        if (!gdbRegexp) {
            this.filter = term;
            return;
        }

        if (this.loading) {
            this.filter = term;
            return;
        }
        this.loading = true;
        let started = false;
        const loadStart = Date.now();
        try {
            const cfg = vscode.workspace.getConfiguration('gdbSymbols');
            const includeNonDebugging = cfg.get<boolean>('includeNonDebugging', false);
            const skipNonDebugging = !includeNonDebugging;

            started = true;
            this.changeEmitter.fire();

            const [vars, funcs] = await this.poller.runReadOperation(session, async () => {
                const v = await this.execInfoListing(
                    session,
                    'info variables',
                    skipNonDebugging,
                    gdbRegexp
                );
                const f = await this.execInfoListing(
                    session,
                    'info functions',
                    skipNonDebugging,
                    gdbRegexp
                );
                return [v, f];
            });

            const entries = [
                ...parseSymbolListing(vars, 'variables', { skipNonDebugging }),
                ...parseSymbolListing(funcs, 'functions', { skipNonDebugging })
            ].sort((a, b) => a.name.localeCompare(b.name));

            this._filter = term;
            this.filteredEntries = {
                sessionId: session.id,
                filter: term,
                gdbRegexp,
                entries
            };
            this.rebuildView();
            this._lastLoad = {
                durationMs: Date.now() - loadStart,
                entries: entries.length,
                filter: term,
                gdbRegexp
            };
        } finally {
            this.loading = false;
            if (started) {
                this.changeEmitter.fire();
            }
        }
    }

    // ---- view rebuilding ---------------------------------------------------

    /** Recomputes the visible view from the loaded table (filter/settings changed). */
    refreshView(): void {
        this.rebuildView();
        this.changeEmitter.fire();
    }

    private activeEntries(): readonly SymbolEntry[] {
        if (this.filteredEntries && this.filteredEntries.filter === this._filter) {
            return this.filteredEntries.entries;
        }
        return this.allEntries;
    }

    private rebuildView(): void {
        const viewStart = Date.now();
        const sourceEntries = this.activeEntries();
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
        for (const entry of sourceEntries) {
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

        let visible = 0;
        for (const list of this.entries.values()) {
            visible += list.length;
        }
        this._lastViewBuild = { durationMs: Date.now() - viewStart, visible };
    }

    /**
     * Runs an `info variables` / `info functions` listing, optionally passing the
     * GDB `-n` flag to omit non-debugging (minimal) symbols. `-n` was added in
     * GDB 8.1; on an older GDB the flagged command is rejected (no valid listing),
     * so we transparently fall back to the plain command. The non-debugging
     * symbols are then still filtered out client-side by the parser.
     */
    private async execInfoListing(
        session: vscode.DebugSession,
        command: string,
        skipNonDebugging: boolean,
        nameRegexp?: string
    ): Promise<string> {
        const regexpArg = nameRegexp ? ` ${nameRegexp}` : '';
        if (skipNonDebugging) {
            try {
                return await this.execConsole(session, `${command} -n${regexpArg}`);
            } catch {
                // Older GDB without the '-n' flag: fall back to the plain listing.
            }
        }
        return this.execConsole(session, `${command}${regexpArg}`);
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
