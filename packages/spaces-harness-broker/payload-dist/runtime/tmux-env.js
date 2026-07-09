/**
 * Environment scrubbing/sanitization for the tmux client and server. Pure
 * functions extracted from `tmux.ts` (SRP): they decide which inherited env
 * keys to drop before spawning a tmux client/server and how to sanitize the
 * inherited PATH so an outer codex ephemeral arg0 shim never leaks into the
 * runtime-owned tmux server.
 */
const SCRUB_EXACT_KEYS = new Set([
    'BUILD_NUMBER',
    'CI',
    'CLICOLOR_FORCE',
    'CONTINUOUS_INTEGRATION',
    'FORCE_COLOR',
    'GITHUB_ACTIONS',
    'NO_COLOR',
    'RUN_ID',
]);
const SCRUB_PREFIXES = ['AGENTCHAT_', 'AGENT_', 'CODEX_', 'HRC_'];
function shouldScrubInheritedEnvKey(key) {
    return SCRUB_EXACT_KEYS.has(key) || SCRUB_PREFIXES.some((prefix) => key.startsWith(prefix));
}
function scrubInheritedEnv(env) {
    const scrubbed = {};
    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined && !shouldScrubInheritedEnvKey(key)) {
            scrubbed[key] = value;
        }
    }
    return scrubbed;
}
export function listInheritedEnvKeysToScrub(env) {
    const keys = new Set(SCRUB_EXACT_KEYS);
    for (const key of Object.keys(env)) {
        if (shouldScrubInheritedEnvKey(key)) {
            keys.add(key);
        }
    }
    return [...keys].sort();
}
export function sanitizeTmuxClientEnv(env) {
    const sanitized = scrubInheritedEnv(env);
    const sanitizedPath = sanitizeTmuxServerPath(sanitized['PATH']);
    if (!sanitizedPath) {
        const { PATH: _discardedPath, ...withoutPath } = sanitized;
        return withoutPath;
    }
    sanitized['PATH'] = sanitizedPath;
    return sanitized;
}
function isCodexEphemeralPathEntry(entry) {
    return (entry.includes('/tmp/arg0/codex-arg0') ||
        entry.includes('/node_modules/@openai/codex/') ||
        entry.includes('/node_modules/@openai/codex-darwin-arm64/vendor/'));
}
export function sanitizeTmuxServerPath(path) {
    if (!path)
        return undefined;
    const seen = new Set();
    const entries = path
        .split(':')
        .filter((entry) => entry.length > 0)
        .filter((entry) => !isCodexEphemeralPathEntry(entry))
        .filter((entry) => {
        if (seen.has(entry))
            return false;
        seen.add(entry);
        return true;
    });
    return entries.length > 0 ? entries.join(':') : undefined;
}
//# sourceMappingURL=tmux-env.js.map