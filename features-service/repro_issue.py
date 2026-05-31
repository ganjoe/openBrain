import sys
from pathlib import Path
import multiprocessing

# Add src to path
sys.path.insert(0, str(Path(__file__).parent) + "/src")

try:
    from main import run_feature_pipeline
    print("Successfully imported run_feature_pipeline")
except Exception as e:
    print(f"Failed to import run_feature_pipeline: {e}")
    import traceback
    traceback.print_exc()

def mock_run(log_queue=None):
    print("Running mock_run")
    # This is what we want to test
    try:
        from main import run_feature_pipeline
        run_feature_pipeline(log_queue=None)
    except Exception as e:
        print(f"Error in mock_run: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    mock_run()
