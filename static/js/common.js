/* Shared helpers for every tool page, exposed as window.ImageTools. */
(function () {
  "use strict";

  /* ---------------------------------------------------------------- */
  /* Theme toggle (initial theme is applied by an inline script in      */
  /* base.html before first paint)                                     */
  /* ---------------------------------------------------------------- */
  const themeToggle = document.getElementById("theme-toggle");
  const iconMoon    = document.getElementById("icon-moon");
  const iconSun     = document.getElementById("icon-sun");

  function isDark() {
    return document.documentElement.getAttribute("data-theme") === "dark";
  }

  function syncThemeIcons() {
    iconMoon.style.display = isDark() ? "none" : "";
    iconSun.style.display  = isDark() ? "" : "none";
  }

  syncThemeIcons();

  // On narrow screens the tool tabs scroll sideways; keep the current one in view.
  const activeTab = document.querySelector('.tool-nav a[aria-current="page"]');
  if (activeTab) {
    const nav = activeTab.parentElement;
    nav.scrollLeft = activeTab.offsetLeft - (nav.clientWidth - activeTab.offsetWidth) / 2;
  }

  themeToggle.addEventListener("click", function () {
    const dark = !isDark();
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "");
    try { localStorage.setItem("theme", dark ? "dark" : "light"); } catch (_) { /* storage unavailable */ }
    syncThemeIcons();
  });

  /* ---------------------------------------------------------------- */
  /* Session: a page's results live in one server-side session          */
  /* ---------------------------------------------------------------- */
  function createSession() {
    const session = { id: generateSessionId() };

    session.reset = function () {
      fetch("/session/" + session.id, { method: "DELETE" });
      session.id = generateSessionId();
    };

    window.addEventListener("beforeunload", function () {
      navigator.sendBeacon("/session/" + session.id);
    });

    return session;
  }

  function generateSessionId() {
    return Math.random().toString(36).slice(2, 10) +
           Math.random().toString(36).slice(2, 10);
  }

  /* ---------------------------------------------------------------- */
  /* Upload zone                                                       */
  /* ---------------------------------------------------------------- */
  // Wires up #upload-zone / #file-input. onFiles receives the files whose
  // extension is in `extensions`; if none qualify an error is shown instead.
  function bindUploadZone(extensions, onFiles) {
    const zone  = document.getElementById("upload-zone");
    const input = document.getElementById("file-input");

    function handle(fileList) {
      const valid = [];
      for (let i = 0; i < fileList.length; i++) {
        const ext = fileList[i].name.split(".").pop().toLowerCase();
        if (extensions.includes(ext)) valid.push(fileList[i]);
      }
      if (valid.length === 0) {
        showError("No supported images selected. Please use " + describeExtensions(extensions) + " files.");
        return;
      }
      hideError();
      onFiles(input.multiple ? valid : valid.slice(0, 1));
    }

    zone.addEventListener("click", function (e) {
      if (e.target !== input) input.click();
    });

    zone.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
    });

    zone.addEventListener("dragover", function (e) {
      e.preventDefault();
      zone.classList.add("dragover");
    });

    zone.addEventListener("dragleave", function (e) {
      if (!zone.contains(e.relatedTarget)) zone.classList.remove("dragover");
    });

    zone.addEventListener("drop", function (e) {
      e.preventDefault();
      zone.classList.remove("dragover");
      handle(e.dataTransfer.files);
    });

    input.addEventListener("change", function () {
      handle(input.files);
      input.value = "";
    });

    return {
      setLabel: function (text) {
        zone.querySelector(".upload-label").textContent = text;
      },
      resetLabel: function () {
        zone.querySelector(".upload-label").textContent =
          input.multiple ? "Drag & drop images here" : "Drag & drop an image here";
      },
    };
  }

  function describeExtensions(extensions) {
    const names = [];
    if (extensions.includes("jpg")) names.push("JPEG");
    if (extensions.includes("png")) names.push("PNG");
    if (extensions.includes("webp")) names.push("WebP");
    return names.length > 1
      ? names.slice(0, -1).join(", ") + " or " + names[names.length - 1]
      : names.join("");
  }

  function selectionLabel(files) {
    return files.length === 1 ? "1 file selected" : files.length + " files selected";
  }

  /* ---------------------------------------------------------------- */
  /* Requests                                                          */
  /* ---------------------------------------------------------------- */
  // POST a FormData and resolve with the parsed JSON response. Uses XHR for
  // upload progress; onUploadProgress receives a 0-1 fraction.
  function postForm(url, formData, onUploadProgress) {
    return new Promise(function (resolve, reject) {
      const xhr = new XMLHttpRequest();

      if (onUploadProgress) {
        xhr.upload.addEventListener("progress", function (e) {
          if (e.lengthComputable) onUploadProgress(e.loaded / e.total);
        });
      }

      xhr.addEventListener("load", function () {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch (_) { /* not JSON */ }

        if (xhr.status >= 200 && xhr.status < 300) {
          if (data) resolve(data);
          else reject(new Error("Unexpected server response."));
        } else {
          reject(new Error(data && data.error
            ? data.error
            : "Server error (" + xhr.status + "). Please try again."));
        }
      });

      xhr.addEventListener("error", function () {
        reject(new Error("Network error. Is the server running?"));
      });

      xhr.open("POST", url);
      xhr.send(formData);
    });
  }

  // Send files one request at a time so each gets its own progress step and
  // slow operations (background removal) never hit the server's timeout.
  // buildForm(file) returns the FormData; onResult is called per result.
  async function processEach(files, options) {
    const errors = [];
    hideError();

    for (let i = 0; i < files.length; i++) {
      const label = options.verb + (files.length > 1 ? " " + (i + 1) + " of " + files.length : "") + "…";
      showProgress(Math.round(i / files.length * 100), label);

      try {
        const data = await postForm(options.url, options.buildForm(files[i]), function (fraction) {
          showProgress(Math.round((i + fraction * 0.5) / files.length * 100), label);
        });
        (data.results || []).forEach(options.onResult);
        (data.errors || []).forEach(function (e) { errors.push(e.filename + ": " + e.error); });
      } catch (err) {
        errors.push(files[i].name + ": " + err.message);
      }
    }

    hideProgress();
    if (errors.length > 0) showError(errors.join(" | "));
  }

  /* ---------------------------------------------------------------- */
  /* Results list                                                      */
  /* ---------------------------------------------------------------- */
  // Wires up #results with its count badge, "Download All" and "Clear".
  function createResultsList(session, onClear) {
    const section   = document.getElementById("results");
    const container = document.getElementById("cards-container");
    const counter   = document.getElementById("result-count");
    let count = 0;

    document.getElementById("download-all-btn").addEventListener("click", function () {
      triggerDownload("/download-all/" + session.id);
    });

    document.getElementById("clear-btn").addEventListener("click", function () {
      container.innerHTML = "";
      section.hidden = true;
      count = 0;
      counter.textContent = "0";
      hideError();
      session.reset();
      if (onClear) onClear();
    });

    return {
      add: function (card) {
        section.hidden = false;
        count += 1;
        counter.textContent = count;
        container.insertBefore(card, container.firstChild);
      },
    };
  }

  // A result tile with a preview of the processed image (click to open full size).
  function buildResultTile(result, sessionId) {
    const url = "/download/" + sessionId + "/" + result.id;
    const tile = el("div", { className: "result-tile" });

    const preview = el("a", {
      className: "tile-preview",
      href: url + "?inline=1",
      target: "_blank",
      rel: "noopener",
      title: "Open full size",
    });
    preview.appendChild(el("img", {
      className: "checkerboard",
      src: url + "?inline=1",
      alt: result.original_name,
      loading: "lazy",
    }));
    tile.appendChild(preview);

    const body = el("div", { className: "tile-body" });
    body.appendChild(el("div", { className: "card-filename", textContent: result.original_name, title: result.original_name }));
    body.appendChild(el("div", {
      className: "card-dims",
      textContent: result.width + " × " + result.height + " px  ·  " + result.format + "  ·  " + formatBytes(result.output_size),
    }));
    tile.appendChild(body);

    const dlBtn = el("button", { className: "dl-btn" });
    dlBtn.appendChild(downloadIcon());
    dlBtn.appendChild(document.createTextNode("Download"));
    dlBtn.addEventListener("click", function () { triggerDownload(url); });
    tile.appendChild(dlBtn);

    return tile;
  }

  /* ---------------------------------------------------------------- */
  /* Progress & errors (#progress-wrap, #error-banner)                  */
  /* ---------------------------------------------------------------- */
  function showProgress(value, label) {
    document.getElementById("progress-wrap").hidden = false;
    document.getElementById("upload-progress").value = value;
    document.getElementById("progress-label").textContent = label;
  }

  function hideProgress() {
    document.getElementById("progress-wrap").hidden = true;
    document.getElementById("upload-progress").value = 0;
  }

  function showError(msg) {
    const banner = document.getElementById("error-banner");
    banner.hidden = false;
    banner.textContent = msg;
  }

  function hideError() {
    const banner = document.getElementById("error-banner");
    banner.hidden = true;
    banner.textContent = "";
  }

  /* ---------------------------------------------------------------- */
  /* Utilities                                                         */
  /* ---------------------------------------------------------------- */
  // Decode a File/Blob into an <img>. Unlike createImageBitmap's historical
  // default, <img> applies EXIF orientation everywhere, matching the server.
  function loadImage(blob) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("Could not read image")); };
      img.src = url;
    });
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob);
        else reject(new Error("Could not render image"));
      }, type, quality);
    });
  }

  function triggerDownload(url) {
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  }

  function el(tag, props) {
    const node = document.createElement(tag);
    if (props) Object.assign(node, props);
    return node;
  }

  function downloadIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.innerHTML =
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
      '<polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>';
    return svg;
  }

  window.ImageTools = {
    IMAGE_EXTENSIONS: ["jpg", "jpeg", "png", "webp"],
    createSession: createSession,
    bindUploadZone: bindUploadZone,
    selectionLabel: selectionLabel,
    postForm: postForm,
    processEach: processEach,
    createResultsList: createResultsList,
    buildResultTile: buildResultTile,
    showProgress: showProgress,
    hideProgress: hideProgress,
    showError: showError,
    hideError: hideError,
    loadImage: loadImage,
    canvasToBlob: canvasToBlob,
    triggerDownload: triggerDownload,
    formatBytes: formatBytes,
    el: el,
    downloadIcon: downloadIcon,
  };
})();
