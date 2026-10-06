#!/bin/bash
set -e

# ==========================================
# CONFIGURATION
# ==========================================
ENV_FILE="/home/daniel/openBrain/.env"
DOCKER_COMPOSE_FILE="/home/daniel/openBrain/docker-compose.yml"
LOCAL_BACKUP_DIR="/storage/backups/supabase"
TMP_DUMP="/tmp/supabase_backup.dump"

# Maximale Anzahl lokal vorgehaltener Dumps (Rotation nach Aenderungszeit). Default: 3
MAX_LOCAL_DUMPS="${MAX_LOCAL_DUMPS:-3}"

source "$ENV_FILE"

if ! mkdir -p "$LOCAL_BACKUP_DIR" 2>/dev/null; then
    echo "[WARN] Cannot create or access $LOCAL_BACKUP_DIR. Local backup will be skipped."
    LOCAL_BACKUP_ENABLED=false
else
    LOCAL_BACKUP_ENABLED=true
fi

# ==========================================
# 1. GENERATE LOCAL DUMP
# ==========================================
echo "[$(date)] Starting backup process..."
docker compose -f "$DOCKER_COMPOSE_FILE" exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -F c > "$TMP_DUMP"

# ==========================================
# 2. DETERMINE FILENAMES
# ==========================================
DAY_OF_YEAR=$(date +%j | sed 's/^0*//')
MODULO=$((DAY_OF_YEAR % 3))
DAILY_NAME="supabase_daily_${MODULO}.dump"
WEEKLY_NAME="supabase_weekly.dump"
DAY_OF_WEEK=$(date +%u)

FILES_TO_UPLOAD=("$DAILY_NAME")
if [ "$DAY_OF_WEEK" -eq 7 ]; then
    FILES_TO_UPLOAD+=("$WEEKLY_NAME")
fi

# ==========================================
# 3. LOCAL BACKUP FIRST (must never depend on Google)
#    WICHTIG: erfolgt VOR dem Token-Abruf. Ein Token- oder Upload-Fehler
#    darf das lokale Backup niemals verhindern.
# ==========================================
if [ "$LOCAL_BACKUP_ENABLED" = true ]; then
    for NAME in "${FILES_TO_UPLOAD[@]}"; do
        cp "$TMP_DUMP" "$LOCAL_BACKUP_DIR/$NAME"
        echo "[$(date)] Local backup written: $LOCAL_BACKUP_DIR/$NAME"
    done

    # Retention: nur die neuesten MAX_LOCAL_DUMPS Dumps behalten
    mapfile -t OLD_DUMPS < <(ls -1t "$LOCAL_BACKUP_DIR"/supabase_*.dump 2>/dev/null | tail -n +$((MAX_LOCAL_DUMPS + 1)))
    for OLD in "${OLD_DUMPS[@]:-}"; do
        [ -n "$OLD" ] || continue
        echo "[$(date)] Pruning old local dump: $OLD"
        rm -f "$OLD"
    done
else
    echo "[WARN] Local backup disabled; continuing with cloud upload only."
fi

# ==========================================
# 4. GET GOOGLE ACCESS TOKEN (optional, non-fatal)
# ==========================================
echo "[$(date)] Requesting Google access token..."
AUTH_RESPONSE=$(curl -s -X POST https://oauth2.googleapis.com/token -d client_id="$GOOGLE_CLIENT_ID" -d client_secret="$GOOGLE_CLIENT_SECRET" -d refresh_token="$GOOGLE_REFRESH_TOKEN" -d grant_type=refresh_token || true)
ACCESS_TOKEN=$(printf '%s' "$AUTH_RESPONSE" | jq -r '.access_token // empty' 2>/dev/null || true)

# ==========================================
# 5. UPLOAD FUNCTION
# ==========================================
upload_to_gdrive() {
    local FILE_NAME=$1
    echo "[$(date)] Uploading $FILE_NAME to Google Drive..."

    SEARCH_RESPONSE=$(curl -s -G "https://www.googleapis.com/drive/v3/files" -H "Authorization: Bearer $ACCESS_TOKEN" --data-urlencode "q=name='$FILE_NAME' and trashed=false" --data-urlencode "fields=files(id)")
    FILE_ID=$(printf '%s' "$SEARCH_RESPONSE" | jq -r '.files[0].id // empty' 2>/dev/null || true)

    if [ -n "$FILE_ID" ]; then
        echo "[$(date)] File exists (ID: $FILE_ID). Overwriting..."
        curl -s -X PATCH "https://www.googleapis.com/upload/drive/v3/files/$FILE_ID?uploadType=media" -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: application/octet-stream" --data-binary @"$TMP_DUMP" > /dev/null
    else
        echo "[$(date)] File does not exist. Creating new..."
        curl -s -X POST "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart" -H "Authorization: Bearer $ACCESS_TOKEN" -F "metadata={\"name\":\"$FILE_NAME\"};type=application/json;charset=UTF-8" -F "file=@$TMP_DUMP;type=application/octet-stream" > /dev/null
    fi
}

# ==========================================
# 6. EXECUTE CLOUD UPLOAD (non-fatal)
# ==========================================
if [ -n "$ACCESS_TOKEN" ]; then
    for NAME in "${FILES_TO_UPLOAD[@]}"; do
        upload_to_gdrive "$NAME" || echo "[WARN] $(date) Upload failed for $NAME (local backup remains intact)."
    done
else
    echo "[WARN] $(date) Could not obtain Google access token. Skipping cloud upload; local backup is intact."
    printf '%s\n' "$AUTH_RESPONSE"
fi

# ==========================================
# 7. CLEANUP
# ==========================================
rm -f "$TMP_DUMP"
echo "[$(date)] Backup completed (local=$LOCAL_BACKUP_ENABLED, cloud=$([ -n "$ACCESS_TOKEN" ] && echo ok || echo skipped))."
