import { platform } from 'node:os';
/**
 * Maximum bytes available for a Unix domain socket path (`sockaddr_un.sun_path`),
 * including the trailing NUL. macOS allots 104 bytes, Linux 108. Using the
 * smaller, platform-correct value lets the broker fail EARLY with a clear
 * message instead of surfacing a low-level `bind` errno.
 */
export const socketPathByteBudget = () => (platform() === 'linux' ? 108 : 104);
export const socketPathByteLength = (socketPath) => Buffer.byteLength(socketPath, 'utf8') + 1; // + trailing NUL
export class SocketPathTooLongError extends Error {
    constructor(socketPath, needed, budget) {
        super(`socket path too long: ${needed} bytes exceeds the ${budget}-byte platform limit (${socketPath})`);
        this.name = 'SocketPathTooLongError';
    }
}
/**
 * Throw {@link SocketPathTooLongError} when `socketPath` would not fit the
 * platform `sockaddr_un` budget. Run BEFORE any bind.
 */
export function assertSocketPathWithinBudget(socketPath) {
    const budget = socketPathByteBudget();
    const needed = socketPathByteLength(socketPath);
    if (needed > budget) {
        throw new SocketPathTooLongError(socketPath, needed, budget);
    }
}
//# sourceMappingURL=socket-path.js.map