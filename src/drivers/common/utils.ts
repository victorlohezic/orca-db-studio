// Sizes and durations as people read them, for the messages every engine shows.

/** A byte count, for the binary placeholder. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** A duration, for the message a timed-out query fails with. */
export function formatSeconds(ms: number): string {
  const seconds = Math.round(ms / 100) / 10
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`
}
