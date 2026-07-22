import re

with open("/home/daniel/openBrain/agent-cco/prompt.txt", "r", encoding="utf-8") as f:
    content = f.read()

new_yt_block = """**7. YouTube-Transkripte (Phase 2 - Reiner Background Sync)**

* **`manage_yt_channels`** — YouTube-Channels verwalten.
  - `action`: `"LIST"`, `"ADD"`, oder `"REMOVE"`
  - `channel`: YouTube Handle (z.B. `@MarkMinervini`) oder Channel-URL
  - `notes`: optionaler Kontext (z.B. `"VCP/SEPA Methodology"`)
  - Funktioniert genau wie `manage_influencers` für X.

* **`manage_yt_sync`** — Steuert den periodischen YouTube-Hintergrund-Sync.
  - `action`: `"START"`, `"STOP"`, oder `"STATUS"`
  - `hours_back`: Optional für STATUS (Default: 24), um die Logs der letzten N Stunden abzufragen.
  - **WICHTIG:** Das Sync-Tool läuft periodisch im Hintergrund und sucht für alle aktiven Influencer nach neuen Videos. Es lädt ausschließlich die Roh-Transkripte in die Datenbank (`yt_videos`). Es ist KEIN LLM für Segmentierung involviert!
  - Nutze `action="STATUS"`, wenn der User fragt, "was macht der sync genau jetzt" oder "zeige mir den Status von heute". Das Tool gibt dann eine kompakte Liste der letzten Aktionen aus der Log-Tabelle zurück.

* **`list_yt_videos`** — Listet Videos für einen YouTube-Channel aus der Datenbank auf, sortiert nach Datum.
  - `channel`: YouTube Handle oder Fuzzy-Name
  - `limit`: max Videos (Default: 10, max: 50)
  - Zeigt den Status an (z.B. `downloaded`, `failed`, `pending`).

* **`list_online_yt_videos`** — Listet aktuell auf YouTube online verfügbare Videos eines Kanals live via yt-dlp auf (ohne Download).
  - `channel`: YouTube Handle oder Fuzzy-Name
  - `limit`: optional, max Videos

* **`search_yt_content`** — Suche in alten YouTube-Transkript-Blöcken (noch aus Phase 1).
"""

# Replace everything from "**7. YouTube-Transkripte**" up to "**8. Anti-Infinite-Loop Rule"
content = re.sub(r'\*\*7\. YouTube-Transkripte\*\*[\s\S]*?(?=\*\*8\. Anti-Infinite-Loop Rule)', new_yt_block, content)

with open("/home/daniel/openBrain/agent-cco/prompt.txt", "w", encoding="utf-8") as f:
    f.write(content)
