/**
 * Quote a value for safe inclusion in a POSIX shell command line. Bare
 * alphanumerics and a small safe punctuation set pass through unquoted; anything
 * else is wrapped in single quotes with embedded single quotes escaped.
 */
export declare function shellQuote(value: string): string;
//# sourceMappingURL=shell-quote.d.ts.map