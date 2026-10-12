const $ = (id) => document.getElementById(id);

let election = null;      // active election as returned at student login
let currentPRN = "";
let voteToken = "";
let pending = { passcode: "", prn: "", email: "" };
let resendTimer = null;
let adminToken = "";

/* ---------- API helper ---------- */
async function api(path, { method = "GET", body, auth = false } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (auth) headers.Authorization = `Bearer ${adminToken}`;
  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error("Cannot reach the server. Please check your connection and try again.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || "Something went wrong.");
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}

/* ---------- UI helpers ---------- */
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}
function showNotice(message, type = "error") {
  const el = $("notice");
  el.textContent = message;
  el.className = `notice ${type}`;
}
function clearNotice() { $("notice").className = "notice hidden"; $("notice").textContent = ""; }
function showLogin() {
  $("studentView").classList.add("hidden"); $("adminView").classList.add("hidden");
  document.querySelector(".app-card").classList.remove("hidden");
  document.querySelector(".hero").classList.remove("hidden");
  $("studentTab").classList.add("active"); $("adminTab").classList.remove("active");
  $("studentForm").classList.remove("hidden"); $("adminForm").classList.add("hidden");
  resetOtpStep();
  clearNotice();
  loadSidePosts();
}
function selectTab(tab) {
  clearNotice();
  const isStudent = tab === "student";
  $("studentTab").classList.toggle("active", isStudent);
  $("adminTab").classList.toggle("active", !isStudent);
  resetOtpStep();
  $("studentForm").classList.toggle("hidden", !isStudent);
  $("adminForm").classList.toggle("hidden", isStudent);
}
$("studentTab").addEventListener("click", () => selectTab("student"));
$("adminTab").addEventListener("click", () => selectTab("admin"));

function stateText(state) {
  return ({ "not-configured":"Not configured", invalid:"Invalid timing", upcoming:"Scheduled", open:"Voting is open", ended:"Voting ended" })[state] || state;
}
function niceDate(value) {
  if (!value) return "Not set";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "Not set" : d.toLocaleString([], { dateStyle:"medium", timeStyle:"short" });
}
// ISO string (UTC) -> value for <input type="datetime-local"> in the browser's local time
function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function cleanNames(value) {
  return value.split("\n").map(s => s.trim()).filter(Boolean).filter((s, i, a) => a.findIndex(x => x.toLowerCase() === s.toLowerCase()) === i);
}
function initials(name) { return name.split(/\s+/).slice(0,2).map(s => s[0]).join("").toUpperCase(); }
function setBusy(btn, busy) { btn.disabled = busy; btn.style.opacity = busy ? ".65" : ""; }

async function loadSidePosts() {
  try {
    const e = await api("/election");
    $("sidePosts").textContent = e ? String(e.posts.length).padStart(2, "0") : "--";
  } catch { $("sidePosts").textContent = "--"; }
}
loadSidePosts();

