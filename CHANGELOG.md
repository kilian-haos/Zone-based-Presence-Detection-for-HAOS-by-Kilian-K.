# Changelog

## 1.2.0 – 2026-11-07

- **AI model view**: a colourful, fluid view of what the learning ghost filter has learned (ghost spots, real activity, uncertainty, where people stay) with the live raw targets as little clouds that draw trails behind them. As a tab ("✦ AI model") and as its own card `custom:zone-presence-model-card`. Problem spots explained in one sentence (create an exclusion zone or forget with one click), click any spot for its values, time-lapse, statistics, export/import of the model.
- **Exclusion zones**: detections appearing inside never count; a person walking in counts up to a configurable depth and is shown at the edge. Optionally learn detections there as ghosts. Always the same red; normal zones never get it automatically. Hinted at in the normal view.
- **Dimensions**: length badges on every room edge (live while dragging); tap to type a length – the middle stays, the edge grows on both sides, optionally keeping all angles. Corner angles can be typed, Tab jumps to the next edge.
- **Dragging an edge moves it parallel**: neighbouring edges keep their direction (a rectangle stays a rectangle), with snapping to parallel walls, other zones and alignment lines; rooms in a 5 cm grid. Shift = free as before.
- **Visible elements**: choose every element of the view (incl. sensor overlap, dimensions, heatmap, learned ghost spots) with presets; remembered per browser, configurable for the room card.
- **Zone templates** (sofa, beds, dining table, desk, armchair) and **duplicate** for zones and exclusion zones.
- **Learning model 2.0**: Gaussian kernel and bilinear reading, time-of-day windows, second sensor as a witness, detection of erratic multipath ghosts, self-check with adaptive learning strength, daily statistics with a warning when a sensor suddenly reports many more ghosts, heatmap of stays, snapshots for the time-lapse. **Compute level 1–3** (Configure → Algorithms & timings). The 1.x model is migrated automatically; changing the level or the sensor range resamples instead of forgetting.
- Marketplace (Home Assistant 2026.11) documented; HACS keeps working on older versions.

## 1.1.0 – 2026-10-30

- **Edit PIN off by default.** The PIN is only active if the field contains an entry; the hint sits directly above the field.
- **New option "Allow editing for non-administrators"** (Configure → Display & editing). The PIN is then the only protection – strongly recommended together with this option.
- **Own icon** for the integration (shown from Home Assistant 2026.3).
- **New room card** `custom:zone-presence-room-card`: only the floor plan of one room, freely scalable, room selectable in the visual editor.
- **Wall tolerance default 1.2 m** (was 0.3 m). Existing installations that still use the old default are migrated automatically.
- **Language follows Home Assistant** – the manual language option is gone. Dialogs and entity names use HA's translations; the card follows the user's language; device models, default names, notifications and the sidebar title follow the system language (German only on a German HA, otherwise English).
- **Snapping** when drawing zones and rooms: room corners, walls, other zones, parallels and right angles, with guide lines. Hold Shift while dragging with the mouse to turn it off temporarily; touch always snaps.

## 1.0.0 – 2026-10-30

First release as a Home Assistant integration (successor of the YAML/package solution "Präsenz-Zonen" v2.1).

- All algorithms run server-side: card and binary sensors show the same result.
- Setup via the UI, automatic detection of a device's target/presence entities.
- One device per zone with binary sensor "<Name> (Zone N)" and a "Person count" sensor; "Person count" per room.
- Sitting/lying detection with damping and zone exit margin, stuck detection, presence gate, wall filter.
- Learning ghost filter with a one-time, schedulable learning calibration and continuous learning.
- Auto alignment of multiple sensors (distance-weighted), red calibration cones (single/room), undo/redo.
- Card is loaded automatically, optional sidebar panel.
- Import of the former package solution (`zone_presence.import_legacy`).
- Language: English by default, German selectable (setup step or "Display & language"); the card can
  override it per card with `language: en|de`.
