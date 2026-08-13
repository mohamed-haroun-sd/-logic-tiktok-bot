const CONFIG = require("../config");

// ═══════════════════════════════════════════════════════════════════
//  API Client for Logic Website — HARDENED v2
//  Every mutating call retries up to 3 times, because a failed
//  status update is exactly what caused duplicate charges before.
// ═══════════════════════════════════════════════════════════════════

async function retryWithBackoff(fn, attempts = 3, label = "API call") {
    let lastError = null;

    for (let i = 1; i <= attempts; i++) {
        try {
            const result = await fn();
            if (result) return true;
            lastError = new Error(`HTTP non-ok on attempt ${i}`);
        } catch (error) {
            lastError = error;
        }

        if (i < attempts) {
            const delay = i * 1000; // 1s, 2s, ...
            await new Promise(r => setTimeout(r, delay));
        }
    }

    console.error(`[API] ❌ ${label} failed after ${attempts} attempts: ${lastError?.message}`);
    return false;
}


async function getPendingOrder() {
    try {
        const response = await fetch(
            `${CONFIG.WEBSITE_API}/api/tiktok/orders/pending`,
            {
                method: "GET",
                headers: {
                    "Accept": "application/json"
                },
                signal: AbortSignal.timeout(10000)
            }
        );

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();

        // The API returns { ok, count, orders: [...] }
        if (!data?.ok || !data?.orders || data.orders.length === 0) {
            return null;
        }

        // Take the first pending order
        const order = data.orders[0];

        // Normalize: ensure order_id exists (map id → order_id)
        order.order_id = order.order_id || order.id || order._id;

        return order;

    } catch (error) {
        console.error(
            `[API] getPendingOrder failed: ${error.message}`
        );

        return null;
    }
}


async function updateOrder(order, data = {}) {
    if (!order) {
        return false;
    }

    return retryWithBackoff(async () => {
        const response = await fetch(
            `${CONFIG.WEBSITE_API}/api/tiktok/order/update`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json"
                },
                body: JSON.stringify({
                    order_id: order.order_id,
                    ...data
                }),
                signal: AbortSignal.timeout(10000)
            }
        );

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        return true;
    }, 3, `updateOrder(${order.order_id})`);
}


async function sendLoginLink(order, loginLink, expiresSeconds = 120) {
    if (!order || !loginLink) {
        return false;
    }

    const expires = Math.floor(Date.now() / 1000) + expiresSeconds;

    return retryWithBackoff(async () => {
        const response = await fetch(
            `${CONFIG.WEBSITE_API}/api/tiktok/order/update`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json"
                },
                body: JSON.stringify({
                    order_id: order.order_id,
                    status: "link_ready",
                    login_link: loginLink,
                    expires: expires
                }),
                signal: AbortSignal.timeout(10000)
            }
        );

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        console.log(`[API] ✅ Login link sent for order ${order.order_id}`);
        return true;
    }, 3, `sendLoginLink(${order.order_id})`);
}


async function completeOrder(order) {
    if (!order) {
        return false;
    }

    return retryWithBackoff(async () => {
        const response = await fetch(
            `${CONFIG.WEBSITE_API}/api/tiktok/order/update`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json"
                },
                body: JSON.stringify({
                    order_id: order.order_id,
                    status: "completed",
                    charge_status: "completed"
                }),
                signal: AbortSignal.timeout(10000)
            }
        );

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        console.log(`[API] ✅ Order ${order.order_id} marked as completed`);
        return true;
    }, 3, `completeOrder(${order.order_id})`);
}


async function failOrder(order, reason = "unknown") {
    if (!order) {
        return false;
    }

    return retryWithBackoff(async () => {
        const response = await fetch(
            `${CONFIG.WEBSITE_API}/api/tiktok/order/update`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json"
                },
                body: JSON.stringify({
                    order_id: order.order_id,
                    status: "failed",
                    charge_status: "failed",
                    failure_message: reason,
                    failure_code: reason,
                    session_id: reason
                }),
                signal: AbortSignal.timeout(10000)
            }
        );

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        console.log(`[API] ❌ Order ${order.order_id} marked as failed: ${reason}`);
        return true;
    }, 3, `failOrder(${order.order_id})`);
}


module.exports = {
    getPendingOrder,
    updateOrder,
    sendLoginLink,
    completeOrder,
    failOrder
};
