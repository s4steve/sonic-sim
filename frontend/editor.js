import React, { useEffect, useRef, useState } from "react";
import htm from "htm";
import { PORTS, api, ipEntries, setIp, membership, deleteGroup, warnings, diffConfigDb, diffLines, parseFrr, writeFrr } from "./config.js";

const html = htm.bind(React.createElement);
const TABS = ["System", "Ports", "IP", "VLANs", "PortChannels", "VXLAN", "ACL", "Routing", "Raw"];

/** Full-screen editor for one SONiC node's config_db.json + frr.conf. */
export function ConfigEditor({ lab, node, running, onClose, onSaved }) {
  const [orig, setOrig] = useState(null); // {cdb, frr} as saved
  const [cdb, setCdb] = useState(null);
  const [frr, setFrr] = useState("");
  const [tab, setTab] = useState("IP");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    Promise.all([api(`/labs/${lab.name}/nodes/${node}/config_db.json`), api(`/labs/${lab.name}/nodes/${node}/frr.conf`)])
      .then(([c, f]) => { setOrig({ cdb: c, frr: f }); setCdb(structuredClone(c)); setFrr(f); })
      .catch((e) => setErr(e.message));
  }, []);

  if (!cdb) return html`<div class="modal"><div class="dialog"><p>${err || "Loading…"}</p><button onClick=${onClose}>Close</button></div></div>`;

  const edit = (fn) => { setResult(null); setCdb((c) => { const n = structuredClone(c); fn(n); return n; }); };
  const changes = [...diffConfigDb(orig.cdb, cdb).map((l) => "config_db  " + l), ...diffLines(orig.frr, frr).map((l) => "frr.conf   " + l)];
  const warn = warnings(cdb);
  // Which port is cabled to what, from the topology.
  const peers = Object.fromEntries(lab.links.flatMap(([a, b]) =>
    [[a, b], [b, a]].filter(([x]) => x.startsWith(node + ":")).map(([x, y]) => [x.split(":")[1], y])));

  async function save(apply) {
    setBusy(true); setErr(""); setResult(null);
    try {
      const r = await api(`/labs/${lab.name}/nodes/${node}/config`, { method: "POST", body: { config_db: cdb, frr, apply } });
      setOrig({ cdb: structuredClone(cdb), frr });
      setResult(r); onSaved(node, cdb);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  const props = { cdb, edit, frr, setFrr: (f) => { setResult(null); setFrr(f); }, peers, setErr };
  return html`<div class="modal" onKeyDown=${(e) => e.key === "Escape" && onClose()}>
    <div class="dialog wide">
      <div class="dlg-head">
        <h2>${node} configuration</h2>
        <nav>${TABS.map((t) => html`<button key=${t} class=${t === tab ? "tab on" : "tab"} onClick=${() => setTab(t)}>${t}</button>`)}</nav>
        <button onClick=${() => (!changes.length || confirm("Discard unsaved changes?")) && onClose()}>Close</button>
      </div>
      <div class="dlg-body">
        ${tab === "System" && html`<${System} ...${props} />`}
        ${tab === "Ports" && html`<${Ports} ...${props} />`}
        ${tab === "IP" && html`<${Ips} ...${props} />`}
        ${tab === "VLANs" && html`<${Groups} ...${props} table="VLAN" />`}
        ${tab === "PortChannels" && html`<${Groups} ...${props} table="PORTCHANNEL" />`}
        ${tab === "VXLAN" && html`<${Vxlan} ...${props} />`}
        ${tab === "ACL" && html`<${Acl} ...${props} />`}
        ${tab === "Routing" && html`<${Routing} ...${props} />`}
        ${tab === "Raw" && html`<${Raw} ...${props} setCdb=${setCdb} />`}
      </div>
      <div class="dlg-foot">
        ${warn.map((w) => html`<div class="warn" key=${w}>⚠ ${w}</div>`)}
        ${err && html`<div class="warn">${err}</div>`}
        ${result && html`<div class="ok">${result.applied ? "Saved and applied to the running node." : "Saved. It takes effect on the next deploy."}
          ${result.warnings.map((w) => html`<div class="warn" key=${w}>Node said: ${w}</div>`)}</div>`}
        <details open=${changes.length > 0 && changes.length < 12}>
          <summary>${changes.length ? `${changes.length} unsaved change${changes.length > 1 ? "s" : ""}` : "No unsaved changes"}</summary>
          <pre class="diff">${changes.join("\n")}</pre>
        </details>
        <div class="row">
          <button disabled=${busy || !changes.length} onClick=${() => save(false)}>Save</button>
          <button class="primary" disabled=${busy || !changes.length || !running}
            title=${running ? "Save, then make the running switch match (including deletions)" : "Deploy the lab first"}
            onClick=${() => save(true)}>Save & apply</button>
        </div>
      </div>
    </div>
  </div>`;
}

const Hint = ({ children }) => html`<p class="hint">${children}</p>`;

function System({ cdb, edit }) {
  const md = cdb.DEVICE_METADATA?.localhost || {};
  return html`<label>Hostname</label>
    <input value=${md.hostname || ""} onChange=${(e) => edit((c) => { ((c.DEVICE_METADATA ||= {}).localhost ||= {}).hostname = e.target.value; })} />
    <${Hint}>DEVICE_METADATA|localhost. The rest of this table (hwsku, MAC, …) comes from the sonic-vs image and is kept as is.<//>
    <${Hint}>BGP's AS number lives in FRR here, so set it on the Routing tab.<//>`;
}

function Ports({ cdb, edit, peers }) {
  const [all, setAll] = useState(false);
  const shown = PORTS.sonic.filter((p) => all || peers[p] || cdb.PORT?.[p]);
  const set = (p, f, v) => edit((c) => { const r = ((c.PORT ||= {})[p] ||= {}); if (v === "") delete r[f]; else r[f] = v; });
  return html`<table>
      <thead><tr><th>Port</th><th>Cabled to</th><th>Admin</th><th>MTU</th><th>Description</th></tr></thead>
      <tbody>${shown.map((p) => { const r = cdb.PORT?.[p] || {}; return html`<tr key=${p}>
        <td>${p}</td><td class="muted">${peers[p] || "—"}</td>
        <td><select value=${r.admin_status || "down"} onChange=${(e) => set(p, "admin_status", e.target.value)}>
          <option>up</option><option>down</option></select></td>
        <td><input class="num" value=${r.mtu || ""} placeholder="9100" onChange=${(e) => set(p, "mtu", e.target.value)} /></td>
        <td><input value=${r.description || ""} onChange=${(e) => set(p, "description", e.target.value)} /></td>
      </tr>`; })}</tbody></table>
    <label class="check"><input type="checkbox" checked=${all} onChange=${(e) => setAll(e.target.checked)} /> Show all 32 ports</label>
    <${Hint}>PORT table. A port passes traffic only when admin is up. Lanes and speed come from the hwsku.<//>`;
}

function interfaces(cdb) {
  return [...PORTS.sonic, ...Object.keys(cdb.PORTCHANNEL || {}), ...Object.keys(cdb.VLAN || {}),
    ...new Set(["Loopback0", ...Object.keys(cdb.LOOPBACK_INTERFACE || {}).filter((k) => !k.includes("|"))])];
}

function Ips({ cdb, edit, peers }) {
  const [ifname, setIf] = useState("Loopback0");
  const [ip, setIp_] = useState("");
  const valid = /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(ip);
  return html`<table>
      <thead><tr><th>Interface</th><th>Address</th><th>Cabled to</th><th></th></tr></thead>
      <tbody>${ipEntries(cdb).map(({ ifname: i, ip: a }) => html`<tr key=${i + a}>
        <td>${i}</td><td>${a}</td><td class="muted">${peers[i] || ""}</td>
        <td><button class="danger" onClick=${() => edit((c) => setIp(c, i, a, false))}>Remove</button></td></tr>`)}</tbody>
    </table>
    <div class="row">
      <select value=${ifname} onChange=${(e) => setIf(e.target.value)}>${interfaces(cdb).map((i) => html`<option key=${i}>${i}</option>`)}</select>
      <input value=${ip} placeholder="10.0.0.1/24" onChange=${(e) => setIp_(e.target.value)} />
      <button disabled=${!valid} onClick=${() => { edit((c) => setIp(c, ifname, ip, true)); setIp_(""); }}>Add IP</button>
    </div>
    <${Hint}>An IP makes an interface routed (L3). Ethernet and PortChannel IPs go in INTERFACE / PORTCHANNEL_INTERFACE,
      a VLAN's IP (SVI) in VLAN_INTERFACE, and loopbacks in LOOPBACK_INTERFACE. Remember to set the port admin up on the Ports tab.<//>`;
}

/** VLANs and PortChannels share a shape: a group with member ports. */
function Groups({ cdb, edit, peers, table }) {
  const isVlan = table === "VLAN", member = table + "_MEMBER";
  const [id, setId] = useState("");
  const [add, setAdd] = useState({});
  const lagOf = membership(cdb, "PORTCHANNEL_MEMBER");
  const routed = new Set(ipEntries(cdb).map((e) => e.ifname)); // an L3 port can't also be L2
  const candidates = [...PORTS.sonic.filter((p) => !routed.has(p) && (isVlan || !lagOf[p])),
    ...(isVlan ? Object.keys(cdb.PORTCHANNEL || {}).filter((p) => !routed.has(p)) : [])];
  const name = (isVlan ? "Vlan" : "PortChannel") + id;
  const newGroup = () => edit((c) => {
    (c[table] ||= {})[name] = isVlan ? { vlanid: id } : { admin_status: "up", mtu: "9100", min_links: "1", lacp_key: "auto" };
  });
  return html`${Object.keys(cdb[table] || {}).map((g) => {
      const members = Object.entries(cdb[member] || {}).filter(([k]) => k.startsWith(g + "|"));
      const pick = add[g] || candidates[0];
      return html`<fieldset key=${g}><legend>${g}</legend>
        <table><tbody>${members.map(([k, r]) => { const p = k.split("|")[1]; return html`<tr key=${k}>
          <td>${p}</td><td class="muted">${peers[p] || ""}</td>
          ${isVlan && html`<td><select value=${r.tagging_mode || "untagged"}
            onChange=${(e) => edit((c) => { c[member][k].tagging_mode = e.target.value; })}>
            <option>untagged</option><option>tagged</option></select></td>`}
          <td><button class="danger" onClick=${() => edit((c) => { delete c[member][k]; if (!Object.keys(c[member]).length) delete c[member]; })}>Remove</button></td>
        </tr>`; })}</tbody></table>
        <div class="row">
          <select value=${pick} onChange=${(e) => setAdd({ ...add, [g]: e.target.value })}>
            ${candidates.filter((p) => !cdb[member]?.[`${g}|${p}`]).map((p) => html`<option key=${p}>${p}</option>`)}</select>
          <button onClick=${() => edit((c) => { (c[member] ||= {})[`${g}|${pick}`] = isVlan ? { tagging_mode: "untagged" } : {}; })}>Add member</button>
          <button class="danger" onClick=${() => edit((c) => deleteGroup(c, table, g))}>Delete ${g}</button>
        </div>
      </fieldset>`;
    })}
    <div class="row">
      <input class="num" value=${id} placeholder=${isVlan ? "100" : "1"} onChange=${(e) => setId(e.target.value.replace(/\D/g, ""))} />
      <button disabled=${!id || cdb[table]?.[name]} onClick=${() => { newGroup(); setId(""); }}>Add ${isVlan ? "VLAN" : "PortChannel"}</button>
    </div>
    <${Hint}>${isVlan
      ? "VLAN + VLAN_MEMBER. Untagged = access port, tagged = trunk. Give the VLAN an IP on the IP tab to route it (SVI)."
      : "PORTCHANNEL + PORTCHANNEL_MEMBER (LACP via teamd). Both ends need a PortChannel with matching member links. Put IPs on the PortChannel, not its members."}<//>`;
}

function Vxlan({ cdb, edit }) {
  const [vlan, setVlan] = useState("");
  const [vni, setVni] = useState("");
  const src = cdb.VXLAN_TUNNEL?.vtep?.src_ip || "";
  const maps = Object.entries(cdb.VXLAN_TUNNEL_MAP || {});
  const vlans = Object.keys(cdb.VLAN || {});
  const pick = vlan || vlans[0];
  return html`<label>VTEP source IP (usually Loopback0's address)</label>
    <input value=${src} placeholder="10.255.1.1" onChange=${(e) => edit((c) => {
      if (e.target.value) (c.VXLAN_TUNNEL ||= {}).vtep = { ...c.VXLAN_TUNNEL?.vtep, src_ip: e.target.value };
      else { delete c.VXLAN_TUNNEL; delete c.VXLAN_EVPN_NVO; delete c.VXLAN_TUNNEL_MAP; }
    })} />
    <label class="check"><input type="checkbox" disabled=${!src} checked=${!!cdb.VXLAN_EVPN_NVO?.nvo}
      onChange=${(e) => edit((c) => { if (e.target.checked) c.VXLAN_EVPN_NVO = { nvo: { source_vtep: "vtep" } }; else delete c.VXLAN_EVPN_NVO; })} />
      Use BGP EVPN to find remote VTEPs and MACs (VXLAN_EVPN_NVO). Also turn on EVPN on the Routing tab.</label>
    <h3>VLAN ↔ VNI</h3>
    <table><tbody>${maps.map(([k, r]) => html`<tr key=${k}><td>${r.vlan}</td><td>VNI ${r.vni}</td>
      <td><button class="danger" onClick=${() => edit((c) => { delete c.VXLAN_TUNNEL_MAP[k]; if (!Object.keys(c.VXLAN_TUNNEL_MAP).length) delete c.VXLAN_TUNNEL_MAP; })}>Remove</button></td></tr>`)}</tbody></table>
    <div class="row">
      <select value=${pick} onChange=${(e) => setVlan(e.target.value)}>${vlans.map((v) => html`<option key=${v}>${v}</option>`)}</select>
      <input class="num" value=${vni} placeholder="1010" onChange=${(e) => setVni(e.target.value.replace(/\D/g, ""))} />
      <button disabled=${!src || !pick || !vni} onClick=${() => { edit((c) => { (c.VXLAN_TUNNEL_MAP ||= {})[`vtep|map_${vni}_${pick}`] = { vlan: pick, vni }; }); setVni(""); }}>Map</button>
    </div>
    <${Hint}>VXLAN_TUNNEL, VXLAN_EVPN_NVO and VXLAN_TUNNEL_MAP. Mapping a VLAN to a VNI stretches it to every VTEP that maps the
      same VNI: hosts on different leaves end up in one subnet. The VTEP IP must be reachable in the underlay (advertise the loopback in BGP).
      Use the same VNI on every leaf. sonic-vs bridges this in the Linux kernel, so it really passes traffic.<//>`;
}

function Acl({ cdb, edit, peers }) {
  const [name, setName] = useState("");
  const tables = Object.entries(cdb.ACL_TABLE || {});
  const rules = (t) => Object.entries(cdb.ACL_RULE || {}).filter(([k]) => k.startsWith(t + "|"));
  const setRule = (k, f, v) => edit((c) => { const r = c.ACL_RULE[k]; if (v === "") delete r[f]; else r[f] = v; });
  return html`<p class="warn">sonic-vs accepts ACLs and programs them into its ASIC database, but does not enforce them on traffic
      (a DROP rule still lets packets through). Use this to learn the config model, and test the effect on real hardware.</p>
    ${tables.map(([t, tr]) => html`<fieldset key=${t}><legend>${t}</legend>
      <div class="grid2">
        <label>Type<select value=${tr.type} onChange=${(e) => edit((c) => { c.ACL_TABLE[t].type = e.target.value; })}>
          ${["L3", "L3V6", "MIRROR"].map((x) => html`<option key=${x}>${x}</option>`)}</select></label>
        <label>Stage<select value=${tr.stage || "ingress"} onChange=${(e) => edit((c) => { c.ACL_TABLE[t].stage = e.target.value; })}>
          <option>ingress</option><option>egress</option></select></label>
      </div>
      <label>Bound to ports</label>
      <div>${PORTS.sonic.filter((p) => peers[p] || (tr.ports || []).includes(p)).map((p) => html`<label class="check inline" key=${p}>
        <input type="checkbox" checked=${(tr.ports || []).includes(p)} onChange=${(e) => edit((c) => {
          const ps = new Set(c.ACL_TABLE[t].ports || []); e.target.checked ? ps.add(p) : ps.delete(p); c.ACL_TABLE[t].ports = [...ps];
        })} /> ${p}</label>`)}</div>
      <table><thead><tr><th>Rule</th><th>Priority</th><th>Action</th><th>Src IP</th><th>Dst IP</th><th>Proto</th><th>Dst port</th><th></th></tr></thead>
        <tbody>${rules(t).map(([k, r]) => html`<tr key=${k}><td>${k.split("|")[1]}</td>
          <td><input class="num" value=${r.PRIORITY || ""} onChange=${(e) => setRule(k, "PRIORITY", e.target.value)} /></td>
          <td><select value=${r.PACKET_ACTION || "FORWARD"} onChange=${(e) => setRule(k, "PACKET_ACTION", e.target.value)}><option>FORWARD</option><option>DROP</option></select></td>
          <td><input value=${r.SRC_IP || ""} placeholder="any" onChange=${(e) => setRule(k, "SRC_IP", e.target.value)} /></td>
          <td><input value=${r.DST_IP || ""} placeholder="any" onChange=${(e) => setRule(k, "DST_IP", e.target.value)} /></td>
          <td><input class="num" value=${r.IP_PROTOCOL || ""} placeholder="6=tcp" onChange=${(e) => setRule(k, "IP_PROTOCOL", e.target.value)} /></td>
          <td><input class="num" value=${r.L4_DST_PORT || ""} onChange=${(e) => setRule(k, "L4_DST_PORT", e.target.value)} /></td>
          <td><button class="danger" onClick=${() => edit((c) => { delete c.ACL_RULE[k]; })}>×</button></td></tr>`)}</tbody></table>
      <div class="row">
        <button onClick=${() => edit((c) => { let i = 1; while (c.ACL_RULE?.[`${t}|RULE_${i}`]) i++;
          (c.ACL_RULE ||= {})[`${t}|RULE_${i}`] = { PRIORITY: String(1000 - i * 10), PACKET_ACTION: "DROP" }; })}>Add rule</button>
        <button class="danger" onClick=${() => edit((c) => { delete c.ACL_TABLE[t]; for (const [k] of rules(t)) delete c.ACL_RULE[k];
          for (const x of ["ACL_TABLE", "ACL_RULE"]) if (c[x] && !Object.keys(c[x]).length) delete c[x]; })}>Delete ${t}</button>
      </div>
    </fieldset>`)}
    <div class="row">
      <input value=${name} placeholder="DATAACL" onChange=${(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))} />
      <button disabled=${!name || cdb.ACL_TABLE?.[name]} onClick=${() => { edit((c) => { (c.ACL_TABLE ||= {})[name] = { type: "L3", stage: "ingress", ports: [] }; }); setName(""); }}>Add ACL table</button>
    </div>
    <${Hint}>ACL_TABLE binds a table to ports; ACL_RULE entries match fields and FORWARD or DROP. The highest PRIORITY wins.<//>`;
}

function Routing({ frr, setFrr }) {
  // Rows live here so a blank row you just added survives (writeFrr skips blanks); re-read only
  // when frr.conf changed elsewhere (Raw tab).
  const [m, setM] = useState(() => parseFrr(frr));
  const wrote = useRef(frr);
  useEffect(() => { if (frr !== wrote.current) { wrote.current = frr; setM(parseFrr(frr)); } }, [frr]);
  const set = (fn) => { const n = structuredClone(m); fn(n); setM(n); wrote.current = writeFrr(frr, n); setFrr(wrote.current); };
  const list = (key, blank) => ({ add: () => set((n) => n.bgp[key].push(blank)), del: (i) => set((n) => n.bgp[key].splice(i, 1)) });
  if (m.unsupported.length) return html`<p class="warn">This router bgp block has settings the form doesn't handle:</p>
    <pre class="diff">${m.unsupported.join("\n")}</pre><${Hint}>Edit frr.conf on the Raw tab instead, so they aren't lost.<//>`;
  return html`<fieldset><legend>Static routes</legend>
      <table><tbody>${m.static.map((r, i) => html`<tr key=${i}>
        <td><input value=${r.prefix} placeholder="10.9.0.0/16" onChange=${(e) => set((n) => { n.static[i].prefix = e.target.value; })} /></td>
        <td>via <input value=${r.nexthop} placeholder="10.0.12.1" onChange=${(e) => set((n) => { n.static[i].nexthop = e.target.value; })} /></td>
        <td><button class="danger" onClick=${() => set((n) => n.static.splice(i, 1))}>Remove</button></td></tr>`)}</tbody></table>
      <button onClick=${() => set((n) => n.static.push({ prefix: "", nexthop: "" }))}>Add static route</button>
      <${Hint}>Written as "ip route" in frr.conf: sonic-vs has no bgpcfgd, so the STATIC_ROUTE table isn't used.<//>
    </fieldset>
    <fieldset><legend><label class="check"><input type="checkbox" checked=${!!m.bgp}
        onChange=${(e) => set((n) => { n.bgp = e.target.checked ? { asn: "65000", routerId: "", noPolicy: true, neighbors: [], networks: [], redistribute: [] } : null; })} /> BGP</label></legend>
      ${m.bgp && html`
        <div class="grid2">
          <label>Local AS<input value=${m.bgp.asn} onChange=${(e) => set((n) => { n.bgp.asn = e.target.value.replace(/\D/g, ""); })} /></label>
          <label>Router ID<input value=${m.bgp.routerId} placeholder="10.255.0.1" onChange=${(e) => set((n) => { n.bgp.routerId = e.target.value; })} /></label>
        </div>
        <label class="check"><input type="checkbox" checked=${m.bgp.noPolicy} onChange=${(e) => set((n) => { n.bgp.noPolicy = e.target.checked; })} />
          Don't require route-maps on eBGP sessions (no bgp ebgp-requires-policy). Without this, FRR exchanges no routes with eBGP peers until you add policies.</label>
        <h3>Neighbors</h3>
        <table><tbody>${m.bgp.neighbors.map((nb, i) => html`<tr key=${i}>
          <td><input value=${nb.ip} placeholder="10.0.12.1" onChange=${(e) => set((n) => { n.bgp.neighbors[i].ip = e.target.value; })} /></td>
          <td>AS <input class="num" value=${nb.asn} placeholder="65002" onChange=${(e) => set((n) => { n.bgp.neighbors[i].asn = e.target.value.replace(/\D/g, ""); })} /></td>
          <td><button class="danger" onClick=${() => list("neighbors").del(i)}>Remove</button></td></tr>`)}</tbody></table>
        <button onClick=${list("neighbors", { ip: "", asn: "" }).add}>Add neighbor</button>
        <h3>Advertise networks</h3>
        <table><tbody>${m.bgp.networks.map((p, i) => html`<tr key=${i}>
          <td><input value=${p} placeholder="10.0.1.0/24" onChange=${(e) => set((n) => { n.bgp.networks[i] = e.target.value; })} /></td>
          <td><button class="danger" onClick=${() => list("networks").del(i)}>Remove</button></td></tr>`)}</tbody></table>
        <button onClick=${list("networks", "").add}>Add network</button>
        <h3>EVPN</h3>
        <label class="check"><input type="checkbox" checked=${!!m.bgp.evpn}
          onChange=${(e) => set((n) => { n.bgp.evpn = e.target.checked ? { allVni: true } : null; })} />
          Exchange EVPN routes (address-family l2vpn evpn) with every neighbor. Spines need this too, to pass EVPN routes between leaves.</label>
        ${m.bgp.evpn && html`<label class="check"><input type="checkbox" checked=${m.bgp.evpn.allVni}
          onChange=${(e) => set((n) => { n.bgp.evpn.allVni = e.target.checked; })} />
          Advertise all local VNIs (advertise-all-vni). Turn this on for leaves (VTEPs), off for spines.</label>`}
        <h3>Redistribute</h3>
        ${["connected", "static"].map((r) => html`<label class="check" key=${r}><input type="checkbox" checked=${m.bgp.redistribute.includes(r)}
          onChange=${(e) => set((n) => { n.bgp.redistribute = e.target.checked ? [...n.bgp.redistribute, r] : n.bgp.redistribute.filter((x) => x !== r); })} /> ${r}</label>`)}
        <${Hint}>A "network" is only advertised if it's in the routing table exactly (for example a connected subnet).<//>`}
    </fieldset>`;
}

function Raw({ cdb, setCdb, frr, setFrr }) {
  const [text, setText] = useState(JSON.stringify(cdb, null, 4));
  const [bad, setBad] = useState("");
  const typed = useRef(null); // the object we parsed from the textarea: don't reformat under the cursor
  useEffect(() => { if (cdb !== typed.current) setText(JSON.stringify(cdb, null, 4)); }, [cdb]);
  return html`<div class="grid2 raw">
    <label>config_db.json
      <textarea spellcheck="false" value=${text} onChange=${(e) => {
        setText(e.target.value);
        try { const d = JSON.parse(e.target.value); if (typeof d !== "object" || Array.isArray(d)) throw new Error("must be an object"); setBad(""); typed.current = d; setCdb(d); }
        catch (x) { setBad(x.message); }
      }} />
      ${bad && html`<span class="warn">${bad}</span>`}</label>
    <label>frr.conf
      <textarea spellcheck="false" value=${frr} onChange=${(e) => setFrr(e.target.value)} /></label>
  </div>
  <${Hint}>The same files you'd import or export. Edits here and in the forms stay in sync. QoS tables (DSCP_TO_TC_MAP, SCHEDULER,
    PORT_QOS_MAP, …) are edited here: sonic-vs loads defaults for them but, like ACLs, doesn't enforce them on traffic.<//>`;
}
