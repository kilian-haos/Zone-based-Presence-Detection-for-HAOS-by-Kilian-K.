"""Tests der Engine ohne Home Assistant (python -m unittest / pytest)."""
from __future__ import annotations

import importlib
import pathlib
import sys
import types
import unittest

# Engine-Module laden, ohne custom_components/zone_presence/__init__.py (HA) auszuführen
_PKG_DIR = pathlib.Path(__file__).resolve().parents[1] / "custom_components" / "zone_presence"
if "zpe" not in sys.modules:
    _pkg = types.ModuleType("zpe")
    _pkg.__path__ = [str(_PKG_DIR)]
    sys.modules["zpe"] = _pkg
engine_mod = importlib.import_module("zpe.engine")
geometry = importlib.import_module("zpe.geometry")
Engine = engine_mod.Engine
Settings = engine_mod.Settings

ROOM = [{"id": "r1", "name": "Raum", "polygon": [[0, 0], [6, 0], [6, 6], [0, 6]]}]


def sensor_wiring(sid: str, prefix: str, presence: bool = True) -> dict:
    return {
        "id": sid,
        "targets": [{"x": f"sensor.{prefix}_t{i}_x", "y": f"sensor.{prefix}_t{i}_y"} for i in (1, 2, 3)],
        "presence": f"binary_sensor.{prefix}_presence" if presence else None,
        "scale": 0.001,
    }


def make_engine(sensors=None, zones=None, settings=None, rooms=ROOM) -> Engine:
    eng = Engine(Settings.from_dict(settings or {}))
    sensors = sensors or [(sensor_wiring("s1", "a"), {"label": "S1", "room": "r1", "pos": [2, 0], "rot": 0})]
    scfg = {}
    for idx, (w, g) in enumerate(sensors):
        s = engine_mod.parse_sensor(w, g, idx)
        scfg[s.id] = s
    eng.set_config(engine_mod.parse_rooms(rooms), scfg, engine_mod.parse_zones(zones or []))
    return eng


class Feeder:
    """Simuliert ESPHome-Zustände inkl. leichtem Rauschen (echte Person jittert)."""

    def __init__(self, eng: Engine) -> None:
        self.eng = eng
        self.t = 0.0
        self.k = 0

    def set(self, prefix: str, slot: int, x_mm: float | None, y_mm: float | None, jitter: bool = True) -> None:
        j = 0.0
        if jitter and x_mm is not None and y_mm is not None and not (x_mm == 0 and y_mm == 0):
            self.k += 1
            j = (self.k % 3) - 1  # -1,0,1 mm
        xv = None if x_mm is None else str(x_mm + j)
        yv = None if y_mm is None else str(y_mm)
        self.eng.ingest(f"sensor.{prefix}_t{slot}_x", xv, self.t)
        self.eng.ingest(f"sensor.{prefix}_t{slot}_y", yv, self.t)

    def presence(self, prefix: str, on: bool) -> None:
        self.eng.ingest(f"binary_sensor.{prefix}_presence", "on" if on else "off", self.t)

    def run(self, seconds: float, step: float = 0.25, each=None) -> set:
        changed = set()
        end = self.t + seconds
        while self.t < end - 1e-9:
            self.t += step
            if each:
                each(self)
            changed |= self.eng.compute(self.t)
        return changed


def zone(zid="z1", num=1, pts=None, room="r1", **kw):
    return {"id": zid, "num": num, "room": room, "name": kw.pop("name", "Sofa"),
            "points": pts or [[1, 1.5], [3, 1.5], [3, 2.5], [1, 2.5]], **kw}


class TestGeometry(unittest.TestCase):
    def test_transform(self):
        self.assertEqual(tuple(round(v, 6) for v in geometry.sensor_to_room(0, 1, [2, 0], 0)), (2.0, 1.0))
        p = geometry.sensor_to_room(0, 1, [2, 0], 90)
        self.assertAlmostEqual(p[0], 1.0)
        self.assertAlmostEqual(p[1], 0.0, places=6)

    def test_poly(self):
        sq = [[0, 0], [2, 0], [2, 2], [0, 2]]
        self.assertTrue(geometry.point_in_poly(1, 1, sq))
        self.assertFalse(geometry.point_in_poly(3, 1, sq))
        self.assertAlmostEqual(geometry.dist_to_poly_edge((3, 1), sq), 1.0)


