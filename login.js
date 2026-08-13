// ═══════════════════════════════════════════════════════════════════
//  TikTok Coins Auto-Payment Bot — v8 (HARDENED / NO-DUPLICATE)
//
//  CRITICAL SAFETY ARCHITECTURE (v8):
//  ─────────────────────────────────────────────────────────────
//  1. PID LOCKFILE  → impossible to run 2 instances simultaneously
//  2. ATOMIC CLAIM  → order status → "processing" the moment it's
//                     pulled, so no other instance can ever grab it
//  3. ONE-TRY RULE  → each order gets EXACTLY ONE payment attempt.
//                     Failed? Marked "failed" forever. The user
//                     must re-confirm the order themselves.
//  4. STEP FAILURE  → any step failing HALTS the whole sequence;
//                     it can NEVER fall through to "Pay"
//  5. PRE-PAY CHECK → the bot verifies card fields are actually
//                     filled before it dares to press Pay
//  6. POST-PAY CHECK→ success is confirmed via success screen,
//                     not assumed
//  7. GRACEFUL EXIT → SIGTERM closes browser + removes lockfile
//  ═══════════════════════════════════════════════════════════════════

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const CONFIG = require("./config");
const worker = require("./bot/worker");
const cards = require("./bot/cardsManager");
const { runFullSequence } = require("./data/runFullSequence");

chromium.use(stealth);

// ── Constants ──
const PORT = 3000;
const LOCKFILE = "/tmp/tiktok-bot.lock";
const SESSION_FILE = CONFIG.SESSION_FILE;
const CARD_FILE = CONFIG.CARD_FILE;
const USER_DATA_DIR = path.join(__dirname, CONFIG.USER_DATA_DIR);
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
const PUBLIC_DIR = path.join(__dirname, 'public_html');

// ── State ──
let page = null;
let context = null;
let isRunning = false;
let currentStep = 0;
let progressMsg = 'Waiting for start...';
let shutdownRequested = false;

// ═══ Track processed order IDs so they are NEVER re-processed ═══
const processedOrderIds = new Set();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

function log(msg) { console.log(`[${ts()}] ${msg}`); }
function warn(msg) { console.warn(`[${ts()}] ⚠️ ${msg}`); }
function err(msg, e) {
    console.error(`[${ts()}] ❌ ${msg}`);
    if (e) console.error(`   ${e.message}`);
}

// ═══════════════════════════════════════════════════════════════════
//  PID LOCKFILE — prevent multiple instances at the OS level
// ═══════════════════════════════════════════════════════════════════

function acquireLock() {
    try {
        if (fs.existsSync(LOCKFILE)) {
            const pid = parseInt(fs.readFileSync(LOCKFILE, 'utf8').trim(), 10);
            if (pid && isPidAlive(pid)) {
                console.error(`🚫 FATAL: Another instance is already running (PID ${pid}).`);
                console.error(`   Kill it first:  kill -9 ${pid}`);
                console.error(`   Or:  rm ${LOCKFILE}   (only if no instance is running)`);
                process.exit(1);
            }
            warn(`Stale lockfile found (PID ${pid} dead) — removing`);
            fs.unlinkSync(LOCKFILE);
        }
        fs.writeFileSync(LOCKFILE, String(process.pid));
        log(`🔒 Lock acquired: PID ${process.pid} → ${LOCKFILE}`);
    } catch (e) {
        console.error(`🚫 FATAL: Could not create lockfile: ${e.message}`);
        process.exit(1);
    }
}

function releaseLock() {
    try {
        if (fs.existsSync(LOCKFILE)) {
            const pid = parseInt(fs.readFileSync(LOCKFILE, 'utf8').trim(), 10);
            if (pid === process.pid) {
                fs.unlinkSync(LOCKFILE);
                log(`🔓 Lock released`);
            }
        }
    } catch {}
}

function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

process.on('SIGINT', () => { shutdownRequested = true; gracefulExit(); });
process.on('SIGTERM', () => { shutdownRequested = true; gracefulExit(); });
process.on('uncaughtException', (e) => {
    err('Uncaught exception', e);
    gracefulExit();
});

