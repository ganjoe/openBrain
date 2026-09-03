import time
import logging
import threading
import multiprocessing
import queue
from datetime import datetime, timezone
from typing import Callable, Generator, Optional, Dict, Any

logger = logging.getLogger(__name__)

class QueueHandler(logging.Handler):
    """Logs to a queue so we can stream them to an API response."""
    def __init__(self, log_queue: queue.Queue):
        super().__init__()
        self.log_queue = log_queue

    def emit(self, record):
        msg = self.format(record)
        self.log_queue.put(msg)

class JobManager:
    """
    Manages the state and live progress of feature calculation jobs.
    Requirement F-SYS-030: Job Overlap Protection & Progress Tracking.
    """
    _instance = None
    _lock = threading.Lock()

    _is_running: bool
    _internal_lock: threading.Lock
    _stage: str
    _total_tickers: int
    _completed_tickers: int
    _failed_tickers: int
    _current_ticker: str
    _start_time: float
    _pass1_start_time: float
    _elapsed_seconds: float
    _avg_time_per_ticker_ms: float
    _eta_seconds: float
    _last_run: Dict[str, Any]

    def __new__(cls):
        """Singleton pattern to ensure only one JobManager tracks the state."""
        with cls._lock:
            if cls._instance is None:
                cls._instance = super(JobManager, cls).__new__(cls)
                cls._instance._is_running = False
                cls._instance._internal_lock = threading.Lock()
                cls._instance._internal_manager = multiprocessing.Manager()
                cls._instance._stage = "IDLE"
                cls._instance._total_tickers = 0
                cls._instance._completed_tickers = 0
                cls._instance._failed_tickers = 0
                cls._instance._current_ticker = ""
                cls._instance._start_time = 0.0
                cls._instance._pass1_start_time = 0.0
                cls._instance._elapsed_seconds = 0.0
                cls._instance._avg_time_per_ticker_ms = 0.0
                cls._instance._eta_seconds = 0.0
                cls._instance._last_run = {}
            return cls._instance

    def set_stage(self, stage: str, total_tickers: int = 0):
        with self._internal_lock:
            self._stage = stage
            if total_tickers > 0:
                self._total_tickers = total_tickers
            if stage in ("STARTING", "PASS_0_PRECOMPUTE"):
                self._start_time = time.perf_counter()
                self._completed_tickers = 0
                self._failed_tickers = 0
                self._avg_time_per_ticker_ms = 0.0
                self._eta_seconds = 0.0
            elif stage == "PASS_1_PROCESSING":
                self._pass1_start_time = time.perf_counter()

    def update_progress(self, completed: int, total: int, current_ticker: str = "", failed_count: int = 0):
        with self._internal_lock:
            self._completed_tickers = completed
            self._total_tickers = total
            self._failed_tickers = failed_count
            if current_ticker:
                self._current_ticker = current_ticker
            
            now = time.perf_counter()
            self._elapsed_seconds = round(now - self._start_time, 2) if self._start_time > 0 else 0.0
            
            # Calculate metrics for pass 1 processing
            if completed > 0 and self._pass1_start_time > 0:
                pass1_elapsed = now - self._pass1_start_time
                self._avg_time_per_ticker_ms = round((pass1_elapsed / completed) * 1000, 2)
                remaining = max(0, total - completed)
                self._eta_seconds = round(remaining * (self._avg_time_per_ticker_ms / 1000), 1)
            elif completed == total:
                self._eta_seconds = 0.0

    def record_completion(self, success_count: int, failed_count: int, data_points: int, duration_seconds: float):
        with self._internal_lock:
            self._stage = "IDLE"
            self._is_running = False
            self._completed_tickers = success_count + failed_count
            self._failed_tickers = failed_count
            self._eta_seconds = 0.0
            self._last_run = {
                "finished_at": datetime.now(timezone.utc).isoformat(),
                "duration_seconds": round(duration_seconds, 2),
                "total_tickers": self._total_tickers,
                "success_count": success_count,
                "failed_count": failed_count,
                "data_points": data_points,
                "avg_time_per_ticker_ms": self._avg_time_per_ticker_ms,
                "status": "SUCCESS" if failed_count == 0 else "PARTIAL_SUCCESS"
            }

    def record_failure(self, error_message: str):
        with self._internal_lock:
            self._stage = "IDLE"
            self._is_running = False
            self._last_run = {
                "finished_at": datetime.now(timezone.utc).isoformat(),
                "duration_seconds": round(time.perf_counter() - self._start_time, 2) if self._start_time > 0 else 0,
                "total_tickers": self._total_tickers,
                "status": "FAILED",
                "error": error_message
            }

    def get_detailed_status(self) -> Dict[str, Any]:
        with self._internal_lock:
            pct = round((self._completed_tickers / self._total_tickers * 100), 1) if self._total_tickers > 0 else 0.0
            elapsed = round(time.perf_counter() - self._start_time, 2) if (self._is_running and self._start_time > 0) else self._elapsed_seconds
            
            return {
                "is_running": self._is_running,
                "stage": self._stage,
                "total_tickers": self._total_tickers,
                "completed_tickers": self._completed_tickers,
                "failed_tickers": self._failed_tickers,
                "current_ticker": self._current_ticker,
                "progress_pct": pct,
                "elapsed_seconds": elapsed,
                "avg_time_per_ticker_ms": self._avg_time_per_ticker_ms,
                "eta_seconds": self._eta_seconds,
                "last_run": self._last_run
            }

    def start_feature_calculation(self, run_func: Callable, *args, **kwargs) -> bool:
        """
        Attempts to start the feature calculation job in a background thread.
        Returns True if started successfully, False if already running.
        Passes all kwargs (e.g. priority) through to run_func.
        """
        with self._internal_lock:
            if self._is_running:
                logger.warning("Feature calculation trigger ignored: A process is already running.")
                return False
            self._is_running = True

        # Run in background thread so API doesn't block
        thread = threading.Thread(target=self._run_wrapper, args=(run_func, args, kwargs))
        thread.daemon = True
        thread.start()
        
        priority = kwargs.get('priority')
        logger.info("Feature calculation job started in background.%s", f" Priority: {priority}" if priority else "")
        return True

    def stream_feature_calculation(self, run_func: Callable, *args, **kwargs) -> Generator[str, None, None]:
        """
        Runs the feature calculation and yields log lines in real-time.
        Requires the job not to be running.
        """
        with self._internal_lock:
            if self._is_running:
                yield "Error: A feature calculation process is already running.\n"
                return
            self._is_running = True

        # Use a persistent Manager to create a proxy queue that can be pickled
        # and safely passed to ProcessPoolExecutor worker processes. This avoids 
        # destroying the Manager proxy when the HTTP stream generator exits early.
        mp_queue = self._internal_manager.Queue()
        handler = QueueHandler(mp_queue)
        handler.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))
        
        # Attach to the root logger to capture all logs in the main process
        target_logger = logging.getLogger()
        target_logger.addHandler(handler)
        target_logger.setLevel(logging.DEBUG)
        
        # Shared stop event for the generator loop
        done = threading.Event()

        # Inject the queue into kwargs so it can be passed to run_func and then to workers
        kwargs['log_queue'] = mp_queue

        def run_and_signal():
            try:
                run_func(*args, **kwargs)
            except Exception as e:
                # Since we are in a thread but the main work is in processes,
                # this catch is for errors in the thread itself.
                import traceback
                error_details = traceback.format_exc()
                logger.error(f"ERROR in runner thread:\n{error_details}")
                mp_queue.put(f"ERROR in runner thread: {e}\n{error_details}")
            finally:
                done.set()
                target_logger.removeHandler(handler)
                with self._internal_lock:
                    self._is_running = False

        thread = threading.Thread(target=run_and_signal)
        thread.start()

        # Yield from queue until done
        while not done.is_set() or not mp_queue.empty():
            try:
                msg = mp_queue.get(timeout=0.1)
                if hasattr(msg, 'getMessage'):  # Check if it's a LogRecord
                    msg = f"{msg.asctime if hasattr(msg, 'asctime') else ''} | {msg.levelname} | {msg.getMessage()}"
                yield str(msg) + "\n"
            except (queue.Empty, EOFError):
                continue

    def _run_wrapper(self, run_func, args, kwargs):
        try:
            logger.info("Background job execution started.")
            run_func(*args, **kwargs)
        except Exception as e:
            logger.error(f"Background job failed with exception: {e}")
        finally:
            with self._internal_lock:
                self._is_running = False
                logger.info("Background job execution finished. System ready for re-trigger.")

    @property
    def is_running(self) -> bool:
        with self._internal_lock:
            return self._is_running
