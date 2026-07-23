# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What This Is

Bees is an autonomous task management system with a Kanban board UI. Users create tasks via a chat interface; each task is a Hermes agent session that autonomously decides how to execute — doing the work itself, spawning child sessions, or creating cron jobs. After each agent turn, a lightweight completion judge evaluates whether the task is done and moves it to review automatically. The user never talks to child sessions or cron jobs directly; the task agent manages its own sub-resources.

## Prerequisites

- Node.js v20-v23 (Node.js 22 LTS recommended)
- Hermes agent installed with its Python venv (default location: `~/.hermes/hermes-agent/`)

The server spawns a Python worker subprocess that imports Hermes `AIAgent` directly — no `hermes gateway` process or HTTP API is involved. The Python executable is resolved in this order:

1. `HERMES_PYTHON` env var (explicit path)
2. `HERMES_AGENT_DIR/venv/bin/python` (if `HERMES_AGENT_DIR` is set)
3. `~/.hermes/hermes-agent/venv/bin/python` (default)
4. `python3` (system fallback)

## Commands

```bash
npm run dev          # dev mode: tsx watch + Vite dev server on :6969
npm run build        # production build: server (tsc) + client (vite) + copy .sql/.py assets
npm run start        # run compiled production build
npm run prod         # build + run production in one command
```

No test suite or linter is configured.

Note: `better-sqlite3` currently does not install cleanly on Windows under Node 24 without native build tooling. Use Node 22 LTS for local development unless you intentionally want to compile native addons with Visual Studio C++ tools.

## Architecture

```
Browser (React/Vite :6969)
  ↕ HTTP + SSE
Express API + Vite middleware (:6969)
  ↕ JSONL over stdin/stdout
Python worker (hermes_worker.py)
  ↕ direct Python import
Hermes AIAgent
```

- **Server** (`server/`): Express + SQLite (better-sqlite3, WAL mode). All timestamps are epoch milliseconds.
- **Python worker** (`server/workers/hermes_worker.py`): JSONL bridge that imports Hermes `AIAgent` directly. Spawned as a subprocess by `HermesWorkerAdapter`, auto-restarts on crash. Manages concurrent agent runs via semaphore (default: 10).
- **Client** (`client/`): React 19 + Vite + Tailwind CSS + Zustand + react-router. `@shared` path alias resolves to `../shared/`.
- **Shared** (`shared/types.ts`): TypeScript types used by both client and server.

### State directory

All persistent state lives under `BEES_HOME` (default: `~/.bees/`):
- `data/bees.db` — SQLite database
- `logs/` — log files
- `workspace/` — default working directory for Hermes task artifacts

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Agent communication | Python subprocess + JSONL | Imports Hermes AIAgent directly — no HTTP gateway overhead, structured streaming events, per-task model/reasoning control |
| Task execution | Autonomous agent session | Each task IS a Hermes session. The agent decides execution strategy (self, child session, cron job). Our backend doesn't manage sub-resources. |
| Completion judge | Lightweight LLM call after each agent turn | After a chat stream completes, the server sends the response to a `judge.completion` worker request. A fast judge model evaluates whether the task looks done and auto-moves to `in_review`. No polling, no prompt pollution — the judge runs outside the conversation. |
| Source of truth | Hermes SessionDB for chat history; Bees SQLite for task metadata; in-memory LiveChatRun for active streams | Hermes owns all transcripts and replay. Bees has no message table. `tasks.id` is the Hermes root session ID; Bees stores task metadata, per-task settings, and `last_agent_response_at`. During active streaming, `live-chat.ts` holds an in-memory `LiveChatRun` with accumulated messages. After streaming ends and the run TTL expires, chat history is projected from Hermes SessionDB on demand. |
| Status ownership | Judge auto-moves to `in_review`; human moves everything else via drag-drop | Clean separation: judge evaluates completion, human controls all manual transitions. |

## Key Patterns

