import type { CodexAppServerDriverSpec, InputId, PermissionRequestId, TurnId } from 'spaces-harness-broker-protocol';
import type { DriverContext } from '../driver';
import type { JsonRpcRequest } from './rpc-client';
/**
 * Allocates monotonically increasing `permissionRequestId` values for a single
 * invocation. Each invocation owns its own allocator (created via
 * {@link createPermissionRequestIdAllocator}), so the per-request counter is no
 * longer process-global shared state across concurrent invocations or test
 * cases — id sequences start independently per invocation.
 */
export interface PermissionRequestIdAllocator {
    next(invocationId: string): PermissionRequestId;
}
export interface PermissionHandlerContext {
    ctx: DriverContext;
    driver: CodexAppServerDriverSpec;
    currentTurnId: TurnId | undefined;
    currentInputId: InputId | undefined;
    permissionRequestIds: PermissionRequestIdAllocator;
}
/**
 * Build a BOUNDED display subject from a native Codex permission request
 * (CONTRACTS §7.9). This is a positive projection of known-safe fields for the
 * given permission kind — never a copy-everything-then-scrub. The raw native
 * payload is not persisted; only this bounded summary is emitted as
 * `subjectDisplay` and forwarded to the client as the request `subject`.
 */
export declare function buildSubjectDisplay(kind: string, params: unknown): Record<string, unknown>;
/**
 * Create a fresh per-invocation `permissionRequestId` allocator. The counter is
 * encapsulated in the returned closure rather than living at module scope, so
 * separate invocations (and separate test cases) get independent id sequences.
 */
export declare function createPermissionRequestIdAllocator(): PermissionRequestIdAllocator;
/**
 * Handle a permission request from the Codex app-server process.
 *
 * Decision transport is JSON-RPC request/response (broker→client); the
 * `permission.requested` / `permission.resolved` events are audit only. There
 * is no branch where a missing default approves — default-deny everywhere.
 *
 * Modes:
 * - deny: resolve deny by policy.
 * - allow: resolve allow by policy.
 * - ask-client:
 *   - if the client did not negotiate `permissionRequests` (or no request
 *     transport is wired): emit a diagnostic and deny by policy.
 *   - otherwise ask the client via `ctx.requestPermission`, bounded by
 *     `timeoutMs`:
 *       - timeout → defaultDecision (decidedBy `timeout`)
 *       - handler error → defaultDecision (decidedBy `api`)
 *       - valid decision → the client's decision (decidedBy `user`)
 *     where a missing defaultDecision means deny.
 */
export declare function handlePermissionRequest(request: JsonRpcRequest, handlerCtx: PermissionHandlerContext): Promise<unknown>;
//# sourceMappingURL=permissions.d.ts.map