# Stammbaum — Claude-Projektregeln

## Bilder immer verknüpfen

Wenn der User im Chat ein Bild (JPG, PNG, WEBP, HEIC, PDF) teilt, das zu diesem Projekt gehört (Urkunden, Fotos, Dokumente), **sofort und ohne Rückfrage** in die Stammbaum-DB laden und mit allen betroffenen Personen verknüpfen.

Ablauf:
1. Analyse: welche Personen zeigt / betrifft das Bild? (Heiratsurkunde → beide Ehepartner; Geburtsurkunde → Kind + beide Eltern; Grabstein → verstorbene Person; Foto → alle abgebildeten Personen.)
2. Als Editor einloggen: `POST /api/auth/login {role:"editor",pin:…}` (Cookie-JAR).
3. Pro Bild: `POST /api/images?caption=<beschreibung>` (raw body, `Content-Type: image/jpeg|png|webp|heic|application/pdf`). Max 15 MB.
4. Pro betroffene Person: `POST /api/person-images {person_id, image_id, role}`. `role` beschreibt die Bedeutung des Bilds für diese Person: `"Heiratsurkunde"`, `"Geburtsurkunde (Kind)"`, `"Geburtsurkunde (Eltern)"`, `"Taufe"`, `"Sterbeurkunde"`, `"Trauerinnerung"`, `"Foto"`, `"Grabstein"`.
5. In der Antwort an den User nennen welche Personen welches Bild bekommen haben, nicht die image_ids.

Nie ein Bild nur analysieren und wegwerfen. Nie ein Bild in den Scratchpad legen, ohne es auch hochzuladen. Scratchpad ist Zwischenlager für den Upload, nicht Endlagerung.

Wenn mehrere Personen auf einem Bild stehen (Hochzeits-/Familienfoto), für jede eine Verknüpfung mit sinnvoller `role`.

## Namenskonventionen im Datenmodell

- `surname` = aktueller Nachname (bei verheirateten Frauen der Mann-Name).
- `birth_name` = Geburtsname (nur bei abweichendem Nachnamen setzen).
- `given_name` = alle Vornamen in Urkundenreihenfolge, mit Rufname an bevorzugter Stelle.
- Bei unleserlichen Teilen in `notes` dokumentieren („Vorname Urkunde 1939 unleserlich, Hypothese KI: Karl").

## Quellen in `notes`

Jede Person bekommt in `notes` eine kurze Quellenangabe: Standesamt + Nummer + Jahr, Trauerinnerung-Verlag, Kirchenbuch, Trauzeugen etc. So kann man später zurückverfolgen, woher ein Datum stammt.

## Dokumente ausschlachten (immer)

Jedes hochgeladene Dokument (Urkunde, Ausweis, Reisepass, Meldekarte, Zeugnis, Schulzeugnis, Militärpass, Trauerinnerung, Brief, Foto mit Metadaten) wird **vollständig analysiert** und die extrahierten Fakten als strukturierte Dossier-Einträge hinzugefügt — nicht nur im `notes`-Feld.

Zu prüfen und pro Treffer ein eigener Eintrag in die passende Sub-Ressource:

- **Adressen / Wohnorte** (Straße, Hausnummer, Stadt, Land, Zeitraum falls bekannt) → `POST /api/persons/:id/residences`. `kind` nutzen für Kontext: `Geburtsort`, `Kindheit/Jugend`, `Studienort`, `Elternhaus`, `Wehrdienst`, `Alterswohnsitz`, etc. In `notes` die Quelle (welches Dokument + welche Nummer belegt es).
- **Beruf / Ausbildung** (Lehrstelle, Studium, Arbeitgeber, Dienstgrad bei Militär, Beamtentitel) → `POST /api/persons/:id/jobs` oder `/education` oder `/military`.
- **Lebensdaten** die noch nicht in der Person-Row stehen (Geburt, Tod, Taufe, Heirat) → `PATCH /api/persons/:id`.
- **Beziehungen** die neu auftauchen (Zeugen, Trauzeugen, Paten, erwähnte Verwandte) → als neue Personen anlegen und mit Edges (parent/spouse/godparent) verknüpfen, sofern der Beleg eindeutig ist. Sonst in `notes` als Hypothese dokumentieren.
- **Ausweis-/Dokumentennummern** (Reisepassnummer, Personalausweisnummer, Standesamt-Registernummer, Melderegister-Nr., Kennbuchstaben) → in `notes` der Person oder des Dokument-Eintrags festhalten. Niemals wegwerfen.
- **Historische Hinweise** (Besatzungszone, politische Lage, Flucht/Vertreibung, Kriegseinsatz) → als `anecdotes`-Eintrag mit `source` = Dokument.

Format der `notes` bei strukturierten Einträgen: eine Zeile pro Fakt mit Quellen-Hinweis in Klammern, z. B. `"Belegt durch Personalausweis Britische Zone, A Nr. 175672, Kennbuchstaben EHD"`.

Immer in der Antwort an den User **auflisten**, welche strukturierten Einträge aus einem Dokument hinzugefügt wurden — nicht nur „habe das Bild verknüpft".
