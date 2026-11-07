"""Websocket-API für Karte und Panel.

Ändernde Befehle: Administratoren, oder alle Benutzer, wenn „Bearbeiten auch für
Nicht-Administratoren erlauben“ gesetzt ist (dann schützt nur noch der PIN).
"""
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
    connection.send_error(msg_id, "not_found", "Zone Presence Detection is not set up or not loaded")


def _editable_runtime(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> ZonePresenceRuntime | None:
    """Runtime für ändernde Befehle: Admins oder – falls freigegeben – alle Benutzer."""
    rt = get_runtime(hass, msg.get("entry_id"))
    if rt is None:
        _not_found(connection, msg["id"])
        return None
    if not rt.can_edit(connection.user):
        connection.send_error(msg["id"], websocket_api.ERR_UNAUTHORIZED, "Editing is not allowed for this user")
        return None
    return rt


def _rights(rt: ZonePresenceRuntime, connection: websocket_api.ActiveConnection) -> dict[str, bool]:
    return {"is_admin": bool(connection.user and connection.user.is_admin), "can_edit": rt.can_edit(connection.user)}


@callback
def async_register(hass: HomeAssistant) -> None:
    for cmd in (ws_config, ws_subscribe, ws_apply, ws_auto_calibrate, ws_calibration,
                ws_model_view, ws_model_forget, ws_model_export, ws_model_import):
        websocket_api.async_register_command(hass, cmd)


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/config", vol.Optional("entry_id"): str})
@callback
def ws_config(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    rt = get_runtime(hass, msg.get("entry_id"))
    if rt is None:
        _not_found(connection, msg["id"])
        return
    connection.send_result(msg["id"], {**rt.config_payload(), **_rights(rt, connection)})


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

    @callback
    def send(payload: dict) -> None:
        if payload.get("type") == "config":
            # Rechte bei jeder Konfiguration neu bestimmen (Option kann sich ändern)
            payload = {**payload, **_rights(rt, connection)}
        connection.send_message(websocket_api.event_message(msg_id, payload))

    connection.subscriptions[msg_id] = rt.subscribe(send, msg["debug"])
    connection.send_result(msg_id)
    rt.send_initial(send)


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/apply",
        vol.Optional("entry_id"): str,
        vol.Optional("rooms"): list,
        vol.Optional("zones"): list,
        vol.Optional("exclusions"): list,
        vol.Optional("sensors"): dict,
        vol.Optional("persist", default=True): bool,
    }
)
@callback
def ws_apply(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    rt = _editable_runtime(hass, connection, msg)
    if rt is None:
        return
    payload = {k: msg[k] for k in ("rooms", "zones", "exclusions", "sensors") if k in msg}
    try:
        cfg = rt.apply(payload, msg["persist"])
    except (ValueError, TypeError, KeyError) as err:
        connection.send_error(msg["id"], "invalid_format", str(err))
        return
    connection.send_result(msg["id"], cfg if msg["persist"] else None)


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/auto_calibrate", vol.Optional("entry_id"): str, vol.Required("room_id"): str}
)
@callback
def ws_auto_calibrate(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    rt = _editable_runtime(hass, connection, msg)
    if rt is None:
        return
    connection.send_result(msg["id"], rt.auto_calibrate(msg["room_id"]))


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
    rt = _editable_runtime(hass, connection, msg)
    if rt is None:
        return
    if msg["action"] == "start":
        rt.start_calibration(msg.get("duration"))
    else:
        rt.abort_calibration()
    connection.send_result(msg["id"], rt.calibration_info())


# ---------------------------------------------------------------- Modell-Ansicht
@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/model_view",
        vol.Optional("entry_id"): str,
        vol.Required("room_id"): str,
        vol.Optional("history", default=False): bool,
    }
)
@websocket_api.async_response
async def ws_model_view(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Lernkarten eines Raums (nur lesend, für alle angemeldeten Benutzer)."""
    rt = get_runtime(hass, msg.get("entry_id"))
    if rt is None:
        _not_found(connection, msg["id"])
        return
    try:
        view = await rt.async_model_view(msg["room_id"], msg["history"])
    except ValueError as err:
        connection.send_error(msg["id"], "invalid_format", str(err))
        return
    connection.send_result(msg["id"], view)


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/model_forget",
        vol.Optional("entry_id"): str,
        vol.Required("room_id"): str,
        vol.Required("x"): vol.Coerce(float),
        vol.Required("y"): vol.Coerce(float),
        vol.Optional("radius", default=0.5): vol.All(vol.Coerce(float), vol.Range(min=0.1, max=5)),
    }
)
@callback
def ws_model_forget(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    rt = _editable_runtime(hass, connection, msg)
    if rt is None:
        return
    try:
        n = rt.model_forget(msg["room_id"], msg["x"], msg["y"], msg["radius"])
    except ValueError as err:
        connection.send_error(msg["id"], "invalid_format", str(err))
        return
    connection.send_result(msg["id"], {"cells": n})


@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/model_export", vol.Optional("entry_id"): str})
@callback
def ws_model_export(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    rt = get_runtime(hass, msg.get("entry_id"))
    if rt is None:
        _not_found(connection, msg["id"])
        return
    connection.send_result(msg["id"], rt.model_export())


@websocket_api.require_admin
@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/model_import", vol.Optional("entry_id"): str, vol.Required("data"): dict}
)
@callback
def ws_model_import(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    rt = get_runtime(hass, msg.get("entry_id"))
    if rt is None:
        _not_found(connection, msg["id"])
        return
    try:
        res = rt.model_import(msg["data"])
    except (ValueError, TypeError, KeyError) as err:
        connection.send_error(msg["id"], "invalid_format", str(err))
        return
    connection.send_result(msg["id"], res)
