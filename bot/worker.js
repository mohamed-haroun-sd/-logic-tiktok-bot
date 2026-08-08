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

async function updateOrder(data = {}) {
    if (!currentOrder) {
        return false;
    }

    try {
        await api.updateOrder(currentOrder, data);

        return true;

    } catch (err) {
        utils.error(
            `Failed to update order ${currentOrder.order_id}:`,
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

    // ═══ Atomic backend claim: mark order as "processing" so no
    // other bot instance can ever pull it again ═══
    const claimed = await api.updateOrder(order, {
        status: "processing"
    });

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

async function failOrder(errorMessage) {
    if (!currentOrder) {
        return;
    }

    const orderId = currentOrder.order_id;

    await updateOrder({
        status: "failed",
        charge_status: "failed",
        session_id: errorMessage
    });

    utils.log(
        `❌ Order ${orderId} marked as FAILED: ${errorMessage}`
    );

    releaseOrder();
}

async function completeOrder(extraData = {}) {
    if (!currentOrder) {
        return;
    }

    const orderId = currentOrder.order_id;

    await updateOrder({
        status: "completed",
        charge_status: "completed",
        ...extraData
    });

    utils.log(
        `✅ Order ${orderId} marked as COMPLETED`
    );

    releaseOrder();
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

module.exports = {
    isRunning,
    getCurrentOrder,
    getPendingOrder,
    updateOrder,
    claimOrder,
    releaseOrder,
    failOrder,
    completeOrder,
    process
};
