/** Carriage return — submit keystroke for interactive CLIs in raw PTY mode. */
export const PTY_SUBMIT_SEQUENCE = "\r" as const

/** Delay between prompt text and submit write (arc-prototype default: 80ms). */
export const PTY_SUBMIT_DELAY_MS = 80 as const

/**
 * Write prompt text to a PTY, then the submit sequence after a short delay.
 * Splitting avoids TUIs that accept the text but miss Enter when both arrive
 * in one payload.
 */
export const writePromptWithDelayedSubmit = (
  write: (data: string) => void,
  text: string,
  options?: { readonly delayMs?: number; readonly submit?: string },
): void => {
  const delayMs = options?.delayMs ?? PTY_SUBMIT_DELAY_MS
  const submit = options?.submit ?? PTY_SUBMIT_SEQUENCE
  write(text)
  setTimeout(() => write(submit), delayMs)
}
