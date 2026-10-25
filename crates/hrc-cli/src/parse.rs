use crate::{Error, Result};
use serde_json::Value;
use std::collections::BTreeMap;

pub(crate) struct Parsed<'a> {
    pub node: &'a Value,
    pub options: BTreeMap<String, String>,
    pub positionals: Vec<String>,
    pub help: bool,
    global_agent: bool,
}
impl Parsed<'_> {
    pub fn flag(&self, key: &str) -> bool {
        if key == "agent" {
            return self.global_agent;
        }
        self.options.get(key).is_some_and(|v| v == "true")
    }
    pub fn value(&self, key: &str) -> Option<&str> {
        self.options.get(key).map(String::as_str)
    }
    pub fn path(&self) -> String {
        self.node["path"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" ")
    }
}

pub(crate) fn parse<'a>(surface: &'a Value, args: &[String]) -> Result<Parsed<'a>> {
    let mut parsed = Parsed {
        node: surface,
        options: BTreeMap::new(),
        positionals: Vec::new(),
        help: false,
        global_agent: false,
    };
    let mut index = 0;
    let mut literal = false;
    while index < args.len() {
        let token = &args[index];
        index += 1;
        if token == "--" && !literal {
            literal = true;
            continue;
        }
        if !literal && (token == "--help" || token == "-h") {
            parsed.help = true;
            continue;
        }
        if !literal && token.starts_with('-') && token != "-" {
            let (name, inline) = token
                .split_once('=')
                .map_or((token.as_str(), None), |(a, b)| (a, Some(b)));
            let opt =
                parsed.node["options"].as_array().unwrap().iter().find(|o| {
                    o["long"].as_str() == Some(name) || o["short"].as_str() == Some(name)
                });
            let Some(opt) = opt else {
                return Err(Error::usage(format!("unknown option: {name}")));
            };
            let key = opt["long"]
                .as_str()
                .unwrap_or(name)
                .trim_start_matches('-')
                .to_owned();
            let takes_value = opt["required"] == true || opt["optional"] == true;
            let value = if let Some(inline) = inline {
                inline.to_owned()
            } else if takes_value
                && args
                    .get(index)
                    .is_some_and(|s| opt["required"] == true || !s.starts_with('-'))
            {
                index += 1;
                args[index - 1].clone()
            } else if opt["required"] == true {
                return Err(command_error(
                    &parsed,
                    format!(
                        "error: option '{}' argument missing",
                        opt["flags"].as_str().unwrap()
                    ),
                ));
            } else {
                "true".into()
            };
            if key == "output" && value != "json" {
                return Err(command_error(
                    &parsed,
                    format!(
                        "error: option '--output <format>' argument '{value}' is invalid. Allowed choices are json."
                    ),
                ));
            }
            // The global presentation flag and runtime list's --agent <id>
            // have distinct Commander owners despite sharing a spelling.
            if key == "agent" && !takes_value {
                parsed.global_agent = value == "true";
            } else {
                parsed.options.insert(key, value);
            }
        } else if !literal && parsed.positionals.is_empty() {
            let child = parsed.node["children"]
                .as_array()
                .unwrap()
                .iter()
                .find(|n| {
                    n["name"] == *token
                        || n["aliases"].as_array().unwrap().iter().any(|a| a == token)
                });
            if let Some(child) = child {
                parsed.node = child;
            } else {
                parsed.positionals.push(token.clone());
            }
        } else {
            parsed.positionals.push(token.clone());
        }
    }
    if !parsed.node["children"].as_array().unwrap().is_empty() && !parsed.positionals.is_empty() {
        let mut names = vec!["help".to_owned()];
        for child in parsed.node["children"].as_array().unwrap() {
            names.push(child["name"].as_str().unwrap().to_owned());
            names.extend(
                child["aliases"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned),
            );
        }
        names.sort();
        names.dedup();
        return Err(Error::usage(format!(
            "unknown command: {}. Available commands: {}",
            parsed.positionals[0],
            names.join(", ")
        )));
    }
    if parsed.flag("agent") && parsed.flag("human") {
        return Err(Error::usage("--agent and --human are mutually exclusive"));
    }
    if !parsed.help {
        let arguments = parsed.node["arguments"].as_array().unwrap();
        if parsed.path() != "ls"
            && parsed.positionals.len() > arguments.len()
            && !arguments.iter().any(|a| a["variadic"] == true)
        {
            return Err(command_error(
                &parsed,
                format!(
                    "error: too many arguments for '{}'. Expected {} arguments but got {}.",
                    parsed.node["name"].as_str().unwrap(),
                    arguments.len(),
                    parsed.positionals.len()
                ),
            ));
        }
        for opt in parsed.node["options"].as_array().unwrap() {
            let name = opt["long"]
                .as_str()
                .unwrap_or_default()
                .trim_start_matches('-');
            if opt["mandatory"] == true && !parsed.options.contains_key(name) {
                return Err(command_error(
                    &parsed,
                    format!(
                        "error: required option '{}' not specified",
                        opt["flags"].as_str().unwrap()
                    ),
                ));
            }
        }
        for (i, arg) in parsed.node["arguments"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
        {
            if arg["required"] == true && parsed.positionals.get(i).is_none() {
                return Err(command_error(
                    &parsed,
                    format!(
                        "error: missing required argument '{}'",
                        arg["name"].as_str().unwrap()
                    ),
                ));
            }
        }
    }
    if parsed.value("output") == Some("json") {
        if !parsed.node["options"]
            .as_array()
            .unwrap()
            .iter()
            .any(|o| o["long"] == "--json")
        {
            return Err(Error::usage(format!(
                "--output json is not supported by '{}'",
                parsed.node["name"].as_str().unwrap()
            )));
        }
        parsed.options.insert("json".into(), "true".into());
    }
    Ok(parsed)
}
fn command_error(parsed: &Parsed<'_>, message: String) -> Error {
    let path = parsed.path();
    Error::usage(format!(
        "{message}\ncommand: hrc{}\nusage: {}",
        if path.is_empty() {
            String::new()
        } else {
            format!(" {path}")
        },
        parsed.node["usage"].as_str().unwrap_or_default()
    ))
}
