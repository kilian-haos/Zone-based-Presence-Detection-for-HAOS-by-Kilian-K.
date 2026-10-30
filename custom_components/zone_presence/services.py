"""Dienste: Lernkalibrierung, Lernmodell, Import der bisherigen Package-Lösung."""
from __future__ import annotations

import voluptuous as vol

from homeassistant.core import HomeAssistant, ServiceCall, ServiceResponse, SupportsResponse, callback
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers import config_validation as cv

from .const import DOMAIN
from .websocket import get_runtime

SERVICE_START = "start_learning_calibration"
SERVICE_ABORT = "abort_learning_calibration"
SERVICE_SCHEDULE = "schedule_learning_calibration"
SERVICE_RESET = "reset_learning_model"
SERVICE_IMPORT = "import_legacy"

_DURATION = vol.All(vol.Coerce(float), vol.Range(min=15, max=480))

POSITION_SCHEMA = vol.Schema(
    {
        vol.Optional("pos"): vol.All([vol.Coerce(float)], vol.Length(min=2, max=2)),
        vol.Optional("rot"): vol.Coerce(float),
        vol.Optional("room"): str,
        vol.Optional("flip_x"): vol.In([-1, 1]),
        vol.Optional("flip_y"): vol.In([-1, 1]),
        vol.Optional("range"): vol.Coerce(float),
        vol.Optional("half_angle"): vol.Coerce(float),
    }
)


def _rt(hass: HomeAssistant):
    rt = get_runtime(hass)
    if rt is None:
        raise ServiceValidationError(
            translation_domain=DOMAIN, translation_key="not_loaded",
        )
    return rt


@callback
def async_register(hass: HomeAssistant) -> None:
    async def start(call: ServiceCall) -> None:
        _rt(hass).start_calibration(call.data.get("duration"))

    async def abort(call: ServiceCall) -> None:
        _rt(hass).abort_calibration()

    async def schedule(call: ServiceCall) -> None:
        rt = _rt(hass)
        t = call.data["time"]
        rt.set_control("cal_time", f"{t.hour:02d}:{t.minute:02d}")
        if "duration" in call.data:
            rt.set_control("cal_duration", call.data["duration"])
        rt.set_control("cal_armed", True)

    async def reset(call: ServiceCall) -> None:
        _rt(hass).reset_model()

    async def import_legacy(call: ServiceCall) -> ServiceResponse:
        return _rt(hass).import_legacy(dict(call.data))

    hass.services.async_register(DOMAIN, SERVICE_START, start, schema=vol.Schema({vol.Optional("duration"): _DURATION}))
    hass.services.async_register(DOMAIN, SERVICE_ABORT, abort, schema=vol.Schema({}))
    hass.services.async_register(
        DOMAIN, SERVICE_SCHEDULE, schedule,
        schema=vol.Schema({vol.Required("time"): cv.time, vol.Optional("duration"): _DURATION}),
    )
    hass.services.async_register(DOMAIN, SERVICE_RESET, reset, schema=vol.Schema({}))
    hass.services.async_register(
        DOMAIN, SERVICE_IMPORT, import_legacy,
        schema=vol.Schema(
            {
                vol.Optional("zone_prefix", default="input_text.zonen_zone_"): cv.string,
                vol.Optional("room_prefix", default="input_text.zonen_room_"): cv.string,
                vol.Optional("cal_prefix", default="input_text.zonen_cal_"): cv.string,
                vol.Optional("max_zones", default=12): vol.All(vol.Coerce(int), vol.Range(min=1, max=64)),
                vol.Optional("max_rooms", default=4): vol.All(vol.Coerce(int), vol.Range(min=1, max=16)),
                vol.Optional("positions", default={}): {cv.string: POSITION_SCHEMA},
                vol.Optional("replace", default=True): cv.boolean,
            }
        ),
        supports_response=SupportsResponse.OPTIONAL,
    )
