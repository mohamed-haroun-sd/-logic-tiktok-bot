const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { createCanvas, loadImage } = require("canvas");
const jsQR = require("jsqr");

const CONFIG = require("./config");
const api = require("./bot/api");
const worker = require("./bot/worker");
const { runFullSequence } = require("./data/runFullSequence");

chromium.use(stealth);

const app = express();
const PORT = Number(process.env.TIKTOK_BOT_PORT || 3000);
const LOCK_FILE = path.join(CONFIG.LOG_DIR, "bot.lock");
const MAX_DIAGNOSTIC_TEXT = 1200;

let context = null;
let page = null;
let running = false;
let shutdownRequested = false;
let proxyIndex = 0;
let currentOrder = null;
let currentLogin = null;
let lastError = null;
let lastTickAt = 0;
let browserReady = false;
let tikTokReachable = false;
let consoleErrors = [];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => new Date().toISOString();
const log = message => console.log(`[${now()}] ${message}`);
const warn = message => console.warn(`[${now()}] WARN ${message}`);
const safeText = value => String(value || "").replace(/\s+/g, " ").trim().slice(0, MAX_DIAGNOSTIC_TEXT);

function ensureDirs() {
    for (const dir of [CONFIG.LOG_DIR, CONFIG.SCREENSHOT_DIR, path.dirname(CONFIG.SESSION_FILE), CONFIG.USER_DATA_DIR]) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
}

function acquireLock() {
    ensureDirs();
    try {
        if (fs.existsSync(LOCK_FILE)) {
            const oldPid = Number.parseInt(fs.readFileSync(LOCK_FILE, "utf8"), 10);
            if (oldPid > 0) {
                try {
                    process.kill(oldPid, 0);
                    throw new Error(`another bot is running with PID ${oldPid}`);
                } catch (error) {
                    if (error.code === "ESRCH") fs.unlinkSync(LOCK_FILE);
                    else if (error.message.startsWith("another bot")) throw error;
                    else fs.unlinkSync(LOCK_FILE);
                }
            } else fs.unlinkSync(LOCK_FILE);
        }
        fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx", mode: 0o600 });
    } catch (error) {
        throw new Error(`lock acquisition failed: ${error.message}`);
    }
}

function releaseLock() {
    try {
        if (fs.existsSync(LOCK_FILE) && Number.parseInt(fs.readFileSync(LOCK_FILE, "utf8"), 10) === process.pid) {
            fs.unlinkSync(LOCK_FILE);
        }
    } catch (error) {
        warn(`lock release failed: ${error.message}`);
    }
}

function loadProcessedIds() {
    try {
        const value = JSON.parse(fs.readFileSync(CONFIG.PROCESSED_IDS_FILE, "utf8"));
        return new Set(Array.isArray(value) ? value.map(String) : []);
    } catch {
        return new Set();
    }
}

const processedIds = loadProcessedIds();
function saveProcessedIds() {
    const temp = `${CONFIG.PROCESSED_IDS_FILE}.tmp`;
    try {
        fs.mkdirSync(path.dirname(CONFIG.PROCESSED_IDS_FILE), { recursive: true, mode: 0o700 });
        fs.writeFileSync(temp, JSON.stringify([...processedIds]), { mode: 0o600 });
        fs.renameSync(temp, CONFIG.PROCESSED_IDS_FILE);
    } catch (error) {
        warn(`processed id save failed: ${error.message}`);
        try { fs.unlinkSync(temp); } catch {}
    }
}

function currentProxy() {
    return CONFIG.PROXIES[proxyIndex % Math.max(CONFIG.PROXIES.length, 1)] || null;
}

function rotateProxy() {
    if (!CONFIG.PROXIES.length) return;
    proxyIndex = (proxyIndex + 1) % CONFIG.PROXIES.length;
    warn(`proxy rotated to ${CONFIG.PROXIES[proxyIndex].name || proxyIndex}`);
}

function attachPageDiagnostics(pg) {
    consoleErrors = [];
    pg.on("console", message => {
        if (message.type() === "error") consoleErrors.push(safeText(message.text()));
        if (consoleErrors.length > 20) consoleErrors.shift();
    });
    pg.on("pageerror", error => {
        consoleErrors.push(safeText(error.message));
        if (consoleErrors.length > 20) consoleErrors.shift();
    });
}

