export function startPolling(task, intervalMs) {
  let stopped = false;
  let inFlight = false;

  const run = async () => {
    if (stopped || inFlight) return false;
    inFlight = true;
    try {
      await task();
      return true;
    } finally {
      inFlight = false;
    }
  };

  void run().catch(() => undefined);
  const timer = setInterval(() => void run().catch(() => undefined), intervalMs);
  return {
    run,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}