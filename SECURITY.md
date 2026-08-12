# Security Policy

> ⚠ **Alpha — agents execute real commands.** Lares runs AI agents that execute
> commands in real terminals, drive a real browser (including authenticated
> sessions), and read/write files in your workspace. Treat every agent as capable
> of running arbitrary code and of sending data over the network. Use it only in
> workspaces you trust; use throwaway credentials and keep long-lived secrets out
> of active workspaces; avoid signing into sensitive accounts in the Lares browser
> during alpha runs; and prefer a sandboxed or disposable environment.

## Alpha security status

Lares is pre-1.0 and carries **no security guarantees.** Its model is *"you trust
the agents and the workspace,"* **not** *"the app sandboxes the agents."* Some
guardrails exist (a browser access-policy store and action-audit log, best-effort
workspace path-confinement, an untrusted-inbox convention for web-derived
research), but they are partial: terminal commands are not sandboxed or gated,
there is no per-command approval wall, path-confinement is not a jail, and the
browser acts in whatever sessions you are signed into. **Do not rely on Lares to
contain a hostile or prompt-injected agent.**

One boundary *is* enforced: **cross-workspace collaboration is supervisor-only and
audited.** Only a supervisor-lane agent can discover, read, message, revive, or
peer-launch across workspaces; a worker or researcher is refused. Every crossing —
success **and** denial — is written to a `cross_workspace_audit` ledger (message
contents are never stored), each agent carries a per-agent capability token
(never the shared global bearer), and a token-mint failure fails closed rather
than grant admin authority.

The full threat model — what is dangerous, which boundaries exist today, and which
do not — is in [docs/security.md](docs/security.md).

## Researcher lane: enforced boundaries and open gaps

The researcher lane already applies capability minimisation in production. Its
Claude launch uses a `--tools` allowlist and separately disallows `Bash`, `Edit`,
`MultiEdit`, and `NotebookEdit`, on both Windows and WSL. The researcher therefore
cannot run a shell through the native Bash tool, so a shell-based exfiltration
chain such as `curl` is not available. This is a shipped control, not planned
future work.

That control does not make information read by the researcher confidential. The
concrete confidentiality paths are **Read → `.lares/research/inbox/` → privileged
reader** (a supervisor or other unrestricted agent later reads the research), and
**Read → WebFetch/browser GET**. The inbox is intentionally an untrusted tier that
privileged agents read. `wrapUntrusted` framing and `trust: untrusted` are software
controls on agent behaviour; there is no OS boundary preventing persuasive inbox
text from influencing a privileged reader.

On Windows, the restricted-token cage is a write boundary, not a read boundary.
WP-8 tightened its restricting SID list to the synthetic capability SID plus the
logon SID, so its writable set is now **granted roots ∪ logon-SID-granted
locations**; an Everyone-only write grant no longer makes a location writable by
the caged process. Everyone remains in the independent token default DACL because
removing it there prevents Node from initialising. The fail-closed ACL audit walks
the configured workspace audit root, follows reparse points to canonical targets,
and rejects logon-SID Allow-write grants outside the canonical grant roots. It
still reports Everyone-writable directories as non-fatal host-hygiene telemetry.
The audit is not a whole-host inventory: locations outside its configured roots
remain unexamined.

Gate A's machine probe, `2026-08-11-probe-deny-read-ace-synthetic-sid.md`
(retained in the workspace's untrusted research inbox and deliberately not
committed because it contains host identifiers), returned **INERT**: a deny-read
ACE for the synthetic restricting SID did not stop
the restricted child reading the known bytes, although the controls proved that
the harness observed a real-user read denial and a synthetic-SID write denial.
The restricted and unrestricted processes had identical normal-group SIDs for
read purposes. Plan `plan_7068b26d` is therefore primarily a usability fix and
does **not** add read isolation. WP-8 is the sole security-hardening exception:
it removed Everyone from the restricting SID list and measurably reduced the
writable set, while retaining the logon-SID exposure described above. The
[reviewed WP-8 probe report](.lares/research/cleared/2026-08-11-probe-wp8-restricting-sid-list.md)
records the native-payload matrix and the audit correction.

Read-side isolation remains a known gap. The AppContainer feasibility report,
`2026-08-11-spike-appcontainer-feasibility.md` (retained in the workspace's
untrusted research inbox and not committed), demonstrated a viable direction:
an ordinary same-user process read a
credential-shaped test file, while a verified AppContainer read of the same path
returned `EPERM`. AppContainer was declined on cost for now and is not a shipped
feature. The remaining direction and its browser-loopback gate are recorded in an
[undispatched proposal](.lares/proposals/2026-08-11-appcontainer-read-isolation-browser-loopback-gate.md).

## Reporting a vulnerability

Please report security vulnerabilities through **GitHub's private vulnerability
reporting** on the [`getlares/lares`](https://github.com/getlares/lares) repository
(the repo's **Security → Report a vulnerability** tab). This keeps the report
private until a fix is available.

**Please do not open a public issue for a security bug.**

This is a solo-maintained alpha, so acknowledgement is best-effort — expect a
first response **within about a week.** When you report, please include what you
did, what happened, and what you expected, so the issue can be reproduced.
