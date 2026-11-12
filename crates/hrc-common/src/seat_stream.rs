//! hrc-stream/1 framing, shared by synchronous terminal clients and the daemon.
//! No transport or async runtime: callers own backpressure and JSON semantics.
use std::io::{self, Read, Write};

pub const PROTOCOL: &str = "hrc-stream/1";
pub const HEADER_LEN: usize = 5;
pub const MAX_PAYLOAD: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    Data = 1,
    Control = 2,
    Close = 3,
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

/// Validate before allocating a payload, on either sync or async transports.
pub fn header(bytes: [u8; HEADER_LEN]) -> io::Result<(Kind, usize)> {
    let kind = match bytes[0] {
        1 => Kind::Data,
        2 => Kind::Control,
        3 => Kind::Close,
        _ => return Err(invalid("unknown seat stream frame type")),
    };
    let len = u32::from_be_bytes(bytes[1..].try_into().unwrap()) as usize;
    if len > MAX_PAYLOAD {
        return Err(invalid("seat stream payload exceeds 1 MiB"));
    }
    Ok((kind, len))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Frame {
    kind: Kind,
    payload: Vec<u8>,
}
impl Frame {
    pub fn new(kind: Kind, payload: Vec<u8>) -> io::Result<Self> {
        if payload.len() > MAX_PAYLOAD {
            return Err(invalid("seat stream payload exceeds 1 MiB"));
        }
        Ok(Self { kind, payload })
    }
    pub fn kind(&self) -> Kind {
        self.kind
    }
    pub fn payload(&self) -> &[u8] {
        &self.payload
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(HEADER_LEN + self.payload.len());
        bytes.push(self.kind as u8);
        bytes.extend_from_slice(&(self.payload.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&self.payload);
        bytes
    }
    pub fn write(&self, writer: &mut impl Write) -> io::Result<()> {
        writer.write_all(&self.encode())
    }
    /// EOF between frames is clean; a truncated header or payload is an error.
    pub fn read(reader: &mut impl Read) -> io::Result<Option<Self>> {
        let mut bytes = [0; HEADER_LEN];
        loop {
            match reader.read(&mut bytes[..1]) {
                Ok(0) => return Ok(None),
                Ok(_) => break,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            }
        }
        reader.read_exact(&mut bytes[1..])?;
        let (kind, len) = header(bytes)?;
        let mut payload = vec![0; len];
        reader.read_exact(&mut payload)?;
        Ok(Some(Self { kind, payload }))
    }
}

/// The outcome of one `GET /v1/streams/open` on a unix socket.
pub enum Open {
    /// HTTP 101 and the home's `opened` control frame. Read further frames
    /// from `reader` (it may hold buffered frame bytes); write on `stream`.
    Upgraded {
        reader: io::BufReader<std::os::unix::net::UnixStream>,
        stream: std::os::unix::net::UnixStream,
        opened: serde_json::Value,
    },
    /// Any other HTTP answer; `code` is the JSON error code when there is one.
    Refused {
        status: u16,
        code: Option<String>,
        message: String,
    },
}

/// Open a stream by hand (sync clients have no HTTP library): one request,
/// then the `opened` frame. `timeout` bounds the handshake only.
pub fn open(
    socket: &std::path::Path,
    query: &[(&str, &str)],
    caller: &str,
    timeout: std::time::Duration,
) -> io::Result<Open> {
    use io::BufRead;
    let stream = std::os::unix::net::UnixStream::connect(socket)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    let query = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(query)
        .finish();
    let caller: String = caller.chars().filter(|c| c.is_ascii_graphic()).collect();
    write!(
        &stream,
        "GET /v1/streams/open?{query} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: {PROTOCOL}\r\nx-praesidium-caller: {caller}\r\n\r\n"
    )?;
    let mut reader = io::BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let status: u16 = line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| invalid("malformed HTTP status line"))?;
    let mut length = None;
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            return Err(invalid("truncated HTTP response head"));
        }
        let header = line.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':')
            && name.eq_ignore_ascii_case("content-length")
        {
            length = value.trim().parse::<usize>().ok();
        }
    }
    if status != 101 {
        let mut body = Vec::new();
        match length {
            Some(n) => {
                body.resize(n.min(MAX_PAYLOAD), 0);
                reader.read_exact(&mut body)?;
            }
            None => {
                reader.take(MAX_PAYLOAD as u64).read_to_end(&mut body)?;
            }
        }
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap_or_default();
        let error = &value["error"];
        return Ok(Open::Refused {
            status,
            code: error["code"].as_str().map(str::to_owned),
            message: error["message"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| String::from_utf8_lossy(&body).into_owned()),
        });
    }
    let frame = Frame::read(&mut reader)?.ok_or_else(|| invalid("stream closed before opened"))?;
    let opened: serde_json::Value = serde_json::from_slice(frame.payload())
        .ok()
        .filter(|v: &serde_json::Value| frame.kind == Kind::Control && v["op"] == "opened")
        .ok_or_else(|| invalid("first frame is not opened"))?;
    stream.set_read_timeout(None)?;
    stream.set_write_timeout(None)?;
    Ok(Open::Upgraded {
        reader,
        stream,
        opened,
    })
}
