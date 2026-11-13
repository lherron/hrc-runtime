//! Hand-written bindings for the dozen libghostty-vt calls hrc-pty makes
//! (`include/ghostty/vt.h` at the pinned commit), and a safe owner around
//! one headless terminal. Struct layouts are checked against the library's
//! own ABI manifest (`ghostty_type_json`) by `abi_layout_matches_manifest`.
use std::ffi::{c_int, c_void};
use std::ptr;

type Terminal = *mut c_void;
type Formatter = *mut c_void;

const SUCCESS: c_int = 0;

const OPT_KITTY_IMAGE_STORAGE_LIMIT: c_int = 16;
const OPT_SCROLLBACK_MAX_LINES: c_int = 29;
const OPT_CONTINUATION_MAX_BYTES: c_int = 32;

const DATA_COLS: c_int = 1;
const DATA_ROWS: c_int = 2;
const DATA_CURSOR_X: c_int = 3;
const DATA_CURSOR_Y: c_int = 4;
const DATA_ACTIVE_SCREEN: c_int = 6;
const DATA_CURSOR_VISIBLE: c_int = 7;
const DATA_KITTY_KEYBOARD_FLAGS: c_int = 8;
const DATA_TOTAL_ROWS: c_int = 14;
const DATA_KITTY_GRAPHICS: c_int = 30;

const KG_DATA_PLACEMENT_ITERATOR: c_int = 1;
const KP_IMAGE_ID: c_int = 1;
const KP_PLACEMENT_ID: c_int = 2;
const KP_IS_VIRTUAL: c_int = 3;
const KP_X_OFFSET: c_int = 4;
const KP_Y_OFFSET: c_int = 5;
const KP_SOURCE_X: c_int = 6;
const KP_SOURCE_Y: c_int = 7;
const KP_SOURCE_WIDTH: c_int = 8;
const KP_SOURCE_HEIGHT: c_int = 9;
const KP_COLUMNS: c_int = 10;
const KP_ROWS: c_int = 11;
const KP_Z: c_int = 12;
const KI_WIDTH: c_int = 3;
const KI_HEIGHT: c_int = 4;
const KI_FORMAT: c_int = 5;
const KI_PIXELS: c_int = 7;
const KFORMAT_RGB: c_int = 0;
const KFORMAT_RGBA: c_int = 1;
const KFORMAT_GRAY_ALPHA: c_int = 3;
const KFORMAT_GRAY: c_int = 4;

const SYS_OPT_DECODE_PNG: c_int = 2;

const FORMAT_PLAIN: c_int = 0;
const FORMAT_VT: c_int = 1;

const FMT_OPT_EMIT: c_int = 1;
const FMT_OPT_TRIM: c_int = 3;
const FMT_OPT_SELECTION: c_int = 4;
const FMT_OPT_EXTRAS: c_int = 5;

type FormatterExtras = u32;
const EXTRA_MODES: FormatterExtras = 1 << 1;
const EXTRA_SCROLLING_REGION: FormatterExtras = 1 << 2;
const EXTRA_TABSTOPS: FormatterExtras = 1 << 3;
const EXTRA_KEYBOARD: FormatterExtras = 1 << 5;
const EXTRA_CURSOR: FormatterExtras = 1 << 6;
const EXTRA_STYLE: FormatterExtras = 1 << 7;
const EXTRA_HYPERLINK: FormatterExtras = 1 << 8;
const EXTRA_PROTECTION: FormatterExtras = 1 << 9;
const EXTRA_KITTY_KEYBOARD: FormatterExtras = 1 << 10;
const EXTRA_CHARSETS: FormatterExtras = 1 << 11;

const SCREEN_ALTERNATE: c_int = 1;

const POINT_ACTIVE: c_int = 0;
const POINT_SCREEN: c_int = 2;

#[repr(C)]
pub(crate) struct GhosttyWriter {
    write: Option<unsafe extern "C" fn(*mut c_void, *const u8, usize) -> bool>,
    userdata: *mut c_void,
}

