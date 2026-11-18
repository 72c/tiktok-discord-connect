/*
 * Discord Connections+ - extension bridge (isolated world)
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Relays the toolbar button / keyboard shortcut to page.js, which runs in the
 * page's own world and owns the panel. DOM events cross between the two worlds.
 */
(() => {
    if (globalThis.__dcPlusBridge) return;
    globalThis.__dcPlusBridge = true;

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg?.type !== "dcplus:toggle") return;
        window.dispatchEvent(new CustomEvent("dcplus:toggle"));
        sendResponse({ ok: true });
    });
})();
