// Browser-Test der Karte mit simuliertem Backend (Playwright/Chromium).
// Aufruf: node tests/browser/run.js <ausgabe-ordner>
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const OUT = process.argv[2] || path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });
const URL = "file://" + path.join(__dirname, "harness.html");

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

  ok("keine JS-Fehler", errors.length === 0, errors.join(" | "));
  console.log(`\n${pass} ok, ${fail} fehlgeschlagen`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