#[repr(C)]
struct GhosttyString {
    ptr: *const u8,
    len: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub(crate) struct GhosttyGridRef {
    node: *mut c_void,
    x: u16,
    y: u16,
}

#[repr(C)]
pub(crate) struct GhosttySelection {
    start: GhosttyGridRef,
    end: GhosttyGridRef,
    rectangle: bool,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct GhosttyPointCoordinate {
    x: u16,
    y: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
union GhosttyPointValue {
    coordinate: GhosttyPointCoordinate,
    _padding: [u64; 2],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub(crate) struct GhosttyPoint {
    tag: c_int,
    value: GhosttyPointValue,
}

unsafe extern "C" {
    fn ghostty_terminal_new(
        alloc: *const c_void,
        out: *mut Terminal,
        cols: u16,
        rows: u16,
    ) -> c_int;
    fn ghostty_terminal_free(t: Terminal);
    fn ghostty_terminal_resize(
        t: Terminal,
        cols: u16,
        rows: u16,
        cell_w: u32,
        cell_h: u32,
    ) -> c_int;
    fn ghostty_terminal_set(t: Terminal, option: c_int, value: *const c_void) -> c_int;
    fn ghostty_terminal_vt_write(t: Terminal, data: *const u8, len: usize);
    fn ghostty_terminal_continuation_write(t: Terminal, writer: GhosttyWriter) -> c_int;
    fn ghostty_terminal_get(t: Terminal, data: c_int, out: *mut c_void) -> c_int;
    fn ghostty_terminal_grid_ref(
        t: Terminal,
        point: GhosttyPoint,
        out: *mut GhosttyGridRef,
    ) -> c_int;
    fn ghostty_formatter_terminal_new(
        alloc: *const c_void,
        out: *mut Formatter,
        t: Terminal,
    ) -> c_int;
    fn ghostty_formatter_set(f: Formatter, option: c_int, value: *const c_void) -> c_int;
    fn ghostty_formatter_format(f: Formatter, writer: GhosttyWriter) -> c_int;
    fn ghostty_formatter_free(f: Formatter);
    #[cfg(test)]
    fn ghostty_type_json() -> *const std::ffi::c_char;
    fn ghostty_kitty_graphics_get(g: *mut c_void, data: c_int, out: *mut c_void) -> c_int;
    fn ghostty_kitty_graphics_image(g: *mut c_void, image_id: u32) -> *mut c_void;
    fn ghostty_kitty_graphics_image_get(image: *mut c_void, data: c_int, out: *mut c_void)
    -> c_int;
    fn ghostty_kitty_graphics_placement_iterator_new(
        alloc: *const c_void,
        out: *mut *mut c_void,
    ) -> c_int;
    fn ghostty_kitty_graphics_placement_iterator_free(it: *mut c_void);
    fn ghostty_kitty_graphics_placement_next(it: *mut c_void) -> bool;
    fn ghostty_kitty_graphics_placement_get(
        it: *mut c_void,
        data: c_int,
        out: *mut c_void,
    ) -> c_int;
    fn ghostty_kitty_graphics_placement_viewport_pos(
        it: *mut c_void,
        image: *mut c_void,
        t: Terminal,
        col: *mut i32,
        row: *mut i32,
    ) -> c_int;
    fn ghostty_sys_set(option: c_int, value: *const c_void) -> c_int;
    fn ghostty_alloc(alloc: *const c_void, len: usize) -> *mut u8;
}

#[repr(C)]
struct GhosttySysImage {
    width: u32,
    height: u32,
    data: *mut u8,
    data_len: usize,
}

unsafe extern "C" fn decode_png(
    _userdata: *mut c_void,
    alloc: *const c_void,
    data: *const u8,
    len: usize,
    out: *mut GhosttySysImage,
) -> bool {
    // SAFETY: libghostty passes a valid input slice and out-pointer.
    let input = unsafe { std::slice::from_raw_parts(data, len) };
    let Ok(rgba) = png_to_rgba(input) else {
        return false;
    };
    let (w, h, pixels) = rgba;
    // SAFETY: the buffer is allocated with the allocator libghostty hands us,
    // which is how it frees it.
    unsafe {
        let buf = ghostty_alloc(alloc, pixels.len());
        if buf.is_null() {
            return false;
        }
        ptr::copy_nonoverlapping(pixels.as_ptr(), buf, pixels.len());
        *out = GhosttySysImage {
            width: w,
            height: h,
            data: buf,
            data_len: pixels.len(),
        };
    }
    true
}

fn png_to_rgba(input: &[u8]) -> anyhow::Result<(u32, u32, Vec<u8>)> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(input));
    decoder.set_transformations(
        png::Transformations::normalize_to_color8() | png::Transformations::ALPHA,
    );
    let mut reader = decoder.read_info()?;
    let mut buf = vec![0; reader.output_buffer_size().unwrap_or(0)];
    let info = reader.next_frame(&mut buf)?;
    buf.truncate(info.buffer_size());
    let pixels = match info.color_type {
        png::ColorType::Rgba => buf,
        png::ColorType::GrayscaleAlpha => buf
            .chunks(2)
            .flat_map(|p| [p[0], p[0], p[0], p[1]])
            .collect(),
        other => anyhow::bail!("unexpected PNG color type {other:?}"),
    };
    Ok((info.width, info.height, pixels))
}

/// Install the PNG decoder libghostty-vt uses for Kitty `f=100` images.
/// Process-global; call once before the first terminal exists.
pub(crate) fn install_png_decoder() {
    let f: unsafe extern "C" fn(
        *mut c_void,
        *const c_void,
        *const u8,
        usize,
        *mut GhosttySysImage,
    ) -> bool = decode_png;
    // SAFETY: the option takes the function pointer itself as the value.
    unsafe { ghostty_sys_set(SYS_OPT_DECODE_PNG, f as *const c_void) };
}

unsafe extern "C" fn append_to_vec(userdata: *mut c_void, data: *const u8, len: usize) -> bool {
    // SAFETY: userdata is the &mut Vec<u8> passed by `vec_writer` for the
    // duration of one synchronous call; data/len is libghostty's slice.
    unsafe {
        let out = &mut *(userdata as *mut Vec<u8>);
        out.extend_from_slice(std::slice::from_raw_parts(data, len));
    }
    true
}

fn vec_writer(out: &mut Vec<u8>) -> GhosttyWriter {
    GhosttyWriter {
        write: Some(append_to_vec),
        userdata: out as *mut Vec<u8> as *mut c_void,
    }
}

/// The screen a capture or replay reflects.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ScreenKind {
    Primary,
    Alternate,
}

impl ScreenKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            ScreenKind::Primary => "primary",
            ScreenKind::Alternate => "alternate",
        }
    }
}

