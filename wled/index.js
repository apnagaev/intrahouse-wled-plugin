'use strict';

const path = require('path');

async function main() {
  let plugin;
  try {
    const options = JSON.parse(process.argv[2]);
    plugin = require(path.join(options.pluginapi, 'index.js'))();
    const params = await plugin.params.get();
    require('./app')(plugin, params);
  } catch (error) {
    const message = 'WLED: ' + error.message;
    if (plugin) {
      plugin.exit(8, message);
    } else {
      if (process.send) process.send({ type: 'debug', txt: message });
      else console.error(message);
      process.exitCode = 8;
      if (process.connected) process.disconnect();
    }
  }
}

if (require.main === module) main();
