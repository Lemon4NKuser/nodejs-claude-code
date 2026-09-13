---
name: site-versioning
description: Use this skill whenever the user asks to change, update, fix or improve "the site" / "the project" that lives in master/. It copies master into a .claude/work scratch folder (including hidden files), makes the edits there, carries the previous backups/vN forward into a new .backups/vN+1 (including hidden files), overlays the edited content, commits, then copies work into master/ (including hidden files), clears work/, and finally triggers the Go server to restart index.js. Also use this skill when the user asks to roll back / revert to a previous version. Never edit files inside an existing .backups/vN folder directly — that folder is a frozen restore point once created. Never push git history anywhere — commits stay local.
---

# Site Versioning Skill

```
master/               # the live folder — the Go server runs
                       # `node index.js` out of here
.claude/
  work/                # scratch folder — this is where you actually make
                        # edits, always empty at the start and end of a task
  restart_signal       # write to this file to tell the Go server to
                        # restart index.js (see "Restarting index.js" below)
.backups/
  v1/
  v5/
  v10/
  ...
```

Version folders are named `v<number>` — a plain incrementing integer, **not**
semver (`v1`, `v2`, ... `v27`, `v28`), and always without leading zeros or a
`.` in the name.

**Every copy in this workflow includes hidden files** (`.git`, dotfiles,
everything) — never a partial copy. Use `cp -r source/. dest/` (the trailing
`/.` picks up hidden files too), not `cp -r source/* dest/`.

## Restarting index.js

The Go server does **not** run `nodemon` and does **not** watch `master/`
for changes. It only watches one file: `.claude/restart_signal`. Whenever
anything is written to that file (any content — even an empty write via
`touch`), the Go server:

1. Checks whether `master/package.json` has changed since it was last
   installed, and runs `npm install` first if so (it does **not** run
   `npm install` on every write — only when the file's contents actually
   changed).
2. Stops the currently running `index.js`.
3. Starts `index.js` again.

This means **deploying into `master/` alone does not restart the app** —
step 8 below (writing to `.claude/restart_signal`) is required every time,
even for edits that don't touch dependencies.

## Workflow — follow these steps in order, every time

1. **Make sure `.claude/work/` is empty before starting.**
   If it isn't (leftover from an interrupted previous task), clear it out
   first — it should never carry state between tasks.

2. **Copy all of master into `.claude/work`.**
   `cp -r master/. .claude/work/`

3. **Make the requested changes inside `.claude/work/` only.**
   Do not touch `master/` or any folder under `.backups/` at this stage.

4. **Find the latest existing version.**
   List folders under `.backups/` matching `^v[0-9]+$` and pick the one with
   the highest numeric value (`v9` < `v10`, compare as numbers, not as
   strings). If `.backups/` has no version folders yet, treat the "latest
   version" as `v0` (i.e. the next one to create is `v1`).

5. **Create `.backups/vN+1`.**
   - If a previous version exists, copy all of it forward first:
     `cp -r .backups/v<N> .backups/v<N+1>`
   - If this is the very first version, just create the folder:
     `mkdir .backups/v1`
   - Then copy all of `.claude/work` on top:
     `cp -r .claude/work/. .backups/v<N+1>/`
   - If `.backups/v<N+1>/.git` doesn't exist yet (first version), initialize
     it: `git -C .backups/v<N+1> init`
   - Commit:
     ```
     git -C .backups/v<N+1> add -A
     git -C .backups/v<N+1> commit -m "v<N+1>: <one-line summary>

     - <change 1>
     - <change 2>
     ..."
     ```
   Write a real, specific commit body — not just the version number.

6. **Deploy: copy all of `.claude/work` into master.**
   Only after the commit above exists:
   - empty `master/`
   - `cp -r .claude/work/. master/`
   This alone does **not** restart the app — see step 8.

7. **Clear `.claude/work/`.**
   Empty it out completely so it's ready for the next task.

8. **Trigger the restart.**
   Write anything to the restart signal file, e.g.:
   `date > .claude/restart_signal`
   The Go server will pick this up, reinstall dependencies automatically if
   `master/package.json` changed, stop the old `index.js`, and start the
   new one. This step is mandatory at the end of every task in this
   workflow, including reverts — the deploy in step 6 by itself does not
   restart anything.

## Reverting to a previous version

- **Restore a whole numbered version** ("go back to v15", "undo the last
  change"): copy all of `.backups/v<N>` into `.claude/work/`, then deploy it
  the same way as steps 6–8 above (empty `master/`, copy all of
  `.claude/work/` into it, clear `.claude/work/`, then trigger the restart).
- **Undo just one specific change, not a whole version rollback** ("undo
  that one edit", "that last commit broke something", "what did v9 actually
  change"): git here is **read-only**. Use it to inspect, never to rewrite:
  - `git -C .backups/v<latest> log` to see the commit list
  - `git -C .backups/v<latest> show <commit>` or
    `git -C .backups/v<latest> diff <commit>~1 <commit>` to see exactly what
    that commit changed
  Once you can see the diff, undo it the normal way: edit the files in
  `.claude/work/` by hand to remove that specific change (per the usual
  workflow — step 2 onward), then commit the result as a new version. Do
  not try to make git do the undo for you.

## Rules

- **Never edit an existing `.backups/vN` folder's content directly for a
  new change.** The next change always starts a new `vN+1` copied forward
  from it, per step 5.
- **Never edit `master/` directly for a feature/fix request.** All edits
  happen inside `.claude/work/` first; `master/` is only ever overwritten
  wholesale in the deploy step, after the commit.
- **Every copy step copies everything, including hidden files.** Don't use
  glob copies that would skip dotfiles.
- **Follow the order strictly: edit in `.claude/work/` → carry the previous
  version forward and commit into the new `.backups/vN+1` → deploy into
  `master/` → clear `.claude/work/` → trigger the restart signal.** Don't
  skip the commit, don't reorder it after the deploy, and don't skip the
  restart signal — without it the running app keeps serving the old code.
- **Never push, anywhere.** All git operations in this skill stay strictly
  local to whichever `.backups/vN` repo you're working in. Never run
  `git push`, never add or use a remote (`git remote add ...`), and never
  interact with GitHub or any other git host from this skill, even if one is
  configured elsewhere in the project. If the user explicitly asks to push
  somewhere, that's outside this skill's scope — confirm with them
  separately rather than doing it as part of a version/edit workflow.
- **Git is read-only outside of `init`, `add`, and `commit`.** The only git
  commands this skill ever uses to *change* a repo's state are `git init`
  (once, for the first version) and `git add` / `git commit` (when
  finalizing a new version in step 5). Never run `git revert`, `git reset`,
  `git checkout -- <file>`, `git restore`, `git cherry-pick`, `git rebase`,
  or anything else that rewrites, reverts, or checks out history — even if
  the user asks for a rollback or undo by name. `git log`, `git show`, and
  `git diff` are fine and encouraged for *looking at* what changed. Actually
  undoing something always means editing files by hand in `.claude/work/`
  and committing a new version, never a git history operation.
- If something goes wrong mid-edit inside `.claude/work/` before it's been
  committed and deployed, it's safe to just clear `.claude/work/` and start
  over — nothing has been committed or deployed yet, so nothing live is
  affected.
