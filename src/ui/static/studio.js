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
  let leftForConnect = false;

  function redirectConnect() {
    const ref = PROJECT.exec(location.pathname)?.[1];
    const url = new URL(location.href);
    if (!ref || url.searchParams.get("showConnect") !== "true") return;
    // Without this, Back returns to the sheet's URL and redirects again.
    for (const name of CONNECT_PARAMS) url.searchParams.delete(name);
    replaceState.call(history, history.state, "", url);
    leftForConnect = true;
    location.assign(`/_hs/projects/${ref}`);
  }

  // Back restores this page from the back/forward cache with the sheet Studio had already opened.
  addEventListener("pageshow", (event) => {
    if (event.persisted && leftForConnect) location.reload();
  });

  // Studio's logo links to /project/default, its built-in project, and navigates there without a
  // request hattisar could redirect (design §3). A full load lets the server decide. Never on page
  // load or within /project/default: a hattisar project with ref "default" would reload forever.
  let lastRef = PROJECT.exec(location.pathname)?.[1];
  function loadDefaultFromServer() {
    const ref = PROJECT.exec(location.pathname)?.[1];
    const entered = ref === "default" && lastRef !== "default";
    lastRef = ref;
    if (entered) location.reload();
  }

  function onNavigate() {
    loadDefaultFromServer();
    redirectConnect();
  }

  history.pushState = function (...args) {
    pushState.apply(this, args);
    onNavigate();
  };
  history.replaceState = function (...args) {
    replaceState.apply(this, args);
    onNavigate();
  };
  addEventListener("popstate", onNavigate);
  redirectConnect();
})();