/// One headless libghostty-vt terminal. Not thread-safe; the server keeps it
/// behind its state mutex.
pub(crate) struct Vt {
    t: Terminal,
}

// SAFETY: the handle is only touched under the server's state mutex.
unsafe impl Send for Vt {}

impl Vt {
    pub(crate) fn new(cols: u16, rows: u16) -> anyhow::Result<Self> {
        let mut t: Terminal = ptr::null_mut();
        // SAFETY: out-pointer to a local; a null allocator selects the default.
        let rc = unsafe { ghostty_terminal_new(ptr::null(), &mut t, cols.max(1), rows.max(1)) };
        anyhow::ensure!(
            rc == SUCCESS && !t.is_null(),
            "ghostty_terminal_new failed: {rc}"
        );
        let vt = Vt { t };
        // Continuation tracking makes the replay safe mid-sequence (§4.3 step 2).
        vt.set_usize(OPT_CONTINUATION_MAX_BYTES, 64 * 1024)?;
        vt.set_usize(OPT_SCROLLBACK_MAX_LINES, 10_000)?;
        Ok(vt)
    }

    /// Turn on Kitty graphics with a per-seat image storage limit (§4.3).
    pub(crate) fn enable_kitty_graphics(&self, limit: u64) -> anyhow::Result<()> {
        // SAFETY: option takes a uint64_t* read during the call.
        let rc = unsafe {
            ghostty_terminal_set(
                self.t,
                OPT_KITTY_IMAGE_STORAGE_LIMIT,
                &limit as *const u64 as *const c_void,
            )
        };
        anyhow::ensure!(rc == SUCCESS, "kitty image storage limit: {rc}");
        Ok(())
    }

