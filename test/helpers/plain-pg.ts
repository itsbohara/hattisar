import { execFileSync } from "node:child_process";
import { expect } from "vitest";
import { compose } from "../stack.js";
import { postForm } from "./session.js";

export function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

function composeNetwork(): string {
  const db = compose(["ps", "-q", "db"]).trim();
  return docker([
    "inspect",
    "-f",
    "{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}",
    db,
  ]);
}

export function startPlainPg(name: string, image: string, password: string): void {
  docker([
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "--network",
    composeNetwork(),
    "-p",
    "127.0.0.1::5432",
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    image,
  ]);
}

// The init-time server listens on the unix socket only, so TCP readiness means the real server.
export async function waitForTcpReady(container: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      docker(["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`${container} never became ready`);
}

// As the container's superuser; psql variables keep identifiers and literals out of the script text.
export function plainPgSql(
  container: string,
  script: string,
  vars: Record<string, string> = {},
): string {
  const varArgs = Object.entries(vars).flatMap(([name, value]) => ["-v", `${name}=${value}`]);
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-U",
      "postgres",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      ...varArgs,
    ],
    { encoding: "utf8", input: script },
  ).trim();
}

export function createAdmin(
  container: string,
  name: string,
  password: string,
  attributes: string,
): void {
  plainPgSql(container, `CREATE ROLE :"name" LOGIN ${attributes} PASSWORD :'password';`, {
    name,
    password,
  });
}

export async function boxesPage(baseUrl: string, cookie: string): Promise<string> {
  const response = await fetch(`${baseUrl}/_hs/boxes`, { headers: { cookie } });
  expect(response.status).toBe(200);
  return response.text();
}

export function boxIdFrom(html: string, name: string): string {
  const row = html.split("<tr").find((part) => part.includes(`data-box="${name}"`));
  const id = row?.match(/\/_hs\/boxes\/(\d+)\/edit/)?.[1];
  if (!id) throw new Error(`box ${name} not listed`);
  return id;
}

export function registerBox(
  baseUrl: string,
  cookie: string,
  fields: Record<string, string>,
): Promise<Response> {
  return postForm(
    baseUrl,
    "/_hs/boxes",
    { port: "5432", sslmode: "disable", publicHost: "localhost", publicPort: "5432", ...fields },
    cookie,
  );
}

export function removeBox(baseUrl: string, cookie: string, id: string): Promise<Response> {
  return postForm(baseUrl, `/_hs/boxes/${id}/remove`, {}, cookie);
}
