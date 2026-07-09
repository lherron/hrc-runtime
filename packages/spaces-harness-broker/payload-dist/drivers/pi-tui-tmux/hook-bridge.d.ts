export interface PiHookBridgeOptions {
    socketPath: string;
    stdin?: NodeJS.ReadableStream | undefined;
    env?: Record<string, string | undefined> | undefined;
}
/**
 * Broker-owned Pi hook bridge. The Pi TUI route uses the generated
 * asp-hrc-events.bridge.js extension, but points HRC_LAUNCH_HOOK_CLI at this
 * wrapper instead of HRC. The generated extension forwards Pi lifecycle/message/
 * tool events as JSON; this bridge adds broker invocation identity and posts the
 * envelope to the driver's callback socket.
 */
export declare function runPiHookBridge(options: PiHookBridgeOptions): Promise<void>;
/** CLI entrypoint: `harness-broker pi-hook --socket <path>`. */
export declare function runPiHookBridgeCli(args: string[]): Promise<void>;
//# sourceMappingURL=hook-bridge.d.ts.map