async function launchBrowser(forceFresh = false) {
    if (context && page && !forceFresh) return;
    if (context) {
        try { await context.close(); } catch {}
    }
    context = null;
    page = null;
    browserReady = false;
    const proxy = currentProxy();
    const options = {
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled", "--disable-infobars", "--disable-notifications"],
        viewport: { width: 1280, height: 800 },
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36"
    };
    if (proxy) options.proxy = { server: proxy.server, username: proxy.username, password: proxy.password };
    if (fs.existsSync(CONFIG.SESSION_FILE)) options.storageState = CONFIG.SESSION_FILE;
    context = await chromium.launchPersistentContext(CONFIG.USER_DATA_DIR, options);
    page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(30000);
    attachPageDiagnostics(page);
    browserReady = true;
    log(`browser ready for account ${CONFIG.SESSION_ACCOUNT_ID}`);
}

function isTunnelError(error) {
    return /ERR_TUNNEL|ERR_PROXY|ERR_ADDRESS_UNREACHABLE|ERR_INTERNET_DISCONNECTED/i.test(String(error?.message || error));
}

async function gotoWithRetry(url, attempts = 3, timeout = 30000) {
    let last = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            await page.goto(url, { waitUntil: "domcontentloaded", timeout });
            tikTokReachable = true;
            return true;
        } catch (error) {
            last = error;
            tikTokReachable = false;
            if (!isTunnelError(error) || attempt >= attempts) break;
            rotateProxy();
            await launchBrowser(true);
            await sleep(1500 * attempt);
        }
    }
    throw last || new Error("navigation failed");
}

async function checkSession() {
    try {
        await gotoWithRetry("https://www.tiktok.com/login", 2, 20000);
        await sleep(1200);
        if (!page.url().includes("/login")) return true;
        return await page.evaluate(() => {
            const selectors = ["[data-e2e=\"user-profile-menu\"]", "[data-e2e=\"user-avatar\"]", "[data-e2e=\"upload-btn\"]", "img[src*='user_avatar']"];
            return selectors.filter(selector => document.querySelector(selector)).length >= 2;
        }).catch(() => false);
    } catch {
        return false;
    }
}

async function decodeQr(locator) {
    try {
        if (!(await locator.isVisible({ timeout: 2500 }).catch(() => false))) return null;
        const buffer = await locator.screenshot({ type: "png" });
        const image = await loadImage(buffer);
        const canvas = createCanvas(image.width, image.height);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(image, 0, 0);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const result = jsQR(data.data, data.width, data.height, { inversionAttempts: "attemptBoth" });
        return result?.data || null;
    } catch {
        return null;
    }
}

async function extractQr() {
    const selectors = ["canvas", "img[src*='qrcode']", "img[src*='qr-code']", "img[src*='qr']", "[data-e2e*='qr']", "[class*='qrCode']", "[class*='qr-code']", "[class*='qrcode']"];
    for (const selector of selectors) {
        const loc = page.locator(selector);
        const count = Math.min(await loc.count().catch(() => 0), 10);
        for (let index = 0; index < count; index++) {
            const payload = await decodeQr(loc.nth(index));
            if (payload) {
                let image = null;
                try { image = `data:image/png;base64,${(await loc.nth(index).screenshot({ type: "png" })).toString("base64")}`; } catch {}
                return { payload, image };
            }
        }
    }
    return null;
}

function newLoginSession() {
    return {
        id: crypto.randomUUID(),
        state: "QR_CREATED",
        createdAt: Date.now(),
        expiresAt: Date.now() + CONFIG.QR_TTL_SECONDS * 1000,
        accountId: CONFIG.SESSION_ACCOUNT_ID
    };
}

async function authenticatedSignals() {
    return page.evaluate(() => {
        const checks = [
            document.querySelector('[data-e2e="user-profile-menu"]') !== null,
            document.querySelector('[data-e2e="user-avatar"]')?.getBoundingClientRect().height > 0,
            document.querySelector('[data-e2e="upload-btn"]') !== null,
            !location.href.includes("/login")
        ];
        return checks.filter(Boolean).length >= 2;
    }).catch(() => false);
}

