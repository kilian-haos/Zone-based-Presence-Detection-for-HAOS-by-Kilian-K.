<img src="custom_components/zone_presence/brand/icon.png" alt="" width="96" align="right">

# Zonenbasierte Präsenzerkennung für HAOS von Kilian K.

🇬🇧 [English version](README.md) · 🇩🇪 Deutsch

Nutze die X- und Y-Entitäten beliebiger mmWave-Präsenzsensoren in einer vollständig grafischen Oberfläche, um Zonen, Räume, Sperrzonen, Sensor-Kalibrierungen und Offsets festzulegen – und lass ein lernendes Modell ungewollte Fehlerkennungen herausfiltern (entwickelt und getestet mit Sensoren wie dem HLK-LD2450 über ESPHome). Du zeichnest Räume und Zonen auf einem Live-Grundriss und bekommst für jede Zone einen Belegungs- und einen Personenanzahl-Sensor. Alles läuft lokal in deinem eigenen Home Assistant.

---

## Funktionen

- **Live-Grundriss** als Dashboard-Karte und als Seitenleisten-Panel – mehrere Räume als Reiter.
- **Raum-Karte**: nur der Grundriss eines Raums, frei skalierbar; Raum und sichtbare Elemente wählst du im Karten-Editor.
- **KI-Modell-Ansicht** – eine farbenfrohe, fließende Darstellung dessen, was der lernende Geisterfilter gelernt hat: Geisterstellen, echte Aktivität, Unsicherheit und Aufenthalte, dazu die Live-Rohtargets, die kleine Schwaden hinter sich herziehen. Als Reiter und als eigene Dashboard-Karte (siehe [KI-Modell-Ansicht](#ki-modell-ansicht)).
- **Zonen** (beliebige Vielecke), jede mit eigenem Gerät in der Integration: Binärsensor **„Zonenname (Zone N)“** und Sensor **„Personenanzahl“**. Zonen-Vorlagen (Sofa, Bett, Esstisch, …) und Duplizieren.
- **Sperrzonen** (rot): Erkennungen darin zählen nie – ideal für Ventilator, Vorhang oder ein spiegelndes Fenster. Eine von außen hereinkommende Person zählt bis zu einer einstellbaren Eindringtiefe weiter (siehe [Sperrzonen](#sperrzonen)).
- **Bemaßung**: Jede Raumkante zeigt beim Zeichnen ihre Länge in Metern; antippen und exakte Länge eintippen (die Mitte der Kante bleibt, die Kante wächst nach beiden Seiten). Eckwinkel lassen sich ebenfalls eintippen.
- **Personenanzahl je Raum**, unabhängig von den Zonen-Sensoren.
- **Sitz-/Liege-Erkennung**: Bewegungen in einem kleinen, einstellbaren Radius werden gedämpft, dazu ein größerer Austrittspuffer – liegende Personen „driften“ nicht aus der Zone.
- **Hänger-Erkennung**: eingefrorene Target-Werte (hängender ESP/Sensor) werden ignoriert.
- **Presence-Gate**: Ist der Presence-Sensor eines Geräts frei, zählen seine Targets nicht.
- **Wand-Filter**: knapp außerhalb des Raums wird an die Wand gesetzt, weit außerhalb (Reflexionen o. Ä.) verworfen.
- **Lernender Geisterfilter** mit einmaliger, planbarer **Lernkalibrierung** (z. B. heute Nacht um 3 Uhr für 2 h) und **kontinuierlichem Lernen** im Betrieb. Er lernt je Tageszeit, prüft sich selbst, erkennt sprunghafte Mehrwege-Geister und nutzt einen zweiten Sensor als Zeugen (siehe [Lernender Geisterfilter](#lernender-geisterfilter)). **Rechenlast 1–3** wählbar.
- **Mehrere Sensoren**: Bei zwei oder mehr Sensoren in einem Raum werden Personen zusammengefasst; der **Auto-Abgleich** bestimmt die Sensor-Offsets anhand einer Person, damit die Targets verschiedener Sensoren, die zur selben Person gehören, sauber übereinanderliegen.
- **Kalibrierung** mit rot leuchtendem Kegel: einzelner Sensor (verschieben + drehen), ganzer Raum (verschieben) oder komplettes Spiegeln der X-Achse bei vertauschten oder defekten Sensoren.
- **Einrasten** beim Zeichnen: Ecken rasten an Raumecken und Wänden ein; Kanten wandern **parallel** – die Nachbarkanten behalten ihren Winkel, ein Rechteck bleibt ein Rechteck – und rasten an parallelen Wänden und anderen Zonen ein. **Shift** gedrückt halten (Maus) schaltet das Einrasten vorübergehend ab (per Touch rastet es immer).
- **Sichtbare Elemente**: Du bestimmst genau, was die Ansicht zeigt (Zonen, Namen, Sperrzonen, Sensoren, Kegel, Überlappung, Personen, Beschriftungen, Rohdaten, verworfene Geister, Bemaßung, Heatmap, gelernte Geisterstellen) – mit Voreinstellungen, je Browser gemerkt.
- **Rückgängig/Wiederholen** der letzten 5 Änderungen.
- **Optionaler Bearbeitungs-PIN**: Bearbeiten nur für Administratoren, außer für alle freigegeben; der 4-stellige PIN begrenzt den Zugriff zusätzlich – besonders sinnvoll, wenn „alle dürfen bearbeiten“ an ist.
- **Alle Zeiten und Schwellen einstellbar**, die Nachlaufzeit zusätzlich je Zone. Schau dich in den Einstellungen und Menüs um – und wenn etwas fehlt, eröffne gern ein Issue.
- **Sprache:** folgt Home Assistant automatisch (siehe [Sprache](#sprache)).

## Voraussetzungen

- Home Assistant **2025.1** oder neuer.
- Je Sensor mindestens **eine X- und eine Y-Entität** (Target 1). Weitere Targets und ein Presence-Binärsensor sind optional.
- Koordinaten in mm (LD2450-Standard), cm oder m.
- Das Icon der Integration erscheint ab Home Assistant **2026.3** (ältere Versionen zeigen einen Platzhalter).

### Beispiel-Konfiguration für ESPHome (so bekomme ich meine Sensordaten)

Die vollständige Beispiel-Konfiguration steht in der [englischen README](README.md#example-esphome-configuration-this-is-how-i-get-my-sensor-data) – sie ist sprachunabhängig. Wichtig: `throttle: 250ms` an den X/Y-Sensoren und `baud_rate: 256000`.

## Installation

### Home Assistant 2026.11 oder neuer: Marketplace

Seit 2026.11 ist HACS als **Marketplace** fest in Home Assistant eingebaut.

1. **Einstellungen → Marketplace → Über Link hinzufügen** → URL dieses Repositorys (beim ersten Mal fragt Home Assistant nach einer GitHub-Verbindung; sie liest nur öffentliche Informationen).
2. „Zone Presence Detection by Kilian K.“ installieren und Home Assistant **neu starten**.

### Home Assistant 2026.10 oder älter: HACS (benutzerdefiniertes Repository)

1. HACS → ⋮ → **Benutzerdefinierte Repositories** → URL dieses Repositorys, Kategorie **Integration**.
2. „Zone Presence Detection by Kilian K.“ installieren und Home Assistant **neu starten**.

Updates erscheinen in beiden Fällen unter **Einstellungen → Updates**. Marketplace und HACS können nur **öffentliche** Repositorys hinzufügen.

### Von Hand

Den Ordner `custom_components/zone_presence` nach `<config>/custom_components/` kopieren und neu starten. Ohne Marketplace/HACS gibt es keine Update-Hinweise.

## Einrichtung

1. **Einstellungen → Geräte & Dienste → Integration hinzufügen → „Zone Presence Detection“**.
2. Optional gleich den ersten Sensor hinzufügen: Gerät wählen (z. B. das ESPHome-Gerät mit den LD2450-Entitäten) – Target-X/Y und der Presence-Sensor werden automatisch vorgeschlagen. Einheit prüfen (LD2450: mm).
3. Weitere Sensoren: Integration → **Konfigurieren → Sensor hinzufügen**.
4. Panel **„Präsenz-Zonen“** in der Seitenleiste öffnen (oder die Karte ins Dashboard), **Bearbeiten** (PIN nur, falls gesetzt), dann:
   - **Räume**: Raum zeichnen (Ecken/Kanten ziehen, Länge oder Winkel antippen und eintippen, Mitte tippen = weiterer Punkt).
   - **Sensoren**: Sensoren an ihre Einbauposition ziehen und mit dem Pfeil ausrichten.
   - **Zonen**: Zonen anlegen und benennen (▾ = Vorlagen), **Sperrzonen** dort anlegen, wo nichts zählen soll.
   - **Kalibrieren**: eine Person in den Überlappungsbereich, **⚡ Sensoren abgleichen**, dann mit den übrigen Kalibrier-Optionen feinjustieren.

## Dashboard-Karten

Die Karten lädt die Integration automatisch – keine Ressource nötig.

```yaml
type: custom:zone-presence-card
title: Wohnzimmer           # optional (Standard: "Zone Presence" / "Präsenz-Zonen")
room: Wohnzimmer            # optional: Start-Reiter (Name oder ID)
pin: "1234"                 # optional: überschreibt den PIN aus den Optionen ("" = kein PIN)
lock_minutes: 30            # optional: Sperre nach 3 falschen PIN-Eingaben
merge_color: "#2dd4bf"      # optional: Farbe zusammengefasster Personen
```

**Bedienung:** Reiter wechseln den Raum (Zahl = Personen im Raum). **Grundriss / ✦ KI-Modell** wechselt die Ansicht. **👁** wählt die sichtbaren Elemente (Voreinstellungen: nur Personen, Standard, Diagnose, alles – je Browser gemerkt). **◎** schaltet schnell die Rohdaten: unbestätigte Detektionen (gestrichelt, mit Konfidenz) und verworfene Geister (✕). Sitzende/liegende Personen haben einen gestrichelten Ring. **Einstellungen** öffnet die Integrationsseite.

| Modus | Bedienung |
|---|---|
| Zonen | Ecke/Kante/Mitte ziehen · Kanten wandern parallel · Mitte tippen = 2 Extra-Punkte · Name tippen = Name, Farbe, eigene Nachlaufzeit, aktiv, duplizieren · ✕ = löschen · **＋ Zone ▾** = Vorlagen · **＋ Sperrzone** |
| Sensoren | Sensor ziehen = platzieren · Pfeil = drehen · Sensor tippen = Details, Raum, Spiegeln, Offsets |
| Räume | Ecken/Kanten ziehen (Einrasten, 5-cm-Raster) · **Längen-Badge tippen = Länge eintippen**, Winkel tippen = Winkel eintippen, **Tab** = nächste Kante · Mitte tippen = ein Punkt mehr · weitere Räume · umbenennen · löschen |
| Kalibrieren | Einzelner Sensor: roten Kegel verschieben (Kreis) und drehen (Pfeil) · Ganzer Raum: alle Kegel verschieben · Auto-Abgleich · Offsets zurücksetzen · Lernkalibrierung starten |

**Einrasten:** Beim Ziehen von Ecken, Kanten oder ganzen Zonen/Räumen rasten Punkte an Raumecken, Wänden und den Ecken/Kanten anderer Zonen ein. Eine Kante wandert **parallel**: Die Nachbarkanten behalten ihre Richtung, Rechtecke bleiben Rechtecke und schräge Wände gleiten mit. Die Kante rastet an parallelen Wänden, anderen Zonenkanten und den Fluchtlinien anderer Ecken ein. Gestrichelte Hilfslinien zeigen, woran es einrastet. **Shift** gedrückt halten = frei ziehen (auch seitlich); per Touch rastet es immer ein.

**Maße eintippen:** Das Längen-Badge einer Raumkante antippen und z. B. `4,35` eingeben (Komma oder Punkt). Die Mitte der Kante bleibt, wo sie ist, und die Kante wird nach beiden Seiten länger oder kürzer. Mit **„Winkel beibehalten“** (Standard) wandern die Nachbarwände mit, die Form behält alle Winkel (ein Rechteck bleibt ein Rechteck); ohne den Haken bewegen sich nur die beiden Ecken dieser Kante. **Enter** übernimmt, **Tab** übernimmt und springt zur nächsten Kante, **Esc** bricht ab.

### Raum-Karte

Nur der Grundriss eines Raums – ohne Leisten und Reiter. In der Abschnitte-Ansicht frei in Breite und Höhe ziehbar, der Grundriss behält seine Proportionen. Raum und sichtbare Elemente wählst du im visuellen Karten-Editor.

```yaml
type: custom:zone-presence-room-card
room: Wohnzimmer            # Name oder ID (leer = erster Raum)
show_cones: true            # Sensoren und Erfassungskegel
show_names: true            # Zonennamen und Zähler
layers: [zones, zone_names, exclusions, persons, dims]   # optional: genau diese Elemente
```

Mögliche `layers`: `zones`, `zone_names`, `exclusions`, `sensors`, `cones`, `overlap`, `persons`, `person_labels`, `raw`, `rejected`, `dims`, `heat`, `ghostmap`.

Die farbigen Kegel zeigen immer den **unkorrigierten** Sensorbereich. Die roten Kegel im Kalibrier-Modus zeigen den **korrigierten** Bereich; die gestrichelte Linie verbindet sie mit dem echten Sensor.

### KI-Modell-Ansicht

Reiter **✦ KI-Modell** in Karte/Panel oder als eigene Karte:

```yaml
type: custom:zone-presence-model-card
room: Wohnzimmer            # Name oder ID (leer = erster Raum)
show_targets: true          # Live-Rohtargets mit Schwaden
legend: true                # kleine Legende in der Karte
model_layers: [g, r, u, h]  # g = Geisterstellen, r = echte Aktivität, u = Unsicherheit, h = Aufenthalte
```

- **Magenta/pinke Wolken** – Geisterstellen: Hier erwartet das Modell Fehlerkennungen (heller = sicherer). **Türkis/Blau** – echte Aktivität: Hier laufen wirklich Menschen. **Nachtblauer Dunst** – Unsicherheit: Über diese Stelle weiß das Modell noch wenig; **schwarz** = kein Sensor sieht sie. **Bernstein** – Aufenthalte.
- **Live-Rohtargets** sind kleine leuchtende Wolken in der Farbe ihres Sensors (unbestätigt: rosa getönt, in einer Sperrzone: rot). Bewegen sie sich, ziehen sie Schwaden hinter sich her.
- **Problemstellen** (nummerierte Ringe): die drei auffälligsten Geisterbereiche, in einem Satz erklärt (wandnah = Reflexion, sonst vermutlich ein bewegtes Objekt, vor allem zu welcher Tageszeit, welcher Sensor). Mit einem Klick dort eine **Sperrzone anlegen** oder den Bereich **vergessen**.
- **Irgendwo in den Raum klicken** zeigt die Werte dieser Stelle; dort lässt sich der Bereich vergessen (Ø 1 m).
- **Zeitraffer**: spielt ab, wie das Modell gelernt hat (Schnappschuss alle 24 h / 6 h / 2 h je nach Rechenlast).
- **Statistik**: heute und in den letzten 7 Tagen abgefangene Geister, Ergebnis der Selbstprüfung, Rechenlast und aktuelles Tageszeit-Fenster, Speicher. Administratoren können das Modell als Datei **exportieren/importieren** (z. B. vor einer Neuinstallation).

## Entitäten

| Gerät | Entität | Beschreibung |
|---|---|---|
| Zone „Beispiel (Zone 1)“ | `binary_sensor.beispiel_zone_1` | Belegung, Attribute: Personen, Zonennummer, Raum, Nachlaufzeit |
| | z. B. `sensor.beispiel_zone_1_personenanzahl` | Personen in der Zone (sofort, ohne Nachlauf) |
| Raum | z. B. `sensor.<raum>_personenanzahl` | Personen im Raum |
| Hub „Zone Presence Detection“ | Lernkalibrierung (Status) | Bereit / Geplant / Läuft / Abgeschlossen / Gestört / Abgebrochen, Fortschritt |
| | Lernkalibrierung geplant (Schalter) | Einmalig: startet zur Startzeit und schaltet sich danach selbst aus |
| | Startzeit / Dauer Lernkalibrierung | z. B. 03:00 und 120 min |
| | Kontinuierliches Lernen (Schalter) | Lernen im laufenden Betrieb |
| | Tasten | Lernkalibrierung starten/abbrechen, Lernmodell zurücksetzen |
| | Verworfene Geistertargets (Diagnose) | Zähler; Attribute: hinter der Wand, gefiltert, in Sperrzone, Geister heute, Selbstprüfung |

Sperrzonen haben keine Entitäten.

Die entity_id entsteht einmalig aus Zonenname und Entitätsname in der Home-Assistant-Sprache (Englisch: `…_person_count`, Deutsch: `…_personenanzahl`) und bleibt danach stabil – auch wenn du die Zone umbenennst oder die Sprache später wechselst (nur der Anzeigename folgt).

## Sprache

Es gibt keine Spracheinstellung – alles folgt Home Assistant:

| Was | Sprache |
|---|---|
| Einrichtungs-/Optionsdialoge, Entitätsnamen, Zustände, Dienste | übernimmt Home Assistant: deutsche oder englische Übersetzung, andere Sprachen fallen auf Englisch zurück |
| Karte und Panel | Sprache des **angemeldeten Benutzers** (Profil): Deutsch, wenn Deutsch, sonst Englisch |
| Gerätemodelle, Standardnamen (Raum 1, …), Benachrichtigungen, Seitenleisten-Titel | **Systemsprache** (Einstellungen → System → Allgemein): Deutsch nur, wenn Deutsch, sonst Englisch |

Ändert sich die Systemsprache, lädt sich die Integration selbst neu.

## So funktioniert es

Jede Messung jedes Targets durchläuft diese Stufen (alles in der Integration, die Karte zeigt nur das Ergebnis):

1. **Gates** – kein Target (0/0), **eingefroren** (keine Änderung seit *Eingefroren nach*), **Presence-Sensor frei**.
2. **Umrechnung** Sensor → Raum mit Platzierung und Kalibrier-Offset.
3. **Wand-Filter** – innerhalb der *Wandtoleranz* an die Wand setzen, darüber hinaus verwerfen.
4. **Sperrzonen** – ein darin entstandenes Target wird ignoriert; ein hereinlaufendes bis zur erlaubten Tiefe an den Rand gesetzt, tiefer drin ignoriert.
5. **Tracking** – Sprünge schneller als die *maximale Gehgeschwindigkeit* starten ein neues Target.
6. **Sitz-/Liege-Modus** – bleibt ein Target *Sitz-/Liege-Modus nach* Sekunden im *Sitz-/Liege-Radius*, wird es stark geglättet und verlässt Zonen nur mit dem größeren Austrittspuffer.
7. **Geisterfilter** – Konfidenz aus Alter, zurückgelegtem Weg (der geglätteten Position), Bestätigung durch einen zweiten Sensor, „ein zweiter Sensor müsste es sehen, sieht es aber nicht“, sprunghaftem Springen, den gelernten Geister- und Aktivitätskarten und der Wandnähe. Bestätigung mit Hysterese; wer hereingelaufen ist oder von zwei Sensoren gesehen wird, gilt als *bewiesen* und wird nicht mehr verworfen.
8. **Personen** – Targets verschiedener Sensoren innerhalb der *Zusammenfassen*-Distanz werden eine Person (mit Hysterese, nie zwei Targets desselben Sensors). Die Position gewichtet den näheren Sensor stärker.
9. **Zonen** – Belegung, Personenanzahl und Nachlaufzeit.

### Sperrzonen

Eine Sperrzone (Zonen-Modus → **＋ Sperrzone**) ist immer rot, alle im selben Rot; normale Zonen bekommen dieses Rot nie automatisch (von Hand darfst du ihnen trotzdem jede Farbe geben). In der normalen Ansicht sind Sperrzonen nur angedeutet.

- **Taucht aus dem Nichts** in einer Sperrzone auf → komplett ignoriert (keine Person, keine Zone, keine Raumzählung). Erst wenn es die Sperrzone 3 s lang verlassen hat, zählt es als neue Erkennung.
- **Läuft von außen hinein** → zählt bis zur **erlaubten Eindringtiefe** (Standard 0,3 m) weiter und wird am Rand angezeigt – wie bei der Wandtoleranz. Tiefer drin wird es ignoriert.
- **Erkennungen hier als Geister lernen** (optional je Sperrzone): Das Lernmodell behandelt alles, was dort auftaucht, als Geist. Standardmäßig aus – dann berührt nichts aus einer Sperrzone das Modell.

### Lernender Geisterfilter

Ein leichtgewichtiges statistisches Modell (keine Cloud, kein neuronales Netz): je Sensor mehrere Wahrscheinlichkeitskarten im Sensor-Koordinatensystem – sie bleiben also gültig, wenn du Platzierung oder Offsets später änderst.

- **Lernkalibrierung** (einmalig, planbar): Bei **leerem Raum** wird z. B. 2 h lang aufgezeichnet, wo Geister auftauchen (Ventilator, Vorhang, Reflexionen). Laufen Personen durch, werden ihre Daten verworfen; ist mehr als 15 % der Zeit gestört, meldet die Integration das.
- **Kontinuierliches Lernen**: ortsfeste, kurzlebige, nie bestätigte Targets stärken die Geisterkarte; bestätigte, bewegte Personen stärken die Aktivitätskarte (die den Geisterverdacht an dieser Stelle senkt). Im Betrieb Gelerntes verfällt mit der eingestellten Halbwertszeit.
- **Tageszeit** (Rechenlast 2–3): Geister werden je Tageszeit-Fenster gelernt (4 × 6 h bzw. 8 × 3 h). Ein Ventilator, der nur abends läuft, macht die Stelle morgens nicht verdächtig.
- **Glatte Karten**: Gauß-Kern und bilineares Auslesen – keine Lücken mehr an Zellgrenzen.
- **Zweiter Sensor als Zeuge**: Schaut ein anderer Sensor des Raums auf die Stelle (und hat einen freien Target-Platz oder meldet „keine Präsenz“), sieht dort aber nichts, gilt die Erkennung als verdächtig und wird stärker als Geist gelernt.
- **Sprunghaftes Springen**: Mehrwege-Geister springen hin und her, Menschen bewegen sich stetig. Springen senkt die Konfidenz und zählt nicht als zurückgelegter Weg.
- **Selbstprüfung**: Wurde eine später bewiesene Person vom Modell gebremst, baut es die Geister-Evidenz dort ab; zählte ein Geist kurz als Person, lernt es die Stelle stärker. Die Lernstärke passt sich langsam an (Ergebnis in der KI-Modell-Ansicht).
- **Tagesstatistik und Warnung**: Meldet ein Sensor plötzlich viel mehr Geister als üblich (verschoben, verdreht, neues Möbelstück, Ventilator, Defekt), zeigt Home Assistant einmal pro Tag eine Benachrichtigung.
- **Rechenlast** (Konfigurieren → Algorithmen & Zeiten): 1 = sparsam (25-cm-Raster, ein Modell für den ganzen Tag), 2 = ausgewogen (15 cm, 4 Tageszeit-Fenster, empfohlen), 3 = maximal (10 cm, 8 Tageszeit-Fenster, dichterer Zeitraffer). Selbst Stufe 3 braucht nur wenige Megabyte RAM und wenige Prozent eines CPU-Kerns – die Grenze ist die Genauigkeit des Radars, nicht der Rechner. Beim Wechsel wird das Gelernte umgerastert statt gelöscht.

**Grenzen (gewollt):** Das Modell kann ausschließlich die Konfidenz einzelner Detektionen senken. Es erzeugt nie Personen, ändert nie die Konfiguration, ist nach oben begrenzt und jederzeit abschalt- und zurücksetzbar. Hereinlaufende oder von zwei Sensoren gesehene Personen werden immer erkannt.

### Auto-Abgleich mehrerer Sensoren

Eine Person steht in dem Bereich, den mehrere Sensoren sehen. Berücksichtigt werden nur Sensoren, die die Person gerade sehen und deren Messung nicht zu weit vom Mittel entfernt ist. Der Konsens ist ein entfernungsgewichtetes Mittel: Der nähere Sensor gilt als genauer und wird weniger korrigiert (gleicher Abstand → je die Hälfte; 1 : 2 → 1/3 zu 2/3).

## Einstellungen

Integration → **Konfigurieren → Algorithmen & Zeiten**:

| Einstellung | Standard | Wirkung |
|---|---|---|
| Nachlaufzeit der Zonen | 10 s | Zone bleibt nach der letzten Person so lange belegt (je Zone überschreibbar) |
| Mindestdauer neuer Personen | 1 s | Neue ortsfeste Detektionen müssen so lange bestehen |
| Eingefroren nach | 3 s | Ein Target ganz ohne Änderung gilt als hängend |
| Sitz-/Liege-Modus nach | 5 s | |
| Sitz-/Liege-Radius | 0,7 m | |
| Glättung in Bewegung / im Sitz-/Liege-Modus | 0,25 s / 2,5 s | Zeitkonstanten |
| Zonen-Austrittspuffer / im Sitz-/Liege-Modus | 0,2 m / 0,45 m | |
| Zusammenfassen mehrerer Sensoren bis | 0,9 m | |
| Targets hinter Wänden verwerfen / Wandtoleranz | an / 1,2 m | Bis zur Toleranz außerhalb des Raums an die Wand setzen, weiter außerhalb verwerfen |
| Maximale Gehgeschwindigkeit | 3 m/s | |
| Lernender Geisterfilter / Stärke | an / 50 % | |
| Lerngeschwindigkeit / Gedächtnis | normal / 14 Tage | |
| Rechenlast des Lernmodells | 2 | 1 sparsam · 2 ausgewogen · 3 maximal |
| Auto-Abgleich: max. Abstand | 2 m | |

Unter **Darstellung & Bearbeiten**: Panel an/aus, Panel-Titel (leer = Standardtitel) und der Abschnitt **Bearbeiten**:

- **Bearbeitungs-PIN** – standardmäßig aus. Der PIN ist nur aktiv, wenn das Feld eine Eingabe enthält (4 Ziffern).
- **Bearbeiten auch für Nicht-Administratoren erlauben** – standardmäßig dürfen nur Administratoren bearbeiten. Mit Haken darf jeder Benutzer bearbeiten; der PIN ist dann der einzige Schutz vor ungewollten Änderungen – also unbedingt einen setzen.

## Dienste

| Dienst | Beschreibung |
|---|---|
| `zone_presence.start_learning_calibration` | Lernkalibrierung jetzt starten (optional `duration` in min) |
| `zone_presence.schedule_learning_calibration` | Einmalig für `time` planen (optional `duration`) |
| `zone_presence.abort_learning_calibration` | Laufende Lernkalibrierung abbrechen |
| `zone_presence.reset_learning_model` | Alles Gelernte löschen |
| `zone_presence.import_legacy` | Räume, Zonen und Kalibrierung aus der früheren YAML-/Package-Lösung übernehmen |

## Tipps zum LD2450 (ESPHome)

- X/Y-Sensoren drosseln, z. B. `filters: [ throttle: 250ms ]` – entlastet Home Assistant und reicht für die Zonen-Logik völlig.
- Eine Achse entweder in ESPHome (`multiply: -1` nur an **X**) **oder** im Sensor-Panel der Karte („X-Achse spiegeln“) spiegeln – nicht beides.
- Eine ganz ruhig sitzende Person erzeugt beim LD2450 meist trotzdem winzige Wertänderungen und bleibt sichtbar. Hängt der ESP, verschwindet das Target nach *Eingefroren nach*.
- Ein Ventilator, ein Vorhang oder ein Fenster, das ständig Geister erzeugt: KI-Modell-Ansicht öffnen – die Problemstelle zeigt sich dort meist und wird mit einem Klick zur Sperrzone.

## Fehlersuche

- **Karte zeigt „Verbinde …“ oder einen Fehler**: Ist die Integration eingerichtet und geladen? Browser neu laden.
- **Personen erscheinen gespiegelt**: „X-Achse spiegeln“ im Sensor-Panel.
- **Personen werden nicht erkannt**: ◎ einschalten – unbestätigte Detektionen und verworfene Geister werden angezeigt. In der KI-Modell-Ansicht nachsehen (ist die Stelle magenta?), den Bereich vergessen oder die *Stärke des Geisterfilters* senken bzw. das Lernmodell zurücksetzen.
- **Eine Person vor einem Möbelstück wird spät erkannt**: Kann ein zweiter Sensor nicht hinter das Möbel sehen, gilt das eventuell als „fehlender Zeuge“. Meist lernt das Modell die Stelle innerhalb weniger Tage als echte Aktivität.
- **Diagnose**: Integration → ⋮ → *Diagnose herunterladen* (enthält Konfiguration, Tracks, Modell-Statistik).

## Entwicklung

```bash
python -m unittest discover -s tests -p "test_*.py"   # Engine, Modell, Laufzeit (läuft ohne HA)
npm install --no-save playwright && npx playwright install chromium
node tests/browser/run.js tests/browser/out            # Browser-Test der Karten (Deutsch + Englisch)
```

Die Engine (`engine.py`, `ghost_model.py`, `model_view.py`, `geometry.py`) ist reines Python ohne Home-Assistant-Abhängigkeit.
