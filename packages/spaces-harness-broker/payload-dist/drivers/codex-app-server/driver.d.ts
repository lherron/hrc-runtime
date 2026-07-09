import type { CodexAppServerDriverSpec, HarnessInvocationSpec } from 'spaces-harness-broker-protocol';
import type { Driver } from '../driver';
export declare function createCodexAppServerDriver(): Driver;
type DiagnosticEmitter = (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
/**
 * Tolerantly validate the Codex `initialize` handshake response.
 *
 * - A clearly-unsupported `protocolVersion` (a string that does not carry the
 *   `codex-app-server/` namespace) is a hard failure: throw HarnessError so the
 *   broker fails the invocation predictably rather than driving an incompatible
 *   server.
 * - A present-but-non-string `protocolVersion`, or a non-object response, is
 *   suspicious but non-critical — emit a `warn` diagnostic and continue.
 * - A missing `protocolVersion` is loose-but-common (do not overfit to the fake
 *   server) — emit a `debug` diagnostic and continue.
 */
export declare function validateInitializeHandshake(result: unknown, emitDiagnostic: DiagnosticEmitter): void;
/**
 * Build `thread/start` params from the driver spec. Every driver-spec field is
 * either forwarded to the native call or deliberately handled elsewhere:
 *  - model / approvalPolicy / sandboxMode: forwarded here.
 *  - profile: forwarded here (Codex app-server selects a config profile).
 *  - modelReasoningEffort: forwarded as a thread-scope `config` override here
 *    AND applied per-turn in buildTurnStartParams(effort).
 *  - defaultImageAttachments: applied per-turn in buildTurnStartParams.
 *  - resumeThreadId / resumeFallback / permissionPolicy: consumed by the driver
 *    resume + permission paths, not by thread/start.
 */
export declare function buildThreadStartParams(spec: HarnessInvocationSpec, driver: CodexAppServerDriverSpec): Record<string, unknown>;
export {};
//# sourceMappingURL=driver.d.ts.map