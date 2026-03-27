const express = require('express');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const PROJECT_ROOT = path.join(__dirname, '..');
const AUTO_PULL_LOG = path.join(__dirname, 'data', 'auto-pull.log');
const startTime = Date.now();

// GET /admin — render admin panel
router.get('/', (req, res) => {
    const uptime = Math.floor((Date.now() - startTime) / 1000);

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>APEX Admin</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
<style>
    :root {
        --bg-base: #121215;
        --bg-surface: #1a1a22;
        --bg-raised: #22222b;
        --bg-inset: #161619;
        --border-subtle: rgba(255, 200, 100, 0.06);
        --border-medium: rgba(255, 200, 100, 0.12);
        --border-strong: rgba(255, 200, 100, 0.20);
        --accent: #f59e0b;
        --accent-light: #fbbf24;
        --accent-dim: rgba(245, 158, 11, 0.12);
        --accent-gradient: linear-gradient(135deg, #f59e0b 0%, #f97316 100%);
        --accent-glow: rgba(245, 158, 11, 0.30);
        --green: #34d399;
        --green-dim: rgba(52, 211, 153, 0.10);
        --green-border: rgba(52, 211, 153, 0.25);
        --red: #f87171;
        --red-dim: rgba(248, 113, 113, 0.10);
        --red-border: rgba(248, 113, 113, 0.30);
        --yellow: #fbbf24;
        --yellow-dim: rgba(251, 191, 36, 0.10);
        --yellow-border: rgba(251, 191, 36, 0.25);
        --text-primary: #f5f5f0;
        --text-secondary: #a8a8a0;
        --text-muted: #78786e;
        --text-faint: #5a5a52;
        --radius-sm: 8px;
        --radius-md: 12px;
        --radius-lg: 16px;
        --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.3);
        --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.4);
        --transition-fast: 0.15s ease;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; scrollbar-width: thin; scrollbar-color: var(--border-medium) transparent; }
    body {
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: var(--bg-base);
        background-image: radial-gradient(ellipse 80% 50% at 50% 0%, rgba(245,158,11,0.04) 0%, transparent 70%);
        color: var(--text-secondary);
        padding: 28px 32px;
        max-width: 960px;
        margin: 0 auto;
        min-height: 100vh;
        -webkit-font-smoothing: antialiased;
    }
    .page-header { margin-bottom: 28px; }
    .page-header .subtitle {
        font-size: 10px;
        color: var(--text-faint);
        text-transform: uppercase;
        letter-spacing: 2.5px;
        margin-bottom: 4px;
    }
    .page-header h1 {
        font-size: 28px;
        font-weight: 800;
        background: var(--accent-gradient);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
        letter-spacing: -0.5px;
        margin-bottom: 8px;
    }
    .back-link {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        color: var(--text-muted);
        text-decoration: none;
        padding: 4px 10px;
        background: var(--bg-raised);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        transition: all 0.2s;
    }
    .back-link:hover { color: var(--accent); border-color: var(--accent); }
    h2 {
        color: var(--text-muted);
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 1.5px;
        margin: 28px 0 12px;
    }
    .card {
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-lg);
        padding: 24px;
        margin-bottom: 16px;
        box-shadow: var(--shadow-sm);
        transition: box-shadow var(--transition-fast), border-color var(--transition-fast);
    }
    .card:hover { box-shadow: var(--shadow-md); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 16px; }
    .stat { text-align: center; padding: 8px; }
    .stat .value { font-size: 1.3rem; font-weight: 600; color: var(--accent); }
    .stat .label { font-size: 11px; color: var(--text-muted); margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
    .btn {
        background: var(--accent);
        color: #000;
        border: none;
        padding: 8px 18px;
        border-radius: var(--radius-sm);
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: all var(--transition-fast);
        margin-right: 8px;
        margin-bottom: 8px;
    }
    .btn:hover { opacity: 0.9; transform: translateY(-1px); box-shadow: 0 4px 12px var(--accent-glow); }
    .btn:active { transform: translateY(0); opacity: 0.8; }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none; box-shadow: none; }
    .btn.secondary {
        background: var(--bg-raised);
        color: var(--text-secondary);
        border: 1px solid var(--border-medium);
    }
    .btn.secondary:hover { border-color: var(--border-strong); color: var(--text-primary); box-shadow: none; transform: none; }
    pre {
        background: var(--bg-inset);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        padding: 16px;
        font-size: 12px;
        max-height: 300px;
        overflow-y: auto;
        white-space: pre-wrap;
        word-break: break-all;
        color: var(--text-secondary);
        margin-top: 12px;
        line-height: 1.5;
    }
    .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
    .status-dot.green { background: var(--green); box-shadow: 0 0 6px var(--green); }
    #result { margin-top: 12px; padding: 12px 16px; border-radius: var(--radius-sm); display: none; font-size: 13px; }
    #result.success { display: block; background: var(--green-dim); color: var(--green); border: 1px solid var(--green-border); }
    #result.error { display: block; background: var(--red-dim); color: var(--red); border: 1px solid var(--red-border); }
    a { color: var(--accent); text-decoration: none; }
    a:hover { color: var(--accent-light); }
    .empty-state { color: var(--text-muted); text-align: center; padding: 16px; font-size: 13px; }
    .health-row { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border-subtle); }
    .health-row:last-child { border-bottom: none; }
    .health-label { font-size: 13px; color: var(--text-secondary); }
    .health-value { font-size: 13px; font-weight: 600; color: var(--text-primary); }
    .backup-list { margin-top: 12px; }
    .backup-item { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; font-size: 12px; color: var(--text-muted); }
    .backup-item:first-child { color: var(--text-secondary); }
    #health-section { opacity: 0; transition: opacity 0.3s; }
    #health-section.loaded { opacity: 1; }
