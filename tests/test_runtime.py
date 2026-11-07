"""Tests der Laufzeit-Schicht (runtime.py) gegen eine minimale HA-Nachbildung."""
from __future__ import annotations

import asyncio
import importlib
import json
import pathlib
import sys
import time
import types
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import ha_stub  # noqa: E402

ha_stub.install()

_PKG_DIR = pathlib.Path(__file__).resolve().parents[1] / "custom_components" / "zone_presence"
if "zpe" not in sys.modules:
    _pkg = types.ModuleType("zpe")
    _pkg.__path__ = [str(_PKG_DIR)]
    sys.modules["zpe"] = _pkg
runtime_mod = importlib.import_module("zpe.runtime")
er = sys.modules["homeassistant.helpers.entity_registry"]
dr = sys.modules["homeassistant.helpers.device_registry"]
storage = sys.modules["homeassistant.helpers.storage"]


def wiring(sid: str, prefix: str, name: str) -> dict:
    return {
        "id": sid, "name": name, "scale": 0.001, "unit": "mm",
        "targets": [{"x": f"sensor.{prefix}_target{i}_x", "y": f"sensor.{prefix}_target{i}_y"} for i in (1, 2, 3)],
        "presence": f"binary_sensor.{prefix}_presence",
    }


OPTIONS = {
    "sensors": [wiring("s1", "ess", "Esszimmer"), wiring("s2", "wz", "Wohnzimmer")],
    "settings": {"confirm_time": 0, "off_delay": 10},
    "panel": True, "panel_title": "", "edit_pin": "1234",
}


