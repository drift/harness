// The agent loop. This is the whole trick behind every coding agent:
//
//   messages = [user prompt]
//   loop:
//     response = model(system, tools, messages)
//     append response to messages
//     if the model asked for tools: run them, append results, loop
//     if the model says it's done: ask the stop hook, maybe loop again
//
// The API is stateless. "Memory" is just this messages array, resent in full
// on every call. Everything else (permissions, verification, cost limits) is
// the harness deciding what to put in that array and when to stop.

import Anthropic from '@anthropic-ai/sdk'
import type { Hooks } from './hooks.ts'
import type { Tool } from './tools.ts'
import type { Transcript } from './transcript.ts'
import { addUsage, emptyUsage, type Usage } from './usage.ts'

type Message = Anthropic.Beta.BetaMessageParam
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type AgentEvent =
  | { type: 'text', text: string }
  | { type: 'tool_call', name: string, input: Record<string, unknown> }
  | { type: 'tool_result', name: string, content: string, isError: boolean }
  | { type: 'stop_hook', ok: boolean, feedback?: string }
  | { type: 'usage', usage: Usage, turn: number }

export type AgentOptions = {
  client: Anthropic
  model: string
  effort: Effort
  system: string
  tools: Tool[]
  root: string
  hooks?: Hooks
  maxTurns?: number
  maxStopBlocks?: number
  transcript?: Transcript
  onEvent?: (event: AgentEvent) => void
}

export type AgentResult = {
  messages: Message[]
  usage: Usage
  turns: number
  outcome: 'done' | 'max_turns' | 'refusal' | 'stop_hook_gave_up'
  finalText: string
}

export async function runAgent(messages: Message[], options: AgentOptions): Promise<AgentResult> {
  const { client, tools, root, hooks = {}, maxTurns = 50, maxStopBlocks = 3, onEvent = () => {} } = options
  const byName = new Map(tools.map(tool => [tool.definition.name, tool]))
  let usage = emptyUsage()
  let stopBlocks = 0
  let finalText = ''

  for (let turn = 1; turn <= maxTurns; turn++) {
    // Everything the model knows is in this one request. Keep `system` and
    // `tools` byte-identical between calls: they're the cached prefix, and any
    // change (a timestamp, a reordered tool) makes every call pay full price.
    const request: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model: options.model,
      max_tokens: 16_000,
      system: options.system,
      tools: tools.map(tool => tool.definition),
      messages,
      output_config: { effort: options.effort },
      cache_control: { type: 'ephemeral' },
      // If a safety classifier declines, the API retries on a fallback model
      // inside the same call instead of just stopping.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    }
    options.transcript?.write('request', { turn, request })
    const response = await client.beta.messages.create(request)
    options.transcript?.write('response', { turn, response })

    usage = addUsage(usage, response.usage)
    onEvent({ type: 'usage', usage, turn })

    // Append the assistant turn exactly as it came back, thinking blocks and
    // all. Never edit earlier turns: the API checks that history is append-only.
    messages.push({ role: 'assistant', content: response.content })

    for (const block of response.content) {
      if (block.type === 'text' && block.text) {
        finalText = block.text
        onEvent({ type: 'text', text: block.text })
      }
    }

    switch (response.stop_reason) {
      case 'tool_use': {
        // The model may ask for several tools at once. All their results go
        // back in ONE user message. Splitting them teaches the model to stop
        // calling tools in parallel.
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
        for (const block of response.content) {
          if (block.type !== 'tool_use') continue
          const input = block.input as Record<string, unknown>
          onEvent({ type: 'tool_call', name: block.name, input })
          const result = await callTool(byName.get(block.name), block.name, input, root, hooks)
          onEvent({ type: 'tool_result', name: block.name, content: result.content, isError: !!result.isError })
          results.push({ type: 'tool_result', tool_use_id: block.id, content: result.content, is_error: result.isError })
        }
        messages.push({ role: 'user', content: results })
        continue
      }

      case 'pause_turn':
        // A long server-side turn paused. Resend as-is to let it carry on.
        continue

      case 'refusal':
        return { messages, usage, turns: turn, outcome: 'refusal', finalText }

      case 'max_tokens':
        // A tool call cut off here would have truncated input. Don't run it.
        throw new Error('response hit max_tokens; raise max_tokens or ask for smaller steps')

      default: {
        // end_turn: the model thinks it's finished. The harness decides.
        const verdict = hooks.stop ? await hooks.stop() : { ok: true as const }
        onEvent({ type: 'stop_hook', ok: verdict.ok, feedback: verdict.ok ? undefined : verdict.feedback })
        if (verdict.ok) return { messages, usage, turns: turn, outcome: 'done', finalText }
        if (++stopBlocks > maxStopBlocks) return { messages, usage, turns: turn, outcome: 'stop_hook_gave_up', finalText }
        messages.push({ role: 'user', content: verdict.feedback })
      }
    }
  }

  return { messages, usage, turns: maxTurns, outcome: 'max_turns', finalText }
}

async function callTool(tool: Tool | undefined, name: string, input: Record<string, unknown>, root: string, hooks: Hooks) {
  if (!tool) return { content: `unknown tool: ${name}`, isError: true }
  const verdict = hooks.preToolUse ? await hooks.preToolUse(name, input) : { allow: true as const }
  if (!verdict.allow) return { content: `denied: ${verdict.reason}`, isError: true }
  try {
    return tool.run(input, root)
  } catch (error) {
    // A failing tool is information for the model, not a crash for the harness.
    return { content: error instanceof Error ? error.message : String(error), isError: true }
  }
}
