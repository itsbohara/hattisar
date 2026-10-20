import { Document } from "../layout.js";

export function ErrorPage() {
  return (
    <Document title="Error">
      <body class="centered">
        <main class="card">
          <h1>Something went wrong</h1>
          <p class="alert alert-error" role="alert">
            hattisar hit an internal error. The details are in its log.
          </p>
          <p>
            <a href="/_hs/projects">Back to projects</a>
          </p>
        </main>
      </body>
    </Document>
  );
}
