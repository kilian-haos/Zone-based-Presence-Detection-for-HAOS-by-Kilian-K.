"""Lernender Geisterfilter – leichtgewichtiges statistisches Modell.

Pro Sensor werden drei dünn besetzte Evidenz-Karten im *Sensor-Frame* geführt
(Zellen à 25 cm). Weil die Karten im Sensor-Frame liegen, bleiben sie gültig,
wenn Platzierung oder Kalibrier-Offsets im Dashboard geändert werden.

  cal    Geister-Evidenz aus der einmaligen (Nacht-)Kalibrierung. Kein Verfall.
  ghost  Geister-Evidenz aus dem laufenden Betrieb (unbestätigte, ortsfeste,
         kurzlebige Targets). Verfällt mit Halbwertszeit.
  real   Evidenz echter Aktivität (bestätigte, bewegte oder von mehreren
         Sensoren gesehene Personen). Verfällt mit Halbwertszeit und senkt die
         Geister-Wahrscheinlichkeit an dieser Stelle.

Evidenz E wird über p = 1 - exp(-E) in eine Wahrscheinlichkeit überführt.
Alle Karten sind nach oben begrenzt. Das Modell kann ausschließlich die
Konfidenz einzelner Detektionen senken – es erzeugt nie Personen, ändert keine
Konfiguration und kann jederzeit abgeschaltet oder zurückgesetzt werden.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

CELL = 0.25
CAL_CAP = 5.0
GHOST_CAP = 3.0
REAL_CAP = 5.0
# 3x3-Kern für räumliche Generalisierung
_KERNEL = (
    (0, 0, 1.0),
    (1, 0, 0.35), (-1, 0, 0.35), (0, 1, 0.35), (0, -1, 0.35),
    (1, 1, 0.2), (1, -1, 0.2), (-1, 1, 0.2), (-1, -1, 0.2),
)


def _prob(e: float) -> float:
    return 1.0 - math.exp(-e) if e > 0 else 0.0


@dataclass
class SensorMap:
    range_m: float
    cell: float = CELL
    cal: dict[int, float] = field(default_factory=dict)
    ghost: dict[int, float] = field(default_factory=dict)
    real: dict[int, float] = field(default_factory=dict)
    run: dict[int, float] = field(default_factory=dict)  # laufende Kalibrierung

    @property
    def nx(self) -> int:
        return int(math.ceil(2 * self.range_m / self.cell))

    @property
    def ny(self) -> int:
        return int(math.ceil(self.range_m / self.cell))

    def cell_of(self, xs: float, ys: float) -> tuple[int, int] | None:
        cx = int(math.floor((xs + self.range_m) / self.cell))
        cy = int(math.floor(ys / self.cell))
        if 0 <= cx < self.nx and 0 <= cy < self.ny:
            return cx, cy
        return None

    def _idx(self, cx: int, cy: int) -> int | None:
        if 0 <= cx < self.nx and 0 <= cy < self.ny:
            return cy * self.nx + cx
        return None

    def add(self, layer: dict[int, float], xs: float, ys: float, amount: float, cap: float) -> None:
        c = self.cell_of(xs, ys)
        if c is None or amount <= 0:
            return
        for dx, dy, w in _KERNEL:
            i = self._idx(c[0] + dx, c[1] + dy)
            if i is None:
                continue
            layer[i] = min(cap, layer.get(i, 0.0) + amount * w)

    def value(self, layer: dict[int, float], xs: float, ys: float) -> float:
        c = self.cell_of(xs, ys)
        if c is None:
            return 0.0
        i = self._idx(*c)
        return layer.get(i, 0.0) if i is not None else 0.0

    def ghost_prob(self, xs: float, ys: float) -> float:
        """Geister-Wahrscheinlichkeit, abgeschwächt durch echte Aktivität."""
        g = max(_prob(self.value(self.cal, xs, ys)), _prob(self.value(self.ghost, xs, ys)))
        r = _prob(self.value(self.real, xs, ys))
        return g * (1.0 - 0.8 * r)

    def real_prob(self, xs: float, ys: float) -> float:
        return _prob(self.value(self.real, xs, ys))

    def decay(self, factor: float) -> None:
        for layer in (self.ghost, self.real):
            dead = []
            for k, v in layer.items():
                nv = v * factor
                if nv < 0.01:
                    dead.append(k)
                else:
                    layer[k] = nv
            for k in dead:
                del layer[k]

    def to_dict(self) -> dict:
        def pack(layer: dict[int, float]) -> dict[str, float]:
            return {str(k): round(v, 3) for k, v in layer.items() if v >= 0.01}

        return {
            "range": self.range_m, "cell": self.cell,
            "cal": pack(self.cal), "ghost": pack(self.ghost), "real": pack(self.real),
        }

    @classmethod
    def from_dict(cls, data: dict, range_m: float) -> "SensorMap":
        m = cls(range_m=range_m)
        if not isinstance(data, dict):
            return m
        # Raster passt nicht mehr (z. B. Reichweite geändert) -> neu lernen
        if abs(float(data.get("range", -1)) - range_m) > 1e-6 or abs(float(data.get("cell", -1)) - CELL) > 1e-9:
            return m

        def unpack(d) -> dict[int, float]:
            out: dict[int, float] = {}
            if isinstance(d, dict):
                for k, v in d.items():
                    try:
                        out[int(k)] = float(v)
                    except (TypeError, ValueError):
                        continue
            return out

        m.cal, m.ghost, m.real = unpack(data.get("cal")), unpack(data.get("ghost")), unpack(data.get("real"))
        return m


@dataclass
class LearnRates:
    """Lernraten (Multiplikator über die Auswahl langsam/normal/schnell)."""
    factor: float = 1.0
    half_life_days: float = 14.0


class GhostModel:
    def __init__(self) -> None:
        self.maps: dict[str, SensorMap] = {}
        self.rates = LearnRates()

    def ensure(self, sensor_id: str, range_m: float) -> SensorMap:
        m = self.maps.get(sensor_id)
        if m is None or abs(m.range_m - range_m) > 1e-6:
            m = SensorMap(range_m=range_m)
            self.maps[sensor_id] = m
        return m

    def drop_unknown(self, sensor_ids: set[str]) -> None:
        for sid in list(self.maps):
            if sid not in sensor_ids:
                del self.maps[sid]

    # ---- Online-Lernen ----
    def learn_ghost(self, sensor_id: str, xs: float, ys: float, weight: float) -> None:
        m = self.maps.get(sensor_id)
        if m is None:
            return
        # Schutz vor "Vergiftung": an Stellen mit klar echter Aktivität nichts lernen
        if m.real_prob(xs, ys) > 0.5:
            return
        m.add(m.ghost, xs, ys, 0.5 * weight * self.rates.factor, GHOST_CAP)

    def learn_real(self, sensor_id: str, xs: float, ys: float, dt: float) -> None:
        m = self.maps.get(sensor_id)
        if m is None:
            return
        m.add(m.real, xs, ys, (dt / 30.0) * self.rates.factor, REAL_CAP)

    def decay(self, elapsed_s: float) -> None:
        hl = max(0.5, self.rates.half_life_days) * 86400.0
        factor = 0.5 ** (elapsed_s / hl)
        for m in self.maps.values():
            m.decay(factor)

    # ---- Kalibrierung ----
    def cal_begin(self) -> None:
        for m in self.maps.values():
            m.run = {}

    def cal_add(self, sensor_id: str, xs: float, ys: float, dwell_s: float) -> None:
        m = self.maps.get(sensor_id)
        if m is None:
            return
        m.add(m.run, xs, ys, dwell_s / 10.0, CAL_CAP)

    def cal_commit(self) -> int:
        cells = 0
        for m in self.maps.values():
            m.cal = {k: v for k, v in m.run.items() if v >= 0.02}
            m.run = {}
            cells += len(m.cal)
        return cells

    def cal_abort(self) -> None:
        for m in self.maps.values():
            m.run = {}

    def reset(self) -> None:
        for m in self.maps.values():
            m.cal, m.ghost, m.real, m.run = {}, {}, {}, {}

    def stats(self) -> dict:
        return {
            sid: {"cal_cells": len(m.cal), "ghost_cells": len(m.ghost), "real_cells": len(m.real)}
            for sid, m in self.maps.items()
        }

    def to_dict(self) -> dict:
        return {sid: m.to_dict() for sid, m in self.maps.items()}

    def load(self, data: dict, ranges: dict[str, float]) -> None:
        self.maps = {}
        for sid, rng in ranges.items():
            self.maps[sid] = SensorMap.from_dict((data or {}).get(sid, {}), rng)
