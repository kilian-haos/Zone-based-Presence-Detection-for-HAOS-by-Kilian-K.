/*
 * Zone Presence Detection by Kilian K. — Dashboard-Karte & Seitenleisten-Panel
 *
 * Die Karte rechnet nichts selbst: Personen, Zonen-Belegung, Sitz-/Liege-Modus und
 * Geisterfilter kommen live aus der Integration (Websocket). Dadurch zeigt die Karte
 * exakt das, was auch die Binärsensoren sehen. Bearbeitungen (Räume, Zonen, Sensor-
 * Platzierung, Kalibrierung) gehen über die Websocket-API zurück an die Integration.
 */
(() => {
const VERSION = "1.0.0";
const DOMAIN = "zone_presence";
const SCALE = 100;            // SVG-Einheiten pro Meter
const MARGIN = 0.6;           // m Rand
const TAP_PX = 6;             // Pointer-Up bis hier = Tipp
const SNAP_M = 0.12;          // Raum-Zeichnen: Snap auf Nachbar-x/y
const GRID_M = 0.05;          // Raum-Zeichnen: Raster
const HIST_MAX = 5;           // Rückgängig/Wiederholen
const LIVE_THROTTLE = 80;     // ms für Live-Kalibrierung
const EXTRA_RESTORE = 1.0;    // m Extra-Punkte-Wiederherstellung
const ZONE_COLORS = ["#a78bfa", "#f472b6", "#34d399", "#fbbf24", "#60a5fa", "#fb7185", "#4ade80", "#c084fc"];
const NS = "http://www.w3.org/2000/svg";

const d2r = (d) => (d * Math.PI) / 180;
const r2d = (r) => (r * 180) / Math.PI;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const clone = (o) => JSON.parse(JSON.stringify(o));
const rid = (p) => p + Math.random().toString(36).slice(2, 10);
const round = (v, n = 3) => Math.round(v * 10 ** n) / 10 ** n;
function centroid(pts) { let x = 0, y = 0; for (const p of pts) { x += p[0]; y += p[1]; } return [x / pts.length, y / pts.length]; }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

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
  }

  /* ===================================================== Lebenszyklus */
  setConfig(config) {
    this._config = Object.assign({ title: "Präsenz-Zonen", lock_minutes: 30, merge_color: "#2dd4bf" }, config || {});
    try { this._showRaw = localStorage.getItem("zp_show_raw") === "1"; } catch (e) {}
    this._built = false;
    this._render();
  }
  static getStubConfig() { return { title: "Präsenz-Zonen" }; }
  getCardSize() { return 14; }
  getGridOptions() { return { columns: "full", min_rows: 8 }; }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._subscribe();   // Wiederholungen übernimmt der Watchdog
  }
  get hass() { return this._hass; }

  connectedCallback() {
    this._watch = setInterval(() => {
      if (this._hass && Date.now() - this._lastMsg > 7000) this._subscribe();
    }, 3000);
    if (this._hass && !this._unsubP) this._subscribe();
  }
  disconnectedCallback() {
    clearInterval(this._watch);
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
      this._error = (e && (e.message || e.code)) || "Verbindung fehlgeschlagen";
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
      if (!m.is_admin && this._mode !== "view") { this._mode = "view"; this._unlocked = false; }
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
    catch (e) { this._toast("Fehler: " + ((e && e.message) || e)); }
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
  _snap() { return JSON.stringify({ rooms: this._rooms, zones: this._zones, sensors: this._geometry(), active: this._activeRoom }); }
  _pushUndo() { this._undo.push(this._snap()); if (this._undo.length > HIST_MAX) this._undo.shift(); this._redo = []; this._updHist(); }
  _popNoop() { this._undo.pop(); this._updHist(); }
  _restore(str) {
    const s = JSON.parse(str);
    this._cfg.rooms = s.rooms; this._cfg.zones = s.zones;
    for (const sen of this._sensors) if (s.sensors[sen.id]) Object.assign(sen, s.sensors[sen.id]);
    if (s.rooms.find((r) => r.id === s.active)) this._activeRoom = s.active;
    this._apply({ rooms: s.rooms, zones: s.zones, sensors: s.sensors }, true);
    this._built = false; this._render();
  }
  _undoAct() { if (!this._undo.length) return; this._redo.push(this._snap()); if (this._redo.length > HIST_MAX) this._redo.shift(); this._restore(this._undo.pop()); this._toast("Rückgängig"); }
  _redoAct() { if (!this._redo.length) return; this._undo.push(this._snap()); if (this._undo.length > HIST_MAX) this._undo.shift(); this._restore(this._redo.pop()); this._toast("Wiederhergestellt"); }
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
      this.shadowRoot.innerHTML = `<style>${this._css()}</style><div class="zp"><div class="topbar"><div class="title">${esc(this._config.title)}</div></div>
        <div class="empty">${this._error ? "⚠ " + esc(this._error) + "<br><small>Ist die Integration „Zone Presence Detection“ eingerichtet?</small>" : "Verbinde …"}</div></div>`;
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
      mode: q(".mode-btn"), undo: q(".undo-btn"), redo: q(".redo-btn"), guide: q(".guide"), chip: q(".chip"),
    };
    this._personEls = new Map();
    this._wire();
    this._renderRoom();
    this._renderSensors();
    this._renderZones();
    this._renderGhosts();
    this._renderCtx();
    this._updHist();
    this._built = true;
    this._renderLive();
  }

  _html(b) {
    const admin = this._isAdmin();
    return `
    <div class="zp${this._guideOpen ? "" : " guide-collapsed"}" data-mode="${this._mode}">
      <div class="topbar">
        <div class="title">${esc(this._config.title)}</div>
        <span class="chip" hidden></span>
        <div class="spacer"></div>
        <button class="icon-btn raw-btn${this._showRaw ? " on" : ""}" title="Rohdaten & verworfene Geister anzeigen">◎</button>
        <button class="icon-btn undo-btn" title="Rückgängig" hidden>↶</button>
        <button class="icon-btn redo-btn" title="Wiederholen" hidden>↷</button>
        ${admin ? `<button class="mode-btn"><span class="dot"></span><span class="mt">${this._modeLabel()}</span></button>` : ""}
      </div>
      <div class="tabs">${this._tabsHtml()}</div>
      <div class="toolbar"${this._unlocked ? "" : " hidden"}>${this._toolbarHtml()}</div>
      <div class="ctxbar" hidden></div>
      <div class="body">
        <aside class="guide">
          <button class="guide-toggle" title="Hilfe">${this._guideOpen ? "⟨" : "?"}</button>
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
              ${this._fadeDefs(b)}
            </defs>
            <g id="room"></g>
            <g mask="url(#fadeMX)"><g mask="url(#fadeMY)"><g id="coverage"></g><g id="ghosts"></g></g></g>
            <g id="zones"></g>
            <g id="sensors"></g><g id="raw"></g><g id="persons"></g>
          </svg>
        </div>
      </div>
      <div class="panel" hidden></div>
      <div class="toast" hidden></div>
      <div class="pin-overlay" hidden>
        <div class="pin-box">
          <div class="pin-title">Code für Bearbeiten</div>
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

  _modeLabel() { return ({ view: "Ansicht", zones: "Zonen", sensors: "Sensoren", rooms: "Räume", "cal-sensor": "Kalibrieren", "cal-room": "Kalibrieren" })[this._mode] || "Ansicht"; }
  _tabsHtml() {
    const t = this._rooms.map((r) => `<button class="tab${r.id === this._activeRoom ? " active" : ""}" data-room="${esc(r.id)}">${esc(r.name)}<span class="tab-count" data-roomcount="${esc(r.id)}"></span></button>`).join("");
    const add = this._unlocked && this._mode === "rooms" ? `<button class="tab tab-add" data-addroom="1">＋ Raum</button>` : "";
    return t + add;
  }
  _toolbarHtml() {
    const seg = (m, l) => `<button class="seg${this._mode === m || (m === "cal" && this._mode.startsWith("cal")) ? " on" : ""}" data-mode="${m}">${l}</button>`;
    return `<div class="segs">${seg("view", "Ansicht")}${seg("zones", "Zonen")}${seg("sensors", "Sensoren")}${seg("rooms", "Räume")}${seg("cal", "Kalibrieren")}</div>
      <button class="link-btn" data-act="settings" title="Sensoren, Algorithmen, Zeiten">⚙ Einstellungen</button>`;
  }

  _renderCtx() {
    const bar = this._el.ctx;
    let h = "";
    if (this._unlocked) {
      if (this._mode === "zones") h = `<button class="ctx accent" data-act="addzone">＋ Zone</button><span class="hint">Ecke/Kante/Mitte ziehen · Mitte tippen = Extra-Punkte · Name tippen = Einstellungen</span>`;
      else if (this._mode === "sensors") h = `<span class="hint">Sensor ziehen = platzieren · Pfeil = drehen · Sensor tippen = Details & Offsets</span>`;
      else if (this._mode === "rooms") h = `<button class="ctx" data-act="renameroom">Raum umbenennen</button>${this._rooms.length > 1 ? `<button class="ctx danger" data-act="delroom">Raum löschen</button>` : ""}<span class="hint">Ecke/Kante ziehen · Mitte tippen = Punkt mehr · Snapping auf rechte Winkel</span>`;
      else if (this._mode.startsWith("cal")) {
        const opts = this._activeSensors().map((s) => `<option value="${esc(s.id)}"${s.id === this._calSid ? " selected" : ""}>${esc(s.label + " · " + s.name)}</option>`).join("");
        h = `<div class="segs small"><button class="seg${this._mode === "cal-sensor" ? " on" : ""}" data-calmode="cal-sensor">Einzelner Sensor</button><button class="seg${this._mode === "cal-room" ? " on" : ""}" data-calmode="cal-room">Ganzer Raum</button></div>
          ${this._mode === "cal-sensor" ? `<select class="ctx-sel" data-act="calpick">${opts}</select>` : ""}
          <button class="ctx accent" data-act="autocal">⚡ Sensoren abgleichen</button>
          <button class="ctx" data-act="${this._mode === "cal-sensor" ? "calreset" : "calresetroom"}">${this._mode === "cal-sensor" ? "Offset 0 (dieser)" : "Offsets 0 (Raum)"}</button>
          <button class="ctx danger" data-act="calresetall">⟲ Alle Kalibrierungen</button>
          <button class="ctx" data-act="learn">🧠 Lernkalibrierung jetzt</button>
          <span class="hint">${this._mode === "cal-sensor" ? "Roter Kegel: Kreis = x/y · Pfeil = drehen" : "Roter Kreis = ganzer Raum (nur x/y)"}</span>`;
      }
    }
    bar.innerHTML = h;
    bar.hidden = !h;
  }

  _renderRoom() {
    const poly = this._roomPoly();
    let extra = "";
    if (this._mode === "rooms" && this._unlocked) {
      poly.forEach((a, i) => {
        const bb = poly[(i + 1) % poly.length], m = this._px((a[0] + bb[0]) / 2, (a[1] + bb[1]) / 2);
        extra += `<circle class="room-edge" cx="${m[0]}" cy="${m[1]}" r="7" data-redge="${i}"/>`;
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
    const g = this._el.zones;
    g.innerHTML = "";
    this._zones.filter((z) => z.room === this._activeRoom).forEach((z) => {
      const grp = document.createElementNS(NS, "g");
      grp.setAttribute("class", "zone");
      grp.dataset.zone = z.id;
      grp.style.setProperty("--zc", z.color);
      g.appendChild(grp);
      this._renderZone(z, grp);
    });
  }
  _renderZone(z, grp) {
    grp = grp || this._el.zones.querySelector(`.zone[data-zone="${CSS.escape(z.id)}"]`);
    if (!grp) return;
    const edit = this._mode === "zones" && this._unlocked;
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
    if (cal.status === "running") { chip.hidden = false; chip.textContent = `🧠 Lernt … ${Math.round((cal.progress || 0) * 100)} %`; }
    else if (cal.status === "scheduled" && cal.next) { chip.hidden = false; chip.textContent = `🧠 Geplant ${new Date(cal.next).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`; }
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
    // Rohdaten / verworfene Geister
    if (this._showRaw) {
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
        h += `<g class="rej" transform="translate(${x} ${y})"><path d="M-7 -7 L7 7 M7 -7 L-7 7"/></g>`;
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
    this.shadowRoot.querySelector(".raw-btn").addEventListener("click", (ev) => {
      this._showRaw = !this._showRaw;
      ev.currentTarget.classList.toggle("on", this._showRaw);
      try { localStorage.setItem("zp_show_raw", this._showRaw ? "1" : "0"); } catch (x) {}
      this._renderLive();
    });
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
    e.svg.addEventListener("pointercancel", () => { this._drag = null; });
    e.zones.addEventListener("click", (ev) => this._zoneClick(ev));
    e.pin.querySelectorAll(".pin-pad button").forEach((btn) => btn.addEventListener("click", () => this._onPin(btn.dataset.k)));
  }

  _setMode(m) {
    this._mode = m;
    this._built = false;
    this._render();
  }

  _onCtx(ev) {
    const cm = ev.target.closest("[data-calmode]");
    if (cm && ev.type === "click") { if (cm.dataset.calmode === "cal-sensor" && !this._calSid) this._calSid = (this._activeSensors()[0] || {}).id || null; return this._setMode(cm.dataset.calmode); }
    const el = ev.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act;
    // Auswahlfeld nur beim Wechsel – ein Neuaufbau beim Klick würde das native Menü schließen
    if (act === "calpick") { if (ev.type !== "change") return; this._calSid = el.value; this._renderGhosts(); return; }
    if (ev.type !== "click") return;
    if (act === "addzone") this._addZone();
    else if (act === "renameroom") this._renameRoom();
    else if (act === "delroom") this._deleteRoom();
    else if (act === "autocal") this._autoCal();
    else if (act === "calreset") this._resetOffsets([this._calSid], "Offset zurückgesetzt");
    else if (act === "calresetroom") this._resetOffsets(this._activeSensors().map((s) => s.id), "Offsets des Raums zurückgesetzt");
    else if (act === "calresetall") { if (confirm("Alle Kalibrierungen (Offsets aller Sensoren) zurücksetzen?")) this._resetOffsets(this._sensors.map((s) => s.id), "Alle Kalibrierungen zurückgesetzt"); }
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
    const t = ev.target.closest("[data-corner],[data-edge],[data-move],[data-rcorner],[data-redge],[data-rmove],[data-smove],[data-srot],[data-gmove],[data-grot],[data-gmoveroom]");
    if (!t) return;
    let d = null;
    if (this._mode === "zones" && t.closest(".zone")) {
      const z = this._zones.find((zz) => zz.id === t.closest(".zone").dataset.zone);
      if (!z) return;
      if (t.dataset.corner != null) d = { kind: "zcorner", z, idx: +t.dataset.corner, orig: z.points[+t.dataset.corner].slice() };
      else if (t.dataset.edge != null) { const i = +t.dataset.edge, j = (i + 1) % z.points.length; d = { kind: "zedge", z, i, j, p0: z.points[i].slice(), p1: z.points[j].slice() }; }
      else if (t.dataset.move != null) d = { kind: "zmove", z, orig: clone(z.points) };
    } else if (this._mode === "rooms") {
      const room = this._room();
      if (t.dataset.rcorner != null) d = { kind: "rcorner", room, idx: +t.dataset.rcorner, orig: room.polygon[+t.dataset.rcorner].slice() };
      else if (t.dataset.redge != null) { const i = +t.dataset.redge, j = (i + 1) % room.polygon.length; d = { kind: "redge", room, i, j, p0: room.polygon[i].slice(), p1: room.polygon[j].slice() }; }
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
    ev.preventDefault();
  }

  _move(ev) {
    const d = this._drag;
    if (!d) return;
    const [sx, sy] = this._svgPt(ev);
    const cur = this._toRoom(sx, sy);
    const dx = cur[0] - d.start[0], dy = cur[1] - d.start[1];
    d.moved = Math.max(d.moved, Math.hypot(sx - d.startSvg[0], sy - d.startSvg[1]));
    if (d.moved < TAP_PX) return;
    const r3 = (p) => [round(p[0]), round(p[1])];
    switch (d.kind) {
      case "zcorner": d.z.points[d.idx] = r3([d.orig[0] + dx, d.orig[1] + dy]); this._renderZone(d.z); break;
      case "zedge": d.z.points[d.i] = r3([d.p0[0] + dx, d.p0[1] + dy]); d.z.points[d.j] = r3([d.p1[0] + dx, d.p1[1] + dy]); this._renderZone(d.z); break;
      case "zmove": d.z.points = d.orig.map((p) => r3([p[0] + dx, p[1] + dy])); this._renderZone(d.z); break;
      case "rcorner": d.room.polygon[d.idx] = this._snapPoint(d.room, d.idx, [d.orig[0] + dx, d.orig[1] + dy]); this._renderRoom(); break;
      case "redge": d.room.polygon[d.i] = r3([d.p0[0] + dx, d.p0[1] + dy]); d.room.polygon[d.j] = r3([d.p1[0] + dx, d.p1[1] + dy]); this._renderRoom(); break;
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
    try { this._el.svg.releasePointerCapture(ev.pointerId); } catch (x) {}
    const tap = d.moved < TAP_PX;
    if (tap && d.kind === "zmove") { this._toggleExtra(d.z); return this._afterDrag(); }
    if (tap && d.kind === "rmove") { this._addRoomPoint(d.room); return this._afterDrag(); }
    if (tap) {
      this._popNoop();
      this._afterDrag();
      // Pointer-Capture leitet den Klick auf das SVG um -> Panel direkt hier öffnen
      if (d.kind === "smove") this._openSensorPanel(this._sensor(d.s.id) || d.s);
      return;
    }
    this._flushLive();
    if (d.kind[0] === "z") this._apply({ zones: this._zones });
    else if (d.kind[0] === "r") this._apply({ rooms: this._rooms });
    else this._apply({ sensors: this._geometry() });
    this._afterDrag();
  }
  _afterDrag() { if (this._pendingRebuild) { this._pendingRebuild = false; this._built = false; this._render(); } }

  _snapPoint(room, idx, p) {
    const n = room.polygon.length, prev = room.polygon[(idx - 1 + n) % n], next = room.polygon[(idx + 1) % n];
    let [x, y] = p;
    for (const nb of [prev, next]) { if (Math.abs(x - nb[0]) < SNAP_M) x = nb[0]; if (Math.abs(y - nb[1]) < SNAP_M) y = nb[1]; }
    room.polygon.forEach((q, i) => { if (i === idx) return; if (Math.abs(x - q[0]) < SNAP_M) x = q[0]; if (Math.abs(y - q[1]) < SNAP_M) y = q[1]; });
    return [round(Math.round(x / GRID_M) * GRID_M), round(Math.round(y / GRID_M) * GRID_M)];
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
    this._apply({ zones: this._zones });
  }
  _addZone() {
    this._pushUndo();
    const c = centroid(this._roomPoly()), h = 0.75;
    const used = new Set(this._zones.map((z) => z.color));
    const z = {
      id: rid("z"), room: this._activeRoom, name: "Neue Zone", enabled: true, extra: [], off_delay: null,
      color: ZONE_COLORS.find((col) => !used.has(col)) || ZONE_COLORS[this._zones.length % ZONE_COLORS.length],
      points: [[c[0] - h, c[1] - h], [c[0] + h, c[1] - h], [c[0] + h, c[1] + h], [c[0] - h, c[1] + h]].map((p) => [round(p[0]), round(p[1])]),
    };
    this._cfg.zones = this._zones.concat([z]);
    this._renderZones();
    this._apply({ zones: this._zones });
  }
  _deleteZone(z) {
    if (!confirm(`Zone „${z.name}“ löschen? Ihr Binärsensor und ihre Personenanzahl werden entfernt.`)) return;
    this._pushUndo();
    this._cfg.zones = this._zones.filter((x) => x.id !== z.id);
    this._renderZones();
    this._apply({ zones: this._zones });
  }
  _zoneClick(ev) {
    if (this._mode !== "zones" || !this._unlocked) return;
    const grp = ev.target.closest(".zone"); if (!grp) return;
    const z = this._zones.find((x) => x.id === grp.dataset.zone); if (!z) return;
    if (ev.target.closest(".tag-del")) return this._deleteZone(z);
    if (ev.target.closest(".tag-text,.tag-bg")) this._openZonePanel(z);
  }
  _openZonePanel(z) {
    const s = (this._cfg && this._cfg.settings) || {};
    this._panel(`Zone ${z.num ? z.num : ""} · ${esc(z.name)}`, `
      <div class="p-grid">
        ${this._field("Name", "name", z.name)}
        ${this._field("Farbe", "color", z.color, "color")}
        ${this._field(`Nachlaufzeit (s) – leer = Standard ${s.off_delay ?? 10} s`, "off_delay", z.off_delay ?? "", "number")}
        <label class="p-row p-check"><input type="checkbox" data-p="enabled"${z.enabled === false ? "" : " checked"}><span>Zone aktiv</span></label>
      </div>
      <div class="p-note">Der Binärsensor heißt automatisch „${esc(z.name)} (Zone ${z.num || "?"})“, dazu gibt es „Personenanzahl“.</div>`,
    (get) => {
      this._pushUndo();
      z.name = (get("name") || z.name).slice(0, 40);
      z.color = get("color") || z.color;
      const od = get("off_delay");
      z.off_delay = od === "" ? null : Math.max(0, Number(od) || 0);
      z.enabled = this._el.panel.querySelector('[data-p="enabled"]').checked;
      this._renderZone(z);
      this._apply({ zones: this._zones });
    });
  }

  /* ----- Räume ----- */
  _addRoom() {
    this._pushUndo();
    const room = { id: rid("r"), name: "Raum " + (this._rooms.length + 1), polygon: [[0, 0], [4, 0], [4, 3], [0, 3]] };
    this._cfg.rooms = this._rooms.concat([room]);
    this._activeRoom = room.id;
    this._apply({ rooms: this._rooms });
    this._built = false; this._render();
  }
  _renameRoom() {
    const r = this._room(); if (!r) return;
    const name = prompt("Raumname:", r.name);
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
    if (!confirm(`Raum „${r.name}“ löschen?${nz ? ` Seine ${nz} Zone(n) werden ebenfalls gelöscht.` : ""}`)) return;
    this._pushUndo();
    this._cfg.rooms = this._rooms.filter((x) => x.id !== r.id);
    this._cfg.zones = this._zones.filter((z) => z.room !== r.id);
    this._activeRoom = this._rooms[0].id;
    this._apply({ rooms: this._rooms, zones: this._zones });
    this._built = false; this._render();
  }
  _addRoomPoint(room) {
    const e = this._edges(room.polygon).sort((a, b) => b.len - a.len)[0];
    room.polygon.splice(e.i + 1, 0, [round(e.mid[0]), round(e.mid[1])]);
    this._renderRoom();
    this._apply({ rooms: this._rooms });
    this._toast("Punkt hinzugefügt");
  }

  /* ----- Sensoren ----- */
  _openSensorPanel(s) {
    const o = this._off(s), ents = s.entities || {};
    const roomOpts = this._rooms.map((r) => `<option value="${esc(r.id)}"${r.id === s.room ? " selected" : ""}>${esc(r.name)}</option>`).join("");
    const entList = (ents.targets || []).map((t, i) => `<div class="p-ent"><b>Target ${i + 1}</b><code>${esc(t.x)}</code><code>${esc(t.y)}</code></div>`).join("")
      + `<div class="p-ent"><b>Presence</b><code>${esc(ents.presence || "– (optional, nicht gesetzt)")}</code></div>`;
    this._panel(`${esc(s.label)} · ${esc(s.name)}`, `
      <div class="p-grid">
        ${this._field("Name", "name", s.name)}${this._field("Kürzel", "label", s.label)}
        ${this._field("Farbe", "color", s.color, "color")}
        <label class="p-row"><span>Raum</span><select data-p="room">${roomOpts}</select></label>
        ${this._field("Reichweite (m)", "range", s.range, "number")}${this._field("Halbwinkel (°)", "half_angle", s.half_angle, "number")}
      </div>
      <div class="p-sub">Platzierung</div>
      <div class="p-grid">
        ${this._field("Pos X (m)", "px", this._basePos(s)[0], "number")}${this._field("Pos Y (m)", "py", this._basePos(s)[1], "number")}
        ${this._field("Rotation (°)", "rot", this._baseRot(s), "number")}
        <label class="p-row p-check"><input type="checkbox" data-p="flip_x"${s.flip_x < 0 ? " checked" : ""}><span>X-Achse spiegeln</span></label>
      </div>
      <div class="p-sub">Kalibrier-Offset</div>
      <div class="p-grid">
        ${this._field("Offset X (m)", "dx", o.dx || 0, "number")}${this._field("Offset Y (m)", "dy", o.dy || 0, "number")}
        ${this._field("Offset Rotation (°)", "dr", o.dr || 0, "number")}
      </div>
      <div class="p-sub">Entitäten</div>${entList}
      <div class="p-note">Entitäten änderst du unter <a href="#" data-act="settings">Einstellungen → Konfigurieren → Sensor-Entitäten bearbeiten</a>.</div>`,
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
      if (res.ok) this._toast(`Abgeglichen: ${Object.keys(res.sensors).length} Sensoren auf einen Punkt`);
      else { this._popNoop(); this._toast(res.error === "need_two" ? "Mindestens 2 Sensoren müssen dieselbe Person sehen." : "Messpunkte liegen zu weit auseinander – nur eine Person in den Überlappungsbereich stellen."); }
    } catch (e) { this._popNoop(); this._toast("Fehler: " + ((e && e.message) || e)); }
  }
  async _startLearning() {
    const mins = (this._cfg.controls && this._cfg.controls.cal_duration) || 120;
    if (!confirm(`Lernkalibrierung jetzt für ${mins} Minuten starten?\n\nWährenddessen sollten die Räume leer sein. Geplant (z. B. nachts um 3 Uhr) geht es über die Entitäten „Startzeit Lernkalibrierung“ und „Lernkalibrierung geplant“.`)) return;
    try { await this._ws({ type: `${DOMAIN}/calibration`, action: "start" }); this._toast("Lernkalibrierung gestartet"); }
    catch (e) { this._toast("Fehler: " + ((e && e.message) || e)); }
  }
  _openSettings() {
    history.pushState(null, "", `/config/integrations/integration/${DOMAIN}`);
    window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace: false } }));
  }

  /* ----- Panel/Formulare ----- */
  _field(label, key, value, type = "text") {
    return `<label class="p-row"><span>${label}</span><input data-p="${key}" type="${type}" ${type === "number" ? 'step="any"' : ""} value="${esc(value)}"></label>`;
  }
  _panel(title, body, onSave) {
    const p = this._el.panel;
    p.innerHTML = `<div class="p-box"><div class="p-head"><span>${title}</span><button class="p-close">✕</button></div>
      <div class="p-scroll">${body}</div><div class="p-foot"><button class="p-save">Übernehmen</button></div></div>`;
    p.hidden = false;
    const get = (k) => { const el = p.querySelector(`[data-p="${k}"]`); return el ? String(el.value).trim() : ""; };
    p.querySelector(".p-close").addEventListener("click", () => { p.hidden = true; });
    p.addEventListener("click", (ev) => { if (ev.target === p) p.hidden = true; }, { once: true });
    p.querySelector(".p-save").addEventListener("click", () => { onSave(get); p.hidden = true; this._toast("Übernommen"); });
  }

  /* ----- PIN ----- */
  _lockKey() { return "zp_lock"; }
  _lock() { try { return JSON.parse(localStorage.getItem(this._lockKey())) || { fails: 0, until: 0 }; } catch (e) { return { fails: 0, until: 0 }; } }
  _setLock(s) { try { localStorage.setItem(this._lockKey(), JSON.stringify(s)); } catch (e) {} }
  _fmt(t) { return new Date(t).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }); }
  _requestUnlock(then) {
    if (!this._isAdmin()) return this._toast("Bearbeiten ist nur für Administratoren möglich.");
    if (!this._pin()) { this._unlocked = true; then(); return; }
    this._pinThen = then;
    const lock = this._lock(), p = this._el.pin;
    p.hidden = false;
    if (lock.until > Date.now()) this._pinSub("Gesperrt bis " + this._fmt(lock.until) + " Uhr");
    else { this._pinBuffer = ""; this._dots(); this._pinSub(lock.fails > 0 ? `Falscher Code – noch ${3 - lock.fails} Versuche` : "4-stelligen Code eingeben"); }
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
    if (lock.fails >= 3) { lock.until = Date.now() + (Number(this._config.lock_minutes) || 30) * 60000; lock.fails = 0; this._pinSub("Gesperrt bis " + this._fmt(lock.until) + " Uhr"); }
    else this._pinSub(`Falscher Code – noch ${3 - lock.fails} Versuche`);
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
    return `<div class="guide-head">Bedienung</div><div class="guide-body">
      <p><b>Tabs:</b> Räume wechseln (Zahl = Personen im Raum).</p>
      <p><b>◎</b> zeigt Rohdaten: unbestätigte Detektionen (gestrichelt, mit Konfidenz) und verworfene Geister (✕).</p>
      <p><b>Bearbeiten</b> → PIN → Leiste. <b>↶/↷</b> = letzte 5 Aktionen.</p>
      <ul>
        <li><b>Zonen:</b> Ecke/Kante/Mitte ziehen, Mitte tippen = Extra-Punkte, Name tippen = Name, Farbe, eigene Nachlaufzeit.</li>
        <li><b>Sensoren:</b> ziehen = platzieren, Pfeil = drehen, tippen = Details & Offsets.</li>
        <li><b>Räume:</b> Ecken/Kanten ziehen (Snapping), Mitte tippen = Punkt mehr, ＋ Raum.</li>
        <li><b>Kalibrieren:</b> roter Kegel = korrigierter Bereich. Einzeln: verschieben + drehen. Raum: nur verschieben. <b>⚡</b> gleicht Sensoren über eine Person ab.</li>
        <li><b>🧠 Lernkalibrierung:</b> lernt bei leerem Raum die Geisterstellen. Planbar über die Hub-Entitäten.</li>
      </ul></div>`;
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
    /* nur die Ebene des aktiven Modus nimmt Klicks an – nichts verdeckt die Griffe */
    #persons, #raw, #coverage{ pointer-events:none; }
    .zp:not([data-mode="zones"]) #zones, .zp:not([data-mode="sensors"]) #sensors{ pointer-events:none; }
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
    @media (max-width:760px){
      .body{ flex-direction:column; }
      .guide{ width:auto; flex-basis:auto; order:2; }
      .guide-inner{ width:auto; }
      :host{ --zp-maxh:62vh; }
      .stage-wrap{ order:1; }
      .zp.guide-collapsed .guide{ width:auto; flex-basis:auto; min-height:46px; }
      .zp.guide-collapsed .guide-inner{ height:0; padding:0; opacity:0; }
      .zp.guide-collapsed .guide::before{ content:"Bedienung"; position:absolute; left:16px; top:14px; font-size:13px; color:var(--c-muted); }
      .p-grid{ grid-template-columns:1fr; }
      .topbar, .tabs, .toolbar, .ctxbar{ padding-left:14px; padding-right:14px; }
    }`;
  }
}

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
    this._card.setConfig({ entry_id: cfg.entry_id, title: (this._panel && this._panel.title) || "Präsenz-Zonen" });
    if (this._hass) this._card.hass = this._hass;
    body.appendChild(this._card);
    this.append(style, head, body);
  }
}

if (!customElements.get("zone-presence-card")) customElements.define("zone-presence-card", ZonePresenceCard);
if (!customElements.get("zone-presence-panel")) customElements.define("zone-presence-panel", ZonePresencePanel);
window.customCards = window.customCards || [];
if (!window.customCards.find((c) => c.type === "zone-presence-card")) {
  window.customCards.push({ type: "zone-presence-card", name: "Zone Presence Detection", description: "Live-Grundriss mit Zonen, Personen und Kalibrierung (Zone Presence Detection by Kilian K.)", preview: false });
}
console.info("%c Zone Presence Detection %c " + VERSION + " ", "background:#2dd4bf;color:#04110f;border-radius:4px 0 0 4px", "background:#0f2227;color:#2dd4bf;border-radius:0 4px 4px 0");
})();
