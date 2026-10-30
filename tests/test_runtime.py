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
    "panel": True, "panel_title": "Präsenz-Zonen", "edit_pin": "1234",
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

    def test_setup_defaults(self):
        d = self.rt.data
        self.assertEqual([r["id"] for r in d["rooms"]], ["r1"])
        self.assertEqual(d["geometry"]["s1"]["label"], "S1")
        self.assertEqual(d["geometry"]["s2"]["label"], "S2")
        self.assertEqual(d["geometry"]["s2"]["room"], "r1")
        names = sorted(dev.name for dev in dr.DEV_REG.devices.values())
        self.assertEqual(names, ["Raum 1", "Zone Presence Detection"])
        room_dev = next(d for d in dr.DEV_REG.devices.values() if d.name == "Raum 1")
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
        self.rt.engine.model.maps["s1"].ghost[5] = 2.0
        self.rt.reset_model()
        self.assertEqual(self.rt.engine.model.maps["s1"].ghost, {})

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