</style>
</head>
<body>
<div class="page-header">
    <div class="subtitle">System Administration</div>
    <h1>APEX Admin</h1>
    <a href="/" class="back-link">&larr; Dashboard</a>
    <a href="/monitor" class="back-link">Monitor</a>
</div>

<h2>Server Status</h2>
<div class="card grid">
    <div class="stat">
        <div class="value">${formatUptime(uptime)}</div>
        <div class="label">Uptime</div>
    </div>
    <div class="stat">
        <div class="value"><span class="status-dot green"></span>Running</div>
        <div class="label">Server</div>
    </div>
</div>

<h2>Portfolio Health</h2>
<div class="card" id="health-section">
    <div class="empty-state">Loading...</div>
</div>

<h2>Actions</h2>
<div class="card">
    <button class="btn" onclick="doAction('pull')">Pull & Restart</button>
    <button class="btn secondary" onclick="loadLogs('server')">Server Logs</button>
    <button class="btn secondary" onclick="loadLogs('pull')">Pull Logs</button>
    <div id="result"></div>
    <pre id="logs" style="display:none;"></pre>
</div>

<script>
async function doAction(action) {
    if (action === 'pull' && !confirm('This will pull latest code and restart the server. Continue?')) return;

    const el = document.getElementById('result');
    el.className = ''; el.style.display = 'none';
    el.textContent = 'Working...'; el.className = 'success'; el.style.display = 'block';

    try {
        const res = await fetch('/admin/action/' + action, { method: 'POST' });
        const data = await res.json();
        el.textContent = data.message || data.error;
        el.className = res.ok ? 'success' : 'error';
    } catch (err) {
        if (action === 'pull') {
            el.textContent = 'Pull complete — server restarting, page will reload...';
            el.className = 'success';
            setTimeout(function() { location.reload(); }, 5000);
        } else {
            el.textContent = 'Request failed: ' + err.message;
            el.className = 'error';
        }
    }
}

async function loadLogs(type) {
    const el = document.getElementById('logs');
    try {
        const res = await fetch('/admin/logs/' + type);
        const data = await res.json();
        el.textContent = data.logs;
        el.style.display = 'block';
    } catch (err) {
        el.textContent = 'Failed to load logs';
        el.style.display = 'block';
    }
}

function healthRow(label, value) {
    return '<div class="health-row">' +
        '<span class="health-label">' + label + '</span>' +
        '<span class="health-value">' + value + '</span></div>';
}

async function loadHealth() {
    const section = document.getElementById('health-section');
    try {
        const res = await fetch('/api/portfolio/health');
        const h = await res.json();

        let html = healthRow('Holdings', h.holdingsCount + ' positions');
        html += healthRow('Transactions', h.transactionCount.toLocaleString());
        html += healthRow('Closed Trades', h.closedTradesCount.toLocaleString());
        html += healthRow('Performance History', h.perfHistoryCount.toLocaleString() + ' entries');
        html += healthRow('Portfolio Size', h.portfolioSizeKb + ' KB');
        html += healthRow('Last Save', h.lastSave ? new Date(h.lastSave).toLocaleString() : 'Never');

        if (h.backups && h.backups.length > 0) {
            html += '<div class="backup-list">';
            html += '<div class="health-row"><span class="health-label">Backups (' + h.backups.length + ')</span></div>';
            h.backups.forEach(function(b) {
                html += '<div class="backup-item">' +
                    '<span>' + new Date(b.timestamp).toLocaleString() + '</span>' +
                    '<span>' + b.sizeKb + ' KB</span></div>';
            });
            html += '</div>';
        }

        section.innerHTML = html;
        section.classList.add('loaded');
    } catch (err) {
        section.innerHTML = '<div class="empty-state">Failed to load portfolio health</div>';
        section.classList.add('loaded');
    }
}

loadHealth();
</script>
</body>
</html>`);
});

// POST /admin/action/pull — trigger git pull and restart
router.post('/action/pull', (req, res) => {
    const script = path.join(__dirname, 'auto-pull.sh');
    execFile('bash', [script], { cwd: PROJECT_ROOT, timeout: 30000 }, (err, stdout, stderr) => {
        if (err) {
            return res.status(500).json({ error: 'Pull failed', details: stderr || err.message });
        }
        res.json({ message: stdout.trim() || 'Pull complete' });
    });
});

// GET /admin/logs/server — last 50 lines of service logs
router.get('/logs/server', (req, res) => {
    execFile('journalctl', ['-u', 'apex', '--no-pager', '-n', '50'], { timeout: 5000 }, (err, stdout) => {
        if (err) return res.json({ logs: 'Failed to read logs: ' + err.message });
        res.json({ logs: stdout });
    });
});

// GET /admin/logs/pull — last 50 lines of auto-pull log
router.get('/logs/pull', (req, res) => {
    try {
        if (!fs.existsSync(AUTO_PULL_LOG)) {
            return res.json({ logs: 'No pull log yet.' });
        }
        const content = fs.readFileSync(AUTO_PULL_LOG, 'utf8');
        const lines = content.trim().split('\n');
        res.json({ logs: lines.slice(-50).join('\n') });
    } catch (err) {
        res.json({ logs: 'Failed to read log: ' + err.message });
    }
});

function formatUptime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

module.exports = router;
