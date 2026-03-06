import { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";

// ── STL Parser ────────────────────────────────────────────────────────────────
function parseSTL(buffer) {
  const isBinary = checkBinary(buffer);
  if (isBinary) return parseBinarySTL(buffer);
  return parseASCIISTL(buffer);
}

function checkBinary(buffer) {
  const header = new Uint8Array(buffer, 0, 80);
  const numTriangles = new DataView(buffer).getUint32(80, true);
  const expected = 84 + numTriangles * 50;
  if (expected === buffer.byteLength) return true;
  const str = String.fromCharCode(...new Uint8Array(buffer, 0, Math.min(256, buffer.byteLength)));
  return !str.includes("solid");
}

function parseBinarySTL(buffer) {
  const view = new DataView(buffer);
  const numTriangles = view.getUint32(80, true);
  const positions = new Float32Array(numTriangles * 9);
  const normals = new Float32Array(numTriangles * 9);
  let offset = 84;
  for (let i = 0; i < numTriangles; i++) {
    const nx = view.getFloat32(offset, true); offset += 4;
    const ny = view.getFloat32(offset, true); offset += 4;
    const nz = view.getFloat32(offset, true); offset += 4;
    for (let v = 0; v < 3; v++) {
      const base = i * 9 + v * 3;
      positions[base]     = view.getFloat32(offset, true); offset += 4;
      positions[base + 1] = view.getFloat32(offset, true); offset += 4;
      positions[base + 2] = view.getFloat32(offset, true); offset += 4;
      normals[base] = nx; normals[base + 1] = ny; normals[base + 2] = nz;
    }
    offset += 2;
  }
  return { positions, normals, triangleCount: numTriangles };
}

function parseASCIISTL(buffer) {
  const text = new TextDecoder().decode(buffer);
  const positions = []; const normals = [];
  const normalRe = /facet normal\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)/g;
  const vertexRe = /vertex\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)/g;
  let nMatch, vMatches = [];
  const allNormals = []; const allVertices = [];
  let nm; while ((nm = normalRe.exec(text)) !== null) allNormals.push([+nm[1], +nm[2], +nm[3]]);
  let vm; while ((vm = vertexRe.exec(text)) !== null) allVertices.push([+vm[1], +vm[2], +vm[3]]);
  const triCount = Math.min(allNormals.length, Math.floor(allVertices.length / 3));
  const posArr = new Float32Array(triCount * 9);
  const normArr = new Float32Array(triCount * 9);
  for (let i = 0; i < triCount; i++) {
    const [nx, ny, nz] = allNormals[i] || [0, 0, 1];
    for (let v = 0; v < 3; v++) {
      const vi = i * 3 + v; const base = i * 9 + v * 3;
      posArr[base]     = allVertices[vi]?.[0] ?? 0;
      posArr[base + 1] = allVertices[vi]?.[1] ?? 0;
      posArr[base + 2] = allVertices[vi]?.[2] ?? 0;
      normArr[base] = nx; normArr[base + 1] = ny; normArr[base + 2] = nz;
    }
  }
  return { positions: posArr, normals: normArr, triangleCount: triCount };
}

function buildGeometry({ positions, normals }) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("normal",   new THREE.BufferAttribute(normals, 3));
  geo.computeBoundingBox();
  return geo;
}

function computeVolume(positions) {
  let vol = 0;
  for (let i = 0; i < positions.length; i += 9) {
    const ax = positions[i], ay = positions[i+1], az = positions[i+2];
    const bx = positions[i+3], by = positions[i+4], bz = positions[i+5];
    const cx = positions[i+6], cy = positions[i+7], cz = positions[i+8];
    vol += (ax*(by*cz - bz*cy) + bx*(cy*az - cz*ay) + cx*(ay*bz - az*by)) / 6;
  }
  return Math.abs(vol);
}