    fn set_usize(&self, option: c_int, value: usize) -> anyhow::Result<()> {
        // SAFETY: option takes a size_t* read during the call.
        let rc = unsafe {
            ghostty_terminal_set(self.t, option, &value as *const usize as *const c_void)
        };
        anyhow::ensure!(rc == SUCCESS, "ghostty_terminal_set({option}) failed: {rc}");
        Ok(())
    }

    pub(crate) fn write(&mut self, bytes: &[u8]) {
        // SAFETY: valid slice; the terminal never retains it.
        unsafe { ghostty_terminal_vt_write(self.t, bytes.as_ptr(), bytes.len()) }
    }

    pub(crate) fn resize(&mut self, cols: u16, rows: u16, cell_w: u32, cell_h: u32) {
        // SAFETY: plain values.
        unsafe { ghostty_terminal_resize(self.t, cols.max(1), rows.max(1), cell_w, cell_h) };
    }

    fn get<T: Default>(&self, data: c_int) -> T {
        let mut out = T::default();
        // SAFETY: each call site pairs `data` with its documented output type.
        unsafe { ghostty_terminal_get(self.t, data, &mut out as *mut T as *mut c_void) };
        out
    }

    pub(crate) fn size(&self) -> (u16, u16) {
        (self.get::<u16>(DATA_COLS), self.get::<u16>(DATA_ROWS))
    }

    pub(crate) fn cursor(&self) -> (u16, u16) {
        (
            self.get::<u16>(DATA_CURSOR_X),
            self.get::<u16>(DATA_CURSOR_Y),
        )
    }

    pub(crate) fn cursor_visible(&self) -> bool {
        self.get::<bool>(DATA_CURSOR_VISIBLE)
    }

    pub(crate) fn screen(&self) -> ScreenKind {
        if self.get::<c_int>(DATA_ACTIVE_SCREEN) == SCREEN_ALTERNATE {
            ScreenKind::Alternate
        } else {
            ScreenKind::Primary
        }
    }

    pub(crate) fn kitty_keyboard_flags(&self) -> u8 {
        self.get::<u8>(DATA_KITTY_KEYBOARD_FLAGS)
    }

    fn grid_ref(&self, tag: c_int, x: u16, y: u32) -> Option<GhosttyGridRef> {
        let point = GhosttyPoint {
            tag,
            value: GhosttyPointValue {
                coordinate: GhosttyPointCoordinate { x, y },
            },
        };
        let mut out = GhosttyGridRef {
            node: ptr::null_mut(),
            x: 0,
            y: 0,
        };
        // SAFETY: out-pointer to a sized local.
        let rc = unsafe { ghostty_terminal_grid_ref(self.t, point, &mut out) };
        (rc == SUCCESS).then_some(out)
    }

