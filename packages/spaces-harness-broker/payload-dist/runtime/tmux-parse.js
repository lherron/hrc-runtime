/**
 * Pure parsers + format constants for tmux command output. Extracted from
 * `tmux.ts` (SRP): pane-identity parsing and the regex/format string that
 * drives it, with no dependency on the lifecycle or controller classes.
 */
const PANE_IDENTITY_PATTERN = /^(\$\d+)[\t_](@\d+)[\t_](%\d+)$/;
export const PANE_IDENTITY_FORMAT = '#{session_id}\t#{window_id}\t#{pane_id}';
export function parsePaneIdentity(stdout) {
    const line = stdout
        .trim()
        .split('\n')
        .map((entry) => entry.trim())
        .find((entry) => entry.length > 0);
    if (!line) {
        throw new Error('tmux command did not return pane identity');
    }
    const match = PANE_IDENTITY_PATTERN.exec(line);
    if (!match) {
        throw new Error(`unexpected tmux pane identity line: ${line}`);
    }
    const [, sessionId, windowId, paneId] = match;
    if (!sessionId || !windowId || !paneId) {
        throw new Error(`tmux pane identity regex captured empty groups in line: ${line}`);
    }
    return { sessionId, windowId, paneId };
}
//# sourceMappingURL=tmux-parse.js.map