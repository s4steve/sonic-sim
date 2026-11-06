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
  </div>`;
}
const nodeTypes = { lab: LabNode };

// A cable labelled at each end, next to the device that port belongs to.
function CableEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }) {
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const at = (f) => `translate(-50%, -50%) translate(${sourceX + (targetX - sourceX) * f}px, ${sourceY + (targetY - sourceY) * f}px)`;
  return html`<${React.Fragment}>
    <${BaseEdge} id=${id} path=${path} style=${selected ? { stroke: "var(--accent)", strokeWidth: 2 } : undefined} />
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
    setLab(l); setStatus(s); setFlowNodes(toFlowNodes(l, s)); setSel(null); setDirty(false); setTerm(null); setConfigs({});
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
  useEffect(() => { setFlowNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, state: status[n.id] } }))); }, [status]);

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
    type: "cable", data: { a: portLabel(a), b: portLabel(b) },
  })) : [];
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
      openTerm=${(node) => setTerm(node)} configure=${setEditing} />`}</aside>
    ${editing && html`<${ConfigEditor} key=${editing} lab=${lab} node=${editing} running=${status[editing] === "running"}
      onClose=${() => setEditing(null)} onSaved=${(n, c) => setConfigs((cs) => ({ ...cs, [n]: c }))} />`}
    ${term && html`<${Term} key=${lab.name + term} lab=${lab.name} node=${term} kind=${lab.nodes[term]?.kind} close=${() => setTerm(null)} />`}
  `;
}

function Side({ lab, sel, status, edit, setSel, openTerm, configure }) {
  if (sel?.node && lab.nodes[sel.node]) {
    const n = sel.node, spec = lab.nodes[n];
    const set = (k) => (e) => edit((l) => { l.nodes[n][k] = e.target.value; });
    return html`<h2>${n} <small>(${spec.kind === "sonic" ? "SONiC switch" : "host"})</small></h2>
      ${spec.kind === "host" && html`
        <label>IP on eth1 (CIDR)</label><input value=${spec.ip || ""} placeholder="e.g. 192.168.10.10/24" onChange=${set("ip")} />
        <label>Default gateway</label><input value=${spec.gw || ""} placeholder="e.g. 192.168.10.1" onChange=${set("gw")} />`}
      <label>Ports in use</label>
      <div>${[...usedPorts(lab, n)].join(", ") || "none"}</div>
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
      <p class="hint">Port changes take effect on the next deploy.</p>`;
  }
  return html`<h2>${lab.name}</h2>
    <p class="hint">Add switches and hosts from the toolbar. Drag from a node's side dot to another node to link them;
      the next free port on each side is picked for you. Click a node or link to edit it.</p>
    <p class="hint">${Object.keys(lab.nodes).length} nodes · ${lab.links.length} links</p>`;
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