async function gracefulExit() {
    log('🛑 Shutting down gracefully...');
    if (context) {
        try { await context.storageState({ path: SESSION_FILE }); } catch {}
        try { await context.close(); } catch {}
    }
    releaseLock();
    log('✅ Bot stopped cleanly. No orphan processes.');
    process.exit(0);
}

// ═══════════════════════════════════════════════════════════════════
//  EXPRESS SERVER
// ═══════════════════════════════════════════════════════════════════

const app = express();
app.use(express.json({ limit: '5mb' }));

if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
app.use('/static', express.static(PUBLIC_DIR));

// Delete old screenshots
['step1', 'step2', 'step3', 'step4'].forEach(name => {
    const f = path.join(PUBLIC_DIR, `${name}.png`);
    if (fs.existsSync(f)) { fs.unlinkSync(f); log(`🗑️ Deleted old ${name}.png`); }
});

app.get('/status', (req, res) => {
    res.json({
        step: currentStep,
        message: progressMsg,
        running: isRunning,
        steps: [
            { id: 1, label: 'Coins Selection', done: currentStep >= 1, active: currentStep === 1 },
            { id: 2, label: 'Recharge & Select Card', done: currentStep >= 2, active: currentStep === 2 },
            { id: 3, label: 'Fill Card (iframe)', done: currentStep >= 3, active: currentStep === 3 },
            { id: 4, label: 'Pay and Link', done: currentStep >= 4, active: currentStep === 4 },
            { id: 5, label: 'Complete', done: currentStep >= 5, active: currentStep === 5 },
        ]
    });
});

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TikTok Payment Tracker</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            background: #0d0d0d;
            color: #fff;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 20px;
        }
        h2 { font-size: 22px; margin-bottom: 12px; }
        .btn {
            display: inline-block;
            background: linear-gradient(135deg, #ff0050, #ff2d78);
            color: #fff;
            padding: 14px 32px;
            border-radius: 10px;
            font-weight: 700;
            font-size: 16px;
            text-decoration: none;
            margin-bottom: 16px;
            transition: transform 0.2s, box-shadow 0.2s;
            border: none;
            cursor: pointer;
        }
        .btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(255,0,80,0.4); }
        .btn.running { opacity: 0.5; pointer-events: none; }
        .progress-bar { display: flex; gap: 6px; margin-bottom: 14px; width: 100%; max-width: 400px; }
        .progress-step { flex: 1; height: 6px; background: #2a2a2a; border-radius: 3px; transition: background 0.3s; }
        .progress-step.done { background: #00d45a; }
        .progress-step.active { background: #ff0050; animation: pulse 1s infinite; }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
        .status-text { font-size: 14px; color: #888; margin-bottom: 14px; min-height: 20px; }
        .steps { display: flex; flex-direction: column; gap: 14px; width: 100%; max-width: 400px; }
        .step-card { background: #181818; border: 1px solid #2a2a2a; border-radius: 14px; padding: 12px; text-align: center; transition: border-color 0.3s, box-shadow 0.3s; }
        .step-card.active { border-color: #ff0050; box-shadow: 0 0 15px rgba(255,0,80,0.2); }
        .step-card.done { border-color: #00d45a; box-shadow: 0 0 15px rgba(0,212,90,0.2); }
        .step-label { font-size: 13px; color: #888; margin-bottom: 8px; font-weight: 600; }
        .step-card img { width: 100%; border-radius: 10px; min-height: 180px; object-fit: contain; background: #222; display: block; }
        .step-card .placeholder { width: 100%; height: 180px; border-radius: 10px; background: #222; display: flex; align-items: center; justify-content: center; color: #444; font-size: 13px; }
    </style>
</head>
<body>
    <h2>🤖 TikTok Payment Tracker</h2>
    <a href="/run" id="startBtn" class="btn">🚀 Start Payment Process</a>
    <div class="progress-bar">
        <div class="progress-step" id="ps1"></div>
        <div class="progress-step" id="ps2"></div>
        <div class="progress-step" id="ps3"></div>
        <div class="progress-step" id="ps4"></div>
    </div>
    <div class="status-text" id="statusText">Waiting to start...</div>
    <div class="steps">
        <div class="step-card" id="card1">
            <div class="step-label">⏳ 1 · Coins Selection (30 Coins)</div>
            <div class="placeholder" id="img1wrap">No screenshot yet</div>
            <img id="img1" src="" style="display:none" alt="Step 1">
        </div>
        <div class="step-card" id="card2">
            <div class="label">⏳ 2 · Recharge & Select Card</div>
            <div class="placeholder" id="img2wrap">No screenshot yet</div>
            <img id="img2" src="" style="display:none" alt="Step 2">
        </div>
        <div class="step-card" id="card3">
            <div class="step-label">⏳ 3 · Card Details (inside iframe)</div>
            <div class="placeholder" id="img3wrap">No screenshot yet</div>
            <img id="img3" src="" style="display:none" alt="Step 3">
        </div>
        <div class="step-card" id="card4">
            <div class="step-label">⏳ 4 · After Pay and Link</div>
            <div class="placeholder" id="img4wrap">No screenshot yet</div>
            <img id="img4" src="" style="display:none" alt="Step 4">
        </div>
    </div>
    <script>
        function updateUI(data) {
            for (let i = 1; i <= 4; i++) {
                const el = document.getElementById('ps' + i);
                el.className = 'progress-step';
                if (data.steps[i-1].done) el.classList.add('done');
                if (data.steps[i-1].active) el.classList.add('active');
            }
            document.getElementById('statusText').textContent = data.message;
            const t = Date.now();
            for (let i = 1; i <= 4; i++) {
                const img = document.getElementById('img' + i);
                const wrap = document.getElementById('img' + i + 'wrap');
                const card = document.getElementById('card' + i);
                if (data.steps[i-1].done) {
                    img.src = '/static/step' + i + '.png?t=' + t;
                    img.style.display = 'block';
                    wrap.style.display = 'none';
                    card.className = 'step-card done';
                } else if (data.steps[i-1].active) {
                    card.className = 'step-card active';
                    wrap.style.display = 'none';
                    img.style.display = 'none';
                } else {
                    card.className = 'step-card';
                    wrap.style.display = 'flex';
                    img.style.display = 'none';
                }
            }
            const btn = document.getElementById('startBtn');
            if (data.running) {
                btn.classList.add('running');
                btn.textContent = '⏳ Running...';
            } else {
                btn.classList.remove('running');
                btn.textContent = '🚀 Start Payment Process';
            }
        }
        function poll() {
            fetch('/status?t=' + Date.now()).then(r => r.json()).then(updateUI).catch(() => {});
        }
        setInterval(poll, 1500);
        poll();
    </script>
</body>
</html>`);
});

app.get('/run', (req, res) => {
    res.json({ ok: true, message: "Worker Ready" });
});

// ═══════════════════════════════════════════════════════════════════
//  BROWSER LAUNCH
// ═══════════════════════════════════════════════════════════════════

async function launchBrowser(silent = false) {
    if (!silent) log('🚀 Launching browser...');
    else log('   🚀 Launching browser (silent)...');

    // v11: proxy comes from CONFIG.PROXIES with rotation support —
    // never hard-coded. When the current tunnel fails, launchBrowser
    // is called with a fresh profile AND a rotated proxy.
    const proxy = getCurrentProxy();

    const launchOpts = {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars',
            '--disable-notifications',
        ],
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    };

    if (proxy) {
        launchOpts.proxy = {
            server: proxy.server,
            username: proxy.username,
            password: proxy.password,
        };
        log(`   🌐 Proxy: ${proxy.name}`);
    }

    if (fs.existsSync(SESSION_FILE)) {
        launchOpts.storageState = SESSION_FILE;
        log('   Session loaded');
    }

    context = await chromium.launchPersistentContext(USER_DATA_DIR, launchOpts);
    page = context.pages()[0] || await context.newPage();

    context.on('close', async () => {
        try { await context.storageState({ path: SESSION_FILE }); } catch {}
    });

    app.listen(PORT, '0.0.0.0', () => {
        log(`✅ Server running on port ${PORT}`);
        log('');
        log('📋 HOW TO USE:');
        log('   1. Open http://YOUR_IP:3000');
        log('   2. Click "Start Payment Process" ONCE');
        log('   3. Watch progress live');
        log('   4. DO NOT click again until done');
        log('');
        log('🔒 Safety: only ONE instance can run at a time (PID lock)');
        log('');
    });
}

// ═══════════════════════════════════════════════════════════════════
//  QR LOGIN FUNCTIONS
// ═══════════════════════════════════════════════════════════════════

// ═══ ERROR CLASSIFICATION (v11) — sent to the backend so the
//     website can show a useful failure message ═══
const ERROR_CLASSES = {
    NETWORK_ERROR: 'NETWORK_ERROR',                 // page/navigation generic net failure
    PROXY_ERROR: 'PROXY_ERROR',                     // tunnel / proxy specific
    LOGIN_ERROR: 'LOGIN_ERROR',                     // could not reach/parse login page
    QR_ERROR: 'QR_ERROR',                           // QR extraction / scan timeout
    SESSION_ERROR: 'SESSION_ERROR',                 // session check crashed / ambiguous
    COINS_SELECTION_ERROR: 'COINS_SELECTION_ERROR', // package not available
    PAYMENT_FORM_ERROR: 'PAYMENT_FORM_ERROR',       // iframe / form fields not fillable
    PAYMENT_DECLINED: 'PAYMENT_DECLINED',           // issuer/gateway rejected
    PAYMENT_TIMEOUT: 'PAYMENT_TIMEOUT',             // no confirmation in time
    UNSUPPORTED_COIN_AMOUNT: 'UNSUPPORTED_COIN_AMOUNT' // requested coins not sold
};

function classifyError(message, context = '') {
    const msg = String(message || '');
    const ctx = String(context || '');
    if (isTunnelError(msg) || msg.includes('ERR_PROXY_CONNECTION_FAILED')) return ERROR_CLASSES.PROXY_ERROR;
    if (/net::|navigate|timeout|ENOTFOUND|ECONNREFUSED|ECONNRESET/i.test(msg) && !isTunnelError(msg)) return ERROR_CLASSES.NETWORK_ERROR;
    if (ctx.includes('qr') || /qr/i.test(msg)) return ERROR_CLASSES.QR_ERROR;
    if (ctx.includes('session') || ctx.includes('login')) return ERROR_CLASSES.LOGIN_ERROR;
    if (ctx.includes('coins') || ctx.includes('package')) return ERROR_CLASSES.COINS_SELECTION_ERROR;
    if (ctx.includes('iframe') || ctx.includes('card') || ctx.includes('payment form')) return ERROR_CLASSES.PAYMENT_FORM_ERROR;
    if (ctx.includes('payment') && /declined|rejected|failed/i.test(msg)) return ERROR_CLASSES.PAYMENT_DECLINED;
    if (ctx.includes('payment') && /timed?out/i.test(msg)) return ERROR_CLASSES.PAYMENT_TIMEOUT;
    return ERROR_CLASSES.UNKNOWN_ERROR;
}

// ═══ PROXY ROTATION — use CONFIG.PROXIES instead of the hard-coded one ═══
let currentProxyIndex = 0;

function getCurrentProxy() {
    const list = CONFIG.PROXIES || [];
    if (list.length === 0) return null;
    return list[currentProxyIndex % list.length];
}

function rotateProxy() {
    const list = CONFIG.PROXIES || [];
    if (list.length === 0) return;
    currentProxyIndex = (currentProxyIndex + 1) % list.length;
    warn(`🌐 Proxy rotated → ${list[currentProxyIndex].name}`);
}

function isTunnelError(message) {
    const msg = String(message || '');
    const msgLower = msg.toLowerCase();
    return ['err_tunnel_connection_failed', 'err_proxy_connection_failed', 'net::err_tunnel',
            'net::err_proxy_connection_failed', 'err_address_unreachable', 'err_internet_disconnected']
        .some(p => msgLower.includes(p));
}

async function gotoWithTunnelRetry(pg, url, opts = {}) {
    // v11 tunnel-recovery architecture (per requirements §14):
    // Navigation Failed → close browser/context → switch proxy →
    // create fresh browser context → retry navigation. Limited to
    // a bounded number of full restarts (not blind re-goto on the
    // same dead context).
    const attempts = opts.attempts || 3;
    const timeout = opts.timeout || 20000;

    for (let i = 1; i <= attempts; i++) {
        try {
            await pg.goto(url, { waitUntil: 'domcontentloaded', timeout });
            return true;
        } catch (e) {
            const msg = String(e.message || '');
            if (!isTunnelError(msg) || i >= attempts) throw e;

            warn(`   🌐 Tunnel failed (${msg.split(' at ')[0].replace('page.goto: ', '')}) — full restart + proxy rotation (${i}/${attempts})...`);
            rotateProxy();

            // Close the dead context and create a fresh one with the
            // rotated proxy (same profile dir, new context).
            try { if (context) { await context.close(); } } catch {}
            context = null;
            page = null;

            await sleep(3000 * i);

            try {
                await launchBrowser(true);
                pg = page;
            } catch (le) {
                warn('   Browser relaunch failed: ' + le.message);
                throw e; // propagate original tunnel error
            }

            if (!pg) throw e;
        }
    }

    return false;
}

async function checkTikTokSession(pg) {
    try {
        const ok = await gotoWithTunnelRetry(pg, 'https://www.tiktok.com/login', { attempts: 2, timeout: 15000 });
        if (!ok) return false;

        await sleep(2000);

        const url = pg.url();
        if (!url.includes('tiktok.com/login')) {
            return true; // Already logged in
        }

        const profileVisible = await pg.evaluate(() => {
            const avatar = document.querySelector('[data-e2e="user-avatar"], .user-avatar, img[src*="user_avatar"]');
            return avatar !== null && avatar.getBoundingClientRect().height > 0;
        }).catch(() => false);

        return profileVisible;
    } catch (e) {
        warn('checkTikTokSession error: ' + e.message);
        return false;
    }
}

async function doQRLogin(pg) {
    try {
        log('   Opening TikTok login page for QR...');
        const ok = await gotoWithTunnelRetry(pg, 'https://www.tiktok.com/login', { attempts: 3, timeout: 20000 });
        if (!ok) {
            return { success: false, error: 'net::ERR_TUNNEL_CONNECTION_FAILED after 3 retries' };
        }
        await sleep(2000);

        const qrTab = await pg.locator('[data-e2e="qr-code"], [class*="qrCode"], text=QR code').first();
        if (await qrTab.isVisible({ timeout: 5000 }).catch(() => false)) {
            await qrTab.click({ force: true });
            await sleep(2000);
        }

        const qrLink = await pg.evaluate(() => {
            const qrImg = document.querySelector('.qr_code img, [class*="qr-code"] img, img[src*="qr"]');
            if (qrImg && qrImg.src) return qrImg.src;

            const qrContainer = document.querySelector('[class*="qr-code"], [data-e2e="qr-code"]');
            if (qrContainer) {
                const dataUrl = qrContainer.getAttribute('data-login-url') || qrContainer.getAttribute('data-url');
                if (dataUrl) return dataUrl;
            }

            const currentUrl = window.location.href;
            if (currentUrl.includes('webcast') || currentUrl.includes('login')) {
                return currentUrl;
            }

            return null;
        });

        if (!qrLink) {
            return { success: false, error: 'Could not extract QR link' };
        }

        log('   ✅ QR link extracted');
        return { success: true, link: qrLink };

    } catch (e) {
        return { success: false, error: e.message };
    }
}

// v11: REAL login verification (§23/§33). Generating a QR is NOT a
// successful login. We wait until TikTok actually shows an
// authenticated account on tiktok.com (user menu / profile elements),
// and only then send LOGIN_SUCCESS to the backend.
async function verifyTikTokAuthenticated(pg) {
    try {
        // Authenticated homepage signals: user menu with avatar,
        // upload/profile icons that only exist for logged-in users.
        return await pg.evaluate(() => {
            const signals = [
                // Logged-in header menu
                document.querySelector('[data-e2e="user-profile-menu"]') !== null,
                // Avatar present in the header area
                !!document.querySelector('[data-e2e="user-avatar"]') &&
                    document.querySelector('[data-e2e="user-avatar"]').getBoundingClientRect().height > 0,
                // Upload button (only logged-in users can upload)
                !!document.querySelector('[data-e2e="upload-btn"]'),
                // Follow/Inbox icons appear only when authenticated
                !!document.querySelector('[data-e2e="follow-icon"]'),
                !!document.querySelector('[data-e2e="inbox-icon"]'),
            ];
            const hit = signals.filter(Boolean).length;
            return hit >= 2; // at least two independent signals
        }).catch(() => false);
    } catch {
        return false;
    }
}

async function waitForQRScan(pg, timeoutMs = 120000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
        try {
            const authenticated = await verifyTikTokAuthenticated(pg);
            if (authenticated) {
                return true;
            }
        } catch {}

        await sleep(2000);
    }

    return false; // Timeout
}

// ═══════════════════════════════════════════════════════════════════
//  API POLLING LOOP — HARDENED (ONE-TRY RULE)
// ═══════════════════════════════════════════════════════════════════

// ═══ Persistent file-based processed-IDs list ═══
// Survives process restarts: even after a kill/reboot cycle,
// already-charged order IDs are never charged again.
const PROCESSED_IDS_FILE = path.join(__dirname, 'processed_orders.json');

function loadProcessedIds() {
    try {
        if (fs.existsSync(PROCESSED_IDS_FILE)) {
            const ids = JSON.parse(fs.readFileSync(PROCESSED_IDS_FILE, 'utf8'));
            return new Set(Array.isArray(ids) ? ids : []);
        }
    } catch {}
    return new Set();
}

let persistedProcessedIds = loadProcessedIds();

// ═══ Atomic save: write to .tmp then rename — immune to corruption
//     from crashes mid-write (utils.writeJson pattern) ═══
function saveProcessedIds() {
    const tmpFile = PROCESSED_IDS_FILE + '.tmp';
    try {
        fs.writeFileSync(tmpFile, JSON.stringify([...persistedProcessedIds]));
        fs.renameSync(tmpFile, PROCESSED_IDS_FILE);
    } catch (e) {
        warn('Could not save processed IDs: ' + e.message);
        try { fs.unlinkSync(tmpFile); } catch {}
    }
}

setInterval(async () => {
    // ── Shutdown guard ──
    if (shutdownRequested) return;

    // ── In-process lock (no overlapping ticks) ──
    if (isRunning) return;

    try {
        const order = await worker.getPendingOrder();
        if (!order) return;

        // ═══ Rule #1: NEVER re-process an order we've already attempted ═══
        if (persistedProcessedIds.has(order.order_id)) {
            log('⏭️  Order already attempted before — skipping forever: ' + order.order_id);
            // Force it to "failed" so the website never offers it again
            await worker.failOrder(order, { message: 'already_attempted_skip', failureCode: 'DUPLICATE_ORDER' });
            return;
        }

        // ═══ Rule #2: Atomic claim — other instances can't grab it ═══
        const claimed = await worker.updateOrder(order, { status: 'processing' });
        if (!claimed) {
            warn('Could not claim order (backend unreachable) — will retry next tick: ' + order.order_id);
            return;
        }
        log('🔒 Order claimed: ' + order.order_id + ' → processing');

        // v11: start sending fine-grained status updates (step flow)
        let paymentStep = 'awaiting_session';

        // ═══ Mark as attempted — irreversible for this process lifetime ═══
        persistedProcessedIds.add(order.order_id);
        saveProcessedIds();

        global.CURRENT_ORDER = order;
        isRunning = true;

        console.log("📦 Processing:", order.order_id);

        // ═══ Session check ─══
        let sessionValid = false;
        try {
            sessionValid = await checkTikTokSession(page);
        } catch (e) {
            warn('Session check failed: ' + e.message);
        }

        if (!sessionValid) {
            paymentStep = 'login_required';
            log('⚠️ TikTok session expired — need QR login');
            await worker.updateOrder(order, { status: 'processing', payment_step: paymentStep });

            const qrResult = await doQRLogin(page);

            if (qrResult.success && qrResult.link) {
                await worker.sendLoginLink(order, qrResult.link);
                log('📤 Login link sent to website');
                paymentStep = 'qr_ready';
                await worker.updateOrder(order, { status: 'processing', payment_step: paymentStep });

                log('⏳ Waiting for user to scan QR (max 2 min)...');
                const scanned = await waitForQRScan(page, 120000);

                if (!scanned) {
                    // ═══ ONE-TRY RULE: user did not scan → fail, NO retry ═══
                    warn('QR scan timeout — order FAILED (user must re-confirm)');
                    paymentStep = 'qr_scan_timeout';
                    await worker.failOrder(order, { message: 'qr_scan_timeout_no_retry', paymentStep });
                    isRunning = false;
                    return;
                }

                // v11 REAL verification: authenticated signals detected
                log('✅ TikTok login VERIFIED — account authenticated');
                paymentStep = 'login_success';
                await worker.updateOrder(order, { status: 'processing', payment_step: paymentStep });
                try { await context.storageState({ path: SESSION_FILE }); } catch {}
            } else {
                // QR extraction failed → fail, no retry
                warn('QR login failed: ' + (qrResult.error || 'unknown'));
                paymentStep = 'qr_failed';
                await worker.failOrder(order, { message: 'qr_login_failed', paymentStep });
                isRunning = false;
                return;
            }
        } else {
            paymentStep = 'login_success';
            log('✅ TikTok session is valid');
        }

        // v11: send detailed steps BEFORE the payment sequence starts
        paymentStep = 'coins_selecting';
        await worker.updateOrder(order, { status: 'processing', payment_step: paymentStep }).catch(() => {});

        // ═══ Payment sequence — ANY step failure halts immediately ═══
        try {
            // v11: step callbacks that push fine-grained state to backend
            const setStateCb = {
                setStep: (step) => { currentStep = step; },
                setProgress: (message) => { progressMsg = message; },
                setPaymentStep: async (step) => {
                    paymentStep = step;
                    try { await worker.updateOrder(order, { status: 'processing', payment_step: step }); } catch {}
                }
            };

            const result = await runFullSequence({
                page,
                CONFIG,
                CARD_FILE,
                sleep,
                log,
                warn,
                err,
                takeScreenshot: async (stepName) => {
                    const srcFile = path.join(SCREENSHOT_DIR, `${stepName}.png`);
                    const publicFile = path.join(PUBLIC_DIR, `${stepName}.png`);

                    try {
                        const buffer = await page.screenshot({ type: 'png' });
                        fs.writeFileSync(srcFile, buffer);
                        fs.copyFileSync(srcFile, publicFile);
                        log(`📸 ${stepName}.png saved (${buffer.length} bytes)`);
                        return true;
                    } catch (e) {
                        err(`Screenshot ${stepName}`, e);
                        return false;
                    }
                },
                clickOne: async (selectors, label) => {
                    for (const sel of selectors) {
                        try {
                            const el = page.locator(sel).first();

                            if (await el.isVisible({ timeout: 6000 })) {
                                await el.click({ force: true });
                                log(`   ✅ Clicked: ${label}`);
                                return true;
                            }
                        } catch {}
                    }

                    warn(`Could not click: ${label}`);
                    return false;
                },
                fillInIframe: async (iframeLocator, placeholder, value, label) => {
                    const selectors = [
                        `input[placeholder="${placeholder}"]`,
                        `input[placeholder*="${placeholder.split(' ').slice(0, 2).join(' ')}" i]`,
                        `input[placeholder*="${placeholder}" i]`,
                        `input[name*="${placeholder.split(' ')[0]}" i]`,
                    ];

                    for (const sel of selectors) {
                        try {
                            const el = iframeLocator.locator(sel).first();

                            if (await el.isVisible({ timeout: 5000 })) {
                                await el.click({ force: true });
                                await sleep(300);
                                await el.fill('');
                                await sleep(100);
                                await el.type(value, { delay: 60 });

                                log(`   ✅ Filled iframe field: ${label}`);
                                return true;
                            }
                        } catch {}
                    }

                    warn(`Could not fill iframe field: ${label}`);
                    return false;
                },
                dumpIframe: async () => {
                    try {
                        // v11: use the ACTUAL Frame object (not frameLocator,
                        // which doesn't expose evaluate()) — this is the same
                        // fix that cured "iframe.evaluate is not a function"
                        const frame = page.frames().find(f => f.url().includes('pipopay')) || page.frames()[1];
                        if (!frame) { warn('No inner frame found for dump'); return; }

                        const info = await frame.evaluate(() => ({
                            inputs: Array.from(document.querySelectorAll('input')).map(inp => ({
                                placeholder: inp.placeholder,
                                name: inp.name,
                                type: inp.type,
                                visible: inp.getBoundingClientRect().height > 0
                            })),
                            buttons: Array.from(
                                document.querySelectorAll('button, [role="button"]')
                            ).map(btn => ({
                                text: (btn.textContent || '').trim().substring(0, 50)
                            })),
                            bodyPreview: document.body.innerText.substring(0, 300)
                        }));

                        log('   📍 INSIDE PipoPay iframe:');
                        log('   📍 Body preview: ' + info.bodyPreview);

                        info.inputs.forEach((inp, i) =>
                            log(`      Input ${i + 1}: ph="${inp.placeholder}" name="${inp.name}" type="${inp.type}"`)
                        );

                        info.buttons.forEach((btn, i) =>
                            log(`      Button ${i + 1}: "${btn.text}"`)
                        );

                    } catch (e) {
                        warn('Could not access iframe contents: ' + e.message);
                    }
                },
                getState: () => setStateCb
            });

            // ═══ Final verdict — ONE attempt only ═══
            if (!result?.success) {
                warn('Payment sequence failed — order marked FAILED (no retry)');
                paymentStep = result?.paymentStep || paymentStep;
                const code = result?.failureCode || classifyError(result?.message || '', paymentStep);
                await worker.failOrder(order, { message: result?.message || 'payment_sequence_failed', paymentStep, failureCode: code });
            } else {
                log('✅ Payment sequence completed — order marked COMPLETED');
                await worker.completeOrder(order);
            }

        } catch (e) {
            console.log(e);
            warn('Unexpected crash — order marked FAILED (no retry)');
            const code = classifyError(String(e), paymentStep);
            await worker.failOrder(order, { message: String(e), paymentStep, failureCode: code });
        }

        // ═══ CLEAN STATE: wipe TikTok session + browser profile after EACH order ═══
        // Next order always starts from a fresh login (QR scan), so no stale
        // cookies, fingerprint residue, or lingering TikTok state survives.
        try {
            if (context) {
                try { await context.close(); } catch {}
                context = null;
            }
            if (page) page = null;
            if (fs.existsSync(SESSION_FILE)) {
                fs.unlinkSync(SESSION_FILE);
                log('🧹 Deleted session file');
            }
            if (fs.existsSync(USER_DATA_DIR)) {
                fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
                log('🧹 Deleted browser profile (cookies/local data)');
            }
            global.CURRENT_ORDER = null;
        } catch (ce) {
            warn('Cleanup error (non-fatal): ' + ce.message);
        }

        // ═══ Relaunch browser with fresh profile for the next order ═══
        try {
            await launchBrowser(true);
            log('🚀 Fresh browser launched for next order');
        } catch (le) {
            err('Failed to relaunch browser', le);
        }

        isRunning = false;

    } catch (loopError) {
        err('Polling loop error', loopError);
        isRunning = false;
    }

}, CONFIG.POLL_INTERVAL);

// ═══ Start with PID lock guard ═══
acquireLock();
launchBrowser();
