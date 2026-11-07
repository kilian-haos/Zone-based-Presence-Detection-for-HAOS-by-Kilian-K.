"""Personenanzahl je Zone/Raum, Status der Lernkalibrierung, Geisterfilter-Statistik."""
from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import CAL_STATUSES, signal_new_entities
from .entity import HubEntity, RoomEntity, ZoneEntity
from .runtime import ZonePresenceRuntime


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    runtime: ZonePresenceRuntime = entry.runtime_data
    entities: list[SensorEntity] = [CalibrationStatus(runtime), GhostRejected(runtime)]
    entities += [RoomPersonCount(runtime, rid) for rid in sorted(runtime.room_ids)]
    entities += [ZonePersonCount(runtime, zid) for zid in sorted(runtime.zone_ids)]
    async_add_entities(entities)

    @callback
    def _new(rooms: set[str], zones: set[str]) -> None:
        new: list[SensorEntity] = [RoomPersonCount(runtime, rid) for rid in sorted(rooms)]
        new += [ZonePersonCount(runtime, zid) for zid in sorted(zones)]
        if new:
            async_add_entities(new)

    entry.async_on_unload(async_dispatcher_connect(hass, signal_new_entities(entry.entry_id), _new))


class ZonePersonCount(ZoneEntity, SensorEntity):
    _attr_translation_key = "person_count"
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = None

    def __init__(self, runtime: ZonePresenceRuntime, zone_id: str) -> None:
        super().__init__(runtime, zone_id, "count")

    @property
    def native_value(self) -> int | None:
        zs = self.runtime.engine.zone_state.get(self.zone_id)
        return zs.count if zs else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        zs = self.runtime.engine.zone_state.get(self.zone_id)
        return {"persons": zs.persons} if zs else {}


class RoomPersonCount(RoomEntity, SensorEntity):
    _attr_translation_key = "person_count"
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, runtime: ZonePresenceRuntime, room_id: str) -> None:
        super().__init__(runtime, room_id, "count")

    @property
    def native_value(self) -> int | None:
        return self.runtime.engine.room_count.get(self.room_id)


class CalibrationStatus(HubEntity, SensorEntity):
    _attr_device_class = SensorDeviceClass.ENUM
    _attr_options = CAL_STATUSES

    def __init__(self, runtime: ZonePresenceRuntime) -> None:
        super().__init__(runtime, "calibration_status")

    @property
    def native_value(self) -> str:
        return self.runtime.calibration_status()

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        info = self.runtime.calibration_info()
        last = self.runtime.data.get("cal_last") or {}
        return {
            "progress_percent": round(info["progress"] * 100),
            "next_run": info["next"],
            "last_started": last.get("started"),
            "last_finished": last.get("finished"),
            "learned_cells": last.get("cells"),
            "disturbed_percent": round((last.get("disturbed_ratio") or 0) * 100) if last.get("disturbed_ratio") is not None else None,
            "model": self.runtime.engine.model.stats(),
        }


class GhostRejected(HubEntity, SensorEntity):
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_state_class = SensorStateClass.TOTAL_INCREASING

    def __init__(self, runtime: ZonePresenceRuntime) -> None:
        super().__init__(runtime, "ghost_rejected")

    @property
    def native_value(self) -> int:
        st = self.runtime.engine.stats
        return int(st["rejected_wall"] + st["rejected_filter"] + st.get("rejected_excl", 0))

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        st = self.runtime.engine.stats
        model = self.runtime.engine.model
        today = sum((days.get(model.day) or [0])[0] for days in model.daily.values())
        return {"behind_wall": st["rejected_wall"], "filtered": st["rejected_filter"],
                "in_exclusion_zone": st.get("rejected_excl", 0), "tracks_total": st["tracks"],
                "ghosts_today": int(today), "model_precision": model.precision()}
