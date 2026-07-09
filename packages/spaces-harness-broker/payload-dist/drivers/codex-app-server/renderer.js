import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellQuote } from '../tmux-shared';
import { createCodexTranscriptModel } from './transcript';
/**
 * Build the durable-read projection for one invocation. Live subscription is
 * established BEFORE the `eventsSince` bootstrap so no event slips through the
 * gap between the replay snapshot and the live stream; any replay/live overlap
 * (and any out-of-order live arrival during bootstrap) is reconciled by seq so
 * output is de-duplicated and strictly seq-ordered.
 */
export function createCodexAppServerRendererProjection(options) {
    const { invocationId, readSurface, sink } = options;
    const lines = [];
    const seenSeqs = new Set();
    let bootstrapping = true;
    const deferredLive = [];
    let subscription;
    let closed = false;
    function pushLine(line) {
        lines.push(line);
        sink?.(line);
    }
    // The presentation layer: folds the durable event stream into an
    // hrcchat-turn-style transcript (palette + glyphs + rail, assistant deltas
    // coalesced, tool calls grouped). The projection owns ordering/dedup; the
    // model owns styling.
    const transcript = createCodexTranscriptModel({
        invocationId,
        emit: pushLine,
        ...(options.color !== undefined ? { color: options.color } : {}),
        ...(options.width !== undefined ? { width: options.width } : {}),
    });
    function render(event) {
        if (event.invocationId !== invocationId)
            return;
        if (seenSeqs.has(event.seq))
            return;
        seenSeqs.add(event.seq);
        transcript.apply(event);
    }
    function onLive(event) {
        if (closed)
            return;
        if (event.invocationId !== invocationId)
            return;
        // While bootstrapping, defer live events so they are flushed in seq order
        // AFTER the replay snapshot — never interleaved ahead of it.
        if (bootstrapping) {
            deferredLive.push(event);
            return;
        }
        render(event);
    }
    return {
        async start() {
            subscription = readSurface.observe(onLive);
            try {
                const response = await readSurface.eventsSince({ invocationId, afterSeq: 0 });
                for (const event of [...response.events].sort((a, b) => a.seq - b.seq)) {
                    render(event);
                }
            }
            catch (error) {
                transcript.readFailure(formatReadFailure(error));
            }
            finally {
                bootstrapping = false;
                // Flush any live events captured during bootstrap, in seq order.
                for (const event of deferredLive.sort((a, b) => a.seq - b.seq)) {
                    render(event);
                }
                deferredLive.length = 0;
            }
        },
        lines() {
            return [...lines];
        },
        close() {
            closed = true;
            subscription?.close();
            subscription = undefined;
        },
    };
}
/**
 * Render a durable-read failure VISIBLY (daedalus invariant): a retention-gap
 * (`EventReplayUnavailable`) or any other read-surface error must surface in
 * the renderer output, never be silently dropped.
 */
export function formatReadFailure(error) {
    const err = (error ?? {});
    const code = err.code !== undefined ? String(err.code) : 'unknown';
    const floor = err.data?.retentionFloorSeq;
    const floorNote = floor !== undefined ? ` retentionFloorSeq=${String(floor)}` : '';
    const message = typeof err.message === 'string' ? err.message : String(error);
    return `renderer durable read failed (${code})${floorNote}: ${message}`;
}
/**
 * Resolve the absolute path to the renderer entry process that ships beside
 * this module (`renderer-entry.ts` in dev, `.js` once built by tsc). The launch
 * command invokes it directly inside the leased pane.
 */
export function resolveRendererEntryPath() {
    const self = fileURLToPath(import.meta.url);
    return join(dirname(self), `renderer-entry${extname(self)}`);
}
/**
 * Build the command line pasted into the leased pane to launch the renderer.
 * It names the durable read source explicitly — bootstrap method
 * `invocation.eventsSince` and live notification `invocation.event` — so the
 * launch is self-documenting and a driver-pushed private feed can never satisfy
 * it. Never references `codex-cli-tmux`: the app-server JSON-RPC child stays the
 * harness transport.
 */
export function buildRendererLaunchCommand(options) {
    const entry = options.rendererEntryPath ?? resolveRendererEntryPath();
    return [
        'exec bun',
        shellQuote(entry),
        '--driver codex-app-server',
        `--invocation-id ${shellQuote(options.invocationId)}`,
        `--observer-socket ${shellQuote(options.observerSocketPath)}`,
        `--control-socket ${shellQuote(options.controlSocketPath)}`,
        ...(options.runtimeId !== undefined ? [`--runtime-id ${shellQuote(options.runtimeId)}`] : []),
        '--bootstrap-method invocation.eventsSince',
        '--live-method invocation.event',
    ].join(' ');
}
//# sourceMappingURL=renderer.js.map