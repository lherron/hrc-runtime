export type TmuxLaunchExecPrompts = {
    /** Path to the materialized system-prompt file; content is read+framed at launch. */
    systemPromptFile?: string | undefined;
    systemPromptMode?: 'append' | 'replace' | undefined;
    /** Startup priming text (delivered to the harness via argv; framed here for visibility). */
    initialPrompt?: string | undefined;
};
export type TmuxLaunchExecArtifact = {
    argv: string[];
    cwd: string;
    env?: Record<string, string | undefined> | undefined;
    /**
     * Launch-header material. When present, the runner frame-prints the system
     * prompt + priming + key env into the pane BEFORE spawning the harness, so the
     * operator sees the same framed launch context the legacy hrc launch printed.
     */
    prompts?: TmuxLaunchExecPrompts | undefined;
};
export type TmuxLaunchExecFiles = {
    launchFilePath: string;
    /** Absolute path to the real launch-runner module the command line invokes. */
    runnerPath: string;
    commandLine: string;
};
/**
 * Write the launch artifact (pure JSON data) for a tmux broker route and return
 * the command line that runs the real launch runner against it. The runner reads
 * the artifact, frame-prints the launch header, and spawns the harness.
 */
export declare function writeTmuxLaunchExecFiles(basePath: string, artifact: TmuxLaunchExecArtifact): Promise<TmuxLaunchExecFiles>;
//# sourceMappingURL=tmux-launch-exec.d.ts.map