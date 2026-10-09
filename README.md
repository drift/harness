# harness

A small coding agent in under 600 lines of commented TypeScript, built to learn how agents like Claude Code work inside rather than just using them.

It has the same core parts: the loop, tools, a permission hook, a verify-on-stop hook, token and cost accounting, a full transcript of every request and response, and Geoffrey Huntley's Ralph loop.

## Run it

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...          # or `ant auth login`

# One task. Asks before every shell command and edit.
npm start -- --root ../drift.nz "explain how the water seal gets its colour"

# The agent can't finish until verify passes.
npm start -- --root ../drift.nz --verify "npm run verify" "add a test for the 20-message chat limit"

# Chat mode: every prompt continues the same conversation.
npm start -- --root ../drift.nz

# Ralph: fresh context every iteration, state lives on disk.
npm start -- --root ../drift.nz --ralph PROMPT.md --verify "npm run verify" --max-iterations 5 --yolo
```

Defaults: `claude-opus-5-5` at `--effort medium`. For cheap experiments, try `--model claude-haiku-5-5` or `--effort low`.

`npm run verify` runs typecheck and 13 tests against a scripted fake model. No key, no tokens.

## How it works, file by file

| File | What it teaches | The Claude Code equivalent |
|---|---|---|
| `src/agent.ts` | **The loop.** Call the model, append its reply, run the tools it asked for, append the results, repeat. The API is stateless: the conversation is just an array you resend each time. | The core agent loop |
| `src/tools.ts` | **Tools are just schemas plus your functions.** The model only *asks*. Your code decides what runs. Paths are confined to the project because model output is untrusted. | Read, Edit, Bash, Glob |
| `src/hooks.ts` | **The harness gets the final say.** `preToolUse` can deny a call. `stop` can refuse to let the model finish. | `PreToolUse` and `Stop` hooks, permission prompts |
| `src/usage.ts` | **Every turn has a price.** Watch cache reads grow as the stable prefix gets reused. | `/cost` |
| `src/transcript.ts` | **Read what the model actually saw.** | `--verbose`, session logs |
| `src/ralph.ts` | **Fresh context beats long context.** Each iteration starts empty and re-reads state from disk. | `/loop`, Huntley's Ralph |
| `test/fake-model.ts` | **The model is just an HTTP endpoint.** Script it, and you can test a harness deterministically. | |

## Things to notice in your first real run

1. Open the transcript (`.harness/transcripts/*.jsonl`). Each request contains the *entire* conversation so far. That growth is why long sessions get slow and expensive, and why compaction exists.
2. A tool call is not an action. It's a JSON block the model emits. Try denying one and watch the model adapt.
3. Run with `--verify` on a task the model gets slightly wrong. The failing output goes back as a user message, and that's how the agent corrects itself.
4. Compare `--effort low` with `--effort high` on the same task: tokens, turns, and whether the result passes verify.
5. `cache read` should be most of your input from turn 2 on. If it's zero, something in `system` or `tools` is changing between calls.

## Exercises

Each one adds a real piece of a production harness. Write a failing test against the fake model first.

1. **Streaming.** Switch to `client.beta.messages.stream()` and print text as it arrives. Use `finalMessage()` to get the result.
2. **Subagents.** Add a `task` tool that calls `runAgent` with a fresh messages array and returns only the final text. This is how Claude Code keeps its main context small.
3. **Skills.** Add a `load_skill` tool that reads `skills/<name>/SKILL.md` on demand, and list only the skill names and descriptions in the system prompt. This is progressive disclosure.
4. **Context limits.** Add a token budget. When it's near, summarise old turns or drop old tool results, then measure what breaks.
5. **Parallel tools.** Run read-only tool calls concurrently. Keep edits and bash sequential. Ask yourself why.
6. **Evals.** Write 10 small tasks with a check for each. Run them before and after every harness change. This is how you know a change helped instead of guessing.
