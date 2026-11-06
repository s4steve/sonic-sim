"""Scripted lab checks from labs/<lab>/checks.yaml, e.g.

    - {from: h1, ping: 10.0.2.10}           # host or switch can ping an address
    - {node: leaf1, bgp_established: 2}     # exactly this many BGP peers Established
    - {node: leaf1, route: 10.0.2.0/24}     # prefix is in the routing table
    - {node: leaf1, route: 10.0.2.0/24, via: bgp}
"""
import ipaddress
import json
from concurrent.futures import ThreadPoolExecutor

import yaml

from . import node as nodes
from .lab import LabError, lab_dir, load


def path(lab: str):
    return lab_dir(lab) / "checks.yaml"


def parse(lab: str, text: str) -> list[dict]:
    """Validate checks.yaml against the lab, so nothing odd reaches a command line."""
    try:
        checks = yaml.safe_load(text) or []
    except yaml.YAMLError as e:
        raise LabError(f"checks.yaml: {e}") from None
    if not isinstance(checks, list):
        raise LabError("checks.yaml must be a list of checks")
    labnodes = load(lab)["nodes"]
    for i, c in enumerate(checks, 1):
        if not isinstance(c, dict):
            raise LabError(f"check {i}: must be a mapping")
        who = c.get("from") or c.get("node")
        if who not in labnodes:
            raise LabError(f"check {i}: unknown node {who!r}")
        try:
            if "ping" in c:
                ipaddress.ip_address(str(c["ping"]))
            elif "route" in c:
                ipaddress.ip_network(str(c["route"]))
            elif "bgp_established" in c:
                int(c["bgp_established"])
            else:
                raise LabError(f"check {i}: needs ping, route or bgp_established")
        except ValueError as e:
            raise LabError(f"check {i}: {e}") from None
        if ("route" in c or "bgp_established" in c) and labnodes[who]["kind"] != "sonic":
            raise LabError(f"check {i}: route/bgp checks need a SONiC node")
    return checks


def describe(c: dict) -> str:
    if "ping" in c:
        return f"{c['from']} can ping {c['ping']}"
    if "route" in c:
        return f"{c['node']} has a route to {c['route']}" + (f" via {c['via']}" if c.get("via") else "")
    return f"{c['node']} has {c['bgp_established']} BGP peer(s) Established"


def run_one(lab: str, c: dict) -> dict:
    try:
        if "ping" in c:
            r = nodes.run(lab, c["from"], "ping", "-c", "3", "-W", "1", "-i", "0.3", str(c["ping"]))
            ok, detail = r.returncode == 0, (r.stdout.strip().splitlines() or [r.stderr.strip()])[-2:]
            detail = " ".join(detail)
        elif "route" in c:
            r = nodes.run(lab, c["node"], "vtysh", "-c", f"show ip route {c['route']} json")
            entries = json.loads(r.stdout or "{}").get(str(c["route"]), [])
            protos = sorted({e.get("protocol") for e in entries})
            ok = bool(entries) and (not c.get("via") or c["via"] in protos)
            detail = f"found via {', '.join(protos)}" if entries else "not in routing table"
        else:
            peers = nodes.bgp_peers(lab, c["node"])
            up = [ip for ip, p in peers.items() if p["state"] == "Established"]
            ok = len(up) == int(c["bgp_established"])
            detail = f"{len(up)}/{len(peers)} Established" + "".join(
                f"; {ip} {p['state']}" for ip, p in peers.items() if p["state"] != "Established")
    except Exception as e:  # a node that's down is a failed check, not a crashed run
        ok, detail = False, str(e)[-300:]
    return {"check": describe(c), "ok": ok, "detail": detail}


def run_all(lab: str) -> list[dict]:
    checks = parse(lab, path(lab).read_text()) if path(lab).exists() else []
    with ThreadPoolExecutor(8) as pool:
        return list(pool.map(lambda c: run_one(lab, c), checks))
