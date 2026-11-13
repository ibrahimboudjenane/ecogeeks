// Run the whole site on your own computer, no Netlify needed.
//   node local-server.js      then open http://localhost:3000
// Requires Node.js 18 or newer (check with: node -v).
const http = require("http");
const fs = require("fs");
const path = require("path");
const Module = require("module");

// ---- Load .env (simple KEY=VALUE parser, no extra packages) ----
const envFile = path.join(__dirname, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
if (!process.env.QR_SECRET || !process.env.ADMIN_TOKEN) {
  console.warn("WARNING: QR_SECRET and/or ADMIN_TOKEN missing in .env");
}

// ---- Local storage: a JSON file instead of Netlify Blobs ----
const DATA_FILE = path.join(__dirname, "data.json");
let db = {};
try { db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch { db = {}; }
const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));

const localStore = {
  async get(key) {
    return db[key] === undefined ? null : structuredClone(db[key]);
  },
  async setJSON(key, value) {
    db[key] = structuredClone(value);
    save();
  },
  async list({ prefix = "" } = {}) {
    return { blobs: Object.keys(db).filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
  },
};

// Make the API code's `require("@netlify/blobs")` use the local storage above.
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "@netlify/blobs") return { getStore: () => localStore };
  return originalLoad.call(this, request, ...rest);
};

const { handler } = require("./netlify/functions/api.js");

// ---- Web server: static pages + /api ----
const PUBLIC = path.join(__dirname, "public");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};
const PORT = Number(process.env.PORT) || 3000;

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");

    if (url.pathname.startsWith("/api/")) {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const result = await handler({
        path: url.pathname,
        httpMethod: req.method,
        headers: req.headers,
        body: raw || null,
        queryStringParameters: Object.fromEntries(url.searchParams),
      });
      res.writeHead(result.statusCode, result.headers);
      res.end(result.body);
      return;
    }

    const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const file = path.normalize(path.join(PUBLIC, requested));
    if (!file.startsWith(PUBLIC)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    });
  })
  .listen(PORT, () => {
    console.log(`Eco Geeks Club running at http://localhost:${PORT}`);
    console.log("Press Ctrl+C to stop. Data is saved in data.json.");
  });
