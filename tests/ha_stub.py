"""Minimale Home-Assistant-Nachbildung, um runtime.py ohne echtes HA zu testen.

Wird nur verwendet, wenn das Paket `homeassistant` nicht installiert ist. Bildet genau
die Schnittstellen nach, die runtime.py/const.py nutzen (Registries, Store, Events,
Dispatcher). Die API-Signaturen wurden gegen den HA-Quellcode abgeglichen.
"""
from __future__ import annotations

import enum
import sys
import types
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

SENT: list[tuple] = []            # Dispatcher-Aufrufe
NOTIFICATIONS: list[dict] = []
TIME_LISTENERS: list[dict] = []


def _mod(name: str) -> types.ModuleType:
    m = sys.modules.get(name)
    if m is None:
        m = types.ModuleType(name)
        sys.modules[name] = m
        parent, _, child = name.rpartition(".")
        if parent:
            setattr(_mod(parent), child, m)
    return m


def install() -> None:
    try:
        import homeassistant  # noqa: F401
        if not getattr(homeassistant, "__zp_stub__", False):
            return
    except ImportError:
        pass

    ha = _mod("homeassistant")
    ha.__zp_stub__ = True

    const = _mod("homeassistant.const")

    class Platform(str, enum.Enum):
        BINARY_SENSOR = "binary_sensor"
        SENSOR = "sensor"
        BUTTON = "button"
        SWITCH = "switch"
        NUMBER = "number"
        TIME = "time"

    const.Platform = Platform
    const.EVENT_HOMEASSISTANT_STOP = "homeassistant_stop"

    core = _mod("homeassistant.core")
    core.callback = lambda f: f

    class Event:
        def __init__(self, data: dict) -> None:
            self.data = data

    core.Event = Event
    core.HomeAssistant = object

    ce = _mod("homeassistant.config_entries")
    ce.ConfigEntry = object

    # ---- Registries
    dr = _mod("homeassistant.helpers.device_registry")

    class DeviceEntryType(str, enum.Enum):
        SERVICE = "service"

    class DeviceInfo(dict):
        __optional_keys__ = frozenset({"identifiers", "name", "via_device_id"})

    @dataclass
    class Device:
        id: str
        identifiers: set
        config_entries: set
        name: str | None = None
        via_device_id: str | None = None

    class DevReg:
        def __init__(self) -> None:
            self.devices: dict[str, Device] = {}
            self._n = 0

        def async_get_device(self, identifiers=None, connections=None):
            for d in self.devices.values():
                if d.identifiers & set(identifiers or ()):
                    return d
            return None

        def async_get_or_create(self, *, config_entry_id, identifiers, name=None, via_device_id=None, **kw):
            d = self.async_get_device(identifiers=identifiers)
            if d is None:
                self._n += 1
                d = Device(f"dev{self._n}", set(identifiers), {config_entry_id}, name, via_device_id)
                self.devices[d.id] = d
            return d

        def async_update_device(self, device_id, *, name=None, via_device_id=None, remove_config_entry_id=None, **kw):
            d = self.devices[device_id]
            if name is not None:
                d.name = name
            if via_device_id is not None:
                d.via_device_id = via_device_id
            if remove_config_entry_id:
                d.config_entries.discard(remove_config_entry_id)
                if not d.config_entries:
                    del self.devices[device_id]
            return d

    DEV_REG = DevReg()
    dr.DeviceEntryType = DeviceEntryType
    dr.DeviceInfo = DeviceInfo
    dr.async_get = lambda hass: DEV_REG
    dr.async_entries_for_config_entry = lambda reg, eid: [d for d in list(reg.devices.values()) if eid in d.config_entries]
    dr.DEV_REG = DEV_REG

    er = _mod("homeassistant.helpers.entity_registry")

    @dataclass
    class Ent:
        entity_id: str
        unique_id: str
        config_entry_id: str

    class EntReg:
        def __init__(self) -> None:
            self.entities: dict[str, Ent] = {}

        def add(self, entity_id: str, unique_id: str, entry_id: str) -> None:
            self.entities[entity_id] = Ent(entity_id, unique_id, entry_id)

        def async_remove(self, entity_id: str) -> None:
            self.entities.pop(entity_id, None)

    ENT_REG = EntReg()
    er.async_get = lambda hass: ENT_REG
    er.async_entries_for_config_entry = lambda reg, eid: [e for e in list(reg.entities.values()) if e.config_entry_id == eid]
    er.ENT_REG = ENT_REG

    disp = _mod("homeassistant.helpers.dispatcher")
    disp.async_dispatcher_send = lambda hass, signal, *args: SENT.append((signal, args))

    ev = _mod("homeassistant.helpers.event")
    ev.async_call_later = lambda hass, delay, action: (lambda: None)
    ev.async_track_state_change_event = lambda hass, ids, action: (lambda: None)
    ev.async_track_time_interval = lambda hass, action, interval: (lambda: None)

    def track_time_change(hass, action, hour=None, minute=None, second=None):
        rec = {"action": action, "hour": hour, "minute": minute}
        TIME_LISTENERS.append(rec)
        return lambda: TIME_LISTENERS.remove(rec) if rec in TIME_LISTENERS else None

    ev.async_track_time_change = track_time_change

    st = _mod("homeassistant.helpers.storage")
    STORES: dict[str, Any] = {}

    class Store:
        def __init__(self, hass, version, key) -> None:
            self.key = key

        async def async_load(self):
            return STORES.get(self.key)

        async def async_save(self, data) -> None:
            import json
            STORES[self.key] = json.loads(json.dumps(data))

        def async_delay_save(self, func, delay=0) -> None:
            import json
            STORES[self.key] = json.loads(json.dumps(func()))

        async def async_remove(self) -> None:
            STORES.pop(self.key, None)

    st.Store = Store
    st.STORES = STORES

    pn = _mod("homeassistant.components.persistent_notification")
    pn.async_create = lambda hass, message, title=None, notification_id=None: NOTIFICATIONS.append(
        {"message": message, "title": title, "id": notification_id})

    dt = _mod("homeassistant.util.dt")
    dt.utcnow = lambda: datetime.now(timezone.utc)
    dt.now = lambda: datetime.now().astimezone()
    _mod("homeassistant.util").dt = dt
    _mod("homeassistant.helpers")


@dataclass
class FakeState:
    state: str
    attributes: dict = field(default_factory=dict)


class FakeStates:
    def __init__(self) -> None:
        self._s: dict[str, FakeState] = {}

    def get(self, eid: str):
        return self._s.get(eid)

    def set(self, eid: str, state: str) -> None:
        self._s[eid] = FakeState(state)


class FakeBus:
    def async_listen_once(self, event, cb):
        return lambda: None


class FakeServices:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    async def async_call(self, domain, service, data, blocking=False):
        self.calls.append((domain, service, data))


class FakeHass:
    def __init__(self) -> None:
        self.states = FakeStates()
        self.bus = FakeBus()
        self.data: dict = {}


class FakeEntry:
    def __init__(self, options: dict, entry_id: str = "entry1") -> None:
        self.entry_id = entry_id
        self.options = options
