const rgb = (r, g, b, msg) => `\x1b[38;2;${r};${g};${b}m${msg}\x1b[0m`;
const log = (...args) => console.log(`[${rgb(88, 101, 242, 'arRPC')} > ${rgb(237, 66, 69, 'process')}]`, ...args);

import fs from 'node:fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DetectableDB = JSON.parse(fs.readFileSync(join(__dirname, 'detectable.json'), 'utf8'));

import * as Natives from './native/index.js';
const Native = Natives[process.platform];

// https://stackoverflow.com/a/56641259
/**
 * Replaces all occurrences of words in a sentence with new words.
 * @function
 * @param {string} sentence - The sentence to modify.
 * @param {Object} wordsToReplace - An object containing words to be replaced as the keys and their replacements as the values.
 * @returns {string} - The modified sentence.
 */
function replaceAll(sentence, wordsToReplace) {
  return Object.keys(wordsToReplace).reduce(
    (f, s, i) =>
      `${f}`.replace(new RegExp(s, 'ig'), wordsToReplace[s]),
    sentence
  )
}

const bitness_suffixes = {
  '.x64': '',
  '_64': '',
  'x64': '',
  '64': '',
}

String.prototype.replaceArray = function(find, replace) {
  var replaceString = this;
  var regex;
  for (var i = 0; i < find.length; i++) {
    regex = new RegExp(find[i], "g");
    replaceString = replaceString.replace(regex, replace[i]);
  }
  return replaceString;
};

// ------------------------ Refactor helpers -------------------------------
/** Normalize a filesystem path for comparisons. */
const normPath = (p = '') => String(p).toLowerCase().replaceAll('\\', '/');

/** Strip common 64-bit suffixes from executable names. */
const stripBitness = (s = '') => {
  const suffixes = ['.x64', '_64', 'x64', '64'];
  for (const suf of suffixes) {
    if (s.endsWith(suf)) return s.slice(0, -suf.length);
  }
  return s;
};

/**
 * Build a compact set of candidates we will try to match against the DB.
 * Examples returned: ['eldenring.exe', 'eldenring', 'steamapps/common/eldenring.exe']
 */
const buildCandidates = (rawPath, cwdPath) => {
  const out = new Set();
  const p = normPath(rawPath);

  // Drop CLI args if present (e.g., "C:/Games/foo/bar.exe --flag ...")
  const noArgs = p.includes(' --') ? p.split(' --')[0] : p;
  const base = noArgs.slice(noArgs.lastIndexOf('/') + 1);

  out.add(stripBitness(base));

  // For Windows-style exe paths, include the last 2 segments to catch DB entries
  if (noArgs.includes('.exe')) {
    const last2 = noArgs.split('/').slice(-2).join('/');
    out.add(stripBitness(last2));
  }

  // Also include a cwd-anchored variant to help path.includes matches
  if (cwdPath) out.add(`${normPath(cwdPath)}/${stripBitness(base)}`);

  // Add exe-less variant if present
  if (base.endsWith('.exe')) out.add(stripBitness(base.replace(/\.exe$/, '')));

  return Array.from(out);
};

/**
 * Decide whether a known executable entry matches the running process.
 * Mirrors legacy behavior but is easier to read & extend.
 */
const matchesKnownExe = (known, candidates, cwdPath, argsStr) => {
  if (!known || known.is_launcher) return false;
  const kname = known.name || '';
  const needsArgs = Boolean(known.arguments);
  const hasReqArgs = !needsArgs || (argsStr && argsStr.includes(known.arguments));

  // Special '>' syntax: require exact match to the first candidate
  if (kname[0] === '>') {
    return candidates[0] === kname.slice(1) && hasReqArgs;
  }

  // Try direct name and common variants across all candidates
  for (const cand of candidates) {
    const running = cand;
    if (kname === running) return hasReqArgs;
    if (kname === `${running}.exe`) return hasReqArgs;
    if (kname === running.replace(/\.exe$/, '')) return hasReqArgs;
    if (String(running).includes(`/${kname}`)) return hasReqArgs; // handles cwd + filename
  }

  // Temporary compatibility for known problematic titles
  if (kname.includes('zenlesszonezero') && candidates.some(c => String(c).includes('zenlesszonezero'))) {
    return hasReqArgs;
  }

  // Last resort: allow arg-only matches (previous behavior)
  return needsArgs && hasReqArgs;
};
// -------------------------------------------------------------------------

const timestamps = {}, names = {}, pids = {};
export default class ProcessServer {
  constructor(handlers) {
    if (!Native) return; // log('unsupported platform:', process.platform);

    this.handlers = handlers;

    this.scan = this.scan.bind(this);

    this.scan();
    setInterval(this.scan, 5000);

    log('started');
  }

  async scan() {
    // const startTime = performance.now();
    const processes = await Native.getProcesses();
    const ids = [];

    // log(`got processes list in ${(performance.now() - startTime).toFixed(2)}ms`);

    for (const [pid, _path, args, _cwdPath = ''] of processes) {
      if (pid === 1) continue // init system
      if (_path.length < 1) continue; // process has no name, i.e. kernel thread
      if (_path.startsWith('/proc')) continue; // internal *nix stuff
      if (_path.startsWith('/usr/lib/')) continue; // internal *nix stuff
      if (_path.includes('systemd')) continue;
      const cwdPath = _cwdPath.toLowerCase().replaceAll('\\', '/');
      const path = _path.toLowerCase().replaceAll('\\', '/');
      if (path.startsWith('c:/windows')) continue // system processes (wine)
      if (_path.includes('webhelper')) continue; // CEF Processes
      // TODO: add 'dolphin-emu' to database for linux executable
      if (_path.endsWith('/bin/dolphin')) continue; // KDE file manager, not Dolphin Emulator
      const argsStr = Array.isArray(args) ? args.join(' ') : '';

      const toCompare = buildCandidates(path, cwdPath);

      // Matching against database (cleaned up)
      for (const { executables, id, name } of DetectableDB) {
        if (!executables || !Array.isArray(executables)) continue;

        const matched = executables.some((k) => matchesKnownExe(k, toCompare, cwdPath, argsStr));
        if (!matched) continue;

        names[id] = name;
        pids[id] = pid;
        ids.push(id);

        if (!timestamps[id]) {
          log('detected game!', name);
          timestamps[id] = Date.now();
        }

        // Re-send activity each scan to cover Discord startup races
        this.handlers.message({ socketId: id }, {
          cmd: 'SET_ACTIVITY',
          args: {
            activity: {
              application_id: id,
              name,
              timestamps: { start: timestamps[id] }
            },
            pid
          }
        });

        for (const id in timestamps) {
          if (!ids.includes(id)) {
            log('lost game!', names[id]);
            delete timestamps[id];

            this.handlers.message({
              socketId: id
            }, {
              cmd: 'SET_ACTIVITY',
              args: {
                activity: null,
                pid: pids[id]
              }
            });
          }
        }
      }
      // log(`finished scan in ${(performance.now() - startTime).toFixed(2)}ms`);
      // process.stdout.write(`\r${' '.repeat(100)}\r[${rgb(88, 101, 242, 'arRPC')} > ${rgb(237, 66, 69, 'process')}] scanned (took ${(performance.now() - startTime).toFixed(2)}ms)\n`);
    }
  }
}
