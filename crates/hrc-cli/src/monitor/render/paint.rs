//! chalk's styling for the human renderers.

pub(super) fn stdout_is_tty() -> bool {
    std::io::IsTerminal::is_terminal(&std::io::stdout())
}

/// chalk 5 / supports-color level for stdout, reduced to on/off: every style
/// used here is a basic 16-color or modifier code, identical at levels 1–3.
fn color_enabled() -> bool {
    let env = |k: &str| std::env::var(k).ok();
    let force = env("FORCE_COLOR").map(|v| match v.as_str() {
        "true" => Some(1.),
        "false" => Some(0.),
        "" => Some(1.),
        v => {
            let t = v.trim_start();
            let digits = t
                .strip_prefix(['-', '+'])
                .unwrap_or(t)
                .bytes()
                .take_while(u8::is_ascii_digit)
                .count();
            let sign = usize::from(t.starts_with(['-', '+']));
            t[..digits + sign].parse::<f64>().ok().map(|n| n.min(3.))
        }
    });
    let force = force.map(|f| f.unwrap_or(f64::NAN));
    if force == Some(0.) {
        return false;
    }
    if env("TF_BUILD").is_some() && env("AGENT_NAME").is_some() {
        return true;
    }
    if !stdout_is_tty() && force.is_none() {
        return false;
    }
    let min = force.filter(|f| *f != 0. && !f.is_nan()).unwrap_or(0.);
    let term = env("TERM").unwrap_or_default();
    if term == "dumb" {
        return min > 0.;
    }
    if env("CI").is_some() {
        if [
            "GITHUB_ACTIONS",
            "GITEA_ACTIONS",
            "CIRCLECI",
            "TRAVIS",
            "APPVEYOR",
            "GITLAB_CI",
            "BUILDKITE",
            "DRONE",
        ]
        .iter()
        .any(|k| env(k).is_some())
            || env("CI_NAME").as_deref() == Some("codeship")
        {
            return true;
        }
        return min > 0.;
    }
    if let Some(v) = env("TEAMCITY_VERSION") {
        let major = v.split('.').next().unwrap_or_default();
        let minor = v.split('.').nth(1).unwrap_or_default();
        return (major == "9"
            && minor
                .trim_start_matches('0')
                .starts_with(|c: char| c.is_ascii_digit())
            && v.matches('.').count() >= 2)
            || (major.len() >= 2 && major.bytes().all(|b| b.is_ascii_digit()) && v.contains('.'));
    }
    if env("COLORTERM").as_deref() == Some("truecolor")
        || ["xterm-kitty", "xterm-ghostty", "wezterm"].contains(&term.as_str())
    {
        return true;
    }
    if let Some(program) = env("TERM_PROGRAM")
        && (program == "iTerm.app" || program == "Apple_Terminal")
    {
        return true;
    }
    let lower = term.to_ascii_lowercase();
    if lower.ends_with("-256") || lower.ends_with("-256color") {
        return true;
    }
    if ["screen", "xterm", "vt100", "vt220", "rxvt"]
        .iter()
        .any(|p| lower.starts_with(p))
        || ["color", "ansi", "cygwin", "linux"]
            .iter()
            .any(|p| lower.contains(p))
    {
        return true;
    }
    env("COLORTERM").is_some() || min > 0.
}

#[derive(Clone, Copy)]
pub(crate) struct Paint {
    on: bool,
}
type Style = (&'static str, &'static str);
pub(super) const DIM: Style = ("\x1b[2m", "\x1b[22m");
pub(super) const BOLD: Style = ("\x1b[1m", "\x1b[22m");
pub(super) const CYAN: Style = ("\x1b[36m", "\x1b[39m");
pub(super) const CYAN_BRIGHT: Style = ("\x1b[96m", "\x1b[39m");
pub(super) const GREEN: Style = ("\x1b[32m", "\x1b[39m");
pub(super) const GREEN_BRIGHT: Style = ("\x1b[92m", "\x1b[39m");
pub(super) const RED: Style = ("\x1b[31m", "\x1b[39m");
pub(super) const YELLOW_BRIGHT: Style = ("\x1b[93m", "\x1b[39m");
pub(super) const MAGENTA: Style = ("\x1b[35m", "\x1b[39m");
pub(super) const BLUE: Style = ("\x1b[34m", "\x1b[39m");
pub(super) const BLUE_BRIGHT: Style = ("\x1b[94m", "\x1b[39m");
pub(super) const WHITE: Style = ("\x1b[37m", "\x1b[39m");
pub(super) const BLACK: Style = ("\x1b[30m", "\x1b[39m");
pub(super) const BG_WHITE: Style = ("\x1b[47m", "\x1b[49m");

impl Paint {
    pub fn detect() -> Self {
        Self {
            on: color_enabled(),
        }
    }
    /// chalk's applyStyle for a chain of styles (outermost first).
    pub(super) fn chain(self, styles: &[Style], text: &str) -> String {
        if !self.on || text.is_empty() {
            return text.into();
        }
        let mut text = text.to_owned();
        if text.contains('\x1b') {
            for (open, close) in styles.iter().rev() {
                text = text.replace(close, &format!("{close}{open}"));
            }
        }
        let open_all = styles.iter().map(|s| s.0).collect::<String>();
        let close_all = styles.iter().rev().map(|s| s.1).collect::<String>();
        if text.contains('\n') {
            let mut out = String::new();
            let mut rest = text.as_str();
            while let Some(i) = rest.find('\n') {
                let cr = i > 0 && rest.as_bytes()[i - 1] == b'\r';
                out.push_str(&rest[..if cr { i - 1 } else { i }]);
                out.push_str(&close_all);
                out.push_str(if cr { "\r\n" } else { "\n" });
                out.push_str(&open_all);
                rest = &rest[i + 1..];
            }
            out.push_str(rest);
            text = out;
        }
        format!("{open_all}{text}{close_all}")
    }
    pub(super) fn s(self, style: Style, text: &str) -> String {
        self.chain(&[style], text)
    }
}