/* =============== Student flow =============== */
function resetOtpStep() {
  clearInterval(resendTimer);
  $("otpForm").classList.add("hidden");
  $("otpCode").value = "";
  pending = { passcode: "", prn: "", email: "" };
}
function startResendCountdown(sec) {
  clearInterval(resendTimer);
  const btn = $("resendOtp");
  let left = sec;
  const tick = () => {
    btn.disabled = left > 0;
    btn.textContent = left > 0 ? `Resend OTP in ${left}s` : "Resend OTP";
    if (left-- <= 0) clearInterval(resendTimer);
  };
  tick(); resendTimer = setInterval(tick, 1000);
}
async function requestOtp(fromResend = false) {
  clearNotice();
  const body = fromResend ? pending : {
    passcode: $("studentPasscode").value.trim(),
    prn: $("prn").value.trim().toUpperCase(),
    name: $("studentName").value.trim(),
    classYear: $("classYear").value,
    email: $("email").value.trim(),
  };
  if (!body.passcode || !body.prn || !body.name || !body.classYear || !body.email) return showNotice("Enter your passcode, name, class/year, PRN and email address.");
  const btn = fromResend ? $("resendOtp") : $("sendOtpBtn");
  setBusy(btn, true);
  try {
    const res = await api("/student/send-otp", { method: "POST", body });
    pending = { ...body };
    $("studentForm").classList.add("hidden");
    $("otpForm").classList.remove("hidden");
    $("otpInfo").textContent = `We sent a 6-digit OTP to ${res.emailMasked}. It is valid for ${Math.round(res.expiresInSec / 60)} minutes. If it does not arrive, check your spam folder.`;
    const dev = $("devOtpNote");
    if (res.devOtp) { dev.textContent = `Demo mode (no email sent): your OTP is ${res.devOtp}`; dev.className = "notice info"; }
    else dev.className = "notice hidden";
    $("otpCode").value = ""; $("otpCode").focus();
    startResendCountdown(res.resendInSec || 30);
    if (fromResend) showNotice("A new OTP has been sent.", "success");
  } catch (err) {
    showNotice(err.message);
    if (err.data?.retryAfter) startResendCountdown(err.data.retryAfter);
  } finally { setBusy(btn, false); }
}
$("studentForm").addEventListener("submit", (event) => { event.preventDefault(); requestOtp(false); });
$("resendOtp").addEventListener("click", () => requestOtp(true));
$("changeNumber").addEventListener("click", () => {
  clearInterval(resendTimer);
  $("otpForm").classList.add("hidden"); $("studentForm").classList.remove("hidden"); clearNotice();
});
$("otpForm").addEventListener("submit", async (event) => {
  event.preventDefault(); clearNotice();
  const otp = $("otpCode").value.trim();
  if (!/^\d{6}$/.test(otp)) return showNotice("Enter the 6-digit OTP.");
  const btn = $("verifyOtpBtn");
  setBusy(btn, true);
  try {
    const res = await api("/student/verify-otp", { method: "POST", body: { prn: pending.prn, email: pending.email, otp } });
    election = res.election;
    currentPRN = res.prn;
    voteToken = res.token;
    clearInterval(resendTimer);
    openBallot();
  } catch (err) { showNotice(err.message); }
  finally { setBusy(btn, false); }
});

function openBallot() {
  document.querySelector(".app-card").classList.add("hidden");
  document.querySelector(".hero").classList.add("hidden");
  $("studentView").classList.remove("hidden"); $("adminView").classList.add("hidden");
  $("studentElectionLabel").textContent = election.name;
  $("electionStatus").textContent = `● ${stateText(election.state)} · Closes ${niceDate(election.endTime)} · Signed in with PRN ${currentPRN}`;
  $("ballotPosts").innerHTML = election.posts.map((p, idx) => `
    <div class="position-block">
      <div class="position-title"><span class="position-number">${String(idx + 1).padStart(2, "0")}</span><div><h3>${escapeHTML(p.title)}</h3><p>Select one candidate</p></div></div>
      <div class="candidate-grid">${p.candidates.map((name, i) => {
        const id = `c-${p.id}-${i}`;
        return `<div class="candidate-option"><input type="radio" id="${id}" name="post-${p.id}" value="${escapeHTML(name)}" required><label for="${id}"><span class="avatar">${escapeHTML(initials(name))}</span><span class="candidate-name">${escapeHTML(name)}</span><span class="radio-mark"></span></label></div>`;
      }).join("")}</div>
    </div>`).join("");
}

$("ballotForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentPRN || !election) return alert("Please sign in again.");
  const choices = {}, lines = [];
  for (const p of election.posts) {
    const picked = document.querySelector(`input[name="post-${p.id}"]:checked`);
    if (!picked) return alert(`Please select one candidate for ${p.title}.`);
    choices[p.id] = picked.value;
    lines.push(`${p.title}: ${picked.value}`);
  }
  if (!confirm(`Confirm your ballot?\n${lines.join("\n")}\n\nYou cannot change your vote after submission.`)) return;
  const btn = $("submitVote");
  setBusy(btn, true);
  try {
    await api("/vote", { method: "POST", body: { token: voteToken, choices } });
  } catch (err) {
    setBusy(btn, false);
    return alert(err.message);
  }
  setBusy(btn, false);
  currentPRN = ""; voteToken = "";
  $("ballotForm").reset();
  $("studentView").classList.add("hidden");
  document.querySelector(".hero").classList.remove("hidden");
  document.querySelector(".app-card").classList.remove("hidden");
  selectTab("student");
  $("studentPasscode").value = ""; $("prn").value = ""; $("studentName").value = ""; $("classYear").value = ""; $("email").value = "";
  resetOtpStep(); $("studentForm").classList.remove("hidden");
  showNotice("Your ballot has been submitted successfully. Thank you for participating!", "success");
});
$("studentLogout").addEventListener("click", () => { currentPRN = ""; voteToken = ""; $("ballotForm").reset(); showLogin(); });

