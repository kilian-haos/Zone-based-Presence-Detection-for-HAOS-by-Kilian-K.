"""Entity base classes."""
from __future__ import annotations

from homeassistant.core import callback
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity import Entity

from .const import MANUFACTURER, VERSION, signal_hub, signal_state
from .runtime import ZonePresenceRuntime


class ZPEntity(Entity):
    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, runtime: ZonePresenceRuntime) -> None:
        self.runtime = runtime
        self._eid = runtime.entry.entry_id


class HubEntity(ZPEntity):
    """Entität am Hub-Gerät (Kalibrierung/Lernen)."""

    def __init__(self, runtime: ZonePresenceRuntime, key: str) -> None:
        super().__init__(runtime)
        self._attr_unique_id = f"{self._eid}_{key}"
        self._attr_translation_key = key
        self._attr_device_info = DeviceInfo(
            identifiers={runtime.hub_device_id}, name="Zone Presence Detection",
            manufacturer=MANUFACTURER, model=runtime.t("model_hub"), sw_version=VERSION,
            entry_type=dr.DeviceEntryType.SERVICE,
        )

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(async_dispatcher_connect(self.hass, signal_hub(self._eid), self._on_hub))

    @callback
    def _on_hub(self) -> None:
        self.async_write_ha_state()


class ZoneEntity(ZPEntity):
    """Entität an einem Zonen-Gerät."""

    def __init__(self, runtime: ZonePresenceRuntime, zone_id: str, suffix: str) -> None:
        super().__init__(runtime)
        self.zone_id = zone_id
        self._key = "z:" + zone_id
        self._attr_unique_id = f"{self._eid}_zone_{zone_id}_{suffix}"
        z = runtime.engine.zones.get(zone_id)
        via = runtime.room_device_id(z.room) if z and z.room else runtime.hub_device_id
        self._attr_device_info = DeviceInfo(
            identifiers={runtime.zone_device_id(zone_id)},
            name=z.display_name if z else f"Zone {zone_id}",
            manufacturer=MANUFACTURER, model=runtime.t("model_zone"), **runtime.via_kwargs(via),
        )

    @property
    def available(self) -> bool:
        return self.zone_id in self.runtime.engine.zones

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(async_dispatcher_connect(self.hass, signal_state(self._eid), self._on_state))

    @callback
    def _on_state(self, changed: set[str]) -> None:
        if self._key in changed:
            self.async_write_ha_state()


class RoomEntity(ZPEntity):
    """Entität an einem Raum-Gerät."""

    def __init__(self, runtime: ZonePresenceRuntime, room_id: str, suffix: str) -> None:
        super().__init__(runtime)
        self.room_id = room_id
        self._key = "r:" + room_id
        self._attr_unique_id = f"{self._eid}_room_{room_id}_{suffix}"
        r = runtime.engine.rooms.get(room_id)
        self._attr_device_info = DeviceInfo(
            identifiers={runtime.room_device_id(room_id)}, name=r.name if r else room_id,
            manufacturer=MANUFACTURER, model=runtime.t("model_room"), **runtime.via_kwargs(runtime.hub_device_id),
        )

    @property
    def available(self) -> bool:
        return self.room_id in self.runtime.engine.rooms

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(async_dispatcher_connect(self.hass, signal_state(self._eid), self._on_state))

    @callback
    def _on_state(self, changed: set[str]) -> None:
        if self._key in changed:
            self.async_write_ha_state()
