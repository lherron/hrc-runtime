import { PassThrough } from 'node:stream';
/**
 * In-process stream pair for driving the broker protocol without spawning.
 * Used in tests to wire a protocol server to in-memory streams.
 */
export interface StdioHarness {
    /** Write to this to send data to the broker's stdin. */
    readonly input: PassThrough;
    /** Read from this to receive broker stdout output. */
    readonly output: PassThrough;
    /** Read from this to receive broker stderr diagnostics. */
    readonly stderr: PassThrough;
}
export declare function createStdioHarness(): StdioHarness;
//# sourceMappingURL=stdio-harness.d.ts.map