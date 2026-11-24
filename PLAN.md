# Plan: Slash command to toggle the Laya router on/off

## Context

`pi-laya-server` is the companion repo for the npm-installed `pi-laya-model-router` pi extension.
The router has two layers:

- **Systemd user service** `pi-laya` (this repo's `server.py` + `pi-laya.service`): the Laya
  difficulty/security classifier, started/stopped with `systemctl --user`.
- **pi extension** (`npm:pi-laya-model-router`, in `~/.pi/agent/npm/node_modules/pi-laya-model-router/`):
  registers `/laya-router` (status only) and, via `before_agent_start`, routes each prompt through
  the socket client. On failure it fails open (keeps current model) with a warning notification.

Today there is no on/off switch. Goal: `/laya-router on|off|status|toggle`.

## Design

Fork the npm extension into this repo instead of patching node_modules in place (patching is
lost on `pi update`). The fork is the single source of truth; the npm package is removed from pi.

### New files (in this repo)

- `extensions/laya-model-router.ts` — copy of the installed extension, modified:
  - `/laya-router` gains subcommands:
    - `/laya-router` (no args) — status + mappings (current behavior, unchanged)
    - `/laya-router on` — `systemctl --user start pi-laya`; remove `<agentDir>/laya-router-disabled` marker file
    - `/laya-router off` — `systemctl --user stop pi-laya`; write the marker file
    - `/laya-router status` — same as no-args status, plus a one-line "off" state when the marker exists
    - `/laya-router toggle` — stop-or-start based on service state (`systemctl --user is-active pi-laya`), keeping the marker file in sync with the service state
  - `before_agent_start`: if the marker file exists, return silently (no route attempt, no warning).
  - Marker file lives at `<agentDir>/laya-router-disabled` (getAgentDir() from the pi package, same as config).
  - All `systemctl` calls via `pi.exec("systemctl", [...])`; no other new dependencies.
- `extensions/laya-socket-client.ts` — copied unchanged.
- README: short section documenting `/laya-router on|off|status|toggle` and the removal of the npm package.

### Install / wiring (user side, one time)

1. `pi remove npm:pi-laya-model-router` (removes the package from `~/.pi/agent/settings.json`)
2. `ln -s ~/projects/pi-laya-server/extensions/laya-model-router.ts ~/.pi/agent/extensions/laya-model-router.ts`
   (and the socket client next to it, or keep both symlinked in the same dir; note: the fork
   imports `./laya-socket-client.ts`, so the socket client must be discoverable/importable —
   safest is to symlink both files into `~/.pi/agent/extensions/`, or symlink the directory.)
3. `/reload` in pi to pick the extension up.

### What stays unchanged

- `server.py`, `pi-laya.service`, `laya-model-router.json`, protocol.
- Existing `/laya-router` status behavior (no-args) and the fail-open behavior when the
  service is down but the router is not explicitly off.
- The npm package is **removed** from pi (not just disabled), per user decision.

## Steps

- [x] Copy `extensions/laya-model-router.ts` + `laya-socket-client.ts` from
      `~/.pi/agent/npm/node_modules/pi-laya-model-router/extensions/` into this repo's `extensions/`
- [x] Modify `laya-model-router.ts`: add marker-file silent skip + `on|off|status|toggle` subcommands
- [x] Update README (`/laya-router` usage, note the fork replaces the npm package)
- [x] `pi remove npm:pi-laya-model-router`
- [x] Symlink fork into `~/.pi/agent/extensions/`
- [x] `/reload` and verify in pi (status, on, off, status)

## Verification

- `systemctl --user is-active pi-laya` reflects the state after `/laya-router on` / `off`
- With the router off: a prompt makes **no** socket call and shows no warning (marker file present)
- With the router on: prompt routes as before; `/laya-router status` shows active + level mappings
- `/reload` after the symlink keeps everything working
