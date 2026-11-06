# Phase 0 spike findings (2026-11-06)

**Result: exit criteria met.** Two sonic-vs switches ran eBGP (AS65001 ↔ AS65002), and h1 pinged h2 through both of them (TTL 62, 0% loss). Configs applied from files at deploy time gave the same result.

## Environment
| | |
|---|---|
| Host | `syrinx` (`syrinx.local`, 192.168.0.248): x86_64, 16 cores, 27 GB RAM, Ubuntu 26.04.1 |
| Docker | Engine 28.3.3 at `/var/run/docker.sock`. The CLI's active context is Docker Desktop (not running), so always set `DOCKER_HOST=unix:///var/run/docker.sock` or `--context default` |
| containerlab | 0.82.0. User `stevew` is in `clab_admins`, so no sudo is needed |
| SONiC image | `docker-sonic-vs:202511`: mssonic build 1268989, 211 MB gz, 817 MB loaded, sha256 `1596ad38266e9928c584d6ebd89f72fcb02d2a08ca1f82e1e6f8878821f16009`. Kept at `~/sonic-images/` on syrinx |
| Host image | `ghcr.io/hellt/network-multitool` |

## Answers to the plan's questions
1. **Ports.** hwsku Force10-S6000 has 32 ports, `Ethernet0, 4, 8 … 124`. containerlab `ethN` maps to `Ethernet{4*(N-1)}` (eth1→Ethernet0, eth2→Ethernet4), via `/usr/share/sonic/hwsku/lanemap.ini`. Port speed shows 10G once up, MTU 9100.
2. **Applying config.**
   - `config reload` is **broken** in sonic-vs: it needs `sudo` (not installed) and systemd (the image uses supervisord).
   - `docker restart` of a single node **breaks the lab**, because the containerlab veth links are lost. Don't do it.
   - `/etc/sonic/config_db.json` **can't be bind-mounted**, because `start.sh` replaces it with `mv`.
   - The containerlab sonic-vs kind has **no `startup-config`**.
   - ✅ **What works: full apply = (re)deploy.** Mount `cfg/<node>` at `/cfg`, then the kind's `exec:` waits for zebra, runs `sonic-cfggen -j /cfg/config_db.json --write-to-db`, `supervisorctl start bgpd`, then `vtysh -f /cfg/frr.conf`. See `spike/spike2.clab.yml`. The lab deploys in 37 s and traffic flows at about 41 s.
   - ✅ **Incremental apply on a live node:** `sonic-cfggen -j part.json --write-to-db`, which only *merges*. Deleting something needs an explicit removal (`sonic-db-cli CONFIG_DB DEL …` or a `config` CLI command).
   - ✅ **Pull the running config:** `config save -y` and `vtysh -c 'write memory'`, then `docker cp` out `/etc/sonic/config_db.json` and `/etc/frr/frr.conf`.
3. **BGP model: FRR config directly (`frr.conf`), not CONFIG_DB.** sonic-vs has no `bgpcfgd`, so `BGP_NEIGHBOR`-style tables are never turned into FRR config. `bgpd` also has `autostart=false` and must be started by hand. A node's config is therefore **two files**: `config_db.json` (ports, IPs, VLANs, LAGs, VRFs, VXLAN, ACL, QoS) plus `frr.conf` (BGP, plus static routes if we want them in FRR).
4. **CLI.** `show ip bgp …` and `show ip route` are **broken** (they need sudo, and the bgp plugin isn't registered). `show interfaces status` works. Use `vtysh -c "show bgp summary"` and `vtysh -c "show ip route"` for routing state. The app's terminal and status poller should use vtysh for anything routing-related.
5. **Resources.** About 130–160 MB RAM per switch and about 1 MB per host. RAM won't limit lab size on this host; CPU and boot contention will come first. Boot to zebra-ready takes well under a minute when configs are applied at deploy.
6. **Dataplane fidelity** (every item below was programmed into ASIC_DB):
   | Feature | Programmed | Enforced in traffic |
   |---|---|---|
   | L3 routes, interface IPs | ✅ | ✅ (ping verified) |
   | BGP → FIB (FRR→fpmsyncd→orchagent) | ✅ | ✅ |
   | VLAN, VLAN member, SVI | ✅ (kernel `Vlan100@Bridge`) | not yet traffic-tested |
   | PortChannel/LAG (teamd) | ✅ | not yet traffic-tested |
   | VRF | ✅ (kernel VRF device) | not yet traffic-tested |
   | VXLAN + BGP EVPN (L2 VNI) | ✅ (kernel `vtep-10`, bridged) | ✅ Phase 5: hosts in one subnet on different leaves ping over VNI 1010. MACs learned via EVPN type-2, flood list via type-3; auto route-targets match across leaf ASNs and spines keep the next hop |
   | ACL | ✅ | ❌ **not enforced**: a DROP rule for h1 still passed pings |
   | QoS maps/schedulers/WRED | ✅ (from defaults) | ❌ assumed not enforced (software dataplane) |

   The UI must label ACL and QoS as "config-only in sonic-vs".

## Plan changes this causes
- A node's config is `config_db.json` + `frr.conf`. Import/export handles both, and the BGP editor writes `frr.conf`.
- "Deploy" and "Apply full config" both mean containerlab (re)deploy using the exec recipe above. "Apply change" on a running lab means a merge via `sonic-cfggen --write-to-db`, plus explicit deletes.
- The status poller and checks use `vtysh` and `redis-cli`, not the SONiC `show` commands that need sudo.
- `spike/configure.sh` uses the CLI path (`config interface ip add`) and is kept for reference only.

## Phase 5 additions
- **Link cut** (`ip link set ethN down` on one end) drops carrier on both veth ends, and both SONiC ports go oper down. Unlike an admin shutdown, FRR keeps the BGP session until the hold timer (180 s) expires. That's a realistic gray failure.
- **netem** (`tc qdisc … netem`) works inside both node types. 20 ms each way gives about 41 ms RTT.
