const CONFIG = require("../config");

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

        if (!data?.ok || !data?.order) {
            return null;
        }

        return data.order;

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


module.exports = {
    getPendingOrder,
    updateOrder
};
