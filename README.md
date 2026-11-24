# pi-laya-server

Companion server for the [pi-laya-model-router](https://pi.dev/packages/pi-laya-model-router)
pi extension. It uses [Laya](https://github.com/NandhaKishorM/laya) to classify each prompt as
`low`, `medium` or `high` effort, and the extension switches pi to the model mapped to that level.

## How it routes

Laya scores the prompt's difficulty from 0 (trivial) to 3 (hard) and checks whether it is
security-related:

| Level | Rule (defaults) |
|---|---|
| high | difficulty ≥ 2.0, or security ≥ 0.5 |
| low | difficulty < 1.3 |
| medium | everything else |

Override the thresholds with `LAYA_HIGH_FROM`, `LAYA_LOW_BELOW` and `LAYA_SECURITY_FROM`.

## Protocol

Newline-delimited JSON over a Unix socket (default `/tmp/pi-laya-guardrails.sock`, override with
`PI_LAYA_SOCKET`):

```
→ {"id": "…", "kind": "model_route", "text": "…"}
← {"id": "…", "level": "low|medium|high", "confidence": 0.13}
← {"id": "…", "error": "…"}            # on failure; the extension keeps the current model
```

## Install

Runs on CPU. It needs about 2.5 GB of RAM, and the first start downloads about 2 GB of model weights from Hugging Face.

```bash
git clone <this repo> ~/.pi/agent/laya-server && cd ~/.pi/agent/laya-server
python3 -m venv .venv
.venv/bin/pip install --extra-index-url https://download.pytorch.org/whl/cpu -r requirements.txt

cp pi-laya.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now pi-laya

cp laya-model-router.json ~/.pi/agent/       # edit the level → model mappings
pi install npm:pi-laya-model-router
echo 'export PI_LAYA_TIMEOUT_MS=5000' >> ~/.bashrc   # extension default is 2s
```

The service is capped at 4 GB with no swap (`MemoryMax`, `MemorySwapMax`), so on a machine short
on memory Laya is killed rather than freezing everything. Raise `MemoryMax` if it gets OOM-killed.

## Operating

```bash
journalctl --user -u pi-laya -f      # routing decisions, one line per prompt
systemctl --user restart pi-laya     # after editing server.py
```

In pi, `/laya-router` shows the active level → model mappings.

## Toggling the router from pi

This repo carries its own fork of the `pi-laya-model-router` pi extension (in `extensions/`),
which adds on/off control to the `/laya-router` command. The npm-published package is **not
installed** alongside it — the fork is the single source of the command.

Wire it up once:

```bash
pi remove npm:pi-laya-model-router       # remove the npm package (one time)
mkdir -p ~/.pi/agent/extensions
ln -s ~/projects/pi-laya-server/extensions/laya-model-router.ts ~/.pi/agent/extensions/laya-model-router.ts
ln -s ~/projects/pi-laya-server/extensions/laya-socket-client.ts ~/.pi/agent/extensions/laya-socket-client.ts
# then run /reload in pi
```

Then, inside pi:

- `/laya-router` (or `status`) — show mode, level mappings and service state
- `/laya-router on` — start the `pi-laya` systemd user service
- `/laya-router off` — stop the service and silence the router entirely
- `/laya-router toggle` — flip between on and off

When the router is off, `before_agent_start` returns immediately: no socket call, no warning
notification, and the status line shows nothing. The off state is persisted to a marker file at
`~/.pi/agent/laya-router-disabled`, so it survives pi restarts (`/laya-router on` removes it).
The service is intentionally **not** disabled at boot — it stays `enabled` and will start on
login; only the user-facing state is toggled.
