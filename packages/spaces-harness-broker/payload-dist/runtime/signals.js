export async function terminateProcess({ proc, graceMs }) {
    if (proc.exitCode !== null || proc.killed) {
        return;
    }
    const exited = new Promise((resolve) => {
        proc.once('exit', () => resolve());
    });
    proc.kill('SIGTERM');
    const graceExpired = new Promise((resolve) => {
        setTimeout(() => resolve('kill'), graceMs);
    });
    const result = await Promise.race([exited.then(() => 'exit'), graceExpired]);
    if (result === 'kill' && proc.exitCode === null) {
        proc.kill('SIGKILL');
        await exited;
    }
}
//# sourceMappingURL=signals.js.map