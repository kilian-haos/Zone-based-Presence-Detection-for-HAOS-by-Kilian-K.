"""Laufzeit: verbindet Engine, Speicher, Entitäten, Zeitplan und Live-Daten."""
from __future__ import annotations

import logging
import re
import time
import uuid
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import Any

from homeassistant.components import persistent_notification
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_HOMEASSISTANT_STOP
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import (
    async_call_later,
    async_track_state_change_event,
    async_track_time_change,
    async_track_time_interval,
)
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import (
    CONF_ALLOW_USER_EDIT,
    CONF_SENSORS,
    CONF_SETTINGS,
    DEBOUNCE,
    DEFAULT_CAL_DURATION,
    DEFAULT_CAL_TIME,
    DOMAIN,
    HEARTBEAT,
    MODEL_SAVE_INTERVAL,
    MODEL_STORE_VERSION,
    PUSH_INTERVAL,
    SENSOR_COLORS,
    STORE_VERSION,
    TICK_INTERVAL,
    ZONE_COLORS,
    signal_hub,
    signal_new_entities,
    signal_state,
)
from .engine import Engine, Settings, parse_rooms, parse_sensor, parse_zones
from .geometry import centroid, poly_valid
from .i18n import system_lang, tr

_LOGGER = logging.getLogger(__name__)
# Ab HA 2026.8 wird das übergeordnete Gerät per Geräte-ID angegeben (via_device_id)
_VIA_BY_ID = "via_device_id" in getattr(dr.DeviceInfo, "__optional_keys__", ())
_ID_RE = re.compile(r"^[A-Za-z0-9_\-]{1,40}$")
_TIME_RE = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")

DEFAULT_ROOM_POLY = [[0, 0], [5, 0], [5, 4], [0, 4]]


def _num(v: Any, default: float, lo: float | None = None, hi: float | None = None) -> float:
    try:
        f = float(v)
        if f != f or f in (float("inf"), float("-inf")):
            return default
    except (TypeError, ValueError):
        return default
    if lo is not None:
        f = max(lo, f)
    if hi is not None:
        f = min(hi, f)
    return f


def _clean_poly(raw: Any) -> list[list[float]] | None:
    try:
        poly = [[round(float(p[0]), 3), round(float(p[1]), 3)] for p in raw]
    except (TypeError, ValueError, IndexError):
        return None
    if not poly_valid(poly) or len(poly) > 64:
        return None
    if any(abs(c) > 1000 for p in poly for c in p):
        return None
    return poly


def _clean_str(v: Any, default: str, maxlen: int = 40) -> str:
    s = str(v).strip() if v is not None else ""
    return s[:maxlen] if s else default


def _clean_color(v: Any, default: str) -> str:
    s = str(v or "").strip()
    return s if re.match(r"^#[0-9a-fA-F]{3,8}$", s) else default


def migrate_options_1_2(options: Any) -> dict:
    """Optionen 1.0 -> 1.1: Wandtoleranz-Standard 0,3 -> 1,2 m, Sprache automatisch, Bearbeiten-Freigabe."""
    opts = dict(options or {})
    settings = dict(opts.get(CONF_SETTINGS) or {})
    if settings.get("wall_tolerance") in (None, 0.3):   # nur den alten Standard ersetzen
        settings["wall_tolerance"] = 1.2
    opts[CONF_SETTINGS] = settings
    opts.pop("language", None)
    opts.setdefault(CONF_ALLOW_USER_EDIT, False)
    return opts


