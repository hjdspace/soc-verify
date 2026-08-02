'use strict';

/**
 * Return the bridge injected by SoC Verify into plugin view HTML.
 * Keeping this helper tiny lets plugin HTML use a normal package import in
 * development while the host still controls the actual message transport.
 */
function getPluginUiBridge(target = globalThis) {
  if (!target.socVerify || typeof target.socVerify.invoke !== 'function') {
    throw new Error('SoC Verify plugin UI bridge is not available');
  }
  return target.socVerify;
}

module.exports = { getPluginUiBridge };