// ── STL Serializer (for export) ───────────────────────────────────────────────
function serializeSTL(geometry) {
  const pos = geometry.attributes.position;
  const count = pos.count;
  const triCount = count / 3;
  const buf = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buf);
  const enc = new TextEncoder();
  const header = enc.encode("STL exported by PrintLab Slicer".padEnd(80, " "));
  new Uint8Array(buf, 0, 80).set(header.subarray(0, 80));
  view.setUint32(80, triCount, true);
  let offset = 84;
  for (let i = 0; i < triCount; i++) {
    const ax = pos.getX(i*3), ay = pos.getY(i*3), az = pos.getZ(i*3);
    const bx = pos.getX(i*3+1), by = pos.getY(i*3+1), bz = pos.getZ(i*3+1);
    const cx = pos.getX(i*3+2), cy = pos.getY(i*3+2), cz = pos.getZ(i*3+2);
    const ux = bx-ax, uy = by-ay, uz = bz-az;
    const vx = cx-ax, vy = cy-ay, vz = cz-az;
    const nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
    const len = Math.sqrt(nx*nx+ny*ny+nz*nz) || 1;
    view.setFloat32(offset, nx/len, true); offset+=4;
    view.setFloat32(offset, ny/len, true); offset+=4;
    view.setFloat32(offset, nz/len, true); offset+=4;
    for (const [x,y,z] of [[ax,ay,az],[bx,by,bz],[cx,cy,cz]]) {
      view.setFloat32(offset, x, true); offset+=4;
      view.setFloat32(offset, y, true); offset+=4;
      view.setFloat32(offset, z, true); offset+=4;
    }
    view.setUint16(offset, 0, true); offset+=2;
  }
  return buf;
}

// ── Format helpers ─────────────────────────────────────────────────────────────
const fmtMM = v => v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : v.toFixed(0);
const fmtVol = v => v >= 1e6 ? `${(v/1e6).toFixed(2)} cm³` : `${v.toFixed(0)} mm³`;
const fmtW = g => g >= 1000 ? `${(g/1000).toFixed(2)} kg` : `${g.toFixed(1)} g`;
const fmtTime = m => { const h = Math.floor(m/60), mn = Math.round(m%60); return h > 0 ? `${h}h ${mn}m` : `${mn}m`; };

