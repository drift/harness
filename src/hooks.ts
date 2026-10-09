// Hooks are where the harness, not the model, gets the final say. These are
// the same two hooks drift.nz uses in Claude Code:
//
//   preToolUse  runs before every tool call. It can deny the call, and the
//               model sees the reason as the tool's result.
//   stop        runs when the model says it's finished. It can refuse, and the
//               feedback goes back to the model as a new user message. This is
//               "backpressure": the model can't stop on a red build.

import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'

export type PreToolUse = (name: string, input: Record<string, unknown>) => Promise<{ allow: true } | { allow: false, reason: string }>
export type Stop = () => Promise<{ ok: true } | { ok: false, feedback: string }>

export type Hooks = { preToolUse?: PreToolUse, stop?: Stop }

// Commands no agent should run unattended, whatever it was asked.
const NEVER = [/\brm\s+-rf\s+[/~]/, /\bgit\s+push\b/, /\bcurl\b.*\|\s*(ba)?sh/, /\bsudo\b/]

export function guardBash(): PreToolUse {
  return async (name, input) => {
    if (name !== 'bash') return { allow: true }
    const command = String(input.command)
    const hit = NEVER.find(pattern => pattern.test(command))
    return hit ? { allow: false, reason: `blocked by harness policy (${hit})` } : { allow: true }
  }
}

// Ask a person before any shell command or edit. Chain it after guardBash.
export function askHuman(): PreToolUse {
  return async (name, input) => {
    if (name !== 'bash' && name !== 'edit_file') return { allow: true }
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const summary = name === 'bash' ? input.command : input.path
    const answer = await rl.question(`\nallow ${name}: ${summary} ? [y/N] `)
    rl.close()
    return answer.trim().toLowerCase() === 'y' ? { allow: true } : { allow: false, reason: 'the user declined this call' }
  }
}

export function chain(...hooks: PreToolUse[]): PreToolUse {
  return async (name, input) => {
    for (const hook of hooks) {
      const verdict = await hook(name, input)
      if (!verdict.allow) return verdict
    }
    return { allow: true }
  }
}

// Run a shell command when the model claims it's done. Non-zero exit sends the
// tail of the output back to the model to fix.
export function verifyCommand(command: string, root: string): Stop {
  return async () => {
    const result = spawnSync('bash', ['-c', command], { cwd: root, encoding: 'utf8', timeout: 600_000 })
    if (result.status === 0) return { ok: true }
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(-60).join('\n')
    return {
      ok: false,
      feedback: `You said you were done, but \`${command}\` failed (exit ${result.status}). Fix the cause; don't weaken the check.\n\n${output}`,
    }
  }
}
