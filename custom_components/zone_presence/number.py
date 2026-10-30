"""Dauer der Lernkalibrierung."""
from __future__ import annotations

from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory, UnitOfTime
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .entity import HubEntity
from .runtime import ZonePresenceRuntime


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    async_add_entities([CalibrationDuration(entry.runtime_data)])


class CalibrationDuration(HubEntity, NumberEntity):
    _attr_icon = "mdi:timer-sand"
    _attr_entity_category = EntityCategory.CONFIG
    _attr_native_min_value = 15
    _attr_native_max_value = 480
    _attr_native_step = 15
    _attr_mode = NumberMode.BOX
    _attr_native_unit_of_measurement = UnitOfTime.MINUTES

    def __init__(self, rt: ZonePresenceRuntime) -> None:
        super().__init__(rt, "calibration_duration")

    @property
    def native_value(self) -> float:
        return float(self.runtime.data["controls"]["cal_duration"])

    async def async_set_native_value(self, value: float) -> None:
        self.runtime.set_control("cal_duration", value)
