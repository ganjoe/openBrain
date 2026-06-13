import sys
import os

sys.path.append(os.path.join(os.path.dirname(__file__), 'agent-srm/dashboard-backend'))
from main import advance_time, AdvanceTimeRequest

print("Testing advance_time...")
res = advance_time(AdvanceTimeRequest(target_date="2026-06-13"))
print("Result:", res)
