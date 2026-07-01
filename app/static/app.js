const state = {
  user: null,
  downloads: [],
  users: [],
  systemInfo: null,
  poller: null,
};

const APP_ID = "pulliku";
const APP_NAME = "Pulliku";
const APP_SUBTITLE = "Media Download Interface";
const THEME_KEY = `${APP_ID}-theme`;
const MODE_KEY = `${APP_ID}-mode`;
const LEGACY_PULLORA_THEME_KEY = "pullora-theme";
const LEGACY_PULLORA_MODE_KEY = "pullora-mode";
const LEGACY_THEME_KEY = "ytdlp-client-theme";
const LEGACY_MODE_KEY = "ytdlp-client-mode";
const CSRF_COOKIE = "pulliku_csrf";
const systemScheme = window.matchMedia("(prefers-color-scheme: dark)");
const THEMES = ["lavender", "mint", "sky", "amber", "rose", "graphite"];
const MODES = ["system", "light", "dark"];

const compatibleVideoCodecs = {
  auto: ["auto", "h264", "h265", "av1", "vp9"],
  mp4: ["auto", "h264", "h265", "av1"],
  webm: ["auto", "vp9", "av1"],
  mkv: ["auto", "h264", "h265", "av1", "vp9"],
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function cookieValue(name) {
  const prefix = `${encodeURIComponent(name)}=`;
  return document.cookie
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix))
    ?.slice(prefix.length) || "";
}

function migrateThemeStorage() {
  const oldTheme = localStorage.getItem(LEGACY_PULLORA_THEME_KEY) || localStorage.getItem(LEGACY_THEME_KEY);
  const oldMode = localStorage.getItem(LEGACY_PULLORA_MODE_KEY) || localStorage.getItem(LEGACY_MODE_KEY);
  if (!localStorage.getItem(THEME_KEY) && oldTheme) {
    localStorage.setItem(THEME_KEY, oldTheme);
  }
  if (!localStorage.getItem(MODE_KEY) && oldMode) {
    localStorage.setItem(MODE_KEY, oldMode);
  }
}

function savedTheme() {
  const theme = localStorage.getItem(THEME_KEY);
  return THEMES.includes(theme) ? theme : "lavender";
}

function savedMode() {
  const mode = localStorage.getItem(MODE_KEY);
  return MODES.includes(mode) ? mode : "system";
}

function resolvedMode(mode = savedMode()) {
  return mode === "system" ? (systemScheme.matches ? "dark" : "light") : mode;
}

function applyTheme() {
  const theme = savedTheme();
  const mode = savedMode();
  const resolved = resolvedMode(mode);
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.mode = mode;
  document.documentElement.dataset.resolvedMode = resolved;
  updateThemeControls(theme, mode);
  requestAnimationFrame(() => {
    const color = getComputedStyle(document.documentElement).getPropertyValue("--color-background").trim();
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color || (resolved === "dark" ? "#101316" : "#FFFBFF"));
  });
}

