/**
 * Preload script that patches fs.promises.rename to retry on EPERM.
 *
 * Problem:
 *   On Windows, when electron-builder extracts the Electron zip to a .tmp
 *   directory and then renames it to the final name, the rename can fail
 *   with EPERM because antivirus (Windows Defender) is still scanning the
 *   newly extracted files and holding file handles.
 *
 * Solution:
 *   Patch fs.promises.rename (and fs.renameSync) to retry a few times with
 *   a short delay when EPERM is encountered, giving the AV scanner time to
 *   release its handles.
 *
 * Usage:
 *   node --require ./scripts/rename-retry-patch.cjs electron-builder ...
 *   or via NODE_OPTIONS="--require ./scripts/rename-retry-patch.cjs"
 */

'use strict';

const fs = require('node:fs');
const fsPromises = require('node:fs/promises');

const MAX_RETRIES = 10;
const BASE_DELAY_MS = 500;

function isEpermError(err) {
  return err && (err.code === 'EPERM' || err.code === 'EBUSY');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Patch fs.promises.rename
const originalRename = fsPromises.rename;
fsPromises.rename = async function retryRename(oldPath, newPath) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await originalRename.call(fsPromises, oldPath, newPath);
    } catch (err) {
      if (!isEpermError(err) || attempt === MAX_RETRIES) {
        throw err;
      }
      const delay = BASE_DELAY_MS * Math.pow(1.5, attempt);
      process.stderr.write(
        `[rename-retry] EPERM on rename ${oldPath} -> ${newPath}, ` +
        `retry ${attempt + 1}/${MAX_RETRIES} in ${Math.round(delay)}ms\n`
      );
      await sleep(delay);
    }
  }
};

// Patch fs.renameSync (used by some libraries)
const originalRenameSync = fs.renameSync;
fs.renameSync = function retryRenameSync(oldPath, newPath) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return originalRenameSync.call(fs, oldPath, newPath);
    } catch (err) {
      if (!isEpermError(err) || attempt === MAX_RETRIES) {
        throw err;
      }
      const delay = BASE_DELAY_MS * Math.pow(1.5, attempt);
      process.stderr.write(
        `[rename-retry] EPERM on renameSync ${oldPath} -> ${newPath}, ` +
        `retry ${attempt + 1}/${MAX_RETRIES} in ${Math.round(delay)}ms\n`
      );
      // Synchronous sleep using Atomics.wait
      const buf = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(buf, 0, 0, delay);
    }
  }
};

// Also patch fs.rename (callback style)
const originalRenameCb = fs.rename;
fs.rename = function retryRenameCb(oldPath, newPath, callback) {
  let attempt = 0;
  function tryRename() {
    originalRenameCb.call(fs, oldPath, newPath, (err, ...args) => {
      if (err && isEpermError(err) && attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(1.5, attempt);
        attempt++;
        process.stderr.write(
          `[rename-retry] EPERM on rename(cb) ${oldPath} -> ${newPath}, ` +
          `retry ${attempt}/${MAX_RETRIES} in ${Math.round(delay)}ms\n`
        );
        setTimeout(tryRename, delay);
        return;
      }
      callback(err, ...args);
    });
  }
  tryRename();
};

// Silence the "module loaded" message in production — only log on debug
if (process.env.DEBUG_RENAME_PATCH) {
  console.log('[rename-retry] fs.rename patches installed');
}
