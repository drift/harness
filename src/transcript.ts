// Every request and response, one JSON object per line. This is the best way
// to learn the internals: run a task, then read exactly what the model was
// sent and what it sent back.
//
//   jq -c 'select(.kind=="request") | .request.messages | length' .harness/transcripts/*.jsonl

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type Transcript = { path: string, write: (kind: string, data: unknown) => void }

export function openTranscript(root: string): Transcript {
  const dir = join(root, '.harness', 'transcripts')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`)
  return {
    path,
    write(kind, data) {
      appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), kind, ...(data as object) })}\n`)
    },
  }
}
