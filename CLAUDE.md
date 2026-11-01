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
