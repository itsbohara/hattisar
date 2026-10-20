import { compose } from "../stack.js";

export interface S3Test {
  accessKey: string;
  secretKey: string;
  bucket: string;
}

export function s3TestService(): S3Test {
  const config = JSON.parse(compose(["--profile", "s3-test", "config", "--format", "json"])) as {
    services: Record<string, { environment: Record<string, string> } | undefined>;
  };
  const env = config.services["s3-bucket"]?.environment;
  if (!env) throw new Error("the s3-test profile is missing from the compose files");
  return {
    accessKey: env.S3_TEST_ACCESS_KEY as string,
    secretKey: env.S3_TEST_SECRET_KEY as string,
    bucket: env.S3_TEST_BUCKET as string,
  };
}

export function s3Fields(
  s3: S3Test,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    endpoint: "http://s3:9000",
    region: "us-east-1",
    bucket: s3.bucket,
    accessKeyId: s3.accessKey,
    secretAccessKey: s3.secretKey,
    forcePathStyle: "on",
    prefix: "it-backups",
    ...overrides,
  };
}

// A request on the object, signed inside the s3 container (its port is not published).
function objectRequest(s3: S3Test, key: string, args: string[], input?: string): string {
  return compose(
    [
      "exec",
      "-T",
      "s3",
      "curl",
      "-s",
      ...args,
      "--aws-sigv4",
      "aws:amz:us-east-1:s3",
      "--user",
      `${s3.accessKey}:${s3.secretKey}`,
      `http://localhost:9000/${s3.bucket}/${key}`,
    ],
    input,
  ).trim();
}

export function objectStatus(
  s3: S3Test,
  key: string,
): { status: number; length: number | undefined } {
  const out = objectRequest(s3, key, [
    "-o",
    "/dev/null",
    "-w",
    "%{http_code} %header{content-length}",
    "-I",
  ]);
  const [status, length] = out.split(" ");
  return { status: Number(status), length: length ? Number(length) : undefined };
}

export function putObject(s3: S3Test, key: string, body: string): void {
  objectRequest(s3, key, ["-f", "-X", "PUT", "--data-binary", "@-"], body);
}

export function deleteObject(s3: S3Test, key: string): void {
  objectRequest(s3, key, ["-f", "-X", "DELETE"]);
}
