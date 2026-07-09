export function buildTurnStartParams(options) {
    return {
        threadId: options.threadId,
        input: buildCodexInput(options.input, options.driver.defaultImageAttachments),
        cwd: options.cwd,
        approvalPolicy: options.driver.approvalPolicy ?? 'never',
        sandboxPolicy: encodeSandboxPolicy(options.driver.sandboxMode),
        model: options.driver.model ?? null,
        effort: options.driver.modelReasoningEffort ?? null,
        summary: null,
        // T-03779: structured output is per-turn input data. Map the current input's
        // JSON Schema response format to Codex app-server `turn/start.outputSchema`;
        // omitted or `{ kind: 'text' }` carries no schema.
        outputSchema: options.input.responseFormat?.kind === 'json_schema'
            ? options.input.responseFormat.schema
            : null,
    };
}
function buildCodexInput(input, defaultImageAttachments) {
    const items = [];
    const text = input.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
    if (text.length > 0) {
        items.push({ type: 'text', text, text_elements: [] });
    }
    for (const part of input.content) {
        if (part.type === 'local_image') {
            items.push({ type: 'localImage', path: part.path });
        }
    }
    for (const path of defaultImageAttachments ?? []) {
        items.push({ type: 'localImage', path });
    }
    return items;
}
function encodeSandboxPolicy(sandboxMode) {
    if (!sandboxMode)
        return null;
    switch (sandboxMode) {
        case 'danger-full-access':
            return { type: 'dangerFullAccess' };
        case 'read-only':
            return { type: 'readOnly' };
        case 'workspace-write':
            return { type: 'workspaceWrite' };
        default:
            return { type: sandboxMode };
    }
}
//# sourceMappingURL=input.js.map