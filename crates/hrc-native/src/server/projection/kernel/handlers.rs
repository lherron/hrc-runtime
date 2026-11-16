//! HRC owns replay; these handlers deliberately declare no cardo idempotency.
use cardo_app::parts::{Failure, Openings, Unfenced};
use cardo_runtime::service::DispatchFailure;
use hrc_domain::{
    annotation::{self, AnnotationAct, AnnotationDelete, AnnotationPut},
    owner::OwnerCall,
    restart::{self, Restart},
    send::{self, SeatSend},
    summon::{self, Summon},
};
use serde_json::Value;
use std::sync::Arc;

pub(super) fn openings(owner: Arc<dyn OwnerCall>) -> anyhow::Result<Openings> {
    let mut openings = Openings::new();
    openings.stop_unsupported("the kernel stops with HRC; restart HRC with `prae node restart`");
    for declaration in hrc_domain::declarations::declarations()["operations"]
        .as_array()
        .expect("operations")
    {
        let declaration: cardo_core::registry::OperationDeclaration =
            serde_json::from_value(declaration.clone())?;
        let name = declaration.name.clone();
        let owner = owner.clone();
        openings.handler(
            Unfenced::new(declaration, move |call| {
                run(&name, call.args.clone(), owner.as_ref()).map_err(failure)
            })
            .into(),
        );
    }
    Ok(openings)
}

fn run(name: &str, args: Value, owner: &dyn OwnerCall) -> Result<Value, DispatchFailure> {
    match name {
        summon::OPERATION => Summon::parse(args)?.run(owner),
        restart::OPERATION => Restart::parse(args)?.run(owner),
        send::OPERATION => SeatSend::parse(args)?.run(owner),
        annotation::PUT => AnnotationPut::parse(args)?.run(owner),
        annotation::ACT => AnnotationAct::parse(args)?.run(owner),
        annotation::DELETE => AnnotationDelete::parse(args)?.run(owner),
        _ => unreachable!("undeclared HRC handler"),
    }
}

fn failure(error: DispatchFailure) -> Failure {
    Failure::new(
        &error.code,
        error.message,
        "read the HRC refusal and refresh the seat before retrying",
    )
    .with_details(error.details)
}
