import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import * as THREE from "three";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils";
import opentype from "opentype.js";
import ClipperLib from "clipper-lib";

const DEFAULTS = {
  name: "Name",
  font: "Bhineka:style=Regular",

  // TEXT (from your screenshot)
  textCapHeight: 14.5,
  textHeight: 3.0,

  // BASE
  borderHeight: 2.0,
  borderOffset: 2.5,

  // HOLE TAB
  gap: -1.5,
  tabDiameter: 8.0,
  holeDiameter: 3.5,
  tabYOffset: 3.0,

  // COLORS
  borderColor: "#f9a8d4",
  textColor: "#c084fc",
};
// Fonts that render better at a specific default cap height
const FONT_CAP_HEIGHT_DEFAULTS = {
  "Luckiest Guy:style=Regular": 10,
  "Titan One:style=Regular":    10,
};

const FONT_URLS = {
  "Pacifico:style=Regular":      "/fonts/Pacifico-Regular.ttf",
  "Lobster:style=Regular":       "/fonts/Lobster-Regular.ttf",
  "Titan One:style=Regular":     "/fonts/TitanOne-Regular.ttf",
  "Luckiest Guy:style=Regular":  "/fonts/LuckiestGuy-Regular.ttf",
  "Bhineka:style=Regular":       "/fonts/Bhineka-Regular.ttf",
  "Pheonies:style=Regular":      "/fonts/Pheonies.otf",
  "Freedom:style=Regular":       "/fonts/Freedom-10eM.ttf",
  "Baby Plums:style=Regular":    "/fonts/BabyPlums-rv2gL.ttf",
  "Short Baby:style=Regular":    "/fonts/ShortBaby-Mg2w.ttf",
  "Cabal Bold:style=Regular":    "/fonts/CabalBold-78yP.ttf",
  "Pixel Letters:style=Regular": "/fonts/Pixellettersfull-BnJ5.ttf",
  "Hearty Geelyn:style=Regular": "/fonts/HeartyGeelynEditsAirbrush-ze23.ttf",
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

// ── Clipper helpers ────────────────────────────────────────────────────────────
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

// ── Geometry helpers ───────────────────────────────────────────────────────────
function signedAreaVec2(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].y;
    a -= pts[j].x * pts[i].y;
  }
  return a / 2;
}

function signedArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    a += poly[i][0] * poly[j][1];
    a -= poly[j][0] * poly[i][1];
  }
  return a / 2;
}

