# Zone based Presence Detection for HAOS by Kilian K.
Use the X and Y sensor entities of any mmWave presence sensor setup in a fully GUI-based interface to define zones, rooms, sensor calibrations, and offsets, while leveraging machine learning to prevent unwanted failure detections (tested and developed for sensors like the HLK-LD2450 with ESPHome). By this you can draw rooms and zones on a live floor plan while getting occupancy and a person count sensors for every zone. Everything runs locally on your very own Home Assistant instance.

---

## Features

- **Live floor plan** as a dashboard card as well as a sidebar panel – several rooms as tabs.
- **Room card**: only the floor plan of one room, freely scalable and the room is selectable in the card editor.
- **Zones** (any polygon), each comes with its own device in the integration: binary sensor **"Zone Name (Zone ID)"** and a **"Person count"** sensor.
- **Person count sensor per room, independent from the zone person count sensors**.
- **Sitting/lying detection**: movements within a small, adjustable radius are damped, plus a larger zone exit margin – lying persons do not "drift" out of the zone.
- **Stuck detection**: frozen target values (hanging ESP/Sensors) are ignored.
- **Presence gate**: if a device's presence sensor is clear, its targets do not count.
- **Wall filter**: slightly outside of the defined room area is snapped to the wall, far outside (reflections or else) is rejected.
- **Learning ghost filter** with a one-time, schedulable **learning calibration** (e.g. tonight at 3 am for 2 h) and **continuous learning** during operation, the system can confidently remove ghost targets and optimize the detection of real targets along the way with carefully programmed machine learning algorithms.
- **Multiple sensor setups**: with two or more sensors in one single room, persons are merged; the **auto alignment function** automatically chooses sensor offsets using one person to cleanly align targets from different sensors wich represent the same person for effortless merging.
- **Calibration possibilities** symbolized with a red glowing cone: single sensor (move + rotate), whole room (move), or even full x flip to encounter sensor mismatches and defects.
- **Snapping** while drawing: corners snap to room corners and walls, edges snap parallel or at right angles to walls and neighbouring edges. Hold **Shift** while dragging with the mouse to turn snapping off temporarily (touch always snaps).
- **Undo/redo** of the last 5 edits,
- **optional edit PIN**: editing is admin-only unless enabled for all users, the 4-digit PIN code can be used to limit access to the edit functions or to further protect from unwanted edits. This becomes especially useful when enabling the "all users can edit" mode.
- **All timings and thresholds are configurable**, off delay additionally per zone. Just look around in the config and GUI menus, I'm sure you'll find what you're looking for, if not please let me know by opening an issue.
- **Language:** follows Home Assistant automatically (see [Language](#language)).

## Requirements

- Home Assistant **2025.1** or newer.
- Per sensor at least **one x and one y entity** (target 1). More targets and a presence binary sensor are optional.
- Coordinates in mm (LD2450 default), cm or m.
- The integration icon is shown from Home Assistant **2026.3** on (older versions show a placeholder).

### Here you can find a default ESPHome example config wich is how I get my sensor data:

```yaml
# uart config and pin definition
# If you have problems like all sensors showing up as unavailable, try switching the rx and tx pins
uart:
  id: uart_bus_ld2450_01
  tx_pin: GPIO18  #your GPIO for tx
  rx_pin: GPIO17  #your GPIO for rx
  baud_rate: 256000
  parity: NONE
  stop_bits: 1

# defining the sensor itself with it's component
ld2450:
  id: ld2450_01
  uart_id: uart_bus_ld2450_01

# defining all the entities
binary_sensor:
  - platform: ld2450
    ld2450_id: ld2450_01
    has_target:
      id: mmwave_pro01_has_target
      name: "Presence"
      device_class: occupancy
    has_moving_target:
      name: "Aktive Bewegung"
      device_class: motion
    has_still_target:
      name: "Stillstand"
      device_class: occupancy

text_sensor:
  - platform: ld2450
    ld2450_id: ld2450_01
    version:
      name: "LD2450 Firmware"
    mac_address:
      name: "LD2450 BT MAC"

button:
  - platform: restart
    name: "ESP Restart"
  - platform: ld2450
    ld2450_id: ld2450_01
    restart:
      name: "LD2450 Reboot"
    factory_reset:
      name: "LD2450 Factory Reset"

switch:
  - platform: ld2450
    ld2450_id: ld2450_01
    bluetooth:
      name: "LD2450 Bluetooth"
    multi_target:
      name: "Multi-Target Tracking"

number:
  - platform: ld2450
    ld2450_id: ld2450_01
    presence_timeout:
      name: "mmWave Timeout"

sensor:
  - platform: ld2450
    ld2450_id: ld2450_01
    target_count:
      name: "Targets gesamt"
    still_target_count:
      name: "Targets still"
    moving_target_count:
      name: "Targets bewegend"

        target_1:
      x:
        name: "Target1 X"
        id: target1_x
        filters:
          - throttle: 250ms
      y:
        name: "Target1 Y"
        id: target1_y
        filters:
          - throttle: 250ms
      speed:
        name: "Target1 Speed"
      angle:
        name: "Target1 Winkel"
      distance:
        name: "Target1 Distanz"

    target_2:
      x:
        name: "Target2 X"
        id: target2_x
        filters:
          - throttle: 250ms
      y:
        name: "Target2 Y"
        id: target2_y
        filters:
          - throttle: 250ms
      speed:
        name: "Target2 Speed"
      angle:
        name: "Target2 Winkel"
      distance:
        name: "Target2 Distanz"

    target_3:
      x:
        name: "Target3 X"
        id: target3_x
        filters:
          - throttle: 250ms
      y:
        name: "Target3 Y"
        id: target3_y
        filters:
          - throttle: 250ms
      speed:
        name: "Target3 Speed"
      angle:
        name: "Target3 Winkel"
      distance:
        name: "Target3 Distanz"
```

## Installation

### Via HACS (custom repository)

1. HACS → ⋮ → **Custom repositories** → URL of this repository, category **Integration**.
2. Install "Zone Presence Detection by Kilian K." and **restart** Home Assistant.

> HACS is **required**

### Manual

Copy the folder `custom_components/zone_presence` to `<config>/custom_components/` and restart.

## Setup

1. **Settings → Devices & services → Add integration → "Zone Presence Detection"**.
2. Optionally add the first sensor right away: pick the device (e.g. the ESPHome device, nesting the LD2450s entities) – all the entities like target x/y values and the presence sensor are suggested automatically. Please check the unit (LD2450: mm).
3. More than one sensor: integration → **Configure → Add sensor**.
4. Open the **"Zone Presence"** panel in the sidebar (or add the card to a dashboard), **Edit** (enter the PIN code, only necessary if you set one), then:
   - **Rooms**: draw the room (drag corners/edges, tap the centre = extra point, snaps to right angles).
   - **Sensors**: drag the sensors to their mounting position and orient them with the arrow.
   - **Zones**: add and name zones.
   - **Calibrate**: with one person in the overlap areas, hit **⚡ Align sensors**, then fine-tune with the other available calibration options.

## Dashboard card

The card is loaded by the integration automatically – no resource needed.

```yaml
type: custom:zone-presence-card
title: Living room.         # optional (default: "Zone Presence" / "Präsenz-Zonen")
room: Living room           # optional: start tab (name or ID)
pin: "1234"                 # optional: overrides the PIN code from the options ("" = no PIN)
lock_minutes: 30            # optional: lock after 3 wrong PIN code entries
merge_color: "#2dd4bf"      # optional: colour of merged persons
```

**Usage:** tabs switch the room (number = persons in the room). **◎** shows raw data: unconfirmed detections (dashed, with confidence) and rejected ghosts (✕). Sitting/lying persons get a dashed ring. **Settings** opens the integration page.

| Mode | Usage |
|---|---|
| Zones | Drag corner/edge/centre · tap centre = 2 extra points · tap name = name, colour, own off delay, active · ✕ = delete |
| Sensors | Drag sensor = place · arrow = rotate · tap sensor = details, room, mirror, offsets |
| Rooms | Drag corners/edges (snapping) · tap centre = one more point · add more Rooms · rename · delete |
| Calibrate | Single sensor: move (circle) and rotate (arrow) the red cone · Whole room: move all cones · auto alignment · reset offsets · start learning calibration |

**Snapping:** while dragging corners, edges or whole zones/rooms, points snap to room corners, walls and the corners/edges of other zones, and edges snap parallel or at right angles to walls and neighbouring edges. Dashed guide lines show what is snapping. Hold **Shift** to drag freely; on touch devices snapping is always on.

### Room card

Only the floor plan of one room – no toolbars or tabs. In the sections view it can be resized freely in width and height; the floor plan keeps its proportions. The room is chosen in the visual card editor.

```yaml
type: custom:zone-presence-room-card
room: Living room           # name or ID (empty = first room)
show_cones: true            # sensors and coverage cones
show_names: true            # zone names and counts
```

The coloured cones always show the **uncorrected** sensor area. The red cones in calibration mode show the **corrected** area; the dashed line connects them to the real sensor.

## Entities

| Device | Entity | Description |
|---|---|---|
| Zone "Example (Zone 1)" | `binary_sensor.example_zone_1` | Occupancy, attributes: persons, zone number, room, off delay |
| | e.g. `sensor.example_zone_1_person_count` | Number of persons in the zone (immediate, no off delay) |
| Room | e.g. `sensor.<room>_person_count` | Persons in the room |
| Hub "Zone Presence Detection" | Learning calibration (status) | Ready / Scheduled / Running / Done / Disturbed / Aborted, progress |
| | Learning calibration scheduled (switch) | One-shot: starts at the start time and turns itself off afterwards |
| | Learning calibration start time / duration | e.g. 03:00 and 120 min |
| | Continuous learning (switch) | Learning during normal operation |
| | Buttons | Start / abort learning calibration, reset learning model |
| | Rejected ghost targets (diagnostic) | Counter |

The entity_id is created once from the zone name and the entity name in the Home Assistant language
(English: `…_person_count`, German: `…_personenanzahl`) and stays stable afterwards – even if you rename
the zone or change the language later (only the display name follows).

## Language

There is no language setting – everything follows Home Assistant:

| What | Language |
|---|---|
| Setup/options dialogs, entity names, states, services | Home Assistant handles these: German or English translation, other languages fall back to English |
| Card and panel | Language of the **logged-in user** (profile): German if it is German, otherwise English |
| Device models, default names (Room 1, …), notifications, sidebar title | **System language** (Settings → System → General): German only if it is German, otherwise English |

If the system language changes, the integration reloads by itself.

## How it works

For every measurement, each target passes these stages (all inside the integration, the card only shows the result):

1. **Gates** – no target (0/0), **frozen** (no change for *Frozen after*), **presence sensor clear**.
2. **Transformation** sensor → room using placement and calibration offset.
3. **Wall filter** – within the *wall tolerance* snap to the wall, beyond it reject.
4. **Tracking** – jumps faster than the *maximum walking speed* start a new target.
5. **Sitting/lying mode** – if a target stays within the *sitting/lying radius* for *sitting/lying mode after* seconds, it is smoothed strongly; it only leaves zones with the larger exit margin.
6. **Ghost filter** – confidence from age, distance travelled, confirmation by a second sensor, the learned ghost and activity map, and wall proximity. Confirmation with hysteresis; whoever walked in or is seen by two sensors counts as *proven* and is no longer rejected.
7. **Persons** – targets of different sensors within the *merge* distance become one person (with hysteresis, never two targets of the same sensor). The position weights the closer sensor more.
8. **Zones** – occupancy, person count and off delay.

### Learning ghost filter

A lightweight statistical model (no cloud, no neural network): per sensor three probability maps in the sensor coordinate system (25 cm grid), so they stay valid after later placement or offset changes.

- **Learning calibration** (one-time, schedulable): with an **empty room**, it records for e.g. 2 h where ghosts appear (fan, curtain, reflections). If persons walk through, their data is discarded; if more than 15 % of the time is disturbed, the integration reports it.
- **Continuous learning**: stationary, short-lived, never confirmed targets strengthen the ghost map; confirmed, moving persons strengthen the activity map (which lowers ghost suspicion at that spot). What is learned during operation decays with the configured half-life.

**Limits (by design):** the model can only lower the confidence of individual detections. It never creates persons, never changes the configuration, is capped, and can be turned off and reset at any time. Persons walking in or seen by two sensors are always detected.

### Auto alignment of multiple sensors

One person stands in the area that several sensors see. Only sensors that currently see the person and whose measurement is not too far from the mean are included. The consensus is a distance-weighted mean: the closer sensor counts as more accurate and is corrected less (equal distance → half each; 1 : 2 → 1/3 vs 2/3).

## Settings

Integration → **Configure → Algorithms & timings**:

| Setting | Default | Effect |
|---|---|---|
| Zone off delay | 10 s | Zone stays occupied this long after the last person (can be overridden per zone) |
| Minimum age of new persons | 1 s | New stationary detections must persist this long |
| Frozen after | 3 s | A target without any change counts as hanging |
| Sitting/lying mode after | 5 s | |
| Sitting/lying radius | 0.7 m | |
| Smoothing while moving / sitting/lying | 0.25 s / 2.5 s | Time constants |
| Zone exit margin / while sitting/lying | 0.2 m / 0.45 m | |
| Merge multiple sensors up to | 0.9 m | |
| Reject targets behind walls / wall tolerance | on / 1.2 m | Up to the tolerance outside the room is snapped to the wall, further outside is rejected |
| Maximum walking speed | 3 m/s | |
| Learning ghost filter / strength | on / 50 % | |
| Learning speed / memory | normal / 14 days | |
| Auto alignment: max. spread | 2 m | |

Under **Display & editing**: panel on/off, panel title (empty = default title), and the **editing** section:

- **Edit PIN** – off by default. The PIN is only active if the field contains an entry (4 digits).
- **Allow editing for non-administrators** – by default only administrators can edit. If checked, every user can edit; the PIN is then the only protection against unwanted changes, so set one.

## Services

| Service | Description |
|---|---|
| `zone_presence.start_learning_calibration` | Start the learning calibration now (optional `duration` in min) |
| `zone_presence.schedule_learning_calibration` | Schedule it once for `time` (optional `duration`) |
| `zone_presence.abort_learning_calibration` | Abort a running learning calibration |
| `zone_presence.reset_learning_model` | Delete everything learned |
| `zone_presence.import_legacy` | Import rooms, zones and calibration from the former YAML/package solution |

## Tips for the LD2450 (ESPHome)

- Throttle the X/Y sensors, e.g. `filters: [ throttle: 250ms ]` – this takes load off Home Assistant and is plenty for the zone logic.
- Mirror an axis either in ESPHome (`multiply: -1` on **X** only) **or** in the card's sensor panel ("Mirror X axis") – not both.
- A person sitting completely still usually still causes tiny value changes on the LD2450 and stays visible. If the ESP hangs, the target disappears after the *Frozen after* time.

## Troubleshooting

- **Card shows "Connecting …" or an error**: is the integration set up and loaded? Reload the browser.
- **Persons appear mirrored**: "Mirror X axis" in the sensor panel.
- **Persons are not detected**: turn on ◎ – unconfirmed detections and rejected ghosts are shown. If needed, lower the *ghost filter strength* or reset the learning model.
- **Diagnostics**: integration → ⋮ → *Download diagnostics* (contains configuration, tracks, model statistics).

## Development

```bash
python -m unittest discover -s tests -p "test_*.py"   # engine + runtime (runs without HA)
npm install --no-save playwright && npx playwright install chromium
node tests/browser/run.js tests/browser/out            # browser test of the card (German + English)
```

The engine (`engine.py`, `ghost_model.py`, `geometry.py`) is plain Python without any Home Assistant dependency.