// ── Main Component ────────────────────────────────────────────────────────────
export default function STLSlicer() {
  const canvasRef   = useRef(null);
  const rendererRef = useRef(null);
  const cameraRef   = useRef(null);
  const sceneRef    = useRef(null);
  const ctrlRef     = useRef(null);
  const animRef     = useRef(null);
  const meshRef     = useRef(null);
  const geoRef      = useRef(null);
  const fileRef     = useRef(null);

  const [file, setFile]       = useState(null);
  const [stats, setStats]     = useState(null);
  const [dragging, setDrag]   = useState(false);
  const [loading, setLoading] = useState(false);
  const [viewMode, setView]   = useState("solid"); // solid | wire | xray
  const [error, setError]     = useState(null);

  // ── Scene init ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0d13);
    sceneRef.current = scene;

    // Grid
    const grid = new THREE.GridHelper(300, 30, 0x1a2a3a, 0x0f1c28);
    grid.position.y = -0.5;
    scene.add(grid);

    // Lights
    scene.add(new THREE.AmbientLight(0x334455, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(60, 80, 40); scene.add(sun);
    const fill = new THREE.DirectionalLight(0x4488cc, 0.5);
    fill.position.set(-40, 20, -30); scene.add(fill);
    const rim = new THREE.DirectionalLight(0x00ffcc, 0.3);
    rim.position.set(0, -30, -50); scene.add(rim);

    const w = el.clientWidth, h = el.clientHeight;
    const camera = new THREE.PerspectiveCamera(45, w/h, 0.01, 10000);
    camera.position.set(80, 60, 120);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h);
    renderer.shadowMap.enabled = true;
    el.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    import("three/examples/jsm/controls/OrbitControls").then(({ OrbitControls }) => {
      const ctrl = new OrbitControls(camera, renderer.domElement);
      ctrl.enableDamping = true; ctrl.dampingFactor = 0.07;
      ctrl.minDistance = 5; ctrl.maxDistance = 2000;
      ctrlRef.current = ctrl;
    });

    let last = 0;
    const tick = t => {
      animRef.current = requestAnimationFrame(tick);
      if (t - last < 14) return; last = t;
      ctrlRef.current?.update();
      renderer.render(scene, camera);
    };
    tick(0);

    const onResize = () => {
      const w = el.clientWidth, h = el.clientHeight;
      camera.aspect = w/h; camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(animRef.current);
      ctrlRef.current?.dispose();
      renderer.dispose(); renderer.domElement.remove();
    };
  }, []);

  // ── Load STL ─────────────────────────────────────────────────────────────────
  const loadSTL = useCallback(async (f) => {
    setLoading(true); setError(null);
    try {
      const buf = await f.arrayBuffer();
      const parsed = parseSTL(buf);
      const geo = buildGeometry(parsed);
      geo.computeBoundingBox();
      const bb = geo.boundingBox;
      const center = new THREE.Vector3();
      bb.getCenter(center);
      geo.translate(-center.x, -center.y, -bb.min.z);
      geo.computeBoundingBox();
      const size = new THREE.Vector3();
      geo.boundingBox.getSize(size);

      if (meshRef.current) {
        sceneRef.current.remove(meshRef.current);
        geoRef.current?.dispose();
        meshRef.current.material?.dispose();
      }

      const mat = new THREE.MeshPhongMaterial({
        color: 0x00d4ff, specular: 0x224466, shininess: 60,
        transparent: false, opacity: 1, side: THREE.DoubleSide
      });
      const mesh = new THREE.Mesh(geo, mat);
      sceneRef.current.add(mesh);
      meshRef.current = mesh;
      geoRef.current = geo;

      // Camera fit
      const maxDim = Math.max(size.x, size.y, size.z);
      const dist = maxDim * 2.2;
      if (cameraRef.current) {
        cameraRef.current.position.set(dist * 0.7, dist * 0.6, dist);
        cameraRef.current.near = maxDim * 0.001;
        cameraRef.current.far  = maxDim * 100;
        cameraRef.current.updateProjectionMatrix();
      }
      if (ctrlRef.current) {
        ctrlRef.current.target.set(0, size.z * 0.4, 0);
        ctrlRef.current.update();
      }

      const vol = computeVolume(parsed.positions);
      const weightPLA = (vol / 1000) * 1.24;
      const filLen = vol / (Math.PI * Math.pow(1.75/2, 2));
      const printM = (vol / 220) + 3;

      setStats({
        name: f.name,
        size: f.size,
        triangles: parsed.triangleCount,
        w: fmtMM(size.x), h: fmtMM(size.y), d: fmtMM(size.z),
        volume: fmtVol(vol),
        weight: fmtW(weightPLA),
        filament: `${(filLen / 1000).toFixed(2)} m`,
        printTime: fmtTime(printM),
        rawVol: vol,
      });
      setFile(f);
      fileRef.current = f;
    } catch (e) {
      console.error(e); setError("Failed to parse STL. Make sure it's a valid binary or ASCII STL file.");
    }
    setLoading(false);
  }, []);

  // ── View mode update ─────────────────────────────────────────────────────────
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const mat = mesh.material;
    if (viewMode === "solid") {
      mat.wireframe = false; mat.transparent = false; mat.opacity = 1;
      mat.color.set(0x00d4ff);
    } else if (viewMode === "wire") {
      mat.wireframe = true; mat.transparent = false; mat.opacity = 1;
      mat.color.set(0x00ff88);
    } else if (viewMode === "xray") {
      mat.wireframe = false; mat.transparent = true; mat.opacity = 0.22;
      mat.color.set(0x44aaff);
    }
    mat.needsUpdate = true;
  }, [viewMode]);

  // ── Drag & drop ──────────────────────────────────────────────────────────────
  const onDrop = useCallback((e) => {
    e.preventDefault(); setDrag(false);
    const f = e.dataTransfer.files[0];
    if (f && f.name.toLowerCase().endsWith(".stl")) loadSTL(f);
    else setError("Please drop an .STL file.");
  }, [loadSTL]);

  const onFileInput = useCallback((e) => {
    const f = e.target.files[0];
    if (f) loadSTL(f);
  }, [loadSTL]);

  // ── Export ───────────────────────────────────────────────────────────────────
  const doExport = useCallback(() => {
    const geo = geoRef.current;
    if (!geo) return;
    const buf = serializeSTL(geo);
    const name = (fileRef.current?.name || "model").replace(/\.stl$/i, "") + "_exported.stl";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([buf], { type: "model/stl" }));
    a.download = name; a.click(); URL.revokeObjectURL(a.href);
  }, []);

  const resetCamera = useCallback(() => {
    if (!cameraRef.current || !ctrlRef.current) return;
    cameraRef.current.position.set(80, 60, 120);
    ctrlRef.current.target.set(0, 0, 0);
    ctrlRef.current.update();
  }, []);

  // ── Styles ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    const id = "stl-slicer-styles";
    if (document.getElementById(id)) return;
    const s = document.createElement("style");
    s.id = id;
    s.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&display=swap');
      *, *::before, *::after { box-sizing: border-box; }
      html, body, #root { margin: 0; padding: 0; height: 100%; overflow: hidden; background: #06090f; }
      .stl-btn { transition: all 0.18s; cursor: pointer; font-family: 'JetBrains Mono', monospace; }
      .stl-btn:hover { filter: brightness(1.15); transform: translateY(-1px); }
      .stl-btn:active { transform: translateY(0); }
      .view-btn { transition: all 0.15s; cursor: pointer; }
      .view-btn:hover { background: rgba(0,212,255,0.15) !important; }
      .drop-zone-idle { border: 2px dashed #1a3040; }
      .drop-zone-idle:hover { border-color: #00d4ff44; background: rgba(0,212,255,0.03); }
      .drop-zone-active { border: 2px dashed #00d4ff !important; background: rgba(0,212,255,0.06) !important; }
      @keyframes spin { to { transform: rotate(360deg); } }
      @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
      @keyframes scanline {
        0% { transform: translateY(-100%); }
        100% { transform: translateY(400%); }
      }
      .stat-row { animation: fadeIn 0.3s ease both; }
      ::-webkit-scrollbar { width: 3px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: #1a3040; border-radius: 2px; }
    `;
    document.head.appendChild(s);
  }, []);

  const ACCENT = "#00d4ff";
  const GREEN  = "#00ff88";

  return (
    <div style={{ fontFamily: "'Space Grotesk', sans-serif", background: "#06090f", color: "#c8dde8", height: "100dvh", width: "100vw", display: "flex", flexDirection: "column", overflow: "hidden" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px", borderBottom: "1px solid #0d1e2a", background: "#06090fdd", backdropFilter: "blur(10px)", flexShrink: 0, zIndex: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 28, height: 28, background: `linear-gradient(135deg, ${ACCENT}, #0066ff)`, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>◈</div>
          <div>
            <div style={{ fontFamily: "'JetBrains Mono'", fontWeight: 700, fontSize: 13, letterSpacing: "0.12em", color: "#fff" }}>PRINTLAB</div>
            <div style={{ fontSize: 9, letterSpacing: "0.2em", color: "#3a6070", marginTop: -1 }}>STL SLICER · BETA</div>
          </div>
          <div style={{ width: 1, height: 28, background: "#0d1e2a", margin: "0 4px" }} />
          <button className="stl-btn"
            onClick={() => window.location.href = '/'}
            style={{ padding: "5px 12px", fontSize: 10, letterSpacing: "0.1em", fontFamily: "'JetBrains Mono'", textTransform: "uppercase", background: "transparent", border: "1px solid #0d1e2a", borderRadius: 6, color: "#3a6070" }}>
            ← Keychain
          </button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {file && (
            <>
              {/* View mode */}
              {["solid","wire","xray"].map(m => (
                <button key={m} className="view-btn stl-btn"
                  onClick={() => setView(m)}
                  style={{
                    padding: "5px 12px", fontSize: 10, letterSpacing: "0.1em",
                    fontFamily: "'JetBrains Mono'", textTransform: "uppercase",
                    background: viewMode === m ? "rgba(0,212,255,0.15)" : "transparent",
                    border: viewMode === m ? `1px solid ${ACCENT}44` : "1px solid #0d1e2a",
                    borderRadius: 6, color: viewMode === m ? ACCENT : "#3a6070",
                  }}>{m}</button>
              ))}
              <div style={{ width: 1, height: 20, background: "#0d1e2a", margin: "0 4px" }} />
              <button className="stl-btn"
                onClick={doExport}
                style={{ padding: "6px 16px", fontSize: 10, letterSpacing: "0.12em", fontFamily: "'JetBrains Mono'", textTransform: "uppercase", background: `linear-gradient(135deg, ${ACCENT}22, #0044ff22)`, border: `1px solid ${ACCENT}55`, borderRadius: 6, color: ACCENT, fontWeight: 600 }}>
                ↓ Export STL
              </button>
              <button className="stl-btn"
                onClick={resetCamera}
                style={{ padding: "6px 10px", fontSize: 10, fontFamily: "'JetBrains Mono'", background: "transparent", border: "1px solid #0d1e2a", borderRadius: 6, color: "#3a6070" }}>
                ⟳
              </button>
            </>
          )}
          <label className="stl-btn" style={{ padding: "6px 16px", fontSize: 10, letterSpacing: "0.12em", fontFamily: "'JetBrains Mono'", textTransform: "uppercase", background: "#0d1e2a", border: "1px solid #1a3040", borderRadius: 6, color: "#7aafbf", cursor: "pointer", fontWeight: 500 }}>
            + Import STL
            <input type="file" accept=".stl" onChange={onFileInput} style={{ display: "none" }} />
          </label>
        </div>
      </div>

      {/* Main layout */}
      <div style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>

        {/* Sidebar */}
        {stats ? (
          <div style={{ width: 240, background: "#060c13", borderRight: "1px solid #0d1e2a", overflowY: "auto", flexShrink: 0, padding: "16px 0" }}>
            {/* File info */}
            <div style={{ padding: "0 16px 14px", borderBottom: "1px solid #0d1e2a" }}>
              <div style={{ fontSize: 9, letterSpacing: "0.18em", color: "#2a4a5a", textTransform: "uppercase", marginBottom: 6 }}>File</div>
              <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 11, color: ACCENT, wordBreak: "break-all", lineHeight: 1.4 }}>{stats.name}</div>
              <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, color: "#3a6070", marginTop: 4 }}>{(stats.size / 1024).toFixed(1)} KB</div>
            </div>

            {/* Dimensions */}
            <Section label="Dimensions">
              <StatRow label="Width"  val={`${stats.w} mm`} accent={ACCENT} />
              <StatRow label="Depth"  val={`${stats.h} mm`} accent={ACCENT} />
              <StatRow label="Height" val={`${stats.d} mm`} accent={ACCENT} />
            </Section>

            {/* Model stats */}
            <Section label="Model">
              <StatRow label="Triangles" val={stats.triangles.toLocaleString()} />
              <StatRow label="Volume"    val={stats.volume} />
            </Section>

            {/* Print estimate */}
            <Section label="Print Estimate · PLA">
              <div style={{ fontSize: 9, color: "#1a3040", marginBottom: 8, fontFamily: "'JetBrains Mono'" }}>1.75mm filament · 20% infill</div>
              <StatRow label="Weight"   val={stats.weight}   accent={GREEN} />
              <StatRow label="Filament" val={stats.filament} accent={GREEN} />
              <StatRow label="Time est." val={stats.printTime} accent={GREEN} />
            </Section>

            {/* Coming soon */}
            <div style={{ margin: "14px 16px 0", padding: "12px", background: "rgba(0,212,255,0.04)", border: "1px solid #0d2030", borderRadius: 8 }}>
              <div style={{ fontSize: 9, letterSpacing: "0.15em", color: ACCENT + "66", textTransform: "uppercase", marginBottom: 6 }}>Coming Soon</div>
              <div style={{ fontSize: 10, color: "#2a4a5a", lineHeight: 1.6, fontFamily: "'JetBrains Mono'" }}>
                💰 Print pricing<br/>
                🔪 Slice preview<br/>
                📐 Auto-orient<br/>
                🛡 Wall thickness
              </div>
            </div>
          </div>
        ) : (
          <div style={{ width: 240, background: "#060c13", borderRight: "1px solid #0d1e2a", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, flexShrink: 0, padding: 20 }}>
            <div style={{ fontSize: 28, opacity: 0.15 }}>◈</div>
            <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, color: "#1a3040", textAlign: "center", lineHeight: 1.7, letterSpacing: "0.06em" }}>
              Import an STL file<br/>to see model stats
            </div>
          </div>
        )}

        {/* Viewport */}
        <div style={{ flex: 1, position: "relative", minHeight: 0, overflow: "hidden" }}
          onDragOver={e => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}>

          {/* Three.js canvas mount */}
          <div ref={canvasRef} style={{ position: "absolute", inset: 0 }} />

          {/* Scanline overlay */}
          <div style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden", zIndex: 1 }}>
            <div style={{ position: "absolute", left: 0, right: 0, height: "25%", background: "linear-gradient(180deg, transparent, rgba(0,212,255,0.015), transparent)", animation: "scanline 6s linear infinite", zIndex: 1 }} />
          </div>

          {/* Corner decorations */}
          {[["0","0","top","left"],["0","auto","top","right"],["auto","0","bottom","left"],["auto","auto","bottom","right"]].map(([t,b,tt,ll], i) => (
            <div key={i} style={{ position: "absolute", [tt]: 16, [ll]: 16, width: 18, height: 18, zIndex: 2, pointerEvents: "none",
              borderTop: tt === "top" ? `1.5px solid ${ACCENT}44` : "none",
              borderBottom: tt === "bottom" ? `1.5px solid ${ACCENT}44` : "none",
              borderLeft: ll === "left" ? `1.5px solid ${ACCENT}44` : "none",
              borderRight: ll === "right" ? `1.5px solid ${ACCENT}44` : "none",
            }} />
          ))}

          {/* Drop overlay */}
          {dragging && (
            <div style={{ position: "absolute", inset: 0, background: "rgba(0,212,255,0.06)", border: `2px dashed ${ACCENT}`, borderRadius: 2, zIndex: 20, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
              <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 14, letterSpacing: "0.2em", color: ACCENT }}>DROP STL FILE</div>
            </div>
          )}

          {/* Loading overlay */}
          {loading && (
            <div style={{ position: "absolute", inset: 0, background: "rgba(6,9,15,0.8)", zIndex: 30, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
              <div style={{ width: 36, height: 36, border: `3px solid #0d1e2a`, borderTop: `3px solid ${ACCENT}`, borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
              <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 11, letterSpacing: "0.2em", color: ACCENT }}>PARSING STL…</div>
            </div>
          )}

          {/* Empty state */}
          {!file && !loading && (
            <label className="drop-zone-idle"
              style={{ position: "absolute", inset: 40, borderRadius: 12, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, cursor: "pointer", transition: "all 0.2s", zIndex: 5 }}>
              <input type="file" accept=".stl" onChange={onFileInput} style={{ display: "none" }} />
              <div style={{ width: 72, height: 72, border: `1.5px solid #1a3040`, borderRadius: 16, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 32, color: "#1a3040" }}>◈</div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 13, letterSpacing: "0.15em", color: "#2a4a5a", textTransform: "uppercase" }}>Drop STL file here</div>
                <div style={{ fontSize: 11, color: "#1a3040", marginTop: 6, letterSpacing: "0.06em" }}>or click to browse · binary &amp; ASCII supported</div>
              </div>
            </label>
          )}

          {/* Error */}
          {error && (
            <div style={{ position: "absolute", bottom: 20, left: "50%", transform: "translateX(-50%)", background: "#1a0810", border: "1px solid #ff4466", borderRadius: 8, padding: "10px 20px", fontFamily: "'JetBrains Mono'", fontSize: 11, color: "#ff6688", zIndex: 40, whiteSpace: "nowrap" }}>
              ⚠ {error}
              <span onClick={() => setError(null)} style={{ marginLeft: 16, cursor: "pointer", opacity: 0.5, fontWeight: 700 }}>✕</span>
            </div>
          )}

          {/* Controls hint */}
          {file && (
            <div style={{ position: "absolute", bottom: 14, right: 16, fontFamily: "'JetBrains Mono'", fontSize: 9, color: "#1a3040", letterSpacing: "0.1em", textAlign: "right", lineHeight: 1.8, zIndex: 5, pointerEvents: "none" }}>
              LEFT DRAG · rotate<br/>RIGHT DRAG · pan<br/>SCROLL · zoom
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────
function Section({ label, children }) {
  return (
    <div style={{ padding: "12px 16px", borderBottom: "1px solid #0d1e2a" }}>
      <div style={{ fontSize: 9, letterSpacing: "0.18em", color: "#2a4a5a", textTransform: "uppercase", marginBottom: 8 }}>{label}</div>
      {children}
    </div>
  );
}

function StatRow({ label, val, accent }) {
  return (
    <div className="stat-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 5 }}>
      <span style={{ fontSize: 10, color: "#2a5060", fontFamily: "'JetBrains Mono'" }}>{label}</span>
      <span style={{ fontSize: 11, color: accent || "#7aafbf", fontFamily: "'JetBrains Mono'", fontWeight: 600 }}>{val}</span>
    </div>
  );
}