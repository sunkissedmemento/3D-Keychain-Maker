import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import * as THREE from "three";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter";
import { mergeGeometries, mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils";
import opentype from "opentype.js";
import ClipperLib from "clipper-lib";

const DEFAULTS = {
  name: "Name",
  font: "Bhineka:style=Regular",
  textCapHeight: 20,
  textHeight: 3.0,
  borderHeight: 2.0,
  borderOffset: 3.0,
  gap: 0,
  tabDiameter: 8.0,
  holeDiameter: 4.0,
  tabYOffset: 0.0,
  borderColor: "#f9a8d4",
  textColor: "#c084fc",
};

const FONT_URLS = {
  "Pacifico:style=Regular": "/fonts/Pacifico-Regular.ttf",
  "Lobster:style=Regular": "/fonts/Lobster-Regular.ttf",
  "Titan One:style=Regular": "/fonts/TitanOne-Regular.ttf",
  "Luckiest Guy:style=Regular": "/fonts/LuckiestGuy-Regular.ttf",
  "Bhineka:style=Regular": "/fonts/Bhineka-Regular.ttf",
  "Pheonies:style=Regular": "/fonts/Pheonies.otf",
};

const STORAGE_KEY = "keychain_colors_v1";
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

async function readSavedColors() {
  try {
    const r = await window.storage.get(STORAGE_KEY);
    if (!r) return null;
    const p = JSON.parse(r.value);
    return {
      borderColor: HEX_RE.test(p?.borderColor) ? p.borderColor : null,
      textColor: HEX_RE.test(p?.textColor) ? p.textColor : null,
    };
  } catch { return null; }
}

async function persistColors(bc, tc) {
  try { await window.storage.set(STORAGE_KEY, JSON.stringify({ borderColor: bc, textColor: tc })); } catch {}
}

const LIGHT = {
  bg: "#fdf6f0", surface: "#ffffff", border: "#f0e6df", text: "#5c3d6b",
  muted: "#b89ec4", accent: "#f472b6", accent2: "#c084fc", trackBg: "#f5e6f0",
  pill: "#fce7f3", pillText: "#e879a0", inputBg: "#fff8fc", inputBorder: "#edd5f0",
  sceneBg: 0xe8d5f0, shadow: "#f9a8d428", shadow2: "#c084fc18",
  blob1: "#fce7f338", blob2: "#e9d5ff38",
};
const DARK = {
  bg: "#16101f", surface: "#201530", border: "#2e1f42", text: "#ead6f8",
  muted: "#7a5a9a", accent: "#f472b6", accent2: "#c084fc", trackBg: "#2e1d3a",
  pill: "#3a1f52", pillText: "#e879f9", inputBg: "#1a1028", inputBorder: "#3a2050",
  sceneBg: 0x1a0f2e, shadow: "#f9a8d418", shadow2: "#c084fc14",
  blob1: "#f472b612", blob2: "#c084fc12",
};

// ── Clipper helpers ──────────────────────────────────────────────────────────
const SCALE = 1000;
const toCP = p => p.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }));
const fromCP = p => p.map(v => [v.X / SCALE, v.Y / SCALE]);

function offsetUnion(paths, delta) {
  const co = new ClipperLib.ClipperOffset(2, 0.75 * SCALE);
  co.AddPaths(paths.map(toCP), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const off = new ClipperLib.Paths();
  co.Execute(off, delta * SCALE);
  const c = new ClipperLib.Clipper();
  c.AddPaths(off, ClipperLib.PolyType.ptSubject, true);
  const sol = new ClipperLib.Paths();
  c.Execute(ClipperLib.ClipType.ctUnion, sol, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return sol.map(fromCP);
}

// ── Geometry helpers ─────────────────────────────────────────────────────────

// SVG/font coords have Y pointing DOWN. THREE.ExtrudeGeometry expects Y pointing UP.
// Instead of scaling after extrusion (which breaks winding), we negate Y in the
// shape points BEFORE extrusion. This keeps winding correct from the start.
function svgShapesToThreeShapes(svgPaths) {
  const shapes = [];
  for (const path of svgPaths) {
    // toShapes(true) = isCCW hint for SVG
    const pathShapes = path.toShapes(true);
    for (const shape of pathShapes) {
      // Negate Y on all points in the outer contour
      for (const pt of shape.getPoints()) {
        pt.y = -pt.y;
      }
      // Rebuild shape with negated Y
      const pts = shape.getPoints().map(p => new THREE.Vector2(p.x, -p.y));
      const newShape = new THREE.Shape(pts);
      // Also negate holes
      for (const hole of shape.holes) {
        const holePts = hole.getPoints().map(p => new THREE.Vector2(p.x, -p.y));
        newShape.holes.push(new THREE.Path(holePts));
      }
      shapes.push(newShape);
    }
  }
  return shapes;
}

// Rebuild shapes from flat 2D contours (for the border/base offset path).
// Clipper returns polys in screen coords (Y-down), so we negate Y here too.
function signedArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    a += poly[i][0] * poly[j][1];
    a -= poly[j][0] * poly[i][1];
  }
  return a / 2;
}

