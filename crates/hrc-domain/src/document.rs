//! The `hrc` document's cardo adapter: its format, the `hrc.project` ingest
//! worker over the kernel's own reader, and the `hrc.seat` attacher through
//! the owner seam. rusthrc wraps it with the owner operations.
use crate::{ledger::HrcLedger, owner::OwnerCall, projector::SeatProjector, reader::HrcRead};
use cardo_core::{Format, document::CoreDomain};
use cardo_runtime::{core_adapter::CoreAdapter, ingest::LedgerIngest};
use std::{sync::Arc, time::Duration};

pub type HrcCore = CoreAdapter<CoreDomain>;

pub fn core(read: HrcRead, owner: Arc<dyn OwnerCall>) -> HrcCore {
    let source = Arc::new(HrcLedger::new(read.clone()));
    let mut adapter =
        CoreAdapter::<CoreDomain>::new(|| CoreDomain, crate::decode_edits, Duration::from_secs(60))
            .with_format(Format::new("hrc", 1));
    adapter.in_process_worker("hrc", move || {
        Box::new(LedgerIngest::new(
            "hrc.project",
            source.clone(),
            SeatProjector::new(read.clone()),
        ))
    });
    adapter.attacher("hrc.seat", move |node, mode| {
        crate::attach::attach(owner.as_ref(), node, mode)
    });
    adapter
}
