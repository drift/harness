// A scripted stand-in for the Messages API. Each test queues the responses the
// "model" will give, runs the harness against it, then inspects exactly what
// the harness sent. No API key, no tokens, fully deterministic.

import Anthropic from '@anthropic-ai/sdk'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

type Block =
  | { type: 'text', text: string }
  | { type: 'tool_use', id: string, name: string, input: Record<string, unknown> }

export type Scripted = { content: Block[], stop_reason: 'end_turn' | 'tool_use' | 'refusal' | 'max_tokens' }

export const say = (text: string): Scripted => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' })

export const call = (...calls: [name: string, input: Record<string, unknown>][]): Scripted => ({
  content: calls.map(([name, input], i) => ({ type: 'tool_use', id: `toolu_${name}_${i}_${Math.random().toString(36).slice(2, 8)}`, name, input })),
  stop_reason: 'tool_use',
})

export type FakeModel = {
  client: Anthropic
  requests: Anthropic.Beta.MessageCreateParamsNonStreaming[]
  close: () => Promise<void>
}

export async function fakeModel(script: Scripted[]): Promise<FakeModel> {
  const queue = [...script]
  const requests: Anthropic.Beta.MessageCreateParamsNonStreaming[] = []

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    // Deep-copy: the harness keeps mutating its messages array after sending.
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))

    const next = queue.shift()
    if (!next) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'fake model: script exhausted' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id: `msg_${requests.length}`,
      type: 'message',
      role: 'assistant',
      model: 'fake',
      content: next.content,
      stop_reason: next.stop_reason,
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: requests.length > 1 ? 80 : 0, cache_creation_input_tokens: 0 },
    }))
  })

  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  const client = new Anthropic({ apiKey: 'fake', baseURL: `http://127.0.0.1:${port}`, maxRetries: 0 })
  return { client, requests, close: () => new Promise(done => server.close(() => done())) }
}
