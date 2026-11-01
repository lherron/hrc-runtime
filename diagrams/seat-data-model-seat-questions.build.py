"""Build (or rebuild) the seat-data-model-seat-questions frame: seat-data-model (2026-10-31) carried to the
T-12239 design agreed 2026-11-01. A seat's open questions are one seat-scoped c2 · asks record with rows;
no c2 annotation is generation-scoped; the generation keeps attention, the runtime and any future kind."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _fig
from arris_client import Board, deliver, edges
from arris_client.typography import span
from _fig import (CARD_H, CARD_W, COBALT, COBALT_L, DEEP, GAP, GRAPHITE, GROUND, LEAD, NESTED, NEUTRAL, PAD, PAPER, PLUM, PLUM_L,
                  PLUM_T, RULE, SILVER, VERMILION, VERMILION_L, VERMILION_T, VIRIDIAN, VIRIDIAN_L, Fig)

BOARD = "/Users/lherron/praesidium/hrc-runtime/diagrams/seat-data.arris-board.json"
NATIVE = "/Users/lherron/praesidium/hrc-runtime/diagrams/seat-data-model-seat-questions.arris.json"
FRAME = "seat-data-model-seat-questions"
ID_PREFIX = os.environ.get("ID_PREFIX", "v1")
TITLE_H = 40.0


def rec_h(rows):
    return 60.0 + 15.0 * len(rows) + 20.0


def gen_size(n_docs):
    n = 1 + n_docs                               # the runtime slot is always drawn (card or "none")
    w = PAD * 2 + n * CARD_W + (n - 1) * GAP
    h = TITLE_H + 30 + CARD_H + PAD              # attention pill row (30) above the cards
    return w, h


def seat_size(s):
    gens = s["gen_rows"]
    gw = [gen_size(len(g["docs"]))[0] for g in gens]
    gh = max(gen_size(len(g["docs"]))[1] for g in gens)
    w = max(PAD * 2 + sum(gw) + GAP * (len(gens) - 1), 980)
    h = TITLE_H + 44 + rec_h(s["rows"]) + GAP + gh + PAD
    return w, h


def project_size(seats):
    sizes = [seat_size(s) for s in seats]
    return PAD * 2 + max(w for w, _ in sizes), TITLE_H + sum(h for _, h in sizes) + GAP * (len(seats) - 1) + PAD


# ---- data: the 10-31 frame's seats, carried to the new design -------------------------------
PROJECTS = [
    {"id": "taskboard", "seats": [
        {"ref": "mable@taskboard:primary", "scope": "agent:mable:project:taskboard:task:primary",
         "meta": "title: Taskboard · colour: #2449B8",
         "rows": [("draft", "File the cody draft?", "File (recommended) · Stop", "task T-11958", "agree (vesta)", "—")],
         "aside": "c2 · receipt · <requestId> (the last delivery's claim; target generation 16 in the body)",
         "gen_rows": [
             {"n": 15, "status": "archived", "attention": None, "runtime": None, "docs": []},
             {"n": 16, "status": "active", "attention": "jev · decision · 2026-10-30T15:43:37.837Z",
              "runtime": ("rt-1c9e…", "pi · tmux · idle"),
              "docs": [("turn · summary", "future kind", "any ns.kind; writer owns the body schema", "a generation-scoped kind HRC still allows")]},
         ]},
    ]},
    {"id": "c2", "seats": [
        {"ref": "vesta@c2:primary", "scope": "agent:vesta:project:c2:task:primary",
         "meta": "title: Vesta · role: primary",
         "rows": [("scope-widen", "Widen c2 scope to task seats?", "Keep (recommended) · Widen", "task —", "—", "—")],
         "aside": "her resolved ask (remount-fix) is gone: a row leaves when answered · Vesta is a seat like any other",
         "gen_rows": [
             {"n": 1, "status": "active", "attention": None, "runtime": ("rt-7a40…", "pi · tmux · busy"), "docs": []},
         ]},
        {"ref": "mable@c2:primary", "scope": "agent:mable:project:c2:task:primary",
         "meta": "title: c2 strategy", "seat_ann": ("wrkq · hcs", "bound", "hcs T-12170 · subject: seat"),
         "rows": [("stella", "Let Stella run the four live sends on the test card?", "Approve (recommended) · Hold", "task T-12235", "agree (vesta)", "—"),
                  ("c2demo", "Who taps Send on c2demo-2?", "Stella (recommended) · Me", "task T-12235", "agree (vesta)", "—")],
         "aside": "c2 · ping · last {at, attentionAt, generation} (controller; none written: every lit turn was covered)",
         "gen_rows": [
             {"n": 3, "status": "active", "attention": "jev · approval · 2026-11-01T14:00:25.281Z",
              "runtime": ("rt-f1063…", "claude · hrcpty · idle"), "docs": []},
         ]},
    ]},
]


def asks_record(fig, x, y, w, s):
    rows = s["rows"]
    h = rec_h(rows)
    rec = fig.box(x, y, w, h, fill=PLUM_T, stroke=PLUM_L, width=1.5, radius=8.0, stem="rec")
    agent = s["ref"].split("@")[0]
    segs = [span("HRC.ANNOTATION · C2 · ASKS", face="cond.semibold", size=9.5, tracking=0.9, fill=PLUM),
            span(f"     subject seat · key {s['ref'].split(':')[0]} + c2 + asks + open · updatedBy agent:{agent} · CAS --expect-updated-at", face="mono.regular", size=9, fill=SILVER), "\n",
            span(f"open questions · {len(rows)} row{'s' if len(rows) != 1 else ''}", face="sans.semibold", size=12.5, fill=GRAPHITE),
            span("      a status turn writes nothing · survives rotation · the seat's own writing", size=10, fill=LEAD)]
    for rid, ask, opts, task, review, sent in rows:
        segs += ["\n", span(f"{rid:<13}", face="mono.regular", size=9.5, fill=PLUM), span(ask, face="sans.semibold", size=10.5, fill=GRAPHITE),
                 span(f"    {opts}    {task}    review {review}    sent {sent}", size=10, fill=LEAD)]
    segs += ["\n", span("beside it on the seat:  ", face="sans.semibold", size=9.5, fill=LEAD), span(s["aside"], size=9.5, fill=LEAD)]
    fig.caption(rec, *segs, padding=10.0)
    return rec


def build(fig):
    anchors = {}
    X0, Y0 = 48.0, 150.0
    fig.text(48, 40, span("The hrc document, instanced: seats hold their open questions as one annotation; generations hold attention and the runtime",
                          face="sans.semibold", size=24, fill=GRAPHITE), max_width=1700)
    fig.text(48, 78, span("hrc:hrc to-be · the 10-31 seats carried to the T-12239 design (rows from their cards and asks; mable@c2's two rows are real, 2026-11-01) · shape agreed with Lance 2026-11-01, Daedalus pending", size=13, fill=LEAD))
    fig.box(48, 108, 1752, 1.0, fill=RULE, stroke=RULE, width=0.0, radius=0.0, stem="rule")

    pw = [project_size(p["seats"]) for p in PROJECTS]
    doc_w = PAD * 2 + max(w for w, _ in pw)
    doc_h = TITLE_H + sum(h for _, h in pw) + GAP * (len(PROJECTS) - 1) + PAD
    fig.container(X0, Y0, doc_w, doc_h, kicker="DOCUMENT · CARDO", name="hrc:hrc",
                  sub="rebuildable · observation types only · one hierarchy: lineage", fill=GROUND, ink=LEAD)
    y = Y0 + TITLE_H
    for p, (w_p, h_p) in zip(PROJECTS, pw):
        px = X0 + PAD
        fig.container(px, y, w_p, h_p, kicker="HRC.PROJECT", name=p["id"], sub=f"key projectId={p['id']}", fill=NESTED)
        sy = y + TITLE_H
        for s in p["seats"]:
            w_s, h_s = seat_size(s)
            sx = px + PAD
            fig.container(sx, sy, w_s, h_s, kicker="HRC.SEAT", name=s["ref"], sub=f"key sessionRef={s['scope']}/lane:main",
                          fill=PAPER, ink=COBALT, line=COBALT_L)
            fig.text(sx + 12, sy + TITLE_H - 2,
                     span("identity  ", face="sans.semibold", size=10.5, fill=LEAD), span(s["scope"].replace("agent:", "").replace(":project:", " · ").replace(":task:", " · "), size=10.5, fill=LEAD),
                     "      ", span("metadata  ", face="sans.semibold", size=10.5, fill=LEAD), span(s["meta"], size=10.5, fill=LEAD),
                     "      ", span("activeGeneration  ", face="sans.semibold", size=10.5, fill=LEAD), span(str(s["gen_rows"][-1]["n"]), size=10.5, fill=LEAD))
            if s.get("seat_ann"):
                k, st, key = s["seat_ann"]
                sa = fig.card(sx + w_s - PAD - CARD_W, sy + 6, kicker="HRC.ANNOTATION · " + k.upper(), name=st,
                              lines=("continuity-scoped: survives rotation",), meta=key, hue=(PLUM, PLUM_L), fill=PLUM_T, h=70)
                anchors.setdefault("seat_annotation", sa)
                anchors.setdefault("seat_annotation_y", sy + 6 + 35)
            rec = asks_record(fig, sx + PAD, sy + TITLE_H + 44, w_s - 2 * PAD, s)
            anchors.setdefault("asks", rec)
            anchors.setdefault("asks_y", sy + TITLE_H + 44 + rec_h(s["rows"]) / 2)
            gx = sx + PAD
            gy = sy + TITLE_H + 44 + rec_h(s["rows"]) + GAP
            for g in s["gen_rows"]:
                w_g, h_g = gen_size(len(g["docs"]))
                active = g["status"] == "active"
                fig.container(gx, gy, w_g, h_g, kicker="HRC.GENERATION", name=f"generation {g['n']} · {g['status']}",
                              sub=f"order {g['n']}" if w_g < 400 else f"key hostSessionId · order {g['n']}", fill=DEEP if active else GROUND,
                              ink=GRAPHITE if active else SILVER, dash=None if active else [5, 4], line=None if active else NEUTRAL)
                ay = gy + TITLE_H + 2
                if g["attention"]:
                    pill = fig.box(gx + PAD, ay, 330, 22, fill=VERMILION_T, stroke=VERMILION_L, width=1.0, radius=11.0, stem="pill")
                    fig.caption(pill, span("attention  ", face="sans.semibold", size=10, fill=VERMILION), span(g["attention"], size=10, fill=VERMILION),
                                valign="center", padding=4.0)
                    if "attention" not in anchors:
                        anchors["attention"] = pill
                        anchors["pill_y"] = ay + 11
                        anchors["pill_right"] = gx + PAD + 330
                else:
                    fig.text(gx + PAD + 6, ay + 4, span("attention  none", size=10, fill=SILVER))
                cx, cy = gx + PAD, ay + 30
                if g["runtime"]:
                    rid, rdesc = g["runtime"]
                    fig.card(cx, cy, kicker="HRC.RUNTIME", name=rid, lines=(rdesc, "attachable"), meta="key runtimeId · contextReading", hue=(VIRIDIAN, VIRIDIAN_L))
                else:
                    fig.card(cx, cy, kicker="HRC.RUNTIME", name="none", lines=("process ended", "node drops after 24 h"),
                             meta="live_until set", hue=(SILVER, NEUTRAL), fill=GROUND, dash=[4, 3])
                cx += CARD_W + GAP
                for kicker, state, line, meta in g["docs"]:
                    fig.card(cx, cy, kicker="HRC.ANNOTATION · " + kicker.upper(), name=state, lines=(line,), meta=meta,
                             hue=(SILVER, PLUM_L), fill=PAPER, dash=[5, 4])
                    cx += CARD_W + GAP
                gx += w_g + GAP
            sy += h_s + GAP
        y += h_p + GAP

    # ---- stores column (unchanged from the 10-31 frame) -----------------------------------------
    SX, SW = X0 + doc_w + 120, 330
    fig.text(SX + SW + 48 - 48 - 420, 20, span("TO-BE · 2026-11-01 · T-12239", face="mono.regular", size=10, fill=SILVER), align="right", max_width=420)
    rows = [
        ("continuities", "scope_ref, lane_ref → active session; identity", "mirrors → hrc.seat"),
        ("session_metadata", "continuity scalars: title, colour, hcs ref", "mirrors → hrc.seat.metadata"),
        ("sessions", "host_session_id, generation, status, continuation", "mirrors → hrc.generation"),
        ("runtimes", "runtime_id, transport, status, tmux, presentation", "mirrors → hrc.runtime"),
        ("seat_annotations", "subject seat|generation · ns, kind, id → JSON · fence", "mirrors → hrc.annotation · c2: subject seat only"),
    ]
    RH = 84
    sh = TITLE_H + len(rows) * (RH + GAP) + PAD
    fig.container(SX, Y0, SW, sh, kicker="DATASTORE · HRC", name="state.sqlite", sub="rows the nodes mirror", fill=GROUND)
    ry = Y0 + TITLE_H
    ann_box = None
    for name, desc, target in rows:
        emph = name.startswith("seat_annotations")
        bx = fig.card(SX + PAD, ry, kicker="TABLE", name=name, lines=(desc,), meta=target, hue=(PLUM if emph else GRAPHITE, PLUM_L if emph else NEUTRAL),
                      fill=PLUM_T if emph else PAPER, w=SW - 2 * PAD, h=RH)
        if emph:
            ann_box, ann_row_y = bx, ry + RH / 2
        ry += RH + GAP
    ly = Y0 + sh + 40
    ledger = fig.card(SX + PAD, ly, kicker="DATASTORE · HRC", name="hrc_events (ledger)",
                      lines=("turn.attention from jev · seat.annotation.action", "time series stays outside doms"),
                      meta="append-only · hrc_seq", hue=(VIRIDIAN, VIRIDIAN_L), w=SW - 2 * PAD, h=92)
    jev = fig.card(SX + PAD, ly + 92 + 40, kicker="DAEMON · HRC-TURN-ATTENTION", name="jev classifier",
                   lines=("appends turn.attention per completed turn",), meta="attention-v3", hue=(GRAPHITE, NEUTRAL), w=SW - 2 * PAD, h=70)
    fig.text(SX + PAD, ly + 92 + 40 + 70 + 24,
             span("proposed in T-12239: ", face="sans.semibold", size=10.5, fill=VIRIDIAN),
             span("the attention fold also carries runId and turnId, so the controller can tie a delivery's run to the turn that answered it", size=10.5, fill=LEAD),
             max_width=SW - 2 * PAD)

    # ---- edges -------------------------------------------------------------------------------------
    fig.port(jev, "t", "top"); fig.port(ledger, "b", "bottom")
    fig.edge(jev, "t", ledger, "b", stroke=COBALT_L, width=1.4, head=True, label="turn.attention")
    gutter = SX - 60
    if ann_box is not None and "asks" in anchors:
        fig.port(ann_box, "l", "left"); fig.port(anchors["asks"], "r", "right")
        fig.edge(ann_box, "l", anchors["asks"], "r", stroke=PLUM_L, width=1.3, dash=[2, 3], label="mirrors",
                 waypoints=[(gutter + 30, ann_row_y), (gutter + 30, anchors["asks_y"])])
    if "attention" in anchors:
        fig.port(ledger, "l", "left"); fig.port(anchors["attention"], "r", "right")
        sel = fig.edge(ledger, "l", anchors["attention"], "r", stroke=VIRIDIAN_L, width=1.6, head=True, label="selected event → attention",
                       waypoints=[(gutter, ly + 46), (gutter, anchors["pill_y"])])
        # on the long final segment, in the seat's whitespace right of the generation (fractions measured from the ledger end)
        total = 60 + abs(ly + 46 - anchors["pill_y"]) + (gutter - anchors["pill_right"])
        frac = (60 + abs(ly + 46 - anchors["pill_y"]) + (gutter - anchors["pill_right"]) * 0.45) / total
        fig.b.update_edge_label(sel, "l", placement=edges.route_fraction(round(frac, 3)), shaft_gap=None, clearance=6.0)

    # ---- key ------------------------------------------------------------------------------------------
    ky = Y0 + doc_h + 36
    fig.text(X0, ky, span("KEY", face="cond.semibold", size=9.5, tracking=0.9, fill=LEAD))
    items = [
        (COBALT_L, "hrc.seat", "the continuity · key sessionRef · metadata lives here"),
        (GRAPHITE, "hrc.generation", "one per host session · ordered · attention is its field · live 24 h after its runtime ends"),
        (VIRIDIAN_L, "hrc.runtime", "the process · key runtimeId · attachable"),
        (PLUM_L, "hrc.annotation", "client-owned JSON on a seat or generation · c2 uses the seat subject only: asks (questions as rows), receipt, ping"),
    ]
    for i, (colour, name, desc) in enumerate(items):
        kx = X0 + 60 + (i % 2) * 760
        kyy = ky + (i // 2) * 24
        fig.box(kx, kyy + 2, 12, 12, fill=colour, stroke=colour, width=0.0, radius=3.0, stem="sw")
        fig.text(kx + 18, kyy - 2, span(name, face="sans.semibold", size=11, fill=GRAPHITE), "  ", span(desc, size=11, fill=LEAD))
    fig.text(X0 + 60, ky + 52, span("nesting", face="sans.semibold", size=11, fill=GRAPHITE), "  ", span("= the lineage hierarchy (project › seat › generation › runtime; seat › annotation)", size=11, fill=LEAD),
             "      ", span("dotted", face="sans.semibold", size=11, fill=GRAPHITE), "  ", span("= mirrors one store row", size=11, fill=LEAD),
             "      ", span("green", face="sans.semibold", size=11, fill=VIRIDIAN), "  ", span("= folded from the ledger, never stored on the node", size=11, fill=LEAD),
             "      ", span("dashed card", face="sans.semibold", size=11, fill=GRAPHITE), "  ", span("= a kind HRC allows that c2 no longer writes", size=11, fill=LEAD))
    return SX + SW + 48, ky + 90


def clear(b, doc):
    snap = doc.inspect()
    kinds = {o["object_id"]: o["type"] for o in snap["objects"]}
    ids = doc.ids()
    for e in ids.get("edges", []):
        b.delete_edge(e)
    texts = [o for o in ids.get("objects", []) if kinds.get(o) == "arris.styled_text"]
    boxes = [o for o in ids.get("objects", []) if kinds.get(o) == "arris.box"]
    for t in texts:
        b.delete(t)
    for x in boxes:
        b.delete(x)
    return len(ids.get("edges", [])) + len(texts) + len(boxes)


_ids = {}
def uid(stem):
    n = _ids.get(stem, 0) + 1
    _ids[stem] = n
    return f"{ID_PREFIX}.{stem}.{n}"
_fig.uid = uid

board = Board.attach(BOARD, client="mable")
session, doc = board.frame(FRAME)
with session:
    with doc.edit() as b:
        removed = clear(b, doc)
        b.set_page_fill("#FFFFFF")
        fig = Fig(b)
        right, bottom = build(fig)
        b.set_page(right, bottom)
    print("removed", removed, "page", right, bottom)
    deliver(doc, NATIVE, keep_previous="drafts")
    print("delivered")
