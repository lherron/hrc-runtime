export function createDriverRegistry(drivers) {
    const map = new Map();
    for (const driver of drivers) {
        map.set(driver.kind, driver);
    }
    return {
        get(kind) {
            return map.get(kind);
        },
        summaries() {
            return drivers.map((d) => ({
                kind: d.kind,
                version: d.version,
                available: true,
                capabilities: d.capabilities(),
            }));
        },
    };
}
//# sourceMappingURL=registry.js.map