class ZonePresenceRuntime:
    """Eine Instanz je Config-Entry."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        self.lang = system_lang(hass)
        self.store: Store[dict] = Store(hass, STORE_VERSION, f"{DOMAIN}.{entry.entry_id}")
        self.model_store: Store[dict] = Store(hass, MODEL_STORE_VERSION, f"{DOMAIN}.{entry.entry_id}.model")
        self.engine = Engine(Settings.from_dict(entry.options.get(CONF_SETTINGS)))
        self.data: dict[str, Any] = {}
        self.zone_ids: set[str] = set()
        self.room_ids: set[str] = set()
        self._unsubs: list[Callable[[], None]] = []
        self._debounce_unsub: Callable[[], None] | None = None
        self._cal_time_unsub: Callable[[], None] | None = None
        self._subscribers: dict[int, tuple[Callable[[dict], None], bool]] = {}
        self._last_push = 0.0
        self._last_snapshot: dict | None = None
        self._last_hub_push = 0.0
        self._last_cal_key: tuple = ()
        self._last_stats = -1

    # ================================================================ Setup
    @property
    def wiring(self) -> list[dict]:
        return list(self.entry.options.get(CONF_SENSORS, []))

    @property
    def allow_user_edit(self) -> bool:
        return bool(self.entry.options.get(CONF_ALLOW_USER_EDIT, False))

    def can_edit(self, user: Any) -> bool:
        """Admins immer; andere Benutzer nur, wenn in den Optionen freigegeben."""
        if user is None:
            return False
        return bool(user.is_admin) or self.allow_user_edit

    def t(self, key: str, **kw: Any) -> str:
        return tr(self.lang, key, **kw)

    async def async_setup(self) -> None:
        raw = await self.store.async_load() or {}
        self.data = self._normalize(raw)
        model_raw = await self.model_store.async_load() or {}

        rooms, sensors, zones = self._parse_all()
        self.engine.model.load(model_raw.get("maps", {}), {sid: s.range for sid, s in sensors.items()})
        self.engine.set_config(rooms, sensors, zones)
        self.engine.learning_enabled = bool(self.data["controls"]["learning"])
        last = self.data.get("cal_last") or {}
        if last.get("status") in ("done", "disturbed", "aborted"):
            self.engine.cal_status = last["status"]
            self.engine.cal_result = {k: last.get(k) for k in ("cells", "disturbed_ratio", "duration_s")}
        self.zone_ids = set(zones)
        self.room_ids = set(rooms)
        self._cleanup_registry()
        self.ensure_devices()
        self.store.async_delay_save(self._data_to_save, 1)

        now = time.monotonic()
        for eid in self.engine.watched_entities:
            st = self.hass.states.get(eid)
            self.engine.ingest(eid, st.state if st else None, now)
        if self.engine.watched_entities:
            self._unsubs.append(
                async_track_state_change_event(self.hass, self.engine.watched_entities, self._on_state)
            )
        self._unsubs.append(async_track_time_interval(self.hass, self._tick, timedelta(seconds=TICK_INTERVAL)))
        self._unsubs.append(
            async_track_time_interval(self.hass, self._save_model_cb, timedelta(seconds=MODEL_SAVE_INTERVAL))
        )
        self._unsubs.append(self.hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STOP, self._on_stop))
        self._schedule_cal_listener()
        self._compute()

    async def async_unload(self) -> None:
        for u in self._unsubs:
            u()
        self._unsubs.clear()
        if self._debounce_unsub:
            self._debounce_unsub()
            self._debounce_unsub = None
        if self._cal_time_unsub:
            self._cal_time_unsub()
            self._cal_time_unsub = None
        self._subscribers.clear()
        await self.model_store.async_save(self._model_to_save())
        await self.store.async_save(self._data_to_save())

    async def _on_stop(self, _event: Event) -> None:
        await self.model_store.async_save(self._model_to_save())

    # ================================================================ Daten
    def _normalize(self, raw: dict) -> dict:
        rooms = []
        for r in raw.get("rooms") or []:
            poly = _clean_poly(r.get("polygon"))
            rid = str(r.get("id") or "")
            if poly and _ID_RE.match(rid):
                rooms.append({"id": rid, "name": _clean_str(r.get("name"), rid), "polygon": poly})
        if not rooms:
            rooms = [{"id": "r1", "name": self.t("room", n=1), "polygon": [list(p) for p in DEFAULT_ROOM_POLY]}]
        controls = {
            "cal_time": DEFAULT_CAL_TIME, "cal_duration": DEFAULT_CAL_DURATION,
            "cal_armed": False, "learning": True,
        }
        controls.update({k: v for k, v in (raw.get("controls") or {}).items() if k in controls})
        if not _TIME_RE.match(str(controls["cal_time"])):
            controls["cal_time"] = DEFAULT_CAL_TIME
        zones = [z for z in (raw.get("zones") or []) if isinstance(z, dict)]
        next_num = int(raw.get("next_zone_num") or 1)
        for z in zones:
            next_num = max(next_num, int(z.get("num") or 0) + 1)
        data = {
            "rooms": rooms,
            "zones": zones,
            "geometry": dict(raw.get("geometry") or {}),
            "controls": controls,
            "next_zone_num": next_num,
            "cal_last": raw.get("cal_last") or {},
        }
        # Standard-Geometrie für neu verdrahtete Sensoren
        for idx, w in enumerate(self.wiring):
            sid = str(w.get("id"))
            if sid not in data["geometry"]:
                data["geometry"][sid] = self._default_geometry(idx, w, rooms[0])
        return data

    def _default_geometry(self, idx: int, wiring: dict, room: dict) -> dict:
        poly = room["polygon"]
        cx = centroid(poly)[0]
        miny = min(p[1] for p in poly)
        return {
            "label": f"S{idx + 1}", "name": wiring.get("name") or f"Sensor {idx + 1}",
            "color": SENSOR_COLORS[idx % len(SENSOR_COLORS)], "room": room["id"],
            "pos": [round(cx + 0.4 * idx, 2), miny], "rot": 0.0, "flip_x": 1, "flip_y": 1,
            "range": 6.0, "half_angle": 60.0, "offset": {"dx": 0.0, "dy": 0.0, "dr": 0.0},
        }

    def _data_to_save(self) -> dict:
        return self.data

    def _model_to_save(self) -> dict:
        return {"maps": self.engine.model.to_dict()}

    def _parse_all(self):
        rooms = parse_rooms(self.data["rooms"])
        sensors = {}
        for idx, w in enumerate(self.wiring):
            s = parse_sensor(w, self.data["geometry"].get(str(w.get("id"))), idx)
            if s is not None:
                if s.room and s.room not in rooms:
                    s.room = None
                sensors[s.id] = s
        zones = parse_zones(self.data["zones"])
        for z in zones.values():
            if z.room and z.room not in rooms:
                z.room = None
        return rooms, sensors, zones

    def _rebuild(self) -> None:
        rooms, sensors, zones = self._parse_all()
        for sid, s in sensors.items():
            self.engine.model.ensure(sid, s.range)
        self.engine.set_config(rooms, sensors, zones)

    # ================================================================ Rechnen
    @callback
    def _on_state(self, event: Event) -> None:
        ns = event.data.get("new_state")
        if self.engine.ingest(event.data["entity_id"], ns.state if ns else None, time.monotonic()):
            if self._debounce_unsub is None:
                self._debounce_unsub = async_call_later(self.hass, DEBOUNCE, self._debounced)

    @callback
    def _debounced(self, _now: datetime) -> None:
        self._debounce_unsub = None
        self._compute()

    @callback
    def _tick(self, _now: datetime) -> None:
        self._compute()

    @callback
    def _compute(self) -> None:
        now = time.monotonic()
        was_active = self.engine.cal_active
        changed = self.engine.compute(now)
        if changed:
            async_dispatcher_send(self.hass, signal_state(self.entry.entry_id), changed)
        if was_active and not self.engine.cal_active:
            self._on_calibration_finished()
        cal_key = (self.engine.cal_active, self.engine.cal_status, self.data["controls"]["cal_armed"])
        st = self.engine.stats
        stats_key = st["rejected_wall"] + st["rejected_filter"]
        if cal_key != self._last_cal_key or (
            (self.engine.cal_active or stats_key != self._last_stats) and now - self._last_hub_push > 15
        ):
            self._last_stats = stats_key
            self._last_cal_key = cal_key
            self._last_hub_push = now
            async_dispatcher_send(self.hass, signal_hub(self.entry.entry_id))
        self._push(now)

    @callback
    def _push(self, now: float, force: bool = False) -> None:
        if not self._subscribers:
            return
        if not force and now - self._last_push < PUSH_INTERVAL:
            return
        snap = self.engine.snapshot(debug=True)
        snap["cal"] = self.calibration_info()
        if not force and snap == self._last_snapshot and now - self._last_push < HEARTBEAT:
            return
        self._last_snapshot = snap
        self._last_push = now
        lean = {k: v for k, v in snap.items() if k not in ("candidates", "rejected")}
        for send, debug in list(self._subscribers.values()):
            try:
                send({"type": "state", **(snap if debug else lean)})
            except Exception:  # noqa: BLE001 - ein defekter Client darf nicht stören
                _LOGGER.debug("Senden an Abonnenten fehlgeschlagen", exc_info=True)

    @callback
    def send_initial(self, send: Callable[[dict], None]) -> None:
        send({"type": "config", **self.config_payload()})
        self._push(time.monotonic(), force=True)

    @callback
    def subscribe(self, send: Callable[[dict], None], debug: bool) -> Callable[[], None]:
        key = id(send)
        self._subscribers[key] = (send, debug)

        @callback
        def _unsub() -> None:
            self._subscribers.pop(key, None)

        return _unsub

    @callback
    def _broadcast_config(self) -> None:
        payload = {"type": "config", **self.config_payload()}
        for send, _debug in list(self._subscribers.values()):
            try:
                send(payload)
            except Exception:  # noqa: BLE001
                _LOGGER.debug("Senden an Abonnenten fehlgeschlagen", exc_info=True)

    # ================================================================ Karte
    def config_payload(self) -> dict:
        sensors = []
        for idx, w in enumerate(self.wiring):
            sid = str(w.get("id"))
            s = self.engine.sensors.get(sid)
            geo = self.data["geometry"].get(sid) or {}
            sensors.append({
                "id": sid,
                "label": geo.get("label") or f"S{idx + 1}",
                "name": geo.get("name") or w.get("name") or sid,
                "color": geo.get("color") or SENSOR_COLORS[idx % len(SENSOR_COLORS)],
                "room": s.room if s else geo.get("room"),
                "pos": geo.get("pos") or [0, 0],
                "rot": geo.get("rot", 0),
                "flip_x": geo.get("flip_x", 1), "flip_y": geo.get("flip_y", 1),
                "range": geo.get("range", 6.0), "half_angle": geo.get("half_angle", 60.0),
                "offset": geo.get("offset") or {"dx": 0, "dy": 0, "dr": 0},
                "entities": {"targets": w.get("targets", []), "presence": w.get("presence")},
                "valid": s is not None,
            })
        from .const import CONF_PIN, DEFAULT_PIN

        return {
            "entry_id": self.entry.entry_id,
            "pin": str(self.entry.options.get(CONF_PIN, DEFAULT_PIN) or ""),
            "language": self.lang,
            "allow_user_edit": self.allow_user_edit,
            "rooms": self.data["rooms"],
            "zones": self.data["zones"],
            "sensors": sensors,
            "settings": self.engine.settings.as_dict(),
            "controls": self.data["controls"],
        }

    @callback
    def apply(self, payload: dict, persist: bool) -> dict:
        """Änderungen aus der Karte übernehmen (Räume, Zonen, Sensor-Geometrie)."""
        if "rooms" in payload:
            rooms = []
            seen: set[str] = set()
            for r in payload["rooms"] or []:
                rid = str(r.get("id") or "")
                poly = _clean_poly(r.get("polygon"))
                if not _ID_RE.match(rid) or rid in seen or not poly:
                    raise ValueError(f"Invalid room: {rid or r}")
                seen.add(rid)
                rooms.append({"id": rid, "name": _clean_str(r.get("name"), rid), "polygon": poly})
            if not rooms:
                raise ValueError("At least one room is required")
            self.data["rooms"] = rooms
        if "zones" in payload:
            old = {z.get("id"): z for z in self.data["zones"]}
            used: set[int] = set()
            zones = []
            for z in payload["zones"] or []:
                zid = str(z.get("id") or "")
                pts = _clean_poly(z.get("points"))
                if not _ID_RE.match(zid) or not pts or any(x["id"] == zid for x in zones):
                    raise ValueError(f"Invalid zone: {zid or z}")
                num = int(_num(z.get("num") or (old.get(zid) or {}).get("num"), 0))
                if num <= 0 or num in used:
                    num = 0
                od = z.get("off_delay")
                zones.append({
                    "id": zid, "num": num, "room": str(z.get("room") or "") or None,
                    "name": _clean_str(z.get("name"), "Zone"),
                    "color": _clean_color(z.get("color"), ZONE_COLORS[len(zones) % len(ZONE_COLORS)]),
                    "enabled": bool(z.get("enabled", True)), "points": pts,
                    "extra": [int(i) for i in (z.get("extra") or []) if isinstance(i, (int, float))][:8],
                    "off_delay": None if od in (None, "") else _num(od, 0, 0, 3600),
                })
                if num:
                    used.add(num)
            for z in zones:
                if not z["num"]:
                    n = self.data["next_zone_num"]
                    while n in used:
                        n += 1
                    z["num"] = n
                    used.add(n)
                    self.data["next_zone_num"] = n + 1
            self.data["next_zone_num"] = max([self.data["next_zone_num"], *[n + 1 for n in used]])
            self.data["zones"] = zones
        if "sensors" in payload:
            ids = {str(w.get("id")) for w in self.wiring}
            for sid, g in (payload["sensors"] or {}).items():
                if sid not in ids or not isinstance(g, dict):
                    continue
                cur = self.data["geometry"].setdefault(sid, {})
                if "label" in g:
                    cur["label"] = _clean_str(g["label"], cur.get("label") or sid, 6)
                if "name" in g:
                    cur["name"] = _clean_str(g["name"], cur.get("name") or sid)
                if "color" in g:
                    cur["color"] = _clean_color(g["color"], cur.get("color") or "#38bdf8")
                if "room" in g:
                    cur["room"] = str(g["room"]) if g["room"] else None
                if "pos" in g and isinstance(g["pos"], (list, tuple)) and len(g["pos"]) == 2:
                    cur["pos"] = [round(_num(g["pos"][0], 0, -1000, 1000), 3), round(_num(g["pos"][1], 0, -1000, 1000), 3)]
                if "rot" in g:
                    cur["rot"] = round(_num(g["rot"], 0, -360, 360), 2)
                for k in ("flip_x", "flip_y"):
                    if k in g:
                        cur[k] = -1 if _num(g[k], 1) < 0 else 1
                if "range" in g:
                    cur["range"] = round(_num(g["range"], 6, 0.5, 20), 2)
                if "half_angle" in g:
                    cur["half_angle"] = round(_num(g["half_angle"], 60, 5, 90), 1)
                if "offset" in g and isinstance(g["offset"], dict):
                    o = g["offset"]
                    cur["offset"] = {
                        "dx": round(_num(o.get("dx"), 0, -50, 50), 4),
                        "dy": round(_num(o.get("dy"), 0, -50, 50), 4),
                        "dr": round(_num(o.get("dr"), 0, -360, 360), 3),
                    }
        self._rebuild()
        if persist:
            self._sync_entities()
            self.store.async_delay_save(self._data_to_save, 1)
            self._broadcast_config()
        self._compute()
        self._push(time.monotonic(), force=True)
        return self.config_payload()

    @callback
    def auto_calibrate(self, room_id: str) -> dict:
        res = self.engine.auto_calibrate(room_id)
        if res.get("ok"):
            for sid, off in res["sensors"].items():
                geo = self.data["geometry"].setdefault(sid, {})
                cur = geo.get("offset") or {"dx": 0, "dy": 0, "dr": 0}
                geo["offset"] = {"dx": off["dx"], "dy": off["dy"], "dr": cur.get("dr", 0)}
            self._rebuild()
            self.store.async_delay_save(self._data_to_save, 1)
            self._broadcast_config()
            self._compute()
        return res

    # ================================================================ Entitäten/Geräte
    def room_device_id(self, room_id: str) -> tuple[str, str]:
        return (DOMAIN, f"{self.entry.entry_id}_room_{room_id}")

    def zone_device_id(self, zone_id: str) -> tuple[str, str]:
        return (DOMAIN, f"{self.entry.entry_id}_zone_{zone_id}")

    @property
    def hub_device_id(self) -> tuple[str, str]:
        return (DOMAIN, self.entry.entry_id)

    def _expected_unique_ids(self) -> set[str]:
        eid = self.entry.entry_id
        out = {f"{eid}_{k}" for k in (
            "start_calibration", "abort_calibration", "reset_model", "calibration_scheduled",
            "learning", "calibration_time", "calibration_duration", "calibration_status", "ghost_rejected",
        )}
        for z in self.zone_ids:
            out |= {f"{eid}_zone_{z}_occupancy", f"{eid}_zone_{z}_count"}
        for r in self.room_ids:
            out.add(f"{eid}_room_{r}_count")
        return out

    @callback
    def _cleanup_registry(self) -> None:
        """Entitäten/Geräte gelöschter Zonen/Räume entfernen (auch nach Neustart)."""
        ent_reg = er.async_get(self.hass)
        expected = self._expected_unique_ids()
        for ent in er.async_entries_for_config_entry(ent_reg, self.entry.entry_id):
            if ent.unique_id not in expected:
                ent_reg.async_remove(ent.entity_id)
        dev_reg = dr.async_get(self.hass)
        valid = {self.hub_device_id} | {self.zone_device_id(z) for z in self.zone_ids} \
            | {self.room_device_id(r) for r in self.room_ids}
        for dev in dr.async_entries_for_config_entry(dev_reg, self.entry.entry_id):
            if not dev.identifiers & valid:
                dev_reg.async_update_device(dev.id, remove_config_entry_id=self.entry.entry_id)

    @callback
    def via_kwargs(self, identifier: tuple[str, str]) -> dict[str, Any]:
        """Übergeordnetes Gerät kompatibel angeben: ab HA 2026.8 per Geräte-ID
        (via_device_id), davor per Identifier-Tupel (via_device)."""
        if _VIA_BY_ID:
            dev = dr.async_get(self.hass).async_get_device(identifiers={identifier})
            return {"via_device_id": dev.id} if dev else {}
        return {"via_device": identifier}

    @callback
    def ensure_devices(self) -> None:
        """Hub- und Raum-Geräte vorab anlegen, damit Zonen korrekt darunter hängen."""
        from .const import MANUFACTURER, VERSION

        dev_reg = dr.async_get(self.hass)
        dev_reg.async_get_or_create(
            config_entry_id=self.entry.entry_id, identifiers={self.hub_device_id},
            name="Zone Presence Detection", manufacturer=MANUFACTURER, model=self.t("model_hub"),
            sw_version=VERSION, entry_type=dr.DeviceEntryType.SERVICE,
        )
        for rid, room in self.engine.rooms.items():
            dev_reg.async_get_or_create(
                config_entry_id=self.entry.entry_id, identifiers={self.room_device_id(rid)},
                name=room.name, manufacturer=MANUFACTURER, model=self.t("model_room"), **self.via_kwargs(self.hub_device_id),
            )

    @callback
    def _sync_entities(self) -> None:
        zones = set(self.engine.zones)
        rooms = set(self.engine.rooms)
        new_z, new_r = zones - self.zone_ids, rooms - self.room_ids
        self.zone_ids, self.room_ids = zones, rooms
        self._cleanup_registry()
        self.ensure_devices()
        dev_reg = dr.async_get(self.hass)
        # Namen/Zuordnung bestehender Geräte nachziehen
        room_dev_ids = {}
        for rid, room in self.engine.rooms.items():
            dev = dev_reg.async_get_device(identifiers={self.room_device_id(rid)})
            if dev:
                room_dev_ids[rid] = dev.id
                if dev.name != room.name:
                    dev_reg.async_update_device(dev.id, name=room.name)
        hub = dev_reg.async_get_device(identifiers={self.hub_device_id})
        for zid, z in self.engine.zones.items():
            dev = dev_reg.async_get_device(identifiers={self.zone_device_id(zid)})
            if not dev:
                continue
            via = room_dev_ids.get(z.room) if z.room else (hub.id if hub else None)
            changes: dict[str, Any] = {}
            if dev.name != z.display_name:
                changes["name"] = z.display_name
            if via and dev.via_device_id != via:
                changes["via_device_id"] = via
            if changes:
                dev_reg.async_update_device(dev.id, **changes)
        if new_z or new_r:
            async_dispatcher_send(self.hass, signal_new_entities(self.entry.entry_id), new_r, new_z)

    # ================================================================ Lern-Kalibrierung
    def calibration_status(self) -> str:
        if self.engine.cal_active:
            return "running"
        if self.data["controls"]["cal_armed"]:
            return "scheduled"
        return self.engine.cal_status if self.engine.cal_status in ("done", "disturbed", "aborted") else "idle"

    def next_calibration(self) -> datetime | None:
        if not self.data["controls"]["cal_armed"]:
            return None
        m = _TIME_RE.match(self.data["controls"]["cal_time"])
        if not m:
            return None
        now = dt_util.now()
        nxt = now.replace(hour=int(m.group(1)), minute=int(m.group(2)), second=0, microsecond=0)
        if nxt <= now:
            nxt += timedelta(days=1)
        return nxt

    def calibration_info(self) -> dict:
        nxt = self.next_calibration()
        return {
            "status": self.calibration_status(),
            "progress": round(self.engine.calibration_progress(time.monotonic()), 3),
            "next": nxt.isoformat() if nxt else None,
        }

    @callback
    def start_calibration(self, duration_min: float | None = None) -> None:
        minutes = _num(duration_min if duration_min is not None else self.data["controls"]["cal_duration"],
                       DEFAULT_CAL_DURATION, 1, 1440)
        self.engine.calibration_start(time.monotonic(), minutes * 60)
        self.data["cal_last"] = {"status": "running", "started": dt_util.utcnow().isoformat(), "duration_min": minutes}
        self.store.async_delay_save(self._data_to_save, 1)
        _LOGGER.info("Learning calibration started (%s min)", minutes)
        self._compute()

    @callback
    def abort_calibration(self) -> None:
        if self.engine.cal_active:
            self.engine.calibration_abort()
            self.data["cal_last"] = {**self.data.get("cal_last", {}), "status": "aborted",
                                     "finished": dt_util.utcnow().isoformat()}
            self.store.async_delay_save(self._data_to_save, 1)
        self._compute()

    @callback
    def _on_calibration_finished(self) -> None:
        res = self.engine.cal_result
        status = self.engine.cal_status
        self.data["cal_last"] = {
            **self.data.get("cal_last", {}), **res, "status": status, "finished": dt_util.utcnow().isoformat(),
        }
        self.store.async_delay_save(self._data_to_save, 1)
        self.model_store.async_delay_save(self._model_to_save, 1)
        if status == "disturbed":
            msg = self.t("cal_disturbed", pct=round((res.get("disturbed_ratio") or 0) * 100), cells=res.get("cells", 0))
        else:
            msg = self.t("cal_done", cells=res.get("cells", 0))
        persistent_notification.async_create(
            self.hass, msg, title="Zone Presence Detection", notification_id=f"{DOMAIN}_calibration",
        )

    @callback
    def _schedule_cal_listener(self) -> None:
        if self._cal_time_unsub:
            self._cal_time_unsub()
            self._cal_time_unsub = None
        m = _TIME_RE.match(self.data["controls"]["cal_time"])
        if not m:
            return
        self._cal_time_unsub = async_track_time_change(
            self.hass, self._cal_time_reached, hour=int(m.group(1)), minute=int(m.group(2)), second=0
        )

    @callback
    def _cal_time_reached(self, _now: datetime) -> None:
        if not self.data["controls"]["cal_armed"]:
            return
        self.data["controls"]["cal_armed"] = False  # einmalig
        self.start_calibration()

    @callback
    def set_control(self, key: str, value: Any) -> None:
        c = self.data["controls"]
        if key == "cal_time":
            if not _TIME_RE.match(str(value)):
                raise ValueError("Invalid time")
            c["cal_time"] = str(value)
            self._schedule_cal_listener()
        elif key == "cal_duration":
            c["cal_duration"] = int(_num(value, DEFAULT_CAL_DURATION, 15, 480))
        elif key == "cal_armed":
            c["cal_armed"] = bool(value)
        elif key == "learning":
            c["learning"] = bool(value)
            self.engine.learning_enabled = bool(value)
        else:
            raise ValueError(key)
        self.store.async_delay_save(self._data_to_save, 1)
        self._compute()
        async_dispatcher_send(self.hass, signal_hub(self.entry.entry_id))
        self._broadcast_config()

    @callback
    def reset_model(self) -> None:
        self.engine.model.reset()
        self.model_store.async_delay_save(self._model_to_save, 1)
        self.data["cal_last"] = {}
        self.engine.cal_status = "idle"
        self.store.async_delay_save(self._data_to_save, 1)
        async_dispatcher_send(self.hass, signal_hub(self.entry.entry_id))

    @callback
    def _save_model_cb(self, _now: datetime) -> None:
        self.model_store.async_delay_save(self._model_to_save, 5)

    # ================================================================ Import aus der Package-Lösung
    @callback
    def import_legacy(self, opts: dict) -> dict:
        """Übernimmt Räume, Zonen und Kalibrierung aus den input_text-Helfern der
        bisherigen Package-Lösung."""
        import json

        def load(eid: str) -> dict | None:
            st = self.hass.states.get(eid)
            if not st or st.state in ("", "unknown", "unavailable"):
                return None
            try:
                v = json.loads(st.state)
                return v if isinstance(v, dict) else None
            except ValueError:
                return None

        rooms, zones = [], []
        for i in range(1, int(opts.get("max_rooms", 4)) + 1):
            o = load(f"{opts['room_prefix']}{i}")
            if o and _clean_poly(o.get("p")):
                rooms.append({"id": f"r{i}", "name": _clean_str(o.get("n"), self.t("room", n=i)), "polygon": _clean_poly(o["p"])})
        if not rooms:
            rooms = list(self.data["rooms"])
        room_ids = {r["id"] for r in rooms}
        for i in range(1, int(opts.get("max_zones", 12)) + 1):
            o = load(f"{opts['zone_prefix']}{i}")
            if not o or not _clean_poly(o.get("p")):
                continue
            rid = f"r{o.get('r', 1)}"
            zones.append({
                "id": f"z{i}", "num": i, "room": rid if rid in room_ids else rooms[0]["id"],
                "name": _clean_str(o.get("n"), self.t("zone", n=i)), "color": _clean_color(o.get("c"), ZONE_COLORS[(i - 1) % 8]),
                "enabled": o.get("e") is not False, "points": _clean_poly(o["p"]), "extra": o.get("x") or [],
                "off_delay": None,
            })
        positions = opts.get("positions") or {}
        sensors_payload: dict[str, dict] = {}
        imported_sensors = []
        for idx, w in enumerate(self.wiring):
            sid = str(w.get("id"))
            geo = self.data["geometry"].get(sid) or {}
            label = str(geo.get("label") or f"S{idx + 1}")
            g: dict[str, Any] = {}
            pos_opt = positions.get(label) or positions.get(label.upper()) or {}
            cal = load(f"{opts['cal_prefix']}{label.lower()}") or {}
            if cal.get("px") is not None and cal.get("py") is not None:
                g["pos"] = [cal["px"], cal["py"]]
            elif "pos" in pos_opt:
                g["pos"] = pos_opt["pos"]
            if cal.get("rot") is not None:
                g["rot"] = cal["rot"]
            elif "rot" in pos_opt:
                g["rot"] = pos_opt["rot"]
            g["offset"] = {"dx": cal.get("dx") or 0, "dy": cal.get("dy") or 0, "dr": cal.get("dr") or 0}
            room = pos_opt.get("room")
            if room in room_ids:
                g["room"] = room
            elif geo.get("room") not in room_ids:
                g["room"] = rooms[0]["id"]
            for k in ("flip_x", "flip_y", "range", "half_angle"):
                if k in pos_opt:
                    g[k] = pos_opt[k]
            sensors_payload[sid] = g
            imported_sensors.append(label)
        self.apply({"rooms": rooms, "zones": zones if zones or opts.get("replace", True) else self.data["zones"],
                    "sensors": sensors_payload}, persist=True)
        return {"rooms": len(rooms), "zones": len(zones), "sensors": imported_sensors}

    @staticmethod
    def new_id(prefix: str) -> str:
        return f"{prefix}{uuid.uuid4().hex[:8]}"
