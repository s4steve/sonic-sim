"""Lab model (labs/<name>/lab.yaml) and containerlab deploy/destroy/inspect.

lab.yaml uses SONiC port names (Ethernet0, Ethernet4, ...) for switches and ethN for hosts:

    name: two-switch
    nodes:
      sw1: {kind: sonic}
      h1:  {kind: host, ip: 10.0.1.10/24, gw: 10.0.1.1}
    links:
      - [sw1:Ethernet0, sw2:Ethernet0]
      - [sw1:Ethernet4, h1:eth1]

Each sonic node's config lives in labs/<lab>/nodes/<node>/{config_db.json,frr.conf}.
"""
import json
import os
import re
import subprocess
from pathlib import Path

import yaml

LABS_DIR = Path(os.environ.get("SONIC_SIM_LABS", Path(__file__).resolve().parent.parent / "labs"))
SONIC_IMAGE = os.environ.get("SONIC_SIM_IMAGE", "docker-sonic-vs:202511")
HOST_IMAGE = "ghcr.io/hellt/network-multitool"
SONIC_PORTS = [f"Ethernet{4 * i}" for i in range(32)]  # Force10-S6000 hwsku in docker-sonic-vs
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,30}$")  # lab/node names become paths and container names
os.environ.setdefault("DOCKER_HOST", "unix:///var/run/docker.sock")  # syrinx CLI defaults to Docker Desktop

# Applied after boot: sonic-vs has no startup-config, no working `config reload`, and bgpd
# doesn't autostart (see docs/spike.md).
SONIC_EXEC = [
    "bash -c 'until supervisorctl status zebra | grep -q RUNNING; do sleep 2; done'",
    "sonic-cfggen -j /cfg/config_db.json --write-to-db",
    "supervisorctl start bgpd",
    "bash -c 'sleep 2; vtysh -f /cfg/frr.conf'",
]


class _Dumper(yaml.SafeDumper):
    """Keep lab.yaml readable: short lists inline, e.g. pos: [80, 80] and - [sw1:Ethernet0, sw2:Ethernet0]."""


_Dumper.add_representer(list, lambda d, v: d.represent_sequence(
    "tag:yaml.org,2002:seq", v, flow_style=all(isinstance(x, (str, int, float)) for x in v)))


class LabError(ValueError):
    pass


def check_name(name: str) -> str:
    if not NAME_RE.match(name or ""):
        raise LabError(f"bad name {name!r}: use lowercase letters, digits, '-' (max 31)")
    return name


def lab_dir(lab: str) -> Path:
    return LABS_DIR / check_name(lab)


def node_dir(lab: str, node: str) -> Path:
    return lab_dir(lab) / "nodes" / check_name(node)


def port_to_eth(port: str) -> str:
    """Ethernet0 -> eth1, Ethernet4 -> eth2 (containerlab ethN = SONiC lane group N-1)."""
    if port not in SONIC_PORTS:
        raise LabError(f"unknown SONiC port {port!r}")
    return f"eth{int(port[8:]) // 4 + 1}"


def validate(lab: dict) -> dict:
    nodes = lab.get("nodes") or {}
    for n, spec in nodes.items():
        check_name(n)
        if spec.get("kind") not in ("sonic", "host"):
            raise LabError(f"node {n}: kind must be sonic or host")
    used = set()
    for link in lab.get("links") or []:
        if len(link) != 2:
            raise LabError(f"link {link}: needs exactly two endpoints")
        for ep in link:
            node, _, port = ep.partition(":")
            if node not in nodes:
                raise LabError(f"link {link}: unknown node {node!r}")
            if nodes[node]["kind"] == "sonic":
                port_to_eth(port)
            elif not re.fullmatch(r"eth[1-9][0-9]?", port):
                raise LabError(f"link {link}: host ports are eth1, eth2, ...")
            if ep in used:
                raise LabError(f"port {ep} used twice")
            used.add(ep)
    return lab


def load(lab: str) -> dict:
    data = yaml.safe_load((lab_dir(lab) / "lab.yaml").read_text())
    if data.get("name") != lab:
        raise LabError(f"lab.yaml name {data.get('name')!r} must match folder {lab!r}")
    return validate(data)


def save(lab: dict) -> None:
    validate(lab)
    d = lab_dir(lab["name"])
    d.mkdir(parents=True, exist_ok=True)
    (d / "lab.yaml").write_text(yaml.dump(lab, Dumper=_Dumper, sort_keys=False))


def list_labs() -> list[str]:
    return sorted(p.parent.name for p in LABS_DIR.glob("*/lab.yaml"))


