const express = require('express');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();

chromium.use(stealth);

const app = express();
const PORT = 3000;
const CONFIG = require('./config');
const worker = require('./bot/worker');
const { runFullSequence } = require('./data/runFullSequence');

const SESSION_FILE = CONFIG.SESSION_FILE;
const USER_DATA_DIR = CONFIG.USER_DATA_DIR;

app.use(express.json());
app.use('/static', express.static(path.join(__dirname, 'public_html')));

let browserContext = null;
let mainPage = null;
let isProcessing = false;
let currentOrder = null;
let lastQR = null;

let profile = {
    avatar: '',
    username: 'Unknown',
    displayName: 'User',
    coins: '0',
    status: 'Disconnected',
    step: 'idle',
    message: 'Waiting for orders...'
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function launchBrowser() {
    console.log('🚀 Launching TikTok V13 Master Browser...');
    const launchOptions = {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--window-size=1280,800',
        ]
    };

    if (fs.existsSync(SESSION_FILE)) {
        launchOptions.storageState = SESSION_FILE;
    }

    const proxy = CONFIG.PROXIES[0];
    if (proxy) {
        launchOptions.proxy = {
            server: proxy.server,
            username: proxy.username,
            password: proxy.password
        };
    }

    browserContext = await chromium.launchPersistentContext(USER_DATA_DIR, launchOptions);
    mainPage = browserContext.pages()[0] || await browserContext.newPage();
    mainPage.setDefaultTimeout(30000);
    console.log('✅ Browser Ready');
    updateProfileData();
}

async function updateProfileData() {
    try {
        profile.status = 'Checking...';
        await mainPage.goto('https://www.tiktok.com/foryou', { waitUntil: 'networkidle', timeout: 30000 });
        
        const loggedIn = await mainPage.evaluate(() => {
            const avatar = document.querySelector('[data-e2e="user-avatar"] img, .user-avatar img');
            const username = document.querySelector('[data-e2e="user-title"], .user-username');
            const displayName = document.querySelector('[data-e2e="user-subtitle"], .user-nickname');
            if (!avatar) return null;
            return {
                avatar: avatar.src,
                username: username ? username.innerText.trim() : 'Unknown',
                displayName: displayName ? displayName.innerText.trim() : 'User'
            };
        });

        if (loggedIn) {
            profile = { ...profile, ...loggedIn, status: 'Connected' };
            await mainPage.goto('https://www.tiktok.com/coin', { waitUntil: 'networkidle' });
            profile.coins = await mainPage.evaluate(() => {
                const el = document.querySelector('[data-e2e="wallet-current-balance"], .wallet-coins-balance');
                return el ? el.innerText.trim() : '0';
            });
        } else {
            profile.status = 'Login Required';
        }
    } catch (e) {
        profile.status = 'Error: ' + e.message;
    }
}

async function handleQRLogin() {
    profile.step = 'login_required';
    profile.message = 'Generating QR Code...';
    await mainPage.goto('https://www.tiktok.com/login/qrcode', { waitUntil: 'networkidle' });
    
    await mainPage.waitForSelector('canvas', { timeout: 15000 });
    const qrElement = await mainPage.locator('canvas').first();
    const qrPath = path.join(__dirname, 'public_html', 'tiktok_qr.png');
    await qrElement.screenshot({ path: qrPath });
    lastQR = '/static/tiktok_qr.png?t=' + Date.now();
    
    profile.step = 'qr_ready';
    profile.message = 'Please scan the QR code on your phone';
    
    // Polling for login success
    for (let i = 0; i < 60; i++) {
        const authenticated = await mainPage.evaluate(() => !window.location.href.includes('login'));
        if (authenticated) {
            await browserContext.storageState({ path: SESSION_FILE });
            await updateProfileData();
            return true;
        }
        await sleep(2000);
    }
    return false;
}

async function pollOrders() {
    setInterval(async () => {
        if (isProcessing) return;
        
        const order = await worker.getPendingOrder();
        if (!order) return;
        
        isProcessing = true;
        currentOrder = order;
        profile.message = `Processing Order: ${order.order_id}`;
        
        try {
            await worker.updateOrder(order, { status: 'processing', payment_step: 'checking_session' });
            
            if (profile.status !== 'Connected') {
                const success = await handleQRLogin();
                if (!success) throw new Error('Login Timeout');
            }
            
            // Start Sequence
            const result = await runFullSequence({
                page: mainPage,
                CONFIG,
                CARD_FILE: CONFIG.CARD_FILE,
                sleep,
                log: (m) => { profile.message = m; console.log(m); },
                warn: console.warn,
                err: console.error,
                takeScreenshot: async (name) => {
                    await mainPage.screenshot({ path: path.join(__dirname, 'public_html', `${name}.png`) });
                },
                clickOne: async (sels, name) => {
                    for (const s of sels) {
                        if (await mainPage.isVisible(s)) {
                            await mainPage.click(s);
                            return true;
                        }
                    }
                    return false;
                },
                getState: () => ({
                    setStep: (s) => { profile.step = s; },
                    setProgress: (m) => { profile.message = m; },
                    setPaymentStep: async (ps) => { await worker.updateOrder(order, { payment_step: ps }); }
                })
            });
            
            if (result.success) {
                await worker.completeOrder(order);
            } else {
                await worker.failOrder(order, { message: result.message });
            }
            
        } catch (e) {
            profile.message = 'Error: ' + e.message;
            await worker.failOrder(order, { message: e.message });
        } finally {
            isProcessing = false;
            currentOrder = null;
            await updateProfileData();
        }
    }, 5000);
}

