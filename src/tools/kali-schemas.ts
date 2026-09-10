/**
 * The kali tool contracts exactly as exposed to the model. Extracted from the
 * Pi factory so the Web golden test can hash the real schemas; change these
 * only when you intend to change the model-visible contract.
 */
import { Type } from "typebox";

export const KALI_RUN_DESCRIPTION =
  "Run an allowlisted Kali binary in the campaign container. nmap/nuclei/katana and other scanners return immediately with execution_id and keep running in the container (up to 60 min). Do not poll; finish_step. bash/sh/python3 run /workspace scripts or bash -c.";

export const KALI_RUN_PARAMETERS = Type.Object({
  kind: Type.Literal("kali"),
  bin: Type.String(),
  args: Type.Array(Type.String()),
  url: Type.Optional(Type.String()),
  redirects: Type.Optional(Type.Array(Type.String())),
  timeout_ms: Type.Optional(Type.Number()),
});

export const KALI_WRITE_DESCRIPTION =
  "Write a script or payload file into the campaign container workspace (/workspace)";

export const KALI_WRITE_PARAMETERS = Type.Object({
  kind: Type.Literal("kali_write"),
  path: Type.String({ description: "Relative path under /workspace, e.g. payloads/xss.html" }),
  content: Type.String(),
});

export const PLAYWRIGHT_DESCRIPTION =
  "Operate the persistent Playwright Chromium in the Kali container (goto/snapshot/click/type/press/screenshot/content/wait/back/status). Use snapshot refs for click/type.";

export const PLAYWRIGHT_PARAMETERS = Type.Object({
  kind: Type.Literal("playwright"),
  op: Type.String({ description: "goto|snapshot|click|type|press|screenshot|content|wait|back|status" }),
  url: Type.Optional(Type.String()),
  ref: Type.Optional(Type.String()),
  selector: Type.Optional(Type.String()),
  text: Type.Optional(Type.String()),
  key: Type.Optional(Type.String()),
  timeout_ms: Type.Optional(Type.Number()),
  redirects: Type.Optional(Type.Array(Type.String())),
});
