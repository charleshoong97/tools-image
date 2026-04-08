(function () {
  "use strict";

  /* ---------------------------------------------------------------- */
  /* State                                                             */
  /* ---------------------------------------------------------------- */
  const state = {
    sessionId: generateSessionId(),
    pendingFiles: [],   // File objects waiting to be compressed
    isUploading: false,
    resultCount: 0,
  };

  /* ---------------------------------------------------------------- */
  /* DOM refs                                                          */
  /* ---------------------------------------------------------------- */
  const uploadZone     = document.getElementById("upload-zone");
  const fileInput      = document.getElementById("file-input");
  const qualitySlider  = document.getElementById("quality-slider");
  const qualityLabel   = document.getElementById("quality-label");
  const compressBtn    = document.getElementById("compress-btn");
  const progressWrap   = document.getElementById("progress-wrap");
  const progressBar    = document.getElementById("upload-progress");
  const progressLabel  = document.getElementById("progress-label");
  const errorBanner    = document.getElementById("error-banner");
  const resultsSection = document.getElementById("results");
  const resultCount    = document.getElementById("result-count");
  const cardsContainer = document.getElementById("cards-container");
  const downloadAllBtn = document.getElementById("download-all-btn");
  const clearBtn       = document.getElementById("clear-btn");
  const themeToggle    = document.getElementById("theme-toggle");
  const iconMoon       = document.getElementById("icon-moon");
  const iconSun        = document.getElementById("icon-sun");

  /* ---------------------------------------------------------------- */
  /* Theme toggle                                                      */
  /* ---------------------------------------------------------------- */
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
  let darkMode = prefersDark.matches;

  function applyTheme() {
    document.documentElement.setAttribute("data-theme", darkMode ? "dark" : "");
    iconMoon.style.display = darkMode ? "none" : "";
    iconSun.style.display  = darkMode ? "" : "none";
  }

  applyTheme();
  themeToggle.addEventListener("click", function () {
    darkMode = !darkMode;
    applyTheme();
  });

  /* ---------------------------------------------------------------- */
  /* Upload zone interactions                                          */
  /* ---------------------------------------------------------------- */
  uploadZone.addEventListener("click", function (e) {
    if (e.target !== fileInput) fileInput.click();
  });

  uploadZone.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
  });

  uploadZone.addEventListener("dragover", function (e) {
    e.preventDefault();
    uploadZone.classList.add("dragover");
  });

  uploadZone.addEventListener("dragleave", function (e) {
    if (!uploadZone.contains(e.relatedTarget)) {
      uploadZone.classList.remove("dragover");
    }
  });

  uploadZone.addEventListener("drop", function (e) {
    e.preventDefault();
    uploadZone.classList.remove("dragover");
    handleFiles(e.dataTransfer.files);
  });

  fileInput.addEventListener("change", function () {
    handleFiles(fileInput.files);
    fileInput.value = "";
  });

  /* ---------------------------------------------------------------- */
  /* Quality slider                                                    */
  /* ---------------------------------------------------------------- */
  qualitySlider.addEventListener("input", function () {
    updateQualityLabel();
  });

  function updateQualityLabel() {
    const val = parseInt(qualitySlider.value, 10);
    const formats = detectFormats(state.pendingFiles);

    if (formats.hasPng && !formats.hasJpeg) {
      const level = Math.round((100 - val) / 100 * 9);
      qualityLabel.textContent = "Compression Level: " + level + " / 9";
    } else {
      qualityLabel.textContent = "Quality: " + val;
    }
  }

  function detectFormats(files) {
    let hasJpeg = false, hasPng = false;
    for (let i = 0; i < files.length; i++) {
      const ext = files[i].name.split(".").pop().toLowerCase();
      if (ext === "jpg" || ext === "jpeg") hasJpeg = true;
      if (ext === "png") hasPng = true;
    }
    return { hasJpeg, hasPng };
  }

  /* ---------------------------------------------------------------- */
  /* File handling                                                     */
  /* ---------------------------------------------------------------- */
  function handleFiles(fileList) {
    const allowed = ["jpg", "jpeg", "png"];
    const valid = [];

    for (let i = 0; i < fileList.length; i++) {
      const f = fileList[i];
      const ext = f.name.split(".").pop().toLowerCase();
      if (allowed.includes(ext)) {
        valid.push(f);
      }
    }

    if (valid.length === 0) {
      showError("No supported images selected. Please use JPEG or PNG files.");
      return;
    }

    state.pendingFiles = valid;
    hideError();
    compressBtn.disabled = false;
    updateQualityLabel();

    // Update upload zone label
    const label = uploadZone.querySelector(".upload-label");
    label.textContent = valid.length === 1
      ? "1 file selected"
      : valid.length + " files selected";
  }

  /* ---------------------------------------------------------------- */
  /* Compress button                                                   */
  /* ---------------------------------------------------------------- */
  compressBtn.addEventListener("click", function () {
    if (state.isUploading || state.pendingFiles.length === 0) return;
    uploadAndCompress(state.pendingFiles, parseInt(qualitySlider.value, 10));
  });

  function uploadAndCompress(files, quality) {
    state.isUploading = true;
    compressBtn.disabled = true;
    hideError();
    showProgress(0, "Uploading…");

    const fd = new FormData();
    for (let i = 0; i < files.length; i++) {
      fd.append("files[]", files[i]);
    }
    fd.append("quality", quality);
    fd.append("session_id", state.sessionId);

    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener("progress", function (e) {
      if (e.lengthComputable) {
        const pct = Math.round(e.loaded / e.total * 90);
        showProgress(pct, "Uploading…");
      }
    });

    xhr.addEventListener("load", function () {
      showProgress(100, "Processing…");
      if (xhr.status >= 200 && xhr.status < 300) {
        let data;
        try { data = JSON.parse(xhr.responseText); } catch (_) {
          showError("Unexpected server response.");
          finishUpload();
          return;
        }

        if (data.errors && data.errors.length > 0) {
          const msgs = data.errors.map(function (e) { return e.filename + ": " + e.error; });
          showError(msgs.join(" | "));
        }

        if (data.results && data.results.length > 0) {
          renderResults(data.results, files);
        }
      } else {
        showError("Server error (" + xhr.status + "). Please try again.");
      }
      finishUpload();
    });

    xhr.addEventListener("error", function () {
      showError("Network error. Is the server running?");
      finishUpload();
    });

    xhr.open("POST", "/compress");
    xhr.send(fd);
  }

  function finishUpload() {
    state.isUploading = false;
    state.pendingFiles = [];
    compressBtn.disabled = true;
    hideProgress();

    // Reset upload zone label
    const label = uploadZone.querySelector(".upload-label");
    label.textContent = "Drag & drop images here";
  }

  /* ---------------------------------------------------------------- */
  /* Render results                                                    */
  /* ---------------------------------------------------------------- */
  function renderResults(results, originalFiles) {
    resultsSection.hidden = false;
    state.resultCount += results.length;
    resultCount.textContent = state.resultCount;

    // Build a map from filename -> File object for thumbnails
    const fileMap = {};
    for (let i = 0; i < originalFiles.length; i++) {
      fileMap[originalFiles[i].name] = originalFiles[i];
    }

    results.forEach(function (r) {
      const card = buildCard(r, fileMap[r.original_name]);
      cardsContainer.insertBefore(card, cardsContainer.firstChild);
    });
  }

  function buildCard(result, originalFile) {
    const savings = 1 - result.ratio;
    const savingsPct = Math.round(savings * 100);

    const card = el("div", { className: "result-card" });

    // Thumbnail
    const canvas = el("canvas", { className: "card-thumb" });
    canvas.width = 72;
    canvas.height = 72;
    card.appendChild(canvas);
    if (originalFile) drawThumbnail(canvas, originalFile);

    // Info
    const info = el("div", { className: "card-info" });

    const filename = el("div", { className: "card-filename" });
    filename.appendChild(document.createTextNode(result.original_name));
    info.appendChild(filename);

    const meta = el("div", { className: "card-meta" });

    const origSize = el("span");
    origSize.appendChild(document.createTextNode(formatBytes(result.original_size)));
    meta.appendChild(origSize);

    const arrow = el("span", { className: "arrow" });
    arrow.appendChild(document.createTextNode("→"));
    meta.appendChild(arrow);

    const compSize = el("span", { className: "compressed-size" });
    compSize.appendChild(document.createTextNode(formatBytes(result.compressed_size)));
    meta.appendChild(compSize);

    const badge = el("span", {
      className: "savings-badge " + savingsClass(savingsPct),
    });
    const badgeText = savingsPct > 0
      ? "-" + savingsPct + "%"
      : (savingsPct === 0 ? "0%" : "+" + Math.abs(savingsPct) + "%");
    badge.appendChild(document.createTextNode(badgeText));
    meta.appendChild(badge);

    info.appendChild(meta);

    const dims = el("div", { className: "card-dims" });
    dims.appendChild(document.createTextNode(result.width + " × " + result.height + " px  ·  " + result.format));
    info.appendChild(dims);

    card.appendChild(info);

    // Download button
    const actions = el("div", { className: "card-actions" });
    const dlBtn = el("button", { className: "dl-btn" });
    dlBtn.appendChild(downloadIcon());
    dlBtn.appendChild(document.createTextNode("Download"));
    dlBtn.addEventListener("click", function () {
      triggerDownload("/download/" + state.sessionId + "/" + result.id);
    });
    actions.appendChild(dlBtn);
    card.appendChild(actions);

    return card;
  }

  function savingsClass(pct) {
    if (pct >= 20) return "good";
    if (pct >= 5)  return "ok";
    return "bad";
  }

  /* ---------------------------------------------------------------- */
  /* Thumbnail                                                         */
  /* ---------------------------------------------------------------- */
  function drawThumbnail(canvas, file) {
    const ctx = canvas.getContext("2d");
    createImageBitmap(file).then(function (bitmap) {
      const size = 72;
      const scale = Math.max(size / bitmap.width, size / bitmap.height);
      const sw = bitmap.width * scale;
      const sh = bitmap.height * scale;
      const sx = (size - sw) / 2;
      const sy = (size - sh) / 2;
      ctx.drawImage(bitmap, sx, sy, sw, sh);
      bitmap.close();
    }).catch(function () {
      // If bitmap fails, leave canvas blank
    });
  }

  /* ---------------------------------------------------------------- */
  /* Download                                                          */
  /* ---------------------------------------------------------------- */
  function triggerDownload(url) {
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  downloadAllBtn.addEventListener("click", function () {
    triggerDownload("/download-all/" + state.sessionId);
  });

  /* ---------------------------------------------------------------- */
  /* Clear                                                             */
  /* ---------------------------------------------------------------- */
  clearBtn.addEventListener("click", function () {
    cardsContainer.innerHTML = "";
    resultsSection.hidden = true;
    state.resultCount = 0;
    resultCount.textContent = "0";
    hideError();

    fetch("/session/" + state.sessionId, { method: "DELETE" });
    state.sessionId = generateSessionId();
  });

  /* ---------------------------------------------------------------- */
  /* Cleanup on unload                                                 */
  /* ---------------------------------------------------------------- */
  window.addEventListener("beforeunload", function () {
    navigator.sendBeacon("/session/" + state.sessionId,
      new Blob([], { type: "application/json" }));
  });

  /* ---------------------------------------------------------------- */
  /* Progress helpers                                                  */
  /* ---------------------------------------------------------------- */
  function showProgress(value, label) {
    progressWrap.hidden = false;
    progressBar.value = value;
    progressLabel.textContent = label;
  }

  function hideProgress() {
    progressWrap.hidden = true;
    progressBar.value = 0;
  }

  /* ---------------------------------------------------------------- */
  /* Error helpers                                                     */
  /* ---------------------------------------------------------------- */
  function showError(msg) {
    errorBanner.hidden = false;
    errorBanner.textContent = msg;
  }

  function hideError() {
    errorBanner.hidden = true;
    errorBanner.textContent = "";
  }

  /* ---------------------------------------------------------------- */
  /* Utilities                                                         */
  /* ---------------------------------------------------------------- */
  function generateSessionId() {
    return Math.random().toString(36).slice(2, 10) +
           Math.random().toString(36).slice(2, 10);
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

})();
