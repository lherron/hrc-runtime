//! Detached responder (§4.4): while no read-write client is attached, watch
//! the child's output for the startup queries and answer them with the bytes
//! a real Ghostty answered (`responder-answers.json`, recorded by
//! `e2e/record_answers.py`). Two replies are parameterised by live state, as
//! Ghostty's are: the kitty keyboard flags the model holds, and the cell size.
use serde::Deserialize;

/// The recording compiled into the binary; `--answers` overrides it.
pub(crate) const RECORDED: &str = include_str!("../responder-answers.json");

#[derive(Deserialize)]
struct AnswerFile {
    answers: Vec<Answer>,
}

#[derive(Deserialize, Clone)]
pub(crate) struct Answer {
    pub(crate) name: String,
    /// The exact query bytes Claude Code sends.
    query: String,
    /// The exact reply bytes Ghostty sent; empty means Ghostty did not answer.
    reply: String,
    /// `kitty_flags` or `cell_size`: the reply's numbers come from live state
    /// in the recorded reply's shape.
    #[serde(default)]
    template: Option<String>,
}

pub(crate) struct Live {
    pub(crate) kitty_flags: u8,
    /// Cell size in pixels (width, height) of the last attached client.
    pub(crate) cell_px: Option<(u32, u32)>,
}

#[derive(Clone, Copy, PartialEq)]
enum State {
    Ground,
    Esc,
    Csi,
    /// OSC, DCS or APC body; `bel_ends` for OSC.
    Str {
        bel_ends: bool,
    },
    StrEsc,
}

const MAX_SEQ: usize = 512;

pub(crate) struct Responder {
    answers: Vec<Answer>,
    state: State,
    seq: Vec<u8>,
    overflow: bool,
}

impl Responder {
    pub(crate) fn load(json: &str) -> anyhow::Result<Self> {
        let file: AnswerFile = serde_json::from_str(json)?;
        Ok(Responder {
            answers: file.answers,
            state: State::Ground,
            seq: Vec::new(),
            overflow: false,
        })
    }

    /// Forget any half-seen sequence: a query split across an attach is
    /// dropped, not answered late (§4.4).
    pub(crate) fn reset(&mut self) {
        self.state = State::Ground;
        self.seq.clear();
        self.overflow = false;
    }

    /// Scan one chunk of child output; returns (query name, reply) for every
    /// complete query that has a recorded answer.
    pub(crate) fn scan(&mut self, bytes: &[u8], live: &Live) -> Vec<(String, Vec<u8>)> {
        let mut out = Vec::new();
        for &b in bytes {
            if let Some(seq) = self.step(b)
                && let Some(reply) = self.answer(&seq, live)
            {
                out.push(reply);
            }
        }
        out
    }

    fn push(&mut self, b: u8) {
        if self.seq.len() < MAX_SEQ {
            self.seq.push(b);
        } else {
            self.overflow = true;
        }
    }

    fn finish(&mut self) -> Option<Vec<u8>> {
        self.state = State::Ground;
        let seq = std::mem::take(&mut self.seq);
        (!std::mem::take(&mut self.overflow)).then_some(seq)
    }

    fn step(&mut self, b: u8) -> Option<Vec<u8>> {
        if b == 0x18 || b == 0x1a {
            self.reset();
            return None;
        }
        match self.state {
            State::Ground => {
                if b == 0x1b {
                    self.seq.clear();
                    self.seq.push(b);
                    self.state = State::Esc;
                }
                None
            }
            State::Esc => {
                self.push(b);
                self.state = match b {
                    b'[' => State::Csi,
                    b']' => State::Str { bel_ends: true },
                    b'_' | b'P' => State::Str { bel_ends: false },
                    0x1b => {
                        self.seq = vec![0x1b];
                        State::Esc
                    }
                    _ => State::Ground,
                };
                None
            }
            State::Csi => {
                self.push(b);
                if (0x40..=0x7e).contains(&b) {
                    return self.finish();
                }
                if b == 0x1b {
                    self.seq = vec![0x1b];
                    self.state = State::Esc;
                }
                None
            }
            State::Str { bel_ends } => {
                self.push(b);
                if b == 0x07 && bel_ends {
                    return self.finish();
                }
                if b == 0x1b {
                    self.state = State::StrEsc;
                }
                None
            }
            State::StrEsc => {
                if b == b'\\' {
                    self.push(b);
                    return self.finish();
                }
                // ESC that was not ST starts a new sequence.
                self.seq = vec![0x1b];
                self.overflow = false;
                self.state = State::Esc;
                self.step(b)
            }
        }
    }

    fn answer(&self, seq: &[u8], live: &Live) -> Option<(String, Vec<u8>)> {
        let a = self.answers.iter().find(|a| a.query.as_bytes() == seq)?;
        if a.reply.is_empty() {
            return None;
        }
        let reply = match a.template.as_deref() {
            Some("kitty_flags") => format!("\x1b[?{}u", live.kitty_flags).into_bytes(),
            Some("cell_size") => match live.cell_px {
                Some((w, h)) => format!("\x1b[6;{h};{w}t").into_bytes(),
                None => a.reply.clone().into_bytes(),
            },
            _ => a.reply.clone().into_bytes(),
        };
        Some((a.name.clone(), reply))
    }

    /// The recorded cell size (`CSI 16 t` reply), the default before any
    /// client has attached.
    pub(crate) fn recorded_cell_px(&self) -> Option<(u32, u32)> {
        let a = self
            .answers
            .iter()
            .find(|a| a.template.as_deref() == Some("cell_size"))?;
        let body = a.reply.strip_prefix("\x1b[6;")?.strip_suffix('t')?;
        let (h, w) = body.split_once(';')?;
        Some((w.parse().ok()?, h.parse().ok()?))
    }
}
