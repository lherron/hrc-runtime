import type { Driver } from './driver';
export interface NoopDriverOptions {
    /** Which terminal state to enter on stop: 'exited' or 'failed'. */
    terminal?: 'exited' | 'failed' | undefined;
}
export declare function createNoopDriver(options?: NoopDriverOptions): Driver;
//# sourceMappingURL=noop-driver.d.ts.map