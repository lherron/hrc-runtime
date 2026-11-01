"""Build (or rebuild) the seat-data-question-keyed frame: one real seat under the T-12239 to-be design,
as agreed with Lance 2026-11-01. A seat's open questions are ONE seat-scoped record (c2 · asks) with
question rows; generations beneath it hold only the runtime, the attention history and the controller's
ping. Re-running clears the frame's objects first and redraws through the live serve."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _fig
from arris_client import Board, deliver, edges
from arris_client.typography import span
from _fig import (CARD_H, CARD_W, COBALT, COBALT_L, COBALT_T, DEEP, GAP, GRAPHITE, GROUND, LEAD, NESTED, NEUTRAL, PAD, PAPER, PLUM,
                  PLUM_L, PLUM_T, RULE, SILVER, VERMILION, VERMILION_L, VERMILION_T, VIRIDIAN, VIRIDIAN_L, VIRIDIAN_T, Fig)

BOARD = "/Users/lherron/praesidium/hrc-runtime/diagrams/seat-data.arris-board.json"
NATIVE = "/Users/lherron/praesidium/hrc-runtime/diagrams/seat-data-question-keyed.arris.json"
FRAME = "seat-data-question-keyed"
RUNTIME = os.environ.get("RT", "rt-f1063…")
GEN_PREFIX = os.environ.get("ID_PREFIX", "v2")   # new ids never clash with the objects this run deletes

TITLE_H = 40.0
STRIP_H = 62.0
# Real turn.attention events on mable@c2:primary generation 3, 2026-11-01 (hrc_events, lit=true).
EVENTS = [("13:46:47", "human_action"), ("13:46:53", "human_action"), ("13:47:35", "human_action"),
          ("13:53:53", "approval"), ("13:59:13", "approval"), ("14:00:25", "approval")]


def gen_w(n_cards):
    return PAD * 2 + n_cards * CARD_W + (n_cards - 1) * GAP


def build(fig):
    X0, Y0 = 48.0, 150.0
    fig.text(48, 40, span("One seat under T-12239: its open questions are one record; attention events come and go beneath it",
                          face="sans.semibold", size=24, fill=GRAPHITE), max_width=1600)
    fig.text(48, 78, span("hrc:hrc to-be · mable@c2:primary on max3, 2026-11-01 13:46–14:00 · six lit turns, two question rows, one record · shape agreed with Lance 2026-11-01, Daedalus pending",
                          size=13, fill=LEAD))
    fig.text(1582, 20, span("TO-BE · 2026-11-01 · T-12239", face="mono.regular", size=10, fill=SILVER), align="right", max_width=420)
    fig.box(48, 108, 1752, 1.0, fill=RULE, stroke=RULE, width=0.0, radius=0.0, stem="rule")

    # ---- sizes -------------------------------------------------------------------------
    g2_w, g3_w = gen_w(1), gen_w(2)
    gen_h = TITLE_H + STRIP_H + CARD_H + PAD
    REC_H = 166.0
    seat_w = PAD * 2 + g2_w + GAP + g3_w
    seat_w = max(seat_w, 1300.0)
    seat_h = TITLE_H + 44 + REC_H + GAP + gen_h + PAD
    proj_w, proj_h = PAD * 2 + seat_w, TITLE_H + seat_h + PAD
    doc_w, doc_h = PAD * 2 + proj_w, TITLE_H + proj_h + PAD

    fig.container(X0, Y0, doc_w, doc_h, kicker="DOCUMENT · CARDO", name="hrc:hrc",
                  sub="rebuildable · observation types only · one hierarchy: lineage", fill=GROUND, ink=LEAD)
    px, py = X0 + PAD, Y0 + TITLE_H
    fig.container(px, py, proj_w, proj_h, kicker="HRC.PROJECT", name="c2", sub="key projectId=c2", fill=NESTED)
    sx, sy = px + PAD, py + TITLE_H
    fig.container(sx, sy, seat_w, seat_h, kicker="HRC.SEAT", name="mable@c2:primary",
                  sub="key sessionRef=agent:mable:project:c2:task:primary/lane:main", fill=PAPER, ink=COBALT, line=COBALT_L)
    fig.text(sx + 12, sy + TITLE_H - 2,
             span("identity  ", face="sans.semibold", size=10.5, fill=LEAD), span("mable · c2 · primary", size=10.5, fill=LEAD),
             "      ", span("metadata  ", face="sans.semibold", size=10.5, fill=LEAD), span("title: c2 strategy", size=10.5, fill=LEAD),
             "      ", span("activeGeneration  ", face="sans.semibold", size=10.5, fill=LEAD), span("3", size=10.5, fill=LEAD))

    # ---- the asks record: seat-scoped, one per seat ----------------------------------------
    rx, ry, rw = sx + PAD, sy + TITLE_H + 44, seat_w - 2 * PAD
    rec = fig.box(rx, ry, rw, REC_H, fill=PLUM_T, stroke=PLUM_L, width=1.6, radius=8.0, stem="rec")
    fig.caption(rec,
                span("HRC.ANNOTATION · C2 · ASKS", face="cond.semibold", size=9.5, tracking=0.9, fill=PLUM),
                span("     subject seat · key mable@c2 + c2 + asks + open · updatedBy agent:mable · CAS --expect-updated-at", face="mono.regular", size=9, fill=SILVER), "\n",
                span("open questions · 2 rows", face="sans.semibold", size=13, fill=GRAPHITE),
                span("        a status turn writes nothing · a row leaves when the seat removes it · the record survives rotation: it holds the question, not the conversation", size=10.5, fill=LEAD), "\n",
                span("\n", size=4), 
                span("stella  ", face="mono.regular", size=10, fill=PLUM), span("Let Stella run the four live sends on the test card?", face="sans.semibold", size=11, fill=GRAPHITE),
                span("     Approve ", size=10.5, fill=GRAPHITE), span("(recommended)", size=10, fill=VIRIDIAN), span(" · Hold     task T-12235     review ", size=10.5, fill=LEAD), span("agree", size=10.5, fill=VIRIDIAN), span(" (vesta)     sent —", size=10.5, fill=LEAD), "\n",
                span("c2demo  ", face="mono.regular", size=10, fill=PLUM), span("Who taps Send on c2demo-2?", face="sans.semibold", size=11, fill=GRAPHITE),
                span("     Stella ", size=10.5, fill=GRAPHITE), span("(recommended)", size=10, fill=VIRIDIAN), span(" · Me     task T-12235     review ", size=10.5, fill=LEAD), span("agree", size=10.5, fill=VIRIDIAN), span(" (vesta)     sent —", size=10.5, fill=LEAD), "\n",
                span("per row:", face="sans.semibold", size=10, fill=LEAD), span("  id · ask · options · recommended · why? · task? · dependsOn? <seat>#<row> (folds under the owner's row, never sent) · review {verdict, why} (vesta) · sent {runId, at} (controller)", size=10, fill=LEAD), "\n",
                span("beside it, also on the seat:", face="sans.semibold", size=10, fill=LEAD), span("  c2 · ping · last {at, attentionAt, generation} (controller)   ·   c2 · receipt · <requestId> (the pane's per-action claim; target generation in the body)   ·   Vesta's own asks are rows in vesta@c2's record", size=10, fill=LEAD),
                padding=12.0)

    # ---- generation 2 · archived -----------------------------------------------------------
    gx, gy = sx + PAD, ry + REC_H + GAP
    fig.container(gx, gy, g2_w, gen_h, kicker="HRC.GENERATION", name="generation 2 · archived",
                  fill=GROUND, ink=SILVER, dash=[5, 4], line=NEUTRAL)
    fig.text(gx + PAD + 6, gy + TITLE_H + 6, span("attention  none", size=10, fill=SILVER))
    fig.text(gx + PAD + 6, gy + TITLE_H + 24, span("no copy of the asks here:", face="sans.semibold", size=10, fill=SILVER), span(" the record is the seat's", size=10, fill=SILVER))
    cy = gy + TITLE_H + STRIP_H
    fig.card(gx + PAD, cy, kicker="HRC.RUNTIME", name="none", lines=("process ended", "node drops after 24 h"),
             meta="live_until set", hue=(SILVER, NEUTRAL), fill=GROUND, dash=[4, 3])

    # ---- generation 3 · active -------------------------------------------------------------
    gx3 = gx + g2_w + GAP
    fig.container(gx3, gy, g3_w, gen_h, kicker="HRC.GENERATION", name="generation 3 · active", sub="key hostSessionId · order 3",
                  fill=DEEP, ink=GRAPHITE)
    chip_w, chip_gap, chip_h = 76.0, 6.0, 22.0
    ay = gy + TITLE_H + 4
    live = None
    for i, (hhmm, kind) in enumerate(EVENTS):
        last = i == len(EVENTS) - 1
        cx = gx3 + PAD + i * (chip_w + chip_gap)
        chip = fig.box(cx, ay, chip_w, chip_h, fill=VERMILION_T if last else PAPER, stroke=VERMILION_L if last else NEUTRAL,
                       width=1.0, radius=11.0, dash=None if last else [3, 3], stem="chip")
        fig.caption(chip, span(hhmm, face="sans.semibold", size=9, fill=VERMILION if last else SILVER), valign="center", padding=3.0, align="center")
        if last:
            live = chip
    fig.text(gx3 + PAD + 6, ay + chip_h + 6,
             span("attention", face="sans.semibold", size=10, fill=VERMILION), span("  = the live chip · six lit turns, all covered by the open rows above · ping.last never written", size=10, fill=LEAD))
    cx = gx3 + PAD
    fig.card(cx, cy, kicker="HRC.RUNTIME", name=RUNTIME, lines=("claude · hrcpty · idle", "attachable: hrcpty"),
             meta="key runtimeId · contextReading", hue=(VIRIDIAN, VIRIDIAN_L))
    cx += CARD_W + GAP
    fig.card(cx, cy, kicker="C2 ANNOTATIONS ON A GENERATION", name="none",
             lines=("card, ask, receipt and ping all live on the seat", "a rotation touches zero c2 annotations"),
             meta="HRC keeps the generation subject; c2 stops using it", hue=(SILVER, NEUTRAL), fill=GROUND, dash=[4, 3])

    # ---- right column: the hands on the record, then where attention comes from -------------
    SX, SW, WH, WGAP = X0 + doc_w + 150, 330.0, 100.0, 22.0
    writers = [
        ("WRITER · THE SEAT", "edits its rows", ("adds a row when a question arises", "removes it when answered or moot · nothing on a status turn"),
         "put · --expect-updated-at · --as agent:mable", (COBALT, COBALT_L), COBALT_T, "edit rows"),
        ("WRITER · C2 CONTROLLER", "pings · delivers · stamps sent", ("lit turn ∧ no open row → one ping", "delivers to the live generation · sent {runId, at} on the row"),
         "system:c2-controller", (GRAPHITE, NEUTRAL), PAPER, "sent"),
        ("WRITER · VESTA", "reviews rows", ("review {verdict, why, dependsOn?} per row", "never edits the seat's rows · retires nothing"),
         "agent:vesta", (PLUM, PLUM_L), PLUM_T, "review"),
        ("READER · LANCE", "answers rows", ("pane or phone · the answer carries its question", "seat.send → live generation · session.annotation.action"),
         "agent:lance", (VERMILION, VERMILION_L), VERMILION_T, "act"),
    ]
    fig.port(rec, "r0", "right", 0.2); fig.port(rec, "r1", "right", 0.4); fig.port(rec, "r2", "right", 0.6); fig.port(rec, "r3", "right", 0.8)
    gutter = SX - 70
    for i, (kicker, name, lines, meta, hue, fill, label) in enumerate(writers):
        wy = Y0 + i * (WH + WGAP)
        w = fig.card(SX, wy, kicker=kicker, name=name, lines=lines, meta=meta, hue=hue, fill=fill, w=SW, h=WH)
        fig.port(w, "l", "left")
        port_y = ry + REC_H * (0.2 + 0.2 * i)
        fig.edge(w, "l", rec, f"r{i}", stroke=hue[1], width=1.3, head=True, label=label, label_at=(gutter - 64.0, port_y - 9.0),
                 waypoints=[(gutter, wy + WH / 2), (gutter, port_y)])
    ly = Y0 + 4 * (WH + WGAP) + 30
    ledger = fig.card(SX, ly, kicker="DATASTORE · HRC", name="hrc_events (ledger)",
                      lines=("turn.attention from jev, one per completed turn", "session.annotation.changed · .action"),
                      meta="append-only · hrc_seq", hue=(VIRIDIAN, VIRIDIAN_L), w=SW, h=92)
    jev = fig.card(SX, ly + 92 + 40, kicker="DAEMON · HRC-TURN-ATTENTION", name="jev classifier",
                   lines=("classifies the final text of every completed turn", "a status turn that restates the ask lights again"),
                   meta="attention-v3", hue=(GRAPHITE, NEUTRAL), w=SW, h=92)
    fig.port(jev, "t", "top")
    fig.port(ledger, "b", "bottom")
    fig.edge(jev, "t", ledger, "b", stroke=COBALT_L, width=1.4, head=True, label="turn.attention")
    fig.port(ledger, "l", "left")
    fig.port(live, "r", "right")
    chip_right = gx3 + PAD + (len(EVENTS) - 1) * (chip_w + chip_gap) + chip_w
    sel = fig.edge(ledger, "l", live, "r", stroke=VIRIDIAN_L, width=1.6, head=True, label="selected event → attention",
                   waypoints=[(gutter - 40, ly + 46), (gutter - 40, ay + chip_h / 2)])
    # the label on the route's final horizontal segment, no shaft gap: a point off the route cannot open one
    fig.b.update_edge_label(sel, "l", placement=edges.page_placement(((chip_right + gutter - 40) / 2 - 60, ay + chip_h / 2)), shaft_gap=None, clearance=6.0)
    fig.text(SX, ly + 92 + 40 + 92 + 24,
             span("proposed in T-12239: ", face="sans.semibold", size=10.5, fill=VIRIDIAN),
             span("the attention fold also carries runId and turnId, so the controller can tie a delivery's run to the turn that answered it", size=10.5, fill=LEAD),
             max_width=SW)

    # ---- what changed, under the document ----------------------------------------------------
    ny = Y0 + doc_h + 40
    fig.text(X0, ny, span("What changed from the 10-31 frame (cards keyed by attention event)", face="sans.semibold", size=12, fill=GRAPHITE))
    changes = [
        ("cardinality", "one card per lit turn → one asks record per seat, with one row per open question"),
        ("subject", "generation → seat: the record survives rotation, so nothing is re-raised from a handoff and a Vesta-carried ask never duplicates the seat's"),
        ("writer", "Vesta from the transcript → the seat itself; Vesta reviews per row"),
        ("fence", "attention.at → the record's CAS (expect.updatedAt); no touch, no generation fence"),
        ("ping", "lit turn ∧ no open row → one ping, recorded as c2 · ping · last on the seat; the classifier card is the fallback after one unanswered ping"),
        ("scope", "card, ask, receipt, ping were generation-scoped because the card was; all four move to the seat, so c2 writes no generation-scoped annotation and Vesta's asks are rows in her own record"),
        ("lifecycle", "card open → sent → resolved → per row: sent {runId, at}, greyed in the pane, gone when the seat removes it; partial answers fall out of this (Later rows stay)"),
        ("delivery", "the answer carries its question (\"1. Let Stella run the four live sends? — Approve.\"), so any generation reads it in context"),
        ("cross-seat", "rare, always a dependent waiting on the owner (T-12224: foundry ↔ hrc-runtime): a row's dependsOn folds it under the owner's row; no shared decision record"),
        ("unchanged", "hrc.annotation, seat_annotations, the ledger, the kernel mirror, the generation's attention fold"),
    ]
    for i, (k, v) in enumerate(changes):
        fig.text(X0 + 12, ny + 26 + i * 20, span(k, face="sans.semibold", size=10.5, fill=GRAPHITE), max_width=110)
        fig.text(X0 + 124, ny + 26 + i * 20, span(v, size=10.5, fill=LEAD), max_width=doc_w - 140)

    # ---- key -------------------------------------------------------------------------------------
    ky = ny + 26 + len(changes) * 20 + 30
    fig.text(X0, ky, span("KEY", face="cond.semibold", size=9.5, tracking=0.9, fill=LEAD))
    items = [
        (PLUM_L, "hrc.annotation · c2 · asks", "the seat's one record of open questions · subject seat · rows are the questions · the seat's own writing"),
        (VERMILION_L, "live chip", "the generation's attention field now: a pure fold of its latest turn event"),
        (NEUTRAL, "grey chip", "an earlier lit turn, cleared when the next turn started (ledger history, not a node)"),
        (NEUTRAL, "dashed grey card", "an empty slot: what used to live there and no longer does"),
    ]
    for i, (colour, name, desc) in enumerate(items):
        kx = X0 + 60 + (i % 2) * 860
        kyy = ky + (i // 2) * 24
        fig.box(kx, kyy + 2, 12, 12, fill=colour, stroke=colour, width=0.0, radius=3.0, stem="sw")
        fig.text(kx + 18, kyy - 2, span(name, face="sans.semibold", size=11, fill=GRAPHITE), "  ", span(desc, size=11, fill=LEAD))
    return SX + SW + 48, ky + 70


def clear(b, doc):
    """Delete every object and edge the live frame holds (edges first, then texts, then boxes), so a rerun redraws cleanly."""
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
    return f"{GEN_PREFIX}.{stem}.{n}"
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
    receipt = deliver(doc, NATIVE, keep_previous="drafts")
    print("delivered")
