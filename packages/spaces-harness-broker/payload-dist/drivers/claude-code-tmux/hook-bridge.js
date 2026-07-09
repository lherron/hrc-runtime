import { parseHookJson, postEnvelope, postEnvelopeAndRead, readAll, runHookBridgeCli, } from '../hook-bridge-transport';
import { buildHookEnvelopeFromEnv } from './hook-ingestion';
export async function runClaudeHookBridge(options) {
    const env = options.env ?? process.env;
    const stdin = options.stdin ?? process.stdin;
    const raw = await readAll(stdin);
    const hookData = parseHookJson(raw);
    const envelope = buildHookEnvelopeFromEnv(hookData, env);
    await postEnvelope(options.socketPath, envelope);
}
export async function runClaudeHookDecisionBridge(options) {
    const env = options.env ?? process.env;
    const stdin = options.stdin ?? process.stdin;
    const raw = await readAll(stdin);
    const hookData = parseHookJson(raw);
    const envelope = buildHookEnvelopeFromEnv(hookData, env);
    const response = await postEnvelopeAndRead(options.socketPath, envelope);
    const decision = parseClaudeHookDecisionResponse(response);
    if (decision !== undefined) {
        process.stdout.write(JSON.stringify(decision));
    }
}
function parseClaudeHookDecisionResponse(raw) {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed === 'ok') {
        return undefined;
    }
    try {
        const parsed = JSON.parse(trimmed);
        if (!isRecord(parsed)) {
            return undefined;
        }
        if (typeof parsed['decision'] === 'string' ||
            typeof parsed['continue'] === 'boolean' ||
            typeof parsed['stopReason'] === 'string' ||
            typeof parsed['suppressOutput'] === 'boolean') {
            return parsed;
        }
    }
    catch {
        return undefined;
    }
    return undefined;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** CLI entrypoint: `harness-broker claude-hook --socket <path>`. */
export async function runClaudeHookBridgeCli(args) {
    await runHookBridgeCli({
        commandName: 'claude-hook',
        args,
        run: ({ socketPath }) => runClaudeHookBridge({ socketPath }),
    });
}
/** CLI entrypoint: `harness-broker claude-hook-decision --socket <path>`. */
export async function runClaudeHookDecisionBridgeCli(args) {
    await runHookBridgeCli({
        commandName: 'claude-hook-decision',
        args,
        run: ({ socketPath }) => runClaudeHookDecisionBridge({ socketPath }),
    });
}
//# sourceMappingURL=hook-bridge.js.map