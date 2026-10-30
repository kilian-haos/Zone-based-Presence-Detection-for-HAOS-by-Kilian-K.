"""Diagnosedaten (Einstellungen → Geräte & Dienste → Integration → Diagnose herunterladen)."""
from __future__ import annotations

import time
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import VERSION


async def async_get_config_entry_diagnostics(hass: HomeAssistant, entry: ConfigEntry) -> dict[str, Any]:
    rt = entry.runtime_data
    eng = rt.engine
    now = time.monotonic()
    return {
        "version": VERSION,
        "options": dict(entry.options),
        "store": rt.data,
        "calibration": rt.calibration_info(),
        "model": eng.model.stats(),
        "stats": dict(eng.stats),
        "tracks": [
            {
                "key": t.key, "label": t.label, "age_s": round(now - t.born, 1), "conf": round(t.conf, 3),
                "confirmed": t.confirmed, "proven": t.proven, "still": t.still, "max_disp": round(t.max_disp, 2),
                "room": [round(t.room[0], 2), round(t.room[1], 2)], "zones": sorted(t.zones),
            }
            for t in eng.tracks.values()
        ],
        "snapshot": eng.snapshot(debug=True),
    }