class TestBasics(unittest.TestCase):
    def test_person_enters_zone_and_off_delay(self):
        eng = make_engine(zones=[zone()], settings={"off_delay": 5})
        f = Feeder(eng)
        f.presence("a", True)
        f.set("a", 1, 0, 2000)  # Raum (2,2) in der Zone
        f.run(0.5, each=lambda ff: ff.set("a", 1, 0, 2000))
        self.assertFalse(eng.zone_state["z1"].on, "vor Mindestalter noch nicht bestätigt")
        f.run(1.5, each=lambda ff: ff.set("a", 1, 0, 2000))
        self.assertTrue(eng.zone_state["z1"].on)
        self.assertEqual(eng.zone_state["z1"].count, 1)
        f.set("a", 1, 0, 0)  # Target weg
        f.run(3)
        self.assertTrue(eng.zone_state["z1"].on, "Nachlauf aktiv")
        self.assertEqual(eng.zone_state["z1"].count, 0)
        f.run(3)
        self.assertFalse(eng.zone_state["z1"].on)

    def test_zone_off_delay_override(self):
        eng = make_engine(zones=[zone(off_delay=1)], settings={"off_delay": 30})
        f = Feeder(eng)
        f.run(2, each=lambda ff: ff.set("a", 1, 0, 2000))
        f.set("a", 1, 0, 0)
        f.run(1.5)
        self.assertFalse(eng.zone_state["z1"].on)

    def test_stuck_target_is_dropped(self):
        eng = make_engine(zones=[zone()], settings={"off_delay": 0, "stuck_timeout": 3})
        f = Feeder(eng)
        f.run(2, each=lambda ff: ff.set("a", 1, 0, 2000))
        self.assertTrue(eng.zone_state["z1"].on)
        f.run(3.5)  # keine Änderung mehr -> eingefroren
        self.assertEqual(len(eng.persons), 0)
        self.assertFalse(eng.zone_state["z1"].on)

    def test_presence_off_drops_targets(self):
        eng = make_engine(zones=[zone()], settings={"off_delay": 0})
        f = Feeder(eng)
        f.presence("a", True)
        f.run(2, each=lambda ff: ff.set("a", 1, 0, 2000))
        self.assertEqual(len(eng.persons), 1)
        f.presence("a", False)
        f.run(0.5, each=lambda ff: ff.set("a", 1, 0, 2000))
        self.assertEqual(len(eng.persons), 0)

    def test_presence_optional(self):
        eng = make_engine(sensors=[(sensor_wiring("s1", "a", presence=False), {"room": "r1", "pos": [2, 0]})])
        f = Feeder(eng)
        f.run(2, each=lambda ff: ff.set("a", 1, 0, 2000))
        self.assertEqual(len(eng.persons), 1)

    def test_target1_xy_required(self):
        w = {"id": "s9", "targets": [{"x": "sensor.x", "y": None}]}
        self.assertIsNone(engine_mod.parse_sensor(w, {}, 0))

    def test_two_persons_count(self):
        eng = make_engine(zones=[zone(pts=[[0.5, 1], [4, 1], [4, 3], [0.5, 3]])])
        f = Feeder(eng)

        def both(ff):
            ff.set("a", 1, -800, 2000)
            ff.set("a", 2, 800, 2000)
        f.run(2, each=both)
        self.assertEqual(eng.zone_state["z1"].count, 2)

    def test_settings_clamped(self):
        s = Settings.from_dict({"off_delay": -5, "still_radius": 99, "ghost_strength": 300, "learning_speed": "x"})
        self.assertEqual(s.off_delay, 0)
        self.assertEqual(s.still_radius, 3)
        self.assertEqual(s.ghost_strength, 100)
        self.assertEqual(s.learning_speed, "normal")


