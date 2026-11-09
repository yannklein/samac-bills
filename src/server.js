import { createApp, configFromEnv } from './app.js';

const config = configFromEnv();
for (const k of ['apiToken', 'endesaNie']) if (!config[k]) console.warn(`[samac-bills] warning: ${k} not set`);
if (!config.devUserEmail && !config.cfTeamDomain) console.warn('[samac-bills] warning: CF_ACCESS_TEAM_DOMAIN not set, web UI will deny everyone');
if (config.devUserEmail) console.warn(`[samac-bills] DEV MODE: acting as ${config.devUserEmail} (?as=email to switch)`);

const { app } = createApp(config);
app.listen(config.port, () => console.log(`[samac-bills] listening on :${config.port} (data: ${config.dataDir})`));
