"""Lernender Geisterfilter 2.0 – leichtgewichtiges statistisches Modell (reines Python).

Pro Sensor werden Evidenz-Karten im *Sensor-Frame* geführt. Weil sie im Sensor-Frame
liegen, bleiben sie gültig, wenn Platzierung oder Kalibrier-Offsets geändert werden.

  cal      Geister-Evidenz aus der einmaligen (Nacht-)Lernkalibrierung. Kein Verfall.
  ghost[k] Geister-Evidenz aus dem laufenden Betrieb, getrennt nach Tageszeit-Fenster k
           (z. B. Ventilator nur abends, Heizungsluft nur nachts). Verfällt.
  real     Evidenz echter Aktivität (bewiesene Personen). Verfällt und senkt die
           Geister-Wahrscheinlichkeit an dieser Stelle.

Neu in 2.0:
  * Gauß-Kern statt 3x3-Kern und bilineares Auslesen: kein "Verschwinden" an Zellgrenzen.
  * Rechenlast-Stufen 1-3 (Rastergröße, Tageszeit-Fenster, Zeitraffer-Verlauf).
  * Konfidenz je Zelle (wie viel weiß das Modell an dieser Stelle überhaupt?).
  * Selbstprüfung: Fehlentscheidungen (bewiesene Person war unterdrückt / Geist kam
    durch) korrigieren die Karten und passen die Lernstärke an.
  * Tagesstatistik je Sensor, Aufenthalts-Heatmap je Raum, Schnappschüsse (Zeitraffer).
  * Verlustfreie Migration vom 1.x-Format und beim Wechsel der Rechenlast (Umrastern).

Evidenz E wird über p = 1 - exp(-E) in eine Wahrscheinlichkeit überführt. Alle Karten
sind nach oben begrenzt. Das Modell kann ausschließlich die Konfidenz einzelner
Detektionen senken - es erzeugt nie Personen und ändert keine Konfiguration.
"""
from __future__ import annotations

import math
from array import array
from dataclasses import dataclass
from typing import Any

# Rechenlast-Stufen. RAM je Sensor (6 m Reichweite): Stufe 1 ≈ 0,1 MB, 2 ≈ 0,6 MB, 3 ≈ 2,5 MB
LEVELS: dict[int, dict[str, float]] = {
    1: {"cell": 0.25, "slots": 1, "heat": 0.25, "snap_h": 24, "snap_keep": 14, "view": 0.25},
    2: {"cell": 0.15, "slots": 4, "heat": 0.20, "snap_h": 6, "snap_keep": 28, "view": 0.18},
    3: {"cell": 0.10, "slots": 8, "heat": 0.10, "snap_h": 2, "snap_keep": 84, "view": 0.12},
}
DEFAULT_LEVEL = 2
SIGMA_M = 0.2            # m räumliche Verallgemeinerung (unabhängig von der Rastergröße)
CAL_CAP = 5.0
GHOST_CAP = 3.0
REAL_CAP = 5.0
EPS = 0.004
MAX_CELLS = 250_000      # Sicherung je Ebene (RAM-Obergrenze, auch bei 20 m Reichweite)
SNAP_CELL = 0.25
DAILY_KEEP = 30
HEAT_HALF_LIFE_D = 30.0
CELL = LEVELS[1]["cell"]  # Kompatibilität (1.x)


def _prob(e: float) -> float:
    return 1.0 - math.exp(-e) if e > 0 else 0.0


def _zeros(n: int) -> array:
    return array("f", bytes(4 * n))


def _pack(arr: array, digits: int = 3) -> dict[str, list]:
    idx: list[int] = []
    val: list[float] = []
    for i, v in enumerate(arr):
        if v >= EPS:
            idx.append(i)
            val.append(round(v, digits))
    return {"i": idx, "v": val}


