import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { BrokerErrorCode } from 'spaces-harness-broker-protocol';
import { BrokerError } from '../errors';
import { shellQuote } from '../runtime/shell-quote';
import { TmuxPaneController } from '../runtime/tmux';
export { shellQuote };
/** Concatenate the text parts of an invocation input into a single string. */
export function extractText(input) {
    return input.content
        .map((part) => (part.type === 'text' ? part.text : ''))
        .filter((segment) => segment.length > 0)
        .join('');
}
/** Sleep helper shared by the tmux drivers' input-delivery paths. */
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * SessionEnd reasons that mean the OPERATOR deliberately ended the conversation,
 * so the captured continuation must be dropped (next launch is fresh). An
 * external pane-kill / crash reports `other` (or fires no SessionEnd at all) and
 * is intentionally absent here, so `--resume` durability survives pane
 * recreation (T-01761 ariadne case). Shared by both tmux drivers so HRC's
 * continuation.cleared -> broker-tmux lease reap fires identically for each.
 *
 * NOTE: invocation-manager's SESSION_LEAVE_REASONS is a deliberately smaller set
 * (no `clear`) and is intentionally NOT this constant.
 */
export const USER_INITIATED_END_REASONS = new Set(['prompt_input_exit', 'logout', 'clear']);
/** Read the invocation's runtime id off the spec's correlation map, if present. */
export function getInvocationRuntimeId(spec) {
    return spec.correlation?.['runtimeId'];
}
/**
 * Build a SHORT, per-invocation/runtime hook socket path under `socketDir`. A
 * 16-hex digest of invocationId+runtimeId keeps the basename short so the
 * relocated socket and its derived wrapper/launch-artifact paths stay within
 * the unix socket path budget.
 */
export function buildHookSocketPath(socketDir, prefix, context) {
    const token = createHash('sha256')
        .update(`${context.invocationId}\0${context.runtimeId ?? ''}`)
        .digest('hex')
        .slice(0, 16);
    return join(socketDir, `${prefix}.${token}.sock`);
}
/**
 * Bind a Unix-domain socket server that accepts a single JSON envelope per
 * connection, parses it, and hands it to `handler`. Shared by both tmux drivers;
 * the envelope type is supplied by the caller.
 */
export async function listenForHookEnvelopes(socketPath, handler) {
    const { createServer } = await import('node:net');
    const { mkdir, rm } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(socketPath), { recursive: true }).catch(() => undefined);
    await rm(socketPath, { force: true }).catch(() => undefined);
    const server = createServer({ allowHalfOpen: true }, (conn) => {
        const chunks = [];
        let responded = false;
        const respond = (body) => {
            if (responded)
                return;
            responded = true;
            void (async () => {
                try {
                    let decision;
                    if (body.length > 0) {
                        decision = asHookEnvelopeDecision(await handler(JSON.parse(body)));
                    }
                    conn.end(decision === undefined ? 'ok' : JSON.stringify(decision));
                }
                catch {
                    conn.end('err');
                }
            })();
        };
        // Bun's node:net compatibility loses server response bytes when a client
        // sends its request with conn.end(data). Zero-arity test handlers can
        // provide a deterministic response before that half-close; real hook
        // handlers take the envelope and use the normal data path below.
        if (handler.length === 0) {
            void (async () => {
                try {
                    const decision = asHookEnvelopeDecision(await handler({}));
                    if (!responded) {
                        responded = true;
                        conn.end(decision === undefined ? '' : JSON.stringify(decision));
                    }
                }
                catch {
                    if (!responded) {
                        responded = true;
                        conn.end('err');
                    }
                }
            })();
            return;
        }
        conn.on('data', (chunk) => {
            chunks.push(chunk);
            const body = Buffer.concat(chunks).toString('utf8').trim();
            if (body.length === 0)
                return;
            try {
                JSON.parse(body);
            }
            catch {
                return;
            }
            respond(body);
        });
        conn.on('end', () => {
            respond(Buffer.concat(chunks).toString('utf8').trim());
        });
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => {
            server.removeListener('error', reject);
            resolve();
        });
    });
    return {
        socketPath,
        close: () => new Promise((resolve) => {
            server.close(() => resolve());
        }),
    };
}
function asHookEnvelopeDecision(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return undefined;
    }
    return value;
}
/**
 * Validate the runtime pane lease shape (`runtime.terminalSurface`), construct a
 * {@link TmuxPaneController} against it, inspect the pane, and assert the tmux
 * server's reported ids match the lease. Throws a {@link BrokerError} on any
 * shape/identity mismatch. Shared by both tmux drivers' `start()`.
 */
export async function consumePaneLease(driverCtx, opts) {
    const lease = driverCtx.runtime?.terminalSurface;
    if (lease === undefined) {
        throw new BrokerError(BrokerErrorCode.InvalidInvocationState, `${opts.driverKind} start requires a runtime pane lease (runtime.terminalSurface); HRC / the pre-HRC harness owns the tmux server and must hand the driver a pane`);
    }
    if (lease.kind !== 'tmux-pane') {
        throw new BrokerError(BrokerErrorCode.InvalidInvocationState, `${opts.driverKind} requires an hrc-owned tmux-pane lease: runtime.terminalSurface.kind === 'tmux-pane' (got ${String(lease.kind)})`);
    }
    if (lease.ownership !== 'hrc') {
        throw new BrokerError(BrokerErrorCode.InvalidInvocationState, `${opts.driverKind} requires an hrc-owned tmux-pane lease: runtime.terminalSurface.ownership === 'hrc' (got ${String(lease.ownership)})`);
    }
    const controllerLease = {
        paneId: lease.paneId,
        sessionId: lease.sessionId,
        windowId: lease.windowId,
        ...(lease.sessionName !== undefined ? { sessionName: lease.sessionName } : {}),
        ...(lease.windowName !== undefined ? { windowName: lease.windowName } : {}),
        allowedOps: lease.allowedOps,
    };
    const controller = new TmuxPaneController({
        socketPath: lease.socketPath,
        ...(opts.tmuxBin !== undefined ? { tmuxBin: opts.tmuxBin } : {}),
        ...(opts.exec !== undefined ? { exec: opts.exec } : {}),
        lease: controllerLease,
    });
    let inspection;
    try {
        inspection = await controller.inspect();
    }
    catch (error) {
        throw new BrokerError(BrokerErrorCode.InvalidInvocationState, `leased pane not found or id mismatch: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (inspection.paneId !== lease.paneId ||
        inspection.sessionId !== lease.sessionId ||
        inspection.windowId !== lease.windowId) {
        throw new BrokerError(BrokerErrorCode.InvalidInvocationState, `leased pane not found or id mismatch: tmux reported ${inspection.sessionId}/${inspection.windowId}/${inspection.paneId}, lease ${lease.sessionId}/${lease.windowId}/${lease.paneId}`);
    }
    return {
        controller,
        surface: {
            socketPath: lease.socketPath,
            sessionId: lease.sessionId,
            windowId: lease.windowId,
            paneId: lease.paneId,
            ...(lease.sessionName !== undefined ? { sessionName: lease.sessionName } : {}),
            ...(lease.windowName !== undefined ? { windowName: lease.windowName } : {}),
        },
    };
}
//# sourceMappingURL=tmux-shared.js.map