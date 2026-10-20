// Studio renders its top bar on the client and rebuilds it on navigation, so the link is re-added
// whenever it goes missing.
(() => {
  const ID = "hattisar-back";

  function addBackLink() {
    const header = document.querySelector("header");
    if (!header || document.getElementById(ID)) return;
    const link = document.createElement("a");
    link.id = ID;
    link.href = "/_hs/projects";
    link.textContent = "← hattisar";
    const home = header.querySelector('a[href="/project/default"]');
    if (home) home.before(link);
    else header.firstElementChild?.prepend(link);
  }

  new MutationObserver(addBackLink).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  addBackLink();
})();