class TestStillAndDrift(unittest.TestCase):
    def test_lying_person_drifting_stays_in_zone(self):
        # Zone endet bei y=2.5; liegende Person bei y=2.3, Rohwerte driften langsam auf y=2.8
        eng = make_engine(zones=[zone()], settings={"off_delay": 0})
        f = Feeder(eng)
        f.run(8, each=lambda ff: ff.set("a", 1, 0, 2300))
        self.assertTrue(eng.tracks["s1:0"].still)
        self.assertTrue(eng.zone_state["z1"].on)
        state = {"y": 2300.0}

        def drift(ff):
            state["y"] = min(2800.0, state["y"] + 5)  # 2 cm/s
            ff.set("a", 1, 0, state["y"])
        f.run(30, each=drift)
        self.assertTrue(eng.tracks["s1:0"].still, "Drift innerhalb 70 cm bleibt Sitz-/Liege-Modus")
        self.assertTrue(eng.zone_state["z1"].on, "Liegende Person bleibt trotz Drift in der Zone")

    def test_walking_out_leaves_zone(self):
        eng = make_engine(zones=[zone()], settings={"off_delay": 0})
        f = Feeder(eng)
        f.run(3, each=lambda ff: ff.set("a", 1, 0, 2000))
        self.assertTrue(eng.zone_state["z1"].on)
        f.run(3, each=lambda ff: ff.set("a", 1, 0, 4500))  # klar aus der Zone gegangen
        self.assertFalse(eng.zone_state["z1"].on)


class TestWalls(unittest.TestCase):
    def test_far_outside_rejected(self):
        eng = make_engine(zones=[], settings={"wall_tolerance": 0.3})
        f = Feeder(eng)
        f.run(2, each=lambda ff: ff.set("a", 1, 0, 7000))  # y=7, Raum endet bei 6
        self.assertEqual(len(eng.persons), 0)
        self.assertTrue(any(r["r"] == "wall" for r in eng.rejected))

    def test_slightly_outside_clamped(self):
        eng = make_engine(zones=[], settings={"wall_tolerance": 0.3})
        f = Feeder(eng)
        f.run(2, each=lambda ff: ff.set("a", 1, 0, 6150))
        self.assertEqual(len(eng.persons), 1)
        self.assertLessEqual(eng.persons[0].pos[1], 6.0)

    def test_wall_filter_off(self):
        eng = make_engine(zones=[], settings={"wall_filter": False})
        f = Feeder(eng)
        f.run(2, each=lambda ff: ff.set("a", 1, 0, 7000))
        self.assertEqual(len(eng.persons), 1)


