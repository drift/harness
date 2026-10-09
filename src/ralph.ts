// Geoffrey Huntley's "Ralph" loop, in its simplest form:
//
//   while :; do cat PROMPT.md | agent; done
//
// Each iteration starts with a FRESH context: no messages carried over. State
// lives on disk instead (a plan file, the code, git), so the model re-reads
// what matters every time rather than dragging a growing, stale transcript.
// The prompt usually says: pick the single most important item from the plan,
// do it, verify it, update the plan.
//
// This version adds the two things an unattended loop needs: a cap on
// iterations, and a way for the model to say the whole job is finished.

import { readFileSync } from 'node:fs'
import { runAgent, type AgentOptions, type AgentResult } from './agent.ts'
import { emptyUsage, sumUsage, type Usage } from './usage.ts'

export const DONE_TOKEN = 'RALPH_DONE'

export type RalphOptions = AgentOptions & {
  promptFile: string
  maxIterations: number
  onIteration?: (iteration: number, result: AgentResult) => void
}

export async function runRalph(options: RalphOptions): Promise<{ iterations: number, usage: Usage, finished: boolean }> {
  let total = emptyUsage()

  for (let iteration = 1; iteration <= options.maxIterations; iteration++) {
    // Re-read every time: you can steer a running loop by editing the prompt.
    const prompt = readFileSync(options.promptFile, 'utf8')
    const instructions = `${prompt}\n\nWhen every item in the plan is done and verified, end your reply with ${DONE_TOKEN}.`
    const result = await runAgent([{ role: 'user', content: instructions }], options)

    total = sumUsage(total, result.usage)
    options.onIteration?.(iteration, result)

    if (result.outcome === 'done' && result.finalText.includes(DONE_TOKEN)) {
      return { iterations: iteration, usage: total, finished: true }
    }
  }
  return { iterations: options.maxIterations, usage: total, finished: false }
}

