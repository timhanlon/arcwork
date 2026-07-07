/**
 * The distillation prompt: a single user message wrapping the rendered timeline,
 * with the instructions placed AFTER the transcript.
 *
 * Instruction placement is load-bearing. A small local model reads a leading
 * instruction as just more context and then continues the transcript's last task
 * (writing code, answering the final question) instead of summarizing. With the
 * transcript first and the instruction last, the model's most recent tokens are
 * the summarization ask, so it summarizes. Bump {@link PROMPT_VERSION} whenever
 * the wording below changes — it is part of the summary's idempotency key, so a
 * reworded prompt distills a fresh summary rather than colliding with an old one.
 */

export const PROMPT_VERSION = 1

// Section structure + precision requirements mirror the compaction summaries the
// distiller is meant to reproduce (exact paths/hashes, quoted user words, whole
// session covered, nothing invented).
const INSTRUCTIONS = `The text above is a condensed timeline of a coding-agent chat session (USER / ASSISTANT / SUBAGENT / TOOL lines, truncated). Your ONLY job is to write a compaction summary of the ENTIRE session so a fresh agent can continue the work. Do NOT continue, answer, or redo any task from the timeline itself.

Output exactly these markdown sections:
## Primary Request and Intent
## Key Technical Concepts
## Files and Code Sections
## Errors and Fixes
## User Preferences and Feedback
## Current State
## Remaining Work

Be precise: exact file paths, commit hashes, API names, quoted user words. Cover the WHOLE session from the beginning, not just the end. Do not invent details.`

/** Wrap a rendered timeline into the single distillation user message. */
export const buildDistillPrompt = (timeline: string): string =>
  `SESSION TIMELINE START\n${timeline}\nSESSION TIMELINE END\n\n${INSTRUCTIONS}`
