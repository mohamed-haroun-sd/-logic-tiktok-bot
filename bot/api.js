const CONFIG = require("../config");

async function retryWithBackoff(fn, attempts = 3, label = "API call") {
    let lastError = null;
    for (let i = 1; i <= attempts; i++) {
        try {
            const result = await fn();
            if (result) return result;
            lastError = new Error(`HTTP non-ok on attempt ${i}`);
        } catch (error) {
            lastError = error;
        }
        if (i < attempts) await new Promise(resolve => setTimeout(resolve, i * 1000));
    }
    console.error(`[API] ${label} failed after ${attempts} attempts: ${lastError?.message || "unknown"}`);
    return false;
}

function headers(extra = {}) {
    const result = { Accept: "application/json", ...extra };
    if (CONFIG.BOT_API_TOKEN) result.Authorization = `Bearer ${CONFIG.BOT_API_TOKEN}`;
    return result;
}

async function request(path, options = {}) {
    const response = await fetch(`${CONFIG.WEBSITE_API}${path}`, {
        ...options,
        headers: headers(options.headers || {}),
        signal: options.signal || AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

async function getPendingOrder() {
    try {
        const data = await request("/api/tiktok/orders/pending", { method: "GET" });
        if (!data?.ok || !Array.isArray(data.orders) || data.orders.length === 0) return null;
        const order = { ...data.orders[0] };
        order.order_id = order.order_id || order.id || order._id;
        return order.order_id ? order : null;
    } catch (error) {
        console.error(`[API] getPendingOrder failed: ${error.message}`);
        return null;
    }
}

async function claimOrder(order) {
    if (!order?.order_id) return false;
    return retryWithBackoff(async () => {
        const data = await request("/api/tiktok/order/claim", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ order_id: order.order_id })
        });
        return data?.ok ? data.order || true : false;
    }, 3, `claimOrder(${order.order_id})`);
}

async function updateOrder(order, data = {}) {
    if (!order?.order_id) return false;
    return retryWithBackoff(async () => {
        const result = await request("/api/tiktok/order/update", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ order_id: order.order_id, ...data })
        });
        return result?.ok === true;
    }, 3, `updateOrder(${order.order_id})`);
}

async function sendLoginLink(order, loginLink, expiresSeconds = CONFIG.QR_TTL_SECONDS, extra = {}) {
    if (!order?.order_id || !loginLink) return false;
    const expires = Math.floor(Date.now() / 1000) + expiresSeconds;
    return updateOrder(order, {
        status: "processing",
        payment_step: "qr_ready",
        login_link: loginLink,
        expires,
        ...extra
    });
}

async function completeOrder(order, extra = {}) {
    if (!order?.order_id) return false;
    return updateOrder(order, {
        status: "completed",
        charge_status: "completed",
        payment_step: "success",
        ...extra
    });
}

async function failOrder(order, reason = {}) {
    if (!order?.order_id) return false;
    const detail = typeof reason === "string" ? { message: reason } : (reason || {});
    return updateOrder(order, {
        status: "failed",
        charge_status: "failed",
        failure_message: detail.message || "unknown",
        failure_code: detail.failureCode || detail.message || "UNKNOWN_ERROR",
        payment_step: detail.paymentStep || "failed"
    });
}

module.exports = {
    retryWithBackoff,
    getPendingOrder,
    claimOrder,
    updateOrder,
    sendLoginLink,
    completeOrder,
    failOrder
};
