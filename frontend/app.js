import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ReactFlow, ReactFlowProvider, useReactFlow, Background, Controls, Handle, Position, ConnectionMode, applyNodeChanges, BaseEdge, EdgeLabelRenderer, getBezierPath } from "@xyflow/react";
import htm from "htm";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { PORTS, api, ipEntries, membership } from "./config.js";
import { ConfigEditor } from "./editor.js";

const html = htm.bind(React.createElement);

const usedPorts = (lab, node) =>
  new Set(lab.links.flat().filter((e) => e.startsWith(node + ":")).map((e) => e.split(":")[1]));
const freePorts = (lab, node) => PORTS[lab.nodes[node].kind].filter((p) => !usedPorts(lab, node).has(p));

function LabNode({ data }) {
  return html`<div class=${"node " + data.kind}>
    <${Handle} type="source" id="l" position=${Position.Left} />
    <${Handle} type="source" id="r" position=${Position.Right} />
    <${Handle} type="source" id="t" position=${Position.Top} />
    <${Handle} type="source" id="b" position=${Position.Bottom} />
    <div class="name">${data.label}</div>
    <div class="meta">${data.kind === "sonic" ? "SONiC" : data.ip || "host"}
      <span class=${"dot " + (data.state || "")} title=${data.state || "not deployed"}></span></div>
    ${data.bgp && html`<div class=${"bgp " + (data.bgp.up < data.bgp.total ? "bad" : "good")}
      title=${data.bgp.detail}>BGP ${data.bgp.up}/${data.bgp.total}</div>`}
  </div>`;
}
const nodeTypes = { lab: LabNode };

// A cable labelled at each end, next to the device that port belongs to.
function CableEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }) {
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const at = (f) => `translate(-50%, -50%) translate(${sourceX + (targetX - sourceX) * f}px, ${sourceY + (targetY - sourceY) * f}px)`;
  return html`<${React.Fragment}>
    <${BaseEdge} id=${id} path=${path} style=${{ ...(data.oper && { stroke: data.oper === "up" ? "var(--up)" : "var(--err)",
      strokeWidth: 2, strokeDasharray: data.oper === "up" ? undefined : "6 4" }), ...(selected && { stroke: "var(--accent)", strokeWidth: 3 }) }} />
    <${EdgeLabelRenderer}>
      <div class="end" style=${{ transform: at(0.22) }}>${data.a}</div>
      <div class="end" style=${{ transform: at(0.78) }}>${data.b}</div>
    </${EdgeLabelRenderer}>
  </${React.Fragment}>`;
}
const edgeTypes = { cable: CableEdge };

const toFlowNodes = (lab, status, prev = []) => {
  const seen = { sonic: 0, host: 0 }; // default layout: switches on top, hosts below
  return Object.entries(lab.nodes).map(([name, spec]) => {
    const old = prev.find((n) => n.id === name); // keep unsaved drag positions
    const i = seen[spec.kind]++;
    return { id: name, type: "lab", selected: old?.selected,
    position: old?.position || (spec.pos ? { x: spec.pos[0], y: spec.pos[1] } : { x: 80 + i * 260, y: spec.kind === "sonic" ? 80 : 280 }),
    data: { label: name, kind: spec.kind, ip: spec.ip, state: status[name] } };
  });
};

