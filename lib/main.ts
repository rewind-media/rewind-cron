import { runCron } from "./Cron.js";
import {
  Database,
  loadDbConfig,
  mkMongoDatabase,
} from "@rewind-media/rewind-common";

const dbConfig = loadDbConfig();
mkMongoDatabase(dbConfig).then((db: Database) => {
  runCron(db);
});
