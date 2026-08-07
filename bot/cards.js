const fs = require("fs");
const path = require("path");
const CONFIG = require("../config");

const CARD_FILE = path.resolve(__dirname, "..", CONFIG.CARD_FILE);

function normalizeCard(card, index = 0) {
    if (!card || typeof card !== "object") return null;

    const number = String(
        card.number ||
        card.cardNumber ||
        card.card_number ||
        ""
    ).replace(/\s+/g, "");

    const expiry =
        card.expiry ||
        card.expire ||
        card.expiration ||
        card.expiryDate ||
        "";

    const cvv = String(
        card.cvv ||
        card.cvc ||
        card.securityCode ||
        ""
    ).trim();

    if (!number || !expiry || !cvv) {
        return null;
    }

    return {
        id: card.id || `card_${index + 1}`,
        number,
        expiry: String(expiry).trim(),
        cvv,
        name: card.name || card.cardholder || "",
        enabled: card.enabled !== false
    };
}

function readRawCards() {
    if (!fs.existsSync(CARD_FILE)) {
        throw new Error(`Card file not found: ${CARD_FILE}`);
    }

    const raw = fs.readFileSync(CARD_FILE, "utf8").trim();

    if (!raw) {
        throw new Error("Card file is empty");
    }

    let data;

    try {
        data = JSON.parse(raw);
    } catch (error) {
        throw new Error(`Invalid card.json JSON: ${error.message}`);
    }

    if (Array.isArray(data)) {
        return data;
    }

    if (Array.isArray(data.cards)) {
        return data.cards;
    }

    if (data.card && typeof data.card === "object") {
        return [data.card];
    }

    if (typeof data === "object") {
        return [data];
    }

    throw new Error("Unsupported cards.json format");
}

function getCards() {
    return readRawCards()
        .map((card, index) => normalizeCard(card, index))
        .filter(Boolean);
}

function getActiveCards() {
    return getCards().filter(card => card.enabled !== false);
}

function getCard(index = 0) {
    const cards = getActiveCards();

    if (!cards.length) {
        throw new Error("No active cards available");
    }

    if (index < 0 || index >= cards.length) {
        throw new Error(`Card index ${index} does not exist`);
    }

    return cards[index];
}

function getFirstCard() {
    return getCard(0);
}

function maskNumber(number) {
    const value = String(number || "");

    if (value.length < 8) {
        return "****";
    }

    return `${value.slice(0, 4)} **** **** ${value.slice(-4)}`;
}

function getSafeCardsInfo() {
    return getActiveCards().map(card => ({
        id: card.id,
        number: maskNumber(card.number),
        expiry: card.expiry,
        name: card.name
    }));
}

function validateCard(card) {
    const errors = [];

    if (!card) {
        errors.push("Card is missing");
        return {
            valid: false,
            errors
        };
    }

    if (!/^\d{12,19}$/.test(card.number)) {
        errors.push("Invalid card number");
    }

    if (!card.expiry) {
        errors.push("Missing expiry");
    }

    if (!/^\d{3,4}$/.test(card.cvv)) {
        errors.push("Invalid CVV");
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

function getCardForOrder(order = {}) {
    const cards = getActiveCards();

    if (!cards.length) {
        throw new Error("No active payment cards configured");
    }

    /*
     * إذا كان الموقع مستقبلاً يرسل card_id
     * نستخدم البطاقة المطلوبة.
     */
    if (order.card_id) {
        const selected = cards.find(
            card => String(card.id) === String(order.card_id)
        );

        if (!selected) {
            throw new Error(`Requested card ${order.card_id} not found`);
        }

        return selected;
    }

    /*
     * حاليًا نستخدم أول بطاقة فعالة.
     * يمكن لاحقًا إضافة rotation / fallback.
     */
    return cards[0];
}

module.exports = {
    getCards,
    getActiveCards,
    getCard,
    getFirstCard,
    getCardForOrder,
    getSafeCardsInfo,
    validateCard,
    maskNumber
};
