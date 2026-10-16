(function () {
  "use strict";

  const T = window.ImageTools;

  const PREVIEW_MAX = 1000;      // px, longest side of images sent for preview
  const STAMP_MAX_WIDTH = 4096;  // px, text is rendered at up to this width
  const FONTS = {
    sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
    mono: 'ui-monospace, "SFMono-Regular", Consolas, "Courier New", monospace',
    script: '"Brush Script MT", "Segoe Script", "Comic Sans MS", cursive',
  };

  const session = T.createSession();
  const state = {
    files: [],
    previewIndex: 0,
    previewCache: new Map(),  // File -> Promise of a downscaled {blob, name}
    position: "bottom-right",
    logo: null,               // File
    logoPreview: null,        // Promise of a downscaled logo Blob
    isProcessing: false,
    previewToken: 0,
    previewUrl: null,
  };

  /* ---------------------------------------------------------------- */
  /* DOM refs                                                          */
  /* ---------------------------------------------------------------- */
  const processBtn   = document.getElementById("process-btn");
  const textOptions  = document.getElementById("text-options");
  const imageOptions = document.getElementById("image-options");
  const textInput    = document.getElementById("wm-text");
  const fontSelect   = document.getElementById("wm-font");
  const colorInput   = document.getElementById("wm-color");
  const boldInput    = document.getElementById("wm-bold");
  const logoInput    = document.getElementById("wm-logo");
  const logoName     = document.getElementById("wm-logo-name");
  const marginField  = document.getElementById("margin-field");
  const spacingField = document.getElementById("spacing-field");
  const previewImg   = document.getElementById("preview-img");
  const previewEmpty = document.getElementById("preview-empty");
  const previewBusy  = document.getElementById("preview-busy");
  const previewNav   = document.getElementById("preview-nav");
  const previewName  = document.getElementById("preview-name");
  const positionBtns = document.querySelectorAll("[data-position]");

  const sliders = {
    size:     { input: document.getElementById("wm-size"),     out: document.getElementById("wm-size-out"),     unit: "%" },
    opacity:  { input: document.getElementById("wm-opacity"),  out: document.getElementById("wm-opacity-out"),  unit: "%" },
    rotation: { input: document.getElementById("wm-rotation"), out: document.getElementById("wm-rotation-out"), unit: "°" },
    margin:   { input: document.getElementById("wm-margin"),   out: document.getElementById("wm-margin-out"),   unit: "%" },
    spacing:  { input: document.getElementById("wm-spacing"),  out: document.getElementById("wm-spacing-out"),  unit: "%" },
  };

  const uploadZone = T.bindUploadZone(T.IMAGE_EXTENSIONS, function (files) {
    state.files = files;
    state.previewIndex = 0;
    state.previewCache = new Map();
    uploadZone.setLabel(T.selectionLabel(files));
    updateControls();
    schedulePreview(0);
  });
  const results = T.createResultsList(session);

  /* ---------------------------------------------------------------- */
  /* Options                                                           */
  /* ---------------------------------------------------------------- */
  document.querySelectorAll('input[name="wm-type"]').forEach(function (radio) {
    radio.addEventListener("change", function () {
      textOptions.hidden = watermarkType() !== "text";
      imageOptions.hidden = watermarkType() !== "image";
      updateControls();
      schedulePreview();
    });
  });

  [textInput, fontSelect, colorInput, boldInput].forEach(function (input) {
    input.addEventListener("input", function () {
      updateControls();
      schedulePreview();
    });
  });

  logoInput.addEventListener("change", function () {
    const file = logoInput.files[0];
    logoInput.value = "";
    if (!file) return;
    state.logo = file;
    state.logoPreview = downscale(file, PREVIEW_MAX).then(function (scaled) { return scaled.blob; });
    logoName.textContent = file.name;
    updateControls();
    schedulePreview(0);
  });

  positionBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      state.position = btn.dataset.position;
      positionBtns.forEach(function (b) {
        b.setAttribute("aria-checked", b === btn ? "true" : "false");
      });
      marginField.hidden = state.position === "tile";
      spacingField.hidden = state.position !== "tile";
      schedulePreview(0);
    });
  });

  Object.keys(sliders).forEach(function (name) {
    const slider = sliders[name];
    slider.input.addEventListener("input", function () {
      slider.out.textContent = slider.input.value + slider.unit;
      schedulePreview();
    });
  });

  function watermarkType() {
    return document.querySelector('input[name="wm-type"]:checked').value;
  }

  function currentOptions() {
    const options = { position: state.position };
    Object.keys(sliders).forEach(function (name) {
      options[name] = sliders[name].input.value;
    });
    return options;
  }

  function appendOptions(fd, options) {
    Object.keys(options).forEach(function (name) {
      fd.append(name, options[name]);
    });
  }

  function hasWatermark() {
    return watermarkType() === "text" ? textInput.value.trim() !== "" : state.logo !== null;
  }

  function updateControls() {
    processBtn.disabled = state.isProcessing || state.files.length === 0 || !hasWatermark();
    processBtn.textContent = state.files.length > 1
      ? "Apply to " + state.files.length + " Images"
      : "Apply Watermark";
  }

  /* ---------------------------------------------------------------- */
  /* Watermark stamp                                                   */
  /* ---------------------------------------------------------------- */
  // Text is rendered here rather than on the server so that every font and
  // script the browser supports (CJK, emoji, ...) works.
  function renderTextStamp(maxWidth) {
    const text = textInput.value.trim();
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const fontAt = function (px) {
      return (boldInput.checked ? "bold " : "") + px + "px " + FONTS[fontSelect.value];
    };

    // Measure at a reference size, then pick the size that fills maxWidth,
    // capped so very short text (e.g. "©") doesn't produce a huge canvas.
    ctx.font = fontAt(100);
    const ref = ctx.measureText(text);
    const refWidth = ref.actualBoundingBoxLeft + ref.actualBoundingBoxRight;
    const fontPx = Math.max(8, Math.floor(Math.min(maxWidth / refWidth * 100, maxWidth / 4)));

    ctx.font = fontAt(fontPx);
    const m = ctx.measureText(text);
    const pad = Math.ceil(fontPx * 0.05);
    canvas.width = Math.ceil(m.actualBoundingBoxLeft + m.actualBoundingBoxRight) + pad * 2;
    canvas.height = Math.ceil(m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) + pad * 2;

    ctx.font = fontAt(fontPx);  // resizing a canvas resets its context state
    ctx.fillStyle = colorInput.value;
    ctx.fillText(text, pad + m.actualBoundingBoxLeft, pad + m.actualBoundingBoxAscent);
    return T.canvasToBlob(canvas, "image/png");
  }

  // Resolves to the stamp Blob, or null when there's nothing to stamp yet.
  function makeStamp(forPreview) {
    if (!hasWatermark()) return Promise.resolve(null);
    if (watermarkType() === "text") {
      return renderTextStamp(forPreview ? PREVIEW_MAX : STAMP_MAX_WIDTH);
    }
    return forPreview ? state.logoPreview : Promise.resolve(state.logo);
  }

  /* ---------------------------------------------------------------- */
  /* Live preview                                                      */
  /* ---------------------------------------------------------------- */
  let previewTimer = null;

  function schedulePreview(delay) {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(updatePreview, delay === undefined ? 250 : delay);
  }

  document.getElementById("preview-prev").addEventListener("click", function () {
    stepPreview(-1);
  });
  document.getElementById("preview-next").addEventListener("click", function () {
    stepPreview(1);
  });

  function stepPreview(delta) {
    const n = state.files.length;
    state.previewIndex = (state.previewIndex + delta + n) % n;
    schedulePreview(0);
  }

  async function updatePreview() {
    const file = state.files[state.previewIndex];
    const token = ++state.previewToken;

    previewNav.hidden = state.files.length < 2;
    if (file) previewName.textContent = (state.previewIndex + 1) + " / " + state.files.length + "  ·  " + file.name;

    if (!file) return showPreviewMessage("Select images to see a preview");
    if (!hasWatermark()) {
      return showPreviewMessage(watermarkType() === "text"
        ? "Enter the watermark text"
        : "Choose a logo image to see a preview");
    }

    previewBusy.hidden = false;
    try {
      const results = await Promise.all([previewBase(file), makeStamp(true)]);
      const fd = new FormData();
      fd.append("file", results[0].blob, results[0].name);
      fd.append("stamp", results[1], "stamp.png");
      appendOptions(fd, currentOptions());

      const resp = await fetch("/add-watermark/preview", { method: "POST", body: fd });
      if (!resp.ok) {
        const data = await resp.json().catch(function () { return {}; });
        throw new Error(data.error || "Preview failed (" + resp.status + ")");
      }
      const blob = await resp.blob();
      if (token !== state.previewToken) return;  // a newer preview is on its way

      if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
      state.previewUrl = URL.createObjectURL(blob);
      previewImg.src = state.previewUrl;
      previewImg.hidden = false;
      previewEmpty.hidden = true;
    } catch (err) {
      if (token === state.previewToken) showPreviewMessage(err.message);
    } finally {
      if (token === state.previewToken) previewBusy.hidden = true;
    }
  }

  function showPreviewMessage(msg) {
    previewImg.hidden = true;
    previewEmpty.hidden = false;
    previewEmpty.textContent = msg;
  }

  function previewBase(file) {
    if (!state.previewCache.has(file)) state.previewCache.set(file, downscale(file, PREVIEW_MAX));
    return state.previewCache.get(file);
  }

  // Resolve to {blob, name}: the image scaled so its longest side is at most
  // maxSide, as PNG if it has transparency and as a (much smaller) JPEG otherwise.
  function downscale(file, maxSide) {
    return T.loadImage(file).then(function (img) {
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      const transparent = file.type !== "image/jpeg" && hasTransparency(ctx, canvas.width, canvas.height);
      return T.canvasToBlob(canvas, transparent ? "image/png" : "image/jpeg", 0.9).then(function (blob) {
        return { blob: blob, name: transparent ? "preview.png" : "preview.jpg" };
      });
    });
  }

  function hasTransparency(ctx, width, height) {
    const data = ctx.getImageData(0, 0, width, height).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 255) return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------- */
  /* Apply                                                             */
  /* ---------------------------------------------------------------- */
  processBtn.addEventListener("click", async function () {
    if (state.isProcessing || state.files.length === 0) return;

    state.isProcessing = true;
    updateControls();

    try {
      // Snapshot everything so changes made mid-batch don't mix settings.
      const stamp = await makeStamp(false);
      const options = currentOptions();
      const files = state.files;
      const sessionId = session.id;

      await T.processEach(files, {
        url: "/add-watermark",
        verb: "Watermarking",
        buildForm: function (file) {
          const fd = new FormData();
          fd.append("files[]", file);
          fd.append("stamp", stamp, "stamp.png");
          appendOptions(fd, options);
          fd.append("session_id", sessionId);
          return fd;
        },
        onResult: function (result) {
          results.add(T.buildResultTile(result, sessionId));
        },
      });
    } catch (err) {
      T.showError(err.message);
    } finally {
      state.isProcessing = false;
      updateControls();
    }
  });

  updateControls();
})();
