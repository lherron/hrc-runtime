//! `JSON.parse` as Bun's JavaScriptCore LiteralParser runs it, including its
//! exact error messages (the federation config diagnostic embeds them).
use serde_json::{Map, Number, Value};

#[derive(Clone, PartialEq)]
enum Token {
    LBracket,
    RBracket,
    LBrace,
    RBrace,
    Colon,
    Comma,
    Other(char),
    Str(String),
    Num(f64),
    True,
    False,
    Null,
    Ident(String),
    End,
}

struct Lexer {
    chars: Vec<char>,
    pos: usize,
}

impl Lexer {
    fn peek(&self, offset: usize) -> Option<char> {
        self.chars.get(self.pos + offset).copied()
    }
    fn starts_with(&self, word: &str) -> bool {
        word.chars()
            .enumerate()
            .all(|(i, c)| self.peek(i) == Some(c))
    }
    fn next(&mut self) -> Result<Token, String> {
        while matches!(self.peek(0), Some(' ' | '\t' | '\n' | '\r')) {
            self.pos += 1;
        }
        let Some(c) = self.peek(0) else {
            return Ok(Token::End);
        };
        let single = |t| Ok(t);
        match c {
            '[' => {
                self.pos += 1;
                single(Token::LBracket)
            }
            ']' => {
                self.pos += 1;
                single(Token::RBracket)
            }
            '{' => {
                self.pos += 1;
                single(Token::LBrace)
            }
            '}' => {
                self.pos += 1;
                single(Token::RBrace)
            }
            ':' => {
                self.pos += 1;
                single(Token::Colon)
            }
            ',' => {
                self.pos += 1;
                single(Token::Comma)
            }
            '(' | ')' | '=' | ';' | '.' => {
                self.pos += 1;
                single(Token::Other(c))
            }
            '"' => self.string(),
            '\'' => Err("Single quotes (') are not allowed in JSON".into()),
            '-' | '0'..='9' => self.number(),
            _ if self.starts_with("true") => {
                self.pos += 4;
                Ok(Token::True)
            }
            _ if self.starts_with("false") => {
                self.pos += 5;
                Ok(Token::False)
            }
            _ if self.starts_with("null") => {
                self.pos += 4;
                Ok(Token::Null)
            }
            _ if c.is_ascii_alphabetic() || c == '_' || c == '$' => {
                let start = self.pos;
                while self
                    .peek(0)
                    .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
                {
                    self.pos += 1;
                }
                Ok(Token::Ident(self.chars[start..self.pos].iter().collect()))
            }
            _ => Err(format!("Unrecognized token '{c}'")),
        }
    }
    fn string(&mut self) -> Result<Token, String> {
        self.pos += 1;
        let mut out = String::new();
        // Lone surrogates are representable in JS; Rust strings substitute U+FFFD.
        let mut units: Vec<u16> = Vec::new();
        let flush = |units: &mut Vec<u16>, out: &mut String| {
            out.push_str(&String::from_utf16_lossy(units));
            units.clear();
        };
        loop {
            let Some(c) = self.peek(0) else {
                return Err("Unterminated string".into());
            };
            if c == '"' {
                self.pos += 1;
                flush(&mut units, &mut out);
                return Ok(Token::Str(out));
            }
            if (c as u32) < 0x20 {
                return Err("Unterminated string".into());
            }
            if c != '\\' {
                flush(&mut units, &mut out);
                out.push(c);
                self.pos += 1;
                continue;
            }
            self.pos += 1;
            let Some(e) = self.peek(0) else {
                return Err("Unterminated string".into());
            };
            self.pos += 1;
            let simple = match e {
                '"' => Some('"'),
                '\\' => Some('\\'),
                '/' => Some('/'),
                'b' => Some('\u{8}'),
                'f' => Some('\u{c}'),
                'n' => Some('\n'),
                'r' => Some('\r'),
                't' => Some('\t'),
                _ => None,
            };
            if let Some(s) = simple {
                flush(&mut units, &mut out);
                out.push(s);
                continue;
            }
            if e != 'u' {
                return Err(format!("Invalid escape character {e}"));
            }
            if self.pos + 4 > self.chars.len() {
                return Err("\\u must be followed by 4 hex digits".into());
            }
            let hex: String = self.chars[self.pos..self.pos + 4].iter().collect();
            match u16::from_str_radix(&hex, 16) {
                Ok(unit) if hex.chars().all(|c| c.is_ascii_hexdigit()) => {
                    units.push(unit);
                    self.pos += 4;
                }
                _ => return Err(format!("\"\\u{hex}\" is not a valid unicode escape")),
            }
        }
    }
    fn number(&mut self) -> Result<Token, String> {
        let start = self.pos;
        if self.peek(0) == Some('-') {
            self.pos += 1;
        }
        match self.peek(0) {
            Some('0') => self.pos += 1,
            Some('1'..='9') => {
                while self.peek(0).is_some_and(|c| c.is_ascii_digit()) {
                    self.pos += 1;
                }
            }
            _ => return Err("Invalid number".into()),
        }
        if self.peek(0) == Some('.') {
            self.pos += 1;
            if !self.peek(0).is_some_and(|c| c.is_ascii_digit()) {
                return Err("Invalid digits after decimal point".into());
            }
            while self.peek(0).is_some_and(|c| c.is_ascii_digit()) {
                self.pos += 1;
            }
        }
        if matches!(self.peek(0), Some('e' | 'E')) {
            let sign = usize::from(matches!(self.peek(1), Some('+' | '-')));
            // An exponent without digits is not consumed.
            if self.peek(1 + sign).is_some_and(|c| c.is_ascii_digit()) {
                self.pos += 1 + sign;
                while self.peek(0).is_some_and(|c| c.is_ascii_digit()) {
                    self.pos += 1;
                }
            }
        }
        let text: String = self.chars[start..self.pos].iter().collect();
        Ok(Token::Num(text.parse().unwrap_or(f64::NAN)))
    }
}

