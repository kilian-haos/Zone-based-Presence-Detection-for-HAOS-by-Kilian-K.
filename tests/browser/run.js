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
  ok("Kandidaten + verworfene Geister", (await page.locator(".cand").count()) === 1 && (await page.locator(".rej").count()) === 1);
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

  ok("keine JS-Fehler", errors.length === 0, errors.join(" | "));
  console.log(`\n${pass} ok, ${fail} fehlgeschlagen`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