def _unpack(d: Any, n: int) -> array:
    out = _zeros(n)
    if isinstance(d, dict) and isinstance(d.get("i"), list):
        for i, v in zip(d.get("i") or [], d.get("v") or []):
            try:
                i = int(i)
                if 0 <= i < n:
                    out[i] = float(v)
            except (TypeError, ValueError):
                continue
    elif isinstance(d, dict):  # 1.x: {"idx": wert}
        for k, v in d.items():
            try:
                i = int(k)
                if 0 <= i < n:
                    out[i] = float(v)
            except (TypeError, ValueError):
                continue
    return out


class _Raster:
    """Dichtes Raster im Sensor-Frame: x in [-range, range], y in [0, range]."""

    def __init__(self, range_m: float, cell: float) -> None:
        self.range_m = float(range_m)
        self.cell = float(cell)
        while math.ceil(2 * self.range_m / self.cell) * math.ceil(self.range_m / self.cell) > MAX_CELLS:
            self.cell *= 1.25
        self.nx = max(1, int(math.ceil(2 * self.range_m / self.cell)))
        self.ny = max(1, int(math.ceil(self.range_m / self.cell)))
        self.n = self.nx * self.ny
        r = max(1, int(math.ceil(2.0 * SIGMA_M / self.cell)))
        self._r = r

    def center(self, i: int) -> tuple[float, float]:
        cy, cx = divmod(i, self.nx)
        return ((cx + 0.5) * self.cell - self.range_m, (cy + 0.5) * self.cell)

    def sample(self, layer: array, xs: float, ys: float) -> float:
        """Bilinear ausgelesener Wert (0 außerhalb)."""
        u = (xs + self.range_m) / self.cell - 0.5
        v = ys / self.cell - 0.5
        x0, y0 = math.floor(u), math.floor(v)
        fx, fy = u - x0, v - y0
        nx, ny = self.nx, self.ny
        acc = 0.0
        for dx, dy, w in ((0, 0, (1 - fx) * (1 - fy)), (1, 0, fx * (1 - fy)), (0, 1, (1 - fx) * fy), (1, 1, fx * fy)):
            cx, cy = x0 + dx, y0 + dy
            if w > 0 and 0 <= cx < nx and 0 <= cy < ny:
                acc += layer[cy * nx + cx] * w
        return acc

    def splat(self, layers: list[tuple[array, float]], xs: float, ys: float, amount: float) -> None:
        """Gauß-Kern (Spitze = amount) in eine oder mehrere Ebenen (mit Obergrenze) addieren.
        Negative Beträge (Verlernen) bleiben bei 0 stehen."""
        if amount == 0:
            return
        c0 = int(math.floor((xs + self.range_m) / self.cell))
        r0 = int(math.floor(ys / self.cell))
        r = self._r
        s2 = 2.0 * SIGMA_M * SIGMA_M
        cell, rng, nx, ny = self.cell, self.range_m, self.nx, self.ny
        for cy in range(max(0, r0 - r), min(ny, r0 + r + 1)):
            py = (cy + 0.5) * cell - ys
            for cx in range(max(0, c0 - r), min(nx, c0 + r + 1)):
                px = (cx + 0.5) * cell - rng - xs
                w = math.exp(-(px * px + py * py) / s2)
                if w < 0.02:
                    continue
                i = cy * nx + cx
                for layer, cap in layers:
                    v = layer[i] + amount * w
                    layer[i] = 0.0 if v < EPS else (cap if v > cap else v)

    def scale_disc(self, layers: list[array], xs: float, ys: float, radius: float) -> int:
        """Bereich vergessen: Werte im Kreis auf 0, weicher Rand."""
        c0 = int(math.floor((xs + self.range_m) / self.cell))
        r0 = int(math.floor(ys / self.cell))
        rr = int(math.ceil((radius + self.cell) / self.cell)) + 1
        touched = 0
        for cy in range(max(0, r0 - rr), min(self.ny, r0 + rr + 1)):
            py = (cy + 0.5) * self.cell - ys
            for cx in range(max(0, c0 - rr), min(self.nx, c0 + rr + 1)):
                px = (cx + 0.5) * self.cell - self.range_m - xs
                d = math.hypot(px, py)
                if d > radius + self.cell:
                    continue
                k = 0.0 if d <= radius else (d - radius) / self.cell
                i = cy * self.nx + cx
                for layer in layers:
                    if layer[i]:
                        layer[i] = layer[i] * k if layer[i] * k >= EPS else 0.0
                        touched += 1
        return touched


