import { createBroker } from './broker';
import { createDefaultClaudeCodeTmuxDriver } from './drivers/claude-code-tmux/driver';
import { createCodexAppServerDriver } from './drivers/codex-app-server/driver';
import { createDefaultCodexCliTmuxDriver } from './drivers/codex-cli-tmux/driver';
import { createDefaultPiTuiTmuxDriver } from './drivers/pi-tui-tmux/driver';
export function createDefaultBroker(onEvent, onPermissionRequest, options = {}) {
    return createBroker({
        drivers: [
            createCodexAppServerDriver(),
            createDefaultClaudeCodeTmuxDriver(options.hookIpcDir),
            createDefaultCodexCliTmuxDriver(options.hookIpcDir),
            createDefaultPiTuiTmuxDriver(options.hookIpcDir),
        ],
        ...(onEvent !== undefined ? { onEvent } : {}),
        ...(onPermissionRequest !== undefined ? { onPermissionRequest } : {}),
        ...(options.advertisedTransports !== undefined
            ? { advertisedTransports: options.advertisedTransports }
            : {}),
        ...(options.advertiseAttachReplay !== undefined
            ? { advertiseAttachReplay: options.advertiseAttachReplay }
            : {}),
        ...(options.eventLedger !== undefined ? { eventLedger: options.eventLedger } : {}),
        ...(options.attachIdentity !== undefined ? { attachIdentity: options.attachIdentity } : {}),
        ...(options.brokerInstanceId !== undefined
            ? { brokerInstanceId: options.brokerInstanceId }
            : {}),
    });
}
//# sourceMappingURL=default-broker.js.map