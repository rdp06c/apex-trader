const express = require('express');
const path = require('path');
const portfolioRoutes = require('./api/portfolio');
const scanner = require('./scanner/monitor');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(express.json({ limit: '2mb' }));
app.use('/api', portfolioRoutes);

// Scanner status endpoint
app.get('/api/scanner/status', (req, res) => {
    res.json(scanner.getStatus());
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
