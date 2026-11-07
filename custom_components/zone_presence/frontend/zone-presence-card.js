/*
 * Zone Presence Detection by Kilian K. — Dashboard-Karte & Seitenleisten-Panel
 *
 * Die Karte rechnet nichts selbst: Personen, Zonen-Belegung, Sitz-/Liege-Modus und
 * Geisterfilter kommen live aus der Integration (Websocket). Dadurch zeigt die Karte
 * exakt das, was auch die Binärsensoren sehen. Bearbeitungen (Räume, Zonen, Sensor-
 * Platzierung, Kalibrierung) gehen über die Websocket-API zurück an die Integration.
 */
(() => {
const VERSION = "1.2.0";
const DOMAIN = "zone_presence";
const SCALE = 100;            // SVG-Einheiten pro Meter
const MARGIN = 0.6;           // m Rand
const TAP_PX = 6;             // Pointer-Up bis hier = Tipp
const SNAP_M = 0.12;          // Raum-Zeichnen: Snap auf Nachbar-x/y
const GRID_M = 0.05;          // Raum-Zeichnen: Raster
const HIST_MAX = 5;           // Rückgängig/Wiederholen
const LIVE_THROTTLE = 80;     // ms für Live-Kalibrierung
const EXTRA_RESTORE = 1.0;    // m Extra-Punkte-Wiederherstellung
// Normale Zonen bekommen nie automatisch das Rot der Sperrzonen
const ZONE_COLORS = ["#a78bfa", "#f472b6", "#34d399", "#fbbf24", "#60a5fa", "#22d3ee", "#4ade80", "#c084fc"];
const EXCL_COLOR = "#ff3b3b";
// Sichtbare Elemente (Ansicht) – je Browser gemerkt, Raum-/Modell-Karte über die Kartenkonfiguration
const LAYERS = ["zones", "zone_names", "exclusions", "sensors", "cones", "overlap", "persons", "person_labels", "raw", "rejected", "dims", "heat", "ghostmap"];
const LAYER_DEFAULT = ["zones", "zone_names", "exclusions", "sensors", "cones", "persons", "person_labels"];
const PRESETS = {
  minimal: ["zones", "exclusions", "persons"],
  standard: LAYER_DEFAULT,
  diag: LAYER_DEFAULT.concat(["overlap", "raw", "rejected", "dims", "ghostmap"]),
  all: LAYERS,
};
const ZONE_TEMPLATES = [
  { k: "square", w: 1.5, h: 1.5 }, { k: "sofa", w: 2.2, h: 0.95 }, { k: "bed", w: 2.0, h: 1.8 },
  { k: "bed1", w: 2.0, h: 0.95 }, { k: "table", w: 1.8, h: 1.0 }, { k: "desk", w: 1.4, h: 0.8 }, { k: "armchair", w: 0.9, h: 0.9 },
];
const MODEL_LAYERS = ["g", "r", "u", "h", "t"];   // Geister, Aktivität, Unsicherheit, Aufenthalte, Live-Targets
const NS = "http://www.w3.org/2000/svg";

const d2r = (d) => (d * Math.PI) / 180;
const r2d = (r) => (r * 180) / Math.PI;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const clone = (o) => JSON.parse(JSON.stringify(o));
const rid = (p) => p + Math.random().toString(36).slice(2, 10);
const round = (v, n = 3) => Math.round(v * 10 ** n) / 10 ** n;
function centroid(pts) { let x = 0, y = 0; for (const p of pts) { x += p[0]; y += p[1]; } return [x / pts.length, y / pts.length]; }
/* ===================================================== Sprache (Standard: Englisch) */
const I18N = {
  en: {
    title: "Zone Presence", connecting: "Connecting …", not_setup: "Is the “Zone Presence Detection” integration set up?",
    conn_failed: "Connection failed", error: "Error: ", undo: "Undo", redo: "Redo", undone: "Undone", redone: "Restored",
    raw_btn: "Show raw data & rejected ghosts", help: "Help", guide: "How to use", pin_title: "Edit code",
    m_view: "View", m_zones: "Zones", m_sensors: "Sensors", m_rooms: "Rooms", m_cal: "Calibrate",
    add_room: "＋ Room", settings: "⚙ Settings", settings_tip: "Sensors, algorithms, timings",
    add_zone: "＋ Zone", hint_zones: "Drag corner/edge/centre · edges move parallel · tap centre = extra points · tap name = settings",
    hint_sensors: "Drag sensor = place · arrow = rotate · tap sensor = details & offsets",
    rename_room: "Rename room", delete_room: "Delete room", hint_rooms: "Drag corner/edge (edges move parallel) · tap a length/angle to type it · tap centre = one more point",
    cal_single: "Single sensor", cal_room: "Whole room", autocal: "⚡ Align sensors", off0_one: "Offset 0 (this one)", off0_room: "Offsets 0 (room)",
    cal_all: "⟲ All calibrations", learn_now: "🧠 Learning calibration now",
    hint_cal_single: "Red cone: circle = x/y · arrow = rotate", hint_cal_room: "Red circle = whole room (x/y only)",
    learning: "🧠 Learning … {p} %", scheduled: "🧠 Scheduled {t}",
    off_reset: "Offset reset", off_reset_room: "Room offsets reset", cal_all_q: "Reset all calibrations (offsets of all sensors)?", cal_all_done: "All calibrations reset",
    new_zone: "New zone", del_zone_q: "Delete zone “{n}”? Its binary sensor and person count will be removed.",
    name: "Name", color: "Colour", off_delay: "Off delay (s) – empty = default {d} s", zone_active: "Zone active",
    zone_note: "The binary sensor is named “{n} (Zone {k})” automatically, plus a “Person count” sensor.",
    room_n: "Room {n}", room_name_q: "Room name:", del_room_q: "Delete room “{n}”?", del_room_zones: " Its {k} zone(s) will be deleted too.",
    point_added: "Point added", label: "Short label", room: "Room", range: "Range (m)", half_angle: "Half angle (°)",
    placement: "Placement", pos_x: "Pos X (m)", pos_y: "Pos Y (m)", rotation: "Rotation (°)", flip_x: "Mirror X axis",
    cal_offset: "Calibration offset", off_x: "Offset X (m)", off_y: "Offset Y (m)", off_r: "Offset rotation (°)",
    entities: "Entities", presence_unset: "– (optional, not set)",
    entities_note: "Change entities under <a href=\"#\" data-act=\"settings\">Settings → Configure → Edit sensor entities</a>.",
    aligned: "Aligned: {n} sensors to one point", need_two: "At least 2 sensors must see the same person.",
    too_far: "Measurements are too far apart – put only one person into the overlap area.",
    learn_q: "Start the learning calibration now for {m} minutes?\n\nThe rooms should be empty meanwhile. To schedule it (e.g. at 3 am) use the entities “Learning calibration start time” and “Learning calibration scheduled”.",
    learn_started: "Learning calibration started", apply: "Apply", applied: "Applied", admin_only: "Editing is only allowed for administrators (can be enabled for all users in the integration options).",
    locked_until: "Locked until {t}", wrong_code: "Wrong code – {n} attempts left", enter_code: "Enter 4-digit code",
    g_tabs: "<b>Tabs:</b> switch rooms (number = persons in the room).",
    g_raw: "<b>◎</b> shows raw data: unconfirmed detections (dashed, with confidence) and rejected ghosts (✕).",
    g_edit: "<b>Edit</b> → PIN → toolbar. <b>↶/↷</b> = last 5 actions.",
    g_zones: "<b>Zones:</b> drag corner/edge/centre, tap centre = extra points, tap name = name, colour, own off delay.",
    g_sensors: "<b>Sensors:</b> drag = place, arrow = rotate, tap = details & offsets.",
    g_rooms: "<b>Rooms:</b> drag corners/edges (snapping), tap centre = one more point, ＋ Room.",
    g_cal: "<b>Calibrate:</b> red cone = corrected area. Single: move + rotate. Room: move only. <b>⚡</b> aligns sensors using one person.",
    g_learn: "<b>🧠 Learning calibration:</b> learns ghost spots while the room is empty. Schedulable via the hub entities.",
    card_desc: "Live floor plan with zones, persons and calibration (Zone Presence Detection by Kilian K.)",
    room_card_name: "Zone Presence – Room", room_card_desc: "Only the floor plan of one room, freely scalable (Zone Presence Detection by Kilian K.)",
    ed_room: "Room", ed_first: "First room", ed_cones: "Show sensors and coverage cones", ed_names: "Show zone names", ed_loading: "Loading rooms …",
    ed_error: "Rooms could not be loaded – is the integration set up?",
    v_plan: "Floor plan", v_model: "AI model", layers_btn: "Visible elements",
    lay_zones: "Zones", lay_zone_names: "Zone names & counts", lay_exclusions: "Exclusion zones", lay_sensors: "Sensors",
    lay_cones: "Coverage cones", lay_overlap: "Sensor overlap", lay_persons: "Persons", lay_person_labels: "Person labels",
    lay_raw: "Unconfirmed detections", lay_rejected: "Rejected ghosts", lay_dims: "Dimensions", lay_heat: "Where people stay (heatmap)",
    lay_ghostmap: "Learned ghost spots", presets: "Presets", preset_minimal: "Persons only", preset_standard: "Standard", preset_diag: "Diagnosis", preset_all: "Everything",
    add_excl: "＋ Exclusion zone", new_excl: "Exclusion zone", excl_title: "Exclusion zone",
    excl_depth: "Allowed depth (m) – a person walking in still counts up to this depth",
    excl_learn: "Learn detections here as ghosts", excl_active: "Active",
    excl_note: "Nothing that appears inside an exclusion zone counts – no person, no zone, no learning (unless enabled). A person walking in from outside counts up to the allowed depth and is shown at the edge; deeper in, it is ignored. Exclusion zones have no entities.",
    del_excl_q: "Delete exclusion zone “{n}”?",
    tpl_square: "Square", tpl_sofa: "Sofa", tpl_bed: "Double bed", tpl_bed1: "Single bed", tpl_table: "Dining table", tpl_desk: "Desk", tpl_armchair: "Armchair",
    duplicate: "Duplicate", copy_suffix: " (copy)", duplicated: "Duplicated",
    len_title: "Edge length (m)", keep_angles: "Keep angles (neighbouring walls move along)", angle_title: "Corner angle (°)",
    dims_hint: "Tap a length or angle to type it · Tab = next edge", invalid_len: "Invalid value", ok: "OK",
    m_learned: "What the model has learned", leg_g: "Ghost spots", leg_r: "Real activity", leg_u: "Uncertain (little data)", leg_h: "Where people stay", leg_t: "Live raw targets",
    st_level: "Compute level {l}", st_slot: "Time window {a}–{b} h", st_precision: "Self-check: {p} % correct", st_noprec: "Self-check: collecting data",
    st_today: "Ghosts caught today: {n}", st_week: "Last 7 days: {n}", st_mem: "Memory {kb} kB", st_learning_off: "Continuous learning is off",
    spots_title: "Problem spots", spot_none: "No conspicuous spots – the model has nothing to complain about.",
    spot_wall: "Ghosts keep appearing here close to the wall – probably a reflection off the wall, a window or a mirror.",
    spot_obj: "Ghosts keep appearing here – probably a moving object such as a fan, curtain, plant or radiator.",
    spot_cal: "Learned during the learning calibration (empty room).", spot_slot: "Mostly between {a} and {b} h.", spot_sensor: "Seen by {s}.",
    spot_excl: "Create exclusion zone", spot_forget: "Forget", spot_created: "Exclusion zone created",
    info_g: "Ghost probability", info_r: "Real activity", info_c: "Model confidence", info_h: "Stays (relative)", info_blind: "No sensor sees this spot.",
    forget_area: "Forget this area (Ø 1 m)", forgotten: "Forgotten",
    tl_title: "Time-lapse", tl_none: "No snapshots yet – the model saves one every {h} h.", tl_live: "Now", tl_play: "Play", tl_pause: "Pause",
    export: "Export model", import: "Import model", import_q: "Replace the learned model with the file “{n}”?", imported: "Model imported ({n} sensors)", import_bad: "Not a valid model file",
    model_loading: "Loading model …", model_error: "Model could not be loaded",
    model_card_name: "Zone Presence – AI model", model_card_desc: "Fluid view of what the learning ghost filter has learned, with live raw targets (Zone Presence Detection by Kilian K.)",
    ed_targets: "Show live raw targets", ed_layers: "Visible elements", ed_legend: "Show legend", ed_default_layers: "Default",
    g_view: "<b>👁</b> chooses what is visible. <b>AI model</b> shows what the ghost filter has learned.",
    g_excl: "<b>Exclusion zones</b> (zone mode): detections there never count.",
  },
  de: {
    title: "Präsenz-Zonen", connecting: "Verbinde …", not_setup: "Ist die Integration „Zone Presence Detection“ eingerichtet?",
    conn_failed: "Verbindung fehlgeschlagen", error: "Fehler: ", undo: "Rückgängig", redo: "Wiederholen", undone: "Rückgängig", redone: "Wiederhergestellt",
    raw_btn: "Rohdaten & verworfene Geister anzeigen", help: "Hilfe", guide: "Bedienung", pin_title: "Code für Bearbeiten",
    m_view: "Ansicht", m_zones: "Zonen", m_sensors: "Sensoren", m_rooms: "Räume", m_cal: "Kalibrieren",
    add_room: "＋ Raum", settings: "⚙ Einstellungen", settings_tip: "Sensoren, Algorithmen, Zeiten",
    add_zone: "＋ Zone", hint_zones: "Ecke/Kante/Mitte ziehen · Kanten wandern parallel · Mitte tippen = Extra-Punkte · Name tippen = Einstellungen",
    hint_sensors: "Sensor ziehen = platzieren · Pfeil = drehen · Sensor tippen = Details & Offsets",
    rename_room: "Raum umbenennen", delete_room: "Raum löschen", hint_rooms: "Ecke/Kante ziehen (Kanten wandern parallel) · Länge/Winkel antippen zum Eintippen · Mitte tippen = Punkt mehr",
    cal_single: "Einzelner Sensor", cal_room: "Ganzer Raum", autocal: "⚡ Sensoren abgleichen", off0_one: "Offset 0 (dieser)", off0_room: "Offsets 0 (Raum)",
    cal_all: "⟲ Alle Kalibrierungen", learn_now: "🧠 Lernkalibrierung jetzt",
    hint_cal_single: "Roter Kegel: Kreis = x/y · Pfeil = drehen", hint_cal_room: "Roter Kreis = ganzer Raum (nur x/y)",
    learning: "🧠 Lernt … {p} %", scheduled: "🧠 Geplant {t}",
    off_reset: "Offset zurückgesetzt", off_reset_room: "Offsets des Raums zurückgesetzt", cal_all_q: "Alle Kalibrierungen (Offsets aller Sensoren) zurücksetzen?", cal_all_done: "Alle Kalibrierungen zurückgesetzt",
    new_zone: "Neue Zone", del_zone_q: "Zone „{n}“ löschen? Ihr Binärsensor und ihre Personenanzahl werden entfernt.",
    name: "Name", color: "Farbe", off_delay: "Nachlaufzeit (s) – leer = Standard {d} s", zone_active: "Zone aktiv",
    zone_note: "Der Binärsensor heißt automatisch „{n} (Zone {k})“, dazu gibt es „Personenanzahl“.",
    room_n: "Raum {n}", room_name_q: "Raumname:", del_room_q: "Raum „{n}“ löschen?", del_room_zones: " Seine {k} Zone(n) werden ebenfalls gelöscht.",
    point_added: "Punkt hinzugefügt", label: "Kürzel", room: "Raum", range: "Reichweite (m)", half_angle: "Halbwinkel (°)",
    placement: "Platzierung", pos_x: "Pos X (m)", pos_y: "Pos Y (m)", rotation: "Rotation (°)", flip_x: "X-Achse spiegeln",
    cal_offset: "Kalibrier-Offset", off_x: "Offset X (m)", off_y: "Offset Y (m)", off_r: "Offset Rotation (°)",
    entities: "Entitäten", presence_unset: "– (optional, nicht gesetzt)",
    entities_note: "Entitäten änderst du unter <a href=\"#\" data-act=\"settings\">Einstellungen → Konfigurieren → Sensor-Entitäten bearbeiten</a>.",
    aligned: "Abgeglichen: {n} Sensoren auf einen Punkt", need_two: "Mindestens 2 Sensoren müssen dieselbe Person sehen.",
    too_far: "Messpunkte liegen zu weit auseinander – nur eine Person in den Überlappungsbereich stellen.",
    learn_q: "Lernkalibrierung jetzt für {m} Minuten starten?\n\nWährenddessen sollten die Räume leer sein. Geplant (z. B. nachts um 3 Uhr) geht es über die Entitäten „Startzeit Lernkalibrierung“ und „Lernkalibrierung geplant“.",
    learn_started: "Lernkalibrierung gestartet", apply: "Übernehmen", applied: "Übernommen", admin_only: "Bearbeiten ist nur für Administratoren erlaubt (in den Optionen der Integration für alle freigebbar).",
    locked_until: "Gesperrt bis {t} Uhr", wrong_code: "Falscher Code – noch {n} Versuche", enter_code: "4-stelligen Code eingeben",
    g_tabs: "<b>Tabs:</b> Räume wechseln (Zahl = Personen im Raum).",
    g_raw: "<b>◎</b> zeigt Rohdaten: unbestätigte Detektionen (gestrichelt, mit Konfidenz) und verworfene Geister (✕).",
    g_edit: "<b>Bearbeiten</b> → PIN → Leiste. <b>↶/↷</b> = letzte 5 Aktionen.",
    g_zones: "<b>Zonen:</b> Ecke/Kante/Mitte ziehen, Mitte tippen = Extra-Punkte, Name tippen = Name, Farbe, eigene Nachlaufzeit.",
    g_sensors: "<b>Sensoren:</b> ziehen = platzieren, Pfeil = drehen, tippen = Details & Offsets.",
    g_rooms: "<b>Räume:</b> Ecken/Kanten ziehen (Snapping), Mitte tippen = Punkt mehr, ＋ Raum.",
    g_cal: "<b>Kalibrieren:</b> roter Kegel = korrigierter Bereich. Einzeln: verschieben + drehen. Raum: nur verschieben. <b>⚡</b> gleicht Sensoren über eine Person ab.",
    g_learn: "<b>🧠 Lernkalibrierung:</b> lernt bei leerem Raum die Geisterstellen. Planbar über die Hub-Entitäten.",
    card_desc: "Live-Grundriss mit Zonen, Personen und Kalibrierung (Zone Presence Detection by Kilian K.)",
    room_card_name: "Zone Presence – Raum", room_card_desc: "Nur der Grundriss eines Raums, frei skalierbar (Zone Presence Detection by Kilian K.)",
    ed_room: "Raum", ed_first: "Erster Raum", ed_cones: "Sensoren und Erfassungskegel anzeigen", ed_names: "Zonennamen anzeigen", ed_loading: "Räume werden geladen …",
    ed_error: "Räume konnten nicht geladen werden – ist die Integration eingerichtet?",
    v_plan: "Grundriss", v_model: "KI-Modell", layers_btn: "Sichtbare Elemente",
    lay_zones: "Zonen", lay_zone_names: "Zonennamen & Zähler", lay_exclusions: "Sperrzonen", lay_sensors: "Sensoren",
    lay_cones: "Erfassungskegel", lay_overlap: "Überlappung der Sensoren", lay_persons: "Personen", lay_person_labels: "Personen-Beschriftung",
    lay_raw: "Unbestätigte Detektionen", lay_rejected: "Verworfene Geister", lay_dims: "Bemaßung", lay_heat: "Aufenthalte (Heatmap)",
    lay_ghostmap: "Gelernte Geisterstellen", presets: "Voreinstellungen", preset_minimal: "Nur Personen", preset_standard: "Standard", preset_diag: "Diagnose", preset_all: "Alles",
    add_excl: "＋ Sperrzone", new_excl: "Sperrzone", excl_title: "Sperrzone",
    excl_depth: "Erlaubte Eindringtiefe (m) – eine hereinkommende Person zählt bis zu dieser Tiefe",
    excl_learn: "Erkennungen hier als Geister lernen", excl_active: "Aktiv",
    excl_note: "Was in einer Sperrzone auftaucht, zählt nicht – keine Person, keine Zone, kein Lernen (außer eingeschaltet). Eine von außen hereinkommende Person zählt bis zur erlaubten Eindringtiefe und wird am Rand angezeigt, tiefer drin wird sie ignoriert. Sperrzonen haben keine Entitäten.",
    del_excl_q: "Sperrzone „{n}“ löschen?",
    tpl_square: "Quadrat", tpl_sofa: "Sofa", tpl_bed: "Doppelbett", tpl_bed1: "Einzelbett", tpl_table: "Esstisch", tpl_desk: "Schreibtisch", tpl_armchair: "Sessel",
    duplicate: "Duplizieren", copy_suffix: " (Kopie)", duplicated: "Dupliziert",
    len_title: "Kantenlänge (m)", keep_angles: "Winkel beibehalten (Nachbarwände wandern mit)", angle_title: "Eckwinkel (°)",
    dims_hint: "Länge oder Winkel antippen zum Eintippen · Tab = nächste Kante", invalid_len: "Ungültiger Wert", ok: "OK",
    m_learned: "Was das Modell gelernt hat", leg_g: "Geisterstellen", leg_r: "Echte Aktivität", leg_u: "Unsicher (wenig Daten)", leg_h: "Aufenthalte", leg_t: "Live-Rohtargets",
    st_level: "Rechenlast {l}", st_slot: "Tageszeit-Fenster {a}–{b} Uhr", st_precision: "Selbstprüfung: {p} % richtig", st_noprec: "Selbstprüfung: sammelt noch Daten",
    st_today: "Heute abgefangene Geister: {n}", st_week: "Letzte 7 Tage: {n}", st_mem: "Speicher {kb} kB", st_learning_off: "Kontinuierliches Lernen ist aus",
    spots_title: "Problemstellen", spot_none: "Keine auffälligen Stellen – das Modell hat nichts zu beanstanden.",
    spot_wall: "Hier tauchen immer wieder Geister nahe der Wand auf – vermutlich eine Reflexion an Wand, Fenster oder Spiegel.",
    spot_obj: "Hier tauchen immer wieder Geister auf – vermutlich ein bewegtes Objekt wie Ventilator, Vorhang, Pflanze oder Heizung.",
    spot_cal: "Gelernt in der Lernkalibrierung (leerer Raum).", spot_slot: "Vor allem zwischen {a} und {b} Uhr.", spot_sensor: "Gesehen von {s}.",
    spot_excl: "Sperrzone anlegen", spot_forget: "Vergessen", spot_created: "Sperrzone angelegt",
    info_g: "Geister-Wahrscheinlichkeit", info_r: "Echte Aktivität", info_c: "Modell-Sicherheit", info_h: "Aufenthalte (relativ)", info_blind: "Kein Sensor sieht diese Stelle.",
    forget_area: "Diesen Bereich vergessen (Ø 1 m)", forgotten: "Vergessen",
    tl_title: "Zeitraffer", tl_none: "Noch keine Schnappschüsse – das Modell speichert alle {h} h einen.", tl_live: "Jetzt", tl_play: "Abspielen", tl_pause: "Pause",
    export: "Modell exportieren", import: "Modell importieren", import_q: "Gelerntes Modell durch die Datei „{n}“ ersetzen?", imported: "Modell importiert ({n} Sensoren)", import_bad: "Keine gültige Modelldatei",
    model_loading: "Modell wird geladen …", model_error: "Modell konnte nicht geladen werden",
    model_card_name: "Zone Presence – KI-Modell", model_card_desc: "Fließende Ansicht dessen, was der lernende Geisterfilter gelernt hat, mit Live-Rohtargets (Zone Presence Detection by Kilian K.)",
    ed_targets: "Live-Rohtargets anzeigen", ed_layers: "Sichtbare Elemente", ed_legend: "Legende anzeigen", ed_default_layers: "Standard",
    g_view: "<b>👁</b> wählt, was sichtbar ist. <b>KI-Modell</b> zeigt, was der Geisterfilter gelernt hat.",
    g_excl: "<b>Sperrzonen</b> (Zonen-Modus): Erkennungen dort zählen nie.",
  },
};
const normLang = (l) => { const v = String(l || "").toLowerCase().slice(0, 2); return I18N[v] ? v : "en"; };
const fmtStr = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? vars[k] : m));
/* ===================================================== Einrasten (Snapping)
 * Sanfter Widerstand beim Zeichnen von Zonen und Räumen:
 *  - Punkte: Raumecken und Ecken anderer Zonen (Zonen), stärkste Stufe
 *  - Linien: Wände und Kanten anderer Zonen (Zonen); Parallelen/rechte Winkel zu Wänden,
 *    eigenen Kanten und den Achsen, ausgehend von den festen Nachbarecken
 *  - Schnittpunkte zweier Linien (z. B. parallel zur Wand UND rechter Winkel)
 * Fangradien in Bildschirm-Pixeln (gleiches Gefühl bei jeder Größe), mit Hysterese.
 * Maus + gedrückte Shift-Taste schaltet das Einrasten vorübergehend ab (Touch rastet immer).
 */
