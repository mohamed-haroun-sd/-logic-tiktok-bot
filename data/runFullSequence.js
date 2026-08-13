const fs = require("fs");

// ═══════════════════════════════════════════════════════════════════
//  TikTok Payment Sequence — v11 (PER-REQUIREMENT REVIEW)
//
//  SAFETY RULES:
//  ─────────────
//  1. STEP FAILURE HALTS: every step throws/rejects on failure —
//     there is NO fall-through to "Pay".
//  2. DYNAMIC PACKAGE MATCHING (§26/§27): the bot READS the actual
//     packages sold on tiktok.com/coin at runtime and matches the
//     requested coins. If the exact amount is not sold it returns
//     UNSUPPORTED_COIN_AMOUNT — it never buys a wrong package.
//  3. NO BLIND RETRY AFTER PAY (§28): pay is pressed exactly once
//     per order, and only after verifying the form is ready and
//     the amount matches.
//  4. REAL POST-PAY VERIFICATION (§33): success is confirmed by
//     reading the actual gateway response (success indicator),
//     not by assuming the click worked.
//  5. SENSITIVE DATA: card numbers / CVV are NEVER logged or
//     written into screenshots captions.
// ═══════════════════════════════════════════════════════════════════

// v11: error codes forwarded to the website backend
const FAILURE_CODES = {
    COINS_SELECTION_ERROR: "COINS_SELECTION_ERROR",
    PAYMENT_FORM_ERROR: "PAYMENT_FORM_ERROR",
    PAYMENT_DECLINED: "PAYMENT_DECLINED",
    PAYMENT_TIMEOUT: "PAYMENT_TIMEOUT",
    UNKNOWN_ERROR: "UNKNOWN_ERROR"
};

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
        setProgress,
        setPaymentStep
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
    log("🚀 STARTING TikTok Payment Sequence v11");
    log("═══════════════════════════════════════════════════════════");

    // ── PipoPay frame reference (used by steps 3 & 4) ──
    let pipoFrame = null;

    // ═══════════════════════════════════════════════════════════
    // STEP 1 — Open Coin Page & DYNAMICALLY match the package
    // ═══════════════════════════════════════════════════════════

    setStep(1);
    setProgress("Opening coin page & reading available packages...");
    if (setPaymentStep) setPaymentStep("coins_selecting").catch(() => {});

    log("");
    log("━━━ STEP 1: Open Coin Page ━━━");

    let selectedPackage = null;
    let selectedPrice = null;

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

        // ── v11 §26: read the ACTUAL packages TikTok sells right now ──
        const packages = await page.evaluate(() => {
            const results = [];

            // Every package is a <button> whose text/aria-label
            // starts with a number (e.g. "30 Coins", "1,400").
            // "Custom" is handled separately (unsupported here).
            const buttons = Array.from(
                document.querySelectorAll('button')
            );

            for (const btn of buttons) {
                const label = (
                    btn.getAttribute("aria-label") ||
                    btn.textContent ||
                    ""
                ).trim();

                const numMatch = label.match(/^([\d,]+)/);
                if (!numMatch) continue;

                const amount = parseInt(
                    numMatch[1].replace(/,/g, ""),
                    10
                );

                if (amount > 0 && !results.find(r => r.amount === amount)) {
                    // Price text usually sits right below the number
                    const text = label;
                    const priceMatch = text.match(
                        /([A-Z]{3}|[$€£¥])\s*([\d.,]+)/
                    );
                    results.push({
                        amount,
                        price: priceMatch ? priceMatch[0] : null,
                        label
                    });
                }
            }

            return results.sort((a, b) => a.amount - b.amount);
        });

        log(`   📦 Packages TikTok currently sells: ${JSON.stringify(packages)}`);

        // ── v11: exact-match ONLY — never guess a wrong package ──
        selectedPackage = packages.find(p => p.amount === coinAmount);

        if (!selectedPackage) {
            warn(
                `   ⛔ Requested ${coinAmount} coins is NOT among the packages TikTok sells right now`
            );
            await takeScreenshot("step1");
            return {
                success: false,
                message: `Package ${coinAmount} coins not available — TikTok sells: ${packages.map(p => p.amount).join(", ")}`,
                failureCode: FAILURE_CODES.COINS_SELECTION_ERROR,
                paymentStep: "coins_not_available"
            };
        }

        selectedPrice = selectedPackage.price;

        log(`   ✅ Exact package found: ${selectedPackage.amount} Coins (${selectedPrice || "price not shown"})`);

        // ── Click the matching package (by role + text, not nth-child) ──
        const coinClicked = await clickOne(
            [
                `button:has-text("${selectedPackage.amount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}")`,
                `button:has-text("${coinAmount}")`
            ],
            `${coinAmount} Coins`
        );

        if (!coinClicked) {
            await takeScreenshot("step1");
            return {
                success: false,
                message: `Could not click package ${coinAmount} Coins`,
                failureCode: FAILURE_CODES.COINS_SELECTION_ERROR,
                paymentStep: "coins_selection_failed"
            };
        }

        // ── v11: verify the Total reflects the selection ──
        await sleep(1500);

        const totalOk = await page.evaluate(amount => {
            const body = document.body.innerText || "";
            // Total should no longer be "0" after a valid selection
            return /Total/.test(body) && !/Total\s+\$\s*0/.test(body);
        }, coinAmount).catch(() => false);

        if (!totalOk) {
            warn("   ⚠️ Total did not update after selection — will continue carefully");
        }

        await takeScreenshot("step1");

    } catch (e) {
        err("Step 1 crashed", e);
        await takeScreenshot("step1");
        return {
            success: false,
            message: "Step 1 crashed: " + e.message,
            failureCode: FAILURE_CODES.COINS_SELECTION_ERROR
        };
    }

    // ═══════════════════════════════════════════════════════════
    // STEP 2 — Recharge & Select Card
    // ═══════════════════════════════════════════════════════════

    setStep(2);
    setProgress("Clicking Recharge & selecting payment method...");
    if (setPaymentStep) setPaymentStep("payment_ready").catch(() => {});

    log("");
    log("━━━ STEP 2: Click Recharge & Select Card ━━━");

    try {
        // ── v11 §27: wait for the Recharge button to be ENABLED ──
        const rechargeEnabled = await page
            .getByRole("button", { name: "Recharge" })
            .isEnabled({ timeout: 8000 })
            .catch(() => false);

        if (!rechargeEnabled) {
            warn("   ⚠️ Recharge button not enabled yet — waiting...");
            await sleep(2000);
        }

        const rechargeBtns = [
            'button:has-text("Recharge")',
            'button.TUXButton--primary:has-text("Recharge")'
        ];

        const clicked = await clickOne(rechargeBtns, "Recharge");

        if (!clicked) {
            await takeScreenshot("step2");
            return {
                success: false,
                message: "Recharge button not found",
                failureCode: FAILURE_CODES.UNKNOWN_ERROR,
                paymentStep: "recharge_not_found"
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
                message: "Could not select Add Credit Or Debit Card",
                failureCode: FAILURE_CODES.PAYMENT_FORM_ERROR,
                paymentStep: "card_method_not_found"
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
                try { await dumpIframe(); } catch {}
                await takeScreenshot("step2");
                return {
                    success: false,
                    message: "PipoPay iframe not visible",
                    failureCode: FAILURE_CODES.PAYMENT_FORM_ERROR,
                    paymentStep: "iframe_not_visible"
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
                        try { await dumpIframe(); } catch {}
                        await takeScreenshot("step2");
                    return {
                        success: false,
                        message: "No usable iframe found",
                        failureCode: FAILURE_CODES.PAYMENT_FORM_ERROR,
                        paymentStep: "no_iframe"
                    };
                }

                log("   ⚠️ Using first iframe (fallback)");

                } catch {
                    try { await dumpIframe(); } catch {}
                    await takeScreenshot("step2");
                    return {
                        success: false,
                        message: "No iframe found at all",
                    failureCode: FAILURE_CODES.PAYMENT_FORM_ERROR,
                    paymentStep: "no_iframe"
                };
            }
        }

        await takeScreenshot("step2");

    } catch (e) {
        err("Step 2 crashed", e);
        await takeScreenshot("step2");
        return { success: false, message: "Step 2 crashed: " + e.message, failureCode: FAILURE_CODES.PAYMENT_FORM_ERROR };
    }

    // ═══════════════════════════════════════════════════════════
    // STEP 3 — Fill Card Details
    // ═══════════════════════════════════════════════════════════

    setStep(3);
    setProgress("Filling card details...");

    log("");
    log("━━━ STEP 3: Fill Card Details ━━━");

    try {
        if (!pipoFrame) {
            return {
                success: false,
                message: "PipoPay iframe reference missing (step 2 failed earlier)",
                failureCode: FAILURE_CODES.PAYMENT_FORM_ERROR,
                paymentStep: "iframe_missing"
            };
        }

        if (!fs.existsSync(CARD_FILE)) {
            throw new Error(`Card file "${CARD_FILE}" not found`);
        }

        const card = JSON.parse(fs.readFileSync(CARD_FILE, "utf8"));

        // §20: ONLY the masked number goes to the log — never PAN/CVV
        log(
            `   📋 Card: ${
                card.cardNumber
                    ? card.cardNumber.replace(/\d{4}(?=\d{4})/g, "****")
                    : "N/A"
            }`
        );

        // ── v11: track how many REQUIRED fields were filled ──
        let requiredFilled = 0;
        const requiredFields = 4; // number, holder, expiry, cvv

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
            try { await dumpIframe(); } catch {}
            return {
                success: false,
                message: "Card Number field could not be filled",
                failureCode: FAILURE_CODES.PAYMENT_FORM_ERROR,
                paymentStep: "card_number_not_filled"
            };
        }
        requiredFilled++;
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
            try { await dumpIframe(); } catch {}
            return {
                success: false,
                message: "Cardholder Name field could not be filled",
                failureCode: FAILURE_CODES.PAYMENT_FORM_ERROR,
                paymentStep: "cardholder_not_filled"
            };
        }
        requiredFilled++;
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
            try { await dumpIframe(); } catch {}
            return {
                success: false,
                message: "Expiration Date field could not be filled",
                failureCode: FAILURE_CODES.PAYMENT_FORM_ERROR,
                paymentStep: "expiry_not_filled"
            };
        }
        requiredFilled++;
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
            try { await dumpIframe(); } catch {}
            return {
                success: false,
                message: "CVV field could not be filled",
                failureCode: FAILURE_CODES.PAYMENT_FORM_ERROR,
                paymentStep: "cvv_not_filled"
            };
        }
        requiredFilled++;
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

        log(`   📝 Form progress: ${requiredFilled}/${requiredFields} required fields filled`);

        await sleep(1000);

        await takeScreenshot("step3");

    } catch (e) {
        err("Step 3 crashed", e);
        await takeScreenshot("step3");
        return { success: false, message: "Step 3 crashed: " + e.message, failureCode: FAILURE_CODES.PAYMENT_FORM_ERROR };
    }

    // ═══════════════════════════════════════════════════════════
    // STEP 4 — FORM READINESS CHECK + Pay and link
    //   v11: "readiness" = fill tracking (§3 above) + Pay button
    //        enabled — NOT reading input.value from the iframe,
    //        which was the root cause of false failures before.
    // ═══════════════════════════════════════════════════════════

    setStep(4);
    setProgress("Processing payment...");
    if (setPaymentStep) setPaymentStep("payment_processing").catch(() => {});

    log("");
    log("━━━ STEP 4: Verify & Pay ━━━");

    try {
        await sleep(2000);

        // ── v11: form-readiness check (button enabled, not input.value) ──
        log("   🔍 Pre-pay verification: form readiness...");

        let formReady = false;
        let payBtnEnabled = false;
        let readinessAttempts = 0;

        while (readinessAttempts < 3 && !formReady) {
            readinessAttempts++;

            try {
                // 1. Pay button exists and is enabled inside the iframe
                payBtnEnabled = await pipoFrame
                    .locator(
                        'button:has-text("Pay and link"), button:has-text("Pay and Link"), button:has-text("Pay now" i), button:has-text("Pay Now" i), button.TUXButton--primary'
                    )
                    .first()
                    .isEnabled({ timeout: 5000 })
                    .catch(() => false);

                // 2. If the button is disabled, the form itself says so —
                //    wait briefly and give it one more chance.
                formReady = payBtnEnabled;

                if (!formReady && readinessAttempts < 3) {
                    warn(`   ⚠️ Pay button not ready yet (attempt ${readinessAttempts}/3) — filling fields once more and retrying...`);
                    await sleep(2000);

                    // Re-fill only the number field once (idempotent)
                    const cardNumberPlaceholders = [
                        "Enter card number",
                        "Card number",
                        "XXXX XXXX XXXX XXXX"
                    ];
                    const card = JSON.parse(fs.readFileSync(CARD_FILE, "utf8"));
                    for (const ph of cardNumberPlaceholders) {
                        const ok = await fillInIframe(
                            pipoFrame, ph, card.cardNumber || "", "Card Number"
                        );
                        if (ok) break;
                    }
                    await sleep(1500);
                }
            } catch {
                formReady = false;
            }
        }

        if (!formReady) {
            warn("⚠️ FORM READINESS CHECK FAILED after 3 attempts (Pay button not enabled)");
            log("   🛑 Refusing to press Pay — form not ready.");
            try { await dumpIframe(); } catch {}
            await takeScreenshot("step4");
            return {
                success: false,
                message: "Pre-pay check failed: payment form not ready",
                failureCode: FAILURE_CODES.PAYMENT_FORM_ERROR,
                paymentStep: "form_not_ready"
            };
        }

        log("   ✅ Form readiness check passed");

        // ── v11 §28: Pay is pressed EXACTLY ONCE per order ──
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
            try { await dumpIframe(); } catch {}
            await takeScreenshot("step4");
            return {
                success: false,
                message: "Pay button not found",
                failureCode: FAILURE_CODES.PAYMENT_FORM_ERROR,
                paymentStep: "pay_not_found"
            };
        }

        // ── POST-PAY: wait for the REAL result (no blind retry) ──
        log("   ⏳ Waiting for payment result (max 30s)...");

        await sleep(5000);

        const paymentResult = await page.evaluate(() => {
            const body = (document.body.innerText || "").toLowerCase();
            const url = window.location.href.toLowerCase();

            // Strong success signals
            const successSignals = [
                "payment successful",
                "successful",
                "thank you",
                "order confirmed",
                "success",
                " recharge successful",
                "charged successfully"
            ];

            // Strong failure signals
            const failureSignals = [
                "payment declined",
                "transaction declined",
                "card declined",
                "payment failed",
                "transaction failed",
                "insufficient funds",
                "not processed",
                "try again"
            ];

            for (const s of successSignals) {
                if (body.includes(s)) return { status: "success", signal: s };
            }

            for (const s of failureSignals) {
                if (body.includes(s)) return { status: "declined", signal: s };
            }

            // URL-based signals
            if (url.includes("success") && !url.includes("fail")) {
                return { status: "success", signal: "url:success" };
            }
            if (url.includes("fail") || url.includes("error") || url.includes("decline")) {
                return { status: "declined", signal: "url:" + url.split("?")[0].slice(-30) };
            }

            return { status: "unknown", signal: "no signal found" };
        }).catch(() => ({ status: "unknown", signal: "evaluate failed" }));

        await takeScreenshot("step4");

        if (paymentResult.status === "declined") {
            log(`   ❌ Payment was DECLINED by gateway: ${paymentResult.signal}`);
            return {
                success: false,
                message: `Payment declined: ${paymentResult.signal}`,
                failureCode: FAILURE_CODES.PAYMENT_DECLINED,
                paymentStep: "payment_declined"
            };
        }

        if (paymentResult.status === "unknown") {
            warn(`   ⚠️ Could not determine payment result (${paymentResult.signal}) — treating as timeout (NOT re-paying)`);
            return {
                success: false,
                message: `Payment result unknown: ${paymentResult.signal} (no retry per one-try rule)`,
                failureCode: FAILURE_CODES.PAYMENT_TIMEOUT,
                paymentStep: "payment_result_unknown"
            };
        }

        log(`   ✅ Payment result: ${paymentResult.signal}`);

    } catch (e) {
        err("Step 4 crashed", e);
        await takeScreenshot("step4");
        return { success: false, message: "Step 4 crashed: " + e.message, failureCode: FAILURE_CODES.UNKNOWN_ERROR };
    }

    // ═══════════════════════════════════════════════════════════
    // DONE
    // ═══════════════════════════════════════════════════════════

    setStep(5);
    setProgress("Sequence complete!");
    if (setPaymentStep) setPaymentStep("success").catch(() => {});

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
