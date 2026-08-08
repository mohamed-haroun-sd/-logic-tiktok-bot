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

async function launchBrowser() {
    log('🚀 Launching browser...');

    const launchOpts = {
        headless: true,
        proxy: {
            server: 'http://rp.infiniteproxies.com:1111',
            username: 'u87453w6p',
            password: 'a4NtWclFQS8B9S52Rurs_country-UnitedStates',
        },
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

async function checkTikTokSession(pg) {
    try {
        await pg.goto('https://www.tiktok.com/login', { waitUntil: 'domcontentloaded', timeout: 15000 });
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
        await pg.goto('https://www.tiktok.com/login', {
            waitUntil: 'domcontentloaded',
            timeout: 20000
        });
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

async function waitForQRScan(pg, timeoutMs = 120000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
        try {
            const isLoggedIn = await checkTikTokSession(pg);
            if (isLoggedIn) {
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

function saveProcessedIds() {
    try {
        fs.writeFileSync(PROCESSED_IDS_FILE, JSON.stringify([...persistedProcessedIds]));
    } catch (e) {
        warn('Could not save processed IDs: ' + e.message);
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
            await worker.failOrder(order, 'already_attempted_skip');
            return;
        }

        // ═══ Rule #2: Atomic claim — other instances can't grab it ═══
        const claimed = await worker.updateOrder(order, { status: 'processing' });
        if (!claimed) {
            warn('Could not claim order (backend unreachable) — will retry next tick: ' + order.order_id);
            return;
        }
        log('🔒 Order claimed: ' + order.order_id + ' → processing');

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
            log('⚠️ TikTok session expired — need QR login');

            const qrResult = await doQRLogin(page);

            if (qrResult.success && qrResult.link) {
                await worker.sendLoginLink(order, qrResult.link);
                log('📤 Login link sent to website');

                log('⏳ Waiting for user to scan QR (max 2 min)...');
                const scanned = await waitForQRScan(page, 120000);

                if (!scanned) {
                    // ═══ ONE-TRY RULE: user did not scan → fail, NO retry ═══
                    warn('QR scan timeout — order FAILED (user must re-confirm)');
                    await worker.failOrder(order, 'qr_scan_timeout_no_retry');
                    isRunning = false;
                    return;
                }

                log('✅ User scanned QR — session active');
                try { await context.storageState({ path: SESSION_FILE }); } catch {}
            } else {
                // QR extraction failed → fail, no retry
                warn('QR login failed: ' + (qrResult.error || 'unknown'));
                await worker.failOrder(order, 'qr_login_failed');
                isRunning = false;
                return;
            }
        } else {
            log('✅ TikTok session is valid');
        }

        // ═══ Payment sequence — ANY step failure halts immediately ═══
        try {
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
                        const iframe = page
                            .frameLocator('iframe[src*="pipopay"]')
                            .first();

                        const info = await iframe.evaluate(() => ({
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
                getState: () => ({
                    setStep: (step) => {
                        currentStep = step;
                    },
                    setProgress: (message) => {
                        progressMsg = message;
                    }
                })
            });

            // ═══ Final verdict — ONE attempt only ═══
            if (!result?.success) {
                warn('Payment sequence failed — order marked FAILED (no retry)');
                await worker.failOrder(order, result?.message || 'payment_sequence_failed');
            } else {
                log('✅ Payment sequence completed — order marked COMPLETED');
                await worker.completeOrder(order);
            }

        } catch (e) {
            console.log(e);
            warn('Unexpected crash — order marked FAILED (no retry)');
            await worker.failOrder(order, String(e));
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