function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if (((yi > pt.y) !== (yj > pt.y)) && (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function opentypePathToContours(otPath, yFlip = true) {
  const contours = [];
  let current = null;
  const flip = yFlip ? -1 : 1;

  for (const cmd of otPath.commands) {
    if (cmd.type === "M") {
      if (current && current.length >= 3) contours.push(current);
      current = [new THREE.Vector2(cmd.x, flip * cmd.y)];
    } else if (cmd.type === "L") {
      current?.push(new THREE.Vector2(cmd.x, flip * cmd.y));
    } else if (cmd.type === "C") {
      if (current) {
        const p0 = current[current.length - 1];
        const p1 = new THREE.Vector2(cmd.x1, flip * cmd.y1);
        const p2 = new THREE.Vector2(cmd.x2, flip * cmd.y2);
        const p3 = new THREE.Vector2(cmd.x,  flip * cmd.y);
        const segs = 12;
        for (let s = 1; s <= segs; s++) {
          const t = s / segs;
          const mt = 1 - t;
          current.push(new THREE.Vector2(
            mt*mt*mt*p0.x + 3*mt*mt*t*p1.x + 3*mt*t*t*p2.x + t*t*t*p3.x,
            mt*mt*mt*p0.y + 3*mt*mt*t*p1.y + 3*mt*t*t*p2.y + t*t*t*p3.y
          ));
        }
      }
    } else if (cmd.type === "Q") {
      if (current) {
        const p0 = current[current.length - 1];
        const p1 = new THREE.Vector2(cmd.x1, flip * cmd.y1);
        const p2 = new THREE.Vector2(cmd.x,  flip * cmd.y);
        const segs = 10;
        for (let s = 1; s <= segs; s++) {
          const t = s / segs;
          const mt = 1 - t;
          current.push(new THREE.Vector2(
            mt*mt*p0.x + 2*mt*t*p1.x + t*t*p2.x,
            mt*mt*p0.y + 2*mt*t*p1.y + t*t*p2.y
          ));
        }
      }
    } else if (cmd.type === "Z") {
      if (current && current.length >= 3) {
        contours.push(current);
        current = null;
      }
    }
  }
  if (current && current.length >= 3) contours.push(current);
  return contours;
}

function opentypePathToThreeShapes(otPath) {
  const contours = opentypePathToContours(otPath, true);

  const outers = [];
  const holes  = [];
  for (const pts of contours) {
    const area = signedAreaVec2(pts);
    if (area > 0) outers.push(pts);
    else          holes.push(pts);
  }

  if (outers.length === 0 && holes.length > 0) {
    holes.sort((a, b) => Math.abs(signedAreaVec2(b)) - Math.abs(signedAreaVec2(a)));
    outers.push(holes.shift());
  }

  return outers.map(outerPts => {
    const shape = new THREE.Shape(outerPts);
    for (const holePts of holes) {
      if (pointInPolygon(holePts[0], outerPts)) {
        shape.holes.push(new THREE.Path(holePts));
      }
    }
    return shape;
  });
}

function svgShapesToThreeShapes(svgPaths) {
  const shapes = [];
  for (const path of svgPaths) {
    const pathShapes = path.toShapes(true);
    for (const shape of pathShapes) {
      const pts = shape.getPoints().map(p => new THREE.Vector2(p.x, -p.y));
      const newShape = new THREE.Shape(pts);
      for (const hole of shape.holes) {
        const holePts = hole.getPoints().map(p => new THREE.Vector2(p.x, -p.y));
        newShape.holes.push(new THREE.Path(holePts));
      }
      shapes.push(newShape);
    }
  }
  return shapes;
}

function clipperPolysToShapes(polys) {
  const outers = [];
  const holes  = [];
  for (const poly of polys) {
    if (poly.length < 3) continue;
    const area = signedArea(poly);
    const pts3d = poly.map(([x, y]) => new THREE.Vector2(x, -y));
    if (area > 0) outers.push(pts3d);
    else           holes.push(pts3d);
  }
  return outers.map(outerPts => {
    const shape = new THREE.Shape(outerPts);
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

// ── 3MF writer ────────────────────────────────────────────────────────────────
function buildZip(files) {
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
    const dosDate = 0x5765;
    const dosTime = 0x0000;

    const local = concat(
      new Uint8Array([0x50,0x4B,0x03,0x04]),
      u16(20), u16(0), u16(0),
      u16(dosTime), u16(dosDate),
      u32(crc),
      u32(data.length), u32(data.length),
      u16(name.length), u16(0),
      name, data
    );

    const central = concat(
      new Uint8Array([0x50,0x4B,0x01,0x02]),
      u16(20), u16(20),
      u16(0), u16(0),
      u16(dosTime), u16(dosDate),
      u32(crc),
      u32(data.length), u32(data.length),
      u16(name.length), u16(0), u16(0),
      u16(0), u16(0),
      u32(0),
      u32(offset),
      name
    );

    localHeaders.push(local);
    centralHeaders.push(central);
    offset += local.length;
  }

  const cdOffset = offset;
  const cdSize   = centralHeaders.reduce((s, h) => s + h.length, 0);

  const eocd = concat(
    new Uint8Array([0x50,0x4B,0x05,0x06]),
    u16(0), u16(0),
    u16(files.length), u16(files.length),
    u32(cdSize), u32(cdOffset),
    u16(0)
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

  const norm = hex => hex.replace(/^#/, "").toUpperCase().padStart(6, "0");

  function meshXML(posArr, count) {
    const v = [], t = [];
    for (let i = 0; i < count; i++)
      v.push(`          <vertex x="${posArr[i*3].toFixed(6)}" y="${posArr[i*3+1].toFixed(6)}" z="${posArr[i*3+2].toFixed(6)}" />`);
    for (let i = 0; i < count; i += 3)
      t.push(`          <triangle v1="${i}" v2="${i+1}" v3="${i+2}" />`);
    return `        <vertices>\n${v.join("\n")}\n        </vertices>\n        <triangles>\n${t.join("\n")}\n        </triangles>`;
  }

  const btArr = new Float32Array(bPos.count * 3 + tbPos.count * 3);
  btArr.set(bPos.array, 0);
  btArr.set(tbPos.array, bPos.count * 3);

  const baseMesh = meshXML(btArr, bPos.count + tbPos.count);
  const textMesh = meshXML(txPos.array, txPos.count);
  bFlat.dispose(); tbFlat.dispose(); txFlat.dispose();

  const modelXML = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US"
  xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="2" name="base_tab" type="model">
      <mesh> ${baseMesh}
      </mesh>
    </object>
    <object id="3" name="text" type="model">
      <mesh> ${textMesh}
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

  const modelSettings = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="2">
    <metadata key="extruder" value="1" />
    <metadata key="name" value="base_tab" />
  </object>
  <object id="3">
    <metadata key="extruder" value="2" />
    <metadata key="name" value="text" />
  </object>
</config>`;

  const plateSettings = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <metadata key="plater_id" value="1" />
    <filament id="1" color="#${norm(borderHex)}" type="PLA" />
    <filament id="2" color="#${norm(textHex)}" type="PLA" />
  </plate>
</config>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />
  <Default Extension="config" ContentType="application/xml" />
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />
</Relationships>`;

  return buildZip([
    { name: "[Content_Types].xml",            data: contentTypes },
    { name: "_rels/.rels",                    data: rels },
    { name: "3D/3dmodel.model",               data: modelXML },
    { name: "Metadata/model_settings.config", data: modelSettings },
    { name: "Metadata/plate_settings.config", data: plateSettings },
  ]);
}

// ── React helpers ──────────────────────────────────────────────────────────────
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

// ── Dimensions Card — slicer style ────────────────────────────────────────────
function DimensionsCard({ dimensions, objectName, darkMode }) {
  if (!dimensions) return null;

  const bg      = darkMode ? "rgba(12,8,22,0.42)" : "rgba(255,255,255,0.30)";
  const border  = darkMode ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.60)";
  const divider = darkMode ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)";
  const fg      = darkMode ? "#f0eaf8" : "#1a1a1a";
  const fgLabel = darkMode ? "rgba(200,185,220,0.70)" : "rgba(60,50,80,0.60)";
  const sizeClr = "#4dabf7";
  const mono    = "'DM Mono','Courier New',monospace";

  // Filament length: volume / cross-section area of 1.75mm diameter filament
  const filamentLengthMm = (parseFloat(dimensions.volume)*1.2) / (Math.PI * Math.pow(1.75/2, 2));
  const filamentLengthM  = (filamentLengthMm / 1000).toFixed(2);

  function Row({ label, value, color }) {
    return (
      <div style={{ display:"flex", alignItems:"baseline", gap:6, lineHeight:"1.7" }}>
        <span style={{ fontSize:11.5, color:fgLabel, fontFamily:mono, whiteSpace:"nowrap", flexShrink:0, minWidth:118 }}>{label}</span>
        <span style={{ fontSize:11.5, color:color||fg, fontFamily:mono }}>{value}</span>
      </div>
    );
  }

  return (
    <div style={{
      position:"absolute", top:12, left:12, zIndex:10,
      background:bg,
      backdropFilter:"blur(10px)", WebkitBackdropFilter:"blur(10px)",
      border:`1px solid ${border}`,
      borderRadius:7,
      padding:"8px 13px 9px 11px",
      boxShadow: darkMode ? "0 3px 16px rgba(0,0,0,0.65)" : "0 2px 12px rgba(0,0,0,0.13)",
      pointerEvents:"none",
      minWidth:250,
    }}>
      <Row label="Object name:" value={objectName} />
      <Row label="Size:"        value={`${dimensions.w} x ${dimensions.h} x ${dimensions.d} mm`} color={sizeClr} />
      <Row label="Volume:"      value={`${dimensions.volume} mm³`} />
      <Row label="Triangles:"   value={dimensions.triangles.toLocaleString()} />

      <div style={{ height:1, background:divider, margin:"5px 0 4px" }} />

      <Row label="Printing Time:"    value={dimensions.printTime} />
      <Row label="Filament Weight:"  value={`${dimensions.weightG} g`} />
      <Row label="Filament Length:"  value={`${filamentLengthM} m`} />
    </div>
  );
}

// ── App ────────────────────────────────────────────────────────────────────────
export default function KeychainApp() {
  const [darkMode, setDarkMode] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const h = e => setDarkMode(e.matches);
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, []);
  const C = darkMode ? DARK : LIGHT;

  const [name,          setName]          = useState(DEFAULTS.name);
  const [font,          setFont]          = useState(DEFAULTS.font);
  const [textCapHeight, setTextCapHeight] = useState(DEFAULTS.textCapHeight);
  const [textHeight,    setTextHeight]    = useState(DEFAULTS.textHeight);
  const [borderHeight,  setBorderHeight]  = useState(DEFAULTS.borderHeight);
  const [borderOffset,  setBorderOffset]  = useState(DEFAULTS.borderOffset);
  const [gap,           setGap]           = useState(DEFAULTS.gap);
  const [tabDiameter,   setTabDiameter]   = useState(DEFAULTS.tabDiameter);
  const [holeDiameter,  setHoleDiameter]  = useState(DEFAULTS.holeDiameter);
  const [tabYOffset,    setTabYOffset]    = useState(DEFAULTS.tabYOffset);
  const [borderColor,   setBorderColor]   = useState(DEFAULTS.borderColor);
  const [textColor,     setTextColor]     = useState(DEFAULTS.textColor);
  const [dimensions,    setDimensions]    = useState(null);

  // --- Linked text size controls (Width <-> Cap Height) ---
  const [textWidth, setTextWidth] = useState(null);
  const measuredTextRef = useRef({ w: null, h: null });
  const textWidthDefaultRef = useRef(null);
  const clamp = (v, mn, mx) => Math.min(mx, Math.max(mn, v));

  const colorsLoadedRef = useRef(false);
  const [fontsReady,  setFontsReady]  = useState(false);
  const [loadedFonts, setLoadedFonts] = useState(new Set());
  const [status,      setStatus]      = useState("loading");
  const [exporting,   setExporting]   = useState(false);
  const [exportModal, setExportModal] = useState(null);

  useEffect(() => {
    readSavedColors().then(s => {
      if (s?.borderColor) setBorderColor(s.borderColor);
      if (s?.textColor)   setTextColor(s.textColor);
      colorsLoadedRef.current = true;
    });
  }, []);
  useEffect(() => { if (colorsLoadedRef.current) persistColors(borderColor, textColor); }, [borderColor, textColor]);

  const dName          = useDebounce(name,          200);
  const dTextCapHeight = useDebounce(textCapHeight, 80);
  const dTextHeight    = useDebounce(textHeight,    80);
  const dBorderHeight  = useDebounce(borderHeight,  80);
  const dBorderOffset  = useDebounce(borderOffset,  80);
  const dGap           = useDebounce(gap,           80);
  const dTabD          = useDebounce(tabDiameter,   80);
  const dHoleD         = useDebounce(holeDiameter,  80);
  const dTabY          = useDebounce(tabYOffset,    80);

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
    setTextWidth(null);
    textWidthDefaultRef.current = null;
    measuredTextRef.current = { w: null, h: null };
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
      const loaded = new Set();
      for (const k of Object.keys(FONT_URLS)) {
        try {
          const r = await fetch(FONT_URLS[k]);
          if (!r.ok) { console.warn(`Font not found (${r.status}): ${FONT_URLS[k]}`); continue; }
          const buf = await r.arrayBuffer();
          fontCacheRef.current[k] = opentype.parse(buf);
          loaded.add(k);
          if (!alive) return;
          setLoadedFonts(new Set(loaded));
        } catch (e) {
          console.warn(`Failed to load font "${k}" (${FONT_URLS[k]}):`, e);
        }
      }
      if (!alive) return;
      if (loaded.size > 0) { setFontsReady(true); setStatus("ready"); }
      else { setStatus("error"); }
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (loadedFonts.size > 0 && !loadedFonts.has(font)) {
      const fallback = [...loadedFonts][0];
      console.warn(`Font "${font}" unavailable, falling back to "${fallback}"`);
      setFont(fallback);
    }
  }, [loadedFonts, font]);

  // Auto-apply font-specific cap height when font changes
  useEffect(() => {
    const override = FONT_CAP_HEIGHT_DEFAULTS[font];
    if (override !== undefined) setTextCapHeight(override);
    else setTextCapHeight(DEFAULTS.textCapHeight);
  }, [font]);

  const clearGroup = useCallback(() => {
    const g = groupRef.current;
    if (!g) return;
    while (g.children.length) {
      const o = g.children.pop();
      o?.traverse?.(c => { if (c.isMesh) { c.geometry?.dispose(); c.material?.dispose(); } });
    }
  }, []);

  // ── Main geometry build ────────────────────────────────────────────────────
  useEffect(() => {
    if (!fontsReady || !safeName || !groupRef.current) return;
    const otFont = fontCacheRef.current[font];
    if (!otFont) return;
    setStatus("building");
    clearGroup();
    const tid = setTimeout(() => {
      try {
        const isCFF = !!(otFont.tables && otFont.tables.cff);

        const ttfShapes = (otPath) => {
          const svgStr = otPath.toPathData(4);
          const parsed = new SVGLoader().parse(`<svg><path d="${svgStr}"/></svg>`);
          return svgShapesToThreeShapes(parsed.paths);
        };
        const cffShapes = (otPath) => opentypePathToThreeShapes(otPath);

        const shapesLookHollow = (shapes) => {
          if (!shapes.length) return false;
          let outerArea = 0, holeArea = 0;
          for (const s of shapes) {
            const pts = s.getPoints(8);
            outerArea += Math.abs(signedAreaVec2(pts));
            for (const h of s.holes) {
              const hpts = h.getPoints(8);
              holeArea += Math.abs(signedAreaVec2(hpts));
            }
          }
          return outerArea > 0 && (holeArea / outerArea) > 0.6;
        };

        const buildTextShapes = (otPath) => {
          if (isCFF) return cffShapes(otPath);
          const ttf = ttfShapes(otPath);
          if (shapesLookHollow(ttf)) return cffShapes(otPath);
          return ttf;
        };

        // ── Calibrate font scale using OS/2 table metrics (most accurate).
        // Priority: sCapHeight > sTypoAscender > unitsPerEm fallback.
        // This avoids per-string bbox variance (ascenders, descenders, overshoots)
        // that caused short names to render at the wrong size.
        const unitsPerEm = otFont.unitsPerEm || 1000;
        const os2 = otFont.tables?.os2;
        const capHeightUnits =
          (os2?.sCapHeight  > 0 ? os2.sCapHeight  : null) ??
          (os2?.sTypoAscender > 0 ? os2.sTypoAscender : null) ??
          unitsPerEm * 0.72; // reasonable fallback ~72% of em
        // fontSize such that capHeightUnits maps to dTextCapHeight mm
        const fontSize = dTextCapHeight * (unitsPerEm / capHeightUnits);

        const scaledOtPath = otFont.getPath(safeName, 0, 0, fontSize);
        const textShapes = buildTextShapes(scaledOtPath);
        if (!textShapes.length) return;

        const textGeo = new THREE.ExtrudeGeometry(textShapes, {
          depth: dTextHeight, bevelEnabled: false, curveSegments: 8
        });
        textGeo.computeBoundingBox();
        const tb = textGeo.boundingBox;

        // --- Measure text size (for linked Width slider) ---
        const textW = tb.max.x - tb.min.x;
        const textH = tb.max.y - tb.min.y;
        measuredTextRef.current = { w: textW, h: textH };
        setTextWidth(() => {
          if (textWidthDefaultRef.current == null) textWidthDefaultRef.current = +textW.toFixed(2);
          return +textW.toFixed(2);
        });

        textGeo.translate(-(tb.max.x + tb.min.x) / 2, -(tb.max.y + tb.min.y) / 2, 0);

        const svgPath = scaledOtPath.toPathData(4);
        const svgData = new SVGLoader().parse(`<svg><path d="${svgPath}"/></svg>`);
        const rawContours = svgData.paths.flatMap(p =>
          p.subPaths.map(sp => sp.getPoints(48).map(pt => [pt.x, pt.y])).filter(c => c.length >= 3)
        );

        {
          let curX = 0;
          for (let ci = 0; ci < safeName.length; ci++) {
            const ch = safeName[ci];
            const glyph = otFont.charToGlyph(ch);
            const advance = (glyph.advanceWidth || 0) * (fontSize / otFont.unitsPerEm);
            if (ch === " ") {
              const x0 = curX, x1 = curX + advance;
              const y0 = -fontSize * 0.1, y1 = fontSize * 0.1;
              rawContours.push([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
            }
            curX += advance;
            if (ci + 1 < safeName.length) {
              const nextGlyph = otFont.charToGlyph(safeName[ci + 1]);
              const kern = otFont.getKerningValue(glyph, nextGlyph);
              curX += kern * (fontSize / otFont.unitsPerEm);
            }
          }
        }

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

        const tabGeo = makeTabGeo(dTabD / 2, dHoleD / 2, dBorderHeight, 40);
        tabGeo.translate(baseB.min.x - dGap - dTabD / 2, dTabY, 0);

        clearGroup();
        const baseMat = new THREE.MeshPhongMaterial({ color: borderColor, shininess: 80,  side: THREE.DoubleSide });
        const textMat = new THREE.MeshPhongMaterial({ color: textColor,   shininess: 100, side: THREE.DoubleSide });
        const baseMesh = new THREE.Mesh(baseGeo, baseMat);
        const tabMesh  = new THREE.Mesh(tabGeo,  baseMat);
        const textMesh = new THREE.Mesh(textGeo, textMat);
        textMesh.position.z = dBorderHeight;
        groupRef.current.add(baseMesh, tabMesh, textMesh);
        meshRef.current = { base: baseMesh, tab: tabMesh, text: textMesh };

        // ── Compute print dimensions, volume, triangle count ─────────────────
        const combined = new THREE.Box3();
        combined.expandByObject(baseMesh);
        combined.expandByObject(tabMesh);
        const size = new THREE.Vector3();
        combined.getSize(size);

        function meshVolume(geo) {
          const pos = geo.attributes.position;
          let vol = 0;
          for (let i = 0; i < pos.count; i += 3) {
            const ax = pos.getX(i),   ay = pos.getY(i),   az = pos.getZ(i);
            const bx = pos.getX(i+1), by = pos.getY(i+1), bz = pos.getZ(i+1);
            const cx = pos.getX(i+2), cy = pos.getY(i+2), cz = pos.getZ(i+2);
            vol += (ax*(by*cz - bz*cy) + bx*(cy*az - cz*ay) + cx*(ay*bz - az*by)) / 6;
          }
          return Math.abs(vol);
        }
        const bFlat  = baseGeo.toNonIndexed();
        const tbFlat = tabGeo.toNonIndexed();
        const txFlat = textGeo.toNonIndexed();
        const totalVol = meshVolume(bFlat) + meshVolume(tbFlat) + meshVolume(txFlat);
        const totalTris = (bFlat.attributes.position.count + tbFlat.attributes.position.count + txFlat.attributes.position.count) / 3;
        bFlat.dispose(); tbFlat.dispose(); txFlat.dispose();

        const bboxVol  = (size.x * size.y * (dBorderHeight + dTextHeight)*.40);
        const weightG  = (bboxVol / 1000) * 1.24;
        const weightG2c = weightG * 1.25;

        const printMins = ((totalVol*0.75) / 240) * 1.5 + 4;
        const printH    = Math.floor(printMins / 60);
        const printM    = Math.round(printMins % 60);
        const printTimeStr = printH > 0 ? `${printH}h ${printM}m` : `${printM}m`;

        const bambuMins    = totalVol / 300;
        const creaMins     = totalVol / 180;
        const fmtT = m => { const h = Math.floor(m/60), mn = Math.round(m%60); return h > 0 ? `${h}h ${mn}m` : `${mn}m`; };

        setDimensions({
          w: +size.x.toFixed(2),
          h: +size.y.toFixed(2),
          d: +(dBorderHeight + dTextHeight).toFixed(2),
          volume: totalVol.toFixed(2),
          triangles: Math.round(totalTris),
          weightG: weightG2c.toFixed(2),
          printTime: printTimeStr,
          bambuTime: fmtT(bambuMins),
          creaTime:  fmtT(creaMins),
        });

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

  // ── STL export ──────────────────────────────────────────────────────────────
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

  // ── 3MF export ──────────────────────────────────────────────────────────────
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
              {Object.keys(FONT_URLS).map(k => {
                const label = k.split(":")[0];
                const isOTF = FONT_URLS[k].endsWith(".otf");
                const available = loadedFonts.has(k);
                return (
                  <option key={k} value={k} disabled={!available}>
                    {label}{isOTF ? " (OTF)" : ""}{!available ? " – loading…" : ""}
                  </option>
                );
              })}
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
          <SliderRow
            label="Cap Height"
            value={textCapHeight}
            min={8}
            max={60}
            step={0.5}
            onChange={(v) => setTextCapHeight(v)}
            defaultValue={DEFAULTS.textCapHeight}
            C={C}
          />

          {/* Linked width slider (updates cap height proportionally) */}
          {textWidth != null && (
            <SliderRow
              label="Text Width"
              value={textWidth}
              min={20}
              max={200}
              step={0.5}
              unit="mm"
              onChange={(targetW) => {
                setTextWidth(targetW);
                const curW = measuredTextRef.current.w;
                if (!curW || curW <= 0) return;
                const scale = targetW / curW;
                const nextCap = clamp(textCapHeight * scale, 8, 60);
                setTextCapHeight(nextCap);
              }}
              defaultValue={textWidthDefaultRef.current ?? textWidth}
              C={C}
            />
          )}

          <SliderRow label="Depth"          value={textHeight}    min={0.5} max={10} step={0.5} onChange={setTextHeight}    defaultValue={DEFAULTS.textHeight}    C={C} />

          <SectionHeader label="Base" C={C} />
          <SliderRow label="Height"         value={borderHeight}  min={0.5} max={8}  step={0.5} onChange={setBorderHeight}  defaultValue={DEFAULTS.borderHeight}  C={C} />
          <SliderRow label="Border Padding" value={borderOffset}  min={0}   max={15} step={0.5} onChange={setBorderOffset}  defaultValue={DEFAULTS.borderOffset}  C={C} />

          <SectionHeader label="Hole Tab" C={C} />
          <SliderRow label="Gap"            value={gap}           min={-5}  max={10} step={0.5} onChange={setGap}           defaultValue={DEFAULTS.gap}           C={C} />
          <SliderRow label="Tab Diameter"   value={tabDiameter}   min={4}   max={20} step={0.5} onChange={setTabDiameter}   defaultValue={DEFAULTS.tabDiameter}   C={C} />
          <SliderRow label="Hole Diameter"  value={holeDiameter}  min={1}   max={10} step={0.5} onChange={setHoleDiameter}  defaultValue={DEFAULTS.holeDiameter}  C={C} />
          <SliderRow label="Tab Y Offset"   value={tabYOffset}    min={-10} max={10} step={0.5} onChange={setTabYOffset}    defaultValue={DEFAULTS.tabYOffset}    C={C} />

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

          <div style={{ position: "relative", flex: 1, minHeight: 0, overflow: "hidden" }}>
            <div ref={canvasRef} style={{ position: "absolute", inset: 0 }} />
            <DimensionsCard dimensions={dimensions} objectName={safeName || "keychain"} darkMode={darkMode} />
          </div>
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
