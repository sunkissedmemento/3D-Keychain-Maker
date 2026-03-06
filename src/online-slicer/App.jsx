import { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";

// ── JSZip CDN loader ──────────────────────────────────────────────────────────
function loadJSZip() {
  return new Promise((resolve, reject) => {
    if (window.JSZip) return resolve(window.JSZip);
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
    s.onload = () => resolve(window.JSZip);
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

// ── 3MF Parser ────────────────────────────────────────────────────────────────
async function parse3MF(buffer) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(buffer);
  const allPaths = Object.keys(zip.files);

  // Find model file
  let modelEntry = zip.file("3D/3dmodel.model");
  if (!modelEntry) {
    modelEntry = Object.values(zip.files).find((f) => !f.dir && f.name.endsWith(".model"));
  }
  if (!modelEntry) throw new Error("No .model file found in 3MF");

  const xmlText = await modelEntry.async("string");
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");

  // ── Geometry ───────────────────────────────────────────────────────────────
  const objects = doc.querySelectorAll("object");
  const allPositions = [];
  const supportPositions = [];
  let totalTriangles = 0;

  objects.forEach((obj) => {
    const type = (obj.getAttribute("type") || "model").toLowerCase();
    const name = (obj.getAttribute("name") || "").toLowerCase();
    const isSupport = type === "support" || type === "support-blocker" || type === "support-enforcer" || name.includes("support");
    const mesh = obj.querySelector("mesh");
    if (!mesh) return;
    const verticesEl = mesh.querySelector("vertices");
    const trianglesEl = mesh.querySelector("triangles");
    if (!verticesEl || !trianglesEl) return;
    const verts = [];
    verticesEl.querySelectorAll("vertex").forEach((v) => {
      verts.push([parseFloat(v.getAttribute("x") || "0"), parseFloat(v.getAttribute("y") || "0"), parseFloat(v.getAttribute("z") || "0")]);
    });
    const target = isSupport ? supportPositions : allPositions;
    trianglesEl.querySelectorAll("triangle").forEach((t) => {
      const v1 = parseInt(t.getAttribute("v1")), v2 = parseInt(t.getAttribute("v2")), v3 = parseInt(t.getAttribute("v3"));
      if (isNaN(v1) || isNaN(v2) || isNaN(v3) || !verts[v1] || !verts[v2] || !verts[v3]) return;
      target.push(...verts[v1], ...verts[v2], ...verts[v3]);
      if (!isSupport) totalTriangles++;
    });
  });

  if (totalTriangles === 0) throw new Error("No triangles found in 3MF");

  const positions = new Float32Array(allPositions);
  const normals = computeNormals(positions);

  // ── Config parsing ─────────────────────────────────────────────────────────
  // Bambu Studio stores settings as JSON in these files:
  const CONFIG_PRIORITY = [
    "Metadata/print_profile.config",       // process/print settings JSON
    "Metadata/project_settings.config",    // full project JSON (has everything)
    "Metadata/model_settings.config",      // per-object settings XML
    "Metadata/slice_info.config",          // slice result info
  ];

  // Also collect any other .config files dynamically
  allPaths.forEach((p) => {
    if (p.startsWith("Metadata/") && p.endsWith(".config") && !CONFIG_PRIORITY.includes(p)) {
      CONFIG_PRIORITY.push(p);
    }
  });

  const rawConfig = {};

  for (const src of CONFIG_PRIORITY) {
    const entry = zip.file(src);
    if (!entry) continue;
    const text = (await entry.async("string")).trim();
    if (!text) continue;

    // ── JSON (Bambu Studio primary format) ──────────────────────────────────
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        const parsed = JSON.parse(text);
        // project_settings.config is a flat JSON object with arrays for multi-extruder
        // print_profile.config is also flat JSON
        const flat = flattenBambuJSON(parsed);
        for (const [k, v] of Object.entries(flat)) {
          if (!(k in rawConfig)) rawConfig[k] = v;
        }
        continue;
      } catch {}
    }

    // ── XML with <config> structure (model_settings.config) ─────────────────
    try {
      const xdoc = parser.parseFromString(text, "application/xml");
      // Bambu model_settings uses: <config><object id="..."><metadata key="..." value="..."/></object></config>
      xdoc.querySelectorAll("metadata").forEach((el) => {
        const k = el.getAttribute("key") || el.getAttribute("name");
        const v = el.getAttribute("value") || el.textContent?.trim();
        if (k && v && !(k in rawConfig)) rawConfig[k] = v;
      });
      // Also <setting key value>
      xdoc.querySelectorAll("setting").forEach((el) => {
        const k = el.getAttribute("key");
        const v = el.getAttribute("value");
        if (k && v && !(k in rawConfig)) rawConfig[k] = v;
      });
      continue;
    } catch {}

    // ── key = value fallback ─────────────────────────────────────────────────
    text.split("\n").forEach((line) => {
      const m = line.match(/^([^=;#\[]+?)\s*=\s*(.+)$/);
      if (m) { const k = m[1].trim(); if (!(k in rawConfig)) rawConfig[k] = m[2].trim(); }
    });
  }

  return {
    positions, normals, triangleCount: totalTriangles,
    rawConfig, allPaths,
    hasSupportGeometry: supportPositions.length > 0,
    supportPositionsArr: supportPositions.length > 0 ? new Float32Array(supportPositions) : null,
  };
}

// Flatten Bambu JSON config — handles single-element arrays (multi-extruder fields)
function flattenBambuJSON(obj, prefix = "") {
  const out = {};
  if (typeof obj !== "object" || obj === null) return out;
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      if (v.length === 1 && typeof v[0] !== "object") {
        out[k] = String(v[0]); // single-extruder scalar
      } else if (v.every((x) => typeof x !== "object")) {
        out[k] = v.map(String).join(", "); // multi-value primitive array
      } else {
        // Array of objects — flatten each with index
        v.forEach((item, i) => {
          if (typeof item === "object") Object.assign(out, flattenBambuJSON(item, `${key}[${i}]`));
        });
      }
    } else if (typeof v === "object") {
      Object.assign(out, flattenBambuJSON(v, key));
    } else {
      // Skip gcode blocks (very long strings)
      const str = String(v);
      if (str.length < 200) out[k] = str;
    }
  }
  return out;
}

function computeNormals(positions) {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 9) {
    const ax=positions[i],ay=positions[i+1],az=positions[i+2];
    const bx=positions[i+3],by=positions[i+4],bz=positions[i+5];
    const cx=positions[i+6],cy=positions[i+7],cz=positions[i+8];
    const ux=bx-ax,uy=by-ay,uz=bz-az,vx=cx-ax,vy=cy-ay,vz=cz-az;
    const nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx;
    const len=Math.sqrt(nx*nx+ny*ny+nz*nz)||1;
    for(let j=0;j<3;j++){normals[i+j*3]=nx/len;normals[i+j*3+1]=ny/len;normals[i+j*3+2]=nz/len;}
  }
  return normals;
}

function computeVolume(positions) {
  let vol=0;
  for(let i=0;i<positions.length;i+=9){
    vol+=(positions[i]*(positions[i+4]*positions[i+8]-positions[i+5]*positions[i+7])+positions[i+3]*(positions[i+7]*positions[i+2]-positions[i+8]*positions[i+1])+positions[i+6]*(positions[i+1]*positions[i+5]-positions[i+2]*positions[i+4]))/6;
  }
  return Math.abs(vol);
}

// ── Bambu JSON key → display mapping ──────────────────────────────────────────
// Keys from: project_settings.config + print_profile.config (Bambu Studio)
const KEY_MAP = {
  // Layer
  layer_height:                    { label:"Layer Height",         sec:"Layer",       fmt:v=>`${v} mm` },
  initial_layer_height:            { label:"First Layer",          sec:"Layer",       fmt:v=>`${v} mm` },
  top_shell_layers:                { label:"Top Layers",           sec:"Layer" },
  bottom_shell_layers:             { label:"Bottom Layers",        sec:"Layer" },
  top_shell_thickness:             { label:"Top Thickness",        sec:"Layer",       fmt:v=>`${v} mm` },
  bottom_shell_thickness:          { label:"Bottom Thickness",     sec:"Layer",       fmt:v=>`${v} mm` },
  // Walls
  wall_loops:                      { label:"Wall Loops",           sec:"Walls" },
  outer_wall_line_width:           { label:"Outer Wall Width",     sec:"Walls",       fmt:v=>`${v} mm` },
  inner_wall_line_width:           { label:"Inner Wall Width",     sec:"Walls",       fmt:v=>`${v} mm` },
  wall_filament:                   { label:"Wall Filament",        sec:"Walls" },
  // Infill
  sparse_infill_density:           { label:"Infill Density",       sec:"Infill",      fmt:v=>v.includes("%")?v:`${v}%` },
  sparse_infill_pattern:           { label:"Infill Pattern",       sec:"Infill" },
  infill_combination:              { label:"Infill Combo",         sec:"Infill",      fmt:v=>v==="1"?"On":"Off" },
  infill_filament:                 { label:"Infill Filament",      sec:"Infill" },
  // Speed
  outer_wall_speed:                { label:"Outer Wall",           sec:"Speed",       fmt:v=>`${v} mm/s` },
  inner_wall_speed:                { label:"Inner Wall",           sec:"Speed",       fmt:v=>`${v} mm/s` },
  sparse_infill_speed:             { label:"Infill",               sec:"Speed",       fmt:v=>`${v} mm/s` },
  top_surface_speed:               { label:"Top Surface",          sec:"Speed",       fmt:v=>`${v} mm/s` },
  initial_layer_speed:             { label:"First Layer",          sec:"Speed",       fmt:v=>`${v} mm/s` },
  travel_speed:                    { label:"Travel",               sec:"Speed",       fmt:v=>`${v} mm/s` },
  travel_speed_z:                  { label:"Z Travel",             sec:"Speed",       fmt:v=>`${v} mm/s` },
  initial_layer_infill_speed:      { label:"1st Layer Infill",     sec:"Speed",       fmt:v=>`${v} mm/s` },
  // Temperature
  nozzle_temperature:              { label:"Nozzle Temp",          sec:"Temperature", fmt:v=>`${v}°C` },
  nozzle_temperature_initial_layer:{ label:"Nozzle Temp (1st)",    sec:"Temperature", fmt:v=>`${v}°C` },
  hot_plate_temp:                  { label:"Bed Temp",             sec:"Temperature", fmt:v=>`${v}°C` },
  hot_plate_temp_initial_layer:    { label:"Bed Temp (1st)",       sec:"Temperature", fmt:v=>`${v}°C` },
  bed_temperature:                 { label:"Bed Temp",             sec:"Temperature", fmt:v=>`${v}°C` },
  // Filament
  filament_type:                   { label:"Material",             sec:"Filament" },
  filament_colour:                 { label:"Color",                sec:"Filament" },
  filament_diameter:               { label:"Diameter",             sec:"Filament",    fmt:v=>`${v} mm` },
  filament_density:                { label:"Density",              sec:"Filament",    fmt:v=>`${v} g/cm³` },
  filament_settings_id:            { label:"Filament Profile",     sec:"Filament" },
  filament_ids:                    { label:"Filament IDs",         sec:"Filament" },
  // Supports
  enable_support:                  { label:"Supports",             sec:"Supports",    fmt:v=>v==="1"||v==="true"?"Enabled":"Disabled" },
  support_type:                    { label:"Support Type",         sec:"Supports" },
  support_style:                   { label:"Support Style",        sec:"Supports" },
  support_threshold_angle:         { label:"Overhang Angle",       sec:"Supports",    fmt:v=>`${v}°` },
  support_interface_top_layers:    { label:"Interface Layers",     sec:"Supports" },
  support_filament:                { label:"Support Filament",     sec:"Supports" },
  // Cooling
  fan_min_speed:                   { label:"Fan Min",              sec:"Cooling",     fmt:v=>`${v}%` },
  fan_max_speed:                   { label:"Fan Max",              sec:"Cooling",     fmt:v=>`${v}%` },
  fan_cooling_layer_time:          { label:"Cooling Layer Time",   sec:"Cooling",     fmt:v=>`${v}s` },
  slow_down_min_speed:             { label:"Slow-down Min",        sec:"Cooling",     fmt:v=>`${v} mm/s` },
  // Adhesion
  brim_type:                       { label:"Brim Type",            sec:"Adhesion" },
  brim_width:                      { label:"Brim Width",           sec:"Adhesion",    fmt:v=>`${v} mm` },
  brim_object_gap:                 { label:"Brim Gap",             sec:"Adhesion",    fmt:v=>`${v} mm` },
  skirt_loops:                     { label:"Skirt Loops",          sec:"Adhesion" },
  // Quality
  seam_position:                   { label:"Seam Position",        sec:"Quality" },
  resolution:                      { label:"Resolution",           sec:"Quality",     fmt:v=>`${v} mm` },
  ironing_type:                    { label:"Ironing",              sec:"Quality" },
  detect_overhang_wall:            { label:"Detect Overhang",      sec:"Quality",     fmt:v=>v==="1"?"On":"Off" },
  detect_thin_wall:                { label:"Detect Thin Wall",     sec:"Quality",     fmt:v=>v==="1"?"On":"Off" },
  // Retraction
  retraction_length:               { label:"Retraction Len",       sec:"Retraction",  fmt:v=>`${v} mm` },
  retraction_speed:                { label:"Retraction Speed",     sec:"Retraction",  fmt:v=>`${v} mm/s` },
  // Machine
  printer_model:                   { label:"Printer",              sec:"Machine" },
  nozzle_diameter:                 { label:"Nozzle Dia",           sec:"Machine",     fmt:v=>`${v} mm` },
  nozzle_type:                     { label:"Nozzle Type",          sec:"Machine" },
  bed_type:                        { label:"Bed Type",             sec:"Machine" },
  print_settings_id:               { label:"Process Profile",      sec:"Machine" },
  curr_plate_index:                { label:"Plate Index",          sec:"Machine" },
};

const SEC_COLOR = {
  Layer:"#00aaff", Walls:"#aa88ff", Infill:"#ffaa00", Speed:"#ff44aa",
  Temperature:"#ff5533", Supports:"#ff6644", Filament:"#00dc82",
  Cooling:"#44ddff", Adhesion:"#88ff44", Quality:"#ddbbff",
  Retraction:"#ffdd44", Machine:"#aaaaaa", Other:"#445566",
};

function buildSections(rawConfig) {
  const sections = {};
  const used = new Set();
  for (const [rawKey, rawVal] of Object.entries(rawConfig)) {
    const m = KEY_MAP[rawKey];
    if (!m) continue;
    const val = m.fmt ? m.fmt(rawVal) : rawVal;
    if (!sections[m.sec]) sections[m.sec] = [];
    sections[m.sec].push({ label: m.label, value: val });
    used.add(rawKey);
  }
  // Catch unmapped keys that seem useful
  const extra = [];
  for (const [k, v] of Object.entries(rawConfig)) {
    if (used.has(k)) continue;
    if (k.includes("gcode") || k.length > 50 || v.length > 80) continue;
    if (k.startsWith("extruder_") || k.startsWith("bed_exclude") || k.startsWith("compatible")) continue;
    extra.push({ label: k, value: v });
  }
  if (extra.length > 0) sections["Other"] = extra.slice(0, 25);
  return sections;
}

const fmtMM = (v) => v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : v.toFixed(0);
const fmtVol = (v) => v >= 1e6 ? `${(v/1e6).toFixed(2)} cm³` : `${v.toFixed(0)} mm³`;

function injectStyles() {
  const id = "v3mf-styles";
  if (document.getElementById(id)) return;
  const s = document.createElement("style");
  s.id = id;
  s.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600&family=Syne:wght@400;600;700;800&display=swap');
    *,*::before,*::after{box-sizing:border-box}
    html,body,#root{margin:0;padding:0;height:100%;overflow:hidden;background:#050709}
    @keyframes spin{to{transform:rotate(360deg)}}
    @keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
    @keyframes pulse{0%,100%{opacity:.4}50%{opacity:1}}
    @keyframes scanline{0%{transform:translateY(-100%)}100%{transform:translateY(500%)}}
    .b3{transition:all .15s;cursor:pointer}
    .b3:hover{filter:brightness(1.2);transform:translateY(-1px)}
    .b3:active{transform:translateY(0)}
    .ri{animation:fadeUp .22s ease both}
    .drop-idle{border:2px dashed #1a2530;transition:all .2s}
    .drop-idle:hover{border-color:rgba(0,220,130,.35);background:rgba(0,220,130,.03)}
    ::-webkit-scrollbar{width:3px}
    ::-webkit-scrollbar-track{background:transparent}
    ::-webkit-scrollbar-thumb{background:#182030;border-radius:2px}
  `;
  document.head.appendChild(s);
}

export default function Viewer3MF() {
  const canvasRef = useRef(null);
  const rendererRef = useRef(null);
  const cameraRef = useRef(null);
  const sceneRef = useRef(null);
  const ctrlRef = useRef(null);
  const animRef = useRef(null);
  const meshRef = useRef(null);
  const suppRef = useRef(null);

  const [file, setFile] = useState(null);
  const [data, setData] = useState(null);
  const [dragging, setDrag] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [viewMode, setViewMode] = useState("solid");
  const [showSupport, setShowSupport] = useState(true);
  const [activeSec, setActiveSec] = useState(null);
  const [showRaw, setShowRaw] = useState(false);

  const AC="#00dc82", A2="#00aaff", BG="#050709", BG2="#07090d";
  const BD="#0f1820", TL="#1a3040", TM="#4a7080", TH="#c8dde8";

  useEffect(() => { injectStyles(); }, []);

  // Scene init
  useEffect(() => {
    const el = canvasRef.current; if (!el) return;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x050709);
    sceneRef.current = scene;

    const grid = new THREE.GridHelper(300, 25, 0x0f2030, 0x071018);
    grid.position.y = -0.5; scene.add(grid);
    const axL = (a,b,c) => { const g=new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a),new THREE.Vector3(...b)]); return new THREE.Line(g,new THREE.LineBasicMaterial({color:c,transparent:true,opacity:.35})); };
    scene.add(axL([0,0,0],[8,0,0],0xff4455)); scene.add(axL([0,0,0],[0,8,0],0x44ff88)); scene.add(axL([0,0,0],[0,0,8],0x4488ff));

    scene.add(new THREE.AmbientLight(0x223344,1.0));
    const kl=new THREE.DirectionalLight(0xffffff,1.3); kl.position.set(60,90,50); scene.add(kl);
    const fl=new THREE.DirectionalLight(0x2255aa,.6); fl.position.set(-50,20,-40); scene.add(fl);
    const rl=new THREE.DirectionalLight(0x00dc82,.25); rl.position.set(0,-20,-60); scene.add(rl);

    const w=el.clientWidth,h=el.clientHeight;
    const camera=new THREE.PerspectiveCamera(45,w/h,.01,10000);
    camera.position.set(80,60,120); cameraRef.current=camera;

    const renderer=new THREE.WebGLRenderer({antialias:true});
    renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
    renderer.setSize(w,h); el.appendChild(renderer.domElement);
    rendererRef.current=renderer;

    import("three/examples/jsm/controls/OrbitControls").then(({OrbitControls})=>{
      const ctrl=new OrbitControls(camera,renderer.domElement);
      ctrl.enableDamping=true; ctrl.dampingFactor=.07; ctrl.minDistance=2; ctrl.maxDistance=5000;
      ctrlRef.current=ctrl;
    });

    let last=0;
    const tick=(t)=>{
      animRef.current=requestAnimationFrame(tick);
      if(t-last<14)return; last=t;
      ctrlRef.current?.update(); renderer.render(scene,camera);
    }; tick(0);

    const onResize=()=>{ const w=el.clientWidth,h=el.clientHeight; camera.aspect=w/h; camera.updateProjectionMatrix(); renderer.setSize(w,h); };
    window.addEventListener("resize",onResize);
    return ()=>{ window.removeEventListener("resize",onResize); cancelAnimationFrame(animRef.current); ctrlRef.current?.dispose(); renderer.dispose(); renderer.domElement.remove(); };
  }, []);

  const loadFile = useCallback(async (f) => {
    setLoading(true); setError(null); setData(null);
    try {
      const buf = await f.arrayBuffer();
      const parsed = await parse3MF(buf);

      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(parsed.positions, 3));
      geo.setAttribute("normal", new THREE.BufferAttribute(parsed.normals, 3));
      geo.computeBoundingBox();
      const bb = geo.boundingBox;
      const center = new THREE.Vector3(); bb.getCenter(center);
      geo.translate(-center.x, -center.y, -bb.min.z);
      geo.computeBoundingBox();
      const size = new THREE.Vector3(); geo.boundingBox.getSize(size);

      if (meshRef.current) { sceneRef.current.remove(meshRef.current); meshRef.current.geometry.dispose(); meshRef.current.material.dispose(); }
      if (suppRef.current) { sceneRef.current.remove(suppRef.current); suppRef.current.geometry.dispose(); suppRef.current.material.dispose(); suppRef.current = null; }

      const mesh = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({ color:0x00dc82, specular:0x224433, shininess:50, side:THREE.DoubleSide }));
      sceneRef.current.add(mesh); meshRef.current = mesh;

      if (parsed.hasSupportGeometry && parsed.supportPositionsArr) {
        const sg = new THREE.BufferGeometry();
        const sp = new Float32Array(parsed.supportPositionsArr);
        for (let i=0;i<sp.length;i+=3){sp[i]-=center.x;sp[i+1]-=center.y;sp[i+2]-=bb.min.z;}
        sg.setAttribute("position", new THREE.BufferAttribute(sp,3));
        sg.computeVertexNormals();
        const sm = new THREE.Mesh(sg, new THREE.MeshPhongMaterial({color:0xff7733,transparent:true,opacity:.5,side:THREE.DoubleSide}));
        sceneRef.current.add(sm); suppRef.current = sm;
      }

      const maxDim=Math.max(size.x,size.y,size.z), dist=maxDim*2.2;
      if(cameraRef.current){cameraRef.current.position.set(dist*.7,dist*.6,dist);cameraRef.current.near=maxDim*.001;cameraRef.current.far=maxDim*100;cameraRef.current.updateProjectionMatrix();}
      if(ctrlRef.current){ctrlRef.current.target.set(0,size.z*.4,0);ctrlRef.current.update();}

      const vol=computeVolume(parsed.positions);
      const sections=buildSections(parsed.rawConfig);

      setData({ name:f.name, fileSize:f.size, triangleCount:parsed.triangleCount, size, volume:vol, sections, rawConfig:parsed.rawConfig, allPaths:parsed.allPaths, hasSupportGeometry:parsed.hasSupportGeometry, configKeyCount:Object.keys(parsed.rawConfig).length });
      setFile(f);
    } catch(e) {
      console.error(e); setError(`Parse failed: ${e.message}`);
    }
    setLoading(false);
  }, []);

  useEffect(()=>{
    const m=meshRef.current; if(!m)return;
    if(viewMode==="solid"){m.material.wireframe=false;m.material.transparent=false;m.material.opacity=1;m.material.color.set(0x00dc82);}
    else if(viewMode==="wire"){m.material.wireframe=true;m.material.transparent=false;m.material.opacity=1;m.material.color.set(0x00ffaa);}
    else if(viewMode==="xray"){m.material.wireframe=false;m.material.transparent=true;m.material.opacity=.18;m.material.color.set(0x00aaff);}
    m.material.needsUpdate=true;
  },[viewMode]);
  useEffect(()=>{ if(suppRef.current)suppRef.current.visible=showSupport; },[showSupport]);

  const onDrop=useCallback((e)=>{ e.preventDefault();setDrag(false); const f=e.dataTransfer.files[0]; if(f&&f.name.toLowerCase().endsWith(".3mf"))loadFile(f); else setError("Please drop a .3MF file."); },[loadFile]);
  const onFileInput=useCallback((e)=>{ const f=e.target.files[0]; if(f)loadFile(f); },[loadFile]);
  const resetCamera=useCallback(()=>{ if(!cameraRef.current||!ctrlRef.current)return; cameraRef.current.position.set(80,60,120); ctrlRef.current.target.set(0,0,0); ctrlRef.current.update(); },[]);

  const secs = data?.sections || {};
  const secNames = Object.keys(secs);
  const visible = activeSec ? { [activeSec]: secs[activeSec] } : secs;

  // Button style helpers
  const btnBase = (active, col="#c8dde8") => ({
    padding:"4px 10px", fontSize:9, letterSpacing:"0.1em", fontFamily:"'IBM Plex Mono'", textTransform:"uppercase",
    background: active ? `${col}22` : "transparent",
    border: active ? `1px solid ${col}55` : `1px solid ${BD}`,
    borderRadius:5, color: active ? col : TL,
  });

  return (
    <div style={{ fontFamily:"'Syne',sans-serif", background:BG, color:TH, height:"100dvh", width:"100vw", display:"flex", flexDirection:"column", overflow:"hidden" }}>

      {/* ── Header ── */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"10px 18px", borderBottom:`1px solid ${BD}`, background:"#06080cdd", backdropFilter:"blur(12px)", flexShrink:0, zIndex:10 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ width:30,height:30,background:`linear-gradient(135deg,${AC},${A2})`,borderRadius:7,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15 }}>⬡</div>
          <div>
            <div style={{ fontFamily:"'IBM Plex Mono'",fontWeight:600,fontSize:12,letterSpacing:"0.14em",color:"#fff" }}>3MF VIEWER</div>
            <div style={{ fontSize:9,letterSpacing:"0.22em",color:TL,marginTop:-1 }}>BAMBU STUDIO · CONFIG INSPECTOR</div>
          </div>
          {file&&<><div style={{width:1,height:26,background:BD,margin:"0 4px"}}/><div style={{fontFamily:"'IBM Plex Mono'",fontSize:10,color:TM,maxWidth:220,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{file.name}</div></>}
        </div>
        <div style={{ display:"flex",alignItems:"center",gap:6 }}>
          {file&&<>
            {["solid","wire","xray"].map(m=>(
              <button key={m} className="b3" onClick={()=>setViewMode(m)} style={btnBase(viewMode===m,AC)}>{m}</button>
            ))}
            {data?.hasSupportGeometry&&(
              <button className="b3" onClick={()=>setShowSupport(p=>!p)} style={btnBase(showSupport,"#ff6644")}>⬟ SUPPORTS</button>
            )}
            <button className="b3" onClick={resetCamera} style={{...btnBase(false),padding:"4px 9px"}}>⟳</button>
          </>}
          <label className="b3" style={{ padding:"5px 14px",fontSize:9,letterSpacing:"0.12em",fontFamily:"'IBM Plex Mono'",textTransform:"uppercase",background:`${AC}18`,border:`1px solid ${AC}44`,borderRadius:5,color:AC,cursor:"pointer",fontWeight:600 }}>
            + OPEN 3MF
            <input type="file" accept=".3mf" onChange={onFileInput} style={{ display:"none" }} />
          </label>
        </div>
      </div>

      {/* ── Body ── */}
      <div style={{ display:"flex", flex:1, minHeight:0, overflow:"hidden" }}>

        {/* ── Sidebar ── */}
        <div style={{ width:264, background:BG2, borderRight:`1px solid ${BD}`, overflowY:"auto", flexShrink:0 }}>
          {data ? (<>
            {/* Model info */}
            <div style={{ padding:"14px 16px", borderBottom:`1px solid ${BD}` }}>
              <SL>Model</SL>
              <IR label="Triangles" val={data.triangleCount.toLocaleString()} accent={AC}/>
              <IR label="Volume"    val={fmtVol(data.volume)}/>
              <IR label="File Size" val={`${(data.fileSize/1024).toFixed(1)} KB`}/>
              {data.hasSupportGeometry&&(
                <div style={{ marginTop:8,padding:"5px 8px",background:"rgba(255,102,68,.08)",border:"1px solid rgba(255,102,68,.2)",borderRadius:5 }}>
                  <span style={{ fontFamily:"'IBM Plex Mono'",fontSize:9,color:"#ff6644" }}>⬟ SUPPORT GEOMETRY PRESENT</span>
                </div>
              )}
            </div>

            {/* Dimensions */}
            <div style={{ padding:"12px 16px", borderBottom:`1px solid ${BD}` }}>
              <SL>Dimensions</SL>
              <IR label="X (Width)"  val={`${fmtMM(data.size.x)} mm`} accent={AC}/>
              <IR label="Y (Depth)"  val={`${fmtMM(data.size.y)} mm`} accent={AC}/>
              <IR label="Z (Height)" val={`${fmtMM(data.size.z)} mm`} accent={AC}/>
            </div>

            {/* Slicer Config */}
            {secNames.length > 0 ? (
              <div style={{ padding:"12px 0" }}>
                <div style={{ padding:"0 16px 6px" }}>
                  <SL>Slicer Config · Read-Only</SL>
                  <div style={{ fontSize:9,fontFamily:"'IBM Plex Mono'",color:TL,lineHeight:1.5 }}>{data.configKeyCount} keys from Bambu Studio</div>
                </div>

                {/* Section tabs */}
                <div style={{ display:"flex",flexWrap:"wrap",gap:4,padding:"2px 12px 10px" }}>
                  <button className="b3" onClick={()=>setActiveSec(null)} style={{ padding:"3px 8px",fontSize:8,letterSpacing:"0.1em",fontFamily:"'IBM Plex Mono'",textTransform:"uppercase",background:activeSec===null?"rgba(200,220,230,.1)":"transparent",border:activeSec===null?`1px solid rgba(200,220,230,.2)`:`1px solid ${BD}`,borderRadius:4,color:activeSec===null?TH:TL,cursor:"pointer" }}>All</button>
                  {secNames.map(s=>{
                    const col=SEC_COLOR[s]||SEC_COLOR.Other;
                    return <button key={s} className="b3" onClick={()=>setActiveSec(p=>p===s?null:s)} style={{ padding:"3px 8px",fontSize:8,letterSpacing:"0.1em",fontFamily:"'IBM Plex Mono'",textTransform:"uppercase",background:activeSec===s?`${col}22`:"transparent",border:activeSec===s?`1px solid ${col}55`:`1px solid ${BD}`,borderRadius:4,color:activeSec===s?col:TL,cursor:"pointer" }}>{s}</button>;
                  })}
                </div>

                {Object.entries(visible).map(([sec,rows])=>{
                  const col=SEC_COLOR[sec]||SEC_COLOR.Other;
                  return (
                    <div key={sec} style={{ marginBottom:2 }}>
                      <div style={{ padding:"5px 16px 3px",display:"flex",alignItems:"center",gap:6 }}>
                        <div style={{ width:5,height:5,borderRadius:"50%",background:col,flexShrink:0 }}/>
                        <span style={{ fontSize:8,letterSpacing:"0.18em",color:col,textTransform:"uppercase",fontFamily:"'IBM Plex Mono'" }}>{sec}</span>
                      </div>
                      <div style={{ padding:"0 10px 5px" }}>
                        {rows.map(({label,value},i)=>(
                          <SRow key={label} label={label} val={value} col={col} delay={i*25}/>
                        ))}
                      </div>
                    </div>
                  );
                })}

                {/* Raw keys toggle */}
                <div style={{ padding:"10px 14px 4px" }}>
                  <button className="b3" onClick={()=>setShowRaw(p=>!p)} style={{ width:"100%",padding:"5px 0",fontSize:9,fontFamily:"'IBM Plex Mono'",letterSpacing:"0.1em",background:showRaw?`${A2}15`:"transparent",border:`1px solid ${BD}`,borderRadius:5,color:showRaw?A2:TL,cursor:"pointer" }}>
                    {showRaw?"▲ HIDE RAW KEYS":"▼ SHOW ALL RAW KEYS"}
                  </button>
                </div>
                {showRaw&&(
                  <div style={{ padding:"6px 12px 12px" }}>
                    {Object.entries(data.rawConfig).map(([k,v])=>(
                      <div key={k} className="ri" style={{ display:"flex",justifyContent:"space-between",gap:4,marginBottom:3,padding:"3px 5px",background:"rgba(255,255,255,.015)",borderRadius:3 }}>
                        <span style={{ fontSize:8,color:TL,fontFamily:"'IBM Plex Mono'",flexShrink:0,maxWidth:118,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{k}</span>
                        <span style={{ fontSize:8,color:TM,fontFamily:"'IBM Plex Mono'",textAlign:"right",maxWidth:118,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{v}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ padding:"20px 16px" }}>
                <SL>Slicer Config</SL>
                <div style={{ fontSize:9,fontFamily:"'IBM Plex Mono'",color:"#ff7755",lineHeight:1.6,marginTop:6 }}>
                  No config metadata found.<br/>This 3MF may be a geometry-only export (not a Bambu Studio project file).
                </div>
                <div style={{ marginTop:10,fontSize:8,fontFamily:"'IBM Plex Mono'",color:TL,lineHeight:1.8 }}>
                  <div style={{ color:TM,marginBottom:4 }}>Files inside:</div>
                  {data.allPaths.map(p=><div key={p}>{p}</div>)}
                </div>
              </div>
            )}
          </>) : (
            <div style={{ display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",gap:10,padding:20 }}>
              <div style={{ fontSize:36,opacity:.08 }}>⬡</div>
              <div style={{ fontFamily:"'IBM Plex Mono'",fontSize:10,color:TL,textAlign:"center",lineHeight:1.7 }}>Open a .3MF to<br/>inspect settings</div>
            </div>
          )}
        </div>

        {/* ── Viewport ── */}
        <div style={{ flex:1,position:"relative",minHeight:0,overflow:"hidden" }}
          onDragOver={e=>{e.preventDefault();setDrag(true);}} onDragLeave={()=>setDrag(false)} onDrop={onDrop}>
          <div ref={canvasRef} style={{ position:"absolute",inset:0 }}/>

          {/* Scanline */}
          <div style={{ position:"absolute",inset:0,pointerEvents:"none",overflow:"hidden",zIndex:1 }}>
            <div style={{ position:"absolute",left:0,right:0,height:"20%",background:"linear-gradient(180deg,transparent,rgba(0,220,130,.01),transparent)",animation:"scanline 8s linear infinite" }}/>
          </div>

          {/* Corner marks */}
          {[["top","left"],["top","right"],["bottom","left"],["bottom","right"]].map(([tt,ll],i)=>(
            <div key={i} style={{ position:"absolute",[tt]:14,[ll]:14,width:16,height:16,zIndex:2,pointerEvents:"none", borderTop:tt==="top"?`1.5px solid ${AC}33`:"none",borderBottom:tt==="bottom"?`1.5px solid ${AC}33`:"none",borderLeft:ll==="left"?`1.5px solid ${AC}33`:"none",borderRight:ll==="right"?`1.5px solid ${AC}33`:"none" }}/>
          ))}

          {file&&<div style={{ position:"absolute",bottom:14,right:14,fontFamily:"'IBM Plex Mono'",fontSize:9,color:TL,letterSpacing:"0.08em",textAlign:"right",lineHeight:1.8,zIndex:5,pointerEvents:"none" }}>DRAG · rotate &nbsp; RIGHT · pan &nbsp; SCROLL · zoom</div>}

          {dragging&&(
            <div style={{ position:"absolute",inset:0,background:`${AC}08`,border:`2px dashed ${AC}`,zIndex:20,display:"flex",alignItems:"center",justifyContent:"center",pointerEvents:"none" }}>
              <div style={{ fontFamily:"'IBM Plex Mono'",fontSize:13,letterSpacing:"0.2em",color:AC }}>DROP 3MF FILE</div>
            </div>
          )}

          {loading&&(
            <div style={{ position:"absolute",inset:0,background:"rgba(5,7,9,.85)",zIndex:30,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:18 }}>
              <div style={{ width:38,height:38,border:`3px solid ${BD}`,borderTop:`3px solid ${AC}`,borderRadius:"50%",animation:"spin .75s linear infinite" }}/>
              <div style={{ fontFamily:"'IBM Plex Mono'",fontSize:11,letterSpacing:"0.2em",color:AC,animation:"pulse 1.5s ease infinite" }}>PARSING 3MF…</div>
            </div>
          )}

          {!file&&!loading&&(
            <label className="drop-idle" style={{ position:"absolute",inset:40,borderRadius:14,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:18,cursor:"pointer",zIndex:5 }}>
              <input type="file" accept=".3mf" onChange={onFileInput} style={{ display:"none" }}/>
              <div style={{ width:80,height:80,border:`1.5px solid ${BD}`,borderRadius:18,display:"flex",alignItems:"center",justifyContent:"center",fontSize:36,color:TL }}>⬡</div>
              <div style={{ textAlign:"center" }}>
                <div style={{ fontFamily:"'IBM Plex Mono'",fontSize:12,letterSpacing:"0.18em",color:TM,textTransform:"uppercase" }}>Drop .3MF File Here</div>
                <div style={{ fontSize:11,color:TL,marginTop:8 }}>or click to browse · Bambu Studio project files</div>
              </div>
            </label>
          )}

          {error&&(
            <div style={{ position:"absolute",bottom:20,left:"50%",transform:"translateX(-50%)",background:"#120408",border:"1px solid #ff4455",borderRadius:8,padding:"10px 20px",fontFamily:"'IBM Plex Mono'",fontSize:11,color:"#ff6677",zIndex:40,whiteSpace:"nowrap" }}>
              ⚠ {error}
              <span onClick={()=>setError(null)} style={{ marginLeft:14,cursor:"pointer",opacity:.5 }}>✕</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SL({children}){ return <div style={{fontSize:8,letterSpacing:"0.2em",color:"#1a3040",textTransform:"uppercase",marginBottom:8,fontFamily:"'IBM Plex Mono'"}}>{children}</div>; }
function IR({label,val,accent}){ return <div className="ri" style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:5}}><span style={{fontSize:10,color:"#2a5060",fontFamily:"'IBM Plex Mono'"}}>{label}</span><span style={{fontSize:11,color:accent||"#7aafbf",fontFamily:"'IBM Plex Mono'",fontWeight:500}}>{val}</span></div>; }
function SRow({label,val,col,delay=0}){ return <div className="ri" style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4,animationDelay:`${delay}ms`,padding:"4px 6px",background:"rgba(255,255,255,.018)",borderRadius:4}}><span style={{fontSize:9,color:"#3a5565",fontFamily:"'IBM Plex Mono'",flexShrink:0,marginRight:6}}>{label}</span><span style={{fontSize:10,color:col,fontFamily:"'IBM Plex Mono'",fontWeight:500,textAlign:"right"}}>{val}</span></div>; }