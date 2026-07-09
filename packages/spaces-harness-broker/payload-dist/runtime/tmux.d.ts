export type RestartStyle = 'reuse_pty' | 'fresh_pty';
export type TmuxExecResult = {
    stdout: string;
    stderr: string;
};
export type TmuxExec = (argv: string[], options?: {
    env?: Record<string, string | undefined> | undefined;
}) => Promise<TmuxExecResult>;
export type TmuxPaneAllowedOps = {
    inspect?: boolean | undefined;
    sendInput?: boolean | undefined;
    sendInterrupt?: boolean | undefined;
    capture?: boolean | undefined;
    resize?: boolean | undefined;
};
export type TmuxPaneControllerLease = {
    paneId: string;
    sessionId: string;
    windowId: string;
    sessionName?: string | undefined;
    windowName?: string | undefined;
    allowedOps: TmuxPaneAllowedOps;
};
export type TmuxPaneControllerOptions = {
    socketPath: string;
    tmuxBin?: string | undefined;
    exec?: TmuxExec | undefined;
    lease: TmuxPaneControllerLease;
};
export type TmuxPaneInspection = {
    paneId: string;
    sessionId: string;
    windowId: string;
    alive: boolean;
};
export type TmuxPaneResize = {
    columns?: number | undefined;
    rows?: number | undefined;
};
export declare class TmuxPaneController {
    private readonly socketPath;
    private readonly tmuxBinary;
    private readonly execImpl;
    private readonly lease;
    constructor(options: TmuxPaneControllerOptions);
    inspect(): Promise<TmuxPaneInspection>;
    sendLiteral(text: string): Promise<void>;
    sendEnter(): Promise<void>;
    sendKeys(keys: string): Promise<void>;
    /**
     * Paste-confirm-submit (T-01734, hardened T-01747): land the launch command at
     * the leased pane's prompt and submit it using deterministic capture-pane
     * signals — no blind timers.
     *
     * 1. (Re)paste until the command renders at the prompt. paste-buffer is dropped
     *    if the pane's shell PTY is not yet reading on a cold launch, so a single
     *    paste can silently vanish; we re-paste (discarding any partial fragment
     *    with C-c first, so a re-paste never concatenates onto a stale line) until
     *    the command is observed present. This replaces the codex driver's blind
     *    pre-paste sleep and removes the bare-shell fallout of a dropped paste.
     * 2. Press Enter and confirm the command left the prompt; re-press Enter
     *    (bounded) while it is still sitting there (a swallowed Enter). Once the
     *    line advances we stop, so no stray Enter is injected into the launched
     *    program.
     *
     * Degrades to a single blind paste + gap + Enter when the lease cannot observe
     * the pane (no capture).
     */
    sendPastedLine(text: string): Promise<void>;
    /** load-buffer + paste-buffer the text into the leased pane (not yet submitted). */
    private pasteBuffer;
    /**
     * Abort any partially-rendered paste with C-c so a re-paste starts from a clean
     * prompt and never concatenates onto a stale fragment (which would submit a
     * malformed command line). Safe here: only the pane's shell is at the prompt —
     * the harness has not started yet.
     */
    private discardPromptLine;
    /** Best-effort capture for submit confirmation; undefined if denied/failed. */
    private captureForSubmit;
    /**
     * Poll capture-pane until `predicate` holds. Returns true on match, false on
     * timeout, or 'no-capture' when the lease cannot observe the pane.
     */
    private waitForPane;
    interrupt(): Promise<void>;
    capture(): Promise<string>;
    resize(_size: TmuxPaneResize): Promise<void>;
    private exec;
}
export declare function createTmuxPaneController(options: TmuxPaneControllerOptions): TmuxPaneController;
//# sourceMappingURL=tmux.d.ts.map
