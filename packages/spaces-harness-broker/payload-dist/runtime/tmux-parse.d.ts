export declare const PANE_IDENTITY_FORMAT = "#{session_id}\t#{window_id}\t#{pane_id}";
export declare function parsePaneIdentity(stdout: string): {
    sessionId: string;
    windowId: string;
    paneId: string;
};
//# sourceMappingURL=tmux-parse.d.ts.map