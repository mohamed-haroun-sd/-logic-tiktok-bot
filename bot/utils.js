const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const LOG_DIR = path.join(ROOT_DIR, "logs");
const SCREENSHOT_DIR = path.join(ROOT_DIR, "screenshots");
const TEMP_DIR = path.join(ROOT_DIR, "temp");

for (const dir of [LOG_DIR, SCREENSHOT_DIR, TEMP_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function timestamp() {
    return new Date().toISOString();
}

function log(message, ...args) {
    console.log(`[${timestamp()}] ${message}`, ...args);
}

function error(message, ...args) {
    console.error(`[${timestamp()}] ❌ ${message}`, ...args);
}

function safeString(value, fallback = "") {
    if (value === undefined || value === null) {
        return fallback;
    }

    return String(value).trim();
}

function safeNumber(value, fallback = 0) {
    const number = Number(value);

    return Number.isFinite(number)
        ? number
        : fallback;
}

function generateId(prefix = "id") {
    return `${prefix}_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function fileExists(file) {
    return fs.existsSync(file);
}

function readJson(file, fallback = null) {
    try {
        if (!fs.existsSync(file)) {
            return fallback;
        }

        const content = fs.readFileSync(file, "utf8").trim();

        if (!content) {
            return fallback;
        }

        return JSON.parse(content);
    } catch (err) {
        error(`Failed to read JSON: ${file}`, err.message);
        return fallback;
    }
}

function writeJson(file, data) {
    ensureDir(path.dirname(file));

    const tempFile = `${file}.tmp`;

    fs.writeFileSync(
        tempFile,
        JSON.stringify(data, null, 2),
        "utf8"
    );

    fs.renameSync(tempFile, file);

    return true;
}

function screenshotName(prefix = "step") {
    return path.join(
        SCREENSHOT_DIR,
        `${prefix}_${Date.now()}.png`
    );
}

function normalizeUrl(url) {
    return safeString(url).replace(/\/+$/, "");
}

function mask(value, visibleStart = 2, visibleEnd = 2) {
    const text = safeString(value);

    if (!text) {
        return "";
    }

    if (text.length <= visibleStart + visibleEnd) {
        return "*".repeat(text.length);
    }

    return (
        text.slice(0, visibleStart) +
        "*".repeat(
            text.length - visibleStart - visibleEnd
        ) +
        text.slice(-visibleEnd)
    );
}

function sanitizeError(err) {
    if (!err) {
        return "Unknown error";
    }

    return safeString(
        err.message ||
        err.error ||
        err.toString(),
        "Unknown error"
    );
}

function isValidOrder(order) {
    if (!order || typeof order !== "object") {
        return false;
    }

    return Boolean(
        order.order_id ||
        order.id
    );
}

module.exports = {
    sleep,
    log,
    error,
    safeString,
    safeNumber,
    generateId,
    ensureDir,
    fileExists,
    readJson,
    writeJson,
    screenshotName,
    normalizeUrl,
    mask,
    sanitizeError,
    isValidOrder,
    ROOT_DIR,
    LOG_DIR,
    SCREENSHOT_DIR,
    TEMP_DIR
};
