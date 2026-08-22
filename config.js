const fs = require("fs");
const path = require("path");

function loadDotEnv(filePath) {
    const values = {};
    try {
        if (!fs.existsSync(filePath)) return values;
        for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || line.startsWith("#")) continue;
            const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
            if (!match) continue;
            let value = match[2].trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            values[match[1]] = value;
        }
    } catch (error) {
        console.warn(`[CONFIG] Could not read env file: ${error.message}`);
    }
    return values;
}

const envFile = loadDotEnv(process.env.TIKTOK_ENV_FILE || path.join(__dirname, ".env"));
const value = (key, fallback = "") => process.env[key] || envFile[key] || fallback;
const integer = (key, fallback) => {
    const parsed = Number.parseInt(value(key, String(fallback)), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
};

let proxies = [];
try {
    const rawProxies = value("TIKTOK_PROXIES_JSON", "[]");
    const parsed = JSON.parse(rawProxies);
    if (Array.isArray(parsed)) proxies = parsed.filter(proxy => proxy && proxy.server);
} catch (error) {
    console.warn(`[CONFIG] Invalid TIKTOK_PROXIES_JSON: ${error.message}`);
}

const accountId = value("TIKTOK_ACCOUNT_ID", "primary").replace(/[^A-Za-z0-9_-]/g, "_") || "primary";
const dataRoot = path.resolve(value("TIKTOK_DATA_DIR", path.join(__dirname, "runtime")));
const sessionRoot = path.join(dataRoot, "sessions");

module.exports = {
    WEBSITE_API: value("WEBSITE_API", "http://127.0.0.1:5000"),
    BOT_API_TOKEN: value("TIKTOK_BOT_TOKEN", ""),
    POLL_INTERVAL: integer("TIKTOK_POLL_INTERVAL", 5000),
    QR_TTL_SECONDS: integer("TIKTOK_QR_TTL_SECONDS", 120),
    ORDER_TIMEOUT_MS: integer("TIKTOK_ORDER_TIMEOUT_MS", 15 * 60 * 1000),
    SESSION_ACCOUNT_ID: accountId,
    SESSION_FILE: value("TIKTOK_SESSION_FILE", path.join(sessionRoot, `${accountId}.storage.json`)),
    USER_DATA_DIR: value("TIKTOK_USER_DATA_DIR", path.join(sessionRoot, accountId)),
    CARD_FILE: value("TIKTOK_CARD_FILE", path.join(__dirname, "card.json")),
    LOG_DIR: value("TIKTOK_LOG_DIR", path.join(dataRoot, "logs")),
    SCREENSHOT_DIR: value("TIKTOK_SCREENSHOT_DIR", path.join(dataRoot, "screenshots")),
    PROCESSED_IDS_FILE: value("TIKTOK_PROCESSED_IDS_FILE", path.join(dataRoot, "processed_orders.json")),
    PROXIES: proxies
};