function App() {
  const [labs, setLabs] = useState([]);
  const [lab, setLab] = useState(null); // lab.yaml content: {name, nodes, links}
  const [status, setStatus] = useState({}); // node -> container state
  const [flowNodes, setFlowNodes] = useState([]);
  const [sel, setSel] = useState(null); // {node} | {link: index}
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState({ text: "" });
  const [term, setTerm] = useState(null);
  const [configs, setConfigs] = useState({}); // sonic node -> config_db, for link labels
  const [editing, setEditing] = useState(null);
  const [live, setLive] = useState({}); // sonic node -> {ports, bgp} while deployed
  const [checksOpen, setChecksOpen] = useState(false);
  const flow = useReactFlow();
  const mainRef = useRef();

  const say = (text, err = false) => setMsg({ text, err });
  const run = async (label, fn) => {
    setBusy(label); say(label + "…");
    try { await fn(); say(label + " done"); } catch (e) { say(e.message, true); } finally { setBusy(""); }
  };

  useEffect(() => { api("/labs").then((l) => { setLabs(l); if (l[0]) open(l[0]); }).catch((e) => say(e.message, true)); }, []);

  async function open(name) {
    const data = await api(`/labs/${name}`);
    const { status: st, ...l } = data;
    l.links ||= [];
    const s = Object.fromEntries(st.map((c) => [c.node, c.state]));
    setLab(l); setStatus(s); setFlowNodes(toFlowNodes(l, s)); setSel(null); setDirty(false); setTerm(null); setConfigs({}); setLive({});
    for (const [n, spec] of Object.entries(l.nodes)) if (spec.kind === "sonic")
      api(`/labs/${name}/nodes/${n}/config_db.json`).then((c) => setConfigs((cs) => ({ ...cs, [n]: c }))).catch(() => {});
  }

  // Poll container state so badges follow deploy/destroy and crashes.
  useEffect(() => {
    if (!lab) return;
    const t = setInterval(() => api(`/labs/${lab.name}`)
      .then((d) => setStatus(Object.fromEntries(d.status.map((c) => [c.node, c.state])))).catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [lab?.name]);
  const anyRunning = Object.values(status).some((s) => s === "running");
  useEffect(() => {
    if (!lab || !anyRunning) { setLive({}); return; }
    const poll = () => api(`/labs/${lab.name}/live`).then(setLive).catch(() => {});
    poll(); const t = setInterval(poll, 5000);
    return () => clearInterval(t);
  }, [lab?.name, anyRunning]);
  useEffect(() => { setFlowNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, state: status[n.id], bgp: bgpBadge(live[n.id]) } }))); }, [status, live]);

  const edit = (fn) => {
    setLab((l) => { const next = structuredClone(l); fn(next); setFlowNodes((ns) => toFlowNodes(next, status, ns)); return next; });
    setDirty(true);
  };
  const withPositions = () => {
    const l = structuredClone(lab);
    for (const n of flowNodes) l.nodes[n.id].pos = [Math.round(n.position.x), Math.round(n.position.y)];
    return l;
  };
  const save = async () => { const l = withPositions(); await api(`/labs/${l.name}`, { method: "PUT", body: l }); setLab(l); setDirty(false); };

  function addNode(kind) {
    const prefix = kind === "sonic" ? "sw" : "h";
    let i = 1; while (lab.nodes[prefix + i]) i++;
    const r = mainRef.current.getBoundingClientRect(); // drop it in the middle of what you're looking at
    const p = flow.screenToFlowPosition({ x: r.left + r.width / 2 - 50, y: r.top + r.height / 2 - 25 });
    const pos = [Math.round(p.x), Math.round(p.y)];
    edit((l) => { l.nodes[prefix + i] = kind === "sonic" ? { kind, pos } : { kind, ip: "", gw: "", pos }; });
    setSel({ node: prefix + i });
  }

  function onConnect({ source, target }) {
    if (source === target) return;
    const a = freePorts(lab, source)[0], b = freePorts(lab, target)[0];
    if (!a || !b) return say(`no free port on ${a ? target : source}`, true);
    edit((l) => l.links.push([`${source}:${a}`, `${target}:${b}`]));
    say(`linked ${source}:${a} ↔ ${target}:${b}. Select the link to change ports.`);
  }

  async function newLab() {
    const name = prompt("Lab name (lowercase letters, digits, -)");
    if (!name) return;
    await run("Create", async () => {
      await api(`/labs/${name}`, { method: "PUT", body: { nodes: {}, links: [] } });
      setLabs(await api("/labs")); await open(name);
    });
  }

  const pos = Object.fromEntries(flowNodes.map((n) => [n.id, n.position]));
  const sides = (a, b) => { // attach each link to the sides that face each other
    const dx = (pos[b]?.x ?? 0) - (pos[a]?.x ?? 0), dy = (pos[b]?.y ?? 0) - (pos[a]?.y ?? 0);
    return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? ["r", "l"] : ["l", "r"]) : (dy >= 0 ? ["b", "t"] : ["t", "b"]);
  };
  const edges = lab ? lab.links.map(([a, b], i) => ({
    id: String(i), source: a.split(":")[0], target: b.split(":")[0], selected: sel?.link === i,
    ...(([s, t]) => ({ sourceHandle: s, targetHandle: t }))(sides(a.split(":")[0], b.split(":")[0])),
    type: "cable", data: { a: portLabel(a), b: portLabel(b), oper: cableOper(a, b) },
  })) : [];
  // A cable is up when every SONiC end reports oper up (hosts don't report).
  function cableOper(...eps) {
    const states = eps.map((ep) => { const [n, p] = ep.split(":"); return live[n]?.ports?.[p]; }).filter(Boolean);
    return !states.length ? null : states.every((x) => x === "up") ? "up" : "down";
  }
  // What each cabled port is: its IP, or the VLAN/PortChannel it belongs to.
  function portLabel(ep) {
    const [n, p] = ep.split(":"), c = configs[n];
    if (lab.nodes[n]?.kind === "host") return lab.nodes[n].ip ? html`${p}<br />${lab.nodes[n].ip}` : p;
    if (!c) return p;
    const lag = membership(c, "PORTCHANNEL_MEMBER")[p]?.[0];
    const vlans = membership(c, "VLAN_MEMBER")[lag || p];
    const ip = ipEntries(c).find((e) => e.ifname === (lag || p))?.ip;
    return html`${p}${[lag, vlans?.join(","), ip].filter(Boolean).map((x) => html`<br />${x}`)}`;
  }
  const deployed = Object.values(status).some((s) => s === "running");

  return html`
    <header>
      <h1>SONiC Lab</h1>
      <select value=${lab?.name || ""} onChange=${(e) => (!dirty || confirm("Discard unsaved changes?")) && open(e.target.value)}>
        ${labs.map((n) => html`<option key=${n}>${n}</option>`)}
      </select>
      <button onClick=${newLab}>New lab</button>
      <button disabled=${!lab || !!busy} onClick=${() => addNode("sonic")}>+ SONiC switch</button>
      <button disabled=${!lab || !!busy} onClick=${() => addNode("host")}>+ Host</button>
      <button disabled=${!dirty || !!busy} onClick=${() => run("Save", save)}>Save</button>
      <button class="primary" disabled=${!lab || !!busy} title="Saves, then (re)deploys every node from its saved config"
        onClick=${() => run("Deploy", async () => { await save(); const st = await api(`/labs/${lab.name}/deploy`, { method: "POST" });
          setStatus(Object.fromEntries(st.map((c) => [c.node, c.state]))); })}>${deployed ? "Redeploy" : "Deploy"}</button>
      <button class="danger" disabled=${!deployed || !!busy}
        onClick=${() => confirm("Destroy all lab containers?") && run("Destroy", async () => {
          await api(`/labs/${lab.name}/destroy`, { method: "POST" }); setStatus({}); setTerm(null); })}>Destroy</button>
      <button disabled=${!lab} onClick=${() => setChecksOpen(true)}>Checks</button>
      <span class=${"msg" + (msg.err ? " err" : "")}>${dirty ? "unsaved changes · " : ""}${msg.text}</span>
    </header>
    <main ref=${mainRef}>
      ${lab && html`<${ReactFlow} nodes=${flowNodes} edges=${edges} nodeTypes=${nodeTypes} edgeTypes=${edgeTypes}
        connectionMode=${ConnectionMode.Loose} fitView
        onNodesChange=${(ch) => { setFlowNodes((ns) => applyNodeChanges(ch, ns)); if (ch.some((c) => c.type === "position" && c.dragging === false)) setDirty(true); }}
        onConnect=${onConnect}
        onNodeClick=${(_, n) => setSel({ node: n.id })}
        onEdgeClick=${(_, e) => setSel({ link: Number(e.id) })}
        onPaneClick=${() => setSel(null)}
        deleteKeyCode=${null}>
        <${Background} /><${Controls} />
      </${ReactFlow}>`}
    </main>
    <aside>${lab && html`<${Side} lab=${lab} sel=${sel} status=${status} edit=${edit} setSel=${setSel}
      openTerm=${(node) => setTerm(node)} configure=${setEditing} live=${live} />`}</aside>
    ${checksOpen && html`<${Checks} lab=${lab.name} running=${anyRunning} onClose=${() => setChecksOpen(false)} />`}
    ${editing && html`<${ConfigEditor} key=${editing} lab=${lab} node=${editing} running=${status[editing] === "running"}
      onClose=${() => setEditing(null)} onSaved=${(n, c) => setConfigs((cs) => ({ ...cs, [n]: c }))} />`}
    ${term && html`<${Term} key=${lab.name + term} lab=${lab.name} node=${term} kind=${lab.nodes[term]?.kind} close=${() => setTerm(null)} />`}
  `;
}

