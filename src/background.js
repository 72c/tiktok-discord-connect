/*
 * Discord Connections+ - background worker
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Toolbar button / Alt+Shift+C: toggle the panel in the current Discord tab,
 * or focus (or open) a Discord tab if you are somewhere else.
 */
const DISCORD_URLS = ["https://discord.com/*", "https://ptb.discord.com/*", "https://canary.discord.com/*"];
const DISCORD_RE = /^https:\/\/(?:(?:ptb|canary)\.)?discord\.com\//;

async function toggleIn(tabId) {
    try {
        await chrome.tabs.sendMessage(tabId, { type: "dcplus:toggle" });
        return;
    } catch {
        // The tab was open before the extension was installed, so the content
        // scripts are not in it yet. Inject them now. Unhiding still works this
        // way; a reload just makes it apply a bit earlier.
    }
    await chrome.scripting.executeScript({ target: { tabId }, files: ["src/page.js"], world: "MAIN" });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["src/bridge.js"] });
    await chrome.tabs.sendMessage(tabId, { type: "dcplus:toggle" });
}

function toggleWhenLoaded(tabId) {
    const listener = (id, info) => {
        if (id !== tabId || info.status !== "complete") return;
        chrome.tabs.onUpdated.removeListener(listener);
        toggleIn(tabId).catch(err => console.warn("[Connections+]", err));
    };
    chrome.tabs.onUpdated.addListener(listener);
}

chrome.action.onClicked.addListener(async tab => {
    try {
        if (tab?.id != null && DISCORD_RE.test(tab.url ?? "")) {
            await toggleIn(tab.id);
            return;
        }

        const [existing] = await chrome.tabs.query({ url: DISCORD_URLS });
        if (existing?.id != null) {
            await chrome.tabs.update(existing.id, { active: true });
            if (existing.windowId != null) await chrome.windows.update(existing.windowId, { focused: true });
            await toggleIn(existing.id);
            return;
        }

        const created = await chrome.tabs.create({ url: "https://discord.com/channels/@me" });
        if (created.id != null) toggleWhenLoaded(created.id);
    } catch (err) {
        console.warn("[Connections+]", err);
    }
});
