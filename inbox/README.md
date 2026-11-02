# Inbox

Hier Bilder/Dokumente reinwerfen. Ich (Claude) nehme sie beim nächsten Prompt mit „verarbeite inbox" (oder äquivalent):

1. Analysiere jedes File (OCR, Erkennung welche Person(en), welche Rolle)
2. Lade hoch via `/api/images` + verknüpfe mit Person(en)
3. Extrahiere strukturierte Fakten (Adressen → `/residences`, Berufe → `/jobs`, etc.) gemäß CLAUDE.md-Regel „Dokumente ausschlachten"
4. Verschiebe das verarbeitete File nach `inbox/processed/<datum>/` (nicht löschen — Backup)
5. Berichte dir pro File was ergänzt wurde

Formate: JPG, PNG, WEBP, HEIC, PDF. Max 15 MB per File.