def run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class RuntimeTest(unittest.TestCase):
    def setUp(self) -> None:
        storage.STORES.clear()
        er.ENT_REG.entities.clear()
        dr.DEV_REG.devices.clear()
        ha_stub.SENT.clear()
        ha_stub.NOTIFICATIONS.clear()
        ha_stub.TIME_LISTENERS.clear()
        self.hass = ha_stub.FakeHass()
        self.entry = ha_stub.FakeEntry(json.loads(json.dumps(OPTIONS)))
        self.rt = runtime_mod.ZonePresenceRuntime(self.hass, self.entry)
        run(self.rt.async_setup())

    def _make(self, system_language="en", **opts):
        storage.STORES.clear()
        o = json.loads(json.dumps(OPTIONS))
        o.update(opts)
        rt = runtime_mod.ZonePresenceRuntime(ha_stub.FakeHass(system_language), ha_stub.FakeEntry(o, "entry2"))
        run(rt.async_setup())
        return rt

    def test_language_follows_system_english(self):
        self.assertEqual(self.rt.lang, "en")
        self.assertEqual(self.rt.data["rooms"][0]["name"], "Room 1")
        self.assertEqual(self.rt.config_payload()["language"], "en")
        self.rt.engine.cal_result = {"cells": 7}
        self.rt.engine.cal_status = "done"
        self.rt._on_calibration_finished()
        self.assertIn("7 ghost cells", ha_stub.NOTIFICATIONS[-1]["message"])

    def test_language_follows_system_german(self):
        for code in ("de", "de-CH", "de_AT"):
            self.assertEqual(self._make(system_language=code).lang, "de", code)
        rt = self._make(system_language="de")
        self.assertEqual(rt.data["rooms"][0]["name"], "Raum 1")
        self.assertEqual(rt.config_payload()["language"], "de")
        rt.engine.cal_result = {"cells": 3, "disturbed_ratio": 0.4}
        rt.engine.cal_status = "disturbed"
        rt._on_calibration_finished()
        self.assertIn("40 % durch bewegte Personen", ha_stub.NOTIFICATIONS[-1]["message"])

    def test_language_other_falls_back_to_english(self):
        for code in ("fr", "nl", "en-GB", "", None):
            self.assertEqual(self._make(system_language=code).lang, "en", code)

    def test_old_language_option_ignored(self):
        # Option "language" aus 1.0.0 hat keine Wirkung mehr – maßgeblich ist Home Assistant
        self.assertEqual(self._make("en", **{"language": "de"}).lang, "en")
        self.assertEqual(self._make("de", **{"language": "en"}).lang, "de")

    def test_edit_rights(self):
        admin, user = ha_stub.FakeUser(True), ha_stub.FakeUser(False)
        self.assertTrue(self.rt.can_edit(admin))
        self.assertFalse(self.rt.can_edit(user))
        self.assertFalse(self.rt.can_edit(None))
        self.assertFalse(self.rt.config_payload()["allow_user_edit"])
        rt = self._make(allow_user_edit=True)
        self.assertTrue(rt.can_edit(user))
        self.assertTrue(rt.config_payload()["allow_user_edit"])

    def test_migration_1_2(self):
        mig = runtime_mod.migrate_options_1_2
        old = {"settings": {"wall_tolerance": 0.3, "off_delay": 12}, "language": "de", "edit_pin": "1234"}
        new = mig(old)
        self.assertEqual(new["settings"]["wall_tolerance"], 1.2)
        self.assertEqual(new["settings"]["off_delay"], 12)
        self.assertNotIn("language", new)
        self.assertEqual(new["edit_pin"], "1234")          # gesetzter PIN bleibt
        self.assertFalse(new["allow_user_edit"])
        self.assertEqual(mig({"settings": {"wall_tolerance": 0.8}})["settings"]["wall_tolerance"], 0.8)
        self.assertEqual(runtime_mod.Settings().wall_tolerance, 1.2)

    def test_pin_default_off(self):
        const = __import__("zpe.const", fromlist=["DEFAULT_PIN"])
        self.assertEqual(const.DEFAULT_PIN, "")

    def test_setup_defaults(self):
        d = self.rt.data
        self.assertEqual([r["id"] for r in d["rooms"]], ["r1"])
        self.assertEqual(d["geometry"]["s1"]["label"], "S1")
        self.assertEqual(d["geometry"]["s2"]["label"], "S2")
        self.assertEqual(d["geometry"]["s2"]["room"], "r1")
        names = sorted(dev.name for dev in dr.DEV_REG.devices.values())
        self.assertEqual(names, ["Room 1", "Zone Presence Detection"])
        room_dev = next(d for d in dr.DEV_REG.devices.values() if d.name == "Room 1")
        hub = next(d for d in dr.DEV_REG.devices.values() if d.name == "Zone Presence Detection")
        self.assertEqual(room_dev.via_device_id, hub.id, "Raum hängt unter dem Hub (via_device_id)")
        self.assertIn("zone_presence.entry1", storage.STORES)

    def test_payload(self):
        p = self.rt.config_payload()
        self.assertEqual(p["pin"], "1234")
        self.assertEqual(len(p["sensors"]), 2)
        self.assertEqual(p["sensors"][0]["entities"]["presence"], "binary_sensor.ess_presence")
        self.assertTrue(p["sensors"][0]["valid"])
        self.assertIn("off_delay", p["settings"])

    def test_apply_zones_numbers_and_entities(self):
        z = [{"id": "za", "room": "r1", "name": "Sofa", "points": [[1, 1], [2, 1], [2, 2], [1, 2]]},
             {"id": "zb", "room": "r1", "name": "Tisch", "points": [[3, 1], [4, 1], [4, 2], [3, 2]]}]
        cfg = self.rt.apply({"zones": z}, persist=True)
        nums = {x["id"]: x["num"] for x in cfg["zones"]}
        self.assertEqual(sorted(nums.values()), [1, 2])
        self.assertEqual(self.rt.zone_ids, {"za", "zb"})
        self.assertTrue(any(sig.startswith("zone_presence_new_") and args[1] == {"za", "zb"} for sig, args in ha_stub.SENT))
        self.assertEqual(self.rt.engine.zones["za"].display_name, "Sofa (Zone 1)")
        # Nummern bleiben stabil, neue Zone bekommt die nächste freie
        z2 = cfg["zones"] + [{"id": "zc", "room": "r1", "name": "Bett", "points": [[1, 3], [2, 3], [2, 4], [1, 4]]}]
        cfg = self.rt.apply({"zones": [x for x in z2 if x["id"] != "za"]}, persist=True)
        nums = {x["id"]: x["num"] for x in cfg["zones"]}
        self.assertEqual(nums, {"zb": 2, "zc": 3})

    def test_delete_zone_removes_entities_and_device(self):
        self.rt.apply({"zones": [{"id": "za", "room": "r1", "name": "Sofa", "points": [[1, 1], [2, 1], [2, 2], [1, 2]]}]}, True)
        er.ENT_REG.add("binary_sensor.sofa_zone_1", "entry1_zone_za_occupancy", "entry1")
        er.ENT_REG.add("sensor.sofa_zone_1_personenanzahl", "entry1_zone_za_count", "entry1")
        dr.DEV_REG.async_get_or_create(config_entry_id="entry1", identifiers={("zone_presence", "entry1_zone_za")}, name="Sofa (Zone 1)")
        self.rt.apply({"zones": []}, True)
        self.assertNotIn("binary_sensor.sofa_zone_1", er.ENT_REG.entities)
        self.assertNotIn("sensor.sofa_zone_1_personenanzahl", er.ENT_REG.entities)
        self.assertIsNone(dr.DEV_REG.async_get_device(identifiers={("zone_presence", "entry1_zone_za")}))

    def test_rename_zone_updates_device(self):
        self.rt.apply({"zones": [{"id": "za", "room": "r1", "name": "Sofa", "points": [[1, 1], [2, 1], [2, 2], [1, 2]]}]}, True)
        dev = dr.DEV_REG.async_get_or_create(config_entry_id="entry1", identifiers={("zone_presence", "entry1_zone_za")}, name="Sofa (Zone 1)")
        z = self.rt.data["zones"][0] | {"name": "Couch"}
        self.rt.apply({"zones": [z]}, True)
        self.assertEqual(dr.DEV_REG.devices[dev.id].name, "Couch (Zone 1)")

    def test_invalid_input_rejected(self):
        with self.assertRaises(ValueError):
            self.rt.apply({"zones": [{"id": "bad id!", "points": [[0, 0], [1, 0], [1, 1]]}]}, True)
        with self.assertRaises(ValueError):
            self.rt.apply({"rooms": []}, True)
        with self.assertRaises(ValueError):
            self.rt.apply({"zones": [{"id": "z1", "points": [[0, 0], [1, 0]]}]}, True)

    def test_sensor_geometry_and_live_detection(self):
        self.rt.apply({"zones": [{"id": "za", "room": "r1", "name": "Sofa", "points": [[1, 1], [3, 1], [3, 3], [1, 3]]}],
                       "sensors": {"s1": {"pos": [2, 0], "rot": 0}}}, True)
        Ev = sys.modules["homeassistant.core"].Event
        for eid, val in (("binary_sensor.ess_presence", "on"), ("sensor.ess_target1_x", "0"), ("sensor.ess_target1_y", "2000")):
            self.hass.states.set(eid, val)
            self.rt._on_state(Ev({"entity_id": eid, "new_state": self.hass.states.get(eid)}))
        self.rt._compute()
        time.sleep(0.05)
        self.hass.states.set("sensor.ess_target1_x", "1")
        self.rt._on_state(Ev({"entity_id": "sensor.ess_target1_x", "new_state": self.hass.states.get("sensor.ess_target1_x")}))
        self.rt._compute()
        zs = self.rt.engine.zone_state["za"]
        self.assertTrue(zs.on)
        self.assertEqual(zs.count, 1)
        self.assertTrue(any(sig.startswith("zone_presence_state_") and "z:za" in args[0] for sig, args in ha_stub.SENT))

    def test_live_preview_not_persisted(self):
        before = json.dumps(storage.STORES.get("zone_presence.entry1"))
        self.rt.apply({"sensors": {"s1": {"offset": {"dx": 0.5, "dy": 0, "dr": 0}}}}, persist=False)
        self.assertEqual(json.dumps(storage.STORES.get("zone_presence.entry1")), before)
        self.assertAlmostEqual(self.rt.engine.sensors["s1"].dx, 0.5)

    def test_import_legacy(self):
        s = self.hass.states
        s.set("input_text.zonen_room_1", json.dumps({"n": "Wohn-/Esszimmer", "p": [[0, 0], [7, 0], [7, 4], [3.45, 4], [3.45, 5.5], [0, 5.5]]}))
        s.set("input_text.zonen_zone_1", json.dumps({"r": 1, "n": "Sofa", "c": "#a78bfa", "e": True, "x": [], "p": [[4, 2], [6, 2], [6, 3.5], [4, 3.5]]}))
        s.set("input_text.zonen_zone_3", json.dumps({"r": 1, "n": "Esstisch", "c": "#34d399", "e": True, "x": [], "p": [[0.5, 1], [2.5, 1], [2.5, 3], [0.5, 3]]}))
        s.set("input_text.zonen_zone_2", "")
        s.set("input_text.zonen_cal_s1", json.dumps({"px": None, "py": None, "rot": None, "dx": 0.12, "dy": -0.05, "dr": 2}))
        s.set("input_text.zonen_cal_s2", json.dumps({"px": 6.5, "py": 0.1, "rot": 14, "dx": 0, "dy": 0, "dr": 0}))
        res = self.rt.import_legacy({
            "zone_prefix": "input_text.zonen_zone_", "room_prefix": "input_text.zonen_room_", "cal_prefix": "input_text.zonen_cal_",
            "max_zones": 12, "max_rooms": 4, "positions": {"S1": {"pos": [2.25, 0], "rot": 0}}, "replace": True,
        })
        self.assertEqual(res, {"rooms": 1, "zones": 2, "sensors": ["S1", "S2"]})
        zones = {z["name"]: z for z in self.rt.data["zones"]}
        self.assertEqual(zones["Sofa"]["num"], 1)
        self.assertEqual(zones["Esstisch"]["num"], 3, "alte Zonennummer bleibt erhalten")
        self.assertEqual(self.rt.engine.zones[zones["Esstisch"]["id"]].display_name, "Esstisch (Zone 3)")
        g1, g2 = self.rt.data["geometry"]["s1"], self.rt.data["geometry"]["s2"]
        self.assertEqual(g1["pos"], [2.25, 0])
        self.assertEqual(g1["offset"], {"dx": 0.12, "dy": -0.05, "dr": 2})
        self.assertEqual(g2["pos"], [6.5, 0.1])
        self.assertEqual(g2["rot"], 14)
        self.assertEqual(self.rt.data["rooms"][0]["name"], "Wohn-/Esszimmer")
        self.assertEqual(self.rt.data["next_zone_num"], 4)

    def test_calibration_schedule_and_finish(self):
        self.assertEqual(self.rt.calibration_status(), "idle")
        with self.assertRaises(ValueError):
            self.rt.set_control("cal_time", "25:00")
        self.rt.set_control("cal_time", "03:15")
        self.assertEqual(ha_stub.TIME_LISTENERS[-1]["hour"], 3)
        self.assertEqual(ha_stub.TIME_LISTENERS[-1]["minute"], 15)
        self.rt.set_control("cal_armed", True)
        self.assertEqual(self.rt.calibration_status(), "scheduled")
        self.assertIsNotNone(self.rt.next_calibration())
        ha_stub.TIME_LISTENERS[-1]["action"](None)   # 03:15 erreicht
        self.assertFalse(self.rt.data["controls"]["cal_armed"], "einmalig: nach Start wieder aus")
        self.assertEqual(self.rt.calibration_status(), "running")
        self.rt.engine.cal_end = time.monotonic() - 1
        self.rt._compute()
        self.assertEqual(self.rt.calibration_status(), "done")
        self.assertEqual(self.rt.data["cal_last"]["status"], "done")
        self.assertTrue(ha_stub.NOTIFICATIONS)
        self.assertIn("zone_presence.entry1.model", storage.STORES)

    def test_learning_switch_and_reset(self):
        self.rt.set_control("learning", False)
        self.assertFalse(self.rt.engine.learning_enabled)
        self.rt.engine.model.maps["s1"].add_ghost(1.0, 2.0, 2.0)
        self.assertGreater(self.rt.engine.model.maps["s1"].ghost_prob(1.0, 2.0), 0.5)
        self.rt.reset_model()
        self.assertEqual(self.rt.engine.model.maps["s1"].ghost_prob(1.0, 2.0), 0.0)

    def test_exclusions_apply_and_payload(self):
        ex = [{"id": "x1", "room": "r1", "name": "Ventilator", "points": [[1, 1], [2, 1], [2, 2], [1, 2]], "depth": 0.4, "learn": True}]
        self.rt.apply({"exclusions": ex}, True)
        p = self.rt.config_payload()
        self.assertEqual(p["exclusions"][0]["depth"], 0.4)
        self.assertTrue(p["exclusions"][0]["learn"])
        self.assertEqual(p["excl_color"], "#ff3b3b")
        self.assertNotIn(p["excl_color"], p["zone_colors"])
        self.assertIn("x1", self.rt.engine.exclusions)
        self.assertEqual(self.rt.zone_ids, set(), "Sperrzonen bekommen keine Entitäten")
        with self.assertRaises(ValueError):
            self.rt.apply({"exclusions": [{"id": "bad id!", "room": "r1", "points": [[0, 0], [1, 0], [1, 1]]}]}, True)
        # Raum gelöscht -> seine Sperrzonen auch
        self.rt.apply({"rooms": [{"id": "r9", "name": "X", "polygon": [[0, 0], [3, 0], [3, 3], [0, 3]]}]}, True)
        self.assertEqual(self.rt.data["exclusions"], [])

    def test_auto_zone_colors_never_exclusion_red(self):
        zones = [{"id": f"z{i}", "room": "r1", "name": "Z", "points": [[1, 1], [2, 1], [2, 2], [1, 2]]} for i in range(10)]
        self.rt.apply({"zones": zones}, True)
        self.assertTrue(all(z["color"] != "#ff3b3b" for z in self.rt.data["zones"]))

    def test_model_view_forget_export_import(self):
        m = self.rt.engine.model
        for _ in range(10):
            m.learn_ghost("s1", 0.0, 2.0, 1.0)
        rid = self.rt.data["rooms"][0]["id"]
        view = run(self.rt.async_model_view(rid, history=True))
        self.assertIn("spots", view)
        self.assertIn("history", view)
        self.assertEqual(view["level"], 2)
        exp = json.loads(json.dumps(self.rt.model_export()))
        self.rt.reset_model()
        self.assertEqual(m.maps["s1"].ghost_prob(0.0, 2.0), 0.0)
        res = self.rt.model_import(exp)
        self.assertIn("s1", res["sensors"])
        self.assertGreater(self.rt.engine.model.maps["s1"].ghost_prob(0.0, 2.0), 0.5)
        with self.assertRaises(ValueError):
            self.rt.model_import({"foo": 1})
        with self.assertRaises(ValueError):
            run(self.rt.async_model_view("nope"))

    def test_old_model_store_migrated(self):
        storage.STORES.clear()
        idx = 8 * 48 + 28
        storage.STORES["zone_presence.entry2.model"] = {"maps": {"s1": {"range": 6.0, "cell": 0.25,
                                                                         "cal": {str(idx): 3.0}, "ghost": {}, "real": {}}}}
        o = json.loads(json.dumps(OPTIONS))
        rt = runtime_mod.ZonePresenceRuntime(ha_stub.FakeHass(), ha_stub.FakeEntry(o, "entry2"))
        run(rt.async_setup())
        self.assertGreater(rt.engine.model.maps["s1"].ghost_prob(1.12, 2.12), 0.8)
        self.assertEqual(rt._model_to_save()["version"], 2)

    def test_rate_alarm_notification(self):
        m = self.rt.engine.model
        m.daily["s1"] = {f"2026-01-0{d}": [5.0, 20.0, 0.0] for d in range(1, 8)}
        m.set_day("2026-01-09")
        m.count("s1", 0, 80)
        ha_stub.NOTIFICATIONS.clear()
        self.rt._hourly(None)
        self.assertTrue(ha_stub.NOTIFICATIONS)
        n = len(ha_stub.NOTIFICATIONS)
        self.rt._hourly(None)
        self.assertEqual(len(ha_stub.NOTIFICATIONS), n, "nur einmal pro Tag")

    def test_reload_restores_state(self):
        self.rt.apply({"zones": [{"id": "za", "room": "r1", "name": "Sofa", "points": [[1, 1], [2, 1], [2, 2], [1, 2]]}]}, True)
        self.rt.set_control("cal_duration", 90)
        run(self.rt.async_unload())
        rt2 = runtime_mod.ZonePresenceRuntime(self.hass, self.entry)
        run(rt2.async_setup())
        self.assertEqual(rt2.zone_ids, {"za"})
        self.assertEqual(rt2.data["controls"]["cal_duration"], 90)
        self.assertEqual(rt2.engine.zones["za"].num, 1)

    def test_removed_sensor_ignored(self):
        self.entry.options["sensors"] = [OPTIONS["sensors"][0], {"id": "s9", "targets": [{"x": "sensor.a", "y": ""}]}]
        rt2 = runtime_mod.ZonePresenceRuntime(self.hass, self.entry)
        run(rt2.async_setup())
        self.assertEqual(set(rt2.engine.sensors), {"s1"}, "Sensor ohne y bei Target 1 wird nicht verwendet")
        payload = rt2.config_payload()
        self.assertFalse(next(s for s in payload["sensors"] if s["id"] == "s9")["valid"])


if __name__ == "__main__":
    unittest.main()
