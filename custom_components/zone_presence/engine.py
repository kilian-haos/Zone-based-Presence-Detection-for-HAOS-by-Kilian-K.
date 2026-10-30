"""Zone Presence Detection – Engine (reines Python, ohne Home-Assistant-Abhängigkeit).

Pipeline je Berechnung:
  1. Rohwerte je Sensor-Slot (x/y) -> Gates: kein Target (0/0), eingefroren
     (Stuck), Presence-Sensor frei.
  2. Transformation Sensor-Frame -> Raum (Platzierung + Kalibrier-Offset).
  3. Wand-Filter: knapp außerhalb -> an die Wand klemmen, weit außerhalb -> verwerfen.
  4. Tracking je Slot (Sprung-Erkennung im Sensor-Frame), Sitz-/Liege-Erkennung,
     zeitkonstante Glättung (stark gedämpft im Sitz-/Liege-Modus).
  5. Geisterfilter: Konfidenz aus Alter, Weg, Bestätigung durch zweiten Sensor,
     gelernter Geister-/Aktivitätskarte, Wandnähe. Hysterese, "bewiesene" Tracks.
  6. Personen: Zusammenfassen über Sensoren (mit Hysterese, max. 1 Track je Sensor).
  7. Zonen: Zugehörigkeit mit Austritts-Hysterese (größer im Sitz-/Liege-Modus),
     Personenanzahl, Nachlaufzeit (Off-Delay).
  8. Lernen: Online (Geister/echte Aktivität) und optionale Kalibrierung.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field, fields
from typing import Any

from .geometry import (
    centroid,
    closest_on_poly,
    dist,
    dist_to_poly_edge,
    point_in_poly,
    poly_valid,
    sensor_to_room,
)
from .ghost_model import GhostModel

LEARN_FACTORS = {"slow": 0.5, "normal": 1.0, "fast": 2.0}
CAL_REAL_DISP = 1.2      # m: Track mit mehr Weg gilt in der Kalibrierung als echte Person
PROVEN_DISP = 1.0        # m: Weg, ab dem ein Track als echte Person "bewiesen" ist
PROVEN_CORR_S = 2.0      # s: Bestätigung durch zweiten Sensor, ab der "bewiesen"
CONF_ON = 0.6
CONF_OFF = 0.3
MERGE_SPLIT_FACTOR = 1.3


# ============================================================ Einstellungen
@dataclass
class Settings:
    off_delay: float = 10.0          # s Nachlauf der Zonen
    stuck_timeout: float = 3.0       # s ohne Rohwert-Änderung -> Target eingefroren
    still_delay: float = 5.0         # s bis Sitz-/Liege-Modus
    still_radius: float = 0.7        # m Bewegungsradius im Sitz-/Liege-Modus
    tau_move: float = 0.25           # s Glättung in Bewegung
    tau_still: float = 2.5           # s Glättung im Sitz-/Liege-Modus
    merge_distance: float = 0.9      # m Zusammenfassen zweier Sensoren
    zone_exit_margin: float = 0.2    # m Austritts-Hysterese der Zonen
    still_exit_margin: float = 0.45  # m Austritts-Hysterese im Sitz-/Liege-Modus
    wall_filter: bool = True         # Targets hinter Wänden verwerfen
    wall_tolerance: float = 1.2      # m bis hierhin an die Wand klemmen statt verwerfen
    max_speed: float = 3.0           # m/s plausible Höchstgeschwindigkeit
    ghost_filter: bool = True
    ghost_strength: int = 50         # 0..100
    confirm_time: float = 1.0        # s Mindestalter neuer Personen
    learning_speed: str = "normal"   # slow | normal | fast
    memory_days: float = 14.0        # Halbwertszeit des Online-Lernens
    cal_max_spread: float = 2.0      # m Auto-Abgleich: max. Abstand der Messpunkte

    _LIMITS = {
        "off_delay": (0, 3600), "stuck_timeout": (0.5, 120), "still_delay": (0, 600),
        "still_radius": (0.05, 3), "tau_move": (0.01, 5), "tau_still": (0.05, 30),
        "merge_distance": (0, 3), "zone_exit_margin": (0, 2), "still_exit_margin": (0, 2),
        "wall_tolerance": (0, 2), "max_speed": (0.5, 15), "ghost_strength": (0, 100),
        "confirm_time": (0, 30), "memory_days": (0.5, 365), "cal_max_spread": (0.2, 10),
    }

    @classmethod
    def from_dict(cls, data: dict | None) -> "Settings":
        s = cls()
        data = data or {}
        for f in fields(cls):
            if f.name.startswith("_") or f.name not in data:
                continue
            cur = getattr(s, f.name)
            val = data[f.name]
            try:
                if isinstance(cur, bool):
                    val = bool(val)
                elif isinstance(cur, int):
                    val = int(round(float(val)))
                elif isinstance(cur, float):
                    val = float(val)
                else:
                    val = str(val)
            except (TypeError, ValueError):
                continue
            lim = cls._LIMITS.get(f.name)
            if lim and not isinstance(val, bool):
                val = type(cur)(min(lim[1], max(lim[0], val)))
            setattr(s, f.name, val)
        if s.learning_speed not in LEARN_FACTORS:
            s.learning_speed = "normal"
        return s

    def as_dict(self) -> dict:
        return {f.name: getattr(self, f.name) for f in fields(self) if not f.name.startswith("_")}


# ============================================================ Konfiguration
@dataclass
class RoomCfg:
    id: str
    name: str
    polygon: list[list[float]]


@dataclass
class SensorCfg:
    id: str
    label: str
    name: str
    color: str
    room: str | None
    pos: list[float]
    rot: float
    flip_x: float
    flip_y: float
    scale: float
    range: float
    half_angle: float
    dx: float
    dy: float
    dr: float
    targets: list[tuple[str, str]]
    presence: str | None

    @property
    def eff_pos(self) -> tuple[float, float]:
        return (self.pos[0] + self.dx, self.pos[1] + self.dy)

    @property
    def eff_rot(self) -> float:
        return self.rot + self.dr

    def to_room(self, xs: float, ys: float) -> tuple[float, float]:
        return sensor_to_room(xs, ys, self.eff_pos, self.eff_rot, self.flip_x, self.flip_y)


@dataclass
class ZoneCfg:
    id: str
    num: int
    room: str | None
    name: str
    color: str
    enabled: bool
    points: list[list[float]]
    off_delay: float | None = None

    @property
    def display_name(self) -> str:
        return f"{self.name} (Zone {self.num})"


def _f(v: Any, default: float) -> float:
    try:
        f = float(v)
        return f if math.isfinite(f) else default
    except (TypeError, ValueError):
        return default


def parse_rooms(raw: list | None) -> dict[str, RoomCfg]:
    out: dict[str, RoomCfg] = {}
    for r in raw or []:
        try:
            rid = str(r["id"])
            poly = [[float(p[0]), float(p[1])] for p in r.get("polygon", [])]
        except (KeyError, TypeError, ValueError, IndexError):
            continue
        if poly_valid(poly):
            out[rid] = RoomCfg(rid, str(r.get("name") or rid), poly)
    return out


def parse_sensor(wiring: dict, geo: dict | None, idx: int) -> SensorCfg | None:
    """wiring = Entitäts-Zuordnung (Options-Flow), geo = Platzierung (Store/Karte)."""
    targets: list[tuple[str, str]] = []
    for t in wiring.get("targets", []):
        if isinstance(t, dict) and t.get("x") and t.get("y"):
            targets.append((str(t["x"]), str(t["y"])))
    if not targets:
        return None  # x/y des ersten Targets sind Pflicht
    geo = geo or {}
    sid = str(wiring["id"])
    pos = geo.get("pos") or [0.0, 0.0]
    off = geo.get("offset") or {}
    return SensorCfg(
        id=sid,
        label=str(geo.get("label") or wiring.get("label") or f"S{idx + 1}"),
        name=str(geo.get("name") or wiring.get("name") or sid),
        color=str(geo.get("color") or wiring.get("color") or "#38bdf8"),
        room=(str(geo["room"]) if geo.get("room") else None),
        pos=[_f(pos[0], 0.0), _f(pos[1], 0.0)],
        rot=_f(geo.get("rot"), 0.0),
        flip_x=-1.0 if _f(geo.get("flip_x", wiring.get("flip_x", 1)), 1) < 0 else 1.0,
        flip_y=-1.0 if _f(geo.get("flip_y", wiring.get("flip_y", 1)), 1) < 0 else 1.0,
        scale=_f(wiring.get("scale"), 0.001) or 0.001,
        range=min(20.0, max(0.5, _f(geo.get("range"), 6.0))),
        half_angle=min(90.0, max(5.0, _f(geo.get("half_angle"), 60.0))),
        dx=_f(off.get("dx"), 0.0), dy=_f(off.get("dy"), 0.0), dr=_f(off.get("dr"), 0.0),
        targets=targets,
        presence=(str(wiring["presence"]) if wiring.get("presence") else None),
    )


def parse_zones(raw: list | None) -> dict[str, ZoneCfg]:
    out: dict[str, ZoneCfg] = {}
    for z in raw or []:
        try:
            zid = str(z["id"])
            pts = [[float(p[0]), float(p[1])] for p in z.get("points", [])]
            num = int(z.get("num") or 0)
        except (KeyError, TypeError, ValueError, IndexError):
            continue
        if not poly_valid(pts) or num <= 0:
            continue
        od = z.get("off_delay")
        out[zid] = ZoneCfg(
            id=zid, num=num, room=(str(z["room"]) if z.get("room") else None),
            name=str(z.get("name") or f"Zone {num}"), color=str(z.get("color") or "#a78bfa"),
            enabled=bool(z.get("enabled", True)), points=pts,
            off_delay=(None if od in (None, "") else max(0.0, _f(od, 0.0))),
        )
    return out


# ============================================================ Laufzeit-Objekte
@dataclass
class RawSlot:
    x: float | None = None
    y: float | None = None
    tx: float = 0.0
    ty: float = 0.0


@dataclass
class Track:
    key: str
    sensor_id: str
    slot: int
    label: str
    born: float
    last: float
    xs: float
    ys: float
    birth_s: tuple[float, float]
    room_raw: tuple[float, float]
    room: tuple[float, float]
    smooth: tuple[float, float]
    avg: tuple[float, float]
    anchor: tuple[float, float]
    anchor_t: float
    still: bool = False
    max_disp: float = 0.0
    out_d: float = 0.0
    conf: float = 0.0
    confirmed: bool = False
    ever_confirmed: bool = False
    proven: bool = False
    corr: bool = False
    corr_time: float = 0.0
    corr_total: float = 0.0
    zones: set[str] = field(default_factory=set)
    sum_xs: float = 0.0
    sum_ys: float = 0.0
    n: int = 0
    cal_buf: dict[tuple[int, int], list[float]] = field(default_factory=dict)
    cal_dwell: float = 0.0


@dataclass
class Person:
    key: str
    tracks: list[Track]
    pos: tuple[float, float]
    room: str | None
    still: bool
    conf: float


@dataclass
class ZoneState:
    on: bool = False
    count: int = 0
    last_raw_on: float = -1e9
    persons: list[str] = field(default_factory=list)


def _sig(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, x))))


# ============================================================ Engine
class Engine:
    def __init__(self, settings: Settings | None = None, model: GhostModel | None = None) -> None:
        self.settings = settings or Settings()
        self.model = model or GhostModel()
        self.learning_enabled = True
        self.rooms: dict[str, RoomCfg] = {}
        self.sensors: dict[str, SensorCfg] = {}
        self.zones: dict[str, ZoneCfg] = {}
        self._entity_map: dict[str, tuple[str, int, str]] = {}
        self._presence_map: dict[str, str] = {}
        self._raw: dict[tuple[str, int], RawSlot] = {}
        self._presence: dict[str, bool | None] = {}
        self.tracks: dict[str, Track] = {}
        self.persons: list[Person] = []
        self.zone_state: dict[str, ZoneState] = {}
        self.room_count: dict[str, int] = {}
        self.rejected: list[dict] = []
        self._merged_pairs: set[tuple[str, str]] = set()
        self._wall_keys: set[str] = set()
        self._last_compute: float | None = None
        self._decay_acc = 0.0
        self.stats = {"rejected_wall": 0, "rejected_filter": 0, "tracks": 0}
        # Kalibrierung
        self.cal_active = False
        self.cal_start = 0.0
        self.cal_end = 0.0
        self.cal_disturbed = 0.0
        self.cal_status = "idle"
        self.cal_result: dict = {}
        self._apply_learn_rates()

    # ---------------------------------------------------------- Konfiguration
    def _apply_learn_rates(self) -> None:
        self.model.rates.factor = LEARN_FACTORS.get(self.settings.learning_speed, 1.0)
        self.model.rates.half_life_days = self.settings.memory_days

    def set_settings(self, settings: Settings) -> None:
        self.settings = settings
        self._apply_learn_rates()

    def set_config(self, rooms: dict[str, RoomCfg], sensors: dict[str, SensorCfg], zones: dict[str, ZoneCfg]) -> None:
        old_sensors = self.sensors
        self.rooms, self.sensors, self.zones = rooms, sensors, zones
        self._entity_map = {}
        self._presence_map = {}
        for s in sensors.values():
            for i, (ex, ey) in enumerate(s.targets):
                self._entity_map[ex] = (s.id, i, "x")
                self._entity_map[ey] = (s.id, i, "y")
            if s.presence:
                self._presence_map[s.presence] = s.id
            self.model.ensure(s.id, s.range)
        self.model.drop_unknown(set(sensors))
        # Tracks entfernter Sensoren/Slots verwerfen, Tracks verschobener Sensoren
        # mitverschieben (Live-Kalibrierung: Personen gleiten mit statt neu zu starten)
        for key, tr in list(self.tracks.items()):
            s = sensors.get(tr.sensor_id)
            if s is None or tr.slot >= len(s.targets):
                del self.tracks[key]
                continue
            o = old_sensors.get(tr.sensor_id)
            if o is not None and (o.eff_pos != s.eff_pos or o.eff_rot != s.eff_rot
                                  or o.flip_x != s.flip_x or o.flip_y != s.flip_y):
                new = s.to_room(tr.xs, tr.ys)
                ddx, ddy = new[0] - tr.room_raw[0], new[1] - tr.room_raw[1]
                for attr in ("room_raw", "room", "smooth", "avg", "anchor"):
                    p = getattr(tr, attr)
                    setattr(tr, attr, (p[0] + ddx, p[1] + ddy))
        for key in list(self._raw):
            s = sensors.get(key[0])
            if s is None or key[1] >= len(s.targets):
                del self._raw[key]
        for zid in list(self.zone_state):
            if zid not in zones:
                del self.zone_state[zid]
        for zid in zones:
            self.zone_state.setdefault(zid, ZoneState())
        for tr in self.tracks.values():
            tr.zones &= set(zones)

    @property
    def watched_entities(self) -> list[str]:
        return list(self._entity_map) + list(self._presence_map)

    # ---------------------------------------------------------- Eingang
    def ingest(self, entity_id: str, state: str | None, now: float) -> bool:
        """Neuer Zustand einer beobachteten Entität. Gibt True zurück, wenn relevant."""
        if entity_id in self._presence_map:
            sid = self._presence_map[entity_id]
            self._presence[sid] = True if state == "on" else (False if state == "off" else None)
            return True
        m = self._entity_map.get(entity_id)
        if m is None:
            return False
        sid, slot, axis = m
        raw = self._raw.setdefault((sid, slot), RawSlot())
        val: float | None
        try:
            val = float(state) if state not in (None, "", "unknown", "unavailable") else None
            if val is not None and not math.isfinite(val):
                val = None
        except (TypeError, ValueError):
            val = None
        if axis == "x":
            if val != raw.x:
                raw.x, raw.tx = val, now
        elif val != raw.y:
            raw.y, raw.ty = val, now
        return True

    # ---------------------------------------------------------- Hauptberechnung
    def compute(self, now: float) -> set[str]:
        """Berechnet alles neu. Gibt die IDs geänderter Zonen/Räume zurück
        (Präfix 'z:' bzw. 'r:')."""
        st = self.settings
        dt = 0.0 if self._last_compute is None else max(0.0, min(2.0, now - self._last_compute))
        self._last_compute = now
        self.rejected = []
        seen: set[str] = set()

        for s in self.sensors.values():
            pres = self._presence.get(s.id)
            pres_ok = s.presence is None or pres is not False
            room = self.rooms.get(s.room) if s.room else None
            for i in range(len(s.targets)):
                key = f"{s.id}:{i}"
                raw = self._raw.get((s.id, i))
                valid = raw is not None and raw.x is not None and raw.y is not None and not (raw.x == 0 and raw.y == 0)
                tr = self.tracks.get(key)
                if not valid:
                    self._wall_keys.discard(key)
                    if tr:
                        self._end_track(tr, "gone", now)
                    continue
                stuck = now - max(raw.tx, raw.ty) > st.stuck_timeout
                if stuck or not pres_ok:
                    if tr:
                        self._end_track(tr, "stuck" if stuck else "presence", now)
                    continue
                xs, ys = raw.x * s.scale, raw.y * s.scale
                p_raw = s.to_room(xs, ys)
                p = p_raw
                out_d = 0.0
                if room is not None and st.wall_filter and not point_in_poly(p[0], p[1], room.polygon):
                    q, d = closest_on_poly(p, room.polygon)
                    if d > st.wall_tolerance:
                        if key not in self._wall_keys:  # Ereignisse zählen, nicht Messungen
                            self._wall_keys.add(key)
                            self.stats["rejected_wall"] += 1
                        self.rejected.append({"x": p[0], "y": p[1], "s": s.id, "r": "wall"})
                        if self.cal_active:
                            self.model.cal_add(s.id, xs, ys, dt)
                        if tr:
                            self._end_track(tr, "wall", now)
                        continue
                    # leicht nach innen setzen, damit die Raum-Zugehörigkeit eindeutig ist
                    c = centroid(room.polygon)
                    v = (c[0] - q[0], c[1] - q[1])
                    vl = math.hypot(*v) or 1.0
                    p = (q[0] + v[0] / vl * 0.02, q[1] + v[1] / vl * 0.02)
                    out_d = d
                self._wall_keys.discard(key)
                # Sprung-Erkennung im Sensor-Frame (unabhängig von Platzierung/Offsets)
                if tr is not None:
                    gap = max(0.1, now - tr.last)
                    if math.hypot(xs - tr.xs, ys - tr.ys) > st.max_speed * gap + 0.5:
                        self._end_track(tr, "jump", now)
                        tr = None
                if tr is None:
                    tr = Track(
                        key=key, sensor_id=s.id, slot=i, label=f"{s.label}T{i + 1}", born=now, last=now,
                        xs=xs, ys=ys, birth_s=(xs, ys), room_raw=p_raw, room=p, smooth=p, avg=p_raw,
                        anchor=p, anchor_t=now,
                    )
                    self.tracks[key] = tr
                    self.stats["tracks"] += 1
                self._update_track(tr, s, xs, ys, p_raw, p, out_d, now)
                seen.add(key)

        # Tracks ohne Update (Sensor nicht mehr vorhanden o. ä.)
        for key, tr in list(self.tracks.items()):
            if key not in seen:
                self._end_track(tr, "gone", now)

        self._corroborate(dt)
        self._confidence_and_learning(dt)
        if self.cal_active:
            self._calibration_step(now, dt)
        self._build_persons()
        changed = self._zones_and_rooms(now)

        self._decay_acc += dt
        if self._decay_acc >= 60.0:
            if self.learning_enabled:
                self.model.decay(self._decay_acc)
            self._decay_acc = 0.0
        return changed

    def _update_track(self, tr: Track, s: SensorCfg, xs: float, ys: float,
                      p_raw: tuple[float, float], p: tuple[float, float], out_d: float, now: float) -> None:
        st = self.settings
        dtu = max(0.0, min(2.0, now - tr.last))
        tr.last = now
        tr.xs, tr.ys = xs, ys
        tr.room_raw, tr.room, tr.out_d = p_raw, p, out_d
        tr.max_disp = max(tr.max_disp, math.hypot(xs - tr.birth_s[0], ys - tr.birth_s[1]))
        tr.sum_xs += xs
        tr.sum_ys += ys
        tr.n += 1
        # Sitz-/Liege-Erkennung
        if dist(p, tr.anchor) > st.still_radius:
            tr.anchor, tr.anchor_t, tr.still = p, now, False
        elif now - tr.anchor_t >= st.still_delay:
            tr.still = True
        # zeitkonstante Glättung (unabhängig von der Abtastrate)
        tau = st.tau_still if tr.still else st.tau_move
        a = 1.0 - math.exp(-dtu / tau) if dtu > 0 else (1.0 if tr.n == 1 else 0.0)
        tr.smooth = (tr.smooth[0] + a * (p[0] - tr.smooth[0]), tr.smooth[1] + a * (p[1] - tr.smooth[1]))
        b = 1.0 - math.exp(-dtu / 1.0) if dtu > 0 else 0.0
        tr.avg = (tr.avg[0] + b * (p_raw[0] - tr.avg[0]), tr.avg[1] + b * (p_raw[1] - tr.avg[1]))

    def _corroborate(self, dt: float) -> None:
        md = self.settings.merge_distance
        ts = list(self.tracks.values())
        for t in ts:
            t.corr = any(o.sensor_id != t.sensor_id and dist(o.room, t.room) <= md for o in ts)
            if t.corr:
                t.corr_time += dt
                t.corr_total += dt
            else:
                t.corr_time = 0.0

    def _confidence_and_learning(self, dt: float) -> None:
        st = self.settings
        strength = st.ghost_strength / 100.0
        bias = -1.2 - (strength - 0.5) * 1.2
        w_ghost = 4.5 * (0.5 + strength)
        for t in self.tracks.values():
            m = self.model.maps.get(t.sensor_id)
            age = t.last - t.born
            if not st.ghost_filter:
                t.conf = 1.0
                t.confirmed = True
            else:
                g = m.ghost_prob(t.xs, t.ys) if m else 0.0
                r = m.real_prob(t.xs, t.ys) if m else 0.0
                f_age = min(age / st.confirm_time, 1.0) if st.confirm_time > 0 else 1.0
                f_travel = min(t.max_disp / PROVEN_DISP, 1.0)
                f_out = min(t.out_d / st.wall_tolerance, 1.0) if st.wall_tolerance > 0 else 0.0
                logit = bias + 2.6 * f_age + 3.0 * f_travel + 4.0 * (1.0 if t.corr else 0.0) \
                    - w_ghost * g + 0.8 * r - 1.0 * f_out
                t.conf = _sig(logit)
                if not t.confirmed and t.conf >= CONF_ON:
                    t.confirmed = True
                elif t.confirmed and not t.proven and t.conf < CONF_OFF:
                    t.confirmed = False
                    t.zones.clear()
            if t.confirmed:
                t.ever_confirmed = True
                if t.max_disp >= PROVEN_DISP or t.corr_time >= PROVEN_CORR_S:
                    t.proven = True
            # Online-Lernen echter Aktivität
            if self.learning_enabled and t.proven and dt > 0:
                self.model.learn_real(t.sensor_id, t.xs, t.ys, dt)

    def _end_track(self, t: Track, reason: str, now: float) -> None:
        self.tracks.pop(t.key, None)
        age = now - t.born
        if not t.ever_confirmed:
            self.stats["rejected_filter"] += 1
        # Online-Lernen von Geistern: nur natürliches Verschwinden, nie bestätigt,
        # ortsfest, nicht von anderem Sensor gesehen
        if (self.learning_enabled and reason == "gone" and not t.ever_confirmed and age >= 0.5
                and t.max_disp < 0.5 and t.corr_total < 0.5 and t.n > 0):
            self.model.learn_ghost(t.sensor_id, t.sum_xs / t.n, t.sum_ys / t.n, min(age, 10.0) / 10.0)
        if self.cal_active:
            self._cal_flush(t)
        self._merged_pairs = {p for p in self._merged_pairs if t.key not in p}

    # ---------------------------------------------------------- Personen
    def _build_persons(self) -> None:
        st = self.settings
        conf = [t for t in self.tracks.values() if t.confirmed]
        parent = {t.key: t.key for t in conf}
        members: dict[str, set[str]] = {t.key: {t.sensor_id} for t in conf}

        def find(k: str) -> str:
            while parent[k] != k:
                parent[k] = parent[parent[k]]
                k = parent[k]
            return k

        pairs = []
        for i, a in enumerate(conf):
            for b in conf[i + 1:]:
                if a.sensor_id == b.sensor_id:
                    continue
                pk = tuple(sorted((a.key, b.key)))
                limit = st.merge_distance * (MERGE_SPLIT_FACTOR if pk in self._merged_pairs else 1.0)
                d = dist(a.smooth, b.smooth)
                if d <= limit:
                    pairs.append((d, pk))
        pairs.sort()
        merged_now: set[tuple[str, str]] = set()
        for _, (ka, kb) in pairs:
            ra, rb = find(ka), find(kb)
            if ra == rb:
                merged_now.add((ka, kb))
                continue
            if members[ra] & members[rb]:
                continue  # nie zwei Targets desselben Sensors zu einer Person
            parent[rb] = ra
            members[ra] |= members.pop(rb)
            merged_now.add((ka, kb))
        self._merged_pairs = merged_now

        groups: dict[str, list[Track]] = {}
        for t in conf:
            groups.setdefault(find(t.key), []).append(t)
        persons: list[Person] = []
        for ts in groups.values():
            ts.sort(key=lambda t: t.key)
            wsum = x = y = 0.0
            for t in ts:
                s = self.sensors.get(t.sensor_id)
                d = dist(t.room_raw, s.eff_pos) if s else 1.0
                w = 1.0 / max(0.3, d)  # näherer Sensor = genauer
                x += t.smooth[0] * w
                y += t.smooth[1] * w
                wsum += w
            s0 = self.sensors.get(ts[0].sensor_id)
            persons.append(Person(
                key="+".join(t.key for t in ts), tracks=ts, pos=(x / wsum, y / wsum),
                room=s0.room if s0 else None, still=all(t.still for t in ts),
                conf=max(t.conf for t in ts),
            ))
        self.persons = persons

    # ---------------------------------------------------------- Zonen/Räume
    def _zones_and_rooms(self, now: float) -> set[str]:
        st = self.settings
        changed: set[str] = set()
        # Zugehörigkeit je bestätigtem Track mit Austritts-Hysterese
        for t in self.tracks.values():
            if not t.confirmed:
                t.zones.clear()
                continue
            s = self.sensors.get(t.sensor_id)
            for z in self.zones.values():
                if not z.enabled or s is None or z.room != s.room:
                    t.zones.discard(z.id)
                    continue
                inside = point_in_poly(t.smooth[0], t.smooth[1], z.points)
                if inside:
                    t.zones.add(z.id)
                elif z.id in t.zones:
                    margin = st.still_exit_margin if t.still else st.zone_exit_margin
                    if dist_to_poly_edge(t.smooth, z.points) > margin:
                        t.zones.discard(z.id)
        for z in self.zones.values():
            zs = self.zone_state.setdefault(z.id, ZoneState())
            persons = [p for p in self.persons if any(z.id in t.zones for t in p.tracks)]
            count = len(persons)
            names = sorted("+".join(t.label for t in p.tracks) for p in persons)
            prev = (zs.on, zs.count, tuple(zs.persons))
            off_delay = z.off_delay if z.off_delay is not None else st.off_delay
            if count > 0:
                zs.on = True
                zs.last_raw_on = now
            elif zs.on and now - zs.last_raw_on >= off_delay:
                zs.on = False
            zs.count = count
            zs.persons = names
            if prev != (zs.on, zs.count, tuple(zs.persons)):
                changed.add("z:" + z.id)
        counts: dict[str, int] = {rid: 0 for rid in self.rooms}
        for p in self.persons:
            if p.room in counts:
                counts[p.room] += 1
        for rid, c in counts.items():
            if self.room_count.get(rid) != c:
                changed.add("r:" + rid)
        self.room_count = counts
        return changed

    # ---------------------------------------------------------- Kalibrierung (Geistermodell)
    def calibration_start(self, now: float, duration_s: float) -> None:
        self.model.cal_begin()
        for t in self.tracks.values():
            t.cal_buf, t.cal_dwell = {}, 0.0
        self.cal_active = True
        self.cal_start = now
        self.cal_end = now + max(60.0, duration_s)
        self.cal_disturbed = 0.0
        self.cal_status = "running"

    def calibration_abort(self) -> None:
        if self.cal_active:
            self.model.cal_abort()
        self.cal_active = False
        self.cal_status = "aborted"

    def calibration_progress(self, now: float) -> float:
        if not self.cal_active:
            return 1.0 if self.cal_status in ("done", "disturbed") else 0.0
        span = max(1.0, self.cal_end - self.cal_start)
        return max(0.0, min(1.0, (now - self.cal_start) / span))

    def _calibration_step(self, now: float, dt: float) -> None:
        real_present = False
        for t in self.tracks.values():
            if t.max_disp > CAL_REAL_DISP or t.corr_total >= PROVEN_CORR_S:
                real_present = True
                t.cal_buf.clear()
                continue
            m = self.model.maps.get(t.sensor_id)
            if m is None:
                continue
            c = m.cell_of(t.xs, t.ys)
            if c is None:
                continue
            b = t.cal_buf.setdefault(c, [0.0, 0.0, 0.0])
            b[0] += t.xs * dt
            b[1] += t.ys * dt
            b[2] += dt
            t.cal_dwell += dt
        if real_present:
            self.cal_disturbed += dt
        if now >= self.cal_end:
            self.calibration_finish(now)

    def _cal_flush(self, t: Track) -> None:
        if t.max_disp > CAL_REAL_DISP or t.corr_total >= PROVEN_CORR_S:
            t.cal_buf.clear()
            return
        for (_cx, _cy), (sx, sy, dw) in t.cal_buf.items():
            if dw > 0:
                self.model.cal_add(t.sensor_id, sx / dw, sy / dw, dw)
        t.cal_buf.clear()

    def calibration_finish(self, now: float) -> None:
        if not self.cal_active:
            return
        for t in list(self.tracks.values()):
            self._cal_flush(t)
        cells = self.model.cal_commit()
        span = max(1.0, now - self.cal_start)
        ratio = self.cal_disturbed / span
        self.cal_active = False
        self.cal_status = "disturbed" if ratio > 0.15 else "done"
        self.cal_result = {"cells": cells, "disturbed_ratio": round(ratio, 3), "duration_s": round(span)}

    # ---------------------------------------------------------- Auto-Abgleich (Sensor-Offsets)
    def auto_calibrate(self, room_id: str) -> dict:
        """Gleicht die Offsets aller Sensoren eines Raums ab, die gerade dieselbe
        Person sehen. Korrektur nach Distanz verteilt (inverse-Distanz-Konsens)."""
        sensors = {sid: s for sid, s in self.sensors.items() if s.room == room_id}
        by_sensor: dict[str, list[Track]] = {}
        for t in self.tracks.values():
            if t.sensor_id in sensors:
                by_sensor.setdefault(t.sensor_id, []).append(t)
        if len(by_sensor) < 2:
            return {"ok": False, "error": "need_two"}
        allpts = [t.avg for ts in by_sensor.values() for t in ts]
        prelim = centroid(allpts)
        pts = {sid: min(ts, key=lambda t: dist(t.avg, prelim)).avg for sid, ts in by_sensor.items()}
        med = centroid(list(pts.values()))
        kept = [sid for sid, p in pts.items() if dist(p, med) <= self.settings.cal_max_spread]
        if len(kept) < 2:
            return {"ok": False, "error": "spread"}
        d_of = {sid: max(0.2, dist(pts[sid], sensors[sid].eff_pos)) for sid in kept}
        wsum = sum(1.0 / d_of[sid] for sid in kept)
        cx = sum(pts[sid][0] / d_of[sid] for sid in kept) / wsum
        cy = sum(pts[sid][1] / d_of[sid] for sid in kept) / wsum
        result = {}
        for sid in kept:
            s = sensors[sid]
            s.dx += cx - pts[sid][0]
            s.dy += cy - pts[sid][1]
            result[sid] = {"dx": round(s.dx, 4), "dy": round(s.dy, 4)}
        return {"ok": True, "sensors": result, "point": [round(cx, 3), round(cy, 3)]}

    # ---------------------------------------------------------- Ausgabe
    def snapshot(self, debug: bool = True) -> dict:
        r3 = lambda v: round(v, 3)  # noqa: E731
        out = {
            "persons": [
                {
                    "k": p.key, "x": r3(p.pos[0]), "y": r3(p.pos[1]), "still": p.still,
                    "labels": [t.label for t in p.tracks], "sensors": [t.sensor_id for t in p.tracks],
                    "room": p.room, "conf": round(p.conf, 2),
                }
                for p in self.persons
            ],
            "zones": {zid: {"on": zs.on, "count": zs.count} for zid, zs in self.zone_state.items()},
            "rooms": dict(self.room_count),
        }
        if debug:
            out["candidates"] = [
                {"x": r3(t.room[0]), "y": r3(t.room[1]), "s": t.sensor_id, "label": t.label, "conf": round(t.conf, 2)}
                for t in self.tracks.values() if not t.confirmed
            ]
            out["rejected"] = [{"x": r3(r["x"]), "y": r3(r["y"]), "s": r["s"], "r": r["r"]} for r in self.rejected]
        return out
