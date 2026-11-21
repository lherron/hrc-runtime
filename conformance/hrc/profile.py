"""HRC's ops-only wire profile, composed with cardo's pinned suite."""
from wire_suite import CardoProfile


class HrcProfile(CardoProfile):
    name = 'hrc'
    WIRE = 2  # suite class family; V.set(3) selects the actual wire dialect.
    write_op = 'seat.send'
    read_op = 'kernel.status'
    EXTRA = []
    CELLS = []
    host_binary = None  # Lifecycle is graded by embed_suite, on this same host.
    serves_ledger = False
    redproof_host = False
    idempotent_op = None
    # The edit kinds cardo's built-in ingest discovery advertises on HRC.
    edit_kinds = ["upsert", "remove_by_key"]
    # The suite's registry-generation probe: a type-only provider HRC hosts
    # without changing its six operation declarations. cardo retired the
    # Foundry profile this came from in 151f93f (protocol 2 retirement);
    # ServedProductProfile carries the same fixture but formats host_binary.
    GEN = {"provider": "wiresuite-gen", "version": "1", "node_types": [{
        "name": "wiresuite.gen", "schema_version": 1, "root": True,
        "payload": {"kind": "object", "fields": {"label": {"kind": "string"}}}}]}

    def __init__(self, workdir):
        super().__init__(workdir)

    def setup(self, wire):
        wire.call("registry.disable", {"provider": "wiresuite-gen"})  # a crashed earlier run may have left it
        wire.ok("registry.enable", self.GEN)

    def provider_declared(self, wire):
        return any(t["name"] == "wiresuite.gen" for t in wire.ok(self.discover_op)["result"]["node_types"])

    def provider_off(self, wire):
        return wire.ok("registry.disable", {"provider": "wiresuite-gen"})["result"]["generation"]

    def provider_on(self, wire):
        return wire.ok("registry.enable", self.GEN)["result"]["generation"]
