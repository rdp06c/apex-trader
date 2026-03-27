        // Portfolio state
        let portfolio = {
            cash: 0,
            initialBalance: 0,
            totalDeposits: 0, // Track all cash deposits (initial + weekly funding)
            holdings: {},
            transactions: [],
            performanceHistory: [],
            closedTrades: [], // Track completed buy/sell pairs for analytics
            holdingTheses: {}, // Thesis memory: per-holding catalyst, thesis, targets
            tradingStrategy: 'aggressive', // aggressive, balanced, or conservative
            journalEntries: [], // Trading journal notes
            lastMarketRegime: null, // { regime, timestamp }
            lastCandidateScores: null, // { timestamp, candidates: [...] }
            lastSectorRotation: null, // { timestamp, sectors: {...} }
            lastVIX: null, // { level, interpretation, trend, ... }
            holdSnapshots: [],    // Hold decision outcome tracking
            regimeHistory: []     // Rolling regime transition log
        };

        // Portfolio storage adapter — server-backed with localStorage fallback
        const portfolioStorage = {
            _etag: null,
            _serverAvailable: null, // null = untested, true/false after first probe

            async load() {
                let serverData = null;
                try {
                    const res = await fetch('/api/portfolio');
                    if (res.ok) {
                        this._etag = res.headers.get('ETag');
                        this._serverAvailable = true;
                        serverData = await res.json();
                    }
                } catch (e) { /* server unreachable */ }

                // Check localStorage for newer data (covers failed server saves)
                let localData = null;
                try {
                    const saved = localStorage.getItem('aiTradingPortfolio');
                    if (saved) localData = JSON.parse(saved);
                } catch (e) { /* corrupt localStorage */ }

                if (!serverData) {
                    this._serverAvailable = false;
                    return localData;
                }

                // Reconcile: if localStorage has more transactions, it has unsaved trades
                if (localData) {
                    const serverTxCount = (serverData.transactions || []).length;
                    const localTxCount = (localData.transactions || []).length;
                    const serverClosedCount = (serverData.closedTrades || []).length;
                    const localClosedCount = (localData.closedTrades || []).length;
                    if (localTxCount > serverTxCount || localClosedCount > serverClosedCount) {
                        console.warn(`⚠️ localStorage has newer data (txns: ${localTxCount} vs server ${serverTxCount}, closed: ${localClosedCount} vs ${serverClosedCount}) — using localStorage and syncing to server`);
                        // Push localStorage version to server to reconcile
                        try {
                            const headers = { 'Content-Type': 'application/json' };
                            const res = await fetch('/api/portfolio', {
                                method: 'POST', headers,
                                body: JSON.stringify(localData)
                            });
                            if (res.ok) {
                                this._etag = res.headers.get('ETag');
                                console.log('✅ Server synced with localStorage data');
                            }
                        } catch (e) { console.warn('Failed to sync localStorage to server:', e.message); }
                        return localData;
                    }
                }

                return serverData;
            },

            async save(data) {
                const json = JSON.stringify(data);
                let serverOk = false;
                let serverError = '';

                // Server save with retry — Pi restarts can cause brief unavailability
                if (this._serverAvailable !== false) {
                    const MAX_RETRIES = 3;
                    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                        try {
                            const headers = { 'Content-Type': 'application/json' };
                            if (this._etag) headers['If-Match'] = this._etag;
                            const res = await fetch('/api/portfolio', {
                                method: 'POST', headers, body: json
                            });
                            if (res.ok) {
                                this._etag = res.headers.get('ETag');
                                this._serverAvailable = true;
                                serverOk = true;
                                break;
                            } else {
                                serverError = `${res.status} ${res.statusText}`;
                                console.error(`Portfolio server save failed (attempt ${attempt}/${MAX_RETRIES}): ${serverError} (payload ${(json.length / 1024 / 1024).toFixed(2)}MB)`);
                            }
                        } catch (e) {
                            serverError = e.message;
                            console.error(`Portfolio server save error (attempt ${attempt}/${MAX_RETRIES}):`, e.message);
                        }
                        if (attempt < MAX_RETRIES) {
                            await new Promise(r => setTimeout(r, 1000 * attempt));
                        }
                    }
                }

                // localStorage as backup — may fail on quota, don't let it block anything
                let localOk = false;
                try {
                    localStorage.setItem('aiTradingPortfolio', json);
                    localOk = true;
                } catch (e) {
                    console.warn('localStorage quota exceeded — server save is primary, this is non-fatal');
                    // Try saving a trimmed version (strip large scan data)
                    try {
                        const trimmed = JSON.parse(json);
                        delete trimmed.lastCandidateScores;
                        localStorage.setItem('aiTradingPortfolio', JSON.stringify(trimmed));
                        localOk = true;
                        console.log('Saved trimmed portfolio to localStorage (without candidate scores)');
                    } catch (e2) { /* truly out of space — server has the full data */ }
                }

                return { serverOk, localOk, serverError, payloadMB: (json.length / 1024 / 1024).toFixed(2) };
            }
        };

        let preventAutoSave = false; // Prevent auto-save during recovery

        // Chart instances
        let performanceChart = null;
        let sectorChart = null;

        // Stock full names mapping
        const stockNames = {
            // Tech - AI/Software
            'NVDA': 'NVIDIA', 'AMD': 'Advanced Micro Devices', 'GOOGL': 'Alphabet (Google)', 'GOOG': 'Alphabet (Google)',
            'META': 'Meta Platforms', 'PLTR': 'Palantir', 'SNOW': 'Snowflake', 'MSFT': 'Microsoft',
            'ORCL': 'Oracle', 'CRM': 'Salesforce', 'ADBE': 'Adobe', 'NOW': 'ServiceNow',
            'AI': 'C3.ai', 'BBAI': 'BigBear.ai', 'SOUN': 'SoundHound AI', 'PATH': 'UiPath',
            'S': 'SentinelOne', 'HUBS': 'HubSpot', 'ZM': 'Zoom', 'DOCU': 'DocuSign',
            'TEAM': 'Atlassian', 'WDAY': 'Workday', 'VEEV': 'Veeva', 'ESTC': 'Elastic',
            'DDOG': 'Datadog', 'NET': 'Cloudflare', 'MDB': 'MongoDB', 'CRWD': 'CrowdStrike',
            'PANW': 'Palo Alto Networks', 'ZS': 'Zscaler', 'OKTA': 'Okta', 'CFLT': 'Confluent',
            'GTLB': 'GitLab', 'FROG': 'JFrog', 'BILL': 'Bill Holdings', 'DOCN': 'DigitalOcean',
            'MNDY': 'monday.com', 'PCOR': 'Procore', 'APP': 'AppLovin',
            'INTU': 'Intuit',
            // Cybersecurity
            'FTNT': 'Fortinet', 'TENB': 'Tenable', 'QLYS': 'Qualys',
            'RPD': 'Rapid7', 'VRNS': 'Varonis Systems',
            // S&P 500 Technology additions
            'ACN': 'Accenture', 'ADSK': 'Autodesk', 'ANET': 'Arista Networks', 'CSCO': 'Cisco',
            'CTSH': 'Cognizant', 'EPAM': 'EPAM Systems', 'FFIV': 'F5 Networks', 'FICO': 'Fair Isaac',
            'GDDY': 'GoDaddy', 'GEN': 'Gen Digital', 'GLW': 'Corning', 'HPE': 'HP Enterprise',
            'JBL': 'Jabil', 'KEYS': 'Keysight Technologies', 'MSI': 'Motorola Solutions',
            'PAYC': 'Paycom', 'PTC': 'PTC Inc.', 'TEL': 'TE Connectivity', 'TER': 'Teradyne',
            'TRMB': 'Trimble', 'TTD': 'Trade Desk', 'TYL': 'Tyler Technologies',
            'VRSN': 'VeriSign', 'ZBRA': 'Zebra Technologies', 'CDW': 'CDW Corp.',
            'AKAM': 'Akamai', 'CIEN': 'Ciena', 'CSGP': 'CoStar Group', 'NDSN': 'Nordson',
            'TDY': 'Teledyne Technologies',
            'GRMN': 'Garmin', 'IT': 'Gartner', 'CHTR': 'Charter Communications',
            // Technology - Gaming/Media
            'EA': 'Electronic Arts', 'TTWO': 'Take-Two Interactive', 'FOX': 'Fox Corp Class B',
            'MTCH': 'Match Group',
            // Mid-cap Technology additions
            'CRDO': 'Credo Technology', 'RMBS': 'Rambus', 'LSCC': 'Lattice Semiconductor',
            'MTSI': 'MACOM Technology', 'DIOD': 'Diodes Inc.', 'NTNX': 'Nutanix',
            'ASAN': 'Asana', 'FIVN': 'Five9', 'RBRK': 'Rubrik',
            'GTM': 'ZoomInfo', 'DT': 'Dynatrace',
            'TWLO': 'Twilio', 'DBX': 'Dropbox', 'BOX': 'Box Inc.',
            'YOU': 'Clear Secure', 'SMTC': 'Semtech', 'CALX': 'Calix', 'PI': 'Impinj',
            'MANH': 'Manhattan Associates', 'GWRE': 'Guidewire', 'WK': 'Workiva',
            'BSY': 'Bentley Systems', 'APPF': 'AppFolio', 'PCTY': 'Paylocity',

            // Tech - Hardware/Semiconductors
            'AAPL': 'Apple', 'QCOM': 'Qualcomm', 'INTC': 'Intel', 'MU': 'Micron Technology',
            'ARM': 'Arm Holdings', 'AVGO': 'Broadcom', 'TXN': 'Texas Instruments', 'ADI': 'Analog Devices',
            'NXPI': 'NXP Semiconductors', 'KLAC': 'KLA Corporation', 'ASML': 'ASML Holding', 'TSM': 'Taiwan Semiconductor',
            'SNPS': 'Synopsys', 'CDNS': 'Cadence Design', 'ON': 'ON Semiconductor', 'MPWR': 'Monolithic Power',
            'SWKS': 'Skyworks Solutions', 'QRVO': 'Qorvo', 'DELL': 'Dell Technologies', 'HPQ': 'HP Inc.',
            'AMAT': 'Applied Materials', 'LRCX': 'Lam Research', 'MRVL': 'Marvell Technology', 'SMCI': 'Super Micro Computer',
            'ENTG': 'Entegris', 'FORM': 'FormFactor', 'MKSI': 'MKS Instruments', 'COHR': 'Coherent',
            'IPGP': 'IPG Photonics', 'LITE': 'Lumentum', 'AMBA': 'Ambarella', 'SLAB': 'Silicon Labs',
            'CRUS': 'Cirrus Logic', 'SYNA': 'Synaptics', 'MCHP': 'Microchip Technology',
            'WDC': 'Western Digital', 'STX': 'Seagate', 'PSTG': 'Pure Storage', 'NTAP': 'NetApp', 'CHKP': 'Check Point',
            'IONQ': 'IonQ', 'RGTI': 'Rigetti Computing', 'QBTS': 'D-Wave Quantum', 'QUBT': 'Quantum Computing',
            'ARQQ': 'Arqit Quantum', 'IBM': 'IBM',
            'WOLF': 'Wolfspeed', 'OUST': 'Ouster',
            'IMOS': 'ChipMOS Technologies', 'VECO': 'Veeco Instruments', 'POWI': 'Power Integrations',
            'PLXS': 'Plexus Corp.', 'VICR': 'Vicor Corporation',

            // EV/Automotive
            'TSLA': 'Tesla', 'RIVN': 'Rivian', 'LCID': 'Lucid Group', 'NIO': 'NIO Inc.',
            'XPEV': 'XPeng', 'LI': 'Li Auto', 'F': 'Ford', 'GM': 'General Motors',
            'STLA': 'Stellantis', 'TM': 'Toyota', 'HMC': 'Honda', 'RACE': 'Ferrari',
            'BLNK': 'Blink Charging', 'CHPT': 'ChargePoint',
            'EVGO': 'EVgo', 'PAG': 'Penske Auto',
            'QS': 'QuantumScape', 'ALV': 'Autoliv',
            'CVNA': 'Carvana', 'KMX': 'CarMax', 'APTV': 'Aptiv',
            'AN': 'AutoNation', 'LAD': 'Lithia Motors',

            // Finance
            'JPM': 'JPMorgan Chase', 'BAC': 'Bank of America', 'V': 'Visa', 'MA': 'Mastercard',
            'SOFI': 'SoFi', 'PYPL': 'PayPal', 'XYZ': 'Block',
            'WFC': 'Wells Fargo', 'GS': 'Goldman Sachs', 'MS': 'Morgan Stanley', 'C': 'Citigroup',
            'BLK': 'BlackRock', 'SCHW': 'Charles Schwab', 'AFRM': 'Affirm', 'UPST': 'Upstart',
            'NU': 'Nu Holdings', 'MELI': 'MercadoLibre', 'HOOD': 'Robinhood',
            'GPN': 'Global Payments', 'LC': 'LendingClub', 'AXP': 'American Express',
            'FIS': 'Fidelity National', 'COF': 'Capital One', 'ALLY': 'Ally Financial',
            'USB': 'U.S. Bancorp', 'PNC': 'PNC Financial', 'TFC': 'Truist Financial',
            'RF': 'Regions Financial', 'KEY': 'KeyCorp', 'FITB': 'Fifth Third', 'CFG': 'Citizens Financial',
            'HBAN': 'Huntington Bancshares', 'MTB': 'M&T Bank', 'STT': 'State Street', 'BK': 'BNY Mellon',
            'NTRS': 'Northern Trust', 'ZION': 'Zions Bancorp', 'FHN': 'First Horizon',
            'WRB': 'Berkley', 'CB': 'Chubb', 'TRV': 'Travelers', 'ALL': 'Allstate',
            'PGR': 'Progressive', 'AIG': 'AIG', 'MET': 'MetLife', 'PRU': 'Prudential',
            'RKT': 'Rocket Companies',
            // S&P 500 Financial additions
            'SPGI': 'S&P Global', 'ICE': 'Intercontinental Exchange', 'CME': 'CME Group',
            'MCO': "Moody's", 'MSCI': 'MSCI Inc.', 'NDAQ': 'Nasdaq Inc.',
            'AON': 'Aon', 'AJG': 'Arthur J. Gallagher', 'ACGL': 'Arch Capital',
            'AFL': 'Aflac', 'CINF': 'Cincinnati Financial', 'BRO': 'Brown & Brown',
            'GL': 'Globe Life', 'ERIE': 'Erie Indemnity', 'EG': 'Everest Group',
            'BRK.B': 'Berkshire Hathaway', 'BX': 'Blackstone', 'KKR': 'KKR & Co.',
            'APO': 'Apollo Global', 'ARES': 'Ares Management', 'IBKR': 'Interactive Brokers',
            'PFG': 'Principal Financial', 'L': 'Loews', 'BEN': 'Franklin Templeton',
            'IVZ': 'Invesco', 'SYF': 'Synchrony Financial', 'CBOE': 'Cboe Global Markets',
            'RJF': 'Raymond James', 'AMP': 'Ameriprise', 'TROW': 'T. Rowe Price',
            'FISV': 'Fiserv', 'HIG': 'Hartford Financial', 'CPAY': 'Corpay',
            'AIZ': 'Assurant', 'JKHY': 'Jack Henry & Associates',
            'CBRE': 'CBRE Group', 'FDS': 'FactSet Research', 'VRSK': 'Verisk Analytics',
            'WTW': 'Willis Towers Watson', 'EFX': 'Equifax',
            // Mid-cap Financial additions
            'WAL': 'Western Alliance', 'EWBC': 'East West Bancshares',
            'FNB': 'F.N.B. Corp.', 'WTFC': 'Wintrust', 'PNFP': 'Pinnacle Financial',
            'SSB': 'SouthState', 'BOKF': 'BOK Financial', 'GBCI': 'Glacier Bancorp',
            'FLG': 'Flagstar Financial', 'OZK': 'Bank OZK',
            'SBCF': 'Seacoast Banking', 'UMBF': 'UMB Financial',
            'FCNCA': 'First Citizens Bancshares', 'FNF': 'Fidelity National Financial',
            'FAF': 'First American Financial', 'ESNT': 'Essent Group',
            'RDN': 'Radian Group', 'KNSL': 'Kinsale Capital', 'RLI': 'RLI Corp.',
            'ORI': 'Old Republic', 'THG': 'Hanover Insurance',
            'AFG': 'American Financial Group', 'RYAN': 'Ryan Specialty',
            'JEF': 'Jefferies', 'EVR': 'Evercore', 'PJT': 'PJT Partners',
            'HLI': 'Houlihan Lokey', 'LPLA': 'LPL Financial', 'PIPR': 'Piper Sandler',
            'SF': 'Stifel Financial', 'MKTX': 'MarketAxess', 'VIRT': 'Virtu Financial',
            'TW': 'Tradeweb Markets',
            // Payments/Fintech
            'FOUR': 'Shift4 Payments', 'PAYO': 'Payoneer', 'DLO': 'DLocal',
            'RELY': 'Remitly', 'FLYW': 'Flywire',

            // Growth
            'DKNG': 'DraftKings', 'RBLX': 'Roblox', 'U': 'Unity Software', 'PINS': 'Pinterest',
            'SNAP': 'Snap Inc.', 'SPOT': 'Spotify', 'ROKU': 'Roku', 'ABNB': 'Airbnb',
            'LYFT': 'Lyft', 'DASH': 'DoorDash', 'UBER': 'Uber', 'SHOP': 'Shopify',
            'SE': 'Sea Limited', 'BABA': 'Alibaba', 'JD': 'JD.com', 'PDD': 'PDD Holdings',
            'CPNG': 'Coupang', 'BKNG': 'Booking Holdings', 'EXPE': 'Expedia', 'TCOM': 'Trip.com',
            'TRIP': 'TripAdvisor', 'PTON': 'Peloton', 'OPEN': 'Opendoor', 'COMP': 'Compass Inc.',
            'CWAN': 'Clearwater Analytics', 'DUOL': 'Duolingo', 'BROS': 'Dutch Bros', 'CAVA': 'CAVA Group',
            // Mid-cap Growth
            'TOST': 'Toast', 'GLBE': 'Global-e Online', 'CART': 'Instacart (Maplebear)',
            'GRAB': 'Grab Holdings', 'IOT': 'Samsara', 'BRZE': 'Braze',
            'ONON': 'On Holding', 'BIRK': 'Birkenstock',

            // Healthcare
            'JNJ': 'Johnson & Johnson', 'UNH': 'UnitedHealth', 'LLY': 'Eli Lilly', 'PFE': 'Pfizer',
            'MRNA': 'Moderna', 'ABBV': 'AbbVie', 'VRTX': 'Vertex Pharma', 'REGN': 'Regeneron',
            'BMY': 'Bristol Myers Squibb', 'GILD': 'Gilead Sciences', 'AMGN': 'Amgen', 'CVS': 'CVS Health',
            'ISRG': 'Intuitive Surgical', 'TMO': 'Thermo Fisher', 'DHR': 'Danaher', 'ABT': 'Abbott Labs',
            'CI': 'The Cigna Group', 'HUM': 'Humana', 'SYK': 'Stryker', 'BSX': 'Boston Scientific',
            'MDT': 'Medtronic', 'BDX': 'Becton Dickinson', 'BAX': 'Baxter', 'ZBH': 'Zimmer Biomet',
            'HCA': 'HCA Healthcare', 'DVA': 'DaVita',
            'EXAS': 'Exact Sciences', 'ILMN': 'Illumina', 'BIIB': 'Biogen', 'ALNY': 'Alnylam',
            'INCY': 'Incyte', 'NBIX': 'Neurocrine Bio', 'UTHR': 'United Therapeutics', 'JAZZ': 'Jazz Pharma',
            'SRPT': 'Sarepta', 'BMRN': 'BioMarin', 'IONS': 'Ionis Pharma', 'RGEN': 'Repligen',
            // Biotech/Genomics
            'CRSP': 'CRISPR Therapeutics', 'NTLA': 'Intellia Therapeutics', 'BEAM': 'Beam Therapeutics',
            'RXRX': 'Recursion Pharma', 'TWST': 'Twist Bioscience', 'PACB': 'PacBio',
            'EDIT': 'Editas Medicine', 'IOVA': 'Iovance Biotherapeutics', 'PCVX': 'Vaxcyte',
            'MDGL': 'Madrigal Pharma', 'TGTX': 'TG Therapeutics', 'LEGN': 'Legend Biotech',
            'DNA': 'Ginkgo Bioworks', 'FATE': 'Fate Therapeutics',
            // Digital Health
            'HIMS': 'Hims & Hers', 'DOCS': 'Doximity', 'OSCR': 'Oscar Health',
            'ZTS': 'Zoetis', 'WAT': 'Waters Corp.',
            // S&P 500 Healthcare additions
            'MRK': 'Merck', 'A': 'Agilent Technologies', 'IQV': 'IQVIA',
            'GEHC': 'GE HealthCare', 'HOLX': 'Hologic', 'DXCM': 'DexCom',
            'IDXX': 'IDEXX Labs', 'PODD': 'Insulet', 'ALGN': 'Align Technology',
            'EW': 'Edwards Lifesciences', 'COO': 'CooperCompanies',
            'MTD': 'Mettler-Toledo', 'WST': 'West Pharma', 'TECH': 'Bio-Techne',
            'CNC': 'Centene', 'MOH': 'Molina Healthcare', 'COR': 'Cencora',
            'CAH': 'Cardinal Health', 'MCK': 'McKesson', 'VTRS': 'Viatris',
            'LH': 'LabCorp', 'DGX': 'Quest Diagnostics', 'RMD': 'ResMed',
            'ELV': 'Elevance Health', 'STE': 'Steris', 'HSIC': 'Henry Schein',
            'UHS': 'Universal Health', 'CRL': 'Charles River Labs', 'RVTY': 'Revvity',
            'SOLV': 'Solventum',
            // Mid-cap Healthcare additions
            'NVCR': 'NovoCure', 'GKOS': 'Glaukos', 'NVST': 'Envista',
            'XRAY': 'Dentsply Sirona', 'TFX': 'Teleflex', 'MMSI': 'Merit Medical',
            'PEN': 'Penumbra', 'LNTH': 'Lantheus', 'AZTA': 'Azenta',
            'NEOG': 'Neogen', 'PRCT': 'PROCEPT BioRobotics', 'IRTC': 'iRhythm',
            'HALO': 'Halozyme', 'INSM': 'Insmed', 'RARE': 'Ultragenyx',
            'PTCT': 'PTC Therapeutics', 'ARWR': 'Arrowhead Pharma',
            'FOLD': 'Amicus Therapeutics', 'MYGN': 'Myriad Genetics',
            'GH': 'Guardant Health', 'NTRA': 'Natera', 'SDGR': 'Schrodinger',
            'VERA': 'Vera Therapeutics',

            // Consumer
            'AMZN': 'Amazon', 'WMT': 'Walmart', 'COST': 'Costco', 'TGT': 'Target',
            'HD': 'Home Depot', 'LOW': "Lowe's", 'SBUX': 'Starbucks', 'MCD': "McDonald's",
            'NKE': 'Nike', 'LULU': 'Lululemon', 'DIS': 'Disney', 'NFLX': 'Netflix',
            'KO': 'Coca-Cola', 'PEP': 'PepsiCo',
            'CMG': 'Chipotle', 'YUM': 'Yum! Brands', 'ETSY': 'Etsy', 'W': 'Wayfair', 'CHWY': 'Chewy',
            'WBD': 'Warner Bros Discovery', 'FOXA': 'Fox Corp', 'CMCSA': 'Comcast',
            'OMC': 'Omnicom Group',
            'T': 'AT&T', 'VZ': 'Verizon', 'TMUS': 'T-Mobile',
            'PM': 'Philip Morris', 'MO': 'Altria', 'BUD': 'AB InBev', 'TAP': 'Molson Coors',
            'STZ': 'Constellation Brands', 'MNST': 'Monster Beverage', 'CELH': 'Celsius', 'KDP': 'Keurig Dr Pepper',
            'ULTA': 'Ulta Beauty', 'ELF': 'e.l.f. Beauty', 'RH': 'RH (Restoration Hardware)',
            'DECK': 'Deckers Outdoor', 'CROX': 'Crocs', 'LEVI': "Levi Strauss", 'UAA': 'Under Armour',
            'ORLY': "O'Reilly Auto", 'AZO': 'AutoZone', 'AAP': 'Advance Auto Parts',
            'GPC': 'Genuine Parts', 'TSCO': 'Tractor Supply', 'DG': 'Dollar General', 'DLTR': 'Dollar Tree',
            'ROST': 'Ross Stores', 'TJX': 'TJX Companies', 'BBY': 'Best Buy',
            // S&P 500 Consumer additions
            'PG': 'Procter & Gamble', 'CL': 'Colgate-Palmolive', 'KHC': 'Kraft Heinz',
            'MDLZ': 'Mondelez', 'GIS': 'General Mills', 'CLX': 'Clorox',
            'CHD': 'Church & Dwight', 'SJM': 'J.M. Smucker', 'KMB': 'Kimberly-Clark',
            'HRL': 'Hormel Foods', 'CAG': 'Conagra', 'CPB': 'Campbell Soup',
            'MKC': 'McCormick', 'HSY': 'Hershey', 'KR': 'Kroger', 'SYY': 'Sysco',
            'ADM': 'Archer-Daniels-Midland', 'TSN': 'Tyson Foods', 'BG': 'Bunge',
            'KVUE': 'Kenvue', 'EL': 'Estee Lauder', 'AMCR': 'Amcor',
            'DPZ': "Domino's Pizza", 'DRI': 'Darden Restaurants', 'EBAY': 'eBay',
            'HAS': 'Hasbro', 'HLT': 'Hilton', 'LVS': 'Las Vegas Sands',
            'MAR': 'Marriott', 'MGM': 'MGM Resorts', 'NCLH': 'Norwegian Cruise Line',
            'RCL': 'Royal Caribbean', 'RL': 'Ralph Lauren', 'TPR': 'Tapestry',
            'WYNN': 'Wynn Resorts', 'CCL': 'Carnival', 'WSM': 'Williams-Sonoma',
            'POOL': 'Pool Corp.', 'LW': 'Lamb Weston', 'NWS': 'News Corp Class B',
            'NWSA': 'News Corp Class A', 'TKO': 'TKO Group', 'LYV': 'Live Nation',
            'BF.B': 'Brown-Forman',
            // Mid-cap Consumer additions
            'TXRH': 'Texas Roadhouse', 'WING': 'Wingstop', 'SHAK': 'Shake Shack',
            'SG': 'Sweetgreen', 'LOCO': 'El Pollo Loco', 'DNUT': 'Krispy Kreme',
            'EAT': 'Brinker International', 'CAKE': 'Cheesecake Factory',
            'BJRI': "BJ's Restaurants", 'PLAY': "Dave & Buster's", 'DIN': 'Dine Brands',
            'JACK': 'Jack in the Box', 'ARCO': 'Arcos Dorados',
            'FIVE': 'Five Below', 'OLLI': "Ollie's Bargain", 'BJ': "BJ's Wholesale",
            'COLM': 'Columbia Sportswear', 'VFC': 'VF Corp.',
            'GIII': 'G-III Apparel', 'OXM': 'Oxford Industries',
            'PVH': 'PVH Corp.', 'COTY': 'Coty', 'MNSO': 'Miniso',
            'AEO': 'American Eagle', 'ANF': 'Abercrombie & Fitch', 'GAP': 'Gap Inc.',
            'VSCO': "Victoria's Secret", 'BBWI': 'Bath & Body Works', 'RVLV': 'Revolve',
            'WRBY': 'Warby Parker', 'M': "Macy's", 'KSS': "Kohl's", 'BURL': 'Burlington',
            'PENN': 'Penn Entertainment', 'CZR': 'Caesars Entertainment',
            'BYD': 'Boyd Gaming', 'GDEN': 'Golden Entertainment',
            'VAC': 'Marriott Vacations', 'MTN': 'Vail Resorts', 'FUN': 'Six Flags',
            'PRKS': 'United Parks & Resorts',

            // Energy
            'XOM': 'ExxonMobil', 'CVX': 'Chevron', 'COP': 'ConocoPhillips', 'SLB': 'SLB',
            'NEE': 'NextEra Energy', 'ENPH': 'Enphase', 'FSLR': 'First Solar', 'PLUG': 'Plug Power',
            'EOG': 'EOG Resources', 'OXY': 'Occidental Petroleum', 'MPC': 'Marathon Petroleum', 'PSX': 'Phillips 66',
            'VLO': 'Valero Energy', 'TRGP': 'Targa Resources', 'DVN': 'Devon Energy', 'FANG': 'Diamondback Energy',
            'WMB': 'Williams Companies', 'APA': 'APA Corporation', 'HAL': 'Halliburton', 'BKR': 'Baker Hughes',
            'NOV': 'NOV Inc.', 'FTI': 'TechnipFMC', 'DUK': 'Duke Energy', 'SO': 'Southern Company',
            'D': 'Dominion Energy', 'AEP': 'American Electric Power', 'EXC': 'Exelon', 'OKE': 'ONEOK',
            'SEDG': 'SolarEdge', 'RUN': 'Sunrun', 'PBF': 'PBF Energy', 'DK': 'Delek US',
            'CTRA': 'Coterra Energy', 'OVV': 'Ovintiv', 'PR': 'Permian Resources', 'SM': 'SM Energy',
            'MGY': 'Magnolia Oil', 'MTDR': 'Matador Resources', 'CHRD': 'Chord Energy', 'VNOM': 'Viper Energy',
            'EQT': 'EQT Corporation', 'SMR': 'NuScale Power', 'VST': 'Vistra', 'CEG': 'Constellation Energy',
            'CCJ': 'Cameco', 'LNG': 'Cheniere Energy', 'AR': 'Antero Resources',
            'GEV': 'GE Vernova',
            // S&P 500 Energy/Utilities additions
            'SRE': 'Sempra', 'AES': 'AES Corp.', 'PCG': 'PG&E',
            'EIX': 'Edison International', 'XEL': 'Xcel Energy', 'WEC': 'WEC Energy',
            'ES': 'Eversource Energy', 'ETR': 'Entergy', 'PEG': 'PSEG',
            'ED': 'Consolidated Edison', 'FE': 'FirstEnergy', 'CNP': 'CenterPoint',
            'PPL': 'PPL Corp.', 'AEE': 'Ameren', 'ATO': 'Atmos Energy',
            'DTE': 'DTE Energy', 'CMS': 'CMS Energy', 'EVRG': 'Evergy',
            'NI': 'NiSource', 'LNT': 'Alliant Energy', 'NRG': 'NRG Energy',
            'PNW': 'Pinnacle West', 'AWK': 'American Water Works',
            'KMI': 'Kinder Morgan', 'TPL': 'Texas Pacific Land', 'EXE': 'Expand Energy',
            // Mid-cap Energy/Clean Energy additions
            'ARRY': 'Array Technologies', 'MAXN': 'Maxeon Solar', 'BE': 'Bloom Energy',
            'STEM': 'Stem Inc.', 'SHLS': 'Shoals Technologies',
            'ORA': 'Ormat Technologies', 'CWEN': 'Clearway Energy', 'TAC': 'TransAlta',
            'CNX': 'CNX Resources', 'RRC': 'Range Resources', 'WFRD': 'Weatherford',
            'LBRT': 'Liberty Energy', 'PTEN': 'Patterson-UTI',
            'HP': 'Helmerich & Payne',

            // Industrials
            'BA': 'Boeing', 'CAT': 'Caterpillar', 'DE': 'Deere & Co.', 'GE': 'GE Aerospace',
            'HON': 'Honeywell', 'UPS': 'United Parcel Service', 'FDX': 'FedEx',
            'MMM': '3M', 'UNP': 'Union Pacific', 'NSC': 'Norfolk Southern', 'CSX': 'CSX Corporation',
            'CHRW': 'C.H. Robinson', 'CMI': 'Cummins', 'EMR': 'Emerson Electric', 'ETN': 'Eaton',
            'PH': 'Parker Hannifin', 'ROK': 'Rockwell Automation', 'AME': 'Ametek', 'DOV': 'Dover', 'ITW': 'Illinois Tool Works',
            'DHI': 'D.R. Horton', 'LEN': 'Lennar', 'NVR': 'NVR Inc.', 'PHM': 'PulteGroup',
            'TOL': 'Toll Brothers', 'BLD': 'TopBuild', 'BLDR': 'Builders FirstSource',
            'JBHT': 'J.B. Hunt', 'KNX': 'Knight-Swift', 'ODFL': 'Old Dominion Freight', 'XPO': 'XPO',
            'IR': 'Ingersoll Rand', 'WM': 'WM', 'RSG': 'Republic Services',
            'PCAR': 'Paccar', 'PWR': 'Quanta Services', 'JCI': 'Johnson Controls',
            'AOS': 'A.O. Smith', 'ROP': 'Roper Technologies', 'CARR': 'Carrier Global', 'VLTO': 'Veralto',
            'ROCK': 'Gibraltar Industries', 'MLI': 'Mueller Industries', 'RUSHA': 'Rush Enterprises',
            'MYRG': 'MYR Group', 'DY': 'Dycom Industries', 'APOG': 'Apogee Enterprises',
            // Infrastructure/Data Center
            'VRT': 'Vertiv Holdings', 'EME': 'EMCOR Group', 'APH': 'Amphenol',
            'HUBB': 'Hubbell', 'WCC': 'WESCO International', 'TT': 'Trane Technologies',
            'GNRC': 'Generac Holdings',
            // Policy-Sensitive
            'GEO': 'GEO Group', 'CXW': 'CoreCivic',
            // S&P 500 Industrials additions
            'ADP': 'Automatic Data Processing', 'OTIS': 'Otis Worldwide', 'CTAS': 'Cintas',
            'WAB': 'Wabtec', 'FAST': 'Fastenal', 'URI': 'United Rentals',
            'CPRT': 'Copart', 'GWW': 'W.W. Grainger', 'FIX': 'Comfort Systems USA',
            'ROL': 'Rollins', 'ALLE': 'Allegion', 'SNA': 'Snap-on',
            'SWK': 'Stanley Black & Decker', 'PNR': 'Pentair', 'PAYX': 'Paychex',
            'DAL': 'Delta Air Lines', 'UAL': 'United Airlines', 'LUV': 'Southwest Airlines',
            'EXPD': 'Expeditors', 'LII': 'Lennox', 'PKG': 'Packaging Corp.',
            'AVY': 'Avery Dennison', 'MAS': 'Masco', 'IP': 'International Paper',
            'WY': 'Weyerhaeuser', 'BALL': 'Ball Corp.', 'FTV': 'Fortive',
            'IFF': 'IFF Inc.', 'BR': 'Broadridge Financial', 'J': 'Jacobs Solutions',
            'VMC': 'Vulcan Materials', 'MLM': 'Martin Marietta', 'CRH': 'CRH plc',
            'XYL': 'Xylem', 'SW': 'Smurfit Westrock',
            // Mid-cap Industrials additions
            'ACM': 'AECOM', 'MTZ': 'MasTec', 'STRL': 'Sterling Construction',
            'GVA': 'Granite Construction', 'ROAD': 'Construction Partners',
            'PRIM': 'Primoris', 'TPC': 'Tutor Perini', 'AGX': 'Argan Inc.',
            'UFPI': 'UFP Industries',
            'AWI': 'Armstrong World', 'TREX': 'Trex', 'SITE': 'SiteOne Landscape',
            'BFAM': 'Bright Horizons', 'HRI': 'Herc Holdings',
            'WSC': 'WillScot Mobile Mini', 'SKYW': 'SkyWest',
            'ALK': 'Alaska Air', 'JBLU': 'JetBlue', 'AAL': 'American Airlines',
            'SNDR': 'Schneider National', 'SAIA': 'Saia Inc.', 'ARCB': 'ArcBest',
            'WERN': 'Werner', 'HUBG': 'Hub Group', 'R': 'Ryder', 'GATX': 'GATX',
            'RXO': 'RXO Inc.', 'ATKR': 'Atkore', 'AIT': 'Applied Industrial',
            'REZI': 'Resideo', 'LECO': 'Lincoln Electric', 'MIDD': 'Middleby',
            'FELE': 'Franklin Electric', 'WTS': 'Watts Water', 'MWA': 'Mueller Water',
            'ESE': 'ESCO Technologies', 'IEX': 'IDEX Corp.',

            // Real Estate
            'AMT': 'American Tower', 'PLD': 'Prologis', 'EQIX': 'Equinix', 'O': 'Realty Income',
            'CCI': 'Crown Castle', 'PSA': 'Public Storage', 'DLR': 'Digital Realty', 'WELL': 'Welltower',
            'VICI': 'VICI Properties', 'SPG': 'Simon Property', 'AVB': 'AvalonBay', 'EQR': 'Equity Residential',
            'MAA': 'Mid-America Apartment', 'UDR': 'UDR Inc.', 'CPT': 'Camden Property', 'ESS': 'Essex Property',
            'ELS': 'Equity LifeStyle', 'SUI': 'Sun Communities', 'NXRT': 'NexPoint Residential',
            'VTR': 'Ventas', 'STWD': 'Starwood Property', 'DOC': 'Healthpeak', 'OHI': 'Omega Healthcare',
            'SBRA': 'Sabra Healthcare', 'LTC': 'LTC Properties', 'HR': 'Healthcare Realty', 'MPT': 'Medical Properties Trust',
            'NHI': 'National Health Investors', 'CTRE': 'CareTrust REIT', 'IRM': 'Iron Mountain', 'CUBE': 'CubeSmart',
            'NSA': 'National Storage', 'REXR': 'Rexford Industrial',
            'TRNO': 'Terreno Realty', 'SELF': 'Global Self Storage', 'SAFE': 'Safehold',
            // S&P 500 Real Estate additions
            'EXR': 'Extra Space Storage', 'ARE': 'Alexandria Real Estate',
            'KIM': 'Kimco Realty', 'REG': 'Regency Centers', 'INVH': 'Invitation Homes',
            'FRT': 'Federal Realty', 'HST': 'Host Hotels', 'BXP': 'BXP Inc.',
            'SBAC': 'SBA Communications',
            // Mid-cap Real Estate additions
            'GLPI': 'Gaming & Leisure Properties', 'SLG': 'SL Green', 'VNO': 'Vornado',
            'DEI': 'Douglas Emmett', 'CUZ': 'Cousins Properties', 'HIW': 'Highwoods',
            'CDP': 'COPT Defense Properties', 'NNN': 'NNN REIT', 'ADC': 'Agree Realty',
            'EPRT': 'Essential Properties', 'KRG': 'Kite Realty', 'AKR': 'Acadia Realty',
            'BNL': 'Broadstone Net Lease', 'GTY': 'Getty Realty',
            'IIPR': 'Innovative Industrial Properties', 'APLE': 'Apple Hospitality',
            'RLJ': 'RLJ Lodging', 'PEB': 'Pebblebrook Hotel', 'SHO': 'Sunstone Hotel',
            'DRH': 'DiamondRock', 'FR': 'First Industrial', 'STAG': 'STAG Industrial',
            'LXP': 'LXP Industrial', 'COLD': 'Americold', 'LAMR': 'Lamar Advertising',
            'OUT': 'Outfront Media',

            // Materials
            'NEM': 'Newmont', 'FCX': 'Freeport-McMoRan', 'NUE': 'Nucor', 'DOW': 'Dow Inc.',
            'USAR': 'USA Rare Earth', 'UUUU': 'Energy Fuels', 'NB': 'NioCorp Developments', 'MP': 'MP Materials',
            'GOLD': 'Barrick Gold', 'AU': 'AngloGold Ashanti', 'AEM': 'Agnico Eagle', 'WPM': 'Wheaton Precious Metals',
            'FNV': 'Franco-Nevada', 'RGLD': 'Royal Gold', 'KGC': 'Kinross Gold', 'HL': 'Hecla Mining',
            'STLD': 'Steel Dynamics', 'RS': 'Reliance Steel', 'CLF': 'Cleveland-Cliffs', 'MT': 'ArcelorMittal',
            'TX': 'Ternium', 'CMC': 'Commercial Metals', 'ATI': 'ATI Inc.',
            'LYB': 'LyondellBasell', 'EMN': 'Eastman Chemical', 'CE': 'Celanese', 'DD': 'DuPont',
            'APD': 'Air Products', 'LIN': 'Linde', 'GTLS': 'Chart Industries', 'NUAI': 'New Era Helium', 'ASPI': 'ASP Isotopes', 'ECL': 'Ecolab',
            'SHW': 'Sherwin-Williams', 'PPG': 'PPG Industries', 'RPM': 'RPM International', 'AXTA': 'Axalta Coating',
            'ALB': 'Albemarle', 'SQM': 'SQM', 'LAC': 'Lithium Americas', 'AA': 'Alcoa',
            'FUL': 'H.B. Fuller', 'NEU': 'NewMarket', 'B': 'Barrick Mining',
            // S&P 500 Materials additions
            'CTVA': 'Corteva Agriscience', 'MOS': 'Mosaic', 'CF': 'CF Industries',
            // Mid-cap Materials additions
            'PAAS': 'Pan American Silver', 'AG': 'First Majestic', 'CDE': 'Coeur Mining',
            'EGO': 'Eldorado Gold', 'SSRM': 'SSR Mining', 'HBM': 'Hudbay Minerals',
            'TECK': 'Teck Resources', 'RIO': 'Rio Tinto', 'BHP': 'BHP Group',
            'VALE': 'Vale', 'SCCO': 'Southern Copper', 'GFI': 'Gold Fields',
            'BTG': 'B2Gold', 'IAUX': 'i-80 Gold', 'AMR': 'Alpha Metallurgical',
            'HCC': 'Warrior Met Coal', 'CNR': 'Core Natural Resources',
            'MEOH': 'Methanex', 'CC': 'Chemours', 'OLN': 'Olin', 'TROX': 'Tronox',
            'HUN': 'Huntsman', 'WLK': 'Westlake', 'CBT': 'Cabot', 'NGVT': 'Ingevity',
            'ASH': 'Ashland', 'SON': 'Sonoco', 'SEE': 'Sealed Air',
            'GPK': 'Graphic Packaging', 'SLVM': 'Sylvamo',

            // Defense
            'LMT': 'Lockheed Martin', 'RTX': 'RTX Corporation', 'NOC': 'Northrop Grumman', 'GD': 'General Dynamics',
            'LHX': 'L3Harris', 'HII': 'Huntington Ingalls', 'TXT': 'Textron', 'HWM': 'Howmet Aerospace',
            'AXON': 'Axon Enterprise', 'KTOS': 'Kratos Defense', 'AVAV': 'AeroVironment', 'AIR': 'AAR Corp',
            'SAIC': 'SAIC', 'LDOS': 'Leidos', 'CACI': 'CACI International', 'BAH': 'Booz Allen Hamilton',
            'BWXT': 'BWX Technologies', 'WWD': 'Woodward', 'TDG': 'TransDigm', 'HEI': 'HEICO',
            'CW': 'Curtiss-Wright', 'MOG.A': 'Moog', 'AIN': 'Albany International',
            'PSN': 'Parsons Corporation', 'MRCY': 'Mercury Systems', 'DRS': 'Leonardo DRS',
            // Drones/eVTOL
            'RCAT': 'Red Cat Holdings', 'JOBY': 'Joby Aviation', 'ACHR': 'Archer Aviation',
            // Mid-cap Defense additions
            'OSIS': 'OSI Systems', 'VSEC': 'VSE Corp.', 'BDC': 'Belden',

            // Space
            'RKLB': 'Rocket Lab', 'ASTS': 'AST SpaceMobile', 'LUNR': 'Intuitive Machines',
            'RDW': 'Redwire', 'BKSY': 'BlackSky Technology', 'SPIR': 'Spire Global',
            'IRDM': 'Iridium Communications', 'GSAT': 'Globalstar',

            // Crypto
            'COIN': 'Coinbase', 'MSTR': 'Strategy', 'MARA': 'MARA Holdings',
            'RIOT': 'Riot Platforms', 'CLSK': 'CleanSpark', 'HUT': 'Hut 8',
            'BTDR': 'Bitdeer Technologies', 'BITF': 'Bitfarms',
            // Crypto additions
            'CORZ': 'Core Scientific', 'WULF': 'TeraWulf', 'IREN': 'Iris Energy',
            'CIFR': 'Cipher Mining',

            // Index Funds
            'SPY': 'S&P 500 ETF', 'QQQ': 'Nasdaq 100 ETF', 'IWM': 'Russell 2000 ETF', 'VOO': 'Vanguard S&P 500'
        };

        const stockSectors = {
            // Tech - AI/Software
            'NVDA': 'Technology', 'AMD': 'Technology', 'GOOGL': 'Technology', 'GOOG': 'Technology',
            'META': 'Technology', 'PLTR': 'Technology', 'SNOW': 'Technology', 'MSFT': 'Technology',
            'ORCL': 'Technology', 'CRM': 'Technology', 'ADBE': 'Technology', 'NOW': 'Technology',
            'AI': 'Technology', 'BBAI': 'Technology', 'SOUN': 'Technology', 'PATH': 'Technology',
            'S': 'Technology', 'HUBS': 'Technology', 'ZM': 'Technology', 'DOCU': 'Technology',
            'TEAM': 'Technology', 'WDAY': 'Technology', 'VEEV': 'Technology', 'ESTC': 'Technology',
            'DDOG': 'Technology', 'NET': 'Technology', 'MDB': 'Technology', 'CRWD': 'Technology',
            'PANW': 'Technology', 'ZS': 'Technology', 'OKTA': 'Technology', 'CFLT': 'Technology',
            'GTLB': 'Technology', 'FROG': 'Technology', 'BILL': 'Technology', 'DOCN': 'Technology',
            'MNDY': 'Technology', 'PCOR': 'Technology', 'APP': 'Technology',
            'INTU': 'Technology',
            'FTNT': 'Technology', 'TENB': 'Technology', 'QLYS': 'Technology',
            'RPD': 'Technology', 'VRNS': 'Technology',
            'ACN': 'Technology', 'ADSK': 'Technology', 'ANET': 'Technology', 'CSCO': 'Technology',
            'CTSH': 'Technology', 'EPAM': 'Technology', 'FFIV': 'Technology', 'FICO': 'Technology',
            'GDDY': 'Technology', 'GEN': 'Technology', 'GLW': 'Technology', 'HPE': 'Technology',
            'JBL': 'Technology', 'KEYS': 'Technology', 'MSI': 'Technology',
            'PAYC': 'Technology', 'PTC': 'Technology', 'TEL': 'Technology', 'TER': 'Technology',
            'TRMB': 'Technology', 'TTD': 'Technology', 'TYL': 'Technology',
            'VRSN': 'Technology', 'ZBRA': 'Technology', 'CDW': 'Technology',
            'AKAM': 'Technology', 'CIEN': 'Technology', 'CSGP': 'Technology', 'NDSN': 'Technology',
            'TDY': 'Technology',
            'GRMN': 'Technology', 'IT': 'Technology', 'CHTR': 'Technology',
            'EA': 'Technology', 'TTWO': 'Technology', 'FOX': 'Consumer', 'MTCH': 'Technology',
            'CRDO': 'Technology', 'RMBS': 'Technology', 'LSCC': 'Technology',
            'MTSI': 'Technology', 'DIOD': 'Technology', 'NTNX': 'Technology',
            'ASAN': 'Technology', 'FIVN': 'Technology', 'RBRK': 'Technology',
            'GTM': 'Technology', 'DT': 'Technology',
            'TWLO': 'Technology', 'DBX': 'Technology', 'BOX': 'Technology',
            'YOU': 'Technology', 'SMTC': 'Technology', 'CALX': 'Technology', 'PI': 'Technology',
            'MANH': 'Technology', 'GWRE': 'Technology', 'WK': 'Technology',
            'BSY': 'Technology', 'APPF': 'Technology', 'PCTY': 'Technology',
            'AAPL': 'Technology', 'QCOM': 'Technology', 'INTC': 'Technology', 'MU': 'Technology',
            'ARM': 'Technology', 'AVGO': 'Technology', 'TXN': 'Technology', 'ADI': 'Technology',
            'NXPI': 'Technology', 'KLAC': 'Technology', 'ASML': 'Technology', 'TSM': 'Technology',
            'SNPS': 'Technology', 'CDNS': 'Technology', 'ON': 'Technology', 'MPWR': 'Technology',
            'SWKS': 'Technology', 'QRVO': 'Technology', 'DELL': 'Technology', 'HPQ': 'Technology',
            'AMAT': 'Technology', 'LRCX': 'Technology', 'MRVL': 'Technology', 'ENTG': 'Technology',
            'FORM': 'Technology', 'MKSI': 'Technology', 'COHR': 'Technology', 'IPGP': 'Technology',
            'LITE': 'Technology', 'AMBA': 'Technology', 'SLAB': 'Technology', 'CRUS': 'Technology',
            'SYNA': 'Technology', 'MCHP': 'Technology', 'SMCI': 'Technology', 'WDC': 'Technology',
            'STX': 'Technology', 'PSTG': 'Technology', 'NTAP': 'Technology', 'CHKP': 'Technology',
            'IONQ': 'Technology', 'RGTI': 'Technology', 'QBTS': 'Technology', 'QUBT': 'Technology',
            'ARQQ': 'Technology', 'IBM': 'Technology',
            'WOLF': 'Technology', 'OUST': 'Technology',
            'TSLA': 'Automotive', 'RIVN': 'Automotive', 'LCID': 'Automotive', 'NIO': 'Automotive',
            'XPEV': 'Automotive', 'LI': 'Automotive', 'F': 'Automotive', 'GM': 'Automotive',
            'STLA': 'Automotive', 'TM': 'Automotive', 'HMC': 'Automotive', 'RACE': 'Automotive',
            'BLNK': 'Automotive', 'CHPT': 'Automotive', 'EVGO': 'Automotive',
            'PAG': 'Automotive', 'QS': 'Automotive',
            'ALV': 'Automotive',
            'CVNA': 'Automotive', 'KMX': 'Automotive', 'APTV': 'Automotive',
            'AN': 'Automotive', 'LAD': 'Automotive',
            'JPM': 'Financial', 'BAC': 'Financial', 'V': 'Financial', 'MA': 'Financial',
            'SOFI': 'Financial', 'PYPL': 'Financial', 'XYZ': 'Financial', 'GPN': 'Financial',
            'WFC': 'Financial', 'GS': 'Financial', 'MS': 'Financial', 'C': 'Financial',
            'BLK': 'Financial', 'SCHW': 'Financial', 'AFRM': 'Financial', 'UPST': 'Financial',
            'LC': 'Financial', 'NU': 'Financial', 'MELI': 'Financial', 'HOOD': 'Financial',
            'AXP': 'Financial', 'FIS': 'Financial', 'COF': 'Financial', 'ALLY': 'Financial',
            'USB': 'Financial', 'PNC': 'Financial', 'TFC': 'Financial', 'RF': 'Financial',
            'KEY': 'Financial', 'FITB': 'Financial', 'CFG': 'Financial', 'HBAN': 'Financial',
            'MTB': 'Financial', 'STT': 'Financial', 'BK': 'Financial', 'NTRS': 'Financial',
            'ZION': 'Financial', 'FHN': 'Financial',
            'WRB': 'Financial', 'CB': 'Financial', 'TRV': 'Financial', 'ALL': 'Financial',
            'PGR': 'Financial', 'AIG': 'Financial', 'MET': 'Financial', 'PRU': 'Financial',
            'SPGI': 'Financial', 'ICE': 'Financial', 'CME': 'Financial',
            'MCO': 'Financial', 'MSCI': 'Financial', 'NDAQ': 'Financial',
            'AON': 'Financial', 'AJG': 'Financial', 'ACGL': 'Financial',
            'AFL': 'Financial', 'CINF': 'Financial', 'BRO': 'Financial',
            'GL': 'Financial', 'ERIE': 'Financial', 'EG': 'Financial',
            'BRK.B': 'Financial', 'BX': 'Financial', 'KKR': 'Financial',
            'APO': 'Financial', 'ARES': 'Financial', 'IBKR': 'Financial',
            'PFG': 'Financial', 'L': 'Financial', 'BEN': 'Financial',
            'IVZ': 'Financial', 'SYF': 'Financial', 'CBOE': 'Financial',
            'RJF': 'Financial', 'AMP': 'Financial', 'TROW': 'Financial',
            'FISV': 'Financial', 'HIG': 'Financial', 'CPAY': 'Financial',
            'AIZ': 'Financial', 'JKHY': 'Financial',
            'CBRE': 'Financial', 'FDS': 'Financial', 'VRSK': 'Financial',
            'WTW': 'Financial', 'EFX': 'Financial',
            'WAL': 'Financial', 'EWBC': 'Financial',
            'FNB': 'Financial', 'WTFC': 'Financial', 'PNFP': 'Financial',
            'SSB': 'Financial', 'BOKF': 'Financial', 'GBCI': 'Financial',
            'FLG': 'Financial', 'OZK': 'Financial',
            'SBCF': 'Financial', 'UMBF': 'Financial',
            'FCNCA': 'Financial', 'FNF': 'Financial',
            'FAF': 'Financial', 'ESNT': 'Financial',
            'RDN': 'Financial', 'KNSL': 'Financial', 'RLI': 'Financial',
            'ORI': 'Financial', 'THG': 'Financial',
            'AFG': 'Financial', 'RYAN': 'Financial',
            'JEF': 'Financial', 'EVR': 'Financial', 'PJT': 'Financial',
            'HLI': 'Financial', 'LPLA': 'Financial', 'PIPR': 'Financial',
            'SF': 'Financial', 'MKTX': 'Financial', 'VIRT': 'Financial',
            'TW': 'Financial',
            'FOUR': 'Financial', 'PAYO': 'Financial', 'DLO': 'Financial',
            'RELY': 'Financial', 'FLYW': 'Financial',
            'DKNG': 'Technology', 'RBLX': 'Technology', 'U': 'Technology', 'PINS': 'Technology',
            'SNAP': 'Technology', 'SPOT': 'Technology', 'ABNB': 'Consumer',
            'LYFT': 'Technology', 'DASH': 'Consumer', 'UBER': 'Technology', 'CPNG': 'Consumer',
            'SHOP': 'Technology', 'SE': 'Consumer', 'BABA': 'Consumer', 'JD': 'Consumer',
            'PDD': 'Consumer', 'BKNG': 'Consumer', 'EXPE': 'Consumer', 'TCOM': 'Consumer', 'TRIP': 'Consumer',
            'PTON': 'Consumer', 'OPEN': 'Technology', 'COMP': 'Technology', 'RKT': 'Financial',
            'CWAN': 'Technology', 'DUOL': 'Technology', 'BROS': 'Consumer', 'CAVA': 'Consumer',
            'TOST': 'Technology', 'GLBE': 'Technology', 'CART': 'Technology',
            'GRAB': 'Technology', 'IOT': 'Technology', 'BRZE': 'Technology',
            'ONON': 'Consumer', 'BIRK': 'Consumer',
            'JNJ': 'Healthcare', 'UNH': 'Healthcare', 'LLY': 'Healthcare', 'PFE': 'Healthcare',
            'MRNA': 'Healthcare', 'ABBV': 'Healthcare', 'VRTX': 'Healthcare', 'REGN': 'Healthcare',
            'BMY': 'Healthcare', 'GILD': 'Healthcare', 'AMGN': 'Healthcare', 'CVS': 'Healthcare',
            'CI': 'Healthcare', 'HUM': 'Healthcare', 'ISRG': 'Healthcare', 'TMO': 'Healthcare',
            'DHR': 'Healthcare', 'ABT': 'Healthcare', 'SYK': 'Healthcare', 'BSX': 'Healthcare',
            'MDT': 'Healthcare', 'BDX': 'Healthcare', 'BAX': 'Healthcare', 'ZBH': 'Healthcare',
            'HCA': 'Healthcare', 'DVA': 'Healthcare',
            'EXAS': 'Healthcare', 'ILMN': 'Healthcare', 'BIIB': 'Healthcare', 'ALNY': 'Healthcare',
            'INCY': 'Healthcare', 'NBIX': 'Healthcare', 'UTHR': 'Healthcare', 'JAZZ': 'Healthcare',
            'SRPT': 'Healthcare', 'BMRN': 'Healthcare', 'IONS': 'Healthcare', 'RGEN': 'Healthcare',
            'CRSP': 'Healthcare', 'NTLA': 'Healthcare', 'BEAM': 'Healthcare',
            'RXRX': 'Healthcare', 'TWST': 'Healthcare', 'PACB': 'Healthcare',
            'EDIT': 'Healthcare', 'IOVA': 'Healthcare', 'PCVX': 'Healthcare',
            'MDGL': 'Healthcare', 'TGTX': 'Healthcare', 'LEGN': 'Healthcare',
            'DNA': 'Healthcare', 'FATE': 'Healthcare',
            'HIMS': 'Healthcare', 'DOCS': 'Healthcare', 'OSCR': 'Healthcare',
            'ZTS': 'Healthcare', 'WAT': 'Healthcare',
            'MRK': 'Healthcare', 'A': 'Healthcare', 'IQV': 'Healthcare',
            'GEHC': 'Healthcare', 'HOLX': 'Healthcare', 'DXCM': 'Healthcare',
            'IDXX': 'Healthcare', 'PODD': 'Healthcare', 'ALGN': 'Healthcare',
            'EW': 'Healthcare', 'COO': 'Healthcare',
            'MTD': 'Healthcare', 'WST': 'Healthcare', 'TECH': 'Healthcare',
            'CNC': 'Healthcare', 'MOH': 'Healthcare', 'COR': 'Healthcare',
            'CAH': 'Healthcare', 'MCK': 'Healthcare', 'VTRS': 'Healthcare',
            'LH': 'Healthcare', 'DGX': 'Healthcare', 'RMD': 'Healthcare',
            'ELV': 'Healthcare', 'STE': 'Healthcare', 'HSIC': 'Healthcare',
            'UHS': 'Healthcare', 'CRL': 'Healthcare', 'RVTY': 'Healthcare',
            'SOLV': 'Healthcare',
            'NVCR': 'Healthcare', 'GKOS': 'Healthcare', 'NVST': 'Healthcare',
            'XRAY': 'Healthcare', 'TFX': 'Healthcare', 'MMSI': 'Healthcare',
            'PEN': 'Healthcare', 'LNTH': 'Healthcare', 'AZTA': 'Healthcare',
            'NEOG': 'Healthcare', 'PRCT': 'Healthcare', 'IRTC': 'Healthcare',
            'HALO': 'Healthcare', 'INSM': 'Healthcare', 'RARE': 'Healthcare',
            'PTCT': 'Healthcare', 'ARWR': 'Healthcare',
            'FOLD': 'Healthcare', 'MYGN': 'Healthcare',
            'GH': 'Healthcare', 'NTRA': 'Healthcare', 'SDGR': 'Healthcare',
            'VERA': 'Healthcare',
            'AMZN': 'Consumer', 'WMT': 'Consumer', 'COST': 'Consumer', 'TGT': 'Consumer',
            'HD': 'Consumer', 'LOW': 'Consumer', 'SBUX': 'Consumer', 'MCD': 'Consumer',
            'CMG': 'Consumer', 'YUM': 'Consumer', 'NKE': 'Consumer', 'LULU': 'Consumer',
            'ETSY': 'Consumer', 'W': 'Consumer', 'CHWY': 'Consumer',
            'DIS': 'Consumer', 'NFLX': 'Consumer', 'ROKU': 'Consumer', 'CARR': 'Industrials', 'WBD': 'Consumer',
            'FOXA': 'Consumer', 'CMCSA': 'Consumer', 'OMC': 'Consumer',
            'T': 'Consumer', 'VZ': 'Consumer', 'TMUS': 'Consumer',
            'KO': 'Consumer', 'PEP': 'Consumer', 'PM': 'Consumer', 'MO': 'Consumer',
            'BUD': 'Consumer', 'TAP': 'Consumer', 'STZ': 'Consumer', 'MNST': 'Consumer',
            'CELH': 'Consumer', 'KDP': 'Consumer', 'ULTA': 'Consumer', 'ELF': 'Consumer',
            'RH': 'Consumer', 'DECK': 'Consumer', 'CROX': 'Consumer', 'LEVI': 'Consumer',
            'UAA': 'Consumer', 'ORLY': 'Consumer', 'AZO': 'Consumer', 'AAP': 'Consumer',
            'GPC': 'Consumer', 'TSCO': 'Consumer', 'DG': 'Consumer', 'DLTR': 'Consumer',
            'ROST': 'Consumer', 'TJX': 'Consumer', 'BBY': 'Consumer',
            'PG': 'Consumer', 'CL': 'Consumer', 'KHC': 'Consumer',
            'MDLZ': 'Consumer', 'GIS': 'Consumer', 'CLX': 'Consumer',
            'CHD': 'Consumer', 'SJM': 'Consumer', 'KMB': 'Consumer',
            'HRL': 'Consumer', 'CAG': 'Consumer', 'CPB': 'Consumer',
            'MKC': 'Consumer', 'HSY': 'Consumer', 'KR': 'Consumer', 'SYY': 'Consumer',
            'ADM': 'Consumer', 'TSN': 'Consumer', 'BG': 'Consumer',
            'KVUE': 'Consumer', 'EL': 'Consumer', 'AMCR': 'Consumer',
            'DPZ': 'Consumer', 'DRI': 'Consumer', 'EBAY': 'Consumer',
            'HAS': 'Consumer', 'HLT': 'Consumer', 'LVS': 'Consumer',
            'MAR': 'Consumer', 'MGM': 'Consumer', 'NCLH': 'Consumer',
            'RCL': 'Consumer', 'RL': 'Consumer', 'TPR': 'Consumer',
            'WYNN': 'Consumer', 'CCL': 'Consumer', 'WSM': 'Consumer',
            'POOL': 'Consumer', 'LW': 'Consumer', 'NWS': 'Consumer',
            'NWSA': 'Consumer', 'TKO': 'Consumer', 'LYV': 'Consumer',
            'BF.B': 'Consumer',
            'TXRH': 'Consumer', 'WING': 'Consumer', 'SHAK': 'Consumer',
            'SG': 'Consumer', 'LOCO': 'Consumer', 'DNUT': 'Consumer',
            'EAT': 'Consumer', 'CAKE': 'Consumer',
            'BJRI': 'Consumer', 'PLAY': 'Consumer', 'DIN': 'Consumer',
            'JACK': 'Consumer', 'ARCO': 'Consumer',
            'FIVE': 'Consumer', 'OLLI': 'Consumer', 'BJ': 'Consumer',
            'COLM': 'Consumer', 'VFC': 'Consumer',
            'GIII': 'Consumer', 'OXM': 'Consumer',
            'PVH': 'Consumer', 'COTY': 'Consumer', 'MNSO': 'Consumer',
            'AEO': 'Consumer', 'ANF': 'Consumer', 'GAP': 'Consumer',
            'VSCO': 'Consumer', 'BBWI': 'Consumer', 'RVLV': 'Consumer',
            'WRBY': 'Consumer', 'M': 'Consumer', 'KSS': 'Consumer', 'BURL': 'Consumer',
            'PENN': 'Consumer', 'CZR': 'Consumer',
            'BYD': 'Consumer', 'GDEN': 'Consumer',
            'VAC': 'Consumer', 'MTN': 'Consumer', 'FUN': 'Consumer',
            'PRKS': 'Consumer',
            'XOM': 'Energy', 'CVX': 'Energy', 'COP': 'Energy', 'SLB': 'Energy',
            'EOG': 'Energy', 'OXY': 'Energy', 'MPC': 'Energy', 'PSX': 'Energy',
            'VLO': 'Energy', 'TRGP': 'Energy', 'DVN': 'Energy', 'FANG': 'Energy',
            'WMB': 'Energy', 'APA': 'Energy', 'HAL': 'Energy', 'BKR': 'Energy',
            'NOV': 'Energy', 'FTI': 'Energy', 'NEE': 'Energy', 'DUK': 'Energy',
            'SO': 'Energy', 'D': 'Energy', 'AEP': 'Energy', 'EXC': 'Energy',
            'OKE': 'Energy',
            'ENPH': 'Energy', 'SEDG': 'Energy', 'RUN': 'Energy',
            'FSLR': 'Energy', 'PLUG': 'Energy', 'PBF': 'Energy', 'DK': 'Energy',
            'CTRA': 'Energy', 'OVV': 'Energy', 'PR': 'Energy', 'SM': 'Energy',
            'MGY': 'Energy', 'MTDR': 'Energy', 'CHRD': 'Energy', 'VNOM': 'Energy',
            'SMR': 'Energy', 'VST': 'Energy', 'CEG': 'Energy', 'CCJ': 'Energy',
            'LNG': 'Energy', 'AR': 'Energy', 'GEV': 'Energy',
            'SRE': 'Energy', 'AES': 'Energy', 'PCG': 'Energy',
            'EIX': 'Energy', 'XEL': 'Energy', 'WEC': 'Energy',
            'ES': 'Energy', 'ETR': 'Energy', 'PEG': 'Energy',
            'ED': 'Energy', 'FE': 'Energy', 'CNP': 'Energy',
            'PPL': 'Energy', 'AEE': 'Energy', 'ATO': 'Energy',
            'DTE': 'Energy', 'CMS': 'Energy', 'EVRG': 'Energy',
            'NI': 'Energy', 'LNT': 'Energy', 'NRG': 'Energy',
            'PNW': 'Energy', 'AWK': 'Energy',
            'KMI': 'Energy', 'TPL': 'Energy', 'EXE': 'Energy',
            'ARRY': 'Energy', 'MAXN': 'Energy', 'BE': 'Energy',
            'STEM': 'Energy', 'SHLS': 'Energy',
            'ORA': 'Energy', 'CWEN': 'Energy', 'TAC': 'Energy',
            'CNX': 'Energy', 'RRC': 'Energy', 'WFRD': 'Energy',
            'LBRT': 'Energy', 'PTEN': 'Energy',
            'HP': 'Energy',
            'BA': 'Industrials', 'CAT': 'Industrials', 'DE': 'Industrials', 'GE': 'Industrials',
            'HON': 'Industrials', 'MMM': 'Industrials', 'UNP': 'Industrials', 'NSC': 'Industrials',
            'CSX': 'Industrials', 'UPS': 'Industrials', 'FDX': 'Industrials', 'CHRW': 'Industrials',
            'CMI': 'Industrials', 'EMR': 'Industrials', 'ETN': 'Industrials', 'PH': 'Industrials',
            'ROK': 'Industrials', 'AME': 'Industrials', 'DOV': 'Industrials', 'ITW': 'Industrials',
            'DHI': 'Industrials', 'LEN': 'Industrials', 'NVR': 'Industrials', 'PHM': 'Industrials',
            'TOL': 'Industrials', 'BLD': 'Industrials', 'BLDR': 'Industrials', 'JBHT': 'Industrials',
            'KNX': 'Industrials', 'ODFL': 'Industrials', 'XPO': 'Industrials',
            'IR': 'Industrials', 'WM': 'Industrials', 'RSG': 'Industrials',
            'PCAR': 'Industrials', 'PWR': 'Industrials', 'JCI': 'Industrials',
            'AOS': 'Industrials', 'ROP': 'Industrials',
            'VRT': 'Industrials', 'EME': 'Industrials', 'APH': 'Industrials',
            'HUBB': 'Industrials', 'WCC': 'Industrials', 'TT': 'Industrials',
            'GNRC': 'Industrials',
            'GEO': 'Industrials', 'CXW': 'Industrials',
            'ADP': 'Industrials', 'OTIS': 'Industrials', 'CTAS': 'Industrials',
            'WAB': 'Industrials', 'FAST': 'Industrials', 'URI': 'Industrials',
            'CPRT': 'Industrials', 'GWW': 'Industrials', 'FIX': 'Industrials',
            'ROL': 'Industrials', 'ALLE': 'Industrials', 'SNA': 'Industrials',
            'SWK': 'Industrials', 'PNR': 'Industrials', 'PAYX': 'Industrials',
            'DAL': 'Industrials', 'UAL': 'Industrials', 'LUV': 'Industrials',
            'EXPD': 'Industrials', 'LII': 'Industrials', 'PKG': 'Industrials',
            'AVY': 'Industrials', 'MAS': 'Industrials', 'IP': 'Industrials',
            'WY': 'Industrials', 'BALL': 'Industrials', 'FTV': 'Industrials',
            'IFF': 'Industrials', 'BR': 'Industrials', 'J': 'Industrials',
            'VMC': 'Industrials', 'MLM': 'Industrials', 'CRH': 'Industrials',
            'XYL': 'Industrials', 'SW': 'Industrials',
            'ACM': 'Industrials', 'MTZ': 'Industrials', 'STRL': 'Industrials',
            'GVA': 'Industrials', 'ROAD': 'Industrials',
            'PRIM': 'Industrials', 'TPC': 'Industrials', 'AGX': 'Industrials',
            'UFPI': 'Industrials',
            'AWI': 'Industrials', 'TREX': 'Industrials', 'SITE': 'Industrials',
            'BFAM': 'Industrials', 'HRI': 'Industrials',
            'WSC': 'Industrials', 'SKYW': 'Industrials',
            'ALK': 'Industrials', 'JBLU': 'Industrials', 'AAL': 'Industrials',
            'SNDR': 'Industrials', 'SAIA': 'Industrials', 'ARCB': 'Industrials',
            'WERN': 'Industrials', 'HUBG': 'Industrials', 'R': 'Industrials', 'GATX': 'Industrials',
            'RXO': 'Industrials', 'ATKR': 'Industrials', 'AIT': 'Industrials',
            'REZI': 'Industrials', 'LECO': 'Industrials', 'MIDD': 'Industrials',
            'FELE': 'Industrials', 'WTS': 'Industrials', 'MWA': 'Industrials',
            'ESE': 'Industrials', 'IEX': 'Industrials',
            'AMT': 'Real Estate', 'PLD': 'Real Estate', 'CCI': 'Real Estate', 'EQIX': 'Real Estate',
            'PSA': 'Real Estate', 'DLR': 'Real Estate', 'WELL': 'Real Estate', 'O': 'Real Estate',
            'VICI': 'Real Estate', 'SPG': 'Real Estate', 'AVB': 'Real Estate', 'EQR': 'Real Estate',
            'MAA': 'Real Estate', 'UDR': 'Real Estate', 'CPT': 'Real Estate', 'ESS': 'Real Estate',
            'ELS': 'Real Estate', 'SUI': 'Real Estate', 'NXRT': 'Real Estate',
            'VTR': 'Real Estate', 'STWD': 'Real Estate', 'VLTO': 'Industrials', 'DOC': 'Real Estate', 'OHI': 'Real Estate',
            'SBRA': 'Real Estate', 'LTC': 'Real Estate', 'HR': 'Real Estate', 'MPT': 'Real Estate',
            'NHI': 'Real Estate', 'CTRE': 'Real Estate', 'IRM': 'Real Estate', 'CUBE': 'Real Estate',
            'NSA': 'Real Estate', 'REXR': 'Real Estate',
            'TRNO': 'Real Estate', 'SELF': 'Real Estate', 'SAFE': 'Real Estate',
            'EXR': 'Real Estate', 'ARE': 'Real Estate',
            'KIM': 'Real Estate', 'REG': 'Real Estate', 'INVH': 'Real Estate',
            'FRT': 'Real Estate', 'HST': 'Real Estate', 'BXP': 'Real Estate',
            'SBAC': 'Real Estate',
            'GLPI': 'Real Estate', 'SLG': 'Real Estate', 'VNO': 'Real Estate',
            'DEI': 'Real Estate', 'CUZ': 'Real Estate', 'HIW': 'Real Estate',
            'CDP': 'Real Estate', 'NNN': 'Real Estate', 'ADC': 'Real Estate',
            'EPRT': 'Real Estate', 'KRG': 'Real Estate', 'AKR': 'Real Estate',
            'BNL': 'Real Estate', 'GTY': 'Real Estate',
            'IIPR': 'Real Estate', 'APLE': 'Real Estate',
            'RLJ': 'Real Estate', 'PEB': 'Real Estate', 'SHO': 'Real Estate',
            'DRH': 'Real Estate', 'FR': 'Real Estate', 'STAG': 'Real Estate',
            'LXP': 'Real Estate', 'COLD': 'Real Estate', 'LAMR': 'Real Estate',
            'OUT': 'Real Estate',
            'NEM': 'Materials', 'FCX': 'Materials', 'GOLD': 'Materials', 'AU': 'Materials',
            'AEM': 'Materials', 'WPM': 'Materials', 'FNV': 'Materials', 'RGLD': 'Materials',
            'KGC': 'Materials', 'HL': 'Materials', 'NUE': 'Materials', 'STLD': 'Materials',
            'RS': 'Materials', 'CLF': 'Materials', 'MT': 'Materials',
            'TX': 'Materials', 'CMC': 'Materials', 'NB': 'Materials', 'ATI': 'Materials',
            'DOW': 'Materials', 'LYB': 'Materials', 'EMN': 'Materials', 'CE': 'Materials',
            'APD': 'Materials', 'LIN': 'Materials', 'GTLS': 'Materials', 'NUAI': 'Materials', 'ASPI': 'Materials', 'ECL': 'Materials',
            'SHW': 'Materials', 'PPG': 'Materials', 'RPM': 'Materials', 'AXTA': 'Materials',
            'ALB': 'Materials', 'SQM': 'Materials', 'LAC': 'Materials', 'AA': 'Materials',
            'MP': 'Materials', 'DD': 'Materials', 'USAR': 'Materials',
            'FUL': 'Materials', 'NEU': 'Materials', 'UUUU': 'Materials', 'B': 'Materials',
            'CTVA': 'Materials', 'MOS': 'Materials', 'CF': 'Materials',
            'PAAS': 'Materials', 'AG': 'Materials', 'CDE': 'Materials',
            'EGO': 'Materials', 'SSRM': 'Materials', 'HBM': 'Materials',
            'TECK': 'Materials', 'RIO': 'Materials', 'BHP': 'Materials',
            'VALE': 'Materials', 'SCCO': 'Materials', 'GFI': 'Materials',
            'BTG': 'Materials', 'IAUX': 'Materials', 'AMR': 'Materials',
            'HCC': 'Materials', 'CNR': 'Materials',
            'MEOH': 'Materials', 'CC': 'Materials', 'OLN': 'Materials', 'TROX': 'Materials',
            'HUN': 'Materials', 'WLK': 'Materials', 'CBT': 'Materials', 'NGVT': 'Materials',
            'ASH': 'Materials', 'SON': 'Materials', 'SEE': 'Materials',
            'GPK': 'Materials', 'SLVM': 'Materials',
            'LMT': 'Defense', 'RTX': 'Defense', 'NOC': 'Defense', 'GD': 'Defense',
            'LHX': 'Defense', 'HII': 'Defense', 'TXT': 'Defense', 'HWM': 'Defense',
            'AXON': 'Defense', 'KTOS': 'Defense', 'AVAV': 'Defense', 'AIR': 'Defense',
            'SAIC': 'Defense', 'LDOS': 'Defense', 'CACI': 'Defense', 'BAH': 'Defense',
            'BWXT': 'Defense', 'WWD': 'Defense', 'MOG.A': 'Defense', 'TDG': 'Defense',
            'HEI': 'Defense', 'CW': 'Defense', 'AIN': 'Defense',
            'PSN': 'Defense', 'MRCY': 'Defense', 'DRS': 'Defense',
            'RCAT': 'Defense', 'JOBY': 'Defense', 'ACHR': 'Defense',
            'OSIS': 'Defense', 'VSEC': 'Defense', 'BDC': 'Defense',
            'EQT': 'Energy',
            'ROCK': 'Industrials', 'MLI': 'Industrials', 'RUSHA': 'Industrials',
            'MYRG': 'Industrials', 'DY': 'Industrials', 'APOG': 'Industrials',
            'IMOS': 'Technology', 'VECO': 'Technology', 'POWI': 'Technology',
            'PLXS': 'Technology', 'VICR': 'Technology',
            'RKLB': 'Space', 'ASTS': 'Space', 'LUNR': 'Space', 'RDW': 'Space',
            'BKSY': 'Space', 'SPIR': 'Space', 'IRDM': 'Space', 'GSAT': 'Space',
            'COIN': 'Crypto', 'MSTR': 'Crypto', 'MARA': 'Crypto', 'RIOT': 'Crypto',
            'CLSK': 'Crypto', 'HUT': 'Crypto', 'BTDR': 'Crypto', 'BITF': 'Crypto',
            'CORZ': 'Crypto', 'WULF': 'Crypto', 'IREN': 'Crypto', 'CIFR': 'Crypto',
            'SPY': 'Index Fund', 'QQQ': 'Index Fund', 'IWM': 'Index Fund', 'VOO': 'Index Fund'
        };

        // API Configuration
        let POLYGON_API_KEY = localStorage.getItem('polygon_api_key') || '';
        let GOOGLE_CLIENT_ID = localStorage.getItem('google_client_id') || '';
        let GOOGLE_API_KEY = localStorage.getItem('google_api_key') || '';

        function checkApiKeysConfigured() {
            if (!POLYGON_API_KEY) {
                console.warn('Missing API key: Massive API Key');
                return false;
            }
            return true;
        }

        function isMarketOpen() {
            const now = new Date();
            const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
            const day = et.getDay();
            if (day === 0 || day === 6) return false;
            const hours = et.getHours();
            const minutes = et.getMinutes();
            const timeMinutes = hours * 60 + minutes;
            return timeMinutes >= 570 && timeMinutes < 960;
        }

        let priceCache = {};
        let apiCallsToday = 0;
        let lastResetDate = new Date().toDateString();

        function loadPriceCache() {
            const cached = localStorage.getItem('priceCache');
            const cacheDate = localStorage.getItem('priceCacheDate');
            const today = new Date().toDateString();
            if (cacheDate !== today) {
                localStorage.setItem('priceCacheDate', today);
                localStorage.setItem('apiCallsToday', '0');
                apiCallsToday = 0;
            } else {
                apiCallsToday = parseInt(localStorage.getItem('apiCallsToday') || '0');
            }
            if (cached) {
                priceCache = JSON.parse(cached);
            }
        }

        function savePriceToCache(symbol, priceData) {
            priceCache[symbol] = {
                ...priceData,
                timestamp: new Date().toISOString(),
                cachedAt: new Date().toLocaleTimeString()
            };
            localStorage.setItem('priceCache', JSON.stringify(priceCache));
        }

        function getCachedPrice(symbol) {
            if (priceCache[symbol]) {
                const cached = priceCache[symbol];
                const cacheAge = Date.now() - new Date(cached.timestamp).getTime();
                const fourHours = 4 * 60 * 60 * 1000;
                if (cacheAge < fourHours) {
                    return { ...cached, isFromCache: true };
                }
            }
            return null;
        }

        function initChart() {
            if (performanceChart) return;
            const ctx = document.getElementById('performanceChart').getContext('2d');
            performanceChart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [
                        { label: 'Total Return', data: [], borderColor: '#f59e0b', backgroundColor: 'rgba(245, 158, 11, 0.08)', borderWidth: 2.5, tension: 0.35, fill: true, pointRadius: 0, pointHoverRadius: 5, pointHoverBackgroundColor: '#f59e0b', pointHoverBorderColor: '#fff', pointHoverBorderWidth: 2 },
                        { label: 'SPY', data: [], borderColor: '#60a5fa', backgroundColor: 'transparent', borderWidth: 2, borderDash: [6, 3], tension: 0.35, fill: false, pointRadius: 0, pointHoverRadius: 4, pointHoverBackgroundColor: '#60a5fa', pointHoverBorderColor: '#fff', pointHoverBorderWidth: 2 },
                        { label: 'QQQ', data: [], borderColor: '#a78bfa', backgroundColor: 'transparent', borderWidth: 2, borderDash: [6, 3], tension: 0.35, fill: false, pointRadius: 0, pointHoverRadius: 4, pointHoverBackgroundColor: '#a78bfa', pointHoverBorderColor: '#fff', pointHoverBorderWidth: 2 },
                        { label: 'DIA', data: [], borderColor: '#34d399', backgroundColor: 'transparent', borderWidth: 2, borderDash: [6, 3], tension: 0.35, fill: false, pointRadius: 0, pointHoverRadius: 4, pointHoverBackgroundColor: '#34d399', pointHoverBorderColor: '#fff', pointHoverBorderWidth: 2 }
                    ]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    interaction: { intersect: false, mode: 'index' },
                    plugins: {
                        legend: { display: true, labels: { color: '#a8a8a0', font: { family: "'Inter', sans-serif", size: 11 }, boxWidth: 12, boxHeight: 12, padding: 16, usePointStyle: true } },
                        tooltip: { backgroundColor: 'rgba(22, 22, 25, 0.95)', titleColor: '#f5f5f0', bodyColor: '#a8a8a0', borderColor: 'rgba(245, 158, 11, 0.3)', borderWidth: 1, padding: 12, cornerRadius: 8, titleFont: { family: "'Inter', sans-serif", size: 12, weight: '600' }, bodyFont: { family: "'Inter', sans-serif", size: 12 }, displayColors: true, boxWidth: 8, boxHeight: 8, boxPadding: 4,
                            callbacks: {
                                label: function(context) { const val = context.parsed.y; if (val == null) return null; const sign = val >= 0 ? '+' : ''; return ` ${context.dataset.label}: ${sign}${val.toFixed(2)}%`; },
                                afterBody: function(contexts) { const totalVal = contexts[0]?.parsed?.y; const spyVal = contexts[1]?.parsed?.y; if (totalVal != null && spyVal != null) { const alpha = totalVal - spyVal; return `  Alpha: ${alpha >= 0 ? '+' : ''}${alpha.toFixed(2)}%`; } return ''; }
                            }
                        }
                    },
                    scales: {
                        y: { position: 'left', border: { display: false }, title: { display: true, text: 'Return %', color: '#78786e', font: { family: "'Inter', sans-serif", size: 10 } }, ticks: { color: '#78786e', font: { family: "'Inter', sans-serif", size: 11 }, padding: 8, callback: function(value) { return (value >= 0 ? '+' : '') + value.toFixed(1) + '%'; } }, grid: { color: function(context) { return context.tick.value === 0 ? 'rgba(255, 255, 255, 0.15)' : 'rgba(255, 200, 100, 0.05)'; }, drawTicks: false } },
                        x: { border: { display: false }, ticks: { color: '#78786e', font: { family: "'Inter', sans-serif", size: 10 }, padding: 6, maxRotation: 0 }, grid: { display: false } }
                    }
                }
            });
            const sectorCtx = document.getElementById('sectorChart').getContext('2d');
            sectorChart = new Chart(sectorCtx, {
                type: 'doughnut',
                data: { labels: [], datasets: [{ data: [], backgroundColor: ['#f59e0b','#a78bfa','#34d399','#60a5fa','#f97316','#ec4899','#fbbf24','#14b8a6','#8b5cf6','#f43f5e','#06b6d4','#84cc16'], borderWidth: 3, borderColor: '#1a1a22', hoverBorderColor: '#1a1a22', hoverOffset: 6 }] },
                options: { responsive: true, maintainAspectRatio: false, cutout: '68%', plugins: { legend: { display: false }, tooltip: { backgroundColor: 'rgba(22, 22, 25, 0.95)', titleColor: '#f5f5f0', bodyColor: '#a8a8a0', borderColor: 'rgba(255, 200, 100, 0.15)', borderWidth: 1, padding: 12, cornerRadius: 8, titleFont: { family: "'Inter', sans-serif", size: 12, weight: '600' }, bodyFont: { family: "'Inter', sans-serif", size: 12 }, callbacks: { label: function(context) { return ' ' + context.label + ': ' + context.parsed.toFixed(1) + '%'; } } } } }
            });
        }

        const BENCHMARK_CHART_TTL = 30 * 60 * 1000;
        const benchmarkChartCaches = { SPY: null, QQQ: null, DIA: null };
        async function fetchBenchmarkForChart(symbol, fromDate) {
            const cached = benchmarkChartCaches[symbol];
            if (cached && Date.now() - cached.fetchedAt < BENCHMARK_CHART_TTL) return cached.bars;
            if (!POLYGON_API_KEY) return null;
            try {
                const toStr = new Date().toISOString().split('T')[0];
                const resp = await fetch(`https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/day/${fromDate}/${toStr}?adjusted=true&sort=asc&limit=50000&apiKey=${POLYGON_API_KEY}`);
                if (!resp.ok) return null;
                const data = await resp.json();
                if (data.results && data.results.length > 0) { benchmarkChartCaches[symbol] = { bars: data.results, fetchedAt: Date.now() }; return data.results; }
            } catch (e) { console.warn(`${symbol} chart fetch failed:`, e.message); }
            return null;
        }
        async function fetchSPYForChart(fromDate) { return fetchBenchmarkForChart('SPY', fromDate); }

        async function updatePerformanceChart() {
            if (!performanceChart || portfolio.performanceHistory.length === 0) return;
            const dailyMap = {};
            for (const entry of portfolio.performanceHistory) {
                const date = new Date(entry.timestamp).toISOString().split('T')[0];
                if (!dailyMap[date] || entry.totalReturnPct != null) { dailyMap[date] = { value: entry.value, totalReturnPct: entry.totalReturnPct ?? null }; }
            }
            const allDates = Object.keys(dailyMap).sort();
            const dates = allDates.filter(d => dailyMap[d].totalReturnPct != null);
            if (dates.length < 1) return;
            const cumulativeReturns = dates.map(d => dailyMap[d].totalReturnPct);
            function computeBenchmarkReturns(bars, dates) {
                const returns = new Array(dates.length).fill(null);
                if (!bars || bars.length === 0) return returns;
                const byDate = {};
                for (const bar of bars) { const d = new Date(bar.t).toISOString().split('T')[0]; byDate[d] = bar.c; }
                let baselinePrice = null;
                for (const bar of bars) { const d = new Date(bar.t).toISOString().split('T')[0]; if (d <= dates[0]) baselinePrice = bar.c; else break; }
                if (!baselinePrice) baselinePrice = bars[0].c;
                let lastPrice = baselinePrice;
                for (let i = 0; i < dates.length; i++) { if (byDate[dates[i]]) lastPrice = byDate[dates[i]]; returns[i] = Math.round(((lastPrice - baselinePrice) / baselinePrice) * 100 * 100) / 100; }
                return returns;
            }
            let spyReturns = new Array(dates.length).fill(null);
            let qqqReturns = new Array(dates.length).fill(null);
            let diaReturns = new Array(dates.length).fill(null);
            try {
                const [spyBars, qqqBars, diaBars] = await Promise.all([fetchBenchmarkForChart('SPY', dates[0]), fetchBenchmarkForChart('QQQ', dates[0]), fetchBenchmarkForChart('DIA', dates[0])]);
                spyReturns = computeBenchmarkReturns(spyBars, dates);
                qqqReturns = computeBenchmarkReturns(qqqBars, dates);
                diaReturns = computeBenchmarkReturns(diaBars, dates);
            } catch (e) { console.warn('Benchmark chart data unavailable:', e.message); }
            const today = new Date(); const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
            const labels = dates.map(d => { const date = new Date(d + 'T12:00:00'); if (date.toDateString() === today.toDateString()) return 'Today'; if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'; return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); });
            performanceChart.data.labels = labels;
            performanceChart.data.datasets[0].data = cumulativeReturns;
            performanceChart.data.datasets[1].data = spyReturns;
            performanceChart.data.datasets[2].data = qqqReturns;
            performanceChart.data.datasets[3].data = diaReturns;
            performanceChart.update();
        }

        function initializeAccount() {
            const balance = parseFloat(document.getElementById('initialBalance').value);
            if (!balance || balance <= 0 || !Number.isFinite(balance)) { alert('Please enter a valid positive number for the starting balance.'); return; }
            if (portfolio.transactions.length > 0 || Object.keys(portfolio.holdings).length > 0) { if (!confirm(`⚠️ This will reset your portfolio to $${balance.toFixed(2)}.\n\nAll current holdings (${Object.keys(portfolio.holdings).length} positions) and transaction history (${portfolio.transactions.length} trades) will be erased.\n\nContinue?`)) return; }
            portfolio.cash = balance; portfolio.initialBalance = balance; portfolio.totalDeposits = balance;
            portfolio.holdings = {}; portfolio.transactions = [];
            portfolio.performanceHistory = [{ timestamp: new Date().toISOString(), value: balance }];
            addActivity('Account initialized with $' + balance.toLocaleString(), 'init');
            updateUI(); savePortfolio();
        }

        function clearLocalStorage() {
            if (confirm('⚠️ This will clear ALL local data including your portfolio!\n\nMake sure you have a backup first.\n\nContinue?')) {
                localStorage.clear(); preventAutoSave = true;
                const status = document.getElementById('recoveryStatus');
                status.textContent = '✅ Local storage cleared! Now use "Restore from Local File" to load your backup.';
                status.style.color = '#34d399';
                addActivity('🗑️ Local storage cleared - recovery mode active', 'warning');
            }
        }

        function restoreFromLocalFile(input) {
            const status = document.getElementById('recoveryStatus');
            const file = input.files[0];
            if (!file) return;
            if (!file.name.endsWith('.json')) { status.textContent = '❌ Please select a .json file.'; status.style.color = '#ef4444'; return; }
            if (!confirm(`⚠️ This will replace your current portfolio with the data from "${file.name}".\n\nCurrent portfolio will be overwritten.\n\nContinue?`)) { input.value = ''; return; }
            status.textContent = `⏳ Reading ${file.name}...`; status.style.color = '#3b82f6';
            const reader = new FileReader();
            reader.onload = function(e) {
                try {
                    const restoredPortfolio = JSON.parse(e.target.result);
                    if (typeof restoredPortfolio.cash === 'undefined' || typeof restoredPortfolio.holdings === 'undefined') throw new Error('File does not appear to be a valid APEX portfolio (missing cash or holdings).');
                    console.log('Loaded portfolio from local file:', Object.keys(restoredPortfolio.holdings).length, 'positions');
                    preventAutoSave = true;
                    portfolio = restoredPortfolio;
                    localStorage.setItem('aiTradingPortfolio', JSON.stringify(portfolio));
                    updateUI(); updatePerformanceAnalytics(); updateSectorAllocation();
                    preventAutoSave = false;
                    const holdingsCount = Object.keys(portfolio.holdings).length;
                    status.textContent = `✅ Portfolio restored from ${file.name}! ${holdingsCount} positions. Reloading...`;
                    status.style.color = '#34d399';
                    addActivity(`💾 Portfolio restored from local file "${file.name}" - ${holdingsCount} positions`, 'success');
                    setTimeout(() => { location.reload(); }, 2000);
                } catch (error) { preventAutoSave = false; status.textContent = '❌ Failed to restore: ' + error.message; status.style.color = '#ef4444'; console.error('Local file restore error:', error); }
            };
            reader.onerror = function() { status.textContent = '❌ Failed to read file.'; status.style.color = '#ef4444'; };
            reader.readAsText(file); input.value = '';
        }

        function checkAndResetApiCounter() {
            const today = new Date().toDateString();
            if (!lastResetDate) lastResetDate = today;
            if (today !== lastResetDate) { apiCallsToday = 0; lastResetDate = today; localStorage.setItem('apiCallsToday', '0'); localStorage.setItem('lastResetDate', today); }
        }

        function loadApiUsage() {
            const savedCalls = localStorage.getItem('apiCallsToday');
            const savedDate = localStorage.getItem('lastResetDate');
            const savedCache = localStorage.getItem('priceCache');
            if (savedDate) lastResetDate = savedDate; else lastResetDate = new Date().toDateString();
            if (savedCalls) apiCallsToday = parseInt(savedCalls);
            if (savedCache) { try { priceCache = JSON.parse(savedCache); } catch (e) { priceCache = {}; } }
            checkAndResetApiCounter(); updateApiUsageDisplay();
        }

        function saveApiUsage() {
            localStorage.setItem('apiCallsToday', apiCallsToday.toString());
            localStorage.setItem('lastResetDate', lastResetDate);
            localStorage.setItem('priceCache', JSON.stringify(priceCache));
        }

        function updateApiUsageDisplay() {
            const statusEl = document.getElementById('apiUsageStatus');
            if (statusEl) { statusEl.textContent = `API Calls: ${apiCallsToday} used today | Unlimited remaining ✅`; statusEl.style.color = '#34d399'; }
        }

        // === TECHNICAL INDICATORS ===

        function calculateRSI(bars, period = 14) {
            if (!bars || bars.length < period + 1) return null;
            let gainSum = 0, lossSum = 0;
            for (let i = 1; i <= period; i++) { const change = bars[i].c - bars[i - 1].c; if (change > 0) gainSum += change; else lossSum += Math.abs(change); }
            let avgGain = gainSum / period; let avgLoss = lossSum / period;
            for (let i = period + 1; i < bars.length; i++) { const change = bars[i].c - bars[i - 1].c; avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period; avgLoss = (avgLoss * (period - 1) + (change < 0 ? Math.abs(change) : 0)) / period; }
            if (avgLoss === 0) return 100;
            const rs = avgGain / avgLoss;
            return Math.round((100 - 100 / (1 + rs)) * 10) / 10;
        }

        function calculateSMA(bars, period = 20) {
            if (!bars || bars.length < period) return null;
            const slice = bars.slice(-period);
            return Math.round(slice.reduce((sum, b) => sum + b.c, 0) / period * 100) / 100;
        }

        function calculateEMAArray(closes, period) {
            if (closes.length < period) return [];
            const multiplier = 2 / (period + 1);
            const emaValues = [];
            let ema = closes.slice(0, period).reduce((s, c) => s + c, 0) / period;
            emaValues.push(ema);
            for (let i = period; i < closes.length; i++) { ema = (closes[i] - ema) * multiplier + ema; emaValues.push(ema); }
            return emaValues;
        }

        function calculateMACD(bars) {
            if (!bars || bars.length < 35) return null;
            const closes = bars.map(b => b.c);
            const ema12 = calculateEMAArray(closes, 12);
            const ema26 = calculateEMAArray(closes, 26);
            const offset = 26 - 12;
            const macdLine = [];
            for (let i = 0; i < ema26.length; i++) { macdLine.push(ema12[i + offset] - ema26[i]); }
            const signalLine = calculateEMAArray(macdLine, 9);
            if (signalLine.length < 2) return null;
            const currentMACD = macdLine[macdLine.length - 1];
            const currentSignal = signalLine[signalLine.length - 1];
            const prevMACD = macdLine[macdLine.length - 2];
            const prevSignal = signalLine.length >= 2 ? signalLine[signalLine.length - 2] : currentSignal;
            const histogram = currentMACD - currentSignal;
            let crossover = 'none';
            if (prevMACD <= prevSignal && currentMACD > currentSignal) crossover = 'bullish';
            else if (prevMACD >= prevSignal && currentMACD < currentSignal) crossover = 'bearish';
            return { macd: Math.round(currentMACD * 1000) / 1000, signal: Math.round(currentSignal * 1000) / 1000, histogram: Math.round(histogram * 1000) / 1000, crossover };
        }

        function calculateSMACrossover(bars) {
            if (!bars || bars.length < 52) return null;
            const sma20Now = calculateSMA(bars, 20); const sma50Now = calculateSMA(bars, 50);
            if (sma20Now == null || sma50Now == null) return null;
            const prevBars = bars.slice(0, -1);
            const sma20Prev = calculateSMA(prevBars, 20); const sma50Prev = calculateSMA(prevBars, 50);
            if (sma20Prev == null || sma50Prev == null) return null;
            let crossover = 'none';
            if (sma20Prev <= sma50Prev && sma20Now > sma50Now) crossover = 'bullish';
            else if (sma20Prev >= sma50Prev && sma20Now < sma50Now) crossover = 'bearish';
            const spread = sma50Now !== 0 ? ((sma20Now - sma50Now) / sma50Now * 100) : 0;
            return { sma50: sma50Now, crossover, spread: Math.round(spread * 100) / 100 };
        }

        // multiDayCache kept as empty — used by calculate5DayMomentum and calculateVolumeRatio
        let multiDayCache = {};

        function calculate5DayMomentum(priceData, symbol) {
            const allBars = multiDayCache[symbol];
            if (!allBars || allBars.length < 2) {
                if (!priceData || !priceData.price) return { score: 0, trend: 'unknown', basis: 'no-data' };
                const cp = priceData.changePercent || 0;
                let score = 5;
                if (cp > 5) score = 7; else if (cp > 2) score = 6.5; else if (cp > 0) score = 6;
                else if (cp > -2) score = 4; else if (cp > -5) score = 2; else score = 0;
                return { score, trend: score >= 6 ? 'building' : score <= 4 ? 'fading' : 'neutral', changePercent: cp, basis: '1-day-fallback' };
            }
            const bars = allBars.slice(-5);
            const latest = bars[bars.length - 1], oldest = bars[0], mid = bars[Math.floor(bars.length / 2)];
            const totalReturn = ((latest.c - oldest.c) / oldest.c) * 100;
            const firstHalfReturn = ((mid.c - oldest.c) / oldest.c) * 100;
            const secondHalfReturn = ((latest.c - mid.c) / mid.c) * 100;
            const isAccelerating = secondHalfReturn > firstHalfReturn;
            let upDays = 0;
            for (let i = 1; i < bars.length; i++) { if (bars[i].c > bars[i-1].c) upDays++; }
            const upDayRatio = upDays / (bars.length - 1);
            const recentVol = bars.slice(-2).reduce((s, b) => s + b.v, 0) / 2;
            const earlyVol = bars.slice(0, 2).reduce((s, b) => s + b.v, 0) / 2;
            const volumeTrend = earlyVol > 0 ? recentVol / earlyVol : 1;
            let score = 5;
            if (totalReturn > 8) score += 3; else if (totalReturn > 4) score += 2; else if (totalReturn > 1) score += 1;
            else if (totalReturn < -8) score -= 3; else if (totalReturn < -4) score -= 2; else if (totalReturn < -1) score -= 1;
            if (upDayRatio >= 0.8) score += 1.5; else if (upDayRatio >= 0.6) score += 0.5;
            else if (upDayRatio <= 0.2) score -= 1.5; else if (upDayRatio <= 0.4) score -= 0.5;
            if (isAccelerating && totalReturn > 0) score += 0.5;
            else if (!isAccelerating && totalReturn < 0) score -= 0.5;
            score = Math.max(0, Math.min(10, Math.round(score * 10) / 10));
            let trend = 'neutral';
            if (score >= 7 && isAccelerating) trend = 'building';
            else if (score >= 6) trend = 'steady-up';
            else if (score <= 3 && !isAccelerating) trend = 'fading';
            else if (score <= 4) trend = 'steady-down';
            return { score: Math.round(score * 10) / 10, trend, totalReturn5d: Math.round(totalReturn * 100) / 100, todayChange: priceData?.changePercent || 0, upDays, totalDays: bars.length - 1, isAccelerating, volumeTrend: Math.round(volumeTrend * 100) / 100, basis: '5-day-real' };
        }

        function calculateVolumeRatio(symbol) {
            const bars = multiDayCache[symbol];
            if (!bars || bars.length < 6) return null;
            const todayBar = bars[bars.length - 1];
            const todayVol = todayBar.v;
            if (!todayVol || todayVol <= 0) return null;
            const histBars = bars.slice(-21, -1);
            if (histBars.length < 5) return null;
            const validBars = histBars.filter(b => b.v > 0);
            if (validBars.length < 5) return null;
            const avgVol = validBars.reduce((s, b) => s + b.v, 0) / validBars.length;
            let projectedVol = todayVol;
            if (isMarketOpen()) {
                const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
                const elapsedMin = (et.getHours() * 60 + et.getMinutes()) - 570;
                if (elapsedMin > 0) projectedVol = todayVol * (390 / elapsedMin);
            }
            return { ratio: Math.round((projectedVol / avgVol) * 100) / 100, todayVolume: todayVol, avgVolume: Math.round(avgVol) };
        }

        // === PRICE FETCHING ===

        let bulkSnapshotCache = {};
        let bulkSnapshotTimestamp = 0;
        let bulkSnapshotRaw = {};

        let lastHoldingDataArray = [];
        let holdingsSortAsc = false;
        let holdingsSortMode = 'dateAdded';

        async function fetchIndexSnapshot(tickers) {
            if (!POLYGON_API_KEY) return {};
            try {
                const tickerParam = tickers.join(',');
                const response = await fetch(`https://api.polygon.io/v3/snapshot/indices?ticker.any_of=${tickerParam}&apiKey=${POLYGON_API_KEY}`);
                const data = await response.json();
                const result = {};
                if (data && data.results) {
                    for (const idx of data.results) {
                        if (idx.ticker && idx.session) { result[idx.ticker] = { price: idx.value ?? idx.session?.close ?? null, change: idx.session?.change ?? null, changePercent: idx.session?.change_percent ?? null }; }
                    }
                }
                return result;
            } catch (e) { console.warn('Index snapshot fetch failed:', e.message); return {}; }
        }

        async function fetchBulkSnapshot(symbols) {
            const now = Date.now();
            const allCached = symbols.every(s => bulkSnapshotCache[s]);
            if (now - bulkSnapshotTimestamp < 15000 && allCached) { console.log('Using cached bulk snapshot (' + Math.floor((now - bulkSnapshotTimestamp) / 1000) + 's old)'); return bulkSnapshotCache; }
            if (!POLYGON_API_KEY) throw new Error('API_KEY_MISSING');
            try {
                const tickerParam = symbols.join(',');
                const response = await fetch(`https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${tickerParam}&apiKey=${POLYGON_API_KEY}`);
                const data = await response.json();
                if (data && data.status === 'OK' && data.tickers && data.tickers.length > 0) {
                    const result = {};
                    data.tickers.forEach(ticker => {
                        const symbol = ticker.ticker; const day = ticker.day; const prevDay = ticker.prevDay;
                        if (!day || !prevDay) return;
                        const marketOpen = isMarketOpen();
                        let currentPrice;
                        if (marketOpen) currentPrice = (ticker.lastTrade && ticker.lastTrade.p) || day.c || day.l;
                        else currentPrice = day.c || (ticker.lastTrade && ticker.lastTrade.p) || day.l;
                        const prevClose = prevDay.c;
                        if (!currentPrice || currentPrice === 0) currentPrice = prevClose;
                        if (!currentPrice || !prevClose) return;
                        let change, changePercent;
                        if (marketOpen && ticker.todaysChange != null) { change = ticker.todaysChange; changePercent = ticker.todaysChangePerc; }
                        else { change = currentPrice - prevClose; changePercent = (currentPrice - prevClose) / prevClose * 100; }
                        result[symbol] = { price: parseFloat(currentPrice), change: parseFloat(change), changePercent: parseFloat(changePercent), vwap: ticker.day?.vw ? parseFloat(ticker.day.vw) : null, timestamp: new Date().toISOString(), isReal: true, note: marketOpen ? 'Real-time' : 'Market closed' };
                        priceCache[symbol] = result[symbol];
                    });
                    Object.assign(bulkSnapshotCache, result); bulkSnapshotTimestamp = now;
                    apiCallsToday++; saveApiUsage(); updateApiUsageDisplay();
                    data.tickers.forEach(ticker => { bulkSnapshotRaw[ticker.ticker] = ticker; });
                    console.log(`✅ Bulk snapshot: ${Object.keys(result).length}/${symbols.length} tickers in 1 API call`);
                    return result;
                }
                throw new Error('Bulk snapshot failed: ' + JSON.stringify(data).substring(0, 200));
            } catch (error) { console.warn('Bulk snapshot failed, falling back to individual calls:', error.message); return null; }
        }

        function getCurrentPositionBuys(symbol) {
            const allTx = portfolio.transactions || [];
            let lastFullSellIdx = -1; let runningShares = 0;
            for (let i = 0; i < allTx.length; i++) {
                const t = allTx[i]; if (t.symbol !== symbol) continue;
                if (t.type === 'BUY') runningShares += t.shares;
                if (t.type === 'SELL') { runningShares -= t.shares; if (runningShares <= 0) { lastFullSellIdx = i; runningShares = 0; } }
            }
            return allTx.filter((t, idx) => t.type === 'BUY' && t.symbol === symbol && idx > lastFullSellIdx);
        }

        async function getStockPrice(symbol) {
            if (!POLYGON_API_KEY) throw new Error('API_KEY_MISSING: Polygon API key not configured');
            checkAndResetApiCounter();
            const now = Date.now(); const cacheKey = symbol;
            if (priceCache[cacheKey]) {
                const cacheAge = now - new Date(priceCache[cacheKey].timestamp).getTime();
                if (cacheAge < 60000) { return priceCache[cacheKey]; } else { delete priceCache[cacheKey]; }
            }
            try {
                const response = await fetch(`https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${symbol}?apiKey=${POLYGON_API_KEY}`);
                const data = await response.json();
                if (data && data.status === 'OK' && data.ticker) {
                    const ticker = data.ticker; const day = ticker.day; const prevDay = ticker.prevDay;
                    if (!day || !prevDay) throw new Error('Missing price data in response');
                    const marketOpen = isMarketOpen();
                    let currentPrice;
                    if (marketOpen) currentPrice = (ticker.lastTrade && ticker.lastTrade.p) || day.c || day.l;
                    else currentPrice = day.c || (ticker.lastTrade && ticker.lastTrade.p) || day.l;
                    const prevClose = prevDay.c;
                    if (!currentPrice || currentPrice === 0) currentPrice = prevClose;
                    if (!currentPrice || !prevClose) throw new Error('Missing price values');
                    let change, changePercent;
                    if (marketOpen && ticker.todaysChange != null) { change = ticker.todaysChange; changePercent = ticker.todaysChangePerc; }
                    else { change = currentPrice - prevClose; changePercent = (currentPrice - prevClose) / prevClose * 100; }
                    const priceData = { price: parseFloat(currentPrice), change: parseFloat(change), changePercent: parseFloat(changePercent), timestamp: new Date().toISOString(), isReal: true, note: marketOpen ? 'Real-time' : 'Market closed' };
                    priceCache[cacheKey] = priceData; apiCallsToday++; saveApiUsage(); updateApiUsageDisplay();
                    return priceData;
                }
                if (data && data.error) throw new Error(`API_ERROR: ${data.error}`);
                if (data && data.status === 'ERROR') throw new Error(`API_ERROR: ${data.message || 'Unknown Polygon error'}`);
                throw new Error(`NO_DATA: Unable to fetch data for ${symbol}`);
            } catch (error) {
                if (error.message.startsWith('API_LIMIT_REACHED') || error.message.startsWith('API_ERROR') || error.message.startsWith('NO_DATA')) throw error;
                throw new Error(`NETWORK_ERROR: Failed to fetch price for ${symbol}: ${error.message}`);
            }
        }

        async function calculatePortfolioValue() {
            let total = 0; const priceData = {};
            const holdingSymbols = Object.keys(portfolio.holdings);
            if (holdingSymbols.length === 0) return { total, priceData };
            try {
                const snapshot = await fetchBulkSnapshot(holdingSymbols);
                for (const [symbol, shares] of Object.entries(portfolio.holdings)) {
                    if (snapshot[symbol] && snapshot[symbol].price > 0) { priceData[symbol] = snapshot[symbol]; total += snapshot[symbol].price * shares; }
                }
            } catch (error) { console.warn('Bulk snapshot failed in calculatePortfolioValue:', error.message); }
            for (const [symbol, shares] of Object.entries(portfolio.holdings)) {
                if (!priceData[symbol]) {
                    const lastTransaction = portfolio.transactions.filter(t => t.symbol === symbol && t.price > 0).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
                    if (lastTransaction) { priceData[symbol] = { price: lastTransaction.price, change: 0, changePercent: 0, isReal: false, note: 'Using last known price' }; total += lastTransaction.price * shares; }
                    else { priceData[symbol] = { price: 0, change: 0, changePercent: 0, isReal: false, note: 'Price unavailable' }; }
                }
            }
            return { total, priceData };
        }

        // === HOLDINGS RENDERING (SIMPLIFIED) ===

        function sortAndRenderHoldings(dataArray) {
            const sortMode = holdingsSortMode || 'dateAdded';
            const sorted = [...dataArray];
            switch (sortMode) {
                case 'totalPL': sorted.sort((a, b) => b.gainLossPercent - a.gainLossPercent); break;
                case 'dailyChange': sorted.sort((a, b) => b.stockPrice.changePercent - a.stockPrice.changePercent); break;
                case 'positionSize': sorted.sort((a, b) => b.currentValue - a.currentValue); break;
                case 'symbol': sorted.sort((a, b) => a.symbol.localeCompare(b.symbol)); break;
                case 'dateAdded': default: sorted.sort((a, b) => a.insertionOrder - b.insertionOrder); break;
            }
            if (holdingsSortAsc) sorted.reverse();

            const holdingsList = document.getElementById('holdingsList');
            const holdingsDetailGrid = document.getElementById('holdingsDetailGrid');
            let compactHtml = '';
            let detailHtml = '';
            for (const h of sorted) {
                compactHtml += `
                    <div class="sidebar-holding-compact">
                        <div class="compact-left">
                            <span class="compact-symbol">${h.symbol}</span>
                            <span class="compact-shares">${h.shares} shares</span>
                        </div>
                        <div class="compact-right">
                            <span class="compact-price">$${h.stockPrice.price.toFixed(2)}</span>
                            <span class="compact-daily ${h.changeClass}">${h.stockPrice.changePercent >= 0 ? '+' : ''}${h.stockPrice.changePercent.toFixed(2)}%</span>
                        </div>
                    </div>
                `;

                const stopPrice = h.avgPurchasePrice > 0 ? h.avgPurchasePrice * 0.9 : null;
                const targetPrice = h.avgPurchasePrice > 0 ? h.avgPurchasePrice * 1.1 : null;

                detailHtml += `
                    <div class="holding-item holding-card ${h.gainLoss >= 0 ? 'card-positive' : 'card-negative'}">
                        <div class="holding-card-header">
                            <div>
                                <div class="holding-card-symbol">${h.symbol}</div>
                                <div class="holding-card-name"><a href="https://stockanalysis.com/stocks/${encodeURIComponent(h.symbol.toLowerCase())}/" target="_blank" rel="noopener" class="holding-card-link">${h.stockName}</a> <span class="holding-card-sector">· ${h.stockSector}</span></div>
                                <div class="holding-card-shares">${h.shares} shares · ${h.daysHeld === 0 ? 'Today' : h.daysHeld + 'd'} · ${h.positionSizePercent.toFixed(1)}% of portfolio</div>
                            </div>
                            <div>
                                <div class="holding-card-value">$${h.currentValue.toLocaleString(undefined, {minimumFractionDigits: 2})}</div>
                                <div class="holding-card-gainloss ${h.gainLossClass}">${h.gainLoss >= 0 ? '+' : ''}$${Math.abs(h.gainLoss).toFixed(2)} (${h.gainLossPercent >= 0 ? '+' : ''}${h.gainLossPercent.toFixed(2)}%)</div>
                                <div class="holding-card-daily ${h.dailyClass}">
                                    ${h.daysHeld === 0
                                        ? `Since entry: ${h.gainLossPercent >= 0 ? '+' : ''}${h.gainLossPercent.toFixed(2)}% · ${h.gainLoss >= 0 ? '+' : ''}$${h.gainLoss.toFixed(2)}`
                                        : `Today: ${h.stockPrice.changePercent >= 0 ? '+' : ''}${h.stockPrice.changePercent.toFixed(2)}% · ${h.dayPL >= 0 ? '+' : ''}$${h.dayPL.toFixed(2)}`
                                    }
                                </div>
                            </div>
                        </div>
                        <div class="holding-card-stats">
                            ${stopPrice ? '<span class="hc-stat"><span class="hc-stat-lbl">Stop</span><span class="hc-stat-val ' + (h.stockPrice.price <= stopPrice ? 'negative' : '') + '">$' + stopPrice.toFixed(2) + '</span></span>' : ''}
                            ${targetPrice ? '<span class="hc-stat"><span class="hc-stat-lbl">Target</span><span class="hc-stat-val ' + (h.stockPrice.price >= targetPrice ? 'positive' : '') + '">$' + targetPrice.toFixed(2) + '</span></span>' : ''}
                        </div>
                        <div class="holding-card-footer">
                            <div><span class="holding-card-footer-label">Entry:</span> <span class="holding-card-footer-value">${h.earliestDate ? h.earliestDate.toLocaleDateString('en-US', {month: 'short', day: 'numeric'}) : 'N/A'}</span></div>
                            <div><span class="holding-card-footer-label">Cost:</span> <span class="holding-card-footer-value">$${h.avgPurchasePrice.toFixed(2)}</span></div>
                            <div><span class="holding-card-footer-label">Now:</span> <span class="holding-card-footer-value">$${h.stockPrice.price.toFixed(2)}</span></div>
                        </div>
                    </div>
                `;
            }
            if (holdingsList) holdingsList.innerHTML = compactHtml;
            if (holdingsDetailGrid) holdingsDetailGrid.innerHTML = detailHtml;
        }

        function applyHoldingsSort() {
            if (lastHoldingDataArray.length > 0) {
                sortAndRenderHoldings(lastHoldingDataArray);
            }
        }

        function toggleHoldingsSortDir() {
            holdingsSortAsc = !holdingsSortAsc;
            const btn = document.getElementById('holdingsSortDir');
            if (btn) btn.innerHTML = holdingsSortAsc ? '&#9650;' : '&#9660;';
            applyHoldingsSort();
        }

        function toggleSortDropdown() {
            const menu = document.getElementById('holdingsSortMenu');
            if (menu) menu.classList.toggle('open');
        }

        function selectSortOption(el) {
            holdingsSortMode = el.dataset.value;
            document.getElementById('holdingsSortLabel').textContent = el.textContent;
            const menu = document.getElementById('holdingsSortMenu');
            menu.querySelectorAll('.custom-select-option').forEach(o => o.classList.remove('selected'));
            el.classList.add('selected');
            menu.classList.remove('open');
            applyHoldingsSort();
        }

        // Close custom dropdown when clicking outside
        document.addEventListener('click', (e) => {
            const wrapper = document.getElementById('holdingsSortWrapper');
            if (wrapper && !wrapper.contains(e.target)) {
                const menu = document.getElementById('holdingsSortMenu');
                if (menu) menu.classList.remove('open');
            }
        });

        // === UPDATE UI (SIMPLIFIED) ===

        async function updateUI() {
            try {
                const { total: totalValue, priceData } = await calculatePortfolioValue();

            let dailyGain = 0;
            let dailyGainPercent = 0;

            const now_local = new Date();
            const dayOfWeek = now_local.getDay();
            const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

            if (!isWeekend) {
                const todayStart = new Date(now_local.getFullYear(), now_local.getMonth(), now_local.getDate());
                for (const [symbol, shares] of Object.entries(portfolio.holdings)) {
                    const sp = priceData[symbol];
                    if (sp && sp.change != null) {
                        const buys = getCurrentPositionBuys(symbol);
                        const todayBuys = buys.filter(t => {
                            const bd = new Date(t.timestamp);
                            return new Date(bd.getFullYear(), bd.getMonth(), bd.getDate()).getTime() === todayStart.getTime();
                        });
                        const todayShares = todayBuys.reduce((sum, t) => sum + t.shares, 0);
                        const priorShares = shares - todayShares;
                        let holdingDailyChange;
                        if (todayShares > 0 && priorShares > 0) {
                            // Mixed: prior shares use prev close, today's shares use entry price
                            const todayCost = todayBuys.reduce((sum, t) => sum + (t.cost || t.price * t.shares), 0);
                            const todayAvg = todayCost / todayShares;
                            holdingDailyChange = (sp.change * priorShares) + ((sp.price - todayAvg) * todayShares);
                        } else if (todayShares > 0) {
                            // All shares bought today — use entry price as baseline
                            const totalCost = buys.reduce((sum, t) => sum + (t.cost || t.price * t.shares), 0);
                            const totalShares = buys.reduce((sum, t) => sum + t.shares, 0);
                            const avgEntry = totalCost / totalShares;
                            holdingDailyChange = (sp.price - avgEntry) * shares;
                        } else {
                            // All shares from before today — use prev close
                            holdingDailyChange = sp.change * shares;
                        }
                        dailyGain += holdingDailyChange;
                    }
                }
                const baseValue = totalValue - dailyGain;
                if (baseValue > 0) dailyGainPercent = (dailyGain / baseValue) * 100;
            }

            document.getElementById('dailyPerformance').textContent = dailyGainPercent.toFixed(2) + '%';
            document.getElementById('dailyPerformance').className = 'index-price';
            document.getElementById('dailyPerformance').style.color = dailyGainPercent >= 0 ? '#34d399' : '#f87171';
            document.getElementById('dailyPerformanceDollar').textContent = (dailyGain >= 0 ? '+' : '') + '$' + dailyGain.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
            document.getElementById('dailyPerformanceDollar').className = 'index-change ' + (dailyGain >= 0 ? 'positive' : 'negative');

            let totalInvested = 0;
            for (const [symbol, shares] of Object.entries(portfolio.holdings)) {
                const buys = getCurrentPositionBuys(symbol);
                if (buys.length > 0) {
                    const totalCost = buys.reduce((sum, t) => sum + (t.price * t.shares), 0);
                    const totalShares = buys.reduce((sum, t) => sum + t.shares, 0);
                    totalInvested += totalShares > 0 ? (totalCost / totalShares) * shares : 0;
                }
            }

            document.getElementById('portfolioValue').textContent = '$' + totalValue.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
            document.getElementById('investedValue').textContent = '$' + totalInvested.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
            document.getElementById('positionsCount').textContent = Object.keys(portfolio.holdings).length;

            const heroChangeEl = document.getElementById('heroChange');
            if (heroChangeEl) {
                if (dailyGain !== 0 || dailyGainPercent !== 0) {
                    const sign = dailyGain >= 0 ? '+' : '';
                    heroChangeEl.textContent = sign + '$' + dailyGain.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ' (' + sign + dailyGainPercent.toFixed(2) + '%) today';
                    heroChangeEl.className = 'hero-change ' + (dailyGain >= 0 ? 'positive' : 'negative');
                } else { heroChangeEl.textContent = ''; }
            }

            const unrealizedPL = totalValue - totalInvested;
            const unrealizedEl = document.getElementById('unrealizedPL');
            if (unrealizedEl) { unrealizedEl.textContent = (unrealizedPL >= 0 ? '+' : '') + '$' + unrealizedPL.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2}); unrealizedEl.style.color = unrealizedPL >= 0 ? 'var(--green)' : 'var(--red)'; }
            const realizedTotal = (portfolio.closedTrades || []).reduce((s, t) => s + t.profitLoss, 0);
            const realizedEl = document.getElementById('realizedPL');
            if (realizedEl) { realizedEl.textContent = (realizedTotal >= 0 ? '+' : '') + '$' + realizedTotal.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2}); realizedEl.style.color = realizedTotal >= 0 ? 'var(--green)' : 'var(--red)'; }

            if (privacyMode) applyPrivacyMode();

            const holdingsList = document.getElementById('holdingsList');
            const holdingsDetailGrid = document.getElementById('holdingsDetailGrid');
            if (Object.keys(portfolio.holdings).length === 0) {
                holdingsList.innerHTML = '<div class="empty-state">No positions yet</div>';
                if (holdingsDetailGrid) holdingsDetailGrid.innerHTML = '<div class="empty-state">No positions yet</div>';
            } else {
                const holdingDataArray = [];
                let insertionOrder = 0;
                for (const [symbol, shares] of Object.entries(portfolio.holdings)) {
                    const stockPrice = priceData[symbol] || { price: 0, change: 0, changePercent: 0 };
                    const currentValue = stockPrice.price * shares;
                    const changeClass = stockPrice.change >= 0 ? 'positive' : 'negative';
                    const buyTransactions = getCurrentPositionBuys(symbol);
                    let avgPurchasePrice = 0; let earliestDate = null; let daysHeld = 0;
                    if (buyTransactions.length > 0) {
                        const totalCost = buyTransactions.reduce((sum, t) => sum + (t.cost || t.price * t.shares), 0);
                        const totalShares = buyTransactions.reduce((sum, t) => sum + t.shares, 0);
                        avgPurchasePrice = totalCost / totalShares;
                        earliestDate = new Date(buyTransactions[0].timestamp);
                        daysHeld = countTradingDays(earliestDate, new Date());
                    }
                    const gainLoss = currentValue - (avgPurchasePrice * shares);
                    const gainLossPercent = avgPurchasePrice > 0 ? ((stockPrice.price - avgPurchasePrice) / avgPurchasePrice) * 100 : 0;
                    const positionSizePercent = totalValue > 0 ? (currentValue / totalValue) * 100 : 0;
                    const stockName = stockNames[symbol] || symbol;
                    const stockSector = stockSectors[symbol] || 'Unknown';
                    const gainLossClass = gainLoss >= 0 ? 'positive' : 'negative';

                    // Compute per-holding daily P&L (split today buys vs prior)
                    const _now = new Date();
                    const _todayStart = new Date(_now.getFullYear(), _now.getMonth(), _now.getDate());
                    const _todayBuys = buyTransactions.filter(t => {
                        const bd = new Date(t.timestamp);
                        return new Date(bd.getFullYear(), bd.getMonth(), bd.getDate()).getTime() === _todayStart.getTime();
                    });
                    const _todayShares = _todayBuys.reduce((sum, t) => sum + t.shares, 0);
                    const _priorShares = shares - _todayShares;
                    let dayPL;
                    if (_todayShares > 0 && _priorShares > 0) {
                        const _todayCost = _todayBuys.reduce((sum, t) => sum + (t.cost || t.price * t.shares), 0);
                        const _todayAvg = _todayCost / _todayShares;
                        dayPL = (stockPrice.change * _priorShares) + ((stockPrice.price - _todayAvg) * _todayShares);
                    } else if (_todayShares > 0) {
                        dayPL = (stockPrice.price - avgPurchasePrice) * shares;
                    } else {
                        dayPL = stockPrice.change * shares;
                    }
                    const dailyClass = daysHeld === 0 ? (gainLossPercent >= 0 ? 'positive' : 'negative') : (dayPL >= 0 ? 'positive' : 'negative');

                    holdingDataArray.push({
                        symbol, shares, stockPrice, currentValue, changeClass, avgPurchasePrice,
                        earliestDate, daysHeld, gainLoss, gainLossPercent, gainLossClass,
                        positionSizePercent, stockName, stockSector, dailyClass, dayPL,
                        insertionOrder: insertionOrder++
                    });
                }
                lastHoldingDataArray = holdingDataArray;
                sortAndRenderHoldings(holdingDataArray);
            }

            const now = new Date();
            const lastEntry = portfolio.performanceHistory[portfolio.performanceHistory.length - 1];
            const timeSinceLast = lastEntry ? (now - new Date(lastEntry.timestamp)) : Infinity;
            const _closedPL = (portfolio.closedTrades || []).reduce((sum, t) => sum + (t.profitLoss || 0), 0);
            let _costBasis = 0;
            for (const [_sym, _sh] of Object.entries(portfolio.holdings)) {
                const _buys = getCurrentPositionBuys(_sym);
                if (_buys.length > 0) { const _tc = _buys.reduce((s, t) => s + (t.price * t.shares), 0); const _ts = _buys.reduce((s, t) => s + t.shares, 0); _costBasis += _ts > 0 ? (_tc / _ts) * _sh : 0; }
            }
            const _unrealizedPL = totalValue - _costBasis;
            const _totalReturnPct = _costBasis > 0 ? ((_closedPL + _unrealizedPL) / _costBasis) * 100 : 0;

            if (timeSinceLast >= 15 * 60 * 1000 || !lastEntry) {
                portfolio.performanceHistory.push({ timestamp: now.toISOString(), value: totalValue, totalReturnPct: Math.round(_totalReturnPct * 100) / 100 });
            } else {
                lastEntry.value = totalValue; lastEntry.timestamp = now.toISOString(); lastEntry.totalReturnPct = Math.round(_totalReturnPct * 100) / 100;
            }

            await updatePerformanceChart();
            updatePerformanceAnalytics();
            updateSectorAllocation(priceData);

            } catch (error) {
                console.error('Error updating UI:', error);
                addActivity('⚠️ Error updating display - some data may be stale. Try refreshing the page.', 'error');
                document.getElementById('portfolioValue').textContent = 'Error';
            }
        }

        // === UTILITY FUNCTIONS ===

        function formatMarketCap(value) {
            if (value == null || value === 0) return '--';
            if (value >= 1e12) return '$' + (value / 1e12).toFixed(1) + 'T';
            if (value >= 1e9) return '$' + (value / 1e9).toFixed(0) + 'B';
            if (value >= 1e6) return '$' + (value / 1e6).toFixed(0) + 'M';
            return '$' + value.toLocaleString();
        }

        function formatTimeAgo(isoDate) {
            if (!isoDate) return '';
            const diff = Date.now() - new Date(isoDate).getTime();
            const hours = Math.floor(diff / 3600000);
            if (hours < 1) return '<1h';
            if (hours < 24) return hours + 'h';
            return Math.floor(hours / 24) + 'd';
        }

        function escapeNewlinesInJsonStrings(str) {
            let out = '', inStr = false, esc = false;
            for (let i = 0; i < str.length; i++) {
                const ch = str[i];
                if (esc) { out += ch; esc = false; continue; }
                if (ch === '\\' && inStr) { out += ch; esc = true; continue; }
                if (ch === '"') { inStr = !inStr; out += ch; continue; }
                if (inStr) { if (ch === '\n') { out += '\\n'; continue; } if (ch === '\r') { out += '\\r'; continue; } if (ch === '\t') { out += '\\t'; continue; } }
                out += ch;
            }
            return out;
        }

        function countTradingDays(startDate, endDate) {
            const start = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
            const end = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
            let count = 0; const d = new Date(start);
            while (d < end) { d.setDate(d.getDate() + 1); const dow = d.getDay(); if (dow !== 0 && dow !== 6) count++; }
            return count;
        }

        function escapeHtml(str) {
            if (typeof str !== 'string') return String(str ?? '');
            return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
        }

        function addActivity(text, type = 'general') {
            const feed = document.getElementById('activityFeed');
            const time = new Date().toLocaleString();
            const item = document.createElement('div');
            item.className = `activity-item ${type}`;
            item.innerHTML = `<div class="activity-time">${time}</div><div class="activity-description">${escapeHtml(text)}</div>`;
            if (feed.firstChild && feed.firstChild.textContent.includes('No activity')) feed.innerHTML = '';
            feed.insertBefore(item, feed.firstChild);
        }

        // === SAVE / LOAD PORTFOLIO (SIMPLIFIED) ===

        async function savePortfolio(localOnly = false) {
            return await portfolioStorage.save(portfolio);
        }

        async function loadPortfolio() {
            const saved = await portfolioStorage.load();
            if (saved) {
                try {
                    portfolio = saved;
                    console.log(`Portfolio loaded: ${Object.keys(portfolio.holdings).length} positions, ${portfolio.transactions.length} transactions`);

                    // MIGRATION: Ensure new analytics fields exist
                    if (!portfolio.lastMarketRegime) portfolio.lastMarketRegime = null;
                    if (!portfolio.lastCandidateScores) portfolio.lastCandidateScores = null;
                    if (!portfolio.lastSectorRotation) portfolio.lastSectorRotation = null;
                    if (!portfolio.lastVIX) portfolio.lastVIX = null;
                    if (!portfolio.blockedTrades) portfolio.blockedTrades = [];
                    if (!portfolio.tradingRules) portfolio.tradingRules = null;
                    if (!portfolio.holdSnapshots) portfolio.holdSnapshots = [];
                    if (!portfolio.regimeHistory) portfolio.regimeHistory = [];

                    // MIGRATION: Reclassify exitReason on historical closedTrades
                    if (!portfolio._exitReasonV2) {
                        (portfolio.closedTrades || []).forEach(trade => {
                            if (!trade.exitReason || trade.exitReason === 'manual' || trade.exitReason === 'profit_target') {
                                const ret = trade.returnPercent || 0;
                                if (ret >= 2) trade.exitReason = 'profit_target';
                                else if (ret <= -8) trade.exitReason = 'stop_loss';
                                else { const reasonLower = (trade.exitReasoning || '').toLowerCase(); if (reasonLower.includes('stop loss') || reasonLower.includes('cutting loss')) trade.exitReason = 'stop_loss'; else if (reasonLower.includes('redeploy') || reasonLower.includes('better use of capital') || reasonLower.includes('freeing')) trade.exitReason = 'opportunity_cost'; else if (reasonLower.includes('catalyst') || reasonLower.includes('thesis') || reasonLower.includes('deteriorat')) trade.exitReason = 'catalyst_failure'; else if (ret < 0) trade.exitReason = 'catalyst_failure'; else trade.exitReason = 'profit_target'; }
                            }
                        });
                        portfolio._exitReasonV2 = true;
                    }

                    // MIGRATION: Null out composite scores from pre-v2 scoring formula
                    if (!portfolio._scoringV2) {
                        let nulled = 0;
                        (portfolio.closedTrades || []).forEach(trade => { if (trade.entryTechnicals && trade.entryTechnicals.compositeScore != null) { trade.entryTechnicals.compositeScore = null; nulled++; } });
                        portfolio._scoringV2 = true;
                        if (nulled > 0) console.log(`✅ Migration: Nulled ${nulled} old-formula composite scores on closedTrades (scoring v2)`);
                    }

                    // MIGRATION: Reconstruct totalDeposits if missing or zero
                    if (!portfolio.totalDeposits && portfolio.initialBalance) {
                        let totalBuyCost = 0, totalSellProceeds = 0;
                        (portfolio.transactions || []).forEach(t => { if (t.type === 'BUY') totalBuyCost += (t.cost || t.price * t.shares); if (t.type === 'SELL') totalSellProceeds += (t.proceeds || t.price * t.shares); });
                        let reconstructed = portfolio.cash + totalBuyCost - totalSellProceeds;
                        if (reconstructed < portfolio.initialBalance) reconstructed = portfolio.initialBalance;
                        portfolio.totalDeposits = Math.round(reconstructed * 100) / 100;
                        savePortfolio(true);
                    }

                    // MIGRATION: Fix corrupted performanceHistory values
                    if (portfolio.performanceHistory && portfolio.performanceHistory.length > 0) {
                        let fixed = 0;
                        for (let i = 0; i < portfolio.performanceHistory.length; i++) {
                            const entry = portfolio.performanceHistory[i];
                            if (typeof entry.value !== 'number' || isNaN(entry.value)) {
                                const prev = portfolio.performanceHistory.slice(0, i).reverse().find(e => typeof e.value === 'number' && !isNaN(e.value));
                                const next = portfolio.performanceHistory.slice(i + 1).find(e => typeof e.value === 'number' && !isNaN(e.value));
                                if (prev && next) entry.value = (prev.value + next.value) / 2;
                                else if (prev) entry.value = prev.value + (entry.deposit || 0);
                                else if (next) entry.value = next.value;
                                else entry.value = portfolio.cash;
                                fixed++;
                            }
                        }
                        if (fixed > 0) { console.log(`📊 MIGRATION: Fixed ${fixed} corrupted performanceHistory entries`); savePortfolio(true); }
                    }

                    // MIGRATION: Reconstruct performanceHistory from transaction dates
                    // (cost basis approximation — we don't have historical market prices)
                    if (!portfolio._perfHistoryReconstructed) {
                        const txs = (portfolio.transactions || []).slice().sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
                        if (txs.length > 0) {
                            const reconstructed = [];
                            const runningLots = {}; // symbol → [{shares, price}]
                            let realizedPL = 0;

                            // Group transactions by date
                            const dateGroups = {};
                            for (const tx of txs) {
                                const date = new Date(tx.timestamp).toISOString().split('T')[0];
                                if (!dateGroups[date]) dateGroups[date] = [];
                                dateGroups[date].push(tx);
                            }

                            for (const date of Object.keys(dateGroups).sort()) {
                                for (const tx of dateGroups[date]) {
                                    if (tx.type === 'BUY') {
                                        if (!runningLots[tx.symbol]) runningLots[tx.symbol] = [];
                                        runningLots[tx.symbol].push({ shares: tx.shares, price: tx.price });
                                    } else if (tx.type === 'SELL') {
                                        const lots = runningLots[tx.symbol] || [];
                                        const totalCost = lots.reduce((s, l) => s + l.shares * l.price, 0);
                                        const totalShares = lots.reduce((s, l) => s + l.shares, 0);
                                        const avgPrice = totalShares > 0 ? totalCost / totalShares : 0;
                                        realizedPL += (tx.price - avgPrice) * tx.shares;
                                        let toSell = tx.shares;
                                        while (toSell > 0 && lots.length > 0) {
                                            if (lots[0].shares <= toSell) { toSell -= lots[0].shares; lots.shift(); }
                                            else { lots[0].shares -= toSell; toSell = 0; }
                                        }
                                        if (lots.length === 0) delete runningLots[tx.symbol];
                                    }
                                }
                                let costBasis = 0;
                                for (const lots of Object.values(runningLots)) {
                                    for (const lot of lots) costBasis += lot.shares * lot.price;
                                }
                                const totalReturnPct = costBasis > 0 ? Math.round((realizedPL / costBasis) * 100 * 100) / 100 : 0;
                                reconstructed.push({ timestamp: date + 'T16:00:00.000Z', value: costBasis, totalReturnPct });
                            }
                            portfolio.performanceHistory = reconstructed;
                            console.log(`✅ Migration: Reconstructed ${reconstructed.length} performanceHistory entries from ${txs.length} transactions`);
                            savePortfolio(true);
                        }
                        portfolio._perfHistoryReconstructed = true;
                    }

                    // MIGRATION: Backfill closedTrades from orphaned SELL transactions
                    if (!portfolio._backfillClosedV1) {
                        portfolio.closedTrades = portfolio.closedTrades || [];
                        const existingClosed = new Set(portfolio.closedTrades.map(ct => `${ct.symbol}|${ct.sellDate}`));
                        const txs = portfolio.transactions || [];
                        let backfilled = 0;
                        for (let i = 0; i < txs.length; i++) {
                            const sell = txs[i]; if (sell.type !== 'SELL') continue;
                            const sellDate = sell.timestamp; const key = `${sell.symbol}|${sellDate}`; if (existingClosed.has(key)) continue;
                            let sharesNeeded = sell.shares; let runningShares = 0; let windowStart = 0;
                            for (let j = 0; j < i; j++) { const t = txs[j]; if (t.symbol !== sell.symbol) continue; if (t.type === 'BUY') runningShares += t.shares; if (t.type === 'SELL') { runningShares -= t.shares; if (runningShares <= 0) { windowStart = j + 1; runningShares = 0; } } }
                            const matchedBuys = [];
                            for (let j = windowStart; j < i; j++) { const t = txs[j]; if (t.symbol === sell.symbol && t.type === 'BUY') matchedBuys.push(t); }
                            if (matchedBuys.length === 0) continue;
                            const totalBuyCost = matchedBuys.reduce((s, t) => s + (t.cost || t.price * t.shares), 0);
                            const totalBuyShares = matchedBuys.reduce((s, t) => s + t.shares, 0);
                            const avgBuyPrice = totalBuyShares > 0 ? totalBuyCost / totalBuyShares : 0;
                            const profitLoss = avgBuyPrice > 0 ? (sell.price - avgBuyPrice) * sell.shares : 0;
                            const returnPercent = avgBuyPrice > 0 ? ((sell.price - avgBuyPrice) / avgBuyPrice) * 100 : 0;
                            let exitReason = 'manual';
                            if (returnPercent >= 2) exitReason = 'profit_target'; else if (returnPercent <= -8) exitReason = 'stop_loss'; else if (returnPercent < 0) exitReason = 'catalyst_failure';
                            portfolio.closedTrades.push({ symbol: sell.symbol, sector: stockSectors[sell.symbol] || 'Unknown', buyPrice: avgBuyPrice, sellPrice: sell.price, shares: sell.shares, profitLoss, returnPercent, buyDate: matchedBuys[0].timestamp, sellDate, holdTime: new Date(sellDate).getTime() - new Date(matchedBuys[0].timestamp).getTime(), entryConviction: matchedBuys[0].conviction || null, entryTechnicals: matchedBuys[0].entryTechnicals || {}, entryMarketRegime: matchedBuys[0].entryMarketRegime || null, entryHoldingsCount: matchedBuys[0].entryHoldingsCount || null, exitReason, exitReasoning: sell.reasoning || 'Manual sell', exitConviction: null, exitMarketRegime: null, exitHoldingsCount: null, exitTechnicals: {}, positionSizePercent: matchedBuys[0].positionSizePercent || null, tracking: { priceAfter3d: null, priceAfter5d: null, tracked: false }, manual: true, backfilled: true });
                            existingClosed.add(key); backfilled++;
                        }
                        portfolio.closedTrades.sort((a, b) => new Date(a.sellDate) - new Date(b.sellDate));
                        portfolio._backfillClosedV1 = true;
                        if (backfilled > 0) { console.log(`✅ Migration: Backfilled ${backfilled} missing closedTrades from transaction history`); savePortfolio(true); }
                    }

                    await updateUI();
                    addActivity(`Portfolio loaded from localStorage - ${Object.keys(portfolio.holdings).length} positions`, 'init');
                } catch (error) { console.error('Error parsing localStorage portfolio:', error); addActivity('⚠️ Error loading saved portfolio', 'error'); }
            } else { console.log('No portfolio found in localStorage'); }
        }

        // === REFRESH PRICES (SIMPLIFIED) ===

        async function refreshPrices() {
            console.log('🔄 Manual price refresh requested');
            addActivity('🔄 Refreshing all prices...', 'general');
            Object.keys(priceCache).forEach(key => delete priceCache[key]);
            bulkSnapshotTimestamp = 0;
            await updateUI();
            addActivity('✅ Prices refreshed!', 'success');
        }

        // === MANUAL TRADE ===

        let manualTradeMode = 'buy';

        function openManualTradeModal() {
            const modal = document.getElementById('manualTradeModal');
            modal.classList.add('active');
            document.getElementById('manualTradeDate').value = new Date().toISOString().split('T')[0];
            document.getElementById('manualTradeSymbol').value = '';
            document.getElementById('manualTradeShares').value = '';
            document.getElementById('manualTradePrice').value = '';
            document.getElementById('manualTradeReason').value = '';
            document.getElementById('manualTradeSetup').value = '';
            document.getElementById('manualTradeStatus').textContent = '';
            document.getElementById('manualTradeStatus').style.color = 'var(--text-muted)';
            switchManualTradeTab('buy');
            document.getElementById('manualTradeSymbol').focus();
        }

        function closeManualTradeModal() {
            document.getElementById('manualTradeModal').classList.remove('active');
        }

        function switchManualTradeTab(mode) {
            manualTradeMode = mode;
            document.getElementById('manualBuyTab').classList.toggle('active', mode === 'buy');
            document.getElementById('manualSellTab').classList.toggle('active', mode === 'sell');
            document.getElementById('manualTradeTitle').textContent = mode === 'buy' ? 'Manual Buy' : 'Manual Sell';
            document.getElementById('manualTradeSubmit').textContent = mode === 'buy' ? 'Submit Buy' : 'Submit Sell';
            document.getElementById('manualTradeSubmit').style.background = mode === 'buy' ? '' : 'var(--red)';

            const setupWrap = document.getElementById('manualTradeSetupWrap');
            if (setupWrap) setupWrap.style.display = mode === 'buy' ? '' : 'none';

            if (mode === 'sell') {
                const holdingSymbols = Object.keys(portfolio.holdings);
                if (holdingSymbols.length === 0) document.getElementById('manualTradeStatus').textContent = 'No holdings to sell.';
            } else { document.getElementById('manualTradeStatus').textContent = ''; }
        }

        async function fetchHistoricalBars(symbol, entryDate) {
            const to = new Date(entryDate);
            const from = new Date(to);
            from.setDate(from.getDate() - 100);
            const fromStr = from.toISOString().split('T')[0];
            const toStr = to.toISOString().split('T')[0];
            try {
                const response = await fetch(`https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/day/${fromStr}/${toStr}?adjusted=true&sort=asc&apiKey=${POLYGON_API_KEY}`);
                const data = await response.json();
                if ((data.status === 'OK' || data.status === 'DELAYED') && data.results && data.results.length >= 5) return data.results;
                return null;
            } catch (e) { console.warn(`Failed to fetch historical bars for ${symbol}:`, e.message); return null; }
        }

        function reconstructSignals(symbol, bars, entryDate) {
            if (!bars || bars.length < 5) return null;
            const entryTs = new Date(entryDate + 'T23:59:59').getTime();
            const trimmed = bars.filter(b => b.t <= entryTs);
            if (trimmed.length < 5) return null;
            const rsi = calculateRSI(trimmed);
            const macd = calculateMACD(trimmed);
            const sma20 = calculateSMA(trimmed, 20);
            const smaCrossover = calculateSMACrossover(trimmed);
            const originalCache = multiDayCache[symbol];
            multiDayCache[symbol] = trimmed;
            const momentum = calculate5DayMomentum(null, symbol);
            multiDayCache[symbol] = originalCache;
            return {
                momentumScore: momentum.score, totalReturn5d: momentum.totalReturn5d ?? 0,
                upDays: momentum.upDays ?? 0, totalDays: momentum.totalDays ?? 0,
                isAccelerating: momentum.isAccelerating ?? false, volumeTrend: momentum.volumeTrend ?? 1,
                rsi, macd, sma20, smaCrossover,
                entryPrice: trimmed[trimmed.length - 1].c, bars: trimmed
            };
        }

        async function submitManualTrade() {
            const symbol = document.getElementById('manualTradeSymbol').value.trim().toUpperCase();
            const shares = parseInt(document.getElementById('manualTradeShares').value);
            const price = parseFloat(document.getElementById('manualTradePrice').value);
            const dateStr = document.getElementById('manualTradeDate').value;
            const reason = document.getElementById('manualTradeReason').value.trim();
            const statusEl = document.getElementById('manualTradeStatus');

            if (!symbol) { statusEl.textContent = 'Symbol is required.'; return; }
            if (!shares || shares <= 0) { statusEl.textContent = 'Shares must be > 0.'; return; }
            if (!price || price <= 0) { statusEl.textContent = 'Price must be > 0.'; return; }
            if (!dateStr) { statusEl.textContent = 'Date is required.'; return; }

            const cost = price * shares;
            const now = new Date();
            const todayStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
            const timestamp = dateStr === todayStr ? now.toISOString() : new Date(dateStr + 'T12:00:00').toISOString();

            if (manualTradeMode === 'buy') {
                statusEl.textContent = 'Fetching historical signals...';
                document.getElementById('manualTradeSubmit').disabled = true;

                let signals = null;
                try {
                    const bars = await fetchHistoricalBars(symbol, dateStr);
                    if (bars) {
                        signals = reconstructSignals(symbol, bars, dateStr);
                        if (signals) statusEl.textContent = `Signals captured: MOM ${signals.momentumScore}, RSI ${signals.rsi != null ? Math.round(signals.rsi) : '--'}, MACD ${signals.macd?.crossover || 'none'}`;
                        else statusEl.textContent = 'Insufficient bar data for signal reconstruction. Proceeding without signals.';
                    } else { statusEl.textContent = 'Could not fetch historical data. Proceeding without signals.'; }
                } catch (e) { console.warn('Signal reconstruction failed:', e.message); statusEl.textContent = 'Signal fetch failed. Proceeding without signals.'; }

                try {
                    const entryTechnicals = signals ? {
                        momentumScore: signals.momentumScore, rsi: signals.rsi ?? null,
                        macdCrossover: signals.macd?.crossover || null, sma20: signals.sma20 ?? null,
                        scoringVersion: 2
                    } : {};

                    portfolio.holdings[symbol] = (portfolio.holdings[symbol] || 0) + shares;
                    portfolio.transactions.push({
                        type: 'BUY', symbol, shares, price, timestamp, cost,
                        conviction: null, reasoning: reason || 'Manual entry', entryTechnicals,
                        entryMarketRegime: portfolio.lastMarketRegime?.regime || null,
                        entryHoldingsCount: Object.keys(portfolio.holdings).length,
                        positionSizePercent: portfolio.performanceHistory?.length > 0 ? (cost / portfolio.performanceHistory[portfolio.performanceHistory.length - 1].value * 100) : null,
                        portfolioValueAtEntry: portfolio.performanceHistory?.length > 0 ? portfolio.performanceHistory[portfolio.performanceHistory.length - 1].value : null,
                        manual: true
                    });

                    if (!portfolio.holdingTheses) portfolio.holdingTheses = {};
                    const newThesis = { originalCatalyst: reason || 'Manual entry', entryPrice: price, entryDate: timestamp, stopPrice: Math.round(price * 0.9 * 100) / 100, targetPrice: Math.round(price * 1.1 * 100) / 100 };
                    if (!portfolio.holdingTheses[symbol]) portfolio.holdingTheses[symbol] = newThesis;
                    else { const existing = portfolio.holdingTheses[symbol]; for (const [k, v] of Object.entries(newThesis)) { if (existing[k] == null && v != null) existing[k] = v; } }

                    statusEl.textContent = 'Saving...';
                    const saveResult = await savePortfolio();
                    if (saveResult && !saveResult.serverOk && !saveResult.localOk) { statusEl.textContent = `BUY recorded in memory but save FAILED — do not refresh! Try again.`; statusEl.style.color = 'var(--red, red)'; }
                    else if (saveResult && !saveResult.serverOk) { statusEl.textContent = `BUY ${shares} ${symbol} @ $${price.toFixed(2)} saved locally — server failed: ${saveResult.serverError}`; statusEl.style.color = 'var(--orange, orange)'; setTimeout(closeManualTradeModal, 3000); }
                    else { statusEl.textContent = `BUY ${shares} ${symbol} @ $${price.toFixed(2)} recorded!`; statusEl.style.color = 'var(--green)'; setTimeout(closeManualTradeModal, 2000); }
                    addActivity(`Manual BUY: ${shares} shares of ${symbol} at $${price.toFixed(2)} on ${dateStr}`, 'buy');
                    showUndoButton(`BUY ${shares} ${symbol} @ $${price.toFixed(2)}`);
                    updateUI().then(() => updatePerformanceAnalytics());
                } catch (buyErr) {
                    console.error('Manual buy execution error:', buyErr);
                    statusEl.textContent = `Buy error: ${buyErr.message}. Saving...`; statusEl.style.color = 'var(--orange, orange)';
                    await savePortfolio(); setTimeout(closeManualTradeModal, 3000);
                }

            } else if (manualTradeMode === 'sell') {
                const currentShares = portfolio.holdings[symbol] || 0;
                if (currentShares <= 0) { statusEl.textContent = `You don't hold any ${symbol}.`; return; }
                if (shares > currentShares) { statusEl.textContent = `You only hold ${currentShares} shares of ${symbol}.`; return; }

                try {
                    const revenue = price * shares;
                    const buyTransactions = getCurrentPositionBuys(symbol);
                    portfolio.holdings[symbol] -= shares;
                    portfolio.transactions.push({ type: 'SELL', symbol, shares, price, timestamp, revenue, reasoning: reason || 'Manual sell', manual: true });

                    if (buyTransactions.length > 0) {
                        const totalBuyCost = buyTransactions.reduce((sum, t) => sum + (t.cost || t.price * t.shares), 0);
                        const totalBuyShares = buyTransactions.reduce((sum, t) => sum + t.shares, 0);
                        const avgBuyPrice = totalBuyShares > 0 ? totalBuyCost / totalBuyShares : 0;
                        const profitLoss = avgBuyPrice > 0 ? (price - avgBuyPrice) * shares : 0;
                        const returnPercent = avgBuyPrice > 0 ? ((price - avgBuyPrice) / avgBuyPrice) * 100 : 0;
                        const originalBuyTx = buyTransactions[0];
                        let exitReason = 'manual';
                        if (returnPercent >= 2) exitReason = 'profit_target'; else if (returnPercent <= -8) exitReason = 'stop_loss';
                        else if (reason) { const rl = reason.toLowerCase(); if (rl.includes('stop') || rl.includes('loss')) exitReason = 'stop_loss'; else if (rl.includes('catalyst') || rl.includes('thesis') || rl.includes('broke')) exitReason = 'catalyst_failure'; else if (returnPercent < 0) exitReason = 'catalyst_failure'; else exitReason = 'profit_target'; }
                        portfolio.closedTrades = portfolio.closedTrades || [];
                        portfolio.closedTrades.push({
                            symbol, sector: stockSectors[symbol] || 'Unknown', buyPrice: avgBuyPrice, sellPrice: price, shares, profitLoss, returnPercent,
                            buyDate: buyTransactions[0].timestamp, sellDate: timestamp,
                            holdTime: (() => { const sellMs = new Date(timestamp).getTime(); let weightedSum = 0, totalShrs = 0; for (const bt of buyTransactions) { const held = sellMs - new Date(bt.timestamp).getTime(); weightedSum += held * bt.shares; totalShrs += bt.shares; } return totalShrs > 0 ? weightedSum / totalShrs : sellMs - new Date(buyTransactions[0].timestamp).getTime(); })(),
                            entryConviction: originalBuyTx.conviction || null, entryTechnicals: originalBuyTx.entryTechnicals || {},
                            entryMarketRegime: originalBuyTx.entryMarketRegime || null, entryHoldingsCount: originalBuyTx.entryHoldingsCount || null,
                            exitReason, exitReasoning: reason || 'Manual sell', exitConviction: null,
                            exitMarketRegime: portfolio.lastMarketRegime?.regime || null, exitHoldingsCount: Object.keys(portfolio.holdings).length,
                            exitTechnicals: {}, positionSizePercent: originalBuyTx.positionSizePercent || null,
                            tracking: { priceAfter3d: null, priceAfter5d: null, tracked: false }, manual: true
                        });
                    }

                    if (portfolio.holdings[symbol] <= 0) { delete portfolio.holdings[symbol]; if (portfolio.holdingTheses?.[symbol]) delete portfolio.holdingTheses[symbol]; }
                    else if (portfolio.holdingTheses?.[symbol]) { portfolio.holdingTheses[symbol].lastTrimDate = timestamp; portfolio.holdingTheses[symbol].lastTrimPrice = price; }

                    const plStr = buyTransactions.length > 0 ? (() => { const avg = buyTransactions.reduce((s, t) => s + (t.cost || t.price * t.shares), 0) / buyTransactions.reduce((s, t) => s + t.shares, 0); const ret = ((price - avg) / avg * 100); return ` (${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%)`; })() : '';
                    statusEl.textContent = 'Saving...';
                    const saveResult = await savePortfolio();
                    if (saveResult && !saveResult.serverOk && !saveResult.localOk) { statusEl.textContent = `SELL recorded in memory but save FAILED — do not refresh! Try again.`; statusEl.style.color = 'var(--red, red)'; }
                    else if (saveResult && !saveResult.serverOk) { statusEl.textContent = `SELL ${shares} ${symbol} @ $${price.toFixed(2)}${plStr} saved locally — server failed`; statusEl.style.color = 'var(--orange, orange)'; setTimeout(closeManualTradeModal, 3000); }
                    else { statusEl.textContent = `SELL ${shares} ${symbol} @ $${price.toFixed(2)}${plStr} recorded!`; statusEl.style.color = 'var(--green)'; setTimeout(closeManualTradeModal, 2000); }
                    addActivity(`Manual SELL: ${shares} shares of ${symbol} at $${price.toFixed(2)} on ${dateStr}${plStr}`, 'sell');
                    showUndoButton(`SELL ${shares} ${symbol} @ $${price.toFixed(2)}`);
                    updateUI().then(() => updatePerformanceAnalytics());
                } catch (sellErr) {
                    console.error('Manual sell execution error:', sellErr);
                    statusEl.textContent = `Sell error: ${sellErr.message}. Saving...`; statusEl.style.color = 'var(--orange, orange)';
                    await savePortfolio(); setTimeout(closeManualTradeModal, 3000);
                }
            }
            document.getElementById('manualTradeSubmit').disabled = false;
        }

        // === UNDO TRADE ===

        let undoData = null;

        function showUndoButton(label) {
            undoData = { timestamp: Date.now() };
            const container = document.getElementById('undoTradeContainer');
            document.getElementById('undoTradeLabel').textContent = label;
            container.style.display = 'flex';
        }

        function hideUndoButton() {
            undoData = null;
            document.getElementById('undoTradeContainer').style.display = 'none';
        }

        async function undoLastTrade() {
            if (!undoData) return;
            const txs = portfolio.transactions || [];
            if (txs.length === 0) { hideUndoButton(); return; }
            const lastTx = txs[txs.length - 1];
            const symbol = lastTx.symbol;
            const desc = `${lastTx.type} ${lastTx.shares} ${symbol} @ $${lastTx.price.toFixed(2)}`;
            if (!confirm(`Undo ${desc}?`)) return;
            if (lastTx.type === 'BUY') {
                portfolio.holdings[symbol] = (portfolio.holdings[symbol] || 0) - lastTx.shares;
                if (portfolio.holdings[symbol] <= 0) delete portfolio.holdings[symbol];
                if (!portfolio.holdings[symbol] && portfolio.holdingTheses?.[symbol]) delete portfolio.holdingTheses[symbol];
            } else if (lastTx.type === 'SELL') {
                portfolio.holdings[symbol] = (portfolio.holdings[symbol] || 0) + lastTx.shares;
                const closedTrades = portfolio.closedTrades || [];
                for (let i = closedTrades.length - 1; i >= 0; i--) { if (closedTrades[i].symbol === symbol && closedTrades[i].sellDate === lastTx.timestamp) { closedTrades.splice(i, 1); break; } }
                if (!portfolio.holdingTheses?.[symbol]) {
                    const buys = txs.slice(0, -1).filter(t => t.type === 'BUY' && t.symbol === symbol);
                    if (buys.length > 0) { const origBuy = buys[buys.length - 1]; portfolio.holdingTheses = portfolio.holdingTheses || {}; portfolio.holdingTheses[symbol] = { originalCatalyst: origBuy.reasoning || 'Restored after undo', entryConviction: origBuy.conviction || null, entryPrice: origBuy.price, entryDate: origBuy.timestamp, peakPrice: origBuy.price, peakDate: origBuy.timestamp }; }
                }
            }
            txs.pop();
            savePortfolio(); await updateUI(); updatePerformanceAnalytics();
            addActivity(`↩ Undo: ${desc}`, 'init'); hideUndoButton();
        }

        // === RESET ACCOUNT ===

        function resetAccount() {
            if (confirm('Are you sure you want to reset your account? This will delete all positions and history.')) {
                portfolio = { cash: 0, initialBalance: 0, totalDeposits: 0, holdings: {}, transactions: [], performanceHistory: [], closedTrades: [], holdingTheses: {}, tradingStrategy: 'aggressive', journalEntries: [], lastMarketRegime: null, lastCandidateScores: null, lastSectorRotation: null, lastVIX: null, holdSnapshots: [], regimeHistory: [], blockedTrades: [] };
                localStorage.removeItem('aiTradingPortfolio');
                localStorage.removeItem('apexDecisionHistory');
                document.getElementById('activityFeed').innerHTML = '<div class="empty-state">No activity yet</div>';
                updateUI();
                if (performanceChart) { performanceChart.data.labels = []; performanceChart.data.datasets.forEach(ds => { ds.data = []; }); performanceChart.update(); }
            }
        }

        // === SECTOR ALLOCATION ===

        async function updateSectorAllocation(priceData = null) {
            if (!sectorChart) return;
            const sectorValues = {}; let totalHoldingsValue = 0;
            if (Object.keys(portfolio.holdings).length > 0) {
                for (const [symbol, shares] of Object.entries(portfolio.holdings)) {
                    let stockPrice;
                    if (priceData && priceData[symbol]) stockPrice = priceData[symbol];
                    else { try { stockPrice = await getStockPrice(symbol); } catch (error) { stockPrice = { price: 0, change: 0, changePercent: 0 }; } }
                    const value = stockPrice.price * shares;
                    const sector = stockSectors[symbol] || 'Other';
                    sectorValues[sector] = (sectorValues[sector] || 0) + value;
                    totalHoldingsValue += value;
                }
            }
            const sectorPercentages = {};
            if (totalHoldingsValue > 0) { for (const [sector, value] of Object.entries(sectorValues)) sectorPercentages[sector] = (value / totalHoldingsValue) * 100; }
            const sectors = Object.keys(sectorPercentages); const percentages = Object.values(sectorPercentages);
            sectorChart.data.labels = sectors; sectorChart.data.datasets[0].data = percentages; sectorChart.update();
            const legendHtml = sectors.map((sector, index) => {
                const percentage = sectorPercentages[sector]; const value = sectorValues[sector];
                const color = sectorChart.data.datasets[0].backgroundColor[index % sectorChart.data.datasets[0].backgroundColor.length];
                return `<div class="sector-legend-item"><div class="sector-legend-swatch" style="background: ${color};"></div><div class="sector-legend-text">${sector}: <strong>${percentage.toFixed(1)}%</strong> ($${value.toFixed(2)})</div></div>`;
            }).join('');
            document.getElementById('sectorLegend').innerHTML = legendHtml;
        }

        // === PERFORMANCE ANALYTICS (SIMPLIFIED) ===

        function updatePerformanceAnalytics() {
            const closedTrades = portfolio.closedTrades || [];
            const realizedPL = closedTrades.reduce((sum, t) => sum + (t.profitLoss || 0), 0);
            const performanceHistory = portfolio.performanceHistory || [];
            const holdingsValue = performanceHistory.length > 0 ? performanceHistory[performanceHistory.length - 1].value : 0;
            let costBasis = 0;
            for (const [symbol, shares] of Object.entries(portfolio.holdings)) {
                const buys = getCurrentPositionBuys(symbol);
                if (buys.length > 0) { const totalCost = buys.reduce((sum, t) => sum + (t.price * t.shares), 0); const totalShares = buys.reduce((sum, t) => sum + t.shares, 0); costBasis += totalShares > 0 ? (totalCost / totalShares) * shares : 0; }
            }
            const unrealizedPL = holdingsValue - costBasis;
            const returnDollar = realizedPL + unrealizedPL;
            const totalReturn = costBasis > 0 ? (returnDollar / costBasis) * 100 : 0;

            document.getElementById('totalReturn').textContent = totalReturn.toFixed(2) + '%';
            document.getElementById('totalReturn').className = 'index-price';
            document.getElementById('totalReturn').style.color = totalReturn >= 0 ? '#34d399' : '#f87171';
            document.getElementById('totalReturnDollar').textContent = (returnDollar >= 0 ? '+' : '') + '$' + returnDollar.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
            document.getElementById('totalReturnDollar').className = 'index-change ' + (returnDollar >= 0 ? 'positive' : 'negative');

            const wins = closedTrades.filter(t => t.profitLoss > 0).length;
            const losses = closedTrades.filter(t => t.profitLoss < 0).length;
            const totalClosed = wins + losses;
            const winRate = totalClosed > 0 ? (wins / totalClosed) * 100 : 0;
            document.getElementById('winRate').textContent = winRate.toFixed(0) + '%';
            document.getElementById('winRate').style.color = winRate >= 50 ? '#34d399' : '#f87171';
            document.getElementById('winLossRatio').textContent = `${wins}W / ${losses}L`;

            if (closedTrades.length > 0) {
                const bestTrade = closedTrades.reduce((best, trade) => trade.profitLoss > best.profitLoss ? trade : best);
                if (bestTrade.profitLoss > 0) { document.getElementById('bestTrade').textContent = bestTrade.symbol; document.getElementById('bestTradeGain').textContent = '+' + bestTrade.returnPercent.toFixed(2) + '% (+$' + bestTrade.profitLoss.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ')'; }
                else { document.getElementById('bestTrade').textContent = 'N/A'; document.getElementById('bestTradeGain').textContent = '--'; }
                const worstTrade = closedTrades.reduce((worst, trade) => trade.profitLoss < worst.profitLoss ? trade : worst);
                if (worstTrade.profitLoss < 0) { document.getElementById('worstTrade').textContent = worstTrade.symbol; document.getElementById('worstTradeLoss').textContent = worstTrade.returnPercent.toFixed(2) + '% ($' + worstTrade.profitLoss.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ')'; }
                else { document.getElementById('worstTrade').textContent = 'N/A'; document.getElementById('worstTradeLoss').textContent = '--'; }
            } else { document.getElementById('bestTrade').textContent = 'N/A'; document.getElementById('bestTradeGain').textContent = '--'; document.getElementById('worstTrade').textContent = 'N/A'; document.getElementById('worstTradeLoss').textContent = '--'; }

            if (closedTrades.length > 0) {
                const avgHoldMs = closedTrades.reduce((sum, trade) => sum + trade.holdTime, 0) / closedTrades.length;
                const avgHoldDays = avgHoldMs / (1000 * 60 * 60 * 24);
                document.getElementById('avgHoldTime').textContent = avgHoldDays < 1 ? (avgHoldDays * 24).toFixed(1) + ' hours' : avgHoldDays.toFixed(1) + ' days';
            }

            const transactions = portfolio.transactions || [];
            document.getElementById('totalTrades').textContent = transactions.length;

            const health = portfolio.portfolioHealth;
            if (health && health.alpha != null) {
                document.getElementById('alphaValue').textContent = (health.alpha >= 0 ? '+' : '') + health.alpha.toFixed(2) + '%';
                document.getElementById('alphaValue').style.color = health.alpha >= 0 ? '#34d399' : '#f87171';
                document.getElementById('spyReturn').textContent = 'SPY: ' + (health.spyReturn >= 0 ? '+' : '') + health.spyReturn.toFixed(2) + '%';
                document.getElementById('spyReturn').className = 'index-change';
            } else { document.getElementById('alphaValue').textContent = '--'; document.getElementById('spyReturn').textContent = ''; }

            updateTradeHistory();

            ['winRate', 'bestTrade', 'worstTrade'].forEach(t => {
                const p = document.getElementById(t + 'Expansion');
                if (p) p.classList.remove('open');
                const c = p ? p.closest('.expandable-card') : null;
                if (c) c.classList.remove('expanded');
            });
        }

        // === TRADE HISTORY ===

        function updateTradeHistory() {
            const container = document.getElementById('tradeHistory');
            const closedTrades = portfolio.closedTrades || [];
            if (closedTrades.length === 0) { container.innerHTML = '<div class="empty-state">No closed trades yet</div>'; return; }
            const sorted = [...closedTrades].reverse();
            let html = `<table class="signal-accuracy-table"><thead><tr><th>Symbol</th><th>Buy</th><th>Sell</th><th>Shares</th><th>P&L</th><th>Return</th><th>Hold</th></tr></thead><tbody>`;
            for (const t of sorted) {
                const plColor = t.profitLoss >= 0 ? 'var(--green)' : 'var(--red)';
                const plSign = t.profitLoss >= 0 ? '+' : '';
                const buyDate = t.buyDate ? new Date(t.buyDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '--';
                const sellDate = t.sellDate ? new Date(t.sellDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '--';
                const holdDays = (t.buyDate && t.sellDate) ? countTradingDays(new Date(t.buyDate), new Date(t.sellDate)) : '--';
                const holdStr = holdDays === '--' ? '--' : holdDays <= 1 ? '<1d' : holdDays + 'd';
                html += `<tr><td style="font-weight:600;">${escapeHtml(t.symbol)}</td><td>${buyDate}</td><td>${sellDate}</td><td>${t.shares}</td><td style="color:${plColor};font-weight:600;">${plSign}$${t.profitLoss.toFixed(2)}</td><td style="color:${plColor};">${plSign}${t.returnPercent.toFixed(1)}%</td><td>${holdStr}</td></tr>`;
            }
            html += '</tbody></table>';
            container.innerHTML = html;
        }

        // === WINDOW.ONLOAD (SIMPLIFIED) ===

        window.onload = async function() {
            initChart();
            await loadPortfolio();
            if (portfolioStorage._serverAvailable) {
                try {
                    const configRes = await fetch('/api/config');
                    if (configRes.ok) {
                        const config = await configRes.json();
                        if (config.polygonApiKey) { POLYGON_API_KEY = config.polygonApiKey; localStorage.setItem('polygon_api_key', config.polygonApiKey); }
                        console.log('API keys loaded from server');
                    }
                } catch (e) { /* server config unavailable */ }
            }
            loadApiUsage();
            updatePerformanceAnalytics();
            updateSectorAllocation();
            updateApiKeyStatus();
        };

        // === UI TOGGLE FUNCTIONS ===

        let privacyMode = localStorage.getItem('privacyMode') === 'true';
        function togglePrivacyMode() { privacyMode = !privacyMode; localStorage.setItem('privacyMode', privacyMode); applyPrivacyMode(); }
        function applyPrivacyMode() {
            const mask = '•••••';
            const ids = ['portfolioValue', 'investedValue', 'unrealizedPL', 'realizedPL'];
            const toggle = document.getElementById('privacyToggle');
            if (privacyMode) {
                ids.forEach(id => { const el = document.getElementById(id); if (el) { if (!el.dataset.realValue) el.dataset.realValue = el.textContent; el.textContent = mask; } });
                const heroChange = document.getElementById('heroChange');
                if (heroChange) { if (!heroChange.dataset.realValue) heroChange.dataset.realValue = heroChange.innerHTML; heroChange.innerHTML = ''; }
                if (toggle) toggle.style.opacity = '1';
            } else {
                ids.forEach(id => { const el = document.getElementById(id); if (el && el.dataset.realValue) { el.textContent = el.dataset.realValue; delete el.dataset.realValue; } });
                const heroChange = document.getElementById('heroChange');
                if (heroChange && heroChange.dataset.realValue) { heroChange.innerHTML = heroChange.dataset.realValue; delete heroChange.dataset.realValue; }
                if (toggle) toggle.style.opacity = '0.5';
            }
        }
        if (privacyMode) setTimeout(applyPrivacyMode, 500);

        function toggleSection(sectionId) {
            const body = document.getElementById(sectionId + 'Body');
            const icon = document.getElementById(sectionId + 'Toggle');
            if (!body) return;
            body.classList.toggle('collapsed');
            if (icon) icon.classList.toggle('collapsed');
            const header = body.previousElementSibling;
            if (header && header.hasAttribute('aria-expanded')) header.setAttribute('aria-expanded', !body.classList.contains('collapsed'));
        }

        let _popoverAbort = null;

        function toggleAnalyticsExpansion(cardType, cardEl) {
            const popover = document.getElementById('analyticsPopover');
            const allCards = document.querySelectorAll('.expandable-card');
            const wasOpen = popover.classList.contains('open') && popover.dataset.cardType === cardType;
            if (_popoverAbort) { _popoverAbort.abort(); _popoverAbort = null; }
            popover.classList.remove('open'); allCards.forEach(c => c.classList.remove('expanded'));
            if (wasOpen) return;
            populateAnalyticsExpansion(cardType);
            const section = cardEl.closest('.analytics-section');
            const sectionRect = section.getBoundingClientRect();
            const cardRect = cardEl.getBoundingClientRect();
            const top = cardRect.bottom - sectionRect.top + 6;
            let left = cardRect.left - sectionRect.left;
            const popoverWidth = 400;
            if (left + popoverWidth > section.offsetWidth) left = section.offsetWidth - popoverWidth;
            if (left < 0) left = 0;
            popover.style.top = top + 'px'; popover.style.left = left + 'px';
            popover.dataset.cardType = cardType; popover.classList.add('open'); cardEl.classList.add('expanded');
            _popoverAbort = new AbortController();
            setTimeout(() => { document.addEventListener('click', (e) => { if (!popover.contains(e.target) && !e.target.closest('.expandable-card')) { popover.classList.remove('open'); allCards.forEach(c => c.classList.remove('expanded')); if (_popoverAbort) { _popoverAbort.abort(); _popoverAbort = null; } } }, { signal: _popoverAbort.signal }); }, 0);
        }

        function populateAnalyticsExpansion(cardType) {
            const container = document.getElementById('analyticsPopoverContent');
            if (!container) return;
            const closedTrades = portfolio.closedTrades || [];
            let html = '';
            if (cardType === 'winRate') {
                if (closedTrades.length === 0) { container.innerHTML = '<div style="font-size:12px;color:var(--text-faint);padding:8px 0;">No closed trades yet</div>'; return; }
                const recent = closedTrades.slice(-10).reverse();
                recent.forEach(t => { const isWin = t.profitLoss > 0; const badge = isWin ? '<span class="trade-history-badge win">W</span>' : '<span class="trade-history-badge loss">L</span>'; const retColor = isWin ? 'var(--green)' : 'var(--red)'; const retStr = (isWin ? '+' : '') + (t.returnPercent || 0).toFixed(2) + '%'; html += `<div class="trade-history-row"><span class="trade-history-symbol">${t.symbol}</span>${badge}<span class="trade-history-return" style="color:${retColor}">${retStr}</span></div>`; });
            } else if (cardType === 'bestTrade') {
                const winners = closedTrades.filter(t => t.profitLoss > 0).sort((a, b) => b.profitLoss - a.profitLoss).slice(0, 5);
                if (winners.length === 0) { container.innerHTML = '<div style="font-size:12px;color:var(--text-faint);padding:8px 0;">No winning trades yet</div>'; return; }
                winners.forEach(t => { const holdDays = t.holdTime ? (t.holdTime / (1000*60*60*24)).toFixed(1) : '?'; const profit = '+$' + (t.profitLoss || 0).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2}); html += `<div class="top-trade-row"><div class="top-trade-header"><span class="top-trade-symbol">${t.symbol}</span><span class="top-trade-return" style="color:var(--green)">+${(t.returnPercent||0).toFixed(2)}%</span></div><div class="top-trade-details">${profit} &middot; ${holdDays}d hold</div></div>`; });
            } else if (cardType === 'worstTrade') {
                const losers = closedTrades.filter(t => t.profitLoss < 0).sort((a, b) => a.profitLoss - b.profitLoss).slice(0, 5);
                if (losers.length === 0) { container.innerHTML = '<div style="font-size:12px;color:var(--text-faint);padding:8px 0;">No losing trades yet</div>'; return; }
                losers.forEach(t => { const holdDays = t.holdTime ? (t.holdTime / (1000*60*60*24)).toFixed(1) : '?'; const loss = '$' + (t.profitLoss || 0).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2}); html += `<div class="top-trade-row"><div class="top-trade-header"><span class="top-trade-symbol">${t.symbol}</span><span class="top-trade-return" style="color:var(--red)">${(t.returnPercent||0).toFixed(2)}%</span></div><div class="top-trade-details">${loss} &middot; ${holdDays}d hold</div></div>`; });
            }
            container.innerHTML = html;
        }

        // === API KEY MANAGEMENT (SIMPLIFIED) ===

        function toggleApiConfig() {
            const panel = document.getElementById('apiConfigPanel');
            const toggle = document.getElementById('apiConfigToggle');
            if (panel.style.display === 'none') { panel.style.display = 'block'; toggle.textContent = 'Hide'; loadApiKeysToForm(); }
            else { panel.style.display = 'none'; toggle.textContent = 'Show'; }
        }

        function loadApiKeysToForm() {
            const el = document.getElementById('polygonKeyInput');
            if (el) el.value = localStorage.getItem('polygon_api_key') || '';
        }

        function saveApiKeys() {
            const polygonKey = document.getElementById('polygonKeyInput').value.trim();
            const warnings = [];
            if (polygonKey && polygonKey.length < 10) warnings.push('Massive API key looks too short');
            if (polygonKey) localStorage.setItem('polygon_api_key', polygonKey);
            POLYGON_API_KEY = polygonKey;
            const status = document.getElementById('apiKeySaveStatus');
            status.style.display = 'block';
            if (warnings.length > 0) { status.style.color = '#fbbf24'; status.textContent = '⚠️ Saved with warnings: ' + warnings.join('; '); }
            else { status.style.color = '#34d399'; status.textContent = '✅ API key saved locally!'; }
            updateApiKeyStatus();
            setTimeout(() => { status.style.display = 'none'; }, 5000);
        }

        function updateApiKeyStatus() {
            const polygonStatus = document.getElementById('polygonStatus');
            if (polygonStatus) {
                if (localStorage.getItem('polygon_api_key')) { polygonStatus.style.color = '#34d399'; polygonStatus.textContent = '✅ Massive: Configured'; }
                else { polygonStatus.style.color = '#f87171'; polygonStatus.textContent = '❌ Massive: Not configured'; }
            }
        }
