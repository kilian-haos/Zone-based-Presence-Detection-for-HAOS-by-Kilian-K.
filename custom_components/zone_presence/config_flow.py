"""Config flow and options (sensors, settings, display & editing)."""
from __future__ import annotations

import re
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.core import HomeAssistant, callback
from homeassistant.data_entry_flow import section
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers import selector

from .const import (
    CONF_ALLOW_USER_EDIT,
    CONF_PANEL,
    CONF_PANEL_TITLE,
    CONF_PIN,
    CONF_SENSORS,
    CONF_SETTINGS,
    DEFAULT_PIN,
    DOMAIN,
    NAME,
)
from .engine import Settings

UNITS = {"mm": 0.001, "cm": 0.01, "m": 1.0}
TARGET_KEYS = [f"target{n}_{a}" for n in (1, 2, 3) for a in ("x", "y")]

_SENSOR_SEL = selector.EntitySelector(selector.EntitySelectorConfig(domain="sensor"))
_PRESENCE_SEL = selector.EntitySelector(selector.EntitySelectorConfig(domain="binary_sensor"))
SECTION_EDIT = "editing"


def _title(value: Any) -> str:
    """Empty panel title = default title in the chosen language."""
    return str(value or "").strip()[:40]


def _norm(text: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", "_", (text or "").lower())


def guess_from_device(hass: HomeAssistant, device_id: str) -> dict[str, Any]:
    """Target-x/y und Presence-Sensor eines Geräts (z. B. ESPHome-LD2450) erkennen."""
    ent_reg = er.async_get(hass)
    entries = er.async_entries_for_device(ent_reg, device_id)
    out: dict[str, Any] = {}
    for n in (1, 2, 3):
        for axis in ("x", "y"):
            pat = re.compile(rf"target_?{n}_?{axis}(_|$)")
            for e in entries:
                if e.domain != "sensor":
                    continue
                texts = (e.entity_id.split(".", 1)[1], e.original_name, e.name, e.unique_id)
                if any(pat.search(_norm(t)) for t in texts if t):
                    out[f"target{n}_{axis}"] = e.entity_id
                    break
    best = None
    for e in entries:
        if e.domain != "binary_sensor":
            continue
        t = " ".join(_norm(x) for x in (e.entity_id, e.original_name, e.name) if x)
        if ("presence" in t or "praesenz" in t or "prasenz" in t) and not any(w in t for w in ("moving", "still", "bewegt")):
            if best is None or _norm(e.entity_id).endswith("presence"):
                best = e.entity_id
    if best:
        out["presence"] = best
    x1 = out.get("target1_x")
    st = hass.states.get(x1) if x1 else None
    unit = str(st.attributes.get("unit_of_measurement", "")).lower() if st else ""
    out["unit"] = unit if unit in UNITS else "mm"
    return out


def wiring_to_form(w: dict) -> dict[str, Any]:
    out: dict[str, Any] = {"name": w.get("name", "")}
    for n, t in enumerate(w.get("targets", []), start=1):
        out[f"target{n}_x"], out[f"target{n}_y"] = t.get("x"), t.get("y")
    if w.get("presence"):
        out["presence"] = w["presence"]
    unit = w.get("unit")
    if unit not in UNITS:
        unit = next((k for k, v in UNITS.items() if abs(v - float(w.get("scale", 0.001))) < 1e-9), "mm")
    out["unit"] = unit
    return out


def sensor_schema(d: dict[str, Any]) -> vol.Schema:
    def sv(key: str) -> dict | None:
        return {"suggested_value": d[key]} if d.get(key) else None

    fields: dict[Any, Any] = {
        vol.Required("name", description=sv("name")): selector.TextSelector(),
        vol.Required("target1_x", description=sv("target1_x")): _SENSOR_SEL,
        vol.Required("target1_y", description=sv("target1_y")): _SENSOR_SEL,
    }
    for key in TARGET_KEYS[2:]:
        fields[vol.Optional(key, description=sv(key))] = _SENSOR_SEL
    fields[vol.Optional("presence", description=sv("presence"))] = _PRESENCE_SEL
    fields[vol.Required("unit", default=d.get("unit") or "mm")] = selector.SelectSelector(
        selector.SelectSelectorConfig(options=list(UNITS), translation_key="unit",
                                      mode=selector.SelectSelectorMode.DROPDOWN)
    )
    return vol.Schema(fields)


def validate_sensor(hass: HomeAssistant, data: dict[str, Any], sid: str) -> tuple[dict[str, str], dict]:
    errors: dict[str, str] = {}
    targets = []
    used: set[str] = set()
    for n in (1, 2, 3):
        x, y = data.get(f"target{n}_x"), data.get(f"target{n}_y")
        if bool(x) != bool(y):
            errors[f"target{n}_y" if x else f"target{n}_x"] = "pair_incomplete"
            continue
        if not x:
            continue
        if x == y:
            errors[f"target{n}_y"] = "same_entity"
            continue
        if x in used or y in used:
            errors[f"target{n}_x"] = "duplicate_entity"
            continue
        used |= {x, y}
        for key, eid in ((f"target{n}_x", x), (f"target{n}_y", y)):
            if hass.states.get(eid) is None and er.async_get(hass).async_get(eid) is None:
                errors[key] = "entity_not_found"
        targets.append({"x": x, "y": y})
    if not data.get("target1_x") or not data.get("target1_y"):
        errors.setdefault("target1_x", "required_xy")
    unit = data.get("unit") if data.get("unit") in UNITS else "mm"
    wiring = {
        "id": sid,
        "name": str(data.get("name") or sid).strip()[:40],
        "targets": targets,
        "presence": data.get("presence") or None,
        "scale": UNITS[unit],
        "unit": unit,
    }
    return errors, wiring


def next_sensor_id(sensors: list[dict]) -> str:
    n = 1
    ids = {str(s.get("id")) for s in sensors}
    while f"s{n}" in ids:
        n += 1
    return f"s{n}"


def settings_schema(s: dict[str, Any]) -> vol.Schema:
    def num(key: str, lo: float, hi: float, step: float, unit: str | None = None,
            mode: selector.NumberSelectorMode = selector.NumberSelectorMode.BOX) -> tuple:
        return (vol.Required(key, default=s[key]),
                selector.NumberSelector(selector.NumberSelectorConfig(
                    min=lo, max=hi, step=step, unit_of_measurement=unit, mode=mode)))

    items = [
        num("off_delay", 0, 3600, 1, "s"),
        num("confirm_time", 0, 30, 0.1, "s"),
        num("stuck_timeout", 0.5, 120, 0.5, "s"),
        num("still_delay", 0, 600, 1, "s"),
        num("still_radius", 0.05, 3, 0.05, "m"),
        num("tau_move", 0.01, 5, 0.01, "s"),
        num("tau_still", 0.05, 30, 0.05, "s"),
        num("zone_exit_margin", 0, 2, 0.05, "m"),
        num("still_exit_margin", 0, 2, 0.05, "m"),
        num("merge_distance", 0, 3, 0.05, "m"),
        (vol.Required("wall_filter", default=s["wall_filter"]), selector.BooleanSelector()),
        num("wall_tolerance", 0, 2, 0.05, "m"),
        num("max_speed", 0.5, 15, 0.1, "m/s"),
        (vol.Required("ghost_filter", default=s["ghost_filter"]), selector.BooleanSelector()),
        num("ghost_strength", 0, 100, 5, "%", selector.NumberSelectorMode.SLIDER),
        (vol.Required("learning_speed", default=s["learning_speed"]),
         selector.SelectSelector(selector.SelectSelectorConfig(
             options=["slow", "normal", "fast"], translation_key="learning_speed",
             mode=selector.SelectSelectorMode.DROPDOWN))),
        num("memory_days", 0.5, 365, 0.5, "d"),
        (vol.Required("compute_level", default=str(s["compute_level"])),
         selector.SelectSelector(selector.SelectSelectorConfig(
             options=["1", "2", "3"], translation_key="compute_level",
             mode=selector.SelectSelectorMode.LIST))),
        num("cal_max_spread", 0.2, 10, 0.1, "m"),
    ]
    return vol.Schema(dict(items))


# ====================================================================== Einrichtung
class ZonePresenceConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1
    MINOR_VERSION = 2

    def __init__(self) -> None:
        self._options: dict[str, Any] = {}
        self._prefill: dict[str, Any] = {}

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")
        if user_input is not None:
            self._options = {
                CONF_SENSORS: [],
                CONF_SETTINGS: Settings().as_dict(),
                CONF_PANEL: user_input[CONF_PANEL],
                CONF_PANEL_TITLE: _title(user_input.get(CONF_PANEL_TITLE)),
                CONF_PIN: DEFAULT_PIN,
                CONF_ALLOW_USER_EDIT: False,
            }
            if user_input.get("add_sensor"):
                return await self.async_step_sensor_device()
            return self._finish()
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema({
                vol.Required("add_sensor", default=True): selector.BooleanSelector(),
                vol.Required(CONF_PANEL, default=True): selector.BooleanSelector(),
                vol.Optional(CONF_PANEL_TITLE): selector.TextSelector(),
            }),
        )

    async def async_step_sensor_device(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            self._prefill = guess_from_device(self.hass, user_input["device"]) if user_input.get("device") else {}
            self._prefill["name"] = user_input.get("name") or self._device_name(user_input.get("device")) or "Sensor 1"
            return await self.async_step_sensor_entities()
        return self.async_show_form(step_id="sensor_device", data_schema=_device_schema())

    def _device_name(self, device_id: str | None) -> str | None:
        if not device_id:
            return None
        from homeassistant.helpers import device_registry as dr

        dev = dr.async_get(self.hass).async_get(device_id)
        return (dev.name_by_user or dev.name) if dev else None

    async def async_step_sensor_entities(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        defaults = self._prefill
        if user_input is not None:
            errors, wiring = validate_sensor(self.hass, user_input, "s1")
            if not errors:
                self._options[CONF_SENSORS] = [wiring]
                return self._finish()
            defaults = user_input
        return self.async_show_form(step_id="sensor_entities", data_schema=sensor_schema(defaults), errors=errors)

    def _finish(self) -> ConfigFlowResult:
        return self.async_create_entry(title=NAME, data={}, options=self._options)

    @staticmethod
    @callback
    def async_get_options_flow(config_entry) -> "ZonePresenceOptionsFlow":
        return ZonePresenceOptionsFlow()


def _device_schema() -> vol.Schema:
    return vol.Schema({
        vol.Optional("device"): selector.DeviceSelector(selector.DeviceSelectorConfig()),
        vol.Optional("name"): selector.TextSelector(),
    })


# ====================================================================== Optionen
class ZonePresenceOptionsFlow(OptionsFlow):
    def __init__(self) -> None:
        self._sid: str | None = None
        self._prefill: dict[str, Any] = {}

    def _opts(self) -> dict[str, Any]:
        o = dict(self.config_entry.options)
        o[CONF_SENSORS] = [dict(s) for s in o.get(CONF_SENSORS, [])]
        o.setdefault(CONF_SETTINGS, Settings().as_dict())
        o.setdefault(CONF_PANEL, True)
        o.setdefault(CONF_PANEL_TITLE, "")
        o.pop("language", None)  # bis 1.0.0: manuelle Sprache, jetzt automatisch
        o.setdefault(CONF_PIN, DEFAULT_PIN)
        o.setdefault(CONF_ALLOW_USER_EDIT, False)
        return o

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        menu = ["add_sensor", "settings", "display"]
        if self._opts()[CONF_SENSORS]:
            menu[1:1] = ["edit_sensor", "remove_sensor"]
        return self.async_show_menu(step_id="init", menu_options=menu)

    # ---- Sensor hinzufügen
    async def async_step_add_sensor(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            self._sid = next_sensor_id(self._opts()[CONF_SENSORS])
            self._prefill = guess_from_device(self.hass, user_input["device"]) if user_input.get("device") else {}
            name = user_input.get("name")
            if not name and user_input.get("device"):
                from homeassistant.helpers import device_registry as dr

                dev = dr.async_get(self.hass).async_get(user_input["device"])
                name = (dev.name_by_user or dev.name) if dev else None
            self._prefill["name"] = name or f"Sensor {self._sid[1:]}"
            return await self.async_step_sensor_entities()
        return self.async_show_form(step_id="add_sensor", data_schema=_device_schema())

    # ---- Sensor bearbeiten
    async def async_step_edit_sensor(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        sensors = self._opts()[CONF_SENSORS]
        if user_input is not None:
            self._sid = user_input["sensor"]
            w = next((s for s in sensors if s.get("id") == self._sid), {})
            self._prefill = wiring_to_form(w)
            return await self.async_step_sensor_entities()
        return self.async_show_form(step_id="edit_sensor", data_schema=_pick_schema(sensors))

    async def async_step_sensor_entities(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        defaults = self._prefill
        if user_input is not None:
            errors, wiring = validate_sensor(self.hass, user_input, self._sid or "s1")
            if not errors:
                opts = self._opts()
                sensors = opts[CONF_SENSORS]
                for i, s in enumerate(sensors):
                    if s.get("id") == wiring["id"]:
                        sensors[i] = wiring
                        break
                else:
                    sensors.append(wiring)
                return self.async_create_entry(data=opts)
            defaults = user_input
        return self.async_show_form(step_id="sensor_entities", data_schema=sensor_schema(defaults), errors=errors)

    # ---- Sensor entfernen
    async def async_step_remove_sensor(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        opts = self._opts()
        sensors = opts[CONF_SENSORS]
        errors: dict[str, str] = {}
        if user_input is not None:
            if not user_input.get("confirm"):
                errors["confirm"] = "confirm_required"
            else:
                opts[CONF_SENSORS] = [s for s in sensors if s.get("id") != user_input["sensor"]]
                return self.async_create_entry(data=opts)
        schema = _pick_schema(sensors).extend({vol.Required("confirm", default=False): selector.BooleanSelector()})
        return self.async_show_form(step_id="remove_sensor", data_schema=schema, errors=errors)

    # ---- Einstellungen
    async def async_step_settings(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        opts = self._opts()
        current = Settings.from_dict(opts[CONF_SETTINGS]).as_dict()
        if user_input is not None:
            opts[CONF_SETTINGS] = Settings.from_dict({**current, **user_input}).as_dict()
            return self.async_create_entry(data=opts)
        return self.async_show_form(step_id="settings", data_schema=settings_schema(current))

    # ---- Darstellung
    async def async_step_display(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        opts = self._opts()
        errors: dict[str, str] = {}
        if user_input is not None:
            edit = user_input.get(SECTION_EDIT) or {}
            pin = str(edit.get(CONF_PIN) or "").strip()
            if pin and not re.fullmatch(r"\d{4}", pin):
                errors["base"] = "invalid_pin"
            else:
                opts[CONF_PANEL] = user_input[CONF_PANEL]
                opts[CONF_PANEL_TITLE] = _title(user_input.get(CONF_PANEL_TITLE))
                opts[CONF_PIN] = pin
                opts[CONF_ALLOW_USER_EDIT] = bool(edit.get(CONF_ALLOW_USER_EDIT))
                return self.async_create_entry(data=opts)
        return self.async_show_form(
            step_id="display",
            data_schema=display_schema(opts),
            errors=errors,
        )


def display_schema(opts: dict[str, Any]) -> vol.Schema:
    """Darstellung + Bearbeiten-Abschnitt (der Hinweis steht als Abschnittsbeschreibung direkt über dem PIN)."""
    return vol.Schema({
        vol.Required(CONF_PANEL, default=opts[CONF_PANEL]): selector.BooleanSelector(),
        vol.Optional(CONF_PANEL_TITLE, description={"suggested_value": opts[CONF_PANEL_TITLE]}):
            selector.TextSelector(),
        vol.Required(SECTION_EDIT): section(
            vol.Schema({
                vol.Optional(CONF_PIN, description={"suggested_value": opts.get(CONF_PIN, DEFAULT_PIN)}):
                    selector.TextSelector(selector.TextSelectorConfig(type=selector.TextSelectorType.PASSWORD)),
                vol.Required(CONF_ALLOW_USER_EDIT, default=bool(opts.get(CONF_ALLOW_USER_EDIT))):
                    selector.BooleanSelector(),
            }),
            {"collapsed": False},
        ),
    })


def _pick_schema(sensors: list[dict]) -> vol.Schema:
    options = [
        selector.SelectOptionDict(value=str(s["id"]), label=f"{s.get('name') or s['id']} ({s['id']})") for s in sensors
    ]
    return vol.Schema({
        vol.Required("sensor"): selector.SelectSelector(
            selector.SelectSelectorConfig(options=options, mode=selector.SelectSelectorMode.DROPDOWN)
        )
    })
