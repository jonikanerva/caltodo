const setDefaultEnv = (key: string, value: string) => {
  if (!process.env[key]) {
    process.env[key] = value
  }
}

setDefaultEnv("SESSION_SECRET", "integration-session-secret-32-chars-long")
setDefaultEnv("ACTION_TOKEN_SECRET", "integration-action-secret-32-chars-long")
setDefaultEnv("TOKEN_ENCRYPTION_KEY", "integration-encryption-key-32-chars")
setDefaultEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/caltodo_test")
