import type { InvocationCapabilities, InvocationInput, TurnId } from 'spaces-harness-broker-protocol';
import type { Driver } from '../drivers/driver';
export interface TestDriverController {
    readonly inputs: InvocationInput[];
    readonly steeredInputs: InvocationInput[];
    readonly activeInput: InvocationInput | undefined;
    readonly activeTurnId: TurnId | undefined;
    completeActiveTurn(finalOutput?: string): void;
    failActiveTurn(message?: string): void;
    interruptActiveTurn(reason?: string): void;
    /** Emit a continuation.cleared with the given reason (simulates /quit, /clear). */
    clearContinuation(reason: string): void;
}
export interface TestDriverOptions {
    failInputIds?: Iterable<string> | undefined;
    inputCapabilities?: Partial<InvocationCapabilities['input']> | undefined;
    supportsSteer?: boolean | undefined;
    /**
     * When true, `applyInputNow` returns the allocated turnId but does NOT emit
     * its own `turn.started` — modelling a claude-code-tmux idle dispatch where
     * the Claude `UserPromptSubmit` hook never fires. The broker must still
     * guarantee the bracket from the returned turnId (T-04846).
     */
    suppressTurnStarted?: boolean | undefined;
}
export interface TestDriverHandle {
    driver: Driver;
    controller: TestDriverController;
}
export declare function createTestDriver(options?: TestDriverOptions): TestDriverHandle;
//# sourceMappingURL=test-driver.d.ts.map