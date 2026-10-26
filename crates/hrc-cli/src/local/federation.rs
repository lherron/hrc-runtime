//! hrc-server federation/federation-config.ts `resolveFederationConfig` and
//! `summarizeFederationConfig`, with node-id.ts, registry-bind.ts and
//! peer-protocol.ts `parsePeerProtocolBind`. Every diagnostic matches Bun.
use super::{js_json, js_keys, node_join};
use reqwest::Url;
use serde_json::{Map, Value, json};

type Fallible<T> = Result<T, String>;

const GATE_MODES: [&str; 3] = ["off", "advisory", "enforce"];

fn quote(s: &str) -> String {
    serde_json::to_string(s).unwrap()
}

fn node_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')
}

fn is_reserved(value: &str) -> bool {
    value.to_lowercase() == "local"
}
pub fn is_valid_node_id(value: &str) -> bool {
    node_id_violation(value).is_none()
}

/// node-id.ts `describeNodeIdViolation`.
fn node_id_violation(value: &str) -> Option<String> {
    let len = crate::js::utf16_len(value);
    if len == 0 {
        return Some("it is empty".into());
    }
    if len > 64 {
        return Some(format!("it is {len} characters (maximum 64)"));
    }
    if !value.chars().all(node_char) {
        let mut unique: Vec<char> = Vec::new();
        for c in value.chars().filter(|c| !node_char(*c)) {
            if !unique.contains(&c) {
                unique.push(c);
            }
        }
        let list: Vec<String> = unique.iter().map(|c| quote(&c.to_string())).collect();
        return Some(format!(
            "it contains disallowed character(s) {} (allowed: A-Z a-z 0-9 . _ -)",
            list.join(", ")
        ));
    }
    if is_reserved(value) {
        return Some("it is the reserved placement sentinel \"local\" (federation spec §5)".into());
    }
    None
}

fn parse_node_id(value: &str, context: &str) -> Fallible<String> {
    match node_id_violation(value) {
        Some(v) => Err(format!(
            "{context} is not a valid nodeId ({}): {v}",
            quote(value)
        )),
        None => Ok(value.to_owned()),
    }
}

/// `deriveNodeIdFromHostname(os.hostname())`.
fn derive_node_id() -> String {
    let mut buf = [0u8; 256];
    let raw = unsafe {
        if libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) == 0 {
            let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
            String::from_utf8_lossy(&buf[..end]).into_owned()
        } else {
            String::new()
        }
    };
    let short = crate::js::trim(&raw)
        .split('.')
        .next()
        .unwrap_or("")
        .to_owned();
    let sanitized: String = short
        .to_lowercase()
        .encode_utf16()
        .map(|u| {
            char::from_u32(u as u32)
                .filter(|c| node_char(*c))
                .unwrap_or('-')
        })
        .take(64)
        .collect();
    if sanitized.is_empty() || is_reserved(&sanitized) {
        "unknown-node".into()
    } else {
        sanitized
    }
}

pub(super) fn config_path(state_root: &str) -> String {
    if let Ok(configured) = std::env::var("HRC_PEER_CONFIG_FILE") {
        let configured = crate::js::trim(&configured);
        if !configured.is_empty() {
            return configured.to_owned();
        }
    }
    node_join(&[state_root, "federation.json"])
}

/// WHATWG `URL.hostname`; the url crate's host slice keeps IPv6 brackets too.
fn hostname(url: &Url) -> String {
    url.host_str().unwrap_or_default().to_owned()
}

fn port(url: &Url) -> String {
    url.port().map(|p| p.to_string()).unwrap_or_default()
}

fn validate_peer_endpoint(endpoint: &str, place: &str) -> Fallible<String> {
    let url = Url::parse(endpoint)
        .map_err(|_| format!("{place} endpoint is not a valid URL: {}", quote(endpoint)))?;
    let protocol = format!("{}:", url.scheme());
    if protocol != "http:" && protocol != "https:" {
        return Err(format!(
            "{place} endpoint must use http: or https:, got {}",
            quote(&protocol)
        ));
    }
    let name = hostname(&url);
    let host = strip_brackets(&name);
    if host.is_empty() {
        return Err(format!("{place} endpoint has no host: {}", quote(endpoint)));
    }
    if host.contains('*') || host == "0.0.0.0" || host == "::" {
        return Err(format!(
            "{place} endpoint must name a specific host, not the wildcard/unspecified address {}",
            quote(&name)
        ));
    }
    Ok(url.to_string())
}

