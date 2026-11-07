// Browser-Test der Karte mit simuliertem Backend (Playwright/Chromium).
// Aufruf: node tests/browser/run.js <ausgabe-ordner>
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const OUT = process.argv[2] || path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });
const BASE = "file://" + path.join(__dirname, "harness.html");
const URL = BASE + "?lang=de";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log("  ok  ", name); } else { fail++; console.log("  FAIL", name, extra); } };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(URL);
  await page.waitForTimeout(600);

  const ws = () => page.evaluate(() => window.__ws);
  const lastApply = async (filter = () => true) => (await ws()).filter((m) => m.type === "zone_presence/apply").filter(filter).pop();
  const center = async (sel) => { const b = await page.locator(sel).first().boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
  const drag = async (sel, dx, dy) => {
    const [x, y] = await center(sel);
    await page.mouse.move(x, y); await page.mouse.down();
    for (let i = 1; i <= 8; i++) { await page.mouse.move(x + (dx * i) / 8, y + (dy * i) / 8); await page.waitForTimeout(20); }
    await page.mouse.up(); await page.waitForTimeout(150);
  };
  const tap = async (sel) => { const [x, y] = await center(sel); await page.mouse.click(x, y); await page.waitForTimeout(150); };

  console.log("Ansicht");
  ok("abonniert", (await ws())[0].type === "zone_presence/subscribe");
  ok("2 Personen gerendert", (await page.locator(".person").count()) === 2);
  ok("Sofa belegt (sitzende Person)", (await page.locator('.zone[data-zone="z1"].occupied').count()) === 1);
  ok("Personenzahl am Sofa", (await page.locator('.zone[data-zone="z1"] .tag-count-t').textContent()) === "1");
  ok("Sitzende Person markiert", (await page.locator(".person.still").count()) === 1);
  ok("Raum-Zähler im Tab", (await page.locator('[data-roomcount="r1"]').textContent()) === "2");
  ok("Lern-Chip sichtbar", /Lernt/.test(await page.locator(".chip").textContent()));
  ok("Kegel 2x", (await page.locator(".cov").count()) === 2);
  await page.screenshot({ path: path.join(OUT, "01_ansicht.png") });

  console.log("PIN");
  await page.locator(".mode-btn").click();
  ok("PIN-Overlay offen", await page.locator(".pin-overlay").isVisible());
  for (const k of ["1", "2", "3", "4"]) await page.locator(`.pin-pad button[data-k="${k}"]`).click();
  await page.waitForTimeout(300);
  ok("PIN akzeptiert", !(await page.locator(".pin-overlay").isVisible()));
  ok("Zonen-Modus", (await page.locator(".zp").getAttribute("data-mode")) === "zones");
  ok("Undo/Redo sichtbar", await page.locator(".undo-btn").isVisible());
  await page.screenshot({ path: path.join(OUT, "02_zonen.png") });

  console.log("Zonen");
  await page.locator('.zone[data-zone="z3"] .tag-text').click();
  ok("Zonen-Panel offen", await page.locator(".panel .p-box").isVisible());
  await page.screenshot({ path: path.join(OUT, "03_zonenpanel.png") });
  await page.locator('.panel [data-p="off_delay"]').fill("30");
  await page.locator('.panel [data-p="name"]').fill("Esstisch groß");
  await page.locator(".panel .p-save").click();
  await page.waitForTimeout(200);
  let a = await lastApply((m) => m.zones);
  const z3 = a.zones.find((z) => z.id === "z3");
  ok("Off-Zeit je Zone gesendet", z3.off_delay === 30 && z3.name === "Esstisch groß", JSON.stringify(z3));

  const before = JSON.stringify((await lastApply((m) => m.zones)).zones.find((z) => z.id === "z1").points);
  await drag('.zone[data-zone="z1"] [data-corner="0"]', 40, 30);
  a = await lastApply((m) => m.zones);
  ok("Ecke ziehen speichert", JSON.stringify(a.zones.find((z) => z.id === "z1").points) !== before && a.persist === true);
  await page.locator(".undo-btn").click(); await page.waitForTimeout(200);
  a = await lastApply((m) => m.zones);
  ok("Rückgängig stellt wieder her", JSON.stringify(a.zones.find((z) => z.id === "z1").points) === before);
  await page.locator(".redo-btn").click(); await page.waitForTimeout(200);
  a = await lastApply((m) => m.zones);
  ok("Wiederholen", JSON.stringify(a.zones.find((z) => z.id === "z1").points) !== before);

  await tap('.zone[data-zone="z1"] [data-move]');
  a = await lastApply((m) => m.zones);
  ok("Mitte tippen = Extra-Punkte", (a.zones.find((z) => z.id === "z1").extra || []).length === 2, JSON.stringify(a.zones.find((z) => z.id === "z1")));
  await page.locator('[data-act="addzone"]').click(); await page.waitForTimeout(200);
  a = await lastApply((m) => m.zones);
  ok("＋ Zone", a.zones.length === 3 && a.zones[2].name === "Neue Zone");
  ok("Neue Zone gezeichnet", (await page.locator(".zone").count()) === 3);

  console.log("Räume");
  await page.locator('.seg[data-mode="rooms"]').click(); await page.waitForTimeout(200);
  await tap("[data-rmove]");
  a = await lastApply((m) => m.rooms);
  ok("Mitte tippen = Punkt mehr", a.rooms.find((r) => r.id === "r1").polygon.length === 7);
  await drag('[data-rcorner="2"]', 9, 7);
  a = await lastApply((m) => m.rooms);
  const poly = a.rooms.find((r) => r.id === "r1").polygon;
  ok("Snapping auf Raster", poly.every((p) => p.every((v) => Math.abs(v * 20 - Math.round(v * 20)) < 1e-6)), JSON.stringify(poly));
  await page.locator('[data-act="renameroom"]').click(); await page.waitForTimeout(200);
  a = await lastApply((m) => m.rooms);
  ok("Raum umbenennen", a.rooms.find((r) => r.id === "r1").name === "Wohnzimmer neu");
  await page.locator('[data-addroom]').click(); await page.waitForTimeout(250);
  a = await lastApply((m) => m.rooms);
  ok("＋ Raum (neuer Tab)", a.rooms.length === 3 && (await page.locator(".tab").count()) >= 3);
  await page.screenshot({ path: path.join(OUT, "04_raeume.png") });
  await page.locator('.tab[data-room="r1"]').click(); await page.waitForTimeout(200);

  console.log("Sensoren");
  await page.locator('.seg[data-mode="sensors"]').click(); await page.waitForTimeout(200);
  const nBefore = (await ws()).length;
  await drag('[data-smove="s1"]', 30, 0);
  const msgs = (await ws()).slice(nBefore).filter((m) => m.type === "zone_presence/apply");
  ok("Live-Vorschau beim Ziehen (persist:false)", msgs.some((m) => m.persist === false));
  ok("Speichern beim Loslassen (persist:true)", msgs.some((m) => m.persist === true && m.sensors && m.sensors.s1));
  await tap('[data-smove="s2"]');
  ok("Sensor tippen öffnet Panel", await page.locator(".panel .p-box").isVisible());
  ok("Entitäten angezeigt", (await page.locator(".panel .p-ent code").first().textContent()).includes("sensor.wz_target1_x"));
  await page.screenshot({ path: path.join(OUT, "05_sensorpanel.png") });
  await page.locator(".panel .p-close").click();

  console.log("Kalibrieren");
  await page.locator('.seg[data-mode="cal"]').click(); await page.waitForTimeout(200);
  ok("Einzel-Geisterkegel", (await page.locator(".ghost-cone").count()) === 1);
  await page.locator('[data-act="calpick"]').selectOption("s2"); await page.waitForTimeout(250);
  ok("Sensorauswahl bleibt (kein Neuaufbau)", (await page.locator('[data-act="calpick"]').inputValue()) === "s2");
  const n2 = (await ws()).length;
  await drag('[data-gmove="s2"]', 25, 15);
  const cm = (await ws()).slice(n2).filter((m) => m.type === "zone_presence/apply");
  ok("Kegel verschieben: live + gespeichert", cm.some((m) => m.persist === false) && cm.some((m) => m.persist && m.sensors.s2.offset.dx !== 0));
  await drag('[data-grot="s2"]', 40, 0);
  a = await lastApply((m) => m.sensors);
  ok("Kegel drehen ändert dr", a.sensors.s2.offset.dr !== 0, JSON.stringify(a.sensors.s2.offset));
  await page.screenshot({ path: path.join(OUT, "06_kal_einzel.png") });
  await page.locator('[data-calmode="cal-room"]').click(); await page.waitForTimeout(200);
  ok("Raum-Modus: 2 Geisterkegel", (await page.locator(".ghost-cone").count()) === 2);
  const offs = (await lastApply((m) => m.sensors)).sensors;
  await drag("[data-gmoveroom]", -20, 10);
  a = await lastApply((m) => m.sensors);
  ok("Raum verschieben: beide Offsets geändert", a.sensors.s1.offset.dx !== offs.s1.offset.dx && a.sensors.s2.offset.dx !== offs.s2.offset.dx);
  await page.screenshot({ path: path.join(OUT, "07_kal_raum.png") });
  await page.locator('[data-act="autocal"]').click(); await page.waitForTimeout(250);
  ok("Auto-Abgleich aufgerufen", (await ws()).some((m) => m.type === "zone_presence/auto_calibrate" && m.room_id === "r1"));
  ok("Toast", /Abgeglichen/.test(await page.locator(".toast").textContent()));
  await page.locator('[data-act="calresetall"]').click(); await page.waitForTimeout(200);
  a = await lastApply((m) => m.sensors);
  ok("Alle Kalibrierungen zurückgesetzt", Object.values(a.sensors).every((g) => g.offset.dx === 0 && g.offset.dy === 0 && g.offset.dr === 0));
  await page.locator('[data-act="learn"]').click(); await page.waitForTimeout(200);
  ok("Lernkalibrierung gestartet", (await ws()).some((m) => m.type === "zone_presence/calibration" && m.action === "start"));

  console.log("Rohdaten");
  await page.locator(".raw-btn").click(); await page.waitForTimeout(250);
  ok("Kandidaten + verworfene Geister", (await page.locator(".cand").count()) === 1 && (await page.locator(".rej").count()) === 2);
  await page.locator('.seg[data-mode="view"]').click(); await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, "08_rohdaten.png") });

  console.log("Smartphone + Panel");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  ok("kein horizontales Scrollen (mobil)", !overflow);
  await page.screenshot({ path: path.join(OUT, "09_mobil.png"), fullPage: true });
  await page.evaluate(() => window.__setPanel());
  await page.waitForTimeout(600);
  ok("Panel rendert Karte", (await page.locator("zone-presence-panel zone-presence-card .person").count()) === 2);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, "10_panel.png") });

  console.log("Sprache");
  const txt = async (p, sel) => (await p.locator(sel).first().textContent()).trim();
  const en = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  en.on("pageerror", (e) => errors.push(String(e)));
  await en.goto(BASE); await en.waitForTimeout(600);
  ok("Standard Englisch: Titel", (await txt(en, ".title")) === "Zone Presence");
  ok("Englisch: Lern-Chip", /Learning/.test(await txt(en, ".chip")));
  ok("Englisch: Bedienhilfe", (await txt(en, ".guide-head")) === "How to use");
  ok("Englisch: Modus-Knopf", (await txt(en, ".mode-btn .mt")) === "View");
  await en.locator(".mode-btn").click();
  ok("Englisch: PIN-Dialog", (await txt(en, ".pin-title")) === "Edit code" && /Enter 4-digit/.test(await txt(en, ".pin-sub")));
  for (const k of ["1", "2", "3", "4"]) await en.locator(`.pin-pad button[data-k="${k}"]`).click();
  await en.waitForTimeout(300);
  await en.locator('[data-act="addzone"]').click(); await en.waitForTimeout(200);
  const enApply = (await en.evaluate(() => window.__ws)).filter((m) => m.type === "zone_presence/apply" && m.zones).pop();
  ok("Englisch: neue Zone heißt „New zone“", enApply.zones[enApply.zones.length - 1].name === "New zone");
  ok("Englisch: Werkzeugleiste", (await txt(en, '.seg[data-mode="cal"]')) === "Calibrate");
  await en.screenshot({ path: path.join(OUT, "11_english.png") });
  await en.goto(BASE + "?lang=de"); await en.waitForTimeout(600);
  ok("Deutsch per Integration: Titel", (await txt(en, ".title")) === "Präsenz-Zonen");
  ok("Deutsch per Integration: Hilfe", (await txt(en, ".guide-head")) === "Bedienung");
  await en.goto(BASE + "?ulang=de"); await en.waitForTimeout(600);
  ok("Benutzersprache Deutsch -> Karte deutsch", (await txt(en, ".title")) === "Präsenz-Zonen");
  await en.goto(BASE + "?ulang=de-CH"); await en.waitForTimeout(600);
  ok("Benutzersprache de-CH -> deutsch", (await txt(en, ".guide-head")) === "Bedienung");
  await en.goto(BASE + "?lang=de&ulang=fr"); await en.waitForTimeout(600);
  ok("Benutzersprache Französisch -> Englisch", (await txt(en, ".title")) === "Zone Presence");
  await en.goto(BASE + "?lang=de&ulang=en"); await en.waitForTimeout(600);
  ok("Benutzersprache hat Vorrang vor Systemsprache", (await txt(en, ".title")) === "Zone Presence");
  await en.goto(BASE + "?lang=de"); await en.waitForTimeout(600);
  await en.evaluate(() => window.__setPanel()); await en.waitForTimeout(600);
  ok("Panel ohne Titel: Standardtitel der Sprache", (await txt(en, "zone-presence-panel .title")) === "Präsenz-Zonen");
  await en.close();

  // ------------------------------------------------------------------ Rechte
  console.log("Rechte");
  const rp = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  rp.on("pageerror", (e) => errors.push(String(e)));
  await rp.goto(BASE + "?admin=0"); await rp.waitForTimeout(600);
  ok("Nicht-Admin ohne Freigabe: kein Bearbeiten-Knopf", (await rp.locator(".mode-btn").count()) === 0);
  await rp.goto(BASE + "?admin=0&canedit=1"); await rp.waitForTimeout(600);
  ok("Nicht-Admin mit Freigabe: Bearbeiten-Knopf da", (await rp.locator(".mode-btn").count()) === 1);
  await rp.locator(".mode-btn").click();
  for (const k of ["1", "2", "3", "4"]) await rp.locator(`.pin-pad button[data-k="${k}"]`).click();
  await rp.waitForTimeout(300);
  ok("Nicht-Admin: PIN nötig und Bearbeiten möglich", (await rp.locator(".zp").getAttribute("data-mode")) === "zones");
  ok("Nicht-Admin: kein Einstellungen-Link", (await rp.locator('.toolbar [data-act="settings"]').count()) === 0);
  await rp.close();

  // ------------------------------------------------------------------ Einrasten
  console.log("Einrasten");
  const sp = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  sp.on("pageerror", (e) => errors.push(String(e)));
  const open = async (q = "?lang=de") => {
    await sp.goto(BASE + q); await sp.waitForTimeout(600);
    await sp.locator(".mode-btn").click();
    for (const k of ["1", "2", "3", "4"]) await sp.locator(`.pin-pad button[data-k="${k}"]`).click();
    await sp.waitForTimeout(300);
  };
  const scr = (x, y) => sp.evaluate(([a, b]) => window.__scr(a, b), [x, y]);
  const handle = async (sel) => { const b = await sp.locator(sel).first().boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
  // Ziehen von einem Griff so, dass der Raumpunkt "from" bei "to" landet
  const dragPt = async (sel, from, to, opts = {}) => {
    const [hx, hy] = await handle(sel), A = await scr(...from), B = await scr(...to);
    const tx = hx + (B[0] - A[0]), ty = hy + (B[1] - A[1]);
    await sp.mouse.move(hx, hy); await sp.mouse.down();
    if (opts.shift) await sp.keyboard.down("Shift");
    for (let i = 1; i <= 10; i++) { await sp.mouse.move(hx + ((tx - hx) * i) / 10, hy + ((ty - hy) * i) / 10); await sp.waitForTimeout(15); }
    const guides = await sp.evaluate(() => window.__card.shadowRoot.querySelectorAll("#guides > *").length);
    await sp.mouse.up();
    if (opts.shift) await sp.keyboard.up("Shift");
    await sp.waitForTimeout(150);
    return guides;
  };
  const zoneOf = (id) => sp.evaluate((z) => window.__card._zones.find((x) => x.id === z).points, id);
  const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

  await open();
  let g = await dragPt('.zone[data-zone="z1"] [data-corner="1"]', [6.6, 1.8], [6.93, 1.84]);
  let pts = await zoneOf("z1");
  ok("Zonenecke rastet an Wand + bleibt parallel (7 | 1.8)", near(pts[1][0], 7) && near(pts[1][1], 1.8), JSON.stringify(pts[1]));
  ok("Hilfslinien beim Ziehen sichtbar", g > 0, String(g));
  ok("Hilfslinien nach dem Loslassen weg", (await sp.evaluate(() => window.__card.shadowRoot.querySelectorAll("#guides > *").length)) === 0);
  await sp.screenshot({ path: path.join(OUT, "12_einrasten.png") });

  await open();
  await dragPt('.zone[data-zone="z1"] [data-corner="1"]', [6.6, 1.8], [6.93, 1.84], { shift: true });
  pts = await zoneOf("z1");
  ok("Shift: kein Einrasten", !near(pts[1][0], 7, 0.005) && near(pts[1][0], 6.93, 0.03) && near(pts[1][1], 1.84, 0.03), JSON.stringify(pts[1]));

  await open();
  await dragPt('.zone[data-zone="z3"] [data-move]', [0.6, 1.2], [0.05, 0.06]);
  pts = await zoneOf("z3");
  ok("Zone rastet in die Raumecke (0 | 0)", near(pts[0][0], 0) && near(pts[0][1], 0), JSON.stringify(pts[0]));
  ok("Zone behält Form beim Einrasten", near(pts[2][0] - pts[0][0], 2.2, 1e-3) && near(pts[2][1] - pts[0][1], 2.2, 1e-3), JSON.stringify(pts));

  await open();
  await dragPt('.zone[data-zone="z3"] [data-corner="2"]', [2.8, 3.4], [2.86, 3.45]);
  pts = await zoneOf("z3");
  ok("Freie Ecke: rechter Winkel zu beiden Nachbarn", near(pts[2][0], 2.8) && near(pts[2][1], 3.4), JSON.stringify(pts[2]));

  await open();
  await sp.locator('.seg[data-mode="rooms"]').click(); await sp.waitForTimeout(200);
  await dragPt('[data-rcorner="3"]', [3.45, 4], [3.7, 4.05]);
  const rp3 = await sp.evaluate(() => window.__card._room().polygon[3]);
  ok("Raumecke: Wand bleibt waagrecht, x im Raster", near(rp3[1], 4) && near(rp3[0], 3.7), JSON.stringify(rp3));
  await sp.close();

  // ------------------------------------------------------------------ Raum-Karte
  console.log("Raum-Karte");
  const rc = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  rc.on("pageerror", (e) => errors.push(String(e)));
  rc.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await rc.goto(BASE + "?lang=de"); await rc.waitForTimeout(400);
  await rc.evaluate(() => window.__mountRoom({ room: "Wohn-/Esszimmer" }, 640, 300)); await rc.waitForTimeout(600);
  const inRoom = (sel) => rc.evaluate((s) => { const r = window.__room.shadowRoot.querySelector(s); return r ? getComputedStyle(r).display !== "none" && r.getBoundingClientRect().height > 0 : false; }, sel);
  ok("Raum-Karte: nur Grundriss (keine Leisten)", !(await inRoom(".topbar")) && !(await inRoom(".tabs")) && !(await inRoom(".guide")) && (await inRoom("svg.stage")));
  ok("Raum-Karte: Personen + Zonen live", (await rc.evaluate(() => window.__room.shadowRoot.querySelectorAll(".person").length)) === 2
    && (await rc.evaluate(() => window.__room.shadowRoot.querySelectorAll(".zone").length)) === 2);
  let box = await rc.evaluate(() => { const r = window.__room.shadowRoot.querySelector(".stage-wrap").getBoundingClientRect(); return [r.width, r.height]; });
  ok("Raum-Karte füllt feste Kachel (640×300)", near(box[0], 640, 1) && near(box[1], 300, 1), JSON.stringify(box));
  await rc.screenshot({ path: path.join(OUT, "13_raumkarte_breit.png") });
  await rc.evaluate(() => window.__mountRoom({ room: "Wohn-/Esszimmer" }, 260, 420)); await rc.waitForTimeout(500);
  box = await rc.evaluate(() => { const r = window.__room.shadowRoot.querySelector(".stage-wrap").getBoundingClientRect(); return [r.width, r.height]; });
  ok("Raum-Karte füllt hohe Kachel (260×420)", near(box[0], 260, 1) && near(box[1], 420, 1), JSON.stringify(box));
  await rc.screenshot({ path: path.join(OUT, "14_raumkarte_hoch.png") });
  await rc.evaluate(() => window.__mountRoom({ room: "r1" }, 500, "auto")); await rc.waitForTimeout(500);
  box = await rc.evaluate(() => { const w = window.__room.shadowRoot.querySelector(".stage-wrap"); const r = w.getBoundingClientRect(); return [r.width, r.height, parseFloat(getComputedStyle(w).getPropertyValue("--ar"))]; });
  ok("Raum-Karte ohne feste Höhe: Seitenverhältnis des Raums", near(box[0], 500, 1) && near(box[1], 500 / box[2], 2), JSON.stringify(box));
  await rc.evaluate(() => window.__mountRoom({ room: "Büro", show_cones: false, show_names: false }, 400, 300)); await rc.waitForTimeout(500);
  ok("Raum-Karte: Raumauswahl (Büro)", (await rc.evaluate(() => window.__room._activeRoom)) === "r2");
  ok("Raum-Karte: Kegel ausblendbar", !(await inRoom("#coverage")));
  await rc.evaluate(() => window.__mountEditor({ room: "r1" })); await rc.waitForTimeout(400);
  const opts = await rc.evaluate(() => [...document.querySelectorAll('zone-presence-room-card-editor select[data-k="room"] option')].map((o) => o.textContent));
  ok("Editor: Räume zur Auswahl", opts.includes("Büro") && opts.includes("Wohn-/Esszimmer"), JSON.stringify(opts));
  await rc.locator('zone-presence-room-card-editor select[data-k="room"]').selectOption("r2"); await rc.waitForTimeout(150);
  await rc.locator('zone-presence-room-card-editor input[data-k="show_cones"]').uncheck(); await rc.waitForTimeout(150);
  const evs = await rc.evaluate(() => window.__edEvents);
  ok("Editor: config-changed (Raum, Kegel)", evs.length >= 2 && evs[evs.length - 1].room === "r2" && evs[evs.length - 1].show_cones === false, JSON.stringify(evs));
  await rc.close();

  // ------------------------------------------------------------------ 1.2: Sichtbarkeit
  console.log("Sichtbare Elemente");
  const lp = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  lp.on("pageerror", (e) => errors.push(String(e)));
  lp.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await lp.goto(BASE + "?lang=de"); await lp.waitForTimeout(600);
  const inCard = (pg, sel) => pg.evaluate((s) => { const r = window.__card.shadowRoot.querySelector(s); return r ? getComputedStyle(r).display !== "none" : false; }, sel);
  ok("Sperrzone in der Ansicht angedeutet", await inCard(lp, '#excl .excl[data-zone="x1"]'));
  await lp.locator(".lay-btn").click(); await lp.waitForTimeout(200);
  ok("Menü sichtbare Elemente offen", await lp.locator(".laypop").isVisible());
  ok("Alle Elemente wählbar (13)", (await lp.locator(".laypop [data-layer]").count()) === 13);
  await lp.screenshot({ path: path.join(OUT, "15_sichtbar.png") });
  await lp.locator('.laypop [data-layer="cones"]').uncheck(); await lp.waitForTimeout(150);
  ok("Kegel ausgeblendet", !(await inCard(lp, "#coverage")));
  await lp.locator('.laypop [data-preset="minimal"]').click(); await lp.waitForTimeout(150);
  ok("Voreinstellung „Nur Personen“", !(await inCard(lp, "#sensors")) && (await inCard(lp, "#persons")) && !(await inCard(lp, "#zones .zone .zone-tag")));
  await lp.locator('.laypop [data-layer="dims"]').check(); await lp.waitForTimeout(150);
  ok("Bemaßung in der Ansicht", (await lp.evaluate(() => window.__card.shadowRoot.querySelectorAll("#dims .dim").length)) === 6);
  await lp.locator('.laypop [data-layer="overlap"]').check(); await lp.waitForTimeout(150);
  ok("Überlappung gezeichnet", (await lp.evaluate(() => window.__card.shadowRoot.querySelectorAll("#overlap .ovl").length)) === 1);
  await lp.locator('.laypop [data-layer="heat"]').check(); await lp.waitForTimeout(500);
  ok("Heatmap im Grundriss (Modelldaten geladen)", (await lp.evaluate(() => window.__card.shadowRoot.querySelectorAll("#mbg image").length)) === 1);
  const saved = await lp.evaluate(() => JSON.parse(localStorage.getItem("zp_layers_v1")));
  ok("Auswahl gemerkt (localStorage)", saved.includes("dims") && !saved.includes("sensors"), JSON.stringify(saved));
  await lp.reload(); await lp.waitForTimeout(600);
  ok("Auswahl nach Neuladen erhalten", !(await inCard(lp, "#sensors")) && (await lp.evaluate(() => window.__card.shadowRoot.querySelectorAll("#dims .dim").length)) === 6);
  await lp.screenshot({ path: path.join(OUT, "16_ebenen.png") });
  await lp.evaluate(() => localStorage.removeItem("zp_layers_v1"));
  await lp.close();

  // ------------------------------------------------------------------ Sperrzonen, Vorlagen, Kanten
  console.log("Sperrzonen + Vorlagen + Kanten");
  const zp = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  zp.on("pageerror", (e) => errors.push(String(e)));
  zp.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  const unlock = async (pg, q = "?lang=de") => {
    await pg.goto(BASE + q); await pg.waitForTimeout(600);
    await pg.locator(".mode-btn").click();
    for (const k of ["1", "2", "3", "4"]) await pg.locator(`.pin-pad button[data-k="${k}"]`).click();
    await pg.waitForTimeout(300);
  };
  const lastA = async (pg, f = () => true) => (await pg.evaluate(() => window.__ws)).filter((m) => m.type === "zone_presence/apply").filter(f).pop();
  await unlock(zp);
  // Kante parallel ziehen: Rechteck bleibt Rechteck, auch bei schrägem Ziehen
  const scr2 = (x, y) => zp.evaluate(([a, b]) => window.__scr(a, b), [x, y]);
  const dragBy = async (sel, fromPt, toPt, shift) => {
    const bx = await zp.locator(sel).first().boundingBox(), hx = bx.x + bx.width / 2, hy = bx.y + bx.height / 2;
    const A1 = await scr2(...fromPt), B1 = await scr2(...toPt);
    await zp.mouse.move(hx, hy); await zp.mouse.down();
    if (shift) await zp.keyboard.down("Shift");
    for (let i = 1; i <= 10; i++) { await zp.mouse.move(hx + ((B1[0] - A1[0]) * i) / 10, hy + ((B1[1] - A1[1]) * i) / 10); await zp.waitForTimeout(15); }
    await zp.mouse.up(); if (shift) await zp.keyboard.up("Shift"); await zp.waitForTimeout(150);
  };
  const zpts = (id) => zp.evaluate((z) => window.__card._zoneObj(z).points.map((p) => p.slice()), id);
  // z3 = [[0.6,1.2],[2.8,1.2],[2.8,3.4],[0.6,3.4]] – rechte Kante (Index 1) schräg nach rechts oben ziehen
  await dragBy('.zone[data-zone="z3"] [data-edge="1"]', [2.8, 2.3], [3.37, 1.93]);
  let zz = await zpts("z3");
  ok("Kante wandert parallel (rechte Winkel bleiben)", zz[1][1] === 1.2 && zz[2][1] === 3.4 && zz[1][0] === zz[2][0] && zz[1][0] > 3.2, JSON.stringify(zz));
  await dragBy('.zone[data-zone="z3"] [data-edge="1"]', [zz[1][0], 2.3], [3.41, 2.4]);
  zz = await zpts("z3");
  ok("Kante rastet an paralleler Wand/Flucht ein (x = 3,45)", Math.abs(zz[1][0] - 3.45) < 1e-6 && Math.abs(zz[2][0] - 3.45) < 1e-6, JSON.stringify(zz));
  const before3 = await zpts("z3");
  await dragBy('.zone[data-zone="z3"] [data-edge="2"]', [1.7, 3.4], [2.2, 3.62], true);
  zz = await zpts("z3");
  ok("Shift: frei verschieben (auch seitlich)", Math.abs(zz[2][0] - before3[2][0] - 0.5) < 0.05 && Math.abs(zz[3][0] - before3[3][0] - 0.5) < 0.05, JSON.stringify(zz));

  await zp.locator('[data-act="addexcl"]').click(); await zp.waitForTimeout(200);
  let A = await lastA(zp, (m) => m.exclusions);
  ok("＋ Sperrzone gesendet", A.exclusions.length === 2 && A.exclusions[1].name === "Sperrzone" && A.zones.length === 2);
  const exColor = await zp.evaluate(() => getComputedStyle(window.__card.shadowRoot.querySelectorAll("#excl .excl")[1].querySelector(".ex-fill")).stroke);
  ok("Sperrzone rot", /255, 59, 59/.test(exColor), exColor);
  const newId = A.exclusions[1].id;
  await zp.locator(`#excl .excl[data-zone="${newId}"] .tag-text`).click(); await zp.waitForTimeout(200);
  ok("Sperrzonen-Panel offen", await zp.locator(".panel .p-box").isVisible());
  await zp.locator('.panel [data-p="depth"]').fill("0.5");
  await zp.locator('.panel [data-p="learn"]').check();
  await zp.locator(".panel .p-save").click(); await zp.waitForTimeout(200);
  A = await lastA(zp, (m) => m.exclusions);
  const ne = A.exclusions.find((x) => x.id === newId);
  ok("Eindringtiefe + Lernen gespeichert", ne.depth === 0.5 && ne.learn === true, JSON.stringify(ne));
  await zp.screenshot({ path: path.join(OUT, "17_sperrzone.png") });
  await zp.locator('[data-act="tplmenu"]').click(); await zp.waitForTimeout(150);
  ok("Vorlagen-Menü", (await zp.locator(".dd-menu [data-tpl]").count()) === 7);
  await zp.locator('.dd-menu [data-tpl="sofa"]').click(); await zp.waitForTimeout(200);
  A = await lastA(zp, (m) => m.zones);
  const sofa = A.zones[A.zones.length - 1], sw = Math.max(...sofa.points.map((p) => p[0])) - Math.min(...sofa.points.map((p) => p[0])), sh = Math.max(...sofa.points.map((p) => p[1])) - Math.min(...sofa.points.map((p) => p[1]));
  ok("Vorlage Sofa 2,2 × 0,95 m", Math.abs(sw - 2.2) < 1e-6 && Math.abs(sh - 0.95) < 1e-6 && sofa.name === "Sofa", JSON.stringify(sofa));
  ok("Zonenfarbe nie Sperrzonen-Rot", A.zones.every((z) => z.color.toLowerCase() !== "#ff3b3b"));
  await zp.locator('.zone[data-zone="z3"] .tag-text').click(); await zp.waitForTimeout(200);
  await zp.locator(".panel .p-extra").click(); await zp.waitForTimeout(200);
  A = await lastA(zp, (m) => m.zones);
  ok("Zone duplizieren", A.zones.some((z) => z.name === "Esstisch (Kopie)") && A.zones.length === 4);

  // Raum-Bemaßung
  await zp.locator('.seg[data-mode="rooms"]').click(); await zp.waitForTimeout(200);
  const badges = await zp.evaluate(() => [...window.__card.shadowRoot.querySelectorAll("#room .dim text")].map((t) => t.textContent));
  ok("Längen-Badges an allen Kanten", badges.length === 6 && badges[0] === "7,00 m", JSON.stringify(badges));
  ok("Winkel an allen Ecken", (await zp.evaluate(() => [...window.__card.shadowRoot.querySelectorAll("#room .ang text")].map((t) => t.textContent))).join(" ") === "90° 90° 90° 270° 90° 90°");
  // Kante 0 (oben, 0,0 -> 7,0) per Ziehen nach oben: Badge der Nachbarkante aktualisiert sich live
  const bb0 = await zp.locator('#room [data-redge="0"]').boundingBox();
  await zp.mouse.move(bb0.x + bb0.width / 2, bb0.y + bb0.height / 2); await zp.mouse.down();
  for (let i = 1; i <= 6; i++) { await zp.mouse.move(bb0.x + bb0.width / 2, bb0.y + bb0.height / 2 - i * 6); await zp.waitForTimeout(15); }
  const liveTxt = await zp.evaluate(() => window.__card.shadowRoot.querySelector('#room [data-redge="5"] text').textContent);
  await zp.mouse.up(); await zp.waitForTimeout(150);
  ok("Badge aktualisiert sich live beim Ziehen", liveTxt !== "5,50 m", liveTxt);
  await zp.locator(".undo-btn").click(); await zp.waitForTimeout(250);
  // Länge eintippen
  await zp.locator('#room [data-redge="0"]').click(); await zp.waitForTimeout(200);
  ok("Eingabefeld öffnet sich am Badge", await zp.locator(".dimedit").isVisible());
  await zp.screenshot({ path: path.join(OUT, "18_bemassung.png") });
  await zp.locator(".dimedit .de-in").fill("8");
  await zp.locator(".dimedit .de-in").press("Enter"); await zp.waitForTimeout(200);
  A = await lastA(zp, (m) => m.rooms);
  let rpoly = A.rooms.find((r) => r.id === "r1").polygon;
  ok("Länge 8 m, Mitte bleibt (3,5 | 0)", Math.abs(rpoly[0][0] + 0.5) < 1e-6 && Math.abs(rpoly[1][0] - 7.5) < 1e-6 && rpoly[0][1] === 0 && rpoly[1][1] === 0, JSON.stringify(rpoly));
  ok("Winkel bleiben: Nachbarwände wandern mit", Math.abs(rpoly[5][0] + 0.5) < 1e-6 && Math.abs(rpoly[2][0] - 7.5) < 1e-6 && rpoly[5][1] === 5.5 && rpoly[2][1] === 4, JSON.stringify(rpoly));
  await zp.locator('#room [data-redge="1"]').click(); await zp.waitForTimeout(200);
  await zp.locator(".dimedit .de-in").fill("3,5");
  await zp.locator(".dimedit .de-in").press("Tab"); await zp.waitForTimeout(250);
  A = await lastA(zp, (m) => m.rooms);
  rpoly = A.rooms.find((r) => r.id === "r1").polygon;
  ok("Tab übernimmt (3,5 m) und springt zur nächsten Kante", Math.abs(rpoly[2][1] - rpoly[1][1] - 3.5) < 1e-6 && (await zp.locator(".dimedit").isVisible()) && (await zp.locator(".dimedit .de-in").inputValue()) !== "3,50", JSON.stringify(rpoly));
  await zp.locator(".dimedit .de-in").press("Escape"); await zp.waitForTimeout(100);
  ok("Esc schließt das Eingabefeld", !(await zp.locator(".dimedit").isVisible()));
  await zp.locator('#room [data-redge="2"]').click(); await zp.waitForTimeout(150);
  await zp.locator(".dimedit .de-k").uncheck();
  await zp.locator(".dimedit .de-in").fill("4");
  await zp.locator(".dimedit .de-ok").click(); await zp.waitForTimeout(200);
  const lit = await zp.evaluate(() => { const poly = [[0, 0], [4, 0], [4, 3], [0, 3]]; window.__card._setEdgeLength(poly, 0, 5, false); return poly; });
  ok("Ohne „Winkel beibehalten“ nur die Kante selbst", JSON.stringify(lit) === JSON.stringify([[-0.5, 0], [4.5, 0], [4, 3], [0, 3]]), JSON.stringify(lit));
  const keep = await zp.evaluate(() => { const poly = [[0, 0], [4, 0], [5, 3], [-1, 3]]; window.__card._setEdgeLength(poly, 0, 6, true); return poly; });
  ok("Winkel beibehalten auch bei schrägen Wänden (Trapez)", JSON.stringify(keep) === JSON.stringify([[-1, 0], [5, 0], [6, 3], [-2, 3]]), JSON.stringify(keep));
  // Winkel eintippen
  await zp.locator(".undo-btn").click(); await zp.waitForTimeout(250);
  await zp.locator('#room [data-rang="1"]').click(); await zp.waitForTimeout(200);
  await zp.locator(".dimedit .de-in").fill("80");
  await zp.locator(".dimedit .de-in").press("Enter"); await zp.waitForTimeout(200);
  const ang = await zp.evaluate(() => window.__card.shadowRoot.querySelector('#room [data-rang="1"] text').textContent);
  ok("Eckwinkel eintippen", ang === "80°", ang);
  // Raumkante ziehen: parallel + 5-cm-Raster
  await zp.locator(".undo-btn").click(); await zp.waitForTimeout(250);
  const rbefore = await zp.evaluate(() => window.__card._room().polygon.map((p) => p.slice()));
  await dragBy('#room [data-redge="1"]', [rbefore[1][0], 2], [rbefore[1][0] + 0.33, 1.6]);
  const rafter = await zp.evaluate(() => window.__card._room().polygon.map((p) => p.slice()));
  ok("Raumkante parallel, im Raster", rafter[1][1] === rbefore[1][1] && rafter[2][1] === rbefore[2][1] && rafter[1][0] === rafter[2][0] && Math.abs(rafter[1][0] * 20 - Math.round(rafter[1][0] * 20)) < 1e-6, JSON.stringify([rbefore[1], rafter[1], rafter[2]]));
  await zp.close();

  // ------------------------------------------------------------------ KI-Modell-Ansicht
  console.log("KI-Modell");
  const mp = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  mp.on("pageerror", (e) => errors.push(String(e)));
  mp.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await mp.goto(BASE + "?lang=de"); await mp.waitForTimeout(600);
  await mp.locator('.vseg [data-view="model"]').click(); await mp.waitForTimeout(1500);
  ok("Modell-Ansicht: Daten angefordert", (await mp.evaluate(() => window.__ws)).some((m) => m.type === "zone_presence/model_view" && m.room_id === "r1"));
  const pix = async () => mp.evaluate(() => {
    const c = window.__card.shadowRoot.querySelector("canvas.fx"), x = c.getContext("2d"), d = x.getImageData(0, 0, c.width, c.height).data;
    let n = 0, sum = 0; for (let i = 3; i < d.length; i += 16) { if (d[i] > 8) n++; sum += d[i - 3] + d[i - 2] + d[i - 1]; } return { n, sum, w: c.width, h: c.height };
  });
  const p1 = await pix(); await mp.waitForTimeout(700); const p2 = await pix();
  ok("Canvas zeichnet Wolken", p1.n > 1000 && p1.w > 300, JSON.stringify(p1));
  ok("Es bewegt sich (nie tot)", p1.sum !== p2.sum, JSON.stringify([p1.sum, p2.sum]));
  ok("Problemstellen markiert", (await mp.evaluate(() => window.__card.shadowRoot.querySelectorAll("#ospots .ospot").length)) === 2);
  ok("Panel: Problemstellen erklärt", /Wand/.test(await mp.locator(".mpanel .mp-spot").first().textContent()) && /18 und 24 Uhr/.test(await mp.locator(".mpanel .mp-spot").first().textContent()));
  ok("Panel: Statistik", /93 % richtig/.test(await mp.locator(".mpanel").textContent()) && /Heute abgefangene Geister: 14/.test(await mp.locator(".mpanel").textContent()));
  ok("Live-Rohtargets in der Animation", (await mp.evaluate(() => window.__card._fx.tg.size)) === 5);
  await mp.waitForTimeout(800);
  ok("Bewegte Targets ziehen Schwaden", (await mp.evaluate(() => window.__card._fx.trails.length)) > 5);
  await mp.screenshot({ path: path.join(OUT, "19_modell.png") });
  await mp.locator(".mpanel [data-ml='g']").click(); await mp.waitForTimeout(200);
  ok("Legende schaltet Ebene ab", !(await mp.evaluate(() => window.__card._mlayers.has("g"))) && (await mp.evaluate(() => window.__card._fx.want.g)) === 0);
  await mp.locator(".mpanel [data-ml='g']").click(); await mp.waitForTimeout(200);
  const so = await mp.locator('#ospots [data-spot="1"]').boundingBox();
  await mp.mouse.click(so.x + so.width / 2, so.y + so.height / 2); await mp.waitForTimeout(250);
  ok("Klick auf Markierung hebt Problemstelle hervor", (await mp.locator(".mp-spot.hl").count()) === 1 && (await mp.locator('.mp-spot.hl[data-spotrow="1"]').count()) === 1);
  const pt = await mp.evaluate(() => window.__scr(3.0, 2.5));
  await mp.mouse.click(pt[0], pt[1]); await mp.waitForTimeout(200);
  ok("Klick zeigt Werte der Stelle", await mp.locator(".minfo").isVisible() && /Echte Aktivität/.test(await mp.locator(".minfo").textContent()));
  await mp.screenshot({ path: path.join(OUT, "20_modell_info.png") });
  await mp.locator(".minfo [data-forget]").click(); await mp.waitForTimeout(150);
  ok("Vergessen fragt nach PIN", await mp.locator(".pin-overlay").isVisible());
  for (const k of ["1", "2", "3", "4"]) await mp.locator(`.pin-pad button[data-k="${k}"]`).click();
  await mp.waitForTimeout(400);
  ok("Bereich vergessen gesendet", (await mp.evaluate(() => window.__ws)).some((m) => m.type === "zone_presence/model_forget" && Math.abs(m.x - 3) < 0.05 && m.radius === 0.5));
  ok("Bleibt in der Modell-Ansicht", (await mp.locator(".zp.view-model").count()) === 1);
  await mp.locator('.mpanel [data-mact="spotexcl"][data-i="0"]').click(); await mp.waitForTimeout(250);
  const ea = (await mp.evaluate(() => window.__ws)).filter((m) => m.type === "zone_presence/apply" && m.exclusions).pop();
  ok("Problemstelle -> Sperrzone", ea && ea.exclusions.length === 2 && ea.exclusions[1].points[0][0] === 0.6 && ea.exclusions[1].points[2][1] === 5.0, JSON.stringify(ea && ea.exclusions[1]));
  await mp.locator('.mpanel [data-mact="tlload"]').click(); await mp.waitForTimeout(400);
  ok("Zeitraffer lädt Verlauf", (await mp.evaluate(() => window.__ws)).some((m) => m.type === "zone_presence/model_view" && m.history === true));
  ok("Zeitraffer spielt", (await mp.locator(".mpanel .mp-tl input[type=range]").count()) === 1);
  await mp.waitForTimeout(1600);
  ok("Zeitraffer schreitet fort", +(await mp.locator(".mpanel .mp-tl input[type=range]").inputValue()) >= 1);
  await mp.screenshot({ path: path.join(OUT, "21_zeitraffer.png") });
  ok("Export/Import nur für Admins sichtbar", (await mp.locator('.mpanel [data-mact="export"]').count()) === 1);
  const [dl] = await Promise.all([mp.waitForEvent("download", { timeout: 3000 }).catch(() => null), mp.locator('.mpanel [data-mact="export"]').click()]);
  ok("Export lädt eine Datei", dl && /zone-presence-model-.*\.json/.test(dl.suggestedFilename()));
  await mp.locator('.vseg [data-view="plan"]').click(); await mp.waitForTimeout(300);
  ok("Zurück zum Grundriss stoppt die Animation", (await mp.evaluate(() => window.__card._fx.running)) === false);
  await mp.setViewportSize({ width: 390, height: 844 }); await mp.locator('.vseg [data-view="model"]').click(); await mp.waitForTimeout(800);
  ok("Modell mobil: kein horizontales Scrollen", !(await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  await mp.screenshot({ path: path.join(OUT, "22_modell_mobil.png"), fullPage: true });
  await mp.close();

  // ------------------------------------------------------------------ KI-Modell-Karte
  console.log("KI-Modell-Karte");
  const mc = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  mc.on("pageerror", (e) => errors.push(String(e)));
  mc.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await mc.goto(BASE + "?lang=de"); await mc.waitForTimeout(400);
  await mc.evaluate(() => window.__mountModel({ room: "Wohn-/Esszimmer" }, 620, 380)); await mc.waitForTimeout(1500);
  const mstate = await mc.evaluate(() => { const c = window.__model, sr = c.shadowRoot, cv = sr.querySelector("canvas.fx"), r = cv.getBoundingClientRect();
    const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data; let n = 0; for (let i = 3; i < d.length; i += 16) if (d[i] > 8) n++;
    return { running: c._fx && c._fx.running, w: r.width, h: r.height, n, chips: sr.querySelectorAll(".mlegend .mp-chip").length, top: !!sr.querySelector(".topbar") && getComputedStyle(sr.querySelector(".topbar")).display !== "none" }; });
  ok("Modell-Karte animiert und füllt die Kachel", mstate.running && Math.abs(mstate.w - 620) < 1 && Math.abs(mstate.h - 380) < 1 && mstate.n > 500, JSON.stringify(mstate));
  ok("Modell-Karte: Legende, keine Leisten", mstate.chips === 5 && !mstate.top);
  await mc.screenshot({ path: path.join(OUT, "23_modellkarte.png") });
  await mc.evaluate(() => window.__mountModel({ room: "Büro", show_targets: false, legend: false }, 400, 300)); await mc.waitForTimeout(800);
  ok("Modell-Karte: Raum + Optionen", (await mc.evaluate(() => window.__model._activeRoom)) === "r2" && !(await mc.evaluate(() => window.__model._mlayers.has("t"))) && (await mc.evaluate(() => window.__model.shadowRoot.querySelectorAll(".mlegend .mp-chip").length)) === 0);
  await mc.evaluate(() => window.__mountEditor({ room: "r1" }, "zone-presence-model-card-editor")); await mc.waitForTimeout(400);
  ok("Modell-Editor: Optionen", (await mc.locator('zone-presence-model-card-editor input[data-k="show_targets"]').count()) === 1 && (await mc.locator('zone-presence-model-card-editor [data-m="model_layers"]').count()) === 4);
  await mc.locator('zone-presence-model-card-editor [data-m="model_layers"][value="u"]').uncheck(); await mc.waitForTimeout(150);
  const mev = await mc.evaluate(() => window.__edEvents);
  ok("Modell-Editor: Ebenen wählbar", JSON.stringify(mev[mev.length - 1].model_layers) === JSON.stringify(["g", "r", "h"]) || JSON.stringify(mev[mev.length - 1].model_layers) === JSON.stringify(["g", "r"]), JSON.stringify(mev));
  await mc.evaluate(() => window.__mountRoom({ room: "r1", layers: ["zones", "persons", "dims"] }, 500, 320)); await mc.waitForTimeout(600);
  const rl = await mc.evaluate(() => { const sr = window.__room.shadowRoot; const vis = (s) => { const e = sr.querySelector(s); return !!e && getComputedStyle(e).display !== "none"; }; return { sensors: vis("#sensors"), dims: sr.querySelectorAll("#dims .dim").length, persons: vis("#persons") }; });
  ok("Raum-Karte: sichtbare Elemente per Konfiguration", !rl.sensors && rl.dims === 6 && rl.persons, JSON.stringify(rl));
  await mc.close();

  ok("keine JS-Fehler", errors.length === 0, errors.join(" | "));
  console.log(`\n${pass} ok, ${fail} fehlgeschlagen`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