/* =============== Admin flow =============== */
let elections = [], selectedId = "", mode = "edit", lastPosts = [], lastVotes = [], lastName = "votes", dbCurrent = "votes";

function showAdminLogin(msg) {
  adminToken = "";
  showLogin(); selectTab("admin");
  if (msg) showNotice(msg);
}
function handleErr(err) {
  if (err.status === 401 && adminToken) { showAdminLogin(err.message); return; }
  alert(err.message);
}

$("adminForm").addEventListener("submit", async (event) => {
  event.preventDefault(); clearNotice();
  const btn = event.submitter || event.target.querySelector("button[type=submit]");
  setBusy(btn, true);
  try {
    const { token } = await api("/admin/login", { method: "POST", body: { username: $("adminUser").value.trim(), password: $("adminPassword").value } });
    adminToken = token;
    $("adminPassword").value = "";
    document.querySelector(".app-card").classList.add("hidden");
    document.querySelector(".hero").classList.add("hidden");
    $("studentView").classList.add("hidden"); $("adminView").classList.remove("hidden");
    await loadElections();
  } catch (err) { showNotice(err.message); }
  finally { setBusy(btn, false); }
});

async function loadElections(preferId) {
  const { elections: list } = await api("/admin/elections", { auth: true });
  elections = list;
  const sel = $("electionSelect");
  sel.innerHTML = list.map(e => `<option value="${e.id}">${escapeHTML(e.name)}${e.active ? " ● active" : ""} (${e.ballots} vote${e.ballots === 1 ? "" : "s"})</option>`).join("");
  const active = list.find(e => e.active);
  $("activeName").textContent = active ? active.name : "None";
  if (!list.length) { selectedId = ""; startNew(); clearSummary(); await loadDbTabs(); return; }
  selectedId = preferId && list.some(e => e.id === preferId) ? preferId : (active || list[0]).id;
  sel.value = selectedId;
  await loadSelected();
  await loadDbTabs();
}
function clearSummary() {
  $("adminStatus").textContent = "—"; $("adminTimeSummary").textContent = "Create an election to begin";
  $("voterCount").textContent = "0"; $("resultsArea").innerHTML = ""; lastPosts = []; lastVotes = []; renderVoteTable();
  $("activateBtn").disabled = true; $("deleteElectionBtn").disabled = true;
}

/* ----- posts editor ----- */
function postBlockHTML(p = {}) {
  return `<div class="post-edit" data-id="${escapeHTML(p.id || "")}">
    <div class="post-edit-head"><input class="post-title" required maxlength="80" placeholder="Post title, e.g. President" value="${escapeHTML(p.title || "")}"><button type="button" class="text-btn remove-post">Remove</button></div>
    <textarea class="post-cands" rows="3" required placeholder="One candidate per line">${escapeHTML((p.candidates || []).join("\n"))}</textarea>
  </div>`;
}
function renderPostsEditor(posts) { $("postsEditor").innerHTML = posts.map(postBlockHTML).join(""); }
function readPosts() {
  return [...document.querySelectorAll("#postsEditor .post-edit")].map(el => ({
    id: el.dataset.id || undefined,
    title: el.querySelector(".post-title").value.trim(),
    candidates: cleanNames(el.querySelector(".post-cands").value),
  }));
}
$("addPostBtn").addEventListener("click", () => {
  $("postsEditor").insertAdjacentHTML("beforeend", postBlockHTML());
  $("postsEditor").lastElementChild.querySelector(".post-title").focus();
});
$("postsEditor").addEventListener("click", (e) => {
  if (!e.target.classList.contains("remove-post")) return;
  if (document.querySelectorAll("#postsEditor .post-edit").length <= 1) return alert("An election needs at least one post.");
  e.target.closest(".post-edit").remove();
});

