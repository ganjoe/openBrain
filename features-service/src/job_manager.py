import threading
import logging
import multiprocessing
import queue
from typing import Callable, Generator

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
    Manages the state of the feature calculation job to prevent overlapping executions.
    Requirement F-SYS-030: Job Overlap Protection.
    """
    _instance = None
    _lock = threading.Lock()

    _is_running: bool
    _internal_lock: threading.Lock

    def __new__(cls):
        """Singleton pattern to ensure only one JobManager tracks the state."""
        with cls._lock:
            if cls._instance is None:
                cls._instance = super(JobManager, cls).__new__(cls)
                cls._instance._is_running = False
                cls._instance._internal_lock = threading.Lock()
                cls._instance._internal_manager = multiprocessing.Manager()
            return cls._instance

    def start_feature_calculation(self, run_func: Callable, *args, **kwargs) -> bool:
        """
        Attempts to start the feature calculation job in a background thread.
        Returns True if started successfully, False if already running.
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
        
        logger.info("Feature calculation job started in background.")
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
