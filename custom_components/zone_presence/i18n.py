"""Language - follows Home Assistant automatically, there is no manual setting.

* Everything Home Assistant can translate itself (setup/options dialogs, entity names,
  states, services) uses the integration's translation files in the HA language;
  languages without a translation fall back to English.
* Texts the integration writes itself (device models, default room/zone names,
  notifications, sidebar title) only exist in English and German: German only if the
  Home Assistant *system* language is German, otherwise English.
* The card/panel follows the language of the viewing user (German or English).
"""
from __future__ import annotations

from typing import Any

LANGUAGES = ("en", "de")
DEFAULT_LANGUAGE = "en"

STRINGS: dict[str, dict[str, str]] = {
    "en": {
        "panel_title": "Zone Presence",
        "room": "Room {n}",
        "zone": "Zone {n}",
        "model_hub": "Hub",
        "model_room": "Room",
        "model_zone": "Presence zone",
        "cal_done": "The learning calibration has finished. {cells} ghost cells were learned.",
        "cal_disturbed": (
            "The learning calibration has finished, but {pct} % of it was disturbed by moving people. "
            "Only the undisturbed parts were learned ({cells} cells). Repeat it with an empty room for a "
            "better result."
        ),
    },
    "de": {
        "panel_title": "Präsenz-Zonen",
        "room": "Raum {n}",
        "zone": "Zone {n}",
        "model_hub": "Hub",
        "model_room": "Raum",
        "model_zone": "Präsenzzone",
        "cal_done": "Die Lernkalibrierung ist abgeschlossen. {cells} Geister-Zellen wurden gelernt.",
        "cal_disturbed": (
            "Die Lernkalibrierung ist abgeschlossen, war aber zu {pct} % durch bewegte Personen gestört. "
            "Gelernt wurden nur die ungestörten Anteile ({cells} Zellen). Für ein besseres Ergebnis bei "
            "leerem Raum wiederholen."
        ),
    },
}


def norm_lang(value: Any) -> str:
    """'de', 'de-CH', 'de_AT' -> 'de'; everything else -> 'en'."""
    v = str(value or "").lower().replace("_", "-").split("-")[0]
    return v if v in LANGUAGES else DEFAULT_LANGUAGE


def system_lang(hass: Any) -> str:
    """Language of the Home Assistant instance (Settings → System → General)."""
    return norm_lang(getattr(getattr(hass, "config", None), "language", None))


def tr(lang: str, key: str, **kw: Any) -> str:
    text = STRINGS[norm_lang(lang)].get(key) or STRINGS[DEFAULT_LANGUAGE][key]
    return text.format(**kw) if kw else text