/// `host.replace(/^\[|\]$/g, '')`
fn strip_brackets(host: &str) -> &str {
    let host = host.strip_prefix('[').unwrap_or(host);
    host.strip_suffix(']').unwrap_or(host)
}

/// registry-bind.ts `isTailnetHost`.
fn is_tailnet_host(raw: &str) -> bool {
    let host = strip_brackets(raw).to_lowercase();
    if let Ok(v4) = host.parse::<std::net::Ipv4Addr>() {
        let o = v4.octets();
        return o[0] == 100 && (64..=127).contains(&o[1]);
    }
    if host.parse::<std::net::Ipv6Addr>().is_ok() {
        return host.starts_with("fd7a:115c:a1e0:");
    }
    host.ends_with(".ts.net") && host.len() > ".ts.net".len()
}

const TAILNET: &str = "(100.64.0.0/10, fd7a:115c:a1e0::/48, or *.ts.net)";

fn validate_registry_endpoint(endpoint: &str, place: &str) -> Fallible<String> {
    let url = Url::parse(endpoint)
        .map_err(|_| format!("{place} is not a valid URL: {}", quote(endpoint)))?;
    let protocol = format!("{}:", url.scheme());
    if protocol != "http:" && protocol != "https:" {
        return Err(format!(
            "{place} must use http: or https:, got {}",
            quote(&protocol)
        ));
    }
    if !url.username().is_empty() || url.password().is_some_and(|p| !p.is_empty()) {
        return Err(format!("{place} must not contain embedded credentials"));
    }
    let port = port(&url);
    if port.is_empty() {
        return Err(format!("{place} must include an explicit port"));
    }
    if !(1..=65_535).contains(&port.parse::<u32>().unwrap_or(0)) {
        return Err(format!("{place} port must be between 1 and 65535"));
    }
    let name = hostname(&url);
    if !is_tailnet_host(&name) {
        return Err(format!(
            "{place} must name a specific tailnet host {TAILNET}, got {}",
            quote(&name)
        ));
    }
    // endpoint.slice(endpoint.indexOf('//') + 2), in UTF-16 units.
    let units: Vec<u16> = endpoint.encode_utf16().collect();
    let slash = units
        .windows(2)
        .position(|w| w == [b'/' as u16, b'/' as u16])
        .map_or(-1, |i| i as i64);
    let after = &units[((slash + 2) as usize).min(units.len())..];
    let suffix = after
        .iter()
        .position(|u| [b'/' as u16, b'?' as u16, b'#' as u16].contains(u))
        .map_or(&[][..], |i| &after[i..]);
    if !suffix.is_empty() && suffix != [b'/' as u16] {
        return Err(format!(
            "{place} must be an origin with no path, query, or fragment"
        ));
    }
    Ok(url.to_string())
}

/// registry-bind.ts `parseRegistryBind` and `parsePeerProtocolBind`.
fn parse_bind(raw: &str, place: &str, specific: &str) -> Fallible<()> {
    let bind = crate::js::trim(raw);
    let url = Url::parse(bind)
        .map_err(|_| format!("{place} bind is not a valid URL: {}", quote(bind)))?;
    if url.scheme() != "http" {
        return Err(format!(
            "{place} bind must use http: (tailnet supplies transport encryption)"
        ));
    }
    let port = port(&url);
    if port.is_empty() {
        return Err(format!("{place} bind must include an explicit port"));
    }
    if !(1..=65_535).contains(&port.parse::<u32>().unwrap_or(0)) {
        return Err(format!("{place} bind port must be between 1 and 65535"));
    }
    let path = url.path();
    if !url.username().is_empty()
        || url.password().is_some_and(|p| !p.is_empty())
        || url.query().is_some_and(|q| !q.is_empty())
        || url.fragment().is_some_and(|f| !f.is_empty())
        || (!path.is_empty() && path != "/")
    {
        return Err(format!(
            "{place} bind must contain only {specific}tailnet host and explicit port"
        ));
    }
    let name = hostname(&url);
    if !is_tailnet_host(&name) {
        return Err(format!(
            "{place} bind must name a specific tailnet host {TAILNET}, got {}",
            quote(&name)
        ));
    }
    Ok(())
}

