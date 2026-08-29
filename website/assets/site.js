(() => {
  const root = document.documentElement;
  const stored = localStorage.getItem("gx-theme");
  const preferred = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  const applyTheme = (theme) => {
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    document.querySelectorAll("[data-theme-label]").forEach((el) => {
      el.textContent = theme === "dark" ? "Light mode" : "Dark mode";
    });
    document.querySelectorAll("[data-theme-icon]").forEach((el) => {
      el.textContent = theme === "dark" ? "☀" : "◐";
    });
  };

  applyTheme(stored || preferred);

  document.addEventListener("click", (event) => {
    const themeButton = event.target.closest("[data-theme-toggle]");
    if (themeButton) {
      const next = root.dataset.theme === "dark" ? "light" : "dark";
      localStorage.setItem("gx-theme", next);
      applyTheme(next);
    }

    const navButton = event.target.closest("[data-nav-toggle]");
    if (navButton) {
      const nav = document.querySelector("[data-nav]");
      const open = nav.classList.toggle("open");
      navButton.setAttribute("aria-expanded", String(open));
    }
  });

  const year = document.querySelector("[data-year]");
  if (year) year.textContent = String(new Date().getFullYear());
})();
