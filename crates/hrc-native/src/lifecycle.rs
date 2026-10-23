//! Native lifecycle authority, bounded gate decisions and owner-epoch fences.
//! No listener, process signal, fake readiness, or hidden Store ownership.
use crate::{
    admission::TurnGate,
    config::{AgentScope, NodeIdentity, token},
    credentials::CredentialStore,
    error::{NativeError, Result},
};
use hrc_store::{Committed, InFlightRun, Store, StoreError, WriteTx};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeSet,
    rc::Rc,
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Stop,
    Restart,
}
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct Flags {
    pub wait: bool,
    pub drain: bool,
    pub force: bool,
}
#[derive(Debug, Clone)]
pub struct LifecycleRequest {
    pub action: Action,
    pub reason: Option<String>,
    pub target_node: Option<String>,
    pub flags: Flags,
    pub wait_timeout: Duration,
    pub drain_timeout: Duration,
    pub proof_timeout: Duration,
    pub requested_run_id: Option<String>,
}
impl LifecycleRequest {
    pub fn parse(value: &Value) -> Result<Self> {
        let body = value
            .as_object()
            .ok_or_else(|| NativeError::malformed("lifecycle body must be an object", "body"))?;
        for key in body.keys() {
            if ![
                "action",
                "reason",
                "targetNode",
                "wait",
                "drain",
                "force",
                "waitTimeoutMs",
                "drainTimeoutMs",
                "proofTimeoutMs",
                "requestedRunId",
            ]
            .contains(&key.as_str())
            {
                return Err(NativeError::malformed(format!("unknown field {key}"), key));
            }
        }
        let action = match body.get("action").and_then(Value::as_str) {
            Some("stop") => Action::Stop,
            Some("restart") => Action::Restart,
            _ => {
                return Err(NativeError::malformed(
                    "action must be stop or restart",
                    "action",
                ));
            }
        };
        let boolean = |key: &str| -> Result<bool> {
            match body.get(key) {
                None => Ok(false),
                Some(Value::Bool(v)) => Ok(*v),
                _ => Err(NativeError::malformed("must be a boolean", key)),
            }
        };
        let text = |key: &str| -> Result<Option<String>> {
            match body.get(key) {
                None | Some(Value::Null) => Ok(None),
                Some(Value::String(s)) => Ok((!s.trim().is_empty()).then(|| s.trim().to_owned())),
                _ => Err(NativeError::malformed("must be a string", key)),
            }
        };
        let timeout = |key: &str, fallback: u64| -> Result<Duration> {
            let n = match body.get(key) {
                None => fallback,
                Some(v) => v
                    .as_f64()
                    .filter(|n| (1.0..=9_007_199_254_740_991.0).contains(n) && n.fract() == 0.0)
                    .map(|n| n as u64)
                    .ok_or_else(|| {
                        NativeError::malformed("must be a positive safe integer", key)
                    })?,
            };
            Ok(Duration::from_millis(n))
        };
        let request = Self {
            action,
            reason: text("reason")?,
            target_node: text("targetNode")?,
            flags: Flags {
                wait: boolean("wait")?,
                drain: boolean("drain")?,
                force: boolean("force")?,
            },
            wait_timeout: timeout("waitTimeoutMs", 300_000)?,
            drain_timeout: timeout("drainTimeoutMs", 300_000)?,
            proof_timeout: timeout("proofTimeoutMs", 60_000)?,
            requested_run_id: text("requestedRunId")?,
        };
        request.validate()?;
        Ok(request)
    }
    fn validate(&self) -> Result<()> {
        if self.flags.wait && self.flags.drain {
            return Err(NativeError::malformed(
                "wait and drain are mutually exclusive",
                "drain",
            ));
        }
        if self.flags.drain && self.action != Action::Restart {
            return Err(NativeError::malformed(
                "drain applies to restart only",
                "drain",
            ));
        }
        if self
            .target_node
            .as_ref()
            .is_some_and(|s| !token(s) || s.eq_ignore_ascii_case("local"))
        {
            return Err(NativeError::malformed("invalid targetNode", "targetNode"));
        }
        for (name, duration) in [
            ("waitTimeoutMs", self.wait_timeout),
            ("drainTimeoutMs", self.drain_timeout),
            ("proofTimeoutMs", self.proof_timeout),
        ] {
            if duration.is_zero() || duration.as_millis() > 9_007_199_254_740_991 {
                return Err(NativeError::malformed("invalid timeout", name));
            }
        }
        Ok(())
    }
}
/// Borrowed header values; never Debug/Serialize the credential presentation.
pub struct CallerPresentation<'a> {
    pub runtime_id: Option<&'a str>,
    pub credential: Option<&'a str>,
    pub session_ref: Option<&'a str>,
}
/// Borrowed owner-thread dependencies. Store cannot leave this call.
pub struct LocalAuthorityContext<'a> {
    pub node: &'a NodeIdentity,
    pub peers: &'a BTreeSet<String>,
    pub credentials: &'a CredentialStore,
    pub store: &'a mut Store,
    pub executor_available: bool,
}
/// Authentication of authenticated_node remains the receiving transport's job.
pub struct PeerAttestation<'a> {
    pub authenticated_node: &'a str,
    pub origin_node: &'a str,
    pub requested_by: &'a str,
    pub caller_kind: &'a str,
    pub request_id: &'a str,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum CallerKind {
    #[serde(rename = "mable-primary")]
    Primary,
    #[serde(rename = "mable-node-local")]
    NodeLocal,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleGrant {
    pub request_id: String,
    pub requested_by: String,
    pub caller_kind: CallerKind,
    pub origin_node: String,
    pub reason: String,
    pub action: Action,
    pub flags: Flags,
}
#[derive(Default)]
pub struct LifecycleAuthority {
    busy: Rc<Cell<bool>>,
    next: u64,
}
impl LifecycleAuthority {
    /// Authorize first; this method never changes turn admission or signals.
    pub fn authorize_local(
        &mut self,
        request: LifecycleRequest,
        caller: CallerPresentation<'_>,
        context: LocalAuthorityContext<'_>,
    ) -> Result<LifecycleOperation> {
        let LocalAuthorityContext {
            node,
            peers,
            credentials,
            store,
            executor_available,
        } = context;
        request.validate()?;
        node.validate()?;
        let runtime_id = caller
            .runtime_id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| refusal("credential_missing"))?;
        let value = caller
            .credential
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| refusal("credential_missing"))?;
        let binding = credentials
            .verify(runtime_id, value)
            .ok_or_else(|| refusal("credential_unknown"))?;
        let live = store.read_snapshot(|tx| {
            Ok(tx
                .runtime_by_id(runtime_id)?
                .is_some_and(|r| binding.matches_runtime(&r)))
        })?;
        if !live {
            return Err(refusal("credential_revoked"));
        }
        if attributed_scope(caller.session_ref) != Some(binding.scope_ref.as_str()) {
            return Err(refusal("credential_mismatch"));
        }
        let kind =
            allowed_scope(&binding.scope_ref, node).ok_or_else(|| refusal("not_authorized"))?;
        let target = request.target_node.as_deref().unwrap_or(&node.node_id);
        if target != node.node_id && kind != CallerKind::Primary {
            return Err(refusal("node_local_cross_node"));
        }
        if request.reason.as_ref().is_none_or(|s| s.trim().is_empty()) {
            return Err(refusal("reason_required"));
        }
        if target != node.node_id && !peers.contains(target) {
            return Err(refusal("unknown_node"));
        }
        // Forwarding requires P5, not a local gate with a foreign target label.
        if target != node.node_id {
            return Err(NativeError::new(
                503,
                "runtime_unavailable",
                "native lifecycle peer forwarding is not integrated",
                json!({"code": "peer_lifecycle_unavailable", "targetNode": target, "retryable": true}),
            ));
        }
        self.begin(
            request,
            binding.scope_ref,
            kind,
            &node.node_id,
            None,
            executor_available,
        )
    }
    /// Only a TRANSPORT-authenticated peer identity may be supplied by P5.
    /// This validates attestation, not transport authentication itself.
    pub fn authorize_peer(
        &mut self,
        request: LifecycleRequest,
        attestation: PeerAttestation<'_>,
        node: &NodeIdentity,
        executor_available: bool,
    ) -> Result<LifecycleOperation> {
        let PeerAttestation {
            authenticated_node,
            origin_node,
            requested_by,
            caller_kind,
            request_id,
        } = attestation;
        request.validate()?;
        node.validate()?;
        if authenticated_node != origin_node
            || !token(authenticated_node)
            || caller_kind != "mable-primary"
            || !is_primary(requested_by)
            || request
                .target_node
                .as_ref()
                .is_some_and(|id| id != &node.node_id)
        {
            return Err(refusal("attestation_refused"));
        }
        if request_id.trim().is_empty() {
            return Err(NativeError::malformed(
                "requestId must be non-empty",
                "requestId",
            ));
        }
        self.begin(
            request,
            requested_by.into(),
            CallerKind::Primary,
            origin_node,
            Some(request_id),
            executor_available,
        )
    }
    fn begin(
        &mut self,
        request: LifecycleRequest,
        requested_by: String,
        caller_kind: CallerKind,
        origin: &str,
        request_id: Option<&str>,
        executor_available: bool,
    ) -> Result<LifecycleOperation> {
        let reason = request
            .reason
            .as_ref()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| refusal("reason_required"))?
            .trim()
            .to_owned();
        if !executor_available {
            return Err(refusal("executor_unavailable"));
        }
        if self.busy.get() {
            return Err(refusal("lifecycle_in_progress"));
        }
        self.next = self
            .next
            .checked_add(1)
            .ok_or_else(|| refusal("lifecycle_in_progress"))?;
        let id = request_id.map(str::to_owned).unwrap_or_else(|| {
            format!(
                "lifecycle-native-{}-{}-{}",
                std::process::id(),
                chrono::Utc::now().timestamp_micros(),
                self.next
            )
        });
        let grant = LifecycleGrant {
            request_id: id,
            requested_by,
            caller_kind,
            origin_node: origin.into(),
            reason,
            action: request.action,
            flags: request.flags,
        };
        self.busy.set(true);
        Ok(LifecycleOperation {
            grant,
            request,
            busy: self.busy.clone(),
            began: None,
            gate: None,
            admission_operation: None,
            ready: false,
            acknowledged: None,
            owns_busy: true,
            notes: vec![],
        })
    }
}
#[derive(Debug)]
pub enum GateProgress {
    Waiting {
        in_flight: Vec<InFlightRun>,
        active_admissions: usize,
    },
    Ready {
        notes: Vec<String>,
    },
}
/// Keep this lease alive from authorization through execution/exit. Drop resets
/// action singleflight but deliberately never reopens a durable drain implicitly.
pub struct LifecycleOperation {
    grant: LifecycleGrant,
    request: LifecycleRequest,
    busy: Rc<Cell<bool>>,
    began: Option<Instant>,
    gate: Option<TurnGate>,
    admission_operation: Option<String>,
    ready: bool,
    acknowledged: Option<Instant>,
    owns_busy: bool,
    notes: Vec<String>,
}
impl LifecycleOperation {
    /// Parent polls on its timer; no transaction survives this call.
    pub fn poll_gate(
        &mut self,
        store: &mut Store,
        gate: &TurnGate,
        now: Instant,
    ) -> Result<GateProgress> {
        if !self.owns_busy {
            return Err(NativeError::stale("lifecycle operation was cancelled"));
        }
        if self.ready {
            return Ok(GateProgress::Ready {
                notes: self.notes.clone(),
            });
        }
        let began = *self.began.get_or_insert(now);
        if self.request.flags.drain && self.admission_operation.is_none() {
            let id = format!("restart-drain-{}", self.grant.request_id);
            gate.close(
                &id,
                Some(self.grant.requested_by.clone()),
                self.request.requested_run_id.clone(),
                Some(self.grant.reason.clone()),
            )?;
            self.admission_operation = Some(id);
            self.gate = Some(gate.clone());
        }
        if !self.request.flags.force || self.request.flags.drain {
            let excluded = if self.request.action == Action::Restart {
                vec!["tmux".into()]
            } else {
                vec![]
            };
            let cutoff = (chrono::Utc::now() - chrono::Duration::minutes(5))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            let work = store.read_snapshot(|tx| {
                tx.recent_in_flight_work(
                    &cutoff,
                    self.request.flags.drain,
                    &excluded,
                    self.request.requested_run_id.as_deref(),
                )
            })?;
            let active = if self.request.flags.drain {
                gate.snapshot().active_admissions
            } else {
                0
            };
            if !work.is_empty() || active != 0 {
                let timeout = if self.request.flags.drain {
                    self.request.drain_timeout
                } else {
                    self.request.wait_timeout
                };
                if (self.request.flags.wait || self.request.flags.drain)
                    && now.saturating_duration_since(began) < timeout
                {
                    return Ok(GateProgress::Waiting {
                        in_flight: work,
                        active_admissions: active,
                    });
                }
                if self.request.flags.drain {
                    self.notes.push(format!("drain timed out with {} headless run(s) and {active} admission(s); force restart semantics under closed admission", work.len()));
                } else {
                    let code = match (self.request.action, self.request.flags.wait) {
                        (Action::Restart, false) => "restart_refused_in_flight",
                        (Action::Stop, false) => "stop_refused_in_flight",
                        (Action::Restart, true) => "restart_drain_timeout",
                        (Action::Stop, true) => "stop_drain_timeout",
                    };
                    return Err(NativeError::new(
                        409,
                        "server_lifecycle_in_flight",
                        "lifecycle action has in-flight work",
                        json!({"refusalCode": code, "inFlight": work}),
                    ));
                }
            } else if self.request.flags.drain {
                self.notes
                    .push("drain complete under closed admission".into());
            }
        }
        self.ready = true;
        Ok(GateProgress::Ready {
            notes: self.notes.clone(),
        })
    }
    pub fn grant(&self) -> Result<&LifecycleGrant> {
        if !self.ready || !self.owns_busy {
            return Err(NativeError::stale("lifecycle work gate has not settled"));
        }
        Ok(&self.grant)
    }
    /// Call only after the response has been acknowledged to the caller.
    pub fn acknowledge(&mut self, now: Instant) -> Result<()> {
        self.grant()?;
        if self.acknowledged.is_none() {
            self.acknowledged = Some(now);
        }
        Ok(())
    }
    pub fn may_execute(&self, now: Instant) -> bool {
        self.ready
            && self
                .acknowledged
                .is_some_and(|at| now.saturating_duration_since(at) >= Duration::from_millis(150))
    }
    pub fn cancel(&mut self) -> Result<()> {
        if !self.owns_busy {
            return Ok(());
        }
        if self.acknowledged.is_some() {
            return Err(NativeError::stale(
                "an acknowledged lifecycle action cannot be cancelled",
            ));
        }
        if let (Some(gate), Some(id)) = (&self.gate, &self.admission_operation) {
            gate.reopen(Some(id))?;
        }
        self.busy.set(false);
        self.owns_busy = false;
        self.ready = false;
        Ok(())
    }
}
impl Drop for LifecycleOperation {
    fn drop(&mut self) {
        if self.owns_busy {
            self.busy.set(false);
        }
    }
}
fn refusal(reason: &str) -> NativeError {
    let mut detail = json!({"refusal": reason});
    if reason == "lifecycle_in_progress" {
        detail["retryable"] = json!(true);
    }
    NativeError::new(
        if reason == "lifecycle_in_progress" {
            409
        } else {
            403
        },
        "server_lifecycle_refused",
        "lifecycle action requires a current authorized Mable runtime credential and reason",
        detail,
    )
}
fn is_primary(scope: &str) -> bool {
    AgentScope::parse(scope).is_ok_and(|s| {
        s.agent == "mable" && s.project.is_some() && s.task == Some("primary") && s.role.is_none()
    })
}
fn allowed_scope(scope: &str, node: &NodeIdentity) -> Option<CallerKind> {
    if is_primary(scope) {
        return Some(CallerKind::Primary);
    }
    let s = AgentScope::parse(scope).ok()?;
    if node.declared
        && s.agent == "mable"
        && s.project.is_some()
        && s.role.is_none()
        && ((s.task == Some("minisvc") && node.node_id == "svc")
            || (s.task == Some("hrcdev")
                && s.project == Some("hrc-runtime")
                && node.node_id == "hrcdev"))
    {
        Some(CallerKind::NodeLocal)
    } else {
        None
    }
}
fn attributed_scope(session_ref: Option<&str>) -> Option<&str> {
    let mut parts = session_ref?.trim().split('/');
    let scope = parts.next()?.trim();
    let lane = parts.next()?.trim().strip_prefix("lane:")?;
    if lane.is_empty() || parts.next().is_some() || AgentScope::parse(scope).is_err() {
        return None;
    }
    Some(scope)
}

