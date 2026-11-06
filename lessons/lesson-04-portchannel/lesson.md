# Lesson 4: Bundle two links into a PortChannel (LAG)

sw1 and sw2 are joined by **two** cables. Used one by one, you'd need two subnets and you'd lose a link's worth of addressing. A **PortChannel** (link aggregation, LACP) bundles them into one logical link that keeps working if a member fails.

The host ports, the ports' admin state and static routes are done. The static routes already point at the far end of the PortChannel you're about to build.

## Goal
- `PortChannel1` on both switches, with `Ethernet0` and `Ethernet4` as members.
- sw1's PortChannel1 is `10.0.12.0/31` and sw2's is `10.0.12.1/31`.
- sw1 pings sw2 over it, and h1 pings h2.

## Steps
1. **sw1 → Configure → PortChannels:** add PortChannel `1`, then add members `Ethernet0` and `Ethernet4`.
2. **IP tab:** pick `PortChannel1` and give it `10.0.12.0/31`. The IP goes on the bundle, **not** on the member ports.
3. Repeat on sw2 with `10.0.12.1/31`.
4. **Save & apply** both. LACP needs a few seconds to negotiate, so give it 5 to 10 seconds, then **Check my work**.

## Then try this
- In a terminal on sw1: `teamdctl PortChannel1 state` shows LACP's view of each member.
- Select one of the two sw1 ↔ sw2 cables and **Cut link**. Run the checks again: they should still pass over the remaining member. Bring the link back up afterwards.