class SensorMap:
    """Karten eines Sensors."""

    def __init__(self, range_m: float, cell: float = LEVELS[DEFAULT_LEVEL]["cell"], slots: int = 1) -> None:
        self.g = _Raster(range_m, cell)
        self.slots = max(1, int(slots))
        n = self.g.n
        self.cal = _zeros(n)
        self.real = _zeros(n)
        self.ghost = [_zeros(n) for _ in range(self.slots)]
        self.ghost_all = _zeros(n)      # Summe über alle Tageszeit-Fenster
        self.run = _zeros(n)            # laufende Lernkalibrierung
        self.cur_slot = 0

    # ---- Eigenschaften (Kompatibilität)
    @property
    def range_m(self) -> float:
        return self.g.range_m

    @property
    def cell(self) -> float:
        return self.g.cell

    @property
    def nx(self) -> int:
        return self.g.nx

    @property
    def ny(self) -> int:
        return self.g.ny

    def cell_of(self, xs: float, ys: float) -> tuple[int, int] | None:
        cx = int(math.floor((xs + self.g.range_m) / self.g.cell))
        cy = int(math.floor(ys / self.g.cell))
        if 0 <= cx < self.g.nx and 0 <= cy < self.g.ny:
            return cx, cy
        return None

    # ---- Auslesen
    def ghost_value(self, xs: float, ys: float, slot: int | None = None) -> float:
        slot = self.cur_slot if slot is None else slot
        v = self.g.sample(self.ghost[slot % self.slots], xs, ys)
        if self.slots > 1:
            v = max(v, 0.5 * self.g.sample(self.ghost_all, xs, ys) / self.slots)
        return v

    def ghost_prob(self, xs: float, ys: float, slot: int | None = None) -> float:
        """Geister-Wahrscheinlichkeit (Tageszeit-Fenster), abgeschwächt durch echte Aktivität."""
        g = max(_prob(self.g.sample(self.cal, xs, ys)), _prob(self.ghost_value(xs, ys, slot)))
        if g <= 0:
            return 0.0
        r = _prob(self.g.sample(self.real, xs, ys))
        return g * (1.0 - 0.8 * r)

    def real_prob(self, xs: float, ys: float) -> float:
        return _prob(self.g.sample(self.real, xs, ys))

    def confidence(self, xs: float, ys: float) -> float:
        """0 = hier weiß das Modell nichts, 1 = viel gelernt."""
        e = (self.g.sample(self.cal, xs, ys) + self.g.sample(self.real, xs, ys)
             + self.g.sample(self.ghost_all, xs, ys) / self.slots)
        return 1.0 - math.exp(-e / 1.5)

    # ---- Lernen
    def add_ghost(self, xs: float, ys: float, amount: float) -> None:
        self.g.splat([(self.ghost[self.cur_slot % self.slots], GHOST_CAP),
                      (self.ghost_all, GHOST_CAP * self.slots)], xs, ys, amount)

    def add_real(self, xs: float, ys: float, amount: float) -> None:
        self.g.splat([(self.real, REAL_CAP)], xs, ys, amount)

    def unlearn_ghost(self, xs: float, ys: float, amount: float) -> None:
        layers = [(g, GHOST_CAP) for g in self.ghost] + [(self.ghost_all, GHOST_CAP * self.slots)]
        self.g.splat(layers, xs, ys, -amount)
        self.g.splat([(self.cal, CAL_CAP)], xs, ys, -amount * 0.5)

    def forget(self, xs: float, ys: float, radius: float) -> int:
        return self.g.scale_disc([self.cal, self.real, self.ghost_all, *self.ghost], xs, ys, radius)

    def decay(self, factor: float) -> None:
        def dec(arr: array) -> array:
            return array("f", [v * factor if v * factor >= EPS else 0.0 for v in arr])

        self.real = dec(self.real)
        self.ghost = [dec(a) for a in self.ghost]
        self.ghost_all = dec(self.ghost_all)

    def reset(self) -> None:
        n = self.g.n
        self.cal, self.real, self.ghost_all, self.run = _zeros(n), _zeros(n), _zeros(n), _zeros(n)
        self.ghost = [_zeros(n) for _ in range(self.slots)]

    # ---- Statistik
    def counts(self) -> dict[str, int]:
        return {
            "cal_cells": sum(1 for v in self.cal if v >= 0.02),
            "ghost_cells": sum(1 for v in self.ghost_all if v >= 0.02),
            "real_cells": sum(1 for v in self.real if v >= 0.02),
        }

    def memory_bytes(self) -> int:
        return 4 * self.g.n * (4 + self.slots)

    # ---- Persistenz
    def to_dict(self) -> dict:
        return {
            "v": 2, "range": self.g.range_m, "cell": self.g.cell, "slots": self.slots,
            "cal": _pack(self.cal), "real": _pack(self.real), "ghost": [_pack(g) for g in self.ghost],
        }

    @classmethod
    def from_dict(cls, data: Any, range_m: float, cell: float | None = None, slots: int = 1) -> "SensorMap":
        """Lädt Karten; passt das Raster nicht (Reichweite/Rechenlast geändert, 1.x-Format),
        wird bilinear umgerastert statt neu gelernt."""
        cell = cell or LEVELS[DEFAULT_LEVEL]["cell"]
        m = cls(range_m=range_m, cell=cell, slots=slots)
        if not isinstance(data, dict) or not data:
            return m
        try:
            src_range = float(data.get("range", range_m))
            src_cell = float(data.get("cell", CELL))
        except (TypeError, ValueError):
            return m
        if data.get("v") == 2:
            src_slots = max(1, int(data.get("slots") or 1))
            ghosts = data.get("ghost") or []
        else:  # 1.x: eine Geister-Ebene, Zellen à 0,25 m
            src_slots = 1
            ghosts = [data.get("ghost")]
        src = _Raster(src_range, src_cell)
        if abs(src.cell - src_cell) > 1e-9:
            return m  # unplausibel groß -> neu lernen
        cal = _unpack(data.get("cal"), src.n)
        real = _unpack(data.get("real"), src.n)
        gl = [_unpack(g, src.n) for g in ghosts] or [_zeros(src.n)]
        while len(gl) < src_slots:
            gl.append(_zeros(src.n))
        same = abs(src.range_m - m.g.range_m) < 1e-9 and abs(src.cell - m.g.cell) < 1e-9
        if same:
            m.cal, m.real = cal, real
        else:
            m.cal = _resample(src, cal, m.g)
            m.real = _resample(src, real, m.g)
        for k in range(m.slots):
            hour = (k + 0.5) * 24.0 / m.slots
            sk = int(hour / (24.0 / src_slots)) % src_slots
            m.ghost[k] = array("f", gl[sk]) if same else _resample(src, gl[sk], m.g)
        m.ghost_all = _zeros(m.g.n)
        for g in m.ghost:
            for i, v in enumerate(g):
                if v:
                    m.ghost_all[i] += v
        return m


