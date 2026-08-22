const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);

const TRANSITIONS = {
    pending: new Set(["waiting_link", "login_required", "cancelled"]),
    waiting_link: new Set(["processing", "cancelled"]),
    login_required: new Set(["processing", "failed", "cancelled"]),
    processing: new Set(["verifying", "completed", "failed"]),
    verifying: new Set(["completed", "failed"]),
    retryable: new Set(["waiting_link", "cancelled"]),
    completed: new Set(),
    failed: new Set(),
    cancelled: new Set()
};

function normalizeState(value) {
    const state = String(value || "pending").trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(TRANSITIONS, state) ? state : "pending";
}

function canTransition(from, to) {
    const source = normalizeState(from);
    const target = normalizeState(to);
    return source === target || Boolean(TRANSITIONS[source]?.has(target));
}

function isTerminal(value) {
    return TERMINAL_STATES.has(normalizeState(value));
}

function claimable(value) {
    const state = normalizeState(value);
    return state === "waiting_link" || state === "pending" || state === "retryable";
}

module.exports = {
    TRANSITIONS,
    TERMINAL_STATES,
    normalizeState,
    canTransition,
    isTerminal,
    claimable
};
