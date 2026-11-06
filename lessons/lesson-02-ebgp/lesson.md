# Lesson 2: Replace static routes with eBGP

This is the lab from lesson 1, with all the interfaces done but **no routes**. Static routes don't scale, so data centers run BGP between every pair of switches. SONiC uses **FRR** for routing, and in sonic-vs BGP is configured in FRR's own file, `frr.conf`.

## Goal
- sw1 (AS **65001**) and sw2 (AS **65002**) have an eBGP session Established.
- Each switch learns the other's host subnet **via BGP**.
- h1 can ping h2.

## Steps
1. On **sw1 → Configure → Routing**, tick **BGP**. Set Local AS `65001` and Router ID `10.0.12.0`.
2. Add a neighbor: `10.0.12.1`, AS `65002`.
3. Under **Advertise networks** add `10.0.1.0/24`, the subnet h1 lives on.
4. Leave **"Don't require route-maps on eBGP sessions"** ticked. Modern FRR refuses to exchange eBGP routes until you write policy. That's sensible in production, but not needed for a lab.
5. Do the mirror image on sw2: AS `65002`, router ID `10.0.12.1`, neighbor `10.0.12.0` AS `65001`, network `10.0.2.0/24`.
6. **Save & apply** both, wait a few seconds, then **Check my work**.

## Look around
- Click a switch: the side panel lists its BGP peers and how many prefixes each sent. The node badge shows **BGP 1/1**.
- In a terminal: `vtysh -c "show bgp summary"` and `vtysh -c "show ip route"` (look for `B>*`).
- Try unticking the route-map option on one side and applying. The session stays up, but routes stop flowing. Can you see it in `show bgp summary`?