    /// Format the active screen as `emit` with trailing-whitespace `trim`,
    /// the VT `extras`, and a selection (`None` formats the whole screen).
    fn format(
        &self,
        emit: c_int,
        trim: bool,
        extras: FormatterExtras,
        selection: Option<&GhosttySelection>,
    ) -> anyhow::Result<Vec<u8>> {
        let mut f: Formatter = ptr::null_mut();
        // SAFETY: out-pointer to a local; a null allocator selects the default.
        let rc = unsafe { ghostty_formatter_terminal_new(ptr::null(), &mut f, self.t) };
        anyhow::ensure!(
            rc == SUCCESS && !f.is_null(),
            "ghostty_formatter_terminal_new failed: {rc}"
        );
        let set = |option: c_int, value: *const c_void| {
            // SAFETY: each value points at the option's documented type; the
            // formatter copies it during the call.
            let rc = unsafe { ghostty_formatter_set(f, option, value) };
            anyhow::ensure!(
                rc == SUCCESS,
                "ghostty_formatter_set({option}) failed: {rc}"
            );
            Ok(())
        };
        let result = (|| {
            set(FMT_OPT_EMIT, &emit as *const c_int as *const c_void)?;
            set(FMT_OPT_TRIM, &trim as *const bool as *const c_void)?;
            set(
                FMT_OPT_EXTRAS,
                &extras as *const FormatterExtras as *const c_void,
            )?;
            if let Some(sel) = selection {
                set(
                    FMT_OPT_SELECTION,
                    sel as *const GhosttySelection as *const c_void,
                )?;
            }
            let mut out = Vec::new();
            // SAFETY: the writer's userdata is `out`, alive across the call.
            let rc = unsafe { ghostty_formatter_format(f, vec_writer(&mut out)) };
            anyhow::ensure!(rc == SUCCESS, "ghostty_formatter_format failed: {rc}");
            Ok(out)
        })();
        // SAFETY: f came from ghostty_formatter_terminal_new.
        unsafe { ghostty_formatter_free(f) };
        result
    }

    /// Plain text of the viewport plus the last `scrollback` rows above it,
    /// one line per row (trailing whitespace trimmed).
    pub(crate) fn capture_plain(&self, scrollback: usize) -> anyhow::Result<String> {
        let (cols, rows) = self.size();
        let total = self.get::<usize>(DATA_TOTAL_ROWS);
        let top = total.saturating_sub(rows as usize + scrollback);
        let start = self.grid_ref(POINT_SCREEN, 0, top as u32);
        let end = self.grid_ref(
            POINT_ACTIVE,
            cols.saturating_sub(1),
            u32::from(rows.saturating_sub(1)),
        );
        let (Some(start), Some(end)) = (start, end) else {
            anyhow::bail!("capture: grid refs out of range");
        };
        let selection = GhosttySelection {
            start,
            end,
            rectangle: false,
        };
        let bytes = self.format(FORMAT_PLAIN, true, 0, Some(&selection))?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    /// The active screen as VT: modes, keyboard state, scrolling region,
    /// tabstops, then content and pen, and the cursor when `cursor` is set
    /// (`styled` capture; the replay places the cursor itself, after images).
    pub(crate) fn format_vt(&self, cursor: bool) -> anyhow::Result<Vec<u8>> {
        let mut extras = EXTRA_MODES
            | EXTRA_SCROLLING_REGION
            | EXTRA_TABSTOPS
            | EXTRA_KEYBOARD
            | EXTRA_STYLE
            | EXTRA_HYPERLINK
            | EXTRA_PROTECTION
            | EXTRA_KITTY_KEYBOARD
            | EXTRA_CHARSETS;
        if cursor {
            extras |= EXTRA_CURSOR;
        }
        self.format(FORMAT_VT, false, extras, None)
    }

    /// Bytes that complete a sequence the child left half-written, so the
    /// client parser resumes exactly where the model is.
    pub(crate) fn continuation(&self) -> Vec<u8> {
        let mut out = Vec::new();
        // SAFETY: the writer's userdata is `out`, alive across the call.
        let rc = unsafe { ghostty_terminal_continuation_write(self.t, vec_writer(&mut out)) };
        if rc != SUCCESS {
            out.clear();
        }
        out
    }
}

/// One placement the active screen's Kitty storage holds, with its image.
pub(crate) struct KittyPlacement {
    pub(crate) image_id: u32,
    pub(crate) placement_id: u32,
    pub(crate) is_virtual: bool,
    pub(crate) col: i32,
    pub(crate) row: i32,
    pub(crate) x_offset: u32,
    pub(crate) y_offset: u32,
    pub(crate) source: [u32; 4],
    pub(crate) columns: u32,
    pub(crate) rows: u32,
    pub(crate) z: i32,
}

/// A stored image's pixels as RGBA (f=32) or RGB (f=24).
pub(crate) struct KittyImage {
    pub(crate) id: u32,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) format: u32,
    pub(crate) pixels: Vec<u8>,
}