function setForm(e) {
  $("electionName").value = e ? e.name : "";
  $("startTime").value = e ? toLocalInput(e.startTime) : toLocalInput(new Date(Date.now() - 5 * 60000).toISOString());
  $("endTime").value = e ? toLocalInput(e.endTime) : toLocalInput(new Date(Date.now() + 24 * 3600000).toISOString());
  $("electionCode").value = e ? e.passcode : "";
  renderPostsEditor(e ? e.posts : [{ title: "President" }, { title: "Vice President" }]);
}
function startNew() {
  mode = "new"; setForm(null);
  $("formTitle").textContent = "Create new election"; $("formTag").textContent = "New";
  $("saveLabel").textContent = "Create election";
}
async function loadSelected() {
  mode = "edit";
  $("formTitle").textContent = "Election setup"; $("formTag").textContent = "Editing";
  $("saveLabel").textContent = "Save election settings";
  const s = await api(`/admin/elections/${selectedId}/summary`, { auth: true });
  const e = s.election;
  setForm(e);
  lastName = e.name; lastPosts = e.posts; lastVotes = s.votes;
  $("adminStatus").textContent = stateText(e.state);
  $("adminTimeSummary").textContent = `${niceDate(e.startTime)} — ${niceDate(e.endTime)}`;
  $("voterCount").textContent = s.totalBallots;
  $("resultsArea").innerHTML = s.posts.map(p => renderResultGroup(p.title, p.counts)).join("");
  renderVoteTable();
  $("activateBtn").disabled = e.active; $("activateBtn").textContent = e.active ? "Active ✓" : "Make active";
  $("deleteElectionBtn").disabled = false;
}

function renderResultGroup(title, counts) {
  const names = Object.keys(counts);
  const max = Math.max(0, ...Object.values(counts));
  const lines = names.map(name => {
    const count = counts[name] || 0, width = max ? count / max * 100 : 0;
    return `<div class="result-line"><div class="result-label"><span>${escapeHTML(name)}${count > 0 && count === max ? '<span class="small-badge">Leading</span>' : ''}</span><span>${count} vote${count === 1 ? "" : "s"}</span></div><div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div></div>`;
  }).join("");
  return `<div class="result-group"><h4>${escapeHTML(title)}</h4>${lines || '<div class="empty-results">No candidates configured.</div>'}</div>`;
}
function choiceFor(vote, post) {
  return (vote.choices.find(c => c.postId === post.id) || {}).candidate || "—";
}
function renderVoteTable() {
  $("recordsHead").innerHTML = `<tr><th>PRN</th><th>Email</th>${lastPosts.map(p => `<th>${escapeHTML(p.title)}</th>`).join("")}<th>Submitted</th></tr>`;
  const cols = lastPosts.length + 3;
  $("voteRecords").innerHTML = lastVotes.length
    ? lastVotes.map(v => `<tr><td>${escapeHTML(v.prn)}</td><td>${escapeHTML(v.email || "—")}</td>${lastPosts.map(p => `<td>${escapeHTML(choiceFor(v, p))}</td>`).join("")}<td>${escapeHTML(niceDate(v.submittedAt))}</td></tr>`).join("")
    : `<tr><td colspan="${cols}" class="empty-results">No votes recorded yet.</td></tr>`;
}

$("electionSelect").addEventListener("change", async (e) => {
  selectedId = e.target.value;
  try { await loadSelected(); } catch (err) { handleErr(err); }
});
$("newElectionBtn").addEventListener("click", startNew);
$("refreshResults").addEventListener("click", async () => {
  try { await loadElections(selectedId); } catch (err) { handleErr(err); }
});
$("activateBtn").addEventListener("click", async () => {
  try { await api(`/admin/elections/${selectedId}/activate`, { method: "POST", auth: true }); await loadElections(selectedId); }
  catch (err) { handleErr(err); }
});
$("deleteElectionBtn").addEventListener("click", async () => {
  const e = elections.find(x => x.id === selectedId);
  if (!e) return;
  if (!confirm(`Delete "${e.name}" and all ${e.ballots} recorded vote(s) from the database? This cannot be undone.`)) return;
  try { await api(`/admin/elections/${selectedId}`, { method: "DELETE", auth: true }); await loadElections(); }
  catch (err) { handleErr(err); }
});

