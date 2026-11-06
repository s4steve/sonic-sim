// Pure helpers for SONiC config: no DOM, no React, so `node frontend/config.test.mjs` can check them.

// ponytail: duplicated from backend/lab.py SONIC_PORTS; serve it from the API if hwskus ever vary
export const PORTS = {
  sonic: Array.from({ length: 32 }, (_, i) => `Ethernet${i * 4}`),
  host: Array.from({ length: 8 }, (_, i) => `eth${i + 1}`),
};

export async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { "content-type": "application/json" }, ...opts,
    body: opts.body && (typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body)) });
  const data = r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text();
  if (!r.ok) throw new Error(data.detail || data || r.statusText);
  return data;
}

// ---------- CONFIG_DB ----------

// Which table holds the IPs for an interface name.
export const ipTable = (ifname) =>
  ifname.startsWith("Loopback") ? "LOOPBACK_INTERFACE" : ifname.startsWith("Vlan") ? "VLAN_INTERFACE"
    : ifname.startsWith("PortChannel") ? "PORTCHANNEL_INTERFACE" : "INTERFACE";
const IP_TABLES = ["INTERFACE", "LOOPBACK_INTERFACE", "VLAN_INTERFACE", "PORTCHANNEL_INTERFACE"];

/** [{ifname, ip}] across all L3 interface tables. */
export const ipEntries = (cdb) =>
  IP_TABLES.flatMap((t) => Object.keys(cdb[t] || {}).filter((k) => k.includes("|"))
    .map((k) => ({ ifname: k.split("|")[0], ip: k.split("|")[1] })));

/** Add or remove one IP. Keeps the bare interface key SONiC needs while it has any IP. */
export function setIp(cdb, ifname, ip, on) {
  const t = ipTable(ifname);
  const rows = (cdb[t] ||= {});
  if (on) { rows[ifname] ||= {}; rows[`${ifname}|${ip}`] = {}; }
  else {
    delete rows[`${ifname}|${ip}`];
    if (!Object.keys(rows).some((k) => k.startsWith(ifname + "|"))) delete rows[ifname];
  }
  if (!Object.keys(rows).length) delete cdb[t];
}

/** {member port -> group} for VLAN_MEMBER / PORTCHANNEL_MEMBER, e.g. {Ethernet8: "Vlan100"}. */
export function membership(cdb, table) {
  const out = {};
  for (const k of Object.keys(cdb[table] || {})) {
    const [group, port] = k.split("|");
    (out[port] ||= []).push(group);
  }
  return out;
}

/** Remove a VLAN or PortChannel with everything that hangs off it. */
export function deleteGroup(cdb, table, name) {
  const member = table + "_MEMBER";
  delete cdb[table]?.[name];
  for (const k of Object.keys(cdb[member] || {})) if (k.startsWith(name + "|")) delete cdb[member][k];
  for (const { ifname, ip } of ipEntries(cdb)) if (ifname === name) setIp(cdb, name, ip, false);
  for (const t of [table, member]) if (cdb[t] && !Object.keys(cdb[t]).length) delete cdb[t];
}

/** Things SONiC will reject or silently misbehave on. */
export function warnings(cdb) {
  const out = [];
  const vlan = membership(cdb, "VLAN_MEMBER"), lag = membership(cdb, "PORTCHANNEL_MEMBER");
  const routed = new Set(ipEntries(cdb).map((e) => e.ifname));
  for (const [p, groups] of Object.entries(lag)) {
    if (groups.length > 1) out.push(`${p} is in more than one PortChannel (${groups.join(", ")})`);
    if (vlan[p]) out.push(`${p} is a PortChannel member, so put ${groups[0]} in the VLAN instead`);
    if (routed.has(p)) out.push(`${p} is a PortChannel member, so put its IP on ${groups[0]}`);
  }
  for (const p of Object.keys(vlan)) if (routed.has(p)) out.push(`${p} has an IP and is also a VLAN member`);
  for (const [k, v] of Object.entries(cdb.VLAN_MEMBER || {}))
    if (!cdb.VLAN?.[k.split("|")[0]]) out.push(`${k}: VLAN ${k.split("|")[0]} doesn't exist`);
  return out;
}

