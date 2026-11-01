"""Shared figure vocabulary for the seat-data frames: Transit tokens, record cards, containers, ports and edges.
Factored out of seat-data-model.build.py (unchanged there) so later frames draw the same shapes."""
from arris_client import edges
from arris_client.typography import runs, span

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


