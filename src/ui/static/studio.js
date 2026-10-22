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

  // A client-side move into another project gets a full load. Studio's logo links to
  // /project/default, its built-in project, without a request hattisar could redirect (design §3).
  // And Studio keeps snippets in memory by id alone, while hattisar gives the same name the same id
  // in every project (§3.3): without a reload, B's editor would show and autosave A's snippet.
  // Never on page load or within one ref: a hattisar project with ref "default" would reload forever.
  let lastRef = PROJECT.exec(location.pathname)?.[1];
  function reloadOnProjectChange() {
    const ref = PROJECT.exec(location.pathname)?.[1];
    const changed =
      ref !== undefined && ref !== lastRef && (lastRef !== undefined || ref === "default");
    lastRef = ref;
    if (changed) location.reload();
  }

  function onNavigate() {
    reloadOnProjectChange();
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
