const express    = require("express");
const multer     = require("multer");
const cors       = require("cors");
const fs         = require("fs");
const path       = require("path");
const os         = require("os");
const AdmZip     = require("adm-zip");
const { execFile } = require("child_process");

const PORT = 3001;

const SLICER_PATH =
  process.env.SLICER_PATH ||
  "C:\\Program Files\\OrcaSlicer\\orca-slicer.exe";

const PRINTER_PROFILES = {
  k2: "Creality K2 Plus 0.4 nozzle",
};

const PRICING = {
  filamentCostPerGram: 0.02,
  machineRatePerHour:  0.50,
  markupMultiplier:    3.0,
  minimumPrice:        3.00,
};

const app    = express();
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 100 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());


// ---------------------------------------------------------------------------
// patch3mf — fix known bad params in Bambu-exported 3MF configs
// ---------------------------------------------------------------------------
const CONFIG_CLAMP = {
  raft_first_layer_expansion: { min: 0,                  default: 0 },
  solid_infill_filament:      { min: 1, max: 2147483647, default: 1 },
  sparse_infill_filament:     { min: 1, max: 2147483647, default: 1 },
  tree_support_wall_count:    { min: 0, max: 2,          default: 0 },
  wall_filament:              { min: 1, max: 2147483647, default: 1 },
};

function patch3mf(inputPath) {
  const patchedPath = inputPath.replace(/\.3mf$/i, "_patched.3mf");
  const zip = new AdmZip(inputPath);
  let anyPatched = false;

  zip.getEntries().forEach(entry => {
    const name = entry.entryName.toLowerCase();
    if (name !== "metadata/project_settings.config") return;

    let content;
    try { content = zip.readAsText(entry); } catch { return; }

    let cfg;
    try { cfg = JSON.parse(content); } catch { return; }

    let modified = false;

    // Always inject G92 E0 — required by OrcaSlicer when relative E is on
    const lg = String(cfg["layer_gcode"] || "");
    if (!lg.includes("G92 E0")) {
      cfg["layer_gcode"] = "G92 E0\n" + lg;
      console.log("[patch3mf] injected G92 E0 into layer_gcode");
      modified = true;
    }

    // Clamp out-of-range params
    for (const [key, rule] of Object.entries(CONFIG_CLAMP)) {
      if (!(key in cfg)) continue;
      const raw = cfg[key];
      const n = parseFloat(raw);
      if (isNaN(n)) continue;
      if (n < rule.min || (rule.max !== undefined && n > rule.max)) {
        cfg[key] = typeof raw === "string" ? String(rule.default) : rule.default;
        console.log(`[patch3mf] clamped: ${key} = ${raw} -> ${cfg[key]}`);
        modified = true;
      }
    }

    if (modified) {
      zip.updateFile(entry.entryName, Buffer.from(JSON.stringify(cfg, null, 4), "utf8"));
      anyPatched = true;
    }
  });

  zip.writeZip(patchedPath);
  console.log(anyPatched ? `[patch3mf] patched -> ${patchedPath}` : "[patch3mf] no changes needed");
  return patchedPath;
}

// ---------------------------------------------------------------------------
// 3MF → STL conversion
// Extracts all mesh geometry from the 3MF and writes a clean ASCII STL.
// This avoids all OrcaSlicer config validation errors from Bambu exports.
// ---------------------------------------------------------------------------

function parseXmlAttributes(attrText) {
  const attrs = {};
  const re = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(attrText)) !== null) attrs[m[1]] = m[2];
  return attrs;
}

function parseTransform(t) {
  if (!t || !String(t).trim()) return [1,0,0, 0,1,0, 0,0,1, 0,0,0];
  const nums = String(t).trim().split(/\s+/).map(Number);
  if (nums.length !== 12 || nums.some(isNaN)) return [1,0,0, 0,1,0, 0,0,1, 0,0,0];
  return nums;
}

function multiplyTransforms(A, B) {
  return [
    A[0]*B[0]+A[1]*B[3]+A[2]*B[6],  A[0]*B[1]+A[1]*B[4]+A[2]*B[7],  A[0]*B[2]+A[1]*B[5]+A[2]*B[8],
    A[3]*B[0]+A[4]*B[3]+A[5]*B[6],  A[3]*B[1]+A[4]*B[4]+A[5]*B[7],  A[3]*B[2]+A[4]*B[5]+A[5]*B[8],
    A[6]*B[0]+A[7]*B[3]+A[8]*B[6],  A[6]*B[1]+A[7]*B[4]+A[8]*B[7],  A[6]*B[2]+A[7]*B[5]+A[8]*B[8],
    A[0]*B[9]+A[1]*B[10]+A[2]*B[11]+A[9],
    A[3]*B[9]+A[4]*B[10]+A[5]*B[11]+A[10],
    A[6]*B[9]+A[7]*B[10]+A[8]*B[11]+A[11],
  ];
}