function updateThemeControls(theme = savedTheme(), mode = savedMode()) {
  $$("[data-theme-choice]").forEach((button) => {
    const selected = button.dataset.themeChoice === theme;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  $$("[data-mode-choice]").forEach((button) => {
    const selected = button.dataset.modeChoice === mode;
    button.setAttribute("aria-selected", String(selected));
  });
}

async function injectIcons() {
  const target = $("#iconSprite");
  if (!target) return;
  try {
    const response = await fetch("/static/icons/psu-icons.svg", { credentials: "same-origin" });
    target.innerHTML = await response.text();
    target.hidden = true;
  } catch {
    target.innerHTML = "";
    target.hidden = true;
  }
}

function initials(name) {
  return String(name || APP_NAME)
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("") || "PU";
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

function formatExpiryDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

async function api(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const csrfToken = cookieValue(CSRF_COOKIE);
    if (csrfToken) {
      headers["X-CSRF-Token"] = csrfToken;
    }
  }

  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    method,
    headers,
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

function selectedMediaType() {
  return new FormData($("#downloadForm")).get("media_type") || "video";
}

function settingsLabel(settings = {}) {
  const type = settings.media_type || "video";
  if (type === "audio") {
    const label = ["Audio", settings.audio_format, settings.audio_bitrate]
      .filter((value) => value && value !== "auto")
      .join(" ");
    return label === "Audio" ? "Audio Auto" : label || "Audio Auto";
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

function retentionLabel(item) {
  if (item.is_permanent) return "No expiration";
  if (item.status === "completed") {
    const expiresAt = formatExpiryDate(item.retention_expires_at);
    if (expiresAt) return `Expires: ${expiresAt}`;
    const days = Number(item.retention_days || 7);
    return days > 0 ? `Expires in ${days} days` : "No expiration";
  }
  return null;
}

function downloadSettingsSummary() {
  const form = new FormData($("#downloadForm"));
  const type = form.get("media_type") || "video";
  const playlist = form.get("playlist") === "on" ? "Playlist on" : "Playlist off";
  if (type === "audio") {
    return [
      "Audio",
      form.get("audio_format") === "auto" ? "Auto format" : String(form.get("audio_format")).toUpperCase(),
      ["flac", "wav"].includes(form.get("audio_format")) || form.get("audio_bitrate") === "auto"
        ? "Auto bitrate"
        : form.get("audio_bitrate"),
      playlist,
    ];
  }
  return [
    "Video",
    form.get("video_format") === "auto" ? "Auto format" : String(form.get("video_format")).toUpperCase(),
    form.get("video_codec") === "auto" ? "Auto codec" : String(form.get("video_codec")).toUpperCase(),
    playlist,
  ];
}

function renderOptionsSummary() {
  $("#optionsSummary").innerHTML = downloadSettingsSummary()
    .map((item) => `<span class="psu-chip">${escapeHtml(item)}</span>`)
    .join("");
}

function updateVideoCodecOptions() {
  const format = $("#videoFormat").value;
  const codec = $("#videoCodec");
  const allowed = compatibleVideoCodecs[format] || compatibleVideoCodecs.auto;
  Array.from(codec.options).forEach((option) => {
    option.disabled = !allowed.includes(option.value);
  });
  if (!allowed.includes(codec.value)) {
    codec.value = "auto";
  }
}

function updateAudioBitrateState() {
  const format = $("#audioFormat").value;
  const bitrate = $("#audioBitrate");
  const isLossless = ["flac", "wav"].includes(format);
  bitrate.disabled = isLossless;
  if (isLossless) {
    bitrate.value = "auto";
  }
}

function updateDownloadOptions() {
  const type = selectedMediaType();
  $$("[data-setting-group]").forEach((element) => {
    element.hidden = element.dataset.settingGroup !== type;
  });
  updateVideoCodecOptions();
  updateAudioBitrateState();
  renderOptionsSummary();
}

function setOptionsOpen(open) {
  $("#downloadOptionsPanel").hidden = !open;
  $("#optionsToggle").setAttribute("aria-expanded", String(open));
  $("#optionsDisclosure").dataset.open = String(open);
}

function resetDownloadOptions() {
  $("#downloadForm").reset();
  setOptionsOpen(false);
  updateDownloadOptions();
}

function showLogin() {
  $("#setupView").hidden = true;
  $("#loginView").hidden = false;
  $("#appView").hidden = true;
  $("#userMenu").hidden = true;
  if (state.poller) clearInterval(state.poller);
}

function showSetup(configured, missingConfig = "") {
  $("#setupView").hidden = false;
  $("#loginView").hidden = true;
  $("#appView").hidden = true;
  $("#userMenu").hidden = true;
  $("#setupRegisterWindow").hidden = !configured;
  $("#setupErrorWindow").hidden = configured;
  $("#setupMissingConfig").textContent = missingConfig || "ISHIKU_SETUP_SECRET_FILE";
  if (state.poller) clearInterval(state.poller);
  if (configured) {
    requestAnimationFrame(() => $("#setupSecret")?.focus());
  }
}

function showApp() {
  $("#setupView").hidden = true;
  $("#loginView").hidden = true;
  $("#appView").hidden = false;
  const name = state.user?.display_name || state.user?.username || APP_NAME;
  const avatar = initials(name);
  $("#currentUser").textContent = name;
  $("#avatarInitials").textContent = avatar;
  $("#accountAvatar").textContent = avatar;
  $("#accountName").textContent = name;
  $("#accountRole").textContent = state.user?.is_admin ? "Administrator" : "Local account";
  $("#userMenuTitle").textContent = APP_NAME;
  $("#adminTools").hidden = !state.user?.is_admin;
}

async function loadSystemInfo() {
  state.systemInfo = await api("/api/health");
  renderAboutInfo();
}

function renderAboutInfo() {
  const payload = state.systemInfo || {};
  const shortSha = payload.build_sha ? payload.build_sha.slice(0, 12) : "dev";
  const rows = [
    ["App Name", APP_NAME],
    ["Interface", APP_SUBTITLE],
    ["Pulliku version", payload.version || "0.1.1"],
    ["GitHub SHA", shortSha],
    ["Build date", payload.build_date || "unknown"],
    ["Data directory", payload.data_dir || "unknown"],
    ["Download directory", payload.download_dir || "unknown"],
    ["File retention", `${payload.file_retention_days ?? 7} days`],
    ["Database status", payload.database_status || "unknown"],
    ["Setup state", payload.setup_state || "unknown"],
    ["Health status", payload.status || "unknown"],
    ["Log level", payload.log_level || "info"],
    ["yt-dlp version", payload.yt_dlp_version || "unknown"],
    ["Public IP", payload.public_ip || "unavailable"],
    ["Impersonation", payload.curl_cffi_available ? "available" : "missing"],
    ["Deno", payload.deno_version || "unavailable"],
    ["yt-dlp-ejs", payload.yt_dlp_ejs_version || "unavailable"],
    ["ffmpeg", payload.ffmpeg_version || "unavailable"],
    ["Diagnostics", "No client-side errors recorded"],
    ["Logs", "Server logs are available through Docker"],
  ];
  $("#aboutInfo").innerHTML = rows
    .map(([label, value]) => `<div class="about-row"><span>${escapeHtml(label)}</span><code>${escapeHtml(value)}</code></div>`)
    .join("");
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

function renderQueueStats() {
  const counts = state.downloads.reduce(
    (acc, item) => {
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    },
    { running: 0, queued: 0, completed: 0, failed: 0 },
  );
  $("#queueStats").innerHTML = [
    `Active ${counts.running || 0}`,
    `Queued ${counts.queued || 0}`,
    `Completed ${counts.completed || 0}`,
    `Failed ${counts.failed || 0}`,
  ]
    .map((item) => `<span class="psu-chip">${escapeHtml(item)}</span>`)
    .join("");
}

function renderDownloads() {
  const target = $("#downloadList");
  renderQueueStats();
  if (!state.downloads.length) {
    target.innerHTML = `
      <div class="empty-state">
        <img src="/static/pulliku-logo.png" alt="" />
        <div>
          <strong>No downloads</strong>
          <div class="meta">Add a URL to start the first Pulliku queue item.</div>
        </div>
      </div>
    `;
    return;
  }

  target.innerHTML = state.downloads
    .map((item) => {
      const title = item.title || item.url;
      const canCancel = ["queued", "running"].includes(item.status);
      const canDelete = item.status !== "running";
      const canTogglePermanent = item.status === "completed";
      const retentionText = retentionLabel(item);
      const hasNoExpiration = canTogglePermanent && retentionText === "No expiration";
      const progress = Math.max(0, Math.min(100, item.progress || 0));
      const size = formatBytes(item.file_size);
      const detail = [settingsLabel(item.settings), size, item.speed, item.eta ? `ETA ${item.eta}` : null, formatDate(item.created_at)]
        .filter(Boolean)
        .join(" - ");
      return `
        <article class="download-card ${escapeHtml(item.status)}">
          <div class="download-top">
            <div>
              <div class="download-title">${escapeHtml(title)}</div>
              <div class="meta">${escapeHtml(detail || item.url)}</div>
            </div>
            <div class="download-badges">
              <span class="status-chip ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span>
            </div>
          </div>
          <div class="progress-track"><progress class="progress-bar" value="${progress}" max="100" aria-label="Download progress"></progress></div>
          ${item.error ? `<div class="meta">${escapeHtml(item.error)}</div>` : ""}
          <div class="card-actions">
            <div class="card-actions-left">
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
                item.open_file_url
                  ? `<a class="icon-button" href="${escapeHtml(item.open_file_url)}" target="_blank" rel="noopener" title="Open file" aria-label="Open file">
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M15 3h6v6"></path>
                        <path d="M10 14 21 3"></path>
                        <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"></path>
                      </svg>
                    </a>`
                  : ""
              }
              ${canCancel ? `<button class="psu-button psu-button--tonal" type="button" data-action="cancel" data-id="${item.id}">Stop</button>` : ""}
            </div>
            <div class="card-actions-right">
              ${
                canTogglePermanent
                  ? `<button class="retention-pill ${item.is_permanent ? "is-permanent" : ""} ${hasNoExpiration ? "has-no-expiration" : ""}" type="button" data-action="permanent" data-id="${item.id}" data-permanent="${item.is_permanent ? "false" : "true"}" aria-pressed="${item.is_permanent ? "true" : "false"}" title="${item.is_permanent ? "Enable expiration again" : "Keep this file permanently"}">
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M5 22h14"></path>
                        <path d="M5 2h14"></path>
                        <path d="M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22"></path>
                        <path d="M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2"></path>
                        ${hasNoExpiration ? `<path class="retention-expiration-slash" d="M4 20 20 4"></path>` : ""}
                      </svg>
                      <span>${escapeHtml(retentionText)}</span>
                    </button>`
                  : ""
              }
              ${canDelete ? `<button class="icon-button icon-button--danger" type="button" data-action="delete" data-id="${item.id}" title="Delete file" aria-label="Delete file">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M3 6h18"></path>
                  <path d="M8 6V4h8v2"></path>
                  <path d="M19 6l-1 14H6L5 6"></path>
                  <path d="M10 11v5"></path>
                  <path d="M14 11v5"></path>
                </svg>
              </button>` : ""}
            </div>
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
            <button class="psu-button psu-button--text" type="button" data-user-action="password" data-id="${user.id}">Password</button>
            ${
              user.id !== state.user.id
                ? `<button class="psu-button psu-button--text" type="button" data-user-action="delete" data-id="${user.id}">Delete</button>`
                : ""
            }
          </div>
        </div>
      `,
    )
    .join("");
}

function openUserMenu() {
  $("#userMenu").hidden = false;
  $("#userMenuButton").setAttribute("aria-expanded", "true");
  loadSystemInfo().catch(() => renderAboutInfo());
}

function closeUserMenu() {
  $("#userMenu").hidden = true;
  $("#userMenuButton").setAttribute("aria-expanded", "false");
}

async function boot() {
  migrateThemeStorage();
  applyTheme();
  await injectIcons();
  updateDownloadOptions();
  try {
    const setup = await api("/api/setup/status");
    if (setup.setup_required) {
      showSetup(Boolean(setup.setup_configured), setup.missing_config);
      return;
    }
  } catch (error) {
    showSetup(false, error.message || "ISHIKU_SETUP_SECRET_FILE");
    return;
  }
  try {
    const payload = await api("/api/me");
    state.user = payload.user;
    showApp();
    await Promise.all([refreshAll(), loadSystemInfo()]);
    state.poller = setInterval(refreshAll, 2500);
  } catch {
    showLogin();
  }
}

$("#setupHelpButton").addEventListener("click", () => {
  $("#setupHelp").hidden = !$("#setupHelp").hidden;
});

$("#setupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const setupForm = event.currentTarget;
  $("#setupError").textContent = "";
  const submitButton = setupForm.querySelector("button[type='submit']");
  submitButton.disabled = true;
  const form = new FormData(setupForm);
  try {
    await api("/api/setup/register", {
      method: "POST",
      body: JSON.stringify({
        setup_secret: form.get("setup_secret"),
        display_name: form.get("display_name"),
        username: form.get("username"),
        email: form.get("email") || "",
        password: form.get("password"),
        password_confirm: form.get("password_confirm"),
      }),
    });
    setupForm.reset();
    showLogin();
  } catch (error) {
    $("#setupError").textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});

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
    await Promise.all([refreshAll(), loadSystemInfo()]);
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
        media_type: form.get("media_type") || "video",
        video_format: form.get("video_format") || "auto",
        video_codec: form.get("video_codec") || "auto",
        video_quality: form.get("video_quality") || "auto",
        audio_format: form.get("audio_format") || "auto",
        audio_bitrate: form.get("audio_bitrate") || "auto",
        playlist: form.get("playlist") === "on",
      }),
    });
    downloadForm?.reset();
    setOptionsOpen(false);
    updateDownloadOptions();
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
    } else if (button.dataset.action === "permanent") {
      await api(`/api/downloads/${id}/permanent`, {
        method: "POST",
        body: JSON.stringify({ is_permanent: button.dataset.permanent === "true" }),
      });
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

$("#optionsToggle").addEventListener("click", () => {
  setOptionsOpen($("#downloadOptionsPanel").hidden);
});
$("#optionsReset").addEventListener("click", resetDownloadOptions);
$("#optionsDone").addEventListener("click", () => setOptionsOpen(false));
$("#videoFormat").addEventListener("change", updateDownloadOptions);
$("#videoCodec").addEventListener("change", renderOptionsSummary);
$("#audioFormat").addEventListener("change", updateDownloadOptions);
$("#audioBitrate").addEventListener("change", renderOptionsSummary);
$$("input[name='media_type']").forEach((input) => input.addEventListener("change", updateDownloadOptions));
$("#downloadForm").addEventListener("change", renderOptionsSummary);
$("#refreshButton").addEventListener("click", loadDownloads);

$("#userMenuButton").addEventListener("click", openUserMenu);
$("#userMenuClose").addEventListener("click", closeUserMenu);
$("#userMenu").addEventListener("click", (event) => {
  if (event.target.matches("[data-menu-close]")) {
    closeUserMenu();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#userMenu").hidden) {
    closeUserMenu();
  }
});

$$("[data-theme-choice]").forEach((button) => {
  button.addEventListener("click", () => {
    localStorage.setItem(THEME_KEY, button.dataset.themeChoice);
    applyTheme();
  });
});
$$("[data-mode-choice]").forEach((button) => {
  button.addEventListener("click", () => {
    localStorage.setItem(MODE_KEY, button.dataset.modeChoice);
    applyTheme();
  });
});
systemScheme.addEventListener("change", () => {
  if (savedMode() === "system") applyTheme();
});

window.addEventListener("scroll", () => {
  $("[data-psu-app-header]")?.classList.toggle("is-scrolled", window.scrollY > 4);
}, { passive: true });

$("#copyDebugButton").addEventListener("click", async () => {
  const payload = JSON.stringify(state.systemInfo || {}, null, 2);
  await navigator.clipboard.writeText(payload);
});

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

boot();
