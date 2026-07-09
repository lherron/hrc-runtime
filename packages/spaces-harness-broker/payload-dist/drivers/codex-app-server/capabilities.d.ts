import type { InvocationCapabilities } from 'spaces-harness-broker-protocol';
/**
 * Static capability descriptor for the codex-app-server driver.
 *
 * Kept in its own module so the (immutable) capability surface is declared
 * separately from the driver's lifecycle/RPC logic. Internal-only — consumed
 * via the driver's `capabilities()` accessor.
 */
export declare const CODEX_CAPABILITIES: InvocationCapabilities;
//# sourceMappingURL=capabilities.d.ts.map