import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 8081);

const app = express();
app.disable("x-powered-by");

app.use(express.json({ limit: "5mb" }));

const upload = multer({
  limits: { fileSize: 10 * 1024 * 1024 },
});

function safeId(raw) {
  const id = String(raw || "");
  if (!/^[a-z][a-z0-9_]*$/.test(id)) return null;
  return id;
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

// --- API ---

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.post("/api/characters", async (req, res) => {
  try {
    const list = req.body;
    if (!Array.isArray(list)) {
      res.status(400).json({ ok: false, error: "Body must be a JSON array." });
      return;
    }
    const outPath = path.join(__dirname, "data", "characters.json");
    const text = `${JSON.stringify(list, null, 2)}\n`;
    await fs.writeFile(outPath, text, "utf8");
    res.json({ ok: true, path: "data/characters.json", bytes: text.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post("/api/enemies", async (req, res) => {
  try {
    const list = req.body;
    if (!Array.isArray(list)) {
      res.status(400).json({ ok: false, error: "Body must be a JSON array." });
      return;
    }
    const outPath = path.join(__dirname, "data", "enemies.json");
    const text = `${JSON.stringify(list, null, 2)}\n`;
    await fs.writeFile(outPath, text, "utf8");
    res.json({ ok: true, path: "data/enemies.json", bytes: text.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post("/api/sprites/:id", upload.single("file"), async (req, res) => {
  try {
    const id = safeId(req.params.id);
    if (!id) {
      res.status(400).json({ ok: false, error: "Invalid id." });
      return;
    }
    const file = req.file;
    if (!file) {
      res.status(400).json({ ok: false, error: "Missing file field (file)." });
      return;
    }
    if (file.mimetype !== "image/png") {
      res.status(400).json({ ok: false, error: "Only PNG supported for now (image/png)." });
      return;
    }
    const dir = path.join(__dirname, "sprites");
    await ensureDir(dir);
    const outPath = path.join(dir, `${id}.png`);
    await fs.writeFile(outPath, file.buffer);
    res.json({ ok: true, spriteUrl: `/sprites/${id}.png` });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post("/api/background", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ ok: false, error: "Missing file field (file)." });
      return;
    }
    if (file.mimetype !== "image/png") {
      res.status(400).json({ ok: false, error: "Only PNG supported for now (image/png)." });
      return;
    }
    const bgDir = path.join(__dirname, "backgrounds");
    const dataDir = path.join(__dirname, "data");
    await Promise.all([ensureDir(bgDir), ensureDir(dataDir)]);
    const rel = "backgrounds/arena.png";
    await fs.writeFile(path.join(__dirname, rel), file.buffer);
    const cfg = {
      arenaSpriteBackground: rel,
      updatedAt: Date.now(),
    };
    const cfgText = `${JSON.stringify(cfg, null, 2)}\n`;
    await fs.writeFile(path.join(dataDir, "background.json"), cfgText, "utf8");
    res.json({ ok: true, background: cfg });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.delete("/api/background", async (_req, res) => {
  try {
    const rel = "backgrounds/arena.png";
    const imgPath = path.join(__dirname, rel);
    try {
      await fs.unlink(imgPath);
    } catch (e) {
      if (e && e.code !== "ENOENT") throw e;
    }
    const cfg = {
      arenaSpriteBackground: "",
      updatedAt: Date.now(),
    };
    const cfgText = `${JSON.stringify(cfg, null, 2)}\n`;
    await ensureDir(path.join(__dirname, "data"));
    await fs.writeFile(path.join(__dirname, "data", "background.json"), cfgText, "utf8");
    res.json({ ok: true, background: cfg });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.delete("/api/sprites/:id", async (req, res) => {
  try {
    const id = safeId(req.params.id);
    if (!id) {
      res.status(400).json({ ok: false, error: "Invalid id." });
      return;
    }
    const outPath = path.join(__dirname, "sprites", `${id}.png`);
    try {
      await fs.unlink(outPath);
    } catch (e) {
      if (e && e.code !== "ENOENT") throw e;
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// --- Static ---
app.use(express.static(__dirname));
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});
app.get("/devtools", (_req, res) => {
  res.sendFile(path.join(__dirname, "devtools", "index.html"));
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`VibeJam dev server running on http://localhost:${PORT}`);
});

