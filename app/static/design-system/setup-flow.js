const BAD_PLACEHOLDER_PASSWORDS = new Set([
  "admin", "password", "passwort", "changeme", "change-me", "123456", "123456789", "ishiku"
]);

export function validateAdminSetupInput(input) {
  const errors = {};
  const setupSecret = String(input.setupSecret ?? "");
  const username = String(input.username ?? "").trim();
  const appId = String(input.appId ?? "").trim().toLowerCase();
  const appName = String(input.appName ?? "").trim().toLowerCase();
  const password = String(input.password ?? "");
  const passwordConfirm = String(input.passwordConfirm ?? "");
  const normalizedPassword = password.trim().toLowerCase();

  if (!setupSecret.trim()) {
    errors.setupSecret = "Setup secret is required.";
  }
  if (!username) {
    errors.username = "Admin username is required.";
  }
  if (password.length < 12) {
    errors.password = "The admin password must be at least 12 characters long.";
  }
  if (password && setupSecret && password === setupSecret) {
    errors.password = "The admin password must not match the setup secret.";
  }
  if (normalizedPassword && BAD_PLACEHOLDER_PASSWORDS.has(normalizedPassword)) {
    errors.password = "Do not use a placeholder password.";
  }
  if (normalizedPassword && (normalizedPassword === username.toLowerCase() || normalizedPassword === appId || normalizedPassword === appName)) {
    errors.password = "The admin password must not be the username, app ID, or app name.";
  }
  if (password !== passwordConfirm) {
    errors.passwordConfirm = "The passwords do not match.";
  }
  return {
    valid: Object.keys(errors).length === 0,
    errors
  };
}

export function bindRegisterWindow(form, options = {}) {
  if (!form) return;
  const appId = options.appId ?? form.dataset.appId ?? "ishiku-app";
  const appName = options.appName ?? form.dataset.appName ?? "ishiku App";

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearFieldErrors(form);

    const data = new FormData(form);
    const result = validateAdminSetupInput({
      appId,
      appName,
      setupSecret: data.get("setup_secret"),
      username: data.get("admin_username"),
      password: data.get("admin_password"),
      passwordConfirm: data.get("admin_password_confirm")
    });

    if (!result.valid) {
      renderFieldErrors(form, result.errors);
      return;
    }

    if (typeof options.onSubmit === "function") {
      await options.onSubmit(data, form);
    }
  });
}

function clearFieldErrors(form) {
  form.querySelectorAll("[data-field-error]").forEach((node) => {
    node.textContent = "";
    node.hidden = true;
  });
  form.querySelectorAll("[aria-invalid='true']").forEach((node) => node.setAttribute("aria-invalid", "false"));
}

function renderFieldErrors(form, errors) {
  Object.entries(errors).forEach(([field, message]) => {
    const input = form.querySelector(`[name="${cssEscape(fieldToName(field))}"]`);
    const error = form.querySelector(`[data-field-error="${cssEscape(fieldToName(field))}"]`);
    if (input) input.setAttribute("aria-invalid", "true");
    if (error) {
      error.textContent = message;
      error.hidden = false;
    }
  });
}

function fieldToName(field) {
  const map = {
    setupSecret: "setup_secret",
    username: "admin_username",
    password: "admin_password",
    passwordConfirm: "admin_password_confirm"
  };
  return map[field] ?? field;
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "\$&");
}
