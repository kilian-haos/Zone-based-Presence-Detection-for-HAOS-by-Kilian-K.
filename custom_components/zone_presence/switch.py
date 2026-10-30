"""Schalter am Hub: einmalige Lernkalibrierung geplant, kontinuierliches Lernen."""
from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .entity import HubEntity
from .runtime import ZonePresenceRuntime


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    rt: ZonePresenceRuntime = entry.runtime_data
    async_add_entities([ControlSwitch(rt, "calibration_scheduled", "cal_armed", "mdi:calendar-clock"),
                        ControlSwitch(rt, "learning", "learning", "mdi:brain")])


class ControlSwitch(HubEntity, SwitchEntity):
    def __init__(self, rt: ZonePresenceRuntime, key: str, control: str, icon: str) -> None:
        super().__init__(rt, key)
        self._control = control
        self._attr_icon = icon

    @property
    def is_on(self) -> bool:
        return bool(self.runtime.data["controls"][self._control])

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        if self._control != "cal_armed":
            return None
        nxt = self.runtime.next_calibration()
        return {"next_run": nxt.isoformat() if nxt else None}

    async def async_turn_on(self, **kwargs: Any) -> None:
        self.runtime.set_control(self._control, True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        self.runtime.set_control(self._control, False)
