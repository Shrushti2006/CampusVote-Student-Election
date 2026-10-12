require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { MongoClient, ObjectId } = require("mongodb");
const Student = require("./models/Student");
const AttendanceModel = require("./models/Attendance");

const {
  MONGODB_URI,
  DB_NAME = "campusvote",
  PORT = 3000 ,
  ADMIN_USERNAME = "admin",   // only used to create the first admin account
  ADMIN_PASSWORD = "admin123", // only used to create the first admin account
  EMAIL_PROVIDER = "console",  // console | smtp
  OTP_DEV_ECHO = "false",      // console provider only: also return the OTP to the browser (testing!)
  ALLOWED_EMAIL_DOMAINS = "",  // optional, e.g. "dypatil.edu,student.dypatil.edu" (empty = any email)
} = process.env;
const OTP_EXPIRY_MIN = Number(process.env.OTP_EXPIRY_MINUTES) || 5;
const OTP_RESEND_SEC = 30;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_SENDS_PER_HOUR = 5;
const TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET || crypto.randomBytes(32).toString("hex");

if (!MONGODB_URI) {
  console.error("Missing MONGODB_URI in .env");
  process.exit(1);
}

const client = new MongoClient(MONGODB_URI);
let adminsCol, electionsCol, votesCol, otpsCol, studentsCol, attendanceCol;

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

/* =============== helpers =============== */
const safeEqual = (a, b) => {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
  console.error(err);
  res.status(500).json({ error: "Server error. Please try again." });
});
function limiter(max, windowMs) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const rec = (hits.get(req.ip) || []).filter((t) => now - t < windowMs);
    if (rec.length >= max) return res.status(429).json({ error: "Too many attempts. Try again later." });
    rec.push(now);
    hits.set(req.ip, rec);
    next();
  };
}
const oid = (id) => { try { return new ObjectId(String(id)); } catch { return null; } };

