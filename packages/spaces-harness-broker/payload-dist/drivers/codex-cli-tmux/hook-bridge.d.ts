/**
 * Broker-owned Codex hook bridge for the pre-HRC codex-cli-tmux path.
 *
 * Codex still uses the ASP/HRC hook materialization shape (`hooks.json` command
 * calls `bun "$HRC_LAUNCH_HOOK_CLI"`), but the driver points that env var at a
 * broker-owned wrapper. This bridge reads the raw Codex hook JSON, wraps it in a
 * broker hook envelope, and posts it to the broker callback socket. It never
 * emits hrc-runtime ingest envelopes and has no hrc-runtime dependency.
 */
export interface CodexHookBridgeOptions {
    socketPath: string;
    stdin?: NodeJS.ReadableStream | undefined;
    env?: Record<string, string | undefined> | undefined;
}
export declare function runCodexHookBridge(options: CodexHookBridgeOptions): Promise<void>;
/** CLI entrypoint: `harness-broker codex-hook --socket <path>`. */
export declare function runCodexHookBridgeCli(args: string[]): Promise<void>;
//# sourceMappingURL=hook-bridge.d.ts.map