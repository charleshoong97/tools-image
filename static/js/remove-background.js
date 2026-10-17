(function () {
  "use strict";

  const T = window.ImageTools;

  const session = T.createSession();
  const state = {
    pendingFiles: [],
    isProcessing: false,
  };

  const processBtn = document.getElementById("process-btn");
  const colorInput = document.getElementById("bg-color");
  const backgroundRadios = document.querySelectorAll('input[name="background"]');

  const uploadZone = T.bindUploadZone(T.IMAGE_EXTENSIONS, function (files) {
    state.pendingFiles = files;
    processBtn.disabled = false;
    uploadZone.setLabel(T.selectionLabel(files));
  });
  const results = T.createResultsList(session);

  /* ---------------------------------------------------------------- */
  /* Background option                                                 */
  /* ---------------------------------------------------------------- */
  backgroundRadios.forEach(function (radio) {
    radio.addEventListener("change", function () {
      colorInput.hidden = selectedBackground() !== "custom";
    });
  });

  function selectedBackground() {
    return document.querySelector('input[name="background"]:checked').value;
  }

  /* ---------------------------------------------------------------- */
  /* Processing                                                        */
  /* ---------------------------------------------------------------- */
  processBtn.addEventListener("click", function () {
    if (state.isProcessing || state.pendingFiles.length === 0) return;

    const choice = selectedBackground();
    const background = choice === "custom" ? colorInput.value : choice;
    const files = state.pendingFiles;
    const sessionId = session.id;

    state.isProcessing = true;
    processBtn.disabled = true;

    T.processEach(files, {
      url: "/remove-background",
      verb: "Removing background",
      buildForm: function (file) {
        const fd = new FormData();
        fd.append("files[]", file);
        fd.append("background", background);
        fd.append("session_id", sessionId);
        return fd;
      },
      onResult: function (result) {
        results.add(T.buildResultTile(result, sessionId));
      },
    }).then(function () {
      state.isProcessing = false;
      state.pendingFiles = [];
      uploadZone.resetLabel();
    });
  });
})();
