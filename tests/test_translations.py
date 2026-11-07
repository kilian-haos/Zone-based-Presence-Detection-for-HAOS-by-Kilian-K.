"""Konsistenz: Übersetzungen ↔ Code, Einstellungen, Dienste, Manifest."""
from __future__ import annotations

import importlib
import json
import pathlib
import re
import sys
import types
import unittest

import yaml

PKG = pathlib.Path(__file__).resolve().parents[1] / "custom_components" / "zone_presence"
if "zpe" not in sys.modules:
    _p = types.ModuleType("zpe")
    _p.__path__ = [str(PKG)]
    sys.modules["zpe"] = _p
Settings = importlib.import_module("zpe.engine").Settings
SRC = "\n".join(p.read_text() for p in PKG.glob("*.py"))


class TranslationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tr = {lang: json.loads((PKG / "translations" / f"{lang}.json").read_text()) for lang in ("de", "en")}

    def test_same_keys_de_en(self):
        def keys(d, prefix=""):
            out = set()
            for k, v in d.items():
                out.add(prefix + k)
                if isinstance(v, dict):
                    out |= keys(v, prefix + k + ".")
            return out
        self.assertEqual(keys(self.tr["de"]), keys(self.tr["en"]))

    def test_entity_translation_keys(self):
        used = set(re.findall(r'_attr_translation_key = "(\w+)"', SRC))
        used |= set(re.findall(r'super\(\).__init__\((?:rt|runtime), "(\w+)"\)', SRC))
        used |= set(re.findall(r'ControlSwitch\(rt, "(\w+)"', SRC))
        known = {k for plat in self.tr["de"]["entity"].values() for k in plat}
        self.assertTrue(used, "keine Schlüssel gefunden")
        self.assertEqual(used - known, set())

    def test_settings_labels(self):
        fields = set(Settings().as_dict())
        for lang in ("de", "en"):
            data = set(self.tr[lang]["options"]["step"]["settings"]["data"])
            self.assertEqual(fields, data, lang)

    def test_flow_steps(self):
        cfg_steps = set(re.findall(r'async_step_(\w+)\(', (PKG / "config_flow.py").read_text()))
        de = self.tr["de"]
        for s in ("user", "sensor_device", "sensor_entities"):
            self.assertIn(s, de["config"]["step"])
        for s in ("init", "add_sensor", "edit_sensor", "sensor_entities", "remove_sensor", "settings", "display"):
            self.assertIn(s, de["options"]["step"])
            self.assertIn(s, cfg_steps)
        errors = set(re.findall(r'errors\[[^\]]+\] = "(\w+)"|setdefault\("\w+", "(\w+)"\)', (PKG / "config_flow.py").read_text()))
        errors = {e for pair in errors for e in pair if e}
        self.assertEqual(errors - set(de["options"]["error"]), set())

    def test_services(self):
        services = yaml.safe_load((PKG / "services.yaml").read_text())
        for name, spec in services.items():
            self.assertIn(name, self.tr["de"]["services"], name)
            for field in (spec or {}).get("fields", {}):
                self.assertIn(field, self.tr["de"]["services"][name]["fields"], f"{name}.{field}")
        registered = set(re.findall(r'SERVICE_\w+ = "(\w+)"', (PKG / "services.py").read_text()))
        self.assertEqual(registered, set(services))

    def test_card_i18n_same_keys(self):
        card = (PKG / "frontend" / "zone-presence-card.js").read_text()
        block = card[card.index("const I18N = {"):card.index("const normLang")]
        en_part, de_part = block.split("\n  de: {")

        def keys(part):
            return set(re.findall(r'(?:^|[\s,{])(\w+): "', part))

        self.assertGreater(len(keys(en_part)), 60)
        self.assertEqual(keys(en_part), keys(de_part))
        used = set(re.findall(r'_t\("(\w+)"', card)) | set(re.findall(r'\bt\("(\w+)"\)', card))
        # Dynamische Schlüssel: Präfix + Liste (Ebenen, Vorlagen, Legende, Voreinstellungen)
        lists = {
            "lay_": re.search(r"const LAYERS = \[([^\]]+)\]", card).group(1),
            "tpl_": " ".join(re.findall(r'\{ k: "(\w+)"', card)),
            "leg_": re.search(r"const MODEL_LAYERS = \[([^\]]+)\]", card).group(1),
            "preset_": "minimal standard diag all",
        }
        for prefix, items in lists.items():
            self.assertIn(prefix, used)
            used.discard(prefix)
            for item in re.findall(r"\w+", items):
                used.add(prefix + item)
        self.assertEqual(used - keys(en_part), set())

    def test_backend_i18n_same_keys(self):
        i18n = importlib.import_module("zpe.i18n")
        self.assertEqual(set(i18n.STRINGS["en"]), set(i18n.STRINGS["de"]))
        self.assertEqual(i18n.norm_lang(None), "en")
        self.assertEqual(i18n.norm_lang("de-DE"), "de")

    def test_display_section(self):
        flow = (PKG / "config_flow.py").read_text()
        self.assertIn('SECTION_EDIT = "editing"', flow)
        self.assertNotIn("CONF_LANGUAGE", flow)
        for lang in ("de", "en"):
            disp = self.tr[lang]["options"]["step"]["display"]
            sec = disp["sections"]["editing"]
            self.assertEqual(set(sec["data"]), {"edit_pin", "allow_user_edit"}, lang)
            self.assertIn("PIN", sec["description"])
            self.assertNotIn("language", disp["data"])
            self.assertNotIn("language", self.tr[lang]["config"]["step"]["user"]["data"])

    def test_manifest(self):
        m = json.loads((PKG / "manifest.json").read_text())
        keys = list(m)
        self.assertEqual(keys[:2], ["domain", "name"])
        self.assertEqual(keys[2:], sorted(keys[2:]), "hassfest erwartet sortierte Schlüssel")
        const = (PKG / "const.py").read_text()
        self.assertIn(f'VERSION = "{m["version"]}"', const)
        card = (PKG / "frontend" / "zone-presence-card.js").read_text()
        self.assertIn(f'const VERSION = "{m["version"]}"', card)


if __name__ == "__main__":
    unittest.main()
