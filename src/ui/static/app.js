// Menus are <details data-menu>, so they open without this script; it only closes them on an outside
// click or Escape, and keeps one open at a time.
(() => {
  const openMenus = () => document.querySelectorAll("details[data-menu][open]");

  document.addEventListener("click", (event) => {
    for (const menu of openMenus()) {
      if (!menu.contains(event.target)) menu.open = false;
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    for (const menu of openMenus()) {
      menu.open = false;
      menu.querySelector("summary")?.focus();
    }
  });
})();
