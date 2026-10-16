// PM2 process definition. The service is started with
//
//   pm2 startOrReload ecosystem.config.cjs
//
// which is what deploy/deploy.sh runs, so a deploy by hand, by the GitHub
// workflow and by the Harness pipeline all start the process the same way.
//
// __dirname rather than a hardcoded path: the checkout can live anywhere, and a
// path baked in here would be wrong on the day it moves.
//
// A .cjs file because package.json sets "type": "module" and PM2 loads this
// itself, not through Node's module resolver.

module.exports = {
  apps: [
    {
      name: "simpul-warehouse-selector",
      // TypeScript, run as-is. Node 24 strips the types on the way in, so there
      // is no build step and no build output to go stale.
      script: "src/http/server.ts",
      // Explicit, because PM2 otherwise chooses an interpreter from the file
      // extension, and .ts is not one it handles on its own.
      interpreter: "node",
      cwd: __dirname,
      env: {
        // Loopback only. nginx is the sole public entry point, so nothing else
        // should be able to reach the process even from the same machine.
        HOST: "127.0.0.1",
        PORT: "3000",
        // Optional. Without this file the "minutes" objective reports itself
        // unavailable and the core selection path is unchanged.
        SIMPUL_HISTORY_PATH: `${__dirname}/data/customer1-historical.csv`,
      },
      // PM2 does not timestamp its log lines by default, which makes a deploy
      // that failed at 14:02 indistinguishable from one that failed at 09:20.
      time: true,
    },
  ],
};
