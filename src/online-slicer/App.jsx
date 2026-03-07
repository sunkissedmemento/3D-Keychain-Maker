import { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";

const API_BASE = "http://localhost:3001";

const QUALITY_PRESETS = {
  fine: {
    label: "Fine",
    layerHeight: 0.1,
    profile: "0.10mm Fine @Creality K2 Plus 0.4 nozzle",
  },
  standard: {
    label: "Standard",
    layerHeight: 0.2,
    profile: "0.20mm Standard @Creality K2 Plus 0.4 nozzle",
  },
  draft: {
    label: "Draft",
    layerHeight: 0.28,
    profile: "0.28mm Draft @Creality K2 Plus 0.4 nozzle",
  },
};

const MATERIALS = ["PLA", "PETG", "ABS", "TPU", "ASA"];

function loadJSZip() {
  return new Promise((res, rej) => {
    if (window.JSZip) return res(window.JSZip);
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
    s.onload = () => res(window.JSZip);
    s.onerror = rej;
    document.head.appendChild(s);
  });
}

async function detect3MFSupports(buffer) {
  try {
    const JSZip = await loadJSZip();
    const zip = await JSZip.loadAsync(buffer);
    const entry = zip.file("Metadata/project_settings.config");
    if (!entry) return false;
    const raw = await entry.async("string");
    const cfg = JSON.parse(raw);
    return (
      cfg["enable_support"] === "1" ||
      cfg["enable_support"] === 1 ||
      cfg["enable_support"] === true
    );
  } catch {
    return false;
  }
}

async function parse3MFForPreview(buffer) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(buffer);

  // Helper: parse all <object> elements from an XML string into the objects map
  function parseObjectsFromXml(xmlText, objects) {
    const doc = new DOMParser().parseFromString(xmlText, "application/xml");
    doc.querySelectorAll("object").forEach((obj) => {
      const id = obj.getAttribute("id");
      const type = (obj.getAttribute("type") || "model").toLowerCase();
      if (type === "support-blocker" || type === "support-enforcer") return;

      const mesh = obj.querySelector("mesh");
      if (!mesh) return;

      const verts = [];
      mesh.querySelector("vertices")?.querySelectorAll("vertex").forEach((v) => {
        verts.push([+v.getAttribute("x"), +v.getAttribute("y"), +v.getAttribute("z")]);
      });

      const tris = [];
      mesh.querySelector("triangles")?.querySelectorAll("triangle").forEach((t) => {
        tris.push([+t.getAttribute("v1"), +t.getAttribute("v2"), +t.getAttribute("v3")]);
      });

      if (verts.length && tris.length) objects[id] = { verts, tris };
    });
  }

  // Step 1: load all .model files in the zip (main + external objects)
  const objects = {};
  const modelFiles = Object.values(zip.files).filter(
    (f) => !f.dir && f.name.endsWith(".model")
  );

  for (const entry of modelFiles) {
    const xml = await entry.async("string");
    parseObjectsFromXml(xml, objects);
  }

  console.log("[3mf] objects parsed:", Object.keys(objects).length, Object.keys(objects));

  // Step 2: get build items from the main model file
  const mainEntry = zip.file("3D/3dmodel.model") ||
    Object.values(zip.files).find((f) => !f.dir && f.name.endsWith(".model"));
  if (!mainEntry) throw new Error("No .model entry found in 3MF");

  const mainXml = await mainEntry.async("string");
  const mainDoc = new DOMParser().parseFromString(mainXml, "application/xml");

  function parseTransform(str) {
    if (!str) return null;
    const n = str.trim().split(/\s+/).map(Number);
    if (n.length !== 12) return null;
    const m = new THREE.Matrix4();
    m.set(
      n[0], n[3], n[6], n[9],
      n[1], n[4], n[7], n[10],
      n[2], n[5], n[8], n[11],
      0, 0, 0, 1
    );
    return m;
  }

  // Step 3: resolve component references recursively
  function resolveObject(id, xform, outPos) {
    const obj = objects[id];
    if (!obj) return;

    const { verts, tris } = obj;
    tris.forEach(([v1, v2, v3]) => {
      if (!verts[v1] || !verts[v2] || !verts[v3]) return;
      [verts[v1], verts[v2], verts[v3]].forEach(([x, y, z]) => {
        if (xform) {
          const v = new THREE.Vector3(x, y, z).applyMatrix4(xform);
          outPos.push(v.x, v.y, v.z);
        } else {
          outPos.push(x, y, z);
        }
      });
    });
  }

  const allPos = [];
  const buildItems = mainDoc.querySelectorAll("build item");
  console.log("[3mf] build items:", buildItems.length);

  buildItems.forEach((item) => {
    const objId = item.getAttribute("objectid");
    const mat = parseTransform(item.getAttribute("transform"));
    resolveObject(objId, mat, allPos);
  });

  console.log("[3mf] allPos after build items:", allPos.length);

  // Fallback: dump all objects if build gave nothing
  if (allPos.length === 0) {
    Object.values(objects).forEach(({ verts, tris }) => {
      tris.forEach(([v1, v2, v3]) => {
        if (!verts[v1] || !verts[v2] || !verts[v3]) return;
        allPos.push(...verts[v1], ...verts[v2], ...verts[v3]);
      });
    });
    console.log("[3mf] allPos after fallback:", allPos.length);
  }

  if (allPos.length === 0) throw new Error("3MF has no renderable geometry");

  return { positions: new Float32Array(allPos) };
}


