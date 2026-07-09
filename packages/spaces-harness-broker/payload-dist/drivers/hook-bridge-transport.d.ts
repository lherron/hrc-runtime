/**
 * Shared transport mechanics for the broker-owned hook bridges (claude-code-tmux
 * and codex-cli-tmux). Both bridges read raw hook JSON on stdin, wrap it in a
 * driver-specific envelope (the builders legitimately diverge — Claude requires
 * a callbackSocket, Codex keeps it optional), and post the serialized envelope
 * to the broker callback unix socket.
 *
 * Only the transport is shared here; the envelope CONTRACT stays per-driver.
 */
/** Drain a readable stream to a UTF-8 string. */
export declare function readAll(stream: NodeJS.ReadableStream): Promise<string>;
/**
 * Parse the raw hook JSON. Empty stdin becomes an empty hook object; a non-JSON
 * payload is forwarded verbatim under `{ raw }` so the broker can diagnose it
 * rather than silently dropping the event.
 */
export declare function parseHookJson(raw: string): unknown;
/** Connect to the broker callback socket and write the serialized envelope. */
export declare function postEnvelope(socketPath: string, envelope: unknown): Promise<void>;
/** Connect to the broker callback socket, write an envelope, and read the response body. */
export declare function postEnvelopeAndRead(socketPath: string, envelope: unknown, options?: {
    timeoutMs?: number | undefined;
}): Promise<string>;
/**
 * Shared CLI entrypoint for the hook bridges. Resolves `--socket <path>`,
 * exits(1) with a usage error if absent, otherwise runs the driver bridge and
 * swallows delivery errors (hooks are best-effort observability, not turn gates).
 */
export declare function runHookBridgeCli(options: {
    commandName: string;
    args: string[];
    run: (params: {
        socketPath: string;
    }) => Promise<void>;
}): Promise<void>;
//# sourceMappingURL=hook-bridge-transport.d.ts.map