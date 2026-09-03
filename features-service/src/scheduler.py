import asyncio
import logging
import os
import threading
import time
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, Optional
import httpx

logger = logging.getLogger(__name__)

DEFAULT_CONFIG: Dict[str, Any] = {
    "enabled": False,
    "mode": "INTERVAL",  # "INTERVAL" or "DAILY"
    "interval_minutes": 60,
    "daily_time_utc": "22:00",
    "last_run_at": None,
    "next_run_at": None,
}

class FeatureScheduler:
    """
    Background scheduler for cyclical feature calculation.
    Persists configuration in Supabase system_settings ('features_schedule_config').
    """
    _instance = None
    _lock = threading.Lock()

    def __new__(cls):
        with cls._lock:
            if cls._instance is None:
                cls._instance = super(FeatureScheduler, cls).__new__(cls)
                cls._instance._config = DEFAULT_CONFIG.copy()
                cls._instance._running = False
                cls._instance._thread = None
                cls._instance._stop_event = threading.Event()
            return cls._instance

    @property
    def config(self) -> Dict[str, Any]:
        return self._config.copy()

    def _get_supabase_auth_headers(self) -> Dict[str, str]:
        service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
        return {
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        }

    def _get_postgrest_url(self) -> str:
        return os.environ.get("POSTGREST_URL", "http://postgrest:3000").rstrip("/")

    def load_config_from_db(self) -> Dict[str, Any]:
        """Fetch schedule config from Supabase system_settings."""
        try:
            url = f"{self._get_postgrest_url()}/system_settings"
            headers = self._get_supabase_auth_headers()
            with httpx.Client(timeout=5.0) as client:
                res = client.get(url, params={"key": "eq.features_schedule_config", "select": "value"}, headers=headers)
                if res.status_code == 200:
                    data = res.json()
                    if data and len(data) > 0 and "value" in data[0]:
                        loaded = data[0]["value"]
                        self._config.update(loaded)
                        logger.info("Loaded features schedule config from Supabase DB: %s", self._config)
                        return self._config
        except Exception as e:
            logger.warning("Could not load schedule config from Supabase (using memory defaults): %s", e)
        return self._config

    def save_config_to_db(self, new_cfg: Dict[str, Any]) -> None:
        """Upsert schedule config to Supabase system_settings."""
        self._config.update(new_cfg)
        self._recalculate_next_run()
        try:
            url = f"{self._get_postgrest_url()}/system_settings"
            headers = self._get_supabase_auth_headers()
            headers["Prefer"] = "resolution=merge-duplicates"
            payload = {
                "key": "features_schedule_config",
                "value": self._config,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
            with httpx.Client(timeout=5.0) as client:
                res = client.post(url, json=payload, headers=headers)
                if res.status_code not in (200, 201, 204):
                    logger.warning("Supabase save config response %d: %s", res.status_code, res.text)
                else:
                    logger.info("Saved features schedule config to Supabase DB: %s", self._config)
        except Exception as e:
            logger.error("Failed to save schedule config to Supabase: %s", e)

    def _recalculate_next_run(self) -> None:
        if not self._config.get("enabled", False):
            self._config["next_run_at"] = None
            return

        now = datetime.now(timezone.utc)
        mode = self._config.get("mode", "INTERVAL").upper()

        if mode == "INTERVAL":
            mins = max(5, int(self._config.get("interval_minutes", 60)))
            self._config["interval_minutes"] = mins
            next_dt = now + timedelta(minutes=mins)
            self._config["next_run_at"] = next_dt.isoformat()
        elif mode == "DAILY":
            daily_str = self._config.get("daily_time_utc", "22:00")
            try:
                hour, minute = map(int, daily_str.split(":"))
            except Exception:
                hour, minute = 22, 0
                self._config["daily_time_utc"] = "22:00"

            target_today = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
            if target_today <= now:
                target_dt = target_today + timedelta(days=1)
            else:
                target_dt = target_today
            self._config["next_run_at"] = target_dt.isoformat()

    def start(self, run_pipeline_func: Any) -> None:
        """Starts the background scheduler thread."""
        if self._running:
            return
        self._running = True
        self._stop_event.clear()
        self.load_config_from_db()
        if self._config.get("enabled") and not self._config.get("next_run_at"):
            self._recalculate_next_run()

        self._thread = threading.Thread(target=self._loop, args=(run_pipeline_func,), daemon=True)
        self._thread.start()
        logger.info("FeatureScheduler background worker started.")

    def stop(self) -> None:
        self._running = False
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=2)
        logger.info("FeatureScheduler stopped.")

    def _loop(self, run_pipeline_func: Any) -> None:
        from job_manager import JobManager
        jm = JobManager()

        while not self._stop_event.is_set():
            try:
                # Check DB periodically for config changes
                if self._config.get("enabled", False):
                    next_run_str = self._config.get("next_run_at")
                    if next_run_str:
                        next_run = datetime.fromisoformat(next_run_str)
                        now = datetime.now(timezone.utc)
                        if now >= next_run:
                            if not jm.is_running:
                                logger.info("⏰ Scheduled trigger fired! Starting feature calculation pipeline...")
                                success = jm.start_feature_calculation(run_pipeline_func)
                                if success:
                                    self._config["last_run_at"] = now.isoformat()
                                    self._recalculate_next_run()
                                    # Update DB with new run timestamps
                                    self.save_config_to_db(self._config)
                            else:
                                logger.info("⏰ Scheduled trigger deferred: A job is already in progress.")
            except Exception as e:
                logger.error("Error in scheduler loop: %s", e)

            # Sleep 15 seconds between checks
            self._stop_event.wait(15.0)
