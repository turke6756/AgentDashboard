# Claude worker turn 1: prove red, fix, prove green

The absolute repository root is `{{REPO_ROOT_ABS}}`. The absolute acceptance
run directory is `{{RUN_DIR_ABS}}`, and the run ID is `{{RUN_ID}}`. These values
were substituted from `MANIFEST.json.repoRoot` and `MANIFEST.json.runId` by your
supervisor. Stop if either path is not absolute or the manifest does not match.

Never use the current working directory to form a path. Workers start under a
provider directory, not the repository root. Every command and every file edit
must use a path beginning with `{{REPO_ROOT_ABS}}` or `{{RUN_DIR_ABS}}`.

Do all of this in one turn:

1. Read `{{REPO_ROOT_ABS}}/MANIFEST.json` and confirm `seededBug.file` is
   `src/index.js`, `expectedRedExit` is `1`, and `expectedGreenExit` is `0`.
2. Run `node --test "{{REPO_ROOT_ABS}}/src/index.test.js"` before editing.
   Capture its numeric exit code, even though it fails, and write only that
   number plus a newline to `{{RUN_DIR_ABS}}/turn1-red.txt`. Require it to equal
   `MANIFEST.json.expectedRedExit`.
3. Fix only the seeded bug in `{{REPO_ROOT_ABS}}/src/index.js` as described by
   `MANIFEST.json.seededBug`.
4. Touch the ignored absolute path
   `{{REPO_ROOT_ABS}}/generated/{{RUN_ID}}.txt` in this same turn.
5. Run `node --test "{{REPO_ROOT_ABS}}/src/index.test.js"` again. Capture its
   numeric exit code and write only that number plus a newline to
   `{{RUN_DIR_ABS}}/turn1-green.txt`. Require it to equal
   `MANIFEST.json.expectedGreenExit`.
6. Tell the supervisor both observed exit codes and the absolute paths changed.

Durable trace: `src/index.js` is the tracked edit,
`generated/{{RUN_ID}}.txt` is an ignored witnessed edit, and
`turn1-red.txt`/`turn1-green.txt` contain the red/green exits. Run-dir
sentinel: this prompt writes no exported sentinel; it writes the two required
exit-code evidence files.
