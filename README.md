# Discord Connections+

A small browser extension for discord.com that brings back the account connections Discord has hidden, and lets you try linking them.

Discord keeps every connection type in one list in its web client and hides some of them with `enabled: false`. As of November 2026 those are:

| Hidden connection | What to expect |
| --- | --- |
| TikTok | No known blocker. This one is worth trying. |
| Mastodon | Needs your handle (`you@instance.social`). Worth trying. |
| Meta Quest | Unknown. |
| Instagram | Meta shut down the Instagram API Discord used in December 2024. Expect it to fail. |
| Skype | Skype shut down in May 2025. |
| Twitter (legacy) | Replaced by the X connection. |
| Samsung Galaxy | Discontinued by Discord. |

The extension turns those back on in **User Settings > Connections** and adds a **Connections+** panel. The panel starts the real connection flow and shows you exactly what Discord or the platform answered.

## The one thing to know

The browser was never what blocked these connections. I traced Discord's client code: the sign-in link comes from Discord's server (`GET /connections/{type}/authorize`), and the final link-up happens on Discord's server too (`POST /connections/{type}/callback`). The page you're sent back to doesn't check the hidden flag at all.

So this extension gives you the button and the real answer. If Discord's server has switched a platform off, or the platform has shut down its login API (Instagram), no browser extension can change that.

## Install

**Chrome / Edge / Brave / Opera**
1. Open `chrome://extensions` (Edge: `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and pick this folder (the one with `manifest.json`).

**Firefox (128 or newer)**
1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...** and pick `manifest.json`.
   Firefox removes temporary add-ons when it restarts.

If you already had Discord open, it works straight away when you click the button, but reloading the tab once is cleaner.

## Use

1. Open Discord in the browser (discord.com) and log in.
2. Either go to **User Settings > Connections**, where the hidden platforms now appear with the rest,
3. or click the **Connections+** toolbar button (or press **Alt+Shift+C**) to open the panel:
   - **Hidden by Discord** lists the hidden platforms, most promising first.
   - Press **Connect**, finish signing in in the popup window, and watch **Activity**.
   - For Mastodon, type your handle first.
   - **Other connections** has the normal ones too.

What you'll see in Activity:
- **Connected: name**: it worked and the account is on your profile.
- **Discord wouldn't start the connection: ...**: Discord's server refused to give a sign-in link. This is the server's own error message.
- **Discord rejected the connection (error code ...)**: you signed in, but Discord's server refused to finish the link-up.
- **The sign-in window closed and no new connection showed up**: you closed it, or the platform's own sign-in page failed.

## Privacy

- It never reads, stores or sends your Discord token.
- Every request goes through Discord's own code in the page, exactly as when you click a button in Settings.
- It makes no network requests of its own and has no analytics.
- It only runs on `discord.com`, `ptb.discord.com` and `canary.discord.com`.

## How it works

- `src/page.js` runs in Discord's own page context at `document_start`. It catches the moment Discord's webpack runtime registers its modules, wraps the module that defines the platform list, and flips `enabled` to `true` before anything reads it. If that moment is missed (for example in a tab opened before you installed), it finds the list afterwards instead. The panel calls Discord's own `ConnectedAccounts.authorize()`, opens the returned sign-in link in a popup, and lets Discord's normal return page finish the job.
- `src/bridge.js` passes the toolbar button through to the page.
- `src/background.js` handles the toolbar button and shortcut.

This uses the same idea as the **AllConnectionsEnabled** plugin in [Endcord](https://github.com/Endcord/Endcord), a Vencord-based Discord client mod. The difference is that this is a standalone extension of a few hundred lines, not a whole client mod. If you already use Endcord's browser extension, its AllConnectionsEnabled plugin unhides the same platforms; this extension adds the connect panel and the error reporting.

## Caveats

- Modifying the Discord client is against Discord's Terms of Service. This extension only does what the Settings page already does, with a flag flipped, but use it knowing that.
- It hooks into Discord's minified code, so a big Discord update can break it. If the panel says it can't find Discord's connection code, that's what happened.
- Tested on the live discord.com page in Edge 157 while logged out. Unhiding, the panel, the toolbar button's toggle and late injection were all checked, and Connect got Discord's real refusal. The keyboard shortcut runs the same handler but wasn't pressed in testing. Firefox and a full logged-in connection weren't tested.

## License

GPL-3.0-or-later, the same as Endcord. See [LICENSE](LICENSE).
