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
      const toCompare = [];
      let newPath
      if (path.includes(' --')) {
        newPath = path.split(' --')[0];
      }
      else
      {
        newPath = path;
      }
      newPath = newPath.substr(newPath.lastIndexOf('/') + 1);

      // log(`performance checkpoint: ${(performance.now() - startTime).toFixed(2)}ms`);

      toCompare.push(newPath);
      if (path.includes('.exe')) {
        const part2 = path.split('/').slice(-2).join('/');
        toCompare.push(part2);
        replaceAll(toCompare, bitness_suffixes);
      }

      // TODO: Convert into an inline function similar to findInObjArray
      // TODO: Don't try to match the running executable more than once
      for (const { executables, id, name } of DetectableDB) {
        if (
          executables?.some((known_exe) => {
            if (known_exe.is_launcher) return false;
            if (known_exe.name[0] === '>') {
              if (known_exe.name.substring(1) === toCompare[0]) {
                // TODO: Deduplicate with that version at the end of the following 'else' statement
                if (args && known_exe.arguments) return args.join(" ").indexOf(known_exe.arguments) > -1;
              }
            } else {
              if (
                toCompare.some((running) => {
                  // if (running === 'exe') {
                  //   throw new Error("Tried to match 'exe', this usually indicates a broken filter!")
                  //   return false;
                  // }
                  // explicit match first
                  if (known_exe.name === running) {
                    console.log(`Got explicit match:    ${known_exe.name} <==> ${running}`)
                    return true;
                  }
                  // Try comparing against an exe.suffixed version (Linux native games and such)
                  if (known_exe.name === running+'.exe') {
                    console.log(`Got exe match:    ${known_exe.name} <==> ${running}`)
                    return true
                  }
                  // Try comparing against an exe-less version (mistake in database)
                  if (known_exe.name === running.replace('.exe','')) {
                  console.log(`Got exe-less (fixup) match:    ${known_exe.name} <==> ${running}`)
                    return true
                  }
                  if (`${cwdPath}/${running}`.includes(`/${known_exe.name}`)
                  ) {
                    console.log(`Matched [${running}] with 'if ([${cwdPath}}/{${running}].includes(/[${known_exe.name}])'`)
                    return true;
                  }
                  if (
                    running.includes('zenlesszonezero') &&
                    known_exe.name.includes('zenlesszonezero')
                  ) {
                    // log(
                    //   `WARNING: Failed to match known problematic but running game '${known_exe.name}' via '${running}\n`,
                    //   'The database needs to be fixed to make the following match succeed:\n',
                    //   `Running ==> [${running}] <==> [${known_exe.name}] <== Database`,
                    // );
                    return true
                  }
                })
              ) {
                return true;
              }
            }
            if (args && known_exe.arguments) return args.join(" ").indexOf(known_exe.arguments) > -1;
          })
        ) {
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
