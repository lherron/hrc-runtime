"""Build the seat-data-model frame: an instanced block diagram of the to-be hrc document."""
from arris_client import Board, edges, deliver
from arris_client.typography import runs, span

BOARD = "/Users/lherron/praesidium/hrc-runtime/diagrams/seat-data.arris-board.json"
NATIVE = "/Users/lherron/praesidium/hrc-runtime/diagrams/seat-data-model.arris.json"

# Transit tokens
PAPER, GROUND, NESTED, DEEP = "#FFFFFF", "#F3F5F8", "#E2E7EE", "#D0D8E3"
GRAPHITE, LEAD, SILVER, RULE, NEUTRAL = "#1A2330", "#4A5565", "#8792A2", "#D8DEE5", "#7D8898"
COBALT, COBALT_L, COBALT_T = "#2449B8", "#5C7BD9", "#EEF2FD"
VIRIDIAN, VIRIDIAN_L, VIRIDIAN_T = "#0B6E5B", "#2E9C84", "#E8F5F1"
PLUM, PLUM_L, PLUM_T = "#6A3C9E", "#9877C9", "#F3EEFA"
VERMILION, VERMILION_L, VERMILION_T = "#B4401A", "#E0754C", "#FCEFE9"

CARD_W, CARD_H = 258.0, 104.0
PAD = 16.0
GAP = 14.0

ids = {}


def uid(stem):
    n = ids.get(stem, 0) + 1
    ids[stem] = n
    return f"{stem}.{n}"


class Fig:
    def __init__(self, batch):
        self.b = batch
        self.order = 0
        self.ports = {}

    def box(self, x, y, w, h, *, fill=PAPER, stroke=NEUTRAL, width=1.2, radius=8.0, dash=None, stem="box"):
        self.order += 1
        kw = dict(width=w, height=h, corner_radius=radius, fill=fill, stroke=stroke, stroke_width=width)
        if dash:
            kw["stroke_dash"] = dash
        return self.b.create("arris.box", object_id=uid(stem), at=(x, y), order=self.order, **kw)

    def caption(self, box_id, *segments, align="left", valign="top", padding=10.0, size=11.0, fill=LEAD, stem="txt"):
        self.order += 1
        bid = box_id if isinstance(box_id, str) else self.b.object_id(box_id)
        return self.b.create(
            "arris.styled_text", object_id=uid(stem), at=(0.0, 0.0), order=self.order,
            bindings={"caption_region": {"source": {"kind": "object", "id": bid}, "port": "caption"}},
            face="sans.regular", size=size, fill=fill, align=align, vertical_align=valign,
            padding=padding, overflow="clip_to_region", line_height=1.3,
            **runs(*segments).to_payload(),
        )

    def text(self, x, y, *segments, size=11.0, fill=LEAD, align="left", max_width=0.0, stem="free"):
        self.order += 1
        return self.b.create(
            "arris.styled_text", object_id=uid(stem), at=(x, y), order=self.order,
            face="sans.regular", size=size, fill=fill, align=align, line_height=1.3,
            max_width=max_width, **runs(*segments).to_payload(),
        )

    # a record card: kicker / name / lines / meta
    def card(self, x, y, *, kicker, name, lines=(), meta=None, hue=(GRAPHITE, NEUTRAL), fill=PAPER, w=CARD_W, h=CARD_H, dash=None):
        ink, line = hue
        box = self.box(x, y, w, h, fill=fill, stroke=line, width=1.4, dash=dash, stem="card")
        segs = [span(kicker, face="cond.semibold", size=9.5, tracking=0.9, fill=ink),
                "\n", span(name, face="sans.semibold", size=13, fill=GRAPHITE)]
        for ln in lines:
            segs += ["\n", span(ln, size=10.5, fill=LEAD)]
        if meta:
            segs += ["\n", span(meta, face="mono.regular", size=9, fill=SILVER)]
        self.caption(box, *segs)
        return box

    # a container with a title band; returns box id
    def container(self, x, y, w, h, *, kicker, name, fill, ink=LEAD, line=None, sub=None, radius=10.0, dash=None):
        box = self.box(x, y, w, h, fill=fill, stroke=line or fill, width=1.0 if line else 0.0, radius=radius, dash=dash, stem="cont")
        segs = [span(kicker, face="cond.semibold", size=9.5, tracking=0.9, fill=ink),
                "  ", span(name, face="sans.semibold", size=12.5, fill=GRAPHITE)]
        if sub:
            segs += ["   ", span(sub, face="mono.regular", size=9.5, fill=SILVER)]
        self.caption(box, *segs, padding=12.0)
        return box

    def port(self, obj, pid, side, frac=0.5):
        # set_attachments replaces the whole record: accumulate every port per node
        key = obj if isinstance(obj, str) else self.b.object_id(obj)
        lst = self.ports.setdefault(key, [])
        lst.append(edges.port(pid, edges.side(side, frac)))
        self.b.set_attachments(obj, edges.attachments(list(lst)))

    def edge(self, a, pa, b, pb, *, stroke=SILVER, width=1.2, dash=None, head=False, waypoints=(), label=None, lfill=LEAD, at=0.5):
        self.order += 1
        kw = dict(shaft=edges.shaft(stroke=stroke, width=width, dash=dash) if dash else edges.shaft(stroke=stroke, width=width))
        if head:
            kw["end"] = edges.terminator("arris.filled", parameters={"length": 9.0, "width": 7.0})
        if waypoints:
            kw["route"] = edges.route(strategy=edges.strategy("arris.polyline"),
                                      waypoints=[edges.page_waypoint(px, py) for px, py in waypoints], corner_radius=6.0)
        if label:
            kw["labels"] = [edges.label("l", "arris.label", clearance=3.0,
                                        placement=edges.route_fraction(at),
                                        parameters={"text": label, "face": "sans.regular", "size": 10, "fill": lfill})]
        return self.b.create_edge(edges.endpoint(a, port_id=pa), edges.endpoint(b, port_id=pb),
                                  edge_id=uid("edge"), order=self.order, **kw)


