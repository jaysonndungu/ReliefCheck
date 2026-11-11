/** Stop waiting on cancellation while keeping a handler on the underlying operation. */
export async function waitForAbortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: (() => void) | undefined
  const cancellation = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([cancellation, operation])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}
