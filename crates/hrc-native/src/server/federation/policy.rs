//! federation/placement-policy.ts `resolvePlacementPolicy`: the declared
//! `[placement]` policy for a scope's agent, observed through the same
//! placement resolution the route serves. Shared by locate and the gate.
use crate::server::{Server, aspc};
use serde_json::{Value, json};

pub enum Policy {
    /// `policy` is SummonGatePolicy: {claimsTask, provisioningNode?, placement:{launch?, pins, homes}}.
    Resolved {
        policy: Value,
        profile: String,
    },
    NotAnAgentScope(String),
    NoProfile(String),
    Unreadable(String),
}

impl Policy {
    /// placement-policy.ts `createPlacementPolicyResolver`: `Ok(None)` for a
    /// scope no agent policy can speak for; profile failures are errors.
    pub fn for_gate(self) -> Result<Option<Value>, String> {
        match self {
            Self::Resolved { policy, .. } => Ok(Some(policy)),
            Self::NotAnAgentScope(_) => Ok(None),
            Self::NoProfile(detail) | Self::Unreadable(detail) => Err(detail),
        }
    }
}

/// The scope's (agent, project, task) on a validated ScopeRef.
pub fn scope_parts(scope: &str) -> (&str, Option<&str>, Option<&str>) {
    let p: Vec<&str> = scope.split(':').collect();
    (
        p[1],
        p.get(3).copied(),
        (p.get(4) == Some(&"task")).then(|| p[5]),
    )
}

pub async fn policy_for(server: &Server, scope: &str) -> Policy {
    if hrc_cli::validate_scope(scope).is_err() {
        return Policy::NotAnAgentScope(format!(
            "\"{scope}\" is not a parseable scope ref, so no agent profile can declare placement for it."
        ));
    }
    let (agent, project, task) = scope_parts(scope);
    let mut request = json!({"agentId":agent});
    if let Some(project) = project {
        request["projectId"] = project.into();
    }
    if let Some(task) = task {
        request["taskId"] = task.into();
    }
    request["cwd"] = std::env::current_dir()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
        .into();
    request["runMode"] = "task".into();
    let no_root = || {
        Policy::NoProfile(format!(
            "No agent root found for \"{agent}\", so no [placement] stanza could be read."
        ))
    };
    let observed = match aspc::resolve_placement(server, request).await {
        Ok(observed) => observed,
        Err(error)
            if error.code == "declaration_invalid"
                && error
                    .detail
                    .as_ref()
                    .is_some_and(|d| d["producerCode"] == "agent_not_found") =>
        {
            return no_root();
        }
        Err(error) => {
            return Policy::Unreadable(format!(
                "Could not observe a declaration for \"{agent}\": {}",
                error.message
            ));
        }
    };
    let Some(root) = observed["agentRoot"].as_str() else {
        return no_root();
    };
    let profile = format!("{}/agent-profile.toml", root.trim_end_matches('/'));
    if observed["source"]["agentProfile"] == "absent" {
        return Policy::NoProfile(format!(
            "{profile} does not exist, so this agent declares no placement."
        ));
    }
    if observed["source"]["agentProfile"] == "invalid"
        || observed["source"]["projectTargets"] == "invalid"
    {
        let diagnostics = observed["warnings"]
            .as_array()
            .map(|w| {
                w.iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .filter(|d| !d.is_empty())
            .unwrap_or_else(|| "invalid source".into());
        return Policy::Unreadable(format!(
            "Could not interpret the declaration for \"{agent}\" at {profile}: {diagnostics}"
        ));
    }
    let observed_policy = &observed["policy"];
    let mut policy = json!({"claimsTask":observed_policy["claimsTask"]});
    if let Some(node) = observed_policy
        .get("provisioningNode")
        .filter(|v| !v.is_null())
    {
        policy["provisioning"] = json!({"node":node});
    }
    policy["placement"] = observed_policy["placement"].clone();
    Policy::Resolved { policy, profile }
}
