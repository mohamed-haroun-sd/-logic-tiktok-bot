const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const express = require('express');
const path = require('path');
const fs = require('fs');

chromium.use(stealth);

const CONFIG = require('./config');
const worker = require('./bot/worker');
const { runFullSequence } = require('./data/runFullSequence');

const SESSION_FILE = CONFIG.SESSION_FILE;
const USER_DATA_DIR = CONFIG.USER_DATA_DIR;
const PROCESSED_IDS_FILE = path.join(__dirname, 'processed_orders.json');

let browserContext = null;
let mainPage = null;
let isRunning = false;
let currentProxyIndex = 0;

// ═══ Duplicate Charge Protection ═══
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
    } catch (e) {}
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function rotateProxy() {
    if (CONFIG.PROXIES && CONFIG.PROXIES.length > 0) {
        currentProxyIndex = (currentProxyIndex + 1) % CONFIG.PROXIES.length;
        console.log(`[PROXY] Rotated to: ${CONFIG.PROXIES[currentProxyIndex].name}`);
    }
}

async function launchBrowser(forceFresh = false) {
    if (browserContext && !forceFresh) return;
    if (browserContext) { try { await browserContext.close(); } catch {} }

    console.log('[BROWSER] Launching Hardened Context...');
    const proxy = CONFIG.PROXIES[currentProxyIndex];
    
    const launchOptions = {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--window-size=1280,800',
            '--ignore-certificate-errors',
            '--disable-http2'
        ]
    };

    if (fs.existsSync(SESSION_FILE)) launchOptions.storageState = SESSION_FILE;

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
}

async function gotoWithTunnelRetry(url, attempts = 3) {
    for (let i = 1; i <= attempts; i++) {
        try {
            await mainPage.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
            return true;
        } catch (e) {
            if (i >= attempts) throw e;
            console.warn(`[NETWORK] Attempt ${i} failed, rotating proxy...`);
            rotateProxy();
            await launchBrowser(true);
            await sleep(3000);
        }
    }
    return false;
}

async function checkSession() {
    try {
        await mainPage.goto('https://www.tiktok.com/foryou', { waitUntil: 'networkidle', timeout: 15000 });
        return await mainPage.evaluate(() => !!document.querySelector('[data-e2e="user-avatar"]'));
    } catch (e) { return false; }
}

async function doQRLogin(order) {
    console.log('[QR] Navigating to direct QR page...');
    await gotoWithTunnelRetry('https://www.tiktok.com/login/qrcode');
    
    await mainPage.waitForSelector('canvas', { timeout: 15000 });
    const qrElement = await mainPage.locator('canvas').first();
    const qrPath = path.join(__dirname, 'public_html', 'tiktok_qr.png');
    await qrElement.screenshot({ path: qrPath });
    
    console.log('[QR] QR Code captured. Waiting for scan...');
    if (order) await worker.updateOrder(order, { payment_step: 'qr_ready' });

    for (let i = 0; i < 60; i++) {
        const authenticated = await mainPage.evaluate(() => {
            const signals = [
                document.querySelector('[data-e2e="user-profile-menu"]') !== null,
                document.querySelector('[data-e2e="user-avatar"]') !== null,
                !window.location.href.includes('login')
            ];
            return signals.filter(Boolean).length >= 2;
        });

        if (authenticated) {
            console.log('[LOGIN] Authentication Verified!');
            await browserContext.storageState({ path: SESSION_FILE });
            return true;
        }
        await sleep(2000);
    }
    return false;
}

async function startPolling() {
    console.log('[SYSTEM] Starting Hardened Polling Loop...');
    setInterval(async () => {
        if (isRunning) return;
        
        const order = await worker.getPendingOrder();
        if (!order) return;
        
        if (persistedProcessedIds.has(order.order_id)) {
            console.log(`[SKIP] Order ${order.order_id} already attempted.`);
            await worker.failOrder(order, { message: 'DUPLICATE_ORDER_SKIP' });
            return;
        }
        
        isRunning = true;
        persistedProcessedIds.add(order.order_id);
        saveProcessedIds();

        console.log(`[ORDER] Processing: ${order.order_id}`);
        
        try {
            await worker.updateOrder(order, { status: 'processing', payment_step: 'checking_session' });
            
            const isLogged = await checkSession();
            if (!isLogged) {
                const success = await doQRLogin(order);
                if (!success) throw new Error('QR_SCAN_TIMEOUT');
            }
            
            const result = await runFullSequence({
                page: mainPage,
                CONFIG,
                CARD_FILE: CONFIG.CARD_FILE,
                sleep,
                log: (m) => console.log(`[ORDER] ${m}`),
                warn: (m) => console.warn(`[WARN] ${m}`),
                err: (m) => console.error(`[ERR] ${m}`),
                takeScreenshot: async (n) => await mainPage.screenshot({ path: path.join(__dirname, 'public_html', `${n}.png`) }),
                clickOne: async (sels) => {
                    for (const s of sels) { if (await mainPage.isVisible(s)) { await mainPage.click(s); return true; } }
                    return false;
                },
                getState: () => ({
                    setStep: () => {},
                    setProgress: () => {},
                    setPaymentStep: async (ps) => await worker.updateOrder(order, { payment_step: ps })
                })
            });
            
            if (result.success) await worker.completeOrder(order);
            else await worker.failOrder(order, { message: result.message });
            
        } catch (e) {
            console.error(`[FATAL] Order ${order.order_id} failed:`, e.message);
            await worker.failOrder(order, { message: e.message });
        } finally {
            isRunning = false;
        }
    }, 5000);
}

launchBrowser().then(startPolling);
