"""Websocket-API für Karte und Panel."""
from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN
from .runtime import ZonePresenceRuntime


def get_runtime(hass: HomeAssistant, entry_id: str | None = None) -> ZonePresenceRuntime | None:
    for entry in hass.config_entries.async_entries(DOMAIN):
        if entry.state is not ConfigEntryState.LOADED:
            continue
        if entry_id and entry.entry_id != entry_id:
            continue
        rt = getattr(entry, "runtime_data", None)
        if isinstance(rt, ZonePresenceRuntime):
            return rt
    return None


def _not_found(connection: websocket_api.ActiveConnection, msg_id: int) -> None:
    connection.send_error(msg_id, "not_found", "Zone Presence Detection ist nicht eingerichtet oder nicht geladen")


@callback
def async_register(hass: HomeAssistant) -> None:
    for cmd in (ws_config, ws_subscribe, ws_apply, ws_auto_calibrate, ws_calibration):
        websocket_api.async_register_command(hass, cmd)


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/config", vol.Optional("entry_id"): str})
@callback
def ws_config(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    rt = get_runtime(hass, msg.get("entry_id"))
    if rt is None:
        _not_found(connection, msg["id"])
        return
    connection.send_result(msg["id"], {**rt.config_payload(), "is_admin": bool(connection.user and connection.user.is_admin)})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/subscribe",
        vol.Optional("entry_id"): str,
        vol.Optional("debug", default=True): bool,
    }
)
@callback
def ws_subscribe(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    rt = get_runtime(hass, msg.get("entry_id"))
    if rt is None:
        _not_found(connection, msg["id"])
        return
    msg_id = msg["id"]
    is_admin = bool(connection.user and connection.user.is_admin)

    @callback
    def send(payload: dict) -> None:
        if payload.get("type") == "config":
            payload = {**payload, "is_admin": is_admin}
        connection.send_message(websocket_api.event_message(msg_id, payload))

    connection.subscriptions[msg_id] = rt.subscribe(send, msg["debug"])
    connection.send_result(msg_id)
    rt.send_initial(send)


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/apply",
        vol.Optional("entry_id"): str,
        vol.Optional("rooms"): list,
        vol.Optional("zones"): list,
        vol.Optional("sensors"): dict,
        vol.Optional("persist", default=True): bool,
    }
)
@callback
def ws_apply(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    rt = get_runtime(hass, msg.get("entry_id"))
    if rt is None:
        _not_found(connection, msg["id"])
        return
    payload = {k: msg[k] for k in ("rooms", "zones", "sensors") if k in msg}
    try:
        cfg = rt.apply(payload, msg["persist"])
    except (ValueError, TypeError, KeyError) as err:
        connection.send_error(msg["id"], "invalid_format", str(err))
        return
    connection.send_result(msg["id"], cfg if msg["persist"] else None)


@websocket_api.require_admin
@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/auto_calibrate", vol.Optional("entry_id"): str, vol.Required("room_id"): str}
)
@callback
def ws_auto_calibrate(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    rt = get_runtime(hass, msg.get("entry_id"))
    if rt is None:
        _not_found(connection, msg["id"])
        return
    connection.send_result(msg["id"], rt.auto_calibrate(msg["room_id"]))


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/calibration",
        vol.Optional("entry_id"): str,
        vol.Required("action"): vol.In(["start", "abort"]),
        vol.Optional("duration"): vol.All(vol.Coerce(float), vol.Range(min=1, max=1440)),
    }
)
@callback
def ws_calibration(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    rt = get_runtime(hass, msg.get("entry_id"))
    if rt is None:
        _not_found(connection, msg["id"])
        return
    if msg["action"] == "start":
        rt.start_calibration(msg.get("duration"))
    else:
        rt.abort_calibration()
    connection.send_result(msg["id"], rt.calibration_info())
