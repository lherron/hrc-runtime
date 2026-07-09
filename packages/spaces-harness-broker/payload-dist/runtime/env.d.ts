declare const dispatchEnvBrand: unique symbol;
export type DispatchEnv = Readonly<Record<string, string>> & {
    readonly [dispatchEnvBrand]: true;
};
/**
 * The broker spawn environment is a VALIDATED DISJOINT UNION of four channels:
 *
 *   ambientAllowlist ⊎ credentials ⊎ lockedEnv ⊎ dispatchEnv
 *
 * Channels are disjoint by construction — a key present in more than one
 * channel is an ERROR, not a precedence decision. There is no last-write-wins.
 *
 * 1. ambientAllowlist — inherited from the broker's own `process.env`, limited
 *    to a fixed allowlist (HOME PATH SHELL TMPDIR TEMP TMP USER USERNAME TERM
 *    LANG LC_ TZ). NODE_, SSH_AUTH_SOCK, proxy, and XDG_ vars are reserved,
 *    not plain ambient.
 * 2. credentials — a driver-provided map. EMPTY for the codex driver: codex
 *    auth is file-based (auth.json on disk via CODEX_HOME, a lockedEnv path);
 *    no credential ever enters the spawn env. The parameter exists for spec
 *    fidelity / future drivers.
 * 3. lockedEnv — ASP-declared, non-secret config from `spec.process.lockedEnv`.
 * 4. dispatchEnv — per-invocation correlation/handles from the
 *    `InvocationDispatchRequest` envelope (never hashed, never in the spec).
 *
 * Key-class rules (reusing the shared protocol validators): lockedEnv and
 * dispatchEnv keys MUST NOT be ambient, credential, or reserved keys, and
 * dispatchEnv MUST NOT shadow a lockedEnv key (caught here as a collision).
 */
export interface ProcessEnvChannels {
    credentials?: Record<string, string> | undefined;
    lockedEnv?: Record<string, string> | undefined;
    dispatchEnv?: DispatchEnv | undefined;
    /**
     * Ordered directories prepended to the FINAL composed PATH (from
     * `spec.process.pathPrepend`). Applied AFTER the four-channel disjoint-union
     * compose. This is the one controlled mutation of the reserved PATH key — a
     * pathPrepend entry already present in ambient PATH is NOT a collision.
     */
    pathPrepend?: string[] | undefined;
}
export declare function parseDispatchEnv(input: unknown, lockedEnv?: Record<string, string> | undefined): DispatchEnv | undefined;
export declare function buildProcessEnv(channels: ProcessEnvChannels): NodeJS.ProcessEnv;
export {};
//# sourceMappingURL=env.d.ts.map