def _resample(src: _Raster, layer: array, dst: _Raster) -> array:
    out = _zeros(dst.n)
    if not any(v >= EPS for v in layer):
        return out
    for i in range(dst.n):
        xs, ys = dst.center(i)
        v = src.sample(layer, xs, ys)
        if v >= EPS:
            out[i] = v
    return out


class HeatMap:
    """Aufenthalts-Heatmap eines Raums (Raum-Koordinaten, Sekunden mit Verfall)."""

    def __init__(self, bbox: tuple[float, float, float, float], res: float) -> None:
        x0, y0, x1, y1 = bbox
        self.x0, self.y0, self.res = x0 - 0.5, y0 - 0.5, res
        self.nx = max(1, int(math.ceil((x1 - x0 + 1.0) / res)))
        self.ny = max(1, int(math.ceil((y1 - y0 + 1.0) / res)))
        while self.nx * self.ny > MAX_CELLS:
            self.res *= 1.25
            self.nx = max(1, int(math.ceil((x1 - x0 + 1.0) / self.res)))
            self.ny = max(1, int(math.ceil((y1 - y0 + 1.0) / self.res)))
        self.arr = _zeros(self.nx * self.ny)
        self.bbox = tuple(bbox)
        self.req = res

    def add(self, x: float, y: float, amount: float) -> None:
        u = (x - self.x0) / self.res - 0.5
        v = (y - self.y0) / self.res - 0.5
        x0, y0 = math.floor(u), math.floor(v)
        fx, fy = u - x0, v - y0
        for dx, dy, w in ((0, 0, (1 - fx) * (1 - fy)), (1, 0, fx * (1 - fy)), (0, 1, (1 - fx) * fy), (1, 1, fx * fy)):
            cx, cy = x0 + dx, y0 + dy
            if 0 <= cx < self.nx and 0 <= cy < self.ny:
                self.arr[cy * self.nx + cx] += amount * w

    def sample(self, x: float, y: float) -> float:
        u = (x - self.x0) / self.res - 0.5
        v = (y - self.y0) / self.res - 0.5
        x0, y0 = math.floor(u), math.floor(v)
        fx, fy = u - x0, v - y0
        acc = 0.0
        for dx, dy, w in ((0, 0, (1 - fx) * (1 - fy)), (1, 0, fx * (1 - fy)), (0, 1, (1 - fx) * fy), (1, 1, fx * fy)):
            cx, cy = x0 + dx, y0 + dy
            if 0 <= cx < self.nx and 0 <= cy < self.ny:
                acc += self.arr[cy * self.nx + cx] * w
        return acc

    def forget(self, x: float, y: float, radius: float) -> None:
        for cy in range(self.ny):
            yy = self.y0 + (cy + 0.5) * self.res
            if abs(yy - y) > radius + self.res:
                continue
            for cx in range(self.nx):
                xx = self.x0 + (cx + 0.5) * self.res
                if math.hypot(xx - x, yy - y) <= radius:
                    self.arr[cy * self.nx + cx] = 0.0

    def decay(self, factor: float) -> None:
        self.arr = array("f", [v * factor if v * factor >= 0.05 else 0.0 for v in self.arr])

    def to_dict(self) -> dict:
        return {"bbox": list(self.bbox), "res": self.res, "nx": self.nx, "ny": self.ny, "x0": self.x0, "y0": self.y0,
                "a": _pack(self.arr, 1)}

    @classmethod
    def from_dict(cls, data: Any, bbox: tuple[float, float, float, float], res: float) -> "HeatMap":
        h = cls(bbox, res)
        if not isinstance(data, dict):
            return h
        try:
            old = cls(tuple(data["bbox"]), float(data["res"]))
            old.arr = _unpack(data.get("a"), old.nx * old.ny)
        except (KeyError, TypeError, ValueError):
            return h
        if old.nx == h.nx and old.ny == h.ny and abs(old.res - h.res) < 1e-9 and abs(old.x0 - h.x0) < 1e-9 \
                and abs(old.y0 - h.y0) < 1e-9:
            h.arr = old.arr
            return h
        for cy in range(h.ny):
            for cx in range(h.nx):
                v = old.sample(h.x0 + (cx + 0.5) * h.res, h.y0 + (cy + 0.5) * h.res)
                if v > 0.05:
                    h.arr[cy * h.nx + cx] = v * (h.res / old.res) ** 2
        return h


