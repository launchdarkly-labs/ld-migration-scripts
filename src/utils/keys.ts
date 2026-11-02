/** LaunchDarkly resource keys: start with a letter or number, then letters, numbers, ".", "_" or "-". */
const RESOURCE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_KEY_LENGTH = 256;

export function isValidResourceKey(key: string): boolean {
  return key.length <= MAX_KEY_LENGTH && RESOURCE_KEY.test(key);
}