const SNAP_PX = { pt: 12, line: 9 };
const SNAP_KEEP = 1.4;
const vsub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const vadd = (a, b) => [a[0] + b[0], a[1] + b[1]];
const vmul = (a, k) => [a[0] * k, a[1] * k];
const vdot = (a, b) => a[0] * b[0] + a[1] * b[1];
const vcross = (a, b) => a[0] * b[1] - a[1] * b[0];
const vunit = (a) => { const l = Math.hypot(a[0], a[1]); return l > 1e-9 ? [a[0] / l, a[1] / l] : null; };
const projLine = (p, a, d) => vadd(a, vmul(d, vdot(vsub(p, a), d)));
function lineX(a1, d1, a2, d2) {
  const c = vcross(d1, d2);
  if (Math.abs(c) < 0.17) return null;            // fast parallel (< ~10°)
  return vadd(a1, vmul(d1, vcross(vsub(a2, a1), d2) / c));
}
function polyEdges(pts) { return pts.map((p, i) => [p, pts[(i + 1) % pts.length]]); }
// Eindeutige Richtungen (mod 180°) inkl. der Senkrechten
function dirSet(segs, extra) {
  const out = [];
  const add = (d) => { if (!d) return; for (const e of out) if (Math.abs(vcross(d, e)) < 0.009) return; out.push(d); };
  for (const d of extra || []) { add(vunit(d)); add(vunit([-d[1], d[0]])); }
  for (const [a, b] of segs) { const d = vunit(vsub(b, a)); if (d) { add(d); add([-d[1], d[0]]); } }
  return out;
}
const segLines = (segs, tag) => segs.map(([a, b], i) => { const d = vunit(vsub(b, a)); return d ? { a, d, seg: [a, b], key: tag + i } : null; }).filter(Boolean);
const anchorLines = (pt, dirs, tag) => dirs.map((d, j) => ({ a: pt, d, key: `${tag}_${j}` }));
function nearLines(p, lines, tol, prev) {
  const out = [];
  for (const L of lines) {
    const q = projLine(p, L.a, L.d);
    if (L.seg) {                                   // Strecke: nur in ihrem Bereich (+Toleranz)
      const t = vdot(vsub(q, L.seg[0]), L.d), len = dist(L.seg[0], L.seg[1]);
      if (t < -tol || t > len + tol) continue;
    }
    const dd = dist(p, q);
    if (dd <= (prev.includes(L.key) ? tol * SNAP_KEEP : tol)) out.push({ L, q, dd });
  }
  return out;
}
// Einzelner Punkt (Ecke ziehen). ctx: { pts, lines, tolP, tolL, prev }
function snapPoint(p, ctx) {
  const prev = ctx.prev || "";
  let best = null;
  ctx.pts.forEach((q, i) => {
    const key = "p" + i, dd = dist(p, q);
    if (dd <= (prev === key ? ctx.tolP * SNAP_KEEP : ctx.tolP) && (!best || dd < best.dd)) best = { q, dd, key, guides: [{ pt: q }] };
  });
  if (best) return best;
  const near = nearLines(p, ctx.lines, ctx.tolL, prev);
  let bi = null;
  for (let i = 0; i < near.length; i++) for (let j = i + 1; j < near.length; j++) {
    const A = near[i].L, B = near[j].L, X = lineX(A.a, A.d, B.a, B.d);
    if (!X) continue;
    const key = [A.key, B.key].sort().join("&"), dd = dist(p, X);
    if (dd <= (prev === key ? ctx.tolP * SNAP_KEEP : ctx.tolP) && (!bi || dd < bi.dd)) bi = { q: X, dd, key, guides: [{ line: A }, { line: B }] };
  }
  if (bi) return bi;
  if (!near.length) return null;
  near.sort((a, b) => (prev === b.L.key) - (prev === a.L.key) || a.dd - b.dd);
  return { q: near[0].q, dd: near[0].dd, key: near[0].L.key, guides: [{ line: near[0].L }], line: near[0].L };
}
// Mehrere Punkte gemeinsam verschieben (Kante/ganze Zone). items: [{ v, lines }]
function snapTranslate(items, ctx) {
  const prev = ctx.prev || "";
  let best = null;
  items.forEach((it, k) => ctx.pts.forEach((q, i) => {
    const key = `p${i}@${k}`, dd = dist(it.v, q);
    if (dd <= (prev === key ? ctx.tolP * SNAP_KEEP : ctx.tolP) && (!best || dd < best.dd)) best = { t: vsub(q, it.v), dd, key, guides: [{ pt: q }] };
  }));
  if (best) return best;
  const cands = [];
  items.forEach((it, k) => {
    for (const n of nearLines(it.v, ctx.lines.concat(it.lines || []), ctx.tolL, prev)) cands.push({ c: vsub(n.q, it.v), dd: n.dd, L: n.L, key: `${n.L.key}@${k}` });
  });
  if (!cands.length) return null;
  cands.sort((a, b) => (prev.includes(b.key)) - (prev.includes(a.key)) || a.dd - b.dd);
  const c1 = cands[0], m1 = [-c1.L.d[1], c1.L.d[0]];
  for (const c2 of cands.slice(1)) {                // zweite, nicht parallele Linie -> beide Richtungen
    if (Math.abs(vcross(c1.L.d, c2.L.d)) < 0.34) continue;
    const m2 = [-c2.L.d[1], c2.L.d[0]], b1 = vdot(c1.c, m1), b2 = vdot(c2.c, m2), det = m1[0] * m2[1] - m1[1] * m2[0];
    const t = [(b1 * m2[1] - m1[1] * b2) / det, (m1[0] * b2 - b1 * m2[0]) / det];
    if (dist(t, c1.c) <= ctx.tolP) return { t, key: [c1.key, c2.key].sort().join("&"), guides: [{ line: c1.L }, { line: c2.L }] };
  }
  return { t: c1.c, key: c1.key, guides: [{ line: c1.L }], line: c1.L };
}
const isAxis = (d) => Math.abs(d[0]) < 1e-6 || Math.abs(d[1]) < 1e-6;
const gridR = (v) => round(Math.round(v / GRID_M) * GRID_M);
function pip(x, y, poly) { let ins = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi) ins = !ins; } return ins; }
// Schnittpunkt zweier Geraden (Punkt + Richtung), null bei (fast) parallel
function lineHit(a1, d1, a2, d2) { const c = vcross(d1, d2); if (Math.abs(c) < 1e-6) return null; return vadd(a1, vmul(d1, vcross(vsub(a2, a1), d2) / c)); }
// Innenwinkel an Ecke i (0..360) und Richtung der Winkelhalbierenden ins Rauminnere
function cornerInfo(poly, i) {
  const n = poly.length, p = poly[i], a = poly[(i - 1 + n) % n], b = poly[(i + 1) % n];
  const ua = vunit(vsub(a, p)), ub = vunit(vsub(b, p));
  if (!ua || !ub) return { deg: 180, bis: [0, -1], ua: ua || [1, 0], ub: ub || [-1, 0] };
  const small = r2d(Math.acos(Math.max(-1, Math.min(1, vdot(ua, ub)))));
  let bis = vunit(vadd(ua, ub)) || [-ua[1], ua[0]];
  const probe = vadd(p, vmul(bis, 0.02));
  const inside = pip(probe[0], probe[1], poly);
  return { deg: inside ? small : 360 - small, bis: inside ? bis : vmul(bis, -1), ua, ub };
}
const rot2 = (v, deg) => { const r = d2r(deg), c = Math.cos(r), s = Math.sin(r); return [v[0] * c - v[1] * s, v[0] * s + v[1] * c]; };
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

/* ===================================================== Modell-Ansicht: fließende Wolken
 * Canvas über dem Grundriss. Die Lernkarten (Raumraster aus der Integration) werden als
 * weich gezeichnete Grundschicht plus driftende "Wölkchen" (Partikel) dargestellt, die
 * einem langsamen Strömungsfeld folgen. Live-Rohtargets sind kleine leuchtende Wolken,
 * die beim Bewegen Schwaden hinter sich herziehen. Ein feiner Nebel sorgt dafür, dass es
 * nie still steht. Nur gezeichnet, solange die Ansicht sichtbar ist.
 */
const MCOL = {
  g: [[255, 43, 214], [255, 77, 141], [255, 150, 70]],    // Geister: Magenta -> Pink -> Orange
  r: [[45, 212, 191], [56, 189, 248], [129, 140, 248]],   // Aktivität: Türkis -> Cyan -> Indigo
  u: [[46, 52, 96], [72, 80, 150], [104, 110, 196]],      // Unsicherheit: Nachtblau
  h: [[245, 158, 11], [251, 191, 36], [254, 240, 138]],   // Aufenthalte: Bernstein -> Gelb
};
const MLEG = { g: "#ff4dd2", r: "#38d9f8", u: "#7c83d8", h: "#fbbf24", t: "#e9e9ff" };
function ramp(cols, v) {
  const t = Math.max(0, Math.min(1, v)) * (cols.length - 1), i = Math.min(cols.length - 2, Math.floor(t)), f = t - i, a = cols[i], b = cols[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
const hexRgb = (h) => { const m = String(h || "#999").replace("#", ""); const v = m.length === 3 ? m.split("").map((c) => c + c).join("") : m.slice(0, 6); return [parseInt(v.slice(0, 2), 16) || 0, parseInt(v.slice(2, 4), 16) || 0, parseInt(v.slice(4, 6), 16) || 0]; };
const mixRgb = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// Textur einer Ebene (1 Pixel je Rasterzelle) + Gewichte zum Platzieren der Wölkchen
function buildTex(src, key, poly) {
  const { nx, ny, res, x0, y0 } = src, n = nx * ny;
  const cv = document.createElement("canvas"); cv.width = nx; cv.height = ny;
  const cx = cv.getContext("2d"), img = cx.createImageData(nx, ny), w = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const gx = i % nx, gy = (i / nx) | 0;
    let v = 0, a = 0, col = null;
    if (key === "g") { v = (src.g[i] || 0) / 100; if (v > 0.03) { col = ramp(MCOL.g, v); a = Math.pow(v, 0.8) * 0.95; } }
    else if (key === "r") { v = (src.r ? src.r[i] : 0) / 100; if (v > 0.03) { col = ramp(MCOL.r, v); a = Math.pow(v, 0.85) * 0.8; } }
    else if (key === "h") { v = (src.h ? src.h[i] : 0) / 100; if (v > 0.03) { col = ramp(MCOL.h, v); a = Math.pow(v, 0.7) * 0.85; } }
    else if (key === "u") {
      if (!src.v || !src.c) continue;
      const inside = pip(x0 + (gx + 0.5) * res, y0 + (gy + 0.5) * res, poly);
      if (!inside) continue;
      if (src.v[i] > 0) { v = 1 - (src.c[i] || 0) / 100; if (v > 0.35) { col = ramp(MCOL.u, v); a = (v - 0.35) * 0.42; } }
      else { v = 0; col = [4, 3, 10]; a = 0.6; }           // toter Winkel
    }
    if (!col) continue;
    const k = i * 4;
    img.data[k] = col[0]; img.data[k + 1] = col[1]; img.data[k + 2] = col[2]; img.data[k + 3] = Math.round(Math.min(1, a) * 255);
    w[i] = key === "u" ? Math.max(0, v - 0.35) : v * v;
    sum += w[i];
  }
  cx.putImageData(img, 0, 0);
  const cdf = new Float32Array(n); let acc = 0;
  for (let i = 0; i < n; i++) { acc += w[i]; cdf[i] = acc; }
  return { cv, cdf, sum, w, src };
}

class ModelFX {
  constructor(card) {
    this.card = card;
    this.parts = []; this.trails = []; this.mist = []; this.tg = new Map(); this.sprites = new Map();
    this.tex = {}; this.base = null; this.running = false; this.visible = true; this.last = 0; this.fc = 0;
    this.reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    this.speed = this.reduce ? 0.35 : 1;
  }
  attach(canvas, svg, poly, layers) {
    const same = this.poly && JSON.stringify(this.poly) === JSON.stringify(poly);
    this.canvas = canvas; this.svg = svg; this.poly = poly; this.layers = layers;
    this.ctx = canvas.getContext("2d");
    this.base = null;
    if (!same) { this.mist = []; this.parts = []; this.trails = []; this.tg.clear(); this.src = null; this.tex = {}; }
    this._resize();
    if (this._ro) this._ro.disconnect();
    if (window.ResizeObserver) { this._ro = new ResizeObserver(() => { this._resize(); this.base = null; }); this._ro.observe(canvas); }
    if (this._io) this._io.disconnect();
    if (window.IntersectionObserver) { this._io = new IntersectionObserver((es) => { this.visible = es.some((e) => e.isIntersecting); }); this._io.observe(canvas); }
    if (this.src) this.setData(this.src, true);
  }
  detach() { this.stop(); if (this._ro) this._ro.disconnect(); if (this._io) this._io.disconnect(); this._ro = this._io = null; }
  _resize() {
    const c = this.canvas; if (!c || !c.isConnected) return false;
    const r = c.getBoundingClientRect(), dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; this.base = null; }
    const m = this.svg.getScreenCTM(); if (!m) return false;
    const b = this.card._b;
    const kx = dpr * m.a * SCALE, ky = dpr * m.d * SCALE;
    const ox = dpr * (m.e - r.left) - kx * b.minx, oy = dpr * (m.f - r.top) - ky * b.miny;
    if (!this.k || Math.abs(this.k.kx - kx) > 1e-6 || Math.abs(this.k.ox - ox) > 0.5 || Math.abs(this.k.oy - oy) > 0.5) this.base = null;
    this.k = { kx, ky, ox, oy, dpr };
    return true;
  }
  X(x) { return this.k.kx * x + this.k.ox; }
  Y(y) { return this.k.ky * y + this.k.oy; }
  S(m) { return this.k.kx * m; }
  setLayers(set) { this.layers = set; this.base = null; this._retarget(); }
  setData(src, keep) {
    this.src = src;
    this.tex = {};
    for (const k of ["u", "h", "r", "g"]) if (src && (k !== "u" || src.c) && (k !== "h" || src.h)) this.tex[k] = buildTex(src, k, this.poly);
    this.base = null;
    if (!keep) this.parts = this.parts.filter((p) => Math.random() < 0.5);   // weich überblenden
    this._retarget();
  }
  _retarget() {
    const perf = this.reduce ? 0.6 : 1;
    this.want = {};
    const res2 = this.src ? this.src.res * this.src.res : 0.04;
    const f = { g: 70, r: 45, h: 40, u: 6 }, cap = { g: 90, r: 60, h: 55, u: 30 };
    for (const k of ["g", "r", "h", "u"]) {
      const t = this.tex[k];
      this.want[k] = t && this.layers.has(k) && t.sum > 0 ? Math.round(Math.min(cap[k], Math.max(4, t.sum * res2 * f[k])) * perf) : 0;
    }
  }
  setTargets(list) {
    const now = performance.now() / 1000, seen = new Set();
    for (const t of list || []) {
      seen.add(t.k);
      let e = this.tg.get(t.k);
      if (!e) { e = { x: t.x, y: t.y, vx: 0, vy: 0, emit: 0, born: now, a: 0 }; this.tg.set(t.k, e); }
      Object.assign(e, { tx: t.x, ty: t.y, s: t.s, c: t.c, ok: t.ok, ex: t.ex, pr: t.pr, gone: 0 });
    }
    for (const [k, e] of this.tg) if (!seen.has(k) && !e.gone) e.gone = now;
  }
  start() { if (this.running) return; this.running = true; this.last = 0; const loop = (ts) => { if (!this.running) return; this.raf = requestAnimationFrame(loop); this._frame(ts); }; this.raf = requestAnimationFrame(loop); }
  stop() { this.running = false; if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; }
  _sprite(rgb, soft) {
    const key = rgb.map((v) => Math.round(v)).join(",") + (soft ? "s" : "");
    let s = this.sprites.get(key);
    if (!s) {
      s = document.createElement("canvas"); s.width = s.height = 64;
      const c = s.getContext("2d"), g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
      const [r, gg, b] = rgb.map((v) => Math.round(v));
      g.addColorStop(0, `rgba(${r},${gg},${b},${soft ? 0.55 : 1})`); g.addColorStop(soft ? 0.5 : 0.28, `rgba(${r},${gg},${b},${soft ? 0.22 : 0.42})`); g.addColorStop(1, `rgba(${r},${gg},${b},0)`);
      c.fillStyle = g; c.fillRect(0, 0, 64, 64);
      if (this.sprites.size > 200) this.sprites.clear();
      this.sprites.set(key, s);
    }
    return s;
  }
  _flow(x, y, T) {
    const a = Math.sin(x * 1.3 + T * 0.21) + Math.cos(y * 1.1 - T * 0.17) + Math.sin((x + y) * 0.7 + T * 0.13) * 0.8 + Math.cos((x - y) * 0.9 - T * 0.09) * 0.6;
    const ang = a * 1.7;
    return [Math.cos(ang), Math.sin(ang)];
  }
  _spawn(k) {
    const t = this.tex[k]; if (!t || t.sum <= 0) return null;
    const r = Math.random() * t.sum, cdf = t.cdf;
    let lo = 0, hi = cdf.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < r) lo = mid + 1; else hi = mid; }
    const s = t.src, gx = lo % s.nx, gy = (lo / s.nx) | 0, v = Math.min(1, Math.sqrt(t.w[lo]) || 0.5);
    const x = s.x0 + (gx + Math.random()) * s.res, y = s.y0 + (gy + Math.random()) * s.res;
    const R = { g: [0.16, 0.42], r: [0.18, 0.38], h: [0.2, 0.45], u: [0.35, 0.75] }[k];
    const rgb = k === "u" ? (s.v && s.v[lo] === 0 ? [40, 30, 70] : ramp(MCOL.u, v)) : ramp(MCOL[k], v);
    return { k, x, y, v, rgb, r: R[0] + Math.random() * (R[1] - R[0]), age: 0, life: 4 + Math.random() * 6, ph: Math.random() * 6.28 };
  }
  _bbox() { let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (const [x, y] of this.poly) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); } return [a, b, c, d]; }
  _buildBase() {
    const c = this.canvas; if (!c || !this.k) return;
    const base = this.base || document.createElement("canvas");
    base.width = c.width; base.height = c.height;
    const x = base.getContext("2d");
    x.clearRect(0, 0, base.width, base.height);
    x.save();
    this._clip(x);
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high";
    const blur = Math.max(2, this.S(0.16));
    if ("filter" in x) x.filter = `blur(${blur.toFixed(1)}px)`;
    for (const k of ["u", "h", "r", "g"]) {
      const t = this.tex[k]; if (!t || !this.layers.has(k)) continue;
      const s = t.src;
      x.globalCompositeOperation = k === "u" ? "source-over" : "lighter";
      x.globalAlpha = k === "u" ? 0.9 : 0.8;
      x.drawImage(t.cv, this.X(s.x0), this.Y(s.y0), this.S(s.nx * s.res), this.k.ky * s.ny * s.res);
    }
    x.restore();
    this.base = base;
  }
  _clip(x) {
    x.beginPath();
    this.poly.forEach((p, i) => (i ? x.lineTo(this.X(p[0]), this.Y(p[1])) : x.moveTo(this.X(p[0]), this.Y(p[1]))));
    x.closePath(); x.clip();
  }
  _frame(ts) {
    if (!this.visible || document.hidden || !this.canvas || !this.canvas.isConnected) { this.last = ts; return; }
    const dt = Math.min(0.05, this.last ? (ts - this.last) / 1000 : 0.016) * this.speed;
    this.last = ts;
    const T = ts / 1000;
    if (++this.fc % 40 === 0 || !this.k) this._resize();
    if (!this.k) return;
    if (!this.base) this._buildBase();
    const c = this.ctx, W = this.canvas.width, H = this.canvas.height;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = "source-over"; c.globalAlpha = 1;
    c.clearRect(0, 0, W, H);
    c.save();
    this._clip(c);
    // Nebel – immer in Bewegung
    const bb = this._bbox();
    while (this.mist.length < (this.reduce ? 8 : 14)) this.mist.push({ x: bb[0] + Math.random() * (bb[2] - bb[0]), y: bb[1] + Math.random() * (bb[3] - bb[1]), r: 0.9 + Math.random() * 1.0, age: Math.random() * 10, life: 12 + Math.random() * 10, rgb: Math.random() < 0.5 ? [124, 92, 255] : [56, 120, 255] });
    c.globalCompositeOperation = "lighter";
    for (const m of this.mist) {
      const f = this._flow(m.x * 0.5, m.y * 0.5, T * 0.6);
      m.x += f[0] * 0.05 * dt; m.y += f[1] * 0.05 * dt; m.age += dt;
      if (m.age > m.life) { Object.assign(m, { x: bb[0] + Math.random() * (bb[2] - bb[0]), y: bb[1] + Math.random() * (bb[3] - bb[1]), age: 0 }); }
      const a = Math.sin(Math.PI * m.age / m.life) * 0.08, R = this.S(m.r);
      c.globalAlpha = a; c.drawImage(this._sprite(m.rgb, true), this.X(m.x) - R, this.Y(m.y) - R, 2 * R, 2 * R);
    }
    // Grundschicht atmet und wabert leicht
    if (this.base) {
      const w = this.S(0.035);
      c.globalAlpha = 0.62 + 0.18 * Math.sin(T * 0.55);
      c.drawImage(this.base, Math.sin(T * 0.31) * w, Math.cos(T * 0.27) * w);
      c.globalAlpha = 0.28 + 0.1 * Math.sin(T * 0.43 + 1);
      c.drawImage(this.base, Math.cos(T * 0.23) * w * 1.6, Math.sin(T * 0.37) * w * 1.6);
    }
    // Wölkchen
    for (const k of ["u", "h", "r", "g"]) {
      const want = (this.want && this.want[k]) || 0;
      let have = 0; for (const p of this.parts) if (p.k === k) have++;
      for (; have < want; have++) { const p = this._spawn(k); if (!p) break; p.age = Math.random() * p.life * 0.6; this.parts.push(p); }
    }
    const keep = [];
    const count = {};
    for (const p of this.parts) {
      p.age += dt;
      const f = this._flow(p.x, p.y, T);
      const sp = p.k === "u" ? 0.035 : 0.075;
      p.x += f[0] * sp * dt; p.y += f[1] * sp * dt;
      count[p.k] = (count[p.k] || 0) + 1;
      if (p.age > p.life || !this.layers.has(p.k) || count[p.k] > ((this.want && this.want[p.k]) || 0)) {
        const n = this.layers.has(p.k) && count[p.k] <= ((this.want && this.want[p.k]) || 0) ? this._spawn(p.k) : null;
        if (n) keep.push(n);
        continue;
      }
      keep.push(p);
      const life = Math.sin(Math.PI * p.age / p.life);
      const base = { g: 0.55, r: 0.42, h: 0.4, u: 0.12 }[p.k];
      const a = Math.pow(life, 1.2) * base * (0.4 + 0.6 * p.v) * (0.85 + 0.15 * Math.sin(T * 1.7 + p.ph));
      const R = this.S(p.r * (0.85 + 0.35 * p.age / p.life));
      c.globalCompositeOperation = p.k === "u" ? "source-over" : "lighter";
      c.globalAlpha = a; c.drawImage(this._sprite(p.rgb, p.k === "u"), this.X(p.x) - R, this.Y(p.y) - R, 2 * R, 2 * R);
    }
    this.parts = keep;
    // Live-Rohtargets mit Schwaden
    c.globalCompositeOperation = "lighter";
    const now = performance.now() / 1000;
    if (this.layers.has("t")) {
      for (const [key, e] of this.tg) {
        if (e.gone && now - e.gone > 0.8) { this.tg.delete(key); continue; }
        const px = e.x, py = e.y, kk = Math.min(1, dt / this.speed * 9);
        e.x += (e.tx - e.x) * kk; e.y += (e.ty - e.y) * kk;
        const vx = (e.x - px) / Math.max(1e-3, dt), vy = (e.y - py) / Math.max(1e-3, dt);
        e.vx += (vx - e.vx) * 0.2; e.vy += (vy - e.vy) * 0.2;
        const sen = this.card._sensor(e.s), scol = hexRgb(sen ? sen.color : "#8899ff");
        const rgb = e.ex ? [255, 59, 59] : e.pr ? mixRgb(scol, [220, 255, 250], 0.35) : e.ok ? scol : mixRgb(scol, [255, 60, 200], 0.55 * (1 - (e.c || 0)));
        e.rgb = rgb;
        const spd = Math.hypot(e.vx, e.vy);
        e.emit -= dt;
        if (spd > 0.06 && e.emit <= 0 && !e.gone) {
          e.emit = this.reduce ? 0.09 : 0.035;
          const f = this._flow(e.x, e.y, T);
          this.trails.push({ x: e.x, y: e.y, vx: -e.vx * 0.22 + f[0] * 0.05, vy: -e.vy * 0.22 + f[1] * 0.05, age: 0, life: 1.1 + Math.random() * 0.9, r0: 0.07, r1: 0.3 + Math.min(0.25, spd * 0.12), rgb, a: e.ok || e.pr ? 0.42 : 0.3 });
        }
        e.a = e.gone ? Math.max(0, 1 - (now - e.gone) / 0.8) : Math.min(1, e.a + dt * 3);
      }
      const tk = [];
      for (const p of this.trails) {
        p.age += dt; if (p.age > p.life) continue; tk.push(p);
        const f = this._flow(p.x, p.y, T);
        p.x += (p.vx + f[0] * 0.04) * dt; p.y += (p.vy + f[1] * 0.04) * dt;
        p.vx *= 0.985; p.vy *= 0.985;
        const q = p.age / p.life, R = this.S(p.r0 + (p.r1 - p.r0) * q);
        c.globalAlpha = p.a * Math.pow(1 - q, 1.6); c.drawImage(this._sprite(p.rgb, true), this.X(p.x) - R, this.Y(p.y) - R, 2 * R, 2 * R);
      }
      this.trails = tk.length > 600 ? tk.slice(-600) : tk;
      for (const e of this.tg.values()) {
        const X = this.X(e.x), Y = this.Y(e.y), pulse = 1 + 0.08 * Math.sin(T * 3 + e.born);
        const R1 = this.S(0.34) * pulse, R2 = this.S(0.13);
        c.globalAlpha = 0.5 * e.a * (e.ok || e.pr ? 1 : 0.7); c.drawImage(this._sprite(e.rgb), X - R1, Y - R1, 2 * R1, 2 * R1);
        c.globalAlpha = 0.95 * e.a; c.drawImage(this._sprite(mixRgb(e.rgb, [255, 255, 255], 0.45)), X - R2, Y - R2, 2 * R2, 2 * R2);
      }
    } else { this.trails = []; }
    c.restore();
  }
}

class ZonePresenceCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = {};
    this._cfg = null;            // Konfiguration aus dem Backend
    this._live = null;           // Live-Zustand aus dem Backend
    this._activeRoom = null;
    this._mode = "view";         // view | zones | sensors | rooms | cal-sensor | cal-room
    this._calSid = null;
    this._unlocked = false;
    this._showRaw = false;
    this._guideOpen = false;
    this._drag = null;
    this._undo = [];
    this._redo = [];
    this._personEls = new Map();
    this._known = new Set();
    this._pinBuffer = "";
    this._pinThen = null;
    this._lastMsg = 0;
    this._built = false;
    this._zoneExtra = {};         // Wiederherstellung der Extra-Punkte (Sitzung)
    this._view = "plan";          // plan | model
    this._layers = new Set(LAYER_DEFAULT);
    this._mlayers = new Set(["g", "r", "u", "t"]);
    this._mview = null;           // Modelldaten (Raumraster) aus der Integration
    this._fx = null;              // Animation der Modell-Ansicht
  }

  /* ===================================================== Sprache */
  // Folgt automatisch Home Assistant: Sprache des angemeldeten Benutzers (Deutsch oder
  // Englisch). Ohne Frontend-Sprache gilt die Systemsprache aus der Integration.
  get _lang() {
    const h = this._hass;
    const ui = h && ((h.locale && h.locale.language) || h.language);
    return normLang(ui || (this._cfg && this._cfg.language) || "en");
  }
  _t(key, vars) { const d = I18N[this._lang]; return fmtStr(key in d ? d[key] : I18N.en[key] != null ? I18N.en[key] : key, vars); }
  get _title() { return this._config.title || this._t("title"); }
  _timeFmt(t) { return new Date(t).toLocaleTimeString(this._lang === "de" ? "de-DE" : undefined, { hour: "2-digit", minute: "2-digit" }); }

  /* ===================================================== Lebenszyklus */
  setConfig(config) {
    this._config = Object.assign({ lock_minutes: 30, merge_color: "#2dd4bf" }, config || {});
    this._layers = this._loadLayers();
    if (Array.isArray(this._config.model_layers)) this._mlayers = new Set(this._config.model_layers.filter((l) => MODEL_LAYERS.includes(l)));
    if (this._config.show_targets === false) this._mlayers.delete("t");
    this._built = false;
    this._render();
  }

  /* ===================================================== Sichtbare Elemente */
  _loadLayers() {
    const c = this._config || {};
    if (Array.isArray(c.layers) && c.layers.length) return new Set(c.layers.filter((l) => LAYERS.includes(l)));
    if (this._compact) {
      const s = new Set(LAYER_DEFAULT);
      if (c.show_cones === false) { s.delete("cones"); s.delete("sensors"); }
      if (c.show_names === false) s.delete("zone_names");
      return s;
    }
    try { const v = JSON.parse(localStorage.getItem("zp_layers_v1")); if (Array.isArray(v)) return new Set(v.filter((l) => LAYERS.includes(l))); } catch (e) {}
    const s = new Set(LAYER_DEFAULT);
    try { if (localStorage.getItem("zp_show_raw") === "1") { s.add("raw"); s.add("rejected"); } } catch (e) {}
    return s;
  }
  _saveLayers() { if (this._compact) return; try { localStorage.setItem("zp_layers_v1", JSON.stringify([...this._layers])); } catch (e) {} }
  _lay(k) { return this._layers.has(k); }
  _layClasses() { return LAYERS.filter((k) => !this._layers.has(k)).map((k) => " L-off-" + k).join(""); }
  _setLayers(set) {
    this._layers = new Set(set);
    this._saveLayers();
    if (!this._el) return;
    const root = this._el.root;
    for (const k of LAYERS) root.classList.toggle("L-off-" + k, !this._layers.has(k));
    const rb = this.shadowRoot.querySelector(".raw-btn"); if (rb) rb.classList.toggle("on", this._lay("raw"));
    this._renderOverlap(); this._renderDims(); this._renderLive(); this._syncModel();
    this._renderLayPop();
  }
  static getStubConfig() { return {}; }
  getCardSize() { return 14; }
  getGridOptions() { return { columns: "full", min_rows: 8 }; }

  set hass(hass) {
    const first = !this._hass;
    const before = this._hass ? this._lang : null;
    this._hass = hass;
    if (first) this._subscribe();   // Wiederholungen übernimmt der Watchdog
    else if (before !== this._lang && !this._drag) { this._built = false; this._render(); }  // Sprache gewechselt
  }
  get hass() { return this._hass; }

  connectedCallback() {
    this._watch = setInterval(() => {
      if (this._hass && Date.now() - this._lastMsg > 7000) this._subscribe();
    }, 3000);
    if (this._hass && !this._unsubP) this._subscribe();
    if (this._built) this._syncModel();
  }
  disconnectedCallback() {
    clearInterval(this._watch);
    clearInterval(this._mTimer); this._mTimer = null;
    clearTimeout(this._tlTimer);
    if (this._fx) this._fx.stop();
    if (this._layClose) { window.removeEventListener("pointerdown", this._layClose); this._layClose = null; }
    this._unsubscribe();
  }

  async _unsubscribe() {
    const p = this._unsubP;
    this._unsubP = null;
    if (p) { try { (await p)(); } catch (e) {} }
  }

  async _subscribe() {
    if (!this._hass || !this._hass.connection || this._subscribing) return;
    this._subscribing = true;
    await this._unsubscribe();
    this._lastMsg = Date.now();
    const msg = { type: `${DOMAIN}/subscribe`, debug: true };
    if (this._config.entry_id) msg.entry_id = this._config.entry_id;
    try {
      this._unsubP = this._hass.connection.subscribeMessage((m) => this._onMsg(m), msg);
      await this._unsubP;
      this._error = null;
    } catch (e) {
      this._unsubP = null;
      this._error = (e && (e.message || e.code)) || this._t("conn_failed");
      this._render();
    }
    this._subscribing = false;
  }

  _onMsg(m) {
    this._lastMsg = Date.now();
    if (m.type === "config") {
      const firstCfg = !this._cfg;
      this._cfg = m;
      if (!this._activeRoom || !m.rooms.find((r) => r.id === this._activeRoom)) {
        const pref = this._config.room && m.rooms.find((r) => r.id === this._config.room || r.name === this._config.room);
        this._activeRoom = (pref || m.rooms[0] || {}).id || null;
      }
      if (!this._canEdit() && this._mode !== "view") { this._mode = "view"; this._unlocked = false; }
      if (this._drag) { this._pendingRebuild = true; return; }
      this._built = false;
      this._render();
      if (firstCfg) this._renderLive();
    } else if (m.type === "state") {
      this._live = m;
      this._renderLive();
    }
  }

  /* ===================================================== Daten-Helfer */
  get _rooms() { return (this._cfg && this._cfg.rooms) || []; }
  get _zones() { return (this._cfg && this._cfg.zones) || []; }
  get _excls() { return (this._cfg && this._cfg.exclusions) || []; }
  _zoneObj(id) { return this._zones.find((z) => z.id === id) || this._excls.find((z) => z.id === id); }
  _isExcl(z) { return this._excls.includes(z); }
  _applyZones() { return this._apply({ zones: this._zones, exclusions: this._excls }); }
  _fmtNum(v, d = 2) { return Number(v).toLocaleString(this._lang === "de" ? "de-DE" : "en-US", { minimumFractionDigits: d, maximumFractionDigits: d }); }
  _parseNum(s) { const v = parseFloat(String(s).trim().replace(/\s/g, "").replace(",", ".")); return isFinite(v) ? v : NaN; }
  get _sensors() { return (this._cfg && this._cfg.sensors) || []; }
  _room() { return this._rooms.find((r) => r.id === this._activeRoom) || this._rooms[0]; }
  _roomPoly() { const r = this._room(); return r ? r.polygon : [[0, 0], [5, 0], [5, 4], [0, 4]]; }
  _activeSensors() { return this._sensors.filter((s) => s.room === this._activeRoom); }
  _sensor(id) { return this._sensors.find((s) => s.id === id); }
  _off(s) { return s.offset || { dx: 0, dy: 0, dr: 0 }; }
  _basePos(s) { return [Number(s.pos[0]) || 0, Number(s.pos[1]) || 0]; }
  _baseRot(s) { return Number(s.rot) || 0; }
  _effPos(s) { const o = this._off(s), b = this._basePos(s); return [b[0] + (o.dx || 0), b[1] + (o.dy || 0)]; }
  _effRot(s) { return this._baseRot(s) + (this._off(s).dr || 0); }
  _pin() {
    if (this._config.pin != null) return String(this._config.pin);
    return this._cfg ? String(this._cfg.pin || "") : "1234";
  }
  _isAdmin() { return !!(this._cfg && this._cfg.is_admin); }
  // Bearbeiten: Admins, oder alle Benutzer, wenn in der Integration freigegeben
  _canEdit() { return !this._compact && !!(this._cfg && (this._cfg.can_edit != null ? this._cfg.can_edit : this._cfg.is_admin)); }

  _geometry() {
    const out = {};
    for (const s of this._sensors) {
      out[s.id] = {
        label: s.label, name: s.name, color: s.color, room: s.room, pos: s.pos, rot: s.rot,
        flip_x: s.flip_x, flip_y: s.flip_y, range: s.range, half_angle: s.half_angle, offset: this._off(s),
      };
    }
    return out;
  }

  /* ===================================================== Backend-Aufrufe */
  _ws(msg) {
    if (this._config.entry_id) msg.entry_id = this._config.entry_id;
    return this._hass.callWS(msg);
  }
  async _apply(parts, persist = true) {
    const msg = Object.assign({ type: `${DOMAIN}/apply`, persist }, parts);
    try { await this._ws(msg); }
    catch (e) { this._toast(this._t("error") + ((e && e.message) || e)); }
  }
  _applyLive(parts) {
    this._livePending = Object.assign(this._livePending || {}, parts);
    if (this._liveTimer) return;
    this._liveTimer = setTimeout(() => {
      const p = this._livePending; this._livePending = null; this._liveTimer = null;
      if (p) this._apply(p, false);
    }, LIVE_THROTTLE);
  }
  _flushLive() { clearTimeout(this._liveTimer); this._liveTimer = null; this._livePending = null; }

  /* ===================================================== Verlauf */
  _snap() { return JSON.stringify({ rooms: this._rooms, zones: this._zones, exclusions: this._excls, sensors: this._geometry(), active: this._activeRoom }); }
  _pushUndo() { this._undo.push(this._snap()); if (this._undo.length > HIST_MAX) this._undo.shift(); this._redo = []; this._updHist(); }
  _popNoop() { this._undo.pop(); this._updHist(); }
  _restore(str) {
    const s = JSON.parse(str);
    this._cfg.rooms = s.rooms; this._cfg.zones = s.zones; this._cfg.exclusions = s.exclusions || [];
    for (const sen of this._sensors) if (s.sensors[sen.id]) Object.assign(sen, s.sensors[sen.id]);
    if (s.rooms.find((r) => r.id === s.active)) this._activeRoom = s.active;
    this._apply({ rooms: s.rooms, zones: s.zones, exclusions: this._cfg.exclusions, sensors: s.sensors }, true);
    this._built = false; this._render();
  }
  _undoAct() { if (!this._undo.length) return; this._redo.push(this._snap()); if (this._redo.length > HIST_MAX) this._redo.shift(); this._restore(this._undo.pop()); this._toast(this._t("undone")); }
  _redoAct() { if (!this._redo.length) return; this._undo.push(this._snap()); if (this._undo.length > HIST_MAX) this._undo.shift(); this._restore(this._redo.pop()); this._toast(this._t("redone")); }
  _updHist() {
    if (!this._el) return;
    this._el.undo.hidden = this._el.redo.hidden = !this._unlocked;
    this._el.undo.disabled = !this._undo.length;
    this._el.redo.disabled = !this._redo.length;
  }

  /* ===================================================== Geometrie/Viewport */
  // Ansicht auf den Raum zentriert (+ Sensoren). Die Kegel ragen darüber hinaus und
  // werden an den Rändern weich ausgeblendet (Masken fadeMX/fadeMY) statt hart abgeschnitten.
  _bounds() {
    const poly = this._roomPoly();
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    const fold = (x, y) => { minx = Math.min(minx, x); miny = Math.min(miny, y); maxx = Math.max(maxx, x); maxy = Math.max(maxy, y); };
    for (const [x, y] of poly) fold(x, y);
    for (const s of this._activeSensors()) for (const p of [this._basePos(s), this._effPos(s)]) fold(p[0], p[1]);
    if (!isFinite(minx)) { minx = 0; miny = 0; maxx = 5; maxy = 4; }
    const pad = MARGIN + 0.6;
    return { minx: minx - pad, miny: miny - pad, w: maxx - minx + 2 * pad, h: maxy - miny + 2 * pad };
  }
  _fadeDefs(b) {
    const W = b.w * SCALE, H = b.h * SCALE, f = 70;
    const grad = (id, x2, y2, L) => `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${x2}" y2="${y2}">
      <stop offset="0" stop-color="#000"/><stop offset="${f / L}" stop-color="#fff"/><stop offset="${1 - f / L}" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient>`;
    const mask = (id, g) => `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="url(#${g})"/></mask>`;
    return grad("fadeX", W, 0, W) + grad("fadeY", 0, H, H) + mask("fadeMX", "fadeX") + mask("fadeMY", "fadeY");
  }
  _px(x, y) { return [(x - this._b.minx) * SCALE, (y - this._b.miny) * SCALE]; }
  _toRoom(sx, sy) { return [sx / SCALE + this._b.minx, sy / SCALE + this._b.miny]; }
  _pathD(pts) { return pts.map((p, i) => (i ? "L" : "M") + this._px(p[0], p[1]).join(" ")).join(" ") + " Z"; }
  _conePath(pos, rot, s) {
    const pts = [pos], base = d2r(rot), half = d2r(s.half_angle || 60), R = s.range || 6;
    for (let k = 0; k <= 24; k++) { const a = -half + (2 * half * k) / 24; pts.push([pos[0] - Math.sin(base + a) * R, pos[1] + Math.cos(base + a) * R]); }
    return this._pathD(pts);
  }

  /* ===================================================== Rendern */
  _render() {
    if (!this.shadowRoot) return;
    if (!this._cfg) {
      this.shadowRoot.innerHTML = `<style>${this._css()}</style><div class="zp">${this._compact ? "" : `<div class="topbar"><div class="title">${esc(this._title)}</div></div>`}
        <div class="empty">${this._error ? "⚠ " + esc(this._error) + "<br><small>" + esc(this._t("not_setup")) + "</small>" : esc(this._t("connecting"))}</div></div>`;
      this._el = null;
      return;
    }
    this._b = this._bounds();
    const b = this._b;
    this.shadowRoot.innerHTML = `<style>${this._css()}</style>${this._html(b)}`;
    const q = (s) => this.shadowRoot.querySelector(s);
    this._el = {
      root: q(".zp"), svg: q("svg.stage"), tabs: q(".tabs"), toolbar: q(".toolbar"), ctx: q(".ctxbar"),
      room: q("#room"), cov: q("#coverage"), ghosts: q("#ghosts"), zones: q("#zones"), sensors: q("#sensors"),
      raw: q("#raw"), persons: q("#persons"), panel: q(".panel"), pin: q(".pin-overlay"), toast: q(".toast"),
      mode: q(".mode-btn"), undo: q(".undo-btn"), redo: q(".redo-btn"), guide: q(".guide"), chip: q(".chip"), guides: q("#guides"),
      excl: q("#excl"), dims: q("#dims"), overlap: q("#overlap"), mbg: q("#mbg"), fx: q("canvas.fx"), over: q("svg.over"),
      ospots: q("#ospots"), dimedit: q(".dimedit"), minfo: q(".minfo"), mpanel: q(".mpanel"), laypop: q(".laypop"),
      mlegend: q(".mlegend"), wrap: q(".stage-wrap"),
    };
    this._personEls = new Map();
    this._wire();
    this._renderRoom();
    this._renderSensors();
    this._renderZones();
    this._renderGhosts();
    this._renderOverlap();
    this._renderDims();
    this._renderCtx();
    this._updHist();
    this._built = true;
    this._renderLive();
    this._syncModel();
  }

  _html(b) {
    const admin = this._canEdit();
    return `
    <div class="zp${this._guideOpen ? "" : " guide-collapsed"}${this._compact ? " compact" : ""}${this._view === "model" ? " view-model" : ""}${this._layClasses()}" data-mode="${this._mode}">
      <div class="topbar">
        <div class="title">${esc(this._title)}</div>
        <div class="segs vseg"><button class="seg${this._view === "plan" ? " on" : ""}" data-view="plan">${esc(this._t("v_plan"))}</button><button class="seg${this._view === "model" ? " on" : ""}" data-view="model">✦ ${esc(this._t("v_model"))}</button></div>
        <span class="chip" hidden></span>
        <div class="spacer"></div>
        <button class="icon-btn lay-btn" title="${esc(this._t("layers_btn"))}"><svg viewBox="0 0 24 24" width="17" height="17"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/></svg></button>
        <button class="icon-btn raw-btn${this._lay("raw") ? " on" : ""}" title="${esc(this._t("raw_btn"))}">◎</button>
        <button class="icon-btn undo-btn" title="${esc(this._t("undo"))}" hidden>↶</button>
        <button class="icon-btn redo-btn" title="${esc(this._t("redo"))}" hidden>↷</button>
        ${admin ? `<button class="mode-btn"><span class="dot"></span><span class="mt">${this._modeLabel()}</span></button>` : ""}
      </div>
      <div class="laypop" hidden></div>
      <div class="tabs">${this._tabsHtml()}</div>
      <div class="toolbar"${this._unlocked ? "" : " hidden"}>${this._toolbarHtml()}</div>
      <div class="ctxbar" hidden></div>
      <div class="body">
        <aside class="guide" data-label="${esc(this._t("guide"))}">
          <button class="guide-toggle" title="${esc(this._t("help"))}">${this._guideOpen ? "⟨" : "?"}</button>
          <div class="guide-inner">${this._guideHtml()}</div>
        </aside>
        <div class="stage-wrap" style="aspect-ratio:${b.w} / ${b.h}; --ar:${(b.w / b.h).toFixed(4)}">
          <svg class="stage" viewBox="0 0 ${b.w * SCALE} ${b.h * SCALE}" preserveAspectRatio="xMidYMid meet">
            <defs>
              ${this._activeSensors().map((s, i) => `<radialGradient id="cov${i}" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stop-color="${s.color}" stop-opacity="0.42"/><stop offset="45%" stop-color="${s.color}" stop-opacity="0.2"/>
                <stop offset="100%" stop-color="${s.color}" stop-opacity="0.04"/></radialGradient>`).join("")}
              <mask id="roomMask" maskUnits="userSpaceOnUse" x="0" y="0" width="${b.w * SCALE}" height="${b.h * SCALE}">
                <rect x="0" y="0" width="${b.w * SCALE}" height="${b.h * SCALE}" fill="#fff"/>
                <path d="${this._pathD(this._roomPoly())}" fill="#5c5c5c"/>
              </mask>
              <radialGradient id="ghostGrad" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stop-color="#ff4d4d" stop-opacity="0.55"/><stop offset="55%" stop-color="#ff4d4d" stop-opacity="0.28"/>
                <stop offset="100%" stop-color="#ff4d4d" stop-opacity="0"/></radialGradient>
              <filter id="ghostBlur" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="9"/></filter>
              <clipPath id="roomClip"><path d="${this._pathD(this._roomPoly())}"/></clipPath>
              <pattern id="exHatch" patternUnits="userSpaceOnUse" width="16" height="16" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="16" stroke="${EXCL_COLOR}" stroke-width="3"/></pattern>
              ${this._fadeDefs(b)}
            </defs>
            <g id="room"></g>
            <g id="mbg" clip-path="url(#roomClip)"></g>
            <g mask="url(#fadeMX)"><g mask="url(#fadeMY)"><g id="coverage"></g><g id="ghosts"></g></g></g>
            <g id="overlap" clip-path="url(#roomClip)"></g>
            <g id="zones"></g>
            <g id="excl"></g>
            <g id="dims"></g>
            <g id="guides"></g>
            <g id="sensors"></g><g id="raw"></g><g id="persons"></g>
          </svg>
          <canvas class="fx"></canvas>
          <svg class="over" viewBox="0 0 ${b.w * SCALE} ${b.h * SCALE}" preserveAspectRatio="xMidYMid meet"><rect class="o-hit" x="0" y="0" width="${b.w * SCALE}" height="${b.h * SCALE}"/><path class="o-room" d="${this._pathD(this._roomPoly())}"/><g id="osens"></g><g id="ospots"></g></svg>
          <div class="dimedit" hidden></div>
          <div class="minfo" hidden></div>
          <div class="mlegend"></div>
        </div>
      </div>
      <div class="mpanel" hidden></div>
      <div class="panel" hidden></div>
      <div class="toast" hidden></div>
      <div class="pin-overlay" hidden>
        <div class="pin-box">
          <div class="pin-title">${esc(this._t("pin_title"))}</div>
          <div class="pin-sub"></div>
          <div class="pin-dots"><i></i><i></i><i></i><i></i></div>
          <div class="pin-pad">
            ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-k="${n}">${n}</button>`).join("")}
            <button data-k="del" class="aux">⌫</button><button data-k="0">0</button><button data-k="cancel" class="aux">✕</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  _modeLabel() { return this._t(({ view: "m_view", zones: "m_zones", sensors: "m_sensors", rooms: "m_rooms", "cal-sensor": "m_cal", "cal-room": "m_cal" })[this._mode] || "m_view"); }
  _tabsHtml() {
    const t = this._rooms.map((r) => `<button class="tab${r.id === this._activeRoom ? " active" : ""}" data-room="${esc(r.id)}">${esc(r.name)}<span class="tab-count" data-roomcount="${esc(r.id)}"></span></button>`).join("");
    const add = this._unlocked && this._mode === "rooms" ? `<button class="tab tab-add" data-addroom="1">${esc(this._t("add_room"))}</button>` : "";
    return t + add;
  }
  _toolbarHtml() {
    const seg = (m, l) => `<button class="seg${this._mode === m || (m === "cal" && this._mode.startsWith("cal")) ? " on" : ""}" data-mode="${m}">${l}</button>`;
    return `<div class="segs">${seg("view", this._t("m_view"))}${seg("zones", this._t("m_zones"))}${seg("sensors", this._t("m_sensors"))}${seg("rooms", this._t("m_rooms"))}${seg("cal", this._t("m_cal"))}</div>
      ${this._isAdmin() ? `<button class="link-btn" data-act="settings" title="${esc(this._t("settings_tip"))}">${esc(this._t("settings"))}</button>` : ""}`;
  }

  _renderCtx() {
    const bar = this._el.ctx;
    let h = "";
    if (this._unlocked) {
      if (this._mode === "zones") h = `<span class="dd"><button class="ctx accent" data-act="addzone">${esc(this._t("add_zone"))}</button><button class="ctx accent dd-btn" data-act="tplmenu" title="Templates">▾</button>
          <span class="dd-menu" hidden>${ZONE_TEMPLATES.map((tp) => `<button class="dd-item" data-tpl="${tp.k}">${esc(this._t("tpl_" + tp.k))} <small>${this._fmtNum(tp.w, 1)} × ${this._fmtNum(tp.h, 1)} m</small></button>`).join("")}</span></span>
          <button class="ctx ex-add" data-act="addexcl">${esc(this._t("add_excl"))}</button><span class="hint">${esc(this._t("hint_zones"))}</span>`;
      else if (this._mode === "sensors") h = `<span class="hint">${esc(this._t("hint_sensors"))}</span>`;
      else if (this._mode === "rooms") h = `<button class="ctx" data-act="renameroom">${esc(this._t("rename_room"))}</button>${this._rooms.length > 1 ? `<button class="ctx danger" data-act="delroom">${esc(this._t("delete_room"))}</button>` : ""}<span class="hint">${esc(this._t("hint_rooms"))}</span>`;
      else if (this._mode.startsWith("cal")) {
        const opts = this._activeSensors().map((s) => `<option value="${esc(s.id)}"${s.id === this._calSid ? " selected" : ""}>${esc(s.label + " · " + s.name)}</option>`).join("");
        h = `<div class="segs small"><button class="seg${this._mode === "cal-sensor" ? " on" : ""}" data-calmode="cal-sensor">${esc(this._t("cal_single"))}</button><button class="seg${this._mode === "cal-room" ? " on" : ""}" data-calmode="cal-room">${esc(this._t("cal_room"))}</button></div>
          ${this._mode === "cal-sensor" ? `<select class="ctx-sel" data-act="calpick">${opts}</select>` : ""}
          <button class="ctx accent" data-act="autocal">${esc(this._t("autocal"))}</button>
          <button class="ctx" data-act="${this._mode === "cal-sensor" ? "calreset" : "calresetroom"}">${esc(this._t(this._mode === "cal-sensor" ? "off0_one" : "off0_room"))}</button>
          <button class="ctx danger" data-act="calresetall">${esc(this._t("cal_all"))}</button>
          <button class="ctx" data-act="learn">${esc(this._t("learn_now"))}</button>
          <span class="hint">${esc(this._t(this._mode === "cal-sensor" ? "hint_cal_single" : "hint_cal_room"))}</span>`;
      }
    }
    bar.innerHTML = h;
    bar.hidden = !h;
  }

  _renderRoom() {
    const poly = this._roomPoly();
    let extra = "";
    if (this._mode === "rooms" && this._unlocked) {
      poly.forEach((a, i) => { extra += this._angBadge(poly, i); });
      poly.forEach((a, i) => {
        const bb = poly[(i + 1) % poly.length];
        extra += this._dimBadge(this._px((a[0] + bb[0]) / 2, (a[1] + bb[1]) / 2), dist(a, bb), i, true);
      });
      poly.forEach((p, i) => { const [x, y] = this._px(p[0], p[1]); extra += `<circle class="room-corner" cx="${x}" cy="${y}" r="10" data-rcorner="${i}"/>`; });
      const c = this._px(...centroid(poly));
      extra += `<g class="move-h" transform="translate(${c[0]} ${c[1]})" data-rmove="1"><circle r="15"/><path d="${this._moveIcon()}"/></g>`;
    }
    this._el.room.innerHTML = `<path class="room" d="${this._pathD(poly)}"/>${extra}`;
    this._el.cov.innerHTML = this._activeSensors().map((s, i) => {
      const d = this._conePath(this._basePos(s), this._baseRot(s), s);
      return `<path class="cov" d="${d}" fill="url(#cov${i})" mask="url(#roomMask)"/><path class="cov-edge" d="${d}" stroke="${s.color}"/>`;
    }).join("");
  }
  _dimBadge(m, len, i, interactive) {
    const txt = this._fmtNum(len) + " m", w = txt.length * 7.4 + 20;
    return `<g class="dim${interactive ? " dim-h" : ""}" transform="translate(${m[0]} ${m[1]})"${interactive ? ` data-redge="${i}"` : ""}><rect x="${-w / 2}" y="-13" width="${w}" height="26" rx="13"/><text y="4.5">${esc(txt)}</text></g>`;
  }
  _angBadge(poly, i) {
    const ci = cornerInfo(poly, i), p = vadd(poly[i], vmul(ci.bis, 0.34)), [x, y] = this._px(p[0], p[1]);
    const v = Math.abs(ci.deg - Math.round(ci.deg)) < 0.05 ? String(Math.round(ci.deg)) : this._fmtNum(ci.deg, 1);
    return `<g class="ang${Math.abs(ci.deg - 90) < 0.05 || Math.abs(ci.deg - 270) < 0.05 ? " right" : ""}" transform="translate(${x} ${y})" data-rang="${i}"><rect x="-21" y="-11" width="42" height="22" rx="11"/><text y="4">${v}°</text></g>`;
  }
  _renderDims() {
    if (!this._el || !this._el.dims) return;
    if (!this._lay("dims") || (this._mode === "rooms" && this._unlocked) || this._view === "model") { this._el.dims.innerHTML = ""; return; }
    const poly = this._roomPoly();
    this._el.dims.innerHTML = poly.map((a, i) => { const b = poly[(i + 1) % poly.length]; return this._dimBadge(this._px((a[0] + b[0]) / 2, (a[1] + b[1]) / 2), dist(a, b), i, false); }).join("");
  }
  _renderOverlap() {
    if (!this._el || !this._el.overlap) return;
    const list = this._activeSensors();
    if (!this._lay("overlap") || list.length < 2) { this._el.overlap.innerHTML = ""; return; }
    let h = "";
    list.forEach((s, j) => { h += `<clipPath id="ovc${j}"><path d="${this._conePath(this._effPos(s), this._effRot(s), s)}"/></clipPath>`; });
    list.forEach((s, i) => list.forEach((o, j) => {
      if (j <= i) return;
      h += `<path class="ovl" d="${this._conePath(this._effPos(s), this._effRot(s), s)}" clip-path="url(#ovc${j})"/>`;
    }));
    this._el.overlap.innerHTML = h;
  }
  _moveIcon() { return "M0 -8 L0 8 M-8 0 L8 0 M-8 0 l3 -3 M-8 0 l3 3 M8 0 l-3 -3 M8 0 l-3 3 M0 -8 l-3 3 M0 -8 l3 3 M0 8 l-3 -3 M0 8 l3 -3"; }

  _renderSensors() {
    const edit = this._mode === "sensors" && this._unlocked;
    this._el.sensors.innerHTML = this._activeSensors().map((s) => {
      const [cx, cy] = this._px(...this._basePos(s));
      let rot = "";
      if (edit) {
        const th = d2r(this._baseRot(s)), hx = cx - Math.sin(th) * 46, hy = cy + Math.cos(th) * 46;
        rot = `<line class="s-rotline" x1="${cx}" y1="${cy}" x2="${hx}" y2="${hy}"/><circle class="s-rot" cx="${hx}" cy="${hy}" r="9" data-srot="${esc(s.id)}"/>`;
      }
      return `<g class="sensor${edit ? " editable" : ""}${s.valid === false ? " invalid" : ""}" data-sensor="${esc(s.id)}">${rot}
        <circle class="s-ring" cx="${cx}" cy="${cy}" r="18" stroke="${s.color}"/>
        <circle class="s-core" cx="${cx}" cy="${cy}" r="11" fill="${s.color}" style="--sc:${s.color}" data-smove="${esc(s.id)}"/>
        <text x="${cx}" y="${cy - 24}" class="sensor-lbl" fill="${s.color}">${esc(s.label + " · " + s.name)}</text></g>`;
    }).join("");
  }

  _renderZones() {
    const mk = (z, cls, parent) => {
      const grp = document.createElementNS(NS, "g");
      grp.setAttribute("class", cls);
      grp.dataset.zone = z.id;
      grp.style.setProperty("--zc", cls === "excl" ? EXCL_COLOR : z.color);
      parent.appendChild(grp);
      this._renderZone(z, grp);
    };
    this._el.zones.innerHTML = "";
    this._zones.filter((z) => z.room === this._activeRoom).forEach((z) => mk(z, "zone", this._el.zones));
    this._el.excl.innerHTML = "";
    this._excls.filter((z) => z.room === this._activeRoom).forEach((z) => mk(z, "excl", this._el.excl));
  }
  _renderZone(z, grp) {
    grp = grp || this._el.svg.querySelector(`[data-zone="${CSS.escape(z.id)}"]`);
    if (!grp) return;
    const edit = this._mode === "zones" && this._unlocked;
    if (grp.classList.contains("excl")) return this._renderExcl(z, grp, edit);
    const [cx, cy] = this._px(...centroid(z.points));
    // Namensschild oben in der Zone, damit Personen (meist mittig) es nicht verdecken
    const ys = z.points.map((p) => p[1]);
    const topPx = this._px(0, Math.min(...ys))[1], hPx = (Math.max(...ys) - Math.min(...ys)) * SCALE;
    const ty = hPx >= 110 ? topPx + 30 : (edit ? cy - 26 : cy);
    // Schildbreite nach Namenslänge: Haken links, Text mittig, Zähler rechts
    const hw = Math.max(64, Math.min(150, String(z.name).length * 4.6 + 44));
    let h = `<path class="zone-fill" d="${this._pathD(z.points)}"/>
      <g class="zone-tag" transform="translate(${cx} ${ty})">
        <rect class="tag-bg" x="${-hw}" y="-17" width="${2 * hw}" height="34" rx="17"/>
        <path class="tag-check" d="M ${-hw + 13} 0 l 6 7 l 12 -14"/>
        <text class="tag-text" x="0" y="5">${esc(z.name)}</text>
        <g class="tag-count" transform="translate(${hw - 18} 0)"><circle r="11"/><text y="4" class="tag-count-t"></text></g>
        ${edit ? `<g class="tag-del" transform="translate(${hw + 16} 0)"><circle r="12"/><path d="M -5 -5 L 5 5 M 5 -5 L -5 5"/></g>` : ""}
      </g>`;
    if (edit) {
      z.points.forEach((a, i) => { const bb = z.points[(i + 1) % z.points.length], m = this._px((a[0] + bb[0]) / 2, (a[1] + bb[1]) / 2); h += `<circle class="edge-h" cx="${m[0]}" cy="${m[1]}" r="7" data-edge="${i}"/>`; });
      const extra = z.extra || [];
      z.points.forEach((p, i) => { const [x, y] = this._px(p[0], p[1]); h += `<circle class="corner-h${extra.includes(i) ? " extra" : ""}" cx="${x}" cy="${y}" r="${extra.includes(i) ? 9 : 10}" data-corner="${i}"/>`; });
      h += `<g class="move-h" transform="translate(${cx} ${cy})" data-move="1"><circle r="15"/><path d="${this._moveIcon()}"/></g>`;
    }
    grp.innerHTML = h;
    grp.classList.toggle("disabled", z.enabled === false);
    this._applyZoneLive(z.id, grp);
  }

  _renderExcl(z, grp, edit) {
    let h = `<path class="ex-fill" d="${this._pathD(z.points)}"/><path class="ex-hatch" d="${this._pathD(z.points)}" fill="url(#exHatch)"/>`;
    if (edit) {
      const [cx, cy] = this._px(...centroid(z.points));
      const ys = z.points.map((p) => p[1]), hPx = (Math.max(...ys) - Math.min(...ys)) * SCALE;
      const ty = hPx >= 90 ? this._px(0, Math.min(...ys))[1] + 24 : cy - 26;
      const label = "⛔ " + z.name, hw = Math.max(52, Math.min(140, String(label).length * 4.4 + 26));
      h += `<g class="zone-tag ex-tag" transform="translate(${cx} ${ty})"><rect class="tag-bg" x="${-hw}" y="-15" width="${2 * hw}" height="30" rx="15"/>
        <text class="tag-text" x="0" y="5">${esc(label)}</text>
        <g class="tag-del" transform="translate(${hw + 15} 0)"><circle r="12"/><path d="M -5 -5 L 5 5 M 5 -5 L -5 5"/></g></g>`;
      z.points.forEach((a, i) => { const bb = z.points[(i + 1) % z.points.length], m = this._px((a[0] + bb[0]) / 2, (a[1] + bb[1]) / 2); h += `<circle class="edge-h" cx="${m[0]}" cy="${m[1]}" r="7" data-edge="${i}"/>`; });
      z.points.forEach((p, i) => { const [x, y] = this._px(p[0], p[1]); h += `<circle class="corner-h" cx="${x}" cy="${y}" r="9" data-corner="${i}"/>`; });
      h += `<g class="move-h" transform="translate(${cx} ${cy})" data-move="1"><circle r="14"/><path d="${this._moveIcon()}"/></g>`;
    }
    grp.innerHTML = h;
    grp.classList.toggle("disabled", z.enabled === false);
  }

  _ghostList() {
    if (this._mode === "cal-sensor") { const s = this._sensor(this._calSid); return s && s.room === this._activeRoom ? [s] : []; }
    if (this._mode === "cal-room") return this._activeSensors();
    return [];
  }
  _renderGhosts() {
    if (!this._el) return;
    const list = this._ghostList();
    let h = list.map((s) => {
      const ep = this._effPos(s), bp = this._basePos(s), apex = this._px(...ep), real = this._px(...bp);
      let handles = "";
      if (this._mode === "cal-sensor") {
        const th = d2r(this._effRot(s)), hx = apex[0] - Math.sin(th) * 60, hy = apex[1] + Math.cos(th) * 60;
        handles = `<line class="ghost-rotline" x1="${apex[0]}" y1="${apex[1]}" x2="${hx}" y2="${hy}"/>
          <circle class="ghost-rot" cx="${hx}" cy="${hy}" r="11" data-grot="${esc(s.id)}"/>
          <g class="ghost-move" transform="translate(${apex[0]} ${apex[1]})" data-gmove="${esc(s.id)}"><circle r="15"/><path d="M0 -8 L0 8 M-8 0 L8 0"/></g>`;
      }
      return `<g class="ghost"><line class="ghost-link" x1="${real[0]}" y1="${real[1]}" x2="${apex[0]}" y2="${apex[1]}"/>
        <path class="ghost-cone" d="${this._conePath(ep, this._effRot(s), s)}" fill="url(#ghostGrad)" filter="url(#ghostBlur)"/>${handles}</g>`;
    }).join("");
    if (this._mode === "cal-room" && list.length) {
      const [cx, cy] = this._px(...centroid(list.map((s) => this._effPos(s))));
      h += `<g class="ghost-move" transform="translate(${cx} ${cy})" data-gmoveroom="1"><circle r="17"/><path d="${this._moveIcon()}"/></g>`;
    }
    this._el.ghosts.innerHTML = h;
  }

  /* ----- Live-Daten ----- */
  _applyZoneLive(zid, grp) {
    const zs = this._live && this._live.zones ? this._live.zones[zid] : null;
    grp.classList.toggle("occupied", !!(zs && zs.on));
    const t = grp.querySelector(".tag-count-t");
    const c = zs ? zs.count : 0;
    if (t) t.textContent = c > 0 ? String(c) : "";
    const cg = grp.querySelector(".tag-count");
    if (cg) cg.classList.toggle("has", c > 0);
  }

  _renderLive() {
    if (!this._el || !this._live) return;
    const live = this._live;
    // Zonen
    this._el.zones.querySelectorAll(".zone").forEach((grp) => this._applyZoneLive(grp.dataset.zone, grp));
    // Raum-Zähler in Tabs
    this._el.tabs.querySelectorAll("[data-roomcount]").forEach((el) => {
      const n = (live.rooms || {})[el.dataset.roomcount] || 0;
      el.textContent = n ? String(n) : "";
    });
    // Status-Chip Lernkalibrierung
    const cal = live.cal || {};
    const chip = this._el.chip;
    if (cal.status === "running") { chip.hidden = false; chip.textContent = this._t("learning", { p: Math.round((cal.progress || 0) * 100) }); }
    else if (cal.status === "scheduled" && cal.next) { chip.hidden = false; chip.textContent = this._t("scheduled", { t: this._timeFmt(cal.next) }); }
    else chip.hidden = true;
    // Personen
    const seen = new Set();
    for (const p of live.persons || []) {
      if (p.room !== this._activeRoom) continue;
      seen.add(p.k);
      const merged = (p.sensors || []).length > 1;
      const s0 = this._sensor((p.sensors || [])[0]);
      const color = merged ? this._config.merge_color : (s0 ? s0.color : "#2dd4bf");
      const [x, y] = this._px(p.x, p.y);
      let el = this._personEls.get(p.k);
      if (!el) {
        el = document.createElementNS(NS, "g");
        el.setAttribute("class", "person");
        el.style.setProperty("--g", color);
        const lbl = merged
          ? `<text class="p-lbl small" y="-3">${esc(p.labels[0])}</text><text class="p-lbl small" y="9">${esc(p.labels[1] || "")}</text>`
          : `<text class="p-lbl" y="4">${esc(p.labels[0])}</text>`;
        // Nur wirklich neue Personen federn auf – nicht nach jedem Neuaufbau der Karte
        const fresh = !this._known.has(p.k);
        el.innerHTML = `<g class="${fresh ? "pop" : ""}"><circle class="p-halo" r="26" fill="${color}"/><circle class="p-still" r="25" stroke="${color}"/><circle class="p-core" r="18" fill="${color}"/>${lbl}</g>`;
        el.style.transform = `translate(${x}px, ${y}px)`;
        this._el.persons.appendChild(el);
        this._personEls.set(p.k, el);
      } else {
        el.style.transform = `translate(${x}px, ${y}px)`;
      }
      el.classList.toggle("still", !!p.still);
    }
    for (const [k, el] of this._personEls) if (!seen.has(k)) { el.remove(); this._personEls.delete(k); }
    this._known = seen;
    if (this._fx && this._view === "model") this._fx.setTargets((live.targets || []).filter((t) => { const s = this._sensor(t.s); return s && s.room === this._activeRoom; }));
    // Rohdaten / verworfene Geister
    if (this._lay("raw") || this._lay("rejected")) {
      const room = this._activeRoom;
      const sens = new Set(this._activeSensors().map((s) => s.id));
      let h = "";
      for (const c of live.candidates || []) {
        if (!sens.has(c.s)) continue;
        const s = this._sensor(c.s), [x, y] = this._px(c.x, c.y);
        h += `<g class="cand" transform="translate(${x} ${y})"><circle r="14" stroke="${s ? s.color : "#999"}"/><text y="30">${esc(c.label)} ${Math.round(c.conf * 100)}%</text></g>`;
      }
      for (const r of live.rejected || []) {
        if (!sens.has(r.s)) continue;
        const [x, y] = this._px(r.x, r.y);
        h += `<g class="rej${r.r === "excl" ? " ex" : ""}" transform="translate(${x} ${y})"><path d="M-7 -7 L7 7 M7 -7 L-7 7"/></g>`;
      }
      this._el.raw.innerHTML = h;
      void room;
    } else this._el.raw.innerHTML = "";
  }

  /* ===================================================== Interaktion */
  _wire() {
    const e = this._el;
    if (e.mode) e.mode.addEventListener("click", () => {
      if (!this._unlocked) this._requestUnlock(() => this._setMode("zones"));
      else this._setMode(this._mode === "view" ? "zones" : "view");
    });
    e.undo.addEventListener("click", () => this._undoAct());
    e.redo.addEventListener("click", () => this._redoAct());
    this.shadowRoot.querySelector(".raw-btn").addEventListener("click", () => {
      const on = !this._lay("raw"), set = new Set(this._layers);
      for (const k of ["raw", "rejected"]) { if (on) set.add(k); else set.delete(k); }
      try { localStorage.setItem("zp_show_raw", on ? "1" : "0"); } catch (x) {}
      this._setLayers(set);
    });
    this.shadowRoot.querySelector(".lay-btn").addEventListener("click", (ev) => { ev.stopPropagation(); this._toggleLayPop(); });
    this.shadowRoot.querySelector(".vseg").addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-view]"); if (!b || b.dataset.view === this._view) return;
      this._setView(b.dataset.view);
    });
    e.laypop.addEventListener("click", (ev) => this._onLayPop(ev));
    e.excl.addEventListener("click", (ev) => this._zoneClick(ev));
    e.over.addEventListener("click", (ev) => this._modelClick(ev));
    e.mpanel.addEventListener("click", (ev) => this._onMPanel(ev));
    e.mpanel.addEventListener("input", (ev) => this._onMPanel(ev));
    e.mpanel.addEventListener("change", (ev) => this._onMPanel(ev));
    e.mlegend.addEventListener("click", (ev) => this._onMPanel(ev));
    e.minfo.addEventListener("click", (ev) => this._onMInfo(ev));
    const toggleGuide = () => {
      this._guideOpen = !this._guideOpen;
      e.root.classList.toggle("guide-collapsed", !this._guideOpen);
      this.shadowRoot.querySelector(".guide-toggle").textContent = this._guideOpen ? "⟨" : "?";
    };
    this.shadowRoot.querySelector(".guide-toggle").addEventListener("click", toggleGuide);
    e.tabs.addEventListener("click", (ev) => {
      if (ev.target.closest("[data-addroom]")) return this._addRoom();
      const t = ev.target.closest("[data-room]");
      if (t && t.dataset.room !== this._activeRoom) {
        this._activeRoom = t.dataset.room;
        if (this._mode === "cal-sensor") this._calSid = (this._activeSensors()[0] || {}).id || null;
        this._built = false; this._render();
      }
    });
    e.toolbar.addEventListener("click", (ev) => {
      if (ev.target.closest("[data-act='settings']")) return this._openSettings();
      const b = ev.target.closest("[data-mode]");
      if (!b) return;
      const m = b.dataset.mode;
      if (m === "cal") { this._calSid = this._calSid && this._activeSensors().find((s) => s.id === this._calSid) ? this._calSid : (this._activeSensors()[0] || {}).id || null; this._setMode(this._calSid ? "cal-sensor" : "cal-room"); }
      else this._setMode(m);
    });
    e.ctx.addEventListener("click", (ev) => this._onCtx(ev));
    e.ctx.addEventListener("change", (ev) => this._onCtx(ev));
    e.svg.addEventListener("pointerdown", (ev) => this._down(ev));
    e.svg.addEventListener("pointermove", (ev) => this._move(ev));
    e.svg.addEventListener("pointerup", (ev) => this._up(ev));
    e.svg.addEventListener("pointercancel", () => { this._drag = null; this._endKeys(); });
    e.zones.addEventListener("click", (ev) => this._zoneClick(ev));
    e.pin.querySelectorAll(".pin-pad button").forEach((btn) => btn.addEventListener("click", () => this._onPin(btn.dataset.k)));
  }

  _setMode(m) {
    this._mode = m;
    if (m !== "view") this._view = "plan";
    this._built = false;
    this._render();
  }
  _setView(v) {
    this._view = v;
    if (v === "model" && this._mode !== "view") this._mode = "view";
    this._built = false;
    this._render();
  }

  /* ----- Sichtbarkeits-Menü ----- */
  _toggleLayPop(force) {
    const p = this._el.laypop, open = force != null ? force : p.hidden;
    p.hidden = !open;
    if (open) {
      this._renderLayPop();
      this._layClose = (ev) => { if (!ev.composedPath().includes(p) && !ev.composedPath().some((n) => n.classList && n.classList.contains("lay-btn"))) this._toggleLayPop(false); };
      setTimeout(() => window.addEventListener("pointerdown", this._layClose), 0);
    } else if (this._layClose) { window.removeEventListener("pointerdown", this._layClose); this._layClose = null; }
  }
  _renderLayPop() {
    const p = this._el && this._el.laypop; if (!p || p.hidden) return;
    const same = (a, b) => a.length === b.size && a.every((k) => b.has(k));
    p.innerHTML = `<div class="lp-head">${esc(this._t("presets"))}</div>
      <div class="lp-presets">${Object.keys(PRESETS).map((k) => `<button class="lp-preset${same(PRESETS[k], this._layers) ? " on" : ""}" data-preset="${k}">${esc(this._t("preset_" + k))}</button>`).join("")}</div>
      <div class="lp-head">${esc(this._t("layers_btn"))}</div>
      ${LAYERS.map((k) => `<label class="lp-row"><input type="checkbox" data-layer="${k}"${this._lay(k) ? " checked" : ""}><span>${esc(this._t("lay_" + k))}</span></label>`).join("")}`;
  }
  _onLayPop(ev) {
    const pr = ev.target.closest("[data-preset]");
    if (pr) return this._setLayers(PRESETS[pr.dataset.preset]);
    const cb = ev.target.closest("[data-layer]");
    if (cb) { const set = new Set(this._layers); if (cb.checked) set.add(cb.dataset.layer); else set.delete(cb.dataset.layer); this._setLayers(set); }
  }

  _onCtx(ev) {
    const tpl = ev.target.closest("[data-tpl]");
    if (tpl && ev.type === "click") { tpl.closest(".dd-menu").hidden = true; return this._addZone(ZONE_TEMPLATES.find((x) => x.k === tpl.dataset.tpl)); }
    const cm = ev.target.closest("[data-calmode]");
    if (cm && ev.type === "click") { if (cm.dataset.calmode === "cal-sensor" && !this._calSid) this._calSid = (this._activeSensors()[0] || {}).id || null; return this._setMode(cm.dataset.calmode); }
    const el = ev.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act;
    // Auswahlfeld nur beim Wechsel – ein Neuaufbau beim Klick würde das native Menü schließen
    if (act === "calpick") { if (ev.type !== "change") return; this._calSid = el.value; this._renderGhosts(); return; }
    if (ev.type !== "click") return;
    if (act === "addzone") this._addZone();
    else if (act === "tplmenu") { const m = this._el.ctx.querySelector(".dd-menu"); if (m) m.hidden = !m.hidden; }
    else if (act === "addexcl") this._addExcl();
    else if (act === "renameroom") this._renameRoom();
    else if (act === "delroom") this._deleteRoom();
    else if (act === "autocal") this._autoCal();
    else if (act === "calreset") this._resetOffsets([this._calSid], this._t("off_reset"));
    else if (act === "calresetroom") this._resetOffsets(this._activeSensors().map((s) => s.id), this._t("off_reset_room"));
    else if (act === "calresetall") { if (confirm(this._t("cal_all_q"))) this._resetOffsets(this._sensors.map((s) => s.id), this._t("cal_all_done")); }
    else if (act === "learn") this._startLearning();
  }

  _svgPt(ev) {
    const pt = this._el.svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
    const p = pt.matrixTransform(this._el.svg.getScreenCTM().inverse());
    return [p.x, p.y];
  }

  _down(ev) {
    if (!this._unlocked) return;
    const [sx, sy] = this._svgPt(ev);
    const start = this._toRoom(sx, sy);
    const base = { start, startSvg: [sx, sy], moved: 0 };
    const t = ev.target.closest("[data-corner],[data-edge],[data-move],[data-rcorner],[data-redge],[data-rang],[data-rmove],[data-smove],[data-srot],[data-gmove],[data-grot],[data-gmoveroom]");
    if (!t) return;
    this._closeDimEdit();
    let d = null;
    const edgeDrag = (kind, owner, pts, i) => {
      const n = pts.length, j = (i + 1) % n;
      return { kind, i, j, p0: pts[i].slice(), p1: pts[j].slice(), ph: pts[(i - 1 + n) % n].slice(), pk: pts[(j + 1) % n].slice(), orig: clone(pts), ...owner };
    };
    if (this._mode === "zones" && t.closest(".zone,.excl")) {
      const z = this._zoneObj(t.closest(".zone,.excl").dataset.zone);
      if (!z) return;
      if (t.dataset.corner != null) d = { kind: "zcorner", z, idx: +t.dataset.corner, orig: z.points[+t.dataset.corner].slice() };
      else if (t.dataset.edge != null) d = edgeDrag("zedge", { z }, z.points, +t.dataset.edge);
      else if (t.dataset.move != null) d = { kind: "zmove", z, orig: clone(z.points) };
    } else if (this._mode === "rooms") {
      const room = this._room();
      if (t.dataset.rcorner != null) d = { kind: "rcorner", room, idx: +t.dataset.rcorner, orig: room.polygon[+t.dataset.rcorner].slice() };
      else if (t.dataset.redge != null) d = edgeDrag("redge", { room }, room.polygon, +t.dataset.redge);
      else if (t.dataset.rang != null) d = { kind: "rang", room, idx: +t.dataset.rang };
      else if (t.dataset.rmove != null) d = { kind: "rmove", room, orig: clone(room.polygon) };
    } else if (this._mode === "sensors") {
      const s = this._sensor(t.dataset.smove || t.dataset.srot);
      if (!s) return;
      d = t.dataset.srot != null ? { kind: "srot", s } : { kind: "smove", s, orig: this._basePos(s) };
    } else if (this._mode === "cal-sensor") {
      const s = this._sensor(t.dataset.gmove || t.dataset.grot);
      if (!s) return;
      d = t.dataset.grot != null ? { kind: "grot", s } : { kind: "gmove", s, orig: Object.assign({}, this._off(s)) };
    } else if (this._mode === "cal-room" && t.dataset.gmoveroom != null) {
      const orig = {}; this._activeSensors().forEach((s) => { orig[s.id] = Object.assign({}, this._off(s)); });
      d = { kind: "groom", orig };
    }
    if (!d) return;
    try { this._el.svg.setPointerCapture(ev.pointerId); } catch (x) {}
    this._pushUndo();
    this._drag = Object.assign(base, d);
    // Shift drücken/loslassen ohne Mausbewegung -> Einrasten sofort neu bewerten
    this._keyH = (e) => {
      if (e.key !== "Shift" || !this._drag || !this._lastMove) return;
      this._move(Object.assign({}, this._lastMove, { shiftKey: e.type === "keydown", preventDefault() {} }));
    };
    window.addEventListener("keydown", this._keyH);
    window.addEventListener("keyup", this._keyH);
    ev.preventDefault();
  }
  _endKeys() {
    if (this._keyH) { window.removeEventListener("keydown", this._keyH); window.removeEventListener("keyup", this._keyH); this._keyH = null; }
    this._lastMove = null;
    this._showGuides(null);
  }

  _move(ev) {
    const d = this._drag;
    if (!d) return;
    this._lastMove = { clientX: ev.clientX, clientY: ev.clientY, pointerType: ev.pointerType, shiftKey: ev.shiftKey };
    const [sx, sy] = this._svgPt(ev);
    const cur = this._toRoom(sx, sy);
    const dx = cur[0] - d.start[0], dy = cur[1] - d.start[1];
    d.moved = Math.max(d.moved, Math.hypot(sx - d.startSvg[0], sy - d.startSvg[1]));
    if (d.moved < TAP_PX) return;
    const r3 = (p) => [round(p[0]), round(p[1])];
    // Einrasten: immer bei Touch/Stift, bei der Maus außer mit gedrückter Shift-Taste
    const snap = !(ev.shiftKey && ev.pointerType === "mouse");
    d._delta = [dx, dy];
    const res = (r) => { d.snapKey = r ? r.key : ""; this._showGuides(r ? r.guides : null); return r; };
    switch (d.kind) {
      case "zcorner": {
        let p = [d.orig[0] + dx, d.orig[1] + dy];
        const r = snap ? res(snapPoint(p, this._snapCtx(d.z.points, [d.idx], "zone", d))) : res(null);
        if (r) p = r.q;
        d.z.points[d.idx] = r3(p); this._renderZone(d.z); break;
      }
      case "zedge": { this._pushPull(d, d.z.points, "zone", [dx, dy], snap, res); this._renderZone(d.z); break; }
      case "zmove": {
        let t = [dx, dy];
        if (snap) {
          const ctx = this._snapCtx(d.orig, d.orig.map((_, i) => i), "zone", d);
          const r = res(snapTranslate(d.orig.map((p) => ({ v: vadd(p, t) })), ctx));
          if (r) t = vadd(t, r.t);
        } else res(null);
        d.z.points = d.orig.map((p) => r3(vadd(p, t))); this._renderZone(d.z); break;
      }
      case "rcorner": {
        let p = [d.orig[0] + dx, d.orig[1] + dy];
        if (snap) {
          const r = res(snapPoint(p, this._snapCtx(d.room.polygon, [d.idx], "room", d)));
          if (!r) p = [gridR(p[0]), gridR(p[1])];
          else if (r.line && isAxis(r.line.d)) p = Math.abs(r.line.d[0]) < 1e-6 ? [r.q[0], gridR(r.q[1])] : [gridR(r.q[0]), r.q[1]];
          else p = r.q;
        } else res(null);
        d.room.polygon[d.idx] = r3(p); this._renderRoom(); break;
      }
      case "redge": { this._pushPull(d, d.room.polygon, "room", [dx, dy], snap, res); this._renderRoom(); break; }
      case "rang": break;
      case "rmove": d.room.polygon = d.orig.map((p) => r3([p[0] + dx, p[1] + dy])); this._renderRoom(); break;
      case "smove": d.s.pos = r3([d.orig[0] + dx, d.orig[1] + dy]); this._renderSensors(); this._renderRoom(); this._applyLive({ sensors: { [d.s.id]: { pos: d.s.pos } } }); break;
      case "srot": { const bp = this._basePos(d.s); d.s.rot = Math.round(r2d(Math.atan2(-(cur[0] - bp[0]), cur[1] - bp[1]))); this._renderSensors(); this._renderRoom(); this._applyLive({ sensors: { [d.s.id]: { rot: d.s.rot } } }); break; }
      case "gmove": d.s.offset = Object.assign({}, this._off(d.s), { dx: round(d.orig.dx + dx, 4), dy: round(d.orig.dy + dy, 4) }); this._renderGhosts(); this._applyLive({ sensors: { [d.s.id]: { offset: d.s.offset } } }); break;
      case "grot": { const ep = this._effPos(d.s); const ang = r2d(Math.atan2(-(cur[0] - ep[0]), cur[1] - ep[1])); d.s.offset = Object.assign({}, this._off(d.s), { dr: Math.round(ang - this._baseRot(d.s)) }); this._renderGhosts(); this._applyLive({ sensors: { [d.s.id]: { offset: d.s.offset } } }); break; }
      case "groom": {
        const patch = {};
        this._activeSensors().forEach((s) => { const o = d.orig[s.id]; s.offset = Object.assign({}, o, { dx: round(o.dx + dx, 4), dy: round(o.dy + dy, 4) }); patch[s.id] = { offset: s.offset }; });
        this._renderGhosts(); this._applyLive({ sensors: patch }); break;
      }
    }
    ev.preventDefault();
  }

  _up(ev) {
    const d = this._drag;
    if (!d) return;
    this._drag = null;
    this._endKeys();
    try { this._el.svg.releasePointerCapture(ev.pointerId); } catch (x) {}
    const tap = d.moved < TAP_PX;
    if (tap && d.kind === "zmove") { this._toggleExtra(d.z); return this._afterDrag(); }
    if (tap && d.kind === "redge") { this._popNoop(); this._afterDrag(); return this._editLength(d.i); }
    if (tap && d.kind === "rang") { this._popNoop(); this._afterDrag(); return this._editAngle(d.idx); }
    if (tap && d.kind === "rmove") { this._addRoomPoint(d.room); return this._afterDrag(); }
    if (tap) {
      this._popNoop();
      this._afterDrag();
      // Pointer-Capture leitet den Klick auf das SVG um -> Panel direkt hier öffnen
      if (d.kind === "smove") this._openSensorPanel(this._sensor(d.s.id) || d.s);
      return;
    }
    this._flushLive();
    if (d.kind[0] === "z") this._applyZones();
    else if (d.kind[0] === "r") this._apply({ rooms: this._rooms });
    else this._apply({ sensors: this._geometry() });
    this._afterDrag();
  }
  _afterDrag() { if (this._pendingRebuild) { this._pendingRebuild = false; this._built = false; this._render(); } }

  /* ----- Einrasten: Kontext ----- */
  // pts: Polygon des gezogenen Objekts, moving: Indizes, die sich bewegen
  _snapCtx(pts, moving, kind, d) {
    const ppm = this._ppm(), mv = new Set(moving), n = pts.length;
    const fixedEdges = polyEdges(pts).filter((e, i) => !mv.has(i) && !mv.has((i + 1) % n));
    const ctx = { pts: [], lines: [], tolP: SNAP_PX.pt / ppm, tolL: SNAP_PX.line / ppm, prev: d.snapKey || "" };
    if (kind === "zone") {
      const room = this._roomPoly();
      const others = this._zones.concat(this._excls).filter((o) => o.room === this._activeRoom && o !== d.z);
      ctx.pts = room.concat(...others.map((o) => o.points));
      ctx.lines = segLines(polyEdges(room), "w").concat(...others.map((o, k) => segLines(polyEdges(o.points), `z${k}e`)));
      ctx.dirs = dirSet(polyEdges(room).concat(fixedEdges), [[1, 0]]);
    } else {
      ctx.dirs = dirSet(fixedEdges, [[1, 0]]);
      // Ausrichten an allen anderen Ecken des Raums (waagrecht/senkrecht)
      pts.forEach((q, i) => { if (!mv.has(i)) ctx.lines.push({ a: q, d: [1, 0], key: `vx${i}` }, { a: q, d: [0, 1], key: `vy${i}` }); });
    }
    // Ecke ziehen: Parallelen/rechte Winkel ausgehend von den festen Nachbarecken
    if (moving.length === 1) {
      const i = moving[0], a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
      ctx.lines = ctx.lines.concat(anchorLines(a, ctx.dirs, "na"), anchorLines(b, ctx.dirs, "nb"));
    }
    return ctx;
  }
  /* Kante ziehen: parallel verschieben, die Nachbarkanten behalten ihre Richtung
     (Rechteck bleibt Rechteck, schräge Nachbarn gleiten mit). Einrasten an parallelen
     Wänden/Kanten und Fluchtlinien von Ecken; Räume zusätzlich im 5-cm-Raster.
     Shift (Maus) = frei verschieben wie bisher. */
  _pushPull(d, pts, kind, delta, snap, res) {
    const r3 = (p) => [round(p[0]), round(p[1])];
    if (!snap) { res(null); pts[d.i] = r3(vadd(d.p0, delta)); pts[d.j] = r3(vadd(d.p1, delta)); return; }
    const u = vunit(vsub(d.p1, d.p0)); if (!u) return;
    const nr = [-u[1], u[0]];
    let s = vdot(delta, nr);
    const r = this._snapOffset(d, kind, s, u, nr);
    if (r) s = r.s; else if (kind === "room") s = Math.round(s / GRID_M) * GRID_M;
    res(r);
    const a = vadd(d.p0, vmul(nr, s));
    const slide = (q, p) => { const dir = vunit(vsub(p, q)); const hit = dir && Math.abs(vcross(dir, u)) > 0.05 ? lineHit(a, u, q, dir) : null; return hit || vadd(p, vmul(nr, s)); };
    const ni = slide(d.ph, d.p0), nj = slide(d.pk, d.p1);
    if (dist(ni, nj) < 0.05 || vdot(vsub(nj, ni), u) <= 0) return;   // Kante würde umklappen
    pts[d.i] = r3(ni); pts[d.j] = r3(nj);
  }
  _snapOffset(d, kind, s, u, nr) {
    const tol = SNAP_PX.line / this._ppm(), prev = d.snapKey || "";
    const cands = [];
    const addLine = (a, key, guide, w = 1) => cands.push({ s: vdot(vsub(a, d.p0), nr), key, guide, w });
    let segs = [], pts = [];
    if (kind === "zone") {
      const room = this._roomPoly();
      const others = this._zones.concat(this._excls).filter((o) => o.room === this._activeRoom && o !== d.z);
      segs = polyEdges(room).map((e, k) => [e, "w" + k]).concat(...others.map((o, j) => polyEdges(o.points).map((e, k) => [e, `z${j}e${k}`])));
      pts = room.map((q, k) => [q, "rp" + k]).concat(...others.map((o, j) => o.points.map((q, k) => [q, `z${j}p${k}`])));
    } else {
      const poly = d.orig;
      segs = polyEdges(poly).map((e, k) => [e, "w" + k]).filter((x, k) => k !== d.i && k !== (d.i - 1 + poly.length) % poly.length && k !== d.j);
      pts = poly.map((q, k) => [q, "rp" + k]).filter((x, k) => k !== d.i && k !== d.j);
    }
    for (const [[a, b], key] of segs) {
      const dir = vunit(vsub(b, a));
      if (dir && Math.abs(vcross(dir, u)) < 0.03) addLine(a, key, { line: { a, d: u, seg: [a, b] } }, 0.8);
    }
    for (const [q, key] of pts) addLine(q, key, { line: { a: q, d: u } }, 1);
    let best = null;
    for (const c of cands) {
      const dd = Math.abs(c.s - s) * c.w, lim = c.key === prev ? tol * SNAP_KEEP : tol;
      if (dd <= lim && (!best || dd < best.dd)) best = { ...c, dd };
    }
    return best ? { s: best.s, key: best.key, guides: [best.guide] } : null;
  }
  _ppm() {
    try { const m = this._el.svg.getScreenCTM(); return Math.max(1e-3, Math.hypot(m.a, m.b) * SCALE); } catch (e) { return 80; }
  }
  _showGuides(guides) {
    const g = this._el && this._el.guides;
    if (!g) return;
    g.innerHTML = (guides || []).map((x) => {
      if (x.pt) { const [cx, cy] = this._px(...x.pt); return `<circle class="snap-pt" cx="${cx}" cy="${cy}" r="11"/>`; }
      const L = x.line, A = this._px(...vadd(L.a, vmul(L.d, -60))), B = this._px(...vadd(L.a, vmul(L.d, 60)));
      return `<line class="snap-line" x1="${A[0]}" y1="${A[1]}" x2="${B[0]}" y2="${B[1]}"/>`;
    }).join("");
  }

  /* ----- Zonen ----- */
  _edges(pts) { return pts.map((p, i) => { const q = pts[(i + 1) % pts.length]; return { i, len: dist(p, q), mid: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] }; }); }
  _insertAt(z, inserts) {
    inserts.sort((a, b) => b.edge - a.edge);
    for (const ins of inserts) z.points.splice(ins.edge + 1, 0, [round(ins.point[0]), round(ins.point[1])]);
    return inserts.map((ins) => z.points.findIndex((p) => p[0] === round(ins.point[0]) && p[1] === round(ins.point[1]))).filter((k) => k >= 0).sort((a, b) => a - b);
  }
  _toggleExtra(z) {
    const extra = z.extra || [];
    if (extra.length) {
      this._zoneExtra[z.id] = { ref: centroid(z.points), pts: extra.map((i) => z.points[i].slice()) };
      z.points = z.points.filter((_, i) => !extra.includes(i));
      z.extra = [];
    } else {
      const last = this._zoneExtra[z.id];
      const c = centroid(z.points);
      let inserts;
      if (last && dist(c, last.ref) <= EXTRA_RESTORE) {
        const dx = c[0] - last.ref[0], dy = c[1] - last.ref[1];
        inserts = last.pts.map((p) => { const q = [p[0] + dx, p[1] + dy]; const e = this._edges(z.points).sort((a, b) => dist(a.mid, q) - dist(b.mid, q))[0]; return { edge: e.i, point: q }; });
      } else {
        const edges = this._edges(z.points), max = Math.max(...edges.map((e) => e.len));
        const chosen = edges.every((e) => Math.abs(e.len - max) < 0.05)
          ? (() => { const byX = edges.slice().sort((a, b) => a.mid[0] - b.mid[0]); return [byX[0], byX[byX.length - 1]]; })()
          : edges.slice().sort((a, b) => b.len - a.len).slice(0, 2);
        inserts = chosen.map((e) => ({ edge: e.i, point: e.mid }));
      }
      z.extra = this._insertAt(z, inserts);
    }
    this._renderZone(z);
    this._applyZones();
  }
  _nextColor() {
    const pal = (this._cfg && this._cfg.zone_colors) || ZONE_COLORS, used = new Set(this._zones.map((z) => z.color));
    return pal.find((col) => !used.has(col) && col.toLowerCase() !== EXCL_COLOR) || pal[this._zones.length % pal.length];
  }
  _rectAt(w, h, c) {
    c = c || centroid(this._roomPoly());
    return [[c[0] - w / 2, c[1] - h / 2], [c[0] + w / 2, c[1] - h / 2], [c[0] + w / 2, c[1] + h / 2], [c[0] - w / 2, c[1] + h / 2]].map((p) => [round(p[0]), round(p[1])]);
  }
  _addZone(tpl) {
    this._pushUndo();
    tpl = tpl || ZONE_TEMPLATES[0];
    const z = {
      id: rid("z"), room: this._activeRoom, name: tpl.k === "square" ? this._t("new_zone") : this._t("tpl_" + tpl.k), enabled: true, extra: [], off_delay: null,
      color: this._nextColor(), points: this._rectAt(tpl.w, tpl.h),
    };
    this._cfg.zones = this._zones.concat([z]);
    this._renderZones();
    this._applyZones();
  }
  _addExcl(rect) {
    if (!this._unlocked) return this._requestUnlock(() => { this._setMode("zones"); this._addExcl(rect); });
    this._pushUndo();
    const pts = rect ? [[rect[0], rect[1]], [rect[2], rect[1]], [rect[2], rect[3]], [rect[0], rect[3]]].map((p) => [round(p[0]), round(p[1])]) : this._rectAt(0.8, 0.8);
    const z = { id: rid("x"), room: this._activeRoom, name: this._t("new_excl"), depth: 0.3, learn: false, enabled: true, points: pts };
    this._cfg.exclusions = this._excls.concat([z]);
    if (this._el) this._renderZones();
    this._applyZones();
    return z;
  }
  _duplicate(z) {
    this._pushUndo();
    const ex = this._isExcl(z);
    const c = Object.assign(clone(z), { id: rid(ex ? "x" : "z"), name: (z.name + this._t("copy_suffix")).slice(0, 40), points: z.points.map((p) => [round(p[0] + 0.3), round(p[1] + 0.3)]) });
    if (ex) this._cfg.exclusions = this._excls.concat([c]);
    else { delete c.num; c.color = this._nextColor(); this._cfg.zones = this._zones.concat([c]); }
    this._renderZones();
    this._applyZones();
    this._toast(this._t("duplicated"));
  }
  _deleteZone(z) {
    const ex = this._isExcl(z);
    if (!confirm(this._t(ex ? "del_excl_q" : "del_zone_q", { n: z.name }))) return;
    this._pushUndo();
    if (ex) this._cfg.exclusions = this._excls.filter((x) => x.id !== z.id);
    else this._cfg.zones = this._zones.filter((x) => x.id !== z.id);
    this._renderZones();
    this._applyZones();
  }
  _zoneClick(ev) {
    if (this._mode !== "zones" || !this._unlocked) return;
    const grp = ev.target.closest(".zone,.excl"); if (!grp) return;
    const z = this._zoneObj(grp.dataset.zone); if (!z) return;
    if (ev.target.closest(".tag-del")) return this._deleteZone(z);
    if (ev.target.closest(".tag-text,.tag-bg")) { if (this._isExcl(z)) this._openExclPanel(z); else this._openZonePanel(z); }
  }
  _openExclPanel(z) {
    this._panel(`${esc(this._t("excl_title"))} · ${esc(z.name)}`, `
      <div class="p-grid">
        ${this._field(this._t("name"), "name", z.name)}
        ${this._field(this._t("excl_depth"), "depth", z.depth ?? 0.3, "number")}
        <label class="p-row p-check"><input type="checkbox" data-p="learn"${z.learn ? " checked" : ""}><span>${esc(this._t("excl_learn"))}</span></label>
        <label class="p-row p-check"><input type="checkbox" data-p="enabled"${z.enabled === false ? "" : " checked"}><span>${esc(this._t("excl_active"))}</span></label>
      </div>
      <div class="p-note">${esc(this._t("excl_note"))}</div>`,
    (get) => {
      this._pushUndo();
      z.name = (get("name") || z.name).slice(0, 40);
      const dv = this._parseNum(get("depth"));
      z.depth = isFinite(dv) ? Math.min(3, Math.max(0, dv)) : (z.depth ?? 0.3);
      z.learn = this._el.panel.querySelector('[data-p="learn"]').checked;
      z.enabled = this._el.panel.querySelector('[data-p="enabled"]').checked;
      this._renderZone(z);
      this._applyZones();
    }, [{ label: this._t("duplicate"), fn: () => this._duplicate(z) }]);
  }
  _openZonePanel(z) {
    const s = (this._cfg && this._cfg.settings) || {};
    this._panel(`Zone ${z.num ? z.num : ""} · ${esc(z.name)}`, `
      <div class="p-grid">
        ${this._field(this._t("name"), "name", z.name)}
        ${this._field(this._t("color"), "color", z.color, "color")}
        ${this._field(this._t("off_delay", { d: s.off_delay ?? 10 }), "off_delay", z.off_delay ?? "", "number")}
        <label class="p-row p-check"><input type="checkbox" data-p="enabled"${z.enabled === false ? "" : " checked"}><span>${esc(this._t("zone_active"))}</span></label>
      </div>
      <div class="p-note">${esc(this._t("zone_note", { n: z.name, k: z.num || "?" }))}</div>`,
    (get) => {
      this._pushUndo();
      z.name = (get("name") || z.name).slice(0, 40);
      z.color = get("color") || z.color;
      const od = get("off_delay");
      z.off_delay = od === "" ? null : Math.max(0, Number(od) || 0);
      z.enabled = this._el.panel.querySelector('[data-p="enabled"]').checked;
      this._renderZone(z);
      this._applyZones();
    }, [{ label: this._t("duplicate"), fn: () => this._duplicate(z) }]);
  }

  /* ----- Räume ----- */
  _addRoom() {
    this._pushUndo();
    const room = { id: rid("r"), name: this._t("room_n", { n: this._rooms.length + 1 }), polygon: [[0, 0], [4, 0], [4, 3], [0, 3]] };
    this._cfg.rooms = this._rooms.concat([room]);
    this._activeRoom = room.id;
    this._apply({ rooms: this._rooms });
    this._built = false; this._render();
  }
  _renameRoom() {
    const r = this._room(); if (!r) return;
    const name = prompt(this._t("room_name_q"), r.name);
    if (name == null || !name.trim()) return;
    this._pushUndo();
    r.name = name.trim().slice(0, 40);
    this._apply({ rooms: this._rooms });
    this._el.tabs.innerHTML = this._tabsHtml();
    this._renderLive();
  }
  _deleteRoom() {
    const r = this._room();
    if (!r || this._rooms.length <= 1) return;
    const nz = this._zones.filter((z) => z.room === r.id).length;
    if (!confirm(this._t("del_room_q", { n: r.name }) + (nz ? this._t("del_room_zones", { k: nz }) : ""))) return;
    this._pushUndo();
    this._cfg.rooms = this._rooms.filter((x) => x.id !== r.id);
    this._cfg.zones = this._zones.filter((z) => z.room !== r.id);
    this._activeRoom = this._rooms[0].id;
    this._apply({ rooms: this._rooms, zones: this._zones });
    this._built = false; this._render();
  }
  /* ----- Bemaßung: Länge/Winkel eintippen ----- */
  // Mitte der Kante bleibt, die Kante wächst/schrumpft nach beiden Seiten. Mit "Winkel
  // beibehalten" wandern die Nachbarwände parallel mit (Rechteck bleibt Rechteck).
  _setEdgeLength(poly, i, L, keep) {
    const n = poly.length, j = (i + 1) % n, a = poly[i], b = poly[j], len = dist(a, b);
    if (len < 1e-6) return false;
    const u = vmul(vsub(b, a), 1 / len), m = vmul(vadd(a, b), 0.5);
    const na = vsub(m, vmul(u, L / 2)), nb = vadd(m, vmul(u, L / 2));
    const out = poly.map((p) => p.slice());
    out[i] = na; out[j] = nb;
    if (keep && n >= 4) {
      const h = (i - 1 + n) % n, k = (j + 1) % n, g = (h - 1 + n) % n, l = (k + 1) % n;
      const da = vsub(na, a), db = vsub(nb, b);
      const shift = (q, far, delta, farDir) => {   // Nachbarwand (q-…) um delta verschieben, Endpunkt q gleitet auf seiner anderen Wand
        const dir = vunit(vsub(q === poly[h] ? a : b, q)), od = vunit(farDir);
        if (!dir || !od || Math.abs(vcross(dir, od)) < 0.05) return vadd(q, delta);
        return lineHit(vadd(q, delta), dir, q, od) || vadd(q, delta);
      };
      out[h] = shift(poly[h], poly[g], da, vsub(poly[h], poly[g]));
      out[k] = shift(poly[k], poly[l], db, vsub(poly[l], poly[k]));
    }
    for (let q = 0; q < n; q++) poly[q] = [round(out[q][0]), round(out[q][1])];
    return true;
  }
  _setCornerAngle(poly, i, deg) {
    const n = poly.length, j = (i + 1) % n, ci = cornerInfo(poly, i);
    const sgn = Math.sign(vcross(ci.ua, ci.ub)) || 1;
    const dir = ci.deg <= 180 ? sgn : -sgn;
    const nd = rot2(ci.ua, dir * deg), len = dist(poly[i], poly[j]);
    poly[j] = [round(poly[i][0] + nd[0] * len), round(poly[i][1] + nd[1] * len)];
  }
  _editLength(i) {
    const room = this._room(); if (!room) return;
    const n = room.polygon.length; i = ((i % n) + n) % n;
    const a = room.polygon[i], b = room.polygon[(i + 1) % n];
    this._dimEditor({
      title: this._t("len_title"), value: this._fmtNum(dist(a, b)), keep: this._keepAngles !== false,
      anchor: this._el.svg.querySelector(`[data-redge="${i}"]`),
      ok: (v, keep) => {
        if (!(v >= 0.05 && v <= 50)) { this._toast(this._t("invalid_len")); return false; }
        this._keepAngles = keep;
        this._pushUndo();
        this._setEdgeLength(room.polygon, i, v, keep);
        this._renderRoom(); this._renderDims();
        this._apply({ rooms: this._rooms });
        return true;
      },
      tab: (dir) => this._editLength(i + dir),
    });
  }
  _editAngle(i) {
    const room = this._room(); if (!room) return;
    const ci = cornerInfo(room.polygon, i);
    this._dimEditor({
      title: this._t("angle_title"), value: this._fmtNum(ci.deg, Math.abs(ci.deg - Math.round(ci.deg)) < 0.05 ? 0 : 1),
      anchor: this._el.svg.querySelector(`[data-rang="${i}"]`),
      ok: (v) => {
        if (!(v > 1 && v < 359)) { this._toast(this._t("invalid_len")); return false; }
        this._pushUndo();
        this._setCornerAngle(room.polygon, i, v);
        this._renderRoom(); this._renderDims();
        this._apply({ rooms: this._rooms });
        return true;
      },
      tab: (dir) => this._editAngle((i + dir + room.polygon.length) % room.polygon.length),
    });
  }
  _dimEditor(o) {
    const box = this._el.dimedit, wrap = this._el.wrap;
    box.innerHTML = `<div class="de-title">${esc(o.title)}</div><div class="de-row"><input class="de-in" inputmode="decimal" value="${esc(o.value)}"><button class="de-ok">${esc(this._t("ok"))}</button></div>
      ${o.keep != null ? `<label class="de-keep"><input type="checkbox" class="de-k"${o.keep ? " checked" : ""}> ${esc(this._t("keep_angles"))}</label>` : ""}
      <div class="de-hint">${esc(this._t("dims_hint"))}</div>`;
    box.hidden = false;
    const wr = wrap.getBoundingClientRect(), ar = o.anchor ? o.anchor.getBoundingClientRect() : { left: wr.left + wr.width / 2, width: 0, bottom: wr.top + wr.height / 2 };
    const bw = box.offsetWidth || 230, bh = box.offsetHeight || 110;
    let x = ar.left - wr.left + ar.width / 2 - bw / 2, y = ar.bottom - wr.top + 8;
    if (y + bh > wr.height) y = Math.max(4, ar.bottom - wr.top - bh - (o.anchor ? o.anchor.getBoundingClientRect().height + 16 : 0));
    box.style.left = Math.max(4, Math.min(wr.width - bw - 4, x)) + "px";
    box.style.top = Math.max(4, y) + "px";
    const inp = box.querySelector(".de-in");
    const commit = () => { const v = this._parseNum(inp.value), k = box.querySelector(".de-k"); if (!isFinite(v)) { this._toast(this._t("invalid_len")); return false; } const okk = o.ok(v, k ? k.checked : undefined); if (okk) this._closeDimEdit(); return okk; };
    inp.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); commit(); }
      else if (ev.key === "Escape") { ev.preventDefault(); this._closeDimEdit(); }
      else if (ev.key === "Tab") { ev.preventDefault(); if (commit()) o.tab(ev.shiftKey ? -1 : 1); }
    });
    box.querySelector(".de-ok").addEventListener("click", commit);
    setTimeout(() => { inp.focus(); inp.select(); }, 0);
  }
  _closeDimEdit() { if (this._el && this._el.dimedit) { this._el.dimedit.hidden = true; this._el.dimedit.innerHTML = ""; } }

  _addRoomPoint(room) {
    const e = this._edges(room.polygon).sort((a, b) => b.len - a.len)[0];
    room.polygon.splice(e.i + 1, 0, [round(e.mid[0]), round(e.mid[1])]);
    this._renderRoom();
    this._apply({ rooms: this._rooms });
    this._toast(this._t("point_added"));
  }

  /* ----- Sensoren ----- */
  _openSensorPanel(s) {
    const o = this._off(s), ents = s.entities || {};
    const roomOpts = this._rooms.map((r) => `<option value="${esc(r.id)}"${r.id === s.room ? " selected" : ""}>${esc(r.name)}</option>`).join("");
    const entList = (ents.targets || []).map((t, i) => `<div class="p-ent"><b>Target ${i + 1}</b><code>${esc(t.x)}</code><code>${esc(t.y)}</code></div>`).join("")
      + `<div class="p-ent"><b>Presence</b><code>${esc(ents.presence || this._t("presence_unset"))}</code></div>`;
    this._panel(`${esc(s.label)} · ${esc(s.name)}`, `
      <div class="p-grid">
        ${this._field(this._t("name"), "name", s.name)}${this._field(this._t("label"), "label", s.label)}
        ${this._field(this._t("color"), "color", s.color, "color")}
        <label class="p-row"><span>${esc(this._t("room"))}</span><select data-p="room">${roomOpts}</select></label>
        ${this._field(this._t("range"), "range", s.range, "number")}${this._field(this._t("half_angle"), "half_angle", s.half_angle, "number")}
      </div>
      <div class="p-sub">${esc(this._t("placement"))}</div>
      <div class="p-grid">
        ${this._field(this._t("pos_x"), "px", this._basePos(s)[0], "number")}${this._field(this._t("pos_y"), "py", this._basePos(s)[1], "number")}
        ${this._field(this._t("rotation"), "rot", this._baseRot(s), "number")}
        <label class="p-row p-check"><input type="checkbox" data-p="flip_x"${s.flip_x < 0 ? " checked" : ""}><span>${esc(this._t("flip_x"))}</span></label>
      </div>
      <div class="p-sub">${esc(this._t("cal_offset"))}</div>
      <div class="p-grid">
        ${this._field(this._t("off_x"), "dx", o.dx || 0, "number")}${this._field(this._t("off_y"), "dy", o.dy || 0, "number")}
        ${this._field(this._t("off_r"), "dr", o.dr || 0, "number")}
      </div>
      <div class="p-sub">${esc(this._t("entities"))}</div>${entList}
      <div class="p-note">${this._t("entities_note")}</div>`,
    (get) => {
      this._pushUndo();
      const num = (k, def) => { const v = parseFloat(get(k)); return isFinite(v) ? v : def; };
      Object.assign(s, {
        name: get("name") || s.name, label: (get("label") || s.label).slice(0, 6), color: get("color") || s.color,
        room: get("room") || s.room, range: num("range", s.range), half_angle: num("half_angle", s.half_angle),
        pos: [num("px", s.pos[0]), num("py", s.pos[1])], rot: num("rot", s.rot),
        flip_x: this._el.panel.querySelector('[data-p="flip_x"]').checked ? -1 : 1,
        offset: { dx: num("dx", 0), dy: num("dy", 0), dr: num("dr", 0) },
      });
      this._apply({ sensors: this._geometry() });
      this._built = false; this._render();
    });
    const link = this._el.panel.querySelector("[data-act='settings']");
    if (link) link.addEventListener("click", (ev) => { ev.preventDefault(); this._openSettings(); });
  }

  /* ----- Kalibrierung ----- */
  _resetOffsets(ids, msg) {
    this._pushUndo();
    ids.filter(Boolean).forEach((id) => { const s = this._sensor(id); if (s) s.offset = { dx: 0, dy: 0, dr: 0 }; });
    this._renderGhosts();
    this._apply({ sensors: this._geometry() });
    this._toast(msg);
  }
  async _autoCal() {
    this._pushUndo();
    try {
      const res = await this._ws({ type: `${DOMAIN}/auto_calibrate`, room_id: this._activeRoom });
      if (res.ok) this._toast(this._t("aligned", { n: Object.keys(res.sensors).length }));
      else { this._popNoop(); this._toast(this._t(res.error === "need_two" ? "need_two" : "too_far")); }
    } catch (e) { this._popNoop(); this._toast(this._t("error") + ((e && e.message) || e)); }
  }
  async _startLearning() {
    const mins = (this._cfg.controls && this._cfg.controls.cal_duration) || 120;
    if (!confirm(this._t("learn_q", { m: mins }))) return;
    try { await this._ws({ type: `${DOMAIN}/calibration`, action: "start" }); this._toast(this._t("learn_started")); }
    catch (e) { this._toast(this._t("error") + ((e && e.message) || e)); }
  }
  _openSettings() {
    history.pushState(null, "", `/config/integrations/integration/${DOMAIN}`);
    window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace: false } }));
  }

  /* ----- Panel/Formulare ----- */
  _field(label, key, value, type = "text") {
    return `<label class="p-row"><span>${esc(label)}</span><input data-p="${key}" type="${type}" ${type === "number" ? 'step="any"' : ""} value="${esc(value)}"></label>`;
  }
  _panel(title, body, onSave, extras) {
    const p = this._el.panel;
    p.innerHTML = `<div class="p-box"><div class="p-head"><span>${title}</span><button class="p-close">✕</button></div>
      <div class="p-scroll">${body}</div><div class="p-foot">${(extras || []).map((x, i) => `<button class="p-extra" data-x="${i}">${esc(x.label)}</button>`).join("")}<span class="spacer"></span><button class="p-save">${esc(this._t("apply"))}</button></div></div>`;
    p.querySelectorAll(".p-extra").forEach((b) => b.addEventListener("click", () => { p.hidden = true; extras[+b.dataset.x].fn(); }));
    p.hidden = false;
    const get = (k) => { const el = p.querySelector(`[data-p="${k}"]`); return el ? String(el.value).trim() : ""; };
    p.querySelector(".p-close").addEventListener("click", () => { p.hidden = true; });
    p.addEventListener("click", (ev) => { if (ev.target === p) p.hidden = true; }, { once: true });
    p.querySelector(".p-save").addEventListener("click", () => { onSave(get); p.hidden = true; this._toast(this._t("applied")); });
  }

  /* ----- PIN ----- */
  _lockKey() { return "zp_lock"; }
  _lock() { try { return JSON.parse(localStorage.getItem(this._lockKey())) || { fails: 0, until: 0 }; } catch (e) { return { fails: 0, until: 0 }; } }
  _setLock(s) { try { localStorage.setItem(this._lockKey(), JSON.stringify(s)); } catch (e) {} }
  _fmt(t) { return this._timeFmt(t); }
  _requestUnlock(then) {
    if (!this._canEdit()) return this._toast(this._t("admin_only"));
    if (!this._pin()) { this._unlocked = true; then(); return; }
    this._pinThen = then;
    const lock = this._lock(), p = this._el.pin;
    p.hidden = false;
    if (lock.until > Date.now()) this._pinSub(this._t("locked_until", { t: this._fmt(lock.until) }));
    else { this._pinBuffer = ""; this._dots(); this._pinSub(lock.fails > 0 ? this._t("wrong_code", { n: 3 - lock.fails }) : this._t("enter_code")); }
  }
  _pinSub(t) { this._el.pin.querySelector(".pin-sub").textContent = t; }
  _dots() { this._el.pin.querySelectorAll(".pin-dots i").forEach((d, i) => d.classList.toggle("on", i < this._pinBuffer.length)); }
  _onPin(k) {
    if (k === "cancel") { this._el.pin.hidden = true; this._pinBuffer = ""; return; }
    if (k === "del") { this._pinBuffer = this._pinBuffer.slice(0, -1); return this._dots(); }
    if (this._lock().until > Date.now() || this._pinBuffer.length >= 4) return;
    this._pinBuffer += k; this._dots();
    if (this._pinBuffer.length === 4) setTimeout(() => this._checkPin(), 120);
  }
  _checkPin() {
    const box = this._el.pin.querySelector(".pin-box");
    if (this._pinBuffer === this._pin()) {
      this._setLock({ fails: 0, until: 0 });
      this._unlocked = true; this._pinBuffer = ""; this._el.pin.hidden = true;
      const then = this._pinThen; this._pinThen = null;
      (then || (() => this._setMode("zones")))();
      return;
    }
    const lock = this._lock(); lock.fails = (lock.fails || 0) + 1; this._pinBuffer = ""; this._dots();
    if (lock.fails >= 3) { lock.until = Date.now() + (Number(this._config.lock_minutes) || 30) * 60000; lock.fails = 0; this._pinSub(this._t("locked_until", { t: this._fmt(lock.until) })); }
    else this._pinSub(this._t("wrong_code", { n: 3 - lock.fails }));
    this._setLock(lock);
    box.classList.add("shake"); setTimeout(() => box.classList.remove("shake"), 500);
  }

  _toast(msg) {
    const t = this._el && this._el.toast; if (!t) return;
    t.textContent = msg; t.hidden = false; requestAnimationFrame(() => t.classList.add("show"));
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => { t.classList.remove("show"); setTimeout(() => { t.hidden = true; }, 250); }, 2600);
  }

  _guideHtml() {
    const t = (k) => this._t(k);   // feste, eigene Texte mit <b>-Auszeichnung
    return `<div class="guide-head">${esc(t("guide"))}</div><div class="guide-body">
      <p>${t("g_tabs")}</p>
      <p>${t("g_raw")}</p>
      <p>${t("g_edit")}</p>
      <ul>
        <li>${t("g_zones")}</li>
        <li>${t("g_sensors")}</li>
        <li>${t("g_rooms")}</li>
        <li>${t("g_cal")}</li>
        <li>${t("g_learn")}</li>
        <li>${t("g_excl")}</li>
      </ul><p>${t("g_view")}</p></div>`;
  }

  /* ===================================================== Modell-Ansicht (Daten, Panel, Interaktion) */
  _modelWanted() { return this._view === "model" || this._lay("heat") || this._lay("ghostmap"); }
  _syncModel() {
    if (!this._el || !this._cfg) return;
    clearInterval(this._mTimer); this._mTimer = null;
    if (this._mview && this._mview.room !== this._activeRoom) { this._mview = null; this._tl = null; }
    if (this._view === "model") {
      if (!this._fx) this._fx = new ModelFX(this);
      this._fx.attach(this._el.fx, this._el.svg, this._roomPoly(), this._mlayers);
      this._fx.start();
      this._renderOSens();
      this._renderMLegend();
    } else if (this._fx) this._fx.stop();
    if (!this._modelWanted()) { if (this._el.mbg) this._el.mbg.innerHTML = ""; return; }
    if (this._mview) this._onModelData(); else this._renderMPanel();
    if (!this._mview || Date.now() - (this._mFetched || 0) > 8000) this._fetchModel(false);
    this._mTimer = setInterval(() => { if (this.isConnected && !document.hidden) this._fetchModel(false); }, this._view === "model" ? 30000 : 60000);
  }
  async _fetchModel(history) {
    if (!this._hass || !this._activeRoom || this._mBusy) return;
    const room = this._activeRoom;
    this._mBusy = true;
    try {
      const v = await this._ws({ type: `${DOMAIN}/model_view`, room_id: room, history: !!history });
      if (room !== this._activeRoom) return;
      if (!history && this._mview && this._mview.history && this._mview.room === room) v.history = this._mview.history;
      this._mview = v; this._mErr = null; this._mFetched = Date.now();
    } catch (e) { this._mErr = (e && (e.message || e.code)) || "error"; }
    finally { this._mBusy = false; }
    this._onModelData();
  }
  _onModelData() {
    if (!this._el) return;
    if (this._view === "model") {
      if (this._fx && this._mview) this._fx.setData(this._tlSource() || this._mview);
      this._renderMPanel(); this._renderSpots(); this._renderMLegend();
    } else this._renderMbg();
  }
  _tlSource() {
    const h = this._mview && this._mview.history, i = this._tl ? this._tl.i : null;
    if (!h || i == null || i >= h.frames.length) return null;
    const f = h.frames[i];
    return { res: h.res, x0: h.x0, y0: h.y0, nx: h.nx, ny: h.ny, g: f.g, r: f.r, ts: f.ts };
  }
  // Grundriss-Ansicht: Heatmap/Geisterstellen als ruhiges Bild unter den Zonen
  _renderMbg() {
    const g = this._el && this._el.mbg; if (!g) return;
    const v = this._mview;
    if (!v || !(this._lay("heat") || this._lay("ghostmap"))) { g.innerHTML = ""; return; }
    const poly = this._roomPoly(), sc = 8;
    const cv = document.createElement("canvas"); cv.width = v.nx * sc; cv.height = v.ny * sc;
    const x = cv.getContext("2d");
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high";
    if ("filter" in x) x.filter = `blur(${sc * 0.9}px)`;
    for (const k of ["h", "g"]) {
      if ((k === "h" && !this._lay("heat")) || (k === "g" && !this._lay("ghostmap"))) continue;
      const t = buildTex(v, k, poly);
      x.globalCompositeOperation = "source-over"; x.globalAlpha = 0.75;
      x.drawImage(t.cv, 0, 0, cv.width, cv.height);
    }
    const [px, py] = this._px(v.x0, v.y0);
    g.innerHTML = `<image href="${cv.toDataURL()}" x="${px}" y="${py}" width="${v.nx * v.res * SCALE}" height="${v.ny * v.res * SCALE}" preserveAspectRatio="none" opacity="0.85"/>`;
  }
  _renderOSens() {
    const g = this._el && this._el.over && this._el.over.querySelector("#osens"); if (!g) return;
    g.innerHTML = this._activeSensors().map((s) => { const [cx, cy] = this._px(...this._effPos(s)); return `<g class="osen"><circle cx="${cx}" cy="${cy}" r="9" fill="${s.color}" style="filter:drop-shadow(0 0 8px ${s.color})"/><text x="${cx}" y="${cy - 16}" fill="${s.color}">${esc(s.label)}</text></g>`; }).join("");
  }
  _renderSpots() {
    const g = this._el && this._el.ospots; if (!g) return;
    const spots = (this._mview && !this._tlSource() && this._mview.spots) || [];
    g.innerHTML = spots.map((sp, i) => { const [x, y] = this._px(sp.x, sp.y); return `<g class="ospot" data-spot="${i}" transform="translate(${x} ${y})"><circle class="ring" r="20"/><circle class="dot" r="12"/><text y="4.5">${i + 1}</text></g>`; }).join("");
  }
  _legendChips() {
    return MODEL_LAYERS.map((k) => `<button class="mp-chip${this._mlayers.has(k) ? "" : " off"}" data-ml="${k}"><i style="background:${MLEG[k]};color:${MLEG[k]}"></i>${esc(this._t("leg_" + k))}</button>`).join("");
  }
  _renderMLegend() {
    const el = this._el && this._el.mlegend; if (!el) return;
    el.innerHTML = this._compact && this._config.legend !== false && this._view === "model" ? this._legendChips() : "";
  }
  _spotText(sp) {
    const parts = [this._t(sp.near_wall ? "spot_wall" : "spot_obj")];
    if (sp.cal) parts.push(this._t("spot_cal"));
    if (sp.slot) { const span = 24 / sp.slot[1]; parts.push(this._t("spot_slot", { a: Math.round(sp.slot[0] * span), b: Math.round((sp.slot[0] + 1) * span) })); }
    const s = this._sensor(sp.sensor); if (s) parts.push(this._t("spot_sensor", { s: s.label + " · " + s.name }));
    return parts.join(" ");
  }
  _renderMPanel() {
    const p = this._el && this._el.mpanel; if (!p) return;
    if (this._view !== "model" || this._compact) { p.hidden = true; return; }
    p.hidden = false;
    const v = this._mview;
    if (!v) { p.innerHTML = `<div class="mp-legend">${this._legendChips()}</div><div class="mp-load">${esc(this._mErr ? this._t("model_error") + ": " + this._mErr : this._t("model_loading"))}</div>`; return; }
    const st = v.stats || {}, daily = st.daily || {}, sens = this._activeSensors().map((s) => s.id);
    const now = new Date(), pad = (n) => String(n).padStart(2, "0");
    const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const weekAgo = new Date(now.getTime() - 6 * 86400000), weekKey = `${weekAgo.getFullYear()}-${pad(weekAgo.getMonth() + 1)}-${pad(weekAgo.getDate())}`;
    let nToday = 0, nWeek = 0;
    for (const sid of sens) {
      const days = daily[sid] || {};
      nToday += (days[todayKey] || [0])[0] || 0;
      for (const k of Object.keys(days)) if (k >= weekKey && k <= todayKey) nWeek += days[k][0] || 0;
    }
    const span = 24 / (v.slots || 1);
    const prec = st.precision;
    const tl = v.history;
    const frames = tl ? tl.frames.length : 0, ti = this._tl ? this._tl.i : frames;
    const tsTxt = tl && ti < frames ? new Date(tl.frames[ti].ts * 1000).toLocaleString(this._lang === "de" ? "de-DE" : undefined, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : this._t("tl_live");
    const snapH = { 1: 24, 2: 6, 3: 2 }[v.level] || 6;
    const spots = v.spots || [];
    const canEdit = this._canEdit();
    p.innerHTML = `<div class="mp-legend">${this._legendChips()}</div>
      <div class="mp-grid">
        <div class="mp-card">
          <div class="mp-h">${esc(this._t("m_learned"))}</div>
          <div class="mp-stat">${esc(this._t("st_today", { n: Math.round(nToday) }))} · <b>${esc(this._t("st_week", { n: Math.round(nWeek) }))}</b></div>
          <div class="mp-stat">${esc(prec == null ? this._t("st_noprec") : this._t("st_precision", { p: Math.round(prec * 100) }))}</div>
          <div class="mp-stat">${esc(this._t("st_level", { l: v.level }))}${v.slots > 1 ? " · " + esc(this._t("st_slot", { a: Math.round(v.slot * span), b: Math.round((v.slot + 1) * span) })) : ""} · ${esc(this._t("st_mem", { kb: st.memory_kb ?? "?" }))}</div>
          ${st.learning === false ? `<div class="mp-stat mp-warn">⚠ ${esc(this._t("st_learning_off"))}</div>` : ""}
          ${this._isAdmin() ? `<div class="mp-btns" style="margin-top:10px"><button data-mact="export">⤓ ${esc(this._t("export"))}</button><button data-mact="import">⤒ ${esc(this._t("import"))}</button><input type="file" accept="application/json,.json" class="mp-file" hidden></div>` : ""}
        </div>
        <div class="mp-card">
          <div class="mp-h">${esc(this._t("spots_title"))}</div>
          ${spots.length ? spots.map((sp, i) => `<div class="mp-spot${this._spotHl === i ? " hl" : ""}" data-spotrow="${i}"><span class="mp-num">${i + 1}</span><div><p>${esc(this._spotText(sp))}</p>
            ${canEdit ? `<div class="mp-btns"><button data-mact="spotexcl" data-i="${i}">⛔ ${esc(this._t("spot_excl"))}</button><button data-mact="spotforget" data-i="${i}">${esc(this._t("spot_forget"))}</button></div>` : ""}</div></div>`).join("")
            : `<div class="mp-stat">${esc(this._t("spot_none"))}</div>`}
        </div>
        <div class="mp-card">
          <div class="mp-h">${esc(this._t("tl_title"))}</div>
          ${frames ? `<div class="mp-tl"><button data-mact="tlplay">${this._tl && this._tl.play ? "❚❚" : "▶"}</button><input type="range" min="0" max="${frames}" step="1" value="${ti}" data-mact="tlslide"><span class="mp-date">${esc(tsTxt)}</span></div>`
            : tl ? `<div class="mp-stat">${esc(this._t("tl_none", { h: snapH }))}</div>` : `<button data-mact="tlload">▶ ${esc(this._t("tl_play"))}</button>`}
        </div>
      </div>`;
  }
  _spotHighlight(i) {
    this._spotHl = i;
    this._renderMPanel();
    const row = this._el.mpanel.querySelector(`[data-spotrow="${i}"]`);
    if (row && row.scrollIntoView) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  async _onMPanel(ev) {
    const chip = ev.target.closest("[data-ml]");
    if (chip && ev.type === "click") {
      const k = chip.dataset.ml;
      if (this._mlayers.has(k)) this._mlayers.delete(k); else this._mlayers.add(k);
      if (this._fx) this._fx.setLayers(this._mlayers);
      this._renderMPanel(); this._renderMLegend();
      return;
    }
    const b = ev.target.closest("[data-mact]"); if (!b) return;
    const act = b.dataset.mact;
    if (act === "tlslide" && ev.type === "input") {
      const n = this._mview.history.frames.length, i = +b.value;
      this._tl = Object.assign(this._tl || {}, { i: i >= n ? null : i });
      if (i >= n) this._tl.i = n;
      this._fx.setData(this._tlSource() || this._mview, true);
      this._renderSpots();
      const lbl = this._el.mpanel.querySelector(".mp-date");
      if (lbl) { const f = this._tlSource(); lbl.textContent = f ? new Date(f.ts * 1000).toLocaleString(this._lang === "de" ? "de-DE" : undefined, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : this._t("tl_live"); }
      return;
    }
    if (ev.type !== "click") return;
    if (act === "tlload") { await this._fetchModel(true); this._tl = { i: 0, play: true }; this._tlRun(); return; }
    if (act === "tlplay") { this._tl = this._tl || { i: 0 }; this._tl.play = !this._tl.play; if (this._tl.i >= (this._mview.history.frames.length)) this._tl.i = 0; this._tlRun(); this._renderMPanel(); return; }
    if (act === "export") return this._exportModel();
    if (act === "import") { const f = this._el.mpanel.querySelector(".mp-file"); f.onchange = () => this._importModel(f.files && f.files[0]); f.click(); return; }
    const sp = this._mview && this._mview.spots && this._mview.spots[+b.dataset.i];
    if (!sp) return;
    if (act === "spotexcl") {
      const bb = this._roomPoly().reduce((a, q) => [Math.min(a[0], q[0]), Math.min(a[1], q[1]), Math.max(a[2], q[0]), Math.max(a[3], q[1])], [Infinity, Infinity, -Infinity, -Infinity]);
      const r = [Math.max(bb[0], sp.rect[0]), Math.max(bb[1], sp.rect[1]), Math.min(bb[2], sp.rect[2]), Math.min(bb[3], sp.rect[3])];
      const run = () => { this._addExcl(r); this._toast(this._t("spot_created")); };
      if (!this._unlocked) this._requestUnlock(run); else run();
    } else if (act === "spotforget") this._forgetArea(sp.x, sp.y, Math.max(0.5, Math.sqrt(sp.area || 0.25)));
  }
  _tlRun() {
    clearTimeout(this._tlTimer);
    const h = this._mview && this._mview.history;
    if (!this._tl || !this._tl.play || !h || !h.frames.length || this._view !== "model") return;
    this._tl.i = (this._tl.i == null ? 0 : this._tl.i);
    this._fx.setData(this._tlSource() || this._mview, true);
    this._renderSpots(); this._renderMPanel();
    this._tlTimer = setTimeout(() => {
      if (!this._tl) return;
      this._tl.i += 1;
      if (this._tl.i > h.frames.length) { this._tl.play = false; this._tl.i = h.frames.length; this._fx.setData(this._mview, true); this._renderSpots(); this._renderMPanel(); return; }
      this._tlRun();
    }, 700);
  }
  _forgetArea(x, y, radius) {
    const run = async () => {
      try { await this._ws({ type: `${DOMAIN}/model_forget`, room_id: this._activeRoom, x, y, radius }); this._toast(this._t("forgotten")); this._closeMInfo(); this._fetchModel(false); }
      catch (e) { this._toast(this._t("error") + ((e && e.message) || e)); }
    };
    if (!this._canEdit()) return this._toast(this._t("admin_only"));
    if (!this._unlocked) this._requestUnlock(run); else run();
  }
  _modelClick(ev) {
    if (this._view !== "model") return;
    const spot = ev.target.closest("[data-spot]");
    if (spot) { if (!this._compact) this._spotHighlight(+spot.dataset.spot); return; }
    const v = this._mview; if (!v) return;
    const svg = this._el.over, pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
    const q = pt.matrixTransform(svg.getScreenCTM().inverse()), [x, y] = this._toRoom(q.x, q.y);
    if (!pip(x, y, this._roomPoly())) return this._closeMInfo();
    const gx = Math.floor((x - v.x0) / v.res), gy = Math.floor((y - v.y0) / v.res);
    if (gx < 0 || gy < 0 || gx >= v.nx || gy >= v.ny) return this._closeMInfo();
    const i = gy * v.nx + gx;
    const bar = (val, col) => `<div class="mi-bar"><i style="width:${val}%;background:${col}"></i></div>`;
    const blind = v.v && v.v[i] === 0;
    const box = this._el.minfo;
    box.innerHTML = blind ? `<div>${esc(this._t("info_blind"))}</div>` : `
      <div class="mi-row"><span>${esc(this._t("info_g"))}</span><b>${v.g[i]} %</b></div>${bar(v.g[i], MLEG.g)}
      <div class="mi-row"><span>${esc(this._t("info_r"))}</span><b>${v.r[i]} %</b></div>${bar(v.r[i], MLEG.r)}
      <div class="mi-row"><span>${esc(this._t("info_c"))}</span><b>${v.c[i]} %</b></div>${bar(v.c[i], MLEG.u)}
      <div class="mi-row"><span>${esc(this._t("info_h"))}</span><b>${v.h ? v.h[i] : 0} %</b></div>${bar(v.h ? v.h[i] : 0, MLEG.h)}
      ${this._canEdit() ? `<button class="mi-act" data-forget="${round(x, 2)},${round(y, 2)}">${esc(this._t("forget_area"))}</button>` : ""}`;
    box.hidden = false;
    const wr = this._el.wrap.getBoundingClientRect(), bw = box.offsetWidth, bh = box.offsetHeight;
    box.style.left = Math.max(6, Math.min(wr.width - bw - 6, ev.clientX - wr.left + 12)) + "px";
    box.style.top = Math.max(6, Math.min(wr.height - bh - 6, ev.clientY - wr.top + 12)) + "px";
  }
  _closeMInfo() { if (this._el && this._el.minfo) this._el.minfo.hidden = true; }
  _onMInfo(ev) {
    const b = ev.target.closest("[data-forget]"); if (!b) return;
    const [x, y] = b.dataset.forget.split(",").map(Number);
    this._forgetArea(x, y, 0.5);
  }
  async _exportModel() {
    try {
      const data = await this._ws({ type: `${DOMAIN}/model_export` });
      const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `zone-presence-model-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) { this._toast(this._t("error") + ((e && e.message) || e)); }
  }
  async _importModel(file) {
    if (!file) return;
    if (!confirm(this._t("import_q", { n: file.name }))) return;
    let data;
    try { data = JSON.parse(await file.text()); } catch (e) { return this._toast(this._t("import_bad")); }
    try {
      const res = await this._ws({ type: `${DOMAIN}/model_import`, data });
      this._toast(this._t("imported", { n: (res.sensors || []).length }));
      this._mview = null; this._fetchModel(false);
    } catch (e) { this._toast(this._t("import_bad") + " – " + ((e && e.message) || e)); }
  }

  /* ===================================================== CSS */
  _css() {
    return `
    :host{
      --c-bg: var(--primary-background-color, #0b0c0e);
      --c-surface: var(--ha-card-background, var(--card-background-color, #17181c));
      --c-raise: var(--gray200, var(--secondary-background-color, #202227));
      --c-raise2: var(--gray300, #2b2d34);
      --c-line: var(--gray400, var(--divider-color, #3f414b));
      --c-teal: var(--teal, var(--primary-color, #2fd6b0));
      --c-ink: var(--text-primary-color, #04130f);
      --c-text: var(--primary-text-color, #f1f2f4);
      --c-muted: var(--secondary-text-color, #868894);
      --c-red: var(--red, var(--error-color, #ef7b63));
      --c-active: var(--ob-active-teal, rgba(47,214,176,.14));
      --c-press: var(--ob-press, rgba(255,255,255,0.07));
      --c-scrim: var(--ob-scrim, rgba(5,6,8,0.45));
      --c-blur: var(--ob-blur, blur(14px) brightness(0.7));
      --rad: var(--ha-card-border-radius, 28px);
      --rad-in: var(--ob-radius-inner, 20px);
      --ease: var(--ob-ease, cubic-bezier(0.22,1,0.36,1));
      --spring: var(--ob-spring, cubic-bezier(0.34,1.56,0.64,1));
      --font: var(--primary-font-family, 'Outfit','Manrope','Inter',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif);
      display:block; font-family:var(--font); color:var(--c-text);
    }
    *{ box-sizing:border-box; }
    [hidden]{ display:none !important; }
    .zp{ position:relative; background:var(--c-surface); border-radius:var(--rad); overflow:hidden; }
    .empty{ padding:40px 20px; text-align:center; color:var(--c-muted); line-height:1.6; }
    .topbar{ display:flex; align-items:center; gap:8px; padding:14px 18px 8px; flex-wrap:wrap; }
    .title{ font-size:19px; font-weight:600; letter-spacing:.2px; }
    .chip{ font-size:12px; padding:5px 11px; border-radius:999px; background:var(--c-active); color:var(--c-teal); }
    .spacer{ flex:1; }
    button{ font-family:inherit; cursor:pointer; color:var(--c-text); background:var(--c-raise); border:0; border-radius:999px; padding:9px 16px; font-size:14px; font-weight:500;
      transition:background .2s var(--ease), transform .16s var(--spring), color .2s var(--ease), opacity .2s; }
    @media (hover:hover){ button:hover{ background:var(--c-raise2); } }
    button:active{ transform:scale(.97); background:var(--c-press); }
    .icon-btn{ padding:9px 13px; font-size:17px; line-height:1; }
    .icon-btn.on{ background:var(--c-active); color:var(--c-teal); }
    .icon-btn:disabled{ opacity:.35; cursor:default; transform:none; }
    .mode-btn{ display:flex; align-items:center; gap:9px; }
    .mode-btn .dot{ width:9px; height:9px; border-radius:50%; background:var(--c-muted); }
    .zp:not([data-mode="view"]) .mode-btn{ background:var(--c-active); color:var(--c-teal); }
    .zp:not([data-mode="view"]) .mode-btn .dot{ background:var(--c-teal); }
    .tabs{ display:flex; gap:7px; padding:2px 18px 6px; flex-wrap:wrap; }
    .tab{ padding:7px 14px; font-size:13px; color:var(--c-muted); display:inline-flex; gap:7px; align-items:center; }
    .tab.active{ background:var(--c-active); color:var(--c-teal); font-weight:600; }
    .tab-count:not(:empty){ min-width:18px; height:18px; border-radius:9px; background:var(--c-teal); color:var(--c-ink); font-size:11px; display:inline-grid; place-items:center; padding:0 5px; font-weight:700; }
    .tab-add{ color:var(--c-teal); background:transparent; border:1px dashed var(--c-line); }
    .toolbar{ padding:2px 18px 6px; display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
    .segs{ display:inline-flex; background:var(--c-raise); border-radius:999px; padding:3px; gap:2px; flex-wrap:wrap; }
    .segs.small .seg{ padding:6px 11px; font-size:12px; }
    .seg{ padding:7px 14px; font-size:13px; background:transparent; color:var(--c-muted); }
    .seg.on{ background:var(--c-active); color:var(--c-teal); font-weight:600; }
    .link-btn{ padding:7px 13px; font-size:13px; background:transparent; color:var(--c-muted); }
    .ctxbar{ display:flex; align-items:center; gap:8px; padding:2px 18px 8px; flex-wrap:wrap; }
    .ctx{ padding:7px 13px; font-size:13px; }
    .ctx.accent{ background:var(--c-active); color:var(--c-teal); }
    .ctx.danger{ color:var(--c-red); }
    .ctx-sel, .p-row select{ font-family:inherit; background:var(--c-raise); color:var(--c-text); border:0; border-radius:999px; padding:8px 12px; font-size:13px; }
    .hint{ font-size:12px; color:var(--c-muted); }
    .body{ display:flex; gap:12px; padding:0 14px 14px; }
    .guide{ position:relative; width:290px; flex:0 0 290px; border-radius:var(--rad-in); background:var(--c-raise); overflow:hidden; transition:flex-basis .32s var(--ease), width .32s var(--ease); }
    .guide-inner{ width:258px; padding:16px; transition:opacity .22s var(--ease); }
    .guide-toggle{ position:absolute; top:12px; right:12px; z-index:2; padding:3px 11px; background:var(--c-raise2); }
    .guide-head{ font-weight:600; color:var(--c-teal); margin-bottom:10px; font-size:15px; }
    .guide-body p{ margin:8px 0; font-size:13px; color:var(--c-muted); line-height:1.5; }
    .guide-body ul{ margin:8px 0 0; padding-left:16px; }
    .guide-body li{ font-size:12.5px; margin:7px 0; line-height:1.45; }
    .guide-body b{ color:var(--c-text); }
    .zp.guide-collapsed .guide{ width:46px; flex-basis:46px; }
    .zp.guide-collapsed .guide-inner{ opacity:0; pointer-events:none; }
    :host{ --zp-maxh:76vh; }
    :host([panel]){ --zp-maxh:calc(100vh - 210px); }
    .stage-wrap{ flex:0 1 auto; min-width:0; margin:0 auto; width:min(100%, calc(var(--zp-maxh) * var(--ar))); max-height:var(--zp-maxh); background:var(--c-bg); border-radius:var(--rad-in); overflow:hidden; }
    svg.stage{ width:100%; height:100%; display:block; touch-action:none; }
    /* Raum-Karte: nur der Grundriss, frei skalierbar (füllt die Kachel, Seitenverhältnis bleibt) */
    :host(.zp-room-host){ height:100%; }
    .zp.compact{ height:100%; display:flex; }
    .zp.compact > :not(.body){ display:none !important; }
    .zp.compact .body{ flex:1 1 auto; padding:0; min-width:0; min-height:0; height:100%; }
    .zp.compact .guide{ display:none; }
    .zp.compact .stage-wrap{ flex:1 1 auto; width:100%; height:100%; max-height:none; margin:0; background:transparent; border-radius:var(--rad); }
    .zp.compact svg.stage{ touch-action:auto; }
    .snap-line{ stroke:var(--c-teal); stroke-width:1.6; stroke-dasharray:7 6; opacity:.8; pointer-events:none; }
    .snap-pt{ fill:none; stroke:var(--c-teal); stroke-width:3; pointer-events:none; }
    /* nur die Ebene des aktiven Modus nimmt Klicks an – nichts verdeckt die Griffe */
    #persons, #raw, #coverage{ pointer-events:none; }
    .zp:not([data-mode="zones"]) #zones, .zp:not([data-mode="zones"]) #excl, .zp:not([data-mode="sensors"]) #sensors, #dims, #overlap, #mbg{ pointer-events:none; }
    .room{ fill:var(--c-bg); stroke:var(--c-line); stroke-width:3; }
    .room-corner{ fill:var(--c-teal); stroke:var(--c-surface); stroke-width:2.5; cursor:grab; }
    .room-edge, .edge-h{ fill:var(--c-surface); stroke:var(--c-teal); stroke-width:2; cursor:grab; }
    .edge-h{ stroke:var(--zc); }
    .move-h circle{ fill:var(--c-surface); stroke:var(--c-teal); stroke-width:2.5; cursor:move; }
    .move-h path{ stroke:var(--c-teal); stroke-width:2; fill:none; }
    .cov{ pointer-events:none; }
    .cov-edge{ fill:none; stroke-opacity:.35; stroke-width:1.5; opacity:.5; pointer-events:none; }
    .sensor-lbl{ font-size:12px; text-anchor:middle; font-weight:600; pointer-events:none; }
    .s-core{ filter:drop-shadow(0 0 7px var(--sc)); }
    .sensor.editable .s-core{ cursor:move; }
    .sensor.invalid .s-core{ opacity:.35; }
    .s-ring{ fill:none; stroke-opacity:.45; animation:zp-ring 3s ease-in-out infinite; transform-box:fill-box; transform-origin:center; pointer-events:none; }
    @keyframes zp-ring{ 0%,100%{ opacity:.45; transform:scale(1) } 50%{ opacity:.15; transform:scale(1.22) } }
    .s-rotline{ stroke:var(--c-teal); stroke-opacity:.5; stroke-width:1.5; stroke-dasharray:4 4; }
    .s-rot{ fill:var(--c-surface); stroke:var(--c-teal); stroke-width:2.5; cursor:grab; }
    .ghost-cone{ pointer-events:none; }
    .ghost-link{ stroke:#ff4d4d; stroke-opacity:.5; stroke-width:1.5; stroke-dasharray:5 5; pointer-events:none; }
    .ghost-rotline{ stroke:#ff4d4d; stroke-opacity:.6; stroke-width:1.5; stroke-dasharray:4 4; }
    .ghost-rot{ fill:#1a1012; stroke:#ff6b6b; stroke-width:2.5; cursor:grab; filter:drop-shadow(0 0 6px #ff4d4d); }
    .ghost-move circle{ fill:#1a1012; stroke:#ff6b6b; stroke-width:2.5; cursor:move; filter:drop-shadow(0 0 6px #ff4d4d); }
    .ghost-move path{ stroke:#ff8f8f; stroke-width:2; fill:none; }
    .zone-fill{ fill:var(--zc); fill-opacity:.10; stroke:var(--zc); stroke-opacity:.5; stroke-width:2.5; transition:fill-opacity .35s var(--ease), stroke-opacity .35s var(--ease); }
    .zone.occupied .zone-fill{ fill-opacity:.24; stroke-opacity:1; }
    .zone.disabled .zone-fill{ stroke-dasharray:8 6; fill-opacity:.04; }
    .tag-bg{ fill:var(--c-raise); transition:fill .3s var(--ease); cursor:pointer; }
    .zone.occupied .tag-bg{ fill:var(--c-active); }
    .tag-text{ fill:var(--c-text); font-size:15px; font-weight:500; text-anchor:middle; dominant-baseline:middle; }
    .zone-tag .tag-text{ cursor:pointer; }
    .tag-check{ fill:none; stroke:var(--c-teal); stroke-width:3; stroke-linecap:round; stroke-linejoin:round; opacity:0; transition:opacity .3s var(--ease); }
    .zone.occupied .tag-check{ opacity:1; }
    .zone.occupied .tag-text{ fill:var(--c-teal); }
    .tag-count{ opacity:0; transition:opacity .3s var(--ease); }
    .tag-count.has{ opacity:1; }
    .tag-count circle{ fill:var(--c-teal); }
    .tag-count-t{ fill:var(--c-ink); font-size:12px; font-weight:700; text-anchor:middle; }
    .tag-del circle{ fill:var(--c-raise2); } .tag-del path{ stroke:var(--c-red); stroke-width:2; stroke-linecap:round; } .tag-del{ cursor:pointer; }
    .corner-h{ fill:var(--zc); stroke:var(--c-surface); stroke-width:2.5; cursor:grab; }
    .corner-h.extra{ fill-opacity:.18; stroke:var(--zc); }
    .person{ transition:transform .16s linear; }
    .pop{ animation:zp-pop .5s var(--spring); }
    @keyframes zp-pop{ from{ transform:translateY(16px) scale(.2); opacity:0 } to{ transform:none; opacity:1 } }
    .p-halo{ opacity:.16; animation:zp-pulse 2.4s ease-in-out infinite; transform-box:fill-box; transform-origin:center; }
    .p-still{ fill:none; stroke-width:2; stroke-dasharray:3 5; opacity:0; transition:opacity .6s var(--ease); }
    .person.still .p-still{ opacity:.8; }
    .person.still .p-halo{ animation:none; opacity:.1; }
    .p-core{ filter:drop-shadow(0 0 8px var(--g)); }
    .p-lbl{ fill:var(--c-ink); font-size:12px; font-weight:700; text-anchor:middle; dominant-baseline:middle; }
    .p-lbl.small{ font-size:10px; }
    @keyframes zp-pulse{ 0%,100%{ transform:scale(1); opacity:.16 } 50%{ transform:scale(1.16); opacity:.26 } }
    .cand circle{ fill:none; stroke-width:2; stroke-dasharray:4 4; opacity:.8; }
    .cand text{ fill:var(--c-muted); font-size:11px; text-anchor:middle; }
    .rej path{ stroke:#ff6b6b; stroke-width:2.5; stroke-linecap:round; opacity:.8; }
    .panel{ position:fixed; inset:0; z-index:9998; display:flex; align-items:center; justify-content:center; padding:16px; background:var(--c-scrim); backdrop-filter:var(--c-blur); -webkit-backdrop-filter:var(--c-blur); animation:zp-fade .2s var(--ease); }
    .p-box{ background:var(--c-surface); border:1px solid var(--c-line); border-radius:26px; width:460px; max-width:100%; max-height:88vh; display:flex; flex-direction:column; overflow:hidden; animation:zp-rise .35s var(--spring); }
    .p-head{ display:flex; align-items:center; justify-content:space-between; padding:16px 18px; font-weight:600; border-bottom:1px solid var(--c-line); }
    .p-close{ padding:3px 10px; }
    .p-scroll{ padding:16px 18px; overflow:auto; }
    .p-grid{ display:grid; grid-template-columns:1fr 1fr; gap:9px; margin-bottom:12px; }
    .p-row{ display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--c-muted); }
    .p-row input:not([type=checkbox]){ font-family:inherit; background:var(--c-bg); color:var(--c-text); border:1px solid var(--c-line); border-radius:12px; padding:8px 10px; font-size:13px; min-height:36px; }
    .p-row input[type=color]{ padding:3px; }
    .p-check{ flex-direction:row; align-items:center; gap:8px; color:var(--c-text); font-size:13px; }
    .p-sub{ font-size:12px; color:var(--c-teal); margin:6px 0 8px; font-weight:600; }
    .p-ent{ background:var(--c-raise); border-radius:14px; padding:9px 11px; margin-bottom:7px; font-size:12px; display:flex; flex-direction:column; gap:3px; }
    .p-ent code{ color:var(--c-muted); word-break:break-all; }
    .p-note{ font-size:11.5px; color:var(--c-muted); line-height:1.5; margin-top:8px; }
    .p-note a{ color:var(--c-teal); }
    .p-foot{ padding:14px 18px; border-top:1px solid var(--c-line); text-align:right; }
    .p-save{ background:var(--c-active); color:var(--c-teal); font-weight:600; padding:10px 22px; }
    .toast{ position:fixed; left:50%; bottom:28px; transform:translateX(-50%) translateY(14px); z-index:10000; background:var(--c-raise2); padding:11px 20px; border-radius:999px; font-size:13px; box-shadow:0 8px 28px rgba(0,0,0,.4); opacity:0; transition:opacity .25s var(--ease), transform .3s var(--spring); }
    .toast.show{ opacity:1; transform:translateX(-50%) translateY(0); }
    .pin-overlay{ position:fixed; inset:0; z-index:9999; display:flex; align-items:center; justify-content:center; padding:16px; background:var(--c-scrim); backdrop-filter:var(--c-blur); -webkit-backdrop-filter:var(--c-blur); animation:zp-fade .2s var(--ease); }
    @keyframes zp-fade{ from{ opacity:0 } to{ opacity:1 } }
    .pin-box{ background:var(--c-surface); border:1px solid var(--c-line); border-radius:28px; padding:22px; width:290px; max-width:100%; animation:zp-rise .35s var(--spring); }
    @keyframes zp-rise{ from{ opacity:0; transform:translateY(10px) } to{ opacity:1; transform:none } }
    .pin-box.shake{ animation:zp-shake .4s; }
    @keyframes zp-shake{ 0%,100%{transform:translateX(0)} 20%{transform:translateX(-8px)} 40%{transform:translateX(8px)} 60%{transform:translateX(-6px)} 80%{transform:translateX(6px)} }
    .pin-title{ text-align:center; font-weight:600; font-size:17px; }
    .pin-sub{ text-align:center; color:var(--c-muted); font-size:13px; margin-top:5px; min-height:18px; }
    .pin-dots{ display:flex; gap:14px; justify-content:center; margin:14px 0; }
    .pin-dots i{ width:14px; height:14px; border-radius:50%; background:var(--c-raise2); transition:.2s var(--ease); }
    .pin-dots i.on{ background:var(--c-teal); }
    .pin-pad{ display:grid; grid-template-columns:repeat(3,1fr); gap:10px; }
    .pin-pad button{ height:52px; font-size:22px; border-radius:var(--rad-in); transition:transform .32s var(--spring), background .18s var(--ease); }
    .pin-pad button:active{ transform:scale(.88); }
    .pin-pad .aux{ color:var(--c-muted); font-size:18px; }

    /* ---------- 1.2: Ansicht wählen, sichtbare Elemente */
    .vseg{ margin-left:4px; } .vseg .seg{ padding:6px 12px; font-size:12.5px; }
    .lay-btn svg{ display:block; }
    .laypop{ position:absolute; right:14px; top:58px; z-index:30; width:270px; max-width:calc(100% - 28px); max-height:70vh; overflow:auto; background:var(--c-surface); border:1px solid var(--c-line); border-radius:20px; padding:12px; box-shadow:0 16px 40px rgba(0,0,0,.45); animation:zp-rise .25s var(--spring); }
    .lp-head{ font-size:11px; color:var(--c-muted); text-transform:uppercase; letter-spacing:.07em; margin:4px 6px 8px; }
    .lp-presets{ display:flex; flex-wrap:wrap; gap:6px; margin-bottom:12px; }
    .lp-preset{ padding:6px 11px; font-size:12px; } .lp-preset.on{ background:var(--c-active); color:var(--c-teal); }
    .lp-row{ display:flex; gap:10px; align-items:center; padding:6px 7px; font-size:13px; border-radius:10px; cursor:pointer; }
    @media (hover:hover){ .lp-row:hover{ background:var(--c-raise); } }
    .zp.L-off-zones #zones, .zp.L-off-exclusions #excl, .zp.L-off-sensors #sensors, .zp.L-off-cones #coverage, .zp.L-off-persons #persons{ display:none; }
    .zp.L-off-zone_names .zone .zone-tag{ display:none; }
    .zp.L-off-person_labels .p-lbl{ display:none; }
    .zp.L-off-raw .cand, .zp.L-off-rejected .rej{ display:none; }
    .zp[data-mode="zones"] #zones, .zp[data-mode="zones"] #excl, .zp[data-mode="zones"] .zone .zone-tag, .zp[data-mode="sensors"] #sensors{ display:inline !important; }
    /* ---------- Sperrzonen: immer rot, in der Ansicht nur angedeutet */
    .ex-fill{ fill:var(--zc); fill-opacity:.045; stroke:var(--zc); stroke-opacity:.38; stroke-width:2; stroke-dasharray:7 6; }
    .ex-hatch{ opacity:.06; pointer-events:none; }
    .zp[data-mode="zones"] .ex-fill{ fill-opacity:.1; stroke-opacity:.95; }
    .zp[data-mode="zones"] .ex-hatch{ opacity:.22; }
    .excl.disabled .ex-fill{ stroke-opacity:.18; }
    .ex-tag .tag-bg{ fill:rgba(255,59,59,.16); } .ex-tag .tag-text{ fill:#ff8a8a; font-size:13px; }
    .ex-add{ color:#ff7a7a; }
    .excl .corner-h{ fill:var(--zc); } .excl .edge-h{ stroke:var(--zc); } .excl .move-h circle{ stroke:var(--zc); } .excl .move-h path{ stroke:var(--zc); }
    .rej.ex path{ stroke:#ff3b3b; opacity:.5; }
    /* ---------- Bemaßung */
    .dim rect{ fill:var(--c-surface); stroke:var(--c-teal); stroke-width:1.6; }
    .dim text{ fill:var(--c-text); font-size:12.5px; font-weight:600; text-anchor:middle; font-variant-numeric:tabular-nums; pointer-events:none; }
    .dim-h{ cursor:grab; }
    @media (hover:hover){ .dim-h:hover rect{ fill:var(--c-raise2); } }
    #dims .dim rect{ fill:var(--c-raise); stroke:var(--c-line); opacity:.92; }
    .ang rect{ fill:var(--c-bg); stroke:var(--c-line); stroke-width:1; opacity:.92; }
    .ang text{ fill:var(--c-muted); font-size:11px; text-anchor:middle; font-variant-numeric:tabular-nums; pointer-events:none; }
    .ang{ cursor:pointer; } .ang.right text{ fill:var(--c-teal); }
    .dimedit{ position:absolute; z-index:20; width:240px; background:var(--c-surface); border:1px solid var(--c-line); border-radius:18px; padding:11px 12px; box-shadow:0 14px 34px rgba(0,0,0,.45); animation:zp-rise .2s var(--spring); }
    .de-title{ font-size:12px; color:var(--c-muted); margin-bottom:6px; }
    .de-row{ display:flex; gap:7px; }
    .de-in{ flex:1; min-width:0; font:inherit; font-size:16px; background:var(--c-bg); color:var(--c-text); border:1px solid var(--c-teal); border-radius:12px; padding:7px 10px; }
    .de-ok{ padding:7px 14px; background:var(--c-active); color:var(--c-teal); font-weight:600; }
    .de-keep{ display:flex; gap:7px; align-items:center; font-size:12px; margin-top:8px; }
    .de-hint{ font-size:11px; color:var(--c-muted); margin-top:7px; line-height:1.35; }
    .ovl{ fill:#fff; fill-opacity:.06; stroke:#fff; stroke-opacity:.35; stroke-width:1.5; stroke-dasharray:4 5; }
    /* ---------- Vorlagen */
    .dd{ position:relative; display:inline-flex; gap:2px; }
    .dd > .ctx:first-child{ border-radius:999px 6px 6px 999px; }
    .dd-btn{ border-radius:6px 999px 999px 6px !important; padding:7px 10px !important; }
    .dd-menu{ position:absolute; top:calc(100% + 6px); left:0; z-index:25; display:flex; flex-direction:column; min-width:220px; background:var(--c-surface); border:1px solid var(--c-line); border-radius:16px; padding:6px; box-shadow:0 14px 34px rgba(0,0,0,.45); }
    .dd-item{ text-align:left; background:transparent; padding:8px 10px; border-radius:10px; font-size:13px; display:flex; justify-content:space-between; gap:12px; }
    .dd-item small{ color:var(--c-muted); }
    .p-foot{ display:flex; align-items:center; gap:8px; } .p-foot .spacer{ flex:1; } .p-extra{ padding:9px 14px; font-size:13px; }
    /* ---------- Modell-Ansicht */
    .stage-wrap{ position:relative; }
    canvas.fx, svg.over{ position:absolute; inset:0; width:100%; height:100%; display:none; }
    .zp.view-model canvas.fx{ display:block; pointer-events:none; }
    .zp.view-model svg.over{ display:block; }
    .zp.view-model .stage-wrap{ background:radial-gradient(120% 90% at 50% 40%, #0d1022 0%, #05060b 72%); }
    .zp.view-model .room{ fill:#070912; stroke:rgba(160,170,255,.12); }
    .zp.view-model #coverage, .zp.view-model #persons, .zp.view-model #raw, .zp.view-model #ghosts, .zp.view-model #mbg, .zp.view-model #overlap, .zp.view-model #dims, .zp.view-model #sensors{ display:none; }
    .zp.view-model #zones .zone-fill{ fill-opacity:.02; stroke-opacity:.2; }
    .zp.view-model .zone-tag{ opacity:.45; }
    .zp.view-model .toolbar, .zp.view-model .ctxbar{ display:none !important; }
    .o-room{ fill:none; stroke:rgba(190,200,255,.3); stroke-width:2.5; pointer-events:none; filter:drop-shadow(0 0 7px rgba(140,120,255,.5)); }
    .o-hit{ fill:transparent; cursor:crosshair; }
    .osen{ pointer-events:none; } .osen text{ font-size:12px; font-weight:700; text-anchor:middle; opacity:.85; }
    .ospot{ cursor:pointer; }
    .ospot circle.ring{ fill:none; stroke:#ff5fd2; stroke-width:2.5; animation:zp-spot 2.4s ease-in-out infinite; transform-box:fill-box; transform-origin:center; }
    .ospot circle.dot{ fill:rgba(20,10,30,.85); stroke:#ff5fd2; stroke-width:2; }
    .ospot text{ fill:#ffd1f3; font-size:13px; font-weight:700; text-anchor:middle; pointer-events:none; }
    @keyframes zp-spot{ 0%,100%{ transform:scale(1); opacity:.9 } 50%{ transform:scale(1.35); opacity:.25 } }
    .minfo{ position:absolute; z-index:20; min-width:220px; background:rgba(14,15,24,.94); color:#eef; border:1px solid rgba(160,170,255,.25); border-radius:16px; padding:10px 12px; font-size:12.5px; -webkit-backdrop-filter:blur(10px); backdrop-filter:blur(10px); box-shadow:0 12px 30px rgba(0,0,0,.5); }
    .mi-row{ display:flex; justify-content:space-between; gap:12px; margin:3px 0; } .mi-row b{ font-variant-numeric:tabular-nums; }
    .mi-bar{ height:4px; border-radius:2px; background:rgba(255,255,255,.08); margin:2px 0 6px; overflow:hidden; } .mi-bar i{ display:block; height:100%; }
    .mi-act{ margin-top:8px; width:100%; font-size:12.5px; padding:8px 10px; background:rgba(255,95,210,.14); color:#ffb3ea; }
    .mpanel{ padding:0 14px 16px; }
    .mp-legend, .mlegend{ display:flex; flex-wrap:wrap; gap:7px; }
    .mp-chip{ display:inline-flex; align-items:center; gap:7px; padding:6px 12px; font-size:12.5px; }
    .mp-chip i{ width:10px; height:10px; border-radius:50%; box-shadow:0 0 10px currentColor; }
    .mp-chip.off{ opacity:.4; } .mp-chip.off i{ box-shadow:none; }
    .mp-grid{ display:grid; grid-template-columns:repeat(auto-fit, minmax(250px, 1fr)); gap:10px; margin-top:10px; }
    .mp-card{ background:var(--c-raise); border-radius:var(--rad-in); padding:13px 15px; font-size:13px; min-width:0; }
    .mp-h{ font-weight:600; margin-bottom:8px; color:var(--c-teal); }
    .mp-stat{ color:var(--c-muted); margin:4px 0; line-height:1.45; } .mp-stat b{ color:var(--c-text); font-weight:600; }
    .mp-warn{ color:#fbbf24; }
    .mp-spot{ display:flex; gap:10px; padding:9px 6px; border-top:1px solid var(--c-line); border-radius:12px; transition:background .3s var(--ease); }
    .mp-spot:first-of-type{ border-top:0; } .mp-spot.hl{ background:rgba(255,95,210,.08); }
    .mp-num{ flex:0 0 24px; height:24px; border-radius:50%; background:rgba(255,95,210,.18); color:#ff9de6; display:grid; place-items:center; font-weight:700; font-size:12px; }
    .mp-spot p{ margin:0 0 7px; line-height:1.42; }
    .mp-btns{ display:flex; gap:6px; flex-wrap:wrap; } .mp-btns button{ padding:5px 11px; font-size:12px; }
    .mp-tl{ display:flex; align-items:center; gap:10px; } .mp-tl button{ padding:6px 12px; }
    .mp-tl input[type=range]{ flex:1; min-width:0; accent-color:var(--c-teal); }
    .mp-date{ font-size:12px; color:var(--c-muted); min-width:96px; text-align:right; font-variant-numeric:tabular-nums; }
    .mp-load{ color:var(--c-muted); font-size:13px; padding:10px 2px; }
    .mlegend{ position:absolute; left:10px; bottom:10px; z-index:5; pointer-events:auto; }
    .zp:not(.compact) .mlegend{ display:none; }
    .mlegend{ gap:4px; max-width:calc(100% - 20px); }
    .mlegend .mp-chip{ background:rgba(10,12,20,.62); color:#dde; padding:3px 8px; font-size:10.5px; gap:5px; -webkit-backdrop-filter:blur(6px); backdrop-filter:blur(6px); }
    .zp.compact.view-model .stage-wrap{ border-radius:var(--rad); }
    @media (max-width:760px){
      .vseg .seg{ padding:6px 10px; }
      .body{ flex-direction:column; }
      .guide{ width:auto; flex-basis:auto; order:2; }
      .guide-inner{ width:auto; }
      :host{ --zp-maxh:62vh; }
      .stage-wrap{ order:1; }
      .zp.guide-collapsed .guide{ width:auto; flex-basis:auto; min-height:46px; }
      .zp.guide-collapsed .guide-inner{ height:0; padding:0; opacity:0; }
      .zp.guide-collapsed .guide::before{ content:attr(data-label); position:absolute; left:16px; top:14px; font-size:13px; color:var(--c-muted); }
      .p-grid{ grid-template-columns:1fr; }
      .topbar, .tabs, .toolbar, .ctxbar{ padding-left:14px; padding-right:14px; }
    }`;
  }
}

/* ===================================================== Raum-Karte (nur Grundriss) */
// type: custom:zone-presence-room-card
//   room: <Name oder ID>        (leer = erster Raum)
//   show_cones: true|false      (Sensoren + Erfassungskegel)
//   show_names: true|false      (Zonennamen/Zähler)
class ZonePresenceRoomCard extends ZonePresenceCard {
  constructor() { super(); this._compact = true; }
  connectedCallback() { this.classList.add("zp-room-host"); super.connectedCallback(); }
  setConfig(config) { super.setConfig(Object.assign({ show_cones: true, show_names: true }, config || {})); }
  static getStubConfig() { return { show_cones: true, show_names: true }; }
  static getConfigElement() { return document.createElement("zone-presence-room-card-editor"); }
  getCardSize() { return 6; }
  // Sections-Ansicht: frei in Breite und Höhe skalierbar
  getGridOptions() { return { columns: 6, rows: 4, min_columns: 2, min_rows: 2 }; }
  _onMsg(m) {
    // Raum aus der Konfiguration bleibt fest (keine Tabs in dieser Karte)
    if (m.type === "config" && this._config.room) {
      const r = m.rooms.find((x) => x.id === this._config.room || x.name === this._config.room);
      if (r) this._activeRoom = r.id;
    }
    super._onMsg(m);
  }
}

/* ===================================================== Modell-Karte (KI-Modell, fließend) */
// type: custom:zone-presence-model-card
//   room: <Name oder ID>   show_targets: true|false   legend: true|false   model_layers: [g, r, u, h, t]
class ZonePresenceModelCard extends ZonePresenceCard {
  constructor() { super(); this._compact = true; this._view = "model"; }
  connectedCallback() { this.classList.add("zp-room-host"); super.connectedCallback(); }
  setConfig(config) { super.setConfig(Object.assign({ show_targets: true, legend: true }, config || {})); }
  static getStubConfig() { return { show_targets: true, legend: true }; }
  static getConfigElement() { return document.createElement("zone-presence-model-card-editor"); }
  getCardSize() { return 6; }
  getGridOptions() { return { columns: 6, rows: 4, min_columns: 3, min_rows: 2 }; }
  _setView() {}
  _onMsg(m) {
    if (m.type === "config" && this._config.room) {
      const r = m.rooms.find((x) => x.id === this._config.room || x.name === this._config.room);
      if (r) this._activeRoom = r.id;
    }
    super._onMsg(m);
  }
}

class ZonePresenceRoomCardEditor extends HTMLElement {
  get _kind() { return "room"; }
  setConfig(config) { this._config = Object.assign({}, config || {}); this._render(); }
  set hass(h) {
    this._hass = h;
    if (!this._rooms && !this._loading) this._load();
    this._render();
  }
  get _lang() { const h = this._hass; return normLang(h && ((h.locale && h.locale.language) || h.language)); }
  _t(k) { return I18N[this._lang][k] || I18N.en[k] || k; }
  async _load() {
    this._loading = true;
    try { const cfg = await this._hass.callWS({ type: `${DOMAIN}/config` }); this._rooms = cfg.rooms || []; this._err = false; }
    catch (e) { this._rooms = []; this._err = true; }
    this._loading = false;
    this._render();
  }
  _changed(patch) {
    const c = Object.assign({}, this._config, patch);
    if (!c.room) delete c.room;
    if (Array.isArray(c.layers) && !c.layers.length) delete c.layers;
    this._config = c;
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: c }, bubbles: true, composed: true }));
  }
  _render() {
    if (!this._hass || !this._config) return;
    const c = this._config;
    const rooms = this._rooms || [];
    const data = { room: rooms.some((r) => r.id === c.room) ? c.room : (rooms.find((r) => r.name === c.room) || {}).id || "",
      show_cones: c.show_cones !== false, show_names: c.show_names !== false,
      show_targets: c.show_targets !== false, legend: c.legend !== false,
      layers: Array.isArray(c.layers) ? c.layers : [], model_layers: Array.isArray(c.model_layers) ? c.model_layers : ["g", "r", "u", "t"] };
    const model = this._kind === "model";
    const roomSel = { name: "room", selector: { select: { mode: "dropdown", options: [{ value: "", label: this._t("ed_first") }].concat(rooms.map((r) => ({ value: r.id, label: r.name }))) } } };
    const schema = model ? [
      roomSel,
      { name: "show_targets", selector: { boolean: {} } },
      { name: "legend", selector: { boolean: {} } },
      { name: "model_layers", selector: { select: { multiple: true, mode: "list", options: MODEL_LAYERS.filter((k) => k !== "t").map((k) => ({ value: k, label: this._t("leg_" + k) })) } } },
    ] : [
      roomSel,
      { name: "show_cones", selector: { boolean: {} } },
      { name: "show_names", selector: { boolean: {} } },
      { name: "layers", selector: { select: { multiple: true, mode: "list", options: LAYERS.filter((k) => !["raw", "rejected"].includes(k)).map((k) => ({ value: k, label: this._t("lay_" + k) })) } } },
    ];
    const labels = { room: "ed_room", show_cones: "ed_cones", show_names: "ed_names", show_targets: "ed_targets", legend: "ed_legend", layers: "ed_layers", model_layers: "ed_layers" };
    if (customElements.get("ha-form")) {
      if (!this._form) {
        this._form = document.createElement("ha-form");
        this._form.addEventListener("value-changed", (ev) => this._changed(ev.detail.value));
        this._note = document.createElement("div");
        this._note.style.cssText = "color:var(--secondary-text-color);font-size:13px;margin-bottom:8px";
        this.append(this._note, this._form);
      }
      this._note.textContent = this._loading ? this._t("ed_loading") : this._err ? this._t("ed_error") : "";
      this._form.hass = this._hass;
      this._form.data = data;
      this._form.schema = schema;
      this._form.computeLabel = (sch) => this._t(labels[sch.name]);
      return;
    }
    // Rückfall ohne ha-form (z. B. außerhalb von Home Assistant)
    const cb = (k) => `<label><input type="checkbox" data-k="${k}"${data[k] ? " checked" : ""}> ${esc(this._t(labels[k]))}</label>`;
    const multi = (k, opts) => `<fieldset style="border:0;padding:0;margin:0"><legend>${esc(this._t(labels[k]))}</legend>${opts.map((o) => `<label style="display:block"><input type="checkbox" data-m="${k}" value="${o.value}"${data[k].includes(o.value) ? " checked" : ""}> ${esc(o.label)}</label>`).join("")}</fieldset>`;
    this.innerHTML = `<div style="display:grid;gap:10px;font-family:inherit">
      ${this._loading ? `<div>${esc(this._t("ed_loading"))}</div>` : this._err ? `<div>${esc(this._t("ed_error"))}</div>` : ""}
      <label>${esc(this._t("ed_room"))} <select data-k="room"><option value="">${esc(this._t("ed_first"))}</option>${rooms.map((r) => `<option value="${esc(r.id)}"${r.id === data.room ? " selected" : ""}>${esc(r.name)}</option>`).join("")}</select></label>
      ${model ? cb("show_targets") + cb("legend") + multi("model_layers", schema[3].selector.select.options) : cb("show_cones") + cb("show_names") + multi("layers", schema[3].selector.select.options)}</div>`;
    this.querySelectorAll("[data-k]").forEach((el) => el.addEventListener("change", () => this._changed({ [el.dataset.k]: el.type === "checkbox" ? el.checked : el.value })));
    this.querySelectorAll("[data-m]").forEach((el) => el.addEventListener("change", () => {
      const k = el.dataset.m, vals = [...this.querySelectorAll(`[data-m="${k}"]:checked`)].map((x) => x.value);
      this._changed({ [k]: vals });
    }));
  }
}

class ZonePresenceModelCardEditor extends ZonePresenceRoomCardEditor { get _kind() { return "model"; } }

/* ===================================================== Seitenleisten-Panel */
class ZonePresencePanel extends HTMLElement {
  set hass(h) { this._hass = h; this._ensure(); if (this._card) this._card.hass = h; if (this._menu) this._menu.hass = h; }
  set narrow(n) { this._narrow = n; if (this._menu) this._menu.narrow = n; this._ensure(); }
  set panel(p) { this._panel = p; this._ensure(); }
  _ensure() {
    if (this._card || !this._panel) return;
    const cfg = (this._panel && this._panel.config) || {};
    this.innerHTML = "";
    const style = document.createElement("style");
    style.textContent = `zone-presence-panel{ display:block; min-height:100vh; background:var(--primary-background-color); }
      .zpp-head{ display:flex; align-items:center; height:56px; padding:0 8px; color:var(--app-header-text-color, var(--primary-text-color)); }
      .zpp-body{ padding:8px 16px 24px; max-width:1500px; margin:0 auto; }`;
    const head = document.createElement("div");
    head.className = "zpp-head";
    this._menu = document.createElement("ha-menu-button");
    this._menu.hass = this._hass; this._menu.narrow = this._narrow;
    head.appendChild(this._menu);
    const body = document.createElement("div");
    body.className = "zpp-body";
    this._card = document.createElement("zone-presence-card");
    this._card.setAttribute("panel", "");
    this._card.setConfig({ entry_id: cfg.entry_id, title: (this._panel && this._panel.title) || "" });
    if (this._hass) this._card.hass = this._hass;
    body.appendChild(this._card);
    this.append(style, head, body);
  }
}

if (!customElements.get("zone-presence-card")) customElements.define("zone-presence-card", ZonePresenceCard);
if (!customElements.get("zone-presence-panel")) customElements.define("zone-presence-panel", ZonePresencePanel);
if (!customElements.get("zone-presence-room-card")) customElements.define("zone-presence-room-card", ZonePresenceRoomCard);
if (!customElements.get("zone-presence-room-card-editor")) customElements.define("zone-presence-room-card-editor", ZonePresenceRoomCardEditor);
if (!customElements.get("zone-presence-model-card")) customElements.define("zone-presence-model-card", ZonePresenceModelCard);
if (!customElements.get("zone-presence-model-card-editor")) customElements.define("zone-presence-model-card-editor", ZonePresenceModelCardEditor);
window.customCards = window.customCards || [];
if (!window.customCards.find((c) => c.type === "zone-presence-card")) {
  window.customCards.push({ type: "zone-presence-card", name: "Zone Presence Detection", description: I18N[normLang(navigator.language)].card_desc, preview: false });
}
if (!window.customCards.find((c) => c.type === "zone-presence-room-card")) {
  const L = I18N[normLang(navigator.language)];
  window.customCards.push({ type: "zone-presence-room-card", name: L.room_card_name, description: L.room_card_desc, preview: true });
}
if (!window.customCards.find((c) => c.type === "zone-presence-model-card")) {
  const L = I18N[normLang(navigator.language)];
  window.customCards.push({ type: "zone-presence-model-card", name: L.model_card_name, description: L.model_card_desc, preview: true });
}
console.info("%c Zone Presence Detection %c " + VERSION + " ", "background:#2dd4bf;color:#04110f;border-radius:4px 0 0 4px", "background:#0f2227;color:#2dd4bf;border-radius:0 4px 4px 0");
})();
