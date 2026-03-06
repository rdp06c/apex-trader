const express = require('express');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const scanner = require('./scanner/monitor');

const router = express.Router();
const PROJECT_ROOT = path.join(__dirname, '..');
const AUTO_PULL_LOG = path.join(__dirname, 'data', 'auto-pull.log');
const startTime = Date.now();

// GET /admin — render admin panel
router.get('/', (req, res) => {
    const status = scanner.getStatus();
    const uptime = Math.floor((Date.now() - startTime) / 1000);

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>APEX Admin</title>
<style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0a0a0f; color: #e0e0e0; font-family: 'Segoe UI', system-ui, sans-serif; padding: 20px; max-width: 900px; margin: 0 auto; }
    h1 { color: #00d4aa; margin-bottom: 20px; font-size: 1.5rem; }
    h2 { color: #888; font-size: 0.9rem; text-transform: uppercase; letter-spacing: 1px; margin: 24px 0 12px; }
    .card { background: #12121a; border: 1px solid #1e1e2e; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
    .stat { text-align: center; }
    .stat .value { font-size: 1.4rem; font-weight: 600; color: #00d4aa; }
    .stat .label { font-size: 0.75rem; color: #666; margin-top: 4px; }
    .reading { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #1a1a2a; }
    .reading:last-child { border-bottom: none; }
    .reading .sym { font-weight: 600; width: 60px; }
    .reading .struct { padding: 2px 8px; border-radius: 4px; font-size: 0.8rem; }
    .bullish { background: #0a3d1f; color: #00ff88; }
    .bearish { background: #3d0a0a; color: #ff4444; }
    .ranging, .contracting, .unknown { background: #2a2a1a; color: #ffaa00; }
    .btn { background: #1a1a2e; border: 1px solid #2a2a3e; color: #00d4aa; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-size: 0.9rem; margin-right: 8px; margin-bottom: 8px; }
    .btn:hover { background: #2a2a3e; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn.danger { color: #ff6666; border-color: #3d1a1a; }
    pre { background: #0a0a12; border: 1px solid #1a1a2a; border-radius: 6px; padding: 12px; font-size: 0.75rem; max-height: 300px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; color: #aaa; margin-top: 8px; }
    .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
    .status-dot.green { background: #00ff88; }
    .status-dot.red { background: #ff4444; }
    .status-dot.yellow { background: #ffaa00; }
    #result { margin-top: 12px; padding: 10px; border-radius: 6px; display: none; }
    #result.success { display: block; background: #0a3d1f; color: #00ff88; }
    #result.error { display: block; background: #3d0a0a; color: #ff4444; }
    a { color: #00d4aa; }
</style>
</head>
<body>
<h1>APEX Admin Panel</h1>
<p style="margin-bottom: 20px;"><a href="/">&larr; Back to Dashboard</a></p>

<h2>Server Status</h2>
<div class="card grid">
    <div class="stat">
        <div class="value">${formatUptime(uptime)}</div>
        <div class="label">Uptime</div>
    </div>
    <div class="stat">
        <div class="value"><span class="status-dot ${status.marketOpen ? 'green' : 'red'}"></span>${status.marketOpen ? 'Open' : 'Closed'}</div>
        <div class="label">Market</div>
    </div>
    <div class="stat">
        <div class="value">${status.lastRun ? timeAgo(status.lastRun) : 'Never'}</div>
        <div class="label">Last Scan</div>
    </div>
    <div class="stat">
        <div class="value">${status.alertsSent}</div>
        <div class="label">Alerts Sent</div>
    </div>
    <div class="stat">
        <div class="value">${status.fullScan?.lastRun ? timeAgo(status.fullScan.lastRun) : 'Never'}</div>
        <div class="label">Last Full Scan</div>
    </div>
    <div class="stat">
        <div class="value">${status.fullScan?.stocksScanned || 0}</div>
        <div class="label">Stocks Scored</div>
    </div>
</div>

${status.fullScan?.topScorers?.length > 0 ? `
<h2>Top Scorers (Last Full Scan)</h2>
<div class="card">
    ${status.fullScan.topScorers.map((s, i) => `
        <div class="reading">
            <span style="color:#666; width:20px;">${i + 1}.</span>
            <span class="sym">${s.symbol}</span>
            <span style="font-size:0.9rem; color:#00d4aa; font-weight:600;">${s.score}</span>
            <span style="font-size:0.8rem; color:#888;">$${s.price?.toFixed(2) || '?'}</span>
        </div>
    `).join('')}
</div>
` : ''}

<h2>Scanner Readings</h2>
<div class="card">
    ${Object.keys(status.readings).length === 0
        ? '<div style="color: #666; text-align: center; padding: 12px;">No readings yet — scanner runs during market hours</div>'
        : Object.entries(status.readings).map(([sym, r]) => `
            <div class="reading">
                <span class="sym">${sym}</span>
                ${r.price ? `<span style="font-size:0.8rem; color:#aaa;">$${r.price.toFixed(2)}</span>` : ''}
                <span class="struct ${r.structure}">${r.structure}</span>
                <span style="font-size:0.8rem; color:#888;">RSI: ${r.rsi != null ? Math.round(r.rsi) : '—'}</span>
                <span style="font-size:0.8rem; color:#888;">MACD: ${r.macdCrossover === 'bullish' ? '<span style="color:#2ecc40">▲</span>' : r.macdCrossover === 'bearish' ? '<span style="color:#ff4757">▼</span>' : '—'}</span>
                ${r.choch ? `<span style="font-size:0.8rem; color:#ff4757;">⚠ CHoCH ${r.chochType}</span>` : ''}
                ${r.lossSignals && r.lossSignals.length > 0 ? `<span style="font-size:0.75rem; background:#ff4757; color:#fff; padding:1px 6px; border-radius:8px; font-weight:600;" title="${r.lossSignals.join(', ')}">${r.lossSignals.length} warning${r.lossSignals.length > 1 ? 's' : ''}</span>` : ''}
                <span style="font-size:0.75rem; color:#666;">${r.timestamp ? timeAgo(r.timestamp) : ''}</span>
            </div>
        `).join('')
    }
</div>

<h2>Actions</h2>
<div class="card">
    <button class="btn" onclick="doAction('pull')">Pull & Restart</button>
    <button class="btn" onclick="doAction('scan')">Run Scanner Now</button>
    <button class="btn" onclick="doAction('fullscan')" id="fullscanBtn">Run Full Scan</button>
    <button class="btn" onclick="loadLogs('server')">Server Logs</button>
    <button class="btn" onclick="loadLogs('pull')">Pull Logs</button>
    <div id="result"></div>
    <pre id="logs" style="display:none;"></pre>
</div>

<script>
async function doAction(action) {
    const el = document.getElementById('result');
    el.className = ''; el.style.display = 'none';
    el.textContent = 'Working...'; el.className = 'success'; el.style.display = 'block';
    try {
        const res = await fetch('/admin/action/' + action, { method: 'POST' });
        const data = await res.json();
        el.textContent = data.message || data.error;
        el.className = res.ok ? 'success' : 'error';
    } catch (err) {
        el.textContent = 'Request failed: ' + err.message;
        el.className = 'error';
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

// POST /admin/action/scan — trigger scanner immediately
router.post('/action/scan', (req, res) => {
    scanner.runStructureCheck({ force: true })
        .then(() => {
            const status = scanner.getStatus();
            const count = Object.keys(status.readings).length;
            res.json({ message: `Scanner complete. ${count} holdings checked, ${status.alertsSent} total alerts.` });
        })
        .catch(err => {
            res.status(500).json({ error: 'Scan failed: ' + err.message });
        });
});

// POST /admin/action/fullscan — trigger full market scan
router.post('/action/fullscan', (req, res) => {
    res.json({ message: 'Full scan started — this takes 2-5 minutes. Check back for results.' });
    scanner.runFullScan({ force: true }).catch(err => {
        console.error('Admin full scan error:', err.message);
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

function timeAgo(isoStr) {
    const diff = Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
}

module.exports = router;
