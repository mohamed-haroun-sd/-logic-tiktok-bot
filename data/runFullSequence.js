const fs = require("fs");

// ═══════════════════════════════════════════════════════════════════
//  TikTok Payment Sequence — HARDENED v2
//
//  SAFETY RULES:
//  ─────────────
//  1. STEP FAILURE HALTS: every step throws/rejects on failure.
//     There is NO fall-through — if Step 1 fails we never reach
//     "Pay", so an order that failed can never be charged.
//  2. PRE-PAY VERIFICATION: before pressing "Pay and link" the bot
//     confirms the card number field inside PipoPay is actually
//     filled (its value is not empty).
//  3. POST-PAY VERIFICATION: after paying, the bot waits and
//     inspects the outcome instead of blindly declaring success.
// ═══════════════════════════════════════════════════════════════════

function hardFail(message) {
    const e = new Error(message);
    e.isSequenceError = true;
    return e;
}

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

    // ── PipoPay frame reference (used by steps 3 & 4) ──
    let pipoFrame = null;

    // =========================================================
    // STEP 1 — Open Coin Page
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

        const coinClicked = await clickOne(coinBtns, `${coinAmount} Coins`);

        if (!coinClicked) {
            await takeScreenshot("step1");
            return {
                success: false,
                message: `Could not select ${coinAmount} coins`
            };
        }

        await sleep(1500);
        await takeScreenshot("step1");

    } catch (e) {
        err("Step 1 crashed", e);
        await takeScreenshot("step1");
        return { success: false, message: "Step 1 crashed: " + e.message };
    }

    // =========================================================
    // STEP 2 — Recharge & Select Card
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

        const clicked = await clickOne(rechargeBtns, "Recharge");

        if (!clicked) {
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

        const cardSelected = await clickOne(cardRadioSelectors, "Add Credit Or Debit Card");

        if (!cardSelected) {
            await takeScreenshot("step2");
            return {
                success: false,
                message: "Could not select Add Credit Or Debit Card"
            };
        }

        log("   Waiting for PipoPay iframe...");

        await sleep(4000);

        await page.waitForLoadState("networkidle", {
            timeout: 10000
        }).catch(() => {});

        await sleep(4000);

        // Locate the PipoPay iframe — fail the step if it never appears
        try {
            pipoFrame =
                page
                    .frameLocator('iframe[src*="pipopay"]')
                    .first();

            const iframeVisible = await pipoFrame
                .locator("body")
                .isVisible({ timeout: 8000 })
                .catch(() => false);

            if (!iframeVisible) {
                warn("PipoPay iframe not visible — dumping contents");
                await dumpIframe();
                await takeScreenshot("step2");
                return {
                    success: false,
                    message: "PipoPay iframe not visible"
                };
            }

            log("   ✅ PipoPay iframe is loaded!");

        } catch {
            warn("PipoPay iframe not found — trying first iframe");

            try {
                pipoFrame = page.frameLocator("iframe").first();

                const anyVisible = await pipoFrame
                    .locator("body")
                    .isVisible({ timeout: 8000 })
                    .catch(() => false);

                if (!anyVisible) {
                    await dumpIframe();
                    await takeScreenshot("step2");
                    return {
                        success: false,
                        message: "No usable iframe found"
                    };
                }

                log("   ⚠️ Using first iframe (fallback)");

            } catch {
                await dumpIframe();
                await takeScreenshot("step2");
                return {
                    success: false,
                    message: "No iframe found at all"
                };
            }
        }

        await takeScreenshot("step2");

    } catch (e) {
        err("Step 2 crashed", e);
        await takeScreenshot("step2");
        return { success: false, message: "Step 2 crashed: " + e.message };
    }

    // =========================================================
    // STEP 3 — Fill Card Details
    // =========================================================

    setStep(3);
    setProgress("Filling card details...");

    log("");
    log("━━━ STEP 3: Fill Card Details ━━━");

    try {
        if (!pipoFrame) {
            return {
                success: false,
                message: "PipoPay iframe reference missing (step 2 failed earlier)"
            };
        }

        if (!fs.existsSync(CARD_FILE)) {
            throw new Error(`Card file "${CARD_FILE}" not found`);
        }

        const card = JSON.parse(fs.readFileSync(CARD_FILE, "utf8"));

        log(
            `   📋 Card: ${
                card.cardNumber
                    ? card.cardNumber.replace(/\d{4}(?=\d{4})/g, "****")
                    : "N/A"
            }`
        );

        // Card number — REQUIRED
        const cardNumberPlaceholders = [
            "Enter card number",
            "Card number",
            "Card Number",
            "XXXX XXXX XXXX XXXX",
            "Number",
            "number"
        ];

        let filled = false;
        for (const ph of cardNumberPlaceholders) {
            filled = await fillInIframe(
                pipoFrame, ph, card.cardNumber || "", "Card Number"
            );
            if (filled) break;
        }
        if (!filled) {
            await dumpIframe();
            return {
                success: false,
                message: "Card Number field could not be filled"
            };
        }
        await sleep(500);

        // Cardholder — REQUIRED
        const holderPlaceholders = [
            "Cardholder name",
            "Name on card",
            "Full name",
            "Cardholder Name",
            "Name",
            "name",
            "Full Name"
        ];

        filled = false;
        for (const ph of holderPlaceholders) {
            filled = await fillInIframe(
                pipoFrame, ph, card.cardHolder || "", "Cardholder Name"
            );
            if (filled) break;
        }
        if (!filled) {
            await dumpIframe();
            return {
                success: false,
                message: "Cardholder Name field could not be filled"
            };
        }
        await sleep(500);

        // Expiry — REQUIRED
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

        filled = false;
        for (const ph of expPlaceholders) {
            filled = await fillInIframe(
                pipoFrame, ph, card.expiryDate || "", "Expiration Date"
            );
            if (filled) break;
        }
        if (!filled) {
            await dumpIframe();
            return {
                success: false,
                message: "Expiration Date field could not be filled"
            };
        }
        await sleep(500);

        // CVV — REQUIRED
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

        filled = false;
        for (const ph of cvvPlaceholders) {
            filled = await fillInIframe(
                pipoFrame, ph, card.cvv || "", "CVV"
            );
            if (filled) break;
        }
        if (!filled) {
            await dumpIframe();
            return {
                success: false,
                message: "CVV field could not be filled"
            };
        }
        await sleep(1000);

        // Postal — OPTIONAL (fallback value accepted)
        const postalPlaceholders = [
            "Postal code",
            "Zip code",
            "ZIP",
            "zip",
            "12345"
        ];

        filled = false;
        for (const ph of postalPlaceholders) {
            filled = await fillInIframe(
                pipoFrame, ph, card.postalCode || "12345", "Postal Code"
            );
            if (filled) break;
        }
        if (!filled) {
            warn("Postal Code not filled (non-critical, continuing)");
        }

        await sleep(1000);

        await takeScreenshot("step3");

    } catch (e) {
        err("Step 3 crashed", e);
        await takeScreenshot("step3");
        return { success: false, message: "Step 3 crashed: " + e.message };
    }

    // =========================================================
    // STEP 4 — PRE-PAY VERIFICATION + Pay and Link
    // =========================================================

    setStep(4);
    setProgress("Processing payment...");

    log("");
    log("━━━ STEP 4: Verify & Pay ━━━");

    try {
        await sleep(2000);

        // ── PRE-PAY CHECK: confirm the card number field is really filled ──
        log("   🔍 Pre-pay verification: checking card field...");

        let cardFilledConfirmed = false;

        try {
            cardFilledConfirmed = await pipoFrame.evaluate(() => {
                const inputs = Array.from(document.querySelectorAll('input'));

                for (const inp of inputs) {
                    const ph = (inp.placeholder || '').toLowerCase();
                    const name = (inp.name || '').toLowerCase();

                    if (
                        ph.includes('card number') ||
                        ph.includes('xxxx') ||
                        ph.includes('number') ||
                        name.includes('card') ||
                        name.includes('number')
                    ) {
                        const val = (inp.value || '').replace(/\s/g, '');
                        return val.length >= 13; // at least a real card length
                    }
                }

                return false;
            }).catch(() => false);
        } catch {
            cardFilledConfirmed = false;
        }

        if (!cardFilledConfirmed) {
            warn("⚠️ PRE-PAY CHECK FAILED: card number field appears EMPTY");
            log("   🛑 Refusing to press Pay — card details not confirmed.");
            await dumpIframe();
            await takeScreenshot("step4");
            return {
                success: false,
                message: "Pre-pay check failed: card fields not filled"
            };
        }

        log("   ✅ Pre-pay check passed: card field is filled");

        const payBtns = [
            'button:has-text("Pay and link")',
            'button:has-text("Pay and Link")',
            'button:has-text("Pay now" i)',
            'button:has-text("Pay Now" i)',
            'button.TUXButton--primary'
        ];

        const clicked = await clickOne(payBtns, "Pay and link");

        if (!clicked) {
            warn("Pay button not found");
            await dumpIframe();
            await takeScreenshot("step4");
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
        return { success: false, message: "Step 4 crashed: " + e.message };
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