- **Session lifecycle**: `tasks.id` is the Bees task ID and the Hermes root session ID. Chat and history reads all use `task.id`; Bees does not persist Hermes-returned child or continuation session IDs.
- **Chat projection**: `GET /tasks/:id/messages` loads raw rows from Hermes `SessionDB.get_messages()` via the Python worker, which filters out tool-call-only turns and empty messages. The client shows optimistic messages during streaming and loads the projected history from Hermes on page load/task switch.
- **Completion judge**: After each successful chat stream, `consumeChatRun()` fires a `judge.completion` request to the Python worker with the task title, description, and the agent's accumulated response text (truncated to ~4KB). The judge creates a throwaway AIAgent with `reasoning_effort=none`, evaluates the response, and returns `{done, reason}`. If `done=true` and the task is still `in_progress`, the server auto-moves it to `in_review` and broadcasts the update. Judge failures are non-critical — the task stays as-is.
- **Agent defaults**: Global default model/reasoning settings are stored in the Python worker via `settings.set` and surfaced through `GET /api/agent/defaults`. The Settings page lets users pick the default model (two-panel picker with search) and reasoning effort for all new tasks. Agent settings routes live in `server/routes/agent.ts`.
- **Per-task model/reasoning**: Each task can override the default Hermes model and reasoning effort (`agent_model`, `reasoning_effort` columns on `tasks`). Settings logic lives in `server/agent-settings.ts`. The Python worker resolves the final model/provider from Hermes config + per-task overrides.
- **Live chat**: `POST /api/tasks/:id/messages` returns `202` immediately with a `runId`. The server consumes the agent stream in the background via `consumeChatRun()` in `server/routes/chat.ts`. Clients subscribe to `GET /api/tasks/:id/live` SSE for real-time `text_delta`, `thinking_delta`, `tool_progress`, `done`, and `error` events. On connect, the client receives a snapshot of the current in-memory `LiveChatRun` if one exists. Runs are kept in memory briefly after completion (30s normal, 5min on error) so late-connecting clients can catch up.
- **Live-chat state** (`server/live-chat.ts`): In-memory `Map<taskId, LiveChatRun>` accumulates streaming events into structured messages (user + assistant with tools/thinking/usage). This is ephemeral — on server restart, active run state is lost, but the Hermes session history remains in SessionDB.
- **Command runtimes** (`server/adapters/command-runtime.ts`): Pluggable `AgentAdapter` for CLI runtimes (`codex`, `claude_code`, `opencode`) registered in `server/adapters/registry.ts`. Each chat message spawns the CLI with the prompt on stdin and normalizes stdout into `StreamEvent`s; these runtimes are stateless (no history replay between turns). Runtime metadata (label, install command, model/reasoning controls) lives in `server/runtime-config.ts`; per-task runtime/model/reasoning overrides flow through `taskRunSettings()`. OpenCode specifics: runs `opencode run --pure --format json --auto --thinking [--model provider/model]` using the user's real OpenCode config/auth (no XDG isolation), so authenticated providers (e.g. `opencode-go` with Kimi models) work. Model discovery shells out to `opencode models` and reads the default model from `opencode.json`/`opencode.jsonc`.
- **SSE board events**: `/api/events` broadcasts board-level events (task CRUD) to all clients. Separate from per-task live chat SSE.
- **Disconnect resilience**: If the browser disconnects during a stream, the server continues draining the worker stream to completion. On successful completion, `last_agent_response_at` is recorded for the task.
- **Cron jobs**: Hermes manages cron job state internally. Bees exposes endpoints to list, pause, resume, trigger, and remove jobs. Cron jobs link back to their originating task via `origin.platform === 'bees'`.
- **File browser**: `server/routes/files.ts` exposes CRUD operations on the `BEES_HOME/workspace/` directory (list, read, write, create, rename, delete, upload via multer). The client's `FileBrowserPage` provides a full file manager UI.
- **Skills catalog**: `server/skills/catalog.ts` discovers bundled skill definitions. Exposed via `server/routes/skills.ts` and rendered in the client's `SkillsPage`.
- **Server imports**: Use `.js` extensions in import paths (ESM with tsx).

## Task State Machine

```
               user creates
                    │
                    ▼
            ┌──────────────┐
  ┌─────────│  IN_PROGRESS  │◄─────────┐
  │         └───────┬───────┘          │
  │                 │                  │
  │     completion  │                  │ human moves
  │         judge   │                  │ (drag-drop)
  │      "done"     │                  │
  │                 │                  │
  │          ┌──────▼──────┐           │
  │          │  IN_REVIEW   │          │
  │          │  human       │          │
  │          │  verifies    │──────────┘
  │          └──────┬───────┘
  │                 │
  │                 │ human moves
  │                 │
  │          ┌──────▼──────┐
  └─────────►│    DONE      │
    human    │  verified    │
    moves    └─────────────┘
```

**Judge moves to**: `in_review` (via completion judge after each agent turn)
**Human moves to**: `in_progress`, `done` (via drag-and-drop or action buttons)

## Data Flows

### New Task → Agent Session

```
User creates task via UI
  → POST /api/tasks (creates task in SQLite; tasks.id is the Hermes root session ID)
  → Task appears on board in "In Progress" column
  → User sends first message via POST /api/tasks/:id/messages
  → Server returns 202 with runId; client subscribes to GET /tasks/:id/live SSE
  → Server calls consumeChatRun() with session ID equal to task.id
  → LiveChatRun accumulates text_delta/thinking/tools into in-memory messages
  → Each event is broadcast to /live SSE subscribers in real time
  → Python worker loads prior Hermes history, runs AIAgent.run_conversation()
  → Hermes persists the full turn (user + assistant) in SessionDB
  → Successful completion records tasks.last_agent_response_at
  → Run state expires from memory after TTL; history loads from Hermes on next page load
```

