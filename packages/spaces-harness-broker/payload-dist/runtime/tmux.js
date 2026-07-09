import { BrokerErrorCode } from 'spaces-harness-broker-protocol';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrokerError } from '../errors';
import { sanitizeTmuxClientEnv } from './tmux-env';
import { PANE_IDENTITY_FORMAT, parsePaneIdentity } from './tmux-parse';
// sendPastedLine submit tuning (T-01734, hardened T-01747). The launch command is
// pasted into the leased pane, then Enter is pressed to submit it. Two failure
// modes are handled deterministically via capture-pane signals instead of blind
// timers:
//   1. paste-buffer is DROPPED entirely if the leased pane's shell PTY is not yet
//      reading on a cold launch — so we (re)paste, discarding any partial with
//      C-c first, until the command actually renders at the prompt. This replaces
//      the codex driver's blind pre-paste sleep AND the bare-shell fallout that
//      a dropped paste left behind.
//   2. once present, Enter is pressed and we confirm the command line left the
//      prompt, re-pressing Enter (bounded) while it is still sitting there.
// PASTE_RENDER_TIMEOUT_MS is the per-attempt budget for a paste to render: a paste
// that lands matches within a poll or two; a dropped paste burns this budget then
// triggers a re-paste. MAX_PASTE_ATTEMPTS bounds the cold-start wait.
const PASTE_RENDER_TIMEOUT_MS = 1_500;
const MAX_PASTE_ATTEMPTS = 5;
const PRESENT_POLL_INTERVAL_MS = 150;
const SUBMIT_CONFIRM_TIMEOUT_MS = 1_500;
const SUBMIT_POLL_INTERVAL_MS = 150;
const MAX_SUBMIT_ATTEMPTS = 5;
// Used only when the lease does not grant capture (we cannot observe the pane).
const LEGACY_PASTE_GAP_MS = 1_000;
// Trailing window of the pasted command used as the present / still-unexecuted
// needle (whitespace-stripped so terminal line-wrap inside the window never breaks
// the match — capture-pane hard-wraps long commands at pane width).
const COMMAND_TAIL_LEN = 60;
export class TmuxPaneController {
    socketPath;
    tmuxBinary;
    execImpl;
    lease;
    constructor(options) {
        this.socketPath = options.socketPath;
        this.tmuxBinary = options.tmuxBin ?? 'tmux';
        this.execImpl = options.exec ?? createDefaultTmuxExec();
        this.lease = options.lease;
        const { allowedOps } = this.lease;
        if (allowedOps.inspect !== true) {
            throw new BrokerError(BrokerErrorCode.CapabilityDenied, 'inspect requires allowedOps.inspect');
        }
        if (allowedOps.sendInput !== true) {
            throw new BrokerError(BrokerErrorCode.CapabilityDenied, 'sendInput requires allowedOps.sendInput');
        }
        if (allowedOps.sendInterrupt !== true) {
            throw new BrokerError(BrokerErrorCode.CapabilityDenied, 'sendInterrupt requires allowedOps.sendInterrupt');
        }
    }
    async inspect() {
        const result = await this.exec([
            'display-message',
            '-p',
            '-t',
            this.lease.paneId,
            '-F',
            PANE_IDENTITY_FORMAT,
        ]);
        const { sessionId, windowId, paneId } = parsePaneIdentity(result.stdout);
        return { paneId, sessionId, windowId, alive: true };
    }
    async sendLiteral(text) {
        if (text.length === 0) {
            return;
        }
        await this.exec(['send-keys', '-l', '-t', this.lease.paneId, text]);
    }
    async sendEnter() {
        await this.exec(['send-keys', '-t', this.lease.paneId, 'Enter']);
    }
    async sendKeys(keys) {
        if (keys.length === 0) {
            return;
        }
        await this.pasteBuffer(keys);
        await sleep(1_000);
        await this.sendEnter();
    }
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
    async sendPastedLine(text) {
        const tail = commandTail(text);
        // No capture → cannot observe the pane; best-effort single blind submit.
        if (this.lease.allowedOps.capture !== true) {
            await this.pasteBuffer(text);
            await sleep(LEGACY_PASTE_GAP_MS);
            await this.sendEnter();
            return;
        }
        // Step 1: (re)paste until the command is present at the prompt.
        let present = false;
        for (let attempt = 0; attempt < MAX_PASTE_ATTEMPTS; attempt++) {
            if (attempt > 0) {
                await this.discardPromptLine();
            }
            await this.pasteBuffer(text);
            const rendered = await this.waitForPane((pane) => normalizePane(pane).includes(tail), PASTE_RENDER_TIMEOUT_MS, PRESENT_POLL_INTERVAL_MS);
            if (rendered === true) {
                present = true;
                break;
            }
        }
        if (!present) {
            // Never rendered within budget: best-effort single Enter, no worse than legacy.
            await this.sendEnter();
            return;
        }
        // Step 2: submit and confirm the command line advanced past the prompt.
        // Because we know the command WAS present, "no longer ends with the command"
        // now reliably means it was accepted (the prompt advanced or a program took
        // over the pane), not merely that it has not been typed yet.
        for (let attempt = 0; attempt < MAX_SUBMIT_ATTEMPTS; attempt++) {
            await this.sendEnter();
            const advanced = await this.waitForPane((pane) => !normalizePane(pane).endsWith(tail), SUBMIT_CONFIRM_TIMEOUT_MS, SUBMIT_POLL_INTERVAL_MS);
            if (advanced === true) {
                return;
            }
        }
    }
    /** load-buffer + paste-buffer the text into the leased pane (not yet submitted). */
    async pasteBuffer(text) {
        const bufferName = `harness-broker-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const tempDir = await mkdtemp(join(tmpdir(), 'harness-broker-paste-'));
        const tempFile = join(tempDir, 'input.txt');
        let bufferLoaded = false;
        try {
            await writeFile(tempFile, text, { mode: 0o600 });
            await chmod(tempFile, 0o600);
            await this.exec(['load-buffer', '-b', bufferName, tempFile]);
            bufferLoaded = true;
            await this.exec(['paste-buffer', '-d', '-b', bufferName, '-t', this.lease.paneId]);
            bufferLoaded = false;
        }
        finally {
            await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
            if (bufferLoaded) {
                await this.exec(['delete-buffer', '-b', bufferName]).catch(() => undefined);
            }
        }
    }
    /**
     * Abort any partially-rendered paste with C-c so a re-paste starts from a clean
     * prompt and never concatenates onto a stale fragment (which would submit a
     * malformed command line). Safe here: only the pane's shell is at the prompt —
     * the harness has not started yet.
     */
    async discardPromptLine() {
        await this.exec(['send-keys', '-t', this.lease.paneId, 'C-c']);
    }
    /** Best-effort capture for submit confirmation; undefined if denied/failed. */
    async captureForSubmit() {
        if (this.lease.allowedOps.capture !== true) {
            return undefined;
        }
        try {
            const result = await this.exec(['capture-pane', '-t', this.lease.paneId, '-p', '-S', '-200']);
            return result.stdout;
        }
        catch {
            return undefined;
        }
    }
    /**
     * Poll capture-pane until `predicate` holds. Returns true on match, false on
     * timeout, or 'no-capture' when the lease cannot observe the pane.
     */
    async waitForPane(predicate, timeoutMs, intervalMs) {
        if (this.lease.allowedOps.capture !== true) {
            return 'no-capture';
        }
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const pane = await this.captureForSubmit();
            if (pane !== undefined && predicate(pane)) {
                return true;
            }
            if (Date.now() >= deadline) {
                return false;
            }
            await sleep(intervalMs);
        }
    }
    async interrupt() {
        await this.exec(['send-keys', '-t', this.lease.paneId, 'C-c']);
    }
    async capture() {
        if (this.lease.allowedOps.capture !== true) {
            throw new BrokerError(BrokerErrorCode.CapabilityDenied, 'capture requires allowedOps.capture');
        }
        const result = await this.exec(['capture-pane', '-t', this.lease.paneId, '-p']);
        return result.stdout;
    }
    async resize(_size) {
        if (this.lease.allowedOps.resize !== true) {
            throw new BrokerError(BrokerErrorCode.CapabilityDenied, 'resize requires allowedOps.resize');
        }
    }
    async exec(args) {
        return this.execImpl([this.tmuxBinary, '-S', this.socketPath, ...args], {
            env: sanitizeTmuxClientEnv(process.env),
        });
    }
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * Strip ALL whitespace (including terminal line-wrap newlines) so capture-pane
 * content can be matched regardless of pane width. capture-pane hard-wraps a long
 * pasted command at the pane width with a newline the original command never had;
 * collapsing those wraps to a SPACE would corrupt the content (e.g. ".../codex.lau\nnch.json"
 * -> ".../codex.lau nch.json"), breaking a substring/suffix match whenever a wrap
 * falls inside the needle. Removing whitespace from both haystack and needle is
 * wrap-agnostic for presence checks on space-free command tails (paths/flags).
 */
function normalizePane(text) {
    return text.replace(/\s+/g, '');
}
/** Trailing window of the pasted command used as the settled/unexecuted needle. */
function commandTail(text) {
    const normalized = normalizePane(text);
    return normalized.slice(-Math.min(normalized.length, COMMAND_TAIL_LEN));
}
function createDefaultTmuxExec() {
    return async (argv, options) => {
        const spawnOptions = options?.env === undefined
            ? { stdout: 'pipe', stderr: 'pipe' }
            : { env: options.env, stdout: 'pipe', stderr: 'pipe' };
        const proc = Bun.spawn(argv, spawnOptions);
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        if (exitCode !== 0) {
            const rendered = stderr.trim() || stdout.trim() || `tmux exited with status ${exitCode}`;
            throw new Error(rendered);
        }
        return { stdout, stderr };
    };
}
export function createTmuxPaneController(options) {
    return new TmuxPaneController(options);
}
//# sourceMappingURL=tmux.js.map
