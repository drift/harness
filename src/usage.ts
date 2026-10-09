// Token accounting. Every response reports what it cost; the harness adds it up.
// Watch cacheRead climb on later turns: that's the cached prefix (system +
// tools + earlier messages) being reused at a fraction of the input price.

import type Anthropic from '@anthropic-ai/sdk'

export type Usage = { input: number, output: number, cacheRead: number, cacheWrite: number }

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

export function addUsage(total: Usage, usage: Anthropic.Beta.BetaUsage): Usage {
  return {
    input: total.input + usage.input_tokens,
    output: total.output + usage.output_tokens,
    cacheRead: total.cacheRead + (usage.cache_read_input_tokens ?? 0),
    cacheWrite: total.cacheWrite + (usage.cache_creation_input_tokens ?? 0),
  }
}

// US$ per million tokens. Cache writes (5-minute TTL) cost 1.25x input.
const PRICES: Record<string, { input: number, output: number, cacheRead: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  // Haiku's cache-read rate assumed at the usual 0.1x input; check current pricing.
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
}

export function sumUsage(a: Usage, b: Usage): Usage {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite }
}

export function estimateCost(model: string, usage: Usage): number | undefined {
  const price = PRICES[model]
  if (!price) return undefined
  return (
    usage.input * price.input
    + usage.output * price.output
    + usage.cacheRead * price.cacheRead
    + usage.cacheWrite * price.input * 1.25
  ) / 1_000_000
}

export function formatUsage(model: string, usage: Usage): string {
  const cost = estimateCost(model, usage)
  const dollars = cost === undefined ? 'unknown price' : `~US$${cost.toFixed(4)}`
  return `in ${usage.input} · out ${usage.output} · cache read ${usage.cacheRead} · cache write ${usage.cacheWrite} · ${dollars}`
}
