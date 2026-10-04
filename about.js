(() => {
  "use strict";

  const extension = globalThis.browser ?? globalThis.chrome;
  const settingsApi = globalThis.LexendSettings;
  const applyTheme = (value) => {
    document.documentElement.dataset.theme = settingsApi.normalizeSettings(value).theme;
  };

  applyTheme();

  const supportCard = document.getElementById("donate-link");
  const confetti = document.getElementById("support-confetti");
  if (supportCard && confetti && globalThis.matchMedia) {
    const reducedMotion = globalThis.matchMedia("(prefers-reduced-motion: reduce)");
    const animations = new Map();
    const particleCount = 16;
    const maxParticles = 64;

    const moveLight = (event) => {
      if (reducedMotion.matches || event.pointerType === "touch") return;
      const bounds = supportCard.getBoundingClientRect();
      supportCard.style.setProperty("--support-mx", `${event.clientX - bounds.left}px`);
      supportCard.style.setProperty("--support-my", `${event.clientY - bounds.top}px`);
    };
    supportCard.addEventListener("pointermove", moveLight);

    const celebrate = (event) => {
      if (reducedMotion.matches || event.pointerType === "touch") return;
      const cardBounds = supportCard.getBoundingClientRect();
      const pointerEntry = event.type === "pointerenter";
      const x = pointerEntry ? event.clientX : cardBounds.left + cardBounds.width / 2;
      const y = pointerEntry ? event.clientY : cardBounds.top + cardBounds.height / 2;

      // Every entry gets a burst, even while earlier particles are still falling.
      // Retire the oldest particles if rapid re-entry reaches the visual budget.
      while (animations.size > maxParticles - particleCount) {
        const [animation, piece] = animations.entries().next().value;
        animations.delete(animation);
        piece.remove();
        animation.cancel();
      }

      for (let index = 0; index < particleCount; index += 1) {
        const piece = document.createElement("span");
        piece.className = "support-confetti-piece";
        confetti.append(piece);
        const dx = (Math.random() - .5) * 160;
        const dy = -55 - Math.random() * 45;
        const spin = (Math.random() - .5) * 180;
        const keyframes = [0, .2, .45, .7, 1].map((time) => ({
          transform: `translate(${x + dx * time}px, ${y + dy * time + 180 * time * time}px) translate(-50%, -50%) rotate(${spin * time}deg)`,
          opacity: time < .55 ? 1 : (1 - time) / .45,
          offset: time
        }));
        const animation = piece.animate(keyframes, {
          duration: 650 + Math.random() * 200,
          easing: "linear"
        });
        animations.set(animation, piece);
        const remove = () => {
          piece.remove();
          animations.delete(animation);
        };
        animation.onfinish = remove;
        animation.oncancel = remove;
      }
    };

    supportCard.addEventListener("pointerenter", celebrate);
    supportCard.addEventListener("focus", (event) => {
      if (supportCard.matches(":focus-visible")) celebrate(event);
    });
    reducedMotion.addEventListener("change", () => {
      if (reducedMotion.matches) {
        for (const [animation, piece] of animations) {
          piece.remove();
          animation.cancel();
        }
        animations.clear();
      }
    });
  }

  extension?.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName === "sync" && Object.hasOwn(changes, "theme")) {
      applyTheme({ theme: changes.theme.newValue });
    }
  });

  const start = async () => {
    try {
      applyTheme(await extension?.storage?.sync?.get(null));
    } catch (error) {
      console.error("Lexend for the Web could not load the interface theme.", error);
    }
  };
  start();
})();
