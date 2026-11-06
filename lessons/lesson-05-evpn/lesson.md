# Lesson 5: Stretch a subnet across leaves with EVPN-VXLAN

The leaf-spine **underlay** is done: every switch runs eBGP and the leaves' loopbacks (`10.255.1.1`, `10.255.1.2`) can reach each other. But h1 (`10.10.0.11/24`) and h2 (`10.10.0.12/24`) are in the **same subnet** on **different leaves**, and routing can't join them. You'll build a layer-2 **overlay**: VLAN 10 carried inside VXLAN (VNI 1010) between the leaves, with BGP EVPN telling each leaf where the other's MACs live.

## Goal
h1 and h2 ping each other as if they shared one switch.

## Steps, on each leaf
1. **VLANs:** add VLAN `10` with `Ethernet8` (the host port) **untagged**.
2. **VXLAN:** set the VTEP source IP to the leaf's loopback (`10.255.1.1` on leaf1, `10.255.1.2` on leaf2). Tick **Use BGP EVPN**. Map `Vlan10` to VNI `1010`.
3. **Routing:** under EVPN tick **Exchange EVPN routes** and **Advertise all local VNIs**.

## On each spine
4. **Routing:** tick **Exchange EVPN routes** only. Spines carry EVPN routes between leaves but have no VNIs of their own.

**Save & apply** everything, wait about 10 seconds, then **Check my work**.

## Look around
- On leaf1: `vtysh -c "show evpn vni"` (one remote VTEP), `vtysh -c "show bgp l2vpn evpn route"` (type-2 = MACs, type-3 = VTEPs), and `bridge fdb show | grep 10.255` (h2's MAC points at leaf2's VTEP).
- Capture on a spine link while h1 pings h2 and open it in Wireshark: you'll see ICMP inside UDP port 4789 (VXLAN).
