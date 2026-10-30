"""Buttons am Hub: Lernkalibrierung starten/abbrechen, Lernmodell zurücksetzen."""
from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .entity import HubEntity
from .runtime import ZonePresenceRuntime


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    rt: ZonePresenceRuntime = entry.runtime_data
    async_add_entities([StartCalibration(rt), AbortCalibration(rt), ResetModel(rt)])


class StartCalibration(HubEntity, ButtonEntity):
    _attr_icon = "mdi:school-outline"

    def __init__(self, rt: ZonePresenceRuntime) -> None:
        super().__init__(rt, "start_calibration")

    async def async_press(self) -> None:
        self.runtime.start_calibration()


class AbortCalibration(HubEntity, ButtonEntity):
    _attr_icon = "mdi:stop-circle-outline"

    def __init__(self, rt: ZonePresenceRuntime) -> None:
        super().__init__(rt, "abort_calibration")

    async def async_press(self) -> None:
        self.runtime.abort_calibration()


class ResetModel(HubEntity, ButtonEntity):
    _attr_icon = "mdi:restore-alert"
    _attr_entity_category = EntityCategory.CONFIG

    def __init__(self, rt: ZonePresenceRuntime) -> None:
        super().__init__(rt, "reset_model")

    async def async_press(self) -> None:
        self.runtime.reset_model()
