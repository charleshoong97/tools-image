(function () {
  "use strict";

  const T = window.ImageTools;

  /* ---------------------------------------------------------------- */
  /* State                                                             */
  /* ---------------------------------------------------------------- */
  const session = T.createSession();
  const state = {
    pendingFiles: [],   // File objects waiting to be compressed
    isUploading: false,
  };

  /* ---------------------------------------------------------------- */
  /* DOM refs                                                          */
  /* ---------------------------------------------------------------- */
  const qualitySlider  = document.getElementById("quality-slider");
  const qualityLabel   = document.getElementById("quality-label");
  const compressBtn    = document.getElementById("compress-btn");

  const uploadZone = T.bindUploadZone(["jpg", "jpeg", "png"], handleFiles);
  const results = T.createResultsList(session);

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
  function handleFiles(files) {
    state.pendingFiles = files;
    compressBtn.disabled = false;
    updateQualityLabel();
    uploadZone.setLabel(T.selectionLabel(files));
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
    T.hideError();
    T.showProgress(0, "Uploading…");

    const fd = new FormData();
    for (let i = 0; i < files.length; i++) {
      fd.append("files[]", files[i]);
    }
    fd.append("quality", quality);
    fd.append("session_id", session.id);

    T.postForm("/compress", fd, function (fraction) {
      const pct = Math.round(fraction * 90);
      T.showProgress(pct, pct < 90 ? "Uploading…" : "Processing…");
    }).then(function (data) {
      if (data.errors && data.errors.length > 0) {
        const msgs = data.errors.map(function (e) { return e.filename + ": " + e.error; });
        T.showError(msgs.join(" | "));
      }

      if (data.results && data.results.length > 0) {
        renderResults(data.results, files);
      }
    }).catch(function (err) {
      T.showError(err.message);
    }).then(finishUpload);
  }

  function finishUpload() {
    state.isUploading = false;
    state.pendingFiles = [];
    compressBtn.disabled = true;
    T.hideProgress();
    uploadZone.resetLabel();
  }

  /* ---------------------------------------------------------------- */
  /* Render results                                                    */
  /* ---------------------------------------------------------------- */
  function renderResults(resultList, originalFiles) {
    // Build a map from filename -> File object for thumbnails
    const fileMap = {};
    for (let i = 0; i < originalFiles.length; i++) {
      fileMap[originalFiles[i].name] = originalFiles[i];
    }

    resultList.forEach(function (r) {
      results.add(buildCard(r, fileMap[r.original_name]));
    });
  }

  function buildCard(result, originalFile) {
    const el = T.el;
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
    origSize.appendChild(document.createTextNode(T.formatBytes(result.original_size)));
    meta.appendChild(origSize);

    const arrow = el("span", { className: "arrow" });
    arrow.appendChild(document.createTextNode("→"));
    meta.appendChild(arrow);

    const compSize = el("span", { className: "compressed-size" });
    compSize.appendChild(document.createTextNode(T.formatBytes(result.compressed_size)));
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
    dlBtn.appendChild(T.downloadIcon());
    dlBtn.appendChild(document.createTextNode("Download"));
    const downloadUrl = "/download/" + session.id + "/" + result.id;
    dlBtn.addEventListener("click", function () {
      T.triggerDownload(downloadUrl);
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

})();
