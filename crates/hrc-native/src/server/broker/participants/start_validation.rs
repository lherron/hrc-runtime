//! Acceptance predicate for the published InvocationStartRequest validator.
//! Descriptor validation exposes only its generic error message, so internal
//! issue lists need not be reconstructed. Every admission rule still applies.
use serde_json::Value;
fn opt(v: &Value, key: &str, f: impl FnOnce(&Value) -> bool) -> bool {
    v.get(key).is_none_or(f)
}
fn string(v: &Value) -> bool {
    v.is_string()
}
fn number(v: &Value) -> bool {
    v.is_number()
}
fn strings(v: &Value) -> bool {
    v.as_array().is_some_and(|a| a.iter().all(string))
}
fn member(v: &Value, values: &[&str]) -> bool {
    v.as_str().is_some_and(|s| values.contains(&s))
}
fn required_strings(v: &Value, keys: &[&str]) -> bool {
    keys.iter().all(|k| v.get(*k).is_some_and(string))
}
fn optional_strings(v: &Value, keys: &[&str]) -> bool {
    keys.iter().all(|k| opt(v, k, string))
}
fn optional_numbers(v: &Value, keys: &[&str]) -> bool {
    keys.iter().all(|k| opt(v, k, number))
}
fn string_record(v: &Value) -> bool {
    v.as_object().is_some_and(|m| m.values().all(string))
}
fn allowed_env(v: &Value) -> bool {
    v.as_object().is_some_and(|m| {
        m.iter().all(|(key, value)| {
            let bytes = key.as_bytes();
            let valid = bytes
                .first()
                .is_some_and(|b| b.is_ascii_alphabetic() || *b == b'_')
                && bytes
                    .iter()
                    .all(|b| b.is_ascii_alphanumeric() || *b == b'_');
            valid
                && value.is_string()
                && ![
                    "HOME",
                    "PATH",
                    "SHELL",
                    "TMPDIR",
                    "TEMP",
                    "TMP",
                    "USER",
                    "USERNAME",
                    "TERM",
                    "LANG",
                    "TZ",
                    "OPENAI_API_KEY",
                    "ANTHROPIC_API_KEY",
                    "AWS_ACCESS_KEY_ID",
                    "AWS_SECRET_ACCESS_KEY",
                    "AWS_SESSION_TOKEN",
                    "GITHUB_TOKEN",
                    "SSH_AUTH_SOCK",
                    "HTTP_PROXY",
                    "HTTPS_PROXY",
                    "ALL_PROXY",
                    "NO_PROXY",
                    "http_proxy",
                    "https_proxy",
                    "all_proxy",
                    "no_proxy",
                ]
                .contains(&key.as_str())
                && !["LC_", "NODE_", "npm_", "NPM_", "XDG_"]
                    .iter()
                    .any(|p| key.starts_with(p))
                && !key.ends_with("_TOKEN")
                && !key.ends_with("_PASSWORD")
        })
    })
}
fn permission(v: &Value) -> bool {
    v.is_object()
        && member(&v["mode"], &["deny", "allow", "ask-client"])
        && opt(v, "timeoutMs", number)
        && opt(v, "defaultDecision", |x| member(x, &["allow", "deny"]))
}
fn driver(v: &Value) -> bool {
    if !v.is_object() || !v["kind"].is_string() {
        return false;
    }
    match v["kind"].as_str().unwrap() {
        "codex-app-server" => {
            optional_strings(
                v,
                &[
                    "resumeThreadId",
                    "model",
                    "modelReasoningEffort",
                    "developerInstructions",
                ],
            ) && opt(v, "presentation", |x| {
                member(x, &["none", "tmux-tui", "codex-tui"])
            }) && opt(v, "transport", |x| {
                member(x, &["jsonrpc-stdio", "websocket-unix"])
            }) && opt(v, "defaultImageAttachments", strings)
                && opt(v, "approvalPolicy", |x| {
                    member(x, &["untrusted", "on-failure", "on-request", "never"])
                })
                && opt(v, "sandboxMode", |x| {
                    member(x, &["read-only", "workspace-write", "danger-full-access"])
                })
                && opt(v, "resumeFallback", |x| member(x, &["start-fresh", "fail"]))
                && opt(v, "permissionPolicy", permission)
        }
        "muse-serve" => {
            optional_strings(
                v,
                &[
                    "serveBin",
                    "workspace",
                    "model",
                    "reasoningEffort",
                    "resumeSessionId",
                ],
            ) && opt(v, "homeMode", |x| member(x, &["isolated", "operator"]))
                && opt(v, "approvalMode", |x| {
                    member(
                        x,
                        &["allowAll", "promptUnmatched", "onRequest", "denyUnmatched"],
                    )
                })
                && opt(v, "resumeFallback", |x| member(x, &["start-fresh", "fail"]))
                && opt(v, "permissionPolicy", permission)
        }
        _ => true,
    }
}
fn agent(v: &Value) -> bool {
    v.is_object()
        && v["agentId"].as_str().is_some_and(|s| !s.trim().is_empty())
        && optional_strings(
            v,
            &[
                "projectId",
                "agentRoot",
                "projectRoot",
                "aspHome",
                "scopeRef",
                "laneRef",
                "runId",
                "hostSessionId",
            ],
        )
        && opt(v, "generation", number)
        && opt(v, "runMode", |x| {
            member(x, &["query", "heartbeat", "task", "maintenance"])
        })
        && opt(v, "taskContext", |c| {
            c.is_object()
                && c["taskId"].as_str().is_some_and(|s| !s.trim().is_empty())
                && c.get("phase").is_some_and(|x| x.is_null() || x.is_string())
                && required_strings(c, &["role", "hintsText"])
                && strings(&c["requiredEvidenceKinds"])
        })
}
fn input(v: &Value) -> bool {
    v.is_object()
        && opt(v, "inputId", string)
        && member(&v["kind"], &["user", "steer", "append_context"])
        && v["content"].as_array().is_some_and(|a| {
            a.iter().all(|c| {
                c.is_object()
                    && match c["type"].as_str() {
                        Some("text") => c["text"].is_string(),
                        Some("local_image") => c["path"].is_string(),
                        Some("file_ref") => c["path"].is_string() && opt(c, "mimeType", string),
                        _ => false,
                    }
            })
        })
        && opt(v, "responseFormat", |f| {
            f.is_object()
                && match f["kind"].as_str() {
                    Some("text") => f.get("schema").is_none(),
                    Some("json_schema") => f["schema"].is_object(),
                    _ => false,
                }
        })
        && opt(v, "metadata", string_record)
}
fn spec(v: &Value) -> bool {
    if !v.is_object()
        || v["specVersion"] != "harness-broker.invocation/v1"
        || v.get("lifecyclePolicy").is_some()
        || !opt(v, "labels", string_record)
        || !opt(v, "correlation", string_record)
    {
        return false;
    }
    let h = &v["harness"];
    let p = &v["process"];
    let d = &v["driver"];
    if !h.is_object()
        || !required_strings(h, &["frontend", "driver"])
        || !opt(h, "provider", string)
        || !p.is_object()
    {
        return false;
    }
    let native = member(
        &h["driver"],
        &["agent-harness", "agent-harness-tmux", "foundry-resident"],
    );
    if p["execution"] == "native-worker" {
        if p.get("command").is_some() || p.get("args").is_some() {
            return false;
        }
    } else if !p["command"].is_string() || !strings(&p["args"]) {
        return false;
    }
    let transport = &p["harnessTransport"];
    if !p["cwd"].is_string()
        || !opt(p, "lockedEnv", allowed_env)
        || !opt(p, "pathPrepend", strings)
        || !transport.is_object()
        || !member(
            &transport["kind"],
            &[
                "jsonrpc-stdio",
                "pipes",
                "pty",
                "in-process",
                "native-worker",
            ],
        )
        || (transport["kind"] == "pty" && !optional_numbers(transport, &["cols", "rows"]))
        || !opt(p, "limits", |l| {
            l.is_object()
                && optional_numbers(
                    l,
                    &[
                        "startupTimeoutMs",
                        "turnTimeoutMs",
                        "stopGraceMs",
                        "maxEventBytes",
                    ],
                )
        })
    {
        return false;
    }
    if !native && (p.get("execution").is_some() || transport["kind"] == "native-worker") {
        return false;
    }
    if (p["execution"] == "native-worker") != (transport["kind"] == "native-worker") {
        return false;
    }
    if !opt(v, "interaction", |i| {
        i.is_object()
            && member(&i["mode"], &["headless", "interactive", "service"])
            && opt(i, "turnConcurrency", |x| x == "single")
            && opt(i, "inputQueue", |x| member(x, &["none", "fifo"]))
    }) || !opt(v, "continuation", |c| {
        c.is_object() && required_strings(c, &["provider", "key"]) && opt(c, "kind", string)
    }) || !driver(d)
        || h["driver"] != d["kind"]
    {
        return false;
    }
    let sdk = member(
        &h["driver"],
        &[
            "pi-sdk",
            "agent-harness",
            "agent-harness-tmux",
            "foundry-resident",
        ],
    );
    let in_process = member(&h["driver"], &["pi-sdk", "arris-resident"]);
    if !sdk {
        if v.get("sdk").is_some() || !in_process && transport["kind"] == "in-process" {
            return false;
        }
    } else {
        let s = &v["sdk"];
        if !s.is_object()
            || s["runtime"] != "pi-sdk"
            || !required_strings(s, &["provider", "modelId"])
            || !member(&s["authMode"], &["api-key", "oauth"])
            || !opt(s, "thinkingLevel", string)
        {
            return false;
        }
        if native
            && (transport["kind"] != "native-worker"
                || p["execution"] != "native-worker"
                || v.get("agent").is_none()
                || d.get("controlProtocol").is_some())
        {
            return false;
        }
        if h["driver"] == "pi-sdk"
            && (transport["kind"] != "in-process"
                || p["command"] != "in-process"
                || p["args"].as_array().is_some_and(|a| !a.is_empty()))
        {
            return false;
        }
    }
    opt(v, "agent", agent)
        && opt(v, "launch", |l| {
            l.is_object()
                && optional_strings(l, &["systemPromptFile", "initialPrompt"])
                && opt(l, "systemPromptMode", |x| member(x, &["append", "replace"]))
        })
}
pub fn valid_start(v: &Value) -> bool {
    v.is_object()
        && spec(&v["spec"])
        && opt(v, "initialInput", input)
        && v.get("runtime").is_none()
        && v.get("lifecyclePolicy").is_none()
}

// Same credential predicate used by Bun to remove pi-sdk dispatch credentials.
pub fn credential_key(key: &str) -> bool {
    [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "GITHUB_TOKEN",
    ]
    .contains(&key)
        || key.ends_with("_TOKEN")
        || key.ends_with("_PASSWORD")
}
