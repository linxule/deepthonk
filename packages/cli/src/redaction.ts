// Match keys that hold a secret value. Exclude metadata pointers like apiKeyEnv/apiKeyFile/apiKeyStdin
// which only name where the secret lives.
export const SECRET_KEY_RE = /^(api[_-]?key|token|secret|password|authorization|bearer|cookie|credential)$/i;
export { rejectAllSecretShapedFields } from "@deepthonk/providers";

export function redacted(value: unknown): unknown {
  const serialized = JSON.stringify(value, (key, inner) => {
    if (SECRET_KEY_RE.test(key) && inner) return "[redacted]";
    return inner;
  });
  return serialized === undefined ? undefined : JSON.parse(serialized);
}
