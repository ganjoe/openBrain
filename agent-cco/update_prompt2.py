with open("/home/daniel/openBrain/agent-cco/prompt.txt", "r", encoding="utf-8") as f:
    content = f.read()

# We want to replace the sections * `list_yt_videos` and * `list_online_yt_videos` in the prompt with * `show_yt_content`
# Also need to replace instructions that refer to list_online_yt_videos

# Let's find the YT-Transkripte block
start_marker = "* **`list_yt_videos`**"
end_marker = "* **`search_yt_content`**"

start_idx = content.find(start_marker)
end_idx = content.find(end_marker)

if start_idx != -1 and end_idx != -1:
    new_docs = """* **`show_yt_content`** — Listet Videos für einen YouTube-Channel auf (entweder aus der lokalen Datenbank oder live von YouTube).
  - `action`: `"DATABASE"` (für lokal gespeicherte Videos) oder `"ONLINE"` (für live auf YouTube verfügbare Videos)
  - `channel`: YouTube Handle oder fuzzy channel name
  - `limit`: optional, max Videos (Default: 10)
  - **WICHTIG (ONLINE-Modus):** Wenn der User frische Videos auf YouTube sehen will, nutze `action="ONLINE"`. Die Response enthält am Ende eine Zeile `URLs: ["...", "..."]` mit allen URLs. Wenn der User danach sagt "lade alle herunter" oder "verarbeite alle", nutze `video_urls=[]` in `manage_yt_sync` mit diesen URLs.
  - **WICHTIG (DATABASE-Modus):** Wenn der User fragt "welche Videos haben wir in der DB", nutze `action="DATABASE"`.

"""
    content = content[:start_idx] + new_docs + content[end_idx:]

# Also replace any other mention of list_online_yt_videos
content = content.replace("list_online_yt_videos", "show_yt_content(action=\"ONLINE\")")

with open("/home/daniel/openBrain/agent-cco/prompt.txt", "w", encoding="utf-8") as f:
    f.write(content)

print("Prompt updated.")
