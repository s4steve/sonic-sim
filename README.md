# sonic-sim

A lab simulator for learning SONiC. Labs run real `docker-sonic-vs` switches wired by containerlab on an x86 Linux host.

- `labs/<name>/lab.yaml`: topology (nodes, links using SONiC port names)
- `labs/<name>/checks.yaml`: scripted assertions (`ping`, `bgp_established`, `route`) run from the Checks button
- `labs/<name>/nodes/<node>/config_db.json` and `frr.conf`: each switch's config. CONFIG_DB is merged over sonic-vs defaults at deploy; BGP lives in FRR (see `docs/spike.md`)
- `backend/`: FastAPI lab engine

## Sample labs
- `two-switch`: h1 – sw1 ⇄ sw2 – h2 with one eBGP session. The smallest useful lab.
- `leaf-spine`: 2 spines, 2 leaves, 2 hosts. eBGP from each leaf to both spines, ECMP between them. Shut a leaf uplink (Configure → Ports → admin down → Save & apply) to watch the cable go red, BGP drop to 1/2, and the pings keep passing through the other spine.

## Self-checks
```bash
uv run python -m backend.lab && uv run python -m backend.node
node frontend/config.test.mjs
```

## Run (on the lab host)
```bash
uv sync
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
| `POST .../config` | save `{config_db, frr, apply}`; with `apply`, the running node is made to match, deletions included |
| `GET .../diff`, `POST .../pull` | saved vs running diff; save running config |
| `GET /labs/{lab}/live` | port oper status + BGP peers for each running switch (the canvas polls this) |
| `GET/PUT /labs/{lab}/checks`, `POST .../checks/run` | read/save checks.yaml, run it |
| `GET /labs/{lab}/capture?node=&port=&seconds=` | pcap of one cable end |
| `WS .../terminal` | shell in the node (`docker exec -it … bash`) for the web terminal |
