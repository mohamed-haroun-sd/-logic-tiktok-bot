const api = require("./api");
const utils = require("./utils");

let running = false;
let currentOrder = null;

function isRunning() {
    return running;
}

function getCurrentOrder() {
    return currentOrder;
}

async function updateOrder(orderOrData, data = {}) {
    // ── FIX ROOT CAUSE: accept an explicit order so claims work
    //    even when currentOrder is null (before the order is claimed) ──
    let order = null;
    let payload = {};

    if (orderOrData && orderOrData.order_id) {
        order = orderOrData;
        payload = data;
    } else if (currentOrder) {
        order = currentOrder;
        payload = orderOrData || {};
    } else {
        utils.error("updateOrder: no order context available");
        return false;
    }

    try {
        await api.updateOrder(order, payload);

        return true;

    } catch (err) {
        utils.error(
            `Failed to update order ${order.order_id}:`,
            utils.sanitizeError(err)
        );

        return false;
    }
}

async function getPendingOrder() {
    try {
        const order = await api.getPendingOrder();

        if (!order) {
            return null;
        }

        if (!utils.isValidOrder(order)) {
            utils.error("Invalid order received from website API");
            return null;
        }

        return order;

    } catch (err) {
        utils.error(
            "Failed to get pending order:",
            utils.sanitizeError(err)
        );

        return null;
    }
}

async function claimOrder(order) {
    if (running) {
        return false;
    }

    if (!utils.isValidOrder(order)) {
        return false;
    }

    // Atomic backend claim: the server must transition the order once.
    // A plain update is not enough because two workers can race after GET.
    const claimed = await api.claimOrder(order);

    if (!claimed) {
        utils.error(
            `Could not atomically claim order ${order.order_id}`
        );
        return false;
    }

    running = true;
    currentOrder = order;

    global.CURRENT_ORDER = order;

    utils.log(
        `📦 Order claimed: ${order.order_id} → processing`
    );

    return true;
}

function releaseOrder() {
    running = false;
    currentOrder = null;

    global.CURRENT_ORDER = null;
}

// v11: failOrder accepts { message, paymentStep, failureCode } so the
// website can display a precise failure reason to the merchant.
async function failOrder(orderOrMessage, errorMessage = null) {
    // ── Explicit-order variant so failures never crash ──
    let order = null;
    let message = null;
    let paymentStep = null;
    let failureCode = null;

    if (typeof orderOrMessage === "object" && orderOrMessage?.order_id) {
        order = orderOrMessage;
        const detail = errorMessage || {};
        message = (typeof detail === "object" ? detail.message : detail) || "unknown";
        paymentStep = detail?.paymentStep || null;
        failureCode = detail?.failureCode || null;
    } else if (currentOrder) {
        order = currentOrder;
        const detail = orderOrMessage || {};
        message = (typeof detail === "object" ? detail.message : detail) || "unknown";
        paymentStep = detail?.paymentStep || null;
        failureCode = detail?.failureCode || null;
    } else {
        utils.error("failOrder: no order context");
        return;
    }

    const payload = {
        status: "failed",
        charge_status: "failed",
        failure_message: message,
        failure_code: failureCode || message
    };

    if (paymentStep) {
        payload.payment_step = paymentStep;
    }

    await updateOrder(order, payload);

    utils.log(
        `❌ Order ${order.order_id} marked as FAILED: ${message}${failureCode ? " [" + failureCode + "]" : ""}`
    );

    releaseOrder();
    return true;
}

async function completeOrder(orderOrData = {}) {
    // ── Explicit-order variant ──
    let order = null;
    let extraData = {};

    if (typeof orderOrData === "object" && orderOrData?.order_id) {
        order = orderOrData;
        extraData = {};
    } else if (currentOrder) {
        order = currentOrder;
        extraData = orderOrData || {};
    } else {
        utils.error("completeOrder: no order context");
        return;
    }

    await updateOrder(order, {
        status: "completed",
        charge_status: "completed",
        payment_step: "success",
        ...extraData
    });

    utils.log(
        `✅ Order ${order.order_id} marked as COMPLETED`
    );

    releaseOrder();
    return true;
}

async function process(handler) {
    if (running) {
        return {
            ok: false,
            reason: "worker_busy"
        };
    }

    const order = await getPendingOrder();

    if (!order) {
        return {
            ok: false,
            reason: "no_order"
        };
    }

    const claimed = await claimOrder(order);

    if (!claimed) {
        return {
            ok: false,
            reason: "claim_failed"
        };
    }

    try {
        if (typeof handler !== "function") {
            throw new Error(
                "Worker handler is not a function"
            );
        }

        const result = await handler(
            currentOrder,
            {
                updateOrder,
                completeOrder,
                failOrder
            }
        );

        if (running) {
            releaseOrder();
        }

        return {
            ok: true,
            order,
            result
        };

    } catch (err) {

        const message = utils.sanitizeError(err);

        utils.error(
            `Order ${order.order_id} failed:`,
            message
        );

        await failOrder(message);

        return {
            ok: false,
            order,
            error: message
        };
    }
}

async function sendLoginLink(orderOrLink, loginLink = null, expiresSeconds = 120) {
    // ── Explicit-order variant so QR link delivery never crashes ──
    let order = null;
    let link = null;

    if (typeof orderOrLink === "object" && orderOrLink?.order_id) {
        order = orderOrLink;
        link = loginLink;
    } else if (currentOrder) {
        order = currentOrder;
        link = orderOrLink;
    } else {
        utils.error("sendLoginLink: no order context");
        return false;
    }

    if (!link) {
        utils.error("sendLoginLink: no login link provided");
        return false;
    }

    try {
        const sent = await api.sendLoginLink(order, link, expiresSeconds);
        if (sent) {
            utils.log(`📤 Login link delivered for order ${order.order_id}`);
        }
        return sent;
    } catch (err) {
        utils.error(
            `Failed to send login link for ${order.order_id}:`,
            utils.sanitizeError(err)
        );
        return false;
    }
}

module.exports = {
    isRunning,
    getCurrentOrder,
    getPendingOrder,
    updateOrder,
    claimOrder,
    releaseOrder,
    failOrder,
    completeOrder,
    sendLoginLink,
    process
};
