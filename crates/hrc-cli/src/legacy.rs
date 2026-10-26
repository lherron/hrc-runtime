//! Bun's legacy argv bridge (cli/argv.ts): `toLegacyArgv` and the
//! `hasFlag`/`parseFlag` rescans its handlers run over the flat list.
use crate::{Error, Result, parse::Parsed};

/// Bun's `toLegacyArgv`: positionals, then each set string option as
/// `--flag value`, then each true boolean as `--flag`. The legacy handlers
/// rescan this flat list, so a value spelled like a flag is seen as one.
pub(crate) fn legacy_argv(
    positionals: &[&str],
    args: &Parsed<'_>,
    strings: &[&str],
    booleans: &[&str],
) -> Vec<String> {
    let mut out: Vec<String> = positionals.iter().map(|s| (*s).to_owned()).collect();
    for flag in strings {
        if let Some(value) = args.value(flag) {
            out.push(format!("--{flag}"));
            out.push(value.to_owned());
        }
    }
    for flag in booleans {
        if args.flag(flag) {
            out.push(format!("--{flag}"));
        }
    }
    out
}

/// Bun `hasFlag`.
pub(crate) fn has_flag(args: &[String], flag: &str) -> bool {
    args.iter().any(|a| a == flag)
}

/// Bun `parseFlag`: the first exact token takes the next one; `--flag=` inline.
pub(crate) fn parse_flag(args: &[String], flag: &str) -> Result<Option<String>> {
    let inline = format!("{flag}=");
    for (i, arg) in args.iter().enumerate() {
        if arg == flag {
            return match args.get(i + 1) {
                Some(value) => Ok(Some(value.clone())),
                None => Err(Error::usage(format!("{flag} requires a value"))),
            };
        }
        if let Some(value) = arg.strip_prefix(&inline) {
            return Ok(Some(value.to_owned()));
        }
    }
    Ok(None)
}
