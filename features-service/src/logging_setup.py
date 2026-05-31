import logging
import sys
import re
from pathlib import Path

GREY = "\033[90m"
CYAN = "\033[36m"
MAGENTA = "\033[35m"
YELLOW = "\033[33m"
RED = "\033[31m"
BOLD_RED = "\033[31;1m"
RESET = "\033[0m"

TICKER_RE = re.compile(r"\b([A-Z]{1,5})\b")
NUMBER_RE = re.compile(r"(\b\d+(\.\d+)?\b)")

class ColoredFormatter(logging.Formatter):
    COLORS = {
        logging.DEBUG: GREY,
        logging.INFO: RESET,
        logging.WARNING: YELLOW,
        logging.ERROR: RED,
        logging.CRITICAL: BOLD_RED,
    }

    def format(self, record: logging.LogRecord) -> str:
        color = self.COLORS.get(record.levelno, RESET)
        msg = str(record.msg)
        if record.args:
            try:
                msg = msg % record.args
            except Exception:
                pass
        msg = TICKER_RE.sub(f"{CYAN}\\1{RESET}{color}", msg)
        msg = NUMBER_RE.sub(f"{MAGENTA}\\1{RESET}{color}", msg)
        time_str = self.formatTime(record, "%H:%M:%S")
        level_str = record.levelname.ljust(8)
        module_str = record.name[:20].ljust(20)
        if "════" in msg:
            return f"{color}{msg}{RESET}"
        return f"{time_str} | {color}{level_str}{RESET} | {GREY}{module_str}{RESET} | {color}{msg}{RESET}"

def configure_logging(log_dir: str) -> None:
    log_dir_path = Path(log_dir)
    log_dir_path.mkdir(parents=True, exist_ok=True)

    fmt = "%(asctime)s | %(levelname)-8s | %(name)-25s | %(message)s"
    datefmt = "%d.%m.%Y %H:%M:%S"
    formatter = logging.Formatter(fmt, datefmt=datefmt)

    root = logging.getLogger()
    root.setLevel(logging.DEBUG)

    stream_handler = logging.StreamHandler(sys.stdout)
    stream_handler.setLevel(logging.DEBUG)
    stream_handler.setFormatter(ColoredFormatter())
    root.addHandler(stream_handler)

    file_handler = logging.FileHandler(log_dir_path / "error.log", encoding="utf-8")
    file_handler.setLevel(logging.ERROR)
    file_handler.setFormatter(formatter)
    root.addHandler(file_handler)

    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
