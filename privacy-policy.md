# FarePath — Privacy Policy

**Last updated: 6 August 2026**

FarePath is an offline Mumbai rail route and fare app. This policy is short because the app does
very little with data: it collects nothing.

## What we collect

**Nothing.** FarePath has no accounts, no sign-in, no analytics, no advertising SDKs, no crash
reporting, and no tracking of any kind. We do not know who you are, where you are, or where you
travelled.

## What stays on your device

Your language and appearance preferences, and the origin and destination you last entered, are held
in the app's own storage on your device. They are never transmitted anywhere. Uninstalling the app
removes them.

## Permissions

FarePath requests **no Android permissions**. It does not ask for location, storage, contacts,
camera, or microphone access. Location permissions are explicitly blocked in the app manifest, so
the app cannot request them even by accident through a dependency.

## Network access

Version 1 of FarePath makes **no network requests at all**. The complete transit dataset is bundled
inside the app, which is why it works in a tunnel, on an underground platform, or in airplane mode.

A future version may add an **optional** data refresh, so that a corrected fare can reach you
without waiting for an app-store update. If and when that ships:

- it will be a plain download of a static file from a public URL,
- it will send no information about you — no identifiers, no device details beyond what any HTTP
  request unavoidably reveals to the host,
- the app will remain fully functional if you never use it,
- and this policy and the Play Data Safety declaration will be updated **before** the feature is
  released, not after.

## Children

FarePath is suitable for all ages and collects no data from anyone, including children.

## Contact

Questions about this policy, or a correction to the transit or fare data:
**corrections@farepath.app**

## Changes

If this policy changes, the "last updated" date above changes with it, and the version history is
public in the app's repository.

---

*FarePath is not affiliated with or endorsed by MMRDA, MMRC, MMOPL, MMMOCL, CIDCO, Indian Railways,
or any transit operator. Station and route data © OpenStreetMap contributors, licensed under
ODbL 1.0.*
