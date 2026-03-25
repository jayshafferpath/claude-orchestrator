import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { JiraPoller } from './jira.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3100;
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const WORK_DIR = process.env.WORK_DIR || join(dirname(__dirname), '..');

// Active sessions: id -> { process, command, status, startedAt, logs }
const sessions = new Map();

// All connected WebSocket clients
const clients = new Set();

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

function getSessionSummary(id) {
  const s = sessions.get(id);
  if (!s) return null;
  return {
    id,
    command: s.command,
    status: s.status,
    startedAt: s.startedAt,
    exitCode: s.exitCode ?? null,
  };
}

// Available commands mapped to claude CLI skill invocations
const COMMANDS = {
  'queue-full': { skill: 'jay-claude-queue', label: 'Full Queue Cycle' },
  'queue-plan': { skill: 'jay-queue-plan', label: 'Phase 1: Plan' },
  'queue-execute': { skill: 'jay-queue-execute', label: 'Phase 2: Execute' },
  'queue-promote': { skill: 'jay-queue-promote', label: 'Phase 3: Promote' },
  'stack-rebase': { skill: 'jay-stack-rebase', label: 'Stack Rebase' },
  'pr-description': { skill: 'jay-pr-description', label: 'PR Description' },
  'pr-walkthrough': { skill: 'jay-pr-walkthrough', label: 'PR Walkthrough' },
  'ears-requirements': { skill: 'jay-ears-requirements', label: 'EARS Requirements' },
};

function spawnClaude(commandKey, args = '') {
  const cmd = COMMANDS[commandKey];
  if (!cmd) throw new Error(`Unknown command: ${commandKey}`);

  const id = randomUUID().slice(0, 8);
  const prompt = args ? `/${cmd.skill} ${args}` : `/${cmd.skill}`;

  const proc = spawn(CLAUDE_BIN, ['-p', prompt, '--verbose'], {
    cwd: WORK_DIR,
    env: { ...process.env, FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const session = {
    process: proc,
    command: commandKey,
    label: cmd.label,
    args,
    status: 'running',
    startedAt: new Date().toISOString(),
    exitCode: null,
    logs: [],
  };

  sessions.set(id, session);

  broadcast({ type: 'session:start', session: getSessionSummary(id) });

  const pushLog = (stream, data) => {
    const text = data.toString();
    const entry = { ts: Date.now(), stream, text };
    session.logs.push(entry);
    // Cap log buffer at 5000 lines
    if (session.logs.length > 5000) session.logs.shift();
    broadcast({ type: 'session:log', id, ...entry });
  };

  proc.stdout.on('data', (d) => pushLog('stdout', d));
  proc.stderr.on('data', (d) => pushLog('stderr', d));

  proc.on('close', (code) => {
    session.status = code === 0 ? 'completed' : 'failed';
    session.exitCode = code;
    broadcast({ type: 'session:end', id, status: session.status, exitCode: code });
  });

  proc.on('error', (err) => {
    session.status = 'error';
    const entry = { ts: Date.now(), stream: 'stderr', text: `Process error: ${err.message}` };
    session.logs.push(entry);
    broadcast({ type: 'session:log', id, ...entry });
    broadcast({ type: 'session:end', id, status: 'error', exitCode: null });
  });

  return id;
}

function killSession(id) {
  const session = sessions.get(id);
  if (!session || session.status !== 'running') return false;
  session.process.kill('SIGTERM');
  setTimeout(() => {
    if (session.status === 'running') session.process.kill('SIGKILL');
  }, 5000);
  return true;
}

// Jira poller
let jiraState = null;
let jiraPoller = null;

const { JIRA_HOST, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
if (JIRA_HOST && JIRA_EMAIL && JIRA_API_TOKEN) {
  const pollInterval = parseInt(process.env.JIRA_POLL_INTERVAL || '30000', 10);
  jiraPoller = new JiraPoller({
    host: JIRA_HOST,
    email: JIRA_EMAIL,
    apiToken: JIRA_API_TOKEN,
    pollInterval,
    onUpdate: (state) => {
      jiraState = state;
      broadcast({ type: 'jira:update', ...state });
    },
  });
  jiraPoller.start();
  console.log(`Jira poller started (every ${pollInterval / 1000}s) -> ${JIRA_HOST}`);
} else {
  console.log('Jira poller disabled (set JIRA_HOST, JIRA_EMAIL, JIRA_API_TOKEN to enable)');
}

// WebSocket handler
wss.on('connection', (ws) => {
  clients.add(ws);

  // Send current state on connect
  ws.send(JSON.stringify({
    type: 'init',
    commands: Object.entries(COMMANDS).map(([key, val]) => ({ key, label: val.label })),
    sessions: [...sessions.keys()].map(getSessionSummary),
    jira: jiraState,
    jiraEnabled: !!jiraPoller,
  }));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    switch (msg.action) {
      case 'run': {
        try {
          const id = spawnClaude(msg.command, msg.args || '');
          ws.send(JSON.stringify({ type: 'ack', action: 'run', id }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', message: err.message }));
        }
        break;
      }

      case 'kill': {
        const ok = killSession(msg.id);
        ws.send(JSON.stringify({ type: 'ack', action: 'kill', id: msg.id, ok }));
        break;
      }

      case 'logs': {
        const session = sessions.get(msg.id);
        if (session) {
          ws.send(JSON.stringify({ type: 'logs', id: msg.id, entries: session.logs }));
        }
        break;
      }

      case 'status': {
        ws.send(JSON.stringify({
          type: 'status',
          sessions: [...sessions.keys()].map(getSessionSummary),
        }));
        break;
      }

      case 'clear': {
        // Clear completed/failed sessions
        for (const [id, s] of sessions) {
          if (s.status !== 'running') sessions.delete(id);
        }
        ws.send(JSON.stringify({ type: 'ack', action: 'clear' }));
        break;
      }

      case 'jira:refresh': {
        if (jiraPoller) {
          jiraPoller.poll();
          ws.send(JSON.stringify({ type: 'ack', action: 'jira:refresh' }));
        } else {
          ws.send(JSON.stringify({ type: 'error', message: 'Jira poller not configured' }));
        }
        break;
      }

      default:
        ws.send(JSON.stringify({ type: 'error', message: `Unknown action: ${msg.action}` }));
    }
  });

  ws.on('close', () => clients.delete(ws));
});

// Serve static files
app.use(express.static(join(__dirname, '..', 'public')));

server.listen(PORT, () => {
  console.log(`Claude Orchestrator running at http://localhost:${PORT}`);
  console.log(`WebSocket at ws://localhost:${PORT}`);
  console.log(`Work directory: ${WORK_DIR}`);
});
