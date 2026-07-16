interface ApiKeys {
  source_account_api_key: string;
  destination_account_api_key: string;
  /** Split (Harness FME) Admin API key for the Split → LD source adapter. */
  split_api_key?: string;
}

let cachedApiKeys: ApiKeys | null = null;

export async function loadApiKeys(): Promise<ApiKeys> {
  if (cachedApiKeys !== null) {
    return cachedApiKeys;
  }

  try {
    const configPath = new URL("../../config/api_keys.json", import.meta.url);
    const configText = await Deno.readTextFile(configPath);
    const keys = JSON.parse(configText) as ApiKeys;
    cachedApiKeys = keys;
    return keys;
  } catch (error) {
    console.error("Error loading API keys:", error instanceof Error ? error.message : String(error));
    console.error("Please ensure config/api_keys.json exists with valid API keys");
    Deno.exit(1);
  }
}

export async function getSourceApiKey(): Promise<string> {
  const keys = await loadApiKeys();
  return keys.source_account_api_key;
}

export async function getDestinationApiKey(): Promise<string> {
  const keys = await loadApiKeys();
  return keys.destination_account_api_key;
}

/**
 * Split Admin API key: prefers the SPLIT_API_KEY environment variable,
 * falls back to split_api_key in config/api_keys.json.
 */
export async function getSplitApiKey(): Promise<string> {
  const fromEnv = Deno.env.get("SPLIT_API_KEY");
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  const keys = await loadApiKeys();
  if (keys.split_api_key && keys.split_api_key.length > 0) {
    return keys.split_api_key;
  }

  console.error("No Split API key found.");
  console.error("Set the SPLIT_API_KEY environment variable or add split_api_key to config/api_keys.json");
  Deno.exit(1);
}

