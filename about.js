(() => {
  "use strict";

  const extension = globalThis.browser ?? globalThis.chrome;
  const settingsApi = globalThis.LexendSettings;
  const applyTheme = (value) => {
    document.documentElement.dataset.theme = settingsApi.normalizeSettings(value).theme;
  };

  applyTheme();

  const supportCard = document.getElementById("donate-link");
  const confetti = supportCard?.querySelector(".support-confetti");
  const orb = supportCard?.querySelector(".support-orb");
  if (confetti && orb && globalThis.matchMedia) {
    const reducedMotion = globalThis.matchMedia("(prefers-reduced-motion: reduce)");
    const animations = new Set();
    let lastBurst = -Infinity;

    const celebrate = (event) => {
      if (reducedMotion.matches || event.pointerType === "touch"
          || animations.size || performance.now() - lastBurst < 1200) return;
      lastBurst = performance.now();
      const cardBounds = supportCard.getBoundingClientRect();
      const orbBounds = orb.getBoundingClientRect();
      const x = orbBounds.left + orbBounds.width / 2 - cardBounds.left;
      const y = orbBounds.top + orbBounds.height / 2 - cardBounds.top;

      for (let index = 0; index < 28; index += 1) {
        const piece = document.createElement("span");
        piece.className = "support-confetti-piece";
        confetti.append(piece);
        const angle = (index / 28) * Math.PI * 2;
        const distance = 50 + Math.random() * Math.min(cardBounds.width * .55, 240);
        const dx = Math.cos(angle) * distance;
        const dy = Math.sin(angle) * distance;
        const spin = (Math.random() - .5) * 720;
        const animation = piece.animate([
          { transform: `translate(${x}px, ${y}px) rotate(0deg) scale(.4)`, opacity: 0 },
          { transform: `translate(${x + dx * .55}px, ${y + dy * .55}px) rotate(${spin * .5}deg) scale(1)`, opacity: 1, offset: .25 },
          { transform: `translate(${x + dx}px, ${y + dy + 100}px) rotate(${spin}deg) scale(.6)`, opacity: 0 }
        ], {
          duration: 1000 + Math.random() * 400,
          easing: "cubic-bezier(.15, .65, .35, 1)"
        });
        animations.add(animation);
        const remove = () => {
          piece.remove();
          animations.delete(animation);
        };
        animation.onfinish = remove;
        animation.oncancel = remove;
      }
    };

    supportCard.addEventListener("pointerenter", celebrate);
    supportCard.addEventListener("focus", celebrate);
    reducedMotion.addEventListener("change", () => {
      if (reducedMotion.matches) {
        for (const animation of animations) animation.cancel();
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