/* ---------- admin password hashing (scrypt) ---------- */
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString("hex") };
}
function verifyPassword(password, admin) {
  const expected = Buffer.from(admin.hash, "hex");
  const actual = crypto.scryptSync(String(password), admin.salt, 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
const getAdmin = () => adminsCol.findOne({ _id: "admin" });

/* ---------- signed tokens (admin session + voting session) ---------- */
function signPayload(obj) {
  const payload = Buffer.from(JSON.stringify(obj)).toString("base64url");
  const sig = crypto.createHmac("sha256", TOKEN_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
function readPayload(token, type) {
  const [payload, sig] = String(token || "").split(".");
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", TOKEN_SECRET).update(payload).digest("base64url");
  if (!safeEqual(sig, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    return data.t === type && data.exp > Date.now() ? data : null;
  } catch { return null; }
}
const signToken = (admin) => signPayload({ t: "admin", exp: Date.now() + 8 * 3600 * 1000, v: admin.tokenVersion || 0 });
const requireAdmin = asyncH(async (req, res, next) => {
  const data = readPayload((req.headers.authorization || "").replace(/^Bearer\s+/i, ""), "admin");
  if (!data) return res.status(401).json({ error: "Not authorised. Please sign in again." });
  const admin = await getAdmin();
  if (!admin || (admin.tokenVersion || 0) !== data.v)
    return res.status(401).json({ error: "Credentials changed. Please sign in again." });
  req.admin = admin;
  next();
});

/* ---------- email addresses, OTPs and mail sending ---------- */
function normalizeEmail(input) {
  const e = String(input || "").trim().toLowerCase();
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : null;
}
// One mailbox = one voter: ignore "+tag" aliases (and dots for Gmail) when checking uniqueness.
function emailKey(e) {
  let [user, domain] = e.split("@");
  user = user.split("+")[0];
  if (domain === "gmail.com" || domain === "googlemail.com") { user = user.replace(/\./g, ""); domain = "gmail.com"; }
  return `${user}@${domain}`;
}
const allowedDomains = ALLOWED_EMAIL_DOMAINS.split(",").map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
const emailAllowed = (e) => !allowedDomains.length || allowedDomains.includes(e.split("@")[1]);
const maskEmail = (e) => { const [u, d] = e.split("@"); return `${u.slice(0, 2)}${"•".repeat(Math.max(u.length - 2, 3))}@${d}`; };
const otpHash = (id, otp) => crypto.createHmac("sha256", TOKEN_SECRET).update(`${id}:${otp}`).digest("hex");

// simple in-memory counters (per server process) to stop email flooding
const sendLog = new Map();
function tooManySends(key) {
  const now = Date.now();
  const rec = (sendLog.get(key) || []).filter((t) => now - t < 3600 * 1000);
  sendLog.set(key, rec);
  return rec.length >= OTP_MAX_SENDS_PER_HOUR;
}
const noteSend = (key) => sendLog.get(key).push(Date.now());

let transporter = null;
async function setupMail() {
  if (EMAIL_PROVIDER === "console") {
    console.warn("EMAIL_PROVIDER=console: no email is sent; OTPs are printed in this terminal. Use EMAIL_PROVIDER=smtp for real use.");
    if (OTP_DEV_ECHO === "true") console.warn("OTP_DEV_ECHO=true: OTPs are shown on the web page. Turn this OFF before a real election.");
    return;
  }
  if (EMAIL_PROVIDER !== "smtp") { console.error(`Unknown EMAIL_PROVIDER "${EMAIL_PROVIDER}". Use console or smtp.`); process.exit(1); }
  const { SMTP_USER, SMTP_PASS, SMTP_HOST = "smtp.gmail.com", SMTP_PORT = "465", SMTP_SECURE = "true" } = process.env;
  if (!SMTP_USER || !SMTP_PASS) { console.error("EMAIL_PROVIDER=smtp needs SMTP_USER and SMTP_PASS in .env"); process.exit(1); }
  const nodemailer = require("nodemailer");
  transporter = nodemailer.createTransport({ host: SMTP_HOST, port: Number(SMTP_PORT), secure: SMTP_SECURE !== "false", auth: { user: SMTP_USER, pass: SMTP_PASS } });
  try { await transporter.verify(); console.log(`Email sending ready (${SMTP_HOST} as ${SMTP_USER})`); }
  catch (err) { console.error("Email setup failed:", err.message); process.exit(1); }
}
async function sendEmailOtp(to, otp) {
  if (EMAIL_PROVIDER === "console") { console.log(`[OTP] ${to} -> ${otp}`); return; }
  await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to,
    subject: `Your CampusVote OTP: ${otp}`,
    text: `Your CampusVote OTP is ${otp}. It is valid for ${OTP_EXPIRY_MIN} minutes. Do not share it with anyone.\n\nIf you did not request this, you can ignore this email.`,
    html: `<div style="font-family:Arial,sans-serif;color:#192642"><p>Your CampusVote OTP is</p><p style="font-size:30px;font-weight:700;letter-spacing:8px;margin:8px 0">${otp}</p><p>It is valid for ${OTP_EXPIRY_MIN} minutes. Do not share it with anyone.</p><p style="color:#888;font-size:12px">If you did not request this, you can ignore this email.</p></div>`,
  });
}
const devEcho = () => EMAIL_PROVIDER === "console" && OTP_DEV_ECHO === "true";

/* ---------- elections ---------- */
function electionState(e) {
  if (!e.startTime || !e.endTime) return "not-configured";
  const now = Date.now(), start = new Date(e.startTime).getTime(), end = new Date(e.endTime).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return "invalid";
  if (now < start) return "upcoming";
  if (now > end) return "ended";
  return "open";
}
const publicElection = (e) => ({
  id: String(e._id), name: e.name, startTime: e.startTime, endTime: e.endTime,
  posts: e.posts, state: electionState(e), active: !!e.active,
});
const getActiveElection = () => electionsCol.findOne({ active: true });
const newPostId = () => crypto.randomBytes(4).toString("hex");

function parseElectionBody(b = {}) {
  const names = (a) => (Array.isArray(a) ? a : []).map((x) => String(x).trim().slice(0, 100)).filter(Boolean)
    .filter((x, i, arr) => arr.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i).slice(0, 50);
  const start = new Date(b.startTime), end = new Date(b.endTime);
  const passcode = String(b.passcode || "").trim();
  const name = String(b.name || "").trim().slice(0, 120);
  if (!name) return { error: "Please enter an election name." };
  if (isNaN(start) || isNaN(end) || end <= start) return { error: "Please set a valid end time that is after the start time." };
  if (!passcode) return { error: "Please set an election passcode." };
  const rawPosts = Array.isArray(b.posts) ? b.posts.slice(0, 20) : [];
  if (!rawPosts.length) return { error: "Add at least one post (e.g. President)." };
  const posts = [], titles = new Set(), ids = new Set();
  for (const p of rawPosts) {
    const title = String((p && p.title) || "").trim().slice(0, 80);
    const candidates = names(p && p.candidates);
    if (!title) return { error: "Every post needs a title." };
    if (titles.has(title.toLowerCase())) return { error: `The post "${title}" is listed twice.` };
    if (!candidates.length) return { error: `Add at least one candidate for "${title}".` };
    titles.add(title.toLowerCase());
    let id = /^[a-f0-9]{8}$/.test(String((p && p.id) || "")) ? p.id : newPostId();
    while (ids.has(id)) id = newPostId();
    ids.add(id);
    posts.push({ id, title, candidates });
  }
  return { value: { name, startTime: start.toISOString(), endTime: end.toISOString(), passcode, posts } };
}
const postsKey = (posts) => JSON.stringify((posts || []).map((p) => [p.id, p.title, p.candidates]));

/* =============== STUDENT ROUTES =============== */
app.get("/api/election", asyncH(async (_req, res) => {
  const e = await getActiveElection();
  res.json(e ? publicElection(e) : null);
}));

// Step 1: check passcode / PRN / email, then email a 6-digit OTP.
app.post("/api/student/send-otp", limiter(30, 15 * 60 * 1000), asyncH(async (req, res) => {
  const passcode = String(req.body.passcode || "").trim();
  const prn = String(req.body.prn || "").trim().toUpperCase();
  const email = normalizeEmail(req.body.email);
  const studentName = String(req.body.name || "").trim();
  const classYear = String(req.body.classYear || "").trim().toUpperCase();
  if (!studentName) return res.status(400).json({ error: "Enter your registered name." });
  if (!passcode || !prn) return res.status(400).json({ error: "Enter your election passcode and PRN." });
  if (!email) return res.status(400).json({ error: "Enter a valid email address." });
  if (!emailAllowed(email)) return res.status(400).json({ error: `Please use your college email (${allowedDomains.map((d) => "@" + d).join(", ")}).` });
  const key = emailKey(email);
  const student = await studentsCol.findOne({ prn });
  if (!student) return res.status(403).json({ error: "Your PRN is not registered. Contact your teacher/admin." });
  if (student.name.toLowerCase() !== studentName.toLowerCase())
    return res.status(401).json({ error: "Name or PRN does not match the student register." });
  const e = await getActiveElection();
  if (!e) return res.status(403).json({ error: "No election is open for voting right now." });
  if (!safeEqual(passcode, e.passcode))
    return res.status(401).json({ error: "That election passcode is incorrect. Please check with your admin." });
  const attendance = await attendanceCol.findOne({ electionId: e._id, prn, present: true });
  if (!attendance) return res.status(403).json({ error: "Your attendance has not been marked present by your teacher for this election. Contact your teacher." });
  if (await votesCol.findOne({ electionId: e._id, prn }, { projection: { _id: 1 } }))
    return res.status(409).json({ error: "This PRN has already submitted a ballot. A second vote is not allowed." });
  if (await votesCol.findOne({ electionId: e._id, emailKey: key }, { projection: { _id: 1 } }))
    return res.status(409).json({ error: "This email address has already been used to vote in this election." });
  const state = electionState(e);
  if (state !== "open") {
    const msg = state === "upcoming" ? `Voting has not started yet. It opens at ${new Date(e.startTime).toLocaleString("en-IN")}.`
      : state === "ended" ? "This election has ended. Votes can no longer be submitted."
      : "The admin has not configured a valid election time yet.";
    return res.status(403).json({ error: msg });
  }

  const id = `${e._id}:${prn}`;
  const existing = await otpsCol.findOne({ _id: id });
  if (existing && Date.now() - existing.sentAt.getTime() < OTP_RESEND_SEC * 1000) {
    const wait = Math.ceil(OTP_RESEND_SEC - (Date.now() - existing.sentAt.getTime()) / 1000);
    return res.status(429).json({ error: `Please wait ${wait}s before requesting another OTP.`, retryAfter: wait });
  }
  if (tooManySends(`prn:${id}`) || tooManySends(`email:${key}`))
    return res.status(429).json({ error: "Too many OTP requests. Please try again in an hour." });

  const otp = String(crypto.randomInt(100000, 1000000));
  try { await sendEmailOtp(email, otp); }
  catch (err) {
    console.error("Email send failed:", err.message);
    return res.status(502).json({ error: "Could not send the OTP email. Please check the address and try again, or contact the admin." });
  }
  noteSend(`prn:${id}`); noteSend(`email:${key}`);
  await otpsCol.replaceOne({ _id: id }, {
    _id: id, electionId: e._id, prn, email, otpHash: otpHash(id, otp), attempts: 0,
    sentAt: new Date(), expiresAt: new Date(Date.now() + OTP_EXPIRY_MIN * 60 * 1000),
  }, { upsert: true });
  res.json({
    ok: true, emailMasked: maskEmail(email), expiresInSec: OTP_EXPIRY_MIN * 60, resendInSec: OTP_RESEND_SEC,
    ...(devEcho() ? { devOtp: otp } : {}),
  });
}));

// Step 2: verify the OTP; success returns a short-lived voting token.
app.post("/api/student/verify-otp", limiter(40, 15 * 60 * 1000), asyncH(async (req, res) => {
  const prn = String(req.body.prn || "").trim().toUpperCase();
  const email = normalizeEmail(req.body.email);
  const otp = String(req.body.otp || "").trim();
  if (!prn || !email || !/^\d{6}$/.test(otp)) return res.status(400).json({ error: "Enter the 6-digit OTP." });
  const e = await getActiveElection();
  if (!e) return res.status(403).json({ error: "No election is open for voting right now." });
  const id = `${e._id}:${prn}`;
  const doc = await otpsCol.findOneAndUpdate({ _id: id, email }, { $inc: { attempts: 1 } }, { returnDocument: "after" });
  if (!doc || doc.expiresAt < new Date())
    return res.status(400).json({ error: "OTP expired or not requested. Please request a new OTP." });
  if (doc.attempts > OTP_MAX_ATTEMPTS) {
    await otpsCol.deleteOne({ _id: id });
    return res.status(429).json({ error: "Too many wrong attempts. Please request a new OTP." });
  }
  if (!safeEqual(otpHash(id, otp), doc.otpHash))
    return res.status(401).json({ error: `Incorrect OTP. ${Math.max(OTP_MAX_ATTEMPTS - doc.attempts, 0)} attempt(s) left.` });
  await otpsCol.deleteOne({ _id: id });
  if (electionState(e) !== "open") return res.status(403).json({ error: "Voting is not currently open." });
  const token = signPayload({ t: "vote", eid: String(e._id), prn, email, exp: Date.now() + 15 * 60 * 1000 });
  res.json({ token, prn, emailMasked: maskEmail(email), election: publicElection(e) });
}));

// Saves one vote record: PRN + verified email + the chosen candidate for every post.
app.post("/api/vote", limiter(30, 15 * 60 * 1000), asyncH(async (req, res) => {
  const data = readPayload(req.body.token, "vote");
  if (!data) return res.status(401).json({ error: "Your OTP session expired. Please sign in again." });
  const given = req.body.choices && typeof req.body.choices === "object" ? req.body.choices : {};
  const e = await getActiveElection();
  if (!e || String(e._id) !== data.eid) return res.status(403).json({ error: "This election is no longer active. Please sign in again." });
  if (electionState(e) !== "open")
    return res.status(403).json({ error: "Voting is not currently open. Your vote was not submitted." });
  const attendance = await attendanceCol.findOne({ electionId: e._id, prn: data.prn, present: true });
  if (!attendance) return res.status(403).json({ error: "Your teacher-marked attendance is missing. Your vote was not submitted." });
  const registeredStudent = await studentsCol.findOne({ prn: data.prn });
  if (!registeredStudent) return res.status(403).json({ error: "Student registration was not found. Contact your admin." });
  const choices = [];
  for (const p of e.posts) {
    const candidate = given[p.id];
    if (!p.candidates.includes(candidate))
      return res.status(400).json({ error: `Please select one candidate for ${p.title}.` });
    choices.push({ postId: p.id, post: p.title, candidate });
  }
  try {
    await votesCol.insertOne({ electionId: e._id, electionName: e.name, prn: data.prn, email: data.email, emailKey: emailKey(data.email), emailVerified: true, choices, submittedAt: new Date() });
  } catch (err) {
    if (err.code === 11000) {
      const byEmail = err.keyPattern && err.keyPattern.emailKey;
      return res.status(409).json({ error: byEmail ? "This email address has already been used to vote." : "This PRN has already voted. Duplicate ballot blocked." });
    }
    throw err;
  }
  res.status(201).json({ ok: true });
}));

/* =============== ADMIN ROUTES =============== */
app.post("/api/admin/login", limiter(10, 15 * 60 * 1000), asyncH(async (req, res) => {
  const { username = "", password = "" } = req.body || {};
  const admin = await getAdmin();
  const ok = admin && safeEqual(String(username).trim(), admin.username) && verifyPassword(password, admin);
  if (!ok) return res.status(401).json({ error: "Incorrect admin username or password." });
  res.json({ token: signToken(admin), username: admin.username });
}));

// Change admin username and/or password.
app.post("/api/admin/credentials", requireAdmin, limiter(10, 15 * 60 * 1000), asyncH(async (req, res) => {
  const currentPassword = String(req.body.currentPassword || "");
  const newUsername = String(req.body.newUsername || "").trim();
  const newPassword = String(req.body.newPassword || "");
  if (!verifyPassword(currentPassword, req.admin)) return res.status(401).json({ error: "Current password is incorrect." });
  if (!newUsername && !newPassword) return res.status(400).json({ error: "Enter a new username or a new password." });
  if (newUsername && newUsername.length < 3) return res.status(400).json({ error: "Username must be at least 3 characters." });
  if (newPassword && newPassword.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });
  const set = { updatedAt: new Date(), tokenVersion: (req.admin.tokenVersion || 0) + 1 };
  if (newUsername) set.username = newUsername;
  if (newPassword) Object.assign(set, hashPassword(newPassword));
  await adminsCol.updateOne({ _id: "admin" }, { $set: set });
  const updated = await getAdmin();
  res.json({ ok: true, username: updated.username, token: signToken(updated) });
}));

// List all elections with ballot counts.
app.get("/api/admin/elections", requireAdmin, asyncH(async (_req, res) => {
  const list = await electionsCol.find({}).sort({ createdAt: -1 }).toArray();
  const counts = await votesCol.aggregate([{ $group: { _id: "$electionId", n: { $sum: 1 } } }]).toArray();
  const byId = Object.fromEntries(counts.map((c) => [String(c._id), c.n]));
  res.json({ elections: list.map((e) => ({ ...publicElection(e), ballots: byId[String(e._id)] || 0 })) });
}));

// Create a new election (becomes the active one unless makeActive === false).
app.post("/api/admin/elections", requireAdmin, asyncH(async (req, res) => {
  const { error, value } = parseElectionBody(req.body);
  if (error) return res.status(400).json({ error });
  const makeActive = req.body.makeActive !== false;
  if (makeActive) await electionsCol.updateMany({}, { $set: { active: false } });
  const r = await electionsCol.insertOne({ ...value, active: makeActive, createdAt: new Date() });
  res.status(201).json({ id: String(r.insertedId) });
}));

// Edit an election. Candidate lists are locked once votes exist.
app.put("/api/admin/elections/:id", requireAdmin, asyncH(async (req, res) => {
  const _id = oid(req.params.id);
  const existing = _id && await electionsCol.findOne({ _id });
  if (!existing) return res.status(404).json({ error: "Election not found." });
  const { error, value } = parseElectionBody(req.body);
  if (error) return res.status(400).json({ error });
  if (postsKey(value.posts) !== postsKey(existing.posts) && await votesCol.countDocuments({ electionId: _id }) > 0)
    return res.status(409).json({ error: "Posts and candidates can't be changed after votes have been recorded. Create a new election instead." });
  await electionsCol.updateOne({ _id }, { $set: value });
  if (value.name !== existing.name) await votesCol.updateMany({ electionId: _id }, { $set: { electionName: value.name } });
  res.json({ ok: true });
}));

app.post("/api/admin/elections/:id/activate", requireAdmin, asyncH(async (req, res) => {
  const _id = oid(req.params.id);
  if (!_id || !(await electionsCol.findOne({ _id }))) return res.status(404).json({ error: "Election not found." });
  await electionsCol.updateMany({}, { $set: { active: false } });
  await electionsCol.updateOne({ _id }, { $set: { active: true } });
  res.json({ ok: true });
}));

app.delete("/api/admin/elections/:id", requireAdmin, asyncH(async (req, res) => {
  const _id = oid(req.params.id);
  if (!_id || !(await electionsCol.findOne({ _id }))) return res.status(404).json({ error: "Election not found." });
  await votesCol.deleteMany({ electionId: _id });
  await electionsCol.deleteOne({ _id });
  res.json({ ok: true });
}));

// Full voting details for one election: tally per post + one record per PRN (who voted for whom).
app.get("/api/admin/elections/:id/summary", requireAdmin, asyncH(async (req, res) => {
  const _id = oid(req.params.id);
  const e = _id && await electionsCol.findOne({ _id });
  if (!e) return res.status(404).json({ error: "Election not found." });
  const votes = await votesCol.find({ electionId: _id }).sort({ submittedAt: -1 }).toArray();
  const posts = e.posts.map((p) => {
    const counts = Object.fromEntries(p.candidates.map((c) => [c, 0]));
    votes.forEach((v) => {
      const ch = (v.choices || []).find((x) => x.postId === p.id);
      if (ch && Object.prototype.hasOwnProperty.call(counts, ch.candidate)) counts[ch.candidate]++;
    });
    return { id: p.id, title: p.title, counts };
  });
  res.json({
    election: { ...publicElection(e), passcode: e.passcode },
    totalBallots: votes.length,
    posts,
    votes: votes.map((v) => ({ prn: v.prn, email: v.email || v.mobile || "", choices: v.choices || [], submittedAt: v.submittedAt })),
  });
}));

/* ---------- student register and teacher-marked attendance ---------- */
app.get("/api/admin/students", requireAdmin, asyncH(async (_req, res) => {
  const students = await studentsCol.find({}, { projection: { _id: 0, rollNo: 1, name: 1, prn: 1 } }).sort({ rollNo: 1, name: 1 }).limit(2000).toArray();
  res.json({ students });
}));
app.post("/api/admin/students", requireAdmin, asyncH(async (req, res) => {
  const student = Student.normalize(req.body);
  if (!Student.isValid(student)) return res.status(400).json({ error: "Roll number, name and PRN are required." });
  try {
    await studentsCol.updateOne({ prn: student.prn }, { $set: student, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
    res.status(201).json({ ok: true, student });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "Roll number or PRN is already registered." });
    throw err;
  }
}));
app.delete("/api/admin/students/:prn", requireAdmin, asyncH(async (req, res) => {
  const prn = String(req.params.prn || "").trim().toUpperCase();
  await studentsCol.deleteOne({ prn });
  res.json({ ok: true });
}));
app.get("/api/admin/attendance", requireAdmin, asyncH(async (req, res) => {
  const e = await getActiveElection();
  if (!e) return res.status(403).json({ error: "Create/activate an election first." });
  const year = ["SY", "TY"].includes(String(req.query.classYear || "").toUpperCase()) ? String(req.query.classYear).toUpperCase() : null;
  const studentFilter = year ? { classYear: year } : {};
  const [students, marks] = await Promise.all([studentsCol.find(studentFilter, { projection: { _id: 0 } }).sort({ name: 1 }).toArray(), attendanceCol.find({ electionId: e._id }).toArray()]);
  const marked = new Map(marks.map(a => [a.prn, a]));
  res.json({ election: publicElection(e), students: students.map(st => ({ ...st, present: !!marked.get(st.prn)?.present, markedAt: marked.get(st.prn)?.markedAt || null })) });
}));
app.post("/api/admin/attendance", requireAdmin, asyncH(async (req, res) => {
  const e = await getActiveElection();
  if (!e) return res.status(403).json({ error: "Create/activate an election first." });
  const entries = Array.isArray(req.body.entries) ? req.body.entries : [];
  if (entries.length > 2000) return res.status(400).json({ error: "Submit at most 2000 attendance entries at a time." });
  let marked = 0;
  for (const entry of entries) {
    const prn = String(entry.prn || "").trim().toUpperCase();
    const student = await studentsCol.findOne({ prn }, { projection: { _id: 0, prn: 1, name: 1, rollNo: 1 } });
    if (!student) continue;
    await attendanceCol.updateOne({ electionId: e._id, prn }, { $set: { electionId: e._id, electionName: e.name, prn, studentName: student.name, rollNo: student.rollNo, present: entry.present === true, markedAt: new Date(), markedBy: req.admin.username } }, { upsert: true });
    marked++;
  }
  res.json({ ok: true, marked });
}));

/* ---------- admin-only database viewer ---------- */
const viewable = () => ({ elections: electionsCol, votes: votesCol, admins: adminsCol, students: studentsCol, attendance: attendanceCol });
app.get("/api/admin/database", requireAdmin, asyncH(async (_req, res) => {
  const cols = viewable();
  const out = [];
  for (const [name, col] of Object.entries(cols)) out.push({ name, count: await col.countDocuments() });
  res.json({ database: DB_NAME, collections: out });
}));
app.get("/api/admin/database/:name", requireAdmin, asyncH(async (req, res) => {
  const col = viewable()[req.params.name];
  if (!col) return res.status(404).json({ error: "Unknown collection." });
  const projection = req.params.name === "admins" ? { hash: 0, salt: 0 } : {}; // never expose password hashes
  const docs = await col.find({}, { projection }).sort({ _id: -1 }).limit(500).toArray();
  res.json({ name: req.params.name, count: docs.length, documents: docs });
}));

app.use("/api", (_req, res) => res.status(404).json({ error: "Not found." }));

/* =============== START =============== */
(async () => {
  await setupMail();
  await client.connect();
  const db = client.db(DB_NAME);
  adminsCol = db.collection("admins");
  electionsCol = db.collection("elections");
  votesCol = db.collection("votes");
  otpsCol = db.collection("otps");
  studentsCol = db.collection("students");
  attendanceCol = db.collection("attendance");
  // Migrate older student records to the requested three-field register.
  try { await studentsCol.dropIndex("email_1"); } catch { /* legacy index may not exist */ }
  const legacyStudents = await studentsCol.find({ $or: [{ email: { $exists: true } }, { classYear: { $exists: true } }, { rollNo: { $exists: false } }] }).toArray();
  for (const oldStudent of legacyStudents) {
    await studentsCol.updateOne({ _id: oldStudent._id }, {
      $set: { rollNo: oldStudent.rollNo || oldStudent.prn },
      $unset: { email: "", classYear: "", updatedAt: "" }
    });
  }
  await studentsCol.createIndex({ prn: 1 }, { unique: true });
  await studentsCol.createIndex({ rollNo: 1 }, { unique: true, sparse: true });
  await attendanceCol.createIndex({ electionId: 1, prn: 1 }, { unique: true });
  console.log(`MVC models loaded: Student, Attendance (${AttendanceModel.collectionName})`);

  // one vote per PRN and per verified email, per election
  try { await votesCol.dropIndex("prn_1"); } catch { /* legacy index not present */ }
  await votesCol.createIndex({ electionId: 1, prn: 1 }, { unique: true });
  await votesCol.createIndex({ electionId: 1, emailKey: 1 }, { unique: true, partialFilterExpression: { emailKey: { $type: "string" } } });
  await otpsCol.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // expired OTPs vanish automatically

  if (!(await getAdmin())) {
    await adminsCol.insertOne({ _id: "admin", username: ADMIN_USERNAME, ...hashPassword(ADMIN_PASSWORD), tokenVersion: 0, updatedAt: new Date() });
    console.log(`Created first admin account "${ADMIN_USERNAME}" (change it from the dashboard).`);
  }
  // migrate older data (fixed President / Vice President fields) to the flexible "posts" format
  for (const e of await electionsCol.find({ posts: { $exists: false }, president: { $exists: true } }).toArray()) {
    const posts = [
      { id: newPostId(), title: "President", candidates: e.president || [] },
      { id: newPostId(), title: "Vice President", candidates: e.vice || [] },
    ];
    await electionsCol.updateOne({ _id: e._id }, { $set: { posts }, $unset: { president: "", vice: "" } });
    await votesCol.updateMany({ electionId: e._id, choices: { $exists: false } }, [
      { $set: { choices: [
        { postId: posts[0].id, post: "President", candidate: "$president" },
        { postId: posts[1].id, post: "Vice President", candidate: "$vice" },
      ] } },
      { $unset: ["president", "vice"] },
    ]);
  }
  if ((await electionsCol.countDocuments()) === 0) {
    const now = Date.now();
    await electionsCol.insertOne({
      name: "Student Council Election 2026",
      startTime: new Date(now - 5 * 60 * 1000).toISOString(),
      endTime: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
      passcode: "CAMPUS26",
      posts: [
        { id: newPostId(), title: "President", candidates: ["Aditi Sharma", "Rahul Patil", "Neha Joshi"] },
        { id: newPostId(), title: "Vice President", candidates: ["Arjun Deshmukh", "Priya Kulkarni", "Sameer Shah"] },
      ],
      active: true, createdAt: new Date(),
    });
  }
  console.log(`Connected to MongoDB database "${DB_NAME}"`);
  app.listen(PORT, "0.0.0.0",() => console.log(`CampusVote running at http://localhost:${PORT}`));
})().catch((err) => {
  console.error("Failed to start:", err.message);
  process.exit(1);
});
