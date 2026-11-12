use hrc_common::seat_stream::{Frame, HEADER_LEN, Kind, MAX_PAYLOAD};
use std::io::{Cursor, ErrorKind};

#[test]
fn wire_boundaries_and_sync_roundtrip() {
    let frame = Frame::new(Kind::Data, b"hello".to_vec()).unwrap();
    let bytes = frame.encode();
    assert_eq!(&bytes[..HEADER_LEN], &[1, 0, 0, 0, 5]);
    assert_eq!(Frame::read(&mut Cursor::new(bytes)).unwrap(), Some(frame));
    assert!(Frame::read(&mut Cursor::new([])).unwrap().is_none());
    for bytes in [
        vec![1],
        vec![1, 0, 0, 0, 1],
        vec![4, 0, 0, 0, 0],
        vec![1, 0, 16, 0, 1],
    ] {
        assert!(Frame::read(&mut Cursor::new(bytes)).is_err());
    }
    assert!(Frame::new(Kind::Data, vec![0; MAX_PAYLOAD]).is_ok());
    assert_eq!(
        Frame::new(Kind::Data, vec![0; MAX_PAYLOAD + 1])
            .unwrap_err()
            .kind(),
        ErrorKind::InvalidData
    );
    for kind in [Kind::Control, Kind::Close] {
        let frame = Frame::new(kind, b"{}".to_vec()).unwrap();
        assert_eq!(
            Frame::read(&mut Cursor::new(frame.encode())).unwrap(),
            Some(frame)
        );
    }
}
