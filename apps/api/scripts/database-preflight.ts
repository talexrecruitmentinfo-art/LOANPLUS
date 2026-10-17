import { diagnoseDatabaseConfiguration } from '../src/database-config';

const diagnostic = diagnoseDatabaseConfiguration();

console.log(JSON.stringify({
  configurationOnly: true,
  databaseConnectionAttempted: false,
  ...diagnostic,
}, null, 2));

if (!diagnostic.consistent) {
  process.exitCode = 1;
}