$("settingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const start = $("startTime").value, end = $("endTime").value;
  if (!start || !end || new Date(end) <= new Date(start)) return alert("Please set a valid end time that is after the start time.");
  const body = {
    name: $("electionName").value.trim(),
    startTime: new Date(start).toISOString(),
    endTime: new Date(end).toISOString(),
    passcode: $("electionCode").value.trim(),
    posts: readPosts(),
  };
  try {
    if (mode === "new") {
      const { id } = await api("/admin/elections", { method: "POST", auth: true, body });
      await loadElections(id);
      alert("Election created and set as active.");
    } else {
      await api(`/admin/elections/${selectedId}`, { method: "PUT", auth: true, body });
      await loadElections(selectedId);
      alert("Election settings saved.");
    }
  } catch (err) { handleErr(err); }
});

/* ----- change admin username / password ----- */
$("accountForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = { currentPassword: $("currentPassword").value, newUsername: $("newUsername").value.trim(), newPassword: $("newPassword").value };
  try {
    const res = await api("/admin/credentials", { method: "POST", auth: true, body });
    adminToken = res.token;
    $("accountForm").reset();
    alert(`Credentials updated. Your username is now "${res.username}".`);
  } catch (err) { alert(err.message); }
});

/* ----- CSV export ----- */
$("downloadCsv").addEventListener("click", () => {
  const q = v => `"${String(v).replace(/"/g, '""')}"`;
  const rows = [["PRN", "Email", ...lastPosts.map(p => p.title), "Submitted at"],
    ...lastVotes.map(v => [v.prn, v.email || "", ...lastPosts.map(p => choiceFor(v, p)), v.submittedAt])];
  const blob = new Blob([rows.map(r => r.map(q).join(",")).join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = `${lastName.replace(/[^\w\-]+/g, "_")}_votes.csv`; a.click();
  URL.revokeObjectURL(a.href);
});

/* ----- admin-only database viewer ----- */
async function loadDbTabs() {
  try {
    const { database, collections } = await api("/admin/database", { auth: true });
    $("dbName").textContent = `· ${database}`;
    $("dbTabs").innerHTML = collections.map(c => `<button type="button" class="db-tab${c.name === dbCurrent ? " active" : ""}" data-name="${c.name}">${c.name} (${c.count})</button>`).join("");
    await loadDbCollection(dbCurrent);
  } catch (err) { handleErr(err); }
}
async function loadDbCollection(name) {
  dbCurrent = name;
  document.querySelectorAll(".db-tab").forEach(t => t.classList.toggle("active", t.dataset.name === name));
  const { documents } = await api(`/admin/database/${name}`, { auth: true });
  const keys = [...new Set(documents.flatMap(d => Object.keys(d)))];
  $("dbHead").innerHTML = `<tr>${keys.map(k => `<th>${escapeHTML(k)}</th>`).join("")}</tr>`;
  $("dbBody").innerHTML = documents.length
    ? documents.map(d => `<tr>${keys.map(k => {
        const v = d[k];
        const text = v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
        return `<td class="cell-json" title="${escapeHTML(text)}">${escapeHTML(text)}</td>`;
      }).join("")}</tr>`).join("")
    : `<tr><td class="empty-results">This collection is empty.</td></tr>`;
}
$("dbTabs").addEventListener("click", async (e) => {
  const name = e.target.dataset && e.target.dataset.name;
  if (!name) return;
  try { await loadDbCollection(name); } catch (err) { handleErr(err); }
});

$("adminLogout").addEventListener("click", () => {
  adminToken = "";
  $("dbBody").innerHTML = ""; $("dbHead").innerHTML = ""; // don't leave database contents in the page after sign-out
  showLogin();
});
