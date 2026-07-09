import type { DriverSummary } from 'spaces-harness-broker-protocol';
import type { Driver } from './driver';
export interface DriverRegistry {
    get(kind: string): Driver | undefined;
    summaries(): DriverSummary[];
}
export declare function createDriverRegistry(drivers: Driver[]): DriverRegistry;
//# sourceMappingURL=registry.d.ts.map