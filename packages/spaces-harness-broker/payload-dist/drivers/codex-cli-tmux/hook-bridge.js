import { parseHookJson, postEnvelope, readAll, runHookBridgeCli } from '../hook-bridge-transport';
import { buildCodexHookEnvelopeFromEnv } from './hook-ingestion';
export async function runCodexHookBridge(options) {
    const env = options.env ?? process.env;
    const stdin = options.stdin ?? process.stdin;
    const raw = await readAll(stdin);
    const hookData = parseHookJson(raw);
    const envelope = buildCodexHookEnvelopeFromEnv(hookData, env);
    await postEnvelope(options.socketPath, envelope);
}
/** CLI entrypoint: `harness-broker codex-hook --socket <path>`. */
export async function runCodexHookBridgeCli(args) {
    await runHookBridgeCli({
        commandName: 'codex-hook',
        args,
        run: ({ socketPath }) => runCodexHookBridge({ socketPath }),
    });
}
//# sourceMappingURL=hook-bridge.js.map