const express = require('express');
const path = require('path');
const portfolioRoutes = require('./api/portfolio');
const scanner = require('./scanner/monitor');
const adminRoutes = require('./admin');

const app = express();
const PORT = process.env.PORT || 4000;

// Basic auth middleware — protects everything when credentials are configured
const AUTH_USER = process.env.AUTH_USER;
const AUTH_PASS = process.env.AUTH_PASS;

if (AUTH_USER && AUTH_PASS) {
    app.use((req, res, next) => {
        const auth = req.headers.authorization;
        if (!auth || !auth.startsWith('Basic ')) {
            res.set('WWW-Authenticate', 'Basic realm="APEX"');
            return res.status(401).send('Authentication required');
        }
        const decoded = Buffer.from(auth.slice(6), 'base64').toString();
        const [user, pass] = decoded.split(':');
        if (user === AUTH_USER && pass === AUTH_PASS) {
            return next();
        }
        res.set('WWW-Authenticate', 'Basic realm="APEX"');
        res.status(401).send('Invalid credentials');
    });
    console.log(`Basic auth enabled (user: ${AUTH_USER})`);
} else {
    console.log('Basic auth disabled — set AUTH_USER and AUTH_PASS in .env to enable');
}

app.use(express.json({ limit: '2mb' }));
app.use('/api', portfolioRoutes);

// Serve API keys to authenticated browsers (no more manual Settings entry)
app.get('/api/config', (req, res) => {
    const config = {};
    if (process.env.MASSIVE_API_KEY && process.env.MASSIVE_API_KEY !== 'your_api_key_here') {
        config.polygonApiKey = process.env.MASSIVE_API_KEY;
    }
    if (process.env.ANTHROPIC_API_URL) {
        config.anthropicApiUrl = process.env.ANTHROPIC_API_URL;
    }
    res.json(config);
});

// Scanner status endpoint (includes full scan status)
app.get('/api/scanner/status', (req, res) => {
    res.json(scanner.getStatus());
});

// Full scan trigger via API (for browser "Run Server Scan" button)
app.post('/api/scanner/fullscan', (req, res) => {
    res.json({ message: 'Full scan started' });
    scanner.runFullScan({ force: true }).catch(err => {
        console.error('API full scan error:', err.message);
    });
});

// Admin panel
app.use('/admin', adminRoutes);

// Analytics dashboard
app.get('/analytics', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'analytics.html'));
});

// Trade journal
app.get('/journal', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'journal.html'));
});

app.use(express.static(path.join(__dirname, '..')));

app.listen(PORT, () => {
    console.log(`APEX server running on port ${PORT}`);

    // Start background scanner if API key is configured
    if (process.env.MASSIVE_API_KEY && process.env.MASSIVE_API_KEY !== 'your_api_key_here') {
        scanner.start();
    } else {
        console.log('Scanner: MASSIVE_API_KEY not set — scanner disabled');
    }
});
