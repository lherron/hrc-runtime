"""HRC's ops-only wire profile, composed with cardo's pinned suite."""
from wire_suite import FoundryProfile


class HrcProfile(FoundryProfile):
    name = 'hrc'
    WIRE = 2  # suite class family; V.set(3) selects the actual wire dialect.
    write_op = 'seat.send'
    read_op = 'kernel.status'
    EXTRA = []
    CELLS = []
    host_binary = None  # Lifecycle is graded by embed_suite, on this same host.
    serves_ledger = False
    redproof_host = False

    def __init__(self, workdir):
        super().__init__(workdir, None)

    def setup(self, wire):
        # This type-only provider supports the suite's registry-generation
        # probe without changing HRC's six operation declarations.
        super().setup(wire)
