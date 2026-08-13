const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const express = require('express');
const path = require('path');
const fs = require('fs');

chromium.use(stealth);

const CONFIG = require('./config');
const worker = require('./bot/worker');

const PORT = 3000;
const SESSION_FILE = CONFIG.SESSION_FILE;
const USER_DATA_DIR = CONFIG.USER_DATA_DIR;

let browserContext = null;
let mainPage = null;
let isRunning = false;
let currentStep = 'idle';
let statusMessage = 'Waiting for order...';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function launchBrowser() {
    console.log('🚀 Launching TikTok Browser (V13)...');
    
    const launchOptions = {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars',
            '--window-size=1280,800',
        ]
    };

    if (fs.existsSync(SESSION_FILE)) {
        launchOptions.storageState = SESSION_FILE;
        console.log('   ✅ Session loaded');
    }

    const proxy = CONFIG.PROXIES[0]; // Use first proxy for now, rotation can be added
    if (proxy) {
        launchOptions.proxy = {
            server: proxy.server,
            username: proxy.username,
            password: proxy.password
        };
        console.log(`   🌐 Proxy: ${proxy.name}`);
    }

    browserContext = await chromium.launchPersistentContext(USER_DATA_DIR, launchOptions);
    mainPage = browserContext.pages()[0] || await browserContext.newPage();
    
    mainPage.setDefaultTimeout(30000);
    console.log('✅ Browser Ready');
}

async function checkSession() {
    try {
        await mainPage.goto('https://www.tiktok.com/foryou', { waitUntil: 'networkidle' });
        const loggedIn = await mainPage.evaluate(() => {
            return !!document.querySelector('[data-e2e="user-avatar"]');
        });
        return loggedIn;
    } catch (e) {
        return false;
    }
}

async function getQRCode() {
    console.log('🔗 Navigating to QR Login page...');
    await mainPage.goto('https://www.tiktok.com/login/qrcode', { waitUntil: 'networkidle' });
    
    // Wait for the QR canvas to appear
    await mainPage.waitForSelector('canvas', { timeout: 15000 });
    
    // Check if refresh is needed
    const needsRefresh = await mainPage.isVisible('div[class*="DivCodeMask"]');
    if (needsRefresh) {
        console.log('🔄 QR expired, clicking refresh...');
        await mainPage.click('div[class*="DivCodeMask"]');
        await sleep(2000);
    }

    // Take a screenshot of the QR element
    const qrElement = await mainPage.locator('canvas').first();
    const qrPath = path.join(__dirname, 'public_html', 'tiktok_qr.png');
    await qrElement.screenshot({ path: qrPath });
    
    console.log('✅ QR Code captured and saved');
    return '/static/tiktok_qr.png';
}

async function startOrderPolling() {
    setInterval(async () => {
        if (isRunning) return;
        
        const order = await worker.getPendingOrder();
        if (!order) return;
        
        isRunning = true;
        console.log(`📦 Processing Order: ${order.order_id}`);
        
        try {
            await worker.updateOrder(order, { status: 'processing', payment_step: 'checking_session' });
            
            const isLogged = await checkSession();
            if (!isLogged) {
                console.log('⚠️ Session expired, requesting QR login...');
                await worker.updateOrder(order, { status: 'processing', payment_step: 'login_required' });
                
                const qrUrl = await getQRCode();
                // In a real scenario, we'd send a link, but here we provide the QR image on the dashboard
                await worker.updateOrder(order, { status: 'processing', payment_step: 'qr_ready', qr_url: qrUrl });
                
                console.log('⏳ Waiting for user to scan...');
                let authenticated = false;
                for (let i = 0; i < 60; i++) { // 2 minutes
                    authenticated = await mainPage.evaluate(() => {
                        return !window.location.href.includes('login');
                    });
                    if (authenticated) break;
                    await sleep(2000);
                }
                
                if (!authenticated) {
                    throw new Error('QR Scan Timeout');
                }
                
                console.log('✅ Login successful!');
                await browserContext.storageState({ path: SESSION_FILE });
            }
            
            // Proceed to payment sequence
            await worker.updateOrder(order, { status: 'processing', payment_step: 'coins_selecting' });
            // Here you would call runFullSequence(mainPage, ...)
            console.log('🚀 Starting payment sequence...');
            
        } catch (e) {
            console.error(`❌ Order ${order.order_id} failed:`, e.message);
            await worker.failOrder(order, { message: e.message });
        } finally {
            isRunning = false;
        }
    }, 5000);
}

const app = express();
app.use('/static', express.static(path.join(__dirname, 'public_html')));

app.get('/status', (req, res) => {
    res.json({ step: currentStep, message: statusMessage });
});

launchBrowser().then(() => {
    startOrderPolling();
    app.listen(PORT, () => {
        console.log(`🚀 Bot V13 Status Server on port ${PORT}`);
    });
});
