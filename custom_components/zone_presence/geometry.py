"""Reine Geometrie-Helfer (keine Home-Assistant-Abhängigkeit).

Koordinatensystem: Meter, Ursprung oben links, x nach rechts, y nach unten.
Sensor-Frame (LD2450): xs seitlich, ys nach vorne (in Metern nach Skalierung).
"""
from __future__ import annotations

import math
from typing import Sequence

Point = tuple[float, float]


def dist(a: Sequence[float], b: Sequence[float]) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def centroid(pts: Sequence[Sequence[float]]) -> Point:
    n = len(pts)
    if n == 0:
        return (0.0, 0.0)
    return (sum(p[0] for p in pts) / n, sum(p[1] for p in pts) / n)


def point_in_poly(x: float, y: float, poly: Sequence[Sequence[float]]) -> bool:
    """Ray-Casting. Identisch zur Karte."""
    inside = False
    n = len(poly)
    if n < 3:
        return False
    j = n - 1
    for i in range(n):
        xi, yi = poly[i][0], poly[i][1]
        xj, yj = poly[j][0], poly[j][1]
        denom = (yj - yi) or 1e-9
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / denom + xi:
            inside = not inside
        j = i
    return inside


def closest_on_segment(p: Sequence[float], a: Sequence[float], b: Sequence[float]) -> Point:
    ax, ay = a[0], a[1]
    dx, dy = b[0] - ax, b[1] - ay
    l2 = dx * dx + dy * dy
    if l2 <= 1e-12:
        return (ax, ay)
    t = ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2
    t = max(0.0, min(1.0, t))
    return (ax + t * dx, ay + t * dy)


def closest_on_poly(p: Sequence[float], poly: Sequence[Sequence[float]]) -> tuple[Point, float]:
    """Nächster Punkt auf dem Polygonrand und dessen Abstand."""
    best: Point = (p[0], p[1])
    best_d = math.inf
    n = len(poly)
    for i in range(n):
        q = closest_on_segment(p, poly[i], poly[(i + 1) % n])
        d = dist(p, q)
        if d < best_d:
            best_d, best = d, q
    return best, best_d


def dist_to_poly_edge(p: Sequence[float], poly: Sequence[Sequence[float]]) -> float:
    return closest_on_poly(p, poly)[1]


def sensor_to_room(
    xs: float,
    ys: float,
    pos: Sequence[float],
    rot_deg: float,
    flip_x: float = 1.0,
    flip_y: float = 1.0,
) -> Point:
    """Sensor-Frame -> Raum. forward=(-sin, cos), lateral=(cos, sin). Identisch zur Karte."""
    th = math.radians(rot_deg)
    rx = pos[0] + ys * flip_y * (-math.sin(th)) + xs * flip_x * math.cos(th)
    ry = pos[1] + ys * flip_y * math.cos(th) + xs * flip_x * math.sin(th)
    return (rx, ry)


def poly_valid(poly) -> bool:
    try:
        return len(poly) >= 3 and all(
            len(p) == 2 and all(isinstance(v, (int, float)) and math.isfinite(v) for v in p)
            for p in poly
        )
    except TypeError:
        return False