async function createQrLogin(order) {
    currentLogin = newLoginSession();
    currentLogin.state = "QR_CREATED";
    await gotoWithRetry("https://www.tiktok.com/login/qrcode", 3, 30000);
    await sleep(3000);
    const qr = await extractQr();
    if (!qr) {
        currentLogin.state = "LOGIN_FAILED";
        throw new Error("QR_PAYLOAD_NOT_DETECTED");
    }
    currentLogin.state = "QR_SENT";
    await api.sendLoginLink(order, qr.payload, CONFIG.QR_TTL_SECONDS, {
        login_session_id: currentLogin.id,
        qr_image: qr.image || ""
    });
    currentLogin.state = "WAITING_FOR_SCAN";
    await worker.updateOrder(order, { payment_step: "waiting_for_scan", login_session_id: currentLogin.id });
    return currentLogin;
}

async function waitForLogin(order, loginSession) {
    const deadline = Date.now() + CONFIG.QR_TTL_SECONDS * 1000;
    while (Date.now() < deadline && !shutdownRequested) {
        if (await authenticatedSignals()) {
            loginSession.state = "LOGIN_SUCCESS";
            await worker.updateOrder(order, { payment_step: "login_success", login_session_id: loginSession.id });
            await context.storageState({ path: CONFIG.SESSION_FILE });
            loginSession.state = "SESSION_SAVED";
            await worker.updateOrder(order, { payment_step: "session_saved", login_session_id: loginSession.id });
            return true;
        }
        if (loginSession.state === "WAITING_FOR_SCAN") {
            const scanHint = await page.evaluate(() => /scanned|confirm|تأكيد|تم المسح/i.test(document.body?.innerText || "")).catch(() => false);
            if (scanHint) {
                loginSession.state = "QR_SCANNED";
                await worker.updateOrder(order, { payment_step: "qr_scanned", login_session_id: loginSession.id });
            }
        }
        await sleep(2000);
    }
    loginSession.state = "LOGIN_EXPIRED";
    return false;
}

async function diagnostics(order, step, error) {
    const orderId = String(order?.order_id || "unknown");
    const base = path.join(CONFIG.SCREENSHOT_DIR, `order_${orderId}_${step}`);
    const record = {
        order_id: orderId,
        request_id: crypto.randomUUID(),
        session_id: currentLogin?.id || null,
        timestamp: now(),
        step,
        error_code: error?.failureCode || error?.code || "UNKNOWN_ERROR",
        error_type: error?.type || "unknown",
        error_message: safeText(error?.message || error),
        current_url: safeText(page?.url?.()),
        console_errors: consoleErrors.slice(-20)
    };
    try {
        record.page_title = safeText(await page.title());
        record.visible_text = safeText(await page.locator("body").innerText({ timeout: 3000 }));
    } catch {}
    try { await page.screenshot({ path: `${base}.png`, fullPage: false }); record.screenshot = `${base}.png`; } catch {}
    try { fs.writeFileSync(`${base}.json`, JSON.stringify(record, null, 2), { mode: 0o600 }); } catch {}
    lastError = record;
    return record;
}

