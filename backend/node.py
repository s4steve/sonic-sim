"""Talk to a running sonic-vs node: push config, pull running config, diff.

All via `docker exec`. Uses vtysh/sonic-cfggen, not the SONiC `show`/`config reload`
commands that need sudo (broken in sonic-vs, see docs/spike.md).
"""
import difflib
import json
import subprocess

from .lab import LabError, check_name, node_dir


def container(lab: str, node: str) -> str:
    return f"clab-{check_name(lab)}-{check_name(node)}"


def sh(lab: str, node: str, cmd: str, stdin: str | None = None, timeout: int = 60) -> str:
    r = subprocess.run(["docker", "exec", "-i", container(lab, node), "bash", "-c", cmd],
                       input=stdin, capture_output=True, text=True, timeout=timeout)
    if r.returncode:
        raise RuntimeError(f"{node}: `{cmd}` failed:\n{(r.stderr or r.stdout)[-2000:]}")
    return r.stdout


def parse_config_db(text: str) -> dict:
    """Validate an imported config_db.json: an object of table -> object. Contents pass through untouched."""
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise LabError(f"not valid JSON: {e}") from None
    if not isinstance(data, dict) or not all(isinstance(v, dict) for v in data.values()):
        raise LabError("config_db.json must be an object of TABLE -> {key: {field: value}}")
    return data


def dump_config_db(data: dict) -> str:
    return json.dumps(data, indent=4, sort_keys=True) + "\n"  # same layout as `config save`


def run(lab: str, node: str, *argv: str, stdin: str | None = None) -> subprocess.CompletedProcess:
    """docker exec with an argv list (no shell), so user-supplied keys can't inject commands."""
    return subprocess.run(["docker", "exec", "-i", container(lab, node), *argv],
                          input=stdin, capture_output=True, text=True, timeout=60)


# Delete dependents before what they depend on: IPs and members first, then base keys.
def _delete_order(tk: tuple[str, str]) -> tuple:
    table, key = tk
    return (0 if table.endswith(("_MEMBER", "INTERFACE")) else 1, -key.count("|"))


def config_db_removals(old: dict, new: dict) -> tuple[list[tuple[str, str]], list[tuple[str, str, str]]]:
    """(keys to DEL, fields to HDEL) to turn CONFIG_DB `old` into `new` (merging `new` does the rest)."""
    keys, fields = [], []
    for table, rows in old.items():
        for key, row in rows.items():
            if key not in new.get(table, {}):
                keys.append((table, key))
            else:
                fields += [(table, key, f) for f in row if f not in new[table][key]]
    return sorted(keys, key=_delete_order), fields


_FRR_SKIP = ("!", "exit", "exit-address-family", "end", "frr version", "frr defaults", "service integrated-vtysh-config")


def _frr_paths(text: str) -> list[tuple[str, ...]]:
    """Each config line with its parent context lines, from FRR's indentation."""
    paths, stack = [], []
    for line in text.splitlines():
        body = line.strip()
        if not body or body.startswith(_FRR_SKIP):
            continue
        depth = len(line) - len(line.lstrip(" "))
        stack = [(d, l) for d, l in stack if d < depth]
        paths.append(tuple(l for _, l in stack) + (body,))
        stack.append((depth, body))
    return paths


def frr_removals(old: str, new: str) -> list[list[str]]:
    """vtysh command sequences that undo lines present in `old` but not `new`.
    `vtysh -f new` only adds, so this is the delete half of a reload (no frr-reload.py in sonic-vs)."""
    new_paths, cmds = set(_frr_paths(new)), []
    gone = [p for p in _frr_paths(old) if p not in new_paths]
    for p in gone:
        if any(p[:i] in gone for i in range(1, len(p))):
            continue  # a removed parent block takes this with it
        last = p[-1]
        cmds.append([*p[:-1], last[3:] if last.startswith("no ") else "no " + last])
    return cmds


def apply(lab: str, node: str, config_db: dict, frr: str, live: bool) -> list[str]:
    """Save both files; if `live`, make the running node match them, deletions included.
    Returns warnings (commands the node rejected)."""
    nd = node_dir(lab, node)
    nd.mkdir(parents=True, exist_ok=True)
    old_cdb = json.loads((nd / "config_db.json").read_text()) if (nd / "config_db.json").exists() else {}
    old_frr = (nd / "frr.conf").read_text() if (nd / "frr.conf").exists() else ""
    (nd / "config_db.json").write_text(dump_config_db(config_db))
    (nd / "frr.conf").write_text(frr)
    for f in ("config_db.json", "frr.conf"):
        (nd / f).chmod(0o644)
    if not live:
        return []
    warnings = []

    def do(*argv, stdin=None):
        r = run(lab, node, *argv, stdin=stdin)
        if r.returncode or "% " in r.stdout:  # vtysh reports errors as "% ..." on stdout
            warnings.append(f"{' '.join(argv)[-200:]}: {(r.stderr or r.stdout).strip()[-300:]}")

    keys, fields = config_db_removals(old_cdb, config_db)
    for table, key in keys:
        do("sonic-db-cli", "CONFIG_DB", "DEL", f"{table}|{key}")
    for table, key, field in fields:
        do("sonic-db-cli", "CONFIG_DB", "HDEL", f"{table}|{key}", field)
    do("sonic-cfggen", "-j", "/dev/stdin", "--write-to-db", stdin=dump_config_db(config_db))
    for seq in frr_removals(old_frr, frr):
        do("vtysh", "-c", "configure terminal", *[a for c in seq for a in ("-c", c)])
    do("vtysh", "-f", "/cfg/frr.conf")
    return warnings


