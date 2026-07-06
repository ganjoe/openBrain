import time
import os
import json
import uuid
import paho.mqtt.publish as publish
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
from datetime import datetime, timezone

# Konfiguration
WATCH_DIR = os.path.join(os.path.dirname(__file__), "lists")
MQTT_BROKER_HOST = os.environ.get("MQTT_BROKER_HOST", "localhost")
MQTT_BROKER_PORT = int(os.environ.get("MQTT_BROKER_PORT", "1883"))
TARGET_AGENT = "srm"
TOPIC = f"agents/{TARGET_AGENT}/inbox"

# Falls Skript nicht im Container läuft, sondern direkt im Host, localhost probieren
# Du kannst MQTT_BROKER_HOST in der Shell setzen.

class WatchlistHandler(FileSystemEventHandler):
    def on_created(self, event):
        if not event.is_directory and event.src_path.endswith(".txt"):
            filename = os.path.basename(event.src_path)
            # Kurz warten, falls die Datei noch geschrieben wird
            time.sleep(1)
            self.notify_agent(filename)
            
    def notify_agent(self, filename):
        unix_ts = int(time.time())
        date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        
        envelope = {
            "header": {
                "from": "system",
                "to": TARGET_AGENT,
                "date": date_str,
                "unix": unix_ts,
                "msg_type": "chat"
            },
            "content": {
                "text": f"Eine neue Watchlist '{filename}' wurde soeben in /backtesting/lists/ abgelegt. Du kannst den Inhalt mit 'manage_local_watchlist' lesen, entscheiden ob du einen Backtest auslösen möchtest, und die Datei anschließend archivieren."
            }
        }
        
        payload = json.dumps(envelope)
        try:
            publish.single(TOPIC, payload, hostname=MQTT_BROKER_HOST, port=MQTT_BROKER_PORT)
            print(f"[{datetime.now().strftime('%H:%M:%S')}] Benachrichtigung für '{filename}' gesendet.")
        except Exception as e:
            print(f"Fehler beim Senden der MQTT Nachricht: {e}")

if __name__ == "__main__":
    if not os.path.exists(WATCH_DIR):
        os.makedirs(WATCH_DIR)
        
    event_handler = WatchlistHandler()
    observer = Observer()
    observer.schedule(event_handler, WATCH_DIR, recursive=False)
    observer.start()
    
    print(f"Watching {WATCH_DIR} for new .txt files... (MQTT: {MQTT_BROKER_HOST}:{MQTT_BROKER_PORT})")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()
