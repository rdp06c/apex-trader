const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const DATA_DIR = path.join(__dirname, '..', 'data');
const PORTFOLIO_PATH = path.join(DATA_DIR, 'portfolio.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const MAX_BACKUPS = 5;

const DEFAULT_PORTFOLIO = {
    cash: 0,
    initialBalance: 0,
    totalDeposits: 0,
    holdings: {},
    transactions: [],
    closedTrades: [],
    performanceHistory: [],
    holdingTheses: {},
    tradingStrategy: 'balanced',
    journalEntries: [],
    lastMarketRegime: null,
    lastCandidateScores: null,
    lastSectorRotation: null,
    lastVIX: null,
    regimeHistory: [],
    holdSnapshots: [],
    blockedTrades: [],
    calibratedWeights: null,
    portfolioHealth: null,
    watchlist: []
};

// Simple in-process mutex to prevent concurrent file writes
let writeQueue = Promise.resolve();

function getETag() {
    try {
        const stat = fs.statSync(PORTFOLIO_PATH);
        return `"${stat.mtimeMs}"`;
    } catch {
        return null;
    }
}

function rotateBackups() {
    if (!fs.existsSync(BACKUP_DIR)) {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }
    const backups = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.endsWith('.json'))
        .sort()
        .reverse();
    while (backups.length >= MAX_BACKUPS) {
        const oldest = backups.pop();
        fs.unlinkSync(path.join(BACKUP_DIR, oldest));
    }
}

function saveBackup() {
    if (!fs.existsSync(PORTFOLIO_PATH)) return;
    rotateBackups();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `portfolio-${timestamp}.json`;
    fs.copyFileSync(PORTFOLIO_PATH, path.join(BACKUP_DIR, backupName));
}

// GET /api/portfolio
router.get('/portfolio', (req, res) => {
    try {
        if (!fs.existsSync(PORTFOLIO_PATH)) {
            return res.json(DEFAULT_PORTFOLIO);
        }
        const data = fs.readFileSync(PORTFOLIO_PATH, 'utf8');
        const etag = getETag();
        if (etag) res.set('ETag', etag);
        res.json(JSON.parse(data));
    } catch (err) {
        console.error('Error reading portfolio:', err.message);
        res.status(500).json({ error: 'Failed to read portfolio' });
    }
});

// POST /api/portfolio
router.post('/portfolio', (req, res) => {
    const portfolio = req.body;
    if (!portfolio || typeof portfolio !== 'object') {
        return res.status(400).json({ error: 'Invalid portfolio data' });
    }

    writeQueue = writeQueue.then(() => {
        try {
            // Backup current version before overwriting
            saveBackup();

            // Atomic write: tmp file then rename
            const tmpPath = PORTFOLIO_PATH + '.tmp.json';
            fs.writeFileSync(tmpPath, JSON.stringify(portfolio, null, 2), 'utf8');
            fs.renameSync(tmpPath, PORTFOLIO_PATH);

            const etag = getETag();
            if (etag) res.set('ETag', etag);
            res.json({ ok: true });
        } catch (err) {
            console.error('Error saving portfolio:', err.message);
            res.status(500).json({ error: 'Failed to save portfolio' });
        }
    });
});

// GET /api/portfolio/health
router.get('/portfolio/health', (req, res) => {
    try {
        // Read portfolio
        let portfolio = DEFAULT_PORTFOLIO;
        if (fs.existsSync(PORTFOLIO_PATH)) {
            portfolio = JSON.parse(fs.readFileSync(PORTFOLIO_PATH, 'utf8'));
        }

        // Portfolio file stats
        let lastSave = null;
        let portfolioSizeKb = 0;
        if (fs.existsSync(PORTFOLIO_PATH)) {
            const stat = fs.statSync(PORTFOLIO_PATH);
            lastSave = stat.mtime.toISOString();
            portfolioSizeKb = Math.round(stat.size / 1024);
        }

        // Backup info
        let backups = [];
        if (fs.existsSync(BACKUP_DIR)) {
            backups = fs.readdirSync(BACKUP_DIR)
                .filter(f => f.endsWith('.json'))
                .sort()
                .reverse()
                .map(f => {
                    const stat = fs.statSync(path.join(BACKUP_DIR, f));
                    return {
                        filename: f,
                        timestamp: stat.mtime.toISOString(),
                        sizeKb: Math.round(stat.size / 1024)
                    };
                });
        }

        res.json({
            holdingsCount: Object.keys(portfolio.holdings || {}).filter(s => (portfolio.holdings[s] || 0) > 0).length,
            transactionCount: (portfolio.transactions || []).length,
            closedTradesCount: (portfolio.closedTrades || []).length,
            perfHistoryCount: (portfolio.performanceHistory || []).length,
            backups,
            lastSave,
            portfolioSizeKb
        });
    } catch (err) {
        console.error('Error reading portfolio health:', err.message);
        res.status(500).json({ error: 'Failed to read portfolio health' });
    }
});

// GET /api/portfolio/backups
router.get('/portfolio/backups', (req, res) => {
    try {
        if (!fs.existsSync(BACKUP_DIR)) {
            return res.json([]);
        }
        const backups = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.endsWith('.json'))
            .sort()
            .reverse();
        res.json(backups);
    } catch (err) {
        res.status(500).json({ error: 'Failed to list backups' });
    }
});

// POST /api/portfolio/restore/:filename
router.post('/portfolio/restore/:filename', (req, res) => {
    const filename = req.params.filename;
    if (!/^portfolio-[\d\-TZ]+\.json$/.test(filename)) {
        return res.status(400).json({ error: 'Invalid backup filename' });
    }
    const backupPath = path.join(BACKUP_DIR, filename);
    if (!fs.existsSync(backupPath)) {
        return res.status(404).json({ error: 'Backup not found' });
    }

    writeQueue = writeQueue.then(() => {
        try {
            // Backup current before restoring
            saveBackup();
            fs.copyFileSync(backupPath, PORTFOLIO_PATH);
            const data = fs.readFileSync(PORTFOLIO_PATH, 'utf8');
            const etag = getETag();
            if (etag) res.set('ETag', etag);
            res.json(JSON.parse(data));
        } catch (err) {
            res.status(500).json({ error: 'Failed to restore backup' });
        }
    });
});

module.exports = router;