impl Vt {
    /// Every placement in the active screen's image storage and the pixels of
    /// each image those placements show. Off-screen and virtual placements are
    /// included; the caller decides what it can re-emit.
    pub(crate) fn kitty_snapshot(&self) -> (Vec<KittyPlacement>, Vec<KittyImage>) {
        let mut placements = Vec::new();
        let mut images: Vec<KittyImage> = Vec::new();
        let mut graphics: *mut c_void = ptr::null_mut();
        // SAFETY: output type GhosttyKittyGraphics (a pointer).
        let rc = unsafe {
            ghostty_terminal_get(
                self.t,
                DATA_KITTY_GRAPHICS,
                &mut graphics as *mut *mut c_void as *mut c_void,
            )
        };
        if rc != SUCCESS || graphics.is_null() {
            return (placements, images);
        }
        let mut it: *mut c_void = ptr::null_mut();
        // SAFETY: out-pointer to a local; freed below.
        if unsafe { ghostty_kitty_graphics_placement_iterator_new(ptr::null(), &mut it) } != SUCCESS
        {
            return (placements, images);
        }
        // SAFETY: the iterator is filled from a storage handle borrowed under
        // the state mutex; nothing mutates the terminal until we return.
        unsafe {
            ghostty_kitty_graphics_get(
                graphics,
                KG_DATA_PLACEMENT_ITERATOR,
                &mut it as *mut *mut c_void as *mut c_void,
            );
            while ghostty_kitty_graphics_placement_next(it) {
                let u32_of = |data: c_int| {
                    let mut v = 0u32;
                    ghostty_kitty_graphics_placement_get(
                        it,
                        data,
                        &mut v as *mut u32 as *mut c_void,
                    );
                    v
                };
                let image_id = u32_of(KP_IMAGE_ID);
                let mut is_virtual = false;
                ghostty_kitty_graphics_placement_get(
                    it,
                    KP_IS_VIRTUAL,
                    &mut is_virtual as *mut bool as *mut c_void,
                );
                let mut z = 0i32;
                ghostty_kitty_graphics_placement_get(it, KP_Z, &mut z as *mut i32 as *mut c_void);
                let image = ghostty_kitty_graphics_image(graphics, image_id);
                if image.is_null() {
                    continue;
                }
                let (mut col, mut row) = (i32::MIN, i32::MIN);
                if !is_virtual {
                    ghostty_kitty_graphics_placement_viewport_pos(
                        it, image, self.t, &mut col, &mut row,
                    );
                }
                placements.push(KittyPlacement {
                    image_id,
                    placement_id: u32_of(KP_PLACEMENT_ID),
                    is_virtual,
                    col,
                    row,
                    x_offset: u32_of(KP_X_OFFSET),
                    y_offset: u32_of(KP_Y_OFFSET),
                    source: [
                        u32_of(KP_SOURCE_X),
                        u32_of(KP_SOURCE_Y),
                        u32_of(KP_SOURCE_WIDTH),
                        u32_of(KP_SOURCE_HEIGHT),
                    ],
                    columns: u32_of(KP_COLUMNS),
                    rows: u32_of(KP_ROWS),
                    z,
                });
                if images.iter().any(|i| i.id == image_id) {
                    continue;
                }
                let img_u32 = |data: c_int| {
                    let mut v = 0u32;
                    ghostty_kitty_graphics_image_get(
                        image,
                        data,
                        &mut v as *mut u32 as *mut c_void,
                    );
                    v
                };
                let mut format: c_int = 0;
                ghostty_kitty_graphics_image_get(
                    image,
                    KI_FORMAT,
                    &mut format as *mut c_int as *mut c_void,
                );
                // No value until the pixels arrive (a load still in flight).
                let mut px = GhosttyString {
                    ptr: ptr::null(),
                    len: 0,
                };
                if ghostty_kitty_graphics_image_get(
                    image,
                    KI_PIXELS,
                    &mut px as *mut GhosttyString as *mut c_void,
                ) != SUCCESS
                    || px.ptr.is_null()
                {
                    continue;
                }
                let raw = std::slice::from_raw_parts(px.ptr, px.len);
                let (format, pixels) = match format {
                    KFORMAT_RGBA => (32, raw.to_vec()),
                    KFORMAT_RGB => (24, raw.to_vec()),
                    KFORMAT_GRAY_ALPHA => (
                        32,
                        raw.chunks(2)
                            .flat_map(|p| [p[0], p[0], p[0], p[1]])
                            .collect(),
                    ),
                    KFORMAT_GRAY => (24, raw.iter().flat_map(|&g| [g, g, g]).collect()),
                    _ => continue,
                };
                images.push(KittyImage {
                    id: image_id,
                    width: img_u32(KI_WIDTH),
                    height: img_u32(KI_HEIGHT),
                    format,
                    pixels,
                });
            }
            ghostty_kitty_graphics_placement_iterator_free(it);
        }
        (placements, images)
    }
}

