// Stub Split Admin API server for smoke-testing source_from_split.ts
const page = (objects: unknown[]) => ({ objects, offset: 0, limit: 50, totalCount: objects.length });

const routes: Record<string, unknown> = {
  "/internal/api/v2/workspaces": page([{ id: "ws-1", name: "Demo Workspace" }]),
  "/internal/api/v2/environments/ws/ws-1": [
    { id: "env-prod", name: "Prod-Default", production: true },
    { id: "env-stg", name: "Staging", production: false },
  ],
  "/internal/api/v2/trafficTypes/ws/ws-1": [
    { id: "tt-user", name: "user", displayAttributeId: "userId" },
    { id: "tt-acct", name: "account", displayAttributeId: "accountId" },
  ],
  "/internal/api/v2/splits/ws/ws-1": page([
    { id: "f1", name: "paywall_beta", description: "Paywall test", trafficType: { id: "tt-user", name: "user" }, tags: [{ name: "checkout" }] },
    { id: "f2", name: "new_homepage", description: "Homepage", trafficType: { id: "tt-user", name: "user" }, tags: null },
    { id: "f3", name: "widget_redesign", description: "Depends on homepage", trafficType: { id: "tt-user", name: "user" }, tags: null },
  ]),
  "/internal/api/v3/flag-sets": { data: [{ id: "fs-1", name: "core checkout" }] },
  "/internal/api/v2/splits/ws/ws-1/environments/env-prod": page([
    {
      name: "paywall_beta",
      environment: { id: "env-prod", name: "Prod-Default" },
      trafficType: { id: "tt-user", name: "user" },
      killed: false,
      treatments: [
        { name: "on", configurations: '{"price": 9.99}', keys: ["vip-user"], segments: ["Beta Testers"] },
        { name: "off", keys: ["blocked-user"] },
      ],
      defaultTreatment: "off",
      trafficAllocation: 100,
      flagSets: [{ id: "fs-1" }],
      rules: [
        {
          condition: {
            combiner: "AND",
            matchers: [
              { type: "IN_LIST_STRING", attribute: "plan", strings: ["pro", "team"] },
              { type: "GREATER_THAN_OR_EQUAL_TO_SEMVER", attribute: "appVersion", string: "2.0.0" },
            ],
          },
          buckets: [{ treatment: "on", size: 50 }, { treatment: "off", size: 50 }],
        },
      ],
      defaultRule: [{ treatment: "off", size: 100 }],
    },
    {
      name: "new_homepage",
      environment: { id: "env-prod", name: "Prod-Default" },
      trafficType: { id: "tt-user", name: "user" },
      killed: false,
      treatments: [{ name: "on" }, { name: "off" }],
      defaultTreatment: "off",
      trafficAllocation: 100,
      rules: [],
      defaultRule: [{ treatment: "on", size: 25 }, { treatment: "off", size: 75 }],
    },
    {
      name: "widget_redesign",
      environment: { id: "env-prod", name: "Prod-Default" },
      trafficType: { id: "tt-user", name: "user" },
      killed: false,
      treatments: [{ name: "on" }, { name: "off" }],
      defaultTreatment: "off",
      trafficAllocation: 100,
      rules: [
        {
          condition: { combiner: "AND", matchers: [{ type: "IN_SPLIT", depends: { splitName: "new_homepage", treatment: "on" } }] },
          buckets: [{ treatment: "on", size: 100 }],
        },
      ],
      defaultRule: [{ treatment: "off", size: 100 }],
    },
  ]),
  "/internal/api/v2/splits/ws/ws-1/environments/env-stg": page([
    {
      name: "paywall_beta",
      environment: { id: "env-stg", name: "Staging" },
      trafficType: { id: "tt-user", name: "user" },
      killed: true,
      treatments: [{ name: "on", configurations: '{"price": 4.99}' }, { name: "off" }],
      defaultTreatment: "off",
      trafficAllocation: 50,
      rules: [],
      defaultRule: [{ treatment: "on", size: 100 }],
    },
  ]),
  "/internal/api/v2/segments/ws/ws-1": page([
    { name: "Beta Testers", description: "beta", trafficType: { id: "tt-user", name: "user" }, tags: null },
    { name: "Key Accounts", description: "accts", trafficType: { id: "tt-acct", name: "account" }, tags: null },
  ]),
  "/internal/api/v2/segments/ws/ws-1/environments/env-prod": page([
    { name: "Beta Testers", environment: { id: "env-prod", name: "Prod-Default" }, trafficType: { id: "tt-user", name: "user" } },
    { name: "Key Accounts", environment: { id: "env-prod", name: "Prod-Default" }, trafficType: { id: "tt-acct", name: "account" } },
  ]),
  "/internal/api/v2/segments/ws/ws-1/environments/env-stg": page([]),
  "/internal/api/v2/segments/env-prod/Beta Testers/keys": { keys: [{ key: "u1" }, { key: "u2" }], count: 2, offset: 0, limit: 100 },
  "/internal/api/v2/segments/env-prod/Key Accounts/keys": { keys: [{ key: "acme" }], count: 1, offset: 0, limit: 100 },
  "/internal/api/v2/rule-based-segments/ws/ws-1/environments/env-prod": page([
    {
      id: "rbs-1",
      name: "Beta Emails",
      description: "beta by email",
      trafficType: { id: "tt-user", name: "user" },
      rules: [{ condition: { combiner: "AND", matchers: [{ attribute: "email", operator: "ends_with", value: "@beta.example.com" }] } }],
      excludedKeys: ["u9"],
      excludedSegments: [{ name: "Beta Testers", type: "segment" }],
    },
  ]),
  "/internal/api/v2/rule-based-segments/ws/ws-1/environments/env-stg": page([]),
  "/internal/api/v2/large-segments/ws/ws-1/environments/env-prod": page([
    { name: "All Customers", trafficType: { id: "tt-user", name: "user" }, creationTime: 1508261321997 },
  ]),
  "/internal/api/v2/large-segments/ws/ws-1/environments/env-stg": page([]),
};

Deno.serve({ port: 8571 }, (req) => {
  const url = new URL(req.url);
  const path = decodeURIComponent(url.pathname);
  const offset = Number(url.searchParams.get("offset") ?? "0");
  const body = routes[path];
  if (body === undefined) {
    console.error("MISS", path);
    return new Response(JSON.stringify({ code: 404, message: `no stub for ${path}` }), { status: 404 });
  }
  // Second page of any paginated endpoint is empty
  if (offset > 0) {
    const b = body as Record<string, unknown>;
    if (Array.isArray(b.objects)) return Response.json({ objects: [], offset, limit: 50, totalCount: b.objects.length });
    if (Array.isArray(b.keys)) return Response.json({ keys: [], count: b.keys.length, offset, limit: 100 });
  }
  return Response.json(body);
});
