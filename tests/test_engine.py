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
        self.assertEqual(sum(1 for v in eng.model.maps["s1"].cal if v > 0), 0, "laufende Person wird nicht als Geist gelernt")

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


def json_roundtrip(d):
    import json
    return json.loads(json.dumps(d))


class TestExclusionsAndFeatures(unittest.TestCase):
    EXCL = [{"id": "x1", "room": "r1", "name": "Ventilator", "points": [[4, 3], [5, 3], [5, 4], [4, 4]], "depth": 0.3}]

    def _eng(self, excl=None, **kw):
        eng = make_engine(**kw)
        eng.set_config(eng.rooms, eng.sensors, eng.zones, engine_mod.parse_exclusions(excl if excl is not None else self.EXCL))
        return eng

    def test_born_in_exclusion_ignored(self):
        eng = self._eng(zones=[zone(pts=[[3, 2], [6, 2], [6, 5], [3, 5]])])
        f = Feeder(eng)
        # S1 bei (2,0) rot 0: Raum (4.5, 3.5) -> xs = 2.5, ys = 3.5
        f.run(10, each=lambda ff: ff.set("a", 1, 2500, 3500))
        self.assertEqual(len(eng.persons), 0, "aus dem Nichts in der Sperrzone -> ignoriert")
        self.assertTrue(eng.tracks["s1:0"].excluded)
        self.assertFalse(eng.zone_state["z1"].on)
        self.assertEqual(eng.room_count["r1"], 0)
        self.assertTrue(any(r["r"] == "excl" for r in eng.snapshot()["rejected"]))
        self.assertGreaterEqual(eng.stats["rejected_excl"], 1)

    def test_walking_in_shallow_is_clamped_deep_is_rejected(self):
        eng = self._eng()
        f = Feeder(eng)
        state = {"x": 500.0}

        def walk(ff):
            state["x"] = min(state["x"] + 200, 2200.0)    # bis 0,2 m in die Sperrzone (Raum x = 4.2)
            ff.set("a", 1, state["x"], 3500)
        f.run(12, each=walk)
        self.assertEqual(len(eng.persons), 1, "knapp hinein: Person bleibt, an den Rand gesetzt")
        self.assertLess(eng.persons[0].pos[0], 4.0 + 1e-3)
        f.run(3, each=lambda ff: ff.set("a", 1, 2600, 3500))   # 0,6 m tief -> ungültig
        self.assertEqual(len(eng.persons), 0)

    def test_released_after_leaving(self):
        eng = self._eng()
        f = Feeder(eng)
        f.run(3, each=lambda ff: ff.set("a", 1, 2500, 3500))
        self.assertTrue(eng.tracks["s1:0"].excluded)
        state = {"x": 2500.0}

        def leave(ff):
            state["x"] = max(state["x"] - 150, 0.0)
            ff.set("a", 1, state["x"], 3500)
        f.run(12, each=leave)
        self.assertFalse(eng.tracks["s1:0"].excluded, "Sperrzone verlassen -> wieder normal")
        self.assertEqual(len(eng.persons), 1)

    def test_exclusion_learning_option(self):
        excl = [dict(self.EXCL[0], learn=True)]
        eng = self._eng(excl=excl)
        f = Feeder(eng)
        for _ in range(6):
            f.run(2, each=lambda ff: ff.set("a", 1, 2500, 3500))
            f.set("a", 1, 0, 0)
            f.run(1)
        self.assertGreater(eng.model.maps["s1"].ghost_prob(2.5, 3.5), 0.4)
        eng2 = self._eng()
        f2 = Feeder(eng2)
        for _ in range(6):
            f2.run(2, each=lambda ff: ff.set("a", 1, 2500, 3500))
            f2.set("a", 1, 0, 0)
            f2.run(1)
        self.assertEqual(eng2.model.maps["s1"].ghost_prob(2.5, 3.5), 0.0, "ohne Lernen: Modell bleibt unberührt")

    def test_erratic_ghost_not_proven(self):
        eng = make_engine(zones=[])
        f = Feeder(eng)
        state = {"k": 0}

        def jumpy(ff):   # Mehrwege-Geist springt 0,8 m hin und her
            state["k"] += 1
            ff.set("a", 1, 0 if state["k"] % 2 else 800, 3000, jitter=False)
        f.run(6, each=jumpy)
        t = eng.tracks.get("s1:0")
        self.assertTrue(t is None or not t.proven)
        self.assertEqual(len(eng.persons), 0, "sprunghafter Geist wird nicht zur Person")

    def test_walking_person_still_confirmed_fast(self):
        eng = make_engine(zones=[])
        f = Feeder(eng)
        state = {"y": 1000.0}

        def walk(ff):
            state["y"] += 300
            ff.set("a", 1, 0, state["y"])
        f.run(3, each=walk)
        self.assertEqual(len(eng.persons), 1)
        self.assertTrue(eng.tracks["s1:0"].proven)

    def test_cross_sensor_unseen(self):
        """S2 schaut auf dieselbe Stelle, hat Presence 'aus' -> Geisterverdacht bei S1."""
        sensors = [
            (sensor_wiring("s1", "a"), {"label": "S1", "room": "r1", "pos": [2, 0], "rot": 0}),
            (sensor_wiring("s2", "b"), {"label": "S2", "room": "r1", "pos": [2, 6], "rot": 180}),
        ]
        eng = make_engine(sensors=sensors, zones=[])
        f = Feeder(eng)
        f.presence("b", False)
        f.run(6, each=lambda ff: ff.set("a", 1, 0, 3000))
        self.assertGreater(eng.tracks["s1:0"].unseen_t, 4)
        conf_unseen = eng.tracks["s1:0"].conf
        eng2 = make_engine(sensors=sensors, zones=[])
        f2 = Feeder(eng2)
        f2.run(6, each=lambda ff: ff.set("a", 1, 0, 3000))
        self.assertLess(conf_unseen, eng2.tracks["s1:0"].conf)

    def test_selfcheck_false_positive_unlearns(self):
        eng = make_engine(zones=[])
        f = Feeder(eng)
        m = eng.model.maps["s1"]
        for _ in range(8):
            eng.model.learn_ghost("s1", 0.0, 1.0, 1.0)
        before = m.ghost_prob(0.0, 1.0)
        state = {"y": 1000.0}

        def walk(ff):
            state["y"] = min(state["y"] + 250, 4500)
            ff.set("a", 1, 0, state["y"])
        f.run(5, each=walk)
        self.assertTrue(eng.tracks["s1:0"].proven)
        f.set("a", 1, 0, 0)
        f.run(1)
        self.assertGreaterEqual(eng.model.check["fp"], 1)
        self.assertLess(m.ghost_prob(0.0, 1.0), before)

    def test_heat_and_daily_stats(self):
        eng = make_engine(zones=[])
        eng.set_clock(14.0, "2026-11-07")
        f = Feeder(eng)
        f.run(10, each=lambda ff: ff.set("a", 1, 0, 2000))
        h = eng.model.heat["r1"]
        self.assertGreater(h.sample(2.0, 2.0), 3)
        f.set("a", 1, 0, 0)
        f.run(1)
        self.assertEqual(eng.model.daily["s1"]["2026-11-07"][1], 1, "ein Track gezählt")

    def test_rate_alarm(self):
        gm = importlib.import_module("zpe.ghost_model")
        m = gm.GhostModel(1)
        m.daily["s1"] = {f"2026-11-0{d}": [10.0, 50.0, 0.0] for d in range(1, 7)}
        m.set_day("2026-11-07")
        m.count("s1", 0, 20)
        self.assertIsNone(m.rate_alarm("s1"))
        m.count("s1", 0, 40)
        self.assertEqual(m.rate_alarm("s1")[0], 60)

    def test_model_view_and_spots(self):
        mv = importlib.import_module("zpe.model_view")
        eng = make_engine(zones=[])
        for _ in range(10):
            eng.model.learn_ghost("s1", 1.0, 3.0, 1.0)    # Raum (3, 3)
        view = mv.build_view(ROOM[0]["polygon"], eng.view_sensors("r1"), eng.model.heat.get("r1"), 0.2, 0, 4)
        self.assertEqual(len(view["g"]), view["nx"] * view["ny"])
        self.assertTrue(view["spots"])
        sp = view["spots"][0]
        self.assertAlmostEqual(sp["x"], 3.0, delta=0.3)
        self.assertAlmostEqual(sp["y"], 3.0, delta=0.3)
        self.assertEqual(sp["sensor"], "s1")
        n = mv.forget_area(eng.model, eng.view_sensors("r1"), "r1", 3.0, 3.0, 0.6)
        self.assertGreater(n, 0)
        self.assertLess(eng.model.maps["s1"].ghost_prob(1.0, 3.0), 0.05)

    def test_history_frames(self):
        mv = importlib.import_module("zpe.model_view")
        eng = make_engine(zones=[])
        eng.model.learn_ghost("s1", 1.0, 3.0, 1.0)
        eng.model.maybe_snapshot(1.0, force=True)
        hist = mv.build_history(ROOM[0]["polygon"], eng.view_sensors("r1"), eng.model.snaps)
        self.assertEqual(len(hist["frames"]), 1)
        self.assertGreater(max(hist["frames"][0]["g"]), 20)


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
        m3.load(data, {"s1": 8.0})  # Reichweite geändert -> umrastern statt vergessen
        self.assertAlmostEqual(m3.maps["s1"].ghost_prob(1.0, 2.0), m.maps["s1"].ghost_prob(1.0, 2.0), places=1)

    def test_v1_migration(self):
        """1.x-Format (dünn besetzte Dicts, 25 cm) wird verlustarm übernommen."""
        gm = importlib.import_module("zpe.ghost_model")
        # Zelle für (1.0, 2.0) im alten Raster: cx = (1+6)/0.25 = 28, cy = 8 -> idx = 8*48+28
        idx = 8 * 48 + 28
        v1 = {"maps": {"s1": {"range": 6.0, "cell": 0.25, "cal": {str(idx): 3.0}, "ghost": {str(idx): 2.0},
                              "real": {}}}}
        for level in (1, 2, 3):
            m = gm.GhostModel(level)
            m.load(v1, {"s1": 6.0})
            p = m.maps["s1"].ghost_prob(1.12, 2.12)
            self.assertGreater(p, 0.8, f"Stufe {level}: {p}")
            for slot in range(m.slots):
                self.assertGreater(m.maps["s1"].ghost_value(1.12, 2.12, slot), 1.0, "alle Tageszeit-Fenster")

    def test_level_change_resamples(self):
        gm = importlib.import_module("zpe.ghost_model")
        m = gm.GhostModel(1)
        m.ensure("s1", 6.0)
        m.learn_ghost("s1", -1.0, 3.0, 1.0)
        before = m.maps["s1"].ghost_prob(-1.0, 3.0)
        m.set_level(3)
        self.assertEqual(m.maps["s1"].slots, 8)
        self.assertAlmostEqual(m.maps["s1"].cell, 0.1)
        self.assertGreater(m.maps["s1"].ghost_prob(-1.0, 3.0), before * 0.7)

    def test_time_of_day_slots(self):
        gm = importlib.import_module("zpe.ghost_model")
        m = gm.GhostModel(2)          # 4 Fenster à 6 h
        m.ensure("s1", 6.0)
        m.set_clock_slot(21.0)         # abends
        for _ in range(6):
            m.learn_ghost("s1", 1.0, 2.0, 1.0)
        evening = m.maps["s1"].ghost_prob(1.0, 2.0)
        m.set_clock_slot(9.0)          # morgens
        morning = m.maps["s1"].ghost_prob(1.0, 2.0)
        self.assertGreater(evening, 0.7)
        self.assertLess(morning, evening * 0.5, "Ventilator abends -> morgens kaum Geisterverdacht")

    def test_no_loss_at_cell_border(self):
        gm = importlib.import_module("zpe.ghost_model")
        m = gm.GhostModel(1)
        m.ensure("s1", 6.0)
        m.learn_ghost("s1", 0.0, 2.0, 1.0)     # genau auf einer Zellgrenze
        a, b = m.maps["s1"].ghost_prob(-0.05, 2.0), m.maps["s1"].ghost_prob(0.05, 2.0)
        self.assertGreater(min(a, b), 0.15)
        self.assertLess(abs(a - b), 0.05)

    def test_snapshot_and_heat_persist(self):
        gm = importlib.import_module("zpe.ghost_model")
        m = gm.GhostModel(2)
        m.ensure("s1", 6.0)
        m.learn_ghost("s1", 1.0, 2.0, 1.0)
        h = m.heat_for("r1", (0, 0, 6, 6))
        h.add(2.0, 2.0, 60)
        self.assertTrue(m.maybe_snapshot(1000.0, force=True))
        data = m.to_dict()
        m2 = gm.GhostModel(2)
        m2.load(json_roundtrip(data), {"s1": 6.0})
        m2.restore_heat({"r1": (0, 0, 6, 6)})
        self.assertEqual(len(m2.snaps), 1)
        self.assertGreater(m2.heat["r1"].sample(2.0, 2.0), 10)


if __name__ == "__main__":
    unittest.main()