impl Drop for Vt {
    fn drop(&mut self) {
        // SAFETY: t came from ghostty_terminal_new and is freed once.
        unsafe { ghostty_terminal_free(self.t) }
    }
}

/// libghostty-vt's ABI manifest (JSON), for the layout check.
#[cfg(test)]
pub(crate) fn type_json() -> String {
    // SAFETY: a static NUL-terminated string owned by the library.
    unsafe { std::ffi::CStr::from_ptr(ghostty_type_json()) }
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abi_layout_matches_manifest() {
        let manifest: serde_json::Value = serde_json::from_str(&type_json()).unwrap();
        let types = &manifest["types"];
        for (name, size) in [
            ("GhosttyString", size_of::<GhosttyString>()),
            ("GhosttySysImage", size_of::<GhosttySysImage>()),
            ("GhosttyGridRef", size_of::<GhosttyGridRef>()),
            ("GhosttySelection", size_of::<GhosttySelection>()),
            ("GhosttyPoint", size_of::<GhosttyPoint>()),
            ("GhosttyWriter", size_of::<GhosttyWriter>()),
        ] {
            assert_eq!(
                types[name]["size"].as_u64(),
                Some(size as u64),
                "{name}: {}",
                types[name]
            );
        }
    }

    /// The enum values hard-coded above are positional in libghostty-vt and
    /// renumber between releases (1.0 shifted every terminal option by one);
    /// check each against the manifest by name.
    #[test]
    fn abi_enum_values_match_manifest() {
        let manifest: serde_json::Value = serde_json::from_str(&type_json()).unwrap();
        let types = &manifest["types"];
        for (ty, key, value) in [
            ("GhosttyResult", "SUCCESS", SUCCESS),
            (
                "GhosttyTerminalOption",
                "KITTY_IMAGE_STORAGE_LIMIT",
                OPT_KITTY_IMAGE_STORAGE_LIMIT,
            ),
            (
                "GhosttyTerminalOption",
                "SCROLLBACK_MAX_LINES",
                OPT_SCROLLBACK_MAX_LINES,
            ),
            (
                "GhosttyTerminalOption",
                "CONTINUATION_MAX_BYTES",
                OPT_CONTINUATION_MAX_BYTES,
            ),
            ("GhosttyTerminalData", "COLS", DATA_COLS),
            ("GhosttyTerminalData", "ROWS", DATA_ROWS),
            ("GhosttyTerminalData", "CURSOR_X", DATA_CURSOR_X),
            ("GhosttyTerminalData", "CURSOR_Y", DATA_CURSOR_Y),
            ("GhosttyTerminalData", "ACTIVE_SCREEN", DATA_ACTIVE_SCREEN),
            ("GhosttyTerminalData", "CURSOR_VISIBLE", DATA_CURSOR_VISIBLE),
            (
                "GhosttyTerminalData",
                "KITTY_KEYBOARD_FLAGS",
                DATA_KITTY_KEYBOARD_FLAGS,
            ),
            ("GhosttyTerminalData", "TOTAL_ROWS", DATA_TOTAL_ROWS),
            ("GhosttyTerminalData", "KITTY_GRAPHICS", DATA_KITTY_GRAPHICS),
            ("GhosttyTerminalScreen", "ALTERNATE", SCREEN_ALTERNATE),
            (
                "GhosttyKittyGraphicsData",
                "PLACEMENT_ITERATOR",
                KG_DATA_PLACEMENT_ITERATOR,
            ),
            ("GhosttyKittyGraphicsPlacementData", "IMAGE_ID", KP_IMAGE_ID),
            (
                "GhosttyKittyGraphicsPlacementData",
                "PLACEMENT_ID",
                KP_PLACEMENT_ID,
            ),
            (
                "GhosttyKittyGraphicsPlacementData",
                "IS_VIRTUAL",
                KP_IS_VIRTUAL,
            ),
            ("GhosttyKittyGraphicsPlacementData", "X_OFFSET", KP_X_OFFSET),
            ("GhosttyKittyGraphicsPlacementData", "Y_OFFSET", KP_Y_OFFSET),
            ("GhosttyKittyGraphicsPlacementData", "SOURCE_X", KP_SOURCE_X),
            ("GhosttyKittyGraphicsPlacementData", "SOURCE_Y", KP_SOURCE_Y),
            (
                "GhosttyKittyGraphicsPlacementData",
                "SOURCE_WIDTH",
                KP_SOURCE_WIDTH,
            ),
            (
                "GhosttyKittyGraphicsPlacementData",
                "SOURCE_HEIGHT",
                KP_SOURCE_HEIGHT,
            ),
            ("GhosttyKittyGraphicsPlacementData", "COLUMNS", KP_COLUMNS),
            ("GhosttyKittyGraphicsPlacementData", "ROWS", KP_ROWS),
            ("GhosttyKittyGraphicsPlacementData", "Z", KP_Z),
            ("GhosttyKittyGraphicsImageData", "WIDTH", KI_WIDTH),
            ("GhosttyKittyGraphicsImageData", "HEIGHT", KI_HEIGHT),
            ("GhosttyKittyGraphicsImageData", "FORMAT", KI_FORMAT),
            ("GhosttyKittyGraphicsImageData", "PIXELS", KI_PIXELS),
            ("GhosttyKittyImageFormat", "RGB", KFORMAT_RGB),
            ("GhosttyKittyImageFormat", "RGBA", KFORMAT_RGBA),
            ("GhosttyKittyImageFormat", "GRAY_ALPHA", KFORMAT_GRAY_ALPHA),
            ("GhosttyKittyImageFormat", "GRAY", KFORMAT_GRAY),
            ("GhosttySysOption", "DECODE_PNG", SYS_OPT_DECODE_PNG),
            ("GhosttyFormatterFormat", "PLAIN", FORMAT_PLAIN),
            ("GhosttyFormatterFormat", "VT", FORMAT_VT),
            ("GhosttyFormatterOption", "EMIT", FMT_OPT_EMIT),
            ("GhosttyFormatterOption", "TRIM", FMT_OPT_TRIM),
            ("GhosttyFormatterOption", "SELECTION", FMT_OPT_SELECTION),
            ("GhosttyFormatterOption", "EXTRAS", FMT_OPT_EXTRAS),
            ("GhosttyPointTag", "ACTIVE", POINT_ACTIVE),
            ("GhosttyPointTag", "SCREEN", POINT_SCREEN),
        ] {
            assert_eq!(
                types[ty]["values"][key].as_i64(),
                Some(i64::from(value)),
                "{ty}.{key}"
            );
        }
    }
}
