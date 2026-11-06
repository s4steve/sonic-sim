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


def push(lab: str, node: str) -> None:
    """Apply the saved files to a running node. MERGE only: removed entries stay until redeploy."""
    nd = node_dir(lab, node)
    sh(lab, node, "sonic-cfggen -j /dev/stdin --write-to-db", stdin=(nd / "config_db.json").read_text())
    sh(lab, node, "vtysh -f /cfg/frr.conf")  # /cfg is the bind-mounted node folder


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