# ---- layout: sizes ---------------------------------------------------------
TITLE_H = 40.0          # container title band


def gen_size(n_docs, has_runtime):
    n = (1 if has_runtime else 1) + n_docs   # a runtime slot is always drawn (card or "none")
    w = PAD * 2 + n * CARD_W + (n - 1) * GAP
    h = TITLE_H + 30 + CARD_H + PAD            # attention pill row (30) above the cards
    return w, h


def seat_size(gens):
    gw = [gen_size(*g)[0] for g in gens]
    gh = max(gen_size(*g)[1] for g in gens)
    w = PAD * 2 + sum(gw) + GAP * (len(gens) - 1)
    w = max(w, 920)                              # room for a seat-scoped annotation beside the header
    h = TITLE_H + 44 + gh + PAD                 # 44: the seat's own field lines
    return w, h


def project_size(seats):
    sw = [seat_size(s["gens"])[0] for s in seats]
    sh = [seat_size(s["gens"])[1] for s in seats]
    w = PAD * 2 + max(sw)
    h = TITLE_H + sum(sh) + GAP * (len(seats) - 1) + PAD
    return w, h


# ---- data (real seats on max3, 2026-10-31) ---------------------------------
PROJECTS = [
    {"id": "taskboard", "seats": [
        {"ref": "mable@taskboard:primary", "scope": "agent:mable:project:taskboard:task:primary",
         "meta": "title: Taskboard · colour: #2449B8", "gens": [(1, False), (2, True)],
         "gen_rows": [
             {"n": 15, "status": "archived", "attention": None,
              "runtime": None,
              "docs": [("c2 · card", "superseded", "mable@taskboard#15#…T14:02:11Z")]},
             {"n": 16, "status": "active", "attention": "jev · decision · 2026-10-30T15:43:37.837Z",
              "runtime": ("rt-1c9e…", "pi · tmux · idle"),
              "docs": [("c2 · card", "open · 4 actions", "mable@taskboard#16#…T15:43:37.837Z"), ("turn · summary", "future kind", "no HRC change needed")]},
         ]},
    ]},
    {"id": "c2", "seats": [
        {"ref": "vesta@c2:primary", "scope": "agent:vesta:project:c2:task:primary",
         "meta": "title: Vesta · role: primary", "gens": [(2, True)],
         "gen_rows": [
             {"n": 1, "status": "active", "attention": None,
              "runtime": ("rt-7a40…", "pi · tmux · busy"),
              "docs": [("c2 · ask", "open", "vesta@c2#scope-widen"),
                       ("c2 · ask", "resolved", "vesta@c2#remount-fix")]},
         ]},
        {"ref": "mable@c2:primary", "scope": "agent:mable:project:c2:task:primary",
         "meta": "title: c2 strategy", "gens": [(0, True)], "seat_ann": ("wrkq · hcs", "bound", "hcs T-12170 · subject: seat"),
         "gen_rows": [
             {"n": 1, "status": "active", "attention": None,
              "runtime": ("rt-92d8…", "claude · tmux · busy"),
              "docs": []},
         ]},
    ]},
]