async function processOne(order) {
    currentOrder = order;
    global.CURRENT_ORDER = order;
    const claim = await api.claimOrder(order);
    if (!claim) return { ok: false, reason: "claim_lost" };
    if (processedIds.has(String(order.order_id))) {
        await worker.failOrder(order, { message: "DUPLICATE_ORDER", failureCode: "DUPLICATE_ORDER" });
        return { ok: false, reason: "duplicate" };
    }
    processedIds.add(String(order.order_id));
    saveProcessedIds();
    running = true;
    try {
        await worker.updateOrder(order, { payment_step: "checking_session", attempt: 1, session_id: CONFIG.SESSION_ACCOUNT_ID });
        if (!(await checkSession())) {
            await worker.updateOrder(order, { payment_step: "login_required" });
            const loginSession = await createQrLogin(order);
            if (!(await waitForLogin(order, loginSession))) {
                await worker.failOrder(order, { message: "QR_SCAN_TIMEOUT", failureCode: "QR_SCAN_TIMEOUT", paymentStep: "login_expired" });
                return { ok: false, reason: "login_expired" };
            }
        } else {
            await worker.updateOrder(order, { payment_step: "login_success", session_id: CONFIG.SESSION_ACCOUNT_ID });
        }

        const result = await runFullSequence({
            page,
            order,
            CONFIG,
            CARD_FILE: CONFIG.CARD_FILE,
            sleep,
            log: message => log(`[ORDER ${order.order_id}] ${message}`),
            warn,
            err: (message, error) => warn(`${message}: ${safeText(error?.message || error)}`),
            takeScreenshot: async step => page.screenshot({ path: path.join(CONFIG.SCREENSHOT_DIR, `order_${order.order_id}_${step}.png`) }),
            clickOne: async selectors => {
                for (const selector of selectors) {
                    const target = page.locator(selector).first();
                    if (await target.isVisible({ timeout: 4000 }).catch(() => false)) {
                        await target.click({ force: true });
                        return true;
                    }
                }
                return false;
            },
            fillInIframe: async (frame, placeholder, value) => {
                const selectors = [`input[placeholder=\"${placeholder}\"]`, `input[placeholder*='${placeholder}' i]`, `input[name*='${placeholder.split(" ")[0]}' i]`];
                for (const selector of selectors) {
                    const target = frame.locator(selector).first();
                    if (await target.isVisible({ timeout: 4000 }).catch(() => false)) {
                        await target.fill(String(value));
                        return true;
                    }
                }
                return false;
            },
            dumpIframe: async () => {},
            getState: () => ({
                setStep: () => {},
                setProgress: () => {},
                setPaymentStep: step => worker.updateOrder(order, { status: "processing", payment_step: step })
            })
        });
        if (result?.success) {
            await worker.completeOrder(order, { session_id: CONFIG.SESSION_ACCOUNT_ID });
            return { ok: true };
        }
        const failure = Object.assign(new Error(result?.message || "PAYMENT_FAILED"), result);
        await diagnostics(order, result?.paymentStep || "payment", failure);
        await worker.failOrder(order, { message: result?.message || "PAYMENT_FAILED", failureCode: result?.failureCode || "PAYMENT_FAILED", paymentStep: result?.paymentStep || "failed" });
        return { ok: false, reason: result?.failureCode || "PAYMENT_FAILED" };
    } catch (error) {
        await diagnostics(order, "unexpected", error);
        await worker.failOrder(order, { message: safeText(error.message), failureCode: error.failureCode || "UNKNOWN_ERROR", paymentStep: "failed" });
        return { ok: false, reason: error.message };
    } finally {
        try { if (context) await context.storageState({ path: CONFIG.SESSION_FILE }); } catch {}
        currentOrder = null;
        global.CURRENT_ORDER = null;
        currentLogin = null;
        running = false;
    }
}

async function pollingLoop() {
    while (!shutdownRequested) {
        lastTickAt = Date.now();
        if (!running) {
            const order = await worker.getPendingOrder();
            if (order) await processOne(order);
        }
        await sleep(CONFIG.POLL_INTERVAL);
    }
}

app.use(express.json({ limit: "2mb" }));
app.get("/health", (req, res) => res.json({
    ok: true,
    bot: "ONLINE",
    browser: browserReady ? "READY" : "OFFLINE",
    tiktok: tikTokReachable ? "REACHABLE" : "UNKNOWN",
    session_account: CONFIG.SESSION_ACCOUNT_ID,
    queue: running ? 1 : 0,
    processing: running ? 1 : 0,
    last_tick: lastTickAt,
    current_order: currentOrder?.order_id || null,
    login_state: currentLogin?.state || null,
    last_error: lastError
}));
app.get("/api/status", (req, res) => res.json({
    running,
    current_order: currentOrder?.order_id || null,
    login: currentLogin,
    last_error: lastError
}));
app.use("/static", express.static(CONFIG.SCREENSHOT_DIR));

async function shutdown(code = 0) {
    if (shutdownRequested) return;
    shutdownRequested = true;
    try { if (context) await context.storageState({ path: CONFIG.SESSION_FILE }); } catch {}
    try { if (context) await context.close(); } catch {}
    releaseLock();
    process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("uncaughtException", async error => {
    console.error(error);
    await shutdown(1);
});
process.on("unhandledRejection", error => console.error("UNHANDLED", error));

(async () => {
    try {
        acquireLock();
        await launchBrowser();
        app.listen(PORT, "127.0.0.1", () => log(`health server listening on 127.0.0.1:${PORT}`));
        await pollingLoop();
    } catch (error) {
        console.error(`[FATAL] ${error.message}`);
        releaseLock();
        process.exit(1);
    }
})();
