import pytest
import time
from src.job_manager import JobManager

def test_job_manager_singleton():
    jm1 = JobManager()
    jm2 = JobManager()
    assert jm1 is jm2

def test_job_manager_prevents_overlap():
    jm = JobManager()
    
    # Reset state just in case (since it's a singleton)
    with jm._internal_lock:
        jm._is_running = False

    def long_job():
        time.sleep(0.5)

    # Start first job
    success1 = jm.start_feature_calculation(long_job)
    assert success1 is True
    assert jm.is_running is True

    # Attempt to start second job immediately
    success2 = jm.start_feature_calculation(long_job)
    assert success2 is False
    
    # Wait for first job to finish
    time.sleep(0.7)
    assert jm.is_running is False
    
    # Now it should be possible again
    success3 = jm.start_feature_calculation(lambda: None)
    assert success3 is True

def test_job_manager_execution_error():
    jm = JobManager()
    with jm._internal_lock:
        jm._is_running = False
        
    def failing_job():
        raise ValueError("Boom")
        
    success = jm.start_feature_calculation(failing_job)
    assert success is True
    
    time.sleep(0.2)
    # Even if it failed, it should have reset is_running
    assert jm.is_running is False
