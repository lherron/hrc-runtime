"""Build the seat-data-question-keyed frame: one real seat under the T-12239 to-be design.
A card follows the question (id = askId the seat chose); attention events come and go beneath it."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from arris_client import Board, deliver
from arris_client.typography import span
from _fig import (CARD_H, CARD_W, COBALT, COBALT_L, DEEP, GAP, GRAPHITE, GROUND, LEAD, NESTED, NEUTRAL, PAD, PAPER, PLUM, PLUM_L,
                  PLUM_T, RULE, SILVER, VERMILION, VERMILION_L, VERMILION_T, VIRIDIAN, VIRIDIAN_L, Fig)

BOARD = "/Users/lherron/praesidium/hrc-runtime/diagrams/seat-data.arris-board.json"
NATIVE = "/Users/lherron/praesidium/hrc-runtime/diagrams/seat-data-question-keyed.arris.json"
FRAME = "seat-data-question-keyed"
RUNTIME = os.environ.get("RT", "rt-92d8…")

TITLE_H = 40.0
CARD_H2 = 118.0           # generation-row cards carry one more line than the model frame's
STRIP_H = 62.0            # the attention-event strip above the cards
ASK = "t12235-phone-sends"
# Real turn.attention events on mable@c2:primary generation 3, 2026-11-01 (hrc_events, lit=true).
EVENTS = [("13:46:47", "human_action"), ("13:46:53", "human_action"), ("13:47:35", "human_action"),
          ("13:53:53", "approval"), ("13:59:13", "approval"), ("14:00:25", "approval")]


def gen_w(n_cards):
    return PAD * 2 + n_cards * CARD_W + (n_cards - 1) * GAP


def build(fig):
    X0, Y0 = 48.0, 150.0
    fig.text(48, 40, span("One seat under T-12239: the card follows the question; attention events come and go beneath it",
                          face="sans.semibold", size=24, fill=GRAPHITE), max_width=1600)
    fig.text(48, 78, span("hrc:hrc to-be · mable@c2:primary on max3, 2026-11-01 13:46–14:00 · six lit turns, one question, one card · draft, not approved",
                          size=13, fill=LEAD))
    fig.text(1582, 20, span("TO-BE · DRAFT 2026-11-01 · T-12239", face="mono.regular", size=10, fill=SILVER), align="right", max_width=420)
    fig.box(48, 108, 1752, 1.0, fill=RULE, stroke=RULE, width=0.0, radius=0.0, stem="rule")

    # ---- sizes -----------------------------------------------------------------
    g2_w, g3_w = gen_w(2), gen_w(3)
    gen_h = TITLE_H + STRIP_H + CARD_H2 + PAD
    seat_w = PAD * 2 + g2_w + GAP + g3_w
    seat_h = TITLE_H + 44 + gen_h + PAD
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

    # ---- generation 2 · archived --------------------------------------------------
    gx, gy = sx + PAD, sy + TITLE_H + 44
    fig.container(gx, gy, g2_w, gen_h, kicker="HRC.GENERATION", name="generation 2 · archived", sub="key hostSessionId · order 2",
                  fill=GROUND, ink=SILVER, dash=[5, 4], line=NEUTRAL)
    fig.text(gx + PAD + 6, gy + TITLE_H + 6, span("attention  none  (a generation inherits no older signal)", size=10, fill=SILVER))
    cy = gy + TITLE_H + STRIP_H
    fig.card(gx + PAD, cy, kicker="HRC.RUNTIME", name="none", lines=("process ended", "node drops after 24 h"),
             meta="live_until set", hue=(SILVER, NEUTRAL), fill=GROUND, dash=[4, 3], h=CARD_H2)
    fig.card(gx + PAD + CARD_W + GAP, cy, kicker="HRC.ANNOTATION · C2 · CARD", name="ended · generation_changed",
             lines=("rode with its generation", "the new generation re-raised it from the handoff"),
             meta=f"mable@c2#2#{ASK}", hue=(SILVER, PLUM_L), fill=PAPER, dash=[5, 4], h=CARD_H2)

    # ---- generation 3 · active ----------------------------------------------------
    gx3 = gx + g2_w + GAP
    fig.container(gx3, gy, g3_w, gen_h, kicker="HRC.GENERATION", name="generation 3 · active", sub="key hostSessionId · order 3",
                  fill=DEEP, ink=GRAPHITE)
    # the attention-event strip: one chip per lit turn; only the last is the live field
    chip_w, chip_gap, chip_h = 124.0, 7.0, 22.0
    ay = gy + TITLE_H + 4
    live = None
    for i, (hhmm, kind) in enumerate(EVENTS):
        last = i == len(EVENTS) - 1
        cx = gx3 + PAD + i * (chip_w + chip_gap)
        chip = fig.box(cx, ay, chip_w, chip_h, fill=VERMILION_T if last else PAPER, stroke=VERMILION_L if last else NEUTRAL,
                       width=1.0, radius=11.0, dash=None if last else [3, 3], stem="chip")
        fig.caption(chip, span(hhmm + "  ", face="sans.semibold", size=9, fill=VERMILION if last else SILVER),
                    span(kind, size=9, fill=VERMILION if last else SILVER), valign="center", padding=3.0, align="center")
        if last:
            live = chip
    fig.text(gx3 + PAD + 6, ay + chip_h + 6,
             span("attention", face="sans.semibold", size=10, fill=VERMILION), span("  = the live chip only · the five grey ones were cleared by the next turn · all six name the same question", size=10, fill=LEAD))
    cx = gx3 + PAD
    fig.card(cx, cy, kicker="HRC.RUNTIME", name=RUNTIME, lines=("claude · hrcpty · idle", "attachable: hrcpty"),
             meta="key runtimeId · contextReading", hue=(VIRIDIAN, VIRIDIAN_L), h=CARD_H2)
    cx += CARD_W + GAP
    card = fig.card(cx, cy, kicker="HRC.ANNOTATION · C2 · CARD", name="open · 2 questions",
                    lines=("the seat wrote it · put fenced on generation 3", "updatedBy agent:mable · review: agree (vesta)"),
                    meta=f"mable@c2#3#{ASK}", hue=(PLUM, PLUM_L), fill=PLUM_T, h=CARD_H2)
    cx += CARD_W + GAP
    ping = fig.card(cx, cy, kicker="HRC.ANNOTATION · C2 · PING", name="pinged 13:46:47",
                    lines=("a lit turn with no open card → one line to the seat", "at most one per uncovered attention"),
                    meta="mable@c2#3#ping#…T13:46:47Z", hue=(SILVER, PLUM_L), fill=PAPER, dash=[5, 4], h=CARD_H2)

    # ---- the hands on the card: a row below the document ---------------------------
    WY = Y0 + doc_h + 56
    WW, WH = 300.0, 100.0
    writers = [
        ("WRITER · THE SEAT", "mable@c2:primary", ("puts the card before a turn ends on a question", "touches it on status turns · retires it when answered"),
         "put · --expect-generation 3 · --as agent:mable", (COBALT, COBALT_L), PAPER, "put · touch · retire"),
        ("WRITER · C2 CONTROLLER", "pings · moves state", ("lit turn, no open card → one ping line", "open → sent → resolved · ends on rotation"),
         "system:c2-controller", (GRAPHITE, NEUTRAL), PAPER, "ping · state"),
        ("WRITER · VESTA", "reviews", ("review {verdict, why, recommend?} beside the seat's", "retires duplicates · never rewrites the card"),
         "agent:vesta", (PLUM, PLUM_L), PLUM_T, "review"),
        ("READER · LANCE", "answers on the card", ("pane or phone → seat.send to generation 3", "a click → session.annotation.action in the ledger"),
         "agent:lance", (VERMILION, VERMILION_L), VERMILION_T, "act"),
    ]
    total = len(writers) * WW + (len(writers) - 1) * 40
    wx0 = X0 + (doc_w - total) / 2
    card_id = fig.b.object_id(card)
    for i, (kicker, name, lines, meta, hue, fill, label) in enumerate(writers):
        wx = wx0 + i * (WW + 40)
        w = fig.card(wx, WY, kicker=kicker, name=name, lines=lines, meta=meta, hue=hue, fill=fill, w=WW, h=WH)
        fig.port(w, "t", "top")
        frac = (i + 1) / (len(writers) + 1)
        fig.port(card, f"b{i}", "bottom", frac)
        fig.edge(w, "t", card, f"b{i}", stroke=hue[1], width=1.3, head=True, label=label, at=0.78)

    # ---- the ledger on the right: where attention comes from ------------------------
    SX, SW = X0 + doc_w + 120, 330.0
    ledger = fig.card(SX, Y0, kicker="DATASTORE · HRC", name="hrc_events (ledger)",
                      lines=("turn.attention from jev, one per completed turn", "session.annotation.changed · .action"),
                      meta="append-only · hrc_seq", hue=(VIRIDIAN, VIRIDIAN_L), w=SW, h=92)
    jev = fig.card(SX, Y0 + 92 + 40, kicker="DAEMON · HRC-TURN-ATTENTION", name="jev classifier",
                   lines=("classifies the final text of every completed turn", "a status turn that restates the ask lights again"),
                   meta="attention-v3", hue=(GRAPHITE, NEUTRAL), w=SW, h=92)
    fig.port(jev, "t", "top")
    fig.port(ledger, "b", "bottom")
    fig.edge(jev, "t", ledger, "b", stroke=COBALT_L, width=1.4, head=True, label="turn.attention")
    fig.port(ledger, "l", "left")
    fig.port(live, "r", "right")
    fig.edge(ledger, "l", live, "r", stroke=VIRIDIAN_L, width=1.6, head=True, label="selected event → attention  (+ runId, turnId: proposed)", at=0.4,
             waypoints=[(SX - 60, Y0 + 46), (SX - 60, ay + chip_h / 2)])
    fig.text(SX, Y0 + 92 + 40 + 92 + 28,
             span("What changed from the 10-31 frame", face="sans.semibold", size=11, fill=GRAPHITE), "\n",
             span("card id: attention.at → askId (seat-chosen)", size=10.5, fill=LEAD), "\n",
             span("put fence: attention.at → generation", size=10.5, fill=LEAD), "\n",
             span("writer: vesta from the transcript → the seat itself", size=10.5, fill=LEAD), "\n",
             span("cardinality: one card per lit turn → one per open question", size=10.5, fill=LEAD), "\n",
             span("new bookkeeping: c2 · ping on the generation", size=10.5, fill=LEAD), "\n",
             span("unchanged: subject, table, ledger, rotation ends the card", size=10.5, fill=SILVER),
             max_width=SW)

    # ---- key ----------------------------------------------------------------------------
    ky = WY + WH + 44
    fig.text(X0, ky, span("KEY", face="cond.semibold", size=9.5, tracking=0.9, fill=LEAD))
    items = [
        (VERMILION_L, "live chip", "the generation's attention field now: a pure fold of its latest turn event"),
        (NEUTRAL, "grey chip", "an earlier lit turn on the same question, cleared when the next turn started (ledger history, not a node)"),
        (PLUM_L, "hrc.annotation · c2 · card", "one per open question · key subject generation + ns c2 + kind card + id askId · the seat's own writing"),
        (PLUM_L, "dashed annotation", "ended, or controller bookkeeping (ping) · Vesta's review rides inside the card body"),
    ]
    for i, (colour, name, desc) in enumerate(items):
        kx = X0 + 60 + (i % 2) * 860
        kyy = ky + (i // 2) * 24
        fig.box(kx, kyy + 2, 12, 12, fill=colour, stroke=colour, width=0.0, radius=3.0, stem="sw")
        fig.text(kx + 18, kyy - 2, span(name, face="sans.semibold", size=11, fill=GRAPHITE), "  ", span(desc, size=11, fill=LEAD))
    return SX + SW + 48, ky + 70


board = Board.attach(BOARD, client="mable")
session, doc = board.frame(FRAME)
with session:
    with doc.edit() as b:
        b.set_page_fill("#FFFFFF")
        fig = Fig(b)
        right, bottom = build(fig)
        b.set_page(right, bottom)
    print("page", right, bottom)
    receipt = deliver(doc, NATIVE, keep_previous="drafts")
    print("delivered", receipt.get("findings_count", ""), receipt.get("previews", ""))
