(() => {
  "use strict";

  const extension = globalThis.browser ?? globalThis.chrome;
  const storage = extension?.storage?.sync;
  const defaults = { enabled: true, scope: "body" };
  const enabledInput = document.querySelector("#enabled");
  const fieldset = document.querySelector("#scope-fieldset");
  const status = document.querySelector("#status");
  const scopeInputs = [...document.querySelectorAll('input[name="scope"]')];
  let statusTimer;

  const showStatus = (message) => {
    status.textContent = message;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      status.textContent = enabledInput.checked ? "ACTIVE" : "PAUSED";
    }, 1200);
  };

  const render = ({ enabled, scope }) => {
    enabledInput.checked = enabled;
    fieldset.disabled = !enabled;
    scopeInputs.forEach((input) => {
      input.checked = input.value === scope;
      input.closest(".choice").classList.toggle("is-selected", input.checked);
    });
    status.textContent = enabled ? "ACTIVE" : "PAUSED";
  };

  const save = async (nextSettings) => {
    if (!storage) {
      showStatus("PREVIEW");
      return;
    }

    try {
      await storage.set(nextSettings);
      showStatus("SAVED");
    } catch (error) {
      console.error("Lexend the Web could not save settings.", error);
      status.textContent = "SAVE FAILED";
    }
  };

  enabledInput.addEventListener("change", () => {
    fieldset.disabled = !enabledInput.checked;
    save({ enabled: enabledInput.checked });
  });

  scopeInputs.forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) {
        scopeInputs.forEach((scopeInput) => {
          scopeInput.closest(".choice").classList.toggle(
            "is-selected",
            scopeInput === input
          );
        });
        save({ scope: input.value });
      }
    });
  });

  if (storage) {
    storage.get(defaults).then(render).catch((error) => {
      console.error("Lexend the Web could not load settings.", error);
      render(defaults);
      status.textContent = "LOAD FAILED";
    });
  } else {
    render(defaults);
  }
})();
