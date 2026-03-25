const LABEL_STATES = [
  { label: 'ClaudePlanning', key: 'planning', display: 'Planning' },
  { label: 'ClaudePlanNeedsApproval', key: 'needsApproval', display: 'Needs Approval' },
  { label: 'ClaudePlanApproved', key: 'approved', display: 'Approved' },
  { label: 'ClaudeExecuting', key: 'executing', display: 'Executing' },
  { label: 'ClaudeNeedsReview', key: 'needsReview', display: 'Needs Review' },
  { label: 'ClaudeFailed', key: 'failed', display: 'Failed' },
];

// Tickets with ClaudeWork but none of the workflow labels = ready/waiting
const WORKFLOW_LABELS = LABEL_STATES.map((s) => s.label);

export class JiraPoller {
  constructor({ host, email, apiToken, pollInterval = 30000, onUpdate }) {
    this.host = host.replace(/\/+$/, '');
    this.auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
    this.pollInterval = pollInterval;
    this.onUpdate = onUpdate;
    this.timer = null;
    this.lastState = null;
  }

  start() {
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollInterval);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async fetch(path) {
    const res = await globalThis.fetch(`${this.host}${path}`, {
      headers: {
        Authorization: `Basic ${this.auth}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      throw new Error(`Jira API ${res.status}: ${res.statusText} - ${path}`);
    }
    return res.json();
  }

  async searchIssues(jql, fields = 'summary,status,assignee,labels,priority,issuetype,parent') {
    const params = new URLSearchParams({
      jql,
      fields,
      maxResults: '50',
    });
    const data = await this.fetch(`/rest/api/3/search?${params}`);
    return data.issues || [];
  }

  formatIssue(issue) {
    const f = issue.fields;
    return {
      key: issue.key,
      summary: f.summary,
      status: f.status?.name,
      statusCategory: f.status?.statusCategory?.key,
      assignee: f.assignee?.displayName || null,
      priority: f.priority?.name || null,
      type: f.issuetype?.name || null,
      labels: f.labels || [],
      parent: f.parent?.key || null,
    };
  }

  classifyTicket(issue) {
    const labels = issue.labels || [];
    // Return the most advanced workflow label (last in the state machine wins)
    for (let i = LABEL_STATES.length - 1; i >= 0; i--) {
      if (labels.includes(LABEL_STATES[i].label)) {
        return LABEL_STATES[i].key;
      }
    }
    return 'ready';
  }

  async poll() {
    try {
      const issues = await this.searchIssues(
        'labels = "ClaudeWork" ORDER BY priority DESC, created ASC'
      );

      const columns = {
        ready: { display: 'Ready', tickets: [] },
      };
      for (const s of LABEL_STATES) {
        columns[s.key] = { display: s.display, tickets: [] };
      }
      // Done column for tickets that reached statusCategory=done
      columns.done = { display: 'Done', tickets: [] };

      for (const raw of issues) {
        const ticket = this.formatIssue(raw);
        if (ticket.statusCategory === 'done') {
          columns.done.tickets.push(ticket);
        } else {
          const col = this.classifyTicket(ticket);
          columns[col].tickets.push(ticket);
        }
      }

      const state = { columns, updatedAt: new Date().toISOString(), total: issues.length };

      // Only broadcast if state changed
      const serialized = JSON.stringify(state);
      if (serialized !== this.lastState) {
        this.lastState = serialized;
        this.onUpdate(state);
      }
    } catch (err) {
      console.error(`Jira poll error: ${err.message}`);
      this.onUpdate({ error: err.message, updatedAt: new Date().toISOString() });
    }
  }
}

export { LABEL_STATES, WORKFLOW_LABELS };
