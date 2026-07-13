from abc import ABC, abstractmethod
from typing import List
import pandas as pd

class BaseScanner(ABC):
    @abstractmethod
    def scan_ticker(self, ticker: str, df: pd.DataFrame) -> List[int]:
        """
        Scan a single ticker's DataFrame.
        Returns a list of Unix-timestamps (seconds) where the condition was met.
        Empty list = no match.
        """
        pass

    @abstractmethod
    def get_parameters(self) -> dict:
        """
        Return the parameters of the scanner.
        """
        pass