### Completion Judge

```
Chat stream completes (done event in consumeChatRun)
  → Accumulated response text available from stream
  → Fire judgeTaskCompletion() (async, non-blocking)
  → Send judge.completion request to Python worker with task title, description, response text
  → Worker creates throwaway AIAgent with reasoning_effort=none
  → Judge prompt asks: "given the task and response, is the task complete?"
  → Returns {done: boolean, reason: string}
  → IF done=true AND task.status === 'in_progress':
      → Update task status to 'in_review'
      → Broadcast task_updated event
  → IF done=false or judge fails: task stays as-is
```

## Worker Protocol

The Python worker communicates via JSONL (one JSON object per line) over stdin/stdout.

**Request types**: `health`, `chat`, `judge.completion`, `session.messages.get`, `session.get`, `settings.get`, `settings.set`, `models.list`, `cron.jobs.list`, `cron.jobs.get`, `cron.jobs.runs`, `cron.jobs.run.content`, `cron.jobs.pause`, `cron.jobs.resume`, `cron.jobs.run`, `cron.jobs.remove`, `cron.tick`

**Stream events** (emitted during `chat` requests):

| Event | Description |
|-------|-------------|
| `text_delta` | Agent's visible response text |
| `thinking_delta` | Agent's reasoning content |
| `tool_progress` | Tool lifecycle (`running` / `completed` / `error`) with name and duration |
| `done` | Stream complete — carries `sessionId` and `usage` |
| `error` | Error with message, optional `code` and `hint` |

**Thinking content**: Live reasoning streams as `thinking_delta`. Historical reasoning is projected from Hermes `reasoning_content` / `reasoning` into `msg.thinking` when available.

## Client Routes

| Path | Component | Description |
|------|-----------|-------------|
| `/` | `Board` | Kanban board (3 columns + drag-and-drop) |
| `/tasks/new` | `NewTaskPage` | Create task + initial chat with agent |
| `/tasks/:taskId` | `TaskDetailPage` | Task detail + chat thread |
| `/cron` | `CronPage` | View and manage Hermes cron jobs |
| `/skills` | `SkillsPage` | Browse bundled skill definitions |
| `/files` | `FileBrowserPage` | File manager for workspace directory |
| `/settings` | `SettingsPage` | Theme, default model + reasoning effort |

## Environment Variables

All optional — defaults work for local development.

```bash
PORT=6969                        # Web server port
HERMES_PYTHON=                   # Path to Python with Hermes deps (auto-detected if unset)
HERMES_AGENT_DIR=                # Path to Hermes agent dir (default: ~/.hermes/hermes-agent)
HERMES_AGENT_RUN_LIMIT=10        # Max concurrent agent runs in Python worker (chat + judge)
BEES_HOME=~/.bees          # State directory (DB, logs, backups, workspace)
DB_PATH=~/.bees/data/bees.db  # SQLite database path
BEES_MODEL_LIST_CACHE_TTL_SECONDS=60  # Cache TTL for model list in Python worker
BEES_DEFAULT_RUNTIME=hermes      # Default runtime for new tasks: hermes | codex | claude_code | opencode
BEES_OPENCODE_COMMAND=opencode   # Command used for the OpenCode runtime (also BEES_CODEX_COMMAND, BEES_CLAUDE_CODE_COMMAND)
BEES_OPENCODE_TIMEOUT_SECONDS=   # Per-runtime chat timeout (default: no timeout; BEES_COMMAND_RUNTIME_TIMEOUT_SECONDS sets a global one)
```

## Hermes Python Library

The Python worker imports Hermes `AIAgent` from the local agent directory (not via pip). Key API surface used:

- **`AIAgent(model, provider, session_id, session_db, ...)`**: Constructor takes model/provider config, session tracking, callbacks for streaming deltas, and tool configuration. Create one instance per conversation turn — not thread-safe across concurrent calls.
- **`agent.run_conversation(user_message, system_message, conversation_history, task_id)`**: Full control method returning `{"final_response", "messages", "input_tokens", "output_tokens", ...}`. The worker passes sanitized history from `SessionDB.get_messages_as_conversation()` as `conversation_history`.
- **`SessionDB`**: From `hermes_state` module. Used for `get_messages()` (raw rows for chat projection), `get_messages_as_conversation()` (formatted history for agent replay), `get_session()` (session metadata with token counts/cost), and `resolve_resume_session_id()` (follow session chains).
- **Callbacks**: `stream_delta_callback` (text), `reasoning_callback` (thinking), `tool_progress_callback` (tool lifecycle events). These are passed to the constructor and fire during `run_conversation()`.

Docs: https://hermes-agent.nousresearch.com/docs/guides/python-library

## Future

- **Additional adapters**: The `AgentAdapter` interface (`server/adapters/types.ts`) is pluggable. Other OpenAI-compatible backends (OpenClaw, LiteLLM, etc.) could implement it.
