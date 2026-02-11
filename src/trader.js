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
            'GTLB': 'GitLab', 'FROG': 'JFrog', 'BILL': 'Bill Holdings', 'DOCN': 'DigitalOcean',
            'GTM': 'ZoomInfo', 'MNDY': 'monday.com', 'PCOR': 'Procore', 'APP': 'AppLovin',
            'INTU': 'Intuit',

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

            // EV/Automotive
            'TSLA': 'Tesla', 'RIVN': 'Rivian', 'LCID': 'Lucid Group', 'NIO': 'NIO Inc.',
            'XPEV': 'XPeng', 'LI': 'Li Auto', 'F': 'Ford', 'GM': 'General Motors',
            'STLA': 'Stellantis', 'TM': 'Toyota', 'HMC': 'Honda', 'RACE': 'Ferrari',
            'VWAGY': 'Volkswagen', 'PSNY': 'Polestar', 'NSANY': 'Nissan', 'MBGYY': 'Mercedes-Benz',
            'POAHY': 'Porsche', 'FUJHY': 'Subaru', 'BLNK': 'Blink Charging', 'CHPT': 'ChargePoint',
            'EVGO': 'EVgo', 'PAG': 'Penske Auto', 'WOLF': 'Wolfspeed',
            'QS': 'QuantumScape', 'WKHS': 'Workhorse', 'ALV': 'Autoliv',
            'HYLN': 'Hyliion', 'GEV': 'GE Vernova', 'JZXN': 'Jiuzi Holdings', 'VRM': 'Vroom',
            'CVNA': 'Carvana', 'KMX': 'CarMax', 'APTV': 'Aptiv',
            'OUST': 'Ouster', 'AN': 'AutoNation', 'LAD': 'Lithia Motors',

            // Finance
            'JPM': 'JPMorgan Chase', 'BAC': 'Bank of America', 'V': 'Visa', 'MA': 'Mastercard',
            'COIN': 'Coinbase', 'SOFI': 'SoFi', 'PYPL': 'PayPal', 'SQ': 'Block (Square)',
            'WFC': 'Wells Fargo', 'GS': 'Goldman Sachs', 'MS': 'Morgan Stanley', 'C': 'Citigroup',
            'BLK': 'BlackRock', 'SCHW': 'Charles Schwab', 'AFRM': 'Affirm', 'UPST': 'Upstart',
            'NU': 'Nu Holdings', 'MELI': 'MercadoLibre', 'HOOD': 'Robinhood',
            'GPN': 'Global Payments', 'LC': 'LendingClub', 'AXP': 'American Express',
            'FIS': 'Fidelity National', 'COF': 'Capital One', 'ALLY': 'Ally Financial',
            'USB': 'U.S. Bancorp', 'PNC': 'PNC Financial', 'TFC': 'Truist Financial',
            'RF': 'Regions Financial', 'KEY': 'KeyCorp', 'FITB': 'Fifth Third', 'CFG': 'Citizens Financial',
            'HBAN': 'Huntington Bancshares', 'MTB': 'M&T Bank', 'STT': 'State Street', 'BK': 'Bank of New York',
            'NTRS': 'Northern Trust', 'ZION': 'Zions Bancorp', 'FHN': 'First Horizon',
            'WRB': 'Berkley', 'CB': 'Chubb', 'TRV': 'Travelers', 'ALL': 'Allstate',
            'PGR': 'Progressive', 'AIG': 'AIG', 'MET': 'MetLife', 'PRU': 'Prudential',
            'RKT': 'Rocket Companies',

            // Growth
            'DKNG': 'DraftKings', 'RBLX': 'Roblox', 'U': 'Unity Software', 'PINS': 'Pinterest',
            'SNAP': 'Snap Inc.', 'SPOT': 'Spotify', 'ROKU': 'Roku', 'ABNB': 'Airbnb',
            'LYFT': 'Lyft', 'DASH': 'DoorDash', 'UBER': 'Uber', 'SHOP': 'Shopify',
            'SE': 'Sea Limited', 'BABA': 'Alibaba', 'JD': 'JD.com', 'PDD': 'Pinduoduo',
            'CPNG': 'Coupang', 'BKNG': 'Booking Holdings', 'EXPE': 'Expedia', 'TCOM': 'Trip.com',
            'TRIP': 'TripAdvisor', 'PTON': 'Peloton', 'OPEN': 'Opendoor', 'COMP': 'Compass',
            'CWAN': 'Clearwater Analytics', 'DUOL': 'Duolingo', 'BROS': 'Dutch Bros', 'CAVA': 'CAVA Group',

            // Healthcare
            'JNJ': 'Johnson & Johnson', 'UNH': 'UnitedHealth', 'LLY': 'Eli Lilly', 'PFE': 'Pfizer',
            'MRNA': 'Moderna', 'ABBV': 'AbbVie', 'VRTX': 'Vertex Pharma', 'REGN': 'Regeneron',
            'BMY': 'Bristol Myers Squibb', 'GILD': 'Gilead Sciences', 'AMGN': 'Amgen', 'CVS': 'CVS Health',
            'ISRG': 'Intuitive Surgical', 'TMO': 'Thermo Fisher', 'DHR': 'Danaher', 'ABT': 'Abbott Labs',
            'CI': 'Cigna', 'HUM': 'Humana', 'SYK': 'Stryker', 'BSX': 'Boston Scientific',
            'MDT': 'Medtronic', 'BDX': 'Becton Dickinson', 'BAX': 'Baxter', 'ZBH': 'Zimmer Biomet',
            'HCA': 'HCA Healthcare', 'DVA': 'DaVita',
            'EXAS': 'Exact Sciences', 'ILMN': 'Illumina', 'BIIB': 'Biogen', 'ALNY': 'Alnylam',
            'INCY': 'Incyte', 'NBIX': 'Neurocrine Bio', 'UTHR': 'United Therapeutics', 'JAZZ': 'Jazz Pharma',
            'SRPT': 'Sarepta', 'BMRN': 'BioMarin', 'IONS': 'Ionis Pharma', 'RGEN': 'Repligen',

            // Consumer
            'AMZN': 'Amazon', 'WMT': 'Walmart', 'COST': 'Costco', 'TGT': 'Target',
            'HD': 'Home Depot', 'LOW': "Lowe's", 'SBUX': 'Starbucks', 'MCD': "McDonald's",
            'NKE': 'Nike', 'LULU': 'Lululemon', 'DIS': 'Disney', 'NFLX': 'Netflix',
            'KO': 'Coca-Cola', 'PEP': 'PepsiCo',
            'CMG': 'Chipotle', 'YUM': 'Yum! Brands', 'ETSY': 'Etsy', 'W': 'Wayfair', 'CHWY': 'Chewy',
            'WBD': 'Warner Bros Discovery', 'FOXA': 'Fox Corp', 'CMCSA': 'Comcast',
            'T': 'AT&T', 'VZ': 'Verizon', 'TMUS': 'T-Mobile',
            'PM': 'Philip Morris', 'MO': 'Altria', 'BUD': 'AB InBev', 'TAP': 'Molson Coors',
            'STZ': 'Constellation Brands', 'MNST': 'Monster Beverage', 'CELH': 'Celsius', 'KDP': 'Keurig Dr Pepper',
            'ULTA': 'Ulta Beauty', 'ELF': 'e.l.f. Beauty', 'RH': 'RH (Restoration Hardware)',
            'DECK': 'Deckers Outdoor', 'CROX': 'Crocs', 'LEVI': "Levi Strauss", 'UAA': 'Under Armour',
            'ORLY': "O'Reilly Auto", 'AZO': 'AutoZone', 'AAP': 'Advance Auto Parts',
            'GPC': 'Genuine Parts', 'TSCO': 'Tractor Supply', 'DG': 'Dollar General', 'DLTR': 'Dollar Tree',
            'ROST': 'Ross Stores', 'TJX': 'TJX Companies', 'BBY': 'Best Buy',

            // Energy
            'XOM': 'ExxonMobil', 'CVX': 'Chevron', 'COP': 'ConocoPhillips', 'SLB': 'Schlumberger',
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

            // Industrials
            'BA': 'Boeing', 'CAT': 'Caterpillar', 'DE': 'Deere & Co.', 'GE': 'General Electric',
            'HON': 'Honeywell', 'UPS': 'United Parcel Service', 'FDX': 'FedEx',
            'MMM': '3M', 'UNP': 'Union Pacific', 'NSC': 'Norfolk Southern', 'CSX': 'CSX Corporation',
            'CHRW': 'C.H. Robinson', 'CMI': 'Cummins', 'EMR': 'Emerson Electric', 'ETN': 'Eaton',
            'PH': 'Parker Hannifin', 'ROK': 'Rockwell Automation', 'AME': 'Ametek', 'DOV': 'Dover', 'ITW': 'Illinois Tool Works',
            'DHI': 'D.R. Horton', 'LEN': 'Lennar', 'NVR': 'NVR Inc.', 'PHM': 'PulteGroup',
            'TOL': 'Toll Brothers', 'BLD': 'TopBuild', 'BLDR': 'Builders FirstSource',
            'JBHT': 'J.B. Hunt', 'KNX': 'Knight-Swift', 'ODFL': 'Old Dominion Freight', 'XPO': 'XPO Logistics',
            'IR': 'Ingersoll Rand', 'WM': 'Waste Management', 'RSG': 'Republic Services',
            'PCAR': 'Paccar', 'PWR': 'Quanta Services', 'JCI': 'Johnson Controls',
            'AOS': 'A.O. Smith', 'ROP': 'Roper Technologies', 'CARR': 'Carrier Global', 'VLTO': 'Veralto',

            // Real Estate
            'AMT': 'American Tower', 'PLD': 'Prologis', 'EQIX': 'Equinix', 'O': 'Realty Income',
            'CCI': 'Crown Castle', 'PSA': 'Public Storage', 'DLR': 'Digital Realty', 'WELL': 'Welltower',
            'VICI': 'VICI Properties', 'SPG': 'Simon Property', 'AVB': 'AvalonBay', 'EQR': 'Equity Residential',
            'MAA': 'Mid-America Apartment', 'UDR': 'UDR Inc.', 'CPT': 'Camden Property', 'ESS': 'Essex Property',
            'AIV': 'Aimco', 'ELS': 'Equity LifeStyle', 'SUI': 'Sun Communities', 'NXRT': 'NexPoint Residential',
            'VTR': 'Ventas', 'STWD': 'Starwood Property', 'DOC': 'Healthpeak', 'OHI': 'Omega Healthcare',
            'SBRA': 'Sabra Healthcare', 'LTC': 'LTC Properties', 'HR': 'Healthcare Realty', 'MPT': 'Medical Properties Trust',
            'NHI': 'National Health Investors', 'CTRE': 'CareTrust REIT', 'IRM': 'Iron Mountain', 'CUBE': 'CubeSmart',
            'NSA': 'National Storage', 'REXR': 'Rexford Industrial',
            'TRNO': 'Terreno Realty', 'SELF': 'Global Self Storage', 'SAFE': 'Safehold',

            // Materials
            'NEM': 'Newmont', 'FCX': 'Freeport-McMoRan', 'NUE': 'Nucor', 'DOW': 'Dow Inc.',
            'USAR': 'USA Rare Earth', 'UUUU': 'Energy Fuels', 'NB': 'NioCorp Developments', 'MP': 'MP Materials',
            'GOLD': 'Barrick Gold', 'AU': 'AngloGold Ashanti', 'AEM': 'Agnico Eagle', 'WPM': 'Wheaton Precious Metals',
            'FNV': 'Franco-Nevada', 'RGLD': 'Royal Gold', 'KGC': 'Kinross Gold', 'HL': 'Hecla Mining',
            'STLD': 'Steel Dynamics', 'RS': 'Reliance Steel', 'CLF': 'Cleveland-Cliffs', 'MT': 'ArcelorMittal',
            'TX': 'Ternium', 'CMC': 'Commercial Metals', 'ATI': 'ATI Inc.',
            'LYB': 'LyondellBasell', 'EMN': 'Eastman Chemical', 'CE': 'Celanese', 'DD': 'DuPont',
            'APD': 'Air Products', 'LIN': 'Linde', 'ECL': 'Ecolab',
            'SHW': 'Sherwin-Williams', 'PPG': 'PPG Industries', 'RPM': 'RPM International', 'AXTA': 'Axalta Coating',
            'ALB': 'Albemarle', 'SQM': 'SQM', 'LAC': 'Lithium Americas', 'AA': 'Alcoa',
            'FUL': 'H.B. Fuller', 'NEU': 'NewMarket',

            // Defense
            'LMT': 'Lockheed Martin', 'RTX': 'RTX Corporation', 'NOC': 'Northrop Grumman', 'GD': 'General Dynamics',
            'LHX': 'L3Harris', 'HII': 'Huntington Ingalls', 'TXT': 'Textron', 'HWM': 'Howmet Aerospace',
            'AXON': 'Axon Enterprise', 'KTOS': 'Kratos Defense', 'AVAV': 'AeroVironment', 'AIR': 'AAR Corp',
            'SAIC': 'SAIC', 'LDOS': 'Leidos', 'CACI': 'CACI International', 'BAH': 'Booz Allen Hamilton',
            'BWXT': 'BWX Technologies', 'WWD': 'Woodward', 'TDG': 'TransDigm', 'HEI': 'HEICO',
            'CW': 'Curtiss-Wright', 'LGTY': 'Logility',

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
            'GTM': 'Technology', 'MNDY': 'Technology', 'PCOR': 'Technology', 'APP': 'Technology',
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
            'IONQ': 'Technology', 'RGTI': 'Technology', 'QBTS': 'Technology', 'QUBT': 'Technology',
            'ARQQ': 'Technology', 'IBM': 'Technology',

            // EV/Automotive
            'TSLA': 'Automotive', 'RIVN': 'Automotive', 'LCID': 'Automotive', 'NIO': 'Automotive',
            'XPEV': 'Automotive', 'LI': 'Automotive', 'F': 'Automotive', 'GM': 'Automotive',
            'STLA': 'Automotive', 'TM': 'Automotive', 'HMC': 'Automotive', 'RACE': 'Automotive',
            'VWAGY': 'Automotive', 'PSNY': 'Automotive', 'NSANY': 'Automotive',
            'MBGYY': 'Automotive', 'POAHY': 'Automotive', 'FUJHY': 'Automotive', 
            'BLNK': 'Automotive', 'CHPT': 'Automotive', 'EVGO': 'Automotive',
            'PAG': 'Automotive', 'WOLF': 'Automotive', 'QS': 'Automotive',
            'WKHS': 'Automotive', 'ALV': 'Automotive', 'HYLN': 'Automotive',
            'GEV': 'Automotive', 'JZXN': 'Automotive', 'VRM': 'Automotive',
            'CVNA': 'Automotive', 'KMX': 'Automotive', 'APTV': 'Automotive',
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
            'ZION': 'Financial', 'FHN': 'Financial',
            'WRB': 'Financial', 'CB': 'Financial', 'TRV': 'Financial', 'ALL': 'Financial',
            'PGR': 'Financial', 'AIG': 'Financial', 'MET': 'Financial', 'PRU': 'Financial',

            // Growth Tech/Consumer
            'DKNG': 'Technology', 'RBLX': 'Technology', 'U': 'Technology', 'PINS': 'Technology',
            'SNAP': 'Technology', 'SPOT': 'Technology', 'ABNB': 'Consumer',
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
            'HCA': 'Healthcare', 'DVA': 'Healthcare',
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
            'ENPH': 'Energy', 'SEDG': 'Energy', 'RUN': 'Energy',
            'FSLR': 'Energy', 'PLUG': 'Energy', 'PBF': 'Energy', 'DK': 'Energy',
            'CTRA': 'Energy', 'OVV': 'Energy', 'PR': 'Energy', 'SM': 'Energy',
            'MGY': 'Energy', 'MTDR': 'Energy', 'CHRD': 'Energy', 'VNOM': 'Energy',
            'SMR': 'Energy', 'VST': 'Energy', 'CEG': 'Energy', 'CCJ': 'Energy',
            'LNG': 'Energy', 'AR': 'Energy',

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
            'SBRA': 'Real Estate', 'LTC': 'Real Estate', 'HR': 'Real Estate', 'MPT': 'Real Estate',
            'NHI': 'Real Estate', 'CTRE': 'Real Estate', 'IRM': 'Real Estate', 'CUBE': 'Real Estate',
            'NSA': 'Real Estate', 'REXR': 'Real Estate',
            'TRNO': 'Real Estate', 'SELF': 'Real Estate', 'SAFE': 'Real Estate',
            
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
            'AIN': 'Defense', 'MLI': 'Defense', 'B': 'Defense',
            'RUSHA': 'Defense', 'LGTY': 'Defense', 'PLXS': 'Defense',
            'VECO': 'Defense', 'POWI': 'Defense', 'VICR': 'Defense', 'MYRG': 'Defense',
            'DY': 'Defense', 'APOG': 'Defense', 'IMOS': 'Defense',
            
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
        
        // Check if US stock market is currently open (9:30 AM - 4:00 PM ET, weekdays)
        function isMarketOpen() {
            const now = new Date();
            // Convert to Eastern Time
            const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
            const day = et.getDay(); // 0=Sun, 6=Sat
            if (day === 0 || day === 6) return false;
            const hours = et.getHours();
            const minutes = et.getMinutes();
            const timeMinutes = hours * 60 + minutes;
            // Market open: 9:30 (570 min) to 16:00 (960 min)
            return timeMinutes >= 570 && timeMinutes < 960;
        }

        // Price cache to store real data and prevent mock data usage
        let priceCache = {};
        let apiCallsToday = 0;  // Consolidated - removed duplicate apiCallCount
        let lastResetDate = new Date().toDateString();
        let chatHistory = []; // Conversation memory for chat (last 5 exchanges)

        // Streaming fetch for Anthropic API — reads SSE events and reconstructs
        // the same message object shape that response.json() would return.
        // Keeps the Cloudflare Worker connection alive so free-plan 100s timeout is never hit.
        async function fetchAnthropicStreaming(bodyParams) {
            const resp = await fetch(ANTHROPIC_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(bodyParams)
            });

            // Non-streaming path: error responses or worker didn't enable streaming
            const ct = resp.headers.get('content-type') || '';
            if (!resp.ok || !ct.includes('text/event-stream')) {
                return await resp.json();
            }

            // SSE streaming path — reconstruct a Messages-API-shaped object
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            let message = null;   // top-level envelope from message_start
            const blocks = [];    // content blocks accumulated here

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });

                // Process complete lines
                let nl;
                while ((nl = buf.indexOf('\n')) !== -1) {
                    const line = buf.slice(0, nl).trim();
                    buf = buf.slice(nl + 1);
                    if (!line.startsWith('data: ')) continue;
                    const payload = line.slice(6);
                    if (payload === '[DONE]') continue;

                    let evt;
                    try { evt = JSON.parse(payload); } catch { continue; }

                    switch (evt.type) {
                        case 'message_start':
                            message = evt.message;          // { id, type, role, content:[], model, ... }
                            break;
                        case 'content_block_start':
                            blocks[evt.index] = evt.content_block; // { type:'text', text:'' }
                            break;
                        case 'content_block_delta':
                            if (evt.delta?.type === 'text_delta' && blocks[evt.index] != null) {
                                blocks[evt.index].text = (blocks[evt.index].text || '') + evt.delta.text;
                            }
                            break;
                        case 'message_delta':
                            if (message) {
                                if (evt.delta?.stop_reason) message.stop_reason = evt.delta.stop_reason;
                                if (evt.usage) message.usage = { ...message.usage, ...evt.usage };
                            }
                            break;
                    }
                }
            }

            if (message) {
                message.content = blocks;
                return message;
            }
            // Fallback — shouldn't happen, but return an error shape so callers handle it
            return { type: 'error', error: { message: 'Stream ended without message_start event' } };
        }

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
                            pointStyle: 'line',
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
                            pointStyle: 'dash',
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
                                usePointStyle: true,
                                pointStyleWidth: 18,
                                boxHeight: 7,
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
                            grace: '5%',
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
            
            // Dataset 2: Trading P&L (value minus cumulative deposits at each point)
            // Walk the history and track how much cash has been deposited up to each point.
            // The first entry is always the initial balance (a deposit itself).
            // Subsequent entries flagged with {deposit: amount} add to the running total.
            // P&L = value - cumulativeDeposits  (starts at $0, shows pure trading gains/losses)

            const initialBal = portfolio.initialBalance || 0;
            const totalDeps = portfolio.totalDeposits || initialBal;

            // Build deposit timeline from flagged entries
            const depositTimeline = []; // [{index, amount}]
            portfolio.performanceHistory.forEach((h, i) => {
                if (h.deposit) {
                    depositTimeline.push({ index: i, amount: h.deposit, flagged: true });
                }
            });

            // Check if flagged deposits account for all known deposits
            const flaggedTotal = depositTimeline.reduce((s, d) => s + d.amount, 0);
            const unaccounted = totalDeps - initialBal - flaggedTotal;

            // If deposits are missing flags (added before tracking), detect them as value jumps
            if (unaccounted > 50) {
                console.log(`📊 ${unaccounted.toFixed(0)} in deposits missing flags — scanning for value jumps`);
                let remaining = unaccounted;
                for (let i = 1; i < rawValues.length && remaining > 50; i++) {
                    // Skip points that already have a flagged deposit
                    if (depositTimeline.find(d => d.index === i)) continue;
                    const prev = rawValues[i - 1];
                    const curr = rawValues[i];
                    if (prev && curr && prev > 0) {
                        const jump = curr - prev;
                        // A deposit looks like a sudden jump > $50 and > 5% of previous value
                        if (jump > 50 && (jump / prev) > 0.05) {
                            const amount = Math.min(jump, remaining);
                            depositTimeline.push({ index: i, amount, detected: true });
                            remaining -= amount;
                            console.log(`📊 Detected unflagged deposit at point ${i}: +$${amount.toFixed(2)}`);
                            // Backfill the flag so future renders don't need detection
                            portfolio.performanceHistory[i].deposit = amount;
                        }
                    }
                }
                if (remaining > 50) {
                    console.log(`📊 Still $${remaining.toFixed(0)} unaccounted — may be spread across small increments`);
                }
                // Sort by index after adding detected deposits
                depositTimeline.sort((a, b) => a.index - b.index);
            }

            // Build cumulative deposits at each point
            // Start with initialBalance (the first deposit), then add flagged deposits
            let cumDeposits = initialBal;
            const adjustedValues = rawValues.map((val, i) => {
                const depositAtPoint = depositTimeline.find(d => d.index === i);
                if (depositAtPoint) {
                    cumDeposits += depositAtPoint.amount;
                }
                return val - cumDeposits;
            });

            console.log(`📊 Chart: raw last=$${rawValues[rawValues.length-1]?.toFixed(2)}, P&L last=$${adjustedValues[adjustedValues.length-1]?.toFixed(2)}, deposits found=${depositTimeline.length}, totalDeposits=$${cumDeposits}`);
            
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
        async function addWeeklyFunding() {
            const funding = parseFloat(document.getElementById('weeklyFunding').value);

            // Calculate current portfolio value BEFORE adding the deposit
            let currentValue;
            try {
                const result = await calculatePortfolioValue();
                currentValue = result.total;
            } catch (e) {
                // Fallback: sum cash + estimate holdings from last known data
                const lastKnown = portfolio.performanceHistory.filter(e => e.value != null).slice(-1)[0];
                currentValue = lastKnown ? lastKnown.value : portfolio.cash;
                console.warn('Could not calculate live portfolio value for deposit, using fallback:', e.message);
            }

            portfolio.cash += funding;
            portfolio.totalDeposits += funding; // Track this deposit

            // Record the deposit with accurate pre-deposit value + funding amount
            portfolio.performanceHistory.push({
                timestamp: new Date().toISOString(),
                value: currentValue + funding,
                deposit: funding
            });

            addActivity('Weekly funding added: $' + funding.toLocaleString(), 'funding');
            await updateUI();
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

        // Get live stock price with caching
        // ENHANCED MARKET ANALYSIS - Real multi-day momentum and strength metrics
        
        // Cache for 5-day price history (fetched once per analysis run)
        let multiDayCache = {};
        const MULTIDAY_CACHE_TTL = 15 * 60 * 1000; // 15 minutes
        
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
            // Restore from localStorage cache if fresh enough
            try {
                const cached = localStorage.getItem('multiDayCache');
                const ts = parseInt(localStorage.getItem('multiDayCacheTs') || '0');
                if (cached && Date.now() - ts < MULTIDAY_CACHE_TTL) {
                    multiDayCache = JSON.parse(cached);
                    const hitCount = symbols.filter(s => multiDayCache[s]).length;
                    console.log(`📦 Restored ${hitCount}/${symbols.length} stocks from 5-day cache (${Math.round((Date.now() - ts) / 60000)}min old)`);
                    // Only fetch symbols not in cache
                    symbols = symbols.filter(s => !multiDayCache[s]);
                    if (symbols.length === 0) return;
                } else {
                    multiDayCache = {};
                }
            } catch { multiDayCache = {}; }

            const BATCH = 50, DELAY = 300;
            for (let i = 0; i < symbols.length; i += BATCH) {
                const batch = symbols.slice(i, i + BATCH);
                await Promise.all(batch.map(s => fetch5DayHistory(s)));
                if (i + BATCH < symbols.length) await new Promise(r => setTimeout(r, DELAY));
            }
            console.log(`✅ Fetched 5-day history for ${Object.keys(multiDayCache).length} stocks (${symbols.length} new)`);

            // Persist to localStorage
            try {
                localStorage.setItem('multiDayCache', JSON.stringify(multiDayCache));
                localStorage.setItem('multiDayCacheTs', String(Date.now()));
            } catch (e) { console.warn('Could not persist 5-day cache:', e.message); }
        }
        
        // Store raw bulk snapshot data (with day OHLCV) for synthetic today bar in grouped daily
        let bulkSnapshotRaw = {};

        // === GROUPED DAILY BARS: Fetch OHLCV for all stocks via per-date grouped endpoint ===
        // Replaces per-ticker fetching with ~40 date-based API calls (one per trading day)
        async function fetchGroupedDailyBars(symbolSet) {
            // Restore from localStorage cache if fresh enough
            try {
                const cached = localStorage.getItem('multiDayCache');
                const ts = parseInt(localStorage.getItem('multiDayCacheTs') || '0');
                if (cached && Date.now() - ts < MULTIDAY_CACHE_TTL) {
                    multiDayCache = JSON.parse(cached);
                    const hitCount = [...symbolSet].filter(s => multiDayCache[s]).length;
                    // Also verify bar depth — need 35+ for MACD. Old 5-day fallback data has ~20 bars.
                    const sampleSyms = [...symbolSet].filter(s => multiDayCache[s]).slice(0, 5);
                    const avgBars = sampleSyms.length > 0 ? sampleSyms.reduce((sum, s) => sum + (multiDayCache[s]?.length || 0), 0) / sampleSyms.length : 0;
                    console.log(`📦 Restored ${hitCount}/${symbolSet.size} stocks from grouped daily cache (${Math.round((Date.now() - ts) / 60000)}min old, avg ${Math.round(avgBars)} bars)`);
                    if (hitCount >= symbolSet.size * 0.8 && avgBars >= 35) return; // Good coverage AND depth
                }
            } catch { /* ignore cache errors */ }

            multiDayCache = {};

            // Compute 40 most recent weekdays (skip Sat/Sun)
            const tradingDates = [];
            const d = new Date();
            d.setHours(0, 0, 0, 0);
            while (tradingDates.length < 40) {
                d.setDate(d.getDate() - 1);
                const dow = d.getDay();
                if (dow !== 0 && dow !== 6) { // Skip Sunday (0) and Saturday (6)
                    const yyyy = d.getFullYear();
                    const mm = String(d.getMonth() + 1).padStart(2, '0');
                    const dd = String(d.getDate()).padStart(2, '0');
                    tradingDates.push(`${yyyy}-${mm}-${dd}`);
                }
            }
            tradingDates.reverse(); // Oldest first

            console.log(`📊 Fetching grouped daily bars for ${tradingDates.length} trading days...`);

            const BATCH = 5, DELAY = 100;
            let fetchedDates = 0, skippedDates = 0;

            for (let i = 0; i < tradingDates.length; i += BATCH) {
                const batch = tradingDates.slice(i, i + BATCH);
                const batchResults = await Promise.all(batch.map(async (dateStr) => {
                    try {
                        const response = await fetch(
                            `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${dateStr}?adjusted=true&apiKey=${POLYGON_API_KEY}`
                        );
                        if (!response.ok) return { dateStr, bars: [] };
                        const data = await response.json();
                        if (data.resultsCount === 0 || !data.results) {
                            return { dateStr, bars: [] }; // Holiday or no data
                        }
                        return { dateStr, bars: data.results };
                    } catch (err) {
                        console.warn(`Grouped daily fetch failed for ${dateStr}:`, err.message);
                        return { dateStr, bars: [] };
                    }
                }));

                for (const { dateStr, bars } of batchResults) {
                    if (bars.length === 0) { skippedDates++; continue; }
                    fetchedDates++;
                    for (const bar of bars) {
                        if (!symbolSet.has(bar.T)) continue; // Filter to our universe
                        if (!multiDayCache[bar.T]) multiDayCache[bar.T] = [];
                        multiDayCache[bar.T].push({ o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v, t: bar.t });
                    }
                }

                if (i + BATCH < tradingDates.length) await new Promise(r => setTimeout(r, DELAY));
            }

            // Sort each ticker's bars by timestamp ascending
            for (const sym of Object.keys(multiDayCache)) {
                multiDayCache[sym].sort((a, b) => a.t - b.t);
            }

            // Append synthetic bar for today from bulk snapshot's day data
            // (bulk snapshot is already fetched at this point)
            if (Object.keys(bulkSnapshotRaw).length > 0) {
                for (const sym of symbolSet) {
                    const raw = bulkSnapshotRaw[sym];
                    if (raw && raw.day && raw.day.o) {
                        if (!multiDayCache[sym]) multiDayCache[sym] = [];
                        const todayBar = { o: raw.day.o, h: raw.day.h, l: raw.day.l, c: raw.day.c, v: raw.day.v, t: Date.now() };
                        // Only append if last bar isn't already today
                        const lastBar = multiDayCache[sym][multiDayCache[sym].length - 1];
                        if (!lastBar || new Date(lastBar.t).toDateString() !== new Date().toDateString()) {
                            multiDayCache[sym].push(todayBar);
                        }
                    }
                }
            }

            const totalSymbols = Object.keys(multiDayCache).length;
            console.log(`✅ Grouped daily bars: ${totalSymbols} stocks, ${fetchedDates} dates fetched, ${skippedDates} holidays skipped`);

            // Persist to localStorage
            try {
                localStorage.setItem('multiDayCache', JSON.stringify(multiDayCache));
                localStorage.setItem('multiDayCacheTs', String(Date.now()));
            } catch (e) { console.warn('Could not persist grouped daily cache:', e.message); }
        }

        // === TECHNICAL INDICATORS (Client-Side from 40-bar data) ===

        // RSI (Relative Strength Index) using Wilder's smoothing
        function calculateRSI(bars, period = 14) {
            if (!bars || bars.length < period + 1) return null;
            let gainSum = 0, lossSum = 0;
            for (let i = 1; i <= period; i++) {
                const change = bars[i].c - bars[i - 1].c;
                if (change > 0) gainSum += change;
                else lossSum += Math.abs(change);
            }
            let avgGain = gainSum / period;
            let avgLoss = lossSum / period;
            for (let i = period + 1; i < bars.length; i++) {
                const change = bars[i].c - bars[i - 1].c;
                avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
                avgLoss = (avgLoss * (period - 1) + (change < 0 ? Math.abs(change) : 0)) / period;
            }
            if (avgLoss === 0) return 100;
            const rs = avgGain / avgLoss;
            return Math.round((100 - 100 / (1 + rs)) * 10) / 10;
        }

        // Simple Moving Average
        function calculateSMA(bars, period = 20) {
            if (!bars || bars.length < period) return null;
            const slice = bars.slice(-period);
            return Math.round(slice.reduce((sum, b) => sum + b.c, 0) / period * 100) / 100;
        }

        // Exponential Moving Average (returns array of EMA values for signal line calculation)
        function calculateEMAArray(closes, period) {
            if (closes.length < period) return [];
            const multiplier = 2 / (period + 1);
            const emaValues = [];
            // SMA seed
            let ema = closes.slice(0, period).reduce((s, c) => s + c, 0) / period;
            emaValues.push(ema);
            for (let i = period; i < closes.length; i++) {
                ema = (closes[i] - ema) * multiplier + ema;
                emaValues.push(ema);
            }
            return emaValues;
        }

        // MACD (12, 26, 9) — returns current values + crossover signal
        function calculateMACD(bars) {
            if (!bars || bars.length < 35) return null;
            const closes = bars.map(b => b.c);
            const ema12 = calculateEMAArray(closes, 12);
            const ema26 = calculateEMAArray(closes, 26);
            // Align: ema12 starts at index 12, ema26 starts at index 26
            // MACD line starts when both are available (index 26 onward)
            const offset = 26 - 12; // 14 — ema12 has 14 more values than ema26
            const macdLine = [];
            for (let i = 0; i < ema26.length; i++) {
                macdLine.push(ema12[i + offset] - ema26[i]);
            }
            // Signal line = EMA(9) of MACD line
            const signalLine = calculateEMAArray(macdLine, 9);
            if (signalLine.length < 2) return null;
            const signalOffset = macdLine.length - signalLine.length;
            const currentMACD = macdLine[macdLine.length - 1];
            const currentSignal = signalLine[signalLine.length - 1];
            const prevMACD = macdLine[macdLine.length - 2];
            const prevSignal = signalLine.length >= 2 ? signalLine[signalLine.length - 2] : currentSignal;
            const histogram = currentMACD - currentSignal;
            let crossover = 'none';
            if (prevMACD <= prevSignal && currentMACD > currentSignal) crossover = 'bullish';
            else if (prevMACD >= prevSignal && currentMACD < currentSignal) crossover = 'bearish';
            return {
                macd: Math.round(currentMACD * 1000) / 1000,
                signal: Math.round(currentSignal * 1000) / 1000,
                histogram: Math.round(histogram * 1000) / 1000,
                crossover
            };
        }

        // === TICKER DETAILS: Market Cap + SIC Description ===
        let tickerDetailsCache = {};
        const TICKER_DETAILS_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

        async function fetchTickerDetails(symbols) {
            // Restore from localStorage
            try {
                const cached = localStorage.getItem('tickerDetailsCache');
                const ts = parseInt(localStorage.getItem('tickerDetailsCacheTs') || '0');
                if (cached && Date.now() - ts < TICKER_DETAILS_TTL) {
                    tickerDetailsCache = JSON.parse(cached);
                }
            } catch { tickerDetailsCache = {}; }

            const uncached = symbols.filter(s => !tickerDetailsCache[s]);
            if (uncached.length === 0) {
                console.log(`📦 Ticker details: all ${symbols.length} from cache`);
                return;
            }

            console.log(`📋 Fetching ticker details for ${uncached.length} stocks...`);
            const BATCH = 20, DELAY = 100;
            let fetched = 0;
            for (let i = 0; i < uncached.length; i += BATCH) {
                const batch = uncached.slice(i, i + BATCH);
                await Promise.all(batch.map(async (symbol) => {
                    try {
                        const response = await fetch(
                            `https://api.polygon.io/v3/reference/tickers/${symbol}?apiKey=${POLYGON_API_KEY}`
                        );
                        if (!response.ok) return;
                        const data = await response.json();
                        if (data.results) {
                            tickerDetailsCache[symbol] = {
                                marketCap: data.results.market_cap || null,
                                sicDescription: data.results.sic_description || null,
                                name: data.results.name || null,
                                sharesOutstanding: data.results.share_class_shares_outstanding || null
                            };
                            fetched++;
                        }
                    } catch (err) {
                        console.warn(`Ticker details failed for ${symbol}:`, err.message);
                    }
                }));
                if (i + BATCH < uncached.length) await new Promise(r => setTimeout(r, DELAY));
            }

            console.log(`✅ Ticker details: ${fetched} new, ${symbols.length - uncached.length} cached`);
            try {
                localStorage.setItem('tickerDetailsCache', JSON.stringify(tickerDetailsCache));
                localStorage.setItem('tickerDetailsCacheTs', String(Date.now()));
            } catch (e) { console.warn('Could not persist ticker details cache:', e.message); }
        }

        // === SHORT INTEREST ===
        let shortInterestCache = {};
        const SHORT_INTEREST_TTL = 24 * 60 * 60 * 1000; // 24 hours

        async function fetchShortInterest(symbols) {
            // Restore from localStorage
            try {
                const cached = localStorage.getItem('shortInterestCache');
                const ts = parseInt(localStorage.getItem('shortInterestCacheTs') || '0');
                if (cached && Date.now() - ts < SHORT_INTEREST_TTL) {
                    shortInterestCache = JSON.parse(cached);
                    const hitCount = symbols.filter(s => shortInterestCache[s]).length;
                    if (hitCount > 0) {
                        console.log(`📦 Short interest: ${hitCount}/${symbols.length} from cache`);
                        if (hitCount >= symbols.length * 0.8) return;
                    }
                }
            } catch { shortInterestCache = {}; }

            console.log(`📉 Fetching short interest data...`);
            const uncached = symbols.filter(s => !shortInterestCache[s]);
            // Batch fetch using ticker.any_of parameter (up to 250 tickers per request)
            const BATCH = 250;
            for (let i = 0; i < uncached.length; i += BATCH) {
                const batch = uncached.slice(i, i + BATCH);
                try {
                    const tickerParam = batch.join(',');
                    const response = await fetch(
                        `https://api.polygon.io/stocks/v1/short-interest?ticker.any_of=${tickerParam}&order=desc&limit=1000&sort=settlement_date&apiKey=${POLYGON_API_KEY}`
                    );
                    if (!response.ok) {
                        console.warn(`Short interest fetch HTTP ${response.status}`);
                        continue;
                    }
                    const data = await response.json();
                    if (data.results) {
                        // Keep only the most recent entry per ticker
                        for (const entry of data.results) {
                            const sym = entry.ticker;
                            if (!shortInterestCache[sym]) {
                                shortInterestCache[sym] = {
                                    shortInterest: entry.short_volume || entry.current_short_position || 0,
                                    daysToCover: entry.days_to_cover || 0,
                                    avgDailyVolume: entry.avg_daily_volume || 0,
                                    settlementDate: entry.settlement_date || null
                                };
                            }
                        }
                    }
                } catch (err) {
                    console.warn('Short interest fetch error:', err.message);
                }
            }

            const totalCached = Object.keys(shortInterestCache).length;
            console.log(`✅ Short interest: ${totalCached} stocks total`);
            try {
                localStorage.setItem('shortInterestCache', JSON.stringify(shortInterestCache));
                localStorage.setItem('shortInterestCacheTs', String(Date.now()));
            } catch (e) { console.warn('Could not persist short interest cache:', e.message); }
        }

        // === NEWS + SENTIMENT ===
        let newsCache = {};
        const NEWS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

        let vixCache = null;
        const VIX_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours (EOD data)

        async function fetchNewsForStocks(symbols) {
            // Restore from localStorage
            try {
                const cached = localStorage.getItem('newsCache');
                const ts = parseInt(localStorage.getItem('newsCacheTs') || '0');
                if (cached && Date.now() - ts < NEWS_CACHE_TTL) {
                    newsCache = JSON.parse(cached);
                }
            } catch { newsCache = {}; }

            const uncached = symbols.filter(s => !newsCache[s]);
            if (uncached.length === 0) {
                console.log(`📦 News: all ${symbols.length} from cache`);
                return;
            }

            console.log(`📰 Fetching news for ${uncached.length} stocks...`);
            const BATCH = 10, DELAY = 100;
            let fetched = 0;
            for (let i = 0; i < uncached.length; i += BATCH) {
                const batch = uncached.slice(i, i + BATCH);
                await Promise.all(batch.map(async (symbol) => {
                    try {
                        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
                        const response = await fetch(
                            `https://api.polygon.io/v2/reference/news?ticker=${symbol}&limit=3&order=desc&sort=published_utc&published_utc.gte=${sevenDaysAgo}&apiKey=${POLYGON_API_KEY}`
                        );
                        if (!response.ok) return;
                        const data = await response.json();
                        if (data.results && data.results.length > 0) {
                            newsCache[symbol] = data.results.map(article => {
                                // Find sentiment for this specific ticker from insights array
                                const insight = (article.insights || []).find(ins => ins.ticker === symbol);
                                return {
                                    title: article.title,
                                    publishedUtc: article.published_utc,
                                    sentiment: insight?.sentiment || null,
                                    sentimentReasoning: insight?.sentiment_reasoning || null
                                };
                            });
                            fetched++;
                        } else {
                            newsCache[symbol] = []; // Mark as fetched (no news)
                        }
                    } catch (err) {
                        console.warn(`News fetch failed for ${symbol}:`, err.message);
                    }
                }));
                if (i + BATCH < uncached.length) await new Promise(r => setTimeout(r, DELAY));
            }

            console.log(`✅ News: ${fetched} new, ${symbols.length - uncached.length} cached`);
            try {
                localStorage.setItem('newsCache', JSON.stringify(newsCache));
                localStorage.setItem('newsCacheTs', String(Date.now()));
            } catch (e) { console.warn('Could not persist news cache:', e.message); }
        }

        // === VIX INDEX DATA ===
        async function fetchVIX() {
            // Check memory cache first
            if (vixCache && Date.now() - vixCache._fetchedAt < VIX_CACHE_TTL) {
                console.log('📦 VIX: from memory cache');
                return vixCache;
            }

            // Check localStorage cache
            try {
                const cached = localStorage.getItem('vixCache');
                const ts = parseInt(localStorage.getItem('vixCacheTs') || '0');
                if (cached && Date.now() - ts < VIX_CACHE_TTL) {
                    vixCache = JSON.parse(cached);
                    vixCache._fetchedAt = ts;
                    console.log(`📦 VIX: ${vixCache.level} from localStorage cache`);
                    return vixCache;
                }
            } catch { /* ignore corrupt cache */ }

            try {
                console.log('📊 Fetching VIX snapshot...');

                // Use snapshot endpoint (covered by Indices Basic plan)
                // Try api.polygon.io first (known CORS-friendly), fall back to api.massive.com with Bearer auth
                let data = null;
                const endpoints = [
                    { url: `https://api.polygon.io/v3/snapshot/indices?ticker.any_of=I:VIX&apiKey=${POLYGON_API_KEY}`, label: 'polygon' },
                    { url: `https://api.massive.com/v3/snapshot/indices?ticker.any_of=I:VIX`, label: 'massive', headers: { 'Authorization': `Bearer ${POLYGON_API_KEY}` } }
                ];

                for (const ep of endpoints) {
                    try {
                        const response = await fetch(ep.url, ep.headers ? { headers: ep.headers } : undefined);
                        if (!response.ok) {
                            console.warn(`VIX fetch (${ep.label}): HTTP ${response.status}`);
                            continue;
                        }
                        data = await response.json();
                        if (data.results && data.results.length > 0) {
                            console.log(`✅ VIX fetched via ${ep.label}`);
                            break;
                        }
                        data = null;
                    } catch (e) {
                        console.warn(`VIX fetch (${ep.label}) error:`, e.message);
                    }
                }

                if (!data || !data.results || data.results.length === 0) {
                    console.warn('VIX fetch: no results from any endpoint');
                    return null;
                }

                const snap = data.results[0];
                const level = snap.value;
                const session = snap.session || {};
                const prevClose = session.previous_close || level;
                const change = session.change || (level - prevClose);
                const changePercent = session.change_percent || (prevClose !== 0 ? ((level - prevClose) / prevClose) * 100 : 0);

                // Trend from today's change direction
                const trend = changePercent > 5 ? 'rising' : changePercent < -5 ? 'falling' : 'stable';

                // Interpretation
                let interpretation;
                if (level < 15) interpretation = 'complacent';
                else if (level <= 20) interpretation = 'normal';
                else if (level <= 30) interpretation = 'elevated';
                else interpretation = 'panic';

                vixCache = {
                    level,
                    prevClose,
                    change,
                    changePercent,
                    trend,
                    interpretation,
                    _fetchedAt: Date.now()
                };

                // Persist to localStorage
                try {
                    localStorage.setItem('vixCache', JSON.stringify(vixCache));
                    localStorage.setItem('vixCacheTs', String(Date.now()));
                } catch (e) { console.warn('Could not persist VIX cache:', e.message); }

                console.log(`✅ VIX: ${level.toFixed(1)} (${interpretation}, ${trend}), change: ${change >= 0 ? '+' : ''}${change.toFixed(2)} (${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(1)}%)`);
                return vixCache;
            } catch (err) {
                console.warn('VIX fetch error:', err.message);
                return null;
            }
        }

        // Calculate REAL 5-day momentum score (uses last 5 bars from 20-day cache)
        function calculate5DayMomentum(priceData, symbol) {
            const allBars = multiDayCache[symbol];
            if (!allBars || allBars.length < 2) {
                if (!priceData || !priceData.price) return { score: 0, trend: 'unknown', basis: 'no-data' };
                const cp = priceData.changePercent || 0;
                // Cap at 7 — without multi-day context a single-day spike shouldn't dominate rankings
                let score = 5;
                if (cp > 5) score = 7; else if (cp > 2) score = 6.5; else if (cp > 0) score = 6;
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
        let bulkSnapshotCache = {};
        let bulkSnapshotTimestamp = 0;
        
        async function fetchBulkSnapshot(symbols) {
            const now = Date.now();
            // Only refetch if cache is >15 seconds old (real-time data)
            if (now - bulkSnapshotTimestamp < 15000 && Object.keys(bulkSnapshotCache).length > 0) {
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

                        // When market is closed, prefer regular session close (day.c)
                        // over lastTrade which reflects extended-hours trading
                        const marketOpen = isMarketOpen();
                        let currentPrice;
                        if (marketOpen) {
                            currentPrice = (ticker.lastTrade && ticker.lastTrade.p) || day.c || day.l;
                        } else {
                            currentPrice = day.c || (ticker.lastTrade && ticker.lastTrade.p) || day.l;
                        }
                        const prevClose = prevDay.c;
                        if (!currentPrice || currentPrice === 0) currentPrice = prevClose;
                        if (!currentPrice || !prevClose) return;

                        // Use pre-computed change fields when available (only reliable during market hours)
                        let change, changePercent;
                        if (marketOpen && ticker.todaysChange != null) {
                            change = ticker.todaysChange;
                            changePercent = ticker.todaysChangePerc;
                        } else {
                            change = currentPrice - prevClose;
                            changePercent = (currentPrice - prevClose) / prevClose * 100;
                        }

                        result[symbol] = {
                            price: parseFloat(currentPrice),
                            change: parseFloat(change),
                            changePercent: parseFloat(changePercent),
                            timestamp: new Date().toISOString(),
                            isReal: true,
                            note: marketOpen ? 'Real-time' : 'Market closed'
                        };
                        
                        // Also update the regular price cache
                        priceCache[symbol] = result[symbol];
                    });
                    
                    bulkSnapshotCache = result;
                    bulkSnapshotTimestamp = now;
                    apiCallsToday++;
                    saveApiUsage();
                    updateApiUsageDisplay();

                    // Store raw ticker data for synthetic today bar in grouped daily bars
                    data.tickers.forEach(ticker => {
                        bulkSnapshotRaw[ticker.ticker] = ticker;
                    });

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
                    
                    // When market is closed, prefer regular session close (day.c)
                    // over lastTrade which reflects extended-hours trading
                    const marketOpen = isMarketOpen();
                    let currentPrice;
                    if (marketOpen) {
                        currentPrice = (ticker.lastTrade && ticker.lastTrade.p) || day.c || day.l;
                    } else {
                        currentPrice = day.c || (ticker.lastTrade && ticker.lastTrade.p) || day.l;
                    }
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

                    // Use pre-computed change fields when available (only reliable during market hours)
                    let change, changePercent;
                    if (marketOpen && ticker.todaysChange != null) {
                        change = ticker.todaysChange;
                        changePercent = ticker.todaysChangePerc;
                    } else {
                        change = currentPrice - prevClose;
                        changePercent = (currentPrice - prevClose) / prevClose * 100;
                    }

                    const priceData = {
                        price: parseFloat(currentPrice),
                        change: parseFloat(change),
                        changePercent: parseFloat(changePercent),
                        timestamp: new Date().toISOString(),
                        isReal: true,
                        note: marketOpen ? 'Real-time' : 'Market closed'
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
                const sector = trade.sector || stockSectors[trade.symbol] || 'Unknown';
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

            // Analyze runner entries (intraday change at purchase)
            const withTodayChg = tradesWithTechnicals.filter(t => t.entryTechnicals.todayChange != null);
            const runners = withTodayChg.filter(t => t.entryTechnicals.todayChange >= 5);
            const bigRunners = withTodayChg.filter(t => t.entryTechnicals.todayChange >= 10);
            const nonRunners = withTodayChg.filter(t => t.entryTechnicals.todayChange < 5);

            // Analyze market structure at entry
            const withStructure = tradesWithTechnicals.filter(t => t.entryTechnicals.structure != null);
            const bullishStructure = withStructure.filter(t => t.entryTechnicals.structure === 'bullish');
            const bearishStructure = withStructure.filter(t => t.entryTechnicals.structure === 'bearish');
            const otherStructure = withStructure.filter(t => t.entryTechnicals.structure !== 'bullish' && t.entryTechnicals.structure !== 'bearish');

            // Analyze CHoCH vs BOS entries
            const withChoch = withStructure.filter(t => t.entryTechnicals.choch);
            const withBos = withStructure.filter(t => t.entryTechnicals.bos);

            // Analyze acceleration
            const withAccel = tradesWithTechnicals.filter(t => t.entryTechnicals.isAccelerating != null);
            const accelerating = withAccel.filter(t => t.entryTechnicals.isAccelerating);
            const decelerating = withAccel.filter(t => !t.entryTechnicals.isAccelerating);

            // Analyze market regime at entry
            const withRegime = closedTrades.filter(t => t.entryMarketRegime);
            const bullRegime = withRegime.filter(t => t.entryMarketRegime === 'bull');
            const bearRegime = withRegime.filter(t => t.entryMarketRegime === 'bear');
            const choppyRegime = withRegime.filter(t => t.entryMarketRegime === 'choppy');

            // Analyze portfolio concentration at entry
            const withHoldings = closedTrades.filter(t => t.entryHoldingsCount != null);
            const concentrated = withHoldings.filter(t => t.entryHoldingsCount <= 3);
            const diversified = withHoldings.filter(t => t.entryHoldingsCount > 3);

            // Analyze position sizing
            const withSizing = closedTrades.filter(t => t.positionSizePercent != null && t.positionSizePercent > 0);
            const bigPositions = withSizing.filter(t => t.positionSizePercent >= 15);
            const smallPositions = withSizing.filter(t => t.positionSizePercent < 15);

            // Analyze RSI at entry
            const withRSI = tradesWithTechnicals.filter(t => t.entryTechnicals.rsi != null);
            const rsiOversold = withRSI.filter(t => t.entryTechnicals.rsi < 30);
            const rsiNeutral = withRSI.filter(t => t.entryTechnicals.rsi >= 30 && t.entryTechnicals.rsi <= 70);
            const rsiOverbought = withRSI.filter(t => t.entryTechnicals.rsi > 70);

            // Analyze MACD crossover at entry
            const withMACD = tradesWithTechnicals.filter(t => t.entryTechnicals.macdCrossover != null);
            const macdBullish = withMACD.filter(t => t.entryTechnicals.macdCrossover === 'bullish');
            const macdBearish = withMACD.filter(t => t.entryTechnicals.macdCrossover === 'bearish');
            const macdNone = withMACD.filter(t => t.entryTechnicals.macdCrossover === 'none');

            // Analyze short squeeze potential at entry
            const withDTC = tradesWithTechnicals.filter(t => t.entryTechnicals.daysToCover != null);
            const highSqueeze = withDTC.filter(t => t.entryTechnicals.daysToCover > 5);
            const moderateSqueeze = withDTC.filter(t => t.entryTechnicals.daysToCover >= 3 && t.entryTechnicals.daysToCover <= 5);
            const lowSqueeze = withDTC.filter(t => t.entryTechnicals.daysToCover < 3);

            // Analyze composite score calibration
            const withScore = tradesWithTechnicals.filter(t => t.entryTechnicals.compositeScore != null);
            const scoreHigh = withScore.filter(t => t.entryTechnicals.compositeScore >= 15);
            const scoreMedium = withScore.filter(t => t.entryTechnicals.compositeScore >= 10 && t.entryTechnicals.compositeScore < 15);
            const scoreLow = withScore.filter(t => t.entryTechnicals.compositeScore < 10);

            // Analyze VIX level at entry
            const withVIX = tradesWithTechnicals.filter(t => t.entryTechnicals.vixLevel != null);
            const vixComplacent = withVIX.filter(t => t.entryTechnicals.vixLevel < 15);
            const vixNormal = withVIX.filter(t => t.entryTechnicals.vixLevel >= 15 && t.entryTechnicals.vixLevel <= 20);
            const vixElevated = withVIX.filter(t => t.entryTechnicals.vixLevel > 20 && t.entryTechnicals.vixLevel <= 30);
            const vixPanic = withVIX.filter(t => t.entryTechnicals.vixLevel > 30);

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
                },
                runners: {
                    hasData: withTodayChg.length >= 3,
                    runners: calcStats(runners),
                    bigRunners: calcStats(bigRunners),
                    nonRunners: calcStats(nonRunners)
                },
                structure: {
                    hasData: withStructure.length >= 3,
                    bullish: calcStats(bullishStructure),
                    bearish: calcStats(bearishStructure),
                    other: calcStats(otherStructure),
                    choch: calcStats(withChoch),
                    bos: calcStats(withBos)
                },
                acceleration: {
                    hasData: withAccel.length >= 3,
                    accelerating: calcStats(accelerating),
                    decelerating: calcStats(decelerating)
                },
                regime: {
                    hasData: withRegime.length >= 3,
                    bull: calcStats(bullRegime),
                    bear: calcStats(bearRegime),
                    choppy: calcStats(choppyRegime)
                },
                concentration: {
                    hasData: withHoldings.length >= 3,
                    concentrated: calcStats(concentrated),
                    diversified: calcStats(diversified)
                },
                sizing: {
                    hasData: withSizing.length >= 3,
                    big: calcStats(bigPositions),
                    small: calcStats(smallPositions)
                },
                rsi: {
                    hasData: withRSI.length >= 3,
                    oversold: calcStats(rsiOversold),
                    neutral: calcStats(rsiNeutral),
                    overbought: calcStats(rsiOverbought)
                },
                macd: {
                    hasData: withMACD.length >= 3,
                    bullish: calcStats(macdBullish),
                    bearish: calcStats(macdBearish),
                    none: calcStats(macdNone)
                },
                squeeze: {
                    hasData: withDTC.length >= 3,
                    high: calcStats(highSqueeze),
                    moderate: calcStats(moderateSqueeze),
                    low: calcStats(lowSqueeze)
                },
                compositeScore: {
                    hasData: withScore.length >= 3,
                    high: calcStats(scoreHigh),
                    medium: calcStats(scoreMedium),
                    low: calcStats(scoreLow)
                },
                vix: {
                    hasData: withVIX.length >= 3,
                    complacent: calcStats(vixComplacent),
                    normal: calcStats(vixNormal),
                    elevated: calcStats(vixElevated),
                    panic: calcStats(vixPanic)
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

            // Hold time bucketing — find optimal hold periods
            const holdBuckets = {};
            closedTrades.forEach(t => {
                if (!t.holdTime) return;
                const days = Math.floor(t.holdTime / 86400000);
                const bucket = days <= 1 ? '0-1d' : days <= 3 ? '2-3d' : days <= 7 ? '4-7d' : days <= 14 ? '1-2w' : '2w+';
                if (!holdBuckets[bucket]) holdBuckets[bucket] = { wins: 0, losses: 0, totalReturn: 0, count: 0 };
                const b = holdBuckets[bucket];
                b.count++;
                b.totalReturn += t.returnPercent;
                if (t.profitLoss > 0) b.wins++; else b.losses++;
            });
            Object.values(holdBuckets).forEach(b => {
                b.winRate = b.count > 0 ? (b.wins / b.count) * 100 : 0;
                b.avgReturn = b.count > 0 ? b.totalReturn / b.count : 0;
            });

            return {
                hasData: true,
                byReason: analysis,
                avgWinnerReturn: avgWinnerReturn,
                profitTargetCount: byReason.profit_target.length,
                holdBuckets: holdBuckets,
                insight: avgWinnerReturn < 15 && byReason.profit_target.length > 2
                    ? "Consider holding winners longer - average win is only " + avgWinnerReturn.toFixed(1) + "%"
                    : null
            };
        }

        // Derive actionable trading rules from closed trade history
        // Returns { rules: [...], summary: {...} } with enforcement levels: block, warn, observe
        function deriveTradingRules() {
            const closedTrades = portfolio.closedTrades || [];
            const tradesWithTechnicals = closedTrades.filter(t => t.entryTechnicals && Object.keys(t.entryTechnicals).length > 0);

            if (closedTrades.length < 3) {
                return { rules: [], summary: { totalTrades: closedTrades.length, insufficientData: true } };
            }

            const totalWins = closedTrades.filter(t => t.profitLoss > 0).length;
            const totalLosses = closedTrades.length - totalWins;
            const overallWinRate = (totalWins / closedTrades.length) * 100;
            const winners = closedTrades.filter(t => t.profitLoss > 0);
            const losers = closedTrades.filter(t => t.profitLoss <= 0);
            const avgWin = winners.length > 0 ? winners.reduce((s, t) => s + t.returnPercent, 0) / winners.length : 0;
            const avgLoss = losers.length > 0 ? losers.reduce((s, t) => s + t.returnPercent, 0) / losers.length : 0;
            const avgWinDays = winners.length > 0 ? winners.reduce((s, t) => s + (t.holdTime || 0), 0) / winners.length / 86400000 : 0;
            const avgLossDays = losers.length > 0 ? losers.reduce((s, t) => s + (t.holdTime || 0), 0) / losers.length / 86400000 : 0;

            // Recent trend (last 10 trades)
            const recentN = Math.min(10, closedTrades.length);
            const recentTrades = closedTrades.slice(-recentN);
            const recentWins = recentTrades.filter(t => t.profitLoss > 0).length;
            const recentLosses = recentN - recentWins;

            const calcGroupStats = (trades) => {
                if (!trades || trades.length === 0) return null;
                const wins = trades.filter(t => t.profitLoss > 0).length;
                return {
                    count: trades.length,
                    winRate: (wins / trades.length) * 100,
                    avgReturn: trades.reduce((s, t) => s + t.returnPercent, 0) / trades.length
                };
            };

            // Define pattern dimensions to evaluate
            const patternDefs = [
                {
                    id: 'runner_entry',
                    label: 'Runner Entries (up 5%+ today)',
                    losingFilter: t => t.entryTechnicals && t.entryTechnicals.todayChange != null && t.entryTechnicals.todayChange >= 5,
                    winningFilter: t => t.entryTechnicals && t.entryTechnicals.todayChange != null && t.entryTechnicals.todayChange < 5,
                    descTemplate: (ls, ws) => `Stocks up 5%+ on the day of purchase: ${ls.winRate.toFixed(0)}% win rate vs ${ws.winRate.toFixed(0)}% for non-runners`
                },
                {
                    id: 'overbought_rsi',
                    label: 'Overbought RSI (>70)',
                    losingFilter: t => t.entryTechnicals && t.entryTechnicals.rsi != null && t.entryTechnicals.rsi > 70,
                    winningFilter: t => t.entryTechnicals && t.entryTechnicals.rsi != null && t.entryTechnicals.rsi <= 70,
                    descTemplate: (ls, ws) => `RSI > 70 at entry: ${ls.winRate.toFixed(0)}% win rate vs ${ws.winRate.toFixed(0)}% for non-overbought`
                },
                {
                    id: 'bearish_structure',
                    label: 'Bearish Structure Entries',
                    losingFilter: t => t.entryTechnicals && t.entryTechnicals.structure === 'bearish',
                    winningFilter: t => t.entryTechnicals && t.entryTechnicals.structure === 'bullish',
                    descTemplate: (ls, ws) => `Bearish structure at entry: ${ls.winRate.toFixed(0)}% win rate vs ${ws.winRate.toFixed(0)}% for bullish`
                },
                {
                    id: 'bearish_macd',
                    label: 'Bearish MACD Crossover',
                    losingFilter: t => t.entryTechnicals && t.entryTechnicals.macdCrossover === 'bearish',
                    winningFilter: t => t.entryTechnicals && t.entryTechnicals.macdCrossover === 'bullish',
                    descTemplate: (ls, ws) => `Bearish MACD at entry: ${ls.winRate.toFixed(0)}% win rate vs ${ws.winRate.toFixed(0)}% for bullish crossover`
                },
                {
                    id: 'outflow_sector',
                    label: 'Outflow Sector Entries',
                    losingFilter: t => t.entryTechnicals && (t.entryTechnicals.sectorRotation === 'avoid' || t.entryTechnicals.sectorRotation === 'caution'),
                    winningFilter: t => t.entryTechnicals && (t.entryTechnicals.sectorRotation === 'accumulate' || t.entryTechnicals.sectorRotation === 'favorable'),
                    descTemplate: (ls, ws) => `Outflow sector entries: ${ls.winRate.toFixed(0)}% win rate vs ${ws.winRate.toFixed(0)}% for inflow sectors`
                },
                {
                    id: 'high_momentum',
                    label: 'Extended Momentum (9+)',
                    losingFilter: t => t.entryTechnicals && t.entryTechnicals.momentumScore != null && t.entryTechnicals.momentumScore >= 9,
                    winningFilter: t => t.entryTechnicals && t.entryTechnicals.momentumScore != null && t.entryTechnicals.momentumScore < 7,
                    descTemplate: (ls, ws) => `Momentum 9+ at entry: ${ls.winRate.toFixed(0)}% win rate vs ${ws.winRate.toFixed(0)}% for momentum <7`
                },
                {
                    id: 'large_position',
                    label: 'Large Positions (15%+)',
                    losingFilter: t => t.positionSizePercent != null && t.positionSizePercent >= 15,
                    winningFilter: t => t.positionSizePercent != null && t.positionSizePercent > 0 && t.positionSizePercent < 15,
                    descTemplate: (ls, ws) => `Large positions (15%+): ${ls.winRate.toFixed(0)}% win rate vs ${ws.winRate.toFixed(0)}% for smaller positions`
                },
                {
                    id: 'low_composite',
                    label: 'Low Composite Score (<10)',
                    losingFilter: t => t.entryTechnicals && t.entryTechnicals.compositeScore != null && t.entryTechnicals.compositeScore < 10,
                    winningFilter: t => t.entryTechnicals && t.entryTechnicals.compositeScore != null && t.entryTechnicals.compositeScore >= 15,
                    descTemplate: (ls, ws) => `Low composite score (<10): ${ls.winRate.toFixed(0)}% win rate vs ${ws.winRate.toFixed(0)}% for high scores (15+)`
                },
                {
                    id: 'overconfident_conviction',
                    label: 'Max Conviction (9-10)',
                    losingFilter: t => t.entryConviction != null && t.entryConviction >= 9,
                    winningFilter: t => t.entryConviction != null && t.entryConviction >= 5 && t.entryConviction <= 6,
                    descTemplate: (ls, ws) => `9-10 conviction trades: ${ls.winRate.toFixed(0)}% win rate vs ${ws.winRate.toFixed(0)}% for moderate (5-6) conviction`
                }
            ];

            const rules = [];
            for (const pdef of patternDefs) {
                const losingTrades = closedTrades.filter(pdef.losingFilter);
                const winningTrades = closedTrades.filter(pdef.winningFilter);
                const losingStats = calcGroupStats(losingTrades);
                const winningStats = calcGroupStats(winningTrades);

                // Show all patterns — even ones without enough data yet
                if (!losingStats && !winningStats) {
                    rules.push({
                        id: pdef.id, label: pdef.label, type: 'neutral', enforcement: 'observe',
                        winRate: 0, avgReturn: 0, trades: 0,
                        compareWinRate: 0, compareTrades: 0, compareAvgReturn: 0,
                        needsData: true,
                        description: `No data yet — need trades with ${pdef.label.toLowerCase()} conditions`
                    });
                    continue;
                }

                if (!losingStats || !winningStats) {
                    // One side has data, show what we have
                    const hasStats = losingStats || winningStats;
                    const side = losingStats ? 'losing' : 'winning';
                    rules.push({
                        id: pdef.id, label: pdef.label, type: 'neutral', enforcement: 'observe',
                        winRate: hasStats.winRate, avgReturn: hasStats.avgReturn, trades: hasStats.count,
                        compareWinRate: 0, compareTrades: 0, compareAvgReturn: 0,
                        needsData: true,
                        description: `Only ${hasStats.count} trades on ${side} side — need both sides to compare`
                    });
                    continue;
                }

                const winRateDiff = winningStats.winRate - losingStats.winRate;
                const losingCount = losingStats.count;

                // Determine enforcement level
                let enforcement = 'observe';
                let type = 'neutral';
                if (losingCount >= 10 && losingStats.winRate < 40 && winRateDiff > 15) {
                    enforcement = 'block';
                    type = 'avoid';
                } else if (losingCount >= 8 && winRateDiff > 15) {
                    enforcement = 'warn';
                    type = 'avoid';
                } else if (losingCount >= 5 && winRateDiff > 10) {
                    enforcement = 'warn';
                    type = 'avoid';
                }

                rules.push({
                    id: pdef.id,
                    label: pdef.label,
                    type,
                    enforcement,
                    winRate: losingStats.winRate,
                    avgReturn: losingStats.avgReturn,
                    trades: losingStats.count,
                    compareWinRate: winningStats.winRate,
                    compareTrades: winningStats.count,
                    compareAvgReturn: winningStats.avgReturn,
                    description: pdef.descTemplate(losingStats, winningStats)
                });
            }

            // Also derive "prefer" rules — patterns that work well
            const preferDefs = [
                {
                    id: 'pullback_entry',
                    label: 'Pullback Entries (-2% to -8% 5d)',
                    filter: t => t.entryTechnicals && t.entryTechnicals.momentumScore != null && t.entryTechnicals.momentumScore >= -8 && t.entryTechnicals.momentumScore <= -2,
                    altFilter: t => t.entryTechnicals && t.entryTechnicals.todayChange != null && t.entryTechnicals.todayChange < 0 && t.entryTechnicals.structure === 'bullish'
                },
                {
                    id: 'bullish_structure_entry',
                    label: 'Bullish Structure Entries',
                    filter: t => t.entryTechnicals && t.entryTechnicals.structure === 'bullish'
                },
                {
                    id: 'oversold_rsi',
                    label: 'Oversold RSI (<30)',
                    filter: t => t.entryTechnicals && t.entryTechnicals.rsi != null && t.entryTechnicals.rsi < 30
                },
                {
                    id: 'bullish_macd_entry',
                    label: 'Bullish MACD Crossover',
                    filter: t => t.entryTechnicals && t.entryTechnicals.macdCrossover === 'bullish'
                },
                {
                    id: 'inflow_sector_entry',
                    label: 'Inflow Sector Entries',
                    filter: t => t.entryTechnicals && (t.entryTechnicals.sectorRotation === 'accumulate' || t.entryTechnicals.sectorRotation === 'favorable')
                }
            ];

            for (const pdef of preferDefs) {
                // Skip if already covered by an avoid rule's winning side
                if (rules.find(r => r.id === pdef.id)) continue;

                const matchingTrades = closedTrades.filter(pdef.filter || (() => false));
                const stats = calcGroupStats(matchingTrades);
                if (!stats || stats.count < 5) continue;

                // Only mark as "prefer" if win rate is notably above overall
                if (stats.winRate > overallWinRate + 5) {
                    rules.push({
                        id: pdef.id,
                        label: pdef.label,
                        type: 'prefer',
                        enforcement: 'observe',
                        winRate: stats.winRate,
                        avgReturn: stats.avgReturn,
                        trades: stats.count,
                        compareWinRate: overallWinRate,
                        compareTrades: closedTrades.length,
                        compareAvgReturn: closedTrades.reduce((s, t) => s + t.returnPercent, 0) / closedTrades.length,
                        description: `${pdef.label}: ${stats.winRate.toFixed(0)}% win rate (${stats.count} trades) vs ${overallWinRate.toFixed(0)}% overall`
                    });
                }
            }

            // Sort: block first, then warn, then prefer, then observe
            const enfOrder = { block: 0, warn: 1, observe: 2 };
            const typeOrder = { avoid: 0, prefer: 1, neutral: 2 };
            rules.sort((a, b) => {
                const eDiff = (enfOrder[a.enforcement] ?? 3) - (enfOrder[b.enforcement] ?? 3);
                if (eDiff !== 0) return eDiff;
                return (typeOrder[a.type] ?? 3) - (typeOrder[b.type] ?? 3);
            });

            const result = {
                rules,
                summary: {
                    totalTrades: closedTrades.length,
                    wins: totalWins,
                    losses: totalLosses,
                    winRate: overallWinRate,
                    avgWin,
                    avgLoss,
                    avgWinDays,
                    avgLossDays,
                    recentWins,
                    recentLosses,
                    recentTrend: recentWins > recentLosses ? 'improving' : recentWins < recentLosses ? 'declining' : 'steady'
                }
            };

            // Persist to portfolio for cross-refresh availability
            portfolio.tradingRules = result;

            return result;
        }

        // Check if a trade's market data matches a specific rule pattern
        function matchesPattern(ruleId, data) {
            if (!data) return false;
            switch (ruleId) {
                case 'runner_entry':
                    return data.momentum?.todayChange >= 5 || data.todayChange >= 5;
                case 'overbought_rsi':
                    return data.rsi > 70;
                case 'bearish_structure':
                    return data.marketStructure?.structure === 'bearish';
                case 'bearish_macd':
                    return data.macdCrossover === 'bearish' || data.macd?.crossover === 'bearish';
                case 'outflow_sector':
                    return data.sectorRotation?.moneyFlow === 'outflow' || data.sectorFlow === 'avoid' || data.sectorFlow === 'caution';
                case 'high_momentum':
                    return data.momentum?.score >= 9;
                case 'low_composite':
                    return data.compositeScore != null && data.compositeScore < 10;
                case 'overconfident_conviction':
                    return false; // Can't block by conviction — Claude decides this
                case 'large_position':
                    return false; // Position sizing is handled separately
                default:
                    return false;
            }
        }

        // Format performance insights for Claude's prompt — concise rules, not statistics
        function formatPerformanceInsights() {
            const rulesData = deriveTradingRules();

            if (rulesData.rules.length === 0) {
                if (rulesData.summary.insufficientData) {
                    return `\nTRADING RULES: Need more trade history (${rulesData.summary.totalTrades} trades so far, need 3+).\n`;
                }
                return `\nTRADING RULES: No clear patterns yet from ${rulesData.summary.totalTrades} trades.\n`;
            }

            const s = rulesData.summary;
            const blockRules = rulesData.rules.filter(r => r.enforcement === 'block');
            const warnRules = rulesData.rules.filter(r => r.enforcement === 'warn' && r.type === 'avoid');
            const preferRules = rulesData.rules.filter(r => r.type === 'prefer');

            let insights = `\nTRADING RULES (derived from your ${s.totalTrades}-trade history):\n\n`;

            if (blockRules.length > 0) {
                insights += `ENFORCED (code-blocked — these trades will not execute):\n`;
                for (const r of blockRules) {
                    insights += `- ${r.label}: ${r.winRate.toFixed(0)}% win rate, ${r.avgReturn >= 0 ? '+' : ''}${r.avgReturn.toFixed(1)}% avg over ${r.trades} trades [BLOCKED]\n`;
                }
                insights += '\n';
            }

            if (warnRules.length > 0) {
                insights += `STRONG GUIDANCE (data says avoid):\n`;
                for (const r of warnRules) {
                    insights += `- ${r.label}: ${r.winRate.toFixed(0)}% win rate over ${r.trades} trades vs ${r.compareWinRate.toFixed(0)}% baseline — skip unless catalyst is extraordinary\n`;
                }
                insights += '\n';
            }

            if (preferRules.length > 0) {
                insights += `WHAT'S WORKING:\n`;
                for (const r of preferRules) {
                    insights += `- ${r.label}: ${r.winRate.toFixed(0)}% win rate, ${r.avgReturn >= 0 ? '+' : ''}${r.avgReturn.toFixed(1)}% avg over ${r.trades} trades\n`;
                }
                insights += '\n';
            }

            insights += `PERFORMANCE: ${s.wins}W-${s.losses}L (${s.winRate.toFixed(0)}%), Avg winner: +${s.avgWin.toFixed(1)}% (${s.avgWinDays.toFixed(1)}d), Avg loser: ${s.avgLoss.toFixed(1)}% (${s.avgLossDays.toFixed(1)}d)\n`;
            insights += `RECENT: ${s.recentWins}W-${s.recentLosses}L — ${s.recentTrend}\n\n`;

            // Hold accuracy insights
            const holdStats = analyzeHoldAccuracy();
            if (holdStats) {
                insights += `HOLD ACCURACY: ${holdStats.overall.accuracy.toFixed(0)}% correct (${holdStats.overall.total} holds), avg ${holdStats.overall.avgChange >= 0 ? '+' : ''}${holdStats.overall.avgChange.toFixed(1)}% next-cycle change.`;
                if (holdStats.byConviction.high) insights += ` High conviction: ${holdStats.byConviction.high.accuracy.toFixed(0)}%.`;
                if (holdStats.byConviction.low) insights += ` Low conviction: ${holdStats.byConviction.low.accuracy.toFixed(0)}%.`;
                insights += '\n';
            }

            // Regime context insights
            const regimeStats = analyzeRegimeTransitions();
            if (regimeStats) {
                insights += `REGIME CONTEXT: ${regimeStats.current.toUpperCase()} for ${regimeStats.durationDays}d (${regimeStats.transitionCount} transitions, avg every ${regimeStats.avgFrequencyDays}d).`;
                if (regimeStats.nearTransition && regimeStats.overallWinRate !== null) {
                    insights += ` Trades near regime changes: ${regimeStats.nearTransition.winRate.toFixed(0)}% win rate vs ${regimeStats.overallWinRate.toFixed(0)}% overall.`;
                }
                insights += '\n';
            }

            // Conviction calibration insights
            const convictionData = analyzeConvictionAccuracy();
            if (convictionData.hasData) {
                insights += `CONVICTION CALIBRATION:\n`;
                for (const [level, stats] of Object.entries(convictionData.analysis)) {
                    insights += `- Conviction ${level}: ${stats.winRate.toFixed(0)}% win rate, ${stats.avgReturn >= 0 ? '+' : ''}${stats.avgReturn.toFixed(1)}% avg return (${stats.count} trades) — ${stats.calibration}\n`;
                }
                insights += '\n';
            }

            // Technical signal accuracy insights
            const techData = analyzeTechnicalAccuracy();
            if (techData.hasData) {
                insights += `SIGNAL ACCURACY (which entry conditions predict wins):\n`;
                const formatSignal = (label, good, bad, goodLabel, badLabel) => {
                    if (!good && !bad) return '';
                    let line = `- ${label}: `;
                    if (good) line += `${goodLabel} ${good.winRate.toFixed(0)}% WR (${good.count})`;
                    if (good && bad) line += ` vs `;
                    if (bad) line += `${badLabel} ${bad.winRate.toFixed(0)}% WR (${bad.count})`;
                    return line + '\n';
                };
                insights += formatSignal('Momentum', techData.momentum.high, techData.momentum.low, 'High:', 'Low:');
                insights += formatSignal('RS', techData.relativeStrength.high, techData.relativeStrength.low, 'High:', 'Low:');
                insights += formatSignal('Sector flow', techData.sectorRotation.inflow, techData.sectorRotation.outflow, 'Inflow:', 'Outflow:');
                if (techData.rsi.hasData) insights += formatSignal('RSI zone', techData.rsi.oversold, techData.rsi.overbought, 'Oversold:', 'Overbought:');
                if (techData.macd.hasData) insights += formatSignal('MACD', techData.macd.bullish, techData.macd.bearish, 'Bullish:', 'Bearish:');
                if (techData.structure.hasData) insights += formatSignal('Structure', techData.structure.bullish, techData.structure.bearish, 'Bullish:', 'Bearish:');
                if (techData.runners.hasData) insights += formatSignal('Entry type', techData.runners.nonRunners, techData.runners.runners, 'Non-runners:', 'Runners (>5%):');
                if (techData.squeeze.hasData) insights += formatSignal('Short squeeze', techData.squeeze.high, techData.squeeze.low, 'High DTC:', 'Low DTC:');
                if (techData.regime.hasData) {
                    let regimeLine = '- Regime at entry: ';
                    const parts = [];
                    if (techData.regime.bull) parts.push(`Bull ${techData.regime.bull.winRate.toFixed(0)}% WR (${techData.regime.bull.count})`);
                    if (techData.regime.bear) parts.push(`Bear ${techData.regime.bear.winRate.toFixed(0)}% WR (${techData.regime.bear.count})`);
                    if (techData.regime.choppy) parts.push(`Choppy ${techData.regime.choppy.winRate.toFixed(0)}% WR (${techData.regime.choppy.count})`);
                    if (parts.length > 0) insights += regimeLine + parts.join(', ') + '\n';
                }
                if (techData.vix.hasData) {
                    let vixLine = '- VIX at entry: ';
                    const parts = [];
                    if (techData.vix.complacent) parts.push(`Complacent ${techData.vix.complacent.winRate.toFixed(0)}% (${techData.vix.complacent.count})`);
                    if (techData.vix.normal) parts.push(`Normal ${techData.vix.normal.winRate.toFixed(0)}% (${techData.vix.normal.count})`);
                    if (techData.vix.elevated) parts.push(`Elevated ${techData.vix.elevated.winRate.toFixed(0)}% (${techData.vix.elevated.count})`);
                    if (techData.vix.panic) parts.push(`Panic ${techData.vix.panic.winRate.toFixed(0)}% (${techData.vix.panic.count})`);
                    if (parts.length > 0) insights += vixLine + parts.join(', ') + '\n';
                }
                insights += '\n';
            }

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

        // REGIME TRANSITION LOG: Track regime changes over time
        function recordRegimeTransition(regime) {
            if (!regime) return { isTransition: false };
            if (!portfolio.regimeHistory) portfolio.regimeHistory = [];

            // Normalize to bull/bear/choppy
            const raw = regime.toLowerCase();
            const normalized = raw.includes('bull') ? 'bull' : raw.includes('bear') ? 'bear' : 'choppy';
            const now = new Date().toISOString();

            const last = portfolio.regimeHistory.length > 0
                ? portfolio.regimeHistory[portfolio.regimeHistory.length - 1]
                : null;

            // Same regime — just update timestamp
            if (last && last.regime === normalized) {
                last.lastSeen = now;
                return { isTransition: false };
            }

            // New regime — record transition
            const entry = {
                regime: normalized,
                timestamp: now,
                lastSeen: now,
                from: last ? last.regime : null
            };
            portfolio.regimeHistory.push(entry);

            // Cap at 200 entries (FIFO)
            if (portfolio.regimeHistory.length > 200) {
                portfolio.regimeHistory = portfolio.regimeHistory.slice(-200);
            }

            console.log(`📊 Regime transition: ${last ? last.regime : 'none'} → ${normalized}`);
            return { isTransition: true, from: last ? last.regime : null, to: normalized };
        }

        // HOLD OUTCOME TRACKING: Record hold decisions with current price
        function recordHoldSnapshots(holdDecisions, enhancedMarketData, regime) {
            if (!holdDecisions || holdDecisions.length === 0) return;
            if (!portfolio.holdSnapshots) portfolio.holdSnapshots = [];

            const normalizedRegime = regime ? (regime.toLowerCase().includes('bull') ? 'bull' : regime.toLowerCase().includes('bear') ? 'bear' : 'choppy') : 'unknown';
            const now = new Date().toISOString();

            for (const decision of holdDecisions) {
                const sym = decision.symbol;
                const emd = enhancedMarketData[sym];
                if (!emd || !emd.price) continue;

                portfolio.holdSnapshots.push({
                    symbol: sym,
                    holdDate: now,
                    price: emd.price,
                    conviction: decision.conviction || null,
                    reasoning: (decision.reasoning || '').substring(0, 120),
                    technicals: {
                        rsi: emd.rsi ?? null,
                        macdCrossover: emd.macd?.crossover || null,
                        structure: emd.marketStructure?.structure || null,
                        dtc: emd.shortInterest?.daysToCover ?? null,
                        vixLevel: vixCache?.level ?? null,
                        vixInterpretation: vixCache?.interpretation ?? null
                    },
                    regime: normalizedRegime,
                    nextPrice: null,
                    nextDate: null,
                    priceChange: null,
                    evaluated: false
                });
            }

            // Cap at 200 entries — evict evaluated first, then oldest
            if (portfolio.holdSnapshots.length > 200) {
                const evaluated = portfolio.holdSnapshots.filter(s => s.evaluated);
                const unevaluated = portfolio.holdSnapshots.filter(s => !s.evaluated);
                if (unevaluated.length > 200) {
                    portfolio.holdSnapshots = unevaluated.slice(-200);
                } else {
                    const keepEvaluated = 200 - unevaluated.length;
                    portfolio.holdSnapshots = evaluated.slice(-keepEvaluated).concat(unevaluated);
                }
            }

            console.log(`📊 Recorded ${holdDecisions.length} hold snapshots (total: ${portfolio.holdSnapshots.length})`);
        }

        // HOLD OUTCOME EVALUATION: Fill in next-cycle prices for unevaluated snapshots
        function evaluateHoldSnapshots(enhancedMarketData) {
            if (!portfolio.holdSnapshots || portfolio.holdSnapshots.length === 0) return;

            const now = new Date().toISOString();
            let evaluatedCount = 0;

            for (const snapshot of portfolio.holdSnapshots) {
                if (snapshot.evaluated) continue;

                const emd = enhancedMarketData[snapshot.symbol];
                if (!emd || !emd.price) continue;

                snapshot.nextPrice = emd.price;
                snapshot.nextDate = now;
                snapshot.priceChange = ((emd.price - snapshot.price) / snapshot.price) * 100;
                snapshot.evaluated = true;
                evaluatedCount++;
            }

            if (evaluatedCount > 0) {
                console.log(`📊 Evaluated ${evaluatedCount} hold snapshots`);
            }
        }

        // HOLD ACCURACY ANALYSIS: Aggregate hold decision outcomes
        function analyzeHoldAccuracy() {
            const snapshots = (portfolio.holdSnapshots || []).filter(s => s.evaluated && s.priceChange !== null);
            if (snapshots.length < 5) return null;

            const correct = snapshots.filter(s => s.priceChange > 0);
            const overall = {
                total: snapshots.length,
                accuracy: (correct.length / snapshots.length) * 100,
                avgChange: snapshots.reduce((sum, s) => sum + s.priceChange, 0) / snapshots.length
            };

            // By conviction bucket
            const byConviction = {};
            for (const bucket of ['low', 'medium', 'high']) {
                const range = bucket === 'low' ? [1, 4] : bucket === 'medium' ? [5, 7] : [8, 10];
                const group = snapshots.filter(s => s.conviction >= range[0] && s.conviction <= range[1]);
                if (group.length >= 3) {
                    const wins = group.filter(s => s.priceChange > 0);
                    byConviction[bucket] = {
                        total: group.length,
                        accuracy: (wins.length / group.length) * 100,
                        avgChange: group.reduce((sum, s) => sum + s.priceChange, 0) / group.length
                    };
                }
            }

            // By regime
            const byRegime = {};
            for (const regime of ['bull', 'bear', 'choppy']) {
                const group = snapshots.filter(s => s.regime === regime);
                if (group.length >= 3) {
                    const wins = group.filter(s => s.priceChange > 0);
                    byRegime[regime] = {
                        total: group.length,
                        accuracy: (wins.length / group.length) * 100,
                        avgChange: group.reduce((sum, s) => sum + s.priceChange, 0) / group.length
                    };
                }
            }

            // By RSI zone
            const byRSI = {};
            for (const zone of ['oversold', 'neutral', 'overbought']) {
                const range = zone === 'oversold' ? [0, 30] : zone === 'neutral' ? [30, 70] : [70, 100];
                const group = snapshots.filter(s => s.technicals?.rsi >= range[0] && s.technicals?.rsi < range[1]);
                if (group.length >= 3) {
                    const wins = group.filter(s => s.priceChange > 0);
                    byRSI[zone] = {
                        total: group.length,
                        accuracy: (wins.length / group.length) * 100,
                        avgChange: group.reduce((sum, s) => sum + s.priceChange, 0) / group.length
                    };
                }
            }

            return { overall, byConviction, byRegime, byRSI };
        }

        // REGIME TRANSITION ANALYSIS: Correlate regime changes with trade outcomes
        function analyzeRegimeTransitions() {
            const history = portfolio.regimeHistory || [];
            if (history.length < 2) return null;

            const latest = history[history.length - 1];
            const durationMs = Date.now() - new Date(latest.timestamp).getTime();
            const durationDays = Math.round(durationMs / (24 * 60 * 60 * 1000));

            // Transition frequency
            const firstTs = new Date(history[0].timestamp).getTime();
            const totalDays = Math.max(1, (Date.now() - firstTs) / (24 * 60 * 60 * 1000));
            const avgFrequency = totalDays / (history.length - 1);

            // Near-transition trade analysis: trades entered within 2 days of a regime change
            const closedTrades = portfolio.closedTrades || [];
            const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;
            let nearTransitionWins = 0, nearTransitionTotal = 0;
            let overallWins = 0, overallTotal = 0;

            for (const trade of closedTrades) {
                if (!trade.buyDate) continue;
                const buyTime = new Date(trade.buyDate).getTime();
                const isWin = trade.profitLoss > 0;
                overallTotal++;
                if (isWin) overallWins++;

                for (const transition of history) {
                    const transTime = new Date(transition.timestamp).getTime();
                    if (Math.abs(buyTime - transTime) <= TWO_DAYS) {
                        nearTransitionTotal++;
                        if (isWin) nearTransitionWins++;
                        break;
                    }
                }
            }

            // Recent transitions for UI timeline (last 5)
            const recentTransitions = history.slice(-6).map(h => ({
                regime: h.regime,
                from: h.from,
                timestamp: h.timestamp,
                daysAgo: Math.round((Date.now() - new Date(h.timestamp).getTime()) / (24 * 60 * 60 * 1000))
            }));

            return {
                current: latest.regime,
                durationDays,
                transitionCount: history.length - 1,
                avgFrequencyDays: Math.round(avgFrequency),
                nearTransition: nearTransitionTotal >= 3 ? {
                    winRate: (nearTransitionWins / nearTransitionTotal) * 100,
                    total: nearTransitionTotal
                } : null,
                overallWinRate: overallTotal >= 3 ? (overallWins / overallTotal) * 100 : null,
                recentTransitions
            };
        }

        // Smart Stock Screener - Samples across ALL sectors every time
        async function screenStocks() {
            // With unlimited API calls, we can sample from all sectors to find the best opportunities
            // This gives APEX a comprehensive view of the entire market
            
            const stockLists = {
                techAI: ['NVDA', 'AVGO', 'GOOGL', 'MSFT', 'META', 'ORCL', 'CRM', 'ADBE', 'NOW', 'INTU',
                         'PLTR', 'SNOW', 'AI', 'BBAI', 'SOUN', 'PATH', 'S', 'HUBS', 'ZM', 'DOCU',
                         'TEAM', 'WDAY', 'VEEV', 'ESTC', 'DDOG', 'NET', 'MDB', 'CRWD', 'PANW', 'ZS',
                         'OKTA', 'CFLT', 'GTLB', 'FROG', 'BILL', 'DOCN', 'GTM', 'MNDY', 'PCOR', 'APP'],
                
                techHardware: ['AAPL', 'QCOM', 'INTC', 'MU', 'ARM', 'DELL', 'HPQ', 'AMAT', 'LRCX', 'MRVL',
                               'AMD', 'TXN', 'ADI', 'NXPI', 'KLAC', 'ASML', 'TSM', 'SNPS', 'CDNS', 'ON',
                               'MPWR', 'SWKS', 'QRVO', 'ENTG', 'FORM', 'MKSI', 'COHR', 'IPGP', 'LITE', 'AMBA',
                               'SLAB', 'CRUS', 'SYNA', 'MCHP', 'SMCI', 'WDC', 'STX', 'PSTG', 'NTAP', 'CHKP',
                               'IONQ', 'RGTI', 'QBTS', 'QUBT', 'ARQQ', 'IBM'],
                
                evAuto: ['TSLA', 'RIVN', 'LCID', 'NIO', 'XPEV', 'LI', 'F', 'GM', 'STLA', 'TM',
                         'HMC', 'RACE', 'VWAGY', 'PSNY', 'NSANY', 'APTV', 'MBGYY', 'POAHY', 'FUJHY', 'ALV',
                         'WKHS', 'BLNK', 'CHPT', 'EVGO', 'PAG', 'WOLF', 'QS', 'OUST',
                         'HYLN', 'GEV', 'JZXN', 'VRM', 'CVNA', 'KMX', 'AN', 'LAD'],
                
                finance: ['JPM', 'BAC', 'WFC', 'GS', 'MS', 'C', 'BLK', 'SCHW', 'V', 'MA',
                          'PYPL', 'GPN', 'AXP', 'FIS', 'COF', 'ALLY', 'USB', 'PNC', 'TFC', 'RF',
                          'KEY', 'FITB', 'MTB', 'CFG', 'HBAN', 'STT', 'BK', 'NTRS',
                          'ZION', 'FHN', 'WRB', 'CB', 'TRV', 'ALL', 'PGR', 'AIG', 'MET', 'PRU'],
                
                growth: ['DKNG', 'RBLX', 'U', 'PINS', 'SNAP', 'SPOT', 'ABNB', 'LYFT', 'DASH', 'UBER',
                         'CPNG', 'BKNG', 'EXPE', 'TCOM', 'TRIP', 'PTON', 'LULU', 'ETSY', 'W', 'CHWY',
                         'COIN', 'OPEN', 'COMP', 'RKT', 'CWAN', 'DUOL', 'BROS', 'CAVA', 'HOOD', 'AFRM',
                         'UPST', 'LC', 'NU', 'SOFI', 'NFLX', 'ROKU', 'WBD', 'FOXA', 'CMCSA', 'T'],
                
                healthcare: ['JNJ', 'UNH', 'LLY', 'ABBV', 'PFE', 'MRNA', 'VRTX', 'REGN', 'BMY', 'GILD',
                             'AMGN', 'CVS', 'CI', 'HUM', 'ISRG', 'TMO', 'DHR', 'ABT', 'SYK', 'BSX',
                             'MDT', 'BDX', 'BAX', 'ZBH', 'HCA', 'DVA', 'EXAS', 'ILMN',
                             'BIIB', 'ALNY', 'INCY', 'NBIX', 'UTHR', 'JAZZ', 'SRPT', 'BMRN', 'IONS', 'RGEN'],
                
                consumer: ['AMZN', 'WMT', 'COST', 'TGT', 'HD', 'LOW', 'SBUX', 'MCD', 'CMG', 'YUM',
                           'NKE', 'RH', 'DECK', 'CROX', 'ULTA', 'ELF', 'LEVI', 'UAA', 'DIS', 'GOOG',
                           'KO', 'PEP', 'PM', 'MO', 'BUD', 'TAP', 'STZ', 'MNST', 'CELH', 'KDP',
                           'ORLY', 'AZO', 'AAP', 'GPC', 'TSCO', 'DG', 'DLTR', 'ROST', 'TJX', 'BBY'],
                
                energy: ['XOM', 'CVX', 'COP', 'SLB', 'EOG', 'OXY', 'MPC', 'PSX', 'VLO', 'TRGP',
                         'DVN', 'FANG', 'WMB', 'APA', 'HAL', 'BKR', 'NOV', 'FTI', 'NEE', 'DUK',
                         'SO', 'D', 'AEP', 'EXC', 'ENPH', 'SEDG', 'RUN', 'FSLR', 'PLUG',
                         'PBF', 'DK', 'CTRA', 'OVV', 'PR', 'SM', 'MGY', 'MTDR', 'CHRD', 'OKE',
                         'SMR', 'VST', 'CEG', 'CCJ', 'LNG', 'AR'],
                
                // NEW SECTORS ADDED:
                
                industrials: ['CAT', 'DE', 'CMI', 'EMR', 'ETN', 'PH', 'ROK', 'AME', 'DOV', 'ITW',
                              'GE', 'HON', 'MMM', 'DHI', 'LEN', 'NVR', 'PHM', 'TOL', 'BLD', 'BLDR',
                              'UNP', 'NSC', 'CSX', 'UPS', 'FDX', 'CHRW', 'JBHT', 'KNX', 'ODFL', 'XPO',
                              'CARR', 'VLTO', 'IR', 'WM', 'RSG', 'PCAR', 'PWR', 'JCI', 'AOS', 'ROP'],
                
                realEstate: ['AMT', 'PLD', 'CCI', 'EQIX', 'PSA', 'DLR', 'WELL', 'O', 'VICI', 'SPG',
                             'AVB', 'EQR', 'MAA', 'UDR', 'CPT', 'ESS', 'AIV', 'ELS', 'SUI', 'NXRT',
                             'VTR', 'STWD', 'DOC', 'OHI', 'SBRA', 'LTC', 'HR', 'MPT', 'NHI', 'CTRE',
                             'IRM', 'CUBE', 'NSA', 'REXR', 'TRNO', 'SELF', 'SAFE'],
                
                materials: ['NEM', 'FCX', 'GOLD', 'AU', 'AEM', 'WPM', 'FNV', 'RGLD', 'KGC', 'HL',
                            'NUE', 'STLD', 'RS', 'CLF', 'AA', 'MT', 'TX', 'CMC', 'NB', 'ATI',
                            'DOW', 'LYB', 'EMN', 'CE', 'APD', 'LIN', 'ECL', 'ALB', 'SQM', 'LAC',
                            'MP', 'DD', 'PPG', 'SHW', 'RPM', 'AXTA', 'FUL', 'NEU', 'USAR', 'UUUU'],
                
                defense: ['LMT', 'RTX', 'NOC', 'GD', 'BA', 'LHX', 'HII', 'TXT', 'HWM', 'AXON',
                          'KTOS', 'AVAV', 'AIR', 'SAIC', 'LDOS', 'CACI', 'BAH', 'BWXT', 'WWD', 'MOG.A',
                          'TDG', 'HEI', 'ROCK', 'IMOS', 'CW', 'AIN', 'MLI', 'B', 'RUSHA',
                          'LGTY', 'PLXS', 'VECO', 'POWI', 'VICR', 'MYRG', 'DY', 'APOG']
            };
            
            // Use all stocks from every sector for maximum coverage
            const selectedStocks = [];

            for (const [sector, stocks] of Object.entries(stockLists)) {
                selectedStocks.push(...stocks);
            }
            
            console.log(`🔍 COMPREHENSIVE Cross-Sector Analysis`);
            console.log(`📊 Analyzing ${selectedStocks.length} stocks across ${Object.keys(stockLists).length} sectors`);
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
                        const BATCH_DELAY_MS = 300;
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
                
                // Step 2: Fetch 40-day grouped daily bars + ticker details + short interest
                thinkingDetail.textContent = `🧪 Fetching 40-day grouped daily bars + details...`;
                try {
                    await Promise.all([
                        fetchGroupedDailyBars(new Set(symbols)),
                        fetchTickerDetails(symbols),
                        fetchShortInterest(symbols),
                        fetchVIX()
                    ]);
                } catch (groupedErr) {
                    console.warn('Grouped daily bars failed, falling back to per-ticker:', groupedErr.message);
                    await fetchAll5DayHistories(symbols);
                }
                const historyTime = performance.now();
                console.log(`⏱️ History phase: ${((historyTime - snapshotTime) / 1000).toFixed(2)}s`);
                console.log(`✅ 40-day history cached for ${Object.keys(multiDayCache).length}/${symbols.length} stocks`);
                
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
                    // Technical indicators
                    const drBars = multiDayCache[symbol];
                    const drRsi = calculateRSI(drBars);
                    const drMacd = calculateMACD(drBars);
                    const drRsiBonus = drRsi != null ? (drRsi < 30 ? 1.5 : drRsi > 70 ? -1.0 : 0) : 0;
                    const drMacdBonus = drMacd?.crossover === 'bullish' ? 1.0 : drMacd?.crossover === 'bearish' ? -1.0 : 0;
                    const drDtc = shortInterestCache[symbol]?.daysToCover || 0;
                    const drStructScore = struct?.structureScore || 0;
                    const drSqueezeBonus = (drDtc > 5 && drStructScore >= 1 && flow !== 'outflow') ? 1.5 : (drDtc > 3 && drStructScore >= 1) ? 0.75 : 0;
                    // Use snapshot changePercent, but on weekends/closed (0%) fall back to last bar's return
                    let dayChg = data.changePercent || 0;
                    if (dayChg === 0) {
                        if (drBars && drBars.length >= 2) {
                            const last = drBars[drBars.length - 1], prev = drBars[drBars.length - 2];
                            dayChg = prev.c ? ((last.c - prev.c) / prev.c) * 100 : 0;
                        }
                    }
                    dryRunScored.push({ symbol, compositeScore: momScore + rsNorm + sBonus + strBonus + drRsiBonus + drMacdBonus + drSqueezeBonus, momentum: momScore, rs: rs?.rsScore || 0, sector, sectorBonus: sBonus, structureScore: drStructScore, structure: struct?.structure || 'unknown', dayChange: parseFloat(dayChg.toFixed(2)), rsi: drRsi, macdCrossover: drMacd?.crossover || 'none', macdHistogram: drMacd?.histogram ?? null, daysToCover: drDtc, name: tickerDetailsCache[symbol]?.name || null, marketCap: tickerDetailsCache[symbol]?.marketCap || null });
                });

                // Fetch news for top candidates + holdings
                dryRunScored.sort((a, b) => b.compositeScore - a.compositeScore);
                const drNewsSymbols = [...new Set([
                    ...dryRunScored.slice(0, 25).map(s => s.symbol),
                    ...Object.keys(portfolio.holdings)
                ])];
                await fetchNewsForStocks(drNewsSymbols);

                // Persist candidate scores from dry run
                portfolio.lastCandidateScores = {
                    timestamp: new Date().toISOString(),
                    candidates: dryRunScored.slice(0, 40)
                };

                // Persist VIX from dry run
                if (vixCache) portfolio.lastVIX = { ...vixCache, fetchedAt: new Date().toISOString() };

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
                
                const detailsCount = Object.keys(tickerDetailsCache).length;
                const shortIntCount = Object.values(shortInterestCache).filter(v => v && v.daysToCover > 0).length;
                const newsCount = Object.values(newsCache).filter(v => v && v.length > 0).length;

                showResultModal('Dry Run Complete', [
                    { label: 'Prices Fetched', value: `${Object.keys(marketData).length} / ${symbols.length}`, cls: 'success' },
                    { label: 'Price Histories', value: `${Object.keys(multiDayCache).length} (40-day bars)` },
                    { label: 'Ticker Details', value: `${detailsCount} (market cap)` },
                    { label: 'Short Interest', value: `${shortIntCount} with DTC` },
                    { label: 'News Headlines', value: `${newsCount} stocks` },
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
                        const BATCH_DELAY_MS = 300;
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
                    const BATCH_DELAY_MS = 300;
                    
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
                        `• Weekend trading data\n\n` +
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
                thinkingDetail.textContent = 'Fetching 40-day grouped daily bars + ticker details + short interest...';
                console.log('🧠 Running enhanced market analysis...');

                // 0. Fetch data in parallel: grouped daily bars, ticker details, short interest
                const allSymbolsFetched = Object.keys(marketData);
                const allSymbolSet = new Set(allSymbolsFetched);
                try {
                    await Promise.all([
                        fetchGroupedDailyBars(allSymbolSet),
                        fetchTickerDetails(allSymbolsFetched),
                        fetchShortInterest(allSymbolsFetched),
                        fetchVIX()
                    ]);
                } catch (groupedErr) {
                    console.warn('Grouped daily bars failed, falling back to per-ticker fetch:', groupedErr.message);
                    await fetchAll5DayHistories(allSymbolsFetched);
                }
                
                // 1. Calculate sector rotation patterns (now uses multi-day data)
                const sectorRotation = detectSectorRotation(marketData);
                console.log('📊 Sector Rotation Analysis:', sectorRotation);

                // Persist sector rotation for dashboard display
                portfolio.lastSectorRotation = { timestamp: new Date().toISOString(), sectors: sectorRotation };

                // Persist VIX for dashboard display
                if (vixCache) portfolio.lastVIX = { ...vixCache, fetchedAt: new Date().toISOString() };

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

                    // Technical indicators (RSI, SMA, MACD) from 40-bar data
                    const bars = multiDayCache[symbol];
                    const rsi = calculateRSI(bars);
                    const sma20 = calculateSMA(bars, 20);
                    const macd = calculateMACD(bars);

                    // Combine all data
                    enhancedMarketData[symbol] = {
                        ...data,
                        sector: sector,
                        momentum: momentum,
                        relativeStrength: relativeStrength,
                        sectorRotation: sectorRotation[sector],
                        marketStructure: marketStructure,
                        rsi: rsi,
                        sma20: sma20,
                        macd: macd,
                        marketCap: tickerDetailsCache[symbol]?.marketCap || null,
                        companyName: tickerDetailsCache[symbol]?.name || null,
                        sicDescription: tickerDetailsCache[symbol]?.sicDescription || null,
                        shortInterest: shortInterestCache[symbol] || null,
                        recentNews: newsCache[symbol] || null
                    };
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

                // Evaluate any pending hold snapshots from previous cycle
                evaluateHoldSnapshots(enhancedMarketData);

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

                    // Intraday runner penalty: stocks already up big today are chasing risk
                    const todayChg = data.momentum?.todayChange || data.changePercent || 0;
                    const runnerPenalty = todayChg >= 15 ? -4
                        : todayChg >= 10 ? -3
                        : todayChg >= 7 ? -2
                        : todayChg >= 5 ? -1
                        : 0;

                    // Extension penalty: stretched on momentum OR relative strength (not both required)
                    const extensionPenalty = (momentumScore >= 9 || rsNormalized >= 8.5) ? -3
                        : (momentumScore >= 8 || rsNormalized >= 8) ? -2
                        : (momentumScore >= 7.5 || rsNormalized >= 7.5) ? -1
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

                    // RSI bonus/penalty: oversold = opportunity, overbought = caution
                    const stockRsi = data.rsi;
                    const rsiBonusPenalty = stockRsi != null ? (stockRsi < 30 ? 1.5 : stockRsi > 70 ? -1.0 : 0) : 0;

                    // MACD bonus: bullish crossover = momentum shifting positive
                    const macdCross = data.macd?.crossover;
                    const macdBonus = macdCross === 'bullish' ? 1.0 : macdCross === 'bearish' ? -1.0 : 0;

                    // Squeeze bonus: high short interest + bullish structure = squeeze potential
                    const dtc = data.shortInterest?.daysToCover || 0;
                    const structScore = data.marketStructure?.structureScore ?? 0;
                    const squeezeBonus = (dtc > 5 && structScore >= 1 && data.sectorRotation?.moneyFlow !== 'outflow') ? 1.5
                        : (dtc > 3 && structScore >= 1) ? 0.75
                        : 0;

                    const compositeScore = momentumScore + rsNormalized + sectorBonus + accelBonus + consistencyBonus + bigMoverBonus + structureBonus + extensionPenalty + pullbackBonus + runnerPenalty + rsiBonusPenalty + macdBonus + squeezeBonus;
                    
                    return { symbol, compositeScore, data };
                });
                
                // 2. Sort by composite score descending
                scoredStocks.sort((a, b) => b.compositeScore - a.compositeScore);

                // Persist top candidate scores for dashboard display
                portfolio.lastCandidateScores = {
                    timestamp: new Date().toISOString(),
                    candidates: scoredStocks.slice(0, 40).map(s => {
                        // Use snapshot changePercent, but on weekends/closed market (0%) fall back to last bar's return
                        let dayChg = s.data.changePercent || 0;
                        if (dayChg === 0) {
                            const bars = multiDayCache[s.symbol];
                            if (bars && bars.length >= 2) {
                                const last = bars[bars.length - 1], prev = bars[bars.length - 2];
                                dayChg = prev.c ? ((last.c - prev.c) / prev.c) * 100 : 0;
                            }
                        }
                        return {
                            symbol: s.symbol,
                            compositeScore: s.compositeScore,
                            momentum: s.data.momentum?.score || 0,
                            rs: s.data.relativeStrength?.rsScore || 0,
                            sector: s.data.sector || 'Unknown',
                            sectorBonus: s.data.sectorRotation?.moneyFlow === 'inflow' ? 2 : s.data.sectorRotation?.moneyFlow === 'modest-inflow' ? 1 : s.data.sectorRotation?.moneyFlow === 'outflow' ? -1 : 0,
                            structureScore: s.data.marketStructure?.structureScore || 0,
                            structure: s.data.marketStructure?.structure || 'unknown',
                            dayChange: parseFloat(dayChg.toFixed(2)),
                            rsi: s.data.rsi,
                            macdCrossover: s.data.macd?.crossover || 'none',
                            macdHistogram: s.data.macd?.histogram ?? null,
                            marketCap: s.data.marketCap,
                            daysToCover: s.data.shortInterest?.daysToCover || 0,
                            name: tickerDetailsCache[s.symbol]?.name || null
                        };
                    })
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

                // Fetch news for top candidates + holdings (limited set, not all 300)
                const newsSymbols = [...new Set([
                    ...scoredStocks.slice(0, 25).map(s => s.symbol),
                    ...Object.keys(portfolio.holdings)
                ])];
                thinkingDetail.textContent = `Fetching news for ${newsSymbols.length} stocks...`;
                await fetchNewsForStocks(newsSymbols);

                // Inject news into enhancedMarketData (and filteredMarketData, which references same objects)
                newsSymbols.forEach(symbol => {
                    if (enhancedMarketData[symbol]) {
                        enhancedMarketData[symbol].recentNews = newsCache[symbol] || null;
                    }
                });

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
                let phase1HoldDecisions = [];
                let phase1Summary = '';
                let phase1Regime = '';
                let updatedCash = portfolio.cash;
                
                if (hasHoldings) {
                    thinkingDetail.textContent = 'Phase 1: Reviewing holdings for sell decisions...';
                    console.log('🔍 Phase 1: Holdings review');
                    
                    const holdingsData = {};
                    holdingSymbolsList.forEach(sym => { if (enhancedMarketData[sym]) holdingsData[sym] = enhancedMarketData[sym]; });
                    
                    const p1Data = await fetchAnthropicStreaming({
                            model: 'claude-sonnet-4-5-20250929',
                            max_tokens: 6000,
                            tools: [{
                                type: "web_search_20250305",
                                name: "web_search",
                                max_uses: 3,
                                allowed_domains: ["investing.com", "bloomberg.com", "cnbc.com", "finance.yahoo.com", "seekingalpha.com", "benzinga.com", "tradingview.com"]
                            }],
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

SEARCH STRATEGY: You have pre-loaded recentNews with recent headlines + machine sentiment for each holding.
${vixCache ? 'VIX level is pre-loaded below — no need to search for it.\n' : ''}Scan recentNews FIRST, then use web search for:
1. One market regime search${vixCache ? ' — broader context beyond VIX (e.g. SPY trend, macro headlines)' : ' (required — include VIX level, SPY trend, macro headlines)'}
2. If ANY holding has EMPTY or STALE recentNews (no articles, or all articles older than 7 days), search for recent news on those holdings — news gaps are blind spots that could hide sell signals. Search: "SYMBOL stock news this week site:investing.com OR site:reuters.com OR site:marketwatch.com"
3. Deep dive on a holding if recentNews shows a potentially alarming headline that needs verification
Pre-loaded news coverage varies by ticker — do NOT assume silence means safety.

SEARCH RECENCY RULE: Today is the ONLY date that matters. Search results older than 2 trading days may reflect outdated conditions (e.g. "tech selloff" that has since reversed). When search results conflict with the real-time price/momentum/RS data provided below, ALWAYS trust the quantitative data — it is live. Note the date of any search result you cite and discount stale narratives. Include "today" or "this week" in search queries to get current results.

Portfolio Cash: $${portfolio.cash.toFixed(2)}
${vixCache ? `VIX: ${vixCache.level.toFixed(1)} (${vixCache.interpretation}${vixCache.trend !== 'stable' ? ', ' + vixCache.trend : ''})` : ''}
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
                },
                rsi: holdingsData[sym]?.rsi ?? null,
                macdSignal: holdingsData[sym]?.macd?.crossover ?? 'none',
                shortInterest: holdingsData[sym]?.shortInterest ? { daysToCover: holdingsData[sym].shortInterest.daysToCover } : null,
                recentNews: (holdingsData[sym]?.recentNews || []).slice(0, 2).map(n => ({ title: n.title, sentiment: n.sentiment }))
            } };
        if (hh < 24) eh[sym].WARNING = 'RECENTLY PURCHASED - only sell on negative catalyst';
    });
    return JSON.stringify(eh);
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
                    });
                    if (p1Data.type === 'error' || p1Data.error) {
                        const em = p1Data.error?.message || 'Phase 1 error';
                        if (em.includes('rate_limit')) throw new Error('Rate limit on Phase 1! Wait 60s. 🕐');
                        console.warn('Phase 1 error (non-fatal):', em);
                    } else {
                        if (p1Data.stop_reason === 'max_tokens') {
                            console.warn('⚠️ Phase 1 TRUNCATED — hit max_tokens limit! Response may be incomplete. Consider increasing max_tokens.');
                            addActivity('⚠️ Phase 1 response was truncated — analysis may be incomplete.', 'warning');
                        }
                        let p1Text = '';
                        if (p1Data.content) for (const b of p1Data.content) { if (b.type === 'text') p1Text += b.text; }

                        try {
                            console.log('Phase 1 raw text (first 500):', p1Text.substring(0, 500));
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
                                ps = escapeNewlinesInJsonStrings(ps);
                                // Fix single quotes around property names and string values
                                ps = ps.replace(/'([^']+)':/g, '"$1":');
                                ps = ps.replace(/:\s*'([^']*)'/g, ': "$1"');
                                ps = ps.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
                                let parsed;
                                try {
                                    parsed = JSON.parse(ps);
                                } catch (innerParseErr) {
                                    // Fallback: structural extraction for Phase 1 fields
                                    console.warn('Phase 1 JSON.parse failed, trying structural extraction:', innerParseErr.message);
                                    parsed = {};
                                    // Extract decisions array
                                    const decisionsMatch = p1Text.match(/"decisions"\s*:\s*(\[[\s\S]*?\])\s*(?:,\s*"|\s*})/);
                                    if (decisionsMatch) {
                                        try {
                                            let dStr = escapeNewlinesInJsonStrings(decisionsMatch[1]);
                                            dStr = dStr.replace(/'([^']+)':/g, '"$1":').replace(/:\s*'([^']*)'/g, ': "$1"');
                                            dStr = dStr.replace(/,(\s*[}\]])/g, '$1');
                                            parsed.decisions = JSON.parse(dStr);
                                        } catch (e2) { console.warn('Structural decisions parse failed:', e2.message); }
                                    }
                                    // Extract holdings_summary
                                    const summaryMatch = p1Text.match(/"holdings_summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
                                    if (summaryMatch) parsed.holdings_summary = summaryMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
                                    // Extract market_regime
                                    const regimeMatch = p1Text.match(/"market_regime"\s*:\s*"(bull|bear|choppy)"/i);
                                    if (regimeMatch) parsed.market_regime = regimeMatch[1].toLowerCase();
                                    if (!parsed.decisions) throw innerParseErr; // Give up if no decisions found
                                    console.log('✅ Phase 1 structural extraction recovered', parsed.decisions.length, 'decisions');
                                }
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
                                    phase1HoldDecisions = parsed.decisions.filter(d => d.action === 'HOLD');
                                    // Synthesize HOLD decisions for holdings the AI didn't explicitly mention
                                    const phase1MentionedSymbols = new Set(parsed.decisions.map(d => d.symbol));
                                    for (const sym of holdingSymbolsList) {
                                        if (!phase1MentionedSymbols.has(sym)) {
                                            console.log(`📊 Synthesizing HOLD for ${sym} (not mentioned in Phase 1 response)`);
                                            phase1HoldDecisions.push({
                                                action: 'HOLD',
                                                symbol: sym,
                                                shares: portfolio.holdings[sym],
                                                conviction: 5,
                                                reasoning: 'Holding — not flagged for sale in Phase 1 review.'
                                            });
                                        }
                                    }
                                    phase1Summary = parsed.holdings_summary || '';
                                    phase1Regime = parsed.market_regime || '';
                                    // Persist market regime for dashboard display
                                    if (phase1Regime) {
                                        portfolio.lastMarketRegime = { regime: phase1Regime, timestamp: new Date().toISOString() };
                                        recordRegimeTransition(phase1Regime);
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

                                    // Record hold decisions for outcome tracking
                                    if (phase1HoldDecisions.length > 0) {
                                        recordHoldSnapshots(phase1HoldDecisions, enhancedMarketData, phase1Regime);
                                    }
                                }
                            }
                        } catch (pe) {
                            console.warn('Phase 1 parse (non-fatal):', pe.message);
                            addActivity('⚠️ Phase 1 response had formatting issues — sell analysis may be incomplete', 'warning');
                        }
                    }
                }
                
                // ── PHASE 2: BUY DECISIONS ──
                // Hard guard: Remove ALL held symbols from Phase 2 candidate pool
                // Phase 1 already reviewed holdings — Phase 2 should only see new candidates
                const heldSymbols = Object.keys(portfolio.holdings);
                heldSymbols.forEach(sym => {
                    if (filteredMarketData[sym]) {
                        delete filteredMarketData[sym];
                        console.log(`🚫 Removed ${sym} from Phase 2 candidates (current holding, reviewed in Phase 1)`);
                    }
                });
                // Also remove Phase 1 sell symbols (in case they weren't in holdings anymore)
                if (phase1SellDecisions.length > 0) {
                    const sellSymbols = phase1SellDecisions.map(d => d.symbol);
                    sellSymbols.forEach(sym => {
                        if (filteredMarketData[sym]) {
                            delete filteredMarketData[sym];
                            console.log(`🚫 Removed ${sym} from Phase 2 candidates (just sold in Phase 1)`);
                        }
                    });
                }
                
                // Update candidate count to reflect removals
                const phase2CandidateCount = Object.keys(filteredMarketData).length;
                console.log(`📊 Phase 2 candidates: ${phase2CandidateCount} (after removing ${candidateCount - phase2CandidateCount} held/sold symbols)`);

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
                
                // ── LOW-CASH SKIP: If cash can't buy 1 share of any top-25 candidate, skip Phase 2 ──
                // Use top-25 scored candidates (real buy targets), not wildcards/reversals/penny stocks
                const holdingSymbolSet = new Set(holdingSymbols);
                const top25Prices = scoredStocks
                    .filter(s => !holdingSymbolSet.has(s.symbol))
                    .slice(0, 25)
                    .map(s => s.data.price)
                    .filter(p => p > 0);
                const cheapestCandidate = top25Prices.length > 0 ? Math.min(...top25Prices) : Infinity;

                if (updatedCash < cheapestCandidate) {
                    console.log(`💰 Low cash skip: $${updatedCash.toFixed(2)} < cheapest candidate $${cheapestCandidate.toFixed(2)} — skipping Phase 2`);
                    addActivity(`💰 Cash ($${updatedCash.toFixed(2)}) insufficient for any candidate — skipping buy analysis to save API costs.`, 'info');

                    // Execute Phase 1 sells (if any) and show Phase 1 decisions
                    const phase1Decisions = [...phase1SellDecisions, ...phase1HoldDecisions];
                    if (phase1Decisions.length > 0) {
                        await executeMultipleTrades({
                            decisions: phase1Decisions,
                            overall_reasoning: '**Phase 1 - Holdings Review:**\n' + phase1Summary + '\n\n**Phase 2 skipped** — insufficient cash for new positions.',
                            research_summary: ''
                        }, enhancedMarketData);
                    }

                    savePortfolio();
                    await updateUI();
                    updatePerformanceAnalytics();
                    setTimeout(() => { thinking.classList.remove('active'); }, 3000);
                    return;
                }

                thinkingDetail.textContent = hasHoldings ? 'Phase 2: Finding buy opportunities...' : 'Researching buy opportunities...';

                // Call Claude API for BUY decisions (Phase 2) via Cloudflare Worker proxy
                const data = await fetchAnthropicStreaming({
                        model: 'claude-sonnet-4-5-20250929',
                        max_tokens: 8000,
                        tools: [{
                            type: "web_search_20250305",
                            name: "web_search",
                            max_uses: 4,
                            allowed_domains: ["investing.com", "bloomberg.com", "cnbc.com", "finance.yahoo.com", "seekingalpha.com", "benzinga.com", "tradingview.com"]
                        }],
                        messages: [{
                            role: 'user',
                            content: `You are APEX, an AGGRESSIVE AI trading agent who's also a passionate teacher. You maximize returns while educating your user about WHY you make each decision.

IMPORTANT DATE CONTEXT:
Today's date is ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}.
Current quarter: Q${Math.floor((new Date().getMonth() + 3) / 3)} ${new Date().getFullYear()}

${hasHoldings && phase1SellDecisions.length > 0 ? '\n══ PHASE 1 RESULTS (Sells already decided) ══\nSells: ' + phase1SellDecisions.map(d => 'SELL ' + d.shares + ' ' + d.symbol + ': ' + d.reasoning).join('\n') + '\nHoldings Summary: ' + phase1Summary + '\nMarket Regime: ' + phase1Regime + (vixCache ? '\nVIX: ' + vixCache.level.toFixed(1) + ' (' + vixCache.interpretation + (vixCache.trend !== 'stable' ? ', ' + vixCache.trend : '') + ')' : '') + '\n══════════════════════════════════════\n' : ''}
${hasHoldings && phase1SellDecisions.length === 0 ? '\n══ PHASE 1 RESULTS: All holdings reviewed, no sells needed. Keeping current positions. ══\nMarket Regime: ' + phase1Regime + (vixCache ? '\nVIX: ' + vixCache.level.toFixed(1) + ' (' + vixCache.interpretation + (vixCache.trend !== 'stable' ? ', ' + vixCache.trend : '') + ')' : '') + '\n' : ''}
${!hasHoldings && vixCache ? '\n══ MARKET CONTEXT ══\nVIX: ' + vixCache.level.toFixed(1) + ' (' + vixCache.interpretation + (vixCache.trend !== 'stable' ? ', ' + vixCache.trend : '') + ')\n══════════════════\n' : ''}

When searching and citing data:
- ONLY use earnings from 2025 or later (2024 data is over 1 year old!)
- Search for "latest earnings" or "recent earnings" not specific old quarters
- Prefer most recent quarter data (Q4 2025, Q1 2026, etc.)
- If you can't find recent data, state that explicitly
- Don't mix old training knowledge with current searches
- SEARCH RECENCY: Include "today" or "this week" in queries. Results older than 2 trading days may reflect outdated conditions. When search narratives conflict with the real-time price/momentum/RS data below, ALWAYS trust the quantitative data — it is live. Note the date of any cited source.

CRITICAL RESEARCH REQUIREMENTS:
You have web_search tool available. Use it STRATEGICALLY to find CATALYSTS that will drive future moves.

SEARCH PHILOSOPHY - Find What Will Move Stocks TOMORROW, Not What Moved Them TODAY:
• You have PRE-LOADED recent headlines + machine sentiment for each candidate (in recentNews)
• Use pre-loaded news as CATALYST CLUES — deep dive the most promising ones with web search
• Focus on CATALYSTS (earnings beats, contracts, launches, upgrades)
• Look for UPCOMING events (guidance, product releases, regulatory decisions)
• Identify SECTOR tailwinds (industry trends, macro factors)
• Don't just search what's up today - find what's ABOUT to move

PRE-LOADED NEWS: Each candidate includes recentNews with up to 3 recent headlines + machine sentiment.
This REPLACES the need for broad catalyst discovery searches. Focus your web searches on:
- VERIFYING the most promising headlines (are they real? how big is the impact?)
- QUANTIFYING catalysts (revenue impact, contract value, guidance numbers)
- Sector-level macro context (rotation, policy, trends)
Do 2-3 searches total (not 3-5). Quality over quantity.

REQUIRED SEARCHES (do 2-3 focused searches):

1. **Catalyst Verification** (MOST IMPORTANT): Scan recentNews headlines across your candidates FIRST.
   If headlines reveal promising catalysts, search to VERIFY and QUANTIFY them.
   If recentNews is sparse or uninformative, do a broad catalyst discovery search.
   Examples:
   • "NVDA Q1 2026 earnings beat guidance raised data center revenue" → Verify + quantify headline
   • "semiconductor companies major contract wins February 2026" → Broad discovery if needed

   Goal: Verify promising headlines or discover catalysts if pre-loaded news is thin

2. **Sector Rotation Analysis**: Search for which sectors have tailwinds
   Examples:
   • "tech vs energy sector rotation February 2026" → Where is money flowing?
   • "semiconductor AI chip demand outlook 2026" → Sector-wide catalyst?

   Goal: Identify sectors with sustained momentum, not just today's leaders

3. **Stock-Specific Deep Dive**: Use recentNews as your starting point.
   Search to deep-dive the 1-2 most promising catalyst headlines you see, not to discover catalysts from scratch.
   Examples:
   • "PLTR Army contract details revenue impact 2026" → Quantify catalyst from headline
   • "AMD data center revenue growth forecast vs Intel" → Competitive position

   Goal: Quantify and verify catalysts for your top candidates

OPTIONAL additional search (only if needed for high-conviction plays):
4. **Risk Assessment**: Check for headwinds if considering a volatile stock
   Example: "semiconductor chip export restrictions impact 2026"

SEARCH STRATEGY - Be Specific and Efficient:
PREFERRED NEWS SOURCES: When searching for stock news or catalysts, prefer results from investing.com, reuters.com, marketwatch.com, bloomberg.com, cnbc.com, seekingalpha.com. These have the best ticker-specific coverage. Add "site:investing.com OR site:reuters.com" to searches when looking for specific stock news.
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
✅ Market cap context (provided in data — large cap = more liquid, small cap = more volatile)

Short Interest Consideration:
• daysToCover >5 + bullish structure + catalyst = potential SHORT SQUEEZE play
• High short interest adds upside convexity — shorts forced to cover amplifies moves
• daysToCover >3 with bullish catalyst = heightened squeeze probability

────────────────────────────────────────────────────────────────

STEP 4: TECHNICAL TIMING (Entry Point & Extension Check)
────────────────────────────────────────────────────────────────

Use enhanced market data:
• momentum.score (0-10)
• relativeStrength.rsScore (0-100)
• momentum.trend (building/fading/neutral)
• rsi (0-100): RSI >70 + extended = overbought, wait for pullback. RSI <30 + bullish structure = oversold bounce setup
• macd.crossover: 'bullish' = momentum shifting positive (confirmation signal), 'bearish' = momentum fading (caution)

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
📋 CURRENT HOLDINGS (Already reviewed in Phase 1 — DO NOT re-analyze)
════════════════════════════════════════════════════════════════

Phase 1 already reviewed all holdings and made HOLD/SELL decisions.
DO NOT output HOLD or SELL decisions — only output BUY decisions.
Do NOT re-analyze these stocks. Focus ALL your tokens on buy candidates.

Currently holding: ${Object.entries(portfolio.holdings).map(([s, sh]) => s + ' (' + sh + ' shares)').join(', ') || 'None'}

${formatPerformanceInsights()}
Current Portfolio:
- Cash Available: $${updatedCash.toFixed(2)} ← THIS IS YOUR BUYING POWER (includes cash from any Phase 1 sells)
- Total Portfolio Value: $${totalValue.toFixed(2)}
- Strategy: CATALYST-FIRST AGGRESSIVE SWING TRADING
${recentlySoldWarnings ? `
🚫 RECENTLY SOLD — RE-BUY REQUIRES NEW CATALYST:
${recentlySoldWarnings}Do NOT re-buy these stocks unless you can cite a specific NEW development that was NOT known when the sell decision was made.
` : ''}
Current Market Data (PRE-SCREENED TOP ${phase2CandidateCount} BUY CANDIDATES — holdings excluded):
${JSON.stringify(filteredMarketData)}

SECTOR SUMMARY (from all 300 stocks analyzed - full market context):
${JSON.stringify(sectorSummary)}

UNDERSTANDING THE DATA:
These ${phase2CandidateCount} stocks were pre-screened from 300+ by composite score (momentum + relative strength + sector flow).
Current holdings have been REMOVED from this data — Phase 1 already reviewed them. Only evaluate NEW positions.
The sector summary covers ALL 300 stocks so you have full market context.

Each stock includes:
• price, change, changePercent - Current price data (today vs prev close)
• momentum: { score: 0-10, trend, totalReturn5d, todayChange, upDays, totalDays, isAccelerating, volumeTrend }
  → Based on REAL 5-day price history. score uses: 5-day return + consistency + acceleration
  → isAccelerating: true if recent half outperformed first half (momentum building)
  → totalReturn5d: actual 5-day cumulative return. basis: '5-day-real' or '1-day-fallback'
  → volumeTrend: ratio of recent volume to early volume. >1.2 = rising (confirms momentum), <0.8 = declining (fragile)
• relativeStrength: { rsScore: 0-100, strength, stockReturn5d, sectorAvg5d, relativePerformance }
  → Based on 5-day returns vs sector 5-day average (not single-day!)
  → 70+ = outperforming sector over 5 days, 30- = underperforming
• sectorRotation: { moneyFlow, rotationSignal, avgReturn5d }
  → Based on 5-day sector trends (more reliable than single-day)

IMPORTANT: momentum and RS reflect MULTI-DAY trends, not just today's move.
A stock flat today but up 8% over 5 days → HIGH momentum.
A stock up 5% today but down over 5 days → MODERATE momentum (spike, weak trend).

• marketStructure: { structure, structureSignal, structureScore, choch, chochType, bos, bosType, sweep, fvg, lastSwingHigh, lastSwingLow }
  → Based on 40-day price bars. Detects swing highs/lows and structural shifts.
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
- Bearish CHoCH = structure breaking down, AVOID for new buys
- Bullish CHoCH + low-swept = potential reversal entry (smart money accumulated)
- Bearish structure + sweep of highs = avoid (likely distribution)
- fvg: 'bullish' (gap up = potential support zone on pullback) or 'bearish' (gap down = potential resistance)
- Bullish FVG on pullback = potential entry zone. Use as timing refinement, not primary signal.

• rsi: 0-100 (RSI-14, Wilder's smoothing from 40-day bars)
  → <30 = oversold (potential bounce setup if structure bullish)
  → 30-70 = neutral zone
  → >70 = overbought (caution — wait for pullback unless fresh catalyst)
  → RSI + structure together: RSI <30 + bullish CHoCH = high-probability reversal

• sma20: 20-day simple moving average price level
  → Price above SMA20 = uptrend intact
  → Price below SMA20 = trend weakening

• macd: { macd, signal, histogram, crossover: 'bullish'|'bearish'|'none' }
  → MACD(12,26,9) momentum oscillator
  → crossover 'bullish' = MACD crossed above signal (momentum shifting positive)
  → crossover 'bearish' = MACD crossed below signal (momentum fading)
  → histogram: MACD minus signal. Positive = bullish momentum, negative = bearish.
  → Histogram growing = momentum accelerating, shrinking = momentum fading.
  → Even without a crossover, histogram direction tells you momentum trajectory.
  → Use with structure: bullish MACD crossover + bullish BOS = strong confirmation

• marketCap: company market capitalization in dollars (null if unavailable)
  → Use for position sizing context (large cap = more liquid, small cap = more volatile)

• shortInterest: { shortInterest, daysToCover, avgDailyVolume, settlementDate }
  → daysToCover >5 + bullish structure = potential short squeeze candidate
  → daysToCover >3 + catalyst = heightened squeeze potential
  → High short interest adds upside convexity if catalyst triggers covering

• recentNews: [{ title, publishedUtc, sentiment, sentimentReasoning }] (up to 3 recent articles)
  → Machine-scored sentiment from Polygon (positive/negative/neutral)
  → Use as catalyst CLUES — verify important headlines with web search
  → Pre-loaded headlines save you search time; deep dive on the most promising ones

CRITICAL REMINDERS:
• Catalyst is the gate - without it (8+/10), don't trade
• Stock down today WITH strong catalyst = buying opportunity!
• Stock up big today WITHOUT catalyst = probably late
• Balance all factors, but catalyst leads the decision
• Phase 1 handles exits — focus on BUY candidates only

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

3. **Volatility Context** (${vixCache ? 'VIX level pre-loaded above — no search needed' : 'Search: "VIX level today"'})
   • VIX <15 = Complacent
   • VIX 15-20 = Normal
   • VIX 20-30 = Elevated (fear)
   • VIX >30 = Panic

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
                });
                console.log('AI Analysis response:', data);
                if (data.stop_reason === 'max_tokens') {
                    console.warn('⚠️ Phase 2 TRUNCATED — hit max_tokens limit! Response may be incomplete. Consider increasing max_tokens.');
                    addActivity('⚠️ Phase 2 response was truncated — buy analysis may be incomplete.', 'warning');
                }

                // Check for API errors (rate limits, etc.)
                if (data.type === 'error' || data.error) {
                    const errorMessage = data.error?.message || data.message || 'API error occurred';
                    console.error('API error:', errorMessage);

                    if (errorMessage.includes('rate_limit') || data.error?.type === 'rate_limit_error') {
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
                
                // 3. Escape newlines/tabs only inside JSON string values (not between tokens)
                jsonString = escapeNewlinesInJsonStrings(jsonString);
                
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
                            if (d.action === 'BUY') {
                                d.shares = Math.floor(d.shares || 0);
                                if (d.shares < 1) d.shares = 1; // Force minimum 1 share for BUY
                            } else if (d.shares) {
                                d.shares = Math.floor(d.shares);
                            }
                        });
                        
                        thinkingDetail.textContent = `AI analyzed ${decision.decisions.length} opportunity(ies)...`;
                        
                        // Prepend Phase 1 sell + hold decisions to the decision list
                        if (phase1SellDecisions.length > 0 || phase1HoldDecisions.length > 0) {
                            decision.decisions = [...phase1SellDecisions, ...phase1HoldDecisions, ...decision.decisions];
                            if (decision.overall_reasoning) {
                                decision.overall_reasoning = '**Phase 1 - Holdings Review:**\n' + phase1Summary + '\n\n**Phase 2 - New Opportunities:**\n' + decision.overall_reasoning;
                            }
                        }
                        
                        // Execute all trades (sells from Phase 1 + buys from Phase 2)
                        await executeMultipleTrades(decision, enhancedMarketData);
                        
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
                        }, enhancedMarketData);
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

            // Step 2b: Enforce learned trading rules
            const tradingRules = deriveTradingRules();
            const blockRules = tradingRules.rules.filter(r => r.enforcement === 'block');
            if (blockRules.length > 0) {
                buyDecisionsAll = buyDecisionsAll.filter(d => {
                    const data = marketData[d.symbol];
                    for (const rule of blockRules) {
                        if (matchesPattern(rule.id, data)) {
                            const msg = `BLOCKED: ${d.symbol} — ${rule.label} (${rule.winRate.toFixed(0)}% win rate, ${rule.trades} trades)`;
                            console.warn(msg);
                            addActivity(msg, 'warning');
                            // Record blocked trade
                            if (!portfolio.blockedTrades) portfolio.blockedTrades = [];
                            portfolio.blockedTrades.push({
                                symbol: d.symbol,
                                timestamp: new Date().toISOString(),
                                ruleId: rule.id,
                                ruleLabel: rule.label,
                                winRate: rule.winRate,
                                price: data?.price || 0
                            });
                            // Cap at 50 entries
                            while (portfolio.blockedTrades.length > 50) portfolio.blockedTrades.shift();
                            return false;
                        }
                    }
                    return true;
                });
            }

            // Step 3: Now validate BUY budget against ACTUAL post-sell cash
            // Pre-filter: drop buy decisions with invalid share counts
            buyDecisionsAll = buyDecisionsAll.filter(d => {
                if (!d.shares || d.shares <= 0 || !Number.isFinite(d.shares)) {
                    console.warn(`⚠️ Dropping BUY ${d.symbol}: invalid shares (${d.shares})`);
                    return false;
                }
                return true;
            });

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
            if (decision.action === 'BUY' && (!shares || shares <= 0 || !Number.isFinite(shares))) {
                console.error(`❌ Invalid share count (${shares}) for BUY ${symbol} — skipping`);
                addActivity(`❌ Trade skipped for ${symbol}: invalid share count`, 'error');
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
                            todayChange: marketData[symbol].momentum?.todayChange ?? marketData[symbol].changePercent ?? null,
                            totalReturn5d: marketData[symbol].momentum?.totalReturn5d ?? null,
                            isAccelerating: marketData[symbol].momentum?.isAccelerating ?? null,
                            upDays: marketData[symbol].momentum?.upDays ?? null,
                            rsScore: marketData[symbol].relativeStrength?.rsScore || null,
                            sectorRotation: marketData[symbol].sectorRotation?.rotationSignal || null,
                            structureScore: marketData[symbol].marketStructure?.structureScore ?? null,
                            structure: marketData[symbol].marketStructure?.structure || null,
                            choch: marketData[symbol].marketStructure?.choch || null,
                            chochType: marketData[symbol].marketStructure?.chochType || null,
                            bos: marketData[symbol].marketStructure?.bos || null,
                            bosType: marketData[symbol].marketStructure?.bosType || null,
                            sweep: marketData[symbol].marketStructure?.sweep || null,
                            rsi: marketData[symbol].rsi ?? null,
                            macdCrossover: marketData[symbol].macd?.crossover || null,
                            macdHistogram: marketData[symbol].macd?.histogram ?? null,
                            daysToCover: marketData[symbol].shortInterest?.daysToCover ?? null,
                            marketCap: marketData[symbol].marketCap ?? null,
                            compositeScore: null, // populated below from lastCandidateScores
                            vixLevel: vixCache?.level ?? null,
                            vixInterpretation: vixCache?.interpretation ?? null
                        },

                        // Market context at entry
                        entryMarketRegime: portfolio.lastMarketRegime?.regime || null,
                        entryHoldingsCount: Object.keys(portfolio.holdings).length,

                        // Position context
                        positionSizePercent: positionSizePercent,
                        portfolioValueAtEntry: totalPortfolioValue
                    });

                    // Populate compositeScore from lastCandidateScores
                    const txForScore = portfolio.transactions[portfolio.transactions.length - 1];
                    const candidateForTx = (portfolio.lastCandidateScores?.candidates || []).find(c => c.symbol === symbol);
                    if (candidateForTx && txForScore.entryTechnicals) txForScore.entryTechnicals.compositeScore = candidateForTx.compositeScore;

                    const convictionEmoji = conviction >= 9 ? '🔥' : conviction >= 7 ? '💪' : '';
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
                            entrySectorFlow: marketData[symbol].sectorRotation?.moneyFlow || null,
                            entryRSI: marketData[symbol].rsi ?? null,
                            entryMACDCrossover: marketData[symbol].macd?.crossover || null,
                            entryStructure: marketData[symbol].marketStructure?.structure || null,
                            entryDTC: marketData[symbol].shortInterest?.daysToCover ?? null,
                            entryCompositeScore: null,
                            entryVIX: vixCache?.level ?? null,
                            entryVIXInterpretation: vixCache?.interpretation ?? null
                        };
                        const candidateEntry = (portfolio.lastCandidateScores?.candidates || []).find(c => c.symbol === symbol);
                        if (candidateEntry) portfolio.holdingTheses[symbol].entryCompositeScore = candidateEntry.compositeScore;
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
                            sector: stockSectors[symbol] || 'Unknown',
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
                            entryMarketRegime: originalBuyTx.entryMarketRegime || null,
                            entryHoldingsCount: originalBuyTx.entryHoldingsCount || null,

                            // 3. Exit Context
                            exitReason: exitReason,
                            exitReasoning: decision.reasoning || '',
                            exitConviction: decision.conviction || null,
                            exitMarketRegime: portfolio.lastMarketRegime?.regime || null,
                            exitHoldingsCount: Object.keys(portfolio.holdings).length,

                            // 4. Technical Indicators at Exit
                            exitTechnicals: {
                                rsi: marketData[symbol]?.rsi ?? null,
                                macdCrossover: marketData[symbol]?.macd?.crossover || null,
                                macdHistogram: marketData[symbol]?.macd?.histogram ?? null,
                                structure: marketData[symbol]?.marketStructure?.structure || null,
                                structureScore: marketData[symbol]?.marketStructure?.structureScore ?? null,
                                daysToCover: marketData[symbol]?.shortInterest?.daysToCover ?? null,
                                vixLevel: vixCache?.level ?? null,
                                vixInterpretation: vixCache?.interpretation ?? null,
                            },

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

                        // Calculate calendar days held (not elapsed time)
                        const nowDate = new Date();
                        const todayStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate());
                        const buyDayStart = new Date(earliestDate.getFullYear(), earliestDate.getMonth(), earliestDate.getDate());
                        daysHeld = Math.round((todayStart - buyDayStart) / (1000 * 60 * 60 * 24));
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

                    // Get stock name and sector from mappings
                    const stockName = stockNames[symbol] || symbol;
                    const stockSector = stockSectors[symbol] || 'Unknown';

                    // Thesis data (momentum, RS, sector flow at entry)
                    const thesis = (portfolio.holdingTheses || {})[symbol];
                    const entryMomentum = thesis?.entryMomentum;
                    const entryRS = thesis?.entryRS;

                    // Conviction emoji
                    const convictionEmoji = conviction >= 9 ? '🔥' : conviction >= 7 ? '💪' : '';

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
                                    <div class="holding-card-name">${stockName} <span class="holding-card-sector">· ${stockSector}</span></div>
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
                                <span class="text-muted" style="margin-left:8px">| Mtm: <strong>${entryMomentum != null ? entryMomentum.toFixed(1) : '--'}</strong> · RS: <strong>${entryRS != null ? entryRS.toFixed(0) : '--'}</strong>${(() => {
                                    const bars = multiDayCache[symbol];
                                    let rsiStr = '', macdStr = '', dtcStr = '';
                                    if (bars && bars.length >= 14) {
                                        const rsiVal = calculateRSI(bars);
                                        if (rsiVal != null) {
                                            const rc = rsiVal < 30 ? 'rsi-oversold' : rsiVal > 70 ? 'rsi-overbought' : '';
                                            rsiStr = ` · RSI: <strong class="${rc}">${Math.round(rsiVal)}</strong>`;
                                        }
                                        const macdResult = calculateMACD(bars);
                                        if (macdResult) {
                                            let mc, arrow;
                                            if (macdResult.crossover === 'bullish') { mc = 'macd-bullish'; arrow = '▲ Cross'; }
                                            else if (macdResult.crossover === 'bearish') { mc = 'macd-bearish'; arrow = '▼ Cross'; }
                                            else { mc = macdResult.histogram >= 0 ? 'macd-bullish' : 'macd-bearish'; arrow = macdResult.histogram >= 0 ? '▲' : '▼'; }
                                            macdStr = ` · MACD: <strong class="${mc}">${arrow}</strong>`;
                                        }
                                    }
                                    const dtcVal = shortInterestCache[symbol]?.daysToCover;
                                    if (dtcVal && dtcVal > 0) {
                                        const dc = dtcVal > 5 ? 'dtc-squeeze' : dtcVal > 3 ? 'dtc-elevated' : '';
                                        dtcStr = ` · DTC: <strong class="${dc}">${dtcVal.toFixed(1)}</strong>`;
                                    }
                                    return rsiStr + macdStr + dtcStr;
                                })()}</span>
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
                            ${(() => {
                                const articles = newsCache[symbol];
                                if (!articles || articles.length === 0) return '';
                                const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
                                const recent = articles.filter(a => new Date(a.published_utc || a.publishedUtc).getTime() > sevenDaysAgo);
                                if (recent.length === 0) return '';
                                const top2 = recent.slice(0, 2);
                                return '<div class="holding-card-news">' + top2.map(a => {
                                    const title = escapeHtml((a.title || '').length > 90 ? a.title.substring(0, 87) + '...' : a.title || '');
                                    const sent = (a.sentiment || 'neutral').toLowerCase();
                                    const sentClass = sent === 'positive' ? 'positive' : sent === 'negative' ? 'negative' : 'neutral';
                                    const timeAgo = formatTimeAgo(a.published_utc || a.publishedUtc);
                                    return `<div class="news-item"><span class="news-time">${timeAgo}</span><span class="news-title">${title}</span><span class="news-sentiment ${sentClass}">${sent}</span></div>`;
                                }).join('') + '</div>';
                            })()}
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

            // (Thesis Tracker removed — momentum/RS now shown in holdings cards)

            } catch (error) {
                console.error('Error updating UI:', error);
                addActivity('⚠️ Error updating display - some data may be stale. Try refreshing the page.', 'error');
                // Still show what we can
                document.getElementById('portfolioValue').textContent = 'Error';
                document.getElementById('cashValue').textContent = '$' + portfolio.cash.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
            }
        }

        // Add activity
        // Format market cap as human-readable string
        function formatMarketCap(value) {
            if (value == null || value === 0) return '--';
            if (value >= 1e12) return '$' + (value / 1e12).toFixed(1) + 'T';
            if (value >= 1e9) return '$' + (value / 1e9).toFixed(0) + 'B';
            if (value >= 1e6) return '$' + (value / 1e6).toFixed(0) + 'M';
            return '$' + value.toLocaleString();
        }

        // Format ISO date as relative time ago
        function formatTimeAgo(isoDate) {
            if (!isoDate) return '';
            const diff = Date.now() - new Date(isoDate).getTime();
            const hours = Math.floor(diff / 3600000);
            if (hours < 1) return '<1h';
            if (hours < 24) return hours + 'h';
            const days = Math.floor(hours / 24);
            return days + 'd';
        }

        // Escape newlines/tabs inside JSON string values only (not between tokens)
        // Newlines between tokens are valid JSON whitespace and must be preserved.
        function escapeNewlinesInJsonStrings(str) {
            let out = '', inStr = false, esc = false;
            for (let i = 0; i < str.length; i++) {
                const ch = str[i];
                if (esc) { out += ch; esc = false; continue; }
                if (ch === '\\' && inStr) { out += ch; esc = true; continue; }
                if (ch === '"') { inStr = !inStr; out += ch; continue; }
                if (inStr) {
                    if (ch === '\n') { out += '\\n'; continue; }
                    if (ch === '\r') { out += '\\r'; continue; }
                    if (ch === '\t') { out += '\\t'; continue; }
                }
                out += ch;
            }
            return out;
        }

        // Escape HTML entities to prevent XSS from AI/user content
        function escapeHtml(str) {
            if (typeof str !== 'string') return str;
            return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
        }

        // Format AI text for readable HTML (escape first, then apply structure)
        function formatDecisionText(str) {
            if (typeof str !== 'string') return str;
            return escapeHtml(str)
                .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
                .replace(/\n{2,}/g, '</p><p>')
                .replace(/\n/g, '<br>')
                .replace(/^/, '<p>').replace(/$/, '</p>')
                .replace(/([\u{1F300}-\u{1F9FF}])/gu, ' $1 ');
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
                    if (!portfolio.lastVIX) portfolio.lastVIX = null;
                    if (!portfolio.blockedTrades) portfolio.blockedTrades = [];
                    if (!portfolio.tradingRules) portfolio.tradingRules = null;
                    if (!portfolio.holdSnapshots) portfolio.holdSnapshots = [];
                    if (!portfolio.regimeHistory) portfolio.regimeHistory = [];

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
                    
                    // MIGRATION: Fix corrupted performanceHistory values from deposit bug
                    // addWeeklyFunding() previously stored object + number = "[object Object]NNN" as value
                    if (portfolio.performanceHistory && portfolio.performanceHistory.length > 0) {
                        let fixed = 0;
                        for (let i = 0; i < portfolio.performanceHistory.length; i++) {
                            const entry = portfolio.performanceHistory[i];
                            if (typeof entry.value !== 'number' || isNaN(entry.value)) {
                                // Interpolate from nearest valid neighbors
                                const prev = portfolio.performanceHistory.slice(0, i).reverse().find(e => typeof e.value === 'number' && !isNaN(e.value));
                                const next = portfolio.performanceHistory.slice(i + 1).find(e => typeof e.value === 'number' && !isNaN(e.value));
                                if (prev && next) {
                                    entry.value = (prev.value + next.value) / 2;
                                } else if (prev) {
                                    entry.value = prev.value + (entry.deposit || 0);
                                } else if (next) {
                                    entry.value = next.value;
                                } else {
                                    entry.value = portfolio.cash;
                                }
                                fixed++;
                            }
                        }
                        if (fixed > 0) {
                            console.log(`📊 MIGRATION: Fixed ${fixed} corrupted performanceHistory entries`);
                            savePortfolio();
                        }
                    }

                    // Restore data caches so holdings cards show indicators + news on page load
                    try {
                        const mdCache = localStorage.getItem('multiDayCache');
                        const mdTs = parseInt(localStorage.getItem('multiDayCacheTs') || '0');
                        if (mdCache && Date.now() - mdTs < MULTIDAY_CACHE_TTL) multiDayCache = JSON.parse(mdCache);
                    } catch {}
                    try {
                        const siCache = localStorage.getItem('shortInterestCache');
                        const siTs = parseInt(localStorage.getItem('shortInterestCacheTs') || '0');
                        if (siCache && Date.now() - siTs < 24 * 60 * 60 * 1000) shortInterestCache = JSON.parse(siCache);
                    } catch {}
                    try {
                        const nCache = localStorage.getItem('newsCache');
                        const nTs = parseInt(localStorage.getItem('newsCacheTs') || '0');
                        if (nCache && Date.now() - nTs < 60 * 60 * 1000) newsCache = JSON.parse(nCache);
                    } catch {}

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
                    lastSectorRotation: null,
                    holdSnapshots: [],
                    regimeHistory: []
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
                // Display order: SELL → HOLD → BUY (mirrors Phase 1→2 logic: sells first, holds, then buys)
                const actionOrder = { 'SELL': 0, 'HOLD': 1, 'BUY': 2 };
                const sortedDecisions = [...decision.decisions].sort((a, b) =>
                    (actionOrder[a.action] ?? 3) - (actionOrder[b.action] ?? 3)
                );
                // Get warn-level rules for badge display
                const warnRulesForBadges = deriveTradingRules().rules.filter(r => r.enforcement === 'warn' && r.type === 'avoid');

                sortedDecisions.forEach(d => {
                    const isSell = d.action === 'SELL';
                    const isBuy = d.action === 'BUY';

                    const actionClass = isSell ? 'sell' : isBuy ? 'buy' : 'hold';
                    const actionColor = isSell ? '#ef4444' : isBuy ? '#34d399' : '#60a5fa';
                    const actionLabel = isSell ? 'SELL' : isBuy ? 'BUY' : 'HOLD';
                    const actionIcon = isSell ? '📉' : isBuy ? '📈' : '📊';

                    const convictionColor = d.conviction >= 9 ? '#34d399' : d.conviction >= 7 ? '#60a5fa' : '#a8a8a0';
                    const convictionEmoji = d.conviction >= 9 ? '🔥' : d.conviction >= 7 ? '💪' : '';
                    const price = marketData[d.symbol] ? `$${marketData[d.symbol].price.toFixed(2)}` : '';

                    // Check for warn-level pattern matches on BUY decisions
                    let warningBadge = '';
                    if (isBuy && marketData[d.symbol]) {
                        for (const wr of warnRulesForBadges) {
                            if (matchesPattern(wr.id, marketData[d.symbol])) {
                                warningBadge = `<div class="pattern-warning">Matches losing pattern: ${escapeHtml(wr.label)} (${wr.winRate.toFixed(0)}% win rate)</div>`;
                                break;
                            }
                        }
                    }

                    stocksList += `
                        <div class="decision-stock-item ${actionClass}" onclick="this.classList.toggle('expanded')">
                            <div class="decision-stock-item-header">
                                <span class="decision-stock-item-title" style="color: ${actionColor};">
                                    ${actionIcon} ${d.shares ? d.shares + ' ' : ''}${d.symbol}${price ? ' @ ' + price : ''}
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
                            ${warningBadge}
                            <div class="decision-stock-reasoning">
                                ${formatDecisionText(d.reasoning)}
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

                if (options.restored) reasoningCard.classList.add('collapsed');
                reasoningCard.innerHTML = `
                    <div class="decision-card-header" onclick="this.parentElement.classList.toggle('collapsed')">
                        <div>
                            <div class="decision-card-title">APEX's Analysis</div>
                            <div class="decision-card-summary">${picksSummary.join(' · ')}</div>
                        </div>
                        <div class="decision-card-actions">
                            <div class="decision-card-time">${timestamp.toLocaleTimeString()}</div>
                            <span class="decision-expand-icon" style="font-size:14px;margin-left:8px;">&#9662;</span>
                            <button class="decision-save-btn" onclick="event.stopPropagation();saveDecisionReasoning(this)">Save</button>
                        </div>
                    </div>
                    <div class="decision-card-body">
                    ${decision.budgetWarning ? `
                        <div class="budget-warning">${escapeHtml(decision.budgetWarning)}</div>
                    ` : ''}
                    ${stocksList}
                    ${decision.reasoning ? `
                        <div class="decision-thoughts collapsed" onclick="this.classList.toggle('collapsed')">
                            <div class="decision-thoughts-label">
                                <span>APEX's Thoughts</span>
                                <span class="decision-expand-icon">&#9662;</span>
                            </div>
                            <div class="decision-thoughts-text">${formatDecisionText(decision.reasoning)}</div>
                        </div>
                    ` : ''}
                    ${decision.research_summary ? `
                        <div class="research-summary collapsed" onclick="this.classList.toggle('collapsed')">
                            <div class="research-summary-label">
                                <span>Research Summary</span>
                                <span class="decision-expand-icon">&#9662;</span>
                            </div>
                            <div class="research-summary-text">${formatDecisionText(decision.research_summary)}</div>
                        </div>
                    ` : ''}
                    </div>
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
                    <div class="decision-single-reasoning">${formatDecisionText(decision.reasoning)}</div>
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
            const container = document.getElementById('learningInsights');
            const rulesData = deriveTradingRules();

            if (rulesData.rules.length === 0 && (rulesData.summary.insufficientData || rulesData.summary.totalTrades < 3)) {
                container.innerHTML = `<div class="empty-state">Need more trade history to derive rules (${rulesData.summary.totalTrades || 0} trades so far)</div>`;
                return;
            }

            let html = '';
            const s = rulesData.summary;

            // ── Section A: Trading Rules ──
            const blockRules = rulesData.rules.filter(r => r.enforcement === 'block');
            const warnRules = rulesData.rules.filter(r => r.enforcement === 'warn' && r.type === 'avoid');
            const preferRules = rulesData.rules.filter(r => r.type === 'prefer');
            const observeRules = rulesData.rules.filter(r => r.enforcement === 'observe' && r.type !== 'prefer');

            if (rulesData.rules.length > 0) {
                html += `<div class="rules-section">
                    <div class="rules-section-title">What APEX Has Learned</div>
                    <div class="rules-grid">`;

                for (const r of blockRules) {
                    html += `<div class="rule-card rule-block">
                        <div class="rule-card-header">
                            <span class="rule-card-label">${escapeHtml(r.label)}</span>
                            <span class="rule-enforcement-badge rule-badge-block">BLOCKED</span>
                        </div>
                        <div class="rule-card-stats">
                            <span class="rule-stat negative">${r.winRate.toFixed(0)}% win rate</span>
                            <span class="rule-stat">${r.trades} trades</span>
                            <span class="rule-stat">${r.avgReturn >= 0 ? '+' : ''}${r.avgReturn.toFixed(1)}% avg</span>
                        </div>
                        <div class="rule-card-compare">vs ${r.compareWinRate.toFixed(0)}% win rate for opposite (${r.compareTrades} trades)</div>
                    </div>`;
                }

                for (const r of warnRules) {
                    html += `<div class="rule-card rule-warn">
                        <div class="rule-card-header">
                            <span class="rule-card-label">${escapeHtml(r.label)}</span>
                            <span class="rule-enforcement-badge rule-badge-warn">AVOID</span>
                        </div>
                        <div class="rule-card-stats">
                            <span class="rule-stat negative">${r.winRate.toFixed(0)}% win rate</span>
                            <span class="rule-stat">${r.trades} trades</span>
                            <span class="rule-stat">${r.avgReturn >= 0 ? '+' : ''}${r.avgReturn.toFixed(1)}% avg</span>
                        </div>
                        <div class="rule-card-compare">vs ${r.compareWinRate.toFixed(0)}% win rate for opposite (${r.compareTrades} trades)</div>
                    </div>`;
                }

                for (const r of preferRules) {
                    html += `<div class="rule-card rule-prefer">
                        <div class="rule-card-header">
                            <span class="rule-card-label">${escapeHtml(r.label)}</span>
                            <span class="rule-enforcement-badge rule-badge-prefer">WORKING</span>
                        </div>
                        <div class="rule-card-stats">
                            <span class="rule-stat positive">${r.winRate.toFixed(0)}% win rate</span>
                            <span class="rule-stat">${r.trades} trades</span>
                            <span class="rule-stat">${r.avgReturn >= 0 ? '+' : ''}${r.avgReturn.toFixed(1)}% avg</span>
                        </div>
                        <div class="rule-card-compare">vs ${r.compareWinRate.toFixed(0)}% overall (${r.compareTrades} trades)</div>
                    </div>`;
                }

                for (const r of observeRules) {
                    if (r.needsData) {
                        html += `<div class="rule-card rule-observe">
                            <div class="rule-card-header">
                                <span class="rule-card-label">${escapeHtml(r.label)}</span>
                                <span class="rule-enforcement-badge rule-badge-observe">NEED DATA</span>
                            </div>
                            <div class="rule-card-compare">${escapeHtml(r.description)}</div>
                        </div>`;
                    } else {
                        html += `<div class="rule-card rule-observe">
                            <div class="rule-card-header">
                                <span class="rule-card-label">${escapeHtml(r.label)}</span>
                                <span class="rule-enforcement-badge rule-badge-observe">WATCHING</span>
                            </div>
                            <div class="rule-card-stats">
                                <span class="rule-stat">${r.winRate.toFixed(0)}% win rate</span>
                                <span class="rule-stat">${r.trades} trades</span>
                                <span class="rule-stat">${r.avgReturn >= 0 ? '+' : ''}${r.avgReturn.toFixed(1)}% avg</span>
                            </div>
                            <div class="rule-card-compare">vs ${r.compareWinRate.toFixed(0)}% for opposite (${r.compareTrades} trades)</div>
                        </div>`;
                    }
                }

                html += `</div></div>`;
            }

            // ── Section B: Performance Summary ──
            if (s.totalTrades >= 3) {
                const closedTradesAll = portfolio.closedTrades || [];
                const totalGains = closedTradesAll.filter(t => t.profitLoss > 0).reduce((sum, t) => sum + t.profitLoss, 0);
                const totalLosses = Math.abs(closedTradesAll.filter(t => t.profitLoss <= 0).reduce((sum, t) => sum + t.profitLoss, 0));
                const profitFactor = totalLosses > 0 ? totalGains / totalLosses : totalGains > 0 ? Infinity : 0;
                const pfColor = profitFactor >= 2 ? 'var(--green)' : profitFactor >= 1 ? 'var(--accent-light)' : 'var(--red)';
                const trendLabel = s.recentTrend === 'improving' ? 'Improving' : s.recentTrend === 'declining' ? 'Declining' : 'Steady';
                const trendColor = s.recentTrend === 'improving' ? 'var(--green)' : s.recentTrend === 'declining' ? 'var(--red)' : 'var(--text-muted)';

                html += `<div class="analytics-panel">
                    <div class="analytics-panel-title">Performance Summary</div>
                    <div class="insight-panel-body">
                        <div class="rr-stats-row">
                            <div class="rr-stat">
                                <div class="rr-stat-value">${s.wins}W-${s.losses}L</div>
                                <div class="rr-stat-label">Record (${s.winRate.toFixed(0)}%)</div>
                            </div>
                            <div class="rr-stat">
                                <div class="rr-stat-value positive">+${s.avgWin.toFixed(1)}%</div>
                                <div class="rr-stat-label">Avg Win (${s.avgWinDays.toFixed(1)}d)</div>
                            </div>
                            <div class="rr-stat">
                                <div class="rr-stat-value negative">${s.avgLoss.toFixed(1)}%</div>
                                <div class="rr-stat-label">Avg Loss (${s.avgLossDays.toFixed(1)}d)</div>
                            </div>
                            <div class="rr-stat">
                                <div class="rr-stat-value" style="color: ${pfColor};">${profitFactor === Infinity ? '∞' : profitFactor.toFixed(2)}</div>
                                <div class="rr-stat-label">Profit Factor</div>
                            </div>
                            <div class="rr-stat">
                                <div class="rr-stat-value" style="color: ${trendColor};">${s.recentWins}W-${s.recentLosses}L</div>
                                <div class="rr-stat-label">Recent (${trendLabel})</div>
                            </div>
                        </div>
                    </div>
                </div>`;
            }

            // ── Section C: Blocked Trades ──
            const blockedTrades = portfolio.blockedTrades || [];
            if (blockedTrades.length > 0) {
                html += `<div class="analytics-panel">
                    <div class="analytics-panel-title">Blocked Trades</div>
                    <div class="insight-panel-body">
                        <div class="blocked-trades-list">`;
                // Show most recent first, up to 10
                const recentBlocked = blockedTrades.slice(-10).reverse();
                for (const bt of recentBlocked) {
                    const timeAgo = formatTimeAgo(bt.timestamp);
                    html += `<div class="blocked-trade-row">
                        <span class="blocked-trade-symbol">${escapeHtml(bt.symbol)}</span>
                        <span class="blocked-trade-rule">${escapeHtml(bt.ruleLabel)}</span>
                        <span class="blocked-trade-stat">${bt.winRate.toFixed(0)}% win rate</span>
                        <span class="blocked-trade-time">${timeAgo}</span>
                    </div>`;
                }
                html += `</div></div></div>`;
            }

            // ── Section D: Hold Decision Accuracy ──
            const holdStats = analyzeHoldAccuracy();
            if (holdStats) {
                const accColor = holdStats.overall.accuracy >= 60 ? 'var(--green)' : holdStats.overall.accuracy >= 45 ? 'var(--yellow)' : 'var(--red)';
                const avgColor = holdStats.overall.avgChange >= 0 ? 'var(--green)' : 'var(--red)';

                html += `<div class="analytics-panel">
                    <div class="analytics-panel-title">Hold Decision Accuracy</div>
                    <div class="insight-panel-body">
                        <div class="rr-stats-row">
                            <div class="rr-stat">
                                <div class="rr-stat-value" style="color: ${accColor};">${holdStats.overall.accuracy.toFixed(0)}%</div>
                                <div class="rr-stat-label">Correct (${holdStats.overall.total} holds)</div>
                            </div>
                            <div class="rr-stat">
                                <div class="rr-stat-value" style="color: ${avgColor};">${holdStats.overall.avgChange >= 0 ? '+' : ''}${holdStats.overall.avgChange.toFixed(2)}%</div>
                                <div class="rr-stat-label">Avg Next-Cycle Change</div>
                            </div>`;

                for (const [bucket, label] of [['high', 'High Conv'], ['medium', 'Med Conv'], ['low', 'Low Conv']]) {
                    if (holdStats.byConviction[bucket]) {
                        const bc = holdStats.byConviction[bucket];
                        const bColor = bc.accuracy >= 60 ? 'var(--green)' : bc.accuracy >= 45 ? 'var(--yellow)' : 'var(--red)';
                        html += `<div class="rr-stat">
                                <div class="rr-stat-value" style="color: ${bColor};">${bc.accuracy.toFixed(0)}%</div>
                                <div class="rr-stat-label">${label} (${bc.total})</div>
                            </div>`;
                    }
                }

                html += `</div></div></div>`;
            }

            // ── Section E: Regime History ──
            const regimeStats = analyzeRegimeTransitions();
            if (regimeStats) {
                const regimeColors = { bull: 'var(--green)', bear: 'var(--red)', choppy: 'var(--yellow)' };
                const regimeLabels = { bull: 'BULL', bear: 'BEAR', choppy: 'CHOPPY' };
                const curColor = regimeColors[regimeStats.current] || 'var(--text-muted)';

                html += `<div class="analytics-panel">
                    <div class="analytics-panel-title">Regime History</div>
                    <div class="insight-panel-body">
                        <div class="rr-stats-row">
                            <div class="rr-stat">
                                <div class="rr-stat-value" style="color: ${curColor};">${regimeLabels[regimeStats.current] || regimeStats.current.toUpperCase()}</div>
                                <div class="rr-stat-label">Current (${regimeStats.durationDays}d)</div>
                            </div>
                            <div class="rr-stat">
                                <div class="rr-stat-value">${regimeStats.transitionCount}</div>
                                <div class="rr-stat-label">Transitions</div>
                            </div>
                            <div class="rr-stat">
                                <div class="rr-stat-value">${regimeStats.avgFrequencyDays}d</div>
                                <div class="rr-stat-label">Avg Between</div>
                            </div>`;

                if (regimeStats.nearTransition && regimeStats.overallWinRate !== null) {
                    const ntColor = regimeStats.nearTransition.winRate < regimeStats.overallWinRate ? 'var(--red)' : 'var(--green)';
                    html += `<div class="rr-stat">
                                <div class="rr-stat-value" style="color: ${ntColor};">${regimeStats.nearTransition.winRate.toFixed(0)}%</div>
                                <div class="rr-stat-label">Near-Shift WR (${regimeStats.nearTransition.total})</div>
                            </div>`;
                }

                html += `</div>`;

                // Timeline of recent transitions
                if (regimeStats.recentTransitions.length > 1) {
                    html += `<div class="regime-timeline">`;
                    for (const t of regimeStats.recentTransitions.reverse()) {
                        const dotColor = regimeColors[t.regime] || 'var(--text-muted)';
                        const fromLabel = t.from ? `${regimeLabels[t.from] || t.from} →` : '';
                        html += `<div class="regime-timeline-entry">
                            <span class="regime-dot" style="background: ${dotColor};"></span>
                            <span>${fromLabel} ${regimeLabels[t.regime] || t.regime}</span>
                            <span class="regime-transition-stats">${t.daysAgo === 0 ? 'today' : t.daysAgo + 'd ago'}</span>
                        </div>`;
                    }
                    html += `</div>`;
                }

                html += `</div></div>`;
            }

            // ── Section F: Conviction Accuracy ──
            const convictionData = analyzeConvictionAccuracy();
            if (convictionData.hasData) {
                html += `<div class="analytics-panel">
                    <div class="analytics-panel-title">Conviction Calibration</div>
                    <div class="insight-panel-body">
                        <div class="rr-stats-row">`;
                for (const [level, stats] of Object.entries(convictionData.analysis)) {
                    const wrColor = stats.winRate >= 60 ? 'var(--green)' : stats.winRate >= 40 ? 'var(--yellow)' : 'var(--red)';
                    const calLabel = stats.calibration === 'well-calibrated' ? 'Calibrated' : 'Overconfident';
                    const calColor = stats.calibration === 'well-calibrated' ? 'var(--green)' : 'var(--red)';
                    html += `<div class="rr-stat">
                            <div class="rr-stat-value" style="color: ${wrColor};">${stats.winRate.toFixed(0)}%</div>
                            <div class="rr-stat-label">Conv ${level} (${stats.count})</div>
                            <div class="rr-stat-label" style="color: ${calColor}; font-size: 10px;">${calLabel} · ${stats.avgReturn >= 0 ? '+' : ''}${stats.avgReturn.toFixed(1)}%</div>
                        </div>`;
                }
                html += `</div></div></div>`;
            }

            // ── Section G: Signal Accuracy ──
            const techData = analyzeTechnicalAccuracy();
            if (techData.hasData) {
                html += `<div class="analytics-panel">
                    <div class="analytics-panel-title">Signal Accuracy</div>
                    <div class="insight-panel-body">
                        <table class="signal-accuracy-table">
                            <thead><tr>
                                <th>Signal</th><th>Condition</th><th>Win Rate</th><th>Avg Return</th><th>Trades</th>
                            </tr></thead><tbody>`;

                const addRow = (signal, label, stats) => {
                    if (!stats) return;
                    const wrColor = stats.winRate >= 60 ? 'var(--green)' : stats.winRate >= 40 ? 'var(--yellow)' : 'var(--red)';
                    const retColor = stats.avgReturn >= 0 ? 'var(--green)' : 'var(--red)';
                    html += `<tr>
                        <td>${signal}</td>
                        <td>${label}</td>
                        <td style="color: ${wrColor}; font-weight: 600;">${stats.winRate.toFixed(0)}%</td>
                        <td style="color: ${retColor};">${stats.avgReturn >= 0 ? '+' : ''}${stats.avgReturn.toFixed(1)}%</td>
                        <td>${stats.count}</td>
                    </tr>`;
                };

                addRow('Momentum', 'High (≥7)', techData.momentum.high);
                addRow('Momentum', 'Low (<7)', techData.momentum.low);
                addRow('Rel. Strength', 'High (≥70)', techData.relativeStrength.high);
                addRow('Rel. Strength', 'Low (<70)', techData.relativeStrength.low);
                addRow('Sector Flow', 'Inflow', techData.sectorRotation.inflow);
                addRow('Sector Flow', 'Outflow', techData.sectorRotation.outflow);
                if (techData.rsi.hasData) {
                    addRow('RSI', 'Oversold (<30)', techData.rsi.oversold);
                    addRow('RSI', 'Neutral', techData.rsi.neutral);
                    addRow('RSI', 'Overbought (>70)', techData.rsi.overbought);
                }
                if (techData.macd.hasData) {
                    addRow('MACD', 'Bullish cross', techData.macd.bullish);
                    addRow('MACD', 'Bearish cross', techData.macd.bearish);
                    addRow('MACD', 'No cross', techData.macd.none);
                }
                if (techData.structure.hasData) {
                    addRow('Structure', 'Bullish', techData.structure.bullish);
                    addRow('Structure', 'Bearish', techData.structure.bearish);
                    addRow('Structure', 'CHoCH', techData.structure.choch);
                    addRow('Structure', 'BOS', techData.structure.bos);
                }
                if (techData.runners.hasData) {
                    addRow('Entry Type', 'Non-runner (<5%)', techData.runners.nonRunners);
                    addRow('Entry Type', 'Runner (≥5%)', techData.runners.runners);
                    addRow('Entry Type', 'Big runner (≥10%)', techData.runners.bigRunners);
                }
                if (techData.squeeze.hasData) {
                    addRow('Short Squeeze', 'High DTC (>5)', techData.squeeze.high);
                    addRow('Short Squeeze', 'Moderate (3-5)', techData.squeeze.moderate);
                    addRow('Short Squeeze', 'Low DTC (<3)', techData.squeeze.low);
                }
                if (techData.compositeScore.hasData) {
                    addRow('Composite', 'High (≥15)', techData.compositeScore.high);
                    addRow('Composite', 'Medium (10-15)', techData.compositeScore.medium);
                    addRow('Composite', 'Low (<10)', techData.compositeScore.low);
                }
                if (techData.regime.hasData) {
                    addRow('Regime', 'Bull', techData.regime.bull);
                    addRow('Regime', 'Bear', techData.regime.bear);
                    addRow('Regime', 'Choppy', techData.regime.choppy);
                }
                if (techData.sizing.hasData) {
                    addRow('Position Size', 'Large (≥15%)', techData.sizing.big);
                    addRow('Position Size', 'Small (<15%)', techData.sizing.small);
                }
                if (techData.concentration.hasData) {
                    addRow('Portfolio', 'Concentrated (≤3)', techData.concentration.concentrated);
                    addRow('Portfolio', 'Diversified (>3)', techData.concentration.diversified);
                }
                if (techData.vix.hasData) {
                    addRow('VIX', 'Complacent (<15)', techData.vix.complacent);
                    addRow('VIX', 'Normal (15-20)', techData.vix.normal);
                    addRow('VIX', 'Elevated (20-30)', techData.vix.elevated);
                    addRow('VIX', 'Panic (>30)', techData.vix.panic);
                }

                html += `</tbody></table></div></div>`;
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
                const data = await fetchAnthropicStreaming({
                        model: 'claude-sonnet-4-5-20250929',
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
                });
                console.log('Chat response data:', data);

                // Check for API errors (rate limits, etc.)
                if (data.type === 'error' || data.error) {
                    const errorMessage = data.error?.message || data.message || 'API error occurred';
                    console.error('API error in chat:', errorMessage);

                    removeTypingIndicator();

                    if (errorMessage.includes('rate_limit') || data.error?.type === 'rate_limit_error') {
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

            let desc = '';
            if (regime.includes('bull')) {
                banner.classList.add('bull');
                labelEl.textContent = 'BULL MARKET';
                desc = 'Aggressive deployment — favor momentum, full sizing';
            } else if (regime.includes('bear')) {
                banner.classList.add('bear');
                labelEl.textContent = 'BEAR MARKET';
                desc = 'Defensive posture — preserve cash, tight stops';
            } else {
                banner.classList.add('choppy');
                labelEl.textContent = 'CHOPPY / MIXED';
                desc = 'Selective entries only — smaller positions';
            }

            // Append recent transition info if available
            const history = portfolio.regimeHistory || [];
            if (history.length >= 2) {
                const latest = history[history.length - 1];
                const daysAgo = Math.round((Date.now() - new Date(latest.timestamp).getTime()) / (24 * 60 * 60 * 1000));
                if (daysAgo <= 14 && latest.from) {
                    desc += ` — Changed from ${latest.from} ${daysAgo === 0 ? 'today' : daysAgo + 'd ago'}`;
                }
            }
            descEl.textContent = desc;

            if (data.timestamp) {
                timeEl.textContent = 'Last detected: ' + new Date(data.timestamp).toLocaleString();
            }

            // VIX display
            const vixEl = document.getElementById('regimeVIX');
            if (vixEl) {
                const vix = portfolio.lastVIX;
                if (vix && vix.level != null) {
                    const sign = vix.change >= 0 ? '+' : '';
                    vixEl.textContent = `VIX ${vix.level.toFixed(1)} (${sign}${vix.change.toFixed(2)})`;
                    vixEl.className = 'regime-vix';
                    if (vix.interpretation === 'complacent') vixEl.classList.add('vix-low');
                    else if (vix.interpretation === 'normal') vixEl.classList.add('vix-normal');
                    else if (vix.interpretation === 'elevated') vixEl.classList.add('vix-elevated');
                    else if (vix.interpretation === 'panic') vixEl.classList.add('vix-panic');
                    vixEl.title = `${vix.interpretation}, ${vix.trend} trend`;
                } else {
                    vixEl.textContent = '';
                    vixEl.className = 'regime-vix';
                }
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
                '<th>#</th><th>Symbol</th><th>Score</th><th>Day</th><th>Mom</th><th>RS</th><th>RSI</th><th>MACD</th><th>Sector</th><th>Structure</th><th>DTC</th><th>MCap</th>' +
                '</tr></thead><tbody>';

            data.candidates.forEach((c, i) => {
                const score = c.compositeScore;
                const scoreClass = score >= 15 ? 'score-high' : score >= 10 ? 'score-mid' : score >= 5 ? 'score-low' : 'score-poor';
                const pct = Math.max(0, Math.min(100, (score / maxScore) * 100));
                const held = holdingSymbols.has(c.symbol);
                const structLabel = (c.structure || 'unknown').replace(/_/g, ' ');
                const dayChg = c.dayChange || 0;
                const dayClass = dayChg > 0 ? 'positive' : dayChg < 0 ? 'negative' : '';

                const name = stockNames[c.symbol] || '';
                const rsiVal = c.rsi;
                const rsiClass = rsiVal != null ? (rsiVal < 30 ? 'rsi-oversold' : rsiVal > 70 ? 'rsi-overbought' : '') : '';
                const macdCross = c.macdCrossover || 'none';
                let macdHist = c.macdHistogram;
                // Fallback: compute from cached bars if histogram wasn't persisted (old data)
                if (macdHist == null && multiDayCache[c.symbol]) {
                    const liveMACD = calculateMACD(multiDayCache[c.symbol]);
                    if (liveMACD) { macdHist = liveMACD.histogram; }
                }
                let macdArrow, macdClass;
                if (macdCross === 'bullish') { macdArrow = '▲ Cross'; macdClass = 'macd-bullish'; }
                else if (macdCross === 'bearish') { macdArrow = '▼ Cross'; macdClass = 'macd-bearish'; }
                else if (macdHist != null) { macdArrow = macdHist >= 0 ? '▲' : '▼'; macdClass = macdHist >= 0 ? 'macd-bullish' : 'macd-bearish'; }
                else { macdArrow = '--'; macdClass = 'macd-neutral'; }
                const dtcVal = c.daysToCover || 0;
                const dtcClass = dtcVal > 5 ? 'dtc-squeeze' : dtcVal > 3 ? 'dtc-elevated' : '';

                html += `<tr>
                    <td class="scorecard-rank">${i + 1}</td>
                    <td><span class="scorecard-symbol">${c.symbol}</span>${held ? '<span class="scorecard-held-badge">HELD</span>' : ''}${name ? `<div style="font-size:10px;color:var(--text-muted);margin-top:1px">${name}</div>` : ''}</td>
                    <td><div class="scorecard-score-cell"><div class="scorecard-bar"><div class="scorecard-bar-fill ${scoreClass}" style="width:${pct}%"></div></div><span class="scorecard-score-num ${scoreClass}">${score.toFixed(1)}</span></div></td>
                    <td class="${dayClass}" style="font-size:11px">${dayChg >= 0 ? '+' : ''}${dayChg.toFixed(2)}%</td>
                    <td>${(c.momentum || 0).toFixed(1)}</td>
                    <td>${(c.rs || 0).toFixed(0)}</td>
                    <td class="${rsiClass}">${rsiVal != null ? Math.round(rsiVal) : '--'}</td>
                    <td class="${macdClass}">${macdArrow}</td>
                    <td>${c.sector || '--'}</td>
                    <td style="font-size:10px;text-transform:capitalize">${structLabel}</td>
                    <td class="${dtcClass}">${dtcVal > 0 ? dtcVal.toFixed(1) : '--'}</td>
                    <td class="mcap-cell">${formatMarketCap(c.marketCap)}</td>
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
