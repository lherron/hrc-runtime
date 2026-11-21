"""HRC's ops-only wire profile, composed with cardo's pinned suite."""
from wire_suite import CardoProfile, GenerationFixture


class HrcProfile(GenerationFixture, CardoProfile):
    """GenerationFixture enables the suite's type-only `wiresuite-gen`
    provider for the registry-generation probe, without changing HRC's six
    operation declarations, and sets the generic edit kinds."""

    name = 'hrc'
    WIRE = 2  # suite class family; V.set(3) selects the actual wire dialect.
    write_op = 'seat.send'
    read_op = 'kernel.status'
    EXTRA = []
    CELLS = []
    host_binary = None  # Lifecycle is graded by embed_suite, on this same host.
    serves_ledger = False
    redproof_host = False