function applyTransform(m, p) {
  return [
    m[0]*p[0]+m[1]*p[1]+m[2]*p[2]+m[9],
    m[3]*p[0]+m[4]*p[1]+m[5]*p[2]+m[10],
    m[6]*p[0]+m[7]*p[1]+m[8]*p[2]+m[11],
  ];
}

function cross(u, v) { return [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]]; }
function sub(a, b)   { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function normalize(v) {
  const l = Math.sqrt(v[0]**2 + v[1]**2 + v[2]**2);
  return l ? [v[0]/l, v[1]/l, v[2]/l] : [0, 0, 1];
}

function convert3mfToStl(inputPath) {
  const zip = new AdmZip(inputPath);
  const modelEntry = zip.getEntry("3D/3dmodel.model");
  if (!modelEntry) throw new Error("3MF has no 3D/3dmodel.model entry");

  const xml = zip.readAsText(modelEntry);
  const objectMap = new Map();
  const buildItems = [];

  // Parse all <object> elements
  const objRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/gi;
  let om;
  while ((om = objRe.exec(xml)) !== null) {
    const attrs = parseXmlAttributes(om[1]);
    const body  = om[2];
    const id    = attrs.id;
    if (!id) continue;

    const obj = { id, vertices: [], triangles: [], components: [] };

    const meshMatch = body.match(/<mesh\b[^>]*>([\s\S]*?)<\/mesh>/i);
    if (meshMatch) {
      const vRe = /<vertex\b([^\/>]*)\/>/gi; let vm;
      while ((vm = vRe.exec(meshMatch[1])) !== null) {
        const a = parseXmlAttributes(vm[1]);
        obj.vertices.push([+a.x||0, +a.y||0, +a.z||0]);
      }
      const tRe = /<triangle\b([^\/>]*)\/>/gi; let tm;
      while ((tm = tRe.exec(meshMatch[1])) !== null) {
        const a = parseXmlAttributes(tm[1]);
        obj.triangles.push([+a.v1||0, +a.v2||0, +a.v3||0]);
      }
    }

    const compMatch = body.match(/<components\b[^>]*>([\s\S]*?)<\/components>/i);
    if (compMatch) {
      const cRe = /<component\b([^\/>]*)\/>/gi; let cm;
      while ((cm = cRe.exec(compMatch[1])) !== null) {
        const a = parseXmlAttributes(cm[1]);
        if (a.objectid) obj.components.push({
          objectid:  String(a.objectid),
          transform: parseTransform(a.transform),
        });
      }
    }

    objectMap.set(String(id), obj);
  }

  // Parse <build> items
  const buildMatch = xml.match(/<build\b[^>]*>([\s\S]*?)<\/build>/i);
  if (buildMatch) {
    const iRe = /<item\b([^\/>]*)\/>/gi; let im;
    while ((im = iRe.exec(buildMatch[1])) !== null) {
      const a = parseXmlAttributes(im[1]);
      if (a.objectid) buildItems.push({
        objectid:  String(a.objectid),
        transform: parseTransform(a.transform),
      });
    }
  }

  // Fallback: use all mesh objects if no build section
  if (!buildItems.length) {
    for (const [id, obj] of objectMap)
      if (obj.triangles.length) buildItems.push({ objectid: id, transform: parseTransform(null) });
  }

  if (!buildItems.length) throw new Error("3MF has no build items or meshes");

  // Flatten all objects into world-space triangles
  const allTris = [];
  const identity = parseTransform(null);
  const visited  = new Set();

  function flatten(id, xform) {
    const key = id + "|" + xform.join(",");
    if (visited.has(key)) return;
    visited.add(key);
    const obj = objectMap.get(id);
    if (!obj) return;

    for (const [i0, i1, i2] of obj.triangles) {
      const a = obj.vertices[i0], b = obj.vertices[i1], c = obj.vertices[i2];
      if (!a || !b || !c) continue;
      allTris.push([
        applyTransform(xform, a),
        applyTransform(xform, b),
        applyTransform(xform, c),
      ]);
    }

    for (const comp of obj.components) {
      flatten(comp.objectid, multiplyTransforms(xform, comp.transform));
    }
  }

  for (const item of buildItems) flatten(item.objectid, item.transform || identity);

  if (!allTris.length) throw new Error("3MF geometry extraction produced zero triangles");

  // Write ASCII STL
  const stlPath = inputPath.replace(/\.3mf$/i, "_converted.stl");
  const lines   = ["solid model"];
  for (const [a, b, c] of allTris) {
    const n = normalize(cross(sub(b, a), sub(c, a)));
    lines.push(`  facet normal ${n[0]} ${n[1]} ${n[2]}`);
    lines.push("    outer loop");
    lines.push(`      vertex ${a[0]} ${a[1]} ${a[2]}`);
    lines.push(`      vertex ${b[0]} ${b[1]} ${b[2]}`);
    lines.push(`      vertex ${c[0]} ${c[1]} ${c[2]}`);
    lines.push("    endloop");
    lines.push("  endfacet");
  }
  lines.push("endsolid model");
  fs.writeFileSync(stlPath, lines.join("\n"), "utf8");

  console.log(`[convert] 3MF -> STL | objects=${objectMap.size} buildItems=${buildItems.length} triangles=${allTris.length} -> ${stlPath}`);
  return stlPath;
}

// ---------------------------------------------------------------------------
// G-code parsing
// ---------------------------------------------------------------------------

function parseGcode(gcodePath) {
  const text = fs.readFileSync(gcodePath, "utf8");

  const debugLines = text.split("\n").filter(l => {
    const s = l.toLowerCase();
    return s.includes("filament") || s.includes("weight") ||
           s.includes("material used") || s.includes("estimated");
  });
  console.log("[debug] key lines:\n" + debugLines.join("\n"));

  const extract = (patterns) => {
    for (const re of patterns) {
      const m = text.match(re);
      if (m) return parseFloat(m[1]);
    }
    return null;
  };

  const extractStr = (patterns) => {
    for (const re of patterns) {
      const m = text.match(re);
      if (m) return m[1].trim();
    }
    return null;
  };

  const weightG = extract([
    /; filament used \[g\] = ([\d.]+)/,
    /;   filament used \[g\] = ([\d.]+)/,
    /;filament used \[g\] = ([\d.]+)/,
    /filament used \[g\] = ([\d.]+)/,
    /; filament_used_g\s*=\s*([\d.]+)/i,
    /; total filament used \[g\] = ([\d.]+)/i,
    /; filament used = ([\d.]+)g/i,
    /; material#1 used: ([\d.]+)g/i,
  ]);

  const filamentMM = extract([
    /; filament used \[mm\] = ([\d.]+)/,
    /;   filament used \[mm\] = ([\d.]+)/,
    /;filament used \[mm\] = ([\d.]+)/,
    /filament used \[mm\] = ([\d.]+)/,
  ]);

  const filamentCM3 = extract([
    /; filament used \[cm3\] = ([\d.]+)/,
    /;   filament used \[cm3\] = ([\d.]+)/,
    /;filament used \[cm3\] = ([\d.]+)/,
    /filament used \[cm3\] = ([\d.]+)/,
  ]);

  const resolvedWeightG = (weightG && weightG > 0)
    ? weightG
    : (filamentCM3 ? +(filamentCM3 * 1.24).toFixed(2) : null);

  const printTimeRaw = extractStr([
    /; estimated printing time \(normal mode\) = (.+)/,
    /; estimated printing time = (.+)/,
    /;estimated printing time \(normal mode\) = (.+)/,
    /;estimated printing time = (.+)/,
    /; print_time = (.+)/i,
    /; total estimated time: (.+)/i,
  ]);

  let totalSeconds = 0;
  if (printTimeRaw) {
    const hm = printTimeRaw.match(/(\d+)h/); if (hm) totalSeconds += parseInt(hm[1]) * 3600;
    const mm = printTimeRaw.match(/(\d+)m/); if (mm) totalSeconds += parseInt(mm[1]) * 60;
    const sm = printTimeRaw.match(/(\d+)s/); if (sm) totalSeconds += parseInt(sm[1]);
  }

  const hours   = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const formatted =
    hours   > 0 ? `${hours}h ${minutes}m` :
    minutes > 0 ? `${minutes}m ${seconds}s` :
                  `${seconds}s`;

  const supportG = extract([
    /; support material \[g\] = ([\d.]+)/,
    /;   support material \[g\] = ([\d.]+)/,
    /;support material \[g\] = ([\d.]+)/,
  ]);

  console.log("[debug] resolved -> weightG:", resolvedWeightG, "| filamentCM3:", filamentCM3, "| time:", printTimeRaw, "| totalSeconds:", totalSeconds);

  return { weightG: resolvedWeightG, filamentMM, filamentCM3, totalSeconds,
           formatted: printTimeRaw || formatted, hours, minutes, seconds, supportG };
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

function calcPrice(sliceResult, cfg = PRICING) {
  const { weightG, totalSeconds } = sliceResult;
  if (!weightG || !totalSeconds) return null;
  const printHours   = totalSeconds / 3600;
  const filamentCost = weightG    * cfg.filamentCostPerGram;
  const machineCost  = printHours * cfg.machineRatePerHour;
  const baseCost     = filamentCost + machineCost;
  const finalPrice   = Math.max(baseCost * cfg.markupMultiplier, cfg.minimumPrice);
  return {
    filamentCost:  +filamentCost.toFixed(2),
    machineCost:   +machineCost.toFixed(2),
    baseCost:      +baseCost.toFixed(2),
    markup:        cfg.markupMultiplier,
    finalPrice:    +finalPrice.toFixed(2),
    breakdown: {
      filament: `${weightG.toFixed(1)}g x $${cfg.filamentCostPerGram}/g`,
      machine:  `${printHours.toFixed(2)}h x $${cfg.machineRatePerHour}/hr`,
      markup:   `${cfg.markupMultiplier}x markup`,
    },
  };
}

// ---------------------------------------------------------------------------
// Slicer runner
// ---------------------------------------------------------------------------

function findGcode(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findGcode(full);
      if (found) return found;
    } else if (entry.name.toLowerCase().endsWith(".gcode")) {
      return full;
    }
  }
  return null;
}