// Convert clipper output polygons to THREE.Shape.
// Clipper normlises winding: positive area = outer, negative = hole.
// We negate Y (screen→3D) which also flips winding, so we re-check after.
function clipperPolysToShapes(polys) {
  // Separate outers (positive area in screen space) from holes.
  const outers = [];
  const holes  = [];
  for (const poly of polys) {
    if (poly.length < 3) continue;
    const area = signedArea(poly); // screen space (Y-down)
    // negate Y for 3D space
    const pts3d = poly.map(([x, y]) => new THREE.Vector2(x, -y));
    if (area > 0) outers.push(pts3d); // outer in screen = positive
    else           holes.push(pts3d);
  }
  return outers.map(outerPts => {
    const shape = new THREE.Shape(outerPts);
    // Attach any hole whose first point is inside this outer (simple heuristic)
    for (const holePts of holes) {
      shape.holes.push(new THREE.Path(holePts));
    }
    return shape;
  });
}

function makeTabGeo(tabR, holeR, h, segs = 48) {
  const s = new THREE.Shape();
  s.absarc(0, 0, tabR, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, holeR, 0, Math.PI * 2, true);
  s.holes.push(hole);
  return new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: false, curveSegments: segs });
}

// ── 3MF writer (ZIP-packaged, slicer-compatible) ─────────────────────────────

// Minimal pure-JS ZIP builder (PKZIP local file + central directory, no compression)
function buildZip(files) {
  // files: Array of { name: string, data: Uint8Array }
  const enc = new TextEncoder();
  const toU8 = s => (typeof s === "string" ? enc.encode(s) : s);

  function u16(n) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b; }
  function u32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; }

  function crc32(data) {
    let c = 0xFFFFFFFF;
    const table = crc32.table || (crc32.table = (() => {
      const t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let v = i;
        for (let j = 0; j < 8; j++) v = (v & 1) ? (0xEDB88320 ^ (v >>> 1)) : (v >>> 1);
        t[i] = v;
      }
      return t;
    })());
    for (let i = 0; i < data.length; i++) c = table[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function concat(...arrays) {
    const total = arrays.reduce((s, a) => s + a.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const a of arrays) { out.set(a, off); off += a.length; }
    return out;
  }

  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const file of files) {
    const name = enc.encode(file.name);
    const data = toU8(file.data);
    const crc  = crc32(data);
    const dosDate = 0x5765; // 2023-11-05 approx
    const dosTime = 0x0000;

    // Local file header
    const local = concat(
      new Uint8Array([0x50,0x4B,0x03,0x04]), // signature
      u16(20),        // version needed
      u16(0),         // flags
      u16(0),         // compression (stored)
      u16(dosTime), u16(dosDate),
      u32(crc),
      u32(data.length), u32(data.length), // compressed = uncompressed
      u16(name.length), u16(0),           // filename len, extra len
      name, data
    );

    // Central directory header
    const central = concat(
      new Uint8Array([0x50,0x4B,0x01,0x02]), // signature
      u16(20), u16(20),   // version made by, version needed
      u16(0), u16(0),     // flags, compression
      u16(dosTime), u16(dosDate),
      u32(crc),
      u32(data.length), u32(data.length),
      u16(name.length), u16(0), u16(0), // filename, extra, comment lengths
      u16(0), u16(0),     // disk number start, internal attrs
      u32(0),             // external attrs
      u32(offset),        // relative offset of local header
      name
    );

    localHeaders.push(local);
    centralHeaders.push(central);
    offset += local.length;
  }

  const cdOffset = offset;
  const cdSize   = centralHeaders.reduce((s, h) => s + h.length, 0);

  // End of central directory
  const eocd = concat(
    new Uint8Array([0x50,0x4B,0x05,0x06]), // signature
    u16(0), u16(0),                         // disk number, disk with CD
    u16(files.length), u16(files.length),   // entries this disk, total entries
    u32(cdSize), u32(cdOffset),
    u16(0)                                   // comment length
  );

  return concat(...localHeaders, ...centralHeaders, eocd);
}

