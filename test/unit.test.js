const assert = require("assert");
const orderState = require("../bot/orderState");

async function testOrderState() {
    assert.equal(orderState.canTransition("waiting_link", "processing"), true);
    assert.equal(orderState.canTransition("completed", "processing"), false);
    assert.equal(orderState.canTransition("failed", "completed"), false);
    assert.equal(orderState.claimable("waiting_link"), true);
    assert.equal(orderState.claimable("completed"), false);
}

async function testApiContract() {
    const previousFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, options) => {
        calls.push({ url, options });
        if (url.endsWith("/api/tiktok/orders/pending")) {
            return { ok: true, json: async () => ({ ok: true, orders: [{ id: "42", coins: 100 }] }) };
        }
        if (url.endsWith("/api/tiktok/order/claim")) {
            return { ok: true, json: async () => ({ ok: true, order: { id: "42" } }) };
        }
        return { ok: true, json: async () => ({ ok: true }) };
    };
    process.env.TIKTOK_BOT_TOKEN = "unit-test-token";
    delete require.cache[require.resolve("../config")];
    delete require.cache[require.resolve("../bot/api")];
    const api = require("../bot/api");
    const order = await api.getPendingOrder();
    assert.equal(order.order_id, "42");
    assert.equal(calls[0].options.method, "GET");
    assert.ok(await api.claimOrder(order));
    assert.equal(calls[1].options.method, "POST");
    assert.equal(calls[1].options.headers.Authorization, "Bearer unit-test-token");
    global.fetch = previousFetch;
}

async function testCustomQuantityFailsSafelyWithoutTikTokSupport() {
    delete require.cache[require.resolve("../data/runFullSequence")];
    const { runFullSequence } = require("../data/runFullSequence");
    const page = {
        goto: async () => {},
        waitForLoadState: async () => {},
        evaluate: async () => [],
        locator: () => ({
            first() { return this; },
            count: async () => 0,
            filter() { return this; },
            click: async () => { throw new Error("not found"); },
            isVisible: async () => false
        })
    };
    const result = await runFullSequence({
        page,
        order: { order_id: "unit-custom", coins: 777 },
        CONFIG: {},
        CARD_FILE: "missing-card.json",
        sleep: async () => {},
        log: () => {}, warn: () => {}, err: () => {},
        takeScreenshot: async () => {}, clickOne: async () => false,
        fillInIframe: async () => false, dumpIframe: async () => {},
        getState: () => ({ setStep() {}, setProgress() {}, setPaymentStep: async () => {} })
    });
    assert.equal(result.success, false);
    assert.equal(result.failureCode, "UNSUPPORTED_COIN_AMOUNT");
}

(async () => {
    await testOrderState();
    await testApiContract();
    await testCustomQuantityFailsSafelyWithoutTikTokSupport();
    console.log("BOT_UNIT_TESTS_OK");
})().catch(error => {
    console.error(error);
    process.exit(1);
});