function runSlicer(inputPath) {
  return new Promise((resolve, reject) => {
    const outDir = inputPath + "_out";
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

    // Find K2 machine + process profiles from OrcaSlicer
    const profileRoots = [
      "C:\\Program Files\\OrcaSlicer\\resources\\profiles\\Creality",
      path.join(os.homedir(), "AppData", "Roaming", "OrcaSlicer", "system", "Creality"),
    ];

    // Pick process profile by quality setting sent from frontend
    const qualityProfile = req.body.qualityProfile || "0.20mm Standard @Creality K2 Plus 0.4 nozzle";

    let machineProfile = null;
    let processProfile = null;

    for (const root of profileRoots) {
      if (!fs.existsSync(root)) continue;

      const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const f of entries) {
          const full = path.join(dir, f.name);
          const lower = f.name.toLowerCase();
          if (f.isDirectory()) { walk(full); continue; }
          if (!f.name.endsWith(".json")) continue;

          // Machine profile: k2 plus 0.4 nozzle in /machine/ folder
          if (dir.toLowerCase().includes("machine") &&
              lower.includes("k2") && lower.includes("0.4") &&
              !machineProfile) {
            machineProfile = full;
          }

          // Process profile: match the exact profile name from frontend
          const nameWithoutExt = f.name.replace(/\.json$/i, "");
          if (dir.toLowerCase().includes("process") &&
              nameWithoutExt === qualityProfile &&
              !processProfile) {
            processProfile = full;
          }
        }
      };
      walk(root);
      if (machineProfile) break;
    }

    // Fallback: if exact profile not found, use any standard 0.4 process profile
    if (!processProfile) {
      for (const root of profileRoots) {
        if (!fs.existsSync(root)) continue;
        const walk = (dir) => {
          let entries;
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const f of entries) {
            const full = path.join(dir, f.name);
            const lower = f.name.toLowerCase();
            if (f.isDirectory()) { walk(full); continue; }
            if (dir.toLowerCase().includes("process") &&
                lower.includes("0.20mm") && lower.includes("k2") &&
                lower.includes("0.4") && !processProfile) {
              processProfile = full;
            }
          }
        };
        walk(root);
        if (processProfile) break;
      }
    }

    console.log("[slicer] Quality:", qualityProfile);
    console.log("[slicer] Machine profile:", machineProfile || "NOT FOUND");
    console.log("[slicer] Process profile:", processProfile || "NOT FOUND");

    const settingsFiles = [machineProfile, processProfile].filter(Boolean);

    const args = [
      "--slice", "0",
      "--outputdir", outDir,
      "--allow-newer-file",
      "--orient", "1",
      ...(settingsFiles.length ? ["--load-settings", settingsFiles.join(";")] : []),
      inputPath,
    ];

    console.log(`[slicer] Running: ${SLICER_PATH} ${args.join(" ")}`);

    execFile(SLICER_PATH, args, { timeout: 5 * 60 * 1000 }, (err, stdout, stderr) => {
      if (stdout) console.log("[slicer] stdout:", stdout);
      if (stderr) console.log("[slicer] stderr:", stderr);
      if (err)    console.error("[slicer] error:", err.message);

      const gcodeFile = findGcode(outDir);
      if (!gcodeFile) {
        try { fs.rmSync(outDir, { recursive: true }); } catch {}
        const detail = stderr?.trim() || err?.message || "unknown";
        return reject(new Error(`Slicer produced no gcode. Detail: ${detail.slice(0, 300)}`));
      }

      console.log("[slicer] found gcode:", gcodeFile);
      resolve({ gcodeFile, outDir });
    });
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/health", (req, res) => {
  res.json({ ok: true, slicer: SLICER_PATH });
});

