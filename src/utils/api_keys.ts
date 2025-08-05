interface ApiKeys {
  source_account_api_key: string;
  destination_account_api_key: string;
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
