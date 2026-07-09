/**
 * Environment scrubbing/sanitization for the tmux client and server. Pure
 * functions extracted from `tmux.ts` (SRP): they decide which inherited env
 * keys to drop before spawning a tmux client/server and how to sanitize the
 * inherited PATH so an outer codex ephemeral arg0 shim never leaks into the
 * runtime-owned tmux server.
 */
export declare function listInheritedEnvKeysToScrub(env: NodeJS.ProcessEnv): string[];
export declare function sanitizeTmuxClientEnv(env: NodeJS.ProcessEnv): Record<string, string>;
export declare function sanitizeTmuxServerPath(path: string | undefined): string | undefined;
//# sourceMappingURL=tmux-env.d.ts.map