app.get("/find-profiles", (req, res) => {
  const roots = [
    path.join(os.homedir(), "AppData", "Roaming", "OrcaSlicer"),
    "C:\\Program Files\\OrcaSlicer\\resources\\profiles",
  ];
  const results = [];
  function walk(dir, depth) {
    if (depth > 5 || !fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (f.isDirectory()) { walk(full, depth + 1); continue; }
      if (f.name.toLowerCase().includes("k2") || f.name.toLowerCase().includes("creality")) {
        results.push(full);
      }
    }
  }
  roots.forEach(r => walk(r, 0));
  res.json(results);
});


app.post("/slice", upload.single("model"), async (req, res) => {
  const uploadedPath = req.file?.path;
  let renamedPath  = null;
  let patchedPath  = null;
  let convertedStl = null;
  let outDir       = null;

  try {
    if (!req.file) return res.status(400).json({ error: "No model file uploaded." });

    const ext = path.extname(req.file.originalname).toLowerCase();
    if (![".stl", ".3mf", ".obj"].includes(ext))
      return res.status(400).json({ error: "Only STL, 3MF, OBJ files accepted." });

    renamedPath = uploadedPath + ext;
    fs.renameSync(uploadedPath, renamedPath);

    console.log(`[slice] ${req.file.originalname} | printer=k2 | layer=${req.body.layerHeight || "0.2"} | infill=${req.body.infill || "15"}% | supports=${req.body.supports}`);

    // Patch 3MF config params, then slice directly (preserves speed/quality settings)
    // Falls back to STL conversion if patched 3MF still fails
    let slicerInput = renamedPath;
    if (ext === ".3mf") {
      patchedPath = patch3mf(renamedPath);
      slicerInput = patchedPath;
    }

    let gcodeFile, od;
    try {
      ({ gcodeFile, outDir: od } = await runSlicer(slicerInput));
    } catch (sliceErr) {
      if (ext === ".3mf") {
        console.warn("[slice] Patched 3MF failed, falling back to STL conversion:", sliceErr.message);
        convertedStl = convert3mfToStl(renamedPath);
        ({ gcodeFile, outDir: od } = await runSlicer(convertedStl));
      } else {
        throw sliceErr;
      }
    }
    outDir = od;

    const sliceResult = parseGcode(gcodeFile);
    const price       = calcPrice(sliceResult);

    // Cleanup temp files
    try { fs.unlinkSync(renamedPath);   } catch {}
    try { if (convertedStl) fs.unlinkSync(convertedStl); } catch {}
    try { fs.rmSync(outDir, { recursive: true }); } catch {}

    if (!sliceResult.weightG) {
      return res.status(500).json({ error: "Slicer ran but could not parse filament weight. Check terminal for [debug] output." });
    }

    res.json({
      ok: true,
      slice: {
        weightG:        sliceResult.weightG,
        filamentM:      sliceResult.filamentMM ? +(sliceResult.filamentMM / 1000).toFixed(2) : null,
        supportWeightG: sliceResult.supportG,
        printTime:      sliceResult.formatted,
        printSeconds:   sliceResult.totalSeconds,
      },
      price,
    });

  } catch (err) {
    console.error("[slice] fatal:", err.message);
    try { if (uploadedPath   && fs.existsSync(uploadedPath))   fs.unlinkSync(uploadedPath);   } catch {}
    try { if (renamedPath    && fs.existsSync(renamedPath))    fs.unlinkSync(renamedPath);    } catch {}
    try { if (convertedStl   && fs.existsSync(convertedStl))   fs.unlinkSync(convertedStl);   } catch {}
    try { const ov = slicerInput + "_override.ini"; if (fs.existsSync(ov)) fs.unlinkSync(ov); } catch {}
    try { if (outDir) fs.rmSync(outDir, { recursive: true }); } catch {}
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n✅  PrintQuote backend running on http://localhost:${PORT}`);
  console.log(`   OrcaSlicer: ${SLICER_PATH}`);
  console.log(`   Pricing: $${PRICING.filamentCostPerGram}/g · $${PRICING.machineRatePerHour}/hr · ${PRICING.markupMultiplier}x markup\n`);
});