app.get('/api/status', (req, res) => {
    res.json({ profile, isProcessing, currentOrder, lastQR });
});

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TikTok V13 Master Dashboard</title>
    <link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;700&display=swap" rel="stylesheet">
    <style>
        :root { --bg: #0b0b0b; --card: #161616; --primary: #fe2c55; --secondary: #25f4ee; --text: #fff; }
        body { background: var(--bg); color: var(--text); font-family: 'Tajawal', sans-serif; padding: 20px; }
        .container { max-width: 800px; margin: 0 auto; }
        .card { background: var(--card); border-radius: 20px; padding: 25px; margin-bottom: 20px; border: 1px solid #333; }
        .flex { display: flex; align-items: center; gap: 20px; }
        .avatar { width: 100px; height: 100px; border-radius: 50%; border: 4px solid var(--primary); background: #333; }
        .badge { padding: 6px 15px; border-radius: 20px; font-size: 14px; font-weight: bold; }
        .online { background: rgba(0,255,127,0.1); color: #00ff7f; }
        .offline { background: rgba(255,69,0,0.1); color: #ff4500; }
        .coins { font-size: 50px; color: #ffd700; font-weight: bold; text-align: center; }
        .qr-box { text-align: center; padding: 20px; background: #fff; border-radius: 15px; margin-top: 20px; display: none; }
        .qr-box img { max-width: 250px; }
        .log-box { background: #000; padding: 15px; border-radius: 10px; font-family: monospace; color: #0f0; height: 100px; overflow-y: auto; font-size: 13px; }
        .step-info { color: var(--secondary); font-weight: bold; margin-bottom: 10px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="card flex">
            <img id="avatar" class="avatar" src="" alt="">
            <div>
                <h1 id="name">TikTok Bot V13</h1>
                <p id="user" style="color:#888">@username</p>
                <span id="status" class="badge offline">Disconnected</span>
            </div>
        </div>

        <div class="card">
            <p style="text-align:center; color:#888">الرصيد الحالي</p>
            <div id="coins" class="coins">0</div>
            <p style="text-align:center">عملة TikTok</p>
        </div>

        <div id="qrSection" class="card" style="display:none">
            <h3 style="text-align:center; margin-bottom:15px">يجب تسجيل الدخول</h3>
            <div class="qr-box" style="display:block">
                <img id="qrImg" src="" alt="QR Code">
                <p style="color:#000; margin-top:10px">امسح الكود من تطبيق تيك توك</p>
            </div>
        </div>

        <div class="card">
            <div class="step-info" id="stepInfo">الحالة: انتظار...</div>
            <div class="log-box" id="logBox">البوت جاهز للعمل...</div>
        </div>
    </div>

    <script>
        async function update() {
            const res = await fetch('/api/status');
            const data = await res.json();
            
            document.getElementById('avatar').src = data.profile.avatar || 'https://www.tiktok.com/favicon.ico';
            document.getElementById('name').innerText = data.profile.displayName;
            document.getElementById('user').innerText = '@' + data.profile.username;
            document.getElementById('coins').innerText = data.profile.coins;
            
            const status = document.getElementById('status');
            status.innerText = data.profile.status;
            status.className = 'badge ' + (data.profile.status === 'Connected' ? 'online' : 'offline');
            
            document.getElementById('stepInfo').innerText = 'الخطوة الحالية: ' + data.profile.step;
            const logBox = document.getElementById('logBox');
            if (logBox.lastChild?.innerText !== data.profile.message) {
                const p = document.createElement('p');
                p.innerText = '> ' + data.profile.message;
                logBox.appendChild(p);
                logBox.scrollTop = logBox.scrollHeight;
            }

            if (data.profile.step === 'qr_ready' || data.profile.step === 'login_required') {
                document.getElementById('qrSection').style.display = 'block';
                if (data.lastQR) document.getElementById('qrImg').src = data.lastQR;
            } else {
                document.getElementById('qrSection').style.display = 'none';
            }
        }
        setInterval(update, 2000);
        update();
    </script>
</body>
</html>
    `);
});

launchBrowser().then(() => {
    pollOrders();
    app.listen(PORT, () => {
        console.log(`✅ V13 Master Dashboard on http://localhost:${PORT}`);
    });
});
