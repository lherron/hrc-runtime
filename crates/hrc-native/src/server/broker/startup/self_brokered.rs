//! Recover only launches whose descriptor and hosting intent were committed.
use super::*;

pub(super) async fn reconcile(server: &Shared) -> Result<()> {
    // Attempts precede runtime rows, so enumerate attempts, not broker candidates.
    let interrupted: Vec<(String, String)> = {
        let db = server.store.lock().unwrap();
        db.sqlite.prepare("SELECT a.attempt_id,a.runtime_id FROM participant_registration_attempts a JOIN participant_registrations p USING(registration_id) WHERE p.lifecycle_owner='hrc-launched' AND a.state NOT IN ('ABANDONED','TERMINAL','SUPERSEDED') AND (a.prepared_profile_json IS NULL OR a.hosting_intent_json IS NULL)")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?
    };
    for (attempt, runtime) in interrupted {
        let socket = hrcpty::self_brokered_socket(&server.runtime, &runtime);
        let pid = std::fs::read_to_string(socket.parent().unwrap().join("hrcpty.pid"))
            .ok()
            .and_then(|s| s.trim().parse().ok());
        // end_lease identifies the supervisor before signalling it. A failed
        // end is a boot failure, never permission to birth beside a predecessor.
        hrcpty::end_lease(&socket, pid).await?;
        match super::super::participants::abandon_hrc_launched(
            server,
            &attempt,
            "launch_interrupted",
        )
        .map_err(|e| anyhow::anyhow!("{}: {}", e.code, e.message))?
        {
            super::super::participants::Answer::Done(_) => {}
            super::super::participants::Answer::Refused(v) => {
                bail!("interrupted launch {attempt}: {v}")
            }
        }
        log(
            "info",
            "participant.launch_interrupted",
            json!({"attemptId":attempt,"runtimeId":runtime}),
        );
    }
    Ok(())
}
