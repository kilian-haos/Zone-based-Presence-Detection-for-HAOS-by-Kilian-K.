"""Modell-Ansicht: Lernkarten aller Sensoren eines Raums in Raum-Koordinaten.

Reines Python ohne Home-Assistant-Abhängigkeit. Läuft im Executor (nur lesender Zugriff,
ein gleichzeitiges Lernen verfälscht höchstens einen Pixel der Darstellung).

Ausgabe je Zelle (0..100): g = Geister-Wahrscheinlichkeit (aktuelles Tageszeit-Fenster),
r = echte Aktivität, c = Konfidenz (wie viel weiß das Modell), h = Aufenthalte (relativ),
v = Anzahl Sensoren, die die Stelle sehen (0 = toter Winkel). Dazu Problemstellen.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from .geometry import closest_on_poly, in_fov, point_in_poly, poly_bbox, room_to_sensor
from .ghost_model import SNAP_CELL, GhostModel, HeatMap, SensorMap, _prob, _Raster, _unpack

SPOT_THRESHOLD = 0.42
MAX_FRAMES = 48


@dataclass
class ViewSensor:
    id: str
    pos: tuple[float, float]
    rot: float
    flip_x: float
    flip_y: float
    range: float
    half_angle: float
    m: SensorMap | None


def _grid(poly: list[list[float]], res: float) -> tuple[float, float, int, int, list[bool]]:
    x0, y0, x1, y1 = poly_bbox(poly)
    nx = max(1, int(math.ceil((x1 - x0) / res)))
    ny = max(1, int(math.ceil((y1 - y0) / res)))
    inside = []
    for cy in range(ny):
        y = y0 + (cy + 0.5) * res
        for cx in range(nx):
            inside.append(point_in_poly(x0 + (cx + 0.5) * res, y, poly))
    return x0, y0, nx, ny, inside


def build_view(poly: list[list[float]], sensors: list[ViewSensor], heat: HeatMap | None,
               res: float, slot: int, slots: int) -> dict[str, Any]:
    x0, y0, nx, ny, inside = _grid(poly, res)
    n = nx * ny
    g, r, c, v, h = [0] * n, [0] * n, [0] * n, [0] * n, [0.0] * n
    best_sid: list[str | None] = [None] * n
    for i in range(n):
        if not inside[i]:
            continue
        cy, cx = divmod(i, nx)
        x, y = x0 + (cx + 0.5) * res, y0 + (cy + 0.5) * res
        gm = rm = cm = 0.0
        vis = 0
        for s in sensors:
            xs, ys = room_to_sensor(x, y, s.pos, s.rot, s.flip_x, s.flip_y)
            if not in_fov(xs, ys, s.range, s.half_angle):
                continue
            vis += 1
            if s.m is None:
                continue
            pg = s.m.ghost_prob(xs, ys, slot)
            if pg > gm:
                gm, best_sid[i] = pg, s.id
            rm = max(rm, s.m.real_prob(xs, ys))
            cm = max(cm, s.m.confidence(xs, ys))
        g[i], r[i], c[i], v[i] = round(gm * 100), round(rm * 100), round(cm * 100), vis
        if heat is not None:
            h[i] = heat.sample(x, y)
    # Aufenthalte relativ zum 97. Perzentil (einzelne Dauersitzplätze sollen nicht alles überstrahlen)
    hv = sorted(x for x in h if x > 0)
    hmax = hv[min(len(hv) - 1, int(len(hv) * 0.97))] if hv else 0.0
    hi = [min(100, round(x / hmax * 100)) if hmax > 0 else 0 for x in h]
    spots = find_spots(poly, sensors, x0, y0, nx, ny, res, g, r, best_sid, slot, slots)
    return {
        "res": round(res, 4), "x0": round(x0, 4), "y0": round(y0, 4), "nx": nx, "ny": ny,
        "g": g, "r": r, "c": c, "v": v, "h": hi, "heat_max_s": round(hmax), "spots": spots,
    }


def find_spots(poly, sensors, x0, y0, nx, ny, res, g, r, best_sid, slot, slots) -> list[dict]:
    """Zusammenhängende Bereiche hoher Geister-Wahrscheinlichkeit (ohne echte Aktivität)."""
    score = [(gg / 100.0) * (1.0 - 0.7 * rr / 100.0) for gg, rr in zip(g, r)]
    seen = [False] * len(score)
    clusters = []
    for i, s in enumerate(score):
        if seen[i] or s < SPOT_THRESHOLD:
            continue
        stack, cells = [i], []
        seen[i] = True
        while stack:
            k = stack.pop()
            cells.append(k)
            cy, cx = divmod(k, nx)
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ax, ay = cx + dx, cy + dy
                if 0 <= ax < nx and 0 <= ay < ny:
                    j = ay * nx + ax
                    if not seen[j] and score[j] >= SPOT_THRESHOLD * 0.85:
                        seen[j] = True
                        stack.append(j)
        mass = sum(score[k] for k in cells) * res * res
        if len(cells) >= 2 or mass > 0.02:
            clusters.append((mass, cells))
    clusters.sort(key=lambda t: -t[0])
    out = []
    by_id = {s.id: s for s in sensors}
    for _mass, cells in clusters[:3]:
        wsum = sum(score[k] for k in cells) or 1.0
        cx = sum((x0 + (k % nx + 0.5) * res) * score[k] for k in cells) / wsum
        cy = sum((y0 + (k // nx + 0.5) * res) * score[k] for k in cells) / wsum
        xs_ = [x0 + (k % nx + 0.5) * res for k in cells]
        ys_ = [y0 + (k // nx + 0.5) * res for k in cells]
        pad = 0.15 + res / 2
        peak = max(score[k] for k in cells)
        _, wall_d = closest_on_poly((cx, cy), poly)
        sid_votes: dict[str, float] = {}
        for k in cells:
            if best_sid[k]:
                sid_votes[best_sid[k]] = sid_votes.get(best_sid[k], 0.0) + score[k]
        sid = max(sid_votes, key=sid_votes.get) if sid_votes else None
        spot = {
            "x": round(cx, 2), "y": round(cy, 2), "peak": round(peak, 2), "area": round(len(cells) * res * res, 2),
            "rect": [round(min(xs_) - pad, 2), round(min(ys_) - pad, 2), round(max(xs_) + pad, 2), round(max(ys_) + pad, 2)],
            "near_wall": wall_d < 0.45, "sensor": sid, "slot": None, "cal": False,
        }
        s = by_id.get(sid) if sid else None
        if s is not None and s.m is not None:
            xs, ys = room_to_sensor(cx, cy, s.pos, s.rot, s.flip_x, s.flip_y)
            m = s.m
            cal = _prob(m.g.sample(m.cal, xs, ys))
            per = [m.g.sample(m.ghost[k], xs, ys) for k in range(m.slots)]
            spot["cal"] = cal >= max([_prob(p) for p in per] + [0.0])
            tot = sum(per)
            if m.slots > 1 and tot > 0:
                k = max(range(m.slots), key=lambda j: per[j])
                if per[k] / tot >= 0.5:
                    spot["slot"] = [k, m.slots]
        out.append(spot)
    return out


def build_history(poly: list[list[float]], sensors: list[ViewSensor], snaps: list[dict]) -> dict[str, Any]:
    """Zeitraffer: gespeicherte Schnappschüsse (0,25 m) in Raum-Koordinaten."""
    res = 0.25
    x0, y0, nx, ny, inside = _grid(poly, res)
    pick = snaps
    if len(pick) > MAX_FRAMES:
        step = len(pick) / MAX_FRAMES
        pick = [pick[int(i * step)] for i in range(MAX_FRAMES - 1)] + [pick[-1]]
    frames = []
    for snap in pick:
        layers = {}
        for s in sensors:
            d = (snap.get("maps") or {}).get(s.id)
            if not d:
                continue
            try:
                ras = _Raster(float(d["range"]), float(d.get("cell", SNAP_CELL)))
            except (KeyError, TypeError, ValueError):
                continue
            layers[s.id] = (ras, _unpack(d.get("g"), ras.n), _unpack(d.get("r"), ras.n))
        g, r = [0] * (nx * ny), [0] * (nx * ny)
        for i in range(nx * ny):
            if not inside[i]:
                continue
            cy, cx = divmod(i, nx)
            x, y = x0 + (cx + 0.5) * res, y0 + (cy + 0.5) * res
            gm = rm = 0.0
            for s in sensors:
                lay = layers.get(s.id)
                if lay is None:
                    continue
                xs, ys = room_to_sensor(x, y, s.pos, s.rot, s.flip_x, s.flip_y)
                if not in_fov(xs, ys, s.range, s.half_angle):
                    continue
                ras, gl, rl = lay
                gm = max(gm, ras.sample(gl, xs, ys))
                rm = max(rm, ras.sample(rl, xs, ys))
            g[i], r[i] = round(min(1.0, gm) * 100), round(min(1.0, rm) * 100)
        frames.append({"ts": snap.get("ts"), "g": g, "r": r})
    return {"res": res, "x0": round(x0, 4), "y0": round(y0, 4), "nx": nx, "ny": ny, "frames": frames}


def forget_area(model: GhostModel, sensors: list[ViewSensor], room_id: str, x: float, y: float, radius: float) -> int:
    touched = 0
    for s in sensors:
        if s.m is None:
            continue
        xs, ys = room_to_sensor(x, y, s.pos, s.rot, s.flip_x, s.flip_y)
        touched += s.m.forget(xs, ys, radius)
    h = model.heat.get(room_id)
    if h is not None:
        h.forget(x, y, radius)
    return touched
