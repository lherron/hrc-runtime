/**
 * Maximum bytes available for a Unix domain socket path (`sockaddr_un.sun_path`),
 * including the trailing NUL. macOS allots 104 bytes, Linux 108. Using the
 * smaller, platform-correct value lets the broker fail EARLY with a clear
 * message instead of surfacing a low-level `bind` errno.
 */
export declare const socketPathByteBudget: () => number;
export declare const socketPathByteLength: (socketPath: string) => number;
export declare class SocketPathTooLongError extends Error {
    constructor(socketPath: string, needed: number, budget: number);
}
/**
 * Throw {@link SocketPathTooLongError} when `socketPath` would not fit the
 * platform `sockaddr_un` budget. Run BEFORE any bind.
 */
export declare function assertSocketPathWithinBudget(socketPath: string): void;
//# sourceMappingURL=socket-path.d.ts.map