@dataclass
class LearnRates:
    """Lernraten (Multiplikator über die Auswahl langsam/normal/schnell)."""
    factor: float = 1.0
    half_life_days: float = 14.0


class GhostModel:
    def __init__(self, level: int = DEFAULT_LEVEL) -> None:
        self.level = level if level in LEVELS else DEFAULT_LEVEL
        self.maps: dict[str, SensorMap] = {}
        self.rates = LearnRates()
        self.slot = 0
        self.day = ""
        # Selbstprüfung: fp = bewiesene Person war vom Modell unterdrückt, fn = Geist kam
        # als Person durch, tp = Geist vom Modell abgefangen; bias = adaptive Lernstärke
        self.check: dict[str, float] = {"fp": 0, "fn": 0, "tp": 0, "bias": 1.0}
        self.daily: dict[str, dict[str, list[float]]] = {}
        self.heat: dict[str, HeatMap] = {}
        self.snaps: list[dict] = []
        self.last_snap = 0.0
        self.warned: dict[str, str] = {}
        self.slot_hour = 12.0
        self._heat_raw: dict = {}

    # ---- Parameter
    @property
    def p(self) -> dict[str, float]:
        return LEVELS[self.level]

    @property
    def slots(self) -> int:
        return int(self.p["slots"])

    def set_level(self, level: int) -> None:
        level = level if level in LEVELS else DEFAULT_LEVEL
        if level == self.level:
            return
        self.level = level
        for sid, m in list(self.maps.items()):
            self.maps[sid] = SensorMap.from_dict(m.to_dict(), m.range_m, self.p["cell"], self.slots)
        self.set_clock_slot(self.slot_hour)
        for rid, h in list(self.heat.items()):
            self.heat[rid] = HeatMap.from_dict(h.to_dict(), h.bbox, self.p["heat"])

    def set_clock_slot(self, hour: float) -> None:
        self.slot_hour = hour
        self.slot = int((hour % 24.0) * self.slots / 24.0) % self.slots
        for m in self.maps.values():
            m.cur_slot = self.slot

    def set_day(self, day: str) -> None:
        self.day = day

    def ensure(self, sensor_id: str, range_m: float) -> SensorMap:
        m = self.maps.get(sensor_id)
        if m is None:
            m = SensorMap(range_m=range_m, cell=self.p["cell"], slots=self.slots)
            self.maps[sensor_id] = m
        elif abs(m.range_m - range_m) > 1e-6:
            m = SensorMap.from_dict(m.to_dict(), range_m, self.p["cell"], self.slots)
            self.maps[sensor_id] = m
        m.cur_slot = self.slot
        return m

    def drop_unknown(self, sensor_ids: set[str]) -> None:
        for sid in list(self.maps):
            if sid not in sensor_ids:
                del self.maps[sid]
        for sid in list(self.daily):
            if sid not in sensor_ids:
                del self.daily[sid]

    # ---- Online-Lernen
    def learn_ghost(self, sensor_id: str, xs: float, ys: float, weight: float) -> None:
        m = self.maps.get(sensor_id)
        if m is None:
            return
        # Schutz vor "Vergiftung": an Stellen mit klar echter Aktivität nichts lernen
        if m.real_prob(xs, ys) > 0.5:
            return
        m.add_ghost(xs, ys, 0.5 * weight * self.rates.factor * self.check["bias"])

    def learn_real(self, sensor_id: str, xs: float, ys: float, dt: float) -> None:
        m = self.maps.get(sensor_id)
        if m is None:
            return
        m.add_real(xs, ys, (dt / 30.0) * self.rates.factor)

    # ---- Selbstprüfung
    def feedback_fp(self, sensor_id: str, xs: float, ys: float) -> None:
        """Bewiesene Person war vom Modell gebremst: Geister-Evidenz dort abbauen."""
        m = self.maps.get(sensor_id)
        if m is not None:
            m.unlearn_ghost(xs, ys, 0.8)
        self.check["fp"] += 1
        self.check["bias"] = max(0.6, self.check["bias"] * 0.97)

    def feedback_fn(self, sensor_id: str, xs: float, ys: float) -> None:
        """Geist wurde kurz als Person gezählt: stärker lernen."""
        self.learn_ghost(sensor_id, xs, ys, 0.8)
        self.check["fn"] += 1
        self.check["bias"] = min(1.4, self.check["bias"] * 1.02)

    def feedback_tp(self) -> None:
        self.check["tp"] += 1

    def precision(self) -> float | None:
        tp, fp, fn = self.check["tp"], self.check["fp"], self.check["fn"]
        total = tp + fp + fn
        return None if total < 5 else round(tp / total, 3)

    def decay(self, elapsed_s: float) -> None:
        hl = max(0.5, self.rates.half_life_days) * 86400.0
        factor = 0.5 ** (elapsed_s / hl)
        for m in self.maps.values():
            m.decay(factor)
        hf = 0.5 ** (elapsed_s / (HEAT_HALF_LIFE_D * 86400.0))
        for h in self.heat.values():
            h.decay(hf)
        # Lernstärke kehrt langsam zu 1 zurück
        self.check["bias"] += (1.0 - self.check["bias"]) * (1.0 - factor)

    # ---- Statistik je Tag
    def count(self, sensor_id: str, key: int, amount: float = 1.0) -> None:
        if not self.day:
            return
        days = self.daily.setdefault(sensor_id, {})
        rec = days.get(self.day)
        if rec is None:
            rec = days[self.day] = [0.0, 0.0, 0.0]   # Geister, Tracks, Personen-Sekunden
            for old in sorted(days)[:-DAILY_KEEP]:
                del days[old]
        rec[key] += amount

    def rate_alarm(self, sensor_id: str, min_events: int = 30, factor: float = 3.0) -> tuple[int, float] | None:
        """Heute ungewöhnlich viele Geister? -> (heute, Median der Vortage)."""
        days = self.daily.get(sensor_id) or {}
        today = days.get(self.day)
        prev = [v[0] for d, v in sorted(days.items()) if d != self.day][-7:]
        if today is None or len(prev) < 4:
            return None
        med = sorted(prev)[len(prev) // 2]
        if today[0] >= max(min_events, factor * max(med, 1.0)):
            return int(today[0]), med
        return None

    # ---- Aufenthalte
    def heat_for(self, room_id: str, bbox: tuple[float, float, float, float]) -> HeatMap:
        h = self.heat.get(room_id)
        bbox = tuple(round(v, 3) for v in bbox)
        if h is None or h.bbox != bbox or abs(h.req - self.p["heat"]) > 1e-9:
            h = HeatMap.from_dict(h.to_dict() if h else None, bbox, self.p["heat"])
            self.heat[room_id] = h
        return h

    def drop_rooms(self, room_ids: set[str]) -> None:
        for rid in list(self.heat):
            if rid not in room_ids:
                del self.heat[rid]

    # ---- Schnappschüsse (Zeitraffer)
    def maybe_snapshot(self, ts: float, force: bool = False) -> bool:
        if not force and ts - self.last_snap < self.p["snap_h"] * 3600:
            return False
        maps = {}
        for sid, m in self.maps.items():
            g = _Raster(m.range_m, SNAP_CELL)
            gh, re = _zeros(g.n), _zeros(g.n)
            any_v = False
            for i in range(g.n):
                xs, ys = g.center(i)
                pg = max(_prob(m.g.sample(m.cal, xs, ys)), max(_prob(m.g.sample(gk, xs, ys)) for gk in m.ghost))
                pr = _prob(m.g.sample(m.real, xs, ys))
                if pg >= 0.02:
                    gh[i] = pg
                    any_v = True
                if pr >= 0.02:
                    re[i] = pr
                    any_v = True
            if any_v:
                maps[sid] = {"range": m.range_m, "cell": SNAP_CELL, "g": _pack(gh, 2), "r": _pack(re, 2)}
        self.last_snap = ts
        if not maps:
            return False
        self.snaps.append({"ts": round(ts), "maps": maps})
        keep = int(self.p["snap_keep"])
        if len(self.snaps) > keep:
            self.snaps = self.snaps[-keep:]
        return True

    # ---- Kalibrierung
    def cal_begin(self) -> None:
        for m in self.maps.values():
            m.run = _zeros(m.g.n)

    def cal_add(self, sensor_id: str, xs: float, ys: float, dwell_s: float) -> None:
        m = self.maps.get(sensor_id)
        if m is None:
            return
        m.g.splat([(m.run, CAL_CAP)], xs, ys, dwell_s / 10.0)

    def cal_commit(self) -> int:
        cells = 0
        for m in self.maps.values():
            m.cal = array("f", [v if v >= 0.02 else 0.0 for v in m.run])
            m.run = _zeros(m.g.n)
            cells += sum(1 for v in m.cal if v > 0)
        return cells

    def cal_abort(self) -> None:
        for m in self.maps.values():
            m.run = _zeros(m.g.n)

    def reset(self) -> None:
        for m in self.maps.values():
            m.reset()
        self.check = {"fp": 0, "fn": 0, "tp": 0, "bias": 1.0}
        self.heat = {}
        self.snaps = []
        self.last_snap = 0.0

    # ---- Ausgabe
    def stats(self) -> dict:
        return {sid: m.counts() for sid, m in self.maps.items()}

    def summary(self) -> dict:
        mem = sum(m.memory_bytes() for m in self.maps.values()) + sum(4 * h.nx * h.ny for h in self.heat.values())
        return {
            "level": self.level, "slots": self.slots, "slot": self.slot, "cell": self.p["cell"],
            "memory_kb": round(mem / 1024), "check": {k: round(v, 3) for k, v in self.check.items()},
            "precision": self.precision(), "snapshots": len(self.snaps),
            "daily": {sid: {d: [round(x) for x in v] for d, v in sorted(days.items())[-14:]} for sid, days in self.daily.items()},
            "sensors": self.stats(),
        }

    def to_dict(self) -> dict:
        return {
            "version": 2, "level": self.level,
            "maps": {sid: m.to_dict() for sid, m in self.maps.items()},
            "check": dict(self.check), "daily": self.daily,
            "heat": {rid: h.to_dict() for rid, h in self.heat.items()},
            "snaps": self.snaps, "last_snap": self.last_snap, "warned": self.warned,
        }

    def load(self, data: dict | None, ranges: dict[str, float]) -> None:
        """Lädt 2.x direkt bzw. 1.x ({"maps": {sid: …}} oder nur die Karten) mit Umrasterung."""
        data = data if isinstance(data, dict) else {}
        if data.get("version") == 2:
            maps = data.get("maps") or {}
            chk = data.get("check") or {}
            self.check = {"fp": float(chk.get("fp", 0)), "fn": float(chk.get("fn", 0)),
                          "tp": float(chk.get("tp", 0)), "bias": min(1.4, max(0.6, float(chk.get("bias", 1.0))))}
            self.daily = {str(s): {str(d): [float(x) for x in v][:3] for d, v in (days or {}).items() if isinstance(v, list)}
                          for s, days in (data.get("daily") or {}).items() if isinstance(days, dict)}
            self.snaps = [s for s in (data.get("snaps") or []) if isinstance(s, dict) and "maps" in s]
            self.last_snap = float(data.get("last_snap") or 0.0)
            self.warned = dict(data.get("warned") or {})
            self._heat_raw = data.get("heat") or {}
        else:
            maps = data.get("maps", data) if isinstance(data.get("maps", data), dict) else {}
            self._heat_raw = {}
        self.maps = {}
        for sid, rng in ranges.items():
            m = SensorMap.from_dict(maps.get(sid, {}), rng, self.p["cell"], self.slots)
            m.cur_slot = self.slot
            self.maps[sid] = m

    def restore_heat(self, rooms: dict[str, tuple[float, float, float, float]]) -> None:
        raw = getattr(self, "_heat_raw", {}) or {}
        for rid, bbox in rooms.items():
            bbox = tuple(round(v, 3) for v in bbox)
            self.heat[rid] = HeatMap.from_dict(raw.get(rid), bbox, self.p["heat"])
        self._heat_raw = {}
