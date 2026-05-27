/**
 * App configuration loader.
 *
 * Reads a JSON file at APPS_CONFIG_PATH (default ./apps.json) and exposes
 * helpers to look up app configs and validate redirect URIs.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

export type AppRole = {
  name: string;
  /** Higher rank = more privileged */
  rank: number;
};

export type AppConfig = {
  id: string;
  name: string;
  /** Name of the env var holding the bcrypt-hashed client secret */
  clientSecretEnv: string;
  allowedRedirectUris: string[];
  /** Origins allowed to call /refresh and /logout with credentials */
  allowedOrigins: string[];
  roles: AppRole[];
};

type AppsFile = AppConfig[];

let _apps: Map<string, AppConfig> | null = null;

function loadFromFile(): Map<string, AppConfig> {
  const configPath =
    process.env['APPS_CONFIG_PATH'] ?? join(process.cwd(), 'apps.json');
  const raw = readFileSync(configPath, 'utf-8');
  const configs: AppsFile = JSON.parse(raw);
  const map = new Map<string, AppConfig>();
  for (const cfg of configs) {
    map.set(cfg.id, cfg);
  }
  return map;
}

function getAppsMap(): Map<string, AppConfig> {
  if (!_apps) {
    _apps = loadFromFile();
  }
  return _apps;
}

/** Reset the in-memory config (useful in tests to inject a different config). */
export function resetAppsConfig(): void {
  _apps = null;
}

/** Inject a config directly (used in tests). */
export function setAppsConfig(configs: AppConfig[]): void {
  _apps = new Map(configs.map((c) => [c.id, c]));
}

export function getApp(clientId: string): AppConfig | undefined {
  return getAppsMap().get(clientId);
}

export function getAllApps(): AppConfig[] {
  return Array.from(getAppsMap().values());
}

/** Returns true if redirectUri is in the app's allow-list. */
export function validateRedirectUri(app: AppConfig, redirectUri: string): boolean {
  return app.allowedRedirectUris.includes(redirectUri);
}

/**
 * Get the bcrypt-hashed client secret for an app from the environment variable
 * named in clientSecretEnv.
 */
export function getClientSecretHash(app: AppConfig): string {
  const hash = process.env[app.clientSecretEnv];
  if (!hash) {
    throw new Error(`Environment variable ${app.clientSecretEnv} is not set for app ${app.id}`);
  }
  return hash;
}

/**
 * Return the rank of a role name within an app config, or -1 if unknown.
 */
export function getRoleRank(app: AppConfig, roleName: string): number {
  return app.roles.find((r) => r.name === roleName)?.rank ?? -1;
}
