import multiprocessing
import logging
import logging.handlers
import queue
import time

def worker(q):
    # Setup logging in worker
    root = logging.getLogger()
    handler = logging.handlers.QueueHandler(q)
    root.addHandler(handler)
    root.setLevel(logging.DEBUG)
    
    logging.info("Hello from worker!")
    logging.error("Error from worker!")

if __name__ == "__main__":
    q = multiprocessing.Queue()
    p = multiprocessing.Process(target=worker, args=(q,))
    p.start()
    
    logs = []
    # Give it some time to work
    start_time = time.time()
    while time.time() - start_time < 2:
        try:
            msg = q.get(timeout=0.1)
            logs.append(msg)
        except queue.Empty:
            continue
    p.join()
    print(f"Captured logs: {logs}")
    if len(logs) > 0:
        print("SUCCESS")
    else:
        print("FAILURE")
