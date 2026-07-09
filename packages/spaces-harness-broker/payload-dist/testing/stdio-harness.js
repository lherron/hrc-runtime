import { PassThrough } from 'node:stream';
export function createStdioHarness() {
    return {
        input: new PassThrough(),
        output: new PassThrough(),
        stderr: new PassThrough(),
    };
}
//# sourceMappingURL=stdio-harness.js.map