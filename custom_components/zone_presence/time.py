"""Startzeit der Lernkalibrierung."""
from __future__ import annotations

from datetime import time

from homeassistant.components.time import TimeEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .entity import HubEntity
from .runtime import ZonePresenceRuntime


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    async_add_entities([CalibrationTime(entry.runtime_data)])


class CalibrationTime(HubEntity, TimeEntity):
    _attr_icon = "mdi:clock-start"
    _attr_entity_category = EntityCategory.CONFIG

    def __init__(self, rt: ZonePresenceRuntime) -> None:
        super().__init__(rt, "calibration_time")

    @property
    def native_value(self) -> time | None:
        h, m = self.runtime.data["controls"]["cal_time"].split(":")
        return time(int(h), int(m))

    async def async_set_value(self, value: time) -> None:
        self.runtime.set_control("cal_time", f"{value.hour:02d}:{value.minute:02d}")
