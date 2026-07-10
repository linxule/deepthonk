export type PhaseJob<T> = (signal: AbortSignal) => Promise<T>;

export interface RunLimitedPhaseOptions {
  signal?: AbortSignal;
}

export const maxPhaseConcurrency = 1_024;

export async function runLimitedPhase<T>(
  jobs: Iterable<PhaseJob<T>>,
  concurrency: number,
  options: RunLimitedPhaseOptions = {}
): Promise<T[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > maxPhaseConcurrency) {
    throw new RangeError(
      `Phase concurrency must be a positive integer no greater than ${maxPhaseConcurrency}, got ${concurrency}.`
    );
  }
  const iterator = jobs[Symbol.iterator]();
  const results: T[] = [];
  const controller = new AbortController();
  let nextIndex = 0;
  let firstError: unknown;
  const abort = (): void => {
    if (firstError === undefined) firstError = abortReason(options.signal);
    if (!controller.signal.aborted) controller.abort(firstError);
  };
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });

  const worker = async (): Promise<void> => {
    while (firstError === undefined) {
      const next = iterator.next();
      if (next.done) return;
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await next.value(controller.signal);
      } catch (error) {
        if (firstError === undefined) {
          firstError = error;
          if (!controller.signal.aborted) controller.abort(error);
        }
        return;
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  } finally {
    options.signal?.removeEventListener("abort", abort);
    if (firstError !== undefined) iterator.return?.();
  }
  if (firstError !== undefined) throw firstError;
  return results;
}

function abortReason(signal: AbortSignal | undefined): unknown {
  if (signal?.reason !== undefined) return signal.reason;
  const error = new Error("Phase aborted.");
  error.name = "AbortError";
  return error;
}
