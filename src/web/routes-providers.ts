import { ProviderCatalog } from "../provider/catalog.ts";
import { testConnection } from "../provider/probe.ts";
import { invalidInput } from "../domain/errors.ts";
import type { SlotName } from "../provider/types.ts";
import type { ApiHandler } from "./server.ts";

type Add = (method: string, pattern: string, handler: ApiHandler) => void;

/**
 * HTTP twin of the provider CLI surface. Same catalog, same secrets file;
 * keys are write-only over the wire exactly like the CLI never prints them.
 */
export function registerProviderRoutes(add: Add, dataDir: string): void {
  const cat = () => new ProviderCatalog(dataDir);

  add("GET", "/api/catalog", () => cat().publicSnapshot());

  add("POST", "/api/providers", async (ctx) => {
    const body = await ctx.json<{ display_name?: string; protocol?: string; base_url?: string; api_key?: string }>();
    return cat().addProvider({
      display_name: body.display_name ?? "provider",
      protocol: body.protocol ?? "",
      base_url: body.base_url ?? "",
      api_key: body.api_key ?? "",
    });
  });

  add("PATCH", "/api/providers/:id", async (ctx) => {
    const body = await ctx.json<{ display_name?: string; protocol?: string; base_url?: string; api_key?: string }>();
    const c = cat();
    const rec = c.updateProvider({
      provider_id: ctx.params.id ?? "",
      display_name: body.display_name,
      protocol: body.protocol,
      base_url: body.base_url,
    });
    if (typeof body.api_key === "string" && body.api_key !== "") c.setApiKey(rec.id, body.api_key);
    return { ...rec, api_key_set: c.hasApiKey(rec.id) };
  });

  add("POST", "/api/providers/:id/key", async (ctx) => {
    const body = await ctx.json<{ api_key?: string; clear?: boolean }>();
    const c = cat();
    const id = ctx.params.id ?? "";
    if (body.clear === true) return c.clearApiKey(id);
    if (typeof body.api_key !== "string" || body.api_key === "") throw invalidInput("missing_key", "api_key is required");
    return c.setApiKey(id, body.api_key);
  });

  add("DELETE", "/api/providers/:id", (ctx) => cat().removeProvider(ctx.params.id ?? ""));

  add("POST", "/api/models", async (ctx) => {
    const body = await ctx.json<{
      provider_id?: string;
      name?: string;
      context_window?: number;
      max_output_tokens?: number;
      vision?: boolean;
    }>();
    return cat().addModel({
      provider_id: body.provider_id ?? "",
      name: body.name ?? "",
      context_window: typeof body.context_window === "number" ? body.context_window : undefined,
      max_output_tokens: typeof body.max_output_tokens === "number" ? body.max_output_tokens : undefined,
      vision: typeof body.vision === "boolean" ? body.vision : undefined,
    });
  });

  add("DELETE", "/api/models/:id", (ctx) => cat().removeModel(ctx.params.id ?? ""));

  add("POST", "/api/test", async (ctx) => {
    const body = await ctx.json<{ provider_id?: string; model_id?: string }>();
    const c = cat();
    const provider = c.getProvider(body.provider_id ?? "");
    const model = c.getModel(body.model_id ?? "");
    const key = c.apiKey(provider.id);
    if (!key) throw invalidInput("missing_api_key", `no api key stored for ${provider.display_name}`);
    const report = await testConnection({ provider, model, apiKey: key });
    const available = report.auth.ok && report.text.ok;
    c.setModelAvailable(model.id, available, report);
    return { model: model.name, available, report };
  });

  add("POST", "/api/slots", async (ctx) => {
    const body = await ctx.json<{ slot?: string; ref?: string }>();
    if (typeof body.slot !== "string" || typeof body.ref !== "string") {
      throw invalidInput("missing_slot", "slots requires { slot, ref }");
    }
    return cat().assignSlot(body.slot as SlotName, body.ref);
  });
}
