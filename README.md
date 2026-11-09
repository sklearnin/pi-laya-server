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
