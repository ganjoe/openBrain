import requests
import json
import time
import subprocess

NEXUS_API = "http://localhost:7734/api"
AGENT_ID = "cco"

def set_provider(provider):
    print(f"📡 Setting provider for {AGENT_ID} to: {provider}...")
    r = requests.post(f"{NEXUS_API}/settings/provider", json={
        "agent_id": AGENT_ID,
        "provider": provider
    })
    r.raise_for_status()
    print("✅ API update successful.")

def send_message(text):
    print(f"💬 Sending message to {AGENT_ID}: '{text}'")
    r = requests.post(f"{NEXUS_API}/send", json={
        "from_agent": "boss",
        "to": AGENT_ID,
        "text": text
    })
    r.raise_for_status()
    print("✅ Message sent.")

def check_bot_logs():
    print(f"🔍 Checking logs of openbrain-cco-bot...")
    # Get last 10 lines
    logs = subprocess.check_output(["docker", "logs", "openbrain-cco-bot", "--tail", "20"]).decode()
    if f"Calling LLM (gemini)" in logs:
        print("🎉 SUCCESS: Bot is using Gemini!")
        return True
    elif f"Calling LLM (local)" in logs:
        print("❌ FAILURE: Bot is still using LM Studio (local).")
        return False
    else:
        print("❓ Could not find LLM provider log entry.")
        return None

if __name__ == "__main__":
    # 1. Switch to Gemini
    set_provider("gemini")
    
    # 2. Wait a bit for MQTT broadcast to arrive
    time.sleep(2)
    
    # 3. Send a test message
    send_message("Hallo, wer bist du? Antworte kurz.")
    
    # 4. Wait for processing
    print("⏳ Waiting for processing...")
    time.sleep(5)
    
    # 5. Check logs
    check_bot_logs()
