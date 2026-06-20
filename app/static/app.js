const state = {
  user: null,
  downloads: [],
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
    const buildDate = payload.build_date && payload.build_date !== "unknown"
      ? payload.build_date.slice(0, 10)
      : "unknown";
    const impersonation = payload.curl_cffi_available ? "impersonation ok" : "impersonation missing";
    const deno = payload.deno_version && payload.deno_version !== "unavailable" ? "deno ok" : "deno missing";
    const label = `yt-dlp ${payload.yt_dlp_version || "unknown"} | YTDLP Client ${payload.version || "0.1.0"} ${shortSha} | updated ${buildDate} | ${impersonation} | ${deno}`;
    targets.forEach((target) => {
      target.textContent = label;
    });
  } catch {
    targets.forEach((target) => {
      target.textContent = "Version unknown";
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
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = Number(bytes);
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index ? 1 : 0)} ${units[index]}`;
}

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function settingsLabel(settings = {}) {
  const type = settings.media_type || "auto";
  if (type === "auto") return "Auto";
  if (type === "audio") {
    const label = ["Audio", settings.audio_format, settings.audio_bitrate]
      .filter((value) => value && value !== "auto")
      .join(" ");
    return label === "Audio" ? "Audio Auto" : label || "Audio Auto";
  }
  if (type === "captions") {
    const label = ["Captions", settings.caption_format, settings.caption_langs]
      .filter((value) => value && value !== "auto")
      .join(" ");
    return label === "Captions" ? "Captions Auto" : label || "Captions Auto";
  }
  if (type === "thumbnail") {
    const label = ["Thumbnail", settings.thumbnail_format]
      .filter((value) => value && value !== "auto")
      .join(" ");
    return label === "Thumbnail" ? "Thumbnail Auto" : label || "Thumbnail Auto";
  }
  const label = [
    "Video",
    settings.video_format,
    settings.video_codec,
    settings.video_quality && settings.video_quality !== "auto" ? `${settings.video_quality}p` : null,
  ]
    .filter((value) => value && value !== "auto")
    .join(" ");
  return label === "Video" ? "Video Auto" : label || "Video Auto";
}

function updateSettingVisibility() {
  const mediaType = $("#mediaType")?.value || "auto";
  const settingsPopover = $(".settings-popover");
  if (settingsPopover) {
    settingsPopover.hidden = mediaType === "auto";
    if (mediaType === "auto") {
      settingsPopover.open = false;
    }
  }
  document.querySelectorAll("[data-setting-group]").forEach((element) => {
    const group = element.dataset.settingGroup;
    element.hidden = mediaType !== group;
  });
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
    throw new Error(payload.detail || "Request failed");
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
  $(".workspace")?.classList.toggle("has-admin", Boolean(state.user?.is_admin));
  $("#currentUser").textContent = state.user?.is_admin
    ? `${state.user.username} - Admin`
    : state.user?.username;
  $("#adminPanel").hidden = !state.user?.is_admin;
}

async function refreshAll() {
  if (!state.user) return;
  await Promise.all([loadDownloads(), state.user.is_admin ? loadUsers() : Promise.resolve()]);
}

async function loadDownloads() {
  const payload = await api("/api/downloads");
  state.downloads = payload.downloads;
  renderDownloads();
}

async function loadUsers() {
  const payload = await api("/api/admin/users");
  state.users = payload.users;
  renderUsers();
}

function renderDownloads() {
  const target = $("#downloadList");
  if (!state.downloads.length) {
    target.innerHTML = '<div class="empty-state">No downloads</div>';
    return;
  }

  target.innerHTML = state.downloads
    .map((item) => {
      const title = item.title || item.url;
      const canCancel = ["queued", "running"].includes(item.status);
      const canDelete = item.status !== "running";
      const progress = Math.max(0, Math.min(100, item.progress || 0));
      const size = formatBytes(item.file_size);
      const detail = [settingsLabel(item.settings), size, item.speed, item.eta ? `ETA ${item.eta}` : null]
        .filter(Boolean)
        .join(" - ");
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
          <div class="meta">${progress.toFixed(0)}% - ${escapeHtml(formatDate(item.created_at))}</div>
          ${item.error ? `<div class="meta">${escapeHtml(item.error)}</div>` : ""}
          <div class="card-actions">
            ${
              item.file_url
                ? `<a class="icon-button" href="${escapeHtml(item.file_url)}" title="Download file" aria-label="Download file">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M12 3v11"></path>
                      <path d="m7 9 5 5 5-5"></path>
                      <path d="M5 20h14"></path>
                    </svg>
                  </a>`
                : ""
            }
            ${
              canCancel
                ? `<button class="ghost danger" type="button" data-action="cancel" data-id="${item.id}">Stop</button>`
                : ""
            }
            ${
              canDelete
                ? `<button class="ghost danger" type="button" data-action="delete" data-id="${item.id}">Remove</button>`
                : ""
            }
          </div>
        </article>
      `;
    })
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
              <div class="meta">${user.is_admin ? "Admin" : "User"} - ${escapeHtml(formatDate(user.created_at))}</div>
            </div>
          </div>
          <div class="user-actions">
            <button class="ghost" type="button" data-user-action="password" data-id="${user.id}">Password</button>
            ${
              user.id !== state.user.id
                ? `<button class="ghost danger" type="button" data-user-action="delete" data-id="${user.id}">Delete</button>`
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
        media_type: form.get("media_type"),
        video_format: form.get("video_format"),
        video_codec: form.get("video_codec"),
        video_quality: form.get("video_quality"),
        audio_format: form.get("audio_format"),
        audio_bitrate: form.get("audio_bitrate"),
        caption_format: form.get("caption_format"),
        caption_langs: form.get("caption_langs"),
        thumbnail_format: form.get("thumbnail_format"),
        playlist: form.get("playlist") === "on",
      }),
    });
    downloadForm?.reset();
    updateSettingVisibility();
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
$("#mediaType").addEventListener("change", updateSettingVisibility);

const settingsPopover = $(".settings-popover");
if (settingsPopover && window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
  settingsPopover.addEventListener("mouseenter", () => {
    settingsPopover.open = true;
  });
  settingsPopover.addEventListener("mouseleave", () => {
    settingsPopover.open = false;
  });
}

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
      const password = prompt("New password");
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

updateSettingVisibility();
boot();