def build(fig):
    anchors = {}
    X0, Y0 = 48.0, 150.0
    # header
    fig.text(48, 40, span("The hrc document, instanced: one node per seat, generation, runtime and annotation; containment is the lineage hierarchy",
                          face="sans.semibold", size=24, fill=GRAPHITE), max_width=1500)
    fig.text(48, 78, span("hrc:hrc to-be · real seats on max3, 2026-10-31 · proposal, not approved", size=13, fill=LEAD))
    fig.text(1582, 20, span("TO-BE · DRAFT 2026-10-31", face="mono.regular", size=10, fill=SILVER), align="right", max_width=420)
    fig.box(48, 108, 1752, 1.0, fill=RULE, stroke=RULE, width=0.0, radius=0.0, stem="rule")

    # document region
    pw = [project_size(p["seats"]) for p in PROJECTS]
    doc_w = PAD * 2 + max(w for w, _ in pw)
    doc_h = TITLE_H + sum(h for _, h in pw) + GAP * (len(PROJECTS) - 1) + PAD
    fig.container(X0, Y0, doc_w, doc_h, kicker="DOCUMENT · CARDO", name="hrc:hrc",
                  sub="rebuildable · observation types only · one hierarchy: lineage", fill=GROUND, ink=LEAD)
    y = Y0 + TITLE_H
    for p, (w_p, h_p) in zip(PROJECTS, pw):
        px = X0 + PAD
        fig.container(px, y, w_p, h_p, kicker="HRC.PROJECT", name=p["id"], sub=f"key projectId={p['id']}", fill=NESTED)
        anchors.setdefault("project", fig.order)
        sy = y + TITLE_H
        for s in p["seats"]:
            w_s, h_s = seat_size(s["gens"])
            sx = px + PAD
            seat_box = fig.container(sx, sy, w_s, h_s, kicker="HRC.SEAT", name=s["ref"], sub=f"key sessionRef={s['scope']}/lane:main",
                                     fill=PAPER, ink=COBALT, line=COBALT_L)
            anchors.setdefault("seat", seat_box)
            fig.text(sx + 12, sy + TITLE_H - 2,
                     span("identity  ", face="sans.semibold", size=10.5, fill=LEAD), span(s["scope"].replace("agent:", "").replace(":project:", " · ").replace(":task:", " · "), size=10.5, fill=LEAD),
                     "      ", span("metadata  ", face="sans.semibold", size=10.5, fill=LEAD), span(s["meta"], size=10.5, fill=LEAD),
                     "      ", span("activeGeneration  ", face="sans.semibold", size=10.5, fill=LEAD), span(str(s["gen_rows"][-1]["n"]), size=10.5, fill=LEAD))
            gx = sx + PAD
            gy = sy + TITLE_H + 44
            if s.get("seat_ann"):
                k, st, key = s["seat_ann"]
                sa = fig.card(sx + w_s - PAD - CARD_W, sy + 8, kicker="HRC.ANNOTATION · " + k.upper(), name=st,
                              lines=("continuity-scoped: survives rotation",), meta=key, hue=(PLUM, PLUM_L), fill=PLUM_T, h=78)
                anchors.setdefault("seat_annotation", sa)
                anchors.setdefault("seat_annotation_y", sy + 8 + 39)
            for (n_docs, has_rt), g in zip(s["gens"], s["gen_rows"]):
                w_g, h_g = gen_size(n_docs, has_rt)
                active = g["status"] == "active"
                gen_box = fig.container(gx, gy, w_g, h_g, kicker="HRC.GENERATION", name=f"generation {g['n']} · {g['status']}",
                                        sub=f"key hostSessionId · order {g['n']}", fill=DEEP if active else GROUND,
                                        ink=GRAPHITE if active else SILVER, dash=None if active else [5, 4], line=None if active else NEUTRAL)
                if active:
                    anchors.setdefault("generation", gen_box)
                # attention row
                ay = gy + TITLE_H + 2
                if g["attention"]:
                    pill = fig.box(gx + PAD, ay, 330, 22, fill=VERMILION_T, stroke=VERMILION_L, width=1.0, radius=11.0, stem="pill")
                    anchors.setdefault("pill_y", ay + 11)
                    fig.caption(pill, span("attention  ", face="sans.semibold", size=10, fill=VERMILION), span(g["attention"], size=10, fill=VERMILION),
                                valign="center", padding=4.0)
                    anchors.setdefault("attention", pill)
                else:
                    fig.text(gx + PAD + 6, ay + 4, span("attention  none", size=10, fill=SILVER))
                cx = gx + PAD
                cy = ay + 30
                if g["runtime"]:
                    rid, rdesc = g["runtime"]
                    rt = fig.card(cx, cy, kicker="HRC.RUNTIME", name=rid, lines=(rdesc, "attachable: tmux-attach"),
                                  meta="key runtimeId · contextReading", hue=(VIRIDIAN, VIRIDIAN_L))
                    anchors.setdefault("runtime", rt)
                else:
                    fig.card(cx, cy, kicker="HRC.RUNTIME", name="none", lines=("process ended", "node drops after 24 h"),
                             meta="live_until set", hue=(SILVER, NEUTRAL), fill=GROUND, dash=[4, 3])
                cx += CARD_W + GAP
                for kicker, state, key in g["docs"]:
                    doc = fig.card(cx, cy, kicker="HRC.ANNOTATION · " + kicker.upper(), name=state,
                                   lines=("JSON ≤ 64 KB · put fenced on attention.at",) if state != "future kind" else ("any ns.kind; writer owns the body schema",),
                                   meta=key, hue=(PLUM, PLUM_L) if state != "future kind" else (SILVER, PLUM_L), fill=PLUM_T if state.startswith("open") else PAPER,
                                   dash=[5, 4] if state == "future kind" else None)
                    if state.startswith("open") and "card" in kicker:
                        anchors.setdefault("annotation", doc)
                    cx += CARD_W + GAP
                gx += w_g + GAP
            sy += h_s + GAP
        y += h_p + GAP

    # ---- stores column -----------------------------------------------------
    SX = X0 + doc_w + 120
    SW = 330
    rows = [
        ("continuities", "scope_ref, lane_ref → active session; identity", "mirrors → hrc.seat"),
        ("session_metadata", "continuity scalars: title, colour, hcs ref", "mirrors → hrc.seat.metadata"),
        ("sessions", "host_session_id, generation, status, continuation", "mirrors → hrc.generation"),
        ("runtimes", "runtime_id, transport, status, tmux, presentation", "mirrors → hrc.runtime"),
        ("seat_annotations  (new)", "subject seat|generation · ns, kind, id → JSON · fence", "mirrors → hrc.annotation"),
    ]
    RH = 84
    sh = TITLE_H + len(rows) * (RH + GAP) + PAD
    fig.container(SX, Y0, SW, sh, kicker="DATASTORE · HRC", name="state.sqlite", sub="rows the nodes mirror", fill=GROUND)
    ry = Y0 + TITLE_H
    store_boxes = {}
    for name, desc, target in rows:
        emph = name.startswith("seat_annotations")
        bx = fig.card(SX + PAD, ry, kicker="TABLE", name=name, lines=(desc,), meta=target, hue=(PLUM if emph else GRAPHITE, PLUM_L if emph else NEUTRAL),
                      fill=PLUM_T if emph else PAPER, w=SW - 2 * PAD, h=RH)
        if emph:
            store_boxes["annotation"] = [bx]
            ann_row_y = ry + RH / 2
        ry += RH + GAP
    ly = Y0 + sh + 40
    ledger = fig.card(SX + PAD, ly, kicker="DATASTORE · HRC", name="hrc_events (ledger)",
                      lines=("turn.attention from jev · seat.annotation.action", "time series stays outside doms"),
                      meta="append-only · hrc_seq", hue=(VIRIDIAN, VIRIDIAN_L), w=SW - 2 * PAD, h=92)
    jev = fig.card(SX + PAD, ly + 92 + 40, kicker="DAEMON · HRC-TURN-ATTENTION", name="jev classifier",
                   lines=("appends turn.attention per completed turn",), meta="attention-v3", hue=(GRAPHITE, NEUTRAL), w=SW - 2 * PAD, h=70)

    # ---- edges: mirrors (dotted, no head) and fold (viridian, head) ------------
    fig.port(jev, "t", "top")
    fig.port(ledger, "b", "bottom")
    fig.edge(jev, "t", ledger, "b", stroke=COBALT_L, width=1.4, head=True, label="turn.attention")
    gutter = SX - 60
    pill_y = anchors.get("pill_y", Y0)
    if "seat_annotation" in anchors and "annotation" in store_boxes:
        bx = store_boxes["annotation"][0]
        fig.port(bx, "l", "left")
        fig.port(anchors["seat_annotation"], "r", "right")
        sa_y = anchors["seat_annotation_y"]
        fig.edge(bx, "l", anchors["seat_annotation"], "r", stroke=PLUM_L, width=1.3, dash=[2, 3], label="mirrors", at=0.5,
                 waypoints=[(gutter + 30, ann_row_y), (gutter + 30, sa_y)])
    if "attention" in anchors:
        fig.port(ledger, "l", "left")
        fig.port(anchors["attention"], "r", "right")
        fig.edge(ledger, "l", anchors["attention"], "r", stroke=VIRIDIAN_L, width=1.6, head=True,
                 waypoints=[(gutter, ly + 46), (gutter, pill_y)], label="selected event → attention", at=0.5)

    # ---- key ------------------------------------------------------------------
    ky = Y0 + doc_h + 36
    fig.text(X0, ky, span("KEY", face="cond.semibold", size=9.5, tracking=0.9, fill=LEAD))
    items = [
        (COBALT_L, "hrc.seat", "the continuity · key sessionRef · metadata lives here"),
        (GRAPHITE, "hrc.generation", "one per host session · ordered · attention is its field · live 24 h after its runtime ends"),
        (VIRIDIAN_L, "hrc.runtime", "the process · key runtimeId · attachable"),
        (PLUM_L, "hrc.annotation", "client-owned JSON on a seat or generation · key subject + ns + kind + id · opaque to HRC"),
    ]
    for i, (colour, name, desc) in enumerate(items):
        kx = X0 + 60 + (i % 2) * 760
        kyy = ky + (i // 2) * 24
        fig.box(kx, kyy + 2, 12, 12, fill=colour, stroke=colour, width=0.0, radius=3.0, stem="sw")
        fig.text(kx + 18, kyy - 2, span(name, face="sans.semibold", size=11, fill=GRAPHITE), "  ", span(desc, size=11, fill=LEAD))
    fig.text(X0 + 60, ky + 52, span("nesting", face="sans.semibold", size=11, fill=GRAPHITE), "  ", span("= the lineage hierarchy (project › seat › generation › runtime | annotation; seat › annotation)", size=11, fill=LEAD),
             "      ", span("dotted", face="sans.semibold", size=11, fill=GRAPHITE), "  ", span("= mirrors one store row", size=11, fill=LEAD),
             "      ", span("green", face="sans.semibold", size=11, fill=VIRIDIAN), "  ", span("= folded from the ledger, never stored on the node", size=11, fill=LEAD))
    return doc_w, doc_h, SX + SW + 48, ky + 90


board = Board.attach(BOARD, client="mable")
session, doc = board.frame("seat-data-model")
with session:
    with doc.edit() as b:
        b.set_page_fill("#FFFFFF")
        fig = Fig(b)
        doc_w, doc_h, right, bottom = build(fig)
        b.set_page(right, bottom)
    print("page", right, bottom)
    receipt = deliver(doc, NATIVE, keep_previous="drafts")
    print("delivered", receipt.get("findings_count", ""), receipt.get("previews", ""))
