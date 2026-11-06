# Lesson 3: VLANs and routing between them (SVIs)

One switch, three hosts. h1 and h2 belong in the **same subnet** (`10.10.0.0/24`, VLAN 10). h3 is in a **different** one (`10.20.0.0/24`, VLAN 20). The ports are already admin up.

## Goal
- h1 ↔ h2: **switched**, at layer 2 inside VLAN 10.
- h1 ↔ h3: **routed** between VLANs by the switch.

## Steps
1. **VLANs tab:** add VLAN `10`, then add `Ethernet0` and `Ethernet4` as **untagged** members. Untagged means an access port: the host sends plain frames.
2. Add VLAN `20` with `Ethernet8` untagged.
3. **IP tab:** pick `Vlan10` and give it `10.10.0.1/24`, then `Vlan20` with `10.20.0.1/24`. An IP on a VLAN is an **SVI**, the router interface for that VLAN and the hosts' gateway.
4. **Save & apply**, then **Check my work**.

## Look around
- The diff preview shows the CONFIG_DB tables involved: `VLAN`, `VLAN_MEMBER`, `VLAN_INTERFACE`.
- Run `show vlan brief` in a terminal on sw1.
- On h1, run `ip neigh` after pinging h2 (you'll see h2's real MAC) and after pinging h3 (you'll see the **switch's** MAC). That difference is switching versus routing.