function Side({ lab, sel, status, edit, setSel, openTerm, configure, live }) {
  if (sel?.node && lab.nodes[sel.node]) {
    const n = sel.node, spec = lab.nodes[n];
    const set = (k) => (e) => edit((l) => { l.nodes[n][k] = e.target.value; });
    return html`<h2>${n} <small>(${spec.kind === "sonic" ? "SONiC switch" : "host"})</small></h2>
      ${spec.kind === "host" && html`
        <label>IP on eth1 (CIDR)</label><input value=${spec.ip || ""} placeholder="e.g. 192.168.10.10/24" onChange=${set("ip")} />
        <label>Default gateway</label><input value=${spec.gw || ""} placeholder="e.g. 192.168.10.1" onChange=${set("gw")} />`}
      <label>Ports in use</label>
      <div>${[...usedPorts(lab, n)].map((p) => html`<span key=${p} class=${"port " + (live[n]?.ports?.[p] || "")}>${p}</span>`)}
        ${!usedPorts(lab, n).size && "none"}</div>
      ${live[n]?.bgp && Object.keys(live[n].bgp).length > 0 && html`<label>BGP peers</label>
        <table><tbody>${Object.entries(live[n].bgp).map(([ip, p]) => html`<tr key=${ip}>
          <td>${ip}</td><td class="muted">AS ${p.remoteAs}</td>
          <td class=${p.state === "Established" ? "ok" : "warn"}>${p.state}${p.state === "Established" ? ` · ${p.pfxRcd} pfx` : ""}</td></tr>`)}</tbody></table>`}
      <div class="row">
        ${spec.kind === "sonic" && html`<button class="primary" onClick=${() => configure(n)}>Configure</button>`}
        <button disabled=${status[n] !== "running"} onClick=${() => openTerm(n)}>Open terminal</button>
        <button class="danger" onClick=${() => { edit((l) => { delete l.nodes[n]; l.links = l.links.filter((lk) => !lk.some((e) => e.startsWith(n + ":"))); }); setSel(null); }}>Delete node</button>
      </div>
      ${spec.kind === "sonic" && html`<p class="hint">Saved as labs/${lab.name}/nodes/${n}/config_db.json and frr.conf.</p>`}
      ${status[n] !== "running" && html`<p class="hint">Deploy the lab to open a terminal.</p>`}`;
  }
  if (sel && sel.link !== undefined && lab.links[sel.link]) {
    const i = sel.link, link = lab.links[i];
    const end = (j) => {
      const [node, port] = link[j].split(":");
      return html`<label>${node}</label>
        <select value=${port} onChange=${(e) => edit((l) => { l.links[i][j] = `${node}:${e.target.value}`; })}>
          ${[port, ...freePorts(lab, node)].map((p) => html`<option key=${p}>${p}</option>`)}
        </select>`;
    };
    return html`<h2>Link</h2>${end(0)}${end(1)}
      <div class="row"><button class="danger" onClick=${() => { edit((l) => l.links.splice(i, 1)); setSel(null); }}>Delete link</button></div>
      <p class="hint">Port changes take effect on the next deploy.</p>
      ${link.every((ep) => status[ep.split(":")[0]] === "running") && html`<${Impair} key=${i} lab=${lab.name} i=${i} />`}
      <label>Packet capture (10 s, opens in Wireshark)</label>
      <div class="row">${link.map((ep) => { const [node, port] = ep.split(":"); return status[node] === "running"
        ? html`<a key=${ep} class="btn" href=${`/labs/${lab.name}/capture?node=${node}&port=${port}&seconds=10`} download>${node}:${port}</a>`
        : html`<span key=${ep} class="muted">${node} not running</span>`; })}</div>
      <p class="hint">Captures on that end of the cable for 10 seconds, then downloads a .pcap.</p>`;
  }
  return html`<h2>${lab.name}</h2>
    <p class="hint">Add switches and hosts from the toolbar. Drag from a node's side dot to another node to link them;
      the next free port on each side is picked for you. Click a node or link to edit it.</p>
    <p class="hint">${Object.keys(lab.nodes).length} nodes · ${lab.links.length} links</p>`;
}

