# Claude Orchestrator

WebSocket-based command & control interface for the [jay-claude-plugins](https://github.com/jayshaffer/jay-claude-plugins) queue system. Provides a web UI and real-time WebSocket API to trigger Claude Code skills, monitor running sessions, and track Jira ticket workflow state.

## Features

- **Skill Launcher** - Trigger Claude Code skills (queue cycles, PR workflows, stack rebasing) from a web dashboard
- **Session Management** - Track running processes with live stdout/stderr streaming via WebSocket
- **Jira Board** - Live-polling Kanban view of `ClaudeWork`-labeled tickets across workflow states
- **WebSocket API** - Real-time bidirectional communication for all operations

## Quick Start

```bash
npm install
npm run dev
```

The server starts at `http://localhost:3100` with WebSocket on the same port.

## Configuration

All configuration is via environment variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3100` | HTTP/WebSocket server port |
| `CLAUDE_BIN` | `claude` | Path to the Claude CLI binary |
| `WORK_DIR` | Parent of project root | Working directory for spawned Claude processes |
| `JIRA_HOST` | _(disabled)_ | Jira instance URL (e.g. `https://myorg.atlassian.net`) |
| `JIRA_EMAIL` | _(disabled)_ | Jira account email for API auth |
| `JIRA_API_TOKEN` | _(disabled)_ | Jira API token |
| `JIRA_POLL_INTERVAL` | `30000` | Jira polling interval in milliseconds |

## Available Commands

| Key | Skill | Description |
|---|---|---|
| `queue-full` | `/jay-claude-queue` | Full queue cycle (plan, execute, promote) |
| `queue-plan` | `/jay-queue-plan` | Phase 1: Plan |
| `queue-execute` | `/jay-queue-execute` | Phase 2: Execute |
| `queue-promote` | `/jay-queue-promote` | Phase 3: Promote |
| `stack-rebase` | `/jay-stack-rebase` | Rebase stacked PR chain |
| `pr-description` | `/jay-pr-description` | Generate PR description |
| `pr-walkthrough` | `/jay-pr-walkthrough` | Walk through PR changes |
| `ears-requirements` | `/jay-ears-requirements` | EARS requirements ideation |

## WebSocket API

Connect to `ws://localhost:3100`. Messages are JSON.

### Client -> Server

| Action | Payload | Description |
|---|---|---|
| `run` | `{ action: "run", command, args? }` | Launch a skill |
| `kill` | `{ action: "kill", id }` | Terminate a session |
| `logs` | `{ action: "logs", id }` | Fetch full log buffer for a session |
| `status` | `{ action: "status" }` | Get all session summaries |
| `clear` | `{ action: "clear" }` | Remove completed/failed sessions |
| `jira:refresh` | `{ action: "jira:refresh" }` | Force a Jira poll |

### Server -> Client

| Type | Description |
|---|---|
| `init` | Sent on connect with available commands, active sessions, and Jira state |
| `session:start` | A new session was created |
| `session:log` | Log line from a running session (`stdout` or `stderr`) |
| `session:end` | Session finished with status and exit code |
| `jira:update` | Jira board state changed |
| `ack` | Acknowledgement of a client action |
| `error` | Error message |

## Project Structure

```
src/
  server.js    # Express + WebSocket server, session management
  jira.js      # Jira REST API poller with label-based workflow tracking
public/
  index.html   # Web dashboard
```