def running(lab: str, node: str) -> dict[str, str]:
    """The node's running config as {filename: text}."""
    sh(lab, node, "config save -y >/dev/null 2>&1; vtysh -c 'write memory' >/dev/null")
    return {"config_db.json": dump_config_db(json.loads(sh(lab, node, "cat /etc/sonic/config_db.json"))),
            "frr.conf": sh(lab, node, "cat /etc/frr/frr.conf")}


def diff(lab: str, node: str) -> str:
    """Unified diff saved -> running, for both files. Empty string = in sync."""
    nd = node_dir(lab, node)
    out = []
    for name, live in running(lab, node).items():
        saved = (nd / name).read_text() if (nd / name).exists() else ""
        if name == "config_db.json" and saved:
            saved = dump_config_db(json.loads(saved))  # compare content, not formatting
        out += difflib.unified_diff(saved.splitlines(True), live.splitlines(True),
                                    f"saved/{node}/{name}", f"running/{node}/{name}")
    return "".join(out)


def pull(lab: str, node: str) -> None:
    """Overwrite the saved files with the node's running config."""
    nd = node_dir(lab, node)
    for name, text in running(lab, node).items():
        (nd / name).write_text(text)
        (nd / name).chmod(0o644)


# One Redis round trip for every port's and PortChannel's oper status (fixed script, no user input).
_OPER_LUA = ("local r={} for _,p in ipairs({'PORT_TABLE:Ethernet*','LAG_TABLE:PortChannel*'}) do "
             "for _,k in ipairs(redis.call('keys',p)) do r[#r+1]=k..' '..(redis.call('hget',k,'oper_status') or '') end end return r")


def bgp_peers(lab: str, node: str) -> dict:
    """{peer_ip: {state, remoteAs, pfxRcd}} from FRR; {} if BGP isn't configured."""
    r = run(lab, node, "vtysh", "-c", "show bgp summary json")
    try:
        peers = json.loads(r.stdout or "{}").get("ipv4Unicast", {}).get("peers", {})
    except json.JSONDecodeError:
        return {}
    return {ip: {k: p.get(k) for k in ("state", "remoteAs", "pfxRcd")} for ip, p in peers.items()}


def live(lab: str, node: str) -> dict:
    """{ports: {Ethernet0: "up", PortChannel1: "down", ...}, bgp: {...}} for one running sonic node."""
    r = run(lab, node, "redis-cli", "-n", "0", "--raw", "eval", _OPER_LUA, "0")
    ports = dict(line.split(":", 1)[1].split(" ", 1) for line in r.stdout.splitlines() if " " in line)
    return {"ports": ports, "bgp": bgp_peers(lab, node)}


def capture(lab: str, node: str, iface: str, seconds: int) -> bytes:
    """pcap of `seconds` of traffic on the container's ethN (the cable itself), max 5000 packets."""
    r = subprocess.run(["docker", "exec", container(lab, node), "timeout", str(seconds),
                        "tcpdump", "-i", iface, "-U", "-c", "5000", "-w", "-"],
                       capture_output=True, timeout=seconds + 15)
    if not r.stdout:  # timeout exits 124 even on success; only an empty pcap is a failure
        raise RuntimeError(f"capture on {node}:{iface} failed: {r.stderr.decode()[-500:]}")
    return r.stdout


if __name__ == "__main__":  # self-check: python -m backend.node
    keys, fields = config_db_removals(
        {"VLAN": {"Vlan10": {"vlanid": "10"}}, "VLAN_MEMBER": {"Vlan10|Ethernet8": {"tagging_mode": "untagged"}},
         "INTERFACE": {"Ethernet0": {}, "Ethernet0|10.0.0.1/31": {}}, "PORT": {"Ethernet0": {"admin_status": "up", "description": "x"}}},
        {"INTERFACE": {"Ethernet0": {}}, "PORT": {"Ethernet0": {"admin_status": "up"}}})
    assert keys == [("VLAN_MEMBER", "Vlan10|Ethernet8"), ("INTERFACE", "Ethernet0|10.0.0.1/31"), ("VLAN", "Vlan10")], keys
    assert fields == [("PORT", "Ethernet0", "description")], fields
    old = "frr version 10\n!\nip route 10.9.0.0/16 10.0.12.1\nrouter bgp 65001\n no bgp ebgp-requires-policy\n neighbor 10.0.12.1 remote-as 65002\n !\n address-family ipv4 unicast\n  network 10.0.1.0/24\n  network 10.0.9.0/24\n exit-address-family\nexit\n"
    new = "router bgp 65001\n neighbor 10.0.12.1 remote-as 65002\n address-family ipv4 unicast\n  network 10.0.1.0/24\n exit-address-family\n"
    assert frr_removals(old, new) == [
        ["no ip route 10.9.0.0/16 10.0.12.1"],
        ["router bgp 65001", "bgp ebgp-requires-policy"],
        ["router bgp 65001", "address-family ipv4 unicast", "no network 10.0.9.0/24"]], frr_removals(old, new)
    assert frr_removals(old, new.replace("65001", "65009")) == [["no ip route 10.9.0.0/16 10.0.12.1"], ["no router bgp 65001"]]
    print("node.py self-check OK")
