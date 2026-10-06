import pandas as pd
import numpy as np

# Simulate a global calendar
global_calendar = pd.date_range("2023-01-01", "2023-01-15", freq="D")

# Simulate a stock that traded on 1st, 2nd, 5th, 6th, and then stopped.
# Notice gaps: 3rd, 4th (e.g. weekend), and after 6th (delisted).
dates = pd.to_datetime(["2023-01-01", "2023-01-02", "2023-01-05", "2023-01-06"])
values = [True, False, True, True]

s = pd.Series(values, index=dates)

# Reindex to global calendar and forward fill with limit
s_reindexed = s.reindex(global_calendar)
s_ffill = s_reindexed.ffill(limit=5) # 5 days forward fill limit

print("Original:")
print(s)
print("\nReindexed:")
print(s_reindexed)
print("\nFFill limit 5:")
print(s_ffill)
print("\nFFill limit 5 as int (to see counts):")
print(s_ffill.astype(float))
