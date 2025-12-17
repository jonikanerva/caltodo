function requireSecret(name: string, minLength = 32): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set and should be a strong, random secret`);
  }
  if (value.length < minLength) {
    throw new Error(`${name} must be at least ${minLength} characters long`);
  }
  return value;
}

export const sessionSecret = requireSecret("SESSION_SECRET");
export const actionTokenSecret = requireSecret("ACTION_TOKEN_SECRET");

if (sessionSecret === actionTokenSecret) {
  throw new Error("SESSION_SECRET and ACTION_TOKEN_SECRET must be different values");
}
