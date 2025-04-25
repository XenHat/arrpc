const rgb = (r, g, b, msg) => `\x1b[38;2;${r};${g};${b}m${msg}\x1b[0m`;
const log = (...args) => console.log(`[${rgb(88, 101, 242, 'arRPC')} > ${rgb(237, 66, 69, 'process')}]`, ...args);

import fs from 'node:fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DetectableDB = JSON.parse(fs.readFileSync(join(__dirname, 'detectable.json'), 'utf8'));

import * as Natives from './native/index.js';
const Native = Natives[process.platform];

function basename(str) {
  return str.substr(str.lastIndexOf('/') + 1);
}

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

    for (const [ pid, _path, args, _cwdPath = '' ] of processes) {
      if (_path.length < 1) continue;
      const path = _path.toLowerCase().replaceAll('\\', '/');
      const cwdPath = _cwdPath.toLowerCase().replaceAll('\\', '/');
      const toCompare = [];

      let newPath = basename(path);
      if (path.includes(' --')) {
        newPath = path.split(' --')[0];
      }
      toCompare.push(newPath);
      replaceAll(toCompare,bitness_suffixes);

      for (const { executables, id, name } of DetectableDB) {
        if (executables?.some(x => {
          if (x.is_launcher) return false;
          if (toCompare.some(y => y.includes('.exe') && (x.name.includes('game/'+y) || x.name.includes('games/'+y)))) return true;
          if (x.name[0] === '>' ? x.name.substring(1) !== toCompare[0] : !toCompare.some(y => x.name === y || `${cwdPath}/${y}`.includes(`/${x.name}`))) return false;
          if (args && x.arguments) return args.join(" ").indexOf(x.arguments) > -1;
          return true;
        })) {
          names[id] = name;
          pids[id] = pid;

          ids.push(id);
          if (!timestamps[id]) {
            log('detected game!', name);
            timestamps[id] = Date.now();
          }

          // Resending this on evry scan is intentional, so that in the case that arRPC scans processes before Discord, existing activities will be sent
          this.handlers.message({
            socketId: id
          }, {
            cmd: 'SET_ACTIVITY',
            args: {
              activity: {
                application_id: id,
                name,
                timestamps: {
                  start: timestamps[id]
                }
              },
              pid
            }
          });
        }
      }
    }

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

    // log(`finished scan in ${(performance.now() - startTime).toFixed(2)}ms`);
    // process.stdout.write(`\r${' '.repeat(100)}\r[${rgb(88, 101, 242, 'arRPC')} > ${rgb(237, 66, 69, 'process')}] scanned (took ${(performance.now() - startTime).toFixed(2)}ms)\n`);
  }
}
