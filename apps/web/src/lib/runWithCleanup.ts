/** Runs cleanup after success, rejection, or a synchronous operation failure. */
export async function runWithCleanup<T>(
  operation: () => Promise<T>,
  cleanup: () => void,
): Promise<T> {
  try {
    return await operation();
  } finally {
    cleanup();
  }
}
