# Facebook Groups

## URLs worth knowing

| Purpose | URL |
|---|---|
| Groups you joined | `https://www.facebook.com/groups/joins` |
| Group feed | `https://www.facebook.com/groups/<idOrSlug>` |
| Group feed, newest first | `https://www.facebook.com/groups/<idOrSlug>?sorting_setting=CHRONOLOGICAL` |
| Search inside a group | `https://www.facebook.com/groups/<idOrSlug>/search/?q=<query>` |

The default group feed is ranked, not chronological, so two runs minutes apart can
return different posts in a different order. For anything that monitors a group over
time, always append `?sorting_setting=CHRONOLOGICAL`.

De-duplicate on `author + text`, **not** on `permalink`: only about 4 posts in 10
come back with one, for the reasons in `overview.md`. `get_group_posts` already
dedupes that way internally, and upgrades a stored post in place if a later round
manages to attach its permalink.

## Reading a group

```bash
ego-browser nodejs <<'EOF'
const task = await taskSpaces.useOrCreate('fb group watch')

await page.goto('https://www.facebook.com/groups/YOUR_GROUP?sorting_setting=CHRONOLOGICAL', { waitUntil: 'load' })

const posts = await site.runTool('facebook', 'get_group_posts', { maxPosts: 20, scrollRounds: 3 })
console.log(JSON.stringify(posts, null, 2))
EOF
```

## Posting to a group

Publishing is irreversible and public, so `post_to_group` splits it in two. Called
without `confirm`, it opens the composer, types the body, and stops — the draft sits
on screen for a human to read. Called with `confirm: true`, it clicks publish.

Run the draft pass first, show the user the screenshot, and only pass `confirm: true`
after they say yes. Do not collapse both into one heredoc to save a round trip; the
review step is the entire point.

```bash
# Round 1 — draft, then look at it
ego-browser nodejs <<'EOF'
const task = await taskSpaces.useOrCreate('fb group post')

await page.goto('https://www.facebook.com/groups/YOUR_GROUP', { waitUntil: 'load' })

const result = await site.runTool('facebook', 'post_to_group', {
  text: 'Draft body goes here.',
})
console.log(JSON.stringify(result))
await page.screenshot()
EOF
```

```bash
# Round 2 — only after the user approves the screenshot
ego-browser nodejs <<'EOF'
const task = await taskSpaces.useOrCreate('fb group post')

const result = await site.runTool('facebook', 'post_to_group', {
  text: 'Draft body goes here.',
  confirm: true,
})
console.log(JSON.stringify(result))
EOF
```

The second round reuses the same named task space, so it lands in the same browser
context with the composer already where the first round left it.

## Composer behaviour

> **Verified 2026-08-06** on a private test group, English UI. Draft path only —
> the `confirm: true` publish branch has still never been run.

The trigger is a `role="button"` whose text is `Write something...`. It opens two
nested `[role="dialog"]` elements — the outer one is labelled `Create post`, the
inner unlabelled one holds the editor. The editor itself is
`div[role="textbox"][contenteditable="true"]` with `data-placeholder="Write
something..."`. Note the page also has a *comment* box that is `contenteditable`
and **not** inside a dialog; requiring the dialog ancestor is what keeps the two
apart.

- **Match the trigger on `role="button"` only, and on the start of the name.** An
  earlier version scanned `[role="button"], [aria-label]` and matched `includes()`,
  which hit the `role="main"` container first — its `innerText` contains its
  children's text, including `Write something...`. It clicked the page body and the
  composer never opened. Prefer the *shortest* matching accessible name.
- **Clear before typing.** A composer left open from an earlier round keeps its
  text and typing *appends*: three runs produced `ABC`, then `ABCABCX`, then
  `ABCABCXhello world`. A retried post would go out doubled. `clear()` is not
  reliable on a contenteditable — the tool sends `Control+a` then `Delete`.
- **A trailing period is silently dropped.** `"ABC."` lands as `"ABC"`;
  `"hello world."` lands as `"hello world"`. Other trailing punctuation survives —
  `"second run replaces?"` arrives intact — so this is specific to `.`, most likely
  Facebook's own link/domain parser normalizing the text. `post_to_group` returns
  `matchesRequested` so the caller sees the difference instead of guessing.
- `fill()` injects text without firing the React handlers that enable the publish
  button. `pressSequentially()` does, which is what the tool uses.
- Newlines: `Enter` inside the composer inserts a line break, it does not submit.
  Safe to type multi-line bodies directly.
- **Do not navigate away with an open draft.** Doing so hangs the renderer:
  `Page.navigate` times out, then every `Runtime.evaluate` times out too, and
  `Page.handleJavaScriptDialog` reports "No dialog is showing". The tab is not
  recoverable in place — close it with `browser.closeTab(...)` and reopen. Press
  `Escape` and confirm the discard *before* navigating.
- A group with post approval turned on returns success and then queues the post for
  a moderator. The tool cannot distinguish that from a live post — check the group's
  "Pending posts" if it matters.
- Link previews attach asynchronously a second or two after a URL is typed. Publish
  too fast and the post goes out without its preview card.

## Multi-group posting

Loop over group URLs in one heredoc, but sleep between them and re-check the
composer each time — see the rate notes in `overview.md`. Posting the identical body
to many groups in quick succession is the exact pattern Facebook's spam classifier
is tuned for; vary the text and space the posts out.
