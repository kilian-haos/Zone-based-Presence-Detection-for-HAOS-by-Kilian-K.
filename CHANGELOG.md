# Changelog

## 1.0.0 – 2026-10-30

Erste Version als Home-Assistant-Integration (Nachfolger der privaten YAML-/Package-Beta-Test-Lösung „Präsenz-Zonen“ v2.1).

- Alle Algorithmen laufen serverseitig: Karte und Binärsensoren zeigen dasselbe Ergebnis.
- Einrichtung per Oberfläche, automatische Erkennung der Target-/Presence-Entitäten eines Geräts.
- Je Zone ein eigenes Gerät mit Binärsensor „<Name> (Zone N)“ und Sensor „Personenanzahl“; je Raum „Personenanzahl“.
- Sitz-/Liege-Erkennung mit Dämpfung und Zonen-Austrittspuffer, Stuck-Erkennung, Presence-Gate, Wandfilter.
- Lernender Geisterfilter mit einmaliger, planbarer Lernkalibrierung und kontinuierlichem Lernen.
- Auto-Abgleich mehrerer Sensoren (distanzgewichtet), rote Kalibrier-Kegel (Einzel/Raum), Rückgängig/Wiederholen.
- Karte wird automatisch geladen, optionales Seitenleisten-Panel.
- Import der bisherigen Package-Lösung (`zone_presence.import_legacy`).