/** Break or degrade a running cable. Runtime only: a redeploy restores it. */
function Impair({ lab, i }) {
  const [st, setSt] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => { api(`/labs/${lab}/links/${i}/impair`).then(setSt).catch((e) => setErr(e.message)); }, []);
  const apply = (next) => api(`/labs/${lab}/links/${i}/impair`, { method: "POST", body: next }).then(setSt).catch((e) => setErr(e.message));
  if (!st) return err && html`<p class="warn">${err}</p>`;
  return html`<label>Fault injection</label>
    <div class="row" style=${{ marginTop: 0 }}>
      <button class=${st.down ? "primary" : "danger"} onClick=${() => apply({ ...st, down: !st.down })}>${st.down ? "Bring link up" : "Cut link"}</button>
    </div>
    <div class="grid2">
      <label>Delay each way (ms)<input value=${st.delay_ms} onChange=${(e) => setSt({ ...st, delay_ms: e.target.value })} /></label>
      <label>Loss (%)<input value=${st.loss_pct} onChange=${(e) => setSt({ ...st, loss_pct: e.target.value })} /></label>
    </div>
    <div class="row"><button onClick=${() => apply(st)}>Apply delay/loss</button>
      <button onClick=${() => apply({ ...st, delay_ms: 0, loss_pct: 0 })}>Clear</button></div>
    ${err && html`<p class="warn">${err}</p>`}
    <p class="hint">Cutting drops carrier like a pulled cable. BGP only notices when its hold timer expires (up to 180 s); until then
      ECMP keeps hashing some traffic into the dead path. Shutting the port in config (admin down) is noticed at once. A redeploy clears all faults.</p>`;
}

