(function () {
  "use strict";

  const T = window.ImageTools;

  // The mask is drawn at most this large (mobile browsers cap canvas size);
  // the server scales it up to the full image.
  const MAX_MASK_SIDE = 4096;
  const MASK_COLOR = "#ef4444";

  const session = T.createSession();
  const state = {
    name: "",        // original file name, reused when re-uploading results
    versions: [],    // [{blob, image, fileId, sessionId}]; versions[0] is the original
    strokes: [],     // selection, in coordinates relative to the image (0-1)
    current: null,   // stroke being drawn
    tool: "brush",
    isProcessing: false,
  };

  /* ---------------------------------------------------------------- */
  /* DOM refs                                                          */
  /* ---------------------------------------------------------------- */
  const uploadZoneEl   = document.getElementById("upload-zone");
  const editor         = document.getElementById("editor");
  const editorHint     = document.getElementById("editor-hint");
  const canvasArea     = document.getElementById("canvas-area");
  const stack          = document.getElementById("canvas-stack");
  const imageCanvas    = document.getElementById("image-canvas");
  const maskCanvas     = document.getElementById("mask-canvas");
  const cursor         = document.getElementById("brush-cursor");
  const brushSize      = document.getElementById("brush-size");
  const brushSizeField = document.getElementById("brush-size-field");
  const processBtn     = document.getElementById("process-btn");
  const downloadBtn    = document.getElementById("download-btn");
  const compareBtn     = document.getElementById("compare-btn");
  const undoRemovalBtn = document.getElementById("undo-removal-btn");
  const newImageBtn    = document.getElementById("new-image-btn");
  const undoStrokeBtn  = document.getElementById("undo-stroke-btn");
  const clearMaskBtn   = document.getElementById("clear-mask-btn");

  T.bindUploadZone(T.IMAGE_EXTENSIONS, function (files) {
    openImage(files[0]);
  });

  async function openImage(file) {
    let image;
    try {
      image = await T.loadImage(file);
    } catch (err) {
      T.showError(file.name + ": " + err.message);
      return;
    }

    state.name = file.name;
    state.versions = [{ blob: file, image: image, fileId: null, sessionId: null }];
    state.strokes = [];
    uploadZoneEl.hidden = true;
    editor.hidden = false;
    editorHint.hidden = false;
    layout();
    updateButtons();
  }

  function currentVersion() {
    return state.versions[state.versions.length - 1];
  }

  /* ---------------------------------------------------------------- */
  /* Drawing                                                           */
  /* ---------------------------------------------------------------- */
  // Fit the image into the available space and size both canvases for the
  // device's pixel ratio.
  function layout() {
    const img = currentVersion().image;
    const maxHeight = Math.max(240, window.innerHeight * 0.65);
    const scale = Math.min(canvasArea.clientWidth / img.naturalWidth, maxHeight / img.naturalHeight);
    const width = Math.max(1, Math.floor(img.naturalWidth * scale));
    const height = Math.max(1, Math.floor(img.naturalHeight * scale));
    const dpr = window.devicePixelRatio || 1;

    stack.style.width = width + "px";
    stack.style.height = height + "px";
    [imageCanvas, maskCanvas].forEach(function (canvas) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    });

    drawImage(img);
    drawOverlay();
  }

  function drawImage(img) {
    const ctx = imageCanvas.getContext("2d");
    ctx.clearRect(0, 0, imageCanvas.width, imageCanvas.height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, imageCanvas.width, imageCanvas.height);
  }

  // Render the selection onto ctx at the given size. Used both for the
  // on-screen overlay and for the mask sent to the server.
  function drawStrokes(ctx, width, height, color) {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const strokes = state.current ? state.strokes.concat([state.current]) : state.strokes;
    strokes.forEach(function (s) {
      if (s.kind === "rect") {
        ctx.fillRect(s.x * width, s.y * height, s.w * width, s.h * height);
        return;
      }

      const lineWidth = s.size * width;
      const first = s.points[0];
      if (s.points.length === 1) {
        ctx.beginPath();
        ctx.arc(first.x * width, first.y * height, lineWidth / 2, 0, Math.PI * 2);
        ctx.fill();
        return;
      }

      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      ctx.moveTo(first.x * width, first.y * height);
      for (let i = 1; i < s.points.length; i++) {
        ctx.lineTo(s.points[i].x * width, s.points[i].y * height);
      }
      ctx.stroke();
    });
  }

  function drawOverlay() {
    drawStrokes(maskCanvas.getContext("2d"), maskCanvas.width, maskCanvas.height, MASK_COLOR);
  }

  let drawQueued = false;
  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(function () {
      drawQueued = false;
      drawOverlay();
    });
  }

  function exportMask() {
    const img = state.versions[0].image;
    const scale = Math.min(1, MAX_MASK_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    drawStrokes(canvas.getContext("2d"), canvas.width, canvas.height, "#ffffff");
    return T.canvasToBlob(canvas, "image/png");
  }

  window.addEventListener("resize", function () {
    if (!editor.hidden) layout();
  });

  /* ---------------------------------------------------------------- */
  /* Selection tools                                                   */
  /* ---------------------------------------------------------------- */
  document.querySelectorAll('input[name="tool"]').forEach(function (radio) {
    radio.addEventListener("change", function () {
      state.tool = radio.value;
      brushSizeField.hidden = state.tool !== "brush";
    });
  });

  function pointerPos(e) {
    const rect = maskCanvas.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  }

  function moveCursor(e) {
    if (state.tool !== "brush") {
      cursor.hidden = true;
      return;
    }
    const rect = maskCanvas.getBoundingClientRect();
    const size = parseInt(brushSize.value, 10);
    cursor.hidden = false;
    cursor.style.width = size + "px";
    cursor.style.height = size + "px";
    cursor.style.transform = "translate(" + (e.clientX - rect.left - size / 2) + "px," +
                                            (e.clientY - rect.top - size / 2) + "px)";
  }

  maskCanvas.addEventListener("pointerdown", function (e) {
    if (state.isProcessing || e.button !== 0) return;
    e.preventDefault();
    maskCanvas.setPointerCapture(e.pointerId);

    const p = pointerPos(e);
    state.current = state.tool === "brush"
      ? { kind: "brush", size: brushSize.value / maskCanvas.getBoundingClientRect().width, points: [p] }
      : { kind: "rect", x: p.x, y: p.y, w: 0, h: 0 };
    requestDraw();
  });

  maskCanvas.addEventListener("pointermove", function (e) {
    moveCursor(e);
    const s = state.current;
    if (!s) return;

    const p = pointerPos(e);
    if (s.kind === "brush") {
      s.points.push(p);
    } else {
      s.w = p.x - s.x;
      s.h = p.y - s.y;
    }
    requestDraw();
  });

  function endStroke() {
    const s = state.current;
    if (!s) return;
    state.current = null;

    if (s.kind === "rect") {
      if (s.w < 0) { s.x += s.w; s.w = -s.w; }
      if (s.h < 0) { s.y += s.h; s.h = -s.h; }
    }
    if (s.kind === "brush" || (s.w > 0 && s.h > 0)) state.strokes.push(s);

    requestDraw();
    updateButtons();
  }

  maskCanvas.addEventListener("pointerup", endStroke);
  maskCanvas.addEventListener("pointercancel", endStroke);
  maskCanvas.addEventListener("pointerleave", function () { cursor.hidden = true; });

  function undoStroke() {
    if (state.isProcessing || state.strokes.length === 0) return;
    state.strokes.pop();
    drawOverlay();
    updateButtons();
  }

  undoStrokeBtn.addEventListener("click", undoStroke);

  document.addEventListener("keydown", function (e) {
    if (!editor.hidden && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      undoStroke();
    }
  });

  clearMaskBtn.addEventListener("click", function () {
    state.strokes = [];
    drawOverlay();
    updateButtons();
  });

  /* ---------------------------------------------------------------- */
  /* Removal                                                           */
  /* ---------------------------------------------------------------- */
  processBtn.addEventListener("click", async function () {
    if (state.isProcessing || state.strokes.length === 0) return;

    state.isProcessing = true;
    updateButtons();
    T.hideError();
    T.showProgress(0, "Uploading…");

    const sessionId = session.id;
    try {
      const fd = new FormData();
      fd.append("file", currentVersion().blob, state.name);
      fd.append("mask", await exportMask(), "mask.png");
      fd.append("session_id", sessionId);

      const data = await T.postForm("/remove-watermark", fd, function (fraction) {
        const pct = Math.round(fraction * 90);
        T.showProgress(pct, pct < 90 ? "Uploading…" : "Removing watermark…");
      });
      if (data.errors && data.errors.length > 0) throw new Error(data.errors[0].error);

      // Load the result so it becomes the image the next pass works on.
      const fileId = data.results[0].id;
      const resp = await fetch("/download/" + sessionId + "/" + fileId + "?inline=1");
      if (!resp.ok) throw new Error("Could not load the result. Please try again.");
      const blob = await resp.blob();
      const image = await T.loadImage(blob);

      state.versions.push({ blob: blob, image: image, fileId: fileId, sessionId: sessionId });
      state.strokes = [];
      drawImage(image);
      drawOverlay();
    } catch (err) {
      T.showError(err.message);
    } finally {
      state.isProcessing = false;
      T.hideProgress();
      updateButtons();
    }
  });

  downloadBtn.addEventListener("click", function () {
    const v = currentVersion();
    if (v.fileId) T.triggerDownload("/download/" + v.sessionId + "/" + v.fileId);
  });

  undoRemovalBtn.addEventListener("click", function () {
    if (state.isProcessing || state.versions.length < 2) return;
    state.versions.pop();
    drawImage(currentVersion().image);
    updateButtons();
  });

  newImageBtn.addEventListener("click", function () {
    if (state.isProcessing) return;
    session.reset();
    state.versions = [];
    state.strokes = [];
    editor.hidden = true;
    editorHint.hidden = true;
    uploadZoneEl.hidden = false;
    T.hideError();
  });

  // Press and hold to see the original image.
  function showOriginal() {
    if (compareBtn.disabled) return;
    drawImage(state.versions[0].image);
    maskCanvas.style.visibility = "hidden";
  }

  function showCurrent() {
    if (state.versions.length === 0) return;
    drawImage(currentVersion().image);
    maskCanvas.style.visibility = "";
  }

  compareBtn.addEventListener("pointerdown", showOriginal);
  compareBtn.addEventListener("pointerup", showCurrent);
  compareBtn.addEventListener("pointerleave", showCurrent);
  compareBtn.addEventListener("pointercancel", showCurrent);
  compareBtn.addEventListener("keydown", function (e) {
    if ((e.key === " " || e.key === "Enter") && !e.repeat) showOriginal();
  });
  compareBtn.addEventListener("keyup", showCurrent);

  function updateButtons() {
    const busy = state.isProcessing;
    const edited = state.versions.length > 1;
    processBtn.disabled = busy || state.strokes.length === 0;
    undoStrokeBtn.disabled = busy || state.strokes.length === 0;
    clearMaskBtn.disabled = busy || state.strokes.length === 0;
    downloadBtn.disabled = busy || !edited;
    compareBtn.disabled = busy || !edited;
    undoRemovalBtn.disabled = busy || !edited;
    newImageBtn.disabled = busy;
  }
})();