fn non_empty_string(value: Option<&Value>, trimmed: bool) -> Option<&str> {
    value.and_then(Value::as_str).filter(|s| {
        if trimmed {
            !crate::js::trim(s).is_empty()
        } else {
            !s.is_empty()
        }
    })
}

/// `JSON.stringify(x)` where x may be `undefined`.
fn stringify(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".into(), js_json)
}

/// One `peers` entry; the tokens stay in daemon memory and never reach a summary.
#[derive(Clone, Debug)]
pub struct FederationPeer {
    pub node_id: String,
    /// Peer-protocol origin, as WHATWG `URL.toString()` normalized it.
    pub endpoint: String,
    pub registry_endpoint: Option<String>,
    pub token: String,
    pub accepted_tokens: Vec<String>,
}

/// federation-config.ts `FederationConfig`, with secrets.
#[derive(Clone, Debug)]
pub struct FederationConfig {
    pub node_id: String,
    pub node_id_provenance: &'static str,
    pub source_path: String,
    pub source_exists: bool,
    pub peers: Vec<FederationPeer>,
    /// Trimmed `registry.bind`, present only on the registry host.
    pub registry_bind: Option<String>,
    pub peer_listener_bind: Option<String>,
    pub gate_mode: String,
    pub registry_host: Option<String>,
}

impl FederationConfig {
    /// `summarizeFederationConfig`: tokens are absent by construction.
    pub fn summary(&self) -> Value {
        let peers: Vec<Value> = self.peers.iter().map(FederationPeer::summary).collect();
        json!({
            "nodeId": self.node_id,
            "nodeIdProvenance": self.node_id_provenance,
            "mode": if peers.is_empty() { "single-node" } else { "federated" },
            "configPath": self.source_path,
            "configExists": self.source_exists,
            "peerCount": peers.len(),
            "peers": peers,
        })
    }
}

impl FederationPeer {
    fn summary(&self) -> Value {
        let mut summary = json!({"nodeId": self.node_id, "endpoint": self.endpoint});
        if let Some(registry) = &self.registry_endpoint {
            summary["registryEndpoint"] = registry.clone().into();
        }
        summary
    }
}

struct Parsed {
    declared: Option<String>,
    peers: Vec<FederationPeer>,
    registry: Option<String>,
    peer_listener: Option<String>,
    gate_mode: Option<String>,
    registry_host: Option<String>,
}

