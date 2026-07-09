import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
export function createJsonlByteOffsetTailer() {
    const buffer = Buffer.alloc(64 * 1024);
    let activePath;
    let offset = 0;
    let partial = '';
    const rewind = () => {
        offset = 0;
        partial = '';
    };
    return {
        getActivePath() {
            return activePath;
        },
        retarget(path) {
            if (path === activePath)
                return false;
            activePath = path;
            rewind();
            return true;
        },
        clear() {
            activePath = undefined;
            rewind();
        },
        readNewLines(onLine) {
            if (activePath === undefined)
                return;
            try {
                if (!existsSync(activePath))
                    return;
                const stats = statSync(activePath);
                if (!stats.isFile())
                    return;
                if (stats.size < offset) {
                    offset = 0;
                    partial = '';
                }
                if (stats.size === offset)
                    return;
                const fd = openSync(activePath, 'r');
                try {
                    while (offset < stats.size) {
                        const bytesToRead = Math.min(buffer.length, stats.size - offset);
                        const bytesRead = readSync(fd, buffer, 0, bytesToRead, offset);
                        if (bytesRead <= 0)
                            break;
                        offset += bytesRead;
                        partial += buffer.subarray(0, bytesRead).toString('utf8');
                        let newlineIndex = partial.indexOf('\n');
                        while (newlineIndex >= 0) {
                            const line = partial.slice(0, newlineIndex);
                            partial = partial.slice(newlineIndex + 1);
                            onLine(line);
                            newlineIndex = partial.indexOf('\n');
                        }
                    }
                }
                finally {
                    closeSync(fd);
                }
            }
            catch {
                return;
            }
        },
    };
}
//# sourceMappingURL=jsonl-byte-tailer.js.map