import pLimit from "p-limit";

export async function runLimitedPhase<T>(
  jobs: ReadonlyArray<() => Promise<T>>,
  concurrency: number
): Promise<T[]> {
  const limit = pLimit(concurrency);
  const results = new Array<T>(jobs.length);
  const completed = new Array<boolean>(jobs.length).fill(false);
  let firstError: unknown;

  await Promise.all(
    jobs.map((job, index) =>
      limit(async () => {
        if (firstError !== undefined) return;
        try {
          results[index] = await job();
          completed[index] = true;
        } catch (error) {
          if (firstError === undefined) firstError = error;
        }
      })
    )
  );

  if (firstError !== undefined) throw firstError;
  if (completed.some((value) => !value)) {
    throw new Error("Phase completed without producing every result.");
  }
  return results;
}
