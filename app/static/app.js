const state = {
  user: null,
  downloads: [],
  files: [],
  users: [],
  poller: null,
};

const $ = (selector) => document.querySelector(selector);

async function loadVersion() {
  const targets = document.querySelectorAll("[data-version]");
  if (!targets.length) return;
  try {
    const payload = await api("/api/health");
    const shortSha = payload.build_sha ? payload.build_sha.slice(0, 7) : "dev";
    targets.forEach((target) => {
      target.textContent = `v${payload.version || "0.1.0"} · ${shortSha}`;
    });
  } catch {
    targets.forEach((target) => {
      target.textContent = "Version unbekannt";
    });
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index ? 1 : 0)} ${units[index]}`;
}

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("de-DE", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) {
    throw new Error(payload.detail || "Anfrage fehlgeschlagen");
  }
  return payload;
}

function showLogin() {
  $("#loginView").hidden = false;
  $("#appView").hidden = true;
  if (state.poller) clearInterval(state.poller);
}

function showApp() {
  $("#loginView").hidden = true;
  $("#appView").hidden = false;
  $("#currentUser").textContent = state.user?.is_admin
    ? `${state.user.username} · Admin`
    : state.user?.username;
  $("#adminPanel").hidden = !state.user?.is_admin;
}

async function refreshAll() {
  if (!state.user) return;
  await Promise.all([loadDownloads(), loadFiles(), state.user.is_admin ? loadUsers() : Promise.resolve()]);
}

async function loadDownloads() {
  const payload = await api("/api/downloads");
  state.downloads = payload.downloads;
  renderDownloads();
}

async function loadFiles() {
  const payload = await api("/api/files");
  state.files = payload.files;
  renderFiles();
}

async function loadUsers() {
  const payload = await api("/api/admin/users");
  state.users = payload.users;
  renderUsers();
}

function renderDownloads() {
  const target = $("#downloadList");
  if (!state.downloads.length) {
    target.innerHTML = '<div class="empty-state">Keine Downloads</div>';
    return;
  }

  target.innerHTML = state.downloads
    .map((item) => {
      const title = item.title || item.url;
      const canCancel = ["queued", "running"].includes(item.status);
      const canDelete = state.user?.is_admin && item.status !== "running";
      const progress = Math.max(0, Math.min(100, item.progress || 0));
      const detail = [item.mode, item.speed, item.eta ? `ETA ${item.eta}` : null]
        .filter(Boolean)
        .join(" · ");
      return `
        <article class="download-card">
          <div class="download-top">
            <div>
              <div class="download-title">${escapeHtml(title)}</div>
              <div class="meta">${escapeHtml(detail || item.url)}</div>
            </div>
            <span class="badge ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span>
          </div>
          <div class="progress-track"><div class="progress-bar" style="width: ${progress}%"></div></div>
          <div class="meta">${progress.toFixed(0)}% · ${escapeHtml(formatDate(item.created_at))}</div>
          ${item.error ? `<div class="meta">${escapeHtml(item.error)}</div>` : ""}
          <div class="card-actions">
            ${
              canCancel
                ? `<button class="ghost danger" type="button" data-action="cancel" data-id="${item.id}">Stoppen</button>`
                : ""
            }
            ${
              canDelete
                ? `<button class="ghost danger" type="button" data-action="delete" data-id="${item.id}">Entfernen</button>`
                : ""
            }
          </div>
        </article>
      `;
    })
    .join("");
}

function renderFiles() {
  const target = $("#fileList");
  if (!state.files.length) {
    target.innerHTML = '<div class="empty-state">Keine Dateien</div>';
    return;
  }

  target.innerHTML = state.files
    .map(
      (file) => `
        <div class="file-row">
          <div class="row-top">
            <a class="file-name" href="${escapeHtml(file.url)}">${escapeHtml(file.name)}</a>
          </div>
          <div class="meta">${formatBytes(file.size)} · ${escapeHtml(formatDate(file.modified_at))}</div>
        </div>
      `,
    )
    .join("");
}

function renderUsers() {
  const target = $("#userList");
  target.innerHTML = state.users
    .map(
      (user) => `
        <div class="user-row">
          <div class="row-top">
            <div>
              <div class="user-name">${escapeHtml(user.username)}</div>
              <div class="meta">${user.is_admin ? "Admin" : "User"} · ${escapeHtml(formatDate(user.created_at))}</div>
            </div>
          </div>
          <div class="user-actions">
            <button class="ghost" type="button" data-user-action="password" data-id="${user.id}">Passwort</button>
            ${
              user.id !== state.user.id
                ? `<button class="ghost danger" type="button" data-user-action="delete" data-id="${user.id}">Loeschen</button>`
                : ""
            }
          </div>
        </div>
      `,
    )
    .join("");
}

async function boot() {
  await loadVersion();
  try {
    const payload = await api("/api/me");
    state.user = payload.user;
    showApp();
    await refreshAll();
    state.poller = setInterval(refreshAll, 2500);
  } catch {
    showLogin();
  }
}

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const loginForm = event.currentTarget;
  $("#loginError").textContent = "";
  const form = new FormData(loginForm);
  try {
    const payload = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        username: form.get("username"),
        password: form.get("password"),
      }),
    });
    state.user = payload.user;
    loginForm?.reset();
    showApp();
    await refreshAll();
    state.poller = setInterval(refreshAll, 2500);
  } catch (error) {
    $("#loginError").textContent = error.message;
  }
});

$("#logoutButton").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  state.user = null;
  showLogin();
});

$("#downloadForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const downloadForm = event.currentTarget;
  $("#downloadError").textContent = "";
  const form = new FormData(downloadForm);
  try {
    await api("/api/downloads", {
      method: "POST",
      body: JSON.stringify({
        url: form.get("url"),
        mode: form.get("mode"),
        playlist: form.get("playlist") === "on",
      }),
    });
    downloadForm?.reset();
    await loadDownloads();
  } catch (error) {
    $("#downloadError").textContent = error.message;
  }
});

$("#downloadList").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const id = button.dataset.id;
  button.disabled = true;
  try {
    if (button.dataset.action === "cancel") {
      await api(`/api/downloads/${id}/cancel`, { method: "POST" });
    } else if (button.dataset.action === "delete") {
      await api(`/api/downloads/${id}`, { method: "DELETE" });
    }
    await loadDownloads();
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
  }
});

$("#refreshButton").addEventListener("click", loadDownloads);
$("#refreshFilesButton").addEventListener("click", loadFiles);

$("#userForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const userForm = event.currentTarget;
  $("#userError").textContent = "";
  const form = new FormData(userForm);
  try {
    await api("/api/admin/users", {
      method: "POST",
      body: JSON.stringify({
        username: form.get("username"),
        password: form.get("password"),
        is_admin: form.get("is_admin") === "on",
      }),
    });
    userForm?.reset();
    await loadUsers();
  } catch (error) {
    $("#userError").textContent = error.message;
  }
});

$("#userList").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-user-action]");
  if (!button) return;
  const id = button.dataset.id;
  button.disabled = true;
  try {
    if (button.dataset.userAction === "delete") {
      await api(`/api/admin/users/${id}`, { method: "DELETE" });
    } else if (button.dataset.userAction === "password") {
      const password = prompt("Neues Passwort");
      if (!password) return;
      await api(`/api/admin/users/${id}/password`, {
        method: "PUT",
        body: JSON.stringify({ password }),
      });
    }
    await loadUsers();
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
  }
});

boot();
