// The agent's hands. A tool is three things:
//   1. a name and description the model reads to decide when to call it,
//   2. a JSON Schema for its input (the model fills this in),
//   3. a function *you* run when the model asks.
// The model never touches your machine. It only emits a `tool_use` block, and
// this file decides what actually happens.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'

export type ToolResult = { content: string, isError?: boolean }

export type Tool = {
  definition: Anthropic.Beta.BetaTool
  run: (input: Record<string, unknown>, root: string) => ToolResult
}

const MAX_OUTPUT = 30_000
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.harness', 'dist'])

// Model output is untrusted. Every path goes through here so `../../etc/passwd`
// or an absolute path can't escape the project.
export function confine(root: string, path: string): string {
  const target = resolve(root, path)
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`path escapes the project root: ${path}`)
  }
  return target
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT) return text
  return `${text.slice(0, MAX_OUTPUT)}\n… [truncated ${text.length - MAX_OUTPUT} characters]`
}

// `strict: true` makes the API guarantee the input matches the schema. That
// requires every property to be listed in `required` and no extras allowed.
function schema(properties: Record<string, { type: 'string', description: string }>) {
  return {
    type: 'object' as const,
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  }
}

function str(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string') throw new Error(`"${key}" must be a string`)
  return value
}

const listFiles: Tool = {
  definition: {
    name: 'list_files',
    description: 'List files under a directory in the project, recursively. Use "." for the project root.',
    input_schema: schema({ path: { type: 'string', description: 'Directory relative to the project root.' } }),
    strict: true,
  },
  run(input, root) {
    const start = confine(root, str(input, 'path'))
    const out: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (out.length >= 500) return
        if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue
        const full = join(dir, entry.name)
        out.push(relative(root, full) + (entry.isDirectory() ? '/' : ''))
        if (entry.isDirectory()) walk(full)
      }
    }
    walk(start)
    return { content: out.join('\n') || '(empty)' }
  },
}

const readFile: Tool = {
  definition: {
    name: 'read_file',
    description: 'Read a text file from the project.',
    input_schema: schema({ path: { type: 'string', description: 'File path relative to the project root.' } }),
    strict: true,
  },
  run(input, root) {
    const path = confine(root, str(input, 'path'))
    if (!existsSync(path) || statSync(path).isDirectory()) {
      return { content: `no such file: ${str(input, 'path')}`, isError: true }
    }
    return { content: truncate(readFileSync(path, 'utf8')) }
  },
}

// The same contract as Claude Code's Edit tool: replace one exact, unique
// string. Uniqueness forces the model to quote enough context to be precise.
const editFile: Tool = {
  definition: {
    name: 'edit_file',
    description:
      'Edit a file by replacing old_str with new_str. old_str must appear exactly once. '
      + 'To create a new file, pass an empty old_str and the full contents as new_str.',
    input_schema: schema({
      path: { type: 'string', description: 'File path relative to the project root.' },
      old_str: { type: 'string', description: 'Exact text to replace, or "" to create the file.' },
      new_str: { type: 'string', description: 'Replacement text.' },
    }),
    strict: true,
  },
  run(input, root) {
    const path = confine(root, str(input, 'path'))
    const oldStr = str(input, 'old_str')
    const newStr = str(input, 'new_str')

    if (oldStr === '') {
      if (existsSync(path)) return { content: 'file already exists; pass old_str to edit it', isError: true }
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, newStr)
      return { content: `created ${str(input, 'path')}` }
    }

    if (!existsSync(path)) return { content: `no such file: ${str(input, 'path')}`, isError: true }
    const text = readFileSync(path, 'utf8')
    const count = text.split(oldStr).length - 1
    if (count === 0) return { content: 'old_str not found', isError: true }
    if (count > 1) return { content: `old_str appears ${count} times; include more context`, isError: true }
    writeFileSync(path, text.replace(oldStr, () => newStr))
    return { content: `edited ${str(input, 'path')}` }
  },
}

const bash: Tool = {
  definition: {
    name: 'bash',
    description: 'Run a shell command in the project root and return its exit code and output. Times out after 120s.',
    input_schema: schema({ command: { type: 'string', description: 'The command to run.' } }),
    strict: true,
  },
  run(input, root) {
    const result = spawnSync('bash', ['-c', str(input, 'command')], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
    })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    const code = result.error ? `error: ${result.error.message}` : `exit ${result.status}`
    return { content: truncate(`${code}\n${output}`), isError: result.status !== 0 }
  },
}

export const defaultTools: Tool[] = [listFiles, readFile, editFile, bash]