class TestGhostFilter(unittest.TestCase):
    def _calibrate_ghost(self, eng, f, x_mm, y_mm, seconds=120):
        eng.calibration_start(f.t, seconds)
        # Geister: ortsfest, kommt und geht
        def blink(ff):
            on = int(ff.t * 2) % 6 < 4
            ff.set("a", 1, x_mm if on else 0, y_mm if on else 0)
        f.run(seconds + 1, each=blink)
        self.assertFalse(eng.cal_active)
        self.assertEqual(eng.cal_status, "done")

    def test_calibrated_ghost_suppressed(self):
        eng = make_engine(zones=[zone()])
        f = Feeder(eng)
        self._calibrate_ghost(eng, f, 1500, 4000)
        self.assertGreater(eng.model.maps["s1"].ghost_prob(1.5, 4.0), 0.6)
        f.set("a", 1, 0, 0)
        f.run(1)
        f.run(10, each=lambda ff: ff.set("a", 1, 1500, 4000))
        self.assertEqual(len(eng.persons), 0, "ortsfester Geist wird unterdrückt")

    def test_person_walking_into_ghost_cell_passes(self):
        eng = make_engine(zones=[])
        f = Feeder(eng)
        self._calibrate_ghost(eng, f, 1500, 4000)
        f.set("a", 1, 0, 0)
        f.run(1)
        state = {"y": 1500.0}

        def walk(ff):
            state["y"] = min(4000.0, state["y"] + 250)  # 1 m/s
            ff.set("a", 1, 1500, state["y"])
        f.run(4, each=walk)
        f.run(10, each=lambda ff: ff.set("a", 1, 1500, 4000))
        self.assertEqual(len(eng.persons), 1, "hereingelaufene Person bleibt bestätigt")
        self.assertTrue(eng.tracks["s1:0"].proven)

    def test_corroboration_beats_ghost_map(self):
        sensors = [
            (sensor_wiring("s1", "a"), {"label": "S1", "room": "r1", "pos": [2, 0], "rot": 0}),
            (sensor_wiring("s2", "b"), {"label": "S2", "room": "r1", "pos": [5.5, 4], "rot": 90}),
        ]
        eng = make_engine(sensors=sensors)
        f = Feeder(eng)
        self._calibrate_ghost(eng, f, 1500, 4000)
        f.set("a", 1, 0, 0)
        f.run(1)
        # S1 sieht (3.5, 4.0); S2 bei (5.5,4) rot 90 schaut nach -x: forward=(-1,0) -> ys=2.0 -> (3.5,4)
        f.run(5, each=lambda ff: (ff.set("a", 1, 1500, 4000), ff.set("b", 1, 0, 2000)))
        self.assertEqual(len(eng.persons), 1)
        self.assertEqual(len(eng.persons[0].tracks), 2, "beide Sensoren zu einer Person zusammengefasst")

    def test_calibration_disturbed_by_real_person(self):
        eng = make_engine(zones=[])
        f = Feeder(eng)
        eng.calibration_start(f.t, 60)
        state = {"y": 500.0, "d": 1}

        def pace(ff):
            state["y"] += 200 * state["d"]
            if state["y"] > 5000 or state["y"] < 500:
                state["d"] *= -1
            ff.set("a", 1, 0, state["y"])
        f.run(61, each=pace)
        self.assertEqual(eng.cal_status, "disturbed")
        self.assertEqual(len(eng.model.maps["s1"].cal), 0, "laufende Person wird nicht als Geist gelernt")

    def test_online_ghost_learning(self):
        eng = make_engine(zones=[])
        f = Feeder(eng)
        before = eng.model.maps["s1"].ghost_prob(-1.0, 3.0)
        for _ in range(12):
            f.run(0.75, each=lambda ff: ff.set("a", 1, -1000, 3000))  # kurz, ortsfest
            f.set("a", 1, 0, 0)
            f.run(1.0)
        after = eng.model.maps["s1"].ghost_prob(-1.0, 3.0)
        self.assertGreater(after, before + 0.3)

    def test_learning_disabled(self):
        eng = make_engine(zones=[])
        eng.learning_enabled = False
        f = Feeder(eng)
        for _ in range(12):
            f.run(0.75, each=lambda ff: ff.set("a", 1, -1000, 3000))
            f.set("a", 1, 0, 0)
            f.run(1.0)
        self.assertEqual(eng.model.maps["s1"].ghost_prob(-1.0, 3.0), 0.0)

    def test_ghost_filter_off_confirms_immediately(self):
        eng = make_engine(zones=[], settings={"ghost_filter": False})
        f = Feeder(eng)
        f.run(0.25, each=lambda ff: ff.set("a", 1, 0, 2000))
        self.assertEqual(len(eng.persons), 1)


