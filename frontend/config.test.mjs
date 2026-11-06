// Self-check for config.js: node frontend/config.test.mjs
import assert from "node:assert/strict";
import { setIp, ipEntries, deleteGroup, warnings, diffConfigDb, diffLines, parseFrr, writeFrr } from "./config.js";

// IPs keep the bare interface key while any IP remains
const cdb = {};
setIp(cdb, "Ethernet0", "10.0.0.0/31", true);
setIp(cdb, "Loopback0", "10.255.0.1/32", true);
assert.deepEqual(cdb.INTERFACE, { Ethernet0: {}, "Ethernet0|10.0.0.0/31": {} });
assert.deepEqual(ipEntries(cdb).map((e) => e.ifname), ["Ethernet0", "Loopback0"]);
setIp(cdb, "Ethernet0", "10.0.0.0/31", false);
assert.equal(cdb.INTERFACE, undefined);

// Deleting a VLAN takes its members and SVI IPs
const v = { VLAN: { Vlan100: { vlanid: "100" } }, VLAN_MEMBER: { "Vlan100|Ethernet8": { tagging_mode: "untagged" } } };
setIp(v, "Vlan100", "10.100.0.1/24", true);
setIp(v, "Ethernet8", "10.9.9.1/24", true);
assert.deepEqual(warnings(v), ["Ethernet8 has an IP and is also a VLAN member"]);
deleteGroup(v, "VLAN", "Vlan100");
assert.deepEqual(Object.keys(v), ["INTERFACE"]);

assert.deepEqual(diffConfigDb({ A: { x: {} } }, { A: { x: { f: "1" } }, B: { y: {} } }),
  ['~ A|x {} → {"f":"1"}', "+ B|y {}"]);
assert.deepEqual(diffLines("a\nb\n!\n", "b\nc\n"), ["- a", "+ c"]);

// frr.conf round trip keeps lines the form doesn't own
const frr = `frr version 10.4.1
hostname sw1
service integrated-vtysh-config
!
ip route 10.9.0.0/16 10.0.12.1
router bgp 65001
 bgp router-id 10.0.12.0
 no bgp ebgp-requires-policy
 neighbor 10.0.12.1 remote-as 65002
 !
 address-family ipv4 unicast
  network 10.0.1.0/24
 exit-address-family
exit
!
ip nht resolve-via-default
`;
const m = parseFrr(frr);
assert.deepEqual(m.static, [{ prefix: "10.9.0.0/16", nexthop: "10.0.12.1" }]);
assert.deepEqual(m.bgp, { asn: "65001", routerId: "10.0.12.0", noPolicy: true,
  neighbors: [{ ip: "10.0.12.1", asn: "65002" }], networks: ["10.0.1.0/24"], redistribute: [] });
assert.deepEqual(m.unsupported, []);
assert.deepEqual(parseFrr(writeFrr(frr, m)), m);
const out = writeFrr(frr, { ...m, static: [], bgp: { ...m.bgp, networks: ["10.0.1.0/24", "10.255.0.1/32"] } });
assert.match(out, /^frr version 10.4.1\nhostname sw1\n/);
assert.match(out, /  network 10.255.0.1\/32\n/);
assert.match(out, /ip nht resolve-via-default\n$/);
assert.doesNotMatch(out, /ip route/);
assert.deepEqual(parseFrr("router bgp 1\n neighbor X peer-group\n").unsupported, ["neighbor X peer-group"]);
assert.equal(writeFrr("", { static: [], bgp: null, unsupported: [] }), "\n");

console.log("config.js self-check OK");
