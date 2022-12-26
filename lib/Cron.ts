import { CronJob } from "cron";
import { FileScanner } from "./scanner/FileScanner.js";
import { ShowScanner } from "./scanner/ShowScanner.js";
import { CronLogger as log } from "./log.js";
import { Library, LibraryType } from "@rewind-media/rewind-protocol";
import { Database } from "@rewind-media/rewind-common";
import { List } from "immutable";

export function runCron(db: Database) {
  return new CronJob(
    "* * * 2 * *",
    () =>
      db.listLibraries().then((libraries) =>
        List(libraries)
          .map((library: Library) => {
            switch (library.type) {
              case LibraryType.File:
                return new FileScanner(library, db);
              case LibraryType.Show:
                return new ShowScanner(library, db);
              default:
                log.warn(
                  `Unknown LibraryType '${library.type}' when scanning ${library.name}`
                );
                return null;
            }
          })
          .filter((it) => it)
          .map((scanner) => scanner?.scan())
      ),
    null,
    true,
    undefined,
    null,
    true
  );
}
