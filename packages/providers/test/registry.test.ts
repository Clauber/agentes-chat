import { describe, expect, test } from "bun:test";
import { MODEL_CATALOG, PROVIDER_IDS } from "../src/catalog";
import { PLAN_IDS } from "../src/plans";
import { REGISTRY, type Registry, type RegistryModel, resolveRoles, routeModels } from "../src/registry";

const ROUTES = new Set<string>([
  ...PROVIDER_IDS,
  ...PLAN_IDS.map((p) => `plan:${p}`),
  "codex",
  "cli:grok",
  "cli:antigravity",
  "cli:opencode-free",
]);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

describe("the model registry (models.json)", () => {
  test("every model has a name and somewhere to run, on routes that exist", () => {
    const problems = Object.entries(REGISTRY.models).flatMap(([id, m]) => [
      ...(m.label.trim() ? [] : [`${id}: no label`]),
      ...(Object.keys(m.on).length ? [] : [`${id}: runs nowhere`]),
      ...Object.keys(m.on).flatMap((route) => (ROUTES.has(route) ? [] : [`${id}: unknown route ${route}`])),
      ...(m.released === undefined || DAY.test(m.released) ? [] : [`${id}: released ${m.released}`]),
    ]);
    expect(problems).toEqual([]);
  });

  test("an API route always has prices, in USD per million tokens; a plan or a CLI never does", () => {
    const problems = Object.entries(REGISTRY.models).flatMap(([id, m]) =>
      Object.entries(m.on).flatMap(([route, r]) => {
        const api = (PROVIDER_IDS as readonly string[]).includes(route);
        // Above $1,000 per million tokens is a price typed per token, or in nano-USD.
        const odd = Object.values(r.prices ?? {}).some((v) => !(v >= 0 && v < 1000));
        return (r.prices !== undefined) === api && !odd ? [] : [`${id} on ${route}`];
      }),
    );
    expect(problems).toEqual([]);
  });

  test("every role goes to a family that has a model on its route, and to only one newest model", () => {
    const held = resolveRoles();
    const problems = Object.entries(REGISTRY.roles).flatMap(([route, roles]) =>
      Object.entries(roles).flatMap(([role, family]) => {
        const on = route === "claude-code" ? "anthropic" : route;
        // A tie would leave the file's order to decide: each family's models on a route need distinct days.
        const days = routeModels(on)
          .filter(([, m]) => m.family === family)
          .map(([, m]) => m.released ?? "");
        return [
          ...(held.get(route)?.has(role as never) ? [] : [`${role} on ${route}: no ${family} model there`]),
          ...(new Set(days).size === days.length ? [] : [`${family} on ${on}: two models released the same day`]),
        ];
      }),
    );
    expect(problems).toEqual([]);
  });

  test("two models never send the same id on one route", () => {
    for (const route of ROUTES) {
      const sent = routeModels(route).map(([id, , r]) => r.id ?? id);
      expect(sent.filter((id, i) => sent.indexOf(id) !== i)).toEqual([]);
    }
  });

  test("the catalog is every API route's model, Claude's with its suggested model and its three sizes", () => {
    const rows = PROVIDER_IDS.flatMap((p) => routeModels(p));
    expect(Object.keys(MODEL_CATALOG)).toHaveLength(rows.length);
    expect(MODEL_CATALOG["claude-sonnet-5-5"]).toMatchObject({ recommended: true, tier: "medium" });
    expect(MODEL_CATALOG["claude-opus-5-5"]?.tier).toBe("large");
    expect(MODEL_CATALOG["claude-haiku-5-5"]).toMatchObject({ tier: "small", cheap: true, router: true });
    // Prices turn into nano-USD per token: $0.006 per million tokens is 6.
    expect(MODEL_CATALOG["deepseek-flash"]?.prices.cacheRead).toBe(6);
  });
});

describe("roles follow each family's newest model", () => {
  const sonnet = (released: string, price: number): RegistryModel => ({
    label: `Sonnet ${released}`,
    family: "claude-sonnet",
    released,
    on: { anthropic: { prices: { input: price, output: price, cacheRead: price, cacheWrite: price } } },
  });
  const registry = (models: Record<string, RegistryModel>): Registry => ({
    updatedAt: "2026-11-17",
    sources: {},
    roles: {
      anthropic: { medium: "claude-sonnet", recommended: "claude-sonnet" },
      "claude-code": { sonnet: "claude-sonnet" },
      "plan:zai": { sonnet: "claude-sonnet" },
    },
    models,
  });

  test("a newer model of the family takes its roles with no other change, wherever it is in the file", () => {
    const held = resolveRoles(
      registry({ "sonnet-new": sonnet("2026-12-01", 2), "sonnet-old": sonnet("2026-09-28", 2) }),
    );
    expect(held.get("anthropic")?.get("medium")).toBe("sonnet-new");
    expect(held.get("anthropic")?.get("recommended")).toBe("sonnet-new");
    // Claude Code's alias runs Claude's API models.
    expect(held.get("claude-code")?.get("sonnet")).toBe("sonnet-new");
    const reversed = resolveRoles(
      registry({ "sonnet-old": sonnet("2026-09-28", 2), "sonnet-new": sonnet("2026-12-01", 2) }),
    );
    expect(reversed.get("anthropic")?.get("medium")).toBe("sonnet-new");
  });

  test("a route without the family's models gives the role to no one", () => {
    const held = resolveRoles(registry({ "sonnet-old": sonnet("2026-09-28", 2) }));
    expect(held.get("plan:zai")?.get("sonnet")).toBeUndefined();
  });
});
