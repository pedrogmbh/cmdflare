/** config: profiles and defaults */
import { configPath, loadConfig, maskSecret, saveConfig, type Profile } from '../core/config';
import { EXIT, UsageError } from '../core/errors';
import { formatOutput } from '../core/output';
import { clearNameCache } from '../core/resolve';
import { c, log, stdoutIsTTY } from '../core/ui';
import { BUILTIN_HELP } from './index';

const PROFILE_KEYS: Array<keyof Profile> = ['account_id', 'zone_id', 'api_token', 'api_key', 'email', 'user_service_key', 'base_url'];
const SETTING_KEYS = ['output', 'color', 'per_page'];
const SECRET_KEYS = new Set(['api_token', 'api_key', 'user_service_key']);

export async function runConfig(args: string[], gf: Record<string, any>): Promise<number> {
  const sub = args[0];
  if (!sub || gf.help || sub === 'help') {
    process.stdout.write(BUILTIN_HELP.config + '\n');
    return EXIT.OK;
  }
  const cfg = loadConfig();
  const profileName: string = gf.profile || process.env.CMDFLARE_PROFILE || cfg.profile || 'default';
  const json = gf.json || gf.output === 'json' || !stdoutIsTTY();

  switch (sub) {
    case 'path':
      process.stdout.write(configPath() + '\n');
      return EXIT.OK;
    case 'list': {
      const view = {
        config_file: configPath(),
        current_profile: cfg.profile ?? 'default',
        profiles: Object.fromEntries(
          Object.entries(cfg.profiles).map(([n, p]) => [n, Object.fromEntries(Object.entries(p).map(([k, v]) => [k, SECRET_KEYS.has(k) ? maskSecret(String(v)) : v]))]),
        ),
        settings: cfg.settings ?? {},
      };
      process.stdout.write(formatOutput(view, { format: json ? 'json' : 'yaml' }) + '\n');
      return EXIT.OK;
    }
    case 'profiles': {
      const names = Object.keys(cfg.profiles);
      if (!names.length) log.info('No profiles yet. Run `cmdflare auth login`.');
      for (const n of names) process.stdout.write(`${n === (cfg.profile ?? 'default') ? c.green('* ') : '  '}${n}\n`);
      return EXIT.OK;
    }
    case 'use': {
      const name = args[1];
      if (!name) throw new UsageError('Usage: cmdflare config use <profile>');
      if (!cfg.profiles[name]) throw new UsageError(`Profile "${name}" does not exist.`, `Known: ${Object.keys(cfg.profiles).join(', ') || '(none)'}`);
      cfg.profile = name;
      saveConfig(cfg);
      log.success(`Default profile is now "${name}".`);
      return EXIT.OK;
    }
    case 'get': {
      const key = args[1];
      if (!key) throw new UsageError('Usage: cmdflare config get <key>');
      const p = cfg.profiles[profileName] ?? {};
      const v = SETTING_KEYS.includes(key) ? (cfg.settings as any)?.[key] : (p as any)[key];
      if (v === undefined) return EXIT.NOT_FOUND;
      process.stdout.write((SECRET_KEYS.has(key) ? maskSecret(String(v)) : String(v)) + '\n');
      return EXIT.OK;
    }
    case 'set': {
      const key = args[1];
      const value = args[2];
      if (!key || value === undefined) throw new UsageError('Usage: cmdflare config set <key> <value>');
      if (SETTING_KEYS.includes(key)) {
        cfg.settings ??= {};
        (cfg.settings as any)[key] = key === 'color' ? value === 'true' : key === 'per_page' ? Number(value) : value;
      } else if (PROFILE_KEYS.includes(key as keyof Profile)) {
        cfg.profiles[profileName] ??= {};
        (cfg.profiles[profileName] as any)[key] = value;
        if (!cfg.profile) cfg.profile = profileName;
      } else {
        throw new UsageError(`Unknown key "${key}".`, `Profile keys: ${PROFILE_KEYS.join(', ')}. Settings: ${SETTING_KEYS.join(', ')}`);
      }
      saveConfig(cfg);
      log.success(`${key} set${SETTING_KEYS.includes(key) ? '' : ` on profile "${profileName}"`}.`);
      return EXIT.OK;
    }
    case 'unset': {
      const key = args[1];
      if (!key) throw new UsageError('Usage: cmdflare config unset <key>');
      if (SETTING_KEYS.includes(key)) delete (cfg.settings as any)?.[key];
      else delete (cfg.profiles[profileName] as any)?.[key];
      saveConfig(cfg);
      log.success(`${key} unset.`);
      return EXIT.OK;
    }
    case 'delete-profile': {
      const name = args[1];
      if (!name) throw new UsageError('Usage: cmdflare config delete-profile <name>');
      if (!cfg.profiles[name]) throw new UsageError(`Profile "${name}" does not exist.`);
      delete cfg.profiles[name];
      if (cfg.profile === name) cfg.profile = Object.keys(cfg.profiles)[0];
      saveConfig(cfg);
      log.success(`Deleted profile "${name}".`);
      return EXIT.OK;
    }
    case 'cache': {
      if (args[1] === 'clear') {
        clearNameCache();
        log.success('Name cache cleared.');
        return EXIT.OK;
      }
      throw new UsageError('Usage: cmdflare config cache clear');
    }
    default:
      throw new UsageError(`Unknown config command "${sub}".`, 'Use: list | get | set | unset | use | profiles | delete-profile | path | cache clear');
  }
}