fn unexpected(token: &Token) -> String {
    match token {
        Token::End => "Unexpected EOF".into(),
        Token::Ident(name) => format!("Unexpected identifier \"{name}\""),
        Token::LBracket => "Unexpected token '['".into(),
        Token::RBracket => "Unexpected token ']'".into(),
        Token::LBrace => "Unexpected token '{'".into(),
        Token::RBrace => "Unexpected token '}'".into(),
        Token::Colon => "Unexpected token ':'".into(),
        Token::Comma => "Unexpected token ','".into(),
        Token::Other(c) => format!("Unexpected token '{c}'"),
        _ => "Unable to parse JSON string".into(),
    }
}

fn number(n: f64) -> Value {
    if n.fract() == 0. && n.abs() < 9_007_199_254_740_992. && !(n == 0. && n.is_sign_negative()) {
        Value::from(n as i64)
    } else {
        Number::from_f64(n).map_or(Value::Null, Value::Number)
    }
}

struct Parser {
    lexer: Lexer,
}

impl Parser {
    fn value(&mut self, token: Token) -> Result<Value, String> {
        match token {
            Token::Str(s) => Ok(Value::String(s)),
            Token::Num(n) => Ok(number(n)),
            Token::True => Ok(Value::Bool(true)),
            Token::False => Ok(Value::Bool(false)),
            Token::Null => Ok(Value::Null),
            Token::LBracket => {
                let mut items = Vec::new();
                let mut token = self.lexer.next()?;
                if token == Token::RBracket {
                    return Ok(Value::Array(items));
                }
                loop {
                    items.push(self.value(token)?);
                    match self.lexer.next()? {
                        Token::RBracket => return Ok(Value::Array(items)),
                        Token::Comma => {
                            token = self.lexer.next()?;
                            if token == Token::RBracket {
                                return Err(
                                    "Unexpected comma at the end of array expression".into()
                                );
                            }
                        }
                        _ => return Err("Expected ']'".into()),
                    }
                }
            }
            Token::LBrace => {
                let mut map = Map::new();
                let mut token = self.lexer.next()?;
                if token == Token::RBrace {
                    return Ok(Value::Object(map));
                }
                let mut first = true;
                loop {
                    let Token::Str(key) = token else {
                        return Err(if first {
                            "Expected '}'".into()
                        } else {
                            "Property name must be a string literal".into()
                        });
                    };
                    if self.lexer.next()? != Token::Colon {
                        return Err(
                            "Expected ':' before value in object property definition".into()
                        );
                    }
                    let next = self.lexer.next()?;
                    let value = self.value(next)?;
                    map.insert(key, value);
                    match self.lexer.next()? {
                        Token::RBrace => return Ok(Value::Object(map)),
                        Token::Comma => token = self.lexer.next()?,
                        _ => return Err("Expected '}'".into()),
                    }
                    first = false;
                }
            }
            other => Err(unexpected(&other)),
        }
    }
}

/// Returns the parsed value, or the message after "JSON Parse error: ".
pub fn parse(text: &str) -> Result<Value, String> {
    let mut parser = Parser {
        lexer: Lexer {
            chars: text.chars().collect(),
            pos: 0,
        },
    };
    let mut run = || -> Result<Value, String> {
        let first = parser.lexer.next()?;
        let value = parser.value(first)?;
        match parser.lexer.next()? {
            Token::End => Ok(value),
            _ => Err("Unable to parse JSON string".into()),
        }
    };
    run().map_err(|m| format!("JSON Parse error: {m}"))
}