function build3MFZip(baseGeo, tabGeo, textGeo, borderHex, textHex) {
  const bFlat  = baseGeo.toNonIndexed();
  const tbFlat = tabGeo.toNonIndexed();
  const txFlat = textGeo.toNonIndexed();
  const bPos   = bFlat.attributes.position;
  const tbPos  = tbFlat.attributes.position;
  const txPos  = txFlat.attributes.position;

  const norm = hex => "#" + hex.replace(/^#/, "").toUpperCase().padStart(6, "0");

  function buildMeshXML(posArr, count, colorIdx, indent) {
    const v = [], t = [];
    for (let i = 0; i < count; i++)
      v.push(`${indent}  <vertex x="${posArr[i*3].toFixed(6)}" y="${posArr[i*3+1].toFixed(6)}" z="${posArr[i*3+2].toFixed(6)}" />`);
    for (let i = 0; i < count; i += 3)
      t.push(`${indent}  <triangle v1="${i}" v2="${i+1}" v3="${i+2}" pid="1" p1="${colorIdx}" p2="${colorIdx}" p3="${colorIdx}" />`);
    return `${indent}<vertices>\n${v.join("\n")}\n${indent}</vertices>\n${indent}<triangles>\n${t.join("\n")}\n${indent}</triangles>`;
  }

  // Object 2 = base+tab mesh (color index 0 = border)
  // Object 3 = text mesh    (color index 1 = text)
  // Object 4 = assembly referencing both via <components> → shows as 1 obj, 2 parts in Bambu
  // m:colorgroup face colors are read per-triangle on import (Bambu Studio v2.5+)
  const baseMesh = buildMeshXML(
    new Float32Array([...bPos.array, ...tbPos.array]),
    bPos.count + tbPos.count, 0, "        "
  );
  const textMesh = buildMeshXML(txPos.array, txPos.count, 1, "        ");

  bFlat.dispose(); tbFlat.dispose(); txFlat.dispose();

  const modelXML = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US"
  xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
  xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
  <resources>
    <m:colorgroup id="1">
      <m:color color="${norm(borderHex)}" />
      <m:color color="${norm(textHex)}" />
    </m:colorgroup>
    <object id="2" name="base_tab" type="model">
      <mesh>
${baseMesh}
      </mesh>
    </object>
    <object id="3" name="text" type="model">
      <mesh>
${textMesh}
      </mesh>
    </object>
    <object id="4" name="keychain" type="model">
      <components>
        <component objectid="2" />
        <component objectid="3" />
      </components>
    </object>
  </resources>
  <build>
    <item objectid="4" />
  </build>
</model>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />
</Relationships>`;

  return buildZip([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels",         data: rels },
    { name: "3D/3dmodel.model",    data: modelXML },
  ]);
}

// ── React helpers ────────────────────────────────────────────────────────────
function useDebounce(v, d) {
  const [dv, setDv] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setDv(v), d);
    return () => clearTimeout(t);
  }, [v, d]);
  return dv;
}

function ResetBtn({ onClick, C }) {
  const [hov, setHov] = useState(false);
  return (
    <button onClick={onClick} onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      title="Reset to default"
      style={{ background: hov ? C.pill : "none", border: "none", borderRadius: "50%", width: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: 11, color: hov ? C.accent : C.muted, transition: "all 0.15s", padding: 0, flexShrink: 0 }}>↺</button>
  );
}

function FieldLabel({ children, dirty, onReset, C }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 5 }}>
      <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: C.muted }}>{children}</span>
      {dirty && <ResetBtn onClick={onReset} C={C} />}
    </div>
  );
}

function SliderRow({ label, value, min, max, step = 1, unit = "mm", onChange, defaultValue, C }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef(null);
  const dirty = value !== defaultValue;
  const bipolar = min < 0 && max > 0;
  const zeroPct = (-min / (max - min)) * 100;
  const valPct = ((value - min) / (max - min)) * 100;
  const fillLeft = bipolar ? Math.min(zeroPct, valPct) : 0;
  const fillWidth = bipolar ? Math.abs(valPct - zeroPct) : valPct;

  function startEdit() { setDraft(String(value)); setEditing(true); setTimeout(() => inputRef.current?.select(), 0); }
  function commitEdit() {
    const parsed = parseFloat(draft);
    if (!isNaN(parsed)) {
      const snapped = Math.round(parsed / step) * step;
      onChange(Math.min(max, Math.max(min, parseFloat(snapped.toFixed(10)))));
    }
    setEditing(false);
  }
  function onKeyDown(e) {
    if (e.key === "Enter") { e.preventDefault(); commitEdit(); }
    if (e.key === "Escape") { setEditing(false); }
  }

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: C.muted }}>{label}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {editing ? (
            <input ref={inputRef} value={draft} onChange={e => setDraft(e.target.value)} onBlur={commitEdit} onKeyDown={onKeyDown}
              style={{ width: 62, fontSize: 12, fontFamily: "'DM Mono',monospace", color: C.pillText, background: C.pill, border: "none", borderRadius: 20, padding: "2px 8px", outline: "none", textAlign: "right" }} />
          ) : (
            <span onClick={startEdit} style={{ fontSize: 12, fontFamily: "'DM Mono',monospace", color: C.pillText, background: C.pill, borderRadius: 20, padding: "2px 8px", cursor: "text", userSelect: "none" }}>
              {bipolar && value > 0 ? `+${value}` : value}{unit}
            </span>
          )}
          {dirty && !editing && <ResetBtn onClick={() => onChange(defaultValue)} C={C} />}
        </div>
      </div>
      <div style={{ position: "relative", height: 18, display: "flex", alignItems: "center" }}>
        <div style={{ position: "absolute", left: 0, right: 0, height: 4, background: C.trackBg, borderRadius: 2, overflow: "hidden" }}>
          <div style={{ position: "absolute", left: `${fillLeft}%`, width: `${fillWidth}%`, height: "100%", background: `linear-gradient(90deg,${C.accent},${C.accent2})`, borderRadius: 2 }} />
          {bipolar && <div style={{ position: "absolute", left: `${zeroPct}%`, top: 0, bottom: 0, width: 2, background: C.muted, transform: "translateX(-50%)", borderRadius: 1 }} />}
        </div>
        <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(+e.target.value)}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, cursor: "pointer", margin: 0 }} />
      </div>
    </div>
  );
}

function SectionHeader({ label, C }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "16px 0 10px" }}>
      <div style={{ flex: 1, height: 1, background: C.border }} />
      <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: C.muted }}>{label}</span>
      <div style={{ flex: 1, height: 1, background: C.border }} />
    </div>
  );
}

function ColorRow({ label, value, defaultValue, onChange, C, tooltip }) {
  const dirty = value !== defaultValue;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
      <div style={{ flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 3 }}>
          <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: C.muted }}>{label}</span>
          {tooltip && <div title={tooltip} style={{ fontSize: 9, color: C.muted, cursor: "help" }}>ⓘ</div>}
        </div>
        <span style={{ fontSize: 11, fontFamily: "'DM Mono',monospace", color: C.pillText }}>{value.toUpperCase()}</span>
      </div>
      {dirty && <ResetBtn onClick={() => onChange(defaultValue)} C={C} />}
      <div style={{ position: "relative", width: 44, height: 44, borderRadius: 10, overflow: "hidden", border: `2px solid ${C.border}`, flexShrink: 0, background: value, boxShadow: `0 2px 8px ${C.shadow}` }}>
        <input type="color" value={value} onChange={e => onChange(e.target.value)}
          style={{ position: "absolute", inset: "-6px", width: "calc(100% + 12px)", height: "calc(100% + 12px)", opacity: 0, cursor: "pointer" }} />
      </div>
    </div>
  );
}

function ExportModal({ defaultName, format, onConfirm, onCancel, C }) {
  const [val, setVal] = useState(defaultName);
  const ref = useRef();
  useEffect(() => { setTimeout(() => ref.current?.select(), 50); }, []);
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(6px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999 }}>
      <div style={{ background: C.surface, borderRadius: 18, padding: "28px 24px 22px", width: 340, boxShadow: "0 20px 60px rgba(0,0,0,0.35)", border: `1.5px solid ${C.border}` }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 6 }}>Name your {format} export</div>
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 16, lineHeight: 1.5 }}>
          {format === "3MF" ? <>Single <code>.3mf</code> file — includes geometry and per-object colors.</> : "Your file will be saved with this name."}
        </div>
        <input ref={ref} value={val} onChange={e => setVal(e.target.value.replace(/[^a-zA-Z0-9 _-]/g, ""))}
          onKeyDown={e => { if (e.key === "Enter" && val.trim()) onConfirm(val.trim()); if (e.key === "Escape") onCancel(); }}
          maxLength={48}
          style={{ width: "100%", padding: "10px 13px", background: C.inputBg, border: "none", borderRadius: 11, color: C.text, fontSize: 14, fontFamily: "inherit", outline: "none", marginBottom: 18 }} />
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onCancel} style={{ flex: 1, padding: "10px 0", borderRadius: 11, border: `1.5px solid ${C.border}`, background: "none", color: C.muted, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
          <button onClick={() => val.trim() && onConfirm(val.trim())} disabled={!val.trim()}
            style={{ flex: 2, padding: "10px 0", borderRadius: 11, border: "none", background: `linear-gradient(135deg,${C.accent},${C.accent2})`, color: "#fff", fontSize: 13, fontWeight: 700, cursor: val.trim() ? "pointer" : "not-allowed", fontFamily: "inherit", opacity: val.trim() ? 1 : 0.5, boxShadow: `0 4px 16px ${C.shadow}` }}>
            Download {format}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [darkMode, setDarkMode] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const h = e => setDarkMode(e.matches);
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, []);
  const C = darkMode ? DARK : LIGHT;

  const [name,         setName]         = useState(DEFAULTS.name);
  const [font,         setFont]         = useState(DEFAULTS.font);
  const [textCapHeight,setTextCapHeight]= useState(DEFAULTS.textCapHeight);
  const [textHeight,   setTextHeight]   = useState(DEFAULTS.textHeight);
  const [borderHeight, setBorderHeight] = useState(DEFAULTS.borderHeight);
  const [borderOffset, setBorderOffset] = useState(DEFAULTS.borderOffset);
  const [gap,          setGap]          = useState(DEFAULTS.gap);
  const [tabDiameter,  setTabDiameter]  = useState(DEFAULTS.tabDiameter);
  const [holeDiameter, setHoleDiameter] = useState(DEFAULTS.holeDiameter);
  const [tabYOffset,   setTabYOffset]   = useState(DEFAULTS.tabYOffset);
  const [borderColor,  setBorderColor]  = useState(DEFAULTS.borderColor);
  const [textColor,    setTextColor]    = useState(DEFAULTS.textColor);
  const colorsLoadedRef = useRef(false);
  const [fontsReady, setFontsReady] = useState(false);
  const [status,     setStatus]     = useState("loading");
  const [exporting,  setExporting]  = useState(false);
  const [exportModal,setExportModal]= useState(null);

  useEffect(() => {
    readSavedColors().then(s => {
      if (s?.borderColor) setBorderColor(s.borderColor);
      if (s?.textColor)   setTextColor(s.textColor);
      colorsLoadedRef.current = true;
    });
  }, []);
  useEffect(() => { if (colorsLoadedRef.current) persistColors(borderColor, textColor); }, [borderColor, textColor]);

  const dName         = useDebounce(name,         200);
  const dTextCapHeight= useDebounce(textCapHeight, 80);
  const dTextHeight   = useDebounce(textHeight,    80);
  const dBorderHeight = useDebounce(borderHeight,  80);
  const dBorderOffset = useDebounce(borderOffset,  80);
  const dGap          = useDebounce(gap,           80);
  const dTabD         = useDebounce(tabDiameter,   80);
  const dHoleD        = useDebounce(holeDiameter,  80);
  const dTabY         = useDebounce(tabYOffset,    80);

  const safeName      = useMemo(() => dName.replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 20), [dName]);
  const suggestedName = `${safeName}_${font.split(":")[0]}`;

  const anyDirty = useMemo(() => {
    const v = { name, font, textCapHeight, textHeight, borderHeight, borderOffset, gap, tabDiameter, holeDiameter, tabYOffset, borderColor, textColor };
    return Object.keys(DEFAULTS).some(k => v[k] !== DEFAULTS[k]);
  }, [name, font, textCapHeight, textHeight, borderHeight, borderOffset, gap, tabDiameter, holeDiameter, tabYOffset, borderColor, textColor]);

  const resetAll = useCallback(() => {
    setName(DEFAULTS.name); setFont(DEFAULTS.font); setTextCapHeight(DEFAULTS.textCapHeight);
    setTextHeight(DEFAULTS.textHeight); setBorderHeight(DEFAULTS.borderHeight);
    setBorderOffset(DEFAULTS.borderOffset); setGap(DEFAULTS.gap);
    setTabDiameter(DEFAULTS.tabDiameter); setHoleDiameter(DEFAULTS.holeDiameter);
    setTabYOffset(DEFAULTS.tabYOffset); setBorderColor(DEFAULTS.borderColor); setTextColor(DEFAULTS.textColor);
  }, []);

  const canvasRef    = useRef(null);
  const cameraRef    = useRef(null);
  const rendererRef  = useRef(null);
  const controlsRef  = useRef(null);
  const animRef      = useRef(null);
  const groupRef     = useRef(null);
  const sceneRef     = useRef(null);
  const fontCacheRef = useRef({});
  const exportGeoRef = useRef({ base: null, tab: null, text: null });
  const meshRef      = useRef({ base: null, tab: null, text: null });

  useEffect(() => {
    if (sceneRef.current) sceneRef.current.background.set(C.sceneBg);
  }, [darkMode, C.sceneBg]);

  // Three.js scene init
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(LIGHT.sceneBg);
    sceneRef.current = scene;
    const camera = new THREE.PerspectiveCamera(50, el.clientWidth / el.clientHeight, 0.1, 5000);
    camera.position.set(0, 0, 140);
    cameraRef.current = camera;
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(el.clientWidth, el.clientHeight);
    el.appendChild(renderer.domElement);
    rendererRef.current = renderer;
    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const d = new THREE.DirectionalLight(0xffffff, 0.8); d.position.set(20, 30, 25); scene.add(d);
    const f = new THREE.DirectionalLight(0xffccee, 0.4); f.position.set(-20, -10, 10); scene.add(f);
    import("three/examples/jsm/controls/OrbitControls").then(({ OrbitControls }) => {
      const ctrl = new OrbitControls(camera, renderer.domElement);
      ctrl.enableDamping = true; ctrl.dampingFactor = 0.08; controlsRef.current = ctrl;
    });
    const g = new THREE.Group(); scene.add(g); groupRef.current = g;
    let last = 0;
    const tick = t => {
      animRef.current = requestAnimationFrame(tick);
      if (document.hidden || t - last < 14) return;
      last = t; controlsRef.current?.update(); renderer.render(scene, camera);
    };
    tick(0);
    const onResize = () => {
      const w = el.clientWidth, h = el.clientHeight;
      camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(animRef.current);
      controlsRef.current?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  // Font loading
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        for (const k of Object.keys(FONT_URLS)) {
          const r = await fetch(FONT_URLS[k]);
          if (!r.ok) throw new Error("Font 404");
          fontCacheRef.current[k] = opentype.parse(await r.arrayBuffer());
          if (!alive) return;
        }
        if (alive) { setFontsReady(true); setStatus("ready"); }
      } catch (e) { console.error(e); setStatus("error"); }
    })();
    return () => { alive = false; };
  }, []);

  const clearGroup = useCallback(() => {
    const g = groupRef.current;
    if (!g) return;
    while (g.children.length) {
      const o = g.children.pop();
      o?.traverse?.(c => { if (c.isMesh) { c.geometry?.dispose(); c.material?.dispose(); } });
    }
  }, []);

  // ── Main geometry build ──────────────────────────────────────────────────
  useEffect(() => {
    if (!fontsReady || !safeName || !groupRef.current) return;
    const otFont = fontCacheRef.current[font];
    if (!otFont) return;
    setStatus("building");
    clearGroup();
    const tid = setTimeout(() => {
      try {
        // ── Step 1: measure cap height to get correct font scale ──
        const probePath  = otFont.getPath(safeName, 0, 0, dTextCapHeight).toPathData(2);
        const probeData  = new SVGLoader().parse(`<svg><path d="${probePath}"/></svg>`);
        const probeShapes = probeData.paths.flatMap(p => p.toShapes(true));
        let fontSize = dTextCapHeight;
        if (probeShapes.length) {
          const probeGeo = new THREE.ExtrudeGeometry(probeShapes, { depth: 1, bevelEnabled: false });
          probeGeo.computeBoundingBox();
          const measuredH = probeGeo.boundingBox.max.y - probeGeo.boundingBox.min.y;
          probeGeo.dispose();
          if (measuredH > 0) fontSize = dTextCapHeight * (dTextCapHeight / measuredH);
        }

        // ── Step 2: get SVG path at calibrated font size ──
        const svgPath = otFont.getPath(safeName, 0, 0, fontSize).toPathData(2);
        const svgData = new SVGLoader().parse(`<svg><path d="${svgPath}"/></svg>`);

        // ── Step 3: build text geometry ──
        // Key fix: negate Y in shape points BEFORE extrusion so winding stays correct.
        // This avoids the scale(1,-1,1) hack that was breaking face normals.
        const textShapes = svgShapesToThreeShapes(svgData.paths);
        if (!textShapes.length) return;

        const textGeo = new THREE.ExtrudeGeometry(textShapes, {
          depth: dTextHeight, bevelEnabled: false, curveSegments: 8
        });
        textGeo.computeBoundingBox();
        const tb = textGeo.boundingBox;
        textGeo.translate(-(tb.max.x + tb.min.x) / 2, -(tb.max.y + tb.min.y) / 2, 0);

        // ── Step 4: build base geometry ──
        // Extract all sub-path contours from SVG (in screen/Y-down space)
        const rawContours = svgData.paths.flatMap(p =>
          p.subPaths.map(sp => sp.getPoints(48).map(pt => [pt.x, pt.y])).filter(c => c.length >= 3)
        );
        const offsetPolys = offsetUnion(rawContours, dBorderOffset);
        const baseShapes  = clipperPolysToShapes(offsetPolys);

        const baseGeo = new THREE.ExtrudeGeometry(baseShapes, {
          depth: dBorderHeight, bevelEnabled: false, curveSegments: 10
        });
        baseGeo.computeBoundingBox();
        const bb = baseGeo.boundingBox;
        baseGeo.translate(-(bb.max.x + bb.min.x) / 2, -(bb.max.y + bb.min.y) / 2, 0);
        baseGeo.computeBoundingBox();
        const baseB = baseGeo.boundingBox;

        // ── Step 5: tab ──
        const tabGeo = makeTabGeo(dTabD / 2, dHoleD / 2, dBorderHeight, 40);
        tabGeo.translate(baseB.min.x - dGap - dTabD / 2, dTabY, 0);

        // ── Step 6: add to scene ──
        clearGroup();
        const baseMat = new THREE.MeshPhongMaterial({ color: borderColor, shininess: 80, side: THREE.DoubleSide });
        const textMat = new THREE.MeshPhongMaterial({ color: textColor,   shininess: 100, side: THREE.DoubleSide });
        const baseMesh = new THREE.Mesh(baseGeo, baseMat);
        const tabMesh  = new THREE.Mesh(tabGeo,  baseMat);
        const textMesh = new THREE.Mesh(textGeo, textMat);
        textMesh.position.z = dBorderHeight;
        groupRef.current.add(baseMesh, tabMesh, textMesh);
        meshRef.current = { base: baseMesh, tab: tabMesh, text: textMesh };

        Object.values(exportGeoRef.current).forEach(g => g?.dispose());
        exportGeoRef.current = { base: baseGeo.clone(), tab: tabGeo.clone(), text: textGeo.clone() };

        const span = Math.max(baseB.max.x - baseB.min.x + dTabD + dGap + 30, baseB.max.y - baseB.min.y + 40);
        if (cameraRef.current)  cameraRef.current.position.set(0, 0, span * 1.2);
        if (controlsRef.current){ controlsRef.current.target.set(0, 0, dBorderHeight / 2); controlsRef.current.update(); }
        setStatus("ready");
      } catch (e) { console.error(e); setStatus("error"); }
    }, 0);
    return () => clearTimeout(tid);
  }, [fontsReady, safeName, font, dTextCapHeight, dTextHeight, dBorderHeight, dBorderOffset, dGap, dTabD, dHoleD, dTabY, borderColor, textColor, clearGroup]);

  // Live color update (no rebuild needed)
  useEffect(() => {
    const { base, tab, text } = meshRef.current;
    if (base) base.material.color.set(borderColor);
    if (tab)  tab.material.color.set(borderColor);
    if (text) text.material.color.set(textColor);
  }, [borderColor, textColor]);

  // ── STL export ───────────────────────────────────────────────────────────
  const doExportSTL = useCallback((filename) => {
    const { base, tab, text } = exportGeoRef.current;
    if (!base || !tab || !text) return;
    const tClone = text.clone(); tClone.translate(0, 0, borderHeight);
    const merged = mergeGeometries([base.clone(), tab.clone(), tClone], false);
    if (!merged) return;
    const stl = new STLExporter().parse(new THREE.Mesh(merged, new THREE.MeshNormalMaterial()), { binary: false });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([stl], { type: "model/stl" }));
    a.download = `${filename}.stl`; a.click(); URL.revokeObjectURL(a.href);
    merged.dispose(); tClone.dispose();
  }, [borderHeight]);

  // ── 3MF export (ZIP-packaged) ────────────────────────────────────────────
  const doExport3MF = useCallback((filename) => {
    const { base, tab, text } = exportGeoRef.current;
    if (!base || !tab || !text) return;
    const tClone = text.clone(); tClone.translate(0, 0, borderHeight);
    const zipBytes = build3MFZip(base, tab, tClone, borderColor, textColor);
    tClone.dispose();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([zipBytes], { type: "application/zip" }));
    a.download = `${filename}.3mf`; a.click(); URL.revokeObjectURL(a.href);
  }, [borderHeight, borderColor, textColor]);

  const resetCamera = useCallback(() => {
    if (!cameraRef.current || !controlsRef.current) return;
    cameraRef.current.position.set(0, 0, 140);
    controlsRef.current.target.set(0, 0, 0);
    controlsRef.current.update();
  }, []);

  // Global styles
  useEffect(() => {
    const id = "kc-v4";
    if (document.getElementById(id)) return;
    const s = document.createElement("style");
    s.id = id;
    s.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&family=DM+Mono&display=swap');
      *, *::before, *::after { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; overflow: hidden; height: 100%; background: transparent; border: none; }
      #root { height: 100%; overflow: hidden; }
      input[type=range]{-webkit-appearance:none;appearance:none;background:transparent;}
      input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:15px;height:15px;border-radius:50%;background:white;border:2px solid #f472b6;box-shadow:0 1px 4px #f472b660;cursor:pointer;transition:transform 0.12s;}
      input[type=range]::-webkit-slider-thumb:hover{transform:scale(1.25);}
      input[type=range]::-moz-range-thumb{width:15px;height:15px;border-radius:50%;background:white;border:2px solid #f472b6;cursor:pointer;}
      input[type=range]:focus{outline:none;}
      select{-webkit-appearance:none;appearance:none;}
      ::-webkit-scrollbar{width:3px;}::-webkit-scrollbar-track{background:transparent;}::-webkit-scrollbar-thumb{background:rgba(196,132,252,0.35);border-radius:3px;}
      @keyframes kc-pulse{0%,100%{opacity:1}50%{opacity:0.4}}
    `;
    document.head.appendChild(s);
  }, []);

  const isBuilding  = status === "building" || status === "loading";
  const statusColor = status === "ready" ? "#86efac" : status === "error" ? "#fca5a5" : "#fcd34d";
  const statusLabel = status === "ready" ? "Ready" : status === "error" ? "Error" : status === "building" ? "Rebuilding…" : "Loading fonts…";

  const inp = {
    width: "100%", padding: "9px 12px", background: C.inputBg, border: "none",
    borderRadius: 12, color: C.text, fontFamily: "'Montserrat',sans-serif",
    fontSize: 13, outline: "none", transition: "border-color 0.2s",
  };

  return (
    <div style={{ fontFamily: "'Montserrat',sans-serif", background: C.bg, color: C.text, height: "100dvh", width: "100vw", overflow: "hidden", margin: 0, padding: 0, display: "flex", flexDirection: "column", position: "relative" }}>
      <div style={{ position: "absolute", top: -80, left: -60, width: 340, height: 340, borderRadius: "50%", background: C.blob1, filter: "blur(60px)", pointerEvents: "none", zIndex: 0 }} />
      <div style={{ position: "absolute", bottom: -60, right: -40, width: 280, height: 280, borderRadius: "50%", background: C.blob2, filter: "blur(50px)", pointerEvents: "none", zIndex: 0 }} />

      <div style={{ position: "relative", zIndex: 1, padding: "14px 24px 10px", borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
        <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.01em", background: `linear-gradient(135deg,${C.accent},${C.accent2})`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
          Keychain Generator
        </div>
        <div style={{ fontSize: 11, color: C.muted, marginTop: 1 }}>Design, preview &amp; export in 3D</div>
      </div>

      <div style={{ position: "relative", zIndex: 1, display: "grid", gridTemplateColumns: "300px 1fr", flex: 1, minHeight: 0, overflow: "hidden" }}>

        {/* Controls */}
        <div style={{ background: C.surface, borderRight: `1px solid ${C.border}`, overflowY: "auto", overflowX: "hidden", padding: "16px 18px" }}>
          <FieldLabel dirty={name !== DEFAULTS.name} onReset={() => setName(DEFAULTS.name)} C={C}>Name</FieldLabel>
          <input value={name} onChange={e => setName(e.target.value)} maxLength={20} placeholder="Your name…"
            onFocus={e => e.target.style.borderColor = C.accent} onBlur={e => e.target.style.borderColor = C.inputBorder}
            style={{ ...inp, marginBottom: 4 }} />
          <div style={{ fontSize: 10, color: C.muted, textAlign: "right", marginBottom: 10 }}>{name.length}/20</div>

          <FieldLabel dirty={font !== DEFAULTS.font} onReset={() => setFont(DEFAULTS.font)} C={C}>Font</FieldLabel>
          <div style={{ position: "relative", marginBottom: 16 }}>
            <select value={font} onChange={e => setFont(e.target.value)} style={{ ...inp, cursor: "pointer", paddingRight: 32 }}>
              <option value="Pacifico:style=Regular">Pacifico</option>
              <option value="Lobster:style=Regular">Lobster</option>
              <option value="Titan One:style=Regular">Titan One</option>
              <option value="Luckiest Guy:style=Regular">Luckiest Guy</option>
              <option value="Bhineka:style=Regular">Bhineka</option>
              <option value="Pheonies:style=Regular">Pheonies</option>
            </select>
            <span style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none", fontSize: 10, color: C.muted }}>▾</span>
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: C.muted }}>Theme</div>
              <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>follows system by default</div>
            </div>
            <button onClick={() => setDarkMode(d => !d)} title={darkMode ? "Switch to light" : "Switch to dark"}
              style={{ width: 42, height: 24, borderRadius: 20, border: "none", cursor: "pointer", background: darkMode ? `linear-gradient(90deg,${C.accent},${C.accent2})` : "#f0e6df", position: "relative", transition: "background 0.3s", padding: 0, flexShrink: 0 }}>
              <span style={{ position: "absolute", top: "50%", left: darkMode ? "calc(100% - 20px)" : 4, transform: "translateY(-50%)", fontSize: 12, transition: "left 0.2s" }}>{darkMode ? "🌙" : "☀️"}</span>
            </button>
          </div>

          <SectionHeader label="Text" C={C} />
          <SliderRow label="Cap Height"    value={textCapHeight} min={8}   max={60} step={0.5} onChange={setTextCapHeight} defaultValue={DEFAULTS.textCapHeight} C={C} />
          <SliderRow label="Depth"         value={textHeight}    min={0.5} max={10} step={0.5} onChange={setTextHeight}    defaultValue={DEFAULTS.textHeight}    C={C} />

          <SectionHeader label="Base" C={C} />
          <SliderRow label="Height"        value={borderHeight}  min={0.5} max={8}  step={0.5} onChange={setBorderHeight}  defaultValue={DEFAULTS.borderHeight}  C={C} />
          <SliderRow label="Border Padding"value={borderOffset}  min={0}   max={15} step={0.5} onChange={setBorderOffset}  defaultValue={DEFAULTS.borderOffset}  C={C} />

          <SectionHeader label="Hole Tab" C={C} />
          <SliderRow label="Gap"           value={gap}           min={-5}  max={10} step={0.5} onChange={setGap}           defaultValue={DEFAULTS.gap}           C={C} />
          <SliderRow label="Tab Diameter"  value={tabDiameter}   min={4}   max={20} step={0.5} onChange={setTabDiameter}   defaultValue={DEFAULTS.tabDiameter}   C={C} />
          <SliderRow label="Hole Diameter" value={holeDiameter}  min={1}   max={10} step={0.5} onChange={setHoleDiameter}  defaultValue={DEFAULTS.holeDiameter}  C={C} />
          <SliderRow label="Tab Y Offset"  value={tabYOffset}    min={-10} max={10} step={0.5} onChange={setTabYOffset}    defaultValue={DEFAULTS.tabYOffset}    C={C} />

          <SectionHeader label="Colors" C={C} />
          <ColorRow label="Border Color" value={borderColor} defaultValue={DEFAULTS.borderColor} onChange={setBorderColor} C={C} />
          <ColorRow label="Text Color"   value={textColor}   defaultValue={DEFAULTS.textColor}   onChange={setTextColor}   C={C} />

          <button onClick={resetAll}
            onMouseEnter={e => { e.currentTarget.style.borderColor = C.accent; e.currentTarget.style.color = C.accent; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = anyDirty ? C.accent : C.border; e.currentTarget.style.color = anyDirty ? C.accent : C.muted; }}
            style={{ width: "100%", marginTop: 20, marginBottom: 10, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "9px 0", borderRadius: 12, background: anyDirty ? C.pill : "none", border: `1.5px solid ${anyDirty ? C.accent : "transparent"}`, color: anyDirty ? C.accent : C.muted, fontSize: 11, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", transition: "all 0.2s" }}>
            ↺ Reset all settings
          </button>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
            {[
              { label: "STL", format: "STL", grad: "linear-gradient(135deg,#fda4af,#f472b6)", note: "geometry only" },
              { label: "3MF", format: "3MF", grad: "linear-gradient(135deg,#c4b5fd,#a78bfa)", note: "with colors"   },
            ].map(({ label, format, grad, note }) => (
              <div key={format} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                <button onClick={() => fontsReady && !exporting && setExportModal(format)} disabled={!fontsReady || exporting}
                  onMouseEnter={e => fontsReady && !exporting && (e.currentTarget.style.transform = "translateY(-1px)")}
                  onMouseLeave={e => (e.currentTarget.style.transform = "none")}
                  style={{ width: "100%", padding: "11px 0 9px", fontSize: 11, fontWeight: 700, fontFamily: "inherit", letterSpacing: "0.06em", textTransform: "uppercase", background: fontsReady && !exporting ? grad : C.trackBg, color: fontsReady && !exporting ? "white" : C.muted, border: "none", borderRadius: 14, cursor: fontsReady && !exporting ? "pointer" : "not-allowed", boxShadow: fontsReady && !exporting ? `0 4px 14px ${C.shadow}` : "none", transition: "all 0.2s" }}>
                  Export {label}
                </button>
                <span style={{ fontSize: 9, color: C.muted }}>{note}</span>
              </div>
            ))}
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "6px 12px", borderRadius: 20, background: C.pill }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: statusColor, animation: isBuilding ? "kc-pulse 1s ease-in-out infinite" : "none", flexShrink: 0 }} />
            <span style={{ fontSize: 10, fontWeight: 600, color: C.muted, animation: isBuilding ? "kc-pulse 1s ease-in-out infinite" : "none" }}>{exporting ? "Exporting…" : statusLabel}</span>
          </div>
        </div>

        {/* Viewport */}
        <div style={{ position: "relative", display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
            <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: C.muted }}>3D Preview</span>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 10, color: C.muted }}>drag to rotate · scroll to zoom</span>
              <button onClick={resetCamera}
                onMouseEnter={e => { e.currentTarget.style.borderColor = C.accent; e.currentTarget.style.color = C.accent; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.color = C.muted; }}
                style={{ fontSize: 10, color: C.muted, background: "none", border: `1px solid ${C.border}`, borderRadius: 8, padding: "3px 8px", cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s" }}>
                ⟳ Reset view
              </button>
            </div>
          </div>
          <div ref={canvasRef} style={{ flex: 1, minHeight: 0, overflow: "hidden" }} />
        </div>
      </div>

      {exportModal && (
        <ExportModal defaultName={suggestedName} format={exportModal}
          onCancel={() => setExportModal(null)}
          onConfirm={filename => {
            if (exportModal === "STL") doExportSTL(filename);
            else if (exportModal === "3MF") doExport3MF(filename);
            setExportModal(null);
          }} C={C} />
      )}
    </div>
  );
}