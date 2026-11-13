const { getStore } = require("@netlify/blobs");
const crypto = require("crypto");

const json = (status, body) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body),
});

// Netlify Blobs normally configures itself. If the function runs without that
// setup, pass the site ID and a personal access token from the environment.
const store = () => {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_ACCESS_TOKEN;
  if (!siteID || !token) {
    const missing = [!siteID && "NETLIFY_SITE_ID", !token && "NETLIFY_ACCESS_TOKEN"].filter(Boolean);
    throw new Error(`Missing environment variable(s): ${missing.join(", ")}. Add them with the Functions scope, then redeploy.`);
  }
  return getStore({ name: "ecogeeks", siteID, token });
};

// Signature only the server can create (needs QR_SECRET).
const sign = (name, points) =>
  crypto.createHmac("sha256", process.env.QR_SECRET).update(`${name}|${points}`).digest("hex");

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const hashPassword = (password, salt = crypto.randomBytes(16).toString("hex")) => ({
  salt,
  hash: crypto.scryptSync(password, salt, 64).toString("hex"),
});

async function listAll(prefix) {
  const s = store();
  const { blobs } = await s.list({ prefix });
  const items = await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })));
  return items.filter(Boolean);
}

async function currentUser(event) {
  const token = (event.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  return (await store().get(`sessions/${token}`, { type: "json" })) || null;
}

function isAdmin(event) {
  const token = event.headers["x-admin-token"] || "";
  return !!process.env.ADMIN_TOKEN && safeEqual(token, process.env.ADMIN_TOKEN);
}

async function createSession(username) {
  const token = crypto.randomBytes(32).toString("hex");
  await store().setJSON(`sessions/${token}`, { username, createdAt: Date.now() });
  return token;
}

exports.handler = async (event) => {
  const route = event.path.replace(/^.*\/api\/?/, "").replace(/\/$/, "");
  const method = event.httpMethod;

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: "Invalid JSON." });
  }

  try {
    // ---------- Visitor: accounts ----------
    if (method === "POST" && route === "register") {
      const username = String(body.username || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (!/^[a-z0-9_]{3,30}$/.test(username)) {
        return json(400, { error: "Username: 3-30 letters, numbers or underscores." });
      }
      if (password.length < 6) return json(400, { error: "Password must be at least 6 characters." });
      const s = store();
      if (await s.get(`users/${username}`, { type: "json" })) {
        return json(409, { error: "This username is already taken." });
      }
      const { salt, hash } = hashPassword(password);
      await s.setJSON(`users/${username}`, { username, salt, hash, createdAt: Date.now() });
      return json(201, { token: await createSession(username), username });
    }

    if (method === "POST" && route === "login") {
      const username = String(body.username || "").trim().toLowerCase();
      const user = await store().get(`users/${username}`, { type: "json" });
      const attempt = hashPassword(String(body.password || ""), user?.salt);
      if (!user || !safeEqual(attempt.hash, user.hash)) {
        return json(401, { error: "Wrong username or password." });
      }
      return json(200, { token: await createSession(username), username });
    }

    // ---------- Public: leaderboard (confirmed wins only) ----------
    if (method === "GET" && route === "leaderboard") {
      const wins = await listAll("wins/");
      const totals = {};
      wins
        .filter((w) => w.status === "confirmed")
        .forEach((w) => {
          totals[w.username] = (totals[w.username] || 0) + w.points;
        });
      const sorted = Object.entries(totals)
        .map(([name, points]) => ({ name, points }))
        .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
      // Competition ranking: tied players share a place (1, 2, 2, 4)
      let place = 0;
      let last = null;
      const rows = sorted.map((r, i) => {
        if (r.points !== last) place = i + 1;
        last = r.points;
        return { place, name: r.name, points: r.points };
      });
      return json(200, { rows });
    }

    // ---------- Visitor: scan a QR code ----------
    if (method === "POST" && route === "scan") {
      const user = await currentUser(event);
      if (!user) return json(401, { error: "Please log in first." });

      let payload;
      try {
        payload = JSON.parse(String(body.code || ""));
      } catch {
        return json(400, { error: "This code is damaged or not recognised." });
      }
      const { n, p, s } = payload || {};
      if (typeof n !== "string" || typeof p !== "number" || typeof s !== "string" || !safeEqual(sign(n, p), s)) {
        return json(400, { error: "This code is fake. It was not issued by the event." });
      }

      const win = {
        id: crypto.randomUUID(),
        username: user.username,
        challenge: n,
        points: p,
        status: "pending",
        createdAt: Date.now(),
      };
      await store().setJSON(`wins/${win.id}`, win);
      return json(201, { message: "Your win is waiting for confirmation.", win });
    }

    // ---------- Visitor: check own wins (confirmed ones drive the tree effect) ----------
    if (method === "GET" && route === "my-wins") {
      const user = await currentUser(event);
      if (!user) return json(401, { error: "Please log in first." });
      const wins = (await listAll("wins/"))
        .filter((w) => w.username === user.username)
        .map(({ id, challenge, points, status, createdAt }) => ({ id, challenge, points, status, createdAt }))
        .sort((a, b) => b.createdAt - a.createdAt);
      return json(200, { wins });
    }

    // ---------- Admin ----------
    if (route.startsWith("admin/")) {
      if (!isAdmin(event)) return json(401, { error: "Invalid admin token." });

      if (method === "GET" && route === "admin/challenges") {
        const items = (await listAll("challenges/")).sort((a, b) => a.createdAt - b.createdAt);
        return json(200, {
          challenges: items.map((c) => ({
            ...c,
            payload: JSON.stringify({ n: c.name, p: c.points, s: sign(c.name, c.points) }),
          })),
        });
      }

      if (method === "POST" && route === "admin/challenges") {
        const name = String(body.name || "").trim();
        const points = Number(body.points);
        if (!name || name.length > 80) return json(400, { error: "Name is required (max 80 characters)." });
        if (!Number.isInteger(points) || points < 1 || points > 1000) {
          return json(400, { error: "Points must be a whole number from 1 to 1000." });
        }
        const challenge = { id: crypto.randomUUID(), name, points, createdAt: Date.now() };
        await store().setJSON(`challenges/${challenge.id}`, challenge);
        return json(201, {
          challenge: { ...challenge, payload: JSON.stringify({ n: name, p: points, s: sign(name, points) }) },
        });
      }

      if (method === "GET" && route === "admin/wins") {
        const filter = (event.queryStringParameters || {}).status;
        let wins = (await listAll("wins/")).sort((a, b) => b.createdAt - a.createdAt);
        if (["pending", "confirmed", "rejected"].includes(filter)) {
          wins = wins.filter((w) => w.status === filter);
        }
        return json(200, { wins });
      }

      const m = route.match(/^admin\/wins\/([\w-]+)$/);
      if (method === "POST" && m) {
        const s = store();
        const win = await s.get(`wins/${m[1]}`, { type: "json" });
        if (!win) return json(404, { error: "Win not found." });
        if (!["confirmed", "rejected"].includes(body.status)) {
          return json(400, { error: "Status must be confirmed or rejected." });
        }
        win.status = body.status;
        win.reviewedAt = Date.now();
        await s.setJSON(`wins/${win.id}`, win);
        return json(200, { win });
      }
    }

    return json(404, { error: "Not found." });
  } catch (err) {
    console.error(err);
    return json(500, { error: "Server error. Please try again." });
  }
};