/** Entry-level diff of two CONFIG_DB objects: ["+ VLAN|Vlan100 {...}", "- ...", "~ ..."]. */
export function diffConfigDb(a, b) {
  const out = [], show = (v) => JSON.stringify(v);
  for (const t of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort())
    for (const k of [...new Set([...Object.keys(a[t] || {}), ...Object.keys(b[t] || {})])].sort()) {
      const x = a[t]?.[k], y = b[t]?.[k];
      if (!x) out.push(`+ ${t}|${k} ${show(y)}`);
      else if (!y) out.push(`- ${t}|${k}`);
      else if (show(x) !== show(y)) out.push(`~ ${t}|${k} ${show(x)} → ${show(y)}`);
    }
  return out;
}

/** Line diff ignoring order (frr.conf is small): removed then added. */
export function diffLines(a, b) {
  const count = (s) => s.split("\n").filter((l) => l.trim() && l.trim() !== "!")
    .reduce((m, l) => m.set(l, (m.get(l) || 0) + 1), new Map());
  const x = count(a), y = count(b), out = [];
  for (const [l, n] of x) for (let i = (y.get(l) || 0); i < n; i++) out.push("- " + l);
  for (const [l, n] of y) for (let i = (x.get(l) || 0); i < n; i++) out.push("+ " + l);
  return out;
}

// ---------- frr.conf (static routes + the `router bgp` block) ----------

/** Split frr.conf into top-level blocks: a line plus its indented children and closing `exit`. */
function blocks(text) {
  const out = [];
  for (const line of text.replace(/\n+$/, "").split("\n")) {
    if (out.length && (/^\s/.test(line) || line === "exit") && out.at(-1).nest) out.at(-1).lines.push(line);
    else out.push({ head: line, lines: [line], nest: /^(router|interface|route-map|vrf|key chain|bfd)\b/.test(line) });
  }
  return out;
}

/** What the routing form understands. `unsupported` = lines in `router bgp` it would lose. */
export function parseFrr(text) {
  const model = { static: [], bgp: null, unsupported: [] };
  for (const b of blocks(text)) {
    let m;
    if ((m = b.head.match(/^ip route (\S+) (\S+)$/))) model.static.push({ prefix: m[1], nexthop: m[2] });
    if (!(m = b.head.match(/^router bgp (\d+)$/))) continue;
    const bgp = (model.bgp = { asn: m[1], routerId: "", noPolicy: false, neighbors: [], networks: [], redistribute: [] });
    for (const raw of b.lines.slice(1)) {
      const l = raw.trim();
      if (["!", "exit", "exit-address-family", "address-family ipv4 unicast"].includes(l)) continue;
      if ((m = l.match(/^bgp router-id (\S+)$/))) bgp.routerId = m[1];
      else if (l === "no bgp ebgp-requires-policy") bgp.noPolicy = true;
      else if ((m = l.match(/^neighbor (\S+) remote-as (\S+)$/))) bgp.neighbors.push({ ip: m[1], asn: m[2] });
      else if ((m = l.match(/^network (\S+)$/))) bgp.networks.push(m[1]);
      else if ((m = l.match(/^redistribute (connected|static)$/))) bgp.redistribute.push(m[1]);
      else model.unsupported.push(l);
    }
  }
  return model;
}

/** Rewrite the static routes and `router bgp` block from the form; every other line is kept. */
export function writeFrr(text, model) {
  const ours = [
    ...model.static.filter((r) => r.prefix && r.nexthop).map((r) => `ip route ${r.prefix} ${r.nexthop}`),
    ...(model.bgp?.asn ? [[
      `router bgp ${model.bgp.asn}`,
      model.bgp.routerId && ` bgp router-id ${model.bgp.routerId}`,
      model.bgp.noPolicy && " no bgp ebgp-requires-policy",
      ...model.bgp.neighbors.filter((n) => n.ip && n.asn).map((n) => ` neighbor ${n.ip} remote-as ${n.asn}`),
      " address-family ipv4 unicast",
      ...model.bgp.networks.filter(Boolean).map((p) => `  network ${p}`),
      ...model.bgp.redistribute.map((r) => `  redistribute ${r}`),
      " exit-address-family",
      "exit",
    ].filter(Boolean).join("\n")] : []),
  ];
  const kept = [];
  let at = -1;
  for (const b of text.trim() ? blocks(text) : []) {
    if (/^(ip route |router bgp )/.test(b.head)) { if (at < 0) at = kept.length; continue; }
    kept.push(b.lines.join("\n"));
  }
  // Drop "!" separators left orphaned next to removed blocks, then put our lines back where they were.
  const out = kept.filter((l, i) => !(l === "!" && (kept[i - 1] === "!" || i === 0)));
  out.splice(at < 0 ? out.length : Math.min(at, out.length), 0, ...ours);
  return out.join("\n") + "\n";
}
