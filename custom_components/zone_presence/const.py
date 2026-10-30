"""Konstanten für Zone Presence Detection by Kilian K."""
from __future__ import annotations

from homeassistant.const import Platform

DOMAIN = "zone_presence"
NAME = "Zone Presence Detection by Kilian K."
MANUFACTURER = "Kilian K."
VERSION = "1.1.0"

PLATFORMS: list[Platform] = [
    Platform.BINARY_SENSOR,
    Platform.SENSOR,
    Platform.BUTTON,
    Platform.SWITCH,
    Platform.NUMBER,
    Platform.TIME,
]

STORE_VERSION = 1
MODEL_STORE_VERSION = 1

# Frontend
FRONTEND_DIR = "frontend"
CARD_FILE = "zone-presence-card.js"
CARD_URL = f"/{DOMAIN}/{CARD_FILE}"
PANEL_URL_PATH = "zone-presence"
PANEL_COMPONENT = "zone-presence-panel"
PANEL_ICON = "mdi:motion-sensor"

# Options-Schlüssel
CONF_SENSORS = "sensors"
CONF_SETTINGS = "settings"
CONF_PANEL = "panel"
CONF_PANEL_TITLE = "panel_title"
CONF_PIN = "edit_pin"
CONF_ALLOW_USER_EDIT = "allow_user_edit"
DEFAULT_PIN = ""  # PIN standardmäßig aus

# Laufzeit
TICK_INTERVAL = 0.25        # s Zeitbasis für Timeouts/Glättung
DEBOUNCE = 0.06             # s x/y-Updates zusammenfassen
PUSH_INTERVAL = 0.1         # s max. Live-Updates an die Karte
HEARTBEAT = 2.0             # s Live-Update auch ohne Änderung
MODEL_SAVE_INTERVAL = 600   # s Lernmodell speichern

DEFAULT_CAL_TIME = "03:00"
DEFAULT_CAL_DURATION = 120  # min

SENSOR_COLORS = ["#38bdf8", "#f59e0b", "#a3e635", "#f472b6", "#c084fc", "#fb7185", "#34d399", "#facc15"]
ZONE_COLORS = ["#a78bfa", "#f472b6", "#34d399", "#fbbf24", "#60a5fa", "#fb7185", "#4ade80", "#c084fc"]

CAL_STATUSES = ["idle", "scheduled", "running", "done", "disturbed", "aborted"]


def signal_state(entry_id: str) -> str:
    return f"{DOMAIN}_state_{entry_id}"


def signal_hub(entry_id: str) -> str:
    return f"{DOMAIN}_hub_{entry_id}"


def signal_new_entities(entry_id: str) -> str:
    return f"{DOMAIN}_new_{entry_id}"
