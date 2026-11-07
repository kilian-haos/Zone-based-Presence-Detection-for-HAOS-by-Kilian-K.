<img src="custom_components/zone_presence/brand/icon.png" alt="" width="96" align="right">

# Zone based Presence Detection for HAOS by Kilian K.

🇬🇧 English · 🇩🇪 [Deutsche Version](README.de.md)

Use the X and Y sensor entities of any mmWave presence sensor setup in a fully GUI-based interface to define zones, rooms, exclusion zones, sensor calibrations and offsets, while leveraging machine learning to prevent unwanted false detections (tested and developed for sensors like the HLK-LD2450 with ESPHome). Draw rooms and zones on a live floor plan and get occupancy and person count sensors for every zone. Everything runs locally on your very own Home Assistant instance.

---

## Features

- **Live floor plan** as a dashboard card as well as a sidebar panel – several rooms as tabs.
- **Room card**: only the floor plan of one room, freely scalable; room and visible elements are selectable in the card editor.
- **AI model view** – a colourful, fluid view of what the learning ghost filter has learned: ghost spots, real activity, uncertainty and where people stay, plus the live raw targets drawing little trails behind them. Available as a tab and as its own dashboard card (see [AI model view](#ai-model-view)).
- **Zones** (any polygon), each comes with its own device in the integration: binary sensor **"Zone Name (Zone ID)"** and a **"Person count"** sensor. Zone templates (sofa, bed, dining table, …) and duplicating.
- **Exclusion zones** (red): detections inside never count – ideal for a fan, a curtain or a reflecting window. A person walking in from outside still counts up to a configurable depth (see [Exclusion zones](#exclusion-zones)).
- **Dimensions**: every room edge shows its length in metres while you draw; tap it to type an exact length (the middle of the edge stays, the edge grows on both sides). Corner angles can be typed as well.
- **Person count sensor per room, independent from the zone person count sensors**.
- **Sitting/lying detection**: movements within a small, adjustable radius are damped, plus a larger zone exit margin – lying persons do not "drift" out of the zone.
- **Stuck detection**: frozen target values (hanging ESP/sensors) are ignored.
- **Presence gate**: if a device's presence sensor is clear, its targets do not count.
- **Wall filter**: slightly outside of the defined room area is snapped to the wall, far outside (reflections or else) is rejected.
- **Learning ghost filter** with a one-time, schedulable **learning calibration** (e.g. tonight at 3 am for 2 h) and **continuous learning** during operation. It learns per time of day, checks itself, recognises erratic multipath ghosts and uses a second sensor as a witness (see [Learning ghost filter](#learning-ghost-filter)). **Compute level 1–3** selectable.
- **Multiple sensor setups**: with two or more sensors in one single room, persons are merged; the **auto alignment function** automatically chooses sensor offsets using one person to cleanly align targets from different sensors which represent the same person for effortless merging.
- **Calibration possibilities** symbolised with a red glowing cone: single sensor (move + rotate), whole room (move), or even a full X flip to counter sensor mismatches and defects.
- **Snapping** while drawing: corners snap to room corners and walls; edges move **parallel** – neighbouring edges keep their angles, so a rectangle stays a rectangle – and snap to parallel walls and other zones. Hold **Shift** while dragging with the mouse to turn snapping off temporarily (touch always snaps).
- **Visible elements**: choose exactly what the view shows (zones, names, exclusion zones, sensors, cones, sensor overlap, persons, labels, raw data, rejected ghosts, dimensions, heatmap, learned ghost spots) – with presets, remembered per browser.
- **Undo/redo** of the last 5 edits.
- **Optional edit PIN**: editing is admin-only unless enabled for all users; the 4-digit PIN can be used to limit access to the edit functions or to further protect from unwanted edits. This becomes especially useful when enabling the "all users can edit" mode.
- **All timings and thresholds are configurable**, off delay additionally per zone. Just look around in the config and GUI menus, I'm sure you'll find what you're looking for – if not, please let me know by opening an issue.
- **Language:** follows Home Assistant automatically (see [Language](#language)).

## Requirements

- Home Assistant **2025.1** or newer.
- Per sensor at least **one x and one y entity** (target 1). More targets and a presence binary sensor are optional.
- Coordinates in mm (LD2450 default), cm or m.
- The integration icon is shown from Home Assistant **2026.3** on (older versions show a placeholder).

### Example ESPHome configuration (this is how I get my sensor data)

```yaml
# UART config and pin definition
# If all sensors show up as unavailable, try swapping the rx and tx pins
uart:
  id: uart_bus_ld2450_01
  tx_pin: GPIO18  # your GPIO for tx
  rx_pin: GPIO17  # your GPIO for rx
  baud_rate: 256000
  parity: NONE
  stop_bits: 1

# the sensor itself with its component
ld2450:
  id: ld2450_01
  uart_id: uart_bus_ld2450_01

# all the entities
binary_sensor:
  - platform: ld2450
    ld2450_id: ld2450_01
    has_target:
      id: mmwave_pro01_has_target
      name: "Presence"
      device_class: occupancy
    has_moving_target:
      name: "Moving target"
      device_class: motion
    has_still_target:
      name: "Still target"
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
      name: "Targets total"
    still_target_count:
      name: "Targets still"
    moving_target_count:
      name: "Targets moving"
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
        name: "Target1 Angle"
      distance:
        name: "Target1 Distance"
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
        name: "Target2 Angle"
      distance:
        name: "Target2 Distance"
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
        name: "Target3 Angle"
      distance:
        name: "Target3 Distance"
```

## Installation

### Home Assistant 2026.11 or newer: Marketplace

HACS is built into Home Assistant as the **Marketplace** since 2026.11.

1. **Settings → Marketplace → Add from link** → URL of this repository (the first time, Home Assistant asks you to connect GitHub; the connection only reads public information).
2. Install "Zone Presence Detection by Kilian K." and **restart** Home Assistant.

### Home Assistant 2026.10 or older: HACS (custom repository)

1. HACS → ⋮ → **Custom repositories** → URL of this repository, category **Integration**.
2. Install "Zone Presence Detection by Kilian K." and **restart** Home Assistant.

Updates appear under **Settings → Updates** in both cases. Marketplace and HACS can only add **public** repositories.

### Manual

Copy the folder `custom_components/zone_presence` to `<config>/custom_components/` and restart. Without Marketplace/HACS you do not get update notifications.

## Setup

1. **Settings → Devices & services → Add integration → "Zone Presence Detection"**.
2. Optionally add the first sensor right away: pick the device (e.g. the ESPHome device nesting the LD2450's entities) – all entities like target x/y values and the presence sensor are suggested automatically. Please check the unit (LD2450: mm).
3. More than one sensor: integration → **Configure → Add sensor**.
4. Open the **"Zone Presence"** panel in the sidebar (or add the card to a dashboard), **Edit** (enter the PIN, only necessary if you set one), then:
   - **Rooms**: draw the room (drag corners/edges, tap a length or angle to type it, tap the centre = extra point).
   - **Sensors**: drag the sensors to their mounting position and orient them with the arrow.
   - **Zones**: add and name zones (▾ = templates), add **exclusion zones** where nothing should count.
   - **Calibrate**: with one person in the overlap area, hit **⚡ Align sensors**, then fine-tune with the other calibration options.

## Dashboard cards

The cards are loaded by the integration automatically – no resource needed.

```yaml
type: custom:zone-presence-card
title: Living room          # optional (default: "Zone Presence" / "Präsenz-Zonen")
room: Living room           # optional: start tab (name or ID)
pin: "1234"                 # optional: overrides the PIN from the options ("" = no PIN)
lock_minutes: 30            # optional: lock after 3 wrong PIN entries
merge_color: "#2dd4bf"      # optional: colour of merged persons
```

**Usage:** tabs switch the room (number = persons in the room). **Floor plan / ✦ AI model** switches the view. **👁** chooses the visible elements (presets: persons only, standard, diagnosis, everything – remembered per browser). **◎** quickly toggles raw data: unconfirmed detections (dashed, with confidence) and rejected ghosts (✕). Sitting/lying persons get a dashed ring. **Settings** opens the integration page.

| Mode | Usage |
|---|---|
| Zones | Drag corner/edge/centre · edges move parallel · tap centre = 2 extra points · tap name = name, colour, own off delay, active, duplicate · ✕ = delete · **＋ Zone ▾** = templates · **＋ Exclusion zone** |
| Sensors | Drag sensor = place · arrow = rotate · tap sensor = details, room, mirror, offsets |
| Rooms | Drag corners/edges (snapping, 5 cm grid) · **tap a length badge = type the length**, tap an angle = type the angle, **Tab** = next edge · tap centre = one more point · add more rooms · rename · delete |
| Calibrate | Single sensor: move (circle) and rotate (arrow) the red cone · Whole room: move all cones · auto alignment · reset offsets · start learning calibration |

**Snapping:** while dragging corners, edges or whole zones/rooms, points snap to room corners, walls and the corners/edges of other zones. Dragging an edge moves it **parallel**: the neighbouring edges keep their direction, so rectangles stay rectangles and slanted walls slide along. The edge snaps to parallel walls, other zone edges and the alignment lines of other corners. Dashed guide lines show what is snapping. Hold **Shift** to drag freely (also sideways); on touch devices snapping is always on.

**Typing dimensions:** tap the length badge of a room edge and type e.g. `4.35` (comma or dot). The middle of the edge stays where it is and the edge gets longer or shorter on both sides. With **"Keep angles"** (default) the neighbouring walls move along, so the shape keeps all its angles (a rectangle stays a rectangle); without it only the two corners of this edge move. **Enter** applies, **Tab** applies and jumps to the next edge, **Esc** cancels.

### Room card

Only the floor plan of one room – no toolbars or tabs. In the sections view it can be resized freely in width and height; the floor plan keeps its proportions. Room and visible elements are chosen in the visual card editor.

```yaml
type: custom:zone-presence-room-card
room: Living room           # name or ID (empty = first room)
show_cones: true            # sensors and coverage cones
show_names: true            # zone names and counts
layers: [zones, zone_names, exclusions, persons, dims]   # optional: exactly these elements
```

Available `layers`: `zones`, `zone_names`, `exclusions`, `sensors`, `cones`, `overlap`, `persons`, `person_labels`, `raw`, `rejected`, `dims`, `heat`, `ghostmap`.

The coloured cones always show the **uncorrected** sensor area. The red cones in calibration mode show the **corrected** area; the dashed line connects them to the real sensor.

### AI model view

Tab **✦ AI model** in the card/panel, or as its own card:

```yaml
type: custom:zone-presence-model-card
room: Living room           # name or ID (empty = first room)
show_targets: true          # live raw targets with trails
legend: true                # small legend in the card
model_layers: [g, r, u, h]  # g = ghost spots, r = real activity, u = uncertainty, h = where people stay
```

- **Magenta/pink clouds** – ghost spots: here the model expects false detections (brighter = more certain). **Turquoise/blue** – real activity: here people really walk. **Night-blue haze** – uncertainty: the model knows little about this spot yet; **black** = no sensor sees it. **Amber** – where people stay.
- **Live raw targets** are small glowing clouds in their sensor's colour (unconfirmed: pinkish, inside an exclusion zone: red). When they move, they draw trails behind them.
- **Problem spots** (numbered rings): the three most conspicuous ghost areas, explained in one sentence (near a wall = reflection, otherwise probably a moving object, mostly at which time of day, which sensor). One click creates an **exclusion zone** there or **forgets** the area.
- **Click anywhere** in the room to see the values of that spot and to forget it (Ø 1 m).
- **Time-lapse**: replays how the model learned (snapshots every 24 h / 6 h / 2 h depending on the compute level).
- **Statistics**: ghosts caught today and in the last 7 days, the self-check score, compute level and current time window, memory. Admins can **export/import** the model as a file (e.g. before reinstalling).

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
| | Rejected ghost targets (diagnostic) | Counter; attributes: behind wall, filtered, in exclusion zone, ghosts today, self-check score |

Exclusion zones have no entities.

The entity_id is created once from the zone name and the entity name in the Home Assistant language (English: `…_person_count`, German: `…_personenanzahl`) and stays stable afterwards – even if you rename the zone or change the language later (only the display name follows).

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
4. **Exclusion zones** – a target appearing inside is ignored; a target walking in is snapped to the edge up to the allowed depth, beyond it ignored.
5. **Tracking** – jumps faster than the *maximum walking speed* start a new target.
6. **Sitting/lying mode** – if a target stays within the *sitting/lying radius* for *sitting/lying mode after* seconds, it is smoothed strongly; it only leaves zones with the larger exit margin.
7. **Ghost filter** – confidence from age, distance travelled (of the smoothed position), confirmation by a second sensor, "a second sensor should see it but doesn't", erratic jumping, the learned ghost and activity maps, and wall proximity. Confirmation with hysteresis; whoever walked in or is seen by two sensors counts as *proven* and is no longer rejected.
8. **Persons** – targets of different sensors within the *merge* distance become one person (with hysteresis, never two targets of the same sensor). The position weights the closer sensor more.
9. **Zones** – occupancy, person count and off delay.

### Exclusion zones

An exclusion zone (zone mode → **＋ Exclusion zone**) is always red, all in the same red; normal zones never get this red automatically (you can still pick any colour for them by hand). In the normal view exclusion zones are only hinted at.

- **Appears out of nowhere** inside an exclusion zone → completely ignored (no person, no zone, no room count). Only when it has left the exclusion zone for 3 s does it count as a new detection.
- **Walks in from outside** → still counts up to the **allowed depth** (default 0.3 m) and is shown at the edge – just like the wall tolerance. Deeper inside it is ignored.
- **Learn detections here as ghosts** (optional per exclusion zone): the learning model treats everything appearing there as a ghost. Off by default – then nothing from inside an exclusion zone touches the model.

### Learning ghost filter

A lightweight statistical model (no cloud, no neural network): per sensor several probability maps in the sensor coordinate system, so they stay valid after later placement or offset changes.

- **Learning calibration** (one-time, schedulable): with an **empty room**, it records for e.g. 2 h where ghosts appear (fan, curtain, reflections). If persons walk through, their data is discarded; if more than 15 % of the time is disturbed, the integration reports it.
- **Continuous learning**: stationary, short-lived, never confirmed targets strengthen the ghost map; confirmed, moving persons strengthen the activity map (which lowers ghost suspicion at that spot). What is learned during operation decays with the configured half-life.
- **Time of day** (compute level 2–3): ghosts are learned per time window (4 × 6 h or 8 × 3 h). A fan that only runs in the evening does not make the spot suspicious in the morning.
- **Smooth maps**: a Gaussian kernel and bilinear reading – no more gaps at cell borders.
- **Second sensor as a witness**: if another sensor of the room looks at the spot (and has a free target slot or reports "no presence") but sees nothing there, the detection is treated as suspicious and learned more strongly as a ghost.
- **Erratic jumping**: multipath ghosts jump back and forth; people move steadily. Jumping lowers the confidence and does not count as distance travelled.
- **Self-check**: if a person who was later proven real had been slowed down by the model, the ghost evidence there is reduced; if a ghost briefly counted as a person, the model learns that spot more strongly. The learning strength adapts slowly (the score is shown in the AI model view).
- **Daily statistics and warning**: if a sensor suddenly reports far more ghosts than usual (moved, turned, new furniture, fan, defect), Home Assistant shows a notification once per day.
- **Compute level** (Configure → Algorithms & timings): 1 = light (25 cm grid, one model for the whole day), 2 = balanced (15 cm, 4 time windows, recommended), 3 = maximum (10 cm, 8 time windows, denser time-lapse). Even level 3 needs only a few megabytes of RAM and a few percent of one CPU core – the limit is the accuracy of the radar, not the computer. Changing the level resamples what was learned instead of deleting it.

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
| Learning model compute level | 2 | 1 light · 2 balanced · 3 maximum |
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
- A fan, a curtain or a window that keeps producing ghosts: open the AI model view – the problem spot usually shows up there and can be turned into an exclusion zone with one click.

## Troubleshooting

- **Card shows "Connecting …" or an error**: is the integration set up and loaded? Reload the browser.
- **Persons appear mirrored**: "Mirror X axis" in the sensor panel.
- **Persons are not detected**: turn on ◎ – unconfirmed detections and rejected ghosts are shown. Check the AI model view (is the spot magenta?), forget the area or lower the *ghost filter strength*, or reset the learning model.
- **A person in front of a piece of furniture is detected late**: if a second sensor cannot see behind the furniture, it may count as a "missing witness". Usually the model learns this spot as real activity within a few days.
- **Diagnostics**: integration → ⋮ → *Download diagnostics* (contains configuration, tracks, model statistics).

## Development

```bash
python -m unittest discover -s tests -p "test_*.py"   # engine, model, runtime (runs without HA)
npm install --no-save playwright && npx playwright install chromium
node tests/browser/run.js tests/browser/out            # browser test of the cards (German + English)
```

The engine (`engine.py`, `ghost_model.py`, `model_view.py`, `geometry.py`) is plain Python without any Home Assistant dependency.
