const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();

const CONFIG = require("../config");

chromium.use(stealth);

let context = null;
let page = null;


async function launchBrowser() {

    if (context && page) {
        return {
            context,
            page
        };
    }

    console.log("🚀 Launching TikTok browser...");

    const launchOptions = {

        headless: true,

        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-blink-features=AutomationControlled",
            "--disable-infobars",
            "--disable-notifications"
        ],

        viewport: {
            width: 1280,
            height: 800
        },

        userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/122.0.0.0 Safari/537.36"
    };


    if (CONFIG.SESSION_FILE) {

        const fs = require("fs");

        if (fs.existsSync(CONFIG.SESSION_FILE)) {

            launchOptions.storageState =
                CONFIG.SESSION_FILE;

            console.log("   ✅ Session loaded");
        }
    }


    context = await chromium.launchPersistentContext(
        CONFIG.USER_DATA_DIR,
        launchOptions
    );


    page =
        context.pages()[0] ||
        await context.newPage();


    context.on("close", async () => {

        try {

            await context.storageState({
                path: CONFIG.SESSION_FILE
            });

            console.log("💾 Session saved");

        } catch (error) {

            console.error(
                "❌ Could not save session:",
                error.message
            );
        }

    });


    page.setDefaultTimeout(15000);


    console.log("✅ Browser ready");


    return {
        context,
        page
    };
}


function getPage() {
    return page;
}


function getContext() {
    return context;
}


async function closeBrowser() {

    try {

        if (context) {
            await context.close();
        }

    } catch (error) {

        console.error(
            "❌ Browser close error:",
            error.message
        );

    } finally {

        context = null;
        page = null;

    }
}


async function screenshot(filePath) {

    if (!page) {
        throw new Error("Browser page is not initialized");
    }

    return await page.screenshot({
        path: filePath,
        fullPage: false
    });
}


module.exports = {
    launchBrowser,
    getPage,
    getContext,
    closeBrowser,
    screenshot
};