fn parse_document(value: &Value, source: &str) -> Fallible<Parsed> {
    let Some(doc) = value.as_object() else {
        return Err(format!("{source} must contain a JSON object"));
    };
    let mut declared = None;
    if let Some(node_id) = doc.get("nodeId") {
        let Some(node_id) = node_id.as_str() else {
            return Err(format!("{source} field \"nodeId\" must be a string"));
        };
        declared = Some(parse_node_id(
            node_id,
            &format!("{source} field \"nodeId\""),
        )?);
    }
    let mut peers = Vec::new();
    let mut owners: Vec<(String, String)> = Vec::new();
    if let Some(raw_peers) = doc.get("peers") {
        let Some(raw_peers) = raw_peers.as_object() else {
            return Err(format!(
                "{source} field \"peers\" must be a JSON object of nodeId to peer entries"
            ));
        };
        for peer_id in js_keys(raw_peers) {
            let entry = &raw_peers[peer_id];
            let place = format!("{source} peer {}", quote(peer_id));
            if let Some(v) = node_id_violation(peer_id) {
                return Err(format!("{place} has an invalid nodeId key: {v}"));
            }
            if declared.as_deref() == Some(peer_id.as_str()) {
                return Err(format!(
                    "{place} is this node's own nodeId — a node cannot be its own peer"
                ));
            }
            let Some(entry) = entry.as_object() else {
                return Err(format!(
                    "{place} must be a JSON object with \"endpoint\" and \"token\""
                ));
            };
            let Some(endpoint) = non_empty_string(entry.get("endpoint"), true) else {
                return Err(format!(
                    "{place} is missing a non-empty string \"endpoint\""
                ));
            };
            let registry_place = format!("{source} peers.{peer_id}.registryEndpoint");
            let raw_registry = entry.get("registryEndpoint");
            if raw_registry.is_some() && non_empty_string(raw_registry, true).is_none() {
                return Err(format!("{registry_place} must be a non-empty string"));
            }
            let Some(token) = non_empty_string(entry.get("token"), false) else {
                return Err(format!("{place} is missing a non-empty string \"token\""));
            };
            let accepted: Vec<String> = match entry.get("acceptedTokens") {
                None => vec![token.to_owned()],
                Some(raw) => {
                    let list = raw.as_array().filter(|a| {
                        !a.is_empty() && a.iter().all(|t| t.as_str().is_some_and(|s| !s.is_empty()))
                    });
                    let Some(list) = list else {
                        return Err(format!(
                            "{place} field \"acceptedTokens\" must be a non-empty array of strings"
                        ));
                    };
                    list.iter()
                        .map(|t| t.as_str().unwrap().to_owned())
                        .collect()
                }
            };
            let mut seen: Vec<&String> = Vec::new();
            for t in &accepted {
                if !seen.contains(&t) {
                    seen.push(t);
                }
            }
            if seen.len() != accepted.len() {
                return Err(format!(
                    "{place} field \"acceptedTokens\" must not contain duplicate tokens"
                ));
            }
            let mut tokens: Vec<String> = vec![token.to_owned()];
            for t in &accepted {
                if !tokens.contains(t) {
                    tokens.push(t.clone());
                }
            }
            for t in tokens {
                if let Some((_, owner)) = owners.iter().find(|(k, _)| *k == t)
                    && owner != peer_id
                {
                    return Err(format!(
                        "{place} reuses the bearer token configured for peer {}; each peer requires distinct outbound and accepted tokens",
                        quote(owner)
                    ));
                }
                match owners.iter_mut().find(|(k, _)| *k == t) {
                    Some(slot) => slot.1 = peer_id.clone(),
                    None => owners.push((t, peer_id.clone())),
                }
            }
            let endpoint = validate_peer_endpoint(crate::js::trim(endpoint), &place)?;
            let registry_endpoint = match raw_registry.and_then(Value::as_str) {
                Some(raw) => Some(validate_registry_endpoint(
                    crate::js::trim(raw),
                    &registry_place,
                )?),
                None => None,
            };
            peers.push(FederationPeer {
                node_id: peer_id.clone(),
                endpoint,
                registry_endpoint,
                token: token.to_owned(),
                accepted_tokens: accepted,
            });
        }
    }
    let mut registry = None;
    if let Some(raw) = doc.get("registry") {
        let Some(raw) = raw.as_object() else {
            return Err(format!(
                "{source} field \"registry\" must be a JSON object with \"bind\""
            ));
        };
        let Some(bind) = non_empty_string(raw.get("bind"), true) else {
            return Err(format!(
                "{source} registry is missing a non-empty string \"bind\""
            ));
        };
        parse_bind(bind, &format!("{source} registry"), "a ")?;
        registry = Some(crate::js::trim(bind).to_owned());
    }
    let mut peer_listener = None;
    if let Some(raw) = doc.get("peerListener") {
        let Some(raw) = raw.as_object() else {
            return Err(format!(
                "{source} field \"peerListener\" must be a JSON object with \"bind\""
            ));
        };
        let Some(bind) = non_empty_string(raw.get("bind"), true) else {
            return Err(format!(
                "{source} peerListener is missing a non-empty string \"bind\""
            ));
        };
        parse_bind(bind, &format!("{source} peerListener"), "a specific ")?;
        peer_listener = Some(crate::js::trim(bind).to_owned());
    }
    let (mut gate_mode, mut registry_host) = (None, None);
    if let Some(raw) = doc.get("gate") {
        let place = format!("{source} field \"gate\"");
        let Some(raw) = raw.as_object() else {
            return Err(format!("{place} must be a JSON object with \"mode\""));
        };
        let mode = raw.get("mode");
        if !mode
            .and_then(Value::as_str)
            .is_some_and(|m| GATE_MODES.contains(&m))
        {
            return Err(format!(
                "{place} has an invalid \"mode\" ({}): expected one of {}",
                stringify(mode),
                GATE_MODES.map(quote).join(", ")
            ));
        }
        if let Some(host) = raw.get("registryHost") {
            let Some(host) = host.as_str() else {
                return Err(format!(
                    "{place} field \"registryHost\" must be a string nodeId"
                ));
            };
            registry_host = Some(parse_node_id(
                host,
                &format!("{place} field \"registryHost\""),
            )?);
        }
        gate_mode = mode.and_then(Value::as_str).map(str::to_owned);
    }
    Ok(Parsed {
        declared,
        peers,
        registry,
        peer_listener,
        gate_mode,
        registry_host,
    })
}

