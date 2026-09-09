# Cutting a Windows release

This is the protocol for producing a `Lares-Setup-<version>-x64.exe` installer.
It is separate from pushing source to GitHub: the repo is the recipe, the
installer is the built product. See [architecture.md](architecture.md) for what
ships; the authoritative list is `build.files` + `build.extraResources` in
`package.json` and `scripts/packaged-scripts-allowlist.json`.

## Preconditions

- Master is pushed to origin. A release is cut from a commit that is public.
- `git status` in the dev checkout may be dirty; that is fine. Only the build
  worktree must be clean.
- The dev app can stay running while building, but NOT while verifying (step 5).

## 1. Bump the version

Edit `"version"` in `package.json` and `package-lock.json` (top level and the
`packages[""]` entry). Commit only those two files:

```
git add package.json package-lock.json
git commit -m "release: bump to 0.3.x" -- package.json package-lock.json
git push origin master
```

## 2. Check out the release commit in the build worktree

Never build in the dev checkout: the running dev app executes from `dist/` and
a release build overwrites it. Use the dedicated worktree:

```
git -C C:\Users\turke\Projects\lares-pkg-build checkout --detach <bump-sha>
git -C C:\Users\turke\Projects\lares-pkg-build status --short   # must be empty
```

If the worktree is missing: `git worktree add --detach C:\Users\turke\Projects\lares-pkg-build <sha>`
then `npm ci` inside it. Re-run `npm ci` whenever `package-lock.json` changed
for reasons other than the version line.

## 3. Build

From the worktree:

```
npm run dist:win:release
```

This runs, in order: the release EDR scan (`lint:edr:release`: src, docs,
package.json, packaged MCP scripts), TypeScript build, native rebuild + verify,
MinGit fetch, payload preflight, electron-builder, packaged-script and bundled-Git
checks, then `scripts/verify-windows-release.ps1`. Expect 10–15 minutes.

The plan-versioning check (`check:plan-versioning`) is deliberately NOT part of
this chain. It audits the developer's `.lares/plans` workshop, not the app.

Output lands in `<worktree>\release\`: the installer, its `.blockmap`, and a
`.sha256` sidecar.

## 4. Read the verifier honestly

Every row of the summary must PASS except `launch smoke`, which is SKIPPED
while any Lares window is open. Known false negative: if `FORCE_COLOR` is set
in your shell, the asar enumeration row fails because a Node warning pollutes
the parser. Re-run the verifier with the variable unset:

```
env -u FORCE_COLOR powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-windows-release.ps1
```

Do not weaken a failing gate to get green. Fix the cause or stop.

## 5. Launch smoke and tag

Close every Lares window (dev and installed; the single-instance lock blocks
the check otherwise), then re-run the verifier from the worktree. When it is
fully green, tag the bump commit in the dev checkout and push the tag:

```
git tag -a v0.3.x -m "Lares 0.3.x" <bump-sha>
git push origin v0.3.x
```

Alternative: treat the VM acceptance install ([vm-acceptance.md](vm-acceptance.md))
as the launch smoke and tag after it passes.

## 6. Stage for VM acceptance (optional)

Copy the installer and `.blockmap` into `C:\vm-tools\vm-acceptance\`, remove
the previous version's files, update the version line in `START-HERE.md`, and
regenerate `MANIFEST.txt` (path | bytes | SHA-256 for every file except itself).

## Publishing (not yet done for any version)

Releases are not published to GitHub Releases or an update feed yet. When that
starts, the tag from step 5 is the anchor; upload the installer, `.blockmap`,
`.sha256` and `latest.yml` to a release named after the tag.
