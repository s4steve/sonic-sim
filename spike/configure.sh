#!/usr/bin/env bash
# Configure the spike lab by hand-equivalent CLI commands, then check it.
# Run on syrinx after deploy: ./configure.sh
set -euo pipefail
sw() { docker exec "clab-spike-$1" bash -c "$2"; }

# sw1: Ethernet0 -> sw2 (10.0.12.0/31), Ethernet4 -> h1 (10.0.1.0/24)
sw sw1 'config interface ip add Ethernet0 10.0.12.0/31 && config interface ip add Ethernet4 10.0.1.1/24 && config interface startup Ethernet0 && config interface startup Ethernet4'
sw sw2 'config interface ip add Ethernet0 10.0.12.1/31 && config interface ip add Ethernet4 10.0.2.1/24 && config interface startup Ethernet0 && config interface startup Ethernet4'

# eBGP straight into FRR. sonic-vs ships bgpd with autostart=false and no bgpcfgd,
# so CONFIG_DB BGP tables are never rendered: start bgpd and configure FRR directly.
for n in sw1 sw2; do sw $n 'supervisorctl start bgpd'; done
sw sw1 "vtysh -c 'conf t' -c 'router bgp 65001' -c 'bgp router-id 10.0.12.0' -c 'no bgp ebgp-requires-policy' \
  -c 'neighbor 10.0.12.1 remote-as 65002' -c 'address-family ipv4 unicast' -c 'network 10.0.1.0/24'"
sw sw2 "vtysh -c 'conf t' -c 'router bgp 65002' -c 'bgp router-id 10.0.12.1' -c 'no bgp ebgp-requires-policy' \
  -c 'neighbor 10.0.12.0 remote-as 65001' -c 'address-family ipv4 unicast' -c 'network 10.0.2.0/24'"

sleep 15
sw sw1 'show ip bgp summary; show ip route'
docker exec clab-spike-h1 ping -c 3 10.0.2.10
