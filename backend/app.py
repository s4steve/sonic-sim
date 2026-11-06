"""HTTP API for the lab engine. Run on the lab host:
    uv run uvicorn backend.app:app --host <LAN/Tailscale IP> --port 8080
No auth: it can run commands in lab containers, so never bind it to a public address.
"""
from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse

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
