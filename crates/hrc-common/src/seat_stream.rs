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
