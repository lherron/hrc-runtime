/**
 * Quote a value for safe inclusion in a POSIX shell command line. Bare
 * alphanumerics and a small safe punctuation set pass through unquoted; anything
 * else is wrapped in single quotes with embedded single quotes escaped.
 */
export function shellQuote(value) {
    if (/^[A-Za-z0-9_./:=-]+$/.test(value)) {
        return value;
    }
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
//# sourceMappingURL=shell-quote.js.map