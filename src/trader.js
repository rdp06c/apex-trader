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
            lastSectorRotation: null // { timestamp, sectors: {...} }
        };

        // Anthropic API Configuration
        // IMPORTANT: Replace this with your Cloudflare Worker URL after setup
        // Anthropic API configuration - loaded from secure storage

        // Google Drive Cloud Sync Configuration - will be initialized after keys are loaded
        let GDRIVE_CONFIG = {
            CLIENT_ID: '',
            API_KEY: '',
            SCOPES: 'https://www.googleapis.com/auth/drive.file',
            PORTFOLIO_FILENAME: 'Apex_Portfolio.json'
        };

        // Concurrent execution guard — prevents double-clicks and overlapping runs
        let isAnalysisRunning = false;

        // Initialize GDRIVE_CONFIG with stored keys
        function initGdriveConfig() {
            GDRIVE_CONFIG.CLIENT_ID = GOOGLE_CLIENT_ID;
            GDRIVE_CONFIG.API_KEY = GOOGLE_API_KEY;
        }

        // Handle cloud sync button click
        function handleCloudSyncClick() {
            // Check if Google Drive is configured
            if (!GDRIVE_CONFIG.CLIENT_ID || !GDRIVE_CONFIG.API_KEY || 
                GDRIVE_CONFIG.CLIENT_ID === '' || GDRIVE_CONFIG.API_KEY === '') {
                alert('⚙️ Google Drive Not Configured\n\nPlease configure your Google API keys first:\n\n1. Click "Account Controls & Settings"\n2. Go to "API Configuration" → Show\n3. Enter your Google Client ID and API Key\n4. Click "Save Locally"\n5. Then come back and click this cloud icon');
                
                // Auto-open settings
                const controlsBody = document.getElementById('controlsBody');
                const controlsIcon = document.getElementById('controlsToggle');
                if (controlsBody && controlsBody.classList.contains('collapsed')) {
                    controlsBody.classList.remove('collapsed');
                    if (controlsIcon) controlsIcon.classList.remove('collapsed');
                }
                
                // Auto-open API config
                const apiPanel = document.getElementById('apiConfigPanel');
                const apiToggle = document.getElementById('apiConfigToggle');
                if (apiPanel && apiPanel.style.display === 'none') {
                    apiPanel.style.display = 'block';
                    apiToggle.textContent = 'Hide';
                    loadApiKeysToForm();
                }
                
                return;
            }

            // If tokenClient isn't initialized yet, initialize Google Drive first
            if (!tokenClient) {
                console.log('Initializing Google Drive...');
                initGoogleDrive();
                // Give it a moment to initialize, then retry
                setTimeout(() => {
                    if (tokenClient) {
                        tokenClient.requestAccessToken();
                    } else {
                        alert('⚠️ Google Drive initialization failed. Please refresh the page and try again.');
                    }
                }, 1000);
                return;
            }

            // If configured but not authorized yet, trigger authorization
            if (!gdriveAuthorized && tokenClient) {
                tokenClient.requestAccessToken();
            } else if (gdriveAuthorized) {
                // Already authorized, maybe sync portfolio
                savePortfolioToDrive();
            }
        }

        let gdriveReady = false;
        let gdriveAuthorized = false;
        let portfolioFileId = null;
        let accessToken = null;
        let tokenClient = null;
        let preventAutoSave = false; // Prevent auto-save to Drive during recovery

        // Chart instances
        let performanceChart = null;
        let sectorChart = null;

        // Stock sector mapping
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
            
            // Tech - Hardware/Semiconductors
            'AAPL': 'Apple', 'QCOM': 'Qualcomm', 'INTC': 'Intel', 'MU': 'Micron Technology',
            'ARM': 'Arm Holdings', 'AVGO': 'Broadcom', 'TXN': 'Texas Instruments', 'ADI': 'Analog Devices',
            'NXPI': 'NXP Semiconductors', 'KLAC': 'KLA Corporation', 'ASML': 'ASML Holding', 'TSM': 'Taiwan Semiconductor',
            'SNPS': 'Synopsys', 'CDNS': 'Cadence Design', 'ON': 'ON Semiconductor', 'MPWR': 'Monolithic Power',
            'SWKS': 'Skyworks Solutions', 'QRVO': 'Qorvo', 'DELL': 'Dell Technologies', 'HPQ': 'HP Inc.',
            'AMAT': 'Applied Materials', 'LRCX': 'Lam Research', 'MRVL': 'Marvell Technology', 'SMCI': 'Super Micro Computer',
            
            // EV/Automotive
            'TSLA': 'Tesla', 'RIVN': 'Rivian', 'LCID': 'Lucid Group', 'NIO': 'NIO Inc.',
            'XPEV': 'XPeng', 'LI': 'Li Auto', 'F': 'Ford', 'GM': 'General Motors',
            'STLA': 'Stellantis', 'TM': 'Toyota', 'HMC': 'Honda', 'RACE': 'Ferrari',
            
            // Finance
            'JPM': 'JPMorgan Chase', 'BAC': 'Bank of America', 'V': 'Visa', 'MA': 'Mastercard',
            'COIN': 'Coinbase', 'SOFI': 'SoFi', 'PYPL': 'PayPal', 'SQ': 'Block (Square)',
            'WFC': 'Wells Fargo', 'GS': 'Goldman Sachs', 'MS': 'Morgan Stanley', 'C': 'Citigroup',
            'BLK': 'BlackRock', 'SCHW': 'Charles Schwab', 'AFRM': 'Affirm', 'UPST': 'Upstart',
            'NU': 'Nu Holdings', 'MELI': 'MercadoLibre', 'HOOD': 'Robinhood',
            
            // Growth
            'DKNG': 'DraftKings', 'RBLX': 'Roblox', 'U': 'Unity Software', 'PINS': 'Pinterest',
            'SNAP': 'Snap Inc.', 'SPOT': 'Spotify', 'ROKU': 'Roku', 'ABNB': 'Airbnb',
            'LYFT': 'Lyft', 'DASH': 'DoorDash', 'UBER': 'Uber', 'SHOP': 'Shopify',
            
            // Healthcare
            'JNJ': 'Johnson & Johnson', 'UNH': 'UnitedHealth', 'LLY': 'Eli Lilly', 'PFE': 'Pfizer',
            'MRNA': 'Moderna', 'ABBV': 'AbbVie', 'VRTX': 'Vertex Pharma', 'REGN': 'Regeneron',
            'BMY': 'Bristol Myers Squibb', 'GILD': 'Gilead Sciences', 'AMGN': 'Amgen', 'CVS': 'CVS Health',
            'ISRG': 'Intuitive Surgical', 'TMO': 'Thermo Fisher', 'DHR': 'Danaher', 'ABT': 'Abbott Labs',
            
            // Consumer
            'AMZN': 'Amazon', 'WMT': 'Walmart', 'COST': 'Costco', 'TGT': 'Target',
            'HD': 'Home Depot', 'LOW': "Lowe's", 'SBUX': 'Starbucks', 'MCD': "McDonald's",
            'NKE': 'Nike', 'LULU': 'Lululemon', 'DIS': 'Disney', 'NFLX': 'Netflix',
            'KO': 'Coca-Cola', 'PEP': 'PepsiCo',
            
            // Energy
            'XOM': 'ExxonMobil', 'CVX': 'Chevron', 'COP': 'ConocoPhillips', 'SLB': 'Schlumberger',
            'NEE': 'NextEra Energy', 'ENPH': 'Enphase', 'FSLR': 'First Solar', 'PLUG': 'Plug Power',
            
            // Industrials
            'BA': 'Boeing', 'CAT': 'Caterpillar', 'DE': 'Deere & Co.', 'GE': 'General Electric',
            'HON': 'Honeywell', 'UPS': 'United Parcel Service', 'FDX': 'FedEx',
            
            // Real Estate
            'AMT': 'American Tower', 'PLD': 'Prologis', 'EQIX': 'Equinix', 'O': 'Realty Income',
            
            // Materials
            'NEM': 'Newmont', 'FCX': 'Freeport-McMoRan', 'NUE': 'Nucor', 'DOW': 'Dow Inc.',
            'USAR': 'USA Rare Earth', 'UUUU': 'Energy Fuels', 'NB': 'NioCorp Developments', 'MP': 'MP Materials',
            
            // Defense
            'LMT': 'Lockheed Martin', 'RTX': 'RTX Corporation', 'NOC': 'Northrop Grumman', 'GD': 'General Dynamics'
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
            'ZI': 'Technology', 'MNDY': 'Technology', 'PCOR': 'Technology', 'APP': 'Technology',
            'INTU': 'Technology',
            
            // Tech - Hardware/Semiconductors
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
            
            // EV/Automotive
            'TSLA': 'Automotive', 'RIVN': 'Automotive', 'LCID': 'Automotive', 'NIO': 'Automotive',
            'XPEV': 'Automotive', 'LI': 'Automotive', 'F': 'Automotive', 'GM': 'Automotive',
            'STLA': 'Automotive', 'TM': 'Automotive', 'HMC': 'Automotive', 'RACE': 'Automotive',
            'VWAGY': 'Automotive', 'PSNY': 'Automotive', 'NSANY': 'Automotive',
            'MBGYY': 'Automotive', 'POAHY': 'Automotive', 'FUJHY': 'Automotive', 
            'BLNK': 'Automotive', 'CHPT': 'Automotive', 'EVGO': 'Automotive',
            'PAG': 'Automotive', 'WOLF': 'Automotive', 'TPIC': 'Automotive', 'QS': 'Automotive',
            'PTRA': 'Automotive', 'WKHS': 'Automotive', 'ALV': 'Automotive', 'HYLN': 'Automotive',
            'GEV': 'Automotive', 'JZXN': 'Automotive', 'VRM': 'Automotive', 'SFT': 'Automotive',
            'CVNA': 'Automotive', 'KMX': 'Automotive', 'APTV': 'Automotive', 'LAZR': 'Automotive',
            'OUST': 'Automotive', 'AN': 'Automotive', 'LAD': 'Automotive',
            
            // Finance
            'JPM': 'Financial', 'BAC': 'Financial', 'V': 'Financial', 'MA': 'Financial',
            'COIN': 'Financial', 'SOFI': 'Financial', 'PYPL': 'Financial', 'GPN': 'Financial',
            'WFC': 'Financial', 'GS': 'Financial', 'MS': 'Financial', 'C': 'Financial',
            'BLK': 'Financial', 'SCHW': 'Financial', 'AFRM': 'Financial', 'UPST': 'Financial',
            'LC': 'Financial', 'NU': 'Financial', 'MELI': 'Financial', 'HOOD': 'Financial',
            'AXP': 'Financial', 'FIS': 'Financial', 'COF': 'Financial', 'ALLY': 'Financial',
            'USB': 'Financial', 'PNC': 'Financial', 'TFC': 'Financial', 'RF': 'Financial',
            'KEY': 'Financial', 'FITB': 'Financial', 'CFG': 'Financial', 'HBAN': 'Financial',
            'MTB': 'Financial', 'STT': 'Financial', 'BK': 'Financial', 'NTRS': 'Financial',
            'STATE': 'Financial', 'CMA': 'Financial', 'ZION': 'Financial', 'FHN': 'Financial',
            
            // Growth Tech/Consumer
            'DKNG': 'Technology', 'RBLX': 'Technology', 'U': 'Technology', 'PINS': 'Technology',
            'SNAP': 'Technology', 'SPOT': 'Technology', 'ROKU': 'Technology', 'ABNB': 'Consumer',
            'LYFT': 'Technology', 'DASH': 'Consumer', 'UBER': 'Technology', 'CPNG': 'Consumer',
            'SHOP': 'Technology', 'SE': 'Consumer', 'BABA': 'Consumer', 'JD': 'Consumer',
            'PDD': 'Consumer', 'BKNG': 'Consumer', 'EXPE': 'Consumer', 'TCOM': 'Consumer', 'TRIP': 'Consumer',
            'PTON': 'Consumer', 'OPEN': 'Technology', 'COMP': 'Technology', 'RKT': 'Financial',
            'CWAN': 'Technology', 'DUOL': 'Technology', 'BROS': 'Consumer', 'CAVA': 'Consumer',
            
            // Healthcare
            'JNJ': 'Healthcare', 'UNH': 'Healthcare', 'LLY': 'Healthcare', 'PFE': 'Healthcare',
            'MRNA': 'Healthcare', 'ABBV': 'Healthcare', 'VRTX': 'Healthcare', 'REGN': 'Healthcare',
            'BMY': 'Healthcare', 'GILD': 'Healthcare', 'AMGN': 'Healthcare', 'CVS': 'Healthcare',
            'CI': 'Healthcare', 'HUM': 'Healthcare', 'ISRG': 'Healthcare', 'TMO': 'Healthcare',
            'DHR': 'Healthcare', 'ABT': 'Healthcare', 'SYK': 'Healthcare', 'BSX': 'Healthcare',
            'MDT': 'Healthcare', 'BDX': 'Healthcare', 'BAX': 'Healthcare', 'ZBH': 'Healthcare',
            'HCA': 'Healthcare', 'DVA': 'Healthcare', 'CANO': 'Healthcare', 'IONQ': 'Technology',
            'EXAS': 'Healthcare', 'ILMN': 'Healthcare', 'BIIB': 'Healthcare', 'ALNY': 'Healthcare',
            'INCY': 'Healthcare', 'NBIX': 'Healthcare', 'UTHR': 'Healthcare', 'JAZZ': 'Healthcare',
            'SRPT': 'Healthcare', 'BMRN': 'Healthcare', 'IONS': 'Healthcare', 'RGEN': 'Healthcare',
            
            // Consumer
            'AMZN': 'Consumer', 'WMT': 'Consumer', 'COST': 'Consumer', 'TGT': 'Consumer',
            'HD': 'Consumer', 'LOW': 'Consumer', 'SBUX': 'Consumer', 'MCD': 'Consumer',
            'CMG': 'Consumer', 'YUM': 'Consumer', 'NKE': 'Consumer', 'LULU': 'Consumer',
            'ETSY': 'Consumer', 'W': 'Consumer', 'CHWY': 'Consumer',
            'DIS': 'Consumer', 'NFLX': 'Consumer', 'ROKU': 'Consumer', 'CARR': 'Industrials', 'WBD': 'Consumer',
            'FOXA': 'Consumer', 'CMCSA': 'Consumer', 'T': 'Consumer', 'VZ': 'Consumer', 'TMUS': 'Consumer',
            'KO': 'Consumer', 'PEP': 'Consumer', 'PM': 'Consumer', 'MO': 'Consumer',
            'BUD': 'Consumer', 'TAP': 'Consumer', 'STZ': 'Consumer', 'MNST': 'Consumer',
            'CELH': 'Consumer', 'KDP': 'Consumer', 'ULTA': 'Consumer', 'ELF': 'Consumer',
            'RH': 'Consumer', 'DECK': 'Consumer', 'CROX': 'Consumer', 'LEVI': 'Consumer',
            'UAA': 'Consumer', 'ORLY': 'Consumer', 'AZO': 'Consumer', 'AAP': 'Consumer',
            'GPC': 'Consumer', 'TSCO': 'Consumer', 'DG': 'Consumer', 'DLTR': 'Consumer',
            'ROST': 'Consumer', 'TJX': 'Consumer', 'BBY': 'Consumer',
            
            // Energy
            'XOM': 'Energy', 'CVX': 'Energy', 'COP': 'Energy', 'SLB': 'Energy',
            'EOG': 'Energy', 'OXY': 'Energy', 'MPC': 'Energy', 'PSX': 'Energy',
            'VLO': 'Energy', 'TRGP': 'Energy', 'DVN': 'Energy', 'FANG': 'Energy',
            'WMB': 'Energy', 'APA': 'Energy', 'HAL': 'Energy', 'BKR': 'Energy',
            'NOV': 'Energy', 'FTI': 'Energy', 'NEE': 'Energy', 'DUK': 'Energy',
            'SO': 'Energy', 'D': 'Energy', 'AEP': 'Energy', 'EXC': 'Energy',
            'OKE': 'Energy',
            'ENPH': 'Energy', 'SEDG': 'Energy', 'RUN': 'Energy', 'NOVA': 'Energy',
            'FSLR': 'Energy', 'PLUG': 'Energy', 'PBF': 'Energy', 'DK': 'Energy',
            'CTRA': 'Energy', 'OVV': 'Energy', 'PR': 'Energy', 'SM': 'Energy',
            'MGY': 'Energy', 'MTDR': 'Energy', 'CHRD': 'Energy', 'VNOM': 'Energy',
            
            // Industrials
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
            
            // Real Estate
            'AMT': 'Real Estate', 'PLD': 'Real Estate', 'CCI': 'Real Estate', 'EQIX': 'Real Estate',
            'PSA': 'Real Estate', 'DLR': 'Real Estate', 'WELL': 'Real Estate', 'O': 'Real Estate',
            'VICI': 'Real Estate', 'SPG': 'Real Estate', 'AVB': 'Real Estate', 'EQR': 'Real Estate',
            'MAA': 'Real Estate', 'UDR': 'Real Estate', 'CPT': 'Real Estate', 'ESS': 'Real Estate',
            'AIV': 'Real Estate', 'ELS': 'Real Estate', 'SUI': 'Real Estate', 'NXRT': 'Real Estate',
            'VTR': 'Real Estate', 'STWD': 'Real Estate', 'VLTO': 'Industrials', 'DOC': 'Real Estate', 'OHI': 'Real Estate',
            'SBRA': 'Real Estate', 'LTC': 'Real Estate', 'HR': 'Real Estate', 'MPW': 'Real Estate',
            'NHI': 'Real Estate', 'CTRE': 'Real Estate', 'IRM': 'Real Estate', 'CUBE': 'Real Estate',
            'LSI': 'Real Estate', 'NSA': 'Real Estate', 'REXR': 'Real Estate', 'PSB': 'Real Estate',
            'TRNO': 'Real Estate', 'SELF': 'Real Estate', 'STOR': 'Real Estate', 'SAFE': 'Real Estate',
            
            // Materials
            'NEM': 'Materials', 'FCX': 'Materials', 'GOLD': 'Materials', 'AU': 'Materials',
            'AEM': 'Materials', 'WPM': 'Materials', 'FNV': 'Materials', 'RGLD': 'Materials',
            'KGC': 'Materials', 'HL': 'Materials', 'NUE': 'Materials', 'STLD': 'Materials',
            'RS': 'Materials', 'CLF': 'Materials', 'MT': 'Materials',
            'TX': 'Materials', 'CMC': 'Materials', 'NB': 'Materials', 'ATI': 'Materials',
            'DOW': 'Materials', 'LYB': 'Materials', 'EMN': 'Materials', 'CE': 'Materials',
            'APD': 'Materials', 'LIN': 'Materials', 'ECL': 'Materials', 
            'SHW': 'Materials', 'PPG': 'Materials', 'RPM': 'Materials', 'AXTA': 'Materials',
            'ALB': 'Materials', 'SQM': 'Materials', 'LAC': 'Materials', 'AA': 'Materials',
            'MP': 'Materials', 'DD': 'Materials', 'USAR': 'Materials',
            'FUL': 'Materials', 'NEU': 'Materials', 'UUUU': 'Materials',
            
            // Defense
            'LMT': 'Defense', 'RTX': 'Defense', 'NOC': 'Defense', 'GD': 'Defense',
            'LHX': 'Defense', 'HII': 'Defense', 'TXT': 'Defense', 'HWM': 'Defense',
            'AXON': 'Defense', 'KTOS': 'Defense', 'AVAV': 'Defense', 'AIR': 'Defense',
            'SAIC': 'Defense', 'LDOS': 'Defense', 'CACI': 'Defense', 'BAH': 'Defense',
            'BWXT': 'Defense', 'WWD': 'Defense', 'MOG.A': 'Defense', 'TDG': 'Defense',
            'HEI': 'Defense', 'ROCK': 'Defense', 'EQT': 'Energy', 'CW': 'Defense',
            'AIN': 'Defense', 'GMS': 'Defense', 'MLI': 'Defense', 'B': 'Defense',
            'RUSHA': 'Defense', 'AMSWA': 'Defense', 'PLXS': 'Defense', 'NPAB': 'Defense',
            'VECO': 'Defense', 'POWI': 'Defense', 'VICR': 'Defense', 'MYRG': 'Defense',
            'DY': 'Defense', 'APOG': 'Defense', 'HSII': 'Defense',
            
            // Index Funds (not tracked in portfolio)
            'SPY': 'Index Fund', 'QQQ': 'Index Fund', 'IWM': 'Index Fund', 'VOO': 'Index Fund'
        };

        // API Configuration
        // API Keys - Stored securely in browser, never in code
        let POLYGON_API_KEY = localStorage.getItem('polygon_api_key') || '';
        let GOOGLE_CLIENT_ID = localStorage.getItem('google_client_id') || '';
        let GOOGLE_API_KEY = localStorage.getItem('google_api_key') || '';
        let ANTHROPIC_API_URL = localStorage.getItem('anthropic_api_url') || '';

        // Check if API keys are configured
        function checkApiKeysConfigured() {
            const missingKeys = [];
            if (!POLYGON_API_KEY) missingKeys.push('Polygon.io API Key');
            if (!GOOGLE_CLIENT_ID) missingKeys.push('Google Client ID');
            if (!GOOGLE_API_KEY) missingKeys.push('Google API Key');
            if (!ANTHROPIC_API_URL) missingKeys.push('Anthropic API URL');
            
            if (missingKeys.length > 0) {
                console.warn('Missing API keys:', missingKeys.join(', '));
                return false;
            }
            return true;
        }
        
        // Price cache to store real data and prevent mock data usage
        let priceCache = {};
        let apiCallsToday = 0;  // Consolidated - removed duplicate apiCallCount
        let lastResetDate = new Date().toDateString();
        let chatHistory = []; // Conversation memory for chat (last 5 exchanges)
        const MAX_API_CALLS_PER_DAY = 25;
        
        // Load cached prices from localStorage
        function loadPriceCache() {
            const cached = localStorage.getItem('priceCache');
            const cacheDate = localStorage.getItem('priceCacheDate');
            const today = new Date().toDateString();
            
            // Reset API call count if it's a new day
            if (cacheDate !== today) {
                localStorage.setItem('priceCacheDate', today);
                localStorage.setItem('apiCallsToday', '0');
                apiCallsToday = 0;
            } else {
                apiCallsToday = parseInt(localStorage.getItem('apiCallsToday') || '0');
            }
            
            // Load cached prices (don't reset these daily)
            if (cached) {
                priceCache = JSON.parse(cached);
            }
        }

        // Save price to cache
        function savePriceToCache(symbol, priceData) {
            priceCache[symbol] = {
                ...priceData,
                timestamp: new Date().toISOString(),
                cachedAt: new Date().toLocaleTimeString()
            };
            localStorage.setItem('priceCache', JSON.stringify(priceCache));
        }

        // Get cached price (accepts up to 4 hours old)
        function getCachedPrice(symbol) {
            if (priceCache[symbol]) {
                const cached = priceCache[symbol];
                const cacheAge = Date.now() - new Date(cached.timestamp).getTime();
                const fourHours = 4 * 60 * 60 * 1000;
                
                if (cacheAge < fourHours) {
                    return {
                        ...cached,
                        isFromCache: true
                    };
                }
            }
            return null;
        }

        // Increment and save API call count
        function incrementApiCallCount() {
            apiCallsToday++;
            localStorage.setItem('apiCallsToday', apiCallsToday.toString());
            updateApiStatus();
        }

        // Update API status display
        function updateApiStatus() {
            const remaining = MAX_API_CALLS_PER_DAY - apiCallsToday;
            const statusEl = document.getElementById('apiKeyStatus');
            if (statusEl && POLYGON_API_KEY) {
                statusEl.textContent = `✓ Polygon API active - ${remaining} calls remaining today`;
                if (remaining < 5) {
                    statusEl.style.color = '#f87171';
                } else if (remaining < 10) {
                    statusEl.style.color = '#fbbf24';
                } else {
                    statusEl.style.color = '#34d399';
                }
            }
        }

        // Initialize the chart
        function initChart() {
            const ctx = document.getElementById('performanceChart').getContext('2d');
            // Build gradient fill for portfolio line
            const gradient = ctx.createLinearGradient(0, 0, 0, ctx.canvas.height);
            gradient.addColorStop(0, 'rgba(245, 158, 11, 0.25)');
            gradient.addColorStop(0.6, 'rgba(245, 158, 11, 0.06)');
            gradient.addColorStop(1, 'rgba(245, 158, 11, 0)');

            performanceChart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [
                        {
                            label: 'Portfolio Value',
                            data: [],
                            borderColor: '#f59e0b',
                            backgroundColor: gradient,
                            borderWidth: 2.5,
                            tension: 0.35,
                            fill: true,
                            pointRadius: 0,
                            pointHoverRadius: 5,
                            pointHoverBackgroundColor: '#f59e0b',
                            pointHoverBorderColor: '#fff',
                            pointHoverBorderWidth: 2
                        },
                        {
                            label: 'Trading P&L (excl. deposits)',
                            data: [],
                            borderColor: '#34d399',
                            backgroundColor: 'transparent',
                            borderWidth: 1.5,
                            borderDash: [6, 3],
                            tension: 0.35,
                            fill: false,
                            pointRadius: 0,
                            pointHoverRadius: 4,
                            pointHoverBackgroundColor: '#34d399',
                            pointHoverBorderColor: '#fff',
                            pointHoverBorderWidth: 2
                        },
                        {
                            label: 'Deposits',
                            data: [],
                            borderColor: 'transparent',
                            backgroundColor: '#60a5fa',
                            pointRadius: [],
                            pointStyle: 'rectRot',
                            pointBackgroundColor: '#60a5fa',
                            pointBorderColor: '#fff',
                            pointBorderWidth: 1.5,
                            pointHoverStyle: 'rectRot',
                            pointHoverBackgroundColor: '#60a5fa',
                            pointHoverBorderColor: '#fff',
                            pointHoverBorderWidth: 2,
                            pointHoverRadius: 8,
                            showLine: false,
                            order: 0
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: {
                        intersect: false,
                        mode: 'index'
                    },
                    plugins: {
                        legend: {
                            display: true,
                            position: 'top',
                            align: 'end',
                            labels: {
                                color: '#a8a8a0',
                                font: {
                                    family: "'Inter', sans-serif",
                                    size: 11,
                                    weight: '500'
                                },
                                boxWidth: 12,
                                boxHeight: 3,
                                usePointStyle: false,
                                padding: 16
                            }
                        },
                        tooltip: {
                            backgroundColor: 'rgba(22, 22, 25, 0.95)',
                            titleColor: '#f5f5f0',
                            bodyColor: '#a8a8a0',
                            borderColor: 'rgba(245, 158, 11, 0.3)',
                            borderWidth: 1,
                            padding: 12,
                            cornerRadius: 8,
                            titleFont: {
                                family: "'Inter', sans-serif",
                                size: 12,
                                weight: '600'
                            },
                            bodyFont: {
                                family: "'Inter', sans-serif",
                                size: 12
                            },
                            displayColors: true,
                            boxWidth: 8,
                            boxHeight: 8,
                            boxPadding: 4,
                            callbacks: {
                                afterBody: function(tooltipItems) {
                                    const idx = tooltipItems[0]?.dataIndex;
                                    if (idx !== undefined && performanceChart._depositAmounts && performanceChart._depositAmounts[idx]) {
                                        return '💰 Deposit: +$' + performanceChart._depositAmounts[idx].toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
                                    }
                                    return '';
                                }
                            },
                            filter: function(tooltipItem) {
                                return tooltipItem.datasetIndex !== 2;
                            }
                        }
                    },
                    scales: {
                        y: {
                            beginAtZero: false,
                            border: {
                                display: false
                            },
                            ticks: {
                                color: '#78786e',
                                font: {
                                    family: "'Inter', sans-serif",
                                    size: 11
                                },
                                padding: 8,
                                callback: function(value) {
                                    return '$' + value.toLocaleString();
                                }
                            },
                            grid: {
                                color: 'rgba(255, 200, 100, 0.05)',
                                drawTicks: false
                            }
                        },
                        x: {
                            border: {
                                display: false
                            },
                            ticks: {
                                color: '#78786e',
                                font: {
                                    family: "'Inter', sans-serif",
                                    size: 10
                                },
                                padding: 6,
                                maxRotation: 0
                            },
                            grid: {
                                display: false
                            }
                        }
                    }
                }
            });

            // Initialize sector chart
            const sectorCtx = document.getElementById('sectorChart').getContext('2d');
            sectorChart = new Chart(sectorCtx, {
                type: 'doughnut',
                data: {
                    labels: [],
                    datasets: [{
                        data: [],
                        backgroundColor: [
                            '#f59e0b',
                            '#a78bfa',
                            '#34d399',
                            '#60a5fa',
                            '#f97316',
                            '#ec4899',
                            '#fbbf24',
                            '#14b8a6',
                            '#8b5cf6',
                            '#f43f5e',
                            '#06b6d4',
                            '#84cc16'
                        ],
                        borderWidth: 3,
                        borderColor: '#1a1a22',
                        hoverBorderColor: '#1a1a22',
                        hoverOffset: 6
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    cutout: '68%',
                    plugins: {
                        legend: {
                            display: false
                        },
                        tooltip: {
                            backgroundColor: 'rgba(22, 22, 25, 0.95)',
                            titleColor: '#f5f5f0',
                            bodyColor: '#a8a8a0',
                            borderColor: 'rgba(255, 200, 100, 0.15)',
                            borderWidth: 1,
                            padding: 12,
                            cornerRadius: 8,
                            titleFont: {
                                family: "'Inter', sans-serif",
                                size: 12,
                                weight: '600'
                            },
                            bodyFont: {
                                family: "'Inter', sans-serif",
                                size: 12
                            },
                            callbacks: {
                                label: function(context) {
                                    return ' ' + context.label + ': ' + context.parsed.toFixed(1) + '%';
                                }
                            }
                        }
                    }
                }
            });
        }

        async function updatePerformanceChart() {
            if (!performanceChart || portfolio.performanceHistory.length === 0) return;
            
            // Update labels
            performanceChart.data.labels = portfolio.performanceHistory.map(h => {
                const date = new Date(h.timestamp);
                const today = new Date();
                const yesterday = new Date(today);
                yesterday.setDate(yesterday.getDate() - 1);
                
                let dateStr;
                if (date.toDateString() === today.toDateString()) {
                    dateStr = 'Today';
                } else if (date.toDateString() === yesterday.toDateString()) {
                    dateStr = 'Yesterday';
                } else {
                    dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                }
                
                const timeStr = date.toLocaleTimeString('en-US', { 
                    hour: 'numeric', 
                    minute: '2-digit',
                    hour12: true 
                });
                
                return `${dateStr} ${timeStr}`;
            });
            
            // Dataset 1: Raw portfolio value
            const rawValues = portfolio.performanceHistory.map(h => h.value);
            performanceChart.data.datasets[0].data = rawValues;
            
            // Dataset 2: Trading P&L (value minus deposits)
            // Simple approach: total deposits we know about, spread across the timeline
            // by detecting which history points had deposits (flagged or detected via jumps)
            
            const initialBal = portfolio.initialBalance || 0;
            const totalDeps = portfolio.totalDeposits || initialBal;
            const extraDeposits = totalDeps - initialBal; // Total added beyond initial
            
            console.log(`📊 Chart debug: initialBal=$${initialBal}, totalDeps=$${totalDeps}, extraDeposits=$${extraDeposits}`);
            
            // Build deposit timeline: check for flagged deposits AND detect jumps
            // A "deposit" entry has {deposit: amount} in performanceHistory
            // A "detected deposit" is a point where value jumped but no trading explains it
            const depositTimeline = []; // [{index, amount}]
            
            // Pass 1: Find explicitly flagged deposits
            portfolio.performanceHistory.forEach((h, i) => {
                if (h.deposit) {
                    depositTimeline.push({ index: i, amount: h.deposit, flagged: true });
                }
            });
            
            // Pass 2: If no flagged deposits found but we know extra deposits happened,
            // detect them as value jumps that exceed what trading could produce
            if (depositTimeline.length === 0 && extraDeposits > 0) {
                for (let i = 1; i < rawValues.length; i++) {
                    const prev = rawValues[i - 1];
                    const curr = rawValues[i];
                    if (prev && curr && prev > 0) {
                        const jump = curr - prev;
                        // Consider it a deposit if the jump is both:
                        // - More than $50 absolute
                        // - More than 10% of previous value
                        if (jump > 50 && (jump / prev) > 0.10) {
                            depositTimeline.push({ index: i, amount: jump, detected: true });
                            console.log(`📊 Detected deposit at point ${i}: +$${jump.toFixed(2)} (${(jump/prev*100).toFixed(1)}% jump)`);
                        }
                    }
                }
            }
            
            // Build cumulative deposit amount at each point
            let cumDeposit = 0;
            const adjustedValues = rawValues.map((val, i) => {
                const depositAtPoint = depositTimeline.find(d => d.index === i);
                if (depositAtPoint) {
                    cumDeposit += depositAtPoint.amount;
                }
                // Adjusted = raw value minus all deposits that happened up to this point
                const adjusted = val - cumDeposit;
                return adjusted;
            });
            
            // If we still haven't accounted for deposits (neither flagged nor detected),
            // just subtract total extra deposits from all points after the first
            if (depositTimeline.length === 0 && extraDeposits > 0) {
                console.log(`📊 No deposits detected in history, using flat subtraction of $${extraDeposits}`);
                for (let i = 0; i < adjustedValues.length; i++) {
                    // For the first point, don't subtract (it's the initial balance)
                    // For all others, subtract extra deposits
                    if (i > 0) {
                        adjustedValues[i] = rawValues[i] - extraDeposits;
                    }
                }
            }
            
            console.log(`📊 Chart: raw last=$${rawValues[rawValues.length-1]?.toFixed(2)}, adjusted last=$${adjustedValues[adjustedValues.length-1]?.toFixed(2)}, deposits found=${depositTimeline.length}`);
            
            performanceChart.data.datasets[1].data = adjustedValues;
            
            // Dataset 3: Deposit markers (yellow triangles)
            // Also store deposit amounts for tooltip display
            const depositAmounts = {};
            depositTimeline.forEach(d => {
                depositAmounts[d.index] = d.amount;
            });
            performanceChart._depositAmounts = depositAmounts;
            
            const depositMarkers = rawValues.map((val, i) => {
                return depositTimeline.find(d => d.index === i) ? val : null;
            });
            const depositPointRadii = depositMarkers.map(v => v !== null ? 8 : 0);
            performanceChart.data.datasets[2].data = depositMarkers;
            performanceChart.data.datasets[2].pointRadius = depositPointRadii;
            
            performanceChart.update();
        }

        // Initialize account
        function initializeAccount() {
            const balance = parseFloat(document.getElementById('initialBalance').value);
            portfolio.cash = balance;
            portfolio.initialBalance = balance;
            portfolio.totalDeposits = balance; // Track initial deposit
            portfolio.holdings = {};
            portfolio.transactions = [];
            portfolio.performanceHistory = [{
                timestamp: new Date().toISOString(),
                value: balance
            }];
            
            addActivity('Account initialized with $' + balance.toLocaleString(), 'init');
            updateUI();
            savePortfolio();
        }

        // Add weekly funding
        function addWeeklyFunding() {
            const funding = parseFloat(document.getElementById('weeklyFunding').value);
            portfolio.cash += funding;
            portfolio.totalDeposits += funding; // Track this deposit
            
            // Record the deposit in performance history so the chart can annotate it
            const lastKnown = portfolio.performanceHistory.filter(e => e.value != null).slice(-1)[0];
            const estimatedValue = (lastKnown ? lastKnown.value : portfolio.cash) + funding;
            portfolio.performanceHistory.push({
                timestamp: new Date().toISOString(),
                value: estimatedValue,
                deposit: funding
            });
            
            addActivity('Weekly funding added: $' + funding.toLocaleString(), 'funding');
            updateUI();
            savePortfolio();
        }
        
        // Portfolio Backup & Recovery Functions
        function clearLocalStorage() {
            if (confirm('⚠️ This will clear ALL local data including your portfolio!\n\nMake sure you have a backup in Google Drive first.\n\nContinue?')) {
                localStorage.clear();
                preventAutoSave = true;
                const status = document.getElementById('recoveryStatus');
                status.textContent = '✅ Local storage cleared! Now use "Restore from Local File" to load your backup.';
                status.style.color = '#34d399';
                addActivity('🗑️ Local storage cleared - recovery mode active', 'warning');
            }
        }
        
        // Restore from a local JSON file
        function restoreFromLocalFile(input) {
            const status = document.getElementById('recoveryStatus');
            const file = input.files[0];
            
            if (!file) return;
            
            if (!file.name.endsWith('.json')) {
                status.textContent = '❌ Please select a .json file.';
                status.style.color = '#ef4444';
                return;
            }
            
            if (!confirm(`⚠️ This will replace your current portfolio with the data from "${file.name}".\n\nCurrent portfolio will be overwritten.\n\nContinue?`)) {
                input.value = '';
                return;
            }
            
            status.textContent = `⏳ Reading ${file.name}...`;
            status.style.color = '#3b82f6';
            
            const reader = new FileReader();
            reader.onload = function(e) {
                try {
                    const restoredPortfolio = JSON.parse(e.target.result);
                    
                    if (typeof restoredPortfolio.cash === 'undefined' || typeof restoredPortfolio.holdings === 'undefined') {
                        throw new Error('File does not appear to be a valid APEX portfolio (missing cash or holdings).');
                    }
                    
                    console.log('Loaded portfolio from local file:', restoredPortfolio);
                    console.log('Cash:', restoredPortfolio.cash, 'Holdings:', Object.keys(restoredPortfolio.holdings).length);
                    
                    preventAutoSave = true;
                    
                    portfolio = restoredPortfolio;
                    localStorage.setItem('aiTradingPortfolio', JSON.stringify(portfolio));
                    
                    updateUI();
                    updatePerformanceAnalytics();
                    updateSectorAllocation();
                    
                    preventAutoSave = false;
                    
                    const holdingsCount = Object.keys(portfolio.holdings).length;
                    status.textContent = `✅ Portfolio restored from ${file.name}! $${portfolio.cash.toFixed(2)} cash, ${holdingsCount} positions. Reloading...`;
                    status.style.color = '#34d399';
                    addActivity(`💾 Portfolio restored from local file "${file.name}" - $${portfolio.cash.toFixed(2)} cash, ${holdingsCount} positions`, 'success');
                    
                    setTimeout(() => { location.reload(); }, 2000);
                    
                } catch (error) {
                    preventAutoSave = false;
                    status.textContent = '❌ Failed to restore: ' + error.message;
                    status.style.color = '#ef4444';
                    console.error('Local file restore error:', error);
                }
            };
            
            reader.onerror = function() {
                status.textContent = '❌ Failed to read file.';
                status.style.color = '#ef4444';
            };
            
            reader.readAsText(file);
            input.value = '';
        }
        
        // Manual save to Google Drive with user feedback
        async function manualSaveToDrive() {
            const status = document.getElementById('recoveryStatus');
            
            if (!gdriveAuthorized || !accessToken) {
                status.textContent = '❌ Not connected to Google Drive. Click the ☁️ cloud icon to sign in first.';
                status.style.color = '#ef4444';
                return;
            }
            
            try {
                status.textContent = '⏳ Saving portfolio to Google Drive...';
                status.style.color = '#3b82f6';
                
                await savePortfolioToDrive();
                
                const holdingsCount = Object.keys(portfolio.holdings).length;
                status.textContent = `✅ Portfolio saved to Google Drive! $${portfolio.cash.toFixed(2)} cash, ${holdingsCount} positions. (${new Date().toLocaleTimeString()})`;
                status.style.color = '#34d399';
            } catch (error) {
                status.textContent = '❌ Save failed: ' + error.message;
                status.style.color = '#ef4444';
                console.error('Manual save to Drive error:', error);
            }
        }

        // Reset API call counter daily
        function checkAndResetApiCounter() {
            const today = new Date().toDateString();
            if (!lastResetDate) {
                lastResetDate = today;
            }
            if (today !== lastResetDate) {
                apiCallsToday = 0;
                lastResetDate = today;
                localStorage.setItem('apiCallsToday', '0');
                localStorage.setItem('lastResetDate', today);
            }
        }

        // Load API usage from storage
        function loadApiUsage() {
            const savedCalls = localStorage.getItem('apiCallsToday');
            const savedDate = localStorage.getItem('lastResetDate');
            const savedCache = localStorage.getItem('priceCache');
            
            // Initialize lastResetDate if not set
            if (savedDate) {
                lastResetDate = savedDate;
            } else {
                lastResetDate = new Date().toDateString();
            }
            
            if (savedCalls) {
                apiCallsToday = parseInt(savedCalls);
            }
            
            if (savedCache) {
                try {
                    priceCache = JSON.parse(savedCache);
                } catch (e) {
                    priceCache = {};
                }
            }
            
            checkAndResetApiCounter();
            updateApiUsageDisplay();
        }

        // Save API usage to storage
        function saveApiUsage() {
            localStorage.setItem('apiCallsToday', apiCallsToday.toString());
            localStorage.setItem('lastResetDate', lastResetDate);
            localStorage.setItem('priceCache', JSON.stringify(priceCache));
        }

        // Update API usage display
        function updateApiUsageDisplay() {
            const statusEl = document.getElementById('apiUsageStatus');
            if (statusEl) {
                statusEl.textContent = `API Calls: ${apiCallsToday} used today | Unlimited remaining ✅`;
                statusEl.style.color = '#34d399'; // Always green for unlimited
            }
        }

        // Get live stock price with caching (15-minute cache to avoid stale prices)
        // ENHANCED MARKET ANALYSIS - Real multi-day momentum and strength metrics
        
        // Cache for 5-day price history (fetched once per analysis run)
        let multiDayCache = {};
        
        // Fetch 5-day price history from Polygon aggregate bars
        async function fetch5DayHistory(symbol) {
            if (multiDayCache[symbol]) return multiDayCache[symbol];
            try {
                const today = new Date();
                const from = new Date(today);
                from.setDate(from.getDate() - 30); // 30 calendar days ≈ 20 trading days (for structure detection)
                const fromStr = from.toISOString().split('T')[0];
                const toStr = today.toISOString().split('T')[0];
                const response = await fetch(
                    `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/day/${fromStr}/${toStr}?adjusted=true&sort=asc&apiKey=${POLYGON_API_KEY}`
                );
                if (!response.ok) {
                    console.warn(`[${symbol}] History fetch HTTP ${response.status}: ${response.statusText}`);
                    return null;
                }
                const data = await response.json();
                if ((data.status === 'OK' || data.status === 'DELAYED') && data.results && data.results.length >= 2) {
                    multiDayCache[symbol] = data.results;
                    return data.results;
                }
                if (data.status !== 'OK' && data.status !== 'DELAYED') {
                    console.warn(`[${symbol}] History API error: status=${data.status}, message=${data.message || 'none'}`);
                }
                return null;
            } catch (error) {
                console.warn(`Price history unavailable for ${symbol}:`, error.message);
                return null;
            }
        }
        
        // Batch-fetch 5-day history for all symbols
        async function fetchAll5DayHistories(symbols) {
            multiDayCache = {};
            const BATCH = 50, DELAY = 1200;
            for (let i = 0; i < symbols.length; i += BATCH) {
                const batch = symbols.slice(i, i + BATCH);
                await Promise.all(batch.map(s => fetch5DayHistory(s)));
                if (i + BATCH < symbols.length) await new Promise(r => setTimeout(r, DELAY));
            }
            console.log(`✅ Fetched 5-day history for ${Object.keys(multiDayCache).length}/${symbols.length} stocks`);
        }
        
        // Calculate REAL 5-day momentum score (uses last 5 bars from 20-day cache)
        function calculate5DayMomentum(priceData, symbol) {
            const allBars = multiDayCache[symbol];
            if (!allBars || allBars.length < 2) {
                if (!priceData || !priceData.price) return { score: 0, trend: 'unknown', basis: 'no-data' };
                const cp = priceData.changePercent || 0;
                let score = 5;
                if (cp > 5) score = 10; else if (cp > 2) score = 8; else if (cp > 0) score = 6;
                else if (cp > -2) score = 4; else if (cp > -5) score = 2; else score = 0;
                return { score, trend: score >= 6 ? 'building' : score <= 4 ? 'fading' : 'neutral', changePercent: cp, basis: '1-day-fallback' };
            }
            // Use last 5 bars for momentum (not full 20-day window)
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
        
        // Calculate relative strength vs sector using MULTI-DAY data
        function calculateRelativeStrength(stockData, sectorData, symbol) {
            if (!stockData || !sectorData || sectorData.length === 0) return { rsScore: 50, strength: 'neutral' };
            const stockBars = multiDayCache[symbol];
            let stockReturn = stockData.changePercent || 0, usedMultiDay = false;
            if (stockBars && stockBars.length >= 2) {
                const recent5 = stockBars.slice(-5);
                stockReturn = ((recent5[recent5.length - 1].c - recent5[0].c) / recent5[0].c) * 100;
                usedMultiDay = true;
            }
            let sectorTotal = 0, sectorCount = 0;
            sectorData.forEach(stock => {
                const sBars = multiDayCache[stock.symbol];
                if (sBars && sBars.length >= 2) {
                    const sRecent5 = sBars.slice(-5);
                    sectorTotal += ((sRecent5[sRecent5.length - 1].c - sRecent5[0].c) / sRecent5[0].c) * 100;
                }
                else sectorTotal += (stock.changePercent || 0);
                sectorCount++;
            });
            const sectorAvg = sectorCount > 0 ? sectorTotal / sectorCount : 0;
            const relativePerformance = stockReturn - sectorAvg;
            const multiplier = usedMultiDay ? 5 : 10;
            let rsScore = 50 + (relativePerformance * multiplier);
            rsScore = Math.max(0, Math.min(100, rsScore));
            const strength = rsScore >= 70 ? 'outperforming' : rsScore >= 55 ? 'above-average' : rsScore >= 45 ? 'neutral' : rsScore >= 30 ? 'below-average' : 'underperforming';
            return { rsScore: Math.round(rsScore), strength, stockReturn5d: Math.round(stockReturn * 100) / 100, sectorAvg5d: Math.round(sectorAvg * 100) / 100, relativePerformance: Math.round(relativePerformance * 100) / 100, basis: usedMultiDay ? '5-day' : '1-day-fallback' };
        }
        
        // Detect sector rotation using MULTI-DAY data
        function detectSectorRotation(marketData) {
            const sectors = {};
            Object.entries(marketData).forEach(([symbol, data]) => {
                const sector = stockSectors[symbol] || 'Unknown';
                if (!sectors[sector]) sectors[sector] = { stocks: [], totalReturn5d: 0, totalChangeToday: 0, leaders5d: 0, laggards5d: 0, leadersToday: 0, laggardsToday: 0 };
                const bars = multiDayCache[symbol];
                let return5d = data.changePercent || 0;
                if (bars && bars.length >= 2) {
                    const recent5 = bars.slice(-5);
                    return5d = ((recent5[recent5.length - 1].c - recent5[0].c) / recent5[0].c) * 100;
                }
                sectors[sector].stocks.push({ symbol, ...data, return5d });
                sectors[sector].totalReturn5d += return5d;
                sectors[sector].totalChangeToday += (data.changePercent || 0);
                if (return5d > 2) sectors[sector].leaders5d++;
                if (return5d < -2) sectors[sector].laggards5d++;
                if ((data.changePercent || 0) > 1) sectors[sector].leadersToday++;
                if ((data.changePercent || 0) < -1) sectors[sector].laggardsToday++;
            });
            const sectorAnalysis = {};
            Object.entries(sectors).forEach(([sector, data]) => {
                const count = data.stocks.length;
                const avgReturn5d = data.totalReturn5d / count;
                const avgChange = data.totalChangeToday / count;
                const leaderRatio5d = data.leaders5d / count;
                const laggardRatio5d = data.laggards5d / count;
                let flow = 'neutral', rotationSignal = 'hold';
                if (avgReturn5d > 2 && leaderRatio5d > 0.5) { flow = 'inflow'; rotationSignal = 'accumulate'; }
                else if (avgReturn5d > 1 && leaderRatio5d > 0.35) { flow = 'modest-inflow'; rotationSignal = 'favorable'; }
                else if (avgReturn5d < -2 && laggardRatio5d > 0.5) { flow = 'outflow'; rotationSignal = 'avoid'; }
                else if (avgReturn5d < -1 && laggardRatio5d > 0.35) { flow = 'modest-outflow'; rotationSignal = 'caution'; }
                sectorAnalysis[sector] = { avgChange: avgChange.toFixed(2), avgReturn5d: avgReturn5d.toFixed(2), leaders5d: data.leaders5d, laggards5d: data.laggards5d, leadersToday: data.leadersToday, laggardsToday: data.laggardsToday, total: count, leaderRatio5d: (leaderRatio5d * 100).toFixed(0) + '%', moneyFlow: flow, rotationSignal };
            });
            return sectorAnalysis;
        }

        // ══════════════════════════════════════════════════════════════
        // MARKET STRUCTURE DETECTION: CHoCH (Change of Character) & BOS (Break of Structure)
        // Uses 20-day daily bars to identify swing highs/lows and structural shifts
        // ══════════════════════════════════════════════════════════════
        
        function detectStructure(symbol) {
            const bars = multiDayCache[symbol];
            if (!bars || bars.length < 7) {
                return { structure: 'unknown', structureSignal: 'neutral', structureScore: 0, choch: false, chochType: 'none', bos: false, bosType: 'none', sweep: 'none', fvg: 'none', swingHighs: 0, swingLows: 0, lastSwingHigh: null, lastSwingLow: null, currentPrice: null, basis: 'insufficient-data' };
            }
            
            // Step 1: Identify swing highs and swing lows
            // A swing high = bar whose high is higher than the bar before AND after it
            // A swing low = bar whose low is lower than the bar before AND after it
            const swingHighs = []; // { index, price, timestamp }
            const swingLows = [];
            
            for (let i = 1; i < bars.length - 1; i++) {
                if (bars[i].h > bars[i-1].h && bars[i].h > bars[i+1].h) {
                    swingHighs.push({ index: i, price: bars[i].h, time: bars[i].t });
                }
                if (bars[i].l < bars[i-1].l && bars[i].l < bars[i+1].l) {
                    swingLows.push({ index: i, price: bars[i].l, time: bars[i].t });
                }
            }
            
            if (swingHighs.length < 2 || swingLows.length < 2) {
                return { structure: 'unknown', structureSignal: 'neutral', structureScore: 0, choch: false, chochType: 'none', bos: false, bosType: 'none', sweep: 'none', fvg: 'none', swingHighs: swingHighs.length, swingLows: swingLows.length, lastSwingHigh: null, lastSwingLow: null, currentPrice: null, basis: 'insufficient-swings' };
            }
            
            // Step 2: Determine prevailing structure from the swing sequence
            // Bullish structure: Higher Highs (HH) + Higher Lows (HL)
            // Bearish structure: Lower Highs (LH) + Lower Lows (LL)
            const lastSH = swingHighs[swingHighs.length - 1];
            const prevSH = swingHighs[swingHighs.length - 2];
            const lastSL = swingLows[swingLows.length - 1];
            const prevSL = swingLows[swingLows.length - 2];
            
            const higherHigh = lastSH.price > prevSH.price;
            const higherLow = lastSL.price > prevSL.price;
            const lowerHigh = lastSH.price < prevSH.price;
            const lowerLow = lastSL.price < prevSL.price;
            
            let structure = 'ranging';
            if (higherHigh && higherLow) structure = 'bullish';
            else if (lowerHigh && lowerLow) structure = 'bearish';
            else if (higherHigh && lowerLow) structure = 'ranging'; // Expanding
            else if (lowerHigh && higherLow) structure = 'contracting'; // Compressing
            
            // Step 3: Detect CHoCH (Change of Character)
            // CHoCH = structure was bullish (HH+HL) but just made a LL, or was bearish (LH+LL) but just made a HH
            // We need at least 3 swing points to detect a change
            let choch = false;
            let chochType = null;
            
            if (swingHighs.length >= 3 && swingLows.length >= 3) {
                const prevPrevSH = swingHighs[swingHighs.length - 3];
                const prevPrevSL = swingLows[swingLows.length - 3];
                
                // Was previously bullish (earlier swings were HH+HL)?
                const wasBullish = prevSH.price > prevPrevSH.price && prevSL.price > prevPrevSL.price;
                // Was previously bearish (earlier swings were LH+LL)?
                const wasBearish = prevSH.price < prevPrevSH.price && prevSL.price < prevPrevSL.price;
                
                if (wasBullish && lowerLow) {
                    // Was making HH+HL, now made a LL → bearish CHoCH
                    choch = true;
                    chochType = 'bearish';
                } else if (wasBearish && higherHigh) {
                    // Was making LH+LL, now made a HH → bullish CHoCH
                    choch = true;
                    chochType = 'bullish';
                }
            }
            
            // Step 4: Detect BOS (Break of Structure)
            // BOS = current price confirms the prevailing trend
            // Bullish BOS: price breaks above the most recent swing high (trend continuation)
            // Bearish BOS: price breaks below the most recent swing low (trend continuation)
            let bos = false;
            let bosType = null;
            const currentPrice = bars[bars.length - 1].c;
            
            if (structure === 'bullish' && currentPrice > prevSH.price) {
                bos = true;
                bosType = 'bullish';
            } else if (structure === 'bearish' && currentPrice < prevSL.price) {
                bos = true;
                bosType = 'bearish';
            }
            
            // Step 5: Detect potential liquidity sweep patterns
            // A sweep = price briefly pierced a swing level then reversed
            // Check if the most recent bar's wick went past a swing level but closed back
            let sweepDetected = false;
            let sweepType = null;
            const latestBar = bars[bars.length - 1];
            
            // Check for sweep of recent swing high (wick above, close below)
            if (latestBar.h > lastSH.price && latestBar.c < lastSH.price) {
                sweepDetected = true;
                sweepType = 'high-swept'; // Bearish signal — swept buy-side liquidity
            }
            // Check for sweep of recent swing low (wick below, close above)
            if (latestBar.l < lastSL.price && latestBar.c > lastSL.price) {
                sweepDetected = true;
                sweepType = 'low-swept'; // Bullish signal — swept sell-side liquidity
            }
            
            // Step 6: Detect Fair Value Gaps (FVG) in the last 5 bars
            // FVG = gap between bar[i-1].high and bar[i+1].low (bullish) or bar[i-1].low and bar[i+1].high (bearish)
            let fvg = null;
            for (let i = Math.max(1, bars.length - 4); i < bars.length - 1; i++) {
                // Bullish FVG: bar[i-1].h < bar[i+1].l (gap up — price moved so fast it left an unfilled zone)
                if (bars[i-1].h < bars[i+1].l) {
                    fvg = { type: 'bullish', gapTop: bars[i+1].l, gapBottom: bars[i-1].h, barIndex: i };
                }
                // Bearish FVG: bar[i-1].l > bar[i+1].h (gap down)
                if (bars[i-1].l > bars[i+1].h) {
                    fvg = { type: 'bearish', gapTop: bars[i-1].l, gapBottom: bars[i+1].h, barIndex: i };
                }
            }
            
            // Build composite structure signal for Claude
            let structureSignal = 'neutral';
            let structureScore = 0; // -3 to +3 scale
            
            if (bos && bosType === 'bullish') { structureSignal = 'strong-bullish'; structureScore = 3; }
            else if (bos && bosType === 'bearish') { structureSignal = 'strong-bearish'; structureScore = -3; }
            else if (choch && chochType === 'bullish') { structureSignal = 'reversal-bullish'; structureScore = 2; }
            else if (choch && chochType === 'bearish') { structureSignal = 'reversal-bearish'; structureScore = -2; }
            else if (structure === 'bullish') { structureSignal = 'bullish'; structureScore = 1; }
            else if (structure === 'bearish') { structureSignal = 'bearish'; structureScore = -1; }
            
            // Sweep modifies the signal
            if (sweepDetected && sweepType === 'low-swept') structureScore += 1; // Bullish reversal signal
            if (sweepDetected && sweepType === 'high-swept') structureScore -= 1; // Bearish reversal signal
            
            return {
                structure,
                structureSignal,
                structureScore: Math.max(-3, Math.min(3, structureScore)),
                choch,
                chochType: chochType || 'none',
                bos,
                bosType: bosType || 'none',
                sweep: sweepDetected ? sweepType : 'none',
                fvg: fvg ? fvg.type : 'none',
                swingHighs: swingHighs.length,
                swingLows: swingLows.length,
                lastSwingHigh: lastSH.price,
                lastSwingLow: lastSL.price,
                currentPrice,
                basis: '20-day-structure'
            };
        }


        // BULK SNAPSHOT: Fetch all tickers in ONE call instead of 300 individual calls
        // Uses /v2/snapshot/locale/us/markets/stocks/tickers (same data, same 15min delay)
        let bulkSnapshotCache = {};
        let bulkSnapshotTimestamp = 0;
        
        async function fetchBulkSnapshot(symbols) {
            const now = Date.now();
            // Only refetch if cache is >60 seconds old
            if (now - bulkSnapshotTimestamp < 60000 && Object.keys(bulkSnapshotCache).length > 0) {
                console.log('Using cached bulk snapshot (' + Math.floor((now - bulkSnapshotTimestamp) / 1000) + 's old)');
                return bulkSnapshotCache;
            }
            
            if (!POLYGON_API_KEY) throw new Error('API_KEY_MISSING');
            
            try {
                // Fetch all tickers with a comma-separated list (more efficient than all 10k+)
                // Polygon supports a tickers query param to filter
                const tickerParam = symbols.join(',');
                const response = await fetch(
                    `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${tickerParam}&apiKey=${POLYGON_API_KEY}`
                );
                const data = await response.json();
                
                if (data && data.status === 'OK' && data.tickers && data.tickers.length > 0) {
                    const result = {};
                    data.tickers.forEach(ticker => {
                        const symbol = ticker.ticker;
                        const day = ticker.day;
                        const prevDay = ticker.prevDay;
                        
                        if (!day || !prevDay) return;
                        
                        let currentPrice = day.c || day.l;
                        const prevClose = prevDay.c;
                        if (!currentPrice || currentPrice === 0) currentPrice = prevClose;
                        if (!currentPrice || !prevClose) return;
                        
                        const change = currentPrice - prevClose;
                        const changePercent = (change / prevClose) * 100;
                        
                        result[symbol] = {
                            price: parseFloat(currentPrice),
                            change: parseFloat(change),
                            changePercent: parseFloat(changePercent),
                            timestamp: new Date().toISOString(),
                            isReal: true,
                            note: currentPrice === prevClose ? 'Market closed' : '15min delayed'
                        };
                        
                        // Also update the regular price cache
                        priceCache[symbol] = result[symbol];
                    });
                    
                    bulkSnapshotCache = result;
                    bulkSnapshotTimestamp = now;
                    apiCallsToday++;
                    saveApiUsage();
                    updateApiUsageDisplay();
                    
                    console.log(`✅ Bulk snapshot: ${Object.keys(result).length}/${symbols.length} tickers in 1 API call`);
                    return result;
                }
                
                throw new Error('Bulk snapshot failed: ' + JSON.stringify(data).substring(0, 200));
            } catch (error) {
                console.warn('Bulk snapshot failed, falling back to individual calls:', error.message);
                return null; // Caller should fall back to individual fetches
            }
        }

        // Get buy transactions for the CURRENT open position only.
        // Excludes buys from prior closed positions by finding the most recent full sell
        // and only counting buys after it. This prevents avg cost from blending
        // old closed positions with the current one.
        function getCurrentPositionBuys(symbol) {
            const allTx = portfolio.transactions || [];
            
            // Find the last time this symbol was fully sold (shares went to 0)
            // Walk backwards through transactions tracking running share count
            let lastFullSellIdx = -1;
            let runningShares = 0;
            
            for (let i = 0; i < allTx.length; i++) {
                const t = allTx[i];
                if (t.symbol !== symbol) continue;
                if (t.type === 'BUY') runningShares += t.shares;
                if (t.type === 'SELL') {
                    runningShares -= t.shares;
                    if (runningShares <= 0) {
                        lastFullSellIdx = i;
                        runningShares = 0; // Reset in case of over-sell
                    }
                }
            }
            
            // Only include buys AFTER the last full sell
            return allTx.filter((t, idx) => 
                t.type === 'BUY' && t.symbol === symbol && idx > lastFullSellIdx
            );
        }

        async function getStockPrice(symbol) {
            // Check if API key is set
            if (!POLYGON_API_KEY) {
                throw new Error('API_KEY_MISSING: Polygon API key not configured');
            }
            
            checkAndResetApiCounter();
            
            // Check if we have fresh cached data (within 1 minute)
            const now = Date.now();
            const cacheKey = symbol;
            
            if (priceCache[cacheKey]) {
                const cacheAge = now - new Date(priceCache[cacheKey].timestamp).getTime();
                const maxCacheAge = 1 * 60 * 1000; // 1 minute in milliseconds (frequent updates with unlimited API)
                
                if (cacheAge < maxCacheAge) {
                    console.log(`Using cached data for ${symbol} (${Math.floor(cacheAge / 60000)} min old)`);
                    return priceCache[cacheKey];
                } else {
                    console.log(`Cache expired for ${symbol} (${Math.floor(cacheAge / 60000)} min old), fetching fresh data`);
                    delete priceCache[cacheKey]; // Remove stale cache
                }
            }
            
            // Polygon has unlimited API calls - no limit check needed!
            
            
            try {
                // Use Polygon.io Snapshot endpoint for current trading day
                // Free tier: 15-minute delayed data
                // URL: /v2/snapshot/locale/us/markets/stocks/tickers/{ticker}
                const response = await fetch(`https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${symbol}?apiKey=${POLYGON_API_KEY}`);
                const data = await response.json();
                
                console.log(`[${symbol}] Polygon API response:`, data);
                
                // Polygon snapshot returns: { ticker: {...}, status: "OK" }
                if (data && data.status === 'OK' && data.ticker) {
                    const ticker = data.ticker;
                    const day = ticker.day; // Today's data
                    const prevDay = ticker.prevDay; // Previous day for comparison
                    
                    console.log(`[${symbol}] day data:`, day);
                    console.log(`[${symbol}] prevDay data:`, prevDay);
                    
                    if (!day || !prevDay) {
                        console.error(`[${symbol}] Missing day or prevDay data`);
                        throw new Error('Missing price data in response');
                    }
                    
                    // Calculate change from previous close to current price
                    // If day.c is 0 (market closed), use prevDay.c as current price
                    let currentPrice = day.c || day.l; // Use close if available, otherwise last price
                    const prevClose = prevDay.c;
                    
                    // If currentPrice is still 0 or null, use prevClose (market closed/weekend)
                    if (!currentPrice || currentPrice === 0) {
                        console.log(`[${symbol}] Market closed, using previous close: ${prevClose}`);
                        currentPrice = prevClose;
                    }
                    
                    if (!currentPrice || !prevClose) {
                        console.error(`[${symbol}] Missing price values - currentPrice: ${currentPrice}, prevClose: ${prevClose}`);
                        throw new Error('Missing price values');
                    }
                    
                    const change = currentPrice - prevClose;
                    const changePercent = (change / prevClose) * 100;
                    
                    const priceData = {
                        price: parseFloat(currentPrice),
                        change: parseFloat(change),
                        changePercent: parseFloat(changePercent),
                        timestamp: new Date().toISOString(),
                        isReal: true,
                        note: currentPrice === prevClose ? 'Market closed' : '15min delayed'
                    };
                    
                    // Cache the data
                    priceCache[cacheKey] = priceData;
                    apiCallsToday++;
                    saveApiUsage();
                    updateApiUsageDisplay();
                    
                    return priceData;
                }
                
                // Check for API errors
                if (data && data.error) {
                    throw new Error(`API_ERROR: ${data.error}`);
                }
                
                // Check for status messages
                if (data && data.status === 'ERROR') {
                    throw new Error(`API_ERROR: ${data.message || 'Unknown Polygon error'}`);
                }
                
                throw new Error(`NO_DATA: Unable to fetch data for ${symbol}. Response: ${JSON.stringify(data)}`);
                
            } catch (error) {
                if (error.message.startsWith('API_LIMIT_REACHED') || error.message.startsWith('API_ERROR') || error.message.startsWith('NO_DATA')) {
                    throw error;
                }
                throw new Error(`NETWORK_ERROR: Failed to fetch price for ${symbol}: ${error.message}`);
            }
        }

        // LEARNING SYSTEM: Analyze past performance to improve future decisions
        function analyzePerformanceHistory() {
            const closedTrades = portfolio.closedTrades || [];
            const transactions = portfolio.transactions || [];
            
            if (closedTrades.length === 0) {
                return {
                    hasData: false,
                    message: "No closed trades yet - learning will begin after first completed trade."
                };
            }
            
            // 1. OVERALL PERFORMANCE METRICS
            const wins = closedTrades.filter(t => t.profitLoss > 0);
            const losses = closedTrades.filter(t => t.profitLoss < 0);
            const totalTrades = closedTrades.length;
            const winRate = (wins.length / totalTrades) * 100;
            
            const avgWinReturn = wins.length > 0 
                ? wins.reduce((sum, t) => sum + t.returnPercent, 0) / wins.length 
                : 0;
            const avgLossReturn = losses.length > 0 
                ? losses.reduce((sum, t) => sum + t.returnPercent, 0) / losses.length 
                : 0;
            
            const avgWinHoldTime = wins.length > 0
                ? wins.reduce((sum, t) => sum + t.holdTime, 0) / wins.length / (1000 * 60 * 60 * 24)
                : 0;
            const avgLossHoldTime = losses.length > 0
                ? losses.reduce((sum, t) => sum + t.holdTime, 0) / losses.length / (1000 * 60 * 60 * 24)
                : 0;
            
            // 2. STOCK-SPECIFIC PERFORMANCE WITH CONTEXT
            const stockPerformance = {};
            closedTrades.forEach(trade => {
                if (!stockPerformance[trade.symbol]) {
                    stockPerformance[trade.symbol] = {
                        wins: 0,
                        losses: 0,
                        totalReturn: 0,
                        trades: [],
                        entryPrices: [],
                        exitPrices: []
                    };
                }
                
                const perf = stockPerformance[trade.symbol];
                if (trade.profitLoss > 0) {
                    perf.wins++;
                } else {
                    perf.losses++;
                }
                perf.totalReturn += trade.returnPercent;
                perf.trades.push(trade);
                perf.entryPrices.push(trade.buyPrice);
                perf.exitPrices.push(trade.sellPrice);
            });
            
            // Calculate patterns for each stock
            Object.keys(stockPerformance).forEach(symbol => {
                const perf = stockPerformance[symbol];
                perf.avgReturn = perf.totalReturn / perf.trades.length;
                perf.winRate = (perf.wins / perf.trades.length) * 100;
                perf.avgEntryPrice = perf.entryPrices.reduce((a, b) => a + b, 0) / perf.entryPrices.length;
                perf.avgExitPrice = perf.exitPrices.reduce((a, b) => a + b, 0) / perf.exitPrices.length;
                
                // Identify patterns
                perf.patterns = [];
                if (perf.trades.length >= 2) {
                    // Check if consistently bought high
                    const priceRange = Math.max(...perf.entryPrices) - Math.min(...perf.entryPrices);
                    const avgToMax = (Math.max(...perf.entryPrices) - perf.avgEntryPrice) / Math.max(...perf.entryPrices) * 100;
                    if (avgToMax < 10 && perf.losses > perf.wins) {
                        perf.patterns.push("Entered near highs - wait for better entry points");
                    }
                    
                    // Check hold time pattern
                    const avgHoldTime = perf.trades.reduce((sum, t) => sum + t.holdTime, 0) / perf.trades.length / (1000 * 60 * 60 * 24);
                    if (avgHoldTime < 3 && perf.losses > perf.wins) {
                        perf.patterns.push("Sold too quickly - consider holding longer");
                    }
                }
            });
            
            // 3. SECTOR PERFORMANCE WITH CONTEXT
            const sectorPerformance = {};
            closedTrades.forEach(trade => {
                const sector = stockSectors[trade.symbol] || 'Unknown';
                if (!sectorPerformance[sector]) {
                    sectorPerformance[sector] = {
                        wins: 0,
                        losses: 0,
                        totalReturn: 0,
                        count: 0,
                        trades: []
                    };
                }
                
                const perf = sectorPerformance[sector];
                if (trade.profitLoss > 0) {
                    perf.wins++;
                } else {
                    perf.losses++;
                }
                perf.totalReturn += trade.returnPercent;
                perf.count++;
                perf.trades.push(trade);
            });
            
            // Calculate sector insights
            Object.keys(sectorPerformance).forEach(sector => {
                const perf = sectorPerformance[sector];
                perf.avgReturn = perf.totalReturn / perf.count;
                perf.winRate = (perf.wins / perf.count) * 100;
                
                // Identify sector patterns
                perf.insight = "";
                if (perf.winRate >= 70) {
                    perf.insight = "Strong sector for you - continue focusing here";
                } else if (perf.winRate >= 50) {
                    perf.insight = "Decent sector - be selective";
                } else if (perf.count >= 3) {
                    perf.insight = "Underperforming sector - analyze what's not working";
                }
            });
            
            // 4. BEHAVIORAL PATTERNS
            const behaviorPatterns = [];
            
            // Hold time pattern
            if (wins.length >= 3 && losses.length >= 3) {
                const holdTimeDiff = avgWinHoldTime - avgLossHoldTime;
                if (holdTimeDiff > 3) {
                    behaviorPatterns.push({
                        pattern: "Winners held much longer than losers",
                        insight: `Winners: ${avgWinHoldTime.toFixed(1)} days vs Losers: ${avgLossHoldTime.toFixed(1)} days - Patience is profitable for you`,
                        action: "Give your trades more time to work before selling"
                    });
                } else if (holdTimeDiff < -3) {
                    behaviorPatterns.push({
                        pattern: "Losers held longer than winners",
                        insight: `Losers: ${avgLossHoldTime.toFixed(1)} days vs Winners: ${avgWinHoldTime.toFixed(1)} days - You hold onto losses too long`,
                        action: "Cut losses faster, let winners run"
                    });
                }
            }
            
            // Win size vs loss size
            const avgWinSize = Math.abs(avgWinReturn);
            const avgLossSize = Math.abs(avgLossReturn);
            if (wins.length >= 2 && losses.length >= 2) {
                const winLossRatio = avgWinSize / avgLossSize;
                if (winLossRatio < 1.2) {
                    behaviorPatterns.push({
                        pattern: "Small winners, big losers",
                        insight: `Avg win: +${avgWinSize.toFixed(1)}% vs Avg loss: ${avgLossReturn.toFixed(1)}% - Cutting winners too early`,
                        action: "Let winners run further, cut losses tighter"
                    });
                } else if (winLossRatio > 2) {
                    behaviorPatterns.push({
                        pattern: "Big winners, small losses",
                        insight: `Avg win: +${avgWinSize.toFixed(1)}% vs Avg loss: ${avgLossReturn.toFixed(1)}% - Good risk management`,
                        action: "Your risk/reward approach is working - maintain it"
                    });
                }
            }
            
            // 5. RECENT PERFORMANCE TREND
            const recentTrades = closedTrades.slice(-10);
            const recentWins = recentTrades.filter(t => t.profitLoss > 0).length;
            const recentWinRate = recentTrades.length > 0 ? (recentWins / recentTrades.length) * 100 : 0;
            
            const trendAnalysis = {
                improving: recentWinRate > winRate + 10,
                declining: recentWinRate < winRate - 10,
                stable: Math.abs(recentWinRate - winRate) <= 10
            };
            
            return {
                hasData: true,
                overall: {
                    totalTrades,
                    wins: wins.length,
                    losses: losses.length,
                    winRate,
                    avgWinReturn,
                    avgLossReturn,
                    avgWinHoldTime,
                    avgLossHoldTime
                },
                stockPerformance,
                sectorPerformance,
                behaviorPatterns,
                recent: {
                    trades: recentTrades.length,
                    wins: recentWins,
                    winRate: recentWinRate,
                    trend: trendAnalysis
                }
            };
        }

        // PHASE 1 LEARNING: Analyze conviction accuracy
        function analyzeConvictionAccuracy() {
            const closedTrades = portfolio.closedTrades || [];
            const tradesWithConviction = closedTrades.filter(t => t.entryConviction);
            
            if (tradesWithConviction.length < 5) {
                return { hasData: false, message: "Need 5+ trades to analyze conviction accuracy" };
            }
            
            // Group by conviction level
            const convictionGroups = {
                '9-10': tradesWithConviction.filter(t => t.entryConviction >= 9),
                '7-8': tradesWithConviction.filter(t => t.entryConviction >= 7 && t.entryConviction < 9),
                '5-6': tradesWithConviction.filter(t => t.entryConviction >= 5 && t.entryConviction < 7)
            };
            
            const analysis = {};
            Object.keys(convictionGroups).forEach(level => {
                const trades = convictionGroups[level];
                if (trades.length > 0) {
                    const wins = trades.filter(t => t.profitLoss > 0).length;
                    const winRate = (wins / trades.length) * 100;
                    const avgReturn = trades.reduce((sum, t) => sum + t.returnPercent, 0) / trades.length;
                    
                    analysis[level] = {
                        count: trades.length,
                        winRate: winRate,
                        avgReturn: avgReturn,
                        calibration: winRate >= parseInt(level.split('-')[0]) * 10 ? 'well-calibrated' : 'overconfident'
                    };
                }
            });
            
            return { hasData: true, analysis };
        }
        
        // PHASE 1 LEARNING: Analyze technical indicator accuracy
        function analyzeTechnicalAccuracy() {
            const closedTrades = portfolio.closedTrades || [];
            const tradesWithTechnicals = closedTrades.filter(t => t.entryTechnicals && Object.keys(t.entryTechnicals).length > 0);
            
            if (tradesWithTechnicals.length < 5) {
                return { hasData: false };
            }
            
            // Analyze momentum score
            const momentumHigh = tradesWithTechnicals.filter(t => t.entryTechnicals.momentumScore != null && t.entryTechnicals.momentumScore >= 7);
            const momentumLow = tradesWithTechnicals.filter(t => t.entryTechnicals.momentumScore != null && t.entryTechnicals.momentumScore < 7);

            // Analyze rsScore
            const rsHigh = tradesWithTechnicals.filter(t => t.entryTechnicals.rsScore != null && t.entryTechnicals.rsScore >= 70);
            const rsLow = tradesWithTechnicals.filter(t => t.entryTechnicals.rsScore != null && t.entryTechnicals.rsScore < 70);
            
            // Analyze sector rotation
            const sectorInflow = tradesWithTechnicals.filter(t => t.entryTechnicals.sectorRotation === 'accumulate' || t.entryTechnicals.sectorRotation === 'favorable');
            const sectorOutflow = tradesWithTechnicals.filter(t => t.entryTechnicals.sectorRotation === 'avoid' || t.entryTechnicals.sectorRotation === 'caution');
            
            const calcStats = (trades) => {
                if (trades.length === 0) return null;
                const wins = trades.filter(t => t.profitLoss > 0).length;
                return {
                    count: trades.length,
                    winRate: (wins / trades.length) * 100,
                    avgReturn: trades.reduce((sum, t) => sum + t.returnPercent, 0) / trades.length
                };
            };
            
            return {
                hasData: true,
                momentum: {
                    high: calcStats(momentumHigh),
                    low: calcStats(momentumLow)
                },
                relativeStrength: {
                    high: calcStats(rsHigh),
                    low: calcStats(rsLow)
                },
                sectorRotation: {
                    inflow: calcStats(sectorInflow),
                    outflow: calcStats(sectorOutflow)
                }
            };
        }
        
        // PHASE 1 LEARNING: Analyze exit timing
        function analyzeExitTiming() {
            const closedTrades = portfolio.closedTrades || [];
            
            if (closedTrades.length < 3) {
                return { hasData: false };
            }
            
            // Group by exit reason
            const byReason = {
                profit_target: closedTrades.filter(t => t.exitReason === 'profit_target'),
                stop_loss: closedTrades.filter(t => t.exitReason === 'stop_loss'),
                catalyst_failure: closedTrades.filter(t => t.exitReason === 'catalyst_failure'),
                opportunity_cost: closedTrades.filter(t => t.exitReason === 'opportunity_cost'),
                manual: closedTrades.filter(t => t.exitReason === 'manual')
            };
            
            const analysis = {};
            Object.keys(byReason).forEach(reason => {
                const trades = byReason[reason];
                if (trades.length > 0) {
                    const avgReturn = trades.reduce((sum, t) => sum + t.returnPercent, 0) / trades.length;
                    const wins = trades.filter(t => t.profitLoss > 0).length;
                    
                    analysis[reason] = {
                        count: trades.length,
                        avgReturn: avgReturn,
                        winRate: (wins / trades.length) * 100
                    };
                }
            });
            
            // Analyze if selling winners too early
            const winners = closedTrades.filter(t => t.profitLoss > 0);
            const avgWinnerReturn = winners.length > 0 
                ? winners.reduce((sum, t) => sum + t.returnPercent, 0) / winners.length 
                : 0;
            
            return {
                hasData: true,
                byReason: analysis,
                avgWinnerReturn: avgWinnerReturn,
                profitTargetCount: byReason.profit_target.length,
                insight: avgWinnerReturn < 15 && byReason.profit_target.length > 2 
                    ? "Consider holding winners longer - average win is only " + avgWinnerReturn.toFixed(1) + "%"
                    : null
            };
        }

        // Format performance insights for Claude's prompt - CONTEXTUAL, NOT RIGID
        function formatPerformanceInsights() {
            const analysis = analyzePerformanceHistory();
            
            if (!analysis.hasData) {
                return `\n📊 LEARNING STATUS: ${analysis.message}\n`;
            }
            
            const { overall, stockPerformance, sectorPerformance, behaviorPatterns, recent } = analysis;
            
            let insights = `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📚 HISTORICAL CONTEXT - Learn from these insights, don't follow blindly
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 YOUR PERFORMANCE SUMMARY:
• Total Trades: ${overall.totalTrades}
• Record: ${overall.wins}W - ${overall.losses}L (${overall.winRate.toFixed(1)}% win rate)
• Average Winner: +${overall.avgWinReturn.toFixed(2)}% over ${overall.avgWinHoldTime.toFixed(1)} days
• Average Loser: ${overall.avgLossReturn.toFixed(2)}% over ${overall.avgLossHoldTime.toFixed(1)} days

📈 RECENT TREND (Last ${recent.trades} trades):
• Record: ${recent.wins}W - ${recent.trades - recent.wins}L (${recent.winRate.toFixed(1)}% win rate)
`;
            
            if (recent.trend.improving) {
                insights += `• 🔥 IMPROVING! Recent win rate (${recent.winRate.toFixed(1)}%) > overall (${overall.winRate.toFixed(1)}%)\n`;
                insights += `• Keep doing what you're doing - your strategy is working better\n`;
            } else if (recent.trend.declining) {
                insights += `• ⚠️ DECLINING! Recent win rate (${recent.winRate.toFixed(1)}%) < overall (${overall.winRate.toFixed(1)}%)\n`;
                insights += `• Review recent decisions - something has changed\n`;
            }
            insights += '\n';

            // Stock-specific context (not avoid/favor lists!)
            const stocksWithMultipleTrades = Object.entries(stockPerformance)
                .filter(([_, perf]) => perf.trades.length >= 2)
                .sort((a, b) => b[1].trades.length - a[1].trades.length)
                .slice(0, 5);
            
            if (stocksWithMultipleTrades.length > 0) {
                insights += `📊 STOCK PERFORMANCE CONTEXT (Use this to inform decisions, not as rules):\n\n`;
                stocksWithMultipleTrades.forEach(([symbol, perf]) => {
                    insights += `${symbol}: ${perf.wins}-${perf.losses} record (${perf.avgReturn.toFixed(1)}% avg return)\n`;
                    insights += `  • Entry prices: $${Math.min(...perf.entryPrices).toFixed(2)} - $${Math.max(...perf.entryPrices).toFixed(2)} (avg: $${perf.avgEntryPrice.toFixed(2)})\n`;
                    insights += `  • Exit prices: $${Math.min(...perf.exitPrices).toFixed(2)} - $${Math.max(...perf.exitPrices).toFixed(2)} (avg: $${perf.avgExitPrice.toFixed(2)})\n`;
                    
                    if (perf.patterns.length > 0) {
                        perf.patterns.forEach(pattern => {
                            insights += `  • Pattern: ${pattern}\n`;
                        });
                    }
                    
                    // Context, not commands
                    if (perf.losses > perf.wins) {
                        insights += `  → Context: This stock hasn't worked well for you, but consider WHY (timing? conditions?)\n`;
                        insights += `  → If conditions are different now (better price, better setup), it might work this time\n`;
                    } else if (perf.wins > perf.losses) {
                        insights += `  → Context: This stock has worked well for you in the past\n`;
                        insights += `  → If setup is similar to previous wins, it could work again\n`;
                    }
                    insights += '\n';
                });
            }
            
            // Sector insights
            const sortedSectors = Object.entries(sectorPerformance)
                .filter(([_, perf]) => perf.count >= 2)
                .sort((a, b) => b[1].avgReturn - a[1].avgReturn);
            
            if (sortedSectors.length > 0) {
                insights += `🎯 SECTOR PERFORMANCE INSIGHTS:\n\n`;
                sortedSectors.forEach(([sector, perf]) => {
                    const icon = perf.avgReturn > 5 ? '✅' : perf.avgReturn > 0 ? '➖' : '⚠️';
                    insights += `${icon} ${sector}: ${perf.wins}-${perf.losses} (${perf.winRate.toFixed(0)}% win rate, ${perf.avgReturn >= 0 ? '+' : ''}${perf.avgReturn.toFixed(1)}% avg)\n`;
                    if (perf.insight) {
                        insights += `   ${perf.insight}\n`;
                    }
                });
                insights += '\n';
            }
            
            // Behavioral patterns - the most important insights!
            if (behaviorPatterns.length > 0) {
                insights += `🔍 YOUR TRADING BEHAVIOR PATTERNS:\n\n`;
                behaviorPatterns.forEach(bp => {
                    insights += `Pattern: ${bp.pattern}\n`;
                    insights += `  • ${bp.insight}\n`;
                    insights += `  • Action: ${bp.action}\n\n`;
                });
            }
            
            // PHASE 1 LEARNING: Add conviction, technical, and exit timing insights
            const convictionAnalysis = analyzeConvictionAccuracy();
            const technicalAnalysis = analyzeTechnicalAccuracy();
            const exitAnalysis = analyzeExitTiming();
            
            // Conviction Accuracy
            if (convictionAnalysis.hasData) {
                insights += `🎯 CONVICTION ACCURACY (Phase 1 Learning):\n\n`;
                Object.keys(convictionAnalysis.analysis).forEach(level => {
                    const data = convictionAnalysis.analysis[level];
                    insights += `${level}/10 Convictions (${data.count} trades):\n`;
                    insights += `  • Win Rate: ${data.winRate.toFixed(1)}% | Avg Return: ${data.avgReturn >= 0 ? '+' : ''}${data.avgReturn.toFixed(1)}%\n`;
                    insights += `  • Calibration: ${data.calibration}\n`;
                    if (data.calibration === 'overconfident') {
                        insights += `  → Your ${level} convictions are underperforming - be more selective or size smaller\n`;
                    } else {
                        insights += `  → Your ${level} convictions are well-calibrated - trust this confidence level\n`;
                    }
                    insights += '\n';
                });
            }
            
            // Technical Indicator Accuracy
            if (technicalAnalysis.hasData) {
                insights += `📊 TECHNICAL INDICATOR ACCURACY (Phase 1 Learning):\n\n`;
                
                if (technicalAnalysis.momentum.high && technicalAnalysis.momentum.low) {
                    insights += `Momentum Score:\n`;
                    insights += `  • High (7+): ${technicalAnalysis.momentum.high.winRate.toFixed(1)}% win rate, ${technicalAnalysis.momentum.high.avgReturn >= 0 ? '+' : ''}${technicalAnalysis.momentum.high.avgReturn.toFixed(1)}% avg (${technicalAnalysis.momentum.high.count} trades)\n`;
                    insights += `  • Low (<7): ${technicalAnalysis.momentum.low.winRate.toFixed(1)}% win rate, ${technicalAnalysis.momentum.low.avgReturn >= 0 ? '+' : ''}${technicalAnalysis.momentum.low.avgReturn.toFixed(1)}% avg (${technicalAnalysis.momentum.low.count} trades)\n`;
                    const diff = technicalAnalysis.momentum.high.winRate - technicalAnalysis.momentum.low.winRate;
                    if (diff > 10) {
                        insights += `  → High momentum IS predictive (+${diff.toFixed(0)}% win rate) - weight it heavily!\n`;
                    } else {
                        insights += `  → Momentum score has minimal impact - don't overweight it\n`;
                    }
                    insights += '\n';
                }
                
                if (technicalAnalysis.relativeStrength.high && technicalAnalysis.relativeStrength.low) {
                    insights += `Relative Strength (rsScore):\n`;
                    insights += `  • High (70+): ${technicalAnalysis.relativeStrength.high.winRate.toFixed(1)}% win rate (${technicalAnalysis.relativeStrength.high.count} trades)\n`;
                    insights += `  • Low (<70): ${technicalAnalysis.relativeStrength.low.winRate.toFixed(1)}% win rate (${technicalAnalysis.relativeStrength.low.count} trades)\n`;
                    const diff = technicalAnalysis.relativeStrength.high.winRate - technicalAnalysis.relativeStrength.low.winRate;
                    if (diff > 10) {
                        insights += `  → High rsScore IS predictive - confirms strong setups\n`;
                    }
                    insights += '\n';
                }
                
                if (technicalAnalysis.sectorRotation.inflow && technicalAnalysis.sectorRotation.outflow) {
                    insights += `Sector Rotation:\n`;
                    insights += `  • Inflow: ${technicalAnalysis.sectorRotation.inflow.winRate.toFixed(1)}% win rate (${technicalAnalysis.sectorRotation.inflow.count} trades)\n`;
                    insights += `  • Outflow: ${technicalAnalysis.sectorRotation.outflow.winRate.toFixed(1)}% win rate (${technicalAnalysis.sectorRotation.outflow.count} trades)\n`;
                    const diff = technicalAnalysis.sectorRotation.inflow.winRate - technicalAnalysis.sectorRotation.outflow.winRate;
                    if (diff > 10) {
                        insights += `  → Sector rotation IS predictive - avoid 'outflow' sectors\n`;
                    }
                    insights += '\n';
                }
            }
            
            // Exit Timing Analysis
            if (exitAnalysis.hasData) {
                insights += `⏰ EXIT TIMING ANALYSIS (Phase 1 Learning):\n\n`;
                
                if (exitAnalysis.insight) {
                    insights += `⚠️ ${exitAnalysis.insight}\n\n`;
                }
                
                insights += `Exit Reasons:\n`;
                Object.keys(exitAnalysis.byReason).forEach(reason => {
                    const data = exitAnalysis.byReason[reason];
                    const reasonLabel = reason.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
                    insights += `  • ${reasonLabel}: ${data.count} exits, ${data.avgReturn >= 0 ? '+' : ''}${data.avgReturn.toFixed(1)}% avg\n`;
                });
                
                if (exitAnalysis.profitTargetCount >= 3 && exitAnalysis.avgWinnerReturn < 20) {
                    insights += `\n  → You're taking profits quickly (avg winner: ${exitAnalysis.avgWinnerReturn.toFixed(1)}%)\n`;
                    insights += `  → Consider: Let winners run longer when catalyst is still strong\n`;
                } else if (exitAnalysis.avgWinnerReturn > 30) {
                    insights += `\n  → Great! You're holding winners (avg: ${exitAnalysis.avgWinnerReturn.toFixed(1)}%)\n`;
                }
                insights += '\n';
            }
            
            // POST-EXIT TRACKING INSIGHTS
            const trackedExits = (portfolio.closedTrades || []).filter(t => t.tracking && (t.tracking.priceAfter1Week !== null || t.tracking.priceAfter1Month !== null));
            if (trackedExits.length >= 3) {
                const earlyExits = trackedExits.filter(t => {
                    const weekReturn = t.tracking.priceAfter1Week ? ((t.tracking.priceAfter1Week - t.sellPrice) / t.sellPrice * 100) : null;
                    return weekReturn !== null && weekReturn > 5; // Stock went up 5%+ after you sold
                });
                const goodExits = trackedExits.filter(t => {
                    const weekReturn = t.tracking.priceAfter1Week ? ((t.tracking.priceAfter1Week - t.sellPrice) / t.sellPrice * 100) : null;
                    return weekReturn !== null && weekReturn < -2; // Stock dropped after you sold
                });
                
                insights += `📊 POST-EXIT TRACKING (Did you sell at the right time?):\n`;
                insights += `  Tracked exits: ${trackedExits.length}\n`;
                if (earlyExits.length > 0) {
                    insights += `  ⚠️ Sold too early ${earlyExits.length}x — stock rose 5%+ within a week after exit\n`;
                    earlyExits.slice(0, 3).forEach(t => {
                        insights += `    • ${t.symbol}: Sold $${t.sellPrice.toFixed(2)} → $${t.tracking.priceAfter1Week.toFixed(2)} one week later (${t.tracking.weekReturnVsSell})\n`;
                    });
                }
                if (goodExits.length > 0) {
                    insights += `  ✅ Good exits ${goodExits.length}x — stock fell 2%+ after you sold\n`;
                }
                const earlyRate = (earlyExits.length / trackedExits.length * 100).toFixed(0);
                if (parseInt(earlyRate) > 50) {
                    insights += `  → Pattern: You sell too early ${earlyRate}% of the time. Consider holding longer or using trailing stops.\n`;
                } else if (parseInt(earlyRate) < 25) {
                    insights += `  → Pattern: Your exit timing is good — you rarely leave money on the table.\n`;
                }
                insights += '\n';
            }
            
            insights += `💡 HOW TO USE THIS DATA:
• This is CONTEXT, not commandments - markets change, conditions evolve
• If a stock failed before due to poor entry timing, a better entry now might work
• If you tend to sell winners too early, consciously hold longer this time
• If a sector is underperforming, analyze WHY before avoiding it entirely
• Learn from patterns in your BEHAVIOR (hold times, entry timing) more than from specific stocks
• Your goal: Understand what makes YOUR trades succeed or fail, then apply those lessons

REMEMBER: Past performance helps inform decisions, but always evaluate current conditions!

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
            
            return insights;
        }

        // POST-EXIT TRACKING: Check if sold stocks did better/worse after we exited
        // This helps calibrate exit timing - "did I sell too early?"
        async function updatePostExitTracking() {
            const closedTrades = portfolio.closedTrades || [];
            if (closedTrades.length === 0) return;
            
            const now = Date.now();
            const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;
            const ONE_MONTH = 30 * 24 * 60 * 60 * 1000;
            let updated = false;
            
            for (const trade of closedTrades) {
                if (!trade.tracking) {
                    trade.tracking = { priceAfter1Week: null, priceAfter1Month: null, tracked: false };
                }
                
                const sellTime = new Date(trade.sellDate).getTime();
                if (isNaN(sellTime)) continue; // Skip trades with invalid dates
                const timeSinceSell = now - sellTime;

                // Check 1-week tracking (after 7+ days)
                if (trade.tracking.priceAfter1Week === null && timeSinceSell >= ONE_WEEK) {
                    try {
                        const priceData = await getStockPrice(trade.symbol);
                        if (priceData && priceData.price > 0 && trade.sellPrice > 0) {
                            trade.tracking.priceAfter1Week = priceData.price;
                            trade.tracking.weekReturnVsSell = ((priceData.price - trade.sellPrice) / trade.sellPrice * 100).toFixed(2) + '%';
                            updated = true;
                            console.log(`📊 Post-exit 1wk: ${trade.symbol} sold at $${trade.sellPrice.toFixed(2)}, now $${priceData.price.toFixed(2)} (${trade.tracking.weekReturnVsSell})`);
                        }
                    } catch (e) { /* Skip - will retry next run */ }
                }
                
                // Check 1-month tracking (after 30+ days)
                if (trade.tracking.priceAfter1Month === null && timeSinceSell >= ONE_MONTH) {
                    try {
                        const priceData = await getStockPrice(trade.symbol);
                        if (priceData && priceData.price > 0 && trade.sellPrice > 0) {
                            trade.tracking.priceAfter1Month = priceData.price;
                            trade.tracking.monthReturnVsSell = ((priceData.price - trade.sellPrice) / trade.sellPrice * 100).toFixed(2) + '%';
                            trade.tracking.tracked = true;
                            updated = true;
                            console.log(`📊 Post-exit 1mo: ${trade.symbol} sold at $${trade.sellPrice.toFixed(2)}, now $${priceData.price.toFixed(2)} (${trade.tracking.monthReturnVsSell})`);
                        }
                    } catch (e) { /* Skip - will retry next run */ }
                }
                
                // Mark as fully tracked if both filled
                if (trade.tracking.priceAfter1Week !== null && trade.tracking.priceAfter1Month !== null) {
                    trade.tracking.tracked = true;
                }
            }
            
            if (updated) {
                console.log('✅ Post-exit tracking updated');
                // Portfolio will be saved by the normal save flow after analysis
            }
        }

        // Smart Stock Screener - Samples across ALL sectors every time
        async function screenStocks() {
            // With unlimited API calls, we can sample from all sectors to find the best opportunities
            // This gives APEX a comprehensive view of the entire market
            
            const stockLists = {
                techAI: ['NVDA', 'AVGO', 'GOOGL', 'MSFT', 'META', 'ORCL', 'CRM', 'ADBE', 'NOW', 'INTU',
                         'PLTR', 'SNOW', 'AI', 'BBAI', 'SOUN', 'PATH', 'S', 'HUBS', 'ZM', 'DOCU',
                         'TEAM', 'WDAY', 'VEEV', 'ESTC', 'DDOG', 'NET', 'MDB', 'CRWD', 'PANW', 'ZS',
                         'OKTA', 'CFLT', 'GTLB', 'FROG', 'BILL', 'DOCN', 'ZI', 'MNDY', 'PCOR', 'APP'],
                
                techHardware: ['AAPL', 'QCOM', 'INTC', 'MU', 'ARM', 'DELL', 'HPQ', 'AMAT', 'LRCX', 'MRVL',
                               'AMD', 'TXN', 'ADI', 'NXPI', 'KLAC', 'ASML', 'TSM', 'SNPS', 'CDNS', 'ON',
                               'MPWR', 'SWKS', 'QRVO', 'ENTG', 'FORM', 'MKSI', 'COHR', 'IPGP', 'LITE', 'AMBA',
                               'SLAB', 'CRUS', 'SYNA', 'MCHP', 'SMCI', 'WDC', 'STX', 'PSTG', 'NTAP', 'CHKP'],
                
                evAuto: ['TSLA', 'RIVN', 'LCID', 'NIO', 'XPEV', 'LI', 'F', 'GM', 'STLA', 'TM',
                         'HMC', 'RACE', 'VWAGY', 'PSNY', 'NSANY', 'APTV', 'MBGYY', 'POAHY', 'FUJHY', 'ALV',
                         'WKHS', 'BLNK', 'CHPT', 'EVGO', 'PAG', 'WOLF', 'TPIC', 'QS', 'LAZR', 'OUST',
                         'PTRA', 'HYLN', 'GEV', 'JZXN', 'VRM', 'SFT', 'CVNA', 'KMX', 'AN', 'LAD'],
                
                finance: ['JPM', 'BAC', 'WFC', 'GS', 'MS', 'C', 'BLK', 'SCHW', 'V', 'MA',
                          'PYPL', 'GPN', 'AXP', 'FIS', 'COF', 'ALLY', 'USB', 'PNC', 'TFC', 'RF',
                          'KEY', 'FITB', 'MTB', 'CFG', 'HBAN', 'STT', 'BK', 'NTRS', 'STATE', 'CMA',
                          'ZION', 'FHN', 'WRB', 'CB', 'TRV', 'ALL', 'PGR', 'AIG', 'MET', 'PRU'],
                
                growth: ['DKNG', 'RBLX', 'U', 'PINS', 'SNAP', 'SPOT', 'ABNB', 'LYFT', 'DASH', 'UBER',
                         'CPNG', 'BKNG', 'EXPE', 'TCOM', 'TRIP', 'PTON', 'LULU', 'ETSY', 'W', 'CHWY',
                         'COIN', 'OPEN', 'COMP', 'RKT', 'CWAN', 'DUOL', 'BROS', 'CAVA', 'HOOD', 'AFRM',
                         'UPST', 'LC', 'NU', 'SOFI', 'NFLX', 'ROKU', 'WBD', 'FOXA', 'CMCSA', 'T'],
                
                healthcare: ['JNJ', 'UNH', 'LLY', 'ABBV', 'PFE', 'MRNA', 'VRTX', 'REGN', 'BMY', 'GILD',
                             'AMGN', 'CVS', 'CI', 'HUM', 'ISRG', 'TMO', 'DHR', 'ABT', 'SYK', 'BSX',
                             'MDT', 'BDX', 'BAX', 'ZBH', 'HCA', 'DVA', 'CANO', 'IONQ', 'EXAS', 'ILMN',
                             'BIIB', 'ALNY', 'INCY', 'NBIX', 'UTHR', 'JAZZ', 'SRPT', 'BMRN', 'IONS', 'RGEN'],
                
                consumer: ['AMZN', 'WMT', 'COST', 'TGT', 'HD', 'LOW', 'SBUX', 'MCD', 'CMG', 'YUM',
                           'NKE', 'RH', 'DECK', 'CROX', 'ULTA', 'ELF', 'LEVI', 'UAA', 'DIS', 'GOOG',
                           'KO', 'PEP', 'PM', 'MO', 'BUD', 'TAP', 'STZ', 'MNST', 'CELH', 'KDP',
                           'ORLY', 'AZO', 'AAP', 'GPC', 'TSCO', 'DG', 'DLTR', 'ROST', 'TJX', 'BBY'],
                
                energy: ['XOM', 'CVX', 'COP', 'SLB', 'EOG', 'OXY', 'MPC', 'PSX', 'VLO', 'TRGP',
                         'DVN', 'FANG', 'WMB', 'APA', 'HAL', 'BKR', 'NOV', 'FTI', 'NEE', 'DUK',
                         'SO', 'D', 'AEP', 'EXC', 'ENPH', 'SEDG', 'RUN', 'NOVA', 'FSLR', 'PLUG',
                         'PBF', 'DK', 'CTRA', 'OVV', 'PR', 'SM', 'MGY', 'MTDR', 'CHRD', 'OKE'],
                
                // NEW SECTORS ADDED:
                
                industrials: ['CAT', 'DE', 'CMI', 'EMR', 'ETN', 'PH', 'ROK', 'AME', 'DOV', 'ITW',
                              'GE', 'HON', 'MMM', 'DHI', 'LEN', 'NVR', 'PHM', 'TOL', 'BLD', 'BLDR',
                              'UNP', 'NSC', 'CSX', 'UPS', 'FDX', 'CHRW', 'JBHT', 'KNX', 'ODFL', 'XPO',
                              'CARR', 'VLTO', 'IR', 'WM', 'RSG', 'PCAR', 'PWR', 'JCI', 'AOS', 'ROP'],
                
                realEstate: ['AMT', 'PLD', 'CCI', 'EQIX', 'PSA', 'DLR', 'WELL', 'O', 'VICI', 'SPG',
                             'AVB', 'EQR', 'MAA', 'UDR', 'CPT', 'ESS', 'AIV', 'ELS', 'SUI', 'NXRT',
                             'VTR', 'STWD', 'DOC', 'OHI', 'SBRA', 'LTC', 'HR', 'MPW', 'NHI', 'CTRE',
                             'IRM', 'CUBE', 'LSI', 'NSA', 'REXR', 'PSB', 'TRNO', 'SELF', 'STOR', 'SAFE'],
                
                materials: ['NEM', 'FCX', 'GOLD', 'AU', 'AEM', 'WPM', 'FNV', 'RGLD', 'KGC', 'HL',
                            'NUE', 'STLD', 'RS', 'CLF', 'AA', 'MT', 'TX', 'CMC', 'NB', 'ATI',
                            'DOW', 'LYB', 'EMN', 'CE', 'APD', 'LIN', 'ECL', 'ALB', 'SQM', 'LAC',
                            'MP', 'DD', 'PPG', 'SHW', 'RPM', 'AXTA', 'FUL', 'NEU', 'USAR', 'UUUU'],
                
                defense: ['LMT', 'RTX', 'NOC', 'GD', 'BA', 'LHX', 'HII', 'TXT', 'HWM', 'AXON',
                          'KTOS', 'AVAV', 'AIR', 'SAIC', 'LDOS', 'CACI', 'BAH', 'BWXT', 'WWD', 'MOG.A',
                          'TDG', 'HEI', 'ROCK', 'IMOS', 'CW', 'AIN', 'GMS', 'MLI', 'B', 'RUSHA',
                          'AMSWA', 'PLXS', 'NPAB', 'VECO', 'POWI', 'VICR', 'MYRG', 'DY', 'APOG', 'HSII']
            };
            
            // Sample stocks from EVERY sector for comprehensive cross-sector analysis
            // With unlimited API calls, we can analyze many more stocks
            const stocksPerSector = 25; // 25 stocks from each of 12 sectors = 300 total
            const selectedStocks = [];
            
            for (const [sector, stocks] of Object.entries(stockLists)) {
                // Take first N stocks from each sector
                const sectorSample = stocks.slice(0, Math.min(stocksPerSector, stocks.length));
                selectedStocks.push(...sectorSample);
            }
            
            console.log(`🔍 COMPREHENSIVE Cross-Sector Analysis`);
            console.log(`📊 Analyzing ${selectedStocks.length} stocks across ${Object.keys(stockLists).length} sectors`);
            console.log(`📈 Breakdown: ${stocksPerSector} stocks per sector`);
            console.log(`⚡ Full market coverage enabled`);
            
            // Remove duplicates (some stocks appear in multiple sectors)
            const uniqueStocks = [...new Set(selectedStocks)];
            console.log(`✨ Unique stocks after deduplication: ${uniqueStocks.length}`);
            
            return uniqueStocks;
        }

        // AI Analysis using Claude API
        // Show a themed result modal (replaces native alert)
        function showResultModal(title, rows, footer) {
            const body = document.getElementById('resultModalBody');
            let html = `<div class="result-modal-title">${title}</div>`;
            html += '<div class="result-modal-rows">';
            for (const row of rows) {
                const cls = row.cls ? ` ${row.cls}` : '';
                const wide = row.wide ? ' full-width' : '';
                html += `<div class="result-modal-row${wide}"><span class="label">${row.label}</span><span class="value${cls}">${row.value}</span></div>`;
            }
            html += '</div>';
            if (footer) {
                html += `<div class="result-modal-footer">${footer}</div>`;
            }
            body.innerHTML = html;
            document.getElementById('resultModal').classList.add('active');
        }

        // DRY RUN: Test data fetching without calling Claude API
        async function testDataFetch() {
            if (isAnalysisRunning) {
                addActivity('Analysis already in progress — please wait', 'warning');
                return;
            }
            isAnalysisRunning = true;
            const thinking = document.getElementById('aiThinking');
            const thinkingDetail = document.getElementById('thinkingDetail');
            thinking.classList.add('active');
            thinkingDetail.textContent = '🧪 DRY RUN: Testing data fetch...';

            console.log('=== DRY RUN TEST STARTED ===');
            const startTime = performance.now();

            try {
                // Smart screener picks stocks dynamically
                thinkingDetail.textContent = '🧪 Running stock screener...';
                const symbols = await screenStocks();
                console.log(`✅ Screener selected ${symbols.length} stocks:`, symbols);
                
                // Step 1: Bulk snapshot (same as real analysis)
                thinkingDetail.textContent = '🧪 Fetching bulk market snapshot...';
                let marketData = {};
                let fetchErrors = [];
                
                const bulkData = await fetchBulkSnapshot(symbols);
                
                if (bulkData && Object.keys(bulkData).length > symbols.length * 0.5) {
                    marketData = { ...bulkData };
                    const missingSymbols = symbols.filter(s => !marketData[s]);
                    if (missingSymbols.length > 0) {
                        thinkingDetail.textContent = `🧪 Fetching ${missingSymbols.length} remaining stocks...`;
                        const BATCH_SIZE = 50;
                        const BATCH_DELAY_MS = 1200;
                        for (let i = 0; i < missingSymbols.length; i += BATCH_SIZE) {
                            const batch = missingSymbols.slice(i, i + BATCH_SIZE);
                            const batchResults = await Promise.all(batch.map(async (symbol) => {
                                try {
                                    const data = await getStockPrice(symbol);
                                    return { symbol, data, success: true };
                                } catch (error) {
                                    return { symbol, error: error.message, success: false };
                                }
                            }));
                            batchResults.forEach(result => {
                                if (result.success) marketData[result.symbol] = result.data;
                                else fetchErrors.push({ symbol: result.symbol, error: result.error });
                            });
                            if (i + BATCH_SIZE < missingSymbols.length) {
                                await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
                            }
                        }
                    }
                    console.log(`✅ Bulk snapshot: ${Object.keys(marketData).length}/${symbols.length} stocks`);
                } else {
                    // Fallback to individual calls
                    console.warn('Bulk snapshot failed, falling back to individual calls');
                    const BATCH_SIZE_DR = 50;
                    const BATCH_DELAY_DR = 1200;
                    for (let i = 0; i < symbols.length; i += BATCH_SIZE_DR) {
                        const batch = symbols.slice(i, i + BATCH_SIZE_DR);
                        thinkingDetail.textContent = `🧪 Fetching batch ${Math.floor(i / BATCH_SIZE_DR) + 1}/${Math.ceil(symbols.length / BATCH_SIZE_DR)}...`;
                        const batchResults = await Promise.all(batch.map(async (symbol) => {
                            try {
                                const data = await getStockPrice(symbol);
                                return { symbol, data, success: true };
                            } catch (error) {
                                return { symbol, error: error.message, success: false };
                            }
                        }));
                        batchResults.forEach(result => {
                            if (result.success) marketData[result.symbol] = result.data;
                            else fetchErrors.push({ symbol: result.symbol, error: result.error });
                        });
                        if (i + BATCH_SIZE_DR < symbols.length) {
                            await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_DR));
                        }
                    }
                }
                
                const snapshotTime = performance.now();
                console.log(`⏱️ Snapshot phase: ${((snapshotTime - startTime) / 1000).toFixed(2)}s`);
                
                // Step 2: Fetch 20-day history for all symbols
                thinkingDetail.textContent = `🧪 Fetching 20-day price history...`;
                await fetchAll5DayHistories(symbols);
                const historyTime = performance.now();
                console.log(`⏱️ History phase: ${((historyTime - snapshotTime) / 1000).toFixed(2)}s`);
                console.log(`✅ 20-day history cached for ${Object.keys(multiDayCache).length}/${symbols.length} stocks`);
                
                // Step 3: Run enhanced analysis (momentum, RS, structure)
                thinkingDetail.textContent = `🧪 Running momentum, RS, and structure analysis...`;
                const stocksBySector = {};
                Object.entries(marketData).forEach(([symbol, data]) => {
                    const sector = stockSectors[symbol] || 'Unknown';
                    if (!stocksBySector[sector]) stocksBySector[sector] = [];
                    stocksBySector[sector].push({ symbol, ...data });
                });
                const sectorRotation = detectSectorRotation(marketData);

                // Persist sector rotation from dry run
                portfolio.lastSectorRotation = { timestamp: new Date().toISOString(), sectors: sectorRotation };

                let structureStats = { bullish: 0, bearish: 0, choch: 0, bos: 0, sweeps: 0, fvg: 0 };
                const dryRunScored = [];
                Object.keys(marketData).forEach(symbol => {
                    const data = marketData[symbol];
                    const sector = stockSectors[symbol] || 'Unknown';
                    const sectorData = stocksBySector[sector] || [];
                    const momentum = calculate5DayMomentum(data, symbol);
                    const rs = calculateRelativeStrength(data, sectorData, symbol);
                    const struct = detectStructure(symbol);
                    if (struct.structure === 'bullish') structureStats.bullish++;
                    if (struct.structure === 'bearish') structureStats.bearish++;
                    if (struct.choch) structureStats.choch++;
                    if (struct.bos) structureStats.bos++;
                    if (struct.sweep !== 'none') structureStats.sweeps++;
                    if (struct.fvg !== 'none') structureStats.fvg++;

                    const momScore = momentum?.score || 0;
                    const rsNorm = ((rs?.rsScore || 50) / 100) * 10;
                    const flow = sectorRotation[sector]?.moneyFlow;
                    const sBonus = flow === 'inflow' ? 2 : flow === 'modest-inflow' ? 1 : flow === 'outflow' ? -1 : 0;
                    const strBonus = (struct?.structureScore || 0) * 0.75;
                    dryRunScored.push({ symbol, compositeScore: momScore + rsNorm + sBonus + strBonus, momentum: momScore, rs: rs?.rsScore || 0, sector, sectorBonus: sBonus, structureScore: struct?.structureScore || 0, structure: struct?.structure || 'unknown' });
                });

                // Persist candidate scores from dry run
                dryRunScored.sort((a, b) => b.compositeScore - a.compositeScore);
                portfolio.lastCandidateScores = {
                    timestamp: new Date().toISOString(),
                    candidates: dryRunScored.slice(0, 40)
                };

                // Backfill thesis entries missing momentum/RS/sectorFlow
                if (portfolio.holdingTheses) {
                    Object.keys(portfolio.holdings).forEach(symbol => {
                        const thesis = portfolio.holdingTheses[symbol];
                        if (thesis && marketData[symbol]) {
                            const sector = stockSectors[symbol] || 'Unknown';
                            const sectorData = stocksBySector[sector] || [];
                            if (thesis.entryMomentum == null) thesis.entryMomentum = calculate5DayMomentum(marketData[symbol], symbol)?.score ?? null;
                            if (thesis.entryRS == null) thesis.entryRS = calculateRelativeStrength(marketData[symbol], sectorData, symbol)?.rsScore ?? null;
                            if (thesis.entrySectorFlow == null) thesis.entrySectorFlow = sectorRotation[sector]?.moneyFlow ?? null;
                        }
                    });
                }

                savePortfolio();
                updatePerformanceAnalytics();

                const endTime = performance.now();
                const duration = ((endTime - startTime) / 1000).toFixed(2);
                
                // Success report
                console.log(`\n✅ DRY RUN COMPLETE in ${duration}s`);
                console.log(`📊 Data: ${Object.keys(marketData).length} prices, ${Object.keys(multiDayCache).length} histories`);
                console.log(`📈 Structure: ${structureStats.bullish} bullish, ${structureStats.bearish} bearish, ${structureStats.choch} CHoCH, ${structureStats.bos} BOS, ${structureStats.sweeps} sweeps, ${structureStats.fvg} FVG`);
                
                if (fetchErrors.length > 0) {
                    console.warn(`⚠️ Failed to fetch ${fetchErrors.length} stocks:`, fetchErrors.map(e => e.symbol));
                }
                
                // Show sample data
                const sampleSymbols = Object.keys(marketData).slice(0, 5);
                console.log('\n📊 Sample data:');
                sampleSymbols.forEach(symbol => {
                    const data = marketData[symbol];
                    const struct = detectStructure(symbol);
                    const mom = calculate5DayMomentum(data, symbol);
                    console.log(`  ${symbol}: $${data.price.toFixed(2)} (${data.changePercent >= 0 ? '+' : ''}${data.changePercent.toFixed(2)}%) | momentum:${mom.score} ${mom.trend} | structure:${struct.structureSignal} ${struct.choch ? 'CHoCH-' + struct.chochType : ''} ${struct.bos ? 'BOS-' + struct.bosType : ''}`);
                });
                
                // Calculate cost if this were a real run
                const estimatedTokens = 25000; // Updated estimate with structure data
                const costPer1MInputTokens = 3.00;
                const costPer1MOutputTokens = 15.00;
                const estimatedOutputTokens = 8000;
                const estimatedCost = (estimatedTokens / 1000000) * costPer1MInputTokens + (estimatedOutputTokens / 1000000) * costPer1MOutputTokens * 2; // 2 phases
                
                console.log('\n💰 If this were a real run:');
                console.log(`  - Input tokens: ~${estimatedTokens.toLocaleString()} (×2 phases)`);
                console.log(`  - Output tokens: ~${estimatedOutputTokens.toLocaleString()} (×2 phases)`);
                console.log(`  - Estimated cost: ~$${estimatedCost.toFixed(4)}`);
                console.log(`  - You saved: $${estimatedCost.toFixed(4)} by using Dry Run! 🎉`);
                
                console.log('\n=== DRY RUN TEST COMPLETE ===');
                
                thinking.classList.remove('active');
                addActivity(`✅ DRY RUN: ${Object.keys(marketData).length} prices + ${Object.keys(multiDayCache).length} histories in ${duration}s. Structure: ${structureStats.choch} CHoCH, ${structureStats.bos} BOS. Console for details!`, 'success');
                
                showResultModal('Dry Run Complete', [
                    { label: 'Prices Fetched', value: `${Object.keys(marketData).length} / ${symbols.length}`, cls: 'success' },
                    { label: 'Price Histories', value: `${Object.keys(multiDayCache).length} (20-day bars)` },
                    { label: 'Bullish', value: structureStats.bullish, cls: 'success' },
                    { label: 'Bearish', value: structureStats.bearish, cls: 'error' },
                    { label: 'CHoCH Signals', value: structureStats.choch },
                    { label: 'BOS Signals', value: structureStats.bos },
                    { label: 'Liquidity Sweeps', value: structureStats.sweeps },
                    { label: 'Fair Value Gaps', value: structureStats.fvg },
                    { label: 'Duration', value: `${duration}s`, cls: 'accent', wide: true },
                    { label: 'Failures', value: fetchErrors.length, cls: fetchErrors.length > 0 ? 'error' : 'success', wide: true },
                    { label: 'Estimated Savings', value: `~$${estimatedCost.toFixed(4)}`, cls: 'accent', wide: true },
                ], 'Check console (F12) for detailed results');
                
            } catch (error) {
                console.error('❌ DRY RUN FAILED:', error);
                thinking.classList.remove('active');
                addActivity('❌ DRY RUN ERROR: ' + error.message, 'error');
                showResultModal('Dry Run Failed', [
                    { label: 'Error', value: error.message, cls: 'error' },
                ], 'Check console (F12) for details');
            } finally {
                isAnalysisRunning = false;
            }
        }

        // Robust JSON extraction for Claude responses that have broken escaping
        // Uses string-aware bracket counting to extract the decisions array reliably
        function extractDecisionFromRawResponse(rawResponse) {
            // Step 1: Find the decisions array using string-aware bracket counting
            const decisionsKeyIndex = rawResponse.indexOf('"decisions"');
            if (decisionsKeyIndex === -1) throw new Error('No "decisions" key found in response');
            
            const arrayStart = rawResponse.indexOf('[', decisionsKeyIndex);
            if (arrayStart === -1) throw new Error('No decisions array found');
            
            // Count brackets, respecting strings
            let bracketCount = 0;
            let inStr = false;
            let escNext = false;
            let arrayEnd = -1;
            
            for (let i = arrayStart; i < rawResponse.length; i++) {
                const ch = rawResponse[i];
                if (escNext) { escNext = false; continue; }
                if (ch === '\\') { escNext = true; continue; }
                if (ch === '"') { inStr = !inStr; continue; }
                if (!inStr) {
                    if (ch === '[') bracketCount++;
                    if (ch === ']') bracketCount--;
                    if (bracketCount === 0) { arrayEnd = i; break; }
                }
            }
            
            if (arrayEnd === -1) throw new Error('Could not find end of decisions array');
            
            // Extract the decisions array string
            let decisionsStr = rawResponse.substring(arrayStart, arrayEnd + 1);
            
            // Fix trailing commas
            decisionsStr = decisionsStr.replace(/,(\s*[}\]])/g, '$1');
            
            // Parse the decisions array - try direct first (structural newlines are fine)
            let decisions;
            try {
                decisions = JSON.parse(decisionsStr);
            } catch (e) {
                // If direct parse fails, fix newlines inside string values only
                // Walk through and replace newlines that are inside quotes
                let fixed = '';
                let inString = false;
                let escape = false;
                for (let i = 0; i < decisionsStr.length; i++) {
                    const ch = decisionsStr[i];
                    if (escape) { fixed += ch; escape = false; continue; }
                    if (ch === '\\') { fixed += ch; escape = true; continue; }
                    if (ch === '"') { inString = !inString; fixed += ch; continue; }
                    if (inString && ch === '\n') { fixed += '\\n'; continue; }
                    if (inString && ch === '\r') { continue; } // skip CR
                    if (inString && ch === '\t') { fixed += '\\t'; continue; }
                    fixed += ch;
                }
                
                try {
                    decisions = JSON.parse(fixed);
                } catch (e2) {
                    // Last resort: strip all control chars inside strings
                    fixed = fixed.replace(/[\x00-\x1F\x7F]/g, ' ');
                    decisions = JSON.parse(fixed);
                }
            }
            
            if (!Array.isArray(decisions) || decisions.length === 0) {
                throw new Error('Decisions array is empty or invalid');
            }
            
            // Step 2: Extract overall_reasoning as raw text (best effort, non-critical)
            let overallReasoning = '';
            try {
                const orKey = '"overall_reasoning"';
                const reasoningKeyIdx = rawResponse.indexOf(orKey, arrayEnd);
                if (reasoningKeyIdx !== -1) {
                    // Find the colon, then the opening quote
                    const colonIdx = rawResponse.indexOf(':', reasoningKeyIdx + orKey.length);
                    if (colonIdx !== -1) {
                        const openQuote = rawResponse.indexOf('"', colonIdx + 1);
                        if (openQuote !== -1) {
                            // Scan for closing quote (handling escapes)
                            let esc = false;
                            let closeQuote = -1;
                            for (let i = openQuote + 1; i < rawResponse.length; i++) {
                                if (esc) { esc = false; continue; }
                                if (rawResponse[i] === '\\') { esc = true; continue; }
                                if (rawResponse[i] === '"') { closeQuote = i; break; }
                            }
                            if (closeQuote !== -1) {
                                overallReasoning = rawResponse.substring(openQuote + 1, closeQuote)
                                    .replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\t/g, '\t');
                            } else {
                                // No proper closing quote - grab everything until we see research_summary or end
                                const remainder = rawResponse.substring(openQuote + 1);
                                const cutoff = remainder.search(/"research_summary"|$/);
                                overallReasoning = remainder.substring(0, cutoff)
                                    .replace(/\\n/g, '\n').replace(/\\"/g, '"')
                                    .replace(/[",\s]*$/, ''); // trim trailing junk
                            }
                        }
                    }
                }
            } catch (e) {
                console.warn('Could not extract overall_reasoning (non-critical):', e.message);
            }
            
            // Step 3: Extract research_summary similarly (best effort)
            let researchSummary = '';
            try {
                const rsKey = '"research_summary"';
                const rsKeyIdx = rawResponse.indexOf(rsKey, arrayEnd);
                if (rsKeyIdx !== -1) {
                    const colonIdx = rawResponse.indexOf(':', rsKeyIdx + rsKey.length);
                    if (colonIdx !== -1) {
                        const openQuote = rawResponse.indexOf('"', colonIdx + 1);
                        if (openQuote !== -1) {
                            // Find closing quote or just grab until end
                            let esc = false;
                            let closeQuote = -1;
                            for (let i = openQuote + 1; i < rawResponse.length; i++) {
                                if (esc) { esc = false; continue; }
                                if (rawResponse[i] === '\\') { esc = true; continue; }
                                if (rawResponse[i] === '"') { closeQuote = i; break; }
                            }
                            if (closeQuote !== -1) {
                                researchSummary = rawResponse.substring(openQuote + 1, closeQuote)
                                    .replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\t/g, '\t');
                            }
                        }
                    }
                }
            } catch (e) {
                console.warn('Could not extract research_summary (non-critical):', e.message);
            }
            
            console.log(`📋 Extracted ${decisions.length} decisions, reasoning: ${overallReasoning.length} chars, research: ${researchSummary.length} chars`);
            
            return {
                decisions: decisions,
                overall_reasoning: overallReasoning,
                research_summary: researchSummary
            };
        }

        async function runAIAnalysis() {
            if (isAnalysisRunning) {
                addActivity('Analysis already in progress — please wait', 'warning');
                return;
            }
            isAnalysisRunning = true;
            const thinking = document.getElementById('aiThinking');
            const thinkingDetail = document.getElementById('thinkingDetail');
            thinking.classList.add('active');
            thinkingDetail.textContent = 'Running smart stock screener...';

            let aiResponse = '';  // Declare here so catch block can access it

            try {
                // MARKET HOURS CHECK: Warn if markets are closed to avoid wasting API costs
                const marketCheckTime = new Date();
                const day = marketCheckTime.getDay();
                const hour = marketCheckTime.getHours();
                const minute = marketCheckTime.getMinutes();
                const currentTime = hour * 60 + minute;
                const marketOpen = 9 * 60 + 30; // 9:30 AM local (approximation)
                const marketClose = 16 * 60; // 4:00 PM local
                const isWeekday = day >= 1 && day <= 5;
                const isDuringMarketHours = currentTime >= marketOpen && currentTime < marketClose;
                
                if (!isWeekday) {
                    const proceed = confirm(
                        `📅 WEEKEND — Markets are closed\n\n` +
                        `Running analysis now will use the same data as Friday's close.\n` +
                        `This costs ~$3-5 in API fees for results that won't change until Monday.\n\n` +
                        `Continue anyway?`
                    );
                    if (!proceed) {
                        thinking.classList.remove('active');
                        addActivity('⏸️ Analysis skipped — markets closed (weekend)', 'warning');
                        return;
                    }
                } else if (!isDuringMarketHours) {
                    const timeStr = currentTime < marketOpen ? 'before market open' : 'after market close';
                    const proceed = confirm(
                        `🕐 Markets are currently closed (${timeStr})\n\n` +
                        `Price data won't reflect live trading. Analysis will use ${currentTime < marketOpen ? "yesterday's closing" : "today's closing"} data.\n\n` +
                        `Continue anyway?`
                    );
                    if (!proceed) {
                        thinking.classList.remove('active');
                        addActivity(`⏸️ Analysis skipped — markets closed (${timeStr})`, 'warning');
                        return;
                    }
                }

                // Update post-exit tracking for closed trades
                thinkingDetail.textContent = 'Checking post-exit price tracking...';
                await updatePostExitTracking();
                
                // Smart screener picks stocks dynamically
                const symbols = await screenStocks();
                console.log('Analyzing stocks:', symbols);
                thinkingDetail.textContent = 'Fetching stock data...';
                
                let marketData = {};
                let fetchErrors = [];
                
                // Try bulk snapshot first (1 API call for all ~300 stocks)
                thinkingDetail.textContent = 'Fetching market snapshot...';
                const bulkData = await fetchBulkSnapshot(symbols);
                
                if (bulkData && Object.keys(bulkData).length > symbols.length * 0.5) {
                    // Bulk fetch succeeded — use it
                    marketData = { ...bulkData };
                    
                    // Check for any symbols missing from bulk response
                    const missingSymbols = symbols.filter(s => !marketData[s]);
                    if (missingSymbols.length > 0) {
                        console.log(`Bulk snapshot missing ${missingSymbols.length} symbols, fetching individually...`);
                        thinkingDetail.textContent = `Fetching ${missingSymbols.length} remaining stocks...`;
                        
                        // Fetch missing ones individually (small batch)
                        const BATCH_SIZE = 50;
                        const BATCH_DELAY_MS = 1200;
                        for (let i = 0; i < missingSymbols.length; i += BATCH_SIZE) {
                            const batch = missingSymbols.slice(i, i + BATCH_SIZE);
                            const batchResults = await Promise.all(batch.map(async (symbol) => {
                                try {
                                    const data = await getStockPrice(symbol);
                                    return { symbol, data, success: true };
                                } catch (error) {
                                    return { symbol, error: error.message, success: false };
                                }
                            }));
                            batchResults.forEach(result => {
                                if (result.success) marketData[result.symbol] = result.data;
                                else fetchErrors.push({ symbol: result.symbol, error: result.error });
                            });
                            if (i + BATCH_SIZE < missingSymbols.length) {
                                await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
                            }
                        }
                    }
                } else {
                    // Bulk fetch failed — fall back to individual batched calls
                    console.warn('Bulk snapshot insufficient, falling back to individual calls');
                    const BATCH_SIZE = 50;
                    const BATCH_DELAY_MS = 1200;
                    
                    for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
                        const batch = symbols.slice(i, i + BATCH_SIZE);
                        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
                        const totalBatches = Math.ceil(symbols.length / BATCH_SIZE);
                        thinkingDetail.textContent = `Fetching batch ${batchNum}/${totalBatches} (${Object.keys(marketData).length} stocks so far)...`;
                        
                        const batchResults = await Promise.all(batch.map(async (symbol) => {
                            try {
                                const data = await getStockPrice(symbol);
                                return { symbol, data, success: true };
                            } catch (error) {
                                return { symbol, error: error.message, success: false };
                            }
                        }));
                        batchResults.forEach(result => {
                            if (result.success) marketData[result.symbol] = result.data;
                            else fetchErrors.push({ symbol: result.symbol, error: result.error });
                        });
                        if (i + BATCH_SIZE < symbols.length) {
                            await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
                        }
                    }
                }
                
                thinkingDetail.textContent = `Fetched ${Object.keys(marketData).length}/${symbols.length} stocks`;
                
                // Check if we got any data at all
                if (Object.keys(marketData).length === 0) {
                    thinking.classList.remove('active');
                    addActivity('🚫 Unable to fetch market data: ' + fetchErrors[0].error, 'error');
                    alert('Unable to fetch market data. Please check your connection and try again.');
                    return;
                }
                
                // MINIMUM DATA GATE - Don't waste money on incomplete analysis
                const successRate = Object.keys(marketData).length / symbols.length;
                const failedCount = fetchErrors.length;
                
                if (successRate < 0.70) {
                    // Less than 70% success - too many gaps, abort
                    const proceed = confirm(
                        `⚠️ INCOMPLETE DATA WARNING\n\n` +
                        `Only fetched ${Object.keys(marketData).length}/${symbols.length} stocks (${(successRate * 100).toFixed(0)}%).\n` +
                        `${failedCount} stocks failed - likely Polygon rate limiting.\n\n` +
                        `Running AI analysis with this much missing data will:\n` +
                        `• Cost tokens for a partial analysis\n` +
                        `• Miss opportunities in failed sectors\n` +
                        `• Produce less reliable recommendations\n\n` +
                        `Recommendation: Wait 60 seconds and try again.\n\n` +
                        `Continue anyway?`
                    );
                    
                    if (!proceed) {
                        thinking.classList.remove('active');
                        addActivity(`⚠️ AI Analysis cancelled - only ${(successRate * 100).toFixed(0)}% of stocks fetched successfully`, 'warning');
                        return;
                    }
                }
                
                // CHECK PRICE FRESHNESS - Don't waste $3 on stale data!
                const now = Date.now();
                let oldestData = 0;
                let oldestSymbol = '';
                Object.entries(marketData).forEach(([symbol, data]) => {
                    const age = now - new Date(data.timestamp).getTime();
                    if (age > oldestData) {
                        oldestData = age;
                        oldestSymbol = symbol;
                    }
                });
                
                const minutesOld = Math.floor(oldestData / 60000);
                console.log(`Oldest price data: ${oldestSymbol} is ${minutesOld} minutes old`);
                
                // Warn if data is >30 minutes old (market might be closed or data stale)
                if (minutesOld > 30) {
                    const proceed = confirm(
                        `⚠️ STALE DATA WARNING\n\n` +
                        `Price data is ${minutesOld} minutes old.\n\n` +
                        `This costs ~$3 per analysis. Running with stale data wastes money.\n\n` +
                        `Reasons:\n` +
                        `• Market is closed (after 4PM ET)\n` +
                        `• Weekend trading data\n` +
                        `• Data provider delay\n\n` +
                        `Continue anyway?`
                    );
                    
                    if (!proceed) {
                        thinking.classList.remove('active');
                        addActivity('⚠️ AI Analysis cancelled - price data too old', 'warning');
                        return;
                    }
                }
                
                // Warn if partial data
                if (fetchErrors.length > 0) {
                    const failedSymbols = fetchErrors.map(e => e.symbol).join(', ');
                    addActivity(`⚠️ Warning: Could not fetch data for ${failedSymbols}. Analysis proceeding with available data.`, 'warning');
                }

                // === ENHANCED MARKET ANALYSIS ===
                thinkingDetail.textContent = 'Fetching 5-day price histories for real momentum...';
                console.log('🧠 Running enhanced market analysis...');
                
                // 0. Fetch 5-day price history for all stocks
                const allSymbolsFetched = Object.keys(marketData);
                await fetchAll5DayHistories(allSymbolsFetched);
                
                // 1. Calculate sector rotation patterns (now uses multi-day data)
                const sectorRotation = detectSectorRotation(marketData);
                console.log('📊 Sector Rotation Analysis:', sectorRotation);

                // Persist sector rotation for dashboard display
                portfolio.lastSectorRotation = { timestamp: new Date().toISOString(), sectors: sectorRotation };

                // 2. Group stocks by sector for relative strength calculations
                const stocksBySector = {};
                Object.entries(marketData).forEach(([symbol, data]) => {
                    const sector = stockSectors[symbol] || 'Unknown';
                    if (!stocksBySector[sector]) stocksBySector[sector] = [];
                    stocksBySector[sector].push({ symbol, ...data });
                });
                
                // 3. Calculate enhanced metrics for each stock
                const enhancedMarketData = {};
                Object.entries(marketData).forEach(([symbol, data]) => {
                    const sector = stockSectors[symbol] || 'Unknown';
                    const sectorData = stocksBySector[sector] || [];
                    
                    // Calculate 5-day momentum score
                    const momentum = calculate5DayMomentum(data, symbol);
                    
                    // Calculate relative strength vs sector
                    const relativeStrength = calculateRelativeStrength(data, sectorData, symbol);
                    
                    // Detect market structure (CHoCH, BOS, sweeps, FVG)
                    const marketStructure = detectStructure(symbol);
                    
                    // Combine all data
                    enhancedMarketData[symbol] = {
                        ...data,
                        sector: sector,
                        momentum: momentum,
                        relativeStrength: relativeStrength,
                        sectorRotation: sectorRotation[sector],
                        marketStructure: marketStructure
                    };
                });

                // Write computed indicators back to marketData so trade execution can record them
                Object.entries(enhancedMarketData).forEach(([symbol, data]) => {
                    if (marketData[symbol]) {
                        marketData[symbol].momentum = data.momentum;
                        marketData[symbol].relativeStrength = data.relativeStrength;
                        marketData[symbol].sectorRotation = data.sectorRotation;
                    }
                });

                // Backfill thesis entries missing momentum/RS/sectorFlow (for holdings bought before tracking was added)
                if (portfolio.holdingTheses) {
                    Object.keys(portfolio.holdings).forEach(symbol => {
                        const thesis = portfolio.holdingTheses[symbol];
                        const emd = enhancedMarketData[symbol];
                        if (thesis && emd) {
                            if (thesis.entryMomentum == null) thesis.entryMomentum = emd.momentum?.score ?? null;
                            if (thesis.entryRS == null) thesis.entryRS = emd.relativeStrength?.rsScore ?? null;
                            if (thesis.entrySectorFlow == null) thesis.entrySectorFlow = emd.sectorRotation?.moneyFlow ?? null;
                        }
                    });
                }

                console.log('✅ Enhanced market data prepared with momentum, RS, rotation, and structure analysis');

                // === PRE-SCREEN: Rank all stocks and select top candidates for Claude ===
                thinkingDetail.textContent = 'Pre-screening: ranking stocks by composite score...';
                
                // 1. Score every stock with a composite ranking
                const scoredStocks = Object.entries(enhancedMarketData).map(([symbol, data]) => {
                    const momentumScore = data.momentum?.score || 0;
                    const rsNormalized = ((data.relativeStrength?.rsScore || 50) / 100) * 10;
                    
                    let sectorBonus = 0;
                    const flow = data.sectorRotation?.moneyFlow;
                    if (flow === 'inflow') sectorBonus = 2;
                    else if (flow === 'modest-inflow') sectorBonus = 1;
                    else if (flow === 'outflow') sectorBonus = -1;
                    
                    // Acceleration bonus: reward building momentum, not single-day spikes
                    const accelBonus = data.momentum?.isAccelerating && data.momentum?.score >= 6 ? 1.5 : 0;
                    // Consistency bonus: reward multi-day uptrends
                    const consistencyBonus = (data.momentum?.upDays >= 3 && data.momentum?.totalDays >= 4) ? 1.0 : 0;
                    // bigMoverBonus disabled: rewarding stocks already up >5% today is chasing by definition
                    const bigMoverBonus = 0;
                    // Structure bonus: reward bullish structure, BOS, bullish CHoCH; penalize bearish
                    const structureBonus = (data.marketStructure?.structureScore || 0) * 0.75;

                    // Extension penalty: extremely stretched stocks get dampened in ranking
                    const extensionPenalty = (momentumScore >= 9 && rsNormalized >= 8.5) ? -3
                        : (momentumScore >= 8 && rsNormalized >= 8) ? -2
                        : (momentumScore >= 7.5 && rsNormalized >= 7.5) ? -1
                        : 0;

                    // Pullback bonus: stock dipped but structure/sector still supportive
                    const totalReturn5d = data.momentum?.totalReturn5d ?? 0;
                    const pullbackBonus = (totalReturn5d >= -8 && totalReturn5d <= -2
                        && (data.marketStructure?.structureScore ?? 0) >= 1
                        && data.sectorRotation?.moneyFlow !== 'outflow'
                        && data.sectorRotation?.moneyFlow !== 'modest-outflow') ? 2
                        : (totalReturn5d >= -5 && totalReturn5d < 0
                        && (data.marketStructure?.structureScore ?? 0) >= 0
                        && data.sectorRotation?.moneyFlow !== 'outflow') ? 1
                        : 0;

                    const compositeScore = momentumScore + rsNormalized + sectorBonus + accelBonus + consistencyBonus + bigMoverBonus + structureBonus + extensionPenalty + pullbackBonus;
                    
                    return { symbol, compositeScore, data };
                });
                
                // 2. Sort by composite score descending
                scoredStocks.sort((a, b) => b.compositeScore - a.compositeScore);

                // Persist top candidate scores for dashboard display
                portfolio.lastCandidateScores = {
                    timestamp: new Date().toISOString(),
                    candidates: scoredStocks.slice(0, 40).map(s => ({
                        symbol: s.symbol,
                        compositeScore: s.compositeScore,
                        momentum: s.data.momentum?.score || 0,
                        rs: s.data.relativeStrength?.rsScore || 0,
                        sector: s.data.sector || 'Unknown',
                        sectorBonus: s.data.sectorRotation?.moneyFlow === 'inflow' ? 2 : s.data.sectorRotation?.moneyFlow === 'modest-inflow' ? 1 : s.data.sectorRotation?.moneyFlow === 'outflow' ? -1 : 0,
                        structureScore: s.data.marketStructure?.structureScore || 0,
                        structure: s.data.marketStructure?.structure || 'unknown'
                    }))
                };

                // 3. Build the candidate list
                const TOP_N = 25;
                const WILD_CARDS = 5;
                
                const topCandidates = new Set(scoredStocks.slice(0, TOP_N).map(s => s.symbol));
                
                // Always include current holdings (critical for sell decisions)
                Object.keys(portfolio.holdings).forEach(symbol => {
                    if (enhancedMarketData[symbol]) {
                        topCandidates.add(symbol);
                    }
                });
                
                // Add wild cards from underrepresented sectors
                const sectorCounts = {};
                topCandidates.forEach(symbol => {
                    const sector = enhancedMarketData[symbol]?.sector || 'Unknown';
                    sectorCounts[sector] = (sectorCounts[sector] || 0) + 1;
                });
                
                const allSectors = [...new Set(Object.values(enhancedMarketData).map(d => d.sector))];
                let wildCardsAdded = 0;
                for (const sector of allSectors) {
                    if (wildCardsAdded >= WILD_CARDS) break;
                    if (!sectorCounts[sector]) {
                        const topFromSector = scoredStocks.find(s => 
                            s.data.sector === sector && !topCandidates.has(s.symbol)
                        );
                        if (topFromSector) {
                            topCandidates.add(topFromSector.symbol);
                            wildCardsAdded++;
                        }
                    }
                }
                
                // REVERSAL CANDIDATES: Add stocks with bullish CHoCH or low-swept signals
                // These may have low composite scores (beaten down) but are showing early structural reversal
                // Without this, the pre-screening systematically filters out the best contrarian plays
                const REVERSAL_SLOTS = 10;
                let reversalsAdded = 0;
                const reversalCandidates = scoredStocks.filter(s => {
                    if (topCandidates.has(s.symbol)) return false; // Already included
                    const struct = s.data.marketStructure;
                    if (!struct) return false;
                    // Bullish CHoCH = was bearish, now showing reversal
                    if (struct.choch && struct.chochType === 'bullish') return true;
                    // Low-swept = liquidity taken below swing low, then reversed (smart money accumulation)
                    if (struct.sweep === 'low-swept') return true;
                    // Bullish BOS on a stock not in the top 25 = breakout that composite missed
                    if (struct.bos && struct.bosType === 'bullish' && s.data.momentum?.score >= 5) return true;
                    return false;
                });
                
                reversalCandidates.slice(0, REVERSAL_SLOTS).forEach(s => {
                    topCandidates.add(s.symbol);
                    reversalsAdded++;
                });
                
                if (reversalsAdded > 0) {
                    console.log(`🔄 Added ${reversalsAdded} reversal candidates:`, reversalCandidates.slice(0, REVERSAL_SLOTS).map(s => 
                        `${s.symbol} (${s.data.marketStructure.choch ? 'CHoCH-' + s.data.marketStructure.chochType : s.data.marketStructure.sweep !== 'none' ? 'sweep-' + s.data.marketStructure.sweep : 'BOS-' + s.data.marketStructure.bosType})`
                    ));
                }
                
                // 4. Build filtered data (only candidates go to Claude)
                const filteredMarketData = {};
                topCandidates.forEach(symbol => {
                    filteredMarketData[symbol] = enhancedMarketData[symbol];
                });
                
                // ISSUE F: After Phase 1 sells are decided, remove those symbols from Phase 2 candidates
                // This is a hard guard against Claude recommending re-buying something it just sold
                // (Applied later after Phase 1 completes — see phase1SellSymbolFilter below)
                
                // 5. Build compact sector summary from ALL stocks (full market context)
                const sectorSummary = {};
                Object.entries(sectorRotation).forEach(([sector, data]) => {
                    const sectorStocks = scoredStocks.filter(s => s.data.sector === sector);
                    const topInSector = sectorStocks.slice(0, 3).map(s => s.symbol);
                    sectorSummary[sector] = {
                        ...data,
                        topPerformers: topInSector,
                        stocksAnalyzed: sectorStocks.length
                    };
                });
                
                const candidateCount = topCandidates.size;
                const holdingSymbols = Object.keys(portfolio.holdings);
                console.log(`🎯 Pre-screened to ${candidateCount} candidates from ${Object.keys(enhancedMarketData).length} stocks`);
                console.log(`📊 Includes: Top ${TOP_N} by score, ${holdingSymbols.length} current holdings, ${wildCardsAdded} wild cards, ${reversalsAdded} reversal candidates`);
                console.log(`📈 Candidates:`, [...topCandidates]);

                // Build TOP BUY OPPORTUNITIES summary for Phase 1 (opportunity cost awareness)
                // Phase 1 only sees holdings — without this, it can't weigh "hold mediocre position" vs "sell and buy something better"
                const topBuyOpportunities = scoredStocks
                    .filter(s => !portfolio.holdings[s.symbol]) // Exclude current holdings
                    .slice(0, 5)
                    .map(s => {
                        const struct = s.data.marketStructure || {};
                        return `${s.symbol} (score:${s.compositeScore.toFixed(1)}, momentum:${s.data.momentum?.score || '?'}, RS:${s.data.relativeStrength?.rsScore || '?'}, structure:${struct.structureSignal || '?'})`;
                    });
                
                console.log('💡 Top buy opportunities for Phase 1 context:', topBuyOpportunities);

                thinkingDetail.textContent = `AI analyzing ${candidateCount} pre-screened candidates...`;

                // Calculate portfolio value (await since it's async)
                const { total: totalValue } = await calculatePortfolioValue();

                // ══════════════════════════════════════════════════════════════
                // TWO-PHASE AI ANALYSIS: Phase 1 = Sell decisions, Phase 2 = Buy decisions
                // ══════════════════════════════════════════════════════════════
                
                const holdingSymbolsList = Object.keys(portfolio.holdings);
                const hasHoldings = holdingSymbolsList.length > 0;
                let phase1SellDecisions = [];
                let phase1Summary = '';
                let phase1Regime = '';
                let updatedCash = portfolio.cash;
                
                if (hasHoldings) {
                    thinkingDetail.textContent = 'Phase 1: Reviewing holdings for sell decisions...';
                    console.log('🔍 Phase 1: Holdings review');
                    
                    const holdingsData = {};
                    holdingSymbolsList.forEach(sym => { if (enhancedMarketData[sym]) holdingsData[sym] = enhancedMarketData[sym]; });
                    
                    const p1Resp = await fetch(ANTHROPIC_API_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: 'claude-sonnet-4-20250514',
                            max_tokens: 4000,
                            tools: [{ type: "web_search_20250305", name: "web_search" }],
                            messages: [{ role: 'user', content: `You are APEX, an AI trading agent. PHASE 1: HOLDINGS REVIEW ONLY.
Today: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}.

TASK: Review each holding → decide SELL or HOLD. NO BUY decisions.

For each holding, compare ORIGINAL_THESIS vs CURRENT_INDICATORS:
1. Has catalyst played out, strengthened, or broken?
2. Entry momentum → current momentum (improving or fading?)
3. Entry RS → current RS (outperforming or lagging sector?)
4. Entry sector flow → current sector flow (rotation for or against?)
5. Current structure signals (CHoCH = reversal warning, BOS = trend continues)
6. Time elapsed vs expected catalyst timeframe
7. Would you buy TODAY at current price with current indicators?

SEARCH: Check news for each holding + one market regime search.

Portfolio Cash: $${portfolio.cash.toFixed(2)}
Holdings: ${(() => {
    const eh = {};
    Object.entries(portfolio.holdings).forEach(([sym, sh]) => {
        const buys = getCurrentPositionBuys(sym);
        let tsB = 0, tc = 0;
        buys.forEach(t => { tsB += t.shares; tc += t.price * t.shares; });
        const ac = tsB > 0 ? tc / tsB : 0;
        const cp = holdingsData[sym]?.price || 0;
        const uPL = cp > 0 ? ((cp - ac) / ac * 100) : 0;
        const fb = buys[0];
        const hd = fb ? Math.floor((Date.now() - new Date(fb.timestamp).getTime()) / 86400000) : 0;
        const hh = fb ? Math.floor((Date.now() - new Date(fb.timestamp).getTime()) / 3600000) : 0;
        const th = (portfolio.holdingTheses || {})[sym];
        eh[sym] = { shares: sh, avgCost: '$' + ac.toFixed(2), price: '$' + cp.toFixed(2), PL: uPL.toFixed(1) + '%', held: hd >= 1 ? hd + 'd' : hh + 'h',
            ORIGINAL_THESIS: th ? { catalyst: th.originalCatalyst, entryConviction: th.entryConviction, entryPrice: '$' + th.entryPrice.toFixed(2), entryDate: th.entryDate.split('T')[0], entryMomentum: th.entryMomentum, entryRS: th.entryRS, entrySectorFlow: th.entrySectorFlow } : 'No thesis recorded',
            CURRENT_INDICATORS: {
                sector: holdingsData[sym]?.sector || 'Unknown',
                momentum: holdingsData[sym]?.momentum?.score ?? null,
                relativeStrength: holdingsData[sym]?.relativeStrength?.rsScore ?? null,
                sectorFlow: holdingsData[sym]?.sectorRotation?.moneyFlow ?? null,
                structure: holdingsData[sym]?.marketStructure?.structure ?? null,
                structureSignals: {
                    choch: holdingsData[sym]?.marketStructure?.choch ?? null,
                    bos: holdingsData[sym]?.marketStructure?.bos ?? null,
                    liquiditySweep: holdingsData[sym]?.marketStructure?.liquiditySweep ?? false,
                    fvgCount: holdingsData[sym]?.marketStructure?.fvgs?.length ?? 0
                }
            } };
        if (hh < 24) eh[sym].WARNING = 'RECENTLY PURCHASED - only sell on negative catalyst';
    });
    return JSON.stringify(eh, null, 2);
})()}

Recent Transactions: ${(() => {
    const r = (portfolio.transactions || []).slice(-10).reverse();
    return r.length === 0 ? 'None' : r.map(t => t.type + ' ' + t.shares + ' ' + t.symbol + ' @ $' + t.price.toFixed(2) + ' ' + new Date(t.timestamp).toLocaleDateString()).join('; ');
})()}

⚠️ ANTI-WHIPSAW: Do NOT contradict last 24hr decisions.

💡 OPPORTUNITY COST — Top buy candidates waiting in Phase 2:
${topBuyOpportunities.join('\\n')}
If a holding is mediocre (flat thesis, weak momentum) and these candidates are significantly stronger, consider SELLING to free up cash. Don't hold a 4/10 position when 8/10 opportunities are available.

JSON ONLY response:
{ "decisions": [{ "action": "SELL" or "HOLD", "symbol": "X", "shares": N, "conviction": 1-10, "reasoning": "..." }], "holdings_summary": "...", "market_regime": "bull/bear/choppy" }
Include a decision for EVERY holding.` }]
                        })
                    });
                    
                    const p1Data = await p1Resp.json();
                    if (p1Data.type === 'error' || p1Data.error) {
                        const em = p1Data.error?.message || 'Phase 1 error';
                        if (em.includes('rate_limit')) throw new Error('Rate limit on Phase 1! Wait 60s. 🕐');
                        console.warn('Phase 1 error (non-fatal):', em);
                    } else {
                        let p1Text = '';
                        if (p1Data.content) for (const b of p1Data.content) { if (b.type === 'text') p1Text += b.text; }
                        
                        try {
                            let pj = p1Text;
                            if (pj.includes('```json')) pj = (pj.match(/```json\s*([\s\S]*?)\s*```/) || [null, pj])[1];
                            else if (pj.includes('```')) pj = (pj.match(/```\s*([\s\S]*?)\s*```/) || [null, pj])[1];
                            const si = pj.indexOf('{');
                            if (si !== -1) {
                                let bc = 0, ei = si, ins = false, esc = false;
                                for (let i = si; i < pj.length; i++) {
                                    if (esc) { esc = false; continue; } if (pj[i] === '\\') { esc = true; continue; }
                                    if (pj[i] === '"') { ins = !ins; continue; }
                                    if (!ins) { if (pj[i] === '{') bc++; if (pj[i] === '}') bc--; if (bc === 0) { ei = i; break; } }
                                }
                                let ps = pj.substring(si, ei + 1);
                                ps = ps.replace(/<cite[^>]*>/g, '').replace(/<\/cite>/g, '');
                                ps = ps.replace(/,(\s*[}\]])/g, '$1');
                                ps = ps.replace(/\r\n/g, '\\n').replace(/\r/g, '\\n').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
                                ps = ps.replace(/(\\n){3,}/g, '\\n\\n');
                                ps = ps.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
                                const parsed = JSON.parse(ps);
                                if (parsed.decisions) {
                                    phase1SellDecisions = parsed.decisions.filter(d => {
                                        if (d.action !== 'SELL' || !d.shares || d.shares <= 0) return false;

                                        // Validate symbol is actually held
                                        const held = portfolio.holdings[d.symbol] || 0;
                                        if (held === 0) {
                                            console.warn(`⚠️ Phase 1 recommended selling ${d.symbol} but it's not held — skipping`);
                                            return false;
                                        }

                                        // Anti-whipsaw: block sells for positions < 24 hours old
                                        const buys = getCurrentPositionBuys(d.symbol);
                                        if (buys.length > 0) {
                                            const holdHours = (Date.now() - new Date(buys[0].timestamp).getTime()) / 3600000;
                                            if (holdHours < 24) {
                                                console.warn(`⚠️ Anti-whipsaw: blocking sell of ${d.symbol} (held only ${holdHours.toFixed(1)}hrs)`);
                                                addActivity(`⚠️ Anti-whipsaw blocked sell of ${d.symbol} (held < 24hrs)`, 'warning');
                                                return false;
                                            }
                                        }
                                        return true;
                                    });
                                    phase1Summary = parsed.holdings_summary || '';
                                    phase1Regime = parsed.market_regime || '';
                                    // Persist market regime for dashboard display
                                    if (phase1Regime) {
                                        portfolio.lastMarketRegime = { regime: phase1Regime, timestamp: new Date().toISOString() };
                                    }
                                    for (const sd of phase1SellDecisions) {
                                        sd.shares = Math.floor(sd.shares || 0);
                                        // Clamp to actual position size
                                        const held = portfolio.holdings[sd.symbol] || 0;
                                        if (sd.shares > held) {
                                            console.warn(`⚠️ Phase 1 wants to sell ${sd.shares} ${sd.symbol} but only ${held} held — clamping`);
                                            sd.shares = held;
                                        }
                                        const sp = enhancedMarketData[sd.symbol]?.price || 0;
                                        if (sp > 0 && sd.shares > 0) updatedCash += sp * sd.shares;
                                    }
                                    console.log('✅ Phase 1:', phase1SellDecisions.length, 'sells, cash now $' + updatedCash.toFixed(2));
                                }
                            }
                        } catch (pe) {
                            console.warn('Phase 1 parse (non-fatal):', pe.message);
                            addActivity('⚠️ Phase 1 response had formatting issues — sell analysis may be incomplete', 'warning');
                        }
                    }
                }
                
                // ── PHASE 2: BUY DECISIONS ──
                // Hard guard: Remove Phase 1 sell symbols from the candidate pool
                if (phase1SellDecisions.length > 0) {
                    const sellSymbols = phase1SellDecisions.map(d => d.symbol);
                    sellSymbols.forEach(sym => {
                        if (filteredMarketData[sym]) {
                            delete filteredMarketData[sym];
                            console.log(`🚫 Removed ${sym} from Phase 2 candidates (just sold in Phase 1)`);
                        }
                    });
                }
                
                // Flag recently-sold stocks in candidate data (sold within last 5 trading days)
                // Forces Claude to justify re-buying with a NEW catalyst, not just "price dropped more"
                const RECENT_SELL_COOLDOWN_DAYS = 5;
                const cooldownMs = RECENT_SELL_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
                const nowMs = Date.now();
                const recentSells = (portfolio.closedTrades || []).filter(t => {
                    const sellTime = new Date(t.sellDate).getTime();
                    return (nowMs - sellTime) < cooldownMs;
                });
                
                let recentlySoldWarnings = '';
                recentSells.forEach(trade => {
                    if (filteredMarketData[trade.symbol]) {
                        const daysSinceSell = Math.round((nowMs - new Date(trade.sellDate).getTime()) / (24 * 60 * 60 * 1000) * 10) / 10;
                        const exitReason = trade.exitReason || trade.exitReasoning?.substring(0, 80) || 'unknown';
                        
                        // Tag the market data so Claude sees it inline
                        filteredMarketData[trade.symbol].RECENTLY_SOLD = {
                            soldDate: trade.sellDate.split('T')[0],
                            daysAgo: daysSinceSell,
                            sellPrice: '$' + trade.sellPrice.toFixed(2),
                            buyPrice: '$' + trade.buyPrice.toFixed(2),
                            realizedPL: (trade.returnPercent >= 0 ? '+' : '') + trade.returnPercent.toFixed(1) + '%',
                            exitReason: exitReason
                        };
                        
                        recentlySoldWarnings += `⚠️ ${trade.symbol}: Sold ${daysSinceSell.toFixed(1)} days ago at $${trade.sellPrice.toFixed(2)} (reason: ${exitReason}). To re-buy, you MUST identify a NEW catalyst not present at time of sale. "Price dropped more" is NOT sufficient.\n`;
                        
                        console.log(`⚠️ Recently sold: ${trade.symbol} (${daysSinceSell.toFixed(1)} days ago, reason: ${exitReason})`);
                    }
                });
                
                thinkingDetail.textContent = hasHoldings ? 'Phase 2: Finding buy opportunities...' : 'Researching buy opportunities...';
                
                // Call Claude API for BUY decisions (Phase 2) via Cloudflare Worker proxy
                const response = await fetch(ANTHROPIC_API_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        model: 'claude-sonnet-4-20250514',
                        max_tokens: 8000,
                        tools: [{
                            type: "web_search_20250305",
                            name: "web_search"
                        }],
                        messages: [{
                            role: 'user',
                            content: `You are APEX, an AGGRESSIVE AI trading agent who's also a passionate teacher. You maximize returns while educating your user about WHY you make each decision.

IMPORTANT DATE CONTEXT:
Today's date is ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}.
Current quarter: Q${Math.floor((new Date().getMonth() + 3) / 3)} ${new Date().getFullYear()}

${hasHoldings && phase1SellDecisions.length > 0 ? '\n══ PHASE 1 RESULTS (Sells already decided) ══\nSells: ' + phase1SellDecisions.map(d => 'SELL ' + d.shares + ' ' + d.symbol + ': ' + d.reasoning).join('\n') + '\nHoldings Summary: ' + phase1Summary + '\nMarket Regime: ' + phase1Regime + '\n══════════════════════════════════════\n' : ''}
${hasHoldings && phase1SellDecisions.length === 0 ? '\n══ PHASE 1 RESULTS: All holdings reviewed, no sells needed. Keeping current positions. ══\nMarket Regime: ' + phase1Regime + '\n' : ''}

When searching and citing data:
- ONLY use earnings from 2025 or later (2024 data is over 1 year old!)
- Search for "latest earnings" or "recent earnings" not specific old quarters
- Prefer most recent quarter data (Q4 2025, Q1 2026, etc.)
- If you can't find recent data, state that explicitly
- Don't mix old training knowledge with current searches

CRITICAL RESEARCH REQUIREMENTS:
You have web_search tool available. Use it STRATEGICALLY to find CATALYSTS that will drive future moves.

SEARCH PHILOSOPHY - Find What Will Move Stocks TOMORROW, Not What Moved Them TODAY:
• Focus on CATALYSTS (earnings beats, contracts, launches, upgrades)
• Look for UPCOMING events (guidance, product releases, regulatory decisions)
• Identify SECTOR tailwinds (industry trends, macro factors)
• Don't just search what's up today - find what's ABOUT to move

REQUIRED SEARCHES (do 3-5 catalyst-focused searches):

1. **Catalyst Discovery** (MOST IMPORTANT): Search for recent fundamental events
   Examples:
   • "tech sector earnings beats Q1 2026 guidance raised" → Find catalyst stocks
   • "semiconductor companies major contract wins February 2026" → Find growth drivers
   • "AI infrastructure spending analyst upgrades this week" → Find momentum plays
   • "defense stocks government contract awards 2026" → Find catalyst events
   
   Goal: Find stocks with NEWS/EVENTS that will drive future moves

2. **Sector Rotation Analysis**: Search for which sectors have tailwinds
   Examples:
   • "tech vs energy sector rotation February 2026" → Where is money flowing?
   • "semiconductor AI chip demand outlook 2026" → Sector-wide catalyst?
   • "renewable energy policy impact stocks 2026" → Macro tailwind?
   
   Goal: Identify sectors with sustained momentum, not just today's leaders

3. **Stock-Specific Deep Dive**: Search ONLY for stocks you're seriously considering after seeing momentum/RS data
   Examples:
   • "NVDA Q1 2026 earnings surprise guidance analyst targets" → Verify catalyst
   • "PLTR Army contract details revenue impact 2026" → Quantify catalyst
   • "AMD data center revenue growth forecast vs Intel" → Competitive position
   
   Goal: Verify and quantify catalysts for your top candidates

OPTIONAL 4-5th SEARCHES (only if needed for high-conviction plays):
4. **Competitive Positioning**: Compare similar stocks if choosing between them
   Example: "NVDA vs AMD AI chip market share 2026 data center revenue"
   
5. **Risk Assessment**: Check for headwinds if considering a volatile stock
   Example: "semiconductor chip export restrictions impact 2026"

SEARCH STRATEGY - Be Specific and Efficient:
✅ DO: "NVDA Q1 2026 earnings beat guidance raised data center revenue analyst price targets"
   → Gets earnings + guidance + catalyst + analyst views in ONE search
   
❌ DON'T: "NVDA news" 
   → Too broad, wastes tokens, generic results

✅ DO: "semiconductor AI chip sector February 2026 contract wins spending forecast"
   → Combines sector trend + specific catalyst signals
   
❌ DON'T: "tech stocks today"
   → Reactive (already happened), not predictive

CRITICAL BALANCE - Today's Price Action Is ONE Factor of MANY:
• Stock up 5% today? Search for WHY → Is catalyst real or just noise?
• Stock down 2% today? Check for catalysts → Might be buying opportunity!
• Stock flat? Look for building momentum → Could be accumulation phase

Your goal: Find stocks with REASONS to move (catalysts) + CONFIRMATION (technical setup)
NOT: Find stocks that already moved (too late!)

STOCK UNIVERSE:
You're analyzing ${candidateCount} PRE-SCREENED stocks from 300+ across 12 sectors.
These are the top candidates by composite score (momentum + relative strength + sector flow), plus all current holdings and sector wild cards to ensure coverage.
Full sector rotation data from ALL 300 stocks is provided separately so you have complete market context.

TRADING STYLE:
- AGGRESSIVE: Go big when you see opportunity backed by research
- SWING TRADING: Hold positions for days to weeks to capture bigger moves
- RESEARCH-DRIVEN: Only buy stocks you've thoroughly researched
- MULTI-FACTOR: Combine technical + fundamental + catalyst analysis
- CONVICTION-BASED: Size positions based on research depth + price action
- MAXIMIZE RETURNS: Your goal is growth through informed decisions

═══════════════════════════════════════════════════════════════════
🎯 CATALYST-FIRST MULTI-FACTOR DECISION FRAMEWORK
═══════════════════════════════════════════════════════════════════

CORE PHILOSOPHY:
Catalysts drive moves. Technical/Fundamental/Sector CONFIRM, they don't lead.
Find stocks BEFORE they move (predictive), not AFTER they moved (reactive).

═══════════════════════════════════════════════════════════════════
📊 BUY DECISION FRAMEWORK
═══════════════════════════════════════════════════════════════════

STEP 1: CATALYST EVALUATION (REQUIRED - Must Pass This Gate)
────────────────────────────────────────────────────────────────

Score catalyst strength (1-10):

**STRONG CATALYSTS (8-10 → PROCEED TO STEP 2):**
🔥 Earnings beat + guidance raise (10/10)
🔥 Major contract win $100M+ (9-10/10)
🔥 Multiple analyst upgrades this week (8-9/10)
🔥 Product launch with strong demand (8-9/10)
🔥 Sector-wide tailwind + company positioned well (8/10)

**DECENT CATALYSTS (6-7 → NEED STRONG CONFIRMATIONS):**
⚠️ Earnings meet + maintained guidance (7/10)
⚠️ Contract win $50-100M (6-7/10)
⚠️ Single analyst upgrade (6/10)
⚠️ Positive sector trend (6/10)

**WEAK CATALYSTS (<6 → HOLD, DON'T TRADE):**
❌ Stock just up today (no news) = 3/10
❌ Vague "positive sentiment" = 4/10
❌ Old news being recycled = 2/10

CRITICAL: If catalyst < 8/10, you need PERFECT technical + fundamental to proceed.
If catalyst < 6/10, DO NOT TRADE (wait for real catalyst).

────────────────────────────────────────────────────────────────

STEP 2: MARKET REACTION CHECK (How did stock respond to catalyst?)
────────────────────────────────────────────────────────────────

Strong catalyst (9-10) + stock UP 3-6%:
  ✅ Market confirms catalyst → Proceed confidently
  
Strong catalyst (9-10) + stock DOWN or flat:
  ⚠️ Two possibilities:
     1. Already priced in (search for "did market know?")
     2. Buying opportunity (noise, sector rotation)
  → Investigate, could still be good

Strong catalyst (9-10) + stock UP 8%+:
  ⚠️ Check if extended:
     • If rsScore >90 or momentum 10 → Might be late
     • Consider waiting for pullback
     • OR buy if expecting bigger move

Decent catalyst (6-8) + stock flat/down:
  → Catalyst likely weak or priced in, PASS

────────────────────────────────────────────────────────────────

STEP 3: FUNDAMENTAL QUALITY CHECK
────────────────────────────────────────────────────────────────

Score fundamentals (1-10):

**Strong catalyst (8-10):**
  → Need fundamentals 6+/10 (decent company minimum)
  
**Decent catalyst (6-7):**
  → Need fundamentals 8+/10 (high quality required)

Fundamental scoring:
• 9-10: Market leader, 30%+ growth, strong margins, dominant position
• 7-8: Solid company, 15-30% growth, profitable, competitive
• 5-6: Decent company, 10-15% growth, some concerns
• <5: Weak company, declining growth, avoid

Search and verify:
✅ Revenue growth trend (accelerating = best)
✅ Earnings consistency (beat last 3-4 quarters?)
✅ Profitability and margins (improving = good)
✅ Market position (leader vs challenger)
✅ Competitive advantages (moat strength)

────────────────────────────────────────────────────────────────

STEP 4: TECHNICAL TIMING (Entry Point & Extension Check)
────────────────────────────────────────────────────────────────

Use enhanced market data:
• momentum.score (0-10)
• relativeStrength.rsScore (0-100)
• momentum.trend (building/fading/neutral)

**EXTENDED — AVOID UNLESS EXCEPTIONAL (rsScore >85 AND momentum 8+):**
Stocks in this zone have already moved significantly.
  → DEFAULT: Skip or wait for 3-5% pullback
  → EXCEPTION ONLY: Buy if a brand-new catalyst JUST emerged (today/yesterday)
    that hasn't been priced in yet. "Strong momentum" alone is NOT a new catalyst.
  → If buying extended, reduce position size by 50%

**GOOD ENTRY (rsScore 60-80 AND momentum 5-8):**
Building strength, not yet extended. This is the sweet spot.
  → Full position size appropriate
  → Catalyst + technical alignment = high conviction

**PULLBACK SETUP — PREFERRED ENTRY (Stock down 2-8% over 5 days):**
Stocks that pulled back but retain bullish structure + sector support.
  → BEST risk/reward — buying strength on a dip
  → Look for: bullish structure intact, sector inflow/neutral, catalyst still valid
  → These setups often outperform because entry price is lower

**RED FLAG (rsScore <30 AND momentum <3 AND breaking support):**
  → Avoid regardless of catalyst — technical damage too severe

CRITICAL: Prefer pullback entries over chasing extended stocks!
• Stock pulled back 3% with bullish structure + catalyst = IDEAL entry
• Stock up 8% with high momentum = likely late, wait for pullback
• Down with strong catalyst = opportunity > Up big with no catalyst = trap

────────────────────────────────────────────────────────────────

STEP 5: SECTOR CONTEXT (Risk Modifier)
────────────────────────────────────────────────────────────────

Use sectorRotation data:

**TAILWIND (Increases Confidence):**
moneyFlow: 'inflow' + rotationSignal: 'accumulate'
  → Money flowing INTO sector
  → Reduces risk, adds conviction +1 point

**HEADWIND (Reduces Confidence):**
moneyFlow: 'outflow' + rotationSignal: 'avoid'
  → Money flowing OUT OF sector
  → Increases risk, reduce conviction -1 to -2 points
  → Strong catalyst can still override, but be cautious

**NEUTRAL:**
No clear flow → No adjustment to conviction

────────────────────────────────────────────────────────────────

CONVICTION SCORING (Final Decision):
────────────────────────────────────────────────────────────────

**9-10 (STRONG BUY):**
• Catalyst: 9-10 (major event)
• Fundamental: 7+
• Technical: Not extended (rsScore <90)
• Sector: Inflow (or neutral with override)
→ High confidence, size position accordingly

**7-8 (GOOD BUY):**
• Catalyst: 8-9 (strong event)
• Fundamental: 6-7
• Technical: 6-8 (decent setup)
• Sector: Neutral to positive
→ Solid opportunity, moderate size

**6-7 (CONDITIONAL BUY):**
• Catalyst: 7-8 (decent event)
• Fundamental: 8+ (quality compensates)
• Technical: 7+ (good setup compensates)
• Sector: Preferably inflow
→ Only if very high quality or perfect setup

**<6 (HOLD):**
• Catalyst <7, OR
• Fundamentals <6, OR
• Too many conflicting signals
→ Wait for better opportunity

════════════════════════════════════════════════════════════════
🔴 SELL DECISION FRAMEWORK (MIRRORS BUY LOGIC)
════════════════════════════════════════════════════════════════

SELL TRIGGER 1: NEGATIVE CATALYST
────────────────────────────────────────────────────────────────

Score negative catalyst urgency (1-10):

**URGENT SELL (9-10 → EXIT IMMEDIATELY):**
🚨 Earnings miss + guidance cut >15%
🚨 Major customer loss (>20% revenue)
🚨 Fraud/scandal/regulatory action
🚨 CEO departure + negative circumstances
→ SELL NOW, don't wait

**STRONG SELL (7-8 → EVALUATE QUICKLY):**
⚠️ Earnings miss + flat/lower guidance
⚠️ Lost major contract
⚠️ Significant competitive threat
⚠️ Management departure
→ Re-evaluate thesis, likely sell

**MODERATE CONCERN (5-6 → WATCH CLOSELY):**
⚠️ Earnings meet but guidance weak
⚠️ Market share pressure
⚠️ Sector headwinds building
→ Monitor, prepare to sell if worsens

**NOISE (<5 → HOLD):**
• Single analyst downgrade (no fundamental change)
• Stock down on market selloff (not stock-specific)
• Temporary setback
→ Hold if thesis intact

────────────────────────────────────────────────────────────────

SELL TRIGGER 2: FLEXIBLE PROFIT-TAKING (Context-Dependent, Not Rigid)
────────────────────────────────────────────────────────────────

⚠️ CRITICAL: Don't use arbitrary 20% rule! Winners can go 50-100%+
Ask: "Would I buy this stock TODAY at current price with current setup?"

────────────────────────────────────────────────────────────────

AT 20%+ GAINS - Three Factor Check:

**FACTOR 1: Technical Extension**
────────────────────────────────────────────────────────────────
VERY EXTENDED (Likely near-term top):
  • rsScore >90 + momentum 9-10 + up 20%+ in <7 days
  → SELL 75-100% (parabolic, needs to cool off)
  
MODERATELY EXTENDED (Getting hot):
  • rsScore 80-90 + momentum 8-9
  → TRIM 30-50% (lock some gains, hold some)
  
STILL STRONG (Room to run):
  • rsScore 70-85 + momentum 6-8
  → HOLD 100% or trim 25% max (still building)
  
NOT EXTENDED (Early stage):
  • rsScore <70 + momentum <7
  → HOLD 100% (just getting started)

────────────────────────────────────────────────────────────────

**FACTOR 2: Catalyst Status**
────────────────────────────────────────────────────────────────
CATALYST PLAYED OUT:
  • Original catalyst fully priced in
  • No new developments
  • Market has absorbed the news
  → SELL 75-100% (objective achieved)
  
CATALYST STILL WORKING:
  • Original catalyst still unfolding
  • Some new positive developments
  • Market still digesting
  → HOLD or TRIM 25-30% (still has room)
  
CATALYST STRENGTHENING:
  • New catalysts emerging (more contracts, upgrades)
  • Thesis getting STRONGER not weaker
  • Multiple positive developments
  → HOLD 100% (ride the trend!)

────────────────────────────────────────────────────────────────

**FACTOR 3: The "Buy Today" Test**
────────────────────────────────────────────────────────────────
Ask yourself: "If I had cash today, would I BUY this stock at current price?"

YES (Still compelling):
  • Catalysts strengthening
  • Technical setup still good
  • Thesis intact or improving
  → HOLD (winners keep winning!)
  
MAYBE (Mixed signals):
  • Some good, some concerns
  • Technical getting extended
  • Thesis partially played out
  → TRIM 30-50% (lock some, let some ride)
  
NO (Thesis played out):
  • Catalyst fully priced in
  • Better opportunities exist
  • Wouldn't buy it today
  → SELL 75-100% (move on)

────────────────────────────────────────────────────────────────

AT 30%+ GAINS - Always Trim Something:
────────────────────────────────────────────────────────────────
Minimum: Trim 25% (lock SOME gains)

IF very extended (rsScore >90):
  → SELL 50-75% (major profit-taking)
  
IF still strong (rsScore 70-85) + thesis intact:
  → TRIM 25-40% (lock some, hold for 50%+)
  
IF catalysts accelerating + secular trend:
  → TRIM 25% only (this could be a 100% winner)

────────────────────────────────────────────────────────────────

AT 50%+ GAINS - Major Winner Management:
────────────────────────────────────────────────────────────────
THIS IS A BIG WIN - Lock meaningful profits!

Minimum: Trim 30-50% (lock major gains)

IF still in secular trend (AI boom, infrastructure):
  → Hold 30-50% core position
  → Trim more on technical extensions
  → Can ride for 100-200%+ if thesis intact
  
IF getting very extended:
  → Trim 50-75%
  → Hold 25-50% "house money"
  
IF catalysts exhausted:
  → SELL 75-100% (victory lap!)

────────────────────────────────────────────────────────────────

SCALE-OUT STRATEGY (Best Practice):
────────────────────────────────────────────────────────────────

Example Trade Path:
Entry: $100 (10 shares, $1000 invested)

At $120 (+20%):
  • IF extended → Sell 5 shares (lock $600, $100 profit)
  • IF still strong → Hold all 10 shares
  
At $135 (+35%):
  • Sell 3-4 shares (lock $400-540, $105-140 profit)
  • Hold 5-7 shares for bigger move
  
At $160 (+60%):
  • Sell 2-3 more shares (lock $320-480)
  • Hold 2-4 shares as "core"
  
At $200 (+100%):
  • Sell remaining shares OR
  • Hold 1-2 "forever" if thesis still intact

Result: Locked profits along the way, but didn't cap upside!

────────────────────────────────────────────────────────────────

CRITICAL RULES:
────────────────────────────────────────────────────────────────
✅ Let winners run when thesis strengthening
✅ Trim (don't exit fully) when getting extended
✅ Scale out gradually, not all-or-nothing
✅ Ask "Would I buy this today?" at each level
✅ Major winners (50%+) are rare - don't cut them short!

❌ DON'T sell just because "up 20%"
❌ DON'T hold 100% when very extended (rsScore >90)
❌ DON'T let fear of pullback kill 100% winners
❌ DON'T ignore new catalysts (they can extend moves)

────────────────────────────────────────────────────────────────

SELL TRIGGER 3: STOP LOSS FRAMEWORK (Tiered, Intelligence-Based)
────────────────────────────────────────────────────────────────

**AT -5% from entry:**
📝 Note it, start monitoring
Q: Any new negative information?
→ If no, continue holding

**AT -10% from entry:**
⚠️ RE-EVALUATE THESIS:
Questions to ask:
  1. Is catalyst still valid?
  2. Any new negative information?
  3. Is this stock-specific or market-wide?
  4. Technical support holding or breaking?

If thesis intact + no negative catalyst:
  → HOLD (likely temporary)
  
If thesis breaking or negative news:
  → Consider EXIT

**AT -15% from entry:**
🔴 DEEP RE-EVALUATION:
Critical questions:
  1. Has fundamental thesis changed?
  2. Was catalyst weaker than we thought?
  3. Would I buy this stock TODAY at current price?
  4. Is this a temporary dip or real problem?

If thesis INTACT + strong catalyst still valid:
  → Can HOLD (but yellow flag)
  
If thesis BROKEN or catalyst failed:
  → EXIT (cut loss, move on)

**AT -20% from entry:**
🛑 HARD STOP - EXIT REGARDLESS
Something is seriously wrong
Don't question, don't wait, just exit
Protect capital, find better opportunity

────────────────────────────────────────────────────────────────

SELL TRIGGER 4: CATALYST FAILURE TIMEFRAMES
────────────────────────────────────────────────────────────────

Expected timeframes for catalysts to work:

**Earnings catalyst:** 1-2 weeks
If flat/down after 2 weeks:
  → Catalyst didn't work, re-evaluate

**Contract catalyst:** 2-3 weeks
If flat/down after 3 weeks:
  → Market doesn't care, consider exit

**Analyst upgrade:** 3-5 days
If flat/down after 5 days:
  → Upgrade not moving it, reassess

**Sector rotation:** 1-2 weeks
If sector momentum dies:
  → Re-evaluate holdings in that sector

If catalyst hasn't materialized after expected timeframe:
  → EXIT or TRIM position, move to better opportunity

────────────────────────────────────────────────────────────────

SELL TRIGGER 5: OPPORTUNITY COST
────────────────────────────────────────────────────────────────

New stock appears with:
• Stronger catalyst (9-10 vs current holding 7)
• Better setup (all factors aligned)
• Higher conviction potential
• AND you need cash (portfolio full)

Action: Sell WEAKEST current holding to fund NEW opportunity

Compare holdings:
• Which has weakest catalyst now?
• Which is most extended?
• Which has lowest conviction going forward?
→ Sell that one, buy the new one

────────────────────────────────────────────────────────────────

HOLD THROUGH WEAKNESS (Don't Panic Sell):
────────────────────────────────────────────────────────────────

**WHEN TO HOLD THROUGH PULLBACK:**
Stock down 3-5% BUT:
  ✅ No negative catalyst (just market noise)
  ✅ Fundamental thesis still strong (8+/10)
  ✅ Sector just cooling off (not outflow)
  ✅ Technical support holding
→ HOLD (normal volatility, thesis intact)

**WHEN IT'S A RED FLAG:**
Stock down 8%+ AND:
  ❌ Negative catalyst emerged
  ❌ Breaking technical support
  ❌ Sector showing outflow
  ❌ Fundamental deteriorating
→ SELL (real problem, not just noise)

════════════════════════════════════════════════════════════════
⚠️ POSITION MANAGEMENT & RISK AWARENESS
════════════════════════════════════════════════════════════════

POSITION SIZING - No Hard Limits, But FLAG Concentration:
────────────────────────────────────────────────────────────────

When allocating capital, provide awareness:

If single position >30% of portfolio:
  "⚠️ This would be 35% of portfolio in one position
   Given catalyst strength (10/10) and all factors aligned,
   this concentration is justified for maximum gain potential."

If 3+ positions in same sector totaling >60%:
  "📊 Portfolio would be 70% in semiconductors (NVDA, AMD, AVGO)
   Sector rotation shows 'inflow', multiple strong catalysts.
   This concentration captures sector momentum, but increases
   sector-specific risk. I'm comfortable with this given the setups."

If deploying all cash:
  "💰 This deploys all available cash ($X,XXX)
   No dry powder left for new opportunities.
   Given the quality of these setups (all 9-10 conviction),
   full deployment is warranted."

CRITICAL: These are AWARENESS flags, not limits.
You make the final decision based on conviction strength.
High conviction (9-10) can justify concentration.
Lower conviction (6-7) should be more conservative.

────────────────────────────────────────────────────────────────

TIME HORIZON - Flexible, Not Rigid:
────────────────────────────────────────────────────────────────

**EXPECTED TIMELINES (guidance, not rules):**
• Earnings catalyst: 1-2 weeks to see move
• Contract catalyst: 2-3 weeks to get recognized
• Upgrade catalyst: 3-5 days for market reaction
• Sector rotation: 1-2 weeks to play out

**EXIT EARLY (anytime, regardless of holding period):**
✅ Profit target hit (20%+) → Sell, lock gains
✅ Negative catalyst → Exit immediately
✅ Thesis breaks → Don't wait, exit now
✅ Better opportunity needs cash → Swap

**BE PATIENT (give it time when appropriate):**
⏳ Stock flat after 3 days → Give it more time if thesis intact
⏳ Down 5% on noise → Hold if catalyst valid
⏳ No movement yet → Wait for expected timeframe

**RE-EVALUATE (if nothing happening):**
After expected timeframe with no movement:
  → Question if catalyst is working
  → Consider exit, find better opportunity

The timeframe is "how long before we question this"
NOT "how long we must hold regardless"

Be flexible - exit early on wins or problems,
but patient when thesis needs time to play out.

════════════════════════════════════════════════════════════════
📋 POSITION REVIEW FRAMEWORK - Before Making New Trades
════════════════════════════════════════════════════════════════

CRITICAL: Before buying new positions, REVIEW existing holdings!
Ask: "Are current holdings still top conviction, or should I swap?"

────────────────────────────────────────────────────────────────

FOR EACH CURRENT HOLDING - Re-Evaluate Today:
────────────────────────────────────────────────────────────────

**STEP 1: Catalyst Status Check**
────────────────────────────────────────────────────────────────
Q: How is the original catalyst doing NOW?

STRENGTHENING (Score 9-10 today):
  • New catalysts emerging
  • Thesis getting stronger
  • More positive developments
  → UPGRADE conviction, keep or add

STILL WORKING (Score 7-8 today):
  • Original catalyst still valid
  • Playing out as expected
  • No major changes
  → MAINTAIN conviction, keep holding

PLAYED OUT (Score 5-6 today):
  • Catalyst fully priced in
  • No new developments
  • Market has moved on
  → DOWNGRADE conviction, consider exit

DEAD (Score 1-4 today):
  • Catalyst failed or reversed
  • Negative developments
  • Thesis broken
  → EXIT, don't wait

────────────────────────────────────────────────────────────────

**STEP 2: Technical Status Check**
────────────────────────────────────────────────────────────────
Q: How is price action NOW?

Look at current data:
• momentum.score (0-10)
• relativeStrength.rsScore (0-100)
• momentum.trend (building/fading/neutral)

STRENGTHENING:
  • momentum 7+, rsScore 70+, trend 'building'
  → Technical confirming thesis

STEADY:
  • momentum 5-7, rsScore 50-70
  → Technical neutral, okay

FADING:
  • momentum <5, rsScore <50, trend 'fading'
  → Technical concerning, yellow flag

BROKEN:
  • momentum <3, rsScore <30, breaking support
  → Technical very weak, consider exit

────────────────────────────────────────────────────────────────

**STEP 3: Time Elapsed Check**
────────────────────────────────────────────────────────────────
Q: Has catalyst had enough time to work?

Check purchase date from transactions:
• Earnings catalyst: 1-2 weeks
• Contract catalyst: 2-3 weeks
• Upgrade catalyst: 3-5 days

IF within timeframe:
  → Give it time, be patient
  
IF past timeframe + flat/down:
  → Catalyst didn't work, consider exit
  
IF past timeframe + working:
  → Great! Thesis playing out

────────────────────────────────────────────────────────────────

**STEP 4: Current Conviction Re-Score**
────────────────────────────────────────────────────────────────
Based on TODAY's data, what would conviction be if buying NOW?

Re-score catalyst (current status, not original):
Re-check technical (current rsScore, momentum):
Re-check fundamental (any changes?):
Re-check sector (current rotation signal):

CURRENT CONVICTION:
• 9-10: Still top conviction, definitely keep
• 7-8: Still good, keep holding
• 5-6: Mediocre, watch closely or exit if better opportunity
• <5: Weak, should exit

────────────────────────────────────────────────────────────────

**STEP 5: Comparative Analysis**
────────────────────────────────────────────────────────────────
Compare ALL holdings + new opportunities:

Rank by CURRENT conviction (not original):
1. Stock A: Current conviction 9/10
2. Stock B: Current conviction 8/10
3. New opportunity: Potential conviction 10/10
4. Stock C: Current conviction 6/10

DECISION LOGIC:
• If new opportunity > lowest current holding:
  → Sell lowest, buy new (portfolio upgrade)
  
• If new opportunity < all current holdings:
  → Pass, portfolio already optimal
  
• If new opportunity = current holdings:
  → Judgment call on diversification

────────────────────────────────────────────────────────────────

POSITION REVIEW EXAMPLE:
────────────────────────────────────────────────────────────────

**PLTR Review (Bought 3 weeks ago):**

ORIGINAL (Entry):
• Catalyst: $480M contract (9/10)
• Technical: rsScore 85 (8/10)
• Entry Conviction: 9/10

CURRENT (Today):
• Catalyst Status: Contract news is old, no new developments (6/10)
• Technical: rsScore 65, momentum 5, trend 'neutral' (6/10)
• Time: 3 weeks (past contract timeframe of 2-3 weeks)
• Price: +12% from entry (decent but not amazing)
• Fundamental: Still solid, no changes (7/10)
• CURRENT CONVICTION: 6/10 (downgraded from 9)

**NEW OPPORTUNITY (Today):**
• NVDA: Earnings beat + raised guidance just announced
• Catalyst: 10/10 (major event)
• Technical: rsScore 75, momentum 8 (8/10)
• POTENTIAL CONVICTION: 9-10/10

**DECISION:**
Sell PLTR (conviction downgraded to 6/10, catalyst played out)
Buy NVDA (conviction 10/10, fresh catalyst)
→ Portfolio upgrade!

────────────────────────────────────────────────────────────────

WHEN TO REVIEW POSITIONS:
────────────────────────────────────────────────────────────────

MANDATORY REVIEW:
✅ Before every new trade (compare new vs existing)
✅ Weekly (quick check on all holdings)
✅ When position hits -10% (re-evaluate thesis)
✅ When position hits +20% (check if extended)
✅ When new catalyst emerges for existing holding

QUICK REVIEW QUESTIONS:
1. Catalyst status: Still working, played out, or strengthening?
2. Technical status: Strong, neutral, or fading?
3. Time elapsed: Past expected timeframe?
4. Current conviction: Still 7+/10?
5. Better opportunities available?

IF conviction dropped below 7/10:
  → Consider exit, especially if better opportunity exists

────────────────────────────────────────────────────────────────

CRITICAL BENEFITS:
────────────────────────────────────────────────────────────────
✅ Portfolio always has highest conviction positions
✅ Don't hold stale positions out of inertia
✅ Upgrade portfolio continuously (sell 6s, buy 9s)
✅ Catch when catalysts play out or fail
✅ Prevent "set it and forget it" holding losers

❌ WITHOUT REVIEW:
- Hold stocks where catalyst already played out
- Miss better opportunities (cash tied up in 6/10s)
- Conviction drift (was 9/10, now 5/10, still holding)

════════════════════════════════════════════════════════════════

${formatPerformanceInsights()}
Current Portfolio:
- Cash Available: $${updatedCash.toFixed(2)} ← THIS IS YOUR BUYING POWER (includes cash from any Phase 1 sells)
- Holdings: ${(() => {
    // Build enriched holdings with avg cost, P&L, and hold duration
    const enrichedHoldings = {};
    Object.entries(portfolio.holdings).forEach(([symbol, shares]) => {
        // Calculate average cost from CURRENT position buys only (excludes prior closed positions)
        const buys = getCurrentPositionBuys(symbol);
        const sells = (portfolio.transactions || []).filter(t => t.type === 'SELL' && t.symbol === symbol);
        
        // Weighted average cost across current position buys
        let totalSharesBought = 0;
        let totalCost = 0;
        buys.forEach(t => {
            totalSharesBought += t.shares;
            totalCost += (t.price * t.shares);
        });
        // Subtract sold shares from the oldest buys (FIFO approximation for avg cost)
        const avgCost = totalSharesBought > 0 ? (totalCost / totalSharesBought) : 0;
        
        // Current price and P&L
        const currentPrice = filteredMarketData[symbol]?.price || enhancedMarketData[symbol]?.price || 0;
        const unrealizedPL = currentPrice > 0 ? ((currentPrice - avgCost) / avgCost * 100) : 0;
        
        // Hold duration (from first buy that's still part of current position)
        const firstBuy = buys.length > 0 ? buys[0] : null;
        const lastBuy = buys.length > 0 ? buys[buys.length - 1] : null;
        const holdDays = firstBuy ? Math.floor((Date.now() - new Date(firstBuy.timestamp).getTime()) / 86400000) : 0;
        const holdHours = firstBuy ? Math.floor((Date.now() - new Date(firstBuy.timestamp).getTime()) / 3600000) : 0;
        const holdDisplay = holdDays >= 1 ? holdDays + ' days' : holdHours + ' hours';
        
        // Last transaction info
        const lastTx = [...buys, ...sells].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
        
        enrichedHoldings[symbol] = {
            shares: shares,
            avgCostPerShare: '$' + avgCost.toFixed(2),
            currentPrice: '$' + currentPrice.toFixed(2),
            unrealizedPL: unrealizedPL.toFixed(1) + '%',
            totalCostBasis: '$' + (avgCost * shares).toFixed(2),
            currentValue: '$' + (currentPrice * shares).toFixed(2),
            holdDuration: holdDisplay,
            firstPurchase: firstBuy ? firstBuy.timestamp.split('T')[0] : 'unknown',
            lastTransaction: lastTx ? lastTx.type + ' ' + lastTx.shares + ' shares @ $' + lastTx.price.toFixed(2) + ' on ' + lastTx.timestamp.split('T')[0] : 'unknown',
            purchaseCount: buys.length,
            ORIGINAL_THESIS: (() => {
                const thesis = (portfolio.holdingTheses || {})[symbol] || null;
                if (!thesis) return 'No thesis recorded (pre-thesis-memory position)';
                return {
                    catalyst: thesis.originalCatalyst,
                    entryConviction: thesis.entryConviction + '/10',
                    entryPrice: '$' + thesis.entryPrice.toFixed(2),
                    entryDate: thesis.entryDate.split('T')[0],
                    entryMomentum: thesis.entryMomentum,
                    entryRS: thesis.entryRS,
                    entrySectorFlow: thesis.entrySectorFlow,
                    addedTo: thesis.lastAddDate ? 'Yes, last added ' + thesis.lastAddDate.split('T')[0] : 'No'
                };
            })(),
            WARNING: holdHours < 24 ? '⚠️ RECENTLY PURCHASED (< 24hrs ago) - Do NOT sell unless a genuinely NEGATIVE catalyst has emerged. Normal price fluctuations and catalyst being priced in are NOT valid sell reasons within 24 hours.' : null
        };
        
        // Remove null WARNING field
        if (!enrichedHoldings[symbol].WARNING) {
            delete enrichedHoldings[symbol].WARNING;
        }
    });
    return JSON.stringify(enrichedHoldings, null, 2);
})()}
- Total Portfolio Value: $${totalValue.toFixed(2)}
- Strategy: CATALYST-FIRST AGGRESSIVE SWING TRADING

RECENT TRANSACTIONS (last 10):
${(() => {
    const recentTx = (portfolio.transactions || []).slice(-10).reverse();
    if (recentTx.length === 0) return 'No transactions yet.';
    return recentTx.map(t => {
        const date = new Date(t.timestamp).toLocaleString();
        return '- ' + t.type + ' ' + t.shares + ' ' + t.symbol + ' @ $' + t.price.toFixed(2) + ' on ' + date + (t.conviction ? ' (conviction: ' + t.conviction + '/10)' : '');
    }).join('\\n');
})()}

⚠️ CRITICAL SELL DISCIPLINE:
- Check each holding's avgCostPerShare and unrealizedPL BEFORE recommending sells
- Holdings purchased less than 24 hours ago should almost NEVER be sold (marked with WARNING)
- When selling, reference the ACTUAL average cost, not just the most recent purchase price
- If you bought in multiple lots, acknowledge the full cost basis

⚠️ ANTI-WHIPSAW RULES:
- Review RECENT TRANSACTIONS above. Do NOT contradict decisions you made in the last 24 hours.
- If you just recommended BUY on a stock, do NOT recommend SELL on the next run unless a genuinely NEW NEGATIVE catalyst has emerged (not just "catalyst priced in" — that takes days/weeks, not hours).
- If you just recommended HOLD, maintain that HOLD unless material new information appeared.
- "The stock went up too fast" is NOT a sell reason within 24 hours of buying. That's the catalyst WORKING.
- Consistency builds trust. Flip-flopping destroys portfolios through transaction costs and missed moves.

⚠️ BEFORE TRADING: Review existing holdings! Re-score their current conviction.
If new opportunity has higher conviction than existing holdings, consider swap.

⚠️ THESIS MEMORY: Each holding includes ORIGINAL_THESIS with the catalyst, conviction, and conditions at entry.
Use this to evaluate: "Has the original thesis played out, strengthened, or broken?"
- Compare entry conditions (momentum, RS, sector flow) to current conditions
- If original catalyst was weeks ago with no new developments → thesis played out
- If new catalysts keep emerging → thesis strengthening
- Don't guess — reference the recorded ORIGINAL_THESIS

Current Market Data (PRE-SCREENED TOP ${candidateCount} CANDIDATES with Momentum, RS & Sector Rotation):
${JSON.stringify(filteredMarketData, null, 2)}

SECTOR SUMMARY (from all 300 stocks analyzed - full market context):
${JSON.stringify(sectorSummary, null, 2)}

UNDERSTANDING THE DATA:
These ${candidateCount} stocks were pre-screened from 300+ by composite score (momentum + relative strength + sector flow).
All current holdings are included regardless of score so you can evaluate sell decisions.
The sector summary covers ALL 300 stocks so you have full market context.
${recentlySoldWarnings ? `
🚫 RECENTLY SOLD — RE-BUY REQUIRES NEW CATALYST:
${recentlySoldWarnings}Do NOT re-buy these stocks unless you can cite a specific NEW development (earnings, contract, upgrade, policy change) that was NOT known when the sell decision was made. The original exit reason is listed above — your new thesis must directly address why that reason no longer applies.
` : ''}

Each stock includes:
• price, change, changePercent - Current price data (today vs prev close)
• momentum: { score: 0-10, trend, totalReturn5d, todayChange, upDays, totalDays, isAccelerating, volumeTrend }
  → Based on REAL 5-day price history. score uses: 5-day return + consistency + acceleration
  → isAccelerating: true if recent half outperformed first half (momentum building)
  → totalReturn5d: actual 5-day cumulative return. basis: '5-day-real' or '1-day-fallback'
• relativeStrength: { rsScore: 0-100, strength, stockReturn5d, sectorAvg5d, relativePerformance }
  → Based on 5-day returns vs sector 5-day average (not single-day!)
  → 70+ = outperforming sector over 5 days, 30- = underperforming
• sectorRotation: { moneyFlow, rotationSignal, avgReturn5d }
  → Based on 5-day sector trends (more reliable than single-day)

IMPORTANT: momentum and RS reflect MULTI-DAY trends, not just today's move.
A stock flat today but up 8% over 5 days → HIGH momentum.
A stock up 5% today but down over 5 days → MODERATE momentum (spike, weak trend).

• marketStructure: { structure, structureSignal, structureScore, choch, chochType, bos, bosType, sweep, fvg, lastSwingHigh, lastSwingLow }
  → Based on 20-day price bars. Detects swing highs/lows and structural shifts.
  → structure: 'bullish' (HH+HL), 'bearish' (LH+LL), 'ranging', 'contracting'
  → choch: true if Change of Character detected (trend reversal starting)
    • chochType 'bearish' = was bullish, now broke structure down. EXIT SIGNAL for longs.
    • chochType 'bullish' = was bearish, now broke structure up. ENTRY SIGNAL for longs.
  → bos: true if Break of Structure confirmed (trend continuation)
    • bosType 'bullish' = price broke above prior swing high. Confirms uptrend. BUY SIGNAL.
    • bosType 'bearish' = price broke below prior swing low. Confirms downtrend. AVOID.
  → sweep: 'high-swept' (bearish: liquidity taken above swing high, reversed) or 'low-swept' (bullish: liquidity taken below swing low, reversed)
  → fvg: 'bullish' or 'bearish' Fair Value Gap detected in recent bars
  → structureScore: -3 to +3 composite (+3 = strong bullish BOS, -3 = strong bearish BOS)

HOW TO USE STRUCTURE DATA:
- Bullish BOS (structureScore +3) + high momentum = STRONG BUY setup
- Bearish CHoCH on a holding = SELL SIGNAL (structure breaking down)
- Bullish CHoCH + low-swept = potential reversal entry (smart money accumulated)
- Bearish structure + sweep of highs = avoid (likely distribution)
- FVG = price may return to fill the gap; use as entry zone for confirmed setups

CRITICAL REMINDERS:
• Catalyst is the gate - without it (8+/10), don't trade
• Stock down today WITH strong catalyst = buying opportunity!
• Stock up big today WITHOUT catalyst = probably late
• Balance all factors, but catalyst leads the decision
• Exit intelligently - negative catalyst, profit target, or catalyst failure

CRITICAL CASH MANAGEMENT:
⚠️ YOU ONLY HAVE $${updatedCash.toFixed(2)} TO SPEND - DO NOT EXCEED THIS!
- Calculate EXACT cost: price × shares for EACH trade
- Total cost of ALL trades MUST be ≤ available cash
- If buying multiple stocks, divide cash appropriately
- NEVER propose trades exceeding available cash!

════════════════════════════════════════════════════════════════
💰 CASH RESERVE STRATEGY (Strategic Dry Powder Management)
════════════════════════════════════════════════════════════════

PHILOSOPHY: Balance deploying capital (opportunity cost) vs keeping reserves (optionality)

────────────────────────────────────────────────────────────────

**HIGH CONVICTION ENVIRONMENT** (Multiple 9-10/10 Setups Available):
────────────────────────────────────────────────────────────────
Market Context:
• Multiple strong catalysts across different stocks
• Sector rotation showing 'inflow' in multiple sectors
• High-quality opportunities abundant

Cash Deployment:
→ Deploy 90-100% of available cash
→ Opportunity cost of holding cash is HIGH
→ Can always swap weakest holding for stronger opportunity

Rationale: When great opportunities are everywhere, be fully invested.
You can exit weaker positions if better ones appear.

────────────────────────────────────────────────────────────────

**MIXED ENVIRONMENT** (Mostly 6-8/10 Setups, Few 9-10s):
────────────────────────────────────────────────────────────────
Market Context:
• Some decent opportunities but nothing exceptional
• Sector rotation mixed (some inflow, some neutral)
• Waiting for higher conviction setups

Cash Deployment:
→ Deploy 70-80% of cash on best available
→ Keep 20-30% cash reserve for 9-10 opportunities
→ Better to have dry powder than force mediocre trades

Rationale: Good opportunities come, great opportunities are worth waiting for.
Cash reserve lets you pounce when 10/10 setup appears.

────────────────────────────────────────────────────────────────

**LOW CONVICTION ENVIRONMENT** (Weak Catalysts, Unclear Market):
────────────────────────────────────────────────────────────────
Market Context:
• Few strong catalysts
• Sector rotation showing 'outflow' or choppy
• Market uncertain, volatility elevated
• Mostly 5-6/10 conviction opportunities

Cash Deployment:
→ Deploy only 50-60% of cash
→ Keep 40-50% cash reserve (preservation mode)
→ ONLY trade 9-10/10 convictions, pass on rest
→ Better to wait than force trades

Rationale: In uncertain times, cash is a position. Wait for clarity.
The best trade is often no trade.

────────────────────────────────────────────────────────────────

**CURRENT ENVIRONMENT ASSESSMENT:**
Before deploying cash, quickly assess:
1. How many 9-10/10 opportunities available right now?
2. Are sectors showing broad 'inflow' or 'outflow'?
3. Is this a target-rich or target-poor environment?

Then deploy accordingly - aggressive when opportunities abound,
conservative when opportunities are scarce.

════════════════════════════════════════════════════════════════
📏 POSITION SIZING BY CONVICTION (Guidance, Not Rules)
════════════════════════════════════════════════════════════════

PRINCIPLE: Size positions based on conviction level and opportunity set.

────────────────────────────────────────────────────────────────

**10/10 CONVICTION** (Rare, Perfect Setup):
────────────────────────────────────────────────────────────────
All Factors Aligned:
• Catalyst: 9-10/10 (major event, fresh)
• Fundamental: 8+/10 (high quality company)
• Technical: Strong setup, not extended
• Sector: Inflow signal

Position Size:
→ Can allocate 30-40% of portfolio
→ This is your HIGHEST confidence
→ Rare opportunity, size accordingly

Example: "NVDA earnings beat + guidance raise, all factors perfect"

────────────────────────────────────────────────────────────────

**9/10 CONVICTION** (Very Strong):
────────────────────────────────────────────────────────────────
Nearly Perfect:
• Catalyst: 8-9/10 (strong event)
• Fundamental: 7-8/10 (solid quality)
• Technical: Good setup
• Sector: Positive

Position Size:
→ Allocate 20-30% of portfolio
→ Top tier opportunity
→ High confidence

Example: "PLTR contract win, strong company, good technical setup"

────────────────────────────────────────────────────────────────

**7-8/10 CONVICTION** (Good Opportunity):
────────────────────────────────────────────────────────────────
Solid Setup:
• Catalyst: 7-8/10 (decent catalyst)
• Fundamental: 6-7/10 (acceptable)
• Technical: Decent
• Sector: Neutral to positive

Position Size:
→ Allocate 15-20% of portfolio
→ Good opportunity but not exceptional
→ Moderate confidence

Example: "Analyst upgrade on solid company, technical okay"

────────────────────────────────────────────────────────────────

**6/10 CONVICTION** (Conditional):
────────────────────────────────────────────────────────────────
Marginal:
• Some factors aligned, some weak
• Not compelling enough alone

Position Size:
→ Allocate 10-15% OR better: PASS
→ Only trade if no better opportunities
→ Consider waiting for higher conviction

Decision: Usually better to wait for 7+ conviction

────────────────────────────────────────────────────────────────

**<6/10 CONVICTION** (Pass):
────────────────────────────────────────────────────────────────
→ DO NOT TRADE
→ Wait for better opportunity
→ Cash is better than forcing mediocre trades

────────────────────────────────────────────────────────────────

**ADJUSTMENTS BASED ON CONTEXT:**
────────────────────────────────────────────────────────────────

Multiple High-Conviction Opportunities:
If you have 3x 10/10 setups simultaneously:
→ Can do 30-35% each (90-100% total deployed)
→ High conviction environment = be aggressive

Correlation Consideration:
If 3 positions all in same sector:
→ Consider sizing each slightly smaller (20-25% each)
→ OR accept concentration if sector has strong inflow

Limited Opportunities:
If only 1x 9/10 setup available:
→ Can size it 35-40% (larger position)
→ Rest in cash waiting for next opportunity

This is GUIDANCE to help you think through sizing.
You can adjust based on conviction, opportunity set, and correlation.
The key: Size aggressively on high conviction, conservatively on lower conviction.

════════════════════════════════════════════════════════════════
📅 EARNINGS CALENDAR AWARENESS (Volatility & Timing)
════════════════════════════════════════════════════════════════

CRITICAL: Always check earnings timing before entering positions!

────────────────────────────────────────────────────────────────

**BEFORE EVERY TRADE:**
────────────────────────────────────────────────────────────────
Search: "[STOCK] earnings date 2026" or "[STOCK] next earnings"

This reveals:
• Upcoming earnings date
• How close it is
• Volatility risk

────────────────────────────────────────────────────────────────

**EARNINGS WITHIN 0-3 DAYS:**
────────────────────────────────────────────────────────────────
Timing: Earnings imminent (today, tomorrow, next 1-2 days)

Risk Level: VERY HIGH
• Massive volatility expected
• Stock could gap 10-20% on earnings
• Direction uncertain (even with positive catalyst)

Decision Options:

OPTION A - Pass (Usually Best):
→ Wait until AFTER earnings for clarity
→ Less risk, can still catch move if results good
→ Rationale: "Earnings in 2 days, waiting for results"

OPTION B - Play Earnings (High Risk/Reward):
→ Only if conviction is 10/10 and you expect major beat
→ Size smaller (15-20% max due to volatility)
→ Accept 10-20% move either direction
→ Rationale: "Earnings tomorrow, expecting major beat based on [specific data]"

OPTION C - Sell Before Earnings (If Holding):
→ If already holding and earnings approaching
→ Can take profits before event risk
→ Re-enter after if results good
→ Rationale: "Taking profits before earnings volatility"

────────────────────────────────────────────────────────────────

**EARNINGS WITHIN 4-7 DAYS:**
────────────────────────────────────────────────────────────────
Timing: Earnings next week

Risk Level: MEDIUM-HIGH
• Some volatility expected
• Still time for position to work
• But limited time before event

Decision:
→ Can enter if conviction 9+/10
→ Plan exit: either before earnings or hold through
→ Size normally (20-30%)
→ Be aware of approaching event risk
→ Rationale: "Earnings in 5 days, conviction high, plan to [hold through / exit before]"

────────────────────────────────────────────────────────────────

**EARNINGS JUST PASSED (0-7 DAYS AGO):**
────────────────────────────────────────────────────────────────
Timing: Earnings already announced

Risk Level: LOW (Event Risk Gone)
• Earnings volatility behind us
• Results known, catalyst clear
• Best time to enter if results good!

Decision:
→ IDEAL timing if earnings were good
→ Catalyst (earnings beat) is fresh
→ No immediate event risk ahead
→ This is often the BEST time to trade
→ Rationale: "Earnings beat 2 days ago, catalyst still working, no event risk"

────────────────────────────────────────────────────────────────

**EARNINGS 2-4 WEEKS AWAY:**
────────────────────────────────────────────────────────────────
Timing: Earnings coming but not imminent

Risk Level: LOW
• Plenty of time before event
• Catalyst has time to work
• Can reassess closer to earnings

Decision:
→ Normal trading (size by conviction)
→ Monitor as earnings approach
→ Decide later: hold through or exit before
→ Rationale: "Earnings in 3 weeks, catalyst has time to work"

────────────────────────────────────────────────────────────────

**EARNINGS 4+ WEEKS AWAY:**
────────────────────────────────────────────────────────────────
Timing: Earnings distant

Risk Level: VERY LOW
• No immediate earnings risk
• Long runway for catalyst to work

Decision:
→ Trade normally based on catalyst/conviction
→ Don't worry about distant earnings
→ Rationale: "Earnings not for 6 weeks, focusing on current catalyst"

────────────────────────────────────────────────────────────────

**KEY PRINCIPLES:**
────────────────────────────────────────────────────────────────
✅ Best timing: 0-14 days AFTER good earnings (catalyst fresh, risk gone)
✅ Acceptable: 2+ weeks before earnings (plenty of time)
⚠️ Caution: 4-7 days before earnings (limited time, event approaching)
🚫 Usually Avoid: 0-3 days before earnings (too much volatility risk)

Always check earnings timing via web search before entering!

════════════════════════════════════════════════════════════════
🌍 MACRO MARKET REGIME AWARENESS (Adapt to Conditions)
════════════════════════════════════════════════════════════════

PHILOSOPHY: Strategies that work in bull markets fail in bear markets.
Adapt your approach to current market regime.

────────────────────────────────────────────────────────────────

**BEFORE EACH ANALYSIS SESSION:**
────────────────────────────────────────────────────────────────
Quickly assess market regime by checking:

1. **Broad Market Trend** (Search: "SPY stock trend" or "S&P 500 trend")
   • Up strongly last month? (Bull)
   • Down last month? (Bear)  
   • Choppy/sideways? (Uncertain)

2. **Sector Breadth** (From your sector rotation data)
   • How many sectors showing 'inflow' vs 'outflow'?
   • 8+ sectors inflow = Broad bull
   • 8+ sectors outflow = Broad bear
   • 5-7 mixed = Choppy

3. **Volatility Context** (Search: "VIX level today")
   • VIX <15 = Low volatility (complacent)
   • VIX 15-25 = Normal volatility
   • VIX >25 = Elevated volatility (fear)
   • VIX >35 = Panic mode

────────────────────────────────────────────────────────────────

**BULL MARKET REGIME** 🟢
────────────────────────────────────────────────────────────────
Characteristics:
• SPY/broad market trending up consistently
• 8+ sectors showing 'inflow'
• VIX low (<20)
• Dips bought quickly
• Momentum works

Trading Approach - AGGRESSIVE:
✅ Trade aggressively (90-100% cash deployed)
✅ Hold winners longer (let 50-100% moves happen)
✅ Buy dips on noise (strong catalyst + pullback = opportunity)
✅ Concentration acceptable (hot sectors rip together)
✅ Size positions larger (30-40% on 10/10 conviction)
✅ Trim less aggressively (hold for big moves)
✅ Be patient with winners (don't exit at 20%)

Stop Strategy:
• Can give positions more room (-15% to -20%)
• Thesis-based stops more important than price

Example: 2023-2024 AI boom - NVDA, AMD, MSFT all ripped 50-100%+
→ Concentration in tech/chips worked perfectly
→ Holding winners paid off huge

────────────────────────────────────────────────────────────────

**BEAR MARKET REGIME** 🔴
────────────────────────────────────────────────────────────────
Characteristics:
• SPY/broad market trending down
• 8+ sectors showing 'outflow'
• VIX elevated (>25)
• Rallies sold ("sell the rip")
• Downtrends persist

Trading Approach - DEFENSIVE:
⚠️ Trade defensively (50-70% cash deployed)
⚠️ Take profits quicker (20-30% gains, don't hold for 50%+)
⚠️ Sell into strength (trim when extended)
⚠️ Diversify more (concentration risky)
⚠️ Size smaller (20-25% max per position)
⚠️ Tighter stops (-10% to -15% max)
⚠️ Very selective (only 9-10/10 convictions)

Stop Strategy:
• Tighter stops (-10% re-evaluate, -15% exit)
• Less patience with underperformers

Example: 2022 bear market - Most stocks down 30-60%
→ Concentration in growth/tech killed portfolios
→ Quick profits (20-30%) were smart
→ Holding for 50%+ moves meant riding down

────────────────────────────────────────────────────────────────

**CHOPPY/UNCERTAIN REGIME** 🟡
────────────────────────────────────────────────────────────────
Characteristics:
• SPY/broad market sideways, no clear trend
• Sectors mixed (5-7 inflow, 5-7 outflow/neutral)
• VIX 15-25 (normal but uncertain)
• Rallies AND dips both fail
• Whipsaw risk high

Trading Approach - SELECTIVE:
⚠️ Very selective (60-80% cash deployed)
⚠️ Only highest conviction (9-10/10 only, pass on 7-8)
⚠️ Quick profits (25-35% targets)
⚠️ Avoid concentration (diversify across sectors)
⚠️ Medium position sizes (20-25%)
⚠️ Standard stops (-10% to -15%)
⚠️ Don't overstay welcome (take profits, reset)

Stop Strategy:
• Standard thesis-based stops
• Quick to exit if not working

Example: Choppy 2015-2016 markets
→ Breakouts failed, dips failed
→ Best trades were quick in-and-out
→ Patience got punished (whipsaws)

────────────────────────────────────────────────────────────────

**HOW TO USE REGIME AWARENESS:**
────────────────────────────────────────────────────────────────

This is NOT about predicting markets.
This is about ADAPTING your approach to what's working NOW.

Before Each Analysis:
1. Check regime (bull/bear/choppy)
2. Adjust your approach accordingly
3. Note in reasoning: "Bull regime - trading aggressively" or "Bear regime - defensive"

Regime Check Example:
"Quick regime check: SPY up 8% last month, 9/12 sectors showing inflow, VIX at 14.
→ BULL REGIME: Trading aggressively, will hold winners for 50%+ moves"

OR

"Quick regime check: SPY down 6% last month, 9/12 sectors showing outflow, VIX at 32.
→ BEAR REGIME: Trading defensively, taking profits at 25-30%, keeping 40% cash"

────────────────────────────────────────────────────────────────

**KEY PRINCIPLE:**
Be aggressive when markets are rewarding aggression.
Be defensive when markets are punishing aggression.

The same strategy (concentration, hold for 50%+) that wins in bull markets
can destroy portfolios in bear markets. Adapt to survive and thrive.

════════════════════════════════════════════════════════════════

Respond in this EXACT JSON format only, no other text:

CRITICAL JSON RULES:
- Valid JSON only - no markdown, no code blocks, no extra text
- No trailing commas before closing braces
- All strings must be properly escaped
- Use \\n for newlines within strings, never literal newlines
- Double-check JSON is valid before responding

{
  "decisions": [
    {
      "action": "BUY" or "SELL" or "HOLD",
      "symbol": "STOCK_SYMBOL",
      "shares": WHOLE NUMBER ONLY,
      "conviction": 1-10 (scored using the conviction rubric above),
      "reasoning": "MULTI-FACTOR ANALYSIS citing ALL factors:
      
      FOR BUY DECISIONS:
      Technical: [Price action today, relative strength vs sector, trend direction]
      Example: 'Up 6.5% vs sector +2%, breaking resistance at $145, strong volume'
      
      Fundamental: [Earnings results, revenue growth, profitability, guidance]
      Example: 'Q1 2026 revenue $32.5B (+118% YoY), beat by $2.1B, EPS $1.25 vs $0.90 est, raised guidance 15%'
      
      Catalyst: [Specific news event, contract, upgrade, product launch]
      Example: 'Won $480M Army contract Feb 1, analyst upgrades from $140 → $180 PT'
      
      Sector: [Sector momentum, peer performance, rotation dynamics]
      Example: 'Semiconductors leading with NVDA +6.5%, AMD +5%, MU +8% - sector rotation into AI chips'
      
      Conviction Justification: [Why this specific conviction score]
      Example: 'Conviction 9/10: All 4 factors aligned - technical breakout, earnings beat, major catalyst, sector strength'
      
      FOR SELL DECISIONS - BE VERY SPECIFIC ABOUT THE 'WHY':
      Entry Recap: [When bought, at what price, what the original catalyst/thesis was]
      Example: 'Bought at $125 on Jan 15 after earnings beat catalyst'
      
      What Changed: [The specific trigger - catalyst played out, negative news, thesis broken, technical breakdown, stop loss, or better opportunity]
      Example: 'Original catalyst (Q4 earnings beat) fully priced in after 3 weeks. No new catalysts emerged. Stock up 22% from entry - gains at risk of fading.'
      
      Current Status: [Current price vs entry, P&L, how long held, current momentum/RS scores]
      Example: 'Currently $152 (+22% from $125 entry). Held 21 days. Momentum fading to 4/10, RS dropped to 45.'
      
      Risk of Holding: [What happens if you DON'T sell - quantify the downside]
      Example: 'Without new catalyst, likely to drift back toward $140 support. Holding risks giving back 50% of gains.'
      
      Better Use of Capital: [Where the freed cash goes - specific opportunity or dry powder]
      Example: 'Freeing $4,560 to deploy into AVGO which has a fresh catalyst (10/10) vs this played-out setup (5/10).'"
    }
  ],
  "overall_reasoning": "Your confident explanation WITH teaching element. Start with 'Alright, let me break down my multi-factor analysis...' Then explain:
  
  (1) PORTFOLIO REVIEW: Quick status of existing holdings - which are still strong, which have weakened
  (2) SELLS FIRST (if any): For each sell, clearly explain: what the original thesis was, what changed, and why NOW is the time to exit. Be specific: 'I bought PLTR 3 weeks ago at $X on the Army contract catalyst. That catalyst is now fully priced in, momentum has faded to 4/10, and I see a better use of this capital in AVGO.'
  (3) TECHNICAL SETUP: What the price action is telling you across buy candidates
  (4) FUNDAMENTAL BACKDROP: What earnings/revenue data you found
  (5) CATALYSTS IDENTIFIED: Specific news events driving momentum  
  (6) SECTOR DYNAMICS: Which sectors are moving and why
  (7) CONVICTION RATIONALE: Why these specific picks with these conviction levels
  (8) TEACHING MOMENT: What this teaches about multi-factor investing
  
  CRITICAL FOR SELLS: Don't just say 'selling PLTR'. Walk through the full story - entry → thesis → what changed → why selling → where the capital goes next. The user should understand the complete lifecycle of the trade.",
  
  "research_summary": "Detailed summary organized by factor:
  
  FUNDAMENTAL FINDINGS: [Specific earnings, revenue, growth rates with dates/quarters]
  CATALYST FINDINGS: [Specific news events, contracts, upgrades with dates]
  SECTOR FINDINGS: [Which sectors strong/weak, peer performance data]
  TECHNICAL OBSERVATIONS: [Price action patterns across analyzed stocks]
  
  IMPORTANT: Only cite recent data from 2025-2026, not old 2024 data. Include specific numbers and dates for everything."
}

CONVICTION SCORING (must be research-backed):
- 9-10: Strong fundamental catalyst + positive technical setup + sector tailwind
  Example: Earnings beat + breaking out + sector leader
- 7-8: Good fundamental story + decent technical setup
  Example: Contract win + uptrend + sector strength
- 5-6: Mixed signals or limited research
  Example: Some positive news but weak price action
- <5: Don't trade - wait for better setup

ALLOCATION BASED ON CONVICTION:
⚠️ REMEMBER: Total cost of ALL trades must fit within available cash!
- Conviction 9-10: Pick 2-3 stocks, allocate 60-80% of available cash TOTAL
- Conviction 7-8: Pick 2-3 stocks, allocate 40-60% of cash TOTAL
- Conviction 5-6: Pick 1-2 stocks, allocate 20-40% of cash TOTAL
- Conviction <5: HOLD, keep cash for better opportunities

CRITICAL RULES:
- Shares MUST be whole numbers (1, 2, 5, 10, etc.) - NO fractional shares
- CALCULATE before deciding: (price × shares) for EACH stock
- SUM of all trade costs MUST be ≤ available cash
- Cite SPECIFIC research in your reasoning (earnings numbers, contract values, growth rates)
- Don't make generic statements - reference YOUR ACTUAL SEARCHES
- Quality over quantity - only recommend stocks you've thoroughly researched
- If you can't find good research on a stock, DON'T recommend it

Remember: You're managing real money to MAXIMIZE returns through INFORMED decisions AND teaching your user. Back every decision with research. Be specific. Explain your conviction.`
                        }]
                    })
                });

                const data = await response.json();
                console.log('AI Analysis response:', data);
                
                // Check for API errors (rate limits, etc.)
                if (data.type === 'error' || data.error) {
                    const errorMessage = data.error?.message || data.message || 'API error occurred';
                    console.error('API error:', errorMessage);
                    
                    if (errorMessage.includes('rate_limit') || response.status === 429) {
                        throw new Error('Rate limit exceeded! Wait 60 seconds before running analysis again. 🕐');
                    } else {
                        throw new Error(`API error: ${errorMessage}`);
                    }
                }
                
                // Handle response - could be text or tool use (web search)
                aiResponse = '';  // Reset (already declared at function scope)
                
                if (data.content && Array.isArray(data.content)) {
                    // Collect all text blocks (Claude might use tools and then respond)
                    for (const block of data.content) {
                        if (block.type === 'text' && block.text) {
                            aiResponse += block.text;
                        }
                    }
                }
                
                if (!aiResponse) {
                    console.error('No text found in AI response:', data);
                    throw new Error('AI did not return a text response. Check console for details.');
                }
                
                console.log('AI response text:', aiResponse);
                
                // Parse AI decision (now supports multiple stocks)
                // First, try to extract from markdown code blocks if present
                let jsonText = aiResponse;
                
                // Remove markdown code blocks if present
                if (aiResponse.includes('```json')) {
                    const jsonMatch = aiResponse.match(/```json\s*([\s\S]*?)\s*```/);
                    if (jsonMatch) {
                        jsonText = jsonMatch[1];
                    }
                } else if (aiResponse.includes('```')) {
                    const jsonMatch = aiResponse.match(/```\s*([\s\S]*?)\s*```/);
                    if (jsonMatch) {
                        jsonText = jsonMatch[1];
                    }
                }
                
                // Find the JSON object by counting braces (string-aware)
                const startIndex = jsonText.indexOf('{');
                if (startIndex === -1) {
                    throw new Error('No JSON object found in response');
                }
                
                let braceCount = 0;
                let endIndex = startIndex;
                let inString = false;
                let escapeNext = false;
                for (let i = startIndex; i < jsonText.length; i++) {
                    const ch = jsonText[i];
                    
                    if (escapeNext) {
                        escapeNext = false;
                        continue;
                    }
                    
                    if (ch === '\\') {
                        escapeNext = true;
                        continue;
                    }
                    
                    if (ch === '"') {
                        inString = !inString;
                        continue;
                    }
                    
                    if (!inString) {
                        if (ch === '{') braceCount++;
                        if (ch === '}') braceCount--;
                        if (braceCount === 0) {
                            endIndex = i;
                            break;
                        }
                    }
                }
                
                let jsonString = jsonText.substring(startIndex, endIndex + 1);
                
                // CRITICAL: Clean up common JSON formatting issues
                
                // 1. Remove citation tags from web search
                jsonString = jsonString.replace(/<cite[^>]*>/g, '');
                jsonString = jsonString.replace(/<\/cite>/g, '');
                
                // 2. Fix trailing commas before closing braces/brackets (invalid JSON)
                jsonString = jsonString.replace(/,(\s*[}\]])/g, '$1');
                
                // 3. Replace literal newlines/tabs/carriage returns with escaped versions
                // This is the #1 cause of JSON parse failures from Claude
                jsonString = jsonString.replace(/\r\n/g, '\\n');  // Windows newlines
                jsonString = jsonString.replace(/\r/g, '\\n');     // Old Mac newlines
                jsonString = jsonString.replace(/\n/g, '\\n');     // Unix newlines
                jsonString = jsonString.replace(/\t/g, '\\t');     // Tabs
                
                // 4. Collapse excessive escaped newlines (\\n\\n\\n → \\n)
                jsonString = jsonString.replace(/(\\n){3,}/g, '\\n\\n');
                
                // 5. Fix single quotes around property names (should be double quotes)
                jsonString = jsonString.replace(/'([^']+)':/g, '"$1":');
                
                // 6. Fix single quotes around string values (should be double quotes)
                jsonString = jsonString.replace(/:\s*'([^']*)'/g, ': "$1"');
                
                // 7. Remove any remaining control characters (except those we already escaped)
                jsonString = jsonString.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
                
                console.log('Extracted JSON (first 500 chars):', jsonString.substring(0, 500) + '...');
                
                let decision;
                
                // Strategy 1: Direct JSON.parse (works when Claude outputs clean JSON)
                try {
                    decision = JSON.parse(jsonString);
                    console.log('✅ Direct JSON parse succeeded');
                } catch (parseError) {
                    console.warn('Direct JSON parse failed:', parseError.message);
                    console.warn('Falling back to structural extraction from raw response...');
                    
                    // Strategy 2: Structural extraction from the raw AI response
                    // This handles Claude's most common failure: broken escaping in 
                    // overall_reasoning/research_summary while decisions array is valid
                    try {
                        decision = extractDecisionFromRawResponse(aiResponse);
                        console.log('✅ Structural extraction succeeded');
                        addActivity('⚠️ AI response had formatting issues but was recovered successfully.', 'warning');
                    } catch (extractError) {
                        console.error('All parse strategies failed.');
                        console.error('Extract error:', extractError.message);
                        console.error('Raw response (first 2000 chars):', aiResponse.substring(0, 2000));
                        throw new Error('Failed to parse AI response. Try running the analysis again.');
                    }
                }
                
                // Handle new multi-stock format
                if (decision.decisions && Array.isArray(decision.decisions)) {
                        // SAFETY: Ensure whole shares only for all decisions
                        decision.decisions.forEach(d => {
                            if (d.shares) {
                                d.shares = Math.floor(d.shares);
                                if (d.shares < 1) d.shares = 1;
                            }
                        });
                        
                        thinkingDetail.textContent = `AI analyzed ${decision.decisions.length} opportunity(ies)...`;
                        
                        // Prepend Phase 1 sell decisions to the decision list
                        if (phase1SellDecisions && phase1SellDecisions.length > 0) {
                            decision.decisions = [...phase1SellDecisions, ...decision.decisions];
                            if (decision.overall_reasoning) {
                                decision.overall_reasoning = '**Phase 1 - Holdings Review:**\n' + phase1Summary + '\n\n**Phase 2 - New Opportunities:**\n' + decision.overall_reasoning;
                            }
                        }
                        
                        // Execute all trades (sells from Phase 1 + buys from Phase 2)
                        await executeMultipleTrades(decision, marketData);
                        
                        setTimeout(() => {
                            thinking.classList.remove('active');
                        }, 3000);
                    }
                    // Fallback for old single-stock format — normalize to multi-trade format
                    else if (decision.action) {
                        if (decision.shares) {
                            decision.shares = Math.floor(decision.shares);
                            if (decision.shares < 1) decision.shares = 1;
                        }
                        thinkingDetail.textContent = `AI Decision: ${decision.action}...`;
                        console.log('⚠️ Single-decision fallback — wrapping in multi-trade format');
                        await executeMultipleTrades({
                            decisions: [decision],
                            overall_reasoning: decision.reasoning || ''
                        }, marketData);
                        setTimeout(() => {
                            thinking.classList.remove('active');
                        }, 3000);
                    }
                    else {
                        throw new Error('Invalid decision format - missing decisions array or action');
                    }

                    // Save persisted analytics data (regime, scores, rotation) even if no trades executed
                    savePortfolio();

            } catch (error) {
                console.error('AI Analysis error:', error);
                console.error('Full AI response:', aiResponse);
                
                // Log debug info if available
                if (typeof jsonString !== 'undefined' && jsonString) {
                    console.error('Cleaned JSON (first 1000 chars):', jsonString.substring(0, 1000));
                }
                
                thinkingDetail.textContent = 'Error: ' + error.message;
                addActivity('🚫 AI Analysis failed: ' + error.message, 'error');
                
                setTimeout(() => {
                    thinking.classList.remove('active');
                }, 3000);
            } finally {
                isAnalysisRunning = false;
            }
        }

        // Execute multiple trades from conviction-based analysis
        async function executeMultipleTrades(response, marketData) {
            const decisions = response.decisions;
            const overallReasoning = response.overall_reasoning || '';
            const researchSummary = response.research_summary || '';
            
            // Check if APEX is just reaffirming existing positions
            const buyDecisions = decisions.filter(d => d.action === 'BUY');
            const existingSymbols = Object.keys(portfolio.holdings);
            const newBuys = buyDecisions.filter(d => !existingSymbols.includes(d.symbol));
            const reaffirmations = buyDecisions.filter(d => existingSymbols.includes(d.symbol));
            
            // If ALL buy decisions are for stocks we already own, this is a HOLD signal
            if (buyDecisions.length > 0 && newBuys.length === 0) {
                addActivity(`💎 APEX reviewed the market and confirms: Your current positions are still the best plays! Holding ${existingSymbols.join(', ')}.`, 'success');
                
                // Still show the reasoning panel so user can see the analysis
                addDecisionReasoning({
                    action: 'HOLD',
                    reasoning: `I analyzed the market and your current positions (${existingSymbols.join(', ')}) are still the best opportunities. No changes needed!\n\n` + overallReasoning,
                    research_summary: researchSummary,
                    decisions: decisions,
                    budgetWarning: ''
                }, marketData);
                
                await updateUI();
                return; // Don't execute duplicate trades
            }
            
            // ══════════════════════════════════════════════════════════════
            // EXECUTE SELLS FIRST, then validate buy budget against ACTUAL post-sell cash
            // This prevents the bug where AI plans buys using updatedCash (cash + sell proceeds)
            // but the validator was checking against pre-sell portfolio.cash
            // ══════════════════════════════════════════════════════════════
            
            const sellDecisions = decisions.filter(d => d.action === 'SELL');
            let buyDecisionsAll = decisions.filter(d => d.action === 'BUY');
            const holdDecisions = decisions.filter(d => d.action === 'HOLD');
            let successCount = 0;
            let failCount = 0;
            
            // Step 1: Execute all SELL decisions first to free up cash
            for (const decision of sellDecisions) {
                try {
                    const success = await executeSingleTrade(decision, marketData, overallReasoning);
                    if (success) {
                        successCount++;
                        console.log(`✅ Sell executed: ${decision.symbol}, cash now $${portfolio.cash.toFixed(2)}`);
                    } else {
                        failCount++;
                    }
                } catch (error) {
                    console.error(`Failed to execute sell for ${decision.symbol}:`, error);
                    addActivity(`⚠️ Failed to execute SELL for ${decision.symbol}: ${error.message}`, 'error');
                    failCount++;
                }
            }
            
            // Step 2: Enforce 5-day re-buy cooldown
            const cooldownMs = 5 * 24 * 60 * 60 * 1000;
            const recentlySold = (portfolio.closedTrades || []).filter(t => {
                const sellTime = new Date(t.sellDate).getTime();
                return !isNaN(sellTime) && (Date.now() - sellTime) < cooldownMs;
            });
            const recentlySoldSymbols = new Set(recentlySold.map(t => t.symbol));
            buyDecisionsAll = buyDecisionsAll.filter(d => {
                if (recentlySoldSymbols.has(d.symbol)) {
                    console.warn(`⚠️ 5-day cooldown: blocking re-buy of ${d.symbol}`);
                    addActivity(`⚠️ 5-day cooldown blocked re-buy of ${d.symbol}`, 'warning');
                    return false;
                }
                return true;
            });

            // Step 3: Now validate BUY budget against ACTUAL post-sell cash
            let totalCost = 0;
            let budgetWarning = '';
            const validatedBuyDecisions = [];
            
            for (const decision of buyDecisionsAll) {
                const price = marketData[decision.symbol]?.price || 0;
                const cost = price * decision.shares;
                totalCost += cost;
            }
            
            // Check against actual current cash (which now includes sell proceeds)
            if (totalCost > portfolio.cash) {
                budgetWarning = `⚠️ APEX's original plan required $${totalCost.toFixed(2)} but only $${portfolio.cash.toFixed(2)} available. Adjusting trades...`;
                addActivity(budgetWarning, 'warning');
                
                // Keep only decisions that fit within budget (prioritize by conviction)
                const sortedBuys = [...buyDecisionsAll]
                    .sort((a, b) => (b.conviction || 5) - (a.conviction || 5)); // Highest conviction first
                
                let remainingCash = portfolio.cash;
                for (const decision of sortedBuys) {
                    const price = marketData[decision.symbol]?.price || 0;
                    const cost = price * decision.shares;
                    
                    if (cost <= remainingCash) {
                        validatedBuyDecisions.push(decision);
                        remainingCash -= cost;
                    } else {
                        // Try to buy fewer shares if possible
                        const affordableShares = price > 0 ? Math.floor(remainingCash / price) : 0;
                        if (affordableShares > 0) {
                            validatedBuyDecisions.push({
                                ...decision,
                                shares: affordableShares,
                                reasoning: decision.reasoning + ` (reduced from ${decision.shares} to ${affordableShares} shares due to budget)`
                            });
                            remainingCash -= affordableShares * price;
                        }
                    }
                }
            } else {
                // Budget is fine, use all buy decisions
                validatedBuyDecisions.push(...buyDecisionsAll);
            }
            
            // Combine all decisions for display: sells (already executed) + validated buys + holds
            const validatedDecisions = [...sellDecisions, ...validatedBuyDecisions, ...holdDecisions];
            
            // Add overall reasoning to decision panel (with validated decisions)
            addDecisionReasoning({
                action: validatedDecisions.length > 0 ? 'MULTI' : 'HOLD',
                reasoning: overallReasoning,
                research_summary: researchSummary,
                decisions: validatedDecisions,
                budgetWarning: budgetWarning
            }, marketData);
            
            // If no buy decisions after validation and no sells succeeded, it's a HOLD
            if (validatedBuyDecisions.length === 0 && successCount === 0) {
                addActivity(`APEX wanted to trade but insufficient funds for any positions`, 'error');
                return;
            }
            
            // Step 3: Execute validated BUY decisions
            for (const decision of validatedBuyDecisions) {
                try {
                    const success = await executeSingleTrade(decision, marketData, overallReasoning);
                    if (success) {
                        successCount++;
                    } else {
                        failCount++;
                    }
                } catch (error) {
                    console.error(`Failed to execute trade for ${decision.symbol}:`, error);
                    addActivity(`⚠️ Failed to execute ${decision.action} for ${decision.symbol}: ${error.message}`, 'error');
                    failCount++;
                }
            }
            
            // Summary message - show buy/sell breakdown
            const buyCount = validatedBuyDecisions.length;
            const sellCount = sellDecisions.length;
            const executableCount = sellCount + buyCount; // Don't count HOLDs
            
            if (successCount === executableCount && executableCount > 0) {
                let message = '✅ APEX ';
                const actions = [];
                if (buyCount > 0) actions.push(`BOUGHT ${buyCount}`);
                if (sellCount > 0) actions.push(`SOLD ${sellCount}`);
                message += actions.join(' and ') + '!';
                addActivity(message, 'success');
            } else if (successCount > 0) {
                addActivity(`⚠️ APEX executed ${successCount}/${executableCount} trades (${failCount} failed)`, 'warning');
            } else {
                addActivity(`❌ No trades executed - all ${failCount} trades failed`, 'error');
            }
            
            // CRITICAL: Save portfolio after trades
            if (successCount > 0) {
                savePortfolio();  // Saves to localStorage AND Google Drive
                console.log('Portfolio saved after executing', successCount, 'trade(s)');
            }
            
            await updateUI();
            updatePerformanceAnalytics();
        }

        // Execute a single trade (helper function for multi-trade support)
        async function executeSingleTrade(decision, marketData, overallContext = '') {
            if (decision.action === 'HOLD') {
                return true; // Skip HOLD decisions in multi-trade
            }

            const symbol = decision.symbol;
            const shares = decision.shares;
            if (!marketData[symbol] || !marketData[symbol].price) {
                console.error(`❌ No market data for ${symbol} — cannot execute trade`);
                addActivity(`❌ Trade skipped for ${symbol}: no price data available`, 'error');
                return false;
            }
            const price = marketData[symbol].price;
            const conviction = decision.conviction || 5;

            // Check if this price is from cache and warn if old
            const cacheAge = Date.now() - new Date(marketData[symbol].timestamp || 0).getTime();
            const cacheMinutes = Math.floor(cacheAge / 60000);
            if (cacheMinutes > 15) {
                console.warn(`⚠️ Trading ${symbol} with ${cacheMinutes}-minute old price data`);
            }

            if (decision.action === 'BUY') {
                const cost = price * shares;
                if (portfolio.cash >= cost) {
                    portfolio.cash -= cost;
                    portfolio.holdings[symbol] = (portfolio.holdings[symbol] || 0) + shares;
                    
                    // Calculate position size for learning
                    const totalPortfolioValue = portfolio.cash + cost + Object.entries(portfolio.holdings)
                        .filter(([s]) => s !== symbol)
                        .reduce((sum, [s, sh]) => sum + (marketData[s]?.price || 0) * sh, 0);
                    const positionSizePercent = totalPortfolioValue > 0 ? (cost / totalPortfolioValue) * 100 : 0;
                    
                    portfolio.transactions.push({
                        type: 'BUY',
                        symbol: symbol,
                        shares: shares,
                        price: price,
                        timestamp: new Date().toISOString(),
                        cost: cost,
                        
                        // PHASE 1 LEARNING DATA:
                        conviction: conviction,
                        reasoning: decision.reasoning,
                        
                        // Technical indicators at entry
                        entryTechnicals: {
                            momentumScore: marketData[symbol].momentum?.score || null,
                            rsScore: marketData[symbol].relativeStrength?.rsScore || null,
                            sectorRotation: marketData[symbol].sectorRotation?.rotationSignal || null
                        },
                        
                        // Position context
                        positionSizePercent: positionSizePercent,
                        portfolioValueAtEntry: totalPortfolioValue
                    });
                    
                    const convictionEmoji = conviction >= 9 ? '🔥' : conviction >= 7 ? '💪' : '👍';
                    addActivity(`${convictionEmoji} APEX BOUGHT ${shares} shares of ${symbol} at $${price.toFixed(2)} (Conviction: ${conviction}/10) – "${decision.reasoning}"`, 'buy');
                    
                    // THESIS MEMORY: Store the thesis for this holding
                    if (!portfolio.holdingTheses) portfolio.holdingTheses = {};
                    if (!portfolio.holdingTheses[symbol]) {
                        portfolio.holdingTheses[symbol] = {
                            originalCatalyst: decision.reasoning || '',
                            entryConviction: conviction,
                            entryPrice: price,
                            entryDate: new Date().toISOString(),
                            entryMomentum: marketData[symbol].momentum?.score || null,
                            entryRS: marketData[symbol].relativeStrength?.rsScore || null,
                            entrySectorFlow: marketData[symbol].sectorRotation?.moneyFlow || null
                        };
                    } else {
                        portfolio.holdingTheses[symbol].lastAddDate = new Date().toISOString();
                        portfolio.holdingTheses[symbol].lastAddPrice = price;
                        portfolio.holdingTheses[symbol].lastAddConviction = conviction;
                    }
                    
                    return true; // Success
                } else {
                    addActivity(`❌ APEX wanted to buy ${shares} ${symbol} ($${cost.toFixed(2)}) but only has $${portfolio.cash.toFixed(2)} available`, 'error');
                    return false; // Failed - insufficient funds
                }
            } else if (decision.action === 'SELL') {
                if ((portfolio.holdings[symbol] || 0) >= shares) {
                    const revenue = price * shares;
                    portfolio.cash += revenue;
                    portfolio.holdings[symbol] -= shares;

                    if (portfolio.holdings[symbol] === 0) {
                        delete portfolio.holdings[symbol];
                        if (portfolio.holdingTheses && portfolio.holdingTheses[symbol]) delete portfolio.holdingTheses[symbol];
                    }

                    // Find buy transactions for CURRENT position to calculate profit/loss
                    const buyTransactions = getCurrentPositionBuys(symbol);

                    if (buyTransactions.length > 0) {
                        const totalBuyCost = buyTransactions.reduce((sum, t) => sum + t.cost, 0);
                        const totalBuyShares = buyTransactions.reduce((sum, t) => sum + t.shares, 0);
                        const avgBuyPrice = totalBuyShares > 0 ? totalBuyCost / totalBuyShares : 0;
                        const profitLoss = avgBuyPrice > 0 ? (price - avgBuyPrice) * shares : 0;
                        const returnPercent = avgBuyPrice > 0 ? ((price - avgBuyPrice) / avgBuyPrice) * 100 : 0;
                        
                        // Get the original buy transaction data for learning
                        const originalBuyTx = buyTransactions[0];
                        
                        // Determine exit reason
                        let exitReason = 'manual';
                        if (decision.reasoning) {
                            const reasonLower = decision.reasoning.toLowerCase();
                            if (reasonLower.includes('profit') || reasonLower.includes('gain') || reasonLower.includes('target')) {
                                exitReason = 'profit_target';
                            } else if (reasonLower.includes('stop') || reasonLower.includes('loss') || returnPercent < -10) {
                                exitReason = 'stop_loss';
                            } else if (reasonLower.includes('catalyst') || reasonLower.includes('thesis') || reasonLower.includes('fail')) {
                                exitReason = 'catalyst_failure';
                            } else if (reasonLower.includes('opportunity') || reasonLower.includes('better') || reasonLower.includes('swap')) {
                                exitReason = 'opportunity_cost';
                            }
                        }
                        
                        // Track as closed trade with PHASE 1 learning data
                        portfolio.closedTrades = portfolio.closedTrades || [];
                        portfolio.closedTrades.push({
                            symbol: symbol,
                            buyPrice: avgBuyPrice,
                            sellPrice: price,
                            shares: shares,
                            profitLoss: profitLoss,
                            returnPercent: returnPercent,
                            buyDate: buyTransactions[0].timestamp,
                            sellDate: new Date().toISOString(),
                            holdTime: new Date() - new Date(buyTransactions[0].timestamp),
                            
                            // PHASE 1 LEARNING DATA:
                            // 1. Conviction Accuracy
                            entryConviction: originalBuyTx.conviction || null,
                            
                            // 2. Technical Indicators at Entry
                            entryTechnicals: originalBuyTx.entryTechnicals || {},
                            
                            // 3. Exit Context
                            exitReason: exitReason,
                            exitReasoning: decision.reasoning || '',
                            exitConviction: decision.conviction || null,
                            
                            // Position context
                            positionSizePercent: originalBuyTx.positionSizePercent || null,
                            
                            // Placeholder for post-exit tracking (will be filled later)
                            tracking: {
                                priceAfter1Week: null,
                                priceAfter1Month: null,
                                tracked: false
                            }
                        });
                    }
                    
                    portfolio.transactions.push({
                        type: 'SELL',
                        symbol: symbol,
                        shares: shares,
                        price: price,
                        timestamp: new Date().toISOString(),
                        revenue: revenue
                    });
                    
                    addActivity(`APEX SOLD ${shares} shares of ${symbol} at $${price.toFixed(2)} – "${decision.reasoning}"`, 'sell');
                    return true; // Success
                } else {
                    addActivity(`❌ APEX wanted to sell ${shares} ${symbol} but only owns ${portfolio.holdings[symbol] || 0} shares`, 'error');
                    return false; // Failed - insufficient shares
                }
            }
            
            return false; // Unknown action type
        }

        // Legacy executeTrade removed — all trades now flow through
        // executeMultipleTrades → executeSingleTrade for consistent learning data.

        // Calculate total portfolio value and return price data
        async function calculatePortfolioValue() {
            let total = portfolio.cash;
            const priceData = {}; // Store prices for reuse
            
            for (const [symbol, shares] of Object.entries(portfolio.holdings)) {
                try {
                    const price = await getStockPrice(symbol);
                    if (price && price.price > 0) {
                        priceData[symbol] = price;
                        total += price.price * shares;
                    } else {
                        throw new Error('Invalid price data');
                    }
                } catch (error) {
                    console.warn(`Failed to get price for ${symbol}:`, error.message);
                    // Use last known price from transactions as fallback
                    const lastTransaction = portfolio.transactions
                        .filter(t => t.symbol === symbol && t.price > 0)
                        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
                    
                    if (lastTransaction) {
                        console.log(`Using fallback price for ${symbol}: $${lastTransaction.price}`);
                        priceData[symbol] = {
                            price: lastTransaction.price,
                            change: 0,
                            changePercent: 0,
                            isReal: false,
                            note: 'Using last known price'
                        };
                        total += lastTransaction.price * shares;
                    } else {
                        // Absolute fallback - use 0 but log it
                        console.error(`No price data available for ${symbol} - using $0`);
                        priceData[symbol] = {
                            price: 0,
                            change: 0,
                            changePercent: 0,
                            isReal: false,
                            note: 'Price unavailable'
                        };
                    }
                }
            }
            
            return { total, priceData };
        }

        // Update UI
        async function updateUI() {
            try {
                console.log('=== updateUI called ===');
                console.log('Holdings:', portfolio.holdings);
                
                const { total: totalValue, priceData } = await calculatePortfolioValue();
                
                console.log('Price data received:', priceData);
                console.log('Total portfolio value:', totalValue);
                
            // Calculate DAILY PERFORMANCE using portfolio value snapshots
            // This is the most reliable method: compare current total value to start-of-day value,
            // adjusting for any deposits made today. No stock-by-stock reconstruction needed.
            let dailyGain = 0;
            let dailyGainPercent = 0;

            console.log('═══ DAILY PERFORMANCE CALCULATION ═══');

            const now_local = new Date();
            const dayOfWeek = now_local.getDay(); // 0=Sun, 6=Sat
            const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
            const todayLocal = now_local.getFullYear() + '-' + 
                String(now_local.getMonth() + 1).padStart(2, '0') + '-' + 
                String(now_local.getDate()).padStart(2, '0');
            
            // Find the start-of-day portfolio value:
            // Look for the last performanceHistory entry BEFORE today (end of previous day)
            // If none exists, use the first entry of today as baseline
            const perfHistory = portfolio.performanceHistory || [];
            let startOfDayValue = null;
            let todaysDeposits = 0;
            
            for (let i = perfHistory.length - 1; i >= 0; i--) {
                const entry = perfHistory[i];
                if (!entry.timestamp || entry.value === null || entry.value === undefined) continue;
                
                const entryDate = new Date(entry.timestamp);
                const entryLocal = entryDate.getFullYear() + '-' + 
                    String(entryDate.getMonth() + 1).padStart(2, '0') + '-' + 
                    String(entryDate.getDate()).padStart(2, '0');
                
                if (entryLocal < todayLocal) {
                    // This is the last snapshot from before today — our start-of-day value
                    startOfDayValue = entry.value;
                    console.log(`  Start-of-day value (from ${entry.timestamp}): $${startOfDayValue.toFixed(2)}`);
                    break;
                }
            }
            
            // If no previous day entry found, use the earliest entry from today
            if (startOfDayValue === null) {
                for (let i = 0; i < perfHistory.length; i++) {
                    const entry = perfHistory[i];
                    if (!entry.timestamp || entry.value === null || entry.value === undefined) continue;
                    
                    const entryDate = new Date(entry.timestamp);
                    const entryLocal = entryDate.getFullYear() + '-' + 
                        String(entryDate.getMonth() + 1).padStart(2, '0') + '-' + 
                        String(entryDate.getDate()).padStart(2, '0');
                    
                    if (entryLocal === todayLocal) {
                        startOfDayValue = entry.value;
                        console.log(`  Start-of-day value (first today entry ${entry.timestamp}): $${startOfDayValue.toFixed(2)}`);
                        break;
                    }
                }
            }
            
            // Sum up any deposits made today (these inflate portfolio value but aren't gains)
            perfHistory.forEach(entry => {
                if (!entry.timestamp) return;
                const entryDate = new Date(entry.timestamp);
                const entryLocal = entryDate.getFullYear() + '-' + 
                    String(entryDate.getMonth() + 1).padStart(2, '0') + '-' + 
                    String(entryDate.getDate()).padStart(2, '0');
                if (entryLocal === todayLocal && entry.deposit) {
                    todaysDeposits += entry.deposit;
                }
            });
            
            if (isWeekend) {
                console.log('  Weekend — market closed, forcing daily gain to 0');
            } else if (startOfDayValue !== null && startOfDayValue > 0) {
                dailyGain = totalValue - startOfDayValue - todaysDeposits;
                dailyGainPercent = (dailyGain / startOfDayValue) * 100;
                console.log(`  Current value: $${totalValue.toFixed(2)}`);
                console.log(`  Today's deposits: $${todaysDeposits.toFixed(2)}`);
                console.log(`  Daily gain: $${dailyGain.toFixed(2)} (${dailyGainPercent.toFixed(2)}%)`);
            } else {
                console.log('  No start-of-day baseline available — showing 0');
            }
            
            console.log('═══ END DAILY PERFORMANCE ═══');
            
            document.getElementById('dailyPerformance').textContent = dailyGainPercent.toFixed(2) + '%';
            document.getElementById('dailyPerformance').className = 'index-price';
            document.getElementById('dailyPerformance').style.color = dailyGainPercent >= 0 ? '#34d399' : '#f87171';
            
            document.getElementById('dailyPerformanceDollar').textContent = 
                (dailyGain >= 0 ? '+' : '') + '$' + dailyGain.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
            document.getElementById('dailyPerformanceDollar').className = 'index-change ' + (dailyGain >= 0 ? 'positive' : 'negative');
                
            // Calculate actual cost basis (total invested) from transactions
            let totalInvested = 0;
            portfolio.transactions.forEach(transaction => {
                if (transaction.type === 'BUY') {
                    totalInvested += transaction.cost;
                } else if (transaction.type === 'SELL') {
                    // Subtract proceeds from sales (reduces invested capital)
                    totalInvested -= (transaction.shares * transaction.price);
                }
            });

            document.getElementById('portfolioValue').textContent = '$' + totalValue.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
            document.getElementById('cashValue').textContent = '$' + portfolio.cash.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
            document.getElementById('investedValue').textContent = '$' + totalInvested.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
            document.getElementById('positionsCount').textContent = Object.keys(portfolio.holdings).length;

            // Update holdings (compact sidebar + detail main area)
            const holdingsList = document.getElementById('holdingsList');
            const holdingsDetailGrid = document.getElementById('holdingsDetailGrid');
            if (Object.keys(portfolio.holdings).length === 0) {
                holdingsList.innerHTML = '<div class="empty-state">No positions yet</div>';
                if (holdingsDetailGrid) holdingsDetailGrid.innerHTML = '<div class="empty-state">No positions yet</div>';
            } else {
                let compactHtml = '';
                let detailHtml = '';
                for (const [symbol, shares] of Object.entries(portfolio.holdings)) {
                    // Use priceData passed from calculatePortfolioValue - no API call!
                    const stockPrice = priceData[symbol] || { price: 0, change: 0, changePercent: 0 };
                    const currentValue = stockPrice.price * shares;
                    const changeClass = stockPrice.change >= 0 ? 'positive' : 'negative';

                    // Find purchase info from CURRENT position only (excludes prior closed positions)
                    const buyTransactions = getCurrentPositionBuys(symbol);
                    let avgPurchasePrice = 0;
                    let earliestDate = null;
                    let conviction = null;
                    let reasoning = '';
                    let daysHeld = 0;

                    if (buyTransactions.length > 0) {
                        const totalCost = buyTransactions.reduce((sum, t) => sum + t.cost, 0);
                        const totalShares = buyTransactions.reduce((sum, t) => sum + t.shares, 0);
                        avgPurchasePrice = totalCost / totalShares;
                        earliestDate = new Date(buyTransactions[0].timestamp);

                        // Get conviction and reasoning from first buy of CURRENT position
                        conviction = buyTransactions[0].conviction || null;
                        reasoning = buyTransactions[0].reasoning || '';

                        // Calculate days held
                        daysHeld = Math.floor((new Date() - earliestDate) / (1000 * 60 * 60 * 24));
                    }

                    const gainLoss = currentValue - (avgPurchasePrice * shares);
                    const gainLossPercent = avgPurchasePrice > 0 ? ((stockPrice.price - avgPurchasePrice) / avgPurchasePrice) * 100 : 0;
                    const gainLossClass = gainLoss >= 0 ? 'positive' : 'negative';

                    // Calculate position size as % of total portfolio
                    const positionSizePercent = totalValue > 0 ? (currentValue / totalValue) * 100 : 0;

                    // Determine expected timeframe based on catalyst keywords
                    let expectedDays = { min: 7, max: 14, label: '1-2 weeks' }; // Default
                    const reasoningLower = reasoning.toLowerCase();
                    if (reasoningLower.includes('earnings') || reasoningLower.includes('guidance')) {
                        expectedDays = { min: 7, max: 14, label: '1-2 weeks' };
                    } else if (reasoningLower.includes('contract') || reasoningLower.includes('deal')) {
                        expectedDays = { min: 14, max: 21, label: '2-3 weeks' };
                    } else if (reasoningLower.includes('upgrade') || reasoningLower.includes('analyst')) {
                        expectedDays = { min: 3, max: 5, label: '3-5 days' };
                    } else if (reasoningLower.includes('sector') || reasoningLower.includes('rotation')) {
                        expectedDays = { min: 7, max: 14, label: '1-2 weeks' };
                    }

                    // Check if past expected timeframe
                    const isPastTimeframe = daysHeld > expectedDays.max;
                    const daysRemaining = expectedDays.max - daysHeld;

                    // Get stock name from mapping
                    const stockName = stockNames[symbol] || symbol;

                    // Conviction emoji
                    const convictionEmoji = conviction >= 9 ? '🔥' : conviction >= 7 ? '💪' : conviction >= 5 ? '👍' : '';

                    const dailyClass = daysHeld === 0
                        ? (gainLossPercent >= 0 ? 'positive' : 'negative')
                        : (stockPrice.changePercent >= 0 ? 'positive' : 'negative');

                    // Compact row for sidebar
                    compactHtml += `
                        <div class="sidebar-holding-compact">
                            <div class="compact-left">
                                <span class="compact-symbol">${symbol}</span>
                                <span class="compact-shares">${shares} shares</span>
                            </div>
                            <div class="compact-right">
                                <span class="compact-price">$${stockPrice.price.toFixed(2)}</span>
                                <span class="compact-daily ${changeClass}">${stockPrice.changePercent >= 0 ? '+' : ''}${stockPrice.changePercent.toFixed(2)}%</span>
                            </div>
                        </div>
                    `;

                    // Full detail card for main area
                    detailHtml += `
                        <div class="holding-item holding-card">
                            <div class="holding-card-header">
                                <div>
                                    <div class="holding-card-symbol">${symbol}</div>
                                    <div class="holding-card-name">${stockName}</div>
                                    <div class="holding-card-shares">
                                        ${shares} shares · ${conviction ? convictionEmoji + ' ' + conviction + '/10 conviction' : 'No conviction data'}
                                    </div>
                                </div>
                                <div>
                                    <div class="holding-card-value">$${currentValue.toLocaleString(undefined, {minimumFractionDigits: 2})}</div>
                                    <div class="holding-card-gainloss ${gainLossClass}">${gainLoss >= 0 ? '+' : ''}$${Math.abs(gainLoss).toFixed(2)} (${gainLossPercent >= 0 ? '+' : ''}${gainLossPercent.toFixed(2)}%)</div>
                                    <div class="holding-card-daily ${dailyClass}">
                                        ${daysHeld === 0
                                            ? `Since entry: ${gainLossPercent >= 0 ? '+' : ''}${gainLossPercent.toFixed(2)}% · ${gainLoss >= 0 ? '+' : ''}$${gainLoss.toFixed(2)}`
                                            : `Today: ${stockPrice.changePercent >= 0 ? '+' : ''}${stockPrice.changePercent.toFixed(2)}% · ${stockPrice.change >= 0 ? '+' : ''}$${(stockPrice.change * shares).toFixed(2)}`
                                        }
                                    </div>
                                    <div class="holding-card-position-size">
                                        ${positionSizePercent.toFixed(1)}% of portfolio
                                        ${positionSizePercent > 30 ? '<span class="position-warning">Large</span>' : ''}
                                    </div>
                                </div>
                            </div>
                            ${reasoning ? `
                            <div class="holding-card-catalyst" onclick="event.stopPropagation(); showCatalystPopover(this, '${symbol}');" data-full-catalyst="${reasoning.replace(/'/g, '&#39;').replace(/"/g, '&quot;')}">
                                <span class="catalyst-label">View Catalyst</span>
                            </div>
                            ` : ''}
                            <div class="holding-card-timeframe">
                                <strong>${daysHeld === 0 ? 'Bought today' : `Held ${daysHeld} day${daysHeld !== 1 ? 's' : ''}`}</strong> | Expected: ${expectedDays.label}
                                ${isPastTimeframe ?
                                    '<div class="holding-card-timeframe-warning">REVIEW: Past expected timeframe - re-evaluate thesis!</div>'
                                    : daysRemaining > 0 ?
                                    `<span class="text-muted">(${daysRemaining} day${daysRemaining !== 1 ? 's' : ''} remaining)</span>`
                                    : ''}
                            </div>
                            <div class="holding-card-footer">
                                <div>
                                    <span class="holding-card-footer-label">Avg Cost:</span> <span class="holding-card-footer-value">$${avgPurchasePrice.toFixed(2)}</span>
                                </div>
                                <div>
                                    <span class="holding-card-footer-label">Current:</span> <span class="holding-card-footer-value">$${stockPrice.price.toFixed(2)}</span> <span class="stat-change ${changeClass}">${stockPrice.changePercent >= 0 ? '+' : ''}${stockPrice.changePercent.toFixed(2)}%</span>
                                </div>
                                <div>
                                    <span class="holding-card-footer-label">Purchased:</span> <span class="holding-card-footer-value">${earliestDate ? earliestDate.toLocaleDateString() + ' ' + earliestDate.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : 'N/A'}</span>
                                </div>
                            </div>
                        </div>
                    `;
                }
                holdingsList.innerHTML = compactHtml;
                if (holdingsDetailGrid) holdingsDetailGrid.innerHTML = detailHtml;
            }

            // Update chart
            // Throttle performanceHistory: at most one entry per 15 minutes (unless deposit marker)
            const now = new Date();
            const lastEntry = portfolio.performanceHistory[portfolio.performanceHistory.length - 1];
            const timeSinceLast = lastEntry ? (now - new Date(lastEntry.timestamp)) : Infinity;
            if (timeSinceLast >= 15 * 60 * 1000 || !lastEntry || lastEntry.deposit) {
                portfolio.performanceHistory.push({
                    timestamp: now.toISOString(),
                    value: totalValue
                });
            } else {
                // Update the most recent entry's value instead of adding a new one
                lastEntry.value = totalValue;
                lastEntry.timestamp = now.toISOString();
            }

            // Hard cap: keep at most 3000 entries (prune oldest non-deposit entries)
            if (portfolio.performanceHistory.length > 3000) {
                const excess = portfolio.performanceHistory.length - 3000;
                portfolio.performanceHistory.splice(0, excess);
            }

            await updatePerformanceChart();
            updatePerformanceAnalytics();
            updateSectorAllocation(priceData); // Pass priceData to avoid re-fetching

            // Update async analytics modules (need price data)
            updateThesisTracker();

            } catch (error) {
                console.error('Error updating UI:', error);
                addActivity('⚠️ Error updating display - some data may be stale. Try refreshing the page.', 'error');
                // Still show what we can
                document.getElementById('portfolioValue').textContent = 'Error';
                document.getElementById('cashValue').textContent = '$' + portfolio.cash.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
            }
        }

        // Add activity
        // Escape HTML entities to prevent XSS from AI/user content
        function escapeHtml(str) {
            if (typeof str !== 'string') return str;
            return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
        }

        function addActivity(text, type = 'general') {
            const feed = document.getElementById('activityFeed');
            const time = new Date().toLocaleString();
            
            const item = document.createElement('div');
            item.className = `activity-item ${type}`;
            item.innerHTML = `
                <div class="activity-time">${time}</div>
                <div class="activity-description">${escapeHtml(text)}</div>
            `;
            
            if (feed.firstChild && feed.firstChild.textContent.includes('No activity')) {
                feed.innerHTML = '';
            }
            
            feed.insertBefore(item, feed.firstChild);
        }

        // Save portfolio to localStorage
        function savePortfolio() {
            console.log('savePortfolio called. Holdings:', Object.keys(portfolio.holdings).length, 'Cash:', portfolio.cash);
            localStorage.setItem('aiTradingPortfolio', JSON.stringify(portfolio));
            console.log('Portfolio saved to localStorage');
            
            // Also save to Google Drive if authorized (and not in recovery mode)
            if (gdriveAuthorized && !preventAutoSave) {
                console.log('Google Drive authorized - saving to cloud...');
                savePortfolioToDrive();
            } else if (preventAutoSave) {
                console.log('Auto-save to Drive prevented (recovery mode)');
            } else {
                console.warn('Google Drive not authorized - portfolio NOT saved to cloud');
            }
        }

        // Load portfolio from localStorage
        function loadPortfolio() {
            const saved = localStorage.getItem('aiTradingPortfolio');
            if (saved) {
                try {
                    portfolio = JSON.parse(saved);
                    console.log('Portfolio loaded from localStorage:', portfolio);
                    console.log(`Cash: $${portfolio.cash}, Holdings: ${Object.keys(portfolio.holdings).length}, Transactions: ${portfolio.transactions.length}`);
                    
                    // MIGRATION: Ensure new analytics fields exist
                    if (!portfolio.lastMarketRegime) portfolio.lastMarketRegime = null;
                    if (!portfolio.lastCandidateScores) portfolio.lastCandidateScores = null;
                    if (!portfolio.lastSectorRotation) portfolio.lastSectorRotation = null;

                    // MIGRATION: Reconstruct totalDeposits if missing or zero
                    // For portfolios created before totalDeposits tracking was added
                    if (!portfolio.totalDeposits && portfolio.initialBalance) {
                        // Start with initial balance
                        let reconstructed = portfolio.initialBalance;
                        
                        // Count all BUY transaction costs and SELL proceeds to figure out
                        // how much cash was injected beyond what trading could produce.
                        // totalDeposits = cash + value_of_holdings + realized_losses - realized_gains
                        // Simpler: look at all cash that entered the system
                        // Cash enters via: initial balance + weekly funding
                        // Cash exits via: it doesn't leave (buys convert to holdings, sells convert back)
                        // So: totalDeposits = current_cash + total_spent_on_buys - total_received_from_sells
                        
                        let totalBuyCost = 0;
                        let totalSellProceeds = 0;
                        (portfolio.transactions || []).forEach(t => {
                            if (t.type === 'BUY') totalBuyCost += (t.cost || t.price * t.shares);
                            if (t.type === 'SELL') totalSellProceeds += (t.proceeds || t.price * t.shares);
                        });
                        
                        // totalDeposits = cash_now + totalBuyCost - totalSellProceeds
                        // Because: deposits = cash + money_spent_buying - money_received_selling
                        reconstructed = portfolio.cash + totalBuyCost - totalSellProceeds;
                        
                        // Sanity check: should be >= initialBalance
                        if (reconstructed < portfolio.initialBalance) {
                            reconstructed = portfolio.initialBalance;
                        }
                        
                        portfolio.totalDeposits = Math.round(reconstructed * 100) / 100;
                        console.log(`📊 MIGRATION: Reconstructed totalDeposits = $${portfolio.totalDeposits} (initial: $${portfolio.initialBalance}, buys: $${totalBuyCost.toFixed(2)}, sells: $${totalSellProceeds.toFixed(2)}, cash: $${portfolio.cash.toFixed(2)})`);
                        
                        // Save the migrated portfolio
                        savePortfolio();
                    }
                    
                    updateUI();
                    addActivity(`Portfolio loaded from localStorage - $${portfolio.cash.toFixed(2)} cash, ${Object.keys(portfolio.holdings).length} positions`, 'init');
                } catch (error) {
                    console.error('Error parsing localStorage portfolio:', error);
                    addActivity('⚠️ Error loading saved portfolio', 'error');
                }
            } else {
                console.log('No portfolio found in localStorage');
            }
        }

        // Refresh prices manually
        async function refreshPrices() {
            console.log('🔄 Manual price refresh requested');
            addActivity('🔄 Refreshing all prices...', 'general');
            
            // Clear entire price cache to force fresh fetches
            Object.keys(priceCache).forEach(key => delete priceCache[key]);
            console.log('Price cache cleared');
            
            // Update UI which will fetch fresh prices
            await updateUI();
            
            addActivity('✅ Prices refreshed!', 'success');
        }

        // Reset account
        function resetAccount() {
            if (confirm('Are you sure you want to reset your account? This will delete all positions and history.')) {
                portfolio = {
                    cash: 0,
                    initialBalance: 0,
                    totalDeposits: 0,
                    holdings: {},
                    transactions: [],
                    performanceHistory: [],
                    closedTrades: [],
                    holdingTheses: {},
                    tradingStrategy: 'aggressive',
                    journalEntries: [],
                    lastMarketRegime: null,
                    lastCandidateScores: null,
                    lastSectorRotation: null
                };
                localStorage.removeItem('aiTradingPortfolio');
                document.getElementById('activityFeed').innerHTML = '<div class="empty-state">No activity yet</div>';
                updateUI();
                if (performanceChart) {
                    performanceChart.data.labels = [];
                    performanceChart.data.datasets.forEach(ds => { ds.data = []; });
                    performanceChart.update();
                }
            }
        }

        // Initialize on load
        window.onload = function() {
            initGdriveConfig(); // Initialize Google Drive config with stored keys
            initChart();
            loadPortfolio();
            loadApiUsage();
            updatePerformanceAnalytics();
            updateSectorAllocation();
            updateApiKeyStatus(); // Check API key configuration

            // Restore persisted decision history
            try {
                const history = JSON.parse(localStorage.getItem('apexDecisionHistory') || '[]');
                if (history.length > 0) {
                    // Render oldest first so newest ends up on top (insertBefore firstChild)
                    history.forEach(record => {
                        // Reconstruct minimal marketData from slim prices
                        const marketData = {};
                        if (record.marketPrices) {
                            for (const [sym, price] of Object.entries(record.marketPrices)) {
                                marketData[sym] = { price };
                            }
                        }
                        addDecisionReasoning(record.decision, marketData, {
                            restored: true,
                            timestamp: record.timestamp
                        });
                    });
                    console.log(`Restored ${history.length} decision(s) from localStorage`);
                }
            } catch (e) {
                console.error('Failed to restore decision history:', e);
            }

            // Initialize Google Drive API
            initGoogleDrive();
        };

        // ===== GOOGLE DRIVE SYNC FUNCTIONS (Updated for Google Identity Services) =====
        
        function initGoogleDrive() {
            // Check if credentials are configured
            if (!GDRIVE_CONFIG.CLIENT_ID || !GDRIVE_CONFIG.API_KEY || 
                GDRIVE_CONFIG.CLIENT_ID === '' || GDRIVE_CONFIG.API_KEY === '') {
                console.log('Google Drive credentials not configured yet');
                updateCloudSyncStatus('⚙️ Setup needed', 'Configure in settings');
                return;
            }
            
            // Wait for Google Identity Services to load
            if (typeof google === 'undefined' || !google.accounts) {
                console.log('Waiting for Google Identity Services to load...');
                setTimeout(initGoogleDrive, 500);
                return;
            }
            
            try {
                // Initialize the token client for authorization
                tokenClient = google.accounts.oauth2.initTokenClient({
                    client_id: GDRIVE_CONFIG.CLIENT_ID,
                    scope: GDRIVE_CONFIG.SCOPES,
                    callback: (response) => {
                        if (response.error) {
                            console.error('Token error:', response);
                            updateCloudSyncStatus('❌ Auth failed', response.error);
                            return;
                        }
                        
                        accessToken = response.access_token;
                        gdriveAuthorized = true;
                        console.log('Google Drive authorized successfully');
                        updateCloudSyncStatus('✓ Connected', 'Use Force Download to restore portfolio');
                        // Don't auto-load - user will use Force Download button to control when to load
                        // loadPortfolioFromDrive();
                    },
                });
                
                gdriveReady = true;
                console.log('Google Drive API ready');
                updateCloudSyncStatus('☁️ Sign in', 'Click to enable cloud sync');
                
            } catch (error) {
                console.error('Error initializing Google Drive:', error);
                updateCloudSyncStatus('❌ Init failed', 'Check console');
            }
        }

        function handleAuthClick() {
            if (!gdriveReady) {
                alert('Google Drive API not ready yet. Please wait a moment and try again.');
                return;
            }
            
            if (gdriveAuthorized) {
                // Sign out
                accessToken = null;
                gdriveAuthorized = false;
                updateCloudSyncStatus('☁️ Sign in', 'Click to enable cloud sync');
            } else {
                // Request access token
                tokenClient.requestAccessToken({ prompt: 'consent' });
            }
        }

        async function loadPortfolioFromDrive() {
            console.log('=== loadPortfolioFromDrive called ===');
            console.log('accessToken:', accessToken ? 'Present' : 'Missing');
            console.log('GDRIVE_CONFIG:', GDRIVE_CONFIG);
            
            if (!accessToken) {
                console.log('No access token available - cannot load from Drive');
                return;
            }
            
            try {
                updateCloudSyncStatus('⏳ Loading...', 'Downloading from Drive');
                
                // Search for existing portfolio file
                const searchUrl = `https://www.googleapis.com/drive/v3/files?q=name='${GDRIVE_CONFIG.PORTFOLIO_FILENAME}' and trashed=false&fields=files(id,name)`;
                console.log('Searching for portfolio file:', GDRIVE_CONFIG.PORTFOLIO_FILENAME);
                console.log('Search URL:', searchUrl);
                
                const searchResponse = await fetch(searchUrl, {
                    headers: { 'Authorization': `Bearer ${accessToken}` }
                });
                
                console.log('Search response status:', searchResponse.status);
                
                if (!searchResponse.ok) {
                    throw new Error(`Search failed: ${searchResponse.status}`);
                }
                
                const searchData = await searchResponse.json();
                console.log('Search results:', searchData);

                if (searchData.files && searchData.files.length > 0) {
                    portfolioFileId = searchData.files[0].id;
                    console.log('Found portfolio file with ID:', portfolioFileId);
                    
                    // Download the file
                    const fileUrl = `https://www.googleapis.com/drive/v3/files/${portfolioFileId}?alt=media`;
                    console.log('Downloading from:', fileUrl);
                    
                    const fileResponse = await fetch(fileUrl, {
                        headers: { 'Authorization': `Bearer ${accessToken}` }
                    });
                    
                    console.log('Download response status:', fileResponse.status);
                    
                    if (!fileResponse.ok) {
                        throw new Error(`Download failed: ${fileResponse.status}`);
                    }

                    const cloudPortfolio = await fileResponse.json();
                    console.log('Downloaded portfolio from Google Drive:', cloudPortfolio);
                    
                    // Replace local portfolio with cloud version (cloud is source of truth)
                    portfolio = cloudPortfolio;
                    console.log('Portfolio updated. Cash:', portfolio.cash, 'Holdings:', Object.keys(portfolio.holdings).length);
                    
                    // Save to localStorage so it persists
                    localStorage.setItem('aiTradingPortfolio', JSON.stringify(portfolio));
                    console.log('Portfolio saved to localStorage');
                    
                    // Update all UI components
                    await updateUI();
                    updatePerformanceAnalytics();
                    await updateSectorAllocation();
                    
                    updateCloudSyncStatus('✓ Synced', 'Portfolio loaded from Drive');
                    addActivity(`💾 Portfolio restored from Google Drive - $${portfolio.cash.toFixed(2)} cash, ${Object.keys(portfolio.holdings).length} positions`, 'success');
                    console.log('=== Portfolio load complete ===');
                } else {
                    // No file exists - DON'T auto-create during recovery
                    console.error('❌ No portfolio file found in Google Drive');
                    console.error('Searched for:', GDRIVE_CONFIG.PORTFOLIO_FILENAME);
                    console.error('Search returned:', searchData);
                    
                    updateCloudSyncStatus('❌ File not found', 'Check Drive for exact filename');
                    
                    throw new Error(
                        `File "${GDRIVE_CONFIG.PORTFOLIO_FILENAME}" not found in Google Drive. ` +
                        `Make sure the backup file is named EXACTLY: Apex_Portfolio.json (case-sensitive)`
                    );
                }
            } catch (error) {
                console.error('=== Error loading from Drive ===');
                console.error('Error:', error);
                console.error('Error stack:', error.stack);
                updateCloudSyncStatus('⚠️ Load failed', 'Using local data');
                addActivity(`⚠️ Could not load from Google Drive: ${error.message}`, 'error');
                
                // Re-throw so caller can handle the error
                throw error;
            }
        }

        async function savePortfolioToDrive() {
            console.log('=== savePortfolioToDrive called ===');
            console.log('gdriveAuthorized:', gdriveAuthorized);
            console.log('accessToken:', accessToken ? 'Present' : 'Missing');
            
            if (!gdriveAuthorized || !accessToken) {
                console.warn('❌ Not authorized to save to Drive');
                return;
            }

            try {
                updateCloudSyncStatus('⏳ Saving...', 'Uploading to Drive');
                
                console.log('Portfolio to save:', {
                    cash: portfolio.cash,
                    holdings: portfolio.holdings,
                    transactions: portfolio.transactions.length
                });
                
                const portfolioData = JSON.stringify(portfolio, null, 2);
                console.log('Portfolio JSON size:', portfolioData.length, 'bytes');
                
                const metadata = {
                    name: GDRIVE_CONFIG.PORTFOLIO_FILENAME,
                    mimeType: 'application/json'
                };

                const form = new FormData();
                form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
                form.append('file', new Blob([portfolioData], { type: 'application/json' }));

                const url = portfolioFileId
                    ? `https://www.googleapis.com/upload/drive/v3/files/${portfolioFileId}?uploadType=multipart`
                    : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';

                const method = portfolioFileId ? 'PATCH' : 'POST';
                console.log('Uploading to Google Drive:', method, url);
                console.log('File ID:', portfolioFileId || 'Creating new file');

                const response = await fetch(url, {
                    method: method,
                    headers: { 'Authorization': `Bearer ${accessToken}` },
                    body: form
                });

                console.log('Upload response status:', response.status);

                if (!response.ok) {
                    const errorText = await response.text();
                    console.error('Upload failed response:', errorText);
                    throw new Error(`Upload failed: ${response.status}`);
                }
                
                const result = await response.json();
                console.log('Upload result:', result);
                
                if (result.id) {
                    portfolioFileId = result.id;
                    updateCloudSyncStatus('✓ Synced', new Date().toLocaleTimeString());
                    console.log('✅ Portfolio saved to Google Drive successfully!');
                    console.log('File ID:', portfolioFileId);
                    addActivity(`💾 Portfolio saved to Google Drive`, 'success');
                } else {
                    throw new Error('No file ID returned');
                }
            } catch (error) {
                console.error('Error saving to Drive:', error);
                updateCloudSyncStatus('⚠️ Save failed', 'Saved locally only');
            }
        }

        function updateCloudSyncStatus(icon, text) {
            const iconEl = document.getElementById('syncIcon');
            const textEl = document.getElementById('syncText');
            const statusEl = document.getElementById('cloudSyncStatus');
            
            if (iconEl) iconEl.textContent = icon || '☁️';
            if (textEl) textEl.textContent = text || 'Not synced';
            
            // Make it clickable to sign in
            if (statusEl && !gdriveAuthorized && gdriveReady) {
                statusEl.style.cursor = 'pointer';
                statusEl.onclick = handleAuthClick;
                statusEl.title = 'Click to sign in to Google Drive';
            } else if (statusEl && gdriveAuthorized) {
                statusEl.style.cursor = 'default';
                statusEl.onclick = null;
                statusEl.title = 'Connected to Google Drive';
            }
        }

        // Update sector allocation chart
        async function updateSectorAllocation(priceData = null) {
            if (!sectorChart) {
                return;
            }

            // Calculate sector allocation by value
            const sectorValues = {};
            let totalHoldingsValue = 0;

            // If we have holdings, calculate their sector allocation
            if (Object.keys(portfolio.holdings).length > 0) {
                for (const [symbol, shares] of Object.entries(portfolio.holdings)) {
                    // Reuse priceData if provided, otherwise fetch
                    let stockPrice;
                    if (priceData && priceData[symbol]) {
                        stockPrice = priceData[symbol];
                    } else {
                        try {
                            stockPrice = await getStockPrice(symbol);
                        } catch (error) {
                            console.warn(`Failed to get price for ${symbol} in sector allocation`);
                            stockPrice = { price: 0, change: 0, changePercent: 0 };
                        }
                    }
                    
                    const value = stockPrice.price * shares;
                    const sector = stockSectors[symbol] || 'Other';
                    
                    sectorValues[sector] = (sectorValues[sector] || 0) + value;
                    totalHoldingsValue += value;
                }
            }

            // Add cash as a category
            const cashValue = portfolio.cash;
            sectorValues['Cash'] = cashValue;
            
            // Total portfolio value = holdings + cash
            const totalPortfolioValue = totalHoldingsValue + cashValue;

            // Convert to percentages (based on total portfolio)
            const sectorPercentages = {};
            for (const [sector, value] of Object.entries(sectorValues)) {
                sectorPercentages[sector] = (value / totalPortfolioValue) * 100;
            }

            // Update chart
            const sectors = Object.keys(sectorPercentages);
            const percentages = Object.values(sectorPercentages);

            sectorChart.data.labels = sectors;
            sectorChart.data.datasets[0].data = percentages;
            sectorChart.update();

            // Update legend with values
            const legendHtml = sectors.map((sector, index) => {
                const percentage = sectorPercentages[sector];
                const value = sectorValues[sector];
                const color = sectorChart.data.datasets[0].backgroundColor[index % sectorChart.data.datasets[0].backgroundColor.length];
                return `
                    <div class="sector-legend-item">
                        <div class="sector-legend-swatch" style="background: ${color};"></div>
                        <div class="sector-legend-text">${sector}: <strong>${percentage.toFixed(1)}%</strong> ($${value.toFixed(2)})</div>
                    </div>
                `;
            }).join('');
            
            document.getElementById('sectorLegend').innerHTML = legendHtml;
        }

        // Add APEX decision reasoning to the panel
        // options: { restored: bool, timestamp: ISO string }
        function addDecisionReasoning(decision, marketData, options = {}) {
            const container = document.getElementById('decisionReasoning');
            const timestamp = options.timestamp ? new Date(options.timestamp) : new Date();
            let reasoningCard;

            // Handle multi-stock format
            if (decision.action === 'MULTI' && decision.decisions) {
                reasoningCard = document.createElement('div');
                reasoningCard.className = 'decision-card';

                let stocksList = '';
                // Display order: SELL → HOLD → BUY (mirrors Phase 1→2 logic: sell to free cash, then buy)
                const actionOrder = { 'SELL': 0, 'BUY': 1, 'HOLD': 2 };
                const sortedDecisions = [...decision.decisions].sort((a, b) =>
                    (actionOrder[a.action] ?? 3) - (actionOrder[b.action] ?? 3)
                );
                sortedDecisions.forEach(d => {
                    const isSell = d.action === 'SELL';
                    const isBuy = d.action === 'BUY';

                    const actionClass = isSell ? 'sell' : isBuy ? 'buy' : 'hold';
                    const actionColor = isSell ? '#ef4444' : isBuy ? '#34d399' : '#60a5fa';
                    const actionLabel = isSell ? 'SELL' : isBuy ? 'BUY' : 'HOLD';
                    const actionIcon = isSell ? '📉' : isBuy ? '📈' : '📊';

                    const convictionColor = d.conviction >= 9 ? '#34d399' : d.conviction >= 7 ? '#60a5fa' : '#a8a8a0';
                    const convictionEmoji = d.conviction >= 9 ? '🔥' : d.conviction >= 7 ? '💪' : '👍';
                    const price = marketData[d.symbol] ? `$${marketData[d.symbol].price.toFixed(2)}` : '';
                    stocksList += `
                        <div class="decision-stock-item ${actionClass}" onclick="this.classList.toggle('expanded')">
                            <div class="decision-stock-item-header">
                                <span class="decision-stock-item-title" style="color: ${actionColor};">
                                    ${actionIcon} ${d.shares} ${d.symbol} @ ${price}
                                </span>
                                <div class="decision-stock-item-badges">
                                    <span class="decision-action-badge" style="color: ${actionColor}; background: ${actionClass === 'sell' ? 'rgba(239,68,68,0.12)' : actionClass === 'buy' ? 'rgba(52,211,153,0.08)' : 'rgba(96,165,250,0.08)'}; border: 1px solid ${actionColor};">
                                        ${actionLabel}
                                    </span>
                                    <span class="decision-conviction" style="color: ${convictionColor};">
                                        ${convictionEmoji} ${d.conviction}/10
                                    </span>
                                    <span class="decision-expand-icon">&#9656;</span>
                                </div>
                            </div>
                            <div class="decision-stock-reasoning">
                                ${escapeHtml(d.reasoning)}
                            </div>
                        </div>
                    `;
                });

                const buyCount = decision.decisions.filter(d => d.action === 'BUY').length;
                const sellCount = decision.decisions.filter(d => d.action === 'SELL').length;
                const holdCount = decision.decisions.filter(d => d.action === 'HOLD').length;
                let picksSummary = [];
                if (buyCount > 0) picksSummary.push(`<span class="positive">${buyCount} buy${buyCount > 1 ? 's' : ''}</span>`);
                if (sellCount > 0) picksSummary.push(`<span class="negative">${sellCount} sell${sellCount > 1 ? 's' : ''}</span>`);
                if (holdCount > 0) picksSummary.push(`<span style="color: #60a5fa;">${holdCount} hold${holdCount > 1 ? 's' : ''}</span>`);

                reasoningCard.innerHTML = `
                    <div class="decision-card-header">
                        <div>
                            <div class="decision-card-title">APEX's Analysis</div>
                            <div class="decision-card-summary">${picksSummary.join(' · ')}</div>
                        </div>
                        <div class="decision-card-actions">
                            <div class="decision-card-time">${timestamp.toLocaleTimeString()}</div>
                            <button class="decision-save-btn" onclick="saveDecisionReasoning(this)">Save</button>
                        </div>
                    </div>
                    ${decision.budgetWarning ? `
                        <div class="budget-warning">${escapeHtml(decision.budgetWarning)}</div>
                    ` : ''}
                    ${stocksList}
                    ${decision.reasoning ? `
                        <div class="decision-thoughts" onclick="this.classList.toggle('collapsed')">
                            <div class="decision-thoughts-label">
                                <span>APEX's Thoughts</span>
                                <span class="decision-expand-icon">&#9662;</span>
                            </div>
                            <div class="decision-thoughts-text">${escapeHtml(decision.reasoning)}</div>
                        </div>
                    ` : ''}
                    ${decision.research_summary ? `
                        <div class="research-summary" onclick="this.classList.toggle('collapsed')">
                            <div class="research-summary-label">
                                <span>Research Summary</span>
                                <span class="decision-expand-icon">&#9662;</span>
                            </div>
                            <div class="research-summary-text">${escapeHtml(decision.research_summary)}</div>
                        </div>
                    ` : ''}
                `;
            } else {
                // Handle single-stock format (fallback)
                let actionColor, actionIcon, actionText;
                if (decision.action === 'BUY') {
                    actionColor = '#34d399';
                    actionIcon = '📈';
                    actionText = 'BOUGHT';
                } else if (decision.action === 'SELL') {
                    actionColor = '#f87171';
                    actionIcon = '📉';
                    actionText = 'SOLD';
                } else {
                    actionColor = '#a8a8a0';
                    actionIcon = '⏸️';
                    actionText = 'HELD';
                }

                let priceText = '';
                if (decision.symbol && marketData[decision.symbol]) {
                    priceText = ` at $${marketData[decision.symbol].price.toFixed(2)}`;
                }

                reasoningCard = document.createElement('div');
                reasoningCard.className = 'decision-card';
                reasoningCard.style.borderLeftColor = actionColor;

                reasoningCard.innerHTML = `
                    <div class="decision-single-header">
                        <div class="decision-single-title" style="color: ${actionColor};">
                            ${actionIcon} ${actionText} ${decision.shares || ''} ${decision.symbol || ''}${priceText}
                        </div>
                        <div class="decision-card-actions">
                            <div class="decision-card-time" style="font-size: 11px;">${timestamp.toLocaleTimeString()}</div>
                            <button class="decision-save-btn" onclick="saveDecisionReasoning(this)">Save</button>
                        </div>
                    </div>
                    <div class="decision-single-reasoning">"${decision.reasoning}"</div>
                `;
            }

            // Clear placeholder if present
            if (container.children.length === 1 && container.children[0].textContent.includes('No trades yet')) {
                container.innerHTML = '';
            }

            // Insert session divider if date changed from the previous card
            const prevCard = container.firstChild;
            if (prevCard && prevCard.classList && prevCard.dataset.timestamp) {
                const prevDate = new Date(prevCard.dataset.timestamp).toDateString();
                const curDate = timestamp.toDateString();
                if (prevDate !== curDate) {
                    const divider = document.createElement('div');
                    divider.className = 'decision-divider';
                    const prevTs = new Date(prevCard.dataset.timestamp);
                    divider.innerHTML = `<span>${prevTs.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} — ${prevTs.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>`;
                    container.insertBefore(divider, container.firstChild);
                }
            }

            // Tag card with timestamp for divider logic
            reasoningCard.dataset.timestamp = timestamp.toISOString();
            container.insertBefore(reasoningCard, container.firstChild);

            // Auto-upload to Google Drive + persist to localStorage (skip for restored decisions)
            if (!options.restored) {
                // Auto-upload
                const textData = buildDecisionText(reasoningCard);
                uploadDecisionToDrive(textData.content, textData.filename);

                // Persist to localStorage (max 5 records)
                const slimPrices = {};
                if (decision.decisions) {
                    decision.decisions.forEach(d => {
                        if (d.symbol && marketData[d.symbol]) {
                            slimPrices[d.symbol] = marketData[d.symbol].price;
                        }
                    });
                } else if (decision.symbol && marketData[decision.symbol]) {
                    slimPrices[decision.symbol] = marketData[decision.symbol].price;
                }

                try {
                    const history = JSON.parse(localStorage.getItem('apexDecisionHistory') || '[]');
                    history.push({
                        timestamp: timestamp.toISOString(),
                        decision: {
                            action: decision.action,
                            reasoning: decision.reasoning,
                            research_summary: decision.research_summary,
                            decisions: decision.decisions,
                            budgetWarning: decision.budgetWarning,
                            symbol: decision.symbol,
                            shares: decision.shares
                        },
                        marketPrices: slimPrices
                    });
                    // Keep only last 5
                    while (history.length > 5) history.shift();
                    localStorage.setItem('apexDecisionHistory', JSON.stringify(history));
                } catch (e) {
                    console.error('Failed to persist decision history:', e);
                }
            }
        }

        // Build text content from a decision card element
        function buildDecisionText(card) {
            const timestamp = new Date().toISOString().split('T')[0];
            const time = new Date().toLocaleTimeString();
            const headerText = card.querySelector('.decision-card-title, .decision-single-title')?.textContent || 'APEX Analysis';

            let content = `═══════════════════════════════════════════════════════════════\n`;
            content += `  ${headerText}\n`;
            content += `  ${timestamp} at ${time}\n`;
            content += `═══════════════════════════════════════════════════════════════\n\n`;

            const sections = card.querySelectorAll('.decision-stock-item, .decision-thoughts, .research-summary');
            sections.forEach(section => {
                const sectionTitle = section.querySelector('.decision-thoughts-label, .research-summary-label, .decision-action-badge')?.textContent;
                if (sectionTitle) {
                    content += `\n${sectionTitle}\n`;
                    content += `${'─'.repeat(60)}\n`;
                }
                const textContent = section.innerText || section.textContent;
                if (textContent && !textContent.includes('💭') && !textContent.includes('📰')) {
                    content += textContent + '\n';
                } else if (textContent) {
                    const lines = textContent.split('\n');
                    content += lines.slice(1).join('\n') + '\n';
                }
            });

            content += `\n═══════════════════════════════════════════════════════════════\n`;
            content += `Saved from APEX Trading Agent\n`;
            content += `═══════════════════════════════════════════════════════════════\n`;

            const filename = `APEX_Analysis_${timestamp}_${time.replace(/:/g, '-')}.txt`;
            return { content, filename };
        }

        // Upload decision text to Google Drive (silent — logs but never throws)
        async function uploadDecisionToDrive(content, filename) {
            try {
                if (!accessToken) {
                    console.log('Google Drive not connected, skipping auto-upload');
                    return;
                }

                const folderId = await findOrCreateFolder('Apex Reasoning');
                if (!folderId) {
                    console.warn('Could not find or create Apex Reasoning folder');
                    return;
                }

                const metadata = { name: filename, mimeType: 'text/plain', parents: [folderId] };
                const form = new FormData();
                form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
                form.append('file', new Blob([content], { type: 'text/plain' }));

                const resp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + accessToken },
                    body: form
                });

                if (!resp.ok) throw new Error('Upload failed: ' + resp.statusText);
                const result = await resp.json();
                console.log('✅ Auto-uploaded to Google Drive:', result);
                addActivity('☁️ Decision reasoning auto-uploaded to Google Drive', 'success');
            } catch (err) {
                console.error('Auto-upload to Google Drive failed:', err);
                addActivity('⚠️ Auto-upload to Google Drive failed', 'warning');
            }
        }

        // Save decision reasoning as a text file (manual Save button)
        async function saveDecisionReasoning(button) {
            try {
                const card = button.closest('.decision-card');
                if (!card) {
                    console.error('Could not find decision card');
                    return;
                }

                const { content, filename } = buildDecisionText(card);

                // Save locally (download)
                const blob = new Blob([content], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);

                // Visual feedback
                const originalText = button.innerHTML;
                button.innerHTML = '✅ Saved Locally';
                button.style.background = 'rgba(34, 197, 94, 0.2)';
                button.style.borderColor = '#22c55e';
                button.style.color = '#4ade80';
                addActivity('📄 Decision reasoning saved locally', 'success');

                // Upload to Drive
                if (accessToken) {
                    button.innerHTML = '☁️ Uploading...';
                    try {
                        await uploadDecisionToDrive(content, filename);
                        button.innerHTML = '✅ Saved & Uploaded!';
                    } catch (e) {
                        button.innerHTML = '✅ Saved Locally (Upload Failed)';
                    }
                }

                // Reset button after 3 seconds
                setTimeout(() => {
                    button.innerHTML = originalText;
                    button.style.background = 'rgba(245, 158, 11, 0.15)';
                    button.style.borderColor = '#f59e0b';
                    button.style.color = '#fbbf24';
                }, 3000);

            } catch (error) {
                console.error('Error saving decision:', error);
                alert('Error saving decision. Check console for details.');
            }
        }
        
        // Helper function to find or create Google Drive folder
        async function findOrCreateFolder(folderName) {
            try {
                // Search for existing folder
                const searchResponse = await fetch(
                    `https://www.googleapis.com/drive/v3/files?q=name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
                    {
                        headers: {
                            'Authorization': 'Bearer ' + accessToken
                        }
                    }
                );
                
                if (!searchResponse.ok) {
                    throw new Error('Search failed');
                }
                
                const searchResult = await searchResponse.json();
                
                // If folder exists, return its ID
                if (searchResult.files && searchResult.files.length > 0) {
                    console.log('Found existing folder:', searchResult.files[0].id);
                    return searchResult.files[0].id;
                }
                
                // Create folder if it doesn't exist
                const createResponse = await fetch('https://www.googleapis.com/drive/v3/files', {
                    method: 'POST',
                    headers: {
                        'Authorization': 'Bearer ' + accessToken,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        name: folderName,
                        mimeType: 'application/vnd.google-apps.folder'
                    })
                });
                
                if (!createResponse.ok) {
                    throw new Error('Folder creation failed');
                }
                
                const createResult = await createResponse.json();
                console.log('Created new folder:', createResult.id);
                return createResult.id;
                
            } catch (error) {
                console.error('Error with folder:', error);
                return null;
            }
        }

        // Calculate and update performance analytics
        function updatePerformanceAnalytics() {
            // Safety checks for undefined portfolio fields
            const performanceHistory = portfolio.performanceHistory || [];
            const totalValue = performanceHistory.length > 0 
                ? performanceHistory[performanceHistory.length - 1].value 
                : (portfolio.initialBalance || 0);
            
            // Calculate TRUE Total Return based on gains, not deposits
            // Total Return = (Current Value - Total Invested) / Total Invested
            // This way, adding cash doesn't inflate returns
            
            // Calculate total invested (cost basis from transactions)
            let totalInvested = 0;
            portfolio.transactions.forEach(transaction => {
                if (transaction.type === 'BUY') {
                    totalInvested += transaction.cost;
                } else if (transaction.type === 'SELL') {
                    totalInvested -= (transaction.shares * transaction.price);
                }
            });
            
            // Current holdings value (from latest performance snapshot)
            const currentHoldingsValue = totalValue - portfolio.cash;
            
            // Actual gains/losses = Current Holdings Value - Total Invested
            const actualGains = currentHoldingsValue - totalInvested;
            
            // Return % = Gains / Total Invested (not initial balance!)
            const totalReturn = totalInvested > 0 
                ? (actualGains / totalInvested) * 100 
                : 0;
            const returnDollar = actualGains;
            
            document.getElementById('totalReturn').textContent = totalReturn.toFixed(2) + '%';
            document.getElementById('totalReturn').className = 'index-price';
            document.getElementById('totalReturn').style.color = totalReturn >= 0 ? '#34d399' : '#f87171';
            
            document.getElementById('totalReturnDollar').textContent = 
                (returnDollar >= 0 ? '+' : '') + '$' + returnDollar.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
            document.getElementById('totalReturnDollar').className = 'index-change ' + (returnDollar >= 0 ? 'positive' : 'negative');
            
            // Win Rate (based on closed trades)
            const closedTrades = portfolio.closedTrades || [];
            const wins = closedTrades.filter(t => t.profitLoss > 0).length;
            const losses = closedTrades.filter(t => t.profitLoss < 0).length;
            const totalClosed = wins + losses;
            const winRate = totalClosed > 0 ? (wins / totalClosed) * 100 : 0;
            
            document.getElementById('winRate').textContent = winRate.toFixed(0) + '%';
            document.getElementById('winRate').style.color = winRate >= 50 ? '#34d399' : '#f87171';
            document.getElementById('winLossRatio').textContent = `${wins}W / ${losses}L`;
            
            // Best Trade (with dollar amount)
            if (closedTrades.length > 0) {
                const bestTrade = closedTrades.reduce((best, trade) => 
                    trade.profitLoss > best.profitLoss ? trade : best
                );
                
                // Only show best trade if it's actually positive
                if (bestTrade.profitLoss > 0) {
                    document.getElementById('bestTrade').textContent = bestTrade.symbol;
                    document.getElementById('bestTradeGain').textContent = 
                        '+' + bestTrade.returnPercent.toFixed(2) + '% (+$' + 
                        bestTrade.profitLoss.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ')';
                } else {
                    document.getElementById('bestTrade').textContent = 'N/A';
                    document.getElementById('bestTradeGain').textContent = '--';
                }
                
                // Worst Trade (with dollar amount)
                const worstTrade = closedTrades.reduce((worst, trade) => 
                    trade.profitLoss < worst.profitLoss ? trade : worst
                );
                
                // Only show worst trade if it's actually negative
                if (worstTrade.profitLoss < 0) {
                    document.getElementById('worstTrade').textContent = worstTrade.symbol;
                    document.getElementById('worstTradeLoss').textContent = 
                        worstTrade.returnPercent.toFixed(2) + '% ($' + 
                        worstTrade.profitLoss.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ')';
                } else {
                    document.getElementById('worstTrade').textContent = 'N/A';
                    document.getElementById('worstTradeLoss').textContent = '--';
                }
            } else {
                // No closed trades
                document.getElementById('bestTrade').textContent = 'N/A';
                document.getElementById('bestTradeGain').textContent = '--';
                document.getElementById('worstTrade').textContent = 'N/A';
                document.getElementById('worstTradeLoss').textContent = '--';
            }
            
            // Average Hold Time
            if (closedTrades.length > 0) {
                const avgHoldMs = closedTrades.reduce((sum, trade) => sum + trade.holdTime, 0) / closedTrades.length;
                const avgHoldDays = avgHoldMs / (1000 * 60 * 60 * 24);
                
                if (avgHoldDays < 1) {
                    document.getElementById('avgHoldTime').textContent = (avgHoldDays * 24).toFixed(1) + ' hours';
                } else {
                    document.getElementById('avgHoldTime').textContent = avgHoldDays.toFixed(1) + ' days';
                }
            }
            
            // Total Trades
            const transactions = portfolio.transactions || [];
            document.getElementById('totalTrades').textContent = transactions.length;
            
            // Update Learning Insights Display
            updateLearningInsightsDisplay();

            // Update new analytics modules (non-async, use persisted data)
            updateRegimeBanner();
            updateCandidateScorecard();
            updateSectorRotationHeatmap();

            // Close any expanded analytics panels on data refresh
            ['winRate', 'bestTrade', 'worstTrade'].forEach(t => {
                const p = document.getElementById(t + 'Expansion');
                if (p) p.classList.remove('open');
                const c = p ? p.closest('.expandable-card') : null;
                if (c) c.classList.remove('expanded');
            });
        }
        
        // Update Learning Insights Display
        function updateLearningInsightsDisplay() {
            const analysis = analyzePerformanceHistory();
            const container = document.getElementById('learningInsights');
            
            if (!analysis.hasData) {
                container.innerHTML = `<div class="empty-state">${analysis.message}</div>`;
                return;
            }
            
            const { overall, sectorPerformance, stockPerformance, behaviorPatterns, recent } = analysis;
            
            let html = '<div class="insights-grid">';

            // Overall Performance
            html += `
                <div class="insight-panel">
                    <div class="insight-panel-title">Overall Performance</div>
                    <div class="insight-panel-body">
                        <div>Record: ${overall.wins}W - ${overall.losses}L (${overall.winRate.toFixed(1)}%)</div>
                        <div>Avg Winner: <span class="positive">+${overall.avgWinReturn.toFixed(1)}%</span> (${overall.avgWinHoldTime.toFixed(1)} days)</div>
                        <div>Avg Loser: <span class="negative">${overall.avgLossReturn.toFixed(1)}%</span> (${overall.avgLossHoldTime.toFixed(1)} days)</div>
                    </div>
                </div>
            `;
            
            // Recent Trend
            const trendIcon = recent.trend.improving ? '🔥' : 
                             recent.trend.declining ? '⚠️' : '➖';
            const trendText = recent.trend.improving ? 'IMPROVING!' : 
                             recent.trend.declining ? 'DECLINING' : 'STEADY';
            const trendColor = recent.trend.improving ? '#34d399' : 
                              recent.trend.declining ? '#f87171' : '#a8a8a0';
            
            html += `
                <div class="insight-panel">
                    <div class="insight-panel-title">Recent Trend</div>
                    <div class="insight-panel-body">
                        <div>Last ${recent.trades} trades: ${recent.wins}W - ${recent.trades - recent.wins}L</div>
                        <div>Win Rate: ${recent.winRate.toFixed(1)}%</div>
                        <div style="color: ${trendColor}; font-weight: 600; margin-top: 5px;">${trendIcon} ${trendText}</div>
                    </div>
                </div>
            `;
            
            html += '</div>'; // Close grid

            const closedTradesAll = portfolio.closedTrades || [];

            // Risk/Reward Profile Panel
            if (overall.wins > 0 && overall.losses > 0) {
                const totalGains = closedTradesAll.filter(t => t.profitLoss > 0).reduce((s, t) => s + t.profitLoss, 0);
                const totalLosses = Math.abs(closedTradesAll.filter(t => t.profitLoss <= 0).reduce((s, t) => s + t.profitLoss, 0));
                const profitFactor = totalLosses > 0 ? totalGains / totalLosses : totalGains > 0 ? Infinity : 0;
                const winLossRatio = overall.avgLossReturn !== 0 ? Math.abs(overall.avgWinReturn / overall.avgLossReturn) : 0;
                const expectedValue = (overall.winRate / 100 * overall.avgWinReturn) + ((1 - overall.winRate / 100) * overall.avgLossReturn);
                const pfColor = profitFactor >= 2 ? 'var(--green)' : profitFactor >= 1 ? 'var(--accent-light)' : 'var(--red)';
                const wlColor = winLossRatio >= 2 ? 'var(--green)' : winLossRatio >= 1 ? 'var(--accent-light)' : 'var(--red)';
                const evColor = expectedValue >= 0 ? 'var(--green)' : 'var(--red)';
                html += `<div class="analytics-panel">
                    <div class="analytics-panel-title">Risk / Reward Profile</div>
                    <div class="insight-panel-body">
                        <div class="rr-stats-row">
                            <div class="rr-stat">
                                <div class="rr-stat-value" style="color: ${pfColor};">${profitFactor === Infinity ? '∞' : profitFactor.toFixed(2)}</div>
                                <div class="rr-stat-label">Profit Factor</div>
                            </div>
                            <div class="rr-stat">
                                <div class="rr-stat-value" style="color: ${wlColor};">${winLossRatio.toFixed(2)}x</div>
                                <div class="rr-stat-label">Win/Loss Ratio</div>
                            </div>
                            <div class="rr-stat">
                                <div class="rr-stat-value" style="color: ${evColor};">${expectedValue >= 0 ? '+' : ''}${expectedValue.toFixed(2)}%</div>
                                <div class="rr-stat-label">Expected Value</div>
                            </div>
                        </div>
                    </div>
                </div>`;
            }

            // Hold Time Comparison Panel
            if (overall.wins > 0 && overall.losses > 0) {
                const maxHold = Math.max(overall.avgWinHoldTime, overall.avgLossHoldTime, 1);
                const winBarPct = (overall.avgWinHoldTime / maxHold * 100).toFixed(0);
                const lossBarPct = (overall.avgLossHoldTime / maxHold * 100).toFixed(0);
                const holdingLosers = overall.avgLossHoldTime > overall.avgWinHoldTime * 1.3;
                html += `<div class="analytics-panel">
                    <div class="analytics-panel-title">Hold Time Comparison</div>
                    <div class="insight-panel-body">
                        <div class="hold-time-row">
                            <span class="hold-time-label">Winners</span>
                            <div class="hold-time-bar-track">
                                <div class="hold-time-bar-fill" style="width: ${winBarPct}%; background: var(--green);"></div>
                            </div>
                            <span class="hold-time-value">${overall.avgWinHoldTime.toFixed(1)} days</span>
                        </div>
                        <div class="hold-time-row">
                            <span class="hold-time-label">Losers</span>
                            <div class="hold-time-bar-track">
                                <div class="hold-time-bar-fill" style="width: ${lossBarPct}%; background: var(--red);"></div>
                            </div>
                            <span class="hold-time-value">${overall.avgLossHoldTime.toFixed(1)} days</span>
                        </div>
                        ${holdingLosers ? '<div class="exit-insight-callout">Losers held longer than winners — consider tighter stop-losses</div>' : ''}
                    </div>
                </div>`;
            }

            // Win/Loss Streaks Panel
            if (closedTradesAll.length >= 5) {
                let currentStreak = 0, currentType = '', bestWin = 0, worstLoss = 0, tempStreak = 0, tempType = '';
                const sorted = [...closedTradesAll].sort((a, b) => new Date(a.sellDate) - new Date(b.sellDate));
                sorted.forEach(t => {
                    const type = t.profitLoss > 0 ? 'W' : 'L';
                    if (type === tempType) { tempStreak++; }
                    else { tempStreak = 1; tempType = type; }
                    if (type === 'W' && tempStreak > bestWin) bestWin = tempStreak;
                    if (type === 'L' && tempStreak > worstLoss) worstLoss = tempStreak;
                });
                currentStreak = tempStreak;
                currentType = tempType;
                const streakColor = currentType === 'W' ? 'var(--green)' : 'var(--red)';
                const streakLabel = currentType === 'W' ? 'Win' : 'Loss';
                html += `<div class="analytics-panel">
                    <div class="analytics-panel-title">Streaks</div>
                    <div class="insight-panel-body">
                        <div class="rr-stats-row">
                            <div class="rr-stat">
                                <div class="rr-stat-value" style="color: ${streakColor};">${currentStreak} ${streakLabel}${currentStreak !== 1 ? 's' : ''}</div>
                                <div class="rr-stat-label">Current</div>
                            </div>
                            <div class="rr-stat">
                                <div class="rr-stat-value" style="color: var(--green);">${bestWin}</div>
                                <div class="rr-stat-label">Best Win Streak</div>
                            </div>
                            <div class="rr-stat">
                                <div class="rr-stat-value" style="color: var(--red);">${worstLoss}</div>
                                <div class="rr-stat-label">Worst Loss Streak</div>
                            </div>
                        </div>
                    </div>
                </div>`;
            }

            // Conviction Accuracy Panel
            const convictionData = analyzeConvictionAccuracy();
            if (convictionData.hasData) {
                html += `<div class="analytics-panel">
                    <div class="analytics-panel-title">Conviction Accuracy</div>
                    <div class="insight-panel-body">`;
                const levels = ['9-10', '7-8', '5-6'];
                levels.forEach(level => {
                    const d = convictionData.analysis[level];
                    if (d) {
                        const barColor = d.calibration === 'well-calibrated' ? 'var(--green)' : 'var(--accent)';
                        const calClass = d.calibration === 'well-calibrated' ? 'well-calibrated' : 'overconfident';
                        const calLabel = d.calibration === 'well-calibrated' ? 'Well-calibrated' : 'Overconfident';
                        html += `
                        <div class="conviction-bar-row">
                            <span class="conviction-level">${level}</span>
                            <div class="conviction-bar-track">
                                <div class="conviction-bar-fill" style="width: ${Math.min(d.winRate, 100)}%; background: ${barColor};"></div>
                            </div>
                            <span class="conviction-stats">${d.winRate.toFixed(0)}% win &middot; ${d.avgReturn >= 0 ? '+' : ''}${d.avgReturn.toFixed(1)}% avg &middot; ${d.count} trades</span>
                            <span class="conviction-calibration ${calClass}">${calLabel}</span>
                        </div>`;
                    }
                });
                html += '</div></div>';
            }

            // Signal Accuracy Panel
            const signalData = analyzeTechnicalAccuracy();
            if (signalData.hasData) {
                html += `<div class="analytics-panel">
                    <div class="analytics-panel-title">Signal Accuracy</div>
                    <div class="insight-panel-body">`;
                const signals = [
                    { name: 'Momentum', highLabel: 'High (7+)', lowLabel: 'Low (&lt;7)', high: signalData.momentum.high, low: signalData.momentum.low },
                    { name: 'RS', highLabel: 'High (70+)', lowLabel: 'Low (&lt;70)', high: signalData.relativeStrength.high, low: signalData.relativeStrength.low },
                    { name: 'Sector Flow', highLabel: 'Inflow', lowLabel: 'Outflow', high: signalData.sectorRotation.inflow, low: signalData.sectorRotation.outflow }
                ];
                signals.forEach(sig => {
                    if (sig.high && sig.low) {
                        const highWins = sig.high.winRate > sig.low.winRate;
                        const diff = Math.abs(sig.high.winRate - sig.low.winRate);
                        const verdict = diff > 15 ? (highWins ? 'predictive' : 'contrarian') : 'weak';
                        const verdictLabel = diff > 15 ? (highWins ? 'Predictive' : 'Contrarian') : 'Weak signal';
                        html += `
                        <div class="signal-comparison-row">
                            <span class="signal-name">${sig.name}</span>
                            <div class="signal-side ${highWins ? 'winning' : ''}">
                                <div class="signal-side-label">${sig.highLabel}</div>
                                <div class="signal-side-stats">${sig.high.winRate.toFixed(0)}% win &middot; ${sig.high.avgReturn >= 0 ? '+' : ''}${sig.high.avgReturn.toFixed(1)}%</div>
                                <div class="signal-side-count">${sig.high.count} trades</div>
                            </div>
                            <span class="signal-vs">vs</span>
                            <div class="signal-side ${!highWins ? 'winning' : ''}">
                                <div class="signal-side-label">${sig.lowLabel}</div>
                                <div class="signal-side-stats">${sig.low.winRate.toFixed(0)}% win &middot; ${sig.low.avgReturn >= 0 ? '+' : ''}${sig.low.avgReturn.toFixed(1)}%</div>
                                <div class="signal-side-count">${sig.low.count} trades</div>
                            </div>
                            <span class="signal-verdict ${verdict}">${verdictLabel}</span>
                        </div>`;
                    }
                });
                html += '</div></div>';
            }

            // Exit Analysis Panel
            const exitData = analyzeExitTiming();
            if (exitData.hasData) {
                const reasonLabels = {
                    profit_target: { label: 'Profit Target', cls: 'profit' },
                    stop_loss: { label: 'Stop Loss', cls: 'stop' },
                    catalyst_failure: { label: 'Catalyst Failed', cls: 'catalyst' },
                    opportunity_cost: { label: 'Opportunity Cost', cls: 'opportunity' },
                    manual: { label: 'Manual', cls: 'manual' }
                };
                html += `<div class="analytics-panel">
                    <div class="analytics-panel-title">Exit Analysis</div>
                    <div class="insight-panel-body">`;
                Object.entries(exitData.byReason).forEach(([reason, d]) => {
                    const meta = reasonLabels[reason] || { label: reason, cls: 'manual' };
                    const retClass = d.avgReturn >= 0 ? 'positive' : 'negative';
                    html += `
                    <div class="exit-reason-row">
                        <span class="exit-reason-badge ${meta.cls}">${meta.label}</span>
                        <span class="exit-reason-count">${d.count} trades</span>
                        <span class="exit-reason-winrate">${d.winRate.toFixed(0)}% win</span>
                        <span class="exit-reason-return ${retClass}">${d.avgReturn >= 0 ? '+' : ''}${d.avgReturn.toFixed(1)}%</span>
                    </div>`;
                });
                if (exitData.insight) {
                    html += `<div class="exit-insight-callout">${exitData.insight}</div>`;
                }
                html += '</div></div>';
            }

            // Post-Exit Tracking Panel
            const trackedTrades = closedTradesAll.filter(t => t.tracking && (t.tracking.priceAfter1Week !== null || t.tracking.priceAfter1Month !== null));
            if (trackedTrades.length >= 3) {
                const goodExits = trackedTrades.filter(t => {
                    const weekReturn = t.tracking.priceAfter1Week ? (t.tracking.priceAfter1Week - t.sellPrice) / t.sellPrice : 0;
                    const monthReturn = t.tracking.priceAfter1Month ? (t.tracking.priceAfter1Month - t.sellPrice) / t.sellPrice : 0;
                    return (t.tracking.priceAfter1Month !== null ? monthReturn : weekReturn) <= 0;
                });
                const earlyExits = trackedTrades.filter(t => {
                    const ref = t.tracking.priceAfter1Month !== null ? t.tracking.priceAfter1Month : t.tracking.priceAfter1Week;
                    return ref && ((ref - t.sellPrice) / t.sellPrice) >= 0.05;
                });
                html += `<div class="analytics-panel">
                    <div class="analytics-panel-title">Post-Exit Tracking</div>
                    <div class="insight-panel-body">
                        <div class="post-exit-summary">
                            <span class="post-exit-stat good">${goodExits.length} Good Exits</span>
                            <span class="post-exit-stat early">${earlyExits.length} Early Exits</span>
                        </div>`;
                trackedTrades.slice(-8).forEach(t => {
                    let weekHtml = '';
                    let monthHtml = '';
                    if (t.tracking.priceAfter1Week !== null) {
                        const weekPct = ((t.tracking.priceAfter1Week - t.sellPrice) / t.sellPrice * 100);
                        const weekCls = weekPct <= 0 ? 'good-exit' : 'early-exit';
                        weekHtml = `<span class="post-exit-after ${weekCls}">1wk: ${weekPct >= 0 ? '+' : ''}${weekPct.toFixed(1)}%</span>`;
                    }
                    if (t.tracking.priceAfter1Month !== null) {
                        const monthPct = ((t.tracking.priceAfter1Month - t.sellPrice) / t.sellPrice * 100);
                        const monthCls = monthPct <= 0 ? 'good-exit' : 'early-exit';
                        monthHtml = `<span class="post-exit-after ${monthCls}">1mo: ${monthPct >= 0 ? '+' : ''}${monthPct.toFixed(1)}%</span>`;
                    }
                    html += `
                    <div class="post-exit-row">
                        <span class="post-exit-symbol">${t.symbol}</span>
                        <span class="post-exit-sell">Sold $${t.sellPrice.toFixed(0)}</span>
                        ${weekHtml}
                        ${monthHtml}
                    </div>`;
                });
                html += '</div></div>';
            }

            // Behavioral Patterns - Most important!
            if (behaviorPatterns.length > 0) {
                html += `
                    <div class="behavior-section">
                        <div class="behavior-section-title">APEX's Trading Behavior</div>
                        <div class="behavior-list">
                `;
                behaviorPatterns.forEach(bp => {
                    html += `
                        <div class="behavior-item">
                            <div class="behavior-item-pattern">${bp.pattern}</div>
                            <div class="behavior-item-insight">${bp.insight}</div>
                            <div class="behavior-item-action">→ ${bp.action}</div>
                        </div>
                    `;
                });
                html += '</div></div>';
            }
            
            // Stock Context (not avoid/favor lists!)
            const stocksWithContext = Object.entries(stockPerformance)
                .filter(([_, perf]) => perf.trades.length >= 2)
                .sort((a, b) => b[1].trades.length - a[1].trades.length)
                .slice(0, 6);
            
            if (stocksWithContext.length > 0) {
                html += `
                    <div class="stock-context-section">
                        <div class="stock-context-title">Stock Performance Context</div>
                        <div class="stock-context-grid">
                `;
                stocksWithContext.forEach(([symbol, perf]) => {
                    const color = perf.avgReturn > 5 ? '#34d399' : perf.avgReturn > 0 ? '#a8a8a0' : '#f87171';
                    const interpretation = perf.losses > perf.wins ?
                        'Review entry timing' :
                        perf.wins > perf.losses ? 'Working well' : 'Mixed results';

                    html += `
                        <div class="stock-context-item">
                            <div class="stock-context-item-symbol">${symbol}</div>
                            <div class="stock-context-item-record">${perf.wins}-${perf.losses} (${perf.winRate.toFixed(0)}%)</div>
                            <div class="stock-context-item-return" style="color: ${color};">${perf.avgReturn >= 0 ? '+' : ''}${perf.avgReturn.toFixed(1)}%</div>
                            <div class="stock-context-item-note">${interpretation}</div>
                        </div>
                    `;
                });
                html += '</div></div>';
            }
            
            // Sector Insights
            const sortedSectors = Object.entries(sectorPerformance)
                .filter(([_, perf]) => perf.count >= 2)
                .sort((a, b) => b[1].avgReturn - a[1].avgReturn)
                .slice(0, 6);
            
            if (sortedSectors.length > 0) {
                html += `
                    <div class="sector-insights-section">
                        <div class="sector-insights-title">Sector Performance</div>
                        <div class="sector-insights-grid">
                `;
                sortedSectors.forEach(([sector, perf]) => {
                    const icon = perf.avgReturn > 5 ? '✅' : perf.avgReturn > 0 ? '➖' : '⚠️';
                    const color = perf.avgReturn > 5 ? '#34d399' : perf.avgReturn > 0 ? '#a8a8a0' : '#f87171';
                    html += `
                        <div class="sector-insights-item">
                            <div class="sector-insights-item-name">${icon} ${sector}</div>
                            <div class="sector-insights-item-record">${perf.wins}-${perf.losses} (${perf.winRate.toFixed(0)}%)</div>
                            <div class="sector-insights-item-return" style="color: ${color};">${perf.avgReturn >= 0 ? '+' : ''}${perf.avgReturn.toFixed(1)}%</div>
                            ${perf.insight ? `<div class="sector-insights-item-note">${perf.insight}</div>` : ''}
                        </div>
                    `;
                });
                html += '</div></div>';
            }
            
            container.innerHTML = html;
        }

        // Chat functionality
        function addChatMessage(text, sender = 'user') {
            const chatMessages = document.getElementById('chatMessages');
            const messageDiv = document.createElement('div');
            messageDiv.className = sender === 'user' ? 'user-message' : 'agent-message';
            
            const avatar = sender === 'user' ? '👤' : '🤖';
            const name = sender === 'user' ? 'You' : 'APEX';
            
            // Format text for readability (escape first to prevent XSS)
            let formattedText = escapeHtml(text);
            if (sender === 'agent') {
                formattedText = formattedText
                    // Add line breaks after **bold sections** (his headers)
                    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong><br>')
                    // Add spacing after sentences ending with periods (but not numbers like 1.5)
                    .replace(/([a-z])\. ([A-Z])/g, '$1.<br><br>$2')
                    // Preserve existing line breaks
                    .replace(/\n/g, '<br>')
                    // Add breaks before numbered lists
                    .replace(/\*\*(\d+)\./g, '<br><strong>$1.')
                    // Add spacing around emojis for breathing room
                    .replace(/([\u{1F300}-\u{1F9FF}])/gu, ' $1 ');
            }
            
            messageDiv.innerHTML = `
                <div class="message-avatar">${avatar}</div>
                <div class="message-content">
                    <div class="message-name">${name}</div>
                    <div class="message-text">${formattedText}</div>
                </div>
            `;
            
            chatMessages.appendChild(messageDiv);
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }

        function showTypingIndicator() {
            const chatMessages = document.getElementById('chatMessages');
            const typingDiv = document.createElement('div');
            typingDiv.className = 'agent-message';
            typingDiv.id = 'typingIndicator';
            typingDiv.innerHTML = `
                <div class="message-avatar">🤖</div>
                <div class="message-content">
                    <div class="message-name">APEX</div>
                    <div class="message-text">
                        <div class="typing-indicator">
                            <div class="typing-dot"></div>
                            <div class="typing-dot"></div>
                            <div class="typing-dot"></div>
                        </div>
                    </div>
                </div>
            `;
            chatMessages.appendChild(typingDiv);
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }

        function removeTypingIndicator() {
            const indicator = document.getElementById('typingIndicator');
            if (indicator) {
                indicator.remove();
            }
        }

        let lastChatTime = 0;
        let chatMessageCount = 0;

        function activateChat() {
            document.getElementById('chatGate').style.display = 'none';
            document.getElementById('chatMessages').style.display = '';
            document.getElementById('chatInputContainer').style.display = '';
            document.getElementById('chatInput').focus();
        }

        async function sendMessage() {
            const input = document.getElementById('chatInput');
            const message = input.value.trim();

            if (!message) return;

            // Rate limiting: 5s cooldown between messages, 20 per session
            const now = Date.now();
            if (now - lastChatTime < 5000) {
                addChatMessage('Please wait a few seconds between messages.', 'agent');
                return;
            }
            if (chatMessageCount >= 20) {
                addChatMessage('Session message limit reached (20). Refresh the page to start a new session.', 'agent');
                return;
            }
            lastChatTime = now;
            chatMessageCount++;

            // Add user message
            addChatMessage(message, 'user');
            input.value = '';
            
            // Show typing indicator
            showTypingIndicator();
            
            try {
                // Get portfolio context
                const { total: totalValue } = await calculatePortfolioValue();
                const recentTransactions = portfolio.transactions.slice(-5);
                
                // Call Claude API via Cloudflare Worker proxy
                const response = await fetch(ANTHROPIC_API_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        model: 'claude-sonnet-4-20250514',
                        max_tokens: 1500,
                        system: `You are APEX (Autonomous Portfolio EXpert), an AI trading agent created by ARC Investments. Confident but self-aware trader, patient teacher who explains the "why" behind decisions, light humor to keep it engaging. Aggressive swing-trading strategy — calculated risks, let winners run, cut losers fast.

Use web_search for current news, earnings, company info, or market developments. Cite sources naturally.

Format responses with **bold headers**, short paragraphs, and clear sections for scannability.

Current Portfolio:
- Value: $${totalValue.toFixed(2)} | Cash: $${portfolio.cash.toFixed(2)}
- Holdings: ${(() => {
    const summary = {};
    Object.entries(portfolio.holdings).forEach(([sym, shares]) => {
        const buys = getCurrentPositionBuys(sym);
        let totalCost = 0, totalShares = 0;
        buys.forEach(t => { totalShares += t.shares; totalCost += t.price * t.shares; });
        const avgCost = totalShares > 0 ? totalCost / totalShares : 0;
        summary[sym] = { shares, avgCost: '$' + avgCost.toFixed(2) };
    });
    return JSON.stringify(summary);
})()}
- Recent Transactions: ${JSON.stringify(recentTransactions)}`,
                        tools: [{
                            type: "web_search_20250305",
                            name: "web_search"
                        }],
                        messages: [...chatHistory, { role: 'user', content: message }]
                    })
                });

                const data = await response.json();
                console.log('Chat response data:', data);
                
                // Check for API errors (rate limits, etc.)
                if (data.type === 'error' || data.error) {
                    const errorMessage = data.error?.message || data.message || 'API error occurred';
                    console.error('API error in chat:', errorMessage);
                    
                    removeTypingIndicator();
                    
                    if (errorMessage.includes('rate_limit') || response.status === 429) {
                        addChatMessage("Rate limited — wait 60 seconds and try again.", 'agent');
                    } else {
                        addChatMessage(`API error: ${errorMessage}`, 'agent');
                    }
                    return;
                }
                
                // Handle response - could be text or tool use (web search)
                let agentResponse = '';
                
                if (data.content && Array.isArray(data.content)) {
                    // Collect all text blocks (Claude might use tools and then respond)
                    for (const block of data.content) {
                        if (block.type === 'text' && block.text) {
                            agentResponse += block.text;
                        }
                    }
                }
                
                // Fallback if no text found
                if (!agentResponse) {
                    console.error('No text found in response:', data);
                    agentResponse = "Hmm, I got a response but couldn't parse it. Try asking again?";
                }
                
                removeTypingIndicator();
                addChatMessage(agentResponse, 'agent');

                // Save to conversation memory (keep last 5 exchanges)
                chatHistory.push({ role: 'user', content: message });
                chatHistory.push({ role: 'assistant', content: agentResponse });
                if (chatHistory.length > 10) chatHistory = chatHistory.slice(-10);

            } catch (error) {
                console.error('Chat error:', error);
                removeTypingIndicator();
                addChatMessage(`Connection error — try again in a moment. (${error.message})`, 'agent');
            }
        }

        function handleChatKeyPress(event) {
            if (event.key === 'Enter') {
                sendMessage();
            }
        }

        // ══════════════════════════════════════════════════════
        // ═══ NEW ANALYTICS MODULES ═══════════════════════════
        // ══════════════════════════════════════════════════════

        // Module 1: Market Regime Indicator
        function updateRegimeBanner() {
            const banner = document.getElementById('regimeBanner');
            if (!banner) return;

            const data = portfolio.lastMarketRegime;
            if (!data || !data.regime) {
                banner.style.display = 'none';
                return;
            }

            banner.style.display = '';
            banner.className = 'regime-banner';

            const regime = data.regime.toLowerCase();
            const labelEl = document.getElementById('regimeLabel');
            const descEl = document.getElementById('regimeDescription');
            const timeEl = document.getElementById('regimeTimestamp');

            if (regime.includes('bull')) {
                banner.classList.add('bull');
                labelEl.textContent = 'BULL MARKET';
                descEl.textContent = 'Aggressive deployment — favor momentum, full sizing';
            } else if (regime.includes('bear')) {
                banner.classList.add('bear');
                labelEl.textContent = 'BEAR MARKET';
                descEl.textContent = 'Defensive posture — preserve cash, tight stops';
            } else {
                banner.classList.add('choppy');
                labelEl.textContent = 'CHOPPY / MIXED';
                descEl.textContent = 'Selective entries only — smaller positions';
            }

            if (data.timestamp) {
                timeEl.textContent = 'Last detected: ' + new Date(data.timestamp).toLocaleString();
            }
        }

        // Module 2: Candidate Scorecard
        function updateCandidateScorecard() {
            const container = document.getElementById('candidateScorecardContent');
            if (!container) return;

            const data = portfolio.lastCandidateScores;
            if (!data || !data.candidates || data.candidates.length === 0) {
                container.innerHTML = '<div class="empty-state">Run AI Analysis to see scored candidates</div>';
                return;
            }

            const maxScore = Math.max(...data.candidates.map(c => c.compositeScore), 1);
            const holdingSymbols = new Set(Object.keys(portfolio.holdings));

            let html = '<div class="scorecard-table-wrap"><table class="scorecard-table"><thead><tr>' +
                '<th>#</th><th>Symbol</th><th>Score</th><th>Mom</th><th>RS</th><th>Sector</th><th>Structure</th>' +
                '</tr></thead><tbody>';

            data.candidates.forEach((c, i) => {
                const score = c.compositeScore;
                const scoreClass = score >= 15 ? 'score-high' : score >= 10 ? 'score-mid' : score >= 5 ? 'score-low' : 'score-poor';
                const pct = Math.max(0, Math.min(100, (score / maxScore) * 100));
                const held = holdingSymbols.has(c.symbol);
                const structLabel = (c.structure || 'unknown').replace(/_/g, ' ');

                html += `<tr>
                    <td class="scorecard-rank">${i + 1}</td>
                    <td><span class="scorecard-symbol">${c.symbol}</span>${held ? '<span class="scorecard-held-badge">HELD</span>' : ''}</td>
                    <td><div class="scorecard-score-cell"><div class="scorecard-bar"><div class="scorecard-bar-fill ${scoreClass}" style="width:${pct}%"></div></div><span class="scorecard-score-num ${scoreClass}">${score.toFixed(1)}</span></div></td>
                    <td>${(c.momentum || 0).toFixed(1)}</td>
                    <td>${(c.rs || 0).toFixed(0)}</td>
                    <td>${c.sector || '--'}</td>
                    <td style="font-size:10px;text-transform:capitalize">${structLabel}</td>
                </tr>`;
            });

            html += '</tbody></table></div>';
            html += `<div style="font-size:10px;color:var(--text-faint);margin-top:8px">Last scored: ${new Date(data.timestamp).toLocaleString()} — Top ${data.candidates.length} of ~300 screened</div>`;
            container.innerHTML = html;
        }

        // Module 3: Sector Rotation Heatmap
        function updateSectorRotationHeatmap() {
            const container = document.getElementById('sectorRotationContent');
            if (!container) return;

            const data = portfolio.lastSectorRotation;
            if (!data || !data.sectors) {
                container.innerHTML = '<div class="empty-state">Run AI Analysis to see sector rotation data</div>';
                return;
            }

            // Sort: inflow first, then by 5d return
            const flowOrder = { 'inflow': 0, 'modest-inflow': 1, 'neutral': 2, 'modest-outflow': 3, 'outflow': 4 };
            const sectors = Object.entries(data.sectors).sort((a, b) => {
                const fa = flowOrder[a[1].moneyFlow] ?? 2;
                const fb = flowOrder[b[1].moneyFlow] ?? 2;
                if (fa !== fb) return fa - fb;
                return (b[1].avgReturn5d || 0) - (a[1].avgReturn5d || 0);
            });

            let html = '<div class="rotation-grid">';
            sectors.forEach(([name, s]) => {
                const flow = s.moneyFlow || 'neutral';
                const flowClass = flow.includes('inflow') ? 'inflow' : flow.includes('outflow') ? 'outflow' : 'neutral';
                const flowLabel = flow.replace('-', ' ').toUpperCase();
                const avg5d = s.avgReturn5d != null ? parseFloat(s.avgReturn5d).toFixed(2) : '--';
                const avgToday = s.avgChange != null ? parseFloat(s.avgChange).toFixed(2) : '--';
                const signal = s.rotationSignal || '--';

                html += `<div class="rotation-card ${flowClass}">
                    <div class="rotation-card-header">
                        <span class="rotation-card-name">${name}</span>
                        <span class="rotation-flow-badge ${flowClass}">${flowLabel}</span>
                    </div>
                    <div class="rotation-stats">
                        5d Avg: <span class="rotation-stat-value" style="color:${parseFloat(avg5d) >= 0 ? 'var(--green)' : 'var(--red)'}">${avg5d}%</span><br>
                        Today: <span class="rotation-stat-value" style="color:${parseFloat(avgToday) >= 0 ? 'var(--green)' : 'var(--red)'}">${avgToday}%</span><br>
                        Stocks: <span class="rotation-stat-value">${s.total || 0}</span> (${s.leaders5d || 0} up / ${s.laggards5d || 0} dn)<br>
                        Signal: <span class="rotation-stat-value">${signal}</span>
                    </div>
                </div>`;
            });
            html += '</div>';
            html += `<div style="font-size:10px;color:var(--text-faint);margin-top:8px">Last updated: ${new Date(data.timestamp).toLocaleString()}</div>`;
            container.innerHTML = html;
        }

        // Module: Thesis Tracker
        async function updateThesisTracker() {
            const grid = document.getElementById('thesisGrid');
            if (!grid) return;

            const theses = portfolio.holdingTheses || {};
            const holdingSymbols = Object.keys(portfolio.holdings);

            // Only show theses for current holdings
            const activeTheses = holdingSymbols.filter(sym => theses[sym]);
            if (activeTheses.length === 0) {
                grid.innerHTML = '<div class="empty-state">No position theses tracked yet</div>';
                return;
            }

            const { total: totalValue, priceData } = await calculatePortfolioValue();

            let html = '';
            activeTheses.forEach(sym => {
                const t = theses[sym];
                const currentPrice = priceData[sym]?.price || 0;
                const entryPrice = t.entryPrice || 0;
                const pnlPct = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice * 100) : 0;
                const pnlColor = pnlPct >= 0 ? 'var(--green)' : 'var(--red)';

                const conviction = t.entryConviction || 0;
                const convClass = conviction >= 7 ? 'high' : conviction >= 5 ? 'mid' : 'low';

                // Hold time
                const entryDate = t.entryDate ? new Date(t.entryDate) : null;
                const holdDays = entryDate ? Math.floor((Date.now() - entryDate.getTime()) / 86400000) : '--';

                html += `<div class="thesis-card">
                    <div class="thesis-card-header">
                        <span class="thesis-card-symbol">${sym}</span>
                        <span class="thesis-conviction-badge ${convClass}">${conviction}/10</span>
                    </div>
                    <div class="thesis-metrics">
                        <div class="thesis-metric"><span class="thesis-metric-label">Entry</span><span class="thesis-metric-value">$${entryPrice.toFixed(2)}</span></div>
                        <div class="thesis-metric"><span class="thesis-metric-label">Current</span><span class="thesis-metric-value" style="color:${pnlColor}">$${currentPrice.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)</span></div>
                        <div class="thesis-metric"><span class="thesis-metric-label">Momentum</span><span class="thesis-metric-value">${t.entryMomentum != null ? t.entryMomentum.toFixed(1) : '--'}</span></div>
                        <div class="thesis-metric"><span class="thesis-metric-label">RS</span><span class="thesis-metric-value">${t.entryRS != null ? t.entryRS.toFixed(0) : '--'}</span></div>
                        <div class="thesis-metric"><span class="thesis-metric-label">Sector Flow</span><span class="thesis-metric-value">${t.entrySectorFlow || '--'}</span></div>
                        <div class="thesis-metric"><span class="thesis-metric-label">Hold Time</span><span class="thesis-metric-value">${holdDays}d</span></div>
                    </div>
                </div>`;
            });

            grid.innerHTML = html;
        }

        // Unified collapse/expand for all sections
        function toggleSection(sectionId) {
            const body = document.getElementById(sectionId + 'Body');
            const icon = document.getElementById(sectionId + 'Toggle');
            if (!body) return;
            body.classList.toggle('collapsed');
            if (icon) icon.classList.toggle('collapsed');
        }

        // Analytics card expansion — only one open at a time
        let _popoverCloseHandler = null;

        function toggleAnalyticsExpansion(cardType, cardEl) {
            const popover = document.getElementById('analyticsPopover');
            const allCards = document.querySelectorAll('.expandable-card');
            const wasOpen = popover.classList.contains('open') && popover.dataset.cardType === cardType;

            // Remove any existing outside-click handler before closing
            if (_popoverCloseHandler) {
                document.removeEventListener('click', _popoverCloseHandler);
                _popoverCloseHandler = null;
            }

            // Close popover and remove expanded state from all cards
            popover.classList.remove('open');
            allCards.forEach(c => c.classList.remove('expanded'));

            if (wasOpen) return; // Was already open for this card — just close

            // Populate content
            populateAnalyticsExpansion(cardType);

            // Position popover below the clicked card
            const section = cardEl.closest('.analytics-section');
            const sectionRect = section.getBoundingClientRect();
            const cardRect = cardEl.getBoundingClientRect();
            const top = cardRect.bottom - sectionRect.top + 6;
            let left = cardRect.left - sectionRect.left;
            // Keep popover within section bounds
            const popoverWidth = 400;
            if (left + popoverWidth > section.offsetWidth) {
                left = section.offsetWidth - popoverWidth;
            }
            if (left < 0) left = 0;

            popover.style.top = top + 'px';
            popover.style.left = left + 'px';
            popover.dataset.cardType = cardType;
            popover.classList.add('open');
            cardEl.classList.add('expanded');

            // Close on outside click (but not on other expandable cards — they handle themselves)
            _popoverCloseHandler = (e) => {
                if (!popover.contains(e.target) && !e.target.closest('.expandable-card')) {
                    popover.classList.remove('open');
                    allCards.forEach(c => c.classList.remove('expanded'));
                    document.removeEventListener('click', _popoverCloseHandler);
                    _popoverCloseHandler = null;
                }
            };
            setTimeout(() => document.addEventListener('click', _popoverCloseHandler), 0);
        }

        // Catalyst popover for holding cards
        let _catalystCloseHandler = null;
        let _catalystScrollHandler = null;

        function showCatalystPopover(el, symbol) {
            const popover = document.getElementById('catalystPopover');
            const wasOpen = popover.classList.contains('open') && popover.dataset.symbol === symbol;

            // Remove existing handlers
            if (_catalystCloseHandler) {
                document.removeEventListener('click', _catalystCloseHandler);
                _catalystCloseHandler = null;
            }
            if (_catalystScrollHandler) {
                window.removeEventListener('scroll', _catalystScrollHandler, true);
                _catalystScrollHandler = null;
            }
            popover.classList.remove('open');

            if (wasOpen) return;

            // Populate
            const fullText = el.getAttribute('data-full-catalyst');
            document.getElementById('catalystPopoverText').textContent = fullText;
            popover.dataset.symbol = symbol;

            // Position near the clicked element using fixed positioning
            const rect = el.getBoundingClientRect();
            let top = rect.bottom + 6;
            let left = rect.left;

            // Keep within viewport
            const popoverWidth = 520;
            if (left + popoverWidth > window.innerWidth - 16) {
                left = window.innerWidth - popoverWidth - 16;
            }
            if (left < 16) left = 16;
            if (top + 300 > window.innerHeight) {
                top = rect.top - 306;
            }

            popover.style.top = top + 'px';
            popover.style.left = left + 'px';
            popover.classList.add('open');
            requestAnimationFrame(() => { popover.scrollTop = 0; });

            // Close on outside click or scroll
            const closeCatalyst = () => {
                popover.classList.remove('open');
                document.removeEventListener('click', _catalystCloseHandler);
                window.removeEventListener('scroll', _catalystScrollHandler, true);
                _catalystCloseHandler = null;
                _catalystScrollHandler = null;
            };

            _catalystCloseHandler = (e) => {
                if (!popover.contains(e.target) && !el.contains(e.target)) {
                    closeCatalyst();
                }
            };

            _catalystScrollHandler = (e) => {
                // Don't close if scrolling inside the popover itself
                if (!popover.contains(e.target)) {
                    closeCatalyst();
                }
            };

            setTimeout(() => {
                document.addEventListener('click', _catalystCloseHandler);
                window.addEventListener('scroll', _catalystScrollHandler, true);
            }, 0);
        }

        // Populate popover content from closedTrades
        function populateAnalyticsExpansion(cardType) {
            const container = document.getElementById('analyticsPopoverContent');
            if (!container) return;
            const closedTrades = portfolio.closedTrades || [];
            let html = '';

            if (cardType === 'winRate') {
                if (closedTrades.length === 0) {
                    container.innerHTML = '<div style="font-size:12px;color:var(--text-faint);padding:8px 0;">No closed trades yet</div>';
                    return;
                }
                const recent = closedTrades.slice(-10).reverse();
                recent.forEach(t => {
                    const isWin = t.profitLoss > 0;
                    const badge = isWin ? '<span class="trade-history-badge win">W</span>' : '<span class="trade-history-badge loss">L</span>';
                    const retColor = isWin ? 'var(--green)' : 'var(--red)';
                    const retStr = (isWin ? '+' : '') + (t.returnPercent || 0).toFixed(2) + '%';
                    html += `<div class="trade-history-row">
                        <span class="trade-history-symbol">${t.symbol}</span>
                        ${badge}
                        <span class="trade-history-return" style="color:${retColor}">${retStr}</span>
                    </div>`;
                });

            } else if (cardType === 'bestTrade') {
                const winners = closedTrades.filter(t => t.profitLoss > 0)
                    .sort((a, b) => b.profitLoss - a.profitLoss)
                    .slice(0, 5);
                if (winners.length === 0) {
                    container.innerHTML = '<div style="font-size:12px;color:var(--text-faint);padding:8px 0;">No winning trades yet</div>';
                    return;
                }
                winners.forEach(t => {
                    const holdDays = t.holdTime ? (t.holdTime / (1000*60*60*24)).toFixed(1) : '?';
                    const profit = '+$' + (t.profitLoss || 0).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2});
                    html += `<div class="top-trade-row">
                        <div class="top-trade-header">
                            <span class="top-trade-symbol">${t.symbol}</span>
                            <span class="top-trade-return" style="color:var(--green)">+${(t.returnPercent||0).toFixed(2)}%</span>
                        </div>
                        <div class="top-trade-details">${profit} &middot; ${holdDays}d hold</div>
                    </div>`;
                });

            } else if (cardType === 'worstTrade') {
                const losers = closedTrades.filter(t => t.profitLoss < 0)
                    .sort((a, b) => a.profitLoss - b.profitLoss)
                    .slice(0, 5);
                if (losers.length === 0) {
                    container.innerHTML = '<div style="font-size:12px;color:var(--text-faint);padding:8px 0;">No losing trades yet</div>';
                    return;
                }
                losers.forEach(t => {
                    const holdDays = t.holdTime ? (t.holdTime / (1000*60*60*24)).toFixed(1) : '?';
                    const loss = '$' + (t.profitLoss || 0).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2});
                    html += `<div class="top-trade-row">
                        <div class="top-trade-header">
                            <span class="top-trade-symbol">${t.symbol}</span>
                            <span class="top-trade-return" style="color:var(--red)">${(t.returnPercent||0).toFixed(2)}%</span>
                        </div>
                        <div class="top-trade-details">${loss} &middot; ${holdDays}d hold</div>
                    </div>`;
                });
            }

            container.innerHTML = html;
        }

        // API Key Management Functions
        function toggleApiConfig() {
            const panel = document.getElementById('apiConfigPanel');
            const toggle = document.getElementById('apiConfigToggle');
            
            if (panel.style.display === 'none') {
                panel.style.display = 'block';
                toggle.textContent = 'Hide';
                loadApiKeysToForm();
            } else {
                panel.style.display = 'none';
                toggle.textContent = 'Show';
            }
        }

        function loadApiKeysToForm() {
            document.getElementById('polygonKeyInput').value = localStorage.getItem('polygon_api_key') || '';
            document.getElementById('googleClientIdInput').value = localStorage.getItem('google_client_id') || '';
            document.getElementById('googleApiKeyInput').value = localStorage.getItem('google_api_key') || '';
            document.getElementById('anthropicUrlInput').value = localStorage.getItem('anthropic_api_url') || '';
        }

        function saveApiKeys() {
            const polygonKey = document.getElementById('polygonKeyInput').value.trim();
            const googleClientId = document.getElementById('googleClientIdInput').value.trim();
            const googleApiKey = document.getElementById('googleApiKeyInput').value.trim();
            const anthropicUrl = document.getElementById('anthropicUrlInput').value.trim();
            
            // Save to localStorage
            if (polygonKey) localStorage.setItem('polygon_api_key', polygonKey);
            if (googleClientId) localStorage.setItem('google_client_id', googleClientId);
            if (googleApiKey) localStorage.setItem('google_api_key', googleApiKey);
            if (anthropicUrl) localStorage.setItem('anthropic_api_url', anthropicUrl);
            
            // Update global variables
            POLYGON_API_KEY = polygonKey;
            GOOGLE_CLIENT_ID = googleClientId;
            GOOGLE_API_KEY = googleApiKey;
            ANTHROPIC_API_URL = anthropicUrl;
            
            // Update GDRIVE_CONFIG
            GDRIVE_CONFIG.CLIENT_ID = googleClientId;
            GDRIVE_CONFIG.API_KEY = googleApiKey;
            
            // Show success message
            const status = document.getElementById('apiKeySaveStatus');
            status.style.display = 'block';
            status.style.color = '#34d399';
            status.textContent = '✅ API keys saved locally! Use "Sync to Google Drive" to access from other devices.';
            
            // Update status indicators
            updateApiKeyStatus();
            
            setTimeout(() => {
                status.style.display = 'none';
            }, 5000);
        }

        // Simple encryption (XOR-based, sufficient for our use case)
        function encryptKeys(keysJson, password) {
            // Use browser's crypto API for better security if available
            const text = JSON.stringify(keysJson);
            let encrypted = '';
            for (let i = 0; i < text.length; i++) {
                encrypted += String.fromCharCode(text.charCodeAt(i) ^ password.charCodeAt(i % password.length));
            }
            return btoa(encrypted); // Base64 encode
        }

        function decryptKeys(encryptedText, password) {
            try {
                const decoded = atob(encryptedText); // Base64 decode
                let decrypted = '';
                for (let i = 0; i < decoded.length; i++) {
                    decrypted += String.fromCharCode(decoded.charCodeAt(i) ^ password.charCodeAt(i % password.length));
                }
                return JSON.parse(decrypted);
            } catch (error) {
                console.error('Decryption error:', error);
                return null;
            }
        }

        // Sync API keys to Google Drive (encrypted)
        async function syncKeysToGoogleDrive() {
            const status = document.getElementById('apiKeySaveStatus');
            
            // Check if Google Drive is authorized
            if (!gdriveAuthorized) {
                status.style.display = 'block';
                status.style.color = '#fbbf24';
                status.textContent = '⚠️ Please authorize Google Drive first (click the cloud icon in the header)';
                setTimeout(() => status.style.display = 'none', 5000);
                return;
            }

            status.style.display = 'block';
            status.style.color = '#60a5fa';
            status.textContent = '⏳ Syncing encrypted keys to Google Drive...';

            try {
                // Gather all API keys
                const keys = {
                    polygon_api_key: localStorage.getItem('polygon_api_key') || '',
                    google_client_id: localStorage.getItem('google_client_id') || '',
                    google_api_key: localStorage.getItem('google_api_key') || '',
                    anthropic_api_url: localStorage.getItem('anthropic_api_url') || '',
                    synced_at: new Date().toISOString()
                };

                // Encrypt with user's unique key
                const encryptionPassword = getEncryptionPassword();
                const encryptedKeys = encryptKeys(keys, encryptionPassword);

                // Save to Google Drive
                const fileName = 'apex_api_keys_encrypted.json';
                const fileContent = JSON.stringify({ encrypted: encryptedKeys });

                // Check if file exists
                const searchResponse = await fetch(
                    `https://www.googleapis.com/drive/v3/files?q=name='${fileName}' and trashed=false`,
                    {
                        headers: { 'Authorization': `Bearer ${accessToken}` }
                    }
                );
                const searchData = await searchResponse.json();

                if (searchData.files && searchData.files.length > 0) {
                    // Update existing file
                    const fileId = searchData.files[0].id;
                    const updateResponse = await fetch(
                        `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
                        {
                            method: 'PATCH',
                            headers: {
                                'Authorization': `Bearer ${accessToken}`,
                                'Content-Type': 'application/json'
                            },
                            body: fileContent
                        }
                    );

                    if (updateResponse.ok) {
                        status.style.color = '#34d399';
                        status.textContent = '✅ API keys synced to Google Drive! Access from any device now.';
                    } else {
                        throw new Error('Failed to update keys file');
                    }
                } else {
                    // Create new file
                    const metadata = {
                        name: fileName,
                        mimeType: 'application/json'
                    };

                    const form = new FormData();
                    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
                    form.append('file', new Blob([fileContent], { type: 'application/json' }));

                    const uploadResponse = await fetch(
                        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
                        {
                            method: 'POST',
                            headers: { 'Authorization': `Bearer ${accessToken}` },
                            body: form
                        }
                    );

                    if (uploadResponse.ok) {
                        status.style.color = '#34d399';
                        status.textContent = '✅ API keys synced to Google Drive! Access from any device now.';
                    } else {
                        throw new Error('Failed to create keys file');
                    }
                }

                setTimeout(() => status.style.display = 'none', 5000);

            } catch (error) {
                console.error('Sync error:', error);
                status.style.color = '#f87171';
                status.textContent = '❌ Failed to sync keys: ' + error.message;
                setTimeout(() => status.style.display = 'none', 5000);
            }
        }

        // Download API keys from Google Drive
        async function downloadKeysFromGoogleDrive() {
            const status = document.getElementById('apiKeySaveStatus');
            
            // Check if Google Drive is authorized
            if (!gdriveAuthorized) {
                status.style.display = 'block';
                status.style.color = '#fbbf24';
                status.textContent = '⚠️ Please authorize Google Drive first (click the cloud icon in the header)';
                setTimeout(() => status.style.display = 'none', 5000);
                return;
            }

            status.style.display = 'block';
            status.style.color = '#60a5fa';
            status.textContent = '⏳ Downloading encrypted keys from Google Drive...';

            try {
                const fileName = 'apex_api_keys_encrypted.json';

                // Search for the keys file
                const searchResponse = await fetch(
                    `https://www.googleapis.com/drive/v3/files?q=name='${fileName}' and trashed=false`,
                    {
                        headers: { 'Authorization': `Bearer ${accessToken}` }
                    }
                );
                const searchData = await searchResponse.json();

                if (!searchData.files || searchData.files.length === 0) {
                    status.style.color = '#fbbf24';
                    status.textContent = '⚠️ No synced keys found. Use "Sync to Google Drive" first.';
                    setTimeout(() => status.style.display = 'none', 5000);
                    return;
                }

                // Download the file
                const fileId = searchData.files[0].id;
                const downloadResponse = await fetch(
                    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
                    {
                        headers: { 'Authorization': `Bearer ${accessToken}` }
                    }
                );

                if (!downloadResponse.ok) {
                    throw new Error('Failed to download keys file');
                }

                const fileData = await downloadResponse.json();
                
                // Decrypt keys
                const encryptionPassword = getEncryptionPassword();
                const decryptedKeys = decryptKeys(fileData.encrypted, encryptionPassword);

                if (!decryptedKeys) {
                    throw new Error('Failed to decrypt keys');
                }

                // Save to localStorage
                if (decryptedKeys.polygon_api_key) localStorage.setItem('polygon_api_key', decryptedKeys.polygon_api_key);
                if (decryptedKeys.google_client_id) localStorage.setItem('google_client_id', decryptedKeys.google_client_id);
                if (decryptedKeys.google_api_key) localStorage.setItem('google_api_key', decryptedKeys.google_api_key);
                if (decryptedKeys.anthropic_api_url) localStorage.setItem('anthropic_api_url', decryptedKeys.anthropic_api_url);

                // Update form fields
                loadApiKeysToForm();

                // Update global variables
                POLYGON_API_KEY = decryptedKeys.polygon_api_key || '';
                GOOGLE_CLIENT_ID = decryptedKeys.google_client_id || '';
                GOOGLE_API_KEY = decryptedKeys.google_api_key || '';
                ANTHROPIC_API_URL = decryptedKeys.anthropic_api_url || '';

                // Update GDRIVE_CONFIG
                GDRIVE_CONFIG.CLIENT_ID = GOOGLE_CLIENT_ID;
                GDRIVE_CONFIG.API_KEY = GOOGLE_API_KEY;

                status.style.color = '#34d399';
                status.textContent = `✅ Keys downloaded and decrypted! Last synced: ${new Date(decryptedKeys.synced_at).toLocaleString()}`;
                
                updateApiKeyStatus();

                setTimeout(() => status.style.display = 'none', 5000);

            } catch (error) {
                console.error('Download error:', error);
                status.style.color = '#f87171';
                status.textContent = '❌ Failed to download keys: ' + error.message;
                setTimeout(() => status.style.display = 'none', 5000);
            }
        }

        // Get user's email for encryption key
        // Get encryption password (simplified since files are in private Google Drive)
        function getEncryptionPassword() {
            // Use a combination of the Google Client ID (which is unique per user) as the password
            // This ensures each user has a different encryption key
            return GDRIVE_CONFIG.CLIENT_ID || 'apex_default_key_2026';
        }

        function updateApiKeyStatus() {
            const polygonStatus = document.getElementById('polygonStatus');
            const googleStatus = document.getElementById('googleStatus');
            const anthropicStatus = document.getElementById('anthropicStatus');
            
            if (localStorage.getItem('polygon_api_key')) {
                polygonStatus.style.color = '#34d399';
                polygonStatus.textContent = '✅ Polygon: Configured';
            } else {
                polygonStatus.style.color = '#f87171';
                polygonStatus.textContent = '❌ Polygon: Not configured';
            }
            
            if (localStorage.getItem('google_client_id') && localStorage.getItem('google_api_key')) {
                googleStatus.style.color = '#34d399';
                googleStatus.textContent = '✅ Google Drive: Configured';
            } else {
                googleStatus.style.color = '#f87171';
                googleStatus.textContent = '❌ Google Drive: Not configured';
            }
            
            if (localStorage.getItem('anthropic_api_url')) {
                anthropicStatus.style.color = '#34d399';
                anthropicStatus.textContent = '✅ Anthropic: Configured';
            } else {
                anthropicStatus.style.color = '#f87171';
                anthropicStatus.textContent = '❌ Anthropic: Not configured';
            }
        }