// Effect identity is an owned snapshot, not an authority to select a new host.
#[derive(Debug, Clone)]
pub struct EffectIdentity {
    pub scope_ref: String,
    pub lane_ref: String,
    pub host_session_id: String,
    pub generation: i64,
    pub runtime_id: Option<String>,
    pub operation_id: Option<String>,
    pub invocation_id: Option<String>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnerPhase {
    Opening,
    Recovering,
    Serving,
    Stopping,
    Closed,
}
struct OwnerState {
    phase: OwnerPhase,
    epoch: u64,
    outstanding: usize,
    deadline_expired: bool,
    incomplete: Vec<String>,
}
#[derive(Clone)]
pub struct LifecycleFence {
    state: Rc<RefCell<OwnerState>>,
}
impl Default for LifecycleFence {
    fn default() -> Self {
        Self {
            state: Rc::new(RefCell::new(OwnerState {
                phase: OwnerPhase::Opening,
                epoch: 0,
                outstanding: 0,
                deadline_expired: false,
                incomplete: vec![],
            })),
        }
    }
}
impl LifecycleFence {
    pub fn phase(&self) -> OwnerPhase {
        self.state.borrow().phase
    }
    pub fn begin_recovery(&self) -> Result<()> {
        self.transition(OwnerPhase::Opening, OwnerPhase::Recovering)
    }
    pub fn mark_serving(&self) -> Result<()> {
        self.transition(OwnerPhase::Recovering, OwnerPhase::Serving)
    }
    fn transition(&self, from: OwnerPhase, to: OwnerPhase) -> Result<()> {
        let mut s = self.state.borrow_mut();
        if s.phase != from {
            return Err(NativeError::stale("invalid daemon phase transition"));
        }
        s.phase = to;
        Ok(())
    }
    pub fn begin_effect(&self, identity: EffectIdentity) -> Result<EffectTicket> {
        let mut s = self.state.borrow_mut();
        if !matches!(s.phase, OwnerPhase::Recovering | OwnerPhase::Serving) {
            return Err(NativeError::stale("daemon is not admitting effects"));
        }
        if identity.generation < 1
            || identity.host_session_id.is_empty()
            || (identity.runtime_id.is_none()
                && (identity.operation_id.is_some() || identity.invocation_id.is_some()))
        {
            return Err(NativeError::malformed(
                "incomplete effect identity",
                "identity",
            ));
        }
        AgentScope::parse(&identity.scope_ref)?;
        if identity.lane_ref.is_empty() {
            return Err(NativeError::malformed("effect lane is empty", "laneRef"));
        }
        s.outstanding += 1;
        Ok(EffectTicket {
            state: self.state.clone(),
            epoch: s.epoch,
            identity,
        })
    }
    /// Invalidates pending effects BEFORE listeners/controller/store relinquish.
    pub fn begin_stop(&self) {
        let mut s = self.state.borrow_mut();
        if !matches!(s.phase, OwnerPhase::Stopping | OwnerPhase::Closed) {
            s.phase = OwnerPhase::Stopping;
            s.epoch = s.epoch.checked_add(1).expect("owner epoch exhausted");
        }
    }
    pub fn note_incomplete(&self, reason: impl Into<String>) {
        self.state.borrow_mut().incomplete.push(reason.into());
    }
    pub fn mark_deadline_expired(&self) {
        self.state.borrow_mut().deadline_expired = true;
    }
    /// Permission for pre-close attestation only, not an append or shutdown proof.
    pub fn may_attest_stopped(&self) -> bool {
        let s = self.state.borrow();
        s.phase == OwnerPhase::Stopping
            && s.outstanding == 0
            && !s.deadline_expired
            && s.incomplete.is_empty()
    }
    pub fn outstanding(&self) -> usize {
        self.state.borrow().outstanding
    }
    pub fn mark_closed(&self) -> Result<()> {
        self.transition(OwnerPhase::Stopping, OwnerPhase::Closed)
    }
}
pub struct EffectTicket {
    state: Rc<RefCell<OwnerState>>,
    epoch: u64,
    identity: EffectIdentity,
}
impl EffectTicket {
    /// Re-checks continuity/runtime INSIDE the same short write transaction as
    /// the mutation. Rollback and postcommit hints remain owned by hrc-store.
    pub fn apply<T>(
        self,
        store: &mut Store,
        write: impl FnOnce(&mut WriteTx<'_>) -> hrc_store::Result<T>,
    ) -> Result<Committed<T>> {
        let s = self.state.borrow();
        if s.epoch != self.epoch || !matches!(s.phase, OwnerPhase::Recovering | OwnerPhase::Serving)
        {
            return Err(NativeError::stale(
                "effect belongs to a stopped or superseded owner",
            ));
        }
        drop(s);
        let i = &self.identity;
        Ok(store.write(|tx| {
            let read = tx.read();
            let host = read.sessions().get_by_host_session_id(&i.host_session_id)?;
            let continuity = read.continuities().get_by_key(&i.scope_ref, &i.lane_ref)?;
            let valid = host.as_ref().is_some_and(|h| {
                h.scope_ref == i.scope_ref
                    && h.lane_ref == i.lane_ref
                    && h.generation == i.generation
                    && h.status == "active"
            }) && continuity
                .as_ref()
                .is_some_and(|c| c.active_host_session_id == i.host_session_id);
            if !valid {
                return Err(stale_effect(&i.host_session_id));
            }
            if let Some(id) = &i.runtime_id {
                let runtime = read.runtime_by_id(id)?;
                if !runtime.as_ref().is_some_and(|r| {
                    r.host_session_id == i.host_session_id
                        && r.scope_ref == i.scope_ref
                        && r.lane_ref == i.lane_ref
                        && r.generation == i.generation
                        && !matches!(r.status.as_str(), "terminated" | "dead" | "stale")
                        && i.operation_id
                            .as_ref()
                            .is_none_or(|id| r.active_operation_id.as_ref() == Some(id))
                        && i.invocation_id
                            .as_ref()
                            .is_none_or(|id| r.active_invocation_id.as_ref() == Some(id))
                }) {
                    return Err(stale_effect(id));
                }
            }
            write(tx)
        })?)
    }
}
impl Drop for EffectTicket {
    fn drop(&mut self) {
        self.state.borrow_mut().outstanding -= 1;
    }
}
fn stale_effect(id: &str) -> StoreError {
    StoreError::Conflict {
        code: "stale_context",
        identity: id.into(),
    }
}