function bgpBadge(l) {
  const peers = Object.entries(l?.bgp || {});
  if (!peers.length) return null;
  const up = peers.filter(([, p]) => p.state === "Established").length;
  return { up, total: peers.length, detail: peers.map(([ip, p]) => `${ip} ${p.state}`).join("\n") };
}

function Checks({ lab, running, onClose }) {
  const [text, setText] = useState(null);
  const [saved, setSaved] = useState("");
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { api(`/labs/${lab}/checks`).then((t) => { setText(t); setSaved(t); }).catch((e) => setErr(e.message)); }, []);
  async function runChecks() {
    setBusy(true); setErr(""); setResults(null);
    try {
      if (text !== saved) { await api(`/labs/${lab}/checks`, { method: "PUT", body: text }); setSaved(text); }
      setResults(await api(`/labs/${lab}/checks/run`, { method: "POST" }));
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  const passed = results?.filter((r) => r.ok).length;
  return html`<div class="modal"><div class="dialog wide">
    <div class="dlg-head"><h2>${lab} checks</h2><span style=${{ flex: 1 }}></span><button onClick=${onClose}>Close</button></div>
    <div class="dlg-body grid2">
      <label>checks.yaml
        <textarea class="code" spellcheck="false" value=${text ?? ""} onChange=${(e) => setText(e.target.value)} />
        <span class="hint">One check per line:<br />
          <code>- {from: h1, ping: 10.0.2.10}</code><br /><code>- {node: leaf1, bgp_established: 2}</code><br />
          <code>- {node: leaf1, route: 10.0.2.0/24, via: bgp}</code></span></label>
      <div>
        <div class="row" style=${{ marginTop: 0 }}>
          <button class="primary" disabled=${busy || !running || text === null} onClick=${runChecks}>${busy ? "Running…" : "Run checks"}</button>
          ${!running && html`<span class="muted">Deploy the lab first.</span>`}
          ${results && html`<strong class=${passed === results.length ? "ok" : "warn"}>${passed}/${results.length} passed</strong>`}
        </div>
        ${err && html`<p class="warn">${err}</p>`}
        ${results?.map((r, i) => html`<div key=${i} class="result">
          <span class=${r.ok ? "ok" : "warn"}>${r.ok ? "✓" : "✗"}</span> ${r.check}<div class="muted">${r.detail}</div></div>`)}
      </div>
    </div>
  </div></div>`;
}

function Term({ lab, node, kind, close }) {
  const ref = useRef();
  useEffect(() => {
    const t = new Terminal({ fontSize: 13, cursorBlink: true, convertEol: false });
    const fit = new FitAddon();
    t.loadAddon(fit); t.open(ref.current); fit.fit();
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/labs/${lab}/nodes/${node}/terminal`);
    ws.binaryType = "arraybuffer";
    const resize = () => { fit.fit(); ws.readyState === 1 && ws.send(JSON.stringify({ r: [t.cols, t.rows] })); };
    ws.onopen = resize;
    ws.onmessage = (e) => t.write(new Uint8Array(e.data));
    ws.onclose = (e) => t.write(`\r\n[connection closed${e.reason ? ": " + e.reason : ""}]\r\n`);
    t.onData((d) => ws.readyState === 1 && ws.send(JSON.stringify({ i: d })));
    const ro = new ResizeObserver(resize); ro.observe(ref.current);
    t.focus();
    return () => { ro.disconnect(); ws.close(); t.dispose(); };
  }, []);
  return html`<div class="term">
    <div class="bar"><span>${node} — ${kind === "host" ? "host shell" : "SONiC shell (show …, config …, vtysh)"}</span>
      <button onClick=${close}>Close</button></div>
    <div class="xterm-host" ref=${ref}></div>
  </div>`;
}

createRoot(document.getElementById("root")).render(html`<${ReactFlowProvider}><${App} /></${ReactFlowProvider}>`);
