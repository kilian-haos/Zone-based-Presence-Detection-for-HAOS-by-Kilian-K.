# Changelog

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