function buildNormals(pos) {
  const n = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 9) {
    const ax = pos[i],     ay = pos[i+1], az = pos[i+2];
    const bx = pos[i+3],   by = pos[i+4], bz = pos[i+5];
    const cx = pos[i+6],   cy = pos[i+7], cz = pos[i+8];
    const ux = bx-ax, uy = by-ay, uz = bz-az;
    const vx = cx-ax, vy = cy-ay, vz = cz-az;
    const nx = uy*vz - uz*vy;
    const ny = uz*vx - ux*vz;
    const nz = ux*vy - uy*vx;
    const l  = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
    for (let j = 0; j < 3; j++) {
      n[i+j*3]   = nx/l;
      n[i+j*3+1] = ny/l;
      n[i+j*3+2] = nz/l;
    }
  }
  return n;
}

function injectStyles() {
  const id = "pq3-styles";
  if (document.getElementById(id)) return;
  const s = document.createElement("style");
  s.id = id;
  s.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@300;400;600;700;800;900&family=JetBrains+Mono:wght@300;400;500;700&display=swap');
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
    html,body,#root{height:100%;overflow:hidden;background:#0a0a0b;}
    @keyframes spin{to{transform:rotate(360deg)}}
    @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
    @keyframes pulse{0%,100%{opacity:.3}50%{opacity:1}}
    @keyframes slideIn{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:none}}
    @keyframes countUp{from{opacity:0;transform:scale(.85)}to{opacity:1;transform:scale(1)}}
    @keyframes bpulse{0%,100%{border-color:#e8ff4722}50%{border-color:#e8ff4788}}
    .btn{transition:all .15s ease;cursor:pointer;user-select:none;}
    .btn:hover{filter:brightness(1.12);transform:translateY(-1px);}
    .btn:active{transform:scale(.97) translateY(0);}
    .fade-in{animation:fadeUp .3s ease both;}
    .slide-in{animation:slideIn .35s ease both;}
    .count-up{animation:countUp .4s cubic-bezier(.34,1.56,.64,1) both;}
    input[type=range]{-webkit-appearance:none;appearance:none;height:2px;cursor:pointer;border-radius:1px;}
    input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;border-radius:50%;cursor:pointer;border:2px solid #0a0a0b;}
    .drop-zone{transition:all .2s ease;}
    .drop-zone:hover,.drop-zone.active{background:rgba(232,255,71,.025)!important;border-color:rgba(232,255,71,.3)!important;}
  `;
  document.head.appendChild(s);
}

export default function App() {
  const canvasRef = useRef(null);
  const cameraRef = useRef(null);
  const sceneRef  = useRef(null);
  const ctrlRef   = useRef(null);
  const animRef   = useRef(null);
  const meshRef   = useRef(null);

  const [file, setFile]           = useState(null);
  const [modelSize, setModelSize] = useState(null);
  const [dragging, setDragging]   = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewErr, setPreviewErr] = useState(null);
  const [viewMode, setViewMode]   = useState("solid");

  const [quality, setQuality]   = useState("standard");
  const [infill, setInfill]     = useState(15);
  const [supports, setSupports] = useState(false);
  const [material, setMaterial] = useState("PLA");

  const [quoting, setQuoting]       = useState(false);
  const [quoteResult, setQuoteResult] = useState(null);
  const [quoteError, setQuoteError]   = useState(null);

  const preset = QUALITY_PRESETS[quality];

  const LIME = "#e8ff47";
  const CYAN = "#47ffe8";
  const RED  = "#ff4757";
  const mono = "'JetBrains Mono', monospace";
  const cond = "'Barlow Condensed', sans-serif";

  useEffect(() => { injectStyles(); }, []);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0b);
    sceneRef.current = scene;

    const BED = 260;
    const plateGeo = new THREE.PlaneGeometry(BED, BED);
    const plateMat = new THREE.MeshPhongMaterial({ color: 0x111114, specular: 0x222226, shininess: 20, side: THREE.DoubleSide });
    const plate = new THREE.Mesh(plateGeo, plateMat);
    plate.rotation.x = -Math.PI / 2;
    scene.add(plate);

    const grid = new THREE.GridHelper(BED, 35, 0x1a1a1e, 0x141417);
    grid.position.y = 0.5;
    scene.add(grid);

    const borderGeo = new THREE.EdgesGeometry(new THREE.PlaneGeometry(BED, BED));
    const borderMat = new THREE.LineBasicMaterial({ color: 0xe8ff4744 });
    const border = new THREE.LineSegments(borderGeo, borderMat);
    border.rotation.x = -Math.PI / 2;
    border.position.y = 0.8;
    scene.add(border);

    scene.add(new THREE.AmbientLight(0x333333, 1.2));
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.8);
    keyLight.position.set(60, 90, 50);
    scene.add(keyLight);
    const accent1 = new THREE.DirectionalLight(0xe8ff47, 0.3);
    accent1.position.set(-60, 40, -40);
    scene.add(accent1);
    const accent2 = new THREE.DirectionalLight(0x47ffe8, 0.2);
    accent2.position.set(0, -30, -80);
    scene.add(accent2);

    const w = el.clientWidth, h = el.clientHeight;
    const camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 20000);
    camera.position.set(300, 250, 400);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h);
    el.appendChild(renderer.domElement);

    import("three/examples/jsm/controls/OrbitControls").then(({ OrbitControls }) => {
      const ctrl = new OrbitControls(camera, renderer.domElement);
      ctrl.enableDamping = true;
      ctrl.dampingFactor = 0.07;
      ctrl.minDistance = 2;
      ctrl.maxDistance = 5000;
      ctrlRef.current = ctrl;
    });

    let last = 0;
    const tick = (t) => {
      animRef.current = requestAnimationFrame(tick);
      if (t - last < 14) return;
      last = t;
      ctrlRef.current?.update();
      renderer.render(scene, camera);
    };
    tick(0);

    const onResize = () => {
      const w2 = el.clientWidth, h2 = el.clientHeight;
      camera.aspect = w2 / h2;
      camera.updateProjectionMatrix();
      renderer.setSize(w2, h2);
    };
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(animRef.current);
      ctrlRef.current?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  const loadPreview = useCallback(async (f) => {
    // ── 3MF only ──────────────────────────────────────────────────────────
    const ext = f.name.split(".").pop().toLowerCase();
    if (ext !== "3mf") {
      setPreviewErr(
        `"${f.name}" is not a .3mf file. Please export your model as 3MF from your slicer.`
      );
      return;
    }

    setPreviewing(true);
    setPreviewErr(null);
    setQuoteResult(null);
    setQuoteError(null);

    try {
      const buf = await f.arrayBuffer();

      // Slice a copy for each consumer — ArrayBuffer is neutered after first JSZip load
      const mfSupportsEnabled = await detect3MFSupports(buf.slice(0));
      setSupports(mfSupportsEnabled);

      const { positions: rawPos } = await parse3MFForPreview(buf.slice(0));
      const remapped = new Float32Array(rawPos.length);
      for (let i = 0; i < rawPos.length; i += 3) {
        remapped[i]   = rawPos[i];
        remapped[i+1] = rawPos[i+2];
        remapped[i+2] = -rawPos[i+1];
      }

      const normals = buildNormals(remapped);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(remapped, 3));
      geo.setAttribute("normal",   new THREE.BufferAttribute(normals, 3));
      geo.computeBoundingBox();

      const bb = geo.boundingBox;
      geo.translate(
        -(bb.max.x + bb.min.x) / 2,
        -bb.min.y,
        -(bb.max.z + bb.min.z) / 2
      );
      geo.computeBoundingBox();

      const size = new THREE.Vector3();
      geo.boundingBox.getSize(size);

      if (meshRef.current) {
        sceneRef.current.remove(meshRef.current);
        meshRef.current.geometry.dispose();
        meshRef.current.material.dispose();
      }

      const mat = new THREE.MeshPhongMaterial({
        color: 0xe8ff47,
        specular: 0x1a1a00,
        shininess: 90,
        side: THREE.DoubleSide,
      });

      const mesh = new THREE.Mesh(geo, mat);
      sceneRef.current.add(mesh);
      meshRef.current = mesh;

      const maxDim = Math.max(size.x, size.y, size.z);
      const dist   = Math.max(maxDim * 2.2, 120);
      cameraRef.current.position.set(dist * 0.7, dist * 0.6, dist);
      cameraRef.current.near = Math.max(maxDim * 0.001, 0.1);
      cameraRef.current.far  = Math.max(maxDim * 100, 2000);
      cameraRef.current.updateProjectionMatrix();

      if (ctrlRef.current) {
        ctrlRef.current.target.set(0, size.y * 0.3, 0);
        ctrlRef.current.update();
      }

      setModelSize({
        x: size.x.toFixed(1),
        y: size.z.toFixed(1),
        z: size.y.toFixed(1),
      });

      setFile(f);
    } catch (e) {
      console.error("[loadPreview] error:", e);
      setPreviewErr(e.message || "Preview failed.");
    }

    setPreviewing(false);
  }, []);

  useEffect(() => {
    const m = meshRef.current;
    if (!m) return;
    if (viewMode === "solid") {
      m.material.wireframe = false;
      m.material.transparent = false;
      m.material.opacity = 1;
      m.material.color.set(0xe8ff47);
    } else if (viewMode === "wire") {
      m.material.wireframe = true;
      m.material.transparent = false;
      m.material.opacity = 1;
      m.material.color.set(0x47ffe8);
    } else {
      m.material.wireframe = false;
      m.material.transparent = true;
      m.material.opacity = 0.13;
      m.material.color.set(0xe8ff47);
    }
    m.material.needsUpdate = true;
  }, [viewMode]);

  const getQuote = useCallback(async () => {
    if (!file) return;
    setQuoting(true);
    setQuoteResult(null);
    setQuoteError(null);

    try {
      const fd = new FormData();
      fd.append("model", file);
      fd.append("printer", "k2");
      fd.append("layerHeight", String(preset.layerHeight));
      fd.append("qualityProfile", preset.profile);
      fd.append("infill", String(infill));
      fd.append("supports", String(supports));
      fd.append("material", material);

      const res  = await fetch(`${API_BASE}/slice`, { method: "POST", body: fd });
      const data = await res.json();

      if (!res.ok || !data.ok) throw new Error(data.error || "Slicing failed");
      setQuoteResult(data);
    } catch (e) {
      setQuoteError(e.message || "Slicing failed.");
    }

    setQuoting(false);
  }, [file, preset, infill, supports, material]);

  // Drop handler — ignore non-3MF silently via loadPreview's own guard
  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) loadPreview(f);
  }, [loadPreview]);

  const onInput = useCallback((e) => {
    const f = e.target.files[0];
    if (f) loadPreview(f);
    // reset input so same file can be re-selected
    e.target.value = "";
  }, [loadPreview]);

  const resetCam = useCallback(() => {
    const m = meshRef.current;
    if (m) {
      const bb   = new THREE.Box3().setFromObject(m);
      const size = new THREE.Vector3();
      bb.getSize(size);
      const dist = Math.max(size.x, size.y, size.z) * 2.2;
      cameraRef.current?.position.set(dist * 0.7, dist * 0.6, dist);
      ctrlRef.current?.target.set(0, size.y * 0.3, 0);
    } else {
      cameraRef.current?.position.set(300, 220, 400);
      ctrlRef.current?.target.set(0, 0, 0);
    }
    ctrlRef.current?.update();
  }, []);

  const secLabel = {
    fontFamily: mono,
    fontSize: 8,
    letterSpacing: "0.18em",
    color: "#2a2a2a",
    textTransform: "uppercase",
    marginBottom: 8,
    display: "block",
  };

  const price = quoteResult?.price;
  const slice = quoteResult?.slice;

  return (
    <div style={{ fontFamily: cond, background: "#0a0a0b", color: "#ccc", height: "100dvh", display: "flex", flexDirection: "column", overflow: "hidden" }}>

      {/* ── Header ── */}
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 20px", height: 50, flexShrink: 0, background: "#0c0c0e", borderBottom: "1px solid #18181b", zIndex: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 28, height: 28, background: LIME, borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="#0a0a0b"><path d="M7 1L13 4.5V10.5L7 14L1 10.5V4.5L7 1Z" /></svg>
          </div>
          <div>
            <div style={{ fontFamily: cond, fontWeight: 800, fontSize: 16, letterSpacing: "0.1em", color: "#fff", lineHeight: 1 }}>PRINT QUOTE</div>
            <div style={{ fontFamily: mono, fontSize: 7, letterSpacing: "0.2em", color: "#2a2a2a", marginTop: 1 }}>CREALITY K2 PLUS · 3D PRINT ESTIMATOR</div>
          </div>

          {file && (
            <>
              <div style={{ width: 1, height: 22, background: "#1e1e22", margin: "0 6px" }} />
              <span style={{ fontFamily: mono, fontSize: 9, color: "#444", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.name}</span>
              {modelSize && (
                <span style={{ fontFamily: mono, fontSize: 8, color: "#2a2a2a" }}>
                  {modelSize.x}×{modelSize.y}×{modelSize.z}mm
                </span>
              )}
            </>
          )}
        </div>

        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {file && (
            <>
              {["solid", "wire", "xray"].map((m) => (
                <button key={m} className="btn" onClick={() => setViewMode(m)}
                  style={{ padding: "3px 9px", fontFamily: mono, fontSize: 7, letterSpacing: "0.12em", textTransform: "uppercase", background: viewMode === m ? `${LIME}18` : "transparent", border: viewMode === m ? `1px solid ${LIME}55` : "1px solid #1a1a1e", borderRadius: 4, color: viewMode === m ? LIME : "#333" }}>
                  {m}
                </button>
              ))}
              <button className="btn" onClick={resetCam}
                style={{ padding: "3px 9px", fontFamily: mono, fontSize: 11, background: "transparent", border: "1px solid #1a1a1e", borderRadius: 4, color: "#333" }}>
                ⟳
              </button>
            </>
          )}

          <label className="btn" style={{ padding: "6px 16px", fontFamily: mono, fontSize: 8, letterSpacing: "0.14em", background: `${LIME}18`, border: `1px solid ${LIME}44`, borderRadius: 5, color: LIME, cursor: "pointer", fontWeight: 700 }}>
            + UPLOAD .3MF
            <input type="file" accept=".3mf" onChange={onInput} style={{ display: "none" }} />
          </label>
        </div>
      </header>

      <div style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>

        {/* ── Left panel ── */}
        <div style={{ width: 220, background: "#0c0c0e", borderRight: "1px solid #18181b", overflowY: "auto", flexShrink: 0, padding: "16px 13px" }}>

          <div style={{ marginBottom: 18 }}>
            <span style={secLabel}>Printer</span>
            <div style={{ background: "#111113", border: `1px solid ${LIME}33`, borderRadius: 6, padding: "8px 10px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontFamily: mono, fontSize: 10, color: LIME, fontWeight: 700 }}>Creality K2 Plus</span>
              <span style={{ fontFamily: mono, fontSize: 7, color: "#333" }}>0.4 nozzle</span>
            </div>
            <div style={{ marginTop: 5, fontFamily: mono, fontSize: 8, color: "#2a2a2a", lineHeight: 1.8 }}>Bed: 260×260×260 mm</div>
          </div>

          <div style={{ marginBottom: 18 }}>
            <span style={secLabel}>Material</span>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
              {MATERIALS.map((m) => (
                <button key={m} className="btn" onClick={() => setMaterial(m)}
                  style={{ padding: "6px 4px", fontFamily: cond, fontSize: 13, fontWeight: 600, letterSpacing: "0.05em", background: material === m ? `${LIME}18` : "#111113", border: material === m ? `1px solid ${LIME}55` : "1px solid #1e1e22", borderRadius: 5, color: material === m ? LIME : "#444" }}>
                  {m}
                </button>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: 18 }}>
            <span style={secLabel}>Quality</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {Object.entries(QUALITY_PRESETS).map(([k, p]) => (
                <button key={k} className="btn" onClick={() => setQuality(k)}
                  style={{ padding: "7px 10px", display: "flex", justifyContent: "space-between", alignItems: "center", fontFamily: cond, fontSize: 13, fontWeight: quality === k ? 700 : 400, background: quality === k ? `${LIME}14` : "#111113", border: quality === k ? `1px solid ${LIME}44` : "1px solid #1e1e22", borderRadius: 6, color: quality === k ? LIME : "#555" }}>
                  <span>{p.label}</span>
                  <span style={{ fontFamily: mono, fontSize: 8, color: quality === k ? `${LIME}77` : "#2a2a2a" }}>{p.layerHeight}mm</span>
                </button>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
              <span style={{ ...secLabel, marginBottom: 0 }}>Infill</span>
              <span style={{ fontFamily: cond, fontWeight: 800, fontSize: 20, color: LIME, lineHeight: 1 }}>{infill}%</span>
            </div>
            <input type="range" min="5" max="100" step="5" value={infill} onChange={(e) => setInfill(+e.target.value)}
              style={{ width: "100%", accentColor: LIME, background: `linear-gradient(to right,${LIME}88 0%,${LIME}88 ${((infill-5)/95)*100}%,#1e1e22 ${((infill-5)/95)*100}%,#1e1e22 100%)` }} />
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
              {[5, 15, 25, 50, 100].map((v) => (
                <button key={v} className="btn" onClick={() => setInfill(v)}
                  style={{ padding: "2px 4px", fontFamily: mono, fontSize: 7, background: infill === v ? `${LIME}18` : "transparent", border: `1px solid ${infill === v ? LIME+"33" : "#1a1a1e"}`, borderRadius: 3, color: infill === v ? LIME : "#2a2a2a" }}>
                  {v}%
                </button>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: 20 }}>
            <span style={secLabel}>Supports</span>
            <button className="btn" onClick={() => setSupports((p) => !p)}
              style={{ width: "100%", padding: "9px 12px", fontFamily: cond, fontSize: 14, fontWeight: 600, background: supports ? `${CYAN}10` : "#111113", border: supports ? `1px solid ${CYAN}44` : "1px solid #1e1e22", borderRadius: 6, color: supports ? CYAN : "#444", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span>{supports ? "Supports Enabled" : "Supports Disabled"}</span>
              <span style={{ fontFamily: mono, fontSize: 9 }}>{supports ? "◆" : "◇"}</span>
            </button>
            <div style={{ marginTop: 5, fontFamily: mono, fontSize: 7, color: "#222", lineHeight: 1.8 }}>
              {supports ? "Use 3MF supports if present, otherwise Tree(auto)" : "Supports turned off"}
            </div>
          </div>

          <button className="btn" onClick={getQuote} disabled={!file || quoting}
            style={{ width: "100%", padding: "13px 0", fontFamily: cond, fontWeight: 800, fontSize: 16, letterSpacing: "0.1em", background: !file ? "#111" : quoting ? `${LIME}33` : LIME, border: "none", borderRadius: 8, color: !file ? "#333" : quoting ? LIME : "#0a0a0b", cursor: !file ? "not-allowed" : "pointer" }}>
            {quoting ? "SLICING…" : file ? "GET QUOTE →" : "UPLOAD .3MF FIRST"}
          </button>
        </div>

        {/* ── Viewport ── */}
        <div style={{ flex: 1, position: "relative", minHeight: 0 }}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}>

          <div ref={canvasRef} style={{ position: "absolute", inset: 0 }} />

          {file && (
            <div style={{ position: "absolute", bottom: 12, right: 14, fontFamily: mono, fontSize: 7, color: "#1e1e22", lineHeight: 2, textAlign: "right", zIndex: 5, pointerEvents: "none" }}>
              DRAG · rotate | RIGHT · pan | SCROLL · zoom
            </div>
          )}

          {dragging && (
            <div style={{ position: "absolute", inset: 0, background: `${LIME}04`, border: `2px dashed ${LIME}66`, zIndex: 20, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontFamily: cond, fontWeight: 900, fontSize: 22, color: LIME, letterSpacing: "0.15em" }}>DROP YOUR MODEL</div>
                <div style={{ fontFamily: mono, fontSize: 8, color: `${LIME}55`, marginTop: 6 }}>.3MF ONLY</div>
              </div>
            </div>
          )}

          {previewing && (
            <div style={{ position: "absolute", inset: 0, background: "rgba(10,10,11,.92)", zIndex: 30, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 18 }}>
              <div style={{ width: 40, height: 40, border: `3px solid #1a1a1e`, borderTop: `3px solid ${LIME}`, borderRadius: "50%", animation: "spin .7s linear infinite" }} />
              <div style={{ fontFamily: mono, fontSize: 9, color: LIME, letterSpacing: "0.2em" }}>LOADING MODEL…</div>
            </div>
          )}

          {!file && !previewing && (
            <label className="drop-zone" style={{ position: "absolute", inset: 32, borderRadius: 12, border: "1px dashed #1a1a1e", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 24, cursor: "pointer", zIndex: 5 }}>
              <input type="file" accept=".3mf" onChange={onInput} style={{ display: "none" }} />
              <div style={{ width: 80, height: 80, border: "1px solid #1a1a1e", borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center", background: "#0d0d0f" }}>
                <svg width="38" height="38" viewBox="0 0 38 38" fill="none">
                  <path d="M19 3L35 12V26L19 35L3 26V12L19 3Z" stroke={LIME} strokeWidth="1" strokeOpacity=".3" fill="none" />
                  <path d="M19 3V35M3 12L19 21L35 12M19 21V35M19 21L4 24.5M19 21L34 24.5" stroke={LIME} strokeWidth=".6" strokeOpacity=".15" />
                </svg>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontFamily: cond, fontWeight: 700, fontSize: 18, color: "#444", letterSpacing: "0.06em" }}>Upload Your 3MF File</div>
                <div style={{ fontFamily: mono, fontSize: 8, color: "#2a2a2a", marginTop: 8 }}>Drag & drop or click to browse</div>
                <div style={{ fontFamily: mono, fontSize: 7, color: "#1e1e22", marginTop: 4 }}>Only .3mf files accepted</div>
              </div>
            </label>
          )}

          {previewErr && (
            <div className="fade-in" style={{ position: "absolute", bottom: 20, left: "50%", transform: "translateX(-50%)", background: "#130a0b", border: `1px solid ${RED}55`, borderRadius: 7, padding: "9px 18px", fontFamily: mono, fontSize: 9, color: RED, zIndex: 40, display: "flex", gap: 12, alignItems: "center", whiteSpace: "nowrap" }}>
              ⚠ {previewErr}
              <span onClick={() => setPreviewErr(null)} style={{ cursor: "pointer", opacity: 0.5 }}>✕</span>
            </div>
          )}
        </div>

        {/* ── Right panel ── */}
        <div style={{ width: 280, background: "#0c0c0e", borderLeft: "1px solid #18181b", display: "flex", flexDirection: "column", flexShrink: 0, overflowY: "auto" }}>
          {quoteResult ? (
            <div className="slide-in" style={{ padding: "18px 16px" }}>
              <div style={{ background: "#111113", border: `1px solid ${LIME}33`, borderRadius: 10, padding: "18px 16px", marginBottom: 16, textAlign: "center", animation: "bpulse 2.5s ease infinite" }}>
                <div style={{ fontFamily: mono, fontSize: 8, letterSpacing: "0.2em", color: "#333", marginBottom: 8 }}>TOTAL PRICE</div>
                <div className="count-up" style={{ fontFamily: cond, fontWeight: 900, fontSize: 52, color: LIME, lineHeight: 1, letterSpacing: "-0.02em" }}>
                  ${price?.finalPrice?.toFixed(2)}
                </div>
                <div style={{ fontFamily: mono, fontSize: 8, color: "#2a2a2a", marginTop: 6 }}>{price?.markup}× markup applied</div>
              </div>

              <div style={{ marginBottom: 16 }}>
                <span style={secLabel}>Cost Breakdown</span>
                <BRow label="Filament" detail={price?.breakdown?.filament} value={`$${price?.filamentCost?.toFixed(2)}`} color={LIME} pct={price ? (price.filamentCost / price.baseCost) * 100 : 0} />
                <BRow label="Machine Time" detail={price?.breakdown?.machine} value={`$${price?.machineCost?.toFixed(2)}`} color={CYAN} pct={price ? (price.machineCost / price.baseCost) * 100 : 0} />
                <div style={{ height: 1, background: "#18181b", margin: "10px 0" }} />
                <SRow label="Base cost" value={`$${price?.baseCost?.toFixed(2)}`} />
                <SRow label={`${price?.markup}× markup`} value={`→ $${price?.finalPrice?.toFixed(2)}`} accent={LIME} />
              </div>

              <div style={{ marginBottom: 16 }}>
                <span style={secLabel}>Slicer Results</span>
                <SRow label="Print Time" value={slice?.printTime} accent={LIME} />
                <SRow label="Model" value={`${((slice?.weightG || 0) - (slice?.supportWeightG || 0)).toFixed(1)}g`} />
                {slice?.supportWeightG > 0 && (
                  <>
                    <SRow label="Supports" value={`+${(+slice.supportWeightG).toFixed(1)}g`} accent={CYAN} />
                    <div style={{ height: 1, background: "#18181b", margin: "4px 0" }} />
                  </>
                )}
                <SRow label="Total" value={`${slice?.weightG?.toFixed(1)}g`} accent={LIME} />
                {slice?.filamentM && <SRow label="Length" value={`${slice.filamentM}m`} />}
              </div>

              <div style={{ marginBottom: 14 }}>
                <span style={secLabel}>Sliced With</span>
                <SRow label="Printer" value="Creality K2 Plus" accent={LIME} />
                <SRow label="Material" value={material} />
                <SRow label="Layer" value={`${preset.layerHeight}mm`} />
                <SRow label="Infill" value={`${infill}%`} />
                <SRow label="Support Mode" value={supports ? (quoteResult?.mfSupports?.enabled ? quoteResult.mfSupports.type || "3MF config" : "Tree(auto)") : "Off"} accent={supports ? CYAN : undefined} />
              </div>

              <button className="btn" onClick={() => setQuoteResult(null)}
                style={{ width: "100%", padding: "8px", fontFamily: mono, fontSize: 8, letterSpacing: "0.12em", background: "transparent", border: "1px solid #1a1a1e", borderRadius: 6, color: "#333" }}>
                ← CHANGE SETTINGS
              </button>
            </div>
          ) : quoteError ? (
            <div style={{ padding: 20 }} className="fade-in">
              <div style={{ padding: "14px", background: "#130a0b", border: `1px solid ${RED}44`, borderRadius: 8 }}>
                <div style={{ fontFamily: mono, fontSize: 9, color: RED }}>⚠ Slicing failed</div>
                <div style={{ fontFamily: mono, fontSize: 8, color: "#444", marginTop: 6, lineHeight: 1.9, wordBreak: "break-word" }}>{quoteError}</div>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 16, padding: 24 }}>
              <div style={{ fontSize: 34, opacity: 0.04 }}>◆</div>
              <div style={{ fontFamily: mono, fontSize: 8, color: "#2a2a2a", textAlign: "center", lineHeight: 2.2, letterSpacing: "0.1em" }}>
                {file ? "CONFIGURE SETTINGS\nAND CLICK GET QUOTE" : "UPLOAD A .3MF FILE\nTO GET STARTED"}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function BRow({ label, detail, value, color, pct }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 3 }}>
        <div>
          <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 9, color: "#555" }}>{label}</span>
          {detail && <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 7, color: "#2a2a2a", marginLeft: 6 }}>{detail}</span>}
        </div>
        <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 11, color, fontWeight: 700 }}>{value}</span>
      </div>
      <div style={{ height: 2, background: "#18181b", borderRadius: 1, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 1, transition: "width .8s ease" }} />
      </div>
    </div>
  );
}

function SRow({ label, value, accent }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 0", borderBottom: "1px solid #111113" }}>
      <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 8, color: "#2a2a2a", letterSpacing: "0.06em" }}>{label}</span>
      <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, color: accent || "#666", fontWeight: 600 }}>{value}</span>
    </div>
  );
}