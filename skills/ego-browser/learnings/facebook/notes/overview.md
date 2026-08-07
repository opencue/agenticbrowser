# Facebook Overview

> **Verified 2026-08-06** against a live logged-in session on
> `facebook.com/groups/claudecommunity`, English UI. Everything in this file was
> read off the real DOM, not inferred. Where a technique was measured, the hit
> rate is given — treat those numbers as the bar a change has to beat.

## What the durable handles actually are

Facebook ships obfuscated, build-generated class names, so nothing here keys off a
class. Two attribute families survive redeploys and are what every tool below uses:

| Handle | What it marks |
|---|---|
| `div[role="feed"]` | the feed container; its **direct children** are the post cards |
| `[data-ad-rendering-role="story_message"]` | the post body — present on every post card |
| `[data-ad-rendering-role="profile_name"]` | the author block (name text + profile link) |
| `[data-ad-rendering-role="meta"]` | the timestamp row — but see the decoy warning below |
| `like_button` / `comment_button` / `share_button` | the action row, same attribute family |

## Trap: `div[role="article"]` is a comment, not a post

This is the single most expensive wrong assumption available here. On a group feed,
`div[role="article"]` matches **comments** — their `aria-label` reads
`"Comment by DE Daniels 12 minutes ago"`. A first implementation that extracted
`div[role="article"]` returned three comments with `comment_id=` permalinks and
empty authors, and looked superficially like a working scraper.

Post cards are `div[role="feed"] > div`. Filter them by the presence of
`[data-ad-rendering-role="story_message"]`: children without one are either the
"sort group feed by" header or a virtualized placeholder.

## Trap: the `meta` block contains decoy text

`[data-ad-rendering-role="meta"]` reads as junk like `ejpbJylBNG.com`, `7JlMDb.com`,
`LXG28.com` — one per card, different each time. It is anti-scraping chaff. Do not
parse it for a timestamp or a domain.

Facebook also interleaves invisible joiners (U+034F and friends) into some text
runs, so `"prdontSsor"` renders as clean text but compares as garbage. Strip
`U+034F` and `U+200B`–`U+200D` from anything extracted before using it as a key.

## Permalinks are lazy, and partly unavailable

The post permalink and the absolute date live in exactly one place: the timestamp
anchor (`a[href*="/posts/"]`), whose text is relative (`14m`) and whose `aria-label`
is absolute (`Thursday 6 August 2026 at 14:11`). Facebook renders that anchor
**on hover**, so a plain extraction finds it on almost nothing.

Measured on a 10-post extraction:

- no hover pass → 1–3 of 10 cards carry a permalink
- real `hover()` on `profile_name` → **4 of 10**
- synthetic `dispatchEvent(new MouseEvent('mouseover'…))` → 1 of 2, unreliable;
  React does not trust it. Use a real CDP hover.
- adding `scrollIntoViewIfNeeded()` before the hover → still 4 of 10, i.e. **no
  measured gain**. It was tried and removed; do not re-add it without a number.

The remaining ~60% appear to be story types Facebook never gives a timestamp anchor.
Treat a missing permalink as normal, not as a bug.

**Do not reconstruct permalinks from `set=gm.<id>` / `set=pcb.<id>`.** Those ids
appear in attached photo links and look exactly like post ids. This was tried:
`gm.1081689191038412` extracted from Michael Freeman's card produced a URL that
loaded, but resolved to a *different author's post*. A plausible-but-wrong permalink
is worse than none — it silently corrupts any dedupe or monitoring built on it.

Because permalinks are unreliable, **dedupe on `author + text`, not on permalink.**

## Login state

Task spaces copy your cookies at creation time, so a space created while you were
logged in stays logged in. A space created before you logged in never sees the
session — recreate the space rather than logging in inside it. An empty result plus
a visible login wall is this, not selector drift.

## Locale

The UI follows the *account's* language, not the browser's. The verified session ran
in English (`Groups`, `Your feed`, `Groups you've joined`). A Hungarian account
renders `Írj valamit…` and `Közzététel`. Selectors here are structural and so are
locale-independent; only the composer button labels in `tools/group-post.js` match
on text, which is why they carry both languages.

## Rate and detection reality

Group posting is the most heavily policed surface on the platform.

- Space posts minutes apart, not seconds. Burst posting across groups is the
  strongest checkpoint trigger.
- Reuse one task space per session rather than a fresh context per action.
- A checkpoint or "confirm it's you" interstitial means stop, not retry.
- Read-only extraction is materially safer, but still rate-limited — keep
  `scrollRounds` modest. The hover pass adds one input event per card, which is
  well within normal human interaction rates.
