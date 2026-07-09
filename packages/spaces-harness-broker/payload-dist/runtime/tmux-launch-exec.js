import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellQuote } from './shell-quote';
/**
 * Resolve the absolute path to the real launch-runner module that ships beside
 * this file (`tmux-launch-runner.ts` in dev, `.js` once built by tsc). The
 * launch command invokes the runner directly — no generated script — so the
 * runner stays normal, lintable, testable code.
 */
function resolveRunnerPath() {
    const self = fileURLToPath(import.meta.url);
    return join(dirname(self), `tmux-launch-runner${extname(self)}`);
}
/**
 * Write the launch artifact (pure JSON data) for a tmux broker route and return
 * the command line that runs the real launch runner against it. The runner reads
 * the artifact, frame-prints the launch header, and spawns the harness.
 */
export async function writeTmuxLaunchExecFiles(basePath, artifact) {
    const launchFilePath = `${basePath}.launch.json`;
    await mkdir(dirname(basePath), { recursive: true });
    await writeFile(launchFilePath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    const runnerPath = resolveRunnerPath();
    return {
        launchFilePath,
        runnerPath,
        commandLine: `exec bun ${shellQuote(runnerPath)} --launch-file ${shellQuote(launchFilePath)}`,
    };
}
//# sourceMappingURL=tmux-launch-exec.js.map