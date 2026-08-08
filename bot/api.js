const CONFIG = require("../config");

// ═══════════════════════════════════════════════════════════════════
//  API Client for Logic Website
//  Endpoints:
//    GET  /api/tiktok/orders/pending     → { ok, count, orders: [{id, uid, coins, ...}] }
//    POST /api/tiktok/order/update       → update status/login_link/session_id
//    GET  /api/tiktok/order/<id>         → { ok, order: {...} }
// ═══════════════════════════════════════════════════════════════════

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
        // Fix: read orders[] array, not single order
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

    try {
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

    } catch (error) {
        console.error(
            `[API] updateOrder failed: ${error.message}`
        );

        return false;
    }
}


async function sendLoginLink(order, loginLink, expiresSeconds = 120) {
    if (!order || !loginLink) {
        return false;
    }

    try {
        const expires = Math.floor(Date.now() / 1000) + expiresSeconds;

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

    } catch (error) {
        console.error(
            `[API] sendLoginLink failed: ${error.message}`
        );

        return false;
    }
}


async function completeOrder(order) {
    if (!order) {
        return false;
    }

    try {
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

    } catch (error) {
        console.error(
            `[API] completeOrder failed: ${error.message}`
        );

        return false;
    }
}


async function failOrder(order, reason = "unknown") {
    if (!order) {
        return false;
    }

    try {
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

    } catch (error) {
        console.error(
            `[API] failOrder failed: ${error.message}`
        );

        return false;
    }
}


module.exports = {
    getPendingOrder,
    updateOrder,
    sendLoginLink,
    completeOrder,
    failOrder
};
