/**
 * Broker-owned Claude hook bridge (H3). The `claude-code-tmux` driver installs
 * a `--settings` hook overlay whose commands invoke this bridge for each Claude
 * hook event (`UserPromptSubmit`/`MessageDisplay`/`PreToolUse`/`Stop`/…). The
 * bridge reads the raw hook JSON on stdin, wraps it in a hook ENVELOPE built
 * from the `HARNESS_BROKER_*` launch env (the real turn id lives at the env
 * level, not in the raw hook JSON — cody's Phase 3 seam), and writes the
 * envelope to the broker callback unix socket.
 *
 * This is the REAL runtime path: there is no hrc-runtime dependency and no TUI
 * stdout parsing — Claude posts hooks out-of-band to the broker socket.
 */
export interface HookBridgeOptions {
    socketPath: string;
    stdin?: NodeJS.ReadableStream | undefined;
    env?: Record<string, string | undefined> | undefined;
}
export declare function runClaudeHookBridge(options: HookBridgeOptions): Promise<void>;
export declare function runClaudeHookDecisionBridge(options: HookBridgeOptions): Promise<void>;
/** CLI entrypoint: `harness-broker claude-hook --socket <path>`. */
export declare function runClaudeHookBridgeCli(args: string[]): Promise<void>;
/** CLI entrypoint: `harness-broker claude-hook-decision --socket <path>`. */
export declare function runClaudeHookDecisionBridgeCli(args: string[]): Promise<void>;
//# sourceMappingURL=hook-bridge.d.ts.map