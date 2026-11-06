# sonic-sim

A lab simulator for learning SONiC. Labs run real `docker-sonic-vs` switches wired by containerlab on an x86 Linux host.

- `labs/<name>/lab.yaml`: topology (nodes, links using SONiC port names)
- `labs/<name>/nodes/<node>/config_db.json` and `frr.conf`: each switch's config. CONFIG_DB is merged over sonic-vs defaults at deploy; BGP lives in FRR (see `docs/spike.md`)
- `backend/`: FastAPI lab engine

## Run (on the lab host)
```bash
uv sync
uv run python -m backend.lab            # self-check
uv run uvicorn backend.app:app --port 8080
```
Then from your Mac, tunnel to it and open http://localhost:8080:
```bash
ssh -N -L 8080:localhost:8080 syrinx.local
```
No auth: the web terminal gives root shells in lab containers, so keep it on localhost behind the tunnel (or a trusted LAN/Tailscale address), never public.

The UI (`frontend/`) has no build step: React, React Flow and xterm.js load as pinned ES modules from esm.sh/jsDelivr, so the browser needs internet access.

## API
| | |
|---|---|
| `GET /labs`, `GET/PUT /labs/{lab}` | list, read (with live status), save topology |
| `POST /labs/{lab}/deploy`, `/destroy` | (re)deploy from saved files, tear down |
| `GET/PUT /labs/{lab}/nodes/{node}/config_db.json`, `frr.conf` | export / import |
| `POST .../push` | merge saved config into the running node (deletions need a redeploy) |
| `GET .../diff`, `POST .../pull` | saved vs running diff; save running config |
| `WS .../terminal` | shell in the node (`docker exec -it … bash`) for the web terminal |
