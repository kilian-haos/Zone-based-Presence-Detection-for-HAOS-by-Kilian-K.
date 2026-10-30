"""Zonen-Präsenz als Binärsensor (ein Gerät je Zone, Name „<Zone> (Zone N)")."""
from __future__ import annotations

from typing import Any

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import signal_new_entities
from .entity import ZoneEntity
from .runtime import ZonePresenceRuntime


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    runtime: ZonePresenceRuntime = entry.runtime_data
    async_add_entities([ZoneOccupancy(runtime, zid) for zid in sorted(runtime.zone_ids)])

    @callback
    def _new(_rooms: set[str], zones: set[str]) -> None:
        if zones:
            async_add_entities([ZoneOccupancy(runtime, zid) for zid in sorted(zones)])

    entry.async_on_unload(async_dispatcher_connect(hass, signal_new_entities(entry.entry_id), _new))


class ZoneOccupancy(ZoneEntity, BinarySensorEntity):
    _attr_device_class = BinarySensorDeviceClass.OCCUPANCY
    _attr_name = None  # Name = Gerätename "<Zone> (Zone N)"

    def __init__(self, runtime: ZonePresenceRuntime, zone_id: str) -> None:
        super().__init__(runtime, zone_id, "occupancy")

    @property
    def is_on(self) -> bool | None:
        zs = self.runtime.engine.zone_state.get(self.zone_id)
        return zs.on if zs else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        z = self.runtime.engine.zones.get(self.zone_id)
        zs = self.runtime.engine.zone_state.get(self.zone_id)
        if not z or not zs:
            return {}
        room = self.runtime.engine.rooms.get(z.room) if z.room else None
        return {
            "zone_number": z.num,
            "zone_name": z.name,
            "room": room.name if room else None,
            "person_count": zs.count,
            "persons": zs.persons,
            "off_delay": z.off_delay if z.off_delay is not None else self.runtime.engine.settings.off_delay,
        }
