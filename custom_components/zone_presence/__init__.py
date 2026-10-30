"""Zone Presence Detection by Kilian K.

Zone presence detection for mmWave radar sensors with position data (e.g. HLK-LD2450 via
ESPHome): rooms, zones, calibration, sitting/lying detection and a learning ghost filter -
all server-side, with its own dashboard card and sidebar panel. English by default,
German if Home Assistant runs in German.
"""
from __future__ import annotations

import hashlib
import logging
from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_CORE_CONFIG_UPDATE
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType

from . import services, websocket
from .const import (
    CARD_FILE,
    CARD_URL,
    CONF_PANEL,
    CONF_PANEL_TITLE,
    DOMAIN,
    FRONTEND_DIR,
    PANEL_COMPONENT,
    PANEL_ICON,
    PANEL_URL_PATH,
    PLATFORMS,
)
from .i18n import system_lang, tr
from .runtime import ZonePresenceRuntime, migrate_options_1_2

_LOGGER = logging.getLogger(__name__)

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

type ZonePresenceConfigEntry = ConfigEntry[ZonePresenceRuntime]

DATA_CARD_URL = f"{DOMAIN}_card_url"


def _file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:10]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Einmalig: Karte ausliefern, Websocket-Befehle und Dienste registrieren."""
    path = Path(__file__).parent / FRONTEND_DIR / CARD_FILE
    digest = await hass.async_add_executor_job(_file_hash, path)
    url = f"{CARD_URL}?v={digest}"
    if hass.http is not None:
        await hass.http.async_register_static_paths([StaticPathConfig(CARD_URL, str(path), False)])
    # Karte in allen Dashboards verfügbar machen (keine manuelle Ressource nötig)
    frontend.add_extra_js_url(hass, url)
    hass.data[DATA_CARD_URL] = url
    websocket.async_register(hass)
    services.async_register(hass)
    return True


async def async_migrate_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """1.0 -> 1.1: Wandtoleranz-Standard 0,3 -> 1,2 m, keine manuelle Sprache mehr."""
    if entry.version > 1:
        return False
    if entry.minor_version < 2:
        opts = migrate_options_1_2(entry.options)
        hass.config_entries.async_update_entry(entry, options=opts, minor_version=2)
        _LOGGER.info("Zone Presence Detection: Konfiguration auf Version 1.2 migriert")
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ZonePresenceConfigEntry) -> bool:
    runtime = ZonePresenceRuntime(hass, entry)
    await runtime.async_setup()
    entry.runtime_data = runtime
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))

    @callback
    def _on_core_config(_event: Event) -> None:
        # Systemsprache geändert -> Gerätemodelle, Standardnamen, Panel-Titel neu setzen
        if system_lang(hass) != runtime.lang:
            hass.config_entries.async_schedule_reload(entry.entry_id)

    entry.async_on_unload(hass.bus.async_listen(EVENT_CORE_CONFIG_UPDATE, _on_core_config))
    if entry.options.get(CONF_PANEL, True):
        await _async_register_panel(hass, entry)
    return True


async def _async_register_panel(hass: HomeAssistant, entry: ConfigEntry) -> None:
    frontend.async_remove_panel(hass, PANEL_URL_PATH, warn_if_unknown=False)
    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name=PANEL_COMPONENT,
        sidebar_title=entry.options.get(CONF_PANEL_TITLE) or tr(system_lang(hass), "panel_title"),
        sidebar_icon=PANEL_ICON,
        module_url=hass.data.get(DATA_CARD_URL, CARD_URL),
        require_admin=False,
        config={"entry_id": entry.entry_id},
    )


async def async_unload_entry(hass: HomeAssistant, entry: ZonePresenceConfigEntry) -> bool:
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        await entry.runtime_data.async_unload()
        frontend.async_remove_panel(hass, PANEL_URL_PATH, warn_if_unknown=False)
    return unloaded


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Options geändert (Sensoren/Einstellungen/Panel) -> neu laden."""
    await hass.config_entries.async_reload(entry.entry_id)


async def async_remove_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Gespeicherte Daten beim Entfernen der Integration löschen."""
    from homeassistant.helpers.storage import Store

    from .const import MODEL_STORE_VERSION, STORE_VERSION

    await Store(hass, STORE_VERSION, f"{DOMAIN}.{entry.entry_id}").async_remove()
    await Store(hass, MODEL_STORE_VERSION, f"{DOMAIN}.{entry.entry_id}.model").async_remove()
