"""Required case assertions for parent adapter integration; absence is GAP."""
REQUIRED = {
    'C01': ['nonempty-exact-and-latest-exports', 'zero-work-export-rejected-externally', 'absent-run', 'absent-selector', 'invalid-format'],
    'C02': ['written', 'reordered-unchanged', 'conflict-exit1-no-mutation', 'replace-drops-old-keys', 'native-typed-reload',
            'export-replacement', 'invalid-json-no-mutation', 'nonobject-no-mutation', 'unknown-key-no-mutation',
            'nonstring-no-mutation', 'empty-no-mutation', 'absent-run-no-mutation'],
    'C03': ['nonempty-capture-auto-and-explicit', 'all-mirrors-absent', 'individual-mirror-missing', 'divergent-mirror',
            'failed-projection', 'sequence-hole', 'missing-lifecycle', 'missing-invocation', 'wrong-artifact',
            'unreadable-artifact', 'lifecycle-exact-payload-and-duplicate-controls'],
    'C04': ['real-isolated-monitor-status-cleanup-native-reopen'],
    'C05': ['spill-native-and-Bun-hydration', 'spill-positive-dry-repeat-full-hydration', 'restub-native-and-Bun-hydration',
            'restub-exact-skips-bytes-repeat-hydration', 'strip-null-authority-preservation-repeat',
            'default-retention-exact-eligibility-preservation', 'bounded-busy-interruption-resume-concurrent-native-append',
            'spill-kill-resume-concurrent-append', 'restub-kill-resume-concurrent-append', 'buffers-kill-resume-concurrent-append'],
    'C06': ['delete-before-copy-refusal', 'full-row-copy-delete-repeat-native-reopen', 'seq-only-weakness-rejected-by-full-row-oracle', 'actual-copy-delete-kill-resume'],
    'C07': ['active-rebuild-duplicate-and-native-read', 'existing-output-exit2-no-overwrite', 'missing-input-refusal', 'conflicting-home-no-partial-insertion'],
}
