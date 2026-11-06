# Lesson 1: Bring up your first routed link

Two SONiC switches, each with a host. Right now they have **no configuration** except a hostname. Your job is to get **h1 talking to h2**.

The hosts are already set up: h1 is `10.0.1.10/24` (gateway `10.0.1.1`), h2 is `10.0.2.10/24` (gateway `10.0.2.1`).

## Goal
1. sw1 can ping sw2 across the link between them.
2. h1 can ping its gateway on sw1.
3. h1 can ping h2.

## Steps
1. **Turn the ports on.** SONiC ports start *admin down*. Click **sw1 → Configure → Ports** and set `Ethernet0` and `Ethernet4` to **up**. Do the same on sw2.
2. **Address the switch-to-switch link.** On the **IP** tab give sw1 `Ethernet0` the address `10.0.12.0/31` and sw2 `Ethernet0` `10.0.12.1/31`. A /31 is the usual choice for a point-to-point link: two addresses, no waste.
3. **Address the host-facing ports.** sw1 `Ethernet4` = `10.0.1.1/24`, sw2 `Ethernet4` = `10.0.2.1/24`. These are the hosts' gateways.
4. **Tell each switch about the far subnet.** A switch only knows subnets it's directly connected to. On the **Routing** tab add a static route: on sw1, `10.0.2.0/24` via `10.0.12.1`; on sw2, `10.0.1.0/24` via `10.0.12.0`.
5. **Save & apply** on each switch, then **Check my work**.

## Look around
- Open a terminal on sw1 and run `show interfaces status`, then `vtysh -c "show ip route"`. The `C` routes are connected and the `S` routes are your static ones.
- Have a look at the **Raw** tab. The IP tab wrote `INTERFACE` entries such as `"Ethernet0|10.0.12.0/31": {}`, which is how SONiC's CONFIG_DB stores an interface address.
