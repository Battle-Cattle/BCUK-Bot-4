'use strict';

// Prints one setting from a .env file exactly as the bot reads it, by parsing the file with the
// bot's own dotenv package (src/shared/config.ts calls dotenv.config()). deploy.sh, the systemd
// installer and the backup scripts call it through env_setting in scripts/lib/dotenv.sh, instead of
// re-implementing dotenv's parser in bash.
//
// Usage: node scripts/envSetting.js <env file> <NAME>   prints NAME's value (nothing if unset)
//        node scripts/envSetting.js --check             exits 0 if dotenv can be loaded
//
// dotenv.parse, not config(): exported shell variables must not mix in (check_exported_db_settings
// compares those separately). And dotenv, not Node's util.parseEnv, which reads some lines
// differently (`NAME: value`, `'it\'s'`). The value is written as is, with no trailing newline, so
// any value (newlines included) survives `$(...)`. A missing file reads as every setting unset, as
// the bot sees it; dotenv itself missing is an error, never "unset".

const fs = require('fs');
const path = require('path');

const REPO_DIR = path.resolve(__dirname, '..');

/** Exit code when dotenv can't be loaded, so callers can tell it from other failures. */
const NO_DOTENV_EXIT = 3;

/**
 * Loads the checkout's dotenv package: from node_modules, or from node_modules.old while deploy.sh
 * has the previous install moved aside for `npm ci`. Nothing else (no parent folders or global
 * installs), so a script never reads .env with a different dotenv than the bot's.
 * @returns The dotenv module, or null if neither folder has it.
 */
function loadDotenv() {
  for (const folder of ['node_modules', 'node_modules.old']) {
    try {
      return require(path.join(REPO_DIR, folder, 'dotenv'));
    } catch (err) {
      if (err.code !== 'MODULE_NOT_FOUND') throw err;
    }
  }
  return null;
}

/**
 * Reads the .env file's text.
 * @param file - Path of the .env file.
 * @returns Its contents, or an empty string if it doesn't exist.
 */
function readEnvFile(file) {
  try {
    return fs.readFileSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

/**
 * Runs the command line: prints the requested setting, or checks dotenv loads.
 * @param args - The arguments after the script name.
 * @returns The process exit code.
 */
function main(args) {
  const dotenv = loadDotenv();
  if (!dotenv) {
    process.stderr.write(`ERROR: Can't load dotenv from ${path.join(REPO_DIR, 'node_modules')} to read .env. Run \`npm ci\` in ${REPO_DIR} first.\n`);
    return NO_DOTENV_EXIT;
  }
  if (args[0] === '--check' && args.length === 1) return 0;
  if (args.length !== 2) {
    process.stderr.write('Usage: node scripts/envSetting.js <env file> <NAME> | --check\n');
    return 2;
  }
  const [file, name] = args;
  const value = dotenv.parse(readEnvFile(file))[name];
  process.stdout.write(value ?? '');
  return 0;
}

process.exitCode = main(process.argv.slice(2));
