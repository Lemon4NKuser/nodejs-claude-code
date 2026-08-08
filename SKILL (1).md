---
name: site-versioning
description: Use this skill whenever the user asks to change, update, fix or improve "the site" / "the project" that lives under the versions/ directory. It creates a new version folder from the latest one, makes the edits there, and writes update.txt so the running orchestrator (index.js) can hot-swap to it. Never edit files in an existing vX.Y.Z folder directly — always create the next version first.
---

# Site Versioning Skill

This project keeps every deployable state of the site in its own folder:

```
versions/
  v0.0.1/
    index.js         # entry point (or server.js / app.js, or package.json "main")
    update.txt        # changelog for this version vs the previous one
  v0.0.2/
    ...
```

`index.js` at the project root watches this directory. As soon as a new
`vX.Y.Z/update.txt` file appears, it stops the currently running version and
starts the new one with `node <entry>`. So the **only** signal that a version
is "ready to go live" is the presence of `update.txt` in that folder.

## Workflow — follow these steps in order every time

1. **Find the latest existing version.**
   List folders under `versions/` matching `vX.Y.Z`, pick the highest by
   semantic version (compare major, then minor, then patch).

2. **Decide the next version number.**
   Default to bumping the patch number (`v0.0.1` -> `v0.0.2`) unless the user
   explicitly asks for a minor/major bump.

3. **Copy, don't edit in place.**
   Copy the entire latest version folder to the new version folder:
   `cp -r versions/v0.0.1 versions/v0.0.2`
   Do this BEFORE making any changes. Never modify files inside an existing,
   already-shipped version folder.

4. **Make the requested changes** inside the new version folder only.

5. **Delete any old `update.txt`** that was copied over from the previous
   version (if present) before writing the new one.

6. **Write `versions/vX.Y.Z/update.txt`** as the last step, once all edits are
   complete and the code is believed to run correctly. Format:

   ```
   vX.Y.Z — <one-line summary of what changed>

   Changes vs vPREV:
   - <change 1>
   - <change 2>
   ...
   ```

   Writing this file is what triggers the live hot-swap — do not write it
   until the version is actually ready to run.

7. **Sanity check before finishing**: confirm the new folder has a runnable
   entry point (`index.js`, `server.js`, `app.js`, or a `package.json` with a
   valid `main`), and that any new dependencies are either already vendored
   in the copied `node_modules` or declared in `package.json` (the
   orchestrator does not run `npm install` automatically — prefer editing
   existing deps rather than introducing new npm packages unless asked).

## Notes

- Keep unrelated files (assets, config) copied over untouched unless the
  task requires changing them.
- If something goes wrong mid-edit, it's safe to delete the half-finished
  new version folder and start over — the orchestrator only reacts to
  `update.txt`, so an incomplete folder is simply ignored.
- Never write directly into `versions/` root — every change lives inside its
  own `vX.Y.Z` folder.

