#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// harness "fix the failing test"         one task, then exit
// harness                                chat: each message continues the same conversation
// harness --ralph PROMPT.md              Ralph loop: fresh context each iteration
//
// Options:
//   --root <dir>          project the agent works in (default: current directory)
//   --verify "<cmd>"      Stop hook: the agent can't finish until this passes
//   --model <id>          default claude-opus-5-5
//   --effort <level>      low | medium | high | xhigh | max (default medium)
//   --yolo                don't ask before shell commands and edits
//   --max-turns <n>       model calls per task (default 50)
//   --max-iterations <n>  Ralph iterations (default 10)

import Anthropic from '@anthropic-ai/sdk'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { runAgent, type AgentEvent, type AgentOptions } from './agent.ts'
import { askHuman, chain, guardBash, verifyCommand } from './hooks.ts'
import { runRalph } from './ralph.ts'
import { defaultTools } from './tools.ts'
import { openTranscript } from './transcript.ts'
import { formatUsage } from './usage.ts'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: 'string', default: process.cwd() },
    verify: { type: 'string' },
    model: { type: 'string', default: 'claude-opus-5-5' },
    effort: { type: 'string', default: 'medium' },
    yolo: { type: 'boolean', default: false },
    ralph: { type: 'string' },
    'max-turns': { type: 'string', default: '50' },
    'max-iterations': { type: 'string', default: '10' },
  },
})

const root = resolve(values.root)
const model = values.model
const efforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const effort = efforts.find(level => level === values.effort)
if (!effort) throw new Error(`--effort must be one of ${efforts.join(', ')}`)

// Kept free of anything that changes between runs (dates, random ids), so it
// stays a cache hit. Project-specific rules belong in the repo (AGENTS.md /
// CLAUDE.md), which the agent can read with its tools.
const system = [
  'You are a coding agent working in a single project directory through the tools provided.',
  'Read before you edit. Make the smallest change that does the job.',
  'Prove your work: run the project\'s tests or checks with the bash tool before saying you are done.',
  'If AGENTS.md or CLAUDE.md exists at the project root, read it first and follow it.',
  values.verify ? `The harness will run \`${values.verify}\` when you finish and send you any failures.` : '',
].filter(Boolean).join('\n')

const transcript = openTranscript(root)

function print(event: AgentEvent) {
  switch (event.type) {
    case 'text': console.log(`\n${event.text}`); break
    case 'tool_call': console.log(`\n→ ${event.name} ${JSON.stringify(event.input).slice(0, 200)}`); break
    case 'tool_result': console.log(`  ${event.isError ? '✗' : '✓'} ${event.content.split('\n')[0].slice(0, 160)}`); break
    case 'stop_hook': console.log(event.ok ? '\n✓ verify passed' : '\n✗ verify failed, sending the output back to the agent'); break
    case 'usage': console.log(`  [turn ${event.turn}] ${formatUsage(model, event.usage)}`); break
  }
}

const options: AgentOptions = {
  client: new Anthropic(),
  model,
  effort,
  system,
  tools: defaultTools,
  root,
  hooks: {
    preToolUse: values.yolo ? guardBash() : chain(guardBash(), askHuman()),
    stop: values.verify ? verifyCommand(values.verify, root) : undefined,
  },
  maxTurns: Number(values['max-turns']),
  transcript,
  onEvent: print,
}

console.log(`harness · ${model} · effort ${effort} · ${root}\ntranscript: ${transcript.path}`)

if (values.ralph) {
  const result = await runRalph({
    ...options,
    promptFile: resolve(values.ralph),
    maxIterations: Number(values['max-iterations']),
    onIteration: (i, r) => console.log(`\n=== iteration ${i}: ${r.outcome} after ${r.turns} turns ===`),
  })
  console.log(`\nralph ${result.finished ? 'finished' : 'stopped at the iteration cap'} after ${result.iterations} iterations · ${formatUsage(model, result.usage)}`)
} else if (positionals.length > 0) {
  const result = await runAgent([{ role: 'user', content: positionals.join(' ') }], options)
  console.log(`\n${result.outcome} after ${result.turns} turns · ${formatUsage(model, result.usage)}`)
} else {
  // Chat mode keeps one messages array across prompts: that's all "a
  // conversation" is.
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const messages: Anthropic.Beta.BetaMessageParam[] = []
  for (;;) {
    const line = (await rl.question('\n> ')).trim()
    if (!line || line === 'exit') break
    messages.push({ role: 'user', content: line })
    rl.pause()
    const result = await runAgent(messages, options)
    rl.resume()
    console.log(`\n[${result.outcome} · ${formatUsage(model, result.usage)}]`)
  }
  rl.close()
}
