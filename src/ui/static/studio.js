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

// Studio's Connect sheet shows Studio's own default database whatever hattisar answers (design §3),
// so opening it goes to the project's page in hattisar instead. Studio opens the sheet by setting
// ?showConnect=true through history.pushState/replaceState without a reload, hence the wrappers.
(() => {
  const PROJECT = /^\/project\/([^/]+)/;
  const CONNECT_PARAMS = ["showConnect", "connectTab", "method"];
  const { pushState, replaceState } = history;

  function redirectConnect() {
    const ref = PROJECT.exec(location.pathname)?.[1];
    const url = new URL(location.href);
    if (!ref || url.searchParams.get("showConnect") !== "true") return;
    // Without this, Back returns to the sheet's URL and redirects again.
    for (const name of CONNECT_PARAMS) url.searchParams.delete(name);
    replaceState.call(history, history.state, "", url);
    location.assign(`/_hs/projects/${ref}`);
  }

  history.pushState = function (...args) {
    pushState.apply(this, args);
    redirectConnect();
  };
  history.replaceState = function (...args) {
    replaceState.apply(this, args);
    redirectConnect();
  };
  addEventListener("popstate", redirectConnect);
  redirectConnect();
})();
