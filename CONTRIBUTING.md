# Contributing

Thanks for helping! The project is deliberately small: **no runtime dependencies, no build step.** You can contribute
by hand or with your coding agent: [AGENTS.md](AGENTS.md) is the briefing for the latter (code map, rules, recipes).

## Get going in a minute

```bash
git clone https://github.com/fandyaditya/herdr-office && cd herdr-office
npm run demo        # the office with a made-up building: no herdr needed -> http://127.0.0.1:4747
npm run check       # syntax + house rules + tests; run it before you push
npm run doctor      # if something about your setup is off
```

Demo mode covers the UI, the simulation and the chat view. You only need a real herdr to work on the herdr client
or on matching a pane to a live agent session. `OFFICE_MOCK_STATIC=1` freezes the demo's random status changes;
`POST /api/mock/set` forces them (see AGENTS.md).

## Good first contributions

- **A trivia line** (one line in `public/js/trivia.js`). True, short, friendly.
- **An easter egg** (`public/js/eggs.js`). Harmless, quiet, never in the way of typing.
- **A furniture piece or room theme** (`public/js/art.js`, `floorplan.js`).
- **A chat adapter** for another agent: Gemini CLI, OpenCode, pi, Copilot CLI. Bigger, and the most useful.
- **macOS / WSL**: try it, tell us what breaks in the process-based session matching.
- **Docs**: anything you tripped over while getting started.

## Guidelines

- Keep runtime dependencies at zero. Dev-only tools (screenshots, e2e) may use `playwright-core`.
- Match the surrounding style: plain ES modules, no transpiling, no inline scripts (the CSP forbids them).
- Add or update a test for server behaviour. Adapter tests use small fixture logs, never real conversations: scrub
  secrets and personal paths from anything you add.
- UI changes: look at them in the demo, on a phone-sized viewport too, and run `npm run screenshots` if the README
  images are affected.
- Never commit `.env`, tokens, or hostnames of your own deployment.

## Adding a chat adapter for another agent

1. Find where the agent stores its session log and how to tie a running process to one session (see
   [docs/chat-view.md](docs/chat-view.md) and the existing adapters in `server/harness/`).
2. Implement `locate(processInfo)` and a `Transcript` class that produces the normalised items.
3. Register it in `server/harness/index.js` and add its kind to `CHAT_KINDS` in `public/js/main.js`.
4. Document it in `docs/harnesses/<name>.md` and the table in the README. Prefer *no chat view* over a wrong
   pane-to-session match.

## Pull requests

Describe what changed and how you checked it; the template has the checklist. Small, focused PRs are easiest to
review. AI-assisted PRs are welcome: say so, and review the diff yourself. Be kind: see the
[code of conduct](CODE_OF_CONDUCT.md).