class TestTrackingAndCalibration(unittest.TestCase):
    def test_jump_creates_new_track(self):
        eng = make_engine(zones=[])
        f = Feeder(eng)
        f.run(2, each=lambda ff: ff.set("a", 1, 0, 1000))
        born = eng.tracks["s1:0"].born
        f.run(0.25, each=lambda ff: ff.set("a", 1, 0, 5000))  # 4 m in 0,25 s
        self.assertNotEqual(eng.tracks["s1:0"].born, born)

    def test_offset_change_keeps_track(self):
        sensors = [(sensor_wiring("s1", "a"), {"label": "S1", "room": "r1", "pos": [2, 0], "rot": 0})]
        eng = make_engine(sensors=sensors, zones=[])
        f = Feeder(eng)
        f.run(2, each=lambda ff: ff.set("a", 1, 0, 2000))
        born = eng.tracks["s1:0"].born
        s = engine_mod.parse_sensor(sensors[0][0], {**sensors[0][1], "offset": {"dx": 0.5}}, 0)
        eng.set_config(eng.rooms, {"s1": s}, eng.zones)
        f.run(0.25, each=lambda ff: ff.set("a", 1, 0, 2000))
        self.assertEqual(eng.tracks["s1:0"].born, born)
        self.assertAlmostEqual(eng.persons[0].pos[0], 2.5, places=1)

    def test_auto_calibrate_distribution(self):
        # S1 bei (0,0) sieht Person 1 m entfernt, S2 bei (6,0) 2 m entfernt; Messungen 0,3 m auseinander
        sensors = [
            (sensor_wiring("s1", "a"), {"label": "S1", "room": "r1", "pos": [0, 0], "rot": 0}),
            (sensor_wiring("s2", "b"), {"label": "S2", "room": "r1", "pos": [6, 0], "rot": 0}),
        ]
        eng = make_engine(sensors=sensors, zones=[], settings={"ghost_filter": False})
        f = Feeder(eng)
        # S1 meldet (1.0, 0.5) -> d≈1.12 ; S2 meldet (1.3, 0.5)?? zu weit -> wir nehmen nahe Werte
        f.run(3, each=lambda ff: (ff.set("a", 1, 1000, 500, jitter=False), ff.set("b", 1, -4700, 500, jitter=False)))
        p1 = eng.tracks["s1:0"].avg
        p2 = eng.tracks["s2:0"].avg
        d1 = max(0.2, geometry.dist(p1, (0, 0)))
        d2 = max(0.2, geometry.dist(p2, (6, 0)))
        res = eng.auto_calibrate("r1")
        self.assertTrue(res["ok"], res)
        c1 = geometry.dist((0, 0), (res["sensors"]["s1"]["dx"], res["sensors"]["s1"]["dy"]))
        c2 = geometry.dist((0, 0), (res["sensors"]["s2"]["dx"], res["sensors"]["s2"]["dy"]))
        self.assertAlmostEqual(c1 / (c1 + c2), d1 / (d1 + d2), places=2)

    def test_auto_calibrate_needs_two(self):
        eng = make_engine(zones=[])
        f = Feeder(eng)
        f.run(2, each=lambda ff: ff.set("a", 1, 0, 2000))
        self.assertEqual(eng.auto_calibrate("r1")["error"], "need_two")

    def test_merge_hysteresis(self):
        sensors = [
            (sensor_wiring("s1", "a"), {"label": "S1", "room": "r1", "pos": [2, 0], "rot": 0}),
            (sensor_wiring("s2", "b"), {"label": "S2", "room": "r1", "pos": [3, 0], "rot": 0}),
        ]
        eng = make_engine(sensors=sensors, zones=[], settings={"merge_distance": 0.9})
        f = Feeder(eng)
        # Abstand 0,8 m -> zusammengefasst
        f.run(3, each=lambda ff: (ff.set("a", 1, 0, 2000), ff.set("b", 1, -1800, 2000)))
        self.assertEqual(len(eng.persons), 1)
        # Abstand 1,05 m (< 0,9*1,3) -> bleibt zusammen
        f.run(3, each=lambda ff: (ff.set("a", 1, 0, 2000), ff.set("b", 1, -1950, 2000)))
        self.assertEqual(len(eng.persons), 1)
        # Abstand 1,4 m -> getrennt
        f.run(3, each=lambda ff: (ff.set("a", 1, 0, 2000), ff.set("b", 1, -2400, 2000)))
        self.assertEqual(len(eng.persons), 2)

    def test_snapshot_shape(self):
        eng = make_engine(zones=[zone()])
        f = Feeder(eng)
        f.run(2, each=lambda ff: ff.set("a", 1, 0, 2000))
        snap = eng.snapshot()
        self.assertIn("persons", snap)
        self.assertEqual(snap["zones"]["z1"], {"on": True, "count": 1})
        self.assertEqual(snap["rooms"]["r1"], 1)


class TestModelPersistence(unittest.TestCase):
    def test_roundtrip(self):
        gm = importlib.import_module("zpe.ghost_model")
        m = gm.GhostModel()
        m.ensure("s1", 6.0)
        m.cal_begin()
        m.cal_add("s1", 1.0, 2.0, 30)
        m.cal_commit()
        data = m.to_dict()
        m2 = gm.GhostModel()
        m2.load(data, {"s1": 6.0})
        self.assertAlmostEqual(m2.maps["s1"].ghost_prob(1.0, 2.0), m.maps["s1"].ghost_prob(1.0, 2.0), places=2)
        m3 = gm.GhostModel()
        m3.load(data, {"s1": 8.0})  # Reichweite geändert -> neu lernen
        self.assertEqual(m3.maps["s1"].ghost_prob(1.0, 2.0), 0.0)


if __name__ == "__main__":
    unittest.main()
