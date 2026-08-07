const fs = require("fs");

async function runFullSequence({
    page,
    CONFIG,
    CARD_FILE,
    sleep,
    log,
    warn,
    err,
    takeScreenshot,
    clickOne,
    fillInIframe,
    dumpIframe,
    getState
}) {
    const {
        setStep,
        setProgress
    } = getState();

    const ORDER = global.CURRENT_ORDER;

    if (!ORDER) {
        console.log("❌ No Current Order");
        return { success: false, message: "No Current Order" };
    }

    console.log("🎯 Order:", ORDER.order_id);
    console.log("👤 TikTok:", ORDER.tiktok_user);
    console.log("🪙 Coins:", ORDER.coins);

    if (!page) {
        return {
            success: false,
            message: "No page"
        };
    }

    log("═══════════════════════════════════════════════════════════");
    log("🚀 STARTING TikTok Payment Sequence");
    log("═══════════════════════════════════════════════════════════");

    // =========================================================
    // STEP 1
    // =========================================================

    setStep(1);
    setProgress("Opening coin page & selecting coins...");

    log("");
    log("━━━ STEP 1: Open Coin Page ━━━");

    try {
        await page.goto("https://www.tiktok.com/coin", {
            waitUntil: "domcontentloaded",
            timeout: 30000
        });

        await page.waitForLoadState("load", {
            timeout: 15000
        }).catch(() => {});

        await page.waitForLoadState("networkidle", {
            timeout: 15000
        }).catch(() => warn("Network not idle"));

        await sleep(3000);

        const coinAmount = ORDER.coins || 30;

        const coinBtns = [
            `button:has-text("${coinAmount}")`,
            `[class*="coinItem"]:has-text("${coinAmount}")`,
            `button:has-text("${coinAmount}")`
        ];

        await clickOne(coinBtns, `${coinAmount} Coins`);

        await sleep(1500);

        await takeScreenshot("step1");

    } catch (e) {
        err("Step 1 crashed", e);
        await takeScreenshot("step1");
    }

    // =========================================================
    // STEP 2
    // =========================================================

    setStep(2);
    setProgress("Clicking Recharge & selecting payment method...");

    log("");
    log("━━━ STEP 2: Click Recharge & Select Card ━━━");

    try {
        const rechargeBtns = [
            'button:has-text("Recharge")',
            'button.TUXButton--primary:has-text("Recharge")'
        ];

        const clicked = await clickOne(
            rechargeBtns,
            "Recharge"
        );

        if (!clicked) {
            warn("Recharge not found");
            await takeScreenshot("step2");

            return {
                success: false,
                message: "Recharge button not found"
            };
        }

        await sleep(3000);

        await page.waitForLoadState("networkidle", {
            timeout: 10000
        }).catch(() => {});

        await sleep(2000);

        log('   Selecting "Add Credit Or Debit Card"...');

        const cardRadioSelectors = [
            'input[name="payment-method"][value="Add credit or debit card"]',
            'input[name="payment-method"][value*="credit" i]',
            'text=Add Credit Or Debit Card',
            'div:has-text("Add Credit Or Debit Card"):has(input)',
            'label:has-text("Add Credit Or Debit Card")'
        ];

        await clickOne(
            cardRadioSelectors,
            "Add Credit Or Debit Card"
        );

        log("   Waiting for PipoPay iframe...");

        await sleep(4000);

        await page.waitForLoadState("networkidle", {
            timeout: 10000
        }).catch(() => {});

        await sleep(4000);

        try {
            const iframeVisible =
                await page
                    .frameLocator('iframe[src*="pipopay"]')
                    .first()
                    .locator("body")
                    .isVisible({
                        timeout: 8000
                    })
                    .catch(() => false);

            if (iframeVisible) {
                log("   ✅ PipoPay iframe is loaded!");
            } else {
                warn("PipoPay iframe not visible");
                await dumpIframe();
            }

        } catch {
            warn("Could not access iframe");
            await dumpIframe();
        }

        await takeScreenshot("step2");

    } catch (e) {
        err("Step 2 crashed", e);
        await takeScreenshot("step2");
    }

    // =========================================================
    // STEP 3
    // =========================================================

    setStep(3);
    setProgress("Filling card details...");

    log("");
    log("━━━ STEP 3: Fill Card Details ━━━");

    try {
        if (!fs.existsSync(CARD_FILE)) {
            throw new Error(
                `Card file "${CARD_FILE}" not found`
            );
        }

        const card = JSON.parse(
            fs.readFileSync(CARD_FILE, "utf8")
        );

        log(
            `   📋 Card: ${
                card.cardNumber
                    ? card.cardNumber.replace(
                        /\d{4}(?=\d{4})/g,
                        "****"
                    )
                    : "N/A"
            }`
        );

        let pipoFrame;

        try {
            pipoFrame =
                page
                    .frameLocator('iframe[src*="pipopay"]')
                    .first();

            log("   ✅ Found PipoPay iframe");

        } catch (e) {
            warn(
                "PipoPay iframe not found — trying first iframe"
            );

            pipoFrame =
                page.frameLocator("iframe").first();
        }

        // Card number

        log("   Filling card number...");

        let filled = false;

        const cardNumberPlaceholders = [
            "Enter card number",
            "Card number",
            "Card Number",
            "XXXX XXXX XXXX XXXX",
            "Number",
            "number"
        ];

        for (const ph of cardNumberPlaceholders) {
            filled = await fillInIframe(
                pipoFrame,
                ph,
                card.cardNumber || "",
                "Card Number"
            );

            if (filled) break;
        }

        if (!filled) {
            warn("Card Number not filled");
            await dumpIframe();
        }

        await sleep(500);

        // Cardholder

        filled = false;

        const holderPlaceholders = [
            "Cardholder name",
            "Name on card",
            "Full name",
            "Cardholder Name",
            "Name",
            "name",
            "Full Name"
        ];

        for (const ph of holderPlaceholders) {
            filled = await fillInIframe(
                pipoFrame,
                ph,
                card.cardHolder || "",
                "Cardholder Name"
            );

            if (filled) break;
        }

        await sleep(500);

        // Expiry

        filled = false;

        const expPlaceholders = [
            "MM/YY",
            "mm/yy",
            "MM/YYYY",
            "Expiration date",
            "Expiry date",
            "Exp date",
            "Expiry",
            "exp"
        ];

        for (const ph of expPlaceholders) {
            filled = await fillInIframe(
                pipoFrame,
                ph,
                card.expiryDate || "",
                "Expiration Date"
            );

            if (filled) break;
        }

        await sleep(500);

        // CVV

        filled = false;

        const cvvPlaceholders = [
            "CVV/CVC",
            "CVC/CVV",
            "CVV",
            "CVC",
            "Security code",
            "Security Code",
            "cvv",
            "cvc"
        ];

        for (const ph of cvvPlaceholders) {
            filled = await fillInIframe(
                pipoFrame,
                ph,
                card.cvv || "",
                "CVV"
            );

            if (filled) break;
        }

        await sleep(1000);

        // Postal

        filled = false;

        const postalPlaceholders = [
            "Postal code",
            "Zip code",
            "ZIP",
            "zip",
            "12345"
        ];

        for (const ph of postalPlaceholders) {
            filled = await fillInIframe(
                pipoFrame,
                ph,
                card.postalCode || "12345",
                "Postal Code"
            );

            if (filled) break;
        }

        await sleep(1000);

        await takeScreenshot("step3");

    } catch (e) {
        err("Step 3 crashed", e);
        await takeScreenshot("step3");
    }

    // =========================================================
    // STEP 4
    // =========================================================

    setStep(4);
    setProgress("Processing payment...");

    log("");
    log("━━━ STEP 4: Pay and Link ━━━");

    try {
        await sleep(2000);

        const payBtns = [
            'button:has-text("Pay and link")',
            'button:has-text("Pay and Link")',
            'button:has-text("Pay now" i)',
            'button:has-text("Pay Now" i)',
            'button.TUXButton--primary'
        ];

        const clicked = await clickOne(
            payBtns,
            "Pay and link"
        );

        if (!clicked) {
            warn("Pay button not found");
            await dumpIframe();

            return {
                success: false,
                message: "Pay button not found"
            };
        }

        log("   ⏳ Waiting after payment...");

        await sleep(5000);

        await takeScreenshot("step4");

    } catch (e) {
        err("Step 4 crashed", e);
        await takeScreenshot("step4");

        return {
            success: false,
            message: e.message
        };
    }

    // =========================================================
    // DONE
    // =========================================================

    setStep(5);
    setProgress("Sequence complete!");

    log("");
    log("═══════════════════════════════════════════════════════════");
    log("✅ SEQUENCE COMPLETE");
    log("═══════════════════════════════════════════════════════════");

    return {
        success: true,
        order_id: ORDER.order_id
    };
}

module.exports = {
    runFullSequence
};
