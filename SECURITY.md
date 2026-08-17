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

## Researcher lane: shared environment and provider boundaries

Researchers have no OS-enforced write boundary on any provider. A researcher uses
the human's normal provider home, so provider settings, credentials, extensions,
and session history are shared with the human's other sessions. The per-provider
working directory `.lares/researcher/<provider>/` remains in use; the removed
paths were the per-agent provider-state HOME redirects under
`.lares/agent-homes/<agent-id>/`.

Provider enforcement is deliberately described separately:

- **Claude:** launches carry `--tools`/`--disallowedTools` and a Claude
  PreToolUse Write guard. A live launch observed an out-of-shape inbox write
  denied. These are real tool controls, but they are not an OS filesystem
  boundary and do not govern unknown provider or MCP routes.
- **Codex:** researcher launches currently register no hook and have no
  researcher write boundary. A live launch wrote the same out-of-shape probe
  path successfully.
- **Antigravity (`agy`):** researcher launches have no researcher write
  boundary. Its deny regexes and `write_file` grants do not prevent shell
  chaining; a live launch wrote the same out-of-shape probe path successfully.

The research inbox remains untrusted. Frontmatter checks, promotion rules, and
`wrapUntrusted` framing improve consistency when downstream readers consume an
artifact; they do not restrict what the researcher process can persist elsewhere.

## Reporting a vulnerability

Please report security vulnerabilities through **GitHub's private vulnerability
reporting** on the [`getlares/lares`](https://github.com/getlares/lares) repository
(the repo's **Security → Report a vulnerability** tab). This keeps the report
private until a fix is available.

**Please do not open a public issue for a security bug.**

This is a solo-maintained alpha, so acknowledgement is best-effort — expect a
first response **within about a week.** When you report, please include what you
did, what happened, and what you expected, so the issue can be reproduced.