/// The config, or the error `resolveFederationConfig` throws.
fn resolve(source: &str) -> Fallible<FederationConfig> {
    let absent = FederationConfig {
        node_id: derive_node_id(),
        node_id_provenance: "derived",
        source_path: source.to_owned(),
        source_exists: false,
        peers: vec![],
        registry_bind: None,
        peer_listener_bind: None,
        gate_mode: "off".into(),
        registry_host: None,
    };
    let raw = match super::read_text(source) {
        Ok(raw) => raw,
        Err((Some(libc::ENOENT), _)) => return Ok(absent),
        Err((_, message)) => {
            return Err(format!(
                "federation config {source} could not be read: {message}"
            ));
        }
    };
    let parsed = super::jsc_json::parse(&raw)
        .map_err(|m| format!("federation config {source} is not valid JSON: {m}"))?;
    let doc = parse_document(&parsed, source)?;
    if doc.declared.is_none() && !doc.peers.is_empty() {
        return Err(format!(
            "federation config {source} declares {} peer(s) but no \"nodeId\": a node with peers must declare its own nodeId (a hostname-derived id is valid only in single-node mode). Fix: add a \"nodeId\" field to {source}, e.g. {{\"nodeId\": \"lab\", \"peers\": {{...}}}}",
            doc.peers.len()
        ));
    }
    if doc.declared.is_none() && doc.registry.is_some() {
        return Err(format!(
            "federation config {source} registry listener requires a declared \"nodeId\" (a hostname-derived id is valid only in single-node mode)"
        ));
    }
    if doc.declared.is_none() && doc.peer_listener.is_some() {
        return Err(format!(
            "federation config {source} peer listener requires a declared \"nodeId\" (a hostname-derived id is valid only in single-node mode)"
        ));
    }
    if doc.peer_listener.is_some() && doc.peers.is_empty() {
        return Err(format!(
            "federation config {source} peer listener requires at least one configured peer for bearer authentication"
        ));
    }
    let (node_id, node_id_provenance) = match doc.declared {
        Some(id) => (id, "declared"),
        None => (absent.node_id, "derived"),
    };
    Ok(FederationConfig {
        node_id,
        node_id_provenance,
        source_exists: true,
        peers: doc.peers,
        registry_bind: doc.registry,
        peer_listener_bind: doc.peer_listener,
        gate_mode: doc.gate_mode.unwrap_or_else(|| "off".into()),
        registry_host: doc.registry_host,
        ..absent
    })
}

/// `resolveFederationConfig` for daemon startup: a malformed file refuses.
pub fn load_config(state_root: &str) -> Fallible<FederationConfig> {
    resolve(&config_path(state_root))
}

/// help.ts `resolveNodeIdentitySummary`.
pub(super) fn node_summary(state_root: &str) -> Value {
    let source = config_path(state_root);
    resolve(&source)
        .map(|config| config.summary())
        .unwrap_or_else(|error| {
            let mut node = Map::new();
            node.insert("nodeId".into(), "(unresolved)".into());
            node.insert("nodeIdProvenance".into(), "unresolved".into());
            node.insert("mode".into(), "unresolved".into());
            node.insert("configPath".into(), source.into());
            node.insert("configExists".into(), true.into());
            node.insert("peerCount".into(), 0.into());
            node.insert("error".into(), error.into());
            Value::Object(node)
        })
}