def to_clab(lab: dict) -> dict:
    """Our lab model -> containerlab topology dict. Binds are relative to the lab folder."""
    nodes = {}
    for n, spec in lab["nodes"].items():
        if spec["kind"] == "sonic":
            nodes[n] = {"kind": "sonic-vs", "binds": [f"nodes/{n}:/cfg:ro"]}
        else:
            exec_ = []
            if spec.get("ip"):
                exec_.append(f"ip addr add {spec['ip']} dev eth1")
            if spec.get("gw"):
                exec_.append(f"ip route replace default via {spec['gw']}")
            nodes[n] = {"kind": "linux", "image": HOST_IMAGE, **({"exec": exec_} if exec_ else {})}

    def ep(e):
        node, _, port = e.partition(":")
        return f"{node}:{port_to_eth(port) if lab['nodes'][node]['kind'] == 'sonic' else port}"

    return {
        "name": lab["name"],
        "topology": {
            "kinds": {"sonic-vs": {"image": lab.get("sonic_image", SONIC_IMAGE), "exec": SONIC_EXEC}},
            "nodes": nodes,
            "links": [{"endpoints": [ep(a), ep(b)]} for a, b in lab.get("links") or []],
        },
    }


def write_clab(lab: dict) -> Path:
    """Write the generated topology, making sure every sonic node has both config files."""
    d = lab_dir(lab["name"])
    for n, spec in lab["nodes"].items():
        if spec["kind"] != "sonic":
            continue
        nd = node_dir(lab["name"], n)
        nd.mkdir(parents=True, exist_ok=True)
        cdb = nd / "config_db.json"
        if not cdb.exists():  # merged over sonic-vs defaults at boot, so a stub is enough
            cdb.write_text(json.dumps({"DEVICE_METADATA": {"localhost": {"hostname": n}}}, indent=4) + "\n")
        (nd / "frr.conf").touch()
        for f in nd.iterdir():
            f.chmod(0o644)  # containers read these as a different user
    path = d / f"{lab['name']}.clab.yml"
    path.write_text("# GENERATED from lab.yaml by backend/lab.py: do not edit\n" + yaml.safe_dump(to_clab(lab), sort_keys=False))
    return path


def clab(*args: str, timeout: int = 600) -> str:
    r = subprocess.run(["containerlab", *args], capture_output=True, text=True, timeout=timeout)
    if r.returncode:
        raise RuntimeError(f"containerlab {' '.join(args)} failed:\n{r.stderr[-2000:]}")
    return r.stdout


def deploy(lab: str) -> str:
    # --reconfigure = fresh nodes, so the merge in SONIC_EXEC is a full config apply
    return clab("deploy", "--reconfigure", "-t", str(write_clab(load(lab))))


def destroy(lab: str) -> str:
    return clab("destroy", "--cleanup", "-t", str(write_clab(load(lab))))


def status(lab: str) -> list[dict]:
    """[{node, state, ip}] for deployed containers; [] when not deployed."""
    r = subprocess.run(["containerlab", "inspect", "--format", "json", "--name", check_name(lab)],
                       capture_output=True, text=True, timeout=60)
    if r.returncode:
        return []
    rows = next(iter(json.loads(r.stdout or "{}").values()), [])
    prefix = f"clab-{lab}-"
    return [{"node": c["name"].removeprefix(prefix), "container": c["name"], "state": c["state"],
             "ip": c.get("ipv4_address", "")} for c in rows]


if __name__ == "__main__":  # self-check: python -m backend.lab
    assert port_to_eth("Ethernet0") == "eth1" and port_to_eth("Ethernet124") == "eth32"
    sample = {"name": "t", "nodes": {"sw1": {"kind": "sonic"}, "h1": {"kind": "host", "ip": "10.0.0.2/24", "gw": "10.0.0.1"}},
              "links": [["sw1:Ethernet4", "h1:eth1"]]}
    c = to_clab(validate(sample))
    assert c["topology"]["links"] == [{"endpoints": ["sw1:eth2", "h1:eth1"]}], c
    assert c["topology"]["nodes"]["sw1"]["binds"] == ["nodes/sw1:/cfg:ro"]
    assert c["topology"]["nodes"]["h1"]["exec"][1] == "ip route replace default via 10.0.0.1"
    for bad in ({**sample, "links": [["sw1:Ethernet2", "h1:eth1"]]},              # not a real port
                {**sample, "links": [["sw1:Ethernet4", "h1:eth1"], ["sw1:Ethernet4", "h1:eth2"]]},  # reuse
                {**sample, "nodes": {"../x": {"kind": "sonic"}}, "links": []}):  # path traversal
        try:
            validate(bad)
        except LabError:
            continue
        raise AssertionError(f"accepted bad lab {bad}")
    print("lab.py self-check OK")
