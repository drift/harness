import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runAgent, type AgentOptions } from '../src/agent.ts'
import { guardBash, verifyCommand } from '../src/hooks.ts'
import { DONE_TOKEN, runRalph } from '../src/ralph.ts'
import { defaultTools } from '../src/tools.ts'
import { call, fakeModel, say, type FakeModel } from './fake-model.ts'

let model: FakeModel | undefined
afterEach(async () => { await model?.close(); model = undefined })

function project(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-test-'))
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text)
  return root
}

function options(fake: FakeModel, root: string, extra: Partial<AgentOptions> = {}): AgentOptions {
  return { client: fake.client, model: 'claude-opus-5-5', effort: 'low', system: 'test system', tools: defaultTools, root, ...extra }
}

describe('the loop', () => {
  it('runs a tool, feeds the result back, and stops when the model is done', async () => {
    const root = project({ 'hello.txt': 'kia ora' })
    model = await fakeModel([call(['read_file', { path: 'hello.txt' }]), say('It says kia ora.')])

    const result = await runAgent([{ role: 'user', content: 'what does hello.txt say?' }], options(model, root))

    expect(result.outcome).toBe('done')
    expect(result.finalText).toBe('It says kia ora.')
    expect(model.requests).toHaveLength(2)
    // The second request carries the whole conversation: the API is stateless.
    const second = model.requests[1].messages
    expect(second.map(m => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(second[2].content).toMatchObject([{ type: 'tool_result', content: 'kia ora' }])
  })

  it('returns all parallel tool results in a single user message', async () => {
    const root = project({ 'a.txt': 'A', 'b.txt': 'B' })
    model = await fakeModel([call(['read_file', { path: 'a.txt' }], ['read_file', { path: 'b.txt' }]), say('done')])

    await runAgent([{ role: 'user', content: 'read both' }], options(model, root))

    const results = model.requests[1].messages[2].content as { tool_use_id: string, content: string }[]
    expect(results.map(r => r.content)).toEqual(['A', 'B'])
  })

  it('sends a stable prefix and the request settings on every call', async () => {
    model = await fakeModel([call(['list_files', { path: '.' }]), say('done')])
    await runAgent([{ role: 'user', content: 'look around' }], options(model, project({ 'x.txt': '' })))

    const [first, second] = model.requests
    expect(second.system).toEqual(first.system)
    expect(second.tools).toEqual(first.tools)
    expect(first).toMatchObject({ output_config: { effort: 'low' }, cache_control: { type: 'ephemeral' }, fallbacks: 'default' })
    expect(first.tools?.every(tool => 'strict' in tool && tool.strict)).toBe(true)
  })

  it('stops at the turn cap instead of looping forever', async () => {
    model = await fakeModel(Array.from({ length: 5 }, () => call(['list_files', { path: '.' }])))
    const result = await runAgent([{ role: 'user', content: 'loop' }], options(model, project(), { maxTurns: 3 }))
    expect(result.outcome).toBe('max_turns')
    expect(model.requests).toHaveLength(3)
  })

  it('accumulates token usage across turns', async () => {
    model = await fakeModel([call(['list_files', { path: '.' }]), say('done')])
    const result = await runAgent([{ role: 'user', content: 'go' }], options(model, project()))
    expect(result.usage).toEqual({ input: 200, output: 40, cacheRead: 80, cacheWrite: 0 })
  })
})

describe('tools', () => {
  it('edits a file only when old_str is unique', async () => {
    const root = project({ 'f.txt': 'one two two' })
    model = await fakeModel([
      call(['edit_file', { path: 'f.txt', old_str: 'two', new_str: '2' }]),
      call(['edit_file', { path: 'f.txt', old_str: 'one', new_str: '1' }]),
      say('done'),
    ])
    await runAgent([{ role: 'user', content: 'edit' }], options(model, root))

    expect(model.requests[1].messages[2].content).toMatchObject([{ is_error: true, content: 'old_str appears 2 times; include more context' }])
    expect(readFileSync(join(root, 'f.txt'), 'utf8')).toBe('1 two two')
  })

  it('refuses paths outside the project and reports it to the model', async () => {
    model = await fakeModel([call(['read_file', { path: '../../etc/passwd' }]), say('ok')])
    await runAgent([{ role: 'user', content: 'escape' }], options(model, project()))
    expect(model.requests[1].messages[2].content).toMatchObject([{ is_error: true, content: expect.stringContaining('escapes the project root') }])
  })

  it('reports an unknown tool as an error instead of crashing', async () => {
    model = await fakeModel([call(['teleport', {}]), say('ok')])
    const result = await runAgent([{ role: 'user', content: 'x' }], options(model, project()))
    expect(result.outcome).toBe('done')
    expect(model.requests[1].messages[2].content).toMatchObject([{ is_error: true, content: 'unknown tool: teleport' }])
  })
})

describe('hooks', () => {
  it('preToolUse can deny a call, and the model sees why', async () => {
    model = await fakeModel([call(['bash', { command: 'git push origin main' }]), say('ok')])
    await runAgent([{ role: 'user', content: 'ship it' }], options(model, project(), { hooks: { preToolUse: guardBash() } }))
    expect(model.requests[1].messages[2].content).toMatchObject([{ is_error: true, content: expect.stringContaining('denied: blocked by harness policy') }])
  })

  it('the stop hook sends failures back until the check passes', async () => {
    const root = project({ 'status.txt': 'red' })
    model = await fakeModel([
      say('All done!'),
      call(['edit_file', { path: 'status.txt', old_str: 'red', new_str: 'green' }]),
      say('Fixed it.'),
    ])
    const stop = verifyCommand('grep -q green status.txt', root)

    const result = await runAgent([{ role: 'user', content: 'make it green' }], options(model, root, { hooks: { stop } }))

    expect(result.outcome).toBe('done')
    expect(model.requests).toHaveLength(3)
    expect(model.requests[1].messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('failed (exit 1)') })
  })

  it('the stop hook gives up after maxStopBlocks so a stuck agent cannot loop', async () => {
    const root = project()
    model = await fakeModel([say('done'), say('done'), say('done')])
    const result = await runAgent([{ role: 'user', content: 'x' }], options(model, root, { hooks: { stop: verifyCommand('false', root) }, maxStopBlocks: 2 }))
    expect(result.outcome).toBe('stop_hook_gave_up')
    expect(model.requests).toHaveLength(3)
  })
})

describe('ralph', () => {
  it('starts every iteration with a fresh context and stops on the done token', async () => {
    const root = project({ 'PROMPT.md': 'Work through PLAN.md.' })
    model = await fakeModel([say('did item 1'), say('did item 2'), say(`all done ${DONE_TOKEN}`)])

    const result = await runRalph({ ...options(model, root), promptFile: join(root, 'PROMPT.md'), maxIterations: 5 })

    expect(result).toMatchObject({ finished: true, iterations: 3 })
    expect(model.requests.map(r => r.messages.length)).toEqual([1, 1, 1])
  })

  it('stops at the iteration cap', async () => {
    const root = project({ 'PROMPT.md': 'go' })
    model = await fakeModel([say('a'), say('b')])
    const result = await runRalph({ ...options(model, root), promptFile: join(root, 'PROMPT.md'), maxIterations: 2 })
    expect(result).toMatchObject({ finished: false, iterations: 2 })
  })
})
