"""HTTP API + web UI for the lab engine. Run on the lab host:
    uv run uvicorn backend.app:app --port 8080        # then: ssh -L 8080:localhost:8080 <host>
No auth: the terminal gives root shells in lab containers, so keep it on localhost
(SSH tunnel) or a trusted LAN/Tailscale address, never a public one.
"""
import asyncio
import json
import os
import pty
import subprocess
from fcntl import ioctl
from pathlib import Path
from struct import pack
from termios import TIOCSWINSZ

from fastapi import Body, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from . import lab as labs
from . import node as nodes

app = FastAPI(title="sonic-sim")


@app.exception_handler(labs.LabError)
def bad_request(_: Request, e: labs.LabError):
    return JSONResponse({"detail": str(e)}, status_code=400)


@app.exception_handler(RuntimeError)
def command_failed(_: Request, e: RuntimeError):
    return JSONResponse({"detail": str(e)}, status_code=502)


def sonic_node(lab: str, node: str) -> None:
    if labs.load(lab)["nodes"].get(node, {}).get("kind") != "sonic":
        raise HTTPException(404, f"no sonic node {node!r} in lab {lab!r}")


@app.get("/labs")
def list_labs():
    return labs.list_labs()


@app.get("/labs/{lab}")
def get_lab(lab: str):
    if not (labs.lab_dir(lab) / "lab.yaml").exists():
        raise HTTPException(404, f"no lab {lab!r}")
    return {**labs.load(lab), "status": labs.status(lab)}


@app.put("/labs/{lab}")
def put_lab(lab: str, body: dict = Body(...)):
    labs.save({**body, "name": labs.check_name(lab)})
    return labs.load(lab)


@app.post("/labs/{lab}/deploy")
def deploy(lab: str):
    labs.deploy(lab)
    return labs.status(lab)


@app.post("/labs/{lab}/destroy")
def destroy(lab: str):
    labs.destroy(lab)
    return {"ok": True}


@app.get("/labs/{lab}/nodes/{node}/config_db.json")
def export_config_db(lab: str, node: str):
    sonic_node(lab, node)
    return PlainTextResponse((labs.node_dir(lab, node) / "config_db.json").read_text(), media_type="application/json")


@app.put("/labs/{lab}/nodes/{node}/config_db.json")
async def import_config_db(lab: str, node: str, request: Request):
    sonic_node(lab, node)
    data = nodes.parse_config_db((await request.body()).decode())
    labs.node_dir(lab, node).mkdir(parents=True, exist_ok=True)
    (labs.node_dir(lab, node) / "config_db.json").write_text(nodes.dump_config_db(data))
    return {"tables": sorted(data)}


@app.get("/labs/{lab}/nodes/{node}/frr.conf", response_class=PlainTextResponse)
def export_frr(lab: str, node: str):
    sonic_node(lab, node)
    return (labs.node_dir(lab, node) / "frr.conf").read_text()


@app.put("/labs/{lab}/nodes/{node}/frr.conf")
async def import_frr(lab: str, node: str, request: Request):
    sonic_node(lab, node)
    body = (await request.body()).decode()
    labs.node_dir(lab, node).mkdir(parents=True, exist_ok=True)
    (labs.node_dir(lab, node) / "frr.conf").write_text(body)
    return {"ok": True}


@app.post("/labs/{lab}/nodes/{node}/push")
def push(lab: str, node: str):
    sonic_node(lab, node)
    nodes.push(lab, node)
    return {"ok": True, "note": "merged into the running node; deletions need a redeploy"}


@app.get("/labs/{lab}/nodes/{node}/diff", response_class=PlainTextResponse)
def diff(lab: str, node: str):
    sonic_node(lab, node)
    return nodes.diff(lab, node)


@app.post("/labs/{lab}/nodes/{node}/pull")
def pull(lab: str, node: str):
    sonic_node(lab, node)
    nodes.pull(lab, node)
    return {"ok": True}


@app.websocket("/labs/{lab}/nodes/{node}/terminal")
async def terminal(ws: WebSocket, lab: str, node: str):
    """Bridge xterm.js <-> `docker exec -it <node> bash` through a pty.
    Client sends JSON: {"i": "<keystrokes>"} or {"r": [cols, rows]}; server sends raw bytes."""
    await ws.accept()
    try:
        if node not in labs.load(lab)["nodes"]:
            raise labs.LabError(f"no node {node!r}")
    except (labs.LabError, OSError) as e:
        await ws.close(code=4404, reason=str(e)[:120])
        return
    master, slave = pty.openpty()
    proc = subprocess.Popen(["docker", "exec", "-it", "-e", "TERM=xterm-256color", nodes.container(lab, node), "bash"],
                            stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    loop = asyncio.get_running_loop()
    out: asyncio.Queue[bytes] = asyncio.Queue()

    def readable():
        try:
            data = os.read(master, 65536)
        except OSError:  # EIO once the shell exits
            data = b""
        if not data:
            loop.remove_reader(master)
        out.put_nowait(data)

    loop.add_reader(master, readable)

    async def to_browser():
        while data := await out.get():
            await ws.send_bytes(data)
        await ws.close()

    sender = asyncio.create_task(to_browser())
    try:
        while True:
            msg = json.loads(await ws.receive_text())
            if "i" in msg:
                os.write(master, msg["i"].encode())
            elif "r" in msg:
                cols, rows = (int(x) for x in msg["r"])
                ioctl(master, TIOCSWINSZ, pack("HHHH", rows, cols, 0, 0))
    except (WebSocketDisconnect, RuntimeError, ValueError):
        pass
    finally:
        sender.cancel()
        loop.remove_reader(master)
        proc.terminate()
        os.close(master)


# Last, so API routes win: the single-page UI (no build step).
app.mount("/", StaticFiles(directory=Path(__file__).resolve().parent.parent / "frontend", html=True), name="ui")
