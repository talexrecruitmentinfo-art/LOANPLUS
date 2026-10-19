export interface PollingController {
  run(): Promise<boolean>;
  stop(): void;
}

export function startPolling(task: () => Promise<void>, intervalMs: number): PollingController;