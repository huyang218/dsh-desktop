---
name: phone
description: Drive an Android phone — boot the emulator, read the screen as refs, tap, type, swipe, install an APK, launch an app, read logcat. Use it whenever the work touches an Android app or needs a phone-shaped environment; a running app can be exercised end to end. Third-party emulators and real phones can be attached by name; iOS simulators can be booted and looked at only.
whenToUse: Any task involving an Android app, an APK you just built, or behavior that needs a real phone-shaped environment.
---

# The phone

You can boot an Android virtual device and drive it. The user can see the
emulator window and can take over at any time.

Two ways to reach it, whichever is available to you:

- Tools named `mcp__phone__open`, `mcp__phone__snapshot`, `mcp__phone__tap`,
  and so on. Prefer these when you have them.
- The `dsh-phone` command, same verbs, same arguments —
  `dsh-phone open`, `dsh-phone tap ref_5`. Run `dsh-phone help` for the
  full list. Add `--json` for the raw result.

## The loop when you build an Android app

1. `open` — boots the virtual device, or attaches to one already running.
   A cold boot takes a minute or two; `open` waits it out for you.
2. `install ./app.apk`, then `launch com.example.app`.
3. `snapshot` — everything on screen, each with a ref, its text, the point
   it sits at, and what it can do (`tap`, `input`, `scroll`).
4. `tap`, `input`, `swipe`, `key back` — then `snapshot` again to see what
   happened.
5. `logcat --filter com.example.app` when something did nothing or crashed —
   an Android app reports its failures there and nowhere else.

Do this before you tell the user the app works.

## How refs behave here

A ref is not a handle the system holds for you — Android has none to give.
It remembers what the view *was*: its resource id, its text, its class. Every
action re-reads the screen and finds that view again before touching it, so
a list that scrolled gets tapped where it is now.

- If the view is gone, the tap refuses and says so. That is the honest
  answer; take a new snapshot rather than retrying.
- `tap --x 540 --y 1200` taps a point directly, when you know the screen has
  not moved and want to skip a round trip.

## Typing

`input` sends keystrokes through adb, which carries **ASCII only** — it will
refuse anything else rather than type half of a sentence. For Chinese or any
other text adb cannot carry, say so and let the user type it, or exercise
the flow another way.

## Other phones, and the line you must not cross

- `devices` lists everything: virtual devices, anything adb is attached to
  (classified — a Google virtual device, a network-attached emulator, a real
  phone on a cable), and iOS simulators.
- `open` with nothing named only ever picks a Google virtual device. That is
  a rule, not a default.
- A third-party emulator (MuMu, LDPlayer, Nox…) waits to be connected to:
  `scan` knocks on the usual ports, `connect 127.0.0.1:16384` attaches to
  one on a known address. Then `open --serial 127.0.0.1:16384`.
- A **real phone** on a cable or wireless debugging is somebody's actual
  telephone, with their accounts and their messages on it. Attach to one only
  when the user has explicitly asked you to work on that device, name it with
  `--serial`, and stay inside the app you were asked to work on. When in
  doubt, ask.
- iOS simulators can be booted (`open --ios "iPhone 17 Pro"`) and looked at.
  Apple ships no way to inject input, so do not plan a flow that needs
  tapping there.

## What not to do

- Do not type credentials, card numbers, or other secrets into any device.
- Do not sleep and hope; `snapshot` after an action answers what happened,
  and `logcat` answers why it did not.
- `shell` runs any adb command and is the escape hatch — prefer the named
  verbs, whose answers are shaped for reading, and never use `shell` to
  factory-reset, wipe, or change device security settings.
