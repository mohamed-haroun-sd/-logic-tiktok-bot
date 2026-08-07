const CONFIG = require("../config");

let currentProxyIndex = 0;

function getProxies() {
    if (!Array.isArray(CONFIG.PROXIES)) {
        return [];
    }

    return CONFIG.PROXIES.filter(proxy =>
        proxy &&
        proxy.server &&
        proxy.username &&
        proxy.password
    );
}

function getProxy(index = currentProxyIndex) {
    const proxies = getProxies();

    if (proxies.length === 0) {
        return null;
    }

    const safeIndex =
        ((index % proxies.length) + proxies.length) % proxies.length;

    return {
        ...proxies[safeIndex],
        index: safeIndex
    };
}

function getCurrentProxy() {
    return getProxy(currentProxyIndex);
}

function nextProxy() {
    const proxies = getProxies();

    if (proxies.length === 0) {
        return null;
    }

    currentProxyIndex =
        (currentProxyIndex + 1) % proxies.length;

    return getCurrentProxy();
}

function setProxy(index) {
    const proxies = getProxies();

    if (proxies.length === 0) {
        return null;
    }

    if (!Number.isInteger(index)) {
        throw new Error("Proxy index must be an integer");
    }

    currentProxyIndex =
        ((index % proxies.length) + proxies.length) %
        proxies.length;

    return getCurrentProxy();
}

function resetProxy() {
    currentProxyIndex = 0;
    return getCurrentProxy();
}

function getProxyCount() {
    return getProxies().length;
}

function getProxyList() {
    return getProxies().map((proxy, index) => ({
        index,
        name: proxy.name || `Proxy ${index + 1}`,
        server: proxy.server,
        username: proxy.username
    }));
}

function validateProxies() {
    const proxies = getProxies();

    return proxies.every(proxy =>
        typeof proxy.server === "string" &&
        typeof proxy.username === "string" &&
        typeof proxy.password === "string"
    );
}

module.exports = {
    getProxies,
    getProxy,
    getCurrentProxy,
    nextProxy,
    setProxy,
    resetProxy,
    getProxyCount,
    getProxyList,
    validateProxies
};
