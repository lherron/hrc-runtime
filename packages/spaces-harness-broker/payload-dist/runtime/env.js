import { delimiter, isAbsolute } from 'node:path';
import { BrokerErrorCode, ENV_KEY_PATTERN, isAmbientEnvKey, isCredentialEnvKey, isReservedEnvKey, } from 'spaces-harness-broker-protocol';
import { BrokerError } from '../errors';
export function parseDispatchEnv(input, lockedEnv) {
    if (input === undefined) {
        return undefined;
    }
    if (!isPlainRecord(input)) {
        throw new BrokerError(BrokerErrorCode.DispatchValidationFailed, 'dispatchEnv must be a plain object');
    }
    const lockedKeys = new Set(Object.keys(lockedEnv ?? {}));
    const parsed = {};
    for (const [key, value] of Object.entries(input)) {
        if (!ENV_KEY_PATTERN.test(key)) {
            throw new BrokerError(BrokerErrorCode.DispatchValidationFailed, `dispatchEnv key must match ${String(ENV_KEY_PATTERN)}: ${key}`, { key });
        }
        if (isAmbientEnvKey(key)) {
            throw new BrokerError(BrokerErrorCode.DispatchValidationFailed, `dispatchEnv key conflicts with ambient env: ${key}`, { key });
        }
        if (isCredentialEnvKey(key)) {
            throw new BrokerError(BrokerErrorCode.DispatchValidationFailed, `dispatchEnv key conflicts with credential env: ${key}`, { key });
        }
        if (isReservedEnvKey(key)) {
            throw new BrokerError(BrokerErrorCode.DispatchValidationFailed, `dispatchEnv key is reserved: ${key}`, { key });
        }
        if (lockedKeys.has(key)) {
            throw new BrokerError(BrokerErrorCode.DispatchValidationFailed, `dispatchEnv must not shadow lockedEnv: ${key}`, { key });
        }
        if (typeof value !== 'string') {
            throw new BrokerError(BrokerErrorCode.DispatchValidationFailed, `dispatchEnv value must be a string: ${key}`, { key });
        }
        parsed[key] = value;
    }
    return Object.freeze(parsed);
}
function isPlainRecord(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
export function buildProcessEnv(channels) {
    const env = {};
    // Channel 1: ambient allowlist, sourced from the broker's own environment.
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && isAmbientEnvKey(key)) {
            env[key] = value;
        }
    }
    // Channels 2–4: composed disjointly. Collisions across channels are errors.
    assignChannel(env, 'credentials', channels.credentials);
    assignChannel(env, 'lockedEnv', channels.lockedEnv);
    assignChannel(env, 'dispatchEnv', channels.dispatchEnv);
    // PATH mutation: applied after the disjoint-union compose. PATH itself is
    // ambient/reserved and never enters via lockedEnv/dispatchEnv.
    applyPathPrepend(env, channels.pathPrepend);
    return env;
}
/**
 * Prepend the validated `pathPrepend` directories to the composed PATH, in
 * array order, using the platform delimiter. If the composed PATH is
 * absent/empty, the final PATH is the joined prepend list.
 */
function applyPathPrepend(env, pathPrepend) {
    if (pathPrepend === undefined || pathPrepend.length === 0) {
        return;
    }
    validatePathPrepend(pathPrepend);
    const prefix = pathPrepend.join(delimiter);
    const ambient = env['PATH'];
    env['PATH'] = ambient && ambient.length > 0 ? `${prefix}${delimiter}${ambient}` : prefix;
}
/**
 * Broker spawn validation for pathPrepend entries. Rejects empty strings,
 * non-absolute paths, NUL bytes, delimiter-containing entries, and duplicates.
 * Does NOT consult ambient PATH — validity must not depend on its contents.
 * Existence of the directory is a runtime concern, not a validity check.
 */
function validatePathPrepend(pathPrepend) {
    const seen = new Set();
    for (const entry of pathPrepend) {
        if (typeof entry !== 'string' || entry.length === 0) {
            throw new BrokerError(BrokerErrorCode.DispatchValidationFailed, 'pathPrepend entry must be a non-empty string', { entry });
        }
        if (entry.includes('\0')) {
            throw new BrokerError(BrokerErrorCode.DispatchValidationFailed, 'pathPrepend entry must not contain a NUL byte', { entry });
        }
        if (entry.includes(delimiter)) {
            throw new BrokerError(BrokerErrorCode.DispatchValidationFailed, `pathPrepend entry must not contain the path delimiter "${delimiter}": ${entry}`, { entry });
        }
        if (!isAbsolute(entry)) {
            throw new BrokerError(BrokerErrorCode.DispatchValidationFailed, `pathPrepend entry must be an absolute path: ${entry}`, { entry });
        }
        if (seen.has(entry)) {
            throw new BrokerError(BrokerErrorCode.DispatchValidationFailed, `pathPrepend contains a duplicate entry: ${entry}`, { entry });
        }
        seen.add(entry);
    }
}
function assignChannel(env, channel, source) {
    for (const [key, value] of Object.entries(source ?? {})) {
        if (!ENV_KEY_PATTERN.test(key)) {
            throw new BrokerError(BrokerErrorCode.ResourceError, `Invalid environment key: ${key}`, {
                key,
                channel,
            });
        }
        // Class disjointness: lockedEnv/dispatchEnv must not collide with the
        // ambient, credential, or reserved key classes. credentials is the one
        // channel allowed to carry credential keys.
        if (channel !== 'credentials' && isCredentialEnvKey(key)) {
            throw new BrokerError(BrokerErrorCode.DispatchValidationFailed, `${channel} key conflicts with credential env: ${key}`, { key, channel });
        }
        if (isAmbientEnvKey(key)) {
            throw new BrokerError(BrokerErrorCode.DispatchValidationFailed, `${channel} key conflicts with ambient env: ${key}`, { key, channel });
        }
        if (isReservedEnvKey(key)) {
            throw new BrokerError(BrokerErrorCode.DispatchValidationFailed, `${channel} key is reserved: ${key}`, { key, channel });
        }
        // Instance disjointness: a concrete key may appear in at most one channel.
        // This also enforces "dispatchEnv must not shadow lockedEnv" at spawn time.
        if (Object.hasOwn(env, key)) {
            throw new BrokerError(BrokerErrorCode.DispatchValidationFailed, `Environment key collision across channels: ${key}`, { key, channel });
        }
        env[key] = value;
    }
}
//# sourceMappingURL=env.js.map