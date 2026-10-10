# Security policy

Herdr Office can send keystrokes to your terminals and displays everything your agents print, so a vulnerability here
can mean remote command execution or secret disclosure.

## Reporting

Please do **not** open a public issue for a vulnerability. Use GitHub's private vulnerability reporting
("Security" tab, "Report a vulnerability") on this repository. Include what you found, how to reproduce it and the
version or commit. You should get a first reply within a week.

## Scope and hardening

- Supported: the latest release / `main`.
- In scope: authentication and session handling, request validation, path traversal, XSS in the chat / terminal /
  markdown renderers, SSRF or file reads through the harness adapters, secret leakage.
- Out of scope: running with `OFFICE_ALLOW_OPEN=1` on a reachable interface, exposing the plain-HTTP port to the
  internet, and anyone who already holds the token.

Run it on loopback or behind HTTPS with a long random `OFFICE_TOKEN`; see the Security section of the README.
