---
name: miniapp
description: Drive a WeChat mini program in the simulator. Open a project, read the page as refs, tap and type, and — further than any browser reaches — read and write the page's data and call wx.* APIs directly. Use it whenever the work touches a mini program — checking a page you just wrote, reproducing a bug, walking a flow that needs login or payment mocked out.
whenToUse: Any task involving a WeChat mini program project — one you just wrote, or one you are debugging.
---

# The mini program simulator

You can run a mini program in the real WeChat DevTools simulator and drive
it. The user can see the simulator and can take over at any time.

Two ways to reach it, whichever is available to you:

- Tools named `mcp__miniapp__open`, `mcp__miniapp__snapshot`,
  `mcp__miniapp__tap`, and so on. Prefer these when you have them.
- The `dsh-miniapp` command, same verbs, same arguments —
  `dsh-miniapp open ./my-app`, `dsh-miniapp tap ref_2`. Run
  `dsh-miniapp help` for the full list. Add `--json` for the raw result.

## The loop when you write a mini program

1. `open <project>` — the directory holding `project.config.json`. It starts
   the DevTools if needed and waits for the first page. The first open on a
   machine can take a minute; that is the DevTools starting, not a hang.
2. Read the snapshot. Every element has a ref, its live text, its geometry,
   and the handler bound to it (`tap=bump`).
3. `tap` and `input` using those refs, `data` to check what changed.
4. `console` when something did nothing — a mini program reports most of its
   own failures there rather than by refusing a call.
5. Change the code, and check again. The DevTools recompiles on save.

Do this before you tell the user a page works. Reading the WXML is not the
same as seeing the page render.

## What reaches further than tapping

A mini program keeps its state somewhere addressable and its APIs somewhere
callable. This is the part a browser has no equivalent for, so remember to
reach for it:

- `data` reads the current page's data; `data count 3` writes it and the
  page re-renders. The direct way to put the app into a state worth looking
  at — far cheaper than tapping towards it, and it reaches states tapping
  cannot produce at all.
- `call getSystemInfoSync` calls any `wx.*` API in the running app.
- `mock login '{"code":"test"}'` makes a `wx.*` API return a fixed result —
  how you walk a flow that needs login, payment, or a network call, without
  one. Pass no result to put the real API back.
- `eval "function(){ return getCurrentPages().length }"` runs anything in
  the logic layer; promises are awaited.

## Reading a page

- Refs are renumbered by every snapshot; use the ones it just returned.
- A `wx:for` list appears as one entry per rendered row — `view[0] "Alpha"`,
  `view[1] "Bravo"` — each tappable on its own, with its own dataset.
- Labels show live values, not template text. `"tapped 3 times"`, not
  `"tapped {{count}} times"`. An expression the snapshot could not resolve
  is left as written — that is honesty, not a bug.
- `screenshot` returns the phone screen alone, no DevTools around it. For
  layout questions; do not reach for it to find a button.

## What a tap here actually is

Selectors in a mini program match `#id`, `.class` and unions of those —
nothing else. Tag names match nothing, and fail by returning an empty list
rather than an error. So a tap is the page's own handler being invoked with
a synthesised event: no bubbling, no gesture. For everything ordinary that
is indistinguishable from a finger; a handler that inspects the raw event
deeply may notice. If a tap "worked" but nothing changed, read `console`,
then read the handler's code.

## What not to do

- Do not type real credentials or pay real money in a flow. `mock` exists so
  that login and payment flows can be exercised without either — say so to
  the user if a flow seems to require the real thing.
- Do not assume navigation happened; `pages` answers what the stack is, and
  `wait /pages/detail/detail` waits for a navigation the app performs itself.
- `close` only quits a DevTools this app started. One the user already had
  open is borrowed, and stays open — that is by design, not a failure.
- The user can open a live mirror of the simulator (模拟设备 → 在窗口中查看) and
  tap, type and scroll in it directly; you and they drive the same session.
- An idle simulator may be closed automatically to give the memory back.
  If a verb says nothing is open, `open` the project again and carry on —
  nothing was lost but the boot time.
